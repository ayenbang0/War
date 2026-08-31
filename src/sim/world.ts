/**
 * The world: all simulation state, and the single tick function that advances it.
 *
 * Invariants (see CLAUDE.md):
 *   - No DOM, no canvas, no browser globals. Runs headless under node.
 *   - No wall-clock time. tick is the only clock.
 *   - Mutated exclusively by step(), exclusively at tick boundaries.
 *
 * MOVEMENT IS THREE LAYERS, and they are never conflated:
 *   1. The squad anchor walks a coarse route from pathfind.ts.
 *   2. Each soldier is assigned a slot in the formation template, which the
 *      anchor and facing project into world space.
 *   3. Each soldier steers toward its own slot, pushing off neighbours.
 * Collapsing any two of these is the standard way formation movement turns to
 * mush: soldiers either clump into a single point or smear along the route.
 */

import { atan2, clamp, cos, dist, floor, max, min, rotateToward, sin, sqrt, TAU } from "./math.ts";
import { Rng, Stream } from "./rng.ts";
import { OrderQueue, type Order } from "./orders.ts";
import { generateTerrain, Terrain, TerrainGrid, TERRAIN_INFO, TILE_SIZE } from "./terrain.ts";
import { formationSlots, formationRadius, type FormationShape } from "./formations.ts";
import { advanceToward } from "./movement.ts";
import { SpatialHash } from "./spatial.ts";
import { clearLine, findPath } from "./pathfind.ts";
import { UNIT_TYPES, type UnitTypeId } from "../content/unit-types.ts";
import { DOCTRINES, type DoctrineId } from "../content/doctrines.ts";
import { MELEE_RANGE, d2, hitDamage, isFlanking, nearestInSquad, spreadTarget } from "./combat.ts";
import { globalMorale, nextMorale, ROUT_THRESHOLD } from "./morale.ts";
import { evaluate, type ArmyState, type Outcome } from "./victory.ts";
import { FogField, concealment, effectiveSight, hasLineOfSight, rangeFromHeight } from "./vision.ts";
import { ArmyAI } from "./ai.ts";
import { SPELLS, hexPenalty, mendRate, nerveShift, wardSoak, type Working } from "./magic.ts";

/** Simulation ticks per second. Slow, deliberate pacing needs no more than this. */
export const TICK_RATE = 20;
/** Seconds of simulated time per tick. */
export const TICK_DT = 1 / TICK_RATE;

/**
 * Soldiers push apart inside this radius.
 *
 * It MUST stay below the tightest rank spacing any formation produces, which is
 * the tight shape at BASE_SPACING * 0.72 * RANK_SCALE ~= 7.7. If separation
 * reaches further than neighbours actually stand, a settled formation shoves
 * itself apart forever and never reaches equilibrium with the slot pull -- the
 * squad looks permanently ragged even standing still.
 */
const SEPARATION_RADIUS = 7;
/** How hard separation competes with the pull toward the assigned slot. */
const SEPARATION_WEIGHT = 1.35;
/**
 * Headroom soldiers get over squad speed. A marching soldier settles at a
 * steady-state lag of (arrival easing distance / CATCHUP) behind its slot, so
 * this directly sets how tidy a column looks in motion.
 */
const CATCHUP = 2.6;
/** Within this distance a soldier counts as standing in its slot. */
const IN_SLOT = 7;
/** Speed multiplier for a squad extracting itself from impassable ground. */
const STRANDED_WADE = 0.35;
/** Morale regained per second while recovering. Roughly 17s from broken to full. */
const RECOVER_MORALE_PER_SEC = 0.06;
/** Fraction of a soldier's maximum hit points healed per second while recovering. */
const RECOVER_HP_FRACTION_PER_SEC = 0.04;
/**
 * Recovery is a commitment, not a free heal: the squad is locked for this long
 * and will not accept any order, including another recover. That is the whole
 * cost of the gesture -- a squad standing down is a squad that cannot react,
 * so calling it in the wrong place should lose you the squad.
 */
export const RECOVER_LOCK_SECONDS = 30;

/**
 * A squad's effective stats, doctrine already applied.
 *
 * Baked at spawn rather than looked up in the hot loops. Combat reads these
 * thousands of times a tick and a doctrine cannot change mid-match, so folding
 * the multipliers in every time would be pure cost for an answer that never
 * changes.
 */
export type SquadStats = {
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
};

export function statsFor(type: UnitTypeId, doctrine: DoctrineId): SquadStats {
  const u = UNIT_TYPES[type];
  const d = DOCTRINES[doctrine];
  return {
    hp: u.hp * d.hp,
    speed: u.speed * d.speed,
    turnRate: u.turnRate * d.turnRate,
    attack: u.attack * d.attack,
    defence: u.defence * d.defence,
    range: u.range,
    attackInterval: u.attackInterval,
    sight: u.sight * d.sight,
    resolve: d.resolve,
    magic: d.magic,
  };
}

export type Stance = "idle" | "move" | "attack" | "hold" | "retreat" | "patrol" | "recover";

/** A blow struck this tick, for the renderer to animate. Never read by the sim. */
export type CombatEvent = {
  /** "shot" flies as a projectile; "melee" is a lunge in place. */
  readonly kind: "shot" | "melee";
  readonly player: number;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  /** True when the blow was fatal, so the renderer can mark the fall. */
  lethal: boolean;
  /** Index of the struck soldier, used only to resolve lethality. */
  readonly victim: number;
};

/**
 * Fixed order, so a stance can be hashed as a stable index. Append only --
 * reordering would silently invalidate every recorded replay and golden.
 */
export const STANCES: readonly Stance[] = [
  "idle", "move", "attack", "hold", "retreat", "patrol", "recover",
];

export type Squad = {
  readonly id: number;
  readonly player: number;
  readonly type: UnitTypeId;
  /** Doctrine-adjusted stats, fixed at spawn. */
  readonly stats: SquadStats;
  /** Formation centre. Soldiers orbit this, they do not define it. */
  anchorX: number;
  anchorY: number;
  /** Radians; 0 points along +x. */
  facing: number;
  shape: FormationShape;
  /** Local-space slot offsets, 2 entries per soldier. */
  slots: Float64Array;
  /** Radius of the slot cloud, for hit-testing and spacing. */
  radius: number;
  /** First index into the soldier store, and how many belong to this squad. */
  readonly first: number;
  readonly count: number;
  /** Remaining route as flat [x0, y0, ...]. Empty when standing. */
  path: number[];
  stance: Stance;
  /** Squad id being attacked, or -1. */
  target: number;
  holdX: number;
  holdY: number;
  holdRadius: number;
  /** Patrol circuit and which leg is being walked. */
  patrol: number[];
  patrolLeg: number;
  patrolForward: boolean;
  /** 0..1. Phase 3 makes this move; for now it only scales speed. */
  morale: number;
  /** 0..1 fraction of soldiers standing in their slots. */
  cohesion: number;
  /** Tick at which a recovery lock lifts. 0 when the squad is free to act. */
  recoverUntil: number;
  /** Tick at which this squad may work its spell again. */
  spellReady: number;
  /** Terrain revision the current route was planned against. */
  pathRevision: number;
  /** Living soldiers. Formation slots are re-derived from this as men fall. */
  live: number;
  /** Whether each player can currently see this squad, indexed by player. */
  seenBy: [boolean, boolean];
  /** Enemies this squad has killed, and its own dead. */
  kills: number;
  losses: number;
  /** Dead this tick and kills this tick, consumed by the morale pass. */
  casualtiesThisTick: number;
  killsThisTick: number;
  /** Tick of the last blow given or taken, for the in-contact test. */
  lastContact: number;
  flanked: boolean;
};

/**
 * Soldiers live in parallel typed arrays rather than objects. At ~600 agents
 * queried every tick for neighbours, struct-of-arrays keeps the hot loops
 * cache-friendly and avoids 600 object headers.
 */
export class SoldierStore {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly facing: Float64Array;
  readonly hp: Float64Array;
  readonly squad: Int32Array;
  /** Which formation slot this soldier is assigned to. */
  readonly slot: Int32Array;
  readonly alive: Uint8Array;
  /** Seconds until this soldier may strike again. */
  readonly cooldown: Float64Array;
  /** Damage accumulated this tick, applied only once every attack is resolved. */
  readonly incoming: Float64Array;
  /** Index into World.squads of whoever last landed a blow, for kill credit. */
  readonly struckBy: Int32Array;
  count = 0;

  constructor(capacity: number) {
    this.x = new Float64Array(capacity);
    this.y = new Float64Array(capacity);
    this.facing = new Float64Array(capacity);
    this.hp = new Float64Array(capacity);
    this.squad = new Int32Array(capacity);
    this.slot = new Int32Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.cooldown = new Float64Array(capacity);
    this.incoming = new Float64Array(capacity);
    this.struckBy = new Int32Array(capacity).fill(-1);
  }
}

export type WorldConfig = {
  readonly seed: number;
  readonly tilesWide: number;
  readonly tilesHigh: number;
  /** Soldier capacity. 15 squads x 20 soldiers x 2 sides needs 600. */
  readonly soldierCapacity?: number;
  /** Match length in seconds. Defaults to the spec's 15 minutes. */
  readonly duration?: number;
  /** Player numbers to be run by the AI. Defaults to none. */
  readonly aiPlayers?: readonly number[];
};

export class World {
  tick = 0;
  readonly seed: number;
  readonly terrain: TerrainGrid;
  readonly orders = new OrderQueue();
  readonly squads: Squad[] = [];
  readonly soldiers: SoldierStore;
  /** Match length in seconds. */
  readonly duration: number;
  /** Set once the match is decided; the world then stops advancing. */
  outcome: Outcome | null = null;
  /**
   * While true the world accepts placement but does not advance: the
   * deployment phase (spec section 3.3). Orders and combat wait for the off.
   */
  deploying = false;

  /**
   * Presentation-only output channel, cleared at the start of every tick.
   *
   * The simulation writes blows here and never reads them back, so this is an
   * OUTPUT, not state: it cannot influence a later tick and is deliberately
   * absent from hashWorld. Without it the renderer would have to infer that an
   * arrow was loosed by watching cooldowns, and would still have no idea what
   * it was aimed at.
   */
  readonly events: CombatEvent[] = [];

  /** One independent stream per subsystem -- see rng.ts for why. */
  readonly rng: {
    readonly combat: Rng;
    readonly morale: Rng;
    readonly ai: Rng;
    readonly spawn: Rng;
  };

  private readonly hash: SpatialHash;
  /** soldier index -> index into squads. Scanning squads per blow is O(n^2). */
  private readonly ownerOf: Int32Array;
  /** Coarse lit/remembered grid per army, for drawing fog. */
  readonly fog: [FogField, FogField];
  /** Commanders the machine is running. Empty in a pure sandbox. */
  readonly ai: ArmyAI[] = [];
  /** Workings currently standing on the field. */
  readonly workings: Working[] = [];
  private readonly neighbours: Int32Array;
  private nextEntityId = 1;

  constructor(config: WorldConfig) {
    this.seed = config.seed | 0;
    this.duration = config.duration ?? 15 * 60;
    this.terrain = generateTerrain(config.tilesWide, config.tilesHigh, this.seed);
    const capacity = config.soldierCapacity ?? 1024;
    this.soldiers = new SoldierStore(capacity);
    this.hash = new SpatialHash(
      this.terrain.worldWidth,
      this.terrain.worldHeight,
      SEPARATION_RADIUS * 2,
      capacity,
    );
    this.neighbours = new Int32Array(256);
    this.ownerOf = new Int32Array(capacity).fill(-1);
    this.fog = [new FogField(this.terrain), new FogField(this.terrain)];
    for (const p of config.aiPlayers ?? []) this.ai.push(new ArmyAI(p));
    this.rng = {
      combat: Rng.create(this.seed, Stream.Combat),
      morale: Rng.create(this.seed, Stream.Morale),
      ai: Rng.create(this.seed, Stream.Ai),
      spawn: Rng.create(this.seed, Stream.Spawn),
    };
  }

  /** Create a squad at full strength, its soldiers already standing in formation. */
  /** Doctrine per player, chosen before deployment. */
  readonly doctrine: [DoctrineId, DoctrineId] = ["maneuver", "maneuver"];

  spawnSquad(player: number, type: UnitTypeId, x: number, y: number, facing: number): Squad {
    const spec = UNIT_TYPES[type];
    const stats = statsFor(type, this.doctrine[player]);
    const s = this.soldiers;
    const first = s.count;
    const count = spec.soldiers;
    // Writing past a Float64Array is a silent no-op rather than a throw, so an
    // over-large army would quietly produce squads whose soldiers all sit at
    // (0, 0) with no error anywhere. Fail loudly instead.
    if (first + count > s.x.length) {
      throw new Error(
        "soldier capacity exceeded: " + (first + count) + " > " + s.x.length +
          " (raise soldierCapacity)",
      );
    }

    const squad: Squad = {
      id: this.nextEntityId++,
      player,
      type,
      stats,
      anchorX: x,
      anchorY: y,
      facing,
      shape: spec.defaultShape,
      slots: new Float64Array(count * 2),
      radius: 0,
      first,
      count,
      path: [],
      stance: "idle",
      target: -1,
      holdX: x,
      holdY: y,
      holdRadius: 0,
      patrol: [],
      patrolLeg: 0,
      patrolForward: true,
      morale: 1,
      cohesion: 1,
      recoverUntil: 0,
      spellReady: 0,
      pathRevision: 0,
      live: count,
      seenBy: [player === 0, player === 1],
      kills: 0,
      losses: 0,
      casualtiesThisTick: 0,
      killsThisTick: 0,
      lastContact: -9999,
      flanked: false,
    };
    formationSlots(squad.shape, count, squad.slots);
    squad.radius = formationRadius(squad.slots, count);

    for (let i = 0; i < count; i++) {
      const id = first + i;
      s.squad[id] = squad.id;
      s.slot[id] = i;
      s.hp[id] = stats.hp;
      s.alive[id] = 1;
      s.cooldown[id] = 0;
      s.incoming[id] = 0;
      s.facing[id] = facing;
      const wx = slotWorldX(squad, i);
      const wy = slotWorldY(squad, i);
      s.x[id] = wx;
      s.y[id] = wy;
    }
    s.count += count;
    const index = this.squads.length;
    for (let i = 0; i < count; i++) this.ownerOf[first + i] = index;
    this.squads.push(squad);
    return squad;
  }

  squadById(id: number): Squad | undefined {
    for (const q of this.squads) if (q.id === id) return q;
    return undefined;
  }

  /** Living soldiers in a squad. */
  strengthOf(squad: Squad): number {
    return squad.live;
  }

  /** Strength-weighted morale for one army. */
  armyMorale(player: number): number {
    const m: number[] = [];
    const w: number[] = [];
    for (const q of this.squads) {
      if (q.player !== player) continue;
      m.push(q.morale);
      // Roster, not live count -- see globalMorale for why the dead must stay
      // on the books.
      w.push(q.count);
    }
    return globalMorale(m, w);
  }

  armyState(player: number): ArmyState {
    let strength = 0;
    let roster = 0;
    for (const q of this.squads) {
      if (q.player !== player) continue;
      strength += q.live;
      roster += q.count;
    }
    return { morale: this.armyMorale(player), strength, roster };
  }

  /** Advance exactly one tick. The only mutator of world state. */
  step(): void {
    if (this.outcome) return; // the match is decided; freeze the board
    if (this.deploying) return; // still setting out; the match has not begun
    // The AI thinks first and issues into the same queue the player uses, so
    // its orders are drained by the very next line like anyone else's.
    for (const ai of this.ai) ai.update(this);
    this.applyOrders();
    this.updateSquadAnchors();
    this.rebuildHash();
    this.updateSoldiers();
    this.updateVision();
    this.castSpells();
    this.resolveCombat();
    this.applyWorkings();
    this.updateMorale();
    this.tick++;
    this.checkVictory();
  }

  private checkVictory(): void {
    this.outcome = evaluate(
      [this.armyState(0), this.armyState(1)],
      this.tick / TICK_RATE,
      this.duration,
    );
  }

  private applyOrders(): void {
    for (const order of this.orders.drain(this.tick)) this.applyOrder(order);
  }

  private applyOrder(order: Order): void {
    const q = this.squadById(order.squad);
    if (!q) return;
    // A recovering squad has stood down and is not taking orders. Enforced here
    // rather than in the UI so it holds for the AI and for replayed order logs
    // too -- the lock is a rule of the simulation, not a disabled button.
    if (q.recoverUntil > this.tick) return;
    switch (order.kind) {
      case "move":
        q.stance = "move";
        q.target = -1;
        q.path = this.routeThrough(q, order.path);
        return;
      case "attack":
        q.stance = "attack";
        q.target = order.target;
        q.path = this.routeThrough(q, order.path);
        return;
      case "retreat":
        q.stance = "retreat";
        q.target = -1;
        q.path = this.routeThrough(q, order.path);
        return;
      case "hold":
        q.stance = "hold";
        q.target = -1;
        q.holdX = order.x;
        q.holdY = order.y;
        q.holdRadius = order.radius;
        q.path = this.routeThrough(q, [order.x, order.y]);
        return;
      case "patrol":
        q.stance = "patrol";
        q.target = -1;
        q.patrol = order.path.slice();
        q.patrolLeg = 0;
        q.patrolForward = true;
        q.path = this.legRoute(q);
        return;
      case "formation":
        this.reshape(q, order.shape);
        return;
      case "recover":
        // Halt where you stand, close ranks, and get your breath back.
        q.stance = "recover";
        q.target = -1;
        q.path.length = 0;
        q.recoverUntil = this.tick + RECOVER_LOCK_SECONDS * TICK_RATE;
        return;
    }
  }

  /**
   * Turn a drawn route into a walkable one. The player draws intent, not a
   * traversable path -- a stroke crosses rivers and cliffs freely -- so every
   * leg is re-routed by A* and the results concatenated.
   */
  private routeThrough(q: Squad, waypoints: readonly number[]): number[] {
    q.pathRevision = this.terrain.revision;
    if (waypoints.length < 2) return [];
    const out: number[] = [];
    let cx = q.anchorX;
    let cy = q.anchorY;
    for (let i = 0; i + 1 < waypoints.length; i += 2) {
      const leg = findPath(this.terrain, cx, cy, waypoints[i], waypoints[i + 1]);
      if (leg.length === 0) break;
      for (const v of leg) out.push(v);
      cx = leg[leg.length - 2];
      cy = leg[leg.length - 1];
    }
    return out;
  }

  /** Re-form into a new shape, keeping soldiers near the slots they already hold. */
  private reshape(q: Squad, shape: FormationShape): void {
    q.shape = shape;
    this.reflow(q);
  }

  /**
   * Greedy nearest-slot assignment. Without it a re-form makes every soldier
   * walk to the slot with its own index, which crosses the whole formation
   * through itself. Iterating slots in index order and breaking ties on soldier
   * index keeps it deterministic.
   */
  private assignSlots(q: Squad): void {
    const s = this.soldiers;
    const taken = new Uint8Array(q.count);
    // Only as many slots as there are men left standing.
    for (let slot = 0; slot < q.live; slot++) {
      const wx = slotWorldX(q, slot);
      const wy = slotWorldY(q, slot);
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < q.count; i++) {
        if (taken[i] === 1) continue;
        const id = q.first + i;
        if (s.alive[id] !== 1) continue;
        const d = dist(s.x[id], s.y[id], wx, wy);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best < 0) continue;
      taken[best] = 1;
      s.slot[q.first + best] = slot;
    }
  }

  // -- layer 1: the squad anchor walks its route ------------------------------

  private updateSquadAnchors(): void {
    this.revalidateRoutes();
    for (const q of this.squads) {
      if (q.stance === "recover") {
        this.recover(q);
        continue;
      }
      if (q.stance === "idle") continue;

      if (q.path.length < 2) {
        if (q.stance === "patrol") {
          this.advancePatrolLeg(q);
          q.path = this.legRoute(q);
        } else if (q.stance === "move" || q.stance === "retreat") {
          q.stance = "idle";
        }
        if (q.path.length < 2) continue;
      }

      const speed = this.squadSpeed(q);
      if (speed <= 0) {
        q.path.length = 0;
        continue;
      }

      // Pivot toward the next waypoint. A formation turns, it does not strafe.
      const desired = atan2(q.path[1] - q.anchorY, q.path[0] - q.anchorX);
      q.facing = rotateToward(q.facing, desired, q.stats.turnRate * TICK_DT);

      let budget = speed * TICK_DT;
      while (budget > 1e-9 && q.path.length >= 2) {
        const r = advanceToward(this.terrain, q.anchorX, q.anchorY, q.path[0], q.path[1], budget);
        q.anchorX = r.x;
        q.anchorY = r.y;
        budget -= r.travelled;
        if (r.blocked) {
          // The route is stale -- terrain changed, or it was never walkable.
          // Drop it rather than grinding against the obstacle forever.
          q.path.length = 0;
          break;
        }
        if (!r.reached) break;
        q.path.splice(0, 2);
        if (r.travelled <= 1e-9 && q.path.length >= 2) break; // no progress; wait a tick
      }

      q.facing = ((q.facing % TAU) + TAU) % TAU;
    }
  }

  /**
   * Rally and heal. The squad stands, re-forms (its soldiers are already
   * pulling toward their slots every tick), and regains morale and hit points.
   * It holds this stance until given another order, so a recovering squad stays
   * recovering rather than silently reverting to idle at full strength.
   */
  private recover(q: Squad): void {
    if (this.tick >= q.recoverUntil) {
      // The full term is served whether or not morale and health topped out.
      q.stance = "idle";
      q.recoverUntil = 0;
      return;
    }
    q.morale = min(1, q.morale + RECOVER_MORALE_PER_SEC * TICK_DT);
    const maxHp = q.stats.hp;
    const heal = maxHp * RECOVER_HP_FRACTION_PER_SEC * TICK_DT;
    const s = this.soldiers;
    for (let i = 0; i < q.count; i++) {
      const id = q.first + i;
      if (s.alive[id] !== 1) continue;
      if (s.hp[id] < maxHp) s.hp[id] = min(maxHp, s.hp[id] + heal);
    }
  }

  /**
   * Re-route anyone whose road has changed under them.
   *
   * The terrain revision invalidates cached render chunks for free, but a
   * squad's route is just a list of points: blow the bridge it was crossing and
   * it keeps walking a path that no longer exists, discovers the water, drops
   * the order and stands there. Checking only when the revision moves keeps
   * this off the hot path entirely -- terrain changes a handful of times a
   * match, not a handful of times a tick.
   */
  private revalidateRoutes(): void {
    const rev = this.terrain.revision;
    for (const q of this.squads) {
      if (q.pathRevision === rev) continue;
      q.pathRevision = rev;
      if (q.path.length < 2) continue;

      let ok = clearLine(this.terrain, q.anchorX, q.anchorY, q.path[0], q.path[1]);
      for (let i = 0; ok && i + 3 < q.path.length; i += 2) {
        ok = clearLine(this.terrain, q.path[i], q.path[i + 1], q.path[i + 2], q.path[i + 3]);
      }
      if (ok) continue;

      // The destination is still what the player asked for; only the way there
      // has changed. Re-plan to the same place rather than abandoning it.
      const goalX = q.path[q.path.length - 2];
      const goalY = q.path[q.path.length - 1];
      q.path = this.routeThrough(q, [goalX, goalY]);
    }
  }

  /** Step to the next patrol waypoint, reversing at the ends of an open route. */
  private advancePatrolLeg(q: Squad): void {
    const n = q.patrol.length / 2;
    if (n < 2) return;
    // A circuit whose ends nearly meet should loop rather than ping-pong.
    const closed = dist(q.patrol[0], q.patrol[1], q.patrol[(n - 1) * 2], q.patrol[(n - 1) * 2 + 1]) < 90;
    if (q.patrolForward) {
      q.patrolLeg++;
      if (q.patrolLeg >= n) {
        if (closed) q.patrolLeg = 0;
        else {
          q.patrolForward = false;
          q.patrolLeg = n - 2;
        }
      }
    } else {
      q.patrolLeg--;
      if (q.patrolLeg < 0) {
        q.patrolForward = true;
        q.patrolLeg = 1;
      }
    }
  }

  private legRoute(q: Squad): number[] {
    const n = q.patrol.length / 2;
    if (n < 2) return [];
    const i = q.patrolLeg < 0 ? 0 : q.patrolLeg >= n ? n - 1 : q.patrolLeg;
    return this.routeThrough(q, [q.patrol[i * 2], q.patrol[i * 2 + 1]]);
  }

  private squadSpeed(q: Squad): number {
    const ground = TERRAIN_INFO[this.terrain.typeAtWorld(q.anchorX, q.anchorY)];
    // Impassable ground scales movement to zero, which is right for entering it
    // and disastrous for standing in it: a squad caught on a flooded tile would
    // have zero speed and never leave. Wading out is slow, not impossible.
    const scale = ground.moveScale > 0 ? ground.moveScale : STRANDED_WADE;
    return q.stats.speed * scale * moraleSpeedScale(q.morale);
  }

  private rebuildHash(): void {
    const s = this.soldiers;
    this.hash.ensureCapacity(s.count);
    this.hash.clear();
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] === 1) this.hash.insert(i, s.x[i], s.y[i]);
    }
  }

  // -- layers 2 and 3: slot projection, then per-soldier steering -------------

  private updateSoldiers(): void {
    const s = this.soldiers;
    for (const q of this.squads) {
      // Soldiers get headroom over the squad so stragglers can close up; the
      // floor keeps a standing squad able to re-form after being jostled.
      const squadSpeed = this.squadSpeed(q);
      const c = cos(q.facing);
      const sn = sin(q.facing);
      let inSlot = 0;
      let alive = 0;

      for (let i = 0; i < q.count; i++) {
        const id = q.first + i;
        if (s.alive[id] !== 1) continue;
        alive++;

        const slot = s.slot[id];
        if (slot >= q.live) continue; // stale slot; reflow reassigns next tick
        const lx = q.slots[slot * 2];
        const ly = q.slots[slot * 2 + 1];
        let tx = q.anchorX + lx * c - ly * sn;
        let ty = q.anchorY + lx * sn + ly * c;

        // A slot can land in a river or against a cliff -- half a wide line's
        // frontage easily does at a crossing. Slide the target back toward the
        // anchor until it is on walkable ground, so the formation compresses
        // against the obstacle rather than stranding men on the bank reaching
        // for a place they can never stand (spec section 4.1: formations
        // deform, then re-form).
        if (TERRAIN_INFO[this.terrain.typeAtWorld(tx, ty)].moveScale <= 0) {
          for (let k = 1; k <= 4; k++) {
            const f = 1 - k * 0.22;
            const px = q.anchorX + (tx - q.anchorX) * f;
            const py = q.anchorY + (ty - q.anchorY) * f;
            if (TERRAIN_INFO[this.terrain.typeAtWorld(px, py)].moveScale > 0) {
              tx = px;
              ty = py;
              break;
            }
          }
        }

        // Soldiers on the outside of a wheel genuinely have to run. A slot at
        // radius r sweeps at omega * r while the squad pivots, which for a
        // 20-wide line is well over the squad's own speed -- cap them at the
        // anchor's pace and the wings fall out of formation on every turn.
        const slotDist = sqrt(lx * lx + ly * ly);
        const maxSpeed = max(
          squadSpeed * CATCHUP + q.stats.turnRate * slotDist,
          q.stats.speed * 0.4,
        );

        const sx = s.x[id];
        const sy = s.y[id];
        const dx = tx - sx;
        const dy = ty - sy;
        const d = sqrt(dx * dx + dy * dy);
        if (d <= IN_SLOT) inSlot++;

        // Layer 2: pull toward the assigned slot, easing in near it so a
        // soldier settles instead of oscillating across its own position.
        const arrive = min(1, d / 10);
        let vx = d > 1e-6 ? (dx / d) * arrive : 0;
        let vy = d > 1e-6 ? (dy / d) * arrive : 0;

        // Layer 3: push off crowded neighbours.
        const n = this.hash.query(sx, sy, SEPARATION_RADIUS, this.neighbours);
        for (let k = 0; k < n; k++) {
          const other = this.neighbours[k];
          if (other === id) continue;
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
          // Vector magnitude doubles as the throttle: settled and uncrowded
          // means a short vector means no movement.
          const budget = maxSpeed * TICK_DT * min(1, vlen);
          const ux = vx / vlen;
          const uy = vy / vlen;
          const r = advanceToward(this.terrain, sx, sy, sx + ux * budget, sy + uy * budget, budget);
          s.x[id] = r.x;
          s.y[id] = r.y;
          // Face the way you are going while closing up; face with the
          // formation once you are in place.
          const desired = d > IN_SLOT * 1.5 ? atan2(uy, ux) : q.facing;
          s.facing[id] = rotateToward(s.facing[id], desired, q.stats.turnRate * 2.2 * TICK_DT);
        } else {
          s.facing[id] = rotateToward(s.facing[id], q.facing, q.stats.turnRate * 2.2 * TICK_DT);
        }
      }

      q.cohesion = alive > 0 ? inSlot / alive : 0;
    }
  }

  // -- vision -----------------------------------------------------------------

  /**
   * Who can see whom, and what each army has lit up.
   *
   * Runs for BOTH armies through the same code. The AI is subject to exactly
   * the fog the player is, which is only credible if there is one
   * implementation rather than a player-facing one and an AI-facing one.
   */
  private updateVision(): void {
    for (const f of this.fog) f.beginUpdate();

    for (const q of this.squads) {
      if (q.live === 0) {
        q.seenBy[0] = false;
        q.seenBy[1] = false;
        continue;
      }
      q.seenBy[q.player] = true;
      this.fog[q.player].stamp(
        q.anchorX,
        q.anchorY,
        effectiveSight(this.terrain, q.stats.sight, q.anchorX, q.anchorY),
      );
    }

    for (const target of this.squads) {
      if (target.live === 0) continue;
      const foe = 1 - target.player;
      let spotted = false;
      const hidden = concealment(this.terrain, target.anchorX, target.anchorY);
      for (const watcher of this.squads) {
        if (watcher.player !== foe || watcher.live === 0) continue;
        const reach =
          effectiveSight(this.terrain, watcher.stats.sight, watcher.anchorX, watcher.anchorY) *
          (1 - hidden);
        if (d2(watcher.anchorX, watcher.anchorY, target.anchorX, target.anchorY) > reach * reach) continue;
        if (!hasLineOfSight(this.terrain, watcher.anchorX, watcher.anchorY, target.anchorX, target.anchorY)) {
          continue;
        }
        spotted = true;
        break;
      }
      target.seenBy[foe] = spotted;
    }
  }

  /** Enemy squads a player can currently see. */
  visibleEnemies(player: number): Squad[] {
    return this.squads.filter((q) => q.player !== player && q.live > 0 && q.seenBy[player]);
  }

  // -- magic ------------------------------------------------------------------

  /**
   * Adepts work whichever spell suits the order they already have.
   *
   * Deliberately no gesture of its own: the pen vocabulary is fourteen classes
   * wide and provably diagonal, and every class added raises collision pressure
   * on all the rest. Telling adepts to attack IS casting the hex.
   */
  private castSpells(): void {
    for (const q of this.squads) {
      if (q.live === 0 || this.tick < q.spellReady) continue;
      const id = UNIT_TYPES[q.type].spell;
      if (!id) continue;

      let choose = id;
      if (q.stance === "attack") choose = "hex";
      else if (q.stance === "hold" || q.stance === "recover") choose = "ward";
      else if (this.woundedNear(q)) choose = "mend";
      else if (this.foeNear(q, SPELLS.hex.radius * 2.4)) choose = "hex";
      else continue;

      const spell = SPELLS[choose];
      // A hex is thrown at the enemy; a ward and a mend settle on your own.
      let tx = q.anchorX;
      let ty = q.anchorY;
      if (!spell.onAllies) {
        const foe = this.nearestVisibleFoe(q);
        if (!foe) continue;
        tx = foe.anchorX;
        ty = foe.anchorY;
      }
      this.workings.push({
        spell: choose,
        player: q.player,
        x: tx,
        y: ty,
        radius: spell.radius,
        until: this.tick + spell.duration * TICK_RATE,
        power: q.stats.magic,
      });
      q.spellReady = this.tick + spell.cooldown * TICK_RATE;
    }

    // Retire faded workings. Iterating backwards keeps the splice cheap.
    for (let i = this.workings.length - 1; i >= 0; i--) {
      if (this.workings[i].until <= this.tick) this.workings.splice(i, 1);
    }
  }

  private woundedNear(q: Squad): boolean {
    for (const other of this.squads) {
      if (other.player !== q.player || other.live === 0) continue;
      if (d2(q.anchorX, q.anchorY, other.anchorX, other.anchorY) > SPELLS.mend.radius * SPELLS.mend.radius) {
        continue;
      }
      if (other.live < other.count * 0.8) return true;
    }
    return false;
  }

  private foeNear(q: Squad, within: number): boolean {
    return this.nearestVisibleFoe(q, within) !== null;
  }

  private nearestVisibleFoe(q: Squad, within = Infinity): Squad | null {
    let best: Squad | null = null;
    let bestD = within * within;
    for (const other of this.squads) {
      if (other.player === q.player || other.live === 0 || !other.seenBy[q.player]) continue;
      const dd = d2(q.anchorX, q.anchorY, other.anchorX, other.anchorY);
      if (dd < bestD || (dd === bestD && best !== null && other.id < best.id)) {
        bestD = dd;
        best = other;
      }
    }
    return best;
  }

  /** Damage reduction and damage amplification a soldier stands in. */
  private shelterAt(player: number, x: number, y: number): number {
    let soak = 0;
    for (const w of this.workings) {
      if (w.spell !== "ward" || w.player !== player) continue;
      if (d2(w.x, w.y, x, y) <= w.radius * w.radius) soak = max(soak, wardSoak(w.power));
    }
    for (const w of this.workings) {
      if (w.spell !== "hex" || w.player === player) continue;
      if (d2(w.x, w.y, x, y) <= w.radius * w.radius) soak -= hexPenalty(w.power);
    }
    return clamp(soak, -0.6, 0.6);
  }

  /** Healing and nerve, applied once a tick to whoever stands in a working. */
  private applyWorkings(): void {
    if (this.workings.length === 0) return;
    const s = this.soldiers;
    for (const q of this.squads) {
      if (q.live === 0) continue;
      for (const w of this.workings) {
        const friendly = w.player === q.player;
        if (SPELLS[w.spell].onAllies !== friendly) continue;
        if (d2(w.x, w.y, q.anchorX, q.anchorY) > w.radius * w.radius) continue;

        q.morale = clamp(q.morale + nerveShift(w.spell, w.power) * TICK_DT, 0, 1);
        if (w.spell !== "mend") continue;
        const heal = mendRate(w.power, q.stats.hp) * TICK_DT;
        for (let i = 0; i < q.count; i++) {
          const id = q.first + i;
          if (s.alive[id] !== 1 || s.hp[id] >= q.stats.hp) continue;
          s.hp[id] = min(q.stats.hp, s.hp[id] + heal);
        }
      }
    }
  }

  // -- combat -----------------------------------------------------------------

  /**
   * One tick of fighting, in two passes.
   *
   * Pass one gathers every blow into soldiers.incoming without changing any
   * hit points. Pass two applies the buffer and removes the dead. Doing it in
   * one pass -- striking and killing as we walk the list -- would give the
   * lower-indexed army, which is always player 0, the first blow in every
   * mutual engagement. That bias is perfectly deterministic and no replay test
   * would ever catch it.
   */
  private resolveCombat(): void {
    const s = this.soldiers;
    this.events.length = 0;
    for (let i = 0; i < s.count; i++) s.incoming[i] = 0;
    for (const q of this.squads) q.flanked = false;

    for (const q of this.squads) {
      if (q.live === 0) continue;
      if (q.stats.range > MELEE_RANGE) {
        const shot = this.aimRanged(q, q.stats.range);
        // Siege has nothing to shoot: put it to work on the enemy's structures.
        if (!shot && UNIT_TYPES[q.type].siege) this.batter(q);
      } else this.aimMelee(q);
    }

    this.applyDamage();
  }

  /** Hand-to-hand: neighbours come from the soldier hash, which is sized for it. */
  private aimMelee(q: Squad): void {
    const s = this.soldiers;
    const reach = MELEE_RANGE;

    for (let i = 0; i < q.count; i++) {
      const id = q.first + i;
      if (s.alive[id] !== 1) continue;
      if (s.cooldown[id] > 0) {
        s.cooldown[id] -= TICK_DT;
        continue;
      }
      const n = this.hash.query(s.x[id], s.y[id], reach, this.neighbours);
      let target = -1;
      let bestD = reach * reach;
      for (let k = 0; k < n; k++) {
        const other = this.neighbours[k];
        if (s.alive[other] !== 1) continue;
        const oq = this.squadOf(other);
        if (!oq || oq.player === q.player) continue;
        const dd = d2(s.x[id], s.y[id], s.x[other], s.y[other]);
        // Ties break on index so two peers never pick different targets.
        if (dd < bestD || (dd === bestD && other < target)) {
          bestD = dd;
          target = other;
        }
      }
      if (target < 0) continue;
      this.strike(q, id, target, q.stats.attack, q.stats.attackInterval);
    }
  }

  /**
   * Shooting: pick an enemy SQUAD first, then soldiers inside it.
   *
   * Never the spatial hash. Its cells are sized for separation distance, so a
   * 250-unit bow sweeping that grid would touch hundreds of cells per soldier
   * per tick. There are only ~30 squads, so scanning them is trivial.
   */
  /**
   * Batter the nearest destructible structure in range.
   *
   * Only siege does this, and only with no squad to shoot at: an army that
   * spends its arrows demolishing a wall while cavalry rides it down has its
   * priorities wrong.
   */
  private batter(q: Squad): void {
    const reach = q.stats.range;
    const t = this.terrain;
    const tx0 = floor((q.anchorX - reach) / TILE_SIZE);
    const tx1 = floor((q.anchorX + reach) / TILE_SIZE);
    const ty0 = floor((q.anchorY - reach) / TILE_SIZE);
    const ty1 = floor((q.anchorY + reach) / TILE_SIZE);

    let bestX = -1;
    let bestY = -1;
    let bestD = reach * reach;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (!t.inBounds(tx, ty) || !t.destructibleAt(tx, ty)) continue;
        // Woods are not worth a siege engine's time; walls and bridges are.
        const kind = t.typeAt(tx, ty);
        if (kind !== Terrain.Fortification && kind !== Terrain.Bridge) continue;
        const cx = (tx + 0.5) * TILE_SIZE;
        const cy = (ty + 0.5) * TILE_SIZE;
        const dd = d2(q.anchorX, q.anchorY, cx, cy);
        if (dd < bestD) {
          bestD = dd;
          bestX = tx;
          bestY = ty;
        }
      }
    }
    if (bestX < 0) return;

    const s = this.soldiers;
    for (let i = 0; i < q.count; i++) {
      const id = q.first + i;
      if (s.alive[id] !== 1) continue;
      if (s.cooldown[id] > 0) {
        s.cooldown[id] -= TICK_DT;
        continue;
      }
      s.cooldown[id] = q.stats.attackInterval;
      this.terrain.damage(bestX, bestY, q.stats.attack * 0.55);
      this.events.push({
        kind: "shot",
        player: q.player,
        x0: s.x[id],
        y0: s.y[id],
        x1: (bestX + 0.5) * TILE_SIZE,
        y1: (bestY + 0.5) * TILE_SIZE,
        lethal: false,
        victim: -1,
      });
    }
  }

  private aimRanged(q: Squad, range: number): boolean {
    const s = this.soldiers;

    let target: Squad | null = null;
    let bestD = Infinity;
    for (const other of this.squads) {
      if (other.player === q.player || other.live === 0) continue;
      // No shooting at what the army cannot see.
      if (!other.seenBy[q.player]) continue;
      const dd = d2(q.anchorX, q.anchorY, other.anchorX, other.anchorY);
      const reach =
        range * rangeFromHeight(this.terrain, q.anchorX, q.anchorY, other.anchorX, other.anchorY) +
        other.radius;
      if (dd > reach * reach) continue;
      if (dd < bestD || (dd === bestD && other.id < (target ? target.id : Infinity))) {
        bestD = dd;
        target = other;
      }
    }
    if (!target) return false;

    for (let i = 0; i < q.count; i++) {
      const id = q.first + i;
      if (s.alive[id] !== 1) continue;
      if (s.cooldown[id] > 0) {
        s.cooldown[id] -= TICK_DT;
        continue;
      }
      // Spread fire across the target squad instead of every archer in a rank
      // converging on the same man and wasting most of the volley.
      const victim = spreadTarget(i, target.first, target.count, s.alive);
      if (victim < 0) continue;
      if (d2(s.x[id], s.y[id], s.x[victim], s.y[victim]) > range * range) {
        // This particular shooter is out of range even though the squad is not.
        const closer = nearestInSquad(
          s.x[id], s.y[id], target.first, target.count, s.alive, s.x, s.y, range,
        );
        if (closer < 0) continue;
        this.strike(q, id, closer, q.stats.attack, q.stats.attackInterval);
        continue;
      }
      this.strike(q, id, victim, q.stats.attack, q.stats.attackInterval);
    }
    return true;
  }

  /** Buffer one blow. Nothing dies until the whole tick has been resolved. */
  private strike(
    q: Squad,
    attacker: number,
    victim: number,
    attack: number,
    interval: number,
  ): void {
    const s = this.soldiers;
    const vq = this.squadOf(victim);
    if (!vq) return;
    const dmg = hitDamage(
      this.rng.combat,
      attack,
      vq.stats.defence,
      // Wards soak, hexes amplify. Negative shelter makes a blow land harder.
      this.shelterAt(vq.player, s.x[victim], s.y[victim]),
      this.terrain,
      s.x[victim],
      s.y[victim],
    );
    s.incoming[victim] += dmg;
    s.struckBy[victim] = this.ownerOf[attacker];
    s.cooldown[attacker] = interval;
    this.events.push({
      kind: q.stats.range > MELEE_RANGE ? "shot" : "melee",
      player: q.player,
      x0: s.x[attacker],
      y0: s.y[attacker],
      x1: s.x[victim],
      y1: s.y[victim],
      lethal: false,
      victim,
    });
    q.lastContact = this.tick;
    vq.lastContact = this.tick;
    if (isFlanking(s.facing[victim], s.x[attacker], s.y[attacker], s.x[victim], s.y[victim])) {
      vq.flanked = true;
    }
  }

  /** Apply the buffered damage, remove the dead, and re-form the survivors. */
  private applyDamage(): void {
    const s = this.soldiers;
    for (const q of this.squads) {
      q.casualtiesThisTick = 0;
      q.killsThisTick = 0;
    }

    for (const q of this.squads) {
      let fell = 0;
      for (let i = 0; i < q.count; i++) {
        const id = q.first + i;
        if (s.alive[id] !== 1 || s.incoming[id] <= 0) continue;
        s.hp[id] -= s.incoming[id];
        if (s.hp[id] > 0) continue;
        s.alive[id] = 0;
        s.hp[id] = 0;
        fell++;
        for (const e of this.events) if (e.victim === id) e.lethal = true;
        // Credit the kill to whoever landed the last blow. Because damage is
        // buffered, a squad wiped out this same tick still gets its credit.
        const killer = s.struckBy[id];
        if (killer >= 0) {
          const kq = this.squads[killer];
          kq.kills++;
          kq.killsThisTick++;
        }
      }
      if (fell === 0) continue;
      q.live -= fell;
      q.losses += fell;
      q.casualtiesThisTick = fell;
      // Slots are derived from the LIVING count, not the spawn roster. Skip
      // this and a squad keeps gaps where its dead used to stand, while
      // cohesion still reads 1.00 because it only ever looks at survivors.
      this.reflow(q);
    }
  }

  /** Rebuild the formation for the squad's current strength. */
  private reflow(q: Squad): void {
    if (q.live <= 0) return;
    formationSlots(q.shape, q.live, q.slots);
    q.radius = formationRadius(q.slots, q.live);
    this.assignSlots(q);
  }

  /** Which squad a soldier belongs to. O(1). */
  private squadOf(soldier: number): Squad | undefined {
    const i = this.ownerOf[soldier];
    return i < 0 ? undefined : this.squads[i];
  }

  // -- morale -----------------------------------------------------------------

  /**
   * One tick of morale for every squad.
   *
   * Local outnumbering is measured from soldiers actually nearby rather than
   * from army totals: a squad can be winning the battle and still be about to
   * break because it is alone against three.
   */
  private updateMorale(): void {
    const s = this.soldiers;
    const inContactWindow = TICK_RATE * 3;

    for (const q of this.squads) {
      if (q.live === 0) {
        q.morale = 0;
        continue;
      }
      const inContact = this.tick - q.lastContact < inContactWindow;

      let friends = 0;
      let foes = 0;
      if (inContact) {
        const n = this.hash.query(q.anchorX, q.anchorY, q.radius + 90, this.neighbours);
        for (let k = 0; k < n; k++) {
          const other = this.neighbours[k];
          if (s.alive[other] !== 1) continue;
          const oq = this.squadOf(other);
          if (!oq) continue;
          if (oq.player === q.player) friends++;
          else foes++;
        }
      }

      q.morale = nextMorale(q.morale, {
        // Doctrine steadies or shortens the nerve of the whole army.
        resolve: q.stats.resolve,
        casualties: q.casualtiesThisTick,
        kills: q.killsThisTick,
        strength: q.live,
        roster: q.count,
        flanked: q.flanked,
        outnumbered: foes > friends * 1.5 && foes > 0,
        inContact,
        cover: TERRAIN_INFO[this.terrain.typeAtWorld(q.anchorX, q.anchorY)].cover,
        dt: TICK_DT,
      });
    }
  }
}

/** World-space position of a formation slot. */
export function slotWorldX(q: Squad, slot: number): number {
  return q.anchorX + q.slots[slot * 2] * cos(q.facing) - q.slots[slot * 2 + 1] * sin(q.facing);
}

export function slotWorldY(q: Squad, slot: number): number {
  return q.anchorY + q.slots[slot * 2] * sin(q.facing) + q.slots[slot * 2 + 1] * cos(q.facing);
}

/** Shaken squads move sluggishly. Full morale is 1, broken is 0. */
function moraleSpeedScale(morale: number): number {
  return 0.55 + 0.45 * clamp(morale, 0, 1);
}

export { ROUT_THRESHOLD };
