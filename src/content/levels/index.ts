/**
 * The level roster.
 *
 * Each is a genuinely different problem rather than a reskin: the ground, the
 * clock, the budget and the win condition all change together, so the army you
 * would compose for one is the wrong army for another. Seeds were picked by
 * sampling the generator for terrain that actually suits the level's idea --
 * an "open ground" map with a third of it under trees would be a lie.
 */

import { provingGround, type LevelDef } from "./proving-ground.ts";
import { TILE_SIZE } from "../../sim/terrain.ts";

/** Control point at a tile position, for readability below. */
function cp(id: number, name: string, tx: number, ty: number, radius = 170): {
  id: number; name: string; x: number; y: number; radius: number;
} {
  return { id, name, x: tx * TILE_SIZE, y: ty * TILE_SIZE, radius };
}

/**
 * A narrow field where the river is the whole problem. Short clock, small
 * budget: there is no time to go the long way and no army spare to try.
 */
export const theCrossing: LevelDef = {
  id: "the-crossing",
  name: "The Crossing",
  brief: "A river with three bridges and no time to be clever. Take one and hold it.",
  seed: 0x6dc5d,
  tilesWide: 140,
  tilesHigh: 96,
  duration: 10 * 60,
  deployment: [
    { player: 0, x: 5, y: 26, w: 20, h: 44 },
    { player: 1, x: 115, y: 26, w: 20, h: 44 },
  ],
  victory: { mode: "rout" },
  controlPoints: [],
  budget: 71,
  enemyDoctrine: "defensive",
  suggestedDifficulty: "captain",
  magic: 1,
};

/**
 * Open ground, a long clock and a large budget: the map where cavalry and
 * manoeuvre actually pay, because there is nowhere to hide and room to swing.
 */
export const theOpenField: LevelDef = {
  id: "open-field",
  name: "The Open Field",
  brief: "Wide, flat and pitiless. Nothing to hide behind, and room for horse to run.",
  seed: 0x501b8,
  tilesWide: 224,
  tilesHigh: 150,
  duration: 18 * 60,
  deployment: [
    { player: 0, x: 8, y: 40, w: 30, h: 70 },
    { player: 1, x: 186, y: 40, w: 30, h: 70 },
  ],
  victory: { mode: "rout" },
  controlPoints: [],
  budget: 119,
  enemyDoctrine: "maneuver",
  suggestedDifficulty: "marshal",
  magic: 1,
};

/**
 * High ground, taken and held. Rout still ends it -- a broken army does not win
 * on flags -- but a careful player wins by standing in the right places rather
 * than by destroying anything.
 */
export const theHighGround: LevelDef = {
  id: "high-ground",
  name: "The High Ground",
  brief: "Three hills decide this. Hold two of them for four minutes and it is yours.",
  seed: 0x115e04,
  tilesWide: 224,
  tilesHigh: 150,
  duration: 15 * 60,
  deployment: [
    { player: 0, x: 8, y: 45, w: 26, h: 60 },
    { player: 1, x: 190, y: 45, w: 26, h: 60 },
  ],
  victory: { mode: "objectives", required: 2, holdToWin: 240 },
  controlPoints: [
    cp(0, "North Height", 112, 40),
    cp(1, "The Saddle", 112, 75),
    cp(2, "South Height", 112, 110),
  ],
  budget: 102,
  enemyDoctrine: "defensive",
  suggestedDifficulty: "captain",
  magic: 1,
};

/**
 * A running fight scored on both ground and blood, so neither pure aggression
 * nor pure occupation wins on its own.
 */
export const theLongVigil: LevelDef = {
  id: "long-vigil",
  name: "The Long Vigil",
  brief: "Wooded country. Points for ground held and for men killed. Both, or neither.",
  seed: 0x8b702,
  tilesWide: 224,
  tilesHigh: 150,
  duration: 20 * 60,
  deployment: [
    { player: 0, x: 8, y: 45, w: 28, h: 60 },
    { player: 1, x: 188, y: 45, w: 28, h: 60 },
  ],
  victory: { mode: "points", perKill: 1, perPointHeld: 1.4, target: 900 },
  controlPoints: [
    cp(0, "The Ford", 112, 58, 190),
    cp(1, "The Waystone", 112, 92, 190),
  ],
  budget: 111,
  enemyDoctrine: "aggressive",
  suggestedDifficulty: "marshal",
  magic: 1.35,
};

export const LEVELS: readonly LevelDef[] = [
  provingGround, theCrossing, theOpenField, theHighGround, theLongVigil,
];

export function levelById(id: string): LevelDef | undefined {
  return LEVELS.find((l) => l.id === id);
}

export type { LevelDef };
