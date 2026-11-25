/**
 * K4 test suite: armies on the kingdom map (PLAN.md §B.4, §B.11 K4). Part of
 * `npm test`; headless, no DOM.
 *
 * What it holds the sim to:
 *   - one rulebook: a squad costs what the battle game says it costs, and
 *     the battle game's caps hold on the map;
 *   - from nothing: the king's first followers form the first army where he
 *     stands, with no barracks, coin or iron, and he rides with it;
 *   - THE PROOF, "recruit -> march -> starve": an army raised and marched
 *     away from its stores eats its packs, then goes hungry, then loses men
 *     to desertion and death on a schedule that is the same on every run;
 *   - merge and split move men, wounded, grain and wages owed, never make or
 *     lose them; squad strength persists (through days and through a save);
 *   - wages, late wages and the desertion of unpaid trained men;
 *   - recovery (the wounded mend at rest in a town, faster with a hall) and
 *     replacement at a barracks from the levy and iron;
 *   - caps: eight armies a side, the rulebook's squad caps;
 *   - the ledger: every day of a run with armies balances;
 *   - replay and save/load reproduce a run with armies exactly; the v3 -> v4
 *     migration of a real K3a save;
 *   - armies are sight sources; intercept is for other sides' armies only;
 *   - the pen: every army stroke previews what it commits.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  KingdomWorld, kingdomHash, loadFromJson, saveToJson, replayLog, deserialize, migrate, MIGRATIONS, KINGDOM_SAVE_VERSION,
  TICKS_PER_DAY, credit, netOf, flowOf, armyById, armiesOf, armyMen, armyWounded, armyWage, armyFullMen,
  armySpeedPct, armyList, squadStrengths, recruitCost, abilityPrice, raiseArmy, armyVisible, inContact, sightSources, holdingKnowledge, standsIn,
  type Army, type KingdomEvent, type KingdomOrderBody, type LedgerDay, type Holding,
} from "../src/sim/kingdom/index.ts";
import {
  ARMY_REFUSAL, COIN_PER_POINT, HUNGER_GRACE_DAYS, LEDGER_CATEGORIES, LEDGER_CATEGORY_IDS, LEDGER_STOCK_IDS, LEVY_MIN_MEN,
  MAX_ARMIES_PER_SIDE, RECRUIT_IRON, STOCK_IDS, UNPAID_GRACE_DAYS, CARRY_PER_MAN, KNOW_SEEN, FACTION_IDS, dailyWage,
} from "../src/content/kingdom/index.ts";
import { UNIT_TYPES, UNIT_TYPE_IDS } from "../src/content/unit-types.ts";
import { validate as validateList, MAX_OF_ONE_ABILITY } from "../src/content/army.ts";
import { abilityCost } from "../src/content/abilities.ts";
import { armyWorld, buildKingdomCorpus } from "./gesture-corpus.ts";
import { interpretStroke, kingdomContext, armyPointsOf } from "../src/input/kingdom-commander.ts";

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
const KING = 0;
const BOAR = FACTION_IDS.indexOf("boar");

function runDays(w: KingdomWorld, n: number, each?: (w: KingdomWorld, ev: KingdomEvent[]) => void): void {
  const until = w.now + n * TICKS_PER_DAY;
  // K5: a contact of the king's holds the realm (the clock stops), so stop with it.
  while (w.now < until && !w.contact) {
    const ev = w.tick();
    each?.(w, ev);
  }
}
/** Run to the first tick of the next day (so that day's economy and army day have run). */
function nextDay(w: KingdomWorld, each?: (w: KingdomWorld, ev: KingdomEvent[]) => void): void {
  do {
    const ev = w.tick();
    each?.(w, ev);
  } while (w.now % TICKS_PER_DAY !== 1);
}
/** Tick until the army stands at the holding (or give up after `maxDays`); the days it took. */
function arrive(w: KingdomWorld, a: Army, holding: number, maxDays = 40, each?: (w: KingdomWorld, ev: KingdomEvent[]) => void): number {
  const t0 = w.now;
  while (w.now - t0 < maxDays * TICKS_PER_DAY) {
    if (standsIn(a.mover) === holding && a.mover.route.length === 0) return (w.now - t0) / TICKS_PER_DAY;
    const ev = w.tick();
    each?.(w, ev);
  }
  return -1;
}
function issue(w: KingdomWorld, body: KingdomOrderBody, player = KING): KingdomEvent[] {
  w.issue(body, player);
  return w.tick();
}
const rejected = (ev: KingdomEvent[]): string | null => {
  const r = ev.find((e) => e.kind === "orderRejected");
  return r && r.kind === "orderRejected" ? r.reason : null;
};
const id = (w: KingdomWorld, key: string): number => w.holdingByKey(key)!.id;
/** Test setup: give the king stock through the ledger, so conservation still holds. */
function give(w: KingdomWorld, stocks: Partial<Record<(typeof STOCK_IDS)[number], number>>): void {
  for (const s of STOCK_IDS) if (stocks[s]) credit(w.economy[KING], w.books[KING], s, stocks[s]!, "trade");
}
/** Test setup: hand the king a holding without the claim's conditions. */
function own(w: KingdomWorld, key: string): Holding {
  const h = w.holdingByKey(key)!;
  h.owner = "king";
  return h;
}
/** Test setup: a standing barracks (and optionally a hall) in an owned holding. */
function standingBuilding(h: Holding, b: string): void {
  const slot = h.buildings.indexOf(null);
  h.buildings[slot] = b;
  h.works[slot] = 0;
}
const totalMen = (as: readonly Army[]): number => as.reduce((n, a) => n + armyMen(a), 0);

/**
 * The opening of Act I, by orders only: rally followers at Cold Hearth, claim
 * it, form the first levy squad of spears where the king stands.
 */
function firstArmy(seed = SEED, followers = 12): KingdomWorld {
  const w = new KingdomWorld({ seed });
  issue(w, { kind: "rally" });
  while (w.kingStocks.stocks.levy < followers && w.king.task === "rally") w.tick();
  issue(w, { kind: "claimHolding", holding: id(w, "cold-hearth") });
  issue(w, { kind: "recruit", at: id(w, "cold-hearth"), army: 0, unit: "line", levy: true });
  return w;
}

// -- 1. one rulebook ------------------------------------------------------------------

section("one rulebook");
{
  let same = true;
  for (const u of UNIT_TYPE_IDS) {
    const c = recruitCost(u, false, 1000);
    if (c.levy !== UNIT_TYPES[u].soldiers || c.coin !== UNIT_TYPES[u].cost * COIN_PER_POINT || c.iron !== (RECRUIT_IRON[u] ?? 0)) same = false;
    if (dailyWage(UNIT_TYPES[u].cost, false) * 2 < UNIT_TYPES[u].cost) same = false;
  }
  check("a trained squad costs its battle points in coin, its men in followers", same);
  check("a levy squad takes only the followers who form it", recruitCost("line", true, 7).levy === 7 &&
    recruitCost("line", true, 7).coin === 0 && recruitCost("line", true, 99).levy === UNIT_TYPES.line.soldiers);
  const p = abilityPrice("barrage", "maneuver");
  check("an ability costs its battle price in coin, and legitimacy", p.coin === abilityCost("barrage", "maneuver") * COIN_PER_POINT && p.legitimacy > 0);
}

// -- 2. from nothing ------------------------------------------------------------------------

section("from nothing: the first army");
{
  const w = new KingdomWorld({ seed: SEED });
  const ch = id(w, "cold-hearth");
  check("no army at the start", w.armies.length === 0 && w.king.army === 0);
  const body: KingdomOrderBody = { kind: "recruit", at: ch, army: 0, unit: "line", levy: true };
  check("no followers, no squad", w.check(body) === ARMY_REFUSAL.levyTooFew(LEVY_MIN_MEN));
  check("trained squads need a barracks", w.check({ ...body, levy: false }) === ARMY_REFUSAL.notYourHolding);
  check("the followers form only spears or slings", w.check({ ...body, unit: "horse" }) === ARMY_REFUSAL.notLevyType);
  issue(w, { kind: "rally" });
  while (w.kingStocks.stocks.levy < 6) w.tick();
  check("the followers must gather where the king stands", w.check({ ...body, at: id(w, "greyshaw") }) === ARMY_REFUSAL.levyKingThere);
  const before = w.kingStocks.stocks.levy;
  const ev = issue(w, body);
  check("six followers form a levy squad", !rejected(ev) && w.armies.length === 1, rejected(ev) ?? "");
  const a = w.armies[0];
  check("of six men, not a full twenty", a.squads.length === 1 && a.squads[0].men === before && a.squads[0].levy);
  check("they leave the followers (recruitment)", w.kingStocks.stocks.levy === 0 && flowOf(w.books[KING].open, "levy", "recruitment") === before);
  check("the king rides with the first army raised where he stands", w.king.army === a.id &&
    ev.some((e) => e.kind === "kingJoined" && e.army === a.id));
  check("the First Army, from the one id counter", a.name === "First Army" && a.id > w.king.id && a.squads[0].id === a.id + 1);
  check("levy squads take no wage", armyWage(a) === 0);
  check("it wraps a battle army list the rulebook accepts", validateList(armyList(a), 1e9).ok &&
    squadStrengths(a)[0].men === before);
}

// -- 3. THE PROOF: recruit -> march -> starve ------------------------------------------

type StarveLog = { day: number; men: number; supply: number; hunger: number; deserted: number; died: number; sick: number }[];

function starveRun(seed: number): { log: StarveLog; gone: number; hash: string; w: KingdomWorld } {
  const w = firstArmy(seed);
  // Enough in the stores that the army is not short at home.
  give(w, { grain: 400 });
  nextDay(w);
  const a = w.armies[0];
  // The king stays at home; the army goes alone, with what its packs hold.
  issue(w, { kind: "kingJoin", army: 0 });
  issue(w, { kind: "marchArmy", army: a.id, to: id(w, "rookstead") });
  const log: StarveLog = [];
  let gone = -1;
  for (let d = 0; d < 200 && gone < 0; d++) {
    nextDay(w, (_w, ev) => {
      for (const e of ev) {
        if (e.kind === "armyDay" && e.army === a.id) {
          log.push({ day: w.date.day, men: armyMen(a), supply: a.supply, hunger: a.hunger, deserted: e.deserted, died: e.died, sick: e.sickened });
        }
        if (e.kind === "armyGone" && e.army === a.id) gone = w.date.day;
      }
    });
  }
  return { log, gone, hash: kingdomHash(w), w };
}

section("THE PROOF: recruit -> march -> starve");
{
  const r = starveRun(SEED);
  const first = r.log[0];
  check("it set out with full packs", first !== undefined && first.supply > 0 && first.supply <= first.men * CARRY_PER_MAN,
    first ? "supply " + first.supply + " for " + first.men + " men" : "");
  const emptyAt = r.log.findIndex((x) => x.supply === 0);
  const hungryAt = r.log.findIndex((x) => x.hunger > 0);
  check("it eats its packs empty, then goes hungry", emptyAt >= 0 && hungryAt >= emptyAt, "empty " + emptyAt + ", hungry " + hungryAt);
  const firstLoss = r.log.findIndex((x) => x.deserted + x.died > 0);
  check("no man is lost before the grace runs out", firstLoss > hungryAt && r.log[firstLoss].hunger > HUNGER_GRACE_DAYS,
    "first loss on log day " + firstLoss);
  const deserted = r.log.reduce((n, x) => n + x.deserted, 0);
  const died = r.log.reduce((n, x) => n + x.died, 0);
  const sick = r.log.reduce((n, x) => n + x.sick, 0);
  check("men desert, die and fall sick", deserted > 0 && died > 0 && sick > 0, deserted + " deserted, " + died + " died, " + sick + " sick");
  let falling = true;
  for (let i = 1; i < r.log.length; i++) if (r.log[i].men > r.log[i - 1].men) falling = false;
  check("strength only falls while it starves", falling);
  check("until it has starved away", r.gone > 0, "gone on day " + r.gone);
  check("the king is safe at home, alone", r.w.king.army === 0 && standsIn(r.w.king.mover) === id(r.w, "cold-hearth"));
  const again = starveRun(SEED);
  check("deterministic: the same losses on the same days", JSON.stringify(again.log) === JSON.stringify(r.log) && again.hash === r.hash);
  const other = starveRun(0x1234);
  check("on another seed too", other.gone > 0 && other.log.some((x) => x.deserted > 0));
  // The control: the same army kept at home, by the stores, is fed.
  const home = firstArmy(SEED);
  give(home, { grain: 2000 });
  issue(home, { kind: "kingJoin", army: 0 });
  let hungry = false;
  // (Loose grain spoils: two weeks, while the stores hold out.)
  runDays(home, 14, (_w, ev) => { for (const e of ev) if (e.kind === "armyDay" && e.short > 0) hungry = true; });
  check("kept at home by full stores it does not go hungry", !hungry && home.armies.length === 1 && home.armies[0].supply > 0);
}

// -- 4. merge and split conserve ---------------------------------------------------------

/** An army of several levy squads, at home with stores, the king riding with it. */
function bigArmy(): KingdomWorld {
  const w = firstArmy(SEED, 8);
  give(w, { levy: 40, grain: 1000 });
  const a = w.armies[0];
  for (const u of ["slinger", "line", "slinger"] as const) issue(w, { kind: "recruit", at: id(w, "cold-hearth"), army: a.id, unit: u, levy: true });
  nextDay(w);
  return w;
}

section("merge and split");
{
  const w = bigArmy();
  const a = w.armies[0];
  a.squads[1].wounded = 3; // test setup: some hurt men
  a.arrears = 7;
  a.unpaid = 2;
  const men0 = armyMen(a);
  const wounded0 = armyWounded(a);
  const supply0 = a.supply;
  const half = a.squads.slice(2).map((s) => s.id);
  const ev = issue(w, { kind: "split", army: a.id, squads: half });
  check("a split makes a second army where the first stands", !rejected(ev) && w.armies.length === 2, rejected(ev) ?? "");
  const b = w.armies[1];
  check("the Second Army", b.name === "Second Army" && b.mover.node === a.mover.node);
  check("men, wounded and grain are conserved", armyMen(a) + armyMen(b) === men0 && armyWounded(a) + armyWounded(b) === wounded0 &&
    a.supply + b.supply === supply0, men0 + " / " + (armyMen(a) + armyMen(b)));
  check("wages owed go with the men", a.arrears + b.arrears === 7);
  check("the squads keep their ids and strength", b.squads.map((s) => s.id).join() === half.join());
  check("the king stays with the army he rode with", w.king.army === a.id);
  check("an army cannot split off everything", w.check({ kind: "split", army: a.id, squads: a.squads.map((s) => s.id) }) === ARMY_REFUSAL.splitNone);
  const one = b.squads.length === 2 ? null : b;
  void one;
  const ev2 = issue(w, { kind: "merge", army: b.id, into: a.id });
  check("a merge of two armies in one place is at once", !rejected(ev2) && w.armies.length === 1, rejected(ev2) ?? "");
  check("and conserves men, wounded, grain and wages owed", armyMen(a) === men0 && armyWounded(a) === wounded0 &&
    a.supply === supply0 && a.arrears === 7);
  check("squads in id order again", a.squads.map((s) => s.id).join() === [...a.squads].sort((x, y) => x.id - y.id).map((s) => s.id).join());
  // A merge at a distance: the second army marches to join the first.
  issue(w, { kind: "split", army: a.id, squads: [a.squads[3].id] });
  const c = w.armies[1];
  issue(w, { kind: "marchArmy", army: c.id, to: id(w, "greyshaw") });
  check("the split-off army marched away", arrive(w, c, id(w, "greyshaw")) > 0);
  const menNow = totalMen(w.armies);
  issue(w, { kind: "merge", army: c.id, into: a.id });
  check("a merge at a distance first marches", w.armies.length === 2 && c.target === a.id && c.mover.route.length > 0);
  runDays(w, 20);
  check("and folds in on meeting, nothing lost", w.armies.length === 1 && totalMen(w.armies) <= menNow && armyById(w, c.id) === undefined,
    totalMen(w.armies) + " of " + menNow);
}

// -- 5. squad strength persists -------------------------------------------------------------

section("squad strength persists");
{
  const w = bigArmy();
  const a = w.armies[0];
  const q = a.squads.find((s) => s.unit === "line" && s.men === UNIT_TYPES.line.soldiers)!;
  const n = a.squads.indexOf(q);
  q.men -= 5; // test setup: as a battle would leave it (K5)
  q.wounded = 4;
  runDays(w, 3);
  check("losses are not refilled by themselves", q.men === UNIT_TYPES.line.soldiers - 5);
  check("nor wounds healed without rest", q.wounded === 4);
  const loaded = loadFromJson(saveToJson(w));
  if (!loaded.ok) console.log("    ", loaded.error);
  check("and survive a save", loaded.ok && loaded.value.armies[0].squads[n].men === q.men &&
    loaded.value.armies[0].squads[n].wounded === 4 && kingdomHash(loaded.value) === kingdomHash(w));
  check("the battle view reads the same strength", squadStrengths(a)[n].wounded === 4 && armyFullMen(a) > armyMen(a));
}

// -- 6. wages --------------------------------------------------------------------------------

/** A trained army raised at a standing barracks in Rookstead, the king not there. */
function trainedArmy(coin: number): { w: KingdomWorld; a: Army } {
  const w = new KingdomWorld({ seed: SEED });
  w.tick(); // past the first day's dawn, so its wages are not mixed in
  const rook = own(w, "rookstead");
  standingBuilding(rook, "barracks");
  give(w, { levy: 100, coin, iron: 10, grain: 3000 });
  const ev = issue(w, { kind: "recruit", at: rook.id, army: 0, unit: "line", levy: false });
  if (rejected(ev)) throw new Error("recruit refused: " + rejected(ev));
  issue(w, { kind: "recruit", at: rook.id, army: w.armies[0].id, unit: "archer", levy: false });
  return { w, a: w.armies[0] };
}

section("recruiting at a barracks");
{
  const w = new KingdomWorld({ seed: SEED });
  w.tick(); // past the first day's dawn, so its wages are not mixed in
  const rook = own(w, "rookstead");
  const body: KingdomOrderBody = { kind: "recruit", at: rook.id, army: 0, unit: "line", levy: false };
  check("no barracks, no trained squads", w.check(body) === ARMY_REFUSAL.needsBarracks);
  standingBuilding(rook, "barracks");
  give(w, { coin: 5 });
  check("followers first", w.check(body) === ARMY_REFUSAL.needLevy(UNIT_TYPES.line.soldiers));
  give(w, { levy: 40 });
  check("then coin", w.check(body) === ARMY_REFUSAL.needCoin(UNIT_TYPES.line.cost * COIN_PER_POINT));
  give(w, { coin: 50 });
  check("then iron", w.check(body) === ARMY_REFUSAL.needIron(RECRUIT_IRON.line!));
  give(w, { iron: 2 });
  const coin0 = w.kingStocks.stocks.coin;
  const ev = issue(w, body);
  check("a line company is raised", !rejected(ev) && w.armies.length === 1 && w.armies[0].squads[0].men === UNIT_TYPES.line.soldiers);
  check("for its men, coin and iron", w.kingStocks.stocks.levy === 20 && w.kingStocks.stocks.coin === coin0 - 12 && w.kingStocks.stocks.iron === 1);
  check("the king, far away, does not ride with it", w.king.army === 0);
  check("it is a trained squad and draws a wage", !w.armies[0].squads[0].levy && armyWage(w.armies[0]) === dailyWage(UNIT_TYPES.line.cost, false));
}

section("wages and late wages");
{
  const { w, a } = trainedArmy(12 + 16);
  const wage = armyWage(a);
  check("the stores are empty of coin after raising it", w.kingStocks.stocks.coin === 0);
  let late = 0;
  const desert: number[] = [];
  runDays(w, 12, (_w, ev) => {
    for (const e of ev) {
      if (e.kind === "wagesLate" && e.days === 1) late++;
      if (e.kind === "armyDay" && e.army === a.id) desert.push(e.deserted);
    }
  });
  check("unpaid wages are owed, day by day", a.arrears === 12 * wage && a.unpaid === 12, a.arrears + " owed, " + a.unpaid + " days");
  check("and flagged late once", late === 1);
  check("no one leaves in the grace", desert.slice(0, UNPAID_GRACE_DAYS).every((n) => n === 0));
  check("then trained men leave", desert.reduce((n, x) => n + x, 0) > 0, desert.join(","));
  give(w, { coin: 500 });
  let paidUp = false;
  nextDay(w, (_w, ev) => { for (const e of ev) if (e.kind === "wagesLate" && e.army === a.id && e.days === 0) paidUp = true; });
  check("coin pays what is owed first", a.arrears === 0 && a.unpaid === 0 && paidUp);
  // Levy squads serve for bread.
  const lw = firstArmy(SEED);
  runDays(lw, 10);
  check("levy squads are never owed", lw.armies[0].arrears === 0 && lw.armies[0].unpaid === 0);
}

// -- 7. recovery and replacement --------------------------------------------------------------

section("recovery and replacement");
{
  const mk = (hall: boolean): { w: KingdomWorld; a: Army } => {
    const r = trainedArmy(500);
    const rook = r.w.holdingByKey("rookstead")!;
    if (hall) standingBuilding(rook, "hall");
    nextDay(r.w); // its first army day at home: packs loaded
    r.a.squads[0].wounded = 10;
    return r;
  };
  const plain = mk(false);
  const withHall = mk(true);
  issue(plain.w, { kind: "recover", army: plain.a.id });
  issue(withHall.w, { kind: "recover", army: withHall.a.id });
  runDays(plain.w, 3);
  runDays(withHall.w, 3);
  check("the wounded mend at rest in a town of yours", plain.a.squads[0].wounded < 10, String(plain.a.squads[0].wounded));
  check("faster with a hall", withHall.a.squads[0].wounded < plain.a.squads[0].wounded,
    withHall.a.squads[0].wounded + " < " + plain.a.squads[0].wounded);
  const idle = mk(false);
  runDays(idle.w, 3);
  check("not without rest", idle.a.squads[0].wounded === 10);
  // Out of a town of yours (here: the town lost), with no surgeons: nothing mends.
  const field = mk(false);
  field.w.holdingByKey("rookstead")!.owner = null; // test setup
  issue(field.w, { kind: "recover", army: field.a.id });
  runDays(field.w, 3);
  check("outside a town of yours, without surgeons, nothing mends", field.a.squads[0].wounded === 10 && field.a.hunger === 0,
    field.a.squads[0].wounded + " wounded, hunger " + field.a.hunger);
  // Replacement: a squad below strength at a barracks takes on men from the levy, and iron.
  const rep = trainedArmy(500);
  rep.a.squads[0].men = 12;
  const levy0 = rep.w.kingStocks.stocks.levy;
  const iron0 = rep.w.kingStocks.stocks.iron;
  issue(rep.w, { kind: "recover", army: rep.a.id });
  runDays(rep.w, 3);
  check("losses are replaced from the levy at a barracks", rep.a.squads[0].men > 12 && rep.w.kingStocks.stocks.levy < levy0,
    rep.a.squads[0].men + " men");
  check("with iron for armed men", rep.w.kingStocks.stocks.iron < iron0);
}

// -- 8. caps --------------------------------------------------------------------------------

section("caps");
{
  const w = firstArmy(SEED, 4);
  give(w, { levy: 200, grain: 2000 });
  const ch = id(w, "cold-hearth");
  issue(w, { kind: "kingJoin", army: 0 });
  for (let i = 1; i < MAX_ARMIES_PER_SIDE; i++) issue(w, { kind: "recruit", at: ch, army: 0, unit: "slinger", levy: true });
  check("eight armies a side", armiesOf(w, KING).length === MAX_ARMIES_PER_SIDE);
  const ninth: KingdomOrderBody = { kind: "recruit", at: ch, army: 0, unit: "slinger", levy: true };
  check("a ninth is refused", w.check(ninth) === ARMY_REFUSAL.tooManyArmies(MAX_ARMIES_PER_SIDE));
  const a = w.armies[0];
  issue(w, { kind: "recruit", at: ch, army: a.id, unit: "line", levy: true });
  check("so is a split at the cap", w.check({ kind: "split", army: a.id, squads: [a.squads[1].id] }) === ARMY_REFUSAL.tooManyArmies(MAX_ARMIES_PER_SIDE));
  const names = new Set(armiesOf(w, KING).map((x) => x.name));
  check("each with its own name", names.size === MAX_ARMIES_PER_SIDE);
  // The rulebook's per-type caps hold on the map.
  const cap = UNIT_TYPES.slinger.maxPerArmy;
  const b = w.armies[1];
  for (let i = b.squads.filter((s) => s.unit === "slinger").length; i < cap; i++) issue(w, { kind: "recruit", at: ch, army: b.id, unit: "slinger", levy: true });
  check("an army holds at most the rulebook's " + cap + " slingers", w.check({ kind: "recruit", at: ch, army: b.id, unit: "slinger", levy: true }) ===
    ARMY_REFUSAL.typeCap(UNIT_TYPES.slinger.name, cap));
  const c = w.armies[2];
  check("and a merge past a type cap is refused", w.check({ kind: "merge", army: c.id, into: b.id }) === ARMY_REFUSAL.typeCap(UNIT_TYPES.slinger.name, cap));
  issue(w, { kind: "disband", army: c.id });
  check("standing one down frees a place", w.check(ninth) === null);
}

// -- 9. the ledger ------------------------------------------------------------------------------

/**
 * A scripted realm with armies, every order through the queue: the opening,
 * a second squad, a split, marches, a barracks built and trained squads
 * raised, an ability earned, a stand-down. Returns the world.
 */
function scripted(seed: number, days: number, each?: (w: KingdomWorld) => void, stopAt = -1, gifts = true): KingdomWorld {
  const w = firstArmy(seed, 14);
  const ch = id(w, "cold-hearth");
  const plan: { day: number; order: (w: KingdomWorld) => KingdomOrderBody | null }[] = [
    { day: 16, order: () => ({ kind: "forage" }) },
    { day: 18, order: (x) => ({ kind: "recruit", at: ch, army: x.king.army, unit: "slinger", levy: true }) },
    { day: 20, order: (x) => ({ kind: "split", army: x.king.army, squads: [x.armies[0].squads[1]?.id ?? 0] }) },
    { day: 21, order: (x) => (x.armies[1] ? { kind: "marchArmy", army: x.armies[1].id, to: id(x, "greyshaw") } : null) },
    { day: 22, order: (x) => (x.armies[0] ? { kind: "setDoctrine", army: x.armies[0].id, doctrine: "maneuver" } : null) },
    { day: 30, order: (x) => (x.armies[1] ? { kind: "merge", army: x.armies[1].id, into: x.armies[0].id } : null) },
    { day: 34, order: () => ({ kind: "build", holding: ch, building: "barracks" }) },
    { day: 50, order: (x) => ({ kind: "recruit", at: ch, army: x.king.army, unit: "line", levy: false }) },
    { day: 52, order: (x) => (x.armies[0] ? { kind: "unlockAbility", army: x.armies[0].id, ability: "levy" } : null) },
    { day: 55, order: (x) => (x.armies[0] ? { kind: "marchArmy", army: x.armies[0].id, to: id(x, "thornwick") } : null) },
    { day: 70, order: () => ({ kind: "moveKing", to: ch }) },
    { day: 80, order: (x) => (x.armies[0] ? { kind: "recover", army: x.armies[0].id } : null) },
    { day: 95, order: () => ({ kind: "kingJoin", army: 0 }) },
    { day: 96, order: (x) => (x.armies[0] ? { kind: "disband", army: x.armies[0].id } : null) },
  ];
  // Funding the barracks and wages, given on the day before (setup, through the ledger).
  const gift: { day: number; stocks: Partial<Record<(typeof STOCK_IDS)[number], number>> }[] = [
    { day: 33, stocks: { coin: 120, timber: 30, iron: 8, grain: 300 } },
    { day: 49, stocks: { levy: 25, coin: 60, iron: 4 } },
    // K6: bread for the last weeks, or a month of famine at Cold Hearth
    // ends in a revolt (K6's rule, tools/kingdom-morale.ts) and the
    // stand-down this script ends on has no town of the king's to go home to.
    // A little at a time: loose grain spoils.
    ...[50, 55, 60, 65, 70, 75, 80, 85, 90].map((day) => ({ day, stocks: { grain: 150 } })),
  ];
  const start = w.date.day;
  for (let d = start; d < days; d++) {
    if (stopAt >= 0 && d >= stopAt) break;
    if (gifts) for (const g of gift) if (g.day === d) give(w, g.stocks);
    for (const p of plan) {
      if (p.day !== d) continue;
      const o = p.order(w);
      if (o) w.issue(o);
    }
    nextDay(w, () => each?.(w));
  }
  return w;
}

section("the ledger balances with armies");
{
  let problem = "";
  let pages = 0;
  let last: LedgerDay | null = null;
  const categories = new Set<string>();
  const w = scripted(SEED, 120, (x) => {
    const book = x.books[KING];
    const c = book.closed;
    if (!c || c === last) return;
    last = c;
    pages++;
    LEDGER_STOCK_IDS.forEach((st, i) => {
      if (c.start[i] + netOf(c, st) !== book.open.start[i]) problem ||= st + " on day " + c.day;
      for (const cat of LEDGER_CATEGORIES) if (flowOf(c, st, cat.id) > 0) categories.add(cat.id);
    });
    for (const st of STOCK_IDS) if (x.economy[KING].stocks[st] < 0) problem ||= st + " below zero";
  });
  check("every day balances: end = start + sources - sinks", problem === "" && pages > 90, problem || pages + " pages");
  for (const cat of ["recruitment", "rations", "provisions", "wages", "favours", "disbanded"]) {
    check("army flows are booked under " + cat, categories.has(cat));
  }
  check("the realm ends with its army stood down", w.armies.length === 0 && w.king.army === 0);
}

// -- 10. replay and save --------------------------------------------------------------------------

section("replay and save/load");
{
  const a = scripted(SEED, 100);
  const b = scripted(SEED, 100);
  check("two runs of the same script agree", kingdomHash(a) === kingdomHash(b));
  // Gifts are test setup outside the order log, so the replay runs the script without them.
  const o = scripted(SEED, 100, undefined, -1, false);
  const r = replayLog(SEED, o.log, o.now);
  check("the log alone replays a run with armies", kingdomHash(r) === kingdomHash(o) && o.log.length > 10, o.log.length + " orders");
  // Save halfway, load, and carry on: the same as never stopping.
  const half = scripted(SEED, 100, undefined, 60);
  const json = saveToJson(half);
  const loaded = loadFromJson(json);
  check("a realm with armies saves and loads", loaded.ok && kingdomHash(loaded.value) === kingdomHash(half), loaded.ok ? "" : loaded.error);
  if (loaded.ok) {
    const w = loaded.value;
    check("armies, squads and the king's place come back", w.armies.length === half.armies.length && w.king.army === half.king.army &&
      JSON.stringify(w.armies) === JSON.stringify(half.armies));
    // Continue both by the same orders.
    const cont = (x: KingdomWorld): string => {
      for (let i = 0; i < 20 * TICKS_PER_DAY; i++) {
        if (i === 3 && x.armies[0]) x.issue({ kind: "marchArmy", army: x.armies[0].id, to: id(x, "fell-end") });
        x.tick();
      }
      return kingdomHash(x);
    };
    check("and carries on exactly as one that never stopped", cont(w) === cont(half));
  }
  const bad = JSON.parse(json);
  if (bad.snapshot.armies[0]) {
    bad.snapshot.armies[0].squads[0].men = 999;
    check("a squad stronger than its type is refused", !deserialize(bad).ok);
    const bad2 = JSON.parse(json);
    bad2.snapshot.armies[0].squads[0].wounded = bad2.snapshot.armies[0].squads[0].men + 1;
    check("more wounded than men is refused", !deserialize(bad2).ok);
    const bad3 = JSON.parse(json);
    bad3.snapshot.king.army = 9999;
    check("the king riding with no such army is refused", !deserialize(bad3).ok);
  }
  // K5 moved the version on to 5 (tools/kingdom-descent.ts tests that step).
  check("the save is version " + KINGDOM_SAVE_VERSION, JSON.parse(json).version === KINGDOM_SAVE_VERSION && KINGDOM_SAVE_VERSION >= 4);
}

section("migration v3 -> v4");
{
  const here = fileURLToPath(new URL(".", import.meta.url));
  const text = readFileSync(here + "fixtures/kingdom-save-v3.json", "utf8");
  const v3 = JSON.parse(text);
  check("the fixture is a real version-3 save", v3.version === 3 && !("armies" in v3.snapshot));
  const m = migrate(JSON.parse(text), MIGRATIONS, 4);
  check("it migrates to version 4", m.ok && m.value.version === 4);
  const m3 = migrate(JSON.parse(text), MIGRATIONS, 3);
  check("a version-3 save is already at 3", m3.ok && m3.value.version === 3);
  const loaded = loadFromJson(text);
  check("and loads", loaded.ok, loaded.ok ? "" : loaded.error);
  if (loaded.ok) {
    const w = loaded.value;
    check("with no armies, the king alone", w.armies.length === 0 && w.king.army === 0);
    check("the day and stores as they were", w.now === v3.snapshot.now && STOCK_IDS.every((s) => w.economy[KING].stocks[s] === v3.snapshot.economy[0].stocks[s]));
    const oldNC = v3.snapshot.economy[0].open.flow.length / LEDGER_STOCK_IDS.length;
    const page = w.books[KING].open;
    const nc = LEDGER_CATEGORY_IDS.length;
    let kept = page.flow.length === nc * LEDGER_STOCK_IDS.length;
    for (let s = 0; s < LEDGER_STOCK_IDS.length; s++) {
      for (let c = 0; c < nc; c++) {
        const want = c < oldNC ? v3.snapshot.economy[0].open.flow[s * oldNC + c] : 0;
        if (page.flow[s * nc + c] !== want) kept = false;
      }
    }
    check("ledger pages re-laid for K4's three categories (and K6's two, K7's one), every old value kept", kept && nc === oldNC + 6);
    // (Its log is kept, not re-run: K4's rules -- the followers leave a
    // hungry camp -- would play an old log out differently. The snapshot is
    // the realm; the log is its history.)
    check("its order log is kept", w.log.length === v3.log.length);
    const again = loadFromJson(saveToJson(w));
    check("and it saves again as version 4, unchanged", again.ok && kingdomHash(again.value) === kingdomHash(w));
    runDays(w, 5);
    check("and it plays on", w.now === v3.snapshot.now + 5 * TICKS_PER_DAY);
  }
}

// -- 11. the king and his army ---------------------------------------------------------------------

section("the king rides with his army");
{
  const w = firstArmy(SEED);
  const a = w.armies[0];
  const ev = issue(w, { kind: "moveKing", to: id(w, "greyshaw") });
  check("marching the king marches his army", !rejected(ev) && a.mover.route.length > 0, rejected(ev) ?? "");
  let together = true;
  const days = arrive(w, a, id(w, "greyshaw"), 40, (x) => {
    const k = x.king.mover;
    if (k.node !== a.mover.node || k.road !== a.mover.road || k.along !== a.mover.along) together = false;
  });
  check("he travels where it travels", together && days > 0, days + " days");
  check("at the army's pace, slower than his party alone", armySpeedPct(a) <= 100);
  issue(w, { kind: "kingJoin", army: 0 });
  check("he can ride alone again, where it stands", w.king.army === 0 && standsIn(w.king.mover) === standsIn(a.mover));
  issue(w, { kind: "moveKing", to: id(w, "cold-hearth") });
  runDays(w, 1);
  check("and then he marches alone", standsIn(a.mover) === id(w, "greyshaw") && w.king.mover.road !== 0);
  const w2 = firstArmy(SEED);
  issue(w2, { kind: "disband", army: w2.armies[0].id });
  check("an army stood down at home leaves the king alone, its men his followers again", w2.armies.length === 0 && w2.king.army === 0 &&
    w2.kingStocks.stocks.levy > 0);
  // The claim counts the men he rides with.
  const w3 = new KingdomWorld({ seed: SEED });
  issue(w3, { kind: "rally" });
  while (w3.kingStocks.stocks.levy < 6) w3.tick();
  issue(w3, { kind: "recruit", at: id(w3, "cold-hearth"), army: 0, unit: "line", levy: true });
  check("with every follower in squads, he can still claim", w3.kingStocks.stocks.levy === 0 &&
    w3.check({ kind: "claimHolding", holding: id(w3, "cold-hearth") }) === null);
}

// -- 12. orders ------------------------------------------------------------------------------------

section("garrison, patrol, doctrine, abilities, intercept");
{
  const w = bigArmy();
  const a = w.armies[0];
  issue(w, { kind: "garrison", army: a.id });
  check("an army digs in where it stands", a.posture === "hold");
  runDays(w, 3);
  check("and counts the days dug in", a.postureDays >= 3);
  const gs = id(w, "greyshaw");
  const ev = issue(w, { kind: "patrol", army: a.id, holdings: [id(w, "cold-hearth"), gs] });
  check("a patrol between two holdings", !rejected(ev) && a.posture === "patrol", rejected(ev) ?? "");
  const seen = new Set<number>();
  runDays(w, 30, () => { const at = standsIn(a.mover); if (at) seen.add(at); });
  check("walks round and round", seen.has(gs) && seen.has(id(w, "cold-hearth")) && a.posture === "patrol");
  issue(w, { kind: "haltArmy", army: a.id });
  check("a halt ends it", a.posture === "none" && a.patrol.length === 0);
  const pct = armySpeedPct(a);
  issue(w, { kind: "setDoctrine", army: a.id, doctrine: "aggressive" });
  check("doctrine is the army's, and sets its pace", a.doctrine === "aggressive" && armySpeedPct(a) > pct, pct + " -> " + armySpeedPct(a));
  give(w, { coin: 200 });
  const legit = w.kingStocks.legitimacy;
  const price = abilityPrice("smoke", a.doctrine);
  const ev2 = issue(w, { kind: "unlockAbility", army: a.id, ability: "smoke" });
  check("an ability is earned with coin and legitimacy", !rejected(ev2) && a.abilities.includes("smoke") &&
    w.kingStocks.legitimacy === legit - price.legitimacy, rejected(ev2) ?? "");
  issue(w, { kind: "unlockAbility", army: a.id, ability: "smoke" });
  check("at most " + MAX_OF_ONE_ABILITY + " of one", w.check({ kind: "unlockAbility", army: a.id, ability: "smoke" }) === ARMY_REFUSAL.abilityCap(MAX_OF_ONE_ABILITY));
  check("and the battle list carries it", armyList(a).abilities?.filter((x) => x === "smoke").length === 2);
  // Intercept is for other sides' armies.
  issue(w, { kind: "split", army: a.id, squads: [a.squads[0].id] });
  const mine = w.armies[1];
  check("never your own: that is a merge", w.check({ kind: "intercept", army: a.id, target: mine.id }) === ARMY_REFUSAL.interceptOwn);
  const far = raiseArmy(w, BOAR, id(w, "boarsden"), ["line"]);
  check("not one no one has eyes on", w.check({ kind: "intercept", army: a.id, target: far.id }) === ARMY_REFUSAL.notSeen);
  const near = raiseArmy(w, BOAR, gs, ["line"]);
  // Walk towards Greyshaw until it comes into sight, then stop.
  issue(w, { kind: "marchArmy", army: a.id, to: gs });
  for (let i = 0; i < 40 * TICKS_PER_DAY && !armyVisible(w, KING, near); i++) w.tick();
  issue(w, { kind: "haltArmy", army: a.id });
  check("but one in sight", w.check({ kind: "intercept", army: a.id, target: near.id }) === null);
  check("another side's army cannot be commanded", w.check({ kind: "marchArmy", army: near.id, to: gs }) === ARMY_REFUSAL.notYourArmy);
  issue(w, { kind: "intercept", army: a.id, target: near.id });
  let met = false;
  runDays(w, 20, (_x, evs) => { for (const e of evs) if (e.kind === "intercepted" && e.army === a.id) met = true; });
  check("an intercept marches to meet it, and stops on contact", met && inContact(w, a, near) && a.target === 0);
  // K5: and the meeting of two enemies is a contact that holds the realm (tools/kingdom-descent.ts).
  check("which is a contact, waiting on the king", w.contact !== null && w.contact.sides[0].army === a.id && w.contact.sides[1].army === near.id);
}

// -- 13. fog and foraging ----------------------------------------------------------------------------

section("armies see, and forage");
{
  const w = firstArmy(SEED);
  const a = w.armies[0];
  issue(w, { kind: "kingJoin", army: 0 });
  const before = sightSources(w, KING).length;
  check("an army is a sight source", before >= 2);
  issue(w, { kind: "marchArmy", army: a.id, to: id(w, "rookstead") });
  arrive(w, a, id(w, "rookstead"), 60);
  const rook = w.holdingByKey("rookstead")!;
  check("it sees where the king is not", holdingKnowledge(w, KING, rook.id) === KNOW_SEEN && standsIn(a.mover) === rook.id);
  // Foraging strips the fields it stands in.
  const f = firstArmy(SEED);
  const ch = f.holdingByKey("cold-hearth")!;
  const p = ch.plots[0];
  p.crop = "rye"; p.stage = "growing"; p.health = 100; // test setup
  // Empty the packs and stores so it must live off the land.
  f.armies[0].supply = 0;
  f.economy[KING].stocks.grain = 0;
  issue(f, { kind: "kingJoin", army: 0 });
  nextDay(f);
  check("an army living off the land tramples the crops", p.health < 100, String(p.health));
  check("and the holding remembers it (K6's unrest hook)", ch.foraged >= 1);
}

// -- 14. the pen: one function for preview and commit -------------------------------------

section("the pen: army strokes preview what they commit");
{
  const cases = buildKingdomCorpus().filter((c) => c.armies);
  const ORDER_OF: Record<string, string> = {
    march: "marchArmy", intercept: "intercept", merge: "merge", join: "kingJoin", split: "split",
    garrison: "garrison", patrol: "patrol", recover: "recover",
  };
  let same = 0;
  let untouched = true;
  let ordered = 0;
  let accepted = 0;
  let rightKind = 0;
  let refusedSaid = 0;
  let refusals = 0;
  const kinds = new Set<string>();
  for (const c of cases) {
    const { world } = armyWorld();
    const before = kingdomHash(world);
    const king = world.kingPosition();
    const pts = armyPointsOf(world);
    let preview = null as ReturnType<typeof interpretStroke> | null;
    for (let n = 1; n <= c.points.length; n++) preview = interpretStroke(c.points.slice(0, n), c.ctx, world, king, pts);
    const commit = interpretStroke(c.points, c.ctx, world, king, pts);
    if (JSON.stringify(preview) === JSON.stringify(commit)) same++;
    if (kingdomHash(world) !== before) untouched = false;
    const kind = c.expected.split(":")[0];
    if (commit.order) {
      ordered++;
      kinds.add(commit.order.kind);
      const want = kind === "march" && commit.order.kind === "moveKing" ? "moveKing" : ORDER_OF[kind];
      if (commit.order.kind === want) rightKind++;
      world.issue(commit.order);
      if (!rejected(world.tick())) accepted++;
    } else if (ORDER_OF[kind]) {
      // A recognised army stroke the sim refuses must say why, on the plate and after release.
      refusals++;
      if (commit.ghost.kind === "none" && commit.ghost.label.startsWith("no order: ") && commit.message.length > 0) refusedSaid++;
    }
  }
  check("every army-scene stroke: the last preview equals the commit", same === cases.length, same + "/" + cases.length);
  check("interpreting never writes the world", untouched);
  check("each order is the one its stroke names", rightKind === ordered, rightKind + "/" + ordered);
  check("and the sim accepts every order the pen commits", accepted === ordered, accepted + "/" + ordered);
  check("every army order kind is reachable by pen", ["marchArmy", "intercept", "merge", "kingJoin", "split", "garrison", "patrol", "recover"]
    .every((k) => kinds.has(k)), [...kinds].join(","));
  check("a stroke the sim would refuse says why", refusedSaid === refusals, refusedSaid + "/" + refusals);
  // The plate for a refused split: a one-squad army.
  const { world, armies } = armyWorld();
  const ctx = kingdomContext(world, world.kingPosition(), 0.45);
  const c4 = ctx.tokens.find((t) => t.id === armies.A4)!;
  const across = [{ x: c4.x + 8, y: c4.y + 14 }, { x: c4.x + 2, y: c4.y }, { x: c4.x - 4, y: c4.y - 14 }];
  const it = interpretStroke(across, ctx, world, world.kingPosition());
  check("a line across a one-squad army is refused, and says so", it.gesture.kind === "split" && it.order === null &&
    it.ghost.label.includes(ARMY_REFUSAL.splitOne), it.ghost.label);
}

console.log("\n" + (failures === 0 ? "all " + checks + " army checks passed" : failures + " of " + checks + " army check(s) FAILED"));
if (failures > 0) process.exitCode = 1;
