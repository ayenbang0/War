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

import { atan2, clamp, cos, dist, max, min, rotateToward, sin, sqrt, TAU } from "./math.ts";
import { Rng, Stream } from "./rng.ts";
import { OrderQueue, type Order } from "./orders.ts";
import { generateTerrain, TerrainGrid, TERRAIN_INFO } from "./terrain.ts";
import { formationSlots, formationRadius, type FormationShape } from "./formations.ts";
import { advanceToward } from "./movement.ts";
import { SpatialHash } from "./spatial.ts";
import { findPath } from "./pathfind.ts";
import { UNIT_TYPES, type UnitTypeId } from "../content/unit-types.ts";

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

export type Stance = "idle" | "move" | "attack" | "hold" | "retreat" | "patrol";

export type Squad = {
  readonly id: number;
  readonly player: number;
  readonly type: UnitTypeId;
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
  count = 0;

  constructor(capacity: number) {
    this.x = new Float64Array(capacity);
    this.y = new Float64Array(capacity);
    this.facing = new Float64Array(capacity);
    this.hp = new Float64Array(capacity);
    this.squad = new Int32Array(capacity);
    this.slot = new Int32Array(capacity);
    this.alive = new Uint8Array(capacity);
  }
}

export type WorldConfig = {
  readonly seed: number;
  readonly tilesWide: number;
  readonly tilesHigh: number;
  /** Soldier capacity. 15 squads x 20 soldiers x 2 sides needs 600. */
  readonly soldierCapacity?: number;
};

export class World {
  tick = 0;
  readonly seed: number;
  readonly terrain: TerrainGrid;
  readonly orders = new OrderQueue();
  readonly squads: Squad[] = [];
  readonly soldiers: SoldierStore;

  /** One independent stream per subsystem -- see rng.ts for why. */
  readonly rng: {
    readonly combat: Rng;
    readonly morale: Rng;
    readonly ai: Rng;
    readonly spawn: Rng;
  };

  private readonly hash: SpatialHash;
  private readonly neighbours: Int32Array;
  private nextEntityId = 1;

  constructor(config: WorldConfig) {
    this.seed = config.seed | 0;
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
    this.rng = {
      combat: Rng.create(this.seed, Stream.Combat),
      morale: Rng.create(this.seed, Stream.Morale),
      ai: Rng.create(this.seed, Stream.Ai),
      spawn: Rng.create(this.seed, Stream.Spawn),
    };
  }

  /** Create a squad at full strength, its soldiers already standing in formation. */
  spawnSquad(player: number, type: UnitTypeId, x: number, y: number, facing: number): Squad {
    const spec = UNIT_TYPES[type];
    const s = this.soldiers;
    const first = s.count;
    const count = spec.soldiers;

    const squad: Squad = {
      id: this.nextEntityId++,
      player,
      type,
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
    };
    formationSlots(squad.shape, count, squad.slots);
    squad.radius = formationRadius(squad.slots, count);

    for (let i = 0; i < count; i++) {
      const id = first + i;
      s.squad[id] = squad.id;
      s.slot[id] = i;
      s.hp[id] = spec.hp;
      s.alive[id] = 1;
      s.facing[id] = facing;
      const wx = slotWorldX(squad, i);
      const wy = slotWorldY(squad, i);
      s.x[id] = wx;
      s.y[id] = wy;
    }
    s.count += count;
    this.squads.push(squad);
    return squad;
  }

  squadById(id: number): Squad | undefined {
    for (const q of this.squads) if (q.id === id) return q;
    return undefined;
  }

  /** Living soldiers in a squad. */
  strengthOf(squad: Squad): number {
    let n = 0;
    for (let i = 0; i < squad.count; i++) if (this.soldiers.alive[squad.first + i] === 1) n++;
    return n;
  }

  /** Advance exactly one tick. The only mutator of world state. */
  step(): void {
    this.applyOrders();
    this.updateSquadAnchors();
    this.rebuildHash();
    this.updateSoldiers();
    this.tick++;
  }

  private applyOrders(): void {
    for (const order of this.orders.drain(this.tick)) this.applyOrder(order);
  }

  private applyOrder(order: Order): void {
    const q = this.squadById(order.squad);
    if (!q) return;
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
    }
  }

  /**
   * Turn a drawn route into a walkable one. The player draws intent, not a
   * traversable path -- a stroke crosses rivers and cliffs freely -- so every
   * leg is re-routed by A* and the results concatenated.
   */
  private routeThrough(q: Squad, waypoints: readonly number[]): number[] {
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
    formationSlots(shape, q.count, q.slots);
    q.radius = formationRadius(q.slots, q.count);
    this.assignSlots(q);
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
    for (let slot = 0; slot < q.count; slot++) {
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
    for (const q of this.squads) {
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
      q.facing = rotateToward(q.facing, desired, UNIT_TYPES[q.type].turnRate * TICK_DT);

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
    const spec = UNIT_TYPES[q.type];
    const ground = TERRAIN_INFO[this.terrain.typeAtWorld(q.anchorX, q.anchorY)];
    return spec.speed * ground.moveScale * moraleSpeedScale(q.morale);
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
      const spec = UNIT_TYPES[q.type];
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
          squadSpeed * CATCHUP + spec.turnRate * slotDist,
          spec.speed * 0.4,
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
          s.facing[id] = rotateToward(s.facing[id], desired, spec.turnRate * 2.2 * TICK_DT);
        } else {
          s.facing[id] = rotateToward(s.facing[id], q.facing, spec.turnRate * 2.2 * TICK_DT);
        }
      }

      q.cohesion = alive > 0 ? inSlot / alive : 0;
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
