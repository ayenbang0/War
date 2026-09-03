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
/**
 * What a battlefield asks for.
 *
 * A weight per unit type and a short list of abilities worth having, derived
 * from what the level already declares: how it is won, how long there is, and
 * what the going is like. The same suggestion on every map was advice that
 * ignored the one thing the player most needs advice about -- cavalry is worth
 * buying on the open field and close to worthless at a river crossing, and a
 * match won by holding ground wants sappers and heavy foot rather than horse.
 */
export type Advice = {
  readonly weights: Partial<Record<UnitTypeId, number>>;
  readonly prefer: readonly AbilityId[];
  readonly note: string;
};

const BASE_WEIGHTS: Record<UnitTypeId, number> = {
  line: 6, archer: 3, skirmisher: 2, horse: 2, scout: 1,
  guard: 1, healer: 1, builder: 1, mage: 1, siege: 1,
};

export function adviseFor(level: {
  victory: { mode: string };
  duration: number;
  country: "open" | "broken" | "high";
}): Advice {
  const w: Record<UnitTypeId, number> = { ...BASE_WEIGHTS };
  const prefer: AbilityId[] = [];
  const notes: string[] = [];
  const scale = (id: UnitTypeId, by: number): void => {
    w[id] = w[id] * by;
  };

  // -- the going --------------------------------------------------------------
  if (level.country === "open") {
    scale("horse", 2); scale("scout", 1.8); scale("siege", 0.5); scale("line", 0.9);
    prefer.push("charge", "flare");
    notes.push("open ground, so horse and eyes pay");
  } else if (level.country === "broken") {
    // A river with bridges is no place for cavalry: there is nowhere to swing.
    scale("horse", 0.3); scale("scout", 0.6); scale("siege", 1.6);
    scale("builder", 1.6); scale("line", 1.2); scale("archer", 1.3);
    prefer.push("smoke", "barrage");
    notes.push("broken ground, so foot and shot over horse");
  } else {
    scale("archer", 1.6); scale("guard", 1.4); scale("builder", 1.3); scale("horse", 0.6);
    prefer.push("flare", "shield");
    notes.push("high ground, so shot from above and men who will not be shifted");
  }

  // -- how it is won ----------------------------------------------------------
  if (level.victory.mode === "objectives") {
    scale("line", 1.2); scale("guard", 1.5); scale("builder", 1.8);
    scale("healer", 1.4); scale("horse", 0.8);
    prefer.unshift("shield", "levy");
    notes.push("ground to hold, so sappers and men who hold it");
  } else if (level.victory.mode === "points") {
    scale("healer", 1.5); scale("builder", 1.4); scale("archer", 1.2);
    prefer.unshift("levy", "shield");
    notes.push("a long reckoning, so staying power");
  } else {
    scale("horse", 1.2); scale("skirmisher", 1.2);
    prefer.unshift("barrage", "charge");
    notes.push("their nerve to break, so pressure");
  }

  // -- the clock --------------------------------------------------------------
  if (level.duration < 12 * 60) {
    // No time for an engine to crawl into position.
    scale("siege", 0.5); scale("horse", 1.3);
    notes.push("a short clock, so nothing slow");
  }

  return { weights: w, prefer, note: notes.join("; ") };
}

/** The order to buy types in, repeated: a balanced slice of an army. */
function cycleFor(weights: Partial<Record<UnitTypeId, number>>): UnitTypeId[] {
  // Interleaved rather than blocked, so a short budget still buys a mixed
  // force instead of nothing but the heaviest-weighted type.
  const out: UnitTypeId[] = [];
  const totals = new Map<UnitTypeId, number>();
  for (const id of UNIT_TYPE_IDS) totals.set(id, 0);
  const target = UNIT_TYPE_IDS.map((id) => weights[id] ?? 0);
  const sum = target.reduce((a, b) => a + b, 0);
  if (sum <= 0) return [...UNIT_TYPE_IDS];
  const steps = 40;
  for (let k = 0; k < steps; k++) {
    // Whichever type is furthest behind its share goes next.
    let best: UnitTypeId | null = null;
    let worst = -Infinity;
    UNIT_TYPE_IDS.forEach((id, i) => {
      if (target[i] <= 0) return;
      const want = (target[i] / sum) * (k + 1);
      const have = totals.get(id) ?? 0;
      const behind = want - have;
      if (behind > worst) {
        worst = behind;
        best = id;
      }
    });
    if (best === null) break;
    out.push(best);
    totals.set(best, (totals.get(best) ?? 0) + 1);
  }
  return out;
}

export function suggestArmy(
  doctrine: DoctrineId, budget: number, advice?: Advice,
): ArmyList {
  const squads: UnitTypeId[] = [];
  const abilities: AbilityId[] = [];
  const spent = (): number => cost({ doctrine, squads, abilities });
  const legal = (): boolean => validate({ doctrine, squads, abilities }, budget).ok;

  // -- the reserve ------------------------------------------------------------
  // Cheapest-first for THIS doctrine, which is the same as saying "what this
  // doctrine is good at": the price list is where a doctrine's character lives.
  const reserve = Math.round(budget * ABILITY_SHARE);
  const prefer = advice?.prefer ?? [];
  const byPrice = [...ABILITY_IDS].sort((a, b) => {
    // What the battlefield asks for comes first; price decides the rest.
    const pa = prefer.indexOf(a);
    const pb = prefer.indexOf(b);
    const ra = pa < 0 ? prefer.length : pa;
    const rb = pb < 0 ? prefer.length : pb;
    if (ra !== rb) return ra - rb;
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
  const shape = cycleFor(advice?.weights ?? BASE_WEIGHTS);
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
