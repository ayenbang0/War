/**
 * Headless checks for K3a: twice the map, exploration and the kingdom fog,
 * events and special upgrades (PLAN.md §B.2, §B.11a; docs/kingdom.md "K3a").
 *
 * Part of `npm test`. Holds the phase to what it claims:
 *
 *   - content: 72 holdings on one connected, uncrossed road graph; at least
 *     24 events of two or three choices and 12 upgrades, every effect valid,
 *     every site kind with an event for each of its sites; no story string
 *     guesses anyone's gender; and the validators are not dead;
 *   - the fog: unknown places are hidden at the start and cannot be marched
 *     to but by a known road; sight is the function of its sources; knowledge
 *     is deterministic and monotone (nothing known is ever forgotten);
 *   - sites: the party halts at a site the first time, its event fires
 *     exactly once, and is drawn on the events stream and nowhere else;
 *   - resolving: the effect of every choice of every event lands through the
 *     ledger, refusals are the card's, and a run with letters answered by
 *     order replays identically from its log and across a save;
 *   - conservation holds every day of a run full of finds;
 *   - upgrades bend the economy they name;
 *   - the v2 -> v3 migration of a real K3 save (tools/fixtures/kingdom-save-v2.json);
 *   - ten years of an exploring king: deterministic, replayable, monotone,
 *     balanced.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Rng, Stream } from "../src/sim/rng.ts";
import {
  KingdomWorld, kingdomHash, loadFromJson, saveToJson, replayLog, mapFingerprint, deserialize, migrate, MIGRATIONS,
  TICKS_PER_DAY, TICKS_PER_YEAR, KINGDOM_SAVE_VERSION, K3_MAP,
  applySight, sightSources, updateSight, targetRefusal, isFrontier, knowsHolding, knowsRoad, findAt, pendingFinds,
  checkResolve, applyResolve, discover, choiceCost, routeOptions, roadCostFor, storageOf, flowOf, netOf, findRoute, credit,
  type KingdomEvent, type KingdomOrderBody, type LedgerDay,
} from "../src/sim/kingdom/index.ts";
import {
  RIMAROS, KNOW_KNOWN, KNOW_SEEN, KNOW_UNKNOWN, RETINUE_SIGHT_MILES, SITE_KINDS, CAMPAIGN_HOLDINGS,
  LEDGER_STOCK_IDS, STOCK_IDS, validateKingdomMap, type KingdomMapDef,
} from "../src/content/kingdom/index.ts";
import {
  STORY_EVENTS, UPGRADES, UPGRADE_IDS, MIN_EVENTS, MIN_UPGRADES, X, EXPLORE_REFUSAL, SITE_NAME,
  validateEvents, validateUpgrades, validateSites, type StoryEventDef,
} from "../src/content/story/index.ts";
import { KingdomCamera } from "../src/render/kingdom/camera.ts";
import { interpretStroke, kingdomContext } from "../src/input/kingdom-commander.ts";

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

function runTicks(w: KingdomWorld, n: number, each?: (ev: KingdomEvent[]) => void): void {
  for (let i = 0; i < n; i++) {
    const ev = w.tick();
    each?.(ev);
  }
}
/** Tick until an event matches or the budget runs out. */
function runUntil(w: KingdomWorld, pred: (e: KingdomEvent) => boolean, budget = 4000): KingdomEvent | null {
  for (let i = 0; i < budget; i++) {
    for (const e of w.tick()) if (pred(e)) return e;
  }
  return null;
}
const id = (w: KingdomWorld, key: string): number => w.holdingByKey(key)!.id;
const siteOf = (w: KingdomWorld, hid: number) => w.map.holdings[hid - w.holdings[0].id].site;
const eventIndex = (eid: string): number => STORY_EVENTS.findIndex((e) => e.id === eid);
/** Test setup: hand the king some stores, through the ledger (as a find), so it still balances. */
function give(w: KingdomWorld, gains: Partial<Record<(typeof STOCK_IDS)[number], number>>): void {
  for (const s of STOCK_IDS) credit(w.economy[KING], w.books[KING], s, gains[s] ?? 0, "finds");
}

/** Plant a letter at a site, as if found today (test setup for one event). */
function plant(w: KingdomWorld, siteKey: string, eventId: string): number {
  const hid = id(w, siteKey);
  w.explore[KING].holdings[hid - 1] = KNOW_SEEN;
  w.explore[KING].finds.push({ site: hid, event: eventIndex(eventId), day: w.date.day, choice: -1, failed: false });
  return hid;
}

/** Every closed ledger page balances: start + net = the next page's start, every stock. */
function balanced(d: LedgerDay | null, next: LedgerDay): string {
  if (!d) return "";
  for (let i = 0; i < LEDGER_STOCK_IDS.length; i++) {
    const s = LEDGER_STOCK_IDS[i];
    if (d.start[i] + netOf(d, s) !== next.start[i]) return "day " + d.day + " " + s + ": " + d.start[i] + " + " + netOf(d, s) + " != " + next.start[i];
  }
  return "";
}

const knowledgeOf = (w: KingdomWorld): string => w.explore.map((e) => e.holdings.join("") + "|" + e.roads.join("")).join("/");

// -- 1. content ----------------------------------------------------------------

section("content");
{
  check("the campaign map validates (spacing, no crossings, sites, startKnown)", validateKingdomMap(RIMAROS).length === 0,
    validateKingdomMap(RIMAROS).slice(0, 3).join("; "));
  check("72 holdings", RIMAROS.holdings.length === 72 && CAMPAIGN_HOLDINGS === 72);
  check("the first 36 are K1's, in K1's order (ids stable)", RIMAROS.holdings[0].key === "cold-hearth" &&
    RIMAROS.holdings[35].key === "wrackhythe" && RIMAROS.holdings.slice(0, 36).every((h) => h.site === undefined));
  // An independent connectivity check, by breadth-first search over the content.
  const adj = new Map<string, string[]>(RIMAROS.holdings.map((h) => [h.key, []]));
  for (const [a, b] of RIMAROS.roads) { adj.get(a)!.push(b); adj.get(b)!.push(a); }
  const seen = new Set([RIMAROS.start]);
  const queue = [RIMAROS.start];
  while (queue.length) for (const n of adj.get(queue.shift()!)!) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  check("one connected road graph", seen.size === RIMAROS.holdings.length, seen.size + " reached");
  const sites = RIMAROS.holdings.filter((h) => h.site !== undefined);
  check("exploration sites of every kind", SITE_KINDS.every((k) => sites.some((h) => h.site === k)), sites.length + " sites");
  check("every site lies in new country (beyond the first 36)", sites.every((h) => RIMAROS.holdings.indexOf(h) >= 36));
  check("the king does not know the new country at the start",
    RIMAROS.startKnown.every((k) => RIMAROS.holdings.findIndex((h) => h.key === k) < 36));

  check("the event table validates", validateEvents().length === 0, validateEvents().slice(0, 3).join("; "));
  check("the upgrade table validates", validateUpgrades().length === 0, validateUpgrades().slice(0, 3).join("; "));
  check("each site kind has an event for every site of it", validateSites(RIMAROS).length === 0, validateSites(RIMAROS).join("; "));
  check("at least " + MIN_EVENTS + " events", STORY_EVENTS.length >= MIN_EVENTS, String(STORY_EVENTS.length));
  check("every event has two or three choices", STORY_EVENTS.every((e) => e.choices.length >= 2 && e.choices.length <= 3));
  check("at least " + MIN_UPGRADES + " special upgrades", UPGRADE_IDS.length >= MIN_UPGRADES, String(UPGRADE_IDS.length));
  check("every upgrade is found somewhere", UPGRADE_IDS.every((u) => STORY_EVENTS.some((e) =>
    e.choices.some((c) => c.effects.some((f) => f.kind === "upgrade" && f.upgrade === u)))));
  check("every event offers a choice that costs nothing", STORY_EVENTS.every((e) =>
    e.choices.some((c) => Object.keys(choiceCost(c.effects)).length === 0)));

  // The validators are not dead.
  type Mutable = { id: string; choices: { effects: unknown[] }[] }[];
  const bad = (edit: (e: Mutable) => void): number => {
    const t = JSON.parse(JSON.stringify(STORY_EVENTS)) as Mutable;
    edit(t);
    return validateEvents(t as unknown as StoryEventDef[]).length;
  };
  check("validator catches a one-choice event", bad((t) => { t[0].choices.length = 1; }) > 0);
  check("validator catches a duplicate id", bad((t) => { t.push(t[0]); }) > 0);
  check("validator catches an unknown upgrade", bad((t) => {
    t[0].choices[0].effects[0] = { kind: "upgrade", upgrade: "philosophers-stone" };
  }) > 0);
  check("validator catches a gain of an unknown stock", bad((t) => {
    t[0].choices[1].effects[0] = { kind: "gain", gains: { gold: 5 } };
  }) > 0);
  check("validator catches a loss outside a gamble", bad((t) => {
    t[0].choices[1].effects.push({ kind: "lose", loss: { grain: 5 } });
  }) > 0);
  check("validator catches an event where every choice costs", bad((t) => {
    for (const c of t[0].choices) c.effects.push({ kind: "pay", cost: { coin: 1 } });
  }) > 0);
  const fewer = JSON.parse(JSON.stringify(RIMAROS)) as KingdomMapDef & { holdings: { site?: string }[] };
  for (const h of fewer.holdings) if (h.site === "forest") h.site = "mine";
  check("site validator catches more sites of a kind than events for it", validateSites(fewer).length > 0);

  // No story string guesses anyone's gender (the house rule).
  const words: string[] = [];
  for (const e of STORY_EVENTS) {
    words.push(e.title, e.text);
    for (const c of e.choices) { words.push(c.label, c.result); if (c.chance) words.push(c.chance.fail.result); }
  }
  for (const u of UPGRADE_IDS) words.push(UPGRADES[u].name, UPGRADES[u].about);
  for (const v of Object.values(X)) if (typeof v === "string") words.push(v);
  words.push(...Object.values(EXPLORE_REFUSAL), ...Object.values(SITE_NAME));
  const gendered = /\b(he|she|him|her|hers|his|himself|herself|man|woman|monk|nun|lord|lady)\b/i;
  const hit = words.filter((s) => gendered.test(s));
  check("no story string guesses a gender", hit.length === 0, hit.slice(0, 2).join(" | "));
}

// -- 2. the fog ------------------------------------------------------------------

section("fog");
{
  const w = new KingdomWorld({ seed: SEED });
  const k = w.explore[KING];
  const unknown = w.holdings.filter((h) => !knowsHolding(w, KING, h.id));
  check("most of the realm is unknown at the start", unknown.length >= 40, unknown.length + " of " + w.holdings.length);
  check("the king knows where he stands, and sees it", k.holdings[w.king.mover.node - 1] === KNOW_SEEN);
  check("he knows what he was told of (startKnown)", RIMAROS.startKnown.every((key) => knowsHolding(w, KING, id(w, key))));
  check("every site is unknown at the start", w.holdings.every((h) => siteOf(w, h.id) === undefined || !knowsHolding(w, KING, h.id)));
  check("the captains know their own country", w.explore.slice(1).every((e) => e.holdings.every((x) => x !== KNOW_UNKNOWN)));

  // Unknown holdings cannot be targeted, except at the end of a known road.
  const deep = unknown.find((h) => !isFrontier(w, KING, h.id))!;
  const edge = w.holdings.find((h) => isFrontier(w, KING, h.id));
  check("there is an unexplored frontier to march to", edge !== undefined, edge?.key ?? "");
  check("a place beyond the frontier is refused", targetRefusal(w, KING, deep.id) === EXPLORE_REFUSAL.unknownPlace &&
    w.check({ kind: "moveKing", to: deep.id }) === EXPLORE_REFUSAL.unknownPlace && w.planKingRoute(deep.id) === null);
  w.issue({ kind: "moveKing", to: deep.id });
  const ev = w.tick();
  check("and the sim rejects the march the same way", ev.some((e) => e.kind === "orderRejected" && e.reason === EXPLORE_REFUSAL.unknownPlace) &&
    w.king.mover.route.length === 0);
  check("a frontier place may be marched to", edge !== undefined && targetRefusal(w, KING, edge.id) === null && w.planKingRoute(edge.id) !== null);
  // Routes keep to known roads.
  let onKnown = true;
  for (const h of w.holdings) {
    const plan = w.planKingRoute(h.id);
    if (!plan) continue;
    let at = w.king.mover.node;
    for (const n of plan.route.nodes) {
      const r = w.graph.links.get(at)!.find(([nb]) => nb === n);
      if (!r || !knowsRoad(w, KING, r[1])) onKnown = false;
      at = n;
    }
  }
  check("every planned route keeps to roads the king knows", onKnown);
  // The pen sees only what he knows.
  const ctx = kingdomContext(w, w.kingPosition(), 1);
  check("the pen offers only known places and frontier marks",
    ctx.holdings.every((h) => knowsHolding(w, KING, h.id) || isFrontier(w, KING, h.id)) && !ctx.holdings.some((h) => h.id === deep.id));
  if (edge) {
    const cam = new KingdomCamera(w.map.width, w.map.height);
    cam.setViewport(1280, 720);
    cam.cut(edge.x, edge.y, 1.5);
    const p = { x: edge.x, y: edge.y };
    const tap = interpretStroke([p, p], kingdomContext(w, w.kingPosition(), cam.pxToWorld), w, w.kingPosition());
    check("tapping an unexplored mark opens no card and says what it is", tap.card === null && tap.message === X.unexploredTap);
  }

  // Sight is a function of its sources.
  const s = new KingdomWorld({ seed: SEED });
  const src = sightSources(s, KING);
  check("the king's sources: his retinue first, at the retinue's radius", src.length === 1 && src[0].miles === RETINUE_SIGHT_MILES);
  const far = s.holdingByKey("wrackhythe")!;
  const before = s.explore[KING].holdings[far.id - 1];
  applySight(s, KING, [{ x: far.x, y: far.y, miles: 60 }]);
  const seenFar = s.explore[KING].holdings[far.id - 1] === KNOW_SEEN;
  const start = s.king.mover.node;
  const startNow = s.explore[KING].holdings[start - 1];
  applySight(s, KING, []);
  check("applySight marks what a source sees as seen", before === KNOW_UNKNOWN && seenFar);
  check("a place out of every source's sight is remembered, not seen", startNow === KNOW_KNOWN &&
    s.explore[KING].holdings[far.id - 1] === KNOW_KNOWN && s.explore[KING].holdings.every((x) => x !== KNOW_SEEN));
  check("and nothing seen is ever forgotten", s.explore[KING].holdings[start - 1] === KNOW_KNOWN);

  // Marching reveals.
  const m = new KingdomWorld({ seed: SEED });
  const target = m.holdings.find((h) => isFrontier(m, KING, h.id))!;
  const knownBefore = m.explore[KING].holdings.filter((x) => x !== KNOW_UNKNOWN).length;
  m.issue({ kind: "moveKing", to: target.id });
  const sighted: number[] = [];
  runUntil(m, (e) => {
    if (e.kind === "sighted" && e.faction === KING) sighted.push(...e.holdings);
    return e.kind === "kingArrived" && e.destination;
  });
  const knownAfter = m.explore[KING].holdings.filter((x) => x !== KNOW_UNKNOWN).length;
  check("marching to the frontier reveals it and the country round it", knowsHolding(m, KING, target.id) &&
    knownAfter > knownBefore && sighted.includes(target.id), knownBefore + " -> " + knownAfter);

  // Deterministic and monotone over a long wander.
  const wander = (seed: number): { trace: string[]; monotone: boolean; world: KingdomWorld } => {
    const x = new KingdomWorld({ seed });
    const pick = Rng.create(0x7e57, Stream.Events);
    const trace: string[] = [];
    let last = x.explore.map((e) => [...e.holdings, ...e.roads]);
    let monotone = true;
    for (let d = 0; d < 400; d++) {
      if (x.king.mover.route.length === 0 && x.king.mover.road === 0) {
        const open = x.holdings.filter((h) => h.id !== x.king.mover.node && targetRefusal(x, KING, h.id) === null);
        const edge = open.filter((h) => isFrontier(x, KING, h.id));
        const pool = edge.length > 0 && pick.int(3) !== 0 ? edge : open;
        if (pool.length) x.issue({ kind: "moveKing", to: pool[pick.int(pool.length)].id });
      }
      // Answer with the first choice the stores can pay (every event has a free one).
      for (const f of pendingFinds(x, KING)) {
        const n = STORY_EVENTS[f.event].choices.length;
        let c = 0;
        while (c < n - 1 && checkResolve(x, KING, f.site, c) !== null) c++;
        x.issue({ kind: "resolveEvent", site: f.site, choice: c });
      }
      runTicks(x, TICKS_PER_DAY);
      const now = x.explore.map((e) => [...e.holdings, ...e.roads]);
      now.forEach((arr, f) => arr.forEach((v, i) => { if (last[f][i] !== KNOW_UNKNOWN && v === KNOW_UNKNOWN) monotone = false; }));
      last = now;
      trace.push(knowledgeOf(x));
    }
    return { trace, monotone, world: x };
  };
  const a = wander(SEED);
  const b = wander(SEED);
  check("the fog is deterministic: the same wander, the same knowledge every day", a.trace.join() === b.trace.join());
  check("the fog is monotone: nothing known ever becomes unknown", a.monotone && b.monotone);
  const knownEnd = a.world.explore[KING].holdings.filter((v) => v !== KNOW_UNKNOWN).length;
  check("and the wander found new country", knownEnd > 30, knownEnd + " places known");
}

// -- 3. sites and their events -------------------------------------------------------

section("sites");
{
  // From the start, the nearest site through the frontier: find one a march can reach.
  const w = new KingdomWorld({ seed: SEED });
  // Lift the fog by hand so the test can send him to a chosen site.
  const lift = (x: KingdomWorld): void => { x.explore[KING].holdings.fill(KNOW_KNOWN); x.explore[KING].roads.fill(KNOW_KNOWN); };
  lift(w);
  const site = id(w, "weather-tower");
  w.issue({ kind: "moveKing", to: site });
  const found = runUntil(w, (e) => e.kind === "siteDiscovered");
  check("arriving at a site finds it", found !== null && found.kind === "siteDiscovered" && found.site === site);
  check("the party halts there", w.king.mover.node === site && w.king.mover.route.length === 0);
  const f = findAt(w, KING, site)!;
  const def = STORY_EVENTS[f.event];
  check("the event drawn fits the site", def !== undefined && (def.site === siteOf(w, site) || def.site === "any"), def?.id);
  check("and its letter waits for a choice", pendingFinds(w, KING).length === 1 && f.choice === -1);

  // Leave and come back: no second event.
  let again = 0;
  const count = (ev: KingdomEvent[]) => { for (const e of ev) if (e.kind === "siteDiscovered") again++; };
  w.issue({ kind: "moveKing", to: id(w, "cold-hearth") });
  for (let i = 0; i < 2000 && !(w.king.mover.node === id(w, "cold-hearth")); i++) count(w.tick());
  w.issue({ kind: "moveKing", to: site });
  for (let i = 0; i < 2000 && !(w.king.mover.node === site); i++) count(w.tick());
  check("a site's event fires exactly once, however often he returns", again === 0 && w.explore[KING].finds.length === 1);

  // A site on the way halts the march there, the first time only.
  const x = new KingdomWorld({ seed: SEED });
  // The first tick is a day boundary, when sight is worked out afresh; the
  // road knowledge is set after it, so the plan uses exactly the roads below.
  x.tick();
  lift(x);
  const tower = id(x, "weather-tower");
  const fell = id(x, "fell-end");
  const cold = id(x, "cold-hearth");
  // cold-hearth -> weather-tower -> fell-end is a route through the site when the direct road is costlier.
  const route = findRoute(x.graph, x.king.mover, fell, routeOptions(x, KING));
  x.explore[KING].roads.fill(KNOW_UNKNOWN);
  for (const r of x.roads) {
    if ((r.a === cold && r.b === tower) || (r.a === tower && r.b === cold) || (r.a === tower && r.b === fell) || (r.a === fell && r.b === tower)) {
      x.explore[KING].roads[r.id - x.roads[0].id] = KNOW_KNOWN;
    }
  }
  x.issue({ kind: "moveKing", to: fell });
  const halt = runUntil(x, (e) => e.kind === "siteDiscovered");
  check("a march through a site not yet found halts at it", halt !== null && x.king.mover.node === tower &&
    x.king.mover.route.length === 0, route ? route.nodes.join(">") : "");
  x.issue({ kind: "moveKing", to: fell });
  let passed = false;
  let rehalt = false;
  for (let i = 0; i < 3000 && x.king.mover.node !== fell; i++) {
    for (const e of x.tick()) { if (e.kind === "kingArrived" && e.at === fell) passed = true; if (e.kind === "siteDiscovered") rehalt = true; }
  }
  check("and passes through it freely once found", passed && !rehalt);

  // The events stream, and only it.
  const y = new KingdomWorld({ seed: SEED });
  lift(y);
  const snap = () => (["economy", "kingdomAi", "autoresolve", "weather"] as const).map((n) => JSON.stringify(y.rng[n].snapshot())).join();
  const others = snap();
  const ev0 = JSON.stringify(y.rng.events.snapshot());
  y.king.mover.node = id(y, "sorrel-wood");
  discover(y, KING, id(y, "sorrel-wood"));
  check("finding a site draws on the events stream", JSON.stringify(y.rng.events.snapshot()) !== ev0);
  check("and on no other stream", snap() === others);
  const gamble = plant(y, "the-forgeworks", "smugglers-cache");
  const gi = STORY_EVENTS[eventIndex("smugglers-cache")].choices.findIndex((c) => c.chance);
  give(y, { coin: 50, grain: 50, timber: 50, iron: 50, levy: 10 });
  const ev1 = JSON.stringify(y.rng.events.snapshot());
  applyResolve(y, KING, gamble, gi);
  check("a gamble rolls on the events stream", JSON.stringify(y.rng.events.snapshot()) !== ev1);
  check("and on no other", snap() === others);
}

// -- 4. resolving --------------------------------------------------------------

section("resolve");
{
  const w = new KingdomWorld({ seed: SEED });
  const site = plant(w, "sorrel-wood", "wild-hives");
  check("no letter: refused", checkResolve(w, KING, id(w, "cold-hearth"), 0) === EXPLORE_REFUSAL.noSuchFind);
  check("no such choice: refused", checkResolve(w, KING, site, 7) === EXPLORE_REFUSAL.noSuchChoice &&
    checkResolve(w, KING, site, -1) === EXPLORE_REFUSAL.noSuchChoice);
  check("another faction's letter: refused", checkResolve(w, 3, site, 0) === EXPLORE_REFUSAL.noSuchFind);
  // A priced choice the stores cannot pay is refused; at least one free choice is not.
  const priced = plant(w, "copperdale", "old-workings");
  const ow = STORY_EVENTS[eventIndex("old-workings")];
  const pi = ow.choices.findIndex((c) => Object.keys(choiceCost(c.effects)).length > 0);
  for (const s of STOCK_IDS) w.economy[KING].stocks[s] = 0;
  check("a price the stores cannot pay is refused, as the card says",
    pi < 0 || (checkResolve(w, KING, priced, pi) === EXPLORE_REFUSAL.cannotPay && w.check({ kind: "resolveEvent", site: priced, choice: pi }) === EXPLORE_REFUSAL.cannotPay));
  const free = ow.choices.findIndex((c) => Object.keys(choiceCost(c.effects)).length === 0);
  check("a free choice is always open", checkResolve(w, KING, priced, free) === null);

  // By order: applied at the boundary, once.
  const r = new KingdomWorld({ seed: SEED });
  const hives = plant(r, "sorrel-wood", "wild-hives");
  const choice = STORY_EVENTS[eventIndex("wild-hives")].choices.findIndex((c) => c.effects.some((e) => e.kind === "upgrade"));
  r.issue({ kind: "resolveEvent", site: hives, choice });
  const ev = r.tick();
  check("a resolveEvent order applies its choice", ev.some((e) => e.kind === "eventResolved" && e.site === hives && e.choice === choice) &&
    findAt(r, KING, hives)!.choice === choice);
  check("the choice's upgrade is gained", ev.some((e) => e.kind === "upgradeGained") && r.explore[KING].upgrades.length === 1);
  r.issue({ kind: "resolveEvent", site: hives, choice: 0 });
  const ev2 = r.tick();
  check("a letter answered once cannot be answered again", ev2.some((e) => e.kind === "orderRejected" && e.reason === EXPLORE_REFUSAL.noSuchFind));

  // Every choice of every event applies cleanly through the ledger.
  let allClean = true;
  let detail = "";
  let gambleBoth = true;
  STORY_EVENTS.forEach((e, ei) => {
    e.choices.forEach((c, ci) => {
      const outcomes = new Set<boolean>();
      for (let seed = 1; seed <= (c.chance ? 40 : 1); seed++) {
        const x = new KingdomWorld({ seed });
        const site = x.holdings.find((h) => siteOf(x, h.id) !== undefined)!.id;
        x.explore[KING].holdings[site - 1] = KNOW_SEEN;
        x.explore[KING].finds.push({ site, event: ei, day: 0, choice: -1, failed: false });
        give(x, { coin: 100, grain: 100, timber: 100, iron: 100, levy: 20 });
        const page = x.books[KING].open;
        const start = LEDGER_STOCK_IDS.map((s) => (s === "legitimacy" ? x.economy[KING].legitimacy : x.economy[KING].stocks[s]));
        const why = applyResolve(x, KING, site, ci);
        const end = LEDGER_STOCK_IDS.map((s) => (s === "legitimacy" ? x.economy[KING].legitimacy : x.economy[KING].stocks[s]));
        // The page opened before give(); compare the movement since `start` with the categories K3a writes.
        const moved = LEDGER_STOCK_IDS.map((_, i) => end[i] - start[i]);
        const viaLedger = LEDGER_STOCK_IDS.map((s) => flowOf(page, s, "finds") + flowOf(page, s, "boons") - flowOf(page, s, "offerings") +
          (s === "legitimacy" ? flowOf(page, s, "deeds") - flowOf(page, s, "disgrace") : 0));
        const given = LEDGER_STOCK_IDS.map((s) => (s === "legitimacy" ? 0 : ({ coin: 100, grain: 100, timber: 100, iron: 100, levy: 20 } as Record<string, number>)[s]));
        const ok = why === null && moved.every((m, i) => m === viaLedger[i] - given[i]) && end.every((v) => v >= 0 && Number.isInteger(v));
        if (!ok && allClean) { allClean = false; detail = e.id + " choice " + ci + (why ? ": " + why : ": moved " + moved + " ledger " + viaLedger); }
        outcomes.add(findAt(x, KING, site)!.failed);
      }
      if (c.chance && outcomes.size !== 2) { gambleBoth = false; detail = detail || e.id + " gamble never went both ways"; }
    });
  });
  check("every choice of every event applies, and every stock it moves goes through the ledger", allClean, detail);
  check("every gamble can go either way", gambleBoth, detail);
  const reveal = STORY_EVENTS.findIndex((e) => e.choices.some((c) => c.effects.some((f) => f.kind === "reveal")));
  {
    const x = new KingdomWorld({ seed: SEED });
    // Copperdale, deep in the Iron Fells: plenty unknown round it.
    const hid = id(x, "copperdale");
    x.explore[KING].holdings[hid - 1] = KNOW_SEEN;
    x.explore[KING].finds.push({ site: hid, event: reveal, day: 0, choice: -1, failed: false });
    const ci = STORY_EVENTS[reveal].choices.findIndex((c) => c.effects.some((f) => f.kind === "reveal"));
    const n0 = x.explore[KING].holdings.filter((v) => v !== KNOW_UNKNOWN).length;
    give(x, { coin: 100, grain: 100, timber: 100, iron: 100, levy: 20 });
    applyResolve(x, KING, hid, ci);
    const n1 = x.explore[KING].holdings.filter((v) => v !== KNOW_UNKNOWN).length;
    check("a reveal marks places known (remembered, not seen)", n1 > n0 && !x.explore[KING].holdings.some((v, i) => v === KNOW_SEEN && i !== hid - 1 &&
      !sightSources(x, KING).some((s) => (x.holdings[i].x - s.x) ** 2 + (x.holdings[i].y - s.y) ** 2 <= s.miles ** 2)), n0 + " -> " + n1);
  }
}

// -- 5. upgrades bend the economy --------------------------------------------------------

section("upgrades");
{
  const withUp = (u: (typeof UPGRADE_IDS)[number]) => {
    const w = new KingdomWorld({ seed: SEED });
    w.explore[KING].upgrades.push(u);
    return w;
  };
  const plain = new KingdomWorld({ seed: SEED });
  check("deep cellars add grain storage", storageOf(withUp("deep-cellars"), KING).granary > storageOf(plain, KING).granary);
  const tracked = (u: (typeof UPGRADE_IDS)[number] | null, days: number) => {
    const w = u ? withUp(u) : new KingdomWorld({ seed: SEED });
    runTicks(w, days * TICKS_PER_DAY);
    return w;
  };
  const weirs = tracked("fishers-weirs", 10);
  check("fisher's weirs bring grain every day, under boons", flowOf(weirs.books[KING].closed!, "grain", "boons") > 0);
  check("charcoal pits bring timber every day", flowOf(tracked("charcoal-pits", 3).books[KING].closed!, "timber", "boons") > 0);
  const drovers = withUp("drovers-roads");
  const track = drovers.roads.find((r) => r.terrain === "track")!;
  check("drovers' roads make tracks easier for the party", roadCostFor(drovers, KING)(track) < track.cost && roadCostFor(plain, KING)(track) === track.cost);
  check("the wayfinder's map widens the retinue's sight", sightSources(withUp("wayfinders-map"), KING)[0].miles > RETINUE_SIGHT_MILES);
  // Foraging with and without the beekeeper's lore.
  const forage = (u: (typeof UPGRADE_IDS)[number] | null): number => {
    const w = u ? withUp(u) : new KingdomWorld({ seed: SEED });
    w.issue({ kind: "forage" });
    runTicks(w, 6 * TICKS_PER_DAY);
    return flowOf(w.books[KING].closed!, "grain", "forage");
  };
  check("beekeeper's lore gathers more from foraging", forage("beekeepers-lore") > forage(null), forage("beekeepers-lore") + " vs " + forage(null));
  const grantW = new KingdomWorld({ seed: SEED });
  const iron0 = grantW.economy[KING].stocks.iron;
  const site = plant(grantW, "the-forgeworks", "sealed-armoury");
  // Force the gamble to succeed by finding a seed that does: the grant is what is under test.
  let granted = false;
  for (let seed = 1; seed < 60 && !granted; seed++) {
    const x = new KingdomWorld({ seed });
    const s2 = plant(x, "the-forgeworks", "sealed-armoury");
    applyResolve(x, KING, s2, 0);
    if (x.explore[KING].upgrades.includes("forgotten-armoury")) granted = x.economy[KING].stocks.iron > iron0 && flowOf(x.books[KING].open, "iron", "boons") > 0;
  }
  void site;
  check("an upgrade's one-off grant lands in the stores, under boons", granted);
}

// -- 6. replay and save ------------------------------------------------------------------

/**
 * Ten years (or `days`) of an exploring king, driven by the test's own stream
 * and the world's state: each idle day he marches somewhere he may (an unfound
 * site if he knows one, else anywhere targetable), and every waiting letter is
 * answered with a choice the stores can pay. Orders go in through world.issue,
 * so the log records them exactly as the game would.
 */
function explorer(seed: number, days: number, each?: (w: KingdomWorld, ev: KingdomEvent[]) => void): KingdomWorld {
  const w = new KingdomWorld({ seed });
  const pick = Rng.create(0xe4b10e, Stream.Events);
  for (let d = 0; d < days; d++) {
    for (const f of pendingFinds(w, KING)) {
      const def = STORY_EVENTS[f.event];
      const open = def.choices.map((_, i) => i).filter((i) => checkResolve(w, KING, f.site, i) === null);
      w.issue({ kind: "resolveEvent", site: f.site, choice: open[pick.int(open.length)] });
    }
    const m = w.king.mover;
    if (m.route.length === 0 && m.road === 0 && pick.int(2) === 0) {
      // An explorer: usually the nearest place not yet explored (an
      // unexplored mark, or a known site not yet set foot in), now and then
      // anywhere at all.
      const open = w.holdings.filter((h) => h.id !== m.node && targetRefusal(w, KING, h.id) === null);
      const fresh = open.filter((h) => isFrontier(w, KING, h.id) || (siteOf(w, h.id) !== undefined && !findAt(w, KING, h.id)));
      let to = 0;
      if (fresh.length > 0 && pick.int(5) !== 0) {
        let best = Infinity;
        for (const h of fresh) {
          const eta = w.planKingRoute(h.id)?.etaTicks ?? Infinity;
          if (eta < best) { best = eta; to = h.id; }
        }
      } else if (open.length > 0) to = open[pick.int(open.length)].id;
      if (to !== 0) w.issue({ kind: "moveKing", to } as KingdomOrderBody);
    }
    if (d % 7 === 3) w.issue({ kind: "forage" });
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      const ev = w.tick();
      each?.(w, ev);
    }
  }
  return w;
}

section("replay");
{
  const a = explorer(SEED, 240);
  const found = a.explore[KING].finds.length;
  const resolved = a.explore[KING].finds.filter((f) => f.choice >= 0).length;
  check("the explorer found and answered letters", found >= 4 && resolved >= 3, found + " found, " + resolved + " answered");
  const r = replayLog(SEED, a.log, a.now);
  check("resolve-by-order replays identically from the log", kingdomHash(r) === kingdomHash(a), kingdomHash(a));
  check("the replay found the same events and made the same choices",
    JSON.stringify(r.explore) === JSON.stringify(a.explore));
  // Save with a letter waiting, load, answer it after the load: the same as never stopping.
  const x = new KingdomWorld({ seed: SEED });
  x.explore[KING].holdings.fill(KNOW_KNOWN);
  x.explore[KING].roads.fill(KNOW_KNOWN);
  x.issue({ kind: "moveKing", to: id(x, "hermits-cell") });
  runUntil(x, (e) => e.kind === "siteDiscovered");
  const json = saveToJson(x);
  const loaded = loadFromJson(json);
  check("a realm with a letter waiting saves and loads", loaded.ok && kingdomHash(loaded.value) === kingdomHash(x), loaded.ok ? "" : loaded.error);
  if (loaded.ok) {
    const y = loaded.value;
    x.issue({ kind: "resolveEvent", site: id(x, "hermits-cell"), choice: 0 });
    y.issue({ kind: "resolveEvent", site: id(y, "hermits-cell"), choice: 0 });
    runTicks(x, 300);
    runTicks(y, 300);
    check("and answering it after the load is the same as before it", kingdomHash(x) === kingdomHash(y));
  }
  // The hash sees exploration state.
  const h0 = kingdomHash(x);
  const nudge = (f: (w: KingdomWorld) => void): boolean => {
    const c = loadFromJson(json);
    if (!c.ok) return false;
    f(c.value);
    return kingdomHash(c.value) !== h0;
  };
  check("the hash sees what a faction knows", nudge((w) => { w.explore[KING].holdings[60] = w.explore[KING].holdings[60] === KNOW_UNKNOWN ? KNOW_KNOWN : KNOW_UNKNOWN; }) &&
    nudge((w) => { w.explore[2].roads[5] = KNOW_SEEN; }));
  check("the hash sees a letter answered, and an upgrade held",
    nudge((w) => { w.explore[KING].finds[0].choice = 0; }) && nudge((w) => { w.explore[KING].upgrades.push("salt-pans"); }));
  const p = JSON.parse(json);
  p.snapshot.explore[0].holdings[3] = 7;
  check("a save with a knowledge value that is not one is refused", !deserialize(p).ok);
  const q = JSON.parse(json);
  q.snapshot.explore[0].finds.push({ ...q.snapshot.explore[0].finds[0] });
  check("a save that finds a site twice is refused", !deserialize(q).ok);
  const u = JSON.parse(json);
  u.snapshot.explore[0].upgrades.push("philosophers-stone");
  check("a save with an unknown upgrade is refused", !deserialize(u).ok);
}

// -- 7. conservation ------------------------------------------------------------------

section("conservation");
{
  let pages = 0;
  let problem = "";
  let finds = 0;
  explorer(SEED + 7, 3 * 360, (w, ev) => {
    for (const e of ev) {
      if (e.kind === "eventResolved") finds++;
      if (e.kind !== "dayBegan") continue;
      w.books.forEach((b) => {
        if (!b.closed) return;
        pages++;
        problem = problem || balanced(b.closed, b.open);
      });
      for (const st of STOCK_IDS) if (!(w.economy[KING].stocks[st] >= 0)) problem = problem || "negative " + st;
    }
  });
  check("three years of exploring balance every day, every stock, every faction", problem === "" && pages > 1000, pages + " pages " + problem);
  check("with letters answered along the way", finds >= 5, String(finds));
}

// -- 8. migration of a real K3 save ---------------------------------------------------------

section("migration v2 -> v3");
{
  const here = fileURLToPath(new URL(".", import.meta.url));
  const text = readFileSync(here + "fixtures/kingdom-save-v2.json", "utf8");
  const v2 = JSON.parse(text);
  check("the fixture is a real version-2 save of the K3 map", v2.version === 2 && v2.mapFingerprint === K3_MAP.fingerprint);
  const m = migrate(JSON.parse(text));
  check("it migrates to version " + KINGDOM_SAVE_VERSION, m.ok && m.value.version === KINGDOM_SAVE_VERSION);
  const m3 = migrate(JSON.parse(text), MIGRATIONS, 3);
  check("by way of version 3 (K3a)", m3.ok && m3.value.version === 3);
  const loaded = loadFromJson(text);
  check("and loads", loaded.ok, loaded.ok ? "" : loaded.error);
  if (loaded.ok) {
    const w = loaded.value;
    const fresh = new KingdomWorld({ seed: v2.seed });
    check("onto the K3a map", mapFingerprint(w) === mapFingerprint(fresh) && w.holdings.length === 72);
    check("the day, the weather and the rng are kept", w.now === v2.snapshot.now && w.weather === v2.snapshot.weather &&
      JSON.stringify(w.rng.events.snapshot()) === JSON.stringify(v2.snapshot.rng.events));
    // The king was on the road from Greyshaw to Rookstead; he still is, on its new id.
    const r = w.graph.roads.get(w.king.mover.road)!;
    const ends = [w.holding(r.a)!.key, w.holding(r.b)!.key].sort().join();
    check("the king is where he was, on his road's new id", ends === "greyshaw,rookstead" &&
      w.king.mover.along === v2.snapshot.king.mover.along && w.king.mover.route.join() === v2.snapshot.king.mover.route.join(),
      "road " + v2.snapshot.king.mover.road + " -> " + w.king.mover.road);
    check("the king keeps his new id", w.king.id === fresh.king.id && w.nextId === fresh.nextId);
    check("the first 36 holdings keep their ids, owners and people", v2.snapshot.holdings.every((h: { id: number; key: string; owner: string | null; population: number }, i: number) =>
      w.holdings[i].id === h.id && w.holdings[i].key === h.key && w.holdings[i].owner === h.owner && w.holdings[i].population === h.population));
    // The sown plot: the log's sow names the same plot as the snapshot, on its new id.
    const sow = w.log.find((o) => o.kind === "sow") as { plot: number } | undefined;
    const plot = w.holdings.flatMap((h) => h.plots).find((p) => p.id === sow?.plot);
    check("plot ids are remapped in the snapshot and in the log alike", plot !== undefined && plot.crop === "rye", "plot " + sow?.plot);
    check("the stores are as they were", STOCK_IDS.every((s) => w.economy[KING].stocks[s] === v2.snapshot.economy[0].stocks[s]));
    const oldNC = v2.snapshot.economy[0].open.flow.length / LEDGER_STOCK_IDS.length;
    const page = w.books[KING].open;
    const nc = page.flow.length / LEDGER_STOCK_IDS.length;
    let relaid = true;
    for (let s = 0; s < LEDGER_STOCK_IDS.length; s++) {
      for (let c = 0; c < nc; c++) {
        const want = c < oldNC ? v2.snapshot.economy[0].open.flow[s * oldNC + c] : 0;
        if (page.flow[s * nc + c] !== want) relaid = false;
      }
    }
    check("ledger pages are re-laid for the new categories, every old value kept", relaid && nc === oldNC + 6);  // K3a's three, then K4's three
    check("the king still knows all of the old map", w.holdings.slice(0, 36).every((h) => knowsHolding(w, KING, h.id)) &&
      w.roads.slice(0, 52).every((r2) => knowsRoad(w, KING, r2.id)));
    check("and the new country is still to explore", w.holdings.slice(36).some((h) => !knowsHolding(w, KING, h.id)));
    check("what is in sight is worked out on load", w.explore[KING].holdings.some((v) => v === KNOW_SEEN));
    let ok = true;
    let halted = false;
    try {
      runTicks(w, 400, (ev) => { if (ev.length >= 0 && w.king.mover.route.length === 0) halted = true; });
    } catch { ok = false; }
    check("it plays on, and the order it had queued still applies", ok && halted && w.log.some((o) => o.kind === "haltKing" && o.seq === 9000));
    const again = loadFromJson(saveToJson(w));
    check("and saves again as version 3", again.ok && kingdomHash(again.value) === kingdomHash(w));
  }
  // A v2 save of some other map is not remapped -- and refused, since no such map exists here.
  const other = JSON.parse(text);
  other.mapFingerprint = "deadbeef";
  check("a v2 save not of the K3 map is refused, not remapped wrong", !deserialize(other).ok);
}

// -- 9. ten years ---------------------------------------------------------------------------

section("ten years");
{
  const days = (10 * TICKS_PER_YEAR) / TICKS_PER_DAY;
  const t0 = performance.now();
  const traceA: string[] = [];
  let monotone = true;
  let last: number[][] | null = null;
  const a = explorer(SEED, days, (w, ev) => {
    if (!ev.some((e) => e.kind === "dayBegan")) return;
    traceA.push(kingdomHash(w));
    const now = w.explore.map((e) => [...e.holdings, ...e.roads]);
    if (last) now.forEach((arr, f) => arr.forEach((v, i) => { if (last![f][i] !== KNOW_UNKNOWN && v === KNOW_UNKNOWN) monotone = false; }));
    last = now;
  });
  const ms = performance.now() - t0;
  const traceB: string[] = [];
  const b = explorer(SEED, days, (w, ev) => { if (ev.some((e) => e.kind === "dayBegan")) traceB.push(kingdomHash(w)); });
  const c = explorer(SEED + 1, 400);
  check("ten years of exploring, one seed, twice: identical every day", traceA.length === days && traceA.join() === traceB.join(), traceA.length + " days");
  check("and identical at the end", kingdomHash(a) === kingdomHash(b), kingdomHash(a));
  check("the log replays the decade", kingdomHash(replayLog(SEED, a.log, a.now)) === kingdomHash(a));
  check("knowledge never went back to unknown in ten years", monotone);
  const ex = a.explore[KING];
  check("the decade explored the realm", ex.finds.length >= 15 && ex.upgrades.length >= 5 &&
    ex.holdings.filter((v) => v !== KNOW_UNKNOWN).length >= 60,
    ex.finds.length + " sites, " + ex.upgrades.length + " upgrades, " + ex.holdings.filter((v) => v !== KNOW_UNKNOWN).length + " places known");
  check("no event was drawn twice", new Set(ex.finds.map((f) => f.event)).size === ex.finds.length);
  check("a different seed explores differently", kingdomHash(c) !== kingdomHash(explorer(SEED, 400)));
  check("ten years run in reasonable time", ms < 20000, ms.toFixed(0) + " ms");
}

// -- summary ----------------------------------------------------------------------------

void updateSight;
console.log("");
if (failures > 0) {
  console.log(failures + " of " + checks + " exploration check(s) FAILED");
  process.exit(1);
}
console.log("all " + checks + " exploration checks passed");
