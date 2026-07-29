import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import type { AnchorSystem } from '../world/AnchorSystem';
import type { AnchorRecord } from '../world/types';

export interface GrappleOptions {
  cooldown?: number;
  maximumRange?: number;
  swingAssist?: number;
}

export interface GrappleRelease {
  speed: number;
  clean: boolean;
  reason:
    | 'input'
    | 'obstructed'
    | 'overstretched'
    | 'dash'
    | 'hazard'
    | 'respawn'
    | 'dispose';
  separationNormal?: THREE.Vector3;
}

export class GrappleController {
  readonly line: THREE.Line;
  attachedAnchor: AnchorRecord | null = null;

  private readonly world: CANNON.World;
  private readonly anchorSystem: AnchorSystem;
  private readonly body: CANNON.Body;
  private readonly cooldown: number;
  private readonly maximumRange: number;
  private readonly swingAssist: number;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = new THREE.LineBasicMaterial({
    color: 0x67f6ff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  private readonly positions = new Float32Array(6);
  private readonly anchorBody = new CANNON.Body({ mass: 0, type: CANNON.Body.STATIC });
  private constraint: CANNON.DistanceConstraint | null = null;
  private cooldownRemaining = 0;
  private ropeLength = 0;
  private elapsedAttached = 0;
  private obstructionTime = 0;
  private readonly radial = new THREE.Vector3();
  private readonly desiredForward = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private disposed = false;

  constructor(
    scene: THREE.Scene,
    world: CANNON.World,
    body: CANNON.Body,
    anchorSystem: AnchorSystem,
    options: GrappleOptions = {},
  ) {
    this.world = world;
    this.body = body;
    this.anchorSystem = anchorSystem;
    this.cooldown = options.cooldown ?? 0.18;
    this.maximumRange = options.maximumRange ?? 38;
    this.swingAssist = options.swingAssist ?? 1;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.line = new THREE.Line(this.geometry, this.material);
    this.line.name = 'energy-tether';
    this.line.frustumCulled = false;
    this.line.visible = false;
    scene.add(this.line);
  }

  get attached(): boolean {
    return this.constraint !== null && this.attachedAnchor !== null;
  }

  tryAttach(position: THREE.Vector3, velocity: THREE.Vector3): AnchorRecord | null {
    if (this.attached || this.cooldownRemaining > 0) {
      return null;
    }
    const anchor = this.anchorSystem.selectTarget(position, velocity, { maxRange: this.maximumRange });
    if (anchor === null || !this.anchorSystem.hasLineOfSight(position, anchor)) {
      return null;
    }
    this.attachedAnchor = anchor;
    this.ropeLength = THREE.MathUtils.clamp(position.distanceTo(anchor.position) * 0.94, 4.5, this.maximumRange);
    this.anchorBody.position.set(anchor.position.x, anchor.position.y, anchor.position.z);
    this.world.addBody(this.anchorBody);
    this.constraint = new CANNON.DistanceConstraint(this.body, this.anchorBody, this.ropeLength, 1e6);
    this.world.addConstraint(this.constraint);
    this.elapsedAttached = 0;
    this.obstructionTime = 0;
    this.line.visible = true;
    this.material.opacity = 0.9;
    return anchor;
  }

  update(
    dt: number,
    elapsed: number,
    handPosition: THREE.Vector3,
    forwardInfluence: number,
    steer: number,
  ): GrappleRelease | null {
    this.cooldownRemaining = Math.max(0, this.cooldownRemaining - dt);
    if (!this.attached || this.attachedAnchor === null) {
      this.line.visible = false;
      return null;
    }
    this.elapsedAttached += dt;
    const anchor = this.attachedAnchor.position;
    this.positions[0] = handPosition.x;
    this.positions[1] = handPosition.y;
    this.positions[2] = handPosition.z;
    this.positions[3] = anchor.x;
    this.positions[4] = anchor.y;
    this.positions[5] = anchor.z;
    this.geometry.getAttribute('position').needsUpdate = true;
    this.material.opacity = 0.68 + Math.sin(elapsed * 14) * 0.2;
    this.material.color.setHSL((0.51 + elapsed * 0.025) % 1, 0.95, 0.7);

    const obstruction = this.anchorSystem.getLineObstruction(
      handPosition,
      this.attachedAnchor,
    );
    if (obstruction !== null && this.elapsedAttached > 0.06) {
      this.obstructionTime += dt;
      if (this.obstructionTime >= 0.025) {
        return this.detach('obstructed', obstruction.normal);
      }
    } else {
      this.obstructionTime = 0;
    }

    this.radial.set(
      this.body.position.x - anchor.x,
      this.body.position.y - anchor.y,
      this.body.position.z - anchor.z,
    );
    const radialDistance = this.radial.length();
    if (radialDistance < 0.22) {
      return null;
    }
    this.radial.multiplyScalar(1 / radialDistance);
    if (radialDistance > Math.max(this.ropeLength * 1.32, this.ropeLength + 3.2)) {
      return this.detach('overstretched', this.radial);
    }
    this.desiredForward.set(steer * 0.25, 0, 1).normalize();
    this.tangent
      .copy(this.desiredForward)
      .addScaledVector(this.radial, -this.desiredForward.dot(this.radial));
    if (this.tangent.lengthSq() > 0.01) {
      this.tangent.normalize();
      const pump = 1 + Math.max(0, forwardInfluence) * 0.6;
      this.body.applyForce(
        new CANNON.Vec3(
          this.tangent.x * this.body.mass * 11 * pump * this.swingAssist,
          this.tangent.y * this.body.mass * 11 * pump * this.swingAssist,
          this.tangent.z * this.body.mass * 11 * pump * this.swingAssist,
        ),
      );
    }

    // Remove only extreme outward radial velocity. Tangential momentum is
    // deliberately untouched, so release feels clean.
    const outward =
      this.body.velocity.x * this.radial.x +
      this.body.velocity.y * this.radial.y +
      this.body.velocity.z * this.radial.z;
    if (outward > 7) {
      const trim = (outward - 7) * 0.7;
      this.body.velocity.x -= this.radial.x * trim;
      this.body.velocity.y -= this.radial.y * trim;
      this.body.velocity.z -= this.radial.z * trim;
    }
    return null;
  }

  detach(
    reason: GrappleRelease['reason'] = 'input',
    separationNormal?: THREE.Vector3,
  ): GrappleRelease | null {
    if (!this.attached) {
      return null;
    }
    const speed = this.body.velocity.length();
    const clean = reason === 'input' && speed >= 17 && this.elapsedAttached >= 0.35;
    if (this.constraint !== null) {
      this.world.removeConstraint(this.constraint);
    }
    this.world.removeBody(this.anchorBody);
    this.constraint = null;
    this.attachedAnchor = null;
    this.cooldownRemaining = this.cooldown;
    this.line.visible = false;
    this.anchorSystem.clearSelection();
    return {
      speed,
      clean,
      reason,
      ...(separationNormal === undefined
        ? {}
        : { separationNormal: separationNormal.clone().normalize() }),
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detach('dispose');
    this.line.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
