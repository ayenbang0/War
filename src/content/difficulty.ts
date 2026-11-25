/**
 * Difficulty settings.
 *
 * Deliberately does NOT hand the machine better troops, more of them, or sight
 * through fog. An opponent that cheats is not harder, it is arbitrary, and it
 * makes the player's own scouting and positioning meaningless.
 *
 * NUMBERS ARE EQUAL AT EVERY SETTING. The enemy is built to the same points the
 * player actually spent, so a harder opponent is harder only because it is
 * better commanded: it reconsiders more often, commits faster, and concentrates
 * more readily. Difficulty used to scale its purse as well, which meant the top
 * setting simply fielded more men -- that is not a better commander, it is a
 * bigger army.
 */

export type DifficultyId = "levy" | "recruit" | "sergeant" | "captain" | "colonel" | "marshal";

export type Difficulty = {
  readonly id: DifficultyId;
  readonly name: string;
  readonly blurb: string;
  /** Ticks between the AI reconsidering. Lower reacts faster. */
  readonly thinkInterval: number;
  /** Ticks a group is left to carry out an order before being re-tasked. */
  readonly commitTicks: number;

  /** How willing it is to converge several groups on one target. 0..1. */
  readonly focus: number;
};

export const DIFFICULTIES: Record<DifficultyId, Difficulty> = {
  levy: {
    id: "levy",
    name: "Levy",
    blurb: "Barely thinks at all and almost never concentrates. For learning the pen. Same numbers as you.",
    thinkInterval: 60,
    commitTicks: 160,
    focus: 0.05,
  },
  recruit: {
    id: "recruit",
    name: "Recruit",
    blurb: "Slow to react, commits late, and fights piecemeal. Same numbers as you.",
    thinkInterval: 40,
    commitTicks: 110,
    focus: 0.15,
  },
  sergeant: {
    id: "sergeant",
    name: "Sergeant",
    blurb: "Sound enough, a little slow to see an opening. Same numbers as you.",
    thinkInterval: 30,
    commitTicks: 84,
    focus: 0.32,
  },
  captain: {
    id: "captain",
    name: "Captain",
    blurb: "Reacts steadily and concentrates when it sees an opening. Same numbers as you.",
    thinkInterval: 20,
    commitTicks: 60,
    focus: 0.5,
  },
  colonel: {
    id: "colonel",
    name: "Colonel",
    blurb: "Quick to answer and quick to concentrate. Punishes a company left alone. Same numbers as you.",
    thinkInterval: 14,
    commitTicks: 44,
    focus: 0.68,
  },
  marshal: {
    id: "marshal",
    name: "Marshal",
    blurb: "Re-reads the field constantly and cuts off stragglers. Same numbers as you.",
    thinkInterval: 10,
    commitTicks: 32,
    focus: 0.85,
  },
};

export const DIFFICULTY_IDS: readonly DifficultyId[] = [
  "levy", "recruit", "sergeant", "captain", "colonel", "marshal",
];
