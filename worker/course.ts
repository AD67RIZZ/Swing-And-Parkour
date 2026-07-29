import type { CourseDescriptor, Vec3 } from "./protocol";
import { generateCourseLayout } from "../src/world/ChunkPatterns";

export interface CheckpointGate {
  position: Vec3;
  respawn: Vec3;
  width: number;
}

// These identifiers and distances mirror the authored standard multiplayer
// course in src/world/ChunkPatterns.ts. The seed varies route sides, moving
// platform phases, rewards and hazards while preserving safe connections.
const STANDARD_CHUNK_KINDS = [
  "beginner",
  "grapple",
  "split",
  "curved",
  "wall-run",
  "grapple",
  "rail",
  "moving",
  "hazard",
  "grapple",
  "split",
  "curved",
  "wall-run",
  "rail",
  "moving",
  "hazard",
  "split",
  "grapple",
  "curved",
  "wall-run",
  "rail",
  "moving",
  "hazard",
  "grapple",
  "curved",
  "split",
  "wall-run",
  "moving",
  "rail",
  "hazard",
  "split",
  "grapple",
  "wall-run",
  "curved",
  "rail",
  "moving",
  "hazard",
  "grapple",
  "split",
  "curved",
  "wall-run",
  "moving",
  "rail",
  "hazard",
  "grapple",
  "split",
  "moving",
  "hazard",
  "final",
] as const;

const STANDARD_CHUNKS = STANDARD_CHUNK_KINDS.map(
  (kind, index) => `chunk-${index}-${kind}`,
);

// Browser motion distance is measured from spawn z=2. These correspond to the
// 0-based checkpoint specs in the deterministic 49-chunk standard layout.
const CHECKPOINT_DISTANCES = [
  0, 150, 411, 566, 775, 878, 1_139, 1_346, 1_451, 1_606, 1_867, 2_022,
  2_179, 2_386, 2_439, 2_540,
];
const TOTAL_DISTANCE = 2_542;
const MAX_CACHED_LAYOUTS = 16;
const layoutCache = new Map<
  number,
  ReturnType<typeof generateCourseLayout>
>();

function layoutFor(course: CourseDescriptor): ReturnType<typeof generateCourseLayout> {
  const cached = layoutCache.get(course.seed);
  if (cached) {
    // Refresh insertion order so active matches remain in the bounded cache.
    layoutCache.delete(course.seed);
    layoutCache.set(course.seed, cached);
    return cached;
  }

  const layout = generateCourseLayout(course.seed, "multiplayer", "standard");
  layoutCache.set(course.seed, layout);
  if (layoutCache.size > MAX_CACHED_LAYOUTS) {
    const oldest = layoutCache.keys().next().value;
    if (oldest !== undefined) layoutCache.delete(oldest);
  }
  return layout;
}

function vec3(tuple: readonly [number, number, number]): Vec3 {
  return { x: tuple[0], y: tuple[1], z: tuple[2] };
}

function randomUint32(): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] ?? 1;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let result = state;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function createCourse(now = Date.now()): CourseDescriptor {
  const seed = randomUint32();
  const random = mulberry32(seed);

  return {
    seed,
    chunkIds: [...STANDARD_CHUNKS],
    checkpointDistances: [...CHECKPOINT_DISTANCES],
    totalDistance: TOTAL_DISTANCE,
    // Clients derive all periodic hazard phases from this shared epoch.
    hazardEpoch: now + 4_000 + Math.floor(random() * 2_000),
  };
}

export function checkpointPosition(
  course: CourseDescriptor,
  checkpointIndex: number,
): Vec3 {
  if (checkpointIndex < 0) return { x: 0, y: 32.25, z: 2 };
  const authored = checkpointGate(course, checkpointIndex);
  if (authored) return authored.respawn;
  const distance = course.checkpointDistances[checkpointIndex] ?? 0;
  // Authored respawn points sit four world units behind checkpoint gates.
  return { x: 0, y: 32.2, z: distance - 2 };
}

/** Exact deterministic gate geometry shared with the browser course builder. */
export function checkpointGate(
  course: CourseDescriptor,
  checkpointIndex: number,
): CheckpointGate | null {
  const checkpoint = layoutFor(course).checkpoints.find(
    (entry) => entry.index === checkpointIndex,
  );
  return checkpoint
    ? {
        position: vec3(checkpoint.position),
        respawn: vec3(checkpoint.respawn),
        width: checkpoint.width,
      }
    : null;
}

/** Exact authored position for collectible/destructible gameplay evidence. */
export function gameplayObjectPosition(
  course: CourseDescriptor,
  event: "shard" | "drone",
  objectId: string,
): Vec3 | null {
  const layout = layoutFor(course);
  const object =
    event === "shard"
      ? layout.shards.find((entry) => entry.id === objectId)
      : layout.hazards.find(
          (entry) => entry.kind === "drone" && entry.id === objectId,
        );
  return object ? vec3(object.position) : null;
}
