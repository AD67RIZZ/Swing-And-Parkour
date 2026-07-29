import * as THREE from "three";

export interface CameraTarget {
  position: THREE.Vector3;
  velocity?: THREE.Vector3;
  grappleAnchor?: THREE.Vector3 | null;
}

export class CameraRig {
  private readonly lookAt = new THREE.Vector3();
  private readonly idealPosition = new THREE.Vector3();
  private readonly horizontalVelocity = new THREE.Vector3();
  private readonly rayDirection = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private reducedMotion = false;
  private sensitivity = 1;
  private shake = 0;
  private initialized = false;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    private readonly getObstacles: () => THREE.Object3D[],
  ) {}

  setReducedMotion(enabled: boolean): void {
    this.reducedMotion = enabled;
    if (enabled) {
      this.shake = 0;
    }
  }

  setSensitivity(value: number): void {
    this.sensitivity = THREE.MathUtils.clamp(
      Number.isFinite(value) ? value : 1,
      0.5,
      2,
    );
  }

  /** Alias matching the persisted GameSettings field name. */
  setCameraSensitivity(value: number): void {
    this.setSensitivity(value);
  }

  /**
   * Clears motion carried over from a prior race. With no target, the next
   * update snaps; supplying one positions the camera immediately.
   */
  reset(target?: CameraTarget, overdrive = false): void {
    this.shake = 0;
    this.initialized = false;
    if (target !== undefined) {
      this.snapTo(target, overdrive);
    }
  }

  snapTo(target: CameraTarget, overdrive = false): void {
    const targetFov = this.prepareTarget(target, overdrive);
    this.resolveObstruction();
    this.camera.position.copy(this.idealPosition);
    this.camera.lookAt(this.lookAt);
    this.camera.fov = targetFov;
    this.camera.updateProjectionMatrix();
    this.initialized = true;
  }

  impact(strength: number): void {
    if (!this.reducedMotion) this.shake = Math.max(this.shake, Math.min(strength, 0.45));
  }

  update(target: CameraTarget, dt: number, overdrive = false): void {
    const targetFov = this.prepareTarget(target, overdrive);
    this.resolveObstruction();
    if (
      !this.initialized ||
      this.camera.position.distanceToSquared(this.idealPosition) > 35 * 35
    ) {
      this.camera.position.copy(this.idealPosition);
      this.camera.fov = targetFov;
      this.initialized = true;
    } else {
      const responseRate =
        (this.reducedMotion ? 14 : 8) * this.sensitivity;
      const smoothing =
        1 - Math.exp(-Math.max(0, Math.min(0.1, dt)) * responseRate);
      this.camera.position.lerp(this.idealPosition, smoothing);
      this.camera.fov += (targetFov - this.camera.fov) * smoothing;
    }

    if (this.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.5;
      this.shake *= Math.exp(-Math.max(0, dt) * 11);
    }
    this.camera.lookAt(this.lookAt);
    this.camera.updateProjectionMatrix();
  }

  private prepareTarget(target: CameraTarget, overdrive: boolean): number {
    const speed = target.velocity?.length() ?? 0;
    if (target.velocity === undefined) {
      this.horizontalVelocity.set(0, 0, 1);
    } else {
      this.horizontalVelocity.copy(target.velocity).setY(0);
      if (this.horizontalVelocity.lengthSq() < 0.01) {
        this.horizontalVelocity.set(0, 0, 1);
      }
      this.horizontalVelocity.normalize();
    }

    const pullBack = target.grappleAnchor ? 2 : 0;
    this.idealPosition
      .copy(target.position)
      .addScaledVector(
        this.horizontalVelocity,
        -(10 + pullBack + Math.min(speed * 0.09, 4)),
      );
    this.idealPosition.y += 5.8;
    this.lookAt
      .copy(target.position)
      .addScaledVector(
        this.horizontalVelocity,
        7 + Math.min(speed * 0.2, 6),
      );
    this.lookAt.y += 1.5;

    const motionScale = this.reducedMotion ? 0.25 : 1;
    return (
      68 +
      (Math.min(speed * 0.16, 8) + (overdrive ? 7 : 0)) * motionScale
    );
  }

  private resolveObstruction(): void {
    this.rayDirection.copy(this.idealPosition).sub(this.lookAt);
    const rayLength = this.rayDirection.length();
    if (rayLength <= 0.001) {
      return;
    }
    this.rayDirection.multiplyScalar(1 / rayLength);
    this.raycaster.set(this.lookAt, this.rayDirection);
    const obstruction = this.raycaster
      .intersectObjects(this.getObstacles(), false)
      .find((hit) => hit.distance < rayLength);
    if (obstruction !== undefined) {
      this.idealPosition
        .copy(this.lookAt)
        .addScaledVector(
          this.rayDirection,
          Math.max(1.6, obstruction.distance - 0.7),
        );
    }
  }
}
