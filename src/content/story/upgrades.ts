/**
 * Special upgrades (PLAN.md §B.11a, phase K3a): lasting boons found at
 * exploration sites -- a mill's stones carted home, a hermit's herb-lore, a
 * ferryman's goodwill. An event choice (events.ts) grants one; the faction
 * keeps it for the rest of the game.
 *
 * Plain data, read by id. What each one does is a list of effects the sim
 * applies through the economy's own paths (sim/kingdom/economy.ts and
 * explore.ts), so a boon in coin or grain goes through the ledger like any
 * other stock change and conservation still holds:
 *
 *   yieldPct      harvests of the faction's fields (optionally one crop, or only
 *                 where a given building stands) are this much bigger
 *   foragePct     the party's foraging gathers this much more grain
 *   taxPct        taxes bring in this much more
 *   musterPct     the seasonal muster is this much bigger (like a barracks)
 *   storage       grain kept as well as in a granary
 *   spoilagePct   loose grain (cellars, packs) spoils this much slower (negative)
 *   grant         stocks once, when found (ledger: finds)
 *   daily         stocks every day (ledger: boons)
 *   legitimacyPerBuilding  legitimacy each season per standing building of a kind
 *   roadCostPct   effort on roads of these surfaces, for the faction's party
 *   sightMiles    the retinue, or every watchtower, sees this much further
 *   later         an effect on armies or battle, for the phase named; recorded,
 *                 not simulated, until that phase reads it
 *
 * Every number is PROVISIONAL (docs/PROVISIONAL.md K3a.x).
 */

import type { BuildingId, Cost } from "../kingdom/buildings.ts";
import type { CropId } from "../kingdom/crops.ts";
import type { RoadTerrainId } from "../kingdom/terrain.ts";

export type UpgradeEffect =
  | { readonly kind: "yieldPct"; readonly pct: number; readonly crop?: CropId; readonly withBuilding?: BuildingId }
  | { readonly kind: "foragePct"; readonly pct: number }
  | { readonly kind: "taxPct"; readonly pct: number }
  | { readonly kind: "musterPct"; readonly pct: number }
  | { readonly kind: "storage"; readonly grain: number }
  | { readonly kind: "spoilagePct"; readonly pct: number }
  | { readonly kind: "grant"; readonly gains: Cost }
  | { readonly kind: "daily"; readonly gains: Cost }
  | { readonly kind: "legitimacyPerBuilding"; readonly building: BuildingId; readonly perSeason: number }
  | { readonly kind: "roadCostPct"; readonly terrains: readonly RoadTerrainId[]; readonly pct: number }
  | { readonly kind: "sightMiles"; readonly of: "retinue" | "watchtower"; readonly miles: number }
  | { readonly kind: "later"; readonly phase: "K4" | "K5" | "K6" | "K7"; readonly note: string };

export type UpgradeId =
  | "old-mill-stones" | "hermits-herbs" | "forgotten-armoury" | "pilgrim-road" | "ferrymans-favour"
  | "wayfinders-map" | "salt-pans" | "charcoal-pits" | "old-kings-seal" | "beekeepers-lore"
  | "veterans-oath" | "deep-cellars" | "lantern-of-the-watch" | "fishers-weirs" | "drovers-roads"
  | "banner-of-the-old-guard";

/** Hash and save order. Append only. */
export const UPGRADE_IDS: readonly UpgradeId[] = [
  "old-mill-stones", "hermits-herbs", "forgotten-armoury", "pilgrim-road", "ferrymans-favour",
  "wayfinders-map", "salt-pans", "charcoal-pits", "old-kings-seal", "beekeepers-lore",
  "veterans-oath", "deep-cellars", "lantern-of-the-watch", "fishers-weirs", "drovers-roads",
  "banner-of-the-old-guard",
];

export type UpgradeDef = {
  readonly id: UpgradeId;
  readonly name: string;
  /** One line for the upgrades list: what it does, in plain words. */
  readonly about: string;
  readonly effects: readonly UpgradeEffect[];
};

export const UPGRADES: Readonly<Record<UpgradeId, UpgradeDef>> = {
  "old-mill-stones": {
    id: "old-mill-stones", name: "Old Mill Stones",
    about: "Fields where a farm and mill stand yield a fifth more.",
    effects: [{ kind: "yieldPct", pct: 20, withBuilding: "farm" }],
  },
  "hermits-herbs": {
    id: "hermits-herbs", name: "Hermit's Herbs",
    about: "Herb fields yield half again; healers will mend faster (with armies).",
    effects: [
      { kind: "yieldPct", pct: 50, crop: "herbs" },
      { kind: "later", phase: "K4", note: "healer squads mend 1.5x as fast" },
    ],
  },
  "forgotten-armoury": {
    id: "forgotten-armoury", name: "Forgotten Armoury",
    about: "Fifteen bars of good iron, and arms for a company (with armies).",
    effects: [
      { kind: "grant", gains: { iron: 15 } },
      { kind: "later", phase: "K4", note: "one company recruited without its iron" },
    ],
  },
  "pilgrim-road": {
    id: "pilgrim-road", name: "Pilgrim Road",
    about: "Each standing shrine of yours adds a point of legitimacy every season.",
    effects: [{ kind: "legitimacyPerBuilding", building: "shrine", perSeason: 1 }],
  },
  "ferrymans-favour": {
    id: "ferrymans-favour", name: "Ferryman's Favour",
    about: "Ferries and fords cost the party two fifths less effort.",
    effects: [{ kind: "roadCostPct", terrains: ["ferry", "ford"], pct: -40 }],
  },
  "wayfinders-map": {
    id: "wayfinders-map", name: "Wayfinder's Map",
    about: "The party sees 25 miles further on the road.",
    effects: [{ kind: "sightMiles", of: "retinue", miles: 25 }],
  },
  "salt-pans": {
    id: "salt-pans", name: "Salt Pans",
    about: "Salted stores: grain in cellars and packs spoils at half the rate.",
    effects: [{ kind: "spoilagePct", pct: -50 }],
  },
  "charcoal-pits": {
    id: "charcoal-pits", name: "Charcoal Pits",
    about: "A cartload of timber every day.",
    effects: [{ kind: "daily", gains: { timber: 1 } }],
  },
  "old-kings-seal": {
    id: "old-kings-seal", name: "The Old King's Seal",
    about: "Writs under the old seal: taxes bring in 15 % more.",
    effects: [{ kind: "taxPct", pct: 15 }],
  },
  "beekeepers-lore": {
    id: "beekeepers-lore", name: "Beekeepers' Lore",
    about: "Foraging gathers a quarter more grain.",
    effects: [{ kind: "foragePct", pct: 25 }],
  },
  "veterans-oath": {
    id: "veterans-oath", name: "Veterans' Oath",
    about: "Half again as many answer each season's muster; veterans steady a line (with armies).",
    effects: [
      { kind: "musterPct", pct: 50 },
      { kind: "later", phase: "K6", note: "+5 starting morale for levy companies" },
    ],
  },
  "deep-cellars": {
    id: "deep-cellars", name: "Deep Cellars",
    about: "Cool galleries keep 250 grain as well as a granary does.",
    effects: [{ kind: "storage", grain: 250 }],
  },
  "lantern-of-the-watch": {
    id: "lantern-of-the-watch", name: "Lantern of the Watch",
    about: "Every watchtower of yours sees 30 miles further.",
    effects: [{ kind: "sightMiles", of: "watchtower", miles: 30 }],
  },
  "fishers-weirs": {
    id: "fishers-weirs", name: "Fishers' Weirs",
    about: "Two grain of fish every day.",
    effects: [{ kind: "daily", gains: { grain: 2 } }],
  },
  "drovers-roads": {
    id: "drovers-roads", name: "Drovers' Roads",
    about: "Cart tracks and moor paths cost the party a fifth less effort.",
    effects: [{ kind: "roadCostPct", terrains: ["track", "moor"], pct: -20 }],
  },
  "banner-of-the-old-guard": {
    id: "banner-of-the-old-guard", name: "Banner of the Old Guard",
    about: "The royal guard's banner: companies under it hold longer (in battle).",
    effects: [{ kind: "later", phase: "K5", note: "+10 starting morale for the army the king leads" }],
  },
};
