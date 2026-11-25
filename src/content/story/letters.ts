/**
 * Story letters (PLAN.md §A.4-§A.6; phase K9): the event cards that carry the
 * plot -- forks, beats, the captains' first encounters, the Margrave's
 * demands, the Regent's letters re-read, the forged scout report, the free
 * companies' offers and betrayals, and the usurper unmasked in Act III.
 *
 * The same card the K3a exploration events use (a letter, two or three
 * choices, effects as data), with three things added for the story:
 *   - `trigger`: the kingdom condition that sends it (vocab.ts). Null means it
 *     is only ever sent by another letter's `followUp` effect. K9 checks
 *     triggers once a day, in table order, and sends each letter once,
 *     except as a follow-up;
 *   - `requires` on a choice: a choice can be offered only when the king has
 *     what it needs (a kept letter, a hired company). Every letter keeps one
 *     choice that requires nothing and costs nothing, so no card can trap the
 *     player (validated, as K3a's are);
 *   - `kind`: what sort of beat it is, for the chronicle screen's grouping and
 *     for the validator (an "encounter" letter must offer its battle).
 *
 * Effects reuse the K3a vocabulary and add the story's own (vocab.ts). A
 * letter that a goal of an act depends on never dead-ends: a choice that
 * declines the battle sends the same letter again later (`followUp` to
 * itself), so an act can always be finished (validate-story.ts proves it).
 *
 * Voice: Brother Aldous's, dry and humane, unless the letter is someone
 * else's. Nobody is given a gendered pronoun; the king is {king}, "the king"
 * or "Majesty", the captains are "the Boar" and "they".
 */

import type { ActId, StoryCondition, StoryEffect } from "./vocab.ts";

export type LetterKind =
  | "beat" | "fork" | "encounter" | "reread" | "demand" | "forgery" | "offer" | "betrayal" | "reveal" | "warning";

export type StoryOutcome = {
  readonly result: string;
  readonly effects: readonly StoryEffect[];
};

export type StoryChoice = StoryOutcome & {
  /** The button: a verb first, short. */
  readonly label: string;
  /** Offered only when this holds. */
  readonly requires?: StoryCondition;
  /** A gamble, as in K3a: `pct` percent this outcome, otherwise `fail`'s. */
  readonly chance?: { readonly pct: number; readonly fail: StoryOutcome };
};

export type StoryLetterDef = {
  readonly id: string;
  readonly act: ActId;
  readonly kind: LetterKind;
  /** Who wrote it, as the chronicle has it. */
  readonly from: string;
  readonly title: string;
  /** The letter: at most three sentences. */
  readonly text: string;
  /** What sends it; null when only a follow-up does. */
  readonly trigger: StoryCondition | null;
  /** Two or three. */
  readonly choices: readonly StoryChoice[];
};

const ALDOUS = "Brother Aldous";

const all = (...of: StoryCondition[]): StoryCondition => ({ kind: "all", of });
const any = (...of: StoryCondition[]): StoryCondition => ({ kind: "any", of });
const flag = (f: string): StoryCondition => ({ kind: "flag", flag: f });

export const STORY_LETTERS: readonly StoryLetterDef[] = [
  // == Act I: the Farthest Reach ===================================================
  {
    id: "first-follower", act: 1, kind: "beat", from: ALDOUS, title: "The First Follower",
    trigger: { kind: "followersAtLeast", n: 1 },
    text: "A shepherd's child from Greyshaw has walked out after us with a dog and a sack of oats, and says the dog can fight. I have written the child's name first in the roll, under the king's, because somebody has to be first.",
    choices: [
      { label: "Take them in, dog and all", result: "The dog eats more than the child. Nobody minds.", effects: [{ kind: "mercy", delta: 1 }] },
      { label: "Send them home with the oats", result: "The child goes home angry and alive. Greyshaw hears that the exile sends children home, and thinks better of the exile for it.", effects: [{ kind: "mercy", delta: 2 }, { kind: "legitimacy", delta: 1 }] },
      { label: "Keep the oats for the march", result: "Six days of bread, and one more mouth. The child does not ask where the oats went.", effects: [{ kind: "gain", gains: { grain: 6 } }, { kind: "mercy", delta: -1 }] },
    ],
  },
  {
    id: "isolde-reread-regent", act: 1, kind: "reread", from: ALDOUS, title: "The Regent's First Letter, Read Again",
    trigger: { kind: "daysPassed", n: 4 },
    text: "In my satchel I still have the copies I made in the old war, and the first is the Regent's: 'You will grow into it or it will bury you, as it buried old Garrow.' Isolde wrote that to the young Marchwarden who is now our exiled king, and I read it then as a warning. I read it now as one too, though I am less sure whom it warned.",
    choices: [
      { label: "Keep the copies", result: "Brother Aldous wraps them in oilcloth with the ledger. A hand is a kind of evidence.", effects: [{ kind: "flag", flag: "kept-isolde-letters" }] },
      { label: "Burn them for warmth", result: "They burn quickly, the way old paper does. The fire is not much warmer for it.", effects: [] },
    ],
  },
  {
    id: "rookstead-roof", act: 1, kind: "beat", from: ALDOUS, title: "A Roof, Then",
    trigger: { kind: "holdingHeld", holding: "rookstead" },
    text: "Rookstead has three walls and a hearth, which is two walls and a hearth more than we had. The followers want to know whether it is a king's house or only a dry one, and it is the first question of the reign that matters.",
    choices: [
      { label: "Raise the old banner over it", result: "The banner is a cloak on a pole, and everyone in the Reach can see it. So can the Hare.", effects: [{ kind: "legitimacy", delta: 2 }, { kind: "flag", flag: "banner-raised" }] },
      { label: "Keep it quiet until spring", result: "No banner, no fires on the walls. Rookstead looks as empty as it did, which was the point.", effects: [{ kind: "flag", flag: "quiet-winter" }] },
    ],
  },
  {
    id: "customs-oath", act: 1, kind: "beat", from: "The elders of Thornwick", title: "The Old Customs",
    trigger: { kind: "holdingsHeld", n: 2 },
    text: "We will follow the banner if the banner swears to keep the Reach's customs: no hunting across our sown fields, the commons open, and the winter dole as it was in the old king's time. The usurper's reeves swore the same and forgot it by spring.",
    choices: [
      { label: "Swear it", result: "{king} swears at the Thornwick stone with half the Reach watching. An oath is cheap to make and dear to break, and everyone present knows which half of that matters.", effects: [{ kind: "legitimacy", delta: 2 }, { kind: "flag", flag: "customs-sworn" }] },
      { label: "Promise nothing that cannot be kept", result: "The elders go home unsatisfied but not deceived. Brother Aldous writes down that this, too, is a kind of answer.", effects: [{ kind: "mercy", delta: 1 }] },
    ],
  },
  {
    id: "winter-bread", act: 1, kind: "beat", from: ALDOUS, title: "Winter Bread",
    trigger: all({ kind: "season", season: "winter" }, { kind: "holdingsHeld", n: 1 }),
    text: "The hamlets are short of bread, and they know we have some. They have not asked yet, which is how I know they are frightened of us.",
    choices: [
      { label: "Share the stores (10 grain)", result: "Ten days' bread goes out along the tracks, and the hamlets stop being frightened.", effects: [{ kind: "pay", cost: { grain: 10 } }, { kind: "mercy", delta: 3 }, { kind: "legitimacy", delta: 1 }] },
      { label: "Keep the stores for the followers", result: "The followers eat. The hamlets watch them eat.", effects: [{ kind: "mercy", delta: -2 }] },
      { label: "Take what Thornwick has hidden", result: "Thornwick had twenty days of grain under the chapel floor. It has none now, and it has a long memory.", effects: [{ kind: "gain", gains: { grain: 20 } }, { kind: "mercy", delta: -5 }] },
    ],
  },
  {
    id: "offer-harker", act: 1, kind: "offer", from: "Captain Harker, of Harker's Outriders", title: "Scouts for Hire",
    trigger: all({ kind: "holdingsHeld", n: 1 }, { kind: "daysPassed", n: 30 }),
    text: "Six riders, good eyes, no illusions. Our last employer was the Hare, who paid in promises; we would like to try coin, even an exile's coin.",
    choices: [
      { label: "Hire them (8 coin)", result: "Harker's Outriders take the coin and the road. The map is bigger by the next morning.", effects: [{ kind: "pay", cost: { coin: 8 } }, { kind: "hire", company: "harker-outriders" }] },
      { label: "Not yet", result: "Harker shrugs. Scouts are patient, mostly.", effects: [{ kind: "followUp", letter: "offer-harker", days: 30 }] },
    ],
  },
  {
    id: "enc-burning-farms", act: 1, kind: "encounter", from: "The reeve of Hareford", title: "The Burning Farms",
    trigger: all({ kind: "holdingHeld", holding: "rookstead" }, any({ kind: "winterSurvived" }, all(flag("banner-raised"), { kind: "daysPassed", n: 45 }))),
    text: "The Hare's riders are burning the farms along the valley floor again, as they did in the old war. The Regent wrote then that the Hare does not stand, does not dig and does not stop, and that there is nothing behind the first rush; that is still true.",
    choices: [
      { label: "Ride to Hareford", result: "The followers take up what they have. Brother Aldous takes up the ledger.", effects: [{ kind: "battle", encounter: "burning-farms" }] },
      { label: "Not yet: they are not ready", result: "Hareford burns a little longer. The reeve will write again.", effects: [{ kind: "legitimacy", delta: -1 }, { kind: "followUp", letter: "enc-burning-farms", days: 10 }] },
    ],
  },
  {
    id: "hare-returns", act: 1, kind: "encounter", from: ALDOUS, title: "The Hare Comes Back",
    trigger: null,
    text: "The Hare's riders are on the valley road again, and a little bolder for having beaten us once. Weather the first rush; the old advice has not changed because we failed to take it.",
    choices: [
      { label: "Meet them in the open", result: "The followers go down to Hareford a second time, and quieter.", effects: [{ kind: "battle", encounter: "burning-farms" }] },
      { label: "Wait and drill", result: "Two more weeks of drill on the frozen field. The Hare will still be there.", effects: [{ kind: "followUp", letter: "hare-returns", days: 15 }] },
    ],
  },
  {
    id: "hare-prisoners", act: 1, kind: "fork", from: ALDOUS, title: "The Hare's Riders",
    trigger: { kind: "encounterWon", encounter: "burning-farms" },
    text: "We have nine of the Hare's riders, taken with torches still in their hands. The farmers of Hareford want them hanged; the riders want to go home; I want it written that I was asked.",
    choices: [
      { label: "Let them go home", result: "They go, on foot, without their horses. Two of them come back a week later to stay.", effects: [{ kind: "mercy", delta: 3 }, { kind: "gain", gains: { levy: 2 } }] },
      { label: "Hang the burners", result: "Hareford watches. Nobody in the valley burns a farm that month.", effects: [{ kind: "mercy", delta: -5 }, { kind: "legitimacy", delta: 1 }] },
      { label: "Put them to work at Rookstead", result: "Nine pairs of hands on the walls. They work well, for prisoners, and talk to the followers at night.", effects: [{ kind: "gain", gains: { levy: 4 } }, { kind: "mercy", delta: -1 }] },
    ],
  },

  // == Act II: the Marches =========================================================
  {
    id: "margrave-demands", act: 2, kind: "demand", from: "A herald of the Red March, under a white cloth", title: "The Margrave's Terms",
    trigger: { kind: "actAtLeast", act: 2 },
    text: "The Margrave of the Red March greets the former king and offers terms: keep the Reach, swear never to cross the Lisle, and the Menagerie will leave the Reach alone. There is a purse with the letter, which the herald says is a courtesy and Brother Aldous says is a price.",
    choices: [
      { label: "Accept the terms and the purse", result: "Thirty coin, and a promise the whole Reach knows was made. The lords south of the Lisle know it too.", effects: [{ kind: "gain", gains: { coin: 30 } }, { kind: "legitimacy", delta: -4 }, { kind: "flag", flag: "margrave-terms-accepted" }] },
      { label: "Refuse, and send the purse back", result: "The herald rides back with the purse and an answer that will be repeated in every hall in the March.", effects: [{ kind: "legitimacy", delta: 2 }] },
      { label: "Keep the purse and send the herald back without a cloak", result: "It is a cold ride to Redcastle. The Margrave will not forget it, and neither will the people who laughed.", effects: [{ kind: "gain", gains: { coin: 30 } }, { kind: "mercy", delta: -2 }, { kind: "legitimacy", delta: 1 }] },
    ],
  },
  {
    id: "terms-broken", act: 2, kind: "demand", from: "The Margrave of the Red March", title: "The Terms Are Broken",
    trigger: all(flag("margrave-terms-accepted"), { kind: "holdingsHeld", n: 6 }),
    text: "The former king swore never to cross the Lisle, and is across it. The Menagerie is loosed, and every captain in it has been told why.",
    choices: [
      { label: "Answer that terms made in exile bind nobody", result: "It is a lawyer's answer, and the March treats it like one.", effects: [{ kind: "legitimacy", delta: -2 }, { kind: "unflag", flag: "margrave-terms-accepted" }] },
      { label: "Send back the Margrave's coin (30 coin)", result: "The coin goes back with a short letter. An oath broken and paid for is still broken, but it is talked of differently.", effects: [{ kind: "pay", cost: { coin: 30 } }, { kind: "legitimacy", delta: 1 }, { kind: "unflag", flag: "margrave-terms-accepted" }] },
    ],
  },
  {
    id: "enc-three-bridges", act: 2, kind: "encounter", from: ALDOUS, title: "The Three Bridges",
    trigger: all({ kind: "actAtLeast", act: 2 }, { kind: "holdingsHeld", n: 4 }),
    text: "The Badger has taken the three bridges over the Lisle and has begun to dig, as in the old war, and the sergeants say the same thing they said then: bring something that breaks a line, or leave the Badger alone. I do not think we can leave the Badger alone.",
    choices: [
      { label: "Take the bridges", result: "The army goes down to the Lisle with everything that can break a line.", effects: [{ kind: "battle", encounter: "three-bridges" }] },
      { label: "Go round by the fords for now", result: "Two days round, and the Badger still on the bridges behind us.", effects: [{ kind: "followUp", letter: "enc-three-bridges", days: 12 }] },
    ],
  },
  {
    id: "ferry-or-wood", act: 2, kind: "fork", from: ALDOUS, title: "Two Roads from the Lisle",
    trigger: { kind: "encounterFought", encounter: "three-bridges" },
    text: "Hallow Ferry is starving under the Owl's siege, and its reeve begs for relief. At the same time the Boar is coming down the forest road toward Ashgrove, because the Boar always marches on whoever is weakest, and today that is us; we cannot answer both.",
    choices: [
      { label: "Relieve Hallow Ferry", result: "The army turns south for the ferry. The Long Wood must look after itself.", effects: [{ kind: "flag", flag: "road-ferry" }] },
      { label: "Hold the Long Wood", result: "The army turns into the trees. Hallow Ferry must hold out alone.", effects: [{ kind: "flag", flag: "road-wood" }] },
    ],
  },
  {
    id: "enc-starving-town", act: 2, kind: "encounter", from: "Edric Mallow, reeve of Hallow Ferry (smuggled out in a loaf)", title: "The Starving Town",
    trigger: flag("road-ferry"),
    text: "We have eaten the horses and we have eaten the dogs, and the Owl sits across the ferry road and does nothing at all, which I have come to understand is the cruellest thing a soldier can do. The Owl answers whatever is done to it, so do not come the way it expects. Forty on the landing would bring the boats across; I am ashamed to ask for so few.",
    choices: [
      { label: "Go round the Owl, to the landing", result: "The army marches on the ferry road as if to attack it, and then does not.", effects: [{ kind: "battle", encounter: "starving-town" }] },
      { label: "Not yet: the army is not in place", result: "Another loaf goes back across the river with an answer in it. The reeve will write again, if the reeve can.", effects: [{ kind: "followUp", letter: "enc-starving-town", days: 5 }] },
    ],
  },
  {
    id: "enc-long-wood", act: 2, kind: "encounter", from: "The reeve of Ashgrove", title: "The Long Wood",
    trigger: flag("road-wood"),
    text: "The Boar is coming down the forest road with the heaviest of the Menagerie behind, and the Boar only knows forward. The Regent's advice in the old war was to give ground in the centre and take the Boar in the flanks; it was good advice, and the Regent gave it to you.",
    choices: [
      { label: "Hold the wood", result: "The army goes into the trees and waits for the sound of the Boar coming.", effects: [{ kind: "battle", encounter: "long-wood" }] },
      { label: "Not yet: fall back on Ashgrove", result: "We fall back. The Boar comes on, as the Boar does.", effects: [{ kind: "followUp", letter: "enc-long-wood", days: 5 }] },
    ],
  },
  {
    id: "ferry-falls", act: 2, kind: "beat", from: ALDOUS, title: "Hallow Ferry Opens Its Gates",
    trigger: all(flag("road-wood"), { kind: "encounterFought", encounter: "long-wood" }),
    text: "Hallow Ferry opened its gate to the Owl while we were in the wood, and Edric Mallow was not among those who walked out. It was the choice we made, and I record what it cost.",
    choices: [
      { label: "Write the reeve's name in the ledger", result: "The reeve's name goes in under the day's date, in the good ink.", effects: [{ kind: "flag", flag: "mallow-dead" }, { kind: "mercy", delta: 1 }] },
      { label: "Swear to take the town back", result: "{king} swears it aloud, which means it will have to be done.", effects: [{ kind: "flag", flag: "mallow-dead" }, { kind: "flag", flag: "oath-ferry" }, { kind: "legitimacy", delta: 1 }] },
    ],
  },
  {
    id: "wood-burns", act: 2, kind: "beat", from: ALDOUS, title: "The Wood Behind Us",
    trigger: all(flag("road-ferry"), { kind: "encounterFought", encounter: "starving-town" }),
    text: "While we were at the ferry the Boar came through the Long Wood and burned Ashgrove's roofs over its people's heads. Nobody blames the king aloud, which is not the same as nobody blaming the king.",
    choices: [
      { label: "Send timber for the roofs (10 timber)", result: "Ten carts of timber go up the forest road. Ashgrove is roofed by the first frost.", effects: [{ kind: "pay", cost: { timber: 10 } }, { kind: "mercy", delta: 2 }, { kind: "legitimacy", delta: 1 }] },
      { label: "The wood must mind itself", result: "Ashgrove mends its own roofs, and minds its own counsel.", effects: [{ kind: "unrest", province: "long-wood", delta: 8 }] },
    ],
  },
  {
    id: "enc-owl-late", act: 2, kind: "encounter", from: ALDOUS, title: "The Owl at the Ferry",
    trigger: all(flag("road-wood"), { kind: "encounterFought", encounter: "long-wood" }, { kind: "holdingsHeld", n: 6 }),
    text: "The Owl still holds Hallow Ferry and still sits across its road, waiting for the move it can answer. The reeve's advice outlived the reeve: make the first move a feint.",
    choices: [
      { label: "Take back the ferry", result: "The army comes down the ferry road, with a feint in front of it.", effects: [{ kind: "battle", encounter: "owl-late" }] },
      { label: "Not yet", result: "The Owl waits. The Owl is good at that.", effects: [{ kind: "followUp", letter: "enc-owl-late", days: 15 }] },
    ],
  },
  {
    id: "enc-boar-late", act: 2, kind: "encounter", from: ALDOUS, title: "Into the Long Wood",
    trigger: all(flag("road-ferry"), { kind: "encounterFought", encounter: "starving-town" }, { kind: "holdingsHeld", n: 6 }),
    text: "The Boar has gone back to Boarsden to boast about Ashgrove. A Boar at home is still a Boar: it will come straight at the centre, so give ground there and take it in the flanks.",
    choices: [
      { label: "Go into the wood after the Boar", result: "The army marches for Boarsden. The trees close behind it.", effects: [{ kind: "battle", encounter: "boar-late" }] },
      { label: "Not yet", result: "The Boar boasts a little longer.", effects: [{ kind: "followUp", letter: "enc-boar-late", days: 15 }] },
    ],
  },
  {
    id: "isolde-first", act: 2, kind: "reread", from: "Isolde, who was Regent", title: "A Letter from Isolde",
    trigger: all({ kind: "actAtLeast", act: 2 }, { kind: "holdingsHeld", n: 5 }),
    text: "I signed it. I will not pretend the seal slipped, or that I was not afraid, or that I did not think you would die in the Reach and spare me the rest of it. You did not die, and I find I have to write to you, which is worse.",
    choices: [
      { label: "Keep it with the others", result: "Brother Aldous files it with the copies from the old war, in the same hand, a little shakier.", effects: [{ kind: "flag", flag: "kept-isolde-letters" }] },
      { label: "Answer in one line", result: "{king} writes one line and does not let Brother Aldous read it. The courier takes it south.", effects: [{ kind: "flag", flag: "kept-isolde-letters" }, { kind: "flag", flag: "isolde-answered" }] },
      { label: "Burn it unanswered", result: "It burns like the others did. Brother Aldous writes nothing, which says enough.", effects: [{ kind: "flag", flag: "isolde-scorned" }] },
    ],
  },
  {
    id: "isolde-reread-wood", act: 2, kind: "reread", from: ALDOUS, title: "The Regent's Order, Read Again",
    trigger: any({ kind: "encounterFought", encounter: "starving-town" }, { kind: "encounterFought", encounter: "long-wood" }),
    text: "In the old war the Regent ordered the young Marchwarden to hold the Long Wood and let Hallow Ferry starve: 'I would rather be blamed than lose the war for one town.' I read it then as hard sense, and I read it now as a habit; Isolde spent a town to save a war, and later spent a king to save a peace.",
    choices: [
      { label: "Keep the copy", result: "It goes back in the oilcloth with the rest.", effects: [{ kind: "flag", flag: "kept-isolde-letters" }] },
      { label: "Let it go", result: "Brother Aldous puts it in the fire without being asked, and then looks as though that was a mistake.", effects: [] },
    ],
  },
  {
    id: "scout-report", act: 2, kind: "forgery", from: "Scout report signed R., carried by courier (as received)", title: "The Barrow Is Empty",
    trigger: all({ kind: "actAtLeast", act: 2 }, { kind: "holdingsHeld", n: 5 }),
    text: "Rode the Grey Wold at dusk; the barrow at Wold Barrow is EMPTY, no fires, no tracks, and the Fox's companies are a day's march south. Recommend the barrow be occupied tonight by any force to hand, as it commands the road north. (The ink has run on the last line, as if the page was wet when it was folded.)",
    choices: [
      { label: "Occupy the barrow tonight", result: "The army marches into the Wold in the dark, as the report asks.", effects: [{ kind: "flag", flag: "fell-for-forgery" }, { kind: "battle", encounter: "the-stones" }] },
      { label: "Have Brother Aldous read it twice", result: "Brother Aldous reads it twice, then a third time against the copies, and goes very quiet.", effects: [{ kind: "flag", flag: "forgery-spotted" }, { kind: "followUp", letter: "stones-by-day", days: 2 }] },
      { label: "Leave the barrow to the crows", result: "Nobody goes into the Wold. Whoever wrote the report will have to try again.", effects: [] },
    ],
  },
  {
    id: "stones-by-day", act: 2, kind: "encounter", from: ALDOUS, title: "The Same Hand",
    trigger: null,
    text: "The report was written in the same hand as the forged scout letter from the old war, the one that sent the young Marchwarden to the Stannary stones in the dark. The Fox is waiting in the heather at Wold Barrow; we know it, and the Fox does not know we know.",
    choices: [
      { label: "Go at dawn, from the side they are not watching", result: "The army goes into the Wold by daylight, from the north.", effects: [{ kind: "battle", encounter: "the-stones" }] },
      { label: "Let the Fox wait in the cold", result: "The Fox waits three nights in the heather for an army that does not come, and goes home with a cough.", effects: [{ kind: "legitimacy", delta: 1 }] },
    ],
  },
  {
    id: "offer-redmayne", act: 2, kind: "offer", from: "Captain Redmayne, of Redmayne's Lances", title: "Lances for Hire",
    trigger: all({ kind: "actAtLeast", act: 2 }, { kind: "holdingsHeld", n: 4 }),
    text: "We are dear, and we are worth it, and we have never once broken a contract that was paid. Pay us and we stay; I say the second part so that nobody can say later I did not.",
    choices: [
      { label: "Hire the Lances (40 coin)", result: "Redmayne's Lances ride in two by two and look at the camp as if pricing it.", effects: [{ kind: "pay", cost: { coin: 40 } }, { kind: "hire", company: "redmayne-lances" }] },
      { label: "Not now", result: "Captain Redmayne leaves an address at the tavern in Lisle, written very neatly.", effects: [{ kind: "followUp", letter: "offer-redmayne", days: 30 }] },
    ],
  },
  {
    id: "redmayne-unpaid", act: 2, kind: "betrayal", from: "Captain Redmayne, of Redmayne's Lances", title: "The Second Part",
    trigger: all({ kind: "companyHired", company: "redmayne-lances" }, { kind: "wagesOwedDays", n: 5 }),
    text: "Five days unpaid. I said the second part plainly when we signed, and I am saying it again now, more plainly.",
    choices: [
      { label: "Pay what is owed (15 coin)", result: "The Lances are paid to the penny and say nothing more about it.", effects: [{ kind: "pay", cost: { coin: 15 } }, { kind: "loyalty", company: "redmayne-lances", delta: 10 }] },
      { label: "Promise pay after the next battle", result: "Redmayne writes the promise down, which is worse than arguing.", effects: [{ kind: "loyalty", company: "redmayne-lances", delta: -15 }] },
      { label: "Let them ride away", result: "The Lances ride away in good order, which is the most a contract can ask.", effects: [{ kind: "companyLeaves", company: "redmayne-lances", how: "expired" }] },
    ],
  },
  {
    id: "offer-halloway", act: 2, kind: "offer", from: "Captain Halloway, of Halloway's Horse", title: "Horse, Cheap",
    trigger: all({ kind: "actAtLeast", act: 2 }, { kind: "holdingsHeld", n: 5 }),
    text: "Horse, quick and cheap, and nobody in the March rides better. Ask anyone who has hired us; some of them will even tell you the truth.",
    choices: [
      { label: "Hire the Horse (15 coin)", result: "Halloway's Horse are in the camp by supper and at the best of the fire by midnight.", effects: [{ kind: "pay", cost: { coin: 15 } }, { kind: "hire", company: "halloway-horse" }, { kind: "followUp", letter: "halloway-poached", days: 40 }] },
      { label: "Send them on their way", result: "Captain Halloway laughs and rides east, toward Redcastle.", effects: [] },
    ],
  },
  {
    id: "halloway-poached", act: 2, kind: "betrayal", from: ALDOUS, title: "A Better Offer",
    trigger: null,
    text: "A rider from the Margrave came to Halloway's fire last night with a purse, and left without it. Captain Halloway has not said anything, which for Halloway is a great deal.",
    choices: [
      { label: "Match the Margrave's price (30 coin)", result: "Halloway takes the coin with a grin. For now they are ours.", requires: { kind: "companyHired", company: "halloway-horse" }, effects: [{ kind: "pay", cost: { coin: 30 } }, { kind: "loyalty", company: "halloway-horse", delta: 20 }] },
      { label: "Pay them off before they can turn (10 coin)", result: "The Horse ride out at dawn with ten coin and no hard feelings, they say.", requires: { kind: "companyHired", company: "halloway-horse" }, effects: [{ kind: "pay", cost: { coin: 10 } }, { kind: "companyLeaves", company: "halloway-horse", how: "expired" }] },
      { label: "Let the purse decide", result: "By morning Halloway's Horse are riding for Redcastle, and know the camp well.", effects: [{ kind: "companyLeaves", company: "halloway-horse", how: "defected" }] },
    ],
  },
  {
    id: "offer-corbin", act: 2, kind: "offer", from: "Captain Corbin, of Corbin's Pack", title: "The Pack",
    trigger: all({ kind: "actAtLeast", act: 2 }, { kind: "holdingsHeld", n: 6 }),
    text: "Dogs that can pull a rider out of the saddle, and runners who keep up with the dogs. We win, and we eat as we go; that is the whole of the contract.",
    choices: [
      { label: "Hire the Pack (20 coin)", result: "Corbin's Pack come in howling. The followers move their tents further off.", effects: [{ kind: "pay", cost: { coin: 20 } }, { kind: "hire", company: "corbin-pack" }, { kind: "mercy", delta: -1 }, { kind: "followUp", letter: "corbin-burning", days: 25 }] },
      { label: "Refuse them", result: "Corbin spits, and takes the Pack north. Somebody else will hire them.", effects: [{ kind: "mercy", delta: 1 }] },
    ],
  },
  {
    id: "corbin-burning", act: 2, kind: "betrayal", from: "The reeve of Furrowby", title: "We Eat As We Go",
    trigger: null,
    text: "Your dogs came through Furrowby because we would not feed them, and we have nothing now to feed anyone. If this is the king's peace I would like to know what the usurper's was for.",
    choices: [
      { label: "Hang the ringleaders", result: "Two of the Pack hang at Furrowby crossroads. Corbin does not forgive it, and the valley does not forget it either way.", requires: { kind: "companyHired", company: "corbin-pack" }, effects: [{ kind: "legitimacy", delta: 2 }, { kind: "loyalty", company: "corbin-pack", delta: -30 }] },
      { label: "Pay Furrowby for its loss (15 coin)", result: "Fifteen coin and the king's own apology. Furrowby takes both.", effects: [{ kind: "pay", cost: { coin: 15 } }, { kind: "mercy", delta: 2 }] },
      { label: "Say nothing", result: "Nothing is said. Everything is remembered.", effects: [{ kind: "mercy", delta: -4 }, { kind: "unrest", province: "vale-of-the-hare", delta: 6 }] },
    ],
  },

  // == Act III: the Heartland ======================================================
  {
    id: "enc-three-hills", act: 3, kind: "encounter", from: "A herald of the Red March, under a white cloth", title: "The Three Hills",
    trigger: { kind: "actAtLeast", act: 3 },
    text: "The Margrave offers terms once more: go back beyond the Lisle and keep the Vale, or meet the Stag on the three hills above High Tarn, where the Stag has never been moved and does not mean to start. (In a different hand, under the seal:) The Stag will not retreat. Make the Stag spend everything on the strongest of the hills.",
    choices: [
      { label: "Refuse, and march on the hills", result: "The herald rides back. The army marches up the High Tarn road.", effects: [{ kind: "legitimacy", delta: 1 }, { kind: "battle", encounter: "three-hills" }] },
      { label: "Refuse, but not yet march", result: "The herald rides back with a refusal and no date. The Stag waits on the hills.", effects: [{ kind: "followUp", letter: "enc-three-hills", days: 10 }] },
    ],
  },
  {
    id: "enc-rising-water", act: 3, kind: "encounter", from: "Hob Tanner, deserter from the Red March", title: "The Rising Water",
    trigger: all({ kind: "actAtLeast", act: 3 }, { kind: "holdingsHeld", n: 14 }),
    text: "The Wolf means to pin you at the Tarn ford and send the dogs and the lances round both ends of you. It has rained in the hills for a week, and the old soldiers in the Wolf's camp say the Tarn comes up all at once in a wet year and takes the ford. I do not want money; I want to go home, so burn this.",
    choices: [
      { label: "Fight at the ford", result: "The army goes down to Tarnford and watches the sky.", effects: [{ kind: "battle", encounter: "rising-water" }] },
      { label: "Fight, and send Hob Tanner home with pay (5 coin)", result: "Hob Tanner goes home with five coin and a pass in the king's name. The army goes down to the ford.", effects: [{ kind: "pay", cost: { coin: 5 } }, { kind: "mercy", delta: 2 }, { kind: "battle", encounter: "rising-water" }] },
      { label: "Hang the deserter as a spy, then fight", result: "Hob Tanner hangs at the camp gate. The warning was true all the same.", effects: [{ kind: "mercy", delta: -3 }, { kind: "battle", encounter: "rising-water" }] },
    ],
  },
  {
    id: "enc-open-field", act: 3, kind: "encounter", from: ALDOUS, title: "The Crow Comes Out",
    trigger: all({ kind: "actAtLeast", act: 3 }, { kind: "holdingsHeld", n: 16 }),
    text: "I have compared every letter that has come to us since the Reach, and the report that sent us to Wold Barrow is in the Crow's hand, the same hand that wrote our letters in the old war. Now that the Crow is known, there is nowhere to hide: the Crow's host is drawn up on the fields at Barley Green, and the Crow goes for whatever is already hurt. Keep the wounded companies back, and forgive me, but from today read every letter twice.",
    choices: [
      { label: "Meet the Crow in the open", result: "The army marches for Barley Green with its wounded at the back.", effects: [{ kind: "battle", encounter: "open-field" }] },
      { label: "Not yet", result: "The Crow waits on the fields, picking at whatever comes near.", effects: [{ kind: "followUp", letter: "enc-open-field", days: 12 }] },
    ],
  },
  {
    id: "enc-the-colours", act: 3, kind: "encounter", from: "The Stag, captain of the Red March, in the Stag's own hand", title: "The Colours",
    trigger: all({ kind: "encounterFought", encounter: "three-hills" }, { kind: "encounterFought", encounter: "open-field" }),
    text: "At High Tarn we did not meet company to company, and I do not hold it against you; it was not that kind of day. Tomorrow, on the downs above Gullwick by the old cairn, it is: bring your standard and guard it well, and take mine if you can. Whoever is left holding a standard at sunset may speak for the country.",
    choices: [
      { label: "Bring the standard", result: "The king's colours go down to the coast, with the best of the army round them.", effects: [{ kind: "battle", encounter: "the-colours" }] },
      { label: "Decline the challenge", result: "The Stag's herald goes back with a refusal. The Stag is said to have laughed, and then not laughed.", effects: [{ kind: "legitimacy", delta: -3 }] },
    ],
  },
  {
    id: "stag-yields", act: 3, kind: "fork", from: ALDOUS, title: "The Stag's Sword",
    trigger: { kind: "encounterWon", encounter: "the-colours" },
    text: "The Stag is alive, under guard, and asks to speak to {king} alone. The Stag says the Margrave is finished, that the Chancellor never meant the Menagerie to outlive its use, and that the Stag would rather choose a side than be thrown away by one.",
    choices: [
      { label: "Take the Stag's sword and oath", result: "The Stag kneels on the downs and swears. Half the Heights swears with the Stag by the end of the month.", effects: [{ kind: "captainSworn", faction: "stag" }, { kind: "legitimacy", delta: 3 }, { kind: "flag", flag: "stag-sworn" }] },
      { label: "Send the Stag home on parole", result: "The Stag goes home to Stagcrown on a borrowed horse and a word given. The Heights watch to see if the word is kept.", effects: [{ kind: "mercy", delta: 3 }, { kind: "flag", flag: "stag-paroled" }] },
      { label: "Hang the Stag at High Tarn", result: "The Stag hangs on the hill where the Stag would not be moved. The Heights are quiet, the way a held breath is quiet.", effects: [{ kind: "mercy", delta: -6 }, { kind: "legitimacy", delta: -2 }, { kind: "flag", flag: "stag-hanged" }] },
    ],
  },
  {
    id: "isolde-fork", act: 3, kind: "fork", from: "Isolde, who was Regent", title: "At Mere Shrine",
    trigger: all({ kind: "actAtLeast", act: 3 }, { kind: "holdingsHeld", n: 18 }),
    text: "I am at Mere Shrine with two servants and no guard, and I will wait three days. I can tell you who wrote the order I signed, and why I signed it, and then you can decide what I am; I have stopped being able to.",
    choices: [
      { label: "Name Isolde a traitor before the lords", result: "Isolde is taken at the shrine and named before the lords of the heartland. Isolde escapes the same night, south, to Rimaros, and to the Chancellor.", effects: [{ kind: "flag", flag: "isolde-villain" }, { kind: "legitimacy", delta: 3 }, { kind: "mercy", delta: -3 }] },
      { label: "Let Isolde go, quietly", result: "{king} sends word that nobody will come to the shrine. Isolde takes ship at Wrackhythe and is not heard of again.", effects: [{ kind: "flag", flag: "isolde-coward" }, { kind: "mercy", delta: 2 }] },
      { label: "Send Isolde back to Rimaros, as the king's eyes", requires: { kind: "notFlag", flag: "isolde-scorned" }, result: "{king} rides to the shrine alone. Isolde goes back to the Crown Seat the next morning, carrying nothing in writing and a great deal in memory.", effects: [{ kind: "flag", flag: "isolde-ally" }, { kind: "mercy", delta: 1 }] },
    ],
  },
  {
    id: "isolde-reread-wall", act: 3, kind: "reread", from: ALDOUS, title: "The Regent's Last Letter, Read Again",
    trigger: any(flag("isolde-villain"), flag("isolde-coward"), flag("isolde-ally")),
    text: "The last letter the Regent wrote in the old war ends: 'I find I am not afraid that you will fail.' I copied it at the time without a second thought, and I have been thinking about it ever since Mere Shrine.",
    choices: [
      { label: "Keep it", result: "It goes in the oilcloth. Whatever Isolde is, Isolde wrote that.", effects: [{ kind: "flag", flag: "kept-isolde-letters" }] },
      { label: "Give it to the king to keep", result: "{king} reads it once and puts it inside the cloak, where Brother Aldous cannot reach it.", effects: [{ kind: "mercy", delta: 1 }] },
    ],
  },
  {
    id: "chancellor-revealed", act: 3, kind: "reveal", from: ALDOUS, title: "The Hand Behind the Hands",
    trigger: all({ kind: "actAtLeast", act: 3 }, any({ kind: "encounterFought", encounter: "open-field" }, { kind: "holdingsHeld", n: 22 }, all(flag("second-seal"), { kind: "holdingsHeld", n: 18 }))),
    text: "The order of exile, the forged report from the Wold, and the Crow's letters from the old war were all drafted on the same paper, ruled in the same way, by clerks of the Chancery. The Margrave was paid and the Regent was told what to sign; Chancellor Oswin Vael holds the Crown Seat, and always meant to.",
    choices: [
      { label: "Proclaim it in every market", result: "Criers go out from every town the king holds. By the end of the month the Chancellor's name is said in the alehouses the way the Margrave's used to be.", effects: [{ kind: "flag", flag: "vael-named" }, { kind: "legitimacy", delta: 6 }] },
      { label: "Lay the copies before the lords in private", requires: flag("kept-isolde-letters"), result: "Brother Aldous sets the Regent's letters beside the forged ones, hand by hand, before the lords of the heartland. Nobody who sees it argues.", effects: [{ kind: "flag", flag: "vael-named" }, { kind: "flag", flag: "lords-convinced" }, { kind: "legitimacy", delta: 8 }] },
      { label: "Keep it close, for the gates", result: "Brother Aldous locks the proof in the ledger box. The Chancellor does not yet know that we know.", effects: [{ kind: "flag", flag: "vael-secret" }] },
    ],
  },
  {
    id: "isolde-proof", act: 3, kind: "reveal", from: "Isolde, at the Crown Seat", title: "The Chancery's Book",
    trigger: all(flag("isolde-ally"), { kind: "encounterFought", encounter: "open-field" }),
    text: "Enclosed is a page torn from the Chancery's own book of payments: so much to the Margrave, so much to each captain by badge, and a line for the clerk who copies hands. I will not be able to send another; the clerk who kept the book has started counting the pages.",
    choices: [
      { label: "Send copies to every hall", result: "The page is copied forty times by Brother Aldous and by everyone else who can write, which in this army is not many.", effects: [{ kind: "flag", flag: "vael-named" }, { kind: "legitimacy", delta: 5 }] },
      { label: "Burn it, to keep Isolde safe", result: "The page burns. If the Chancellor counts the pages again, the count will be one short and no copy will be found.", effects: [{ kind: "mercy", delta: 2 }, { kind: "flag", flag: "isolde-shielded" }] },
    ],
  },
  {
    id: "margrave-falls", act: 3, kind: "fork", from: ALDOUS, title: "The Margrave at Redcastle",
    trigger: { kind: "holdingHeld", holding: "redcastle" },
    text: "The Margrave of the Red March was found in the chapel at Redcastle in a clean shirt, waiting. The Margrave says only that it was the Chancellor's war and the Margrave's mistake, and asks to know which of those {king} means to punish.",
    choices: [
      { label: "Pardon the Margrave on oath", result: "The Margrave swears on the Redcastle altar and is set to guarding the March for the crown it once overthrew. Some think it generous and some think it mad.", effects: [{ kind: "mercy", delta: 4 }, { kind: "legitimacy", delta: -1 }, { kind: "flag", flag: "margrave-pardoned" }, { kind: "captainSworn", faction: "margrave" }, { kind: "unlockAbility", ability: "parley" }] },
      { label: "Try the Margrave in open court", result: "The trial takes three days and is attended by everyone who can walk to Redcastle. The sentence is exile, to the Reach.", effects: [{ kind: "legitimacy", delta: 4 }, { kind: "flag", flag: "margrave-tried" }] },
      { label: "Hang the Margrave from the gate", result: "The Margrave hangs from the gate of Redcastle in the clean shirt. The March is quiet after, and so are the people who were about to come over to the king.", effects: [{ kind: "mercy", delta: -6 }, { kind: "legitimacy", delta: 1 }, { kind: "flag", flag: "margrave-hanged" }] },
    ],
  },
  {
    id: "counter-invasion", act: 3, kind: "warning", from: "Harker's Outriders, or whoever saw them first", title: "Riders on the Lisle Road",
    trigger: all({ kind: "actAtLeast", act: 3 }, { kind: "holdingsHeld", n: 18 }),
    text: "Riders on the Lisle road, a great many, three days out and coming for whatever the king holds that is thinly held. The crown means to take back a province and keep it, to show the lords that the exile's gains do not last.",
    choices: [
      { label: "Burn the fields in their path", result: "The fields go up along the Lisle road. The riders will go hungry, and so will everyone who lives there.", effects: [{ kind: "mercy", delta: -3 }, { kind: "legitimacy", delta: -1 }, { kind: "flag", flag: "fields-burned" }] },
      { label: "Call the levy (10 coin)", result: "The levy comes in from every holding, half-armed and wholly willing.", effects: [{ kind: "pay", cost: { coin: 10 } }, { kind: "gain", gains: { levy: 8 } }] },
      { label: "Garrison and wait", result: "The garrisons close their gates and the king's armies take their places. The riders will find out who holds what.", effects: [] },
    ],
  },
  {
    id: "lords-gather", act: 3, kind: "beat", from: ALDOUS, title: "The Lords Come to Look",
    trigger: all({ kind: "actAtLeast", act: 3 }, { kind: "legitimacyAtLeast", n: 30 }),
    text: "The lords of the heartland have begun to arrive at the king's camp one at a time, with small retinues and large curiosity. They have come to see whether the exile is a king; they will decide by what they are given and how they are kept waiting.",
    choices: [
      { label: "Hold court and hear their grievances", result: "{king} sits for three days on a camp stool and hears every grievance in the heartland. Most of them are about the Chancellor.", effects: [{ kind: "legitimacy", delta: 4 }, { kind: "mercy", delta: 2 }] },
      { label: "Feast them (20 grain, 10 coin)", result: "They eat well and talk better. Feasts are a kind of argument.", effects: [{ kind: "pay", cost: { grain: 20, coin: 10 } }, { kind: "legitimacy", delta: 6 }] },
      { label: "Keep them waiting: the war comes first", result: "The lords wait, and go home, and say that the exile is busy. It is not quite a compliment.", effects: [{ kind: "legitimacy", delta: -2 }] },
    ],
  },
  {
    id: "offer-vane", act: 3, kind: "offer", from: "Adept Vane", title: "The Unlicensed",
    trigger: { kind: "actAtLeast", act: 3 },
    text: "The crown licensed every Adept it could find, and hanged the rest. We are the rest, and we would like a king who owes us something.",
    choices: [
      { label: "Hire the Adepts (50 coin)", result: "Vane's Adepts come in after dark. The followers make the sign against harm and then ask them for help with the fires.", effects: [{ kind: "pay", cost: { coin: 50 } }, { kind: "hire", company: "vane-adepts" }, { kind: "legitimacy", delta: -2 }] },
      { label: "Promise them a licence, after", result: "Vane takes the promise and no coin, and says it will be remembered. It sounds like both a thanks and a warning.", effects: [{ kind: "flag", flag: "adepts-promised" }] },
      { label: "Send them away", result: "They go before morning, leaving the fires burning better than they were.", effects: [] },
    ],
  },
  {
    id: "offer-selby", act: 3, kind: "offer", from: "Captain Selby, of Selby's Champions", title: "Champions",
    trigger: all({ kind: "actAtLeast", act: 3 }, { kind: "holdingsHeld", n: 20 }),
    text: "Every one of us has won a prize at a fair or a duel at a gate, and some of us both. We fight for whoever is winning, and today that is you.",
    choices: [
      { label: "Hire the Champions (35 coin)", result: "Selby's Champions parade through the camp. The followers cheer, which is what Champions are for.", effects: [{ kind: "pay", cost: { coin: 35 } }, { kind: "hire", company: "selby-champions" }, { kind: "followUp", letter: "selby-bid", days: 30 }] },
      { label: "Not today", result: "Selby bows, beautifully, and goes to see who else is winning.", effects: [] },
    ],
  },
  {
    id: "selby-bid", act: 3, kind: "betrayal", from: ALDOUS, title: "Whoever Is Winning",
    trigger: null,
    text: "The Chancellor's agents have been at Selby's fire with a purse twice the size of ours and a story about who is winning now. Captain Selby has asked, quite openly, what we mean to do about it.",
    choices: [
      { label: "Double their wage for the season (30 coin)", result: "Selby takes it with a flourish. The Champions are ours until someone pays more.", requires: { kind: "companyHired", company: "selby-champions" }, effects: [{ kind: "pay", cost: { coin: 30 } }, { kind: "loyalty", company: "selby-champions", delta: 25 }] },
      { label: "Tell Selby to go and be damned", result: "The Champions go to the Chancellor, magnificently. We will meet them again.", effects: [{ kind: "companyLeaves", company: "selby-champions", how: "defected" }] },
    ],
  },

  // == Act IV: the Crown ===========================================================
  {
    id: "vael-offer", act: 4, kind: "demand", from: "Oswin Vael, Chancellor of Rimaros", title: "The Chancellor Writes",
    trigger: { kind: "actAtLeast", act: 4 },
    text: "The realm is tired, and so, I imagine, are you: a pension, a ship and a house over the sea, and a regency council in which your name is spoken first. Refuse, and the Crown Seat will be defended by people who have nothing left to lose, which I am told is the most dangerous kind.",
    choices: [
      { label: "Refuse", result: "The Chancellor's messenger goes back with one word. It is not a long word.", effects: [{ kind: "legitimacy", delta: 2 }] },
      { label: "Pretend to accept, and buy a month", result: "A month of letters back and forth, while the army comes up the Kingsmere road. When it is over everyone knows the king lied, and most of them think the Chancellor deserved it.", effects: [{ kind: "legitimacy", delta: -3 }, { kind: "flag", flag: "lied-to-vael" }] },
      { label: "Answer with the Chancery's own proof", requires: flag("vael-secret"), result: "The proof goes to the Chancellor and to every hall at once. The Crown Seat's own garrison reads it.", effects: [{ kind: "legitimacy", delta: 6 }, { kind: "flag", flag: "vael-named" }, { kind: "unflag", flag: "vael-secret" }] },
    ],
  },
  {
    id: "enc-last-wall", act: 4, kind: "encounter", from: ALDOUS, title: "The Last Wall",
    trigger: all({ kind: "actAtLeast", act: 4 }, { kind: "notFlag", flag: "isolde-ally" }),
    text: "The Badger has dug in on the heights before Rimaros with the Chancellor's siege train behind, and the heights must be ours before the walls can be. In the old war these same heights were held against the Margrave; now we are the ones coming up them.",
    choices: [
      { label: "Take the heights", result: "The army goes up the Kingsmere road toward the Badger's diggings.", effects: [{ kind: "battle", encounter: "last-wall" }] },
      { label: "Not yet", result: "The Badger digs a little deeper. The Badger always does.", effects: [{ kind: "followUp", letter: "enc-last-wall", days: 10 }] },
    ],
  },
  {
    id: "enc-last-wall-ally", act: 4, kind: "encounter", from: "Isolde, at the Crown Seat", title: "The Last Wall",
    trigger: all({ kind: "actAtLeast", act: 4 }, flag("isolde-ally")),
    text: "It comes to this, then: the Badger is on the heights with the siege train, and the Chancellor is behind the walls with everyone left. I cannot open a gate, but I can see that the Badger is told the wrong hour; you do not have to win, only still be on the heights when the Badger expects you to be gone.",
    choices: [
      { label: "Take the heights at Isolde's hour", result: "The army goes up the Kingsmere road at the hour Isolde named. The Badger is facing the other way.", effects: [{ kind: "battle", encounter: "last-wall" }] },
      { label: "Not yet", result: "Isolde will have to find another wrong hour. There are only so many.", effects: [{ kind: "followUp", letter: "enc-last-wall-ally", days: 10 }] },
    ],
  },
  {
    id: "heights-again", act: 4, kind: "encounter", from: ALDOUS, title: "The Heights Again",
    trigger: null,
    text: "The Badger is still on the heights before Rimaros, and has dug the diggings deeper since we were last there. Bring something that breaks a line; the sergeants have stopped saying it, because everyone knows.",
    choices: [
      { label: "Go up the heights again", result: "The army goes back up the Kingsmere road, more slowly than the first time and more carefully.", effects: [{ kind: "battle", encounter: "last-wall" }] },
      { label: "Not yet", result: "The army mends on the Kingsmere road. The Badger digs.", effects: [{ kind: "followUp", letter: "heights-again", days: 10 }] },
    ],
  },
  {
    id: "isolde-holds-gate", act: 4, kind: "beat", from: ALDOUS, title: "Isolde on the Gate",
    trigger: all(flag("isolde-villain"), { kind: "encounterFought", encounter: "last-wall" }),
    text: "Isolde is on the gatehouse of the Crown Seat beside the Chancellor, in plain view of the army, and has sent down a letter that says only: 'You named me. I have become it.'",
    choices: [
      { label: "Send back an offer of pardon", result: "The offer goes up the wall on a pole and does not come down again. The army saw it go.", effects: [{ kind: "mercy", delta: 3 }] },
      { label: "Promise the gatehouse fire", result: "The answer is shouted up the wall. The garrison of the gatehouse hears it, and so does the army, and so does the city behind.", effects: [{ kind: "mercy", delta: -4 }, { kind: "legitimacy", delta: -3 }, { kind: "flag", flag: "gatehouse-threatened" }] },
    ],
  },
  {
    id: "sack-kingsmere", act: 4, kind: "fork", from: ALDOUS, title: "Kingsmere",
    trigger: { kind: "holdingHeld", holding: "kingsmere" },
    text: "Kingsmere is the king's again, and the army that took it has not been paid in a month. They are asking, politely for now, for a day in the town.",
    choices: [
      { label: "Let them have the town for a day", result: "They have it. Kingsmere will be paying for that day long after the war, and so will the king's name.", effects: [{ kind: "gain", gains: { coin: 40 } }, { kind: "mercy", delta: -6 }, { kind: "legitimacy", delta: -4 }, { kind: "flag", flag: "kingsmere-sacked" }] },
      { label: "Pay them from the stores (30 coin)", result: "Thirty coin goes round the army. Kingsmere opens its shutters by evening.", effects: [{ kind: "pay", cost: { coin: 30 } }, { kind: "mercy", delta: 2 }] },
      { label: "Hang the first looter", result: "One looter hangs in Kingsmere market. The rest of the army goes back to camp, muttering, and stays there.", effects: [{ kind: "mercy", delta: -2 }, { kind: "legitimacy", delta: 1 }] },
    ],
  },
  {
    id: "lords-price", act: 4, kind: "demand", from: "The lords of the heartland, jointly", title: "The Lords' Price",
    trigger: all({ kind: "actAtLeast", act: 4 }, { kind: "encounterFought", encounter: "last-wall" }),
    text: "We will stand with the king before the walls of Rimaros, and we will stand at the coronation, if the king restores the rights the Chancellor took: our courts, our tolls and our levies, as they were. We ask it now because after the walls fall we will not be able to.",
    choices: [
      { label: "Grant them their old rights", result: "The rights are granted under the old seal. The lords stand with the king; the villages under them know exactly what it means.", effects: [{ kind: "legitimacy", delta: 5 }, { kind: "unrest", province: "any", delta: 5 }, { kind: "flag", flag: "lords-rights-restored" }] },
      { label: "Refuse: the crown keeps the courts", result: "The lords go back to their tents to think about it. Some are gone in the morning.", effects: [{ kind: "legitimacy", delta: -5 }, { kind: "mercy", delta: 2 }] },
      { label: "Grant the courts, keep the levies", result: "Half a bargain, which leaves everyone half content and nobody at all fooled.", effects: [{ kind: "legitimacy", delta: 2 }] },
    ],
  },
  {
    id: "offer-blackwood", act: 4, kind: "offer", from: "Master Gunner Blackwood", title: "Engines",
    trigger: { kind: "actAtLeast", act: 4 },
    text: "Walls are my whole trade, and Rimaros has the finest in the realm. I would be sorry to see them come down, and sorrier to see somebody else do it.",
    choices: [
      { label: "Hire the Battery (60 coin)", result: "Blackwood's Battery come up the road with their engines under canvas, walking beside them like nurses.", effects: [{ kind: "pay", cost: { coin: 60 } }, { kind: "hire", company: "blackwood-battery" }, { kind: "unlockAbility", ability: "firepots" }] },
      { label: "Not now", result: "Blackwood goes back to measuring the walls from a safe distance, for pleasure.", effects: [{ kind: "followUp", letter: "offer-blackwood", days: 15 }] },
    ],
  },
  {
    id: "enc-crown-siege", act: 4, kind: "encounter", from: ALDOUS, title: "The Walls of Rimaros",
    trigger: all({ kind: "actAtLeast", act: 4 }, { kind: "roadToCrownSeat" }, { kind: "encounterFought", encounter: "last-wall" }),
    text: "The heights are ours, the road is open, and the walls of the Crown Seat are in front of us with the Chancellor behind them. This is the page I have been keeping room for since the Reach.",
    choices: [
      { label: "Lay siege to Rimaros", result: "The army comes down off the heights and the engines go forward.", effects: [{ kind: "battle", encounter: "crown-siege" }] },
      { label: "Not yet", result: "The army waits on the heights. So does the city.", effects: [{ kind: "followUp", letter: "enc-crown-siege", days: 10 }] },
    ],
  },
];
