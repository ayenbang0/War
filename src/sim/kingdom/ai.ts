/**
 * K8: the captains' strategic AI (PLAN.md §B.8).
 *
 * One mind per faction with a persona (the usurper, the Margrave and the
 * eight captains), in a realm with captains (KingdomConfig.captains). Once a
 * day, at the tick's K8 hook, each in faction order:
 *
 *   1. remember -- what it can SEE today (explore.ts knowledge 2) goes into
 *      its memory of the map (FactionIntel): who holds each holding, how many
 *      men stand in it, what walls it has. Nothing else is ever written there.
 *   2. perceive -- a Perception is built from its memory, the hostile armies
 *      it can see now (armies.ts armyVisible), its own armies, holdings and
 *      stores, and the static map. Nothing else of the world goes in.
 *   3. decide -- a pure function of the Perception, its mind (the goal it
 *      holds) and the draws it takes on its own stream (`kingdomAi`) returns
 *      KingdomOrders and its next mind. It never sees the world.
 *   4. The orders go through the SAME queue as the king's, checked by the
 *      same world.check, applied by the same applyOrder, under the same
 *      economy and supply: wages, bread, recruiting costs, hunger.
 *
 * That split is the "may only act on what it has seen" guarantee:
 * tools/kingdom-ai.ts changes what a captain cannot see and asserts that its
 * Perception, and so its orders, do not change.
 *
 * Replay: the AI runs inside the tick from sim state and its own stream, so
 * a replay of the king's log reproduces every order it gave, as the battle
 * AI's are (src/sim/ai.ts). Its orders are therefore not logged: they are
 * stamped seq 0 (a logged order's seq is >= 1) and the tick leaves them out
 * of world.log.
 *
 * The posture comes from the persona's bias and boldness (the same numbers
 * that drive its battle AI, content/commanders.ts) plus a goal: raid,
 * besiege, consolidate, snipe the weakest -- and explore its own country.
 * Goals are weighed every AI.goalDays with a little jitter and hysteresis.
 */

import { ceil, floor, sqrt } from "../math.ts";
import type { Rng } from "../rng.ts";
import { FACTIONS, FACTION_IDS, KING_PLAYER } from "../../content/kingdom/factions.ts";
import { FORTIFICATIONS, MILITIA_SQUADS, AUTORESOLVE } from "../../content/kingdom/descent.ts";
import { UNIT_TYPES, type UnitTypeId } from "../../content/unit-types.ts";
import { CROPS, CROP_IDS, type CropId } from "../../content/kingdom/crops.ts";
import { STOCK_IDS, type StockId } from "../../content/kingdom/economy.ts";
import { KNOW_SEEN } from "../../content/kingdom/exploration.ts";
import { AI, AI_RECRUIT, INVASION_WAVES, WAVE_DAYS } from "../../content/kingdom/invasions.ts";
import { ARMY_MILES_PER_DAY, MAX_ARMIES_PER_SIDE } from "../../content/kingdom/armies.ts";
import type { Season } from "../../content/kingdom/terrain.ts";
import { calendar } from "./clock.ts";
import type { KingdomOrder, KingdomOrderBody } from "./orders.ts";
import type { AiGoal, AiMind, Army, FactionIntel, PlotStage } from "./state.ts";
import { AI_GOALS } from "./state.ts";
import { armyMen, armyVisible, hasBarracks, recruitCost, standsIn } from "./armies.ts";
import { fortificationOf, hostile, inWaitingContact } from "./descent.ts";
import { choiceCost, eventOf, holdingKnowledge, isUnfoundSite, pendingFinds } from "./explore.ts";
import { canAfford } from "./ledger.ts";
import { seedCost } from "./economy.ts";
import { aiFactions, seatOf } from "./invasions.ts";
import type { KingdomWorld } from "./world.ts";

// -- what a faction knows --------------------------------------------------------------------

/** A hostile army the faction can see now. */
export type SeenArmy = {
  readonly id: number;
  readonly owner: number;
  /** Holding it stands in, or 0 on a road. */
  readonly at: number;
  readonly x: number;
  readonly y: number;
  readonly men: number;
  readonly power: number;
};

export type OwnArmy = {
  readonly id: number;
  readonly at: number;
  /** Where it is marching (the last holding of its route), or 0. */
  readonly bound: number;
  /** The army it is chasing, or 0. */
  readonly chasing: number;
  readonly x: number;
  readonly y: number;
  readonly men: number;
  readonly power: number;
  readonly supply: number;
  /** Days it has gone short of bread (0: fed). */
  readonly hunger: number;
  /** Stands as a garrison (it is not sent anywhere). */
  readonly garrison: boolean;
  /** Free company or in a contact: not the steward's to order. */
  readonly busy: boolean;
};

export type OwnHolding = {
  readonly id: number;
  readonly barracks: boolean;
  readonly garrison: number;
  readonly garrisonSlots: number;
  /** Its plots: what stage each is at, and for one that can be sown now, the crop and its seed grain. */
  readonly plots: readonly { readonly id: number; readonly stage: PlotStage; readonly crop: CropId | null; readonly seed: number }[];
};

/** A letter waiting for a choice: what each choice costs, and whether it is a gamble. */
export type PendingFind = {
  readonly site: number;
  readonly choices: readonly { readonly affordable: boolean; readonly gamble: boolean }[];
};

/** Static: the map as everyone knows it (positions, provinces, who held what at the start). */
export type Place = {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly province: string;
  readonly mapOwner: number;
};

/**
 * Everything decide() may read. Built by perceive() from the faction's own
 * state, its memory, what it sees now, and the static map. Plain data, so a
 * test can compare two of them.
 */
export type Perception = {
  readonly faction: number;
  readonly day: number;
  readonly season: Season;
  readonly seat: number;
  readonly provinces: readonly string[];
  readonly stocks: Readonly<Record<StockId, number>>;
  readonly armyCount: number;
  readonly own: readonly OwnArmy[];
  readonly holdings: readonly OwnHolding[];
  readonly enemies: readonly SeenArmy[];
  readonly intel: FactionIntel;
  readonly finds: readonly PendingFind[];
  /** Sites in its own provinces it has not set foot in. */
  readonly unfound: readonly number[];
  /** Story waves due for this faction and not yet ridden (INVASION_WAVES indices). */
  readonly wavesDue: readonly number[];
  /** The holding the exile was last heard of at (the map's start): common talk, not sight. */
  readonly exile: number;
};

function power(squads: readonly { unit: UnitTypeId; men: number; wounded: number }[], morale: number): number {
  let p = 0;
  for (const q of squads) {
    const u = UNIT_TYPES[q.unit];
    p += (q.men - q.wounded) * (u.cost / u.soldiers);
  }
  return p * (0.5 + morale / 200);
}

function armyPoint(world: KingdomWorld, a: Army): { x: number; y: number } {
  // A holding's own coordinates, or the nearer end of the road it is on: an
  // AI weighs distance in straight miles and needs no interpolation.
  const m = a.mover;
  const h = world.holding(m.road === 0 ? m.node : m.along * 2 < (world.graph.roads.get(m.road)?.length ?? 0) ? m.from : m.to);
  return h ? { x: h.x, y: h.y } : { x: 0, y: 0 };
}

/**
 * Write what the faction sees today into its memory. The only reader of the
 * world for anything hostile: only holdings it SEES are written -- and, of
 * the rest, only the owner of a holding that is or was its own (it hears of
 * its own towns lost or won back; it learns nothing else of them unseen).
 */
export function remember(world: KingdomWorld, f: number): void {
  const intel = world.intel[f];
  if (intel.owner.length === 0) return;
  const day = calendar(world.now).day;
  const fid = FACTION_IDS[f];
  world.holdings.forEach((h, i) => {
    if (holdingKnowledge(world, f, h.id) !== KNOW_SEEN) {
      // A lord hears of his own: a town of his that rose, or was taken, is news that reaches him
      // whether or not he can see it (who holds it now; not how many men stand in it).
      const mine = h.owner === fid;
      if (mine !== (intel.owner[i] === f)) intel.owner[i] = h.owner === null ? -1 : FACTION_IDS.indexOf(h.owner);
      return;
    }
    let men = 0;
    for (const a of world.armies) if (a.mover.road === 0 && a.mover.node === h.id && armyVisible(world, f, a)) men += armyMen(a);
    intel.owner[i] = h.owner === null ? -1 : FACTION_IDS.indexOf(h.owner);
    intel.men[i] = men;
    intel.walls[i] = FORTIFICATIONS.indexOf(fortificationOf(h));
    intel.seen[i] = day;
  });
}

/** The faction's Perception: its own state, its memory, its sight, the static map. */
export function perceive(world: KingdomWorld, f: number): Perception {
  const fid = FACTION_IDS[f];
  const d = calendar(world.now);
  const garrisoned = new Set<number>();
  for (const h of world.holdings) if (h.owner === fid) for (const g of h.garrison) garrisoned.add(g);
  const own: OwnArmy[] = [];
  const enemies: SeenArmy[] = [];
  for (const a of world.armies) {
    const p = armyPoint(world, a);
    if (a.owner === f) {
      own.push({
        id: a.id, at: standsIn(a.mover), bound: a.mover.route.length > 0 ? a.mover.route[a.mover.route.length - 1] : 0,
        chasing: a.target, x: p.x, y: p.y, men: armyMen(a), power: power(a.squads, a.morale), supply: a.supply, hunger: a.hunger,
        garrison: garrisoned.has(a.id), busy: a.company > 0 || inWaitingContact(world, a.id),
      });
    } else if (hostile(a.owner, f) && armyVisible(world, f, a)) {
      enemies.push({ id: a.id, owner: a.owner, at: standsIn(a.mover), x: p.x, y: p.y, men: armyMen(a), power: power(a.squads, a.morale) });
    }
  }
  const holdings: OwnHolding[] = world.holdings.filter((h) => h.owner === fid).map((h) => ({
    id: h.id, barracks: hasBarracks(h), garrison: h.garrison.length, garrisonSlots: h.garrisonSlots,
    plots: h.plots.map((p) => {
      // Only a crop that can be sown this season and will not be killed by the winter it would stand in.
      const crop = CROP_IDS.find((c) => CROPS[c].sow.includes(d.season) && !CROPS[c].regrowDays && (CROPS[c].hardy || d.season !== "autumn")) ?? null;
      return { id: p.id, stage: p.stage, crop, seed: crop ? seedCost(CROPS[crop], h).grain ?? 0 : 0 };
    }),
  }));
  const e = world.economy[f];
  const finds: PendingFind[] = pendingFinds(world, f).map((fd) => {
    const def = eventOf(fd);
    return {
      site: fd.site,
      choices: (def ? def.choices : []).map((c) => ({ affordable: canAfford(e, choiceCost(c.effects)), gamble: !!c.chance })),
    };
  });
  const provinces = world.map.provinces.filter((p) => p.governors.includes(fid)).map((p) => p.id);
  const unfound = world.holdings.filter((h) => provinces.includes(h.province) && isUnfoundSite(world, f, h.id)).map((h) => h.id);
  const stocks = {} as Record<StockId, number>;
  for (const s of STOCK_IDS) stocks[s] = e.stocks[s];
  const wavesDue: number[] = [];
  INVASION_WAVES.forEach((w, i) => { if (w.faction === fid && !world.wavesRode[i] && d.day >= w.day) wavesDue.push(i); });
  const intel = world.intel[f];
  return {
    faction: f, day: d.day, season: d.season, seat: seatOf(world, f), provinces, stocks,
    armyCount: own.length, own, holdings, enemies,
    intel: { owner: [...intel.owner], men: [...intel.men], walls: [...intel.walls], seen: [...intel.seen] },
    finds, unfound, wavesDue, exile: world.holdingByKey(world.map.start)?.id ?? 0,
  };
}

// -- deciding -------------------------------------------------------------------------------

export type Decision = { readonly orders: KingdomOrderBody[]; readonly mind: AiMind; readonly rode: number };

/** The static map: built once per world (it never changes). */
export function placesOf(world: KingdomWorld): Place[] {
  return world.holdings.map((h) => {
    const def = world.map.holdings.find((x) => x.key === h.key);
    return { id: h.id, x: h.x, y: h.y, province: h.province, mapOwner: def && def.owner !== null ? FACTION_IDS.indexOf(def.owner) : -1 };
  });
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** A holding's defence as the faction remembers it: the men it saw there, and its walls' townsmen, behind those walls. */
function knownDefence(p: Perception, i: number): number {
  const fort = FORTIFICATIONS[p.intel.walls[i]] ?? "none";
  return (p.intel.men[i] + MILITIA_SQUADS[fort] * AI.militiaGuess) * AUTORESOLVE.walls[fort];
}

/** Idx of a holding id in the intel arrays (ids 1..H in map order). */
function idx(places: readonly Place[], id: number): number {
  return id - places[0].id;
}

/**
 * Decide the day. Pure: the Perception, the mind and the draws are all it
 * reads. Takes exactly AI_GOALS.length draws on a day it weighs its goal,
 * none on any other, so a captain who thinks does not move another's dice.
 */
export function decide(p: Perception, mind: AiMind, places: readonly Place[], rng: Rng): Decision {
  const f = p.faction;
  const persona = FACTIONS[FACTION_IDS[f]].persona;
  const out: KingdomOrderBody[] = [];
  if (!persona) return { orders: out, mind, rode: -1 };
  const seatPlace = places.find((x) => x.id === p.seat);
  const home = seatPlace ?? (p.holdings.length > 0 ? places[idx(places, p.holdings[0].id)] : null);

  // -- the steward: letters, fields, the barracks ------------------------------------
  for (const fd of p.finds) {
    const bold = persona.boldness >= 1;
    let pick = fd.choices.findIndex((c) => c.affordable && c.gamble === bold);
    if (pick < 0) pick = fd.choices.findIndex((c) => c.affordable);
    if (pick >= 0) out.push({ kind: "resolveEvent", site: fd.site, choice: pick });
  }
  // Seed is sown only out of grain beyond what the armies need for AI.marchBreadDays.
  let allMen = 0;
  for (const a of p.own) allMen += a.men;
  let spare = p.stocks.grain - allMen * AI.marchBreadDays;
  for (const h of p.holdings) {
    for (const pl of h.plots) {
      if (pl.stage === "ripe") out.push({ kind: "harvest", plot: pl.id });
      else if ((pl.stage === "empty" || pl.stage === "harvested" || pl.stage === "spoiled") && pl.crop && pl.seed <= spare) {
        out.push({ kind: "sow", plot: pl.id, crop: pl.crop });
        spare -= pl.seed;
      }
    }
  }
  const field = p.own.filter((a) => !a.garrison && !a.busy);
  let fieldMen = 0;
  for (const a of field) fieldMen += a.men;
  const seatH = p.holdings.find((h) => h.id === p.seat);
  if (seatH && seatH.barracks && fieldMen < AI.fieldMen && p.stocks.grain >= allMen * AI.recruitBreadDays) {
    const at = field.find((a) => a.at === p.seat && a.bound === 0);
    for (const unit of AI_RECRUIT) {
      const c = recruitCost(unit, false, p.stocks.levy);
      if (p.stocks.levy < c.levy || p.stocks.coin < c.coin + AI.reserveCoin || p.stocks.iron < c.iron) continue;
      if (!at && p.armyCount >= MAX_ARMIES_PER_SIDE) break;
      out.push({ kind: "recruit", at: p.seat, army: at ? at.id : 0, unit, levy: false });
      break;
    }
  }
  // Too many mouths: a field army at home is stood down (its men go back to the levy, its packs to the stores).
  if (home && p.stocks.grain < allMen * AI.disbandBreadDays) {
    const idle = field.filter((a) => a.at === home.id && a.bound === 0 && a.chasing === 0);
    if (idle.length > 0) out.push({ kind: "disband", army: idle.reduce((x, y) => (y.men < x.men ? y : x)).id });
  }
  // An empty seat: the field army standing in it becomes its garrison.
  if (seatH && seatH.garrison === 0) {
    const at = field.find((a) => a.at === p.seat && a.bound === 0);
    if (at) out.push({ kind: "garrison", army: at.id });
  }

  // -- the goal ---------------------------------------------------------------------------
  let next: AiMind = mind;
  let rode = -1;
  let fieldPower = 0;
  for (const a of field) fieldPower += a.power;
  const kingKnown: number[] = [];
  p.intel.owner.forEach((o, i) => { if (o === KING_PLAYER) kingKnown.push(i); });
  const reach2 = AI.reachMiles * AI.reachMiles;
  const near = (i: number): boolean => !home || dist2(places[i], home) <= reach2;
  const against = p.day >= AI.graceDays;
  // A holding the field hosts can take, as the faction remembers it: men against men (its memory
  // counts heads, not quality), with the margin a careful captain wants.
  const weak = (i: number): boolean => knownDefence(p, i) * AI.margin <= fieldMen;

  if (p.wavesDue.length > 0 && field.length > 0) {
    // A story wave: the king's nearest holding it knows of, else the Reach, where the exile was last heard of.
    rode = p.wavesDue[0];
    const target = nearestKing(p, places, kingKnown.filter(weak), home);
    next = { goal: target.walled ? "besiege" : "raid", target: target.id, since: p.day, wave: rode, rides: 0 };
  } else if (mind.wave >= 0) {
    // A wave keeps its goal for WAVE_DAYS, going for the nearest of the king's holdings it knows
    // and can take, and retargeting as it learns more. It ends when its time is up or its host is
    // gone; when every holding of the king's it knows of is too strong for it (it has seen the
    // garrisons: the invasion is repelled); or when it has looked where it was going and found
    // nothing of the king's anywhere.
    const ti = idx(places, mind.target);
    const open = kingKnown.filter(weak);
    const looked = p.intel.seen[ti] >= mind.since;
    const kings = p.intel.owner[ti] === KING_PLAYER;
    const over = p.day - mind.since >= WAVE_DAYS || field.length === 0;
    if (over || (kingKnown.length > 0 && open.length === 0) || (looked && !kings && open.length === 0)) {
      next = { goal: "consolidate", target: 0, since: p.day, wave: -1, rides: mind.rides };
    } else if (open.length > 0 && !(kings && weak(ti))) {
      const t = nearestKing(p, places, open, home);
      next = { ...mind, goal: t.walled ? "besiege" : "raid", target: t.id };
    }
  } else if (p.day - mind.since >= AI.goalDays || !targetStands(p, mind, places)) {
    next = weigh(p, mind, places, rng, field, fieldPower, fieldMen, kingKnown, near, against);
  }

  // -- acting on it ---------------------------------------------------------------------------
  // A host going hungry out in the country (its packs empty and the land not feeding it) turns
  // for home, whatever the goal: the same hunger that thins the king's armies thins the captain's.
  // A hungry army is then left out of every goal below, so two orders never pull it two ways
  // on alternate days (the "state flicker" the game-ai skill warns of: it marched home one day
  // and back out the next, and starved on the road between).
  const hungry = (a: OwnArmy): boolean => !!home && a.at !== home.id && a.hunger >= AI.homeHungerDays;
  const ordered = new Set<number>();
  const go = (a: OwnArmy, to: number): void => {
    ordered.add(a.id);
    if (a.at !== to && a.bound !== to) out.push({ kind: "marchArmy", army: a.id, to });
  };
  for (const a of field) if (hungry(a) && home) go(a, home.id);
  const fed = field.filter((a) => !hungry(a));
  const host = strongest(fed);
  // The lord rides with the host he sends at a holding (his stores with it, as the king's ride
  // with his), and stays with it until it is home again: a host left in the field when its goal
  // ends must still be fed on the way back (docs/PROVISIONAL.md K8.5).
  const sends = (next.goal === "raid" || next.goal === "besiege" || next.goal === "consolidate") && !!host && next.target !== 0;
  let riding = sends && host ? host.id : 0;
  if (riding === 0 && mind.rides !== 0 && home) {
    const r = p.own.find((a) => a.id === mind.rides);
    if (r && r.at !== home.id) riding = r.id;
  }
  if (riding !== next.rides) next = { ...next, rides: riding };
  // Bread for the road, reckoned from the straight miles (the map is common knowledge) at the
  // base pace: a host the lord rides with eats from the stores and its packs one way; a scout
  // carries its own bread there and back.
  const tripDays = (a: OwnArmy, to: number): number => {
    const t = places[idx(places, to)];
    return t ? ceil(sqrt(dist2(a, t)) / ARMY_MILES_PER_DAY) : 0;
  };
  // A story wave rides on what it has (the story sends it; it forages and lives off the stores).
  const bread = (a: OwnArmy, to: number): boolean =>
    p.stocks.grain + a.supply >= a.men * (AI.marchBreadDays + (next.wave >= 0 ? 0 : tripDays(a, to)));
  const packs = (a: OwnArmy, to: number): boolean => a.supply >= a.men * (2 * tripDays(a, to) + 2);
  switch (next.goal) {
    case "raid":
    case "besiege":
    case "consolidate":
      if (host && next.target && (host.bound === next.target || bread(host, next.target))) go(host, next.target);
      break;
    case "snipe":
      if (host && next.target) {
        ordered.add(host.id);
        if (host.chasing !== next.target) out.push({ kind: "intercept", army: host.id, target: next.target });
      }
      break;
    case "explore": {
      const scout = fed.length > 0 ? fed.reduce((x, y) => (y.men < x.men ? y : x)) : null;
      if (scout && next.target && (scout.bound === next.target || packs(scout, next.target))) go(scout, next.target);
      break;
    }
  }
  // Every other field army goes home: one left out in the country (a goal that ended, a chase
  // that lost its quarry, a march halted on the road) would otherwise stand there for ever.
  if (home) for (const a of fed) if (!ordered.has(a.id) && a.at !== home.id) go(a, home.id);
  return { orders: out, mind: next, rode };
}

function strongest(field: readonly OwnArmy[]): OwnArmy | null {
  let best: OwnArmy | null = null;
  for (const a of field) if (!best || a.power > best.power) best = a;
  return best;
}

/** The king's nearest holding the faction knows of (by its memory), or the exile's last-heard place. */
function nearestKing(p: Perception, places: readonly Place[], known: readonly number[], home: Place | null): { id: number; walled: boolean } {
  let best = -1;
  for (const i of known) if (best < 0 || (home && dist2(places[i], home) < dist2(places[best], home))) best = i;
  if (best < 0) return { id: p.exile, walled: false };
  return { id: places[best].id, walled: p.intel.walls[best] > 0 };
}

/** Is the goal's target still what it was taken up for (as the faction knows)? */
function targetStands(p: Perception, mind: AiMind, places: readonly Place[]): boolean {
  if (mind.target === 0) return true;
  if (mind.goal === "snipe") return p.enemies.some((e) => e.id === mind.target);
  const i = idx(places, mind.target);
  if (mind.goal === "explore") return p.unfound.includes(mind.target);
  if (mind.goal === "consolidate") return p.intel.owner[i] !== p.faction;
  return p.intel.owner[i] >= 0 && hostile(p.intel.owner[i], p.faction);
}

/** Weigh the goals and take the best, with jitter (AI_GOALS.length draws, always) and hysteresis. */
function weigh(
  p: Perception, mind: AiMind, places: readonly Place[], rng: Rng, field: readonly OwnArmy[], fieldPower: number, fieldMen: number,
  kingKnown: readonly number[], near: (i: number) => boolean, against: boolean,
): AiMind {
  const persona = FACTIONS[FACTION_IDS[p.faction]].persona as NonNullable<(typeof FACTIONS)["king"]["persona"]>;
  const b = persona.bias;
  const score: Record<AiGoal, number> = { consolidate: 0, raid: 0, besiege: 0, snipe: 0, explore: 0 };
  const target: Record<AiGoal, number> = { consolidate: 0, raid: 0, besiege: 0, snipe: 0, explore: 0 };
  const home = places.find((x) => x.id === p.seat) ?? null;
  const closer = (i: number, j: number): boolean => !home || dist2(places[i], home) < dist2(places[j], home);

  // Consolidate: threats seen near its holdings, and its own country lost (to take back).
  let threats = 0;
  for (const e of p.enemies) {
    for (const h of p.holdings) if (dist2(e, places[idx(places, h.id)]) <= 60 * 60) { threats++; break; }
  }
  let lost = -1;
  places.forEach((pl, i) => {
    if (pl.mapOwner !== p.faction || p.intel.owner[i] === p.faction || !p.provinces.includes(pl.province)) return;
    if (knownDefence(p, i) * AI.margin > fieldMen) return;
    if (lost < 0 || closer(i, lost)) lost = i;
  });
  score.consolidate = b.defensive * (1 + threats + (lost >= 0 ? 1 : 0));
  target.consolidate = lost >= 0 ? places[lost].id : 0;

  // Raid and besiege: only the king's holdings are anyone's to take, and not before the grace is out.
  // An emergent invasion needs the king seen holding enough to be worth it, and a thin garrison.
  if (against && kingKnown.length >= AI.emergentMinKingHoldings && field.length > 0) {
    let raid = -1;
    let siege = -1;
    for (const i of kingKnown) {
      if (!near(i) || p.intel.men[i] >= AI.thinGarrisonMen) continue;
      if (knownDefence(p, i) * AI.margin > fieldMen) continue;
      if (p.intel.walls[i] === 0) { if (raid < 0 || closer(i, raid)) raid = i; }
      else if (siege < 0 || closer(i, siege)) siege = i;
    }
    if (raid >= 0) { score.raid = b.aggressive * persona.boldness; target.raid = places[raid].id; }
    if (siege >= 0) { score.besiege = b.aggressive * persona.boldness * 0.8; target.besiege = places[siege].id; }
  }

  // Snipe the weakest: a hostile army it can see and outmatch. The king's are not fair game before the grace.
  let weakest: (typeof p.enemies)[number] | null = null;
  for (const e of p.enemies) {
    if (e.owner === KING_PLAYER && !against) continue;
    if (e.power * AI.margin > fieldPower) continue;
    if (home && dist2(e, home) > AI.reachMiles * AI.reachMiles) continue;
    if (!weakest || e.power < weakest.power || (e.power === weakest.power && e.id < weakest.id)) weakest = e;
  }
  if (weakest) { score.snipe = ((b.maneuver + b.reactive) / 2) * persona.boldness; target.snipe = weakest.id; }

  // Explore its own country.
  let site = -1;
  for (const id of p.unfound) {
    const i = idx(places, id);
    if (home && dist2(places[i], home) > AI.exploreMiles * AI.exploreMiles) continue;
    if (site < 0 || closer(i, site)) site = i;
  }
  if (site >= 0 && field.length > 0) { score.explore = 0.4 * b.maneuver; target.explore = places[site].id; }

  let best: AiGoal = "consolidate";
  let bestScore = -1;
  for (const g of AI_GOALS) {
    const jitter = 100 + rng.int(AI.jitterPct + 1);
    let s = (score[g] * jitter) / 100;
    if (g === mind.goal) s *= AI.keepGoal;
    if ((g === "consolidate" || target[g] !== 0) && s > bestScore) { best = g; bestScore = s; }
  }
  return { goal: best, target: target[best], since: p.day, wave: -1, rides: 0 };
}

// -- the hook ---------------------------------------------------------------------------------

/**
 * Every AI faction's day, in faction order: remember, perceive, decide, and
 * queue the orders that pass the same check the king's do. Called by the
 * tick on the first tick of a day, before the day's orders are drained.
 */
export function runAi(world: KingdomWorld): void {
  world.aiOrders = [];
  if (!world.captains) return;
  const places = world.places();
  for (const f of aiFactions()) {
    remember(world, f);
    const seen = perceive(world, f);
    const d = decide(seen, world.minds[f], places, world.rng.kingdomAi);
    world.minds[f] = d.mind;
    if (d.rode >= 0) {
      world.wavesRode[d.rode] = true;
      world.events.push({ kind: "waveRode", faction: f, wave: d.rode });
    }
    // The audit hook (tests only): the Perception and the orders, before any is applied.
    world.onAi?.(f, seen, d.orders);
    for (const body of d.orders) {
      if (world.check(body, f) !== null) continue;
      // seq 0: the AI's, regenerated by a replay, never logged (see the file comment).
      const order: KingdomOrder = { ...body, tick: world.now, player: f, seq: 0 };
      world.submit(order);
      world.aiOrders.push(order);
    }
  }
}

/** For the soak: men of a faction's field armies (not garrisons). */
export function fieldStrength(world: KingdomWorld, f: number): number {
  let n = 0;
  const g = new Set<number>();
  for (const h of world.holdings) for (const x of h.garrison) g.add(x);
  for (const a of world.armies) if (a.owner === f && !g.has(a.id)) n += armyMen(a);
  return floor(n);
}
