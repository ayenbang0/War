/**
 * The authored map of Rimaros (PLAN.md §A.3, §B.2).
 *
 * Eleven provinces round the Crown Seat, plus the Farthest Reach where the king
 * begins, plus (K3a) three wild countries nobody governs: 72 holdings joined
 * by roads (docs/PROVISIONAL.md B.12.2, the user's "twice the map"). This is the
 * campaign map; a seeded procedural graph for skirmish comes later and only has
 * to produce a KingdomMapDef of the same shape.
 *
 * Coordinates are in miles on a 1000 x 700 table, x east and y south. The
 * Reach is the cold north-west corner, the Crown Seat sits in the middle on
 * its rivers, and the Red March is the eastern border the coup came over.
 *
 * Plain data. The sim gives each holding, road and field plot an entity id at
 * world creation, in the order written here, so reordering this file reorders
 * ids -- which a saved game notices and refuses (see sim/kingdom/save.ts).
 */

import type { FactionId } from "./factions.ts";
import type { BiomeId, HoldingKind, RoadTerrainId } from "./terrain.ts";

export type ProvinceId =
  | "farthest-reach" | "vale-of-the-hare" | "long-wood" | "lisle-bridges" | "hallow-ferry"
  | "crown-seat" | "open-fields" | "stag-wolf" | "red-march" | "crows-reach"
  // K3a: the wild country nobody governs, worth exploring (PLAN.md §B.11a).
  | "grey-wold" | "iron-fells" | "the-saltings";

/**
 * What an exploration site is (K3a). The first time a faction's party sets
 * foot in one, an event is drawn for it from content/story/events.ts -- from
 * the events of the site's kind and the events that fit anywhere -- and the
 * party halts there to read it. A holding with no `site` is ordinary ground.
 */
export type SiteKind = "ruin" | "shrine" | "mine" | "forest" | "coast" | "fort";
/** Hash and save order. Append only. */
export const SITE_KINDS: readonly SiteKind[] = ["ruin", "shrine", "mine", "forest", "coast", "fort"];

export type ProvinceDef = {
  readonly id: ProvinceId;
  readonly name: string;
  /** The usual country here; a holding may override it. */
  readonly biome: BiomeId;
  /**
   * Who governs it at the start. Empty for the Reach, which nobody bothered
   * to take. Two for the Heights and the Moor, which A.3 gives one row and two
   * captains: the Stag holds the Heights, the Wolf the Moor.
   */
  readonly governors: readonly FactionId[];
  /** The act of the story it belongs to (PLAN.md §A.3, §A.5). */
  readonly act: 1 | 2 | 3 | 4;
};

export type HoldingDef = {
  /** Stable name for saves and story data. Never shown. */
  readonly key: string;
  readonly name: string;
  readonly province: ProvinceId;
  readonly kind: HoldingKind;
  readonly x: number;
  readonly y: number;
  /** Who holds it at the start; null for unclaimed. */
  readonly owner: FactionId | null;
  /** The province's seat: its governor's hall. */
  readonly seat?: boolean;
  /** Overrides the province's biome. */
  readonly biome?: BiomeId;
  /** Overrides the kind's typical population. */
  readonly population?: number;
  /** Overrides the derived battlefield seed (see holdingSeed). */
  readonly seed?: number;
  /** An exploration site (K3a): its first visit draws an event of this kind. */
  readonly site?: SiteKind;
};

export type RoadDef = readonly [a: string, b: string, terrain: RoadTerrainId];

export type KingdomMapDef = {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly provinces: readonly ProvinceDef[];
  readonly holdings: readonly HoldingDef[];
  readonly roads: readonly RoadDef[];
  /** Where the exiled king stands on day one. */
  readonly start: string;
  /** The holding whose taking ends the war (Act IV). */
  readonly crownSeat: string;
  /**
   * What the exiled king already knows on day one (K3a fog): holdings he
   * remembers, as "known" (remembered, not seen). A road is remembered when
   * both its ends are. Everything else is unknown until his party sees it.
   */
  readonly startKnown: readonly string[];
};

const PROVINCES: readonly ProvinceDef[] = [
  { id: "farthest-reach", name: "The Farthest Reach", biome: "reach", governors: [], act: 1 },
  { id: "vale-of-the-hare", name: "The Vale of the Hare", biome: "vale", governors: ["hare"], act: 1 },
  { id: "long-wood", name: "The Long Wood", biome: "forest", governors: ["boar"], act: 2 },
  { id: "lisle-bridges", name: "The Lisle Bridges", biome: "river", governors: ["badger"], act: 2 },
  { id: "hallow-ferry", name: "Hallow Ferry", biome: "river-town", governors: ["owl"], act: 2 },
  { id: "red-march", name: "The Red March", biome: "border-hills", governors: ["margrave"], act: 2 },
  { id: "open-fields", name: "The Open Fields", biome: "open", governors: ["fox"], act: 3 },
  { id: "stag-wolf", name: "Stag Heights and Wolf Moor", biome: "highland", governors: ["stag", "wolf"], act: 3 },
  { id: "crows-reach", name: "Crow's Reach", biome: "coast", governors: ["crow"], act: 3 },
  { id: "crown-seat", name: "Rimaros, the Crown Seat", biome: "city", governors: ["usurper"], act: 4 },
  // K3a: wild country. Nobody governs it, so nobody bothered to map it for
  // the usurper either; it is where ruins, shrines, mines and old forts wait.
  { id: "grey-wold", name: "The Grey Wold", biome: "moor", governors: [], act: 2 },
  { id: "iron-fells", name: "The Iron Fells", biome: "highland", governors: [], act: 3 },
  { id: "the-saltings", name: "The Saltings", biome: "coast", governors: [], act: 2 },
];

const HOLDINGS: readonly HoldingDef[] = [
  // The Farthest Reach: nobody's. The king begins at Cold Hearth with nothing;
  // the hamlets round it are where the first followers come from, and the
  // ruined keep at Rookstead is the first empty holding to claim (§A.5).
  { key: "cold-hearth", name: "Cold Hearth", province: "farthest-reach", kind: "hamlet", x: 100, y: 70, owner: null, population: 30 },
  { key: "greyshaw", name: "Greyshaw", province: "farthest-reach", kind: "hamlet", x: 170, y: 110, owner: null },
  { key: "thornwick", name: "Thornwick", province: "farthest-reach", kind: "hamlet", x: 95, y: 160, owner: null, population: 40 },
  { key: "fell-end", name: "Fell End", province: "farthest-reach", kind: "hamlet", x: 220, y: 60, owner: null, population: 35 },
  { key: "rookstead", name: "Rookstead", province: "farthest-reach", kind: "keep", x: 200, y: 175, owner: null, population: 0 },

  { key: "harrowfield", name: "Harrowfield", province: "vale-of-the-hare", kind: "town", x: 300, y: 250, owner: "hare", seat: true },
  { key: "linnet-cross", name: "Linnet Cross", province: "vale-of-the-hare", kind: "village", x: 340, y: 205, owner: "hare" },
  { key: "barrowmere", name: "Barrowmere", province: "vale-of-the-hare", kind: "hamlet", x: 250, y: 290, owner: "hare" },
  { key: "furrowby", name: "Furrowby", province: "vale-of-the-hare", kind: "village", x: 320, y: 305, owner: "hare" },

  { key: "boarsden", name: "Boarsden", province: "long-wood", kind: "keep", x: 190, y: 400, owner: "boar", seat: true },
  { key: "ashgrove", name: "Ashgrove", province: "long-wood", kind: "village", x: 230, y: 350, owner: "boar" },
  { key: "underbough", name: "Underbough", province: "long-wood", kind: "hamlet", x: 160, y: 465, owner: "boar" },

  { key: "lisle", name: "Lisle", province: "lisle-bridges", kind: "town", x: 410, y: 260, owner: "badger", seat: true },
  { key: "three-bridges", name: "Three Bridges", province: "lisle-bridges", kind: "village", x: 455, y: 225, owner: "badger" },
  { key: "sett-hollow", name: "Sett Hollow", province: "lisle-bridges", kind: "hamlet", x: 380, y: 310, owner: "badger" },

  { key: "hallow-ferry", name: "Hallow Ferry", province: "hallow-ferry", kind: "town", x: 380, y: 500, owner: "owl", seat: true },
  { key: "owlcote", name: "Owlcote", province: "hallow-ferry", kind: "hamlet", x: 325, y: 465, owner: "owl" },
  { key: "reedham", name: "Reedham", province: "hallow-ferry", kind: "village", x: 425, y: 545, owner: "owl" },

  { key: "rimaros", name: "Rimaros", province: "crown-seat", kind: "city", x: 520, y: 380, owner: "usurper", seat: true },
  { key: "kingsmere", name: "Kingsmere", province: "crown-seat", kind: "town", x: 465, y: 420, owner: "usurper" },
  { key: "chancery-hold", name: "Chancery Hold", province: "crown-seat", kind: "keep", x: 575, y: 345, owner: "usurper" },

  { key: "wideacre", name: "Wideacre", province: "open-fields", kind: "town", x: 560, y: 560, owner: "fox", seat: true },
  { key: "foxhollow", name: "Foxhollow", province: "open-fields", kind: "village", x: 500, y: 600, owner: "fox" },
  { key: "sheaving", name: "Sheaving", province: "open-fields", kind: "hamlet", x: 620, y: 610, owner: "fox" },
  { key: "meadsend", name: "Meadsend", province: "open-fields", kind: "village", x: 640, y: 520, owner: "fox" },

  { key: "stagcrown", name: "Stagcrown", province: "stag-wolf", kind: "keep", x: 680, y: 170, owner: "stag", seat: true },
  { key: "high-tarn", name: "High Tarn", province: "stag-wolf", kind: "village", x: 630, y: 220, owner: "stag" },
  { key: "wolfmere", name: "Wolfmere", province: "stag-wolf", kind: "keep", x: 760, y: 230, owner: "wolf", seat: true, biome: "moor" },
  { key: "bleakmoor", name: "Bleakmoor", province: "stag-wolf", kind: "hamlet", x: 730, y: 150, owner: "wolf", biome: "moor" },

  { key: "redcastle", name: "Redcastle", province: "red-march", kind: "keep", x: 880, y: 360, owner: "margrave", seat: true },
  { key: "tarnford", name: "Tarnford", province: "red-march", kind: "town", x: 800, y: 320, owner: "margrave" },
  { key: "marchgate", name: "Marchgate", province: "red-march", kind: "village", x: 850, y: 430, owner: "margrave" },
  { key: "embersike", name: "Embersike", province: "red-march", kind: "hamlet", x: 930, y: 300, owner: "margrave" },

  { key: "crowhaven", name: "Crowhaven", province: "crows-reach", kind: "town", x: 840, y: 590, owner: "crow", seat: true },
  { key: "gullwick", name: "Gullwick", province: "crows-reach", kind: "village", x: 780, y: 635, owner: "crow" },
  { key: "wrackhythe", name: "Wrackhythe", province: "crows-reach", kind: "hamlet", x: 905, y: 545, owner: "crow" },
  // -- K3a: twice the map (PLAN.md amendment 4, §B.11a) ------------------------
  // Appended after the first 36 so every earlier holding keeps its id; the
  // save migration (sim/kingdom/save.ts, v2 -> v3) moves everything else.
  // Sites (`site`) are found by going there; most are nobody's.

  // The Reach: four places round the exile's first hamlets, met in Act I.
  { key: "weather-tower", name: "Weather Tower", province: "farthest-reach", kind: "keep", x: 150, y: 25, owner: null, population: 0, site: "fort" },
  { key: "hermits-cell", name: "Hermit's Cell", province: "farthest-reach", kind: "hamlet", x: 35, y: 110, owner: null, population: 6, site: "shrine" },
  { key: "old-stone-ring", name: "Old Stone Ring", province: "farthest-reach", kind: "hamlet", x: 305, y: 88, owner: null, population: 0, site: "ruin" },
  { key: "sorrel-wood", name: "Sorrel Wood", province: "farthest-reach", kind: "hamlet", x: 125, y: 235, owner: null, population: 12, site: "forest" },

  // The Grey Wold: high bare country north of the Vale, between the Reach and the Heights.
  { key: "wold-barrow", name: "Wold Barrow", province: "grey-wold", kind: "hamlet", x: 365, y: 105, owner: null, population: 0, site: "ruin" },
  { key: "st-ebbas-well", name: "St Ebba's Well", province: "grey-wold", kind: "hamlet", x: 455, y: 50, owner: null, population: 10, site: "shrine" },
  { key: "greyfold", name: "Greyfold", province: "grey-wold", kind: "hamlet", x: 410, y: 160, owner: null, population: 45 },
  { key: "fallow-keep", name: "Fallow Keep", province: "grey-wold", kind: "keep", x: 545, y: 105, owner: null, population: 0, site: "fort" },
  { key: "hobs-delving", name: "Hob's Delving", province: "grey-wold", kind: "hamlet", x: 615, y: 45, owner: null, population: 20, site: "mine" },

  // The Iron Fells: the old mining country beyond the Moor, north of the March.
  { key: "the-forgeworks", name: "The Forgeworks", province: "iron-fells", kind: "hamlet", x: 795, y: 70, owner: null, population: 0, site: "ruin" },
  { key: "embermouth", name: "Embermouth", province: "iron-fells", kind: "hamlet", x: 880, y: 110, owner: null, population: 30, site: "mine" },
  { key: "hags-tor", name: "Hag's Tor", province: "iron-fells", kind: "hamlet", x: 960, y: 55, owner: null, population: 4, site: "shrine" },
  { key: "copperdale", name: "Copperdale", province: "iron-fells", kind: "village", x: 860, y: 200, owner: null, population: 110, site: "mine" },
  { key: "cinder-fort", name: "Cinder Fort", province: "iron-fells", kind: "keep", x: 950, y: 205, owner: null, population: 0, site: "fort" },

  // The Saltings: the cold west shore below the Reach, salt pans and wreckers.
  { key: "saltcote", name: "Saltcote", province: "the-saltings", kind: "hamlet", x: 55, y: 325, owner: null, population: 40, site: "coast" },
  { key: "drowned-chapel", name: "Drowned Chapel", province: "the-saltings", kind: "hamlet", x: 70, y: 450, owner: null, population: 0, site: "shrine" },
  { key: "wreckers-strand", name: "Wreckers' Strand", province: "the-saltings", kind: "hamlet", x: 80, y: 570, owner: null, population: 35, site: "coast" },
  { key: "old-seawatch", name: "Old Seawatch", province: "the-saltings", kind: "keep", x: 165, y: 650, owner: null, population: 0, site: "fort" },

  // Two more in every governed province: a holding of its governor's, or a
  // site nobody holds.
  { key: "hareford", name: "Hareford", province: "vale-of-the-hare", kind: "village", x: 275, y: 195, owner: "hare" },
  { key: "moot-hill", name: "Moot Hill", province: "vale-of-the-hare", kind: "hamlet", x: 190, y: 268, owner: null, population: 0, site: "ruin" },
  { key: "thornbrake", name: "Thornbrake", province: "long-wood", kind: "village", x: 278, y: 392, owner: "boar" },
  { key: "elder-hollow", name: "Elder Hollow", province: "long-wood", kind: "hamlet", x: 118, y: 372, owner: null, population: 8, site: "forest" },
  { key: "wickham-lock", name: "Wickham Lock", province: "lisle-bridges", kind: "village", x: 475, y: 295, owner: "badger" },
  { key: "sunken-arch", name: "Sunken Arch", province: "lisle-bridges", kind: "hamlet", x: 505, y: 180, owner: null, population: 0, site: "ruin" },
  { key: "eelmarsh", name: "Eelmarsh", province: "hallow-ferry", kind: "hamlet", x: 270, y: 560, owner: "owl" },
  { key: "mere-shrine", name: "Mere Shrine", province: "hallow-ferry", kind: "hamlet", x: 360, y: 610, owner: null, population: 5, site: "shrine" },
  { key: "kingsbridge", name: "Kingsbridge", province: "crown-seat", kind: "village", x: 605, y: 425, owner: "usurper" },
  { key: "gallows-hill", name: "Gallows Hill", province: "crown-seat", kind: "hamlet", x: 470, y: 475, owner: "usurper" },
  { key: "barley-green", name: "Barley Green", province: "open-fields", kind: "village", x: 705, y: 575, owner: "fox" },
  { key: "southwatch", name: "Southwatch", province: "open-fields", kind: "keep", x: 560, y: 665, owner: null, population: 0, site: "fort" },
  { key: "antler-wood", name: "Antler Wood", province: "stag-wolf", kind: "hamlet", x: 600, y: 150, owner: null, population: 10, site: "forest" },
  { key: "howling-scar", name: "Howling Scar", province: "stag-wolf", kind: "hamlet", x: 700, y: 290, owner: "wolf", biome: "moor" },
  { key: "brackenridge", name: "Brackenridge", province: "red-march", kind: "village", x: 955, y: 400, owner: "margrave" },
  { key: "margraves-folly", name: "Margrave's Folly", province: "red-march", kind: "keep", x: 755, y: 405, owner: null, population: 0, site: "fort" },
  { key: "kittiwake-cove", name: "Kittiwake Cove", province: "crows-reach", kind: "hamlet", x: 960, y: 630, owner: null, population: 30, site: "coast" },
  { key: "rookery", name: "Rookery", province: "crows-reach", kind: "hamlet", x: 715, y: 670, owner: "crow" },
];

const ROADS: readonly RoadDef[] = [
  // The Reach: cart tracks between hamlets, and two ways out of it -- the old
  // road south from Rookstead, and a hill pass from Fell End.
  ["cold-hearth", "greyshaw", "track"],
  ["cold-hearth", "thornwick", "track"],
  ["cold-hearth", "fell-end", "track"],
  ["greyshaw", "fell-end", "track"],
  ["greyshaw", "rookstead", "track"],
  ["thornwick", "rookstead", "track"],
  ["rookstead", "harrowfield", "road"],
  ["rookstead", "barrowmere", "track"],
  ["fell-end", "linnet-cross", "pass"],

  ["harrowfield", "linnet-cross", "road"],
  ["harrowfield", "barrowmere", "road"],
  ["harrowfield", "furrowby", "road"],
  ["barrowmere", "furrowby", "track"],

  ["barrowmere", "ashgrove", "track"],
  ["ashgrove", "boarsden", "forest"],
  ["boarsden", "underbough", "forest"],
  ["underbough", "owlcote", "forest"],
  ["boarsden", "owlcote", "road"],

  ["linnet-cross", "lisle", "road"],
  ["furrowby", "sett-hollow", "track"],
  ["lisle", "three-bridges", "road"],
  ["lisle", "sett-hollow", "road"],
  ["lisle", "rimaros", "highway"],
  ["sett-hollow", "kingsmere", "ford"],
  ["three-bridges", "high-tarn", "road"],

  ["hallow-ferry", "owlcote", "road"],
  ["hallow-ferry", "reedham", "road"],
  ["hallow-ferry", "kingsmere", "ferry"],
  ["reedham", "foxhollow", "road"],

  ["rimaros", "kingsmere", "highway"],
  ["rimaros", "chancery-hold", "highway"],
  ["rimaros", "wideacre", "highway"],
  ["chancery-hold", "high-tarn", "road"],
  ["chancery-hold", "tarnford", "highway"],

  ["wideacre", "foxhollow", "road"],
  ["wideacre", "sheaving", "road"],
  ["wideacre", "meadsend", "road"],
  ["sheaving", "meadsend", "track"],
  ["sheaving", "gullwick", "road"],
  ["meadsend", "marchgate", "track"],

  ["stagcrown", "high-tarn", "pass"],
  ["stagcrown", "bleakmoor", "moor"],
  ["bleakmoor", "wolfmere", "moor"],
  ["wolfmere", "high-tarn", "moor"],
  ["wolfmere", "tarnford", "road"],

  ["tarnford", "redcastle", "road"],
  ["redcastle", "marchgate", "road"],
  ["redcastle", "embersike", "track"],
  ["embersike", "tarnford", "track"],
  ["marchgate", "crowhaven", "road"],

  ["crowhaven", "gullwick", "road"],
  ["crowhaven", "wrackhythe", "track"],
  // -- K3a: the roads of the new ground, appended (see HOLDINGS) -------------
  ["cold-hearth", "weather-tower", "track"],
  ["fell-end", "weather-tower", "track"],
  ["cold-hearth", "hermits-cell", "track"],
  ["thornwick", "hermits-cell", "track"],
  ["fell-end", "old-stone-ring", "track"],
  ["thornwick", "sorrel-wood", "forest"],
  ["rookstead", "moot-hill", "track"],
  ["moot-hill", "barrowmere", "track"],
  ["hareford", "harrowfield", "road"],
  ["hareford", "linnet-cross", "road"],

  ["old-stone-ring", "wold-barrow", "moor"],
  ["wold-barrow", "st-ebbas-well", "moor"],
  ["wold-barrow", "greyfold", "moor"],
  ["linnet-cross", "greyfold", "track"],
  ["greyfold", "sunken-arch", "track"],
  ["sunken-arch", "three-bridges", "road"],
  ["st-ebbas-well", "fallow-keep", "moor"],
  ["sunken-arch", "fallow-keep", "track"],
  ["fallow-keep", "hobs-delving", "pass"],
  ["fallow-keep", "antler-wood", "track"],
  ["antler-wood", "high-tarn", "forest"],
  ["hobs-delving", "stagcrown", "pass"],

  ["bleakmoor", "the-forgeworks", "moor"],
  ["the-forgeworks", "embermouth", "track"],
  ["embermouth", "hags-tor", "pass"],
  ["embermouth", "copperdale", "track"],
  ["copperdale", "wolfmere", "road"],
  ["copperdale", "cinder-fort", "track"],
  ["cinder-fort", "embersike", "track"],

  ["sorrel-wood", "saltcote", "track"],
  ["saltcote", "elder-hollow", "track"],
  ["elder-hollow", "boarsden", "forest"],
  ["elder-hollow", "drowned-chapel", "track"],
  ["drowned-chapel", "underbough", "track"],
  ["drowned-chapel", "wreckers-strand", "track"],
  ["wreckers-strand", "old-seawatch", "track"],
  ["old-seawatch", "eelmarsh", "track"],

  ["thornbrake", "ashgrove", "track"],
  ["thornbrake", "owlcote", "forest"],
  ["wickham-lock", "lisle", "road"],
  ["wickham-lock", "three-bridges", "road"],
  ["wickham-lock", "rimaros", "road"],
  ["eelmarsh", "owlcote", "track"],
  ["eelmarsh", "mere-shrine", "track"],
  ["mere-shrine", "reedham", "track"],
  ["kingsbridge", "rimaros", "road"],
  ["kingsbridge", "chancery-hold", "road"],
  ["kingsbridge", "meadsend", "road"],
  ["gallows-hill", "kingsmere", "road"],
  ["gallows-hill", "hallow-ferry", "ferry"],
  ["barley-green", "sheaving", "road"],
  ["barley-green", "meadsend", "road"],
  ["southwatch", "foxhollow", "track"],
  ["southwatch", "sheaving", "track"],
  ["howling-scar", "wolfmere", "moor"],
  ["howling-scar", "high-tarn", "moor"],
  ["brackenridge", "redcastle", "road"],
  ["brackenridge", "embersike", "track"],
  ["margraves-folly", "tarnford", "track"],
  ["margraves-folly", "marchgate", "track"],
  ["kittiwake-cove", "wrackhythe", "track"],
  ["kittiwake-cove", "crowhaven", "road"],
  ["rookery", "gullwick", "road"],
];

export const RIMAROS: KingdomMapDef = {
  id: "rimaros",
  name: "Rimaros",
  width: 1000,
  height: 700,
  provinces: PROVINCES,
  holdings: HOLDINGS,
  roads: ROADS,
  start: "cold-hearth",
  crownSeat: "rimaros",
  // The exile was marched to the Reach along its own tracks, and a king
  // remembers where his governors sit (docs/PROVISIONAL.md K3a.3).
  startKnown: [
    "cold-hearth", "greyshaw", "thornwick", "fell-end", "rookstead",
    "harrowfield", "boarsden", "lisle", "hallow-ferry", "rimaros", "wideacre", "stagcrown", "wolfmere",
    "redcastle", "crowhaven",
  ],
};

/** Every map the sim can be built on, by id. A save names its map. */
export const KINGDOM_MAPS: Record<string, KingdomMapDef> = { rimaros: RIMAROS };

/**
 * The seed a battle at this holding generates its ground from (§B.2).
 *
 * Derived from the KEY, not the position in the list, so adding or
 * reordering holdings never changes anyone else's battlefield. FNV-1a over
 * the key's characters, then mixed with the biome level's own seed so two
 * biomes never share a field. Exact 32-bit integer arithmetic only, so it is
 * the same on every engine even though content/ is not under the sim's
 * purity scan.
 */
export function holdingSeed(def: HoldingDef, levelSeed: number): number {
  if (def.seed !== undefined) return def.seed | 0;
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < def.key.length; i++) {
    h ^= def.key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h ^ levelSeed) | 0;
}
