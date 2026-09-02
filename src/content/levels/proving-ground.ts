/**
 * Levels are data, never code paths.
 *
 * A level names the ground, the clock, the budget, how the match is won and how
 * the machine opens. Adding one is adding a row -- nothing here branches, and
 * nothing in sim/ knows which level it is running.
 */

import type { ControlPoint, VictoryConfig } from "../../sim/victory.ts";
import type { UnitTypeId } from "../unit-types.ts";
import type { DoctrineId } from "../doctrines.ts";
import type { DifficultyId } from "../difficulty.ts";

export type DeploymentZone = {
  readonly player: number;
  /** Tile-space rectangle. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

export type LevelDef = {
  readonly id: string;
  readonly name: string;
  readonly seed: number;
  readonly tilesWide: number;
  readonly tilesHigh: number;
  /** Match length in seconds. */
  readonly duration: number;
  readonly deployment: readonly DeploymentZone[];
  /** One line on the ground and what the fight over it is like. */
  readonly brief: string;
  /** How this match is won. */
  readonly victory: VictoryConfig;
  /** Ground worth standing on. Empty for a straight battle. */
  readonly controlPoints: readonly ControlPoint[];
  /** Points each side may spend composing an army. */
  readonly budget: number;
  /** Companies marching on partway through, if this battlefield has any. */
  readonly reinforcements?: readonly {
    atSeconds: number; player: number; type: UnitTypeId; count: number; x: number; y: number;
  }[];
  /** What the machine fields and how hard it opens. */
  readonly enemyDoctrine: DoctrineId;
  readonly suggestedDifficulty: DifficultyId;
  /** Multiplier on spell strength, for levels that want more or less magic. */
  readonly magic: number;
};

export const provingGround: LevelDef = {
  id: "proving-ground",
  name: "Proving Ground",
  brief: "A wide valley split by a river. Room to manoeuvre and time to think.",
  seed: 0x5eed1234,
  tilesWide: 192,
  tilesHigh: 128,
  duration: 15 * 60,
  deployment: [
    { player: 0, x: 6, y: 34, w: 26, h: 60 },
    { player: 1, x: 160, y: 34, w: 26, h: 60 },
  ],
  victory: { mode: "rout" },
  controlPoints: [],
  budget: 141,
  enemyDoctrine: "aggressive",
  suggestedDifficulty: "captain",
  magic: 1,
};
