import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import type { CourseLayout, PlatformRecord, RailRecord } from './types';

const UP = new THREE.Vector3(0, 1, 0);
const COLLISION_SKIN = 0.09;

function copyToCannon(target: CANNON.Vec3, source: THREE.Vector3): void {
  target.set(source.x, source.y, source.z);
}

export class ChunkManager {
  readonly group = new THREE.Group();
  readonly platforms: PlatformRecord[] = [];
  readonly rails: RailRecord[] = [];
  readonly collidables: THREE.Object3D[] = [];

  private readonly world: CANNON.World;
  private readonly boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly railGeometry = new THREE.CylinderGeometry(0.13, 0.13, 1, 8);
  private readonly materials = new Map<number, THREE.MeshStandardMaterial>();
  private readonly edgeMaterials = new Map<number, THREE.LineBasicMaterial>();
  private readonly edgeGeometry = new THREE.EdgesGeometry(this.boxGeometry);
  private readonly chunkRanges = new Map<number, { start: number; end: number }>();
  private readonly platformsByChunk = new Map<number, PlatformRecord[]>();
  private readonly railsByChunk = new Map<number, RailRecord[]>();
  private readonly chunkVisibility = new Map<number, boolean>();
  private readonly previousPlatformPosition = new THREE.Vector3();
  private readonly nextPlatformPosition = new THREE.Vector3();
  private disposed = false;

  constructor(scene: THREE.Scene, world: CANNON.World, layout: CourseLayout) {
    this.world = world;
    this.group.name = 'race-course';
    scene.add(this.group);
    for (const chunk of layout.chunks) {
      this.chunkRanges.set(chunk.index, { start: chunk.startZ, end: chunk.endZ });
      this.chunkVisibility.set(chunk.index, true);
    }
    this.buildPlatforms(layout);
    this.buildRails(layout);
  }

  private material(color: number): THREE.MeshStandardMaterial {
    let material = this.materials.get(color);
    if (material === undefined) {
      material = new THREE.MeshStandardMaterial({
        color: 0x081126,
        emissive: color,
        emissiveIntensity: 0.22,
        roughness: 0.72,
        metalness: 0.44,
      });
      this.materials.set(color, material);
    }
    return material;
  }

  private edgeMaterial(color: number): THREE.LineBasicMaterial {
    let material = this.edgeMaterials.get(color);
    if (material === undefined) {
      material = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.86,
        toneMapped: false,
      });
      this.edgeMaterials.set(color, material);
    }
    return material;
  }

  private buildPlatforms(layout: CourseLayout): void {
    for (const spec of layout.platforms) {
      const mesh = new THREE.Mesh(this.boxGeometry, this.material(spec.neon));
      mesh.name = spec.id;
      mesh.position.fromArray(spec.position);
      mesh.scale.fromArray(spec.size);
      mesh.receiveShadow = true;
      mesh.castShadow = spec.kind === 'wall';
      mesh.userData.platformId = spec.id;
      mesh.userData.grindable = spec.kind === 'roof';

      const outline = new THREE.LineSegments(this.edgeGeometry, this.edgeMaterial(spec.neon));
      outline.scale.setScalar(1.002);
      outline.renderOrder = 2;
      mesh.add(outline);
      this.group.add(mesh);
      this.collidables.push(mesh);

      // A small invisible skin closes numerical seams between neighbouring
      // rooftops and makes thin edges reliable at dash/swing speed.
      const half = new CANNON.Vec3(
        spec.size[0] / 2 + COLLISION_SKIN,
        spec.size[1] / 2 + COLLISION_SKIN,
        spec.size[2] / 2 + COLLISION_SKIN,
      );
      const body = new CANNON.Body({
        mass: 0,
        type: spec.movement === undefined ? CANNON.Body.STATIC : CANNON.Body.KINEMATIC,
        shape: new CANNON.Box(half),
        material: new CANNON.Material({ friction: 0, restitution: 0 }),
      });
      body.position.set(spec.position[0], spec.position[1], spec.position[2]);
      const taggedBody = body as CANNON.Body & {
        userData?: {
          platformId: string;
          kind: string;
          collisionSkin: number;
        };
      };
      taggedBody.userData = {
        platformId: spec.id,
        kind: spec.kind ?? 'roof',
        collisionSkin: COLLISION_SKIN,
      };
      body.updateAABB();
      this.world.addBody(body);

      const record: PlatformRecord = {
        spec,
        mesh,
        body,
        originalPosition: mesh.position.clone(),
      };
      this.platforms.push(record);
      const chunkPlatforms = this.platformsByChunk.get(spec.chunk);
      if (chunkPlatforms === undefined) {
        this.platformsByChunk.set(spec.chunk, [record]);
      } else {
        chunkPlatforms.push(record);
      }
    }
  }

  private buildRails(layout: CourseLayout): void {
    for (const spec of layout.rails) {
      const start = new THREE.Vector3().fromArray(spec.start);
      const end = new THREE.Vector3().fromArray(spec.end);
      const center = start.clone().add(end).multiplyScalar(0.5);
      const direction = end.clone().sub(start);
      const length = direction.length();
      const mesh = new THREE.Mesh(this.railGeometry, this.material(spec.neon));
      mesh.name = spec.id;
      mesh.position.copy(center);
      mesh.scale.set(1, length, 1);
      mesh.quaternion.setFromUnitVectors(UP, direction.normalize());
      mesh.userData.railId = spec.id;
      mesh.userData.grindable = true;
      this.group.add(mesh);
      const record: RailRecord = { spec, mesh, start, end };
      this.rails.push(record);
      const chunk = Number(spec.id.split('-')[1]);
      if (Number.isFinite(chunk)) {
        const chunkRails = this.railsByChunk.get(chunk);
        if (chunkRails === undefined) {
          this.railsByChunk.set(chunk, [record]);
        } else {
          chunkRails.push(record);
        }
      }
    }
  }

  update(elapsed: number, dt = 1 / 60): void {
    const safeDt = Math.max(1 / 240, Math.min(0.1, dt));
    for (const platform of this.platforms) {
      const movement = platform.spec.movement;
      if (movement === undefined) {
        continue;
      }
      const phase = elapsed * ((Math.PI * 2) / movement.period) + movement.phase;
      const offset = Math.sin(phase) * movement.distance;
      this.previousPlatformPosition.copy(platform.mesh.position);
      this.nextPlatformPosition.copy(platform.originalPosition);
      this.nextPlatformPosition[movement.axis] += offset;
      platform.mesh.position.copy(this.nextPlatformPosition);
      const inverseDt = 1 / safeDt;
      platform.body.previousPosition.copy(platform.body.position);
      copyToCannon(platform.body.position, this.nextPlatformPosition);
      platform.body.interpolatedPosition.copy(platform.body.position);
      platform.body.velocity.set(
        (this.nextPlatformPosition.x - this.previousPlatformPosition.x) * inverseDt,
        (this.nextPlatformPosition.y - this.previousPlatformPosition.y) * inverseDt,
        (this.nextPlatformPosition.z - this.previousPlatformPosition.z) * inverseDt,
      );
      platform.body.aabbNeedsUpdate = true;
      platform.body.updateAABB();
      platform.body.wakeUp();
    }
  }

  /**
   * Enables simple chunk recycling for endless-practice experiments. Authored
   * race modes normally keep all chunks because the standard course is small.
   */
  setChunkVisible(chunk: number, visible: boolean): void {
    if (this.chunkVisibility.get(chunk) === visible) {
      return;
    }
    this.chunkVisibility.set(chunk, visible);
    for (const platform of this.platformsByChunk.get(chunk) ?? []) {
      platform.mesh.visible = visible;
      platform.body.collisionFilterMask = visible ? -1 : 0;
    }
    for (const rail of this.railsByChunk.get(chunk) ?? []) {
      rail.mesh.visible = visible;
    }
  }

  /** Disables distant geometry and physics, then restores it as the runner approaches. */
  recycleAround(playerZ: number, keepBehind = 95, keepAhead = 210): void {
    for (const [chunk, range] of this.chunkRanges) {
      const visible = range.end >= playerZ - keepBehind && range.start <= playerZ + keepAhead;
      this.setChunkVisible(chunk, visible);
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const platform of this.platforms) {
      this.world.removeBody(platform.body);
    }
    this.group.removeFromParent();
    this.boxGeometry.dispose();
    this.railGeometry.dispose();
    this.edgeGeometry.dispose();
    for (const material of this.materials.values()) {
      material.dispose();
    }
    for (const material of this.edgeMaterials.values()) {
      material.dispose();
    }
    this.materials.clear();
    this.edgeMaterials.clear();
    this.chunkRanges.clear();
    this.platformsByChunk.clear();
    this.railsByChunk.clear();
    this.chunkVisibility.clear();
    this.platforms.length = 0;
    this.rails.length = 0;
    this.collidables.length = 0;
  }
}
