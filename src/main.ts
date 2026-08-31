/**
 * Browser entry point: owns the frame loop, the canvas, and the wiring between
 * the pure simulation and the layers that observe it.
 *
 * The loop is a fixed-timestep accumulator. The sim advances in whole 20 Hz
 * ticks and never sees real time; rendering happens at display rate and
 * interpolates between the last two tick states. This split is what makes the
 * simulation reproducible while the picture stays smooth.
 */

import { World, TICK_DT, TICK_RATE } from "./sim/world.ts";
import { hashWorld } from "./sim/hash.ts";
import { PI } from "./sim/math.ts";
import { TILE_SIZE } from "./sim/terrain.ts";
import { provingGround } from "./content/levels/proving-ground.ts";
import { UNIT_TYPES, type UnitTypeId } from "./content/unit-types.ts";
import { Camera } from "./render/camera.ts";
import { Renderer, type Snapshot } from "./render/renderer.ts";
import { drawInk } from "./render/ink.ts";
import { Effects } from "./render/effects.ts";
import { CameraControls } from "./input/camera-controls.ts";
import { Commander } from "./input/commander.ts";
import { Pen } from "./input/pen.ts";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const ctx2d = canvas.getContext("2d", { alpha: false });
if (!ctx2d) throw new Error("2d canvas context unavailable");
const ctx: CanvasRenderingContext2D = ctx2d;

const level = provingGround;
const world = new World({
  seed: level.seed,
  tilesWide: level.tilesWide,
  tilesHigh: level.tilesHigh,
});

/** The spec's stated cap: about fifteen squads a side. */
const ARMY: readonly UnitTypeId[] = [
  "line", "line", "line", "line", "line",
  "skirmisher", "skirmisher", "skirmisher", "skirmisher",
  "archer", "archer", "archer",
  "horse", "horse",
  "guard",
];

for (const zone of level.deployment) {
  for (let i = 0; i < ARMY.length; i++) {
    const x = (zone.x + 4 + (i % 3) * 7) * TILE_SIZE;
    const y = (zone.y + 5 + ((i / 3) | 0) * 10) * TILE_SIZE;
    world.spawnSquad(zone.player, ARMY[i], x, y, zone.player === 0 ? 0 : PI);
  }
}

const PLAYER = 0;
const cam = new Camera(world.terrain.worldWidth, world.terrain.worldHeight);
cam.x = level.deployment[0].x * TILE_SIZE + 500;
cam.y = world.terrain.worldHeight * 0.5;
cam.zoom = 0.85;

const renderer = new Renderer(ctx, world.terrain);
const controls = new CameraControls(canvas, cam);
const effects = new Effects();
const commander = new Commander(world, PLAYER);
const pen = new Pen(canvas, cam, commander);

let dpr = 1;
function resize(): void {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cam.setViewport(w, h);
}
window.addEventListener("resize", resize);
resize();

let paused = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    paused = !paused;
  } else if (e.code === "Period" && paused) {
    snapshotInto(prev);
    world.step();
  }
});

/** State at the previous tick, for render interpolation. */
const prev: Snapshot = {
  soldiers: {
    x: new Float64Array(world.soldiers.x.length),
    y: new Float64Array(world.soldiers.y.length),
    facing: new Float64Array(world.soldiers.facing.length),
  },
  squads: new Map(),
};

function snapshotInto(target: Snapshot): void {
  target.soldiers.x.set(world.soldiers.x);
  target.soldiers.y.set(world.soldiers.y);
  target.soldiers.facing.set(world.soldiers.facing);
  target.squads.clear();
  for (const q of world.squads) {
    target.squads.set(q.id, { x: q.anchorX, y: q.anchorY, facing: q.facing });
  }
}
snapshotInto(prev);

if (import.meta.env.DEV) {
  (window as unknown as { war: unknown }).war = { world, cam, level, commander, pen, hashWorld, UNIT_TYPES };
}

let last = performance.now();
let accumulator = 0;
let fps = 0;
let hudTimer = 0;
let cachedHash = hashWorld(world);

/** Beyond this many ticks in one frame, let the sim fall behind rather than
 *  spiral: a long stall must not turn into a freeze. */
const MAX_STEPS_PER_FRAME = 5;

function frame(now: number): void {
  const dtReal = Math.min((now - last) / 1000, 0.25);
  last = now;
  fps += (1 / Math.max(dtReal, 1e-6) - fps) * 0.1;

  controls.update(dtReal);
  commander.flushPending(now);

  if (!paused) {
    accumulator += dtReal;
    let steps = 0;
    while (accumulator >= TICK_DT && steps < MAX_STEPS_PER_FRAME) {
      snapshotInto(prev);
      world.step();
      // Events are cleared at the top of every tick, so they have to be taken
      // now -- a frame that runs several ticks would otherwise see only the last.
      effects.ingest(world.events, now / 1000);
      accumulator -= TICK_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
  }

  const alpha = paused ? 1 : Math.min(accumulator / TICK_DT, 1);
  const clock = now / 1000;
  renderer.draw(world, cam, prev, alpha, commander.selected, clock, PLAYER);
  effects.draw(ctx, cam, clock);
  drawInk(ctx, cam, pen.points, commander.preview, commander.pendingRail);

  hudTimer += dtReal;
  if (hudTimer > 0.5) {
    hudTimer = 0;
    cachedHash = hashWorld(world);
  }
  const t = world.tick / TICK_RATE;
  const mine = world.squads.filter((q) => q.player === PLAYER);
  const sel = commander.selected.length;
  hud.textContent = [
    level.name + (paused ? "   [PAUSED]" : "") +
      (world.outcome
        ? "   " + (world.outcome.winner === PLAYER ? "VICTORY" : world.outcome.winner < 0 ? "DRAW" : "DEFEAT")
        : ""),
    "t      " + String(Math.floor(t / 60)).padStart(2, "0") + ":" +
      (t % 60).toFixed(1).padStart(4, "0") + " / " + level.duration / 60 + ":00",
    "tick   " + world.tick + "   " + cachedHash,
    "squads " + mine.filter((q) => q.live > 0).length + "/" + mine.length +
      "   men " + mine.reduce((n, q) => n + q.live, 0),
    "morale " + (world.armyMorale(PLAYER) * 100).toFixed(0) + "%" +
      "   enemy " + (world.armyMorale(1 - PLAYER) * 100).toFixed(0) + "%",
    "sel    " + (sel > 0 ? sel + " squad" + (sel > 1 ? "s" : "") : "none") +
      (pen.lastAction ? "   > " + pen.lastAction : ""),
    "zoom   " + cam.zoom.toFixed(2) + "   fps " + fps.toFixed(0),
  ].join("\n");

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
