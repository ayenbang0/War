/**
 * The layers (plan §B.1): one is live at a time, and which one is a TYPE, never
 * a boolean (house rule 2). Battle is Layer 2 (with the troop layer inside its
 * World); the kingdom is Layer 3 and is a stub until K1.
 */

import type { BattleLayer } from "./battle-layer.ts";
import type { KingdomLayer } from "./kingdom-layer.ts";

export type Layer = KingdomLayer | BattleLayer;
export type LayerKind = Layer["kind"];
