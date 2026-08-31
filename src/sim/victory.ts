/**
 * Win conditions.
 *
 * The chosen condition is global-morale rout, with the 15-minute timer as a
 * tiebreak (see PLAN.md). Rout is an instant loss the moment an army's
 * strength-weighted morale falls below the threshold.
 *
 * THE TURTLING PROBLEM. "Higher morale at the timer" on its own rewards doing
 * nothing: an army that hides in a corner takes no casualties and keeps perfect
 * morale. The tiebreak therefore scores morale PLUS the share of the enemy army
 * destroyed. Rout stays exactly as chosen -- this only decides matches that
 * reach full time, where an army that inflicted nothing has earned nothing.
 * Phase 9 makes the whole condition swappable per level.
 */

import { ROUT_THRESHOLD } from "./morale.ts";

/**
 * How much destroying the enemy counts for, relative to holding morale.
 *
 * Weighted equal to morale on purpose. Morale only ever falls through fighting,
 * so any weight low enough to be "a tiebreak nudge" leaves not fighting as the
 * dominant strategy. At parity, wiping out the enemy is worth exactly as much
 * as ending the match untroubled, and an army that inflicted nothing scores its
 * morale and nothing else.
 */
const AGGRESSION_WEIGHT = 1.0;

export type ArmyState = {
  readonly morale: number;
  /** Living soldiers. */
  readonly strength: number;
  /** Full-strength roster at deployment. */
  readonly roster: number;
};

export type Outcome = {
  readonly winner: number;
  readonly reason: "rout" | "annihilated" | "timer";
  readonly detail: string;
};

/** Timer score for one army: morale held, plus enemy destroyed. */
export function score(own: ArmyState, foe: ArmyState): number {
  const destroyed = foe.roster > 0 ? 1 - foe.strength / foe.roster : 0;
  return own.morale + AGGRESSION_WEIGHT * destroyed;
}

/**
 * Evaluate the match. Returns null while it is still running.
 * `elapsed` and `duration` are in seconds.
 */
export function evaluate(
  armies: readonly ArmyState[],
  elapsed: number,
  duration: number,
): Outcome | null {
  const [a, b] = armies;

  const aGone = a.strength === 0;
  const bGone = b.strength === 0;
  if (aGone || bGone) {
    if (aGone && bGone) return { winner: -1, reason: "annihilated", detail: "both armies destroyed" };
    return {
      winner: aGone ? 1 : 0,
      reason: "annihilated",
      detail: "army " + (aGone ? 0 : 1) + " destroyed to the last soldier",
    };
  }

  // Rout is checked before the timer: it ends the match the moment it happens.
  const aBroken = a.morale < ROUT_THRESHOLD;
  const bBroken = b.morale < ROUT_THRESHOLD;
  if (aBroken || bBroken) {
    if (aBroken && bBroken) {
      // Both armies break in the same tick: the steadier one is still standing.
      const winner = a.morale >= b.morale ? 0 : 1;
      return { winner, reason: "rout", detail: "both armies broke; army " + winner + " held longer" };
    }
    return {
      winner: aBroken ? 1 : 0,
      reason: "rout",
      detail: "army " + (aBroken ? 0 : 1) + " routed",
    };
  }

  if (elapsed >= duration) {
    const sa = score(a, b);
    const sb = score(b, a);
    if (sa === sb) return { winner: -1, reason: "timer", detail: "drawn on points" };
    const winner = sa > sb ? 0 : 1;
    return {
      winner,
      reason: "timer",
      detail: "time expired: " + sa.toFixed(3) + " vs " + sb.toFixed(3),
    };
  }

  return null;
}
