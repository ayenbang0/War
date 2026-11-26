/**
 * Crops for the field plots (PLAN.md §B.3 [PROPOSAL], built as written):
 * wheat/barley, rye, flax, herbs/poppy, orchard.
 *
 * A plot's life (src/sim/kingdom/economy.ts):
 *
 *   empty --sow--> sown --(GERMINATION_DAYS in a growing season)--> growing(progress)
 *         --(growDays of growing seasons)--> ripe --harvest--> harvested
 *                                                 \--(ripeDays unharvested)--> spoiled
 *   any stage --(an army foraging it takes health to 0, an enemy burns it,
 *                or winter finds a tender crop still in the ground)--> spoiled
 *   harvested | spoiled --sow--> sown   (a perennial goes harvested --spring--> growing)
 *
 * ECON (owner, 2026-11-25: "the fields sowed with plants shouldn't just
 * randomly die without reason"): no draw of any stream decides a field's fate
 * any more -- the K3 farm weather (drought, frost, flood) is gone. A crop is
 * lost only to a cause the player can see coming: winter, for a tender crop
 * sown too late to ripen (daysToRipe says so before it is sown, and the field
 * card while it grows), an army foraging it, or an enemy's torch. A ripe field
 * is reaped by itself the day it ripens (economy.ts growPlots), so none
 * stands ripe until it spoils in a realm that keeps its stores.
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
 * ECON: the year became twelve thirty-day months (sim/kingdom/clock.ts), each
 * season three times as long as K3's. Growth and ripe days were scaled by
 * three with it, so a crop still fills the same share of its seasons
 * (docs/PROVISIONAL.md ECON.2); germination stayed three days. The grains'
 * yields were then raised past that (owner: "a lot easier with managing
 * resources") -- wheat 2100 (x3 would be 1260), rye 1500 (780) -- and their
 * seed cut to half of x3 (wheat 45, rye 30), so a hamlet's two fields feed
 * the king's party and the hamlet through the year, and the steward who sows
 * a town's fields in its first autumn is not left without bread for its men
 * before the first harvest (ECON.6). Flax, herbs and the orchard are x3.
 *
 * What a crop does beyond the five stocks is recorded in `later` for the
 * phase that uses it: flax's clothing feeds morale (K6), herbs feed the
 * healers' mend and the upkeep of healer and mage squads (K4).
 */

import { SEASONS, type Season } from "./terrain.ts";
import type { Cost } from "./buildings.ts";
import { GERMINATION_DAYS } from "./economy.ts";
import { DAYS_PER_SEASON, DAYS_PER_YEAR } from "../../sim/kingdom/clock.ts";

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
    id: "wheat", name: "Wheat and barley", about: "Sown in spring's first month, reaped at summer's end. The staple.",
    sow: ["spring"], grows: ["spring", "summer"], hardy: false,
    growDays: 150, ripeDays: 30, seed: { grain: 45 }, yield: { grain: 2100 }, later: {},
  },
  rye: {
    id: "rye", name: "Rye", about: "Hardy: sown in autumn, sleeps through winter, reaped in late spring. Smaller yield.",
    sow: ["autumn"], grows: ["autumn", "spring"], hardy: true,
    growDays: 150, ripeDays: 30, seed: { grain: 30 }, yield: { grain: 1500 }, later: {},
  },
  flax: {
    id: "flax", name: "Flax", about: "Linen to sell, and cloth for the army's backs (later).",
    sow: ["spring"], grows: ["spring", "summer"], hardy: false,
    growDays: 120, ripeDays: 30, seed: { grain: 30, coin: 6 }, yield: { coin: 108 }, later: { morale: 1 },
  },
  herbs: {
    id: "herbs", name: "Herbs and poppy", about: "Simples to sell; later they feed the healers.",
    sow: ["spring", "summer"], grows: ["spring", "summer", "autumn"], hardy: false,
    growDays: 108, ripeDays: 30, seed: { coin: 12 }, yield: { coin: 66 }, later: { herbs: 10 },
  },
  orchard: {
    id: "orchard", name: "Orchard", about: "Slow: fruit only after two summers, then every year without resowing.",
    sow: ["spring", "autumn"], grows: ["spring", "summer", "autumn"], hardy: true,
    growDays: 510, ripeDays: 60, regrowDays: 180, seed: { coin: 12, timber: 4 }, yield: { grain: 1140, coin: 60 }, later: {},
  },
};

/**
 * Days from now until a crop is ripe, counted the way the sim grows it
 * (sim/kingdom/economy.ts growPlots), or null if a tender crop would still be
 * in the ground when winter comes and kills it. `dayOfYear` is today; today's
 * growth has already been counted (a field sown today first grows tomorrow:
 * an order, and the day's own sowing, come after the day's growth). `need`
 * is the growing-season days it still wants: GERMINATION_DAYS + growDays for
 * a field sown today. Pure calendar arithmetic, no draw: what the sow menu
 * warns of, what the field card promises, and what auto-sowing waits for.
 */
export function daysToRipe(crop: CropDef, dayOfYear: number, need = GERMINATION_DAYS + crop.growDays): number | null {
  if (need <= 0) return 0;
  let counted = 0;
  for (let i = 1; i <= 3 * DAYS_PER_YEAR; i++) {
    const doy = (dayOfYear + i) % DAYS_PER_YEAR;
    // Whole-number division without Math: the sim reads this (sim/math.ts rule).
    const season = SEASONS[(doy - (doy % DAYS_PER_SEASON)) / DAYS_PER_SEASON];
    if (season === "winter" && !crop.hardy) return null;
    if (crop.grows.includes(season) && ++counted >= need) return i;
  }
  return null;
}

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
    // ECON: sown on the first day of any season it may be sown in, it ripens
    // before the winter that would kill it -- so a field that resows itself
    // at its season's turn never sows a crop to die.
    for (const season of c.sow) {
      const day0 = SEASONS.indexOf(season) * DAYS_PER_SEASON;
      if (daysToRipe(c, day0) === null) problems.push(id + " sown on the first day of " + season + " dies before it ripens");
    }
  }
  return problems;
}
