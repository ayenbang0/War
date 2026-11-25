/**
 * Every word the kingdom map (K2) shows, in one table (PLAN.md §C.4, docs/
 * PROVISIONAL.md C.7.3: English only, but kept where a translation could
 * replace it). Text with values in it is a template function with named
 * parameters, never concatenated in the UI code, so a translation can put the
 * values where its grammar wants them.
 *
 * Plain data and pure formatting; no DOM.
 */

import type { HoldingKind, Season, WeatherId } from "./terrain.ts";

/** Why a pen stroke on the kingdom map did nothing. Every reason is said. */
export type KingdomNoneReason =
  | "nothing-there"
  | "closed-shape"
  | "not-from-king"
  | "no-destination"
  | "already-there"
  | "no-road";

export const NONE_REASON: Record<KingdomNoneReason, string> = {
  "nothing-there": "Nothing there to read about.",
  "closed-shape": "Rings and hearts are orders for armies, which come later. To march, draw a line from the king to a holding.",
  "not-from-king": "That line means nothing: start it on the king's counter.",
  "no-destination": "That line means nothing: end it on a holding.",
  "already-there": "The king is already there.",
  "no-road": "No road leads there.",
};

/** The short form shown on the ghost plate at the pen tip. */
export const NONE_PLATE: Record<KingdomNoneReason, string> = {
  "nothing-there": "nothing here",
  "closed-shape": "no order: rings come with armies",
  "not-from-king": "no order: start on the king",
  "no-destination": "no order: end on a holding",
  "already-there": "no order: already there",
  "no-road": "no order: no road leads there",
};

export const SEASON_NAME: Record<Season, string> = {
  spring: "Spring", summer: "Summer", autumn: "Autumn", winter: "Winter",
};

/** What the weather does, in words, for the date line. */
export const WEATHER_LINE: Record<WeatherId, string> = {
  clear: "clear, good marching",
  fog: "fog, marching a little slower",
  rain: "rain, marching slower",
  storm: "storm, marching much slower",
  snow: "snow, marching slowest",
};

export const KIND_NAME: Record<HoldingKind, string> = {
  hamlet: "Hamlet", village: "Village", town: "Town", keep: "Keep", city: "City",
};

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return n + "th";
  switch (n % 10) {
    case 1: return n + "st";
    case 2: return n + "nd";
    case 3: return n + "rd";
    default: return n + "th";
  }
}

/** "Day 3 · 4th of Autumn, year 1" -- day counts from 1 for the player. */
export function dateLine(p: { day: number; dayOfSeason: number; season: Season; year: number }): string {
  return "Day " + (p.day + 1) + " · " + ordinal(p.dayOfSeason + 1) + " of " + SEASON_NAME[p.season] + ", year " + p.year;
}

/**
 * A journey's length in words, from kingdom ticks (three hours each): hours
 * under a day, then days to the nearest half. Always "about": the weather
 * changes daily and the estimate uses today's.
 */
export function etaWords(ticks: number, ticksPerDay: number): string {
  if (ticks <= 0) return "here now";
  const hours = (ticks * 24) / ticksPerDay;
  if (hours < 24) return "about " + Math.round(hours) + " hours";
  const halves = Math.round((ticks / ticksPerDay) * 2);
  const whole = Math.floor(halves / 2);
  const half = halves % 2 === 1;
  if (whole === 1 && !half) return "about 1 day";
  return "about " + whole + (half ? "½" : "") + " days";
}

export const K = {
  title: "The Exile of Rimaros",
  storesNone: "No stores yet: the king has no coin, grain or followers.",
  speedGroup: "Game speed",
  pause: "Pause",
  speeds: ["1×", "2×", "4×"] as const,
  frontScreen: "Front screen",
  paused: "PAUSED — space to resume, . to step a day",
  pauseFirst: "Pause first (space), then . steps a day.",
  steppedDay: "One day passes.",
  keyHint: "space pause · . step a day · 1 2 3 speed · W A S D / arrows pan · - = zoom · F find the king · Esc close / back",
  canvasLabel: "The map of Rimaros. Draw a line from the king's counter to a holding to march; tap a holding or the king to read about it.",
  close: "Close",
  closeHint: "Esc closes",
  halt: "Halt the march",
  haltDone: "The king's party halts where it stands.",
  // Card fields.
  province: "Province",
  held: "Held by",
  unclaimed: "unclaimed",
  country: "Country",
  people: "People",
  slots: "Slots",
  roads: "Roads",
  seat: "Seat of the province",
  fromKing: "From the king",
  kingHere: "The king is here.",
  kingWhere: "Where",
  kingGoing: "Marching",
  kingStill: "Standing still. Draw a line from the king to a holding to march.",
  with: "Travelling with",
  weather: "Weather",
  // Save.
  notSaved: (detail: string) => "This realm is not being saved (" + detail + "). It lives only until the tab is closed.",
  savedAgain: "The realm is being saved again.",
  unreadableTitle: "The saved realm cannot be read",
  unreadableBody: (detail: string) =>
    "The save in this browser is damaged (" + detail + "). Begin a new exile in its place? The damaged save is replaced.",
  unreadableYes: "Begin a new exile",
  unreadableNo: "Keep it and go back",
  newTitle: "Begin a new exile?",
  newBody: "The realm you have now is lost: the king starts again at Cold Hearth with nothing.",
  newYes: "Begin anew",
  newNo: "Keep my realm",
  homeButton: "The Exile of Rimaros",
  homeNew: "Begin a new exile",
  homeContinue: (when: string) => "Continue: " + when,
  homeFresh: "You are the fallen king, exiled to the farthest reach. Claim it back.",
  homeUnreadable: "The realm saved in this browser cannot be read. You will be asked before anything replaces it.",
  slotsLine: (p: { garrison: number; buildings: number; fields: number }) =>
    p.garrison + " garrison, " + p.buildings + " building, " + p.fields + " field",
  kindOwner: (p: { kind: string; owner: string }) => p.kind + " · " + p.owner,
  roadTo: (p: { name: string; surface: string }) => p.name + " (" + p.surface + ")",
  onRoad: (p: { surface: string; from: string; to: string; miles: number }) =>
    "On the " + p.surface + " from " + p.from + " to " + p.to + ", " + p.miles + " miles along",
  atHolding: (name: string) => "At " + name,
  marchingTo: (p: { name: string; eta: string }) => p.name + ", " + p.eta,
  marchPlate: (p: { name: string; eta: string }) => "March to " + p.name + " · " + p.eta,
  setOut: (p: { name: string; eta: string }) => "The king sets out for " + p.name + ": " + p.eta + " by road.",
  queuedOut: (p: { name: string; eta: string }) => "Ordered: the king sets out for " + p.name + " (" + p.eta + ") when the clock runs.",
  departed: (p: { from: string; to: string }) => "The king leaves " + p.from + " for " + p.to + ".",
  arrived: (name: string) => "The king reaches " + name + ".",
  passed: (name: string) => "The king passes through " + name + ".",
  rejected: (reason: string) => "Order refused: " + reason + ".",
  weatherTurned: (w: string) => "The weather turns: " + w + ".",
  begun: "The exile begins at Cold Hearth: the king, Brother Aldous, and nothing else.",
  resumed: (when: string) => "The chronicle resumes: " + when + ".",
} as const;
