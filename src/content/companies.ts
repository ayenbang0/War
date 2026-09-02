/**
 * Company names.
 *
 * A body of troops the player drew around should be a thing with a name, not a
 * number. "Ashcroft's Horse broke on the left" is a sentence you remember and
 * can learn from; "group 7 lost 12 men" is a log line you skim past. The whole
 * after-action report leans on this.
 *
 * Names are DERIVED, never rolled: the same group of the same men always gets
 * the same name, so nothing here can shift a replay or a hash. Foot companies
 * are numbered because that is how numbered regiments read; mounted, elite and
 * specialist companies take a surname, because those are the ones a player
 * remembers individually.
 */

import type { UnitTypeId } from "./unit-types.ts";

const ORDINALS = [
  "1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th",
  "9th", "10th", "11th", "12th", "13th", "14th", "15th", "16th",
];

/** Surnames for the companies that earn one. Kept plain and period-neutral. */
const SURNAMES = [
  "Ashcroft", "Warden", "Halloway", "Vane", "Redmayne", "Stone", "Corbin", "Marlow",
  "Thorne", "Blackwood", "Ferrers", "Ainsley", "Rooke", "Dunmore", "Selby", "Harker",
];

/** What a company of mostly this type is called. */
const STYLE: Record<UnitTypeId, string> = {
  line: "Foot",
  guard: "Guard",
  skirmisher: "Skirmishers",
  scout: "Outriders",
  archer: "Bowmen",
  horse: "Horse",
  mage: "Adepts",
  siege: "Battery",
};

/** Types named for a person rather than numbered. */
const NAMED: ReadonlySet<string> = new Set(["horse", "guard", "mage", "siege", "scout"]);

/**
 * Name a company from its id and whatever it is mostly made of.
 *
 * `id` is the group's monotonic id, so two companies raised in one battle never
 * collide, and the sixteen-name tables wrap rather than run out.
 */
export function companyName(id: number, dominant: UnitTypeId): string {
  const style = STYLE[dominant] ?? "Company";
  if (NAMED.has(dominant)) {
    return SURNAMES[id % SURNAMES.length] + "'s " + style;
  }
  return ORDINALS[id % ORDINALS.length] + " " + style;
}
