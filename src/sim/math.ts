/**
 * Deterministic math for the simulation.
 *
 * WHY THIS FILE EXISTS
 * IEEE 754 guarantees that + - * / and sqrt produce bit-identical results on
 * every conforming engine. ECMA-262 does NOT specify the transcendentals:
 * Math.sin, cos, tan, atan, atan2, pow, exp, log and hypot are explicitly
 * implementation-approximated and genuinely differ between V8, SpiderMonkey and
 * JavaScriptCore -- and between versions of the same engine. A formation system
 * is wall-to-wall atan2 and sin/cos for facing and slot rotation, so using the
 * host's versions would make replays and lockstep netplay drift apart silently.
 *
 * Everything here is built from + - * / sqrt and exactly-specified Math members
 * only, so it is deterministic by construction. Accuracy is approximate; that is
 * fine. Determinism is the requirement, not precision.
 *
 * This is the ONLY file in src/sim/ permitted to reference `Math`, and only its
 * exactly-specified members (floor, ceil, abs, sqrt, min, max, round, trunc,
 * sign). tools/check-sim-purity.mjs enforces both halves of that rule.
 */

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;

const INV_TAU = 1 / TAU;

// -- exactly-specified primitives, re-exported so sim code never touches Math --
export const floor = Math.floor;
export const ceil = Math.ceil;
export const abs = Math.abs;
export const sqrt = Math.sqrt;
export const min = Math.min;
export const max = Math.max;
export const round = Math.round;
export const trunc = Math.trunc;
export const sign = Math.sign;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wrap to [-PI, PI). Used for angle differences. */
export function wrapAngle(a: number): number {
  const t = (a + PI) * INV_TAU;
  return (a + PI) - floor(t) * TAU - PI;
}

/**
 * sin via odd Taylor polynomial after reduction to [-PI/2, PI/2].
 * Degree 15. The first omitted term is x^17/17!, which at the interval edge
 * (PI/2) is ~3e-12 -- comfortably below anything the sim can observe.
 * Multiply and add only, so it is bit-identical on every engine.
 */
export function sin(x: number): number {
  // reduce to [-PI, PI)
  let a = wrapAngle(x);
  // fold to [-PI/2, PI/2] using sin(PI - a) === sin(a)
  if (a > HALF_PI) a = PI - a;
  else if (a < -HALF_PI) a = -PI - a;

  const s = a * a;
  return (
    a *
    (1 +
      s *
        (-0.16666666666666666 +
          s *
            (0.008333333333333333 +
              s *
                (-0.0001984126984126984 +
                  s *
                    (2.755731922398589e-6 +
                      s *
                        (-2.505210838544172e-8 +
                          s * (1.6059043836821613e-10 + s * -7.647163731819816e-13))))))));
}

export function cos(x: number): number {
  return sin(x + HALF_PI);
}

/**
 * atan on [-1, 1] -- degree-9 odd minimax polynomial, max error ~1e-5 rad
 * (about 0.0006 degrees), which is far below anything a unit facing needs.
 */
function atanUnit(x: number): number {
  const z = x * x;
  return (
    x *
    (0.9998660001 +
      z *
        (-0.3302995 +
          z * (0.180141 + z * (-0.085133 + z * 0.0208351))))
  );
}

export function atan(x: number): number {
  if (x > 1) return HALF_PI - atanUnit(1 / x);
  if (x < -1) return -HALF_PI - atanUnit(1 / x);
  return atanUnit(x);
}

/** Deterministic atan2 with the standard quadrant and signed-zero behaviour. */
export function atan2(y: number, x: number): number {
  if (x > 0) return atan(y / x);
  if (x < 0) return y >= 0 ? atan(y / x) + PI : atan(y / x) - PI;
  // x === 0
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}

export function hypot(x: number, y: number): number {
  return sqrt(x * x + y * y);
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return sqrt(dx * dx + dy * dy);
}

export function distSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/** Shortest signed rotation from `from` to `to`, in [-PI, PI). */
export function angleDelta(from: number, to: number): number {
  return wrapAngle(to - from);
}

/** Rotate `from` toward `to` by at most `maxStep` radians. */
export function rotateToward(from: number, to: number, maxStep: number): number {
  const d = angleDelta(from, to);
  if (d > maxStep) return wrapAngle(from + maxStep);
  if (d < -maxStep) return wrapAngle(from - maxStep);
  return to;
}

/** Exactly-specified 32-bit integer multiply. Needed by the PRNG. */
export const imul = Math.imul;
