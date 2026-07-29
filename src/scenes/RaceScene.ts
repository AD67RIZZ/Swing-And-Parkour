import * as THREE from "three";
import type {
  CheckpointServerMessage,
  FinishServerMessage,
  PlayerMotionState,
  PowerUpStateMessage,
  RespawnServerMessage,
  SnapshotMessage,
} from "../shared/protocol";
import { AudioManager } from "../audio/AudioManager";
import { CameraRig } from "../game/CameraRig";
import type { InputSnapshot } from "../game/InputManager";
import { type GameMode, type RaceSummary, rankForScore } from "../game/GameState";
import { MultiplayerClient } from "../multiplayer/MultiplayerClient";
import { RemotePlayer } from "../multiplayer/RemotePlayer";
import { SnapshotBuffer } from "../multiplayer/SnapshotBuffer";
import { PlayerController, type PlayerAction, type PlayerControllerEvent } from "../player";
import { PowerUpSystem, ScoreSystem } from "../systems";
import { SoloRival, type SoloRivalDebugState } from "../systems/SoloRival";
import { HUD, type LeaderboardEntry } from "../ui/HUD";
import type { GameSettings } from "../utils/Storage";
import { RaceWorld, type WorldEvent } from "../world";

export interface RaceSceneOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  mode: GameMode;
  seed: number;
  settings: GameSettings;
  hud: HUD;
  audio: AudioManager;
  multiplayer?: MultiplayerClient;
  onFinish: (summary: RaceSummary) => void;
}

const TUTORIAL_STEPS: ReadonlyArray<readonly [string, string, string]> = [
  ["Steer", "A steers left and D steers right. Arrow keys work too.", "A LEFT / D RIGHT"],
  ["Double jump", "Press Space to jump, then press it again while airborne.", "SPACE ×2"],
  ["Grapple", "Hold right mouse to catch the highlighted anchor.", "HOLD RMB"],
  ["Launch", "Release the grapple while moving fast to keep your momentum.", "RELEASE"],
  ["Air dash", "Press E once before landing.", "E"],
  ["Wall-run", "Steer toward a bright side wall while you are airborne.", "STEER"],
  ["Collect", "Follow the energy-shard trail to build your combo.", "SHARDS"],
  ["Dodge", "Watch warning shapes and move through a safe opening.", "DODGE"],
  ["Checkpoint", "Cross the gate. Falls now return you here.", "GATE"],
];

export class RaceScene {
  readonly world: RaceWorld;
  readonly player: PlayerController;
  readonly score = new ScoreSystem();
  readonly powerUps = new PowerUpSystem();

  private readonly mode: GameMode;
  private readonly scene: THREE.Scene;
  private readonly hud: HUD;
  private readonly audio: AudioManager;
  private readonly multiplayer?: MultiplayerClient;
  private readonly cameraRig: CameraRig;
  private readonly snapshotBuffer = new SnapshotBuffer(105);
  private readonly remotePlayers = new Map<string, RemotePlayer>();
  private readonly soloRivals: SoloRival[] = [];
  private readonly settings: GameSettings;
  private readonly onFinish: (summary: RaceSummary) => void;
  private elapsed = 0;
  private remainingSeconds = 6 * 60;
  private paused = false;
  private finished = false;
  private completed = false;
  private waitingForServerResults = false;
  private networkAvailable = true;
  private needsAuthoritativeSync = false;
  private pendingCheckpoint: number | null = null;
  private pendingFinish = false;
  private nextProgressRetryAt = 0;
  private latestServerSnapshot?: SnapshotMessage;
  private localPlacement = 1;
  private authoritativeScore = 0;
  private authoritativeCombo = 1;
  private authoritativeCheckpoint = 0;
  private serverStartedAt: number | null = null;
  private serverEndsAt: number | null = null;
  private hazardEpoch: number | null = null;
  private lastTutorialStep = -1;
  private lastInput: InputSnapshot = {
    steer: 0,
    forward: 0,
    grapple: false,
    jump: false,
    dash: false,
    respawn: false,
    pause: false,
    leaderboard: false,
  };

  constructor(options: RaceSceneOptions) {
    this.mode = options.mode;
    this.powerUps.setAuthority(options.mode === "multiplayer" ? "server" : "local");
    this.scene = options.scene;
    this.hud = options.hud;
    this.audio = options.audio;
    this.multiplayer = options.multiplayer;
    this.settings = options.settings;
    this.onFinish = options.onFinish;

    options.scene.background = new THREE.Color(0x02040d);
    options.scene.fog = new THREE.FogExp2(0x081128, options.settings.graphics === "low" ? 0.009 : 0.007);
    this.world = new RaceWorld(options.scene, {
      seed: options.seed,
      mode: options.mode === "solo" ? "practice" : options.mode,
      quality: options.settings.graphics,
      courseLength: options.mode === "tutorial" ? "short" : "standard",
      reducedMotion: options.settings.reducedMotion,
    });
    this.player = new PlayerController(
      options.scene,
      this.world.physicsWorld,
      this.world.anchorSystem,
      {
        spawn: this.world.spawnPosition,
        rails: this.world.rails,
        checkpointProvider: () => this.world.getRespawnPosition(),
        playerColor: options.settings.playerColor,
        reducedMotion: options.settings.reducedMotion,
      },
    );
    this.cameraRig = new CameraRig(options.camera, () => this.world.collidables);
    this.cameraRig.setReducedMotion(options.settings.reducedMotion);
    this.cameraRig.setCameraSensitivity(options.settings.cameraSensitivity);
    this.cameraRig.snapTo({
      position: this.player.position,
      velocity: this.player.velocity,
      grappleAnchor: null,
    });
    this.hud.setVisible(true);
    this.hud.showCountdown("GO");
    this.audio.play("match-start");

    if (this.mode === "solo") this.createSoloRivals(options.scene);
  }

  setServerTiming(startedAt: number, endsAt: number, hazardEpoch = startedAt): void {
    const now = this.serverNow();
    this.serverStartedAt = startedAt;
    this.serverEndsAt = endsAt;
    this.hazardEpoch = hazardEpoch;
    this.elapsed = Math.max(0, (now - startedAt) / 1_000);
    this.remainingSeconds = Math.max(0, (endsAt - now) / 1_000);
  }

  setNetworkAvailable(available: boolean): void {
    if (this.mode !== "multiplayer") return;
    this.networkAvailable = available;
    if (available) {
      this.needsAuthoritativeSync = true;
      this.nextProgressRetryAt = 0;
    }
  }

  get hasNetwork(): boolean {
    return this.networkAvailable;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  applySettings(settings: GameSettings): void {
    this.cameraRig.setReducedMotion(settings.reducedMotion);
    this.cameraRig.setCameraSensitivity(settings.cameraSensitivity);
    this.player.setReducedMotion(settings.reducedMotion);
    this.hud.setControlHints(settings.controlHints || this.mode === "tutorial");
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.density = settings.graphics === "low" ? 0.009 : 0.007;
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get remotePlayerCount(): number {
    return this.remotePlayers.size;
  }

  get soloRivalState(): ReadonlyArray<SoloRivalDebugState> {
    return this.soloRivals.map((rival) => rival.debugState);
  }

  restartFromCheckpoint(): void {
    if (!this.finished) this.player.startRespawn("manual");
  }

  fixedUpdate(dt: number, input: InputSnapshot): void {
    this.lastInput = input;
    if (
      this.paused ||
      this.finished ||
      (this.mode === "multiplayer" &&
        (!this.networkAvailable || this.needsAuthoritativeSync))
    ) {
      return;
    }

    const now = this.serverNow();
    if (this.serverStartedAt === null || this.serverEndsAt === null) {
      this.elapsed += dt;
      this.remainingSeconds = Math.max(0, this.remainingSeconds - dt);
    } else {
      this.elapsed = Math.max(0, (now - this.serverStartedAt) / 1_000);
      this.remainingSeconds = Math.max(0, (this.serverEndsAt - now) / 1_000);
    }
    if (this.remainingSeconds <= 0 && this.mode !== "multiplayer") {
      this.finishLocal(false);
      return;
    }
    this.retryProgressMessages(now);

    this.powerUps.update(
      dt,
      this.mode === "multiplayer" ? this.multiplayer?.estimatedServerTime : undefined,
    );
    for (const request of this.powerUps.drainTimedOutCollections()) {
      this.world.resolvePowerUpCollection(request.objectId, false);
    }
    const modifiers = this.powerUps.modifiers;
    this.player.setMovementModifiers(modifiers);
    this.player.setPowerEffects(this.powerUps.has("overdrive"), modifiers.shielded);
    this.score.setPowerUpMultiplier(modifiers.scoreMultiplier);
    this.player.update(dt, this.elapsed, input);

    const worldResult = this.world.update(
      dt,
      this.hazardEpoch === null ? this.elapsed : Math.max(0, (now - this.hazardEpoch) / 1_000),
      this.player.getWorldState(modifiers.magnetRadius),
    );
    for (const event of worldResult.events) this.handleWorldEvent(event);
    for (const event of this.player.drainEvents()) this.handlePlayerEvent(event);

    const distance = Math.max(0, this.player.position.z - this.world.spawnPosition.z);
    this.score.update(dt, distance, this.player.speed, this.player.grounded);
    this.updateSoloRivals(dt);
    this.updateTutorial(distance);
    this.sendNetworkState(input, distance);
    this.updateHud();
  }

  renderUpdate(dt: number): void {
    this.cameraRig.update(
      {
        position: this.player.position,
        velocity: this.player.velocity,
        grappleAnchor: this.player.grapple.attachedAnchor?.position ?? null,
      },
      dt,
      this.powerUps.has("overdrive"),
    );
    this.updateRemotePlayers(dt);
    this.renderSoloRivals(dt);
  }

  handleSnapshot(message: SnapshotMessage): void {
    this.latestServerSnapshot = message;
    this.remainingSeconds = Math.max(0, message.timeRemainingMs / 1_000);
    if (message.phase === "racing" || message.phase === "finishing") {
      this.serverEndsAt = message.serverTime + Math.max(0, message.timeRemainingMs);
    }
    this.snapshotBuffer.push(message);
    const localId = this.multiplayer?.playerId;
    const local = localId ? message.players.find((entry) => entry.id === localId) : undefined;
    if (local) {
      this.localPlacement = local.placement;
      this.authoritativeScore = local.score;
      this.authoritativeCombo = local.combo;
      this.authoritativeCheckpoint = local.checkpointIndex;
      if (
        this.pendingCheckpoint !== null &&
        local.checkpointIndex >= this.pendingCheckpoint
      ) {
        this.pendingCheckpoint = null;
      }
      if (
        this.pendingCheckpoint === null &&
        local.checkpointIndex !== this.world.currentCheckpoint
      ) {
        const checkpoint = this.world.syncCheckpoint(local.checkpointIndex);
        this.player.setAuthoritativeCheckpoint(checkpoint.respawn, checkpoint.checkpoint);
      }
      // The Worker echoes client motion rather than simulating it, so correcting
      // every delayed snapshot causes rubber-banding. Snap once after reconnect.
      if (this.needsAuthoritativeSync) {
        this.needsAuthoritativeSync = false;
        const checkpoint = this.world.syncCheckpoint(local.checkpointIndex);
        const now = this.serverNow();
        if (local.respawningUntil !== null && local.respawningUntil > now) {
          this.player.startAuthoritativeRespawn(
            checkpoint.respawn,
            checkpoint.checkpoint,
            (local.respawningUntil - now) / 1_000,
            Math.max(
              0,
              ((local.protectedUntil ?? local.respawningUntil) -
                local.respawningUntil) /
                1_000,
            ),
          );
        } else {
          this.player.setAuthoritativeCheckpoint(checkpoint.respawn, checkpoint.checkpoint);
          this.player.teleport(
            new THREE.Vector3(
              local.motion.position.x,
              local.motion.position.y,
              local.motion.position.z,
            ),
            new THREE.Vector3(
              local.motion.velocity.x,
              local.motion.velocity.y,
              local.motion.velocity.z,
            ),
          );
          if (local.protectedUntil !== null) {
            this.player.setAuthoritativeProtection(
              Math.max(0, (local.protectedUntil - now) / 1_000),
            );
          }
        }
      }
    }
    this.hud.setLeaderboard(this.serverLeaderboard(message));
  }

  handleServerCheckpoint(message: CheckpointServerMessage): void {
    if (message.playerId !== this.multiplayer?.playerId) return;
    this.authoritativeCheckpoint = message.checkpointIndex;
    if (
      this.pendingCheckpoint !== null &&
      message.checkpointIndex >= this.pendingCheckpoint
    ) {
      this.pendingCheckpoint = null;
    }
  }

  handleServerFinish(message: FinishServerMessage): void {
    if (message.playerId !== this.multiplayer?.playerId) return;
    this.pendingFinish = false;
    this.waitingForServerResults = true;
  }

  handleServerRespawn(message: RespawnServerMessage): void {
    if (message.playerId !== this.multiplayer?.playerId) return;
    const checkpoint = this.world.syncCheckpoint(message.checkpointIndex);
    const now = this.serverNow();
    this.player.startAuthoritativeRespawn(
      new THREE.Vector3(message.position.x, message.position.y, message.position.z),
      checkpoint.checkpoint,
      Math.max(0, (message.respawnAt - now) / 1_000),
      Math.max(
        0,
        (message.protectedUntil - Math.max(now, message.respawnAt)) / 1_000,
      ),
    );
  }

  handleNetworkError(code: string): void {
    if (code === "invalid_checkpoint") {
      this.pendingCheckpoint = null;
      const localId = this.multiplayer?.playerId;
      const local = localId
        ? this.latestServerSnapshot?.players.find((entry) => entry.id === localId)
        : undefined;
      if (local) {
        const checkpoint = this.world.syncCheckpoint(local.checkpointIndex);
        this.player.setAuthoritativeCheckpoint(checkpoint.respawn, checkpoint.checkpoint);
      }
    } else if (code === "wrong_phase") {
      this.pendingFinish = false;
    }
  }

  handlePowerUpState(message: PowerUpStateMessage): void {
    this.world.resolvePowerUpCollection(message.objectId, true);
    if (message.playerId !== this.multiplayer?.playerId) {
      this.powerUps.rejectCollection(message.objectId);
      return;
    }
    const applied = this.powerUps.applyAuthoritativeState(
      message,
      this.multiplayer.estimatedServerTime,
    );
    if (applied && message.state === "active") {
      this.announcePowerUp(message.kind);
    }
  }

  rejectPowerUp(objectId: string): void {
    this.powerUps.rejectCollection(objectId);
    this.world.resolvePowerUpCollection(objectId, false);
  }

  summary(placement = this.localPlacement): RaceSummary {
    const snapshot = this.score.snapshot();
    const combo = this.score.combo.snapshot();
    return {
      placement,
      score: snapshot.score,
      completed: this.completed,
      finishTimeMs: this.completed ? Math.round(this.elapsed * 1_000) : null,
      distance: snapshot.distance,
      maxCombo: combo.maxMultiplier,
      shards: snapshot.shards,
      drones: snapshot.drones,
      crashes: snapshot.crashes,
      ping: this.multiplayer?.ping ?? 0,
      rank: rankForScore(snapshot.score),
    };
  }

  dispose(): void {
    this.hud.setVisible(false);
    this.hud.hideTutorial();
    this.player.dispose();
    this.world.dispose();
    for (const remote of this.remotePlayers.values()) remote.dispose();
    for (const rival of this.soloRivals) rival.dispose();
    this.remotePlayers.clear();
    this.soloRivals.length = 0;
    this.snapshotBuffer.clear();
  }

  private handleWorldEvent(event: WorldEvent): void {
    if (event.type === "power-up") {
      const result = this.powerUps.requestCollection(
        event.id,
        event.kind,
        this.multiplayer?.estimatedServerTime,
      );
      if (result.status === "activated") {
        this.announcePowerUp(event.kind);
      } else if (
        result.status === "pending" &&
        !this.multiplayer?.sendPowerUpCollect(event.id, event.kind)
      ) {
        this.rejectPowerUp(event.id);
      }
      return;
    }

    if (event.type === "hazard-hit") {
      const shielded = this.powerUps.consumeShield();
      this.player.handleWorldEvent(event, shielded);
      if (shielded) {
        this.audio.play("shield-break");
        this.hud.notice("Shield absorbed the hit", "danger");
      } else {
        this.score.handleWorldEvent(event);
        this.audio.play("crash");
        this.cameraRig.impact(this.settings.screenShake ? 0.38 : 0);
        this.hud.notice("FLOW BROKEN", "danger");
      }
      return;
    }

    this.player.handleWorldEvent(event);
    const points = this.score.handleWorldEvent(event);
    switch (event.type) {
      case "checkpoint":
        this.audio.play("checkpoint");
        this.hud.banner(`CHECKPOINT ${event.checkpoint + 1}`, points > 0 ? `+${points}` : undefined);
        if (this.mode === "multiplayer") {
          this.pendingCheckpoint = Math.max(this.pendingCheckpoint ?? 0, event.checkpoint);
          if (this.multiplayer?.sendCheckpoint(event.checkpoint)) {
            this.nextProgressRetryAt = this.serverNow() + 600;
          }
        }
        break;
      case "shard":
        this.audio.play("shard", event.risky ? 1.2 : 0.8);
        this.multiplayer?.sendGameplayEvent("shard", event.id);
        break;
      case "drone-destroyed":
        this.audio.play("drone-destroy");
        this.hud.notice(`DRONE BREAK +${points}`, "combo");
        this.multiplayer?.sendGameplayEvent("drone", event.id);
        break;
      case "finish":
        if (this.mode === "multiplayer") {
          if (!this.waitingForServerResults) {
            this.waitingForServerResults = true;
            this.pendingFinish = true;
            if (this.multiplayer?.sendFinish()) {
              this.nextProgressRetryAt = this.serverNow() + 600;
            }
            this.hud.banner("FINISH!", "Waiting for official results");
          }
        } else {
          this.finishLocal(true);
        }
        break;
    }
  }

  private announcePowerUp(kind: PowerUpStateMessage["kind"]): void {
    this.audio.play("checkpoint", 0.7);
    this.hud.notice(
      kind === "overdrive" ? "OVERDRIVE" : kind === "shield" ? "SHIELD CHARGED" : "MAGNET PULSE",
      "combo",
    );
  }

  private handlePlayerEvent(event: PlayerControllerEvent): void {
    switch (event.type) {
      case "jump":
        this.audio.play("jump", event.air ? 1.18 : 1);
        if (event.air) {
          this.hud.notice("DOUBLE JUMP", "combo", 850);
        }
        break;
      case "dash":
        this.audio.play("dash");
        this.score.award("dash", 45);
        break;
      case "grapple-attach":
        this.audio.play("grapple-attach");
        this.score.award("grapple", 30);
        break;
      case "grapple-release":
        this.audio.play("grapple-release");
        if (event.clean) {
          this.score.award("clean-release", 125, Math.min(2, event.speed / 20));
          this.multiplayer?.sendGameplayEvent("clean_release", `release-${this.player.networkState.sequence}`);
          this.hud.notice("CLEAN RELEASE", "combo", 1_300);
        }
        if (event.speed > 24) {
          this.multiplayer?.sendGameplayEvent("high_speed", `speed-${this.player.networkState.sequence}`);
        }
        break;
      case "wall-run":
        this.audio.play("wall-run", 0.7);
        this.score.award("wall-run", 90);
        break;
      case "rail":
        this.score.award("rail", 80);
        this.hud.notice("RAIL FLOW", "combo", 1_200);
        break;
      case "land":
        if (event.hard) this.cameraRig.impact(this.settings.screenShake ? Math.min(0.3, event.impact / 70) : 0);
        break;
      case "hazard":
        break;
      case "crash":
        this.score.crash();
        this.audio.play("crash");
        this.cameraRig.impact(this.settings.screenShake ? 0.42 : 0);
        this.multiplayer?.sendRespawn(event.reason === "manual" ? "stuck" : "fall");
        this.hud.banner("SIGNAL LOST", "Rebuilding at checkpoint");
        break;
      case "respawn":
        this.audio.play("respawn");
        this.hud.notice("Back in the flow", "info");
        break;
    }
  }

  private sendNetworkState(input: InputSnapshot, distance: number): void {
    if (!this.multiplayer?.connected) return;
    const motion = this.toMotionState(distance);
    this.multiplayer.sendState(
      {
        steer: input.steer,
        jump: input.jump,
        grapple: input.grapple,
        dash: input.dash,
      },
      motion,
    );
  }

  private retryProgressMessages(now: number): void {
    if (
      this.mode !== "multiplayer" ||
      !this.multiplayer?.connected ||
      now < this.nextProgressRetryAt
    ) {
      return;
    }
    let sent = false;
    if (this.pendingCheckpoint !== null) {
      sent = this.multiplayer.sendCheckpoint(this.pendingCheckpoint) || sent;
    }
    if (this.pendingFinish) {
      sent = this.multiplayer.sendFinish() || sent;
    }
    this.nextProgressRetryAt = now + (sent ? 750 : 250);
  }

  private toMotionState(distance = Math.max(0, this.player.position.z - this.world.spawnPosition.z)): PlayerMotionState {
    const position = this.player.position;
    const velocity = this.player.velocity;
    return {
      position: { x: position.x, y: position.y, z: position.z },
      velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
      yaw: this.player.yaw,
      distance,
      grounded: this.player.grounded,
      action: toProtocolAction(this.player.action),
    };
  }

  private updateHud(): void {
    const snapshot = this.score.snapshot();
    const combo = this.score.combo.snapshot();
    const playerCount =
      this.mode === "multiplayer"
        ? Math.max(1, this.latestServerSnapshot?.players.length ?? 1)
        : this.mode === "solo"
          ? this.soloRivals.length + 1
          : 1;
    const multiplayer = this.mode === "multiplayer";
    const shownCombo = multiplayer ? this.authoritativeCombo : combo.multiplier;
    this.hud.update({
      score: multiplayer ? this.authoritativeScore : snapshot.score,
      distance: snapshot.distance,
      placement: multiplayer ? this.localPlacement : this.soloPlacement(),
      playerCount,
      checkpoint: (multiplayer ? this.authoritativeCheckpoint : this.world.currentCheckpoint) + 1,
      totalCheckpoints: this.world.checkpoints.length,
      combo: shownCombo,
      comboProgress:
        multiplayer ? 0 : combo.multiplier >= 8 ? 1 : (combo.meter % 65) / 65,
      dashAvailable: this.player.dashAvailable,
      speed: this.player.speed * 3.6,
      ping: this.multiplayer?.ping ?? null,
      timer: this.remainingSeconds,
      powerUps: this.powerUps.active.map((power) => ({
        type: power.kind,
        remaining: power.remaining,
        duration: power.duration,
      })),
    });
  }

  private updateTutorial(distance: number): void {
    if (this.mode !== "tutorial") return;
    const segment = Math.max(1, this.world.totalDistance / TUTORIAL_STEPS.length);
    const step = Math.min(TUTORIAL_STEPS.length - 1, Math.floor(distance / segment));
    if (step === this.lastTutorialStep) return;
    this.lastTutorialStep = step;
    const tutorial = TUTORIAL_STEPS[step] ?? TUTORIAL_STEPS[0]!;
    this.hud.showTutorial(tutorial[0], tutorial[1], {
      key: tutorial[2],
      progress: (step + 1) / TUTORIAL_STEPS.length,
    });
  }

  private updateRemotePlayers(dt: number): void {
    const localId = this.multiplayer?.playerId ?? undefined;
    const samples = this.snapshotBuffer.sampleAll(performance.now(), localId);
    for (const [id, sample] of samples) {
      let remote = this.remotePlayers.get(id);
      if (!remote) {
        remote = new RemotePlayer(this.scene, id, {
          name: sample.player.name,
          color: sample.player.color,
        });
        this.remotePlayers.set(id, remote);
      }
      remote.applySnapshot(sample.player);
      remote.update(dt);
    }
    for (const [id, remote] of this.remotePlayers) {
      if (!samples.has(id)) remote.setVisible(false);
    }
  }

  private serverLeaderboard(message: SnapshotMessage): LeaderboardEntry[] {
    const localId = this.multiplayer?.playerId;
    return message.players.map((entry) => ({
      id: entry.id,
      name: entry.name,
      color: entry.color,
      placement: entry.placement,
      score: entry.score,
      checkpoint: entry.checkpointIndex + 1,
      finished: entry.finished,
      local: entry.id === localId,
    }));
  }

  private createSoloRivals(scene: THREE.Scene): void {
    for (let index = 0; index < 2; index += 1) {
      this.soloRivals.push(new SoloRival(scene, this.world.layout, index));
    }
    this.hud.setLeaderboard(this.soloLeaderboard());
  }

  private updateSoloRivals(dt: number): void {
    if (this.mode !== "solo") return;
    for (const rival of this.soloRivals) {
      rival.fixedUpdate(dt, this.elapsed);
    }
    this.hud.setLeaderboard(this.soloLeaderboard());
  }

  private renderSoloRivals(dt: number): void {
    if (this.mode !== "solo") return;
    for (const rival of this.soloRivals) {
      rival.renderUpdate(dt);
    }
  }

  private soloPlacement(): number {
    const distance = Math.max(0, this.player.position.z - this.world.spawnPosition.z);
    return 1 + this.soloRivals.filter((rival) => rival.isAheadOf(distance)).length;
  }

  private soloLeaderboard(): LeaderboardEntry[] {
    const localDistance = Math.max(0, this.player.position.z - this.world.spawnPosition.z);
    const entries: LeaderboardEntry[] = [
      {
        id: "local",
        name: this.settings.playerName,
        color: this.settings.playerColor,
        placement: this.soloPlacement(),
        score: this.score.score,
        checkpoint: this.world.currentCheckpoint + 1,
        local: true,
      },
    ];
    for (const rival of this.soloRivals) {
      entries.push({
        id: rival.id,
        name: rival.name,
        color: rival.color,
        placement: 1,
        score: rival.score,
        checkpoint: rival.checkpointIndex + 1,
        finished: rival.finished,
      });
    }
    entries.sort((left, right) => {
      const leftRival = this.soloRivals.find((rival) => rival.id === left.id);
      const rightRival = this.soloRivals.find((rival) => rival.id === right.id);
      const leftProgress = left.local ? localDistance : leftRival?.distance ?? 0;
      const rightProgress = right.local ? localDistance : rightRival?.distance ?? 0;
      return rightProgress - leftProgress;
    });
    entries.forEach((entry, index) => {
      entry.placement = index + 1;
    });
    return entries;
  }

  private finishLocal(completed: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.completed = completed;
    if (completed) this.score.finish(this.soloPlacement(), this.elapsed);
    this.audio.play(completed && this.soloPlacement() === 1 ? "victory" : "game-over");
    this.onFinish(this.summary(this.soloPlacement()));
  }

  private serverNow(): number {
    return this.mode === "multiplayer" && this.multiplayer
      ? this.multiplayer.estimatedServerTime
      : Date.now();
  }
}

function toProtocolAction(action: PlayerAction): PlayerMotionState["action"] {
  switch (action) {
    case "jump":
      return "jump";
    case "fall":
      return "fall";
    case "grapple":
      return "grapple";
    case "dash":
      return "dash";
    case "wall-run":
      return "wall_run";
    case "respawn":
      return "respawn";
    default:
      return "run";
  }
}
