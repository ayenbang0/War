/**
 * The free companies the story offers (PLAN.md §A.4, §B.7; phase K9, ahead
 * of K7's contracts).
 *
 * Named the way content/companies.ts names any company the player gathers:
 * a surname from its table and the style of what the company is mostly made
 * of ("Redmayne's Lances"). Each entry records the `nameId` and `dominant`
 * type that produce its name, and validate-story.ts checks that
 * `companyName(nameId, dominant)` really is `name` -- one naming rule for a
 * company raised in battle and a company hired in a tavern, so the after-action
 * report and the story letter never disagree about who broke on the left.
 *
 * Prices are in the realm's coin (pennies, K3.1); wages are per day. Loyalty
 * is K7's 0..100. Reputation is B.7's word for how they tend to end:
 *   reliable   keep a contract while they are paid
 *   bloody     keep it, and make the king's name worse while they do
 *   turncoats  cheap, and for sale to the next bidder
 * Every number is PROVISIONAL (docs/PROVISIONAL.md K9s.6).
 */

import type { UnitTypeId } from "../unit-types.ts";
import type { ActId } from "./vocab.ts";

export type Reputation = "reliable" | "bloody" | "turncoats";

export type MercenaryDef = {
  readonly id: string;
  /** As companies.ts would name it: SURNAMES[nameId % 16] + "'s " + style of `dominant`. */
  readonly name: string;
  readonly nameId: number;
  readonly dominant: UnitTypeId;
  /** The squads it brings, by type (the existing 20 types; one rulebook). */
  readonly mix: readonly UnitTypeId[];
  /** Who leads it, as the letters write them. */
  readonly captain: string;
  readonly fee: number;
  readonly wage: number;
  readonly contractDays: number;
  readonly loyalty: number;
  readonly reputation: Reputation;
  /** The act whose letters first offer it. */
  readonly act: ActId;
  /** One line for a card. */
  readonly about: string;
};

export const MERCENARIES: readonly MercenaryDef[] = [
  {
    id: "harker-outriders", name: "Harker's Outriders", nameId: 15, dominant: "scout",
    mix: ["scout", "scout", "horse"], captain: "Captain Harker",
    fee: 8, wage: 1, contractDays: 60, loyalty: 60, reputation: "reliable", act: 1,
    about: "A handful of scouts who outlived their last employer and would like to outlive the next.",
  },
  {
    id: "redmayne-lances", name: "Redmayne's Lances", nameId: 4, dominant: "lancer",
    mix: ["lancer", "lancer", "horse", "wagon"], captain: "Captain Redmayne",
    fee: 40, wage: 3, contractDays: 90, loyalty: 70, reputation: "reliable", act: 2,
    about: "Dear, slow to hire and slower to leave. They have never broken a contract that was paid.",
  },
  {
    id: "halloway-horse", name: "Halloway's Horse", nameId: 2, dominant: "horse",
    mix: ["horse", "horse", "skirmisher"], captain: "Captain Halloway",
    fee: 15, wage: 2, contractDays: 60, loyalty: 35, reputation: "turncoats", act: 2,
    about: "Cheap and quick, and loyal to whoever paid them last.",
  },
  {
    id: "corbin-pack", name: "Corbin's Pack", nameId: 6, dominant: "hounds",
    mix: ["hounds", "hounds", "skirmisher", "line"], captain: "Captain Corbin",
    fee: 20, wage: 2, contractDays: 60, loyalty: 55, reputation: "bloody", act: 2,
    about: "Dogs and the people who run with them. They win, and the villages they pass remember them.",
  },
  {
    id: "vane-adepts", name: "Vane's Adepts", nameId: 3, dominant: "mage",
    mix: ["mage", "mage", "guard"], captain: "Adept Vane",
    fee: 50, wage: 4, contractDays: 90, loyalty: 65, reputation: "reliable", act: 3,
    about: "Adepts who never held the crown's licence. Feared, and worth fearing.",
  },
  {
    id: "selby-champions", name: "Selby's Champions", nameId: 14, dominant: "champion",
    mix: ["champion", "champion", "line", "line"], captain: "Captain Selby",
    fee: 35, wage: 3, contractDays: 60, loyalty: 40, reputation: "turncoats", act: 3,
    about: "Duellists and prize-fighters with a banner. Magnificent while the money lasts.",
  },
  {
    id: "blackwood-battery", name: "Blackwood's Battery", nameId: 9, dominant: "siege",
    mix: ["siege", "siege", "builder", "wagon"], captain: "Master Gunner Blackwood",
    fee: 60, wage: 4, contractDays: 120, loyalty: 70, reputation: "reliable", act: 4,
    about: "Engines, sappers and the patience to use them. A city's walls are their whole trade.",
  },
];
