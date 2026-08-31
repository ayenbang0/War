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
import type { Squad, World } from "./world.ts";

/** Ticks between decisions. Re-planning every tick makes squads twitch. */
const THINK_INTERVAL = 20;
/** Ticks a squad is left alone after being given an order. */
const COMMIT_TICKS = 60;
/** Ticks a posture is held before it may change again. */
const STYLE_DWELL = THINK_INTERVAL * 12;

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

    for (const q of world.squads) {
      if (q.player !== this.player || q.live === 0) continue;
      if (q.recoverUntil > world.tick) continue;
      if (world.tick < (this.committedUntil.get(q.id) ?? 0)) continue;
      if (this.orderSquad(world, q, foes)) {
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
  private orderSquad(world: World, q: Squad, foes: readonly Squad[]): boolean {
    const tick = world.tick;
    const rng = world.rng.ai;

    // A badly mauled squad pulls out rather than feeding the grinder.
    if (q.morale < 0.28) {
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
    if (q.morale < 0.5 && q.live <= q.count * 0.4 && rng.chance(0.35)) {
      world.orders.issue({ kind: "recover", squad: q.id }, this.player, tick);
      return true;
    }

    const target = this.pickTarget(q, foes);

    switch (this.style) {
      case "aggressive":
        if (target) return this.assault(world, q, target, tick);
        return this.advance(world, q, tick);

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
        if (!target) return this.advance(world, q, tick);
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
        return this.advance(world, q, tick);
    }
  }

  private assault(world: World, q: Squad, target: Squad, tick: number): boolean {
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
  private pickTarget(q: Squad, foes: readonly Squad[]): Squad | null {
    let best: Squad | null = null;
    let bestScore = Infinity;
    for (const f of foes) {
      const dx = f.anchorX - q.anchorX;
      const dy = f.anchorY - q.anchorY;
      const d = sqrt(dx * dx + dy * dy);
      // A squad already down to half strength is worth walking further for.
      const s = d * (0.6 + (f.live / f.count) * 0.8);
      if (s < bestScore || (s === bestScore && best !== null && f.id < best.id)) {
        bestScore = s;
        best = f;
      }
    }
    return best;
  }

  private near(q: Squad, other: Squad, within: number): boolean {
    const dx = other.anchorX - q.anchorX;
    const dy = other.anchorY - q.anchorY;
    return dx * dx + dy * dy <= within * within;
  }

  /** Push toward where the enemy was last seen, or the far side of the map. */
  private advance(world: World, q: Squad, tick: number): boolean {
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
