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

/**
 * K9: the story's own screens -- the letter card, the chronicle, the end
 * screen, the in-game menu, the cutscene's controls and the tutorial's coach
 * (ui/story/). Brother Aldous's voice where it is the chronicle speaking,
 * plain where it is a control.
 */
export const STORY_UI = {
  // the letter card
  letterFrom: (from: string) => "From " + from,
  letterHeld: "The realm waits while you read.",
  letterLater: "Decide later",
  letterLaterHint: "Esc lays the letter aside. It waits under Letters in the top bar.",
  letterCosts: (what: string) => "Costs " + what + ".",
  letterBattle: (place: string) => "A battle, at " + place + ".",
  letterChance: (pct: number) => "A gamble: it goes this way about " + pct + " times in a hundred.",
  letterNo: (why: string) => "Not now: " + why,
  letterMore: (n: number) => n === 1 ? "One more letter waits." : n + " more letters wait.",
  lettersButton: (n: number) => "Letters (" + n + ")",
  lettersButtonLabel: (n: number) => n === 1 ? "One letter waits for an answer" : n + " letters wait for an answer",
  answered: (title: string, text: string) => title + ": " + text,
  letterCame: (title: string, from: string) => "A letter from " + from + ": " + title + ".",
  actBegins: (n: number, title: string) => "Act " + ["I", "II", "III", "IV"][n - 1] + " begins: " + title + ".",
  storyGroup: "The story",
  // the chronicle
  chronicleButton: "Chronicle",
  chronicleTitle: "The Chronicle",
  chronicleBy: "Kept by Brother Aldous, in the ledger",
  chronicleAct: (n: number, title: string) => "Act " + ["I", "II", "III", "IV"][n - 1] + ": " + title,
  chronicleGoals: "What this act asks",
  goalDone: "done",
  goalOpen: "not yet",
  chronicleDay: (date: string) => date,
  chronicleEmpty: "Nothing written yet.",
  chronicleClose: "Close",
  chronicleCloseHint: "Esc closes the chronicle; the realm waited while you read.",
  chronicleCount: (n: number) => n === 1 ? "One entry." : n + " entries.",
  // the end screen
  endHeading: "Here the chronicle ends",
  endFallen: "The chronicle stops here.",
  endStats: (days: number, holdings: number, legitimacy: number, mercy: number) =>
    days + " days of the exile, " + holdings + " holdings held, Legitimacy " + legitimacy + ", Mercy " + mercy + ".",
  endRead: "Read the chronicle",
  endHome: "Back to the front screen",
  endNew: "Begin a new exile",
  // the in-game menu
  menuButton: "Menu",
  menuTitle: "The realm, paused",
  menuResume: "Back to the realm",
  menuChronicle: "Read the chronicle",
  menuTutorial: "Replay the tutorial",
  menuTutorialHint: "The tutorial runs in a practice realm; this one is saved first and waits for you.",
  menuFront: "Save and go to the front screen",
  menuHint: "Esc goes back to the realm.",
  // the cutscene
  cutsceneLabel: "The opening of the story",
  cutsceneNext: "Next",
  // the tutorial's coach
  coachLabel: "Tutorial",
  coachStep: (n: number, of: number) => "Step " + n + " of " + of,
  coachLesson: (title: string) => "Lesson: " + title,
  coachDraw: "Draw this:",
  coachSkipStep: "Skip this step",
  coachSkipAll: "Skip the tutorial",
  coachDone: "Well done.",
  coachFinishedTitle: "The tutorial is done",
  coachFinishedBody: "That is every control in the game. The practice realm is put away; your own exile begins at Cold Hearth, with nothing.",
  coachFinishedReplay: "That is every control in the game. The practice realm is put away and your own realm is as you left it.",
  coachBegin: "Begin the exile",
  coachBack: "Back to my realm",
  coachSkipTitle: "Skip the tutorial?",
  coachSkipBody: "It can be replayed at any time from Menu on the map.",
  coachSkipYes: "Skip it",
  coachSkipNo: "Keep learning",
  coachAway: (lesson: string) => "Next: " + lesson,
  coachToTown: "Rookstead is the king's now: go down into it.",
  coachToDrill: "Down to the frozen field below Rookstead, where the first followers drill.",
  coachToArmies: "Back on the map: two armies of the king's stand at Rookstead, and an enemy rides on Greyshaw.",
} as const;
