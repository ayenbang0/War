/**
 * Headless determinism and correctness harness.
 *
 * Runs the simulation with no browser, no canvas, no rAF -- which is only
 * possible because src/sim/ is pure. The replay and golden checks are the
 * regression suite for the whole simulation and the desync detector for
 * Phase 10 netplay.
 */

import { World, TICK_RATE, RECOVER_LOCK_SECONDS } from "../src/sim/world.ts";
import type { Group } from "../src/sim/entities.ts";

/**
 * Spawn a body of one type and immediately group it.
 *
 * There are no inherent squads any more -- soldiers are the entities and groups
 * are drawn by the player -- so a test that wants "a squad of line infantry"
 * has to do what the player does: place the men, then draw a group round them.
 */
function unit(
  w: World, player: number, type: UnitTypeId, x: number, y: number, facing: number,
): Group {
  const ids: number[] = [];
  const n = UNIT_TYPES[type].soldiers;
  for (let i = 0; i < n; i++) {
    ids.push(w.spawnSoldier(player, type, x + (i % 5) * 12, y + ((i / 5) | 0) * 12, facing));
  }
  return w.createGroup(player, ids) as Group;
}

/** Mean nerve of a group's living members. */
function moraleOf(w: World, g: Group): number {
  let sum = 0;
  let n = 0;
  for (const m of g.members) {
    if (w.soldiers.alive[m] !== 1) continue;
    sum += w.soldiers.morale[m];
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

/** Move a whole group somewhere, men and anchor together. */
function place(w: World, g: Group, x: number, y: number): void {
  g.anchorX = x;
  g.anchorY = y;
  g.stance = "idle";
  g.path.length = 0;
  g.members.forEach((m, i) => {
    w.soldiers.x[m] = x + (i % 5) * 12;
    w.soldiers.y[m] = y + ((i / 5) | 0) * 12;
  });
}
import { MELEE_RANGE } from "../src/sim/combat.ts";
import { evaluate, score } from "../src/sim/victory.ts";
import { effectiveSight, hasLineOfSight, rangeFromHeight, FogField } from "../src/sim/vision.ts";
import { PLAYSTYLES } from "../src/sim/ai.ts";
import { COMMANDERS, COMMANDER_IDS, type CommanderId } from "../src/content/commanders.ts";
import { ABILITIES, ABILITY_IDS, abilityCost } from "../src/content/abilities.ts";
import { BRACE_SLOWDOWN, BRACE_SOAK, FORTIFY_SOAK, SPECIALS } from "../src/content/specials.ts";
import { DOCTRINES, DOCTRINE_IDS } from "../src/content/doctrines.ts";
import { DEFAULT_BUDGET, MAX_SQUADS, adviseFor, cost, defaultArmy, suggestArmy, validate } from "../src/content/army.ts";
import { LEVELS } from "../src/content/levels/index.ts";
import { statsFor } from "../src/sim/world.ts";
import { OFFENSIVE_SPELLS, SPELLS, SPELL_IDS, SUPPORTIVE_SPELLS, hexPenalty, wardSoak, type SpellId } from "../src/sim/magic.ts";
import { hitDamage } from "../src/sim/combat.ts";
import { ROUT_THRESHOLD } from "../src/sim/morale.ts";
import { hashWorld, hashTerrain, hashRngStream, hashPaths } from "../src/sim/hash.ts";
import { Rng, Stream } from "../src/sim/rng.ts";
import * as M from "../src/sim/math.ts";
import { provingGround } from "../src/content/levels/proving-ground.ts";
import { generateTerrain, Terrain, TERRAIN_INFO, TILE_SIZE } from "../src/sim/terrain.ts";
import { formationSlots, formationRadius, FORMATION_SHAPES } from "../src/sim/formations.ts";
import { findPath, smoothRoute } from "../src/sim/pathfind.ts";
import { UNIT_TYPES, UNIT_TYPE_IDS, type UnitTypeId } from "../src/content/unit-types.ts";
import type { Order } from "../src/sim/orders.ts";
import { runConfusionMatrix, printMatrix } from "./test-gestures.ts";
import { recognize, type GestureContext, type SquadView } from "../src/input/gestures.ts";
import { Commander } from "../src/input/commander.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log("  PASS  " + name);
  else {
    failures++;
    console.log("  FAIL  " + name + (detail ? "  <- " + detail : ""));
  }
}

function section(name: string): void {
  console.log("");
  console.log(name);
}

// -- 1. math -------------------------------------------------------------------

section("math");
{
  let worstSin = 0;
  let worstAtan2 = 0;
  for (let i = -720; i <= 720; i++) {
    const a = (i / 720) * 12;
    worstSin = Math.max(worstSin, Math.abs(M.sin(a) - Math.sin(a)));
    worstSin = Math.max(worstSin, Math.abs(M.cos(a) - Math.cos(a)));
  }
  for (let i = 0; i < 512; i++) {
    const a = (i / 512) * M.TAU - M.PI;
    const x = Math.cos(a) * 7.3;
    const y = Math.sin(a) * 7.3;
    worstAtan2 = Math.max(worstAtan2, Math.abs(M.wrapAngle(M.atan2(y, x) - Math.atan2(y, x))));
  }
  check("sin/cos within 1e-9 of native", worstSin < 1e-9, "worst " + worstSin.toExponential(2));
  check("atan2 within 1e-4 rad of native", worstAtan2 < 1e-4, "worst " + worstAtan2.toExponential(2));
  check("atan2 quadrants", M.atan2(0, -1) > 3.14 && M.atan2(-1, 0) < -1.57 + 1e-9);
  check("wrapAngle folds to [-PI, PI)", M.wrapAngle(M.TAU * 3 + 1) - 1 < 1e-9);
}

// -- 2. rng --------------------------------------------------------------------

section("rng");
{
  const a = Rng.create(1234, Stream.Combat);
  const b = Rng.create(1234, Stream.Combat);
  const c = Rng.create(1234, Stream.Morale);
  const seqA: number[] = [];
  const seqB: number[] = [];
  const seqC: number[] = [];
  for (let i = 0; i < 2000; i++) {
    seqA.push(a.nextU32());
    seqB.push(b.nextU32());
    seqC.push(c.nextU32());
  }
  check("same seed + stream reproduces stream", seqA.join() === seqB.join());
  check("different streams diverge", seqA.join() !== seqC.join());

  const r = Rng.create(99, Stream.Spawn);
  let sum = 0;
  let lo = 1;
  let hi = 0;
  for (let i = 0; i < 100000; i++) {
    const v = r.nextFloat();
    sum += v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  check("nextFloat mean ~0.5", Math.abs(sum / 100000 - 0.5) < 0.01);
  check("nextFloat stays in [0,1)", lo >= 0 && hi < 1);

  const buckets = new Array(6).fill(0);
  const d = Rng.create(7, Stream.Ai);
  for (let i = 0; i < 60000; i++) buckets[d.int(6)]++;
  check("int(n) covers all buckets evenly", buckets.every((n) => n > 9000 && n < 11000));

  const st = r.snapshot();
  const before = r.nextU32();
  r.restore(st);
  check("snapshot/restore round-trips", r.nextU32() === before);
}

// -- 3. formations -------------------------------------------------------------

section("formations");
{
  let allFinite = true;
  let allCentred = true;
  let allSpaced = true;
  for (const shape of FORMATION_SHAPES) {
    for (const count of [1, 2, 3, 7, 10, 14, 16, 20]) {
      const slots = new Float64Array(count * 2);
      formationSlots(shape, count, slots);
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < count; i++) {
        if (!Number.isFinite(slots[i * 2]) || !Number.isFinite(slots[i * 2 + 1])) allFinite = false;
        sx += slots[i * 2];
        sy += slots[i * 2 + 1];
      }
      // The anchor must sit at the formation's centre of mass, or the squad
      // pivots about a corner and the whole shape swings when it turns.
      const r = Math.max(formationRadius(slots, count), 1);
      if (Math.abs(sx / count) > r * 0.2 || Math.abs(sy / count) > r * 0.2) allCentred = false;

      // No two soldiers may be assigned the same spot.
      for (let i = 0; i < count && allSpaced; i++) {
        for (let j = i + 1; j < count; j++) {
          const dx = slots[i * 2] - slots[j * 2];
          const dy = slots[i * 2 + 1] - slots[j * 2 + 1];
          if (dx * dx + dy * dy < 1) {
            allSpaced = false;
            break;
          }
        }
      }
    }
  }
  check("all shapes produce finite slots", allFinite);
  check("all shapes are centred on the anchor", allCentred);
  check("no two slots coincide", allSpaced);

  // Shape identity: a column must be deeper than wide, a line the reverse.
  function extent(shape: (typeof FORMATION_SHAPES)[number], n: number): { w: number; d: number } {
    const slots = new Float64Array(n * 2);
    formationSlots(shape, n, slots);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, slots[i * 2]);
      maxX = Math.max(maxX, slots[i * 2]);
      minY = Math.min(minY, slots[i * 2 + 1]);
      maxY = Math.max(maxY, slots[i * 2 + 1]);
    }
    return { w: maxY - minY, d: maxX - minX };
  }
  const line = extent("line", 20);
  const column = extent("column", 20);
  const loose = extent("loose", 20);
  const tight = extent("tight", 20);
  check("line is wider than deep", line.w > line.d * 2, line.w.toFixed(0) + " x " + line.d.toFixed(0));
  check("column is deeper than wide", column.d > column.w * 2, column.w.toFixed(0) + " x " + column.d.toFixed(0));
  check("loose is wider than line", loose.w > line.w);
  check("tight is narrower than line", tight.w < line.w);
}

// -- 4. terrain ----------------------------------------------------------------

section("terrain");
{
  const g = generateTerrain(provingGround.tilesWide, provingGround.tilesHigh, provingGround.seed);
  const total = g.type.length;
  const counts = new Map<number, number>();
  for (const t of g.type) counts.set(t, (counts.get(t) ?? 0) + 1);
  const share = (t: number): number => (counts.get(t) ?? 0) / total;
  const passable = g.type.reduce((n, t) => n + (TERRAIN_INFO[t as 0].moveScale > 0 ? 1 : 0), 0);

  function reachable(allowBridge: boolean): number {
    const seen = new Uint8Array(total);
    let start = -1;
    for (let y = 0; y < g.height && start < 0; y++) if (g.passableAt(0, y)) start = y * g.width;
    if (start < 0) return 0;
    const stack = [start];
    seen[start] = 1;
    let n = 0;
    const steps = [1, 0, -1, 0, 0, 1, 0, -1];
    while (stack.length > 0) {
      const i = stack.pop() as number;
      n++;
      const x = i % g.width;
      const y = (i / g.width) | 0;
      for (let k = 0; k < 8; k += 2) {
        const nx = x + steps[k];
        const ny = y + steps[k + 1];
        if (!g.inBounds(nx, ny)) continue;
        const j = ny * g.width + nx;
        if (seen[j] === 1) continue;
        const t = g.typeAt(nx, ny);
        if (t === Terrain.Water) continue;
        if (!allowBridge && t === Terrain.Bridge) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    return n;
  }

  check("map is mostly passable", passable / total > 0.85);

  // -- the varied terrain ---------------------------------------------------
  check("mountains, marsh, roads and scree all appear",
    share(Terrain.Mountain) > 0.001 && share(Terrain.Marsh) > 0.005 &&
      share(Terrain.Road) > 0.005 && share(Terrain.Scree) > 0.01,
    ["mountain", "marsh", "road", "scree"]
      .map((n, i) => n + " " + (share([Terrain.Mountain, Terrain.Marsh, Terrain.Road, Terrain.Scree][i]) * 100).toFixed(1) + "%")
      .join(", "));

  check("roads are the only ground faster than open field",
    TERRAIN_INFO[Terrain.Road].moveScale > 1 &&
      [Terrain.Plain, Terrain.Forest, Terrain.Hill, Terrain.Marsh, Terrain.Scree, Terrain.Bridge]
        .every((t) => TERRAIN_INFO[t].moveScale <= 1),
    "road " + TERRAIN_INFO[Terrain.Road].moveScale + "x");

  check("marsh is a trap, not an obstacle: slow and with no cover",
    TERRAIN_INFO[Terrain.Marsh].moveScale > 0 &&
      TERRAIN_INFO[Terrain.Marsh].moveScale < 0.6 &&
      TERRAIN_INFO[Terrain.Marsh].cover === 0);

  check("mountains are impassable and block sight",
    TERRAIN_INFO[Terrain.Mountain].moveScale === 0 && TERRAIN_INFO[Terrain.Mountain].blocksSight);

  // Mountains create passes; they must never seal the map into halves. A range
  // that walls off a third of the board makes a level unplayable, not tactical.
  {
    const seen = new Uint8Array(total);
    let first = -1;
    for (let y = 0; y < g.height && first < 0; y++) if (g.passableAt(0, y)) first = y * g.width;
    const stack = [first];
    seen[first] = 1;
    let reached = 0;
    const steps = [1, 0, -1, 0, 0, 1, 0, -1];
    while (stack.length > 0) {
      const i = stack.pop() as number;
      reached++;
      const x = i % g.width;
      const y = (i / g.width) | 0;
      for (let k = 0; k < 8; k += 2) {
        const nx = x + steps[k];
        const ny = y + steps[k + 1];
        if (!g.inBounds(nx, ny)) continue;
        const j = ny * g.width + nx;
        if (seen[j] === 1 || !g.passableAt(nx, ny)) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    check("mountains leave passes rather than sealing the map",
      reached > passable * 0.98,
      (reached / passable * 100).toFixed(1) + "% of walkable ground reachable");
  }
  check("river exists", share(Terrain.Water) > 0.01);
  check("bridges were carved", (counts.get(Terrain.Bridge) ?? 0) > 0);
  check("forest and hills both present", share(Terrain.Forest) > 0.03 && share(Terrain.Hill) > 0.03);
  check("river genuinely splits the map", reachable(false) < passable * 0.75);
  check("bridges reconnect both halves", reachable(true) > passable * 0.95);
}

// -- 5. pathfinding ------------------------------------------------------------

/** A fixed set of routes, reused for both the correctness and golden checks. */
const PATH_PROBES: readonly (readonly number[])[] = [
  [400, 400, 5700, 3700], [400, 3700, 5700, 400], [1000, 2000, 5000, 2000],
  [2000, 500, 4000, 3500], [600, 1200, 3200, 1200], [3200, 1200, 600, 1200],
  [800, 800, 800, 3200], [5400, 600, 900, 3400], [2600, 2000, 3600, 2100],
  [1500, 3000, 4500, 900], [300, 2048, 5800, 2048], [4000, 200, 1200, 3900],
  [2048, 128, 2048, 3968], [900, 1500, 5200, 2900], [3000, 3000, 1000, 500],
  [700, 2600, 4800, 1400], [5000, 3400, 1400, 700], [2200, 800, 4600, 3300],
  [1800, 2400, 5600, 1000], [4400, 1600, 1100, 2900],
];

const pathResults: number[][] = [];

section("pathfinding");
{
  const g = generateTerrain(provingGround.tilesWide, provingGround.tilesHigh, provingGround.seed);

  let allFound = 0;
  let allPassable = true;
  let usedBridges = 0;
  for (const p of PATH_PROBES) {
    const route = findPath(g, p[0], p[1], p[2], p[3]);
    pathResults.push(route);
    if (route.length >= 2) allFound++;
    // Every waypoint must stand on walkable ground.
    for (let i = 0; i < route.length; i += 2) {
      if (TERRAIN_INFO[g.typeAtWorld(route[i], route[i + 1])].moveScale <= 0) allPassable = false;
    }
    // A route that crosses the map must use a bridge; the river has no fords.
    if (Math.sign(p[0] - 3072) !== Math.sign(p[2] - 3072)) {
      let crossed = false;
      let cx = p[0];
      let cy = p[1];
      for (let i = 0; i < route.length; i += 2) {
        const steps = Math.ceil(Math.hypot(route[i] - cx, route[i + 1] - cy) / (TILE_SIZE * 0.4)) + 1;
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          if (g.typeAtWorld(cx + (route[i] - cx) * t, cy + (route[i + 1] - cy) * t) === Terrain.Bridge) {
            crossed = true;
          }
        }
        cx = route[i];
        cy = route[i + 1];
      }
      if (crossed) usedBridges++;
    }
  }
  check("every probe route was found", allFound === PATH_PROBES.length, allFound + "/" + PATH_PROBES.length);
  check("every waypoint is on passable ground", allPassable);
  check("cross-map routes go via bridges", usedBridges >= 8, usedBridges + " confirmed crossings");

  // Determinism: identical inputs, identical routes, every time.
  let stable = true;
  for (let rep = 0; rep < 3; rep++) {
    const g2 = generateTerrain(provingGround.tilesWide, provingGround.tilesHigh, provingGround.seed);
    for (let i = 0; i < PATH_PROBES.length; i++) {
      const p = PATH_PROBES[i];
      if (findPath(g2, p[0], p[1], p[2], p[3]).join() !== pathResults[i].join()) stable = false;
    }
  }
  check("routes are reproducible across runs", stable);

  // The forward loop always primes the shared scratch in the same sequence, so
  // it cannot detect epoch or stamp leakage between searches. Walking the same
  // probes backwards gives each search a different scratch history.
  let orderIndependent = true;
  const g3 = generateTerrain(provingGround.tilesWide, provingGround.tilesHigh, provingGround.seed);
  for (let i = PATH_PROBES.length - 1; i >= 0; i--) {
    const p = PATH_PROBES[i];
    if (findPath(g3, p[0], p[1], p[2], p[3]).join() !== pathResults[i].join()) orderIndependent = false;
  }
  check("routes do not depend on search order", orderIndependent);

  // String pulling must actually pull: a raw grid path would have hundreds of
  // waypoints, one per tile.
  const avg = pathResults.reduce((n, r) => n + r.length / 2, 0) / pathResults.length;
  check("routes are string-pulled, not tile-by-tile", avg < 40, "avg " + avg.toFixed(1) + " waypoints");

  const blocked = findPath(g, 400, 400, -9999, -9999);
  check("out-of-bounds goal does not throw", Array.isArray(blocked));
}

// -- 6. army setup shared by the replay and performance checks -----------------

/** A realistic order of battle: 15 squads a side, the spec's stated cap. */
const ARMY: readonly UnitTypeId[] = [
  "line", "line", "line", "line", "line",
  "skirmisher", "skirmisher", "skirmisher", "skirmisher",
  "archer", "archer", "archer",
  "horse", "horse",
  "guard",
];

function buildWorld(): World {
  const w = new World({
    seed: provingGround.seed,
    tilesWide: provingGround.tilesWide,
    tilesHigh: provingGround.tilesHigh,
    soldierCapacity: 2048,
  });
  for (const zone of provingGround.deployment) {
    for (let i = 0; i < ARMY.length; i++) {
      const x = (zone.x + 4 + (i % 3) * 7) * TILE_SIZE;
      const y = (zone.y + 5 + ((i / 3) | 0) * 10) * TILE_SIZE;
      unit(w, zone.player, ARMY[i], x, y, zone.player === 0 ? 0 : M.PI);
    }
  }
  return w;
}

/**
 * A second scenario that actually fights.
 *
 * The march run above never brings the armies into contact -- they start some
 * 4500 world units apart and cover a third of that in 90 seconds -- so on its
 * own it pins movement and pathing while leaving every line of combat, morale
 * and victory code unhashed. This one deploys the two armies within bowshot in
 * the open and orders them straight at each other.
 */
function buildClash(): World {
  const w = new World({
    seed: provingGround.seed ^ 0x1d,
    tilesWide: provingGround.tilesWide,
    tilesHigh: provingGround.tilesHigh,
    duration: 15 * 60,
  });
  // Open plain, well clear of the river, so terrain does not decide the fight.
  for (let i = 0; i < ARMY.length; i++) {
    const row = i % 5;
    const col = (i / 5) | 0;
    unit(w, 0, ARMY[i], 1500 - col * 150, 1500 + row * 150, 0);
    unit(w, 1, ARMY[i], 2150 + col * 150, 1500 + row * 150, M.PI);
  }
  for (const q of w.groups) {
    const foe = w.groups.find((o) => o.player !== q.player && o.members.length > 0);
    if (!foe) continue;
    w.orders.issue(
      { kind: "attack", squad: q.id, target: foe.id, path: [foe.anchorX, foe.anchorY] },
      q.player,
      2 + (q.id % 4),
    );
  }
  return w;
}

/** Scripted opening: both sides advance on the river, then wheel. */
function scriptOrders(w: World): Order[] {
  const log: Order[] = [];
  for (const q of w.groups) {
    const toward = q.player === 0 ? 1 : -1;
    log.push(
      w.orders.issue(
        {
          kind: "move",
          squad: q.id,
          path: [q.anchorX + toward * 950, q.anchorY - 210, q.anchorX + toward * 1650, q.anchorY + 280],
        },
        q.player,
        8 + (q.id % 6) * 4,
      ),
    );
  }
  return log;
}

// -- 7. replay determinism -----------------------------------------------------

const TICKS = TICK_RATE * 90; // 90 simulated seconds

function replay(log: Order[]): { hashes: string[]; final: string; world: World } {
  const w = buildWorld();
  for (const o of log) w.orders.push(o);
  const hashes: string[] = [];
  for (let t = 0; t < TICKS; t++) {
    w.step();
    if (t % 10 === 0) hashes.push(hashWorld(w));
  }
  return { hashes, final: hashWorld(w), world: w };
}

section("replay");
const liveWorld = buildWorld();
const liveFinal = (() => {
  const log = scriptOrders(liveWorld);
  const hashes: string[] = [];
  const t0 = Date.now();
  for (let t = 0; t < TICKS; t++) {
    liveWorld.step();
    if (t % 10 === 0) hashes.push(hashWorld(liveWorld));
  }
  const elapsed = Date.now() - t0;
  const final = hashWorld(liveWorld);

  const a = replay(log);
  const b = replay(log);
  check("live run matches replay tick-for-tick", hashes.join() === a.hashes.join());
  check("two replays are identical", a.hashes.join() === b.hashes.join());
  check("final hashes agree", final === a.final && a.final === b.final);

  const shifted = log.map((o, i) => (i === 0 ? { ...o, tick: o.tick + 1 } : o));
  check("perturbed order log diverges in the trace", replay(shifted).hashes.join() !== a.hashes.join());

  const soldiers = liveWorld.soldiers.count;
  const expected = provingGround.deployment.length * ARMY.reduce((n, t) => n + UNIT_TYPES[t].soldiers, 0);
  check("all squads and soldiers spawned", liveWorld.groups.length === ARMY.length * 2 && soldiers === expected,
    liveWorld.groups.length + " squads, " + soldiers + " soldiers");

  // Performance, measured at the real target scale rather than extrapolated.
  const perTick = elapsed / TICKS;
  check("sim cost stays inside a 20 Hz tick budget", perTick < 50, perTick.toFixed(3) + " ms/tick");
  console.log("");
  console.log("  soldiers    " + soldiers);
  console.log("  sim cost    " + perTick.toFixed(3) + " ms/tick  (" +
    (TICKS / 20 / (elapsed / 1000)).toFixed(0) + "x real time)");
  return final;
})();

// -- 8. movement and formation integrity --------------------------------------

section("movement");
{
  const w = liveWorld;
  let anyOnWater = 0;
  for (let i = 0; i < w.soldiers.count; i++) {
    if (w.soldiers.alive[i] !== 1) continue;
    if (TERRAIN_INFO[w.terrain.typeAtWorld(w.soldiers.x[i], w.soldiers.y[i])].moveScale <= 0) anyOnWater++;
  }
  check("no soldier ends up standing on water", anyOnWater === 0, anyOnWater + " soldiers in the river");

  // Cohesion is only meaningful where the formation can physically exist. A
  // squad halted with half its frontage in a river SHOULD read as ragged --
  // that is the deformation working, not a bug -- so it is measured separately
  // from squads standing on ground that can actually hold the shape.
  let worstOpen = 1;
  let deformed = 0;
  for (const q of w.groups) {
    const c = Math.cos(q.facing);
    const sn = Math.sin(q.facing);
    let blockedSlots = 0;
    for (let i = 0; i < q.members.length; i++) {
      const tx = q.anchorX + q.slots[i * 2] * c - q.slots[i * 2 + 1] * sn;
      const ty = q.anchorY + q.slots[i * 2] * sn + q.slots[i * 2 + 1] * c;
      if (TERRAIN_INFO[w.terrain.typeAtWorld(tx, ty)].moveScale <= 0) blockedSlots++;
    }
    if (blockedSlots > 0) deformed++;
    else if (q.cohesion < worstOpen) worstOpen = q.cohesion;
  }
  check("squads on open ground hold formation", worstOpen > 0.85,
    "worst " + worstOpen.toFixed(2) + " (" + deformed + " squads terrain-deformed)");

  // A clean march with no terrain interference, in a world built for it: one
  // group and one distant opponent, so this measures the formation and not how
  // well it shoulders through an entire deployment zone.
  const w3 = new World({
    seed: provingGround.seed,
    tilesWide: provingGround.tilesWide,
    tilesHigh: provingGround.tilesHigh,
    soldierCapacity: 256,
  });
  const marcher = unit(w3, 0, "line", 900, 1400, 0);
  unit(w3, 1, "line", 5200, 1400, M.PI);
  // Start them stacked, so forming up is part of what is measured.
  for (const m of marcher.members) {
    w3.soldiers.x[m] = 900;
    w3.soldiers.y[m] = 1400;
  }
  w3.orders.issue({ kind: "move", squad: marcher.id, path: [1900, 1400, 1900, 2400] }, 0, 1);

  let worstMarch = 1;
  let settled = false;
  for (let t = 0; t < 3000; t++) {
    w3.step();
    // Allow time to dress ranks from a standing start before judging it.
    if (t > 200) worstMarch = Math.min(worstMarch, marcher.cohesion);
    if (marcher.stance === "idle" && t > 200) {
      settled = true;
      break;
    }
  }
  // Two separate claims, because they are different things. Straight marching
  // should be tidy. A hard ninety-degree wheel legitimately disorders the
  // formation for a moment -- soldiers move at their own pace and cannot sprint
  // to hold station on the outside of a turn -- so what matters there is that
  // it is bounded and that the ranks re-form once the turn is done.
  check("a formation stays tidy and completes its march", settled,
    settled ? "arrived" : "never arrived");
  check("wheeling disorders the ranks but does not break them", worstMarch > 0.45,
    "worst mid-march cohesion " + worstMarch.toFixed(2));
  check("the formation re-forms after the wheel", marcher.cohesion >= 0.85,
    "cohesion on arrival " + marcher.cohesion.toFixed(2));

  // Soldiers are a second movement integrator; the half-tile bound has to hold
  // for them too, not just for squad anchors. Drive squads at a river directly.
  const w2 = buildWorld();
  const g = w2.terrain;
  let placed = 0;
  for (const q of w2.groups) {
    if (placed >= 6) break;
    // Park the squad on the west bank and order it straight across.
    for (let ty = 10; ty < g.height - 10 && placed < 6; ty += 17) {
      let tx = 4;
      while (tx < g.width - 2 && g.typeAt(tx, ty) !== Terrain.Water) tx++;
      if (tx >= g.width - 2 || g.typeAt(tx - 2, ty) === Terrain.Bridge) continue;
      q.anchorX = (tx - 2) * TILE_SIZE;
      q.anchorY = (ty + 0.5) * TILE_SIZE;
      for (let i = 0; i < q.members.length; i++) {
        w2.soldiers.x[q.members[i]] = q.anchorX;
        w2.soldiers.y[q.members[i]] = q.anchorY;
      }
      // Dense polyline straight into the river, bypassing the pathfinder.
      const dense: number[] = [];
      for (let s = 1; s <= 260; s++) dense.push(q.anchorX + s, q.anchorY);
      q.path = dense;
      q.stance = "move";
      placed++;
      break;
    }
  }
  for (let t = 0; t < 200; t++) w2.step();
  let crossed = 0;
  for (let i = 0; i < w2.soldiers.count; i++) {
    if (w2.soldiers.alive[i] !== 1) continue;
    if (TERRAIN_INFO[g.typeAtWorld(w2.soldiers.x[i], w2.soldiers.y[i])].moveScale <= 0) crossed++;
  }
  check("dense paths were exercised against the river", placed >= 4, placed + " squads placed");

  // A unit that somehow ENDS UP on impassable ground -- a spawn error today, a
  // flooded tile once Phase 8 can change terrain underfoot -- must be able to
  // walk out. Refusing every step that touches water also refuses every step
  // out of it, which strands the unit permanently.
  {
    const w4 = buildWorld();
    const g4 = w4.terrain;
    let wx = -1;
    let wy = -1;
    for (let ty = 20; ty < g4.height - 20 && wx < 0; ty += 7) {
      for (let tx = 10; tx < g4.width - 10; tx++) {
        if (g4.typeAt(tx, ty) === Terrain.Water) {
          wx = (tx + 0.5) * TILE_SIZE;
          wy = (ty + 0.5) * TILE_SIZE;
          break;
        }
      }
    }
    const stuck = w4.groups[0];
    stuck.anchorX = wx;
    stuck.anchorY = wy;
    for (let i = 0; i < stuck.members.length; i++) {
      w4.soldiers.x[stuck.members[i]] = wx;
      w4.soldiers.y[stuck.members[i]] = wy;
    }
    w4.orders.issue({ kind: "move", squad: stuck.id, path: [wx - 400, wy] }, 0, w4.tick + 1);
    for (let t = 0; t < TICK_RATE * 25; t++) w4.step();
    let stillWet = 0;
    for (let i = 0; i < stuck.members.length; i++) {
      const id = stuck.members[i];
      if (w4.soldiers.alive[id] !== 1) continue;
      if (TERRAIN_INFO[g4.typeAtWorld(w4.soldiers.x[id], w4.soldiers.y[id])].moveScale <= 0) stillWet++;
    }
    check("a unit stranded on impassable ground can walk out",
      wx > 0 && stillWet === 0, stillWet + " soldiers still in the river");
  }
  check("soldiers never walk onto water either", crossed === 0, crossed + " soldiers crossed");
}

// -- 8b. the hash observes intent, not only position --------------------------

section("state hash");
{
  // Positions alone are not the whole simulation. Two worlds can sit at
  // identical coordinates while carrying different orders, and only separate
  // seconds later -- so the hash has to see stance, shape and patrol state or
  // the golden is a much slower net than it looks.
  function twin(): World {
    const w = buildWorld();
    const q = w.groups[0];
    q.patrol = [q.anchorX, q.anchorY, q.anchorX + 400, q.anchorY, q.anchorX + 400, q.anchorY + 400];
    q.stance = "patrol";
    return w;
  }

  const base = twin();
  const same = twin();
  check("identical worlds hash identically", hashWorld(base) === hashWorld(same));

  const legDiff = twin();
  legDiff.groups[0].patrolLeg = 2;
  check("patrol leg is observed", hashWorld(legDiff) !== hashWorld(base));

  const dirDiff = twin();
  dirDiff.groups[0].patrolForward = false;
  check("patrol direction is observed", hashWorld(dirDiff) !== hashWorld(base));

  const stanceDiff = twin();
  stanceDiff.groups[0].stance = "hold";
  check("stance is observed", hashWorld(stanceDiff) !== hashWorld(base));

  const shapeDiff = twin();
  shapeDiff.groups[0].shape = "wedge";
  check("formation shape is observed", hashWorld(shapeDiff) !== hashWorld(base));

  const holdDiff = twin();
  holdDiff.groups[0].holdRadius = 250;
  check("hold zone is observed", hashWorld(holdDiff) !== hashWorld(base));

  const lockDiff = twin();
  lockDiff.groups[0].recoverUntil = 400;
  check("recovery lock is observed", hashWorld(lockDiff) !== hashWorld(base));
}

// -- 8c. recovery is a commitment ----------------------------------------------

section("recover");
{
  const w = buildWorld();
  const q = w.groups[0];
  const other = w.groups[1];
  for (const m of q.members) w.soldiers.morale[m] = 0.3;
  for (let i = 0; i < q.members.length; i++) w.soldiers.hp[q.members[i]] = 20;
  const startX = q.anchorX;

  w.orders.issue({ kind: "recover", squad: q.id }, 0, w.tick + 1);
  w.step();
  w.step();
  check("recover sets the stance", q.stance === "recover", q.stance);
  check("recover locks the squad for 30s",
    q.recoverUntil - w.tick > TICK_RATE * 29 && q.recoverUntil - w.tick <= TICK_RATE * 30,
    (q.recoverUntil - w.tick) / TICK_RATE + "s remaining");

  // The lock is the entire cost of the gesture, so it has to actually hold.
  w.orders.issue({ kind: "move", squad: q.id, path: [startX + 900, q.anchorY] }, 0, w.tick + 1);
  w.orders.issue({ kind: "formation", squad: q.id, shape: "wedge" }, 0, w.tick + 1);
  w.orders.issue({ kind: "recover", squad: q.id }, 0, w.tick + 1);
  const shapeBefore = q.shape;
  for (let t = 0; t < TICK_RATE * 5; t++) w.step();
  check("a recovering squad refuses movement orders", q.stance === "recover" && q.path.length === 0);
  check("a recovering squad refuses formation orders", q.shape === shapeBefore, q.shape);
  check("a recovering squad does not drift", Math.abs(q.anchorX - startX) < 1, (q.anchorX - startX).toFixed(2));

  // Other squads are unaffected.
  w.orders.issue({ kind: "move", squad: other.id, path: [other.anchorX + 400, other.anchorY] }, 0, w.tick + 1);
  w.step();
  w.step();
  check("the lock is per squad, not army-wide", other.stance === "move");

  const moraleMid = moraleOf(w, q);
  const hpMid = w.soldiers.hp[q.members[0]];
  check("morale climbs while recovering", moraleMid > 0.3, moraleMid.toFixed(3));
  check("hit points climb while recovering", hpMid > 20, hpMid.toFixed(1));

  // Run out the clock.
  for (let t = 0; t < TICK_RATE * 26; t++) w.step();
  check("the lock lifts and the squad stands to", q.stance === "idle" && q.recoverUntil === 0,
    q.stance + " / until " + q.recoverUntil);
  check("morale recovered over the full term", moraleOf(w, q) > 0.9 && moraleOf(w, q) <= 1, moraleOf(w, q).toFixed(3));
  check("wounded soldiers healed", w.soldiers.hp[q.members[0]] > 40, w.soldiers.hp[q.members[0]].toFixed(1));

  // And orders are accepted again.
  w.orders.issue({ kind: "move", squad: q.id, path: [startX + 500, q.anchorY] }, 0, w.tick + 1);
  w.step();
  w.step();
  check("orders are accepted once the term ends", q.stance === "move");
}

// -- 8c2. a real battle --------------------------------------------------------

const CLASH_TICKS = TICK_RATE * 120;

section("battle");
const clashFinal = (() => {
  const w = buildClash();
  const startMen = w.groups.reduce((n, q) => n + q.members.length, 0);
  const t0 = Date.now();
  for (let t = 0; t < CLASH_TICKS && !w.outcome; t++) w.step();
  const elapsed = Date.now() - t0;

  const endMen = w.groups.reduce((n, q) => n + q.members.length, 0);
  const losses = [0, 1].map((p) => {
    let n = 0;
    for (let i = 0; i < w.soldiers.count; i++) {
      if (w.soldiers.player[i] === p && w.soldiers.alive[i] !== 1) n++;
    }
    return n;
  });
  const morale = [w.armyMorale(0), w.armyMorale(1)];

  check("the armies actually engaged", endMen < startMen, startMen - endMen + " casualties");
  check("both sides took losses", losses[0] > 0 && losses[1] > 0, losses.join(" vs "));
  // Mirrored armies on open ground should trade roughly evenly. A large,
  // consistent skew would mean one side is getting a systematic first strike.
  check("a mirrored fight trades roughly evenly",
    Math.abs(losses[0] - losses[1]) < Math.max(losses[0], losses[1]) * 0.5,
    losses.join(" vs "));
  check("morale fell as men died", morale[0] < 1 && morale[1] < 1,
    morale.map((m) => m.toFixed(2)).join(" / "));
  // Kill credit lives on groups, and a group wiped out is disbanded, so credit
  // it holds goes with it. Assert it never EXCEEDS the bodies on the field.
  const credited = w.groups.reduce((n, q) => n + q.kills, 0);
  check("kills are never credited more than once",
    credited <= losses[0] + losses[1],
    credited + " credited vs " + (losses[0] + losses[1]) + " dead");

  console.log("");
  console.log("  casualties  " + losses[0] + " / " + losses[1] + "  of " + startMen + " men");
  console.log("  morale      " + morale.map((m) => (m * 100).toFixed(0) + "%").join(" / "));
  console.log("  battle cost " + (elapsed / CLASH_TICKS).toFixed(3) + " ms/tick");
  if (w.outcome) console.log("  outcome     " + w.outcome.reason + ": " + w.outcome.detail);

  return hashWorld(w);
})();

// -- 8d. combat ----------------------------------------------------------------

section("combat");
{
  /** Move a squad out of the way without killing it -- wiping out a whole
   *  army trips the annihilation outcome and freezes the world mid-test. */
  const park = place;

  /** Reduce a squad to n living soldiers, parked on a point. */
  function trim(w: World, q: Group, n: number, x: number, y: number, hp: number): void {
    for (let i = 0; i < q.members.length; i++) {
      const id = q.members[i];
      const keep = i < n;
      w.soldiers.alive[id] = keep ? 1 : 0;
      w.soldiers.hp[id] = keep ? hp : 0;
      w.soldiers.x[id] = x + i * 2;
      w.soldiers.y[id] = y;
      w.soldiers.cooldown[id] = 0;
    }
    q.members.length = n;
    q.anchorX = x;
    q.anchorY = y;
    q.stance = "idle";
    q.path.length = 0;
  }

  // SIMULTANEITY. Two soldiers who can each kill the other in one blow must
  // BOTH die. Resolve in index order and player 0, who holds the lower
  // indices, always strikes first and walks away -- a bias no replay test
  // would ever catch, because it is perfectly deterministic.
  {
    const w = buildWorld();
    const a = w.groups.find((q) => q.player === 0 && w.typeOf(q.members[0]) === "line") as Group;
    const b = w.groups.find((q) => q.player === 1 && w.typeOf(q.members[0]) === "line") as Group;
    trim(w, a, 1, 2000, 2000, 1);
    trim(w, b, 1, 2000 + MELEE_RANGE * 0.5, 2000, 1);
    for (let t = 0; t < 3 && (a.members.length > 0 && b.members.length > 0); t++) w.step();
    check("mutual kills are simultaneous, not index-ordered", a.members.length === 0 && b.members.length === 0,
      "player0 left " + a.members.length + ", player1 left " + b.members.length);
  }

  // Reach decides how a unit fights, and archers must not have to close.
  {
    const w = buildWorld();
    const archer = w.groups.find((q) => q.player === 0 && w.typeOf(q.members[0]) === "archer") as Group;
    const victim = w.groups.find((q) => q.player === 1 && w.typeOf(q.members[0]) === "line") as Group;
    let corner = 0;
    for (const q of w.groups) {
      if (q === archer || q === victim) continue;
      park(w, q, 200 + (corner % 4) * 90, 3600 + ((corner / 4) | 0) * 90);
      corner++;
    }
    trim(w, archer, 16, 2000, 2000, 100);
    trim(w, victim, 20, 2000 + 200, 2000, 100);
    let shots = 0;
    const victims = new Set<number>();
    for (let t = 0; t < TICK_RATE * 20; t++) {
      w.step();
      // Events are cleared every tick, so they must be collected as they happen.
      for (const e of w.events) {
        if (e.kind !== "shot") continue;
        shots++;
        victims.add(e.victim);
      }
    }
    check("archers engage at range without closing", shots > 0 && victim.members.length < 20,
      shots + " shots, target down to " + victim.members.length + "/20");
    check("ranged fire spreads across several targets", victims.size > 1, victims.size + " distinct targets");
    check("archers stayed at range", Math.abs(archer.anchorX - 2000) < 40,
      "moved " + (archer.anchorX - 2000).toFixed(0));
  }

  // Casualties must re-flow the formation, or the squad keeps holes where its
  // dead stood while cohesion still reads 1.00 because it only counts survivors.
  {
    const w = buildWorld();
    const q = w.groups[0];
    let n = 0;
    for (const other of w.groups) {
      if (other === q) continue;
      park(w, other, 300 + (n % 5) * 80, 3500 + ((n / 5) | 0) * 80);
      n++;
    }
    trim(w, q, 20, 2000, 2000, 100);
    w.step();
    const slotsBefore = q.radius;
    // Kill twelve of the twenty. Membership shrinks as they fall, so the
    // survivors are what is left in the list -- not the first eight entries.
    const doomed = q.members.slice(0, 12);
    for (const m of doomed) {
      w.soldiers.alive[m] = 0;
      w.soldiers.hp[m] = 0;
      w.soldiers.group[m] = -1;
      w.soldiers.slot[m] = -1;
    }
    q.members = q.members.filter((m) => !doomed.includes(m));
    w.orders.issue({ kind: "formation", squad: q.id, shape: "line" }, 0, w.tick + 1);
    for (let t = 0; t < TICK_RATE * 6; t++) w.step();
    const slots = new Set<number>();
    for (let i = 0; i < q.members.length; i++) {
      if (w.soldiers.alive[q.members[i]] === 1) slots.add(w.soldiers.slot[q.members[i]]);
    }
    check("survivors occupy a formation sized for them",
      slots.size === 8 && Math.max(...slots) < 8, "slots used: " + [...slots].sort((x, y) => x - y).join(","));
    check("the formation tightens as the squad shrinks", q.radius < slotsBefore,
      q.radius.toFixed(1) + " vs " + slotsBefore.toFixed(1));
    check("cohesion still reads true after losses", q.cohesion > 0.85, q.cohesion.toFixed(2));
  }
}

// -- 8e. morale and victory ----------------------------------------------------

section("victory");
{
  const full = { morale: 1, strength: 200, roster: 200 };
  check("a running match has no outcome", evaluate({ mode: "rout" }, { armies: [full, full], elapsed: 60, duration: 900, holdSeconds: [0, 0], points: [0, 0] }) === null);

  const broken = { morale: ROUT_THRESHOLD - 0.01, strength: 150, roster: 200 };
  const routed = evaluate({ mode: "rout" }, { armies: [broken, full], elapsed: 60, duration: 900, holdSeconds: [0, 0], points: [0, 0] });
  check("an army below the rout threshold loses at once",
    routed !== null && routed.winner === 1 && routed.reason === "rout");

  const wiped = { morale: 1, strength: 0, roster: 200 };
  const dead = evaluate({ mode: "rout" }, { armies: [wiped, full], elapsed: 60, duration: 900, holdSeconds: [0, 0], points: [0, 0] });
  check("annihilation ends the match", dead !== null && dead.winner === 1 && dead.reason === "annihilated");

  // THE TURTLING PROBLEM. An army that hid in a corner kept perfect morale and
  // inflicted nothing. Under morale alone it would win on time; the tiebreak
  // adds the share of the enemy destroyed, so doing nothing earns nothing.
  // The turtle avoided contact: perfect morale, and it inflicted nothing, so
  // the fighter's roster is untouched. The fighter paid morale for its attacks
  // and destroyed a third of the turtle's army.
  const turtle = { morale: 1.0, strength: 133, roster: 200 };
  const fighter = { morale: 0.8, strength: 200, roster: 200 };
  const timed = evaluate({ mode: "rout" }, { armies: [turtle, fighter], elapsed: 900, duration: 900, holdSeconds: [0, 0], points: [0, 0] });
  check("turtling does not win on the timer",
    timed !== null && timed.reason === "timer" && timed.winner === 1,
    "turtle " + score(turtle, fighter).toFixed(3) + " vs fighter " + score(fighter, turtle).toFixed(3));
  check("an army that inflicted nothing scores only its morale",
    Math.abs(score(turtle, fighter) - turtle.morale) < 1e-9);

  // But morale still matters: an army that traded evenly and held up wins.
  const steady = { morale: 0.9, strength: 170, roster: 200 };
  const shaken = { morale: 0.35, strength: 170, roster: 200 };
  const onMorale = evaluate({ mode: "rout" }, { armies: [steady, shaken], elapsed: 900, duration: 900, holdSeconds: [0, 0], points: [0, 0] });
  check("morale still decides an even trade", onMorale !== null && onMorale.winner === 0);

  // A live match must actually reach a decision when one side is destroyed.
  {
    const w = buildWorld();
    for (const q of w.groups) {
      if (q.player !== 1) continue;
      for (let i = 0; i < q.members.length; i++) w.soldiers.alive[q.members[i]] = 0;
      q.members.length = 0;
    }
    w.step();
    check("the world stops once the match is decided",
      w.outcome !== null && w.outcome.winner === 0, w.outcome ? w.outcome.detail : "no outcome");
    const frozen = w.tick;
    w.step();
    w.step();
    check("a decided world does not keep ticking", w.tick === frozen);
  }
}

// -- 8f. vision and fog --------------------------------------------------------

section("vision");
{
  const w = buildWorld();
  const g = w.terrain;

  // Find open plain, and a wood, to test sight against.
  let openX = 0;
  let openY = 0;
  outer: for (let ty = 20; ty < g.height - 20; ty += 3) {
    for (let tx = 15; tx < 60; tx++) {
      let clear = true;
      for (let dy = -8; dy <= 8 && clear; dy++) {
        for (let dx = -14; dx <= 14; dx++) if (g.typeAt(tx + dx, ty + dy) !== Terrain.Plain) { clear = false; break; }
      }
      if (clear) { openX = (tx + 0.5) * TILE_SIZE; openY = (ty + 0.5) * TILE_SIZE; break outer; }
    }
  }
  check("found open ground to test sight on", openX > 0);

  function place(q: Group, x: number, y: number): void {
    q.anchorX = x;
    q.anchorY = y;
    q.stance = "idle";
    q.path.length = 0;
    for (let i = 0; i < q.members.length; i++) {
      w.soldiers.x[q.members[i]] = x;
      w.soldiers.y[q.members[i]] = y;
    }
  }

  const watcher = w.groups.find((q) => q.player === 0 && w.typeOf(q.members[0]) === "skirmisher")!;
  const quarry = w.groups.find((q) => q.player === 1 && w.typeOf(q.members[0]) === "line")!;
  let n = 0;
  for (const q of w.groups) {
    if (q === watcher || q === quarry) continue;
    place(q, (q.player === 0 ? 260 : 5860) + (n % 4) * 55, (q.player === 0 ? 3760 : 240) + ((n / 4) | 0) * 55);
    n++;
  }

  // The watcher's ACTUAL reach, doctrine included. Using the raw roster value
  // understates it by the doctrine's sight multiplier, and the test then places
  // its "too far" case inside the real range.
  const sight = effectiveSight(g, w.stats(watcher.members[0]).sight, openX, openY);
  // High ground can stretch sight by nearly half again, so "beyond sight" has
  // to clear the best case any watcher on this map could have.
  const wellBeyond = sight * 2.6 + 400;

  place(watcher, openX, openY);
  place(quarry, openX + sight * 0.5, openY);
  for (let t = 0; t < 8; t++) w.step();
  check("an enemy in the open within sight is spotted", quarry.seenBy[0], "sight " + sight.toFixed(0));

  place(quarry, openX + wellBeyond, openY);
  for (let t = 0; t < 8; t++) w.step();
  check("an enemy beyond sight is not spotted", !quarry.seenBy[0],
    "outcome " + (w.outcome ? w.outcome.reason + '/' + w.outcome.detail : 'none') + ", tick " + w.tick + ", dist " + Math.hypot(quarry.anchorX - watcher.anchorX, quarry.anchorY - watcher.anchorY).toFixed(0) +
    " vs sight " + sight.toFixed(0) +
    ", watcher at " + watcher.anchorX.toFixed(0) + "," + watcher.anchorY.toFixed(0) +
    ", seen-bits " + quarry.members.map((m) => w.soldiers.seen[m]).join("") +
    ", fog " + w.fog[0].at(quarry.anchorX, quarry.anchorY) +
    ", nearest friendly " + (() => {
      let best = 1e9;
      for (let i = 0; i < w.soldiers.count; i++) {
        if (w.soldiers.alive[i] !== 1 || w.soldiers.player[i] !== 0) continue;
        best = Math.min(best, Math.hypot(w.soldiers.x[i] - quarry.anchorX, w.soldiers.y[i] - quarry.anchorY));
      }
      return best.toFixed(0);
    })());

  check("vision is symmetric: the watcher is seen too",
    (() => { place(quarry, openX + sight * 0.4, openY); w.step(); return watcher.seenBy[1]; })());

  // A wood between them must break the line of sight.
  let forestX = -1;
  let forestY = -1;
  for (let ty = 6; ty < g.height - 6 && forestX < 0; ty++) {
    for (let tx = 6; tx < g.width - 6; tx++) {
      if (g.typeAt(tx, ty) !== Terrain.Forest) continue;
      let thick = true;
      for (let d = -2; d <= 2 && thick; d++) if (g.typeAt(tx + d, ty) !== Terrain.Forest) thick = false;
      if (thick) { forestX = (tx + 0.5) * TILE_SIZE; forestY = (ty + 0.5) * TILE_SIZE; break; }
    }
  }
  check("found a wood to hide behind", forestX > 0);
  check("terrain blocks line of sight",
    !hasLineOfSight(g, forestX - 120, forestY, forestX + 120, forestY));
  check("open ground does not block line of sight",
    hasLineOfSight(g, openX - 200, openY, openX + 200, openY));
  check("standing beside a wood does not blind you",
    hasLineOfSight(g, forestX, forestY, forestX + 20, forestY));

  // High ground sees further than low.
  let hi = 0;
  let lo = 255;
  let hx = 0, hy = 0, lx = 0, ly = 0;
  for (let ty = 4; ty < g.height - 4; ty += 2) {
    for (let tx = 4; tx < g.width - 4; tx += 2) {
      if (!g.passableAt(tx, ty)) continue;
      const e = g.elevationAt(tx, ty);
      if (e > hi) { hi = e; hx = (tx + 0.5) * TILE_SIZE; hy = (ty + 0.5) * TILE_SIZE; }
      if (e < lo) { lo = e; lx = (tx + 0.5) * TILE_SIZE; ly = (ty + 0.5) * TILE_SIZE; }
    }
  }
  check("high ground sees further than low",
    effectiveSight(g, 400, hx, hy) > effectiveSight(g, 400, lx, ly),
    effectiveSight(g, 400, hx, hy).toFixed(0) + " vs " + effectiveSight(g, 400, lx, ly).toFixed(0));
  check("shooting downhill outranges shooting uphill",
    rangeFromHeight(g, hx, hy, lx, ly) > rangeFromHeight(g, lx, ly, hx, hy));

  // The fog field must light up around your own army and nowhere else.
  {
    const fog = new FogField(g);
    fog.beginUpdate();
    fog.stamp(openX, openY, 300);
    check("fog lights up around your own squads", fog.at(openX, openY) === 1);
    check("fog stays dark where nobody has been", fog.at(openX + 2000, openY) === 0);
    fog.beginUpdate();
    check("ground once seen is remembered, not re-hidden", fog.at(openX, openY) === 2);
  }

  // You cannot shoot what you cannot see. Rather than poke at internals, this
  // hides the target behind a real wood and checks the arrows stop.
  {
    function fireAt(sepFromWood: number, throughForest: boolean): { shots: number; seen: boolean } {
      const w2 = buildWorld();
      const archer = w2.groups.find((q) => q.player === 0 && w.typeOf(q.members[0]) === "archer")!;
      const target = w2.groups.find((q) => q.player === 1 && w.typeOf(q.members[0]) === "line")!;
      let k = 0;
      for (const q of w2.groups) {
        if (q === archer || q === target) continue;
        // Opposite corners. Parking both armies in one corner has them fighting
        // each other, and their arrows get counted as the archers' own.
        const px = (q.player === 0 ? 260 : 5860) + (k % 4) * 55;
        const py = (q.player === 0 ? 3760 : 240) + ((k / 4) | 0) * 55;
        q.anchorX = px;
        q.anchorY = py;
        q.stance = "idle";
        for (let i = 0; i < q.members.length; i++) { w2.soldiers.x[q.members[i]] = px; w2.soldiers.y[q.members[i]] = py; }
        k++;
      }
      const ax = throughForest ? forestX - sepFromWood : openX;
      const ay = throughForest ? forestY : openY;
      const tx = throughForest ? forestX + sepFromWood : openX + 200;
      const ty = throughForest ? forestY : openY;
      for (const [q, x, y] of [[archer, ax, ay], [target, tx, ty]] as const) {
        q.anchorX = x;
        q.anchorY = y;
        q.stance = "idle";
        q.path.length = 0;
        for (let i = 0; i < q.members.length; i++) { w2.soldiers.x[q.members[i]] = x; w2.soldiers.y[q.members[i]] = y; }
      }
      let shots = 0;
      for (let t = 0; t < 60; t++) {
        w2.step();
        for (const e of w2.events) if (e.kind === "shot") shots++;
      }
      return { shots, seen: target.seenBy[0] };
    }

    const clear = fireAt(0, false);
    const hidden = fireAt(110, true);
    check("archers fire on a target in the open", clear.seen && clear.shots > 0, clear.shots + " shots");
    check("a wood between them stops both the sighting and the shooting",
      !hidden.seen && hidden.shots === 0, hidden.shots + " shots, seen=" + hidden.seen);
  }
}

// -- 8g. the AI ----------------------------------------------------------------

section("ai");
{
  /** A full match with both sides run by the machine. */
  function autoMatch(seed: number, duration: number): World {
    const w = new World({
      seed,
      tilesWide: provingGround.tilesWide,
      tilesHigh: provingGround.tilesHigh,
      duration,
      aiPlayers: [0, 1],
    });
    for (const zone of provingGround.deployment) {
      for (let i = 0; i < ARMY.length; i++) {
        unit(
          w, zone.player, ARMY[i],
          (zone.x + 4 + (i % 3) * 7) * TILE_SIZE,
          (zone.y + 5 + ((i / 3) | 0) * 10) * TILE_SIZE,
          zone.player === 0 ? 0 : M.PI,
        );
      }
    }
    return w;
  }

  const w = autoMatch(provingGround.seed, 15 * 60);
  const startMen = w.groups.reduce((n, q) => n + q.members.length, 0);
  const stylesSeen = new Set<string>();
  let sawThroughFog = 0;

  // The AI issues into the queue and the same tick drains it, so the pending
  // count never rises. Count the calls instead.
  let ordersIssued = 0;
  const byKind = new Map<string, number>();
  const realIssue = w.orders.issue.bind(w.orders);
  w.orders.issue = ((body, player, tick) => {
    ordersIssued++;
    byKind.set(body.kind, (byKind.get(body.kind) ?? 0) + 1);
    // The invariant that matters: an attack order must name a squad the
    // issuing side can see AT THE MOMENT IT IS GIVEN. Losing sight of the
    // target mid-approach afterwards is fine -- that is memory, not cheating.
    if (body.kind === "attack") {
      const t = w.groupById(body.target);
      if (t && !t.seenBy[player]) sawThroughFog++;
    }
    return realIssue(body, player, tick);
  }) as typeof w.orders.issue;

  const t0 = Date.now();
  let ticks = 0;
  for (; ticks < TICK_RATE * 15 * 60 && !w.outcome; ticks++) {
    w.step();
    for (const ai of w.ai) stylesSeen.add(ai.style);
    // The AI must never act on a squad the fog is hiding from it. Sampling is
    // cheap and catches a privileged-information regression immediately.

  }
  const elapsed = Date.now() - t0;
  const endMen = w.groups.reduce((n, q) => n + q.members.length, 0);

  check("the AI issues orders", ordersIssued > 0, ordersIssued + " orders");
  check("the AI uses more than one kind of order", byKind.size > 1,
    [...byKind].map(([k, n]) => k + " " + n).join(", "));
  check("the AI never orders an attack on a squad it cannot see", sawThroughFog === 0,
    sawThroughFog + " attacks ordered on unseen squads");
  check("the AI brings on a battle", endMen < startMen, startMen - endMen + " casualties");
  check("the AI changes posture during a match", stylesSeen.size > 1, [...stylesSeen].join(", "));
  check("every posture the AI adopts is a known one",
    [...stylesSeen].every((s2) => (PLAYSTYLES as readonly string[]).includes(s2)));
  check("a full AI match reaches a decision", w.outcome !== null,
    w.outcome ? w.outcome.reason + ": " + w.outcome.detail : "still running at full time");
  check("AI decisions cost little", elapsed / Math.max(ticks, 1) < 5,
    (elapsed / Math.max(ticks, 1)).toFixed(3) + " ms/tick over " + ticks + " ticks");

  // Determinism: the AI is part of the simulation, so two identical worlds must
  // stay identical for a whole match without a single order being supplied.
  const a = autoMatch(provingGround.seed ^ 0x99, 60);
  const b = autoMatch(provingGround.seed ^ 0x99, 60);
  let diverged = -1;
  for (let t = 0; t < TICK_RATE * 60; t++) {
    a.step();
    b.step();
    if (t % 25 === 0 && hashWorld(a) !== hashWorld(b)) {
      diverged = t;
      break;
    }
  }
  check("two AI matches from one seed never diverge", diverged < 0,
    diverged >= 0 ? "diverged at tick " + diverged : "identical throughout");

  console.log("");
  console.log("  ai match    " + (ticks / TICK_RATE).toFixed(0) + "s, " + (startMen - endMen) + " dead");
  console.log("  postures    " + [...stylesSeen].join(", "));
  if (w.outcome) console.log("  outcome     " + w.outcome.reason + ": " + w.outcome.detail);
}

// -- 8g2. how a drawn group forms up -------------------------------------------

section("grouping");
{
  const w = new World({ seed: 5, tilesWide: 60, tilesHigh: 60, soldierCapacity: 512 });
  const ids: number[] = [];
  for (let i = 0; i < 24; i++) ids.push(w.spawnSoldier(0, "line", 900 + (i % 6) * 14, 900 + ((i / 6) | 0) * 14, 0));
  for (let i = 0; i < 16; i++) ids.push(w.spawnSoldier(0, "archer", 900 + (i % 6) * 14, 900 + ((i / 6) | 0) * 14, 0));
  for (let i = 0; i < 4; i++) ids.push(w.spawnSoldier(0, "siege", 940, 940, 0));
  w.spawnSoldier(1, "line", 3000, 900, M.PI);
  const g = w.createGroup(0, ids) as Group;

  check("a drawn group forms square by default", g.shape === "square", g.shape);

  for (let t = 0; t < 200; t++) w.step();

  // Shooters belong behind the men holding the line. +x is forward.
  const fwd = { melee: [] as number[], ranged: [] as number[] };
  for (const m of g.members) {
    const slot = w.soldiers.slot[m];
    if (slot < 0) continue;
    (w.stats(m).range > MELEE_RANGE ? fwd.ranged : fwd.melee).push(g.slots[slot * 2]);
  }
  const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
  check("shooters form up behind the melee", mean(fwd.ranged) < mean(fwd.melee) - 10,
    "melee " + mean(fwd.melee).toFixed(1) + " vs ranged " + mean(fwd.ranged).toFixed(1));
  check("every man got a slot", fwd.melee.length + fwd.ranged.length === g.members.length);

  // A formation has to keep a sane shape at any size. A single rank fifty men
  // wide is a queue, not a body of troops: it cannot turn and has no depth.
  function ratio(shape: "line" | "square" | "column", n: number): number {
    const slots = new Float64Array(n * 2);
    formationSlots(shape, n, slots);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      x0 = Math.min(x0, slots[i * 2]);
      x1 = Math.max(x1, slots[i * 2]);
      y0 = Math.min(y0, slots[i * 2 + 1]);
      y1 = Math.max(y1, slots[i * 2 + 1]);
    }
    return (y1 - y0) / Math.max(x1 - x0, 1e-6);
  }
  let lineOk = true;
  let squareOk = true;
  let columnOk = true;
  for (const n of [8, 20, 60, 120, 240]) {
    if (ratio("line", n) > 5.5) lineOk = false;
    const sq = ratio("square", n);
    if (sq < 0.6 || sq > 1.7) squareOk = false;
    if (ratio("column", n) > 0.8) columnOk = false;
  }
  check("a line stays broad without becoming a thread", lineOk,
    [8, 60, 240].map((n) => n + ":" + ratio("line", n).toFixed(1)).join(" "));
  check("a square stays square at any size", squareOk,
    [8, 60, 240].map((n) => n + ":" + ratio("square", n).toFixed(1)).join(" "));
  check("a column stays deeper than wide", columnOk,
    [8, 60, 240].map((n) => n + ":" + ratio("column", n).toFixed(1)).join(" "));
  check("big formations gain ranks rather than width",
    ratio("line", 240) <= ratio("line", 20) * 1.4,
    "20:" + ratio("line", 20).toFixed(1) + " 240:" + ratio("line", 240).toFixed(1));
}

// -- 8g3. melee soldiers engage rather than walk past --------------------------

section("engagement");
{
  /**
   * March a group past a screen of enemies standing in its way.
   *
   * The enemies are left UNGROUPED and spread across a wide band on purpose:
   * a grouped enemy re-forms into a compact block that a route can curve
   * around, and then this measures pathfinding rather than whether men stop to
   * fight. A loose screen cannot be side-stepped, and it exercises the
   * ungrouped case at the same time.
   */
  function marchPast(stance: "move" | "retreat"): {
    passed: boolean; contact: boolean; endX: number; dead: number;
  } {
    const w = new World({ seed: 31, tilesWide: 100, tilesHigh: 60, soldierCapacity: 256 });
    const mine: number[] = [];
    for (let i = 0; i < 20; i++) {
      mine.push(w.spawnSoldier(0, "line", 800 + (i % 5) * 13, 880 + ((i / 5) | 0) * 13, 0));
    }
    for (let i = 0; i < 22; i++) w.spawnSoldier(1, "line", 1600, 620 + i * 30, M.PI);
    const g = w.createGroup(0, mine) as Group;

    w.orders.issue(
      stance === "retreat"
        ? { kind: "retreat", squad: g.id, path: [2600, 900] }
        : { kind: "move", squad: g.id, path: [2600, 900] },
      0,
      1,
    );
    let contact = false;
    for (let t = 0; t < TICK_RATE * 80; t++) {
      w.step();
      if (w.events.length > 0) contact = true;
    }
    let dead = 0;
    for (let i = 0; i < w.soldiers.count; i++) if (w.soldiers.alive[i] !== 1) dead++;
    return { passed: g.anchorX > 2300, contact, endX: g.anchorX, dead };
  }

  const advancing = marchPast("move");
  check("a marching line stops and fights rather than walking past",
    advancing.contact && !advancing.passed,
    "contact " + advancing.contact + ", ended at x=" + advancing.endX.toFixed(0) +
    ", " + advancing.dead + " dead");

  // A withdrawal is the one order that overrides this. Disengaging IS the order.
  const withdrawing = marchPast("retreat");
  check("a withdrawal pushes through instead of stopping to fight",
    withdrawing.endX > advancing.endX + 200,
    "retreat reached x=" + withdrawing.endX.toFixed(0) +
    " vs advance x=" + advancing.endX.toFixed(0));

  // Shooters must not charge: their whole value is standing behind the line.
  {
    const w = new World({ seed: 32, tilesWide: 100, tilesHigh: 60, soldierCapacity: 256 });
    const archers: number[] = [];
    for (let i = 0; i < 16; i++) archers.push(w.spawnSoldier(0, "archer", 800 + (i % 4) * 13, 900 + ((i / 4) | 0) * 13, 0));
    const foe: number[] = [];
    for (let i = 0; i < 16; i++) foe.push(w.spawnSoldier(1, "line", 940 + (i % 4) * 13, 900 + ((i / 4) | 0) * 13, M.PI));
    const g = w.createGroup(0, archers) as Group;
    w.createGroup(1, foe);
    const startX = g.anchorX;
    for (let t = 0; t < TICK_RATE * 12; t++) w.step();
    check("archers hold their ground instead of charging",
      Math.abs(g.anchorX - startX) < 40, "moved " + (g.anchorX - startX).toFixed(0));
  }
}

// -- 8g4. nobody gets left on the bank -----------------------------------------

section("crossings");
{
  /**
   * March a formation over a bridge and count who never made it.
   *
   * A wide line on a narrow crossing is the hard case: whole ranks of slots
   * hang over the water, so those men walk at the bank and grind against it.
   * Not standing IN the river was never the problem -- being abandoned beside
   * it was.
   */
  function crossBridge(n: number, shape: "line" | "square"): { stranded: number; wet: number } {
    const w = buildWorld();
    const T = w.terrain;
    // Clear the field so this measures the crossing, not the traffic.
    let parked = 0;
    for (const other of w.groups) {
      place(w, other, 300 + (parked % 5) * 90, 3500 + ((parked / 5) | 0) * 90);
      parked++;
    }
    let bx = -1;
    let by = -1;
    for (let ty = 0; ty < T.height && bx < 0; ty++) {
      for (let tx = 0; tx < T.width; tx++) {
        if (T.typeAt(tx, ty) === Terrain.Bridge) { bx = tx; by = ty; break; }
      }
    }
    let west = bx;
    while (west > 0 && T.typeAt(west, by) !== Terrain.Plain) west--;
    let east = bx;
    while (east < T.width - 1 && T.typeAt(east, by) !== Terrain.Plain) east++;

    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(w.spawnSoldier(
        0, "line",
        (west - 4) * TILE_SIZE + (i % 6) * 13,
        (by + 0.5) * TILE_SIZE + ((i / 6) | 0) * 13,
        0,
      ));
    }
    const g = w.createGroup(0, ids) as Group;
    w.setFormation(g.id, shape);
    w.orders.issue(
      { kind: "move", squad: g.id, path: [(east + 6) * TILE_SIZE, (by + 0.5) * TILE_SIZE] },
      0, 1,
    );
    for (let t = 0; t < TICK_RATE * 200; t++) w.step();

    let stranded = 0;
    let wet = 0;
    for (const m of g.members) {
      if (Math.hypot(w.soldiers.x[m] - g.anchorX, w.soldiers.y[m] - g.anchorY) > g.radius + 120) stranded++;
      if (TERRAIN_INFO[T.typeAtWorld(w.soldiers.x[m], w.soldiers.y[m])].moveScale <= 0) wet++;
    }
    return { stranded, wet };
  }

  const tight = crossBridge(20, "square");
  const wide = crossBridge(48, "line");
  const huge = crossBridge(90, "line");

  check("a compact group crosses cleanly", tight.stranded === 0 && tight.wet === 0,
    tight.stranded + " stranded");
  check("a wide line crosses without losing its wings", wide.stranded === 0,
    wide.stranded + "/48 left on the bank");
  check("even a very wide line gets everyone over", huge.stranded === 0,
    huge.stranded + "/90 left on the bank");
  check("and nobody ends up standing in the river",
    tight.wet === 0 && wide.wet === 0 && huge.wet === 0,
    tight.wet + "/" + wide.wet + "/" + huge.wet);
}

// -- 8h. army building ---------------------------------------------------------

section("army");
{
  const army = defaultArmy();
  const v = validate(army);
  check("the default army is legal", v.ok, v.problems.join("; "));
  // The suggestion is a whole setup, not a pile of troops.
  for (const d of DOCTRINE_IDS) {
    for (const b of [107, 141, 179]) {
      const sug = suggestArmy(d, b);
      const v = validate(sug, b);
      check("a suggested " + d + " army at " + b + " is legal",
        v.ok, v.problems.join("; "));
      check("  and brings a reserve", (sug.abilities ?? []).length >= 2,
        (sug.abilities ?? []).join(","));
      // "Uses all unit credits": whatever is left must be genuinely
      // unspendable -- nothing legal can be added to it at all.
      let spendable = false;
      for (const id of UNIT_TYPE_IDS) {
        if (validate({ ...sug, squads: [...sug.squads, id] }, b).ok) spendable = true;
      }
      check("  and spends everything it legally can",
        !spendable, v.spent + "/" + b + " with " + (b - v.spent) + " left over");
    }
  }

  // The advice must actually read the battlefield, not just the budget.
  {
    const countOf = (l: typeof LEVELS[number], id: UnitTypeId): number =>
      suggestArmy("maneuver", l.budget, adviseFor(l)).squads.filter((q) => q === id).length;
    const open = LEVELS.find((l) => l.country === "open" && l.victory.mode === "rout");
    const broken = LEVELS.find((l) => l.country === "broken");
    const holding = LEVELS.find((l) => l.victory.mode === "objectives");
    if (open && broken) {
      // Per company, since the two maps do not have the same purse.
      const openShare = countOf(open, "horse") / suggestArmy("maneuver", open.budget, adviseFor(open)).squads.length;
      const brokenShare = countOf(broken, "horse") / suggestArmy("maneuver", broken.budget, adviseFor(broken)).squads.length;
      check("horse is advised on open ground and not at a river",
        openShare > brokenShare * 2,
        "open " + (openShare * 100).toFixed(0) + "% vs broken " + (brokenShare * 100).toFixed(0) + "%");
    }
    if (holding && open) {
      check("ground to hold is advised sappers to hold it with",
        countOf(holding, "builder") > countOf(open, "builder"),
        holding.name + " " + countOf(holding, "builder") + " vs " + open.name + " " + countOf(open, "builder"));
    }
    const shapes = new Set(LEVELS.map((l) =>
      suggestArmy("maneuver", l.budget, adviseFor(l)).squads.slice().sort().join(",")));
    check("no two battlefields get the same advice", shapes.size === LEVELS.length,
      shapes.size + " distinct suggestions across " + LEVELS.length + " battlefields");
  }

  check("the default army spends most of its budget",
    v.spent > DEFAULT_BUDGET * 0.75 && v.spent <= DEFAULT_BUDGET,
    v.spent + "/" + DEFAULT_BUDGET);
  check("the default army fits the squad cap", army.squads.length <= MAX_SQUADS,
    army.squads.length + " squads");

  check("over budget is rejected",
    !validate({ doctrine: "maneuver", squads: new Array(15).fill("guard") }).ok);
  // Sized from the cap rather than hard-coded, so raising the cap retunes the
  // test instead of breaking it.
  check("too many squads is rejected",
    validate({ doctrine: "maneuver", squads: new Array(MAX_SQUADS + 5).fill("line") }, 999)
      .problems.some((p2) => p2.includes("too many squads")));
  // Sized off the cap rather than hard-coded, so retuning the cap retunes the
  // test instead of silently disarming it.
  check("a single type cannot dominate",
    validate({ doctrine: "maneuver", squads: new Array(UNIT_TYPES.line.maxPerArmy + 1).fill("line") }, 999)
      .problems.some((p2) => p2.includes("Line Infantry")));
  check("an empty army is rejected", !validate({ doctrine: "maneuver", squads: [] }).ok);
  check("cost adds up", cost({ doctrine: "maneuver", squads: ["line", "horse"] }) ===
    UNIT_TYPES.line.cost + UNIT_TYPES.horse.cost);

  // Every doctrine must be a trade. A doctrine that is better at everything is
  // not a choice, it is the answer.
  let dominant = "";
  for (const a of DOCTRINE_IDS) {
    for (const b of DOCTRINE_IDS) {
      if (a === b) continue;
      const A = DOCTRINES[a];
      const B = DOCTRINES[b];
      const keys = ["speed", "turnRate", "attack", "defence", "hp", "sight", "magic"] as const;
      const better = keys.every((k) => A[k] >= B[k]) && A.resolve <= B.resolve;
      if (better) dominant = a + " dominates " + b;
    }
  }
  check("no doctrine is strictly better than another", dominant === "", dominant);

  // Doctrine has to actually reach the squads.
  const aggr = statsFor("line", "aggressive");
  const def = statsFor("line", "defensive");
  check("aggressive trades armour for pace", aggr.speed > def.speed && aggr.defence < def.defence,
    aggr.speed.toFixed(1) + "/" + aggr.defence.toFixed(0) + " vs " +
      def.speed.toFixed(1) + "/" + def.defence.toFixed(0));
  check("maneuver re-forms fastest",
    DOCTRINE_IDS.every((d) => DOCTRINES[d].turnRate <= DOCTRINES.maneuver.turnRate));
  check("magic trades physical strength for it",
    DOCTRINES.magic.magic > 1 && DOCTRINES.magic.attack < 1);

  // A doctrine chosen before spawn must be baked into the squads it produces.
  {
    const w = new World({
      seed: 7, tilesWide: 40, tilesHigh: 40, soldierCapacity: 64,
    });
    w.doctrine[0] = "aggressive";
    w.doctrine[1] = "defensive";
    const fast = unit(w, 0, "line", 400, 400, 0);
    const tough = unit(w, 1, "line", 800, 400, M.PI);
    check("each army carries its own doctrine",
      w.stats(fast.members[0]).speed > w.stats(tough.members[0]).speed &&
        w.stats(fast.members[0]).defence < w.stats(tough.members[0]).defence,
      w.stats(fast.members[0]).speed.toFixed(1) + " vs " +
        w.stats(tough.members[0]).speed.toFixed(1));
    check("doctrine reaches soldier hit points",
      w.soldiers.hp[tough.members[0]] > w.soldiers.hp[fast.members[0]]);
  }

  // Deployment holds the world until the player gives the off.
  {
    const w = new World({ seed: 11, tilesWide: 40, tilesHigh: 40, soldierCapacity: 64 });
    w.deploying = true;
    const q = unit(w, 0, "line", 400, 400, 0);
    // An army with no opponent counts as having annihilated it, which ends the
    // match on the first tick and would make this look like a deployment bug.
    unit(w, 1, "line", 1150, 400, M.PI);
    w.orders.issue({ kind: "move", squad: q.id, path: [900, 400] }, 0, 0);
    for (let t = 0; t < 40; t++) w.step();
    const parked = q.anchorX;
    check("deployment freezes the match", w.tick === 0, "tick " + w.tick);
    w.deploying = false;
    for (let t = 0; t < 40; t++) w.step();
    check("the match runs once deployment ends", w.tick === 40 && q.anchorX > parked + 5,
      "tick " + w.tick + ", moved " + (q.anchorX - parked).toFixed(0));
  }

  // Capacity is guarded: writing past a typed array is a silent no-op.
  {
    const w = new World({ seed: 3, tilesWide: 30, tilesHigh: 30, soldierCapacity: 24 });
    unit(w, 0, "line", 200, 200, 0);
    let threw = false;
    try {
      unit(w, 0, "line", 300, 200, 0);
    } catch {
      threw = true;
    }
    check("overrunning soldier capacity throws instead of failing silently", threw);
  }
}

// -- 8i. magic and special units -----------------------------------------------

section("magic");
{
  check("every spell is medium-intensity, not decisive",
    SPELL_IDS.every((id) => SPELLS[id].radius < 260 && SPELLS[id].duration <= 15),
    SPELL_IDS.map((id) => id + " r" + SPELLS[id].radius).join(", "));
  check("a ward never reaches immunity", wardSoak(10) <= 0.4, wardSoak(10).toFixed(2));
  check("a hex never becomes instantly fatal", hexPenalty(10) <= 0.5);
  check("no spell can be worked continuously",
    SPELL_IDS.every((id) => SPELLS[id].cooldown > SPELLS[id].duration),
    SPELL_IDS.map((id) => id + " " + SPELLS[id].duration + "s/" + SPELLS[id].cooldown + "s").join(", "));

  // Scarcity is RELATIVE to the common troops, not an absolute number: caps
  // rise with the budget, and pinning them to 2 meant this test would have to
  // be edited every time the purse grew, which is how a test stops meaning
  // anything.
  check("special units are scarcer than the line they support",
    UNIT_TYPES.mage.maxPerArmy < UNIT_TYPES.line.maxPerArmy / 2 &&
    UNIT_TYPES.siege.maxPerArmy < UNIT_TYPES.line.maxPerArmy / 2 &&
    UNIT_TYPES.guard.maxPerArmy < UNIT_TYPES.line.maxPerArmy / 2,
    "line " + UNIT_TYPES.line.maxPerArmy + ", mage " + UNIT_TYPES.mage.maxPerArmy +
    ", siege " + UNIT_TYPES.siege.maxPerArmy + ", guard " + UNIT_TYPES.guard.maxPerArmy);
  check("scouts see furthest of anything on the field",
    UNIT_TYPE_IDS.every((id) => UNIT_TYPES[id].sight <= UNIT_TYPES.scout.sight));
  check("siege outranges every other unit",
    UNIT_TYPE_IDS.every((id) => UNIT_TYPES[id].range <= UNIT_TYPES.siege.range));
  check("special units cost what they are worth",
    UNIT_TYPES.mage.cost > UNIT_TYPES.line.cost && UNIT_TYPES.siege.cost > UNIT_TYPES.line.cost);

  // Measure the ward directly rather than through a duel. Swapping the adepts
  // for another unit to get a control also swaps in that unit's fighting,
  // which swamps the effect being measured -- the first version of this test
  // "showed" wards costing lives because the control was a skirmisher that
  // simply killed the enemy faster.
  {
    const w = new World({ seed: 909, tilesWide: 40, tilesHigh: 40, soldierCapacity: 64 });
    const rng = Rng.create(1, Stream.Combat);
    const bare: number[] = [];
    const shielded: number[] = [];
    const hexed: number[] = [];
    for (let i = 0; i < 400; i++) {
      bare.push(hitDamage(rng, 40, 100, 0, w.terrain, 600, 600));
      shielded.push(hitDamage(rng, 40, 100, wardSoak(1), w.terrain, 600, 600));
      hexed.push(hitDamage(rng, 40, 100, -hexPenalty(1), w.terrain, 600, 600));
    }
    const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
    check("a ward blunts incoming blows", mean(shielded) < mean(bare) * 0.85,
      mean(shielded).toFixed(1) + " vs " + mean(bare).toFixed(1));
    check("a hex makes blows land harder", mean(hexed) > mean(bare) * 1.1,
      mean(hexed).toFixed(1) + " vs " + mean(bare).toFixed(1));
    check("neither reaches an absurd extreme",
      mean(shielded) > mean(bare) * 0.4 && mean(hexed) < mean(bare) * 2);
  }

  // A squad standing in a friendly ward should steady, and in an enemy hex
  // should waver, with everything else held equal.
  {
    function nerveAfter(spell: "ward" | "hex" | null): number {
      const w = new World({ seed: 77, tilesWide: 40, tilesHigh: 40, soldierCapacity: 64 });
      const q = unit(w, 0, "line", 600, 600, 0);
      unit(w, 1, "line", 1200, 600, M.PI);
      for (const m of q.members) w.soldiers.morale[m] = 0.5;
      if (spell) {
        w.workings.push({
          spell,
          // Not sustained by any company: this fixture is testing the working
          // itself, not who is keeping it up.
          group: -1,
          player: spell === "ward" ? 0 : 1,
          x: 600, y: 600, radius: 300,
          until: 99999, power: 1,
        });
      }
      for (let t = 0; t < TICK_RATE * 8; t++) w.step();
      return moraleOf(w, q);
    }
    const none = nerveAfter(null);
    const warded = nerveAfter("ward");
    const hexed = nerveAfter("hex");
    check("a ward steadies the squad standing in it", warded > none,
      warded.toFixed(3) + " vs " + none.toFixed(3));
    check("an enemy hex saps nerve", hexed < none, hexed.toFixed(3) + " vs " + none.toFixed(3));
  }

  check("adepts on the field actually work spells", (() => {
    const w = new World({ seed: 31, tilesWide: 40, tilesHigh: 40, soldierCapacity: 64 });
    const m = unit(w, 0, "mage", 500, 500, 0);
    unit(w, 1, "line", 900, 500, M.PI);
    w.orders.issue({ kind: "attack", squad: m.id, target: w.groups[1].id, path: [900, 500] }, 0, 1);
    let peak = 0;
    for (let t = 0; t < TICK_RATE * 20 && !w.outcome; t++) {
      w.step();
      peak = Math.max(peak, w.workings.length);
    }
    return peak > 0;
  })());

  check("workings expire rather than accumulating forever", (() => {
    const w = new World({ seed: 5, tilesWide: 40, tilesHigh: 40, soldierCapacity: 64 });
    const q = unit(w, 0, "mage", 500, 500, 0);
    unit(w, 1, "line", 1100, 500, M.PI);
    w.orders.issue({ kind: "hold", squad: q.id, x: 500, y: 500, radius: 150 }, 0, 1);
    for (let t = 0; t < TICK_RATE * 5; t++) w.step();
    const during = w.workings.length;
    for (let t = 0; t < TICK_RATE * 40; t++) w.step();
    return during > 0 && w.workings.length <= during;
  })());
}

// -- 8j. destructible terrain --------------------------------------------------

section("destruction");
{
  const w = buildWorld();
  const g = w.terrain;

  // Find a bridge, and the fortifications the map has none of yet -- so this
  // exercises bridges and woods, which the generator does produce.
  let bx = -1;
  let by = -1;
  for (let ty = 0; ty < g.height && bx < 0; ty++) {
    for (let tx = 0; tx < g.width; tx++) {
      if (g.typeAt(tx, ty) === Terrain.Bridge) { bx = tx; by = ty; break; }
    }
  }
  check("found a bridge to break", bx >= 0);

  const rev0 = g.revision;
  let broke = false;
  for (let i = 0; i < 40 && !broke; i++) broke = g.damage(bx, by, 40);
  check("a bridge can be broken", broke && g.typeAt(bx, by) === Terrain.Water,
    "now " + TERRAIN_INFO[g.typeAt(bx, by)].name);
  check("breaking terrain bumps the revision", g.revision > rev0);
  check("plain ground cannot be destroyed", !g.damage(1, 1, 9999) || g.typeAt(1, 1) !== Terrain.Water);

  // Burning a wood must open the sightline it was blocking.
  {
    let fx = -1;
    let fy = -1;
    for (let ty = 6; ty < g.height - 6 && fx < 0; ty++) {
      for (let tx = 6; tx < g.width - 6; tx++) {
        if (g.typeAt(tx, ty) !== Terrain.Forest) continue;
        let thick = true;
        for (let d = -2; d <= 2 && thick; d++) if (g.typeAt(tx + d, ty) !== Terrain.Forest) thick = false;
        if (thick) { fx = tx; fy = ty; break; }
      }
    }
    const ax = (fx - 4) * TILE_SIZE;
    const bxw = (fx + 4) * TILE_SIZE;
    const yy = (fy + 0.5) * TILE_SIZE;
    const before = hasLineOfSight(g, ax, yy, bxw, yy);
    // Burn the whole span the sightline crosses, not just the thick middle.
    for (let d = -5; d <= 5; d++) {
      for (let i = 0; i < 40; i++) g.damage(fx + d, fy, 40);
    }
    check("a wood can be burnt away", !before && hasLineOfSight(g, ax, yy, bxw, yy),
      "sight before " + before + ", after " + hasLineOfSight(g, ax, yy, bxw, yy));
  }

  // THE POINT OF ALL THIS: a squad whose road is destroyed must re-plan, not
  // walk into the water, discover it, and stand there for the rest of the match.
  {
    const w2 = buildWorld();
    const g2 = w2.terrain;
    let cx = -1;
    let cy = -1;
    for (let ty = 0; ty < g2.height && cx < 0; ty++) {
      for (let tx = 0; tx < g2.width; tx++) {
        if (g2.typeAt(tx, ty) === Terrain.Bridge) { cx = tx; cy = ty; break; }
      }
    }
    const q = w2.groups[0];
    // Park it on the west bank and send it across that crossing.
    q.anchorX = (cx - 12) * TILE_SIZE;
    q.anchorY = (cy + 0.5) * TILE_SIZE;
    for (let i = 0; i < q.members.length; i++) {
      w2.soldiers.x[q.members[i]] = q.anchorX;
      w2.soldiers.y[q.members[i]] = q.anchorY;
    }
    const goalX = (cx + 14) * TILE_SIZE;
    w2.orders.issue({ kind: "move", squad: q.id, path: [goalX, q.anchorY] }, 0, w2.tick + 1);
    for (let t = 0; t < TICK_RATE * 4; t++) w2.step();
    const hadRoute = q.path.length >= 2;

    // Blow the whole crossing while they are on their way.
    for (let d = -3; d <= 3; d++) {
      for (let row = -1; row <= 1; row++) {
        for (let i = 0; i < 40; i++) w2.terrain.damage(cx + d, cy + row, 40);
      }
    }
    w2.step();
    const rerouted = q.pathRevision === w2.terrain.revision;

    for (let t = 0; t < TICK_RATE * 40; t++) w2.step();
    let inWater = 0;
    for (let i = 0; i < q.members.length; i++) {
      const id = q.members[i];
      if (w2.soldiers.alive[id] !== 1) continue;
      if (TERRAIN_INFO[g2.typeAtWorld(w2.soldiers.x[id], w2.soldiers.y[id])].moveScale <= 0) inWater++;
    }
    check("the squad had a route across before the crossing went", hadRoute);
    check("destroying the road re-plans the route", rerouted);
    check("nobody drowns when the bridge goes", inWater === 0, inWater + " in the water");
  }
}

// -- 9. gestures ---------------------------------------------------------------

section("gestures");
{
  const report = runConfusionMatrix();
  check("every gesture classifies as itself", report.offDiagonal.length === 0,
    report.offDiagonal.length + " off-diagonal: " +
      report.offDiagonal.slice(0, 4).map((m) => m.expected + "->" + m.actual).join(", "));
  check("corpus covers all six gestures plus glyphs", report.total >= 80, report.total + " strokes");
  printMatrix(report);
  console.log("");
  console.log("  accuracy    " + report.correct + "/" + report.total +
    " (" + ((report.correct / report.total) * 100).toFixed(1) + "%)");
}

// -- 9a2. levels ---------------------------------------------------------------

section("levels");
{
  check("there is more than one battlefield", LEVELS.length >= 4, LEVELS.length + " levels");

  let ok = true;
  const notes: string[] = [];
  for (const l of LEVELS) {
    const v = validate(defaultArmy("maneuver", l.budget), l.budget);
    if (!v.ok) {
      ok = false;
      notes.push(l.id + ": " + v.problems.join("; "));
    }
    // Deployment zones must sit on the map and not overlap each other.
    for (const z of l.deployment) {
      if (z.x < 0 || z.y < 0 || z.x + z.w > l.tilesWide || z.y + z.h > l.tilesHigh) {
        ok = false;
        notes.push(l.id + ": deployment zone off the map");
      }
    }
    const [a, b] = l.deployment;
    if (a && b && Math.abs(a.x - b.x) < Math.max(a.w, b.w)) {
      ok = false;
      notes.push(l.id + ": armies deploy on top of each other");
    }
    // Control points must be reachable ground, not sitting in a river.
    const g = generateTerrain(l.tilesWide, l.tilesHigh, l.seed);
    for (const cp of l.controlPoints) {
      if (!g.passableAt(Math.floor(cp.x / TILE_SIZE), Math.floor(cp.y / TILE_SIZE))) {
        ok = false;
        notes.push(l.id + ": control point " + cp.name + " is on impassable ground");
      }
    }
    if (l.victory.mode === "objectives" && l.victory.required > l.controlPoints.length) {
      ok = false;
      notes.push(l.id + ": needs more points held than exist");
    }
    if (l.victory.mode !== "rout" && l.controlPoints.length === 0) {
      ok = false;
      notes.push(l.id + ": ground-based victory with no ground to take");
    }
  }
  check("every level is legal and playable", ok, notes.join(" | "));

  // The roster should be varied, not four maps with the numbers changed.
  const modes = new Set(LEVELS.map((l) => l.victory.mode));
  const sizes = new Set(LEVELS.map((l) => l.tilesWide * l.tilesHigh));
  const budgets = new Set(LEVELS.map((l) => l.budget));
  check("levels differ in how they are won", modes.size >= 3, [...modes].join(", "));
  check("levels differ in size and budget", sizes.size >= 2 && budgets.size >= 3,
    sizes.size + " sizes, " + budgets.size + " budgets");

  // Each level's terrain should suit its brief.
  function share(l: (typeof LEVELS)[number], t: number): number {
    const g = generateTerrain(l.tilesWide, l.tilesHigh, l.seed);
    let n = 0;
    for (const v of g.type) if (v === t) n++;
    return n / g.type.length;
  }
  const open = LEVELS.find((l) => l.id === "open-field");
  const hills = LEVELS.find((l) => l.id === "high-ground");
  check("the open field is actually open", open !== undefined && share(open, Terrain.Forest) < 0.15,
    open ? (share(open, Terrain.Forest) * 100).toFixed(0) + "% wooded" : "missing");
  // High ground is now graded -- hill, then scree, then bare mountain -- so
  // counting only the middle band understates how hilly a map is.
  const highGround = (l: (typeof LEVELS)[number]): number =>
    share(l, Terrain.Hill) + share(l, Terrain.Scree) + share(l, Terrain.Mountain);
  check("the high ground actually has high ground", hills !== undefined && highGround(hills) > 0.2,
    hills ? (highGround(hills) * 100).toFixed(0) + "% high ground" : "missing");
}

// -- 9a3. what the pen may do while setting out --------------------------------

section("deployment");
{
  // Deployment is for arranging an army, not commanding it. Selecting,
  // gathering and dressing ranks must work; every battlefield order must not.
  const w = new World({ seed: 21, tilesWide: 60, tilesHigh: 60, soldierCapacity: 256 });
  const mine: number[] = [];
  for (let i = 0; i < 20; i++) mine.push(w.spawnSoldier(0, "line", 900 + (i % 5) * 13, 900 + ((i / 5) | 0) * 13, 0));
  const foe: number[] = [];
  for (let i = 0; i < 20; i++) foe.push(w.spawnSoldier(1, "line", 1700 + (i % 5) * 13, 900 + ((i / 5) | 0) * 13, M.PI));
  const g = w.createGroup(0, mine) as Group;
  w.createGroup(1, foe);
  w.deploying = true;

  const cmd = new Commander(w, 0);
  cmd.selected = [g.id];

  /** Straight stroke well clear of the men: a march when the battle is on. */
  function marchStroke(): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < 30; i++) out.push({ x: 940 + i * 20, y: 1400 });
    return out;
  }
  /** A tight closed loop out on the map: a hold order. */
  function holdStroke(): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i <= 30; i++) {
      const t = (i / 30) * Math.PI * 2;
      out.push({ x: 1400 + Math.cos(t) * 90, y: 1400 + Math.sin(t) * 90 });
    }
    return out;
  }

  const marchSaid = cmd.commit(marchStroke());
  check("a march does nothing while setting out",
    g.stance === "idle" && g.path.length === 0 && w.orders.size === 0,
    "stance " + g.stance + ", queued " + w.orders.size + ", said: " + marchSaid);

  cmd.selected = [g.id];
  const holdSaid = cmd.commit(holdStroke());
  check("a hold order does nothing while setting out",
    g.stance === "idle" && w.orders.size === 0, "said: " + holdSaid);

  check("the player is told why nothing happened", marchSaid.length > 0 && holdSaid.length > 0,
    marchSaid);

  // Nothing may sit queued waiting to fire the instant the battle starts.
  w.deploying = false;
  w.step();
  check("no order was quietly banked for later",
    g.stance === "idle" && g.path.length === 0, "stance " + g.stance);

  // Formations MUST work, and must take effect immediately -- the world is not
  // ticking, so anything left in the queue would never be applied.
  {
    const w2 = new World({ seed: 22, tilesWide: 60, tilesHigh: 60, soldierCapacity: 256 });
    const men: number[] = [];
    for (let i = 0; i < 20; i++) men.push(w2.spawnSoldier(0, "line", 900 + (i % 5) * 13, 900 + ((i / 5) | 0) * 13, 0));
    for (let i = 0; i < 6; i++) w2.spawnSoldier(1, "line", 2400, 900, M.PI);
    const q = w2.createGroup(0, men) as Group;
    w2.deploying = true;
    const cmd2 = new Commander(w2, 0);
    cmd2.selected = [q.id];

    check("a group starts square", q.shape === "square", q.shape);
    // A stroke drawn across the group's front is the "line" glyph.
    const glyph: { x: number; y: number }[] = [];
    for (let i = 0; i < 24; i++) glyph.push({ x: q.anchorX, y: q.anchorY - 60 + i * 5 });
    const said = cmd2.commit(glyph);
    check("a formation glyph works while setting out", q.shape === "line",
      "shape " + q.shape + ", said: " + said);
    check("and it applies at once rather than queueing", w2.orders.size === 0,
      w2.orders.size + " queued");
  }

  // Gathering men into a group must work: it is the whole point of deploying.
  {
    const w3 = new World({ seed: 23, tilesWide: 60, tilesHigh: 60, soldierCapacity: 256 });
    for (let i = 0; i < 12; i++) w3.spawnSoldier(0, "line", 900 + (i % 4) * 16, 900 + ((i / 4) | 0) * 16, 0);
    for (let i = 0; i < 6; i++) w3.spawnSoldier(1, "line", 2400, 900, M.PI);
    w3.deploying = true;
    const cmd3 = new Commander(w3, 0);
    const loop: { x: number; y: number }[] = [];
    for (let i = 0; i <= 36; i++) {
      const t = (i / 36) * Math.PI * 2;
      loop.push({ x: 930 + Math.cos(t) * 140, y: 920 + Math.sin(t) * 140 });
    }
    const said = cmd3.commit(loop);
    check("a lasso gathers men while setting out", w3.groups.length === 1,
      w3.groups.length + " groups, said: " + said);
  }

  // Split and recover must be refused while setting out, like every other
  // order. Only select, lasso and formation are legal before the battle starts.
  // These two are checked by name because they were added late and are the two
  // that reach the world through their own code paths.
  {
    const w4 = new World({ seed: 24, tilesWide: 60, tilesHigh: 60, soldierCapacity: 512 });
    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i < 12; i++) left.push(w4.spawnSoldier(0, "line", 800 + (i % 4) * 16, 900 + ((i / 4) | 0) * 16, 0));
    for (let i = 0; i < 12; i++) right.push(w4.spawnSoldier(0, "line", 1200 + (i % 4) * 16, 900 + ((i / 4) | 0) * 16, 0));
    for (let i = 0; i < 6; i++) w4.spawnSoldier(1, "line", 2400, 900, M.PI);
    const a = w4.createGroup(0, left) as Group;
    const b = w4.createGroup(0, right) as Group;
    w4.deploying = true;
    const cmd4 = new Commander(w4, 0);
    cmd4.selected = [a.id, b.id];

    const groupsBefore = w4.groups.length;
    // A cut between the two groups, drawn clear of both.
    const cut: { x: number; y: number }[] = [];
    for (let i = 0; i < 30; i++) cut.push({ x: 1080, y: 600 + i * 24 });
    const cutSaid = cmd4.commit(cut);
    check("a split does nothing while setting out",
      w4.groups.length === groupsBefore && w4.orders.size === 0,
      w4.groups.length + " groups, " + w4.orders.size + " queued, said: " + cutSaid);

    // A heart drawn on open ground beside the men.
    cmd4.selected = [a.id, b.id];
    const heartPts: { x: number; y: number }[] = [];
    for (let i = 0; i <= 46; i++) {
      const t = (i / 46) * M.PI * 2;
      const hx = 16 * M.sin(t) * M.sin(t) * M.sin(t);
      const hy = -(13 * M.cos(t) - 5 * M.cos(2 * t) - 2 * M.cos(3 * t) - M.cos(4 * t));
      heartPts.push({ x: 1000 + (hx / 16) * 260, y: 1500 + (hy / 16) * 260 });
    }
    const heartSaid = cmd4.commit(heartPts);
    check("a recover does nothing while setting out",
      a.recoverUntil === 0 && b.recoverUntil === 0 && w4.orders.size === 0,
      "recoverUntil " + a.recoverUntil + "/" + b.recoverUntil + ", said: " + heartSaid);
    check("and the player is told why, for both",
      cutSaid.length > 0 && heartSaid.length > 0, cutSaid + " | " + heartSaid);

    // Cutting one group in two is an order like any other, so it is refused
    // while setting out even though a formation glyph is not.
    cmd4.selected = [a.id];
    const groupsBeforeDivide = w4.groups.length;
    const through: { x: number; y: number }[] = [];
    for (let i = 0; i < 30; i++) through.push({ x: a.anchorX, y: a.anchorY - 400 + i * (800 / 29) });
    const divideSaid = cmd4.commit(through);
    for (let t = 0; t < 6; t++) w4.step();
    check("cutting a group in two does nothing while setting out",
      w4.groups.length === groupsBeforeDivide && w4.orders.size === 0,
      w4.groups.length + " groups, said: " + divideSaid);
  }
}

// -- 9a4. a glyph on your men beats a cut across the map -----------------------

section("glyph vs split");
{
  // Both a formation glyph and a split are straight strokes. What separates
  // them is whether the stroke sits ON your men or out on the map -- and a
  // column drawn slightly off-centre must still form up rather than cut the
  // selection in half.
  const R = 46;
  const squads: SquadView[] = [
    { id: 1, player: 0, x: 900, y: 900, radius: R, size: 20, facing: 0, visible: true },
    { id: 2, player: 0, x: 1300, y: 900, radius: R, size: 20, facing: 0, visible: true },
    { id: 3, player: 0, x: 900, y: 1300, radius: R, size: 20, facing: 0, visible: true },
    { id: 4, player: 0, x: 1300, y: 1300, radius: R, size: 20, facing: 0, visible: true },
  ];
  const ctx = (selected: number[]): GestureContext =>
    ({ player: 0, squads, selected, homeX: 0, pendingLine: null });

  /** A straight stroke of `len` centred on (cx, cy), along `angle`. */
  function glyph(cx: number, cy: number, angle: number, len: number): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < 26; i++) {
      const t = i / 25 - 0.5;
      out.push({ x: cx + Math.cos(angle) * len * t, y: cy + Math.sin(angle) * len * t });
    }
    return out;
  }

  const all = [1, 2, 3, 4];

  // Along the squad's own axis, centred on it: a column.
  const onSquad = recognize(glyph(900, 900, 0, 80), ctx(all));
  check("a glyph centred on a group forms it up, even with a group selected",
    onSquad?.kind === "formation" && onSquad.shape === "column",
    onSquad ? onSquad.kind + (onSquad.kind === "formation" ? "/" + onSquad.shape : "") : "null");

  // The same glyph nudged off-centre, so it no longer STARTS on the squad.
  const offCentre = recognize(glyph(900 + 34, 900 + 20, 0, 80), ctx(all));
  check("an off-centre glyph still forms up rather than splitting",
    offCentre?.kind === "formation",
    offCentre ? offCentre.kind : "null");

  // A long line drawn out on the map, clear of everyone: a cut.
  const acrossMap = recognize(glyph(1100, 1100, Math.PI / 2, 900), ctx(all));
  check("a line drawn clear of your men splits the group",
    acrossMap?.kind === "split", acrossMap ? acrossMap.kind : "null");

  // And with a single squad selected there is no group to cut, so the same
  // stroke is simply a march.
  const single = recognize(glyph(1100, 1100, Math.PI / 2, 900), ctx([1]));
  check("with one squad selected the same line is a move",
    single?.kind === "move", single ? single.kind : "null");
}

// -- 9a5. split, recover, and curved routes ------------------------------------

// -- 8i2. an opponent with a face ----------------------------------------------

section("commanders");
{
  check("every commander has a habit stated plainly enough to punish",
    COMMANDER_IDS.every((id) => COMMANDERS[id].blurb.length > 30 && COMMANDERS[id].epithet.length > 0));
  check("no commander is simply better at everything",
    COMMANDER_IDS.every((id) => {
      const b = COMMANDERS[id].bias;
      return PLAYSTYLES.some((p) => b[p] < 1) && PLAYSTYLES.some((p) => b[p] > 1);
    }));

  // The point of a named commander is that he fights differently. Same seed,
  // same armies, same ground -- only the man in charge changes.
  function postures(id: CommanderId): string[] {
    const w = new World({
      seed: provingGround.seed,
      tilesWide: provingGround.tilesWide,
      tilesHigh: provingGround.tilesHigh,
      duration: 6 * 60,
      soldierCapacity: 1024,
      aiPlayers: [1],
      commander: COMMANDERS[id],
    });
    for (const zone of provingGround.deployment) {
      for (let i = 0; i < ARMY.length; i++) {
        unit(w, zone.player, ARMY[i],
          (zone.x + 4 + (i % 3) * 7) * TILE_SIZE,
          (zone.y + 5 + ((i / 3) | 0) * 10) * TILE_SIZE,
          zone.player === 0 ? 0 : M.PI);
      }
    }
    const seen: string[] = [];
    for (let t = 0; t < TICK_RATE * 6 * 60 && !w.outcome; t++) {
      w.step();
      const style = w.ai[0].style;
      if (seen[seen.length - 1] !== style) seen.push(style);
    }
    return seen;
  }

  const boar = postures("boar");
  const badger = postures("badger");
  const fox = postures("fox");
  check("the Boar fights aggressively", boar.includes("aggressive"), boar.join(" -> "));
  check("the Badger holds ground instead", badger.includes("defensive") && !badger.includes("aggressive"),
    badger.join(" -> "));
  check("the Fox works the flanks", fox.includes("maneuver"), fox.join(" -> "));
  check("two commanders do not fight the same battle",
    boar.join() !== badger.join(),
    "boar " + boar.join(" -> ") + " | badger " + badger.join(" -> "));
  check("but a broken army holds regardless of who commands it",
    COMMANDERS.boar.bias.aggressive > 1);
}

// -- 8i3. what the adepts actually do ------------------------------------------

section("adept spells");
{
  check("there is a real spell list, not three things",
    SPELL_IDS.length >= 8, SPELL_IDS.length + " spells");
  check("some of them kill and some of them only tilt",
    SPELL_IDS.some((id) => SPELLS[id].kind === "burst") &&
    SPELL_IDS.some((id) => SPELLS[id].kind === "field"));
  check("every offensive spell lands on enemies and every supportive one on friends",
    OFFENSIVE_SPELLS.every((id) => !SPELLS[id].onAllies) &&
    SUPPORTIVE_SPELLS.every((id) => SPELLS[id].onAllies || id === "mend"));
  check("bursts still obey the medium-magic rules",
    SPELL_IDS.every((id) => SPELLS[id].radius < 260 && SPELLS[id].duration <= 15 &&
      SPELLS[id].cooldown > SPELLS[id].duration),
    SPELL_IDS.map((id) => id + " " + SPELLS[id].duration + "/" + SPELLS[id].cooldown).join(" "));

  // Adepts do not all reach for the same thing. Run several matches and count
  // how many different spells actually get worked.
  {
    const worked = new Set<string>();
    for (let seed = 200; seed < 208; seed++) {
      const w = new World({ seed, tilesWide: 70, tilesHigh: 70, soldierCapacity: 512 });
      const casters: number[] = [];
      for (let i = 0; i < 8; i++) casters.push(w.spawnSoldier(0, "mage", 1200 + (i % 4) * 14, 1200, 0));
      const foes: number[] = [];
      for (let i = 0; i < 16; i++) foes.push(w.spawnSoldier(1, "line", 1420 + (i % 4) * 14, 1200 + ((i / 4) | 0) * 14, M.PI));
      const g = w.createGroup(0, casters) as Group;
      w.createGroup(1, foes);
      g.stance = "attack";
      for (let t = 0; t < TICK_RATE * 90; t++) {
        w.step();
        for (const k of w.workings) worked.add(k.spell);
      }
    }
    check("adepts reach for more than one spell", worked.size >= 3,
      [...worked].join(", "));
    check("and at least one of them is a spell that kills",
      [...worked].some((id) => SPELLS[id as SpellId].kind === "burst"),
      [...worked].join(", "));
  }

  // A fireball actually hurts the men it lands on.
  {
    const w = new World({ seed: 210, tilesWide: 70, tilesHigh: 70, soldierCapacity: 512 });
    const casters: number[] = [];
    for (let i = 0; i < 8; i++) casters.push(w.spawnSoldier(0, "mage", 1200 + (i % 4) * 14, 1200, 0));
    const foes: number[] = [];
    for (let i = 0; i < 16; i++) foes.push(w.spawnSoldier(1, "line", 1400 + (i % 4) * 14, 1200 + ((i / 4) | 0) * 14, M.PI));
    const g = w.createGroup(0, casters) as Group;
    w.createGroup(1, foes);
    g.stance = "attack";
    let hpBefore = 0;
    for (const f of foes) hpBefore += w.soldiers.hp[f];
    for (let t = 0; t < TICK_RATE * 60; t++) w.step();
    let hpAfter = 0;
    for (const f of foes) if (w.soldiers.alive[f] === 1) hpAfter += w.soldiers.hp[f];
    check("adepts do real harm to an enemy in front of them", hpAfter < hpBefore,
      hpBefore.toFixed(0) + " -> " + hpAfter.toFixed(0) + " hp");
  }
}

// -- 8i4. what troops do for themselves ----------------------------------------

section("unit specials");
{
  check("every fighting kind of soldier knows something",
    (["line", "skirmisher", "archer", "horse", "guard", "mage", "scout"] as const)
      .every((id) => UNIT_TYPES[id].special !== undefined),
    (["line", "skirmisher", "archer", "horse", "guard", "mage", "scout"] as const)
      .map((id) => id + ":" + (UNIT_TYPES[id].special ?? "-")).join(" "));
  check("each one is a trade rather than a free gift",
    BRACE_SOAK > 0 && BRACE_SLOWDOWN > 1 && FORTIFY_SOAK > 0.9);
  check("the two one-shots are limited and the rest are not",
    SPECIALS.blink.uses === 1 && SPECIALS.breakBow.uses === 1 &&
    SPECIALS.brace.uses === 0 && SPECIALS.dodge.uses === 0 && SPECIALS.dash.uses === 0);
  check("scouts are the fastest thing on the field",
    UNIT_TYPE_IDS.every((id) => UNIT_TYPES[id].speed <= UNIT_TYPES.scout.speed),
    "scout " + UNIT_TYPES.scout.speed + ", horse " + UNIT_TYPES.horse.speed);
  check("and they are called scouts", UNIT_TYPES.scout.name === "Scouts", UNIT_TYPES.scout.name);

  // A line company under real pressure locks shields.
  {
    const w = new World({ seed: 151, tilesWide: 70, tilesHigh: 70, soldierCapacity: 512 });
    const mine: number[] = [];
    for (let i = 0; i < 16; i++) mine.push(w.spawnSoldier(0, "line", 1300 + (i % 4) * 14, 1300 + ((i / 4) | 0) * 14, 0));
    for (let i = 0; i < 30; i++) w.spawnSoldier(1, "guard", 1370 + (i % 6) * 14, 1300 + ((i / 6) | 0) * 14, M.PI);
    const g = w.createGroup(0, mine) as Group;
    w.createGroup(1, [...Array(30).keys()].map((k) => k + 16));
    let braced = false;
    for (let t = 0; t < TICK_RATE * 40 && !braced; t++) {
      w.step();
      if (w.hasSpecial(g, "brace")) braced = true;
    }
    check("a line company braces when the fighting turns against it", braced);
  }

  // Archers with the enemy on top of them throw the bows down.
  {
    const w = new World({ seed: 152, tilesWide: 70, tilesHigh: 70, soldierCapacity: 512 });
    const bows: number[] = [];
    for (let i = 0; i < 16; i++) bows.push(w.spawnSoldier(0, "archer", 1300 + (i % 4) * 14, 1300 + ((i / 4) | 0) * 14, 0));
    for (let i = 0; i < 30; i++) w.spawnSoldier(1, "guard", 1350 + (i % 6) * 14, 1300 + ((i / 6) | 0) * 14, M.PI);
    const g = w.createGroup(0, bows) as Group;
    w.createGroup(1, [...Array(30).keys()].map((k) => k + 16));
    let turned = false;
    for (let t = 0; t < TICK_RATE * 60 && !turned; t++) {
      w.step();
      turned = g.members.some((m) => w.soldiers.alive[m] === 1 && w.typeOf(m) === "skirmisher");
    }
    check("archers overrun in melee throw down their bows", turned);
  }

  // Adepts about to be destroyed step out of the world, once.
  {
    const w = new World({ seed: 153, tilesWide: 90, tilesHigh: 70, soldierCapacity: 512 });
    const adepts: number[] = [];
    for (let i = 0; i < 8; i++) adepts.push(w.spawnSoldier(0, "mage", 1800 + (i % 4) * 14, 1300 + ((i / 4) | 0) * 14, 0));
    for (let i = 0; i < 30; i++) w.spawnSoldier(1, "guard", 1850 + (i % 6) * 14, 1300 + ((i / 6) | 0) * 14, M.PI);
    const g = w.createGroup(0, adepts) as Group;
    w.createGroup(1, [...Array(30).keys()].map((k) => k + 8));
    const startX = g.anchorX;
    for (let t = 0; t < TICK_RATE * 60; t++) w.step();
    check("adepts about to be destroyed withdraw by the Art",
      w.liveCount(g) === 0 || g.anchorX < startX - 500,
      "from " + startX.toFixed(0) + " to " + g.anchorX.toFixed(0));
    check("and can only do it once", g.specialUses <= 1, "uses " + g.specialUses);
  }
}

// -- 8i5. the enemy always has something in mind -------------------------------

section("the enemy has intentions");
{
  // The complaint this encodes: companies that reached the last known enemy
  // position, found nothing, and then stood on empty ground for the rest of the
  // battle. Measured as the share of enemy companies sitting idle and pathless
  // late in a match with no player to fight.
  const w = new World({
    seed: 301, tilesWide: 120, tilesHigh: 90, soldierCapacity: 1024,
    aiPlayers: [1], duration: 900,
  });
  for (let i = 0; i < 60; i++) {
    w.spawnSoldier(1, i % 3 === 0 ? "line" : i % 3 === 1 ? "archer" : "horse",
      5000 + (i % 8) * 16, 1200 + ((i / 8) | 0) * 16, M.PI);
  }
  // A token enemy far away, so there is something to look for but nothing to
  // find nearby.
  for (let i = 0; i < 6; i++) w.spawnSoldier(0, "line", 300, 3000 + i * 14, 0);

  let worstIdle = 0;
  for (let t = 0; t < TICK_RATE * 240; t++) {
    w.step();
    if (t % (TICK_RATE * 20) !== 0 || t < TICK_RATE * 60) continue;
    const mob = w.groups.filter((g) => g.player === 1 && w.liveCount(g) > 0);
    if (mob.length === 0) continue;
    const idle = mob.filter((g) => g.stance === "idle" && g.path.length === 0).length;
    worstIdle = M.max(worstIdle, idle / mob.length);
  }
  check("the enemy never just stops and does nothing",
    worstIdle < 0.35, (worstIdle * 100).toFixed(0) + "% of its companies idle at the worst moment");

  // Holding must be justified: on an objective, or on its own works.
  {
    const w2 = new World({
      seed: 302, tilesWide: 120, tilesHigh: 90, soldierCapacity: 1024,
      aiPlayers: [1], duration: 900,
      controlPoints: [{ id: 1, name: "The Ford", x: 2600, y: 2000, radius: 200 }],
    });
    for (let i = 0; i < 40; i++) w2.spawnSoldier(1, "line", 5000 + (i % 6) * 16, 1200 + ((i / 6) | 0) * 16, M.PI);
    for (let i = 0; i < 6; i++) w2.spawnSoldier(0, "line", 300, 3000 + i * 14, 0);
    let holdingNowhere = 0;
    let holds = 0;
    for (let t = 0; t < TICK_RATE * 200; t++) {
      w2.step();
      if (t % (TICK_RATE * 15) !== 0 || t < TICK_RATE * 60) continue;
      for (const g of w2.groups) {
        if (g.player !== 1 || g.stance !== "hold" || w2.liveCount(g) === 0) continue;
        holds++;
        const onPoint = w2.controlPoints.some((p) => {
          const dx = p.x - g.anchorX;
          const dy = p.y - g.anchorY;
          return dx * dx + dy * dy <= (p.radius + 400) * (p.radius + 400);
        });
        const digging = g.members.some((m) =>
          w2.soldiers.alive[m] === 1 && UNIT_TYPES[w2.typeOf(m)].builds);
        if (!onPoint && !digging) holdingNowhere++;
      }
    }
    check("and holds ground for a reason when it holds at all",
      holds === 0 || holdingNowhere / holds < 0.4,
      holdingNowhere + " of " + holds + " holds were on nothing in particular");
  }
}

// -- 8j. surgeons and sappers --------------------------------------------------

section("surgeons and sappers");
{
  // Surgeons mend wounded men. The spec asks for healing over time and morale
  // boosts (6.2); this is both.
  {
    const w = new World({ seed: 81, tilesWide: 60, tilesHigh: 60, soldierCapacity: 256 });
    const hurt: number[] = [];
    for (let i = 0; i < 10; i++) hurt.push(w.spawnSoldier(0, "line", 900 + (i % 5) * 15, 900, 0));
    const medics: number[] = [];
    for (let i = 0; i < 6; i++) medics.push(w.spawnSoldier(0, "healer", 900 + (i % 3) * 14, 940, 0));
    // Somebody has to be left alive on the other side, or the match ends by
    // annihilation on tick one and step() returns without doing anything.
    for (let i = 0; i < 4; i++) w.spawnSoldier(1, "line", 1700, 1700, M.PI);
    for (const m of hurt) w.soldiers.hp[m] = 40;
    const before = w.soldiers.hp[hurt[0]];
    w.soldiers.morale[hurt[0]] = 0.4;
    const g = w.createGroup(0, medics) as Group;
    g.lastContact = 0;
    for (let t = 0; t < TICK_RATE * 20; t++) w.step();

    check("surgeons work succour, not a hex",
      w.workings.length === 0 || w.workings.every((k) => k.spell === "succour"),
      w.workings.map((k) => k.spell).join(",") || "none active");
    check("wounded men near surgeons recover hit points",
      w.soldiers.hp[hurt[0]] > before,
      before.toFixed(0) + " -> " + w.soldiers.hp[hurt[0]].toFixed(0));
    check("and steady their nerve", w.soldiers.morale[hurt[0]] > 0.4,
      w.soldiers.morale[hurt[0]].toFixed(2));
    check("surgeons are no use in a fight",
      UNIT_TYPES.healer.attack < UNIT_TYPES.line.attack / 4,
      "attack " + UNIT_TYPES.healer.attack);
  }

  // Sappers dig in on ground they are told to hold.
  {
    const w = new World({ seed: 82, tilesWide: 60, tilesHigh: 60, soldierCapacity: 256 });
    // Set them down on ground that can actually be dug. Spawning at a fixed
    // spot put them in a wood, where the test passed while proving nothing.
    let dig = { x: 0, y: 0 };
    outer: for (let ty0 = 20; ty0 < 40; ty0++) {
      for (let tx0 = 20; tx0 < 40; tx0++) {
        if (w.terrain.fortifiableAt(tx0, ty0)) {
          dig = { x: (tx0 + 0.5) * TILE_SIZE, y: (ty0 + 0.5) * TILE_SIZE };
          break outer;
        }
      }
    }
    const men: number[] = [];
    for (let i = 0; i < 8; i++) men.push(w.spawnSoldier(0, "builder", dig.x + (i % 4) * 6, dig.y, 0));
    for (let i = 0; i < 4; i++) w.spawnSoldier(1, "line", 1700, 1700, M.PI);
    const g = w.createGroup(0, men) as Group;
    const tx = (g.anchorX / TILE_SIZE) | 0;
    const ty = (g.anchorY / TILE_SIZE) | 0;
    const diggable = w.terrain.fortifiableAt(tx, ty);
    g.stance = "hold";
    const revBefore = w.terrain.revision;
    for (let t = 0; t < TICK_RATE * 30; t++) w.step();

    check("the sappers are standing on ground that can be dug", diggable,
      "terrain " + w.terrain.typeAt(tx, ty));
    check("sappers holding open ground raise a fieldwork",
      w.terrain.typeAt(tx, ty) === Terrain.Fortification,
      "terrain now " + w.terrain.typeAt(tx, ty));
    check("and that re-bakes the map", w.terrain.revision > revBefore);
  }

  // But not while somebody is fighting them.
  {
    const w = new World({ seed: 82, tilesWide: 60, tilesHigh: 60, soldierCapacity: 256 });
    const men: number[] = [];
    for (let i = 0; i < 8; i++) men.push(w.spawnSoldier(0, "builder", 900 + (i % 4) * 14, 900, 0));
    for (let i = 0; i < 4; i++) w.spawnSoldier(1, "line", 1700, 1700, M.PI);
    const g = w.createGroup(0, men) as Group;
    g.stance = "hold";
    const tx = (g.anchorX / TILE_SIZE) | 0;
    const ty = (g.anchorY / TILE_SIZE) | 0;
    for (let t = 0; t < TICK_RATE * 30; t++) {
      w.step();
      g.lastContact = w.tick; // somebody is on them the whole time
    }
    check("men under attack cannot entrench",
      w.terrain.typeAt(tx, ty) !== Terrain.Fortification);
  }

  // Siege-capable men bring works down. Until now the `siege` flag was read by
  // nothing at all -- engines carried it and no unit could knock anything over.
  {
    const w = new World({ seed: 83, tilesWide: 60, tilesHigh: 60, soldierCapacity: 256 });
    const men: number[] = [];
    for (let i = 0; i < 4; i++) men.push(w.spawnSoldier(0, "siege", 900 + i * 16, 900, 0));
    for (let i = 0; i < 4; i++) w.spawnSoldier(1, "line", 1700, 1700, M.PI);
    const g = w.createGroup(0, men) as Group;
    // Find diggable ground beside them rather than assuming the tile east of
    // the anchor is open -- at some seeds it is forest, and the "wall" was
    // never built, so the battering test passed against nothing at all.
    const cx = (g.anchorX / TILE_SIZE) | 0;
    const cy = (g.anchorY / TILE_SIZE) | 0;
    let tx = -1;
    let ty = -1;
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      if (w.terrain.fortifiableAt(cx + dx, cy + dy)) {
        tx = cx + dx;
        ty = cy + dy;
        break;
      }
    }
    w.terrain.fortify(tx, ty);
    check("a wall stands in front of them",
      tx >= 0 && w.terrain.typeAt(tx, ty) === Terrain.Fortification,
      tx < 0 ? "no diggable ground beside them" : "terrain " + w.terrain.typeAt(tx, ty));
    g.stance = "attack";
    for (let t = 0; t < TICK_RATE * 90 && w.terrain.typeAt(tx, ty) === Terrain.Fortification; t++) w.step();
    check("engines batter a wall down", w.terrain.typeAt(tx, ty) !== Terrain.Fortification,
      "terrain " + w.terrain.typeAt(tx, ty));
  }

  // The works sappers dig belong to them: their own men fight from behind them,
  // and anyone assaulting them fights worse for it.
  {
    const w = new World({ seed: 84, tilesWide: 60, tilesHigh: 60, soldierCapacity: 256 });
    let dig = { x: 0, y: 0 };
    outer3: for (let ty0 = 20; ty0 < 40; ty0++) {
      for (let tx0 = 20; tx0 < 40; tx0++) {
        if (w.terrain.fortifiableAt(tx0, ty0)) {
          dig = { x: (tx0 + 0.5) * TILE_SIZE, y: (ty0 + 0.5) * TILE_SIZE };
          break outer3;
        }
      }
    }
    const men: number[] = [];
    for (let i = 0; i < 8; i++) men.push(w.spawnSoldier(0, "builder", dig.x + (i % 4) * 6, dig.y, 0));
    for (let i = 0; i < 4; i++) w.spawnSoldier(1, "line", 1700, 1700, M.PI);
    const g = w.createGroup(0, men) as Group;
    g.stance = "hold";
    for (let t = 0; t < TICK_RATE * 30; t++) w.step();
    const work = w.fields.find((f) => f.ability === "bulwark");
    check("finishing a fieldwork raises works that belong to the diggers",
      work !== undefined && work.player === 0,
      work ? "owner " + work.player : "no works raised");
  }

  check("both new classes are scarce and cost real points",
    UNIT_TYPES.healer.maxPerArmy <= 3 && UNIT_TYPES.builder.maxPerArmy <= 3 &&
    UNIT_TYPES.healer.cost >= 4 && UNIT_TYPES.builder.cost >= 4);
  check("adding them did not renumber the existing units",
    UNIT_TYPE_IDS[0] === "line" && UNIT_TYPE_IDS[7] === "siege",
    UNIT_TYPE_IDS.join(","));
}

// -- 9b2. does commanding well actually beat not commanding at all? ------------

section("decisions matter");
{
  // THE CONTROLLED DUEL, mirrored.
  //
  // Identical men, identical ground, identical numbers; the only difference is
  // that one side is a formed company and the other is the same men standing
  // loose. The first attempt at this was confounded -- running the two sides
  // formed against each other produced a LARGER margin than formed-against-
  // loose, which proved the scenario itself favoured one side. So the
  // experiment is mirrored: the formed side has to win from either end of the
  // field, and over several seeds, or the result is geometry rather than
  // organisation.
  function duel(seed: number, formedPlayer: number): number {
    const w = new World({ seed, tilesWide: 80, tilesHigh: 80, soldierCapacity: 512 });
    const west: number[] = [];
    const east: number[] = [];
    for (let i = 0; i < 24; i++) west.push(w.spawnSoldier(0, "line", 1210 + (i % 6) * 15, 1200 + ((i / 6) | 0) * 15, 0));
    for (let i = 0; i < 24; i++) east.push(w.spawnSoldier(1, "line", 1325 + (i % 6) * 15, 1200 + ((i / 6) | 0) * 15, M.PI));
    w.createGroup(formedPlayer, formedPlayer === 0 ? west : east);
    for (let t = 0; t < TICK_RATE * 120; t++) w.step();
    // Positive means the FORMED side came out ahead, whichever side it was.
    const loosePlayer = 1 - formedPlayer;
    return score(w.armyState(formedPlayer), w.armyState(loosePlayer)) -
      score(w.armyState(loosePlayer), w.armyState(formedPlayer));
  }

  {
    const seeds = [71, 72, 74, 75];
    const asWest = seeds.map((sd) => duel(sd, 0));
    const asEast = seeds.map((sd) => duel(sd, 1));
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const all = asWest.concat(asEast);

    check("a formed company beats the same men standing loose",
      mean(all) > 0, "mean margin " + mean(all).toFixed(2));
    check("and does so from either end of the field, so it is not the ground",
      mean(asWest) > 0 && mean(asEast) > 0,
      "west " + mean(asWest).toFixed(2) + ", east " + mean(asEast).toFixed(2));
    check("and beats them decisively, not by a hair",
      mean(all) > 0.3, "mean margin " + mean(all).toFixed(2));
    check("and wins the great majority of individual duels",
      all.filter((m) => m > 0).length >= all.length - 1,
      all.filter((m) => m > 0).length + " of " + all.length);
  }

  // THE HEADLINE. A full match in which the player issues NO orders at all --
  // never groups a man, never moves anyone -- against an AI playing properly.
  //
  // This is the measurement that started the whole rebalance: a passive player
  // used to lose by 1.1 to 0.9, which is to say that commanding well barely
  // beat not commanding at all. A do-nothing army has to lose CLEARLY, or none
  // of the pen's vocabulary is worth learning.
  {
    const w = new World({
      seed: provingGround.seed,
      tilesWide: provingGround.tilesWide,
      tilesHigh: provingGround.tilesHigh,
      duration: 8 * 60,
      soldierCapacity: 1024,
      // Only the enemy is commanded. Player 0's men are left exactly as they
      // were set down, which is what "giving no orders" actually looks like.
      aiPlayers: [1],
    });
    for (const zone of provingGround.deployment) {
      for (let i = 0; i < ARMY.length; i++) {
        unit(
          w, zone.player, ARMY[i],
          (zone.x + 4 + (i % 3) * 7) * TILE_SIZE,
          (zone.y + 5 + ((i / 3) | 0) * 10) * TILE_SIZE,
          zone.player === 0 ? 0 : M.PI,
        );
      }
    }
    // The player's men are dissolved into individuals: unit() forms companies,
    // and a player who gives no orders has drawn none.
    for (const g of w.groups.filter((q) => q.player === 0)) w.disband(g.id);

    for (let t = 0; t < TICK_RATE * 8 * 60 && !w.outcome; t++) w.step();

    const passive = score(w.armyState(0), w.armyState(1));
    const commanded = score(w.armyState(1), w.armyState(0));
    check("an army nobody commands loses to one that is commanded",
      commanded > passive,
      "passive " + passive.toFixed(2) + " vs commanded " + commanded.toFixed(2));
    check("and loses clearly, not by a hair",
      commanded - passive > 0.35,
      "margin " + (commanded - passive).toFixed(2));
  }

  // Being got around must be worse than being beaten from the front.
  {
    function fight(fromBehind: boolean): number {
      const w = new World({ seed: 73, tilesWide: 80, tilesHigh: 80, soldierCapacity: 512 });
      const men: number[] = [];
      // Facing east either way; the attacker comes from the east (front) or
      // the west (rear), so only the ANGLE of the assault differs.
      for (let i = 0; i < 20; i++) men.push(w.spawnSoldier(0, "line", 1400 + (i % 5) * 15, 1200 + ((i / 5) | 0) * 15, 0));
      const ax = fromBehind ? 1320 : 1520;
      for (let i = 0; i < 20; i++) w.spawnSoldier(1, "line", ax + (i % 5) * 14, 1200 + ((i / 5) | 0) * 14, fromBehind ? 0 : M.PI);
      const g = w.createGroup(0, men) as Group;
      w.createGroup(1, [...Array(20).keys()].map((k) => k + 20));
      for (let t = 0; t < TICK_RATE * 50; t++) w.step();
      let nerve = 0;
      let n = 0;
      for (const m of g.members) if (w.soldiers.alive[m] === 1) { nerve += w.soldiers.morale[m]; n++; }
      return n > 0 ? nerve / n : 0;
    }
    const front = fight(false);
    const rear = fight(true);
    check("being taken from behind breaks nerve harder than a frontal fight",
      rear < front, "rear " + rear.toFixed(2) + " vs frontal " + front.toFixed(2));
  }
}

// -- 9b3. the glyph/cut boundary, swept ----------------------------------------

section("glyph and cut never overlap");
{
  // Both a formation glyph and a split are straight strokes with two or more
  // companies selected. What separates them is only WHERE the stroke sits, so
  // the honest test is to sweep a glyph sideways off a company and find the
  // point where the reading changes -- and to check there is no band in between
  // where it is ambiguous, and no case where the wrong one fires.
  //
  // Driven in the live game as real pointer strokes first; this pins the result.
  const w = new World({ seed: 91, tilesWide: 90, tilesHigh: 70, soldierCapacity: 512 });
  const a: number[] = [];
  const b2: number[] = [];
  for (let i = 0; i < 20; i++) a.push(w.spawnSoldier(0, "line", 900 + (i % 5) * 16, 900 + ((i / 5) | 0) * 16, 0));
  for (let i = 0; i < 20; i++) b2.push(w.spawnSoldier(0, "line", 900 + (i % 5) * 16, 1500 + ((i / 5) | 0) * 16, 0));
  for (let i = 0; i < 6; i++) w.spawnSoldier(1, "line", 2600, 1200, M.PI);
  const g1 = w.createGroup(0, a) as Group;
  const g2 = w.createGroup(0, b2) as Group;
  const cmd = new Commander(w, 0);

  const glyphAt = (g: Group, off: number): { x: number; y: number }[] => {
    const c = M.cos(g.facing);
    const sn = M.sin(g.facing);
    const L = M.min(g.radius * 0.9, 70);
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i <= 26; i++) {
      const t = -1 + (2 * i) / 26;
      out.push({ x: g.anchorX + c * L * t - sn * off, y: g.anchorY + sn * L * t + c * off });
    }
    return out;
  };

  let formedUpTo = -1;
  let splitFrom = 1e9;
  let everCarved = false;
  let cutEverReshaped = false;
  for (let k = 0; k <= 12; k++) {
    const off = k * g1.radius * 0.5;
    g1.shape = "square";
    cmd.flushPending(Number.MAX_SAFE_INTEGER);
    cmd.selected = [g1.id, g2.id];
    const companiesBefore = w.groups.length;
    const said = cmd.commit(glyphAt(g1, off));
    for (let t = 0; t < 6; t++) w.step();
    if (w.groups.length !== companiesBefore) everCarved = true;
    if (said.startsWith("form")) formedUpTo = off;
    else {
      splitFrom = M.min(splitFrom, off);
      if (g1.shape !== "square") cutEverReshaped = true;
    }
  }

  check("a glyph on the company always forms it up", formedUpTo >= g1.radius * 0.9,
    "formed out to " + formedUpTo.toFixed(0) + " of radius " + g1.radius.toFixed(0));
  check("a stroke clear of the company is always a cut", splitFrom < 1e9 && splitFrom > formedUpTo,
    "cuts from " + splitFrom.toFixed(0) + ", glyphs to " + formedUpTo.toFixed(0));
  check("with clear air between the two, so a shaky hand cannot land between",
    splitFrom - formedUpTo >= g1.radius * 0.4,
    "gap " + (splitFrom - formedUpTo).toFixed(0) + " on a radius of " + g1.radius.toFixed(0));
  check("a glyph never cuts the company up", !everCarved);
  check("and a cut never re-forms it", !cutEverReshaped);
}

// -- 9b3b. lying in wait, and going back on purpose ----------------------------

section("ambush and feint");
{
  // An ambush holds its fire until somebody walks onto it, then hits hard.
  {
    const w = new World({ seed: 111, tilesWide: 80, tilesHigh: 80, soldierCapacity: 512 });
    const hiders: number[] = [];
    for (let i = 0; i < 16; i++) hiders.push(w.spawnSoldier(0, "archer", 1200 + (i % 4) * 14, 1200 + ((i / 4) | 0) * 14, 0));
    // Far enough away that archers (range 250) would normally be shooting.
    const comers: number[] = [];
    for (let i = 0; i < 16; i++) comers.push(w.spawnSoldier(1, "line", 1560 + (i % 4) * 14, 1200 + ((i / 4) | 0) * 14, M.PI));
    const g = w.createGroup(0, hiders) as Group;
    const foe = w.createGroup(1, comers) as Group;
    w.orders.issue({ kind: "ambush", squad: g.id }, 0, w.tick + 1);
    for (let t = 0; t < TICK_RATE * 3; t++) w.step();

    check("men lying in wait hold their fire", g.stance === "ambush" && w.events.length === 0,
      g.stance + ", " + w.events.length + " blows");
    const casualtiesBefore = foe.losses;

    // Now walk them in.
    w.orders.issue({ kind: "move", squad: foe.id, path: [g.anchorX, g.anchorY] }, 1, w.tick + 1);
    let sprungAt = -1;
    for (let t = 0; t < TICK_RATE * 60; t++) {
      w.step();
      if (sprungAt < 0 && g.stance === "attack") sprungAt = w.tick;
    }
    check("and spring it when the enemy walks in", sprungAt > 0, "sprung at tick " + sprungAt);
    check("the enemy pays for walking into it", foe.losses > casualtiesBefore,
      foe.losses + " lost");
  }

  // Lying still in cover is genuinely harder to see than standing about.
  {
    function spottedCount(ambushing: boolean): number {
      const w = new World({ seed: 112, tilesWide: 80, tilesHigh: 80, soldierCapacity: 512 });
      const hiders: number[] = [];
      for (let i = 0; i < 12; i++) hiders.push(w.spawnSoldier(0, "line", 1300 + (i % 4) * 14, 1300 + ((i / 4) | 0) * 14, 0));
      for (let i = 0; i < 12; i++) w.spawnSoldier(1, "scout", 1720 + (i % 4) * 14, 1300 + ((i / 4) | 0) * 14, M.PI);
      const g = w.createGroup(0, hiders) as Group;
      if (ambushing) g.stance = "ambush";
      for (let t = 0; t < TICK_RATE * 4; t++) {
        w.step();
        if (ambushing) g.stance = "ambush"; // hold the stance through the sweep
      }
      let seen = 0;
      for (const m of g.members) if (w.soldiers.alive[m] === 1 && (w.soldiers.seen[m] & 2) !== 0) seen++;
      return seen;
    }
    const openly = spottedCount(false);
    const hidden = spottedCount(true);
    check("men lying in wait are harder to spot than men standing about",
      hidden <= openly, hidden + " seen while hiding vs " + openly + " standing");
  }

  // A feint is a real advance with a real withdrawal already scheduled.
  {
    const w = new World({ seed: 113, tilesWide: 90, tilesHigh: 90, soldierCapacity: 512 });
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) ids.push(w.spawnSoldier(0, "line", 900 + (i % 4) * 14, 1200 + ((i / 4) | 0) * 14, 0));
    for (let i = 0; i < 6; i++) w.spawnSoldier(1, "line", 2500, 1200, M.PI);
    const g = w.createGroup(0, ids) as Group;
    const startX = g.anchorX;
    w.orders.issue({ kind: "feint", squad: g.id, path: [startX + 900, g.anchorY] }, 0, w.tick + 1);

    let furthest = startX;
    let turned = false;
    for (let t = 0; t < TICK_RATE * 40; t++) {
      w.step();
      if (g.anchorX > furthest) furthest = g.anchorX;
      if (g.stance === "retreat") turned = true;
    }
    check("a feint genuinely advances", furthest > startX + 120,
      "reached " + (furthest - startX).toFixed(0) + " out");
    check("and then genuinely turns back", turned, "stance " + g.stance);
    check("heading for the ground it started from",
      g.anchorX < furthest - 40, "at " + g.anchorX.toFixed(0) + ", furthest " + furthest.toFixed(0));
  }

  // Both are orders, so both are refused while setting out.
  {
    const w = new World({ seed: 114, tilesWide: 60, tilesHigh: 60, soldierCapacity: 256 });
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) ids.push(w.spawnSoldier(0, "line", 900 + (i % 4) * 14, 900, 0));
    for (let i = 0; i < 4; i++) w.spawnSoldier(1, "line", 1500, 1500, M.PI);
    const g = w.createGroup(0, ids) as Group;
    w.deploying = true;
    const cmd = new Commander(w, 0);
    cmd.selected = [g.id];
    const zig: { x: number; y: number }[] = [];
    for (let k = 0; k < 7; k++) zig.push({ x: g.anchorX - 120 + k * 95, y: g.anchorY + (k % 2 === 0 ? -140 : 140) });
    const said = cmd.commit(zig);
    for (let t = 0; t < 6; t++) w.step();
    check("lying in wait does nothing while setting out",
      g.stance !== "ambush" && w.orders.size === 0, g.stance + ", said: " + said);
  }
}

// -- 9b3c. arrows run out ------------------------------------------------------

section("volleys");
{
  check("men who shoot carry volleys and men who do not, do not",
    (UNIT_TYPES.archer.volleys ?? 0) > 0 && (UNIT_TYPES.skirmisher.volleys ?? 0) > 0 &&
    (UNIT_TYPES.line.volleys ?? 0) === 0 && (UNIT_TYPES.guard.volleys ?? 0) === 0);

  // A company of archers left shooting will empty its quivers and stop.
  {
    const w = new World({ seed: 121, tilesWide: 80, tilesHigh: 80, soldierCapacity: 512 });
    // Find a clear run of open ground. Placed at a fixed spot the two companies
    // landed either side of a wood, which blocks line of sight -- they never saw
    // each other, never shot, and the test proved nothing.
    let ox = 0;
    let oy = 0;
    outer2: for (let ty = 10; ty < 70; ty++) {
      for (let tx = 10; tx < 60; tx++) {
        let clear = true;
        for (let k = 0; k < 16 && clear; k++) {
          if (TERRAIN_INFO[w.terrain.typeAt(tx + k, ty)].blocksSight ||
              TERRAIN_INFO[w.terrain.typeAt(tx + k, ty)].moveScale <= 0) clear = false;
        }
        if (clear) {
          ox = (tx + 1) * TILE_SIZE;
          oy = (ty + 0.5) * TILE_SIZE;
          break outer2;
        }
      }
    }
    const shooters: number[] = [];
    for (let i = 0; i < 16; i++) shooters.push(w.spawnSoldier(0, "archer", ox + (i % 4) * 14, oy + ((i / 4) | 0) * 14, 0));
    const targets: number[] = [];
    for (let i = 0; i < 40; i++) targets.push(w.spawnSoldier(1, "line", ox + 180 + (i % 8) * 14, oy + ((i / 8) | 0) * 14, M.PI));
    const g = w.createGroup(0, shooters) as Group;
    w.createGroup(1, targets);
    const load = UNIT_TYPES.archer.volleys ?? 0;
    check("they start with a full load", w.soldiers.ammo[shooters[0]] === load, String(w.soldiers.ammo[shooters[0]]));

    for (let t = 0; t < TICK_RATE * 90; t++) w.step();
    let spent = 0;
    for (const m of shooters) if (w.soldiers.alive[m] === 1 && w.soldiers.ammo[m] < load) spent++;
    check("shooting spends arrows", spent > 0, spent + " men have shot");

    // An empty company stops shooting, with the enemy still there in front of
    // it. Tested by emptying the quivers directly rather than by waiting for a
    // long fight to do it -- left to run, one side is wiped out and the match
    // ends, which freezes the world with arrows still in hand and proves
    // nothing either way.
    for (const m of g.members) w.soldiers.ammo[m] = 0;
    for (const m of g.members) w.soldiers.cooldown[m] = 0;
    let shotsWhileDry = 0;
    for (let t = 0; t < TICK_RATE * 10 && !w.outcome; t++) {
      w.step();
      for (const e of w.events) if (e.player === 0 && e.kind === "shot") shotsWhileDry++;
    }
    check("a company out of arrows stops shooting", shotsWhileDry === 0,
      shotsWhileDry + " shots loosed with empty quivers");
  }

  // Standing down refills them, which is the second reason to ever do it.
  {
    const w = new World({ seed: 122, tilesWide: 60, tilesHigh: 60, soldierCapacity: 256 });
    const ids: number[] = [];
    for (let i = 0; i < 8; i++) ids.push(w.spawnSoldier(0, "archer", 900 + (i % 4) * 14, 900, 0));
    for (let i = 0; i < 4; i++) w.spawnSoldier(1, "line", 1600, 1600, M.PI);
    const g = w.createGroup(0, ids) as Group;
    for (const m of ids) w.soldiers.ammo[m] = 2;
    w.orders.issue({ kind: "recover", squad: g.id }, 0, w.tick + 1);
    for (let t = 0; t < TICK_RATE * 25; t++) w.step();
    check("standing down replenishes the quivers", w.soldiers.ammo[ids[0]] > 2,
      "ammo " + w.soldiers.ammo[ids[0]].toFixed(1));
  }
}

// -- 9b3d. the commander's abilities -------------------------------------------

section("abilities");
{
  check("an ability costs points out of the same purse as the men",
    cost({ doctrine: "aggressive", squads: ["line"], abilities: ["barrage"] }) >
    cost({ doctrine: "aggressive", squads: ["line"] }));
  check("doctrine sets the price list",
    abilityCost("barrage", "aggressive") < abilityCost("barrage", "defensive") &&
    abilityCost("shield", "defensive") < abilityCost("shield", "aggressive"),
    "barrage " + abilityCost("barrage", "aggressive") + "/" + abilityCost("barrage", "defensive"));
  check("no doctrine is cheap at everything",
    (["aggressive", "defensive", "maneuver", "magic"] as const).every((d) => {
      const costs = ABILITY_IDS.map((id) => abilityCost(id, d) / ABILITIES[id].cost);
      return costs.some((c) => c < 1) && costs.some((c) => c > 1);
    }));

  // A barrage kills what stands under it, WHOEVER it belongs to.
  {
    const w = new World({ seed: 131, tilesWide: 80, tilesHigh: 80, soldierCapacity: 512 });
    const mine: number[] = [];
    for (let i = 0; i < 12; i++) mine.push(w.spawnSoldier(0, "line", 1200 + (i % 4) * 14, 1200 + ((i / 4) | 0) * 14, 0));
    for (let i = 0; i < 12; i++) w.spawnSoldier(1, "line", 1260 + (i % 4) * 14, 1200 + ((i / 4) | 0) * 14, M.PI);
    w.createGroup(0, mine);
    w.armAbilities(0, ["barrage"]);
    const hpBefore = w.soldiers.hp[mine[0]];
    w.orders.issue({ kind: "ability", squad: -1, ability: "barrage", x: 1230, y: 1215 }, 0, w.tick + 1);
    for (let t = 0; t < TICK_RATE * 4; t++) w.step();
    check("a barrage lands where it was put", w.soldiers.hp[mine[0]] < hpBefore,
      hpBefore.toFixed(0) + " -> " + w.soldiers.hp[mine[0]].toFixed(0));
    // Both sides, properly checked -- the earlier version had an || fallback
    // that would have passed on the friendly damage alone.
    let hurtTheirs = 0;
    for (let i = 0; i < w.soldiers.count; i++) {
      if (w.soldiers.player[i] === 1 && w.soldiers.hp[i] < w.soldiers.maxHp[i]) hurtTheirs++;
    }
    check("and does not care whose men are under it",
      w.soldiers.hp[mine[0]] < hpBefore && hurtTheirs > 0,
      "own man at " + w.soldiers.hp[mine[0]].toFixed(0) + ", " + hurtTheirs + " of theirs hurt");
  }

  // Charges and cooldowns are enforced in the SIM, not the interface.
  {
    const w = new World({ seed: 132, tilesWide: 60, tilesHigh: 60, soldierCapacity: 256 });
    for (let i = 0; i < 4; i++) w.spawnSoldier(0, "line", 900, 900, 0);
    for (let i = 0; i < 4; i++) w.spawnSoldier(1, "line", 1500, 1500, M.PI);
    w.armAbilities(0, ["barrage"]);
    const charges = ABILITIES.barrage.charges;
    for (let k = 0; k < charges + 3; k++) {
      w.orders.issue({ kind: "ability", squad: -1, ability: "barrage", x: 1500, y: 1500 }, 0, w.tick + 1);
      w.step();
    }
    const left = w.abilityState[0].get("barrage");
    check("spending more than you bought is simply refused",
      left !== undefined && left.left >= 0 && left.left < charges,
      "left " + (left ? left.left : "?"));

    // Fired back to back, the cooldown must have stopped most of them.
    check("and a cooldown stops it being spammed",
      left !== undefined && left.left >= charges - 1,
      "only " + (charges - (left?.left ?? 0)) + " got through");
  }

  // A shield turns blows aside; smoke hides the men under it.
  {
    function bloodshed(withShield: boolean): number {
      const w = new World({ seed: 133, tilesWide: 80, tilesHigh: 80, soldierCapacity: 512 });
      // Scouts, not line infantry. Line companies BRACE when they start taking
      // casualties, which halves the damage they take -- and the unshielded
      // company bled sooner, braced sooner, and came out ahead. The shield was
      // being measured against a better defensive trick. Scouts only know how
      // to gallop, which does nothing in a melee, so nothing confounds this.
      const mine: number[] = [];
      for (let i = 0; i < 16; i++) mine.push(w.spawnSoldier(0, "scout", 1200 + (i % 4) * 14, 1200 + ((i / 4) | 0) * 14, 0));
      for (let i = 0; i < 24; i++) w.spawnSoldier(1, "guard", 1270 + (i % 6) * 14, 1200 + ((i / 6) | 0) * 14, M.PI);
      const g = w.createGroup(0, mine) as Group;
      w.createGroup(1, [...Array(24).keys()].map((k) => k + 16));
      if (withShield) {
        w.armAbilities(0, ["shield"]);
        w.orders.issue({ kind: "ability", squad: g.id, ability: "shield", x: g.anchorX, y: g.anchorY }, 0, w.tick + 1);
      }
      for (let t = 0; t < TICK_RATE * 11; t++) w.step();
      let hp = 0;
      for (const m of mine) if (w.soldiers.alive[m] === 1) hp += w.soldiers.hp[m];
      return hp;
    }
    check("a shield wall keeps men alive that would otherwise fall",
      bloodshed(true) > bloodshed(false),
      "shielded " + bloodshed(true).toFixed(0) + " hp vs bare " + bloodshed(false).toFixed(0));
  }

  // A flare shows up men that cover and distance would otherwise hide.
  {
    function seenUnder(withFlare: boolean): number {
      const w = new World({ seed: 135, tilesWide: 90, tilesHigh: 90, soldierCapacity: 512 });
      // One lookout, and an enemy company far off -- beyond what he could pick
      // out on his own.
      w.spawnSoldier(0, "scout", 1200, 1200, 0);
      const foes: number[] = [];
      for (let i = 0; i < 12; i++) foes.push(w.spawnSoldier(1, "line", 2400 + (i % 4) * 14, 1200 + ((i / 4) | 0) * 14, M.PI));
      w.createGroup(1, foes);
      if (withFlare) {
        w.armAbilities(0, ["flare"]);
        w.orders.issue({ kind: "ability", squad: -1, ability: "flare", x: 2420, y: 1215 }, 0, w.tick + 1);
      }
      for (let t = 0; t < TICK_RATE * 3; t++) w.step();
      let seen = 0;
      for (const f of foes) if (w.soldiers.alive[f] === 1 && (w.soldiers.seen[f] & 1) !== 0) seen++;
      return seen;
    }
    const dark = seenUnder(false);
    const lit = seenUnder(true);
    check("a flare shows you ground you could not otherwise see",
      lit > dark, lit + " seen under the flare vs " + dark + " without");
  }

  // Smoke blinds. Checked where the men ARE being seen to begin with, or the
  // count falls from nought to nought and proves nothing -- which is exactly
  // what happened when this was first tried in a live match.
  {
    function seenThrough(withSmoke: boolean): number {
      const w = new World({ seed: 137, tilesWide: 90, tilesHigh: 90, soldierCapacity: 512 });
      const hidden: number[] = [];
      for (let i = 0; i < 12; i++) hidden.push(w.spawnSoldier(0, "line", 1400 + (i % 4) * 14, 1400 + ((i / 4) | 0) * 14, 0));
      // Watchers close enough to see them plainly.
      for (let i = 0; i < 8; i++) w.spawnSoldier(1, "scout", 1560 + (i % 4) * 14, 1400 + ((i / 4) | 0) * 14, M.PI);
      const g = w.createGroup(0, hidden) as Group;
      if (withSmoke) {
        w.armAbilities(0, ["smoke"]);
        w.orders.issue(
          { kind: "ability", squad: -1, ability: "smoke", x: g.anchorX, y: g.anchorY }, 0, w.tick + 1,
        );
      }
      for (let t = 0; t < TICK_RATE * 3; t++) w.step();
      let seen = 0;
      for (const m of hidden) if (w.soldiers.alive[m] === 1 && (w.soldiers.seen[m] & 2) !== 0) seen++;
      return seen;
    }
    const bare = seenThrough(false);
    const smoked = seenThrough(true);
    check("men are plainly visible without smoke", bare > 0, bare + " seen");
    check("and a screen hides them", smoked < bare, smoked + " seen through smoke vs " + bare + " without");
  }

  // The levy turns out where it is called, as a company.
  {
    const w = new World({ seed: 136, tilesWide: 60, tilesHigh: 60, soldierCapacity: 256 });
    for (let i = 0; i < 4; i++) w.spawnSoldier(0, "line", 900, 900, 0);
    for (let i = 0; i < 4; i++) w.spawnSoldier(1, "line", 1600, 1600, M.PI);
    const before = w.soldiers.count;
    const groupsBefore = w.groups.length;
    w.armAbilities(0, ["levy"]);
    w.orders.issue({ kind: "ability", squad: -1, ability: "levy", x: 1100, y: 1100 }, 0, w.tick + 1);
    for (let t = 0; t < TICK_RATE * 2; t++) w.step();
    check("the levy turns out where it was called", w.soldiers.count > before,
      (w.soldiers.count - before) + " men arrived");
    check("and turns out as a company, not a crowd",
      w.groups.length === groupsBefore + 1 &&
      w.groups.some((g) => g.player === 0 && g.members.length > 8),
      w.groups.filter((g) => g.player === 0).map((g) => g.members.length).join(","));
    check("it leaves nothing standing on the field afterwards",
      !w.fields.some((f) => f.ability === "levy"));
  }
}

// -- 9b3e. fresh companies marching on -----------------------------------------

section("reinforcements");
{
  const w = new World({
    seed: 141, tilesWide: 80, tilesHigh: 80, soldierCapacity: 512, duration: 600,
    reinforcements: [
      { atSeconds: 5, player: 0, type: "line", count: 10, x: 900, y: 900 },
      { atSeconds: 9, player: 1, type: "horse", count: 6, x: 1800, y: 1800 },
    ],
  });
  for (let i = 0; i < 6; i++) w.spawnSoldier(0, "line", 1000, 1000, 0);
  for (let i = 0; i < 6; i++) w.spawnSoldier(1, "line", 1900, 1900, M.PI);
  const before = w.soldiers.count;

  for (let t = 0; t < TICK_RATE * 4; t++) w.step();
  check("nobody arrives before their hour", w.soldiers.count === before,
    w.soldiers.count + " men");

  for (let t = 0; t < TICK_RATE * 3; t++) w.step();
  check("the first wave marches on", w.soldiers.count === before + 10,
    w.soldiers.count + " men");
  check("and arrives as a formed company, not a crowd",
    w.groups.some((g) => g.player === 0 && g.members.length === 10),
    w.groups.map((g) => g.player + ":" + g.members.length).join(" "));

  for (let t = 0; t < TICK_RATE * 6; t++) w.step();
  check("the enemy gets theirs too", w.soldiers.count === before + 16,
    w.soldiers.count + " men");

  // The exact-tick test: run well past, and nobody may arrive twice.
  for (let t = 0; t < TICK_RATE * 30; t++) w.step();
  check("a wave arrives once and only once", w.soldiers.count === before + 16,
    w.soldiers.count + " men");
}

// -- 9b4. edge cases and pathologies -------------------------------------------

section("edge cases");
{
  // A company of ONE. Formations divide by member count in several places.
  {
    const w = new World({ seed: 101, tilesWide: 60, tilesHigh: 60, soldierCapacity: 128 });
    const lone = w.spawnSoldier(0, "line", 900, 900, 0);
    for (let i = 0; i < 4; i++) w.spawnSoldier(1, "line", 1700, 1700, M.PI);
    const g = w.createGroup(0, [lone]) as Group;
    for (let t = 0; t < TICK_RATE * 5; t++) w.step();
    check("a company of one man is legal and stays finite",
      g.members.length === 1 && Number.isFinite(g.anchorX) && Number.isFinite(g.radius),
      "anchor " + g.anchorX.toFixed(0) + " radius " + g.radius.toFixed(1));
  }

  // A very large company. Slot tables are sized from membership.
  {
    const w = new World({ seed: 102, tilesWide: 90, tilesHigh: 90, soldierCapacity: 1024 });
    const ids: number[] = [];
    for (let i = 0; i < 240; i++) ids.push(w.spawnSoldier(0, "line", 900 + (i % 20) * 13, 900 + ((i / 20) | 0) * 13, 0));
    for (let i = 0; i < 4; i++) w.spawnSoldier(1, "line", 2400, 2400, M.PI);
    const g = w.createGroup(0, ids) as Group;
    for (let t = 0; t < TICK_RATE * 5; t++) w.step();
    check("a 240-man company forms up without breaking",
      g.slots.length === g.members.length * 2 && Number.isFinite(g.radius) && g.radius > 0,
      g.members.length + " men, radius " + g.radius.toFixed(0));
  }

  // An order into impassable ground. The route must fail safely rather than
  // marching men into a mountain or a river.
  {
    const w = new World({ seed: 103, tilesWide: 80, tilesHigh: 80, soldierCapacity: 256 });
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) ids.push(w.spawnSoldier(0, "line", 900 + (i % 5) * 14, 900, 0));
    for (let i = 0; i < 4; i++) w.spawnSoldier(1, "line", 2200, 2200, M.PI);
    const g = w.createGroup(0, ids) as Group;
    // Find genuinely impassable ground to aim at.
    let target: { x: number; y: number } | null = null;
    for (let ty = 0; ty < 80 && !target; ty++) {
      for (let tx = 0; tx < 80; tx++) {
        if (TERRAIN_INFO[w.terrain.typeAt(tx, ty)].moveScale <= 0) {
          target = { x: (tx + 0.5) * TILE_SIZE, y: (ty + 0.5) * TILE_SIZE };
          break;
        }
      }
    }
    if (target) {
      w.orders.issue({ kind: "move", squad: g.id, path: [target.x, target.y] }, 0, w.tick + 1);
      for (let t = 0; t < TICK_RATE * 30; t++) w.step();
      let drowned = 0;
      for (const m of g.members) {
        if (w.soldiers.alive[m] !== 1) continue;
        if (TERRAIN_INFO[w.terrain.typeAtWorld(w.soldiers.x[m], w.soldiers.y[m])].moveScale <= 0) drowned++;
      }
      check("an order into impassable ground strands nobody in it", drowned === 0, drowned + " in it");
    } else {
      check("an order into impassable ground strands nobody in it", true, "no impassable ground on this map");
    }
  }

  // Nobody may leave the map, however hard they are pushed at the edge.
  {
    const w = new World({ seed: 104, tilesWide: 60, tilesHigh: 60, soldierCapacity: 256 });
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) ids.push(w.spawnSoldier(0, "line", 40 + (i % 4) * 12, 40 + ((i / 4) | 0) * 12, 0));
    for (let i = 0; i < 4; i++) w.spawnSoldier(1, "line", 1400, 1400, M.PI);
    const g = w.createGroup(0, ids) as Group;
    w.orders.issue({ kind: "move", squad: g.id, path: [-4000, -4000] }, 0, w.tick + 1);
    for (let t = 0; t < TICK_RATE * 25; t++) w.step();
    let off = 0;
    for (const m of g.members) {
      if (w.soldiers.alive[m] !== 1) continue;
      if (w.soldiers.x[m] < 0 || w.soldiers.y[m] < 0 ||
          w.soldiers.x[m] > w.terrain.worldWidth || w.soldiers.y[m] > w.terrain.worldHeight) off++;
    }
    check("men ordered off the map stay on it", off === 0, off + " off the edge");
  }
}

// -- 9c. the account of the battle ---------------------------------------------

section("after-action");
{
  // Every company gets a name, and the same men always produce the same one --
  // a name that changed between a match and its replay would be a desync you
  // could see.
  {
    const w = new World({ seed: 61, tilesWide: 60, tilesHigh: 60, soldierCapacity: 256 });
    const foot: number[] = [];
    for (let i = 0; i < 12; i++) foot.push(w.spawnSoldier(0, "line", 900 + (i % 4) * 15, 900 + ((i / 4) | 0) * 15, 0));
    const horse: number[] = [];
    for (let i = 0; i < 8; i++) horse.push(w.spawnSoldier(0, "horse", 1400 + (i % 4) * 15, 900 + ((i / 4) | 0) * 15, 0));
    const a = w.createGroup(0, foot) as Group;
    const b = w.createGroup(0, horse) as Group;
    check("a company of foot is numbered", /Foot$/.test(a.name), a.name);
    check("a company of horse is named for a person", /'s Horse$/.test(b.name), b.name);
    check("two companies never share a name", a.name !== b.name, a.name + " / " + b.name);

    const w2 = new World({ seed: 61, tilesWide: 60, tilesHigh: 60, soldierCapacity: 256 });
    const foot2: number[] = [];
    for (let i = 0; i < 12; i++) foot2.push(w2.spawnSoldier(0, "line", 900 + (i % 4) * 15, 900 + ((i / 4) | 0) * 15, 0));
    check("the same company is named the same way twice",
      (w2.createGroup(0, foot2) as Group).name === a.name);
  }

  // A blow from behind is reported as a flanking kill, whatever the weapon.
  {
    const w = new World({ seed: 62, tilesWide: 70, tilesHigh: 70, soldierCapacity: 256 });
    const victims: number[] = [];
    // Facing EAST, with the enemy set on them from the WEST: every blow lands
    // outside the frontal arc.
    for (let i = 0; i < 14; i++) victims.push(w.spawnSoldier(0, "line", 1400 + (i % 4) * 15, 1200 + ((i / 4) | 0) * 15, 0));
    const killers: number[] = [];
    for (let i = 0; i < 26; i++) killers.push(w.spawnSoldier(1, "guard", 1330 + (i % 6) * 14, 1200 + ((i / 6) | 0) * 14, 0));
    w.createGroup(0, victims);
    w.createGroup(1, killers);
    for (let t = 0; t < TICK_RATE * 45 && w.casualtiesByCause[0].reduce((x, y) => x + y, 0) < 6; t++) w.step();

    const bill = w.casualtiesByCause[0];
    const total = bill[0] + bill[1] + bill[2];
    check("casualties are attributed to a cause", total > 0, JSON.stringify(bill));
    check("men cut down from behind are recorded as flanked", bill[2] > 0, JSON.stringify(bill));
  }

  // A company that loses its nerve is recorded once, with a cause.
  {
    const w = new World({ seed: 63, tilesWide: 70, tilesHigh: 70, soldierCapacity: 256 });
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) ids.push(w.spawnSoldier(0, "skirmisher", 1400 + (i % 4) * 15, 1200 + ((i / 4) | 0) * 15, 0));
    for (let i = 0; i < 30; i++) w.spawnSoldier(1, "guard", 1330 + (i % 6) * 14, 1200 + ((i / 6) | 0) * 14, 0);
    const g = w.createGroup(0, ids) as Group;
    w.createGroup(1, [...Array(30).keys()].map((k) => k + 12));
    for (let t = 0; t < TICK_RATE * 90 && g.brokeAt < 0; t++) w.step();

    check("a company that breaks is recorded", g.brokeAt >= 0, "brokeAt " + g.brokeAt);
    const mine = w.breakages.filter((b) => b.player === 0);
    check("recorded once, not once per tick", mine.length <= 2, mine.length + " entries");
    check("and with a cause the player can learn from",
      mine.length > 0 && mine[0].cause.length > 0, mine.length > 0 ? mine[0].cause : "-");
    check("the report names the company", mine.length > 0 && mine[0].name === g.name,
      mine.length > 0 ? mine[0].name : "-");
  }
}

section("orders in practice");
{
  function army(w: World, player: number, x: number, y: number, n = 10): Group {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(w.spawnSoldier(player, "line", x + (i % 4) * 13, y + ((i / 4) | 0) * 13, 0));
    }
    return w.createGroup(player, ids) as Group;
  }
  function heartOver(g: Group, size: number): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i <= 56; i++) {
      const t = (i / 56) * Math.PI * 2;
      const hx = 16 * Math.sin(t) * Math.sin(t) * Math.sin(t);
      const hy = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
      out.push({ x: g.anchorX + (hx / 16) * size, y: g.anchorY + (hy / 16) * size });
    }
    return out;
  }

  // -- CARVING A COMPANY WITH THE LASSO -------------------------------------
  //
  // There is no separate "divide" gesture. A loop drawn round part of a company
  // takes exactly those men out of it, because a lasso works on MEN and
  // createGroup already removes each man from whatever he was in.
  {
    const w = new World({ seed: 47, tilesWide: 90, tilesHigh: 70, soldierCapacity: 512 });
    const ids: number[] = [];
    for (let i = 0; i < 24; i++) ids.push(w.spawnSoldier(0, "line", 800 + (i % 12) * 30, 1000 + ((i / 12) | 0) * 24, 0));
    army(w, 1, 2600, 1100);
    const g = w.createGroup(0, ids) as Group;
    const cmd = new Commander(w, 0);
    cmd.selected = [];

    // A loop around the LEFT half only. The company's anchor sits outside it,
    // which is exactly the case that used to make carving impossible.
    const cx = 860;
    const loop: { x: number; y: number }[] = [];
    for (let k = 0; k <= 40; k++) {
      const a = (k / 40) * M.PI * 2;
      loop.push({ x: cx + M.cos(a) * 120, y: 1012 + M.sin(a) * 90 });
    }
    const said = cmd.commit(loop);
    const mine = w.groups.filter((q) => q.player === 0);
    check("a loop round part of a company carves those men out", mine.length === 2,
      mine.length + " companies, said: " + said);
    check("and says it split them off rather than merely grouping them",
      said.startsWith("split off"), said);
    check("the men are divided, not duplicated",
      mine.reduce((n, q) => n + q.members.length, 0) === 24,
      mine.map((q) => q.members.length).join(" + "));
    check("the carved half is the half that was enclosed",
      mine.every((q) => q.members.every((m) => w.soldiers.group[m] === q.id)));
    check("and the new company is the one now selected",
      cmd.selected.length === 1 && cmd.selected[0] !== g.id, JSON.stringify(cmd.selected));
  }

  // A tight loop round part of a company BEGINS on top of that company, so the
  // anchor rule claimed it and read it as a formation glyph -- every honest
  // attempt to cut a company in two re-formed it instead. A closed stroke drawn
  // while holding nothing is always a gather, whatever it started over.
  {
    const w = new World({ seed: 51, tilesWide: 90, tilesHigh: 70, soldierCapacity: 512 });
    const ids: number[] = [];
    for (let i = 0; i < 24; i++) ids.push(w.spawnSoldier(0, "line", 900 + (i % 6) * 26, 1000 + ((i / 6) | 0) * 26, 0));
    army(w, 1, 2600, 1100);
    const g = w.createGroup(0, ids) as Group;
    const shapeBefore = g.shape;
    const cmd = new Commander(w, 0);
    cmd.selected = [];
    // Centred ON the men and small enough that the anchor would have taken it.
    const loop: { x: number; y: number }[] = [];
    for (let k = 0; k <= 40; k++) {
      const a2 = (k / 40) * M.PI * 2;
      loop.push({ x: g.anchorX + M.cos(a2) * 60, y: g.anchorY - 26 + M.sin(a2) * 34 });
    }
    const said = cmd.commit(loop);
    check("a tight loop begun ON a company still carves rather than re-forming it",
      said.startsWith("split off"), said);
    check("and the company it came from kept its shape",
      w.groups.filter((q) => q.player === 0).length === 2 && g.shape === shapeBefore,
      w.groups.filter((q) => q.player === 0).length + " companies, shape " + g.shape);
  }

  // A loop thrown round a WHOLE company leaves it whole -- that is gathering,
  // not carving, and it must not be reported as a split.
  {
    const w = new World({ seed: 48, tilesWide: 90, tilesHigh: 70, soldierCapacity: 512 });
    const ids: number[] = [];
    for (let i = 0; i < 16; i++) ids.push(w.spawnSoldier(0, "line", 900 + (i % 4) * 20, 1000 + ((i / 4) | 0) * 20, 0));
    w.createGroup(0, ids);
    const cmd = new Commander(w, 0);
    cmd.selected = [];
    const loop: { x: number; y: number }[] = [];
    for (let k = 0; k <= 40; k++) {
      const a = (k / 40) * M.PI * 2;
      loop.push({ x: 930 + M.cos(a) * 260, y: 1030 + M.sin(a) * 260 });
    }
    const said = cmd.commit(loop);
    check("a loop round a whole company is gathering, not carving",
      said.startsWith("grouped"), said);
    check("and leaves exactly one company", w.groups.filter((q) => q.player === 0).length === 1);
  }

  // -- SPLIT ----------------------------------------------------------------  // -- SPLIT ----------------------------------------------------------------
  {
    const w = new World({ seed: 41, tilesWide: 90, tilesHigh: 70, soldierCapacity: 512 });
    const gs = [army(w, 0, 900, 900), army(w, 0, 1300, 900), army(w, 0, 900, 1300), army(w, 0, 1300, 1300)];
    army(w, 1, 2600, 1100);
    const cmd = new Commander(w, 0);
    cmd.selected = gs.map((g) => g.id);

    const cut: { x: number; y: number }[] = [];
    for (let i = 0; i < 30; i++) cut.push({ x: 700 + i * 30, y: 1100 });
    cmd.commit(cut);
    check("a split is held for the pair window, not applied at once",
      cmd.selected.length === 4 && cmd.pendingRail !== null, cmd.selected.length + " selected");

    cmd.flushPending(Number.MAX_SAFE_INTEGER);
    check("the split then keeps exactly one side", cmd.selected.length === 2,
      cmd.selected.length + " of 4 kept");
    check("it keeps the side left of the stroke",
      cmd.selected.every((id) => (w.groupById(id) as Group).anchorY < 1100),
      cmd.selected.map((id) => Math.round((w.groupById(id) as Group).anchorY)).join(","));

    // Drawn the other way, it keeps the other half.
    cmd.selected = gs.map((g) => g.id);
    cmd.commit([...cut].reverse());
    cmd.flushPending(Number.MAX_SAFE_INTEGER);
    check("drawn the other way it keeps the other half",
      cmd.selected.length === 2 && cmd.selected.every((id) => (w.groupById(id) as Group).anchorY > 1100),
      cmd.selected.map((id) => Math.round((w.groupById(id) as Group).anchorY)).join(","));
  }

  // -- RECOVER --------------------------------------------------------------
  {
    const w = new World({ seed: 42, tilesWide: 90, tilesHigh: 70, soldierCapacity: 512 });
    const g = army(w, 0, 900, 900);
    army(w, 1, 2600, 900);
    for (const m of g.members) {
      w.soldiers.morale[m] = 0.3;
      w.soldiers.hp[m] = 30;
    }
    const cmd = new Commander(w, 0);
    // ONE group selected: the case that used to fall through and read as patrol.
    cmd.selected = [g.id];
    cmd.commit(heartOver(g, 260));
    w.step();
    w.step();
    check("a heart recovers a single group", g.stance === "recover", g.stance);
    check("and it locks for the full term",
      (g.recoverUntil - w.tick) / TICK_RATE > RECOVER_LOCK_SECONDS - 1.5,
      ((g.recoverUntil - w.tick) / TICK_RATE).toFixed(1) + "s");

    const hpBefore = w.soldiers.hp[g.members[0]];
    const parked = g.anchorX;
    w.orders.issue({ kind: "move", squad: g.id, path: [2200, 900] }, 0, w.tick + 1);
    for (let t = 0; t < TICK_RATE * 12; t++) w.step();
    check("recovering heals and steadies",
      w.soldiers.hp[g.members[0]] > hpBefore && w.soldiers.morale[g.members[0]] > 0.3,
      "hp " + hpBefore.toFixed(0) + "->" + w.soldiers.hp[g.members[0]].toFixed(0));
    check("and refuses orders while it lasts",
      g.stance === "recover" && Math.abs(g.anchorX - parked) < 3,
      g.stance + ", moved " + (g.anchorX - parked).toFixed(1));

    // And it must SAY so. The sim drops an order aimed at a recovering group,
    // so a pen that answered "move" left the player watching nothing happen for
    // thirty seconds with no explanation on screen. The group verbs always
    // reported this; the ordinary orders quietly claimed to have worked.
    {
      const cmdR = new Commander(w, 0);
      cmdR.selected = [g.id];
      const march: { x: number; y: number }[] = [];
      for (let i = 0; i < 30; i++) march.push({ x: g.anchorX + 200 + i * 20, y: g.anchorY - 120 });
      const saidMarch = cmdR.commit(march);
      check("and says so rather than claiming the order worked",
        saidMarch === "locked (recovering)", saidMarch);

      const heart2: { x: number; y: number }[] = [];
      for (let i = 0; i <= 46; i++) {
        const t = (i / 46) * M.PI * 2;
        const hx = 16 * M.sin(t) * M.sin(t) * M.sin(t);
        const hy = -(13 * M.cos(t) - 5 * M.cos(2 * t) - 2 * M.cos(3 * t) - M.cos(4 * t));
        heart2.push({ x: g.anchorX + 500 + (hx / 16) * 240, y: g.anchorY + (hy / 16) * 240 });
      }
      cmdR.selected = [g.id];
      check("a second recover on a recovering group says it is already standing down",
        cmdR.commit(heart2) === "already recovering");
    }
  }

  // -- CURVED ROUTES --------------------------------------------------------
  {
    const w = new World({ seed: 51, tilesWide: 120, tilesHigh: 90, soldierCapacity: 256 });
    const g = army(w, 0, 800, 900, 12);
    army(w, 1, 3200, 900, 6);
    const cmd = new Commander(w, 0);
    cmd.selected = [g.id];

    // A swept arc, as a hand would draw it.
    const stroke: { x: number; y: number }[] = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      stroke.push({ x: 830 + t * 1400, y: 900 + Math.sin(t * Math.PI) * 520 });
    }
    cmd.commit(stroke);
    w.step();
    w.step();

    function turns(p: readonly number[]): number[] {
      const out: number[] = [];
      for (let i = 2; i + 3 < p.length; i += 2) {
        const a = Math.atan2(p[i + 1] - p[i - 1], p[i] - p[i - 2]);
        const b = Math.atan2(p[i + 3] - p[i + 1], p[i + 2] - p[i]);
        let d = Math.abs(b - a);
        while (d > Math.PI) d = Math.abs(d - Math.PI * 2);
        out.push((d * 180) / Math.PI);
      }
      return out;
    }
    const t = turns(g.path);
    const mean = t.reduce((a, b) => a + b, 0) / Math.max(t.length, 1);
    check("a drawn arc becomes a many-pointed route, not two corners",
      g.path.length / 2 > 12, g.path.length / 2 + " waypoints");
    check("and its turns are gentle rather than sharp", mean < 25,
      "mean turn " + mean.toFixed(1) + " deg");

    let offRoad = 0;
    for (let i = 0; i < g.path.length; i += 2) {
      if (TERRAIN_INFO[w.terrain.typeAtWorld(g.path[i], g.path[i + 1])].moveScale <= 0) offRoad++;
    }
    check("smoothing never routes anyone through a river", offRoad === 0, offRoad + " bad waypoints");

    // The group must actually track the sweep, not cut the corner.
    let peak = g.anchorY;
    for (let k = 0; k < 900; k++) {
      w.step();
      peak = Math.max(peak, g.anchorY);
    }
    check("the group follows the curve it was given", peak > 1200,
      "reached y=" + peak.toFixed(0) + " on a arc drawn to 1420");

    // A hard right angle must round off, but only where it is safe to.
    const corner = [700, 700, 1400, 700, 1400, 1400];
    const rounded = smoothRoute(w.terrain, corner, 2);
    check("a right-angle corner is rounded",
      Math.max(...turns(rounded)) < 50 && rounded.length > corner.length,
      Math.max(...turns(corner)).toFixed(0) + " deg -> " + Math.max(...turns(rounded)).toFixed(0) + " deg");
  }
}

// -- 9b. selection context -----------------------------------------------------

section("selection");
{
  // The same stroke has to mean different things depending on what is selected.
  // This is context, not shape, so the confusion matrix cannot test it: every
  // case below is the SAME geometry read against a different selection.
  const R = 58;
  const squads: SquadView[] = [
    { id: 1, player: 0, x: 900, y: 900, radius: R, size: 20, facing: 0, visible: true },
    { id: 2, player: 0, x: 1100, y: 900, radius: R, size: 20, facing: 0, visible: true },
    { id: 3, player: 0, x: 900, y: 1100, radius: R, size: 20, facing: 0, visible: true },
    { id: 4, player: 0, x: 1100, y: 1100, radius: R, size: 20, facing: 0, visible: true },
    { id: 9, player: 1, x: 2600, y: 1000, radius: R, size: 20, facing: Math.PI, visible: true },
  ];
  const ctx = (selected: number[]): GestureContext =>
    ({ player: 0, squads, selected, homeX: 0, pendingLine: null });

  // One straight line on open ground, well clear of every squad.
  const cut = [{ x: 1000, y: 500 }, { x: 1000, y: 1500 }];

  const withGroup = recognize(cut, ctx([1, 2, 3, 4]));
  const withOne = recognize(cut, ctx([1]));
  const withNone = recognize(cut, ctx([]));

  check("with a group selected, a line splits the group", withGroup?.kind === "split",
    withGroup ? withGroup.kind : "null");
  check("with one squad selected, the same line is a move", withOne?.kind === "move",
    withOne ? withOne.kind : "null");
  check("with nothing selected, the same line commands nothing", withNone === null,
    withNone ? withNone.kind : "null");

  // A stroke begun ON a squad always commands that squad, group or not.
  const fromSquad = [{ x: 900, y: 900 }, { x: 1500, y: 640 }, { x: 1900, y: 700 }];
  const anchored = recognize(fromSquad, ctx([1, 2, 3, 4]));
  check("a stroke begun on a squad still moves that squad", anchored?.kind === "move");
  check("and it narrows the selection to that squad",
    anchored !== null && anchored.squads.length === 1 && anchored.squads[0] === 1);

  // Tapping empty ground clears the selection; tapping a squad selects it.
  const tapEmpty = recognize([{ x: 1700, y: 1700 }, { x: 1702, y: 1701 }], ctx([1, 2, 3, 4]));
  check("tapping outside a selected group deselects it",
    tapEmpty?.kind === "select" && tapEmpty.squads.length === 0,
    tapEmpty ? tapEmpty.kind + " -> " + JSON.stringify(tapEmpty.squads) : "null");

  const tapSquad = recognize([{ x: 1100, y: 1100 }, { x: 1102, y: 1101 }], ctx([1]));
  check("tapping a squad selects just it",
    tapSquad?.kind === "select" && tapSquad.squads.length === 1 && tapSquad.squads[0] === 4);

  // Group verbs must stay locked away behind an actual group.
  const bigRing: { x: number; y: number }[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = (i / 40) * Math.PI * 2;
    bigRing.push({ x: 1000 + Math.cos(t) * 520, y: 1000 + Math.sin(t) * 520 });
  }
  check("a large ring is a patrol AREA for a group",
    recognize(bigRing, ctx([1, 2, 3, 4]))?.kind === "patrolArea");
  check("the same ring is a patrol CIRCUIT for a lone squad",
    recognize(bigRing, ctx([1]))?.kind === "patrol");
}

// -- 10. golden hashes ---------------------------------------------------------

section("goldens");
{
  // Two tiers, deliberately separated.
  //
  // The WORLD hash is expected to move: every phase that touches movement,
  // combat or morale legitimately changes it. Regenerate with
  //   UPDATE_GOLDEN=1 node tools/headless.ts
  // and say why in the commit message.
  //
  // The STABLE hashes pin the terrain generator, the PRNG arithmetic and the
  // pathfinder, which no later phase should alter. Keeping them apart is the
  // point: if the only anchor were the world hash, regenerating would become
  // reflexive and the suite would quietly stop catching anything. A move in a
  // stable hash is a bug until proven otherwise, and needs UPDATE_STABLE=1.
  const goldenPath = fileURLToPath(new URL("./golden.json", import.meta.url));
  type Golden = {
    world: { ticks: number; final: string };
    clash: { ticks: number; final: string };
    stable: { terrain: string; rng: string; paths: string };
  };

  const stableTerrain = hashTerrain(
    generateTerrain(provingGround.tilesWide, provingGround.tilesHigh, provingGround.seed),
  );
  const stableRng = [Stream.Combat, Stream.Morale, Stream.Ai, Stream.Spawn]
    .map((st) => hashRngStream(Rng.create(provingGround.seed, st), 10000))
    .join("-");
  const stablePaths = hashPaths(pathResults);

  const existing: Golden | null = existsSync(goldenPath)
    ? (JSON.parse(readFileSync(goldenPath, "utf8")) as Golden)
    : null;

  const next: Golden = {
    world: {
      ticks: TICKS,
      final: process.env.UPDATE_GOLDEN || !existing ? liveFinal : existing.world.final,
    },
    clash: {
      ticks: CLASH_TICKS,
      final: process.env.UPDATE_GOLDEN || !existing ? clashFinal : existing.clash.final,
    },
    stable: {
      terrain: process.env.UPDATE_STABLE || !existing ? stableTerrain : existing.stable.terrain,
      rng: process.env.UPDATE_STABLE || !existing ? stableRng : existing.stable.rng,
      paths: process.env.UPDATE_STABLE || !existing ? stablePaths : (existing.stable.paths ?? stablePaths),
    },
  };

  if (process.env.UPDATE_GOLDEN || process.env.UPDATE_STABLE || !existing) {
    writeFileSync(goldenPath, JSON.stringify(next, null, 2));
    console.log("  golden file written");
  }

  if (existing) {
    check("terrain generator unchanged (stable)", existing.stable.terrain === stableTerrain,
      "expected " + existing.stable.terrain + ", got " + stableTerrain);
    check("rng streams unchanged (stable)", existing.stable.rng === stableRng);
    check("pathfinder routes unchanged (stable)", (existing.stable.paths ?? stablePaths) === stablePaths,
      "expected " + existing.stable.paths + ", got " + stablePaths);
    check("world state matches golden", existing.world.ticks === TICKS && existing.world.final === liveFinal,
      "expected " + existing.world.final + ", got " + liveFinal + " (UPDATE_GOLDEN=1 if intended)");
    check("battle state matches golden",
      existing.clash.ticks === CLASH_TICKS && existing.clash.final === clashFinal,
      "expected " + existing.clash.final + ", got " + clashFinal + " (UPDATE_GOLDEN=1 if intended)");
  }

  console.log("");
  console.log("  seed        0x" + provingGround.seed.toString(16));
  console.log("  clash hash  " + clashFinal);
  console.log("  ticks       " + TICKS + " (" + TICKS / TICK_RATE + "s)");
  console.log("  world hash  " + liveFinal);
}

console.log("");
console.log(failures === 0 ? "all checks passed" : failures + " check(s) FAILED");
console.log("");
process.exit(failures === 0 ? 0 : 1);
