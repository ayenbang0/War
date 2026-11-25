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
  10: "#857a6a", // wall: dressed stone, darker and colder than any ground
  11: "#7d6143", // gate: oak and iron, warm against the stone either side
  12: "#9a7c55", // palisade: raw timber
  13: "#c4b69a", // rubble: broken stone spilt over the plain, passable
  14: "#cfc29f", // clearing: stumps and ash where a wood was
};

// -- palette roles (audit RF-01, RF-02) -----------------------------------------
//
// Every overlay is coloured by ROLE, never by a raw hex picked on the spot:
// friend and foe are relative to whoever is looking (the viewer), so the
// player's own men, orders, fields, workings, halos and held ground are always
// the friend colour, whichever seat they took. Before this, counters used the
// absolute player colour while halos hard-coded "own = blue", the shield field
// was always player-0 blue whoever raised it, healing was green for either
// side, and enemy magic was a purple of its own.
//
// The two sides are also pulled apart in LIGHTNESS (friend dark, foe lighter),
// and the foe counter carries a pale keyline the friend one never has, so the
// armies differ in greyscale and for low vision -- colour is the third channel,
// not the only one. docs/ui-policy.md, "Identity".

/** Which side a player is on, as the viewer sees it. */
export type Side = "friend" | "foe";

export function sideOf(player: number, viewer: number): Side {
  return player === viewer ? "friend" : "foe";
}

/** Base colour per side, as [r, g, b]. */
const SIDE_RGB: Record<Side, [number, number, number]> = {
  friend: [48, 80, 124],
  foe: [170, 72, 56],
};

/** The pale keyline every foe counter is wrapped in, and nothing friendly is. */
export const foeKeyline = "rgba(247, 241, 226, 0.95)";

/** A side's colour as a CSS string, optionally translucent. */
export function sideColor(side: Side, alpha = 1): string {
  return rgb(SIDE_RGB[side], alpha);
}

/** Shorthand: the colour of a player's things, as the viewer sees them. */
export function colorFor(player: number, viewer: number, alpha = 1): string {
  return sideColor(sideOf(player, viewer), alpha);
}

/**
 * Status colours, kept off both side hues so a status is never mistaken for a
 * side: recovery is violet (and dashed where it is a ring), a sworn last stand
 * is a heavy dark ink, terror a deep plum.
 */
export const statusColor = {
  recover: "#6a4c93",
  lastStand: "#2f2418",
  terror: "#5d2f6e",
  /** A company whose nerve has gone: drawn as a struck pennant. */
  broken: "#f4ecd8",
} as const;

/**
 * Player colours by seat, kept for the few callers that have no viewer (the
 * menu's unit icons are always drawn as the player's own). Seat 0 is the
 * friend colour, seat 1 the foe colour.
 */
export const playerColor: Record<number, string> = {
  0: sideColor("friend"),
  1: sideColor("foe"),
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

/** Counter base by colour seat: 0 is the friend colour, 1 the foe colour. */
const BASE: Record<number, [number, number, number]> = {
  0: SIDE_RGB.friend,
  1: SIDE_RGB.foe,
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

/**
 * Body fill for one unit type. `seat` picks the colour: 0 the friend colour, 1
 * the foe colour -- pass `player === viewer ? 0 : 1` from the battlefield.
 */
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
