/**
 * Headless determinism and correctness harness.
 *
 * Runs the simulation with no browser, no canvas, no rAF -- which is only
 * possible because src/sim/ is pure. The replay and golden checks are the
 * regression suite for the whole simulation and the desync detector for
 * Phase 10 netplay.
 */

import { World, TICK_RATE } from "../src/sim/world.ts";
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
  check("soldiers never walk onto water either", crossed === 0, crossed + " soldiers crossed");
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
  }

  console.log("");
  console.log("  seed        0x" + provingGround.seed.toString(16));
  console.log("  ticks       " + TICKS + " (" + TICKS / TICK_RATE + "s)");
  console.log("  world hash  " + liveFinal);
}

console.log("");
console.log(failures === 0 ? "all checks passed" : failures + " check(s) FAILED");
console.log("");
process.exit(failures === 0 ? 0 : 1);
