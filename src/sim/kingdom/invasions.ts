/**
 * K8: invasions and the defence against them (PLAN.md §B.8). The captains'
 * strategic AI that sends the invasions is ai.ts; this file is the ground it
 * and the king both stand on:
 *
 *   - The captains' start (a realm with KingdomConfig.captains): stores, a
 *     seat with works, a garrison and a field host for every faction with a
 *     persona.
 *   - Rumours: the king hears of a host riding at one of his holdings, as far
 *     ahead as his watchtowers and scouts allow (warningDays).
 *   - The defence tools as orders: the levy call (callLevy), burning the
 *     fields (burnFields), an ambush laid in a holding (ambush). Garrisoning
 *     is K4's order; walls are a battle effect (descent.ts, app/battle-config.ts);
 *     the retreat to the keep is a choice at the contact (descent.ts).
 *   - A holding with no one to hold it -- no walls, no garrison, no army of
 *     its lord's in it -- is taken by a hostile army that stands in it,
 *     without a battle (seizeUndefended). Everything else goes through K5's
 *     descent.
 *
 * Pure and deterministic like the rest of the sim: id order everywhere, no
 * draws (nothing here is left to chance).
 */

import { ceil, floor, min } from "../math.ts";
import { FACTIONS, FACTION_IDS, KING_PLAYER } from "../../content/kingdom/factions.ts";
import { FORTIFICATIONS } from "../../content/kingdom/descent.ts";
import { UNIT_TYPES } from "../../content/unit-types.ts";
import { BUILDINGS } from "../../content/kingdom/buildings.ts";
import { OPENING_HOSTS } from "../../content/kingdom/descent.ts";
import {
  BURN_FIELDS, CROWN_SEAT_WORKS, FIELD_HOSTS, LEVY_CALL, SEAT_GARRISON, SEAT_WORKS, SEIZED_UNREST, WARNING,
} from "../../content/kingdom/invasions.ts";
import { MAX_ARMIES_PER_SIDE } from "../../content/kingdom/armies.ts";
import { INVASION_REFUSAL } from "../../content/kingdom/invasion-strings.ts";
import { TICKS_PER_DAY } from "./clock.ts";
import type { KingdomOrder, KingdomOrderBody } from "./orders.ts";
import type { Army, FactionIntel, Holding } from "./state.ts";
import {
  armiesOf, armyById, armyMen, armyVisible, armyPosition, planArmyRoute, raiseArmy, removeArmy, setPosture, standsIn,
} from "./armies.ts";
import { fortificationOf, hostile, inWaitingContact } from "./descent.ts";
import { hasStanding } from "./economy.ts";
import { addUnrest } from "./morale.ts";
import { updateSight } from "./explore.ts";
import type { KingdomWorld } from "./world.ts";

export type InvasionOrderBody = Extract<KingdomOrderBody, { kind: "callLevy" | "burnFields" | "ambush" }>;

const INVASION_KINDS: ReadonlySet<string> = new Set(["callLevy", "burnFields", "ambush"]);

export function isInvasionOrder(b: KingdomOrderBody): b is InvasionOrderBody {
  return INVASION_KINDS.has(b.kind);
}

/** Factions with a persona: the ones an AI steers (the usurper, the Margrave, the eight captains). */
export function aiFactions(): number[] {
  const out: number[] = [];
  FACTION_IDS.forEach((id, f) => { if (FACTIONS[id].persona) out.push(f); });
  return out;
}

/** The holding a faction governs from: its seat on the map, while it still holds it. 0 if it has lost it. */
export function seatOf(world: KingdomWorld, f: number): number {
  const def = world.map.holdings.find((d) => d.seat && d.owner === FACTION_IDS[f]);
  const h = def ? world.holdingByKey(def.key) : undefined;
  return h && h.owner === FACTION_IDS[f] ? h.id : 0;
}

function factionOf(h: Holding): number {
  return h.owner === null ? -1 : FACTION_IDS.indexOf(h.owner);
}

// -- the captains' start ----------------------------------------------------------------

/**
 * Every AI faction's seat gets its works (in its free slots, standing), its
 * garrison and its field host. Called by the constructor of a realm with
 * captains, after K5's opening hosts (whose Hare riders are the Hare's field
 * host), so a realm without captains keeps K7's ids exactly.
 */
export function setupCaptains(world: KingdomWorld): void {
  for (const f of aiFactions()) {
    const seat = world.holding(seatOf(world, f));
    if (!seat) continue;
    for (const id of SEAT_WORKS) {
      const slot = seat.buildings.indexOf(null);
      if (slot < 0) break;
      // A wall stands over a palisade (buildings.ts upgrades); the seat's own keep is its kind, not a work.
      if (BUILDINGS[id].upgrades && !seat.buildings.includes(BUILDINGS[id].upgrades as string)) continue;
      seat.buildings[slot] = id;
      seat.works[slot] = 0;
    }
    // K10: the Crown Seat is walled in stone (the capital siege is fought behind it, PLAN Part A Act IV).
    if (seat.key === world.map.crownSeat) {
      for (const id of CROWN_SEAT_WORKS) {
        const up = BUILDINGS[id].upgrades;
        const slot = up ? seat.buildings.indexOf(up) : seat.buildings.indexOf(null);
        if (slot < 0) continue;
        seat.buildings[slot] = id;
        seat.works[slot] = 0;
      }
    }
    const g = raiseArmy(world, f, seat.id, SEAT_GARRISON, "defensive");
    setPosture(world, g, "hold");
    if (seat.garrison.length < seat.garrisonSlots) seat.garrison.push(g.id);
    const opening = world.hosts && OPENING_HOSTS.some((o) => o.faction === FACTION_IDS[f]);
    const host = FIELD_HOSTS[FACTION_IDS[f]];
    if (host && !opening && armiesOf(world, f).length < MAX_ARMIES_PER_SIDE) raiseArmy(world, f, seat.id, host);
  }
}

/**
 * What every faction knows on day one: the map's owners, from common
 * knowledge (seen -1, men unknown 0). An AI faction's memory; empty for the
 * rest, which no AI reads.
 */
export function newIntel(world: KingdomWorld, f: number): FactionIntel {
  if (!world.captains || !FACTIONS[FACTION_IDS[f]].persona) return { owner: [], men: [], walls: [], seen: [] };
  return {
    owner: world.holdings.map((h) => factionOf(h)),
    men: world.holdings.map(() => 0),
    walls: world.holdings.map((h) => FORTIFICATIONS.indexOf(fortificationOf(h))),
    seen: world.holdings.map(() => -1),
  };
}

// -- rumours and warning -----------------------------------------------------------------

/** Squared miles between two map points (compared with squared miles: exact, and no sqrt). */
function miles(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** How many days out the king hears of a host riding at `target` (WARNING). */
export function warningDays(world: KingdomWorld, target: number): number {
  const t = world.holding(target);
  if (!t) return WARNING.baseDays;
  let towers = 0;
  for (const h of world.holdings) {
    if (h.owner !== "king" || !hasStanding(h, "watchtower", true)) continue;
    if (miles(h.x, h.y, t.x, t.y) <= WARNING.towerMiles * WARNING.towerMiles) towers++;
  }
  let scouts = 0;
  for (const a of world.armies) {
    if (a.owner !== KING_PLAYER) continue;
    const p = armyPosition(world, a);
    if (miles(p.x, p.y, t.x, t.y) > WARNING.scoutMiles * WARNING.scoutMiles) continue;
    for (const q of a.squads) if (q.unit === "scout" && q.men > q.wounded) scouts++;
  }
  return min(WARNING.maxDays, WARNING.baseDays + WARNING.perTower * towers + WARNING.perScout * scouts);
}

/** The king's holding a hostile army is riding at, and its days out, or null. */
export function threatOf(world: KingdomWorld, a: Army): { target: number; days: number } | null {
  if (!hostile(a.owner, KING_PLAYER) || a.mover.route.length === 0) return null;
  const dest = a.mover.route[a.mover.route.length - 1];
  const h = world.holding(dest);
  if (!h || h.owner !== "king") return null;
  const plan = planArmyRoute(world, a, dest);
  if (!plan) return null;
  return { target: dest, days: ceil(plan.etaTicks / TICKS_PER_DAY) };
}

/**
 * The day's rumours: every hostile host riding at a holding of the king's
 * that he would now hear of (within warningDays, or in his sight) and has
 * not heard of yet raises one (the rumour card); a rumour whose host is gone,
 * has turned aside or has arrived is forgotten. Once a day, after the day's
 * orders, so a march ordered this morning is heard of this morning.
 */
export function updateRumours(world: KingdomWorld): void {
  const day = world.date.day;
  for (let i = world.rumours.length - 1; i >= 0; i--) {
    const r = world.rumours[i];
    const a = armyById(world, r.army);
    const t = a ? threatOf(world, a) : null;
    if (!t || t.target !== r.target) world.rumours.splice(i, 1);
  }
  for (const a of world.armies) {
    const t = threatOf(world, a);
    if (!t || world.rumours.some((r) => r.army === a.id)) continue;
    const seen = armyVisible(world, KING_PLAYER, a);
    if (!seen && t.days > warningDays(world, t.target)) continue;
    const from = a.mover.road === 0 ? a.mover.node : a.mover.from;
    world.rumours.push({ army: a.id, target: t.target, from, days: t.days, day });
    world.events.push({ kind: "rumour", army: a.id, owner: a.owner, target: t.target, from, days: t.days });
  }
}

// -- the defence tools -------------------------------------------------------------------------

/** Days before `holding` can be called out again (0: now). */
export function levyCooldown(world: KingdomWorld, holding: number): number {
  const day = world.date.day;
  let left = 0;
  for (const l of world.levied) if (l.holding === holding) left = l.day + LEVY_CALL.cooldownDays - day;
  return left > 0 ? left : 0;
}

/** Men a levy call at this holding would turn out now. */
export function levyMen(h: Holding): number {
  return min(LEVY_CALL.maxSquads * UNIT_TYPES[LEVY_CALL.unit].soldiers, floor(h.population / LEVY_CALL.peoplePerMan));
}

export function isBurned(world: KingdomWorld, holding: number): boolean {
  return world.burned.some((b) => b.holding === holding);
}

export function checkInvasionOrder(world: KingdomWorld, body: InvasionOrderBody, player: number): string | null {
  if (body.kind === "ambush") {
    const a = armyById(world, body.army);
    if (!a || a.owner !== player) return INVASION_REFUSAL.noArmy;
    if (inWaitingContact(world, a.id)) return INVASION_REFUSAL.noArmy;
    if (a.mover.road !== 0) return INVASION_REFUSAL.ambushOnRoad;
    if (a.mover.route.length > 0) return INVASION_REFUSAL.ambushMarching;
    if (a.posture === "ambush") return INVASION_REFUSAL.alreadyAmbush;
    return null;
  }
  const h = world.holding(body.holding);
  if (!h) return INVASION_REFUSAL.noSuchHolding;
  if (h.owner !== FACTION_IDS[player]) return INVASION_REFUSAL.notYours;
  if (body.kind === "callLevy") {
    const wait = levyCooldown(world, h.id);
    if (wait > 0) return INVASION_REFUSAL.calledLately(wait);
    if (levyMen(h) < LEVY_CALL.minMen) return INVASION_REFUSAL.tooFew;
    if (armiesOf(world, player).length >= MAX_ARMIES_PER_SIDE) return INVASION_REFUSAL.armyCap(MAX_ARMIES_PER_SIDE);
    return null;
  }
  if (isBurned(world, h.id)) return INVASION_REFUSAL.burning;
  return null;
}

export function applyInvasionOrder(world: KingdomWorld, order: KingdomOrder & InvasionOrderBody): string | null {
  const why = checkInvasionOrder(world, order, order.player);
  if (why) return why;
  const f = order.player;
  if (order.kind === "ambush") {
    const a = armyById(world, order.army) as Army;
    a.target = 0;
    a.mergeInto = false;
    setPosture(world, a, "ambush");
    return null;
  }
  const h = world.holding(order.holding) as Holding;
  if (order.kind === "callLevy") {
    const men = levyMen(h);
    const full = UNIT_TYPES[LEVY_CALL.unit].soldiers;
    const n = ceil(men / full);
    const a = raiseArmy(world, f, h.id, new Array(n).fill(LEVY_CALL.unit), "defensive");
    // The men spread over the squads, the first taking any odd ones; raw levies serve for bread.
    let left = men;
    a.squads = a.squads.map((q, i) => {
      const take = i === n - 1 ? left : min(full, left - floor((left * (n - i - 1)) / (n - i)));
      left -= take;
      return { ...q, men: take, levy: true };
    });
    a.morale = LEVY_CALL.morale;
    h.population -= men;
    setPosture(world, a, "hold");
    if (h.garrison.length < h.garrisonSlots) {
      h.garrison.push(a.id);
      h.garrison.sort((x, y) => x - y);
    }
    for (let i = world.levied.length - 1; i >= 0; i--) if (world.levied[i].holding === h.id) world.levied.splice(i, 1);
    world.levied.push({ holding: h.id, day: world.date.day });
    addUnrest(world, h, LEVY_CALL.unrest);
    world.events.push({ kind: "levyCalled", holding: h.id, army: a.id, men });
    return null;
  }
  // Burn the fields: what is in the ground is lost, and the land feeds no army for a while.
  for (const p of h.plots) {
    if (p.stage !== "sown" && p.stage !== "growing" && p.stage !== "ripe") continue;
    p.stage = "spoiled";
    p.days = 0;
    p.lost = "burned";
    world.events.push({ kind: "plotStage", holding: h.id, plot: p.id, stage: "spoiled", cause: "burned" });
  }
  world.burned.push({ holding: h.id, days: BURN_FIELDS.days });
  world.burned.sort((x, y) => x.holding - y.holding);
  addUnrest(world, h, BURN_FIELDS.unrest);
  world.events.push({ kind: "fieldsBurned", holding: h.id });
  return null;
}

/** The day's count-down of burned land. */
export function runInvasionDay(world: KingdomWorld): void {
  for (let i = world.burned.length - 1; i >= 0; i--) if (--world.burned[i].days <= 0) world.burned.splice(i, 1);
}

// -- taken without a battle -------------------------------------------------------------------

function take(world: KingdomWorld, h: Holding, f: number): void {
  const from = factionOf(h);
  h.owner = FACTION_IDS[f];
  h.garrison = [];
  h.tax = world.economy[f].defaultTax;
  h.taxCarry = 0;
  h.doleCarry = 0;
  h.famine = 0;
  h.festival = 0;
  h.unrest = SEIZED_UNREST;
  world.events.push({ kind: "seized", holding: h.id, faction: f, from });
  world.events.push({ kind: "claimed", holding: h.id, faction: f });
}

/**
 * Every army standing still in a holding with no one to hold it takes it
 * (PLAN §B.8: "a region whose garrison is empty is taken without a battle"):
 * the holding is a hostile faction's, it has no walls (walls are assaulted,
 * descent.ts), no garrison and no army of its lord's standing in it. A
 * steward's army also takes back an unclaimed holding of its own province
 * that it held on the map (a town that threw it off). Commons standing in a
 * holding the king holds go home to it. Each tick after contact, in army-id
 * order; only in a realm with captains (a K5-K7 realm keeps its rules).
 */
export function seizeUndefended(world: KingdomWorld): void {
  const commons = FACTION_IDS.indexOf("commons");
  for (const a of [...world.armies]) {
    if (!world.armies.includes(a)) continue;
    const at = standsIn(a.mover);
    if (at === 0 || a.mover.route.length > 0 || a.target !== 0 || a.posture === "ambush" || inWaitingContact(world, a.id)) continue;
    const h = world.holding(at) as Holding;
    const owner = factionOf(h);
    if (a.owner === commons) {
      if (owner >= 0 && !hostile(owner, a.owner)) {
        h.population += armyMen(a);
        a.squads = [];
        world.events.push({ kind: "commonsDispersed", army: a.id, holding: h.id });
        removeArmy(world, a, "disbanded");
      }
      continue;
    }
    if (owner === a.owner) continue;
    if (fortificationOf(h) !== "none" || h.garrison.length > 0) continue;
    if (owner >= 0) {
      if (!hostile(owner, a.owner)) continue;
      if (world.armies.some((b) => b.owner === owner && standsIn(b.mover) === at)) continue;
    } else {
      const def = world.map.holdings.find((d) => d.key === h.key);
      if (a.owner === KING_PLAYER || !def || def.owner !== FACTION_IDS[a.owner]) continue;
      // Not while hostile men still stand in it (they are met as a contact first).
      if (world.armies.some((b) => hostile(b.owner, a.owner) && standsIn(b.mover) === at)) continue;
    }
    take(world, h, a.owner);
    const fs = [a.owner, owner].filter((x) => x >= 0).sort((x, y) => x - y);
    for (const x of fs) updateSight(world, x);
  }
}
