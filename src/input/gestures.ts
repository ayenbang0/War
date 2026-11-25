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

/**
 * A thing the pen can act on.
 *
 * There are no inherent squads, so this is either a group the player has drawn
 * or a single loose soldier standing on his own -- the pen does not distinguish
 * between them, and neither does the recognizer. The Commander owns the mapping
 * back to the soldiers underneath.
 */
export type SquadView = {
  /** Opaque handle. The Commander decides what it refers to. */
  readonly id: number;
  readonly player: number;
  readonly x: number;
  readonly y: number;
  /** Footprint radius in world units; a lone soldier's is small. */
  readonly radius: number;
  /** Men behind this handle. 1 for a loose soldier; 2+ can be cut in two. */
  readonly size: number;
  readonly facing: number;
  /** False for enemies currently hidden by fog. */
  readonly visible: boolean;
};

/** A straight line held briefly, waiting to see if a parallel one follows. */
export type PendingLine = { readonly a: Point; readonly b: Point } | null;

/**
 * How many times a stroke genuinely doubles back.
 *
 * Measured as sign changes in the turn at each interior vertex of the COARSE
 * simplification, and only for turns sharp enough to be deliberate. A hand
 * wobbling along a straight line changes turn sign constantly, and counting
 * those would make every march an ambush.
 */
function reversals(simple: readonly Point[]): number {
  if (simple.length < 4) return 0;
  let n = 0;
  let last = 0;
  for (let i = 1; i + 1 < simple.length; i++) {
    const t = turnAt(simple, i);
    if (Math.abs(t) < 0.9) continue;
    const sign = t > 0 ? 1 : -1;
    if (last !== 0 && sign !== last) n++;
    last = sign;
  }
  return n;
}

/** Does this stroke run back along the one just drawn? */
function retraces(raw: readonly Point[], prev: readonly number[]): boolean {
  if (prev.length < 4 || raw.length < 2) return false;
  const ax = prev[0];
  const ay = prev[1];
  const bx = prev[prev.length - 2];
  const by = prev[prev.length - 1];
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 1e-6) return false;
  // Every point of the new stroke has to lie near the old line, and the two
  // must span roughly the same ground -- a short scribble over one end of a
  // long march is not a retrace of it.
  const tol = Math.max(70, len * 0.22);
  for (const p of raw) {
    const t = ((p.x - ax) * (bx - ax) + (p.y - ay) * (by - ay)) / (len * len);
    const cl = t < 0 ? 0 : t > 1 ? 1 : t;
    if (Math.hypot(p.x - (ax + (bx - ax) * cl), p.y - (ay + (by - ay) * cl)) > tol) return false;
  }
  const first = raw[0];
  const last = raw[raw.length - 1];
  return Math.hypot(last.x - first.x, last.y - first.y) > len * 0.5;
}

export type GestureContext = {
  readonly player: number;
  readonly squads: readonly SquadView[];
  /** Currently selected friendly squad ids. */
  readonly selected: readonly number[];
  /** World x of the player's own baseline; retreat means "back toward this". */
  readonly homeX: number;
  /** Set while a split line is awaiting a possible parallel partner. */
  readonly pendingLine?: PendingLine;
  /** The route just ordered, if it is still inside the pairing window. */
  readonly pendingRoute?: readonly number[] | null;
};

/** Two or more selected squads form a GROUP, which unlocks the group verbs. */
export function isGroup(ctx: GestureContext): boolean {
  return ctx.selected.length >= 2;
}

export type Recognized =
  | { kind: "select"; squads: number[] }
  | { kind: "move"; squads: number[]; path: number[] }
  | { kind: "attack"; squads: number[]; target: number; path: number[] }
  | { kind: "hold"; squads: number[]; x: number; y: number; radius: number }
  | { kind: "formation"; squads: number[]; shape: FormationShape }
  | { kind: "retreat"; squads: number[]; path: number[] }
  | { kind: "patrol"; squads: number[]; path: number[] }
  // -- group verbs, available only while two or more squads are selected --
  /** Cut the selection: squads left of the drawn direction stay selected. */
  | { kind: "split"; squads: number[]; keep: number[]; drop: number[]; line: number[] }
  /** Two parallel lines: lay the group out in rows and columns. */
  | { kind: "grid"; squads: number[]; places: number[]; rows: number[] }
  /** Cordon and sweep a circular area rather than trace a drawn circuit. */
  | { kind: "patrolArea"; squads: number[]; x: number; y: number; radius: number }
  /** Stand down and recover. Costs 30 seconds of total vulnerability. */
  | { kind: "recover"; squads: number[] }
  /** Lie in wait here: hold fire, keep still, strike whoever walks in. */
  | { kind: "ambush"; squads: number[] }
  /** Advance this route and come back: a real advance, honestly withdrawn. */
  | { kind: "feint"; squads: number[]; path: number[] }
  /** A loop drawn around loose men, with nothing selected: gather them up. */
  /**
   * Gather everything the loop encloses into one company.
   *
   * Carries the POLYGON, not just the handles it caught, because a loop drawn
   * around part of an existing company has to be able to cut those particular
   * men out of it -- and that is a question about where each man is standing,
   * which only the Commander can answer.
   */
  | { kind: "lasso"; squads: number[]; poly: number[] };

// -- tuning, all in world units ------------------------------------------------

/** Below this total length a stroke is a tap, not a drawing. */
export const TAP_LENGTH = 26;
/** Extra grab room around a squad footprint when anchoring a stroke. */
export const ANCHOR_SLACK = 26;
/** Endpoint within this much of an enemy footprint counts as targeting it. */
const ATTACK_SLACK = 34;
/** Ratio of endpoint gap to path length below which a stroke reads as closed. */
const CLOSED_RATIO = 0.3;
/**
 * A hold zone is at most this far across before it reads as a patrol circuit.
 *
 * Mostly a fixed world size, with only a modest term for the group's own
 * footprint. Scaling it purely by footprint meant re-forming a group -- from a
 * line into a square, say -- silently changed what an identical drawn loop
 * meant, which is not something a player can be expected to track.
 */
const HOLD_SPAN_BASE = 300;
const HOLD_SPAN_PER_RADIUS = 2.5;
/** Absolute ceiling so a hold drawn by a huge squad is still a hold. */
const HOLD_SPAN_MAX = 420;
/** Retreat must gain at least this much ground from the nearest enemy. */
const RETREAT_GAIN = 60;
/** Endpoint gap over path length below which an open stroke counts as straight. */
const STRAIGHT_RATIO = 0.9;
/** Two lines within this angle of each other count as parallel. */
const PARALLEL_TOLERANCE = 0.35;
/**
 * A closed shape filling less than this much of its convex hull has a real
 * notch cut into it, i.e. it is a heart rather than a ring. See hullFill.
 */
const HEART_HULL_FILL = 0.96;
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

  const span = bboxSpan(raw);
  // Two different simplifications, for two different jobs. The coarse one
  // decides WHAT the stroke is -- a straight line must survive as two points
  // even when drawn by a shaky hand. The fine one decides WHERE it goes, and
  // keeping it fine is what lets a swept arc stay an arc instead of collapsing
  // into two sharp corners.
  const simple = simplify(raw, Math.max(6, span * 0.09));
  const route = simplify(raw, Math.max(3, span * 0.018));
  const gap = Math.hypot(end.x - start.x, end.y - start.y);
  const closed = total > 1e-6 && gap / total < CLOSED_RATIO;

  // Subject: the squad the stroke starts on, else whatever is selected.
  //
  // The anchor is deliberately NOT applied to a large closed stroke. The rule
  // exists so that drawing FROM a squad TO somewhere is one motion, which is
  // about open strokes going places. A ring or a heart drawn across your own
  // line inevitably starts on top of some squad, and letting that hijack the
  // subject turned "recover this group" into "that one squad, patrol". Small
  // closed strokes still anchor, because a drawn box is how a formation glyph
  // is written.
  let anchored = anchorSquad(ctx, start);
  if (anchored !== null && closed) {
    const on = squadById(ctx, anchored);
    if (on && span > on.radius * 4.5) anchored = null;
    // A CLOSED stroke drawn while holding nothing is always a gather, whatever
    // it started on top of. The anchor exists so a stroke drawn FROM a company
    // TO somewhere is that company's order, which is about open strokes going
    // places; with nothing selected there is no order to give, and inventing a
    // subject turns "loop round these men" into "re-form whatever I started
    // over". That broke carving outright: a loop drawn tightly round half a
    // company necessarily begins on top of it, so every honest attempt to cut
    // a company in two was read as a formation glyph instead.
    if (ctx.selected.length === 0) anchored = null;
  }
  const subjects = anchored !== null ? [anchored] : ctx.selected.slice();

  // 0. Tap. Selects the squad under the pen, or clears the selection.
  if (total < TAP_LENGTH) {
    const tapped = anchorSquad(ctx, start);
    return { kind: "select", squads: tapped !== null ? [tapped] : [] };
  }
  // Nothing selected and a closed stroke: this is a lasso, the only way a
  // group ever comes into existence. Everything the loop encloses is gathered.
  if (subjects.length === 0) {
    if (!closed) return null;
    // Handles whose anchor falls inside, kept for the whole-company case. The
    // decisive test is per MAN and happens in the Commander: a loop around half
    // a company encloses none of its anchors, so gating on them here made
    // carving a company in two impossible.
    const inside: number[] = [];
    for (const u of ctx.squads) {
      if (u.player !== ctx.player) continue;
      if (pointInPolygon(u.x, u.y, raw)) inside.push(u.id);
    }
    const poly: number[] = [];
    for (const p of raw) poly.push(p.x, p.y);
    return { kind: "lasso", squads: inside, poly };
  }

  const subject = squadById(ctx, subjects[0]);
  const scale = subject ? Math.max(subject.radius, 20) : 30;

  // 1. Attack. An endpoint on an enemy is hard evidence and beats every
  //    shape-based reading, so it is resolved before shape is considered.
  const target = enemyAt(ctx, end);
  if (target !== null) {
    return { kind: "attack", squads: subjects, target, path: toPath(route) };
  }

  // 2. Formation. A glyph drawn ON the subject re-forms it, and this is
  //    resolved BEFORE the group verbs on purpose. Both a formation glyph and a
  //    split are straight strokes; the difference is whether the stroke sits on
  //    your men or out on the map. Testing split first meant a column drawn a
  //    little off-centre -- starting just beside the group rather than across
  //    it -- cut the selection in half instead of forming it up, which is a
  //    miserable thing to have happen by a few pixels.
  //    drawn ON the squad, an order is drawn away from it.
  if (subject) {
    const c = centroid(raw);
    const onSquad = Math.hypot(c.x - subject.x, c.y - subject.y) < subject.radius + ANCHOR_SLACK;
    if (onSquad && span < subject.radius * 4.5) {
      const shape = matchFormationGlyph(simple, closed, subject.facing);
      if (shape) return { kind: "formation", squads: subjects, shape };
    }
  }

  // 2b. Ambush. A zigzag -- three or more genuine direction reversals.
  //
  //     Chosen because NOTHING else in the vocabulary reverses direction more
  //     than once: a march is straight or gently swept, a glyph is one or two
  //     strokes, a ring turns steadily the same way. Counting reversals on the
  //     coarse simplification is what keeps a shaky straight line from
  //     accumulating false ones.
  //
  //     Deliberately NOT gated on the stroke being open. A tall zigzag has a
  //     long path between endpoints that are close together, so the closed test
  //     calls it closed and it fell through to the heart -- a zigzag was being
  //     read as "stand down". Repeated reversal is the stronger signal by far:
  //     a ring turns steadily one way and a heart has a single cusp, so neither
  //     reverses three times.
  if (reversals(simple) >= 3) {
    return { kind: "ambush", squads: subjects.slice() };
  }

  // 2c. Feint. A stroke that retraces the route just drawn, within the same
  //     pair window the grid gesture uses. Reusing that machinery rather than
  //     inventing another shape keeps the vocabulary from growing another way
  //     to be misread -- and "draw it again" is a natural way to say "and
  //     come back".
  if (!closed && ctx.pendingRoute && retraces(raw, ctx.pendingRoute)) {
    return { kind: "feint", squads: subjects.slice(), path: toPath(route) };
  }

  // 3. Recover. Available to ANY selection, not just a group of several.
  //
  //    Resolved BEFORE the group verbs, and that ordering is the whole point:
  //    a heart is a large closed stroke, so the group vocabulary read it as
  //    "patrol this area" and swallowed it. Standing one battered company down
  //    is also the commonest reason to want it, and gating it behind "two or
  //    more selected" made that impossible. Safe to resolve this early because
  //    a heart and a ring are separated by how much of its own convex hull the
  //    shape fills, with a wide margin: rings fill 0.98 to 1.00 of theirs,
  //    hearts 0.93.
  if (closed && span > scale && hullFill(raw) < HEART_HULL_FILL) {
    return { kind: "recover", squads: subjects.slice() };
  }

  // 4. Group verbs. Only with two or more squads selected, and only for
  //    strokes that did NOT start on a squad -- the subject rule wins, so
  //    drawing from a squad is always that squad's own order and a group can
  //    still be sent somewhere one squad at a time.
  //     for strokes that did NOT start on a squad -- the subject rule wins, so
  //     drawing from a squad is always that squad's own order and a group can
  //     still be sent somewhere one squad at a time.
  if (isGroup(ctx) && anchored === null) {
    const group = groupVerb(raw, ctx, simple, closed, span, subjects);
    if (group) return group;
  }

  // 5. Closed strokes: hold versus patrol, split by how much ground is enclosed.
  if (closed) {
    const holdSpan = Math.min(HOLD_SPAN_BASE + scale * HOLD_SPAN_PER_RADIUS, HOLD_SPAN_MAX);
    if (span <= holdSpan) {
      const c = centroid(raw);
      // Radius from enclosed area, not bbox: a scrawled loop's bbox overstates it.
      const radius = Math.max(scale, Math.sqrt(Math.max(enclosedArea(raw), 1) / Math.PI));
      return { kind: "hold", squads: subjects, x: c.x, y: c.y, radius };
    }
    return { kind: "patrol", squads: subjects, path: toPath(route) };
  }

  // 6. Open strokes: move versus retreat. Retreat has to earn it -- heading
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
          return { kind: "retreat", squads: subjects, path: toPath(route) };
        }
      }
    }
  }

  return { kind: "move", squads: subjects, path: toPath(route) };
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
    case "split":
      return "split " + r.keep.length + "/" + r.squads.length;
    case "grid":
      return "rows and columns";
    case "patrolArea":
      return "patrol area";
    case "recover":
      return "recover";
    case "ambush":
      return "ambush";
    case "feint":
      return "feint";
    case "lasso":
      // A bare word: how many MEN the loop takes is a question about where
      // each man stands, which only the Commander can answer (audit PC-07).
      // Counting anchors here read "group 0" over a loop round half a company.
      return "group";
    default:
      return r.kind;
  }
}

// -- group-verb geometry -------------------------------------------------------

/**
 * Convex hull by monotone chain. Used only to measure how much of a shape's
 * own hull it fails to fill.
 */
function convexHull(pts: readonly Point[]): Point[] {
  if (pts.length < 3) return pts.slice();
  const s = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * How much of its own convex hull a closed shape actually fills.
 *
 * This is what separates a heart from a circle, and it is measured on the RAW
 * stroke rather than the simplified one on purpose. Counting concave corners
 * was the obvious approach and it does not survive contact with RDP: the notch
 * between a heart's lobes is a fine feature, the simplification tolerance
 * scales with stroke size, and on a large heart the cusp is smoothed away
 * entirely -- so the same gesture read as a heart at one size and a circle at
 * another. Hull deficiency has no such cliff.
 *
 * Measured over the corpus: circles (hold, patrol, patrol-area) fill 0.983 to
 * 1.000 of their hull; hearts fill 0.926 to 0.932. The threshold sits in the
 * gap, with about five percentage points of margin on either side.
 */
function hullFill(pts: readonly Point[]): number {
  const hull = convexHull(pts);
  if (hull.length < 3) return 1;
  const hullArea = enclosedAreaOfLocal(hull);
  if (hullArea < 1e-6) return 1;
  return enclosedAreaOfLocal(pts) / hullArea;
}

function enclosedAreaOfLocal(pts: readonly Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Are two segments parallel (in either direction) within tolerance? */
function isParallel(a0: Point, a1: Point, b0: Point, b1: Point): boolean {
  const h1 = Math.atan2(a1.y - a0.y, a1.x - a0.x);
  const h2 = Math.atan2(b1.y - b0.y, b1.x - b0.x);
  return axisDelta(h1, h2) < PARALLEL_TOLERANCE;
}

/**
 * Which side of the directed line a-to-b a point falls on.
 *
 * World y grows downward, as on any canvas, so the sign is the opposite of the
 * textbook convention: NEGATIVE is the visually left-hand side of travel. Worth
 * stating, because "keep the left half" has to mean what the player sees.
 */
function sideOf(a: Point, b: Point, px: number, py: number): number {
  return (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
}

/**
 * Lay squads out on the two drawn lines: one rank per line, evenly spaced along
 * it. The lines are the drawing, so the arrangement is literally where the
 * player put them rather than a computed guess at what they meant.
 */
function gridPlaces(
  ctx: GestureContext,
  ids: readonly number[],
  a0: Point,
  a1: Point,
  b0: Point,
  b1: Point,
): { places: number[]; rows: number[] } {
  // Match the second line's direction to the first so ranks do not read reversed.
  let c0 = b0;
  let c1 = b1;
  const d1x = a1.x - a0.x;
  const d1y = a1.y - a0.y;
  if (d1x * (b1.x - b0.x) + d1y * (b1.y - b0.y) < 0) {
    c0 = b1;
    c1 = b0;
  }

  const n = ids.length;
  const perRow = Math.ceil(n / 2);
  const places: number[] = [];
  const rows: number[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / perRow);
    const inRow = row === 1 ? n - perRow : Math.min(perRow, n);
    const j = i - row * perRow;
    const t = inRow <= 1 ? 0.5 : (j + 0.5) / inRow;
    const s0 = row === 0 ? a0 : c0;
    const s1 = row === 0 ? a1 : c1;
    places.push(s0.x + (s1.x - s0.x) * t, s0.y + (s1.y - s0.y) * t);
    rows.push(row);
  }
  void ctx;
  return { places, rows };
}

/**
 * The group vocabulary, tried before the single-squad table.
 *
 * Closed strokes split three ways here rather than two: a heart stands down and
 * recovers, a large ring becomes a patrolled area rather than a traced circuit,
 * and a small loop still means hold. Straight open strokes become a cut through
 * the selection -- or, if one is already waiting, the second rail of a grid.
 */
function groupVerb(
  raw: readonly Point[],
  ctx: GestureContext,
  simple: readonly Point[],
  closed: boolean,
  span: number,
  subjects: readonly number[],
): Recognized | null {
  const scale = 60;

  if (closed) {
    if (span > Math.min(HOLD_SPAN_BASE + scale * HOLD_SPAN_PER_RADIUS, HOLD_SPAN_MAX)) {
      const c = centroidOf(raw);
      const radius = Math.max(scale, Math.sqrt(Math.max(enclosedAreaOf(raw), 1) / Math.PI));
      return { kind: "patrolArea", squads: subjects.slice(), x: c.x, y: c.y, radius };
    }
    return null; // small loop: fall through to the ordinary hold reading
  }

  // Straight open strokes only. A curved stroke is not a rail or a cut, so it
  // falls through to the normal move/retreat reading.
  const a = raw[0];
  const b = raw[raw.length - 1];
  const gap = Math.hypot(b.x - a.x, b.y - a.y);
  const total = pathLength(raw);
  if (total < 1e-6 || gap / total < STRAIGHT_RATIO || simple.length !== 2) return null;

  const pending = ctx.pendingLine ?? null;
  if (pending && isParallel(pending.a, pending.b, a, b)) {
    const { places, rows } = gridPlaces(ctx, subjects, pending.a, pending.b, a, b);
    return { kind: "grid", squads: subjects.slice(), places, rows };
  }

  // Cut the selection. Squads on the visually LEFT side of the stroke are kept,
  // so drawing the same line the other way keeps the other half -- one gesture,
  // both outcomes, no modifier.
  //
  // A line that misses the group entirely still returns a split with nothing
  // dropped. That is deliberate: the grid gesture's two rails are naturally
  // drawn where you want the ranks to END UP, which is often clear of the
  // group, and if a rail that cuts nothing were rejected here it could never
  // become the first half of a pair.
  const keep: number[] = [];
  const drop: number[] = [];
  for (const id of subjects) {
    const q = squadById(ctx, id);
    if (!q) continue;
    (sideOf(a, b, q.x, q.y) < 0 ? keep : drop).push(id);
  }
  return { kind: "split", squads: subjects.slice(), keep, drop, line: [a.x, a.y, b.x, b.y] };
}

function centroidOf(pts: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

function enclosedAreaOf(pts: readonly Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/**
 * Even-odd point-in-polygon against the raw stroke.
 *
 * Deliberately the RAW points rather than the simplified ones: a lasso is drawn
 * to enclose particular men, and simplifying first can cut a corner across
 * someone the player deliberately curved around.
 */
export function pointInPolygon(px: number, py: number, poly: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}
