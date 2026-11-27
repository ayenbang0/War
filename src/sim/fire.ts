/**
 * Fire: woods and timber works that burn, spread and burn out.
 *
 * Deterministic by RULE rather than by stream. Every decision is a pure
 * function of the grid at the start of a fire step, the step number and the
 * battle seed, through `tileRoll` (integer hashing in terrain.ts):
 *
 *   - Fire is stepped every FIRE_INTERVAL ticks, never in between.
 *   - Each burning tile, visited in ascending tile order, loses that many
 *     ticks of fuel.
 *   - Each of its four orthogonal neighbours that burns and is not yet alight
 *     catches with a fixed chance per step, rolled on (neighbour, step, seed).
 *     Ignitions are collected first and applied after the sweep, so a tile lit
 *     this step does not itself spread until the next -- which makes the visit
 *     order irrelevant to the result, not merely fixed.
 *   - A tile whose fuel runs out falls to its burnt form (a wood to a clearing,
 *     a palisade or gate to rubble, a bridge into the river) through the same
 *     mutation path as any other terrain change.
 *
 * No rng stream is touched, so lighting a fire cannot shift a single combat,
 * morale or AI roll, and recorded replays without fire are untouched.
 *
 * Fire stops at anything that does not burn: open ground, roads, water,
 * rubble and stone are firebreaks. A wood burns until it is gone or it reaches
 * one, so it always burns out in finite time.
 */

import { floor } from "./math.ts";
import { STRUCTURE, Terrain, tileRoll, type TerrainGrid, type TerrainType } from "./terrain.ts";

/** Ticks between fire steps: half a second. Fire is slow; this is plenty. */
export const FIRE_INTERVAL = 10;

/**
 * Chance per step that a burning tile sets one burning neighbour alight.
 *
 * Woods catch readily; worked timber (a palisade, a gate, a bridge's planking)
 * less so, because it is not a mass of dry undergrowth. At 0.12 a fire front
 * creeps through a wood at roughly a tile every four seconds -- slow enough to
 * outrun on foot, fast enough to drive a company out of cover.
 */
const SPREAD: Partial<Record<TerrainType, number>> = {
  [Terrain.Forest]: 0.12,
  [Terrain.Palisade]: 0.07,
  [Terrain.Gate]: 0.05,
  [Terrain.GateOpen]: 0.05,
  [Terrain.Bridge]: 0.05,
};

/** Damage per second to a man standing on a burning tile, whoever he is. */
export const FIRE_TILE_DPS = 14;

/** Orthogonal neighbours, in a fixed order. */
const ORTHO = [1, 0, -1, 0, 0, 1, 0, -1];

/**
 * Advance every fire on the grid by one step if this tick is a fire tick.
 * Returns the number of tiles that burnt out (fell) this step.
 */
export function stepFire(grid: TerrainGrid, tick: number, seed: number): number {
  if (grid.burning.length === 0 || tick % FIRE_INTERVAL !== 0) return 0;
  const step = floor(tick / FIRE_INTERVAL);
  // A tile felled or battered down while alight was put out by its mutation;
  // drop it from the list here rather than make every mutation search it.
  for (let k = grid.burning.length - 1; k >= 0; k--) {
    if (grid.burn[grid.burning[k]] === 0) grid.burning.splice(k, 1);
  }
  const lit: number[] = [];
  const out: number[] = [];
  // A snapshot: tiles lit during this step are appended to grid.burning by
  // ignite(), and must neither burn nor spread until the next step.
  const now = grid.burning.slice();
  for (const i of now) {
    if (grid.burn[i] === 0) continue;
    const tx = i % grid.width;
    const ty = (i / grid.width) | 0;
    for (let k = 0; k < ORTHO.length; k += 2) {
      const nx = tx + ORTHO[k];
      const ny = ty + ORTHO[k + 1];
      if (!grid.inBounds(nx, ny)) continue;
      const n = ny * grid.width + nx;
      if (grid.burn[n] > 0) continue;
      const chance = SPREAD[grid.type[n] as TerrainType];
      if (chance === undefined || STRUCTURE[grid.type[n] as TerrainType]?.fuel === undefined) continue;
      if (tileRoll(n, step, seed) < chance) lit.push(n);
    }
    if (grid.burn[i] <= FIRE_INTERVAL) out.push(i);
    else grid.burn[i] -= FIRE_INTERVAL;
  }
  // Burn-outs first, then ignitions: a tile cannot be re-lit by the fire that
  // is consuming it, and a neighbour that just fell is no longer fuel.
  for (const i of out) {
    grid.burnDown(i, FIRE_INTERVAL);
    const at = grid.burning.indexOf(i);
    if (at >= 0) grid.burning.splice(at, 1);
  }
  for (const n of lit) grid.ignite(n % grid.width, (n / grid.width) | 0);
  return out.length;
}

/** Set alight every tile that burns within `radius` world units of a point. */
export function igniteDisc(grid: TerrainGrid, x: number, y: number, radius: number, tileSize: number): number {
  const r = radius / tileSize;
  const cx = x / tileSize;
  const cy = y / tileSize;
  let n = 0;
  const x0 = floor(cx - r);
  const x1 = floor(cx + r);
  const y0 = floor(cy - r);
  const y1 = floor(cy + r);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const dx = tx + 0.5 - cx;
      const dy = ty + 0.5 - cy;
      if (dx * dx + dy * dy > r * r) continue;
      if (grid.ignite(tx, ty)) n++;
    }
  }
  return n;
}
