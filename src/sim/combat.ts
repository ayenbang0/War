/**
 * Combat resolution.
 *
 * SIMULTANEITY IS THE WHOLE DESIGN. Damage is gathered into a buffer across
 * every soldier on both sides, and only then applied. Resolving in index order
 * and removing the dead as you go would let player 0's soldiers -- who hold the
 * lower indices, because they spawned first -- always strike before player 1's
 * in a mutual engagement, and win every coin-flip trade. Nothing would catch
 * that: the result is perfectly deterministic and reproducible, just silently
 * unfair. Two soldiers who kill each other in the same tick both die.
 *
 * Target selection splits by reach. Melee uses the soldier spatial hash, whose
 * cells are sized for separation distances. Ranged does NOT: an archer reaching
 * 250 world units through a 14-unit grid would sweep hundreds of cells per
 * soldier per tick, so ranged squads pick an enemy SQUAD first and only then
 * drill into its soldiers.
 */

import { cos, max, min, sin, sqrt } from "./math.ts";
import { TERRAIN_INFO, type TerrainGrid } from "./terrain.ts";
import type { Rng } from "./rng.ts";

/** Reach at or below this counts as hand-to-hand. */
export const MELEE_RANGE = 26;

/** Damage spread, as a fraction either side of the nominal value. */
const DAMAGE_VARIANCE = 0.22;

/**
 * Defence is a soak, not a percentage, so heavy armour never reaches immunity.
 * A defence equal to this value halves incoming damage.
 */
const DEFENCE_SCALE = 110;

/** Damage one hit lands, after armour, cover and a little variance. */
export function hitDamage(
  rng: Rng,
  attack: number,
  defence: number,
  cover: number,
  terrain: TerrainGrid,
  tx: number,
  ty: number,
): number {
  const soak = DEFENCE_SCALE / (DEFENCE_SCALE + max(0, defence));
  const groundCover = TERRAIN_INFO[terrain.typeAtWorld(tx, ty)].cover;
  const shelter = 1 - min(0.8, cover + groundCover);
  const spread = 1 + (rng.nextFloat() * 2 - 1) * DAMAGE_VARIANCE;
  return attack * soak * shelter * spread;
}

/** Squared distance, kept inline-cheap for the hot loops. */
export function d2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/**
 * Pick one soldier from a target squad for a given attacker.
 *
 * Spread by attacker index rather than always nearest -- a whole rank
 * converging on one man wastes most of the volley -- but spread across only a
 * QUARTER of the target squad, not all of it. Spreading evenly over twenty men
 * dilutes a volley so thoroughly that everyone sits at partial health forever
 * and nobody ever falls. Real volleys concentrate.
 *
 * Deterministic: arithmetic on indices, not a roll.
 */
export function spreadTarget(
  attackerIndex: number,
  first: number,
  count: number,
  alive: Uint8Array,
): number {
  let living = 0;
  for (let i = 0; i < count; i++) if (alive[first + i] === 1) living++;
  if (living === 0) return -1;
  const focus = max(1, (living / 4) | 0);
  const pick = attackerIndex % focus;
  let seen = 0;
  for (let i = 0; i < count; i++) {
    if (alive[first + i] !== 1) continue;
    if (seen === pick) return first + i;
    seen++;
  }
  return -1;
}

/** Nearest living enemy soldier in a squad, ties broken on index. */
export function nearestInSquad(
  x: number,
  y: number,
  first: number,
  count: number,
  alive: Uint8Array,
  sx: Float64Array,
  sy: Float64Array,
  maxDist: number,
): number {
  let best = -1;
  let bestD = maxDist * maxDist;
  for (let i = 0; i < count; i++) {
    const id = first + i;
    if (alive[id] !== 1) continue;
    const dd = d2(x, y, sx[id], sy[id]);
    if (dd < bestD) {
      bestD = dd;
      best = id;
    }
  }
  return best;
}

/** True when the attacker is striking the target from behind or the flank. */
export function isFlanking(targetFacing: number, ax: number, ay: number, tx: number, ty: number): boolean {
  const dx = ax - tx;
  const dy = ay - ty;
  const len = sqrt(dx * dx + dy * dy);
  if (len < 1e-6) return false;
  // Dot of the target's facing with the direction the blow comes from.
  const fx = cos(targetFacing);
  const fy = sin(targetFacing);
  return (fx * dx + fy * dy) / len < 0.31; // outside a ~72-degree frontal arc
}
