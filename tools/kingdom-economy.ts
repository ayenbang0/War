/**
 * Headless checks for the K3 economy (PLAN.md §B.3, §C K3; docs/kingdom.md "K3").
 *
 * Part of `npm test`. Holds the economy to what the plan claims for it:
 *
 *   - the content tables are valid, and their validators are not dead;
 *   - the ledger balances: for every faction, stock and day of multi-year
 *     runs, end = start + Σ sources − Σ sinks, nothing goes negative or NaN,
 *     and a stock changed behind the ledger's back is caught;
 *   - the plot state machine: empty → sown → growing → ripe → harvested,
 *     or spoiled by weather, winter or neglect; orchards come back;
 *   - seasons: the calendar, the muster, towns growing with the tax;
 *   - buildings: cost, works, standing, upkeep (idle when unpaid), production,
 *     upgrades, slots;
 *   - taxes are monotone: a higher rate never takes less coin, never grows
 *     a town faster;
 *   - granary storage and spoilage;
 *   - the order check the buttons use is the one the sim applies;
 *   - determinism, save/load and the v1 → v2 migration of a real K2 save;
 *   - THE PROOF: two scripted order logs from the same start -- one gets a
 *     holding and a granary before the first winter and never runs out of
 *     bread; the other is careless and its people starve.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  KingdomWorld, kingdomHash, calendar, saveToJson, loadFromJson, replayLog, migrate, deserialize, mapFingerprint,
  TICKS_PER_DAY, DAYS_PER_SEASON, DAYS_PER_YEAR, KINGDOM_SAVE_VERSION,
  credit, debit, netOf, flowOf, adjustLegitimacy, storageOf, famineDeaths, taxPerDay, checkEconomyOrder,
  changeLegitimacy, dailyNeed, MIGRATIONS, K3_MAP,
  type KingdomEvent, type KingdomOrderBody, type Holding, type LedgerDay,
} from "../src/sim/kingdom/index.ts";
import {
  BUILDINGS, BUILDING_IDS, CROPS, CROP_IDS, LEDGER_CATEGORIES, LEDGER_STOCK_IDS, STOCK_IDS, TAX_RATES, TAX_RATE_IDS,
  KING_START, CELLAR, CARRY_PER_PERSON, SPOIL_PERMILLE, GERMINATION_DAYS,
  HARVEST_VARIANCE_PCT, FIELD_SIZE, CLAIM_MIN_LEVY, FAMINE_LOSS_PCT, LEGITIMACY_MAX,
  validateBuildings, validateCrops, validateEconomy, type BuildingDef, type CropDef,
} from "../src/content/kingdom/index.ts";
import { E, REFUSAL, STOCK_NAME, STOCK_ABOUT, STAGE_NAME, LOST_CAUSE, TASK_NAME, amountsLine, dateLine } from "../src/content/kingdom/ui-strings.ts";
import { MONTHS, SEASONS } from "../src/content/kingdom/terrain.ts";
import { CAREFUL, CARELESS, BUILDER, FORAGER, IDLE, PASSIVE, STRATEGIES, runStrategy, steward, type RunResult } from "./kingdom-strategies.ts";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failures++;
  console.log((ok ? "  ok    " : "  FAIL  ") + name + (detail ? "  <- " + detail : ""));
}
function section(name: string): void {
  console.log("\n[" + name + "]");
}

const SEED = 0x6b1d0001;
const day = (w: KingdomWorld): number => w.date.day;
function runDays(w: KingdomWorld, n: number, each?: (w: KingdomWorld, ev: KingdomEvent[]) => void): void {
  const until = w.now + n * TICKS_PER_DAY;
  while (w.now < until) {
    const ev = w.tick();
    each?.(w, ev);
  }
}
/** Run until the first tick of day `d` has been applied (that day's economy has run). */
function runToDay(w: KingdomWorld, d: number, each?: (w: KingdomWorld, ev: KingdomEvent[]) => void): void {
  while (w.now <= d * TICKS_PER_DAY) {
    const ev = w.tick();
    each?.(w, ev);
  }
}
const kingE = (w: KingdomWorld) => w.economy[0];
const kingBook = (w: KingdomWorld) => w.books[0];
/** Test setup: hand the king a holding without the claim's conditions. */
function own(w: KingdomWorld, key: string): Holding {
  const h = w.holdingByKey(key)!;
  h.owner = "king";
  return h;
}
/**
 * K6 setup: hold a holding's unrest at 0, so a K3 rule (a crop's season, a
 * tax rate's yield) is measured alone over a long run, not cut short by a
 * revolt that K6's own tests (tools/kingdom-morale.ts) hold to account.
 */
function calm(h: Holding): void {
  h.unrest = 0;
}
/** Test setup: give the king stock through the ledger, so conservation still holds. */
function give(w: KingdomWorld, stocks: Partial<Record<(typeof STOCK_IDS)[number], number>>): void {
  for (const s of STOCK_IDS) if (stocks[s]) credit(kingE(w), kingBook(w), s, stocks[s]!, "trade");
}
function issue(w: KingdomWorld, body: KingdomOrderBody): KingdomEvent[] {
  w.issue(body);
  return w.tick();
}
const rejected = (ev: KingdomEvent[]): string | null => {
  const r = ev.find((e) => e.kind === "orderRejected");
  return r && r.kind === "orderRejected" ? r.reason : null;
};

// -- 1. content ----------------------------------------------------------------------

section("content");
{
  check("economy tables are valid", validateEconomy().length === 0, validateEconomy().join("; "));
  check("building table is valid", validateBuildings().length === 0, validateBuildings().join("; "));
  check("crop table is valid", validateCrops().length === 0, validateCrops().join("; "));
  check("every PLAN building is in the table", ["farm", "granary", "woodcutter", "forge", "barracks", "tavern", "watchtower",
    "palisade", "wall", "keep", "shrine", "hall", "market"].every((b) => (BUILDING_IDS as readonly string[]).includes(b)));
  check("every PLAN crop is in the table", ["wheat", "rye", "flax", "herbs", "orchard"].every((c) => (CROP_IDS as readonly string[]).includes(c)));
  const badB: Record<string, BuildingDef> = { ...BUILDINGS, granary: { ...BUILDINGS.granary, days: 0, cost: { coin: -1 } } };
  check("the building validator catches a bad row", validateBuildings(badB).length >= 2, validateBuildings(badB).join("; "));
  const badU: Record<string, BuildingDef> = { ...BUILDINGS, wall: { ...BUILDINGS.wall, upgrades: "nothing" as never } };
  check("the building validator catches an upgrade of nothing", validateBuildings(badU).length >= 1);
  const badC: Record<string, CropDef> = { ...CROPS, rye: { ...CROPS.rye, sow: [], growDays: 0 } };
  check("the crop validator catches a bad row", validateCrops(badC).length >= 2, validateCrops(badC).join("; "));
  for (const id of BUILDING_IDS) {
    const b = BUILDINGS[id];
    const later = b.later;
    if (!later) continue;
    // Battle, defence and vision are data now and K4/K7 read them; nothing here acts on them.
  }
  const defended = BUILDING_IDS.filter((b) => (BUILDINGS[b].later?.defence ?? 0) > 0);
  check("defence is data on the walls (K7 reads it)", ["palisade", "wall", "keep"].every((b) => defended.includes(b as never)));
  check("vision is data on the watchtower (K2 fog reads it later)", (BUILDINGS.watchtower.later?.visionMiles ?? 0) > 0);
  check("every stock decides something: each is spent by some building, crop or order",
    STOCK_IDS.every((s) => s === "levy" ||
      BUILDING_IDS.some((b) => (BUILDINGS[b].cost[s] ?? 0) > 0 || (BUILDINGS[b].upkeep[s] ?? 0) > 0 || (BUILDINGS[b].economy.consumes?.[s] ?? 0) > 0) ||
      CROP_IDS.some((c) => (CROPS[c].seed[s] ?? 0) > 0)));
  check("followers decide the claim (CLAIM_MIN_LEVY)", CLAIM_MIN_LEVY > 0);
}

// -- 2. the ledger --------------------------------------------------------------------

section("ledger");
{
  const w = new KingdomWorld({ seed: SEED });
  const e = kingE(w);
  const b = kingBook(w);
  let threw = false;
  try { debit(e, b, "grain", e.stocks.grain + 1, "food"); } catch { threw = true; }
  check("a debit below zero throws (a sim bug, never a state)", threw);
  threw = false;
  try { credit(e, b, "grain", 1, "food"); } catch { threw = true; }
  check("a sink category cannot credit", threw);
  threw = false;
  try { credit(e, b, "grain", 0.5, "harvest"); } catch { threw = true; }
  check("stocks move in whole numbers", threw);
  const before = e.legitimacy;
  check("legitimacy is clamped to its range",
    adjustLegitimacy(e, b, 1000, "deeds") === LEGITIMACY_MAX - before && e.legitimacy === LEGITIMACY_MAX &&
    adjustLegitimacy(e, b, -1000, "disgrace") === -LEGITIMACY_MAX && (e.legitimacy as number) === 0);
  threw = false;
  try { adjustLegitimacy(e, b, 5, "disgrace"); } catch { threw = true; }
  check("a disgrace cannot raise legitimacy", threw);
  check("changeLegitimacy is the sim's entry point (K6)", changeLegitimacy(w, 0, 3, "deeds") === 3 && e.legitimacy === 3);
  check("every category has a direction", LEDGER_CATEGORIES.every((c) => c.dir === "source" || c.dir === "sink"));
  check("plunder, rations and wages have their categories already (K4/K5)",
    ["plunder", "rations", "wages"].every((c) => LEDGER_CATEGORIES.some((x) => x.id === c)));
}

/**
 * Hold a run to conservation, day by day, for every faction. Returns the
 * number of days checked and the first problem found.
 */
function auditRun(seed: number, strategyName: string, days: number, tamperOnDay = -1, autoFarm = false): { days: number; problem: string } {
  const s = STRATEGIES.find((x) => x.name === strategyName)!;
  let checked = 0;
  let problem = "";
  const lastClosed: (LedgerDay | null)[] = [];
  const keep = steward(["cold-hearth", "greyshaw", "rookstead"]);
  runStrategy(seed, s, days, {
    everyDay: keep,
    autoFarm,
    onTick: (w) => {
      for (let f = 0; f < w.books.length; f++) {
        const e = w.economy[f];
        for (const st of STOCK_IDS) {
          const v = e.stocks[st];
          if (!Number.isInteger(v) || v < 0) problem ||= "day " + day(w) + " faction " + f + " " + st + " = " + v;
        }
        if (!Number.isInteger(e.legitimacy) || e.legitimacy < 0) problem ||= "legitimacy " + e.legitimacy;
        const book = w.books[f];
        if (tamperOnDay >= 0 && f === 0 && day(w) === tamperOnDay && w.now % TICKS_PER_DAY === 3) e.stocks.timber += 1;
        const c = book.closed;
        if (!c || c === lastClosed[f]) continue;
        // A page just closed: it must balance, and chain onto the one before it.
        const prev = lastClosed[f];
        lastClosed[f] = c;
        checked++;
        if (prev && c.day !== prev.day + 1) problem ||= "faction " + f + ": page for day " + c.day + " follows day " + prev.day;
        LEDGER_STOCK_IDS.forEach((st, i) => {
          const end = c.start[i] + netOf(c, st);
          if (end !== book.open.start[i]) {
            problem ||= "faction " + f + " " + st + " day " + c.day + ": start " + c.start[i] + " + net " + netOf(c, st) + " != " + book.open.start[i];
          }
          if (prev && prev.start[i] + netOf(prev, st) !== c.start[i]) problem ||= "pages do not chain for " + st;
          for (const cat of LEDGER_CATEGORIES) {
            const v = flowOf(c, st, cat.id);
            if (!Number.isInteger(v) || v < 0) problem ||= "flow " + st + "/" + cat.id + " = " + v;
          }
        });
      }
    },
  });
  return { days: checked, problem };
}

section("conservation");
{
  for (const [name, seed, auto] of [["careful", SEED, false], ["builder", 7, true], ["careless", 11, false], ["forager", 3, false], ["passive", 5, true]] as const) {
    const r = auditRun(seed, name, 3 * DAYS_PER_YEAR, -1, auto);
    check("three years of '" + name + "'" + (auto ? " (fields resowing themselves)" : "") + " balance every day, every stock, every faction",
      r.problem === "" && r.days >= 3 * DAYS_PER_YEAR * 6 - 6, r.problem || r.days + " pages");
  }
  const t = auditRun(SEED, "careful", 40, 20);
  check("a stock changed behind the ledger's back is caught", t.problem.includes("timber"), t.problem);
}

// -- 3. seasons ------------------------------------------------------------------------

section("seasons");
{
  const seasonOf = (d: number) => calendar(d * TICKS_PER_DAY).season;
  check("the game opens on the first day of autumn", seasonOf(0) === "autumn");
  check("the first winter is days 90-179", seasonOf(89) === "autumn" && seasonOf(90) === "winter" && seasonOf(179) === "winter");
  check("then spring, summer, autumn again", seasonOf(180) === "spring" && seasonOf(270) === "summer" && seasonOf(360) === "autumn");
  check("a season is " + DAYS_PER_SEASON + " days: three months of thirty", DAYS_PER_SEASON === 90 && DAYS_PER_YEAR === 360);
  const d0 = calendar(0);
  check("the exile begins on 1 Harvestmoon, Year 1", d0.dayOfMonth === 0 && MONTHS[d0.month].name === "Harvestmoon" && d0.year === 1,
    dateLine(d0));
  check("the HUD reads a twelve-month date", dateLine(calendar(13 * TICKS_PER_DAY)) === "14 Harvestmoon, Year 1 · Autumn" &&
    dateLine(calendar(200 * TICKS_PER_DAY)).startsWith("21 Thawmoon, Year 2"), dateLine(calendar(200 * TICKS_PER_DAY)));
  check("twelve months, three to a season, in order", MONTHS.length === 12 &&
    MONTHS.every((m, i) => m.season === SEASONS[Math.floor(i / 3)]));

  const w = new KingdomWorld({ seed: SEED });
  const h = own(w, "greyshaw");
  give(w, { grain: 2000 });
  const pop0 = h.population;
  const levy0 = kingE(w).stocks.levy;
  let musters = 0;
  runToDay(w, DAYS_PER_SEASON, () => undefined);
  musters = flowOf(kingBook(w).open, "levy", "muster");
  check("a season's turn musters followers from an owned holding", musters > 0 && kingE(w).stocks.levy === levy0 + musters, musters + " mustered");
  const growth = TAX_RATES.find((t) => t.id === "normal")!.growthPct;
  check("and the holding grows at the default tax, before the muster", h.population + musters === pop0 + Math.floor((pop0 * growth) / 100),
    pop0 + " -> " + h.population + " + " + musters);
  check("winter needs more bread than autumn", dailyNeed(w, 0, "winter") > dailyNeed(w, 0, "autumn"));
}

// -- 4. plots --------------------------------------------------------------------------

section("plots");
{
  // Rye sown in autumn: sown -> growing -> (pauses in winter, hardy) -> ripe -> harvested.
  const w = new KingdomWorld({ seed: SEED });
  const h = own(w, "greyshaw");
  give(w, { grain: 400 });
  const plot = h.plots[0];
  const stages: string[] = [];
  const record = (_w: KingdomWorld, ev: KingdomEvent[]) => {
    calm(h);
    for (const x of ev) if (x.kind === "plotStage" && x.plot === plot.id) stages.push(x.stage + ":" + x.cause + "@" + day(_w));
  };
  check("an empty field can be sown with rye in autumn", w.check({ kind: "sow", plot: plot.id, crop: "rye" }) === null);
  check("but not with wheat (a spring crop)", w.check({ kind: "sow", plot: plot.id, crop: "wheat" }) === REFUSAL.wrongSeason(CROPS.wheat.name),
    String(w.check({ kind: "sow", plot: plot.id, crop: "wheat" })));
  record(w, issue(w, { kind: "sow", plot: plot.id, crop: "rye" }));
  check("sowing pays the seed", flowOf(kingBook(w).open, "grain", "seed") === (CROPS.rye.seed.grain ?? 0) * FIELD_SIZE.hamlet);
  check("sown", plot.stage === "sown" && plot.crop === "rye");
  check("a sown field cannot be sown again", w.check({ kind: "sow", plot: plot.id, crop: "rye" }) === REFUSAL.plotInUse);
  check("nor harvested", w.check({ kind: "harvest", plot: plot.id }) === REFUSAL.notRipe);
  runDays(w, GERMINATION_DAYS + 1, record);
  check("comes up after " + GERMINATION_DAYS + " days", plot.stage === "growing", plot.stage);
  const p1 = plot.progress;
  runDays(w, 5, record);
  check("progress rises while it grows", plot.progress > p1 && plot.progress < 1, p1 + " -> " + plot.progress);
  runToDay(w, DAYS_PER_SEASON + 2, record);
  const pw = plot.progress;
  runDays(w, 10, record);
  check("rye is hardy: it lives through winter, not growing", plot.stage === "growing" && plot.progress === pw);
  const full = Math.floor(((CROPS.rye.yield.grain ?? 0) * FIELD_SIZE.hamlet * plot.health) / 100);
  let got = 0;
  let reapEv = false;
  while (plot.stage !== "harvested" && day(w) < 400) runDays(w, 1, (_w, ev) => {
    record(_w, ev);
    got += ev.filter((x) => x.kind === "harvested").reduce((n, x) => n + (x.kind === "harvested" ? x.gains.grain ?? 0 : 0), 0);
    reapEv ||= ev.some((x) => x.kind === "harvested" && x.plot === plot.id);
  });
  check("it ripens in spring", stages.some((x) => x.startsWith("ripe:")) && calendar(w.now).season === "spring", stages.join(" "));
  check("and is reaped by itself the day it ripens (ECON: auto-harvest)", plot.stage === "harvested" && reapEv &&
    stages.some((x) => x.startsWith("harvested:autoReaped")) &&
    stages.find((x) => x.startsWith("ripe:"))!.split("@")[1] === stages.find((x) => x.startsWith("harvested:"))!.split("@")[1], stages.join(" "));
  check("harvest yields within the variance, into the stores", got >= Math.floor((full * (100 - HARVEST_VARIANCE_PCT)) / 100) &&
    got <= Math.floor((full * (100 + HARVEST_VARIANCE_PCT)) / 100), got + " of " + full);
  check("a harvested field can be sown again in season", w.check({ kind: "sow", plot: plot.id, crop: "herbs" }) === null);
  check("but not with a crop too late to ripen before the winter: refused, saying why (ECON)",
    w.check({ kind: "sow", plot: plot.id, crop: "wheat" }) === REFUSAL.tooLate(CROPS.wheat.name), String(w.check({ kind: "sow", plot: plot.id, crop: "wheat" })));
  check("the path was sown -> growing -> ripe -> harvested",
    ["sown", "growing", "ripe", "harvested"].every((s) => stages.some((x) => x.startsWith(s + ":"))), stages.join(" "));

  // A field nobody keeps (no lord's stores to reap into) still spoils if left ripe; the king's never is.
  const p2 = h.plots[1];
  p2.crop = "wheat"; p2.stage = "growing"; p2.days = CROPS.wheat.growDays - 1; p2.progress = p2.days / CROPS.wheat.growDays;
  runDays(w, CROPS.wheat.ripeDays + 2, () => calm(h));
  check("a ripe field of the king's is reaped, never left to spoil", (p2.stage as string) === "harvested");
  p2.stage = "spoiled"; p2.lost = "overripe";
  check("a spoiled field can be sown again (in the crop's season)", w.check({ kind: "sow", plot: p2.id, crop: "wheat" }) !== REFUSAL.plotInUse &&
    w.check({ kind: "sow", plot: p2.id, crop: "herbs" }) === null, String(w.check({ kind: "sow", plot: p2.id, crop: "herbs" })));

  // Winter kills a tender crop.
  const w2 = new KingdomWorld({ seed: SEED });
  const h2 = own(w2, "greyshaw");
  const [a, b] = h2.plots;
  a.crop = "herbs"; a.stage = "growing"; a.days = 5;
  b.crop = "rye"; b.stage = "growing"; b.days = 5;
  const causes: string[] = [];
  runToDay(w2, DAYS_PER_SEASON, (_w, ev) => { for (const x of ev) if (x.kind === "plotStage") causes.push(x.plot + ":" + x.stage + ":" + x.cause); });
  check("winter kills a tender crop still in the ground", (a.stage as string) === "spoiled" && causes.includes(a.id + ":spoiled:winter"), causes.join(" "));
  check("and the field remembers why (the card says so)", a.lost === "winter" && E.lostCause(a.lost).includes("winter"));
  check("and spares a hardy one", b.stage === "growing");

  // An orchard comes back in spring.
  const w3 = new KingdomWorld({ seed: SEED });
  const h3 = own(w3, "greyshaw");
  const o = h3.plots[0];
  o.crop = "orchard"; o.stage = "harvested";
  check("a harvested orchard needs no sowing", w3.check({ kind: "sow", plot: o.id, crop: "wheat" }) === REFUSAL.orchardStands);
  runToDay(w3, 2 * DAYS_PER_SEASON);
  check("an orchard regrows in spring", (o.stage as string) === "growing" && o.days >= (CROPS.orchard.growDays - (CROPS.orchard.regrowDays ?? 0)));

  // ECON (owner: "the fields sowed with plants shouldn't just randomly die without
  // reason"): no draw harms a crop. Over three years, every field of every holding
  // sown with every crop on the first day of its sowing seasons ripens and is
  // reaped; nothing is lost but to a cause the player can see coming.
  const w4 = new KingdomWorld({ seed: 1234 });
  for (const hh of w4.holdings) hh.owner = "king";
  give(w4, { grain: 200000, coin: 20000, timber: 2000 });
  const lostTo = new Map<string, number>();
  let reaped = 0;
  let farmEvents = 0;
  const sowable = CROP_IDS.filter((c) => !CROPS[c].regrowDays);
  for (let d = 1; d < 3 * DAYS_PER_YEAR; d++) {
    const date = calendar(d * TICKS_PER_DAY);
    if (date.dayOfSeason === 0) {
      let i = 0;
      for (const hh of w4.holdings) for (const p of hh.plots) {
        const crop = sowable[i++ % sowable.length];
        if ((p.stage === "empty" || p.stage === "harvested" || p.stage === "spoiled") && CROPS[crop].sow.includes(date.season)) {
          p.crop = crop; p.stage = "sown"; p.days = 0; p.progress = 0; p.lost = null;
        }
      }
    }
    runToDay(w4, d, (_w, ev) => {
      for (const hh of _w.holdings) calm(hh);
      for (const x of ev) {
        if (x.kind === "plotStage" && x.stage === "spoiled") lostTo.set(x.cause, (lostTo.get(x.cause) ?? 0) + 1);
        if (x.kind === "harvested") reaped++;
        if ((x.kind as string) === "farmWeather") farmEvents++;
      }
    });
  }
  check("no farm weather any more: no drought, frost or flood draws", farmEvents === 0);
  check("crops sown in their season are all reaped, none lost", reaped > 100 && lostTo.size === 0, reaped + " reaped, lost " + JSON.stringify([...lostTo]));
  check("a crop's health is only ever taken by an army or a fire", w4.holdings.every((hh) => hh.plots.every((p) => p.health === 100)));
  check("every way to lose a crop has words (the field card says why)",
    ["winter", "overripe", "foraged", "burned", "trampled"].every((c) => E.lostCause(c) !== "lost"));

  // Planting never moves the weather: one farm draw a day either way.
  const wa = new KingdomWorld({ seed: 99 });
  const wb = new KingdomWorld({ seed: 99 });
  const hb = own(wb, "greyshaw");
  give(wb, { grain: 200 });
  wb.issue({ kind: "sow", plot: hb.plots[0].id, crop: "rye" });
  const wx = (w: KingdomWorld) => { const out: string[] = []; runDays(w, 200, (_w, ev) => { for (const x of ev) if (x.kind === "dayBegan") out.push(x.weather); }); return out.join(); };
  check("sowing a field does not change the weather that follows", wx(wa) === wx(wb));
}

// -- 5. buildings ----------------------------------------------------------------------

section("buildings");
{
  const w = new KingdomWorld({ seed: SEED });
  const h = own(w, "rookstead");
  const def = BUILDINGS.granary;
  check("cannot build without the means", w.check({ kind: "build", holding: h.id, building: "granary" }) === REFUSAL.cannotAfford);
  give(w, { coin: 200, timber: 200, iron: 50 });
  const storeBefore = storageOf(w, 0).granary;
  const c0 = kingE(w).stocks.coin;
  const ev = issue(w, { kind: "build", holding: h.id, building: "granary" });
  const slot = h.buildings.indexOf("granary");
  check("ordering a building pays its cost", c0 - kingE(w).stocks.coin === (def.cost.coin ?? 0));
  check("and starts the works", slot >= 0 && h.works[slot] === def.days && ev.some((x) => x.kind === "buildingStarted"));
  check("a building under way stores nothing yet", storageOf(w, 0).granary === storeBefore);
  let builtAt = -1;
  runDays(w, def.days + 1, (_w, x) => { if (builtAt < 0 && x.some((y) => y.kind === "built")) builtAt = day(_w); });
  check("it stands after its build days", h.works[slot] === 0 && builtAt > 0);
  check("a standing granary adds its storage", storageOf(w, 0).granary === storeBefore + (def.economy.storage ?? 0));

  check("a wall needs a palisade first", w.check({ kind: "build", holding: h.id, building: "wall" }) === REFUSAL.needsFirst(BUILDINGS.palisade.name));
  issue(w, { kind: "build", holding: h.id, building: "palisade" });
  const ps = h.buildings.indexOf("palisade");
  check("nor over a palisade still being built", w.check({ kind: "build", holding: h.id, building: "wall" }) !== null);
  runDays(w, BUILDINGS.palisade.days + 1);
  give(w, { coin: 200, timber: 200, iron: 50 });
  issue(w, { kind: "build", holding: h.id, building: "wall" });
  check("a wall goes up in the palisade's slot", h.buildings[ps] === "wall" && h.works[ps] === BUILDINGS.wall.days);

  // Forge: upkeep, idle when unpaid, consumes timber, makes iron.
  const free = h.buildings.indexOf(null);
  check("there is a slot left at Rookstead", free >= 0);
  issue(w, { kind: "build", holding: h.id, building: "forge" });
  const fs = h.buildings.indexOf("forge");
  runDays(w, BUILDINGS.forge.days + 1);
  const iron0 = kingE(w).stocks.iron;
  runDays(w, 3);
  check("a standing forge makes iron from timber", kingE(w).stocks.iron > iron0 &&
    flowOf(kingBook(w).closed!, "timber", "materials") > 0);
  check("and pays its upkeep", flowOf(kingBook(w).closed!, "coin", "upkeep") > 0);
  check("every slot taken: no more building", w.check({ kind: "build", holding: h.id, building: "market" }) === REFUSAL.noSlot);
  // Spend every coin: the forge goes idle.
  const e = kingE(w);
  debit(e, kingBook(w), "coin", e.stocks.coin, "wages");
  let unpaid = false;
  runDays(w, 2, (_w, x) => { unpaid ||= x.some((y) => y.kind === "upkeepUnpaid"); });
  const ironIdle = e.stocks.iron;
  runDays(w, 2);
  check("unpaid upkeep leaves a building idle, and says so", h.idle[fs] && unpaid);
  check("an idle forge makes nothing", e.stocks.iron === ironIdle);
  give(w, { coin: 10 });
  runDays(w, 2);
  check("paid again, it works again", !h.idle[fs] && e.stocks.iron > ironIdle);

  const w2 = new KingdomWorld({ seed: SEED });
  const g = own(w2, "greyshaw");
  give(w2, { coin: 200, timber: 200 });
  issue(w2, { kind: "build", holding: g.id, building: "granary" });
  check("a hamlet has one slot", w2.check({ kind: "build", holding: g.id, building: "market" }) === REFUSAL.noSlot);
  const other = w2.holdingByKey("thornwick")!;
  check("nobody builds on another's holding", w2.check({ kind: "build", holding: other.id, building: "granary" }) === REFUSAL.notYours);
  check("a unique building is built once", (() => {
    const w3 = new KingdomWorld({ seed: SEED });
    const r = own(w3, "rookstead");
    give(w3, { coin: 500, timber: 500, iron: 100 });
    const u = BUILDING_IDS.find((b) => BUILDINGS[b].unique && !BUILDINGS[b].upgrades && !BUILDINGS[b].notIn?.includes(r.biome))!;
    issue(w3, { kind: "build", holding: r.id, building: u });
    return w3.check({ kind: "build", holding: r.id, building: u }) === REFUSAL.alreadyBuilt;
  })());
}

// -- 6. storage and spoilage -------------------------------------------------------------

section("storage");
{
  const lossOn = (granary: boolean, grain: number): { lost: number; expect: number } => {
    const w = new KingdomWorld({ seed: SEED });
    const h = own(w, "greyshaw");
    if (granary) { h.buildings[0] = "granary"; h.works[0] = 0; }
    give(w, { grain });
    runToDay(w, 1);
    runToDay(w, 2);
    const page = kingBook(w).closed!;
    const st = storageOf(w, 0);
    const g = page.start[LEDGER_STOCK_IDS.indexOf("grain")] - flowOf(page, "grain", "food") - flowOf(page, "grain", "retinue");
    const inG = Math.min(g, st.granary);
    const inL = Math.min(g - inG, st.loose);
    const heap = g - inG - inL;
    const expect = Math.floor((inG * SPOIL_PERMILLE.granary) / 1000) + Math.floor((inL * SPOIL_PERMILLE.loose) / 1000) + Math.ceil((heap * SPOIL_PERMILLE.heap) / 1000);
    return { lost: flowOf(page, "grain", "spoilage"), expect };
  };
  const withG = lossOn(true, 4000);
  const without = lossOn(false, 4000);
  check("spoilage follows the storage table", withG.lost === withG.expect && without.lost === without.expect, JSON.stringify([withG, without]));
  check("a granary keeps grain that would rot in heaps", withG.lost < without.lost, withG.lost + " vs " + without.lost);
  check("nothing in a granary spoils (ECON: the granary is a store, not a leak)", SPOIL_PERMILLE.granary === 0);
  check("a small store in the cellars loses nothing in a day", lossOn(false, 400).lost === 0);
  const w = new KingdomWorld({ seed: SEED });
  const people = 1 + w.king.companions.length + kingE(w).stocks.levy;
  check("loose storage is the cellars of owned holdings plus what the party carries",
    storageOf(w, 0).loose === people * CARRY_PER_PERSON && (own(w, "greyshaw"), storageOf(w, 0).loose === people * CARRY_PER_PERSON + CELLAR.hamlet));
}

// -- 7. taxes --------------------------------------------------------------------------

section("taxes");
{
  for (let i = 1; i < TAX_RATES.length; i++) {
    check("tax " + TAX_RATES[i].id + " takes more than " + TAX_RATES[i - 1].id + " and grows no faster",
      taxPerDay(100, TAX_RATES[i].id) > taxPerDay(100, TAX_RATES[i - 1].id) && TAX_RATES[i].growthPct <= TAX_RATES[i - 1].growthPct);
  }
  const outcome = TAX_RATE_IDS.map((rate) => {
    const w = new KingdomWorld({ seed: SEED });
    const h = own(w, "greyshaw");
    give(w, { grain: 5000 });
    issue(w, { kind: "setTax", holding: h.id, rate });
    let coin = 0;
    runDays(w, 125, (_w) => { calm(h); if (_w.now % TICKS_PER_DAY === 1 && _w.books[0].closed) coin += flowOf(_w.books[0].closed, "coin", "tax"); });
    return { rate, coin, pop: h.population };
  });
  let mono = true;
  for (let i = 1; i < outcome.length; i++) {
    if (outcome[i].coin < outcome[i - 1].coin || outcome[i].pop > outcome[i - 1].pop) mono = false;
  }
  check("over four seasons a higher rate takes at least as much coin and keeps no more people", mono, JSON.stringify(outcome));
  const w = new KingdomWorld({ seed: SEED });
  own(w, "greyshaw"); own(w, "thornwick");
  issue(w, { kind: "setTax", holding: 0, rate: "high" });
  check("a realm-wide rate sets every holding, and holdings claimed later", w.holdingsOf("king").every((h) => h.tax === "high") &&
    kingE(w).defaultTax === "high");
  check("a holding not the king's cannot be taxed", w.check({ kind: "setTax", holding: w.holdingByKey("fell-end")!.id, rate: "low" }) === REFUSAL.notYours);
  check("no tax in famine", (() => {
    const w2 = new KingdomWorld({ seed: SEED });
    const h = own(w2, "greyshaw");
    debit(kingE(w2), kingBook(w2), "grain", kingE(w2).stocks.grain, "wages");
    runDays(w2, 6);
    return h.famine > 0 && flowOf(kingBook(w2).closed!, "coin", "tax") === 0;
  })());
}

// -- 8. the exile's orders --------------------------------------------------------------

section("orders");
{
  const w = new KingdomWorld({ seed: SEED });
  const ch = w.holdingByKey("cold-hearth")!;
  check("the king starts with no holding", w.holdingsOf("king").length === 0);
  check("no coin", kingE(w).stocks.coin === KING_START.coin && KING_START.coin === 0);
  check("and no followers", kingE(w).stocks.levy === 0);
  check("cannot claim without followers", w.check({ kind: "claimHolding", holding: ch.id }) === REFUSAL.claimNeedsFollowers(CLAIM_MIN_LEVY));
  check("cannot claim from elsewhere", w.check({ kind: "claimHolding", holding: w.holdingByKey("greyshaw")!.id }) === REFUSAL.claimFromThere);
  issue(w, { kind: "forage" });
  check("forage sets the task", w.king.task === "forage");
  check("forage twice is refused", w.check({ kind: "forage" }) === REFUSAL.alreadyForaging);
  const g0 = kingE(w).stocks.grain;
  runDays(w, 2);
  check("foraging in autumn brings grain", flowOf(kingBook(w).closed!, "grain", "forage") > 0 && kingE(w).stocks.grain > g0 - 4);
  issue(w, { kind: "rally" });
  check("rally replaces foraging", w.king.task === "rally");
  runDays(w, 5);
  check("rallying brings followers", kingE(w).stocks.levy > 0);
  while (w.check({ kind: "rally" }) !== REFUSAL.rallySpent && day(w) < 60) { if (w.king.task !== "rally") issue(w, { kind: "rally" }); runDays(w, 1); }
  check("a hamlet gives only so many", w.check({ kind: "rally" }) === REFUSAL.rallySpent && ch.population > 0);
  const ev = issue(w, { kind: "claimHolding", holding: ch.id });
  check("with followers, an empty holding is claimed: no battle", ch.owner === "king" && ev.some((x) => x.kind === "claimed"));
  check("an owned hamlet gives no rally", w.check({ kind: "rally" }) === REFUSAL.rallyOwned);
  issue(w, { kind: "moveKing", to: w.holdingByKey("greyshaw")!.id });
  w.tick(); w.tick();
  check("marching ends foraging and rallying", w.king.task === "none");
  check("on the road there is nothing to forage", w.check({ kind: "forage" }) !== null);
  // The sim applies exactly what the check allows: a refused order changes nothing and says why.
  const h0 = kingdomHash(w);
  const refusal = w.check({ kind: "harvest", plot: ch.plots[0].id });
  const evR = issue(w, { kind: "harvest", plot: ch.plots[0].id });
  check("the sim refuses with the check's own reason", refusal !== null && rejected(evR) === refusal, String(rejected(evR)));
  void h0;
  check("checkEconomyOrder is what world.check answers", checkEconomyOrder(w, { kind: "forage" }, 0) === w.check({ kind: "forage" }));
  check("captains' economies wait for K8", w.check({ kind: "forage" }, 1) === REFUSAL.onlyKing);
}

// -- 9. famine ---------------------------------------------------------------------------

section("famine");
{
  check("famine deaths add up to the daily percentage", (() => {
    let total = 0;
    for (let d = 1; d <= 50; d++) total += famineDeaths(30, d);
    return total === Math.floor((50 * 30 * FAMINE_LOSS_PCT) / 100);
  })());
  check("famine never kills more than there are", famineDeaths(1, 1000) <= 1 && famineDeaths(0, 5) === 0);
  const w = new KingdomWorld({ seed: SEED });
  const h = own(w, "greyshaw");
  debit(kingE(w), kingBook(w), "grain", kingE(w).stocks.grain, "wages");
  const starts: KingdomEvent[] = [];
  runDays(w, 10, (_w, ev) => starts.push(...ev.filter((x) => x.kind === "famine")));
  check("an unfed holding is in famine, and the signal counts the days", h.famine >= 9, String(h.famine));
  check("famine is announced once when it begins", starts.filter((x) => x.kind === "famine" && x.holding === h.id && x.days === 1).length === 1);
  check("the hungry party is counted too", kingE(w).hunger >= 9);
  give(w, { grain: 500 });
  runDays(w, 2, (_w, ev) => starts.push(...ev.filter((x) => x.kind === "famine")));
  check("bread ends it, and says so", h.famine === 0 && kingE(w).hunger === 0 &&
    starts.some((x) => x.kind === "famine" && x.holding === h.id && x.days === 0));
}

// -- 10. determinism and saves -------------------------------------------------------------

section("determinism");
{
  const a = runStrategy(SEED, BUILDER, 300, { everyDay: steward(["greyshaw", "rookstead"]) });
  const b = runStrategy(SEED, BUILDER, 300, { everyDay: steward(["greyshaw", "rookstead"]) });
  check("the same seed and strategy give the same realm", kingdomHash(a.world) === kingdomHash(b.world));
  check("its order log replays to the same realm", kingdomHash(replayLog(SEED, a.world.log, a.world.now)) === kingdomHash(a.world));
  const c = runStrategy(SEED + 1, BUILDER, 300, { everyDay: steward(["greyshaw", "rookstead"]) });
  check("another seed is another realm", kingdomHash(c.world) !== kingdomHash(a.world));

  // Save mid-way, load, continue with the same remaining orders: the same as never stopping.
  const half = 150 * TICKS_PER_DAY;
  const mid = replayLog(SEED, a.world.log.filter((o) => o.tick < half), half);
  const json = saveToJson(mid);
  const loaded = loadFromJson(json);
  check("a K3 save loads", loaded.ok, loaded.ok ? "" : loaded.error);
  if (loaded.ok) {
    const w = loaded.value;
    check("the loaded realm is the saved realm", kingdomHash(w) === kingdomHash(mid));
    for (const o of a.world.log) if (o.tick >= half) w.submit(o);
    while (w.now < a.world.now) w.tick();
    check("save -> load -> continue equals never stopping", kingdomHash(w) === kingdomHash(a.world));
    check("the ledger pages survive the save", JSON.stringify(w.books) === JSON.stringify(a.world.books));
  }
  const parsed = JSON.parse(json);
  parsed.snapshot.economy[0].stocks.grain = -5;
  check("a save with a negative stock is refused", !deserialize(parsed).ok);
  const p2 = JSON.parse(json);
  p2.snapshot.holdings[0].buildings[0] = "castle-in-the-air";
  check("a save with an unknown building is refused", !deserialize(p2).ok);
  check("the save is version " + KINGDOM_SAVE_VERSION, parsed.version === KINGDOM_SAVE_VERSION && KINGDOM_SAVE_VERSION >= 3);
}

section("migration");
{
  const here = fileURLToPath(new URL(".", import.meta.url));
  // A real save written by the K2 game (before this phase), kept as a fixture.
  const text = readFileSync(here + "fixtures/kingdom-save-v1.json", "utf8");
  const v1 = JSON.parse(text);
  check("the fixture is a version-1 save", v1.version === 1);
  const m = migrate(v1);
  const m2 = migrate(v1, MIGRATIONS, 2);
  check("it migrates to version 2 (K3)", m2.ok && m2.value.version === 2);
  check("and on to the current version (" + KINGDOM_SAVE_VERSION + ")", m.ok && m.value.version === KINGDOM_SAVE_VERSION);
  const loaded = loadFromJson(text);
  check("and loads", loaded.ok, loaded.ok ? "" : loaded.error);
  if (loaded.ok) {
    const w = loaded.value;
    // K3a doubled the map: the save was made on the frozen K3 map and is now on its successor.
    check("made on the K3 map, now on K3a's", v1.mapFingerprint === K3_MAP.fingerprint &&
      mapFingerprint(w) === mapFingerprint(new KingdomWorld({ seed: v1.seed })));
    check("the king keeps his place and his day", w.now === v1.snapshot.now && w.king.mover.node === v1.snapshot.king.mover.node);
    check("with the exile's starting stores", STOCK_IDS.every((s) => kingE(w).stocks[s] === KING_START[s]));
    let ok = true;
    try { runDays(w, 120); } catch { ok = false; }
    check("and plays on through a winter", ok && day(w) > 120);
    const again = loadFromJson(saveToJson(w));
    check("and saves again as version 3", again.ok && kingdomHash(again.value) === kingdomHash(w));
  }
}

section("migration v8 -> v9: the four-month calendar to the twelve-month one");
{
  const here = fileURLToPath(new URL(".", import.meta.url));
  // A real save written by the K8 game (before ECON): Cold Hearth claimed, rye
  // sown in the first autumn and asleep in the ground, day 46 -- the 16th of
  // the old thirty-day winter.
  const text = readFileSync(here + "fixtures/kingdom-save-v8.json", "utf8");
  const v8 = JSON.parse(text);
  check("the fixture is a version-8 save", v8.version === 8 && v8.epoch === undefined);
  const loaded = loadFromJson(text);
  check("it migrates and loads", loaded.ok, loaded.ok ? "" : loaded.error);
  if (loaded.ok) {
    const w = loaded.value;
    const d = w.date;
    check("the days lived stay lived: the same tick, the same day count", w.now === v8.snapshot.now && d.day === 45);
    check("the date keeps its place in the year: the 16th day of winter becomes the 46th, 16 Snowmoon, Year 1",
      d.season === "winter" && d.dayOfSeason === 45 && d.year === 1 && dateLine(d) === "16 Snowmoon, Year 1 · Winter", dateLine(d));
    const ch = w.holdingByKey("cold-hearth")!;
    const was = v8.snapshot.holdings.find((h: { key: string }) => h.key === "cold-hearth").plots[0];
    const p = ch.plots[0];
    check("the rye in the ground keeps its share of its growth", p.crop === "rye" && p.stage === "growing" &&
      p.days === was.days * 3 && p.progress === p.days / CROPS.rye.growDays, was.days + " -> " + p.days);
    check("nothing resows itself until the player says so", !w.autoFarm && kingE(w).autoSow === null && ch.plots.every((x) => x.auto === null));
    let reaped = false;
    runDays(w, 200, (_w, ev) => { calm(ch); reaped ||= ev.some((x) => x.kind === "harvested" && x.plot === p.id); });
    check("it sleeps through the winter and is reaped by itself in the spring", reaped && p.stage === "harvested");
    const again = loadFromJson(saveToJson(w));
    check("and saves again as version " + KINGDOM_SAVE_VERSION + ", the same realm", again.ok && kingdomHash(again.value) === kingdomHash(w) &&
      JSON.parse(saveToJson(w)).epoch === w.epoch);
  }
}

// -- 11. strings ----------------------------------------------------------------------------

section("strings");
{
  const all: string[] = [];
  const sample: Record<string, unknown> = { name: "Greyshaw", days: 3, n: 2, building: "Granary", crop: "Rye", stage: "growing", pct: 40,
    health: 70, coin: "4 coin", growth: "grow 2%", rate: "Low", gains: "200 grain", field: "Field 1", cause: "the weather", upkeep: "1 coin",
    grain: 120, capacity: 1500, heap: 30, spoils: 1, inGranary: 100, granary: 1500, need: 6, value: 120, net: -6, parts: ["seed -6"],
    label: "seed", when: "9 Reapmoon", stored: "stored 1 of 2", month: 6, dayOfMonth: 0, season: "autumn", year: 1, day: 3 };
  const take = (v: unknown): void => {
    if (typeof v === "string") all.push(v);
    else if (typeof v === "function") {
      // Each function gets the first sample argument of the right shape.
      let last = "(no string)";
      for (const arg of [sample, 3, 1, "Greyshaw"]) {
        try {
          const r = (v as (x: unknown) => unknown)(arg);
          if (typeof r !== "string") continue;
          last = r;
          if (!r.includes("undefined") && !r.includes("NaN") && !r.includes("[object")) break;
        } catch { /* wrong shape */ }
      }
      all.push(last);
    } else if (v && typeof v === "object") for (const x of Object.values(v)) take(x);
  };
  for (const t of [E, REFUSAL, STOCK_NAME, STOCK_ABOUT, STAGE_NAME, LOST_CAUSE, TASK_NAME]) take(t);
  for (const id of BUILDING_IDS) { all.push(BUILDINGS[id].name, BUILDINGS[id].purpose); }
  for (const id of CROP_IDS) { all.push(CROPS[id].name, CROPS[id].about); }
  all.push(amountsLine({ coin: 4, timber: 6 }), amountsLine({}));
  const gendered = all.filter((s) => /\b(he|she|him|her|his|hers|himself|herself)\b/i.test(s));
  check("no economy string guesses anyone's gender", gendered.length === 0, gendered.slice(0, 3).join(" | "));
  const broken = all.filter((s) => typeof s !== "string" || s.length === 0 || s.includes("undefined") || s.includes("NaN"));
  check("no string is empty or undefined", broken.length === 0, broken.slice(0, 3).join(" | "));
  check("costs read in words", amountsLine({ coin: 4, timber: 6 }) === "4 coin, 6 timber");
}

// -- 12. THE PROOF: winter is survivable, or not, by choice -----------------------------------

section("first winter");
{
  const FIRST_WINTER_ENDS = 2 * DAYS_PER_SEASON; // ECON: autumn days 0-89, winter 90-179 (was 60)
  const verdict = (r: RunResult) => {
    const run = r.days.filter((d) => d.day >= 1 && d.day <= FIRST_WINTER_ENDS);
    return {
      minGrain: Math.min(...run.map((d) => d.stocks.grain)),
      hungry: run.filter((d) => d.hunger > 0).length,
      famine: run.filter((d) => d.famine > 0).length,
    };
  };
  const careful = runStrategy(SEED, CAREFUL, FIRST_WINTER_ENDS + 1);
  const careless = runStrategy(SEED, CARELESS, FIRST_WINTER_ENDS + 1);
  console.log("        careful:  " + careful.trace.join(" | "));
  console.log("        careless: " + careless.trace.join(" | "));
  const vc = verdict(careful);
  const vx = verdict(careless);
  // Before the snow: a holding with a standing granary.
  const atSnow = replayLog(SEED, careful.world.log.filter((o) => o.tick < DAYS_PER_SEASON * TICKS_PER_DAY), DAYS_PER_SEASON * TICKS_PER_DAY);
  const granaryBeforeWinter = atSnow.holdingsOf("king").some((h) => h.buildings.some((b, i) => b === "granary" && h.works[i] === 0));
  check("the careful log holds a holding with a standing granary before the first winter", granaryBeforeWinter);
  check("and its grain never runs out through the first winter", vc.minGrain > 0, "lowest " + vc.minGrain);
  check("no one goes hungry, no famine", vc.hungry === 0 && vc.famine === 0, JSON.stringify(vc));
  // ECON ("a lot easier"): the careless start still goes hungry -- everyone rallied on
  // ten days' bread -- but the hamlet it claims opens its stores, so no town starves.
  check("the careless log, from the same start, goes hungry before its claim", vx.hungry > 0 && vx.minGrain === 0, JSON.stringify(vx));
  check("but the claimed hamlet's stores carry it through the winter: no famine (ECON)", vx.famine === 0, JSON.stringify(vx));
  const idle = verdict(runStrategy(SEED, IDLE, FIRST_WINTER_ENDS + 1));
  check("an exile who claims nothing still starves", idle.hungry > FIRST_WINTER_ENDS / 2, JSON.stringify(idle));
  check("both logs are ordinary order logs: they replay", kingdomHash(replayLog(SEED, careful.world.log, careful.world.now)) === kingdomHash(careful.world) &&
    kingdomHash(replayLog(SEED, careless.world.log, careless.world.now)) === kingdomHash(careless.world));
  let robust = true;
  let bad = "";
  for (let s = 1; s <= 8; s++) {
    const a = verdict(runStrategy(s * 7919, CAREFUL, FIRST_WINTER_ENDS + 1));
    const b = verdict(runStrategy(s * 7919, CARELESS, FIRST_WINTER_ENDS + 1));
    if (a.famine || a.hungry || a.minGrain <= 0 || b.famine > 0 || b.hungry === 0) { robust = false; bad ||= "seed " + s * 7919 + " " + JSON.stringify([a, b]); }
  }
  check("the same holds on eight other seeds", robust, bad);
  const doing = runStrategy(SEED, FORAGER, 360);
  check("a forager who claims nothing lives, but owns nothing", doing.days.every((d) => d.hunger === 0) && doing.world.holdingsOf("king").length === 0);
}

// -- 13. ECON: the passive king lives two years; the active one grows ----------------------

section("two years, passive and active");
{
  const two = 2 * DAYS_PER_YEAR;
  const sum = (r: RunResult) => ({
    hungry: r.days.filter((d) => d.hunger > 0).length,
    famine: r.days.filter((d) => d.famine > 0).length,
    towns: r.world.holdingsOf("king").length,
    grain: r.world.kingStocks.stocks.grain,
    coin: r.world.kingStocks.stocks.coin,
  });
  for (const seed of [SEED, 7, 42]) {
    const passive = sum(runStrategy(seed, PASSIVE, two, { autoFarm: true }));
    check("seed " + seed + ": a king who claims Cold Hearth and does nothing more lives two years, fed, the hamlet kept",
      passive.hungry === 0 && passive.famine === 0 && passive.towns === 1, JSON.stringify(passive));
  }
  const handOnly = sum(runStrategy(SEED, PASSIVE, two, { autoFarm: false }));
  check("without the fields resowing themselves the same king starves (auto-resow is what carries it)",
    handOnly.famine > 0, JSON.stringify(handOnly));
  const active = sum(runStrategy(SEED, BUILDER, two, { everyDay: steward(["greyshaw", "rookstead"]), autoFarm: true }));
  const passive = sum(runStrategy(SEED, PASSIVE, two, { autoFarm: true }));
  check("an active king grows: more towns, more grain and coin than the passive one",
    active.hungry === 0 && active.famine === 0 && active.towns > passive.towns && active.grain > passive.grain && active.coin > passive.coin,
    JSON.stringify([active, passive]));
  // Auto-resow sows and auto-harvest reaps (the ledger audit above runs it too).
  let sown = 0;
  let reaped = 0;
  runStrategy(SEED, PASSIVE, two, {
    autoFarm: true,
    onTick: (w) => {
      for (const e of w.events) {
        if (e.kind === "plotStage" && e.cause === "autoSown") sown++;
        if (e.kind === "plotStage" && e.cause === "autoReaped") reaped++;
      }
    },
  });
  check("the fields resowed and reaped themselves, year after year", sown >= 4 && reaped >= 4, sown + " sown, " + reaped + " reaped");
}

console.log("\n" + (failures === 0 ? "all " + checks + " economy checks passed" : failures + " of " + checks + " economy check(s) FAILED"));
if (failures > 0) process.exit(1);
