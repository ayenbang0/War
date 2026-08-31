/**
 * The one place anything in the simulation is allowed to change position.
 *
 * Both movement integrators go through here: the squad anchor following its
 * route, and individual soldiers steering toward their formation slots. That is
 * deliberate. The rule that a mover may never advance more than half a tile
 * without re-testing the ground beneath it (see CLAUDE.md) was originally
 * written into squad movement only; soldier steering is a second integrator and
 * the obvious way to write it -- position += velocity * dt -- silently
 * reintroduces the same river-crossing bug one layer down. Sharing the function
 * makes that impossible.
 */

import { min, sqrt } from "./math.ts";
import { TERRAIN_INFO, TILE_SIZE, type TerrainGrid } from "./terrain.ts";

/** No single sub-step may exceed half a tile. */
const MAX_SUBSTEP = TILE_SIZE * 0.5;

/** Distance below which two points count as coincident. */
export const EPS = 1e-9;

export type MoveResult = {
  x: number;
  y: number;
  /** Distance actually travelled. */
  travelled: number;
  /** True if impassable terrain stopped the mover short. */
  blocked: boolean;
  /** True if the target was reached. */
  reached: boolean;
};

const result: MoveResult = { x: 0, y: 0, travelled: 0, blocked: false, reached: false };

/**
 * Advance from (x, y) toward (tx, ty) by at most budget world units, in
 * increments capped at MAX_SUBSTEP, testing terrain at every landing point.
 *
 * Returns a shared mutable object -- read the fields before calling again.
 * Allocating a result per soldier per tick would mean ~600 objects per tick.
 */
export function advanceToward(
  terrain: TerrainGrid,
  x: number,
  y: number,
  tx: number,
  ty: number,
  budget: number,
): MoveResult {
  result.x = x;
  result.y = y;
  result.travelled = 0;
  result.blocked = false;
  result.reached = false;

  if (budget <= EPS) return result;

  let remaining = budget;
  while (remaining > EPS) {
    const dx = tx - result.x;
    const dy = ty - result.y;
    const d = sqrt(dx * dx + dy * dy);
    if (d <= EPS) {
      result.reached = true;
      return result;
    }
    const stepLen = min(remaining, d, MAX_SUBSTEP);
    const t = stepLen / d;
    const nx = result.x + dx * t;
    const ny = result.y + dy * t;

    if (TERRAIN_INFO[terrain.typeAtWorld(nx, ny)].moveScale <= 0) {
      result.blocked = true;
      return result;
    }

    result.x = nx;
    result.y = ny;
    result.travelled += stepLen;
    remaining -= stepLen;
    if (stepLen >= d - EPS) {
      result.reached = true;
      return result;
    }
  }
  return result;
}
