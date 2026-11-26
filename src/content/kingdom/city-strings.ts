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
  // ECON: no weather harms a crop any more; only an army's foraging does, and it says so.
  healthLine: (pct: number) => pct === 100 ? "whole" : pct + "% of the crop left after an army foraged here",
  crop: "Crop",
  stage: "Stage",
  nothingSown: "nothing sown",
  // ECON (owner: "the fields should be auto harvested and the king can automatically make them sowed").
  reaped: "Harvest",
  reapedAuto: "reaped by itself the day it ripens, into the granary",
  resows: "Resows",
  resowsOff: "no: sow it by hand",
  resowsCrop: (crop: string) => crop + ", by itself in its season",
  resowButton: "Resow automatically…",
  resowTitle: (p: { field: string; name: string }) => "Resow " + p.field + " at " + p.name + " automatically",
  resowIntro: "The field is sown again by itself, paying the seed from the stores, each time it lies open in the crop's season and the crop can ripen before the winter. It is always reaped by itself.",
  resowOff: "Off",
  resowOffLine: "Sow this field by hand.",
  resowSet: (crop: string) => "This field will resow " + crop.toLowerCase() + " by itself.",
  resowUnset: "This field will be sown by hand.",
  ripe: "Ripe",
  ripeOn: (p: { when: string; days: number }) => "about " + p.when + " (" + days(p.days) + ")",
  ripeNever: "not before the winter kills it",
  lostTo: "Last lost",
  // What a field set to resow itself is waiting for (economy.ts autoSowWaits).
  waits: {
    off: "",
    standing: "the orchard stands and fruits again by itself",
    inUse: "",
    season: (p: { crop: string; when: string }) => "waiting for " + p.when + " to sow " + p.crop.toLowerCase(),
    late: (p: { crop: string; when: string }) => "too late this year for " + p.crop.toLowerCase() + ": sown again " + p.when,
    seed: (p: { seed: string }) => "waiting for seed: needs " + p.seed + " in the stores",
  },
  // The city panel's switch for the whole realm.
  resowAll: "Resow all fields automatically",
  resowAllOn: (crop: string) => "On: every field resows " + crop.toLowerCase() + " in its season",
  resowAllOff: "Off: fields are sown by hand",
  resowAllAria: (on: boolean) => "Resow all fields automatically: " + (on ? "on" : "off"),
  resowAllSaid: (on: boolean) => on ? "Every field of the realm will resow itself." : "Fields will be sown by hand.",
  realmStores: (p: { grain: number; capacity: number }) => "The realm's stores: " + p.grain + " grain of " + p.capacity,
  granaryLot: (p: { inGranary: number; granary: number; grain: number; capacity: number }) =>
    "The realm's granaries hold " + p.inGranary + " of " + p.granary + " grain, none of it spoiling; all the realm's stores, " +
    p.grain + " of " + p.capacity + ", are the king's to draw on wherever the army or the towns eat.",

  // -- politics -------------------------------------------------------------
  politicsTitle: (name: string) => "Politics at " + name,
  people: "People",
  loyalty: "Loyalty and unrest",
  lords: "Local lords",
  // An honest placeholder: the lords' rules are K8's (PLAN §B.7).
  lordsNotYet: "none sworn to you here yet",
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
