/**
 * The four acts of the Exile of Rimaros (PLAN.md §A.5, with the user's "start
 * from nothing" amendment; phase K9).
 *
 * Progress is earned by territory, not by a chapter counter: an act ends when
 * every one of its goals holds at once, checked against the kingdom state each
 * day (K9). Its `transition` entry is written into the chronicle that day and
 * the next act's `intro` follows it. Losing a battle or a holding never ends
 * an act early or late by itself; only the goals do, and only losing the king
 * ends the run (docs/PROVISIONAL.md B.12.5).
 *
 * Goals are data (vocab.ts StoryCondition), so the same evaluator answers an
 * act goal, a letter's trigger and an ending's gate. validate-story.ts proves
 * every act can be finished with the story's own content: each goal names
 * real places, captains and encounters, any flag it needs is set by a letter
 * in that act or before, and the legitimacy it asks for is reachable.
 *
 * Voice: Brother Aldous's ledger. The king is {king}.
 */

import type { ActId, StoryCondition } from "./vocab.ts";

export type ChronicleText = {
  readonly title: string;
  readonly text: string;
};

export type ActGoal = {
  readonly id: string;
  /** As the act panel lists it: imperative, short. */
  readonly text: string;
  readonly condition: StoryCondition;
};

export type ActDef = {
  readonly id: ActId;
  readonly title: string;
  /** What the act teaches at the kingdom layer (§A.5's last column), for the act panel. */
  readonly lesson: string;
  /** The chronicle entry that opens the act. */
  readonly intro: ChronicleText;
  /** All of these, at once, end the act. */
  readonly goals: readonly ActGoal[];
  /** The chronicle entry written the day the goals are met. */
  readonly transition: ChronicleText;
};

export const ACTS: readonly ActDef[] = [
  {
    id: 1,
    title: "The Farthest Reach",
    lesson: "Bread, followers and a first roof: forage, rally, claim, and live through the winter.",
    intro: {
      title: "The first page",
      text: "We came into the Farthest Reach with a cloak each, twelve days of grain and nothing else, not a holding, not a soldier and not a penny. A king needs bread first, people second and a roof third; we have none of the three, so I have written them down in that order.",
    },
    goals: [
      { id: "rally", text: "Rally three followers at the hamlets", condition: { kind: "followersAtLeast", n: 3 } },
      { id: "roof", text: "Claim a first holding", condition: { kind: "holdingsHeld", n: 1 } },
      { id: "winter", text: "Live through the winter", condition: { kind: "winterSurvived" } },
      { id: "first-battle", text: "Drive the Hare's riders from Hareford", condition: { kind: "encounterWon", encounter: "burning-farms" } },
      { id: "three", text: "Hold three holdings", condition: { kind: "holdingsHeld", n: 3 } },
    ],
    transition: {
      title: "Out of the Reach",
      text: "Three holdings, a winter behind us and the Hare's riders gone home on foot: it is not a kingdom, but it is more than the council meant us to have. The roads south go to the Vale and the Lisle, where the captains of the Menagerie sit in the old governors' halls.",
    },
  },
  {
    id: 2,
    title: "The Marches",
    lesson: "Several armies, free companies, supply on the march, and holdings to defend while the army is away.",
    intro: {
      title: "The Marches",
      text: "South of the Reach the land is governed again, by the captains the old war's terms made governors. Each of them holds a seat, and each fights the way its badge says; I have begun to keep a page for each one's habits.",
    },
    goals: [
      { id: "six", text: "Hold six holdings", condition: { kind: "holdingsHeld", n: 6 } },
      {
        id: "seat", text: "Take a border governor's seat: Harrowfield, Lisle, Boarsden or Hallow Ferry",
        condition: {
          kind: "any", of: [
            { kind: "seatHeld", province: "vale-of-the-hare" },
            { kind: "seatHeld", province: "lisle-bridges" },
            { kind: "seatHeld", province: "long-wood" },
            { kind: "seatHeld", province: "hallow-ferry" },
          ],
        },
      },
    ],
    transition: {
      title: "A governor's hall",
      text: "{king} slept last night in a governor's hall, under a roof the crown pays for, and the lords of the heartland have begun to send letters asking after the king's health. Nobody asks after an exile's health.",
    },
  },
  {
    id: 3,
    title: "The Heartland",
    lesson: "Unrest and loyalty, garrisons, and a war on two fronts while the crown tries to take ground back.",
    intro: {
      title: "The Heartland",
      text: "The heartland is the realm the lords mean when they say the realm: rich, crowded and watchful. Here the war is won by being believed, and by keeping what is taken through a season of the crown trying to take it back.",
    },
    goals: [
      { id: "believed", text: "Reach a legitimacy of 40", condition: { kind: "legitimacyAtLeast", n: 40 } },
      { id: "share", text: "Hold two holdings in every five of the realm", condition: { kind: "shareHeldAtLeast", pct: 40 } },
      { id: "hold-season", text: "Hold a province, seat and all, through a whole season", condition: { kind: "holdRegionThroughSeason", province: "any", seasons: 1 } },
      {
        id: "who", text: "Learn who holds the Crown Seat",
        condition: { kind: "any", of: [{ kind: "flag", flag: "vael-named" }, { kind: "flag", flag: "vael-secret" }] },
      },
    ],
    transition: {
      title: "The road to Rimaros",
      text: "Two holdings in every five are the king's, a province has been held against everything the crown could send, and we know whose hand wrote the order of exile. What is left is the Crown Seat, and the Chancellor in it.",
    },
  },
  {
    id: 4,
    title: "The Crown",
    lesson: "Sieges, the last defence of the crown, and what kind of king comes home.",
    intro: {
      title: "The Crown",
      text: "Rimaros sits on its rivers where it has always sat, with the heights before it and the Chancellor behind its walls. I have kept room on this page for a long time; I find I am afraid to fill it.",
    },
    goals: [
      { id: "road", text: "Hold a holding on a road into the Crown Seat", condition: { kind: "roadToCrownSeat" } },
      { id: "heights", text: "Take the heights before Rimaros", condition: { kind: "encounterWon", encounter: "last-wall" } },
      { id: "crown", text: "Take Rimaros", condition: { kind: "rimarosTaken" } },
    ],
    transition: {
      title: "The coronation",
      text: "{king} was crowned in the hall at Rimaros with the crown taken out of the same box it was put into. What kind of king came home is written on the next page, and the realm will be reading it for a long time.",
    },
  },
];
