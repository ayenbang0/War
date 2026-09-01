/**
 * Difficulty settings.
 *
 * Deliberately does NOT hand the machine better troops or let it see through
 * fog. An opponent that cheats is not harder, it is arbitrary, and it makes the
 * player's own scouting and positioning meaningless. What changes instead is
 * how well it is commanded: how often it reconsiders, how quickly it commits,
 * how readily it concentrates, and how much of a budget it fields.
 */

export type DifficultyId = "recruit" | "captain" | "marshal";

export type Difficulty = {
  readonly id: DifficultyId;
  readonly name: string;
  readonly blurb: string;
  /** Ticks between the AI reconsidering. Lower reacts faster. */
  readonly thinkInterval: number;
  /** Ticks a group is left to carry out an order before being re-tasked. */
  readonly commitTicks: number;
  /** Multiplier on the enemy's point budget. */
  readonly budget: number;
  /** How willing it is to converge several groups on one target. 0..1. */
  readonly focus: number;
};

export const DIFFICULTIES: Record<DifficultyId, Difficulty> = {
  recruit: {
    id: "recruit",
    name: "Recruit",
    blurb: "Slow to react, commits late, fights piecemeal, and brings fewer men.",
    thinkInterval: 40,
    commitTicks: 110,
    budget: 0.8,
    focus: 0.15,
  },
  captain: {
    id: "captain",
    name: "Captain",
    blurb: "Reacts steadily, concentrates when it sees an opening, matches your budget.",
    thinkInterval: 20,
    commitTicks: 60,
    budget: 1.0,
    focus: 0.5,
  },
  marshal: {
    id: "marshal",
    name: "Marshal",
    blurb: "Re-reads the field constantly, cuts off stragglers, and fields more men than you.",
    thinkInterval: 10,
    commitTicks: 32,
    budget: 1.15,
    focus: 0.85,
  },
};

export const DIFFICULTY_IDS: readonly DifficultyId[] = ["recruit", "captain", "marshal"];
