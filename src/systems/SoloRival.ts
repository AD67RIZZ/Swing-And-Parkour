import * as THREE from "three";
import { RemotePlayer } from "../multiplayer/RemotePlayer";
import type { PlayerSnapshot } from "../shared/protocol";
import { hashSeed } from "../world/SeededRandom";
import type {
  CourseLayout,
  PlatformSpec,
  RailSpec,
  Vec3Tuple,
} from "../world/types";

type RivalPhase = "racing" | "falling" | "respawning" | "finished";

export interface SoloRivalDebugState {
  id: string;
  role: "cpu";
  state: RivalPhase;
  distance: number;
  checkpoint: number;
  failures: number;
  plannedFailures: number;
  finished: boolean;
}

interface RivalPersonality {
  name: string;
  color: PlayerSnapshot["color"];
  speed: number;
  startDelay: number;
  lane: number;
  riskRoute: boolean;
  cadence: number;
  phase: number;
}

interface RouteSurface {
  spec: PlatformSpec;
  startZ: number;
  endZ: number;
}

interface RouteSegment {
  startZ: number;
  endZ: number;
  from: RouteSurface;
  to: RouteSurface;
  kind: "surface" | "transition";
  action: PlayerSnapshot["motion"]["action"];
  airborne: boolean;
  arcHeight: number;
  control?: THREE.Vector3;
}

interface RoutePose {
  position: THREE.Vector3;
  action: PlayerSnapshot["motion"]["action"];
  grounded: boolean;
}

interface FallState {
  elapsed: number;
  start: THREE.Vector3;
  velocity: THREE.Vector3;
}

interface RespawnState {
  elapsed: number;
  position: THREE.Vector3;
  distance: number;
}

const RUNNER_SURFACE_OFFSET = 1.25;
const FALL_KILL_Y = 4;
const RESPAWN_SECONDS = 0.82;

const PERSONALITIES: ReadonlyArray<
  Omit<RivalPersonality, "phase" | "riskRoute">
> = [
  {
    name: "Pulse (CPU)",
    color: "#ff3df2",
    speed: 13.35,
    startDelay: 0.55,
    lane: -0.22,
    cadence: 0.83,
  },
  {
    name: "Circuit (CPU)",
    color: "#7cff6b",
    speed: 14.25,
    startDelay: 1.05,
    lane: 0.24,
    cadence: 0.69,
  },
];

/**
 * A deterministic offline rival. It consumes authored course geometry rather
 * than network snapshots, so it follows roofs, traverses gaps and rebuilds at
 * the same authored checkpoints as a player would.
 */
export class SoloRival {
  readonly id: string;
  readonly name: string;
  readonly color: PlayerSnapshot["color"];

  private readonly player: RemotePlayer;
  private readonly route: SoloRivalRoute;
  private readonly layout: CourseLayout;
  private readonly personality: RivalPersonality;
  private readonly failureDistances: number[];
  private readonly currentPosition = new THREE.Vector3();
  private readonly previousPosition = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private readonly lookAhead = new THREE.Vector3();
  private phase: RivalPhase = "racing";
  private fallState: FallState | null = null;
  private respawnState: RespawnState | null = null;
  private startDelay: number;
  private progress = 0;
  private checkpoint = 0;
  private failures = 0;
  private nextFailure = 0;
  private finishedAt: number | null = null;
  private teleportSnapshot = true;

  constructor(
    scene: THREE.Scene,
    layout: CourseLayout,
    rivalIndex: number,
  ) {
    const base =
      PERSONALITIES[rivalIndex % PERSONALITIES.length] ?? PERSONALITIES[0]!;
    const personalitySeed = hashSeed(
      `${layout.seed}:solo-rival:${rivalIndex}`,
    );
    this.personality = {
      ...base,
      phase: ((personalitySeed >>> 8) % 628) / 100,
      riskRoute: ((personalitySeed >>> 17) & 1) === 1,
    };
    this.id = `solo-rival-${rivalIndex}`;
    this.name = this.personality.name;
    this.color = this.personality.color;
    this.layout = layout;
    this.route = new SoloRivalRoute(
      layout,
      this.personality.lane,
      this.personality.riskRoute,
    );
    this.failureDistances = chooseFailureDistances(
      this.route.failureCandidates,
      layout.totalDistance,
      personalitySeed,
    );
    this.startDelay = this.personality.startDelay;
    this.player = new RemotePlayer(scene, this.id, {
      name: this.name,
      color: this.color,
    });

    // Keep CPU rivals distinct from multiplayer peers for scene inspection,
    // accessibility tooling and any future nameplate/status UI.
    this.player.group.name = `solo-rival:${this.id}`;
    delete this.player.group.userData.playerId;
    this.player.group.userData.rivalId = this.id;
    this.player.group.userData.role = "cpu";
    this.player.group.userData.online = false;

    const initial = this.route.sample(0, 0);
    this.currentPosition.copy(initial.position);
    this.previousPosition.copy(initial.position);
    this.publishSnapshot(0, initial.action, initial.grounded);
  }

  get distance(): number {
    return this.progress;
  }

  get score(): number {
    return Math.max(0, Math.round(this.progress * 12 - this.failures * 180));
  }

  get checkpointIndex(): number {
    return this.checkpoint;
  }

  get finished(): boolean {
    return this.phase === "finished";
  }

  get debugState(): SoloRivalDebugState {
    return {
      id: this.id,
      role: "cpu",
      state: this.phase,
      distance: Math.round(this.progress * 10) / 10,
      checkpoint: this.checkpoint,
      failures: this.failures,
      plannedFailures: this.failureDistances.length,
      finished: this.finished,
    };
  }

  isAheadOf(distance: number): boolean {
    return this.finished || this.progress > distance + 0.05;
  }

  fixedUpdate(dt: number, elapsed: number): void {
    const safeDt = THREE.MathUtils.clamp(dt, 0, 0.1);
    if (safeDt <= 0) return;
    this.previousPosition.copy(this.currentPosition);

    if (this.phase === "falling") {
      this.updateFall(safeDt, elapsed);
    } else if (this.phase === "respawning") {
      this.updateRespawn(safeDt, elapsed);
    } else if (this.phase === "finished") {
      const pose = this.route.sample(this.layout.totalDistance, elapsed);
      this.currentPosition.copy(pose.position);
      this.velocity.set(0, 0, 0);
      this.publishSnapshot(elapsed, "finished", true);
    } else {
      this.updateRace(safeDt, elapsed);
    }
  }

  renderUpdate(dt: number): void {
    this.player.update(dt);
  }

  dispose(): void {
    this.player.dispose();
  }

  private updateRace(dt: number, elapsed: number): void {
    if (this.startDelay > 0) {
      this.startDelay = Math.max(0, this.startDelay - dt);
      const pose = this.route.sample(this.progress, elapsed);
      this.currentPosition.copy(pose.position);
      this.velocity.set(0, 0, 0);
      this.publishSnapshot(elapsed, "run", true);
      return;
    }

    const cadence =
      1 +
      Math.sin(elapsed * this.personality.cadence + this.personality.phase) *
        0.035;
    const previousDistance = this.progress;
    const nextDistance = Math.min(
      this.layout.totalDistance,
      previousDistance + this.personality.speed * cadence * dt,
    );
    const failureDistance = this.failureDistances[this.nextFailure];
    if (
      failureDistance !== undefined &&
      previousDistance < failureDistance &&
      nextDistance >= failureDistance
    ) {
      this.progress = failureDistance;
      this.beginFall(elapsed);
      return;
    }

    this.progress = nextDistance;
    this.updateCheckpoint();
    const pose = this.route.sample(this.progress, elapsed);
    this.currentPosition.copy(pose.position);
    this.calculateVelocity(dt);

    if (this.progress >= this.layout.totalDistance) {
      this.phase = "finished";
      this.finishedAt = elapsed;
      this.velocity.set(0, 0, 0);
      this.publishSnapshot(elapsed, "finished", true);
      return;
    }
    this.publishSnapshot(elapsed, pose.action, pose.grounded);
  }

  private beginFall(elapsed: number): void {
    const pose = this.route.sample(this.progress, elapsed);
    const ahead = this.route.sample(
      Math.min(this.layout.totalDistance, this.progress + 0.8),
      elapsed,
    );
    const direction = ahead.position
      .clone()
      .sub(pose.position)
      .setY(0)
      .normalize();
    if (direction.lengthSq() < 0.1) direction.set(0, 0, 1);

    this.phase = "falling";
    this.failures += 1;
    this.nextFailure += 1;
    this.currentPosition.copy(pose.position);
    this.fallState = {
      elapsed: 0,
      start: pose.position.clone(),
      velocity: direction
        .multiplyScalar(this.personality.speed * 0.72)
        .setY(1.15),
    };
    this.velocity.copy(this.fallState.velocity);
    this.publishSnapshot(elapsed, "fall", false);
  }

  private updateFall(dt: number, elapsed: number): void {
    const fall = this.fallState;
    if (fall === null) return;
    fall.elapsed += dt;
    const time = fall.elapsed;
    this.currentPosition
      .copy(fall.start)
      .addScaledVector(fall.velocity, time);
    this.currentPosition.y =
      fall.start.y + fall.velocity.y * time - 12.5 * time * time;
    this.velocity.copy(fall.velocity);
    this.velocity.y = fall.velocity.y - 25 * time;
    this.publishSnapshot(elapsed, "fall", false);

    if (this.currentPosition.y <= FALL_KILL_Y || time >= 1.85) {
      this.beginRespawn(elapsed);
    }
  }

  private beginRespawn(elapsed: number): void {
    const checkpoint = latestCheckpoint(this.layout, this.progress);
    const position = new THREE.Vector3().fromArray(checkpoint.position);
    this.progress = checkpoint.distance;
    this.checkpoint = checkpoint.index;
    this.phase = "respawning";
    this.fallState = null;
    this.respawnState = {
      elapsed: 0,
      position,
      distance: checkpoint.distance,
    };
    this.currentPosition.copy(position).add(new THREE.Vector3(0, -2.6, 0));
    this.velocity.set(0, 3.2, 0);
    this.teleportSnapshot = true;
    this.publishSnapshot(elapsed, "respawn", false);
  }

  private updateRespawn(dt: number, elapsed: number): void {
    const respawn = this.respawnState;
    if (respawn === null) return;
    respawn.elapsed += dt;
    const ratio = THREE.MathUtils.clamp(
      respawn.elapsed / RESPAWN_SECONDS,
      0,
      1,
    );
    const rebuilt = 1 - Math.pow(1 - ratio, 3);
    this.currentPosition
      .copy(respawn.position)
      .add(new THREE.Vector3(0, (rebuilt - 1) * 2.6, 0));
    this.velocity.set(0, ratio < 1 ? 3.2 * (1 - ratio) : 0, 0);
    this.publishSnapshot(elapsed, "respawn", false);

    if (ratio >= 1) {
      this.phase = "racing";
      this.progress = respawn.distance;
      this.respawnState = null;
      const pose = this.route.sample(this.progress, elapsed);
      this.currentPosition.copy(pose.position);
      this.previousPosition.copy(pose.position);
      this.teleportSnapshot = true;
      this.publishSnapshot(elapsed, pose.action, pose.grounded);
    }
  }

  private calculateVelocity(dt: number): void {
    this.velocity
      .copy(this.currentPosition)
      .sub(this.previousPosition)
      .multiplyScalar(1 / Math.max(dt, 1 / 240));
  }

  private updateCheckpoint(): void {
    const worldZ = this.layout.spawn[2] + this.progress;
    for (const checkpoint of this.layout.checkpoints) {
      if (checkpoint.position[2] <= worldZ + 0.5) {
        this.checkpoint = Math.max(this.checkpoint, checkpoint.index);
      }
    }
  }

  private publishSnapshot(
    elapsed: number,
    action: PlayerSnapshot["motion"]["action"],
    grounded: boolean,
  ): void {
    const ahead = this.route.sample(
      Math.min(this.layout.totalDistance, this.progress + 0.75),
      elapsed,
    );
    this.lookAhead.copy(ahead.position).sub(this.currentPosition);
    const yaw =
      this.lookAhead.lengthSq() > 0.01
        ? Math.atan2(this.lookAhead.x, this.lookAhead.z)
        : 0;
    const snapshot: PlayerSnapshot = {
      id: this.id,
      name: this.name,
      color: this.color,
      // RemotePlayer uses this solely as a visibility flag here. Solo rivals
      // are never inserted into RaceScene's network-player collection.
      connected: true,
      motion: {
        position: {
          x: this.currentPosition.x,
          y: this.currentPosition.y,
          z: this.currentPosition.z,
        },
        velocity: {
          x: this.velocity.x,
          y: this.velocity.y,
          z: this.velocity.z,
        },
        yaw,
        distance: this.progress,
        grounded,
        action,
      },
      checkpointIndex: this.checkpoint,
      placement: 1,
      score: this.score,
      combo: 1,
      finished: this.finished,
      finishTimeMs:
        this.finishedAt === null ? null : Math.round(this.finishedAt * 1_000),
      respawningUntil: null,
      protectedUntil: null,
      pingMs: null,
    };
    this.player.applySnapshot(snapshot, this.teleportSnapshot);
    this.teleportSnapshot = false;
  }
}

class SoloRivalRoute {
  readonly failureCandidates: number[];

  private readonly layout: CourseLayout;
  private readonly lane: number;
  private readonly segments: RouteSegment[];
  private readonly reusablePosition = new THREE.Vector3();

  constructor(
    layout: CourseLayout,
    lane: number,
    riskRoute: boolean,
  ) {
    this.layout = layout;
    this.lane = lane;
    const surfaces = selectRouteSurfaces(layout, riskRoute);
    this.segments = buildRouteSegments(layout, surfaces);
    this.failureCandidates = this.segments
      .filter(
        (segment) =>
          segment.kind === "transition" &&
          segment.airborne &&
          segment.endZ - segment.startZ >= 4,
      )
      .map(
        (segment) =>
          (segment.startZ + segment.endZ) * 0.5 - layout.spawn[2],
      )
      .filter(
        (distance) =>
          distance >= layout.totalDistance * 0.16 &&
          distance <= layout.totalDistance * 0.88,
      );
  }

  sample(distance: number, elapsed: number): RoutePose {
    const worldZ =
      this.layout.spawn[2] +
      THREE.MathUtils.clamp(distance, 0, this.layout.totalDistance);
    const segment =
      this.segments.find(
        (candidate) =>
          worldZ >= candidate.startZ && worldZ <= candidate.endZ,
      ) ??
      (worldZ < (this.segments[0]?.startZ ?? 0)
        ? this.segments[0]
        : this.segments[this.segments.length - 1]);

    if (segment === undefined) {
      return {
        position: new THREE.Vector3().fromArray(this.layout.spawn),
        action: "run",
        grounded: true,
      };
    }

    if (segment.kind === "surface") {
      return {
        position: this.surfacePoint(
          segment.from,
          worldZ,
          elapsed,
          this.reusablePosition.clone(),
        ),
        action: "run",
        grounded: true,
      };
    }

    const span = Math.max(0.001, segment.endZ - segment.startZ);
    const ratio = THREE.MathUtils.clamp(
      (worldZ - segment.startZ) / span,
      0,
      1,
    );
    const from = this.surfacePoint(
      segment.from,
      segment.startZ,
      elapsed,
      new THREE.Vector3(),
    );
    const to = this.surfacePoint(
      segment.to,
      segment.endZ,
      elapsed,
      new THREE.Vector3(),
    );
    const position = new THREE.Vector3();
    if (segment.control !== undefined) {
      const inverse = 1 - ratio;
      position.set(
        inverse * inverse * from.x +
          2 * inverse * ratio * segment.control.x +
          ratio * ratio * to.x,
        inverse * inverse * from.y +
          2 * inverse * ratio * segment.control.y +
          ratio * ratio * to.y,
        worldZ,
      );
    } else {
      position.lerpVectors(from, to, ratio);
      position.z = worldZ;
      if (segment.airborne) {
        position.y += Math.sin(ratio * Math.PI) * segment.arcHeight;
      }
    }
    return {
      position,
      action: segment.action,
      grounded: !segment.airborne,
    };
  }

  private surfacePoint(
    surface: RouteSurface,
    z: number,
    elapsed: number,
    target: THREE.Vector3,
  ): THREE.Vector3 {
    const spec = surface.spec;
    const halfWidth = Math.max(0, spec.size[0] * 0.5 - 1.15);
    const laneOffset =
      THREE.MathUtils.clamp(this.lane, -1, 1) *
      Math.min(halfWidth, 2.4);
    target.set(
      spec.position[0] + laneOffset,
      spec.position[1] + spec.size[1] * 0.5 + RUNNER_SURFACE_OFFSET,
      z,
    );
    const movement = spec.movement;
    if (movement !== undefined) {
      const phase =
        elapsed * ((Math.PI * 2) / movement.period) + movement.phase;
      target[movement.axis] += Math.sin(phase) * movement.distance;
    }
    return target;
  }
}

function selectRouteSurfaces(
  layout: CourseLayout,
  riskRoute: boolean,
): RouteSurface[] {
  const surfaces: RouteSurface[] = [];
  for (const chunk of layout.chunks) {
    let platforms = layout.platforms.filter(
      (platform) =>
        platform.chunk === chunk.index && platform.kind !== "wall",
    );
    if (chunk.kind === "split") {
      const routeName = riskRoute ? "-risk" : "-safe";
      platforms = platforms.filter(
        (platform) =>
          (!platform.id.includes("-safe") &&
            !platform.id.includes("-risk")) ||
          platform.id.includes(routeName),
      );
    }
    platforms.sort(
      (left, right) => left.position[2] - right.position[2],
    );
    for (const spec of platforms) {
      surfaces.push({
        spec,
        startZ: spec.position[2] - spec.size[2] * 0.5,
        endZ: spec.position[2] + spec.size[2] * 0.5,
      });
    }
  }
  return surfaces;
}

function buildRouteSegments(
  layout: CourseLayout,
  surfaces: RouteSurface[],
): RouteSegment[] {
  if (surfaces.length === 0) return [];
  const segments: RouteSegment[] = [];
  const transitions: Array<{
    from: RouteSurface;
    to: RouteSurface;
    startZ: number;
    endZ: number;
  }> = [];

  for (let index = 0; index < surfaces.length - 1; index += 1) {
    const from = surfaces[index];
    const to = surfaces[index + 1];
    if (from === undefined || to === undefined) continue;
    const overlapStart = Math.max(from.startZ, to.startZ);
    const overlapEnd = Math.min(from.endZ, to.endZ);
    const overlaps = overlapEnd >= overlapStart;
    const center = overlaps
      ? (overlapStart + overlapEnd) * 0.5
      : (from.endZ + to.startZ) * 0.5;
    const halfBlend = overlaps
      ? Math.min(1.1, Math.max(0.55, (overlapEnd - overlapStart) * 0.25))
      : 0.65;
    transitions.push({
      from,
      to,
      startZ: Math.max(from.startZ, Math.min(from.endZ - 0.15, center - halfBlend)),
      endZ: Math.min(to.endZ, Math.max(to.startZ + 0.15, center + halfBlend)),
    });
  }

  let surfaceStart = Math.max(layout.spawn[2], surfaces[0]!.startZ);
  for (let index = 0; index < transitions.length; index += 1) {
    const transition = transitions[index];
    if (transition === undefined) continue;
    if (transition.startZ > surfaceStart) {
      segments.push({
        startZ: surfaceStart,
        endZ: transition.startZ,
        from: transition.from,
        to: transition.from,
        kind: "surface",
        action: "run",
        airborne: false,
        arcHeight: 0,
      });
    }

    const chunk =
      layout.chunks[transition.to.spec.chunk] ??
      layout.chunks[transition.from.spec.chunk];
    const rawGap = transition.to.startZ - transition.from.endZ;
    const heightDifference = Math.abs(
      roofY(transition.to.spec) - roofY(transition.from.spec),
    );
    const airborne = rawGap > 0.5 || heightDifference > 1.15;
    const action = transitionAction(chunk?.kind, airborne);
    const control = transitionControl(
      layout,
      transition,
      action,
    );
    segments.push({
      startZ: transition.startZ,
      endZ: Math.max(transition.startZ + 0.01, transition.endZ),
      from: transition.from,
      to: transition.to,
      kind: "transition",
      action,
      airborne,
      arcHeight: airborne
        ? THREE.MathUtils.clamp(
            Math.max(1.4, rawGap * 0.16 + heightDifference * 0.45),
            1.4,
            6.5,
          )
        : 0,
      ...(control === undefined ? {} : { control }),
    });
    surfaceStart = transition.endZ;
  }

  const last = surfaces[surfaces.length - 1]!;
  const finishZ = layout.spawn[2] + layout.totalDistance;
  if (finishZ > surfaceStart) {
    segments.push({
      startZ: surfaceStart,
      endZ: Math.min(finishZ, last.endZ),
      from: last,
      to: last,
      kind: "surface",
      action: "run",
      airborne: false,
      arcHeight: 0,
    });
  }
  return segments.filter(
    (segment) => segment.endZ - segment.startZ > 0.005,
  );
}

function transitionAction(
  chunkKind: CourseLayout["chunks"][number]["kind"] | undefined,
  airborne: boolean,
): PlayerSnapshot["motion"]["action"] {
  if (!airborne) return "run";
  if (chunkKind === "grapple") return "grapple";
  if (chunkKind === "wall-run") return "wall_run";
  if (chunkKind === "rail") return "dash";
  return "jump";
}

function transitionControl(
  layout: CourseLayout,
  transition: {
    from: RouteSurface;
    to: RouteSurface;
    startZ: number;
    endZ: number;
  },
  action: PlayerSnapshot["motion"]["action"],
): THREE.Vector3 | undefined {
  const chunkIndex = transition.to.spec.chunk;
  if (action === "grapple") {
    const anchor = nearestRouteFeature(
      layout.anchors
        .filter((entry) => entry.chunk === chunkIndex)
        .map((entry) => entry.position),
      transition,
    );
    if (anchor !== undefined) {
      return new THREE.Vector3(anchor[0], anchor[1] - 2.2, anchor[2]);
    }
  }
  if (action === "wall_run") {
    const wall = layout.platforms.find(
      (entry) => entry.chunk === chunkIndex && entry.kind === "wall",
    );
    if (wall !== undefined) {
      const side = Math.sign(wall.position[0] - transition.from.spec.position[0]) || 1;
      return new THREE.Vector3(
        wall.position[0] - side * 1.05,
        (roofY(transition.from.spec) + roofY(transition.to.spec)) * 0.5 + 2.6,
        (transition.startZ + transition.endZ) * 0.5,
      );
    }
  }
  if (action === "dash") {
    const rail = layout.rails.find((entry) => railChunk(entry) === chunkIndex);
    if (rail !== undefined) {
      return new THREE.Vector3(
        (rail.start[0] + rail.end[0]) * 0.5,
        (rail.start[1] + rail.end[1]) * 0.5 + 0.35,
        (rail.start[2] + rail.end[2]) * 0.5,
      );
    }
  }
  return undefined;
}

function nearestRouteFeature(
  positions: readonly Vec3Tuple[],
  transition: { startZ: number; endZ: number },
): Vec3Tuple | undefined {
  const midpoint = (transition.startZ + transition.endZ) * 0.5;
  return [...positions].sort(
    (left, right) =>
      Math.abs(left[2] - midpoint) - Math.abs(right[2] - midpoint),
  )[0];
}

function railChunk(rail: RailSpec): number {
  const value = Number.parseInt(rail.id.split("-")[1] ?? "", 10);
  return Number.isFinite(value) ? value : -1;
}

function roofY(spec: PlatformSpec): number {
  return spec.position[1] + spec.size[1] * 0.5 + RUNNER_SURFACE_OFFSET;
}

function chooseFailureDistances(
  candidates: readonly number[],
  totalDistance: number,
  seed: number,
): number[] {
  if (candidates.length === 0) return [];
  const plannedCount = 1 + ((seed >>> 4) & 1);
  const zones =
    plannedCount === 1
      ? ([[0.38, 0.68]] as const)
      : ([[0.24, 0.46], [0.61, 0.82]] as const);
  const selected: number[] = [];
  for (let index = 0; index < zones.length; index += 1) {
    const zone = zones[index];
    if (zone === undefined) continue;
    const inZone = candidates.filter(
      (distance) =>
        distance >= totalDistance * zone[0] &&
        distance <= totalDistance * zone[1] &&
        !selected.includes(distance),
    );
    const pool = inZone.length > 0 ? inZone : candidates;
    const choice =
      pool[(seed + index * 7_919) % pool.length] ?? pool[0];
    if (choice !== undefined && !selected.includes(choice)) {
      selected.push(choice);
    }
  }
  return selected.sort((left, right) => left - right);
}

function latestCheckpoint(
  layout: CourseLayout,
  distance: number,
): {
  index: number;
  distance: number;
  position: Vec3Tuple;
} {
  const worldZ = layout.spawn[2] + distance;
  let selected = {
    index: 0,
    distance: 0,
    position: layout.spawn,
  };
  for (const checkpoint of layout.checkpoints) {
    if (checkpoint.position[2] > worldZ) break;
    selected = {
      index: checkpoint.index,
      distance: Math.max(0, checkpoint.respawn[2] - layout.spawn[2]),
      position: checkpoint.respawn,
    };
  }
  return selected;
}
