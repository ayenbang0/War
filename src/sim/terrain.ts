/**
 * Terrain grid and its deterministic generator.
 *
 * Phase 4 adds vision blocking and elevation effects on range. Phase 8 makes
 * the ground destructible: fortifications (fieldworks, stone walls, gates,
 * palisades) carry hit points and fall to rubble, woods burn or are felled to
 * a clearing, bridges are broken into the river. Every change of a tile's type
 * goes through one function, `mutate`, which bumps `revision`, stamps the
 * tile's own revision (so the renderer re-bakes only the chunks that changed)
 * and logs the tile for the world to settle at the next tick boundary: evict
 * anyone standing on ground that just became impassable, re-plan the routes it
 * cut or opened, and re-sweep sight if it changed what blocks a line of sight.
 */

import { floor, imul, clamp, min } from "./math.ts";

export const Terrain = {
  Plain: 0,
  Forest: 1,
  Hill: 2,
  Water: 3,
  Bridge: 4,
  Fortification: 5,
  /** Impassable rock. Walls off whole regions and creates the passes between. */
  Mountain: 6,
  /** Wadeable but wretched: slow, exposed, and no cover at all. */
  Marsh: 7,
  /** Beaten track. The one terrain that is FASTER than open ground. */
  Road: 8,
  /** Loose scree on a mountain's skirts: slow, broken, a little cover. */
  Scree: 9,
  // -- Phase 8, appended: the numbers are stored in Uint8Arrays and hashed.
  /** A stone curtain wall. Impassable until it is battered down. */
  Wall: 10,
  /** A gate in a wall: timber and iron, the weak point of any circuit. */
  Gate: 11,
  /** A timber stockade. Cheaper than stone, weaker, and it burns. */
  Palisade: 12,
  /** What a fallen wall, gate, palisade or fieldwork leaves: broken, passable. */
  Rubble: 13,
  /** A wood that has been burnt out or felled: stumps and ash, open to sight. */
  Clearing: 14,
  /**
   * K10: a gate standing open. The same timber and iron as a shut gate, with
   * the same wear on it, but a way through for anyone -- which is why only
   * the side holding the walls may swing it, and why it is shut again the
   * moment the gateway is clear (World `gates` order, docs/PROVISIONAL.md K10.1).
   */
  GateOpen: 15,
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
  /**
   * A parapet: blocks sight like any wall, EXCEPT for men standing right
   * against it, who see (and are seen) over the top. That is what manning a
   * wall means, and without it a garrison behind stone is blind and its bows
   * are useless. See vision.ts `PARAPET_REACH`.
   */
  readonly parapet?: boolean;
};

export const TERRAIN_INFO: Record<TerrainType, TerrainInfo> = {
  [Terrain.Plain]: { name: "plain", moveScale: 1.0, cover: 0.0, blocksSight: false },
  [Terrain.Forest]: { name: "forest", moveScale: 0.6, cover: 0.35, blocksSight: true },
  [Terrain.Hill]: { name: "hill", moveScale: 0.75, cover: 0.15, blocksSight: false },
  [Terrain.Water]: { name: "water", moveScale: 0.0, cover: 0.0, blocksSight: false },
  [Terrain.Bridge]: { name: "bridge", moveScale: 0.9, cover: 0.0, blocksSight: false },
  [Terrain.Fortification]: { name: "fortification", moveScale: 0.5, cover: 0.6, blocksSight: true },
  // Mountains are the only other impassable terrain, and they matter for a
  // different reason than the river: a river is crossed at bridges, a mountain
  // is not crossed at all. The gaps between ranges become passes, and a pass is
  // the most valuable ground on any map that has one.
  [Terrain.Mountain]: { name: "mountain", moveScale: 0.0, cover: 0.0, blocksSight: true },
  // Marsh is a trap rather than an obstacle: you can cross it, and you will
  // regret having done so under fire, because it is slow AND offers nothing.
  [Terrain.Marsh]: { name: "marsh", moveScale: 0.45, cover: 0.0, blocksSight: false },
  // The only terrain faster than open ground, which makes roads worth fighting
  // over rather than merely worth walking on.
  [Terrain.Road]: { name: "road", moveScale: 1.3, cover: 0.0, blocksSight: false },
  [Terrain.Scree]: { name: "scree", moveScale: 0.55, cover: 0.2, blocksSight: false },
  // The works of a siege. All three are impassable while they stand -- that is
  // the difference between a wall and a fieldwork you can scramble over -- and
  // their cover is what a missile loses crossing them into the men behind.
  [Terrain.Wall]: { name: "wall", moveScale: 0.0, cover: 0.6, blocksSight: true, parapet: true },
  [Terrain.Gate]: { name: "gate", moveScale: 0.0, cover: 0.5, blocksSight: true, parapet: true },
  [Terrain.Palisade]: { name: "palisade", moveScale: 0.0, cover: 0.45, blocksSight: true, parapet: true },
  // A breach is a way in, not a road: slow going over broken stone, and some
  // cover left in the heaps -- but far less than the wall it was.
  [Terrain.Rubble]: { name: "rubble", moveScale: 0.6, cover: 0.25, blocksSight: false },
  [Terrain.Clearing]: { name: "clearing", moveScale: 0.95, cover: 0.05, blocksSight: false },
  // An open gateway: a paved arch with the leaves folded back. Passable and
  // open to sight (a gateway is a hole in the wall), with a little cover in
  // the arch itself.
  [Terrain.GateOpen]: { name: "open gate", moveScale: 0.9, cover: 0.15, blocksSight: false },
};

/**
 * What wears down, how much it takes, and what it becomes.
 *
 * `hp` is in the same units as `damage()` amounts. A full battery of four
 * engines takes a stone wall section in about half a minute; a gate falls in
 * well under half that, which is why the engines prefer it. `fuel` is how long
 * a burning tile burns, in ticks, before it is gone; only timber burns.
 *
 * What a ruined tile becomes matters as much as that it can be ruined: a
 * broken bridge is water again and cuts the map in half, a burnt wood stops
 * blocking sight, a breached wall is a way in. Each is a route or a sightline
 * that did not exist a moment ago, which is the whole point.
 */
export type Structure = {
  readonly hp: number;
  readonly ruin: TerrainType;
  /** Burn time in ticks, if this burns at all. */
  readonly fuel?: number;
  /** What it becomes when it burns out, if not `ruin`. */
  readonly ash?: TerrainType;
};

export const STRUCTURE: Partial<Record<TerrainType, Structure>> = {
  [Terrain.Fortification]: { hp: 255, ruin: Terrain.Rubble },
  [Terrain.Bridge]: { hp: 255, ruin: Terrain.Water, fuel: 14 * 20 },
  [Terrain.Forest]: { hp: 255, ruin: Terrain.Clearing, fuel: 30 * 20 },
  [Terrain.Wall]: { hp: 2400, ruin: Terrain.Rubble },
  [Terrain.Gate]: { hp: 900, ruin: Terrain.Rubble, fuel: 24 * 20 },
  [Terrain.Palisade]: { hp: 700, ruin: Terrain.Rubble, fuel: 18 * 20 },
  // The same leaves, swung back: as strong, and as quick to burn.
  [Terrain.GateOpen]: { hp: 900, ruin: Terrain.Rubble, fuel: 24 * 20 },
};

/** Walls, gates and palisades: the works a siege is fought over. */
export function isCurtain(t: TerrainType): boolean {
  return t === Terrain.Wall || t === Terrain.Gate || t === Terrain.Palisade || t === Terrain.GateOpen;
}

/** A gate, shut or open (K10). Engines go for these first. */
export function isGate(t: TerrainType): boolean {
  return t === Terrain.Gate || t === Terrain.GateOpen;
}

/** Anything that counts as a work to be battered: curtains and fieldworks. */
export function isWork(t: TerrainType): boolean {
  return isCurtain(t) || t === Terrain.Fortification;
}

/** World units per tile. One soldier occupies roughly a third of a tile. */
export const TILE_SIZE = 32;

// -- deterministic value noise -------------------------------------------------

/**
 * A deterministic roll in [0, 1) for a tile at a moment, from integer hashing
 * alone. Fire uses it rather than an rng stream: a roll that is a pure
 * function of (tile, step, seed) cannot be shifted by the order tiles are
 * visited in, and it draws nothing from any stream another subsystem reads.
 */
export function tileRoll(tile: number, step: number, seed: number): number {
  return hash2(tile, step, seed ^ 0x6a09e667);
}

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
   * Damage each tile has taken since it last changed type. Zero everywhere at
   * generation, so nothing needs initialising and a tile that changes type
   * starts whole. A tile falls when its wear reaches STRUCTURE[type].hp.
   */
  readonly wear: Float64Array;
  /** Ticks of burning left on each tile; 0 = not alight. */
  readonly burn: Uint16Array;
  /**
   * Which side a work belongs to, -1 for nobody: the defender's walls in a
   * siege, the side that dug a fieldwork. Engines never batter their own.
   */
  readonly owner: Int8Array;
  /**
   * The revision at which each tile last changed type. Derived bookkeeping for
   * the renderer, which re-bakes only the chunks holding a tile newer than the
   * chunk; never hashed, because nothing in the sim reads it back.
   */
  readonly tileRevision: Uint32Array;
  /** Tiles alight, ascending by index. Fire is stepped in this order. */
  readonly burning: number[] = [];
  /** Tiles with wear on them, for drawing cracks. Unordered; render only. */
  readonly worn: number[] = [];
  /** Bumped on any mutation so caches (paths, vision, render chunks) can invalidate. */
  revision = 0;
  /** Revision of the last change that made impassable ground passable (a breach). */
  openedAt = 0;
  /** Revision of the last change that made passable ground impassable. */
  closedAt = 0;
  /** Revision of the last change to what blocks a line of sight. */
  sightAt = 0;
  /**
   * True once anything has worn, burnt, been owned or changed type after
   * generation. The world hash covers the destructible state only from then
   * on, so a battle in which nothing is ever touched hashes exactly as it did
   * before destructible terrain existed.
   */
  dynamic = false;
  /** Tiles whose type changed since the world last settled them, in order. */
  private changes: number[] = [];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.type = new Uint8Array(width * height);
    this.elevation = new Uint8Array(width * height);
    this.wear = new Float64Array(width * height);
    this.burn = new Uint16Array(width * height);
    this.owner = new Int8Array(width * height).fill(-1);
    this.tileRevision = new Uint32Array(width * height);
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

  /**
   * THE one way a tile changes type after generation.
   *
   * Everything a change invalidates is decided here and only here: the
   * revision moves (render chunks, perception, routes), the tile is stamped
   * for a per-chunk re-bake, and the kind of change is recorded -- opened,
   * closed, sight -- so the world re-plans only the routes that could be
   * affected and re-sweeps sight only when something that blocks it moved.
   */
  private mutate(i: number, t: TerrainType, keep = false): void {
    const was = TERRAIN_INFO[this.type[i] as TerrainType];
    const now = TERRAIN_INFO[t];
    this.type[i] = t;
    // A gate that swings keeps its wear and its fire: opening and shutting it
    // must never mend it, or swinging a battered gate would be a free repair.
    if (!keep) {
      this.wear[i] = 0;
      this.burn[i] = 0;
    }
    if (!isWork(t)) this.owner[i] = -1;
    this.revision++;
    this.tileRevision[i] = this.revision;
    if (was.moveScale <= 0 && now.moveScale > 0) this.openedAt = this.revision;
    if (was.moveScale > 0 && now.moveScale <= 0) this.closedAt = this.revision;
    if (was.blocksSight !== now.blocksSight || was.parapet !== now.parapet) this.sightAt = this.revision;
    this.dynamic = true;
    this.changes.push(i);
  }

  /** Hand over the tiles changed since the last call, oldest first. */
  drainChanges(): number[] {
    const out = this.changes;
    this.changes = [];
    return out;
  }

  set(tx: number, ty: number, t: TerrainType): void {
    if (!this.inBounds(tx, ty)) return;
    this.mutate(ty * this.width + tx, t);
  }

  /**
   * Wear a tile down. Returns true if it collapsed into something else.
   *
   * See STRUCTURE for what each work takes and becomes.
   */
  damage(tx: number, ty: number, amount: number): boolean {
    if (!this.inBounds(tx, ty) || amount <= 0) return false;
    const i = ty * this.width + tx;
    const st = STRUCTURE[this.type[i] as TerrainType];
    if (st === undefined) return false;
    if (this.wear[i] === 0) this.worn.push(i);
    this.wear[i] += amount;
    this.dynamic = true;
    if (this.wear[i] < st.hp) return false;
    this.collapse(i, st.ruin);
    return true;
  }

  /** A tile falls: drop it from the worn list and turn it into its ruin. */
  private collapse(i: number, ruin: TerrainType): void {
    const at = this.worn.indexOf(i);
    if (at >= 0) this.worn.splice(at, 1);
    this.mutate(i, ruin);
  }

  /** How much of a destructible tile is left, 0..1 (1 for anything else). */
  integrityAt(tx: number, ty: number): number {
    if (!this.inBounds(tx, ty)) return 1;
    const i = ty * this.width + tx;
    const st = STRUCTURE[this.type[i] as TerrainType];
    if (st === undefined) return 1;
    return clamp(1 - this.wear[i] / st.hp, 0, 1);
  }

  /**
   * Raise a fieldwork on a tile (spec 6.2, "terrain manipulation: small
   * barriers, temporary cover").
   *
   * Only open ground can be dug: you cannot fortify a river, a wood or a
   * mountainside, and letting sappers wall off water would let them bridge it.
   * Bumps the revision like any other terrain change, which is what re-bakes
   * the render chunks and tells every company its route may have changed.
   */
  fortify(tx: number, ty: number, player = -1): boolean {
    if (!this.fortifiableAt(tx, ty)) return false;
    const i = ty * this.width + tx;
    this.mutate(i, Terrain.Fortification);
    this.owner[i] = player;
    return true;
  }

  /** True where a fieldwork could be raised. */
  fortifiableAt(tx: number, ty: number): boolean {
    const t = this.typeAt(tx, ty);
    return t === Terrain.Plain || t === Terrain.Road || t === Terrain.Scree ||
      t === Terrain.Rubble || t === Terrain.Clearing;
  }

  /**
   * Build a curtain (wall, gate or palisade) for a side. Setup only: this is
   * how a siege battlefield is laid out before anyone stands on it, never
   * something done under men's feet. Water and mountain are left alone -- a
   * river or a cliff is already a wall.
   */
  raise(tx: number, ty: number, t: TerrainType, player: number): boolean {
    if (!this.inBounds(tx, ty) || !isCurtain(t)) return false;
    const i = ty * this.width + tx;
    const cur = this.type[i] as TerrainType;
    if (cur === Terrain.Water || cur === Terrain.Mountain) return false;
    this.mutate(i, t);
    this.owner[i] = player;
    return true;
  }

  /**
   * K10: swing a gate open or shut. Only a gate tile swings, and only to the
   * other gate state; wear and fire stay as they were. Goes through `mutate`
   * like every other change, so opening one is an opening (routes re-plan
   * into it) and shutting one is a closure (anyone in it is settled out, and
   * the routes it cuts re-plan). Returns false if the tile is not a gate.
   */
  swingGate(tx: number, ty: number, open: boolean): boolean {
    if (!this.inBounds(tx, ty)) return false;
    const i = ty * this.width + tx;
    const cur = this.type[i] as TerrainType;
    const want = open ? Terrain.GateOpen : Terrain.Gate;
    if (!isGate(cur) || cur === want) return false;
    const owner = this.owner[i];
    this.mutate(i, want, true);
    this.owner[i] = owner;
    return true;
  }

  /** True where a tile can be worn down at all. */
  destructibleAt(tx: number, ty: number): boolean {
    return STRUCTURE[this.typeAt(tx, ty)] !== undefined;
  }

  /** Whose work this is, or -1. */
  ownerAt(tx: number, ty: number): number {
    if (!this.inBounds(tx, ty)) return -1;
    return this.owner[ty * this.width + tx];
  }

  flammableAt(tx: number, ty: number): boolean {
    return STRUCTURE[this.typeAt(tx, ty)]?.fuel !== undefined;
  }

  burningAt(tx: number, ty: number): boolean {
    return this.inBounds(tx, ty) && this.burn[ty * this.width + tx] > 0;
  }

  /** Set a tile alight. False if it does not burn or is already burning. */
  ignite(tx: number, ty: number): boolean {
    if (!this.inBounds(tx, ty)) return false;
    const i = ty * this.width + tx;
    const fuel = STRUCTURE[this.type[i] as TerrainType]?.fuel;
    if (fuel === undefined || this.burn[i] > 0) return false;
    this.burn[i] = fuel;
    this.dynamic = true;
    // Kept sorted so fire is always stepped in tile order, whoever lit what.
    let at = this.burning.length;
    while (at > 0 && this.burning[at - 1] > i) at--;
    this.burning.splice(at, 0, i);
    return true;
  }

  /**
   * Burn a tile for `ticks`. Returns true if it burnt out (and fell). Only
   * fire.ts calls this; it keeps `burning` in step itself.
   */
  burnDown(i: number, ticks: number): boolean {
    const left = this.burn[i] - ticks;
    if (left > 0) {
      this.burn[i] = left;
      return false;
    }
    this.burn[i] = 0;
    const st = STRUCTURE[this.type[i] as TerrainType];
    if (st !== undefined) this.collapse(i, st.ash ?? st.ruin);
    return true;
  }
}

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
      } else if (elev > 0.78) {
        // The tops of the highest ground are bare rock, and impassable. This is
        // what creates passes: the gaps a range leaves are the only way through,
        // and they are worth more than anything around them.
        t = Terrain.Mountain;
      } else if (elev > 0.68) {
        // Scree skirts the peaks, so a range has broken ground around it rather
        // than a hard edge you can stand next to safely.
        t = Terrain.Scree;
      } else if (elev > 0.62) {
        t = Terrain.Hill;
      } else if (elev < 0.34 && moist > 0.55) {
        // Marsh collects where the ground is low AND wet -- beside the river,
        // in hollows -- so it lies exactly where an army would rather march.
        t = Terrain.Marsh;
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
  carveRoad(grid, riverSeed);
  openPasses(grid);
  grid.revision++;
  return grid;
}

/**
 * Lay a road across the map, through the middle crossing.
 *
 * Roads are the only terrain faster than open ground, so a road is the fastest
 * way across a map and therefore something worth taking and denying. It is
 * routed through a bridge on purpose: the crossing and the highway being the
 * same place is what makes that ground decisive rather than merely useful.
 */
function carveRoad(grid: TerrainGrid, seed: number): void {
  const ty0 = (grid.height / 2) | 0;
  for (let tx = 0; tx < grid.width; tx++) {
    // A gentle wander, so it is a road and not a ruler.
    const drift = (fbm(tx / grid.width * 5, 3.3, seed, 3) - 0.5) * grid.height * 0.16;
    const ty = clamp((ty0 + drift) | 0, 1, grid.height - 2);
    for (let band = 0; band <= 1; band++) {
      const row = ty + band;
      const i = row * grid.width + tx;
      const cur = grid.type[i] as TerrainType;
      // A road bridges water and tunnels nothing: it goes over crossings and
      // around mountains, and it drains the marsh it runs through.
      if (cur === Terrain.Water) continue;
      if (cur === Terrain.Mountain) continue;
      grid.type[i] = Terrain.Road;
    }
  }
}

/**
 * Guarantee a way through every mountain range.
 *
 * Generated mountains can seal a map in half, which would make a level
 * unplayable rather than interesting. Each range is opened at its lowest point,
 * so the pass sits where a pass naturally would -- at the saddle.
 */
function openPasses(grid: TerrainGrid): void {
  const strideY = 24;
  for (let ty = 0; ty < grid.height; ty += strideY) {
    for (let tx = 0; tx < grid.width; tx++) {
      // Walk each column band; where it is solid rock across, cut the saddle.
      let solid = true;
      let lowest = 255;
      let lowestY = ty;
      for (let y = ty; y < min(ty + strideY, grid.height); y++) {
        const t = grid.type[y * grid.width + tx] as TerrainType;
        if (t !== Terrain.Mountain) {
          solid = false;
          break;
        }
        const e = grid.elevation[y * grid.width + tx];
        if (e < lowest) {
          lowest = e;
          lowestY = y;
        }
      }
      if (!solid) continue;
      for (let d = -1; d <= 1; d++) {
        const y = lowestY + d;
        if (y < 0 || y >= grid.height) continue;
        grid.type[y * grid.width + tx] = Terrain.Scree;
      }
    }
  }
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
