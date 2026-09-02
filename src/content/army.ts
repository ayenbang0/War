/**
 * Point-buy army composition (spec section 3.2).
 *
 * Validation lives here rather than in the UI so that the AI, saved armies and
 * level presets are all held to the same rules. An army that fails validation
 * is never handed to the simulation.
 */

import { UNIT_TYPES, UNIT_TYPE_IDS, type UnitTypeId } from "./unit-types.ts";
import { DOCTRINES, type DoctrineId } from "./doctrines.ts";
import { ABILITIES, abilityCost, type AbilityId } from "./abilities.ts";

/**
 * Points available to each side.
 *
 * Raised repeatedly from the original 55 so an army is a genuinely big force:
 * more companies on the field, and room to afford the specialists and a few
 * orders in reserve without giving up your line.
 */
export const DEFAULT_BUDGET = 198;
/**
 * Cap on how many companies one player commands.
 *
 * Raised alongside the budget, and it HAD to be: with the cap left at fifteen,
 * extra points could only buy dearer companies, never more of them, so an army
 * with half again the points fielded no more men. Idea.txt says "~15 units";
 * this is a deliberate departure in favour of the larger battles the budget is
 * meant to pay for.
 */
export const MAX_SQUADS = 45;
/** How many times one ability may be bought. Twice is a deep magazine, not a
 *  different strategy. */
export const MAX_OF_ONE_ABILITY = 2;

export type ArmyList = {
  readonly doctrine: DoctrineId;
  /** One entry per squad, in deployment order. */
  readonly squads: readonly UnitTypeId[];
  /** Abilities bought, paid for out of the SAME budget as the men. */
  readonly abilities?: readonly AbilityId[];
};

export type Validation = {
  readonly ok: boolean;
  readonly spent: number;
  readonly budget: number;
  readonly problems: string[];
};

export function cost(list: ArmyList): number {
  let n = 0;
  for (const id of list.squads) n += UNIT_TYPES[id].cost;
  // Abilities come out of the same purse as the men, which is the entire
  // design: a barrage is paid for in companies you will not have.
  for (const id of list.abilities ?? []) n += abilityCost(id, list.doctrine);
  return n;
}

/** Check a list against budget, squad cap and per-type caps. */
export function validate(list: ArmyList, budget = DEFAULT_BUDGET): Validation {
  const problems: string[] = [];
  const spent = cost(list);

  if (spent > budget) problems.push("over budget by " + (spent - budget) + " points");
  if (list.squads.length > MAX_SQUADS) {
    problems.push("too many squads: " + list.squads.length + " of at most " + MAX_SQUADS);
  }
  if (list.squads.length === 0) problems.push("an army needs at least one squad");
  if (!DOCTRINES[list.doctrine]) problems.push("unknown doctrine: " + list.doctrine);

  for (const id of list.abilities ?? []) {
    const n = (list.abilities ?? []).filter((a2) => a2 === id).length;
    if (n > MAX_OF_ONE_ABILITY) {
      problems.push(ABILITIES[id].name + ": " + n + " of at most " + MAX_OF_ONE_ABILITY);
    }
  }

  // Per-type caps are what stop a single unit type dominating (spec 3.2).
  for (const id of UNIT_TYPE_IDS) {
    const n = list.squads.filter((s) => s === id).length;
    const cap = UNIT_TYPES[id].maxPerArmy;
    if (n > cap) problems.push(UNIT_TYPES[id].name + ": " + n + " of at most " + cap);
  }

  return { ok: problems.length === 0, spent, budget, problems };
}

/**
 * A balanced default list, used by levels and by the AI.
 *
 * Built by taking the cheapest useful core and adding what the budget allows,
 * so it stays valid if costs are retuned.
 */
export function defaultArmy(doctrine: DoctrineId = "maneuver", budget = DEFAULT_BUDGET): ArmyList {
  // Long enough to actually spend the budget. The order is the preference
  // order, so a smaller purse still buys a sensible core first: line, then
  // shooters and eyes, then the specialists.
  const wish: UnitTypeId[] = [
    "line", "line", "line", "archer", "scout",
    "line", "archer", "skirmisher", "horse", "mage",
    "skirmisher", "scout", "horse", "guard", "siege",
    "skirmisher", "archer", "line", "healer", "builder",
    "line", "skirmisher", "archer", "horse", "guard",
    "line", "scout", "line", "healer", "builder",
    "skirmisher", "mage", "siege",
    "line", "archer", "line", "skirmisher", "horse", "line", "scout",
    "archer", "line", "skirmisher", "guard", "line", "horse", "archer",
    "line", "skirmisher", "line", "scout", "mage", "siege", "line",
  ];
  const squads: UnitTypeId[] = [];
  let spent = 0;
  for (const id of wish) {
    if (squads.length >= MAX_SQUADS) break;
    const c = UNIT_TYPES[id].cost;
    if (spent + c > budget) continue;
    if (squads.filter((s) => s === id).length >= UNIT_TYPES[id].maxPerArmy) continue;
    squads.push(id);
    spent += c;
  }
  return { doctrine, squads };
}
