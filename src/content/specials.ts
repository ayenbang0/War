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

export type SpecialId =
  | "brace" | "dodge" | "breakBow" | "dash" | "fortify" | "blink"
  | "entrench" | "triage"
  // Appended for the second roster. Order matters nowhere, but keep appending.
  | "setPikes" | "pavise" | "couch" | "challenge" | "rally"
  | "cadence" | "terror" | "lastStand" | "laager";

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
  entrench: {
    id: "entrench",
    name: "Entrench",
    blurb: "With the enemy coming on, they dig like men who mean to live: works go up in a third of the time, and they do nothing else at all.",
    duration: 12,
    cooldown: 25,
    uses: 0,
  },
  triage: {
    id: "triage",
    name: "Triage",
    blurb: "Pulls the worst-wounded around them back from the edge, all at once, when there is no time for anything gentler.",
    duration: 4,
    cooldown: 45,
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
  setPikes: {
    id: "setPikes",
    name: "Set pikes",
    blurb: "Butts grounded against a charge coming on: a charge that hits a set hedge does a quarter of its harm and is stopped dead.",
    duration: 6,
    cooldown: 14,
    uses: 0,
  },
  pavise: {
    id: "pavise",
    name: "Pavise",
    blurb: "Under fire, they plant their great shields: arrows mostly thud into wood, but they cannot move while they are behind them.",
    duration: 9,
    cooldown: 18,
    uses: 0,
  },
  couch: {
    id: "couch",
    name: "Couch lances",
    blurb: "Lances lowered for the last hundred paces. The first shock lands far harder; after it the lances are splinters.",
    duration: 4,
    cooldown: 24,
    uses: 0,
  },
  challenge: {
    id: "challenge",
    name: "Challenge",
    blurb: "A champion steps out and calls for a man to face him. The enemy around him loses heart, and he fights like three.",
    duration: 8,
    cooldown: 30,
    uses: 0,
  },
  rally: {
    id: "rally",
    name: "Raise the colours",
    blurb: "When friends nearby are wavering, the standard goes up: nerve comes back to every company that can see it.",
    duration: 10,
    cooldown: 28,
    uses: 0,
  },
  cadence: {
    id: "cadence",
    name: "Beat the march",
    blurb: "While friends nearby are on the move, the drums keep them in step: a quarter faster, and steadier for it.",
    duration: 10,
    cooldown: 14,
    uses: 0,
  },
  terror: {
    id: "terror",
    name: "Loose the pack",
    blurb: "Once the hounds are among them, nerve drains from every enemy near the pack, and horses most of all.",
    duration: 7,
    cooldown: 22,
    uses: 0,
  },
  lastStand: {
    id: "lastStand",
    name: "Last stand",
    blurb: "Sworn not to run. When the company is half gone they cannot break, and they strike half again as hard. Once.",
    duration: 20,
    cooldown: 0,
    uses: 1,
  },
  laager: {
    id: "laager",
    name: "Circle the wagons",
    blurb: "Threatened, the wagons chain into a ring: they stop, they shrug off most of what hits them, and friends beside them are sheltered.",
    duration: 14,
    cooldown: 20,
    uses: 0,
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
/** How much faster sappers dig once they have dug in properly. */
export const ENTRENCH_SPEED = 3;
/** Share of missing health triage puts back, on the men who most need it. */
export const TRIAGE_HEAL = 0.45;
/** How far from the surgeons triage reaches. */
export const TRIAGE_RADIUS = 150;
/** Share of a charge's harm that gets through a set hedge of pikes. */
export const SET_PIKES_PASS = 0.25;
/** Share of an arrow's harm that gets past a planted pavise. */
export const PAVISE_PASS = 0.35;
/** Extra harm of a couched-lance shock, on top of the ordinary charge bonus. */
export const COUCH_BONUS = 1.1;
/** How much harder a champion strikes while his challenge stands. */
export const CHALLENGE_STRIKE = 2;
/** Nerve torn out of every enemy near a champion when he calls his challenge. */
export const CHALLENGE_SHOCK = 0.12;
/** Reach of the champion's challenge. */
export const CHALLENGE_RADIUS = 140;
/** How far a raised standard is seen, and the nerve it puts back per second. */
export const RALLY_RADIUS = 240;
export const RALLY_GAIN = 0.06;
/** Drums: reach, and how much faster the companies in step march. */
export const CADENCE_RADIUS = 220;
export const CADENCE_HASTE = 1.25;
/** Hounds: reach of the panic, nerve drained per second, and horses' share. */
export const TERROR_RADIUS = 110;
export const TERROR_DRAIN = 0.07;
export const TERROR_HORSE = 2.5;
/** Oath-sworn: nerve floor while the stand lasts, and their extra bite. */
export const LAST_STAND_FLOOR = 0.32;
export const LAST_STAND_STRIKE = 1.5;
/** Wagons: what gets through to them, reach of their shelter, and its soak. */
export const LAAGER_PASS = 0.3;
export const LAAGER_RADIUS = 120;
export const LAAGER_SHELTER = 0.3;
