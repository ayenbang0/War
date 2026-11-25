/**
 * Every word the city view (K3b) shows: the city panel, the lot, field and
 * politics cards, the region card's summary, and the result lines of the pen
 * in a town. As ui-strings.ts is for the map and the economy (PLAN.md §C.4,
 * docs/PROVISIONAL.md C.7.3): English only, but kept in one table, and every
 * line with a value in it is a template with named parameters.
 *
 * Plain data and pure formatting; no DOM.
 */

import type { HoldingKind } from "./terrain.ts";

function days(n: number): string {
  return n + (n === 1 ? " day" : " days");
}

export const KIND_PLACE: Record<HoldingKind, string> = {
  hamlet: "hamlet", village: "village", town: "town", keep: "keep", city: "city",
};

export const C = {
  // -- entering and leaving -------------------------------------------------
  enter: "Enter the city",
  enterAria: (name: string) => "Enter " + name + ", the city view",
  leave: "Leave the city",
  entered: (name: string) => "You ride into " + name + ". Esc, or zoom out, to return to the map.",
  left: (name: string) => "Back on the map, over " + name + ".",
  notYours: (name: string) => name + " is not yours: only your own holdings can be entered.",
  lost: (name: string) => name + " is no longer yours; you are back on the map.",
  canvasLabel: (name: string) => "The town plan of " + name + ". Tap a lot or a field; the list beside it does the same.",

  // -- the panel ------------------------------------------------------------
  panelLabel: "The city",
  sub: (p: { kind: string; province: string; people: number }) =>
    capital(p.kind) + " · " + p.province + " · " + p.people + (p.people === 1 ? " soul" : " people"),
  politics: "Politics",
  lots: "Lots",
  fields: "Fields",
  lotButton: (p: { n: number; what: string }) => "Lot " + p.n + ": " + p.what,
  fieldButton: (p: { n: number; what: string }) => "Field " + p.n + ": " + p.what,
  keyHint: "Tap a lot or a field · P politics · F the whole town · Esc leaves · space pause · . step · 1 2 3 speed",

  // -- lots -----------------------------------------------------------------
  lotTitle: (n: number) => "Lot " + n,
  lotNext: "open, next to build",
  lotLater: "open ground, not yet staked",
  lotWorks: (p: { name: string; left: number }) => p.name + ", being built (" + days(p.left) + " left)",
  lotIdle: (name: string) => name + ", idle",
  lotStanding: (name: string) => name,
  lotCardNext: "The builders take this lot next.",
  lotCardLater: (next: number) =>
    "Not yet staked: the town builds outward from the square, so the next building goes on lot " + next + ".",
  lotCardFull: "Every lot here is built on.",
  buildHere: "Build…",
  buildOn: (n: number) => "Build on lot " + n + "…",
  state: "State",
  stateWorks: (p: { left: number; total: number }) => "being built: " + days(p.left) + " left of " + p.total,
  stateStanding: "standing",
  stateIdle: "idle: its upkeep went unpaid today, so it does nothing",
  upkeep: "Upkeep",
  upkeepNone: "none",
  upkeepLine: (s: string) => s + " a day",
  upgrade: (name: string) => "A " + name.toLowerCase() + " can be built over it.",
  enclosure: "It rings the town: you can see it on the plan.",
  buildMenuFor: (n: number) => "It goes on lot " + n + ".",

  // -- fields ---------------------------------------------------------------
  fieldTitle: (n: number) => "Field " + n,
  health: "Health",
  healthLine: (pct: number) => pct + "% of the crop left after the weather",
  crop: "Crop",
  stage: "Stage",
  nothingSown: "nothing sown",

  // -- politics -------------------------------------------------------------
  politicsTitle: (name: string) => "Politics at " + name,
  people: "People",
  loyalty: "Loyalty and unrest",
  lords: "Local lords",
  laws: "Laws",
  // Honest placeholders: these rules do not exist yet (PLAN §B.6, K6).
  loyaltyNotYet: "not yet reckoned: the realm keeps no account of it until the lords' rules are written (K6)",
  lordsNotYet: "none sworn to you here yet",
  lawsNotYet: "none proclaimed yet",
  famineSummary: (d: number) => "Famine: " + days(d) + " short of bread",

  // -- the region card's summary ---------------------------------------------
  summaryTax: (p: { rate: string; coin: string }) => p.rate + ": " + p.coin + " a day",
  summaryLots: (p: { built: string; used: number; total: number }) =>
    (p.built || "nothing built") + " (" + p.used + " of " + p.total + " lots used)",
  summaryFields: (lines: readonly string[]) => lines.join("; "),
  lotsRow: "Lots",
  fieldsRow: "Fields",
  taxRow: "Tax",

  // -- the pen in the city ---------------------------------------------------
  tapNothing: "Nothing there: tap a lot, a field or the square.",
  lineInCity: "In a town the pen taps: a lot to build, a field to sow, the square for politics. Marches are drawn on the map.",
  framed: "The whole town.",
} as const;

function capital(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
