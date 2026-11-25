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
import { cost, validate, type ArmyList } from "./content/army.ts";
import { DIFFICULTIES } from "./content/difficulty.ts";
import { type UnitTypeId } from "./content/unit-types.ts";
import { type AbilityId } from "./content/abilities.ts";
import { openMenu, type Setup } from "./ui/menu.ts";
import { openHome } from "./ui/home.ts";
import { Tutorial } from "./ui/tutorial.ts";
import { AbilityBar } from "./ui/ability-bar.ts";
import { COMMANDERS } from "./content/commanders.ts";
import { LEVELS, levelById } from "./content/levels/index.ts";
import { noteBattle, openCampaign } from "./ui/campaign.ts";

/**
 * The lesson's fixed setup: the smallest field, a plain mixed force, and the
 * most passive commander in the game. A tutorial interrupted by a cavalry
 * charge is not a tutorial.
 */
function tutorialSetup(): Setup {
  const level = LEVELS.reduce((a, b) => (a.tilesWide * a.tilesHigh <= b.tilesWide * b.tilesHigh ? a : b));
  return {
    level,
    difficulty: "recruit",
    army: { doctrine: "defensive", squads: ["line", "line", "archer", "skirmisher"] },
    commander: COMMANDERS.badger,
    // The lesson is about the pen. Abilities are a separate idea and would be
    // one more thing to drop on a first run.
    abilities: [],
  };
}
import { showAfterAction } from "./ui/after-action.ts";
import { UNIT_TYPES } from "./content/unit-types.ts";
import { Camera } from "./render/camera.ts";
import { Renderer, type Snapshot } from "./render/renderer.ts";
import { drawInk } from "./render/ink.ts";
import { Effects } from "./render/effects.ts";
import { isMoving, presenceOf } from "./render/presence.ts";
import { CameraControls } from "./input/camera-controls.ts";
import { Commander } from "./input/commander.ts";
import { Pen } from "./input/pen.ts";

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const ctx2d = canvas.getContext("2d", { alpha: false });
if (!ctx2d) throw new Error("2d canvas context unavailable");
const ctx: CanvasRenderingContext2D = ctx2d;

const PLAYER = 0;

// The front screen first. A first-time player meeting a point-buy table before
// they know what the game is has been given a spreadsheet, not a game.
const home = await openHome(document.getElementById("home") as HTMLElement);
const teaching = home === "tutorial";

// Nothing can be built until the player has chosen: the world needs the level,
// their doctrine, and an enemy army sized by the difficulty they picked. The
// lesson skips all of that and uses a fixed, quiet setup.
// A campaign chapter is chosen first; it fixes the ground and the enemy captain,
// and the ordinary setup screen then opens on it for the army.
const chapter = home === "campaign"
  ? await openCampaign(document.getElementById("home") as HTMLElement)
  : null;
const chapterLevel = chapter ? levelById(chapter.levelId) : undefined;
const setup = teaching
  ? tutorialSetup()
  : await openMenu(
    document.getElementById("menu") as HTMLElement,
    chapter && chapterLevel
      ? {
        title: "Chapter " + chapter.number + ": " + chapter.title,
        level: chapterLevel,
        commander: chapter.commander,
        difficulty: chapter.difficulty,
      }
      : undefined,
  );
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
  // The second roster is mixed in through the list rather than tacked on the
  // end, so even a small purse fields some of it and the enemy you meet is not
  // always the same ten kinds of men.
  const wish: UnitTypeId[] = [
    "line", "archer", "pike", "scout", "horse", "line", "skirmisher",
    "crossbow", "guard", "banner", "line", "hounds", "mage", "slinger", "siege",
    "archer", "oathsworn", "lancer", "healer", "skirmisher", "builder", "pike",
    "drummer", "line", "scout", "champion", "guard", "wagon", "archer", "horse",
    "line", "skirmisher", "mage", "crossbow", "line",
  ];
  const squads: UnitTypeId[] = [];
  for (const id of wish) {
    squads.push(id);
    if (!validate({ doctrine, squads }, budget).ok) squads.pop();
  }
  return { doctrine, squads };
}

// The enemy is built to what the PLAYER actually spent, never more. A harder
// opponent is one that is better commanded, not one with a bigger army --
// difficulty used to scale its purse, which meant the top setting simply
// fielded more men.
const ARMIES: readonly ArmyList[] = [
  setup.army,
  enemyArmy(cost(setup.army)),
];

const world = new World({
  seed: level.seed,
  tilesWide: level.tilesWide,
  tilesHigh: level.tilesHigh,
  duration: level.duration,
  soldierCapacity: 4096,
  aiPlayers: [1],
  aiTuning: { think: diff.thinkInterval, commit: diff.commitTicks, focus: diff.focus },
  commander: setup.commander,
  victory: level.victory,
  controlPoints: level.controlPoints,
  reinforcements: level.reinforcements,
  sightScale: level.night,
  floodAtSeconds: level.floodAtSeconds,
});
world.doctrine[0] = ARMIES[0].doctrine;
world.doctrine[1] = ARMIES[1].doctrine;
/**
 * The abilities bound to keys 1..n, each appearing once.
 *
 * Buying an ability twice buys a deeper magazine, not a second thing to press,
 * so the keys address DISTINCT abilities -- otherwise buying two barrages put a
 * barrage on key 2 and pushed the shield out to key 3, which is not something a
 * player could be expected to work out mid-battle.
 */
const abilityKeys: AbilityId[] = [];
for (const id of setup.abilities) if (!abilityKeys.includes(id)) abilityKeys.push(id);

world.armAbilities(PLAYER, setup.abilities);
// The machine is given the same kit, so nothing the player can spend is
// something the player alone can spend.
world.armAbilities(1, setup.abilities);

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
// Open looking at YOUR OWN MEN, not at the middle of your deployment zone.
// The zone is much taller than the force set out in it, so the camera started
// well below the army -- you began every match, and the tutorial, staring at
// empty ground with your soldiers off the top of the screen.
{
  const s = world.soldiers;
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (let i = 0; i < s.count; i++) {
    if (s.alive[i] !== 1 || s.player[i] !== PLAYER) continue;
    cx += s.x[i];
    cy += s.y[i];
    n++;
  }
  cam.x = n > 0 ? cx / n : (myZone ? myZone.x + myZone.w / 2 : 20) * TILE_SIZE;
  cam.y = n > 0 ? cy / n : world.terrain.worldHeight * 0.5;
}
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

const abilityBar = new AbilityBar(
  document.getElementById("abilities") as HTMLElement,
  teaching ? [] : abilityKeys,
  commander,
);

const tutorial = teaching ? new Tutorial(world, commander) : null;
if (teaching) {
  // The lesson is about the pen, not about setting an army out.
  world.deploying = false;
}

let paused = false;
let showDebug = false;
window.addEventListener("keydown", (e) => {
  if (e.code === "Enter" && world.deploying) {
    world.deploying = false;
    pen.lastAction = "battle begins";
  } else if (e.code === "Escape" && tutorial) {
    window.location.reload();
  } else if (e.code.startsWith("Digit") && !world.deploying) {
    // 1..5 arm an ability; the next pen stroke says where it goes. The left
    // button stays the only thing that ever points at the world.
    const n = Number(e.code.slice(5)) - 1;
    if (n >= 0 && n < abilityKeys.length) {
      pen.lastAction = commander.arm(abilityKeys[n]);
    }
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
  (window as unknown as { war: unknown }).war = {
    world, cam, level, commander, pen, hashWorld, UNIT_TYPES, tutorial,
  };
}

let last = performance.now();
let accumulator = 0;
let fps = 0;
let hudTimer = 0;
let cachedHash = hashWorld(world);
const MAX_STEPS_PER_FRAME = 5;
/** How long a "company broke" line stays on screen. */
const BREAK_NOTICE_MS = 4200;

let deployFogTick = 0;
let lastDust = 0;
let reported = false;
/** The last company to break, shown briefly and then allowed to fade. */
let lastBreak = "";
let lastBreakAt = 0;
let breaksSeen = 0;

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
      // Blows you could not see leave nothing above the fog either.
      effects.ingest(world.events, now / 1000, (x, y) => world.fog[PLAYER].at(x, y) === 1);
      renderer.fallen.ingest(world, world.events, PLAYER, now / 1000);
      effects.ingestSpecials(
        world.specialEvents.filter((m) => m.player === PLAYER || world.fog[PLAYER].at(m.x, m.y) === 1),
        now / 1000,
      );
      // A company that has just ceased to exist leaves nothing behind: no dust
      // from men who are no longer marching, no halo over empty ground.
      for (const id of world.disbanded) effects.forgetGroup(id);
      accumulator -= TICK_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
  }

  // Pick up any company that broke since the last frame. Only the player's own
  // are announced -- being told the enemy is breaking would hand over
  // information the fog is meant to be keeping.
  while (breaksSeen < world.breakages.length) {
    const b = world.breakages[breaksSeen++];
    if (b.player !== PLAYER) continue;
    lastBreak = b.name + " broke - " + b.cause;
    lastBreakAt = now;
  }

  // The match has just ended: show the report once. Guarded by a flag rather
  // than by clearing world.outcome, because the outcome is real state that the
  // HUD and the sim both still read.
  if (world.outcome && !reported) {
    reported = true;
    // A campaign battle is written into the chronicle the moment it ends, win
    // or lose, and the chronicler's entry heads the report.
    const entry = chapter ? noteBattle(chapter.id, world.outcome.winner === PLAYER) : undefined;
    showAfterAction(
      document.getElementById("report") as HTMLElement,
      world, PLAYER, () => window.location.reload(),
      entry ? { entry, again: "Continue the chronicle" } : undefined,
    );
  }

  // Deployment freezes the match, so the sim's vision sweep never runs and the
  // fog would sit at "never seen" everywhere -- you would be setting your army
  // out on a blacked-out map, unable to read the ground you were choosing.
  // Light it from here instead. Throttled because nothing else is competing for
  // the frame and there is no reason to re-stamp 160 discs sixty times a second.
  if (world.deploying && deployFogTick++ % 6 === 0) world.lightGround();

  tutorial?.update();
  abilityBar.update(world, PLAYER, commander, TICK_RATE);
  if (world.outcome) abilityBar.hide();

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
  // Companies on the move scuff the ground. Purely visual and driven from the
  // render clock, so it never touches a tick.
  if (!paused && now - lastDust > 70) {
    lastDust = now;
    for (const g of world.groups) {
      if (g.stance !== "move" && g.stance !== "attack" && g.stance !== "retreat") continue;
      // Dust rises from the men, and only from men who are really moving and
      // really in view. Kicked at the anchor, it ran ahead of the column and
      // went on rising from empty ground after the riders were cut down.
      const p = presenceOf(world, g, PLAYER, prev);
      if (!isMoving(p)) continue;
      effects.kickDust(p.x, p.y, clock, Math.max(18, Math.min(g.radius, p.spread * 2 + 8)), g.id);
    }
  }
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
  } else if (v.mode === "survive") {
    lines.push(v.defender === PLAYER ? "hold out until the clock runs down" : "break them before time");
  } else if (v.mode === "breakthrough") {
    const where = world.controlPoints[v.exit]?.name ?? "the exit";
    lines.push(
      (v.attacker === PLAYER ? "through to " : "keep them from ") + where + ": " +
      world.through[v.attacker] + "/" + v.required,
    );
  } else if (v.mode === "standard") {
    const [a, b] = world.standardsFlying();
    const mine = PLAYER === 0 ? a : b;
    const theirs = PLAYER === 0 ? b : a;
    lines.push("colours: yours " + (mine ? "flying" : "taken") + ", theirs " + (theirs ? "flying" : "taken"));
  }
  if (world.deploying) {
    lines.push("", "loop to group - glyph to form up - drag to place", "ENTER to begin");
  }
  else if (world.outcome) {
    lines.push("", world.outcome.winner === PLAYER ? "VICTORY" : world.outcome.winner < 0 ? "DRAW" : "DEFEAT");
  } else if (lastBreak && performance.now() - lastBreakAt < BREAK_NOTICE_MS) {
    // A company breaking outranks the pen's own chatter: it is the one thing
    // happening on the field that the player most needs to know about. Kept to
    // a single line that fades, because the battlefield stays uncluttered and
    // the full account belongs in the after-action report.
    lines.push("", lastBreak);
  } else if (pen.lastAction) lines.push("", pen.lastAction);

  // The lesson owns the panel while it is running.
  if (tutorial) lines.push(...tutorial.lines());

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
