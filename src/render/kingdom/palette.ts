/**
 * The kingdom map's palette. The base ink and parchment are the battle's own
 * (render/palette.ts), so the two layers read as one table; everything here is
 * what the strategic map adds.
 *
 * Identity is never colour alone (U1-01): the battle's blue and red are 1.15:1
 * in luminance, identical in greyscale. Owner is therefore coded by FILL --
 * hollow for unclaimed ground, solid with a crown tick for the king's, hatched
 * for ground sworn to the crown that exiled him -- and the colours below only
 * add to that. The province washes are decoration; a province is named in
 * words on the map and on the card.
 *
 * Contrast (WCAG relative luminance, checked for U1): ink on parchment 7.50:1,
 * the king's blue on parchment 4.11:1 (a key visual, ≥ 3:1), crown red on
 * parchment 4.74:1.
 */

import { ink, parchment, playerColor } from "../palette.ts";

export { ink, parchment };

/** The table around the map sheet: darker, so the map's edge reads. */
export const table = "#b9a880";
/** The map sheet itself. */
export const sheet = "#e2d6bb";
/** Under every label and line: a light halo, so ink stays ≥ 4.5:1 over any wash. */
export const halo = "rgba(242, 234, 214, 0.92)";
export const inkStrong = "rgba(63, 53, 39, 0.92)";
export const inkMid = "rgba(63, 53, 39, 0.62)";
export const inkLight = "rgba(63, 53, 39, 0.35)";

/** The king's side. */
export const kingColor = playerColor[0];
/** Ground sworn to the crown (the usurper and every captain). */
export const crownColor = playerColor[1];

/** A march being drawn or ordered. */
export const marchInk = "#2e4a6d";
/** A stroke that means nothing: grey, not red -- it is not an error, just no order. */
export const noneInk = "rgba(95, 81, 56, 0.75)";
/** The ghost's label plate. */
export const plate = "rgba(242, 234, 214, 0.96)";
export const plateEdge = "rgba(63, 53, 39, 0.55)";

/** Province washes: low-alpha tints so neighbouring provinces part visibly. */
export const PROVINCE_WASH: Record<string, string> = {
  "farthest-reach": "rgba(132, 150, 168, 0.26)",
  "vale-of-the-hare": "rgba(168, 176, 102, 0.24)",
  "long-wood": "rgba(96, 132, 86, 0.28)",
  "lisle-bridges": "rgba(110, 150, 170, 0.24)",
  "hallow-ferry": "rgba(120, 156, 160, 0.24)",
  "crown-seat": "rgba(176, 140, 96, 0.28)",
  "open-fields": "rgba(196, 176, 96, 0.24)",
  "stag-wolf": "rgba(140, 124, 110, 0.26)",
  "red-march": "rgba(168, 96, 80, 0.22)",
  "crows-reach": "rgba(110, 120, 140, 0.24)",
};

/** One font stack for the map and its panels: a book face, as a map table would be lettered. */
export const MAP_FONT = '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif';
