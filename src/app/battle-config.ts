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
import { DIFFICULTIES, type DifficultyId } from "../content/difficulty.ts";
import { LEVELS, levelById, type LevelDef } from "../content/levels/index.ts";
import { UNIT_TYPES, type UnitTypeId } from "../content/unit-types.ts";
import { nerveFromMorale } from "../content/kingdom/descent.ts";
import { AMBUSHED_NERVE, WALL_NERVE } from "../content/kingdom/invasions.ts";
import { World } from "../sim/world.ts";
import { PI, min } from "../sim/math.ts";
import { TILE_SIZE } from "../sim/terrain.ts";
import type { BattleSpec, FieldedSquad } from "../sim/layers.ts";

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
  /**
   * K5: an army that comes from the kingdom, not from a point-buy -- each
   * squad's fit men (`armies[p].squads[j]` is its kind) and each side's nerve
   * (kingdom morale as starting morale). Absent: every squad full, every man
   * fresh, as every battle before K5.
   */
  readonly field?: {
    readonly men: readonly [readonly number[], readonly number[]];
    readonly nerve: readonly [number, number];
  };
};

/**
 * K5: the battle a kingdom contact is fought as (PLAN.md §B.9). The spec says
 * everything; this only turns it into what the BattleLayer takes. The ground
 * is the holding's country (its level's size, zones and night) generated from
 * the holding's own seed; how it is won is the spec's (rout in the field, the
 * defender holding out behind walls); nothing marches on and no river rises
 * (docs/PROVISIONAL.md K5.9). Only the fit take the field.
 */
export function battleFromSpec(spec: BattleSpec): BattleConfig {
  const base = levelById(spec.terrain.level) ?? LEVELS[0];
  const level: LevelDef = {
    ...base,
    seed: spec.seed,
    duration: spec.duration,
    victory: spec.victory,
    controlPoints: [],
    reinforcements: undefined,
    floodAtSeconds: undefined,
    siege: undefined,
    night: spec.sightScale === 1 ? undefined : spec.sightScale,
  };
  const [a, b] = spec.sides;
  // The machine's side is commanded with its faction's battle habits; a side
  // with no commander of its own (the king's, when two machines meet headless) borrows the Badger's.
  const commander = COMMANDERS[b.commander ?? a.commander ?? "badger"];
  return {
    mode: "battle",
    level,
    armies: [
      { doctrine: a.doctrine, squads: a.squads.map((q) => q.unit) },
      { doctrine: b.doctrine, squads: b.squads.map((q) => q.unit) },
    ],
    commander,
    difficulty: b.difficulty,
    abilities: [a.abilities, b.abilities],
    field: {
      men: [a.squads.map((q) => q.men - q.wounded), b.squads.map((q) => q.men - q.wounded)],
      nerve: fieldNerve(spec),
    },
  };
}

/**
 * Each side's starting nerve: its kingdom morale, and (K8, PLAN §B.8) the
 * ground it chose. A defender behind walls starts steadier (WALL_NERVE); an
 * army that walked into a defender lying in wait or dug in starts shaken
 * (AMBUSHED_NERVE) -- the deployment advantage an ambush is.
 */
export function fieldNerve(spec: BattleSpec): [number, number] {
  const nerve: [number, number] = [nerveFromMorale(spec.sides[0].morale), nerveFromMorale(spec.sides[1].morale)];
  const d = 1 - spec.deployment.attacker;
  nerve[d] = min(1, nerve[d] + WALL_NERVE[spec.terrain.fortification]);
  if (spec.deployment.ambush) nerve[spec.deployment.attacker] *= AMBUSHED_NERVE;
  return nerve;
}

/**
 * Build the battle World a config describes and set its men down: the one
 * place this happens, for the BattleLayer and for the headless suites
 * (tools/kingdom-descent.ts fights a real battle with it). Returns where each
 * squad's men stand (FieldedSquad, per side in squad order), which is how a
 * kingdom battle's survivors are read back.
 *
 * Men are set down LOOSE -- no groups, by design: a group is something the
 * player draws with the pen, not something the game hands them.
 */
export function battleWorld(
  config: BattleConfig, opts: { aiPlayers?: readonly number[]; duration?: number } = {},
): { world: World; fielded: [FieldedSquad[], FieldedSquad[]] } {
  const level = config.level;
  const diff = DIFFICULTIES[config.difficulty];
  const lesson = config.mode === "lesson";
  const world = new World({
    seed: level.seed,
    tilesWide: level.tilesWide,
    tilesHigh: level.tilesHigh,
    // BS-05: the lesson has no clock and no enemy commander, so neither the
    // level's timer nor an attack can end it mid-step. The far side stands
    // where it was set out until the player goes to it.
    duration: opts.duration ?? (lesson ? LESSON_DURATION_SECONDS : level.duration),
    soldierCapacity: 4096,
    aiPlayers: opts.aiPlayers ?? (lesson ? [] : [1]),
    aiTuning: { think: diff.thinkInterval, commit: diff.commitTicks, focus: diff.focus },
    commander: config.commander,
    victory: level.victory,
    controlPoints: level.controlPoints,
    reinforcements: level.reinforcements,
    sightScale: level.night,
    floodAtSeconds: level.floodAtSeconds,
    siege: level.siege,
  });
  world.doctrine[0] = config.armies[0].doctrine;
  world.doctrine[1] = config.armies[1].doctrine;
  world.armAbilities(0, config.abilities[0]);
  world.armAbilities(1, config.abilities[1]);
  const fielded: [FieldedSquad[], FieldedSquad[]] = [[], []];
  for (const zone of level.deployment) {
    const list = config.armies[zone.player];
    const field = config.field;
    let n = 0;
    list.squads.forEach((type, j) => {
      const spec = UNIT_TYPES[type];
      const men = field ? field.men[zone.player][j] ?? 0 : spec.soldiers;
      const nerve = field ? field.nerve[zone.player] : 1;
      const first = world.soldiers.count;
      if (men <= 0) {
        // Nobody fit: the squad waits with the baggage, and takes no place in the line.
        fielded[zone.player][j] = { first, count: 0 };
        return;
      }
      const blockX = (zone.x + 3 + (n % 4) * 5) * TILE_SIZE;
      const blockY = (zone.y + 4 + ((n / 4) | 0) * 9) * TILE_SIZE;
      for (let i = 0; i < men; i++) {
        world.spawnSoldier(
          zone.player, type,
          blockX + (i % 5) * 14, blockY + ((i / 5) | 0) * 14,
          zone.player === 0 ? 0 : PI,
          nerve,
        );
      }
      fielded[zone.player][j] = { first, count: men };
      n++;
    });
  }
  // The board is set out but the battle has not begun -- except in the
  // lesson, which is about the pen, not about setting an army out.
  world.deploying = !lesson;
  return { world, fielded };
}

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
