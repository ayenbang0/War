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

/** The life of a field plot (PLAN.md §B.3). K1 only ever has "empty". */
export type PlotStage = "empty" | "sown" | "growing" | "ripe" | "harvested" | "spoiled";
/** Hash code of a stage is its index. Append only. */
export const PLOT_STAGES: readonly PlotStage[] = ["empty", "sown", "growing", "ripe", "harvested", "spoiled"];

export type FieldPlot = {
  readonly id: number;
  /** Crop id from content/kingdom/crops.ts (K3); null while empty. */
  crop: string | null;
  stage: PlotStage;
  /** 0..1 through the growing stage. */
  progress: number;
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
  /** One entry per building slot: a building id (K3), or null for empty. */
  buildings: (string | null)[];
  plots: FieldPlot[];
};

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
  | { kind: "orderRejected"; order: { kind: string; player: number; seq: number }; reason: string };
