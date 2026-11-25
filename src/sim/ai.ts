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
 * world.visibleEnemies(); nothing consults a squad the fog is hiding. That goes
 * for its sense of the balance too (audit RF-07): how strong and how steady the
 * enemy is gets judged from the men it has seen and remembers, never from the
 * opponent's true totals. And it aims at where enemy soldiers were OBSERVED
 * standing (audit RF-08), not at a company's anchor -- the anchor is the order's
 * virtual point that walks the route ahead of the men, so reading it would be
 * reading the opponent's plan, which the player is never allowed to do.
 */

import { atan2, clamp, cos, min, sin, sqrt } from "./math.ts";
import type { Group, World } from "./world.ts";
import { TILE_SIZE } from "./terrain.ts";
import { UNIT_TYPES } from "../content/unit-types.ts";
import { COMMANDERS, type Commander } from "../content/commanders.ts";

/** Ticks between decisions. Re-planning every tick makes squads twitch. */
const THINK_INTERVAL = 20;
/** Ticks a squad is left alone after being given an order. */
const COMMIT_TICKS = 60;
/** Upper size for a machine-formed group. Beyond this a formation is unwieldy. */
const MAX_GROUP = 20;
/** Two enemy groups within this distance count as supporting each other. */
const SUPPORT_RANGE = 420;
/**
 * How long a sighting of an enemy company is believed after it goes out of
 * view: sixty seconds at the sim's 20 Hz. A literal rather than TICK_RATE,
 * because world.ts imports this file and reading its constant here at module
 * load would race the circular import.
 */
const MEMORY_TICKS = 60 * 20;

/** What the commander believes about one enemy company. */
type Sighting = {
  /** Where its men were seen standing: the centre of the seen ones. */
  x: number;
  y: number;
  /** How many of its men were seen. */
  n: number;
  /** Their mean nerve, as read off how they were carrying themselves. */
  morale: number;
  /** When. */
  tick: number;
};

/** The commander's estimate of the enemy army, from sightings alone. */
export type FoeEstimate = {
  /** Men seen now plus men remembered. 0 when nothing is known. */
  readonly strength: number;
  /** Their mean nerve, or -1 when nothing is known. */
  readonly morale: number;
  /** Whether any enemy has been seen at all within memory. */
  readonly known: boolean;
};

export type Playstyle = "aggressive" | "defensive" | "maneuver" | "reactive";

export const PLAYSTYLES: readonly Playstyle[] = [
  "aggressive", "defensive", "maneuver", "reactive",
];

export class ArmyAI {
  readonly player: number;
  /** How well this commander is run. Never what it can see or what it fields. */
  private think = THINK_INTERVAL;
  private commit = COMMIT_TICKS;
  private focus = 0.5;
  style: Playstyle = "reactive";
  /** Tick at which the current posture was adopted. */
  private styleSince = 0;
  /** Per-squad tick until which a squad is left to carry out its orders. */
  private readonly committedUntil = new Map<number, number>();
  /** Where the enemy was last seen, kept after they slip back into the fog. */
  private lastKnownX = 0;
  private lastKnownY = 0;
  private hasContact = false;
  /**
   * Every enemy company seen within MEMORY_TICKS, by group id. A Map keeps
   * insertion order, which is the order of first sighting -- identical on two
   * peers fed one order stream -- so summing over it is deterministic.
   */
  private readonly memory = new Map<number, Sighting>();
  /** Where each enemy company visible at this think was seen standing. */
  private readonly seenAt = new Map<number, Sighting>();
  /** Enemy soldiers in no company, seen at this think. */
  private looseSeen = 0;
  private looseMoraleSum = 0;
  /** The current estimate of the enemy, refreshed every think. */
  estimate: FoeEstimate = { strength: 0, morale: -1, known: false };

  /**
   * Who is running this army. Leanings only -- never better troops, never more
   * sight. An opponent that cheats is arbitrary rather than hard.
   */
  private commander: Commander = COMMANDERS.hare;

  constructor(
    player: number,
    tuning?: { think: number; commit: number; focus: number },
    commander?: Commander,
  ) {
    this.player = player;
    if (tuning) {
      this.think = tuning.think;
      this.commit = tuning.commit;
      this.focus = tuning.focus;
    }
    if (commander) this.commander = commander;
  }

  /** Who the player is fighting, for the menu and the after-action report. */
  get who(): Commander {
    return this.commander;
  }

  /** Called once per tick from World.step, before orders are drained. */
  update(world: World): void {
    if (world.tick % this.think !== 0) return;
    // With no inherent squads, the machine must organise its own men before it
    // can command them -- exactly as the player does with the pen.
    this.formGroups(world);
    // Look before judging: the posture is chosen from what this think saw.
    const foes = this.observe(world);
    this.chooseStyle(world);

    if (foes.length > 0) {
      // Remember where they were. A commander who forgets the enemy the instant
      // they step behind a wood is not cautious, it is amnesiac. Where they
      // were means where their MEN were seen, not where their orders point.
      let cx = 0;
      let cy = 0;
      for (const f of foes) {
        const at = this.where(f);
        cx += at.x;
        cy += at.y;
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
        this.committedUntil.set(q.id, world.tick + this.commit);
      }
    }
  }

  /**
   * Look at the field: note every enemy company in view and where its seen
   * men stand, forget sightings too old to trust, and re-estimate the enemy.
   * Returns the companies in view, the only ones a decision may act on.
   */
  private observe(world: World): Group[] {
    const foes = world.visibleEnemies(this.player);
    const s = world.soldiers;
    this.seenAt.clear();
    for (const f of foes) {
      let n = 0;
      let cx = 0;
      let cy = 0;
      let nerve = 0;
      for (const m of f.members) {
        if (s.alive[m] !== 1 || !world.canSee(this.player, m)) continue;
        n++;
        cx += s.x[m];
        cy += s.y[m];
        nerve += s.morale[m];
      }
      // seenBy says some man of it is in view, so n is at least one; guarded
      // anyway, because a sighting of nobody would divide by zero.
      if (n === 0) continue;
      const seen: Sighting = { x: cx / n, y: cy / n, n, morale: nerve / n, tick: world.tick };
      this.seenAt.set(f.id, seen);
      // Map.set keeps an existing key in place, so iterating the memory
      // walks companies in order of first sighting: deterministic on both peers.
      this.memory.set(f.id, seen);
    }
    for (const [id, seen] of this.memory) {
      if (world.tick - seen.tick > MEMORY_TICKS) this.memory.delete(id);
    }

    // Men in no company are seen one by one, and only now: a loose man has no
    // company to remember him by.
    this.looseSeen = 0;
    this.looseMoraleSum = 0;
    const foe = 1 - this.player;
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] !== 1 || s.player[i] !== foe || s.group[i] >= 0) continue;
      if (!world.canSee(this.player, i)) continue;
      this.looseSeen++;
      this.looseMoraleSum += s.morale[i];
    }

    let strength = this.looseSeen;
    let nerve = this.looseMoraleSum;
    for (const seen of this.memory.values()) {
      strength += seen.n;
      nerve += seen.morale * seen.n;
    }
    this.estimate = strength > 0
      ? { strength, morale: nerve / strength, known: true }
      : { strength: 0, morale: -1, known: false };
    return foes.filter((f) => this.seenAt.has(f.id));
  }

  /** Where a visible enemy company's men were seen standing at this think. */
  private where(g: Group): { x: number; y: number; n: number } {
    const seen = this.seenAt.get(g.id);
    // Never reached for a company out of view: observe() only hands decisions
    // the ones it saw. Falling back to nothing rather than to the anchor keeps
    // the anchor out of this file entirely.
    return seen ?? { x: 0, y: 0, n: 0 };
  }

  /**
   * Pick a posture from the situation.
   *
   * Deliberately hysteretic: a commander that flips stance every second reads
   * as noise rather than intent, so a style is held for a spell once adopted.
   */
  private chooseStyle(world: World): void {
    if (world.tick - this.styleSince < this.think * 12) return;

    const me = world.armyState(this.player);
    // The enemy as SEEN (RF-07): the men in view and the men remembered, never
    // the opponent's true totals. With nothing seen at all, assume parity --
    // the field was set for an even fight -- rather than either a walkover or
    // a rout; that prior depends on nothing the fog hides.
    const foe = this.estimate;
    const foeStrength = foe.known ? foe.strength : me.strength;
    const foeMorale = foe.known ? foe.morale : me.morale;
    // A bold commander reads the same field as more favourable than it is, and
    // so presses attacks a cautious one would refuse.
    const ratio = (foeStrength > 0 ? me.strength / foeStrength : 2) * this.commander.boldness;
    const shaken = me.morale < foeMorale - 0.12 * this.commander.boldness;

    // Score every posture the situation allows, then let the commander's
    // leanings pick between them. The situation still rules -- a commander who
    // ignored a collapsing army would be broken, not characterful -- but
    // between two defensible choices, character decides, and that is what makes
    // an opponent readable across a match.
    const fit: Record<Playstyle, number> = {
      aggressive: ratio > 1.05 && me.morale > 0.5 ? 1 : 0.12,
      defensive: shaken || me.morale < 0.4 ? 1 : 0.2,
      maneuver: ratio < 1.1 ? 0.8 : 0.4,
      reactive: 0.55,
    };
    let next: Playstyle = "reactive";
    let best = -1;
    for (const style of PLAYSTYLES) {
      const weight = fit[style] * this.commander.bias[style];
      if (weight > best) {
        best = weight;
        next = style;
      }
    }
    // A broken army holds regardless of who is in charge.
    if (me.morale < 0.28) next = "defensive";

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
        // Sappers dig where digging is worth doing, and the works they raise
        // then become ground worth holding for everyone else -- which is how a
        // position grows into a base rather than a scatter of holes.
        if (this.canDig(world, q)) {
          world.orders.issue(
            { kind: "hold", squad: q.id, x: q.anchorX, y: q.anchorY, radius: 180 },
            this.player,
            tick,
          );
          return true;
        }
        // Standing still is a decision, and it needs a reason: an objective
        // under your feet, or your own works to fight from. Otherwise go and
        // take something. Holding empty ground is refusing to play.
        if (!this.worthHolding(world, q)) return this.advance(world, q, tick);
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
        const at = this.where(target);
        const bearing = atan2(at.y - q.anchorY, at.x - q.anchorX) + side * 1.15;
        const swing = 380 + rng.range(0, 220);
        world.orders.issue(
          {
            kind: "attack",
            squad: q.id,
            target: target.id,
            path: [
              at.x + cos(bearing) * swing,
              at.y + sin(bearing) * swing,
              at.x,
              at.y,
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
    const at = this.where(target);
    world.orders.issue(
      { kind: "attack", squad: q.id, target: target.id, path: [at.x, at.y] },
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
      const at = this.where(f);
      const dx = at.x - q.anchorX;
      const dy = at.y - q.anchorY;
      const d = sqrt(dx * dx + dy * dy);
      // Divide and conquer: prefer whoever is unsupported. A group with no
      // friends within supporting distance can be destroyed before help
      // arrives, which is worth walking a long way for -- and is the whole
      // difference between an army that trades evenly and one that beats you in
      // detail. How strongly it weighs is what difficulty actually changes.
      let support = 0;
      for (const other of foes) {
        if (other === f) continue;
        const ot = this.where(other);
        const ox = ot.x - at.x;
        const oy = ot.y - at.y;
        if (ox * ox + oy * oy < SUPPORT_RANGE * SUPPORT_RANGE) support++;
      }
      const isolation = 1 / (1 + support);
      // Weakness as far as can be seen: the men in view, not the muster roll.
      const weakness = at.n * 0.04;
      const s = d * (0.6 + weakness) * (1 - this.focus * 0.6 * isolation);
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

  /** Is an enemy company, as seen, within reach of one of ours? */
  private near(q: Group, other: Group, within: number): boolean {
    const at = this.where(other);
    const dx = at.x - q.anchorX;
    const dy = at.y - q.anchorY;
    return dx * dx + dy * dy <= within * within;
  }

  /**
   * Push toward where the enemy was last seen, or go looking.
   *
   * NEVER returns false for want of somewhere to go. It used to: once a company
   * reached the last known position and found nothing there, this returned
   * false, orderGroup issued nothing at all, and the company simply stood on
   * empty ground for the rest of the battle. An army that stops having
   * intentions is not a cautious army, it is a broken one.
   */
  private advance(world: World, q: Group, tick: number): boolean {
    let tx = this.hasContact ? this.lastKnownX : world.terrain.worldWidth - this.homeX(world);
    let ty = this.hasContact ? this.lastKnownY : world.terrain.worldHeight * 0.5;
    let dx = tx - q.anchorX;
    let dy = ty - q.anchorY;
    if (dx * dx + dy * dy < 120 * 120) {
      // Arrived, and nothing here. Go and look somewhere else rather than
      // standing about: the enemy is somewhere, and the ground worth holding is
      // a better guess than the ground under your feet.
      const sweep = this.sweepTarget(world, q);
      tx = sweep.x;
      ty = sweep.y;
      dx = tx - q.anchorX;
      dy = ty - q.anchorY;
      // The last known position is stale if we stood on it and found nobody.
      this.hasContact = false;
    }
    const d = sqrt(dx * dx + dy * dy);
    if (d < 1e-3) return false;
    const step = min(d, 900);
    world.orders.issue(
      { kind: "move", squad: q.id, path: [q.anchorX + (dx / d) * step, q.anchorY + (dy / d) * step] },
      this.player,
      tick,
    );
    return true;
  }

  /**
   * Somewhere worth going when there is nothing in front of you.
   *
   * Ground first -- a control point is by definition ground somebody wants --
   * then the enemy's own side of the field. Companies are spread across the
   * candidates by id so an army searching does not walk to one spot in a
   * column, which is both useless and the easiest thing in the world to ambush.
   */
  private sweepTarget(world: World, q: Group): { x: number; y: number } {
    const points = world.controlPoints;
    if (points.length > 0) {
      const p = points[q.id % points.length];
      return { x: p.x, y: p.y };
    }
    const enemyX = world.terrain.worldWidth - this.homeX(world);
    const lanes = 3;
    const lane = (q.id % lanes) + 1;
    return {
      x: enemyX === 0 ? world.terrain.worldWidth * 0.15 : world.terrain.worldWidth * 0.85,
      y: (world.terrain.worldHeight * lane) / (lanes + 1),
    };
  }

  /**
   * Is standing here worth doing?
   *
   * Holding is a real decision when there is something under your feet to hold
   * -- an objective, or works your own sappers have raised. Holding empty
   * ground in the middle of nowhere is just refusing to play, and it was what
   * the defensive posture did by default.
   */
  private worthHolding(world: World, q: Group): boolean {
    for (const p of world.controlPoints) {
      const dx = p.x - q.anchorX;
      const dy = p.y - q.anchorY;
      if (dx * dx + dy * dy <= (p.radius + 220) * (p.radius + 220)) return true;
    }
    for (const w of world.works) {
      if (w.player !== this.player) continue;
      const dx = (w.tx + 0.5) * TILE_SIZE - q.anchorX;
      const dy = (w.ty + 0.5) * TILE_SIZE - q.anchorY;
      if (dx * dx + dy * dy <= 320 * 320) return true;
    }
    return false;
  }

  /** Does this company carry sappers? They have somewhere to be. */
  private canDig(world: World, q: Group): boolean {
    for (const m of q.members) {
      if (world.soldiers.alive[m] !== 1) continue;
      if (UNIT_TYPES[world.typeOf(m)].builds) return true;
    }
    return false;
  }

  private homeX(world: World): number {
    return this.player === 0 ? 0 : world.terrain.worldWidth;
  }

  /** Snapshot for hashing: the AI's memory is state like any other. */
  snapshot(): number[] {
    const out = [
      PLAYSTYLES.indexOf(this.style),
      this.styleSince,
      this.hasContact ? 1 : 0,
      this.lastKnownX,
      this.lastKnownY,
      this.memory.size,
    ];
    for (const [id, seen] of this.memory) out.push(id, seen.x, seen.y, seen.n, seen.morale, seen.tick);
    return out;
  }
}
