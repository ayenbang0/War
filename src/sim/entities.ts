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
/** How a blow landed. Low bits are the kind; FLANK_BIT rides on top. */
export const HOW_MELEE = 0;
export const HOW_RANGED = 1;
export const HOW_FLANK_BIT = 4;

/** Casualty causes, in report order. Indices into World.casualtiesByCause. */
export const CAUSES = ["melee", "shot", "flanked"] as const;
export type Cause = (typeof CAUSES)[number];

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
  /**
   * HOW that last blow landed, so a casualty can be explained afterwards.
   *
   * The kind in the low bits, FLANK_BIT set when it came from outside the
   * victim's frontal arc. Written wherever struckBy is, and read only when the
   * man actually dies -- the whole point is to be able to say "shot to pieces"
   * or "broken by a flank charge" rather than showing a bare casualty count.
   */
  readonly struckHow: Uint8Array;
  /**
   * Friends who fell within sight of this soldier THIS TICK.
   *
   * Only meaningful for men in no company. A soldier in a company feels its
   * casualties through the company; a man standing alone felt nothing at all,
   * which made an ungrouped army effectively immune to morale shock and so made
   * NOT commanding a viable strategy. He feels the men dying beside him now.
   */
  readonly localShock: Float64Array;
  /**
   * Volleys left. Only meaningful for men who shoot.
   *
   * Ammunition is what stops a line of archers being an answer to everything:
   * a company that has shot itself dry is a bad melee unit standing in the open,
   * and getting it back means standing it down, which costs thirty seconds of
   * doing nothing at all. It turns "where do I put my shooters" into a question
   * with a wrong answer.
   */
  readonly ammo: Float64Array;
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
    this.struckHow = new Uint8Array(capacity);
    this.localShock = new Float64Array(capacity);
    this.ammo = new Float64Array(capacity);
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

export type Stance =
  | "idle" | "move" | "attack" | "hold" | "retreat" | "patrol" | "recover" | "ambush";

/** Fixed order, so a stance hashes as a stable index. Append only. */
/**
 * APPEND ONLY. Hashed by index, so inserting anywhere but the end would
 * reinterpret every recorded replay and golden.
 */
export const STANCES: readonly Stance[] = [
  "idle", "move", "attack", "hold", "retreat", "patrol", "recover", "ambush",
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
  /**
   * What this company is called, e.g. "2nd Foot", "Ashcroft's Horse".
   *
   * Derived deterministically from the id and the men in it, so it needs no
   * hashing of its own. It exists so the after-action report can tell you which
   * company held and which broke, rather than reciting anonymous numbers.
   */
  readonly name: string;
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
  /** Tick until which this company counts as charging, for the impact bonus. */
  chargeUntil: number;
  /** Accumulated digging effort toward a fieldwork on the ground it holds. */
  buildTicks: number;
  /**
   * Tick at which a feint turns around, or 0. A feint is a genuine advance
   * followed by a genuine withdrawal -- the deception is that the enemy cannot
   * tell which it is until it happens.
   */
  feintTurn: number;
  /** Where a feint came from, and so where it goes back to. */
  feintHomeX: number;
  feintHomeY: number;
  spellReady: number;
  /** Fraction of members standing in their slots. */
  cohesion: number;
  /** Members who broke ranks to fight last tick. Drives the halt in contact. */
  engaged: number;
  kills: number;
  losses: number;
  /** Of those losses, how many were cut down from outside the frontal arc. */
  flankLosses: number;
  /** Tick at which this company's nerve broke, or -1. Reported afterwards. */
  brokeAt: number;
  /** Tick at which the last man fell, or -1. Kept so the report can still
   *  account for companies that no longer exist. */
  destroyedAt: number;
  /** Men in it when it was raised, since members only ever shrinks. */
  raisedWith: number;
  casualtiesThisTick: number;
  /** Of those, the ones cut down from outside the front. Drives flank shock. */
  flankCasualtiesThisTick: number;
  killsThisTick: number;
  lastContact: number;
  flanked: boolean;
  seenBy: [boolean, boolean];
};
