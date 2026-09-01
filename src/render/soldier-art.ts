/**
 * How each kind of soldier is drawn.
 *
 * Every type gets its own silhouette and its own motion, because at a glance a
 * player has to know what is in front of them without reading a label. The
 * shapes are built to be told apart at four or five pixels, which rules out
 * detail and rules in outline: a spear block is broad, an outrider is a dart, a
 * siege engine is a box on wheels.
 *
 * All of it is procedural. There are no sprites in this project, so a unit type
 * is a function, not an asset.
 */

import type { UnitTypeId } from "../content/unit-types.ts";

export type Brush = {
  readonly ctx: CanvasRenderingContext2D;
  /** Screen position. */
  readonly x: number;
  readonly y: number;
  /** Facing in radians, already interpolated. */
  readonly a: number;
  /** Base size in screen pixels. */
  readonly r: number;
  /** 0 just attacked, rising to 1 as the soldier recovers. Drives weapon work. */
  readonly recover: number;
  /** Seconds, for gaits that should not march in lockstep. */
  readonly t: number;
  /** Per-soldier phase offset so a rank does not animate as one. */
  readonly phase: number;
};

/** Relative size per type, so a siege engine looms and a scout does not. */
export const SIZE: Record<UnitTypeId, number> = {
  line: 1.0,
  skirmisher: 0.82,
  archer: 0.9,
  horse: 1.35,
  guard: 1.15,
  mage: 0.95,
  scout: 0.8,
  siege: 1.6,
};

function tri(b: Brush, len: number, wide: number, back: number): void {
  const { ctx, x, y, a, r } = b;
  const c = Math.cos(a);
  const s = Math.sin(a);
  ctx.moveTo(x + c * r * len, y + s * r * len);
  ctx.lineTo(x - c * r * back - s * r * wide, y - s * r * back + c * r * wide);
  ctx.lineTo(x - c * r * back + s * r * wide, y - s * r * back - c * r * wide);
  ctx.closePath();
}

function box(b: Brush, fwd: number, side: number): void {
  const { ctx, x, y, a, r } = b;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const px = -s;
  const py = c;
  ctx.moveTo(x + c * r * fwd + px * r * side, y + s * r * fwd + py * r * side);
  ctx.lineTo(x + c * r * fwd - px * r * side, y + s * r * fwd - py * r * side);
  ctx.lineTo(x - c * r * fwd - px * r * side, y - s * r * fwd - py * r * side);
  ctx.lineTo(x - c * r * fwd + px * r * side, y - s * r * fwd + py * r * side);
  ctx.closePath();
}

/** Add one soldier's body to the current path. */
export function bodyPath(type: UnitTypeId, b: Brush): void {
  switch (type) {
    case "line":
      // A broad, blunt wedge: the shape of a man behind a shield.
      tri(b, 0.95, 0.8, 0.55);
      return;
    case "guard":
      // Heavier and squarer than the line it anchors.
      box(b, 0.8, 0.72);
      return;
    case "skirmisher":
      // Light and narrow, leaning forward.
      tri(b, 1.15, 0.5, 0.4);
      return;
    case "scout":
      // A dart. Nothing else on the field is this thin.
      tri(b, 1.5, 0.34, 0.3);
      return;
    case "archer":
      // Body plus the arc of a bow held across the front.
      tri(b, 0.85, 0.62, 0.5);
      return;
    case "horse":
      // Long in the body, because a mount is longer than a man.
      box(b, 1.25, 0.42);
      return;
    case "mage":
      // No point at all: a rounded figure, unmistakably not a fighter.
      b.ctx.moveTo(b.x + b.r * 0.75, b.y);
      b.ctx.arc(b.x, b.y, b.r * 0.75, 0, Math.PI * 2);
      return;
    case "siege":
      // A blunt engine, wider than it is long.
      box(b, 0.85, 1.0);
      return;
  }
}

/**
 * Ornament drawn over the body: bows, staves, lances, wheels.
 *
 * Separate from the body so bodies can be batched and filled in one pass per
 * type while the fiddly bits are stroked in another -- 460 individual
 * fill+stroke pairs would cost more than the rest of the frame together.
 */
export function detailPath(type: UnitTypeId, b: Brush): void {
  const { ctx, x, y, a, r } = b;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const px = -s;
  const py = c;

  switch (type) {
    case "archer": {
      // The bow bends as the archer draws and springs back when he looses.
      const draw = 0.35 + 0.45 * (1 - b.recover);
      ctx.moveTo(x + c * r * 0.7 + px * r * 0.9, y + s * r * 0.7 + py * r * 0.9);
      ctx.quadraticCurveTo(
        x + c * r * (0.7 + draw), y + s * r * (0.7 + draw),
        x + c * r * 0.7 - px * r * 0.9, y + s * r * 0.7 - py * r * 0.9,
      );
      return;
    }
    case "horse": {
      // A lance, dipping as it strikes and rising again on the recovery.
      const dip = (1 - b.recover) * 0.5;
      ctx.moveTo(x + c * r * 0.4 + px * r * 0.5, y + s * r * 0.4 + py * r * 0.5);
      ctx.lineTo(
        x + c * r * (1.9 - dip) + px * r * 0.3,
        y + s * r * (1.9 - dip) + py * r * 0.3,
      );
      return;
    }
    case "mage": {
      // A staff, and a working that turns over slowly at the tip.
      const spin = b.t * 1.4 + b.phase;
      ctx.moveTo(x - c * r * 0.2, y - s * r * 0.2);
      ctx.lineTo(x + c * r * 1.3, y + s * r * 1.3);
      const gx = x + c * r * 1.35;
      const gy = y + s * r * 1.35;
      ctx.moveTo(gx + Math.cos(spin) * r * 0.4, gy + Math.sin(spin) * r * 0.4);
      ctx.arc(gx, gy, r * 0.4, 0, Math.PI * 2);
      return;
    }
    case "siege": {
      // Wheels, and a beam that recoils hard the instant it looses.
      const recoil = (1 - b.recover) * 0.7;
      for (const side of [-1, 1]) {
        const wx = x + px * r * side * 0.95;
        const wy = y + py * r * side * 0.95;
        ctx.moveTo(wx + r * 0.34, wy);
        ctx.arc(wx, wy, r * 0.34, 0, Math.PI * 2);
      }
      ctx.moveTo(x - c * r * (0.5 + recoil), y - s * r * (0.5 + recoil));
      ctx.lineTo(x + c * r * (1.2 - recoil), y + s * r * (1.2 - recoil));
      return;
    }
    case "guard": {
      // A standard, so the anchor of a line is findable in a melee.
      ctx.moveTo(x - c * r * 0.3, y - s * r * 0.3);
      ctx.lineTo(x - c * r * 0.3 + px * r * 1.4, y - s * r * 0.3 + py * r * 1.4);
      return;
    }
    default:
      return;
  }
}

/**
 * Bob applied to a soldier's drawn position: a gait.
 *
 * Cavalry rock heavily, skirmishers and scouts trot, foot soldiers barely move,
 * and siege engines grind along without bouncing at all. Purely visual -- the
 * simulation knows nothing about it.
 */
export function gait(type: UnitTypeId, moving: boolean, t: number, phase: number): number {
  if (!moving) return 0;
  switch (type) {
    case "horse":
      return Math.sin(t * 11 + phase) * 1.9;
    case "scout":
    case "skirmisher":
      return Math.sin(t * 9 + phase) * 1.1;
    case "siege":
      return 0;
    default:
      return Math.sin(t * 6.5 + phase) * 0.6;
  }
}

/**
 * The same brush moved. Used to draw a counter's contact shadow: the identical
 * body path, offset, so the shadow can never disagree with the silhouette.
 */
export function offsetBrush(b: Brush, dx: number, dy: number): Brush {
  return { ...b, x: b.x + dx, y: b.y + dy };
}
