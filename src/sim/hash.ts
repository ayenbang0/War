/**
 * A 32-bit fingerprint of the entire world state.
 *
 * This is the whole regression suite. Because the sim is deterministic, a
 * recorded order log replayed from the same seed must reproduce the same hash
 * at the same tick -- on any machine, in any browser, forever. Any change to
 * physics, ordering, or arithmetic that was not intended will move the hash.
 * In Phase 10 the same function detects netplay desync between peers.
 *
 * Floats are hashed by their exact bit pattern, which is only meaningful
 * because the determinism rules in CLAUDE.md guarantee bit-equality.
 */

import { imul } from "./math.ts";
import { STANCES, type World } from "./world.ts";
import { FORMATION_SHAPES } from "./formations.ts";
import type { TerrainGrid } from "./terrain.ts";
import type { Rng } from "./rng.ts";

const scratch = new DataView(new ArrayBuffer(8));

const FNV_PRIME = 0x01000193;
const FNV_OFFSET = 0x811c9dc5;

function mixU32(h: number, v: number): number {
  let x = h ^ (v & 0xff);
  x = imul(x, FNV_PRIME);
  x ^= (v >>> 8) & 0xff;
  x = imul(x, FNV_PRIME);
  x ^= (v >>> 16) & 0xff;
  x = imul(x, FNV_PRIME);
  x ^= (v >>> 24) & 0xff;
  x = imul(x, FNV_PRIME);
  return x | 0;
}

function mixF64(h: number, v: number): number {
  scratch.setFloat64(0, v, true);
  return mixU32(mixU32(h, scratch.getUint32(0, true)), scratch.getUint32(4, true));
}

export function hashWorld(world: World): string {
  let h = FNV_OFFSET | 0;
  h = mixU32(h, world.tick);
  h = mixU32(h, world.seed);
  h = mixU32(h, world.terrain.revision);
  h = mixU32(h, world.squads.length);

  for (const q of world.squads) {
    h = mixU32(h, q.id);
    h = mixU32(h, q.player);
    h = mixF64(h, q.anchorX);
    h = mixF64(h, q.anchorY);
    h = mixF64(h, q.facing);
    h = mixF64(h, q.morale);
    h = mixU32(h, q.target);
    h = mixU32(h, q.path.length);
    for (const p of q.path) h = mixF64(h, p);

    // Orders and intent, not just position. Two worlds can hold identical
    // positions while one squad is outbound on patrol leg 3 and the other is
    // inbound on the same leg -- they only separate seconds later. Hashing
    // enum state and leg counters catches that divergence at the tick it
    // happens, which is what a desync detector is for.
    h = mixU32(h, STANCES.indexOf(q.stance));
    h = mixU32(h, FORMATION_SHAPES.indexOf(q.shape));
    h = mixF64(h, q.holdX);
    h = mixF64(h, q.holdY);
    h = mixF64(h, q.holdRadius);
    h = mixU32(h, q.patrolLeg);
    h = mixU32(h, q.patrolForward ? 1 : 0);
    h = mixU32(h, q.patrol.length);
    for (const p of q.patrol) h = mixF64(h, p);
  }

  // Soldiers are the bulk of the state and the thing most likely to drift, so
  // they are hashed individually rather than via a squad-level summary.
  const s = world.soldiers;
  h = mixU32(h, s.count);
  for (let i = 0; i < s.count; i++) {
    h = mixU32(h, s.alive[i]);
    if (s.alive[i] !== 1) continue;
    h = mixU32(h, s.slot[i]);
    h = mixF64(h, s.x[i]);
    h = mixF64(h, s.y[i]);
    h = mixF64(h, s.facing[i]);
    h = mixF64(h, s.hp[i]);
  }

  for (const rng of [world.rng.combat, world.rng.morale, world.rng.ai, world.rng.spawn]) {
    const st = rng.snapshot();
    h = mixU32(h, st.a);
    h = mixU32(h, st.b);
    h = mixU32(h, st.c);
    h = mixU32(h, st.d);
  }

  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Fingerprint of the terrain generator's output alone.
 *
 * Deliberately separate from the world hash. World state is expected to change
 * as phases add movement, combat and morale, so its golden gets regenerated
 * often -- which would train everyone to regenerate reflexively. Terrain
 * generation is not expected to change, so a move here is unambiguously a bug
 * rather than routine drift.
 */
export function hashTerrain(grid: TerrainGrid): string {
  let h = FNV_OFFSET | 0;
  h = mixU32(h, grid.width);
  h = mixU32(h, grid.height);
  h = mixU32(h, grid.revision);
  for (let i = 0; i < grid.type.length; i++) h = mixU32(h, grid.type[i]);
  for (let i = 0; i < grid.elevation.length; i++) h = mixU32(h, grid.elevation[i]);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Fingerprint of a PRNG stream's first pulls outputs. Consumes the generator,
 * so pass a freshly created one.
 */
export function hashRngStream(rng: Rng, pulls: number): string {
  let h = FNV_OFFSET | 0;
  for (let i = 0; i < pulls; i++) h = mixU32(h, rng.nextU32());
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Fingerprint of a set of route results. Pins pathfinding independently. */
export function hashPaths(paths: readonly (readonly number[])[]): string {
  let h = FNV_OFFSET | 0;
  for (const p of paths) {
    h = mixU32(h, p.length);
    for (const v of p) h = mixF64(h, v);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
