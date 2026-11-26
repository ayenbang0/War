/**
 * Every word the exploration layer shows (K3a): the event card, the fog
 * marks, the upgrades list, the feed lines and the sim's refusals for
 * exploration orders. A table like content/kingdom/ui-strings.ts, kept in its
 * own file so the story's words live with the story (§A.6).
 *
 * No string guesses anyone's gender (the strings test checks).
 */

import type { SiteKind } from "../kingdom/map.ts";

/** Refusals the sim gives for exploration orders and fogged marches. */
export const EXPLORE_REFUSAL = {
  unknownPlace: "nobody in the party knows the way there yet; explore toward it",
  noKnownRoad: "no road the party knows leads there",
  noSuchFind: "there is no letter waiting from that place",
  noSuchChoice: "there is no such choice",
  cannotPay: "the stores cannot pay for that choice",
} as const;

/** What a site is, in a word, for the card's subtitle. */
export const SITE_NAME: Readonly<Record<SiteKind, string>> = {
  ruin: "a ruin", shrine: "an old shrine", mine: "a mine", forest: "a deep wood", coast: "a stretch of coast", fort: "an abandoned fort",
};

/** The event card, the upgrades list and the feed. */
export const X = {
  cardFrom: "A letter from Brother Aldous",
  cardAt: (p: { name: string; site: string }) => p.name + ", " + p.site,
  choicesGroup: "What will you do?",
  later: "Decide later",
  laterHint: "The letter waits under Finds.",
  laterKey: "Esc: decide later",
  chose: (label: string) => "Chosen: " + label + ".",
  chosePaused: (label: string) => "Chosen: " + label + ". It is done when the realm runs on.",
  failedResult: "It did not go as hoped.",
  heldClock: "The realm waits while you read.",
  costs: (what: string) => "Costs " + what,
  gamble: (pct: number) => "A gamble: about " + pct + " in 100",
  cannotPay: (what: string) => "Not now: needs " + what,
  done: "Close",
  // feed
  found: (name: string) => "The party halts at " + name + ": there is something here.",
  resolved: (p: { name: string; result: string }) => p.name + ": " + p.result,
  upgrade: (name: string) => "Special upgrade: " + name + ".",
  sighted: (name: string) => "Sighted: " + name + ".",
  sightedMany: (n: number) => n + " new places sighted.",
  revealed: (n: number) => n === 1 ? "One place is marked on your map." : n + " places are marked on your map.",
  // the HUD toggle and its list
  findsButton: (letters: number, upgrades: number) => "Finds" + (letters > 0 ? " · " + letters + " waiting" : upgrades > 0 ? " · " + upgrades : ""),
  findsTitle: "Finds and special upgrades",
  findsLabel: "Show finds and special upgrades",
  lettersHeading: "Letters waiting",
  upgradesHeading: "Special upgrades",
  noUpgrades: "None yet. Ruins, shrines, mines, deep woods, coasts and old forts hide them.",
  noLetters: "No letter waiting.",
  readLetter: (name: string) => "Read the letter from " + name,
  explored: (n: number, of: number) => "Places explored: " + n + " of " + of + " known.",
  // the map
  unexplored: "Unexplored",
  unexploredTap: "Unexplored. A road you know leads there; march to find out what it is.",
} as const;

/** Why an `answerLetter` order is refused (sim/kingdom/story.ts checkAnswer); the letter card shows the same words. */
export const STORY_REFUSAL = {
  noStory: "There is no story running in this realm.",
  notYours: "Only the king answers the king's letters.",
  noSuchLetter: "That letter is not waiting for an answer.",
  noSuchChoice: "That letter has no such answer.",
  notOffered: "That answer is not open to you now.",
  cannotPay: "The stores cannot pay for that answer.",
} as const;
