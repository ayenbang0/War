/**
 * Unit roster. Content, not code paths.
 *
 * Costs and caps feed the Phase 6 point-buy screen. Combat columns feed
 * Phase 3. Nothing here is code -- adding a unit type is adding a row.
 */

import type { FormationShape } from "../sim/formations.ts";
import type { SpellId } from "../sim/magic.ts";
import type { SpecialId } from "./specials.ts";

export type UnitTypeId =
  | "line" | "skirmisher" | "archer" | "horse" | "guard"
  | "mage" | "scout" | "siege" | "healer" | "builder"
  // The second roster, appended. See UNIT_TYPE_IDS: order is hashed.
  | "pike" | "crossbow" | "lancer" | "slinger" | "champion"
  | "banner" | "drummer" | "hounds" | "oathsworn" | "wagon";

export type UnitType = {
  readonly id: UnitTypeId;
  readonly name: string;
  /** One line on what this unit is for, shown when composing an army. */
  readonly role: string;
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
  /** How far this unit sees on level open ground, in world units. */
  readonly sight: number;
  /**
   * Point-buy cost, on a deliberately small and readable scale: a line company
   * is 3 and the dearest thing on the field is 9. Big numbers would carry no
   * more meaning and would be harder to add up in your head while composing.
   */
  readonly cost: number;
  /**
   * Maximum of this type in one army. Special units are deliberately scarce.
   *
   * Raised alongside the budget: with the old caps the most a player could
   * spend on MEN was 145 points, so a larger purse could only go on abilities
   * and the extra credits never reached the troops they were meant to buy.
   */
  readonly maxPerArmy: number;
  /** Volleys carried into the battle. 0 for men who do not shoot. */
  readonly volleys?: number;
  /** What this kind of soldier does for itself, unbidden. */
  readonly special?: SpecialId;
  /** Spell this unit works, if any (spec section 6.2). */
  readonly spell?: SpellId;
  /** Can batter fortifications and bridges when there is nothing to shoot. */
  readonly siege?: boolean;
  /**
   * Raises fieldworks on the ground it is holding (spec 6.2, "terrain
   * manipulation: small barriers, temporary cover").
   */
  readonly builds?: boolean;
};

export const UNIT_TYPES: Record<UnitTypeId, UnitType> = {
  line: {
    id: "line",
    name: "Line Infantry",
    role: "Holds ground and absorbs a charge. Slow, armoured, and the front rank of any real formation.",
    soldiers: 20,
    hp: 100,
    speed: 30,
    turnRate: 1.1,
    defaultShape: "line",
    attack: 20,
    defence: 110,
    range: 9,
    attackInterval: 0.9,
    sight: 320,
    special: "brace",
    cost: 3,
    maxPerArmy: 12,
  },
  skirmisher: {
    id: "skirmisher",
    name: "Skirmishers",
    role: "Fast, lightly armed harassers. Good at reaching a flank, bad at standing still.",
    soldiers: 12,
    hp: 70,
    speed: 46,
    turnRate: 2.0,
    defaultShape: "loose",
    attack: 14,
    defence: 55,
    range: 95,
    attackInterval: 1.4,
    sight: 480,
    special: "dodge",
    cost: 2,
    volleys: 26,
    maxPerArmy: 8,
  },
  archer: {
    id: "archer",
    name: "Archers",
    role: "Kills at two hundred paces and folds instantly in melee. Wants a line in front of it.",
    soldiers: 16,
    hp: 70,
    speed: 32,
    turnRate: 1.3,
    defaultShape: "line",
    attack: 16,
    defence: 45,
    range: 250,
    attackInterval: 1.9,
    sight: 420,
    special: "breakBow",
    cost: 4,
    volleys: 34,
    maxPerArmy: 6,
  },
  horse: {
    id: "horse",
    name: "Horse",
    role: "Fastest thing on the field. Devastating into a flank, wasted against a braced square.",
    soldiers: 10,
    hp: 130,
    speed: 62,
    turnRate: 1.6,
    defaultShape: "wedge",
    attack: 34,
    defence: 95,
    range: 10,
    attackInterval: 1.2,
    sight: 520,
    special: "dash",
    cost: 6,
    maxPerArmy: 5,
  },
  guard: {
    id: "guard",
    name: "Elite Guard",
    role: "Elite heavy foot. Expensive, few, and very hard to break.",
    soldiers: 14,
    hp: 170,
    speed: 27,
    turnRate: 0.9,
    defaultShape: "square",
    attack: 26,
    defence: 170,
    range: 9,
    attackInterval: 1.1,
    sight: 300,
    special: "fortify",
    cost: 7,
    maxPerArmy: 3,
  },
  mage: {
    id: "mage",
    name: "Adepts",
    role: "Adepts. Ward their own, hex the enemy, mend the wounded. Helpless alone.",
    soldiers: 8,
    hp: 65,
    speed: 30,
    turnRate: 1.4,
    attack: 10,
    defence: 40,
    range: 150,
    attackInterval: 2.4,
    sight: 460,
    defaultShape: "tight",
    special: "blink",
    cost: 8,
    maxPerArmy: 3,
    spell: "ward",
  },
  scout: {
    id: "scout",
    name: "Scouts",
    role: "Sees furthest of anything on the field. Buy these or fight in the dark.",
    soldiers: 6,
    hp: 60,
    speed: 74,
    turnRate: 2.4,
    attack: 9,
    defence: 35,
    range: 90,
    attackInterval: 1.5,
    sight: 900,
    defaultShape: "loose",
    special: "dash",
    cost: 3,
    volleys: 18,
    maxPerArmy: 5,
  },
  siege: {
    id: "siege",
    name: "Siege Engine",
    role: "Outranges everything and batters fortifications. Nearly immobile.",
    soldiers: 4,
    hp: 220,
    speed: 14,
    turnRate: 0.45,
    attack: 90,
    defence: 130,
    range: 460,
    attackInterval: 5.5,
    sight: 380,
    defaultShape: "line",
    cost: 9,
    volleys: 14,
    maxPerArmy: 3,
    siege: true,
  },
  healer: {
    id: "healer",
    name: "Surgeons",
    role: "Keeps a company on its feet. Mends wounds and steadies nerve, and cannot fight at all.",
    soldiers: 6,
    hp: 60,
    speed: 40,
    turnRate: 1.8,
    defaultShape: "loose",
    // Nominally armed and deliberately hopeless at it: the point of surgeons is
    // that buying them costs you fighting strength.
    attack: 4,
    defence: 30,
    range: 9,
    attackInterval: 2.4,
    sight: 400,
    special: "triage",
    cost: 5,
    maxPerArmy: 3,
    spell: "succour",
  },
  builder: {
    id: "builder",
    name: "Sappers",
    role: "Digs in. Raises fieldworks on the ground it holds, and breaks down walls and bridges.",
    soldiers: 8,
    hp: 80,
    speed: 34,
    turnRate: 1.4,
    defaultShape: "loose",
    attack: 10,
    defence: 60,
    range: 9,
    attackInterval: 1.6,
    sight: 340,
    special: "entrench",
    cost: 5,
    maxPerArmy: 3,
    siege: true,
    builds: true,
  },
  pike: {
    id: "pike",
    name: "Pikemen",
    role: "A hedge of long spears. Stops horse dead and holds a front; slow to turn and miserable when taken in the side.",
    soldiers: 22,
    hp: 95,
    speed: 26,
    turnRate: 0.7,
    defaultShape: "square",
    attack: 18,
    defence: 100,
    range: 16,
    attackInterval: 1.0,
    sight: 300,
    special: "setPikes",
    cost: 4,
    maxPerArmy: 8,
  },
  crossbow: {
    id: "crossbow",
    name: "Crossbowmen",
    role: "Slow to reload and hard-hitting. Behind a pavise they outlast any archer duel; they cannot shoot on the move.",
    soldiers: 14,
    hp: 80,
    speed: 28,
    turnRate: 1.1,
    defaultShape: "line",
    attack: 30,
    defence: 70,
    range: 210,
    attackInterval: 3.1,
    sight: 400,
    special: "pavise",
    cost: 4,
    volleys: 22,
    maxPerArmy: 6,
  },
  lancer: {
    id: "lancer",
    name: "Lancers",
    role: "Heavy shock horse. One terrible charge, then an ordinary melee. Save them for the moment, and never into pikes.",
    soldiers: 8,
    hp: 150,
    speed: 54,
    turnRate: 1.2,
    defaultShape: "wedge",
    attack: 40,
    defence: 115,
    range: 11,
    attackInterval: 1.4,
    sight: 480,
    special: "couch",
    cost: 7,
    maxPerArmy: 3,
  },
  slinger: {
    id: "slinger",
    name: "Slingers",
    role: "Cheap stones thrown from loose order. Short-ranged and unarmoured, but they never run out of ammunition.",
    soldiers: 12,
    hp: 60,
    speed: 44,
    turnRate: 2.1,
    defaultShape: "loose",
    attack: 10,
    defence: 40,
    range: 140,
    attackInterval: 1.2,
    sight: 440,
    special: "dodge",
    cost: 2,
    volleys: 60,
    maxPerArmy: 8,
  },
  champion: {
    id: "champion",
    name: "Champions",
    role: "A handful of famous fighters. Their challenge shakes whoever they meet; lose them and your own side feels it.",
    soldiers: 4,
    hp: 260,
    speed: 32,
    turnRate: 1.5,
    defaultShape: "tight",
    attack: 44,
    defence: 160,
    range: 10,
    attackInterval: 1.0,
    sight: 340,
    special: "challenge",
    cost: 6,
    maxPerArmy: 2,
  },
  banner: {
    id: "banner",
    name: "Colour Party",
    role: "The standard and its guard. Fights badly, but every wavering company that can see the colours finds its nerve.",
    soldiers: 6,
    hp: 90,
    speed: 32,
    turnRate: 1.4,
    defaultShape: "tight",
    attack: 12,
    defence: 90,
    range: 9,
    attackInterval: 1.3,
    sight: 360,
    special: "rally",
    cost: 5,
    maxPerArmy: 2,
  },
  drummer: {
    id: "drummer",
    name: "Drummers",
    role: "Beats the march. Companies near them move a quarter faster in step. No use at all in a fight.",
    soldiers: 6,
    hp: 60,
    speed: 36,
    turnRate: 1.6,
    defaultShape: "loose",
    attack: 4,
    defence: 30,
    range: 9,
    attackInterval: 2.2,
    sight: 340,
    special: "cadence",
    cost: 3,
    maxPerArmy: 2,
  },
  hounds: {
    id: "hounds",
    name: "War Hounds",
    role: "Fast, savage, and frightening. Horses hate them. They cannot hold anything and break the moment they bleed.",
    soldiers: 10,
    hp: 55,
    speed: 66,
    turnRate: 2.6,
    defaultShape: "loose",
    attack: 15,
    defence: 30,
    range: 8,
    attackInterval: 0.8,
    sight: 420,
    special: "terror",
    cost: 3,
    maxPerArmy: 4,
  },
  oathsworn: {
    id: "oathsworn",
    name: "Oath-sworn",
    role: "Men who have sworn not to leave the field. Ordinary until half of them are dead, then impossible to break.",
    soldiers: 16,
    hp: 110,
    speed: 29,
    turnRate: 1.0,
    defaultShape: "line",
    attack: 22,
    defence: 120,
    range: 9,
    attackInterval: 1.0,
    sight: 300,
    special: "lastStand",
    cost: 5,
    maxPerArmy: 4,
  },
  wagon: {
    id: "wagon",
    name: "War Wagons",
    role: "Armoured carts with handguns. Slow on the road and slower off it; chained into a ring they are a fort.",
    soldiers: 4,
    hp: 240,
    speed: 18,
    turnRate: 0.5,
    defaultShape: "line",
    attack: 28,
    defence: 150,
    range: 170,
    attackInterval: 2.6,
    sight: 360,
    special: "laager",
    cost: 6,
    volleys: 30,
    maxPerArmy: 3,
  },
};

/**
 * APPEND ONLY. Soldiers.type is an index into this list and is hashed, so
 * inserting anywhere but the end would silently reinterpret every recorded
 * replay and every golden -- a line company would become a scout.
 */
export const UNIT_TYPE_IDS: readonly UnitTypeId[] = [
  "line", "skirmisher", "archer", "horse", "guard", "mage", "scout", "siege",
  "healer", "builder",
  "pike", "crossbow", "lancer", "slinger", "champion",
  "banner", "drummer", "hounds", "oathsworn", "wagon",
];
