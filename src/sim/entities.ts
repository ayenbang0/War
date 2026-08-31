/**
 * Soldiers are the entities. Groups are something the player draws.
 *
 * There is no inherent squad. Every soldier carries its own type, stats, hit
 * points, morale and orders-of-the-moment, and exists whether or not anyone has
 * grouped it with anything. A "group" is nothing more than a set of soldiers
 * the player lassoed together with the pen, and it dissolves the moment they
 * stop being useful together.
 *
 * That is a deliberate inversion of the usual RTS model, and it changes what
 * the data has to look like: membership cannot be a contiguous index range
 * decided at spawn, because the player decides it at runtime and changes their
 * mind constantly. Soldiers therefore live in one flat store addressed by id,
 * and a group holds a list of those ids.
 */

import { UNIT_TYPE_IDS, UNIT_TYPES, type UnitTypeId } from "../content/unit-types.ts";
import { DOCTRINES, DOCTRINE_IDS, type DoctrineId } from "../content/doctrines.ts";
import type { FormationShape } from "./formations.ts";

/** Numeric type index, so soldier type can live in a typed array. */
export function typeIndex(id: UnitTypeId): number {
  return UNIT_TYPE_IDS.indexOf(id);
}

export function typeAt(index: number): UnitTypeId {
  return UNIT_TYPE_IDS[index];
}

/** A soldier's effective stats: its own type, with its army's doctrine folded in. */
export type Stats = {
  readonly hp: number;
  readonly speed: number;
  readonly turnRate: number;
  readonly attack: number;
  readonly defence: number;
  readonly range: number;
  readonly attackInterval: number;
  readonly sight: number;
  readonly resolve: number;
  readonly magic: number;
  readonly shape: FormationShape;
};

/**
 * Every (type, doctrine) combination, computed once at module load.
 *
 * Eight types by four doctrines is thirty-two rows. Combat reads a soldier's
 * stats several times per tick per soldier, so folding doctrine multipliers in
 * on every read would be thousands of pointless multiplications a tick for an
 * answer that never changes mid-match.
 */
const TABLE = new Map<string, Stats>();
for (const t of UNIT_TYPE_IDS) {
  for (const d of DOCTRINE_IDS) {
    const u = UNIT_TYPES[t];
    const k = DOCTRINES[d];
    TABLE.set(t + "/" + d, {
      hp: u.hp * k.hp,
      speed: u.speed * k.speed,
      turnRate: u.turnRate * k.turnRate,
      attack: u.attack * k.attack,
      defence: u.defence * k.defence,
      range: u.range,
      attackInterval: u.attackInterval,
      sight: u.sight * k.sight,
      resolve: k.resolve,
      magic: k.magic,
      shape: u.defaultShape,
    });
  }
}

export function statsFor(type: UnitTypeId, doctrine: DoctrineId): Stats {
  return TABLE.get(type + "/" + doctrine) as Stats;
}

/**
 * All soldiers on the field, in parallel typed arrays.
 *
 * Struct-of-arrays because the hot loops walk one field at a time across
 * hundreds of soldiers; an array of objects would scatter every read.
 */
export class Soldiers {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly facing: Float64Array;
  readonly hp: Float64Array;
  readonly maxHp: Float64Array;
  /** Each soldier's own nerve. Group and army morale are derived from these. */
  readonly morale: Float64Array;
  readonly cooldown: Float64Array;
  /** Damage buffered this tick; applied only once every blow is resolved. */
  readonly incoming: Float64Array;
  /** Group index of whoever last struck, for kill credit. -1 for none. */
  readonly struckBy: Int32Array;
  readonly player: Uint8Array;
  /** Index into UNIT_TYPE_IDS. */
  readonly type: Uint8Array;
  readonly alive: Uint8Array;
  /** Group id this soldier belongs to, or -1 when it stands alone. */
  readonly group: Int32Array;
  /** Slot within its group's formation, or -1. */
  readonly slot: Int32Array;
  /**
   * Which armies can currently perceive this soldier: bit 0 for player 0, bit 1
   * for player 1. Recomputed once a tick from sight radii and line of sight.
   *
   * Cached rather than asked on demand: the renderer alone would otherwise ask
   * "can I see him?" once per enemy per frame, and each answer scans for a
   * watcher -- quadratic work every frame to decide what to draw.
   */
  readonly seen: Uint8Array;
  count = 0;

  constructor(capacity: number) {
    this.x = new Float64Array(capacity);
    this.y = new Float64Array(capacity);
    this.facing = new Float64Array(capacity);
    this.hp = new Float64Array(capacity);
    this.maxHp = new Float64Array(capacity);
    this.morale = new Float64Array(capacity);
    this.cooldown = new Float64Array(capacity);
    this.incoming = new Float64Array(capacity);
    this.struckBy = new Int32Array(capacity).fill(-1);
    this.player = new Uint8Array(capacity);
    this.type = new Uint8Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.group = new Int32Array(capacity).fill(-1);
    this.slot = new Int32Array(capacity).fill(-1);
    this.seen = new Uint8Array(capacity);
  }

  get capacity(): number {
    return this.x.length;
  }
}

export type Stance = "idle" | "move" | "attack" | "hold" | "retreat" | "patrol" | "recover";

/** Fixed order, so a stance hashes as a stable index. Append only. */
export const STANCES: readonly Stance[] = [
  "idle", "move", "attack", "hold", "retreat", "patrol", "recover",
];

/**
 * A group: soldiers the player chose to command together.
 *
 * Created by drawing, not by spawning. It owns no soldiers -- it names them --
 * and when its last member dies or leaves, it simply ceases to exist.
 */
export type Group = {
  readonly id: number;
  readonly player: number;
  /** Soldier ids, kept sorted so iteration order never depends on click order. */
  members: number[];
  /** Formation centre, recomputed from the members that are left. */
  anchorX: number;
  anchorY: number;
  facing: number;
  shape: FormationShape;
  /** Local-space slots, resized whenever membership changes. */
  slots: Float64Array;
  radius: number;
  path: number[];
  pathRevision: number;
  stance: Stance;
  /** Group id being attacked, or -1. */
  target: number;
  holdX: number;
  holdY: number;
  holdRadius: number;
  patrol: number[];
  patrolLeg: number;
  patrolForward: boolean;
  recoverUntil: number;
  spellReady: number;
  /** Fraction of members standing in their slots. */
  cohesion: number;
  kills: number;
  losses: number;
  casualtiesThisTick: number;
  killsThisTick: number;
  lastContact: number;
  flanked: boolean;
  seenBy: [boolean, boolean];
};
