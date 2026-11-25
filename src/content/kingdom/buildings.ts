/**
 * Buildings (PLAN.md §B.3): what can stand in a holding's building slots.
 *
 * Each entry gives its cost, build time in days, daily upkeep, the slots it
 * takes, and what it does. Only the ECONOMIC effects are simulated in K3
 * (`economy`); the battle, defence, vision and morale effects are recorded
 * here as data (`later`) so K4 (recruitment), K5 (battle spawn and sieges),
 * K6 (legitimacy, morale), K7 (mercenaries) and K8 (warning) read them from
 * the same row instead of inventing their own.
 *
 * Plain data plus validation. The sim reads a row by id.
 */

import type { BiomeId } from "./terrain.ts";
import type { StockId } from "./economy.ts";

export type BuildingId =
  | "farm" | "granary" | "woodcutter" | "forge" | "barracks" | "tavern" | "watchtower"
  | "palisade" | "wall" | "keep" | "shrine" | "hall" | "market";

/** Hash and save order. Append only. */
export const BUILDING_IDS: readonly BuildingId[] = [
  "farm", "granary", "woodcutter", "forge", "barracks", "tavern", "watchtower",
  "palisade", "wall", "keep", "shrine", "hall", "market",
];

export type Cost = Readonly<Partial<Record<StockId, number>>>;

/** What a building does to the economy, every day it stands and its upkeep is paid. */
export type BuildingEconomy = {
  /** Extra grain storage (spoils slowly). */
  readonly storage?: number;
  /** Percent added to the yield of every plot of its holding. */
  readonly yieldPct?: number;
  /** Made every day, scaled by the holding's wood where `byWood`. */
  readonly produces?: Cost;
  readonly byWood?: boolean;
  /** Taken every day to make it (the forge's charcoal). Without them it makes nothing. */
  readonly consumes?: Cost;
  /** Coin a day from trade: `base` + `perRoad` for each road out + people / `perPeople`. */
  readonly trade?: { readonly base: number; readonly perRoad: number; readonly perPeople: number };
  /** Percent added to the seasonal muster. */
  readonly musterPct?: number;
};

/** Effects for later phases. Recorded, not simulated, in K3. */
export type BuildingLater = {
  /** K5: defence value used in battle spawn and sieges. */
  readonly defence?: number;
  /** K8: vision radius in miles at the kingdom layer. */
  readonly visionMiles?: number;
  /** K8: days of warning of an approaching army. */
  readonly warningDays?: number;
  /** K6: legitimacy a season. */
  readonly legitimacy?: number;
  /** K6: unrest a day, in steps of SHRINE_UNREST_SCALE permille (content/kingdom/morale.ts); negative calms. */
  readonly unrest?: number;
  /** K4: recruits squads from levy here. */
  readonly recruits?: boolean;
  /** K4: wounded recover here, faster by this factor. */
  readonly recovery?: number;
  /** K7: mercenary companies are offered here. */
  readonly mercenaries?: boolean;
  /** K8: rumours of enemy movements. */
  readonly rumours?: boolean;
};

export type BuildingDef = {
  readonly id: BuildingId;
  readonly name: string;
  /** One line for the build menu: what it is for. */
  readonly purpose: string;
  readonly cost: Cost;
  /** Days of work from the order to standing. */
  readonly days: number;
  /** Paid every day; unpaid, the building stands idle that day. */
  readonly upkeep: Cost;
  /** Building slots it takes. */
  readonly slots: number;
  /** Built over this building, in its slot (palisade -> wall -> keep). */
  readonly upgrades?: BuildingId;
  /** Only one per holding. */
  readonly unique: boolean;
  /** Cannot be built in these countries. */
  readonly notIn?: readonly BiomeId[];
  /** Only where the country has wood (BIOME_ECONOMY.wood > 0). */
  readonly needsWood?: boolean;
  readonly economy: BuildingEconomy;
  readonly later: BuildingLater;
};

export const BUILDINGS: Readonly<Record<BuildingId, BuildingDef>> = {
  farm: {
    id: "farm", name: "Farm and mill", purpose: "Better yields from every field here.",
    cost: { coin: 10, timber: 8 }, days: 6, upkeep: {}, slots: 1, unique: true,
    economy: { yieldPct: 30 }, later: {},
  },
  granary: {
    id: "granary", name: "Granary", purpose: "Stores grain through the winter without it rotting.",
    cost: { coin: 4, timber: 4 }, days: 4, upkeep: {}, slots: 1, unique: false,
    economy: { storage: 500 }, later: {},
  },
  woodcutter: {
    id: "woodcutter", name: "Woodcutter", purpose: "Timber every day; more in forest country.",
    cost: { coin: 4 }, days: 3, upkeep: {}, slots: 1, unique: true, needsWood: true,
    economy: { produces: { timber: 3 }, byWood: true }, later: {},
  },
  forge: {
    id: "forge", name: "Forge", purpose: "Iron for arms, burning timber as charcoal.",
    cost: { coin: 20, timber: 12 }, days: 8, upkeep: { coin: 1 }, slots: 1, unique: true,
    economy: { produces: { iron: 1 }, consumes: { timber: 1 } }, later: {},
  },
  barracks: {
    id: "barracks", name: "Barracks", purpose: "Raises more levy each season; trains squads (with armies).",
    cost: { coin: 25, timber: 20, iron: 4 }, days: 10, upkeep: { coin: 1 }, slots: 1, unique: true,
    economy: { musterPct: 100 }, later: { recruits: true },
  },
  tavern: {
    id: "tavern", name: "Tavern", purpose: "A little trade; free companies come here to be hired (rumours later).",
    cost: { coin: 12, timber: 10 }, days: 5, upkeep: {}, slots: 1, unique: true,
    economy: { trade: { base: 1, perRoad: 0, perPeople: 0 } }, later: { mercenaries: true, rumours: true },
  },
  watchtower: {
    id: "watchtower", name: "Watchtower", purpose: "Sees further and warns of armies (later).",
    cost: { coin: 6, timber: 12 }, days: 5, upkeep: {}, slots: 1, unique: true,
    economy: {}, later: { visionMiles: 80, warningDays: 2 },
  },
  palisade: {
    id: "palisade", name: "Palisade", purpose: "A timber wall: defence in battle (later).",
    cost: { coin: 4, timber: 20 }, days: 6, upkeep: {}, slots: 1, unique: true,
    economy: {}, later: { defence: 1 },
  },
  wall: {
    id: "wall", name: "Stone wall", purpose: "Built over the palisade: stronger defence (later).",
    cost: { coin: 40, timber: 10, iron: 8 }, days: 20, upkeep: { coin: 1 }, slots: 1, unique: true, upgrades: "palisade",
    economy: {}, later: { defence: 2 },
  },
  keep: {
    id: "keep", name: "Keep", purpose: "Built over the wall: a siege to take it (later).",
    cost: { coin: 80, timber: 30, iron: 20 }, days: 30, upkeep: { coin: 2 }, slots: 1, unique: true, upgrades: "wall",
    economy: {}, later: { defence: 3 },
  },
  shrine: {
    id: "shrine", name: "Shrine", purpose: "Calms the town every day; a little legitimacy each season.",
    cost: { coin: 8, timber: 4 }, days: 5, upkeep: {}, slots: 1, unique: true,
    economy: {}, later: { legitimacy: 1, unrest: -1 },
  },
  hall: {
    id: "hall", name: "Hall", purpose: "A lord's hall: calms the town, legitimacy each season, and the wounded mend here.",
    cost: { coin: 30, timber: 20 }, days: 12, upkeep: { coin: 1 }, slots: 1, unique: true,
    economy: {}, later: { legitimacy: 2, unrest: -2, recovery: 2 },
  },
  market: {
    id: "market", name: "Market", purpose: "Coin from trade along every road out.",
    cost: { coin: 18, timber: 12 }, days: 8, upkeep: {}, slots: 1, unique: true,
    economy: { trade: { base: 1, perRoad: 1, perPeople: 100 } }, later: {},
  },
};

/** Every problem with the buildings table. Empty means valid. */
export function validateBuildings(table: Readonly<Record<string, BuildingDef>> = BUILDINGS): string[] {
  const problems: string[] = [];
  const ids = Object.keys(table);
  for (const id of ids) if (!(BUILDING_IDS as readonly string[]).includes(id)) problems.push("building " + id + " has no hash code in BUILDING_IDS");
  for (const id of BUILDING_IDS) if (!table[id]) problems.push("BUILDING_IDS lists " + id + ", which is not in the table");
  const whole = (v: number | undefined): boolean => v === undefined || (Number.isInteger(v) && v >= 0);
  for (const b of Object.values(table)) {
    if (b.id !== ids.find((k) => table[k] === b)) problems.push("building " + b.id + " is filed under another id");
    if (!(Number.isInteger(b.days) && b.days >= 1)) problems.push(b.id + ": build time must be a whole number of days >= 1");
    if (!(Number.isInteger(b.slots) && b.slots >= 1)) problems.push(b.id + ": must take at least one slot");
    for (const c of [b.cost, b.upkeep, b.economy.produces ?? {}, b.economy.consumes ?? {}]) {
      for (const v of Object.values(c)) if (!whole(v)) problems.push(b.id + ": costs and amounts must be whole numbers >= 0");
    }
    if (Object.values(b.cost).every((v) => !v)) problems.push(b.id + ": a building that costs nothing is no decision");
    if (b.upgrades !== undefined) {
      const base = table[b.upgrades];
      if (!base) problems.push(b.id + " upgrades unknown building " + b.upgrades);
      else if (base.slots !== b.slots) problems.push(b.id + " must take the slots of what it replaces");
    }
    const e = b.economy;
    const doesSomething = e.storage || e.yieldPct || e.produces || e.trade || e.musterPct ||
      Object.keys(b.later).length > 0;
    if (!doesSomething) problems.push(b.id + " does nothing, now or later");
    if (!b.name || !b.purpose) problems.push(b.id + " needs a name and a purpose line");
  }
  // An upgrade chain must end: palisade -> wall -> keep, never a loop.
  for (const b of Object.values(table)) {
    const seen = new Set<string>([b.id]);
    let at = b.upgrades;
    while (at !== undefined) {
      if (seen.has(at)) { problems.push(b.id + "'s upgrade chain loops"); break; }
      seen.add(at);
      at = table[at]?.upgrades;
    }
  }
  return problems;
}
