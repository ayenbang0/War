/**
 * Crops for the field plots (PLAN.md §B.3 [PROPOSAL], built as written):
 * wheat/barley, rye, flax, herbs/poppy, orchard.
 *
 * A plot's life (src/sim/kingdom/economy.ts):
 *
 *   empty --sow--> sown --(GERMINATION_DAYS in a growing season)--> growing(progress)
 *         --(growDays of growing seasons)--> ripe --harvest--> harvested
 *                                                 \--(ripeDays unharvested)--> spoiled
 *   any stage --(weather harm takes health to 0, or winter kills a tender crop)--> spoiled
 *   harvested | spoiled --sow--> sown   (a perennial goes harvested --spring--> growing)
 *
 * Growth counts only days in a season the crop grows in, so rye sown in
 * autumn sleeps through the winter and ripens in spring, and wheat sown in
 * spring ripens at the end of summer. A tender crop still in the ground on
 * the first day of winter is killed by it.
 *
 * Yields are per plot of a hamlet-sized field (FIELD_SIZE scales them, and
 * the seed, for bigger holdings), before the farm's bonus, the plot's health
 * and the year's variance.
 *
 * What a crop does beyond the five stocks is recorded in `later` for the
 * phase that uses it: flax's clothing feeds morale (K6), herbs feed the
 * healers' mend and the upkeep of healer and mage squads (K4).
 */

import type { Season } from "./terrain.ts";
import type { Cost } from "./buildings.ts";

export type CropId = "wheat" | "rye" | "flax" | "herbs" | "orchard";

/** Hash and save order. Append only. */
export const CROP_IDS: readonly CropId[] = ["wheat", "rye", "flax", "herbs", "orchard"];

export type CropDef = {
  readonly id: CropId;
  readonly name: string;
  /** One line for the plot manager. */
  readonly about: string;
  /** Seasons it may be sown in. */
  readonly sow: readonly Season[];
  /** Seasons its growth counts in. */
  readonly grows: readonly Season[];
  /** Survives frost and winter (dormant, not killed). */
  readonly hardy: boolean;
  /** Days of growing season from coming up to ripe. */
  readonly growDays: number;
  /** Days it stands ripe before it spoils in the field. */
  readonly ripeDays: number;
  /** Paid when sown (seed, saplings). */
  readonly seed: Cost;
  /** Into the stocks on harvest, per hamlet-sized plot. */
  readonly yield: Cost;
  /**
   * Perennial: after a harvest it is not cleared but regrows from the next
   * spring, ripe again after `regrowDays` of growing season.
   */
  readonly regrowDays?: number;
  readonly later: { readonly morale?: number; readonly herbs?: number };
};

export const CROPS: Readonly<Record<CropId, CropDef>> = {
  wheat: {
    id: "wheat", name: "Wheat and barley", about: "Sown in spring, reaped at summer's end. The staple.",
    sow: ["spring"], grows: ["spring", "summer"], hardy: false,
    growDays: 48, ripeDays: 14, seed: { grain: 30 }, yield: { grain: 420 }, later: {},
  },
  rye: {
    id: "rye", name: "Rye", about: "Hardy: sown in autumn, sleeps through winter, reaped in late spring. Smaller yield.",
    sow: ["autumn"], grows: ["autumn", "spring"], hardy: true,
    growDays: 52, ripeDays: 14, seed: { grain: 20 }, yield: { grain: 260 }, later: {},
  },
  flax: {
    id: "flax", name: "Flax", about: "Linen to sell, and cloth for the army's backs (later).",
    sow: ["spring"], grows: ["spring", "summer"], hardy: false,
    growDays: 40, ripeDays: 12, seed: { grain: 10, coin: 2 }, yield: { coin: 36 }, later: { morale: 1 },
  },
  herbs: {
    id: "herbs", name: "Herbs and poppy", about: "Simples to sell; later they feed the healers.",
    sow: ["spring", "summer"], grows: ["spring", "summer", "autumn"], hardy: false,
    growDays: 36, ripeDays: 10, seed: { coin: 4 }, yield: { coin: 22 }, later: { herbs: 10 },
  },
  orchard: {
    id: "orchard", name: "Orchard", about: "Slow: fruit only after two summers, then every year without resowing.",
    sow: ["spring", "autumn"], grows: ["spring", "summer", "autumn"], hardy: true,
    growDays: 170, ripeDays: 20, regrowDays: 60, seed: { coin: 12, timber: 4 }, yield: { grain: 380, coin: 20 }, later: {},
  },
};

/** Every problem with the crops table. Empty means valid. */
export function validateCrops(table: Readonly<Record<string, CropDef>> = CROPS): string[] {
  const problems: string[] = [];
  for (const id of CROP_IDS) if (!table[id]) problems.push("CROP_IDS lists " + id + ", which is not in the table");
  for (const [id, c] of Object.entries(table)) {
    if (c.id !== id) problems.push("crop " + id + " is filed under another id");
    if (!(CROP_IDS as readonly string[]).includes(id)) problems.push("crop " + id + " has no hash code in CROP_IDS");
    if (c.sow.length === 0) problems.push(id + " can never be sown");
    if (c.grows.length === 0) problems.push(id + " never grows");
    if (!(Number.isInteger(c.growDays) && c.growDays >= 1)) problems.push(id + ": growDays must be a whole number >= 1");
    if (!(Number.isInteger(c.ripeDays) && c.ripeDays >= 1)) problems.push(id + ": ripeDays must be a whole number >= 1");
    if (c.regrowDays !== undefined && !(Number.isInteger(c.regrowDays) && c.regrowDays >= 1 && c.regrowDays <= c.growDays)) {
      problems.push(id + ": regrowDays must be a whole number in 1..growDays");
    }
    for (const v of [...Object.values(c.seed), ...Object.values(c.yield)]) {
      if (!(Number.isInteger(v) && v >= 0)) problems.push(id + ": seed and yield must be whole numbers >= 0");
    }
    if (Object.values(c.yield).every((v) => !v)) problems.push(id + " yields nothing");
    // A tender crop must be able to ripen before the winter it cannot survive:
    // its growing seasons from the first sowing season must hold its growth.
    if (!c.hardy && c.grows.includes("winter")) problems.push(id + " is tender but grows in winter");
  }
  return problems;
}
