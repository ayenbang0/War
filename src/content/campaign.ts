/**
 * The campaign: The Marchwarden's Chronicle.
 *
 * Nine battles across the ten battlefields, told the way a war of this kind
 * would have come down to anyone: in letters, and in the entries a chronicler
 * made afterwards. The plot is carried by the same parts of the game the
 * battles are fought with -- each of the Margrave's captains IS one of the
 * enemy commanders, so the Boar you were warned about in a letter is the Boar
 * that comes straight at your centre an hour later, and learning his habit is
 * both the story and the tactic.
 *
 * Design notes (see design/BRAINSTORM.md for where these came from):
 *  - Defeat does not end the chronicle. A lost battle is written down and the
 *    war goes on from there; the final entry is shaped by the whole record.
 *  - One choice between battles closes the other road for good, and the
 *    chronicle says what was given up.
 *  - Some letters are not what they seem. One scout report is a forgery,
 *    which the next letter reveals; the battle it sends you to is real anyway.
 *
 * Pure data and pure functions. Progress is kept by whatever store the caller
 * hands in, so the browser uses localStorage and the tests use a plain object.
 */

import type { CommanderId } from "./commanders.ts";
import type { DifficultyId } from "./difficulty.ts";

export type Letter = {
  /** Who wrote it, as the chronicle has it. */
  readonly from: string;
  readonly body: string;
};

export type Fork = {
  readonly prompt: string;
  readonly options: readonly { readonly label: string; readonly blurb: string; readonly next: string }[];
};

export type Chapter = {
  readonly id: string;
  /** Chapter number as shown; the two roads of the fork share one. */
  readonly number: number;
  readonly title: string;
  readonly levelId: string;
  /** Which of the Margrave's captains you are facing. */
  readonly commander: CommanderId;
  readonly difficulty: DifficultyId;
  /** Read before the battle. */
  readonly letter: Letter;
  /** The chronicler's entry afterwards, for a victory and for a defeat. */
  readonly won: string;
  readonly lost: string;
  /** Where the war goes next: a chapter, a choice, or the end. */
  readonly next: string | Fork | null;
};

export const CHAPTERS: readonly Chapter[] = [
  {
    id: "burning-farms",
    number: 1,
    title: "The Burning Farms",
    levelId: "proving-ground",
    commander: "hare",
    difficulty: "recruit",
    letter: {
      from: "Isolde, Regent of the Vale",
      body:
        "Marchwarden -- I am told you dislike the title. You will grow into it or it will bury you, as it buried old Garrow. " +
        "The Margrave of the Red March crossed the Tarn four days ago with what his own heralds call the Menagerie: eight captains who fight under the badges of beasts. " +
        "The first of them, the one they call the Hare, is burning farms along the valley floor. He does not stand, he does not dig, and he does not stop. " +
        "You have the valley levy and whatever the old Warden left in the armoury. Meet him in the open. If you can weather the first rush, I am told there is nothing behind it.",
    },
    won:
      "The Hare's riders came on three times and the third time they did not come back. The new Marchwarden held the valley road by dusk. " +
      "I have been sent by the Regent to keep this chronicle. I write it down as it was: the levy did not break, though it had every reason to.",
    lost:
      "The Hare would not be caught and the levy would not hold, and by dusk the valley road was his. The Marchwarden brought most of the men back. " +
      "I set it down because the Regent asked for the truth and not a song: it was a bad beginning. It was not the end.",
    next: "three-bridges",
  },
  {
    id: "three-bridges",
    number: 2,
    title: "The Three Bridges",
    levelId: "the-crossing",
    commander: "badger",
    difficulty: "recruit",
    letter: {
      from: "Brother Aldous, chronicler",
      body:
        "My lord Marchwarden, forgive a stranger writing to you. The Regent has made me the keeper of this war's chronicle, and I would rather ask you what happened than guess. " +
        "The second of the Margrave's captains, the Badger, has taken the three bridges over the Lisle and has begun to dig. " +
        "The men say he has never once come out of a position to fight. If that is so, he will make you come to him, and the bridges are narrow. " +
        "Bring something that breaks a line, the sergeants tell me, or leave him alone. I do not think you can leave him alone.",
    },
    won:
      "The Marchwarden put the Badger off the bridges in one afternoon, which the old soldiers say could not be done. " +
      "Two roads open from the Lisle now, and both need the army. Word came at nightfall from Hallow Ferry, and from the Regent, and they do not agree.",
    lost:
      "The bridges held against us. The Badger did not pursue; he never does. We went round by the fords, which cost two days. " +
      "Two roads open from here, and both need the army. Word came at nightfall from Hallow Ferry, and from the Regent, and they do not agree.",
    next: {
      prompt:
        "Hallow Ferry is starving under siege and its reeve begs for relief. The Regent orders you instead to hold the Long Wood, to buy her muster the days it needs. You cannot do both.",
      options: [
        {
          label: "Relieve Hallow Ferry",
          blurb: "Break through the Owl's lines and put men on the ferry landing. The muster will be late.",
          next: "starving-town",
        },
        {
          label: "Hold the Long Wood",
          blurb: "Obey the Regent and hold the wood against the Boar. Hallow Ferry must hold out alone.",
          next: "long-wood",
        },
      ],
    },
  },
  {
    id: "starving-town",
    number: 3,
    title: "The Starving Town",
    levelId: "ferry-road",
    commander: "owl",
    difficulty: "sergeant",
    letter: {
      from: "Edric Mallow, reeve of Hallow Ferry (smuggled out in a loaf)",
      body:
        "We have eaten the horses. We have eaten the dogs. The Margrave's captain they call the Owl sits across the ferry road and does nothing at all, " +
        "and I have come to understand that doing nothing is the cruellest thing a soldier can do. " +
        "He answers whatever is done to him. When we sallied, he was waiting. Do not come at him the way he expects. " +
        "Forty men on the landing would be enough to bring the boats across. Forty. I am ashamed to ask for so few and more ashamed that I cannot ask for more.",
    },
    won:
      "Forty-odd men of the Vale reached the ferry landing with the Owl's companies still drawn up across the road behind them, waiting for an attack that had gone round them. " +
      "The boats came across at dawn. The reeve wept. I write it plainly: the Regent's muster will be late, and the Regent knows whose fault that is.",
    lost:
      "We could not get through. The Owl was always where we went. Hallow Ferry opened its gate to the Margrave three days later, and the reeve was not among those who walked out. " +
      "I write it plainly because it ought to be written: the Marchwarden chose this road, and it did not open.",
    next: "three-hills",
  },
  {
    id: "long-wood",
    number: 3,
    title: "The Long Wood",
    levelId: "long-vigil",
    commander: "boar",
    difficulty: "sergeant",
    letter: {
      from: "Isolde, Regent of the Vale",
      body:
        "You will hold the Long Wood. I know about Hallow Ferry. I know what is happening to them and I know you will blame me for it, and I would rather be blamed than lose the war for one town. " +
        "The Boar is coming down the forest road with the heaviest of the Menagerie behind him. He only knows forward, they say. " +
        "Give him ground in the centre and take him in the flanks, and make every hour in that wood cost him. Every hour you hold is a company I can raise.",
    },
    won:
      "The Long Wood held for nine days and the Boar left half his men in it. The Regent's muster marched on the tenth. " +
      "We had word, in that time, that Hallow Ferry had opened its gates. The Marchwarden did not speak of it. I record that it was the right order, and I record what it cost.",
    lost:
      "The Boar came through the wood in four days instead of the nine the Regent needed. Her muster is raised, but raised in haste, and Hallow Ferry fell all the same. " +
      "I set it down without excuse: the order was obeyed, and it failed.",
    next: "three-hills",
  },
  {
    id: "three-hills",
    number: 4,
    title: "The Three Hills",
    levelId: "high-ground",
    commander: "stag",
    difficulty: "captain",
    letter: {
      from: "A herald of the Red March, under a white cloth",
      body:
        "The Margrave of the Red March greets the Marchwarden of the Vale and offers terms. Withdraw beyond the Lisle and he will leave the Vale its lowland towns. " +
        "Refuse, and his captain the Stag will meet you on the three hills above Corrow, where he has never been moved and does not mean to start. " +
        "The Stag bids me say, in his own words, that he does not retreat and will not ask you to. -- (In a different hand, under the seal:) He will not. He will die first. Make him spend himself on the strongest of the hills.",
    },
    won:
      "We refused the terms and took two of the three hills above Corrow and kept them. The Stag would not give ground and lost his best men on the slopes for it. " +
      "He sent word after, by his own herald and not the Margrave's: he would see the Marchwarden again, under colours, and next time he would take ours.",
    lost:
      "We refused the terms and could not take the hills. The Stag stood on the heights above Corrow and let us break ourselves against him. " +
      "He sent word after, by his own herald: he would see the Marchwarden again, under colours, and next time he would take ours.",
    next: "rising-water",
  },
  {
    id: "rising-water",
    number: 5,
    title: "The Rising Water",
    levelId: "rising-water",
    commander: "wolf",
    difficulty: "captain",
    letter: {
      from: "Hob Tanner, deserter from the Red March",
      body:
        "I am writing this because I cannot say it to anyone over there without hanging for it. The Wolf means to pin you at the river and send his dogs and his lances round both ends of you. " +
        "He knows something you do not. It has rained in the hills for a week, and the old men in his camp say the Lisle comes up all at once in a wet year, and takes the bridges. " +
        "When it does, whatever is on the wrong side stays there. I do not want money. I want to go home. Burn this.",
    },
    won:
      "The Lisle came up at the seventh hour as the deserter said it would, and took the bridges, and the Wolf's pack was on the wrong bank of it. " +
      "I asked the Marchwarden whether we should have trusted a deserter. The answer was that we had not trusted him: we had listened to him, and then looked at the sky.",
    lost:
      "The river came up when the deserter said it would and it was we who were on the wrong bank. The Wolf's riders came round both ends of the line exactly as we had been warned they would. " +
      "Being warned is not the same as being ready. I write that down for whoever reads this next.",
    next: "the-stones",
  },
  {
    id: "the-stones",
    number: 6,
    title: "The Stones",
    levelId: "night-stones",
    commander: "fox",
    difficulty: "captain",
    letter: {
      from: "Scout report, carried by courier (as received)",
      body:
        "To the Marchwarden. Rode the Stannary wood at dusk. The three standing stones are EMPTY. No fires, no tracks, no horse lines. The Fox's companies are a day's march north. " +
        "Recommend the stones be occupied tonight by any force to hand, as they command the road to the city. -- R. (The ink has run on the last line, as if the page was wet when it was folded.)",
    },
    won:
      "The stones were not empty. The Fox was in the wood with every company he had, and the report had been written to bring us there in the dark. " +
      "We held two of the three until morning all the same. In the courier's saddlebag we found a second seal, not ours. Someone is writing our letters for us. I have begun to keep copies.",
    lost:
      "The stones were not empty. The Fox was in the wood with every company he had, and the report had been written to bring us there in the dark, and it did. " +
      "In the courier's saddlebag we found a second seal, not ours. Someone is writing our letters for us. I have begun to keep copies.",
    next: "open-field",
  },
  {
    id: "open-field",
    number: 7,
    title: "The Crow Comes Out",
    levelId: "open-field",
    commander: "crow",
    difficulty: "colonel",
    letter: {
      from: "Brother Aldous, chronicler",
      body:
        "My lord, I have compared every letter that has come to this army since the Lisle. The scout report from the Stannary wood was written in the same hand as two dispatches we were glad to have. " +
        "The hand belongs to the Margrave's last captain, the one his own men call the Crow. He has been reading our letters and writing some of them. " +
        "He has never fought in the open. Now that he is known, he has no choice: his host is drawn up on the Fallow downs, and they say he goes for whatever is already hurt. " +
        "Keep the wounded companies back. And forgive me, but from today I would read every letter twice.",
    },
    won:
      "The Crow came out onto the open field and could find nothing weak enough to pick at. His host broke in the afternoon. " +
      "He was not taken. A letter in his hand, addressed to the Margrave, was found in his tent. It says only: 'The Stag has asked for the colours. Let him have them.'",
    lost:
      "The Crow picked the army apart company by company on the open field, as Brother Aldous had feared he would. " +
      "A letter in his hand, addressed to the Margrave, was found afterwards on a dead courier. It says only: 'The Stag has asked for the colours. Let him have them.'",
    next: "the-colours",
  },
  {
    id: "the-colours",
    number: 8,
    title: "The Colours",
    levelId: "the-colours",
    commander: "stag",
    difficulty: "colonel",
    letter: {
      from: "The Stag, captain of the Red March, in his own hand",
      body:
        "Marchwarden. At Corrow you would not meet me man to man and I do not hold it against you; it was not that kind of day. " +
        "Tomorrow, on the downs by the old cairn, it is. My people have sworn on their own colours to take yours. Bring your standard and guard it well. " +
        "Take mine if you can. Whoever is left holding a standard at the end of the day may speak for his country. I will not ask for terms and I will not give them.",
    },
    won:
      "The Vale's colours were still flying at sunset and the Stag's were in the Marchwarden's tent. The Stag was carried off the field alive. " +
      "He asked to see the Marchwarden and said one thing: that the Margrave would now come himself, with the siege train, to the city, and that he hoped we would hold it.",
    lost:
      "The Stag took our colours at the cairn, as he swore he would, and he did not keep them: he sent them back the next morning under a white cloth, with a word. " +
      "The Margrave would now come himself, with the siege train, to the city. He hoped we would hold it.",
    next: "last-wall",
  },
  {
    id: "last-wall",
    number: 9,
    title: "The Last Wall",
    levelId: "last-wall",
    commander: "badger",
    difficulty: "colonel",
    letter: {
      from: "Isolde, Regent of the Vale",
      body:
        "It comes to this, then. The Margrave is in front of the city with the siege train and every company he has left, and his Badger to dig them in. " +
        "My muster is on the road and will reach you before the end of the day, but not before the worst of it. " +
        "You do not have to win. You have to still be standing when the horse comes over the hill. I have never asked anything harder of anyone, and I find I am not afraid that you will fail.",
    },
    won:
      "The army of the Vale was still on the heights before the city when the Regent's horse came over the hill, and the Margrave's siege train never came within range of the walls. " +
      "The Margrave asked for terms that night.",
    lost:
      "The heights before the city were lost an hour before the Regent's horse arrived. The walls held a week longer, which was long enough for the terms to be better than they might have been. " +
      "The Margrave entered the city under a white cloth, and kept, I am told, most of his promises.",
    next: null,
  },
];

export function chapterById(id: string): Chapter | undefined {
  return CHAPTERS.find((c) => c.id === id);
}

export const FIRST_CHAPTER = CHAPTERS[0].id;

/** Where a chronicle stands. Serialised as JSON by the caller. */
export type Progress = {
  /** The chapter to fight next, or "end" once the war is over. */
  at: string;
  /** Every battle fought, in order. */
  record: { chapter: string; won: boolean }[];
  /** True while the war waits on a choice between roads. */
  forked: boolean;
};

export function freshProgress(): Progress {
  return { at: FIRST_CHAPTER, record: [], forked: false };
}

/** Parse a stored chronicle, falling back to a fresh one if it is not ours. */
export function readProgress(raw: string | null): Progress {
  if (!raw) return freshProgress();
  try {
    const p = JSON.parse(raw) as Partial<Progress>;
    if (typeof p.at !== "string" || !Array.isArray(p.record)) return freshProgress();
    if (p.at !== "end" && !chapterById(p.at)) return freshProgress();
    return { at: p.at, record: p.record.filter((r) => chapterById(r.chapter)), forked: p.forked === true };
  } catch {
    return freshProgress();
  }
}

/** Write a battle into the chronicle and move to whatever comes next. */
export function recordBattle(p: Progress, chapterId: string, won: boolean): Progress {
  const c = chapterById(chapterId);
  if (!c || p.at !== chapterId || p.forked) return p;
  const record = [...p.record, { chapter: chapterId, won }];
  if (c.next === null) return { at: "end", record, forked: false };
  if (typeof c.next === "string") return { at: c.next, record, forked: false };
  // A fork: stay on this chapter until the road is chosen.
  return { at: chapterId, record, forked: true };
}

/** Take one road at a fork. */
export function chooseRoad(p: Progress, next: string): Progress {
  const c = chapterById(p.at);
  if (!p.forked || !c || typeof c.next !== "object" || c.next === null) return p;
  if (!c.next.options.some((o) => o.next === next)) return p;
  return { ...p, at: next, forked: false };
}

/** The chronicle's last entry, shaped by the whole record. */
export function epilogue(p: Progress): string {
  const wins = p.record.filter((r) => r.won).length;
  const fought = p.record.length;
  const last = p.record[p.record.length - 1];
  const city = last && last.chapter === "last-wall" && last.won;
  const ferry = p.record.find((r) => r.chapter === "starving-town");
  const wood = p.record.find((r) => r.chapter === "long-wood");
  const road = ferry
    ? (ferry.won ? "Hallow Ferry was relieved, and the muster was late for it." : "Hallow Ferry was not relieved, though the Marchwarden tried.")
    : wood
      ? (wood.won ? "The Long Wood was held, and Hallow Ferry was the price." : "The Long Wood was not held, and Hallow Ferry fell all the same.")
      : "";
  const tone =
    wins >= 7 ? "The Vale will remember this Marchwarden for as long as it has a chronicle to remember with."
      : wins >= 4 ? "It was not a war of victories. It was a war in which the Vale was never quite beaten, which is rarer."
        : "It was a war of defeats, and I have written every one of them down, because the Regent asked for the truth and the truth is that they kept coming back.";
  return (
    "Here ends the chronicle of the Marchwarden's war, kept by Aldous, lay brother. " +
    "Of " + fought + " battles the army of the Vale won " + wins + ". " + road + " " +
    (city ? "The city did not fall. " : "The city opened its gates on terms. ") + tone
  );
}
