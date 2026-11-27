/**
 * The host each scripted encounter puts in the field (phase K9).
 *
 * encounters.ts says where a captain's first battle with the king is fought,
 * on which battlefield, under whose habits and at what difficulty; it does not
 * say WHO stands there, because K9 had to decide how an encounter comes to be
 * fought on the kingdom map. The answer (docs/PROVISIONAL.md K9.4): a story
 * choice's `battle` effect raises this host for the encounter's faction at the
 * encounter's holding, dug in and left out of the captain's AI, and the king
 * fights it by marching there. A contact with it is the encounter: the battle
 * takes the encounter's level, captain and difficulty.
 *
 * The mixes grow with the act, as the captains' own armies do, and lean on
 * each captain's badge (the Hare rides light, the Badger digs, the Boar
 * comes heavy). Act I's is small on purpose: the first battle of the story
 * is fought with three followers' worth of levy.
 *
 * Plain data; validated by tools/story-check.ts against ENCOUNTERS and the
 * unit table.
 */

import type { UnitTypeId } from "../unit-types.ts";

export const ENCOUNTER_HOSTS: Readonly<Record<string, readonly UnitTypeId[]>> = {
  "burning-farms": ["scout", "skirmisher"],
  "three-bridges": ["line", "pike", "archer"],
  "starving-town": ["archer", "crossbow", "line"],
  "long-wood": ["line", "guard", "champion"],
  "owl-late": ["archer", "crossbow", "line", "line"],
  "boar-late": ["line", "guard", "champion", "pike"],
  "the-stones": ["skirmisher", "scout", "archer"],
  "three-hills": ["guard", "line", "pike", "archer"],
  "rising-water": ["horse", "lancer", "line", "skirmisher"],
  "open-field": ["horse", "archer", "line", "crossbow"],
  "the-colours": ["guard", "line", "lancer", "archer"],
  "last-wall": ["pike", "line", "crossbow", "guard"],
  "crown-siege": ["guard", "line", "crossbow", "archer", "pike"],
};
