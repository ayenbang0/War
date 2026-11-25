/**
 * Free companies (PLAN.md §B.7, phase K7): the tavern as their source, the
 * contract, its price and the company's loyalty, the crown's poaching, and
 * betrayal.
 *
 *   waiting -> offered -> hired -> (renewed | expired | deserted | defected | poached | dismissed | broken)
 *
 * A company is a row of the story's table (content/story/mercenaries.ts
 * MERCENARIES) and a Company record in world.companies, in the same order.
 * Hired, it is an Army on the map (army.company = 1 + its index) raised whole
 * at the tavern -- its own men and arms: no levy is spent, no barracks is
 * needed, and no replacement comes (§B.7 "distinct from levy"). It is paid by
 * its contract's daily wage through the K4 army day (armies.ts armyWage), and
 * every day here its loyalty rises with pay and falls, faster, with wages
 * owed. At 0 it leaves by its reputation: the reliable walk away, the rest go
 * over to the crown with the men and arms the king paid for -- standing
 * where they stood, so K5's contact finds a betrayal in the king's own camp.
 *
 * No random draw: offers go to taverns and bids to companies in a fixed
 * order, on fixed days, by thresholds. Every coin through ledger.ts
 * (`hiring`; legitimacy through `disgrace`).
 */

import { floor, max, min } from "../math.ts";
import { FACTION_IDS, KING_PLAYER } from "../../content/kingdom/factions.ts";
import { MAX_ARMIES_PER_SIDE } from "../../content/kingdom/armies.ts";
import { ARMY_REFUSAL } from "../../content/kingdom/army-strings.ts";
import {
  ACT_HOLDINGS, AWAY_DAYS, BLOODY, LEAVES_AS, LEAVE_LEGITIMACY, LOYALTY, MERCENARIES, OFFER_DAYS, POACH,
  RENEW_FEE_PCT, RENEW_WINDOW, TURNED_FACTION, type CompanyLeaving,
} from "../../content/kingdom/mercenaries.ts";
import { MERC_REFUSAL } from "../../content/kingdom/mercenary-strings.ts";
import { REFUSAL } from "../../content/kingdom/ui-strings.ts";
import { calendar } from "./clock.ts";
import type { KingdomOrder, KingdomOrderBody } from "./orders.ts";
import { MERCENARY_ORDER_KIND_SET } from "./orders.ts";
import type { Army, Company, Holding } from "./state.ts";
import { adjustLegitimacy, debit } from "./ledger.ts";
import { economyActive, hasStanding, ownedBy } from "./economy.ts";
import { armiesOf, armyById, raiseArmy, removeArmy, standsIn } from "./armies.ts";
import { updateSight } from "./explore.ts";
import { moveUnrest } from "./unrest.ts";
import type { KingdomWorld } from "./world.ts";

export type MercenaryOrderBody = Extract<KingdomOrderBody, { kind: "hireCompany" | "renewContract" | "matchBid" }>;

/** Every company waiting, in table order: a new world's list (and a v6 save's, migrated). */
export function newCompanies(): Company[] {
  return MERCENARIES.map((_, index) => ({ index, state: "waiting", at: 0, days: 0, loyalty: 0, army: 0, bid: 0, bidDays: 0 }));
}

// -- queries (the market, the army card and the tests read these) ------------------------

/** Signing fee, renewal fee: whole coin, the renewal rounded up. */
export function hireFee(index: number): number {
  return MERCENARIES[index].fee;
}
export function renewFee(index: number): number {
  return floor((MERCENARIES[index].fee * RENEW_FEE_PCT + 99) / 100);
}
/** What the crown bids for a company. */
export function bidFor(index: number): number {
  return max(POACH.min, floor((MERCENARIES[index].fee * POACH.bidPct) / 100));
}

/** Does this holding have a standing tavern of the king's? */
export function kingsTavern(h: Holding): boolean {
  return h.owner === FACTION_IDS[KING_PLAYER] && hasStanding(h, "tavern");
}

/** The companies drinking in this holding's tavern, in table order (at most one, OFFERS_PER_TAVERN). */
export function offersAt(world: KingdomWorld, holding: number): Company[] {
  return world.companies.filter((c) => c.state === "offered" && c.at === holding);
}

/** The company this army is, if it is one and is in the king's service. */
export function companyOf(world: KingdomWorld, a: Army): Company | null {
  if (a.company === 0) return null;
  const c = world.companies[a.company - 1];
  return c && c.state === "hired" && c.army === a.id ? c : null;
}

/** Is this company free to come to the king's taverns yet (the act gate, K7.2)? */
export function companyAvailable(world: KingdomWorld, index: number): boolean {
  const need = ACT_HOLDINGS[MERCENARIES[index].act] ?? 0;
  return ownedBy(world, KING_PLAYER).length >= need;
}

// -- orders ---------------------------------------------------------------------------

export function isMercenaryOrder(b: KingdomOrderBody): b is MercenaryOrderBody {
  return MERCENARY_ORDER_KIND_SET.has(b.kind);
}

function hiredCompany(world: KingdomWorld, index: number): Company | string {
  const c = world.companies[index];
  if (!c) return MERC_REFUSAL.noSuchCompany;
  if (c.state !== "hired" || !armyById(world, c.army)) return MERC_REFUSAL.notHired;
  return c;
}

/** Why a mercenary order would be refused right now, or null. The market's and the army card's buttons call this. */
export function checkMercenaryOrder(world: KingdomWorld, body: MercenaryOrderBody, player: number): string | null {
  if (player !== KING_PLAYER) return REFUSAL.onlyKing;
  const coin = world.economy[player].stocks.coin;
  switch (body.kind) {
    case "hireCompany": {
      const c = world.companies[body.company];
      if (!c) return MERC_REFUSAL.noSuchCompany;
      const h = world.holding(body.at);
      if (!h) return REFUSAL.noSuchHolding;
      if (h.owner !== FACTION_IDS[player]) return MERC_REFUSAL.notYourHolding;
      if (!kingsTavern(h)) return MERC_REFUSAL.noTavern;
      if (c.state !== "offered" || c.at !== h.id) return MERC_REFUSAL.notOffered;
      if (armiesOf(world, player).length >= MAX_ARMIES_PER_SIDE) return ARMY_REFUSAL.tooManyArmies(MAX_ARMIES_PER_SIDE);
      if (coin < hireFee(c.index)) return MERC_REFUSAL.fee(hireFee(c.index));
      return null;
    }
    case "renewContract": {
      const c = hiredCompany(world, body.company);
      if (typeof c === "string") return c;
      if (c.days > RENEW_WINDOW) return MERC_REFUSAL.notInWindow(RENEW_WINDOW);
      if ((armyById(world, c.army) as Army).arrears > 0) return MERC_REFUSAL.arrears;
      if (coin < renewFee(c.index)) return MERC_REFUSAL.renewFee(renewFee(c.index));
      return null;
    }
    case "matchBid": {
      const c = hiredCompany(world, body.company);
      if (typeof c === "string") return c;
      if (c.bid === 0) return MERC_REFUSAL.noBid;
      if (coin < c.bid) return MERC_REFUSAL.bid(c.bid);
      return null;
    }
  }
}

/** Apply a mercenary order. Returns null if applied, or the refusal (nothing changes). */
export function applyMercenaryOrder(world: KingdomWorld, order: KingdomOrder & MercenaryOrderBody): string | null {
  const why = checkMercenaryOrder(world, order, order.player);
  if (why) return why;
  const f = order.player;
  const e = world.economy[f];
  const book = world.books[f];
  switch (order.kind) {
    case "hireCompany": {
      const c = world.companies[order.company];
      const def = MERCENARIES[c.index];
      const fee = hireFee(c.index);
      debit(e, book, "coin", fee, "hiring");
      // Raised whole where it drinks: its own men, full and fit (raiseArmy is
      // the no-cost muster the story's set pieces use; the fee is the cost).
      const a = raiseArmy(world, f, order.at, def.mix);
      a.company = c.index + 1;
      a.name = def.name;
      a.captain = def.captain;
      c.state = "hired";
      c.at = 0;
      c.days = def.contractDays;
      c.loyalty = def.loyalty;
      c.army = a.id;
      c.bid = 0;
      c.bidDays = 0;
      world.events.push({ kind: "companyHired", company: c.index, army: a.id, fee });
      world.events.push({ kind: "stocksChanged", faction: f });
      return null;
    }
    case "renewContract": {
      const c = world.companies[order.company];
      const fee = renewFee(c.index);
      debit(e, book, "coin", fee, "hiring");
      c.days += MERCENARIES[c.index].contractDays;
      world.events.push({ kind: "contractRenewed", company: c.index, fee });
      world.events.push({ kind: "stocksChanged", faction: f });
      return null;
    }
    case "matchBid": {
      const c = world.companies[order.company];
      const bid = c.bid;
      debit(e, book, "coin", bid, "hiring");
      c.loyalty = min(LOYALTY.max, c.loyalty + LOYALTY.matched);
      c.bid = 0;
      c.bidDays = 0;
      world.events.push({ kind: "bidMatched", company: c.index, bid });
      world.events.push({ kind: "stocksChanged", faction: f });
      return null;
    }
  }
}

// -- leaving -----------------------------------------------------------------------------

function goAway(c: Company): void {
  c.state = "away";
  c.at = 0;
  c.days = AWAY_DAYS;
  c.loyalty = 0;
  c.army = 0;
  c.bid = 0;
  c.bidDays = 0;
}

function leaveService(world: KingdomWorld, c: Company, a: Army, how: CompanyLeaving): void {
  const k = KING_PLAYER;
  world.events.push({ kind: "companyLeft", company: c.index, army: a.id, how });
  const lost = LEAVE_LEGITIMACY[how];
  if (lost > 0) adjustLegitimacy(world.economy[k], world.books[k], -lost, "disgrace");
}

/** Disbanding a company army is dismissing it (armies.ts disband calls this first): paid off, it rides away. */
export function dismissCompany(world: KingdomWorld, a: Army): void {
  const c = companyOf(world, a);
  if (!c) return;
  goAway(c);
  leaveService(world, c, a, "dismissed");
}

/** armies.ts removeArmy calls this for a company army: destroyed in the king's service, the company is broken. */
export function companyArmyGone(world: KingdomWorld, a: Army): void {
  const c = companyOf(world, a);
  if (!c) return;
  c.state = "broken";
  c.at = 0;
  c.days = 0;
  c.army = 0;
  c.bid = 0;
  c.bidDays = 0;
  leaveService(world, c, a, "broken");
}

/**
 * A company goes over to the crown: the same army, the same men, the same
 * place, under the crown's banner. Out of any garrison, out from under the
 * king (who stays where he stood), off every chase of the king's armies. It
 * owes nobody wages any more. If the crown is at its cap of armies the men
 * simply scatter instead (it cannot field one more).
 */
function turnCoat(world: KingdomWorld, c: Company, a: Army, how: "defected" | "poached"): void {
  const to = FACTION_IDS.indexOf(TURNED_FACTION);
  if (armiesOf(world, to).length >= MAX_ARMIES_PER_SIDE) {
    goAway(c);
    c.state = "turned";
    c.days = 0;
    leaveService(world, c, a, how);
    removeArmy(world, a, "deserted");
    updateSight(world, KING_PLAYER);
    return;
  }
  const from = a.owner;
  for (const h of world.holdings) {
    const i = h.garrison.indexOf(a.id);
    if (i >= 0) h.garrison.splice(i, 1);
  }
  if (world.king.army === a.id) {
    world.king.army = 0;
    world.king.mover = { ...a.mover, route: [] };
    world.events.push({ kind: "kingJoined", army: 0 });
  }
  for (const b of world.armies) {
    if (b !== a && b.owner === from && b.target === a.id) { b.target = 0; b.mergeInto = false; b.mover.route = []; }
  }
  a.owner = to;
  a.target = 0;
  a.mergeInto = false;
  a.mover.route = [];
  a.posture = "none";
  a.postureDays = 0;
  a.patrol = [];
  a.patrolIndex = 0;
  a.arrears = 0;
  a.unpaid = 0;
  c.state = "turned";
  c.at = 0;
  c.days = 0;
  c.loyalty = 0;
  c.army = 0;
  c.bid = 0;
  c.bidDays = 0;
  leaveService(world, c, a, how);
  updateSight(world, from);
  updateSight(world, to);
}

// -- the day -----------------------------------------------------------------------------

/**
 * Once a day, after K6's morale day (so today's wages are what loyalty
 * reads): every hired company's loyalty, its bid, its contract; every offer
 * and absence counts down; free taverns get their next company.
 */
export function runMercenaryDay(world: KingdomWorld): void {
  const k = KING_PLAYER;
  if (!economyActive(world, k)) return;
  const d = calendar(world.now);
  const e = world.economy[k];
  const book = world.books[k];

  for (const c of world.companies) {
    const def = MERCENARIES[c.index];
    if (c.state === "hired") {
      const a = armyById(world, c.army);
      if (!a || a.owner !== k) { companyLost(c); continue; }
      // Loyalty: a paid day earns a little; a day with wages owed costs more.
      c.loyalty = a.arrears > 0 ? max(0, c.loyalty - LOYALTY.unpaid) : min(LOYALTY.max, c.loyalty + LOYALTY.paid);
      if (c.loyalty === 0) {
        const how = LEAVES_AS[def.reputation];
        if (how === "deserted") {
          goAway(c);
          leaveService(world, c, a, "deserted");
          removeArmy(world, a, "deserted");
          updateSight(world, k);
        } else {
          turnCoat(world, c, a, "defected");
        }
        continue;
      }
      // A bloody company: the town it stands in hates the king for it; the realm too, each season.
      if (def.reputation === "bloody") {
        const h = world.holding(standsIn(a.mover));
        if (h && h.owner === FACTION_IDS[k]) moveUnrest(world, h, BLOODY.unrest);
        if (d.dayOfSeason === 0) adjustLegitimacy(e, book, -BLOODY.legitimacy, "disgrace");
      }
      // The crown's bid: it stands its days, then the company goes.
      if (c.bid > 0) {
        c.bidDays--;
        if (c.bidDays <= 0) { turnCoat(world, c, a, "poached"); continue; }
      } else if (POACH.onDays.includes(d.dayOfSeason) && c.loyalty < POACH.below[def.reputation]) {
        c.bid = bidFor(c.index);
        c.bidDays = POACH.days;
        world.events.push({ kind: "companyBid", company: c.index, bid: c.bid });
      }
      // The contract runs down; in its window it can be renewed; at 0 they ride away.
      c.days--;
      if (c.days === RENEW_WINDOW) world.events.push({ kind: "contractEnding", company: c.index, days: c.days });
      if (c.days <= 0) {
        goAway(c);
        leaveService(world, c, a, "expired");
        a.squads = [];
        a.supply = 0;
        removeArmy(world, a, "expired");
        updateSight(world, k);
      }
      continue;
    }
    if (c.state === "offered") {
      const h = world.holding(c.at);
      c.days--;
      if (!h || !kingsTavern(h) || c.days <= 0) {
        const at = c.at;
        goAway(c);
        world.events.push({ kind: "companyMovedOn", company: c.index, at });
      }
      continue;
    }
    if (c.state === "away") {
      c.days--;
      if (c.days <= 0) { c.state = "waiting"; c.days = 0; }
    }
  }

  // Free taverns, in holding-id order, take the first company free to come, in table order.
  for (const h of world.holdings) {
    if (!kingsTavern(h) || offersAt(world, h.id).length > 0) continue;
    const c = world.companies.find((x) => x.state === "waiting" && companyAvailable(world, x.index));
    if (!c) break;
    c.state = "offered";
    c.at = h.id;
    c.days = OFFER_DAYS;
    world.events.push({ kind: "companyOffered", company: c.index, at: h.id });
  }
}

/** A hired company whose army is not on the map (a safety net: removeArmy marks it first). */
function companyLost(c: Company): void {
  c.state = "broken";
  c.army = 0;
  c.days = 0;
  c.bid = 0;
  c.bidDays = 0;
}
