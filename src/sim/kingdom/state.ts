/**
 * Kingdom state: plain records, mutated only by KingdomWorld.tick().
 *
 * Every entity -- holding, road, field plot, the king's retinue, and from K4
 * every army -- takes its id from the world's single monotonic counter, and
 * every list here is kept in id order, so "for each holding" means the same
 * sequence on every machine without anyone having to remember to sort.
 *
 * Fields that later phases fill are present now as empty placeholders, so the
 * save format and the hash already cover them and K3/K4 change their
 * contents, not their shape.
 */

import type { FactionId } from "../../content/kingdom/factions.ts";
import type { BiomeId, HoldingKind, RoadTerrainId } from "../../content/kingdom/terrain.ts";
import type { ProvinceId } from "../../content/kingdom/map.ts";
import type { FarmEventId, StockId, TaxRateId } from "../../content/kingdom/economy.ts";

/** The life of a field plot (PLAN.md §B.3; the transitions are in content/kingdom/crops.ts). */
export type PlotStage = "empty" | "sown" | "growing" | "ripe" | "harvested" | "spoiled";
/** Hash code of a stage is its index. Append only. */
export const PLOT_STAGES: readonly PlotStage[] = ["empty", "sown", "growing", "ripe", "harvested", "spoiled"];

export type FieldPlot = {
  readonly id: number;
  /** Crop id from content/kingdom/crops.ts; null while empty. Kept through harvested/spoiled, for the record. */
  crop: string | null;
  stage: PlotStage;
  /**
   * 0..1 through the growing stage. DERIVED from `days` (days / growDays) and
   * written whenever `days` changes, never accumulated, so it is exact.
   */
  progress: number;
  /**
   * Days counted in the current stage: sown -> germination days, growing ->
   * growing-season days, ripe -> days standing ripe.
   */
  days: number;
  /** 0..100: what weather has left of the crop. The yield is scaled by it; 0 spoils it. */
  health: number;
};

export type Holding = {
  readonly id: number;
  /** The content key; what a save and the story refer to. */
  readonly key: string;
  readonly name: string;
  readonly province: ProvinceId;
  readonly kind: HoldingKind;
  readonly biome: BiomeId;
  readonly x: number;
  readonly y: number;
  /** A battle here generates its ground from this (with the biome's level). */
  readonly seed: number;
  /** Null while unclaimed. */
  owner: FactionId | null;
  population: number;
  /** How many armies may stand garrison. */
  readonly garrisonSlots: number;
  /** Ids of armies standing garrison (K4). Never longer than garrisonSlots. */
  garrison: number[];
  /** One entry per building slot: a building id (content/kingdom/buildings.ts), or null for empty. */
  buildings: (string | null)[];
  /** Per slot: days of work left on the building there; 0 = standing (or empty). */
  works: number[];
  /** Per slot: its upkeep went unpaid today, so it did nothing. Rewritten every day. */
  idle: boolean[];
  plots: FieldPlot[];
  /** Tax rate, for an owned holding (content TAX_RATES). */
  tax: TaxRateId;
  /** Pennies of tax owed but not yet a whole coin, x100 (see content/kingdom/economy.ts UNITS). */
  taxCarry: number;
  /** Grain of dole drawn but not yet a whole grain, x100. */
  doleCarry: number;
  /**
   * Consecutive days this holding has gone short of bread. 0 = fed. THE famine
   * signal: K6 turns it into unrest, K4 into desertion of a garrison.
   */
  famine: number;
};

/**
 * One faction's stores and soft stats (PLAN.md §B.3). Kept for every faction
 * in FACTION_IDS order. Only factions whose economy runs (economy.ts
 * ECONOMY_FACTIONS) see them move in K3; the captains' stores wait for K8's
 * stewards.
 */
export type FactionEconomy = {
  readonly stocks: Record<StockId, number>;
  /** Soft stat, 0..LEGITIMACY_MAX. K6 writes its rules; the ledger already records it. */
  legitimacy: number;
  /**
   * Consecutive days the faction's own party (for the king: the king, the
   * companions and the levy following him) has gone short. 0 = fed. The
   * party's famine signal, beside each holding's own; K4 turns it into
   * desertion and attrition.
   */
  hunger: number;
  /** The rate a holding this faction claims starts at; setTax on the realm sets it. */
  defaultTax: TaxRateId;
};

/** What the king's party is doing where it stands (the from-nothing start, §A.5). */
export type KingTask = "none" | "forage" | "rally";
/** Hash code is the index. Append only. */
export const KING_TASKS: readonly KingTask[] = ["none", "forage", "rally"];

export type Road = {
  readonly id: number;
  /** Holding ids of the two ends, a < b. */
  readonly a: number;
  readonly b: number;
  readonly terrain: RoadTerrainId;
  /** Miles, end to end. */
  readonly length: number;
  /** Effort per mile (content ROAD_TERRAIN). Travel effort = length x cost. */
  readonly cost: number;
};

/**
 * Something that travels the road graph: the king's retinue now, armies from
 * K4. Flat fields rather than a union so the hash and the save read the same
 * shape whatever the mover is doing.
 *
 * Exactly one of `node` and `road` is non-zero (ids start at 1):
 *  - at a holding: node = its id, road = 0;
 *  - on a road:    road = its id, travelling from `from` toward `to`,
 *                  `along` miles from `from` -- continuous, so two movers can
 *                  meet halfway between towns (K5 contact).
 */
export type Mover = {
  node: number;
  road: number;
  from: number;
  to: number;
  along: number;
  /**
   * Holdings still to reach, in order. When on a road, route[0] is `to`.
   * Empty when standing still -- including standing halfway along a road
   * after a halt.
   */
  route: number[];
};

/**
 * The exiled king and whoever is with him (PLAN.md §A.5, "start from
 * nothing"): no holding, no army, no coin -- just the king and Brother Aldous
 * at a node of the map. K4 lets this retinue rally followers into an army.
 */
export type KingToken = {
  readonly id: number;
  /** Chosen at the start (docs/PROVISIONAL.md A.7.3). */
  readonly name: string;
  /** Named people travelling with the king. */
  companions: string[];
  mover: Mover;
  /** Foraging or rallying at the holding he stands in; cleared by marching or halting. */
  task: KingTask;
  /** Whole days spent on the task so far. */
  taskDays: number;
};

/**
 * Something that happened during a tick, for the UI and the chronicle.
 * Transient: rebuilt every tick, never saved, never hashed -- everything it
 * reports is already in the state.
 */
export type KingdomEvent =
  | { kind: "dayBegan"; day: number; weather: string }
  | { kind: "kingDeparted"; from: number; to: number }
  | { kind: "kingArrived"; at: number; destination: boolean }
  | { kind: "orderRejected"; order: { kind: string; player: number; seq: number }; reason: string }
  // -- K3: the economy -----------------------------------------------------------
  /** A faction's stocks changed this tick (the resources bar listens for this). */
  | { kind: "stocksChanged"; faction: number }
  /** Drought, frost or flood today (kingdom-wide; flood only harms flood country). */
  | { kind: "farmWeather"; event: FarmEventId }
  | { kind: "plotStage"; holding: number; plot: number; stage: PlotStage; cause: PlotCause }
  | { kind: "built"; holding: number; slot: number; building: string }
  | { kind: "buildingStarted"; holding: number; slot: number; building: string }
  | { kind: "upkeepUnpaid"; holding: number; slot: number; building: string }
  /** Famine began (days === 1) or ended (days === 0) at a holding, or for the party (holding 0). */
  | { kind: "famine"; faction: number; holding: number; days: number }
  | { kind: "foraged"; grain: number; timber: number }
  | { kind: "rallied"; holding: number; followers: number }
  /** A rally at a hamlet that has no more to give. */
  | { kind: "rallyDone"; holding: number }
  | { kind: "claimed"; holding: number; faction: number }
  | { kind: "harvested"; holding: number; plot: number; gains: Partial<Record<StockId, number>> }
  | { kind: "taxSet"; holding: number; rate: TaxRateId }
  | { kind: "taskSet"; task: KingTask; holding: number };

/** Why a plot changed stage, for the feed. */
export type PlotCause = "sown" | "sprouted" | "ripened" | "harvested" | "overripe" | "weather" | "winter" | "regrew";
