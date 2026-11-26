/**
 * What a battle meant for the realm, in lines for the after-action report
 * (K5, PLAN.md §B.9: "the after-action report shows kingdom consequences").
 *
 * Read from the kingdom AFTER the result was applied -- what the spec says
 * went in, what the world now holds, and the tick's events (who fell back
 * where, who was taken, which walls changed hands) -- so the report says
 * what actually happened to the realm rather than a forecast of it.
 */

import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { KingdomEvent } from "../../sim/kingdom/state.ts";
import type { BattleResult, BattleSpec } from "../../sim/layers.ts";
import { armyById, armyMen, armyWounded } from "../../sim/kingdom/armies.ts";
import { DESCENT } from "../../content/kingdom/descent-strings.ts";
import { FACTIONS, FACTION_IDS } from "../../content/kingdom/factions.ts";

export function consequenceLines(
  world: KingdomWorld, spec: BattleSpec, result: BattleResult, events: readonly KingdomEvent[],
): string[] {
  const lines: string[] = [];
  const name = (id: number): string => world.holding(id)?.name ?? "?";
  for (let i = 0; i < 2; i++) {
    const side = spec.sides[i];
    let was = 0;
    for (const q of side.squads) was += q.men;
    if (side.army === 0) {
      let left = 0;
      for (const q of result.squads[i]) left += q.men;
      if (was > left) lines.push(DESCENT.townsmen({ name: name(spec.terrain.holding), lost: was - left }));
      continue;
    }
    const label = side.name;
    const gone = events.find((e) => e.kind === "armyGone" && e.army === side.army);
    if (gone && gone.kind === "armyGone") {
      lines.push(gone.reason === "captured" ? DESCENT.cutOff(label) : DESCENT.armyLost(label));
      continue;
    }
    const a = armyById(world, side.army);
    if (!a) continue;
    lines.push(DESCENT.survivors({ army: label, men: armyMen(a), was, wounded: armyWounded(a) }));
    if (i === 0) lines.push(DESCENT.morale({ army: label, morale: a.morale }));
    const back = events.find((e) => e.kind === "fellBack" && e.army === side.army);
    if (back && back.kind === "fellBack") lines.push(DESCENT.fallsBack({ army: label, to: name(back.to) }));
  }
  for (const e of events) {
    if (e.kind === "stormed") lines.push(DESCENT.stormed({ name: name(e.holding), by: FACTIONS[FACTION_IDS[e.faction]]?.name ?? "?" }));
    // K10: the walls the battle knocked down stay down until they are mended.
    if (e.kind === "wallsDamaged") {
      lines.push(DESCENT.wallsDamaged({ name: name(e.holding), pct: Math.round(e.by / 10), down: Math.round(e.walls / 10) }));
    }
  }
  if (result.legitimacy > 0) lines.push(DESCENT.legitimacyUp(result.legitimacy));
  else if (result.legitimacy < 0) lines.push(DESCENT.legitimacyDown(-result.legitimacy));
  return lines;
}
