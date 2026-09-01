/**
 * The opposing commander.
 *
 * Lives in sim/ and issues Orders through the same queue the player uses. That
 * is not tidiness: an AI that reached in and set stances directly would mutate
 * state outside the order stream, and a replay fed only that stream would
 * diverge the moment the AI did anything. Lockstep netplay would be dead with
 * it. It draws from rng.ai, its own stream, so adding a decision here never
 * shifts a combat or morale roll.
 *
 * It sees exactly what the player sees. Every decision reads
 * world.visibleEnemies(); nothing consults a squad the fog is hiding.
 */

import { atan2, clamp, cos, min, sin, sqrt } from "./math.ts";
import type { Group, World } from "./world.ts";

/** Ticks between decisions. Re-planning every tick makes squads twitch. */
const THINK_INTERVAL = 20;
/** Ticks a squad is left alone after being given an order. */
const COMMIT_TICKS = 60;
/** Ticks a posture is held before it may change again. */
const STYLE_DWELL = THINK_INTERVAL * 12;
/** Upper size for a machine-formed group. Beyond this a formation is unwieldy. */
const MAX_GROUP = 20;

export type Playstyle = "aggressive" | "defensive" | "maneuver" | "reactive";

export const PLAYSTYLES: readonly Playstyle[] = [
  "aggressive", "defensive", "maneuver", "reactive",
];

export class ArmyAI {
  readonly player: number;
  style: Playstyle = "reactive";
  /** Tick at which the current posture was adopted. */
  private styleSince = 0;
  /** Per-squad tick until which a squad is left to carry out its orders. */
  private readonly committedUntil = new Map<number, number>();
  /** Where the enemy was last seen, kept after they slip back into the fog. */
  private lastKnownX = 0;
  private lastKnownY = 0;
  private hasContact = false;

  constructor(player: number) {
    this.player = player;
  }

  /** Called once per tick from World.step, before orders are drained. */
  update(world: World): void {
    if (world.tick % THINK_INTERVAL !== 0) return;
    // With no inherent squads, the machine must organise its own men before it
    // can command them -- exactly as the player does with the pen.
    this.formGroups(world);
    this.chooseStyle(world);

    const foes = world.visibleEnemies(this.player);
    if (foes.length > 0) {
      // Remember where they were. A commander who forgets the enemy the instant
      // they step behind a wood is not cautious, it is amnesiac.
      let cx = 0;
      let cy = 0;
      for (const f of foes) {
        cx += f.anchorX;
        cy += f.anchorY;
      }
      this.lastKnownX = cx / foes.length;
      this.lastKnownY = cy / foes.length;
      this.hasContact = true;
    }

    for (const q of world.groups) {
      if (q.player !== this.player || world.liveCount(q) === 0) continue;
      if (q.recoverUntil > world.tick) continue;
      if (world.tick < (this.committedUntil.get(q.id) ?? 0)) continue;
      if (this.orderGroup(world, q, foes)) {
        this.committedUntil.set(q.id, world.tick + COMMIT_TICKS);
      }
    }
  }

  /**
   * Pick a posture from the situation.
   *
   * Deliberately hysteretic: a commander that flips stance every second reads
   * as noise rather than intent, so a style is held for a spell once adopted.
   */
  private chooseStyle(world: World): void {
    if (world.tick - this.styleSince < STYLE_DWELL) return;

    const me = world.armyState(this.player);
    const foe = world.armyState(1 - this.player);
    const ratio = foe.strength > 0 ? me.strength / foe.strength : 2;
    const shaken = me.morale < foe.morale - 0.12;

    let next: Playstyle;
    if (shaken || me.morale < 0.35) {
      // Losing the nerve battle: stop trading and hold ground.
      next = "defensive";
    } else if (ratio > 1.25 && me.morale > 0.6) {
      next = "aggressive";
    } else if (ratio < 0.85) {
      // Outnumbered but steady: refuse a straight fight, work the flanks.
      next = "maneuver";
    } else {
      next = world.rng.ai.chance(0.4) ? "maneuver" : "reactive";
    }

    if (next !== this.style) {
      this.style = next;
      this.styleSince = world.tick;
    }
  }

  /** Give one squad something to do. Returns false if nothing was issued. */
  private orderGroup(world: World, q: Group, foes: readonly Group[]): boolean {
    const tick = world.tick;
    const rng = world.rng.ai;

    // A badly mauled squad pulls out rather than feeding the grinder.
    if (this.moraleOf(world, q) < 0.28) {
      const dx = this.homeX(world) - q.anchorX;
      world.orders.issue(
        { kind: "retreat", squad: q.id, path: [q.anchorX + clamp(dx, -700, 700), q.anchorY] },
        this.player,
        tick,
      );
      return true;
    }
    // Shaken and thinned out: stand down and recover, accepting the 30 seconds
    // of helplessness that costs.
    if (this.moraleOf(world, q) < 0.5 && rng.chance(0.12)) {
      world.orders.issue({ kind: "recover", squad: q.id }, this.player, tick);
      return true;
    }

    const target = this.pickTarget(q, foes);

    switch (this.style) {
      case "aggressive":
        if (target) return this.assault(world, q, target, tick);
        return this.pressLooseEnemy(world, q, tick) || this.advance(world, q, tick);

      case "defensive": {
        if (target && this.near(q, target, 420)) return this.assault(world, q, target, tick);
        if (q.shape !== "square" && rng.chance(0.4)) {
          world.orders.issue({ kind: "formation", squad: q.id, shape: "square" }, this.player, tick);
          return true;
        }
        world.orders.issue(
          { kind: "hold", squad: q.id, x: q.anchorX, y: q.anchorY, radius: 220 },
          this.player,
          tick,
        );
        return true;
      }

      case "maneuver": {
        if (!target) return this.pressLooseEnemy(world, q, tick) || this.advance(world, q, tick);
        // Swing wide and come in off a flank rather than straight up the front.
        const side = q.id % 2 === 0 ? 1 : -1;
        const bearing = atan2(target.anchorY - q.anchorY, target.anchorX - q.anchorX) + side * 1.15;
        const swing = 380 + rng.range(0, 220);
        world.orders.issue(
          {
            kind: "attack",
            squad: q.id,
            target: target.id,
            path: [
              target.anchorX + cos(bearing) * swing,
              target.anchorY + sin(bearing) * swing,
              target.anchorX,
              target.anchorY,
            ],
          },
          this.player,
          tick,
        );
        return true;
      }

      case "reactive":
        if (target && this.near(q, target, 700)) return this.assault(world, q, target, tick);
        return this.pressLooseEnemy(world, q, tick) || this.advance(world, q, tick);
    }
  }

  /**
   * Go for enemy soldiers who are not in any group.
   *
   * visibleEnemies() only reports GROUPS, and a player is under no obligation to
   * form any -- their men can be scattered across the map, individually. Without
   * this the machine sees nothing worth attacking, issues nothing but marches,
   * and fights only by accidentally bumping into people.
   *
   * An attack order with no named target is an attack-move: walk there and
   * engage whatever is met, which is exactly right for loose men who will not
   * hold still as a formation anyway.
   */
  private pressLooseEnemy(world: World, q: Group, tick: number): boolean {
    const s = world.soldiers;
    const foe = 1 - this.player;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] !== 1 || s.player[i] !== foe) continue;
      if (!world.canSee(this.player, i)) continue;
      const dx = s.x[i] - q.anchorX;
      const dy = s.y[i] - q.anchorY;
      const d = dx * dx + dy * dy;
      // Ties on soldier index, so two peers pick the same man.
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return false;
    world.orders.issue(
      { kind: "attack", squad: q.id, target: -1, path: [s.x[best], s.y[best]] },
      this.player,
      tick,
    );
    return true;
  }

  private assault(world: World, q: Group, target: Group, tick: number): boolean {
    world.orders.issue(
      { kind: "attack", squad: q.id, target: target.id, path: [target.anchorX, target.anchorY] },
      this.player,
      tick,
    );
    return true;
  }

  /**
   * Nearest visible enemy, preferring one already weakened.
   *
   * Ties break on squad id, so two peers replaying an identical order stream
   * make an identical choice.
   */
  private pickTarget(q: Group, foes: readonly Group[]): Group | null {
    let best: Group | null = null;
    let bestScore = Infinity;
    for (const f of foes) {
      const dx = f.anchorX - q.anchorX;
      const dy = f.anchorY - q.anchorY;
      const d = sqrt(dx * dx + dy * dy);
      // A squad already down to half strength is worth walking further for.
      const s = d * (0.6 + f.members.length * 0.04);
      if (s < bestScore || (s === bestScore && best !== null && f.id < best.id)) {
        bestScore = s;
        best = f;
      }
    }
    return best;
  }

  /**
   * Organise loose soldiers into groups.
   *
   * With no inherent squads the machine has to do what the player does with the
   * pen: gather men who are standing together into something it can command.
   * Ungrouped soldiers are bucketed by proximity, largest cluster first, and
   * ties break on soldier id so two peers build identical groups.
   */
  private formGroups(world: World): void {
    const loose = world
      .soldiersOf(this.player)
      .filter((id) => world.soldiers.group[id] < 0);
    if (loose.length === 0) return;

    const CLUSTER = 220;
    const taken = new Set<number>();
    for (const seed of loose) {
      if (taken.has(seed)) continue;
      const batch: number[] = [seed];
      taken.add(seed);
      for (const other of loose) {
        if (taken.has(other) || batch.length >= MAX_GROUP) continue;
        const dx = world.soldiers.x[other] - world.soldiers.x[seed];
        const dy = world.soldiers.y[other] - world.soldiers.y[seed];
        if (dx * dx + dy * dy > CLUSTER * CLUSTER) continue;
        batch.push(other);
        taken.add(other);
      }
      // A lone straggler is not worth a command structure of its own.
      if (batch.length >= 3) world.createGroup(this.player, batch);
    }
  }

  /** Mean nerve of a group's living members. */
  private moraleOf(world: World, g: Group): number {
    let sum = 0;
    let n = 0;
    for (const m of g.members) {
      if (world.soldiers.alive[m] !== 1) continue;
      sum += world.soldiers.morale[m];
      n++;
    }
    return n === 0 ? 0 : sum / n;
  }

  private near(q: Group, other: Group, within: number): boolean {
    const dx = other.anchorX - q.anchorX;
    const dy = other.anchorY - q.anchorY;
    return dx * dx + dy * dy <= within * within;
  }

  /** Push toward where the enemy was last seen, or the far side of the map. */
  private advance(world: World, q: Group, tick: number): boolean {
    const tx = this.hasContact ? this.lastKnownX : world.terrain.worldWidth - this.homeX(world);
    const ty = this.hasContact ? this.lastKnownY : world.terrain.worldHeight * 0.5;
    const dx = tx - q.anchorX;
    const dy = ty - q.anchorY;
    const d = sqrt(dx * dx + dy * dy);
    if (d < 120) return false;
    const step = min(d, 900);
    world.orders.issue(
      { kind: "move", squad: q.id, path: [q.anchorX + (dx / d) * step, q.anchorY + (dy / d) * step] },
      this.player,
      tick,
    );
    return true;
  }

  private homeX(world: World): number {
    return this.player === 0 ? 0 : world.terrain.worldWidth;
  }

  /** Snapshot for hashing: the AI's memory is state like any other. */
  snapshot(): number[] {
    return [
      PLAYSTYLES.indexOf(this.style),
      this.styleSince,
      this.hasContact ? 1 : 0,
      this.lastKnownX,
      this.lastKnownY,
    ];
  }
}
