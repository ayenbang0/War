/**
 * Map-table wargame palette: parchment ground, muted terrain washes, ink lines.
 * Everything is procedurally drawn -- there are no sprite assets in this project.
 */

export const ink = "#3f3527";
export const inkSoft = "rgba(63, 53, 39, 0.28)";
export const inkFaint = "rgba(63, 53, 39, 0.12)";
export const parchment = "#d9cbb0";

export const terrainFill: Record<number, string> = {
  0: "#dccfb0", // plain
  1: "#8ea471", // forest
  2: "#c8b184", // hill
  3: "#8ba7bb", // water
  4: "#a98a5e", // bridge
  5: "#8f8375", // fortification
  6: "#7d7469", // mountain: cold bare rock, clearly not walkable
  7: "#8f9a72", // marsh: sickly green, close to the plain it deceives you into
  8: "#c9ae82", // road: a pale beaten track
  9: "#b4a893", // scree: grey-brown broken ground skirting the peaks
};

/** Player colours, chosen to stay distinguishable against parchment. */
export const playerColor: Record<number, string> = {
  0: "#3b5f8a", // blue
  1: "#8c3a34", // red
};

export const playerColorSoft: Record<number, string> = {
  0: "rgba(59, 95, 138, 0.22)",
  1: "rgba(140, 58, 52, 0.22)",
};

// -- unit counters -------------------------------------------------------------

/**
 * Per-type tone, as a mix away from the player's base colour.
 *
 * Negative sinks toward a shared deep ink, positive lifts toward parchment
 * light. This is the visual hierarchy: the heavy foot that anchors a line is
 * the darkest, most solid thing on the field, and a scout is the palest and
 * least substantial. Because the renderer already batches by (player, type),
 * varying the fill per type costs nothing at all.
 *
 * Everything mixes toward TWO shared endpoints rather than to black and white,
 * which is what keeps sixteen counters reading as one family instead of
 * sixteen unrelated swatches.
 */
const TONE: Record<string, number> = {
  guard: -0.20,
  siege: -0.14,
  line: -0.07,
  horse: 0.00,
  archer: 0.09,
  mage: 0.15,
  skirmisher: 0.17,
  scout: 0.26,
  builder: -0.10,
  healer: 0.21,
  pike: -0.04,
  crossbow: 0.05,
  lancer: -0.12,
  slinger: 0.2,
  champion: -0.24,
  banner: -0.02,
  drummer: 0.18,
  hounds: 0.12,
  oathsworn: -0.16,
  wagon: -0.18,
};

/** Shared dark endpoint: an ink, not black, so shadows stay in the family. */
const DEEP: [number, number, number] = [34, 28, 21];
/** Shared light endpoint: warm parchment light, never pure white. */
const LIFT: [number, number, number] = [242, 233, 212];

const BASE: Record<number, [number, number, number]> = {
  0: [59, 95, 138],
  1: [140, 58, 52],
};

function mix(a: readonly number[], b: readonly number[], t: number): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function rgb(c: readonly number[], alpha = 1): string {
  return alpha >= 1
    ? "rgb(" + c[0] + ", " + c[1] + ", " + c[2] + ")"
    : "rgba(" + c[0] + ", " + c[1] + ", " + c[2] + ", " + alpha + ")";
}

function toneOf(type: string): number {
  return TONE[type] ?? 0;
}

/** Body fill for one unit type of one army. */
export function unitFill(player: number, type: string): string {
  const base = BASE[player] ?? BASE[0];
  const t = toneOf(type);
  return rgb(t < 0 ? mix(base, DEEP, -t) : mix(base, LIFT, t));
}

/**
 * Outline for that same counter: the body colour driven well down toward the
 * shared ink. A single flat outline colour for every type made the pale units
 * look outlined-in-black and the dark ones look untidy; deriving it keeps the
 * edge in the same family as the fill it wraps.
 */
export function unitEdge(player: number, type: string): string {
  const base = BASE[player] ?? BASE[0];
  const t = toneOf(type);
  const body = t < 0 ? mix(base, DEEP, -t) : mix(base, LIFT, t);
  return rgb(mix(body, DEEP, 0.62), 0.85);
}

/** Soft top-light laid inside the silhouette. Warm, never white. */
export const unitSheen = "rgba(247, 240, 223, 0.20)";
/** Contact shadow under a counter, which is what lifts it off the ground. */
export const unitShadow = "rgba(52, 43, 30, 0.20)";
