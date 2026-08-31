/**
 * Point-buy army composition (spec section 3.2).
 *
 * Validation lives here rather than in the UI so that the AI, saved armies and
 * level presets are all held to the same rules. An army that fails validation
 * is never handed to the simulation.
 */

import { UNIT_TYPES, UNIT_TYPE_IDS, type UnitTypeId } from "./unit-types.ts";
import { DOCTRINES, type DoctrineId } from "./doctrines.ts";

/** Points available to each side. Enough for roughly fifteen squads. */
export const DEFAULT_BUDGET = 55;
/** The spec's cap on how many squads one player commands. */
export const MAX_SQUADS = 15;

export type ArmyList = {
  readonly doctrine: DoctrineId;
  /** One entry per squad, in deployment order. */
  readonly squads: readonly UnitTypeId[];
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
  const wish: UnitTypeId[] = [
    "line", "line", "line", "archer", "skirmisher",
    "line", "archer", "skirmisher", "horse", "line",
    "skirmisher", "archer", "horse", "guard", "skirmisher",
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
