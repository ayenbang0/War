/**
 * Raising squads (K4; docs/audit/u2-army-panels.md "Recruit dialog"): the trained
 * squads at a barracks (opened from the barracks' lot in the city view), and
 * the king's first followers formed into levy squads (opened from the king
 * card, where he stands).
 *
 * Both are the shared choice menu (economy-panel.ts): modal, the realm held
 * while it is open, every kind of squad listed with what it costs, and a
 * squad the sim would refuse kept in the list, focusable and marked
 * aria-disabled, saying why in the sim's own words -- the menu asks
 * KingdomWorld.check, the same function that applies the order.
 *
 * Which army a squad joins: the king's own army if it stands here, else the
 * first of the king's armies standing here (lowest id), else a new army
 * (docs/PROVISIONAL.md K4.9). The intro says which.
 */

import type { Screen } from "../screen-stack.ts";
import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { KingdomOrderBody } from "../../sim/kingdom/orders.ts";
import { KING_PLAYER } from "../../content/kingdom/factions.ts";
import { UNIT_TYPES, UNIT_TYPE_IDS, type UnitTypeId } from "../../content/unit-types.ts";
import { LEVY_TYPES, dailyWage } from "../../content/kingdom/armies.ts";
import { AC } from "../../content/kingdom/army-strings.ts";
import { armiesOf, armyById, recruitCost, standsIn } from "../../sim/kingdom/armies.ts";
import { choiceMenu, type EconomyHooks, type Option } from "./economy-panel.ts";

/** The army a squad raised at `holding` joins (0 = a new one). */
export function recruitTarget(world: KingdomWorld, holding: number): number {
  const k = armyById(world, world.king.army);
  if (k && standsIn(k.mover) === holding) return k.id;
  const here = armiesOf(world, KING_PLAYER).find((a) => standsIn(a.mover) === holding);
  return here ? here.id : 0;
}

function intro(world: KingdomWorld, base: string, target: number): string {
  const a = armyById(world, target);
  return base + " " + (a ? AC.recruitInto(a.name) : AC.recruitNew) + ".";
}

function options(world: KingdomWorld, holding: number, units: readonly UnitTypeId[], levy: boolean): Option[] {
  const target = recruitTarget(world, holding);
  const name = armyById(world, target)?.name ?? null;
  return units.map((unit): Option => {
    const u = UNIT_TYPES[unit];
    const order: KingdomOrderBody = { kind: "recruit", at: holding, army: target, unit, levy };
    const c = recruitCost(unit, levy, world.kingStocks.stocks.levy);
    const wage = dailyWage(u.cost, levy);
    return {
      key: (levy ? "levy-" : "recruit-") + unit,
      label: u.name,
      lines: [
        levy ? AC.levyCost(c.levy) : AC.recruitCost(c),
        u.soldiers + " men a squad" + (wage > 0 ? " · " + wage + " coin a day" : ""),
      ],
      why: world.check(order),
      order,
      said: AC.recruited({ unit: u.name, men: c.levy, army: name ?? "new army" }),
    };
  });
}

/** Trained squads at a holding's barracks. */
export function recruitMenu(doc: Document, world: KingdomWorld, holding: number, hooks: EconomyHooks): Screen {
  const h = world.holding(holding);
  return choiceMenu(doc, {
    name: "recruit-menu",
    title: AC.recruitTitle(h?.name ?? "?"),
    intro: intro(world, AC.recruitIntro, recruitTarget(world, holding)),
    options: () => options(world, holding, UNIT_TYPE_IDS, false),
  }, hooks);
}

/** The king's followers, formed where he stands into a levy squad. */
export function levyMenu(doc: Document, world: KingdomWorld, hooks: EconomyHooks): Screen {
  const at = standsIn(world.king.mover);
  return choiceMenu(doc, {
    name: "levy-menu",
    title: AC.levyTitle,
    intro: intro(world, AC.levyIntro, recruitTarget(world, at)),
    options: () => options(world, at, LEVY_TYPES, true),
  }, hooks);
}
