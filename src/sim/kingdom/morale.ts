/**
 * Morale, unrest and legitimacy (PLAN.md §B.6, phase K6): the three nested
 * morale systems of the kingdom layer, and the realm's Mercy/Terror (§A.4).
 *
 *   1. ARMY MORALE -- moved once a day by pay, bread, the king's presence,
 *      the realm's standing and its terror; raised by a victory; below a
 *      floor, men slip away. It is what K5's BattleSpec fields as a side's
 *      starting nerve (descent.ts sideOf -> content nerveFromMorale), so a
 *      hungry, unpaid army fights the next battle shaken: the layers are
 *      coupled, not merely sequential.
 *   2. REGIONAL UNREST -- per holding, in permille, pushed every day by the
 *      causes of content/kingdom/morale.ts (taxes, famine, soldiers
 *      quartered unpaid, the king's standing, custom; calmed by shrines,
 *      halls, justice, festivals, mercy); and by what happens to it -- each
 *      day an army lives off its fields (armies.ts), the season's muster
 *      (economy.ts), a lost battle (descent.ts), a pardon. At RESTLESS_AT a town pays half its
 *      taxes; at REVOLT_AT it revolts.
 *   3. REALM LEGITIMACY -- through the ledger's one entry point (deeds /
 *      disgrace): shrines and halls each season, a festival, a battle (K5),
 *      a revolt.
 *
 * ONE CAUSE LIST. `unrestCauses` is the single function that says what moves
 * a town's unrest and by how much; the day applies its sum and the politics
 * card lists its rows. So the card never shows a cause the sim does not
 * apply, or the reverse -- the same "one check" rule as KingdomWorld.check.
 *
 * Pure and deterministic like the rest of src/sim/kingdom/: holdings and
 * armies in id order, whole numbers with stored remainders, no random draw
 * at all (a revolt happens at a threshold, not on a roll), every stock
 * through ledger.ts.
 */

import { floor, max, min } from "../math.ts";
import { FACTIONS, FACTION_IDS, KING_PLAYER, type FactionId } from "../../content/kingdom/factions.ts";
import { BUILDINGS } from "../../content/kingdom/buildings.ts";
import { MAX_ARMIES_PER_SIDE, LEVY_TYPES } from "../../content/kingdom/armies.ts";
import {
  ARMY_MORALE, CUSTOM_UNREST, FAMINE_UNREST, FESTIVAL, JUSTICE, JUSTICE_IDS,
  LEGITIMACY_UNREST, LOST_BATTLE_UNREST, MERCY_CALM_PER, MERCY_MAX, MERCY_MIN, PARDON, QUARTERED_UNREST,
  RESTLESS_AT, REVOLT, REVOLT_AT, SEASON_LEGITIMACY_CAP, SHRINE_UNREST_SCALE, TAX_UNREST,
  type UnrestCauseId,
} from "../../content/kingdom/morale.ts";
import { MORALE_REFUSAL } from "../../content/kingdom/morale-strings.ts";
import { REFUSAL } from "../../content/kingdom/ui-strings.ts";
import { UNIT_TYPES } from "../../content/unit-types.ts";
import { DAYS_PER_SEASON } from "./clock.ts";
import type { KingdomOrder, KingdomOrderBody } from "./orders.ts";
import type { Army, Holding } from "./state.ts";
import { adjustLegitimacy, canAfford, debit, pay, snapshotStocks } from "./ledger.ts";
import { economyActive, ownedBy, standing } from "./economy.ts";
import { armiesOf, armyMen, armyWounded, perMille, raiseArmy, removeArmy, standsIn, takeMen } from "./armies.ts";
import { updateSight } from "./explore.ts";
import { moveUnrest } from "./unrest.ts";
import type { KingdomWorld } from "./world.ts";

export type MoraleOrderBody = Extract<KingdomOrderBody, { kind: "setJustice" | "holdFestival" | "pardon" }>;

// -- queries (the politics card, the HUD and the tests read these) ---------------------

/** One row of what moves a town's unrest: a cause and its pressure today, in permille a day. */
export type UnrestCause = { readonly cause: UnrestCauseId; readonly permille: number };

/** Is this holding's unrest reckoned: does its lord's economy run (the king's, until K8)? */
export function unrestReckoned(world: KingdomWorld, h: Holding): boolean {
  if (h.owner === null) return false;
  return economyActive(world, FACTION_IDS.indexOf(h.owner));
}

/** Past the lesser threshold: the holding pays half its taxes (economy.ts collectTaxes). */
export function isRestless(h: Holding): boolean {
  return h.unrest >= RESTLESS_AT;
}

/**
 * The absolute season a day is in, counted from the spring of year 1 (so the
 * exile's first autumn is 2), for "once a season". From the calendar, not
 * from the days since the start, so it turns with the seasons even in a realm
 * whose epoch is not a season's first day (a converted old save: ECON.9).
 */
export function seasonIndex(world: KingdomWorld): number {
  return floor(world.date.absoluteDay / DAYS_PER_SEASON);
}

/** Armies of the holding's lord standing in it unpaid or hungry: they live on the townsfolk. */
export function quartered(world: KingdomWorld, h: Holding): Army[] {
  if (h.owner === null) return [];
  const f = FACTION_IDS.indexOf(h.owner);
  return world.armies.filter((a) => a.owner === f && standsIn(a.mover) === h.id && (a.unpaid > 0 || a.hunger > 0));
}

/** Would the courts sit today: justice is courts and the coin is there to pay them. */
export function courtsSit(world: KingdomWorld, h: Holding): boolean {
  if (h.justice !== "courts" || h.owner === null) return false;
  return world.economy[FACTION_IDS.indexOf(h.owner)].stocks.coin >= JUSTICE.courts.coin;
}

/**
 * Every cause moving this holding's unrest today, with its pressure in
 * permille a day, in UNREST_CAUSE_IDS order; causes that are 0 today are
 * left out. `courts` says whether the courts sit (the day passes what it
 * paid for; the card asks whether they could). The ONE list: runMoraleDay
 * applies its sum, the politics card shows its rows.
 */
export function unrestCauses(world: KingdomWorld, h: Holding, courts: boolean = courtsSit(world, h)): UnrestCause[] {
  if (!unrestReckoned(world, h)) return [];
  const f = FACTION_IDS.indexOf(h.owner as FactionId);
  const e = world.economy[f];
  const out: UnrestCause[] = [];
  const add = (cause: UnrestCauseId, permille: number): void => {
    if (permille !== 0) out.push({ cause, permille });
  };
  add("tax", TAX_UNREST[h.tax]);
  add("famine", h.famine > 0 ? FAMINE_UNREST : 0);
  add("quartering", QUARTERED_UNREST * quartered(world, h).length);
  add("legitimacy", e.legitimacy < LEGITIMACY_UNREST.lowBelow ? LEGITIMACY_UNREST.low
    : e.legitimacy >= LEGITIMACY_UNREST.highFrom ? LEGITIMACY_UNREST.high : 0);
  add("custom", h.unrest > 0 ? CUSTOM_UNREST : 0);
  let shrine = 0;
  let hall = 0;
  for (const s of standing(h)) {
    if (h.idle[s.slot]) continue;
    const u = (s.def.later.unrest ?? 0) * SHRINE_UNREST_SCALE;
    if (s.def.id === "hall") hall += u;
    else shrine += u;
  }
  add("shrine", shrine);
  add("hall", hall);
  add("justice", h.justice === "courts" ? (courts ? JUSTICE.courts.unrest : 0) : JUSTICE[h.justice].unrest);
  add("festival", h.festival > 0 ? FESTIVAL.unrestPerDay : 0);
  add("mercy", e.mercy > 0 ? -floor(e.mercy / MERCY_CALM_PER) : 0);
  return out;
}

/** The sum of today's causes: how far unrest will move at the next day boundary. */
export function unrestTrend(world: KingdomWorld, h: Holding): number {
  let n = 0;
  for (const c of unrestCauses(world, h)) n += c.permille;
  return n;
}

/** What a festival here costs: coin and grain by the town's people. */
export function festivalCost(h: Holding): { coin: number; grain: number } {
  return {
    coin: max(FESTIVAL.minCoin, floor(h.population / FESTIVAL.peoplePerCoin)),
    grain: max(FESTIVAL.minGrain, floor(h.population / FESTIVAL.peoplePerGrain)),
  };
}

/** The level an army's morale settles toward while it is fed and paid (content ARMY_MORALE). */
export function armyRestMorale(world: KingdomWorld, a: Army): number {
  const e = world.economy[a.owner];
  let rest = ARMY_MORALE.rest + floor(e.legitimacy / ARMY_MORALE.legitimacyPer);
  if (world.king.army === a.id) rest += ARMY_MORALE.king;
  if (e.mercy < 0) rest += floor(-e.mercy / ARMY_MORALE.terrorPer);
  return rest > 100 ? 100 : rest;
}

// -- the entry points the other rules use ------------------------------------------------

/** Move a holding's unrest by `delta` permille, kept in 0..UNREST_MAX; says when it changes band. */
export function addUnrest(world: KingdomWorld, h: Holding, delta: number): void {
  if (unrestReckoned(world, h)) moveUnrest(world, h, delta);
}

/** THE entry point for Mercy/Terror (the levers here; K9's story choices). Returns the change made after clamping. */
export function changeMercy(world: KingdomWorld, faction: number, delta: number): number {
  if (!Number.isInteger(delta)) throw new Error("morale: mercy moves in whole points");
  const e = world.economy[faction];
  const next = e.mercy + delta < MERCY_MIN ? MERCY_MIN : e.mercy + delta > MERCY_MAX ? MERCY_MAX : e.mercy + delta;
  const moved = next - e.mercy;
  if (moved === 0) return 0;
  e.mercy = next;
  world.events.push({ kind: "mercyChanged", faction, mercy: next, delta: moved });
  return moved;
}

/**
 * A battle the king's side lost at `holding` (descent.ts applyBattleResult):
 * the town it was fought at, if his, and his other towns of that province
 * hear of it.
 */
export function battleLostUnrest(world: KingdomWorld, holding: number): void {
  const at = world.holding(holding);
  if (!at) return;
  for (const h of world.holdings) {
    if (h.owner !== "king") continue;
    if (h.id === at.id) addUnrest(world, h, LOST_BATTLE_UNREST.here);
    else if (h.province === at.province) addUnrest(world, h, LOST_BATTLE_UNREST.province);
  }
}

// -- orders: one check for the button and the sim ------------------------------------------

export function isMoraleOrder(b: KingdomOrderBody): b is MoraleOrderBody {
  return b.kind === "setJustice" || b.kind === "holdFestival" || b.kind === "pardon";
}

/** Why a politics order would be refused now, or null. The politics card asks this; so does the tick. */
export function checkMoraleOrder(world: KingdomWorld, body: MoraleOrderBody, player: number): string | null {
  if (player < 0 || player >= FACTION_IDS.length) return REFUSAL.noSuchFaction;
  const h = world.holding(body.holding);
  if (!h) return REFUSAL.noSuchHolding;
  if (h.owner !== FACTION_IDS[player]) return REFUSAL.notYours;
  if (!economyActive(world, player)) return REFUSAL.onlyKing;
  const e = world.economy[player];
  switch (body.kind) {
    case "setJustice":
      if (!(JUSTICE_IDS as readonly string[]).includes(body.justice)) return MORALE_REFUSAL.noSuchJustice;
      return h.justice === body.justice ? MORALE_REFUSAL.sameJustice : null;
    case "holdFestival": {
      if (h.festival > 0) return MORALE_REFUSAL.festivalRunning(h.festival);
      const c = festivalCost(h);
      return canAfford(e, c) ? null : MORALE_REFUSAL.festivalCost(c);
    }
    case "pardon":
      if (h.pardoned === seasonIndex(world) + 1) return MORALE_REFUSAL.pardonedThisSeason;
      if (h.unrest === 0) return MORALE_REFUSAL.nothingToPardon;
      return null;
  }
}

/** Apply a politics order. Returns the refusal, or null if applied. */
export function applyMoraleOrder(world: KingdomWorld, order: KingdomOrder & MoraleOrderBody): string | null {
  const why = checkMoraleOrder(world, order, order.player);
  if (why) return why;
  const f = order.player;
  const h = world.holding(order.holding) as Holding;
  switch (order.kind) {
    case "setJustice":
      h.justice = order.justice;
      world.events.push({ kind: "justiceSet", holding: h.id, justice: h.justice });
      return null;
    case "holdFestival": {
      const e = world.economy[f];
      const book = world.books[f];
      pay(e, book, festivalCost(h), "festivals");
      adjustLegitimacy(e, book, FESTIVAL.legitimacy, "deeds");
      h.festival = FESTIVAL.days;
      world.events.push({ kind: "festivalHeld", holding: h.id, days: FESTIVAL.days });
      world.events.push({ kind: "stocksChanged", faction: f });
      return null;
    }
    case "pardon":
      addUnrest(world, h, PARDON.unrest);
      changeMercy(world, f, PARDON.mercy);
      h.pardoned = seasonIndex(world) + 1;
      world.events.push({ kind: "pardoned", holding: h.id });
      return null;
  }
}

// -- the day ---------------------------------------------------------------------------------

/** Whose banner a town that throws off the king raises: its old lord's from the map, else the Chancellor's. */
export function rebelFaction(world: KingdomWorld, h: Holding): number {
  // K8: a crown town that throws off its captain rises for no lord: its
  // commons (factions.ts), whom the captain must come and put down.
  if (world.captains && h.owner !== null && FACTIONS[h.owner].crown) return FACTION_IDS.indexOf("commons");
  const def = world.map.holdings.find((d) => d.key === h.key);
  const old = def?.owner ?? null;
  return FACTION_IDS.indexOf(old !== null && old !== "king" ? old : "usurper");
}

/**
 * The holding throws off its lord: it is nobody's, its young men take up the
 * crown's banner as a rebel host standing in it (if it has the people and the
 * crown has room for another army), and its lord's legitimacy falls.
 */
function revolt(world: KingdomWorld, h: Holding, f: number): void {
  const rf = rebelFaction(world, h);
  const unit = LEVY_TYPES[0];
  const full = UNIT_TYPES[unit].soldiers;
  const rebels = min(REVOLT.maxSquads * full, floor(h.population / REVOLT.peoplePerRebel));
  h.owner = null;
  h.garrison = [];
  h.unrest = REVOLT.after;
  h.festival = 0;
  h.famine = 0;
  let army = 0;
  if (rebels >= REVOLT.minRebels && armiesOf(world, rf).length < MAX_ARMIES_PER_SIDE) {
    const n = rebels > full ? 2 : 1;
    const a = raiseArmy(world, rf, h.id, new Array(n).fill(unit));
    // Spread the rebels over the squads, the first taking any odd man.
    let left = rebels;
    a.squads.forEach((q, i) => {
      const take = i === a.squads.length - 1 ? left : left - floor(left / 2);
      q.men = take;
      left -= take;
    });
    a.morale = REVOLT.morale;
    a.posture = "hold";
    h.population -= rebels;
    army = a.id;
  }
  adjustLegitimacy(world.economy[f], world.books[f], -REVOLT.legitimacy, "disgrace");
  world.events.push({ kind: "revolt", holding: h.id, from: f, rebels: army ? rebels : 0, army });
  world.events.push({ kind: "stocksChanged", faction: f });
  updateSight(world, f);
}

/** One army's morale for the day, and the men a broken spirit loses. Returns false if nobody is left. */
function armyMoraleDay(world: KingdomWorld, a: Army): boolean {
  const M = ARMY_MORALE;
  let m = a.morale;
  if (a.hunger > 0) m -= M.hungry;
  if (a.unpaid > 0) m -= M.unpaid;
  if (a.hunger === 0 && a.unpaid === 0) {
    const rest = armyRestMorale(world, a);
    if (m < rest) m = min(rest, m + M.drift);
    else if (m > rest) m = max(rest, m - M.drift);
  }
  a.morale = m < 0 ? 0 : m > 100 ? 100 : m;
  if (a.morale < M.desertBelow) {
    const [n, carry] = perMille(armyMen(a) - armyWounded(a), M.desertPermille, a.desertCarry);
    a.desertCarry = carry;
    const gone = takeMen(a, n, () => true, false);
    if (gone > 0) world.events.push({ kind: "moraleDesertion", army: a.id, n: gone });
    a.squads = a.squads.filter((q) => q.men > 0);
  }
  return a.squads.length > 0;
}

/**
 * The morale day: every reckoned town's unrest, the season's legitimacy and
 * terror, revolts, and every army's morale. Called by KingdomWorld.tick on
 * the first tick of a day, after the economy's day and the armies' day, so
 * today's famine, foraging and wages are what it reads.
 */
export function runMoraleDay(world: KingdomWorld): void {
  const d = world.date;
  const turn = d.dayOfSeason === 0 && d.day > 0;
  for (let f = 0; f < FACTION_IDS.length; f++) {
    if (!economyActive(world, f)) continue;
    const e = world.economy[f];
    const book = world.books[f];
    const before = snapshotStocks(e).join();
    for (const h of ownedBy(world, f)) {
      // The justices are paid first; unpaid, they do not sit today.
      let courts = false;
      if (h.justice === "courts" && e.stocks.coin >= JUSTICE.courts.coin) {
        debit(e, book, "coin", JUSTICE.courts.coin, "justice");
        courts = true;
      }
      let delta = 0;
      for (const c of unrestCauses(world, h, courts)) delta += c.permille;
      addUnrest(world, h, delta);
      if (h.festival > 0 && --h.festival === 0) world.events.push({ kind: "festivalOver", holding: h.id });
    }
    if (turn) {
      // Shrines and halls: legitimacy a season (buildings.ts later.legitimacy), capped for the realm.
      let legit = 0;
      let mercy = 0;
      for (const h of ownedBy(world, f)) {
        for (const s of standing(h)) if (!h.idle[s.slot]) legit += BUILDINGS[s.def.id].later.legitimacy ?? 0;
        mercy += JUSTICE[h.justice].mercyPerSeason;
      }
      if (legit > 0) adjustLegitimacy(e, book, min(legit, SEASON_LEGITIMACY_CAP), "deeds");
      if (mercy !== 0) changeMercy(world, f, mercy);
    }
    // Army morale, and the men low spirits cost, in id order.
    const empty: Army[] = [];
    for (const a of world.armies) if (a.owner === f && !armyMoraleDay(world, a)) empty.push(a);
    for (const a of empty) removeArmy(world, a, "deserted");
    if (empty.length > 0) updateSight(world, f);
    // Revolts, in id order, after the day's unrest is reckoned.
    for (const h of ownedBy(world, f)) if (h.unrest >= REVOLT_AT) revolt(world, h, f);
    if (snapshotStocks(e).join() !== before) world.events.push({ kind: "stocksChanged", faction: f });
  }
}

/** For the HUD: the king's realm at a glance. */
export function realmStanding(world: KingdomWorld, faction: number = KING_PLAYER): { legitimacy: number; mercy: number } {
  const e = world.economy[faction];
  return { legitimacy: e.legitimacy, mercy: e.mercy };
}
