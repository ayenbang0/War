/**
 * Turns recognized gestures into Orders, and owns the selection.
 *
 * Sits between the pen and the simulation and is the only thing in input/ that
 * knows Orders exist. It never touches world state directly -- everything goes
 * through the order queue, so a recorded session replays exactly (and Phase 10
 * can ship the same order stream over the wire).
 */

import type { World } from "../sim/world.ts";
import { recognize, gestureLabel, type GestureContext, type Point, type Recognized, type SquadView } from "./gestures.ts";

/**
 * Ticks between issuing an order and it taking effect. One tick keeps orders
 * landing cleanly on a boundary; Phase 10 raises it to cover network latency,
 * and nothing else has to change.
 */
const ORDER_DELAY = 1;

export class Commander {
  selected: number[] = [];
  /** What the recognizer currently reads the in-progress stroke as. */
  preview: Recognized | null = null;

  private readonly world: World;
  private readonly player: number;

  constructor(world: World, player: number) {
    this.world = world;
    this.player = player;
  }

  /** Snapshot of what the player can see, as the recognizer needs it. */
  context(): GestureContext {
    const squads: SquadView[] = this.world.squads.map((q) => ({
      id: q.id,
      player: q.player,
      x: q.anchorX,
      y: q.anchorY,
      radius: q.radius,
      facing: q.facing,
      // Phase 4 replaces this with real line-of-sight.
      visible: true,
    }));
    // Home is the map edge the player deployed on: it is what separates a
    // fighting withdrawal from an ordinary reposition.
    const homeX = this.player === 0 ? 0 : this.world.terrain.worldWidth;
    return { player: this.player, squads, selected: this.selected, homeX };
  }

  /** Re-read an in-progress stroke. Pure and cheap, so it runs every move. */
  update(points: readonly Point[]): void {
    this.preview = points.length > 1 ? recognize(points, this.context()) : null;
  }

  cancel(): void {
    this.preview = null;
  }

  /** Commit a finished stroke. Returns a short label for the HUD. */
  commit(points: readonly Point[]): string {
    const r = recognize(points, this.context());
    this.preview = null;
    if (!r) return "";

    if (r.kind === "select") {
      this.selected = r.squads.slice();
      return r.squads.length > 0 ? "selected" : "cleared";
    }

    // Acting on a squad also selects it, so the next gesture can follow up
    // without re-targeting.
    this.selected = r.squads.slice();
    const tick = this.world.tick + ORDER_DELAY;
    const n = r.squads.length;

    r.squads.forEach((id, i) => {
      // Several squads told to go to one point would pile onto the same spot
      // and grind against each other. Fan them out perpendicular to the route.
      const q = this.world.squadById(id);
      const spread = q ? q.radius * 2.4 : 80;
      const lateral = n > 1 ? (i - (n - 1) / 2) * spread : 0;

      switch (r.kind) {
        case "move":
          this.world.orders.issue(
            { kind: "move", squad: id, path: fanOut(r.path, lateral) },
            this.player,
            tick,
          );
          return;
        case "attack":
          this.world.orders.issue(
            { kind: "attack", squad: id, target: r.target, path: fanOut(r.path, lateral) },
            this.player,
            tick,
          );
          return;
        case "retreat":
          this.world.orders.issue(
            { kind: "retreat", squad: id, path: fanOut(r.path, lateral) },
            this.player,
            tick,
          );
          return;
        case "patrol":
          this.world.orders.issue(
            { kind: "patrol", squad: id, path: fanOut(r.path, lateral) },
            this.player,
            tick,
          );
          return;
        case "hold": {
          // Spread hold positions around the drawn centre rather than stacking.
          const angle = n > 1 ? (i / n) * Math.PI * 2 : 0;
          const ring = n > 1 ? Math.min(r.radius * 0.6, spread) : 0;
          this.world.orders.issue(
            {
              kind: "hold",
              squad: id,
              x: r.x + Math.cos(angle) * ring,
              y: r.y + Math.sin(angle) * ring,
              radius: r.radius,
            },
            this.player,
            tick,
          );
          return;
        }
        case "formation":
          this.world.orders.issue({ kind: "formation", squad: id, shape: r.shape }, this.player, tick);
          return;
      }
    });

    return gestureLabel(r);
  }
}

/** Shift a whole route sideways, keeping its shape. */
function fanOut(path: readonly number[], lateral: number): number[] {
  const out = path.slice();
  if (lateral === 0 || path.length < 2) return out;
  // Perpendicular to the route's overall heading.
  const dx = path[path.length - 2] - path[0];
  const dy = path[path.length - 1] - path[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return out;
  const px = (-dy / len) * lateral;
  const py = (dx / len) * lateral;
  for (let i = 0; i < out.length; i += 2) {
    out[i] += px;
    out[i + 1] += py;
  }
  return out;
}
