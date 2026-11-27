/**
 * K11: difficulty at the kingdom layer (PLAN.md §B.11, "difficulty at kingdom
 * layer"), as plain data the sim reads.
 *
 * The owner's steer: "The game needs to be a lot easier with managing
 * resources." So the default for a new exile is Gentle, and every knob but
 * the last three is about the king's own stores -- how much his towns eat,
 * how much his fields give, what his soldiers cost, what the first holding
 * brings and what foraging finds. The rival captains' economies are never
 * touched: they play the same realm at every setting, as the battle layer's
 * difficulty (content/difficulty.ts) never hands the machine more men.
 *
 * The last three are about the pressure the realm puts on him: how long the
 * captains leave his holdings alone (their grace), when the story's invasion
 * waves ride, and how well the machine commands its men when a meeting is
 * fought out on the field (a shift along content/difficulty.ts's ladder).
 *
 * Standard is the tuning every phase before K11 was balanced and tested
 * against: every number below is the identity there, which is why the
 * kingdom golden and every older suite keep their realm byte for byte (the
 * sim's default difficulty is Standard; a NEW GAME picks Gentle). All
 * percentages are whole numbers, applied with integer arithmetic.
 */

export type KingdomDifficultyId = "gentle" | "standard" | "hard";

export type KingdomDifficulty = {
  readonly id: KingdomDifficultyId;
  readonly name: string;
  /** One line for the new-game choice: what it changes, in the player's words. */
  readonly blurb: string;
  /** Percent of the usual grain the king's towns draw a day. */
  readonly dolePct: number;
  /** Percent of the usual harvest the king's fields give. */
  readonly yieldPct: number;
  /** Percent of the usual wages the king's trained squads are owed. */
  readonly wagePct: number;
  /** Percent of the first holding's gift of stores (content/kingdom/economy.ts FIRST_HOLDING_STORES). */
  readonly firstStoresPct: number;
  /** Added to the king's foraging percent (as an exploration upgrade's foragePct is). */
  readonly forageBonusPct: number;
  /** Days from the start before a captain may raid or besiege the king's holdings (invasions.ts AI.graceDays at Standard). */
  readonly graceDays: number;
  /** Days added to each story invasion wave's day (INVASION_WAVES). */
  readonly waveDelayDays: number;
  /**
   * A story wave rides only once the king holds at least this many holdings:
   * on Gentle the lords send their hosts against a king who has become a
   * threat, never against an exile still sitting in his first hamlet (the
   * K11 sweep found a king with no army lost his only holding, and with it
   * the story, to the first wave at every other setting).
   */
  readonly waveMinHoldings: number;
  /** Steps along the battle difficulty ladder for the machine's commander in a battle the king fights (negative: easier). */
  readonly battleShift: number;
};

export const KINGDOM_DIFFICULTIES: Readonly<Record<KingdomDifficultyId, KingdomDifficulty>> = {
  gentle: {
    id: "gentle",
    name: "Gentle",
    blurb: "Towns eat less, fields give more, soldiers cost less, and the rival lords are slower to ride against you. For playing the story.",
    dolePct: 70,
    yieldPct: 130,
    wagePct: 70,
    firstStoresPct: 150,
    forageBonusPct: 25,
    graceDays: 450,
    waveDelayDays: 120,
    waveMinHoldings: 3,
    battleShift: -1,
  },
  standard: {
    id: "standard",
    name: "Standard",
    blurb: "The realm as it was balanced: stores need watching through the first winter, and the lords ride when the story says.",
    dolePct: 100,
    yieldPct: 100,
    wagePct: 100,
    firstStoresPct: 100,
    forageBonusPct: 0,
    graceDays: 300,
    waveDelayDays: 0,
    waveMinHoldings: 0,
    battleShift: 0,
  },
  hard: {
    id: "hard",
    name: "Hard",
    blurb: "Lean harvests, hungrier towns, dearer soldiers, and lords who ride early and command well.",
    dolePct: 120,
    yieldPct: 85,
    wagePct: 125,
    firstStoresPct: 70,
    forageBonusPct: -15,
    graceDays: 210,
    waveDelayDays: -60,
    waveMinHoldings: 0,
    battleShift: 1,
  },
};

export const KINGDOM_DIFFICULTY_IDS: readonly KingdomDifficultyId[] = ["gentle", "standard", "hard"];

/** What a world built without saying runs on: the tuning every older suite and save knew. */
export const SIM_DEFAULT_DIFFICULTY: KingdomDifficultyId = "standard";

/** What a new game offers first (the owner: "a lot easier with managing resources"). */
export const NEW_GAME_DIFFICULTY: KingdomDifficultyId = "gentle";

export function isKingdomDifficulty(v: unknown): v is KingdomDifficultyId {
  return typeof v === "string" && (KINGDOM_DIFFICULTY_IDS as readonly string[]).includes(v);
}
