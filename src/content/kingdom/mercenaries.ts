/**
 * Free companies under contract (PLAN.md §B.7, phase K7): how a company the
 * story names (content/story/mercenaries.ts, MERCENARIES) comes to a
 * tavern, signs on, is paid, is kept or lost, and how the crown bids for it.
 *
 * The companies themselves -- their names, mixes, fees, wages, contract
 * lengths, loyalty and reputation -- are the story's table (K9s.6); this
 * file holds the RULES of the lifecycle
 *
 *   waiting -> offered -> hired -> (renewed | expired | deserted | defected | poached | dismissed)
 *
 * as plain data. src/sim/kingdom/mercenaries.ts reads it; tools/
 * kingdom-mercenaries.ts holds each step to it. Every number is a first
 * guess and PROVISIONAL (docs/PROVISIONAL.md K7.x).
 */

import type { Reputation } from "../story/mercenaries.ts";

export { MERCENARIES, type MercenaryDef, type Reputation } from "../story/mercenaries.ts";

/**
 * Where a company is in its life with the king.
 *   waiting  free, and may come to one of his taverns
 *   offered  drinking in one of his taverns, willing to sign (`at`, `days` left)
 *   hired    on contract (`army`, `days` left)
 *   away     gone on to other work; may come back after `days`
 *   turned   went over to the crown (defected or poached): never again
 *   broken   its army was destroyed: there is no company left to hire
 */
export type CompanyState = "waiting" | "offered" | "hired" | "away" | "turned" | "broken";
/** Hash and save order. Append only. */
export const COMPANY_STATES: readonly CompanyState[] = ["waiting", "offered", "hired", "away", "turned", "broken"];

/** How a company left the king's service. */
export type CompanyLeaving = "expired" | "deserted" | "defected" | "poached" | "dismissed" | "broken";
export const COMPANY_LEAVINGS: readonly CompanyLeaving[] = ["expired", "deserted", "defected", "poached", "dismissed", "broken"];

/** Days an offer stands at a tavern before the company moves on. */
export const OFFER_DAYS = 20;
/** Days a company that moved on, or left, is away before it may come back. */
export const AWAY_DAYS = 30;
/** One company at a time drinks in a tavern. */
export const OFFERS_PER_TAVERN = 1;

/**
 * Which companies come to the king's taverns, by the act that first offers
 * them (story/mercenaries.ts `act`). Until K9 keeps the act, the realm's
 * size stands in for it: a company of act n comes once the king holds at
 * least this many holdings (docs/PROVISIONAL.md K7.2).
 */
export const ACT_HOLDINGS: Readonly<Record<number, number>> = { 1: 0, 2: 3, 3: 6, 4: 10 };

/** A contract may be renewed in its last RENEW_WINDOW days, for RENEW_FEE_PCT of the signing fee. */
export const RENEW_WINDOW = 15;
export const RENEW_FEE_PCT = 50;

/**
 * Loyalty (0..100), once a day: paid in full, it rises `paid`; with wages
 * owed, it falls `unpaid`. A matched bid adds `matched`. At 0 the company
 * leaves by its reputation (LEAVES_AS).
 */
export const LOYALTY = { paid: 1, unpaid: 8, matched: 15, max: 100 } as const;

/** How a company whose loyalty is spent leaves: the reliable walk away; the rest go over to the crown. */
export const LEAVES_AS: Readonly<Record<Reputation, "deserted" | "defected">> = {
  reliable: "deserted", bloody: "defected", turncoats: "defected",
};

/** Legitimacy lost when a company leaves the king's service badly (ledger `disgrace`). */
export const LEAVE_LEGITIMACY: Readonly<Record<CompanyLeaving, number>> = {
  expired: 0, dismissed: 0, broken: 0, deserted: 1, defected: 2, poached: 2,
};

/**
 * Poaching (§B.7 "a rival's higher bid can poach them"): on these days of
 * each season the crown's agents bid for every hired company whose loyalty
 * is below its reputation's line. A bid stands `days`; the king can match it
 * (its coin, ledger `hiring`), or the company goes over to the crown.
 */
export const POACH = {
  below: { reliable: 25, bloody: 35, turncoats: 50 } as Readonly<Record<Reputation, number>>,
  /** The bid: this per cent of the company's signing fee, at least `min` coin. */
  bidPct: 50,
  min: 5,
  days: 5,
  onDays: [0, 15] as readonly number[],
} as const;

/**
 * A bloody company (§B.7 reputation) makes the king's name worse: unrest in
 * the king's town it stands in, every day (permille, through K6's
 * moveUnrest), and legitimacy at each season's turn while it is hired.
 */
export const BLOODY = { unrest: 5, legitimacy: 1 } as const;

/** The crown's banner a company goes over to (the Chancellor's, until K8 gives the captains their own agents). */
export const TURNED_FACTION = "usurper";

/** Every problem with the tables above. Empty means valid. */
export function validateMercenaryRules(): string[] {
  const p: string[] = [];
  if (OFFER_DAYS <= 0 || AWAY_DAYS <= 0) p.push("offers and absences must last");
  if (RENEW_WINDOW <= 0 || RENEW_FEE_PCT <= 0) p.push("a renewal must have a window and a price");
  if (LOYALTY.unpaid <= LOYALTY.paid) p.push("missed wages must cost more loyalty than a day's pay earns");
  if (!(POACH.below.reliable < POACH.below.bloody && POACH.below.bloody < POACH.below.turncoats)) p.push("turncoats must be the easiest to poach");
  if (LEAVES_AS.reliable !== "deserted") p.push("a reliable company does not turn on its employer");
  for (let a = 1; a <= 4; a++) if (ACT_HOLDINGS[a] === undefined || (a > 1 && ACT_HOLDINGS[a] < ACT_HOLDINGS[a - 1])) p.push("act gates must rise");
  return p;
}
