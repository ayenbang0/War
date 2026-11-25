/**
 * The seam between the kingdom layer and the battle layer (PLAN.md §B.9).
 *
 * K1 put the combined layer hash here. K5 adds the handoff contract --
 * `BattleSpec` built from kingdom state by one pure function
 * (sim/kingdom/descent.ts `buildBattleSpec`), `BattleResult` applied back by
 * another (`applyBattleResult`) -- as types in this same file, with a hash of
 * each so a desync or a test can name which handoff differed.
 *
 * Why a combined hash with the parts kept visible: a desync report that says
 * only "the hashes differ" leaves you bisecting two simulations at once. The
 * kingdom hash covers KingdomWorld, the battle hash covers the live World (if
 * one is running), and comparing the parts names the layer that drifted --
 * the same philosophy as the stable/world split of the battle goldens.
 */

import { FNV_OFFSET, mixF64, mixU32 } from "./hash.ts";
import type { VictoryConfig } from "./victory.ts";
import type { UnitTypeId } from "../content/unit-types.ts";
import type { DoctrineId } from "../content/doctrines.ts";
import type { AbilityId } from "../content/abilities.ts";
import type { CommanderId } from "../content/commanders.ts";
import type { DifficultyId } from "../content/difficulty.ts";
import type { Fortification } from "../content/kingdom/descent.ts";
import { FORTIFICATIONS } from "../content/kingdom/descent.ts";
import { UNIT_TYPE_IDS } from "../content/unit-types.ts";
import { DOCTRINE_IDS } from "../content/doctrines.ts";
import { ABILITY_IDS } from "../content/abilities.ts";
import { COMMANDER_IDS } from "../content/commanders.ts";
import { DIFFICULTY_IDS } from "../content/difficulty.ts";

// -- K5: the handoff contract (PLAN.md §B.9) --------------------------------------------

/**
 * One squad as a battle takes it from the kingdom: its id there, its kind,
 * the men with the colours and how many of them are wounded. Only the fit
 * (men - wounded) take the field; the wounded wait with the baggage and come
 * back with whoever is left. A townsmen's squad (an assault's defenders) has
 * squad id 0: it is no army's.
 */
export type SpecSquad = {
  readonly squad: number;
  readonly unit: UnitTypeId;
  readonly men: number;
  readonly wounded: number;
};

/** One side of a battle as the kingdom builds it. */
export type BattleSide = {
  /** Faction index (FACTION_IDS). */
  readonly faction: number;
  /** Army id, or 0 for a holding's townsmen. */
  readonly army: number;
  /** For the report: "First Army", "the townsmen of Harrowfield". */
  readonly name: string;
  readonly doctrine: DoctrineId;
  /** Whose battle habits the machine plays this side with; null for the king's own (a person commands it). */
  readonly commander: CommanderId | null;
  readonly difficulty: DifficultyId;
  readonly abilities: readonly AbilityId[];
  /** Kingdom morale, 0..100: the starting nerve of every man. */
  readonly morale: number;
  /** In the army's id order. */
  readonly squads: readonly SpecSquad[];
};

/**
 * Everything a battle is built from, out of kingdom state alone
 * (sim/kingdom/descent.ts `buildBattleSpec`, one pure function). Plain data:
 * the app turns it into a BattleConfig, the headless suite into a World.
 */
export type BattleSpec = {
  /** The contact it settles. */
  readonly contact: number;
  /** The battlefield's seed: the holding's own, so the same place always yields the same ground. */
  readonly seed: number;
  readonly terrain: {
    /** Level whose size, deployment zones and night the battle borrows (the holding's country, terrain.ts BIOMES). */
    readonly level: string;
    readonly biome: string;
    readonly holding: number;
    /** 0 at a holding. */
    readonly road: number;
    readonly fortification: Fortification;
  };
  /** sides[0] is the king's whenever he has a side in it: the battle's player 0. */
  readonly sides: readonly [BattleSide, BattleSide];
  readonly deployment: {
    /** Side index that moved into the other. */
    readonly attacker: number;
    /** The defender was dug in where it stood (hold for two days or more). */
    readonly ambush: boolean;
  };
  readonly victory: VictoryConfig;
  /** Seconds the battle may run. */
  readonly duration: number;
  /** The day's weather and the season, for the report and (K11) sight. */
  readonly weather: string;
  readonly season: string;
  /** Night or murk: every man's sight scaled by this (1 = clear day). */
  readonly sightScale: number;
  /** Armies near enough to march on partway through. K5 fields none (docs/PROVISIONAL.md K5.9). */
  readonly reinforcements: readonly number[];
};

/**
 * Where a spec squad's men stand in a battle World: soldiers `first` ..
 * `first + count - 1` (the fit men, spawned together). Count 0 for a squad
 * with nobody fit to field. app/battle-config.ts `battleWorld` makes these.
 */
export type FieldedSquad = { readonly first: number; readonly count: number };

/** A squad after the battle: men left (wounded included) and how many of them are wounded. */
export type ResultSquad = { readonly squad: number; readonly men: number; readonly wounded: number };

/**
 * What a battle did, as the kingdom takes it back (descent.ts
 * `applyBattleResult`, one pure function). Per side, in BattleSpec order.
 */
export type BattleResult = {
  readonly contact: number;
  /** Side index, or -1 for a field nobody won. */
  readonly winner: number;
  readonly squads: readonly [readonly ResultSquad[], readonly ResultSquad[]];
  /** Morale after, 0..100. */
  readonly morale: readonly [number, number];
  /** The side quit the field: it lost, or (left) its commander took it off. It falls back, or is taken if cut off. */
  readonly fled: readonly [boolean, boolean];
  /** The side's commander took it off the field mid-battle (the withdrawal's rearguard is paid on top). */
  readonly left: readonly [boolean, boolean];
  /** Damage to the holding fought at: health off every growing crop, buildings knocked idle. */
  readonly damage: { readonly crops: number; readonly buildings: number };
  /** Legitimacy the king gains (or loses, negative). */
  readonly legitimacy: number;
};

function mixStr(h: number, s: string): number {
  h = mixU32(h, s.length);
  for (let i = 0; i < s.length; i++) h = mixU32(h, s.charCodeAt(i));
  return h;
}

/** Fingerprint a spec: every field, so two peers (or a test) can see they built the same battle. */
export function hashBattleSpec(s: BattleSpec): string {
  let h = FNV_OFFSET | 0;
  h = mixU32(h, s.contact);
  h = mixU32(h, s.seed);
  h = mixStr(h, s.terrain.level);
  h = mixStr(h, s.terrain.biome);
  h = mixU32(h, s.terrain.holding);
  h = mixU32(h, s.terrain.road);
  h = mixU32(h, FORTIFICATIONS.indexOf(s.terrain.fortification));
  for (const side of s.sides) {
    h = mixU32(h, side.faction);
    h = mixU32(h, side.army);
    h = mixStr(h, side.name);
    h = mixU32(h, DOCTRINE_IDS.indexOf(side.doctrine));
    h = mixU32(h, side.commander === null ? 0xff : COMMANDER_IDS.indexOf(side.commander));
    h = mixU32(h, DIFFICULTY_IDS.indexOf(side.difficulty));
    h = mixU32(h, side.abilities.length);
    for (const a of side.abilities) h = mixU32(h, ABILITY_IDS.indexOf(a));
    h = mixU32(h, side.morale);
    h = mixU32(h, side.squads.length);
    for (const q of side.squads) {
      h = mixU32(h, q.squad);
      h = mixU32(h, UNIT_TYPE_IDS.indexOf(q.unit));
      h = mixU32(h, q.men);
      h = mixU32(h, q.wounded);
    }
  }
  h = mixU32(h, s.deployment.attacker);
  h = mixU32(h, s.deployment.ambush ? 1 : 0);
  h = mixStr(h, JSON.stringify(s.victory));
  h = mixF64(h, s.duration);
  h = mixStr(h, s.weather);
  h = mixStr(h, s.season);
  h = mixF64(h, s.sightScale);
  h = mixU32(h, s.reinforcements.length);
  for (const r of s.reinforcements) h = mixU32(h, r);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Hash one result into a running hash (the order hash uses this too). */
export function mixBattleResult(h: number, r: BattleResult): number {
  h = mixU32(h, r.contact);
  h = mixU32(h, r.winner);
  for (let i = 0; i < 2; i++) {
    h = mixU32(h, r.squads[i].length);
    for (const q of r.squads[i]) {
      h = mixU32(h, q.squad);
      h = mixU32(h, q.men);
      h = mixU32(h, q.wounded);
    }
    h = mixU32(h, r.morale[i]);
    h = mixU32(h, r.fled[i] ? 1 : 0);
    h = mixU32(h, r.left[i] ? 1 : 0);
  }
  h = mixU32(h, r.damage.crops);
  h = mixU32(h, r.damage.buildings);
  h = mixU32(h, r.legitimacy);
  return h;
}

export function hashBattleResult(r: BattleResult): string {
  return (mixBattleResult(FNV_OFFSET | 0, r) >>> 0).toString(16).padStart(8, "0");
}

/** Which layer two peers disagree about, if any. */
export type Drift = "none" | "kingdom" | "battle" | "both";

function parseHex32(h: string): number {
  // Both hashes are 8 lowercase hex digits by construction; anything else is
  // a caller bug, and folding it to a fixed value would hide the drift.
  if (!/^[0-9a-f]{8}$/.test(h)) throw new Error("not a layer hash part: " + h);
  return parseInt(h, 16) | 0;
}

/**
 * h(kingdomHash, battleHash?): one 8-hex-digit fingerprint of the whole game.
 *
 * "No battle running" is mixed in as its own marker, so a kingdom alone never
 * collides with the same kingdom plus a battle whose hash happens to be zero.
 */
export function layerHash(kingdomHash: string, battleHash?: string): string {
  let h = FNV_OFFSET | 0;
  h = mixU32(h, 0x4b494e47); // "KING"
  h = mixU32(h, parseHex32(kingdomHash));
  if (battleHash === undefined) {
    h = mixU32(h, 0);
  } else {
    h = mixU32(h, 1);
    h = mixU32(h, parseHex32(battleHash));
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export type LayerHashes = { readonly kingdom: string; readonly battle?: string };

/** Compare two peers' layer hashes and name the layer that drifted. */
export function driftedLayer(a: LayerHashes, b: LayerHashes): Drift {
  const k = a.kingdom !== b.kingdom;
  const w = a.battle !== b.battle;
  return k && w ? "both" : k ? "kingdom" : w ? "battle" : "none";
}
