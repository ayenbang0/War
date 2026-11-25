/**
 * The road graph: routing and travel.
 *
 * The kingdom-scale counterpart of sim/pathfind.ts and sim/movement.ts. The
 * graph is small (tens of nodes), so the router is a plain Dijkstra with a
 * linear scan for the next node -- no heap, nothing clever, and every choice
 * it makes is pinned by an explicit tie-break so it cannot depend on the order
 * the roads happen to be listed in.
 *
 * Travel is continuous along an edge: a mover is `along` miles down a road, not
 * snapped to its ends, so a march can be redirected, halted or (K5) intercepted
 * anywhere between two towns.
 */

import { sqrt } from "../math.ts";
import type { Holding, Mover, Road } from "./state.ts";

/** Adjacency, built once per world. Neighbours are in ascending holding id. */
export type RoadGraph = {
  /** By holding id: [neighbour id, road id] pairs, neighbour-ascending. */
  readonly links: ReadonlyMap<number, readonly (readonly [number, number])[]>;
  readonly roads: ReadonlyMap<number, Road>;
  readonly holdings: ReadonlyMap<number, Holding>;
  /** Holding ids in ascending order: the canonical node sequence. */
  readonly nodes: readonly number[];
};

export function buildGraph(holdings: readonly Holding[], roads: readonly Road[]): RoadGraph {
  const links = new Map<number, [number, number][]>();
  const holdingById = new Map<number, Holding>();
  for (const h of holdings) {
    links.set(h.id, []);
    holdingById.set(h.id, h);
  }
  const roadById = new Map<number, Road>();
  for (const r of roads) {
    roadById.set(r.id, r);
    links.get(r.a)?.push([r.b, r.id]);
    links.get(r.b)?.push([r.a, r.id]);
  }
  for (const list of links.values()) list.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const nodes = holdings.map((h) => h.id).sort((x, y) => x - y);
  return { links, roads: roadById, holdings: holdingById, nodes };
}

export function roadLength(a: Holding, b: Holding): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return sqrt(dx * dx + dy * dy);
}

/** The road joining two holdings, if there is one. */
export function roadBetween(graph: RoadGraph, a: number, b: number): Road | undefined {
  const list = graph.links.get(a);
  if (!list) return undefined;
  for (const [n, r] of list) if (n === b) return graph.roads.get(r);
  return undefined;
}

/**
 * What a particular traveller may use and how hard it finds it (K3a). The
 * plain graph knows nothing of the fog or of upgrades; a caller passes these
 * in, so the router stays one function and its tie-breaks stay the same.
 */
export type RouteOptions = {
  /** May this road be travelled at all? (Fog: only roads the faction knows.) Default: all. */
  readonly usable?: (road: Road) => boolean;
  /**
   * May a route go ON from this holding, or only end there? (Fog: an
   * unknown holding at the end of a known road can be marched to but not
   * through.) Never asked of the holding the traveller stands in. Default: all.
   */
  readonly through?: (holding: number) => boolean;
  /** Effort per mile of a road for this traveller. Default: road.cost. */
  readonly cost?: (road: Road) => number;
};

/** Options for advanceMover. */
export type AdvanceOptions = {
  /** Effort per mile, as for RouteOptions.cost. Default: road.cost. */
  readonly cost?: (road: Road) => number;
  /**
   * Stop on reaching this holding even mid-route (route cleared): the party
   * halts at a site it is finding for the first time (K3a).
   */
  readonly stopAt?: (holding: number) => boolean;
};

export type Route = {
  /**
   * Holdings to reach, in order, starting with the first one the mover heads
   * for -- an end of its current road, or a neighbour of its current node --
   * and ending at the destination. Empty if it is already there.
   */
  readonly nodes: readonly number[];
  /** Total effort (miles x surface cost), excluding weather. */
  readonly effort: number;
};

/**
 * Cheapest route by road from wherever the mover stands to a holding.
 *
 * From a node, the search starts there. From partway along a road, it starts
 * at BOTH ends, each pre-loaded with the effort of getting to it -- so turning
 * round is considered exactly like going on, and a redirected march never
 * teleports to an end it has not reached.
 *
 * Tie-breaks, so the answer never depends on list order:
 *  - the next node settled is the unsettled one with least effort, then least id;
 *  - an equal-effort alternative replaces a node's predecessor only if it comes
 *    from a smaller id.
 *
 * Weather is ignored on purpose: it scales every mile alike, so it changes when
 * a route arrives, never which route is quickest.
 *
 * Returns null if the destination is unknown or unreachable.
 */
export function findRoute(graph: RoadGraph, mover: Mover, destination: number, opts: RouteOptions = {}): Route | null {
  const costOf = opts.cost ?? ((r: Road) => r.cost);
  if (!graph.holdings.has(destination)) return null;
  if (mover.road === 0 && mover.node === destination) return { nodes: [], effort: 0 };

  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const done = new Set<number>();
  for (const n of graph.nodes) dist.set(n, Infinity);

  // Where the search starts. An equal-effort detour never takes over a start:
  // standing on the road to a town, the road IS the way there.
  const starts = new Set<number>();
  if (mover.road === 0) {
    dist.set(mover.node, 0);
    starts.add(mover.node);
  } else {
    const r = graph.roads.get(mover.road);
    if (!r) return null;
    dist.set(mover.to, (r.length - mover.along) * costOf(r));
    dist.set(mover.from, mover.along * costOf(r));
    starts.add(mover.to);
    starts.add(mover.from);
  }

  for (;;) {
    let u = 0;
    let best = Infinity;
    for (const n of graph.nodes) {
      if (done.has(n)) continue;
      const d = dist.get(n) as number;
      if (d < best) { best = d; u = n; }
    }
    if (u === 0) break;
    done.add(u);
    if (u === destination) break;
    if (opts.through && !(mover.road === 0 && u === mover.node) && !opts.through(u)) continue;
    for (const [v, rid] of graph.links.get(u) ?? []) {
      if (done.has(v)) continue;
      const r = graph.roads.get(rid) as Road;
      if (opts.usable && !opts.usable(r)) continue;
      const nd = best + r.length * costOf(r);
      const cur = dist.get(v) as number;
      if (nd < cur || (nd === cur && !starts.has(v) && u < (prev.get(v) ?? Infinity))) {
        dist.set(v, nd);
        prev.set(v, u);
      }
    }
  }

  const total = dist.get(destination) as number;
  if (total === Infinity) return null;
  const nodes: number[] = [];
  let n: number | undefined = destination;
  while (n !== undefined) {
    nodes.push(n);
    n = prev.get(n);
  }
  nodes.reverse();
  // From a node the first entry is where it already stands.
  if (mover.road === 0) nodes.shift();
  return { nodes, effort: total };
}

/**
 * Point a mover at a route found by findRoute. If the route begins at the end
 * of its road it came FROM, the mover turns round where it stands.
 */
export function setRoute(graph: RoadGraph, mover: Mover, route: Route): void {
  const nodes = [...route.nodes];
  if (mover.road !== 0 && nodes.length > 0 && nodes[0] === mover.from) {
    const r = graph.roads.get(mover.road) as Road;
    const end = mover.from;
    mover.from = mover.to;
    mover.to = end;
    // `along` is measured from `from`, which just swapped ends.
    mover.along = r.length - mover.along;
  }
  mover.route = nodes;
}

/**
 * Spend `effort` (miles x surface cost x weather) moving along the route.
 *
 * May cross several holdings in one call if the roads are short; returns the
 * ids of the holdings reached, in order. A mover with an empty route stays
 * put, wherever it is -- including mid-road after a halt.
 */
export function advanceMover(graph: RoadGraph, mover: Mover, effort: number, weather: number, opts: AdvanceOptions = {}): number[] {
  const costOf = opts.cost ?? ((r: Road) => r.cost);
  const reached: number[] = [];
  let left = effort;
  while (left > 0 && mover.route.length > 0) {
    if (mover.road === 0) {
      const next = mover.route[0];
      const r = roadBetween(graph, mover.node, next);
      // setRoute only ever installs routes findRoute built from real roads,
      // so this is unreachable short of a corrupt save; stop rather than fly.
      if (!r) { mover.route = []; break; }
      mover.road = r.id;
      mover.from = mover.node;
      mover.to = next;
      mover.along = 0;
      mover.node = 0;
    }
    const r = graph.roads.get(mover.road) as Road;
    const perMile = costOf(r) * weather;
    const need = (r.length - mover.along) * perMile;
    if (need <= left) {
      left -= need;
      mover.node = mover.to;
      mover.road = 0;
      mover.along = 0;
      mover.from = 0;
      mover.to = 0;
      reached.push(mover.route.shift() as number);
      if (opts.stopAt && mover.route.length > 0 && opts.stopAt(mover.node)) {
        mover.route = [];
        break;
      }
    } else {
      mover.along += left / perMile;
      left = 0;
    }
  }
  return reached;
}

/** Where on the map a mover is, in miles. For the renderer (K2) and contact (K5). */
export function moverPosition(graph: RoadGraph, mover: Mover): { x: number; y: number } {
  if (mover.road === 0) {
    const h = graph.holdings.get(mover.node) as Holding;
    return { x: h.x, y: h.y };
  }
  const a = graph.holdings.get(mover.from) as Holding;
  const b = graph.holdings.get(mover.to) as Holding;
  const r = graph.roads.get(mover.road) as Road;
  const t = mover.along / r.length;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** A mover standing at a holding. */
export function moverAt(node: number): Mover {
  return { node, road: 0, from: 0, to: 0, along: 0, route: [] };
}
