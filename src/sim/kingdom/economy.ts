/**
 * The kingdom economy (PLAN.md §B.3, phase K3): stockpiles, taxes, trade,
 * buildings, field plots and crops, the seasons, weather on the farms, the
 * town dole, granaries and spoilage, winter famine -- and the orders that let
 * an exiled king with nothing start it: forage, rally, claim.
 *
 * Pure and deterministic like the rest of src/sim/kingdom/:
 *   - every stock is an integer and changes ONLY through ledger.ts, which
 *     records each change by category, so conservation is exact;
 *   - holdings, slots and plots are visited in id order;
 *   - the one random draw a day for farm weather comes from the WEATHER
 *     stream and is made every day whatever is planted, so planting never
 *     shifts the weather; harvest variance comes from the ECONOMY stream.
 *
 * It runs once a day, at the day boundary, right after the day's weather is
 * rolled (docs/kingdom.md, "The tick", step 2). Orders apply later in the
 * same tick and throughout the day, so a forage ordered today is first paid
 * at the next boundary -- "a day spent foraging".
 *
 * Which factions' economies run: ECONOMY_FACTIONS. In K3 only the king's. The
 * captains' stores exist (saved, hashed, at zero) but stand still until K8
 * gives them stewards: with no one to sow their fields, running their towns'
 * dole would starve the whole map in its first winter (docs/PROVISIONAL.md K3.3).
 */

import { ceil, floor, max, min } from "../math.ts";
import { FACTIONS, FACTION_IDS, KING_PLAYER, type FactionId } from "../../content/kingdom/factions.ts";
import { HOLDING_KINDS, type Season } from "../../content/kingdom/terrain.ts";
import {
  AUTO_SOW_DEFAULT, BIOME_ECONOMY, CARRY_PER_PERSON, CELLAR, CLAIM_GRAIN_PER_PERSON, CLAIM_MIN_LEVY, DEFAULT_TAX,
  DOLE_PER_100, FAMINE_LOSS_PCT, FIELD_SIZE, FIRST_HOLDING_STORES, KING_BARNS, FORAGERS_PER_TIMBER, FORAGE_PER_PERSON,
  GERMINATION_DAYS, HARVEST_VARIANCE_PCT, KING_START, KING_START_LEGITIMACY, MUSTER_PCT, PARTY_RATION,
  RALLY_BRINGS, RALLY_FLOOR_PCT, RALLY_PEOPLE_PER_FOLLOWER, SPOIL_PERMILLE, STOCK_IDS, TAX_RATES, TAX_RATE_IDS,
  type StockId, type TaxRateId,
} from "../../content/kingdom/economy.ts";
import { BUILDINGS, type BuildingDef, type BuildingId, type Cost } from "../../content/kingdom/buildings.ts";
import { CROPS, daysToRipe, type CropDef, type CropId } from "../../content/kingdom/crops.ts";
import { REFUSAL } from "../../content/kingdom/ui-strings.ts";
import { WALL_REPAIR, type Fortification } from "../../content/kingdom/descent.ts";
import { CAPTAIN_START, CAPTAIN_START_LEGITIMACY, CROWN_TITHE_PER_100 } from "../../content/kingdom/invasions.ts";
import { moveUnrest } from "./unrest.ts";
import { CLAIM_UNREST, MERCY_START, MUSTER_UNREST, RESTLESS_AT } from "../../content/kingdom/morale.ts";
import type { CalendarDate } from "./clock.ts";
import type { KingdomOrder, KingdomOrderBody } from "./orders.ts";
import type { FactionEconomy, FieldPlot, Holding, KingTask, PlotCause, PlotStage } from "./state.ts";
import {
  adjustLegitimacy, canAfford, credit, debit, debitUpTo, newLedgerDay, pay, receive, snapshotStocks, turnPage,
  type FactionBook,
} from "./ledger.ts";
import type { KingdomWorld } from "./world.ts";
// K3a: special upgrades bend these formulas; with none held every one is the K3 formula exactly.
import {
  creditDailyBoons, foragePct, musterPct, seasonalBoons, spoilagePct, taxPct, upgradeStorage, upgradeYieldPct, withPct,
} from "./explore.ts";

/** Factions whose economy runs, by id. K8 appends the captains as it gives them stewards. */
export const ECONOMY_FACTIONS: readonly FactionId[] = ["king"];

/** The economy orders (everything but the march). */
export type EconomyOrderBody = Extract<KingdomOrderBody, {
  kind: "forage" | "rally" | "claimHolding" | "setTax" | "build" | "sow" | "harvest" | "setAutoSow" | "repairWalls";
}>;

const ECONOMY_KINDS: ReadonlySet<string> = new Set(["forage", "rally", "claimHolding", "setTax", "build", "sow", "harvest", "setAutoSow", "repairWalls"]);

export function isEconomyOrder(b: KingdomOrderBody): b is EconomyOrderBody {
  return ECONOMY_KINDS.has(b.kind);
}

// -- construction -----------------------------------------------------------------

export function newFactionEconomy(id: FactionId, captains = false, autoFarm = false): FactionEconomy {
  const king = id === "king";
  // K8: in a realm with captains every faction with a persona starts with a steward's stores.
  const captain = !king && captains && FACTIONS[id].persona !== null;
  const stocks = {} as Record<StockId, number>;
  for (const s of STOCK_IDS) stocks[s] = king ? KING_START[s] : captain ? CAPTAIN_START[s] : 0;
  const legitimacy = king ? KING_START_LEGITIMACY : captain ? CAPTAIN_START_LEGITIMACY : 0;
  // ECON: a new campaign's king has every field he comes to hold resow itself (KingdomConfig.autoFarm).
  return { stocks, legitimacy, hunger: 0, defaultTax: DEFAULT_TAX, mercy: MERCY_START, autoSow: king && autoFarm ? AUTO_SOW_DEFAULT : null };
}

export function newBook(e: FactionEconomy): FactionBook {
  return { open: newLedgerDay(0, e), closed: null };
}

// -- queries (read-only; the UI and the tests use them) ------------------------------

export function factionIndex(id: FactionId): number {
  return FACTION_IDS.indexOf(id);
}

export function economyActive(world: KingdomWorld, faction: number): boolean {
  if (ECONOMY_FACTIONS.includes(FACTION_IDS[faction])) return true;
  // K8: in a realm with captains (KingdomConfig.captains) every faction with a
  // persona has a steward (sim/kingdom/ai.ts): its stores move, its towns pay
  // and grumble, its armies are paid and fed -- the player's constraints. The
  // commons have no steward and stand still, as every captain did before K8.
  return world.captains && FACTIONS[FACTION_IDS[faction]]?.persona != null;
}

/**
 * Does this faction's dole feed its towns from its stores? The king's does.
 * A crown town feeds itself (docs/PROVISIONAL.md K8.3): the authored cities
 * cannot live off their own few plots, and a steward who let Rimaros starve
 * in the first winter would end the story before Act II. K11 balances it.
 */
export function drawsDole(faction: number): boolean {
  return faction === KING_PLAYER;
}

/** Holdings a faction owns, in id order. */
export function ownedBy(world: KingdomWorld, faction: number): Holding[] {
  const id = FACTION_IDS[faction];
  return world.holdings.filter((h) => h.owner === id);
}

/** People in a faction's own party: for the king, the king, the companions and the levy following him. */
export function partySize(world: KingdomWorld, faction: number): number {
  if (faction !== KING_PLAYER) return 0;
  return 1 + world.king.companions.length + world.economy[faction].stocks.levy;
}

/** The population a holding had in the authored map: the rally floor is a share of it. */
export function basePopulation(world: KingdomWorld, h: Holding): number {
  const def = world.map.holdings.find((d) => d.key === h.key);
  return def?.population ?? HOLDING_KINDS[h.kind].population;
}

/** Buildings standing (finished) in a holding, in slot order, with their slot. */
export function standing(h: Holding): { slot: number; def: BuildingDef }[] {
  const out: { slot: number; def: BuildingDef }[] = [];
  for (let i = 0; i < h.buildings.length; i++) {
    const b = h.buildings[i];
    if (b !== null && h.works[i] === 0 && BUILDINGS[b as BuildingId]) out.push({ slot: i, def: BUILDINGS[b as BuildingId] });
  }
  return out;
}

export function hasStanding(h: Holding, id: BuildingId, activeOnly = false): boolean {
  return standing(h).some((s) => s.def.id === id && (!activeOnly || !h.idle[s.slot]));
}

/**
 * The strongest wall BUILT in a holding (a keep over a wall, a wall over a
 * palisade), whatever state its stones are in (descent.ts fortificationOf
 * says what still STANDS). What mending walls costs is reckoned from this.
 */
export function builtFortification(h: Holding): Fortification {
  if (hasStanding(h, "keep")) return "keep";
  if (hasStanding(h, "wall")) return "wall";
  if (hasStanding(h, "palisade")) return "palisade";
  return "none";
}

/**
 * K10: what mending a holding's walls costs now: every quarter of their
 * strength battered and not yet paid for (rounded up), at the price of the
 * strongest wall built there (content WALL_REPAIR). Empty when there is
 * nothing to pay for.
 */
export function wallRepairCost(h: Holding): Cost {
  const owed = h.walls - h.mend;
  const fort = builtFortification(h);
  if (owed <= 0 || fort === "none") return {};
  const quarters = ceil(owed / 250);
  const per = WALL_REPAIR.perQuarter[fort];
  const out: Partial<Record<StockId, number>> = {};
  for (const s of ["coin", "timber", "iron"] as const) if (per[s]) out[s] = per[s]! * quarters;
  return out;
}

/** Grain storage of a faction: granaries, then cellars and the party's packs. */
export function storageOf(world: KingdomWorld, faction: number): { granary: number; loose: number } {
  let granary = 0;
  let loose = faction === KING_PLAYER ? partySize(world, faction) * CARRY_PER_PERSON : 0;
  const owned = ownedBy(world, faction);
  for (const h of owned) {
    loose += CELLAR[h.kind];
    for (const s of standing(h)) granary += s.def.economy.storage ?? 0;
  }
  // ECON: the crown's barns, a granary's worth that never spoils, as soon as the king holds a town.
  if (faction === KING_PLAYER && owned.length > 0) granary += KING_BARNS;
  granary += upgradeStorage(world, faction);
  return { granary, loose };
}

/**
 * ECON: where the faction's grain lies today, by the order it fills the
 * stores (granaries first, then cellars and packs, then heaps past the
 * room), and what each loses a day -- the readout behind the resources bar
 * and the granary's card, computed exactly as spoil() takes it.
 */
export function grainStores(world: KingdomWorld, faction: number): {
  grain: number; granary: number; loose: number; capacity: number;
  inGranary: number; inLoose: number; heap: number; spoilsToday: number;
} {
  const { granary, loose } = storageOf(world, faction);
  const grain = world.economy[faction].stocks.grain;
  const inGranary = min(grain, granary);
  const inLoose = min(grain - inGranary, loose);
  const heap = grain - inGranary - inLoose;
  const looseRate = (SPOIL_PERMILLE.loose * (100 + spoilagePct(world, faction))) / 100;
  const spoilsToday = floor((inGranary * SPOIL_PERMILLE.granary) / 1000) + floor((inLoose * looseRate) / 1000) +
    ceil((heap * SPOIL_PERMILLE.heap) / 1000);
  return { grain, granary, loose, capacity: granary + loose, inGranary, inLoose, heap, spoilsToday };
}

/** Grain a holding draws today (without consuming its remainder). */
function doleDue(h: Holding, season: Season, pct = 100): { draw: number; carry: number } {
  // K11: the difficulty's dole (the king's towns only; 100 is the old sum exactly).
  const owed = floor((h.population * DOLE_PER_100[season] * pct) / 100) + h.doleCarry;
  const draw = floor(owed / 100);
  return { draw, carry: owed - draw * 100 };
}

/**
 * K11: the difficulty's numbers are the KING's (content/kingdom/difficulty.ts):
 * the rival captains run the same economy at every setting.
 */
function dolePct(world: KingdomWorld, faction: number): number {
  return faction === KING_PLAYER ? world.tuning.dolePct : 100;
}

/** What a faction must find in grain each day at today's season: the party and the towns. */
export function dailyNeed(world: KingdomWorld, faction: number, season: Season = world.date.season): number {
  let n = partySize(world, faction) * PARTY_RATION;
  if (drawsDole(faction)) for (const h of ownedBy(world, faction)) n += doleDue(h, season, dolePct(world, faction)).draw;
  return n;
}

/** Coin a holding pays a day at a rate, rounded down (for the card; the sim keeps the remainder). */
export function taxPerDay(population: number, rate: TaxRateId): number {
  return (population * TAX_RATES[TAX_RATE_IDS.indexOf(rate)].per100) / 100;
}

/** The plot with this id and the holding it belongs to. */
export function findPlot(world: KingdomWorld, id: number): { holding: Holding; plot: FieldPlot; index: number } | null {
  for (const h of world.holdings) {
    for (let i = 0; i < h.plots.length; i++) if (h.plots[i].id === id) return { holding: h, plot: h.plots[i], index: i };
  }
  return null;
}

/** A crop's seed cost at a holding (FIELD_SIZE scales seed with the field). */
export function seedCost(crop: CropDef, h: Holding): Cost {
  const f = FIELD_SIZE[h.kind];
  const out: Partial<Record<StockId, number>> = {};
  for (const s of STOCK_IDS) if (crop.seed[s]) out[s] = crop.seed[s]! * f;
  return out;
}

/** The yield a ripe plot would give at full luck (no variance), for the plot manager. */
export function expectedYield(world: KingdomWorld, h: Holding, plot: FieldPlot): Cost {
  const crop = plot.crop ? CROPS[plot.crop as CropId] : null;
  if (!crop) return {};
  let farm = hasStanding(h, "farm", true) ? (BUILDINGS.farm.economy.yieldPct ?? 0) : 0;
  const f = h.owner === null ? -1 : FACTION_IDS.indexOf(h.owner);
  if (f >= 0) farm += upgradeYieldPct(world, f, h, crop.id);
  const out: Partial<Record<StockId, number>> = {};
  for (const s of STOCK_IDS) {
    const base = crop.yield[s] ?? 0;
    // K11: the difficulty's harvest is applied last, to the king's fields alone.
    if (base) out[s] = floor((floor((base * FIELD_SIZE[h.kind] * plot.health * (100 + farm)) / 10000) * (f === KING_PLAYER ? world.tuning.yieldPct : 100)) / 100);
  }
  return out;
}

/** The slot a building would go in, or -1 (and why not). */
function slotFor(h: Holding, def: BuildingDef): { slot: number; why: string | null } {
  if (def.upgrades) {
    for (let i = 0; i < h.buildings.length; i++) {
      if (h.buildings[i] === def.upgrades && h.works[i] === 0) return { slot: i, why: null };
    }
    return { slot: -1, why: REFUSAL.needsFirst(BUILDINGS[def.upgrades].name) };
  }
  const free = h.buildings.indexOf(null);
  return free < 0 ? { slot: -1, why: REFUSAL.noSlot } : { slot: free, why: null };
}

// -- validating orders: one function for the button and the sim -----------------------

/**
 * K11 (audit U2-05): what an economy order would cost (build, sow, mend the
 * walls), or null for one that costs nothing.
 */
export function economyOrderCost(world: KingdomWorld, body: KingdomOrderBody): Cost | null {
  if (body.kind === "build") return BUILDINGS[body.building]?.cost ?? null;
  if (body.kind === "sow") {
    const found = findPlot(world, body.plot);
    const crop = CROPS[body.crop];
    return found && crop ? seedCost(crop, found.holding) : null;
  }
  if (body.kind === "repairWalls") {
    const h = world.holding(body.holding);
    return h ? wallRepairCost(h) : null;
  }
  return null;
}

/**
 * K11 (audit U2-05): the check a menu offers an order by, counting what the
 * player's orders still waiting on the clock will spend. While paused, two
 * builds the stores pay for one at a time were both offered and the second
 * refused when time ran; now the second says the stores are promised. Never
 * called by the tick (the sim still checks each order against the stores as
 * they are when it lands), so nothing it says moves a hash.
 */
export function checkCountingQueued(world: KingdomWorld, body: KingdomOrderBody, player: number = KING_PLAYER): string | null {
  const why = world.check(body, player);
  if (why !== null) return why;
  const cost = economyOrderCost(world, body);
  if (cost === null) return null;
  const promised: Partial<Record<StockId, number>> = {};
  let any = false;
  for (const o of world.orders.queued()) {
    if (o.player !== player) continue;
    const c = economyOrderCost(world, o);
    if (c === null) continue;
    for (const s of STOCK_IDS) if (c[s]) { promised[s] = (promised[s] ?? 0) + c[s]!; any = true; }
  }
  if (!any) return null;
  const stocks = world.economy[player].stocks;
  for (const s of STOCK_IDS) if ((cost[s] ?? 0) + (promised[s] ?? 0) > stocks[s]) return REFUSAL.promised;
  return null;
}

/**
 * Why an economy order would be refused right now, or null if it would be
 * applied. The panels call this to decide which buttons to offer and to say
 * why one is not on offer, and applyEconomyOrder calls the SAME function, so
 * a button never promises what the sim then refuses.
 */
export function checkEconomyOrder(world: KingdomWorld, body: EconomyOrderBody, player: number): string | null {
  if (player < 0 || player >= FACTION_IDS.length) return REFUSAL.noSuchFaction;
  const e = world.economy[player];
  const owns = (h: Holding | undefined): h is Holding => !!h && h.owner === FACTION_IDS[player];
  switch (body.kind) {
    case "forage":
    case "rally": {
      if (player !== KING_PLAYER) return REFUSAL.onlyKing;
      const m = world.king.mover;
      if (m.road !== 0) return REFUSAL.onTheRoad;
      if (m.route.length > 0) return REFUSAL.marching;
      if (world.king.task === body.kind) return body.kind === "forage" ? REFUSAL.alreadyForaging : REFUSAL.alreadyRallying;
      if (body.kind === "forage") return null;
      const h = world.holding(m.node) as Holding;
      if (h.owner !== null) return REFUSAL.rallyOwned;
      if (h.kind !== "hamlet") return REFUSAL.rallyNotHamlet;
      if (h.population <= rallyFloor(world, h)) return REFUSAL.rallySpent;
      return null;
    }
    case "claimHolding": {
      if (player !== KING_PLAYER) return REFUSAL.onlyKing;
      const h = world.holding(body.holding);
      if (!h) return REFUSAL.noSuchHolding;
      if (h.owner !== null) return h.owner === "king" ? REFUSAL.alreadyYours : REFUSAL.heldByOther;
      if (h.garrison.length > 0) return REFUSAL.garrisoned;
      const m = world.king.mover;
      if (m.road !== 0 || m.node !== h.id) return REFUSAL.claimFromThere;
      // K4: the men of the army he rides with are with him too.
      if (e.stocks.levy + menRidingWithKing(world) < CLAIM_MIN_LEVY) return REFUSAL.claimNeedsFollowers(CLAIM_MIN_LEVY);
      return null;
    }
    case "setTax": {
      if (!(TAX_RATE_IDS as readonly string[]).includes(body.rate)) return REFUSAL.noSuchRate;
      if (body.holding === 0) return null;
      const h = world.holding(body.holding);
      if (!h) return REFUSAL.noSuchHolding;
      if (!owns(h)) return REFUSAL.notYours;
      return null;
    }
    case "build": {
      const h = world.holding(body.holding);
      if (!h) return REFUSAL.noSuchHolding;
      if (!owns(h)) return REFUSAL.notYours;
      const def = BUILDINGS[body.building];
      if (!def) return REFUSAL.noSuchBuilding;
      const eco = BIOME_ECONOMY[h.biome];
      if (def.notIn?.includes(h.biome) || (def.needsWood && eco.wood === 0)) return REFUSAL.wrongCountry;
      if (def.unique && h.buildings.includes(def.id)) return REFUSAL.alreadyBuilt;
      const s = slotFor(h, def);
      if (s.why) return s.why;
      if (!canAfford(e, def.cost)) return REFUSAL.cannotAfford;
      return null;
    }
    case "sow": {
      const found = findPlot(world, body.plot);
      if (!found) return REFUSAL.noSuchPlot;
      if (!owns(found.holding)) return REFUSAL.notYours;
      const crop = CROPS[body.crop];
      if (!crop) return REFUSAL.noSuchCrop;
      const p = found.plot;
      if (p.stage === "harvested" && p.crop && CROPS[p.crop as CropId]?.regrowDays) return REFUSAL.orchardStands;
      if (p.stage !== "empty" && p.stage !== "harvested" && p.stage !== "spoiled") return REFUSAL.plotInUse;
      if (!crop.sow.includes(world.date.season)) return REFUSAL.wrongSeason(crop.name);
      // ECON: no field is sown to die -- a tender crop that could not ripen before the winter is refused, and says why.
      if (daysToRipe(crop, world.date.dayOfYear) === null) return REFUSAL.tooLate(crop.name);
      if (!canAfford(e, seedCost(crop, found.holding))) return REFUSAL.cannotAfford;
      return null;
    }
    case "harvest": {
      const found = findPlot(world, body.plot);
      if (!found) return REFUSAL.noSuchPlot;
      if (!owns(found.holding)) return REFUSAL.notYours;
      if (found.plot.stage !== "ripe") return REFUSAL.notRipe;
      return null;
    }
    case "repairWalls": {
      const h = world.holding(body.holding);
      if (!h) return REFUSAL.noSuchHolding;
      if (!owns(h)) return REFUSAL.notYours;
      if (builtFortification(h) === "none") return REFUSAL.noWalls;
      if (h.walls === 0) return REFUSAL.wallsWhole;
      if (h.mend >= h.walls) return REFUSAL.wallsMending;
      if (!canAfford(e, wallRepairCost(h))) return REFUSAL.cannotAfford;
      return null;
    }
    case "setAutoSow": {
      if (body.crop !== null && !CROPS[body.crop]) return REFUSAL.noSuchCrop;
      if (body.holding === 0) return body.plot === 0 ? null : REFUSAL.noSuchPlot;
      const h = world.holding(body.holding);
      if (!h) return REFUSAL.noSuchHolding;
      if (!owns(h)) return REFUSAL.notYours;
      if (body.plot !== 0 && !h.plots.some((p) => p.id === body.plot)) return REFUSAL.noSuchPlot;
      return null;
    }
  }
}

/**
 * ECON: why a field set to resow itself is not sown today, or null if it
 * would be. Read by the auto-sow and by the field card (which says what the
 * field is waiting for), so the two never disagree. A field is sown by itself
 * only in the crop's own season, while it is open, when the seed is in the
 * stores, and only if the crop would ripen before a winter that kills it:
 * auto-sowing never plants a crop to die.
 */
export function autoSowWaits(world: KingdomWorld, h: Holding, p: FieldPlot): AutoSowWait | null {
  if (p.auto === null || h.owner === null) return "off";
  const crop = CROPS[p.auto as CropId];
  if (!crop) return "off";
  if (p.stage === "harvested" && p.crop && CROPS[p.crop as CropId]?.regrowDays) return "standing";
  if (p.stage !== "empty" && p.stage !== "harvested" && p.stage !== "spoiled") return "inUse";
  const d = world.date;
  if (!crop.sow.includes(d.season)) return "season";
  if (daysToRipe(crop, d.dayOfYear) === null) return "late";
  const f = FACTION_IDS.indexOf(h.owner);
  if (!canAfford(world.economy[f], seedCost(crop, h))) return "seed";
  return null;
}

/** Why an auto-sown field waits (autoSowWaits). The field card words each. */
export type AutoSowWait = "off" | "standing" | "inUse" | "season" | "late" | "seed";

/**
 * Men of the army the king rides with (K4). Summed here rather than imported
 * from armies.ts, which imports this file.
 */
function menRidingWithKing(world: KingdomWorld): number {
  let n = 0;
  for (const a of world.armies) if (a.id === world.king.army) for (const s of a.squads) n += s.men;
  return n;
}

function rallyFloor(world: KingdomWorld, h: Holding): number {
  return floor((basePopulation(world, h) * RALLY_FLOOR_PCT) / 100);
}

// -- applying orders ------------------------------------------------------------------

function setPlot(world: KingdomWorld, h: Holding, p: FieldPlot, stage: PlotStage, cause: PlotCause): void {
  p.stage = stage;
  p.days = 0;
  if (stage === "sown") { p.progress = 0; p.health = 100; p.lost = null; }
  if (stage === "ripe") p.progress = 1;
  // ECON: a lost crop remembers why, for the field card, until the field is sown again.
  if (stage === "spoiled") p.lost = cause;
  world.events.push({ kind: "plotStage", holding: h.id, plot: p.id, stage, cause });
}

export function setTask(world: KingdomWorld, task: KingTask): void {
  const k = world.king;
  if (k.task === task) return;
  k.task = task;
  k.taskDays = 0;
  world.events.push({ kind: "taskSet", task, holding: k.mover.road === 0 ? k.mover.node : 0 });
}

/**
 * Apply an economy order. Returns null if applied, or the refusal (the world
 * then logs an orderRejected and changes nothing).
 */
export function applyEconomyOrder(world: KingdomWorld, order: KingdomOrder & EconomyOrderBody): string | null {
  const why = checkEconomyOrder(world, order, order.player);
  if (why) return why;
  const f = order.player;
  const e = world.economy[f];
  const book = world.books[f];
  switch (order.kind) {
    case "forage":
    case "rally":
      setTask(world, order.kind);
      return null;
    case "claimHolding": {
      const h = world.holding(order.holding) as Holding;
      h.owner = FACTION_IDS[f];
      h.tax = e.defaultTax;
      h.taxCarry = 0;
      h.doleCarry = 0;
      h.famine = 0;
      // K6: strangers are not yet trusted; whatever festival was running is not ours.
      h.unrest = CLAIM_UNREST;
      h.festival = 0;
      // A rally is for unclaimed hamlets; the people of your own are taxed and mustered instead.
      if (world.king.task === "rally") setTask(world, "none");
      // ECON: its fields resow as the realm's switch says, and its stores come with it --
      // the people's own cellars, and for the first holding a winter's start besides.
      for (const p of h.plots) p.auto = e.autoSow;
      const first = ownedBy(world, f).length === 1;
      const gift: Partial<Record<StockId, number>> = { grain: h.population * CLAIM_GRAIN_PER_PERSON };
      // K11: the first holding's gift is the difficulty's share of it.
      if (first) for (const st of STOCK_IDS) gift[st] = (gift[st] ?? 0) + floor(((FIRST_HOLDING_STORES[st] ?? 0) * world.tuning.firstStoresPct) / 100);
      receive(e, book, gift, "finds");
      world.events.push({ kind: "claimed", holding: h.id, faction: f });
      return null;
    }
    case "setTax": {
      const targets = order.holding === 0 ? ownedBy(world, f) : [world.holding(order.holding) as Holding];
      if (order.holding === 0) e.defaultTax = order.rate;
      for (const h of targets) {
        h.tax = order.rate;
        world.events.push({ kind: "taxSet", holding: h.id, rate: order.rate });
      }
      if (order.holding === 0 && targets.length === 0) world.events.push({ kind: "taxSet", holding: 0, rate: order.rate });
      return null;
    }
    case "build": {
      const h = world.holding(order.holding) as Holding;
      const def = BUILDINGS[order.building];
      const { slot } = slotFor(h, def);
      pay(e, book, def.cost, "construction");
      h.buildings[slot] = def.id;
      h.works[slot] = def.days;
      h.idle[slot] = false;
      world.events.push({ kind: "buildingStarted", holding: h.id, slot, building: def.id });
      return null;
    }
    case "sow": {
      const { holding: h, plot: p } = findPlot(world, order.plot)!;
      const crop = CROPS[order.crop];
      pay(e, book, seedCost(crop, h), "seed");
      p.crop = crop.id;
      setPlot(world, h, p, "sown", "sown");
      return null;
    }
    case "harvest": {
      const { holding: h, plot: p } = findPlot(world, order.plot)!;
      reap(world, f, h, p, "harvested");
      return null;
    }
    case "repairWalls": {
      // K10: paid now for every quarter battered; the masons work it off by the day.
      const h = world.holding(order.holding) as Holding;
      pay(e, book, wallRepairCost(h), "construction");
      h.mend = h.walls;
      world.events.push({ kind: "wallsRepairing", holding: h.id, faction: f });
      return null;
    }
    case "setAutoSow": {
      const crop = order.crop;
      const targets = order.holding === 0 ? ownedBy(world, f) : [world.holding(order.holding) as Holding];
      if (order.holding === 0) e.autoSow = crop;
      for (const h of targets) {
        for (const p of h.plots) if (order.plot === 0 || p.id === order.plot) p.auto = crop;
      }
      world.events.push({ kind: "autoSowSet", holding: order.holding, plot: order.plot, crop });
      return null;
    }
  }
}

/**
 * Reap a ripe plot into its lord's stores: the yield at the plot's health
 * and the farm's bonus, times one draw of harvest luck from the economy's
 * own stream. The order's harvest and the day's auto-harvest are this one
 * function, so a field reaped by itself yields exactly what a hand would.
 */
function reap(world: KingdomWorld, f: number, h: Holding, p: FieldPlot, cause: "harvested" | "autoReaped"): void {
  const full = expectedYield(world, h, p);
  const luck = 100 - HARVEST_VARIANCE_PCT + world.rng.economy.int(2 * HARVEST_VARIANCE_PCT + 1);
  const gains: Partial<Record<StockId, number>> = {};
  for (const s of STOCK_IDS) {
    const v = full[s] ?? 0;
    if (v) gains[s] = floor((v * luck) / 100);
  }
  receive(world.economy[f], world.books[f], gains, "harvest");
  setPlot(world, h, p, "harvested", cause);
  world.events.push({ kind: "harvested", holding: h.id, plot: p.id, gains });
}

// -- the day ---------------------------------------------------------------------------

/**
 * ECON: K3's farm weather is gone (no draw decides a field's fate), but its
 * one draw of the weather stream a day is still made, so the weather that
 * follows -- and every realm's marches through it -- is what it always was.
 */
function keepFarmWeatherDraw(world: KingdomWorld): void {
  world.rng.weather.int(100);
}

function growPlots(world: KingdomWorld, d: CalendarDate): void {
  const s = d.season;
  for (const h of world.holdings) {
    for (const p of h.plots) {
      if (p.crop === null) continue;
      const crop = CROPS[p.crop as CropId];
      switch (p.stage) {
        case "sown":
          if (crop.grows.includes(s) && ++p.days >= GERMINATION_DAYS) setPlot(world, h, p, "growing", "sprouted");
          break;
        case "growing":
          if (crop.grows.includes(s)) {
            p.days++;
            p.progress = p.days / crop.growDays;
            if (p.days >= crop.growDays) {
              setPlot(world, h, p, "ripe", "ripened");
              // ECON (owner: "the fields should be auto harvested"): a ripe
              // field of a lord who keeps stores is reaped the day it ripens.
              const f = h.owner === null ? -1 : FACTION_IDS.indexOf(h.owner);
              if (f >= 0 && economyActive(world, f)) reap(world, f, h, p, "autoReaped");
            }
          }
          break;
        case "ripe":
          if (++p.days > crop.ripeDays) setPlot(world, h, p, "spoiled", "overripe");
          break;
        default:
          break;
      }
    }
  }
}

/** The first day of a season: winter kills, orchards wake, towns grow or shrink, the muster. */
function turnSeason(world: KingdomWorld, d: CalendarDate): void {
  for (const h of world.holdings) {
    for (const p of h.plots) {
      if (p.crop === null) continue;
      const crop = CROPS[p.crop as CropId];
      const inGround = p.stage === "sown" || p.stage === "growing" || p.stage === "ripe";
      if (d.season === "winter" && inGround && !crop.hardy) setPlot(world, h, p, "spoiled", "winter");
      if (d.season === "spring" && p.stage === "harvested" && crop.regrowDays) {
        setPlot(world, h, p, "growing", "regrew");
        p.days = crop.growDays - crop.regrowDays;
        p.progress = p.days / crop.growDays;
      }
    }
  }
  for (let f = 0; f < FACTION_IDS.length; f++) {
    if (!economyActive(world, f)) continue;
    const e = world.economy[f];
    const book = world.books[f];
    for (const h of ownedBy(world, f)) {
      if (h.famine > 0 || h.population === 0) continue;
      const g = TAX_RATES[TAX_RATE_IDS.indexOf(h.tax)].growthPct;
      h.population += g >= 0 ? floor((h.population * g) / 100) : -ceil((h.population * -g) / 100);
      let pct = MUSTER_PCT;
      for (const b of standing(h)) if (!h.idle[b.slot]) pct += (MUSTER_PCT * (b.def.economy.musterPct ?? 0)) / 100;
      pct += (MUSTER_PCT * musterPct(world, f)) / 100;
      const n = min(h.population, floor((h.population * pct) / 100));
      h.population -= n;
      credit(e, book, "levy", n, "muster");
      // K6: conscription stirs the town that gave its sons (PLAN §B.6).
      if (n > 0) moveUnrest(world, h, MUSTER_UNREST);
    }
    seasonalBoons(world, f);
  }
}

/**
 * ECON (owner: "the king can automatically make them sowed"): every open
 * field of the faction set to resow itself is sown with its crop, paying the
 * seed from the stores, on the first day its season, its seed and the
 * calendar allow (autoSowWaits). In holding and plot id order, so a short
 * seed store goes to the first fields first, the same every run.
 */
function autoSow(world: KingdomWorld, f: number): void {
  const e = world.economy[f];
  const book = world.books[f];
  for (const h of ownedBy(world, f)) {
    for (const p of h.plots) {
      if (autoSowWaits(world, h, p) !== null) continue;
      const crop = CROPS[p.auto as CropId];
      pay(e, book, seedCost(crop, h), "seed");
      p.crop = crop.id;
      setPlot(world, h, p, "sown", "autoSown");
    }
  }
}

function buildAndProduce(world: KingdomWorld, f: number): void {
  const e = world.economy[f];
  const book = world.books[f];
  for (const h of ownedBy(world, f)) {
    // K10: masons paid to mend the walls work at them a day's share at a time.
    if (h.mend > 0) {
      const m = min(h.mend, h.walls, WALL_REPAIR.perDay);
      h.walls -= m;
      h.mend -= m;
      if (h.walls === 0) {
        h.mend = 0;
        world.events.push({ kind: "wallsMended", holding: h.id });
      }
    }
    for (let i = 0; i < h.buildings.length; i++) {
      const id = h.buildings[i];
      if (id === null) continue;
      const def = BUILDINGS[id as BuildingId];
      if (h.works[i] > 0) {
        h.works[i]--;
        if (h.works[i] === 0) world.events.push({ kind: "built", holding: h.id, slot: i, building: id });
        continue;
      }
      const wasIdle = h.idle[i];
      if (!canAfford(e, def.upkeep)) {
        h.idle[i] = true;
        if (!wasIdle) world.events.push({ kind: "upkeepUnpaid", holding: h.id, slot: i, building: id });
        continue;
      }
      pay(e, book, def.upkeep, "upkeep");
      h.idle[i] = false;
      const eco = def.economy;
      if (eco.produces) {
        if (eco.consumes && !canAfford(e, eco.consumes)) continue;
        if (eco.consumes) pay(e, book, eco.consumes, "materials");
        const wood = eco.byWood ? BIOME_ECONOMY[h.biome].wood : 100;
        for (const s of STOCK_IDS) credit(e, book, s, floor(((eco.produces[s] ?? 0) * wood) / 100), "production");
      }
      if (eco.trade) {
        const roads = world.graph.links.get(h.id)?.length ?? 0;
        const coin = eco.trade.base + eco.trade.perRoad * roads + (eco.trade.perPeople ? floor(h.population / eco.trade.perPeople) : 0);
        credit(e, book, "coin", coin, "trade");
      }
    }
  }
}

function collectTaxes(world: KingdomWorld, f: number): void {
  const e = world.economy[f];
  const book = world.books[f];
  const bonus = taxPct(world, f);
  for (const h of ownedBy(world, f)) {
    if (h.famine > 0) continue;
    // K6, the lesser threshold of unrest: a restless town pays half.
    const half = h.unrest >= RESTLESS_AT ? 2 : 1;
    const owed = floor(withPct(h.population * TAX_RATES[TAX_RATE_IDS.indexOf(h.tax)].per100, bonus) / half) + h.taxCarry;
    const coin = floor(owed / 100);
    h.taxCarry = owed - coin * 100;
    credit(e, book, "coin", coin, "tax");
    // K8: a crown town feeds itself (drawsDole) and pays its lord a tithe in
    // grain besides the coin -- the steward's armies' bread. Booked as tax:
    // it is one, paid in kind (docs/PROVISIONAL.md K8.3).
    if (!drawsDole(f)) credit(e, book, "grain", floor((h.population * CROWN_TITHE_PER_100) / half / 100), "tax");
  }
}

function kingAtWork(world: KingdomWorld, d: CalendarDate): void {
  const k = world.king;
  if (k.task === "none") return;
  const m = k.mover;
  if (m.road !== 0 || m.route.length > 0) { setTask(world, "none"); return; }
  const h = world.holding(m.node) as Holding;
  const e = world.economy[KING_PLAYER];
  const book = world.books[KING_PLAYER];
  if (k.task === "forage") {
    const people = partySize(world, KING_PLAYER);
    const eco = BIOME_ECONOMY[h.biome];
    const grain = withPct(floor((people * FORAGE_PER_PERSON[d.season] * eco.fertility) / 100), foragePct(world, KING_PLAYER) + world.tuning.forageBonusPct);
    const timber = floor((people * eco.wood) / (100 * FORAGERS_PER_TIMBER));
    credit(e, book, "grain", grain, "forage");
    credit(e, book, "timber", timber, "forage");
    k.taskDays++;
    world.events.push({ kind: "foraged", grain, timber });
    return;
  }
  // Rally: checked again every day, since the hamlet empties as it gives.
  const floorPop = rallyFloor(world, h);
  if (h.owner !== null || h.kind !== "hamlet" || h.population <= floorPop) {
    setTask(world, "none");
    world.events.push({ kind: "rallyDone", holding: h.id });
    return;
  }
  const n = min(max(1, floor(h.population / RALLY_PEOPLE_PER_FOLLOWER)), h.population - floorPop);
  h.population -= n;
  credit(e, book, "levy", n, "rally");
  for (const s of STOCK_IDS) credit(e, book, s, (RALLY_BRINGS[s] ?? 0) * n, "rally");
  k.taskDays++;
  world.events.push({ kind: "rallied", holding: h.id, followers: n });
}

/**
 * People lost to the famine's `days`-th day. FAMINE_LOSS_PCT of the
 * population a day, spread over the famine's days with no stored carry:
 * day n loses floor(n*pop*pct/100) - floor((n-1)*pop*pct/100), so a hamlet
 * of 30 at 2% loses a soul about every other day, a town of 600 twelve a day.
 */
export function famineDeaths(population: number, days: number): number {
  if (population <= 0 || days <= 0) return 0;
  const per = population * FAMINE_LOSS_PCT;
  return min(population, floor((days * per) / 100) - floor(((days - 1) * per) / 100));
}

/**
 * Everyone eats: the king's party first in the ledger order but not in
 * priority -- when the grain is short it is shared in proportion to need,
 * and everyone who got less than they needed is in famine.
 */
function eat(world: KingdomWorld, f: number, season: Season): void {
  const e = world.economy[f];
  const book = world.books[f];
  const holdings = ownedBy(world, f);
  const party = partySize(world, f) * PARTY_RATION;
  const draws = holdings.map((h) => (drawsDole(f) ? doleDue(h, season, dolePct(world, f)) : { draw: 0, carry: 0 }));
  let total = party;
  for (const d of draws) total += d.draw;
  const grain = e.stocks.grain;
  const short = grain < total;
  const share = (need: number): number => (short ? floor((grain * need) / total) : need);

  const partyGot = share(party);
  debit(e, book, "grain", partyGot, "retinue");
  const partyShort = partyGot < party;
  if (partyShort !== e.hunger > 0) world.events.push({ kind: "famine", faction: f, holding: 0, days: partyShort ? 1 : 0 });
  e.hunger = partyShort ? e.hunger + 1 : 0;

  holdings.forEach((h, i) => {
    const got = share(draws[i].draw);
    debit(e, book, "grain", got, "food");
    h.doleCarry = draws[i].carry;
    // Rationing is shared, so a short day is a hungry day for every holding,
    // even one whose dole happens to round to nothing today (the carry) --
    // otherwise famine would flicker off on those days.
    const starving = h.population > 0 && (short || got < draws[i].draw);
    if (starving !== h.famine > 0) world.events.push({ kind: "famine", faction: f, holding: h.id, days: starving ? 1 : 0 });
    h.famine = starving ? h.famine + 1 : 0;
    if (starving) h.population -= famineDeaths(h.population, h.famine);
  });
}

function spoil(world: KingdomWorld, f: number): void {
  debitUpTo(world.economy[f], world.books[f], "grain", grainStores(world, f).spoilsToday, "spoilage");
}

/**
 * The economy's day. Called by KingdomWorld.tick on the first tick of each
 * day, after the weather is rolled and before the day's orders apply.
 */
export function runEconomyDay(world: KingdomWorld): void {
  const d = world.date;
  const before = world.economy.map((e, f) => (economyActive(world, f) ? snapshotStocks(e).join() : ""));
  for (let f = 0; f < FACTION_IDS.length; f++) {
    const book = world.books[f];
    if (book.open.day !== d.day) turnPage(book, d.day, world.economy[f]);
  }

  keepFarmWeatherDraw(world);
  if (d.dayOfSeason === 0 && d.day > 0) turnSeason(world, d);
  growPlots(world, d);

  for (let f = 0; f < FACTION_IDS.length; f++) {
    if (!economyActive(world, f)) continue;
    // ECON: fields set to resow themselves are sown (after the day's harvest, before the day's bread).
    autoSow(world, f);
    buildAndProduce(world, f);
    collectTaxes(world, f);
    creditDailyBoons(world, f);
    if (f === KING_PLAYER) kingAtWork(world, d);
    eat(world, f, d.season);
    spoil(world, f);
  }
  world.economy.forEach((e, f) => {
    if (economyActive(world, f) && snapshotStocks(e).join() !== before[f]) world.events.push({ kind: "stocksChanged", faction: f });
  });
}

/** The ledger entry point for legitimacy, for K6 and the story (K9). */
export function changeLegitimacy(world: KingdomWorld, faction: number, delta: number, category: "deeds" | "disgrace"): number {
  return adjustLegitimacy(world.economy[faction], world.books[faction], delta, category);
}
