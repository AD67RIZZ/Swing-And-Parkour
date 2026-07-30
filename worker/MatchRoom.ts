import {
  FINISHING_WINDOW_MS,
  INPUT_RATE_HZ,
  MATCH_DURATION_MS,
  MAX_MESSAGE_BYTES,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PLAYER_COLORS,
  PROTOCOL_VERSION,
  POWER_UP_DURATION_MS,
  RECONNECT_GRACE_MS,
  RESPAWN_CRASH_PENALTY,
  RESPAWN_DELAY_MS,
  RESPAWN_PROTECTION_MS,
  RESPAWN_REQUEST_COOLDOWN_MS,
  SAFE_PLAYER_NAMES,
  SNAPSHOT_RATE_HZ,
  SOCKET_JOIN_TIMEOUT_MS,
  normalizePlayerName,
  type ClientMessage,
  type CourseDescriptor,
  type GameplayEventKind,
  type PlayerColor,
  type PlayerMotionState,
  type PlayerSnapshot,
  type PowerUpKind,
  type RaceResult,
  type RespawnReason,
  type RoomPhase,
  type RoomView,
  type ServerErrorCode,
  type ServerMessage,
  deterministicPowerUpKind,
} from "./protocol";
import {
  checkpointGate,
  checkpointPosition,
  createCourse,
  gameplayObjectPosition,
} from "./course";
import { scoreBreakdown } from "./scoring";
import {
  isToken,
  isPlayerColor,
  normalizeRoomCode,
  parseClientMessage,
  safeJsonParse,
} from "./validation";
import type { Env } from "./env";

interface Reservation {
  token: string;
  expiresAt: number;
}

interface ActivePowerUpRecord {
  objectId: string;
  kind: PowerUpKind;
  startsAt: number;
  endsAt: number;
}

interface ClaimedPowerUpRecord {
  objectId: string;
  kind: PowerUpKind;
  playerId: string;
  claimedAt: number;
}

interface PlayerRecord {
  id: string;
  name: string;
  color: PlayerColor;
  ready: boolean;
  host: boolean;
  connected: boolean;
  connectionId: string | null;
  reconnectToken: string;
  joinedAt: number;
  lastSeenAt: number;
  disconnectedAt: number | null;
  graceUntil: number | null;
  abandoned: boolean;
  motion: PlayerMotionState;
  checkpointIndex: number;
  lastCheckpointAt: number;
  checkpointRespawnPosition: { x: number; y: number; z: number };
  shardsCollected: number;
  dronesDestroyed: number;
  stylePoints: number;
  placementBonus: number;
  crashes: number;
  combo: number;
  maximumCombo: number;
  lastComboAt: number;
  finishPlacement: number | null;
  finishTimeMs: number | null;
  respawningUntil: number | null;
  protectedUntil: number | null;
  lastRespawnAt: number;
  lastPowerUpAt: number;
  activePowerUps: Partial<Record<PowerUpKind, ActivePowerUpRecord>>;
  lastReadyAt: number;
  lastInputSeq: number;
  lastActionSeq: number;
  lastMotionAt: number;
  movementBudget: number;
  plausibilityStrikes: number;
  grappleEpisode: number;
  grappleEpisodeStartedAt: number;
  creditedCleanReleaseEpisode: number;
  creditedHighSpeedEpisode: number;
  seenObjectIds: string[];
  lastEventAt: Partial<Record<GameplayEventKind, number>>;
  eventCounts: Partial<Record<GameplayEventKind, number>>;
  pingMs: number | null;
  pingSamples: number;
}

interface PersistedRoom {
  created: boolean;
  code: string;
  private: boolean;
  phase: RoomPhase;
  createdAt: number;
  lastActivityAt: number;
  reservations: Record<string, Reservation>;
  claimedPowerUps: Record<string, ClaimedPowerUpRecord>;
  players: Record<string, PlayerRecord>;
  course: CourseDescriptor;
  countdownEndsAt: number | null;
  countdownReason: "ready" | "auto" | null;
  quickAutoStartAt: number | null;
  startedAt: number | null;
  matchEndsAt: number | null;
  finishingEndsAt: number | null;
  endedAt: number | null;
  finalReason: "all_finished" | "finishing_window" | "timer" | "empty" | null;
  finalResults: RaceResult[] | null;
  snapshotSeq: number;
  nextFinishPlacement: number;
}

interface SocketAttachment {
  connectionId: string;
  clientKey?: string;
  joined: boolean;
  playerId: string | null;
  joinDeadlineAt: number;
  windowStartedAt: number;
  totalMessages: number;
  inputMessages: number;
  actionMessages: number;
  invalidMessages: number;
}

const STORAGE_KEY = "room";
const RESERVATION_TTL_MS = 20_000;
const COUNTDOWN_MS = 5_000;
const QUICK_AUTO_START_MS = 20_000;
const SOCKET_INACTIVITY_MS = 30_000;
const EMPTY_ROOM_TTL_MS = 5 * 60_000;
const LOBBY_TTL_MS = 30 * 60_000;
const RESULTS_TTL_MS = 10 * 60_000;
const MAX_PENDING_SOCKETS = MAX_PLAYERS;
const MAX_PENDING_SOCKETS_PER_CLIENT = 3;
const MAX_LINEAR_SPEED = 72;
const MAX_VELOCITY = 72;
const POSITION_TOLERANCE = 18;
const MAX_MOVEMENT_BUDGET = MAX_LINEAR_SPEED * 2 + POSITION_TOLERANCE;
const CHECKPOINT_DISTANCE_TOLERANCE = 14;
const CHECKPOINT_X_TOLERANCE = 5;
const CHECKPOINT_Y_TOLERANCE = 12;
const CHECKPOINT_Z_BEHIND_TOLERANCE = 14;
const CHECKPOINT_Z_AHEAD_TOLERANCE = 18;
const FINISH_DISTANCE_TOLERANCE = 8;
const POWER_UP_PICKUP_PROGRESS_TOLERANCE = 42;
const POWER_UP_PICKUP_COOLDOWN_MS = 500;
const MAX_TOTAL_MESSAGES_PER_SECOND = 70;
const MAX_INPUT_MESSAGES_PER_SECOND = 35;
const MAX_ACTION_MESSAGES_PER_SECOND = 18;

const PLACEMENT_BONUSES = [3_000, 2_000, 1_400, 1_000, 750, 500, 300, 150];

const EVENT_RULES: Record<
  GameplayEventKind,
  { cooldownMs: number; combo: number; style: number; maximum: number }
> = {
  shard: { cooldownMs: 60, combo: 0.08, style: 0, maximum: 512 },
  drone: { cooldownMs: 450, combo: 0.4, style: 0, maximum: 30 },
  near_miss: { cooldownMs: 700, combo: 0.18, style: 75, maximum: 180 },
  clean_release: { cooldownMs: 300, combo: 0.12, style: 60, maximum: 300 },
  high_speed: { cooldownMs: 900, combo: 0.1, style: 30, maximum: 180 },
  combo_chain: { cooldownMs: 800, combo: 0.2, style: 90, maximum: 180 },
  risky_route: { cooldownMs: 1_500, combo: 0.35, style: 150, maximum: 80 },
};

function emptyMotion(): PlayerMotionState {
  return {
    position: { x: 0, y: 32.25, z: 2 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    distance: 0,
    grounded: true,
    action: "run",
  };
}

function emptyRoom(): PersistedRoom {
  const now = Date.now();
  return {
    created: false,
    code: "",
    private: false,
    phase: "lobby",
    createdAt: now,
    lastActivityAt: now,
    reservations: {},
    claimedPowerUps: {},
    players: {},
    course: createCourse(now),
    countdownEndsAt: null,
    countdownReason: null,
    quickAutoStartAt: null,
    startedAt: null,
    matchEndsAt: null,
    finishingEndsAt: null,
    endedAt: null,
    finalReason: null,
    finalResults: null,
    snapshotSeq: 0,
    nextFinishPlacement: 1,
  };
}

function token(): string {
  return crypto.randomUUID();
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function failure(
  code: ServerErrorCode,
  message: string,
  status: number,
): Response {
  return json({ ok: false, code, message }, status);
}

function vectorLength(vector: { x: number; y: number; z: number }): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function vectorDistance(
  left: { x: number; y: number; z: number },
  right: { x: number; y: number; z: number },
): number {
  return Math.hypot(
    left.x - right.x,
    left.y - right.y,
    left.z - right.z,
  );
}

function validationErrorCode(reason: string): ServerErrorCode {
  if (reason.includes("protocol")) return "unsupported_protocol";
  if (reason.includes("player name")) return "invalid_name";
  if (reason.includes("player colour")) return "invalid_color";
  return "invalid_message";
}

export class MatchRoom {
  private room: PersistedRoom = emptyRoom();
  private lastPersistAt = 0;
  private nextSnapshotAt = 0;
  private scheduledAlarm: number | null = null;
  private advancing = false;
  private handlingAlarm = false;
  private readonly pendingJoinDeadlines = new WeakMap<WebSocket, number>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.env;
    this.ctx.blockConcurrencyWhile(async () => {
      const [stored, alarm] = await Promise.all([
        this.ctx.storage.get<PersistedRoom>(STORAGE_KEY),
        this.ctx.storage.getAlarm(),
      ]);
      if (stored) {
        this.room = stored;
        this.room.claimedPowerUps ??= {};
        this.room.snapshotSeq ??= 0;
        this.room.nextFinishPlacement ??= 1;
        for (const [index, player] of Object.values(
          this.room.players,
        ).entries()) {
          player.name =
            normalizePlayerName(player.name) ??
            SAFE_PLAYER_NAMES[index % SAFE_PLAYER_NAMES.length] ??
            SAFE_PLAYER_NAMES[0];
          if (!isPlayerColor(player.color)) {
            player.color =
              PLAYER_COLORS[index % PLAYER_COLORS.length] ?? PLAYER_COLORS[0];
          }
          player.motion ??= emptyMotion();
          player.checkpointIndex ??= 0;
          player.checkpointRespawnPosition ??= checkpointPosition(
            this.room.course,
            player.checkpointIndex,
          );
          player.activePowerUps ??= {};
          player.lastPowerUpAt ??= 0;
          player.lastReadyAt ??= 0;
          player.lastInputSeq ??= -1;
          player.lastActionSeq ??= -1;
          player.lastMotionAt ??= player.lastSeenAt ?? Date.now();
          player.movementBudget =
            typeof player.movementBudget === "number" &&
            Number.isFinite(player.movementBudget)
              ? Math.max(0, Math.min(MAX_MOVEMENT_BUDGET, player.movementBudget))
              : POSITION_TOLERANCE;
          player.plausibilityStrikes ??= 0;
          player.grappleEpisode ??= 0;
          player.grappleEpisodeStartedAt ??= 0;
          player.creditedCleanReleaseEpisode ??= -1;
          player.creditedHighSpeedEpisode ??= -1;
          player.seenObjectIds ??= [];
          player.lastEventAt ??= {};
          player.eventCounts ??= {};
          player.pingMs ??= null;
          player.pingSamples ??= 0;
        }
        if (this.room.finalResults) {
          this.room.finalResults.forEach((result, index) => {
            result.name =
              normalizePlayerName(result.name) ??
              SAFE_PLAYER_NAMES[index % SAFE_PLAYER_NAMES.length] ??
              SAFE_PLAYER_NAMES[0];
            if (!isPlayerColor(result.color)) {
              result.color =
                PLAYER_COLORS[index % PLAYER_COLORS.length] ?? PLAYER_COLORS[0];
            }
          });
        }
      }
      this.scheduledAlarm = alarm;
      this.lastPersistAt = Date.now();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    await this.advance(now);

    if (url.pathname === "/internal/create" && request.method === "POST") {
      if (this.room.created) {
        return failure("bad_request", "Room code is already in use.", 409);
      }
      const body = (await request.json().catch(() => null)) as {
        code?: unknown;
        private?: unknown;
      } | null;
      const code =
        body && typeof body.code === "string"
          ? normalizeRoomCode(body.code)
          : null;
      if (!code || typeof body?.private !== "boolean") {
        return failure("bad_request", "Invalid room creation request.", 400);
      }

      this.room = {
        ...emptyRoom(),
        created: true,
        code,
        private: body.private,
        createdAt: now,
        lastActivityAt: now,
        course: createCourse(now),
      };
      const reservation = this.issueReservation(now);
      await this.persist(true);
      await this.scheduleAlarm(now);
      return json({ ok: true, roomCode: code, ...reservation }, 201);
    }

    if (url.pathname === "/internal/reserve" && request.method === "POST") {
      if (!this.room.created) {
        return failure("room_not_found", "Room not found.", 404);
      }
      if (this.room.phase !== "lobby" && this.room.phase !== "countdown") {
        return failure("match_started", "This match has already started.", 409);
      }
      this.removeExpiredReservations(now);
      const occupied = this.activePlayerCount() + this.reservationCount();
      if (occupied >= MAX_PLAYERS) {
        return failure("room_full", "This room is full.", 409);
      }
      const reservation = this.issueReservation(now);
      await this.persist(true);
      await this.scheduleAlarm(now);
      return json({ ok: true, roomCode: this.room.code, ...reservation });
    }

    if (url.pathname === "/internal/status" && request.method === "GET") {
      if (!this.room.created) {
        return failure("room_not_found", "Room not found.", 404);
      }
      return json({
        ok: true,
        room: this.roomView(),
        reservable:
          (this.room.phase === "lobby" ||
            this.room.phase === "countdown") &&
          this.activePlayerCount() + this.reservationCount() < MAX_PLAYERS,
      });
    }

    if (url.pathname === "/ws" && request.method === "GET") {
      if (!this.room.created) {
        return failure("room_not_found", "Room not found.", 404);
      }
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return failure("bad_request", "Expected a WebSocket upgrade.", 426);
      }
      const clientKey =
        request.headers.get("x-neon-client-key")?.slice(0, 80) || "unknown";
      let pendingSockets = 0;
      let pendingForClient = 0;
      for (const socket of this.ctx.getWebSockets()) {
          const attachment =
            socket.deserializeAttachment() as SocketAttachment | null;
          if (attachment?.joined) continue;
          pendingSockets += 1;
          if ((attachment?.clientKey ?? "unknown") === clientKey) {
            pendingForClient += 1;
          }
      }
      if (pendingSockets >= MAX_PENDING_SOCKETS) {
        return failure(
          "rate_limited",
          "Too many connections are waiting to join this room.",
          429,
        );
      }
      if (pendingForClient >= MAX_PENDING_SOCKETS_PER_CLIENT) {
        return failure(
          "rate_limited",
          "Too many connections from this client are waiting to join.",
          429,
        );
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      const attachment: SocketAttachment = {
        connectionId: token(),
        clientKey,
        joined: false,
        playerId: null,
        joinDeadlineAt: now + SOCKET_JOIN_TIMEOUT_MS,
        windowStartedAt: now,
        totalMessages: 0,
        inputMessages: 0,
        actionMessages: 0,
        invalidMessages: 0,
      };
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(attachment);
      this.pendingJoinDeadlines.set(server, attachment.joinDeadlineAt);
      await this.scheduleAlarmNoLaterThan(attachment.joinDeadlineAt);
      this.send(server, {
        type: "connected",
        protocol: PROTOCOL_VERSION,
        roomCode: this.room.code,
        serverTime: now,
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ ok: false, message: "Not found." }, 404);
  }

  async webSocketMessage(
    socket: WebSocket,
    data: string | ArrayBuffer,
  ): Promise<void> {
    const now = Date.now();
    const attachment = this.attachment(socket, now);
    if (!attachment.joined && attachment.joinDeadlineAt <= now) {
      this.sendError(socket, "join_required", "The join window expired.");
      socket.close(1008, "Join timeout");
      return;
    }

    if (typeof data !== "string") {
      this.sendError(socket, "invalid_message", "Binary messages are not supported.");
      attachment.invalidMessages += 1;
      socket.serializeAttachment(attachment);
      if (!attachment.joined || attachment.invalidMessages >= 3) {
        socket.close(1003, "Text JSON required");
      }
      return;
    }

    if (new TextEncoder().encode(data).byteLength > MAX_MESSAGE_BYTES) {
      this.sendError(socket, "message_too_large", "Message is too large.");
      socket.close(1009, "Message too large");
      return;
    }

    const parsedJson = safeJsonParse(data);
    if (!parsedJson.ok) {
      this.invalidMessage(socket, attachment, parsedJson.reason);
      return;
    }
    const parsed = parseClientMessage(parsedJson.value);
    if (!parsed.ok) {
      this.invalidMessage(
        socket,
        attachment,
        parsed.reason,
        validationErrorCode(parsed.reason),
      );
      return;
    }

    if (!this.consumeRateLimit(attachment, parsed.value.type, now)) {
      this.sendError(socket, "rate_limited", "Too many messages.", true);
      socket.serializeAttachment(attachment);
      if (attachment.totalMessages > MAX_TOTAL_MESSAGES_PER_SECOND * 2) {
        socket.close(1008, "Rate limit");
      }
      return;
    }

    await this.advance(now);
    await this.handleMessage(socket, attachment, parsed.value, now);
    socket.serializeAttachment(attachment);
    await this.scheduleAlarm(now);
  }

  async webSocketClose(
    socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.disconnectSocket(socket, Date.now());
  }

  async webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    await this.disconnectSocket(socket, Date.now());
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.scheduledAlarm = null;
    this.handlingAlarm = true;
    try {
      await this.advance(now);
      if (!this.room.created) return;
      if (this.ctx.getWebSockets().length > 0) {
        this.emitSnapshot(now, true);
      }
      await this.persist(true);
      await this.scheduleAlarm(now);
    } finally {
      this.handlingAlarm = false;
    }
  }

  private async handleMessage(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: ClientMessage,
    now: number,
  ): Promise<void> {
    if (message.type === "join") {
      if (attachment.joined) {
        this.sendError(socket, "already_joined", "This socket already joined.");
        return;
      }
      await this.handleJoin(socket, attachment, message, now);
      return;
    }

    if (!attachment.joined || !attachment.playerId) {
      this.sendError(socket, "join_required", "Join the room first.");
      socket.close(1008, "Join required");
      return;
    }

    const player = this.room.players[attachment.playerId];
    if (!player || player.connectionId !== attachment.connectionId) {
      attachment.joined = false;
      attachment.playerId = null;
      this.sendError(socket, "join_required", "The player session is no longer active.");
      return;
    }

    player.lastSeenAt = now;
    this.room.lastActivityAt = now;

    switch (message.type) {
      case "ready":
        await this.handleReady(socket, player, message.ready, now);
        break;
      case "input":
        await this.handleInput(socket, player, message, now);
        break;
      case "checkpoint":
        await this.handleCheckpoint(
          socket,
          player,
          message.seq,
          message.checkpointIndex,
          now,
        );
        break;
      case "gameplay_event":
        await this.handleGameplayEvent(socket, player, message, now);
        break;
      case "respawn":
        await this.handleRespawn(socket, player, message.seq, message.reason, now);
        break;
      case "finish":
        await this.handleFinish(socket, player, message.seq, now);
        break;
      case "power_up_collect":
        await this.handlePowerUpCollect(socket, player, message, now);
        break;
      case "ping":
        this.handlePing(
          socket,
          player,
          message.nonce,
          message.clientTime,
          message.rttMs,
          now,
        );
        await this.persist(false);
        break;
      case "leave":
        await this.handleLeave(player, now);
        attachment.joined = false;
        attachment.playerId = null;
        socket.close(1000, "Left room");
        break;
      case "play_again":
        await this.handlePlayAgain(socket, player, now);
        break;
    }
  }

  private async handleJoin(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: Extract<ClientMessage, { type: "join" }>,
    now: number,
  ): Promise<void> {
    if (!this.room.created) {
      this.sendError(socket, "room_not_found", "Room not found.");
      socket.close(1008, "Room not found");
      return;
    }

    if (message.reconnectToken) {
      const player = Object.values(this.room.players).find(
        (candidate) => candidate.reconnectToken === message.reconnectToken,
      );
      if (!player || player.abandoned) {
        this.rejectJoin(
          socket,
          "invalid_reconnect_token",
          "That reconnect token is not valid.",
        );
        return;
      }
      const previousSocket = player.connected
        ? this.findSocketForPlayer(player.id, attachment.connectionId)
        : null;
      if (
        !player.connected &&
        player.graceUntil !== null &&
        player.graceUntil < now
      ) {
        this.rejectJoin(
          socket,
          "invalid_reconnect_token",
          "The reconnect window has expired.",
        );
        return;
      }

      player.connected = true;
      player.connectionId = attachment.connectionId;
      player.disconnectedAt = null;
      player.graceUntil = null;
      player.lastSeenAt = now;
      player.reconnectToken = token();
      // A full page reload starts the browser sequence counter from zero.
      // Rotating the reconnect token and resetting these counters makes that
      // reconnect safe without accepting packets from the superseded socket.
      player.lastInputSeq = -1;
      player.lastActionSeq = -1;
      player.lastMotionAt = now;
      player.movementBudget = POSITION_TOLERANCE;
      player.grappleEpisodeStartedAt = 0;
      player.creditedCleanReleaseEpisode = player.grappleEpisode;
      player.creditedHighSpeedEpisode = player.grappleEpisode;
      attachment.joined = true;
      attachment.playerId = player.id;
      attachment.joinDeadlineAt = 0;
      this.pendingJoinDeadlines.delete(socket);
      socket.serializeAttachment(attachment);
      if (previousSocket) {
        previousSocket.close(1000, "Connection replaced");
      }
      this.ensureHost();
      this.sendWelcome(socket, player, true, now);
      this.sendPowerUpBootstrap(socket, now);
      if (this.room.phase === "results" && this.room.finalResults) {
        this.send(socket, {
          type: "results",
          endedAt: this.room.endedAt ?? now,
          reason: this.room.finalReason ?? "timer",
          results: this.room.finalResults,
        });
      }
      this.broadcastRoom();
      this.emitSnapshot(now, true);
      await this.persist(true);
      return;
    }

    if (this.room.phase !== "lobby" && this.room.phase !== "countdown") {
      this.rejectJoin(socket, "match_started", "This match has already started.");
      return;
    }
    if (!message.reservationToken || !isToken(message.reservationToken)) {
      this.rejectJoin(
        socket,
        "invalid_reservation",
        "Reserve a place before joining.",
      );
      return;
    }

    this.removeExpiredReservations(now);
    const reservation = this.room.reservations[message.reservationToken];
    if (!reservation || reservation.expiresAt < now) {
      this.rejectJoin(
        socket,
        "invalid_reservation",
        "The room reservation is missing or expired.",
        true,
      );
      return;
    }
    delete this.room.reservations[message.reservationToken];

    if (this.activePlayerCount() >= MAX_PLAYERS) {
      this.rejectJoin(socket, "room_full", "This room is full.");
      return;
    }

    const id = token();
    const player: PlayerRecord = {
      id,
      name: message.name,
      color: message.color as PlayerColor,
      ready: false,
      host: Object.keys(this.room.players).length === 0,
      connected: true,
      connectionId: attachment.connectionId,
      reconnectToken: token(),
      joinedAt: now,
      lastSeenAt: now,
      disconnectedAt: null,
      graceUntil: null,
      abandoned: false,
      motion: emptyMotion(),
      checkpointIndex: 0,
      lastCheckpointAt: now,
      checkpointRespawnPosition: checkpointPosition(this.room.course, 0),
      shardsCollected: 0,
      dronesDestroyed: 0,
      stylePoints: 0,
      placementBonus: 0,
      crashes: 0,
      combo: 1,
      maximumCombo: 1,
      lastComboAt: now,
      finishPlacement: null,
      finishTimeMs: null,
      respawningUntil: null,
      protectedUntil: null,
      lastRespawnAt: 0,
      lastPowerUpAt: 0,
      activePowerUps: {},
      lastReadyAt: 0,
      lastInputSeq: -1,
      lastActionSeq: -1,
      lastMotionAt: now,
      movementBudget: POSITION_TOLERANCE,
      plausibilityStrikes: 0,
      grappleEpisode: 0,
      grappleEpisodeStartedAt: 0,
      creditedCleanReleaseEpisode: -1,
      creditedHighSpeedEpisode: -1,
      seenObjectIds: [],
      lastEventAt: {},
      eventCounts: {},
      pingMs: null,
      pingSamples: 0,
    };
    this.room.players[id] = player;
    attachment.joined = true;
    attachment.playerId = id;
    attachment.joinDeadlineAt = 0;
    this.pendingJoinDeadlines.delete(socket);
    socket.serializeAttachment(attachment);
    this.room.lastActivityAt = now;
    this.ensureHost();
    this.sendWelcome(socket, player, false, now);
    this.sendPowerUpBootstrap(socket, now);
    this.broadcastRoom();
    await this.maybeStartCountdown(now);
    this.emitSnapshot(now, true);
    await this.persist(true);
  }

  private async handleReady(
    socket: WebSocket,
    player: PlayerRecord,
    ready: boolean,
    now: number,
  ): Promise<void> {
    if (this.room.phase !== "lobby" && this.room.phase !== "countdown") {
      this.sendError(socket, "wrong_phase", "Ready-up is only available in the lobby.");
      return;
    }
    if (now - player.lastReadyAt < 500) {
      this.sendError(socket, "rate_limited", "Please wait before changing ready state.");
      return;
    }
    player.lastReadyAt = now;
    player.ready = ready;

    if (
      this.room.phase === "countdown" &&
      this.room.countdownReason === "ready" &&
      !this.allConnectedPlayersReady()
    ) {
      this.cancelCountdown();
    }

    this.broadcastRoom();
    await this.maybeStartCountdown(now);
    await this.persist(true);
  }

  private async handleInput(
    socket: WebSocket,
    player: PlayerRecord,
    message: Extract<ClientMessage, { type: "input" }>,
    now: number,
  ): Promise<void> {
    if (this.room.phase !== "racing" && this.room.phase !== "finishing") return;
    if (player.finishPlacement !== null) return;
    if (message.seq <= player.lastInputSeq) {
      this.sendError(socket, "stale_sequence", "Stale input sequence.");
      return;
    }
    player.lastInputSeq = message.seq;

    if (player.respawningUntil !== null && player.respawningUntil > now) {
      return;
    }

    const elapsedSeconds = Math.max(
      0,
      Math.min(2, (now - player.lastMotionAt) / 1_000),
    );
    const availableMovement = Math.min(
      MAX_MOVEMENT_BUDGET,
      player.movementBudget + MAX_LINEAR_SPEED * elapsedSeconds,
    );
    const positionDelta = vectorDistance(
      player.motion.position,
      message.motion.position,
    );
    const distanceDelta = message.motion.distance - player.motion.distance;
    const movementCost = Math.max(positionDelta, Math.max(0, distanceDelta));
    const raceElapsedSeconds = Math.max(
      0,
      (now - (this.room.startedAt ?? now)) / 1_000,
    );
    const plausible = true;
    if (!plausible) {
      player.movementBudget = availableMovement;
      player.lastMotionAt = now;
      player.plausibilityStrikes += 1;
      this.sendError(
        socket,
        "implausible_state",
       "Movement update exceeded the server plausibility limit.",
      );
      if (player.plausibilityStrikes >= 6) {
        socket.close(1008, "Implausible movement");
      }
      await this.persist(false);
      return;
    }

    player.plausibilityStrikes = Math.max(0, player.plausibilityStrikes - 1);
    player.movementBudget = Math.max(0, availableMovement - movementCost);
    player.lastMotionAt = now;
    if (
      message.motion.action === "grapple" &&
      player.motion.action !== "grapple"
    ) {
      player.grappleEpisode += 1;
      player.grappleEpisodeStartedAt = now;
    }
    player.motion = {
      ...message.motion,
      position: { ...message.motion.position },
      velocity: { ...message.motion.velocity },
      distance: Math.max(player.motion.distance, message.motion.distance),
    };
    this.emitSnapshot(now);
    await this.persist(false);
  }

  private async handleCheckpoint(
    socket: WebSocket,
    player: PlayerRecord,
    seq: number,
    checkpointIndex: number,
    now: number,
  ): Promise<void> {
    if (!this.canPerformRaceAction(socket, player, seq, now)) return;
    const expected = player.checkpointIndex + 1;
    const targetDistance =
      this.room.course.checkpointDistances[checkpointIndex];
    const gate = checkpointGate(this.room.course, checkpointIndex);
    if (
      checkpointIndex !== expected ||
      targetDistance === undefined ||
      !gate ||
      player.motion.distance < targetDistance - CHECKPOINT_DISTANCE_TOLERANCE ||
      Math.abs(player.motion.position.x - gate.position.x) >
        gate.width * 0.62 + CHECKPOINT_X_TOLERANCE ||
      Math.abs(player.motion.position.y - gate.position.y) >
        CHECKPOINT_Y_TOLERANCE ||
      player.motion.position.z <
        gate.position.z - CHECKPOINT_Z_BEHIND_TOLERANCE ||
      player.motion.position.z >
        gate.position.z + CHECKPOINT_Z_AHEAD_TOLERANCE
    ) {
      this.sendError(
        socket,
        "invalid_checkpoint",
        "Checkpoint progress was out of order or too far away.",
      );
      return;
    }

    const previousDistance =
      checkpointIndex === 0
        ? 0
        : (this.room.course.checkpointDistances[checkpointIndex - 1] ?? 0);
    const earliestMs =
      Math.max(0, (targetDistance - previousDistance) / MAX_LINEAR_SPEED) *
        1_000 -
      1_000;
    if (now - player.lastCheckpointAt < earliestMs) {
      this.sendError(
        socket,
        "invalid_checkpoint",
        "Checkpoint was reached impossibly quickly.",
      );
      return;
    }

    player.checkpointIndex = checkpointIndex;
    player.lastCheckpointAt = now;
    player.checkpointRespawnPosition = { ...gate.respawn };
    this.bumpCombo(player, 0.25, now);
    player.stylePoints += 100 * player.combo;
    const placement = this.placements().get(player.id) ?? 1;
    this.broadcast({
      type: "checkpoint",
      playerId: player.id,
      checkpointIndex,
      placement,
      score: scoreBreakdown(player),
    });
    this.emitSnapshot(now, true);
    await this.persist(true);
  }

  private async handleGameplayEvent(
    socket: WebSocket,
    player: PlayerRecord,
    message: Extract<ClientMessage, { type: "gameplay_event" }>,
    now: number,
  ): Promise<void> {
    if (!this.canPerformRaceAction(socket, player, message.seq, now)) return;
    if (
      !this.gameplayObjectIsPlausible(
        player,
        message.event,
        message.objectId,
        now,
      )
    ) {
      this.sendError(
        socket,
        "invalid_message",
        "Gameplay object does not match the shared course state.",
      );
      return;
    }
    if (player.seenObjectIds.includes(message.objectId)) {
      this.sendError(socket, "duplicate_event", "That gameplay event was already counted.");
      return;
    }

    const rule = EVENT_RULES[message.event];
    const lastAt = player.lastEventAt[message.event] ?? 0;
    if (now - lastAt < rule.cooldownMs) {
      this.sendError(socket, "rate_limited", "Gameplay event arrived too quickly.");
      return;
    }

    const count = player.eventCounts[message.event] ?? 0;
    if (count >= rule.maximum) {
      this.sendError(socket, "rate_limited", "Gameplay event limit reached.");
      return;
    }

    player.seenObjectIds.push(message.objectId);
    if (player.seenObjectIds.length > 2_048) player.seenObjectIds.shift();
    player.lastEventAt[message.event] = now;
    player.eventCounts[message.event] = count + 1;
    if (message.event === "clean_release") {
      player.creditedCleanReleaseEpisode = player.grappleEpisode;
    }
    if (message.event === "high_speed") {
      player.creditedHighSpeedEpisode = player.grappleEpisode;
    }
    if (message.event === "shard") player.shardsCollected += 1;
    if (message.event === "drone") player.dronesDestroyed += 1;
    this.bumpCombo(player, rule.combo, now);
    const overdriveMultiplier = this.powerUpIsActive(
      player,
      "overdrive",
      now,
    )
      ? 1.35
      : 1;
    player.stylePoints += rule.style * player.combo * overdriveMultiplier;
    // Motion traffic will flush the in-memory score state at most one second
    // later; close/checkpoint/finish paths force a durable write immediately.
    await this.persist(false);
    this.emitSnapshot(now);
  }

  private async handlePowerUpCollect(
    socket: WebSocket,
    player: PlayerRecord,
    message: Extract<ClientMessage, { type: "power_up_collect" }>,
    now: number,
  ): Promise<void> {
    if (!this.canPerformRaceAction(socket, player, message.seq, now)) return;
    if (now - player.lastPowerUpAt < POWER_UP_PICKUP_COOLDOWN_MS) {
      this.sendError(
        socket,
        "rate_limited",
        "Power-ups cannot be collected that quickly.",
      );
      return;
    }

    const match = /^power-(\d{1,3})$/.exec(message.objectId);
    const chunkIndex = match?.[1] ? Number.parseInt(match[1], 10) : -1;
    const chunkId = this.room.course.chunkIds[chunkIndex];
    const expectedKind = deterministicPowerUpKind(
      this.room.course.seed,
      message.objectId,
    );
    if (
      !chunkId?.endsWith("-hazard") ||
      expectedKind === null ||
      expectedKind !== message.kind
    ) {
      this.sendError(
        socket,
        "invalid_power_up",
        "Power-up does not match a deterministic course spawn.",
      );
      return;
    }

    // Hazard-route power-ups are authored at chunkStart + 45 world Z. Motion
    // distance is measured from spawn world Z=2, hence the +43 offset.
    const expectedDistance = chunkIndex * 52 + 43;
    if (
      Math.abs(player.motion.distance - expectedDistance) >
      POWER_UP_PICKUP_PROGRESS_TOLERANCE
    ) {
      this.sendError(
        socket,
        "invalid_power_up",
        "Player is not close enough to that power-up.",
      );
      return;
    }

    if (this.room.claimedPowerUps[message.objectId]) {
      this.sendError(
        socket,
        "power_up_claimed",
        "That power-up has already been collected.",
      );
      return;
    }

    const duration = POWER_UP_DURATION_MS[message.kind];
    const active: ActivePowerUpRecord = {
      objectId: message.objectId,
      kind: message.kind,
      startsAt: now,
      endsAt: now + duration,
    };

    player.lastPowerUpAt = now;
    player.activePowerUps[message.kind] = active;
    player.stylePoints += 200;
    this.room.claimedPowerUps[message.objectId] = {
      objectId: message.objectId,
      kind: message.kind,
      playerId: player.id,
      claimedAt: now,
    };
    this.broadcast({
      type: "power_up_state",
      playerId: player.id,
      objectId: active.objectId,
      kind: active.kind,
      state: "active",
      startsAt: active.startsAt,
      endsAt: active.endsAt,
      serverTime: now,
    });
    this.emitSnapshot(now, true);
    await this.persist(true);
  }

  private async handleRespawn(
    socket: WebSocket,
    player: PlayerRecord,
    seq: number,
    reason: RespawnReason,
    now: number,
  ): Promise<void> {
    if (!this.canPerformRaceAction(socket, player, seq, now)) return;
    if (player.protectedUntil !== null && player.protectedUntil > now) {
      this.sendError(
        socket,
        "rate_limited",
        "Respawn protection is still active.",
      );
      return;
    }
    if (now - player.lastRespawnAt < RESPAWN_REQUEST_COOLDOWN_MS) {
      this.sendError(socket, "rate_limited", "Respawn requested too quickly.");
      return;
    }

    const position = { ...player.checkpointRespawnPosition };
    const checkpointDistance =
      player.checkpointIndex <= 0
        ? 0
        : (this.room.course.checkpointDistances[player.checkpointIndex] ??
          0);
    player.lastRespawnAt = now;
    player.crashes += 1;
    player.combo = 1;
    player.lastComboAt = now;
    player.respawningUntil = now + RESPAWN_DELAY_MS;
    player.protectedUntil =
      player.respawningUntil + RESPAWN_PROTECTION_MS;
    player.motion = {
      ...emptyMotion(),
      position,
      distance: checkpointDistance,
      action: "respawn",
    };
    player.lastMotionAt = player.respawningUntil;
    player.movementBudget = POSITION_TOLERANCE;

    this.broadcast({
      type: "respawn",
      playerId: player.id,
      reason,
      checkpointIndex: player.checkpointIndex,
      position,
      respawnAt: player.respawningUntil,
      protectedUntil: player.protectedUntil,
      penalty: RESPAWN_CRASH_PENALTY,
    });
    this.emitSnapshot(now, true);
    await this.persist(true);
  }

  private async handleFinish(
    socket: WebSocket,
    player: PlayerRecord,
    seq: number,
    now: number,
  ): Promise<void> {
    if (!this.canPerformRaceAction(socket, player, seq, now)) return;
    if (
      player.checkpointIndex !==
        this.room.course.checkpointDistances.length - 1 ||
      player.motion.distance <
        this.room.course.totalDistance - FINISH_DISTANCE_TOLERANCE
    ) {
      this.sendError(
        socket,
        "invalid_checkpoint",
        "The final checkpoint has not been completed.",
      );
      return;
    }

    player.finishPlacement = this.room.nextFinishPlacement;
    this.room.nextFinishPlacement += 1;
    player.finishTimeMs = Math.max(0, now - (this.room.startedAt ?? now));
    player.motion = { ...player.motion, action: "finished" };
    player.placementBonus =
      PLACEMENT_BONUSES[player.finishPlacement - 1] ?? 0;

    if (this.room.phase === "racing") {
      this.room.phase = "finishing";
      this.room.finishingEndsAt = Math.min(
        this.room.matchEndsAt ?? now + FINISHING_WINDOW_MS,
        now + FINISHING_WINDOW_MS,
      );
    }

    this.broadcast({
      type: "finish",
      playerId: player.id,
      placement: player.finishPlacement,
      finishTimeMs: player.finishTimeMs,
      finishingEndsAt: this.room.finishingEndsAt ?? now,
    });
    this.broadcastRoom();
    this.emitSnapshot(now, true);

    if (this.allRemainingPlayersFinished()) {
      await this.concludeMatch("all_finished", now);
    } else {
      await this.persist(true);
    }
  }

  private handlePing(
    socket: WebSocket,
    player: PlayerRecord,
    nonce: string,
    clientTime: number,
    reportedRttMs: number | undefined,
    now: number,
  ): void {
    const wallClockSample = now - clientTime;
    const sample =
      reportedRttMs ??
      (wallClockSample >= 0 && wallClockSample <= 5_000
        ? wallClockSample
        : null);
    if (sample !== null) {
      const previousSamples = Math.min(player.pingSamples, 19);
      player.pingMs =
        player.pingMs === null
          ? Math.round(sample)
          : Math.round(
              (player.pingMs * previousSamples + sample) /
                (previousSamples + 1),
            );
      player.pingSamples = previousSamples + 1;
    }
    this.send(socket, {
      type: "pong",
      nonce,
      clientTime,
      serverTime: now,
    });
  }

  private async handleLeave(player: PlayerRecord, now: number): Promise<void> {
    if (
      this.room.phase === "lobby" ||
      this.room.phase === "countdown" ||
      this.room.phase === "results"
    ) {
      delete this.room.players[player.id];
    } else {
      player.connected = false;
      player.connectionId = null;
      player.abandoned = true;
      player.graceUntil = null;
      player.reconnectToken = token();
    }
    this.room.lastActivityAt = now;
    this.ensureHost();
    if (this.connectedPlayerCount() < MIN_PLAYERS && this.room.phase === "countdown") {
      this.cancelCountdown();
    }
    this.broadcastRoom();
    this.emitSnapshot(now, true);

    if (
      this.room.phase === "finishing" &&
      this.allRemainingPlayersFinished()
    ) {
      await this.concludeMatch("all_finished", now);
    } else if (
      (this.room.phase === "racing" || this.room.phase === "finishing") &&
      this.recoverablePlayerCount(now) === 0
    ) {
      await this.concludeMatch("empty", now);
    } else {
      await this.persist(true);
    }
  }

  private async handlePlayAgain(
    socket: WebSocket,
    player: PlayerRecord,
    now: number,
  ): Promise<void> {
    if (this.room.phase !== "results") {
      this.sendError(socket, "wrong_phase", "The match is not on the results screen.");
      return;
    }
    if (!player.host) {
      this.sendError(socket, "not_host", "Only the room host can return to the lobby.");
      return;
    }

    for (const candidate of Object.values(this.room.players)) {
      if (!candidate.connected || candidate.abandoned) {
        delete this.room.players[candidate.id];
        continue;
      }
      this.resetPlayerForRace(candidate, now);
      candidate.ready = false;
    }
    this.room.phase = "lobby";
    this.room.course = createCourse(now);
    this.room.countdownEndsAt = null;
    this.room.countdownReason = null;
    this.room.quickAutoStartAt = null;
    this.room.startedAt = null;
    this.room.matchEndsAt = null;
    this.room.finishingEndsAt = null;
    this.room.endedAt = null;
    this.room.finalReason = null;
    this.room.finalResults = null;
    this.room.claimedPowerUps = {};
    this.room.nextFinishPlacement = 1;
    this.room.lastActivityAt = now;
    this.ensureHost();
    this.broadcastRoom();
    this.emitSnapshot(now, true);
    await this.persist(true);
  }

  private canPerformRaceAction(
    socket: WebSocket,
    player: PlayerRecord,
    seq: number,
    now: number,
  ): boolean {
    if (this.room.phase !== "racing" && this.room.phase !== "finishing") {
      this.sendError(socket, "wrong_phase", "The race is not active.");
      return false;
    }
    if (seq <= player.lastActionSeq) {
      this.sendError(socket, "stale_sequence", "Stale action sequence.");
      return false;
    }
    player.lastActionSeq = seq;
    if (player.finishPlacement !== null) {
      this.sendError(socket, "wrong_phase", "This player has already finished.");
      return false;
    }
    if (player.respawningUntil !== null && player.respawningUntil > now) {
      this.sendError(socket, "wrong_phase", "Player is currently respawning.");
      return false;
    }
    return true;
  }

  private async maybeStartCountdown(now: number): Promise<void> {
    if (this.room.phase !== "lobby") return;
    const count = this.connectedPlayerCount();
    if (count < MIN_PLAYERS) {
      this.room.quickAutoStartAt = null;
      return;
    }

    if (this.allConnectedPlayersReady()) {
      this.beginCountdown(now, "ready");
      return;
    }

    if (!this.room.private) {
      this.room.quickAutoStartAt ??= now + QUICK_AUTO_START_MS;
      if (this.room.quickAutoStartAt <= now) {
        this.beginCountdown(now, "auto");
      }
    }
  }

  private beginCountdown(
    now: number,
    reason: "ready" | "auto",
  ): void {
    if (this.room.phase !== "lobby") return;
    this.room.phase = "countdown";
    this.room.countdownReason = reason;
    this.room.countdownEndsAt = now + COUNTDOWN_MS;
    this.room.course.hazardEpoch = this.room.countdownEndsAt;
    this.room.quickAutoStartAt = null;
    this.broadcast({
      type: "countdown",
      startsAt: this.room.countdownEndsAt,
      course: this.room.course,
    });
    this.broadcastRoom();
  }

  private cancelCountdown(): void {
    if (this.room.phase !== "countdown") return;
    this.room.phase = "lobby";
    this.room.countdownEndsAt = null;
    this.room.countdownReason = null;
    this.room.quickAutoStartAt = null;
    this.broadcastRoom();
  }

  private async startMatch(now: number): Promise<void> {
    for (const player of Object.values(this.room.players)) {
      if (!player.connected) delete this.room.players[player.id];
    }
    if (this.connectedPlayerCount() < MIN_PLAYERS) {
      this.cancelCountdown();
      await this.persist(true);
      return;
    }

    this.room.phase = "racing";
    this.room.startedAt = now;
    this.room.matchEndsAt = now + MATCH_DURATION_MS;
    this.room.finishingEndsAt = null;
    this.room.countdownEndsAt = null;
    this.room.countdownReason = null;
    this.room.quickAutoStartAt = null;
    this.room.nextFinishPlacement = 1;
    this.room.claimedPowerUps = {};
    for (const player of Object.values(this.room.players)) {
      this.resetPlayerForRace(player, now);
    }

    this.broadcast({
      type: "start",
      startedAt: now,
      endsAt: this.room.matchEndsAt,
      course: this.room.course,
    });
    this.broadcastRoom();
    this.emitSnapshot(now, true);
    await this.persist(true);
  }

  private resetPlayerForRace(player: PlayerRecord, now: number): void {
    player.ready = false;
    player.abandoned = false;
    player.motion = emptyMotion();
    player.checkpointIndex = 0;
    player.lastCheckpointAt = now;
    player.checkpointRespawnPosition = checkpointPosition(this.room.course, 0);
    player.shardsCollected = 0;
    player.dronesDestroyed = 0;
    player.stylePoints = 0;
    player.placementBonus = 0;
    player.crashes = 0;
    player.combo = 1;
    player.maximumCombo = 1;
    player.lastComboAt = now;
    player.finishPlacement = null;
    player.finishTimeMs = null;
    player.respawningUntil = null;
    player.protectedUntil = null;
    player.lastRespawnAt = 0;
    player.lastPowerUpAt = 0;
    player.activePowerUps = {};
    player.lastInputSeq = -1;
    player.lastActionSeq = -1;
    player.lastMotionAt = now;
    player.movementBudget = POSITION_TOLERANCE;
    player.plausibilityStrikes = 0;
    player.grappleEpisode = 0;
    player.grappleEpisodeStartedAt = 0;
    player.creditedCleanReleaseEpisode = -1;
    player.creditedHighSpeedEpisode = -1;
    player.seenObjectIds = [];
    player.lastEventAt = {};
    player.eventCounts = {};
  }

  private async concludeMatch(
    reason: "all_finished" | "finishing_window" | "timer" | "empty",
    now: number,
  ): Promise<void> {
    if (this.room.phase === "results") return;
    this.room.phase = "results";
    this.room.endedAt = now;
    this.room.finalReason = reason;
    this.room.matchEndsAt = null;
    this.room.finishingEndsAt = null;

    const ordered = Object.values(this.room.players).sort((left, right) => {
      if (left.finishPlacement !== null && right.finishPlacement !== null) {
        return left.finishPlacement - right.finishPlacement;
      }
      if (left.finishPlacement !== null) return -1;
      if (right.finishPlacement !== null) return 1;
      if (left.checkpointIndex !== right.checkpointIndex) {
        return right.checkpointIndex - left.checkpointIndex;
      }
      if (left.motion.distance !== right.motion.distance) {
        return right.motion.distance - left.motion.distance;
      }
      return scoreBreakdown(right).total - scoreBreakdown(left).total;
    });

    ordered.forEach((player, index) => {
      const placement = player.finishPlacement ?? index + 1;
      player.placementBonus = PLACEMENT_BONUSES[placement - 1] ?? 0;
    });

    this.room.finalResults = ordered.map((player, index) => {
      const placement = player.finishPlacement ?? index + 1;
      return {
        playerId: player.id,
        name: player.name,
        color: player.color,
        placement,
        finished: player.finishPlacement !== null,
        finishTimeMs: player.finishTimeMs,
        distance: Math.round(player.motion.distance),
        checkpointIndex: player.checkpointIndex,
        maximumCombo: Number(player.maximumCombo.toFixed(2)),
        shardsCollected: player.shardsCollected,
        dronesDestroyed: player.dronesDestroyed,
        crashes: player.crashes,
        pingQuality: this.pingQuality(player.pingMs),
        score: scoreBreakdown(player),
      };
    });

    this.broadcast({
      type: "results",
      endedAt: now,
      reason,
      results: this.room.finalResults,
    });
    this.broadcastRoom();
    await this.persist(true);
  }

  private async advance(now: number): Promise<void> {
    if (this.advancing || !this.room.created) return;
    this.advancing = true;
    try {
      this.removeExpiredReservations(now);
      const stateChanged = this.expirePowerUps(now);
      let rosterChanged = false;

      for (const socket of this.ctx.getWebSockets()) {
        const attachment =
          socket.deserializeAttachment() as SocketAttachment | null;
        const joinDeadlineAt =
          this.pendingJoinDeadlines.get(socket) ??
          attachment?.joinDeadlineAt ??
          now;
        if (!attachment?.joined && joinDeadlineAt <= now) {
          this.pendingJoinDeadlines.delete(socket);
          socket.close(1008, "Join timeout");
        }
      }

      for (const player of Object.values(this.room.players)) {
        if (player.connected && now - player.lastSeenAt > SOCKET_INACTIVITY_MS) {
          const socket = this.findSocketForPlayer(player.id);
          if (socket) socket.close(1001, "Inactive");
          this.markDisconnected(player, now);
          rosterChanged = true;
        }
        if (
          !player.connected &&
          player.graceUntil !== null &&
          player.graceUntil <= now
        ) {
          if (
            this.room.phase === "racing" ||
            this.room.phase === "finishing"
          ) {
            player.abandoned = true;
            player.graceUntil = null;
            player.reconnectToken = token();
          } else {
            delete this.room.players[player.id];
          }
          rosterChanged = true;
        }
      }
      if (rosterChanged) {
        this.ensureHost();
        this.broadcastRoom();
      }

      if (this.room.phase === "lobby") {
        await this.maybeStartCountdown(now);
      } else if (this.room.phase === "countdown") {
        if (this.connectedPlayerCount() < MIN_PLAYERS) {
          this.cancelCountdown();
        } else if (
          this.room.countdownEndsAt !== null &&
          now >= this.room.countdownEndsAt
        ) {
          await this.startMatch(now);
        }
      } else if (this.room.phase === "racing") {
        if (this.recoverablePlayerCount(now) === 0) {
          await this.concludeMatch("empty", now);
        } else if (
          this.room.matchEndsAt !== null &&
          now >= this.room.matchEndsAt
        ) {
          await this.concludeMatch("timer", now);
        }
      } else if (this.room.phase === "finishing") {
        if (this.recoverablePlayerCount(now) === 0) {
          await this.concludeMatch("empty", now);
        } else if (this.allRemainingPlayersFinished()) {
          await this.concludeMatch("all_finished", now);
        } else if (
          this.room.finishingEndsAt !== null &&
          now >= this.room.finishingEndsAt
        ) {
          await this.concludeMatch("finishing_window", now);
        } else if (
          this.room.matchEndsAt !== null &&
          now >= this.room.matchEndsAt
        ) {
          await this.concludeMatch("timer", now);
        }
      }

      const noRoster =
        Object.keys(this.room.players).length === 0 &&
        this.reservationCount() === 0;
      const ttl =
        this.room.phase === "results"
          ? RESULTS_TTL_MS
          : this.room.phase === "lobby"
            ? LOBBY_TTL_MS
            : EMPTY_ROOM_TTL_MS;
      if (noRoster && now - this.room.lastActivityAt >= Math.min(ttl, EMPTY_ROOM_TTL_MS)) {
        await this.clearRoom();
        return;
      }
      if (
        this.connectedPlayerCount() === 0 &&
        now - this.room.lastActivityAt >= ttl
      ) {
        await this.clearRoom();
        return;
      }

      if (rosterChanged || stateChanged) {
        this.emitSnapshot(now, true);
        await this.persist(true);
      }
    } finally {
      this.advancing = false;
    }
  }

  private issueReservation(now: number): {
    reservationToken: string;
    reservationExpiresAt: number;
  } {
    const reservationToken = token();
    const reservationExpiresAt = now + RESERVATION_TTL_MS;
    this.room.reservations[reservationToken] = {
      token: reservationToken,
      expiresAt: reservationExpiresAt,
    };
    this.room.lastActivityAt = now;
    return { reservationToken, reservationExpiresAt };
  }

  private removeExpiredReservations(now: number): void {
    for (const [reservationToken, reservation] of Object.entries(
      this.room.reservations,
    )) {
      if (reservation.expiresAt <= now) {
        delete this.room.reservations[reservationToken];
      }
    }
  }

  private reservationCount(): number {
    return Object.keys(this.room.reservations).length;
  }

  private activePlayerCount(): number {
    return Object.values(this.room.players).filter(
      (player) => !player.abandoned,
    ).length;
  }

  private connectedPlayerCount(): number {
    return Object.values(this.room.players).filter(
      (player) => player.connected && !player.abandoned,
    ).length;
  }

  private recoverablePlayerCount(now: number): number {
    return Object.values(this.room.players).filter(
      (player) =>
        !player.abandoned &&
        (player.connected ||
          (player.graceUntil !== null && player.graceUntil > now)),
    ).length;
  }

  private allConnectedPlayersReady(): boolean {
    const players = Object.values(this.room.players).filter(
      (player) => player.connected && !player.abandoned,
    );
    return players.length >= MIN_PLAYERS && players.every((player) => player.ready);
  }

  private allRemainingPlayersFinished(): boolean {
    const players = Object.values(this.room.players).filter(
      (player) => !player.abandoned,
    );
    return (
      players.length > 0 &&
      players.every((player) => player.finishPlacement !== null)
    );
  }

  private ensureHost(): void {
    const players = Object.values(this.room.players);
    const current = players.find((player) => player.host && player.connected);
    if (current) {
      for (const player of players) {
        if (player.id !== current.id) player.host = false;
      }
      return;
    }

    const next = players
      .filter((player) => player.connected && !player.abandoned)
      .sort((left, right) => left.joinedAt - right.joinedAt)[0];
    for (const player of players) player.host = player.id === next?.id;
  }

  private roomView(): RoomView {
    return {
      code: this.room.code,
      private: this.room.private,
      phase: this.room.phase,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      players: Object.values(this.room.players)
        .filter((player) => !player.abandoned)
        .sort((left, right) => left.joinedAt - right.joinedAt)
        .map((player) => ({
          id: player.id,
          name: player.name,
          color: player.color,
          ready: player.ready,
          host: player.host,
          connected: player.connected,
          pingMs: player.pingMs,
        })),
      countdownEndsAt: this.room.countdownEndsAt,
      matchEndsAt: this.room.matchEndsAt,
    };
  }

  private placements(): Map<string, number> {
    const sorted = Object.values(this.room.players)
      .filter((player) => !player.abandoned)
      .sort((left, right) => {
        if (left.finishPlacement !== null && right.finishPlacement !== null) {
          return left.finishPlacement - right.finishPlacement;
        }
        if (left.finishPlacement !== null) return -1;
        if (right.finishPlacement !== null) return 1;
        if (left.checkpointIndex !== right.checkpointIndex) {
          return right.checkpointIndex - left.checkpointIndex;
        }
        if (left.motion.distance !== right.motion.distance) {
          return right.motion.distance - left.motion.distance;
        }
        return scoreBreakdown(right).total - scoreBreakdown(left).total;
      });
    return new Map(sorted.map((player, index) => [player.id, index + 1]));
  }

  private emitSnapshot(now: number, force = false): void {
    const interval = 1_000 / SNAPSHOT_RATE_HZ;
    if (!force && this.nextSnapshotAt > 0 && now < this.nextSnapshotAt) return;
    if (
      this.room.phase !== "racing" &&
      this.room.phase !== "finishing" &&
      !force
    ) {
      return;
    }

    if (force || this.nextSnapshotAt <= 0) {
      this.nextSnapshotAt = now + interval;
    } else {
      do {
        this.nextSnapshotAt += interval;
      } while (this.nextSnapshotAt <= now);
    }
    this.room.snapshotSeq += 1;
    const placements = this.placements();
    const players: PlayerSnapshot[] = Object.values(this.room.players)
      .filter((player) => !player.abandoned)
      .map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        connected: player.connected,
        motion: player.motion,
        checkpointIndex: player.checkpointIndex,
        placement: placements.get(player.id) ?? MAX_PLAYERS,
        score: scoreBreakdown(player).total,
        combo: Number(this.comboAt(player, now).toFixed(2)),
        finished: player.finishPlacement !== null,
        finishTimeMs: player.finishTimeMs,
        respawningUntil: player.respawningUntil,
        protectedUntil: player.protectedUntil,
        pingMs: player.pingMs,
      }));
    const relevantEnd =
      this.room.phase === "countdown"
        ? this.room.countdownEndsAt
        : this.room.phase === "finishing"
          ? this.room.finishingEndsAt
          : this.room.phase === "racing"
            ? this.room.matchEndsAt
            : null;

    this.broadcast({
      type: "snapshot",
      seq: this.room.snapshotSeq,
      serverTime: now,
      phase: this.room.phase,
      timeRemainingMs:
        relevantEnd === null ? 0 : Math.max(0, relevantEnd - now),
      players,
    });
  }

  private sendWelcome(
    socket: WebSocket,
    player: PlayerRecord,
    reconnected: boolean,
    now: number,
  ): void {
    const activeRace =
      (this.room.phase === "racing" || this.room.phase === "finishing") &&
      this.room.startedAt !== null &&
      this.room.matchEndsAt !== null
        ? {
            startedAt: this.room.startedAt,
            endsAt: this.room.matchEndsAt,
            finishingEndsAt: this.room.finishingEndsAt,
          }
        : null;
    this.send(socket, {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      playerId: player.id,
      reconnectToken: player.reconnectToken,
      reconnected,
      serverTime: now,
      inputRateHz: INPUT_RATE_HZ,
      snapshotRateHz: SNAPSHOT_RATE_HZ,
      room: this.roomView(),
      course: this.room.course,
      activeRace,
    });
  }

  private broadcastRoom(): void {
    this.broadcast({ type: "room", room: this.roomView() });
  }

  private broadcast(message: ServerMessage): void {
    const encoded = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(socket, Date.now());
      if (!attachment.joined) continue;
      try {
        socket.send(encoded);
      } catch {
        // The close/error callback handles disconnect state.
      }
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A concurrent close can race a response.
    }
  }

  private sendError(
    socket: WebSocket,
    code: ServerErrorCode,
    message: string,
    retryable = false,
  ): void {
    this.send(socket, { type: "error", code, message, retryable });
  }

  private rejectJoin(
    socket: WebSocket,
    code: ServerErrorCode,
    message: string,
    retryable = false,
  ): void {
    this.sendError(socket, code, message, retryable);
    socket.close(1008, "Join rejected");
  }

  private invalidMessage(
    socket: WebSocket,
    attachment: SocketAttachment,
    reason: string,
    code: ServerErrorCode = "invalid_message",
  ): void {
    attachment.invalidMessages += 1;
    this.sendError(socket, code, reason);
    socket.serializeAttachment(attachment);
    if (!attachment.joined || attachment.invalidMessages >= 6) {
      socket.close(1008, "Too many invalid messages");
    }
  }

  private attachment(socket: WebSocket, now: number): SocketAttachment {
    const stored = socket.deserializeAttachment() as
      | SocketAttachment
      | null
      | undefined;
    if (stored) {
      if (!Number.isFinite(stored.joinDeadlineAt)) {
        stored.joinDeadlineAt = stored.joined
          ? 0
          : (this.pendingJoinDeadlines.get(socket) ?? now);
        socket.serializeAttachment(stored);
      }
      return stored;
    }
    const created: SocketAttachment = {
      connectionId: token(),
      joined: false,
      playerId: null,
      joinDeadlineAt: this.pendingJoinDeadlines.get(socket) ?? now,
      windowStartedAt: now,
      totalMessages: 0,
      inputMessages: 0,
      actionMessages: 0,
      invalidMessages: 0,
    };
    socket.serializeAttachment(created);
    return created;
  }

  private consumeRateLimit(
    attachment: SocketAttachment,
    type: ClientMessage["type"],
    now: number,
  ): boolean {
    if (now - attachment.windowStartedAt >= 1_000) {
      attachment.windowStartedAt = now;
      attachment.totalMessages = 0;
      attachment.inputMessages = 0;
      attachment.actionMessages = 0;
    }
    attachment.totalMessages += 1;

    if (type === "input") {
      attachment.inputMessages += 1;
    } else if (type !== "ping") {
      attachment.actionMessages += 1;
    }

    return (
      attachment.totalMessages <= MAX_TOTAL_MESSAGES_PER_SECOND &&
      attachment.inputMessages <= MAX_INPUT_MESSAGES_PER_SECOND &&
      attachment.actionMessages <= MAX_ACTION_MESSAGES_PER_SECOND
    );
  }

  private async disconnectSocket(
    socket: WebSocket,
    now: number,
  ): Promise<void> {
    this.pendingJoinDeadlines.delete(socket);
    const attachment = this.attachment(socket, now);
    if (!attachment.joined || !attachment.playerId) return;
    const player = this.room.players[attachment.playerId];
    if (!player || player.connectionId !== attachment.connectionId) return;
    this.markDisconnected(player, now);
    this.ensureHost();
    this.broadcastRoom();
    this.emitSnapshot(now, true);
    await this.persist(true);
    await this.scheduleAlarm(now);
  }

  private markDisconnected(player: PlayerRecord, now: number): void {
    player.connected = false;
    player.connectionId = null;
    player.disconnectedAt = now;
    player.graceUntil = now + RECONNECT_GRACE_MS;
    if (this.room.phase === "lobby" || this.room.phase === "countdown") {
      player.ready = false;
    }
    this.room.lastActivityAt = now;
  }

  private findSocketForPlayer(
    playerId: string,
    exceptConnectionId?: string,
  ): WebSocket | null {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachment(socket, Date.now());
      if (
        attachment.joined &&
        attachment.playerId === playerId &&
        attachment.connectionId !== exceptConnectionId
      ) {
        return socket;
      }
    }
    return null;
  }

  private powerUpIsActive(
    player: PlayerRecord,
    kind: PowerUpKind,
    now: number,
  ): boolean {
    const active = player.activePowerUps[kind];
    return active !== undefined && active.endsAt > now;
  }

  private sendPowerUpBootstrap(socket: WebSocket, now: number): void {
    for (const claimed of Object.values(this.room.claimedPowerUps)) {
      this.send(socket, {
        type: "power_up_state",
        playerId: claimed.playerId,
        objectId: claimed.objectId,
        kind: claimed.kind,
        state: "consumed",
        startsAt: claimed.claimedAt,
        endsAt: claimed.claimedAt,
        serverTime: now,
      });
    }
    for (const player of Object.values(this.room.players)) {
      for (const active of Object.values(player.activePowerUps)) {
        if (!active || active.endsAt <= now) continue;
        this.send(socket, {
          type: "power_up_state",
          playerId: player.id,
          objectId: active.objectId,
          kind: active.kind,
          state: "active",
          startsAt: active.startsAt,
          endsAt: active.endsAt,
          serverTime: now,
        });
      }
    }
  }

  private expirePowerUps(now: number): boolean {
    let changed = false;
    for (const player of Object.values(this.room.players)) {
      for (const active of Object.values(player.activePowerUps)) {
        if (!active || active.endsAt > now) continue;
        delete player.activePowerUps[active.kind];
        this.broadcast({
          type: "power_up_state",
          playerId: player.id,
          objectId: active.objectId,
          kind: active.kind,
          state: "expired",
          startsAt: active.startsAt,
          endsAt: active.endsAt,
          serverTime: now,
        });
        changed = true;
      }
    }
    return changed;
  }

  private bumpCombo(player: PlayerRecord, amount: number, now: number): void {
    this.decayCombo(player, now);
    player.combo = Math.min(5, player.combo + amount);
    player.maximumCombo = Math.max(player.maximumCombo, player.combo);
    player.lastComboAt = now;
  }

  private gameplayObjectIsPlausible(
    player: PlayerRecord,
    event: GameplayEventKind,
    objectId: string,
    now: number,
  ): boolean {
    if (event === "shard" || event === "drone") {
      const position = gameplayObjectPosition(this.room.course, event, objectId);
      if (!position) return false;
      // Magnetised shards can travel toward the runner, while drones may be
      // destroyed by projectiles fired from a moderate distance.
      const maximumEvidenceDistance = event === "shard" ? 16 : 48;
      return (
        vectorDistance(player.motion.position, position) <=
        maximumEvidenceDistance
      );
    }

    const grappleAge = now - player.grappleEpisodeStartedAt;
    const hasRecentGrappleEvidence =
      player.motion.action === "grapple" &&
      player.grappleEpisode > 0 &&
      player.grappleEpisodeStartedAt > 0 &&
      grappleAge >= 100 &&
      grappleAge <= 10_000;
    const speed = vectorLength(player.motion.velocity);

    if (event === "clean_release") {
      return (
        /^release-\d+$/.test(objectId) &&
        hasRecentGrappleEvidence &&
        grappleAge >= 250 &&
        speed >= 16.5 &&
        player.creditedCleanReleaseEpisode < player.grappleEpisode
      );
    }
    if (event === "high_speed") {
      return (
        /^speed-\d+$/.test(objectId) &&
        hasRecentGrappleEvidence &&
        speed >= 23 &&
        player.creditedHighSpeedEpisode < player.grappleEpisode
      );
    }

    // These legacy score kinds have no authoritative course object or motion
    // transition to prove them, so they cannot affect official multiplayer
    // scoring until evidence is added to the protocol.
    return false;
  }

  private decayCombo(player: PlayerRecord, now: number): void {
    player.combo = this.comboAt(player, now);
    player.lastComboAt = now;
  }

  private comboAt(player: PlayerRecord, now: number): number {
    const idleMs = Math.max(0, now - player.lastComboAt - 2_000);
    return Math.max(1, player.combo - idleMs / 8_000);
  }

  private pingQuality(
    pingMs: number | null,
  ): "great" | "good" | "fair" | "poor" | "unknown" {
    if (pingMs === null) return "unknown";
    if (pingMs < 60) return "great";
    if (pingMs < 120) return "good";
    if (pingMs < 220) return "fair";
    return "poor";
  }

  private async persist(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastPersistAt < 1_000) return;
    this.lastPersistAt = now;
    await this.ctx.storage.put(STORAGE_KEY, this.room);
  }

  private async scheduleAlarm(now: number): Promise<void> {
    if (!this.room.created) return;
    const candidates: number[] = [];
    for (const reservation of Object.values(this.room.reservations)) {
      candidates.push(reservation.expiresAt);
    }
    for (const socket of this.ctx.getWebSockets()) {
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.joined) continue;
      candidates.push(
        this.pendingJoinDeadlines.get(socket) ??
          attachment?.joinDeadlineAt ??
          now + 100,
      );
    }
    for (const player of Object.values(this.room.players)) {
      if (player.connected) candidates.push(player.lastSeenAt + SOCKET_INACTIVITY_MS);
      if (player.graceUntil !== null) candidates.push(player.graceUntil);
      for (const active of Object.values(player.activePowerUps)) {
        if (active) candidates.push(active.endsAt);
      }
    }
    if (this.room.quickAutoStartAt !== null) {
      candidates.push(this.room.quickAutoStartAt);
    }
    if (this.room.countdownEndsAt !== null) candidates.push(this.room.countdownEndsAt);
    if (this.room.matchEndsAt !== null) candidates.push(this.room.matchEndsAt);
    if (this.room.finishingEndsAt !== null) candidates.push(this.room.finishingEndsAt);
    const ttl =
      this.room.phase === "results"
        ? RESULTS_TTL_MS
        : this.room.phase === "lobby"
          ? LOBBY_TTL_MS
          : EMPTY_ROOM_TTL_MS;
    candidates.push(this.room.lastActivityAt + ttl);
    if (
      Object.keys(this.room.players).length === 0 &&
      this.reservationCount() === 0
    ) {
      candidates.push(this.room.lastActivityAt + EMPTY_ROOM_TTL_MS);
    }

    const next = Math.max(
      now + 100,
      Math.min(...candidates.filter((candidate) => Number.isFinite(candidate))),
    );
    if (
      this.scheduledAlarm !== null &&
      Math.abs(this.scheduledAlarm - next) < 500
    ) {
      return;
    }
    this.scheduledAlarm = next;
    await this.ctx.storage.setAlarm(next);
  }

  private async scheduleAlarmNoLaterThan(timestamp: number): Promise<void> {
    if (!this.room.created || !Number.isFinite(timestamp)) return;
    const storedAlarm = await this.ctx.storage.getAlarm();
    if (storedAlarm !== null && storedAlarm <= timestamp) {
      this.scheduledAlarm = storedAlarm;
      return;
    }
    this.scheduledAlarm = timestamp;
    await this.ctx.storage.setAlarm(timestamp);
  }

  private async clearRoom(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    this.room = emptyRoom();
    this.scheduledAlarm = null;
    if (!this.handlingAlarm) {
      await this.ctx.storage.deleteAlarm();
    }
    await this.ctx.storage.delete(STORAGE_KEY);
    for (const socket of sockets) {
      try {
        socket.close(1001, "Room expired");
      } catch {
        // Ignore sockets already closing.
      }
    }
  }
}
