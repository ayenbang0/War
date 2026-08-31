/**
 * Pen gesture recognition.
 *
 * Pure functions over world-space point arrays: no DOM, no canvas, no state.
 * That boundary is deliberate -- it lets the whole discrimination table be
 * tested headless as a confusion matrix, which is the only way the pair
 * collisions below stay honest as the vocabulary grows.
 *
 * THE PROBLEM. Six gestures drawn freehand collide in three places:
 *   - hold and patrol are both closed loops
 *   - formation-change and hold can both be a drawn box
 *   - move and retreat are both open lines
 * Shape alone cannot separate them, so classification runs in a fixed priority
 * order and each step uses a different kind of evidence:
 *
 *   0. TAP        near-zero extent                    -> selection, not an order
 *   1. ATTACK     endpoint lands on a visible enemy   -> resolved before shape
 *   2. FORMATION  stroke is centred ON the squad and matches a glyph
 *   3. HOLD/PATROL  closed stroke, split by enclosed area
 *   4. MOVE/RETREAT open stroke, split by direction relative to home and enemy
 *
 * Rule 2 is what keeps a drawn box from meaning two things: a box centred on
 * your own squad re-forms it into a square, a box drawn out on the map is a
 * hold order. Rule 1 runs first because an endpoint hit-test is hard evidence
 * and shape is not.
 */

import type { FormationShape } from "../sim/formations.ts";

export type Point = { readonly x: number; readonly y: number };

export type SquadView = {
  readonly id: number;
  readonly player: number;
  readonly x: number;
  readonly y: number;
  /** Formation radius in world units. */
  readonly radius: number;
  readonly facing: number;
  /** False for enemies currently hidden by fog (Phase 4). */
  readonly visible: boolean;
};

export type GestureContext = {
  readonly player: number;
  readonly squads: readonly SquadView[];
  /** Currently selected friendly squad ids. */
  readonly selected: readonly number[];
  /** World x of the player's own baseline; retreat means "back toward this". */
  readonly homeX: number;
};

export type Recognized =
  | { kind: "select"; squads: number[] }
  | { kind: "move"; squads: number[]; path: number[] }
  | { kind: "attack"; squads: number[]; target: number; path: number[] }
  | { kind: "hold"; squads: number[]; x: number; y: number; radius: number }
  | { kind: "formation"; squads: number[]; shape: FormationShape }
  | { kind: "retreat"; squads: number[]; path: number[] }
  | { kind: "patrol"; squads: number[]; path: number[] };

// -- tuning, all in world units ------------------------------------------------

/** Below this total length a stroke is a tap, not a drawing. */
const TAP_LENGTH = 26;
/** Extra grab room around a squad footprint when anchoring a stroke. */
export const ANCHOR_SLACK = 26;
/** Endpoint within this much of an enemy footprint counts as targeting it. */
const ATTACK_SLACK = 34;
/** Ratio of endpoint gap to path length below which a stroke reads as closed. */
const CLOSED_RATIO = 0.3;
/** A hold zone is at most this many squad-radii across. Beyond it, patrol. */
const HOLD_SPAN_RADII = 6.5;
/** Absolute ceiling so a hold drawn by a huge squad is still a hold. */
const HOLD_SPAN_MAX = 420;
/** Retreat must gain at least this much ground from the nearest enemy. */
const RETREAT_GAIN = 60;
/** ...and point at least this much homeward, as a cosine (about 63 degrees). */
const RETREAT_HOMEWARD = 0.45;

// -- geometry helpers ----------------------------------------------------------

export function pathLength(pts: readonly Point[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return n;
}

function centroid(pts: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/** Shoelace area of the polygon formed by closing the stroke. */
function enclosedArea(pts: readonly Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function bboxSpan(pts: readonly Point[]): number {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return Math.max(x1 - x0, y1 - y0);
}

/**
 * Ramer-Douglas-Peucker. Two jobs at once: it turns a jittery mouse drag into
 * the clean path the spec asks for (section 4.2), and its vertex count becomes
 * the shape evidence the glyph matcher runs on -- a straight stroke keeps 2
 * points, a chevron 3, a box 5.
 */
export function simplify(pts: readonly Point[], tolerance: number): Point[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  rdp(pts, 0, pts.length - 1, tolerance, keep);
  const out: Point[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i] === 1) out.push(pts[i]);
  return out;
}

function rdp(pts: readonly Point[], lo: number, hi: number, tol: number, keep: Uint8Array): void {
  if (hi <= lo + 1) return;
  const ax = pts[lo].x;
  const ay = pts[lo].y;
  const bx = pts[hi].x;
  const by = pts[hi].y;
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);

  let worst = -1;
  let worstI = -1;
  for (let i = lo + 1; i < hi; i++) {
    const px = pts[i].x - ax;
    const py = pts[i].y - ay;
    // Degenerate segment (a loop returning to its start): fall back to radial
    // distance, or every point looks equally on-line and the loop collapses.
    const d = len < 1e-9 ? Math.hypot(px, py) : Math.abs(px * dy - py * dx) / len;
    if (d > worst) {
      worst = d;
      worstI = i;
    }
  }
  if (worst > tol && worstI > 0) {
    keep[worstI] = 1;
    rdp(pts, lo, worstI, tol, keep);
    rdp(pts, worstI, hi, tol, keep);
  }
}

/** Signed turn at vertex i, in radians. */
function turnAt(pts: readonly Point[], i: number): number {
  const a = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
  const b = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Smallest absolute difference between two headings, ignoring direction. */
function axisDelta(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

// -- subject resolution --------------------------------------------------------

/**
 * Which squad a stroke acts on.
 *
 * A stroke that starts on one of your squads takes that squad as its subject
 * and selects it, so drawing from a squad to a destination is one motion rather
 * than select-then-order (spec section 5.1). Otherwise the order falls to the
 * current selection.
 *
 * Tolerance is in WORLD units, never screen pixels: the same drawn stroke must
 * mean the same thing at zoom 0.35 and at 2.4. Ties break on squad id, never on
 * iteration order, because footprints overlap constantly once formations
 * deform and two peers must agree.
 */
export function anchorSquad(ctx: GestureContext, at: Point): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const q of ctx.squads) {
    if (q.player !== ctx.player) continue;
    const d = Math.hypot(q.x - at.x, q.y - at.y);
    if (d > q.radius + ANCHOR_SLACK) continue;
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && (best === null || q.id < best))) {
      bestD = d;
      best = q.id;
    }
  }
  return best;
}

function enemyAt(ctx: GestureContext, at: Point): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const q of ctx.squads) {
    if (q.player === ctx.player || !q.visible) continue;
    const d = Math.hypot(q.x - at.x, q.y - at.y);
    if (d > q.radius + ATTACK_SLACK) continue;
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && (best === null || q.id < best))) {
      bestD = d;
      best = q.id;
    }
  }
  return best;
}

function nearestEnemy(ctx: GestureContext, at: Point): SquadView | null {
  let best: SquadView | null = null;
  let bestD = Infinity;
  for (const q of ctx.squads) {
    if (q.player === ctx.player || !q.visible) continue;
    const d = Math.hypot(q.x - at.x, q.y - at.y);
    if (d < bestD || (d === bestD && best !== null && q.id < best.id)) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

function squadById(ctx: GestureContext, id: number): SquadView | null {
  for (const q of ctx.squads) if (q.id === id) return q;
  return null;
}

/**
 * Formation glyphs, recognised only when drawn centred on the squad itself.
 *
 * Shape alone decides which: a stroke across the squad's front is a line, one
 * along its axis is a column, a chevron is a wedge, a closed box is a square.
 * loose and tight are deliberately NOT reachable here -- stroke extent already
 * carries meaning elsewhere in this table, and overloading it as a continuous
 * spacing parameter would make a slightly-too-long line flip between "wide
 * line" and "hold this area". They stay reachable from doctrine and content.
 */
function matchFormationGlyph(
  simple: readonly Point[],
  closed: boolean,
  facing: number,
): FormationShape | null {
  if (closed && simple.length >= 4) return "square";
  if (simple.length === 2) {
    const heading = Math.atan2(simple[1].y - simple[0].y, simple[1].x - simple[0].x);
    // Perpendicular to facing means abreast: a line. Along it means a column.
    return axisDelta(heading, facing) > Math.PI / 4 ? "line" : "column";
  }
  if (simple.length === 3) {
    const turn = Math.abs(turnAt(simple, 1));
    // A real chevron, not a lazy bend in a line.
    if (turn > 0.7 && turn < 2.6) return "wedge";
  }
  return null;
}

// -- the recognizer ------------------------------------------------------------

/**
 * Classify a raw world-space stroke. Returns null when the stroke means
 * nothing actionable, for example an order drawn with nothing selected.
 *
 * Call this continuously during the stroke to drive the ghost preview, and once
 * more on release to commit -- it is pure, so re-running it costs nothing.
 */
export function recognize(raw: readonly Point[], ctx: GestureContext): Recognized | null {
  if (raw.length === 0) return null;

  const start = raw[0];
  const end = raw[raw.length - 1];
  const total = pathLength(raw);

  // Subject: the squad the stroke starts on, else whatever is selected.
  const anchored = anchorSquad(ctx, start);
  const subjects = anchored !== null ? [anchored] : ctx.selected.slice();

  // 0. Tap. Selects the squad under the pen, or clears the selection.
  if (total < TAP_LENGTH) {
    return { kind: "select", squads: anchored !== null ? [anchored] : [] };
  }
  if (subjects.length === 0) return null;

  const subject = squadById(ctx, subjects[0]);
  const scale = subject ? Math.max(subject.radius, 20) : 30;
  const span = bboxSpan(raw);
  const simple = simplify(raw, Math.max(6, span * 0.09));
  const gap = Math.hypot(end.x - start.x, end.y - start.y);
  const closed = total > 1e-6 && gap / total < CLOSED_RATIO;

  // 1. Attack. An endpoint on an enemy is hard evidence and beats every
  //    shape-based reading, so it is resolved before shape is considered.
  const target = enemyAt(ctx, end);
  if (target !== null) {
    return { kind: "attack", squads: subjects, target, path: toPath(simple) };
  }

  // 2. Formation. Only when the stroke is centred on the subject: a glyph is
  //    drawn ON the squad, an order is drawn away from it.
  if (subject) {
    const c = centroid(raw);
    const onSquad = Math.hypot(c.x - subject.x, c.y - subject.y) < subject.radius + ANCHOR_SLACK;
    if (onSquad && span < subject.radius * 4.5) {
      const shape = matchFormationGlyph(simple, closed, subject.facing);
      if (shape) return { kind: "formation", squads: subjects, shape };
    }
  }

  // 3. Closed strokes: hold versus patrol, split by how much ground is enclosed.
  if (closed) {
    const holdSpan = Math.min(scale * HOLD_SPAN_RADII, HOLD_SPAN_MAX);
    if (span <= holdSpan) {
      const c = centroid(raw);
      // Radius from enclosed area, not bbox: a scrawled loop's bbox overstates it.
      const radius = Math.max(scale, Math.sqrt(Math.max(enclosedArea(raw), 1) / Math.PI));
      return { kind: "hold", squads: subjects, x: c.x, y: c.y, radius };
    }
    return { kind: "patrol", squads: subjects, path: toPath(simple) };
  }

  // 4. Open strokes: move versus retreat. Retreat has to earn it -- heading
  //    home AND opening real distance from the nearest enemy. Without the
  //    second test every backward reposition would read as a rout.
  if (subject) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.hypot(dx, dy);
    const homeSign = ctx.homeX < subject.x ? -1 : 1;
    // How much of the stroke actually points home, as a cosine. A sign test on
    // dx alone is not enough: a due-north march has no x component at all, so
    // jitter decides its sign, and a sideways step does open ground from an
    // enemy that is due east. Requiring a real homeward component keeps a
    // lateral reposition from reading as a rout.
    const homeward = len > 1e-6 ? (dx * homeSign) / len : 0;
    if (homeward > RETREAT_HOMEWARD) {
      const foe = nearestEnemy(ctx, { x: subject.x, y: subject.y });
      if (foe) {
        const before = Math.hypot(foe.x - start.x, foe.y - start.y);
        const after = Math.hypot(foe.x - end.x, foe.y - end.y);
        if (after - before > RETREAT_GAIN) {
          return { kind: "retreat", squads: subjects, path: toPath(simple) };
        }
      }
    }
  }

  return { kind: "move", squads: subjects, path: toPath(simple) };
}

/** Drop the first point: a path starts where the squad already is. */
function toPath(simple: readonly Point[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < simple.length; i++) out.push(simple[i].x, simple[i].y);
  if (out.length === 0 && simple.length > 0) {
    out.push(simple[simple.length - 1].x, simple[simple.length - 1].y);
  }
  return out;
}

/** Short label for the ghost preview. */
export function gestureLabel(r: Recognized | null): string {
  if (!r) return "";
  switch (r.kind) {
    case "select":
      return r.squads.length > 0 ? "select" : "clear";
    case "formation":
      return "form " + r.shape;
    default:
      return r.kind;
  }
}
