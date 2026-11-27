/**
 * The kingdom map's ground: biomes, road surfaces, kinds of holding, weather.
 *
 * Plain tables. Nothing here branches; the sim reads a row by id.
 */

import type { LevelDef } from "../levels/proving-ground.ts";

// -- biomes --------------------------------------------------------------------

export type BiomeId =
  | "reach" | "vale" | "forest" | "river" | "river-town" | "city"
  | "open" | "highland" | "moor" | "border-hills" | "coast";

export type BiomeDef = {
  readonly id: BiomeId;
  readonly name: string;
  /**
   * The existing battlefield this country fights like (src/content/levels).
   *
   * A battle at a holding (K5) takes this level's size, clock, `country`,
   * night and flood, and generates its ground from the HOLDING's own seed, so
   * every node has its own field but each biome keeps the character its level
   * was picked for. Levels are reused rather than duplicated: one rulebook.
   */
  readonly level: LevelDef["id"];
};

export const BIOMES: Record<BiomeId, BiomeDef> = {
  reach: { id: "reach", name: "cold, sparse, broken country", level: "night-stones" },
  vale: { id: "vale", name: "a wide river valley", level: "proving-ground" },
  forest: { id: "forest", name: "deep woodland", level: "long-vigil" },
  river: { id: "river", name: "bridged river country", level: "the-crossing" },
  "river-town": { id: "river-town", name: "a river town and its roads", level: "ferry-road" },
  city: { id: "city", name: "heights before a walled city", level: "last-wall" },
  open: { id: "open", name: "open farmland", level: "open-field" },
  highland: { id: "highland", name: "highland ridges", level: "high-ground" },
  moor: { id: "moor", name: "stone-strewn moor", level: "night-stones" },
  "border-hills": { id: "border-hills", name: "rain-fed border hills", level: "rising-water" },
  coast: { id: "coast", name: "open downs above the sea", level: "the-colours" },
};

export const BIOME_IDS = Object.keys(BIOMES) as readonly BiomeId[];

// -- roads ---------------------------------------------------------------------

export type RoadTerrainId = "highway" | "road" | "track" | "forest" | "ford" | "ferry" | "moor" | "pass";

export type RoadTerrainDef = {
  readonly id: RoadTerrainId;
  readonly name: string;
  /**
   * Effort per mile, relative to a plain road. Travel time along an edge is
   * length x cost / speed, so a pass at 2.0 takes twice as long as the same
   * distance of road. The router minimises the same product, so the cheapest
   * route is also the quickest.
   */
  readonly cost: number;
};

export const ROAD_TERRAIN: Record<RoadTerrainId, RoadTerrainDef> = {
  highway: { id: "highway", name: "the king's highway", cost: 0.8 },
  road: { id: "road", name: "road", cost: 1.0 },
  track: { id: "track", name: "cart track", cost: 1.4 },
  forest: { id: "forest", name: "forest ride", cost: 1.7 },
  ford: { id: "ford", name: "ford", cost: 1.6 },
  ferry: { id: "ferry", name: "ferry crossing", cost: 1.5 },
  moor: { id: "moor", name: "moor path", cost: 1.8 },
  pass: { id: "pass", name: "hill pass", cost: 2.0 },
};

/** Hash code of a road surface is its index here. Append only. */
export const ROAD_TERRAIN_IDS: readonly RoadTerrainId[] = [
  "highway", "road", "track", "forest", "ford", "ferry", "moor", "pass",
];

// -- kinds of holding ------------------------------------------------------------

export type HoldingKind = "hamlet" | "village" | "town" | "keep" | "city";

export type HoldingKindDef = {
  readonly id: HoldingKind;
  /** Typical people, used when a holding does not give its own. */
  readonly population: number;
  /** Armies that can stand garrison here (K4). */
  readonly garrisonSlots: number;
  /** Buildings that fit (K3). */
  readonly buildingSlots: number;
  /** Fields round it that can be planted (K3). */
  readonly fieldPlots: number;
};

export const HOLDING_KINDS: Record<HoldingKind, HoldingKindDef> = {
  hamlet: { id: "hamlet", population: 50, garrisonSlots: 0, buildingSlots: 1, fieldPlots: 2 },
  village: { id: "village", population: 240, garrisonSlots: 1, buildingSlots: 2, fieldPlots: 3 },
  town: { id: "town", population: 1200, garrisonSlots: 2, buildingSlots: 4, fieldPlots: 4 },
  keep: { id: "keep", population: 300, garrisonSlots: 3, buildingSlots: 3, fieldPlots: 2 },
  city: { id: "city", population: 9000, garrisonSlots: 4, buildingSlots: 6, fieldPlots: 3 },
};

// -- weather -------------------------------------------------------------------

export type Season = "spring" | "summer" | "autumn" | "winter";
export const SEASONS: readonly Season[] = ["spring", "summer", "autumn", "winter"];

/**
 * ECON: the twelve months of the realm's year, three to a season, in the
 * year's order (spring first, as SEASONS). Thirty days each
 * (sim/kingdom/clock.ts DAYS_PER_MONTH). Names of the Reach's own making
 * rather than the real ones, because the real year begins mid-winter and this
 * one, like the seasons the sim counts, begins at the thaw
 * (docs/PROVISIONAL.md ECON.1). Placeholder names; change them freely.
 */
export type MonthDef = { readonly name: string; readonly season: Season };
export const MONTHS: readonly MonthDef[] = [
  { name: "Thawmoon", season: "spring" }, { name: "Seedmoon", season: "spring" }, { name: "Blossommoon", season: "spring" },
  { name: "Sunmoon", season: "summer" }, { name: "Haymoon", season: "summer" }, { name: "Reapmoon", season: "summer" },
  { name: "Harvestmoon", season: "autumn" }, { name: "Leafmoon", season: "autumn" }, { name: "Mistmoon", season: "autumn" },
  { name: "Frostmoon", season: "winter" }, { name: "Snowmoon", season: "winter" }, { name: "Wolfmoon", season: "winter" },
];

export type WeatherId = "clear" | "rain" | "fog" | "storm" | "snow";

export type WeatherDef = {
  readonly id: WeatherId;
  readonly name: string;
  /**
   * Multiplier on the effort of every mile marched today. Kingdom-wide and
   * the same on every road, so it changes WHEN you arrive, never WHICH way is
   * quickest -- the router can ignore it and stay a pure function of the map.
   */
  readonly travel: number;
};

export const WEATHER: Record<WeatherId, WeatherDef> = {
  clear: { id: "clear", name: "clear", travel: 1.0 },
  rain: { id: "rain", name: "rain", travel: 1.3 },
  fog: { id: "fog", name: "fog", travel: 1.1 },
  storm: { id: "storm", name: "storm", travel: 1.6 },
  snow: { id: "snow", name: "snow", travel: 1.8 },
};

/** Hash code of a weather is its index here. Append only. */
export const WEATHER_IDS: readonly WeatherId[] = ["clear", "rain", "fog", "storm", "snow"];

/**
 * Relative odds of each weather by season, in WEATHER_IDS order.
 *
 * Integers, so the roll is an exact integer draw with no float boundary to
 * argue about. Snow only in winter is what makes winter the pressure of Act I
 * (PLAN.md §A.5): the roads close up exactly when the grain runs short.
 */
export const WEATHER_ODDS: Record<Season, readonly number[]> = {
  spring: [5, 4, 2, 1, 0],
  summer: [9, 2, 1, 1, 0],
  autumn: [4, 4, 3, 1, 0],
  winter: [3, 1, 2, 1, 5],
};

/**
 * Chance that today simply keeps yesterday's weather, if the season allows it.
 * Weather comes in spells, not in independent coin flips.
 */
export const WEATHER_PERSISTENCE = 0.55;
