import {
  MAX_PLAYERS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type ServerErrorCode,
} from "./protocol";
import type { Env } from "./env";

interface DirectoryState {
  quickRooms: string[];
  recentCodes: string[];
}

type RateLimitAction = "allocate" | "reserve" | "socket";

interface RateLimitCounter {
  windowStartedAt: number;
  count: number;
}

interface ClientRateLimitState {
  lastSeenAt: number;
  counters: Partial<Record<RateLimitAction, RateLimitCounter>>;
}

interface PersistedRateLimitState {
  clients: Record<string, ClientRateLimitState>;
  global: Partial<Record<RateLimitAction, RateLimitCounter>>;
}

interface RateLimitPolicy {
  windowMs: number;
  clientLimit: number;
  globalLimit: number;
}

interface InternalReservation {
  ok: true;
  roomCode: string;
  reservationToken: string;
  reservationExpiresAt: number;
}

interface InternalFailure {
  ok: false;
  code: ServerErrorCode;
  message: string;
}

const DIRECTORY_KEY = "directory";
const RATE_LIMIT_KEY = "rate-limits";
const MAX_TRACKED_QUICK_ROOMS = 64;
const MAX_RECENT_CODES = 2_048;
const MAX_TRACKED_RATE_LIMIT_CLIENTS = 1_024;
const RATE_LIMIT_RETENTION_MS = 2 * 60_000;
const CLIENT_KEY_PATTERN = /^[A-Za-z0-9:._-]{1,96}$/;
const RATE_LIMIT_ACTIONS = new Set<RateLimitAction>([
  "allocate",
  "reserve",
  "socket",
]);
const RATE_LIMIT_POLICIES: Readonly<
  Record<RateLimitAction, RateLimitPolicy>
> = {
  allocate: {
    windowMs: 60_000,
    clientLimit: 8,
    globalLimit: 240,
  },
  reserve: {
    windowMs: 60_000,
    clientLimit: 16,
    globalLimit: 960,
  },
  socket: {
    windowMs: 60_000,
    clientLimit: 24,
    globalLimit: 1_440,
  },
};

function json(
  value: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("cache-control", "no-store");
  return Response.json(value, {
    status,
    headers,
  });
}

function isRateLimitAction(value: unknown): value is RateLimitAction {
  return (
    typeof value === "string" &&
    RATE_LIMIT_ACTIONS.has(value as RateLimitAction)
  );
}

function normalizeClientKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return CLIENT_KEY_PATTERN.test(normalized) ? normalized : null;
}

function emptyRateLimitState(): PersistedRateLimitState {
  return { clients: {}, global: {} };
}

function randomRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

/**
 * A tiny directory DO serialises quick-match allocation. Capacity is still
 * reserved atomically by each MatchRoom, so stale directory entries cannot
 * overfill a room.
 */
export class Matchmaker {
  private directory: DirectoryState = { quickRooms: [], recentCodes: [] };
  private rateLimits: PersistedRateLimitState = emptyRateLimitState();
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.state.blockConcurrencyWhile(async () => {
      const [storedDirectory, storedRateLimits] = await Promise.all([
        this.state.storage.get<DirectoryState>(DIRECTORY_KEY),
        this.state.storage.get<PersistedRateLimitState>(RATE_LIMIT_KEY),
      ]);
      if (storedDirectory) this.directory = storedDirectory;
      if (storedRateLimits) {
        this.rateLimits = {
          clients: storedRateLimits.clients ?? {},
          global: storedRateLimits.global ?? {},
        };
      }
      if (this.pruneRateLimits(Date.now())) {
        await this.persistRateLimits();
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method !== "POST" ||
      (url.pathname !== "/internal/allocate" &&
        url.pathname !== "/internal/rate-limit")
    ) {
      return json({ ok: false, message: "Not found." }, 404);
    }

    let release: (() => void) | undefined;
    const previous = this.operation;
    this.operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      if (url.pathname === "/internal/rate-limit") {
        return await this.handleRateLimit(request);
      }

      const body = (await request.json().catch(() => null)) as {
        private?: unknown;
      } | null;
      if (!body || typeof body.private !== "boolean") {
        return json(
          { ok: false, code: "bad_request", message: "Invalid allocation." },
          400,
        );
      }
      return body.private
        ? await this.createRoom(true)
        : await this.allocateQuickRoom();
    } finally {
      release?.();
    }
  }

  private async handleRateLimit(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => null)) as {
      clientKey?: unknown;
      action?: unknown;
    } | null;
    const clientKey = normalizeClientKey(body?.clientKey);
    const action = body?.action;
    if (!clientKey || !isRateLimitAction(action)) {
      return json(
        {
          ok: false,
          code: "bad_request",
          message: "Invalid rate-limit request.",
        },
        400,
      );
    }

    const now = Date.now();
    this.pruneRateLimits(now);
    const policy = RATE_LIMIT_POLICIES[action];
    const storedClientKey = `client:${clientKey}`;
    let client = this.rateLimits.clients[storedClientKey];
    if (!client) {
      this.makeRateLimitClientCapacity();
      client = { lastSeenAt: now, counters: {} };
      this.rateLimits.clients[storedClientKey] = client;
    }
    client.lastSeenAt = now;

    const clientCounter = this.counterFor(
      client.counters,
      action,
      policy.windowMs,
      now,
    );
    const globalCounter = this.counterFor(
      this.rateLimits.global,
      action,
      policy.windowMs,
      now,
    );

    if (clientCounter.count >= policy.clientLimit) {
      const retryAfterMs = this.retryAfterMs(
        clientCounter,
        policy.windowMs,
        now,
      );
      await this.persistRateLimits();
      return this.rateLimited(action, retryAfterMs);
    }
    clientCounter.count += 1;

    if (globalCounter.count >= policy.globalLimit) {
      const retryAfterMs = this.retryAfterMs(
        globalCounter,
        policy.windowMs,
        now,
      );
      await this.persistRateLimits();
      return this.rateLimited(action, retryAfterMs);
    }
    globalCounter.count += 1;

    await this.persistRateLimits();
    return json({
      ok: true,
      action,
      remaining: {
        client: Math.max(0, policy.clientLimit - clientCounter.count),
        global: Math.max(0, policy.globalLimit - globalCounter.count),
      },
      resetAt: clientCounter.windowStartedAt + policy.windowMs,
    });
  }

  private counterFor(
    counters: Partial<Record<RateLimitAction, RateLimitCounter>>,
    action: RateLimitAction,
    windowMs: number,
    now: number,
  ): RateLimitCounter {
    const windowStartedAt = Math.floor(now / windowMs) * windowMs;
    const current = counters[action];
    if (
      !current ||
      current.windowStartedAt !== windowStartedAt ||
      !Number.isSafeInteger(current.count) ||
      current.count < 0
    ) {
      const created = { windowStartedAt, count: 0 };
      counters[action] = created;
      return created;
    }
    return current;
  }

  private retryAfterMs(
    counter: RateLimitCounter,
    windowMs: number,
    now: number,
  ): number {
    return Math.max(1, counter.windowStartedAt + windowMs - now);
  }

  private rateLimited(
    action: RateLimitAction,
    retryAfterMs: number,
  ): Response {
    return json(
      {
        ok: false,
        code: "rate_limited",
        message: `Too many ${action} requests.`,
        retryAfterMs,
      },
      429,
      { "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1_000))) },
    );
  }

  private pruneRateLimits(now: number): boolean {
    let changed = false;
    const cutoff = now - RATE_LIMIT_RETENTION_MS;
    for (const [clientKey, client] of Object.entries(
      this.rateLimits.clients,
    )) {
      if (
        !Number.isFinite(client.lastSeenAt) ||
        client.lastSeenAt <= cutoff
      ) {
        delete this.rateLimits.clients[clientKey];
        changed = true;
      }
    }
    return changed;
  }

  private makeRateLimitClientCapacity(): void {
    const clientKeys = Object.keys(this.rateLimits.clients);
    if (clientKeys.length < MAX_TRACKED_RATE_LIMIT_CLIENTS) return;

    let oldestKey = clientKeys[0];
    let oldestSeenAt = Number.POSITIVE_INFINITY;
    for (const clientKey of clientKeys) {
      const lastSeenAt =
        this.rateLimits.clients[clientKey]?.lastSeenAt ??
        Number.NEGATIVE_INFINITY;
      if (lastSeenAt < oldestSeenAt) {
        oldestSeenAt = lastSeenAt;
        oldestKey = clientKey;
      }
    }
    if (oldestKey) delete this.rateLimits.clients[oldestKey];
  }

  private async allocateQuickRoom(): Promise<Response> {
    const candidates = this.directory.quickRooms.slice().reverse();
    const surviving: string[] = [];

    for (let index = 0; index < candidates.length; index += 1) {
      const code = candidates[index];
      if (!code) continue;
      const result = await this.reserve(code, "quick");
      if (result.ok) {
        const unvisited = candidates.slice(index + 1).reverse();
        this.directory.quickRooms = [
          ...new Set([...unvisited, ...surviving, code]),
        ].slice(-MAX_TRACKED_QUICK_ROOMS);
        await this.persist();
        return json(result);
      }

      if (
        result.code !== "room_full" &&
        result.code !== "match_started" &&
        result.code !== "room_not_found"
      ) {
        surviving.push(code);
      }
    }

    // Prune rooms that reported full, started, or missing before adding a new
    // quick-match room.
    this.directory.quickRooms = surviving.slice(-MAX_TRACKED_QUICK_ROOMS);
    return this.createRoom(false);
  }

  private async createRoom(isPrivate: boolean): Promise<Response> {
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const code = randomRoomCode();
      if (this.directory.recentCodes.includes(code)) continue;

      const stub = this.env.MATCH_ROOMS.get(
        this.env.MATCH_ROOMS.idFromName(code),
      );
      const response = await stub.fetch(
        "https://room.internal/internal/create",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code,
            private: isPrivate,
            maxPlayers: MAX_PLAYERS,
          }),
        },
      );
      const result = (await response.json()) as
        | InternalReservation
        | InternalFailure;

      if (!result.ok) {
        // An older still-live room can outlast the bounded recent-code list.
        // Mark the collision and try another code instead of surfacing a
        // random creation failure to the player.
        if (response.status === 409) {
          this.directory.recentCodes.push(code);
          continue;
        }
        return json(result, response.status);
      }

      this.directory.recentCodes.push(code);
      this.directory.recentCodes = this.directory.recentCodes.slice(
        -MAX_RECENT_CODES,
      );
      if (!isPrivate) {
        this.directory.quickRooms.push(code);
        this.directory.quickRooms = this.directory.quickRooms.slice(
          -MAX_TRACKED_QUICK_ROOMS,
        );
      }
      await this.persist();
      return json(result, 201);
    }

    await this.persist();
    return json(
      {
        ok: false,
        code: "internal_error",
        message: "Could not allocate a room code.",
      },
      503,
    );
  }

  private async reserve(
    code: string,
    source: "quick" | "code",
  ): Promise<InternalReservation | InternalFailure> {
    const stub = this.env.MATCH_ROOMS.get(
      this.env.MATCH_ROOMS.idFromName(code),
    );
    const response = await stub.fetch("https://room.internal/internal/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source }),
    });
    return (await response.json()) as InternalReservation | InternalFailure;
  }

  private async persist(): Promise<void> {
    await this.state.storage.put(DIRECTORY_KEY, this.directory);
  }

  private async persistRateLimits(): Promise<void> {
    await this.state.storage.put(RATE_LIMIT_KEY, this.rateLimits);
  }
}
