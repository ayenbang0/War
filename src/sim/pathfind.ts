/**
 * Layer 1 of movement: the squad's coarse route across the map.
 *
 * A* over the terrain grid weighted by movement cost, followed by string
 * pulling to collapse the tile-by-tile result into the handful of waypoints a
 * formation actually needs. Soldiers never see this path -- they follow their
 * slot, and the slot follows the squad anchor along the route. Keeping the
 * three layers separate is what stops formation movement turning to mush.
 *
 * DETERMINISM: a binary heap's sift order is an implementation detail, and two
 * nodes with equal f would otherwise pop in whatever order the heap happened to
 * arrange them. Every comparison here therefore breaks ties on tile index, and
 * neighbours are always enumerated in the same fixed order. Without both, two
 * peers running identical lockstep input could route a squad differently.
 */

import { abs, floor, min, sqrt } from "./math.ts";
import { TERRAIN_INFO, TILE_SIZE, type TerrainGrid } from "./terrain.ts";

const SQRT2 = 1.4142135623730951;

/** Give up rather than freeze the tick on a hopeless request. */
const MAX_EXPANSIONS = 24000;

/** Fixed neighbour order: 4 orthogonals first, then 4 diagonals. */
const NEIGHBOURS = [1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1];

/**
 * Scratch state, sized to the grid and reused across calls. Pathfinding runs
 * many times per second once squads are manoeuvring; reallocating arrays of
 * 24k entries per call would dominate the tick.
 */
class PathScratch {
  readonly gScore: Float64Array;
  readonly fScore: Float64Array;
  readonly cameFrom: Int32Array;
  readonly state: Uint8Array; // 0 unseen, 1 open, 2 closed
  readonly heap: Int32Array;
  heapSize = 0;
  /** Bumped per search so the arrays never need clearing. */
  readonly stamp: Int32Array;
  epoch = 0;

  constructor(size: number) {
    this.gScore = new Float64Array(size);
    this.fScore = new Float64Array(size);
    this.cameFrom = new Int32Array(size);
    this.state = new Uint8Array(size);
    this.heap = new Int32Array(size);
    this.stamp = new Int32Array(size);
  }
}

const scratchByGrid = new WeakMap<TerrainGrid, PathScratch>();

function scratchFor(grid: TerrainGrid): PathScratch {
  let s = scratchByGrid.get(grid);
  if (!s) {
    s = new PathScratch(grid.width * grid.height);
    scratchByGrid.set(grid, s);
  }
  return s;
}

function tileCost(grid: TerrainGrid, tx: number, ty: number): number {
  const scale = TERRAIN_INFO[grid.typeAt(tx, ty)].moveScale;
  return scale <= 0 ? 0 : 1 / scale;
}

/** Octile distance: exact for 8-way movement, so A* stays admissible. */
function heuristic(ax: number, ay: number, bx: number, by: number): number {
  const dx = abs(ax - bx);
  const dy = abs(ay - by);
  return dx + dy + (SQRT2 - 2) * min(dx, dy);
}

function less(s: PathScratch, a: number, b: number): boolean {
  const fa = s.fScore[a];
  const fb = s.fScore[b];
  if (fa !== fb) return fa < fb;
  return a < b; // deterministic tie-break; never rely on heap arrangement
}

function heapPush(s: PathScratch, node: number): void {
  let i = s.heapSize++;
  s.heap[i] = node;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!less(s, s.heap[i], s.heap[parent])) break;
    const t = s.heap[i];
    s.heap[i] = s.heap[parent];
    s.heap[parent] = t;
    i = parent;
  }
}

function heapPop(s: PathScratch): number {
  const top = s.heap[0];
  s.heapSize--;
  if (s.heapSize > 0) {
    s.heap[0] = s.heap[s.heapSize];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let best = i;
      if (l < s.heapSize && less(s, s.heap[l], s.heap[best])) best = l;
      if (r < s.heapSize && less(s, s.heap[r], s.heap[best])) best = r;
      if (best === i) break;
      const t = s.heap[i];
      s.heap[i] = s.heap[best];
      s.heap[best] = t;
      i = best;
    }
  }
  return top;
}

/**
 * Route from world point to world point. Returns a flat [x0, y0, x1, y1, ...]
 * array of world-space waypoints, or an empty array when no route exists.
 */
export function findPath(
  grid: TerrainGrid,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): number[] {
  const sx = clampTile(floor(fromX / TILE_SIZE), grid.width);
  const sy = clampTile(floor(fromY / TILE_SIZE), grid.height);
  let gx = clampTile(floor(toX / TILE_SIZE), grid.width);
  let gy = clampTile(floor(toY / TILE_SIZE), grid.height);
  let goalX = toX;
  let goalY = toY;

  // Ordering an advance into a river is a normal thing for a player to draw.
  // Route to the closest reachable tile instead of refusing outright.
  if (!grid.passableAt(gx, gy)) {
    const near = nearestPassable(grid, gx, gy);
    if (near < 0) return [];
    gx = near % grid.width;
    gy = (near / grid.width) | 0;
    goalX = (gx + 0.5) * TILE_SIZE;
    goalY = (gy + 0.5) * TILE_SIZE;
  }
  // A start on impassable ground is not a refusal to move -- it is a unit that
  // needs to get out. Route from the nearest solid tile and let it wade there.
  let escape: number[] | null = null;
  let ssx = sx;
  let ssy = sy;
  if (!grid.passableAt(sx, sy)) {
    const near = nearestPassable(grid, sx, sy);
    if (near < 0) return [];
    ssx = near % grid.width;
    ssy = (near / grid.width) | 0;
    escape = [(ssx + 0.5) * TILE_SIZE, (ssy + 0.5) * TILE_SIZE];
  }

  const start = ssy * grid.width + ssx;
  const goal = gy * grid.width + gx;
  if (start === goal) return escape ? escape.concat([goalX, goalY]) : [goalX, goalY];

  const s = scratchFor(grid);
  s.epoch++;
  s.heapSize = 0;

  s.stamp[start] = s.epoch;
  s.gScore[start] = 0;
  s.fScore[start] = heuristic(ssx, ssy, gx, gy);
  s.cameFrom[start] = -1;
  s.state[start] = 1;
  heapPush(s, start);

  let expansions = 0;
  while (s.heapSize > 0) {
    const current = heapPop(s);
    if (current === goal) {
      const route = reconstruct(grid, s, goal, goalX, goalY);
      return escape ? escape.concat(route) : route;
    }
    if (s.state[current] === 2) continue;
    s.state[current] = 2;
    if (++expansions > MAX_EXPANSIONS) return [];

    const cx = current % grid.width;
    const cy = (current / grid.width) | 0;

    for (let k = 0; k < NEIGHBOURS.length; k += 2) {
      const stepX = NEIGHBOURS[k];
      const stepY = NEIGHBOURS[k + 1];
      const nx = cx + stepX;
      const ny = cy + stepY;
      if (!grid.inBounds(nx, ny)) continue;

      const cost = tileCost(grid, nx, ny);
      if (cost <= 0) continue;

      const diagonal = stepX !== 0 && stepY !== 0;
      // Refuse to squeeze between two blocked tiles: a formation cannot cut a
      // corner through a cliff even when the diagonal tile itself is open.
      if (diagonal && (!grid.passableAt(cx + stepX, cy) || !grid.passableAt(cx, cy + stepY))) {
        continue;
      }

      const neighbour = ny * grid.width + nx;
      if (s.stamp[neighbour] !== s.epoch) {
        s.stamp[neighbour] = s.epoch;
        s.gScore[neighbour] = Infinity;
        s.state[neighbour] = 0;
        s.cameFrom[neighbour] = -1;
      }
      if (s.state[neighbour] === 2) continue;

      const tentative = s.gScore[current] + (diagonal ? SQRT2 : 1) * cost;
      if (tentative < s.gScore[neighbour]) {
        s.cameFrom[neighbour] = current;
        s.gScore[neighbour] = tentative;
        s.fScore[neighbour] = tentative + heuristic(nx, ny, gx, gy);
        s.state[neighbour] = 1;
        heapPush(s, neighbour);
      }
    }
  }
  return [];
}

function clampTile(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

/** Ring search outward for the closest passable tile to a blocked goal. */
function nearestPassable(grid: TerrainGrid, gx: number, gy: number): number {
  for (let r = 1; r < 40; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // Only the ring edge; the interior was covered by a smaller r.
        if (abs(dx) !== r && abs(dy) !== r) continue;
        const nx = gx + dx;
        const ny = gy + dy;
        if (grid.inBounds(nx, ny) && grid.passableAt(nx, ny)) return ny * grid.width + nx;
      }
    }
  }
  return -1;
}

function reconstruct(
  grid: TerrainGrid,
  s: PathScratch,
  goal: number,
  toX: number,
  toY: number,
): number[] {
  const tiles: number[] = [];
  let node = goal;
  while (node !== -1) {
    tiles.push(node);
    node = s.cameFrom[node];
  }
  tiles.reverse();

  // Tile centres, then string-pull. A raw grid path staircases badly, and a
  // formation walking a staircase looks drunk and re-forms constantly.
  const pts: number[] = [];
  for (const t of tiles) {
    pts.push(((t % grid.width) + 0.5) * TILE_SIZE, (((t / grid.width) | 0) + 0.5) * TILE_SIZE);
  }
  pts[pts.length - 2] = toX;
  pts[pts.length - 1] = toY;
  return stringPull(grid, pts);
}

/** Drop any waypoint the previous kept waypoint can already see past. */
function stringPull(grid: TerrainGrid, pts: number[]): number[] {
  if (pts.length <= 4) return pts.slice(2);
  const out: number[] = [];
  let anchorX = pts[0];
  let anchorY = pts[1];
  for (let i = 2; i < pts.length - 2; i += 2) {
    if (!clearLine(grid, anchorX, anchorY, pts[i + 2], pts[i + 3])) {
      out.push(pts[i], pts[i + 1]);
      anchorX = pts[i];
      anchorY = pts[i + 1];
    }
  }
  out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}

/** True when every tile the segment touches is passable. */
export function clearLine(
  grid: TerrainGrid,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const d = sqrt(dx * dx + dy * dy);
  // Half-tile sampling: the same bound that stops movers stepping over a
  // one-tile barrier.
  const steps = floor(d / (TILE_SIZE * 0.5)) + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (TERRAIN_INFO[grid.typeAtWorld(ax + dx * t, ay + dy * t)].moveScale <= 0) return false;
  }
  return true;
}
