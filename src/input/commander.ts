/**
 * Turns recognized gestures into Orders, and owns the selection.
 *
 * Sits between the pen and the simulation and is the only thing in input/ that
 * knows Orders exist. It never touches world state directly -- everything goes
 * through the order queue, so a recorded session replays exactly (and Phase 10
 * can ship the same order stream over the wire).
 */

import type { World } from "../sim/world.ts";
import { anchorSquad, recognize, gestureLabel, type GestureContext, type PendingLine, type Point, type Recognized, type SquadView } from "./gestures.ts";

/**
 * Ticks between issuing an order and it taking effect. One tick keeps orders
 * landing cleanly on a boundary; Phase 10 raises it to cover network latency,
 * and nothing else has to change.
 */
const ORDER_DELAY = 1;

/**
 * How long a split line waits for a parallel partner before committing.
 *
 * The two-line grid gesture is defined as two consecutive strokes, but the
 * first of them is already a valid split on its own. Rather than applying a
 * split and then visibly undoing it, the first line is held for this long with
 * a ghost saying what a second line would do. Real milliseconds, not ticks:
 * this is interface pacing, and it never reaches the simulation -- only the
 * resulting order does, stamped with its own tick.
 */
const PAIR_WINDOW_MS = 1200;

/** Footprint of a lone soldier, for hit-testing the pen against him. */
const LOOSE_RADIUS = 9;

/**
 * What the pen may do while the board is being set out.
 *
 * Deployment is for arranging your army, not commanding it: you may select,
 * gather men into groups, dress their ranks and pick them up and put them down.
 * Marches, attacks, hold zones, patrols, withdrawals and standing down are all
 * orders for a battle that has not started, so those strokes do nothing at all.
 */
const ALLOWED_WHILE_DEPLOYING: ReadonlySet<string> = new Set([
  "select", "lasso", "formation",
]);

/** Loose soldiers get negative handles so they never collide with group ids. */
function looseHandle(soldier: number): number {
  return -(soldier + 1);
}

function isLoose(handle: number): boolean {
  return handle < 0;
}

function looseSoldier(handle: number): number {
  return -handle - 1;
}

export class Commander {
  selected: number[] = [];
  /** What the recognizer currently reads the in-progress stroke as. */
  preview: Recognized | null = null;

  /** A split line waiting to see whether a parallel one follows. */
  private pendingLine: PendingLine = null;
  private pendingKeep: number[] = [];
  private pendingDeadline = 0;

  private readonly world: World;
  private readonly player: number;

  constructor(world: World, player: number) {
    this.world = world;
    this.player = player;
  }

  /** The held rail, so the renderer can show what a second line would pair with. */
  get pendingRail(): PendingLine {
    return this.pendingLine;
  }

  /**
   * Resolve an expired pair window. Called every frame with real milliseconds;
   * a held split commits on its own if no parallel line arrives.
   */
  flushPending(nowMs: number): void {
    if (this.pendingLine === null || nowMs < this.pendingDeadline) return;
    this.selected = this.pendingKeep.slice();
    this.clearPending();
  }

  private clearPending(): void {
    this.pendingLine = null;
    this.pendingKeep = [];
    this.pendingDeadline = 0;
  }

  /**
   * Snapshot of what the player can see, as the recognizer needs it.
   *
   * Groups and lone soldiers are presented identically -- the pen does not care
   * which it is acting on. Handles are group ids as they stand, and negative
   * ids for loose soldiers, so the two never collide and this class can map
   * back without a second lookup table.
   */
  context(): GestureContext {
    const w = this.world;
    const squads: SquadView[] = [];
    for (const g of w.groups) {
      if (w.liveCount(g) === 0) continue;
      squads.push({
        id: g.id,
        player: g.player,
        x: g.anchorX,
        y: g.anchorY,
        radius: g.radius,
        size: w.liveCount(g),
        facing: g.facing,
        visible: g.player === this.player || g.seenBy[this.player],
      });
    }
    const s = w.soldiers;
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] !== 1 || s.group[i] >= 0) continue;
      squads.push({
        id: looseHandle(i),
        player: s.player[i],
        x: s.x[i],
        y: s.y[i],
        radius: LOOSE_RADIUS,
        size: 1,
        facing: s.facing[i],
        visible: s.player[i] === this.player || w.canSee(this.player, i),
      });
    }
    // Home is the map edge the player deployed on: it is what separates a
    // fighting withdrawal from an ordinary reposition.
    const homeX = this.player === 0 ? 0 : this.world.terrain.worldWidth;
    return {
      player: this.player,
      squads,
      selected: this.selected,
      homeX,
      pendingLine: this.pendingLine,
    };
  }

  /** A recovering group has stood down and will not accept orders. */
  private locked(id: number): boolean {
    const q = this.world.groupById(id);
    return q !== undefined && q.recoverUntil > this.world.tick;
  }

  /** Soldier ids behind a set of handles, groups expanded to their members. */
  private soldiersBehind(handles: readonly number[]): number[] {
    const out: number[] = [];
    for (const h of handles) {
      if (isLoose(h)) {
        out.push(looseSoldier(h));
        continue;
      }
      const g = this.world.groupById(h);
      if (g) for (const m of g.members) out.push(m);
    }
    return out;
  }

  /**
   * Turn handles into commandable groups.
   *
   * Loose soldiers cannot be ordered directly -- an order is given to a group --
   * so acting on them forms one. That is the whole model: the squad exists
   * because the player just commanded these men together.
   */
  private materialise(handles: readonly number[]): number[] {
    const out: number[] = [];
    const loose: number[] = [];
    for (const h of handles) {
      if (isLoose(h)) loose.push(looseSoldier(h));
      else if (this.world.groupById(h)) out.push(h);
    }
    if (loose.length > 0) {
      const g = this.world.createGroup(this.player, loose);
      if (g) out.push(g.id);
    }
    return out;
  }

  /** Re-read an in-progress stroke. Pure and cheap, so it runs every move. */
  update(points: readonly Point[]): void {
    const read = points.length > 1 ? recognize(points, this.context()) : null;

    // No ghost for a stroke that will do nothing. Previewing a march during
    // deployment would promise an order the game is about to ignore, which is
    // worse than showing nothing.
    this.preview =
      read && this.world.deploying && !ALLOWED_WHILE_DEPLOYING.has(read.kind) ? null : read;

    // While setting out, touching one of your own groups picks it up, so
    // placing men is a single motion rather than tap-then-drag.
    if (this.world.deploying && points.length > 0) {
      const grabbed = anchorSquad(this.context(), points[0]);
      if (grabbed !== null && grabbed >= 0) this.selected = [grabbed];
    }
  }

  cancel(): void {
    this.preview = null;
  }

  /** Commit a finished stroke. Returns a short label for the HUD. */
  commit(points: readonly Point[]): string {
    const r = recognize(points, this.context());
    this.preview = null;
    if (!r) return "";

    if (this.world.deploying && !ALLOWED_WHILE_DEPLOYING.has(r.kind)) {
      this.clearPending();
      return "not until the battle begins";
    }

    if (r.kind === "select") {
      this.clearPending();
      this.selected = r.squads.slice();
      return r.squads.length > 0 ? "selected" : "cleared";
    }

    // A lasso is the ONLY way a group is ever born. Everything enclosed is
    // gathered into one, replacing whatever groups those men were in before.
    if (r.kind === "lasso") {
      this.clearPending();
      const men = this.soldiersBehind(r.squads);
      const g = this.world.createGroup(this.player, men);
      this.selected = g ? [g.id] : [];
      return g ? "grouped " + g.members.length : "";
    }

    // -- group verbs ---------------------------------------------------------

    if (r.kind === "split") {
      // Held, not applied: a parallel line drawn within the window turns this
      // into a grid instead, and applying-then-undoing would flicker the board.
      this.pendingLine = { a: { x: r.line[0], y: r.line[1] }, b: { x: r.line[2], y: r.line[3] } };
      this.pendingKeep = r.keep.slice();
      this.pendingDeadline = nowMs() + PAIR_WINDOW_MS;
      // A line clear of the group cuts nothing; it is purely a rail awaiting a
      // partner, and saying "split 0/6" would read as a mistake.
      return r.keep.length === 0 || r.drop.length === 0
        ? "rail set  (draw a parallel line for rows)"
        : "split " + r.keep.length + "/" + r.squads.length + "  (parallel line = rows)";
    }

    if (r.kind === "divide") {
      this.clearPending();
      const id = r.squads[0];
      if (this.locked(id)) return "locked (recovering)";
      const g = this.world.groupById(id);
      if (!g) return "";
      this.world.orders.issue(
        { kind: "divide", squad: id, line: r.line.slice() },
        this.player,
        this.world.tick + ORDER_DELAY,
      );
      // The new half keeps no selection of its own: cutting a body of troops in
      // two is a decision about the board, not about what you are holding.
      return "cut in two";
    }

    if (r.kind === "grid") {
      this.clearPending();
      const tick = this.world.tick + ORDER_DELAY;
      let issued = 0;
      r.squads.forEach((id, i) => {
        if (this.locked(id)) return;
        this.world.orders.issue(
          { kind: "move", squad: id, path: [r.places[i * 2], r.places[i * 2 + 1]] },
          this.player,
          tick,
        );
        issued++;
      });
      return issued > 0 ? "rows and columns" : "locked (recovering)";
    }

    if (r.kind === "patrolArea") {
      this.clearPending();
      const tick = this.world.tick + ORDER_DELAY;
      const n = r.squads.length;
      let issued = 0;
      r.squads.forEach((id, i) => {
        if (this.locked(id)) return;
        // Spread the squads around one ring rather than stacking them on the
        // same circuit: a cordon, not a conga line.
        const phase = (i / n) * Math.PI * 2;
        const ring = r.radius * 0.62;
        const path: number[] = [];
        for (let k = 0; k < 6; k++) {
          const a = phase + (k / 6) * Math.PI * 2;
          path.push(r.x + Math.cos(a) * ring, r.y + Math.sin(a) * ring);
        }
        this.world.orders.issue({ kind: "patrol", squad: id, path }, this.player, tick);
        issued++;
      });
      return issued > 0 ? "patrol area" : "locked (recovering)";
    }

    if (r.kind === "recover") {
      this.clearPending();
      const tick = this.world.tick + ORDER_DELAY;
      let issued = 0;
      for (const id of r.squads) {
        if (this.locked(id)) continue;
        this.world.orders.issue({ kind: "recover", squad: id }, this.player, tick);
        issued++;
      }
      return issued > 0 ? "recover (30s, cannot act)" : "already recovering";
    }

    this.clearPending();

    // Acting on loose men gathers them first: an order needs something to be
    // given to, and that something is a group the player just implicitly drew.
    const handles = this.materialise(r.squads);
    this.selected = handles;
    const tick = this.world.tick + ORDER_DELAY;
    const n = handles.length;

    handles.forEach((id, i) => {
      // Several squads told to go to one point would pile onto the same spot
      // and grind against each other. Fan them out perpendicular to the route.
      const q = this.world.groupById(id);
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
          // Applied directly while deploying, because nothing is ticking to
          // drain the queue -- see World.setFormation.
          if (this.world.deploying) this.world.setFormation(id, r.shape);
          else this.world.orders.issue({ kind: "formation", squad: id, shape: r.shape }, this.player, tick);
          return;
      }
    });

    return gestureLabel(r);
  }
}

/** Real wall-clock milliseconds, used only for interface pacing. */
function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
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
