/**
 * Named opposing commanders.
 *
 * Difficulty already says how WELL the machine is run -- how often it
 * reconsiders, how fast it commits, how readily it concentrates. It says
 * nothing about who is running it, so every opponent fought identically and the
 * only thing to learn was the difficulty slider.
 *
 * A commander is a set of leanings, not a set of stats. None of these makes the
 * enemy stronger; they make it PREDICTABLE IN A PARTICULAR WAY, which is the
 * thing a player can actually read and then exploit. The Boar always comes at
 * the centre, so you give ground and take it in the flanks. The Fox always
 * goes wide, so you refuse the flank and hit the middle while it is still
 * marching. That is where the fun in fighting a machine lives: a habit you can
 * punish.
 *
 * Named for animals rather than people, because the name is meant to BE the
 * tell -- you should be able to guess how a Badger fights before it moves.
 *
 * Deliberately orthogonal to difficulty. The Fox at Marshal is the same
 * commander thinking faster, not a different one.
 */

import type { Playstyle } from "../sim/ai.ts";

export type CommanderId = "boar" | "fox" | "badger" | "hare";

export type Commander = {
  readonly id: CommanderId;
  readonly name: string;
  readonly epithet: string;
  /** Shown when choosing. Says the habit plainly -- it is meant to be known. */
  readonly blurb: string;
  /**
   * Multipliers on how appealing each posture looks when the situation is
   * weighed. 1 is neutral; below 1 means this commander avoids it.
   */
  readonly bias: Record<Playstyle, number>;
  /**
   * How willing he is to fight at a disadvantage. Shifts the strength ratio at
   * which he turns cautious, so a bold commander presses attacks he should not.
   */
  readonly boldness: number;
};

export const COMMANDERS: Record<CommanderId, Commander> = {
  boar: {
    id: "boar",
    name: "Boar",
    epithet: "who only knows forward",
    blurb: "Comes straight at the centre and keeps coming. Give ground and take them in the flanks.",
    bias: { aggressive: 2.2, defensive: 0.35, maneuver: 0.5, reactive: 0.9 },
    boldness: 1.35,
  },
  fox: {
    id: "fox",
    name: "Fox",
    epithet: "never where you looked",
    blurb: "Refuses the battle in front of them. Ignore the flank and hit the middle while they march.",
    bias: { aggressive: 0.5, defensive: 0.7, maneuver: 2.4, reactive: 1.0 },
    boldness: 0.95,
  },
  badger: {
    id: "badger",
    name: "Badger",
    epithet: "who will not be moved",
    blurb: "Digs in and makes you come. Bring something that breaks a line, or leave them alone.",
    bias: { aggressive: 0.4, defensive: 2.3, maneuver: 0.7, reactive: 1.1 },
    boldness: 0.7,
  },
  hare: {
    id: "hare",
    name: "Hare",
    epithet: "who cannot stand still",
    blurb: "Will not sit still and will not dig in. Weather the first rush and there is nothing behind it.",
    // Every leaning above 1 would make this one simply keener than the rest,
    // which is not a character. The weakness is a refusal to hold ground even
    // when holding it is plainly the right answer.
    bias: { aggressive: 1.5, defensive: 0.55, maneuver: 1.4, reactive: 1.2 },
    boldness: 1.15,
  },
};

export const COMMANDER_IDS: readonly CommanderId[] = ["boar", "fox", "badger", "hare"];
