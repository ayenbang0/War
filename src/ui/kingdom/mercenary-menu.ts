/**
 * The free companies' market (K7; docs/audit/u2-mercenary-market.md): who is
 * drinking in a tavern of the king's and willing to sign, opened from the
 * tavern's lot in the city view.
 *
 * The shared choice menu (economy-panel.ts): modal, the realm held while it
 * is open, each company with its fee, wage, contract, men and reputation,
 * and a hire the sim would refuse kept in the list, focusable and marked
 * aria-disabled, saying why in the sim's own words -- the menu asks
 * KingdomWorld.check, the same function that applies the order.
 */

import type { Screen } from "../screen-stack.ts";
import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { KingdomOrderBody } from "../../sim/kingdom/orders.ts";
import { UNIT_TYPES } from "../../content/unit-types.ts";
import { MERCENARIES } from "../../content/kingdom/mercenaries.ts";
import { MARKET, REPUTATION_ABOUT, REPUTATION_WORD } from "../../content/kingdom/mercenary-strings.ts";
import { offersAt } from "../../sim/kingdom/mercenaries.ts";
import { choiceMenu, type EconomyHooks, type Option } from "./economy-panel.ts";

/** "2 Scouts, 1 Horse" -- the squads a company brings, by kind, in its table's order. */
export function squadsLine(mix: readonly string[]): string {
  const seen: string[] = [];
  for (const u of mix) if (!seen.includes(u)) seen.push(u);
  return seen.map((u) => mix.filter((x) => x === u).length + " " + UNIT_TYPES[u as keyof typeof UNIT_TYPES].name).join(", ");
}

function options(world: KingdomWorld, holding: number): Option[] {
  return offersAt(world, holding).map((c): Option => {
    const def = MERCENARIES[c.index];
    const order: KingdomOrderBody = { kind: "hireCompany", company: c.index, at: holding };
    let men = 0;
    for (const u of def.mix) men += UNIT_TYPES[u].soldiers;
    return {
      key: "hire-" + def.id,
      label: MARKET.option({ name: def.name, reputation: REPUTATION_WORD[def.reputation] }),
      lines: [
        ...MARKET.lines({ fee: def.fee, wage: def.wage, contract: def.contractDays, men, squads: squadsLine(def.mix), left: c.days }),
        MARKET.loyalty(def.loyalty) + " · " + REPUTATION_ABOUT[def.reputation],
        def.about,
      ],
      why: world.check(order),
      order,
      said: MARKET.said(def.name),
    };
  });
}

/** The companies at a holding's tavern. */
export function marketMenu(doc: Document, world: KingdomWorld, holding: number, hooks: EconomyHooks): Screen {
  const h = world.holding(holding);
  const any = offersAt(world, holding).length > 0;
  return choiceMenu(doc, {
    name: "market-menu",
    title: MARKET.title,
    intro: any ? MARKET.intro(h?.name ?? "?") : MARKET.none,
    options: () => options(world, holding),
    cancelLabel: MARKET.cancel,
  }, hooks);
}
