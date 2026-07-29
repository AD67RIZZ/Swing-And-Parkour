import {
  INPUT_RATE_HZ,
  MAX_MESSAGE_BYTES,
  PLAYER_COLORS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  ROOM_CODE_PATTERN,
  SAFE_PLAYER_NAMES,
  SOCKET_JOIN_TIMEOUT_MS,
  deterministicPowerUpKind,
  isJoinToken,
  normalizePlayerName,
  type CheckpointServerMessage,
  type ClientMessage,
  type ConnectedMessage,
  type CountdownMessage,
  type ErrorMessage,
  type FinishServerMessage,
  type GameplayEventKind,
  type PlayerColor,
  type PlayerControls,
  type PlayerMotionState,
  type PlayerSnapshot,
  type PowerUpKind,
  type PowerUpStateMessage,
  type RaceResult,
  type RespawnReason,
  type RespawnServerMessage,
  type RoomReservationResponse,
  type RoomView,
  type ServerMessage,
  type SnapshotMessage,
  type StartMessage,
  type WelcomeMessage,
} from "../shared/protocol";
import {
  storage,
  STORAGE_KEYS,
} from "../utils/Storage";
import { parseServerMessage } from "./ProtocolValidation";

declare global {
  interface Window {
    NEON_GRAPPLE_CONFIG?: {
      multiplayerUrl?: unknown;
    };
  }
}

export type MultiplayerStatus =
  | "idle"
  | "reserving"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "unavailable"
  | "error";

export interface MultiplayerProfile {
  name: string;
  color: string;
}

export interface MultiplayerStatusDetail {
  status: MultiplayerStatus;
  message: string;
  reconnectAttempt?: number;
}

export interface PowerUpCollectRejection {
  objectId: string | null;
  kind: PowerUpKind | null;
  error: ErrorMessage & {
    code: "invalid_power_up" | "power_up_claimed";
  };
}

export interface MultiplayerEventMap {
  status: MultiplayerStatusDetail;
  connected: ConnectedMessage;
  welcome: WelcomeMessage;
  room: RoomView;
  countdown: CountdownMessage;
  start: StartMessage;
  snapshot: SnapshotMessage;
  checkpoint: CheckpointServerMessage;
  respawn: RespawnServerMessage;
  finish: FinishServerMessage;
  power_up_state: PowerUpStateMessage;
  power_up_rejected: PowerUpCollectRejection;
  results: RaceResult[];
  ping: number;
  error: ErrorMessage;
  disconnected: { code: number; reason: string; reconnecting: boolean };
  malformed: { count: number };
  availability: { available: boolean; message: string };
  message: ServerMessage;
}

export interface MultiplayerClientOptions {
  profile?: Partial<MultiplayerProfile>;
  endpoint?: string;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
  requestTimeoutMs?: number;
  welcomeTimeoutMs?: number;
  fetch?: typeof window.fetch;
  webSocketFactory?: (url: string) => WebSocket;
}

interface StoredReconnect {
  roomCode: string;
  token: string;
  endpoint: string;
  expiresAt: number;
}

interface JoinCredentials {
  roomCode: string;
  websocketUrl: string;
  reservationToken?: string;
  reconnectToken?: string;
}

const RESERVATION_REQUEST_TIMEOUT_MS = 8_000;
const RECONNECT_CREDENTIAL_TTL_MS = RECONNECT_GRACE_MS * 2;
const TERMINAL_JOIN_ERRORS = new Set<ErrorMessage["code"]>([
  "unsupported_protocol",
  "join_required",
  "already_joined",
  "invalid_reservation",
  "invalid_reconnect_token",
  "duplicate_connection",
  "invalid_name",
  "invalid_color",
  "invalid_room_code",
  "room_not_found",
  "room_full",
  "match_started",
]);

let reconnectMemory: StoredReconnect | null = null;

export class MultiplayerUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MultiplayerUnavailableError";
  }
}

/**
 * Worker reservation + WebSocket client. It validates every incoming message,
 * rate-limits movement to ~20 Hz, measures RTT, and reconnects with the token
 * issued by the Durable Object.
 */
export class MultiplayerClient extends EventTarget {
  private statusValue: MultiplayerStatus = "idle";
  private pingValue: number | null = null;
  private serverClockOffsetMs: number | null = null;
  private playerIdValue: string | null = null;
  private seedValue: number | null = null;
  private roomCodeValue: string | null = null;
  private profile: MultiplayerProfile;
  private socket?: WebSocket;
  private websocketUrl?: string;
  private reservationToken?: string;
  private reconnectToken?: string;
  private endpointIdentity?: string;
  private pingTimer?: number;
  private reconnectTimer?: number;
  private pendingInputTimer?: number;
  private requestController?: AbortController;
  private connectionPromise?: Promise<void>;
  private lastInputSentAt = -Infinity;
  private pendingInput?: { controls: PlayerControls; motion: PlayerMotionState };
  private sequence = 0;
  private malformedCount = 0;
  private pendingPowerUpClaims: Array<{ objectId: string; kind: PowerUpKind }> = [];
  private reconnectAttempt = 0;
  private intentionallyClosed = false;
  private terminalJoinFailure = false;
  private disposed = false;
  private generation = 0;
  private readonly fetcher: typeof window.fetch;
  private readonly makeSocket: (url: string) => WebSocket;

  public constructor(private readonly options: MultiplayerClientOptions = {}) {
    super();
    this.profile = {
      name: multiplayerName(options.profile?.name),
      color: closestPlayerColor(options.profile?.color),
    };
    this.fetcher = options.fetch ?? window.fetch.bind(window);
    this.makeSocket = options.webSocketFactory ?? ((url) => new WebSocket(url));
    // Version 1 stored bearer tokens in localStorage without an expiry.
    storage.remove(STORAGE_KEYS.reconnectToken);
  }

  public get status(): MultiplayerStatus {
    return this.statusValue;
  }

  public get ping(): number | null {
    return this.pingValue;
  }

  /** Current Worker wall-clock estimate, corrected using pong round trips. */
  public get estimatedServerTime(): number {
    return Date.now() + (this.serverClockOffsetMs ?? 0);
  }

  public get playerId(): string | null {
    return this.playerIdValue;
  }

  public get seed(): number | null {
    return this.seedValue;
  }

  public get roomCode(): string | null {
    return this.roomCodeValue;
  }

  public get connected(): boolean {
    return this.statusValue === "connected" && this.socket?.readyState === WebSocket.OPEN;
  }

  public on<K extends keyof MultiplayerEventMap>(
    type: K,
    listener: (detail: MultiplayerEventMap[K]) => void,
  ): () => void {
    const handler = (event: Event): void => listener((event as CustomEvent<MultiplayerEventMap[K]>).detail);
    this.addEventListener(type, handler);
    return () => this.removeEventListener(type, handler);
  }

  public setProfile(profile: Partial<MultiplayerProfile>): void {
    if (profile.name !== undefined) this.profile.name = multiplayerName(profile.name);
    if (profile.color !== undefined) this.profile.color = closestPlayerColor(profile.color);
  }

  public async quickMatch(profile?: Partial<MultiplayerProfile>): Promise<void> {
    if (profile) this.setProfile(profile);
    return this.runConnectionAttempt(() =>
      this.reserveAndConnect("/api/rooms/quick"),
    );
  }

  public async createPrivate(profile?: Partial<MultiplayerProfile>): Promise<void> {
    if (profile) this.setProfile(profile);
    return this.runConnectionAttempt(() =>
      this.reserveAndConnect("/api/rooms/private"),
    );
  }

  public async joinPrivate(roomCode: string, profile?: Partial<MultiplayerProfile>): Promise<void> {
    if (profile) this.setProfile(profile);
    const code = roomCode.trim().toUpperCase();
    if (!ROOM_CODE_PATTERN.test(code)) {
      const error: ErrorMessage = {
        type: "error",
        code: "invalid_room_code",
        message: "That room code is not valid.",
        retryable: false,
      };
      this.emit("error", error);
      throw new Error(error.message);
    }
    return this.runConnectionAttempt(() =>
      this.reserveAndConnect(`/api/rooms/${encodeURIComponent(code)}/reserve`),
    );
  }

  public async reconnectLastSession(): Promise<boolean> {
    if (this.connected) return true;
    if (this.connectionPromise) {
      await this.connectionPromise;
      return this.connected;
    }
    const stored = readStoredReconnect();
    const endpoint = this.resolveEndpoint();
    const endpointIdentity = endpoint
      ? canonicalWebSocketEndpoint(endpoint)
      : null;
    const now = Date.now();
    if (
      !stored ||
      typeof stored.roomCode !== "string" ||
      !ROOM_CODE_PATTERN.test(stored.roomCode) ||
      !isJoinToken(stored.token) ||
      typeof stored.endpoint !== "string" ||
      canonicalWebSocketEndpoint(stored.endpoint) !== endpointIdentity ||
      typeof stored.expiresAt !== "number" ||
      !Number.isFinite(stored.expiresAt) ||
      stored.expiresAt <= now ||
      stored.expiresAt > now + RECONNECT_CREDENTIAL_TTL_MS + 5_000 ||
      !endpoint ||
      !endpointIdentity
    ) {
      clearStoredReconnect();
      return false;
    }
    const websocketUrl = websocketUrlForRoom(endpoint, stored.roomCode);
    this.reconnectToken = stored.token;
    this.roomCodeValue = stored.roomCode;
    this.websocketUrl = websocketUrl;
    this.endpointIdentity = endpointIdentity;
    await this.runConnectionAttempt(() =>
      this.connectSocket(
        {
          roomCode: stored.roomCode,
          websocketUrl,
          reconnectToken: stored.token,
        },
        true,
      ),
    );
    return true;
  }

  /** Lightweight health check for the main-menu connection indicator. */
  public async checkAvailability(timeoutMs = 3_500): Promise<boolean> {
    const endpoint = this.resolveEndpoint();
    if (!endpoint) {
      this.emit("availability", {
        available: false,
        message: "Multiplayer is not configured. Solo practice is available.",
      });
      return false;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
    try {
      const response = await this.fetcher(
        new URL("/health", `${websocketBaseToHttp(endpoint)}/`).toString(),
        { headers: { accept: "application/json" }, signal: controller.signal },
      );
      const value = await readSmallJson(response);
      const health =
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      const available =
        response.ok &&
        health?.ok === true &&
        health.protocol === PROTOCOL_VERSION &&
        typeof health.serverTime === "number" &&
        Number.isFinite(health.serverTime);
      if (available && typeof health?.serverTime === "number") {
        this.recordServerTime(health.serverTime);
      }
      this.emit("availability", {
        available,
        message: available ? "Multiplayer online." : "Multiplayer did not answer correctly.",
      });
      return available;
    } catch {
      this.emit("availability", {
        available: false,
        message: "Multiplayer server unavailable. Solo practice is ready.",
      });
      return false;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  public setReady(ready: boolean): boolean {
    return this.send({ type: "ready", ready });
  }

  public sendState(controls: PlayerControls, motion: PlayerMotionState): void {
    if (this.disposed) return;
    if (this.pendingInput) {
      this.pendingInput = {
        controls: {
          steer: controls.steer,
          grapple: controls.grapple,
          jump: this.pendingInput.controls.jump || controls.jump,
          dash: this.pendingInput.controls.dash || controls.dash,
        },
        motion,
      };
    } else {
      this.pendingInput = { controls: { ...controls }, motion };
    }
    const interval = 1000 / INPUT_RATE_HZ;
    const wait = interval - (performance.now() - this.lastInputSentAt);
    if (wait <= 0) {
      this.flushInput();
    } else if (this.pendingInputTimer === undefined) {
      this.pendingInputTimer = window.setTimeout(() => {
        this.pendingInputTimer = undefined;
        this.flushInput();
      }, wait);
    }
  }

  public sendCheckpoint(checkpointIndex: number): boolean {
    if (!Number.isInteger(checkpointIndex) || checkpointIndex < 0) return false;
    return this.send({
      type: "checkpoint",
      seq: this.nextSequence(),
      checkpointIndex,
    });
  }

  public sendGameplayEvent(event: GameplayEventKind, objectId: string): boolean {
    return this.send({
      type: "gameplay_event",
      seq: this.nextSequence(),
      event,
      objectId: objectId.replace(/[^a-z0-9:_-]/gi, "").slice(0, 64) || "unknown",
    });
  }

  public sendRespawn(reason: RespawnReason): boolean {
    return this.send({ type: "respawn", seq: this.nextSequence(), reason });
  }

  public sendFinish(): boolean {
    return this.send({ type: "finish", seq: this.nextSequence() });
  }

  /**
   * Request a deterministic course power-up. No local effect should be
   * activated until the Worker replies with `power_up_state`.
   */
  public sendPowerUpCollect(objectId: string, kind: PowerUpKind): boolean {
    if (!/^power-\d{1,3}$/.test(objectId)) return false;
    if (
      this.seedValue !== null &&
      deterministicPowerUpKind(this.seedValue, objectId) !== kind
    ) {
      return false;
    }
    const sent = this.send({
      type: "power_up_collect",
      seq: this.nextSequence(),
      objectId,
      kind,
    });
    if (sent) this.pendingPowerUpClaims.push({ objectId, kind });
    return sent;
  }

  public playAgain(): boolean {
    return this.send({ type: "play_again" });
  }

  private runConnectionAttempt(
    operation: () => Promise<void>,
  ): Promise<void> {
    if (this.connectionPromise) return this.connectionPromise;
    let tracked!: Promise<void>;
    tracked = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.connectionPromise === tracked) {
          this.connectionPromise = undefined;
        }
      });
    this.connectionPromise = tracked;
    return tracked;
  }

  public leave(): void {
    this.closeConnection(false);
  }

  private closeConnection(preserveConnectionAttempt: boolean): void {
    this.generation += 1;
    this.intentionallyClosed = true;
    this.terminalJoinFailure = false;
    if (!preserveConnectionAttempt) {
      this.connectionPromise = undefined;
    }
    this.clearTimers();
    if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: "leave" });
    this.socket?.close(1000, "Player left");
    this.socket = undefined;
    this.requestController?.abort();
    this.requestController = undefined;
    this.resetRoomState();
    this.setStatus("idle", "Not connected.");
  }

  private async reserveAndConnect(path: string): Promise<void> {
    if (this.disposed) throw new Error("Multiplayer client has been disposed.");
    this.closeConnection(true);
    this.intentionallyClosed = false;
    const generation = ++this.generation;
    const endpoint = this.resolveEndpoint();
    if (!endpoint) {
      const message =
        "Multiplayer is not configured for this deployment. Solo practice is still available.";
      this.setStatus("unavailable", message);
      throw new MultiplayerUnavailableError(message);
    }

    this.setStatus("reserving", "Finding a skyline room…");
    const httpBase = websocketBaseToHttp(endpoint);
    const endpointIdentity = canonicalWebSocketEndpoint(endpoint);
    if (!endpointIdentity) {
      throw new MultiplayerUnavailableError(
        "The multiplayer endpoint is invalid.",
      );
    }
    this.endpointIdentity = endpointIdentity;
    const requestController = new AbortController();
    this.requestController = requestController;
    const timeoutMs = Math.max(
      1_000,
      this.options.requestTimeoutMs ?? RESERVATION_REQUEST_TIMEOUT_MS,
    );
    const requestTimeout = window.setTimeout(
      () => requestController.abort(),
      timeoutMs,
    );
    let response: Response;
    let json: unknown;
    try {
      response = await this.fetcher(new URL(path, `${httpBase}/`).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: requestController.signal,
      });
      json = await readSmallJson(response);
    } catch (cause) {
      if (generation !== this.generation || this.intentionallyClosed) return;
      const timedOut = cause instanceof Error && cause.name === "AbortError";
      const message = timedOut
        ? "The multiplayer server took too long to answer. You can retry or play solo."
        : "The multiplayer server could not be reached. You can retry or play solo.";
      this.setStatus("unavailable", message);
      throw new MultiplayerUnavailableError(
        cause instanceof Error ? `${message} (${cause.message})` : message,
      );
    } finally {
      window.clearTimeout(requestTimeout);
      if (this.requestController === requestController) {
        this.requestController = undefined;
      }
    }
    if (generation !== this.generation || this.intentionallyClosed) return;

    if (!response.ok) {
      const error = serverHttpError(json, response.status);
      this.emit("error", error);
      this.setStatus("error", error.message);
      throw new Error(error.message);
    }
    const reservation = parseReservation(json, httpBase);
    if (!reservation) {
      const message = "The multiplayer server returned an invalid room reservation.";
      this.setStatus("error", message);
      throw new Error(message);
    }
    await this.connectSocket({
      roomCode: reservation.roomCode,
      websocketUrl: reservation.websocketUrl,
      reservationToken: reservation.reservationToken,
    }, false);
  }

  private async connectSocket(
    credentials: JoinCredentials,
    reconnecting: boolean,
  ): Promise<void> {
    if (this.disposed) return;
    if (
      !this.endpointIdentity ||
      !websocketMatchesEndpoint(
        credentials.websocketUrl,
        this.endpointIdentity,
        credentials.roomCode,
      )
    ) {
      throw new MultiplayerUnavailableError(
        "The multiplayer WebSocket address did not match the configured server.",
      );
    }

    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const generation = ++this.generation;
    this.intentionallyClosed = false;
    this.terminalJoinFailure = false;
    this.websocketUrl = credentials.websocketUrl;
    this.roomCodeValue = credentials.roomCode;
    this.reservationToken = credentials.reservationToken;
    if (credentials.reconnectToken) {
      this.reconnectToken = credentials.reconnectToken;
    }
    this.setStatus(
      reconnecting ? "reconnecting" : "connecting",
      reconnecting ? "Reconnecting to the race…" : "Opening the skyline link…",
      reconnecting ? this.reconnectAttempt : undefined,
    );

    let socket: WebSocket;
    try {
      socket = this.makeSocket(credentials.websocketUrl);
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Could not create a WebSocket.";
      if (!reconnecting) this.setStatus("unavailable", message);
      throw new MultiplayerUnavailableError(message);
    }
    this.socket?.close(1000, "Superseded");
    this.socket = socket;
    socket.binaryType = "arraybuffer";

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const welcomeTimeout = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            socket.close(4000, "Join timeout");
          } catch {
            // A socket can fail while it is still in CONNECTING state.
          }
          reject(
            new MultiplayerUnavailableError(
              "The multiplayer server did not confirm the join in time.",
            ),
          );
        }, Math.max(
          1_000,
          this.options.welcomeTimeoutMs ?? SOCKET_JOIN_TIMEOUT_MS + 2_000,
        ));

        const settle = (
          error?: MultiplayerUnavailableError,
        ): void => {
          if (settled) return;
          settled = true;
          window.clearTimeout(welcomeTimeout);
          if (error) reject(error);
          else resolve();
        };

        socket.addEventListener(
          "open",
          () => {
            if (
              generation !== this.generation ||
              this.disposed ||
              this.intentionallyClosed
            ) {
              socket.close(1000, "Stale connection");
              settle(
                new MultiplayerUnavailableError(
                  "The connection attempt was cancelled.",
                ),
              );
              return;
            }
            try {
              socket.send(
                JSON.stringify({
                  type: "join",
                  protocol: PROTOCOL_VERSION,
                  name: this.profile.name,
                  color: this.profile.color,
                  ...(credentials.reservationToken
                    ? { reservationToken: credentials.reservationToken }
                    : {}),
                  ...(credentials.reconnectToken
                    ? { reconnectToken: credentials.reconnectToken }
                    : {}),
                } satisfies ClientMessage),
              );
            } catch {
              settle(
                new MultiplayerUnavailableError(
                  "The multiplayer join request could not be sent.",
                ),
              );
            }
          },
          { once: true },
        );
        socket.addEventListener(
          "error",
          () =>
            settle(
              new MultiplayerUnavailableError(
                "The multiplayer WebSocket could not open.",
              ),
            ),
          { once: true },
        );
        socket.addEventListener("message", (event) => {
          if (
            generation !== this.generation ||
            socket !== this.socket ||
            this.disposed ||
            this.intentionallyClosed
          ) {
            return;
          }
          const message = this.handleMessage(event);
          if (message?.type === "welcome") {
            settle();
          } else if (
            message?.type === "error" &&
            TERMINAL_JOIN_ERRORS.has(message.code)
          ) {
            settle(new MultiplayerUnavailableError(message.message));
          }
        });
        socket.addEventListener("close", (event) => {
          this.handleClose(event, generation);
          settle(
            new MultiplayerUnavailableError(
              "The multiplayer WebSocket closed before the join was confirmed.",
            ),
          );
        });
      });
    } catch (cause) {
      if (
        generation !== this.generation ||
        this.disposed ||
        this.intentionallyClosed
      ) {
        return;
      }
      if (
        !this.terminalJoinFailure
      ) {
        this.setStatus(
          reconnecting ? "reconnecting" : "unavailable",
          reconnecting
            ? "Reconnection attempt failed. Trying again…"
            : "The multiplayer link could not open. Solo practice is available.",
          reconnecting ? this.reconnectAttempt : undefined,
        );
      }
      throw cause;
    }
  }

  private handleMessage(
    event: MessageEvent<unknown>,
  ): ServerMessage | null {
    if (typeof event.data !== "string") {
      this.handleMalformed();
      return null;
    }
    if (new TextEncoder().encode(event.data).byteLength > MAX_MESSAGE_BYTES) {
      this.socket?.close(4009, "Message too large");
      return null;
    }
    const message = parseServerMessage(event.data);
    if (!message) {
      this.handleMalformed();
      return null;
    }
    if (
      message.type === "power_up_state" &&
      this.seedValue !== null &&
      deterministicPowerUpKind(this.seedValue, message.objectId) !== message.kind
    ) {
      this.handleMalformed();
      return null;
    }
    this.malformedCount = 0;
    this.emit("message", message);

    switch (message.type) {
      case "connected":
        this.recordServerTime(message.serverTime);
        this.emit("connected", message);
        break;
      case "welcome":
        this.handleWelcome(message);
        break;
      case "room":
        this.emit("room", message.room);
        break;
      case "countdown":
        this.seedValue = message.course.seed;
        this.emit("countdown", message);
        break;
      case "start":
        this.seedValue = message.course.seed;
        this.emit("start", message);
        break;
      case "snapshot":
        this.recordServerTime(message.serverTime);
        this.emit("snapshot", message);
        break;
      case "checkpoint":
        this.emit("checkpoint", message);
        break;
      case "respawn":
        this.emit("respawn", message);
        break;
      case "finish":
        this.emit("finish", message);
        break;
      case "power_up_state":
        if (message.playerId === this.playerIdValue) {
          this.pendingPowerUpClaims = this.pendingPowerUpClaims.filter(
            (claim) => claim.objectId !== message.objectId,
          );
        }
        this.emit("power_up_state", message);
        break;
      case "results":
        this.emit("results", message.results);
        break;
      case "pong":
        this.handlePong(message.nonce, message.clientTime, message.serverTime);
        break;
      case "error":
        if (
          message.code === "invalid_power_up" ||
          message.code === "power_up_claimed"
        ) {
          const claim = this.pendingPowerUpClaims.shift();
          this.emit("power_up_rejected", {
            objectId: claim?.objectId ?? null,
            kind: claim?.kind ?? null,
            error: message as PowerUpCollectRejection["error"],
          });
          break;
        }
        this.emit("error", message);
        if (TERMINAL_JOIN_ERRORS.has(message.code)) {
          this.terminalJoinFailure = true;
          this.reconnectToken = undefined;
          this.reservationToken = undefined;
          clearStoredReconnect();
          this.setStatus("error", message.message);
          try {
            this.socket?.close(4003, "Join rejected");
          } catch {
            // The server may already be closing the rejected socket.
          }
        } else if (!message.retryable && !this.connected) {
          this.setStatus("error", message.message);
        }
        break;
    }
    return message;
  }

  private handleWelcome(message: WelcomeMessage): void {
    this.recordServerTime(message.serverTime);
    this.playerIdValue = message.playerId;
    this.roomCodeValue = message.room.code;
    this.seedValue = message.course.seed;
    this.reconnectToken = message.reconnectToken;
    this.reservationToken = undefined;
    this.reconnectAttempt = 0;
    this.terminalJoinFailure = false;
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.persistReconnectCredential();
    this.setStatus("connected", message.reconnected ? "Reconnected to the race." : "Connected.");
    this.startPing();
    this.emit("welcome", message);
    this.emit("room", message.room);
    if (
      message.room.phase === "countdown" &&
      message.room.countdownEndsAt !== null
    ) {
      this.emit("countdown", {
        type: "countdown",
        startsAt: message.room.countdownEndsAt,
        course: message.course,
      });
    }
  }

  private persistReconnectCredential(): void {
    if (
      this.roomCodeValue &&
      this.reconnectToken &&
      this.endpointIdentity
    ) {
      writeStoredReconnect({
        roomCode: this.roomCodeValue,
        token: this.reconnectToken,
        endpoint: this.endpointIdentity,
        expiresAt: Date.now() + RECONNECT_CREDENTIAL_TTL_MS,
      } satisfies StoredReconnect);
    }
  }

  private handlePong(nonce: string, clientTime: number, serverTime: number): void {
    if (!nonce.startsWith("p-")) return;
    const receivedAt = Date.now();
    const rtt = Math.max(0, receivedAt - clientTime);
    this.pingValue = this.pingValue === null ? rtt : this.pingValue * 0.72 + rtt * 0.28;
    this.recordServerTime(serverTime, receivedAt, clientTime);
    this.persistReconnectCredential();
    this.emit("ping", this.pingValue);
  }

  private recordServerTime(
    serverTime: number,
    receivedAt = Date.now(),
    sentAt?: number,
  ): void {
    const estimatedAtReceive =
      sentAt === undefined
        ? serverTime
        : serverTime + Math.max(0, receivedAt - sentAt) * 0.5;
    const sample = estimatedAtReceive - receivedAt;
    const weight = sentAt === undefined ? 0.12 : 0.55;
    this.serverClockOffsetMs =
      this.serverClockOffsetMs === null
        ? sample
        : this.serverClockOffsetMs * (1 - weight) + sample * weight;
  }

  private handleMalformed(): void {
    this.malformedCount += 1;
    this.emit("malformed", { count: this.malformedCount });
    if (this.malformedCount >= 3) {
      this.socket?.close(4002, "Repeated invalid server messages");
    }
  }

  private handleClose(event: CloseEvent, generation: number): void {
    if (generation !== this.generation) return;
    this.stopPing();
    this.socket = undefined;
    if (this.terminalJoinFailure) {
      this.emit("disconnected", {
        code: event.code,
        reason: event.reason || "Join rejected",
        reconnecting: false,
      });
      return;
    }
    if (this.intentionallyClosed || this.disposed) {
      if (!this.disposed) this.setStatus("idle", "Not connected.");
      return;
    }
    const canReconnect =
      (this.options.reconnect ?? true) &&
      Boolean(this.reconnectToken && this.websocketUrl && this.roomCodeValue);
    this.setStatus(
      canReconnect ? "reconnecting" : "disconnected",
      canReconnect ? "Connection lost. Reconnecting…" : "Connection lost.",
      canReconnect ? this.reconnectAttempt + 1 : undefined,
    );
    this.emit("disconnected", {
      code: event.code,
      reason: event.reason || "Connection closed",
      reconnecting: canReconnect,
    });
    if (canReconnect) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (
      this.disposed ||
      this.intentionallyClosed ||
      this.terminalJoinFailure ||
      this.reconnectTimer !== undefined
    ) return;
    const maximum = this.options.maxReconnectAttempts ?? 7;
    if (this.reconnectAttempt >= maximum) {
      this.setStatus("disconnected", "Could not reconnect. Solo practice is still available.");
      return;
    }
    const delays = [500, 1_000, 2_000, 3_500, 5_500, 8_000, 10_000];
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)] ?? 10_000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.websocketUrl || !this.roomCodeValue || !this.reconnectToken) return;
      const credentials: JoinCredentials = {
        roomCode: this.roomCodeValue,
        websocketUrl: this.websocketUrl,
        reconnectToken: this.reconnectToken,
      };
      void this.runConnectionAttempt(() =>
        this.connectSocket(credentials, true),
      ).catch(() => this.scheduleReconnect());
    }, delay);
  }

  private flushInput(): void {
    if (!this.pendingInput) return;
    const input = this.pendingInput;
    this.pendingInput = undefined;
    if (
      this.send({
        type: "input",
        seq: this.nextSequence(),
        clientTime: Date.now(),
        controls: input.controls,
        motion: input.motion,
      })
    ) {
      this.lastInputSentAt = performance.now();
    }
  }

  private send(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private nextSequence(): number {
    this.sequence = (this.sequence + 1) % 2_147_483_647;
    return this.sequence;
  }

  private startPing(): void {
    this.stopPing();
    const ping = (): void => {
      if (!this.connected) return;
      const now = Date.now();
      this.send({
        type: "ping",
        nonce: `p-${Math.round(now).toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        clientTime: now,
        ...(this.pingValue === null
          ? {}
          : { rttMs: Math.max(0, Math.min(5_000, this.pingValue)) }),
      });
    };
    ping();
    this.pingTimer = window.setInterval(ping, 4_000);
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) window.clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    if (this.pendingInputTimer !== undefined) window.clearTimeout(this.pendingInputTimer);
    this.reconnectTimer = undefined;
    this.pendingInputTimer = undefined;
    this.pendingInput = undefined;
    this.pendingPowerUpClaims.length = 0;
  }

  private resetRoomState(): void {
    this.playerIdValue = null;
    this.seedValue = null;
    this.roomCodeValue = null;
    this.websocketUrl = undefined;
    this.endpointIdentity = undefined;
    this.reservationToken = undefined;
    this.reconnectToken = undefined;
    this.pingValue = null;
    this.serverClockOffsetMs = null;
    this.reconnectAttempt = 0;
    this.sequence = 0;
    clearStoredReconnect();
  }

  private resolveEndpoint(): string | null {
    const raw = this.options.endpoint ?? (
      import.meta.env.DEV
        ? "ws://localhost:8787/ws"
        : window.NEON_GRAPPLE_CONFIG?.multiplayerUrl
    );
    if (typeof raw !== "string" || raw.trim() === "") return null;
    if (/your-worker|your-subdomain|example\.com/i.test(raw)) return null;
    try {
      const url = new URL(raw.trim(), window.location.href);
      if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
      if (!import.meta.env.DEV && window.location.protocol === "https:" && url.protocol !== "wss:") {
        return null;
      }
      return url.toString();
    } catch {
      return null;
    }
  }

  private setStatus(
    status: MultiplayerStatus,
    message: string,
    reconnectAttempt?: number,
  ): void {
    this.statusValue = status;
    this.emit("status", {
      status,
      message,
      ...(reconnectAttempt === undefined ? {} : { reconnectAttempt }),
    });
  }

  private emit<K extends keyof MultiplayerEventMap>(type: K, detail: MultiplayerEventMap[K]): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  public dispose(options: { preserveReconnect?: boolean } = {}): void {
    if (this.disposed) return;
    if (options.preserveReconnect) {
      // A real page unload must disconnect the old socket without sending the
      // protocol-level `leave` message or deleting the short-lived reconnect
      // credential. The next page instance can then resume within the
      // server's reconnect grace window.
      if (this.statusValue === "connected") {
        this.persistReconnectCredential();
      }
      this.generation += 1;
      this.intentionallyClosed = true;
      this.terminalJoinFailure = false;
      this.connectionPromise = undefined;
      this.clearTimers();
      this.requestController?.abort();
      this.requestController = undefined;
      this.socket?.close(1001, "Page unloading");
      this.socket = undefined;
      this.disposed = true;
      this.statusValue = "idle";
      return;
    }
    this.leave();
    this.disposed = true;
    this.statusValue = "idle";
  }

  public destroy(): void {
    this.dispose();
  }
}

function websocketBaseToHttp(endpoint: string): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/ws\/?$/i, "").replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function canonicalWebSocketEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    if (url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function websocketUrlForRoom(endpoint: string, roomCode: string): string {
  const url = new URL(
    `/api/rooms/${encodeURIComponent(roomCode)}/ws`,
    `${websocketBaseToHttp(endpoint)}/`,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function websocketMatchesEndpoint(
  websocketUrl: string,
  endpoint: string,
  roomCode: string,
): boolean {
  try {
    const actual = new URL(websocketUrl);
    return (
      !actual.username &&
      !actual.password &&
      !actual.search &&
      !actual.hash &&
      actual.toString() === websocketUrlForRoom(endpoint, roomCode)
    );
  } catch {
    return false;
  }
}

function parseReservation(value: unknown, httpBase: string): RoomReservationResponse | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.roomCode !== "string" ||
    !ROOM_CODE_PATTERN.test(record.roomCode) ||
    !isJoinToken(record.reservationToken) ||
    typeof record.reservationExpiresAt !== "number" ||
    !Number.isFinite(record.reservationExpiresAt) ||
    record.reservationExpiresAt <= 0 ||
    typeof record.websocketUrl !== "string"
  ) {
    return null;
  }
  try {
    const url = new URL(record.websocketUrl, `${httpBase}/`);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return null;
    const expected = new URL(
      `/api/rooms/${encodeURIComponent(record.roomCode)}/ws`,
      `${httpBase}/`,
    );
    expected.protocol = expected.protocol === "https:" ? "wss:" : "ws:";
    if (url.toString() !== expected.toString()) return null;
    return {
      roomCode: record.roomCode,
      reservationToken: record.reservationToken,
      reservationExpiresAt: record.reservationExpiresAt,
      websocketUrl: url.toString(),
    };
  } catch {
    return null;
  }
}

function multiplayerName(raw: unknown): string {
  return normalizePlayerName(raw) ?? SAFE_PLAYER_NAMES[0];
}

function readStoredReconnect(): StoredReconnect | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEYS.reconnectToken);
  } catch {
    return reconnectMemory;
  }
  if (raw === null) return reconnectMemory;
  if (raw.length > 1_024) {
    clearStoredReconnect();
    return null;
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      clearStoredReconnect();
      return null;
    }
    reconnectMemory = value as StoredReconnect;
    return reconnectMemory;
  } catch {
    clearStoredReconnect();
    return null;
  }
}

function writeStoredReconnect(value: StoredReconnect): void {
  reconnectMemory = value;
  try {
    window.sessionStorage.setItem(
      STORAGE_KEYS.reconnectToken,
      JSON.stringify(value),
    );
  } catch {
    // The in-memory copy still supports reconnects in this page.
  }
}

function clearStoredReconnect(): void {
  reconnectMemory = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEYS.reconnectToken);
  } catch {
    // Storage can be unavailable in privacy modes.
  }
  storage.remove(STORAGE_KEYS.reconnectToken);
}

function serverHttpError(value: unknown, status: number): ErrorMessage {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string") {
      return {
        type: "error",
        code:
          typeof record.code === "string"
            ? (record.code as ErrorMessage["code"])
            : "bad_request",
        message: record.message.slice(0, 512),
        retryable: status >= 500 || status === 429,
      };
    }
  }
  return {
    type: "error",
    code: status >= 500 ? "internal_error" : "bad_request",
    message:
      status === 404
        ? "That room was not found."
        : status === 409
          ? "That room cannot be joined right now."
          : "The multiplayer request failed.",
    retryable: status >= 500 || status === 429,
  };
}

function closestPlayerColor(raw: unknown): PlayerColor {
  if (typeof raw !== "string" || !/^#[0-9a-f]{6}$/i.test(raw)) return PLAYER_COLORS[0];
  const normalized = raw.toLowerCase();
  const exact = PLAYER_COLORS.find((color) => color === normalized);
  if (exact) return exact;
  const target = hexToRgb(normalized);
  let closest: PlayerColor = PLAYER_COLORS[0];
  let closestDistance = Infinity;
  for (const color of PLAYER_COLORS) {
    const candidate = hexToRgb(color);
    const distance =
      (target[0] - candidate[0]) ** 2 +
      (target[1] - candidate[1]) ** 2 +
      (target[2] - candidate[2]) ** 2;
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = color;
    }
  }
  return closest;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** Convert any local player colour to the Worker protocol palette. */
export function multiplayerColor(raw: string): PlayerColor {
  return closestPlayerColor(raw);
}

/** Convenience helper for extracting the local player from a snapshot event. */
export function localSnapshot(
  message: SnapshotMessage,
  playerId: string | null,
): PlayerSnapshot | undefined {
  return playerId ? message.players.find((player) => player.id === playerId) : undefined;
}

async function readSmallJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_MESSAGE_BYTES) return null;
  try {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
