/**
 * Win conditions, selectable per level (spec section 11.3).
 *
 * Three modes share one rule: ROUT AND ANNIHILATION END THE MATCH IN ALL OF
 * THEM. An army whose nerve breaks has lost regardless of how many flags it was
 * standing on, and a mode that let a broken army win on points would make
 * morale -- the spine of the whole design -- decorative.
 *
 * What the modes change is only how a match that runs its full length is
 * decided.
 */

import { ROUT_THRESHOLD } from "./morale.ts";

/** How much destroying the enemy counts for, relative to holding morale.
 *
 * Weighted equal to morale on purpose. Morale only ever falls through fighting,
 * so any weight low enough to be "a tiebreak nudge" leaves not fighting as the
 * dominant strategy. At parity, wiping out the enemy is worth exactly as much
 * as ending the match untroubled, and an army that inflicted nothing scores its
 * morale and nothing else.
 */
const AGGRESSION_WEIGHT = 1.0;

export type WinMode = "rout" | "objectives" | "points" | "survive" | "breakthrough" | "standard";

/** A place worth standing on. Positions are world units. */
export type ControlPoint = {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
};

export type VictoryConfig =
  /** Break the enemy's nerve. At full time, morale plus damage done decides. */
  | { readonly mode: "rout" }
  /** Hold enough ground for long enough. */
  | {
      readonly mode: "objectives";
      /** Control points a player must hold at once to be accruing. */
      readonly required: number;
      /** Cumulative seconds of holding that wins outright. */
      readonly holdToWin: number;
    }
  /** Accrue points from ground held and enemies killed. */
  | {
      readonly mode: "points";
      readonly perKill: number;
      /** Points per second per control point held. */
      readonly perPointHeld: number;
      /** Total that wins outright. */
      readonly target: number;
    }
  /**
   * Hold out. The defender wins by still being an army at full time; the
   * attacker has to break or destroy it before the clock runs down.
   */
  | { readonly mode: "survive"; readonly defender: number }
  /**
   * Get through. The attacker wins by having this many living men standing in
   * the exit ground at once; the defender wins by stopping that until time.
   */
  | {
      readonly mode: "breakthrough";
      readonly attacker: number;
      /** Index into the level's control points: the ground to reach. */
      readonly exit: number;
      readonly required: number;
    }
  /**
   * Take the colours. Each side's standard is carried by a colour party (or,
   * failing one, its champions or its guard). Lose every man carrying it and
   * the army has lost, whatever else is still standing.
   */
  | { readonly mode: "standard" };

export const DEFAULT_VICTORY: VictoryConfig = { mode: "rout" };

export type ArmyState = {
  readonly morale: number;
  /** Living soldiers. */
  readonly strength: number;
  /** Full-strength roster at deployment. */
  readonly roster: number;
};

export type MatchState = {
  readonly armies: readonly [ArmyState, ArmyState];
  /** Seconds elapsed, and the match length. */
  readonly elapsed: number;
  readonly duration: number;
  /** Cumulative seconds each side has spent holding enough ground. */
  readonly holdSeconds: readonly [number, number];
  /** Victory points accrued. */
  readonly points: readonly [number, number];
  /** Living men of each side in a breakthrough's exit ground right now. */
  readonly through?: readonly [number, number];
  /** Whether each side's standard is still carried. */
  readonly standards?: readonly [boolean, boolean];
};

export type Outcome = {
  readonly winner: number;
  readonly reason:
    | "rout" | "annihilated" | "timer" | "objectives" | "points"
    | "survived" | "breakthrough" | "standard";
  readonly detail: string;
};

/** Timer score for the rout mode: morale held, plus enemy destroyed. */
export function score(own: ArmyState, foe: ArmyState): number {
  const destroyed = foe.roster > 0 ? 1 - foe.strength / foe.roster : 0;
  return own.morale + AGGRESSION_WEIGHT * destroyed;
}

/** Evaluate the match. Returns null while it is still running. */
export function evaluate(config: VictoryConfig, state: MatchState): Outcome | null {
  const [a, b] = state.armies;

  // -- conditions common to every mode ---------------------------------------

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

  const aBroken = a.morale < ROUT_THRESHOLD;
  const bBroken = b.morale < ROUT_THRESHOLD;
  if (aBroken || bBroken) {
    if (aBroken && bBroken) {
      const winner = a.morale >= b.morale ? 0 : 1;
      return { winner, reason: "rout", detail: "both armies broke; army " + winner + " held longer" };
    }
    return { winner: aBroken ? 1 : 0, reason: "rout", detail: "army " + (aBroken ? 0 : 1) + " routed" };
  }

  // -- outright wins particular to a mode -------------------------------------

  if (config.mode === "objectives") {
    for (const p of [0, 1]) {
      if (state.holdSeconds[p] >= config.holdToWin) {
        return {
          winner: p,
          reason: "objectives",
          detail: "army " + p + " held the ground for " + config.holdToWin + "s",
        };
      }
    }
  }
  if (config.mode === "points") {
    for (const p of [0, 1]) {
      if (state.points[p] >= config.target) {
        return {
          winner: p,
          reason: "points",
          detail: "army " + p + " reached " + config.target + " points",
        };
      }
    }
  }

  if (config.mode === "breakthrough" && state.through) {
    const p = config.attacker;
    if (state.through[p] >= config.required) {
      return {
        winner: p,
        reason: "breakthrough",
        detail: "army " + p + " broke through with " + state.through[p] + " men",
      };
    }
  }
  if (config.mode === "standard" && state.standards) {
    const [ka, kb] = state.standards;
    if (!ka || !kb) {
      if (!ka && !kb) return { winner: -1, reason: "standard", detail: "both standards taken" };
      return {
        winner: ka ? 0 : 1,
        reason: "standard",
        detail: "army " + (ka ? 1 : 0) + " lost its standard",
      };
    }
  }

  if (state.elapsed < state.duration) return null;

  // Held out, or kept the road shut: the clock is the defender's friend.
  if (config.mode === "survive") {
    return {
      winner: config.defender,
      reason: "survived",
      detail: "army " + config.defender + " was still standing at full time",
    };
  }
  if (config.mode === "breakthrough") {
    const d = config.attacker === 0 ? 1 : 0;
    return { winner: d, reason: "breakthrough", detail: "army " + d + " held the road until time" };
  }

  // -- full time --------------------------------------------------------------

  let sa: number;
  let sb: number;
  let reason: Outcome["reason"];
  if (config.mode === "objectives") {
    sa = state.holdSeconds[0];
    sb = state.holdSeconds[1];
    reason = "objectives";
  } else if (config.mode === "points") {
    sa = state.points[0];
    sb = state.points[1];
    reason = "points";
  } else {
    sa = score(a, b);
    sb = score(b, a);
    reason = "timer";
  }

  if (sa === sb) return { winner: -1, reason, detail: "drawn at full time" };
  const winner = sa > sb ? 0 : 1;
  return {
    winner,
    reason,
    detail: "time expired: " + sa.toFixed(1) + " vs " + sb.toFixed(1),
  };
}
