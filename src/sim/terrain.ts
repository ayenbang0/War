/**
 * Terrain grid and its deterministic generator.
 *
 * Terrain is static for Phase 0. Phase 4 adds vision blocking and elevation
 * effects on range; Phase 8 makes fortifications, forest and bridges
 * destructible, at which point mutations must invalidate cached path and
 * vision data -- the grid already carries a `revision` counter for that.
 */

import { floor, imul, clamp } from "./math.ts";

export const Terrain = {
  Plain: 0,
  Forest: 1,
  Hill: 2,
  Water: 3,
  Bridge: 4,
  Fortification: 5,
} as const;

export type TerrainType = (typeof Terrain)[keyof typeof Terrain];

export type TerrainInfo = {
  readonly name: string;
  /** Multiplier on movement speed. 0 means impassable. */
  readonly moveScale: number;
  /** Fraction of incoming ranged damage negated. */
  readonly cover: number;
  /** Blocks line of sight through the tile (Phase 4). */
  readonly blocksSight: boolean;
};

export const TERRAIN_INFO: Record<TerrainType, TerrainInfo> = {
  [Terrain.Plain]: { name: "plain", moveScale: 1.0, cover: 0.0, blocksSight: false },
  [Terrain.Forest]: { name: "forest", moveScale: 0.6, cover: 0.35, blocksSight: true },
  [Terrain.Hill]: { name: "hill", moveScale: 0.75, cover: 0.15, blocksSight: false },
  [Terrain.Water]: { name: "water", moveScale: 0.0, cover: 0.0, blocksSight: false },
  [Terrain.Bridge]: { name: "bridge", moveScale: 0.9, cover: 0.0, blocksSight: false },
  [Terrain.Fortification]: { name: "fortification", moveScale: 0.5, cover: 0.6, blocksSight: true },
};

/** World units per tile. One soldier occupies roughly a third of a tile. */
export const TILE_SIZE = 32;

// -- deterministic value noise -------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let h = (seed ^ imul(x | 0, 0x27d4eb2d) ^ imul(y | 0, 0x165667b1)) | 0;
  h = imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = floor(x);
  const yi = floor(y);
  const tx = smoothstep(x - xi);
  const ty = smoothstep(y - yi);
  const n00 = hash2(xi, yi, seed);
  const n10 = hash2(xi + 1, yi, seed);
  const n01 = hash2(xi, yi + 1, seed);
  const n11 = hash2(xi + 1, yi + 1, seed);
  const a = n00 + (n10 - n00) * tx;
  const b = n01 + (n11 - n01) * tx;
  return a + (b - a) * ty;
}

function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, (seed + i * 0x9e3779b9) | 0) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// -- grid ----------------------------------------------------------------------

export class TerrainGrid {
  readonly width: number;
  readonly height: number;
  readonly type: Uint8Array;
  /** 0..255, drives sight, ranged reach and movement bonuses. */
  readonly elevation: Uint8Array;
  /**
   * Structural integrity, 0..255. Only meaningful on destructible tiles;
   * everything else simply stays at full and is never touched.
   */
  readonly integrity: Uint8Array;
  /** Bumped on any mutation so caches (paths, vision, render chunks) can invalidate. */
  revision = 0;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.type = new Uint8Array(width * height);
    this.elevation = new Uint8Array(width * height);
    this.integrity = new Uint8Array(width * height).fill(255);
  }

  get worldWidth(): number {
    return this.width * TILE_SIZE;
  }

  get worldHeight(): number {
    return this.height * TILE_SIZE;
  }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.width && ty < this.height;
  }

  typeAt(tx: number, ty: number): TerrainType {
    if (!this.inBounds(tx, ty)) return Terrain.Water;
    return this.type[ty * this.width + tx] as TerrainType;
  }

  elevationAt(tx: number, ty: number): number {
    if (!this.inBounds(tx, ty)) return 0;
    return this.elevation[ty * this.width + tx];
  }

  /** Terrain under a world-space point. */
  typeAtWorld(x: number, y: number): TerrainType {
    return this.typeAt(floor(x / TILE_SIZE), floor(y / TILE_SIZE));
  }

  infoAtWorld(x: number, y: number): TerrainInfo {
    return TERRAIN_INFO[this.typeAtWorld(x, y)];
  }

  passableAt(tx: number, ty: number): boolean {
    return TERRAIN_INFO[this.typeAt(tx, ty)].moveScale > 0;
  }

  set(tx: number, ty: number, t: TerrainType): void {
    if (!this.inBounds(tx, ty)) return;
    this.type[ty * this.width + tx] = t;
    this.integrity[ty * this.width + tx] = 255;
    this.revision++;
  }

  /**
   * Wear a tile down. Returns true if it collapsed into something else.
   *
   * What a ruined tile becomes matters as much as that it can be ruined: a
   * broken bridge is water again and cuts the map in half, a burnt wood stops
   * blocking sight, a breached wall is open ground. Each is a route or a
   * sightline that did not exist a moment ago, which is the whole point.
   */
  damage(tx: number, ty: number, amount: number): boolean {
    if (!this.inBounds(tx, ty)) return false;
    const i = ty * this.width + tx;
    const t = this.type[i] as TerrainType;
    // `=== undefined`, not a truthiness test: forest and fortifications both
    // collapse into Terrain.Plain, which is 0, so `!DESTRUCTIBLE[t]` quietly
    // declared them indestructible. Only bridges worked, because Water is 3.
    const ruined = DESTRUCTIBLE[t];
    if (ruined === undefined) return false;

    const left = this.integrity[i] - amount;
    if (left > 0) {
      this.integrity[i] = left;
      return false;
    }
    this.type[i] = ruined;
    this.integrity[i] = 255;
    // Bumping the revision is what invalidates cached render chunks AND tells
    // squads their route may no longer exist.
    this.revision++;
    return true;
  }

  /** True where a tile can be worn down at all. */
  destructibleAt(tx: number, ty: number): boolean {
    return DESTRUCTIBLE[this.typeAt(tx, ty)] !== undefined;
  }
}

/** What each destructible terrain becomes when it fails. */
const DESTRUCTIBLE: Partial<Record<TerrainType, TerrainType>> = {
  [Terrain.Fortification]: Terrain.Plain,
  [Terrain.Bridge]: Terrain.Water,
  [Terrain.Forest]: Terrain.Plain,
};

/**
 * Generate a battlefield: a river splitting the map with bridge crossings,
 * wooded pockets, and high ground. Deliberately symmetric in character (not
 * mirrored exactly) so neither side starts with an obvious terrain advantage.
 */
export function generateTerrain(width: number, height: number, seed: number): TerrainGrid {
  const grid = new TerrainGrid(width, height);
  const elevSeed = seed | 0;
  const moistSeed = (seed ^ 0x5bf03635) | 0;
  const riverSeed = (seed ^ 0x1b873593) | 0;

  const invW = 1 / width;
  const invH = 1 / height;

  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const nx = tx * invW * 8;
      const ny = ty * invH * 8;

      const elev = fbm(nx, ny, elevSeed, 5);
      const moist = fbm(nx + 31.7, ny + 17.3, moistSeed, 4);

      // River meanders vertically down the middle of the map.
      const meander = (fbm(0.0, ty * invH * 6, riverSeed, 3) - 0.5) * 0.42;
      const centre = 0.5 + meander;
      const riverDist = (tx * invW - centre) * (tx * invW - centre);
      const riverHalfWidth = 0.00035;

      let t: TerrainType;
      if (riverDist < riverHalfWidth) {
        t = Terrain.Water;
      } else if (elev > 0.62) {
        t = Terrain.Hill;
      } else if (moist > 0.58 && elev > 0.36) {
        t = Terrain.Forest;
      } else {
        t = Terrain.Plain;
      }

      const i = ty * width + tx;
      grid.type[i] = t;
      grid.elevation[i] = (clamp(elev, 0, 1) * 255) | 0;
    }
  }

  carveBridges(grid);
  grid.revision++;
  return grid;
}

/**
 * Lay bridges across the river at evenly spaced rows. Bridges are the map's
 * chokepoints, so their placement is fixed rather than random -- a bridgeless
 * or bridge-clustered map would make half the battlefield unreachable.
 */
function carveBridges(grid: TerrainGrid): void {
  const crossings = 3;
  for (let k = 1; k <= crossings; k++) {
    const ty = ((grid.height * k) / (crossings + 1)) | 0;
    for (let band = -1; band <= 1; band++) {
      const row = ty + band;
      if (row < 0 || row >= grid.height) continue;
      for (let tx = 0; tx < grid.width; tx++) {
        if (grid.type[row * grid.width + tx] === Terrain.Water) {
          grid.type[row * grid.width + tx] = Terrain.Bridge;
        }
      }
    }
  }
}
