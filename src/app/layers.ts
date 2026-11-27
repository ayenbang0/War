/**
 * The layers (plan §B.1): one is live at a time, and which one is a TYPE, never
 * a boolean (house rule 2). Battle is Layer 2 (with the troop layer inside its
 * World); the kingdom is Layer 3 and is a stub until K1.
 */

import type { BattleLayer } from "./battle-layer.ts";
import type { KingdomLayer } from "./kingdom-layer.ts";
import type { CityLayer } from "./city-layer.ts";

/**
 * K3b: the city is the layer below the kingdom map. While it is live the
 * kingdom layer is suspended under it (not torn down): `CityLayer.realm`.
 */
export type Layer = KingdomLayer | CityLayer | BattleLayer;
export type LayerKind = Layer["kind"];
