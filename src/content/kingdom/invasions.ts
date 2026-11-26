/**
 * K8: the captains' strategic AI, invasions and the defence tools (PLAN.md
 * §B.8). Numbers only; the rules are in sim/kingdom/ai.ts (the AI) and
 * sim/kingdom/invasions.ts (the captains' start, rumours, the levy call,
 * burning the fields, ambush, holdings taken undefended).
 *
 * Every number here is provisional (docs/PROVISIONAL.md K8.n): the plan says
 * what the AI does, not how hard. The pacing ones are tuned for Act I's
 * promise -- the king must have time to survive his first winter and claim
 * two holdings before anyone comes for them (§A.5).
 */

import type { UnitTypeId } from "../unit-types.ts";
import type { BuildingId } from "./buildings.ts";
import type { StockId } from "./economy.ts";
import type { FactionId } from "./factions.ts";
import type { Fortification } from "./descent.ts";

// -- the captains' start --------------------------------------------------------------

/**
 * Each captain's stores on day one. A crown town feeds itself (economy.ts
 * drawsDole), so the grain is the armies' bread until the steward's first
 * harvest; the coin a few weeks of wages, the iron a few squads.
 */
export const CAPTAIN_START: Readonly<Record<StockId, number>> = { coin: 300, grain: 2400, timber: 60, iron: 30, levy: 40 };
/**
 * Grain a crown town pays its lord a day, per 100 people (halved when
 * restless, like its coin): its own bread it keeps (economy.ts drawsDole).
 * Enough for a captain to feed a garrison and a field host from his seat and
 * province without starving the realm in the first winter.
 */
export const CROWN_TITHE_PER_100 = 8;

/** A captain's legitimacy on day one: in the middle band, where it neither soothes nor stirs its towns. */
export const CAPTAIN_START_LEGITIMACY = 40;

/** Works standing in every seat on day one, in the order they take its free slots. */
export const SEAT_WORKS: readonly BuildingId[] = ["barracks", "palisade", "granary"];

/**
 * K10: works raised over the seat works at the Crown Seat, each over the work
 * it upgrades (buildings.ts): Rimaros is walled in stone, so taking it back
 * is a siege (docs/PROVISIONAL.md K10.8).
 */
export const CROWN_SEAT_WORKS: readonly BuildingId[] = ["wall"];

/** The garrison every seat starts with: an army in the hold posture that stands as its garrison. */
export const SEAT_GARRISON: readonly UnitTypeId[] = ["line", "archer"];

/**
 * Each faction's field host on day one, raised at its seat. The Hare's is
 * K5's opening riders when the realm has them (descent.ts OPENING_HOSTS),
 * so the Act I skirmish is unchanged.
 */
export const FIELD_HOSTS: Readonly<Partial<Record<FactionId, readonly UnitTypeId[]>>> = {
  usurper: ["guard", "line", "line", "crossbow"],
  margrave: ["lancer", "line", "line", "archer"],
  boar: ["line", "line", "horse"],
  fox: ["skirmisher", "horse", "archer"],
  badger: ["pike", "line", "archer"],
  hare: ["scout", "scout", "skirmisher"],
  wolf: ["horse", "horse", "line"],
  owl: ["line", "crossbow", "archer"],
  stag: ["lancer", "line", "archer"],
  crow: ["skirmisher", "archer", "line"],
};

// -- the AI's temperament ------------------------------------------------------------------

export const AI = {
  /** Days a goal is kept before it is weighed again (sooner if its target is gone). */
  goalDays: 12,
  /** The goal already held counts for this much more: hysteresis, so a captain does not dither. */
  keepGoal: 1.25,
  /** Each goal's score is scaled by 100..100+jitterPct percent, drawn on the kingdomAi stream. */
  jitterPct: 20,
  /**
   * Days from the start before any captain moves against the king. Act I's
   * winter is days 90-179; this leaves a season after it (§A.5, K8.1). ECON:
   * was 100 on the old four-month year (winter days 30-59); rescaled with the
   * seasons, so the king still has the same share of the year to settle.
   */
  graceDays: 300,
  /** An emergent invasion needs the king seen holding at least this many holdings... */
  emergentMinKingHoldings: 2,
  /** ...and one of them seen with fewer men than this in its garrison (a thin garrison invites it). */
  thinGarrisonMen: 20,
  /** Farthest (straight-line miles from its seat) a captain sends a host on its own account. */
  reachMiles: 260,
  /** A host marches only with this many days of bread for its men in the stores or its packs. */
  marchBreadDays: 6,
  /** The steward recruits only with this many days of bread for every man already under arms in store. */
  recruitBreadDays: 20,
  /** With fewer days of bread than this for every man under arms in store, the steward stands a field army down at home. */
  disbandBreadDays: 3,
  /** A host out in the country this many days hungry turns for home (desertion starts after HUNGER_GRACE_DAYS). */
  homeHungerDays: 1,
  /** Coin the steward keeps back from recruiting: a few days of wages. */
  reserveCoin: 60,
  /** Men the steward wants in the field hosts, recruited toward at the seat's barracks. */
  fieldMen: 60,
  /** An attack is made only on a defence this many times weaker than the host sent (as the AI knows it). */
  margin: 1.2,
  /** Sites in its own provinces a captain explores, within this many miles of its seat. */
  exploreMiles: 120,
  /** Men a holding's walls are reckoned to put up per squad of townsmen, when the AI weighs an assault. */
  militiaGuess: 10,
} as const;

/** Unit raised when the steward recruits, in order of preference (the first the barracks can afford). */
export const AI_RECRUIT: readonly UnitTypeId[] = ["line", "archer"];

// -- invasions -------------------------------------------------------------------------------

export type InvasionWave = {
  /** Calendar day (days since the start) the wave rides. */
  readonly day: number;
  readonly faction: FactionId;
};

/**
 * The story's waves (scheduled invasions): on its day the faction's goal
 * becomes the king's nearest holding it knows of, whatever its temper says.
 * With none known it rides for the Farthest Reach, where the exile was last
 * heard of (that much is common talk, not something it saw), and looks.
 */
export const INVASION_WAVES: readonly InvasionWave[] = [
  // ECON: days 120/200/280 on the old four-month year, x3 with the seasons
  // (the Hare still rides in the first summer, the Badger in the third spring).
  { day: 360, faction: "hare" },
  { day: 600, faction: "boar" },
  { day: 840, faction: "badger" },
];

/** Days a wave keeps its goal before the captain may think better of it. */
export const WAVE_DAYS = 90;

// -- warning ---------------------------------------------------------------------------------

/**
 * How many days out the king hears of a host riding at one of his holdings:
 * a base, more for every watchtower of his standing near the holding, more
 * for every scout squad in his armies near it; a host he can see he always
 * hears of (PLAN §B.8, "warning time is proportional to watchtowers/scouts").
 */
export const WARNING = {
  baseDays: 1,
  perTower: 2,
  perScout: 1,
  /** A watchtower this near the threatened holding counts. */
  towerMiles: 80,
  /** A scout squad in an army this near it counts. */
  scoutMiles: 60,
  maxDays: 7,
} as const;

// -- defence tools ----------------------------------------------------------------------------

/**
 * The levy call: the holding's people turned out at once as levy squads --
 * poor (raw men, low morale) but there today. It empties the fields and
 * frightens the town.
 */
export const LEVY_CALL = {
  /** One man answers for this many people. */
  peoplePerMan: 8,
  maxSquads: 3,
  /** Fewer men than this and the call is not worth making. */
  minMen: 4,
  /** The levy's morale: raw men. */
  morale: 35,
  /** Unrest it adds to the holding, permille. */
  unrest: 120,
  /** Days before the same holding can be called again. */
  cooldownDays: 30,
  unit: "line" as UnitTypeId,
} as const;

/** Burning the fields: every crop in the ground there is lost, and no army can forage there for a while. */
export const BURN_FIELDS = {
  /** Days the land gives an army nothing. */
  days: 30,
  /** Unrest it adds to the holding, permille: the people's own bread burned. */
  unrest: 150,
} as const;

/** Unrest in a holding taken without a battle (its garrison gone): a little less than one stormed. */
export const SEIZED_UNREST = 200;

/**
 * The battle effects of walls and ambush (app/battle-config.ts): a defender
 * behind walls starts steadier; an army that walks into an ambush starts
 * shaken. As nerve (0..1) added, or multiplied.
 */
export const WALL_NERVE: Readonly<Record<Fortification, number>> = { none: 0, palisade: 0.1, wall: 0.15, keep: 0.2 };
export const AMBUSHED_NERVE = 0.8;

/**
 * Retreat to the keep: the townsmen give up the town and hold the keep, which
 * forces a siege -- from K10 a real one, fought behind the keep's two courses
 * of stone (descent.ts keepSiege) -- and the town outside is sacked (its
 * crops lost, its people's unrest raised).
 */
export const KEEP_RETREAT = {
  /** Walls that have a keep (or a stone wall with a tower to retire to) to retreat into. */
  needs: ["wall", "keep"] as readonly Fortification[],
  unrest: 100,
} as const;

/** Legitimacy the king loses for yielding a town without a fight. */
export const YIELD_LEGITIMACY = 3;
