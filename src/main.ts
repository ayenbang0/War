/**
 * Browser entry point: owns the frame loop, the canvas, and the wiring between
 * the pure simulation and the layers that observe it.
 *
 * Fixed-timestep accumulator: the sim advances in whole 20 Hz ticks and never
 * sees real time, while rendering happens at display rate and interpolates
 * between the last two tick states. That split is what makes the simulation
 * reproducible while the picture stays smooth.
 */

import { World, TICK_DT, TICK_RATE } from "./sim/world.ts";
import { hashWorld } from "./sim/hash.ts";
import { PI } from "./sim/math.ts";
import { TILE_SIZE } from "./sim/terrain.ts";
import { validate, type ArmyList } from "./content/army.ts";
import { DIFFICULTIES } from "./content/difficulty.ts";
import { type UnitTypeId } from "./content/unit-types.ts";
import { openMenu } from "./ui/menu.ts";
import { UNIT_TYPES } from "./content/unit-types.ts";
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

const PLAYER = 0;

// Nothing can be built until the player has chosen: the world needs the level,
// their doctrine, and an enemy army sized by the difficulty they picked.
const setup = await openMenu(document.getElementById("menu") as HTMLElement);
const level = setup.level;
const diff = DIFFICULTIES[setup.difficulty];

/**
 * The enemy's army, drawn to its own budget.
 *
 * Composed greedily from a fixed preference order rather than copied from the
 * player, so a difficulty that affords more men fields a genuinely different
 * force, and the list stays legal if costs are ever retuned.
 */
function enemyArmy(budget: number): ArmyList {
  const doctrine = level.enemyDoctrine;
  const wish: UnitTypeId[] = [
    "line", "archer", "line", "scout", "horse", "line", "skirmisher",
    "archer", "guard", "line", "horse", "mage", "skirmisher", "siege", "archer",
  ];
  const squads: UnitTypeId[] = [];
  for (const id of wish) {
    squads.push(id);
    if (!validate({ doctrine, squads }, budget).ok) squads.pop();
  }
  return { doctrine, squads };
}

const ARMIES: readonly ArmyList[] = [
  setup.army,
  enemyArmy(Math.round(level.budget * diff.budget)),
];

const world = new World({
  seed: level.seed,
  tilesWide: level.tilesWide,
  tilesHigh: level.tilesHigh,
  duration: level.duration,
  soldierCapacity: 4096,
  aiPlayers: [1],
  aiTuning: { think: diff.thinkInterval, commit: diff.commitTicks, focus: diff.focus },
  victory: level.victory,
  controlPoints: level.controlPoints,
});
world.doctrine[0] = ARMIES[0].doctrine;
world.doctrine[1] = ARMIES[1].doctrine;

/**
 * Deploy INDIVIDUAL soldiers. No groups are created here, by design: a group is
 * something the player draws with the pen, not something the game hands them.
 */
for (const zone of level.deployment) {
  const list = ARMIES[zone.player];
  let n = 0;
  for (const type of list.squads) {
    const spec = UNIT_TYPES[type];
    const blockX = (zone.x + 3 + (n % 4) * 5) * TILE_SIZE;
    const blockY = (zone.y + 4 + ((n / 4) | 0) * 9) * TILE_SIZE;
    for (let i = 0; i < spec.soldiers; i++) {
      world.spawnSoldier(
        zone.player, type,
        blockX + (i % 5) * 14, blockY + ((i / 5) | 0) * 14,
        zone.player === 0 ? 0 : PI,
      );
    }
    n++;
  }
}

// The board is set out but the battle has not begun.
world.deploying = true;
const myZone = level.deployment.find((z) => z.player === PLAYER);
function inDeploymentZone(x: number, y: number): boolean {
  if (!myZone) return false;
  return (
    x >= myZone.x * TILE_SIZE && x <= (myZone.x + myZone.w) * TILE_SIZE &&
    y >= myZone.y * TILE_SIZE && y <= (myZone.y + myZone.h) * TILE_SIZE
  );
}

const cam = new Camera(world.terrain.worldWidth, world.terrain.worldHeight);
cam.x = (myZone ? myZone.x + myZone.w / 2 : 20) * TILE_SIZE;
cam.y = world.terrain.worldHeight * 0.5;
cam.zoom = 1.1;

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

/** State at the previous tick, for render interpolation. */
const prev: Snapshot = {
  x: new Float64Array(world.soldiers.capacity),
  y: new Float64Array(world.soldiers.capacity),
  facing: new Float64Array(world.soldiers.capacity),
};
function snapshotInto(t: Snapshot): void {
  t.x.set(world.soldiers.x);
  t.y.set(world.soldiers.y);
  t.facing.set(world.soldiers.facing);
}
snapshotInto(prev);

let paused = false;
let showDebug = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "Enter" && world.deploying) {
    world.deploying = false;
    pen.lastAction = "battle begins";
  } else if (e.code === "F2") {
    e.preventDefault();
    showDebug = !showDebug;
  } else if (e.code === "Space") {
    e.preventDefault();
    paused = !paused;
  } else if (e.code === "Period" && paused) {
    snapshotInto(prev);
    world.step();
  }
});

if (import.meta.env.DEV) {
  (window as unknown as { war: unknown }).war = { world, cam, level, commander, pen, hashWorld, UNIT_TYPES };
}

let last = performance.now();
let accumulator = 0;
let fps = 0;
let hudTimer = 0;
let cachedHash = hashWorld(world);
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
      // Events are cleared at the top of every tick, so a frame running several
      // ticks would otherwise see only the last one's blows.
      effects.ingest(world.events, now / 1000);
      accumulator -= TICK_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
  }

  // During deployment the pen drags men into position instead of ordering them.
  if (world.deploying && pen.drawing && pen.points.length > 1 && commander.selected.length > 0) {
    const tip = pen.points[pen.points.length - 1];
    if (inDeploymentZone(tip.x, tip.y)) {
      for (const handle of commander.selected) {
        const g = world.groupById(handle);
        const men = g ? g.members : [];
        if (men.length === 0) continue;
        let cx = 0;
        let cy = 0;
        for (const id of men) {
          cx += world.soldiers.x[id];
          cy += world.soldiers.y[id];
        }
        cx /= men.length;
        cy /= men.length;
        for (const id of men) {
          world.soldiers.x[id] += tip.x - cx;
          world.soldiers.y[id] += tip.y - cy;
        }
      }
      snapshotInto(prev);
    }
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
  drawHud();
  requestAnimationFrame(frame);
}

/**
 * The whole interface, deliberately almost nothing.
 *
 * Your own army's nerve and numbers, the clock, and what the pen just did.
 * Everything else -- tick counts, hashes, frame rate, the enemy's strength --
 * is either a debugging aid or information you are supposed to earn by
 * scouting, and neither belongs on the screen during a battle. F2 brings the
 * diagnostics back when they are actually wanted.
 */
function drawHud(): void {
  const t = world.tick / TICK_RATE;
  const left = Math.max(0, world.duration - t);
  const men = world.soldiersOf(PLAYER).length;
  const morale = world.armyMorale(PLAYER);
  const clock =
    String(Math.floor(left / 60)).padStart(2, "0") + ":" +
    String(Math.floor(left % 60)).padStart(2, "0");

  const bars = 20;
  const filled = Math.round(morale * bars);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(bars - filled);

  const lines = [
    clock + "   " + men + " men",
    bar + " " + (morale * 100).toFixed(0) + "%",
  ];
  const v = world.victory;
  if (v.mode === "objectives") {
    lines.push(
      "holding " + world.pointsHeldBy(PLAYER) + "/" + world.controlPoints.length +
      "   " + Math.floor(world.holdSeconds[PLAYER]) + "s of " + v.holdToWin + "s",
    );
  } else if (v.mode === "points") {
    lines.push(
      Math.floor(world.points[PLAYER]) + " / " + v.target + " pts" +
      "   holding " + world.pointsHeldBy(PLAYER) + "/" + world.controlPoints.length,
    );
  }
  if (world.deploying) {
    lines.push("", "loop to group - glyph to form up - drag to place", "ENTER to begin");
  }
  else if (world.outcome) {
    lines.push("", world.outcome.winner === PLAYER ? "VICTORY" : world.outcome.winner < 0 ? "DRAW" : "DEFEAT");
  } else if (pen.lastAction) lines.push("", pen.lastAction);

  if (showDebug) {
    lines.push(
      "",
      "tick " + world.tick + "  " + cachedHash,
      "groups " + world.groups.length + "  fps " + fps.toFixed(0),
      "zoom " + cam.zoom.toFixed(2) + "  foe " + (world.ai[0] ? world.ai[0].style : "-"),
    );
  }
  hud.textContent = lines.join("\n");
}

requestAnimationFrame(frame);
