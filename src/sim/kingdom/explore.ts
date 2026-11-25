/**
 * Exploration and the kingdom fog (PLAN.md §B.2, §B.11a; phase K3a).
 *
 * Per faction, every holding and road is unknown, known (remembered) or seen
 * (content/kingdom/exploration.ts). What a faction sees is worked out from a
 * list of SIGHT SOURCES -- a point and a radius -- by one function,
 * `applySight`, so K4's armies add sight by adding sources, not by touching
 * the fog. Seen falls back to known when the source moves on; nothing ever
 * falls back to unknown.
 *
 * Exploration sites (ruins, shrines, mines, deep woods, coasts, old forts:
 * map.ts `site`) hold one event each. The first time the king's party sets
 * foot in one it halts there, and an event is drawn for it from the EVENTS
 * stream (nothing else draws from that stream yet, so finding a ruin never
 * moves the weather or a harvest). The letter waits until a `resolveEvent`
 * order picks a choice; its effects go through the ledger like every other
 * stock change.
 *
 * Pure and deterministic like the rest of the sim: holdings and roads in id
 * order, sources in a fixed order, and distances compared squared with only
 * + - * /, which IEEE makes exact on every machine.
 */

import { floor } from "../math.ts";
import { FACTION_IDS, KING_PLAYER } from "../../content/kingdom/factions.ts";
import {
  HOLDING_SIGHT_MILES, KNOW_KNOWN, KNOW_SEEN, KNOW_UNKNOWN, RETINUE_SIGHT_MILES, type Knowledge,
} from "../../content/kingdom/exploration.ts";
import { BUILDINGS } from "../../content/kingdom/buildings.ts";
import { STOCK_IDS, type StockId } from "../../content/kingdom/economy.ts";
import type { RoadTerrainId } from "../../content/kingdom/terrain.ts";
import type { CropId } from "../../content/kingdom/crops.ts";
import { STORY_EVENTS, type EventEffect, type EventOutcome, type StoryEventDef } from "../../content/story/events.ts";
import { UPGRADES, type UpgradeEffect, type UpgradeId } from "../../content/story/upgrades.ts";
import { EXPLORE_REFUSAL } from "../../content/story/strings.ts";
import { calendar } from "./clock.ts";
import { canAfford, credit, debitUpTo, pay } from "./ledger.ts";
import { changeLegitimacy, standing } from "./economy.ts";
import type { AdvanceOptions, RouteOptions } from "./graph.ts";
import type { FactionExploration, Find, Holding, Road } from "./state.ts";
import type { KingdomWorld } from "./world.ts";

/** A point that sees round itself. */
export type SightSource = { readonly x: number; readonly y: number; readonly miles: number };

// -- construction -------------------------------------------------------------------

/**
 * A faction's knowledge on day one. The king knows the map's `startKnown`
 * holdings (the Reach he grew up in, and the great towns everyone has heard
 * of) and the roads that join two of them. The captains are this country's
 * lords and know all of it (docs/PROVISIONAL.md K3a.4); their fog matters
 * from K8, when their stewards and armies act on what they know.
 */
export function newExploration(world: KingdomWorld, faction: number): FactionExploration {
  const holdings: Knowledge[] = [];
  const roads: Knowledge[] = [];
  if (faction !== KING_PLAYER) {
    for (let i = 0; i < world.holdings.length; i++) holdings.push(KNOW_KNOWN);
    for (let i = 0; i < world.roads.length; i++) roads.push(KNOW_KNOWN);
    return { holdings, roads, finds: [], upgrades: [] };
  }
  const start = new Set(world.map.startKnown);
  for (const h of world.holdings) holdings.push(start.has(h.key) ? KNOW_KNOWN : KNOW_UNKNOWN);
  for (const r of world.roads) {
    const a = world.holding(r.a) as Holding;
    const b = world.holding(r.b) as Holding;
    roads.push(start.has(a.key) && start.has(b.key) ? KNOW_KNOWN : KNOW_UNKNOWN);
  }
  return { holdings, roads, finds: [], upgrades: [] };
}

// -- indexing -------------------------------------------------------------------------
//
// Holdings take ids 1..H and roads H+1..H+R (world.ts constructs them in that
// order), so a position in the knowledge arrays is the id minus the first id.

function holdingIndex(world: KingdomWorld, id: number): number {
  return id - world.holdings[0].id;
}

function roadIndex(world: KingdomWorld, id: number): number {
  return id - world.roads[0].id;
}

export function holdingKnowledge(world: KingdomWorld, faction: number, id: number): Knowledge {
  return world.explore[faction].holdings[holdingIndex(world, id)] ?? KNOW_UNKNOWN;
}

export function roadKnowledge(world: KingdomWorld, faction: number, id: number): Knowledge {
  return world.explore[faction].roads[roadIndex(world, id)] ?? KNOW_UNKNOWN;
}

export function knowsHolding(world: KingdomWorld, faction: number, id: number): boolean {
  return holdingKnowledge(world, faction, id) !== KNOW_UNKNOWN;
}

export function knowsRoad(world: KingdomWorld, faction: number, id: number): boolean {
  return roadKnowledge(world, faction, id) !== KNOW_UNKNOWN;
}

/**
 * An unknown holding at the end of a road the faction knows whose other end
 * it also knows: the edge of the map as the faction has drawn it. It may be
 * marched to (that is how it is found) and is drawn as an unnamed mark.
 */
export function isFrontier(world: KingdomWorld, faction: number, id: number): boolean {
  if (knowsHolding(world, faction, id)) return false;
  for (const [n, rid] of world.graph.links.get(id) ?? []) {
    if (knowsRoad(world, faction, rid) && knowsHolding(world, faction, n)) return true;
  }
  return false;
}

/** Why a faction may not be marched to holding `id`, or null if it may. */
export function targetRefusal(world: KingdomWorld, faction: number, id: number): string | null {
  if (!world.holding(id)) return EXPLORE_REFUSAL.unknownPlace;
  if (knowsHolding(world, faction, id) || isFrontier(world, faction, id)) return null;
  return EXPLORE_REFUSAL.unknownPlace;
}

// -- sight --------------------------------------------------------------------------

/** Effects of every upgrade a faction holds, in the order gained. */
export function upgradeEffects(world: KingdomWorld, faction: number): UpgradeEffect[] {
  const out: UpgradeEffect[] = [];
  for (const id of world.explore[faction].upgrades) out.push(...UPGRADES[id].effects);
  return out;
}

function sightBonus(world: KingdomWorld, faction: number, of: "retinue" | "watchtower"): number {
  let n = 0;
  for (const e of upgradeEffects(world, faction)) if (e.kind === "sightMiles" && e.of === of) n += e.miles;
  return n;
}

/**
 * What a faction sees with, in a fixed order: the king's retinue (for the
 * king), then each owned holding in id order -- a standing watchtower that is
 * not idle lifts its holding's radius to the tower's. K4 appends armies.
 */
export function sightSources(world: KingdomWorld, faction: number): SightSource[] {
  const out: SightSource[] = [];
  if (faction === KING_PLAYER) {
    const p = world.kingPosition();
    out.push({ x: p.x, y: p.y, miles: RETINUE_SIGHT_MILES + sightBonus(world, faction, "retinue") });
  }
  const owner = FACTION_IDS[faction];
  const tower = (BUILDINGS.watchtower.later.visionMiles ?? 0) + sightBonus(world, faction, "watchtower");
  for (const h of world.holdings) {
    if (h.owner !== owner) continue;
    let miles = HOLDING_SIGHT_MILES[h.kind];
    for (const b of standing(h)) if (b.def.id === "watchtower" && !h.idle[b.slot] && tower > miles) miles = tower;
    out.push({ x: h.x, y: h.y, miles });
  }
  return out;
}

function pointWithin(px: number, py: number, s: SightSource): boolean {
  const dx = px - s.x;
  const dy = py - s.y;
  return dx * dx + dy * dy <= s.miles * s.miles;
}

/** Is any point of segment a-b within the source's radius? */
function segmentWithin(a: Holding, b: Holding, s: SightSource): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((s.x - a.x) * dx + (s.y - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return pointWithin(a.x + t * dx, a.y + t * dy, s);
}

/**
 * Recompute what a faction sees from `sources`: everything seen falls back to
 * known, then every holding within a source's radius, and every road any part
 * of which is, becomes seen. Returns the ids of holdings that were unknown
 * before (ascending) -- newly found on the map.
 */
export function applySight(world: KingdomWorld, faction: number, sources: readonly SightSource[]): number[] {
  const ex = world.explore[faction];
  const found: number[] = [];
  for (let i = 0; i < world.holdings.length; i++) {
    const h = world.holdings[i];
    const was = ex.holdings[i];
    let now: Knowledge = was === KNOW_SEEN ? KNOW_KNOWN : was;
    for (const s of sources) if (pointWithin(h.x, h.y, s)) { now = KNOW_SEEN; break; }
    if (was === KNOW_UNKNOWN && now !== KNOW_UNKNOWN) found.push(h.id);
    ex.holdings[i] = now;
  }
  for (let i = 0; i < world.roads.length; i++) {
    const r = world.roads[i];
    const a = world.holding(r.a) as Holding;
    const b = world.holding(r.b) as Holding;
    let now: Knowledge = ex.roads[i] === KNOW_SEEN ? KNOW_KNOWN : ex.roads[i];
    for (const s of sources) if (segmentWithin(a, b, s)) { now = KNOW_SEEN; break; }
    ex.roads[i] = now;
  }
  return found;
}

/** applySight from the faction's own sources, with a `sighted` event for anything new. */
export function updateSight(world: KingdomWorld, faction: number): void {
  const found = applySight(world, faction, sightSources(world, faction));
  if (found.length > 0) world.events.push({ kind: "sighted", faction, holdings: found });
}

/**
 * Mark everything within `miles` of a point known (not seen: it was told of,
 * not looked at). Returns the holdings that were unknown before.
 */
export function revealAround(world: KingdomWorld, faction: number, x: number, y: number, miles: number): number[] {
  const ex = world.explore[faction];
  const src: SightSource = { x, y, miles };
  const found: number[] = [];
  world.holdings.forEach((h, i) => {
    if (ex.holdings[i] === KNOW_UNKNOWN && pointWithin(h.x, h.y, src)) {
      ex.holdings[i] = KNOW_KNOWN;
      found.push(h.id);
    }
  });
  world.roads.forEach((r, i) => {
    if (ex.roads[i] !== KNOW_UNKNOWN) return;
    if (segmentWithin(world.holding(r.a) as Holding, world.holding(r.b) as Holding, src)) ex.roads[i] = KNOW_KNOWN;
  });
  return found;
}

// -- routing under the fog -----------------------------------------------------------

/** Effort per mile of a road for a faction's party: the surface, less any road upgrades. */
export function roadCostFor(world: KingdomWorld, faction: number): (road: Road) => number {
  const cuts: { terrains: readonly RoadTerrainId[]; pct: number }[] = [];
  for (const e of upgradeEffects(world, faction)) if (e.kind === "roadCostPct") cuts.push(e);
  if (cuts.length === 0) return (r) => r.cost;
  return (r) => {
    let pct = 100;
    for (const c of cuts) if (c.terrains.includes(r.terrain)) pct += c.pct;
    return (r.cost * (pct < 10 ? 10 : pct)) / 100;
  };
}

/**
 * How a faction's party may route: only on roads it knows, only THROUGH
 * holdings it knows (an unknown one at the end of a known road can be
 * reached, not passed), at its own cost per mile.
 */
export function routeOptions(world: KingdomWorld, faction: number): RouteOptions {
  return {
    usable: (r) => knowsRoad(world, faction, r.id),
    through: (n) => knowsHolding(world, faction, n),
    cost: roadCostFor(world, faction),
  };
}

/** The march: the party's road costs, halting at any site it has not yet found. */
export function marchOptions(world: KingdomWorld, faction: number): AdvanceOptions {
  return { cost: roadCostFor(world, faction), stopAt: (n) => isUnfoundSite(world, faction, n) };
}

// -- finding sites -------------------------------------------------------------------

export function findAt(world: KingdomWorld, faction: number, site: number): Find | undefined {
  return world.explore[faction].finds.find((f) => f.site === site);
}

/** Is this holding an exploration site the faction has not set foot in? */
export function isUnfoundSite(world: KingdomWorld, faction: number, id: number): boolean {
  const def = world.map.holdings[holdingIndex(world, id)];
  return def?.site !== undefined && findAt(world, faction, id) === undefined;
}

/** Letters waiting for a choice, in the order found. */
export function pendingFinds(world: KingdomWorld, faction: number = KING_PLAYER): Find[] {
  return world.explore[faction].finds.filter((f) => f.event >= 0 && f.choice < 0);
}

/**
 * The party has set foot in holding `id`. If it is a site not yet found, draw
 * its event -- uniformly, on the events stream, from the events of its kind
 * and those that fit anywhere that this faction has not yet drawn, in table
 * order -- and record the find. Returns the find, or null if nothing new.
 */
export function discover(world: KingdomWorld, faction: number, id: number): Find | null {
  if (!isUnfoundSite(world, faction, id)) return null;
  const kind = world.map.holdings[holdingIndex(world, id)].site;
  const ex = world.explore[faction];
  const drawn = new Set(ex.finds.map((f) => f.event));
  const pool: number[] = [];
  STORY_EVENTS.forEach((e, i) => {
    if ((e.site === kind || e.site === "any") && !drawn.has(i)) pool.push(i);
  });
  // story/validate.ts holds the campaign to enough events per kind; a custom
  // map that runs out still records the visit, with nothing to decide.
  const event = pool.length > 0 ? pool[world.rng.events.int(pool.length)] : -1;
  const find: Find = { site: id, event, day: calendar(world.now).day, choice: -1, failed: false };
  ex.finds.push(find);
  world.events.push({ kind: "siteDiscovered", faction, site: id, event });
  return find;
}

// -- resolving a letter --------------------------------------------------------------

export function eventOf(find: Find): StoryEventDef | undefined {
  return find.event >= 0 ? STORY_EVENTS[find.event] : undefined;
}

/** What a choice costs up front (its `pay` effects, summed). */
export function choiceCost(effects: readonly EventEffect[]): Partial<Record<StockId, number>> {
  const out: Partial<Record<StockId, number>> = {};
  for (const e of effects) {
    if (e.kind !== "pay") continue;
    for (const s of STOCK_IDS) if (e.cost[s]) out[s] = (out[s] ?? 0) + (e.cost[s] as number);
  }
  return out;
}

/** Why `resolveEvent {site, choice}` would be refused now, or null. The card asks this too. */
export function checkResolve(world: KingdomWorld, faction: number, site: number, choice: number): string | null {
  if (faction < 0 || faction >= world.explore.length) return EXPLORE_REFUSAL.noSuchFind;
  const find = findAt(world, faction, site);
  const def = find ? eventOf(find) : undefined;
  if (!find || !def || find.choice >= 0) return EXPLORE_REFUSAL.noSuchFind;
  if (!Number.isInteger(choice) || choice < 0 || choice >= def.choices.length) return EXPLORE_REFUSAL.noSuchChoice;
  if (!canAfford(world.economy[faction], choiceCost(def.choices[choice].effects))) return EXPLORE_REFUSAL.cannotPay;
  return null;
}

/**
 * Apply a choice (checked first; returns the refusal if any). The price is
 * paid first and whatever comes of a gamble; then ONE roll on the events
 * stream decides a gamble; then the outcome's effects, in their order.
 */
export function applyResolve(world: KingdomWorld, faction: number, site: number, choice: number): string | null {
  const why = checkResolve(world, faction, site, choice);
  if (why) return why;
  const find = findAt(world, faction, site) as Find;
  const def = eventOf(find) as StoryEventDef;
  const c = def.choices[choice];
  const e = world.economy[faction];
  const book = world.books[faction];
  pay(e, book, choiceCost(c.effects), "offerings");
  let outcome: EventOutcome = c;
  let failed = false;
  if (c.chance && world.rng.events.int(100) >= c.chance.pct) {
    outcome = c.chance.fail;
    failed = true;
  }
  find.choice = choice;
  find.failed = failed;
  for (const fx of outcome.effects) applyEffect(world, faction, find, fx);
  world.events.push({ kind: "eventResolved", faction, site, event: find.event, choice, failed });
  return null;
}

function applyEffect(world: KingdomWorld, faction: number, find: Find, fx: EventEffect): void {
  const e = world.economy[faction];
  const book = world.books[faction];
  switch (fx.kind) {
    case "pay":
      return; // paid up front
    case "gain":
      for (const s of STOCK_IDS) credit(e, book, s, fx.gains[s] ?? 0, "finds");
      return;
    case "lose":
      for (const s of STOCK_IDS) debitUpTo(e, book, s, fx.loss[s] ?? 0, "offerings");
      return;
    case "legitimacy":
      changeLegitimacy(world, faction, fx.delta, fx.delta >= 0 ? "deeds" : "disgrace");
      return;
    case "upgrade":
      gainUpgrade(world, faction, fx.upgrade, find.site);
      return;
    case "reveal": {
      const h = world.holding(find.site) as Holding;
      const found = revealAround(world, faction, h.x, h.y, fx.miles);
      world.events.push({ kind: "revealed", faction, site: find.site, holdings: found });
      return;
    }
  }
}

/** A faction gains a special upgrade (once; a second grant of the same one does nothing). */
export function gainUpgrade(world: KingdomWorld, faction: number, id: UpgradeId, site: number): void {
  const ex = world.explore[faction];
  if (ex.upgrades.includes(id)) return;
  ex.upgrades.push(id);
  const e = world.economy[faction];
  const book = world.books[faction];
  for (const fx of UPGRADES[id].effects) {
    if (fx.kind === "grant") for (const s of STOCK_IDS) credit(e, book, s, fx.gains[s] ?? 0, "boons");
  }
  world.events.push({ kind: "upgradeGained", faction, upgrade: id, site });
}

// -- upgrade effects on the economy (economy.ts calls these) ------------------------------

function sumPct(world: KingdomWorld, faction: number, kind: "foragePct" | "taxPct" | "musterPct" | "spoilagePct"): number {
  let n = 0;
  for (const e of upgradeEffects(world, faction)) if (e.kind === kind) n += e.pct;
  return n;
}

export const foragePct = (w: KingdomWorld, f: number): number => sumPct(w, f, "foragePct");
export const taxPct = (w: KingdomWorld, f: number): number => sumPct(w, f, "taxPct");
export const musterPct = (w: KingdomWorld, f: number): number => sumPct(w, f, "musterPct");
export const spoilagePct = (w: KingdomWorld, f: number): number => sumPct(w, f, "spoilagePct");

/** Percent added to a plot's yield in a faction's holding by its upgrades. */
export function upgradeYieldPct(world: KingdomWorld, faction: number, h: Holding, crop: CropId): number {
  let n = 0;
  for (const e of upgradeEffects(world, faction)) {
    if (e.kind !== "yieldPct") continue;
    if (e.crop && e.crop !== crop) continue;
    if (e.withBuilding && !standing(h).some((b) => b.def.id === e.withBuilding && !h.idle[b.slot])) continue;
    n += e.pct;
  }
  return n;
}

/** Extra grain storage (granary-grade) from upgrades. */
export function upgradeStorage(world: KingdomWorld, faction: number): number {
  let n = 0;
  for (const e of upgradeEffects(world, faction)) if (e.kind === "storage") n += e.grain;
  return n;
}

/** The day's boons: stocks some upgrades bring every day (ledger: boons). */
export function creditDailyBoons(world: KingdomWorld, faction: number): void {
  const e = world.economy[faction];
  const book = world.books[faction];
  for (const fx of upgradeEffects(world, faction)) {
    if (fx.kind === "daily") for (const s of STOCK_IDS) credit(e, book, s, fx.gains[s] ?? 0, "boons");
  }
}

/** At the turn of a season: legitimacy per standing building of a kind (ledger: deeds). */
export function seasonalBoons(world: KingdomWorld, faction: number): void {
  const owner = FACTION_IDS[faction];
  for (const fx of upgradeEffects(world, faction)) {
    if (fx.kind !== "legitimacyPerBuilding") continue;
    let n = 0;
    for (const h of world.holdings) {
      if (h.owner !== owner) continue;
      for (const b of standing(h)) if (b.def.id === fx.building && !h.idle[b.slot]) n++;
    }
    if (n > 0) changeLegitimacy(world, faction, n * fx.perSeason, "deeds");
  }
}

/** Places a faction has explored (finds), and the sites it knows of: for the upgrades list. */
export function explorationCounts(world: KingdomWorld, faction: number): { found: number; sitesKnown: number } {
  let sitesKnown = 0;
  world.holdings.forEach((_, i) => {
    if (world.map.holdings[i].site !== undefined && world.explore[faction].holdings[i] !== KNOW_UNKNOWN) sitesKnown++;
  });
  return { found: world.explore[faction].finds.length, sitesKnown };
}

/** floor(x * (100 + pct) / 100) -- the one way a percentage bonus is applied to a whole stock. */
export function withPct(x: number, pct: number): number {
  return pct === 0 ? x : floor((x * (100 + pct)) / 100);
}
