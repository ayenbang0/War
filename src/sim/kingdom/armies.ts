/**
 * Armies on the kingdom map (PLAN.md §B.4, §B.11a, phase K4): raising them
 * from nothing, marching them, feeding and paying them, and what hunger and
 * empty purses do to them.
 *
 * An army is a battle army list -- doctrine, squads, abilities -- that lives
 * on the map: it has a Mover (the same one the king's retinue uses), grain in
 * its packs and wagons, a wage bill, and per squad the men still with the
 * colours and how many of them are wounded. That strength persists: K5 fields
 * what is left (`armyList`, `squadStrengths`) and writes back what survives.
 *
 * Pure and deterministic like the rest of src/sim/kingdom/:
 *   - armies (and their squads) take ids from the world's one counter and are
 *     kept in id order, and every loop here walks them in that order;
 *   - every stock moves through ledger.ts by category (wages, rations,
 *     provisions, recruitment, desertion, disbanded, favours), so the
 *     conservation test holds armies to the same exactness as the towns;
 *   - losses to hunger and unpaid wages are per-mille rates with a stored
 *     remainder, so they are exact integers and need no random draw.
 *
 * WHEN things happen (docs/kingdom.md "The tick"):
 *   - the army day (wages, rations, losses, recovery) runs once a day, right
 *     after the economy's day, so the party and the towns have eaten before
 *     the wagons load;
 *   - orders apply mid-tick like every other order;
 *   - armies march after the king's retinue, every tick, in id order, and
 *     then meetings (intercepts, merges at a distance) are settled.
 *
 * THE KING AND HIS ARMIES (docs/kingdom.md "K4"; docs/PROVISIONAL.md K4.1).
 * The king is not a squad. He rides WITH at most one army (king.army); his
 * retinue -- Brother Aldous and the followers not yet formed into squads --
 * travel with him. While he rides with an army it carries him: his mover is a
 * copy of the army's, written after it marches, and a march order for the
 * king is a march order for that army. The first army raised where he stands
 * alone takes him in, which is how his retinue becomes its nucleus. With no
 * army he is a token of his own, as in K2. An army he rides with draws on the
 * king's stores wherever it is (his purse and packs travel with him); any
 * other army eats from its own packs and wagons away from home.
 */

import { floor, max, min } from "../math.ts";
import { FACTION_IDS, KING_PLAYER } from "../../content/kingdom/factions.ts";
import { UNIT_TYPES, UNIT_TYPE_IDS, type UnitTypeId } from "../../content/unit-types.ts";
import { MAX_OF_ONE_ABILITY, MAX_SQUADS, type ArmyList } from "../../content/army.ts";
import { ABILITIES, abilityCost, type AbilityId } from "../../content/abilities.ts";
import { DOCTRINES, type DoctrineId } from "../../content/doctrines.ts";
import { BUILDINGS } from "../../content/kingdom/buildings.ts";
import { BIOME_ECONOMY } from "../../content/kingdom/economy.ts";
import { WEATHER } from "../../content/kingdom/terrain.ts";
import {
  ABILITY_LEGITIMACY, ARMY_FORAGE_PER_10, ARMY_MILES_PER_DAY, ARMY_ORDINALS, ARMY_RATION, ARMY_SPEED_BASE,
  ARMY_SPEED_PCT, CARRY_PER_MAN, COIN_PER_POINT, CONTACT_MILES, DEFAULT_ARMY_DOCTRINE, FOLLOWER_DESERT_PERMILLE,
  FORAGE_PLOT_HARM, HEAL_PCT, HUNGER_DESERT_PERMILLE, HUNGER_DIE_PERMILLE, HUNGER_GRACE_DAYS, HUNGER_SICK_PERMILLE,
  LEVY_MIN_MEN, LEVY_TYPES, MAX_ARMIES_PER_SIDE, RECRUIT_IRON, REPLACE_IRON_PER_DAY, REPLACE_MEN_PER_DAY, START_MORALE,
  UNPAID_DESERT_PERMILLE, UNPAID_GRACE_DAYS, WAGON_CARRY, dailyWage,
} from "../../content/kingdom/armies.ts";
import { ARMY_REFUSAL, armyName } from "../../content/kingdom/army-strings.ts";
import { REFUSAL } from "../../content/kingdom/ui-strings.ts";
import { EXPLORE_REFUSAL } from "../../content/story/strings.ts";
import { KNOW_SEEN } from "../../content/kingdom/exploration.ts";
import { TICKS_PER_DAY, calendar } from "./clock.ts";
import { advanceMover, findRoute, moverAt, moverPosition, setRoute, type Route } from "./graph.ts";
import { ARMY_ORDER_KIND_SET, type KingdomOrder, type KingdomOrderBody } from "./orders.ts";
import type { Army, ArmyDayReport, ArmyGoneReason, ArmyPosture, ArmySquad, Holding, Mover } from "./state.ts";
import { adjustLegitimacy, credit, debit, debitUpTo, snapshotStocks } from "./ledger.ts";
import { dailyNeed, economyActive, hasStanding, setTask } from "./economy.ts";
import { discover, holdingKnowledge, marchOptions, roadKnowledge, routeOptions, targetRefusal, updateSight } from "./explore.ts";
import type { KingdomWorld } from "./world.ts";
import { DESCENT_REFUSAL } from "../../content/kingdom/descent-strings.ts";
import { walledHostile } from "./descent.ts";

/** The army orders. */
export type ArmyOrderBody = Extract<KingdomOrderBody, {
  kind: "recruit" | "disband" | "marchArmy" | "haltArmy" | "merge" | "split" | "garrison" | "patrol" | "recover" |
    "setDoctrine" | "unlockAbility" | "intercept" | "kingJoin";
}>;

export function isArmyOrder(b: KingdomOrderBody): b is ArmyOrderBody {
  return ARMY_ORDER_KIND_SET.has(b.kind);
}

// -- queries (read-only; the UI, the pen, K5 and the tests use them) ----------------------

export function armyById(world: KingdomWorld, id: number): Army | undefined {
  // Armies are few (at most 8 a side); a scan in id order is the simple, ordered answer.
  for (const a of world.armies) if (a.id === id) return a;
  return undefined;
}

/** A faction's armies, in id order. */
export function armiesOf(world: KingdomWorld, owner: number): Army[] {
  return world.armies.filter((a) => a.owner === owner);
}

/** Men alive and with the colours, wounded included. */
export function armyMen(a: Army): number {
  let n = 0;
  for (const s of a.squads) n += s.men;
  return n;
}

export function armyWounded(a: Army): number {
  let n = 0;
  for (const s of a.squads) n += s.wounded;
  return n;
}

/** Men a full army of these squads would have. */
export function armyFullMen(a: Army): number {
  let n = 0;
  for (const s of a.squads) n += UNIT_TYPES[s.unit].soldiers;
  return n;
}

/** Percent of its men fit to fight (whole). */
export function armyFitness(a: Army): number {
  const men = armyMen(a);
  return men === 0 ? 0 : floor(((men - armyWounded(a)) * 100) / men);
}

/** Coin a day the army's trained squads are owed. */
export function armyWage(a: Army): number {
  let n = 0;
  for (const s of a.squads) n += dailyWage(UNIT_TYPES[s.unit].cost, s.levy);
  return n;
}

/** Grain a day the army eats. */
export function armyRation(a: Army): number {
  return armyMen(a) * ARMY_RATION;
}

/** Grain the army can carry: every man's pack, and the wagons. */
export function armyCapacity(a: Army): number {
  let n = 0;
  for (const s of a.squads) n += s.men * CARRY_PER_MAN + (s.unit === "wagon" && s.men > 0 ? WAGON_CARRY : 0);
  return n;
}

/** Whole days its packs and wagons would feed it with nothing else. */
export function supplyDays(a: Army): number {
  const r = armyRation(a);
  return r === 0 ? 0 : floor(a.supply / r);
}

/** What a faction's armies cost a day, for the resources bar: coin in wages, grain in rations. */
export function armyUpkeep(world: KingdomWorld, owner: number): { wage: number; ration: number } {
  let wage = 0;
  let ration = 0;
  for (const a of armiesOf(world, owner)) {
    wage += armyWage(a);
    ration += armyRation(a);
  }
  return { wage, ration };
}

/** The signals K6 turns into army morale, in one place (hunger, pay, strength, supply, wounded). */
export function armySignals(a: Army): {
  hungryDays: number; unpaidDays: number; arrears: number; strengthPct: number; fitPct: number; supplyDays: number;
} {
  const full = armyFullMen(a);
  return {
    hungryDays: a.hunger,
    unpaidDays: a.unpaid,
    arrears: a.arrears,
    strengthPct: full === 0 ? 0 : floor((armyMen(a) * 100) / full),
    fitPct: armyFitness(a),
    supplyDays: supplyDays(a),
  };
}

/** The battle army list this army fields (K5's BattleSpec is built from it and `squadStrengths`). */
export function armyList(a: Army): ArmyList {
  return { doctrine: a.doctrine, squads: a.squads.map((s) => s.unit), abilities: [...a.abilities] };
}

/** Per squad, in the army list's order: the men a battle would field and how many are wounded. */
export function squadStrengths(a: Army): { squad: number; unit: UnitTypeId; men: number; wounded: number }[] {
  return a.squads.map((s) => ({ squad: s.id, unit: s.unit, men: s.men, wounded: s.wounded }));
}

/** Battle speed of its slowest squad. */
function slowest(a: Army): number {
  let s = Infinity;
  for (const q of a.squads) if (UNIT_TYPES[q.unit].speed < s) s = UNIT_TYPES[q.unit].speed;
  return s === Infinity ? ARMY_SPEED_BASE : s;
}

/**
 * Percent of ARMY_MILES_PER_DAY this army marches at: its slowest squad's
 * pace, times its doctrine's speed (§B.2), clamped.
 */
export function armySpeedPct(a: Army): number {
  const pct = floor((slowest(a) * DOCTRINES[a.doctrine].speed * 100) / ARMY_SPEED_BASE);
  return pct < ARMY_SPEED_PCT.min ? ARMY_SPEED_PCT.min : pct > ARMY_SPEED_PCT.max ? ARMY_SPEED_PCT.max : pct;
}

/** Effort an army has per tick in clear weather (miles x surface cost). */
export function armyEffortPerTick(a: Army): number {
  return (ARMY_MILES_PER_DAY * armySpeedPct(a)) / 100 / TICKS_PER_DAY;
}

/** The holding a mover stands in, or 0 while on a road. */
export function standsIn(m: Mover): number {
  return m.road === 0 ? m.node : 0;
}

/** Map position of an army, in miles. */
export function armyPosition(world: KingdomWorld, a: Army): { x: number; y: number } {
  return moverPosition(world.graph, a.mover);
}

/** Can `faction` see this army now? Its own, always; another's only where the faction has eyes on the ground. */
export function armyVisible(world: KingdomWorld, faction: number, a: Army): boolean {
  if (a.owner === faction) return true;
  const m = a.mover;
  if (m.road === 0) return holdingKnowledge(world, faction, m.node) === KNOW_SEEN;
  return roadKnowledge(world, faction, m.road) === KNOW_SEEN;
}

/** What one squad of `unit` costs to raise, in stocks (levy: only the followers who form it). */
export function recruitCost(unit: UnitTypeId, levy: boolean, followers: number): { levy: number; coin: number; iron: number } {
  const u = UNIT_TYPES[unit];
  if (levy) return { levy: min(u.soldiers, followers), coin: 0, iron: 0 };
  return { levy: u.soldiers, coin: u.cost * COIN_PER_POINT, iron: RECRUIT_IRON[unit] ?? 0 };
}

/** Coin and legitimacy to unlock a battle ability for an army of this doctrine: the battle price list in coin. */
export function abilityPrice(ability: AbilityId, doctrine: DoctrineId): { coin: number; legitimacy: number } {
  return { coin: abilityCost(ability, doctrine) * COIN_PER_POINT, legitimacy: ABILITY_LEGITIMACY };
}

/** A holding where trained squads can be raised and replaced: a standing barracks whose upkeep is paid. */
export function hasBarracks(h: Holding): boolean {
  return hasStanding(h, "barracks", true);
}

/** The route a march order would take, and roughly how many ticks it would take today. For the ghost. */
export function planArmyRoute(world: KingdomWorld, a: Army, to: number): { route: Route; etaTicks: number } | null {
  if (targetRefusal(world, a.owner, to)) return null;
  const route = findRoute(world.graph, a.mover, to, routeOptions(world, a.owner));
  if (!route) return null;
  // Integer ticks by repeated subtraction would be exact but slow; ceil of a
  // quotient of two IEEE doubles is exact enough for a label and is the same
  // on every machine.
  const t = (route.effort * WEATHER[world.weather].travel) / armyEffortPerTick(a);
  const whole = floor(t);
  return { route, etaTicks: whole < t ? whole + 1 : whole };
}

/** Men of the king's army standing where he stands: with his unformed followers, who he has with him. */
export function menWithKing(world: KingdomWorld): number {
  const a = armyById(world, world.king.army);
  return a ? armyMen(a) : 0;
}

// -- making and unmaking armies ---------------------------------------------------------

function lowestFreeOrdinal(world: KingdomWorld, owner: number): number {
  const used = new Set(armiesOf(world, owner).map((a) => a.name));
  for (let i = 0; i < ARMY_ORDINALS.length; i++) if (!used.has(armyName(i))) return i;
  return ARMY_ORDINALS.length;
}

function newArmy(world: KingdomWorld, owner: number, mover: Mover, doctrine: DoctrineId): Army {
  const a: Army = {
    id: world.nextId++,
    owner,
    name: armyName(lowestFreeOrdinal(world, owner)),
    doctrine,
    squads: [],
    abilities: [],
    mover: { ...mover, route: [] },
    supply: 0,
    morale: START_MORALE,
    captain: "",
    hunger: 0,
    unpaid: 0,
    arrears: 0,
    posture: "none",
    postureDays: 0,
    patrol: [],
    patrolIndex: 0,
    target: 0,
    mergeInto: false,
    desertCarry: 0,
    dieCarry: 0,
    sickCarry: 0,
  };
  // Ids only grow, so pushing keeps world.armies in id order.
  world.armies.push(a);
  return a;
}

function newSquad(world: KingdomWorld, unit: UnitTypeId, men: number, levy: boolean): ArmySquad {
  return { id: world.nextId++, unit, men, wounded: 0, levy };
}

/**
 * Put an army on the map without paying for it: for the story's set pieces
 * and the captains' starting hosts (K8), and for tests that need a hostile
 * token to intercept. NOT an order and not for the player -- it is the same
 * kind of setup as the map's starting owners. Squads are full and fit.
 */
export function raiseArmy(
  world: KingdomWorld, owner: number, at: number, units: readonly UnitTypeId[], doctrine: DoctrineId = DEFAULT_ARMY_DOCTRINE,
): Army {
  if (armiesOf(world, owner).length >= MAX_ARMIES_PER_SIDE) throw new Error("raiseArmy: " + FACTION_IDS[owner] + " is at the cap");
  const a = newArmy(world, owner, moverAt(at), doctrine);
  for (const u of units) a.squads.push(newSquad(world, u, UNIT_TYPES[u].soldiers, false));
  world.events.push({ kind: "armyRaised", army: a.id, owner, at });
  updateSight(world, owner);
  return a;
}

function leaveGarrison(world: KingdomWorld, a: Army): void {
  for (const h of world.holdings) {
    const i = h.garrison.indexOf(a.id);
    if (i >= 0) h.garrison.splice(i, 1);
  }
}

function setPosture(world: KingdomWorld, a: Army, p: ArmyPosture): void {
  if (p !== "hold") leaveGarrison(world, a);
  if (p !== "patrol") { a.patrol = []; a.patrolIndex = 0; }
  if (a.posture === p) return;
  a.posture = p;
  a.postureDays = 0;
  world.events.push({ kind: "armyPosture", army: a.id, posture: p });
}

/** Stop chasing anyone. */
function clearTarget(a: Army): void {
  a.target = 0;
  a.mergeInto = false;
}

/** Take an army off the map: out of its garrison, out from under the king, off every chaser. */
export function removeArmy(world: KingdomWorld, a: Army, reason: ArmyGoneReason | null): void {
  leaveGarrison(world, a);
  const i = world.armies.indexOf(a);
  if (i >= 0) world.armies.splice(i, 1);
  if (world.king.army === a.id) {
    world.king.army = 0;
    world.king.mover = { ...a.mover, route: [] };
    world.events.push({ kind: "kingJoined", army: 0 });
  }
  for (const b of world.armies) {
    if (b.target === a.id) { clearTarget(b); b.mover.route = []; }
  }
  if (reason) world.events.push({ kind: "armyGone", army: a.id, owner: a.owner, name: a.name, reason });
}

/** Do two armies stand close enough to meet (a merge, an intercept, K5's contact)? */
export function inContact(world: KingdomWorld, a: Army, b: Army): boolean {
  if (a.mover.road === 0 && b.mover.road === 0) return a.mover.node === b.mover.node;
  const p = armyPosition(world, a);
  const q = armyPosition(world, b);
  const dx = p.x - q.x;
  const dy = p.y - q.y;
  return dx * dx + dy * dy <= CONTACT_MILES * CONTACT_MILES;
}

/** Would folding `a` into `into` break a cap of the rulebook? */
function mergeRefusal(a: Army, into: Army): string | null {
  if (a.squads.length + into.squads.length > MAX_SQUADS) return ARMY_REFUSAL.tooManySquads(MAX_SQUADS);
  for (const u of UNIT_TYPE_IDS) {
    let n = 0;
    for (const s of a.squads) if (s.unit === u) n++;
    for (const s of into.squads) if (s.unit === u) n++;
    if (n > UNIT_TYPES[u].maxPerArmy) return ARMY_REFUSAL.typeCap(UNIT_TYPES[u].name, UNIT_TYPES[u].maxPerArmy);
  }
  return null;
}

/**
 * Fold `a` into `into`. Men, squads and grain are moved whole -- nothing is
 * created or lost (the K4 test holds it to that). Abilities past the cap of
 * MAX_OF_ONE_ABILITY are dropped (docs/PROVISIONAL.md K4.6). The worse of the
 * two hunger and pay counts carries on, and the arrears add: hungry, unpaid
 * men do not forget because they met friends. Morale is the men-weighted mean.
 */
function doMerge(world: KingdomWorld, a: Army, into: Army): void {
  const menA = armyMen(a);
  const menB = armyMen(into);
  into.squads = [...into.squads, ...a.squads].sort((x, y) => x.id - y.id);
  into.supply += a.supply;
  for (const ab of a.abilities) {
    if (into.abilities.filter((x) => x === ab).length < MAX_OF_ONE_ABILITY) into.abilities.push(ab);
  }
  into.hunger = max(into.hunger, a.hunger);
  into.unpaid = max(into.unpaid, a.unpaid);
  into.arrears += a.arrears;
  if (menA + menB > 0) into.morale = floor((into.morale * menB + a.morale * menA) / (menA + menB));
  const kingWith = world.king.army === a.id;
  a.squads = [];
  a.supply = 0;
  a.arrears = 0;
  // Chasers of the absorbed army follow the one it joined.
  for (const b of world.armies) {
    if (b === a || b.target !== a.id) continue;
    if (b.id === into.id) clearTarget(b);
    else b.target = into.id;
  }
  removeArmy(world, a, null);
  if (kingWith) {
    world.king.army = into.id;
    world.king.mover = { ...into.mover, route: [...into.mover.route] };
    world.events.push({ kind: "kingJoined", army: into.id });
  }
  world.events.push({ kind: "armiesMerged", army: a.id, into: into.id, owner: a.owner, name: a.name });
}

/**
 * Take `n` men from the squads `pick` allows, one at a time from the largest
 * (ties: lowest id). `wounded`: take the wounded first (the dying), else the
 * fit (deserters walk). Returns how many were taken.
 */
export function takeMen(a: Army, n: number, pick: (s: ArmySquad) => boolean, wounded: boolean): number {
  let taken = 0;
  while (taken < n) {
    let best: ArmySquad | null = null;
    for (const s of a.squads) {
      if (!pick(s) || s.men === 0) continue;
      const pool = wounded ? s.wounded : s.men - s.wounded;
      const bestPool = best ? (wounded ? best.wounded : best.men - best.wounded) : -1;
      // Prefer the kind of man asked for; fall back to any.
      if (!best || pool > bestPool || (pool === bestPool && s.men > best.men)) best = s;
    }
    if (!best) break;
    if (wounded ? best.wounded > 0 : best.men - best.wounded === 0) best.wounded--;
    best.men--;
    if (best.wounded > best.men) best.wounded = best.men;
    taken++;
  }
  return taken;
}

/** A per-mille share of `of`, with its remainder carried in `carry`: [whole, newCarry]. */
function perMille(of: number, permille: number, carry: number): [number, number] {
  const t = of * permille + carry;
  const n = floor(t / 1000);
  return [n, t - n * 1000];
}

// -- validating orders: one function for the button and the sim -----------------------

function ownArmy(world: KingdomWorld, id: number, player: number): Army | string {
  const a = armyById(world, id);
  if (!a) return ARMY_REFUSAL.noSuchArmy;
  if (a.owner !== player) return ARMY_REFUSAL.notYourArmy;
  return a;
}

/**
 * Why an army order would be refused right now, or null if it would be
 * applied. The army card and the recruit dialog call this for every button
 * (through world.check), and applyArmyOrder calls the SAME function when the
 * order lands.
 */
export function checkArmyOrder(world: KingdomWorld, body: ArmyOrderBody, player: number): string | null {
  if (player < 0 || player >= FACTION_IDS.length) return REFUSAL.noSuchFaction;
  // K5: an army in a contact that waits answers to the contact alone (fight,
  // withdraw or resolve) -- nothing may march it off, split it or fold it away
  // while the battle it is in is being decided.
  if (world.contact) {
    const c = world.contact;
    const named = [body.army];
    if (body.kind === "merge") named.push(body.into);
    if (body.kind === "intercept") named.push(body.target);
    for (const id of named) {
      if (id !== 0 && (c.sides[0].army === id || c.sides[1].army === id)) return DESCENT_REFUSAL.inContact;
    }
  }
  const e = world.economy[player];
  if (body.kind === "recruit") {
    const u = UNIT_TYPES[body.unit];
    if (!u) return ARMY_REFUSAL.noSuchUnit;
    const h = world.holding(body.at);
    if (!h) return REFUSAL.noSuchHolding;
    if (body.army !== 0) {
      const got = ownArmy(world, body.army, player);
      if (typeof got === "string") return got;
      if (standsIn(got.mover) !== h.id) return ARMY_REFUSAL.armyNotThere;
      if (got.squads.length >= MAX_SQUADS) return ARMY_REFUSAL.tooManySquads(MAX_SQUADS);
      let n = 0;
      for (const s of got.squads) if (s.unit === body.unit) n++;
      if (n >= u.maxPerArmy) return ARMY_REFUSAL.typeCap(u.name, u.maxPerArmy);
    } else if (armiesOf(world, player).length >= MAX_ARMIES_PER_SIDE) {
      return ARMY_REFUSAL.tooManyArmies(MAX_ARMIES_PER_SIDE);
    }
    if (body.levy) {
      if (!LEVY_TYPES.includes(body.unit)) return ARMY_REFUSAL.notLevyType;
      // Followers are the king's: they gather round him, so he must be there.
      if (player !== KING_PLAYER) return REFUSAL.onlyKing;
      if (standsIn(world.king.mover) !== h.id) return ARMY_REFUSAL.levyKingThere;
      if (e.stocks.levy < LEVY_MIN_MEN) return ARMY_REFUSAL.levyTooFew(LEVY_MIN_MEN);
      return null;
    }
    if (h.owner !== FACTION_IDS[player]) return ARMY_REFUSAL.notYourHolding;
    if (!hasBarracks(h)) return ARMY_REFUSAL.needsBarracks;
    const c = recruitCost(body.unit, false, e.stocks.levy);
    if (e.stocks.levy < c.levy) return ARMY_REFUSAL.needLevy(c.levy);
    if (e.stocks.coin < c.coin) return ARMY_REFUSAL.needCoin(c.coin);
    if (e.stocks.iron < c.iron) return ARMY_REFUSAL.needIron(c.iron);
    return null;
  }
  if (body.kind === "kingJoin") {
    if (player !== KING_PLAYER) return REFUSAL.onlyKing;
    const k = world.king;
    if (body.army === 0) return k.army === 0 ? ARMY_REFUSAL.kingAlone : null;
    const got = ownArmy(world, body.army, player);
    if (typeof got === "string") return got;
    if (k.army === got.id) return ARMY_REFUSAL.kingAlready;
    const at = standsIn(got.mover);
    if (at === 0 || standsIn(k.mover) !== at) return ARMY_REFUSAL.kingElsewhere;
    return null;
  }
  const got = ownArmy(world, body.army, player);
  if (typeof got === "string") return got;
  const a = got;
  switch (body.kind) {
    case "marchArmy": {
      const unknown = targetRefusal(world, player, body.to);
      if (unknown) return unknown;
      if (standsIn(a.mover) === body.to) return ARMY_REFUSAL.alreadyThere;
      if (!findRoute(world.graph, a.mover, body.to, routeOptions(world, player))) return EXPLORE_REFUSAL.noKnownRoad;
      return null;
    }
    case "haltArmy":
      return null;
    case "merge": {
      const into = ownArmy(world, body.into, player);
      if (typeof into === "string") return into;
      if (into.id === a.id) return ARMY_REFUSAL.sameArmy;
      return mergeRefusal(a, into);
    }
    case "split": {
      const ids = new Set(body.squads);
      if (ids.size === 0 || ids.size !== body.squads.length || ids.size >= a.squads.length) {
        return a.squads.length < 2 ? ARMY_REFUSAL.splitOne : ARMY_REFUSAL.splitNone;
      }
      for (const id of ids) if (!a.squads.some((s) => s.id === id)) return ARMY_REFUSAL.splitNotHers;
      if (armiesOf(world, player).length >= MAX_ARMIES_PER_SIDE) return ARMY_REFUSAL.tooManyArmies(MAX_ARMIES_PER_SIDE);
      return null;
    }
    case "garrison":
    case "recover":
      return a.mover.road === 0 ? null : ARMY_REFUSAL.standing;
    case "patrol": {
      if (body.holdings.length < 2) return ARMY_REFUSAL.patrolNeedsTwo;
      for (let i = 0; i < body.holdings.length; i++) {
        const why = targetRefusal(world, player, body.holdings[i]);
        if (why) return why;
        if (body.holdings[i] === body.holdings[(i + 1) % body.holdings.length]) return ARMY_REFUSAL.patrolNeedsTwo;
      }
      if (!findRoute(world.graph, a.mover, body.holdings[0], routeOptions(world, player))) return EXPLORE_REFUSAL.noKnownRoad;
      return null;
    }
    case "setDoctrine":
      if (!DOCTRINES[body.doctrine]) return ARMY_REFUSAL.noSuchDoctrine;
      return a.doctrine === body.doctrine ? ARMY_REFUSAL.sameDoctrine : null;
    case "unlockAbility": {
      if (!ABILITIES[body.ability]) return ARMY_REFUSAL.noSuchAbility;
      if (a.abilities.filter((x) => x === body.ability).length >= MAX_OF_ONE_ABILITY) return ARMY_REFUSAL.abilityCap(MAX_OF_ONE_ABILITY);
      const p = abilityPrice(body.ability, a.doctrine);
      if (e.stocks.coin < p.coin || e.legitimacy < p.legitimacy) return ARMY_REFUSAL.abilityCost(p.coin, p.legitimacy);
      return null;
    }
    case "intercept": {
      const t = armyById(world, body.target);
      if (!t) return ARMY_REFUSAL.noSuchArmy;
      // Reserved for K8's enemies: meeting your own army is a merge.
      if (t.owner === player) return ARMY_REFUSAL.interceptOwn;
      if (!armyVisible(world, player, t)) return ARMY_REFUSAL.notSeen;
      return null;
    }
    case "disband":
      return null;
  }
}

// -- applying orders ------------------------------------------------------------------

/** Apply an army order. Returns null if applied, or the refusal (nothing changes). */
export function applyArmyOrder(world: KingdomWorld, order: KingdomOrder & ArmyOrderBody): string | null {
  const why = checkArmyOrder(world, order, order.player);
  if (why) return why;
  const f = order.player;
  const e = world.economy[f];
  const book = world.books[f];
  if (order.kind === "recruit") {
    const h = world.holding(order.at) as Holding;
    let a = order.army === 0 ? null : (armyById(world, order.army) as Army);
    const c = recruitCost(order.unit, order.levy, e.stocks.levy);
    if (!a) {
      a = newArmy(world, f, moverAt(h.id), DEFAULT_ARMY_DOCTRINE);
      world.events.push({ kind: "armyRaised", army: a.id, owner: f, at: h.id });
      // The first army raised where the king stands alone takes him in: his retinue is its nucleus.
      if (f === KING_PLAYER && world.king.army === 0 && standsIn(world.king.mover) === h.id) joinKing(world, a);
    }
    debit(e, book, "levy", c.levy, "recruitment");
    debit(e, book, "coin", c.coin, "recruitment");
    debit(e, book, "iron", c.iron, "recruitment");
    const s = newSquad(world, order.unit, c.levy, order.levy);
    a.squads.push(s);
    world.events.push({ kind: "recruited", army: a.id, squad: s.id, unit: s.unit, men: s.men, levy: s.levy });
    world.events.push({ kind: "stocksChanged", faction: f });
    updateSight(world, f);
    return null;
  }
  if (order.kind === "kingJoin") {
    if (order.army === 0) {
      const a = armyById(world, world.king.army) as Army;
      world.king.army = 0;
      world.king.mover = { ...a.mover, route: [] };
      world.events.push({ kind: "kingJoined", army: 0 });
    } else {
      joinKing(world, armyById(world, order.army) as Army);
    }
    return null;
  }
  const a = armyById(world, order.army) as Army;
  switch (order.kind) {
    case "marchArmy": {
      const route = findRoute(world.graph, a.mover, order.to, routeOptions(world, f)) as Route;
      clearTarget(a);
      setPosture(world, a, "none");
      setRoute(world.graph, a.mover, route);
      if (world.king.army === a.id) setTask(world, "none");
      return null;
    }
    case "haltArmy":
      clearTarget(a);
      setPosture(world, a, "none");
      a.mover.route = [];
      return null;
    case "merge": {
      const into = armyById(world, order.into) as Army;
      if (inContact(world, a, into)) { doMerge(world, a, into); return null; }
      setPosture(world, a, "none");
      a.target = into.id;
      a.mergeInto = true;
      chase(world, a);
      return null;
    }
    case "split": {
      const moving = new Set(order.squads);
      const menAll = armyMen(a);
      const out = a.squads.filter((s) => moving.has(s.id));
      let menOut = 0;
      for (const s of out) menOut += s.men;
      const b = newArmy(world, f, a.mover, a.doctrine);
      b.squads = out;
      a.squads = a.squads.filter((s) => !moving.has(s.id));
      // Grain and wages owed go with the men, by head, rounded toward the army that stays.
      const share = menAll === 0 ? 0 : floor((a.supply * menOut) / menAll);
      b.supply = share;
      a.supply -= share;
      const owed = menAll === 0 ? 0 : floor((a.arrears * menOut) / menAll);
      b.arrears = owed;
      a.arrears -= owed;
      b.morale = a.morale;
      b.hunger = a.hunger;
      b.unpaid = b.arrears > 0 ? a.unpaid : 0;
      if (a.arrears === 0) a.unpaid = 0;
      b.mover.route = [];
      world.events.push({ kind: "armySplit", army: a.id, into: b.id, squads: out.map((s) => s.id) });
      return null;
    }
    case "garrison": {
      clearTarget(a);
      a.mover.route = [];
      setPosture(world, a, "hold");
      const h = world.holding(a.mover.node) as Holding;
      // In a holding of yours, with room, it stands as its garrison (B.8's
      // "region with no army can be taken"); anywhere else it simply digs in.
      if (h.owner === FACTION_IDS[f] && h.garrison.length < h.garrisonSlots && !h.garrison.includes(a.id)) {
        h.garrison.push(a.id);
        h.garrison.sort((x, y) => x - y);
      }
      return null;
    }
    case "patrol": {
      clearTarget(a);
      setPosture(world, a, "patrol");
      a.patrol = [...order.holdings];
      a.patrolIndex = 0;
      setRoute(world.graph, a.mover, findRoute(world.graph, a.mover, a.patrol[0], routeOptions(world, f)) as Route);
      if (world.king.army === a.id) setTask(world, "none");
      return null;
    }
    case "recover":
      clearTarget(a);
      a.mover.route = [];
      setPosture(world, a, "recover");
      return null;
    case "setDoctrine":
      a.doctrine = order.doctrine;
      world.events.push({ kind: "doctrineSet", army: a.id, doctrine: a.doctrine });
      return null;
    case "unlockAbility": {
      const p = abilityPrice(order.ability, a.doctrine);
      debit(e, book, "coin", p.coin, "favours");
      adjustLegitimacy(e, book, -p.legitimacy, "favours");
      a.abilities.push(order.ability);
      world.events.push({ kind: "abilityUnlocked", army: a.id, ability: order.ability });
      world.events.push({ kind: "stocksChanged", faction: f });
      return null;
    }
    case "intercept":
      setPosture(world, a, "none");
      a.target = order.target;
      a.mergeInto = false;
      chase(world, a);
      return null;
    case "disband": {
      const at = world.holding(standsIn(a.mover));
      // At home the men rejoin the followers and the grain the stores; out
      // in the country they simply go home, and the grain with them.
      if (at && at.owner === FACTION_IDS[f] && economyActive(f)) {
        credit(e, book, "levy", armyMen(a), "disbanded");
        credit(e, book, "grain", a.supply, "disbanded");
        world.events.push({ kind: "stocksChanged", faction: f });
      }
      a.squads = [];
      a.supply = 0;
      removeArmy(world, a, "disbanded");
      updateSight(world, f);
      return null;
    }
  }
}

function joinKing(world: KingdomWorld, a: Army): void {
  world.king.army = a.id;
  world.king.mover = { ...a.mover, route: [...a.mover.route] };
  setTask(world, "none");
  world.events.push({ kind: "kingJoined", army: a.id });
}

/** Point a chasing army at where its quarry is, or is heading. */
function chase(world: KingdomWorld, a: Army): void {
  const t = armyById(world, a.target);
  if (!t) { clearTarget(a); return; }
  if (inContact(world, a, t)) { a.mover.route = []; return; }
  const dest = t.mover.road === 0 ? t.mover.node : t.mover.to;
  const end = a.mover.route.length > 0 ? a.mover.route[a.mover.route.length - 1] : standsIn(a.mover);
  if (end === dest) return;
  const route = findRoute(world.graph, a.mover, dest, routeOptions(world, a.owner));
  if (!route) { clearTarget(a); a.mover.route = []; return; }
  setRoute(world.graph, a.mover, route);
}

// -- the march (every tick) ---------------------------------------------------------------

/**
 * Every army marches, in id order, then meetings are settled in id order.
 * Called by KingdomWorld.tick after the king's retinue (which stays put while
 * an army carries him).
 */
export function marchArmies(world: KingdomWorld): void {
  const moved = new Set<number>();
  const travel = WEATHER[world.weather].travel;
  for (const a of world.armies) {
    if (a.target) chase(world, a);
    if (a.posture === "patrol" && a.mover.route.length === 0 && a.mover.road === 0 && a.patrol.length > 0) {
      if (a.mover.node === a.patrol[a.patrolIndex]) a.patrolIndex = (a.patrolIndex + 1) % a.patrol.length;
      const r = findRoute(world.graph, a.mover, a.patrol[a.patrolIndex], routeOptions(world, a.owner));
      if (r && r.nodes.length > 0) setRoute(world.graph, a.mover, r);
      else if (!r) setPosture(world, a, "none");
    }
    const m = a.mover;
    if (m.route.length === 0) continue;
    const leaving = m.road === 0 ? m.node : 0;
    const heading = m.route[0];
    // K5: a march halts at hostile walls, as the party halts at a site it is finding, and the
    // townsmen come out to meet it there (descent.ts detectContacts).
    const base = marchOptions(world, a.owner);
    const opts = { ...base, stopAt: (h: number) => (base.stopAt ? base.stopAt(h) : false) || walledHostile(world, a.owner, h) };
    const reached = advanceMover(world.graph, m, armyEffortPerTick(a), travel, opts);
    const king = world.king.army === a.id;
    if (leaving !== 0) {
      world.events.push({ kind: "armyDeparted", army: a.id, from: leaving, to: heading });
      if (king) world.events.push({ kind: "kingDeparted", from: leaving, to: heading });
    }
    for (let i = 0; i < reached.length; i++) {
      const last = i === reached.length - 1 && m.route.length === 0;
      world.events.push({ kind: "armyArrived", army: a.id, at: reached[i], destination: last });
      if (king) world.events.push({ kind: "kingArrived", at: reached[i], destination: last });
    }
    moved.add(a.owner);
    if (reached.length > 0) discover(world, a.owner, reached[reached.length - 1]);
  }
  // Meetings. Snapshot first: a merge takes an army off the list.
  for (const a of [...world.armies]) {
    if (!a.target || !world.armies.includes(a)) continue;
    const t = armyById(world, a.target);
    if (!t || !inContact(world, a, t)) continue;
    if (a.mergeInto && t.owner === a.owner) {
      // Both must stand in the holding, or within contact on the road; then fold.
      doMerge(world, a, t);
      continue;
    }
    world.events.push({ kind: "intercepted", army: a.id, target: t.id });
    clearTarget(a);
    a.mover.route = [];
  }
  // The king rides where his army rides.
  if (world.king.army !== 0) {
    const a = armyById(world, world.king.army);
    if (a) world.king.mover = { ...a.mover, route: [...a.mover.route] };
  }
  for (const f of [...moved].sort((x, y) => x - y)) updateSight(world, f);
}

// -- the army day ---------------------------------------------------------------------------

/**
 * The king's unformed followers are his party: a party hungry past the grace
 * loses some of them each day (K3 left `economy.hunger` for this).
 */
function followersDesert(world: KingdomWorld, f: number): void {
  const e = world.economy[f];
  if (e.hunger <= HUNGER_GRACE_DAYS || e.stocks.levy === 0) return;
  const n = min(e.stocks.levy, max(1, floor((e.stocks.levy * FOLLOWER_DESERT_PERMILLE) / 1000)));
  debit(e, world.books[f], "levy", n, "desertion");
  world.events.push({ kind: "followersDeserted", faction: f, n });
}

/**
 * Wages, bread, hunger, desertion, recovery and replacement for every army
 * whose faction's economy runs, in id order; and the followers' desertion.
 * Called once a day by KingdomWorld.tick, right after the economy's day.
 */
export function runArmyDay(world: KingdomWorld): void {
  const d = calendar(world.now);
  const before = world.economy.map((e) => snapshotStocks(e).join());
  // A new season: the fields an army stripped last season have had time to forgive it.
  if (d.dayOfSeason === 0) for (const h of world.holdings) h.foraged = 0;
  for (let f = 0; f < world.economy.length; f++) if (economyActive(f)) followersDesert(world, f);
  const gone: { a: Army; reason: ArmyGoneReason }[] = [];
  for (const a of world.armies) {
    const f = a.owner;
    a.postureDays++;
    if (!economyActive(f)) continue;
    const e = world.economy[f];
    const book = world.books[f];

    // Wages first, and what is owed before today's: a captain pays before he buys bread.
    const wage = armyWage(a);
    const owed = a.arrears + wage;
    const paid = debitUpTo(e, book, "coin", owed, "wages");
    a.arrears = owed - paid;
    const wasLate = a.unpaid > 0;
    a.unpaid = a.arrears > 0 ? a.unpaid + 1 : 0;
    if (wasLate !== a.unpaid > 0) world.events.push({ kind: "wagesLate", army: a.id, days: a.unpaid });

    // Bread: from its packs and wagons, then from the stores (at home, or
    // where the king's own stores ride with it), then from the land.
    const at = world.holding(standsIn(a.mover));
    const home = !!at && at.owner === FACTION_IDS[f];
    const stores = home || world.king.army === a.id;
    const ration = armyRation(a);
    let need = ration;
    const fromWagons = min(a.supply, need);
    a.supply -= fromWagons;
    need -= fromWagons;
    let fromStores = 0;
    if (need > 0 && stores) {
      fromStores = debitUpTo(e, book, "grain", need, "rations");
      need -= fromStores;
    }
    let foraged = 0;
    if (need > 0 && at) {
      foraged = min(need, floor((armyMen(a) * ARMY_FORAGE_PER_10[d.season] * BIOME_ECONOMY[at.biome].fertility) / 1000));
      need -= foraged;
      // Living off the land strips the fields, whoever's they are: supply
      // bought with goodwill (K6 reads `foraged` as unrest).
      at.foraged++;
      forageHarm(world, at);
    }
    let loaded = 0;
    if (stores) {
      // Fill the packs and wagons, keeping back a day's bread for the party and the towns.
      const spare = e.stocks.grain - dailyNeed(world, f);
      const room = armyCapacity(a) - a.supply;
      loaded = max(0, min(room, spare));
      debit(e, book, "grain", loaded, "provisions");
      a.supply += loaded;
    }
    const short = need;
    a.hunger = short > 0 ? a.hunger + 1 : 0;

    // Hunger past the grace: men walk home, some die, more fall sick.
    let deserted = 0;
    let died = 0;
    let sickened = 0;
    if (a.hunger > HUNGER_GRACE_DAYS) {
      const [dn, dc] = perMille(armyMen(a), HUNGER_DESERT_PERMILLE, a.desertCarry);
      a.desertCarry = dc;
      deserted += takeMen(a, dn, () => true, false);
      const [kn, kc] = perMille(armyMen(a), HUNGER_DIE_PERMILLE, a.dieCarry);
      a.dieCarry = kc;
      died += takeMen(a, kn, () => true, true);
      const [sn, sc] = perMille(armyMen(a) - armyWounded(a), HUNGER_SICK_PERMILLE, a.sickCarry);
      a.sickCarry = sc;
      sickened = fallSick(a, sn);
    }
    // Wages owed past the grace: trained men leave. The levy serve for bread.
    if (a.unpaid > UNPAID_GRACE_DAYS) {
      let trained = 0;
      for (const s of a.squads) if (!s.levy) trained += s.men;
      const [n, c] = perMille(trained, UNPAID_DESERT_PERMILLE, a.desertCarry);
      a.desertCarry = c;
      deserted += takeMen(a, n, (s) => !s.levy, false);
    }

    // Recovery: rest mends the wounded -- in a town of yours, faster with a
    // hall, and wherever there are surgeons -- and at a barracks the gaps in
    // the ranks are filled from the levy (and iron, for armed types).
    let healed = 0;
    let replaced = 0;
    let iron = 0;
    if (a.posture === "recover" && at && short === 0) {
      let pct = 0;
      if (home) pct += HEAL_PCT.owned;
      if (home && hasStanding(at, "hall", true)) pct += (BUILDINGS.hall.later.recovery ?? 0) * HEAL_PCT.perRecovery;
      for (const s of a.squads) if (s.unit === "healer" && s.men - s.wounded > 0) pct += HEAL_PCT.perHealerSquad;
      if (pct > 0) {
        for (const s of a.squads) {
          if (s.wounded === 0) continue;
          const n = min(s.wounded, max(1, floor((s.wounded * pct) / 100)));
          s.wounded -= n;
          healed += n;
        }
      }
      if (home && hasBarracks(at)) {
        for (const s of a.squads) {
          const gap = UNIT_TYPES[s.unit].soldiers - s.men;
          if (gap <= 0 || s.men === 0) continue;
          const needsIron = !s.levy && (RECRUIT_IRON[s.unit] ?? 0) > 0;
          if (needsIron && e.stocks.iron < REPLACE_IRON_PER_DAY) continue;
          const n = min(REPLACE_MEN_PER_DAY, gap, e.stocks.levy);
          if (n === 0) break;
          debit(e, book, "levy", n, "recruitment");
          if (needsIron) iron += debit(e, book, "iron", REPLACE_IRON_PER_DAY, "recruitment");
          s.men += n;
          replaced += n;
        }
      }
    }

    const report: ArmyDayReport = {
      army: a.id, owner: f, wage, paid, arrears: a.arrears, ration, fromWagons, fromStores, foraged, short, loaded,
      deserted, died, sickened, healed, replaced, iron,
    };
    world.events.push({ kind: "armyDay", ...report });
    a.squads = a.squads.filter((s) => s.men > 0);
    if (a.squads.length === 0) gone.push({ a, reason: a.hunger > 0 ? "starved" : "deserted" });
  }
  for (const g of gone) {
    removeArmy(world, g.a, g.reason);
    updateSight(world, g.a.owner);
  }
  world.economy.forEach((e, f) => {
    if (snapshotStocks(e).join() !== before[f]) world.events.push({ kind: "stocksChanged", faction: f });
  });
}

/** `n` fit men fall sick, one at a time from the squad with the most fit men (ties: lowest id). */
function fallSick(a: Army, n: number): number {
  let done = 0;
  while (done < n) {
    let best: ArmySquad | null = null;
    for (const s of a.squads) if (s.men - s.wounded > 0 && (!best || s.men - s.wounded > best.men - best.wounded)) best = s;
    if (!best) break;
    best.wounded++;
    done++;
  }
  return done;
}

/** A day of an army living off the land: every crop in the ground here is trampled and stripped. */
function forageHarm(world: KingdomWorld, h: Holding): void {
  for (const p of h.plots) {
    if (p.stage !== "sown" && p.stage !== "growing" && p.stage !== "ripe") continue;
    p.health = max(0, p.health - FORAGE_PLOT_HARM);
    if (p.health === 0) {
      p.stage = "spoiled";
      p.days = 0;
      world.events.push({ kind: "plotStage", holding: h.id, plot: p.id, stage: "spoiled", cause: "foraged" });
    }
  }
}
