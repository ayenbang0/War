/**
 * Where a company actually IS, as the viewer can see it.
 *
 * The sim's group anchor is a virtual point that walks the route AHEAD of the
 * men and keeps walking while they fight, so anything drawn at the anchor --
 * dust, gallop streaks, rings, halos -- runs on ahead of the company and goes
 * on running after the horsemen under it have stopped or died. That was the
 * "shadow that keeps galloping after the horses are dead" glitch.
 *
 * Presence is computed from the living men instead: their centre, how far they
 * spread, and how fast that centre is really moving between the last two
 * snapshots. For an enemy only the men this viewer can currently see count, so
 * an overlay never gives away a company the fog is hiding.
 *
 * Render-only: reads the world, never writes it.
 */

import type { World } from "../sim/world.ts";
import type { Group } from "../sim/entities.ts";

export type Presence = {
  /** Visible living men. 0 means draw nothing for this company. */
  n: number;
  x: number;
  y: number;
  /** Mean distance of those men from their centre, in world units. */
  spread: number;
  /** Centre's movement since the previous snapshot, world units per tick. */
  vx: number;
  vy: number;
};

export type Prev = { x: Float64Array; y: Float64Array };

const NONE: Presence = { n: 0, x: 0, y: 0, spread: 0, vx: 0, vy: 0 };

/** A man moves this far in one tick only by teleport (blink) or by spawning. */
export const JUMP = 48;

export function presenceOf(world: World, g: Group, viewer: number, prev?: Prev): Presence {
  const s = world.soldiers;
  const own = g.player === viewer;
  const bit = viewer === 0 ? 1 : 2;
  let n = 0;
  let cx = 0;
  let cy = 0;
  let mx = 0;
  let my = 0;
  let moving = 0;
  for (const id of g.members) {
    if (s.alive[id] !== 1) continue;
    if (!own && (s.seen[id] & bit) === 0) continue;
    n++;
    cx += s.x[id];
    cy += s.y[id];
    if (prev) {
      const dx = s.x[id] - prev.x[id];
      const dy = s.y[id] - prev.y[id];
      // A man who has just appeared or blinked has no honest previous point.
      if (Math.abs(dx) + Math.abs(dy) < JUMP) {
        mx += dx;
        my += dy;
        moving++;
      }
    }
  }
  if (n === 0) return NONE;
  cx /= n;
  cy /= n;
  let spread = 0;
  for (const id of g.members) {
    if (s.alive[id] !== 1) continue;
    if (!own && (s.seen[id] & bit) === 0) continue;
    spread += Math.hypot(s.x[id] - cx, s.y[id] - cy);
  }
  spread /= n;
  return {
    n, x: cx, y: cy, spread,
    vx: moving > 0 ? mx / moving : 0,
    vy: moving > 0 ? my / moving : 0,
  };
}

/** Is this company really on the move, not merely ordered to be? */
export function isMoving(p: Presence, minPerTick = 0.35): boolean {
  return p.n > 0 && p.vx * p.vx + p.vy * p.vy > minPerTick * minPerTick;
}
