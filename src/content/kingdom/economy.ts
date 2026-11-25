/**
 * The kingdom economy's numbers (PLAN.md §B.3, phase K3): stocks, ledger
 * categories, tax rates, foraging, rallying, storage, spoilage, the town dole
 * and the starting stores. Plain data; the sim (src/sim/kingdom/economy.ts)
 * reads it by id and nothing here branches.
 *
 * UNITS. Every stock is a whole number, so the ledger balances exactly and a
 * conservation test can demand equality, not "close enough":
 *   - grain is counted in PERSON-DAYS: one grain feeds one person for a day;
 *   - coin is the silver penny of the realm;
 *   - timber is a cartload, iron a bar, levy a person following the banner.
 * Rates that are naturally fractional (a tax of 2 pennies per hundred people
 * per day, the dole a town draws) accumulate in a per-holding remainder
 * instead of being rounded away, so a hamlet of 30 still pays its penny every
 * two days.
 *
 * Every number here is PROVISIONAL (docs/PROVISIONAL.md K3.x) and is tuned by
 * tools/kingdom-sweep.ts; the structure is what later phases build on.
 */

import type { BiomeId, HoldingKind, Season } from "./terrain.ts";

// -- stocks ---------------------------------------------------------------------

/** The five stockpiles of §B.3. The soft stat legitimacy is kept beside them. */
export type StockId = "coin" | "grain" | "timber" | "iron" | "levy";

/** Hash and save order. Append only. */
export const STOCK_IDS: readonly StockId[] = ["coin", "grain", "timber", "iron", "levy"];

/**
 * What the ledger tracks: the five stocks and legitimacy. Legitimacy is a
 * soft stat (§B.3, §B.6) whose rules arrive in K6; it is in the ledger now so
 * K6 only has to call the entry point, never change the bookkeeping.
 */
export type LedgerStockId = StockId | "legitimacy";
export const LEDGER_STOCK_IDS: readonly LedgerStockId[] = [...STOCK_IDS, "legitimacy"];

/** Legitimacy is kept in 0..100; the exiled king starts with some. */
export const LEGITIMACY_MAX = 100;

/**
 * Why a stock moved. Every change to every stock names one of these, and the
 * ledger keeps the sum per category per day, so "where did my grain go?" has
 * an answer and conservation is checkable.
 *
 * A category is either a SOURCE (only ever adds) or a SINK (only ever takes);
 * the test suite holds every recorded amount to its category's direction.
 * Categories later phases fill are present now with `phase` saying who.
 */
export type LedgerCategoryId =
  | "tax" | "trade" | "harvest" | "forage" | "rally" | "muster" | "production" | "plunder" | "deeds"
  | "food" | "retinue" | "spoilage" | "seed" | "construction" | "upkeep" | "materials"
  | "rations" | "wages" | "recruitment" | "desertion" | "disgrace"
  // K3a: exploration events and special upgrades (content/story/).
  | "finds" | "boons" | "offerings"
  // K4: armies (src/sim/kingdom/armies.ts).
  | "provisions" | "disbanded" | "favours";

export type LedgerCategoryDef = {
  readonly id: LedgerCategoryId;
  readonly dir: "source" | "sink";
  /** The phase whose rules use it; K3 for the ones live now. */
  readonly phase: "K3" | "K3a" | "K4" | "K5" | "K6" | "K7";
  /** For the ledger screen and the resources bar's breakdown. */
  readonly label: string;
};

export const LEDGER_CATEGORIES: readonly LedgerCategoryDef[] = [
  { id: "tax", dir: "source", phase: "K3", label: "taxes" },
  { id: "trade", dir: "source", phase: "K3", label: "trade" },
  { id: "harvest", dir: "source", phase: "K3", label: "harvests" },
  { id: "forage", dir: "source", phase: "K3", label: "foraging" },
  { id: "rally", dir: "source", phase: "K3", label: "rallied followers" },
  { id: "muster", dir: "source", phase: "K3", label: "the season's muster" },
  { id: "production", dir: "source", phase: "K3", label: "workshops" },
  { id: "plunder", dir: "source", phase: "K5", label: "plunder" },
  { id: "deeds", dir: "source", phase: "K6", label: "deeds" },
  { id: "food", dir: "sink", phase: "K3", label: "the towns' bread" },
  { id: "retinue", dir: "sink", phase: "K3", label: "the king's party" },
  { id: "spoilage", dir: "sink", phase: "K3", label: "spoilage" },
  { id: "seed", dir: "sink", phase: "K3", label: "seed" },
  { id: "construction", dir: "sink", phase: "K3", label: "building" },
  { id: "upkeep", dir: "sink", phase: "K3", label: "upkeep" },
  { id: "materials", dir: "sink", phase: "K3", label: "workshop materials" },
  { id: "rations", dir: "sink", phase: "K4", label: "army rations" },
  { id: "wages", dir: "sink", phase: "K4", label: "wages" },
  { id: "recruitment", dir: "sink", phase: "K4", label: "recruitment" },
  { id: "desertion", dir: "sink", phase: "K4", label: "desertion" },
  { id: "disgrace", dir: "sink", phase: "K6", label: "disgrace" },
  // K3a, appended (save v3 re-lays old ledger pages for the new width).
  { id: "finds", dir: "source", phase: "K3a", label: "finds and gifts" },
  { id: "boons", dir: "source", phase: "K3a", label: "special upgrades" },
  { id: "offerings", dir: "sink", phase: "K3a", label: "gifts and offerings" },
  // K4, appended (save v4 re-lays old ledger pages for the new width).
  { id: "provisions", dir: "sink", phase: "K4", label: "grain loaded on the armies" },
  { id: "disbanded", dir: "source", phase: "K4", label: "armies stood down" },
  { id: "favours", dir: "sink", phase: "K4", label: "abilities earned for armies" },
];

/** Hash and save order of the categories. Append only. */
export const LEDGER_CATEGORY_IDS: readonly LedgerCategoryId[] = LEDGER_CATEGORIES.map((c) => c.id);

// -- the start: nothing (PLAN.md §A.5 amendment) --------------------------------

/**
 * What the exiled king has on day one: no coin, no followers, and what two
 * people can carry -- a few days' bread. Everything else is earned.
 */
export const KING_START: Readonly<Record<StockId, number>> = { coin: 0, grain: 12, timber: 0, iron: 0, levy: 0 };
export const KING_START_LEGITIMACY = 10;

// -- taxes ------------------------------------------------------------------------

export type TaxRateId = "none" | "low" | "normal" | "high" | "harsh";

export type TaxRateDef = {
  readonly id: TaxRateId;
  readonly name: string;
  /** Pennies per hundred people per day. */
  readonly per100: number;
  /**
   * Population change at the start of each season, in percent, for a fed
   * holding at this rate. High taxes drive people away; this is K3's cost of
   * taxing, until K6 adds unrest (which will read `per100` too).
   */
  readonly growthPct: number;
};

/** In increasing order of what they take; the order is load-bearing (tax monotonicity test). */
export const TAX_RATES: readonly TaxRateDef[] = [
  { id: "none", name: "none", per100: 0, growthPct: 4 },
  { id: "low", name: "low", per100: 2, growthPct: 3 },
  { id: "normal", name: "normal", per100: 4, growthPct: 2 },
  { id: "high", name: "high", per100: 7, growthPct: 0 },
  { id: "harsh", name: "harsh", per100: 11, growthPct: -4 },
];
export const TAX_RATE_IDS: readonly TaxRateId[] = TAX_RATES.map((t) => t.id);
/** The rate a newly claimed holding is taxed at, until the player says otherwise. */
export const DEFAULT_TAX: TaxRateId = "normal";

// -- the dole: what an owned holding draws from the lord's stores -----------------

/**
 * Grain an owned holding draws from its lord's stores, per hundred people per
 * day, by season. Peasants feed themselves from their own plots and gardens
 * for most of the year; the lord's granary is what carries them through the
 * lean months -- hence the winter figure, which is what makes winter the
 * pressure of Act I (§A.5, §B.3).
 */
export const DOLE_PER_100: Readonly<Record<Season, number>> = { spring: 6, summer: 2, autumn: 2, winter: 10 };

/** People in the king's party (the king, companions, followers) each eat this many grain a day. */
export const PARTY_RATION = 1;

/**
 * A holding in famine loses this percentage of its people each day, spread
 * evenly over the famine's days (see famineDeaths in sim/kingdom/economy.ts):
 * a month of famine costs a hamlet about half its people.
 */
export const FAMINE_LOSS_PCT = 2;

/** Share of a fed holding's people called to the levy at the start of each season, in percent. */
export const MUSTER_PCT = 3;

// -- storage and spoilage ---------------------------------------------------------

/** Grain a holding of each kind can keep in its cellars and barns, without a granary. */
export const CELLAR: Readonly<Record<HoldingKind, number>> = { hamlet: 30, village: 80, town: 300, keep: 120, city: 1200 };

/** Grain each person in the king's party can carry. */
export const CARRY_PER_PERSON = 12;

/**
 * Spoilage per day, in tenths of a percent, by where the grain is kept.
 * Grain fills granaries first, then cellars and packs, and what is left over
 * lies in heaps and rots fast. Spoilage of the first two is rounded down (a
 * small store loses nothing in a day); of the heap, rounded up.
 */
export const SPOIL_PERMILLE = { granary: 3, loose: 15, heap: 250 } as const;

// -- foraging and rallying (the from-nothing start) --------------------------------

/**
 * Grain one forager gathers in a day, by season: gleaning, nuts and roots in
 * autumn, next to nothing in winter. Multiplied by the country's fertility.
 */
export const FORAGE_PER_PERSON: Readonly<Record<Season, number>> = { spring: 2, summer: 3, autumn: 5, winter: 1 };

/** Deadwood: one cartload of timber per this many foragers a day, at 100 % wood. */
export const FORAGERS_PER_TIMBER = 4;

export type BiomeEconomy = {
  /** Forage and harvest fertility, percent. */
  readonly fertility: number;
  /** Wood to be had, percent: deadwood for foragers, logs for a woodcutter. 0 = none. */
  readonly wood: number;
  /** Fields here flood in a storm or a wet spell. */
  readonly floods: boolean;
};

export const BIOME_ECONOMY: Readonly<Record<BiomeId, BiomeEconomy>> = {
  reach: { fertility: 100, wood: 100, floods: false },
  vale: { fertility: 130, wood: 80, floods: true },
  forest: { fertility: 90, wood: 200, floods: false },
  river: { fertility: 120, wood: 90, floods: true },
  "river-town": { fertility: 110, wood: 60, floods: true },
  city: { fertility: 60, wood: 0, floods: false },
  open: { fertility: 140, wood: 50, floods: false },
  highland: { fertility: 70, wood: 90, floods: false },
  moor: { fertility: 60, wood: 40, floods: false },
  "border-hills": { fertility: 90, wood: 110, floods: true },
  coast: { fertility: 90, wood: 50, floods: false },
};

/**
 * Rallying at an unclaimed hamlet: followers a day are
 * max(1, floor(people / RALLY_PEOPLE_PER_FOLLOWER)); each leaves the hamlet
 * for the king's levy and brings what they carry. A hamlet stops giving when
 * it is down to RALLY_FLOOR_PCT of the people it had at the start -- the
 * rest will not leave their homes for an exile.
 */
export const RALLY_PEOPLE_PER_FOLLOWER = 25;
export const RALLY_FLOOR_PCT = 60;
export const RALLY_BRINGS: Readonly<Partial<Record<StockId, number>>> = { grain: 3, coin: 1 };

/** Followers needed to claim a holding: it must be held by somebody. */
export const CLAIM_MIN_LEVY = 3;

// -- farm weather (from the weather stream, at day scale) ---------------------------

export type FarmEventId = "drought" | "frost" | "flood";
/** Hash order. Append only. */
export const FARM_EVENT_IDS: readonly FarmEventId[] = ["drought", "frost", "flood"];

/**
 * Chance in percent of a farm event today, by season and today's weather.
 * Drawn once every day whatever the farms hold, so the draw never depends on
 * what anyone planted and the weather stream is consumed identically however
 * the realm is farmed. Frost in autumn only in its second half.
 */
export const FARM_EVENT_ODDS: Readonly<Record<Season, Readonly<Partial<Record<string, readonly [FarmEventId, number]>>>>> = {
  spring: { clear: ["frost", 10], fog: ["frost", 8], rain: ["flood", 6], storm: ["flood", 30] },
  summer: { clear: ["drought", 15], storm: ["flood", 20] },
  autumn: { clear: ["frost", 10], fog: ["frost", 8], rain: ["flood", 5], storm: ["flood", 25] },
  winter: {},
};
/** Autumn frost waits for the season's second half. */
export const AUTUMN_FROST_FROM_DAY = 15;

/** Health lost by a plot, by event and hardiness. A plot at 0 health is spoiled. */
export const FARM_EVENT_HARM: Readonly<Record<FarmEventId, { readonly tender: number; readonly hardy: number }>> = {
  drought: { tender: 6, hardy: 3 },
  frost: { tender: 30, hardy: 5 },
  flood: { tender: 35, hardy: 25 },
};

/** Fields per holding scale up with its kind: a town's "field" is a whole open field. */
export const FIELD_SIZE: Readonly<Record<HoldingKind, number>> = { hamlet: 1, village: 2, town: 6, keep: 1, city: 12 };

/** Harvest variance: the yield is multiplied by a percentage drawn in [100 - V, 100 + V] from the economy stream. */
export const HARVEST_VARIANCE_PCT = 10;

/** Days a sown plot takes to come up (sown -> growing), counted only in a season it grows in. */
export const GERMINATION_DAYS = 3;

/** Every problem with the tables above. Empty means valid. */
export function validateEconomy(): string[] {
  const problems: string[] = [];
  for (let i = 1; i < TAX_RATES.length; i++) {
    if (TAX_RATES[i].per100 <= TAX_RATES[i - 1].per100) problems.push("tax rates must take more as they go up");
    if (TAX_RATES[i].growthPct > TAX_RATES[i - 1].growthPct) problems.push("a higher tax may not grow a town faster");
  }
  const ids = new Set<string>();
  for (const c of LEDGER_CATEGORIES) {
    if (ids.has(c.id)) problems.push("ledger category " + c.id + " is listed twice");
    ids.add(c.id);
  }
  for (const s of STOCK_IDS) if (!Number.isInteger(KING_START[s]) || KING_START[s] < 0) problems.push("start stock " + s + " must be a whole number >= 0");
  for (const v of Object.values(CELLAR)) if (!Number.isInteger(v) || v < 0) problems.push("cellar sizes must be whole numbers");
  return problems;
}
