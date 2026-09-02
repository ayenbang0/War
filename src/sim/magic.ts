/**
 * Medium-intensity tactical magic (spec section 6.2).
 *
 * Nothing here breaks a battle open. Workings are area buffs, debuffs, healing
 * and nerve -- things that tilt an engagement a squad is already in, not things
 * that win one on their own. The strongest ward is worth roughly a doctrine's
 * armour bonus for a few seconds over a small area.
 *
 * NO NEW GESTURES. The pen vocabulary is fourteen classes wide and provably
 * diagonal; every class added raises collision pressure on all the others, and
 * a spell menu would breach the pen-only rule outright. Instead an adept squad
 * works whichever spell suits the order it already has -- told to attack it
 * hexes, told to hold it wards, left alone near wounded it mends. The player
 * casts by choosing where the adepts stand and what they are told to do, which
 * is what "tactical, not cinematic" ought to mean.
 */

import { clamp, min } from "./math.ts";

export type SpellId =
  | "ward" | "hex" | "mend" | "succour"
  | "fireball" | "bolt" | "mire" | "valour";

/**
 * What a working DOES, beyond sitting on the ground.
 *
 * `burst` lands its damage once, the instant it is worked -- a fireball is an
 * event, not a weather system -- while everything else is read per tick for as
 * long as it stands.
 */
export type SpellKind = "field" | "burst";

export type Spell = {
  readonly id: SpellId;
  readonly name: string;
  readonly kind: SpellKind;
  /** Damage on landing, for the offensive ones. */
  readonly damage?: number;
  /** Fraction of its speed a mired unit keeps. */
  readonly slow?: number;
  /** World-unit radius of effect. */
  readonly radius: number;
  /** Seconds the working lasts once placed. */
  readonly duration: number;
  /** Seconds before the same squad may work it again. */
  readonly cooldown: number;
  /** Whether it lands on allies or enemies. */
  readonly onAllies: boolean;
};

export const SPELLS: Record<SpellId, Spell> = {
  ward: {
    id: "ward",
    kind: "field",
    name: "Ward",
    radius: 190,
    duration: 12,
    cooldown: 16,
    onAllies: true,
  },
  hex: {
    id: "hex",
    kind: "field",
    name: "Hex",
    radius: 165,
    duration: 9,
    cooldown: 14,
    onAllies: false,
  },
  mend: {
    id: "mend",
    kind: "field",
    name: "Mend",
    radius: 175,
    duration: 14,
    cooldown: 20,
    onAllies: true,
  },
  /**
   * The surgeons' working: healing over time and steadied nerve together
   * (spec 6.2 lists both). Wider and far more frequent than an adept's mend,
   * but it does nothing offensive at all -- surgeons treat men, they do not
   * fight, and an army that spends points on them is buying staying power
   * rather than force.
   */
  succour: {
    id: "succour",
    kind: "field",
    name: "Succour",
    radius: 210,
    // Held to the same rules as every other working: nothing lasts beyond
    // fifteen seconds, and nothing may be sustained without a gap. Surgeons get
    // the shortest gap of any caster rather than an unbroken effect.
    duration: 13,
    cooldown: 15,
    onAllies: true,
  },
  /**
   * A fireball: a real splash, landed once where it was thrown.
   *
   * The only thing an adept has that KILLS rather than tilts, and the reason
   * the doctrine is worth taking. Short duration because the burst is the
   * whole spell -- what lingers is only the scorch mark on the ground.
   */
  fireball: {
    id: "fireball",
    kind: "burst",
    name: "Fireball",
    damage: 58,
    radius: 130,
    duration: 2,
    cooldown: 11,
    onAllies: false,
  },
  /** A single bolt: less than a fireball, thrown further and more often. */
  bolt: {
    id: "bolt",
    kind: "burst",
    name: "Bolt",
    damage: 40,
    radius: 62,
    duration: 1.5,
    cooldown: 7,
    onAllies: false,
  },
  /** Ground turned to mire. Does no harm; simply refuses to be crossed. */
  mire: {
    id: "mire",
    kind: "field",
    slow: 0.45,
    name: "Mire",
    radius: 175,
    duration: 12,
    cooldown: 15,
    onAllies: false,
  },
  /** Heart put into the men who hear it. */
  valour: {
    id: "valour",
    kind: "field",
    name: "Valour",
    radius: 200,
    duration: 12,
    cooldown: 14,
    onAllies: true,
  },
};

export const SPELL_IDS: readonly SpellId[] =
  ["ward", "hex", "mend", "succour", "fireball", "bolt", "mire", "valour"];

/**
 * What an adept may reach for, split by what the moment calls for.
 *
 * An adept picks at RANDOM from the appropriate list rather than always working
 * the same thing, so two adept companies in one battle do not read as one
 * company copied twice -- and so a player cannot learn a single counter.
 */
export const OFFENSIVE_SPELLS: readonly SpellId[] = ["fireball", "bolt", "hex", "mire"];
export const SUPPORTIVE_SPELLS: readonly SpellId[] = ["ward", "valour", "mend"];

/** A working currently standing on the field. */
export type Working = {
  readonly spell: SpellId;
  readonly player: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** Tick at which it fades. */
  readonly until: number;
  /** Doctrine-scaled strength, 1 being nominal. */
  readonly power: number;
};

/** Damage reduction a ward grants, capped so armour never becomes immunity. */
export function wardSoak(power: number): number {
  return min(0.4, 0.22 * power);
}

/** Fractional damage a hex adds to blows landing on those inside it. */
export function hexPenalty(power: number): number {
  return min(0.5, 0.25 * power);
}

/** Hit points a mend restores per second to each soldier inside it. */
export function mendRate(power: number, maxHp: number): number {
  return maxHp * 0.035 * clamp(power, 0, 2.5);
}

/** Hit points succour restores per second. Steadier than a mend, and surer. */
export function succourRate(power: number, maxHp: number): number {
  return maxHp * 0.055 * clamp(power, 0, 2.5);
}

/** Morale a ward steadies, or a hex saps, per second. */
export function nerveShift(spell: SpellId, power: number): number {
  if (spell === "ward") return 0.012 * power;
  if (spell === "hex") return -0.018 * power;
  // Succour is the morale boost the spec asks for: a surgeon working among the
  // wounded is worth more to a company's nerve than to its hit points.
  if (spell === "succour") return 0.026 * power;
  if (spell === "valour") return 0.03 * power;
  if (spell === "mire") return -0.008 * power;
  return 0.006 * power;
}
