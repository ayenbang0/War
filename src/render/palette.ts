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
