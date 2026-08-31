/**
 * Headless determinism and correctness harness.
 *
 * Runs the simulation with no browser, no canvas, no rAF -- which is only
 * possible because src/sim/ is pure. The replay and golden checks are the
 * regression suite for the whole simulation and the desync detector for
 * Phase 10 netplay.
 */

import { World, TICK_RATE, type Squad } from "../src/sim/world.ts";
import { MELEE_RANGE } from "../src/sim/combat.ts";
import { evaluate, score } from "../src/sim/victory.ts";
import { effectiveSight, hasLineOfSight, rangeFromHeight, FogField } from "../src/sim/vision.ts";
import { PLAYSTYLES } from "../src/sim/ai.ts";
import { ROUT_THRESHOLD } from "../src/sim/morale.ts";
import { hashWorld, hashTerrain, hashRngStream, hashPaths } from "../src/sim/hash.ts";
import { Rng, Stream } from "../src/sim/rng.ts";
import * as M from "../src/sim/math.ts";
import { provingGround } from "../src/content/levels/proving-ground.ts";
import { generateTerrain, Terrain, TERRAIN_INFO, TILE_SIZE } from "../src/sim/terrain.ts";
import { formationSlots, formationRadius, FORMATION_SHAPES } from "../src/sim/formations.ts";
import { findPath } from "../src/sim/pathfind.ts";
import { UNIT_TYPES, type UnitTypeId } from "../src/content/unit-types.ts";
import type { Order } from "../src/sim/orders.ts";
import { runConfusionMatrix, printMatrix } from "./test-gestures.ts";
import { recognize, type GestureContext, type SquadView } from "../src/input/gestures.ts";
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
  });
  for (const zone of provingGround.deployment) {
    for (let i = 0; i < ARMY.length; i++) {
      const col = i % 3;
      const row = (i / 3) | 0;
      const x = (zone.x + 4 + col * 7) * TILE_SIZE;
      const y = (zone.y + 5 + row * 10) * TILE_SIZE;
      w.spawnSquad(zone.player, ARMY[i], x, y, zone.player === 0 ? 0 : M.PI);
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
    w.spawnSquad(0, ARMY[i], 1500 - col * 150, 1500 + row * 150, 0);
    w.spawnSquad(1, ARMY[i], 2150 + col * 150, 1500 + row * 150, M.PI);
  }
  for (const q of w.squads) {
    const foe = w.squads.find((o) => o.player !== q.player && o.live > 0);
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
  for (const q of w.squads) {
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
  check("all squads and soldiers spawned", liveWorld.squads.length === ARMY.length * 2 && soldiers === expected,
    liveWorld.squads.length + " squads, " + soldiers + " soldiers");

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
  for (const q of w.squads) {
    const c = Math.cos(q.facing);
    const sn = Math.sin(q.facing);
    let blockedSlots = 0;
    for (let i = 0; i < q.count; i++) {
      const tx = q.anchorX + q.slots[i * 2] * c - q.slots[i * 2 + 1] * sn;
      const ty = q.anchorY + q.slots[i * 2] * sn + q.slots[i * 2 + 1] * c;
      if (TERRAIN_INFO[w.terrain.typeAtWorld(tx, ty)].moveScale <= 0) blockedSlots++;
    }
    if (blockedSlots > 0) deformed++;
    else if (q.cohesion < worstOpen) worstOpen = q.cohesion;
  }
  check("squads on open ground hold formation", worstOpen > 0.85,
    "worst " + worstOpen.toFixed(2) + " (" + deformed + " squads terrain-deformed)");

  // A clean march with no terrain interference: the shape must survive the
  // whole trip, including the wheel at the waypoint.
  const w3 = buildWorld();
  const marcher = w3.squads[0];
  marcher.anchorX = 900;
  marcher.anchorY = 1400;
  for (let i = 0; i < marcher.count; i++) {
    w3.soldiers.x[marcher.first + i] = 900;
    w3.soldiers.y[marcher.first + i] = 1400;
  }
  w3.orders.issue({ kind: "move", squad: marcher.id, path: [1900, 1400, 1900, 2400] }, 0, 0);
  let worstMarch = 1;
  let settled = false;
  for (let t = 0; t < 1400; t++) {
    w3.step();
    if (t > 60) worstMarch = Math.min(worstMarch, marcher.cohesion);
    if (marcher.stance === "idle" && t > 60) {
      settled = true;
      break;
    }
  }
  check("formation survives a march and a wheel", settled && worstMarch > 0.75,
    "worst mid-march cohesion " + worstMarch.toFixed(2) + (settled ? "" : " (never arrived)"));

  // Soldiers are a second movement integrator; the half-tile bound has to hold
  // for them too, not just for squad anchors. Drive squads at a river directly.
  const w2 = buildWorld();
  const g = w2.terrain;
  let placed = 0;
  for (const q of w2.squads) {
    if (placed >= 6) break;
    // Park the squad on the west bank and order it straight across.
    for (let ty = 10; ty < g.height - 10 && placed < 6; ty += 17) {
      let tx = 4;
      while (tx < g.width - 2 && g.typeAt(tx, ty) !== Terrain.Water) tx++;
      if (tx >= g.width - 2 || g.typeAt(tx - 2, ty) === Terrain.Bridge) continue;
      q.anchorX = (tx - 2) * TILE_SIZE;
      q.anchorY = (ty + 0.5) * TILE_SIZE;
      for (let i = 0; i < q.count; i++) {
        w2.soldiers.x[q.first + i] = q.anchorX;
        w2.soldiers.y[q.first + i] = q.anchorY;
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
    const stuck = w4.squads[0];
    stuck.anchorX = wx;
    stuck.anchorY = wy;
    for (let i = 0; i < stuck.count; i++) {
      w4.soldiers.x[stuck.first + i] = wx;
      w4.soldiers.y[stuck.first + i] = wy;
    }
    w4.orders.issue({ kind: "move", squad: stuck.id, path: [wx - 400, wy] }, 0, w4.tick + 1);
    for (let t = 0; t < TICK_RATE * 25; t++) w4.step();
    let stillWet = 0;
    for (let i = 0; i < stuck.count; i++) {
      const id = stuck.first + i;
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
    const q = w.squads[0];
    q.patrol = [q.anchorX, q.anchorY, q.anchorX + 400, q.anchorY, q.anchorX + 400, q.anchorY + 400];
    q.stance = "patrol";
    return w;
  }

  const base = twin();
  const same = twin();
  check("identical worlds hash identically", hashWorld(base) === hashWorld(same));

  const legDiff = twin();
  legDiff.squads[0].patrolLeg = 2;
  check("patrol leg is observed", hashWorld(legDiff) !== hashWorld(base));

  const dirDiff = twin();
  dirDiff.squads[0].patrolForward = false;
  check("patrol direction is observed", hashWorld(dirDiff) !== hashWorld(base));

  const stanceDiff = twin();
  stanceDiff.squads[0].stance = "hold";
  check("stance is observed", hashWorld(stanceDiff) !== hashWorld(base));

  const shapeDiff = twin();
  shapeDiff.squads[0].shape = "wedge";
  check("formation shape is observed", hashWorld(shapeDiff) !== hashWorld(base));

  const holdDiff = twin();
  holdDiff.squads[0].holdRadius = 250;
  check("hold zone is observed", hashWorld(holdDiff) !== hashWorld(base));

  const lockDiff = twin();
  lockDiff.squads[0].recoverUntil = 400;
  check("recovery lock is observed", hashWorld(lockDiff) !== hashWorld(base));
}

// -- 8c. recovery is a commitment ----------------------------------------------

section("recover");
{
  const w = buildWorld();
  const q = w.squads[0];
  const other = w.squads[1];
  q.morale = 0.3;
  for (let i = 0; i < q.count; i++) w.soldiers.hp[q.first + i] = 20;
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

  const moraleMid = q.morale;
  const hpMid = w.soldiers.hp[q.first];
  check("morale climbs while recovering", moraleMid > 0.3, moraleMid.toFixed(3));
  check("hit points climb while recovering", hpMid > 20, hpMid.toFixed(1));

  // Run out the clock.
  for (let t = 0; t < TICK_RATE * 26; t++) w.step();
  check("the lock lifts and the squad stands to", q.stance === "idle" && q.recoverUntil === 0,
    q.stance + " / until " + q.recoverUntil);
  check("morale recovered over the full term", q.morale > 0.9 && q.morale <= 1, q.morale.toFixed(3));
  check("wounded soldiers healed", w.soldiers.hp[q.first] > 40, w.soldiers.hp[q.first].toFixed(1));

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
  const startMen = w.squads.reduce((n, q) => n + q.live, 0);
  const t0 = Date.now();
  for (let t = 0; t < CLASH_TICKS && !w.outcome; t++) w.step();
  const elapsed = Date.now() - t0;

  const endMen = w.squads.reduce((n, q) => n + q.live, 0);
  const losses = [0, 1].map((p) =>
    w.squads.filter((q) => q.player === p).reduce((n, q) => n + q.losses, 0),
  );
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
  check("kills are credited to squads",
    w.squads.reduce((n, q) => n + q.kills, 0) === losses[0] + losses[1],
    w.squads.reduce((n, q) => n + q.kills, 0) + " credited vs " + (losses[0] + losses[1]) + " dead");

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
  function park(w: World, q: Squad, x: number, y: number): void {
    q.anchorX = x;
    q.anchorY = y;
    q.stance = "idle";
    q.path.length = 0;
    for (let i = 0; i < q.count; i++) {
      w.soldiers.x[q.first + i] = x;
      w.soldiers.y[q.first + i] = y;
    }
  }

  /** Reduce a squad to n living soldiers, parked on a point. */
  function trim(w: World, q: Squad, n: number, x: number, y: number, hp: number): void {
    for (let i = 0; i < q.count; i++) {
      const id = q.first + i;
      const keep = i < n;
      w.soldiers.alive[id] = keep ? 1 : 0;
      w.soldiers.hp[id] = keep ? hp : 0;
      w.soldiers.x[id] = x + i * 2;
      w.soldiers.y[id] = y;
      w.soldiers.cooldown[id] = 0;
    }
    q.live = n;
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
    const a = w.squads.find((q) => q.player === 0 && q.type === "line") as Squad;
    const b = w.squads.find((q) => q.player === 1 && q.type === "line") as Squad;
    trim(w, a, 1, 2000, 2000, 1);
    trim(w, b, 1, 2000 + MELEE_RANGE * 0.5, 2000, 1);
    for (let t = 0; t < 3 && (a.live > 0 && b.live > 0); t++) w.step();
    check("mutual kills are simultaneous, not index-ordered", a.live === 0 && b.live === 0,
      "player0 left " + a.live + ", player1 left " + b.live);
  }

  // Reach decides how a unit fights, and archers must not have to close.
  {
    const w = buildWorld();
    const archer = w.squads.find((q) => q.player === 0 && q.type === "archer") as Squad;
    const victim = w.squads.find((q) => q.player === 1 && q.type === "line") as Squad;
    let corner = 0;
    for (const q of w.squads) {
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
    check("archers engage at range without closing", shots > 0 && victim.live < 20,
      shots + " shots, target down to " + victim.live + "/20");
    check("ranged fire spreads across several targets", victims.size > 1, victims.size + " distinct targets");
    check("archers stayed at range", Math.abs(archer.anchorX - 2000) < 40,
      "moved " + (archer.anchorX - 2000).toFixed(0));
  }

  // Casualties must re-flow the formation, or the squad keeps holes where its
  // dead stood while cohesion still reads 1.00 because it only counts survivors.
  {
    const w = buildWorld();
    const q = w.squads[0];
    let n = 0;
    for (const other of w.squads) {
      if (other === q) continue;
      park(w, other, 300 + (n % 5) * 80, 3500 + ((n / 5) | 0) * 80);
      n++;
    }
    trim(w, q, 20, 2000, 2000, 100);
    w.step();
    const slotsBefore = q.radius;
    for (let i = 0; i < 12; i++) {
      w.soldiers.alive[q.first + i] = 0;
      w.soldiers.hp[q.first + i] = 0;
    }
    q.live = 8;
    w.orders.issue({ kind: "formation", squad: q.id, shape: "line" }, 0, w.tick + 1);
    for (let t = 0; t < TICK_RATE * 6; t++) w.step();
    const slots = new Set<number>();
    for (let i = 0; i < q.count; i++) {
      if (w.soldiers.alive[q.first + i] === 1) slots.add(w.soldiers.slot[q.first + i]);
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
  check("a running match has no outcome", evaluate([full, full], 60, 900) === null);

  const broken = { morale: ROUT_THRESHOLD - 0.01, strength: 150, roster: 200 };
  const routed = evaluate([broken, full], 60, 900);
  check("an army below the rout threshold loses at once",
    routed !== null && routed.winner === 1 && routed.reason === "rout");

  const wiped = { morale: 1, strength: 0, roster: 200 };
  const dead = evaluate([wiped, full], 60, 900);
  check("annihilation ends the match", dead !== null && dead.winner === 1 && dead.reason === "annihilated");

  // THE TURTLING PROBLEM. An army that hid in a corner kept perfect morale and
  // inflicted nothing. Under morale alone it would win on time; the tiebreak
  // adds the share of the enemy destroyed, so doing nothing earns nothing.
  // The turtle avoided contact: perfect morale, and it inflicted nothing, so
  // the fighter's roster is untouched. The fighter paid morale for its attacks
  // and destroyed a third of the turtle's army.
  const turtle = { morale: 1.0, strength: 133, roster: 200 };
  const fighter = { morale: 0.8, strength: 200, roster: 200 };
  const timed = evaluate([turtle, fighter], 900, 900);
  check("turtling does not win on the timer",
    timed !== null && timed.reason === "timer" && timed.winner === 1,
    "turtle " + score(turtle, fighter).toFixed(3) + " vs fighter " + score(fighter, turtle).toFixed(3));
  check("an army that inflicted nothing scores only its morale",
    Math.abs(score(turtle, fighter) - turtle.morale) < 1e-9);

  // But morale still matters: an army that traded evenly and held up wins.
  const steady = { morale: 0.9, strength: 170, roster: 200 };
  const shaken = { morale: 0.35, strength: 170, roster: 200 };
  const onMorale = evaluate([steady, shaken], 900, 900);
  check("morale still decides an even trade", onMorale !== null && onMorale.winner === 0);

  // A live match must actually reach a decision when one side is destroyed.
  {
    const w = buildWorld();
    for (const q of w.squads) {
      if (q.player !== 1) continue;
      for (let i = 0; i < q.count; i++) w.soldiers.alive[q.first + i] = 0;
      q.live = 0;
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

  function place(q: (typeof w.squads)[number], x: number, y: number): void {
    q.anchorX = x;
    q.anchorY = y;
    q.stance = "idle";
    q.path.length = 0;
    for (let i = 0; i < q.count; i++) {
      w.soldiers.x[q.first + i] = x;
      w.soldiers.y[q.first + i] = y;
    }
  }

  const watcher = w.squads.find((q) => q.player === 0 && q.type === "skirmisher")!;
  const quarry = w.squads.find((q) => q.player === 1 && q.type === "line")!;
  let n = 0;
  for (const q of w.squads) {
    if (q === watcher || q === quarry) continue;
    place(q, (q.player === 0 ? 260 : 5860) + (n % 4) * 55, (q.player === 0 ? 3760 : 240) + ((n / 4) | 0) * 55);
    n++;
  }

  const sight = effectiveSight(g, UNIT_TYPES.skirmisher.sight, openX, openY);

  place(watcher, openX, openY);
  place(quarry, openX + sight * 0.5, openY);
  w.step();
  check("an enemy in the open within sight is spotted", quarry.seenBy[0], "sight " + sight.toFixed(0));

  place(quarry, openX + sight * 2.2, openY);
  w.step();
  check("an enemy beyond sight is not spotted", !quarry.seenBy[0]);

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
      const archer = w2.squads.find((q) => q.player === 0 && q.type === "archer")!;
      const target = w2.squads.find((q) => q.player === 1 && q.type === "line")!;
      let k = 0;
      for (const q of w2.squads) {
        if (q === archer || q === target) continue;
        // Opposite corners. Parking both armies in one corner has them fighting
        // each other, and their arrows get counted as the archers' own.
        const px = (q.player === 0 ? 260 : 5860) + (k % 4) * 55;
        const py = (q.player === 0 ? 3760 : 240) + ((k / 4) | 0) * 55;
        q.anchorX = px;
        q.anchorY = py;
        q.stance = "idle";
        for (let i = 0; i < q.count; i++) { w2.soldiers.x[q.first + i] = px; w2.soldiers.y[q.first + i] = py; }
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
        for (let i = 0; i < q.count; i++) { w2.soldiers.x[q.first + i] = x; w2.soldiers.y[q.first + i] = y; }
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
        w.spawnSquad(
          zone.player,
          ARMY[i],
          (zone.x + 4 + (i % 3) * 7) * TILE_SIZE,
          (zone.y + 5 + ((i / 3) | 0) * 10) * TILE_SIZE,
          zone.player === 0 ? 0 : M.PI,
        );
      }
    }
    return w;
  }

  const w = autoMatch(provingGround.seed, 15 * 60);
  const startMen = w.squads.reduce((n, q) => n + q.live, 0);
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
      const t = w.squadById(body.target);
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
  const endMen = w.squads.reduce((n, q) => n + q.live, 0);

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

// -- 9b. selection context -----------------------------------------------------

section("selection");
{
  // The same stroke has to mean different things depending on what is selected.
  // This is context, not shape, so the confusion matrix cannot test it: every
  // case below is the SAME geometry read against a different selection.
  const R = 58;
  const squads: SquadView[] = [
    { id: 1, player: 0, x: 900, y: 900, radius: R, facing: 0, visible: true },
    { id: 2, player: 0, x: 1100, y: 900, radius: R, facing: 0, visible: true },
    { id: 3, player: 0, x: 900, y: 1100, radius: R, facing: 0, visible: true },
    { id: 4, player: 0, x: 1100, y: 1100, radius: R, facing: 0, visible: true },
    { id: 9, player: 1, x: 2600, y: 1000, radius: R, facing: Math.PI, visible: true },
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
