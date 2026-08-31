/**
 * Sight and fog of war.
 *
 * Both sides run through this identically (spec section 9.2): the AI gets no
 * privileged view, and its ignorance is the same ignorance the player has. That
 * only holds if there is exactly one implementation, which is why this lives in
 * sim/ rather than in the renderer.
 *
 * Two different questions are answered here, and they deliberately use
 * different methods:
 *
 *   - CAN I SEE THAT SQUAD? Exact, per pair, with a line-of-sight raycast.
 *     Roughly 15x15 pairs is nothing, and this decides targeting and AI, so it
 *     has to be right.
 *   - WHAT IS LIT ON THE MAP? Approximate, stamped as discs into a coarse grid.
 *     Raycasting every cell against every squad would be tens of thousands of
 *     casts per tick to decide the shading of a picture.
 */

import { floor, max, min, sqrt } from "./math.ts";
import { TERRAIN_INFO, TILE_SIZE, type TerrainGrid } from "./terrain.ts";

/** Fog cells are this many tiles across. Coarse on purpose -- it is shading. */
export const FOG_TILES = 2;
/** World units per fog cell. */
export const FOG_CELL = TILE_SIZE * FOG_TILES;

/** Sight multiplier at the top of the elevation range, and at the bottom. */
const HIGH_GROUND_BONUS = 0.45;
/** How much of its sight a unit loses standing inside cover. */
const COVER_SIGHT_PENALTY = 0.4;
/** A unit inside cover is harder to make out, in world units of lost range. */
const CONCEALMENT = 0.55;

/**
 * Effective sight for a unit standing at a point: high ground sees further,
 * and standing inside a wood costs you as much as it hides you.
 */
export function effectiveSight(grid: TerrainGrid, base: number, x: number, y: number): number {
  const tx = floor(x / TILE_SIZE);
  const ty = floor(y / TILE_SIZE);
  const elev = grid.elevationAt(tx, ty) / 255;
  const info = TERRAIN_INFO[grid.typeAt(tx, ty)];
  const height = 1 + (elev - 0.5) * 2 * HIGH_GROUND_BONUS;
  const thicket = 1 - info.cover * COVER_SIGHT_PENALTY;
  return base * max(0.25, height * thicket);
}

/** How well hidden a unit is where it stands, as a fraction of range denied. */
export function concealment(grid: TerrainGrid, x: number, y: number): number {
  return TERRAIN_INFO[grid.typeAtWorld(x, y)].cover * CONCEALMENT;
}

/**
 * Is the line between two points clear enough to see along?
 *
 * Blocked by anything TERRAIN_INFO marks as sight-blocking -- woods and
 * fortifications. Sampled at half-tile steps, the same bound that stops a mover
 * stepping over a one-tile obstacle; anything coarser lets a squad see through
 * the corner of a wood.
 */
export function hasLineOfSight(
  grid: TerrainGrid,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const dist = sqrt(dx * dx + dy * dy);
  const steps = floor(dist / (TILE_SIZE * 0.5)) + 1;
  // Ignore cover within half a tile of either end. Standing IN a wood must not
  // blind you to the man beside you, nor hide him from you -- and on a short
  // ray every sample is near an endpoint, so without this a squad inside a
  // wood cannot see its own flank.
  const skip = TILE_SIZE * 0.5;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const along = t * dist;
    if (along < skip || dist - along < skip) continue;
    if (TERRAIN_INFO[grid.typeAtWorld(ax + dx * t, ay + dy * t)].blocksSight) return false;
  }
  return true;
}

/** Elevation advantage of an attacker over a target, as a range multiplier. */
export function rangeFromHeight(grid: TerrainGrid, ax: number, ay: number, tx: number, ty: number): number {
  const a = grid.elevationAt(floor(ax / TILE_SIZE), floor(ay / TILE_SIZE)) / 255;
  const t = grid.elevationAt(floor(tx / TILE_SIZE), floor(ty / TILE_SIZE)) / 255;
  // Shooting downhill reaches further; uphill falls short.
  return min(1.35, max(0.75, 1 + (a - t) * 0.7));
}

/**
 * A coarse lit/unlit grid for one army, for drawing fog.
 *
 * Discs, not raycasts. This is the shading of a picture, and casting a ray from
 * every cell to every squad would be tens of thousands of casts a tick to
 * decide it. Unit visibility, which actually matters, is exact elsewhere.
 */
export class FogField {
  readonly cols: number;
  readonly rows: number;
  /** 0 unseen, 1 currently lit, 2 seen before but not now. */
  readonly cell: Uint8Array;

  constructor(grid: TerrainGrid) {
    this.cols = floor(grid.worldWidth / FOG_CELL) + 1;
    this.rows = floor(grid.worldHeight / FOG_CELL) + 1;
    this.cell = new Uint8Array(this.cols * this.rows);
  }

  /** Demote everything currently lit to "remembered", then re-stamp. */
  beginUpdate(): void {
    const c = this.cell;
    for (let i = 0; i < c.length; i++) if (c[i] === 1) c[i] = 2;
  }

  stamp(x: number, y: number, radius: number): void {
    const r = radius / FOG_CELL;
    const cx = x / FOG_CELL;
    const cy = y / FOG_CELL;
    const x0 = max(0, floor(cx - r));
    const x1 = min(this.cols - 1, floor(cx + r));
    const y0 = max(0, floor(cy - r));
    const y1 = min(this.rows - 1, floor(cy + r));
    const rr = r * r;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const dx = gx + 0.5 - cx;
        const dy = gy + 0.5 - cy;
        if (dx * dx + dy * dy <= rr) this.cell[gy * this.cols + gx] = 1;
      }
    }
  }

  at(x: number, y: number): number {
    const gx = floor(x / FOG_CELL);
    const gy = floor(y / FOG_CELL);
    if (gx < 0 || gy < 0 || gx >= this.cols || gy >= this.rows) return 0;
    return this.cell[gy * this.cols + gx];
  }
}
