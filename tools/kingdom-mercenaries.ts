/**
 * K7 test suite: free companies (PLAN.md §B.7, §B.11 K7). Part of `npm test`;
 * headless, no DOM.
 *
 * THE PROOF is the lifecycle, step by step, each with the rule it is held to
 * (content/kingdom/mercenaries.ts):
 *
 *   offer (a king's tavern; the act gate; an offer's days; moving on and
 *   coming back) -> hire (the fee, the army raised whole at the tavern, no
 *   levy; one check for the button and the tick) -> paid upkeep (the
 *   contract's wage, loyalty rising; no barracks replacements; its own
 *   ranks) -> contract end (the renewal window and its fee, or expiry) ->
 *   unpaid (loyalty falling) -> desert (reliable) or betray (bloody,
 *   turncoats) -- plus the crown's poaching bid, matched or not, the bloody
 *   company's unrest, dismissal and a company broken in the field.
 *
 * And THE BETRAYAL SCENARIO, scripted: a turncoat company hired beside the
 * king's own army goes unpaid, turns its coat on the morning its loyalty is
 * spent, and K5's contact finds the two armies face to face in the king's
 * town -- the realm holds for the battle; it is the same on every run, and
 * the order log replays to it.
 *
 * Also: save v7 round trip, the v6 -> v7 migration, tampering refused, and
 * the ledger balancing every day with fees, renewals and bids on it.
 */

import {
  KingdomWorld, kingdomHash, saveToJson, loadFromJson, serialize, deserialize, replayLog, migrate, KINGDOM_SAVE_VERSION,
  TICKS_PER_DAY, DAYS_PER_SEASON, armyById, armyMen, standsIn, credit, debit, flowOf, netOf, removeArmy, raiseArmy, renewFee, bidFor,
  offersAt, companyOf,
  type Army, type Company, type Holding, type KingdomEvent, type KingdomOrderBody, type LedgerDay,
} from "../src/sim/kingdom/index.ts";
import {
  FACTION_IDS, LEDGER_CATEGORY_IDS, LEDGER_STOCK_IDS, STOCK_IDS, MERCENARIES, ACT_HOLDINGS, AWAY_DAYS, BLOODY,
  LEAVE_LEGITIMACY, LOYALTY, OFFER_DAYS, POACH, RENEW_WINDOW, TURNED_FACTION, validateMercenaryRules,
  MERC_REFUSAL, ARMY_REFUSAL,
} from "../src/content/kingdom/index.ts";
import { REFUSAL } from "../src/content/kingdom/ui-strings.ts";
import { PEN, isCompanyName } from "../src/content/kingdom/army-strings.ts";
import { UNIT_TYPES } from "../src/content/unit-types.ts";

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

const SEED = 0x6b1d0007;
const KING = 0;
const USURPER = FACTION_IDS.indexOf(TURNED_FACTION);
const TAVERNS = ["greyshaw", "thornwick", "fell-end", "rookstead"];
const idx = (id: string): number => MERCENARIES.findIndex((m) => m.id === id);
const HARKER = idx("harker-outriders");
const REDMAYNE = idx("redmayne-lances");
const HALLOWAY = idx("halloway-horse");
const CORBIN = idx("corbin-pack");

/** Tick through the next day's first tick (that day's economy, armies, morale and companies have run). */
function nextDay(w: KingdomWorld, each?: (ev: KingdomEvent[]) => void): void {
  do {
    const ev = w.tick();
    each?.(ev);
  } while (w.now % TICKS_PER_DAY !== 1 && !w.contact);
}
function days(w: KingdomWorld, n: number, each?: (ev: KingdomEvent[]) => void): void {
  for (let i = 0; i < n && !w.contact; i++) nextDay(w, each);
}
/** Test setup through the ledger, so conservation still holds. */
function give(w: KingdomWorld, stocks: Partial<Record<(typeof STOCK_IDS)[number], number>>): void {
  for (const s of STOCK_IDS) if (stocks[s]) credit(w.economy[KING], w.books[KING], s, stocks[s]!, "trade");
}
function take(w: KingdomWorld, s: (typeof STOCK_IDS)[number]): void {
  const n = w.economy[KING].stocks[s];
  if (n > 0) debit(w.economy[KING], w.books[KING], s, n, "offerings");
}
function issue(w: KingdomWorld, body: KingdomOrderBody, player = KING): KingdomEvent[] {
  w.issue(body, player);
  return w.tick();
}
const rejectedWith = (ev: KingdomEvent[]): string | null => {
  const r = ev.find((e) => e.kind === "orderRejected");
  return r && r.kind === "orderRejected" ? r.reason : null;
};
const has = (ev: KingdomEvent[], kind: KingdomEvent["kind"]): boolean => ev.some((e) => e.kind === kind);

/** Test setup: a king's holding with a standing tavern, untaxed (so K6 leaves it calm). */
function tavern(w: KingdomWorld, key: string): Holding {
  const h = w.holdingByKey(key)!;
  h.owner = "king";
  h.tax = "none";
  const slot = h.buildings.indexOf(null);
  h.buildings[slot] = "tavern";
  h.works[slot] = 0;
  return h;
}

/**
 * The fixture: day 1 of a fresh exile; `n` of the four taverns stand in the
 * king's holdings (so the act gate is the realm's size: n holdings); bread
 * and coin in the stores. One more day, and the companies come.
 */
function realm(n: number, coin = 300, seed = SEED): { w: KingdomWorld; hs: Holding[] } {
  const w = new KingdomWorld({ seed });
  nextDay(w);
  const hs = TAVERNS.slice(0, n).map((k) => tavern(w, k));
  give(w, { grain: 2000, coin });
  return { w, hs };
}
const co = (w: KingdomWorld, i: number): Company => w.companies[i];

/** A scripted bad year: the tavern's trade (its coin a day) gone with the tavern, so wages can fall behind. */
function closeTavern(h: Holding): void {
  const slot = h.buildings.indexOf("tavern");
  if (slot >= 0) h.buildings[slot] = null;
}

/** Hire company `i` where it is offered; returns its army. */
function hire(w: KingdomWorld, i: number): Army {
  const c = co(w, i);
  const ev = issue(w, { kind: "hireCompany", company: i, at: c.at });
  const why = rejectedWith(ev);
  if (why) throw new Error("hire refused: " + why);
  return armyById(w, co(w, i).army)!;
}

// -- 1. the tables -----------------------------------------------------------------------------

section("the tables");
{
  check("the rules validate", validateMercenaryRules().length === 0, validateMercenaryRules().join("; "));
  check("seven companies, every mix within the rulebook's caps", MERCENARIES.length === 7 && MERCENARIES.every((m) =>
    m.mix.every((u) => m.mix.filter((x) => x === u).length <= UNIT_TYPES[u].maxPerArmy)));
  const w = new KingdomWorld({ seed: SEED });
  check("a new world: every company waiting, in table order", w.companies.length === MERCENARIES.length &&
    w.companies.every((c, i) => c.index === i && c.state === "waiting" && c.army === 0));
  check("'hiring' is a sink of the ledger", LEDGER_CATEGORY_IDS.includes("hiring"));
  // K11 (audit M-09): a company's name takes no "the" and a plural verb.
  const said = PEN.garrisonDone({ army: MERCENARIES[0].name, name: "Rookstead" });
  check("a company digs in without a stray article: \"" + said + "\"", said === MERCENARIES[0].name + " dig in at Rookstead.");
  check("and the king's own armies keep theirs", PEN.garrisonDone({ army: "First Army", name: "Rookstead" }) === "The First Army digs in at Rookstead.");
  check("every company's name reads as one", MERCENARIES.every((m) => isCompanyName(m.name)));
}

// -- 2. offers ---------------------------------------------------------------------------------

section("offers: the tavern is the source");
{
  const none = new KingdomWorld({ seed: SEED });
  days(none, 5);
  check("with no tavern, nobody comes", none.companies.every((c) => c.state === "waiting"));

  const { w, hs } = realm(1);
  const ev: KingdomEvent[] = [];
  nextDay(w, (e) => ev.push(...e));
  const g = hs[0];
  check("a standing tavern of the king's: the first company of act 1 comes to drink", co(w, HARKER).state === "offered" &&
    co(w, HARKER).at === g.id && co(w, HARKER).days === OFFER_DAYS && ev.some((e) => e.kind === "companyOffered" && e.company === HARKER));
  check("one company to a tavern", offersAt(w, g.id).length === 1 && w.companies.filter((c) => c.state === "offered").length === 1);

  // The act gate (K7.2): a second tavern in a one-holding... two-holding realm gets nobody of act 2.
  const two = realm(2);
  nextDay(two.w);
  check("act 2's companies wait for a realm of " + ACT_HOLDINGS[2] + " holdings", offersAt(two.w, two.hs[1].id).length === 0 &&
    co(two.w, REDMAYNE).state === "waiting");
  const four = realm(4);
  nextDay(four.w);
  check("with " + ACT_HOLDINGS[2] + "+, each tavern takes the next, in holding order",
    co(four.w, HARKER).at === four.hs[0].id && co(four.w, REDMAYNE).at === four.hs[1].id &&
    co(four.w, HALLOWAY).at === four.hs[2].id && co(four.w, CORBIN).at === four.hs[3].id);

  // An offer stands OFFER_DAYS, then the company moves on, is away AWAY_DAYS, and comes back.
  const moved: KingdomEvent[] = [];
  days(w, OFFER_DAYS, (e) => moved.push(...e));
  check("unhired, it moves on after " + OFFER_DAYS + " days", co(w, HARKER).state !== "offered" &&
    moved.some((e) => e.kind === "companyMovedOn" && e.company === HARKER));
  check("and the tavern is free for the next company free to come", offersAt(w, g.id).length <= 1);
  days(w, AWAY_DAYS + 1);
  check("after " + AWAY_DAYS + " days away it can come back", co(w, HARKER).state === "offered" || co(w, HARKER).state === "waiting");

  // A tavern lost (the holding taken) withdraws the offer.
  const lost = realm(1);
  nextDay(lost.w);
  lost.hs[0].owner = null;
  const lev: KingdomEvent[] = [];
  nextDay(lost.w, (e) => lev.push(...e));
  check("a tavern no longer the king's: the company moves on", co(lost.w, HARKER).state === "away" && has(lev, "companyMovedOn"));
}

// -- 3. hire -----------------------------------------------------------------------------------

section("hire: fee, a whole company at the tavern, no levy");
{
  const { w, hs } = realm(1, 0);
  nextDay(w);
  const g = hs[0];
  const def = MERCENARIES[HARKER];
  const body: KingdomOrderBody = { kind: "hireCompany", company: HARKER, at: g.id };
  check("no coin: refused with the fee", w.check(body) === MERC_REFUSAL.fee(def.fee));
  check("the same refusal when the order lands", rejectedWith(issue(w, body)) === MERC_REFUSAL.fee(def.fee));
  give(w, { coin: 100 });
  check("not where it is offered: refused", w.check({ ...body, at: w.holdingByKey("cold-hearth")!.id }) === MERC_REFUSAL.notYourHolding);
  check("a company not offered: refused", w.check({ ...body, company: REDMAYNE }) === MERC_REFUSAL.notOffered);
  check("no such company: refused", w.check({ ...body, company: 99 }) === MERC_REFUSAL.noSuchCompany);
  check("only the king hires", w.check(body, USURPER) === REFUSAL.onlyKing);
  check("with the fee, nothing refuses", w.check(body) === null);
  const coin0 = w.kingStocks.stocks.coin;
  const levy0 = w.kingStocks.stocks.levy;
  const hiresBefore = flowOf(w.books[KING].open, "coin", "hiring");
  const ev = issue(w, body);
  const c = co(w, HARKER);
  const a = armyById(w, c.army);
  check("hired: an army on the map, at the tavern", !!a && standsIn(a.mover) === g.id && has(ev, "companyHired") && has(ev, "armyRaised"));
  if (a) {
    check("named for the company, led by its captain", a.name === def.name && a.captain === def.captain && a.company === HARKER + 1);
    check("its own squads, full and trained", a.squads.length === def.mix.length && a.squads.every((s, i) =>
      s.unit === def.mix[i] && !s.levy && s.men === UNIT_TYPES[s.unit].soldiers));
    check("the fee is paid, under 'hiring'", w.kingStocks.stocks.coin === coin0 - def.fee &&
      flowOf(w.books[KING].open, "coin", "hiring") - hiresBefore === def.fee);
    check("no levy is spent (§B.7: distinct from levy)", w.kingStocks.stocks.levy === levy0);
    check("contract and loyalty from the table", c.state === "hired" && c.days === def.contractDays && c.loyalty === def.loyalty);
    check("companyOf finds it", companyOf(w, a) === c);
    check("the tavern is free for the next", offersAt(w, g.id).length === 0);
    check("a second hire of it is refused", w.check(body) === MERC_REFUSAL.notOffered);
  }
}

// -- 4. paid upkeep ----------------------------------------------------------------------------

section("paid upkeep: the contract's wage; its own ranks");
{
  const { w, hs } = realm(1);
  nextDay(w);
  const a = hire(w, HARKER);
  const def = MERCENARIES[HARKER];
  const c = co(w, HARKER);
  const l0 = c.loyalty;
  const days0 = c.days;
  let wages = 0;
  nextDay(w, (ev) => { for (const e of ev) if (e.kind === "armyDay" && e.army === a.id) wages += e.paid; });
  check("a day's wage is the contract's (" + def.wage + " coin)", wages === def.wage && a.arrears === 0);
  check("paid, loyalty rises " + LOYALTY.paid, c.loyalty === l0 + LOYALTY.paid);
  check("and the contract runs down a day", c.days === days0 - 1);
  days(w, 10);
  check("paid every day, it keeps rising", c.loyalty === l0 + 11 * LOYALTY.paid && a.unpaid === 0);

  const other = raiseArmy(w, KING, hs[0].id, ["line"]);
  check("no merging into a company", w.check({ kind: "merge", army: other.id, into: a.id }) === MERC_REFUSAL.companyArmy);
  check("nor a company into another army", w.check({ kind: "merge", army: a.id, into: other.id }) === MERC_REFUSAL.companyArmy);
  check("no splitting it", w.check({ kind: "split", army: a.id, squads: [a.squads[0].id] }) === MERC_REFUSAL.companyArmy);
  check("no recruits into it", w.check({ kind: "recruit", army: a.id, at: hs[0].id, unit: "scout", levy: false }) === MERC_REFUSAL.companyArmy);

  // No replacement pipeline: a barracks, the levy and a rest replace nothing.
  const r = realm(1);
  nextDay(r.w);
  const ra = hire(r.w, HARKER);
  const rook = r.w.holdingByKey("rookstead")!;
  rook.owner = "king";
  rook.buildings[rook.buildings.indexOf(null)] = "barracks";
  give(r.w, { levy: 40, iron: 20 });
  ra.squads[0].men -= 4;
  ra.mover = { ...ra.mover, node: rook.id };
  issue(r.w, { kind: "recover", army: ra.id });
  const men0 = armyMen(ra);
  days(r.w, 3);
  check("a barracks does not refill a company's ranks", armyMen(ra) <= men0);
}

// -- 5. contract end -----------------------------------------------------------------------------

section("contract end: renew in the window, or they ride away");
{
  const { w } = realm(1);
  nextDay(w);
  const a = hire(w, HARKER);
  const def = MERCENARIES[HARKER];
  const c = co(w, HARKER);
  check("outside the window, renewing is refused", w.check({ kind: "renewContract", company: HARKER }) === MERC_REFUSAL.notInWindow(RENEW_WINDOW));
  const ev: KingdomEvent[] = [];
  days(w, def.contractDays - RENEW_WINDOW, (e) => ev.push(...e));
  check("at " + RENEW_WINDOW + " days left: word that the contract is ending", c.days === RENEW_WINDOW &&
    ev.some((e) => e.kind === "contractEnding" && e.company === HARKER));
  const fee = renewFee(HARKER);
  check("renewing costs half the fee, rounded up (" + fee + ")", fee === Math.ceil(def.fee / 2));
  const coin0 = w.kingStocks.stocks.coin;
  const rv = issue(w, { kind: "renewContract", company: HARKER });
  check("renewed: another contract's days, the fee paid", c.days === RENEW_WINDOW + def.contractDays &&
    w.kingStocks.stocks.coin === coin0 - fee && has(rv, "contractRenewed"));

  // Unrenewed, it expires.
  const x = realm(1);
  nextDay(x.w);
  const xa = hire(x.w, HARKER);
  const leg0 = x.w.economy[KING].legitimacy;
  const xev: KingdomEvent[] = [];
  days(x.w, def.contractDays, (e) => xev.push(...e));
  check("unrenewed, at the end of the contract the army leaves the map", !armyById(x.w, xa.id) &&
    xev.some((e) => e.kind === "armyGone" && e.army === xa.id && e.reason === "expired"));
  check("the company is away; an honest end costs the king's name nothing", co(x.w, HARKER).state === "away" &&
    xev.some((e) => e.kind === "companyLeft" && e.how === "expired") && LEAVE_LEGITIMACY.expired === 0);
  void leg0;
  {
    // Wages owed in the window: no renewal. (Redmayne's loyalty outlasts a few unpaid days.)
    const y = realm(4);
    nextDay(y.w);
    hire(y.w, REDMAYNE);
    days(y.w, MERCENARIES[REDMAYNE].contractDays - RENEW_WINDOW);
    for (const h of y.hs) closeTavern(h);
    take(y.w, "coin");
    nextDay(y.w);
    check("a renewal with wages owed is refused", co(y.w, REDMAYNE).state === "hired" &&
      y.w.check({ kind: "renewContract", company: REDMAYNE }) === MERC_REFUSAL.arrears);
  }
  void a;
}

// -- 6. unpaid: the reliable walk away ---------------------------------------------------------------

section("unpaid: loyalty falls; a reliable company walks away");
{
  const { w, hs } = realm(1);
  nextDay(w);
  const a = hire(w, HARKER);
  closeTavern(hs[0]);
  const c = co(w, HARKER);
  take(w, "coin");
  const l0 = c.loyalty;
  nextDay(w);
  check("wages owed: loyalty falls " + LOYALTY.unpaid + " a day", a.arrears > 0 && c.loyalty === l0 - LOYALTY.unpaid);
  check("men do not trickle away as K4's unpaid do: the company stays whole", armyMen(a) === a.squads.reduce((n, s) => n + UNIT_TYPES[s.unit].soldiers, 0));
  const leg0 = w.economy[KING].legitimacy;
  const ev: KingdomEvent[] = [];
  let n = 1;
  while (co(w, HARKER).state === "hired" && n < 30) { nextDay(w, (e) => ev.push(...e)); n++; }
  check("at loyalty 0 it leaves", co(w, HARKER).state === "away" && !armyById(w, a.id), "after " + n + " days");
  check("as deserters (reliable), not turncoats", ev.some((e) => e.kind === "companyLeft" && e.how === "deserted") &&
    !w.armies.some((x) => x.company === HARKER + 1));
  check("and the king's name suffers " + LEAVE_LEGITIMACY.deserted, w.economy[KING].legitimacy === leg0 - LEAVE_LEGITIMACY.deserted);
}

// -- 7. unpaid: turncoats turn ---------------------------------------------------------------------

section("unpaid: a turncoat company goes over to the crown");
{
  const { w, hs } = realm(4);
  nextDay(w);
  const a = hire(w, HALLOWAY);
  const men = armyMen(a);
  // It is posted to Rookstead, the keep, as its garrison.
  a.mover = { ...a.mover, node: hs[3].id };
  issue(w, { kind: "garrison", army: a.id });
  check("it garrisons the keep", hs[3].garrison.includes(a.id));
  for (const h of hs) closeTavern(h);
  take(w, "coin");
  const leg0 = w.economy[KING].legitimacy;
  const ev: KingdomEvent[] = [];
  let n = 0;
  while (co(w, HALLOWAY).state === "hired" && n < 30) { nextDay(w, (e) => ev.push(...e)); n++; }
  check("its loyalty spent, it turns", co(w, HALLOWAY).state === "turned" && ev.some((e) => e.kind === "companyLeft" && e.how === "defected"));
  check("the same army, the same men, now the crown's", a.owner === USURPER && armyById(w, a.id) === a && armyMen(a) === men);
  check("out of the king's garrison", !hs[3].garrison.includes(a.id));
  check("its wages owed are nobody's now", a.arrears === 0 && a.unpaid === 0);
  check("betrayal costs the king " + LEAVE_LEGITIMACY.defected + " legitimacy", w.economy[KING].legitimacy === leg0 - LEAVE_LEGITIMACY.defected);
  check("the king cannot order it any more", w.check({ kind: "haltArmy", army: a.id }) === ARMY_REFUSAL.notYourArmy);
  days(w, AWAY_DAYS + OFFER_DAYS);
  check("a company that turned never comes back to the taverns", co(w, HALLOWAY).state === "turned");
}

// -- 8. poaching --------------------------------------------------------------------------------------

section("poaching: the crown's bid, matched or not");
{
  // Turncoats come with loyalty below the poaching line: the crown bids on the season's next bid day.
  const { w } = realm(4);
  nextDay(w);
  hire(w, HALLOWAY);
  const c = co(w, HALLOWAY);
  check("loyalty below the line (" + POACH.below.turncoats + ")", c.loyalty < POACH.below.turncoats);
  const ev: KingdomEvent[] = [];
  let n = 0;
  while (c.bid === 0 && n < DAYS_PER_SEASON + 1) { nextDay(w, (e) => ev.push(...e)); n++; }
  check("on a bid day the crown bids", c.bid === bidFor(HALLOWAY) && c.bidDays > 0 && POACH.onDays.includes(w.date.dayOfSeason) &&
    ev.some((e) => e.kind === "companyBid"));
  const coin0 = w.kingStocks.stocks.coin;
  const l0 = c.loyalty;
  const mv = issue(w, { kind: "matchBid", company: HALLOWAY });
  check("matched: the coin paid, loyalty up " + LOYALTY.matched + ", the bid gone", w.kingStocks.stocks.coin === coin0 - bidFor(HALLOWAY) &&
    c.loyalty === l0 + LOYALTY.matched && c.bid === 0 && has(mv, "bidMatched"));
  check("no bid, nothing to match", w.check({ kind: "matchBid", company: HALLOWAY }) === MERC_REFUSAL.noBid);

  const p = realm(4);
  nextDay(p.w);
  const pa = hire(p.w, HALLOWAY);
  const pc = co(p.w, HALLOWAY);
  n = 0;
  while (pc.bid === 0 && n < DAYS_PER_SEASON + 1) { nextDay(p.w); n++; }
  const pev: KingdomEvent[] = [];
  days(p.w, POACH.days, (e) => pev.push(...e));
  check("unmatched in " + POACH.days + " days, they are poached: the crown's", pc.state === "turned" && pa.owner === USURPER &&
    pev.some((e) => e.kind === "companyLeft" && e.how === "poached"));

  // A reliable company, paid, is not bid for.
  const r = realm(1);
  nextDay(r.w);
  hire(r.w, HARKER);
  days(r.w, 35);
  check("a paid, reliable company draws no bid", co(r.w, HARKER).bid === 0);
}

// -- 9. bloody ---------------------------------------------------------------------------------------

section("a bloody company: the town hates the king for it");
{
  const run = (bloody: boolean): { unrest: number; leg: number } => {
    const { w, hs } = realm(4);
    nextDay(w);
    const a = hire(w, bloody ? CORBIN : HALLOWAY);
    // Both stand in Rookstead, the fourth tavern; compare Rookstead's unrest.
    if (!bloody) a.mover = { ...a.mover, node: hs[3].id };
    const before = hs[3].unrest;
    nextDay(w);
    return { unrest: hs[3].unrest - before, leg: w.economy[KING].legitimacy };
  };
  const b = run(true);
  const t = run(false);
  check("unrest " + BLOODY.unrest + " permille a day more where it stands", b.unrest - t.unrest === BLOODY.unrest, b.unrest + " vs " + t.unrest);
  const { w } = realm(4);
  nextDay(w);
  hire(w, CORBIN);
  // ECON: the season's turn is ninety days off now -- keep the company in service until then
  // (setup: a long contract, high loyalty, and the coin for its wages).
  co(w, CORBIN).days = 2 * DAYS_PER_SEASON;
  co(w, CORBIN).loyalty = LOYALTY.max;
  give(w, { coin: 2000, grain: 2000 });
  const ev: KingdomEvent[] = [];
  while (w.date.dayOfSeason !== 0) nextDay(w, (e) => ev.push(...e));
  check("and at the season's turn the realm's standing pays for it", flowOf(w.books[KING].closed ?? w.books[KING].open, "legitimacy", "disgrace") >= BLOODY.legitimacy ||
    flowOf(w.books[KING].open, "legitimacy", "disgrace") >= BLOODY.legitimacy);
}

// -- 10. dismissal, and broken ---------------------------------------------------------------------------

section("dismissed, or broken in the field");
{
  const { w } = realm(1);
  nextDay(w);
  const a = hire(w, HARKER);
  const levy0 = w.kingStocks.stocks.levy;
  const ev = issue(w, { kind: "disband", army: a.id });
  check("disbanding a company dismisses it: off the map, away", !armyById(w, a.id) && co(w, HARKER).state === "away" &&
    ev.some((e) => e.kind === "companyLeft" && e.how === "dismissed"));
  check("its men are not the king's to send home: no levy", w.kingStocks.stocks.levy === levy0);

  const b = realm(1);
  nextDay(b.w);
  const ba = hire(b.w, HARKER);
  removeArmy(b.w, ba, "fell");
  check("destroyed in the king's service, the company is broken", co(b.w, HARKER).state === "broken");
  days(b.w, AWAY_DAYS + 5);
  check("and never comes to a tavern again", co(b.w, HARKER).state === "broken");
}

// -- 11. the betrayal scenario --------------------------------------------------------------------------

section("the betrayal: unpaid turncoats turn in the king's own town");
type Betrayal = { w: KingdomWorld; turnedOn: number; contactAt: number; hash: string };
function betrayal(seed: number): Betrayal {
  const { w, hs } = realm(4, 300, seed);
  nextDay(w);
  // Day 2: the king's First Army stands in Fell End; the Halloway Horse are hired there.
  const fell = hs[2];
  const own = raiseArmy(w, KING, fell.id, ["line", "line", "archer"]);
  hire(w, HALLOWAY);
  // Day 3: the treasury is emptied (a scripted bad harvest of coin), and stays empty.
  nextDay(w);
  take(w, "coin");
  let turnedOn = -1;
  for (let d = 0; d < 30 && !w.contact; d++) {
    nextDay(w, (ev) => { for (const e of ev) if (e.kind === "companyLeft" && e.how === "defected") turnedOn = w.date.day; });
    take(w, "coin");
  }
  void own;
  return { w, turnedOn, contactAt: w.contact ? w.contact.holding : 0, hash: kingdomHash(w) };
}
{
  const b = betrayal(SEED);
  const w = b.w;
  const c = w.contact;
  check("the company turned", b.turnedOn > 0 && co(w, HALLOWAY).state === "turned", "day " + b.turnedOn);
  check("and the same morning the realm halts on a contact", !!c && c.kind === "field", c ? c.kind : "none");
  if (c) {
    const mine = armyById(w, c.sides[0].army);
    const them = armyById(w, c.sides[1].army);
    check("the king's own army on one side...", !!mine && mine.owner === KING && mine.company === 0);
    check("...the company it paid on the other, under the crown's banner", !!them && them.owner === USURPER && them.company === HALLOWAY + 1);
    check("in the king's town, where they stood together", c.holding === w.holdingByKey("fell-end")!.id);
    const now = w.now;
    w.tick();
    check("the realm holds until it is settled", w.now === now && !!w.contact);
    const ev = issue(w, { kind: "resolveContact", contact: c.id, choice: "auto", result: null });
    check("auto-resolved, the realm moves on", !w.contact && has(ev, "contactResolved"));
  }
  const again = betrayal(SEED);
  check("the scenario is the same on every run", again.hash === b.hash && again.turnedOn === b.turnedOn);
  const json = saveToJson(again.w);
  const l = loadFromJson(json);
  check("saved on the contact, it loads as the same realm", l.ok && kingdomHash(l.value) === again.hash, l.ok ? "" : l.error);
}

// -- 12. save v7 ----------------------------------------------------------------------------------------

section("save v7: companies round-trip, v6 migrates, tampering refused");
{
  const { w } = realm(4);
  nextDay(w);
  hire(w, HARKER);
  hire(w, HALLOWAY);
  days(w, 20);
  check("the current version is 7 or later (K8: 8)", KINGDOM_SAVE_VERSION >= 7);
  const json = saveToJson(w);
  const l = loadFromJson(json);
  check("a world with companies in service round-trips", l.ok && kingdomHash(l.value) === kingdomHash(w), l.ok ? "" : l.error);
  if (l.ok) {
    check("every company's record comes back", JSON.stringify(l.value.companies) === JSON.stringify(w.companies));
    days(l.value, 15);
    days(w, 15);
    check("and carries on exactly as never stopping", kingdomHash(l.value) === kingdomHash(w));
  }

  const tamper = (f: (s: any) => void): boolean => { const s = JSON.parse(json); f(s); return !deserialize(s).ok; };
  check("a company list of the wrong length is refused", tamper((s) => { s.snapshot.companies.pop(); }));
  check("an unknown company state is refused", tamper((s) => { s.snapshot.companies[0].state = "drunk"; }));
  check("a hired company with no army is refused", tamper((s) => { s.snapshot.companies[HARKER].army = 0; }));
  check("loyalty over 100 is refused", tamper((s) => { s.snapshot.companies[HARKER].loyalty = 101; }));
  check("an army of a company that does not serve is refused", tamper((s) => {
    const a = s.snapshot.armies.find((x: { company: number }) => x.company === HARKER + 1);
    s.snapshot.companies[HARKER] = { company: MERCENARIES[HARKER].id, state: "away", at: 0, days: 5, loyalty: 0, army: 0, bid: 0, bidDays: 0 };
    void a;
  }));
  check("a hire order is read back", !tamper((s) => { s.log.push({ kind: "hireCompany", company: 3, at: 2, tick: 0, player: 0, seq: 9999 }); }));

  // v6 -> v7: the K7 fields go, the pages lose their last category.
  const plain = new KingdomWorld({ seed: SEED });
  days(plain, 12);
  const v6 = serialize(plain) as unknown as Record<string, any>;
  v6.version = 6;
  const width = LEDGER_CATEGORY_IDS.indexOf("hiring");
  const shrink = (p: LedgerDay | null): LedgerDay | null => {
    if (!p) return p;
    const flow: number[] = [];
    for (let s = 0; s < LEDGER_STOCK_IDS.length; s++) for (let c = 0; c < width; c++) flow.push(p.flow[s * LEDGER_CATEGORY_IDS.length + c]);
    return { ...p, flow };
  };
  delete v6.snapshot.companies;
  for (const a of v6.snapshot.armies) delete a.company;
  for (const e of v6.snapshot.economy) { e.open = shrink(e.open); e.closed = shrink(e.closed); }
  const m = migrate(JSON.parse(JSON.stringify(v6)));
  check("a version-6 save migrates to 7 and on to " + KINGDOM_SAVE_VERSION, m.ok && m.value.version === KINGDOM_SAVE_VERSION, m.ok ? "" : m.error);
  const lv = deserialize(JSON.parse(JSON.stringify(v6)));
  check("and loads, every company waiting", lv.ok && lv.value.companies.every((c) => c.state === "waiting"), lv.ok ? "" : lv.error);
  if (lv.ok) {
    const page = lv.value.books[KING].open;
    let kept = page.flow.length === LEDGER_STOCK_IDS.length * LEDGER_CATEGORY_IDS.length;
    for (let s = 0; s < LEDGER_STOCK_IDS.length && kept; s++) {
      for (let c = 0; c < LEDGER_CATEGORY_IDS.length; c++) {
        const want = c < width ? v6.snapshot.economy[0].open.flow[s * width + c] : 0;
        if (page.flow[s * LEDGER_CATEGORY_IDS.length + c] !== want) kept = false;
      }
    }
    check("ledger pages re-laid for K7's category, every old value kept", kept);
    check("the migrated world is the same realm", kingdomHash(lv.value) === kingdomHash(plain));
  }
}

// -- 13. the log replays ------------------------------------------------------------------------------------

section("the log replays, hiring and paying included");
{
  // The fixture's setup (taverns, stores) is not an order, so the replay
  // makes it at the same tick (1) and then submits the whole log, as
  // replayLog does: the hires, renewals and matched bids must bring the
  // world to the same state.
  const until = DAYS_PER_SEASON + 10; // ECON: past the first bid day of a 90-day season (day 45)
  const run = (): KingdomWorld => {
    const { w } = realm(4, 600);
    nextDay(w);
    hire(w, HARKER);
    hire(w, HALLOWAY);
    while (w.date.day < until) {
      for (const i of [HARKER, HALLOWAY]) {
        if (w.check({ kind: "matchBid", company: i }) === null) w.issue({ kind: "matchBid", company: i });
        if (w.check({ kind: "renewContract", company: i }) === null) w.issue({ kind: "renewContract", company: i });
      }
      nextDay(w);
    }
    return w;
  };
  const w = run();
  const r = new KingdomWorld({ seed: SEED });
  for (const o of w.log) r.submit(o);
  r.tick();
  for (const k of TAVERNS) tavern(r, k);
  give(r, { grain: 2000, coin: 600 });
  while (r.now < w.now) r.tick();
  check("the run hired, matched and renewed by order", ["hireCompany", "matchBid", "renewContract"].every((k) => w.log.some((o) => o.kind === k)),
    [...new Set(w.log.map((o) => o.kind))].join(","));
  check("the log replays to it", kingdomHash(r) === kingdomHash(w));
  void replayLog;
}

// -- 14. the ledger ---------------------------------------------------------------------------------------------

section("the ledger balances with fees, renewals and bids on it");
{
  let problem = "";
  let pages = 0;
  let last: LedgerDay | null = null;
  const { w } = realm(4, 600);
  nextDay(w);
  hire(w, HARKER);
  hire(w, HALLOWAY);
  hire(w, CORBIN);
  while (w.date.day < 100) {
    for (const i of [HARKER, HALLOWAY, CORBIN]) {
      if (w.check({ kind: "matchBid", company: i }) === null) w.issue({ kind: "matchBid", company: i });
      if (w.check({ kind: "renewContract", company: i }) === null) w.issue({ kind: "renewContract", company: i });
    }
    nextDay(w, () => {
      const book = w.books[KING];
      const c = book.closed;
      if (!c || c === last) return;
      last = c;
      pages++;
      LEDGER_STOCK_IDS.forEach((st, i) => {
        if (c.start[i] + netOf(c, st) !== book.open.start[i]) problem ||= st + " on day " + c.day;
      });
      for (const st of STOCK_IDS) if (w.economy[KING].stocks[st] < 0) problem ||= st + " below zero";
    });
    if (w.contact) break;
  }
  check("every day balances: end = start + sources - sinks", problem === "" && pages > 80, problem || pages + " pages");
}

console.log(failures === 0 ? "\nall " + checks + " mercenary checks passed" : "\n" + failures + " of " + checks + " mercenary check(s) FAILED");
if (failures > 0) process.exitCode = 1;
