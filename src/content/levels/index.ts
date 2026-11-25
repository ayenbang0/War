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
  budget: 107,
  enemyDoctrine: "defensive",
  suggestedDifficulty: "captain",
  country: "broken",
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
  budget: 179,
  enemyDoctrine: "maneuver",
  suggestedDifficulty: "marshal",
  country: "open",
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
  budget: 153,
  enemyDoctrine: "defensive",
  suggestedDifficulty: "captain",
  country: "high",
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
  budget: 167,
  enemyDoctrine: "aggressive",
  suggestedDifficulty: "marshal",
  country: "broken",
  magic: 1.35,
  // Twenty minutes on a points map is exactly where sitting still starts to
  // look clever, so both sides get fresh companies partway through. It punishes
  // turtling without taking the decision away: the ground you chose at minute
  // one is not the ground you are holding at minute twelve.
  reinforcements: [
    { atSeconds: 6 * 60, player: 0, type: "line", count: 20, x: 12 * TILE_SIZE, y: 70 * TILE_SIZE },
    { atSeconds: 6 * 60, player: 1, type: "line", count: 20, x: 210 * TILE_SIZE, y: 70 * TILE_SIZE },
    { atSeconds: 12 * 60, player: 0, type: "horse", count: 10, x: 12 * TILE_SIZE, y: 80 * TILE_SIZE },
    { atSeconds: 12 * 60, player: 1, type: "horse", count: 10, x: 210 * TILE_SIZE, y: 80 * TILE_SIZE },
  ],
};

/**
 * Getting through, not winning. The enemy holds the road to the ferry and only
 * has to keep it shut; you have to put forty living men on the far bank before
 * the clock runs out. Breaking them is one way to do that. It is not the only
 * one, and usually not the cheapest.
 */
export const theFerryRoad: LevelDef = {
  id: "ferry-road",
  name: "The Ferry Road",
  brief: "The town at Hallow Ferry is starving. Put forty men on the ferry landing before time, by any road.",
  seed: 0x18685,
  tilesWide: 200,
  tilesHigh: 112,
  duration: 14 * 60,
  deployment: [
    { player: 0, x: 6, y: 30, w: 24, h: 52 },
    { player: 1, x: 118, y: 24, w: 26, h: 64 },
  ],
  victory: { mode: "breakthrough", attacker: 0, exit: 0, required: 40 },
  controlPoints: [cp(0, "Hallow Ferry", 188, 56, 210)],
  budget: 131,
  enemyDoctrine: "veteran",
  suggestedDifficulty: "sergeant",
  country: "broken",
  magic: 1,
};

/**
 * Holding out. You are the garrison, you are outnumbered as the day goes on,
 * and nothing is required of you but still to be an army at the end of it.
 * Relief comes, late. The enemy is fed fresh companies in waves.
 */
export const theLastWall: LevelDef = {
  id: "last-wall",
  name: "The Last Wall",
  brief: "Hold the heights in front of the city until the relief arrives. They will keep coming. Do not break.",
  seed: 0x2ae16,
  tilesWide: 176,
  tilesHigh: 120,
  duration: 12 * 60,
  deployment: [
    { player: 0, x: 8, y: 32, w: 30, h: 56 },
    { player: 1, x: 140, y: 32, w: 28, h: 56 },
  ],
  victory: { mode: "survive", defender: 0 },
  controlPoints: [cp(0, "The Gatehouse", 30, 60, 200)],
  budget: 119,
  enemyDoctrine: "siegecraft",
  suggestedDifficulty: "colonel",
  country: "high",
  magic: 1,
  reinforcements: [
    { atSeconds: 3 * 60, player: 1, type: "pike", count: 22, x: 160 * TILE_SIZE, y: 50 * TILE_SIZE },
    { atSeconds: 5 * 60, player: 1, type: "lancer", count: 8, x: 160 * TILE_SIZE, y: 80 * TILE_SIZE },
    { atSeconds: 7 * 60, player: 1, type: "oathsworn", count: 16, x: 160 * TILE_SIZE, y: 60 * TILE_SIZE },
    // The relief. Late, and not enough on its own.
    { atSeconds: 9 * 60, player: 0, type: "horse", count: 10, x: 10 * TILE_SIZE, y: 60 * TILE_SIZE },
  ],
};

/**
 * Take the colours. Every army carries a standard; lose the men carrying it
 * and you have lost, whatever else is still on the field. A battle of thrusts
 * at one small knot of men, and of keeping your own out of reach.
 */
export const theColours: LevelDef = {
  id: "the-colours",
  name: "The Colours",
  brief: "Open downland, and an enemy sworn to take your standard. Take theirs first, and keep your own out of reach.",
  seed: 0x4fd38,
  tilesWide: 184,
  tilesHigh: 120,
  duration: 16 * 60,
  deployment: [
    { player: 0, x: 8, y: 34, w: 28, h: 52 },
    { player: 1, x: 148, y: 34, w: 28, h: 52 },
  ],
  victory: { mode: "standard" },
  controlPoints: [cp(0, "The Old Cairn", 92, 60, 180)],
  budget: 161,
  enemyDoctrine: "zealous",
  suggestedDifficulty: "captain",
  country: "open",
  magic: 1,
};

/**
 * Night among the standing stones. Everyone sees a little over half as far as
 * by day, so scouts are worth twice what they cost and a company can be on top
 * of you before you know it is there. The stones are what you are fighting over.
 */
export const theStones: LevelDef = {
  id: "night-stones",
  name: "Night at the Stones",
  brief: "Three standing stones in a dark wood. Hold two of them for three minutes. You will not see them coming.",
  seed: 0x5ae8f,
  tilesWide: 180,
  tilesHigh: 124,
  duration: 15 * 60,
  deployment: [
    { player: 0, x: 8, y: 36, w: 26, h: 52 },
    { player: 1, x: 146, y: 36, w: 26, h: 52 },
  ],
  victory: { mode: "objectives", required: 2, holdToWin: 180 },
  controlPoints: [
    cp(0, "The Watcher", 90, 30, 160),
    cp(1, "The Cradle", 90, 62, 160),
    cp(2, "The Broken Man", 90, 94, 160),
  ],
  budget: 145,
  enemyDoctrine: "magic",
  suggestedDifficulty: "captain",
  country: "broken",
  magic: 1.5,
  night: 0.55,
};

/**
 * The river is rising. At seven minutes every bridge goes under and the marsh
 * becomes open water, so whatever is on the wrong bank then stays there. The
 * enemy knows it and sends companies round both ends of your line just before.
 */
export const theRisingWater: LevelDef = {
  id: "rising-water",
  name: "The Rising Water",
  brief: "Rain in the hills. At seven minutes the river takes the bridges. Be on the right side of it when it does.",
  seed: 0x74c5a,
  tilesWide: 192,
  tilesHigh: 128,
  duration: 16 * 60,
  deployment: [
    { player: 0, x: 8, y: 36, w: 26, h: 56 },
    { player: 1, x: 158, y: 36, w: 26, h: 56 },
  ],
  victory: { mode: "rout" },
  controlPoints: [],
  budget: 149,
  enemyDoctrine: "raiding",
  suggestedDifficulty: "colonel",
  country: "broken",
  magic: 1,
  floodAtSeconds: 7 * 60,
  // The pincer: two fast companies arriving round both ends of the line.
  reinforcements: [
    { atSeconds: 5 * 60, player: 1, type: "hounds", count: 10, x: 60 * TILE_SIZE, y: 6 * TILE_SIZE },
    { atSeconds: 5 * 60, player: 1, type: "lancer", count: 8, x: 60 * TILE_SIZE, y: 122 * TILE_SIZE },
  ],
};

export const LEVELS: readonly LevelDef[] = [
  provingGround, theCrossing, theOpenField, theHighGround, theLongVigil,
  theFerryRoad, theLastWall, theColours, theStones, theRisingWater,
];

export function levelById(id: string): LevelDef | undefined {
  return LEVELS.find((l) => l.id === id);
}

export type { LevelDef };
