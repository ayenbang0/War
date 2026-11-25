/**
 * Armies on the kingdom map (PLAN.md §B.4, §B.11a, phase K4): what a squad
 * costs to raise and to keep, how fast an army marches, what hunger and
 * empty purses do to it, and how it mends. Plain data; the sim
 * (src/sim/kingdom/armies.ts) reads it and nothing here branches.
 *
 * The battle rulebook stays the one source for what a squad IS: its men
 * (UNIT_TYPES.soldiers), its point cost, its speed and the per-type caps
 * (UNIT_TYPES.maxPerArmy, MAX_SQUADS, MAX_OF_ONE_ABILITY). The numbers here
 * only turn those into kingdom stocks -- coin is points x COIN_PER_POINT, a
 * day's wage is half the points -- so retuning a unit in the battle game
 * retunes its price on the map in the same edit, and the K4 test holds the two
 * together.
 *
 * Every number is PROVISIONAL (docs/PROVISIONAL.md K4.x).
 */

import type { UnitTypeId } from "../unit-types.ts";
import type { DoctrineId } from "../doctrines.ts";
import type { Season } from "./terrain.ts";

/** Most armies one side may field at once (the brief, §B.4). Disband or merge to raise another. */
export const MAX_ARMIES_PER_SIDE = 8;

/**
 * Coin per battle point to raise a trained squad. A line company (3 points)
 * costs 12 pennies -- about a week of a village's taxes -- so the first
 * barracks squad is a decision, not a reflex.
 */
export const COIN_PER_POINT = 4;

/**
 * Iron bars to arm a trained squad, by type: blades and mail for the line,
 * heads for arrows, barding, an engine's fittings. Types not listed need none
 * (slings, hounds, drums). A forge makes 1 bar a day.
 */
export const RECRUIT_IRON: Readonly<Partial<Record<UnitTypeId, number>>> = {
  line: 1, archer: 1, horse: 2, guard: 3, siege: 3, builder: 1, pike: 1, crossbow: 2, lancer: 2,
  champion: 2, oathsworn: 2, wagon: 1, skirmisher: 1,
};

/**
 * Squads the king's first followers can be formed into with no barracks, no
 * coin and no iron: men with spears and slings who came because he asked
 * (§A.5 amendment). Raised where the king stands, from the levy alone.
 */
export const LEVY_TYPES: readonly UnitTypeId[] = ["line", "slinger"];
/** Fewest followers that make a levy squad; a levy squad may be raised under strength. */
export const LEVY_MIN_MEN = 4;

/** The doctrine an army is raised under until the player sets one. */
export const DEFAULT_ARMY_DOCTRINE: DoctrineId = "defensive";

/** A trained squad's daily wage: half its battle points, rounded up. Levy squads serve for bread. */
export function dailyWage(points: number, levy: boolean): number {
  // Integer arithmetic (points are whole): the sim reads this, and its Math is sim/math.ts's.
  return levy ? 0 : (points + (points % 2)) / 2;
}

/** Grain (person-days) one man eats a day: the same ration as the king's party. */
export const ARMY_RATION = 1;
/** Grain one man carries in his pack, in person-days. */
export const CARRY_PER_MAN = 5;
/** Grain a wagon squad carries besides its drivers' packs. */
export const WAGON_CARRY = 120;

/**
 * Miles a day an army of the line marches in clear weather on a plain road:
 * slower than the king's party of three (18), which keeps off the main roads
 * and carries nothing.
 */
export const ARMY_MILES_PER_DAY = 14;
/** The battle speed that marches at ARMY_MILES_PER_DAY; an army goes at its slowest squad's pace. */
export const ARMY_SPEED_BASE = 30;
/** The slowest and fastest an army may march, as percent of ARMY_MILES_PER_DAY. */
export const ARMY_SPEED_PCT = { min: 50, max: 140 } as const;

/** Miles an army sees round itself: a little less than the king's party, which scouts as it goes. */
export const ARMY_SIGHT_MILES = 45;
/** Two armies within this many miles of each other have met (an intercept is complete). */
export const CONTACT_MILES = 3;

/** Army morale on raising, 0..100. A placeholder: K6 writes the rules that move it. */
export const START_MORALE = 60;

// -- hunger and unpaid wages ------------------------------------------------------

/** Days an army can go short of bread before men start to leave (it is the same grace for every army). */
export const HUNGER_GRACE_DAYS = 2;
/** Each hungry day past the grace, per mille of the men who walk home. */
export const HUNGER_DESERT_PERMILLE = 50;
/** ... and per mille who die of hunger and the sickness that follows it. */
export const HUNGER_DIE_PERMILLE = 20;
/** ... and per mille of the fit men who fall sick (counted with the wounded until they mend). */
export const HUNGER_SICK_PERMILLE = 60;
/** Days trained men will serve with wages owed before they start to go. */
export const UNPAID_GRACE_DAYS = 3;
/** Each day past the grace with wages owed, per mille of the trained men who leave. Levy squads are not paid and do not go. */
export const UNPAID_DESERT_PERMILLE = 30;
/**
 * The king's followers not yet formed into squads (the levy) are his party:
 * when the party goes hungry past the same grace (K3's `economy.hunger`, the
 * signal K3 left for K4), this per mille of them walk home each day, and at
 * least one while any are left.
 */
export const FOLLOWER_DESERT_PERMILLE = 50;

/**
 * Grain an army living off the land finds, per ten men per day, by season,
 * before the country's fertility (percent). Always under ten per ten men:
 * foraging slows hunger, it never feeds an army -- that is what wagons and
 * granaries are for -- and every day of it costs the plots round about.
 */
export const ARMY_FORAGE_PER_10: Readonly<Record<Season, number>> = { spring: 3, summer: 4, autumn: 6, winter: 1 };
/** What a day of an army's foraging takes off the health of every crop in the ground where it stands. */
export const FORAGE_PLOT_HARM = 20;

// -- recovery and replacement ---------------------------------------------------------

/**
 * Percent of a squad's wounded who mend a day while the army rests (the
 * recover order, a heart on the map), and at least one while any mend at all.
 * In an owned holding the town nurses them; a standing hall adds its
 * `later.recovery` x HEAL_PCT.perRecovery; each surgeon squad in the army adds
 * its own. In the field, away from any town of yours, only surgeons mend.
 */
export const HEAL_PCT = { owned: 10, perRecovery: 10, perHealerSquad: 10 } as const;
/** Men a squad below strength takes on a day while recovering at a barracks, each from the levy. */
export const REPLACE_MEN_PER_DAY = 2;
/** Iron a squad of an iron-using type spends on a day it takes on men. */
export const REPLACE_IRON_PER_DAY = 1;

/** Days in the hold posture before an army counts as dug in (K5 reads it for the defender's bonus). */
export const HOLD_DIG_IN_DAYS = 2;

// -- abilities, earned by the kingdom --------------------------------------------------

/** Legitimacy spent, beside the coin, to put a battle ability at an army's disposal (favours called in). */
export const ABILITY_LEGITIMACY = 2;

/** Names of armies by ordinal. A new army takes the lowest unused. */
export const ARMY_ORDINALS: readonly string[] = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth"];
