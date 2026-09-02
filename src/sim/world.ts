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

import { atan2, clamp, cos, dist, max, min, rotateToward, sin, sqrt, TAU } from "./math.ts";
import { Rng, Stream } from "./rng.ts";
import { OrderQueue, type Order } from "./orders.ts";
import { generateTerrain, Terrain, TerrainGrid, TERRAIN_INFO, TILE_SIZE } from "./terrain.ts";
import { formationSlots, formationRadius, type FormationShape } from "./formations.ts";
import { advanceToward } from "./movement.ts";
import { SpatialHash } from "./spatial.ts";
import { clearLine, findPath, smoothRoute } from "./pathfind.ts";
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
import { FogField, concealment, effectiveSight, hasLineOfSight, rangeFromHeight } from "./vision.ts";
import { ArmyAI } from "./ai.ts";
import { SPELLS, hexPenalty, mendRate, nerveShift, succourRate, wardSoak, type SpellId, type Working } from "./magic.ts";
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
const CHARGE_LULL = 40;
/** Seconds the charge bonus lasts once contact is made. */
const CHARGE_SECONDS = 2;
/** Extra damage while charging. Rewards committing at speed rather than drifting in. */
const CHARGE_BONUS = 0.45;
/** Digger-ticks of work a fieldwork costs. Eight sappers take about ten seconds. */
const FORTIFY_WORK = 1600;
/** Damage one siege-capable soldier does to works per tick. */
const BATTER_PER_ENGINE = 0.9;
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
  /** How this match is won. Defaults to breaking the enemy's nerve. */
  readonly victory?: VictoryConfig;
  /** Ground worth standing on, for the objective and point modes. */
  readonly controlPoints?: readonly ControlPoint[];
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
  readonly workings: Working[] = [];
  readonly ai: ArmyAI[] = [];
  readonly fog: [FogField, FogField];
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
  readonly breakages: { name: string; player: number; tick: number; cause: string }[] = [];

  readonly rng: {
    readonly combat: Rng;
    readonly morale: Rng;
    readonly ai: Rng;
    readonly spawn: Rng;
  };

  /** Soldiers deployed by each army, kept so morale can hold the dead on the books. */
  readonly roster: [number, number] = [0, 0];
  readonly victory: VictoryConfig;
  readonly controlPoints: readonly ControlPoint[];
  /** Which player holds each point, by index. -1 for contested or empty. */
  readonly heldBy: Int8Array;
  /** Cumulative seconds each side has spent holding enough ground. */
  readonly holdSeconds: [number, number] = [0, 0];
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
    this.steadiness = new Float64Array(this.soldiers.capacity);
    this.rng = {
      combat: Rng.create(this.seed, Stream.Combat),
      morale: Rng.create(this.seed, Stream.Morale),
      ai: Rng.create(this.seed, Stream.Ai),
      spawn: Rng.create(this.seed, Stream.Spawn),
    };
    for (const p of config.aiPlayers ?? []) this.ai.push(new ArmyAI(p, config.aiTuning));
  }

  // -- soldiers ---------------------------------------------------------------

  /**
   * Place one soldier. This is the only way anything enters the world.
   *
   * Note what it does NOT do: it creates no squad, no formation and no command
   * structure. A soldier stands where it is put, alone, until the player draws
   * a group around it.
   */
  spawnSoldier(player: number, type: UnitTypeId, x: number, y: number, facing: number): number {
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
    s.morale[id] = 1;
    s.cooldown[id] = 0;
    s.incoming[id] = 0;
    s.struckBy[id] = -1;
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
      buildTicks: 0,
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
        name: dying.name, player: dying.player, tick: this.tick, cause: "wiped out",
      });
    }
    for (const m of this.groups[at].members) {
      this.soldiers.group[m] = -1;
      this.soldiers.slot[m] = -1;
    }
    this.groups.splice(at, 1);
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
    if (this.deploying) return;
    for (const ai of this.ai) ai.update(this);
    this.applyOrders();
    this.updateGroups();
    this.rebuildHash();
    this.updateSoldiers();
    this.updateVision();
    this.castSpells();
    this.resolveCombat();
    this.applyWorkings();
    this.updateEngineering();
    this.updateMorale();
    this.updateObjectives();
    this.tick++;
    this.outcome = evaluate(this.victory, {
      armies: [this.armyState(0), this.armyState(1)],
      elapsed: this.tick / TICK_RATE,
      duration: this.duration,
      holdSeconds: this.holdSeconds,
      points: this.points,
    });
  }

  private applyOrders(): void {
    for (const order of this.orders.drain(this.tick)) this.applyOrder(order);
  }

  private applyOrder(order: Order): void {
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
      case "recover":
        g.stance = "recover";
        g.target = -1;
        g.path.length = 0;
        g.recoverUntil = this.tick + RECOVER_LOCK_SECONDS * TICK_RATE;
        return;
    }
  }

  /**
   * Turn a drawn route into a walkable one. The player draws intent, not a
   * traversable path -- a stroke crosses rivers freely -- so every leg is
   * re-routed by A* and the results concatenated.
   */
  private routeThrough(g: Group, waypoints: readonly number[]): number[] {
    g.pathRevision = this.terrain.revision;
    if (waypoints.length < 2) return [];
    const out: number[] = [];
    let cx = g.anchorX;
    let cy = g.anchorY;
    for (let i = 0; i + 1 < waypoints.length; i += 2) {
      const leg = findPath(this.terrain, cx, cy, waypoints[i], waypoints[i + 1]);
      if (leg.length === 0) break;
      for (const v of leg) out.push(v);
      cx = leg[leg.length - 2];
      cy = leg[leg.length - 1];
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
        } else if (g.stance === "move" || g.stance === "retreat") {
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
      while (budget > 1e-9 && g.path.length >= 2) {
        const r = advanceToward(this.terrain, g.anchorX, g.anchorY, g.path[0], g.path[1], budget);
        g.anchorX = r.x;
        g.anchorY = r.y;
        budget -= r.travelled;
        if (r.blocked) {
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
      g.pathRevision = rev;
      if (g.path.length < 2) continue;
      let ok = clearLine(this.terrain, g.anchorX, g.anchorY, g.path[0], g.path[1]);
      for (let i = 0; ok && i + 3 < g.path.length; i += 2) {
        ok = clearLine(this.terrain, g.path[i], g.path[i + 1], g.path[i + 2], g.path[i + 3]);
      }
      if (ok) continue;
      const gx = g.path[g.path.length - 2];
      const gy = g.path[g.path.length - 1];
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
    return slowest * FORMATION_PACE * moraleSpeedScale(morale / n);
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
        const mayEngage = g.stance !== "retreat" && g.stance !== "recover";
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
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] !== 1) continue;
      // Every soldier lights its own surroundings, grouped or not. No unit
      // perceives further than its own sight radius allows.
      this.fog[s.player[i]].stamp(
        s.x[i], s.y[i], effectiveSight(this.terrain, this.stats(i).sight, s.x[i], s.y[i]),
      );
    }
  }

  private updateVision(): void {
    if (this.tick % SIGHT_INTERVAL !== 0) return;
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
    const hidden = concealment(this.terrain, s.x[id], s.y[id]);
    const n = this.sightHash.query(s.x[id], s.y[id], MAX_SIGHT, this.watchers);
    let raycasts = 0;
    for (let k = 0; k < n; k++) {
      const eye = this.watchers[k];
      if (s.alive[eye] !== 1 || s.player[eye] !== watcher) continue;
      const reach = effectiveSight(this.terrain, this.stats(eye).sight, s.x[eye], s.y[eye]) * (1 - hidden);
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
        if (!this.woundedNear(g) && this.tick - g.lastContact > TICK_RATE * 6) continue;
        choose = "succour";
      } else if (g.stance === "attack") choose = "hex";
      else if (g.stance === "hold" || g.stance === "recover") choose = "ward";
      else if (this.woundedNear(g)) choose = "mend";
      else continue;

      const spell = SPELLS[choose];
      let tx = g.anchorX;
      let ty = g.anchorY;
      if (!spell.onAllies) {
        const foe = this.nearestVisibleFoe(g);
        if (!foe) continue;
        tx = foe.anchorX;
        ty = foe.anchorY;
      }
      this.workings.push({
        spell: choose,
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
    for (let i = 0; i < s.count; i++) {
      s.incoming[i] = 0;
      s.localShock[i] = 0;
    }
    for (const g of this.groups) g.flanked = false;

    for (let id = 0; id < s.count; id++) {
      if (s.alive[id] !== 1) continue;
      if (s.cooldown[id] > 0) {
        s.cooldown[id] -= TICK_DT;
        continue;
      }
      const st = this.stats(id);
      if (st.range > MELEE_RANGE) this.shoot(id, st);
      else this.hack(id, st);
    }
    this.applyDamage();
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
    s.incoming[victim] += dmg;
    s.struckBy[victim] = attacker;
    s.cooldown[attacker] = st.attackInterval;

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

  /** How many control points a player currently holds. */
  pointsHeldBy(player: number): number {
    let n = 0;
    for (const owner of this.heldBy) if (owner === player) n++;
    return n;
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
  private updateEngineering(): void {
    const s = this.soldiers;
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
        const tx = (g.anchorX / TILE_SIZE) | 0;
        const ty = (g.anchorY / TILE_SIZE) | 0;
        if (this.terrain.fortifiableAt(tx, ty)) {
          g.buildTicks += diggers;
          if (g.buildTicks >= FORTIFY_WORK) {
            g.buildTicks = 0;
            this.terrain.fortify(tx, ty);
          }
        } else {
          g.buildTicks = 0;
        }
      } else {
        g.buildTicks = 0;
      }

      // BREAKING DOWN. An engine with nothing to shoot turns on the works in
      // front of it: a wall it cannot get past, or a bridge better denied to
      // the enemy than left standing.
      if (breakers > 0 && (g.stance === "attack" || g.stance === "move")) {
        const reach = this.stats(g.members[0]).range;
        const target = this.nearestWorks(g.anchorX, g.anchorY, max(reach, TILE_SIZE * 2));
        if (target >= 0) {
          const tx = target % this.terrain.width;
          const ty = (target / this.terrain.width) | 0;
          this.terrain.damage(tx, ty, breakers * BATTER_PER_ENGINE);
        }
      }
    }
  }

  /**
   * The nearest works worth knocking down, by tile index, or -1.
   *
   * Walls and bridges OUTRANK woods, and the tile the company is standing on is
   * never a target. Taking the plain nearest destructible tile meant a battery
   * that happened to be parked in a forest spent the battle demolishing the
   * trees around its own feet while the wall in front of it stood untouched.
   * A wall or a bridge is an obstacle; a wood is only cover.
   *
   * Ties break on the lower tile index so two peers always pick the same wall.
   */
  private nearestWorks(x: number, y: number, reach: number): number {
    const cx = (x / TILE_SIZE) | 0;
    const cy = (y / TILE_SIZE) | 0;
    const span = max(1, (reach / TILE_SIZE) | 0);
    let best = -1;
    let bestD = reach * reach;
    let bestRank = 9;
    for (let ty = cy - span; ty <= cy + span; ty++) {
      for (let tx = cx - span; tx <= cx + span; tx++) {
        if (tx === cx && ty === cy) continue;
        if (!this.terrain.destructibleAt(tx, ty)) continue;
        const type = this.terrain.typeAt(tx, ty);
        const rank = type === Terrain.Forest ? 1 : 0;
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

  // -- morale -------------------------------------------------------------------

  /**
   * Nerve is per soldier now. A man alone feels only his own circumstances; a
   * man in a group feels its losses and its victories too, which is most of
   * what a group is for.
   */
  private updateMorale(): void {
    const s = this.soldiers;
    const window = TICK_RATE * 3;

    for (let id = 0; id < s.count; id++) {
      if (s.alive[id] !== 1) continue;
      const g = this.groupOf(id);
      const inContact = g ? this.tick - g.lastContact < window : false;

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
      this.breakages.push({ name: g.name, player: g.player, tick: this.tick, cause });
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
