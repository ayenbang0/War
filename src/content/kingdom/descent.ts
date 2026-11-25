/**
 * Every number of the descent from the kingdom map into a battle (PLAN.md
 * §B.9, phase K5): when two armies are in contact, what withdrawing costs,
 * what a battle's result is worth to the realm, what a walled holding fields
 * when nobody holds it but its townsmen, how the auto-resolve weighs two
 * armies, and the crown's opening hosts.
 *
 * Plain data, as the rest of content/kingdom/. Every value here is a first
 * guess and provisional (docs/PROVISIONAL.md K5.x); the rules that read them
 * live in src/sim/kingdom/descent.ts and autoresolve.ts.
 */

import type { CommanderId } from "../commanders.ts";
import type { DifficultyId } from "../difficulty.ts";
import type { DoctrineId } from "../doctrines.ts";
import type { UnitTypeId } from "../unit-types.ts";
import { CONTACT_MILES } from "./armies.ts";
import type { FactionId } from "./factions.ts";

/**
 * Miles within which two hostile armies on the same road (or one at a holding
 * and one on a road out of it) are in contact. The same reach K4 gave an
 * intercept, so "meets" means one thing on the map.
 */
export const ENGAGE_RADIUS = CONTACT_MILES;

// -- withdrawing ---------------------------------------------------------------------

/** Withdrawing from a contact leaves this share of the men behind as a rearguard (per mille; at least one man). */
export const WITHDRAW_REARGUARD_PERMILLE = 100;
/** ...and costs this much of the army's morale (0..100). */
export const WITHDRAW_MORALE = 10;

// -- what a battle is worth ------------------------------------------------------------

/** Legitimacy the king gains for a battle won, and loses for one lost (ledger: deeds / disgrace). */
export const WIN_LEGITIMACY = 2;
export const LOSS_LEGITIMACY = 1;
/** A man still standing at the end with less than this share of his hit points comes home wounded. */
export const WOUNDED_HP_FRACTION = 0.5;

/**
 * Kingdom morale (0..100) to a soldier's starting nerve (0..1) and back.
 * A soldier's nerve is 1 when fresh and the battle's rest ceiling is 0.72, so
 * the kingdom's scale is laid over the top half: 0 morale is a nerve of 0.5,
 * the starting 60 is 0.8, a full 100 is 1.
 */
export const NERVE_FLOOR = 0.5;
export function nerveFromMorale(morale: number): number {
  return NERVE_FLOOR + (morale * (1 - NERVE_FLOOR)) / 100;
}

// -- walls without an army ------------------------------------------------------------------

export type Fortification = "none" | "palisade" | "wall" | "keep";
export const FORTIFICATIONS: readonly Fortification[] = ["none", "palisade", "wall", "keep"];

/**
 * A walled holding with no army in it still fights: its townsmen man the
 * walls. Squads of spearmen per kind of wall, each as full as one man in ten
 * of the holding's people allows.
 */
export const MILITIA_SQUADS: Readonly<Record<Fortification, number>> = { none: 0, palisade: 1, wall: 2, keep: 3 };
export const MILITIA_UNIT: UnitTypeId = "line";
export const MILITIA_PEOPLE_PER_MAN = 10;
export const MILITIA_MORALE = 60;

// -- the auto-resolve (sim/kingdom/autoresolve.ts) -------------------------------------------

export const AUTORESOLVE = {
  /**
   * "Resolve for me": the player's side fights without the player, under a
   * sergeant. Its strength counts for this much, and its losses are this much
   * heavier, so the abstract fight is strictly worse in expectation than the
   * one the player could fight (docs/kingdom.md, K5).
   */
  playerPower: 0.8,
  playerLosses: 1.25,
  /** A defender dug in (holding its ground two days or more) fights as this much more. */
  dugIn: 1.15,
  /** Walls count for this much more. */
  walls: { none: 1, palisade: 1.25, wall: 1.5, keep: 1.8 } as Readonly<Record<Fortification, number>>,
  /** The loser loses between these shares of its fit men; the winner between these. */
  loserLoss: [0.3, 0.6] as readonly [number, number],
  winnerLoss: [0.05, 0.25] as readonly [number, number],
  /** Of the men lost, this share are dead; the rest come home wounded. */
  deadShare: 0.5,
  /** Morale after: the winner gains, the loser falls (0..100 points). */
  winnerMorale: 5,
  loserMorale: 20,
} as const;

// -- who fights for whom ----------------------------------------------------------------------

/**
 * Whose battle habits a faction's army fights with. A captain is its own; the
 * Margrave and the Chancellor have no battle commander of their own, so they
 * borrow the nearest temperament (the Margrave bold like the Boar, the
 * Chancellor patient like the Owl).
 */
export const FACTION_BATTLE_COMMANDER: Readonly<Record<FactionId, CommanderId>> = {
  king: "badger", usurper: "owl", margrave: "boar",
  boar: "boar", fox: "fox", badger: "badger", hare: "hare", wolf: "wolf", owl: "owl", stag: "stag", crow: "crow",
  // K8: an angry town fights the way the Boar does: straight at you.
  commons: "boar",
};

/** How well a faction's armies are commanded in battle. The Act I captain is met at the easiest. */
export const FACTION_BATTLE_DIFFICULTY: Readonly<Record<FactionId, DifficultyId>> = {
  king: "recruit", usurper: "captain", margrave: "captain",
  boar: "sergeant", fox: "sergeant", badger: "sergeant", hare: "recruit", wolf: "sergeant", owl: "sergeant",
  stag: "sergeant", crow: "sergeant", commons: "recruit",
};

// -- the crown's opening hosts ------------------------------------------------------------------

export type HostDef = {
  readonly faction: FactionId;
  /** Holding key it stands in on day one. */
  readonly at: string;
  readonly units: readonly UnitTypeId[];
  readonly doctrine: DoctrineId;
};

/**
 * Armies the crown has in the field when the exile begins. K8 gives the
 * captains armies of their own and an AI to move them; until then this is the
 * minimum the story needs: Act I's "win the first skirmish" needs an enemy to
 * march into. The Hare's riders stand at Harrowfield, the Hare's seat at the
 * end of the road out of the Reach.
 */
export const OPENING_HOSTS: readonly HostDef[] = [
  { faction: "hare", at: "harrowfield", units: ["scout", "scout", "skirmisher"], doctrine: "raiding" },
];
