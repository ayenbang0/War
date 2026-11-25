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
  healer: 0.85,
  builder: 0.95,
  pike: 1.0,
  crossbow: 0.95,
  lancer: 1.45,
  slinger: 0.8,
  champion: 1.3,
  banner: 1.0,
  drummer: 0.9,
  hounds: 0.75,
  oathsworn: 1.08,
  wagon: 1.55,
};

/** A closed polygon from (forward, side) pairs, in units of r, around the facing. */
function poly(b: Brush, pts: readonly number[]): void {
  const { ctx, x, y, a, r } = b;
  const c = Math.cos(a);
  const s = Math.sin(a);
  for (let i = 0; i < pts.length; i += 2) {
    const f = pts[i] * r;
    const w = pts[i + 1] * r;
    const px = x + c * f - s * w;
    const py = y + s * f + c * w;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** A stroke from (f0, w0) to (f1, w1), in units of r, around the facing. */
function seg(b: Brush, f0: number, w0: number, f1: number, w1: number): void {
  const { ctx, x, y, a, r } = b;
  const c = Math.cos(a);
  const s = Math.sin(a);
  ctx.moveTo(x + (c * f0 - s * w0) * r, y + (s * f0 + c * w0) * r);
  ctx.lineTo(x + (c * f1 - s * w1) * r, y + (s * f1 + c * w1) * r);
}

/** A small ring at (f, w), in units of r. */
function ring(b: Brush, f: number, w: number, rad: number): void {
  const { ctx, x, y, a, r } = b;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const cx = x + (c * f - s * w) * r;
  const cy = y + (s * f + c * w) * r;
  ctx.moveTo(cx + rad * r, cy);
  ctx.arc(cx, cy, rad * r, 0, Math.PI * 2);
}

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
    case "healer":
      // Rounded like the adept -- neither is a fighter -- but noticeably
      // smaller, so the two are never confused at a glance.
      b.ctx.moveTo(b.x + b.r * 0.62, b.y);
      b.ctx.arc(b.x, b.y, b.r * 0.62, 0, Math.PI * 2);
      return;
    case "builder":
      // Squat and square: men who dig rather than march.
      box(b, 0.62, 0.66);
      return;
    case "pike":
      // Narrow front to back, wide across: a man in a deep block.
      box(b, 0.5, 0.7);
      return;
    case "crossbow":
      // A shouldered wedge, blunter than an archer's.
      poly(b, [0.8, 0, 0.35, 0.62, -0.55, 0.55, -0.55, -0.55, 0.35, -0.62]);
      return;
    case "lancer":
      // Barded horse: longer and heavier than ordinary horse, with a chest.
      poly(b, [1.25, 0, 0.9, 0.48, -1.12, 0.48, -1.25, 0, -1.12, -0.48, 0.9, -0.48]);
      return;
    case "slinger":
      tri(b, 1.0, 0.45, 0.35);
      return;
    case "champion":
      // A broad hexagon: one big man, plainly not a rank-and-file counter.
      poly(b, [0.9, 0, 0.45, 0.8, -0.45, 0.8, -0.9, 0, -0.45, -0.8, 0.45, -0.8]);
      return;
    case "banner":
      // Rounded square: the colour party is a knot of men, not a line.
      poly(b, [0.6, 0.35, 0.35, 0.6, -0.35, 0.6, -0.6, 0.35, -0.6, -0.35, -0.35, -0.6, 0.35, -0.6, 0.6, -0.35]);
      return;
    case "drummer":
      b.ctx.moveTo(b.x + b.r * 0.6, b.y);
      b.ctx.arc(b.x, b.y, b.r * 0.6, 0, Math.PI * 2);
      return;
    case "hounds":
      // Long and low: a dog is a dart with a deep chest.
      poly(b, [1.25, 0, 0.6, 0.32, -0.9, 0.24, -1.1, 0, -0.9, -0.24, 0.6, -0.32]);
      return;
    case "oathsworn":
      // A kite shield: pointed at the front like the line, but tall and heavy.
      poly(b, [1.0, 0, 0.2, 0.75, -0.65, 0.6, -0.65, -0.6, 0.2, -0.75]);
      return;
    case "wagon":
      // A long armoured box, longer than wide: a cart, not an engine.
      box(b, 1.1, 0.72);
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
    case "healer": {
      // A cross. The one unmistakable mark on the field, and the only one that
      // means "do not shoot at this".
      ctx.moveTo(x - c * r * 0.5, y - s * r * 0.5);
      ctx.lineTo(x + c * r * 0.5, y + s * r * 0.5);
      ctx.moveTo(x - px * r * 0.5, y - py * r * 0.5);
      ctx.lineTo(x + px * r * 0.5, y + py * r * 0.5);
      return;
    }
    case "builder": {
      // A spade over the shoulder, angled so it reads as a tool, not a weapon.
      ctx.moveTo(x - c * r * 0.4 - px * r * 0.5, y - s * r * 0.4 - py * r * 0.5);
      ctx.lineTo(x + c * r * 0.7 + px * r * 0.4, y + s * r * 0.7 + py * r * 0.4);
      // The blade, which works up and down while they dig.
      const dig = Math.sin(b.t * 5 + b.phase) * 0.12;
      seg(b, 0.7 + dig, 0.2, 0.85 + dig, 0.6);
      return;
    }
    case "line": {
      // A short spear held out over the shield, jabbing when they strike.
      const jab = (1 - b.recover) * 0.45;
      seg(b, 0.2, 0.45, 1.35 + jab, 0.35);
      return;
    }
    case "skirmisher": {
      // A javelin carried high, thrown forward and then reached for again.
      const throwOut = (1 - b.recover) * 0.6;
      seg(b, -0.5 + throwOut, 0.35, 0.75 + throwOut, 0.15);
      return;
    }
    case "scout": {
      // A short cloak streaming behind, longer the faster they go.
      const flap = Math.sin(b.t * 8 + b.phase) * 0.18;
      seg(b, -0.2, 0.2, -0.95, 0.35 + flap);
      seg(b, -0.2, -0.2, -0.95, -0.35 - flap);
      return;
    }
    case "pike": {
      // The pike itself, far out ahead of the man: the longest line on the
      // field, so a block of them reads as a hedge from any zoom.
      const thrust = (1 - b.recover) * 0.35;
      seg(b, -0.4, 0.15, 2.7 + thrust, 0.05);
      return;
    }
    case "crossbow": {
      // Prod across the front, and the windlass turning while they reload.
      seg(b, 0.85, 0.6, 0.85, -0.6);
      seg(b, 0.95, 0, -0.2, 0);
      if (b.recover < 1) {
        const crank = b.t * 9 + b.phase;
        ring(b, -0.25 + Math.cos(crank) * 0.15, Math.sin(crank) * 0.15, 0.12);
      }
      return;
    }
    case "lancer": {
      // A long lance with a pennon that streams in the wind of the charge.
      const dip = (1 - b.recover) * 0.6;
      seg(b, 0.4, 0.55, 2.4 - dip, 0.32);
      const tip = 2.0 - dip;
      const flutter = Math.sin(b.t * 12 + b.phase) * 0.14;
      seg(b, tip, 0.36, tip - 0.35, 0.55 + flutter);
      seg(b, tip - 0.35, 0.55 + flutter, tip - 0.3, 0.36);
      return;
    }
    case "slinger": {
      // The sling whirls round the head until it lets fly.
      const spin = b.t * 14 + b.phase * 3;
      const len = b.recover < 0.35 ? 0.2 : 0.55;
      ring(b, 0.1 + Math.cos(spin) * len, 0.25 + Math.sin(spin) * len, 0.1);
      return;
    }
    case "champion": {
      // A great blade, swung through an arc on every blow.
      const swing = (1 - b.recover) * 1.6 - 0.8;
      const ca = Math.cos(swing);
      const sa = Math.sin(swing);
      seg(b, 0.2, 0.55, 0.2 + ca * 1.5, 0.55 + sa * 1.5);
      return;
    }
    case "banner": {
      // Pole, and a flag that rolls in the wind. Everyone can find the colours.
      seg(b, -0.1, 0, -0.1, -1.9);
      const wave = Math.sin(b.t * 4 + b.phase) * 0.22;
      const wave2 = Math.sin(b.t * 4 + b.phase + 1.4) * 0.22;
      ctx.moveTo(x + (c * -0.1 - s * -1.9) * r, y + (s * -0.1 + c * -1.9) * r);
      ctx.lineTo(x + (c * (-1.0 + wave) - s * -1.75) * r, y + (s * (-1.0 + wave) + c * -1.75) * r);
      ctx.lineTo(x + (c * (-1.0 + wave2) - s * -1.25) * r, y + (s * (-1.0 + wave2) + c * -1.25) * r);
      ctx.lineTo(x + (c * -0.1 - s * -1.2) * r, y + (s * -0.1 + c * -1.2) * r);
      return;
    }
    case "drummer": {
      // A drum on the hip and two sticks that beat it in time, all together:
      // the drummers are the one thing on the field that moves in unison.
      ring(b, 0.55, 0, 0.32);
      const beat = Math.abs(Math.sin(b.t * 7));
      seg(b, 0.1, 0.35, 0.5 + beat * 0.25, 0.15);
      seg(b, 0.1, -0.35, 0.5 + (1 - beat) * 0.25, -0.15);
      return;
    }
    case "hounds": {
      // A tail that never stops, and jaws that snap on the bite.
      const wag = Math.sin(b.t * 16 + b.phase) * 0.35;
      seg(b, -1.05, 0, -1.6, wag);
      const snap = (1 - b.recover) * 0.25;
      seg(b, 1.25, 0, 1.5 + snap, 0.18);
      seg(b, 1.25, 0, 1.5 + snap, -0.18);
      return;
    }
    case "oathsworn": {
      // A bearded axe, raised and brought down.
      const chop = (1 - b.recover) * 0.9;
      seg(b, 0, 0.6, 0.9 + chop * 0.5, 0.95 - chop);
      ring(b, 0.95 + chop * 0.5, 0.95 - chop, 0.16);
      return;
    }
    case "wagon": {
      // Four wheels turning, and a handgun that kicks back when it fires.
      for (const f of [-0.7, 0.7]) {
        for (const w of [-0.82, 0.82]) ring(b, f, w, 0.26);
      }
      const kick = (1 - b.recover) * 0.35;
      seg(b, 0.2 - kick, 0, 1.45 - kick, 0);
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
    case "lancer":
      // Heavier: a slower, deeper roll.
      return Math.sin(t * 9 + phase) * 2.2;
    case "hounds":
      // A bounding run.
      return Math.abs(Math.sin(t * 13 + phase)) * -1.6;
    case "drummer":
      // In step with each other, which nobody else on the field is.
      return Math.sin(t * 7) * 0.7;
    case "slinger":
      return Math.sin(t * 9 + phase) * 1.0;
    case "wagon":
      // Jolting over the ground rather than bouncing.
      return (Math.sin(t * 17 + phase) > 0.85 ? 0.6 : 0);
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
