/**
 * The three morale systems of the kingdom layer (PLAN.md §B.6, phase K6), as
 * tables: regional unrest and what moves it, the levers a lord pulls in a
 * town (tax, justice, festivals, shrines, mercy), when a town revolts, what
 * moves an army's morale, and the realm's Mercy/Terror.
 *
 * Plain data; the rules that read it are in src/sim/kingdom/morale.ts, and
 * tools/kingdom-morale.ts holds every row to its sign (a test per input: each
 * cause moves its stat the way its row says, and nothing else), in the style
 * of Phase 6's "no doctrine strictly better".
 *
 * UNITS. Unrest is kept in PERMILLE, 0..1000, and shown as 0..100 with one
 * decimal at most, so a daily pressure of "half a point" is a whole number in
 * the sim and the arithmetic stays exact. Army morale keeps K4's 0..100 whole
 * points; Mercy/Terror is the story's −100..100 (content/story/vocab.ts,
 * docs/PROVISIONAL.md K9s.1); legitimacy K3's 0..100.
 *
 * Every number is a first guess and PROVISIONAL (docs/PROVISIONAL.md K6.x).
 */

import type { TaxRateId } from "./economy.ts";
import { MERCY_MAX, MERCY_MIN, MERCY_START } from "../story/vocab.ts";

export { MERCY_MAX, MERCY_MIN, MERCY_START };

// -- regional unrest ----------------------------------------------------------------

/** The top of the unrest scale (permille). */
export const UNREST_MAX = 1000;

/** At or above this, a holding pays half its taxes: the lesser threshold of §B.6. */
export const RESTLESS_AT = 500;
/** At or above this, the holding revolts (§B.6). */
export const REVOLT_AT = 800;

/** How unrest reads in words, by band (lower bound inclusive, in permille). */
export type UnrestBand = "calm" | "uneasy" | "restless" | "revolt";
export const UNREST_BANDS: readonly { readonly band: UnrestBand; readonly from: number }[] = [
  { band: "calm", from: 0 },
  { band: "uneasy", from: 200 },
  { band: "restless", from: RESTLESS_AT },
  { band: "revolt", from: REVOLT_AT },
];

/** The band a level of unrest (permille) reads as. */
export function unrestBand(unrest: number): UnrestBand {
  let band = UNREST_BANDS[0].band;
  for (const b of UNREST_BANDS) if (unrest >= b.from) band = b.band;
  return band;
}

/** Unrest a holding starts at when it comes to the king. Strangers are not yet trusted. */
export const CLAIM_UNREST = 100;
/** ...and when it was taken by storm: the townsmen who died were somebody's sons. */
export const STORMED_UNREST = 300;

/**
 * Every cause of unrest, and its sign. The daily pressure of each cause is in
 * permille a day; a positive one stirs the town, a negative one calms it.
 * `UNREST_CAUSE_IDS` is also the order the politics card lists them in.
 */
export type UnrestCauseId =
  | "tax" | "famine" | "quartering" | "legitimacy"
  | "custom" | "shrine" | "hall" | "justice" | "festival" | "mercy";
export const UNREST_CAUSE_IDS: readonly UnrestCauseId[] = [
  "tax", "famine", "quartering", "legitimacy", "custom", "shrine", "hall", "justice", "festival", "mercy",
];

/**
 * Custom: a town left in peace grows used to its lord, by this many permille
 * a day while it has any unrest at all. Without it a town under a new
 * king's low standing (LEGITIMACY_UNREST.low) and ordinary taxes would drift
 * to revolt in a year with nobody doing anything wrong; with it, ordinary
 * rule settles and only a grievance (high taxes, hunger, soldiers) builds.
 */
export const CUSTOM_UNREST = -3;

/**
 * Taxes (§B.6 "high taxes ↑unrest"): permille a day at each rate. No tax at
 * all calms a town; normal is neutral. Monotone in what the rate takes (the
 * test holds it).
 */
export const TAX_UNREST: Readonly<Record<TaxRateId, number>> = { none: -10, low: -4, normal: 0, high: 8, harsh: 20 };

/** Hunger (§B.6): a day of famine in the holding. */
export const FAMINE_UNREST = 15;

/**
 * An army living off the land here (K4's `foraged` signal, §B.6 "foraging
 * armies ↑"): permille for each army, each day it forages the holding's
 * fields, whoever's army it is. A happening, not a standing cause: it stops
 * when the army leaves (armies.ts runArmyDay).
 */
export const FORAGED_UNREST = 10;

/**
 * Garrison brutality (§B.6): an army of the town's own lord standing in it
 * unpaid or hungry takes what it needs from the townsfolk. Per such army.
 */
export const QUARTERED_UNREST = 12;

/**
 * The realm's standing in the lords' eyes (§B.6 item 3 feeding item 2): a
 * king nobody believes in stirs every town a little; one the lords accept
 * calms them.
 */
export const LEGITIMACY_UNREST = { lowBelow: 20, low: 2, highFrom: 50, high: -5 } as const;

/**
 * Mercy (§B.6 "mercy ↓"): the realm's Mercy, when positive, calms every town
 * by mercy / MERCY_CALM_PER permille a day. Terror does not calm a town; it
 * hardens the king's armies instead (ARMY_MORALE.terrorPer).
 */
export const MERCY_CALM_PER = 10;

// -- the levers -------------------------------------------------------------------

/**
 * Justice (§B.6 "justice ↓"): how the holding's quarrels are judged.
 *   none    nobody sits in judgement: no calm, no cost;
 *   courts  justices sit every day, paid in coin: calms;
 *   rope    the lord's men hang thieves at the crossroads: calms more, costs
 *           nothing in coin, and the realm's Mercy falls each season (terror).
 */
export type JusticeId = "none" | "courts" | "rope";
/** Hash and save order. Append only. */
export const JUSTICE_IDS: readonly JusticeId[] = ["none", "courts", "rope"];
export type JusticeDef = {
  readonly id: JusticeId;
  /** Permille a day (negative calms). */
  readonly unrest: number;
  /** Coin a day for the justices (ledger sink `justice`). Unpaid, the courts do not sit that day. */
  readonly coin: number;
  /** Mercy moved at each season's turn while this justice holds (negative = terror). */
  readonly mercyPerSeason: number;
};
export const JUSTICE: Readonly<Record<JusticeId, JusticeDef>> = {
  none: { id: "none", unrest: 0, coin: 0, mercyPerSeason: 0 },
  courts: { id: "courts", unrest: -8, coin: 1, mercyPerSeason: 0 },
  rope: { id: "rope", unrest: -15, coin: 0, mercyPerSeason: -1 },
};
export const DEFAULT_JUSTICE: JusticeId = "none";

/**
 * A festival (§B.6 "festivals ↓"): bread and ale for the town for a week.
 * Costs coin and grain by the holding's people (ledger sink `festivals`),
 * calms the town every day it runs, and is a ceremony: +1 legitimacy (§B.3
 * "Legitimacy ← ceremony", ledger `deeds`). One at a time per holding.
 */
export const FESTIVAL = {
  days: 7,
  unrestPerDay: -20,
  legitimacy: 1,
  /** Coin: one per this many people, at least `minCoin`. */
  peoplePerCoin: 20,
  minCoin: 3,
  /** Grain: one per this many people, at least `minGrain`. */
  peoplePerGrain: 4,
  minGrain: 5,
} as const;

/**
 * Mercy (§B.6 "mercy ↓", §A.4 Mercy/Terror): pardon the holding's prisoners.
 * Unrest falls at once and the realm's Mercy rises; once a season per holding,
 * because a pardon given every week is not mercy but a habit.
 */
export const PARDON = { unrest: -120, mercy: 2 } as const;

/** Shrines and halls (§B.6 "shrines ↓"): permille a day while standing and paid (content/kingdom/buildings.ts `later.unrest`). */
export const SHRINE_UNREST_SCALE = 5;

/** The season's muster (§B.6 "conscription ↑"): permille, at each season's turn, for each holding that gave men. */
export const MUSTER_UNREST = 40;

/** A battle the king lost (§B.6 "lost battles ↑"): at the holding it was fought at, and at every other holding of his in that province. */
export const LOST_BATTLE_UNREST = { here: 100, province: 30 } as const;

// -- revolt -------------------------------------------------------------------------

/**
 * A revolt (§B.6 "unrest ≥ threshold ⇒ revolt: spawns a rebel army or flips
 * the region"). The holding throws off the king: its owner becomes nobody.
 * If it has the people, its young men also take up the crown's banner -- the
 * province's old lord's, or the Chancellor's where it never had one -- as a
 * rebel host of levy spears standing in the town. Legitimacy falls.
 */
export const REVOLT = {
  /** One rebel per this many people... */
  peoplePerRebel: 10,
  /** ...up to this many full squads (the levy's spear squad). */
  maxSquads: 2,
  /** Fewer than this, and nobody takes up arms: the holding only flips. */
  minRebels: 4,
  morale: 70,
  legitimacy: 3,
  /** What is left of the unrest once the hotheads have marched off. */
  after: 0,
} as const;

// -- army morale (§B.6 item 1) --------------------------------------------------------

/**
 * Army morale moves once a day, after the army has eaten and been paid:
 *   - hungry: falls `hungry` a day; unpaid: falls `unpaid` a day;
 *   - fed and paid: moves one point a day toward its REST level, which is
 *     `rest`, + `king` while the king rides with it (leader presence),
 *     + legitimacy / `legitimacyPer` (the men believe in the cause),
 *     + terror / `terrorPer` (when Mercy is below 0: they fear him more than the enemy);
 *   - a battle won: + `win` on top of what the battle left (recent victories);
 *     a withdrawal already costs K5's WITHDRAW_MORALE (retreating ↓).
 * Below `desertBelow` men slip away: `desertPermille` of the fit men a day.
 * Only armies whose faction's economy runs (the king's, until K8).
 */
export const ARMY_MORALE = {
  rest: 55,
  king: 15,
  legitimacyPer: 10,
  terrorPer: 20,
  hungry: 4,
  unpaid: 3,
  drift: 1,
  win: 8,
  desertBelow: 20,
  desertPermille: 30,
} as const;

// -- the realm's Mercy/Terror ---------------------------------------------------------

/**
 * Legitimacy at each season's turn from standing, paid shrines and halls
 * (buildings.ts `later.legitimacy`, "a season"), ledger `deeds`.
 */
export const SEASON_LEGITIMACY_CAP = 3;

/** Every problem with the tables above. Empty means valid. */
export function validateMorale(): string[] {
  const p: string[] = [];
  const rates: TaxRateId[] = ["none", "low", "normal", "high", "harsh"];
  for (let i = 1; i < rates.length; i++) {
    if (TAX_UNREST[rates[i]] <= TAX_UNREST[rates[i - 1]]) p.push("a higher tax must stir a town more");
  }
  if (!(RESTLESS_AT < REVOLT_AT && REVOLT_AT <= UNREST_MAX)) p.push("the lesser threshold must come before the revolt");
  for (const j of JUSTICE_IDS) if (JUSTICE[j].unrest > 0) p.push("justice " + j + " must not stir a town");
  if (JUSTICE.courts.coin <= 0) p.push("the courts must cost something: a free calm is no decision");
  if (JUSTICE.rope.mercyPerSeason >= 0) p.push("the rope must cost mercy");
  if (FESTIVAL.unrestPerDay >= 0 || PARDON.unrest >= 0) p.push("festivals and pardons must calm");
  if (FAMINE_UNREST <= 0 || FORAGED_UNREST <= 0 || QUARTERED_UNREST <= 0 || MUSTER_UNREST <= 0 || LOST_BATTLE_UNREST.here <= 0) p.push("hunger, brutality, conscription and defeat must stir");
  if (ARMY_MORALE.hungry <= 0 || ARMY_MORALE.unpaid <= 0 || ARMY_MORALE.win <= 0) p.push("army morale rules have the wrong sign");
  for (let i = 1; i < UNREST_BANDS.length; i++) if (UNREST_BANDS[i].from <= UNREST_BANDS[i - 1].from) p.push("unrest bands out of order");
  return p;
}
