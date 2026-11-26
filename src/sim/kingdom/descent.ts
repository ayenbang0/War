/**
 * Dropping a layer: kingdom -> army (PLAN.md §B.9, phase K5).
 *
 * Three things live here, all pure and deterministic like the rest of
 * src/sim/kingdom/:
 *
 *  1. CONTACT. Once per kingdom tick, after the armies march, in army-id
 *     order: two armies of hostile sides on the same holding, or on the same
 *     road within ENGAGE_RADIUS of each other, or one in a holding and the
 *     other on a road out of it within that reach, are in contact; so is an
 *     army standing in a hostile holding that has walls and no army of its
 *     owner's to defend them (its townsmen man the walls). Hostile means one
 *     serves the crown and the other does not (factions.ts `crown`).
 *
 *     A contact the king's side is in is WAITING (`world.contact`): both
 *     armies halt, and the realm holds -- a tick that begins with a contact
 *     waiting applies the orders due and nothing else, and the clock does not
 *     move -- until a `resolveContact` order settles it. That is the plan's
 *     "the kingdom clock auto-pauses on contact", made a rule of the sim
 *     rather than of the screen, so a headless run, a replay and a resumed
 *     save all stop in the same place. A contact between two of the
 *     machine's sides is settled at once by the auto-resolve.
 *
 *  2. THE HANDOFF. `buildBattleSpec` turns a contact and the kingdom into a
 *     BattleSpec (sim/layers.ts); `applyBattleResult` takes a BattleResult
 *     back. Because the realm is held while a contact waits, the spec built
 *     when the battle is applied is the spec the battle was built from.
 *     `resultFromBattle` reads a finished battle World into a result.
 *
 *  3. SETTLING. Fight (with a result), withdraw (a rearguard and some nerve,
 *     unless cut off), or resolve for me (autoresolve.ts, on the
 *     `autoresolve` stream, strictly worse in expectation than fighting).
 *
 * Disengagement: two sides that have just settled a contact are not put in
 * contact again until they have stood apart (`world.disengaged`), or every
 * withdrawal would meet its enemy again on the next tick.
 */

import { encounterFor, isStoryHost, storyAbilities } from "./story.ts";
import type { EncounterDef } from "../../content/story/encounters.ts";
import { abs, floor, max, min, round } from "../math.ts";
import { FACTIONS, FACTION_IDS, KING_PLAYER } from "../../content/kingdom/factions.ts";
import { UNIT_TYPES } from "../../content/unit-types.ts";
import { HOLD_DIG_IN_DAYS } from "../../content/kingdom/armies.ts";
import { BIOMES } from "../../content/kingdom/terrain.ts";
import { levelById } from "../../content/levels/index.ts";
import {
  ENGAGE_RADIUS, FACTION_BATTLE_COMMANDER, FACTION_BATTLE_DIFFICULTY, LOSS_LEGITIMACY, MILITIA_MORALE,
  MILITIA_PEOPLE_PER_MAN, MILITIA_SQUADS, MILITIA_UNIT, NERVE_FLOOR, WIN_LEGITIMACY, WITHDRAW_MORALE,
  WITHDRAW_REARGUARD_PERMILLE, WOUNDED_HP_FRACTION, WALLS_DOWN, SIEGE_STORM, type Fortification,
} from "../../content/kingdom/descent.ts";
import { DESCENT_REFUSAL } from "../../content/kingdom/descent-strings.ts";
import { INVASION_REFUSAL } from "../../content/kingdom/invasion-strings.ts";
import { KEEP_RETREAT, YIELD_LEGITIMACY } from "../../content/kingdom/invasions.ts";
import { moveUnrest } from "./unrest.ts";
import type { BattleResult, BattleSide, BattleSpec, FieldedSquad, SpecSquad } from "../layers.ts";
import type { World } from "../world.ts";
import { findRoute, setRoute, type Route } from "./graph.ts";
import type { KingdomOrder, KingdomOrderBody } from "./orders.ts";
import type { Army, Contact, ContactHow, ContactSide, Holding, Mover } from "./state.ts";
import { armyById, armyMen, inContact, removeArmy, standsIn, takeMen } from "./armies.ts";
import { adjustLegitimacy } from "./ledger.ts";
import { battleLostUnrest } from "./morale.ts";
import { ARMY_MORALE, CLAIM_UNREST, STORMED_UNREST } from "../../content/kingdom/morale.ts";
import { builtFortification } from "./economy.ts";
export { builtFortification };
import { routeOptions, updateSight } from "./explore.ts";
import { autoResolve } from "./autoresolve.ts";
import type { KingdomWorld } from "./world.ts";

type ResolveOrder = Extract<KingdomOrderBody, { kind: "resolveContact" }>;

// -- who is whose enemy -------------------------------------------------------------------

/** Do these two factions fight on sight? One serves the crown and the other does not. */
export function hostile(a: number, b: number): boolean {
  const fa = FACTIONS[FACTION_IDS[a]];
  const fb = FACTIONS[FACTION_IDS[b]];
  return !!fa && !!fb && fa.crown !== fb.crown;
}

/** Is this army in the contact that waits? Its orders are refused until it is settled. */
export function inWaitingContact(world: KingdomWorld, army: number): boolean {
  const c = world.contact;
  return !!c && army !== 0 && (c.sides[0].army === army || c.sides[1].army === army);
}

/**
 * The strongest wall STANDING in a holding: what an assault meets and a
 * siege is fought behind. K10: walls battered down to WALLS_DOWN are rubble
 * until mended, and stand for nothing.
 */
export function fortificationOf(h: Holding): Fortification {
  if (h.walls >= WALLS_DOWN) return "none";
  return builtFortification(h);
}

function factionOf(h: Holding): number {
  return h.owner === null ? -1 : FACTION_IDS.indexOf(h.owner);
}

/** Would an army of `faction` coming here meet hostile walls? (Marches stop there, as at an unfound site.) */
export function walledHostile(world: KingdomWorld, faction: number, holding: number): boolean {
  const h = world.holding(holding);
  if (!h) return false;
  const owner = factionOf(h);
  return owner >= 0 && hostile(owner, faction) && fortificationOf(h) !== "none";
}

// -- contact --------------------------------------------------------------------------------

/** Miles along `m`'s road from holding `end` (one of its two ends). */
function alongFrom(world: KingdomWorld, m: Mover, end: number): number {
  const r = world.graph.roads.get(m.road);
  if (!r) return 0;
  return m.from === end ? m.along : r.length - m.along;
}

/**
 * Are two armies in contact (PLAN.md §B.9: "on the same edge/node")? Both in
 * one holding; or no more than ENGAGE_RADIUS apart by road, along one road or
 * through the holding where their two roads meet. Also when one is chasing
 * the other and has caught it by the intercept's own reach (armies.ts
 * inContact, straight-line), so an interception always becomes a contact and
 * never leaves the chaser halted beside its quarry with nothing happening.
 */
export function engaged(world: KingdomWorld, a: Army, b: Army): boolean {
  const ma = a.mover;
  const mb = b.mover;
  if ((a.target === b.id || b.target === a.id) && inContact(world, a, b)) return true;
  if (ma.road === 0 && mb.road === 0) return ma.node === mb.node;
  if (ma.road !== 0 && mb.road === ma.road) {
    const r = world.graph.roads.get(ma.road);
    if (!r) return false;
    return abs(alongFrom(world, ma, r.a) - alongFrom(world, mb, r.a)) <= ENGAGE_RADIUS;
  }
  // Through a holding both touch: a node one stands in, or an end both roads share.
  for (const n of endsOf(ma)) {
    if (!endsOf(mb).includes(n)) continue;
    if (milesTo(world, ma, n) + milesTo(world, mb, n) <= ENGAGE_RADIUS) return true;
  }
  return false;
}

/** The holdings a mover touches: the one it stands in, or the two ends of its road (ascending). */
function endsOf(m: Mover): number[] {
  if (m.road === 0) return [m.node];
  return m.from < m.to ? [m.from, m.to] : [m.to, m.from];
}

/** Miles by road from a mover to a holding it touches. */
function milesTo(world: KingdomWorld, m: Mover, n: number): number {
  return m.road === 0 ? 0 : alongFrom(world, m, n);
}

/** Is a disengaged pair still too close to forget? (b < 0 is a holding's walls, by -id.) */
function stillEngaged(world: KingdomWorld, a: number, b: number): boolean {
  const x = armyById(world, a);
  if (!x) return false;
  if (b < 0) return standsIn(x.mover) === -b;
  const y = armyById(world, b);
  return !!y && engaged(world, x, y);
}

function isDisengaged(world: KingdomWorld, a: number, b: number): boolean {
  for (const [x, y] of world.disengaged) if (x === a && y === b) return true;
  return false;
}

function disengage(world: KingdomWorld, a: number, b: number): void {
  if (a === 0) return;
  const [x, y] = b < 0 || a < b ? [a, b] : [b, a];
  if (isDisengaged(world, x, y)) return;
  world.disengaged.push([x, y]);
  // Canonical order: by first id, then second, so the hash and the save never see arrival order.
  world.disengaged.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

/**
 * Find this tick's contacts and open them, in army-id order. Called by
 * KingdomWorld.tick after the armies march; `marching` holds the armies that
 * were on the road this tick (an army that moved into another is the
 * attacker).
 */
export function detectContacts(world: KingdomWorld, marching: ReadonlySet<number>): void {
  // Forget the disengaged pairs that have stood apart.
  for (let i = world.disengaged.length - 1; i >= 0; i--) {
    const [a, b] = world.disengaged[i];
    if (!stillEngaged(world, a, b)) world.disengaged.splice(i, 1);
  }
  // Snapshot: an auto-resolved meeting can take an army off the list.
  const list = [...world.armies];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!world.armies.includes(a)) continue;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (!world.armies.includes(b) || !world.armies.includes(a)) continue;
      if (!hostile(a.owner, b.owner) || isDisengaged(world, a.id, b.id)) continue;
      if (inWaitingContact(world, a.id) || inWaitingContact(world, b.id)) continue;
      if (!engaged(world, a, b)) continue;
      const aMoved = marching.has(a.id);
      const bMoved = marching.has(b.id);
      openContact(world, "field", a, b, bMoved && !aMoved ? 1 : 0);
    }
  }
  // Walls with nobody but their townsmen behind them.
  for (const a of [...world.armies]) {
    if (!world.armies.includes(a) || inWaitingContact(world, a.id)) continue;
    const at = standsIn(a.mover);
    if (at === 0 || !walledHostile(world, a.owner, at) || isDisengaged(world, a.id, -at)) continue;
    const h = world.holding(at) as Holding;
    const owner = factionOf(h);
    // An army of the owner's standing there defends them: that is a field contact, found above.
    if (world.armies.some((b) => b.owner === owner && standsIn(b.mover) === at)) continue;
    openAssault(world, a, h);
  }
}

/** Where on its road a contact between these two is, as the holding to fight at and the road (0 at a holding). */
function placeOf(world: KingdomWorld, a: Army, b: Army): { holding: number; road: number } {
  const ma = a.mover;
  const mb = b.mover;
  if (ma.road === 0) return { holding: ma.node, road: mb.road };
  if (mb.road === 0) return { holding: mb.node, road: ma.road };
  const r = world.graph.roads.get(ma.road);
  if (!r) return { holding: ma.from, road: ma.road };
  if (mb.road === ma.road) {
    // Both on one road: the end nearer the middle of the two (ties: road.a, the lower id).
    const mid = (alongFrom(world, ma, r.a) + alongFrom(world, mb, r.a)) / 2;
    return { holding: mid <= r.length / 2 ? r.a : r.b, road: r.id };
  }
  // On two roads: the holding they share (the lower, if two), else the nearer end of the first army's road.
  for (const n of endsOf(ma)) if (endsOf(mb).includes(n)) return { holding: n, road: ma.road };
  return { holding: alongFrom(world, ma, r.a) <= r.length / 2 ? r.a : r.b, road: ma.road };
}

function halt(a: Army): void {
  a.mover.route = [];
  a.target = 0;
  a.mergeInto = false;
}

function openContact(world: KingdomWorld, kind: "field", a: Army, b: Army, attackerIsB: number): void {
  // The king's side is always sides[0] (the battle's player 0, the seat a person takes).
  const swap = b.owner === KING_PLAYER;
  const first = swap ? b : a;
  const second = swap ? a : b;
  const attacker = swap ? 1 - attackerIsB : attackerIsB;
  const place = placeOf(world, a, b);
  const sides: [ContactSide, ContactSide] = [
    { faction: first.owner, army: first.id },
    { faction: second.owner, army: second.id },
  ];
  open(world, { id: 0, kind, sides, attacker, holding: place.holding, road: place.road, tick: world.now });
}

function openAssault(world: KingdomWorld, a: Army, h: Holding): void {
  const owner = factionOf(h);
  const kingDefends = owner === KING_PLAYER;
  const sides: [ContactSide, ContactSide] = kingDefends
    ? [{ faction: owner, army: 0 }, { faction: a.owner, army: a.id }]
    : [{ faction: a.owner, army: a.id }, { faction: owner, army: 0 }];
  open(world, { id: 0, kind: "assault", sides, attacker: kingDefends ? 1 : 0, holding: h.id, road: 0, tick: world.now });
}

function open(world: KingdomWorld, draft: Contact): void {
  const player = draft.sides[0].faction === KING_PLAYER;
  // One waiting contact at a time: a second meeting of the king's side is found again once this one is settled.
  if (player && world.contact) return;
  const c: Contact = { ...draft, id: world.nextId++ };
  for (const s of c.sides) {
    const army = armyById(world, s.army);
    if (army) halt(army);
  }
  if (world.king.army !== 0) {
    const k = armyById(world, world.king.army);
    if (k) world.king.mover = { ...k.mover, route: [] };
  }
  world.events.push({ kind: "contact", contact: c.id, player });
  if (player) {
    world.contact = c;
    return;
  }
  // Two of the machine's sides: settled now, without anyone watching.
  const spec = buildBattleSpec(world, c);
  const result = autoResolve(spec, world.rng.autoresolve, false);
  applyBattleResult(world, c, spec, result, "auto");
}

// -- the spec --------------------------------------------------------------------------------

/** The townsmen a walled holding with no army of its owner's puts on its walls. */
export function militiaSquads(h: Holding, fort: Fortification): SpecSquad[] {
  const n = MILITIA_SQUADS[fort];
  if (n === 0) return [];
  const full = UNIT_TYPES[MILITIA_UNIT].soldiers;
  let men = min(n * full, floor(h.population / MILITIA_PEOPLE_PER_MAN));
  const out: SpecSquad[] = [];
  for (let i = 0; i < n && men > 0; i++) {
    const take = min(full, men - floor((men * (n - i - 1)) / (n - i)));
    out.push({ squad: 0, unit: MILITIA_UNIT, men: take, wounded: 0 });
    men -= take;
  }
  return out;
}

function sideOf(world: KingdomWorld, s: ContactSide, h: Holding, fort: Fortification, enc: EncounterDef | null): BattleSide {
  const fid = FACTION_IDS[s.faction];
  const f = FACTIONS[fid];
  // K9: a story encounter is fought against ITS captain at ITS difficulty (encounters.ts).
  const commander = s.faction === KING_PLAYER ? null : enc ? enc.commander : FACTION_BATTLE_COMMANDER[fid];
  const difficulty = s.faction !== KING_PLAYER && enc ? enc.difficulty : FACTION_BATTLE_DIFFICULTY[fid];
  const a = armyById(world, s.army);
  if (!a) {
    return {
      faction: s.faction, army: 0, name: DESCENT_REFUSAL.townsmenOf(h.name), doctrine: "defensive", commander, difficulty,
      abilities: [], morale: MILITIA_MORALE, squads: militiaSquads(h, fort),
    };
  }
  return {
    faction: s.faction,
    army: a.id,
    name: s.faction === KING_PLAYER ? a.name : a.name + " of " + f.name,
    doctrine: a.doctrine,
    commander,
    difficulty,
    // K9: what the story taught the king's armies comes with every one of them (B.4: kingdom-earned).
    abilities: s.faction === KING_PLAYER ? [...a.abilities, ...storyAbilities(world).filter((x) => !a.abilities.includes(x))] : [...a.abilities],
    morale: a.morale,
    squads: a.squads.map((q) => ({ squad: q.id, unit: q.unit, men: q.men, wounded: q.wounded })),
  };
}

/**
 * The battle a contact is fought as, from kingdom state alone. Pure: the same
 * world and contact always build the same spec (hashBattleSpec).
 */
export function buildBattleSpec(world: KingdomWorld, c: Contact): BattleSpec {
  const h = world.holding(c.holding) as Holding;
  const biome = BIOMES[h.biome];
  // K9: a story encounter is fought on its own battlefield (validated to fight like the holding's country).
  const enc = encounterFor(world, c);
  const levelId = enc ? enc.levelId : biome.level;
  const level = levelById(levelId);
  const defender = 1 - c.attacker;
  const dArmy = armyById(world, c.sides[defender].army);
  // K8: walls are a battle effect for an army too, when it defends a walled
  // holding of its own lord's from inside it (PLAN §B.8). A K5-K7 realm keeps
  // K5's rule (walls only for the townsmen), so its battles are unchanged.
  // K10: so does a story host holding its own walled holding (the Chancery
  // Guard in Rimaros): the capital siege is fought behind the capital's walls.
  // And an army standing in its walled holding is behind those walls however
  // the contact was drawn -- also when the attacker was met on the road in,
  // a contact-radius short of the gate (docs/PROVISIONAL.md K10.7).
  const atHome = !!dArmy && (world.captains || isStoryHost(world, dArmy.id)) &&
    standsIn(dArmy.mover) === h.id && h.owner === FACTION_IDS[dArmy.owner];
  // K10: the townsmen who fell back to the keep are besieged in it.
  const fort: Fortification = c.keep ? "keep" : c.kind === "assault" || atHome ? fortificationOf(h) : "none";
  const night = level?.night;
  const sides: [BattleSide, BattleSide] = [sideOf(world, c.sides[0], h, fort, enc), sideOf(world, c.sides[1], h, fort, enc)];
  return {
    contact: c.id,
    // The holding's own seed: the same place always yields the same ground (docs/kingdom.md, K1).
    seed: h.seed,
    terrain: { level: levelId, biome: h.biome, holding: h.id, road: c.road, fortification: fort, worn: fort === "none" ? 0 : h.walls },
    sides,
    deployment: {
      attacker: c.attacker,
      // Dug in (K5), or lying in wait (K8's ambush): either way it chose the ground and is ready.
      ambush: !!dArmy && ((dArmy.posture === "hold" && dArmy.postureDays >= HOLD_DIG_IN_DAYS) || dArmy.posture === "ambush"),
    },
    // K10: behind walls it is a siege -- the defender wins by holding out,
    // the attacker by breaking the garrison or getting enough men inside the
    // walls (the battle's breakthrough rule, its exit the heart of the works).
    // In the field, by breaking the other.
    victory: fort !== "none"
      ? { mode: "breakthrough", attacker: c.attacker, exit: 0, required: stormMen(sides[c.attacker]) }
      : { mode: "rout" },
    duration: level ? level.duration : 900,
    weather: world.weather,
    season: world.date.season,
    sightScale: night === undefined ? 1 : night,
    reinforcements: [],
  };
}

/** K10: men of the attacking side that must stand inside the walls at once to take them (SIEGE_STORM). */
export function stormMen(side: BattleSide): number {
  let fit = 0;
  for (const q of side.squads) fit += q.men - q.wounded;
  return max(1, min(SIEGE_STORM.maxMen, floor((fit + SIEGE_STORM.share - 1) / SIEGE_STORM.share)));
}

// -- reading a battle back -------------------------------------------------------------------

/** A soldier's nerve (0..1) back to kingdom morale (0..100); the inverse of nerveFromMorale. */
export function moraleFromNerve(nerve: number): number {
  const m = round(((nerve - NERVE_FLOOR) * 100) / (1 - NERVE_FLOOR));
  return m < 0 ? 0 : m > 100 ? 100 : m;
}

/**
 * What a battle World did, as a BattleResult. `fielded` says which soldiers
 * were each spec squad's (app/battle-config.ts `battleWorld` spawned them
 * contiguously); `leftBy` is the side whose commander took it off the field
 * mid-battle (docs/PROVISIONAL.md K5.6), or null for a battle fought out.
 */
export function resultFromBattle(
  spec: BattleSpec, world: World, fielded: readonly (readonly FieldedSquad[])[], leftBy: number | null = null,
): BattleResult {
  const s = world.soldiers;
  const winner = leftBy !== null ? 1 - leftBy : world.outcome ? world.outcome.winner : -1;
  const squads: [{ squad: number; men: number; wounded: number }[], { squad: number; men: number; wounded: number }[]] = [[], []];
  const morale: [number, number] = [spec.sides[0].morale, spec.sides[1].morale];
  for (let side = 0; side < 2; side++) {
    let fieldedMen = 0;
    spec.sides[side].squads.forEach((q, j) => {
      const f = fielded[side]?.[j];
      let alive = 0;
      let hurt = 0;
      if (f) {
        for (let i = f.first; i < f.first + f.count; i++) {
          if (s.alive[i] !== 1) continue;
          alive++;
          if (s.hp[i] < s.maxHp[i] * WOUNDED_HP_FRACTION) hurt++;
        }
        fieldedMen += f.count;
      }
      // The wounded never took the field; they come back with whoever is left.
      squads[side].push({ squad: q.squad, men: alive + q.wounded, wounded: q.wounded + hurt });
    });
    if (fieldedMen > 0) morale[side] = moraleFromNerve(world.armyMorale(side));
  }
  const king = spec.sides[0].faction === KING_PLAYER;
  return {
    contact: spec.contact,
    winner,
    squads,
    morale,
    fled: [winner === 1, winner === 0],
    left: [leftBy === 0, leftBy === 1],
    // K10: what the battle did to the works, over what they carried in.
    damage: { crops: 0, buildings: 0, walls: spec.terrain.fortification === "none" ? 0 : max(0, world.wallDamage() - spec.terrain.worn) },
    legitimacy: !king ? 0 : winner === 0 ? WIN_LEGITIMACY : winner === 1 ? -LOSS_LEGITIMACY : 0,
  };
}

/** Why a result cannot be the result of this spec, or null. Every field is checked: a result may come from a save. */
export function resultRefusal(spec: BattleSpec, r: BattleResult): string | null {
  if (r.contact !== spec.contact) return DESCENT_REFUSAL.wrongBattle;
  if (r.winner !== -1 && r.winner !== 0 && r.winner !== 1) return DESCENT_REFUSAL.badResult;
  for (let i = 0; i < 2; i++) {
    const want = spec.sides[i].squads;
    const got = r.squads[i];
    if (!got || got.length !== want.length) return DESCENT_REFUSAL.badResult;
    for (let j = 0; j < want.length; j++) {
      const q = got[j];
      if (q.squad !== want[j].squad || q.men < 0 || q.men > want[j].men || q.wounded < 0 || q.wounded > q.men) {
        return DESCENT_REFUSAL.badResult;
      }
      if (!Number.isInteger(q.men) || !Number.isInteger(q.wounded)) return DESCENT_REFUSAL.badResult;
    }
    const m = r.morale[i];
    if (!Number.isInteger(m) || m < 0 || m > 100) return DESCENT_REFUSAL.badResult;
  }
  if (!Number.isInteger(r.damage.crops) || r.damage.crops < 0 || !Number.isInteger(r.damage.buildings) || r.damage.buildings < 0) {
    return DESCENT_REFUSAL.badResult;
  }
  // K10: walls are battered only where there are walls, and never past rubble.
  const w = r.damage.walls;
  if (!Number.isInteger(w) || w < 0 || w > WALLS_DOWN - spec.terrain.worn || (spec.terrain.fortification === "none" && w !== 0)) {
    return DESCENT_REFUSAL.badResult;
  }
  if (!Number.isInteger(r.legitimacy)) return DESCENT_REFUSAL.badResult;
  return null;
}

// -- falling back -----------------------------------------------------------------------------

/** Is a hostile army of `faction`'s standing in this holding? */
function hostileStanding(world: KingdomWorld, faction: number, holding: number): boolean {
  return world.armies.some((b) => hostile(b.owner, faction) && standsIn(b.mover) === holding);
}

/**
 * Where an army falls back to, away from `enemy` (an army, or 0 for a
 * holding's walls): on a road, to the end the enemy is not at; in a holding,
 * along any road the enemy is not on. Never into a holding a hostile army
 * stands in or behind hostile walls, and only by roads the side knows. Ties:
 * a holding of its own, then the shortest road, then the lowest id. Returns 0
 * when there is nowhere to go: the army is cut off.
 */
export function retreatTarget(world: KingdomWorld, a: Army, enemy: number): { to: number; route: Route } | null {
  const m = a.mover;
  const e = armyById(world, enemy);
  const opts = routeOptions(world, a.owner);
  const cands: { to: number; road: number }[] = [];
  if (m.road !== 0) {
    const r = world.graph.roads.get(m.road);
    if (!r) return null;
    let away = m.from;
    if (e) {
      // How far along this road from our `from` end the enemy is; ahead of us, we turn back.
      const ea = e.mover.road === m.road ? alongFrom(world, e.mover, m.from)
        : e.mover.road === 0 && e.mover.node === m.to ? r.length : 0;
      away = ea > m.along ? m.from : m.to;
    }
    cands.push({ to: away, road: r.id });
  } else {
    for (const [next, road] of world.graph.links.get(m.node) ?? []) {
      if (e && e.mover.road === road) continue;
      cands.push({ to: next, road });
    }
  }
  let best: { to: number; route: Route; own: boolean; len: number } | null = null;
  for (const c of cands) {
    if (hostileStanding(world, a.owner, c.to) || walledHostile(world, a.owner, c.to)) continue;
    const route = findRoute(world.graph, m, c.to, opts);
    if (!route) continue;
    const h = world.holding(c.to) as Holding;
    const own = h.owner === FACTION_IDS[a.owner];
    const len = world.graph.roads.get(c.road)?.length ?? 0;
    const better = !best || (own !== best.own ? own : len !== best.len ? len < best.len : c.to < best.to);
    if (better) best = { to: c.to, route, own, len };
  }
  return best ? { to: best.to, route: best.route } : null;
}

/** Men a withdrawal leaves behind as its rearguard: a per-mille share, at least one. */
export function rearguardOf(a: Army): number {
  const men = armyMen(a);
  return men === 0 ? 0 : min(men, max(1, floor((men * WITHDRAW_REARGUARD_PERMILLE) / 1000)));
}

/** Fall back from `enemy`, or be taken if cut off. Returns false if the army was taken. */
function fallBack(world: KingdomWorld, a: Army, enemy: number): boolean {
  const back = retreatTarget(world, a, enemy);
  if (!back) {
    removeArmy(world, a, "captured");
    return false;
  }
  setRoute(world.graph, a.mover, back.route);
  a.posture = "none";
  a.postureDays = 0;
  world.events.push({ kind: "fellBack", army: a.id, to: back.to });
  return true;
}

/**
 * K10: a holding whose walls have fallen to `enemy` is given up by every
 * other army of `faction` still standing in it, in id order: each falls back
 * along a road away from the enemy, or is taken if cut off. A siege is
 * fought against one army (the first a contact found); the rest of the
 * garrison does not hold walls the king's men are already inside
 * (docs/PROVISIONAL.md K10.8).
 */
export function abandonHolding(world: KingdomWorld, h: Holding, faction: number, enemy: number): void {
  for (const a of [...world.armies]) {
    if (a.owner !== faction || standsIn(a.mover) !== h.id || !world.armies.includes(a)) continue;
    fallBack(world, a, enemy);
  }
}

// -- settling ---------------------------------------------------------------------------------

function otherArmy(c: Contact, side: number): number {
  return c.sides[1 - side].army;
}

/** The pair to keep apart after settling: two armies, or an army and the walls it came to (-holding id). */
function pairOf(c: Contact): [number, number] {
  const [a, b] = c.sides;
  if (a.army === 0) return [b.army, -c.holding];
  if (b.army === 0) return [a.army, -c.holding];
  return [a.army, b.army];
}

/**
 * Take a battle's result back into the kingdom: survivors (never more than
 * were there), morale, the side that quit the field falls back (or is taken
 * if cut off), an army with nobody left is gone, walls taken change hands,
 * the king's legitimacy moves, the ground fought over is harmed. Pure and
 * deterministic; every loop in contact-side order, then squad-id order.
 */
export function applyBattleResult(
  world: KingdomWorld, c: Contact, spec: BattleSpec, r: BattleResult, how: "fight" | "auto" | "keep",
): void {
  const h = world.holding(c.holding) as Holding;
  for (let i = 0; i < 2; i++) {
    const side = c.sides[i];
    const a = armyById(world, side.army);
    if (a) {
      for (const q of a.squads) {
        const got = r.squads[i].find((x) => x.squad === q.id);
        if (!got) continue;
        q.men = min(q.men, got.men);
        q.wounded = min(q.men, got.wounded);
      }
      a.morale = r.morale[i];
      // Taken off the field mid-battle: the rearguard is paid on top (docs/PROVISIONAL.md K5.6).
      if (r.left[i]) takeMen(a, rearguardOf(a), () => true, false);
      a.squads = a.squads.filter((q) => q.men > 0);
    } else if (side.army === 0) {
      // The townsmen who did not come back were the holding's people.
      let before = 0;
      let after = 0;
      for (const q of spec.sides[i].squads) before += q.men;
      for (const q of r.squads[i]) after += q.men;
      h.population = max(0, h.population - (before - after));
    }
  }
  const kingE = world.economy[KING_PLAYER];
  const book = world.books[KING_PLAYER];
  if (r.legitimacy > 0) adjustLegitimacy(kingE, book, r.legitimacy, "deeds");
  else if (r.legitimacy < 0) adjustLegitimacy(kingE, book, r.legitimacy, "disgrace");
  if (r.legitimacy !== 0) world.events.push({ kind: "stocksChanged", faction: KING_PLAYER });
  // K6: a victory lifts the winner's spirits on top of what the field left
  // them (recent victories, PLAN §B.6); a defeat of the king's side stirs the
  // town it was fought at and his others of that province (lost battles).
  if (r.winner === 0 || r.winner === 1) {
    const w = armyById(world, c.sides[r.winner].army);
    if (w) w.morale = min(100, w.morale + ARMY_MORALE.win);
    const kingSide = c.sides[0].faction === KING_PLAYER ? 0 : c.sides[1].faction === KING_PLAYER ? 1 : -1;
    if (kingSide >= 0 && r.winner !== kingSide) battleLostUnrest(world, h.id);
  }
  if (r.damage.crops > 0) {
    for (const p of h.plots) {
      if (p.stage !== "sown" && p.stage !== "growing" && p.stage !== "ripe") continue;
      p.health = max(0, p.health - r.damage.crops);
      if (p.health === 0) {
        p.stage = "spoiled";
        p.days = 0;
        p.lost = "trampled";
        world.events.push({ kind: "plotStage", holding: h.id, plot: p.id, stage: "spoiled", cause: "trampled" });
      }
    }
  }
  // K10: the walls carry the battle's battering until they are mended.
  if (r.damage.walls > 0) {
    h.walls = min(WALLS_DOWN, h.walls + r.damage.walls);
    h.mend = min(h.mend, h.walls);
    world.events.push({ kind: "wallsDamaged", holding: h.id, by: r.damage.walls, walls: h.walls });
  }
  // K10: the siege of a keep the townsmen fell back to: did it hold?
  if (c.keep) world.events.push({ kind: "siege", holding: h.id, held: r.winner !== c.attacker });
  if (r.damage.buildings > 0) {
    let n = r.damage.buildings;
    for (let s = 0; s < h.buildings.length && n > 0; s++) {
      if (h.buildings[s] !== null && h.works[s] === 0 && !h.idle[s]) { h.idle[s] = true; n--; }
    }
  }
  // Who is gone, and who falls back.
  for (let i = 0; i < 2; i++) {
    const a = armyById(world, c.sides[i].army);
    if (!a) continue;
    if (a.squads.length === 0) { removeArmy(world, a, "fell"); continue; }
    if (r.fled[i]) fallBack(world, a, otherArmy(c, i));
  }
  // Walls stormed: the townsmen lost, and the holding is the attacker's.
  if (c.kind === "assault") {
    const d = 1 - c.attacker;
    if (c.sides[d].army === 0 && r.winner === c.attacker && armyById(world, c.sides[c.attacker].army)) {
      h.owner = FACTION_IDS[c.sides[c.attacker].faction];
      h.garrison = [];
      // K6: a town taken by storm does not love its new lord.
      h.unrest = STORMED_UNREST;
      h.festival = 0;
      world.events.push({ kind: "stormed", holding: h.id, faction: c.sides[c.attacker].faction });
      world.events.push({ kind: "claimed", holding: h.id, faction: c.sides[c.attacker].faction });
    }
  }
  settled(world, c, how, r.winner);
}

function settled(world: KingdomWorld, c: Contact, how: ContactHow, winner: number): void {
  const [x, y] = pairOf(c);
  if (armyById(world, x)) disengage(world, x, y);
  if (world.contact && world.contact.id === c.id) world.contact = null;
  // The king rides where his army rides: a fall back moved it (armies.ts keeps him there on the march).
  const k = armyById(world, world.king.army);
  if (k) world.king.mover = { ...k.mover, route: [...k.mover.route] };
  world.events.push({ kind: "contactResolved", contact: c.id, how, winner });
  const fs = [c.sides[0].faction, c.sides[1].faction].sort((p, q) => p - q);
  for (const f of fs) updateSight(world, f);
}

/** Why `resolveContact` would be refused now, or null. The interstitial's buttons ask this, and the tick asks it again. */
export function checkContactOrder(world: KingdomWorld, body: ResolveOrder, player: number): string | null {
  const c = world.contact;
  if (!c || c.id !== body.contact) return DESCENT_REFUSAL.noContact;
  if (player !== KING_PLAYER || c.sides[0].faction !== KING_PLAYER) return DESCENT_REFUSAL.notYours;
  if (body.choice === "fight") {
    if (!body.result) return DESCENT_REFUSAL.fightNeedsResult;
    return resultRefusal(buildBattleSpec(world, c), body.result);
  }
  if (body.result) return DESCENT_REFUSAL.resultOnlyFought;
  // K8, the defender's choices at its own walls (KD-05): townsmen alone behind them may open the gates or fall back to the keep.
  if (body.choice === "yield" || body.choice === "keep") {
    if (c.kind !== "assault" || c.sides[0].army !== 0) return INVASION_REFUSAL.yieldOnlyWalls;
    const h = world.holding(c.holding) as Holding;
    // K10: once in the keep, there is no further keep to fall back to (the gates may still be opened).
    if (body.choice === "keep" && c.keep) return INVASION_REFUSAL.inKeep(h.name);
    if (body.choice === "keep" && !KEEP_RETREAT.needs.includes(fortificationOf(h))) return INVASION_REFUSAL.noKeep(h.name);
    return null;
  }
  if (body.choice === "withdraw") {
    const a = armyById(world, c.sides[0].army);
    if (!a) return DESCENT_REFUSAL.townsmenStay;
    if (!retreatTarget(world, a, c.sides[1].army)) return DESCENT_REFUSAL.cutOff;
  }
  return null;
}

/** Apply `resolveContact`. Returns the refusal, or null if applied. */
export function applyContactOrder(world: KingdomWorld, order: KingdomOrder & ResolveOrder): string | null {
  const why = checkContactOrder(world, order, order.player);
  if (why) return why;
  const c = world.contact as Contact;
  if (order.choice === "withdraw") {
    const a = armyById(world, c.sides[0].army) as Army;
    takeMen(a, rearguardOf(a), () => true, false);
    a.squads = a.squads.filter((q) => q.men > 0);
    a.morale = max(0, a.morale - WITHDRAW_MORALE);
    if (a.squads.length === 0) removeArmy(world, a, "fell");
    else fallBack(world, a, c.sides[1].army);
    settled(world, c, "withdraw", -1);
    return null;
  }
  if (order.choice === "yield") {
    yieldHolding(world, c);
    return null;
  }
  if (order.choice === "keep") {
    keepSiege(world, c);
    return null;
  }
  const spec = buildBattleSpec(world, c);
  if (order.choice === "fight") {
    applyBattleResult(world, c, spec, order.result as BattleResult, "fight");
    return null;
  }
  // "Resolve for me": a sergeant fights it, worse than the king would (autoresolve.ts).
  applyBattleResult(world, c, spec, autoResolve(spec, world.rng.autoresolve, true), "auto");
  return null;
}

/**
 * The townsmen open the gates: the holding is the attacker's, no one dies,
 * and the king's name suffers for a town given up without a fight.
 */
function yieldHolding(world: KingdomWorld, c: Contact): void {
  const h = world.holding(c.holding) as Holding;
  const by = c.sides[c.attacker].faction;
  h.owner = FACTION_IDS[by];
  h.garrison = [];
  h.unrest = CLAIM_UNREST;
  h.festival = 0;
  const e = world.economy[KING_PLAYER];
  adjustLegitimacy(e, world.books[KING_PLAYER], -YIELD_LEGITIMACY, "disgrace");
  world.events.push({ kind: "stocksChanged", faction: KING_PLAYER });
  world.events.push({ kind: "yielded", holding: h.id, faction: by });
  world.events.push({ kind: "claimed", holding: h.id, faction: by });
  settled(world, c, "yield", c.attacker);
}

/**
 * Retreat to the keep: the town outside is given up and sacked (its crops
 * lost, its people restless) and the keep is besieged. K10 makes that a real
 * siege (lifting K8.9's scope cut): the contact goes on waiting, marked
 * `keep`, and its battle is now a siege of the keep -- two courses of stone
 * round the townsmen (`buildBattleSpec` gives it the keep), fought or
 * resolved like any other battle. If the keep falls, the holding is the
 * attacker's, as by storm.
 */
function keepSiege(world: KingdomWorld, c: Contact): void {
  const h = world.holding(c.holding) as Holding;
  for (const p of h.plots) {
    if (p.stage !== "sown" && p.stage !== "growing" && p.stage !== "ripe") continue;
    p.stage = "spoiled";
    p.days = 0;
    p.lost = "burned";
    world.events.push({ kind: "plotStage", holding: h.id, plot: p.id, stage: "spoiled", cause: "burned" });
  }
  moveUnrest(world, h, KEEP_RETREAT.unrest);
  world.contact = { ...c, keep: true };
  world.events.push({ kind: "keepRetreat", holding: h.id });
}

/** For the interstitial: the men a withdrawal would cost now, or -1 if the army is cut off (or is townsmen). */
export function withdrawalCost(world: KingdomWorld): number {
  const c = world.contact;
  if (!c) return -1;
  const a = armyById(world, c.sides[0].army);
  if (!a || !retreatTarget(world, a, c.sides[1].army)) return -1;
  return rearguardOf(a);
}

/** The point on the map a contact happened at, in miles: where the camera comes back to. */
export function contactPoint(world: KingdomWorld, c: Contact): { x: number; y: number } {
  const a = armyById(world, c.sides[0].army) ?? armyById(world, c.sides[1].army);
  if (a && a.mover.road !== 0) {
    const r = world.graph.roads.get(a.mover.road);
    const from = world.holding(a.mover.from);
    const to = world.holding(a.mover.to);
    if (r && from && to) {
      const t = a.mover.along / r.length;
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    }
  }
  const h = world.holding(c.holding) as Holding;
  return { x: h.x, y: h.y };
}
