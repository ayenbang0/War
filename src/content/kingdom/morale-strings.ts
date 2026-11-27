/**
 * Words for K6's morale systems: the politics card (unrest and what moves it,
 * the levers), the HUD's Mercy/Terror, the army card's morale, the feed, and
 * the sim's refusals. Plain data, one place to reword (docs/ui-policy.md:
 * text lives in tables). English only; every line with a value in it is a
 * template.
 */

import type { JusticeId, UnrestBand, UnrestCauseId } from "./morale.ts";

function days(n: number): string {
  return n + (n === 1 ? " day" : " days");
}

/** Unrest in permille as the 0..100 the player reads, with one decimal only when it has one. */
export function unrestPoints(permille: number): string {
  // Whole numbers only (no Math here): sign, then tens and the tenth.
  const neg = permille < 0;
  const a = neg ? -permille : permille;
  const tenth = a % 10;
  const whole = (a - tenth) / 10;
  return (neg ? "-" : "") + whole + (tenth === 0 ? "" : "." + tenth);
}

/** Why a politics order is refused. The button shows the same words. */
export const MORALE_REFUSAL = {
  noSuchJustice: "there is no such kind of justice",
  sameJustice: "that is already how justice is done here",
  festivalRunning: (left: number) => "a festival is already under way (" + days(left) + " left)",
  festivalCost: (c: { coin: number; grain: number }) =>
    "a festival here needs " + c.coin + " coin and " + c.grain + " grain",
  pardonedThisSeason: "the prisoners here were pardoned this season already",
  nothingToPardon: "the town is quiet: there is no grievance to pardon",
} as const;

/** How unrest reads in words: the band, and loyalty, its complement. */
export const BAND_WORD: Record<UnrestBand, string> = {
  calm: "calm", uneasy: "uneasy", restless: "restless", revolt: "in open revolt",
};
export const LOYALTY_WORD: Record<UnrestBand, string> = {
  calm: "loyal", uneasy: "grumbling", restless: "disloyal", revolt: "lost",
};

/** Each cause on the politics card's list. */
export const CAUSE_LABEL: Record<UnrestCauseId, string> = {
  tax: "Taxes",
  famine: "Famine",
  quartering: "Soldiers quartered unpaid",
  legitimacy: "The king's standing",
  custom: "Growing used to their lord",
  shrine: "Shrines",
  hall: "A lord's hall",
  justice: "Justice",
  festival: "Festival",
  mercy: "The realm's mercy",
};

export const JUSTICE_NAME: Record<JusticeId, string> = { none: "None", courts: "Courts", rope: "The rope" };
export const JUSTICE_ABOUT: Record<JusticeId, string> = {
  none: "Nobody sits in judgement. No calm, no cost.",
  courts: "Justices sit every day for 1 coin. Calms the town; unpaid, they do not sit.",
  rope: "Thieves hang at the crossroads. Calms more and costs nothing, but the realm's mercy falls each season.",
};

/** The politics card (K6 fills K3b's placeholders). */
export const P = {
  standing: (p: { loyalty: string; band: string; points: string }) =>
    capital(p.loyalty) + ": unrest " + p.points + " of 100 (" + p.band + ")",
  today: "Today",
  thresholds: "At 50 the town pays half its taxes; at 80 it revolts.",
  halfTaxes: "Restless: the town pays only half its taxes.",
  trendUp: (pts: string) => "Rising " + pts + " a day.",
  trendDown: (pts: string) => "Falling " + pts + " a day.",
  trendFlat: "Steady.",
  causes: "What moves it",
  causesNone: "Nothing moves it today.",
  causeRow: (p: { label: string; pts: string; raises: boolean }) =>
    p.label + ": " + (p.raises ? "raises" : "calms") + " " + p.pts + " a day",
  notReckoned: "Not yours: its unrest is not the king's to reckon.",
  justice: "Justice",
  justiceSetTo: (name: string) => "Justice: " + name.toLowerCase(),
  festival: "Hold a festival",
  festivalAbout: (p: { coin: number; grain: number; days: number }) =>
    "Bread and ale for " + days(p.days) + ": " + p.coin + " coin and " + p.grain + " grain. Calms the town; +1 legitimacy.",
  festivalOn: (left: number) => "A festival is under way: " + days(left) + " left.",
  pardon: "Pardon the prisoners",
  pardonAbout: "Unrest falls at once and the realm's mercy rises. Once a season.",
  foraged: (n: number) => "Armies have lived off its fields " + days(n) + " this season (each day stirs it).",
  shrines: "Shrines and halls",
  shrinesNone: "None standing here. Build a shrine to calm the town.",
  shrinesLine: (n: number) => n + (n === 1 ? " standing, calming the town." : " standing, calming the town."),
  levers: "Levers",
  refused: (why: string) => "Cannot: " + why + ".",
} as const;

/** The HUD's Mercy/Terror cell. */
export const MERCY = {
  name: "Mercy",
  terror: "Terror",
  about:
    "How the realm remembers your hand: above 0, mercy calms every town; below, terror hardens your armies. Pardons raise it; the rope lowers it.",
  value: (m: number) => (m > 0 ? "+" + m : String(m)),
  label: (m: number) => (m >= 0 ? "Mercy " + (m > 0 ? "+" + m : "0") : "Terror " + -m),
} as const;

/** The army card's morale line, and the battle's start nerve it feeds. */
export const MORALE_WORDS = {
  line: (p: { morale: number; rest: number; falling: boolean }) =>
    p.morale + " of 100" + (p.falling ? ", falling" : p.morale < p.rest ? ", rising toward " + p.rest : p.morale > p.rest ? ", settling toward " + p.rest : ""),
  breaking: "Below 20: men slip away every night.",
} as const;

/** The feed. */
export const MORALE_FEED = {
  band: (p: { name: string; band: string; rising: boolean }) =>
    p.name + (p.rising ? " grows " : " settles: ") + p.band + ".",
  revolt: (p: { name: string; rebels: number }) =>
    p.name + " revolts and throws off the king" + (p.rebels > 0 ? ": " + p.rebels + " rebels take up arms." : "."),
  justice: (p: { name: string; justice: string }) => "At " + p.name + ", justice is now " + p.justice.toLowerCase() + ".",
  festival: (p: { name: string; days: number }) => p.name + " holds a festival for " + days(p.days) + ".",
  festivalOver: (name: string) => "The festival at " + name + " is over.",
  pardoned: (name: string) => "The prisoners of " + name + " are pardoned.",
  mercy: (m: number) => (m >= 0 ? "The realm's mercy is now " + m + "." : "The realm's terror is now " + -m + "."),
  desertion: (p: { army: string; n: number }) => p.n + (p.n === 1 ? " man slips" : " men slip") + " away from the " + p.army + ": its spirit is broken.",
} as const;

function capital(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
