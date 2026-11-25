/**
 * The town plan of one holding (K3b): where its square, streets, lots,
 * fields, houses, trees, water and walls lie, in PLAN UNITS (yards across a
 * sheet of a few hundred). A pure function of the holding's static facts --
 * its key and seed, kind, country, its numbers of building slots and field
 * plots, and the directions of its roads on the kingdom map -- so the same
 * holding always draws as the same town, and two holdings never quite do.
 *
 * Render side only. Nothing here is sim state and nothing in the sim reads
 * it: the sim's holding has slots and plots by index; this file decides
 * where slot 2 and plot 1 are drawn. It uses its own small integer PRNG
 * (never Math.random), seeded from the holding, so the plan is stable across
 * visits, saves and machines.
 *
 * Lots are laid out round the square in SLOT ORDER, clockwise from the main
 * street. The sim's build order takes the first free slot and a slot never
 * empties again, so the free lots are always the last ones: the town builds
 * round its square in turn (docs/PROVISIONAL.md K3b.1).
 */

import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { BiomeId, HoldingKind } from "../../content/kingdom/terrain.ts";

export type Pt = { readonly x: number; readonly y: number };

export type LotPlace = {
  /** The building slot this lot is: holding.buildings[index]. */
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Radians; the long side runs along it. */
  readonly angle: number;
  /** Corners, clockwise. */
  readonly poly: readonly Pt[];
};

export type FieldPlace = {
  /** The plot this field is: holding.plots[index]. */
  readonly index: number;
  readonly poly: readonly Pt[];
  readonly cx: number;
  readonly cy: number;
  /** Direction the furrows run (radians). */
  readonly angle: number;
};

export type House = { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly angle: number };
export type Tree = { readonly x: number; readonly y: number; readonly r: number; readonly conifer: boolean };
export type Street = { readonly pts: readonly Pt[]; readonly width: number; readonly main: boolean; readonly angle: number };

export type Water =
  | { readonly kind: "river"; readonly pts: readonly Pt[]; readonly width: number }
  | { readonly kind: "sea"; readonly poly: readonly Pt[]; readonly shore: readonly Pt[] };

export type SquareKind = "green" | "market" | "bailey";

export type CityPlanInput = {
  readonly key: string;
  readonly seed: number;
  readonly biome: BiomeId;
  readonly kind: HoldingKind;
  /** holding.buildings.length */
  readonly slots: number;
  /** holding.plots.length */
  readonly plots: number;
  /** Directions (radians, map space: +x east, +y south) of the roads out to its neighbours. */
  readonly roadAngles: readonly number[];
};

export type CityPlan = {
  readonly key: string;
  readonly biome: BiomeId;
  readonly kind: HoldingKind;
  readonly width: number;
  readonly height: number;
  readonly centre: Pt;
  /** Radius of the town's core: where an enclosure is built. */
  readonly coreR: number;
  readonly square: { readonly x: number; readonly y: number; readonly r: number; readonly kind: SquareKind };
  readonly streets: readonly Street[];
  readonly lots: readonly LotPlace[];
  readonly fields: readonly FieldPlace[];
  /** The line a palisade or wall follows. */
  readonly ring: readonly Pt[];
  /** Where streets pass through the ring. */
  readonly gates: readonly Pt[];
  readonly houses: readonly House[];
  readonly trees: readonly Tree[];
  readonly water: Water | null;
  readonly bridges: readonly { readonly x: number; readonly y: number; readonly angle: number }[];
  /** Height lines (highland, border hills). */
  readonly contours: readonly (readonly Pt[])[];
  /** Ground marks: stones (moor, the Reach) and heather tufts. */
  readonly stones: readonly Pt[];
  readonly tufts: readonly Pt[];
  /** Hedgerows along field edges (vale, open farmland). */
  readonly hedges: readonly (readonly Pt[])[];
};

type Size = {
  readonly w: number; readonly h: number; readonly core: number;
  readonly lotW: number; readonly lotH: number; readonly square: number;
  readonly fieldDepth: number; readonly fieldLen: number; readonly street: number; readonly houses: number;
};

/** Per kind of holding. A hamlet's sheet is small, so it fills the window too. */
export const PLAN_SIZE: Readonly<Record<HoldingKind, Size>> = {
  hamlet: { w: 620, h: 440, core: 64, lotW: 46, lotH: 34, square: 18, fieldDepth: 88, fieldLen: 150, street: 8, houses: 8 },
  village: { w: 720, h: 500, core: 86, lotW: 48, lotH: 36, square: 24, fieldDepth: 92, fieldLen: 170, street: 9, houses: 18 },
  town: { w: 880, h: 620, core: 126, lotW: 54, lotH: 40, square: 34, fieldDepth: 100, fieldLen: 200, street: 11, houses: 52 },
  keep: { w: 740, h: 520, core: 96, lotW: 50, lotH: 38, square: 28, fieldDepth: 88, fieldLen: 170, street: 10, houses: 16 },
  city: { w: 1000, h: 700, core: 172, lotW: 58, lotH: 42, square: 44, fieldDepth: 104, fieldLen: 220, street: 14, houses: 120 },
};

const TAU = Math.PI * 2;

/** sfc-free small PRNG (mulberry32): integer ops, the same everywhere. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a of a string, for mixing the key into the seed. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function norm(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** Smallest absolute difference between two angles. */
export function angleGap(a: number, b: number): number {
  const d = Math.abs(norm(a) - norm(b));
  return Math.min(d, TAU - d);
}

const at = (c: Pt, a: number, r: number): Pt => ({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });

/** Corners of a rectangle centred at (x, y), long side along `angle`. */
export function rectPoly(x: number, y: number, w: number, h: number, angle: number): Pt[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const hw = w / 2;
  const hh = h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => ({ x: x + u * c - v * s, y: y + u * s + v * c }));
}

export function pointInPoly(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToPolyline(p: Pt, pts: readonly Pt[]): number {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSegment(p, pts[i - 1], pts[i]));
  return d;
}

/**
 * Share `n` items among the gaps between `cuts` (angles), in proportion to
 * each gap's size (largest remainder, ties to the earlier gap), skipping
 * `blocked` arcs. Returns, per item in order clockwise from the first cut,
 * the centre angle of its share and the share's width.
 */
function shareGaps(n: number, cuts: readonly number[], blocked: { a: number; half: number } | null): { a: number; w: number }[] {
  if (n <= 0) return [];
  const sorted = [...cuts].map(norm).sort((x, y) => x - y);
  // Gaps between consecutive cuts; with no cuts the whole circle is one gap from 0.
  type Gap = { a0: number; a1: number };
  let gaps: Gap[] = sorted.length === 0
    ? [{ a0: 0, a1: TAU }]
    : sorted.map((a, i) => ({ a0: a, a1: i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + TAU }));
  if (blocked) {
    // Trim the blocked arc out of whichever gaps it falls in.
    const b0 = norm(blocked.a - blocked.half);
    const b1 = b0 + blocked.half * 2;
    const out: Gap[] = [];
    for (const g of gaps) {
      let pieces: Gap[] = [g];
      for (const shift of [-TAU, 0, TAU]) {
        const lo = b0 + shift;
        const hi = b1 + shift;
        const next: Gap[] = [];
        for (const p of pieces) {
          if (hi <= p.a0 || lo >= p.a1) { next.push(p); continue; }
          if (lo > p.a0) next.push({ a0: p.a0, a1: lo });
          if (hi < p.a1) next.push({ a0: hi, a1: p.a1 });
        }
        pieces = next;
      }
      out.push(...pieces);
    }
    gaps = out.length > 0 ? out : gaps;
  }
  const total = gaps.reduce((s, g) => s + (g.a1 - g.a0), 0);
  const exact = gaps.map((g) => ((g.a1 - g.a0) / total) * n);
  const counts = exact.map((e) => Math.floor(e));
  let left = n - counts.reduce((s, c) => s + c, 0);
  const order = exact.map((e, i) => ({ i, r: e - Math.floor(e) })).sort((x, y) => y.r - x.r || x.i - y.i);
  for (const o of order) { if (left <= 0) break; counts[o.i]++; left--; }
  const out: { a: number; w: number }[] = [];
  gaps.forEach((g, i) => {
    const k = counts[i];
    const w = (g.a1 - g.a0) / Math.max(1, k);
    for (let j = 0; j < k; j++) out.push({ a: norm(g.a0 + w * (j + 0.5)), w });
  });
  return out;
}

/** Road directions closer than this are one street out of town. */
const MERGE_ROADS = (25 * Math.PI) / 180;

export function cityPlan(input: CityPlanInput): CityPlan {
  const size = PLAN_SIZE[input.kind];
  const rnd = prng((input.seed ^ fnv(input.key)) >>> 0);
  const jit = (s: number): number => (rnd() * 2 - 1) * s;
  const W = size.w;
  const H = size.h;
  const centre: Pt = { x: W / 2 + jit(W * 0.04), y: H / 2 + jit(H * 0.04) };
  const core = size.core * (0.94 + rnd() * 0.12);

  // -- streets: toward the real roads -------------------------------------------
  const angles: number[] = [];
  for (const a of input.roadAngles) if (!angles.some((b) => angleGap(a, b) < MERGE_ROADS)) angles.push(norm(a));
  if (angles.length === 0) angles.push(norm(rnd() * TAU));
  // A town on one road still has a back lane out the other side.
  const lanes = angles.length === 1 ? [norm(angles[0] + Math.PI + jit(0.5))] : [];
  const reach = Math.hypot(W, H) * 0.6;
  const streets: Street[] = [...angles, ...lanes].map((a, i) => {
    const bend = jit(0.12);
    const pts: Pt[] = [centre];
    for (const f of [0.35, 0.7, 1]) pts.push(at(centre, a + bend * f, reach * f));
    const lane = i >= angles.length;
    return { pts, width: size.street * (i === 0 ? 1.25 : lane ? 0.7 : 1), main: i === 0, angle: a };
  });
  const cuts = streets.map((s) => s.angle);

  // -- water: on the side with no road -----------------------------------------
  let water: Water | null = null;
  const bridges: { x: number; y: number; angle: number }[] = [];
  let waterAngle: number | null = null;
  if (input.biome === "river" || input.biome === "river-town" || input.biome === "coast") {
    const gaps = shareGaps(1, cuts, null);
    const wa = gaps.length > 0 ? gaps[0].a : rnd() * TAU;
    waterAngle = wa;
    // The largest gap is the one shareGaps gave its single item to.
    const d = core * (input.biome === "river-town" ? 1.02 : input.biome === "river" ? 1.32 : 1.3);
    const foot = at(centre, wa, d);
    const t = wa + Math.PI / 2;
    if (input.biome === "coast") {
      const shore: Pt[] = [];
      for (let i = -6; i <= 6; i++) {
        const p = at(foot, t, (i / 6) * reach);
        shore.push(at(p, wa, jit(10)));
      }
      const far = shore.map((p) => at(p, wa, reach * 1.4)).reverse();
      water = { kind: "sea", poly: [...shore, ...far], shore };
    } else {
      const pts: Pt[] = [];
      for (let i = -6; i <= 6; i++) {
        const p = at(foot, t, (i / 6) * reach);
        pts.push(at(p, wa, Math.sin(i * 0.9 + rnd()) * 14));
      }
      const width = input.biome === "river-town" ? 30 : 24;
      water = { kind: "river", pts, width };
      for (const s of streets) {
        const diff = angleGap(s.angle, wa);
        if (diff > Math.PI / 2 - 0.2) continue;
        const r = d / Math.cos(diff);
        if (r > reach) continue;
        const b = at(centre, s.angle, r);
        bridges.push({ x: b.x, y: b.y, angle: s.angle });
      }
    }
  }

  // -- the square, the lots round it ---------------------------------------------
  const squareKind: SquareKind = input.kind === "hamlet" ? "green" : input.kind === "keep" ? "bailey" : "market";
  const sq = { x: centre.x, y: centre.y, r: size.square * (0.9 + rnd() * 0.2), kind: squareKind };
  const lotR = Math.max(sq.r + size.lotH * 0.75, core * 0.62);
  const lotShares = shareGaps(input.slots, cuts, null);
  // Slot order: clockwise from the main street, so lot 1 sits beside the way in.
  const main = streets[0].angle;
  lotShares.sort((p, q) => norm(p.a - main) - norm(q.a - main));
  const lots: LotPlace[] = lotShares.map((s, i) => {
    const p = at(centre, s.a, lotR);
    const angle = s.a + Math.PI / 2;
    return { index: i, x: p.x, y: p.y, w: size.lotW, h: size.lotH, angle, poly: rectPoly(p.x, p.y, size.lotW, size.lotH, angle) };
  });

  // -- the ring an enclosure follows -------------------------------------------
  const ring: Pt[] = [];
  const RING_N = 22;
  for (let i = 0; i < RING_N; i++) ring.push(at(centre, (i / RING_N) * TAU, core * (1 + jit(0.045))));
  const gates = streets.map((s) => at(centre, s.angle, core));

  // -- fields, outside the ring, between the roads ---------------------------------
  const blocked = waterAngle === null ? null : { a: waterAngle, half: (60 * Math.PI) / 180 };
  const fieldShares = shareGaps(input.plots, cuts, blocked);
  fieldShares.sort((p, q) => norm(p.a - main) - norm(q.a - main));
  const rIn = core * 1.3;
  const fields: FieldPlace[] = fieldShares.map((s, i) => {
    const depth = size.fieldDepth * (0.82 + rnd() * 0.18);
    const rMid = rIn + depth / 2;
    // A share can be half the circle; a field is a field, not a moat.
    const width = Math.min(s.w - 0.2, size.fieldLen / rMid);
    const a0 = s.a - width / 2;
    const a1 = s.a + width / 2;
    const inner: Pt[] = [];
    const outer: Pt[] = [];
    const N = 6;
    for (let k = 0; k <= N; k++) {
      const a = a0 + ((a1 - a0) * k) / N;
      inner.push(at(centre, a, rIn + jit(3)));
      outer.push(at(centre, a, rIn + depth + jit(5)));
    }
    const poly = [...inner, ...outer.reverse()];
    const c = at(centre, s.a, rMid);
    return { index: i, poly, cx: c.x, cy: c.y, angle: s.a };
  });

  // -- houses along the streets, inside the ring ----------------------------------
  const taken: { x: number; y: number; r: number }[] = [{ x: sq.x, y: sq.y, r: sq.r + 4 }];
  for (const l of lots) taken.push({ x: l.x, y: l.y, r: Math.hypot(l.w, l.h) / 2 + 4 });
  const clear = (p: Pt, r: number): boolean => {
    for (const t of taken) if (Math.hypot(p.x - t.x, p.y - t.y) < t.r + r) return false;
    for (const s of streets) if (distToPolyline(p, s.pts) < s.width / 2 + r) return false;
    if (water?.kind === "river" && distToPolyline(p, water.pts) < water.width / 2 + r + 4) return false;
    if (water?.kind === "sea" && pointInPoly(p, water.poly)) return false;
    for (const f of fields) if (pointInPoly(p, f.poly)) return false;
    return true;
  };
  const houses: House[] = [];
  const suburbs = input.kind === "town" || input.kind === "city" ? 1.45 : 1.0;
  for (let tries = 0; houses.length < size.houses && tries < size.houses * 14; tries++) {
    const s = streets[Math.floor(rnd() * streets.length)];
    const r = sq.r + 10 + rnd() * (core * suburbs - sq.r - 10);
    const side = rnd() < 0.5 ? -1 : 1;
    const hw = 7 + rnd() * 6;
    const hh = 5 + rnd() * 3;
    const along = at(centre, s.angle, r);
    const p = at(along, s.angle + side * Math.PI / 2, s.width / 2 + hh + 2 + rnd() * 5);
    const rr = Math.hypot(hw, hh) / 2;
    if (!clear(p, rr)) continue;
    houses.push({ x: p.x, y: p.y, w: hw, h: hh, angle: s.angle + jit(0.15) });
    taken.push({ x: p.x, y: p.y, r: rr });
  }
  // Back lots: a few more off the street, inside the ring.
  for (let tries = 0, extra = Math.floor(size.houses / 3); extra > 0 && tries < 300; tries++) {
    const a = rnd() * TAU;
    const p = at(centre, a, sq.r + 14 + rnd() * (core * 0.9 - sq.r - 14));
    const hw = 6 + rnd() * 5;
    const hh = 4 + rnd() * 3;
    const rr = Math.hypot(hw, hh) / 2;
    if (!clear(p, rr)) continue;
    houses.push({ x: p.x, y: p.y, w: hw, h: hh, angle: a + jit(0.4) });
    taken.push({ x: p.x, y: p.y, r: rr });
    extra--;
  }

  // -- the country round it -------------------------------------------------------
  const inSheet = (p: Pt, m: number): boolean => p.x > m && p.y > m && p.x < W - m && p.y < H - m;
  const outside = (p: Pt, r: number): boolean => Math.hypot(p.x - centre.x, p.y - centre.y) > core * 1.12 + r && clear(p, r);
  const trees: Tree[] = [];
  const TREES: Record<BiomeId, number> = {
    forest: 190, vale: 34, open: 22, reach: 10, moor: 6, highland: 30, "border-hills": 28, river: 30, "river-town": 18, city: 14, coast: 10,
  };
  const conifer = input.biome === "reach" || input.biome === "highland" || input.biome === "moor";
  const wantTrees = TREES[input.biome];
  for (let tries = 0; trees.length < wantTrees && tries < wantTrees * 12; tries++) {
    const p = { x: rnd() * W, y: rnd() * H };
    const r = input.biome === "forest" ? 7 + rnd() * 7 : 5 + rnd() * 5;
    if (!inSheet(p, 6) || !outside(p, r)) continue;
    trees.push({ x: p.x, y: p.y, r, conifer: conifer || (input.biome === "forest" && rnd() < 0.3) });
    taken.push({ x: p.x, y: p.y, r: r * 0.7 });
  }

  const contours: Pt[][] = [];
  if (input.biome === "highland" || input.biome === "border-hills") {
    // A hill off to one side of the town, away from the main street.
    const ha = norm(main + Math.PI + jit(0.8));
    const hc = at(centre, ha, Math.min(W, H) * 0.55);
    for (let ring = 0; ring < 5; ring++) {
      const r = 50 + ring * 38;
      const loop: Pt[] = [];
      for (let k = 0; k < 30; k++) loop.push(at(hc, (k / 30) * TAU, r * (1 + jit(0.08))));
      contours.push(loop);
    }
  }
  const stones: Pt[] = [];
  const tufts: Pt[] = [];
  if (input.biome === "moor" || input.biome === "reach") {
    for (let tries = 0; stones.length < 44 && tries < 600; tries++) {
      const p = { x: rnd() * W, y: rnd() * H };
      if (inSheet(p, 8) && outside(p, 3)) stones.push(p);
    }
    for (let tries = 0; tufts.length < 70 && tries < 900; tries++) {
      const p = { x: rnd() * W, y: rnd() * H };
      if (inSheet(p, 8) && outside(p, 2)) tufts.push(p);
    }
  }
  const hedges: Pt[][] = [];
  if (input.biome === "vale" || input.biome === "open") {
    for (const f of fields) hedges.push([...f.poly, f.poly[0]]);
  }

  return {
    key: input.key, biome: input.biome, kind: input.kind, width: W, height: H, centre, coreR: core,
    square: sq, streets, lots, fields, ring, gates, houses, trees, water, bridges, contours, stones, tufts, hedges,
  };
}

/** The plan of a holding in a live world: reads its static facts and its roads. */
export function planFor(world: KingdomWorld, holdingId: number): CityPlan {
  const h = world.holding(holdingId);
  if (!h) throw new Error("no holding " + holdingId);
  const roadAngles: number[] = [];
  for (const [n] of world.graph.links.get(h.id) ?? []) {
    const o = world.holding(n);
    if (o) roadAngles.push(Math.atan2(o.y - h.y, o.x - h.x));
  }
  return cityPlan({
    key: h.key, seed: h.seed, biome: h.biome, kind: h.kind,
    slots: h.buildings.length, plots: h.plots.length, roadAngles,
  });
}

// -- hit testing (in plan units; the caller passes a tolerance from its zoom) --------

export type CityPick =
  | { readonly kind: "lot"; readonly index: number }
  | { readonly kind: "field"; readonly index: number }
  | { readonly kind: "square" };

/** What a point on the plan is: a lot, a field, or the square; null for nothing. Lots win ties. */
export function pickAt(plan: CityPlan, p: Pt, tol: number): CityPick | null {
  let best: { pick: CityPick; d: number } | null = null;
  for (const l of plan.lots) {
    // Distance from the lot's rectangle, in its own frame.
    const c = Math.cos(-l.angle);
    const s = Math.sin(-l.angle);
    const u = (p.x - l.x) * c - (p.y - l.y) * s;
    const v = (p.x - l.x) * s + (p.y - l.y) * c;
    const dx = Math.max(0, Math.abs(u) - l.w / 2);
    const dy = Math.max(0, Math.abs(v) - l.h / 2);
    const d = Math.hypot(dx, dy);
    if (d <= tol && (!best || d < best.d)) best = { pick: { kind: "lot", index: l.index }, d };
  }
  if (best) return best.pick;
  const sd = Math.hypot(p.x - plan.square.x, p.y - plan.square.y) - plan.square.r;
  if (sd <= tol) return { kind: "square" };
  for (const f of plan.fields) if (pointInPoly(p, f.poly)) return { kind: "field", index: f.index };
  // A near miss on a field's edge still counts, within the tolerance.
  let fb: { i: number; d: number } | null = null;
  for (const f of plan.fields) {
    const d = distToPolyline(p, [...f.poly, f.poly[0]]);
    if (d <= tol && (!fb || d < fb.d)) fb = { i: f.index, d };
  }
  return fb ? { kind: "field", index: fb.i } : null;
}
