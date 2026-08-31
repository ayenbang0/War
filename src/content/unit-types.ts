/**
 * Unit roster. Content, not code paths.
 *
 * Costs and caps feed the Phase 6 point-buy screen. Combat columns feed
 * Phase 3. Nothing here is code -- adding a unit type is adding a row.
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
  /** Damage per hit, before the target's defence and cover. */
  readonly attack: number;
  /** Damage reduction, as a soak. 100 halves incoming damage. */
  readonly defence: number;
  /**
   * Reach in world units. Below MELEE_RANGE this unit fights hand to hand and
   * finds targets through the soldier spatial hash; above it, the unit shoots
   * and picks targets squad-first (sweeping a 200-unit radius through a
   * 14-unit hash grid would cost hundreds of cells per soldier per tick).
   */
  readonly range: number;
  /** Seconds between attacks. */
  readonly attackInterval: number;
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
    attack: 20,
    defence: 110,
    range: 9,
    attackInterval: 0.9,
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
    attack: 14,
    defence: 55,
    range: 95,
    attackInterval: 1.4,
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
    attack: 16,
    defence: 45,
    range: 250,
    attackInterval: 1.9,
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
    attack: 34,
    defence: 95,
    range: 10,
    attackInterval: 1.2,
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
    attack: 26,
    defence: 170,
    range: 9,
    attackInterval: 1.1,
    cost: 7,
    maxPerArmy: 2,
  },
};

export const UNIT_TYPE_IDS: readonly UnitTypeId[] = [
  "line", "skirmisher", "archer", "horse", "guard",
];
