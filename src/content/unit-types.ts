/**
 * Unit roster. Content, not code paths.
 *
 * Costs and caps are already here because Phase 6 builds the point-buy screen
 * on top of them; nothing reads them yet. Phase 3 adds the combat columns
 * (attack, defence, range, attack speed) and Phase 7 the magic ones.
 */

import type { FormationShape } from "../sim/formations.ts";

export type UnitTypeId = "line" | "skirmisher" | "archer" | "horse" | "guard";

export type UnitType = {
  readonly id: UnitTypeId;
  readonly name: string;
  /** Soldiers in a full-strength squad. */
  readonly soldiers: number;
  /** Per-soldier hit points. */
  readonly hp: number;
  /** Squad movement, world units per second on open ground. */
  readonly speed: number;
  /** Radians per second the formation can pivot. */
  readonly turnRate: number;
  readonly defaultShape: FormationShape;
  /** Point-buy cost (Phase 6). */
  readonly cost: number;
  /** Maximum of this type in one army (Phase 6). */
  readonly maxPerArmy: number;
};

export const UNIT_TYPES: Record<UnitTypeId, UnitType> = {
  line: {
    id: "line",
    name: "Line Infantry",
    soldiers: 20,
    hp: 100,
    speed: 30,
    turnRate: 1.1,
    defaultShape: "line",
    cost: 3,
    maxPerArmy: 8,
  },
  skirmisher: {
    id: "skirmisher",
    name: "Skirmishers",
    soldiers: 12,
    hp: 70,
    speed: 46,
    turnRate: 2.0,
    defaultShape: "loose",
    cost: 2,
    maxPerArmy: 5,
  },
  archer: {
    id: "archer",
    name: "Archers",
    soldiers: 16,
    hp: 70,
    speed: 32,
    turnRate: 1.3,
    defaultShape: "line",
    cost: 4,
    maxPerArmy: 4,
  },
  horse: {
    id: "horse",
    name: "Horse",
    soldiers: 10,
    hp: 130,
    speed: 62,
    turnRate: 1.6,
    defaultShape: "wedge",
    cost: 6,
    maxPerArmy: 3,
  },
  guard: {
    id: "guard",
    name: "Elite Guard",
    soldiers: 14,
    hp: 170,
    speed: 27,
    turnRate: 0.9,
    defaultShape: "square",
    cost: 7,
    maxPerArmy: 2,
  },
};

export const UNIT_TYPE_IDS: readonly UnitTypeId[] = [
  "line", "skirmisher", "archer", "horse", "guard",
];
