/**
 * The world: all simulation state, and the single tick function that advances it.
 *
 * Invariants (see CLAUDE.md):
 *   - No DOM, no canvas, no browser globals. Runs headless under node.
 *   - No wall-clock time. tick is the only clock.
 *   - Mutated exclusively by step(), exclusively at tick boundaries.
 *
 * THE ENTITY IS THE SOLDIER. There is no inherent squad: each soldier carries
 * its own type, stats, hit points and nerve, and stands on the field whether or
 * not anyone has grouped it with anything. Groups are drawn by the player and
 * exist only as long as they are useful. Everything below follows from that --
 * membership is a list that changes at runtime, formations are sized to whoever
 * is currently in the group, and a group with no living members disappears.
 *
 * MOVEMENT IS THREE LAYERS, never conflated:
 *   1. The group anchor walks a coarse route from pathfind.ts.
 *   2. Each member is assigned a slot in the formation template.
 *   3. Each soldier steers toward its own slot, pushing off neighbours.
 */

import { atan2, clamp, cos, dist, floor, max, min, PI, rotateToward, round, sin, sqrt, TAU } from "./math.ts";
import { Rng, Stream } from "./rng.ts";
import { OrderQueue, SETUP_ORDER_KINDS, type Order } from "./orders.ts";
import { generateTerrain, isGate, isWork, Terrain, TerrainGrid, TERRAIN_INFO, TILE_SIZE, type TerrainType } from "./terrain.ts";
import { FIRE_TILE_DPS, igniteDisc, stepFire } from "./fire.ts";
import { gateTiles, raiseSiegeWorks, siegeDamage, type SiegeWorks } from "./siege.ts";
import { formationSlots, formationRadius, type FormationShape } from "./formations.ts";
import { advanceToward } from "./movement.ts";
import { SpatialHash } from "./spatial.ts";
import { clearLine, findPathPartial, findPathStrict, smoothRoute } from "./pathfind.ts";
import { UNIT_TYPES } from "../content/unit-types.ts";
import { companyName } from "../content/companies.ts";
import { type DoctrineId } from "../content/doctrines.ts";
import {
  HOW_FLANK_BIT, HOW_MELEE, HOW_RANGED, Soldiers, statsFor, typeAt, typeIndex,
  type Group, type Stats,
} from "./entities.ts";
import { MELEE_RANGE, d2, hitDamage, isFlanking } from "./combat.ts";
import { COMPANY_BREAK, globalMorale, nextMorale } from "./morale.ts";
import { DEFAULT_VICTORY, evaluate, type ArmyState, type ControlPoint, type Outcome, type VictoryConfig } from "./victory.ts";
import { FogField, concealment, effectiveSight, hasLineOfSight, parapetCover, rangeFromHeight } from "./vision.ts";
import { ArmyAI } from "./ai.ts";
import type { Commander } from "../content/commanders.ts";
import {
  OFFENSIVE_SPELLS, SPELLS, SUPPORTIVE_SPELLS, hexPenalty, mendRate, nerveShift,
  succourRate, wardSoak, type SpellId, type Working,
} from "./magic.ts";
import { ABILITIES, type AbilityId } from "../content/abilities.ts";
import {
  BRACE_SLOWDOWN, BRACE_SOAK, DASH_HASTE, DODGE_CHANCE, ENTRENCH_SPEED, FORTIFY_SOAK,
  SPECIALS, TRIAGE_HEAL, TRIAGE_RADIUS, type SpecialId,
  CADENCE_HASTE, CADENCE_RADIUS, CHALLENGE_RADIUS, CHALLENGE_SHOCK, CHALLENGE_STRIKE,
  COUCH_BONUS, LAAGER_PASS, LAAGER_RADIUS, LAAGER_SHELTER, LAST_STAND_FLOOR,
  LAST_STAND_STRIKE, PAVISE_PASS, RALLY_GAIN, RALLY_RADIUS, SET_PIKES_PASS,
  TERROR_DRAIN, TERROR_HORSE, TERROR_RADIUS,
} from "../content/specials.ts";

/** A commander's ability standing on the field. */
export type AbilityField = {
  /**
   * A commander's ability, or "bulwark" -- the works sappers throw up, which
   * behave the same way (a circle of ground that does something to whoever
   * stands in it) and so live in the same list.
   */
  readonly ability: AbilityId | "bulwark";
  readonly player: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly until: number;
};

/** What is left of one ability, for one player. */
export type AbilityCharge = { left: number; readyAt: number };

/**
 * A company arriving partway through a battle.
 *
 * The answer to turtling: sitting on a hill trading nothing is a fine plan
 * right up until the ground behind you fills with men who were not there when
 * you chose it. Spawned from the tick count alone, so a replay produces the
 * same arrivals at the same moment.
 */
export type Reinforcement = {
  readonly atSeconds: number;
  readonly player: number;
  readonly type: UnitTypeId;
  readonly count: number;
  readonly x: number;
  readonly y: number;
};
import type { UnitTypeId } from "../content/unit-types.ts";

export const TICK_RATE = 20;
export const TICK_DT = 1 / TICK_RATE;

/** Soldiers push apart inside this radius. Must stay below the tightest rank
 *  spacing any formation produces, or a settled formation shoves itself apart. */
const SEPARATION_RADIUS = 7;
const SEPARATION_WEIGHT = 1.35;
/**
 * Distance over which a soldier eases into his slot.
 *
 * It also sets the steady-state lag while marching: a soldier throttled to
 * d/EASE of his pace settles where that equals the anchor's pace, roughly EASE
 * units behind. Keep it comfortably under IN_SLOT or a marching group reads as
 * permanently out of formation even though nothing is wrong.
 */
const ARRIVE_EASE = 4;
/**
 * A group marches at this fraction of its slowest member's pace.
 *
 * Without the margin a formation can never dress itself while moving: the
 * anchor travels at exactly the speed its men can manage, so whatever gap a
 * soldier starts with he keeps forever, and a group that has just been drawn
 * around scattered men never actually forms up. Marching pace has always been
 * below top speed for the same reason.
 */
const FORMATION_PACE = 0.85;
const IN_SLOT = 7;
const STRANDED_WADE = 0.35;
/**
 * How far a hand-to-hand soldier will break ranks to get at an enemy.
 *
 * Men with spears do not march politely past someone trying to kill them, and
 * before this they did exactly that: fighting only happened where a formation
 * slot happened to put two enemies within reach, so a line ordered across the
 * field would walk straight through an enemy company and out the other side.
 * Deliberately short -- this is stepping out of line to meet someone already on
 * top of you, not licence to charge off after anything on the horizon.
 */
const ENGAGE_RANGE = 110;
/**
 * Share of a group that must be fighting before the group itself halts.
 *
 * Soldiers breaking ranks is not enough on its own: the anchor kept walking its
 * route and simply dragged the fight along behind it, so a line "stopped to
 * fight" while still crossing the map. A body of troops in contact stays in
 * contact until the matter is settled -- and a march order is not a reason to
 * turn your back on someone with a spear.
 */
const ENGAGE_HALT_FRACTION = 0.2;
/**
 * Directions to try when a soldier walks into something, in order.
 *
 * Shallow deflections first so a man hugs the obstacle rather than veering off
 * across the field, and both ways at each angle so a shoreline can be followed
 * in whichever direction actually opens up.
 */
const DEFLECTIONS = [0.55, -0.55, 1.1, -1.1, 1.7, -1.7];
/** Distance from station beyond which a soldier checks his route is walkable. */
const SLOT_DETOUR_CHECK = 45;
/** Cell size of the sight hash, in world units. */
const SIGHT_CELL = 128;
/** Nothing on the field perceives further than this. Bounds every sight query. */
const MAX_SIGHT = 1200;
/**
 * Ticks between perception sweeps.
 *
 * Working out who can see whom is the most expensive thing in the tick: every
 * soldier against every possible watcher, each pair needing a line-of-sight
 * raycast. It is also the least urgent -- a quarter of a second of staleness in
 * what the fog reveals is imperceptible, while doing it at full rate cost more
 * than combat, movement and morale combined.
 */
const SIGHT_INTERVAL = 4;
/** Blocked line-of-sight checks to try per soldier before giving up on it. */
const MAX_RAYCASTS = 6;
/**
 * How much a fully dressed formation adds to its men's defence.
 *
 * The single most important number in the game's balance. Cohesion was already
 * computed and purely decorative, which meant formations -- the entire point of
 * the pen -- conferred nothing measurable, and an army given no orders at all
 * fought nearly as well as one that was commanded. A rank standing in its slot,
 * shoulder to shoulder, is very much harder to kill than the same men strung
 * out across a field, and now the simulation says so.
 *
 * Men in no group at all get NONE of this. That is what makes grouping pay.
 */
const COHESION_ARMOUR = 1.05;
/**
 * How much harder a dressed company hits than the same men in a crowd.
 *
 * Defence alone was not enough. An organised army took meaningfully less damage
 * and still only traded evenly with a mob, because a mob standing in its own
 * deployment zone is accidentally playing defence and the win condition rewards
 * an even trade. Drill makes a body of troops better at DEALING with an enemy,
 * not merely at surviving one -- ranks that hold their dressing bring their
 * weapons to bear together instead of as a scatter of individual brawls.
 */
const COHESION_STRIKE = 0.55;
/**
 * Ticks out of contact after which arriving counts as a fresh charge.
 *
 * Without a lull requirement a grinding melee would re-trigger the charge bonus
 * every few ticks and turn a standing fight into a permanent one.
 */
/**
 * How far from his slot a fighting man still counts as holding the line.
 *
 * Generous enough to cover leaning out at someone directly in front, tight
 * enough that a man who has run down the field after somebody has plainly left
 * the formation and should not be propping up its cohesion.
 */
const FORMED_WHILE_FIGHTING = 30;
/** How far the shock of a man falling reaches men who have no company. */
const LOOSE_SHOCK_RADIUS = 95;
/**
 * What a lone man measures losses against.
 *
 * He has no roster, so casualties are weighed against the handful of men within
 * sight of him. Small on purpose: a crowd with nobody commanding it comes apart
 * far faster than a company of the same size, which is the entire argument for
 * bothering to draw a company at all.
 */
const LOOSE_ROSTER = 7;
/** Seconds a feint presses forward before turning back. */
const FEINT_ADVANCE_SECONDS = 7;
/**
 * How close an enemy must come before an ambush springs.
 *
 * Short: the whole point is letting them walk right onto you. Longer than
 * melee reach so the first volley still lands before contact.
 */
const AMBUSH_TRIGGER = 150;
/** Seconds of extra bite an ambush gets when it springs. */
const AMBUSH_BITE_SECONDS = 3;
/** Damage a barrage does per second to everyone standing under it. */
const BARRAGE_DAMAGE_PER_SEC = 46;
/** Firepots burn only the enemy, at this share of a barrage, for longer. */
const FIRE_DAMAGE_PER_SEC = BARRAGE_DAMAGE_PER_SEC * 0.45;
/** Pace an enemy company keeps on ground sown with caltrops. */
const CALTROP_SCALE = 0.4;
/** Nerve a muster puts back into every man of the company, at once. */
const MUSTER_NERVE = 0.35;
/** Nerve a forced march costs at the outset: they arrive, and tired. */
const MARCH_FATIGUE = 0.1;
/** Nerve per second a beacon's glow gives the side that lit it. */
const BEACON_GAIN = 0.05;
/** Men in a company of militia called up mid-battle. */
const LEVY_STRENGTH = 16;
/** How far a fieldwork's benefit reaches from the tile it was dug on. */
const BULWARK_RADIUS = 120;
/** Seconds a fieldwork keeps helping the men who dug it. */
const BULWARK_SECONDS = 150;
/** Damage a fieldwork turns aside for the side that built it. */
const BULWARK_SOAK = 0.3;
/** How much weaker a blow is when struck from inside an enemy's works. */
const BULWARK_ASSAULT_PENALTY = 0.25;
/** Damage a shield wall turns aside. Capped well short of immunity. */
const SHIELD_SOAK = 0.45;
/** How well smoke hides whoever is standing in it, for the sight-range term. */
const SMOKE_CONCEALMENT = 0.75;
/** Inside this range men in smoke can still be made out. */
const SMOKE_SEE_THROUGH = 70;
/** How much faster a company ordered to charge actually moves. */
const CHARGE_HASTE = 1.45;
const CHARGE_LULL = 40;
/** Seconds the charge bonus lasts once contact is made. */
const CHARGE_SECONDS = 2;
/** Extra damage while charging. Rewards committing at speed rather than drifting in. */
const CHARGE_BONUS = 0.45;
/** Digger-ticks of work a fieldwork costs. Eight sappers take about ten seconds. */
const FORTIFY_WORK = 1600;
/**
 * Damage one engine does to works per tick. A full battery of four takes a
 * stone wall section (2400) in about 25 seconds and a gate (900) in under ten.
 */
const BATTER_PER_ENGINE = 1.2;
/**
 * Damage one sapper does per tick, to works, bridges and woods. Eight take a
 * wall section in under forty seconds, a span of bridge or a tile of wood in
 * about four. Slower than engines at a wall, but they can work right up
 * against it and they are the only men who can fell a wood or cut a bridge.
 */
const SAP_PER_SAPPER = 0.4;
/** How far a sapper reaches to work: the tiles around where the company stands. */
const SAP_REACH = TILE_SIZE * 2;
/** Damage a barrage does to works and bridges under it, per second. */
const BARRAGE_WORKS_PER_SEC = 60;
/** Share of a firepot throw's radius that sets timber and woods alight. */
const FIREPOT_IGNITE_SHARE = 0.5;
/** Nerve lost by a man flung off a span as it falls. Nobody drowns. */
const FALL_SHOCK = 0.2;
/** How far, in tiles, to look for standing ground for a man the ground fell from. */
const EVICT_SEARCH = 8;
/** Share of a full load a standing-down company recovers each second. */
const RESUPPLY_FRACTION_PER_SEC = 0.05;
const RECOVER_MORALE_PER_SEC = 0.06;
const RECOVER_HP_FRACTION_PER_SEC = 0.04;
export const RECOVER_LOCK_SECONDS = 30;

export type CombatEvent = {
  readonly kind: "shot" | "melee";
  readonly player: number;
  /** Attacker's unit type, so the renderer can animate the right weapon. */
  readonly type: UnitTypeId;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  lethal: boolean;
  readonly victim: number;
  /**
   * The soldier who struck. Presentation only, like the rest of the event: the
   * renderer gates a blow on whether the viewer can see EITHER man (audit
   * RF-04), which needs to know who threw it, not merely from where.
   */
  readonly attacker: number;
};

export type WorldConfig = {
  readonly seed: number;
  readonly tilesWide: number;
  readonly tilesHigh: number;
  readonly soldierCapacity?: number;
  readonly duration?: number;
  readonly aiPlayers?: readonly number[];
  /** How well those commanders are run. Not what they can see or field. */
  readonly aiTuning?: { think: number; commit: number; focus: number };
  /** Who commands the machine's army. Leanings only, never advantages. */
  readonly commander?: Commander;
  /** How this match is won. Defaults to breaking the enemy's nerve. */
  readonly victory?: VictoryConfig;
  /** Ground worth standing on, for the objective and point modes. */
  readonly controlPoints?: readonly ControlPoint[];
  /** Fresh companies marching on partway through the battle. */
  readonly reinforcements?: readonly Reinforcement[];
  /**
   * Night: every man's sight is scaled by this. Absent means full daylight,
   * and multiplying by exactly 1 changes nothing, so day battles are untouched.
   */
  readonly sightScale?: number;
  /** The river rises at this second: every bridge goes under and ford turns to flood. */
  readonly floodAtSeconds?: number;
  /**
   * A siege: walls and gates raised round the defended place before anyone is
   * set down (sim/siege.ts). The hook a K10 siege battle builds its field with.
   */
  readonly siege?: SiegeWorks;
};

export { statsFor, typeAt, typeIndex, STANCES } from "./entities.ts";
export type { Group, Stance, Stats } from "./entities.ts";

export class World {
  tick = 0;
  readonly seed: number;
  readonly terrain: TerrainGrid;
  readonly orders = new OrderQueue();
  readonly soldiers: Soldiers;
  /** Groups the players have drawn. Never created by spawning. */
  readonly groups: Group[] = [];
  /**
   * EVERY company ever raised, including those since wiped out.
   *
   * `groups` is the live board and a company that loses its last man is spliced
   * straight out of it -- which are precisely the companies an after-action
   * report most needs to name. This list never shrinks so the account of the
   * battle can still mention them.
   */
  readonly raised: Group[] = [];
  readonly duration: number;
  outcome: Outcome | null = null;
  /** While true the board is being set out and the match has not begun. */
  deploying = false;
  readonly doctrine: [DoctrineId, DoctrineId] = ["maneuver", "maneuver"];
  readonly events: CombatEvent[] = [];
  /**
   * Moments worth a flash on screen: a bow thrown down, adepts stepping out of
   * the world. Presentation only -- written here and never read back, like
   * CombatEvent.
   */
  readonly specialEvents: { kind: SpecialId; x: number; y: number; player: number }[] = [];
  /** Companies that ceased to exist this tick. Presentation only, like events. */
  readonly disbanded: number[] = [];
  /**
   * The works each side has thrown up, as a NETWORK rather than scattered
   * holes.
   *
   * Sappers extend from what is already standing, so a position grows outward
   * from its first redoubt into a connected system: a wall where the works run
   * in a line, a battlement where several meet. What a piece becomes is decided
   * by how many friendly works already touch it, which means the shape of the
   * base is a consequence of where it was dug rather than a thing chosen from
   * a menu.
   */
  readonly works: {
    tx: number; ty: number; player: number; kind: "redoubt" | "wall" | "battlement";
    builtAt: number;
  }[] = [];
  /** Works under construction, for the digging animation. Presentation only. */
  readonly building: { tx: number; ty: number; player: number; progress: number }[] = [];
  readonly workings: Working[] = [];
  /**
   * Commander's abilities currently standing on the field.
   *
   * Separate from workings because a working is something a UNIT does and these
   * are things the commander spends -- different lifetimes, different rules,
   * and mixing them would mean every spell check had to ask which it was.
   */
  readonly fields: AbilityField[] = [];
  /** Charges left and cooldowns, per player. Set up from the army list. */
  readonly abilityState: [Map<AbilityId, AbilityCharge>, Map<AbilityId, AbilityCharge>] =
    [new Map(), new Map()];
  readonly ai: ArmyAI[] = [];
  readonly fog: [FogField, FogField];
  /**
   * Where each standing aura is this tick: raised colours, beating drums,
   * loosed hounds, a wagon ring. Rebuilt from group state after specials are
   * decided, so it is derived, never hashed, and EMPTY in any battle that has
   * none of the second roster in it -- which is what keeps every older
   * recording and golden reproducing bit for bit.
   */
  private auras: { kind: SpecialId; player: number; x: number; y: number }[] = [];
  readonly reinforcements: readonly Reinforcement[];
  /**
   * Each living soldier's formation steadiness this tick: his group's cohesion,
   * or zero if he stands alone.
   *
   * A scratch array rather than a lookup, because the damage path is the
   * hottest loop in the tick and groupById is a linear scan over every group.
   * Filled once per tick in updateSoldiers, which already computes cohesion and
   * already runs before combat resolves.
   */
  private readonly steadiness: Float64Array;
  /**
   * Casualties by cause, per player: [melee, shot, flanked].
   *
   * DELIBERATELY NOT HASHED, unlike almost everything else here. It is a report
   * derived from state that is already hashed, and it never feeds a decision --
   * nothing reads it back into the simulation. Hashing it would add golden
   * churn for a number that cannot cause a desync on its own.
   */
  readonly casualtiesByCause: [number[], number[]] = [[0, 0, 0], [0, 0, 0]];
  /** Companies that broke, in the order they broke, for the after-action. */
  readonly breakages: { name: string; player: number; tick: number; cause: string; group: number }[] = [];

  readonly rng: {
    readonly combat: Rng;
    readonly morale: Rng;
    readonly ai: Rng;
    readonly spawn: Rng;
    readonly magic: Rng;
  };

  /** Soldiers deployed by each army, kept so morale can hold the dead on the books. */
  readonly roster: [number, number] = [0, 0];
  readonly victory: VictoryConfig;
  readonly controlPoints: readonly ControlPoint[];
  /** Which player holds each point, by index. -1 for contested or empty. */
  readonly heldBy: Int8Array;
  /** Cumulative seconds each side has spent holding enough ground. */
  readonly holdSeconds: [number, number] = [0, 0];
  /** Night's grip on sight, 1 by day. */
  readonly sightScale: number;
  /** Tick the river rises, or -1 for a battlefield with no flood. */
  readonly floodAt: number;
  /** Has it risen yet? */
  flooded = false;
  /** The siege works this field was laid out with, or null. */
  readonly siege: SiegeWorks | null;
  /** terrain.sightAt as of the last perception sweep. */
  private sightSwept = 0;
  /** Breakthrough: each side's living men in the exit ground this tick. */
  readonly through: [number, number] = [0, 0];
  /**
   * The standard mode's bearers, chosen from the deployed armies on the first
   * tick. Only ever filled in that mode, so nothing else hashes or depends on it.
   */
  private standardBearers: [number[], number[]] | null = null;
  readonly points: [number, number] = [0, 0];

  private readonly hash: SpatialHash;
  /**
   * A coarser hash used only for sight.
   *
   * The combat hash has 14-unit cells sized for jostling; a scout's 900-unit
   * perception swept across that grid would touch thousands of cells. Vision
   * gets its own grid at a scale that suits it.
   */
  private readonly sightHash: SpatialHash;
  private readonly neighbours: Int32Array;
  private readonly watchers: Int32Array;
  private nextId = 1;
  /** Cached stats per soldier, resolved once at spawn. */
  private readonly statsOf: Stats[] = [];

  constructor(config: WorldConfig) {
    this.seed = config.seed | 0;
    this.duration = config.duration ?? 15 * 60;
    this.victory = config.victory ?? DEFAULT_VICTORY;
    this.controlPoints = config.controlPoints ?? [];
    this.heldBy = new Int8Array(this.controlPoints.length).fill(-1);
    this.terrain = generateTerrain(config.tilesWide, config.tilesHigh, this.seed);
    this.siege = config.siege ?? null;
    if (this.siege) {
      raiseSiegeWorks(this.terrain, this.siege);
      // Laid out before anyone stands here: there is nothing to settle.
      this.terrain.drainChanges();
    }
    const capacity = config.soldierCapacity ?? 1024;
    this.soldiers = new Soldiers(capacity);
    this.hash = new SpatialHash(
      this.terrain.worldWidth, this.terrain.worldHeight, SEPARATION_RADIUS * 2, capacity,
    );
    this.sightHash = new SpatialHash(
      this.terrain.worldWidth, this.terrain.worldHeight, SIGHT_CELL, capacity,
    );
    this.neighbours = new Int32Array(256);
    this.watchers = new Int32Array(capacity);
    this.fog = [new FogField(this.terrain), new FogField(this.terrain)];
    this.reinforcements = config.reinforcements ?? [];
    this.sightScale = config.sightScale ?? 1;
    this.floodAt = config.floodAtSeconds === undefined ? -1 : round(config.floodAtSeconds * TICK_RATE);
    this.steadiness = new Float64Array(this.soldiers.capacity);
    this.rng = {
      combat: Rng.create(this.seed, Stream.Combat),
      morale: Rng.create(this.seed, Stream.Morale),
      ai: Rng.create(this.seed, Stream.Ai),
      spawn: Rng.create(this.seed, Stream.Spawn),
      magic: Rng.create(this.seed, Stream.Magic),
    };
    for (const p of config.aiPlayers ?? []) {
      this.ai.push(new ArmyAI(p, config.aiTuning, config.commander));
    }
  }

  // -- soldiers ---------------------------------------------------------------

  /**
   * Place one soldier. This is the only way anything enters the world.
   *
   * Note what it does NOT do: it creates no squad, no formation and no command
   * structure. A soldier stands where it is put, alone, until the player draws
   * a group around it.
   */
  /**
   * Set one soldier down. `nerve` (0..1] is the morale he starts with: 1, a
   * fresh man, for every battle until K5; a kingdom army brings its own
   * (content/kingdom/descent.ts nerveFromMorale). The default leaves every
   * earlier battle exactly as it was.
   */
  spawnSoldier(player: number, type: UnitTypeId, x: number, y: number, facing: number, nerve = 1): number {
    const s = this.soldiers;
    if (s.count >= s.capacity) {
      // Writing past a Float64Array is a silent no-op rather than a throw, so an
      // over-large army would quietly produce soldiers stacked at (0, 0).
      throw new Error("soldier capacity exceeded: " + s.capacity + " (raise soldierCapacity)");
    }
    const id = s.count++;
    const stats = statsFor(type, this.doctrine[player]);
    this.statsOf[id] = stats;
    s.x[id] = x;
    s.y[id] = y;
    s.facing[id] = facing;
    s.hp[id] = stats.hp;
    s.maxHp[id] = stats.hp;
    s.morale[id] = nerve;
    s.cooldown[id] = 0;
    s.incoming[id] = 0;
    s.struckBy[id] = -1;
    s.ammo[id] = UNIT_TYPES[type].volleys ?? 0;
    s.player[id] = player;
    s.type[id] = typeIndex(type);
    s.alive[id] = 1;
    s.group[id] = -1;
    s.slot[id] = -1;
    this.roster[player]++;
    return id;
  }

  stats(id: number): Stats {
    return this.statsOf[id];
  }

  typeOf(id: number): UnitTypeId {
    return typeAt(this.soldiers.type[id]);
  }

  // -- groups -----------------------------------------------------------------

  /**
   * Form a group from a set of soldiers.
   *
   * A soldier belongs to at most one group, so joining a new one leaves the old.
   * Members are sorted by id: two peers replaying the same orders must build the
   * same group, and the order the player happened to lasso them in is not
   * something either peer can know.
   */
  createGroup(player: number, ids: readonly number[]): Group | null {
    const s = this.soldiers;
    const members = ids
      .filter((id) => id >= 0 && id < s.count && s.alive[id] === 1 && s.player[id] === player)
      .sort((a, b) => a - b);
    if (members.length === 0) return null;

    for (const id of members) this.leaveGroup(id);

    const id = this.nextId++;
    const g: Group = {
      id,
      player,
      name: companyName(id, this.dominantType(members)),
      members,
      anchorX: 0,
      anchorY: 0,
      facing: 0,
      // Square by default, whatever the men are. A group the player has just
      // drawn around a mixed handful has no obvious frontage, and a square is
      // the shape that reads as "a body of troops" at any size and in any
      // direction. A specific shape is a decision the player makes with a glyph.
      shape: "square",
      slots: new Float64Array(members.length * 2),
      radius: 0,
      path: [],
      pathRevision: this.terrain.revision,
      routeShort: false,
      goalX: 0,
      goalY: 0,
      stance: "idle",
      target: -1,
      holdX: 0,
      holdY: 0,
      holdRadius: 0,
      patrol: [],
      patrolLeg: 0,
      patrolForward: true,
      recoverUntil: 0,
      chargeUntil: 0,
      hasteUntil: 0,
      specialUntil: 0,
      specialReadyAt: 0,
      specialUses: 0,
      blinked: false,
      bowsBroken: false,
      buildTicks: 0,
      feintTurn: 0,
      feintHomeX: 0,
      feintHomeY: 0,
      spellReady: 0,
      cohesion: 1,
      engaged: 0,
      kills: 0,
      losses: 0,
      flankLosses: 0,
      brokeAt: -1,
      destroyedAt: -1,
      raisedWith: members.length,
      casualtiesThisTick: 0,
      flankCasualtiesThisTick: 0,
      killsThisTick: 0,
      lastContact: -9999,
      flanked: false,
      seenBy: [player === 0, player === 1],
    };
    for (const id of members) s.group[id] = g.id;
    this.groups.push(g);
    this.raised.push(g);
    this.recentre(g);
    this.reflow(g);
    return g;
  }

  /**
   * What a company is mostly made of, for naming it.
   *
   * Ties break toward the earlier type in UNIT_TYPE_IDS rather than by count
   * alone, so the same men always produce the same answer.
   */
  private dominantType(members: readonly number[]): UnitTypeId {
    const tally = new Map<UnitTypeId, number>();
    let best: UnitTypeId = "line";
    let bestN = -1;
    for (const m of members) {
      const t = this.typeOf(m);
      const n = (tally.get(t) ?? 0) + 1;
      tally.set(t, n);
      if (n > bestN) {
        bestN = n;
        best = t;
      }
    }
    return best;
  }

  groupById(id: number): Group | undefined {
    for (const g of this.groups) if (g.id === id) return g;
    return undefined;
  }

  /** Remove one soldier from whatever group holds it, disbanding if it empties. */
  leaveGroup(id: number): void {
    const gid = this.soldiers.group[id];
    if (gid < 0) return;
    const g = this.groupById(gid);
    this.soldiers.group[id] = -1;
    this.soldiers.slot[id] = -1;
    if (!g) return;
    const at = g.members.indexOf(id);
    if (at >= 0) g.members.splice(at, 1);
    if (g.members.length === 0) this.disband(g.id);
    else this.reflow(g);
  }

  disband(id: number): void {
    const at = this.groups.findIndex((g) => g.id === id);
    if (at < 0) return;
    const dying = this.groups[at];
    // Only a company that ran out of men was destroyed. Disbanding also happens
    // when the player reorganises, and that is not a casualty report.
    if (dying.destroyedAt < 0 && dying.losses >= dying.raisedWith) {
      dying.destroyedAt = this.tick;
      this.breakages.push({
        name: dying.name, player: dying.player, tick: this.tick, cause: "wiped out", group: dying.id,
      });
    }
    for (const m of this.groups[at].members) {
      this.soldiers.group[m] = -1;
      this.soldiers.slot[m] = -1;
    }
    this.groups.splice(at, 1);
    // Told to the presentation layer so it can drop anything this company left
    // hanging in the air. Cleared with the other per-tick event lists.
    this.disbanded.push(dying.id);
    // Workings this company was sustaining stop the instant it is gone. A
    // healing circle tended by nobody is a circle tended by nobody.
    for (let i = this.workings.length - 1; i >= 0; i--) {
      if (this.workings[i].group === dying.id) this.workings.splice(i, 1);
    }
  }

  /**
   * Re-form a group immediately, outside the order queue.
   *
   * Needed during deployment, where the world is deliberately not ticking:
   * orders queue but never drain, so a formation issued while setting out would
   * sit unapplied and then all fire at once the instant the battle began.
   * Dressing your ranks before the off is arranging the board, not commanding
   * in the field, so it applies directly.
   */
  setFormation(groupId: number, shape: FormationShape): boolean {
    const g = this.groupById(groupId);
    if (!g) return false;
    g.shape = shape;
    this.reflow(g);
    return true;
  }

  /** Living members of a group. */
  liveCount(g: Group): number {
    let n = 0;
    for (const m of g.members) if (this.soldiers.alive[m] === 1) n++;
    return n;
  }

  /** Move the anchor onto the members' centre of mass. */
  private recentre(g: Group): void {
    const s = this.soldiers;
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const m of g.members) {
      if (s.alive[m] !== 1) continue;
      cx += s.x[m];
      cy += s.y[m];
      n++;
    }
    if (n === 0) return;
    g.anchorX = cx / n;
    g.anchorY = cy / n;
  }

  /** Rebuild the formation for the members currently standing. */
  private reflow(g: Group): void {
    const s = this.soldiers;
    const living = g.members.filter((m) => s.alive[m] === 1);
    if (living.length === 0) return;
    if (g.slots.length < living.length * 2) g.slots = new Float64Array(living.length * 2);
    formationSlots(g.shape, living.length, g.slots);
    g.radius = formationRadius(g.slots, living.length);

    // Ranks are filled front to back, and the front belongs to whoever fights
    // hand to hand. Archers and engines shooting over their own front rank is
    // the whole point of having one; leaving placement to proximity alone
    // scatters bowmen through the melee, where they are useless and die first.
    const order: number[] = [];
    for (let i = 0; i < living.length; i++) order.push(i);
    order.sort((a, b) => {
      const ra = this.stats(living[a]).range > MELEE_RANGE ? 1 : 0;
      const rb = this.stats(living[b]).range > MELEE_RANGE ? 1 : 0;
      if (ra !== rb) return ra - rb;
      return living[a] - living[b];
    });
    // Slots front-first: +x is forward, so descending dx walks the ranks back.
    const bySlot: number[] = [];
    for (let i = 0; i < living.length; i++) bySlot.push(i);
    bySlot.sort((a, b) => g.slots[b * 2] - g.slots[a * 2] || a - b);

    // Within a rank, still pick the nearest man so a re-form does not drag
    // everyone across the formation through itself.
    const taken = new Uint8Array(living.length);
    let cursor = 0;
    for (const slot of bySlot) {
      const c = cos(g.facing);
      const sn = sin(g.facing);
      const wx = g.anchorX + g.slots[slot * 2] * c - g.slots[slot * 2 + 1] * sn;
      const wy = g.anchorY + g.slots[slot * 2] * sn + g.slots[slot * 2 + 1] * c;
      // Candidates are the next few in role order, so role wins over distance
      // but men do not cross the whole line to reach an equivalent spot.
      let best = -1;
      let bestD = Infinity;
      for (let k = cursor; k < min(cursor + 6, order.length); k++) {
        const i = order[k];
        if (taken[i] === 1) continue;
        const d = dist(s.x[living[i]], s.y[living[i]], wx, wy);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      // The window can be entirely spoken for. Falling through here would
      // leave the slot empty AND the man slotless, which reads as a formation
      // that never finishes forming up -- so widen the search rather than skip.
      if (best < 0) {
        for (let k = 0; k < order.length; k++) {
          const i = order[k];
          if (taken[i] === 1) continue;
          const d = dist(s.x[living[i]], s.y[living[i]], wx, wy);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
      if (best < 0) continue;
      taken[best] = 1;
      s.slot[living[best]] = slot;
      while (cursor < order.length && taken[order[cursor]] === 1) cursor++;
    }
  }

  // -- army-level readings -----------------------------------------------------

  /**
   * Army morale, over the DEPLOYED roster rather than the survivors.
   *
   * Averaging the living only would mean a soldier's nerve vanishes from the
   * reckoning the instant he dies, so an army could be ground down to three
   * steady men and read as fully composed. The dead count as zero and stay on
   * the books.
   */
  armyMorale(player: number): number {
    const s = this.soldiers;
    const m: number[] = [];
    const w: number[] = [];
    for (let i = 0; i < s.count; i++) {
      if (s.player[i] !== player) continue;
      m.push(s.alive[i] === 1 ? s.morale[i] : 0);
      w.push(1);
    }
    return globalMorale(m, w);
  }

  armyState(player: number): ArmyState {
    const s = this.soldiers;
    let strength = 0;
    for (let i = 0; i < s.count; i++) if (s.player[i] === player && s.alive[i] === 1) strength++;
    return { morale: this.armyMorale(player), strength, roster: this.roster[player] };
  }

  /** Enemy groups a player can currently see. */
  visibleEnemies(player: number): Group[] {
    return this.groups.filter(
      (g) => g.player !== player && this.liveCount(g) > 0 && g.seenBy[player],
    );
  }

  /** Every living soldier of one army, grouped or not. */
  soldiersOf(player: number): number[] {
    const out: number[] = [];
    const s = this.soldiers;
    for (let i = 0; i < s.count; i++) if (s.player[i] === player && s.alive[i] === 1) out.push(i);
    return out;
  }

  // -- the tick ----------------------------------------------------------------

  step(): void {
    if (this.outcome) return;
    if (this.deploying) {
      // The board is being set out and the clock does not run, but the setup
      // orders -- placing a company, dressing its ranks -- still land here, at
      // a tick boundary, and nowhere else (audit PC-05).
      this.applySetupOrders();
      return;
    }
    if (this.tick === this.floodAt) this.raiseFlood();
    // Anything that changed the ground between ticks (a flood above, or a
    // tool poking the terrain) is settled before anyone moves over it.
    this.settleTerrain();
    this.landReinforcements();
    for (const ai of this.ai) ai.update(this);
    this.applyOrders();
    this.updateFeints();
    this.updateGroups();
    this.rebuildHash();
    this.updateSoldiers();
    this.updateVision();
    // Cleared before ANYTHING writes damage for this tick. A fireball is
    // buffered by castSpells, and clearing after that wiped it -- the same
    // mistake the barrage made, one step further up the tick.
    this.clearDamageBuffer();
    // Cleared here, at the top of the tick, rather than inside resolveCombat --
    // which runs AFTER updateSpecials and so wiped every flash before a frame
    // could ever draw it.
    this.specialEvents.length = 0;
    this.disbanded.length = 0;
    this.castSpells();
    this.updateAmbushes();
    this.updateSpecials();
    this.applyFields();
    this.updateFire();
    this.resolveCombat();
    this.applyWorkings();
    this.updateEngineering();
    // Whatever fell this tick -- to engines, sappers, a barrage or fire -- is
    // settled before the tick ends, so no man ends a tick on ground that has
    // just become water.
    this.settleTerrain();
    this.updateMorale();
    this.updateObjectives();
    this.tick++;
    this.outcome = evaluate(this.victory, {
      armies: [this.armyState(0), this.armyState(1)],
      elapsed: this.tick / TICK_RATE,
      duration: this.duration,
      holdSeconds: this.holdSeconds,
      points: this.points,
      through: this.through,
      standards: this.victory.mode === "standard" ? this.standardsFlying() : undefined,
    });
  }

  /**
   * Turn a feint around.
   *
   * The deception is not a trick played on the AI -- it reacts to what it
   * genuinely sees, and what it sees is a real advance. The feint is simply an
   * advance with a withdrawal already scheduled, which is what makes it cost
   * something if the enemy calls it.
   */
  private updateFeints(): void {
    for (const g of this.groups) {
      if (g.feintTurn === 0 || this.tick < g.feintTurn) continue;
      g.feintTurn = 0;
      if (g.recoverUntil > this.tick) continue;
      g.stance = "retreat";
      g.target = -1;
      g.path = this.routeThrough(g, [g.feintHomeX, g.feintHomeY]);
    }
  }

  /**
   * March on anyone due this tick.
   *
   * Compared against the exact tick rather than "at or past it", so a wave
   * arrives once and only once however the match is stepped.
   */
  private landReinforcements(): void {
    for (const r of this.reinforcements) {
      if (this.tick !== round(r.atSeconds * TICK_RATE)) continue;
      const ids: number[] = [];
      for (let i = 0; i < r.count; i++) {
        // Set down on standing ground: a level's arrival point can sit beside
        // a wall or a river, and a man must never begin inside either.
        const at = this.standingGround(r.x + (i % 5) * 14, r.y + ((i / 5) | 0) * 14);
        ids.push(this.spawnSoldier(r.player, r.type, at.x, at.y, r.player === 0 ? 0 : PI));
      }
      // Arriving as a formed company, not as a crowd -- these are troops
      // marching on, and a player has no chance to draw a loop round them.
      if (ids.length > 0) this.createGroup(r.player, ids);
    }
  }

  private applyOrders(): void {
    for (const order of this.orders.drain(this.tick)) this.applyOrder(order);
  }

  /**
   * Apply the setup orders due now while deploying. Other orders stay queued
   * for the battle, exactly as before setup orders existed (the commander
   * refuses to issue them while deploying, so the player banks nothing; this
   * only keeps a peer's or a test's tick-0 order from vanishing).
   */
  private applySetupOrders(): void {
    for (const order of this.orders.drainKinds(this.tick, SETUP_ORDER_KINDS)) {
      if (order.kind === "place") this.applyPlace(order.player, order.squad, order.x, order.y);
      else if (order.kind === "formation") this.applyOrder(order);
    }
  }

  /**
   * Set a company down with its centre on (x, y). Refused whole -- nobody
   * moves -- if any man would land off the map or on ground nobody can stand
   * on, so a company is never dropped half into a river (audit FL-01).
   */
  private applyPlace(player: number, squad: number, x: number, y: number): void {
    const g = this.groupById(squad);
    if (!g || g.player !== player) return;
    const s = this.soldiers;
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const m of g.members) {
      if (s.alive[m] !== 1) continue;
      cx += s.x[m];
      cy += s.y[m];
      n++;
    }
    if (n === 0) return;
    const dx = x - cx / n;
    const dy = y - cy / n;
    for (const m of g.members) {
      if (s.alive[m] !== 1) continue;
      const nx = s.x[m] + dx;
      const ny = s.y[m] + dy;
      if (nx < 0 || ny < 0 || nx >= this.terrain.worldWidth || ny >= this.terrain.worldHeight) return;
      if (!this.terrain.passableAt(floor(nx / TILE_SIZE), floor(ny / TILE_SIZE))) return;
    }
    for (const m of g.members) {
      if (s.alive[m] !== 1) continue;
      s.x[m] += dx;
      s.y[m] += dy;
    }
    // The anchor goes with them, or the men would walk back to where they were
    // picked up from the moment the battle began.
    g.anchorX += dx;
    g.anchorY += dy;
  }

  private applyOrder(order: Order): void {
    if (order.kind === "ability") {
      this.applyAbility(order.player, order.ability, order.x, order.y, order.squad);
      return;
    }
    if (order.kind === "gates") {
      this.applyGates(order.player, order.open);
      return;
    }
    const g = this.groupById(order.squad);
    if (!g) return;
    // A recovering group has stood down and is not taking orders. Enforced in
    // the simulation, not the UI, so it binds the AI and replayed logs equally.
    if (g.recoverUntil > this.tick) return;
    switch (order.kind) {
      case "move":
        g.stance = "move";
        g.target = -1;
        g.path = this.routeThrough(g, order.path);
        return;
      case "attack":
        g.stance = "attack";
        g.target = order.target;
        g.path = this.routeThrough(g, order.path);
        return;
      case "retreat":
        g.stance = "retreat";
        g.target = -1;
        g.path = this.routeThrough(g, order.path);
        return;
      case "hold":
        g.stance = "hold";
        g.target = -1;
        g.holdX = order.x;
        g.holdY = order.y;
        g.holdRadius = order.radius;
        g.path = this.routeThrough(g, [order.x, order.y]);
        return;
      case "patrol":
        g.stance = "patrol";
        g.target = -1;
        g.patrol = order.path.slice();
        g.patrolLeg = 0;
        g.patrolForward = true;
        g.path = this.legRoute(g);
        return;
      case "formation":
        g.shape = order.shape;
        this.reflow(g);
        return;
      case "ambush":
        g.stance = "ambush";
        g.target = -1;
        g.path.length = 0;
        return;
      case "feint": {
        // Remember where it started: a feint is an advance that goes back, and
        // "back" has to mean the ground it actually left.
        g.feintHomeX = g.anchorX;
        g.feintHomeY = g.anchorY;
        g.feintTurn = this.tick + FEINT_ADVANCE_SECONDS * TICK_RATE;
        g.stance = "move";
        g.target = -1;
        g.path = this.routeThrough(g, order.path);
        return;
      }
      case "place":
        // A setup order that arrived after the battle began. Picking men up
        // and putting them down mid-battle would be teleporting.
        return;
      case "recover":
        g.stance = "recover";
        g.target = -1;
        g.path.length = 0;
        g.recoverUntil = this.tick + RECOVER_LOCK_SECONDS * TICK_RATE;
        return;
    }
  }

  /**
   * K10: the garrison swings its gates (docs/PROVISIONAL.md K10.1). Only the
   * side holding the walls; a gate already broken is rubble and does not
   * swing. Opening is always allowed -- a sally port is a decision, not a
   * risk the sim refuses. Shutting is refused, gate by gate, while ANYONE
   * stands in the gateway, friend or foe: a gate is never closed on men,
   * so nobody is ever settled out of a closing gate and the "nobody inside a
   * wall" invariant holds without an eviction. Gates are taken in the
   * record's order, tiles ascending, so two peers swing the same tiles.
   */
  private applyGates(player: number, open: boolean): void {
    const w = this.siege;
    if (!w || w.defender !== player) return;
    const t = this.terrain;
    const occupied = open ? null : this.occupiedTiles();
    for (let k = 0; k < w.gates.length; k++) {
      const tiles = gateTiles(t, w, k);
      if (occupied && tiles.some((i) => occupied.has(i))) continue;
      for (const i of tiles) t.swingGate(i % t.width, (i / t.width) | 0, open);
    }
  }

  /** Every tile a living soldier or a company's anchor stands on (tile indices). */
  private occupiedTiles(): Set<number> {
    const t = this.terrain;
    const occupied = new Set<number>();
    const s = this.soldiers;
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] !== 1) continue;
      occupied.add(floor(s.y[i] / TILE_SIZE) * t.width + floor(s.x[i] / TILE_SIZE));
    }
    for (const g of this.groups) occupied.add(floor(g.anchorY / TILE_SIZE) * t.width + floor(g.anchorX / TILE_SIZE));
    return occupied;
  }

  /**
   * K10: is an open gate of this player's held open by men standing in it
   * right now (so a `gates` shut order would leave it open)? For the HUD's
   * answer to the key (audit K10-04); reads the world, changes nothing.
   */
  gateHeldOpen(player: number): boolean {
    const w = this.siege;
    if (!w || w.defender !== player) return false;
    const t = this.terrain;
    const occupied = this.occupiedTiles();
    for (let k = 0; k < w.gates.length; k++) {
      const tiles = gateTiles(t, w, k);
      if (tiles.some((i) => t.type[i] === Terrain.GateOpen) && tiles.some((i) => occupied.has(i))) return true;
    }
    return false;
  }

  /** K10: does this player hold walls with a gate standing open? (The HUD's button reads it.) */
  gatesOpen(player: number): boolean {
    const w = this.siege;
    if (!w || w.defender !== player) return false;
    for (let k = 0; k < w.gates.length; k++) {
      for (const i of gateTiles(this.terrain, w, k)) if (this.terrain.type[i] === Terrain.GateOpen) return true;
    }
    return false;
  }

  /** K10: does this player hold walls with a gate still standing (shut or open)? */
  hasGates(player: number): boolean {
    const w = this.siege;
    if (!w || w.defender !== player) return false;
    for (let k = 0; k < w.gates.length; k++) {
      for (const i of gateTiles(this.terrain, w, k)) {
        const ty = this.terrain.type[i];
        if (ty === Terrain.Gate || ty === Terrain.GateOpen) return true;
      }
    }
    return false;
  }

  /**
   * K10: how badly this field's siege works are battered, per mille (0 with
   * none). The kingdom takes it back as the holding's wall damage.
   */
  wallDamage(): number {
    return this.siege ? siegeDamage(this.terrain, this.siege) : 0;
  }

  /**
   * Turn a drawn route into a walkable one. The player draws intent, not a
   * traversable path -- a stroke crosses rivers freely -- so every leg is
   * re-routed by A* and the results concatenated.
   */
  private routeThrough(g: Group, waypoints: readonly number[]): number[] {
    g.pathRevision = this.terrain.revision;
    g.routeShort = false;
    if (waypoints.length < 2) return [];
    const out: number[] = [];
    let cx = g.anchorX;
    let cy = g.anchorY;
    for (let i = 0; i + 1 < waypoints.length; i += 2) {
      const leg = findPathPartial(this.terrain, cx, cy, waypoints[i], waypoints[i + 1]);
      if (!leg.reached) {
        // The way is shut. Go as near as the ground allows and remember where
        // the order was for, so a breach can finish what the order began.
        g.routeShort = true;
        g.goalX = waypoints[waypoints.length - 2];
        g.goalY = waypoints[waypoints.length - 1];
        for (const v of leg.route) out.push(v);
        break;
      }
      for (const v of leg.route) out.push(v);
      cx = leg.route[leg.route.length - 2];
      cy = leg.route[leg.route.length - 1];
    }
    // Round the joints off before anyone walks it, so a group sweeps through a
    // turn instead of pivoting on the spot at every waypoint.
    return smoothRoute(this.terrain, out);
  }

  private legRoute(g: Group): number[] {
    const n = g.patrol.length / 2;
    if (n < 2) return [];
    const i = g.patrolLeg < 0 ? 0 : g.patrolLeg >= n ? n - 1 : g.patrolLeg;
    return this.routeThrough(g, [g.patrol[i * 2], g.patrol[i * 2 + 1]]);
  }

  // -- layer 1: group anchors walk their routes --------------------------------

  private updateGroups(): void {
    this.revalidateRoutes();
    for (let i = this.groups.length - 1; i >= 0; i--) {
      const g = this.groups[i];
      if (this.liveCount(g) === 0) {
        this.disband(g.id);
        continue;
      }
      if (g.stance === "recover") {
        this.recover(g);
        continue;
      }
      if (g.stance === "idle") continue;

      if (g.path.length < 2) {
        if (g.stance === "patrol") {
          this.advancePatrolLeg(g);
          g.path = this.legRoute(g);
        } else if (g.stance === "retreat" || (g.stance === "move" && !g.routeShort)) {
          // A march whose road was shut is not over: the company waits at the
          // wall under its order until a breach lets it through.
          g.stance = "idle";
        }
        if (g.path.length < 2) continue;
      }

      // In contact, and not withdrawing: stand and finish it. The order is not
      // forgotten -- the route is kept and resumed once the fight is over.
      const living = this.liveCount(g);
      const holding =
        g.stance !== "retreat" &&
        living > 0 &&
        g.engaged / living >= ENGAGE_HALT_FRACTION;
      if (holding) continue;

      const speed = this.groupSpeed(g);
      if (speed <= 0) {
        g.path.length = 0;
        continue;
      }
      const desired = atan2(g.path[1] - g.anchorY, g.path[0] - g.anchorX);
      g.facing = rotateToward(g.facing, desired, this.groupTurnRate(g) * TICK_DT);

      let budget = speed * TICK_DT;
      let replanned = false;
      while (budget > 1e-9 && g.path.length >= 2) {
        const r = advanceToward(this.terrain, g.anchorX, g.anchorY, g.path[0], g.path[1], budget);
        g.anchorX = r.x;
        g.anchorY = r.y;
        budget -= r.travelled;
        if (r.blocked) {
          // The leg grazes something the planner's samples missed: a cliff's
          // corner, or the end of a wall. Once a tick, re-plan just this leg
          // to the letter from where the anchor stands (findPathStrict) and
          // walk on; only if even that finds no way is the route given up.
          // Dropping it outright froze companies against the rock for good,
          // which a siege, all corners and gateways, made common.
          if (!replanned) {
            replanned = true;
            const leg = findPathStrict(this.terrain, g.anchorX, g.anchorY, g.path[0], g.path[1]);
            if (leg.reached && leg.route.length >= 2) {
              g.path.splice(0, 2, ...leg.route);
              continue;
            }
          }
          g.path.length = 0;
          break;
        }
        if (!r.reached) break;
        g.path.splice(0, 2);
        if (r.travelled <= 1e-9 && g.path.length >= 2) break;
      }
      g.facing = ((g.facing % TAU) + TAU) % TAU;
    }
  }

  /**
   * Re-route anyone whose road changed under them. Checked only when the
   * terrain revision moves -- terrain changes a handful of times a match, not a
   * handful of times a tick, so this stays off the hot path.
   */
  private revalidateRoutes(): void {
    const rev = this.terrain.revision;
    for (const g of this.groups) {
      if (g.pathRevision === rev) continue;
      const since = g.pathRevision;
      g.pathRevision = rev;
      // A BREACH: something impassable has opened since this route was
      // planned, and this company's road had been shut. Re-plan to where it
      // was ordered. Only companies whose route fell short are affected -- a
      // breach can shorten anyone's walk, but re-planning a drawn route the
      // player chose would throw away their waypoints for a few seconds saved.
      if (g.routeShort && this.terrain.openedAt > since) {
        if (g.stance === "patrol") g.path = this.legRoute(g);
        else if (g.stance === "move" || g.stance === "attack" || g.stance === "hold" || g.stance === "retreat") {
          g.path = this.routeThrough(g, [g.goalX, g.goalY]);
        }
        continue;
      }
      // Only a CLOSURE can cut a route; anything else leaves every route as
      // walkable as it was.
      if (this.terrain.closedAt <= since) continue;
      if (g.path.length < 2) continue;
      let ok = clearLine(this.terrain, g.anchorX, g.anchorY, g.path[0], g.path[1]);
      for (let i = 0; ok && i + 3 < g.path.length; i += 2) {
        ok = clearLine(this.terrain, g.path[i], g.path[i + 1], g.path[i + 2], g.path[i + 3]);
      }
      if (ok) continue;
      const gx = g.routeShort ? g.goalX : g.path[g.path.length - 2];
      const gy = g.routeShort ? g.goalY : g.path[g.path.length - 1];
      g.path = this.routeThrough(g, [gx, gy]);
    }
  }

  private advancePatrolLeg(g: Group): void {
    const n = g.patrol.length / 2;
    if (n < 2) return;
    const closed =
      dist(g.patrol[0], g.patrol[1], g.patrol[(n - 1) * 2], g.patrol[(n - 1) * 2 + 1]) < 90;
    if (g.patrolForward) {
      g.patrolLeg++;
      if (g.patrolLeg >= n) {
        if (closed) g.patrolLeg = 0;
        else {
          g.patrolForward = false;
          g.patrolLeg = n - 2;
        }
      }
    } else {
      g.patrolLeg--;
      if (g.patrolLeg < 0) {
        g.patrolForward = true;
        g.patrolLeg = 1;
      }
    }
  }

  /**
   * A group moves at the pace of its slowest member.
   *
   * Averaging would let a player hide a siege engine inside a cavalry group and
   * have it keep up. Mixing arms should feel like a decision with a cost.
   */
  /**
   * A group moves at the pace of its worst-off man -- his own speed AND the
   * ground he is standing on.
   *
   * Reading terrain under the anchor alone was fine when the map was mostly
   * plain, and wrong the moment it was not: with roads at 1.3x and marsh at
   * 0.45x, an anchor on the highway would set a pace nobody in the bog could
   * hold, and the formation tore itself apart crossing ordinary ground.
   */
  private groupSpeed(g: Group): number {
    const s = this.soldiers;
    let slowest = Infinity;
    let morale = 0;
    let n = 0;
    for (const m of g.members) {
      if (s.alive[m] !== 1) continue;
      const ground = TERRAIN_INFO[this.terrain.typeAtWorld(s.x[m], s.y[m])];
      // Impassable ground scales to zero, which is right for entering it and
      // disastrous for standing in it. Wading out is slow, not impossible.
      const scale = ground.moveScale > 0 ? ground.moveScale : STRANDED_WADE;
      slowest = min(slowest, this.stats(m).speed * scale);
      morale += s.morale[m];
      n++;
    }
    if (n === 0) return 0;
    // At the charge: faster, and with the ranks allowed to open up, which is
    // what the extra impact is bought with.
    if (this.hasSpecial(g, "fortify")) return 0;
    // Behind a pavise or chained in a ring, nothing goes anywhere.
    if (this.hasSpecial(g, "pavise") || this.hasSpecial(g, "laager")) return 0;
    const drums = this.auras.length > 0 &&
      this.auraAt("cadence", g.player, g.anchorX, g.anchorY, CADENCE_RADIUS, false)
      ? CADENCE_HASTE : 1;
    const haste = (g.hasteUntil > this.tick ? CHARGE_HASTE : 1) *
      (this.hasSpecial(g, "dash") ? DASH_HASTE : 1);
    // Mired ground is the one working that touches movement rather than
    // damage or nerve: it does no harm at all, it simply refuses to be crossed.
    const spikes = this.fields.length > 0 &&
      this.fieldAt("caltrops", g.player, g.anchorX, g.anchorY, true) ? CALTROP_SCALE : 1;
    return slowest * FORMATION_PACE * haste * drums * spikes * this.mireScale(g) *
      moraleSpeedScale(morale / n);
  }

  private groupTurnRate(g: Group): number {
    const s = this.soldiers;
    let slowestTurn = Infinity;
    let slowestSpeed = Infinity;
    for (const m of g.members) {
      if (s.alive[m] !== 1) continue;
      slowestTurn = min(slowestTurn, this.stats(m).turnRate);
      slowestSpeed = min(slowestSpeed, this.stats(m).speed);
    }
    if (slowestTurn === Infinity) return 1;
    // Leave headroom so wheeling does not consume every last step of pace.
    const bySize = (slowestSpeed * 0.55) / max(g.radius, 8);
    return min(slowestTurn, bySize);
  }

  private recover(g: Group): void {
    if (this.tick >= g.recoverUntil) {
      g.stance = "idle";
      g.recoverUntil = 0;
      return;
    }
    const s = this.soldiers;
    for (const m of g.members) {
      if (s.alive[m] !== 1) continue;
      s.morale[m] = min(1, s.morale[m] + RECOVER_MORALE_PER_SEC * TICK_DT);
      const heal = s.maxHp[m] * RECOVER_HP_FRACTION_PER_SEC * TICK_DT;
      if (s.hp[m] < s.maxHp[m]) s.hp[m] = min(s.maxHp[m], s.hp[m] + heal);
      // Standing down is also how a company replenishes its quivers, which
      // gives the order a second reason to exist and gives an emptied line of
      // archers something to do other than die.
      const full = UNIT_TYPES[this.typeOf(m)].volleys ?? 0;
      if (s.ammo[m] < full) {
        s.ammo[m] = min(full, s.ammo[m] + full * RESUPPLY_FRACTION_PER_SEC * TICK_DT);
      }
    }
  }

  private rebuildHash(): void {
    const s = this.soldiers;
    this.hash.ensureCapacity(s.count);
    this.hash.clear();
    this.sightHash.ensureCapacity(s.count);
    this.sightHash.clear();
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] !== 1) continue;
      this.hash.insert(i, s.x[i], s.y[i]);
      // The coarse grid is rebuilt every tick even though perception only
      // sweeps every few: engagement targeting reads it too, and a stale
      // position is tolerable for fog but not for deciding who to charge.
      this.sightHash.insert(i, s.x[i], s.y[i]);
    }
  }

  // -- layers 2 and 3: slot projection, then per-soldier steering ---------------

  private updateSoldiers(): void {
    const s = this.soldiers;
    // A man is only as steady as the formation he is standing in, and a man in
    // no formation is not steady at all. Cleared first so that leaving a group
    // takes the benefit with it.
    this.steadiness.fill(0);
    for (const g of this.groups) {
      const living = g.members.filter((m) => s.alive[m] === 1);
      if (living.length === 0) continue;
      const speed = this.groupSpeed(g);
      const c = cos(g.facing);
      const sn = sin(g.facing);
      let inSlot = 0;
      let fighting = 0;

      for (const id of living) {
        const slot = s.slot[id];
        if (slot < 0 || slot * 2 + 1 >= g.slots.length) continue;
        const lx = g.slots[slot * 2];
        const ly = g.slots[slot * 2 + 1];
        let tx = g.anchorX + lx * c - ly * sn;
        let ty = g.anchorY + lx * sn + ly * c;

        // A slot can land in a river. Slide the target back toward the anchor
        // until it is walkable, so the formation compresses against the
        // obstacle rather than stranding men reaching for open water.
        if (TERRAIN_INFO[this.terrain.typeAtWorld(tx, ty)].moveScale <= 0) {
          let found = false;
          for (let k = 1; k <= 4; k++) {
            const f = 1 - k * 0.22;
            const px = g.anchorX + (tx - g.anchorX) * f;
            const py = g.anchorY + (ty - g.anchorY) * f;
            if (TERRAIN_INFO[this.terrain.typeAtWorld(px, py)].moveScale > 0) {
              tx = px;
              ty = py;
              found = true;
              break;
            }
          }
          // A wide line crossing a narrow bridge has whole ranks hanging over
          // the water, so sliding toward the anchor never reaches dry ground.
          // Fall back to the anchor itself, which a group can never occupy
          // unless it is passable -- otherwise the wings simply stop on the
          // bank and are left behind for the rest of the match.
          if (!found) {
            tx = g.anchorX;
            ty = g.anchorY;
          }
        }
        // If the way to that slot is not walkable in a straight line, head for
        // the anchor instead. A man on the near bank whose slot sits on the far
        // one will otherwise walk at the water and grind against it -- the
        // anchor is on the crossing, so aiming there funnels him over it.
        // Checked only when he is genuinely far from station, to keep a raycast
        // off the common case.
        if (
          dist(s.x[id], s.y[id], tx, ty) > SLOT_DETOUR_CHECK &&
          !clearLine(this.terrain, s.x[id], s.y[id], tx, ty)
        ) {
          tx = g.anchorX;
          ty = g.anchorY;
        }

        // Melee soldiers break ranks for anyone already on top of them. A
        // withdrawal is the one order that overrides this -- disengaging is the
        // whole point of it -- and a group standing down to recover is helpless
        // by design and does not get to start fights either.
        const mayEngage =
          g.stance !== "retreat" && g.stance !== "recover" && g.stance !== "ambush";
        const foe = mayEngage ? this.engagementFor(id) : -1;
        // Keep where he was SUPPOSED to stand: a man fighting from his place in
        // the line is still a formed company, and cohesion has to be able to
        // say so.
        const slotX = tx;
        const slotY = ty;
        if (foe >= 0) {
          tx = s.x[foe];
          ty = s.y[foe];
        }

        if (foe >= 0) fighting++;
        const arrived = this.steer(id, tx, ty, speed, g.facing);
        if (foe < 0) {
          if (arrived) inSlot++;
        } else if (dist(s.x[id], s.y[id], slotX, slotY) < FORMED_WHILE_FIGHTING) {
          // Stepping out to strike someone in front of you is fighting IN the
          // line. Counting it as a broken formation drove cohesion to zero the
          // instant any company engaged -- which meant the formation bonus
          // vanished in precisely the situation it exists for, and a formed
          // company fought no better than a mob.
          inSlot++;
        }
      }
      g.cohesion = inSlot / living.length;
      for (const id of living) this.steadiness[id] = g.cohesion;
      g.engaged = fighting;
    }

    // Soldiers nobody has grouped still stand their ground, jostle for room,
    // and go for anyone who comes at them. They are entities in their own
    // right, not orphans waiting for a squad.
    for (let id = 0; id < s.count; id++) {
      if (s.alive[id] !== 1 || s.group[id] >= 0) continue;
      const foe = this.engagementFor(id);
      if (foe >= 0) this.steer(id, s.x[foe], s.y[foe], 0, s.facing[id]);
      else this.steer(id, s.x[id], s.y[id], 0, s.facing[id]);
    }
  }

  /**
   * The enemy this soldier should be walking at, or -1 to hold its place.
   *
   * Hand-to-hand only. Archers and engines have their own reach and are worse
   * than useless in a melee, so they keep their slot and shoot; sending them to
   * close would throw away the whole reason they are behind the front rank.
   * Nearest wins, ties on index so both peers pick the same man.
   */
  private engagementFor(id: number): number {
    const s = this.soldiers;
    if (this.stats(id).range > MELEE_RANGE) return -1;
    const n = this.sightHash.query(s.x[id], s.y[id], ENGAGE_RANGE, this.watchers);
    let best = -1;
    let bestD = ENGAGE_RANGE * ENGAGE_RANGE;
    for (let k = 0; k < n; k++) {
      const other = this.watchers[k];
      if (s.alive[other] !== 1 || s.player[other] === s.player[id]) continue;
      const dd = d2(s.x[id], s.y[id], s.x[other], s.y[other]);
      if (dd < bestD || (dd === bestD && other < best)) {
        bestD = dd;
        best = other;
      }
    }
    return best;
  }

  /** One soldier's pull toward its slot, plus separation. True if settled. */
  private steer(id: number, tx: number, ty: number, groupSpeed: number, facing: number): boolean {
    const s = this.soldiers;
    const st = this.stats(id);
    const sx = s.x[id];
    const sy = s.y[id];
    const dx = tx - sx;
    const dy = ty - sy;
    const d = sqrt(dx * dx + dy * dy);
    const settled = d <= IN_SLOT;

    // A soldier moves at his OWN pace and no faster, whether he is marching in
    // formation or walking over to join a group that has just been drawn around
    // him. Letting men accelerate to close a gap makes forming up look like
    // teleporting, and it is the group anchor's job to wait, not the soldier's
    // job to sprint. The anchor already travels at the slowest member's speed,
    // so anyone whose own pace exceeds that closes the distance naturally.
    const ground = TERRAIN_INFO[this.terrain.typeAtWorld(sx, sy)];
    const scale = ground.moveScale > 0 ? ground.moveScale : STRANDED_WADE;
    const maxSpeed = st.speed * scale;
    void groupSpeed;

    const arrive = min(1, d / ARRIVE_EASE);
    let vx = d > 1e-6 ? (dx / d) * arrive : 0;
    let vy = d > 1e-6 ? (dy / d) * arrive : 0;

    const n = this.hash.query(sx, sy, SEPARATION_RADIUS, this.neighbours);
    for (let k = 0; k < n; k++) {
      const other = this.neighbours[k];
      if (other === id || s.alive[other] !== 1) continue;
      const ox = sx - s.x[other];
      const oy = sy - s.y[other];
      const od2 = ox * ox + oy * oy;
      if (od2 <= 1e-9 || od2 >= SEPARATION_RADIUS * SEPARATION_RADIUS) continue;
      const od = sqrt(od2);
      const w = ((SEPARATION_RADIUS - od) / SEPARATION_RADIUS) * SEPARATION_WEIGHT;
      vx += (ox / od) * w;
      vy += (oy / od) * w;
    }

    const vlen = sqrt(vx * vx + vy * vy);
    if (vlen > 1e-6) {
      // Vector magnitude doubles as the throttle: settled and uncrowded means a
      // short vector means no movement.
      const budget = maxSpeed * TICK_DT * min(1, vlen);
      const ux = vx / vlen;
      const uy = vy / vlen;
      let r = advanceToward(this.terrain, sx, sy, sx + ux * budget, sy + uy * budget, budget);
      if (r.blocked) {
        // Pressed against an obstacle. Try walking ALONG it rather than into
        // it: a soldier funnelling onto a bridge is heading at the bank for
        // most of the approach, and stopping dead there is how a wing ends up
        // stranded across the river from its own group.
        for (const turn of DEFLECTIONS) {
          const c = cos(turn);
          const sn2 = sin(turn);
          const dx2 = ux * c - uy * sn2;
          const dy2 = ux * sn2 + uy * c;
          const slid = advanceToward(
            this.terrain, sx, sy, sx + dx2 * budget, sy + dy2 * budget, budget,
          );
          if (slid.travelled > 1e-6) {
            r = slid;
            break;
          }
        }
      }
      s.x[id] = r.x;
      s.y[id] = r.y;
      const want = d > IN_SLOT * 1.5 ? atan2(uy, ux) : facing;
      s.facing[id] = rotateToward(s.facing[id], want, st.turnRate * 2.2 * TICK_DT);
    } else {
      s.facing[id] = rotateToward(s.facing[id], facing, st.turnRate * 2.2 * TICK_DT);
    }
    return settled;
  }

  // -- vision -------------------------------------------------------------------

  /**
   * Who can see whom. Both armies run through this same code -- the AI being
   * subject to the same fog is only credible if there is not a second, more
   * generous path for it.
   */
  /**
   * Light the ground each army can currently see, and nothing else.
   *
   * Split out of updateVision so it can be run while the world is NOT ticking.
   * Deployment freezes the match, so vision never swept, so every fog cell sat
   * at "never seen" and the player set their army out on a blacked-out map --
   * unable to read the ground they were choosing.
   *
   * This deliberately touches only FogField, never s.seen or g.seenBy. The fog
   * grid is not hashed; seenBy is. Keeping off the hashed state means calling
   * this outside the tick loop cannot desync a peer or move a golden.
   */
  lightGround(): void {
    const s = this.soldiers;
    for (const f of this.fog) f.beginUpdate();
    // A flare lights ground nobody is standing near, which is the whole point
    // of firing one: you cannot shell what you cannot see.
    for (const f of this.fields) {
      if (f.ability === "flare") this.fog[f.player].stamp(f.x, f.y, f.radius);
    }
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] !== 1) continue;
      // Every soldier lights its own surroundings, grouped or not. No unit
      // perceives further than its own sight radius allows.
      this.fog[s.player[i]].stamp(
        s.x[i], s.y[i], effectiveSight(this.terrain, this.stats(i).sight * this.sightScale, s.x[i], s.y[i]),
      );
    }
  }

  private updateVision(): void {
    // Swept on its interval -- or at once when the ground that blocks sight
    // has changed (a wall breached, a wood burnt out), because a sightline that
    // opened is news that should not wait for the next sweep.
    if (this.tick % SIGHT_INTERVAL !== 0 && this.terrain.sightAt === this.sightSwept) return;
    this.sightSwept = this.terrain.sightAt;
    const s = this.soldiers;
    this.lightGround();

    // Who can be perceived by whom, once per tick.
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] !== 1) {
        s.seen[i] = 0;
        continue;
      }
      const own = s.player[i];
      let mask = own === 0 ? 1 : 2;
      const foe = 1 - own;
      // Cheap reject first: if no enemy has lit this ground at all, no enemy
      // can possibly have eyes on the man standing there.
      if (this.fog[foe].at(s.x[i], s.y[i]) === 1 && this.spotted(i, foe)) {
        mask |= foe === 0 ? 1 : 2;
      }
      s.seen[i] = mask;
    }

    for (const g of this.groups) {
      if (this.liveCount(g) === 0) continue;
      g.seenBy[g.player] = true;
      const foe = 1 - g.player;
      let spotted = false;
      for (const m of g.members) {
        if (s.alive[m] === 1 && (s.seen[m] & (foe === 0 ? 1 : 2)) !== 0) {
          spotted = true;
          break;
        }
      }
      g.seenBy[foe] = spotted;
    }
  }

  /**
   * Does any soldier of `watcher` actually have eyes on soldier `id`?
   *
   * Bounded by MAX_SIGHT and answered from the coarse sight hash, with an early
   * exit on the first watcher that succeeds -- which in a battle is almost
   * always the first one tried.
   */
  private spotted(id: number, watcher: number): boolean {
    const s = this.soldiers;

    // A screen is OPAQUE, not merely dimming. Treating it as a reduction in
    // sight range did nothing at close quarters -- scouts a hundred and sixty
    // units away still saw straight through a screen that had cut their range
    // by three quarters, because three quarters of nine hundred is still more
    // than a hundred and sixty. Smoke you cannot see through is the whole
    // reason to buy it. Men right on top of it still make each other out.
    if (this.smokeAt(s.x[id], s.y[id]) > 0) {
      let close = false;
      const n0 = this.sightHash.query(s.x[id], s.y[id], SMOKE_SEE_THROUGH, this.watchers);
      for (let k = 0; k < n0; k++) {
        const eye = this.watchers[k];
        if (s.alive[eye] !== 1 || s.player[eye] !== watcher) continue;
        if (d2(s.x[eye], s.y[eye], s.x[id], s.y[id]) <= SMOKE_SEE_THROUGH * SMOKE_SEE_THROUGH) {
          close = true;
          break;
        }
      }
      // Checked BEFORE the flare, so a screen beats a light: you cannot
      // illuminate your way through smoke.
      if (!close) return false;
    }

    // Lit up by a flare: no amount of cover hides a man standing in the light.
    if (this.flaredFor(watcher, s.x[id], s.y[id])) return true;
    let hidden = concealment(this.terrain, s.x[id], s.y[id]);
    // Lying in wait, keeping still: far harder to pick out, and more so in
    // ground that was worth hiding in. An ambush in the open is still an
    // ambush, but it is not concealment -- the bonus scales with the cover the
    // player chose to sit in.
    const own = this.groupOf(id);
    if (own && own.stance === "ambush") hidden = min(0.85, hidden + 0.25 + hidden * 0.6);
    const n = this.sightHash.query(s.x[id], s.y[id], MAX_SIGHT, this.watchers);
    let raycasts = 0;
    for (let k = 0; k < n; k++) {
      const eye = this.watchers[k];
      if (s.alive[eye] !== 1 || s.player[eye] !== watcher) continue;
      const reach = effectiveSight(this.terrain, this.stats(eye).sight * this.sightScale, s.x[eye], s.y[eye]) * (1 - hidden);
      if (d2(s.x[eye], s.y[eye], s.x[id], s.y[id]) > reach * reach) continue;
      if (hasLineOfSight(this.terrain, s.x[eye], s.y[eye], s.x[id], s.y[id])) return true;
      // A raycast is the expensive part. If this many watchers are all in range
      // and all blocked, the man is genuinely well hidden; stop paying to
      // confirm it from every remaining pair of eyes.
      if (++raycasts >= MAX_RAYCASTS) return false;
    }
    return false;
  }

  /** Can this army perceive that soldier? An O(1) read of the per-tick cache. */
  canSee(player: number, id: number): boolean {
    const s = this.soldiers;
    if (s.player[id] === player) return true;
    if (s.alive[id] !== 1) return false;
    return (s.seen[id] & (player === 0 ? 1 : 2)) !== 0;
  }

  // -- magic --------------------------------------------------------------------

  /**
   * Adepts work whichever spell suits the order their group already has.
   *
   * Deliberately no gesture of its own: the pen vocabulary is already wide and
   * provably diagonal, and every class added raises collision pressure on the
   * rest. Telling adepts to attack IS casting the hex.
   */
  private castSpells(): void {
    const s = this.soldiers;
    for (const g of this.groups) {
      if (this.tick < g.spellReady) continue;
      const caster = g.members.find(
        (m) => s.alive[m] === 1 && UNIT_TYPES[this.typeOf(m)].spell !== undefined,
      );
      if (caster === undefined) continue;

      // A caster works what it KNOWS, not whatever the stance suggests. Adepts
      // read the order they were given -- hex when told to attack, ward when
      // told to hold -- but surgeons only ever do the one thing, and picking
      // their working by stance would have them hexing the enemy.
      const known = UNIT_TYPES[this.typeOf(caster)].spell;
      let choose: SpellId;
      if (known === "succour") {
        // Surgeons know one thing and do it. Choosing by stance would have them
        // throwing fire.
        if (!this.woundedNear(g) && this.tick - g.lastContact > TICK_RATE * 6) continue;
        choose = "succour";
      } else {
        // Adepts reach for whatever suits the moment, and WHICH of those they
        // reach for is a roll -- so two adept companies in a battle do not read
        // as one copied twice, and no single counter answers all of them.
        // Drawn from its own stream, so adding a spell to the list never shifts
        // a combat or morale roll.
        const foe = this.nearestVisibleFoe(g);
        const list = foe && g.stance !== "hold" && g.stance !== "recover"
          ? OFFENSIVE_SPELLS
          : SUPPORTIVE_SPELLS;
        choose = list[this.rng.magic.int(list.length)];
        // Healing nobody is a wasted working; fall back to steadying them.
        if (choose === "mend" && !this.woundedNear(g)) choose = "ward";
      }

      const spell = SPELLS[choose];
      let tx = g.anchorX;
      let ty = g.anchorY;
      if (!spell.onAllies) {
        const foe = this.nearestVisibleFoe(g);
        if (!foe) continue;
        tx = foe.anchorX;
        ty = foe.anchorY;
      }
      if (SPELLS[choose].kind === "burst") {
        // A fireball is an event: its damage lands the instant it is worked,
        // and what remains on the ground is only the mark it leaves.
        const spec2 = SPELLS[choose];
        const rr = spec2.radius * spec2.radius;
        for (let i = 0; i < s.count; i++) {
          if (s.alive[i] !== 1) continue;
          if ((s.player[i] === g.player) === spec2.onAllies) {
            if (d2(tx, ty, s.x[i], s.y[i]) > rr) continue;
            s.incoming[i] += spec2.damage ?? 0;
            s.struckBy[i] = caster;
            s.struckHow[i] = HOW_RANGED;
          }
        }
      }

      this.workings.push({
        spell: choose,
        group: g.id,
        player: g.player,
        x: tx,
        y: ty,
        radius: spell.radius,
        until: this.tick + spell.duration * TICK_RATE,
        power: this.stats(caster).magic,
      });
      g.spellReady = this.tick + spell.cooldown * TICK_RATE;
    }
    for (let i = this.workings.length - 1; i >= 0; i--) {
      if (this.workings[i].until <= this.tick) this.workings.splice(i, 1);
    }
  }

  private woundedNear(g: Group): boolean {
    const s = this.soldiers;
    const r = SPELLS.mend.radius * SPELLS.mend.radius;
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] !== 1 || s.player[i] !== g.player) continue;
      if (s.hp[i] >= s.maxHp[i] * 0.75) continue;
      if (d2(g.anchorX, g.anchorY, s.x[i], s.y[i]) <= r) return true;
    }
    return false;
  }

  private nearestVisibleFoe(g: Group): Group | null {
    let best: Group | null = null;
    let bestD = Infinity;
    for (const other of this.groups) {
      if (other.player === g.player || this.liveCount(other) === 0 || !other.seenBy[g.player]) continue;
      const dd = d2(g.anchorX, g.anchorY, other.anchorX, other.anchorY);
      if (dd < bestD || (dd === bestD && best !== null && other.id < best.id)) {
        bestD = dd;
        best = other;
      }
    }
    return best;
  }

  /** Wards soak, enemy hexes amplify. Negative means blows land harder. */
  private shelterAt(player: number, x: number, y: number): number {
    let soak = 0;
    for (const w of this.workings) {
      if (d2(w.x, w.y, x, y) > w.radius * w.radius) continue;
      if (w.spell === "ward" && w.player === player) soak = max(soak, wardSoak(w.power));
      else if (w.spell === "hex" && w.player !== player) soak -= hexPenalty(w.power);
    }
    return clamp(soak, -0.6, 0.6);
  }

  private applyWorkings(): void {
    if (this.workings.length === 0) return;
    const s = this.soldiers;
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] !== 1) continue;
      for (const w of this.workings) {
        const friendly = w.player === s.player[i];
        if (SPELLS[w.spell].onAllies !== friendly) continue;
        if (d2(w.x, w.y, s.x[i], s.y[i]) > w.radius * w.radius) continue;
        s.morale[i] = clamp(s.morale[i] + nerveShift(w.spell, w.power) * TICK_DT, 0, 1);
        if (s.hp[i] >= s.maxHp[i]) continue;
        if (w.spell === "mend") {
          s.hp[i] = min(s.maxHp[i], s.hp[i] + mendRate(w.power, s.maxHp[i]) * TICK_DT);
        } else if (w.spell === "succour") {
          s.hp[i] = min(s.maxHp[i], s.hp[i] + succourRate(w.power, s.maxHp[i]) * TICK_DT);
        }
      }
    }
  }

  // -- combat -------------------------------------------------------------------

  /**
   * One tick of fighting, in two passes.
   *
   * Pass one buffers every blow into soldiers.incoming without changing any hit
   * points; pass two applies them and removes the dead. Striking and killing in
   * one pass would give the lower-indexed army -- always player 0, who spawned
   * first -- the first blow in every mutual engagement and win every coin-flip
   * trade. Perfectly deterministic, and silently unfair.
   *
   * Targeting is per SOLDIER, not per squad: each man picks his own fight with
   * his own reach.
   */
  private resolveCombat(): void {
    const s = this.soldiers;
    this.events.length = 0;
    for (const g of this.groups) g.flanked = false;

    for (let id = 0; id < s.count; id++) {
      if (s.alive[id] !== 1) continue;
      if (s.cooldown[id] > 0) {
        s.cooldown[id] -= TICK_DT;
        continue;
      }
      // Men lying in wait hold their fire until someone walks onto them. That
      // is the whole trade: you give up shooting at range for a first blow
      // delivered at point-blank with the enemy unready.
      const own = this.groupOf(id);
      if (own && own.stance === "ambush") continue;
      const st = this.stats(id);
      if (st.range > MELEE_RANGE) this.shoot(id, st);
      else this.hack(id, st);
    }
    this.applyDamage();
  }

  /**
   * Spring any ambush an enemy has walked into.
   *
   * Checked per company rather than per man: an ambush is sprung together or
   * not at all, which is what makes it worth more than the same men shooting
   * as they each happen to acquire a target.
   */
  private updateAmbushes(): void {
    const s = this.soldiers;
    for (const g of this.groups) {
      if (g.stance !== "ambush") continue;
      let sprung = false;
      for (const m of g.members) {
        if (s.alive[m] !== 1) continue;
        const n = this.hash.query(s.x[m], s.y[m], AMBUSH_TRIGGER, this.neighbours);
        for (let k = 0; k < n; k++) {
          const other = this.neighbours[k];
          if (s.alive[other] === 1 && s.player[other] !== g.player) {
            sprung = true;
            break;
          }
        }
        if (sprung) break;
      }
      if (!sprung) continue;
      // Up and at them, with the bite that waiting bought.
      g.stance = "attack";
      g.chargeUntil = this.tick + AMBUSH_BITE_SECONDS * TICK_RATE;
    }
  }

  /** Empty the damage buffer for a fresh tick. */
  private clearDamageBuffer(): void {
    const s = this.soldiers;
    for (let i = 0; i < s.count; i++) {
      s.incoming[i] = 0;
      s.localShock[i] = 0;
    }
  }

  /** Hand to hand: neighbours come from the hash, whose cells are sized for it. */
  private hack(id: number, st: Stats): void {
    const s = this.soldiers;
    const n = this.hash.query(s.x[id], s.y[id], MELEE_RANGE, this.neighbours);
    let target = -1;
    let bestD = MELEE_RANGE * MELEE_RANGE;
    for (let k = 0; k < n; k++) {
      const other = this.neighbours[k];
      if (s.alive[other] !== 1 || s.player[other] === s.player[id]) continue;
      const dd = d2(s.x[id], s.y[id], s.x[other], s.y[other]);
      if (dd < bestD || (dd === bestD && other < target)) {
        bestD = dd;
        target = other;
      }
    }
    if (target >= 0) this.strike(id, target, st);
  }

  /**
   * Shooting. Never the spatial hash: its cells are sized for separation, so a
   * 250-unit bow sweeping that grid would touch hundreds of cells per soldier
   * per tick. Enemy groups are scanned first, then men within the chosen one.
   */
  private shoot(id: number, st: Stats): void {
    const s = this.soldiers;
    // Out of arrows. He stands with the rest of his company and is now a poor
    // hand-to-hand soldier standing in the open, which is the entire point.
    if (s.ammo[id] <= 0) return;
    const me = s.player[id];
    let best: Group | null = null;
    let bestD = Infinity;
    for (const g of this.groups) {
      if (g.player === me || !g.seenBy[me] || this.liveCount(g) === 0) continue;
      const reach =
        st.range * rangeFromHeight(this.terrain, s.x[id], s.y[id], g.anchorX, g.anchorY) + g.radius;
      const dd = d2(s.x[id], s.y[id], g.anchorX, g.anchorY);
      if (dd > reach * reach) continue;
      if (dd < bestD || (dd === bestD && best !== null && g.id < best.id)) {
        bestD = dd;
        best = g;
      }
    }

    if (best) {
      const living = best.members.filter((m) => s.alive[m] === 1);
      if (living.length === 0) return;
      // Concentrate on a quarter of the group. Spreading a volley over everyone
      // dilutes it so far that all sit wounded forever and nobody falls.
      const focus = max(1, (living.length / 4) | 0);
      const victim = living[id % focus];
      if (d2(s.x[id], s.y[id], s.x[victim], s.y[victim]) <= st.range * st.range) {
        this.strike(id, victim, st);
        return;
      }
    }

    // Ungrouped enemies are still shootable; they just need finding directly.
    // Through the sight hash, not a sweep of the whole army: a scan per shooter
    // per tick is quadratic and was the single most expensive thing in a tick.
    let victim = -1;
    let vd = st.range * st.range;
    const n = this.sightHash.query(s.x[id], s.y[id], st.range, this.watchers);
    for (let k = 0; k < n; k++) {
      const i = this.watchers[k];
      if (s.alive[i] !== 1 || s.player[i] === me) continue;
      const dd = d2(s.x[id], s.y[id], s.x[i], s.y[i]);
      if (dd >= vd || !this.canSee(me, i)) continue;
      vd = dd;
      victim = i;
    }
    if (victim >= 0) this.strike(id, victim, st);
  }

  /** Buffer one blow. Nothing dies until the whole tick has been resolved. */
  private strike(attacker: number, victim: number, st: Stats): void {
    const s = this.soldiers;
    // Under a parley nobody strikes. Checked only when one stands on the field.
    if (this.fields.length > 0 &&
      (this.parleyAt(s.x[attacker], s.y[attacker]) || this.parleyAt(s.x[victim], s.y[victim]))) {
      return;
    }
    const ag = this.groupOf(attacker);

    // Arriving at a body of troops that was not already fighting is a charge.
    // Read BEFORE lastContact is stamped below, and gated on a lull so that a
    // grinding melee does not re-trigger it every few ticks.
    if (ag && this.tick - ag.lastContact > CHARGE_LULL &&
        (ag.stance === "move" || ag.stance === "attack")) {
      ag.chargeUntil = this.tick + CHARGE_SECONDS * TICK_RATE;
    }
    const charging = ag !== undefined && ag.chargeUntil > this.tick;

    // A rank standing in its slot is far harder to kill than the same man
    // caught out of formation, and a man in no group at all gets nothing.
    const defence = this.stats(victim).defence * (1 + COHESION_ARMOUR * this.steadiness[victim]);
    const shield = this.shieldSoak(s.player[victim], s.x[victim], s.y[victim]);
    const vg0 = this.groupOf(victim);
    const ag0 = this.groupOf(attacker);
    // A company that has planted itself deals nothing at all -- that is what
    // the near-immunity is bought with.
    if (ag0 && this.hasSpecial(ag0, "fortify")) return;
    // Light troops on the move are simply missed, half the time.
    if (vg0 && this.hasSpecial(vg0, "dodge") && this.rng.combat.chance(DODGE_CHANCE)) return;

    let dmg = hitDamage(
      this.rng.combat,
      st.attack * (1 + COHESION_STRIKE * this.steadiness[attacker]),
      defence,
      this.shelterAt(s.player[victim], s.x[victim], s.y[victim]),
      this.terrain,
      s.x[victim],
      s.y[victim],
    );
    if (charging) dmg *= 1 + CHARGE_BONUS;
    // Shot over a wall: the stone takes what it takes. Read along the line of
    // the shot, because nobody stands IN a wall -- they stand behind it. Only
    // a field with walls on it asks.
    if (this.siege !== null && st.range > MELEE_RANGE) {
      const behind = parapetCover(this.terrain, s.x[attacker], s.y[attacker], s.x[victim], s.y[victim]);
      if (behind > 0) dmg *= 1 - behind;
    }
    // -- the second roster's habits. Every test is on a special in force, so a
    // battle without these troops takes exactly the arithmetic it always did.
    if (charging && ag0 && this.hasSpecial(ag0, "couch")) dmg *= 1 + COUCH_BONUS;
    if (charging && ag && vg0 && this.hasSpecial(vg0, "setPikes")) {
      // The charge breaks on the hedge, and it is over.
      dmg *= SET_PIKES_PASS;
      ag.chargeUntil = this.tick;
    }
    if (ag0 && this.hasSpecial(ag0, "challenge")) dmg *= CHALLENGE_STRIKE;
    if (ag0 && this.hasSpecial(ag0, "lastStand")) dmg *= LAST_STAND_STRIKE;
    if (st.range > MELEE_RANGE && vg0 && this.hasSpecial(vg0, "pavise")) dmg *= PAVISE_PASS;
    if (vg0 && this.hasSpecial(vg0, "laager")) dmg *= LAAGER_PASS;
    else if (this.auras.length > 0 &&
      this.auraAt("laager", s.player[victim], s.x[victim], s.y[victim], LAAGER_RADIUS, false)) {
      dmg *= 1 - LAAGER_SHELTER;
    }
    if (shield > 0) dmg *= 1 - shield;
    if (vg0 && this.hasSpecial(vg0, "brace")) dmg *= 1 - BRACE_SOAK;
    if (vg0 && this.hasSpecial(vg0, "fortify")) dmg *= 1 - FORTIFY_SOAK;
    // Coming at somebody else's stakes is hard work.
    const hampered = this.assaultPenalty(s.player[attacker], s.x[attacker], s.y[attacker]);
    if (hampered > 0) dmg *= 1 - hampered;
    s.incoming[victim] += dmg;
    s.struckBy[victim] = attacker;
    s.cooldown[attacker] =
      st.attackInterval * (ag0 && this.hasSpecial(ag0, "brace") ? BRACE_SLOWDOWN : 1);
    // A volley is spent where a shot is actually loosed, so looking for a
    // target and finding none costs nothing.
    if (st.range > MELEE_RANGE && s.ammo[attacker] > 0) s.ammo[attacker] -= 1;

    const flanking = isFlanking(
      s.facing[victim], s.x[attacker], s.y[attacker], s.x[victim], s.y[victim],
    );
    // Remembered so that IF this blow turns out to be the fatal one, the death
    // can be explained. Computed here because the flank test needs both men's
    // positions, which are gone by the time damage is applied.
    s.struckHow[victim] =
      (st.range > MELEE_RANGE ? HOW_RANGED : HOW_MELEE) | (flanking ? HOW_FLANK_BIT : 0);

    const vg = this.groupOf(victim);
    if (ag) ag.lastContact = this.tick;
    if (vg) {
      vg.lastContact = this.tick;
      if (flanking) vg.flanked = true;
    }
    this.events.push({
      kind: st.range > MELEE_RANGE ? "shot" : "melee",
      player: s.player[attacker],
      type: this.typeOf(attacker),
      x0: s.x[attacker],
      y0: s.y[attacker],
      x1: s.x[victim],
      y1: s.y[victim],
      lethal: false,
      victim,
      attacker,
    });
  }

  private groupOf(id: number): Group | undefined {
    const gid = this.soldiers.group[id];
    return gid < 0 ? undefined : this.groupById(gid);
  }

  private applyDamage(): void {
    const s = this.soldiers;
    for (const g of this.groups) {
      g.casualtiesThisTick = 0;
      g.flankCasualtiesThisTick = 0;
      g.killsThisTick = 0;
    }
    const reflowed = new Set<number>();

    for (let id = 0; id < s.count; id++) {
      if (s.alive[id] !== 1 || s.incoming[id] <= 0) continue;
      s.hp[id] -= s.incoming[id];
      if (s.hp[id] > 0) continue;
      s.alive[id] = 0;
      s.hp[id] = 0;

      // Credit the kill to whoever landed the last blow. Because damage is
      // buffered, a group wiped out this same tick still gets its credit.
      const killer = s.struckBy[id];
      const kg = killer >= 0 ? this.groupOf(killer) : undefined;
      if (kg) {
        kg.kills++;
        kg.killsThisTick++;
      }
      if (this.victory.mode === "points" && killer >= 0) {
        const side = s.player[killer] === 0 ? 0 : 1;
        this.points[side] += this.victory.perKill;
      }
      // Explain the casualty. A blow from outside the frontal arc is reported
      // as a flanking kill whether it was a spear or an arrow -- that is the
      // thing the player needs to learn from, not the weapon.
      const how = s.struckHow[id];
      const cause = (how & HOW_FLANK_BIT) !== 0 ? 2 : (how & 3) === HOW_RANGED ? 1 : 0;
      this.casualtiesByCause[s.player[id]][cause]++;

      const vg = this.groupOf(id);
      if (vg) {
        vg.losses++;
        vg.casualtiesThisTick++;
        if ((how & HOW_FLANK_BIT) !== 0) {
          vg.flankLosses++;
          vg.flankCasualtiesThisTick++;
        }
        reflowed.add(vg.id);
        const at = vg.members.indexOf(id);
        if (at >= 0) vg.members.splice(at, 1);
      }
      // Men standing loose near him feel it. Done from the DEATH outward -- one
      // spatial query per casualty -- rather than each soldier asking who died
      // near him, which would be a query per soldier per tick.
      const near = this.hash.query(s.x[id], s.y[id], LOOSE_SHOCK_RADIUS, this.neighbours);
      for (let k = 0; k < near; k++) {
        const other = this.neighbours[k];
        if (s.alive[other] !== 1 || s.group[other] >= 0) continue;
        if (s.player[other] !== s.player[id]) continue;
        s.localShock[other]++;
      }

      for (const e of this.events) if (e.victim === id) e.lethal = true;
      s.group[id] = -1;
      s.slot[id] = -1;
    }

    // Formations re-derive from the living, so a group never keeps gaps where
    // its dead used to stand while cohesion still reads full.
    for (const gid of reflowed) {
      const g = this.groupById(gid);
      if (g && g.members.length > 0) this.reflow(g);
    }
  }

  // -- objectives ---------------------------------------------------------------

  /**
   * Who stands on what, and what that earns them.
   *
   * A point is held by whoever has more living men inside it -- not merely
   * whoever arrived first, and not by anyone while it is contested. Counting
   * bodies rather than groups matters here: a single scout should not be able to
   * hold a hilltop against a company just by being grouped.
   */
  private updateObjectives(): void {
    if (this.controlPoints.length === 0) return;
    const s = this.soldiers;
    const held: [number, number] = [0, 0];

    for (let p = 0; p < this.controlPoints.length; p++) {
      const cp = this.controlPoints[p];
      let a = 0;
      let b = 0;
      const n = this.sightHash.query(cp.x, cp.y, cp.radius, this.watchers);
      for (let k = 0; k < n; k++) {
        const id = this.watchers[k];
        if (s.alive[id] !== 1) continue;
        if (d2(cp.x, cp.y, s.x[id], s.y[id]) > cp.radius * cp.radius) continue;
        if (s.player[id] === 0) a++;
        else b++;
      }
      // Contested ground counts for nobody. A point changes hands only when one
      // side clearly owns it, which is what makes taking one a real commitment.
      if (this.victory.mode === "breakthrough" && p === this.victory.exit) {
        this.through[0] = a;
        this.through[1] = b;
      }
      if (a > b) {
        this.heldBy[p] = 0;
        held[0]++;
      } else if (b > a) {
        this.heldBy[p] = 1;
        held[1]++;
      } else {
        this.heldBy[p] = -1;
      }
    }

    const v = this.victory;
    if (v.mode === "objectives") {
      for (const p of [0, 1]) {
        if (held[p] >= v.required) this.holdSeconds[p] += TICK_DT;
      }
    } else if (v.mode === "points") {
      for (const p of [0, 1]) {
        this.points[p] += held[p] * v.perPointHeld * TICK_DT;
      }
    }
  }

  /**
   * The river comes up. Bridges go under and marsh becomes open water, all at
   * once: every crossing the armies planned around is gone. Men caught on a
   * bridge are left wading, which the movement rules already handle. Routes
   * are recomputed, because the ground they were planned over no longer exists.
   */
  private raiseFlood(): void {
    if (this.flooded) return;
    this.flooded = true;
    const t = this.terrain;
    for (let ty = 0; ty < t.height; ty++) {
      for (let tx = 0; tx < t.width; tx++) {
        const k = t.typeAt(tx, ty);
        if (k === Terrain.Bridge || k === Terrain.Marsh) t.set(tx, ty, Terrain.Water);
      }
    }
    for (const g of this.groups) {
      if (g.path.length >= 2) g.path = this.routeThrough(g, [g.path[g.path.length - 2], g.path[g.path.length - 1]]);
    }
  }

  /** Is each side's standard still carried? Chooses the bearers on first use. */
  standardsFlying(): [boolean, boolean] {
    const s = this.soldiers;
    if (!this.standardBearers) {
      const pick = (p: number): number[] => {
        for (const kind of ["banner", "champion", "guard"] as const) {
          const ids: number[] = [];
          for (let i = 0; i < s.count; i++) {
            if (s.alive[i] === 1 && s.player[i] === p && this.typeOf(i) === kind) ids.push(i);
          }
          if (ids.length > 0) return ids;
        }
        // No colours at all: the first company raised carries them.
        for (const g of this.groups) {
          if (g.player === p) return g.members.filter((m) => s.alive[m] === 1);
        }
        return [];
      };
      this.standardBearers = [pick(0), pick(1)];
    }
    const flying = (ids: number[]): boolean => ids.some((i) => s.alive[i] === 1);
    return [flying(this.standardBearers[0]), flying(this.standardBearers[1])];
  }

  /** Who carries each side's standard, for the renderer. Empty until chosen. */
  bearersOf(player: number): readonly number[] {
    return this.standardBearers ? this.standardBearers[player] : [];
  }

  /** How many control points a player currently holds. */
  pointsHeldBy(player: number): number {
    let n = 0;
    for (const owner of this.heldBy) if (owner === player) n++;
    return n;
  }

  // -- what troops do for themselves --------------------------------------------

  /** The special this company's men know, or undefined for a mixed rabble. */
  private specialOf(g: Group): SpecialId | undefined {
    const s = this.soldiers;
    const tally = new Map<SpecialId, number>();
    let best: SpecialId | undefined;
    let bestN = 0;
    for (const m of g.members) {
      if (s.alive[m] !== 1) continue;
      const sp = UNIT_TYPES[this.typeOf(m)].special;
      if (!sp) continue;
      const n = (tally.get(sp) ?? 0) + 1;
      tally.set(sp, n);
      if (n > bestN) {
        bestN = n;
        best = sp;
      }
    }
    return best;
  }

  /** Is this company's own trick in effect right now? */
  hasSpecial(g: Group, id: SpecialId): boolean {
    return g.specialUntil > this.tick && this.specialOf(g) === id;
  }

  /** Which trick a company knows, for the renderer. Undefined for a rabble. */
  specialKind(g: Group): SpecialId | undefined {
    return this.specialOf(g);
  }

  /**
   * Decide, for each company, whether now is the moment.
   *
   * Judged from the company's own circumstances only -- what it can see
   * happening to it -- never from anything the other side is about to do. A
   * company that braced because it knew a charge was coming would be cheating.
   */
  private updateSpecials(): void {
    const s = this.soldiers;
    for (const g of this.groups) {
      if (g.specialUntil > this.tick) continue;
      if (this.tick < g.specialReadyAt) continue;
      const id = this.specialOf(g);
      if (id === undefined) continue;
      const spec = SPECIALS[id];
      // The two that happen once are tracked by their own flags. A shared
      // counter meant a mixed company spent its one withdrawal on bracing.
      if (id === "blink" && g.blinked) continue;
      if (id === "breakBow" && g.bowsBroken) continue;

      const living = this.liveCount(g);
      if (living === 0) continue;
      const inContact = this.tick - g.lastContact < TICK_RATE * 2;
      const bleeding = g.casualtiesThisTick > 0;
      let nerve = 0;
      for (const m of g.members) if (s.alive[m] === 1) nerve += s.morale[m];
      nerve /= living;

      let now = false;
      switch (id) {
        case "brace":
          // Shields go up when the fighting turns against them, not the moment
          // anyone comes into view.
          now = inContact && (bleeding || nerve < 0.7);
          break;
        case "dodge":
          // Light troops start moving the instant anything is aimed their way.
          now = inContact || this.underFire(g);
          break;
        case "breakBow":
          // Bows are thrown down only with the enemy actually on top of them.
          now = this.enemyWithin(g, MELEE_RANGE * 2.2) && (bleeding || nerve < 0.6);
          break;
        case "dash":
          // A gallop is for closing ground, not for standing in a melee.
          now = !inContact && g.path.length >= 2 &&
            (g.stance === "attack" || g.stance === "move");
          break;
        case "fortify":
          // Planting themselves is what a guard does when it is being
          // overwhelmed, and it is close to a last resort.
          now = inContact && (nerve < 0.45 || this.outnumberedAt(g, 1.6));
          break;
        case "entrench":
          // Digging in earnest is for when there is a reason to: something is
          // coming, and this ground is worth keeping.
          now = g.stance === "hold" && this.enemyWithin(g, 900);
          break;
        case "triage":
          // Called when there is no time for anything gentler -- several men
          // near the edge at once.
          now = this.badlyWoundedNear(g) >= 3;
          break;
        case "blink":
          // Once, and only when they are about to be destroyed.
          now = inContact && (nerve < 0.4 || g.losses > g.raisedWith * 0.35);
          break;
        case "setPikes":
          // Butts go down when something is close and coming, not before: a
          // hedge set too early is a hedge that cannot turn.
          now = this.enemyWithin(g, 150) && g.stance !== "move" && g.stance !== "retreat";
          break;
        case "pavise":
          now = this.underFire(g) && g.stance !== "move" && g.stance !== "retreat";
          break;
        case "couch":
          // The last hundred paces of a charge, never a melee already joined.
          now = !inContact && g.stance === "attack" && this.enemyWithin(g, 190);
          break;
        case "challenge":
          now = inContact;
          break;
        case "rally":
          now = this.friendNear(g, RALLY_RADIUS, "wavering") || (inContact && nerve < 0.6);
          break;
        case "cadence":
          now = g.stance === "move" || g.stance === "attack" ||
            this.friendNear(g, CADENCE_RADIUS, "moving");
          break;
        case "terror":
          now = inContact;
          break;
        case "lastStand":
          // Once in a battle, and only when the oath is actually being tested.
          now = g.specialUses === 0 &&
            (g.losses * 2 >= g.raisedWith || (inContact && nerve < 0.35));
          break;
        case "laager":
          now = (inContact || this.underFire(g)) && g.stance !== "move" && g.stance !== "retreat";
          break;
      }
      if (!now) continue;

      g.specialUses++;
      g.specialReadyAt = this.tick + spec.cooldown * TICK_RATE;
      g.specialUntil = this.tick + spec.duration * TICK_RATE;
      this.specialEvents.push({ kind: id, x: g.anchorX, y: g.anchorY, player: g.player });

      if (id === "triage") {
        // All at once, on the men who most need it, rather than the steady
        // trickle a surgeon's ordinary working provides.
        for (let i = 0; i < s.count; i++) {
          if (s.alive[i] !== 1 || s.player[i] !== g.player) continue;
          if (d2(g.anchorX, g.anchorY, s.x[i], s.y[i]) > TRIAGE_RADIUS * TRIAGE_RADIUS) continue;
          const missing = s.maxHp[i] - s.hp[i];
          if (missing <= 0) continue;
          s.hp[i] = min(s.maxHp[i], s.hp[i] + missing * TRIAGE_HEAL);
        }
      }
      if (id === "blink") g.blinked = true;
      if (id === "breakBow") g.bowsBroken = true;
      if (id === "challenge") {
        // The call itself is the blow to nerve; the fighting comes after.
        const c = this.liveCentre(g);
        for (let i = 0; i < s.count; i++) {
          if (s.alive[i] !== 1 || s.player[i] === g.player) continue;
          if (d2(c.x, c.y, s.x[i], s.y[i]) > CHALLENGE_RADIUS * CHALLENGE_RADIUS) continue;
          s.morale[i] = max(0, s.morale[i] - CHALLENGE_SHOCK);
        }
      }

      if (id === "breakBow") {
        // They are skirmishers now, and skirmishers dodge. There is no picking
        // the bow back up.
        for (const m of g.members) {
          if (s.alive[m] !== 1) continue;
          s.type[m] = typeIndex("skirmisher");
          this.statsOf[m] = statsFor("skirmisher", this.doctrine[g.player]);
          s.ammo[m] = 0;
        }
        g.specialReadyAt = this.tick;
        g.specialUntil = 0;
      } else if (id === "blink") {
        // Out of the world and back at the western edge, keeping formation.
        const toX = TILE_SIZE * 2;
        const dx = toX - g.anchorX;
        for (const m of g.members) {
          if (s.alive[m] !== 1) continue;
          const at = this.standingGround(
            clamp(s.x[m] + dx, TILE_SIZE, this.terrain.worldWidth - TILE_SIZE), s.y[m],
          );
          s.x[m] = at.x;
          s.y[m] = at.y;
        }
        g.path.length = 0;
        g.stance = "idle";
        this.recentre(g);
        this.reflow(g);
      }
    }
    this.rebuildAuras();
  }

  /** Rebuild where every standing aura is, from the specials now in force. */
  private rebuildAuras(): void {
    this.auras.length = 0;
    for (const g of this.groups) {
      if (g.specialUntil <= this.tick) continue;
      const id = this.specialOf(g);
      if (id !== "rally" && id !== "cadence" && id !== "terror" && id !== "laager") continue;
      const c = this.liveCentre(g);
      if (c.n === 0) continue;
      this.auras.push({ kind: id, player: g.player, x: c.x, y: c.y });
    }
  }

  /** Strongest aura of a kind reaching this point for this side, 0 or 1. */
  private auraAt(kind: SpecialId, player: number, x: number, y: number, reach: number, foe: boolean): boolean {
    for (const a of this.auras) {
      if (a.kind !== kind) continue;
      if (foe ? a.player === player : a.player !== player) continue;
      if (d2(a.x, a.y, x, y) <= reach * reach) return true;
    }
    return false;
  }

  /** Centre of a company's living men, and how many there are. */
  private liveCentre(g: Group): { x: number; y: number; n: number } {
    const s = this.soldiers;
    let x = 0;
    let y = 0;
    let n = 0;
    for (const m of g.members) {
      if (s.alive[m] !== 1) continue;
      x += s.x[m];
      y += s.y[m];
      n++;
    }
    return n === 0 ? { x: g.anchorX, y: g.anchorY, n } : { x: x / n, y: y / n, n };
  }

  /** Is a friendly company within reach that is wavering, or on the move? */
  private friendNear(g: Group, reach: number, what: "wavering" | "moving"): boolean {
    const s = this.soldiers;
    const c = this.liveCentre(g);
    for (const o of this.groups) {
      if (o === g || o.player !== g.player) continue;
      const oc = this.liveCentre(o);
      if (oc.n === 0 || d2(c.x, c.y, oc.x, oc.y) > reach * reach) continue;
      if (what === "moving") {
        if (o.stance === "move" || o.stance === "attack") return true;
        continue;
      }
      let nerve = 0;
      for (const m of o.members) if (s.alive[m] === 1) nerve += s.morale[m];
      if (nerve / oc.n < 0.5) return true;
    }
    return false;
  }

  /** Is anything shooting at this company? */
  private underFire(g: Group): boolean {
    for (const e of this.events) {
      if (e.kind !== "shot" || e.player === g.player) continue;
      if (this.soldiers.group[e.victim] === g.id) return true;
    }
    return false;
  }

  /**
   * The next piece of ground to dig.
   *
   * Prefers a tile ADJACENT to works this side already holds, so a position
   * grows outward into one connected system instead of a scatter of unrelated
   * holes across the field. Ties break on tile index, never on iteration order.
   */
  private digSite(g: Group): { tx: number; ty: number } {
    const here = { tx: (g.anchorX / TILE_SIZE) | 0, ty: (g.anchorY / TILE_SIZE) | 0 };
    let best: { tx: number; ty: number } | null = null;
    let bestKey = Infinity;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const tx = here.tx + dx;
        const ty = here.ty + dy;
        if (!this.terrain.fortifiableAt(tx, ty)) continue;
        if (this.worksTouching(tx, ty, g.player) === 0) continue;
        const key = ty * this.terrain.width + tx;
        if (key < bestKey) {
          bestKey = key;
          best = { tx, ty };
        }
      }
    }
    return best ?? here;
  }

  /** Works belonging to this side on the eight tiles around this one. */
  private worksTouching(tx: number, ty: number, player: number): number {
    let n = 0;
    for (const w of this.works) {
      if (w.player !== player) continue;
      const dx = w.tx - tx;
      const dy = w.ty - ty;
      if (dx === 0 && dy === 0) continue;
      if (dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1) n++;
    }
    return n;
  }

  /** How many of this company's men are close to going down. */
  private badlyWoundedNear(g: Group): number {
    const s = this.soldiers;
    let n = 0;
    for (const m of g.members) {
      if (s.alive[m] !== 1) continue;
      if (s.hp[m] < s.maxHp[m] * 0.45) n++;
    }
    return n;
  }

  /** Any enemy this close to any of its men? */
  private enemyWithin(g: Group, reach: number): boolean {
    const s = this.soldiers;
    for (const m of g.members) {
      if (s.alive[m] !== 1) continue;
      const n = this.hash.query(s.x[m], s.y[m], reach, this.neighbours);
      for (let k = 0; k < n; k++) {
        const other = this.neighbours[k];
        if (s.alive[other] === 1 && s.player[other] !== g.player) return true;
      }
    }
    return false;
  }

  /** Is it locally outnumbered by at least this ratio? */
  private outnumberedAt(g: Group, ratio: number): boolean {
    const s = this.soldiers;
    let friends = 0;
    let foes = 0;
    const n = this.hash.query(g.anchorX, g.anchorY, 160, this.neighbours);
    for (let k = 0; k < n; k++) {
      const other = this.neighbours[k];
      if (s.alive[other] !== 1) continue;
      if (s.player[other] === g.player) friends++;
      else foes++;
    }
    return foes > friends * ratio && foes > 0;
  }

  // -- commander's abilities ----------------------------------------------------

  /** Stock a player's abilities at the start of a battle. */
  armAbilities(player: number, ids: readonly AbilityId[]): void {
    const state = this.abilityState[player];
    state.clear();
    for (const id of ids) {
      const have = state.get(id);
      // Buying the same ability twice buys its charges twice.
      state.set(id, {
        left: (have?.left ?? 0) + ABILITIES[id].charges,
        readyAt: 0,
      });
    }
  }

  /** Can this player spend that ability right now? */
  abilityReady(player: number, id: AbilityId): boolean {
    const c = this.abilityState[player].get(id);
    return c !== undefined && c.left > 0 && this.tick >= c.readyAt;
  }

  /**
   * Spend one.
   *
   * Charges and cooldowns are checked HERE rather than in the interface, so the
   * rule binds a replay and an AI exactly as it binds the player -- an order
   * arriving for an ability with nothing left simply does nothing.
   */
  private applyAbility(player: number, id: AbilityId, x: number, y: number, squad: number): void {
    if (!this.abilityReady(player, id)) return;
    const c = this.abilityState[player].get(id);
    if (!c) return;
    const spec = ABILITIES[id];
    c.left -= 1;
    c.readyAt = this.tick + spec.cooldown * TICK_RATE;

    if (id === "charge") {
      // Given TO a company: it goes in at the run and hits far harder, at the
      // cost of its dressing while it does.
      const g = this.groupById(squad);
      if (!g) return;
      g.chargeUntil = this.tick + spec.duration * TICK_RATE;
      g.hasteUntil = this.tick + spec.duration * TICK_RATE;
      return;
    }

    if (id === "muster" || id === "forcedMarch") {
      const g = this.groupById(squad);
      if (!g || g.player !== player) return;
      const s = this.soldiers;
      for (const m of g.members) {
        if (s.alive[m] !== 1) continue;
        s.morale[m] = id === "muster"
          ? min(1, s.morale[m] + MUSTER_NERVE)
          : max(0, s.morale[m] - MARCH_FATIGUE);
      }
      if (id === "forcedMarch") g.hasteUntil = this.tick + spec.duration * TICK_RATE;
      return;
    }

    if (id === "levy") {
      // Militia turn out where you point, as a formed company. Nothing lingers
      // on the field afterwards -- what was spent is spent and what arrived is
      // simply men.
      const ids: number[] = [];
      for (let i = 0; i < LEVY_STRENGTH; i++) {
        // Pointing at a wall or a river turns the levy out beside it, not in it.
        const at = this.standingGround(x + (i % 4) * 14, y + ((i / 4) | 0) * 14);
        ids.push(this.spawnSoldier(player, "line", at.x, at.y, player === 0 ? 0 : PI));
      }
      if (ids.length > 0) this.createGroup(player, ids);
      return;
    }

    // Fire on the ground as well as on men: pitch thrown into a wood or onto
    // a stockade sets it alight, and a barrage's burst fires whatever timber
    // it lands on. What burns then spreads and burns out by fire.ts's rules.
    if (id === "firepots") igniteDisc(this.terrain, x, y, spec.radius * FIREPOT_IGNITE_SHARE, TILE_SIZE);
    else if (id === "barrage") igniteDisc(this.terrain, x, y, TILE_SIZE * 0.75, TILE_SIZE);

    this.fields.push({
      ability: id,
      player,
      x,
      y,
      radius: spec.radius,
      until: this.tick + spec.duration * TICK_RATE,
    });
  }

  /**
   * One tick of whatever the commander has put on the field.
   *
   * A barrage does not care whose men are underneath it. That is deliberate and
   * it is the whole reason it costs points: artillery fired from off the map by
   * somebody who cannot see the ground is exactly as dangerous to your own line
   * as to theirs, and a player who drops one on a melee has chosen to.
   */
  private applyFields(): void {
    if (this.fields.length === 0) return;
    const s = this.soldiers;
    for (let i = this.fields.length - 1; i >= 0; i--) {
      if (this.tick >= this.fields[i].until) this.fields.splice(i, 1);
    }
    for (const f of this.fields) {
      // Smoke and flare are about SIGHT and are read where sight is decided;
      // a shield is read where damage is. Only a barrage does anything to a man
      // just for standing there.
      if (f.ability !== "barrage" && f.ability !== "firepots") continue;
      const fire = f.ability === "firepots";
      if (!fire) this.batterUnder(f.x, f.y, f.radius);
      const rr = f.radius * f.radius;
      for (let i = 0; i < s.count; i++) {
        if (s.alive[i] !== 1) continue;
        if (fire && s.player[i] === f.player) continue;
        if (d2(f.x, f.y, s.x[i], s.y[i]) > rr) continue;
        s.incoming[i] += (fire ? FIRE_DAMAGE_PER_SEC : BARRAGE_DAMAGE_PER_SEC) * TICK_DT;
        s.struckBy[i] = -1;
        s.struckHow[i] = HOW_RANGED;
      }
    }
  }

  /** How much of its pace a company keeps on mired ground. 1 when clear. */
  private mireScale(g: Group): number {
    let worst = 1;
    for (const w of this.workings) {
      if (w.spell !== "mire" || w.player === g.player) continue;
      if (d2(w.x, w.y, g.anchorX, g.anchorY) > w.radius * w.radius) continue;
      worst = min(worst, SPELLS.mire.slow ?? 1);
    }
    return worst;
  }

  /** Is this point under a field of this kind -- one's own side's, or the enemy's? */
  private fieldAt(kind: AbilityId, player: number, x: number, y: number, enemy: boolean): boolean {
    for (const f of this.fields) {
      if (f.ability !== kind) continue;
      if (enemy ? f.player === player : f.player !== player) continue;
      if (d2(f.x, f.y, x, y) <= f.radius * f.radius) return true;
    }
    return false;
  }

  /** Is this spot under anyone's parley? A truce binds both sides. */
  private parleyAt(x: number, y: number): boolean {
    for (const f of this.fields) {
      if (f.ability !== "parley") continue;
      if (d2(f.x, f.y, x, y) <= f.radius * f.radius) return true;
    }
    return false;
  }

  /** Is this spot lit by one of `player`'s flares? */
  private flaredFor(player: number, x: number, y: number): boolean {
    for (const f of this.fields) {
      if (f.ability !== "flare" || f.player !== player) continue;
      if (d2(f.x, f.y, x, y) <= f.radius * f.radius) return true;
    }
    return false;
  }

  /**
   * Damage turned aside by anything standing over this man: a shield wall, or
   * his own side's works.
   */
  private shieldSoak(player: number, x: number, y: number): number {
    let best = 0;
    for (const f of this.fields) {
      if (f.player !== player) continue;
      if (f.ability !== "shield" && f.ability !== "bulwark") continue;
      if (d2(f.x, f.y, x, y) > f.radius * f.radius) continue;
      best = max(best, f.ability === "shield" ? SHIELD_SOAK : BULWARK_SOAK);
    }
    return best;
  }

  /** How much an attacker is hampered by assaulting somebody else's works. */
  private assaultPenalty(player: number, x: number, y: number): number {
    for (const f of this.fields) {
      if (f.ability !== "bulwark" || f.player === player) continue;
      if (d2(f.x, f.y, x, y) <= f.radius * f.radius) return BULWARK_ASSAULT_PENALTY;
    }
    return 0;
  }

  /** How much smoke is lying over this spot, 0 to 1. */
  smokeAt(x: number, y: number): number {
    let worst = 0;
    for (const f of this.fields) {
      if (f.ability !== "smoke") continue;
      if (d2(f.x, f.y, x, y) <= f.radius * f.radius) worst = max(worst, SMOKE_CONCEALMENT);
    }
    return worst;
  }

  // -- engineering --------------------------------------------------------------

  /**
   * Sappers digging in, and engines bringing walls down.
   *
   * Both halves of the spec's terrain manipulation, driven from one pass so the
   * two can never disagree about what is destructible. Note that until now the
   * `siege` flag on a unit was read by NOTHING: siege engines carried it, the
   * terrain had a full damage model, and no unit in the game could actually
   * knock anything over.
   *
   * Companies are walked in order and members are sorted, so the tile a company
   * works on is a pure function of hashed state.
   */
  /** Record how far along a piece of work is, for the picture. */
  private noteBuilding(tx: number, ty: number, player: number, progress: number): void {
    for (const b of this.building) {
      if (b.tx === tx && b.ty === ty && b.player === player) {
        b.progress = progress;
        return;
      }
    }
    this.building.push({ tx, ty, player, progress });
  }

  private updateEngineering(): void {
    const s = this.soldiers;
    // Rebuilt each tick from whoever is actually digging.
    this.building.length = 0;
    for (const g of this.groups) {
      let diggers = 0;
      let breakers = 0;
      for (const m of g.members) {
        if (s.alive[m] !== 1) continue;
        const spec = UNIT_TYPES[this.typeOf(m)];
        if (spec.builds) diggers++;
        if (spec.siege) breakers++;
      }

      // DIGGING IN. Only while holding ground and out of contact -- men cannot
      // entrench with someone standing over them, and tying it to the hold
      // order means the player decides where a field is fortified.
      if (
        diggers > 0 && g.stance === "hold" &&
        this.tick - g.lastContact > TICK_RATE * 3
      ) {
        const site = this.digSite(g);
        const tx = site.tx;
        const ty = site.ty;
        if (this.terrain.fortifiableAt(tx, ty)) {
          g.buildTicks += diggers * (this.hasSpecial(g, "entrench") ? ENTRENCH_SPEED : 1);
          this.noteBuilding(tx, ty, g.player, g.buildTicks / FORTIFY_WORK);
          if (g.buildTicks >= FORTIFY_WORK) {
            g.buildTicks = 0;
            if (this.terrain.fortify(tx, ty, g.player)) {
              // What it becomes depends on what it joins onto: a lone hole is a
              // redoubt, one that continues a line is wall, and one that ties
              // several together is a battlement worth standing on.
              const touching = this.worksTouching(tx, ty, g.player);
              const kind = touching >= 2 ? "battlement" : touching === 1 ? "wall" : "redoubt";
              this.works.push({ tx, ty, player: g.player, kind, builtAt: this.tick });
              // The works are more than cover in the terrain: they belong to
              // whoever dug them. Men fighting from behind their own stakes are
              // steadier and harder to shift, and men assaulting them fight at
              // a disadvantage -- which is the whole reason to spend a company
              // on digging instead of on fighting.
              this.fields.push({
                ability: "bulwark",
                player: g.player,
                x: (tx + 0.5) * TILE_SIZE,
                y: (ty + 0.5) * TILE_SIZE,
                radius: BULWARK_RADIUS,
                until: this.tick + BULWARK_SECONDS * TICK_RATE,
              });
            }
          }
        } else {
          g.buildTicks = 0;
          // Nothing here can be dug: a wood to fell or a bridge to cut, then.
          const clear = this.clearSite(g);
          if (clear >= 0) {
            this.terrain.damage(clear % this.terrain.width, (clear / this.terrain.width) | 0,
              diggers * SAP_PER_SAPPER);
          }
        }
      } else {
        g.buildTicks = 0;
      }

      // BREAKING DOWN. Engines and sappers on the march or the attack turn on
      // the enemy works in front of them: a wall they cannot get past, a gate,
      // a palisade, an enemy fieldwork. Never their own side's. Engines reach
      // as far as they shoot; sappers only what they can put a pick to.
      if (breakers > 0 && (g.stance === "attack" || g.stance === "move")) {
        let engines = 0;
        let reach = SAP_REACH;
        for (const m of g.members) {
          if (s.alive[m] !== 1 || !UNIT_TYPES[this.typeOf(m)].siege) continue;
          if (UNIT_TYPES[this.typeOf(m)].builds) continue;
          engines++;
          reach = max(reach, this.stats(m).range);
        }
        const sappers = breakers - engines;
        const target = this.nearestWorks(g.anchorX, g.anchorY, reach, g.player);
        if (target >= 0) {
          const tx = target % this.terrain.width;
          const ty = (target / this.terrain.width) | 0;
          // Sappers only count when the work is within their own short reach.
          const near = d2(g.anchorX, g.anchorY, (tx + 0.5) * TILE_SIZE, (ty + 0.5) * TILE_SIZE) <=
            SAP_REACH * SAP_REACH;
          this.terrain.damage(tx, ty, engines * BATTER_PER_ENGINE + (near ? sappers * SAP_PER_SAPPER : 0));
        }
      }
    }
  }

  /**
   * Sappers holding ground that cannot be dug work it the other way: a wood is
   * felled, a bridge is broken. Bridges first -- a crossing denied is worth
   * more than a sightline -- then woods, nearest first, ties on tile index.
   * Only tiles inside the ring they were told to hold, and within a pick's
   * reach of where they stand, and never the tile under their own feet.
   */
  private clearSite(g: Group): number {
    const t = this.terrain;
    const cx = (g.anchorX / TILE_SIZE) | 0;
    const cy = (g.anchorY / TILE_SIZE) | 0;
    const span = (SAP_REACH / TILE_SIZE) | 0;
    let best = -1;
    let bestRank = 9;
    let bestD = Infinity;
    for (let ty = cy - span; ty <= cy + span; ty++) {
      for (let tx = cx - span; tx <= cx + span; tx++) {
        if (tx === cx && ty === cy) continue;
        const type = t.typeAt(tx, ty);
        const rank = type === Terrain.Bridge ? 0 : type === Terrain.Forest ? 1 : 9;
        if (rank === 9 || !t.inBounds(tx, ty)) continue;
        const wx = (tx + 0.5) * TILE_SIZE;
        const wy = (ty + 0.5) * TILE_SIZE;
        if (d2(g.holdX, g.holdY, wx, wy) > g.holdRadius * g.holdRadius) continue;
        const dd = d2(g.anchorX, g.anchorY, wx, wy);
        if (dd > SAP_REACH * SAP_REACH) continue;
        if (rank < bestRank || (rank === bestRank && dd < bestD)) {
          bestRank = rank;
          bestD = dd;
          best = ty * t.width + tx;
        }
      }
    }
    return best;
  }

  /**
   * The nearest enemy work worth knocking down, by tile index, or -1.
   *
   * Gates OUTRANK walls: the gate is the weak point of any circuit, a third of
   * the stone's strength, and an engine in reach of one has no business
   * pounding the curtain beside it. Woods and bridges are not works -- an
   * engine battering every tree and bridge it marched past demolished the
   * very crossings its own army needed; those are sappers' work, done on a
   * hold order (see clearSite). The tile the company stands on is never a
   * target. Ties break on the lower tile index so two peers pick the same.
   */
  private nearestWorks(x: number, y: number, reach: number, player: number): number {
    const cx = (x / TILE_SIZE) | 0;
    const cy = (y / TILE_SIZE) | 0;
    const span = max(1, (reach / TILE_SIZE) | 0);
    let best = -1;
    let bestD = reach * reach;
    let bestRank = 9;
    for (let ty = cy - span; ty <= cy + span; ty++) {
      for (let tx = cx - span; tx <= cx + span; tx++) {
        if (tx === cx && ty === cy) continue;
        const type = this.terrain.typeAt(tx, ty);
        if (!isWork(type) || !this.terrain.inBounds(tx, ty)) continue;
        if (this.terrain.ownerAt(tx, ty) === player) continue;
        const rank = isGate(type) ? 0 : 1;
        const wx = (tx + 0.5) * TILE_SIZE;
        const wy = (ty + 0.5) * TILE_SIZE;
        const dd = d2(x, y, wx, wy);
        if (dd >= reach * reach) continue;
        if (rank < bestRank || (rank === bestRank && dd < bestD)) {
          bestRank = rank;
          bestD = dd;
          best = ty * this.terrain.width + tx;
        }
      }
    }
    return best;
  }

  /** A barrage wears down every work and bridge it falls on, whoever's. */
  private batterUnder(x: number, y: number, radius: number): void {
    const t = this.terrain;
    const r = (radius / TILE_SIZE) | 0;
    const cx = (x / TILE_SIZE) | 0;
    const cy = (y / TILE_SIZE) | 0;
    const amount = BARRAGE_WORKS_PER_SEC * TICK_DT;
    for (let ty = cy - r; ty <= cy + r; ty++) {
      for (let tx = cx - r; tx <= cx + r; tx++) {
        const type = t.typeAt(tx, ty);
        if (!isWork(type) && type !== Terrain.Bridge) continue;
        if (d2(x, y, (tx + 0.5) * TILE_SIZE, (ty + 0.5) * TILE_SIZE) > radius * radius) continue;
        t.damage(tx, ty, amount);
      }
    }
  }

  // -- fire and falling ground -------------------------------------------------

  /**
   * One tick of fire: step the fires (spread, burn out -- fire.ts), then burn
   * whoever is standing in them. Both sides: a burning wood does not ask whose
   * firepots lit it. Skipped outright on a field with nothing alight.
   */
  private updateFire(): void {
    const t = this.terrain;
    if (t.burning.length === 0) return;
    stepFire(t, this.tick, this.seed);
    const s = this.soldiers;
    const hurt = FIRE_TILE_DPS * TICK_DT;
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] !== 1) continue;
      const tx = floor(s.x[i] / TILE_SIZE);
      const ty = floor(s.y[i] / TILE_SIZE);
      if (!t.burningAt(tx, ty)) continue;
      s.incoming[i] += hurt;
      s.struckBy[i] = -1;
      s.struckHow[i] = HOW_RANGED;
    }
  }

  /**
   * Settle every tile that changed type since the last settling.
   *
   * Changing the ground under men invalidates three things, and this is where
   * the first is handled (the other two read the terrain's own revisions):
   *
   *   1. ANYONE STANDING ON GROUND THAT HAS JUST BECOME IMPASSABLE -- a span
   *      that fell into the river, a bridge the flood took -- is put on the
   *      nearest standing ground at once (standingGround: closest point of the
   *      closest passable tile, ties to the lower tile index) and loses
   *      FALL_SHOCK of nerve. Nobody drowns and nobody wades: no man ends a
   *      tick on water. A company's anchor caught the same way is moved the
   *      same way. Walls are only ever raised before anyone is on the field,
   *      so nobody can be caught inside one.
   *   2. Routes: revalidateRoutes, on the next updateGroups, compares each
   *      company's pathRevision against terrain.openedAt / closedAt.
   *   3. Sight: updateVision sweeps at once when terrain.sightAt has moved.
   *
   * Fieldworks that fell are struck off the works list, so nobody goes on
   * counting a heap of rubble as a redoubt to hold.
   */
  private settleTerrain(): void {
    const changed = this.terrain.drainChanges();
    if (changed.length === 0) return;
    const t = this.terrain;
    const lost = new Set<number>();
    for (const i of changed) {
      if (TERRAIN_INFO[t.type[i] as TerrainType].moveScale <= 0) lost.add(i);
    }
    if (lost.size > 0) {
      const s = this.soldiers;
      for (let i = 0; i < s.count; i++) {
        if (s.alive[i] !== 1) continue;
        const tile = floor(s.y[i] / TILE_SIZE) * t.width + floor(s.x[i] / TILE_SIZE);
        if (!lost.has(tile)) continue;
        const at = this.standingGround(s.x[i], s.y[i]);
        s.x[i] = at.x;
        s.y[i] = at.y;
        s.morale[i] = max(0, s.morale[i] - FALL_SHOCK);
      }
      for (const g of this.groups) {
        const tile = floor(g.anchorY / TILE_SIZE) * t.width + floor(g.anchorX / TILE_SIZE);
        if (!lost.has(tile)) continue;
        const at = this.standingGround(g.anchorX, g.anchorY);
        g.anchorX = at.x;
        g.anchorY = at.y;
      }
    }
    for (let k = this.works.length - 1; k >= 0; k--) {
      const w = this.works[k];
      if (t.typeAt(w.tx, w.ty) !== Terrain.Fortification) this.works.splice(k, 1);
    }
  }

  /**
   * The nearest point a man can stand on, from (x, y): the point itself if the
   * ground there holds, otherwise the closest point (a margin inside the tile
   * edge) of the closest passable tile within EVICT_SEARCH tiles. Ties go to
   * the lower tile index, so it is a pure function of the grid. Left where it
   * is if nothing within reach can be stood on, which no generated or siege
   * field produces.
   */
  standingGround(x: number, y: number): { x: number; y: number } {
    const t = this.terrain;
    const tx0 = floor(x / TILE_SIZE);
    const ty0 = floor(y / TILE_SIZE);
    if (t.passableAt(tx0, ty0)) return { x, y };
    const margin = 2;
    let bestD = Infinity;
    let bx = x;
    let by = y;
    for (let ty = ty0 - EVICT_SEARCH; ty <= ty0 + EVICT_SEARCH; ty++) {
      for (let tx = tx0 - EVICT_SEARCH; tx <= tx0 + EVICT_SEARCH; tx++) {
        if (!t.inBounds(tx, ty) || !t.passableAt(tx, ty)) continue;
        const px = clamp(x, tx * TILE_SIZE + margin, (tx + 1) * TILE_SIZE - margin);
        const py = clamp(y, ty * TILE_SIZE + margin, (ty + 1) * TILE_SIZE - margin);
        const dd = d2(x, y, px, py);
        // Scanned in ascending tile order, so strict < keeps the lower index.
        if (dd < bestD) {
          bestD = dd;
          bx = px;
          by = py;
        }
      }
    }
    return { x: bx, y: by };
  }

  // -- morale -------------------------------------------------------------------

  /**
   * Nerve is per soldier now. A man alone feels only his own circumstances; a
   * man in a group feels its losses and its victories too, which is most of
   * what a group is for.
   */
  private updateMorale(): void {
    const s = this.soldiers;
    // NOT named `window`: this file must never touch browser globals, and a
    // local shadowing one defeats the grep that audits exactly that.
    const contactWindow = TICK_RATE * 3;

    for (let id = 0; id < s.count; id++) {
      if (s.alive[id] !== 1) continue;
      const g = this.groupOf(id);
      const inContact = g ? this.tick - g.lastContact < contactWindow : false;

      let friends = 0;
      let foes = 0;
      if (inContact) {
        const n = this.hash.query(s.x[id], s.y[id], 90, this.neighbours);
        for (let k = 0; k < n; k++) {
          const other = this.neighbours[k];
          if (s.alive[other] !== 1) continue;
          if (s.player[other] === s.player[id]) friends++;
          else foes++;
        }
      }

      s.morale[id] = nextMorale(s.morale[id], {
        resolve: this.stats(id).resolve,
        // A company feels its own losses; a man alone feels the ones he can see.
        casualties: g ? g.casualtiesThisTick : s.localShock[id],
        flankCasualties: g ? g.flankCasualtiesThisTick : 0,
        kills: g ? g.killsThisTick : 0,
        strength: 1,
        // A lone man has no roster to measure losses against, so they are
        // measured against the handful of men around him -- which is why
        // standing in a leaderless crowd is so much worse for the nerve.
        roster: g ? max(1, g.members.length) : LOOSE_ROSTER,
        flanked: g ? g.flanked : false,
        outnumbered: foes > friends * 1.5 && foes > 0,
        inContact,
        cover: TERRAIN_INFO[this.terrain.typeAtWorld(s.x[id], s.y[id])].cover,
        dt: TICK_DT,
      });

      if (this.fields.length > 0 &&
        this.fieldAt("beacon", s.player[id], s.x[id], s.y[id], false)) {
        s.morale[id] = min(1, s.morale[id] + BEACON_GAIN * TICK_DT);
      }
      // Auras and oaths. Skipped entirely in a battle with none of them.
      if (this.auras.length > 0) {
        if (this.auraAt("rally", s.player[id], s.x[id], s.y[id], RALLY_RADIUS, false)) {
          s.morale[id] = min(1, s.morale[id] + RALLY_GAIN * TICK_DT);
        }
        if (this.auraAt("terror", s.player[id], s.x[id], s.y[id], TERROR_RADIUS, true)) {
          const t = this.typeOf(id);
          const horse = t === "horse" || t === "lancer" || t === "scout";
          s.morale[id] = max(0, s.morale[id] - TERROR_DRAIN * TICK_DT * (horse ? TERROR_HORSE : 1));
        }
      }
      if (g && g.specialUntil > this.tick && this.hasSpecial(g, "lastStand")) {
        s.morale[id] = max(s.morale[id], LAST_STAND_FLOOR);
      }
    }

    this.recordBreakages();
  }

  /**
   * Note the moment a company's nerve gives, and what did it.
   *
   * Recorded once per company -- brokeAt guards it -- so the report reads as a
   * short history of the battle rather than a stream of the same line. The
   * cause is attributed from how that company had been losing men up to this
   * point, which is the thing the player can actually learn from: a company
   * that broke having taken most of its losses from the flank was outmanoeuvred,
   * not merely unlucky.
   */
  private recordBreakages(): void {
    const s = this.soldiers;
    for (const g of this.groups) {
      if (g.brokeAt >= 0) continue;
      let living = 0;
      let nerve = 0;
      for (const m of g.members) {
        if (s.alive[m] !== 1) continue;
        nerve += s.morale[m];
        living++;
      }
      if (living === 0 || nerve / living >= COMPANY_BREAK) continue;
      g.brokeAt = this.tick;
      const cause =
        g.flankLosses * 2 >= g.losses && g.losses > 0 ? "flanked"
          : g.losses >= max(1, (g.losses + living) / 2) ? "cut to pieces"
            : "worn down";
      this.breakages.push({ name: g.name, player: g.player, tick: this.tick, cause, group: g.id });
    }
  }
}

/** World-space position of a group's formation slot. */
export function slotWorldX(g: Group, slot: number): number {
  return g.anchorX + g.slots[slot * 2] * cos(g.facing) - g.slots[slot * 2 + 1] * sin(g.facing);
}

export function slotWorldY(g: Group, slot: number): number {
  return g.anchorY + g.slots[slot * 2] * sin(g.facing) + g.slots[slot * 2 + 1] * cos(g.facing);
}

/** Shaken troops move sluggishly. Full morale is 1, broken is 0. */
function moraleSpeedScale(morale: number): number {
  return 0.55 + 0.45 * clamp(morale, 0, 1);
}
