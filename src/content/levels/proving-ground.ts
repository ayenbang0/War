/**
 * Levels are data, never code paths. Phase 9 turns this shape into a full
 * config (objectives, AI doctrine, magic intensity, point budget); for now it
 * carries what Phase 0 needs plus the deployment zones Phase 6 will place into.
 */

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
};

export const provingGround: LevelDef = {
  id: "proving-ground",
  name: "Proving Ground",
  seed: 0x5eed1234,
  tilesWide: 192,
  tilesHigh: 128,
  duration: 15 * 60,
  deployment: [
    { player: 0, x: 6, y: 34, w: 26, h: 60 },
    { player: 1, x: 160, y: 34, w: 26, h: 60 },
  ],
};
