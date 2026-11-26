/**
 * K6 test suite: morale, unrest and legitimacy (PLAN.md §B.6, §B.11 K6).
 * Part of `npm test`; headless, no DOM.
 *
 * THE PROOF is monotonicity: for every cause and every lever, two worlds the
 * same in all but that one input, a day apart, and the stat it is meant to
 * move moves the way its row in content/kingdom/morale.ts says -- and
 * nothing else moves but what the row declares (its cost, its side effect).
 * In the style of Phase 6's "no doctrine strictly better": a test per input.
 *
 * Also held:
 *   - the thresholds: half taxes at RESTLESS_AT, a revolt at REVOLT_AT (a
 *     rebel host of the old lord's banner, or the town only flips);
 *   - army morale: hunger and pay, the king's presence, legitimacy, terror,
 *     a victory; desertion below the floor; and the link into battle -- the
 *     BattleSpec's starting morale (K5's nerve) is the army's;
 *   - the politics card's list is the sim's (one function);
 *   - orders: one check for the button and the tick;
 *   - save v6: round trip, the v5 -> v6 migration, the log replays;
 *   - the ledger balances with festivals and justices on it.
 */

import {
  KingdomWorld, kingdomHash, loadFromJson, saveToJson, serialize, deserialize, replayLog, migrate, KINGDOM_SAVE_VERSION,
  TICKS_PER_DAY, DAYS_PER_SEASON, armyMen, armyById, raiseArmy, standsIn, credit, debit, flowOf, netOf, armyRestMorale,
  unrestCauses, unrestTrend, festivalCost, changeMercy, battleLostUnrest, buildBattleSpec, rebelFaction, isRestless,
  type Army, type Holding, type KingdomEvent, type KingdomOrderBody, type Contact, type LedgerDay,
} from "../src/sim/kingdom/index.ts";
import type { BattleSpec } from "../src/sim/layers.ts";
import {
  FACTION_IDS, LEDGER_STOCK_IDS, LEDGER_CATEGORY_IDS, STOCK_IDS, TAX_RATE_IDS, nerveFromMorale,
  ARMY_MORALE, CLAIM_UNREST, CUSTOM_UNREST, FAMINE_UNREST, FESTIVAL, FORAGED_UNREST, JUSTICE, LEGITIMACY_UNREST,
  LOST_BATTLE_UNREST, MERCY_CALM_PER, MERCY_MAX, MERCY_MIN, MUSTER_UNREST, PARDON, QUARTERED_UNREST, RESTLESS_AT,
  REVOLT, REVOLT_AT, SHRINE_UNREST_SCALE, TAX_UNREST, UNREST_CAUSE_IDS, UNREST_MAX, validateMorale,
  MORALE_REFUSAL, CAUSE_LABEL, unrestPoints,
} from "../src/content/kingdom/index.ts";

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

const SEED = 0x6b1d0006;
const KING = 0;
const id = (w: KingdomWorld, key: string): number => w.holdingByKey(key)!.id;

/** Tick through the next day's first tick (that day's economy, armies and morale have run). */
function nextDay(w: KingdomWorld, each?: (ev: KingdomEvent[]) => void): void {
  do {
    const ev = w.tick();
    each?.(ev);
  } while (w.now % TICKS_PER_DAY !== 1);
}
function days(w: KingdomWorld, n: number, each?: (ev: KingdomEvent[]) => void): void {
  for (let i = 0; i < n; i++) nextDay(w, each);
}
/** Test setup through the ledger, so conservation still holds. */
function give(w: KingdomWorld, stocks: Partial<Record<(typeof STOCK_IDS)[number], number>>): void {
  for (const s of STOCK_IDS) if (stocks[s]) credit(w.economy[KING], w.books[KING], s, stocks[s]!, "trade");
}
function take(w: KingdomWorld, s: (typeof STOCK_IDS)[number]): void {
  const n = w.economy[KING].stocks[s];
  if (n > 0) debit(w.economy[KING], w.books[KING], s, n, "offerings");
}
function issue(w: KingdomWorld, body: KingdomOrderBody): KingdomEvent[] {
  w.issue(body);
  return w.tick();
}
const rejectedWith = (ev: KingdomEvent[]): string | null => {
  const r = ev.find((e) => e.kind === "orderRejected");
  return r && r.kind === "orderRejected" ? r.reason : null;
};

/**
 * The fixture: day 1 of a fresh exile; Greyshaw is the king's, with some
 * unrest already (so a calming cause has room to work and custom applies),
 * bread and coin in the stores. Every variant below changes ONE input.
 */
function town(seed = SEED): { w: KingdomWorld; h: Holding } {
  const w = new KingdomWorld({ seed });
  nextDay(w);
  const h = w.holdingByKey("greyshaw")!;
  h.owner = "king";
  h.unrest = 300;
  give(w, { grain: 600, coin: 200 });
  return { w, h };
}

/** Everything K6 could move, by name: the stats and the stocks. */
function state(w: KingdomWorld): Map<string, number | string> {
  const m = new Map<string, number | string>();
  for (const h of w.holdings) { m.set("unrest:" + h.key, h.unrest); m.set("owner:" + h.key, String(h.owner)); }
  m.set("legitimacy", w.economy[KING].legitimacy);
  m.set("mercy", w.economy[KING].mercy);
  for (const a of w.armies) m.set("morale:" + a.id, a.morale);
  for (const s of STOCK_IDS) m.set("stock:" + s, w.economy[KING].stocks[s]);
  m.set("armies", w.armies.length);
  return m;
}
function diff(a: Map<string, number | string>, b: Map<string, number | string>): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort();
}

/**
 * Run the fixture a day as it is and a day with `vary` applied; the
 * variant's change in `stat`, the baseline's, and every key that differs.
 */
function vary(name: string, setup: (w: KingdomWorld, h: Holding) => void, run = 1, base?: (w: KingdomWorld, h: Holding) => void) {
  const b = town();
  const v = town();
  base?.(b.w, b.h);
  base?.(v.w, v.h);
  setup(v.w, v.h);
  const u0 = b.h.unrest;
  const uv0 = v.h.unrest;
  days(b.w, run);
  days(v.w, run);
  const differs = diff(state(b.w), state(v.w));
  return { name, b, v, dBase: b.h.unrest - u0, dVar: v.h.unrest - uv0, differs };
}
/** Every differing key is one the cause's row declares. */
function only(differs: string[], allowed: string[]): boolean {
  return differs.every((k) => allowed.includes(k));
}

// -- 0. content -----------------------------------------------------------------------------------

section("the tables");
{
  const p = validateMorale();
  check("the morale tables are valid", p.length === 0, p.join("; "));
  check("unrest shown as 0..100 with one decimal", unrestPoints(0) === "0" && unrestPoints(305) === "30.5" && unrestPoints(-15) === "-1.5" && unrestPoints(1000) === "100");
  check("every cause has a label on the politics card", UNREST_CAUSE_IDS.every((c) => typeof CAUSE_LABEL[c] === "string" && CAUSE_LABEL[c].length > 0));
}

// -- 1. THE PROOF: each cause moves unrest its way, and nothing else ----------------------------------

section("THE PROOF: each cause moves unrest the way its row says, and nothing else");
{
  // The baseline: normal tax (0), low legitimacy (+2), custom (-3).
  const { w, h } = town();
  const rows = unrestCauses(w, h).map((c) => c.cause + ":" + c.permille).join(" ");
  check("the baseline's causes are the low standing and custom", rows === "legitimacy:" + LEGITIMACY_UNREST.low + " custom:" + CUSTOM_UNREST, rows);
  const before = h.unrest;
  nextDay(w);
  check("and a day moves it by exactly their sum", h.unrest - before === LEGITIMACY_UNREST.low + CUSTOM_UNREST, (h.unrest - before) + "");

  // Taxes: monotone in what the rate takes, and only unrest and the coin move.
  const byRate = TAX_RATE_IDS.map((rate) => vary("tax " + rate, (_vw, vh) => { vh.tax = rate; }));
  for (let i = 1; i < byRate.length; i++) {
    check("a " + TAX_RATE_IDS[i] + " tax stirs the town more than " + TAX_RATE_IDS[i - 1],
      byRate[i].dVar > byRate[i - 1].dVar, byRate[i - 1].dVar + " -> " + byRate[i].dVar);
  }
  check("and moves only the town's unrest and the coin", byRate.every((r) => only(r.differs, ["unrest:greyshaw", "stock:coin"])),
    byRate.map((r) => r.differs.join(",")).join(" | "));
  check("by exactly its row (harsh - normal)", byRate[4].dVar - byRate[2].dVar === TAX_UNREST.harsh - TAX_UNREST.normal);

  // Famine: the stores empty, the town goes short of bread.
  const famine = vary("famine", (vw) => { take(vw, "grain"); });
  check("famine stirs the town", famine.dVar > famine.dBase && famine.v.h.famine > 0, famine.dBase + " -> " + famine.dVar);
  check("by its row", famine.dVar - famine.dBase === FAMINE_UNREST, String(famine.dVar - famine.dBase));
  check("and moves nothing else K6 owns", only(famine.differs, ["unrest:greyshaw", "stock:grain", "stock:levy"]), famine.differs.join(","));

  // Soldiers quartered unpaid: the same army in both, paid in one.
  // No tax in either (it would pay the wages before the day reckons them).
  const quartered = vary("quartering", (vw) => { take(vw, "coin"); }, 1, (bw, bh) => {
    bh.tax = "none";
    const a = raiseArmy(bw, KING, bh.id, ["line"]);
    a.supply = 500;
  });
  check("an army of the king's quartered unpaid stirs the town", quartered.dVar - quartered.dBase === QUARTERED_UNREST,
    quartered.dBase + " -> " + quartered.dVar);
  check("and moves only the town, the coin and that army's spirit", only(quartered.differs, ["unrest:greyshaw", "stock:coin", "morale:" + quartered.v.w.armies[0].id]),
    quartered.differs.join(","));

  // The king's standing: monotone, three bands.
  const legit = [5, 30, 60].map((l) => vary("legitimacy " + l, (lw) => { lw.economy[KING].legitimacy = l; }));
  check("a king of higher standing stirs his towns less", legit[0].dVar > legit[1].dVar && legit[1].dVar > legit[2].dVar,
    legit.map((r) => r.dVar).join(" > "));
  check("and moves only the town (and the standing it was set to)", legit.every((r) => only(r.differs, ["unrest:greyshaw", "legitimacy"])),
    legit.map((r) => r.differs.join(",")).join(" | "));

  // Custom: a town with any unrest at all settles.
  const calm = town();
  calm.h.unrest = 0;
  check("custom calms only a town with unrest to calm", unrestCauses(calm.w, calm.h).every((c) => c.cause !== "custom") &&
    unrestCauses(w, h).some((c) => c.cause === "custom"));

  // Shrines and halls: standing and paid, they calm; idle, they do not.
  const shrine = vary("shrine", (_vw, vh) => { vh.buildings[0] = "shrine"; vh.works[0] = 0; });
  check("a shrine calms the town by its row", shrine.dBase - shrine.dVar === SHRINE_UNREST_SCALE, shrine.dBase + " -> " + shrine.dVar);
  check("and moves nothing else K6 owns", only(shrine.differs, ["unrest:greyshaw"]), shrine.differs.join(","));
  const hall = vary("hall", (_vw, vh) => { vh.buildings[0] = "hall"; vh.works[0] = 0; });
  check("a hall calms it more", hall.dVar < shrine.dVar && hall.dBase - hall.dVar === 2 * SHRINE_UNREST_SCALE, hall.dVar + " < " + shrine.dVar);
  check("and moves only the town and the coin (its upkeep)", only(hall.differs, ["unrest:greyshaw", "stock:coin"]), hall.differs.join(","));
  const idle = vary("idle shrine", (_vw, vh) => { vh.buildings[0] = "shrine"; vh.works[0] = 3; });
  check("a shrine still being built calms nothing", idle.dVar === idle.dBase);

  // Justice: courts (paid) and the rope calm; unpaid courts do not sit.
  const courts = vary("courts", (_vw, vh) => { vh.justice = "courts"; });
  check("courts calm the town by their row", courts.dVar - courts.dBase === JUSTICE.courts.unrest, courts.dBase + " -> " + courts.dVar);
  check("and cost their coin, booked under justice", flowOf(courts.v.w.books[KING].closed!, "coin", "justice") === JUSTICE.courts.coin ||
    flowOf(courts.v.w.books[KING].open, "coin", "justice") === JUSTICE.courts.coin);
  check("and move only the town and the coin", only(courts.differs, ["unrest:greyshaw", "stock:coin"]), courts.differs.join(","));
  const unpaidCourts = vary("unpaid courts", (vw, vh) => { vh.justice = "courts"; take(vw, "coin"); }, 1, (_bw, bh) => { bh.tax = "none"; });
  check("unpaid, the courts do not sit", unpaidCourts.dVar === unpaidCourts.dBase, unpaidCourts.dBase + " vs " + unpaidCourts.dVar);
  const rope = vary("rope", (_vw, vh) => { vh.justice = "rope"; });
  check("the rope calms more than the courts", rope.dVar < courts.dVar && rope.dVar - rope.dBase === JUSTICE.rope.unrest, rope.dVar + " < " + courts.dVar);
  check("and costs no coin", only(rope.differs, ["unrest:greyshaw"]), rope.differs.join(","));

  // Mercy: above zero it calms every town; terror does not.
  const mercy = vary("mercy", (vw) => { vw.economy[KING].mercy = 50; });
  check("the realm's mercy calms the town by its row", mercy.dBase - mercy.dVar === 50 / MERCY_CALM_PER, mercy.dBase + " -> " + mercy.dVar);
  check("and moves only the town (and the mercy it was set to)", only(mercy.differs, ["unrest:greyshaw", "mercy"]), mercy.differs.join(","));
  const terror = vary("terror", (vw) => { vw.economy[KING].mercy = -50; });
  check("terror neither calms nor stirs a town", terror.dVar === terror.dBase);

  // An army living off the town's fields (whoever's): each day it forages.
  const forage = vary("foraging", (vw, vh) => {
    const a = raiseArmy(vw, FACTION_IDS.indexOf("king"), vh.id, ["line"]);
    a.supply = 0;
    take(vw, "grain");
  }, 1, (bw) => { give(bw, {}); });
  check("an army living off its fields stirs the town (with the famine that empty stores bring)",
    forage.dVar - forage.dBase >= FORAGED_UNREST && forage.v.h.foraged > 0, forage.dBase + " -> " + forage.dVar);
}

// -- 2. the levers, as orders ------------------------------------------------------------------------

section("the levers: orders with one check for the button and the tick");
{
  const { w, h } = town();
  check("justice can be set in an own town", w.check({ kind: "setJustice", holding: h.id, justice: "courts" }) === null);
  check("not to what it already is", w.check({ kind: "setJustice", holding: h.id, justice: "none" }) === MORALE_REFUSAL.sameJustice);
  const other = w.holdingByKey("thornwick")!;
  check("not in a town that is not the king's", w.check({ kind: "setJustice", holding: other.id, justice: "courts" }) !== null);
  check("no festival or pardon there either", w.check({ kind: "holdFestival", holding: other.id }) !== null && w.check({ kind: "pardon", holding: other.id }) !== null);
  const ev = issue(w, { kind: "setJustice", holding: h.id, justice: "rope" });
  check("setJustice applies, with an event", h.justice === "rope" && ev.some((e) => e.kind === "justiceSet"));

  // A festival: its cost, its legitimacy, its calm, its end.
  const c = festivalCost(h);
  const coin0 = w.economy[KING].stocks.coin;
  const grain0 = w.economy[KING].stocks.grain;
  const legit0 = w.economy[KING].legitimacy;
  const fev = issue(w, { kind: "holdFestival", holding: h.id });
  check("a festival is held, with an event", h.festival === FESTIVAL.days && fev.some((e) => e.kind === "festivalHeld"));
  check("it costs its coin and grain, booked under festivals",
    w.economy[KING].stocks.coin === coin0 - c.coin && w.economy[KING].stocks.grain === grain0 - c.grain &&
    flowOf(w.books[KING].open, "coin", "festivals") === c.coin && flowOf(w.books[KING].open, "grain", "festivals") === c.grain);
  check("and is a ceremony: +" + FESTIVAL.legitimacy + " legitimacy", w.economy[KING].legitimacy === legit0 + FESTIVAL.legitimacy);
  check("only one at a time", w.check({ kind: "holdFestival", holding: h.id }) === MORALE_REFUSAL.festivalRunning(h.festival));
  check("the politics card's list has it", unrestCauses(w, h).some((x) => x.cause === "festival" && x.permille === FESTIVAL.unrestPerDay));
  let over = false;
  days(w, FESTIVAL.days + 1, (e) => { if (e.some((x) => x.kind === "festivalOver")) over = true; });
  check("it runs its days and ends, with an event", h.festival === 0 && over);
  const poor = town();
  take(poor.w, "coin");
  check("a festival the stores cannot pay for is refused, and says what it needs",
    poor.w.check({ kind: "holdFestival", holding: poor.h.id }) === MORALE_REFUSAL.festivalCost(festivalCost(poor.h)));
  const qev = issue(poor.w, { kind: "holdFestival", holding: poor.h.id });
  check("the tick refuses it with the same words", rejectedWith(qev) === MORALE_REFUSAL.festivalCost(festivalCost(poor.h)));

  // A pardon: at once, mercy up, once a season.
  const p = town();
  const u0 = p.h.unrest;
  const pev = issue(p.w, { kind: "pardon", holding: p.h.id });
  check("a pardon calms the town at once by its row", p.h.unrest === u0 + PARDON.unrest && pev.some((e) => e.kind === "pardoned"));
  check("and the realm's mercy rises", p.w.economy[KING].mercy === PARDON.mercy && pev.some((e) => e.kind === "mercyChanged"));
  check("once a season", p.w.check({ kind: "pardon", holding: p.h.id }) === MORALE_REFUSAL.pardonedThisSeason);
  while (p.w.date.day < DAYS_PER_SEASON + 1) nextDay(p.w);
  check("and again the next", p.w.check({ kind: "pardon", holding: p.h.id }) === null, String(p.w.check({ kind: "pardon", holding: p.h.id })));
  const q = town();
  q.h.unrest = 0;
  check("a quiet town has nothing to pardon", q.w.check({ kind: "pardon", holding: q.h.id }) === MORALE_REFUSAL.nothingToPardon);

  // Mercy is clamped, through its one entry point.
  const m = town();
  check("mercy moves through changeMercy, clamped", changeMercy(m.w, KING, 500) === MERCY_MAX && changeMercy(m.w, KING, -500) === MERCY_MIN - MERCY_MAX &&
    m.w.economy[KING].mercy === MERCY_MIN);
}

// -- 3. what happens to a town --------------------------------------------------------------------------

section("what happens to a town: claim, muster, defeat");
{
  const w = new KingdomWorld({ seed: SEED });
  issue(w, { kind: "rally" });
  while (w.kingStocks.stocks.levy < 3 && w.king.task === "rally") w.tick();
  const ch = w.holdingByKey("cold-hearth")!;
  issue(w, { kind: "claimHolding", holding: ch.id });
  check("a holding claimed starts at " + unrestPoints(CLAIM_UNREST) + " unrest: strangers are not yet trusted", ch.owner === "king" && ch.unrest === CLAIM_UNREST, String(ch.unrest));

  // The muster, at the season's turn: the same town with and without men to give.
  const a = town();
  const b = town();
  b.h.population = 0;
  a.h.unrest = 300;
  b.h.unrest = 300;
  while (a.w.date.day < DAYS_PER_SEASON) { nextDay(a.w); nextDay(b.w); }
  const gave = flowOf(a.w.books[KING].open, "levy", "muster") > 0;
  check("the season's muster stirs the town that gave its sons", gave && a.h.unrest - b.h.unrest === MUSTER_UNREST, (a.h.unrest - b.h.unrest) + "");

  // A battle lost: the town it was fought at, and the king's others of that province.
  const l = town();
  const th = l.w.holdingByKey("thornwick")!;
  const far = l.w.holdingByKey("harrowfield")!;
  th.owner = "king";
  th.unrest = 100;
  far.owner = "king";
  far.unrest = 100;
  battleLostUnrest(l.w, l.h.id);
  check("a lost battle stirs the town it was fought at", l.h.unrest === 300 + LOST_BATTLE_UNREST.here);
  check("and the king's other towns of the province", th.unrest === 100 + LOST_BATTLE_UNREST.province);
  check("and no town of another province", far.unrest === 100);
}

// -- 4. the thresholds ------------------------------------------------------------------------------------

section("the thresholds: half taxes, then revolt");
{
  const taxOf = (u: number): number => {
    const { w, h } = town();
    h.unrest = u;
    nextDay(w);
    h.unrest = u; // hold it, to read one day's taxes at this level
    nextDay(w);
    return flowOf(w.books[KING].closed!, "coin", "tax");
  };
  const calm = taxOf(RESTLESS_AT - 1 - 20);
  const restless = taxOf(RESTLESS_AT + 20);
  check("a restless town pays half its taxes", restless * 2 <= calm && restless * 2 >= calm - 1 && calm > 0, calm + " -> " + restless);
  const r = town();
  r.h.unrest = RESTLESS_AT;
  check("isRestless reads the lesser threshold", isRestless(r.h));

  // Below the revolt: nothing happens.
  const below = town();
  below.h.unrest = REVOLT_AT - 10;
  nextDay(below.w);
  check("just below the threshold, the town stays", below.h.owner === "king");

  // A revolt with the people for it: the town is nobody's, and a rebel host stands in it.
  const big = town();
  big.h.population = 120;
  big.h.unrest = REVOLT_AT + 50;
  const pop0 = big.h.population;
  const legit0 = big.w.economy[KING].legitimacy;
  const evs: KingdomEvent[] = [];
  nextDay(big.w, (e) => evs.push(...e));
  const ev = evs.find((e) => e.kind === "revolt");
  const rebels = big.w.armies.find((a) => standsIn(a.mover) === big.h.id);
  const rf = rebelFaction(big.w, big.h);
  check("at the threshold the town revolts", ev !== undefined && big.h.owner === null);
  check("its young men take up the crown's banner", rebels !== undefined && rebels.owner === rf && FACTION_IDS[rf] === "usurper" && rebels.posture === "hold" &&
    rebels.morale === REVOLT.morale, rebels ? FACTION_IDS[rebels.owner] + " " + rebels.morale : "none");
  const n = rebels ? armyMen(rebels) : 0;
  check("one rebel in " + REVOLT.peoplePerRebel + ", out of the town's people", n === Math.floor(pop0 / REVOLT.peoplePerRebel) && big.h.population === pop0 - n, n + "");
  check("the king's legitimacy falls by " + REVOLT.legitimacy, big.w.economy[KING].legitimacy === Math.max(0, legit0 - REVOLT.legitimacy));
  check("and the town starts over, calm", big.h.unrest === REVOLT.after && big.h.garrison.length === 0);
  check("its unrest is no longer the king's to reckon", unrestCauses(big.w, big.h).length === 0);

  // A hamlet too small to raise anyone: it only flips.
  const small = town();
  small.h.population = 20;
  small.h.unrest = UNREST_MAX;
  const before = small.w.armies.length;
  nextDay(small.w);
  check("a town too small to raise a host only flips", small.h.owner === null && small.w.armies.length === before);
}

// -- 5. army morale ---------------------------------------------------------------------------------------

section("army morale: pay, bread, the king, the cause, terror, victory");
{
  const army = (setup?: (w: KingdomWorld, a: Army) => void): { w: KingdomWorld; a: Army } => {
    const { w, h } = town();
    const a = raiseArmy(w, KING, h.id, ["line", "line"]);
    a.supply = 2000;
    a.morale = 50;
    setup?.(w, a);
    return { w, a };
  };
  const fed = army();
  const rest = armyRestMorale(fed.w, fed.a);
  check("fed and paid, an army settles toward its rest level", rest === ARMY_MORALE.rest + Math.floor(fed.w.economy[KING].legitimacy / ARMY_MORALE.legitimacyPer), String(rest));
  nextDay(fed.w);
  check("one point a day", fed.a.morale === 50 + ARMY_MORALE.drift, String(fed.a.morale));

  const hungry = army((w, a) => { a.supply = 0; take(w, "grain"); });
  nextDay(hungry.w);
  check("hungry, it falls", hungry.a.morale === 50 - ARMY_MORALE.hungry, String(hungry.a.morale));
  // ECON: wages are a third of the points now, and a day's tax would pay them: no tax here.
  const unpaid = army((w) => { take(w, "coin"); for (const h of w.holdingsOf("king")) h.tax = "none"; });
  nextDay(unpaid.w);
  check("unpaid, it falls", unpaid.a.morale === 50 - ARMY_MORALE.unpaid, String(unpaid.a.morale));

  const king = army((w, a) => { w.king.army = a.id; });
  check("the king riding with it raises its rest level", armyRestMorale(king.w, king.a) === rest + ARMY_MORALE.king);
  const believed = army((w) => { w.economy[KING].legitimacy = 60; });
  check("a king the realm believes in raises it", armyRestMorale(believed.w, believed.a) > rest);
  const feared = army((w) => { w.economy[KING].mercy = -60; });
  check("terror raises it", armyRestMorale(feared.w, feared.a) === rest + 3);
  const merciful = army((w) => { w.economy[KING].mercy = 60; });
  check("mercy does not", armyRestMorale(merciful.w, merciful.a) === rest);

  // Broken spirit: men slip away below the floor.
  const broken = army((_w, a) => { a.morale = 5; });
  const men0 = armyMen(broken.a);
  let deserted = 0;
  days(broken.w, 10, (e) => { for (const x of e) if (x.kind === "moraleDesertion") deserted += x.n; });
  check("below " + ARMY_MORALE.desertBelow + ", men desert", deserted > 0 && armyMen(broken.a) === men0 - deserted, deserted + " of " + men0);
  const steady = army((_w, a) => { a.morale = ARMY_MORALE.desertBelow; });
  const s0 = armyMen(steady.a);
  days(steady.w, 10);
  check("at the floor, nobody goes", armyMen(steady.a) === s0);
  const empty = army((_w, a) => { a.squads = [a.squads[0]]; a.squads[0].men = 2; });
  let gone = "";
  // Test setup: its spirit held broken, day after day, until the last man goes.
  for (let d = 0; d < 200 && gone === ""; d++) {
    empty.a.morale = 0;
    nextDay(empty.w, (e) => { for (const x of e) if (x.kind === "armyGone") gone = x.reason; });
  }
  check("an army whose last man deserts is gone", gone === "deserted" && !empty.w.armies.includes(empty.a), gone);
  check("only economy-run factions' armies are reckoned", (() => {
    const { w, h } = town();
    const hare = raiseArmy(w, FACTION_IDS.indexOf("hare"), h.id, ["line"]);
    hare.morale = 5;
    days(w, 3);
    return hare.morale === 5;
  })());
}

// -- 6. into battle: the BattleSpec's starting morale ---------------------------------------------------

section("into battle: the army's morale is the battle's starting nerve");
{
  const meet = (): { w: KingdomWorld; a: Army } => {
    const w = new KingdomWorld({ seed: SEED, hosts: true });
    const a = raiseArmy(w, KING, id(w, "rookstead"), ["line", "line", "slinger"]);
    a.supply = 3000;
    w.issue({ kind: "marchArmy", army: a.id, to: id(w, "harrowfield") });
    for (let i = 0; i < 40 * TICKS_PER_DAY && !w.contact; i++) {
      w.tick();
      if (!w.contact && a.mover.route.length === 0 && standsIn(a.mover) !== id(w, "harrowfield")) w.issue({ kind: "marchArmy", army: a.id, to: id(w, "harrowfield") });
    }
    return { w, a };
  };
  const spec = (morale: number): BattleSpec | null => {
    const { w, a } = meet();
    a.morale = morale;
    return w.contact ? buildBattleSpec(w, w.contact as Contact) : null;
  };
  const low = spec(25);
  const high = spec(80);
  check("a contact is met", low !== null && high !== null);
  if (low && high) {
    check("the spec carries the army's morale", low.sides[0].morale === 25 && high.sides[0].morale === 80);
    check("so a shaken army starts the battle with less nerve", nerveFromMorale(low.sides[0].morale) < nerveFromMorale(high.sides[0].morale),
      nerveFromMorale(25) + " < " + nerveFromMorale(80));
    check("and the enemy's start is the same either way", low.sides[1].morale === high.sides[1].morale);
  }

  // And back out: a victory lifts the winner on top of what the field left; a defeat stirs the province.
  const settle = (winner: number) => {
    const { w, a } = meet();
    const c = w.contact as Contact;
    const at = w.holding(c.holding)!;
    at.owner = "king"; // test setup: the field is the king's town, so its unrest is reckoned
    at.unrest = 100;
    const sp = buildBattleSpec(w, c);
    const result = {
      contact: sp.contact, winner,
      squads: [sp.sides[0].squads.map((q) => ({ squad: q.squad, men: q.men, wounded: q.wounded })),
        sp.sides[1].squads.map((q) => ({ squad: q.squad, men: q.men, wounded: q.wounded }))] as [any, any],
      morale: [sp.sides[0].morale, sp.sides[1].morale] as [number, number], fled: [winner === 1, winner === 0] as [boolean, boolean],
      left: [false, false] as [boolean, boolean], damage: { crops: 0, buildings: 0 }, legitimacy: winner === 0 ? 2 : winner === 1 ? -1 : 0,
    };
    w.issue({ kind: "resolveContact", contact: c.id, choice: "fight", result });
    const ev = w.tick();
    return { w, a, at, start: sp.sides[0].morale, ev };
  };
  const won = settle(0);
  check("a battle won: the winner's morale is what the field left, + " + ARMY_MORALE.win, won.a.morale === Math.min(100, won.start + ARMY_MORALE.win),
    won.start + " -> " + won.a.morale + (won.ev.find((e) => e.kind === "orderRejected") ? " (rejected)" : ""));
  check("and the town is not stirred", won.at.unrest === 100);
  const lost = settle(1);
  check("a battle lost stirs the town it was fought at", lost.at.unrest === 100 + LOST_BATTLE_UNREST.here, String(lost.at.unrest));
  check("and the loser's morale is only what the field left", armyById(lost.w, lost.a.id)?.morale === lost.start);
}

// -- 7. the politics card's list is the sim's --------------------------------------------------------

section("one list: what the card shows is what the day applies");
{
  const { w, h } = town();
  h.tax = "high";
  h.justice = "courts";
  h.buildings[0] = "shrine";
  w.economy[KING].mercy = 30;
  const a = raiseArmy(w, KING, h.id, ["line"]);
  a.supply = 500;
  take(w, "coin");
  give(w, { coin: 1 }); // the courts' fee, and nothing for wages: the army is quartered unpaid
  days(w, 4);
  const trend = unrestTrend(w, h);
  const before = h.unrest;
  nextDay(w);
  const causes = unrestCauses(w, h).map((c) => c.cause);
  check("the trend the card shows is the day's move", h.unrest - before === trend || h.unrest === 0 || h.unrest === UNREST_MAX, trend + " vs " + (h.unrest - before));
  check("listed in the content's order", causes.every((c, i) => i === 0 || UNREST_CAUSE_IDS.indexOf(c) > UNREST_CAUSE_IDS.indexOf(causes[i - 1])), causes.join(","));
}

// -- 8. save v6 ------------------------------------------------------------------------------------------

/** A realm with every K6 lever pulled through the queue, over a season and more. */
function scripted(seed: number, n: number): KingdomWorld {
  const w = new KingdomWorld({ seed });
  issue(w, { kind: "rally" });
  while (w.kingStocks.stocks.levy < 6 && w.king.task === "rally") w.tick();
  const ch = id(w, "cold-hearth");
  issue(w, { kind: "claimHolding", holding: ch });
  const plan: { day: number; body: KingdomOrderBody }[] = [
    { day: 4, body: { kind: "setJustice", holding: ch, justice: "courts" } },
    { day: 6, body: { kind: "setTax", holding: ch, rate: "high" } },
    { day: 8, body: { kind: "pardon", holding: ch } },
    { day: 10, body: { kind: "forage" } },
    { day: 20, body: { kind: "holdFestival", holding: ch } },
    { day: 33, body: { kind: "setJustice", holding: ch, justice: "rope" } },
    { day: 36, body: { kind: "pardon", holding: ch } },
    { day: 40, body: { kind: "setTax", holding: ch, rate: "low" } },
  ];
  while (w.date.day < n) {
    for (const p of plan) if (p.day === w.date.day) w.issue(p.body);
    nextDay(w);
  }
  return w;
}

section("save v6: round trip, migration, replay");
{
  const w = scripted(SEED, 70);
  const ch = w.holdingByKey("cold-hearth")!;
  check("the script pulled the levers", ch.justice === "rope" && ch.pardoned > 0 && w.economy[KING].mercy !== 0,
    ch.justice + " " + ch.pardoned + " " + w.economy[KING].mercy);
  const json = saveToJson(w);
  check("the save is version " + KINGDOM_SAVE_VERSION, JSON.parse(json).version === KINGDOM_SAVE_VERSION && KINGDOM_SAVE_VERSION >= 6);
  const l = loadFromJson(json);
  check("and loads as the same realm", l.ok && kingdomHash(l.value) === kingdomHash(w), l.ok ? "" : l.error);
  if (l.ok) {
    const lh = l.value.holdingByKey("cold-hearth")!;
    check("unrest, justice, festival, pardon and mercy come back",
      lh.unrest === ch.unrest && lh.justice === ch.justice && lh.festival === ch.festival && lh.pardoned === ch.pardoned &&
      l.value.economy[KING].mercy === w.economy[KING].mercy);
    days(l.value, 10);
    const cont = scripted(SEED, 80);
    check("and carries on exactly as never stopping", kingdomHash(l.value) === kingdomHash(cont));
  }
  const r = replayLog(SEED, w.log, w.now);
  check("the log (politics orders included) replays to it", kingdomHash(r) === kingdomHash(w) && w.log.some((o) => o.kind === "pardon"));

  const tamper = (f: (s: any) => void): boolean => { const s = JSON.parse(json); f(s); return !deserialize(s).ok; };
  check("unrest over the top is refused", tamper((s) => { s.snapshot.holdings[0].unrest = UNREST_MAX + 1; }));
  check("unknown justice is refused", tamper((s) => { s.snapshot.holdings[0].justice = "trial-by-ordeal"; }));
  check("mercy past its bounds is refused", tamper((s) => { s.snapshot.economy[0].mercy = MERCY_MAX + 1; }) && tamper((s) => { s.snapshot.economy[0].mercy = MERCY_MIN - 1; }));
  check("terror (negative mercy) is not refused", !tamper((s) => { s.snapshot.economy[0].mercy = -40; }));
  check("a politics order with an unknown justice is refused", tamper((s) => { s.log.push({ kind: "setJustice", holding: 1, justice: "no", tick: 0, player: 0, seq: 999 }); }));

  // v5 -> v6: the K6 fields go, the pages lose their last two categories.
  const v5 = serialize(scripted(SEED, 20)) as unknown as Record<string, any>;
  v5.version = 5;
  const width = LEDGER_CATEGORY_IDS.indexOf("festivals");
  const shrink = (p: LedgerDay | null): LedgerDay | null => {
    if (!p) return p;
    const flow: number[] = [];
    for (let s = 0; s < LEDGER_STOCK_IDS.length; s++) for (let c = 0; c < width; c++) flow.push(p.flow[s * LEDGER_CATEGORY_IDS.length + c]);
    return { ...p, flow };
  };
  for (const h of v5.snapshot.holdings) { delete h.unrest; delete h.justice; delete h.festival; delete h.pardoned; }
  for (const e of v5.snapshot.economy) { delete e.mercy; e.open = shrink(e.open); e.closed = shrink(e.closed); }
  v5.log = v5.log.filter((o: { kind: string }) => !["setJustice", "holdFestival", "pardon"].includes(o.kind));
  const m = migrate(JSON.parse(JSON.stringify(v5)));
  check("a version-5 save migrates to " + KINGDOM_SAVE_VERSION, m.ok && m.value.version === KINGDOM_SAVE_VERSION, m.ok ? "" : m.error);
  const lv = deserialize(JSON.parse(JSON.stringify(v5)));
  check("and loads", lv.ok, lv.ok ? "" : lv.error);
  if (lv.ok) {
    const x = lv.value;
    check("every town calm, no justice, no festival, no pardon; mercy at the start",
      x.holdings.every((h) => h.unrest === 0 && h.justice === "none" && h.festival === 0 && h.pardoned === 0) && x.economy.every((e) => e.mercy === 0));
    const page = x.books[KING].open;
    let kept = page.flow.length === LEDGER_STOCK_IDS.length * LEDGER_CATEGORY_IDS.length;
    for (let s = 0; s < LEDGER_STOCK_IDS.length && kept; s++) {
      for (let c = 0; c < LEDGER_CATEGORY_IDS.length; c++) {
        const want = c < width ? v5.snapshot.economy[0].open.flow[s * width + c] : 0;
        if (page.flow[s * LEDGER_CATEGORY_IDS.length + c] !== want) kept = false;
      }
    }
    check("ledger pages re-laid for K6's two categories, every old value kept", kept);
  }
}

// -- 9. the ledger -------------------------------------------------------------------------------------

section("the ledger balances with festivals and justices on it");
{
  let problem = "";
  let pages = 0;
  let last: LedgerDay | null = null;
  const cats = new Set<string>();
  const w = new KingdomWorld({ seed: SEED });
  issue(w, { kind: "rally" });
  while (w.kingStocks.stocks.levy < 6 && w.king.task === "rally") w.tick();
  const ch = id(w, "cold-hearth");
  issue(w, { kind: "claimHolding", holding: ch });
  issue(w, { kind: "setJustice", holding: ch, justice: "courts" });
  give(w, { coin: 60, grain: 200 });
  while (w.date.day < 90) {
    if (w.date.day % 15 === 0 && w.check({ kind: "holdFestival", holding: ch }) === null) w.issue({ kind: "holdFestival", holding: ch });
    nextDay(w, () => {
      const book = w.books[KING];
      const c = book.closed;
      if (!c || c === last) return;
      last = c;
      pages++;
      LEDGER_STOCK_IDS.forEach((st, i) => {
        if (c.start[i] + netOf(c, st) !== book.open.start[i]) problem ||= st + " on day " + c.day;
        for (const cat of LEDGER_CATEGORY_IDS) if (flowOf(c, st, cat) > 0) cats.add(cat);
      });
      for (const st of STOCK_IDS) if (w.economy[KING].stocks[st] < 0) problem ||= st + " below zero";
    });
  }
  check("every day balances: end = start + sources - sinks", problem === "" && pages > 80, problem || pages + " pages");
  check("festivals are booked under festivals", cats.has("festivals"));
  check("the justices under justice", cats.has("justice"));
  check("the festival's legitimacy under deeds", cats.has("deeds"));
}

console.log("");
if (failures === 0) console.log("all " + checks + " morale checks passed");
else {
  console.log(failures + " of " + checks + " morale check(s) FAILED");
  process.exitCode = 1;
}
