/**
 * Scripted players for the kingdom economy: shared by tools/kingdom-economy.ts
 * (the "winter survivable / unsurvivable by choice" proof) and
 * tools/kingdom-sweep.ts (the balance sweep).
 *
 * A strategy is a list of steps. Each step may issue one order when it starts,
 * then waits, tick by tick, until its condition holds; then the next step
 * starts. The driver only READS the world to decide, and writes it only
 * through `world.issue`, exactly as a player at the panels would -- so a run
 * produces an ordinary order log, and that log replays to the same realm
 * (the economy test checks it).
 */

import { KingdomWorld, TICKS_PER_DAY, type KingdomOrderBody } from "../src/sim/kingdom/index.ts";
import type { BuildingId } from "../src/content/kingdom/buildings.ts";
import type { CropId } from "../src/content/kingdom/crops.ts";

export type Step = {
  readonly note: string;
  /** Issued when the step starts; a function so it can read the world (ids, plots). */
  readonly order?: (w: KingdomWorld) => KingdomOrderBody | null;
  /** The step ends when this holds (checked after every tick). Default: at once. */
  readonly until?: (w: KingdomWorld) => boolean;
  /** Give up waiting after this many days and go on. */
  readonly maxDays?: number;
};

export type Strategy = { readonly name: string; readonly about: string; readonly steps: readonly Step[] };

const id = (w: KingdomWorld, key: string): number => w.holdingByKey(key)!.id;
const at = (w: KingdomWorld, key: string): boolean => w.king.mover.road === 0 && w.king.mover.node === id(w, key) && w.king.mover.route.length === 0;
const day = (w: KingdomWorld): number => w.date.day;

// -- step builders -------------------------------------------------------------------

export const march = (key: string): Step => ({
  note: "march to " + key, order: (w) => ({ kind: "moveKing", to: id(w, key) }), until: (w) => at(w, key), maxDays: 40,
});
export const forageUntil = (note: string, until: (w: KingdomWorld) => boolean, maxDays = 200): Step => ({
  note: "forage " + note, order: () => ({ kind: "forage" }), until, maxDays,
});
export const rallyUntil = (levy: number, maxDays = 30): Step => ({
  note: "rally to " + levy, order: () => ({ kind: "rally" }),
  until: (w) => w.kingStocks.stocks.levy >= levy || w.king.task !== "rally", maxDays,
});
export const claim = (key: string): Step => ({ note: "claim " + key, order: (w) => ({ kind: "claimHolding", holding: id(w, key) }) });
export const build = (key: string, building: BuildingId): Step => ({
  note: "build " + building + " at " + key,
  order: (w) => ({ kind: "build", holding: id(w, key), building }),
});
/** Wait until a building can be afforded, then order it. */
export const buildWhenAffordable = (key: string, building: BuildingId, maxDays = 120): Step[] => [
  { note: "save for " + building, until: (w) => w.check({ kind: "build", holding: id(w, key), building }) === null, maxDays },
  build(key, building),
];
export const sowAll = (key: string, crop: CropId): Step => ({
  note: "sow " + crop + " at " + key,
  order: (w) => {
    // Sow the first plot that will take it; the next sowAll step sows the next.
    const h = w.holdingByKey(key)!;
    for (const p of h.plots) if (w.check({ kind: "sow", plot: p.id, crop }) === null) return { kind: "sow", plot: p.id, crop };
    return null;
  },
});
export const harvestRipe = (key: string): Step => ({
  note: "harvest at " + key,
  order: (w) => {
    const h = w.holdingByKey(key)!;
    const p = h.plots.find((x) => x.stage === "ripe");
    return p ? { kind: "harvest", plot: p.id } : null;
  },
});
export const waitDays = (n: number): Step => {
  let until = -1;
  return { note: "wait " + n + " days", order: (w) => { until = day(w) + n; return null; }, until: (w) => day(w) >= until };
};
/** Stop whatever the king is doing (a halt also ends foraging or rallying). */
export const rest: Step = { note: "rest", order: () => ({ kind: "haltKing" }) };
export const waitUntilDay = (d: number): Step => ({ note: "wait until day " + d, until: (w) => day(w) >= d, maxDays: 10000 });
export const setTax = (holding: number, rate: "none" | "low" | "normal" | "high" | "harsh"): Step => ({
  note: "tax " + rate, order: () => ({ kind: "setTax", holding, rate }),
});

/**
 * A steward that keeps a holding's fields going for the rest of the run:
 * harvests whatever is ripe, sows whatever the season allows (wheat in
 * spring, rye in autumn), every day. Not an order by itself -- the driver
 * calls it each day once the scripted steps are done.
 */
export function steward(keys: readonly string[]): (w: KingdomWorld) => KingdomOrderBody[] {
  return (w) => {
    const out: KingdomOrderBody[] = [];
    for (const key of keys) {
      const h = w.holdingByKey(key);
      if (!h || h.owner !== "king") continue;
      for (const p of h.plots) {
        if (p.stage === "ripe") { out.push({ kind: "harvest", plot: p.id }); continue; }
        for (const crop of ["wheat", "rye"] as const) {
          if (w.check({ kind: "sow", plot: p.id, crop }) === null) { out.push({ kind: "sow", plot: p.id, crop }); break; }
        }
      }
    }
    return out;
  };
}

// -- the driver ------------------------------------------------------------------------

export type DayRecord = {
  readonly day: number;
  readonly stocks: Readonly<Record<string, number>>;
  readonly need: number;
  readonly hunger: number;
  /** Holdings of the king's in famine today. */
  readonly famine: number;
  readonly owned: number;
};

export type RunResult = {
  readonly world: KingdomWorld;
  readonly days: DayRecord[];
  /** Notes of the steps reached, with the day each started. */
  readonly trace: string[];
};

/**
 * Run `strategy` from a fresh realm for `days` days. `everyDay` (a steward)
 * is consulted at each day's first tick after the scripted steps run out.
 * `onTick` sees the world after every tick (the conservation test hooks in).
 */
export function runStrategy(
  seed: number, strategy: Strategy, days: number,
  opts: { everyDay?: (w: KingdomWorld) => KingdomOrderBody[]; onTick?: (w: KingdomWorld) => void } = {},
): RunResult {
  const w = new KingdomWorld({ seed });
  const trace: string[] = [];
  const out: DayRecord[] = [];
  let i = -1;
  let started = 0;
  const startStep = (): void => {
    i++;
    if (i >= strategy.steps.length) return;
    const s = strategy.steps[i];
    started = day(w);
    trace.push("day " + (day(w) + 1) + ": " + s.note);
    const body = s.order?.(w) ?? null;
    if (body) w.issue(body);
  };
  startStep();
  while (w.now < days * TICKS_PER_DAY) {
    if (w.now % TICKS_PER_DAY === 0 && i >= strategy.steps.length && opts.everyDay) {
      for (const b of opts.everyDay(w)) w.issue(b);
    }
    w.tick();
    opts.onTick?.(w);
    // Steps advance after the tick so an order issued now is applied before it is judged.
    // A step that issued an order is first judged after the tick that applies
    // it; a step with no order and no wait passes at once.
    let fresh = false;
    while (i < strategy.steps.length) {
      const s = strategy.steps[i];
      if (fresh && s.order) break;
      const done = !s.until || s.until(w) || (s.maxDays !== undefined && day(w) - started >= s.maxDays);
      if (!done) break;
      startStep();
      fresh = true;
    }
    if (w.now % TICKS_PER_DAY === 0) {
      const e = w.kingStocks;
      const owned = w.holdingsOf("king");
      out.push({
        day: day(w), stocks: { ...e.stocks }, need: w.dailyNeed(), hunger: e.hunger,
        famine: owned.filter((h) => h.famine > 0).length, owned: owned.length,
      });
    }
  }
  return { world: w, days: out, trace };
}

// -- the strategies ---------------------------------------------------------------------

const firstWinterEnd = 60; // day index: autumn is days 0-29, winter 30-59

/**
 * The careful exile: rally a handful at Cold Hearth, forage while autumn
 * gives, move to Greyshaw, rally a few more there, claim it, build a
 * granary, sow rye, and fill the granary before the snow.
 */
export const CAREFUL: Strategy = {
  name: "careful",
  about: "rally a few, forage to a full pack, claim Greyshaw, granary before winter, sow rye, fill the stores",
  steps: [
    rallyUntil(4, 8),
    forageUntil("at Cold Hearth to a full pack", (w) => w.kingStocks.stocks.grain >= 70 && w.kingStocks.stocks.timber >= 4, 12),
    march("greyshaw"),
    claim("greyshaw"),
    ...buildWhenAffordable("greyshaw", "granary", 10),
    sowAll("greyshaw", "rye"),
    forageUntil("through the first winter", (w) => day(w) >= firstWinterEnd),
    waitUntilDay(firstWinterEnd),
  ],
};

/**
 * The careless exile: rallies every follower Cold Hearth will give, claims
 * Cold Hearth at once (its people now eat from his stores), forages a little
 * and builds nothing -- no granary, so the autumn's gleanings rot in heaps.
 */
export const CARELESS: Strategy = {
  name: "careless",
  about: "rally everyone at Cold Hearth, claim it, no granary, forage a little",
  steps: [
    rallyUntil(99, 20),
    claim("cold-hearth"),
    forageUntil("a few days", (w) => day(w) >= 20),
    rest,
    waitUntilDay(firstWinterEnd),
  ],
};

/** The idle exile: does nothing at all. */
export const IDLE: Strategy = { name: "idle", about: "does nothing", steps: [waitUntilDay(10000)] };

/** The forager: never claims anything, forages forever. Carries only what the party can carry. */
export const FORAGER: Strategy = {
  name: "forager", about: "forages at Cold Hearth forever, claims nothing",
  steps: [forageUntil("forever", () => false, 100000)],
};

/** The builder: the careful start, then Rookstead too, a woodcutter and a farm, taxed low. */
export const BUILDER: Strategy = {
  name: "builder",
  about: "careful start, then claim Rookstead: woodcutter, granary, farm; low tax",
  steps: [
    ...CAREFUL.steps.slice(0, -1),
    waitUntilDay(firstWinterEnd),
    rallyUntil(12, 0),
    march("rookstead"),
    claim("rookstead"),
    ...buildWhenAffordable("rookstead", "woodcutter", 60),
    ...buildWhenAffordable("rookstead", "granary", 60),
    ...buildWhenAffordable("rookstead", "farm", 120),
    forageUntil("at Rookstead a while", (w) => day(w) >= 200),
  ],
};

export const STRATEGIES: readonly Strategy[] = [CAREFUL, CARELESS, IDLE, FORAGER, BUILDER];
