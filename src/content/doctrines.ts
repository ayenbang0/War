/**
 * Doctrines: army-wide modifiers chosen before deployment (spec section 6.3).
 *
 * Every doctrine is a trade, never a straight upgrade. They are applied once at
 * spawn and baked into each squad's own stat block rather than looked up in the
 * hot loops -- combat reads a squad's stats thousands of times a tick, and a
 * doctrine cannot change mid-match, so recomputing it there would be pure cost.
 */

export type DoctrineId = "aggressive" | "defensive" | "maneuver" | "magic";

export type Doctrine = {
  readonly id: DoctrineId;
  readonly name: string;
  readonly blurb: string;
  /** Multipliers applied to every squad in the army. */
  readonly speed: number;
  readonly turnRate: number;
  readonly attack: number;
  readonly defence: number;
  readonly hp: number;
  readonly sight: number;
  /** Multiplier on morale lost to casualties. Below 1 means steadier troops. */
  readonly resolve: number;
  /** Multiplier on spell strength and duration (Phase 7). */
  readonly magic: number;
};

export const DOCTRINES: Record<DoctrineId, Doctrine> = {
  aggressive: {
    id: "aggressive",
    name: "Aggressive",
    blurb: "Move fast, hit hard, and do not expect to be forgiven for mistakes.",
    speed: 1.18,
    turnRate: 1.1,
    attack: 1.15,
    defence: 0.82,
    hp: 1.0,
    sight: 1.0,
    resolve: 1.1,
    magic: 0.9,
  },
  defensive: {
    id: "defensive",
    name: "Defensive",
    blurb: "Hold ground, absorb the charge, and let them break on you.",
    speed: 0.85,
    turnRate: 0.9,
    attack: 0.92,
    defence: 1.3,
    hp: 1.12,
    sight: 1.0,
    resolve: 0.78,
    magic: 0.95,
  },
  maneuver: {
    id: "maneuver",
    name: "Maneuver",
    blurb: "Be where they are not. Re-form quickly, see further, commit late.",
    speed: 1.1,
    turnRate: 1.45,
    attack: 0.95,
    defence: 0.95,
    hp: 1.0,
    sight: 1.25,
    resolve: 0.95,
    magic: 1.0,
  },
  magic: {
    id: "magic",
    name: "Magic",
    blurb: "Stronger workings, at the cost of the arms that carry them.",
    speed: 0.95,
    turnRate: 1.0,
    attack: 0.85,
    defence: 0.85,
    hp: 0.92,
    sight: 1.1,
    resolve: 1.0,
    magic: 1.6,
  },
};

export const DOCTRINE_IDS: readonly DoctrineId[] = [
  "aggressive", "defensive", "maneuver", "magic",
];
