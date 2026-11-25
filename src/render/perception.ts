/**
 * What the viewer can actually see: ONE answer for everything the renderer
 * draws over the map (audit RF-03, RF-04, RF-05).
 *
 * Before this, each overlay asked its own question. Counters asked the sim's
 * per-soldier line-of-sight bit; effects and bodies asked whether the fog
 * DISC was lit; works, workings and fields asked nothing at all. The fog disc
 * is stamped without line of sight ("Discs, not raycasts", vision.ts), so the
 * ground behind a wood read as lit while the men standing on it were rightly
 * not drawn -- and a blow struck there still drew its sparks and its body,
 * which gave the hidden company away. An enemy sapper's digging showed through
 * fog nobody was looking at.
 *
 * Now there are three questions and every draw uses one of them:
 *
 *  - soldier(id): the sim's own per-soldier sight bit, the exact answer the AI
 *    gets too. Your own men always count.
 *  - event(e): a blow is seen if either man in it is.
 *  - ground(x, y): the honest version of "is this cell lit" -- lit by the fog
 *    disc AND in line of sight of one of the viewer's men within his sight, or
 *    under the viewer's own flare. This is what a work, a field, a working or
 *    a flash on open ground is drawn by, and what the fog shading is drawn by.
 *
 * Render-only. The fog grid is shading and is never hashed, and nothing here
 * writes the world, so none of this can move a golden or desync a peer.
 */

import type { CombatEvent, World } from "../sim/world.ts";
import { FOG_CELL, effectiveSight, hasLineOfSight } from "../sim/vision.ts";
import { TERRAIN_INFO, TILE_SIZE } from "../sim/terrain.ts";

/** Fog shading states, as drawn. */
export const SEEN_NEVER = 0;
export const SEEN_NOW = 1;
export const SEEN_BEFORE = 2;
/** Lit by the fog disc but not actually in anyone's line of sight. */
export const SEEN_OBSCURED = 3;

/** Real milliseconds between rebuilds of the ground grid while the clock stands. */
const REFRESH_MS = 300;

/** Is soldier `id` visible to `viewer`? Own men always; else the sim's sight bit. */
export function soldierSeen(world: World, viewer: number, id: number): boolean {
  if (id < 0) return false;
  const s = world.soldiers;
  if (s.player[id] === viewer) return true;
  // The bit, not world.canSee(): a man killed this tick is already marked dead
  // but still carries the sight mask of the sweep that saw him fall, which is
  // exactly the question a body or a kill mark needs answered.
  return (s.seen[id] & (viewer === 0 ? 1 : 2)) !== 0;
}

export class Perception {
  readonly viewer: number;
  /** One byte per fog cell: 1 where the viewer's men truly see the cell. */
  private observed: Uint8Array = new Uint8Array(0);
  private cols = 0;
  private rows = 0;
  private builtTick = -1;
  private builtAt = -Infinity;
  private builtRevision = -1;
  /**
   * Prefix sums of sight-blocking tiles, so "is there any wood or wall in this
   * box" is four reads. Most of a battlefield is open, and a disc with nothing
   * in it that could block a ray needs no rays at all.
   */
  private blockSum: Int32Array = new Int32Array(0);
  private tilesW = 0;
  private tilesH = 0;

  constructor(viewer: number) {
    this.viewer = viewer;
  }

  /**
   * Bring the ground grid up to date. Cheap to call every frame: it rebuilds
   * only when the sim has ticked (sight is swept on ticks), or every few
   * hundred ms while deploying, when the ground is re-lit without ticking.
   */
  refresh(world: World, nowMs: number): void {
    const fog = world.fog[this.viewer];
    const stale = world.tick !== this.builtTick ||
      (world.deploying && nowMs - this.builtAt > REFRESH_MS) ||
      world.terrain.revision !== this.builtRevision ||
      this.cols !== fog.cols;
    if (!stale) return;
    this.builtTick = world.tick;
    this.builtAt = nowMs;
    this.build(world);
  }

  soldier(world: World, id: number): boolean {
    return soldierSeen(world, this.viewer, id);
  }

  /** Who in a blow the viewer can see. */
  event(world: World, e: CombatEvent): { attacker: boolean; victim: boolean } {
    return { attacker: soldierSeen(world, this.viewer, e.attacker), victim: soldierSeen(world, this.viewer, e.victim) };
  }

  /** Is the ground at a world point truly in view? */
  ground(x: number, y: number): boolean {
    const gx = Math.floor(x / FOG_CELL);
    const gy = Math.floor(y / FOG_CELL);
    if (gx < 0 || gy < 0 || gx >= this.cols || gy >= this.rows) return false;
    return this.observed[gy * this.cols + gx] === 1;
  }

  /** Is any part of a disc in view? Centre and four points on its inner ring. */
  disc(x: number, y: number, r: number): boolean {
    if (this.ground(x, y)) return true;
    const k = r * 0.7;
    return this.ground(x + k, y) || this.ground(x - k, y) || this.ground(x, y + k) || this.ground(x, y - k);
  }

  /** Shading state for the fog layer. */
  shade(world: World, x: number, y: number): number {
    const state = world.fog[this.viewer].at(x, y);
    if (state !== SEEN_NOW) return state;
    return this.ground(x, y) ? SEEN_NOW : SEEN_OBSCURED;
  }

  // -- building -----------------------------------------------------------------

  private build(world: World): void {
    const fog = world.fog[this.viewer];
    const grid = world.terrain;
    if (this.cols !== fog.cols || this.rows !== fog.rows) {
      this.cols = fog.cols;
      this.rows = fog.rows;
      this.observed = new Uint8Array(fog.cols * fog.rows);
    } else {
      this.observed.fill(0);
    }
    if (grid.revision !== this.builtRevision || this.blockSum.length === 0) {
      this.builtRevision = grid.revision;
      this.buildBlockSums(world);
    }

    // The viewer's own flares light ground whatever stands in the way: the sim
    // spots anything standing in one regardless of cover (World.flaredFor).
    for (const f of world.fields) {
      if (f.ability !== "flare" || f.player !== this.viewer) continue;
      this.forDisc(f.x, f.y, f.radius, (i) => {
        if (fog.cell[i] === SEEN_NOW) this.observed[i] = 1;
      });
    }

    // One pair of eyes per fog cell is plenty -- the one that sees furthest --
    // and keeps the work proportional to the ground covered, not to the men.
    const s = world.soldiers;
    const eyeSight = new Map<number, number>();
    const eyeX = new Map<number, number>();
    const eyeY = new Map<number, number>();
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] !== 1 || s.player[i] !== this.viewer) continue;
      const sight = effectiveSight(grid, world.stats(i).sight * world.sightScale, s.x[i], s.y[i]);
      const cell = Math.floor(s.y[i] / FOG_CELL) * this.cols + Math.floor(s.x[i] / FOG_CELL);
      if ((eyeSight.get(cell) ?? -1) >= sight) continue;
      eyeSight.set(cell, sight);
      eyeX.set(cell, s.x[i]);
      eyeY.set(cell, s.y[i]);
    }

    for (const [cell, sight] of eyeSight) {
      const ex = eyeX.get(cell) as number;
      const ey = eyeY.get(cell) as number;
      // Nothing in this disc can block a ray: every lit cell in it is seen.
      const clear = !this.anyBlocking(ex - sight, ey - sight, ex + sight, ey + sight);
      this.forDisc(ex, ey, sight, (i, cx, cy) => {
        if (this.observed[i] === 1 || fog.cell[i] !== SEEN_NOW) return;
        if (clear || hasLineOfSight(grid, ex, ey, cx, cy)) this.observed[i] = 1;
      });
    }
  }

  /** Visit every fog cell whose centre lies inside a disc. */
  private forDisc(x: number, y: number, radius: number, visit: (i: number, cx: number, cy: number) => void): void {
    const r = radius / FOG_CELL;
    const cx = x / FOG_CELL;
    const cy = y / FOG_CELL;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.cols - 1, Math.floor(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.rows - 1, Math.floor(cy + r));
    const rr = r * r;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const dx = gx + 0.5 - cx;
        const dy = gy + 0.5 - cy;
        if (dx * dx + dy * dy > rr) continue;
        visit(gy * this.cols + gx, (gx + 0.5) * FOG_CELL, (gy + 0.5) * FOG_CELL);
      }
    }
  }

  private buildBlockSums(world: World): void {
    const g = world.terrain;
    const w = g.width + 1;
    const sum = new Int32Array(w * (g.height + 1));
    for (let ty = 0; ty < g.height; ty++) {
      let row = 0;
      for (let tx = 0; tx < g.width; tx++) {
        if (TERRAIN_INFO[g.typeAt(tx, ty)].blocksSight) row++;
        sum[(ty + 1) * w + tx + 1] = sum[ty * w + tx + 1] + row;
      }
    }
    this.blockSum = sum;
    this.tilesW = g.width;
    this.tilesH = g.height;
  }

  /** Any sight-blocking tile inside a world-space box? */
  private anyBlocking(x0: number, y0: number, x1: number, y1: number): boolean {
    const tx0 = Math.max(0, Math.floor(x0 / TILE_SIZE));
    const ty0 = Math.max(0, Math.floor(y0 / TILE_SIZE));
    const tx1 = Math.min(this.tilesW - 1, Math.floor(x1 / TILE_SIZE));
    const ty1 = Math.min(this.tilesH - 1, Math.floor(y1 / TILE_SIZE));
    if (tx1 < tx0 || ty1 < ty0) return false;
    const W = this.tilesW + 1;
    const s = this.blockSum;
    const n = s[(ty1 + 1) * W + tx1 + 1] - s[ty0 * W + tx1 + 1] - s[(ty1 + 1) * W + tx0] + s[ty0 * W + tx0];
    return n > 0;
  }
}
