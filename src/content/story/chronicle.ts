/**
 * The kingdom ledger's recurring entries (PLAN.md §A.2, §A.6; phase K9):
 * Brother Aldous's voice for the things that keep happening -- a holding
 * claimed or lost, a battle won or lost, an army starving, a revolt, the
 * season turning, a free company walking off.
 *
 * Each happening has a few variants so a long war does not read like a form.
 * K9 picks one deterministically (the day number modulo the count, never a
 * roll, so writing the chronicle cannot shift any rng stream) and fills the
 * {placeholders} it declares. validate-story.ts checks that every variant
 * uses only its entry's declared placeholders, and that every placeholder an
 * entry declares is one K9 can fill (CHRONICLE_PARAMS).
 *
 * Plain text, dry and humane; nobody is given a gendered pronoun.
 */

import type { Season } from "../kingdom/terrain.ts";

/** What K9 can fill a chronicle line with, and from where. */
export const CHRONICLE_PARAMS: Readonly<Record<string, string>> = {
  king: "the player's chosen name",
  holding: "a holding's name",
  province: "a province's name",
  captain: "a captain or faction as the ledger writes it (\"the Boar\")",
  company: "a free company's name (\"Redmayne's Lances\")",
  army: "an army's name",
  fallen: "how many of the king's people died, as a number",
  survivors: "how many came back, as a number",
  days: "a number of days",
  year: "the year of the exile, as a number",
};

export type Happening =
  | "holdingClaimed" | "holdingLost" | "battleWon" | "battleLost" | "armyStarved" | "revolt"
  | "seasonTurns" | "mercenariesDesert" | "companyDefects" | "companyHired" | "followersJoin"
  | "famine" | "invasionWarned" | "captainSworn" | "siteExplored";

export type ChronicleEntryDef = {
  readonly id: string;
  readonly happening: Happening;
  /** For seasonTurns: the season that has just begun. */
  readonly season?: Season;
  /** The placeholders its variants may use. */
  readonly params: readonly string[];
  readonly variants: readonly string[];
};

export const CHRONICLE: readonly ChronicleEntryDef[] = [
  {
    id: "holding-claimed", happening: "holdingClaimed", params: ["king", "holding"],
    variants: [
      "{holding} is the king's. I have written it in the ledger in the good ink, which I am saving for exactly this.",
      "{king} took {holding} today without a blow, which is the best way, and the rarest.",
      "{holding} has a new name on its rolls this evening, and its people are waiting to find out what that means.",
    ],
  },
  {
    id: "holding-lost", happening: "holdingLost", params: ["holding", "captain"],
    variants: [
      "{holding} is lost to {captain}. I have not crossed it out of the ledger; I have written beside it, 'for now'.",
      "{captain} holds {holding} again. The people there will have to learn a new set of answers to the same questions.",
      "We lost {holding} today. It was held, and then it was not; I set it down as plainly as it happened.",
    ],
  },
  {
    id: "battle-won", happening: "battleWon", params: ["holding", "captain", "fallen", "survivors"],
    variants: [
      "At {holding} the field was ours by evening and {captain} was not. We buried {fallen} of our own, and {survivors} came back to tell it.",
      "A victory at {holding}, against {captain}. The army is pleased with itself, and has earned a night of it; {fallen} did not come back to share it.",
      "{captain} gave way at {holding}. I have counted {fallen} dead on our side, and I count them every time, because somebody should.",
    ],
  },
  {
    id: "battle-lost", happening: "battleLost", params: ["holding", "captain", "fallen", "survivors"],
    variants: [
      "{captain} had the field at {holding}. {survivors} came back with the colours, and {fallen} did not come back at all.",
      "We were beaten at {holding}. It was a bad day; it was not the last day, and I write that down so that it is true.",
      "At {holding} {captain} did what {captain} is known for, and we were not ready for it. {fallen} paid for the lesson.",
    ],
  },
  {
    id: "army-starved", happening: "armyStarved", params: ["army", "holding", "days"],
    variants: [
      "{army} has gone {days} days on short bread near {holding}. Hungry soldiers take what they need, and then they take the road home.",
      "There is no grain with {army}, and has not been for {days} days. I have written the date so that we know when it began.",
      "{army} is eating its horses near {holding}. That is the second-to-last thing an army eats.",
    ],
  },
  {
    id: "revolt", happening: "revolt", params: ["holding", "province"],
    variants: [
      "{holding} has risen. The people there have decided that a king who cannot feed or protect them is not one, and I cannot honestly say they are wrong.",
      "Revolt in {province}, beginning at {holding}. Nobody rises against a ruler they are not afraid of or angry with; we have managed both.",
      "{holding} has shut its gates against the king's reeve. It is a small revolt, as revolts go, and they all begin small.",
    ],
  },
  {
    id: "season-spring", happening: "seasonTurns", season: "spring", params: ["year"],
    variants: [
      "Spring of the year {year} of the exile. The fields want sowing, the roads are mud, and the captains are cleaning their armour.",
      "The thaw has come. Everything that was frozen in place, armies included, can move again.",
    ],
  },
  {
    id: "season-summer", happening: "seasonTurns", season: "summer", params: ["year"],
    variants: [
      "Summer of the year {year}. Long days, dry roads, and every army in the realm on them.",
      "Midsummer. The corn is high, which is good for bread and bad for anyone who has to fight in it.",
    ],
  },
  {
    id: "season-autumn", happening: "seasonTurns", season: "autumn", params: ["year"],
    variants: [
      "Autumn of the year {year}. Whatever is not in the granary by the first frost will not be there for the winter.",
      "The leaves are turning, and so, the rumours say, are some of the lords.",
    ],
  },
  {
    id: "season-winter", happening: "seasonTurns", season: "winter", params: ["year"],
    variants: [
      "Winter of the year {year}. The roads close, the stores open, and we find out whether we counted right.",
      "Snow. Nobody marches who can help it, and everyone eats who can.",
    ],
  },
  {
    id: "mercenaries-desert", happening: "mercenariesDesert", params: ["company", "days"],
    variants: [
      "{company} rode away before dawn, {days} days unpaid. I cannot say they were wrong to; I can say they took the good horses.",
      "{company} have left us. A contract is a promise both ways, and we did not keep our half.",
    ],
  },
  {
    id: "company-defects", happening: "companyDefects", params: ["company", "captain"],
    variants: [
      "{company} have gone over to {captain}, and know where every one of our sentries stands. I have asked for the sentries to be moved.",
      "{company} are fighting for {captain} now. They were paid better; it is the oldest reason there is.",
    ],
  },
  {
    id: "company-hired", happening: "companyHired", params: ["company"],
    variants: [
      "{company} have signed with the king. The followers look at them the way followers always look at people who are paid to be brave.",
      "{company} joined today, for coin. I have written the terms down in full, because they certainly have.",
    ],
  },
  {
    id: "followers-join", happening: "followersJoin", params: ["holding", "king"],
    variants: [
      "People from {holding} came to the banner today, with what they could carry. {king} spoke to every one of them.",
      "More followers, from {holding}. I have run out of the first page of the roll and begun the second.",
    ],
  },
  {
    id: "famine", happening: "famine", params: ["holding", "days"],
    variants: [
      "{holding} has had no bread for {days} days. People are leaving, and the ones who stay are watching the king's granary.",
      "Famine at {holding}. Nothing in this ledger matters as much as that sentence.",
    ],
  },
  {
    id: "invasion-warned", happening: "invasionWarned", params: ["captain", "holding", "days"],
    variants: [
      "Riders seen on the road to {holding}: {captain}'s, by the badges, {days} days out.",
      "Word from the watchtowers: {captain} is coming for {holding}, about {days} days away. We have time to be ready, if we use it.",
    ],
  },
  {
    id: "captain-sworn", happening: "captainSworn", params: ["captain", "king"],
    variants: [
      "{captain} knelt to {king} today and swore. I have seen a great many oaths in this war, and I believe this one, mostly.",
      "{captain} is the king's now, sword and badge. The rest of the Menagerie will have heard by morning.",
    ],
  },
  {
    id: "site-explored", happening: "siteExplored", params: ["holding"],
    variants: [
      "The party halted at {holding}, which nobody had visited for years. Something was waiting there; something usually is.",
      "We came to {holding} today and found it was not quite as abandoned as the map said.",
    ],
  },
];
