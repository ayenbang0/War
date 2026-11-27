/**
 * Render glitch regression checks, run in Node with a recording fake canvas.
 *
 * There is no browser in CI, so these do not look at pixels. They record the
 * drawing calls the renderer makes and assert on WHERE it draws, which is what
 * the fixed glitches were about:
 *
 *  - a gallop's speed lines (and dust) kept running at the group anchor after
 *    the riders under it had stopped or died;
 *  - overlays for enemy companies showed through the fog;
 *  - a man who blinked or was just raised streaked in from his stale position;
 *  - the dead vanished without trace, and enemy deaths in fog would leave marks.
 */

import { World } from "../src/sim/world.ts";
import type { Group } from "../src/sim/entities.ts";
import { UNIT_TYPES, type UnitTypeId } from "../src/content/unit-types.ts";
import { Renderer, type Snapshot } from "../src/render/renderer.ts";
import { Camera } from "../src/render/camera.ts";
import { presenceOf, isMoving } from "../src/render/presence.ts";
import { Effects } from "../src/render/effects.ts";
import type { CombatEvent } from "../src/sim/world.ts";
import { TerrainLayer } from "../src/render/terrain-layer.ts";
import { motion } from "../src/render/motion.ts";
import { Terrain } from "../src/sim/terrain.ts";

type Call = { op: string; args: unknown[] };

function fakeContext(log: Call[]): CanvasRenderingContext2D {
  const grad = { addColorStop() {} };
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(t, key: string) {
      if (key in t) return t[key];
      if (key === "createRadialGradient" || key === "createLinearGradient") return () => grad;
      if (key === "measureText") return () => ({ width: 10 });
      if (key === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      return (...args: unknown[]) => { log.push({ op: key, args }); };
    },
    set(t, key: string, v) { t[key] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
}

// The terrain layer bakes chunks into offscreen canvases.
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => fakeContext([]) }),
};

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  <- " + detail : ""));
  if (!ok) failures++;
}

function unit(w: World, player: number, type: UnitTypeId, x: number, y: number): Group {
  const ids: number[] = [];
  for (let i = 0; i < UNIT_TYPES[type].soldiers; i++) {
    ids.push(w.spawnSoldier(player, type, x + (i % 5) * 12, y + ((i / 5) | 0) * 12, 0));
  }
  return w.createGroup(player, ids) as Group;
}

function snap(w: World): Snapshot {
  return {
    x: Float64Array.from(w.soldiers.x),
    y: Float64Array.from(w.soldiers.y),
    facing: Float64Array.from(w.soldiers.facing),
  };
}

function setup(): { w: World; horse: Group; cam: Camera; r: Renderer; log: Call[] } {
  const w = new World({ seed: 7, tilesWide: 60, tilesHigh: 40, soldierCapacity: 256 });
  const horse = unit(w, 0, "horse", 600, 600);
  w.step();
  const log: Call[] = [];
  const r = new Renderer(fakeContext(log), w.terrain);
  const cam = new Camera(w.terrain.worldWidth, w.terrain.worldHeight);
  cam.x = 900;
  cam.y = 600;
  cam.viewW = 1600;
  cam.viewH = 1000;
  return { w, horse, cam, r, log };
}

/** Screen x of every moveTo the specials pass made. */
function specialStrokes(r: Renderer, w: World, cam: Camera, prev: Snapshot, log: Call[]): number[][] {
  log.length = 0;
  (r as unknown as {
    drawSpecials(w: World, c: Camera, n: number, v: number, p: Snapshot): void;
  }).drawSpecials(w, cam, 1, 0, prev);
  return log.filter((c) => c.op === "moveTo" || c.op === "arc").map((c) => c.args as number[]);
}

console.log("\n== Render glitches ==");

{
  const { w, horse, cam, r, log } = setup();
  // A gallop in force, the anchor run far out ahead of the men.
  horse.specialUntil = w.tick + 200;
  horse.anchorX = 1500;
  horse.anchorY = 600;
  const kind = w.specialKind(horse);
  check("horsemen gallop with dash", kind === "dash", String(kind));

  const still = snap(w);
  check("standing riders draw no speed lines", specialStrokes(r, w, cam, still, log).length === 0);

  const moving = snap(w);
  for (const m of horse.members) moving.x[m] -= 3; // they moved +3 this tick
  const lines = specialStrokes(r, w, cam, moving, log);
  const ax = cam.worldToScreenX(1500);
  const near = lines.every((a) => Math.abs((a[0] as number) - ax) > 300);
  check("galloping riders draw speed lines", lines.length > 0, lines.length + " strokes");
  check("speed lines stay on the riders, not the anchor", near);

  for (const m of horse.members) w.soldiers.alive[m] = 0;
  check("dead riders have no presence", presenceOf(w, horse, 0, moving).n === 0);
  check("dead riders draw no speed lines", specialStrokes(r, w, cam, moving, log).length === 0);
}

{
  const { w, cam, r, log } = setup();
  const foe = unit(w, 1, "guard", 1200, 600);
  w.step();
  for (const m of foe.members) w.soldiers.seen[m] = 0;
  foe.seenBy[0] = false;
  foe.specialUntil = w.tick + 200;
  const strokes = specialStrokes(r, w, cam, snap(w), log);
  check("an enemy company in the fog shows no special", strokes.length === 0, strokes.length + " strokes");
  check("an enemy company in the fog has no presence", presenceOf(w, foe, 0).n === 0);
  const p = presenceOf(w, foe, 1);
  check("its own side still sees it", p.n === UNIT_TYPES.guard.soldiers && !isMoving(p));
}

{
  const { w, horse, cam, r } = setup();
  const prev = snap(w);
  const id = horse.members[0];
  prev.x[id] = 0; // as if just raised: stale previous point
  prev.y[id] = 0;
  const brush = (r as unknown as {
    brushFor(w: World, id: number, c: Camera, p: Snapshot, a: number, n: number, b: number): { x: number };
  }).brushFor(w, id, cam, prev, 0.5, 1, 4);
  check("a man who has just appeared is drawn where he is", Math.abs(brush.x - cam.worldToScreenX(w.soldiers.x[id])) < 3);
}

{
  const { w, horse, r } = setup();
  const near = unit(w, 1, "line", 760, 600);
  const foe = unit(w, 1, "line", 1820, 1160);
  w.step();
  const deadOwn = horse.members[0];
  const deadFoe = foe.members[0];
  w.soldiers.alive[deadOwn] = 0;
  w.soldiers.alive[deadFoe] = 0;
  const ev = (victim: number) => ({
    kind: "melee" as const, player: 0, type: "line" as UnitTypeId,
    attacker: -1, x0: 0, y0: 0, x1: w.soldiers.x[victim], y1: w.soldiers.y[victim], lethal: true, victim,
  });
  // Put the enemy's death in unlit ground for player 0.
  const fog = w.fog[0];
  const lit = fog.at(w.soldiers.x[deadFoe], w.soldiers.y[deadFoe]) === 1;
  r.fallen.ingest(w, [ev(deadOwn)], 0, 1);
  check("your own dead lie where they fell", r.fallen.count === 1);
  r.fallen.ingest(w, [ev(deadFoe)], 0, 1);
  check("an enemy who dies in the fog leaves nothing to find", !lit && r.fallen.count === 1, lit ? "was lit" : "fog");
  const seenFoe = near.members[0];
  // The dead are kept only for men the viewer actually saw (RF-04): give this
  // one player 0's sight bit, as the sight sweep would for a man in view.
  // (This world has already ended -- setup() stepped it with one side only --
  // so it will not run another sweep by itself.)
  w.soldiers.seen[seenFoe] |= 1;
  w.soldiers.alive[seenFoe] = 0;
  r.fallen.ingest(w, [ev(seenFoe)], 0, 1);
  check("an enemy who dies in view lies there", r.fallen.count === 2);
}

console.log("\n== Fog honesty (K2: RF-04, RF-06) ==");

{
  // RF-04: effects are drawn above the fog, so they must obey the same sight
  // rule as the men. A blow between two men the viewer cannot see -- in a
  // lit disc behind a wood, say -- leaves nothing; a shot whose archer is
  // hidden lands on its (seen) victim without drawing a streak back to him.
  const fx = new Effects(0);
  const shot: CombatEvent = {
    kind: "shot", player: 1, type: "line" as UnitTypeId, attacker: 3, victim: 4,
    x0: 10, y0: 10, x1: 200, y1: 10, lethal: false,
  };
  fx.ingest([shot], 0, () => ({ attacker: false, victim: false }));
  check("a blow between two unseen men leaves no effect", fx.count === 0, fx.count + " effects");
  const priv = fx as unknown as { shots: unknown[]; impacts: unknown[] };
  fx.ingest([shot], 0, () => ({ attacker: false, victim: true }));
  check("a shot from a hidden archer draws no streak back to him", priv.shots.length === 0 && priv.impacts.length === 1);
  fx.ingest([shot], 0, () => ({ attacker: true, victim: true }));
  check("a shot in plain view still streaks", priv.shots.length === 1);
}

{
  // RF-06: last-seen marks age on the SIM clock. A paused battle (tick
  // constant) drawn at very different wall-clock times keeps every mark at the
  // same strength; only ticks age it.
  const { w, cam, r } = setup();
  const hidden = unit(w, 1, "line", 2200, 1200);
  const marks = (r as unknown as { lastSeen: Map<number, unknown> }).lastSeen;
  marks.set(hidden.id, {
    x: 2200, y: 1200, tick: w.tick - 5 * 20, n: 20, radius: hidden.radius, player: 1, emptySince: -1,
  });
  const prev = snap(w);
  r.draw(w, cam, prev, 1, [], 1, 0);
  const before = r.lastSeenFade(w, hidden.id);
  r.draw(w, cam, prev, 1, [], 500, 0);
  const after = r.lastSeenFade(w, hidden.id);
  check("a last-seen mark is aging", before > 0 && before < 1, "fade " + before.toFixed(2));
  check("a last-seen mark does not fade while the battle is paused", before === after, before + " -> " + after);
  (w as unknown as { tick: number }).tick += 40;
  check("it fades as the battle runs", r.lastSeenFade(w, hidden.id) < before);
}

console.log("\n== Destructible ground (Phase 8) ==");

{
  // Seed 52 with a stone circuit round (16, 40), the same field as
  // tools/siege-check.ts. 120x80 tiles is 8x5 chunks of 16 tiles each.
  const siege = { defender: 0, cx: 16, cy: 40, rx: 9, ry: 9, kind: "wall" as const, gates: [{ side: "east" as const }] };
  const w = new World({ seed: 52, tilesWide: 120, tilesHigh: 80, soldierCapacity: 256, siege });
  const t = w.terrain;
  const layer = new TerrainLayer(t);
  const cam = new Camera(t.worldWidth, t.worldHeight);
  cam.zoom = 0.25;
  cam.viewW = 1000;
  cam.viewH = 700;
  cam.x = t.worldWidth / 2;
  cam.y = t.worldHeight / 2;
  const ctx = fakeContext([]);
  layer.draw(ctx, cam);
  const first = layer.bakes;
  layer.draw(ctx, cam);
  check("the whole field bakes once", first === 40 && layer.bakes === first, first + " chunks, then " + (layer.bakes - first));

  // Wear alone changes no tile's type: drawn live, never baked.
  t.damage(25, 36, 10);
  layer.draw(ctx, cam);
  check("wear on a wall re-bakes nothing", layer.bakes === first);

  // A wall tile in the middle of chunk (1, 2) falls: that chunk alone re-bakes.
  // Tile (25, 36) sits at chunk-local (9, 4), well inside.
  t.damage(25, 36, 1e9);
  layer.draw(ctx, cam);
  check("a breach re-bakes only the chunk it is in", layer.bakes === first + 1,
    (layer.bakes - first) + " re-baked of 40");
  // A change on a chunk's edge also redraws the neighbour whose edge
  // decoration reads it: tile (16, 49) is the first column of chunk (1, 3),
  // and mid-way down it.
  const before = layer.bakes;
  t.damage(16, 49, 1e9);
  layer.draw(ctx, cam);
  check("a change on a chunk edge re-bakes it and its neighbour", layer.bakes - before === 2,
    (layer.bakes - before) + " re-baked");

  // Live ground state: a garrison sees the cracks in its own walls, and fire
  // in the wood its scouts are watching.
  t.damage(25, 44, 1500);
  t.ignite(31, 35);
  t.ignite(32, 35);
  unit(w, 0, "scout", 28 * 32, 35 * 32);
  w.step();
  const log: Call[] = [];
  const r = new Renderer(fakeContext(log), t);
  const view = new Camera(t.worldWidth, t.worldHeight);
  view.x = 28 * 32;
  view.y = 40 * 32;
  view.viewW = 1600;
  view.viewH = 1000;
  const ground = (now: number): Call[] => {
    log.length = 0;
    (r as unknown as { drawGroundState(w: World, c: Camera, n: number, v: number): void })
      .drawGroundState(w, view, now, 0);
    return log.slice();
  };
  r.draw(w, view, snap(w), 1, [], 1, 0);
  const calls = ground(1);
  const flames = calls.filter((c) => c.op === "quadraticCurveTo");
  const cracks = calls.filter((c) => c.op === "lineTo");
  check("a battered wall shows its cracks", cracks.length >= 3, cracks.length + " crack strokes");
  check("a burning wood shows flames", flames.length >= 2 * 3 * 2, flames.length / 2 + " tongues");
  const later = ground(7.3).filter((c) => c.op === "quadraticCurveTo");
  check("flames flicker with motion on", JSON.stringify(later) !== JSON.stringify(flames));
  motion.reduced = true;
  const still1 = ground(1).filter((c) => c.op === "quadraticCurveTo");
  const still2 = ground(7.3).filter((c) => c.op === "quadraticCurveTo");
  motion.reduced = false;
  check("flames stand still under reduced motion, and are still drawn",
    still1.length === flames.length && JSON.stringify(still1) === JSON.stringify(still2));

  // The enemy's side of the field, out of sight: no fire is drawn there.
  const foe = new World({ seed: 52, tilesWide: 120, tilesHigh: 80, soldierCapacity: 256, siege });
  foe.terrain.ignite(36, 35);
  unit(foe, 0, "line", 100 * 32, 70 * 32);
  foe.step();
  const r3log: Call[] = [];
  const r3 = new Renderer(fakeContext(r3log), foe.terrain);
  r3.draw(foe, view, snap(foe), 1, [], 1, 0);
  r3log.length = 0;
  (r3 as unknown as { drawGroundState(w: World, c: Camera, n: number, v: number): void })
    .drawGroundState(foe, view, 1, 0);
  check("fire nobody can see is not drawn", r3log.filter((c) => c.op === "quadraticCurveTo").length === 0);
  check("the breach is drawn as what it now is", t.typeAt(25, 36) === Terrain.Rubble &&
    t.typeAt(16, 49) === Terrain.Rubble);
}

if (failures > 0) {
  console.log("\n" + failures + " render check(s) failed");
  process.exit(1);
}
console.log("\nrender checks passed");
