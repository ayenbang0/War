/**
 * K8 test suite: the captains' strategic AI, invasions and the defence tools
 * (PLAN.md §B.8, §B.11 K8). Part of `npm test`; headless, no DOM.
 *
 * THE PROOF, as the plan names it:
 *
 *   1. The AI does not cheat. Every order every captain gives over a
 *      multi-year soak is audited the moment it is decided (the world's onAi
 *      hook): it names only the captain's own armies, holdings, plots and
 *      letters, places it knows, and hostile armies it can see right then.
 *      Its memory of the map changes only where it can see. And the
 *      Perception it decides from -- and so its orders -- is unchanged when
 *      something it cannot see is changed (a control shows the same test does
 *      move when it CAN see the change).
 *   2. A multi-year AI-against-AI soak on several seeds: no NaN, no negative
 *      stock, no stuck army, the ledger balancing every day for every faction
 *      with a steward, the same hash on a second run and from a replay of the
 *      log (the AI's orders are regenerated, not logged).
 *   3. Three invasions -- the story's three waves -- each LOST when the
 *      Reach is left undefended (a holding taken without a battle) and
 *      REPELLED when it is garrisoned; and a thin garrison is met in a K5
 *      battle, not seized.
 *
 * Also: the captains' start, rumours and warning (watchtowers and scouts),
 * each defence tool (levy call, burn the fields, ambush, walls, yield and the
 * keep), holdings taken undefended, AI-against-AI contact by auto-resolve,
 * save v8 and the v7 migration.
 */

import {
  KingdomWorld, kingdomHash, saveToJson, loadFromJson, serialize, deserialize, replayLog, migrate, KINGDOM_SAVE_VERSION,
  TICKS_PER_DAY, DAYS_PER_YEAR, armyById, armyMen, armyVisible, standsIn, credit, netOf, raiseArmy, setPosture, updateSight,
  debit, perceive, decide, remember, aiFactions, seatOf, warningDays, levyMen, isBurned, buildBattleSpec, knowsHolding,
  isFrontier, holdingKnowledge, fortificationOf, hostile, threatOf, seizeUndefended,
  type Army, type Holding, type KingdomEvent, type KingdomOrderBody, type LedgerDay, type Perception,
} from "../src/sim/kingdom/index.ts";
import {
  FACTION_IDS, FACTIONS, STOCK_IDS, LEDGER_STOCK_IDS, AI, INVASION_WAVES, WAVE_DAYS, WARNING, LEVY_CALL, BURN_FIELDS,
  FIELD_HOSTS, SEAT_GARRISON, CAPTAIN_START, INVASION_REFUSAL, KNOW_SEEN, UNREST_MAX,
} from "../src/content/kingdom/index.ts";
import { UNIT_TYPES } from "../src/content/unit-types.ts";
import { fieldNerve } from "../src/app/battle-config.ts";
import { nerveFromMorale } from "../src/content/kingdom/descent.ts";

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

const SEED = 0x6b1d0008;
const KING = 0;
const HARE = FACTION_IDS.indexOf("hare");
const BOAR = FACTION_IDS.indexOf("boar");
const CROW = FACTION_IDS.indexOf("crow");
const COMMONS = FACTION_IDS.indexOf("commons");
const REACH = ["cold-hearth", "greyshaw", "thornwick", "rookstead", "fell-end"];

function realm(seed = SEED): KingdomWorld {
  return new KingdomWorld({ seed, hosts: true, captains: true });
}
/** Settle a contact of the king's side the way "Resolve for me" does, so a soak never waits on a human. */
function autoSettle(w: KingdomWorld): void {
  if (w.contact) w.issue({ kind: "resolveContact", contact: w.contact.id, choice: "auto", result: null });
}
/** Tick through the next day's first tick, settling any contact on the way. */
function nextDay(w: KingdomWorld, each?: (ev: KingdomEvent[]) => void): void {
  let guard = 0;
  do {
    autoSettle(w);
    const ev = w.tick();
    each?.(ev);
    if (++guard > 64) throw new Error("a day did not end: now " + w.now + " " + JSON.stringify(w.contact) + " " + (w.contact ? w.check({ kind: "resolveContact", contact: w.contact.id, choice: "auto", result: null }) : ""));
  } while (w.now % TICKS_PER_DAY !== 1);
}
function untilDay(w: KingdomWorld, day: number, each?: (ev: KingdomEvent[]) => void): void {
  while (w.date.day < day) nextDay(w, each);
}
/** Test setup through the ledger, so conservation still holds. */
function topUp(w: KingdomWorld, f: number, stocks: Partial<Record<(typeof STOCK_IDS)[number], number>>): void {
  for (const s of STOCK_IDS) {
    const want = stocks[s] ?? 0;
    const have = w.economy[f].stocks[s];
    if (want > have) credit(w.economy[f], w.books[f], s, want - have, "trade");
  }
}
function issue(w: KingdomWorld, body: KingdomOrderBody, player = KING): string | null {
  const why = w.check(body, player);
  if (why === null) w.issue(body, player);
  return why;
}

/**
 * The king holds the Reach (test setup: claimed by hand, people in the empty
 * keep), with bread and coin kept up each day through the ledger and his
 * towns kept calm, so the only thing under test is the invasion.
 */
function reach(w: KingdomWorld, garrison: readonly (readonly (keyof typeof UNIT_TYPES)[])[] = []): Holding[] {
  const hs = REACH.map((k) => w.holdingByKey(k) as Holding);
  for (const h of hs) {
    h.owner = "king";
    if (h.population < 40) h.population = 40;
  }
  hs.forEach((h, i) => {
    const units = garrison[i];
    if (!units || units.length === 0) return;
    const a = raiseArmy(w, KING, h.id, units as (keyof typeof UNIT_TYPES)[], "defensive");
    setPosture(w, a, "hold");
    h.garrison.push(a.id);
  });
  updateSight(w, KING);
  return hs;
}
function keepReach(w: KingdomWorld): void {
  topUp(w, KING, { grain: 600, coin: 400 });
  for (const h of w.holdings) if (h.owner === "king") h.unrest = 0;
}

// -- content ---------------------------------------------------------------------------------

section("content: the AI's table, the waves, the warning");
{
  check("every wave is a faction with a persona, in day order",
    INVASION_WAVES.every((v, i) => FACTIONS[v.faction].persona !== null && (i === 0 || INVASION_WAVES[i - 1].day < v.day)));
  check("no wave rides before the grace is out", INVASION_WAVES.every((v) => v.day >= AI.graceDays));
  check("the waves are three (the plan's '3 invasions')", INVASION_WAVES.length === 3);
  check("every field host and the seat garrison are real units",
    [...SEAT_GARRISON, ...Object.values(FIELD_HOSTS).flat()].every((u) => !!UNIT_TYPES[u as keyof typeof UNIT_TYPES]));
  check("warning grows with towers and scouts and is capped", WARNING.perTower > 0 && WARNING.perScout > 0 && WARNING.maxDays >= WARNING.baseDays);
  check("hysteresis keeps a goal (keepGoal > 1)", AI.keepGoal > 1);
  check("the commons have no steward and no AI", FACTIONS.commons.persona === null && !aiFactions().includes(COMMONS));
}

// -- the captains' start ------------------------------------------------------------------------

section("the captains' start: stores, seats, garrisons, hosts");
{
  const w = realm();
  const k7 = new KingdomWorld({ seed: SEED, hosts: true });
  check("ten AI factions: the usurper, the Margrave and the eight captains", aiFactions().length === 10);
  let ok = true;
  let why = "";
  for (const f of aiFactions()) {
    const seat = w.holding(seatOf(w, f));
    if (!seat) { ok = false; why = FACTION_IDS[f] + " has no seat"; break; }
    const g = seat.garrison.map((id) => armyById(w, id));
    if (g.length !== 1 || !g[0] || g[0].posture !== "hold") { ok = false; why = FACTION_IDS[f] + " seat garrison"; break; }
    if (!w.armies.some((a) => a.owner === f && !seat.garrison.includes(a.id))) { ok = false; why = FACTION_IDS[f] + " has no field host"; break; }
    if (STOCK_IDS.some((s) => w.economy[f].stocks[s] !== CAPTAIN_START[s])) { ok = false; why = FACTION_IDS[f] + " stores"; break; }
  }
  check("every AI faction has its seat, a garrison standing in it, a field host and its stores", ok, why);
  check("the Hare's field host is K5's opening riders", w.armies.some((a) => a.owner === HARE && a.squads.some((q) => q.unit === "scout")));
  check("a realm without captains has no captains' armies (K7's realm)", k7.armies.length === 1 && !k7.captains);
  check("and its hash does not mix K8's state", !k7.captains && kingdomHash(k7) === kingdomHash(new KingdomWorld({ seed: SEED, hosts: true })));
  check("each AI faction remembers the map's owners on day one, and has seen its own country",
    aiFactions().every((f) => w.intel[f].owner.length === w.holdings.length && w.intel[f].seen.some((d) => d === 0)));
}

// -- 1. the AI does not cheat ------------------------------------------------------------------

/**
 * Audit one faction's decision against the world as it stands when it is made.
 * Returns the first breach, or "".
 */
function audit(w: KingdomWorld, f: number, seen: Perception, orders: readonly KingdomOrderBody[]): string {
  const own = (id: number): boolean => armyById(w, id)?.owner === f;
  const ownHolding = (id: number): boolean => seen.holdings.some((h) => h.id === id) && w.holding(id)?.owner === FACTION_IDS[f];
  // The Perception itself: every hostile army in it is one the faction can see.
  for (const e of seen.enemies) {
    const a = armyById(w, e.id);
    if (!a || !armyVisible(w, f, a) || !hostile(a.owner, f)) return FACTION_IDS[f] + " perceives army " + e.id + " it cannot see";
    if (e.men !== armyMen(a)) return FACTION_IDS[f] + " perceives the wrong men for " + e.id;
  }
  for (const a of w.armies) {
    if (a.owner !== f && hostile(a.owner, f) && armyVisible(w, f, a) && !seen.enemies.some((e) => e.id === a.id)) {
      return FACTION_IDS[f] + " fails to perceive army " + a.id + " in plain sight";
    }
  }
  for (const o of orders) {
    const where = FACTION_IDS[f] + " " + o.kind;
    switch (o.kind) {
      case "marchArmy":
        if (!own(o.army)) return where + " names an army not its own";
        if (!knowsHolding(w, f, o.to) && !isFrontier(w, f, o.to)) return where + " to a holding it does not know";
        break;
      case "intercept": {
        if (!own(o.army)) return where + " names an army not its own";
        const t = armyById(w, o.target);
        if (!t || !armyVisible(w, f, t)) return where + " a quarry it cannot see";
        if (!seen.enemies.some((e) => e.id === o.target)) return where + " a quarry not in its Perception";
        break;
      }
      case "recruit":
        if (!ownHolding(o.at)) return where + " at a holding not its own";
        if (o.army !== 0 && !own(o.army)) return where + " into an army not its own";
        break;
      case "sow":
      case "harvest":
        if (!seen.holdings.some((h) => h.plots.some((p) => p.id === o.plot))) return where + " a plot not its own";
        break;
      case "garrison":
      case "disband":
        if (!own(o.army)) return where + " names an army not its own";
        break;
      case "resolveEvent":
        if (!seen.finds.some((x) => x.site === o.site)) return where + " a letter it has not got";
        break;
      default:
        return where + ": a kind the steward never gives";
    }
  }
  return "";
}

section("the AI does not cheat: every order audited as it is decided, over a three-year soak");
{
  for (const seed of [SEED, SEED + 1]) {
    const w = realm(seed);
    let breach = "";
    let decisions = 0;
    let orders = 0;
    let intercepts = 0;
    const kinds = new Set<string>();
    w.onAi = (f, seen, os) => {
      decisions++;
      orders += os.length;
      for (const o of os) { kinds.add(o.kind); if (o.kind === "intercept") intercepts++; }
      breach ||= audit(w, f, seen, os);
    };
    // Its memory changes only where it sees: snapshot every AI faction's intel each day.
    let memory = "";
    let before = aiFactions().map((f) => JSON.stringify(w.intel[f]));
    // Give the king a realm and an army out in the Reach, so there is something hostile to see and not see.
    reach(w, [[], ["line", "archer"]]);
    while (w.date.day < 360 && !breach) {
      if (w.date.day % 7 === 0) keepReach(w);
      nextDay(w);
      aiFactions().forEach((f, i) => {
        const now = w.intel[f];
        const was = JSON.parse(before[i]) as typeof now;
        for (let h = 0; h < now.owner.length; h++) {
          const changed = was.owner[h] !== now.owner[h] || was.men[h] !== now.men[h] || was.walls[h] !== now.walls[h];
          // Seen this morning, when it remembered (the day stamp is written only for a holding in sight).
          if (!changed || now.seen[h] === w.date.day) continue;
          // Unseen, only news of its own: the owner of a holding that is or was its own, and nothing else.
          const own = was.owner[h] === f || now.owner[h] === f;
          if (!own || was.men[h] !== now.men[h] || was.walls[h] !== now.walls[h]) memory ||= FACTION_IDS[f] + " learned of holding " + (h + 1) + " without seeing it";
        }
      });
      before = aiFactions().map((f) => JSON.stringify(w.intel[f]));
    }
    check("seed " + seed + ": every order names only its own, the known and the seen (" + orders + " orders in " + decisions + " decisions)",
      breach === "" && decisions > 3000 && orders > 100, breach);
    check("seed " + seed + ": its memory of the map changes only where it can see (unseen: only the owner of its own towns)", memory === "", memory);
    // ECON: a ripe field is reaped by itself, so the steward no longer orders the harvest.
    check("seed " + seed + ": the steward gives every kind of order it has (march, recruit, sow)",
      ["marchArmy", "recruit", "sow"].every((k) => kinds.has(k)), [...kinds].join(","));
  }
}

section("the AI does not cheat: what it cannot see does not change what it decides");
{
  const w = realm();
  reach(w);
  untilDay(w, 40);
  const json = saveToJson(w);
  const decideFor = (x: KingdomWorld, f: number): string => {
    remember(x, f);
    const p = perceive(x, f);
    const d = decide(p, x.minds[f], x.places(), x.rng.kingdomAi);
    return JSON.stringify({ p, d });
  };
  const fresh = (): KingdomWorld => {
    const l = loadFromJson(json);
    if (!l.ok) throw new Error(l.error);
    return l.value;
  };
  const harrow = w.holdingByKey("harrowfield") as Holding;
  const crowhaven = w.holdingByKey("crowhaven") as Holding;
  const cold = w.holdingByKey("cold-hearth") as Holding;
  check("the fixture: the Hare cannot see Cold Hearth or Crowhaven, and sees Harrowfield",
    holdingKnowledge(w, HARE, cold.id) !== KNOW_SEEN && holdingKnowledge(w, HARE, crowhaven.id) !== KNOW_SEEN &&
    holdingKnowledge(w, HARE, harrow.id) === KNOW_SEEN);
  const base = decideFor(fresh(), HARE);
  // Unseen: a host of the king's raised at Cold Hearth, Crowhaven's people and garrison, the Crow's stores, the king's coin.
  const x = fresh();
  raiseArmy(x, KING, cold.id, ["guard", "guard", "lancer"], "defensive");
  (x.holdingByKey("crowhaven") as Holding).population += 5000;
  for (const id of (x.holdingByKey("crowhaven") as Holding).garrison) (armyById(x, id) as Army).squads.forEach((q) => { q.men = 1; });
  credit(x.economy[CROW], x.books[CROW], "coin", 99999, "trade");
  credit(x.economy[KING], x.books[KING], "coin", 99999, "trade");
  check("changing what the Hare cannot see leaves its Perception and its orders exactly as they were", decideFor(x, HARE) === base);
  // Control: the same change where it CAN see.
  const y = fresh();
  raiseArmy(y, KING, harrow.id, ["guard", "guard", "lancer"], "defensive");
  check("control: the same host raised where the Hare can see it changes what it perceives", decideFor(y, HARE) !== base);
  // Ambush: a host lying in wait is not seen even where the ground is.
  const z = fresh();
  const linnet = z.holdingByKey("linnet-cross") as Holding;
  const hidden = raiseArmy(z, KING, linnet.id, ["line"], "defensive");
  setPosture(z, hidden, "ambush");
  check("the fixture: the Hare sees Linnet Cross", holdingKnowledge(z, HARE, linnet.id) === KNOW_SEEN);
  check("a host lying in wait at Linnet Cross is hidden from the Hare (its Perception unchanged)",
    !armyVisible(z, HARE, hidden) && JSON.stringify(perceive(z, HARE).enemies) === JSON.stringify(perceive(fresh(), HARE).enemies));
}

// -- 2. the soak -------------------------------------------------------------------------------

function soak(seed: number, years: number): { problem: string; hash: string; w: KingdomWorld; contacts: number; aiContacts: number; pages: number } {
  const w = realm(seed);
  let problem = "";
  let contacts = 0;
  let aiContacts = 0;
  let pages = 0;
  const lastClosed: (LedgerDay | null)[] = w.books.map(() => null);
  // Stuck (the game-ai skill's check, at the kingdom's scale): marching for 25 days without
  // reaching a single holding (an army that turns back and forth on a road, or does not move),
  // marching for 150 days without its route ever running out, or standing mid-road with nowhere
  // to go for 3.
  const progress = new Map<number, number>(); // army -> day it last reached a holding or set out
  const marching = new Map<number, number>();
  const idleRoad = new Map<number, number>();
  const finite = (n: number): boolean => typeof n === "number" && Number.isFinite(n);
  while (w.date.day < years * DAYS_PER_YEAR && !problem) {
    nextDay(w, (ev) => {
      for (const e of ev) {
        if (e.kind === "contact") { contacts++; if (!e.player) aiContacts++; }
        if (e.kind === "armyArrived" || e.kind === "armyDeparted") progress.set(e.army, w.date.day);
      }
    });
    // Ledger: every faction with a steward balances, every day.
    w.books.forEach((book, f) => {
      const c = book.closed;
      if (!c || c === lastClosed[f]) return;
      lastClosed[f] = c;
      pages++;
      LEDGER_STOCK_IDS.forEach((st, i) => {
        if (c.start[i] + netOf(c, st) !== book.open.start[i]) problem ||= FACTION_IDS[f] + " " + st + " does not balance on day " + c.day;
      });
    });
    w.economy.forEach((e, f) => {
      for (const s of STOCK_IDS) {
        if (!finite(e.stocks[s])) problem ||= FACTION_IDS[f] + " " + s + " is not a number";
        if (e.stocks[s] < 0) problem ||= FACTION_IDS[f] + " " + s + " below zero";
      }
      if (!finite(e.legitimacy) || e.legitimacy < 0 || e.legitimacy > 100) problem ||= FACTION_IDS[f] + " legitimacy " + e.legitimacy;
    });
    for (const h of w.holdings) {
      if (!finite(h.population) || h.population < 0) problem ||= h.key + " population " + h.population;
      if (!finite(h.unrest) || h.unrest < 0 || h.unrest > UNREST_MAX) problem ||= h.key + " unrest " + h.unrest;
    }
    for (const a of w.armies) {
      const m = a.mover;
      if (![a.supply, a.morale, a.hunger, m.along].every(finite) || a.supply < 0 || a.morale < 0 || a.morale > 100) problem ||= "army " + a.id + " has a bad number";
      for (const q of a.squads) if (!finite(q.men) || q.men < 0 || q.wounded < 0 || q.wounded > q.men) problem ||= "army " + a.id + " squad " + q.id + " men";
      if (armyMen(a) === 0) problem ||= "army " + a.id + " is on the map with no one in it";
      const going = m.route.length > 0 || a.target !== 0;
      if (!going || !progress.has(a.id)) progress.set(a.id, w.date.day);
      if (going) marching.set(a.id, (marching.get(a.id) ?? 0) + 1); else marching.delete(a.id);
      if (m.road !== 0 && !going) idleRoad.set(a.id, (idleRoad.get(a.id) ?? 0) + 1); else idleRoad.delete(a.id);
      const who = FACTION_IDS[a.owner] + " army " + a.id;
      if (w.date.day - (progress.get(a.id) as number) > 25) problem ||= who + " has marched 25 days without reaching a holding (road " + m.road + ")";
      if ((marching.get(a.id) ?? 0) > 150) problem ||= who + " has marched for 150 days and never arrived";
      if ((idleRoad.get(a.id) ?? 0) > 3) problem ||= who + " stands mid-road with nowhere to go";
    }
  }
  return { problem, hash: kingdomHash(w), w, contacts, aiContacts, pages };
}

section("multi-year AI-against-AI soak: no NaN, no negative stocks, no stuck armies, the ledger balances");
{
  // ECON: three twelve-month years (1080 days, every wave's day passed); was five four-month ones.
  const YEARS = 3;
  for (const seed of [SEED, SEED + 7, SEED + 13]) {
    const r = soak(seed, YEARS);
    check("seed " + seed + ": " + YEARS + " years, every invariant holds (" + r.pages + " ledger pages, " + r.contacts + " contacts, " + r.aiContacts + " between machines)",
      r.problem === "" && r.pages > YEARS * DAYS_PER_YEAR * 10, r.problem);
    if (seed === SEED) {
      const again = soak(seed, YEARS);
      check("the same seed soaks to the same hash", again.hash === r.hash, r.hash + " vs " + again.hash);
      const replay = replayLog(seed, r.w.log, r.w.now, { hosts: true, captains: true });
      check("a replay of the log regenerates every AI order and reaches the same hash", kingdomHash(replay) === r.hash);
      check("the AI's orders are not in the log (regenerated, seq 0 never logged)", r.w.log.every((o) => o.seq !== 0));
      check("every wave rode", r.w.wavesRode.every((x) => x));
      const armies = aiFactions().map((f) => r.w.armies.filter((a) => a.owner === f).length);
      check("the captains still keep armies after " + YEARS + " years (no faction stood itself down for good)", armies.filter((n) => n > 0).length >= 8, armies.join(","));
    }
  }
}

section("AI against AI: a captain's town in revolt, and the auto-resolve settles it on the spot");
{
  // The commons are hostile to the crown alone: a rising in a captain's town is a machine-against-machine war.
  check("the commons are the crown's enemies and not the king's", hostile(COMMONS, BOAR) && !hostile(COMMONS, KING));
  const w = realm();
  untilDay(w, 2);
  const ash = w.holdingByKey("ashgrove") as Holding; // the Boar's village, near his seat
  ash.unrest = UNREST_MAX;
  let rose = false;
  let met = 0;
  let settled = "";
  let held = false;
  untilDay(w, 80, (ev) => {
    for (const e of ev) {
      if (e.kind === "revolt" && e.holding === ash.id) rose = e.army !== 0;
      if (e.kind === "contact" && !e.player) met++;
      if (e.kind === "contactResolved" && met > 0 && !settled) settled = e.how;
    }
    if (w.contact) held = true;
  });
  check("the town rose for the commons", rose && w.armies.some((a) => a.owner === COMMONS) || ash.owner === "boar", String(ash.owner));
  check("the Boar came to put it down and the meeting was resolved on the spot", met > 0 && settled === "auto", met + " " + settled);
  check("and the realm never held for it (no contact of the king's side)", !held);
}

// -- 3. three invasions, lost and repelled ------------------------------------------------------

type Outcome = { lost: string[]; rumour: number; rode: boolean; battles: number; ended: boolean };

/** One wave alone (the others marked ridden), against the Reach as set up; until it is over. */
function invasion(wave: number, garrison: readonly (readonly (keyof typeof UNIT_TYPES)[])[], seed = SEED): Outcome {
  const w = realm(seed);
  INVASION_WAVES.forEach((_, j) => { if (j !== wave) w.wavesRode[j] = true; });
  const hs = reach(w, garrison);
  const f = FACTION_IDS.indexOf(INVASION_WAVES[wave].faction);
  const out: Outcome = { lost: [], rumour: -1, rode: false, battles: 0, ended: false };
  const end = INVASION_WAVES[wave].day + WAVE_DAYS + 15;
  while (w.date.day < end) {
    keepReach(w);
    nextDay(w, (ev) => {
      for (const e of ev) {
        if (e.kind === "waveRode" && e.faction === f) out.rode = true;
        if (e.kind === "rumour" && e.owner === f && out.rumour < 0) out.rumour = e.days;
        if (e.kind === "contact" && e.player) out.battles++;
        if ((e.kind === "seized" || e.kind === "claimed") && e.faction === f && hs.some((h) => h.id === e.holding)) {
          const key = (w.holding(e.holding) as Holding).key;
          if (!out.lost.includes(key)) out.lost.push(key);
        }
      }
    });
  }
  out.ended = w.minds[f].wave === -1;
  return out;
}

section("three invasions: each LOST undefended, each REPELLED garrisoned");
{
  const GARRISON: (keyof typeof UNIT_TYPES)[] = ["line", "line", "archer", "archer"];
  INVASION_WAVES.forEach((v, i) => {
    const lost = invasion(i, []);
    check("wave " + (i + 1) + " (the " + v.faction + ", day " + v.day + ") rides, and the king hears of it before it arrives",
      lost.rode && lost.rumour > 0, "rumour " + lost.rumour);
    check("undefended, the Reach is LOST: " + (lost.lost.join(", ") || "nothing taken") + ", without a battle",
      lost.lost.length > 0 && lost.battles === 0);
    const held = invasion(i, REACH.map(() => GARRISON));
    check("garrisoned, it is REPELLED: nothing taken, and the wave is over", held.rode && held.lost.length === 0 && held.ended,
      held.lost.join(",") + " ended " + held.ended);
  });
  // A thin garrison invites the attack (AI.thinGarrisonMen): it is met in a K5 battle, never seized.
  const thin = invasion(0, [[], [], [], ["line"], []]);
  check("a thin garrison is attacked through K5's descent (a battle), not taken without one",
    thin.battles > 0, "battles " + thin.battles + " lost " + thin.lost.join(","));
}

// -- rumours and warning ------------------------------------------------------------------------

section("rumours: warning is proportional to watchtowers and scouts");
{
  const w = realm();
  const hs = reach(w);
  const rook = hs[3];
  const base = warningDays(w, rook.id);
  check("with no tower and no scout the warning is the base", base === WARNING.baseDays);
  const grey = hs[1];
  const slot = grey.buildings.indexOf(null);
  grey.buildings[slot] = "watchtower";
  grey.works[slot] = 0;
  const tower = warningDays(w, rook.id);
  check("a watchtower near it adds its days", tower === base + WARNING.perTower, base + " -> " + tower);
  raiseArmy(w, KING, rook.id, ["scout", "scout"], "defensive");
  const scouts = warningDays(w, rook.id);
  check("scouts near it add theirs", scouts === tower + 2 * WARNING.perScout, tower + " -> " + scouts);
  for (let i = 0; i < 6; i++) raiseArmy(w, KING, rook.id, ["scout", "scout"], "defensive");
  check("and it is capped", warningDays(w, rook.id) <= WARNING.maxDays);
  // The rule, checked on the wave itself every day: a host riding at one of the king's holdings
  // is heard of as soon as it is in his sight or within his warning, and not before.
  const heard = (towers: boolean): { first: number; breach: string } => {
    const x = realm();
    INVASION_WAVES.forEach((_, j) => { if (j !== 0) x.wavesRode[j] = true; });
    const xs = reach(x);
    if (towers) for (const h of xs) { const s = h.buildings.indexOf(null); if (s >= 0) { h.buildings[s] = "watchtower"; h.works[s] = 0; } }
    let first = -1;
    let breach = "";
    const overdue: number[] = [];
    while (x.date.day < INVASION_WAVES[0].day + 50) {
      keepReach(x);
      nextDay(x, (ev) => {
        for (const e of ev) {
          if (e.kind !== "rumour") continue;
          const a = armyById(x, e.army) as Army;
          if (!armyVisible(x, KING, a) && e.days > warningDays(x, e.target)) breach ||= "heard of " + e.days + " days out, unseen, with " + warningDays(x, e.target) + " days' warning";
          if (first < 0) first = e.days;
        }
      });
      // Rumours are reckoned once a day, each morning: what fell due during yesterday is heard today.
      for (const id of overdue) {
        const a = armyById(x, id);
        if (a && threatOf(x, a) && !x.rumours.some((r) => r.army === id)) breach ||= "army " + id + " rides at the king unheard of";
      }
      overdue.length = 0;
      for (const a of x.armies) {
        const t = threatOf(x, a);
        if (!t) continue;
        const due = armyVisible(x, KING, a) || t.days <= warningDays(x, t.target);
        if (due && !x.rumours.some((r) => r.army === a.id)) overdue.push(a.id);
      }
    }
    return { first, breach };
  };
  const plain = heard(false);
  const towered = heard(true);
  check("a host is heard of the day it comes into sight or within warning, never before (" + plain.first + " days out)", plain.first > 0 && plain.breach === "", plain.breach);
  check("with watchtowers it is heard of at least as far out (" + plain.first + " -> " + towered.first + " days)", towered.first >= plain.first && towered.breach === "", towered.breach);
}

// -- the defence tools --------------------------------------------------------------------------

section("defence: the levy call");
{
  const w = realm();
  const [, grey] = reach(w);
  grey.population = 200;
  untilDay(w, 2);
  const men = levyMen(grey);
  const armies = w.armies.length;
  const pop = grey.population;
  const unrest = grey.unrest;
  check("refused at a holding not his", issue(w, { kind: "callLevy", holding: (w.holdingByKey("harrowfield") as Holding).id }) === INVASION_REFUSAL.notYours);
  check("answered at his own", issue(w, { kind: "callLevy", holding: grey.id }) === null);
  nextDay(w);
  const a = w.armies.find((x) => x.owner === KING && standsIn(x.mover) === grey.id);
  check("raises " + men + " men at once, as levy squads, raw (morale " + LEVY_CALL.morale + "), garrisoned",
    w.armies.length === armies + 1 && !!a && armyMen(a) === men && a.squads.every((q) => q.levy) && a.morale <= LEVY_CALL.morale + 1 && (grey.garrisonSlots === 0 || grey.garrison.includes(a.id)),
    a ? armyMen(a) + " men, morale " + a.morale + ", slots " + grey.garrisonSlots + " garrison " + grey.garrison.join("/") + " armies " + armies + "->" + w.armies.length : "none");
  check("out of the town's people, and the town does not like it", grey.population <= pop - men && grey.unrest > unrest, pop + "->" + grey.population + ", " + unrest + "->" + grey.unrest);
  check("refused again until the cooldown is out", issue(w, { kind: "callLevy", holding: grey.id }) === INVASION_REFUSAL.calledLately(LEVY_CALL.cooldownDays - 1));
  const cold = w.holdingByKey("cold-hearth") as Holding;
  cold.population = 10;
  check("refused where too few are left", issue(w, { kind: "callLevy", holding: cold.id }) === INVASION_REFUSAL.tooFew);
}

section("defence: burn the fields");
{
  const w = realm();
  const [, grey] = reach(w);
  untilDay(w, 2);
  for (const p of grey.plots) { p.stage = "growing"; p.crop = "rye"; }
  const unrest = grey.unrest;
  check("answered", issue(w, { kind: "burnFields", holding: grey.id }) === null);
  nextDay(w);
  check("every crop in the ground there is lost", grey.plots.every((p) => p.stage === "spoiled"));
  check("the people's own bread burned: unrest", grey.unrest >= unrest + BURN_FIELDS.unrest - 10);
  check("burned land is marked", isBurned(w, grey.id));
  check("refused while it is burned", issue(w, { kind: "burnFields", holding: grey.id }) === INVASION_REFUSAL.burning);
  // An army standing there gets nothing from the land: the supply it is denied. (The king's own,
  // with his stores emptied, so nothing but the land could feed it.)
  const camp = raiseArmy(w, KING, grey.id, ["line"], "defensive");
  camp.supply = 0;
  const g = w.economy[KING].stocks.grain;
  if (g > 0) debit(w.economy[KING], w.books[KING], "grain", g, "offerings");
  const before = grey.foraged;
  nextDay(w);
  check("an army standing there cannot forage it (it goes hungry)", grey.foraged === before && camp.hunger > 0, grey.foraged + " " + camp.hunger);
  untilDay(w, w.date.day + BURN_FIELDS.days + 1);
  check("after " + BURN_FIELDS.days + " days the land feeds armies again", !isBurned(w, grey.id));
}

/**
 * A realm with the captains' start but their minds switched off (`captains`
 * false from here on), so a test can march a captain's army by hand without
 * its steward calling it home; the defence tools do not depend on the flag.
 */
function quiet(seed = SEED): KingdomWorld {
  const w = realm(seed);
  w.captains = false;
  return w;
}

section("defence: ambush, walls, and the defender's choices at its walls");
{
  const w = quiet();
  const hs = reach(w);
  untilDay(w, 2);
  const grey = hs[1];
  const a = raiseArmy(w, KING, grey.id, ["line", "archer"], "defensive");
  check("refused while marching", (() => { a.mover.route = [hs[0].id]; const r = w.check({ kind: "ambush", army: a.id }, KING); a.mover.route = []; return r === INVASION_REFUSAL.ambushMarching; })());
  check("laid where it stands", issue(w, { kind: "ambush", army: a.id }) === null);
  nextDay(w);
  check("it lies in wait, hidden from the Hare", a.posture === "ambush" && !armyVisible(w, HARE, a));
  // A hare host walks into it: the battle starts with the attacker shaken.
  const raid = raiseArmy(w, HARE, (w.holdingByKey("moot-hill") as Holding).id, ["line", "line"], "defensive");
  w.issue({ kind: "marchArmy", army: raid.id, to: grey.id }, HARE);
  let c = w.contact;
  for (let i = 0; i < 40 * TICKS_PER_DAY && !c; i++) { w.tick(); c = w.contact; }
  check("the march ends in a contact at the ambush", !!c && c.holding === grey.id);
  if (c) {
    const spec = buildBattleSpec(w, c);
    const n = fieldNerve(spec);
    const att = spec.deployment.attacker;
    check("the battle spec carries the ambush (deployment advantage)", spec.deployment.ambush && spec.sides[1 - att].faction === KING);
    check("and the attacker starts shaken", n[att] < nerveFromMorale(spec.sides[att].morale));
    w.issue({ kind: "resolveContact", contact: c.id, choice: "auto", result: null });
    w.tick();
  }
  // Walls: a defender behind its own palisade starts steadier.
  const plain = { ...{ terrain: { fortification: "none" }, deployment: { attacker: 0, ambush: false }, sides: [{ morale: 50 }, { morale: 50 }] } } as unknown as Parameters<typeof fieldNerve>[0];
  const walled = { ...plain, terrain: { fortification: "palisade" } } as unknown as Parameters<typeof fieldNerve>[0];
  check("walls are a battle effect: the defender behind a palisade starts steadier", fieldNerve(walled)[1] > fieldNerve(plain)[1] && fieldNerve(walled)[0] === fieldNerve(plain)[0]);

  // Townsmen alone behind walls: open the gates, or fall back to the keep.
  for (const choice of ["yield", "keep"] as const) {
    const x = quiet();
    const xs = reach(x);
    untilDay(x, 2);
    const town = xs[1];
    const s = town.buildings.indexOf(null);
    // K10: the keep needs stone (a wall stands over the palisade, in its slot).
    town.buildings[s] = choice === "keep" ? "wall" : "palisade";
    town.works[s] = 0;
    town.population = 200;
    const host = raiseArmy(x, HARE, (x.holdingByKey("moot-hill") as Holding).id, ["line", "line", "line"], "defensive");
    x.issue({ kind: "marchArmy", army: host.id, to: town.id }, HARE);
    let cc = x.contact;
    for (let i = 0; i < 40 * TICKS_PER_DAY && !cc; i++) { x.tick(); cc = x.contact; }
    check(choice + ": the host comes to the walls (an assault)", !!cc && cc.kind === "assault", fortificationOf(town));
    if (!cc) continue;
    const why = x.check({ kind: "resolveContact", contact: cc.id, choice, result: null }, KING);
    if (choice === "keep" && fortificationOf(town) === "palisade") {
      check("keep: refused behind a mere palisade", why === INVASION_REFUSAL.noKeep(town.name));
      continue;
    }
    check(choice + ": the choice is open to townsmen behind their walls", why === null, String(why));
    const leg = x.economy[KING].legitimacy;
    const ev: KingdomEvent[] = [];
    x.issue({ kind: "resolveContact", contact: cc.id, choice, result: null });
    ev.push(...x.tick());
    if (choice === "yield") {
      check("yield: the gates open, the town is the Hare's, nobody dies, legitimacy falls",
        town.owner === "hare" && ev.some((e) => e.kind === "yielded") && x.economy[KING].legitimacy < leg && armyMen(host) === 3 * UNIT_TYPES.line.soldiers);
    } else {
      // K10: going into the keep settles nothing -- the siege of the keep is a battle still to be fought.
      check("keep: the town outside is sacked and the townsmen hold the keep, the siege still to fight",
        ev.some((e) => e.kind === "keepRetreat") && !!x.contact && x.contact.keep === true && !ev.some((e) => e.kind === "siege") &&
          town.plots.every((p) => p.stage !== "growing"));
      const kspec = buildBattleSpec(x, x.contact!);
      check("keep: its battle is a siege of the keep", kspec.terrain.fortification === "keep" && kspec.victory.mode === "breakthrough");
      check("keep: there is no second keep to fall back to",
        x.check({ kind: "resolveContact", contact: cc.id, choice: "keep", result: null }, KING) === INVASION_REFUSAL.inKeep(town.name));
      x.issue({ kind: "resolveContact", contact: cc.id, choice: "auto", result: null });
      const ev2 = x.tick();
      const siege = ev2.find((e) => e.kind === "siege");
      check("keep: resolved, the siege of the keep is told and the walls carry its damage",
        !!siege && !x.contact && ev2.some((e) => e.kind === "wallsDamaged") && town.walls > 0, JSON.stringify(siege) + " walls " + town.walls);
    }
  }
}

section("taken without a battle: an empty holding falls to whoever stands in it");
{
  // The rule itself (the tick runs it in a realm with captains; the invasions above show it there).
  const w = quiet();
  const hs = reach(w);
  untilDay(w, 2);
  const thorn = hs[2];
  const raid = raiseArmy(w, HARE, thorn.id, ["scout"], "defensive");
  const ev = w.tick();
  check("nothing is taken by the tick while the captains do not run (a K7 realm keeps its rules)", thorn.owner === "king" && !ev.some((e) => e.kind === "seized"));
  w.events = [];
  seizeUndefended(w);
  check("an ungarrisoned, unwalled holding of the king's is the Hare's when its riders stand in it, with no battle",
    thorn.owner === "hare" && w.events.some((e) => e.kind === "seized" && e.holding === thorn.id) && !w.contact);
  // ...and the king takes it back the same way, once the riders have gone.
  raid.mover.node = (w.holdingByKey("harrowfield") as Holding).id;
  raiseArmy(w, KING, thorn.id, ["line"], "defensive");
  seizeUndefended(w);
  check("and the king takes it back the same way once it stands empty", thorn.owner === "king", String(thorn.owner));
  // Not while its lord's army stands in it, nor behind walls, nor with a garrison.
  const grey = hs[1];
  raiseArmy(w, KING, grey.id, ["line"], "defensive");
  raiseArmy(w, HARE, grey.id, ["scout"], "defensive");
  seizeUndefended(w);
  check("not while an army of its lord's stands in it (that is a contact)", grey.owner === "king");
  const fell = hs[4];
  const s = fell.buildings.indexOf(null);
  fell.buildings[s] = "palisade";
  fell.works[s] = 0;
  raiseArmy(w, HARE, fell.id, ["scout"], "defensive");
  seizeUndefended(w);
  check("not behind walls (walls are assaulted, through K5)", fell.owner === "king" && fortificationOf(fell) === "palisade");
}

// -- save v8 ------------------------------------------------------------------------------------

section("save v8: the captains round-trip, v7 migrates, tampering is refused");
{
  check("the current version is at least 8", KINGDOM_SAVE_VERSION >= 8);
  const w = realm();
  reach(w, [["line"]]);
  untilDay(w, INVASION_WAVES[0].day + 10);
  check("the fixture has minds, memories, a wave ridden and armies abroad", w.wavesRode[0] && aiFactions().some((f) => w.minds[f].goal !== "consolidate" || w.minds[f].since > 0));
  const json = saveToJson(w);
  const l = loadFromJson(json);
  check("a realm with captains round-trips to the same hash", l.ok && kingdomHash(l.value) === kingdomHash(w), l.ok ? "" : l.error);
  if (l.ok) {
    const a = l.value;
    untilDay(w, INVASION_WAVES[0].day + 80);
    untilDay(a, INVASION_WAVES[0].day + 80);
    check("and plays on from the load exactly as without it (the AI picks up its own mind)", kingdomHash(a) === kingdomHash(w));
  }
  // A K7 save (no captains): strip K8's fields and the commons' entries.
  const old = new KingdomWorld({ seed: SEED, hosts: true });
  untilDay(old, 30);
  const v7 = JSON.parse(JSON.stringify(serialize(old)));
  v7.version = 7;
  delete v7.captains;
  delete v7.snapshot.k8;
  v7.snapshot.economy = v7.snapshot.economy.slice(0, COMMONS);
  v7.snapshot.explore = v7.snapshot.explore.slice(0, COMMONS);
  const m = migrate(JSON.parse(JSON.stringify(v7)));
  check("a version-7 save migrates to 8 and on to " + KINGDOM_SAVE_VERSION, m.ok && m.value.version === KINGDOM_SAVE_VERSION, m.ok ? "" : m.error);
  const lv = deserialize(v7);
  check("and loads with no captains, no minds, no rumours", lv.ok && !lv.value.captains && lv.value.rumours.length === 0, lv.ok ? "" : lv.error);
  if (lv.ok) {
    check("to the same hash as the realm it was saved from", kingdomHash(lv.value) === kingdomHash(old));
    untilDay(old, 60);
    untilDay(lv.value, 60);
    check("and plays on the same", kingdomHash(lv.value) === kingdomHash(old));
  }
  const bad = (edit: (s: ReturnType<typeof serialize>) => void): boolean => {
    const s = JSON.parse(json);
    edit(s);
    return !deserialize(s).ok;
  };
  check("a mind with an unknown goal is refused", bad((s) => { (s.snapshot.k8.minds[HARE] as { goal: string }).goal = "conquer"; }));
  check("a lord riding with an army not his is refused", bad((s) => { s.snapshot.k8.minds[HARE].rides = 1; }));
  check("a memory that does not match the map is refused", bad((s) => { s.snapshot.k8.intel[HARE].owner.pop(); }));
  check("a rumour of an army not on the map is refused", bad((s) => { s.snapshot.k8.rumours.push({ army: 99999, target: 1, from: 1, days: 2, day: 1 }); }));
  check("an ambush posture round-trips", (() => {
    const x = realm();
    const a = raiseArmy(x, KING, 1, ["line"], "defensive");
    setPosture(x, a, "ambush");
    const r = loadFromJson(saveToJson(x));
    return r.ok && armyById(r.value, a.id)?.posture === "ambush" && kingdomHash(r.value) === kingdomHash(x);
  })());
}

console.log("\n" + (failures === 0 ? "all " + checks + " AI and invasion checks passed" : failures + " of " + checks + " AI and invasion checks FAILED"));
if (failures > 0) process.exit(1);
