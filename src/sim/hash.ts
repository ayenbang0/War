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
import type { World } from "./world.ts";
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
  h = mixU32(h, world.units.length);

  for (const u of world.units) {
    h = mixU32(h, u.id);
    h = mixU32(h, u.player);
    h = mixF64(h, u.x);
    h = mixF64(h, u.y);
    h = mixF64(h, u.facing);
    h = mixF64(h, u.strength);
    h = mixF64(h, u.morale);
    h = mixU32(h, u.path.length);
    for (const p of u.path) h = mixF64(h, p);
  }

  for (const rng of [world.rng.combat, world.rng.morale, world.rng.ai, world.rng.spawn]) {
    const s = rng.snapshot();
    h = mixU32(h, s.a);
    h = mixU32(h, s.b);
    h = mixU32(h, s.c);
    h = mixU32(h, s.d);
  }

  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Fingerprint of the terrain generator's output alone.
 *
 * Deliberately separate from the world hash. World state is *expected* to change
 * as phases add movement, combat and morale, so its golden gets regenerated
 * often -- which would train everyone to regenerate reflexively. Terrain
 * generation is not expected to change, so a move here is unambiguously a bug
 * (or a deliberate, loud generator change) rather than routine drift.
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
 * Fingerprint of a PRNG stream's first `pulls` outputs. Consumes the generator,
 * so pass a freshly created one. Like hashTerrain, this must never change: it
 * pins the arithmetic in rng.ts independently of any gameplay system, so a
 * Phase 10 desync can be attributed to the right layer.
 */
export function hashRngStream(rng: Rng, pulls: number): string {
  let h = FNV_OFFSET | 0;
  for (let i = 0; i < pulls; i++) h = mixU32(h, rng.nextU32());
  return (h >>> 0).toString(16).padStart(8, "0");
}
