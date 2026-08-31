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
import { provingGround } from "./content/levels/proving-ground.ts";
import { Camera } from "./render/camera.ts";
import { Renderer, type RenderSnapshot } from "./render/renderer.ts";
import { CameraControls } from "./input/camera-controls.ts";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const ctx2d = canvas.getContext("2d", { alpha: false });
if (!ctx2d) throw new Error("2d canvas context unavailable");
// Bound to its own const: `resize` below is a hoisted declaration, so TS will
// not carry the null-narrowing of `ctx2d` into it.
const ctx: CanvasRenderingContext2D = ctx2d;

const level = provingGround;
const world = new World({
  seed: level.seed,
  tilesWide: level.tilesWide,
  tilesHigh: level.tilesHigh,
});

// Phase 0 opening: two forces deploy and march toward the river. Identical to
// the scripted run in tools/headless.ts, so what renders here is the same
// trajectory the determinism harness verifies.
for (const zone of level.deployment) {
  for (let i = 0; i < 8; i++) {
    const x = (zone.x + 4 + (i % 2) * 8) * 32;
    const y = (zone.y + 6 + Math.floor(i / 2) * 12) * 32;
    world.spawnUnit(zone.player, x, y, zone.player === 0 ? 0 : PI);
  }
}
for (const unit of world.units) {
  const toward = unit.player === 0 ? 1 : -1;
  world.orders.issue(
    {
      kind: "move",
      unit: unit.id,
      path: [unit.x + toward * 900, unit.y - 260, unit.x + toward * 1700, unit.y + 320],
    },
    unit.player,
    10 + (unit.id % 5) * 3,
  );
}

const cam = new Camera(world.terrain.worldWidth, world.terrain.worldHeight);
cam.x = world.terrain.worldWidth * 0.25;
cam.y = world.terrain.worldHeight * 0.5;
cam.zoom = 0.7;

const renderer = new Renderer(ctx, world.terrain);
const controls = new CameraControls(canvas, cam);

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
    // Single-step while paused: invaluable for eyeballing sim behaviour.
    snapshotInto(prev);
    world.step();
  }
});

/** Positions at the previous tick, for render interpolation. */
let prev: RenderSnapshot = new Map();
function snapshotInto(target: RenderSnapshot): void {
  target.clear();
  for (const u of world.units) target.set(u.id, { x: u.x, y: u.y, facing: u.facing });
}
snapshotInto(prev);

// Dev-only handle for poking at state from the console. Stripped from
// production builds by the import.meta.env.DEV guard.
if (import.meta.env.DEV) {
  (window as unknown as { war: unknown }).war = { world, cam, level, hashWorld };
}

let last = performance.now();
let accumulator = 0;
let fps = 0;
let hudTimer = 0;
let cachedHash = hashWorld(world);

/** Beyond this many ticks in one frame, give up and let the sim fall behind
 *  rather than spiral: a long stall must not turn into a freeze. */
const MAX_STEPS_PER_FRAME = 5;

function frame(now: number): void {
  const dtReal = Math.min((now - last) / 1000, 0.25);
  last = now;
  fps += (1 / Math.max(dtReal, 1e-6) - fps) * 0.1;

  controls.update(dtReal);

  if (!paused) {
    accumulator += dtReal;
    let steps = 0;
    while (accumulator >= TICK_DT && steps < MAX_STEPS_PER_FRAME) {
      snapshotInto(prev);
      world.step();
      accumulator -= TICK_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
  }

  const alpha = paused ? 1 : Math.min(accumulator / TICK_DT, 1);
  renderer.draw(world, cam, prev, alpha);

  hudTimer += dtReal;
  if (hudTimer > 0.5) {
    hudTimer = 0;
    cachedHash = hashWorld(world);
  }
  const t = world.tick / TICK_RATE;
  hud.textContent = [
    level.name + (paused ? "   [PAUSED]" : ""),
    "t     " + String(Math.floor(t / 60)).padStart(2, "0") + ":" +
      (t % 60).toFixed(1).padStart(4, "0") + " / " + level.duration / 60 + ":00",
    "tick  " + world.tick,
    "hash  " + cachedHash,
    "units " + world.units.length,
    "zoom  " + cam.zoom.toFixed(2) + "   fps " + fps.toFixed(0),
    "",
    "drag mid/right pan - wheel zoom",
    "WASD pan - space pause - . step",
  ].join("\n");

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
