import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import {
  RESPAWN_DELAY_MS,
  RESPAWN_PROTECTION_MS,
} from '../shared/protocol';
import type { AnchorSystem } from '../world/AnchorSystem';
import type { RailRecord, WorldEvent, WorldPlayerState } from '../world/types';
import { DashController } from './DashController';
import { GrappleController, type GrappleRelease } from './GrappleController';
import { PlayerModel } from './PlayerModel';
import type {
  CompactPlayerState,
  PlayerAction,
  PlayerControllerEvent,
  PlayerInputState,
  PlayerMovementModifiers,
} from './types';

export interface PlayerControllerOptions {
  spawn?: THREE.Vector3;
  rails?: readonly RailRecord[];
  checkpointProvider?: () => THREE.Vector3;
  killY?: number;
  baseRunSpeed?: number;
  maximumSpeed?: number;
  playerColor?: THREE.ColorRepresentation;
  reducedMotion?: boolean;
  /** Disable when an external fixed-step simulation owns world.step(). */
  stepPhysics?: boolean;
}

const DEFAULT_INPUT: Required<PlayerInputState> = {
  steer: 0,
  forward: 0,
  jump: false,
  grapple: false,
  dash: false,
  respawn: false,
};

const PLAYER_RADIUS = 0.46;
const PLAYER_SPHERE_OFFSET = 0.34;
const COLLISION_EPSILON = 0.012;
export const PLAYER_JUMP_VELOCITY = 11.8;
export const PLAYER_AIR_JUMPS = 1;
const RESPAWN_DELAY_SECONDS = RESPAWN_DELAY_MS / 1_000;
const RESPAWN_PROTECTION_SECONDS = RESPAWN_PROTECTION_MS / 1_000;
const SWEEP_OFFSETS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, -PLAYER_SPHERE_OFFSET, 0, PLAYER_RADIUS * 0.9],
  [0, PLAYER_SPHERE_OFFSET, 0, PLAYER_RADIUS * 0.9],
  [-0.32, -PLAYER_SPHERE_OFFSET, 0, 0.07],
  [0.32, -PLAYER_SPHERE_OFFSET, 0, 0.07],
  [0, -PLAYER_SPHERE_OFFSET, -0.32, 0.07],
  [0, -PLAYER_SPHERE_OFFSET, 0.32, 0.07],
  [-0.32, PLAYER_SPHERE_OFFSET, 0, 0.07],
  [0.32, PLAYER_SPHERE_OFFSET, 0, 0.07],
  [0, PLAYER_SPHERE_OFFSET, -0.32, 0.07],
  [0, PLAYER_SPHERE_OFFSET, 0.32, 0.07],
];

function clampInput(input: PlayerInputState): Required<PlayerInputState> {
  return {
    steer: THREE.MathUtils.clamp(Number.isFinite(input.steer) ? input.steer : 0, -1, 1),
    forward: THREE.MathUtils.clamp(Number.isFinite(input.forward) ? (input.forward ?? 0) : 0, -1, 1),
    jump: input.jump === true,
    grapple: input.grapple === true,
    dash: input.dash === true,
    respawn: input.respawn === true,
  };
}

export class PlayerController {
  readonly body: CANNON.Body;
  readonly model: PlayerModel;
  readonly grapple: GrappleController;
  readonly dash = new DashController();

  grounded = false;
  action: PlayerAction = 'idle';
  yaw = 0;
  checkpointIndex = 0;

  private readonly world: CANNON.World;
  private readonly anchorSystem: AnchorSystem;
  private readonly rails: readonly RailRecord[];
  private readonly checkpointProvider?: () => THREE.Vector3;
  private readonly killY: number;
  private readonly baseRunSpeed: number;
  private readonly maximumSpeed: number;
  private readonly stepPhysicsInternally: boolean;
  private readonly spawn: THREE.Vector3;
  private readonly checkpointPosition: THREE.Vector3;
  private readonly events: PlayerControllerEvent[] = [];
  private readonly threePosition = new THREE.Vector3();
  private readonly threeVelocity = new THREE.Vector3();
  private readonly grapplePoint = new THREE.Vector3();
  private readonly dashDirection = new THREE.Vector3();
  private readonly closestRailPoint = new THREE.Vector3();
  private readonly railDirection = new THREE.Vector3();
  private readonly correctionPosition = new THREE.Vector3();
  private readonly correctionVelocity = new THREE.Vector3();
  private readonly rayResult = new CANNON.RaycastResult();
  private readonly rayFrom = new CANNON.Vec3();
  private readonly rayTo = new CANNON.Vec3();
  private readonly physicsStart = new CANNON.Vec3();
  private readonly sweepMovement = new CANNON.Vec3();
  private readonly sweepNormal = new THREE.Vector3();
  private readonly penetrationNormal = new THREE.Vector3();
  private readonly releaseNormal = new THREE.Vector3();
  private sweepHitBody: CANNON.Body | null = null;
  private previousInput: Required<PlayerInputState> = { ...DEFAULT_INPUT };
  private modifiers: PlayerMovementModifiers = { speedMultiplier: 1, steeringAssist: 1 };
  private currentRail: RailRecord | null = null;
  private wallSide: -1 | 0 | 1 = 0;
  private wallRunTime = 0;
  private wallCooldown = 0;
  private coyoteTime = 0;
  private jumpBuffer = 0;
  private airJumpsRemaining = PLAYER_AIR_JUMPS;
  private landingPoseTime = 0;
  private stunRemaining = 0;
  private slowRemaining = 0;
  private invulnerabilityRemaining = 0;
  private respawnRemaining = 0;
  private respawnProtectionSeconds = RESPAWN_PROTECTION_SECONDS;
  private respawnUsesCheckpointProvider = true;
  private respawning = false;
  private hasCorrection = false;
  private sequence = 0;
  private disposed = false;

  constructor(
    scene: THREE.Scene,
    world: CANNON.World,
    anchorSystem: AnchorSystem,
    options: PlayerControllerOptions = {},
  ) {
    this.world = world;
    this.anchorSystem = anchorSystem;
    this.rails = options.rails ?? [];
    this.checkpointProvider = options.checkpointProvider;
    this.killY = options.killY ?? 4;
    this.baseRunSpeed = options.baseRunSpeed ?? 14;
    this.maximumSpeed = options.maximumSpeed ?? 33;
    this.stepPhysicsInternally = options.stepPhysics ?? true;
    this.spawn = (options.spawn ?? new THREE.Vector3(0, 32.25, 2)).clone();
    this.checkpointPosition = this.spawn.clone();

    const material = new CANNON.Material('runner');
    material.friction = 0;
    material.restitution = 0;
    this.body = new CANNON.Body({
      mass: 72,
      material,
      linearDamping: 0.035,
      angularDamping: 1,
      fixedRotation: true,
      allowSleep: false,
    });
    this.body.addShape(
      new CANNON.Sphere(PLAYER_RADIUS),
      new CANNON.Vec3(0, -PLAYER_SPHERE_OFFSET, 0),
    );
    this.body.addShape(
      new CANNON.Sphere(PLAYER_RADIUS),
      new CANNON.Vec3(0, PLAYER_SPHERE_OFFSET, 0),
    );
    this.body.position.set(this.spawn.x, this.spawn.y, this.spawn.z);
    this.body.updateMassProperties();
    world.addBody(this.body);

    this.model = new PlayerModel(scene, {
      color: options.playerColor ?? 0x42e8ff,
      reducedMotion: options.reducedMotion,
    });
    this.grapple = new GrappleController(scene, world, this.body, anchorSystem);
    this.syncModel(0, 0, DEFAULT_INPUT);
  }

  get position(): THREE.Vector3 {
    return this.threePosition.set(this.body.position.x, this.body.position.y, this.body.position.z);
  }

  get velocity(): THREE.Vector3 {
    return this.threeVelocity.set(this.body.velocity.x, this.body.velocity.y, this.body.velocity.z);
  }

  get speed(): number {
    return this.body.velocity.length();
  }

  get active(): boolean {
    return !this.respawning;
  }

  get invulnerable(): boolean {
    return this.invulnerabilityRemaining > 0 || this.respawning;
  }

  get isDashing(): boolean {
    return this.dash.isDashing;
  }

  get dashAvailable(): boolean {
    return this.dash.available;
  }

  get wallRunning(): boolean {
    return this.wallSide !== 0;
  }

  get railGrinding(): boolean {
    return this.currentRail !== null;
  }

  get networkState(): CompactPlayerState {
    let flags = 0;
    if (this.grounded) flags |= 1;
    if (this.dash.isDashing) flags |= 2;
    if (this.grapple.attached) flags |= 4;
    if (this.wallSide !== 0) flags |= 8;
    if (this.invulnerable) flags |= 16;
    if (this.respawning) flags |= 32;
    return {
      p: [this.body.position.x, this.body.position.y, this.body.position.z],
      v: [this.body.velocity.x, this.body.velocity.y, this.body.velocity.z],
      yaw: this.yaw,
      action: this.action,
      flags,
      checkpoint: this.checkpointIndex,
      grappleAnchor: this.grapple.attachedAnchor?.id ?? null,
      sequence: this.sequence,
    };
  }

  getWorldState(magnetRadius = 0): WorldPlayerState {
    const state: WorldPlayerState & { active: boolean } = {
      position: this.position,
      velocity: this.velocity,
      radius: 0.62,
      isDashing: this.dash.isDashing,
      invulnerable: this.invulnerable,
      magnetRadius,
      grappleAnchorId: this.grapple.attachedAnchor?.id ?? null,
      active: this.active,
    };
    return state;
  }

  setMovementModifiers(modifiers: Partial<PlayerMovementModifiers>): void {
    this.modifiers = {
      speedMultiplier: THREE.MathUtils.clamp(modifiers.speedMultiplier ?? this.modifiers.speedMultiplier, 0.5, 1.6),
      steeringAssist: THREE.MathUtils.clamp(modifiers.steeringAssist ?? this.modifiers.steeringAssist, 0.5, 1.6),
    };
  }

  setPowerEffects(overdrive: boolean, shielded: boolean): void {
    this.model.setPowerEffects(overdrive, shielded);
  }

  setReducedMotion(enabled: boolean): void {
    this.model.setReducedMotion(enabled);
  }

  update(dt: number, elapsed: number, inputState: PlayerInputState): void {
    if (this.disposed) {
      return;
    }
    const dtSafe = Math.max(0, Math.min(0.1, dt));
    const input = clampInput(inputState);
    this.sequence += 1;
    this.tickTimers(dtSafe);
    this.dash.update(dtSafe);

    if (this.respawning) {
      this.updateRespawn(dtSafe, elapsed, input);
      this.previousInput = input;
      return;
    }

    if (input.respawn && !this.previousInput.respawn && !this.invulnerable) {
      this.startRespawn('manual');
      this.previousInput = input;
      return;
    }
    if (this.body.position.y < this.killY || !Number.isFinite(this.body.position.y)) {
      this.startRespawn(Number.isFinite(this.body.position.y) ? 'fall' : 'physics');
      this.previousInput = input;
      return;
    }

    const wasGrounded = this.grounded;
    const verticalBeforeStep = this.body.velocity.y;
    this.handleInputEdges(input);
    if (this.stunRemaining <= 0) {
      this.updateRail(input);
      this.updateWallRun(dtSafe, input);
      this.applyRunForces(input);
      this.applyJump(input);
      this.applyDash(input);
      this.applyGrapple(dtSafe, elapsed, input);
    }
    this.applyVelocityLimits();
    this.smoothNetworkCorrection(dtSafe);
    this.physicsStart.copy(this.body.position);

    if (this.stepPhysicsInternally) {
      this.world.step(1 / 180, dtSafe, 18);
      const sweptNormal = this.resolveSweptPlatformCollision(this.physicsStart);
      const overlapNormal = this.resolvePlatformPenetrations();
      const obstructionNormal = sweptNormal ?? overlapNormal;
      if (
        obstructionNormal !== null &&
        this.grapple.attached &&
        (sweptNormal !== null || this.penetrationNormal.lengthSq() > 0.0025)
      ) {
        const forcedRelease = this.grapple.detach('obstructed', obstructionNormal);
        if (forcedRelease !== null) {
          this.completeGrappleRelease(forcedRelease);
        }
      }
    }
    this.grounded = this.detectGrounded() || this.currentRail !== null;
    this.handleLanding(wasGrounded, verticalBeforeStep);
    if (this.grounded) {
      this.coyoteTime = 0.12;
      this.dash.resetOnGround();
      if (this.body.velocity.y <= 0.5 || this.currentRail !== null) {
        this.airJumpsRemaining = PLAYER_AIR_JUMPS;
      }
      if (this.wallSide !== 0) {
        this.wallSide = 0;
        this.wallRunTime = 0;
      }
    }

    this.updateAction(input);
    this.updateYaw(dtSafe, input.steer);
    this.syncModel(dtSafe, elapsed, input);
    this.previousInput = input;
  }

  private tickTimers(dt: number): void {
    this.coyoteTime = Math.max(0, this.coyoteTime - dt);
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.landingPoseTime = Math.max(0, this.landingPoseTime - dt);
    this.stunRemaining = Math.max(0, this.stunRemaining - dt);
    this.slowRemaining = Math.max(0, this.slowRemaining - dt);
    this.invulnerabilityRemaining = Math.max(0, this.invulnerabilityRemaining - dt);
    this.wallCooldown = Math.max(0, this.wallCooldown - dt);
  }

  private handleInputEdges(input: Required<PlayerInputState>): void {
    if (input.jump && !this.previousInput.jump) {
      this.jumpBuffer = 0.14;
    }
    if (input.grapple && !this.previousInput.grapple) {
      const anchor = this.grapple.tryAttach(this.position, this.velocity);
      if (anchor !== null) {
        this.events.push({ type: 'grapple-attach', anchorId: anchor.id });
      }
    } else if (!input.grapple && this.previousInput.grapple) {
      this.releaseGrapple('input');
    }
  }

  private applyRunForces(input: Required<PlayerInputState>): void {
    if (this.currentRail !== null || this.dash.isDashing) {
      return;
    }
    const groundFactor = this.grounded ? 1 : 0.48;
    const slowFactor = this.slowRemaining > 0 ? 0.62 : 1;
    const forwardInfluence = 1 + input.forward * (input.forward >= 0 ? 0.1 : 0.3);
    const targetForward =
      this.baseRunSpeed * this.modifiers.speedMultiplier * slowFactor * forwardInfluence;
    const targetSide = input.steer * 6.6 * this.modifiers.steeringAssist;
    const forceX = (targetSide - this.body.velocity.x) * this.body.mass * 8.5 * groundFactor;
    const forceZ = (targetForward - this.body.velocity.z) * this.body.mass * 3.1 * (this.grounded ? 1 : 0.55);
    this.body.applyForce(new CANNON.Vec3(forceX, 0, forceZ));
  }

  private applyJump(_input: Required<PlayerInputState>): void {
    const hasGroundSupport =
      this.grounded || this.coyoteTime > 0 || this.currentRail !== null;
    const isAirJump = !hasGroundSupport;
    if (
      this.jumpBuffer <= 0 ||
      (isAirJump && this.airJumpsRemaining <= 0)
    ) {
      return;
    }
    this.jumpBuffer = 0;
    this.coyoteTime = 0;
    if (isAirJump) {
      this.airJumpsRemaining -= 1;
    }
    this.currentRail = null;
    this.grounded = false;
    this.body.velocity.y = PLAYER_JUMP_VELOCITY;
    this.body.velocity.z = Math.max(this.body.velocity.z, this.baseRunSpeed * 0.92);
    this.events.push({ type: 'jump', air: isAirJump });
  }

  private applyDash(input: Required<PlayerInputState>): void {
    if (!input.dash || this.previousInput.dash || this.grounded) {
      return;
    }
    this.releaseGrapple('dash');
    this.currentRail = null;
    this.dashDirection.set(input.steer * 0.32, 0.06, 1);
    if (this.dash.tryDash(this.body, this.dashDirection, this.modifiers.speedMultiplier)) {
      this.events.push({ type: 'dash' });
    }
  }

  private applyGrapple(
    dt: number,
    elapsed: number,
    input: Required<PlayerInputState>,
  ): void {
    this.model.getGrapplePoint(this.grapplePoint);
    const forcedRelease = this.grapple.update(
      dt,
      elapsed,
      this.grapplePoint,
      input.forward,
      input.steer,
    );
    if (forcedRelease !== null) {
      this.completeGrappleRelease(forcedRelease);
    }
  }

  private releaseGrapple(reason: GrappleRelease['reason']): void {
    const release = this.grapple.detach(reason);
    if (release !== null) {
      this.completeGrappleRelease(release);
    }
  }

  private completeGrappleRelease(release: GrappleRelease): void {
    if (release.reason === 'dispose') {
      return;
    }
    if (release.separationNormal !== undefined) {
      this.releaseNormal.copy(release.separationNormal).normalize();
      this.body.position.x += this.releaseNormal.x * 0.11;
      this.body.position.y += this.releaseNormal.y * 0.11;
      this.body.position.z += this.releaseNormal.z * 0.11;
      const inward =
        this.body.velocity.x * this.releaseNormal.x +
        this.body.velocity.y * this.releaseNormal.y +
        this.body.velocity.z * this.releaseNormal.z;
      if (inward < 0) {
        this.body.velocity.x -= this.releaseNormal.x * inward;
        this.body.velocity.y -= this.releaseNormal.y * inward;
        this.body.velocity.z -= this.releaseNormal.z * inward;
      }
      // A small outward separation gets the capsule away from an underside or
      // wall. Tangential swing speed is deliberately left untouched.
      this.body.velocity.x += this.releaseNormal.x * 1.15;
      this.body.velocity.y += this.releaseNormal.y * 1.15;
      this.body.velocity.z += this.releaseNormal.z * 1.15;
      if (Math.hypot(this.body.velocity.x, this.body.velocity.z) < 5.5) {
        this.body.velocity.z = Math.max(this.body.velocity.z, 5.5);
      }
      this.body.aabbNeedsUpdate = true;
      this.resolvePlatformPenetrations(2);
    }
    // RaceScene turns grapple-release events into score/network events. Forced
    // interruptions therefore stay internal and can never be credited as an
    // intentional clean or high-speed release.
    if (release.reason !== 'input') {
      return;
    }
    this.events.push({
      type: 'grapple-release',
      speed: release.speed,
      clean: release.clean,
      reason: 'input',
    });
  }

  private updateWallRun(dt: number, input: Required<PlayerInputState>): void {
    if (
      this.grounded ||
      this.grapple.attached ||
      this.currentRail !== null ||
      this.wallCooldown > 0 ||
      Math.abs(input.steer) < 0.22 ||
      this.body.velocity.z < 8
    ) {
      if (this.wallSide !== 0) {
        this.wallCooldown = 0.28;
      }
      this.wallSide = 0;
      this.wallRunTime = 0;
      return;
    }

    const side: -1 | 1 = input.steer < 0 ? -1 : 1;
    const fromX = this.body.position.x + side * 0.56;
    this.rayFrom.set(fromX, this.body.position.y, this.body.position.z);
    this.rayTo.set(this.body.position.x + side * 1.22, this.body.position.y, this.body.position.z);
    this.rayResult.reset();
    const hit = this.world.raycastClosest(
      this.rayFrom,
      this.rayTo,
      { skipBackfaces: true },
      this.rayResult,
    );
    const verticalWall =
      hit && this.rayResult.body !== this.body && Math.abs(this.rayResult.hitNormalWorld.y) < 0.35;
    if (!verticalWall || this.wallRunTime >= 1.45) {
      if (this.wallSide !== 0) {
        this.wallCooldown = 0.35;
      }
      this.wallSide = 0;
      this.wallRunTime = 0;
      return;
    }

    if (this.wallSide === 0) {
      this.events.push({ type: 'wall-run', side });
    }
    this.wallSide = side;
    this.wallRunTime += dt;
    this.body.applyForce(
      new CANNON.Vec3(
        side * this.body.mass * 4.2,
        this.body.mass * 21.5,
        this.body.mass * 5.5,
      ),
    );
    this.body.velocity.y = Math.max(this.body.velocity.y, -1.2);
    this.body.velocity.z = Math.max(this.body.velocity.z, this.baseRunSpeed * 1.04);
  }

  private updateRail(input: Required<PlayerInputState>): void {
    if (
      this.grapple.attached ||
      this.dash.isDashing ||
      (this.grounded && this.currentRail === null)
    ) {
      this.currentRail = null;
      return;
    }
    if (this.currentRail === null) {
      this.currentRail = this.findNearbyRail();
      if (this.currentRail !== null) {
        this.events.push({ type: 'rail', railId: this.currentRail.spec.id });
      }
    }
    const rail = this.currentRail;
    if (rail === null) {
      return;
    }
    const segment = this.railDirection.copy(rail.end).sub(rail.start);
    const length = segment.length();
    if (length < 0.1) {
      this.currentRail = null;
      return;
    }
    const direction = segment.multiplyScalar(1 / length);
    this.temporaryClosestOnRail(rail, this.position, this.closestRailPoint);
    const distanceFromEnd = this.closestRailPoint.distanceTo(rail.end);
    if (distanceFromEnd < 0.7 || input.jump) {
      this.currentRail = null;
      if (input.jump) {
        this.jumpBuffer = 0.14;
      }
      return;
    }
    const grindSpeed = Math.max(15.5, this.body.velocity.length() * 0.98);
    this.body.position.x = THREE.MathUtils.lerp(this.body.position.x, this.closestRailPoint.x, 0.45);
    this.body.position.y = THREE.MathUtils.lerp(this.body.position.y, this.closestRailPoint.y + 0.82, 0.65);
    this.body.position.z = THREE.MathUtils.lerp(this.body.position.z, this.closestRailPoint.z, 0.45);
    this.body.velocity.set(direction.x * grindSpeed, direction.y * grindSpeed, direction.z * grindSpeed);
  }

  private findNearbyRail(): RailRecord | null {
    let nearest: RailRecord | null = null;
    let nearestDistance = Infinity;
    for (const rail of this.rails) {
      this.temporaryClosestOnRail(rail, this.position, this.closestRailPoint);
      const dx = this.body.position.x - this.closestRailPoint.x;
      const dz = this.body.position.z - this.closestRailPoint.z;
      const horizontal = Math.hypot(dx, dz);
      const vertical = Math.abs(this.body.position.y - (this.closestRailPoint.y + 0.82));
      const distance = horizontal + vertical * 0.45;
      if (horizontal < 1.05 && vertical < 1.35 && this.body.velocity.y <= 2.5 && distance < nearestDistance) {
        nearest = rail;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  private temporaryClosestOnRail(
    rail: RailRecord,
    point: THREE.Vector3,
    target: THREE.Vector3,
  ): THREE.Vector3 {
    const segment = this.railDirection.copy(rail.end).sub(rail.start);
    const lengthSq = segment.lengthSq();
    if (lengthSq < 0.001) {
      return target.copy(rail.start);
    }
    const t = THREE.MathUtils.clamp(point.clone().sub(rail.start).dot(segment) / lengthSq, 0, 1);
    return target.copy(rail.start).addScaledVector(segment, t);
  }

  /**
   * Cannon-es has no native CCD. Ten inexpensive rays approximate the swept
   * two-sphere capsule and stop the body before it can cross a platform in one
   * simulation tick.
   */
  private resolveSweptPlatformCollision(start: CANNON.Vec3): THREE.Vector3 | null {
    this.sweepNormal.set(0, 0, 0);
    this.sweepHitBody = null;
    this.sweepMovement.set(
      this.body.position.x - start.x,
      this.body.position.y - start.y,
      this.body.position.z - start.z,
    );
    const distance = this.sweepMovement.length();
    if (distance < 0.055) {
      return null;
    }

    let earliestSafeDistance = Infinity;
    const previousMask = this.body.collisionFilterMask;
    // A ray beginning inside the player's compound body would otherwise hit
    // the player itself before reaching course geometry.
    this.body.collisionFilterMask = 0;
    try {
      for (const [offsetX, offsetY, offsetZ, clearance] of SWEEP_OFFSETS) {
        this.rayFrom.set(
          start.x + offsetX,
          start.y + offsetY,
          start.z + offsetZ,
        );
        this.rayTo.set(
          this.body.position.x + offsetX,
          this.body.position.y + offsetY,
          this.body.position.z + offsetZ,
        );
        this.rayResult.reset();
        const hit = this.world.raycastClosest(
          this.rayFrom,
          this.rayTo,
          { skipBackfaces: false },
          this.rayResult,
        );
        if (
          !hit ||
          !this.isPlatformBody(this.rayResult.body) ||
          this.rayResult.body.collisionFilterMask === 0
        ) {
          continue;
        }
        const safeDistance = Math.max(0, this.rayResult.distance - clearance);
        if (safeDistance >= earliestSafeDistance) {
          continue;
        }
        earliestSafeDistance = safeDistance;
        this.sweepHitBody = this.rayResult.body;
        this.sweepNormal.set(
          this.rayResult.hitNormalWorld.x,
          this.rayResult.hitNormalWorld.y,
          this.rayResult.hitNormalWorld.z,
        );
      }
    } finally {
      this.body.collisionFilterMask = previousMask;
    }

    if (this.sweepHitBody === null || !Number.isFinite(earliestSafeDistance)) {
      return null;
    }
    if (this.sweepNormal.lengthSq() < 0.01) {
      this.sweepNormal
        .set(-this.sweepMovement.x, -this.sweepMovement.y, -this.sweepMovement.z)
        .normalize();
    } else {
      this.sweepNormal.normalize();
    }
    const fraction = THREE.MathUtils.clamp(earliestSafeDistance / distance, 0, 1);
    this.body.position.set(
      start.x + this.sweepMovement.x * fraction + this.sweepNormal.x * COLLISION_EPSILON,
      start.y + this.sweepMovement.y * fraction + this.sweepNormal.y * COLLISION_EPSILON,
      start.z + this.sweepMovement.z * fraction + this.sweepNormal.z * COLLISION_EPSILON,
    );
    this.removeVelocityIntoSurface(
      this.sweepNormal.x,
      this.sweepNormal.y,
      this.sweepNormal.z,
      this.sweepHitBody,
    );
    this.body.aabbNeedsUpdate = true;
    return this.sweepNormal;
  }

  /**
   * Last-resort overlap extrusion for seams, moving bodies and a network
   * correction that starts inside geometry. The two sphere contacts are first
   * treated as one vertical capsule, then one minimum translation is applied
   * per platform/pass. Resolving each sphere independently can make the lower
   * and upper halves push in opposite directions forever.
   */
  private resolvePlatformPenetrations(maxIterations = 3): THREE.Vector3 | null {
    this.penetrationNormal.set(0, 0, 0);
    let correctedAny = false;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      let correctedThisPass = false;
      for (const platform of this.world.bodies) {
        if (
          !this.isPlatformBody(platform) ||
          platform.collisionFilterMask === 0
        ) {
          continue;
        }
        const shape = platform.shapes[0];
        if (!(shape instanceof CANNON.Box)) {
          continue;
        }
        const half = shape.halfExtents;
        const localX = this.body.position.x - platform.position.x;
        const localY = this.body.position.y - platform.position.y;
        const localZ = this.body.position.z - platform.position.z;
        if (
          Math.abs(localX) > half.x + PLAYER_RADIUS ||
          Math.abs(localY) >
            half.y + PLAYER_SPHERE_OFFSET + PLAYER_RADIUS ||
          Math.abs(localZ) > half.z + PLAYER_RADIUS
        ) {
          continue;
        }

        let intersectsCapsule = false;
        for (let sphereIndex = 0; sphereIndex < 2; sphereIndex += 1) {
          const sphereOffset =
            sphereIndex === 0 ? -PLAYER_SPHERE_OFFSET : PLAYER_SPHERE_OFFSET;
          const sphereLocalY = localY + sphereOffset;
          const closestX = THREE.MathUtils.clamp(localX, -half.x, half.x);
          const closestY = THREE.MathUtils.clamp(sphereLocalY, -half.y, half.y);
          const closestZ = THREE.MathUtils.clamp(localZ, -half.z, half.z);
          const deltaX = localX - closestX;
          const deltaY = sphereLocalY - closestY;
          const deltaZ = localZ - closestZ;
          if (
            deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ <
            PLAYER_RADIUS * PLAYER_RADIUS
          ) {
            intersectsCapsule = true;
            break;
          }
        }
        if (!intersectsCapsule) {
          continue;
        }

        const capsuleHalfY = PLAYER_SPHERE_OFFSET + PLAYER_RADIUS;
        const penetrationX = half.x + PLAYER_RADIUS - Math.abs(localX);
        const penetrationY = half.y + capsuleHalfY - Math.abs(localY);
        const penetrationZ = half.z + PLAYER_RADIUS - Math.abs(localZ);
        const signX =
          Math.abs(localX) > 1e-8
            ? Math.sign(localX)
            : Math.abs(this.body.velocity.x) > 1e-8
              ? -Math.sign(this.body.velocity.x)
              : 1;
        const signY =
          Math.abs(localY) > 1e-8
            ? Math.sign(localY)
            : Math.abs(this.body.velocity.y) > 1e-8
              ? -Math.sign(this.body.velocity.y)
              : 1;
        const signZ =
          Math.abs(localZ) > 1e-8
            ? Math.sign(localZ)
            : Math.abs(this.body.velocity.z) > 1e-8
              ? -Math.sign(this.body.velocity.z)
              : 1;

        let normalX = signX;
        let normalY = 0;
        let normalZ = 0;
        let penetration = penetrationX;
        if (penetrationY < penetration) {
          normalX = 0;
          normalY = signY;
          penetration = penetrationY;
        }
        if (penetrationZ < penetration) {
          normalX = 0;
          normalY = 0;
          normalZ = signZ;
          penetration = penetrationZ;
        }

        const correction = Math.max(0, penetration) + COLLISION_EPSILON;
        this.body.position.x += normalX * correction;
        this.body.position.y += normalY * correction;
        this.body.position.z += normalZ * correction;
        this.penetrationNormal.x += normalX * correction;
        this.penetrationNormal.y += normalY * correction;
        this.penetrationNormal.z += normalZ * correction;
        this.removeVelocityIntoSurface(
          normalX,
          normalY,
          normalZ,
          platform,
        );
        correctedThisPass = true;
        correctedAny = true;
      }
      if (!correctedThisPass) {
        break;
      }
    }

    if (!correctedAny) {
      return null;
    }
    if (this.penetrationNormal.lengthSq() > 1e-8) {
      this.penetrationNormal.normalize();
    }
    this.body.aabbNeedsUpdate = true;
    return this.penetrationNormal;
  }

  private removeVelocityIntoSurface(
    normalX: number,
    normalY: number,
    normalZ: number,
    platform: CANNON.Body,
  ): void {
    const relativeNormalVelocity =
      (this.body.velocity.x - platform.velocity.x) * normalX +
      (this.body.velocity.y - platform.velocity.y) * normalY +
      (this.body.velocity.z - platform.velocity.z) * normalZ;
    if (relativeNormalVelocity >= 0) {
      return;
    }
    this.body.velocity.x -= normalX * relativeNormalVelocity;
    this.body.velocity.y -= normalY * relativeNormalVelocity;
    this.body.velocity.z -= normalZ * relativeNormalVelocity;
  }

  private isPlatformBody(body: CANNON.Body | null): body is CANNON.Body {
    if (body === null) {
      return false;
    }
    const tagged = body as CANNON.Body & {
      userData?: { platformId?: unknown };
    };
    return typeof tagged.userData?.platformId === 'string';
  }

  private applyVelocityLimits(): void {
    const maximum = this.maximumSpeed * this.modifiers.speedMultiplier;
    const horizontal = Math.hypot(this.body.velocity.x, this.body.velocity.z);
    if (horizontal > maximum) {
      const scale = maximum / horizontal;
      this.body.velocity.x *= scale;
      this.body.velocity.z *= scale;
    }
    this.body.velocity.y = THREE.MathUtils.clamp(this.body.velocity.y, -35, 24);
  }

  private detectGrounded(): boolean {
    for (const contact of this.world.contacts) {
      if (contact.bi !== this.body && contact.bj !== this.body) {
        continue;
      }
      const normalY = contact.bi === this.body ? -contact.ni.y : contact.ni.y;
      if (normalY > 0.48) {
        return true;
      }
    }
    this.rayFrom.set(
      this.body.position.x,
      this.body.position.y - 0.76,
      this.body.position.z,
    );
    this.rayTo.set(
      this.body.position.x,
      this.body.position.y - 1.08,
      this.body.position.z,
    );
    this.rayResult.reset();
    return this.world.raycastClosest(
      this.rayFrom,
      this.rayTo,
      { skipBackfaces: true },
      this.rayResult,
    ) && this.rayResult.body !== this.body && this.rayResult.hitNormalWorld.y > 0.45;
  }

  private handleLanding(wasGrounded: boolean, verticalBeforeStep: number): void {
    if (wasGrounded || !this.grounded || this.currentRail !== null) {
      return;
    }
    const impact = Math.max(0, -verticalBeforeStep);
    const hard = impact >= 17;
    if (hard) {
      this.body.velocity.x *= 0.72;
      this.body.velocity.z = Math.max(this.baseRunSpeed * 0.7, this.body.velocity.z * 0.76);
      this.invulnerabilityRemaining = Math.max(this.invulnerabilityRemaining, 0.32);
    }
    this.landingPoseTime = hard ? 0.24 : 0.12;
    this.model.triggerLanding(impact);
    this.events.push({ type: 'land', impact, hard });
  }

  private updateAction(input: Required<PlayerInputState>): void {
    if (this.respawning) {
      this.action = 'respawn';
    } else if (this.landingPoseTime > 0) {
      this.action = 'land';
    } else if (this.dash.isDashing) {
      this.action = 'dash';
    } else if (this.grapple.attached) {
      this.action = 'grapple';
    } else if (this.wallSide !== 0) {
      this.action = 'wall-run';
    } else if (this.currentRail !== null) {
      this.action = 'rail';
    } else if (this.grounded && input.forward < -0.55) {
      this.action = 'slide';
    } else if (!this.grounded) {
      this.action = this.body.velocity.y > 0.5 ? 'jump' : 'fall';
    } else {
      this.action = this.body.velocity.length() > 1 ? 'run' : 'idle';
    }
  }

  private updateYaw(dt: number, steer: number): void {
    const movementYaw = Math.atan2(this.body.velocity.x, Math.max(2, this.body.velocity.z));
    const target = movementYaw * 0.75 + steer * 0.08;
    this.yaw = THREE.MathUtils.lerp(this.yaw, target, 1 - Math.exp(-10 * dt));
  }

  private syncModel(
    dt: number,
    elapsed: number,
    input: Pick<Required<PlayerInputState>, 'steer'>,
  ): void {
    this.model.update(dt, elapsed, this.position, this.yaw, {
      action: this.action,
      speed: this.speed,
      steer: input.steer,
      verticalVelocity: this.body.velocity.y,
      grounded: this.grounded,
    });
  }

  applyHazard(
    impulse: THREE.Vector3,
    shielded = false,
    slowSeconds = 0.9,
    stunSeconds = 0.2,
  ): boolean {
    if (this.invulnerable) {
      return false;
    }
    this.events.push({ type: 'hazard', shielded });
    if (shielded) {
      this.invulnerabilityRemaining = 0.45;
      return true;
    }
    this.releaseGrapple('hazard');
    this.currentRail = null;
    this.body.velocity.x += impulse.x;
    this.body.velocity.y = Math.max(this.body.velocity.y, impulse.y);
    this.body.velocity.z += impulse.z;
    this.slowRemaining = Math.max(this.slowRemaining, slowSeconds);
    this.stunRemaining = Math.max(this.stunRemaining, stunSeconds);
    this.invulnerabilityRemaining = 0.75;
    return true;
  }

  handleWorldEvent(event: WorldEvent, shielded = false): void {
    if (event.type === 'checkpoint') {
      this.setCheckpoint(event.respawn, event.checkpoint);
    } else if (event.type === 'hazard-hit') {
      this.applyHazard(event.impulse, shielded);
    }
  }

  setCheckpoint(position: THREE.Vector3, index = this.checkpointIndex): void {
    const safeIndex = Math.max(0, Math.floor(Number.isFinite(index) ? index : 0));
    if (safeIndex < this.checkpointIndex) {
      return;
    }
    this.checkpointIndex = safeIndex;
    this.checkpointPosition.copy(position);
  }

  /**
   * Applies server-owned progress, including rollback. Normal local checkpoint
   * updates stay monotonic through setCheckpoint().
   */
  setAuthoritativeCheckpoint(position: THREE.Vector3, index: number): void {
    this.checkpointIndex = Math.max(
      0,
      Math.floor(Number.isFinite(index) ? index : 0),
    );
    this.checkpointPosition.copy(position);
  }

  setAuthoritativeProtection(seconds: number): void {
    this.invulnerabilityRemaining = Math.max(
      this.invulnerabilityRemaining,
      THREE.MathUtils.clamp(Number.isFinite(seconds) ? seconds : 0, 0, 10),
    );
  }

  startRespawn(reason: 'fall' | 'manual' | 'physics' = 'fall'): void {
    if (this.respawning) {
      return;
    }
    this.releaseGrapple('respawn');
    this.currentRail = null;
    this.wallSide = 0;
    this.respawning = true;
    this.airJumpsRemaining = PLAYER_AIR_JUMPS;
    this.respawnRemaining = RESPAWN_DELAY_SECONDS;
    this.respawnProtectionSeconds = RESPAWN_PROTECTION_SECONDS;
    this.respawnUsesCheckpointProvider = true;
    this.action = 'respawn';
    this.body.velocity.setZero();
    this.body.angularVelocity.setZero();
    this.body.collisionResponse = false;
    this.model.setVisible(false);
    this.events.push({ type: 'crash', reason });
  }

  /**
   * Starts or replaces a respawn commanded by the server. It intentionally
   * emits no crash event, preventing a second respawn request and score penalty.
   * delaySeconds and protectionSeconds should be derived from the authoritative
   * respawnAt/protectedUntil timestamps by the caller.
   */
  startAuthoritativeRespawn(
    position: THREE.Vector3,
    checkpointIndex: number,
    delaySeconds = 0,
    protectionSeconds = RESPAWN_PROTECTION_SECONDS,
  ): void {
    this.setAuthoritativeCheckpoint(position, checkpointIndex);
    this.releaseGrapple('respawn');
    this.currentRail = null;
    this.wallSide = 0;
    this.wallRunTime = 0;
    this.respawning = true;
    this.airJumpsRemaining = PLAYER_AIR_JUMPS;
    this.respawnRemaining = THREE.MathUtils.clamp(
      Number.isFinite(delaySeconds) ? delaySeconds : 0,
      0,
      10,
    );
    this.respawnProtectionSeconds = THREE.MathUtils.clamp(
      Number.isFinite(protectionSeconds) ? protectionSeconds : 0,
      0,
      10,
    );
    this.respawnUsesCheckpointProvider = false;
    this.action = 'respawn';
    this.body.velocity.setZero();
    this.body.angularVelocity.setZero();
    this.body.collisionResponse = false;
    this.model.setVisible(false);
  }

  private updateRespawn(
    dt: number,
    elapsed: number,
    input: Required<PlayerInputState>,
  ): void {
    this.respawnRemaining -= dt;
    this.body.velocity.setZero();
    if (this.respawnRemaining <= 0) {
      if (this.respawnUsesCheckpointProvider) {
        const providerPosition = this.checkpointProvider?.();
        if (providerPosition !== undefined) {
          this.checkpointPosition.copy(providerPosition);
        }
      }
      this.teleport(this.checkpointPosition, new THREE.Vector3(0, 0, this.baseRunSpeed * 0.4));
      this.body.collisionResponse = true;
      this.respawning = false;
      this.invulnerabilityRemaining = Math.max(
        this.invulnerabilityRemaining,
        this.respawnProtectionSeconds,
      );
      this.respawnProtectionSeconds = RESPAWN_PROTECTION_SECONDS;
      this.respawnUsesCheckpointProvider = true;
      this.dash.reset();
      this.airJumpsRemaining = PLAYER_AIR_JUMPS;
      this.grounded = false;
      this.action = 'fall';
      this.model.setVisible(true);
      this.events.push({ type: 'respawn', checkpoint: this.checkpointIndex });
    }
    this.syncModel(dt, elapsed, input);
  }

  teleport(position: THREE.Vector3, velocity = new THREE.Vector3()): void {
    this.body.position.set(position.x, position.y, position.z);
    this.body.previousPosition.copy(this.body.position);
    this.body.interpolatedPosition.copy(this.body.position);
    this.body.velocity.set(velocity.x, velocity.y, velocity.z);
    this.body.force.setZero();
    this.body.aabbNeedsUpdate = true;
    this.body.wakeUp();
    this.hasCorrection = false;
  }

  applyNetworkCorrection(state: CompactPlayerState): void {
    this.correctionPosition.fromArray(state.p);
    this.correctionVelocity.fromArray(state.v);
    const error = this.correctionPosition.distanceTo(this.position);
    if (error > 7) {
      this.teleport(this.correctionPosition, this.correctionVelocity);
      this.yaw = state.yaw;
      return;
    }
    this.hasCorrection = true;
  }

  private smoothNetworkCorrection(dt: number): void {
    if (!this.hasCorrection) {
      return;
    }
    const positionAlpha = 1 - Math.exp(-5 * dt);
    const velocityAlpha = 1 - Math.exp(-3 * dt);
    this.body.position.x = THREE.MathUtils.lerp(this.body.position.x, this.correctionPosition.x, positionAlpha);
    this.body.position.y = THREE.MathUtils.lerp(this.body.position.y, this.correctionPosition.y, positionAlpha);
    this.body.position.z = THREE.MathUtils.lerp(this.body.position.z, this.correctionPosition.z, positionAlpha);
    this.body.velocity.x = THREE.MathUtils.lerp(this.body.velocity.x, this.correctionVelocity.x, velocityAlpha);
    this.body.velocity.y = THREE.MathUtils.lerp(this.body.velocity.y, this.correctionVelocity.y, velocityAlpha);
    this.body.velocity.z = THREE.MathUtils.lerp(this.body.velocity.z, this.correctionVelocity.z, velocityAlpha);
    if (this.correctionPosition.distanceToSquared(this.position) < 0.01) {
      this.hasCorrection = false;
    }
  }

  drainEvents(): PlayerControllerEvent[] {
    return this.events.splice(0, this.events.length);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.grapple.dispose();
    this.model.dispose();
    this.world.removeBody(this.body);
    this.events.length = 0;
  }
}
