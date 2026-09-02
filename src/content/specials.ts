/**
 * What each kind of soldier does for itself, without being told.
 *
 * These are NOT orders. The player never spends them and cannot ask for them:
 * a company braces when it is being cut up, cavalry breaks into a gallop when
 * it has open ground and something to reach, archers throw down their bows when
 * the enemy is on top of them. The player's job is to put troops where their
 * habits are worth having, which is a more interesting job than pressing a
 * button at the right moment.
 *
 * Every one is a trade. Bracing halves the damage you take and halves the
 * damage you deal; fortifying makes a company nearly unkillable and completely
 * useless; a gallop gets you there at the cost of arriving strung out.
 * Anything that was purely good would just be a stat.
 */

export type SpecialId = "brace" | "dodge" | "breakBow" | "dash" | "fortify" | "blink";

export type Special = {
  readonly id: SpecialId;
  readonly name: string;
  /** One line, for the army screen. */
  readonly blurb: string;
  /** Seconds it lasts once it triggers. */
  readonly duration: number;
  /** Seconds before the company may do it again. */
  readonly cooldown: number;
  /** How many times in a whole battle. 0 means no limit. */
  readonly uses: number;
};

export const SPECIALS: Record<SpecialId, Special> = {
  brace: {
    id: "brace",
    name: "Shield guard",
    blurb: "Locks shields when the fighting turns against it: half the damage taken, and half the damage dealt.",
    duration: 8,
    cooldown: 16,
    uses: 0,
  },
  dodge: {
    id: "dodge",
    name: "Dodge",
    blurb: "Refuses to stand still under fire. Half of everything aimed at them misses for ten seconds.",
    duration: 10,
    cooldown: 20,
    uses: 0,
  },
  breakBow: {
    id: "breakBow",
    name: "Break the bow",
    blurb: "With the enemy on top of them and nothing left to shoot, they throw down their bows and fight as skirmishers.",
    duration: 0,
    cooldown: 0,
    // Once. There is no picking the bow back up.
    uses: 1,
  },
  dash: {
    id: "dash",
    name: "Gallop",
    blurb: "Twice the pace for five seconds, spent closing the last of the ground or getting round a flank.",
    duration: 5,
    cooldown: 18,
    uses: 0,
  },
  fortify: {
    id: "fortify",
    name: "Fortify",
    blurb: "Overwhelmed, they plant themselves: almost nothing gets through, and they neither move nor strike.",
    duration: 10,
    cooldown: 30,
    uses: 0,
  },
  blink: {
    id: "blink",
    name: "Withdraw by the Art",
    blurb: "About to be destroyed, the adepts step out of the world and reappear at the western edge. Once.",
    duration: 0,
    cooldown: 0,
    uses: 1,
  },
};

/** Damage a bracing company keeps off, and the share of its own it gives up. */
export const BRACE_SOAK = 0.5;
export const BRACE_SLOWDOWN = 2;
/** Chance a blow aimed at a dodging company simply misses. */
export const DODGE_CHANCE = 0.5;
/** Damage a fortified company keeps off. It deals none and does not move. */
export const FORTIFY_SOAK = 0.95;
/** How much faster a company at the gallop travels. */
export const DASH_HASTE = 2;
