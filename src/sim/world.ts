/**
 * The world: all simulation state, and the single tick function that advances it.
 *
 * Invariants (see CLAUDE.md):
 *   - No DOM, no canvas, no browser globals. Runs headless under node.
 *   - No wall-clock time. `tick` is the only clock.
 *   - Mutated exclusively by `step()`, exclusively at tick boundaries.
 *
 * Phase 0 units are single points that walk a path. Phase 1 turns each into a
 * squad of individually-simulated soldiers holding a formation; the unit record
 * grows, the tick contract does not.
 */

import { atan2, clamp, dist, rotateToward, TAU } from "./math.ts";
import { Rng, Stream } from "./rng.ts";
import { OrderQueue, type Order, type FormationShape } from "./orders.ts";
import { generateTerrain, TerrainGrid, TERRAIN_INFO } from "./terrain.ts";

/** Simulation ticks per second. Slow, deliberate pacing needs no more than this. */
export const TICK_RATE = 20;
/** Seconds of simulated time per tick. */
export const TICK_DT = 1 / TICK_RATE;

export type Unit = {
  readonly id: number;
  readonly player: number;
  x: number;
  y: number;
  /** Radians; 0 points along +x. */
  facing: number;
  /** World units per second on open ground. */
  baseSpeed: number;
  /** Radians per second. */
  turnRate: number;
  /** Remaining waypoints as flat [x0, y0, x1, y1, ...]. Empty when idle. */
  path: number[];
  shape: FormationShape;
  /** Placeholder until Phase 3 owns these properly. */
  strength: number;
  morale: number;
};

export type WorldConfig = {
  readonly seed: number;
  readonly tilesWide: number;
  readonly tilesHigh: number;
};

export class World {
  tick = 0;
  readonly seed: number;
  readonly terrain: TerrainGrid;
  readonly orders = new OrderQueue();
  readonly units: Unit[] = [];

  /** One independent stream per subsystem -- see rng.ts for why. */
  readonly rng: {
    readonly combat: Rng;
    readonly morale: Rng;
    readonly ai: Rng;
    readonly spawn: Rng;
  };

  private nextEntityId = 1;

  constructor(config: WorldConfig) {
    this.seed = config.seed | 0;
    this.terrain = generateTerrain(config.tilesWide, config.tilesHigh, this.seed);
    this.rng = {
      combat: Rng.create(this.seed, Stream.Combat),
      morale: Rng.create(this.seed, Stream.Morale),
      ai: Rng.create(this.seed, Stream.Ai),
      spawn: Rng.create(this.seed, Stream.Spawn),
    };
  }

  spawnUnit(player: number, x: number, y: number, facing: number): Unit {
    const unit: Unit = {
      id: this.nextEntityId++,
      player,
      x,
      y,
      facing,
      baseSpeed: 34,
      turnRate: 1.6,
      path: [],
      shape: "line",
      strength: 1,
      morale: 1,
    };
    this.units.push(unit);
    return unit;
  }

  unitById(id: number): Unit | undefined {
    for (const u of this.units) if (u.id === id) return u;
    return undefined;
  }

  /** Advance exactly one tick. The only mutator of world state. */
  step(): void {
    this.applyOrders();
    this.moveUnits();
    this.tick++;
  }

  private applyOrders(): void {
    for (const order of this.orders.drain(this.tick)) {
      this.applyOrder(order);
    }
  }

  private applyOrder(order: Order): void {
    switch (order.kind) {
      case "move": {
        const u = this.unitById(order.unit);
        if (!u) return;
        u.path = order.path.slice();
        return;
      }
      case "formation": {
        const u = this.unitById(order.unit);
        if (!u) return;
        u.shape = order.shape;
        return;
      }
      // Implemented in their own phases; accepted and ignored until then.
      case "attack":
      case "hold":
      case "retreat":
      case "patrol":
        return;
    }
  }

  private moveUnits(): void {
    for (const u of this.units) {
      if (u.path.length < 2) continue;

      const tx = u.path[0];
      const ty = u.path[1];

      // Face the waypoint before committing to it, so units pivot rather than strafe.
      const desired = atan2(ty - u.y, tx - u.x);
      u.facing = rotateToward(u.facing, desired, u.turnRate * TICK_DT);

      const terrain = this.terrain.infoAtWorld(u.x, u.y);
      const speed = u.baseSpeed * terrain.moveScale * moraleSpeedScale(u.morale);
      if (speed <= 0) {
        // Standing on impassable ground should be impossible; drop the order
        // rather than let the unit freeze holding a path it can never walk.
        u.path.length = 0;
        continue;
      }

      let remaining = speed * TICK_DT;
      // Consume waypoints until the step budget runs out.
      while (remaining > 0 && u.path.length >= 2) {
        const wx = u.path[0];
        const wy = u.path[1];
        const d = dist(u.x, u.y, wx, wy);
        if (d <= remaining) {
          u.x = wx;
          u.y = wy;
          remaining -= d;
          u.path.splice(0, 2);
        } else {
          const t = remaining / d;
          const nx = u.x + (wx - u.x) * t;
          const ny = u.y + (wy - u.y) * t;
          // Refuse to walk into impassable terrain; hold position instead of
          // clipping through a river.
          if (TERRAIN_INFO[this.terrain.typeAtWorld(nx, ny)].moveScale <= 0) {
            u.path.length = 0;
          } else {
            u.x = nx;
            u.y = ny;
          }
          remaining = 0;
        }
      }

      u.x = clamp(u.x, 0, this.terrain.worldWidth);
      u.y = clamp(u.y, 0, this.terrain.worldHeight);
      u.facing = ((u.facing % TAU) + TAU) % TAU;
    }
  }
}

/** Shaken units move sluggishly. Full morale is 1, broken is 0. */
function moraleSpeedScale(morale: number): number {
  return 0.55 + 0.45 * clamp(morale, 0, 1);
}
