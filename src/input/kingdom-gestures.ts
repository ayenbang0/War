/**
 * Pen gesture recognition on the KINGDOM map (PLAN.md §B.5): a separate
 * recogniser context, so the strategic vocabulary can never collide with the
 * battlefield's -- a line on the kingdom map is a march by road, never a
 * squad move, and a battle stroke is never read here.
 *
 * Pure, like input/gestures.ts: world-space points in, a classification out;
 * no DOM, no state. It reuses that file's pure stroke utilities (`pathLength`,
 * `simplify`) and leaves it untouched, so the battle's confusion matrix cannot
 * move because of anything here. The kingdom's own matrix lives in
 * tools/gesture-corpus.ts beside the battle's and runs in `npm test`.
 *
 * WHAT IT READS. K2 has one token, the king, so the vocabulary that makes
 * sense is: a tap on the king (his card), a tap on a holding (its card), and a
 * line from the king to a holding (march). Everything else is `none` WITH A
 * REASON -- never null -- because a stroke that means nothing must say so
 * (U0 PC-02, U1-05).
 *
 * THE ORDER, each step on its own kind of evidence:
 *   0. TAP      total length within the tap tolerance -> nearest token or holding
 *   1. CLOSED   ends near where it began -> reserved for K4 (garrison ring,
 *               patrol ring, recover heart). Checked BEFORE anchoring, because
 *               a ring drawn round the king always begins on the king, and
 *               letting that make it a march would be the battle's ring/move
 *               bug one layer up (CLAUDE.md: "a large closed stroke is never
 *               claimed by the anchor").
 *   2. SUBJECT  the stroke must begin on a token (K2: the king)
 *   3. TARGET   where it ends: a holding -> march. K4 adds, in this step and
 *               no other: an enemy army -> intercept; an own army -> merge;
 *               and before it, a line ACROSS an army -> split.
 *
 * TOLERANCES (U0 PC-14, U1-13). CLAUDE.md wants recogniser thresholds in world
 * units so a stroke means the same at every zoom; U0 found that a tap or grab
 * radius fixed in world units is a few pixels at one zoom and tens at another,
 * which no hand can hit or avoid. So each one here is a WORLD base clamped
 * between a screen-pixel floor and ceiling, through `ctx.pxToWorld`: shapes
 * are judged in miles, and what a finger or cursor can actually hit is judged
 * in pixels only at the extremes. The corpus runs at both zoom limits.
 */

import { pathLength, simplify, type Point } from "./gestures.ts";
import type { HoldingKind } from "../content/kingdom/terrain.ts";
import type { KingdomNoneReason } from "../content/kingdom/ui-strings.ts";

export type { Point };

/** Something on the map the pen can act on: the king now, armies from K4. */
export type TokenView = {
  readonly id: number;
  readonly kind: "king";
  /** Faction index (FACTION_IDS); the human king is 0. */
  readonly owner: number;
  /** Where its counter is DRAWN, in miles (render/kingdom/layout.ts). */
  readonly x: number;
  readonly y: number;
  /** The holding it stands in, or 0 while on a road. */
  readonly at: number;
};

export type HoldingView = {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly kind: HoldingKind;
};

export type KingdomGestureContext = {
  /** The seat drawing: only its own tokens can be given orders. */
  readonly player: number;
  /** In id order. */
  readonly tokens: readonly TokenView[];
  /** In id order. */
  readonly holdings: readonly HoldingView[];
  /** Map miles per screen pixel at the zoom the stroke was drawn at. */
  readonly pxToWorld: number;
};

export type KingdomGesture =
  | { kind: "tapToken"; token: number }
  | { kind: "tapHolding"; holding: number }
  /** A line from a token to a holding. `path` is the simplified stroke, flat x,y. */
  | { kind: "march"; token: number; to: number; path: number[] }
  | { kind: "none"; reason: KingdomNoneReason };
  // K4: intercept / garrison / patrol / split / merge / recover slot in here,
  // each produced by exactly one of the steps above.

// -- tuning: [world base in miles, screen floor px, screen ceiling px] ---------

/** Below this length a stroke is a tap, not a drawing. */
export const TAP_TOLERANCE = { miles: 8, minPx: 6, maxPx: 12 } as const;
/** A stroke beginning this close to a token's counter is drawn FROM it. */
export const TOKEN_GRAB = { miles: 10, minPx: 16, maxPx: 26 } as const;
/** A stroke ending (or a tap landing) this close to a holding means that holding. */
export const HOLDING_HIT_MILES: Record<HoldingKind, number> = {
  hamlet: 7, village: 8, keep: 9, town: 10, city: 13,
};
export const HOLDING_HIT_PX = { minPx: 12, maxPx: 24 } as const;
/**
 * A stroke is closed when its ends are this close in absolute terms AND
 * within CLOSED_RATIO of its length. The absolute cap is what keeps a curved
 * march to a holding just beside the king from reading as a ring: a ring ends
 * where it began, a detour ends somewhere else.
 */
export const CLOSED_GAP = { miles: 18, minPx: 18, maxPx: 40 } as const;
const CLOSED_RATIO = 0.3;
/** Simplification for the march path, in miles. */
const SIMPLIFY_MILES = 4;

/** A world-unit base clamped to what a pointer can hit at this zoom. */
export function tolerance(miles: number, minPx: number, maxPx: number, pxToWorld: number): number {
  return Math.min(maxPx * pxToWorld, Math.max(minPx * pxToWorld, miles));
}

export function holdingHitRadius(kind: HoldingKind, pxToWorld: number): number {
  return tolerance(HOLDING_HIT_MILES[kind], HOLDING_HIT_PX.minPx, HOLDING_HIT_PX.maxPx, pxToWorld);
}

function tokenGrab(pxToWorld: number): number {
  return tolerance(TOKEN_GRAB.miles, TOKEN_GRAB.minPx, TOKEN_GRAB.maxPx, pxToWorld);
}

/**
 * The holding a point means: the nearest one whose hit circle holds it.
 * Ties break on holding id, so overlapping circles never depend on list order.
 */
export function holdingAt(ctx: KingdomGestureContext, p: Point): HoldingView | null {
  let best: HoldingView | null = null;
  let bestD = Infinity;
  for (const h of ctx.holdings) {
    const d = Math.hypot(h.x - p.x, h.y - p.y);
    if (d > holdingHitRadius(h.kind, ctx.pxToWorld)) continue;
    if (d < bestD || (d === bestD && best !== null && h.id < best.id)) {
      best = h;
      bestD = d;
    }
  }
  return best;
}

/** The player's own token a point grabs, nearest first, ties on id. */
export function tokenAt(ctx: KingdomGestureContext, p: Point): TokenView | null {
  const grab = tokenGrab(ctx.pxToWorld);
  let best: TokenView | null = null;
  let bestD = Infinity;
  for (const t of ctx.tokens) {
    if (t.owner !== ctx.player) continue;
    const d = Math.hypot(t.x - p.x, t.y - p.y);
    if (d > grab) continue;
    if (d < bestD || (d === bestD && best !== null && t.id < best.id)) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

/**
 * A tap: whichever candidate it lands nearer to, measured as a fraction of
 * each one's own hit radius, so a big city does not swallow the king's
 * counter beside it. The token wins an exact tie -- it is drawn on top.
 */
function tapTarget(ctx: KingdomGestureContext, p: Point): KingdomGesture {
  const grab = tokenGrab(ctx.pxToWorld);
  let token: TokenView | null = null;
  let tokenScore = Infinity;
  for (const t of ctx.tokens) {
    const s = Math.hypot(t.x - p.x, t.y - p.y) / grab;
    if (s <= 1 && (s < tokenScore || (s === tokenScore && token !== null && t.id < token.id))) {
      token = t;
      tokenScore = s;
    }
  }
  let holding: HoldingView | null = null;
  let holdingScore = Infinity;
  for (const h of ctx.holdings) {
    const s = Math.hypot(h.x - p.x, h.y - p.y) / holdingHitRadius(h.kind, ctx.pxToWorld);
    if (s <= 1 && (s < holdingScore || (s === holdingScore && holding !== null && h.id < holding.id))) {
      holding = h;
      holdingScore = s;
    }
  }
  if (token && tokenScore <= holdingScore) return { kind: "tapToken", token: token.id };
  if (holding) return { kind: "tapHolding", holding: holding.id };
  return { kind: "none", reason: "nothing-there" };
}

/** Whether a stroke closes on itself (see CLOSED_GAP). */
export function isClosed(raw: readonly Point[], pxToWorld: number): boolean {
  if (raw.length < 3) return false;
  const len = pathLength(raw);
  const a = raw[0];
  const b = raw[raw.length - 1];
  const gap = Math.hypot(b.x - a.x, b.y - a.y);
  return gap <= CLOSED_RATIO * len && gap <= tolerance(CLOSED_GAP.miles, CLOSED_GAP.minPx, CLOSED_GAP.maxPx, pxToWorld);
}

export function recognizeKingdom(raw: readonly Point[], ctx: KingdomGestureContext): KingdomGesture {
  if (raw.length === 0) return { kind: "none", reason: "nothing-there" };
  const first = raw[0];
  const last = raw[raw.length - 1];

  // 0. A tap reads where it landed. Its midpoint, not its first sample: a
  //    mouse tap wanders a pixel or two between down and up.
  const tap = tolerance(TAP_TOLERANCE.miles, TAP_TOLERANCE.minPx, TAP_TOLERANCE.maxPx, ctx.pxToWorld);
  if (pathLength(raw) <= tap) {
    return tapTarget(ctx, { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 });
  }

  // 1. Closed shapes belong to armies (K4), and are never claimed by the anchor.
  if (isClosed(raw, ctx.pxToWorld)) return { kind: "none", reason: "closed-shape" };

  // 2. The subject: a line means nothing unless it starts on one of your tokens.
  const token = tokenAt(ctx, first);
  if (!token) return { kind: "none", reason: "not-from-king" };

  // 3. The target, from where the line ENDS -- the endpoint is hard evidence,
  //    the path between is only how the hand got there.
  const dest = holdingAt(ctx, last);
  if (!dest) return { kind: "none", reason: "no-destination" };
  if (dest.id === token.at) return { kind: "none", reason: "already-there" };

  const simple = simplify(raw, SIMPLIFY_MILES);
  const path: number[] = [];
  for (const p of simple) path.push(p.x, p.y);
  return { kind: "march", token: token.id, to: dest.id, path };
}

/** The matrix label of a classification (tools/test-gestures.ts). */
export function kingdomGestureLabel(g: KingdomGesture): string {
  return g.kind === "none" ? "none" : g.kind;
}
