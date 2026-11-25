/**
 * What a battle is built from: one plain, serialisable-shaped record.
 *
 * The lesson, the test launch (app/test-hook.ts) and (from K5) the kingdom
 * map all produce one of these, and the BattleLayer takes nothing else. That
 * is the seam the plan's descent needs (§B.9): the kingdom map arrives with
 * pre-built armies and no point-buy, so nothing about building a battle may
 * live in any one screen. (The old skirmish setup screen that also produced
 * these was removed with the sandbox modes: the game is the story only.)
 *
 * Pure: no DOM, no randomness. Whoever builds a setup picks its commander
 * before handing it over, so a config fully determines its battle.
 */

import { cost, validate, type ArmyList } from "../content/army.ts";
import type { AbilityId } from "../content/abilities.ts";
import type { Commander as Captain } from "../content/commanders.ts";
import { COMMANDERS } from "../content/commanders.ts";
import type { DifficultyId } from "../content/difficulty.ts";
import { LEVELS, type LevelDef } from "../content/levels/index.ts";
import type { UnitTypeId } from "../content/unit-types.ts";

/**
 * A battle as a player would choose one: ground, how hard, an army and its
 * reserve, and who leads the other side. The skirmish setup screen used to
 * build these; now only the test launch does, and K5's descent will build its
 * configs from the armies that met instead.
 */
export type Setup = {
  readonly level: LevelDef;
  readonly difficulty: DifficultyId;
  readonly army: ArmyList;
  /** Who the machine's army answers to. */
  readonly commander: Captain;
  /** Abilities bought; distinct ones are bound to keys 1..9, 0, - and = in that order. */
  readonly abilities: readonly AbilityId[];
};

/**
 * A battle is either fought or taught. The lesson is not a battle with a flag
 * on it: it has no clock, no enemy commander and no ability bar, and those are
 * decided by this one field rather than by booleans scattered through the loop.
 */
export type BattleMode = "battle" | "lesson";

export type BattleConfig = {
  readonly mode: BattleMode;
  readonly level: LevelDef;
  /** Player 0's army, then player 1's. */
  readonly armies: readonly [ArmyList, ArmyList];
  /** Who commands the machine's army. */
  readonly commander: Captain;
  readonly difficulty: DifficultyId;
  /** Abilities bought per side, copies included (a copy is a deeper magazine). */
  readonly abilities: readonly [readonly AbilityId[], readonly AbilityId[]];
};

/**
 * How long a lesson's world runs before its clock would end it: six hours.
 *
 * BS-05: The Crossing's own ten-minute clock used to end the lesson mid-step and
 * open the after-action report. The world still needs SOME duration, and six
 * hours is beyond any lesson; the HUD shows no clock in a lesson at all.
 */
export const LESSON_DURATION_SECONDS = 6 * 60 * 60;

/**
 * The enemy's army, drawn to its own budget.
 *
 * Composed greedily from a fixed preference order rather than copied from the
 * player, so a difficulty that affords more men fields a genuinely different
 * force, and the list stays legal if costs are ever retuned.
 */
export function enemyArmy(level: LevelDef, budget: number): ArmyList {
  const doctrine = level.enemyDoctrine;
  // The second roster is mixed in through the list rather than tacked on the
  // end, so even a small purse fields some of it and the enemy you meet is not
  // always the same ten kinds of men.
  const wish: UnitTypeId[] = [
    "line", "archer", "pike", "scout", "horse", "line", "skirmisher",
    "crossbow", "guard", "banner", "line", "hounds", "mage", "slinger", "siege",
    "archer", "oathsworn", "lancer", "healer", "skirmisher", "builder", "pike",
    "drummer", "line", "scout", "champion", "guard", "wagon", "archer", "horse",
    "line", "skirmisher", "mage", "crossbow", "line",
  ];
  const squads: UnitTypeId[] = [];
  // A siege cannot be fought without engines: the level's core goes first,
  // bought from the same purse and held to the same caps as anything else.
  for (const id of [...(level.enemyCore ?? []), ...wish]) {
    squads.push(id);
    if (!validate({ doctrine, squads }, budget).ok) squads.pop();
  }
  return { doctrine, squads };
}

/** A battle from a chosen setup (today the test launch only). */
export function battleFromSetup(setup: Setup): BattleConfig {
  return {
    mode: "battle",
    level: setup.level,
    // The enemy is built to what the PLAYER actually spent, never more. A
    // harder opponent is one that is better commanded, not one with a bigger
    // army -- difficulty used to scale its purse, which meant the top setting
    // simply fielded more men.
    armies: [setup.army, enemyArmy(setup.level, cost(setup.army))],
    commander: setup.commander,
    difficulty: setup.difficulty,
    // The machine is given the same kit, so nothing the player can spend is
    // something the player alone can spend.
    abilities: [setup.abilities, setup.abilities],
  };
}

/**
 * The lesson's fixed setup: the smallest field, a plain mixed force, and no
 * abilities. The lesson is about the pen; abilities are a separate idea and
 * would be one more thing to drop on a first run.
 */
export function lessonConfig(): BattleConfig {
  const level = LEVELS.reduce((a, b) => (a.tilesWide * a.tilesHigh <= b.tilesWide * b.tilesHigh ? a : b));
  const army: ArmyList = { doctrine: "defensive", squads: ["line", "line", "archer", "skirmisher"] };
  return {
    mode: "lesson",
    level,
    difficulty: "recruit",
    armies: [army, enemyArmy(level, cost(army))],
    // Named for the after-action report only: a lesson runs no enemy AI, so
    // nobody commands the far side (BS-05: an attack must not end the lesson).
    commander: COMMANDERS.badger,
    abilities: [[], []],
  };
}

/**
 * The abilities bound to keys, each appearing once.
 *
 * Buying an ability twice buys a deeper magazine, not a second thing to press,
 * so the keys address DISTINCT abilities -- otherwise buying two barrages put a
 * barrage on key 2 and pushed the shield out to key 3, which is not something a
 * player could be expected to work out mid-battle.
 */
export function distinctAbilities(bought: readonly AbilityId[]): AbilityId[] {
  const out: AbilityId[] = [];
  for (const id of bought) if (!out.includes(id)) out.push(id);
  return out;
}
