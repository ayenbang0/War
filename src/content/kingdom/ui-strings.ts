/**
 * Every word the kingdom map (K2) shows, in one table (PLAN.md §C.4, docs/
 * PROVISIONAL.md C.7.3: English only, but kept where a translation could
 * replace it). Text with values in it is a template function with named
 * parameters, never concatenated in the UI code, so a translation can put the
 * values where its grammar wants them.
 *
 * Plain data and pure formatting; no DOM.
 */

import { MONTHS, type HoldingKind, type Season, type WeatherId } from "./terrain.ts";

/** Why a pen stroke on the kingdom map did nothing. Every reason is said. */
export type KingdomNoneReason =
  | "nothing-there"
  | "closed-no-army"
  | "closed-many-armies"
  | "not-from-king"
  | "no-destination"
  | "already-there"
  | "no-road";

export const NONE_REASON: Record<KingdomNoneReason, string> = {
  "nothing-there": "Nothing there to read about.",
  "closed-no-army": "Rings and hearts are orders for an army: start the ring on an army's counter, or draw it round one.",
  "closed-many-armies": "That ring holds more than one army: start it on the counter of the army you mean.",
  "not-from-king": "That line means nothing: start it on the king's or an army's counter, or draw it across an army to split it.",
  "no-destination": "That line means nothing: end it on a holding.",
  "already-there": "The king is already there.",
  "no-road": "No road leads there.",
};

/** The short form shown on the ghost plate at the pen tip. */
export const NONE_PLATE: Record<KingdomNoneReason, string> = {
  "nothing-there": "nothing here",
  "closed-no-army": "no order: ring an army",
  "closed-many-armies": "no order: which army?",
  "not-from-king": "no order: start on a counter",
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

/**
 * ECON: "14 Harvestmoon, Year 2 · Autumn" -- the day of the month counts from
 * 1 for the player, the month by its name (terrain.ts MONTHS), and the
 * season after it because the farms run by the season.
 */
export function dateLine(p: { month: number; dayOfMonth: number; season: Season; year: number }): string {
  return (p.dayOfMonth + 1) + " " + MONTHS[p.month].name + ", Year " + p.year + " · " + SEASON_NAME[p.season];
}

/** The date's long form, for the HUD's tooltip: "Day 3 of the exile; the 1st month of autumn". */
export function dateTitle(p: { day: number; month: number; season: Season }): string {
  const nth = (p.month % 3) + 1;
  return "Day " + (p.day + 1) + " of the exile; the " + ordinal(nth) + " month of " + SEASON_NAME[p.season].toLowerCase() + " (twelve months to the year)";
}

/** "3 Thawmoon" -- a day of the year by month, for warnings and the field card ("ripe about 9 Reapmoon"). */
export function monthDay(dayOfYear: number): string {
  const m = Math.floor(dayOfYear / 30) % 12;
  return (dayOfYear - Math.floor(dayOfYear / 30) * 30 + 1) + " " + MONTHS[m].name;
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
  speedGroup: "Game speed",
  pause: "Pause",
  speeds: ["1×", "2×", "4×", "8×"] as const,
  frontScreen: "Front screen",
  paused: "PAUSED — space to resume, . to step a day",
  pauseFirst: "Pause first (space), then . steps a day.",
  steppedDay: "One day passes.",
  keysTab: "Keys",
  keyHint: "space pause · . step a day · 1 2 3 4 speed · W A S D / arrows pan · - = zoom · F find the king · Esc close / back",
  canvasLabel: "The map of Rimaros. Draw a line from the king's counter to a holding to march; tap a holding or the king to read about it.",
  close: "Close",
  closeHint: "Esc closes",
  halt: "Halt the march",
  haltDone: "The king's party halts where it stands.",
  // Card fields.
  province: "Province",
  held: "Held by",
  // K10
  wallsNone: "none",
  wallsLine: (p: { kind: string; state: string }) => p.kind + ", " + p.state,
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
  homeDifficulty: "Difficulty for a new exile (a game under way keeps its own):",
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

// -- K3: the economy --------------------------------------------------------------

/**
 * Why the sim refuses an economy order. The sim's own checker
 * (src/sim/kingdom/economy.ts checkEconomyOrder) returns these, and the panels
 * show the same words beside a button that is not on offer, so the reason the
 * player reads is the reason the sim acts on.
 */
export const REFUSAL = {
  noSuchFaction: "no such faction",
  onlyKing: "only the king's party can do that",
  onTheRoad: "the party is out on the road; it can only do that at a holding",
  marching: "the party is marching; halt or arrive first",
  alreadyForaging: "the party is already foraging",
  alreadyRallying: "the party is already rallying",
  rallyOwned: "followers are rallied only at unclaimed hamlets",
  rallyNotHamlet: "followers are rallied only at hamlets",
  rallySpent: "no one else here will leave home for an exile",
  noSuchHolding: "there is no such holding",
  alreadyYours: "it is already the king's",
  heldByOther: "it is held by another, and taking it means a fight",
  garrisoned: "it has a garrison",
  claimFromThere: "the king must be there to claim it",
  claimNeedsFollowers: (n: number) => "a holding needs hands: the king needs " + n + " followers to claim it",
  noSuchRate: "there is no such tax rate",
  notYours: "it is not the king's",
  noSuchBuilding: "there is no such building",
  wrongCountry: "it cannot be built in this country",
  alreadyBuilt: "there is one here already",
  needsFirst: (name: string) => "it is built over a " + name.toLowerCase() + ", and there is none standing here",
  noSlot: "every building slot here is taken",
  cannotAfford: "the stores cannot pay for it",
  /** K11 (audit U2-05): the stores would pay, but orders waiting on the clock have them spoken for. */
  promised: "the stores are already promised to orders waiting on the clock",
  noSuchPlot: "there is no such field",
  noSuchCrop: "there is no such crop",
  orchardStands: "the orchard will fruit again next year; it needs no sowing",
  plotInUse: "the field is already sown",
  wrongSeason: (crop: string) => crop + " cannot be sown in this season",
  tooLate: (crop: string) => "too late in the year for " + crop.toLowerCase() + ": the winter would kill it before it ripens",
  notRipe: "it is not ripe",
  // K10: mending walls.
  noWalls: "there are no walls here to mend",
  wallsWhole: "the walls are whole",
  wallsMending: "the masons are already paid for all the damage",
} as const;

/** Stocks, as the resources bar and the panels name them. */
export const STOCK_NAME = {
  coin: "Coin", grain: "Grain", timber: "Timber", iron: "Iron", levy: "Followers", legitimacy: "Legitimacy",
} as const;

/** What each stock is, for the bar's tooltip and its accessible name. */
export const STOCK_ABOUT = {
  coin: "pennies, from taxes and trade; pays for building",
  grain: "days of bread for one person; everyone eats",
  timber: "cartloads, from foraging and woodcutters; for building",
  iron: "bars from a forge; for arms and stone works",
  levy: "people following the king's banner; they eat, carry and forage",
  legitimacy: "how far the realm believes the king is its king",
} as const;

export const TAX_NAME = { none: "None", low: "Low", normal: "Normal", high: "High", harsh: "Harsh" } as const;

export const STAGE_NAME = {
  empty: "lying fallow", sown: "sown", growing: "growing", ripe: "ripe", harvested: "harvested", spoiled: "spoiled",
} as const;

export const TASK_NAME = { none: "resting", forage: "foraging", rally: "rallying followers" } as const;

function signed(n: number): string {
  return n > 0 ? "+" + n : n < 0 ? "−" + -n : "±0";
}

/** Every word of the economy UI (K3), as K is for the map (K2). */
export const E = {
  resourcesGroup: "The king's stores",
  sinceYesterday: (n: number) => signed(n) + " since yesterday",
  deltaShort: (n: number) => signed(n),
  noChange: "no change",
  grainLasts: (days: number) => days >= 999 ? "nothing eats it" : "lasts about " + days + (days === 1 ? " day" : " days"),
  grainStore: (n: number) => "stores hold " + n,
  // ECON: the realm's granary readout (owner: "the granary should actually store food that the king can access").
  storedOf: (p: { grain: number; capacity: number }) => "stored " + p.grain + " of " + p.capacity,
  granaryHolds: (p: { inGranary: number; granary: number }) =>
    p.granary > 0 ? "granaries " + p.inGranary + " of " + p.granary : "no granary yet",
  overflow: (p: { heap: number; spoils: number }) =>
    p.heap + " grain past the stores' room is rotting (" + p.spoils + " a day): build a granary",
  breadRunsOut: (days: number) => "Bread runs out in " + days + (days === 1 ? " day" : " days") + " at today's need",
  winterComing: (p: { days: number; need: number }) =>
    "Winter in " + p.days + (p.days === 1 ? " day" : " days") + ": the towns will eat " + p.need + " a day",
  /** The tooltip of a stock: what moved it yesterday, the biggest causes first. */
  flowTitle: (p: { name: string; value: number; net: number; parts: readonly string[] }) =>
    p.name + " " + p.value + ". Yesterday " + signed(p.net) + (p.parts.length ? ": " + p.parts.join(", ") : "") + ".",
  flowPart: (p: { label: string; n: number }) => p.label + " " + signed(p.n),
  grainTitle: (p: { stored: string; granary: string; spoils: number }) =>
    p.stored + " (" + p.granary + "). The realm's one store: the towns and the armies at home eat from it, wherever the grain was reaped. " +
    (p.spoils > 0 ? p.spoils + " spoil a day in cellars and heaps; " : "") + "a granary keeps grain without spoiling.",
  hungry: (days: number) => "Hungry: the party has gone short " + days + (days === 1 ? " day" : " days"),
  famineAt: (p: { name: string; days: number }) => "Famine at " + p.name + " (" + p.days + (p.days === 1 ? " day" : " days") + ")",
  // The economy panel.
  economy: "The holding",
  tax: "Tax",
  taxGroup: "Tax rate",
  taxLine: (p: { coin: string; growth: string }) => p.coin + " a day; people " + p.growth + " each season",
  taxRealm: "Same rate everywhere",
  taxRealmDone: (rate: string) => "Every holding of the king's is now taxed at " + rate + ".",
  taxSetDone: (p: { name: string; rate: string }) => p.name + " is now taxed at " + p.rate + ".",
  growth: (pct: number) => (pct > 0 ? "grow " + pct + "%" : pct < 0 ? "leave, " + -pct + "%" : "hold steady"),
  bread: "Bread",
  breadLine: (n: number) => n + " grain a day from the king's stores",
  famineNow: (days: number) => "Famine: " + days + (days === 1 ? " day" : " days") + " short of bread",
  buildings: "Buildings",
  slotEmpty: "empty slot",
  slotBuilding: (p: { name: string; days: number }) => p.name + ": being built, " + p.days + (p.days === 1 ? " day" : " days") + " left",
  slotIdle: (name: string) => name + ": idle, upkeep unpaid",
  slotStanding: (name: string) => name,
  build: "Build…",
  buildTitle: (name: string) => "Build at " + name,
  buildIntro: "Each takes one slot. Costs are paid when the work starts.",
  fields: "Fields",
  field: (n: number) => "Field " + n,
  plotLine: (p: { crop: string; stage: string; pct: number; health: number }) =>
    p.crop + ", " + p.stage + (p.stage === "growing" ? " (" + p.pct + "%)" : "") + (p.health < 100 ? ", " + p.health + "% left after foraging" : ""),
  plotEmpty: "lying fallow",
  coinAmount: (n: number) => (Math.round(n * 10) / 10) + " coin",
  sow: "Sow…",
  sowField: (n: number) => "Sow field " + n,
  harvestField: (n: number) => "Harvest field " + n,
  buildAt: (name: string) => "Build at " + name,
  seasons: (names: readonly string[]) => names.join(" or "),
  unavailable: "not now",
  menuGroup: "Choices",
  sowTitle: (p: { field: string; name: string }) => "Sow " + p.field + " at " + p.name,
  sowIntro: "What can be sown now. Seed is paid when it goes in.",
  harvest: "Harvest",
  harvestDone: (p: { name: string; gains: string }) => "Harvested at " + p.name + ": " + p.gains + ".",
  cancel: "Cancel",
  costLine: (s: string) => "Costs " + s,
  free: "nothing",
  daysLine: (p: { days: number; upkeep: string }) => p.days + (p.days === 1 ? " day" : " days") + " to build" + (p.upkeep ? "; upkeep " + p.upkeep + " a day" : ""),
  yieldLine: (s: string) => "Yields about " + s,
  seasonLine: (s: string) => "Sow in " + s,
  // ECON: what a sowing today would come to, from the calendar (crops.ts daysToRipe).
  ripeBy: (p: { when: string; days: number }) => "Ripe about " + p.when + " (" + p.days + " days)",
  tooLate: "Too late this year: winter would kill it before it ripens",
  notNow: (why: string) => "Not now: " + why + ".",
  chosen: "Ordered.",
  queued: (said: string) => said + " (Time is paused: it is done when time runs again.)",
  // The king card.
  kingTask: "Doing",
  forage: "Forage here",
  rally: "Rally followers",
  claim: (name: string) => "Claim " + name,
  forageDone: "The party forages where it stands, each day, until it moves.",
  rallyDone: "The king speaks in the hamlet, each day, to win followers.",
  claimDone: (name: string) => name + " is the king's.",
  legitimacy: "Legitimacy",
  // Feed lines.
  built: (p: { building: string; name: string }) => p.building + " stands at " + p.name + ".",
  buildingStarted: (p: { building: string; name: string; days: number }) =>
    "Work begins on a " + p.building.toLowerCase() + " at " + p.name + ": " + p.days + (p.days === 1 ? " day." : " days."),
  upkeepUnpaid: (p: { building: string; name: string }) => "The " + p.building.toLowerCase() + " at " + p.name + " stands idle: no coin for its upkeep.",
  famineBegins: (name: string) => "Famine at " + name + ": there is not bread enough.",
  famineEnds: (name: string) => "The famine at " + name + " is over.",
  hungerBegins: "The king's party goes hungry.",
  hungerEnds: "The king's party eats again.",
  rallied: (p: { n: number; name: string }) => p.n + (p.n === 1 ? " follower joins" : " followers join") + " the king at " + p.name + ".",
  /** K11 (audit U2-09): a rally's running count, on its one line. */
  ralliedSince: (p: { n: number; name: string; since: number }) => p.n + " followers have joined the king at " + p.name + " since day " + p.since + ".",
  rallySpent: (name: string) => "No one else at " + name + " will follow; the rally ends.",
  claimed: (name: string) => "The king claims " + name + ".",
  ripe: (p: { crop: string; name: string }) => p.crop + " is ripe at " + p.name + ": harvest it before it spoils.",
  spoiled: (p: { crop: string; name: string; cause: string }) => p.crop + " at " + p.name + " is lost (" + p.cause + ").",
  autoSown: (p: { crop: string; name: string }) => p.crop + " is sown at " + p.name + " (the field resows itself).",
  /** Why a crop was lost, in words (FieldPlot.lost; the feed and the field card). */
  lostCause: (cause: string) => LOST_CAUSE[cause] ?? "lost",
} as const;

/**
 * ECON: every way a crop can be lost, in words. None is a dice roll: each is
 * a cause the field card warns of before it happens (docs/PROVISIONAL.md ECON.5).
 */
export const LOST_CAUSE: Readonly<Record<string, string>> = {
  winter: "killed by the winter: sown too late to ripen",
  overripe: "left ripe too long",
  foraged: "stripped by an army foraging",
  burned: "burned",
  trampled: "trampled in a battle",
  weather: "the weather",
};

/** "12 coin, 6 timber" -- a cost or a gain, in stock order, in words. */
export function amountsLine(c: Readonly<Partial<Record<"coin" | "grain" | "timber" | "iron" | "levy", number>>>): string {
  const parts: string[] = [];
  for (const s of ["coin", "grain", "timber", "iron", "levy"] as const) {
    const v = c[s];
    if (v) parts.push(v + " " + (s === "levy" ? (v === 1 ? "follower" : "followers") : s));
  }
  return parts.length ? parts.join(", ") : E.free;
}
