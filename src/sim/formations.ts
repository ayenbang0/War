/**
 * Formation slot layouts.
 *
 * A formation is a set of positions in the squad's LOCAL frame, where +x points
 * forward along the squad's facing and +y points to its right. The squad's
 * anchor and facing turn those into world positions every tick, which is what
 * lets a formation rotate and translate as one coherent shape (spec section 4.1).
 *
 * Layouts are pure functions of (shape, count): no state, no randomness, so the
 * same squad always produces the same slots and a re-form is never a reshuffle.
 */

import { ceil, sqrt, floor } from "./math.ts";

export type FormationShape = "line" | "column" | "wedge" | "square" | "loose" | "tight";

export const FORMATION_SHAPES: readonly FormationShape[] = [
  "line", "column", "wedge", "square", "loose", "tight",
];

/** Nominal gap between neighbouring soldiers, in world units. */
export const BASE_SPACING = 13;

/** Rank depth relative to file width. Ranks sit closer than files look wide. */
const RANK_SCALE = 0.82;

type Layout = { readonly files: number; readonly spacing: number; readonly kind: number };

const KIND_GRID = 0;
const KIND_WEDGE = 1;

/**
 * Frontage and spacing per shape. loose and tight are line variants at
 * different spacing -- they are not reachable from a drawn glyph (stroke extent
 * already carries meaning in the gesture table) and exist for doctrines and
 * content presets.
 */
function layoutFor(shape: FormationShape, count: number): Layout {
  switch (shape) {
    case "line":
      return { files: ceil(count / 2), spacing: BASE_SPACING, kind: KIND_GRID };
    case "loose":
      return { files: ceil(count / 2), spacing: BASE_SPACING * 1.75, kind: KIND_GRID };
    case "tight":
      return { files: ceil(count / 3), spacing: BASE_SPACING * 0.72, kind: KIND_GRID };
    case "column":
      return { files: 2, spacing: BASE_SPACING, kind: KIND_GRID };
    case "square": {
      const side = ceil(sqrt(count));
      return { files: side, spacing: BASE_SPACING, kind: KIND_GRID };
    }
    case "wedge":
      return { files: 0, spacing: BASE_SPACING, kind: KIND_WEDGE };
  }
}

/**
 * Write count local-space slots into out as [dx0, dy0, dx1, dy1, ...].
 * out must have room for count * 2 entries.
 */
export function formationSlots(shape: FormationShape, count: number, out: Float64Array): void {
  if (count <= 0) return;
  const layout = layoutFor(shape, count);

  if (layout.kind === KIND_WEDGE) {
    wedgeSlots(count, layout.spacing, out);
    return;
  }

  const files = layout.files < 1 ? 1 : layout.files;
  const spacing = layout.spacing;
  const ranks = ceil(count / files);
  for (let i = 0; i < count; i++) {
    const rank = floor(i / files);
    const file = i - rank * files;
    // The final rank is usually short; centre it under the ones above.
    const inThisRank = rank === ranks - 1 ? count - rank * files : files;
    out[i * 2] = -rank * spacing * RANK_SCALE;
    out[i * 2 + 1] = (file - (inThisRank - 1) / 2) * spacing;
  }
  recentre(count, out);
}

/**
 * Shift the layout so the anchor sits on its true centre of mass.
 *
 * Done by measurement rather than by construction on purpose: a short final
 * rank, or a wedge with an unpaired arm, leaves the block lopsided in ways that
 * are fiddly to predict per shape. If the anchor is not the centroid, the squad
 * pivots about a point off to one side and the whole formation swings wide
 * every time it turns.
 */
function recentre(count: number, out: Float64Array): void {
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < count; i++) {
    sx += out[i * 2];
    sy += out[i * 2 + 1];
  }
  const cx = sx / count;
  const cy = sy / count;
  for (let i = 0; i < count; i++) {
    out[i * 2] -= cx;
    out[i * 2 + 1] -= cy;
  }
}

/** A V with its point forward: the classic shock formation. */
function wedgeSlots(count: number, spacing: number, out: Float64Array): void {
  out[0] = 0;
  out[1] = 0;
  let i = 1;
  let arm = 1;
  while (i < count) {
    const dx = -arm * spacing * 0.75;
    const dy = arm * spacing * 0.62;
    out[i * 2] = dx;
    out[i * 2 + 1] = dy;
    i++;
    if (i < count) {
      out[i * 2] = dx;
      out[i * 2 + 1] = -dy;
      i++;
    }
    arm++;
  }
  recentre(count, out);
}

/** Radius of the smallest circle containing every slot. Used for hit-testing. */
export function formationRadius(slots: Float64Array, count: number): number {
  let worst = 0;
  for (let i = 0; i < count; i++) {
    const dx = slots[i * 2];
    const dy = slots[i * 2 + 1];
    const d = dx * dx + dy * dy;
    if (d > worst) worst = d;
  }
  return sqrt(worst);
}
