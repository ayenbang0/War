/**
 * Turns recognized gestures into Orders, and owns the selection.
 *
 * Sits between the pen and the simulation and is the only thing in input/ that
 * knows Orders exist. It never touches world state directly -- everything goes
 * through the order queue, so a recorded session replays exactly (and Phase 10
 * can ship the same order stream over the wire).
 */

import type { World } from "../sim/world.ts";
import { anchorSquad, pathLength, pointInPolygon, recognize, gestureLabel, TAP_LENGTH, type GestureContext, type PendingLine, type Point, type Recognized, type SquadView } from "./gestures.ts";
import { ABILITIES, type AbilityId } from "../content/abilities.ts";

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

/**
 * What the pen's ghost should show for the stroke in progress (ink.ts draws
 * it). One source for the ghost's label and the HUD line a commit would give,
 * so what the player reads before lifting the pen is what happens after.
 *
 *  - order:   the recognizer's reading, with a label the Commander has checked
 *             against the world (a lasso counts MEN, audit PC-07);
 *  - ability: an armed ability will take this stroke, whatever its shape
 *             (audit PC-03), so its name and footprint are shown, not an order;
 *  - place:   a deployment drag carrying a company (audit PC-04);
 *  - none:    the stroke so far means nothing, and `label` says why (PC-02).
 */
export type PenGhost =
  | { mode: "order"; read: Recognized; label: string }
  | { mode: "ability"; ability: AbilityId; label: string; radius: number }
  | { mode: "place"; label: string; ok: boolean }
  | { mode: "none"; label: string };

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
  /**
   * The ability waiting for somewhere to be put, or null.
   *
   * Arming is a keypress and PLACING is a pen stroke, which keeps the left
   * button the only thing that ever points at the world. An armed ability
   * swallows the next stroke entirely rather than also giving an order with it.
   */
  armed: AbilityId | null = null;
  /** What the recognizer currently reads the in-progress stroke as. */
  preview: Recognized | null = null;
  /** What the ghost shows for the stroke in progress; see PenGhost. */
  ghost: PenGhost | null = null;
  /**
   * Whether the last committed stroke did nothing. The pen lets such a stroke
   * fade out in grey instead of vanishing, so a stroke that meant nothing is
   * SEEN to mean nothing (audit PC-02).
   */
  rejected = false;
  /**
   * Where the player may set men down while deploying. Supplied by the battle,
   * which knows the level's zones; null means anywhere on the map.
   */
  placeable: ((x: number, y: number) => boolean) | null = null;
  /**
   * The company a deployment stroke picked up at its first point, or null.
   * Decided once per stroke: a stroke that grabbed a company is a placement
   * and is never also read as a gesture (audit PC-04).
   */
  private grabbed: number | null = null;
  private grabOffset: Point = { x: 0, y: 0 };
  private lastPlaced: Point | null = null;

  /** A split line waiting to see whether a parallel one follows. */
  private pendingLine: PendingLine = null;
  /** The route just ordered, while a retrace of it would still mean "feint". */
  private pendingRoute: number[] | null = null;
  private pendingRouteDeadline = 0;
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
      pendingRoute: nowMs() < this.pendingRouteDeadline ? this.pendingRoute : null,
    };
  }

  /**
   * Arm an ability, or disarm it if it was already armed.
   *
   * Refuses one with nothing left or still cooling down, so the interface never
   * pretends to hold something it cannot spend.
   */
  arm(id: AbilityId): string {
    if (this.armed === id) {
      this.armed = null;
      return "";
    }
    if (!this.world.abilityReady(this.player, id)) {
      const c = this.world.abilityState[this.player].get(id);
      if (!c) return ABILITIES[id].name + ": none bought";
      if (c.left <= 0) return ABILITIES[id].name + ": none left";
      return ABILITIES[id].name + ": not ready";
    }
    this.armed = id;
    return ABILITIES[id].name + " - draw where";
  }

  /**
   * Spend the armed ability at the end of a stroke.
   *
   * Returns null when nothing was armed, so the caller can fall through to the
   * ordinary reading of the stroke.
   */
  private placeArmed(points: readonly Point[]): string | null {
    const id = this.armed;
    if (id === null || points.length === 0) return null;
    this.armed = null;
    if (this.world.deploying) return this.refuse("not until the battle begins");
    if (!this.world.abilityReady(this.player, id)) return this.refuse(ABILITIES[id].name + ": not ready");

    const at = points[points.length - 1];
    // A charge is given to a company, so it needs one: whichever of your own
    // the stroke ended on, else whatever is selected.
    let squad = -1;
    if (ABILITIES[id].target === "own" && ABILITIES[id].id === "charge") {
      const on = anchorSquad(this.context(), at);
      squad = on !== null && on >= 0 ? on : (this.selected.find((h) => h >= 0) ?? -1);
      if (squad < 0) return this.refuse("charge: give it to a company");
    }
    this.world.orders.issue(
      { kind: "ability", squad, ability: id, x: at.x, y: at.y },
      this.player,
      this.world.tick + ORDER_DELAY,
    );
    return ABILITIES[id].name;
  }

  /** A recovering group has stood down and will not accept orders. */
  private locked(id: number): boolean {
    const q = this.world.groupById(id);
    return q !== undefined && q.recoverUntil > this.world.tick;
  }

  /**
   * Every living soldier of this player standing inside a drawn loop.
   *
   * Per MAN rather than per company: this is what lets a loop around half a
   * company take exactly that half.
   */
  private menInside(poly: readonly number[]): number[] {
    const s = this.world.soldiers;
    const pts: Point[] = [];
    for (let i = 0; i + 1 < poly.length; i += 2) pts.push({ x: poly[i], y: poly[i + 1] });
    const out: number[] = [];
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] !== 1 || s.player[i] !== this.player) continue;
      if (pointInPolygon(s.x[i], s.y[i], pts)) out.push(i);
    }
    return out;
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

  /**
   * Re-read an in-progress stroke. Cheap, so it runs every move.
   *
   * Pure apart from one thing: a deployment drag issues `place` orders as it
   * goes, so the company follows the pen. They are orders like any other,
   * applied by the world at the next tick boundary (audit PC-05).
   */
  update(points: readonly Point[]): void {
    if (points.length === 0) return;
    if (points.length === 1) this.beginStroke(points[0]);

    // An armed ability takes this stroke whatever its shape, so the ghost must
    // say so rather than promise the march the shape happens to resemble.
    if (this.armed !== null) {
      this.preview = null;
      const a = ABILITIES[this.armed];
      this.ghost = {
        mode: "ability", ability: a.id, radius: a.radius,
        label: this.world.deploying ? "not until the battle begins" : a.name + " here",
      };
      return;
    }

    // A company picked up while setting out is being carried, not ordered.
    if (this.world.deploying && this.grabbed !== null) {
      this.preview = null;
      if (pathLength(points) < TAP_LENGTH) {
        this.ghost = null;
        return;
      }
      const tip = points[points.length - 1];
      const ok = this.mayPlace(tip);
      if (ok) this.issuePlace(tip);
      this.ghost = { mode: "place", ok, label: ok ? "place" : "outside your ground" };
      return;
    }

    const read = points.length > 1 ? recognize(points, this.context()) : null;
    // No order ghost for a stroke that will do nothing. Previewing a march
    // during deployment would promise an order the game is about to ignore.
    this.preview =
      read && this.world.deploying && !ALLOWED_WHILE_DEPLOYING.has(read.kind) ? null : read;
    if (pathLength(points) < TAP_LENGTH && (!read || read.kind === "select")) {
      // Still a tap: nothing to say yet.
      this.ghost = null;
      return;
    }
    const label = this.preview ? this.labelFor(this.preview) : null;
    this.ghost = this.preview && label !== null
      ? { mode: "order", read: this.preview, label }
      : { mode: "none", label: this.whyNothing(read) };
  }

  /** The first point of a stroke: decide, once, whether it picked a company up. */
  private beginStroke(at: Point): void {
    this.grabbed = null;
    this.lastPlaced = null;
    this.rejected = false;
    if (!this.world.deploying || this.armed !== null) return;
    // While setting out, touching one of your own groups picks it up, so
    // placing men is a single motion rather than tap-then-drag.
    const grabbed = anchorSquad(this.context(), at);
    if (grabbed !== null && grabbed >= 0) {
      this.selected = [grabbed];
      this.grabbed = grabbed;
      // Carried by the point you took hold of, not snapped centre-to-pen: a
      // company grabbed by its edge must not jump half its width on the first
      // move (PC-04).
      const c = this.centreOf(grabbed);
      this.grabOffset = c ? { x: c.x - at.x, y: c.y - at.y } : { x: 0, y: 0 };
    }
  }

  private centreOf(squad: number): Point | null {
    const g = this.world.groupById(squad);
    if (!g) return null;
    const s = this.world.soldiers;
    let x = 0;
    let y = 0;
    let n = 0;
    for (const m of g.members) {
      if (s.alive[m] !== 1) continue;
      x += s.x[m];
      y += s.y[m];
      n++;
    }
    return n > 0 ? { x: x / n, y: y / n } : null;
  }

  private mayPlace(at: Point): boolean {
    return this.placeable === null || this.placeable(at.x, at.y);
  }

  /** Carry the grabbed company to a point: a setup order, applied at once. */
  private issuePlace(at: Point): void {
    if (this.grabbed === null) return;
    const x = at.x + this.grabOffset.x;
    const y = at.y + this.grabOffset.y;
    // One order per distinct position: a pen held still sends nothing more.
    if (this.lastPlaced && this.lastPlaced.x === x && this.lastPlaced.y === y) return;
    this.lastPlaced = { x, y };
    // Stamped for the current tick: while deploying the clock does not run,
    // and the world drains setup orders due now at every step it is given.
    this.world.orders.issue({ kind: "place", squad: this.grabbed, x, y }, this.player, this.world.tick);
  }

  /**
   * The ghost's words for a reading, checked against the world. Null when the
   * reading would in fact do nothing -- a loop that encloses no men.
   */
  private labelFor(r: Recognized): string | null {
    if (r.kind !== "lasso") return gestureLabel(r);
    // Counted the way commit() will count them: per man inside the loop, else
    // the companies it was thrown round (PC-07).
    const men = this.menInside(r.poly);
    const gathered = men.length > 0 ? men : this.soldiersBehind(r.squads);
    if (gathered.length === 0) return null;
    const taken = new Set(gathered);
    const carving = this.world.groups.some(
      (q) => q.player === this.player &&
        q.members.some((m) => taken.has(m)) &&
        q.members.some((m) => !taken.has(m)),
    );
    const n = gathered.length;
    return (carving ? "split off " : "group ") + n + (n === 1 ? " man" : " men");
  }

  /**
   * Why a stroke does nothing, in words a player can act on (PC-02). Gentle on
   * purpose: the spec asks for errors to be gently corrected, not scolded.
   */
  private whyNothing(read: Recognized | null): string {
    if (read && this.world.deploying && !ALLOWED_WHILE_DEPLOYING.has(read.kind)) {
      return "not until the battle begins";
    }
    if (read && read.kind === "lasso") return "no men inside that loop";
    if (this.selected.length === 0) return "nothing selected - draw from a company, or loop some men";
    return "no order read - try again";
  }

  cancel(): void {
    this.preview = null;
    this.ghost = null;
    this.grabbed = null;
  }

  /** Commit a finished stroke. Returns a short label for the HUD. */
  commit(points: readonly Point[]): string {
    const said = this.commitStroke(points);
    this.grabbed = null;
    this.preview = null;
    this.ghost = null;
    return said;
  }

  private refuse(why: string): string {
    this.rejected = true;
    return why;
  }

  private commitStroke(points: readonly Point[]): string {
    this.rejected = false;
    // A stroke handed over whole (the tests, the tutorial) never went through
    // update(), so it has not been checked for a grab yet.
    if (points.length > 0 && this.grabbed === null) this.beginStroke(points[0]);
    // An armed ability takes the stroke and nothing else happens with it, so
    // placing a barrage can never also march the company you drew across.
    const placed = this.placeArmed(points);
    if (placed !== null) return placed;

    // A deployment drag that carried a company puts it down where the pen
    // lifted and is never read as a glyph as well (PC-04). A short touch on a
    // company is still a tap, and falls through to select it.
    if (this.world.deploying && this.grabbed !== null && pathLength(points) >= TAP_LENGTH) {
      this.clearPending();
      const tip = points[points.length - 1];
      if (!this.mayPlace(tip)) return this.refuse("outside your ground - set them down in your own zone");
      this.issuePlace(tip);
      return "placed";
    }

    const r = recognize(points, this.context());
    if (!r) return this.refuse(this.whyNothing(null));

    if (this.world.deploying && !ALLOWED_WHILE_DEPLOYING.has(r.kind)) {
      this.clearPending();
      return this.refuse("not until the battle begins");
    }

    if (r.kind === "select") {
      this.clearPending();
      this.selected = r.squads.slice();
      return r.squads.length > 0 ? "selected" : "cleared";
    }

    // A lasso is the ONLY way a company is ever born, and it works on MEN, not
    // on companies. Drawing a loop around part of an existing company therefore
    // cuts exactly those men out of it into a new one -- createGroup already
    // takes each man out of whatever he was in and re-dresses what is left
    // behind. That is why there is no separate "divide" gesture: cutting a
    // company in two is just drawing a loop around the half you want.
    if (r.kind === "lasso") {
      this.clearPending();
      const men = this.menInside(r.poly);
      // Nothing enclosed by position: fall back to the handles the recogniser
      // caught, which is the case where a loop is thrown round a company from
      // well outside it.
      const gathered = men.length > 0 ? men : this.soldiersBehind(r.squads);
      if (gathered.length === 0) return this.refuse("no men inside that loop");
      // Is this taking men OUT of a company, or gathering men who were in none?
      // Decided across every company the loop touched, not from the first man
      // it happened to catch -- a single loose soldier caught alongside half a
      // company would otherwise make a carve look like an ordinary gather.
      const taken = new Set(gathered);
      const carving = this.world.groups.some(
        (q) => q.player === this.player &&
          q.members.some((m) => taken.has(m)) &&
          q.members.some((m) => !taken.has(m)),
      );
      const g = this.world.createGroup(this.player, gathered);
      this.selected = g ? [g.id] : [];
      if (!g) return this.refuse("no men inside that loop");
      return (carving ? "split off " : "grouped ") + g.members.length;
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

    if (r.kind === "ambush") {
      this.clearPending();
      const tick = this.world.tick + ORDER_DELAY;
      let issued = 0;
      for (const id of this.materialise(r.squads)) {
        if (this.locked(id)) continue;
        this.world.orders.issue({ kind: "ambush", squad: id }, this.player, tick);
        issued++;
      }
      return issued > 0 ? "lie in wait" : this.refuse("locked (recovering)");
    }

    if (r.kind === "feint") {
      this.clearPending();
      const tick = this.world.tick + ORDER_DELAY;
      let issued = 0;
      for (const id of this.materialise(r.squads)) {
        if (this.locked(id)) continue;
        this.world.orders.issue(
          { kind: "feint", squad: id, path: r.path.slice() }, this.player, tick,
        );
        issued++;
      }
      return issued > 0 ? "feint - advance and withdraw" : this.refuse("locked (recovering)");
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
      return issued > 0 ? "rows and columns" : this.refuse("locked (recovering)");
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
      return issued > 0 ? "patrol area" : this.refuse("locked (recovering)");
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
      return issued > 0 ? "recover (30s, cannot act)" : this.refuse("already recovering");
    }

    this.clearPending();

    // Acting on loose men gathers them first: an order needs something to be
    // given to, and that something is a group the player just implicitly drew.
    const handles = this.materialise(r.squads);
    this.selected = handles;
    const tick = this.world.tick + ORDER_DELAY;
    const n = handles.length;

    // A group that has stood down takes no orders, and the player has to be
    // TOLD that. The sim drops an order aimed at a recovering group, so without
    // this the pen answered "move" and then nothing happened for thirty
    // seconds, with nothing on screen to explain it. Every group verb already
    // reported this; the ordinary single-group orders -- the ones actually used
    // most -- silently claimed to have worked.
    let issued = 0;

    handles.forEach((id, i) => {
      if (this.locked(id)) return;
      issued++;
      // Several squads told to go to one point would pile onto the same spot
      // and grind against each other. Fan them out perpendicular to the route.
      const q = this.world.groupById(id);
      const spread = q ? q.radius * 2.4 : 80;
      const lateral = n > 1 ? (i - (n - 1) / 2) * spread : 0;

      switch (r.kind) {
        case "move":
          // Hold on to the route: retracing it inside the pair window is how a
          // feint is asked for, reusing the same window the grid gesture uses.
          this.pendingRoute = r.path.slice();
          this.pendingRouteDeadline = nowMs() + PAIR_WINDOW_MS;
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
          // While deploying the clock stands still, so the order is stamped
          // for now: the world drains setup orders due at the current tick on
          // every step it is given, which is the tick boundary (PC-05).
          this.world.orders.issue(
            { kind: "formation", squad: id, shape: r.shape }, this.player,
            this.world.deploying ? this.world.tick : tick,
          );
          return;
      }
    });

    if (issued === 0) return this.refuse("locked (recovering)");
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
