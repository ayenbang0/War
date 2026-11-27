/**
 * Exploration and the kingdom fog (PLAN.md §B.2, phase K3a): how far each
 * sight source sees, as plain numbers the sim reads.
 *
 * The fog is Phase 4's three-state idea at graph scale. Per faction, every
 * holding and every road is:
 *   - UNKNOWN: never seen and not remembered. Not drawn; a march may not be
 *     ordered to it unless a known road leads there;
 *   - KNOWN:   remembered (seen once, or known from the start, or told of)
 *     but not in sight now. Drawn as remembered;
 *   - SEEN:    in sight of one of the faction's sight sources right now.
 * Seen falls back to known when the source moves on; nothing ever falls back
 * to unknown (the monotonicity test holds the sim to that).
 *
 * Sight sources: the king's retinue, every holding the faction owns, and a
 * standing watchtower (which sees further). K4 adds armies through the same
 * function (sim/kingdom/explore.ts `sightSources`).
 *
 * Every number is PROVISIONAL (docs/PROVISIONAL.md K3a.x).
 */

import type { HoldingKind } from "./terrain.ts";

/** Knowledge of one holding or road, by one faction. Stored as these numbers; the order is load-bearing (max = most known). */
export const KNOW_UNKNOWN = 0;
export const KNOW_KNOWN = 1;
export const KNOW_SEEN = 2;
export type Knowledge = typeof KNOW_UNKNOWN | typeof KNOW_KNOWN | typeof KNOW_SEEN;

/**
 * Miles the king's retinue sees round itself. Holdings stand 50-150 miles
 * apart, so the party sees the roads out of where it stands and little of
 * where they lead: the next town is found by going there.
 */
export const RETINUE_SIGHT_MILES = 50;

/** Miles an owned holding sees round itself, by kind: its people know their own country. */
export const HOLDING_SIGHT_MILES: Readonly<Record<HoldingKind, number>> = {
  hamlet: 35, village: 40, town: 50, keep: 55, city: 65,
};
