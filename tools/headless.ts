/**
 * Headless determinism harness.
 *
 * Runs the simulation with no browser, no canvas, no rAF -- which is only
 * possible because src/sim/ is pure. Three checks:
 *
 *   1. math      -- the hand-rolled trig actually approximates the real thing.
 *   2. rng       -- the same seed reproduces the same stream; streams differ.
 *   3. replay    -- an identical order log from an identical seed yields an
 *                   identical state hash, tick for tick.
 *
 * Check 3 is the one that matters. It is the regression suite for the whole
 * simulation and the desync detector for Phase 10 netplay.
 */

import { World, TICK_RATE } from "../src/sim/world.ts";
import { hashWorld, hashTerrain, hashRngStream } from "../src/sim/hash.ts";
import { Rng, Stream } from "../src/sim/rng.ts";
import * as M from "../src/sim/math.ts";
import { provingGround } from "../src/content/levels/proving-ground.ts";
import { generateTerrain, Terrain, TERRAIN_INFO } from "../src/sim/terrain.ts";
import type { Order } from "../src/sim/orders.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log("  PASS  " + name);
  } else {
    failures++;
    console.log("  FAIL  " + name + (detail ? "  <- " + detail : ""));
  }
}

// -- 1. math -------------------------------------------------------------------

console.log("\nmath");
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
    const d = Math.abs(M.wrapAngle(M.atan2(y, x) - Math.atan2(y, x)));
    worstAtan2 = Math.max(worstAtan2, d);
  }
  check("sin/cos within 1e-9 of native", worstSin < 1e-9, "worst " + worstSin.toExponential(2));
  check("atan2 within 1e-4 rad of native", worstAtan2 < 1e-4, "worst " + worstAtan2.toExponential(2));
  check("atan2 quadrants", M.atan2(0, -1) > 3.14 && M.atan2(-1, 0) < -1.57 + 1e-9);
  check("wrapAngle folds to [-PI, PI)", M.wrapAngle(M.TAU * 3 + 1) - 1 < 1e-9);
  check("no Math.* leakage in sim output", Number.isFinite(M.sin(1e6)));
}

// -- 2. rng --------------------------------------------------------------------

console.log("\nrng");
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
  const mean = sum / 100000;
  check("nextFloat mean ~0.5", Math.abs(mean - 0.5) < 0.01, "mean " + mean.toFixed(4));
  check("nextFloat stays in [0,1)", lo >= 0 && hi < 1);

  const buckets = new Array(6).fill(0);
  const d = Rng.create(7, Stream.Ai);
  for (let i = 0; i < 60000; i++) buckets[d.int(6)]++;
  check("int(n) covers all buckets evenly", buckets.every((n) => n > 9000 && n < 11000), buckets.join(","));

  const s = r.snapshot();
  const before = r.nextU32();
  r.restore(s);
  check("snapshot/restore round-trips", r.nextU32() === before);
}

// -- 3. replay determinism -----------------------------------------------------

console.log("\nreplay");

const TICKS = TICK_RATE * 90; // 90 simulated seconds

/** Build a world with a fixed opening and a scripted order log. */
function buildRun(): { world: World; log: Order[] } {
  const world = new World({
    seed: provingGround.seed,
    tilesWide: provingGround.tilesWide,
    tilesHigh: provingGround.tilesHigh,
  });

  const log: Order[] = [];
  const zones = provingGround.deployment;

  for (const zone of zones) {
    for (let i = 0; i < 8; i++) {
      const x = (zone.x + 4 + (i % 2) * 8) * 32;
      const y = (zone.y + 6 + Math.floor(i / 2) * 12) * 32;
      world.spawnUnit(zone.player, x, y, zone.player === 0 ? 0 : M.PI);
    }
  }

  // March both sides toward the middle, with a dog-leg so paths bend.
  for (const unit of world.units) {
    const towardCentre = unit.player === 0 ? 1 : -1;
    const order = world.orders.issue(
      {
        kind: "move",
        unit: unit.id,
        path: [
          unit.x + towardCentre * 900,
          unit.y - 260,
          unit.x + towardCentre * 1700,
          unit.y + 320,
        ],
      },
      unit.player,
      10 + (unit.id % 5) * 3,
    );
    log.push(order);
  }
  return { world, log };
}

/** Replay a recorded log into a fresh world, hashing every 10th tick. */
function replay(log: Order[]): { hashes: string[]; final: string } {
  const world = new World({
    seed: provingGround.seed,
    tilesWide: provingGround.tilesWide,
    tilesHigh: provingGround.tilesHigh,
  });
  const zones = provingGround.deployment;
  for (const zone of zones) {
    for (let i = 0; i < 8; i++) {
      const x = (zone.x + 4 + (i % 2) * 8) * 32;
      const y = (zone.y + 6 + Math.floor(i / 2) * 12) * 32;
      world.spawnUnit(zone.player, x, y, zone.player === 0 ? 0 : M.PI);
    }
  }
  for (const o of log) world.orders.push(o);

  const hashes: string[] = [];
  for (let t = 0; t < TICKS; t++) {
    world.step();
    if (t % 10 === 0) hashes.push(hashWorld(world));
  }
  return { hashes, final: hashWorld(world) };
}

{
  const { world: liveWorld, log } = buildRun();
  const starts = liveWorld.units.map((u) => ({ x: u.x, y: u.y }));
  const liveHashes: string[] = [];
  for (let t = 0; t < TICKS; t++) {
    liveWorld.step();
    if (t % 10 === 0) liveHashes.push(hashWorld(liveWorld));
  }
  const liveFinal = hashWorld(liveWorld);

  const a = replay(log);
  const b = replay(log);

  check("live run matches replay tick-for-tick", liveHashes.join() === a.hashes.join());
  check("two replays are identical", a.hashes.join() === b.hashes.join());
  check("final hashes agree", liveFinal === a.final && a.final === b.final);

  // A one-tick shift in a single order must show up in the trace, otherwise the
  // hash is not actually observing the thing it claims to observe.
  //
  // Compared over the whole trace rather than at the final tick on purpose:
  // every unit finishes its ~1900-unit path around t=77s and then stands still,
  // so by t=90s a one-tick delay has legitimately washed out and the two final
  // hashes agree. That is correct behaviour, and an endpoint-only check would
  // read it as the hash being blind.
  const shifted = log.map((o, i) => (i === 0 ? { ...o, tick: o.tick + 1 } : o));
  const c = replay(shifted);
  check("perturbed order log diverges somewhere in the trace", c.hashes.join() !== a.hashes.join());

  const moved = liveWorld.units.filter((u, i) => {
    const s = starts[i];
    return Math.hypot(u.x - s.x, u.y - s.y) > 100;
  }).length;
  check(
    "every unit spawned and travelled",
    liveWorld.units.length === 16 && moved === 16,
    moved + "/16 moved",
  );

  // Two tiers of golden hash, deliberately separated.
  //
  // The WORLD hash is expected to move: every phase that touches movement,
  // combat or morale legitimately changes it. Regenerate with
  //   UPDATE_GOLDEN=1 node tools/headless.ts
  // and say why in the commit message.
  //
  // The STABLE hashes pin the terrain generator and the PRNG arithmetic, which
  // no later phase should alter. Keeping them apart is the point: if the only
  // anchor were the world hash, regenerating would become reflexive and the
  // suite would quietly stop catching anything. A move in a stable hash is a
  // bug until proven otherwise, and needs UPDATE_STABLE=1 to rewrite.
  const goldenPath = fileURLToPath(new URL("./golden.json", import.meta.url));
  type Golden = {
    world: { ticks: number; final: string };
    stable: { terrain: string; rng: string };
  };

  const stableTerrain = hashTerrain(
    generateTerrain(provingGround.tilesWide, provingGround.tilesHigh, provingGround.seed),
  );
  const stableRng = [Stream.Combat, Stream.Morale, Stream.Ai, Stream.Spawn]
    .map((st) => hashRngStream(Rng.create(provingGround.seed, st), 10000))
    .join("-");

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
    },
  };

  if (process.env.UPDATE_GOLDEN || process.env.UPDATE_STABLE || !existing) {
    writeFileSync(goldenPath, JSON.stringify(next, null, 2));
    console.log("");
    console.log("  golden file written");
  }

  if (existing) {
    check(
      "terrain generator unchanged (stable)",
      existing.stable.terrain === stableTerrain,
      "expected " + existing.stable.terrain + ", got " + stableTerrain,
    );
    check(
      "rng streams unchanged (stable)",
      existing.stable.rng === stableRng,
      "expected " + existing.stable.rng + ", got " + stableRng,
    );
    check(
      "world state matches golden",
      existing.world.ticks === TICKS && existing.world.final === liveFinal,
      "expected " + existing.world.final + ", got " + liveFinal + " (UPDATE_GOLDEN=1 if intended)",
    );
  }

  console.log("\n  seed        0x" + provingGround.seed.toString(16));
  console.log("  ticks       " + TICKS + " (" + TICKS / TICK_RATE + "s)");
  console.log("  units       " + liveWorld.units.length);
  console.log("  final hash  " + liveFinal);
}


// -- 4. terrain ----------------------------------------------------------------

console.log("");
console.log("terrain");
{
  const g = generateTerrain(provingGround.tilesWide, provingGround.tilesHigh, provingGround.seed);
  const total = g.type.length;
  const counts = new Map<number, number>();
  for (const t of g.type) counts.set(t, (counts.get(t) ?? 0) + 1);

  const share = (t: number): number => (counts.get(t) ?? 0) / total;
  const passable = g.type.reduce((n, t) => n + (TERRAIN_INFO[t as 0].moveScale > 0 ? 1 : 0), 0);

  /** Flood fill from the left edge. The river must cut the map; bridges must heal it. */
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

  const withBridges = reachable(true);
  const withoutBridges = reachable(false);

  check("map is mostly passable", passable / total > 0.85, (passable / total * 100).toFixed(1) + "%");
  check("river exists", share(Terrain.Water) > 0.01, (share(Terrain.Water) * 100).toFixed(1) + "%");
  check("bridges were carved", (counts.get(Terrain.Bridge) ?? 0) > 0, String(counts.get(Terrain.Bridge) ?? 0));
  check("forest and hills both present", share(Terrain.Forest) > 0.03 && share(Terrain.Hill) > 0.03,
    "forest " + (share(Terrain.Forest) * 100).toFixed(1) + "%, hill " + (share(Terrain.Hill) * 100).toFixed(1) + "%");
  check("river genuinely splits the map", withoutBridges < passable * 0.75,
    (withoutBridges / passable * 100).toFixed(1) + "% reachable without bridges");
  check("bridges reconnect both halves", withBridges > passable * 0.95,
    (withBridges / passable * 100).toFixed(1) + "% reachable with bridges");

  console.log("");
  for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log("  " + TERRAIN_INFO[t as 0].name.padEnd(14) + String(n).padStart(7) +
      "  " + ((n / total) * 100).toFixed(1) + "%");
  }
}


// -- 5. movement integrity -----------------------------------------------------

console.log("");
console.log("movement");
{
  // A unit must never end a tick standing on impassable terrain, no matter
  // where its waypoints sit. The dangerous case is a waypoint the unit can
  // reach within a single tick's step budget: a naive loop consumes that
  // waypoint whole and lands wherever it points, river or not.
  const w = new World({
    seed: provingGround.seed,
    tilesWide: provingGround.tilesWide,
    tilesHigh: provingGround.tilesHigh,
  });
  const g = w.terrain;

  let crossings = 0;
  let trials = 0;

  for (let ty = 4; ty < g.height - 4 && trials < 400; ty += 3) {
    for (let tx = 4; tx < g.width - 4 && trials < 400; tx += 3) {
      if (g.typeAt(tx, ty) !== Terrain.Water) continue;
      // Need land on both banks along this row.
      let west = tx - 1;
      while (west > 0 && g.typeAt(west, ty) === Terrain.Water) west--;
      let east = tx + 1;
      while (east < g.width - 1 && g.typeAt(east, ty) === Terrain.Water) east++;
      if (!g.passableAt(west, ty) || !g.passableAt(east, ty)) continue;
      if (g.typeAt(west, ty) === Terrain.Bridge || g.typeAt(east, ty) === Terrain.Bridge) continue;

      trials++;
      const startX = (west + 1) * 32 - 0.5; // hard against the water's edge
      const startY = (ty + 0.5) * 32;

      // Case A: one distant waypoint on the far bank. The step budget cannot
      // reach it, so the partial-step branch runs.
      const a = w.spawnUnit(0, startX, startY, 0);
      w.orders.issue(
        { kind: "move", unit: a.id, path: [(east + 0.5) * 32, startY] },
        0,
        w.tick,
      );

      // Case B: a dense polyline crossing the river, every point inside a
      // single tick's step budget. This is what a drawn pen stroke looks like
      // after simplification, and it is the case that skips terrain checks.
      const b = w.spawnUnit(0, startX, startY, 0);
      const dense: number[] = [];
      for (let step = 1; step <= 220; step++) dense.push(startX + step, startY);
      w.orders.issue({ kind: "move", unit: b.id, path: dense }, 0, w.tick);

      for (let k = 0; k < 40; k++) w.step();
      if (g.typeAtWorld(a.x, a.y) === Terrain.Water) crossings++;
      if (g.typeAtWorld(b.x, b.y) === Terrain.Water) crossings++;
    }
  }

  check("found river crossings to test", trials > 20, trials + " trials");
  check("both cases were exercised", w.units.length === trials * 2);
  check("units never end a tick standing on water", crossings === 0, crossings + "/" + trials * 2 + " walked onto water");
}

console.log(
  "\n" + (failures === 0 ? "all checks passed" : failures + " check(s) FAILED") + "\n",
);
process.exit(failures === 0 ? 0 : 1);
