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
import { STANCES } from "./entities.ts";
import { FORMATION_SHAPES } from "./formations.ts";
import type { TerrainGrid } from "./terrain.ts";
import type { Rng } from "./rng.ts";

const scratch = new DataView(new ArrayBuffer(8));

const FNV_PRIME = 0x01000193;
/** FNV-1a offset basis; exported so the kingdom and layer hashes start from it too. */
export const FNV_OFFSET = 0x811c9dc5;

export function mixU32(h: number, v: number): number {
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

export function mixF64(h: number, v: number): number {
  scratch.setFloat64(0, v, true);
  return mixU32(mixU32(h, scratch.getUint32(0, true)), scratch.getUint32(4, true));
}

export function hashWorld(world: World): string {
  let h = FNV_OFFSET | 0;
  h = mixU32(h, world.tick);
  h = mixU32(h, world.seed);
  h = mixU32(h, world.terrain.revision);
  h = mixU32(h, world.groups.length);

  // Groups are drawn by the player, so their membership is genuine state: two
  // peers that grouped different men would command different armies.
  for (const g of world.groups) {
    h = mixU32(h, g.id);
    h = mixU32(h, g.player);
    h = mixF64(h, g.anchorX);
    h = mixF64(h, g.anchorY);
    h = mixF64(h, g.facing);
    h = mixU32(h, g.target);
    h = mixU32(h, STANCES.indexOf(g.stance));
    h = mixU32(h, FORMATION_SHAPES.indexOf(g.shape));
    h = mixU32(h, g.recoverUntil);
    h = mixU32(h, g.spellReady);
    h = mixF64(h, g.holdX);
    h = mixF64(h, g.holdY);
    h = mixF64(h, g.holdRadius);
    h = mixU32(h, g.patrolLeg);
    h = mixU32(h, g.patrolForward ? 1 : 0);
    h = mixU32(h, (g.seenBy[0] ? 1 : 0) | (g.seenBy[1] ? 2 : 0));
    h = mixU32(h, g.members.length);
    for (const m of g.members) h = mixU32(h, m);
    h = mixU32(h, g.path.length);
    for (const p of g.path) h = mixF64(h, p);
    h = mixU32(h, g.patrol.length);
    for (const p of g.patrol) h = mixF64(h, p);
    // A route that fell short is an order still pending: where it is for
    // decides where the company goes when a breach opens. Mixed only while it
    // is pending, so a battle with no walls hashes exactly as it always has.
    if (g.routeShort) {
      h = mixU32(h, 0x53484f52);
      h = mixF64(h, g.goalX);
      h = mixF64(h, g.goalY);
    }
  }

  // Soldiers are the bulk of the state and the thing most likely to drift, so
  // they are hashed individually rather than via a squad-level summary.
  // Soldiers are the entities, and the bulk of the state.
  const s = world.soldiers;
  h = mixU32(h, s.count);
  for (let i = 0; i < s.count; i++) {
    h = mixU32(h, s.alive[i]);
    if (s.alive[i] !== 1) continue;
    h = mixU32(h, s.player[i]);
    h = mixU32(h, s.type[i]);
    h = mixU32(h, s.group[i]);
    h = mixU32(h, s.slot[i]);
    h = mixF64(h, s.x[i]);
    h = mixF64(h, s.y[i]);
    h = mixF64(h, s.facing[i]);
    h = mixF64(h, s.hp[i]);
    h = mixF64(h, s.morale[i]);
    h = mixF64(h, s.cooldown[i]);
    h = mixF64(h, s.ammo[i]);
  }

  // Destructible ground: what each tile is, how worn, what is alight and whose
  // works are whose. The revision alone (hashed above) sees only that SOMETHING
  // changed, not wear accumulating toward a collapse two peers might reach a
  // tick apart. Covered from the first moment anything is touched; a battle in
  // which nothing ever is hashes exactly as it did before Phase 8.
  if (world.terrain.dynamic) h = mixTerrainState(h, world.terrain);

  // Workings alter damage and morale, so they are state, not decoration.
  h = mixU32(h, world.workings.length);
  for (const w of world.workings) {
    h = mixU32(h, w.player);
    h = mixU32(h, w.until);
    h = mixF64(h, w.x);
    h = mixF64(h, w.y);
    h = mixF64(h, w.radius);
    h = mixF64(h, w.power);
  }

  // The AI's posture and its memory of where the enemy was decide its future
  // orders, so they are state and must be hashed like any other.
  for (const ai of world.ai) {
    for (const v of ai.snapshot()) h = mixF64(h, v);
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

function mixTerrainState(h: number, t: TerrainGrid): number {
  for (let i = 0; i < t.type.length; i++) {
    h = mixU32(h, t.type[i]);
    if (t.wear[i] !== 0) {
      h = mixU32(h, i);
      h = mixF64(h, t.wear[i]);
    }
    if (t.burn[i] !== 0) h = mixU32(h, (i << 16) ^ t.burn[i]);
    if (t.owner[i] !== -1) h = mixU32(h, i * 4 + t.owner[i]);
  }
  h = mixU32(h, t.burning.length);
  return h;
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
