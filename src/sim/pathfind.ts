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
  return search(grid, fromX, fromY, toX, toY, false, false).route;
}

/** A route, and whether it actually gets where it was asked to go. */
export type RouteResult = { route: number[]; reached: boolean };

/**
 * Route as far toward a point as the ground allows.
 *
 * The same search as findPath, but when the goal cannot be reached at all --
 * the far side of an unbroken wall, a garrison inside its circuit -- it walks
 * to the reachable tile closest to the goal instead of refusing. That is what
 * an assault looks like: ordered into a town, a company marches up to the wall
 * and waits there, and the world knows the route fell short (`reached` false)
 * so it can try again the moment a breach opens.
 *
 * Kept apart from findPath so the stable path golden, which pins findPath,
 * cannot move because of it.
 */
export function findPathPartial(
  grid: TerrainGrid,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): RouteResult {
  return search(grid, fromX, fromY, toX, toY, true, false);
}

/**
 * Route as findPathPartial does, but walkable to the letter from the exact
 * start point.
 *
 * The ordinary route is string-pulled from the CENTRE of the start tile and
 * checked at half-tile samples (clearLine). A mover, though, tests every point
 * it steps to, so a leg that grazes the corner of a cliff or a wall between
 * two samples -- or one that only the tile centre could see past -- stops it
 * dead. This variant pulls from the real start and keeps a waypoint only when
 * every tile the straight line crosses is open (strictLine), so nothing it
 * returns can block. The world asks for it only when a mover has actually
 * been blocked, which keeps every route that already walked exactly as it was.
 */
export function findPathStrict(
  grid: TerrainGrid,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): RouteResult {
  return search(grid, fromX, fromY, toX, toY, true, true);
}

function search(
  grid: TerrainGrid,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  partial: boolean,
  strict = false,
): RouteResult {
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
    if (near < 0) return { route: [], reached: false };
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
    if (near < 0) return { route: [], reached: false };
    ssx = near % grid.width;
    ssy = (near / grid.width) | 0;
    escape = [(ssx + 0.5) * TILE_SIZE, (ssy + 0.5) * TILE_SIZE];
  }

  const start = ssy * grid.width + ssx;
  const goal = gy * grid.width + gx;
  if (start === goal) {
    return { route: escape ? escape.concat([goalX, goalY]) : [goalX, goalY], reached: true };
  }

  const s = scratchFor(grid);
  s.epoch++;
  s.heapSize = 0;

  s.stamp[start] = s.epoch;
  s.gScore[start] = 0;
  s.fScore[start] = heuristic(ssx, ssy, gx, gy);
  s.cameFrom[start] = -1;
  s.state[start] = 1;
  heapPush(s, start);

  // The closest tile to the goal the search has settled, for a partial route.
  // Closest by the heuristic, ties to the lower index, like everything else.
  let best = start;
  let bestH = s.fScore[start];

  let expansions = 0;
  while (s.heapSize > 0) {
    const current = heapPop(s);
    if (current === goal) {
      const route = reconstruct(grid, s, goal, goalX, goalY, strict && !escape ? [fromX, fromY] : null);
      return { route: escape ? escape.concat(route) : route, reached: true };
    }
    if (s.state[current] === 2) continue;
    s.state[current] = 2;
    if (++expansions > MAX_EXPANSIONS) break;

    const cx = current % grid.width;
    const cy = (current / grid.width) | 0;
    if (partial) {
      const h = heuristic(cx, cy, gx, gy);
      if (h < bestH || (h === bestH && current < best)) {
        bestH = h;
        best = current;
      }
    }

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
  if (!partial || best === start) return { route: [], reached: false };
  const bx = ((best % grid.width) + 0.5) * TILE_SIZE;
  const by = (((best / grid.width) | 0) + 0.5) * TILE_SIZE;
  const route = reconstruct(grid, s, best, bx, by, strict && !escape ? [fromX, fromY] : null);
  return { route: escape ? escape.concat(route) : route, reached: false };
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
  /** For a strict route: the exact start point to pull from. */
  from: readonly number[] | null = null,
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
  if (from === null) return stringPull(grid, pts);
  pts[0] = from[0];
  pts[1] = from[1];
  return strictPull(grid, pts);
}

/**
 * String-pull with strictLine: drop a waypoint only when the kept one before
 * it has a strictly open line past it. Consecutive tile centres of an A* path
 * are always strictly open (diagonals never squeeze past a blocked tile), so
 * the result always walks -- unless the exact start sits so near a blocked
 * corner that even its first tile centre is cut off, in which case the start
 * tile's centre is kept as the first waypoint.
 */
function strictPull(grid: TerrainGrid, pts: number[]): number[] {
  const out: number[] = [];
  let anchorX = pts[0];
  let anchorY = pts[1];
  for (let i = 2; i < pts.length - 2; i += 2) {
    if (!strictLine(grid, anchorX, anchorY, pts[i + 2], pts[i + 3])) {
      out.push(pts[i], pts[i + 1]);
      anchorX = pts[i];
      anchorY = pts[i + 1];
    }
  }
  out.push(pts[pts.length - 2], pts[pts.length - 1]);
  if (out.length >= 2 && !strictLine(grid, pts[0], pts[1], out[0], out[1])) {
    const tx = floor(pts[0] / TILE_SIZE);
    const ty = floor(pts[1] / TILE_SIZE);
    out.unshift((tx + 0.5) * TILE_SIZE, (ty + 0.5) * TILE_SIZE);
  }
  return out;
}

/**
 * True when EVERY tile the exact segment crosses is passable: a grid walk
 * (Amanatides-Woo), not samples, so no corner can slip between two checks.
 * Passing exactly through a grid corner counts as a diagonal step and needs
 * both side tiles open, the same rule A* keeps.
 */
export function strictLine(
  grid: TerrainGrid,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  let tx = floor(ax / TILE_SIZE);
  let ty = floor(ay / TILE_SIZE);
  if (!grid.passableAt(tx, ty)) return false;
  const dx = bx - ax;
  const dy = by - ay;
  const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  let tMaxX = sx > 0 ? ((tx + 1) * TILE_SIZE - ax) / dx : sx < 0 ? (tx * TILE_SIZE - ax) / dx : Infinity;
  let tMaxY = sy > 0 ? ((ty + 1) * TILE_SIZE - ay) / dy : sy < 0 ? (ty * TILE_SIZE - ay) / dy : Infinity;
  const tDeltaX = sx !== 0 ? TILE_SIZE / abs(dx) : Infinity;
  const tDeltaY = sy !== 0 ? TILE_SIZE / abs(dy) : Infinity;
  while (min(tMaxX, tMaxY) <= 1) {
    if (tMaxX < tMaxY) {
      tx += sx;
      tMaxX += tDeltaX;
    } else if (tMaxY < tMaxX) {
      ty += sy;
      tMaxY += tDeltaY;
    } else {
      if (!grid.passableAt(tx + sx, ty) || !grid.passableAt(tx, ty + sy)) return false;
      tx += sx;
      ty += sy;
      tMaxX += tDeltaX;
      tMaxY += tDeltaY;
    }
    if (!grid.passableAt(tx, ty)) return false;
  }
  return true;
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

/**
 * Round the corners off a route.
 *
 * A* on a grid, even after string pulling, gives a chain of straight segments
 * meeting at hard angles, and a formation walking one pivots on the spot at
 * every joint -- it reads as a machine following waypoints rather than a body
 * of troops crossing ground. The spec asks for drawn paths to be smoothed into
 * a clean curve (section 4.2), and this is where that happens.
 *
 * Chaikin corner cutting: each interior corner is replaced by two points a
 * quarter and three quarters along its neighbouring segments. Pure arithmetic,
 * so it stays deterministic, and endpoints never move -- the player asked to
 * end up somewhere specific.
 *
 * A corner is only cut when BOTH replacement segments are walkable. Rounding a
 * corner that hugs a riverbank would otherwise cut it straight through the
 * water, and the mover would stop dead at the bank having been sent into it.
 */
export function smoothRoute(grid: TerrainGrid, pts: readonly number[], passes = 2): number[] {
  if (pts.length < 6) return pts.slice();
  let cur = pts.slice();

  for (let pass = 0; pass < passes; pass++) {
    const out: number[] = [cur[0], cur[1]];
    for (let i = 2; i + 3 < cur.length; i += 2) {
      const px = cur[i - 2];
      const py = cur[i - 1];
      const cx = cur[i];
      const cy = cur[i + 1];
      const nx = cur[i + 2];
      const ny = cur[i + 3];

      const ax = cx + (px - cx) * 0.25;
      const ay = cy + (py - cy) * 0.25;
      const bx = cx + (nx - cx) * 0.25;
      const by = cy + (ny - cy) * 0.25;

      if (clearLine(grid, ax, ay, bx, by) && clearLine(grid, px, py, ax, ay)) {
        out.push(ax, ay, bx, by);
      } else {
        // Keep the hard corner. Better an ugly turn than a route through a river.
        out.push(cx, cy);
      }
    }
    out.push(cur[cur.length - 2], cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}
