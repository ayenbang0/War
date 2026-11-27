/**
 * The one writer of a holding's unrest (K6). Kept apart from morale.ts so
 * the economy's muster (economy.ts) and an army living off the land
 * (armies.ts) can stir a town without importing the morale rules that read
 * them: the module graph stays one-way. Callers decide whether the
 * holding's unrest is reckoned at all (morale.ts unrestReckoned).
 */

import { UNREST_MAX, unrestBand } from "../../content/kingdom/morale.ts";
import type { Holding } from "./state.ts";
import type { KingdomWorld } from "./world.ts";

/** Move a holding's unrest by `delta` permille, kept in 0..UNREST_MAX; says when it changes band. */
export function moveUnrest(world: KingdomWorld, h: Holding, delta: number): void {
  if (delta === 0) return;
  const before = h.unrest;
  const next = before + delta;
  h.unrest = next < 0 ? 0 : next > UNREST_MAX ? UNREST_MAX : next;
  const b1 = unrestBand(h.unrest);
  if (unrestBand(before) !== b1) world.events.push({ kind: "unrestBand", holding: h.id, band: b1, rising: h.unrest > before });
}
