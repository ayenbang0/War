/**
 * Scripted encounters (PLAN.md §A.2, §A.5; phase K9): the Marchwarden's
 * Chronicle re-cast.
 *
 * The old campaign (content/campaign.ts) was nine battles in a chain, fought
 * by a Marchwarden defending the Vale. In the Exile of Rimaros that war is
 * the BACKSTORY: it was fought years ago, the Margrave sued for terms, and the
 * terms made the eight beast captains the crown's governors. Its battles now
 * come back as each captain's FIRST ENCOUNTER with the exiled king, at a real
 * holding on the kingdom map, reusing the chapter's battle setup -- its
 * battlefield (level), its captain and its difficulty -- so the Boar a letter
 * warns of is the Boar whose habit the battle AI plays.
 *
 * An encounter is fought when a story choice's `battle` effect names it (the
 * pre-battle letter lives in letters.ts, kind "encounter"). The battle itself
 * is K5's: who ends up owning the holding, survivors, plunder and the rest
 * come from its BattleResult. What lives here is only what the STORY adds on
 * top -- the chronicle entry for a win and a loss, and the story effects of
 * each (legitimacy, an ability the army learned, a flag, the next letter).
 *
 * Every field the old chapter had is checked against it by validate-story.ts:
 * the level and the captain must be the chapter's, and the difficulty may only
 * be the chapter's or harder (a captain met late has had time to dig in). The
 * holding's own country must fight like the level (terrain.ts BIOMES), or be
 * that level's siege version.
 *
 * Captains are people known by the badge they fight under; the text calls
 * each "the Boar", "the Fox" and "they", never a gendered pronoun.
 */

import type { CommanderId } from "../commanders.ts";
import type { DifficultyId } from "../difficulty.ts";
import type { FactionId } from "../kingdom/factions.ts";
import type { ActId, StoryEffect } from "./vocab.ts";

export type EncounterDef = {
  readonly id: string;
  /** The Marchwarden chapter this re-casts (campaign.ts), or null for one written new. */
  readonly chapter: string | null;
  readonly act: ActId;
  /** Where it is fought: a holding key on the map. */
  readonly holding: string;
  /** Whose army the king meets. */
  readonly faction: FactionId;
  /** Whose habits the battle AI plays (commanders.ts). */
  readonly commander: CommanderId;
  readonly levelId: string;
  readonly difficulty: DifficultyId;
  /** The king's first battle with this captain on this road of the story. */
  readonly first: boolean;
  /** Brother Aldous's entry afterwards, for a victory and for a defeat. */
  readonly won: string;
  readonly lost: string;
  readonly wonEffects: readonly StoryEffect[];
  readonly lostEffects: readonly StoryEffect[];
};

export const ENCOUNTERS: readonly EncounterDef[] = [
  // -- Act I -----------------------------------------------------------------------
  {
    id: "burning-farms", chapter: "burning-farms", act: 1, holding: "hareford",
    faction: "hare", commander: "hare", levelId: "proving-ground", difficulty: "recruit", first: true,
    won: "The Hare's riders came at Hareford three times and the third time they did not come back. {king} held the valley road by dusk with followers who had been shepherds in the autumn.",
    lost: "The Hare would not be caught and the followers would not hold, and Hareford burned. Most of them came back to Rookstead; it was a bad beginning, and I have written it down as one.",
    wonEffects: [{ kind: "legitimacy", delta: 3 }, { kind: "unlockAbility", ability: "levy" }],
    lostEffects: [{ kind: "legitimacy", delta: -1 }, { kind: "followUp", letter: "hare-returns", days: 20 }],
  },

  // -- Act II ----------------------------------------------------------------------
  {
    id: "three-bridges", chapter: "three-bridges", act: 2, holding: "three-bridges",
    faction: "badger", commander: "badger", levelId: "the-crossing", difficulty: "recruit", first: true,
    won: "{king} put the Badger off the bridges in one afternoon, which the old soldiers said could not be done twice in one lifetime. Two roads open from the Lisle now, and both need the army.",
    lost: "The bridges held against us. The Badger did not pursue, which the Badger never does, and we went round by the fords at the cost of two days.",
    wonEffects: [{ kind: "legitimacy", delta: 2 }, { kind: "unlockAbility", ability: "caltrops" }],
    lostEffects: [],
  },
  {
    id: "starving-town", chapter: "starving-town", act: 2, holding: "hallow-ferry",
    faction: "owl", commander: "owl", levelId: "ferry-road", difficulty: "sergeant", first: true,
    won: "Forty-odd of the king's people reached the ferry landing with the Owl's companies still drawn up across the road, waiting for an attack that had gone round them. The boats came across at dawn, and the reeve wept.",
    lost: "We could not get through; the Owl was always where we went. Hallow Ferry opened its gate to the crown three days later, and the reeve was not among those who walked out.",
    wonEffects: [{ kind: "legitimacy", delta: 4 }, { kind: "mercy", delta: 2 }, { kind: "flag", flag: "ferry-relieved" }, { kind: "unlockAbility", ability: "flare" }],
    lostEffects: [{ kind: "flag", flag: "mallow-dead" }],
  },
  {
    id: "long-wood", chapter: "long-wood", act: 2, holding: "ashgrove",
    faction: "boar", commander: "boar", levelId: "long-vigil", difficulty: "sergeant", first: true,
    won: "The Long Wood held for nine days and the Boar left half its companies in it. Word came in that time that Hallow Ferry had opened its gates; {king} did not speak of it, and I record what it cost.",
    lost: "The Boar came through the wood in four days and Ashgrove burned behind the Boar's riders. I set it down without excuse: the choice was made, and it failed.",
    wonEffects: [{ kind: "legitimacy", delta: 3 }, { kind: "unlockAbility", ability: "smoke" }],
    lostEffects: [{ kind: "unrest", province: "long-wood", delta: 10 }],
  },
  {
    // The road not taken at the fork comes back: the Owl still holds the town.
    id: "owl-late", chapter: "starving-town", act: 2, holding: "hallow-ferry",
    faction: "owl", commander: "owl", levelId: "ferry-road", difficulty: "captain", first: true,
    won: "Hallow Ferry was taken back from the Owl on a day its reeve did not live to see. The people came down to the landing all the same, and some of them cheered.",
    lost: "The Owl answered every move we made at Hallow Ferry, as it answered the reeve's sallies in the starving months. The town stays the crown's.",
    wonEffects: [{ kind: "legitimacy", delta: 3 }, { kind: "unlockAbility", ability: "flare" }],
    lostEffects: [],
  },
  {
    // ...or the Boar does, deeper in the wood than before.
    id: "boar-late", chapter: "long-wood", act: 2, holding: "boarsden",
    faction: "boar", commander: "boar", levelId: "long-vigil", difficulty: "captain", first: true,
    won: "We went into the Long Wood after the Boar, as far as Boarsden, and the Boar came straight at us, as the Boar always does. The Boar's riders did not come back out of the trees.",
    lost: "The Boar came straight at the centre and kept coming, and the centre did not hold. We left the wood the way we came in.",
    wonEffects: [{ kind: "legitimacy", delta: 3 }, { kind: "unlockAbility", ability: "smoke" }],
    lostEffects: [{ kind: "unrest", province: "long-wood", delta: 10 }],
  },
  {
    // The forged scout report, re-cast: same hand, new barrow.
    id: "the-stones", chapter: "the-stones", act: 2, holding: "wold-barrow",
    faction: "fox", commander: "fox", levelId: "night-stones", difficulty: "captain", first: true,
    won: "The barrow was not empty: the Fox was in the heather with every company it had. We held the mound until morning all the same, and in the courier's saddlebag we found a second seal, not ours.",
    lost: "The barrow was not empty, and the report had been written to bring us there in the dark, and it did. In the courier's saddlebag we found a second seal, not ours.",
    wonEffects: [{ kind: "legitimacy", delta: 3 }, { kind: "flag", flag: "second-seal" }, { kind: "unlockAbility", ability: "beacon" }],
    lostEffects: [{ kind: "flag", flag: "second-seal" }],
  },

  // -- Act III ---------------------------------------------------------------------
  {
    id: "three-hills", chapter: "three-hills", act: 3, holding: "high-tarn",
    faction: "stag", commander: "stag", levelId: "high-ground", difficulty: "captain", first: true,
    won: "We refused the terms and took two of the three hills above High Tarn and kept them. The Stag sent word after, by the Stag's own herald and not the Margrave's: they would meet {king} again, under colours.",
    lost: "We refused the terms and could not take the hills; the Stag stood on the heights and let us break ourselves against them. The Stag's herald came after all the same: they would meet {king} again, under colours.",
    wonEffects: [{ kind: "legitimacy", delta: 4 }, { kind: "unlockAbility", ability: "shield" }],
    lostEffects: [],
  },
  {
    id: "rising-water", chapter: "rising-water", act: 3, holding: "tarnford",
    faction: "wolf", commander: "wolf", levelId: "rising-water", difficulty: "captain", first: true,
    won: "The Tarn came up at the seventh hour as the deserter said it would, and the Wolf's pack was on the wrong bank of it. Asked whether we should have trusted a deserter, {king} said we had trusted nobody: we had listened, and then looked at the sky.",
    lost: "The river came up when the deserter said it would, and it was we who were on the wrong bank. Being warned is not the same as being ready; I write that down for whoever reads this next.",
    wonEffects: [{ kind: "legitimacy", delta: 4 }, { kind: "unlockAbility", ability: "forcedMarch" }],
    lostEffects: [],
  },
  {
    id: "open-field", chapter: "open-field", act: 3, holding: "barley-green",
    faction: "crow", commander: "crow", levelId: "open-field", difficulty: "colonel", first: true,
    won: "The Crow came out onto the open fields at Barley Green and could find nothing weak enough to pick at, and the Crow's host broke in the afternoon. In the Crow's tent was a letter for the Margrave: 'The Stag has asked for the colours. Let the Stag have them.'",
    lost: "The Crow picked the army apart company by company on the open field, as I had feared. On a dead courier we found a letter for the Margrave: 'The Stag has asked for the colours. Let the Stag have them.'",
    wonEffects: [{ kind: "legitimacy", delta: 5 }, { kind: "unlockAbility", ability: "charge" }],
    lostEffects: [],
  },
  {
    // The Stag's second meeting, by the Stag's own challenge.
    id: "the-colours", chapter: "the-colours", act: 3, holding: "gullwick",
    faction: "stag", commander: "stag", levelId: "the-colours", difficulty: "colonel", first: false,
    won: "The king's colours were still flying at sunset on the downs above Gullwick, and the Stag's were in the royal tent. The Stag was carried off the field alive and asked to see {king}.",
    lost: "The Stag took our colours at the cairn, as sworn, and did not keep them: they came back the next morning under a white cloth. The Stag wrote only that it had been a fair day.",
    wonEffects: [{ kind: "legitimacy", delta: 5 }, { kind: "unlockAbility", ability: "muster" }],
    lostEffects: [{ kind: "legitimacy", delta: -2 }],
  },

  // -- Act IV ----------------------------------------------------------------------
  {
    id: "last-wall", chapter: "last-wall", act: 4, holding: "kingsmere",
    faction: "badger", commander: "badger", levelId: "last-wall", difficulty: "colonel", first: false,
    won: "The heights before Rimaros were ours by evening, and the Badger's diggings were full of the Badger's own engines, left behind. From the heights you can see the Crown Seat's walls, and the walls can see us.",
    lost: "The Badger held the heights before Rimaros, as the Badger holds everything, by refusing to leave. We fell back down the Kingsmere road to count who was left.",
    wonEffects: [{ kind: "legitimacy", delta: 5 }, { kind: "unlockAbility", ability: "barrage" }],
    lostEffects: [{ kind: "legitimacy", delta: -2 }, { kind: "followUp", letter: "heights-again", days: 15 }],
  },
  {
    // Written new: the old chronicle ended before the Crown Seat's own walls.
    // The Chancellor has no battle commander; the garrison fights like the Owl.
    id: "crown-siege", chapter: null, act: 4, holding: "rimaros",
    faction: "usurper", commander: "owl", levelId: "last-wall-siege", difficulty: "marshal", first: true,
    won: "The wall came down on the river side at noon, and by dusk {king} stood in the hall where the council had decided it no longer needed a king. Nobody in it said anything for a long while.",
    lost: "The walls of Rimaros held. The Chancellor watched from the gatehouse and did not come down, and we drew off to the heights to begin again.",
    wonEffects: [{ kind: "flag", flag: "walls-breached" }],
    lostEffects: [{ kind: "legitimacy", delta: -3 }, { kind: "followUp", letter: "enc-crown-siege", days: 20 }],
  },
];
