/**
 * Active abilities: things the commander spends, not things a unit does.
 *
 * Bought from the SAME budget as troops, which is the whole design. A barrage
 * costs about what a company of archers costs, so taking one means going into
 * the battle with fewer men -- a real decision rather than a free extra. Nothing
 * here can be bought with points that had no other use.
 *
 * Every one is limited by charges AND by a cooldown, so no ability is an
 * answer you can simply keep giving. They are moments, not tools.
 *
 * DOCTRINE SETS THE PRICE LIST rather than granting a separate purse. An
 * aggressive army gets its barrage and its charge cheap and pays through the
 * nose to hide behind a shield; a defensive one is the other way about. So
 * choosing a doctrine is choosing which moments you can afford.
 */

import type { DoctrineId } from "./doctrines.ts";

export type AbilityId = "barrage" | "charge" | "shield" | "smoke" | "flare" | "levy";

export type Ability = {
  readonly id: AbilityId;
  readonly name: string;
  readonly blurb: string;
  /** Base point cost, before the doctrine's price list is applied. */
  readonly cost: number;
  /** Uses in a whole battle. */
  readonly charges: number;
  /** Seconds before it can be used again. */
  readonly cooldown: number;
  /** World-unit radius of effect. */
  readonly radius: number;
  /** Seconds the effect lasts. Barrages are short; screens are long. */
  readonly duration: number;
  /** Ground means "anywhere you can see"; own means "on your own company". */
  readonly target: "ground" | "own";
};

export const ABILITIES: Record<AbilityId, Ability> = {
  barrage: {
    id: "barrage",
    name: "Reserve barrage",
    blurb: "Shot from off the field onto ground you choose. Kills what stands there, and will kill your own men just as happily.",
    cost: 5,
    charges: 3,
    cooldown: 45,
    radius: 200,
    duration: 4,
    target: "ground",
  },
  charge: {
    id: "charge",
    name: "Sound the charge",
    blurb: "One company goes in at the run and hits far harder for it. Costs them their formation while they do.",
    cost: 3,
    charges: 4,
    cooldown: 30,
    radius: 0,
    duration: 7,
    target: "own",
  },
  shield: {
    id: "shield",
    name: "Shield wall",
    blurb: "Locked shields over a patch of ground. Very hard to hurt, and nobody under it is going anywhere quickly.",
    cost: 4,
    charges: 3,
    cooldown: 40,
    radius: 190,
    duration: 12,
    target: "own",
  },
  smoke: {
    id: "smoke",
    name: "Smoke screen",
    blurb: "Blinds everyone on that ground, yours included. For crossing open field, or breaking off a fight you are losing.",
    cost: 3,
    charges: 3,
    cooldown: 35,
    radius: 230,
    duration: 14,
    target: "ground",
  },
  flare: {
    id: "flare",
    name: "Send up a flare",
    blurb: "Lights a patch of the map and everything standing in it. You cannot shell what you cannot see.",
    cost: 2,
    charges: 4,
    cooldown: 25,
    radius: 340,
    duration: 10,
    target: "ground",
  },
  levy: {
    id: "levy",
    name: "Call up the levy",
    blurb: "A company of militia turns out where you point. Not good men, but they are there now and they are yours.",
    cost: 6,
    charges: 2,
    cooldown: 60,
    radius: 0,
    duration: 0,
    target: "ground",
  },
};

export const ABILITY_IDS: readonly AbilityId[] =
  ["barrage", "charge", "shield", "smoke", "flare", "levy"];

/**
 * Doctrine price list, as a multiplier on the base cost.
 *
 * Below 1 is this doctrine's speciality and above 1 is what it is bad at.
 * Every doctrine is cheap at something and dear at something else, so none is
 * simply the ability doctrine.
 */
const PRICING: Record<DoctrineId, Partial<Record<AbilityId, number>>> = {
  aggressive: { barrage: 0.6, charge: 0.7, shield: 1.6, smoke: 1.3, flare: 1.0, levy: 1.2 },
  defensive: { shield: 0.6, levy: 0.7, barrage: 1.4, charge: 1.6, smoke: 1.0, flare: 1.1 },
  maneuver: { smoke: 0.6, flare: 0.6, charge: 0.8, barrage: 1.3, shield: 1.4, levy: 1.3 },
  magic: { levy: 0.6, flare: 0.8, smoke: 0.9, shield: 1.0, barrage: 1.2, charge: 1.5 },
};

/** What this ability costs an army of this doctrine. Never below one point. */
export function abilityCost(id: AbilityId, doctrine: DoctrineId): number {
  const scale = PRICING[doctrine]?.[id] ?? 1;
  return Math.max(1, Math.round(ABILITIES[id].cost * scale));
}
