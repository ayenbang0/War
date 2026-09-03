/**
 * Point-buy army composition (spec section 3.2).
 *
 * Validation lives here rather than in the UI so that the AI, saved armies and
 * level presets are all held to the same rules. An army that fails validation
 * is never handed to the simulation.
 */

import { UNIT_TYPES, UNIT_TYPE_IDS, type UnitTypeId } from "./unit-types.ts";
import { DOCTRINES, type DoctrineId } from "./doctrines.ts";
import { ABILITIES, ABILITY_IDS, abilityCost, type AbilityId } from "./abilities.ts";

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
/**
 * Share of the budget a suggested army sets aside for the reserve.
 *
 * About a fifth: enough for a spread of abilities plus a second charge of the
 * cheap ones, without gutting the force that has to hold the ground while you
 * use them.
 */
const ABILITY_SHARE = 0.2;

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

/**
 * A complete, balanced setup: troops AND the abilities to go with them.
 *
 * `defaultArmy` above fills a wish list until the money runs out, which is fine
 * for a fixture but makes a poor suggestion: it buys no abilities at all, and
 * it stops the moment the next thing on the list is unaffordable, leaving
 * points on the table that the player then has to notice and spend themselves.
 *
 * This does three things instead.
 *
 * FIRST it sets aside a share for the reserve, because an ability bought is a
 * company not bought and the trade has to be made deliberately rather than by
 * whatever happens to be left over.
 *
 * SECOND it buys in a combined-arms RATIO rather than off a fixed list -- a
 * core of foot, ranged support behind it, horse to get round a flank, eyes,
 * and a specialist or two -- so the suggestion is an army rather than a pile.
 *
 * THIRD it spends the remainder down to nothing it can legally spend. Whatever
 * cannot be spent at the end is genuinely unspendable: every per-type cap is
 * full, or the cheapest company left costs more than the change.
 */
export function suggestArmy(doctrine: DoctrineId, budget: number): ArmyList {
  const squads: UnitTypeId[] = [];
  const abilities: AbilityId[] = [];
  const spent = (): number => cost({ doctrine, squads, abilities });
  const legal = (): boolean => validate({ doctrine, squads, abilities }, budget).ok;

  // -- the reserve ------------------------------------------------------------
  // Cheapest-first for THIS doctrine, which is the same as saying "what this
  // doctrine is good at": the price list is where a doctrine's character lives.
  const reserve = Math.round(budget * ABILITY_SHARE);
  const byPrice = [...ABILITY_IDS].sort((a, b) => {
    const d = abilityCost(a, doctrine) - abilityCost(b, doctrine);
    return d !== 0 ? d : ABILITY_IDS.indexOf(a) - ABILITY_IDS.indexOf(b);
  });
  // A spread of different abilities first; only then a second charge of any.
  // Checked against the reserve and the per-ability cap DIRECTLY rather than
  // through validate(): at this point no troops have been bought yet, so a full
  // validation fails on "an army needs at least one squad" and every ability
  // was being popped straight back off. The suggestion arrived with an empty
  // reserve every time.
  for (let pass = 0; pass < MAX_OF_ONE_ABILITY; pass++) {
    for (const id of byPrice) {
      const price = abilityCost(id, doctrine);
      if (spent() + price > reserve) continue;
      if (abilities.filter((a) => a === id).length >= MAX_OF_ONE_ABILITY) continue;
      abilities.push(id);
    }
  }

  // -- the army ---------------------------------------------------------------
  // One turn of this cycle is a balanced slice of an army; repeating it scales
  // that shape up to whatever the budget affords.
  const shape: UnitTypeId[] = [
    "line", "line", "archer", "line", "skirmisher", "archer",
    "horse", "line", "scout", "line", "skirmisher", "guard",
    "healer", "line", "archer", "horse", "builder", "line",
    "skirmisher", "mage", "line", "archer", "siege", "scout",
  ];
  let blocked = 0;
  for (let i = 0; blocked < shape.length; i++) {
    const id = shape[i % shape.length];
    squads.push(id);
    if (legal()) {
      blocked = 0;
    } else {
      squads.pop();
      blocked++;
    }
  }

  // -- the change -------------------------------------------------------------
  // Dearest first, so the last of the money buys something that matters rather
  // than a trail of the cheapest thing on the board.
  const byCostDown = [...UNIT_TYPE_IDS].sort((a, b) => UNIT_TYPES[b].cost - UNIT_TYPES[a].cost);
  for (;;) {
    let added = false;
    for (const id of byCostDown) {
      squads.push(id);
      if (legal()) {
        added = true;
      } else {
        squads.pop();
      }
    }
    if (!added) break;
  }

  return { doctrine, squads, abilities };
}
