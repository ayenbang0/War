/**
 * Layer 2, the battle: everything main.ts used to do for its one battle, as an
 * object with a beginning and an end.
 *
 * Built from a plain BattleConfig, so the lesson, the test launch and (from
 * K5) the kingdom map's descent all launch it the same way. `start()` attaches
 * the listeners and the frame loop; `teardown()` cancels the loop, removes every
 * listener it added, clears the canvas and the HUD, and hands back what
 * happened -- so a second battle can be built straight after without a page
 * reload, which is what every return used to cost.
 *
 * Fixed-timestep accumulator: the sim advances in whole 20 Hz ticks and never
 * sees real time, while rendering happens at display rate and interpolates
 * between the last two tick states. That split is what makes the simulation
 * reproducible while the picture stays smooth.
 */

import { World, TICK_DT, TICK_RATE } from "../sim/world.ts";
import type { Outcome } from "../sim/victory.ts";
import { hashWorld } from "../sim/hash.ts";
import { TILE_SIZE } from "../sim/terrain.ts";
import { UNIT_TYPES } from "../content/unit-types.ts";
import type { AbilityId } from "../content/abilities.ts";
import { Camera } from "../render/camera.ts";
import { Renderer, type Snapshot } from "../render/renderer.ts";
import { drawInk } from "../render/ink.ts";
import { Effects } from "../render/effects.ts";
import { isMoving, presenceOf } from "../render/presence.ts";
import { watchReducedMotion } from "../render/motion.ts";
import { CameraControls } from "../input/camera-controls.ts";
import { Commander } from "../input/commander.ts";
import { Pen } from "../input/pen.ts";
import { AbilityBar } from "../ui/ability-bar.ts";
import { signal } from "../ui/story/signals.ts";
import { abilitySlotForCode, type LayerKeys } from "../ui/keys.ts";
import type { InputContext, KeyInput, KeyVerdict } from "../ui/screen-stack.ts";
import { battleWorld, distinctAbilities, type BattleConfig } from "./battle-config.ts";
import type { FieldedSquad } from "../sim/layers.ts";

/** The seat the local player always takes. */
export const PLAYER = 0;

const MAX_STEPS_PER_FRAME = 5;
/** How long a "company broke" line stays on screen. */
const BREAK_NOTICE_MS = 4200;
/**
 * Dev builds expose `window.war` for console poking. Read defensively so the
 * layer also runs under Node (tools/ui-check.ts), where import.meta has no env.
 */
const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
/** The page colour, painted over the canvas when a battle is torn down. */
const CLEAR_COLOUR = "#d9cbb0";

/** Where the battle is in its life. */
export type BattlePhase = "built" | "live" | "over" | "torn-down";

/** The player's own pause (Space), distinct from a screen holding the sim. */
export type RunState = "running" | "paused";

/** What the battle tells the controller. */
export type BattleHooks = {
  /** The match has just ended. Called once. */
  onOutcome(outcome: Outcome): void;
  /** Esc with nothing to cancel: the player wants to leave. */
  requestLeave(): void;
  /** True while a screen on the stack holds the sim (a dialog, the report). */
  simHeld(): boolean;
};

/** The page the battle draws into. */
export type BattleEnv = {
  readonly win: Window;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly hud: HTMLElement;
  readonly abilityRoot: HTMLElement;
};

/** What teardown hands back. */
export type BattleReport = {
  readonly outcome: Outcome | null;
  readonly tick: number;
  readonly hash: string;
};

export class BattleLayer implements LayerKeys {
  readonly kind = "battle" as const;
  readonly config: BattleConfig;
  readonly world: World;
  /** Where each squad's men were set down, per side (K5 reads survivors back from this). */
  readonly fielded: readonly (readonly FieldedSquad[])[];
  readonly cam: Camera;
  readonly commander: Commander;
  readonly pen: Pen;
  /** Distinct abilities, in slot order. */
  readonly abilityKeys: readonly AbilityId[];
  phase: BattlePhase = "built";
  run: RunState = "running";
  showDebug = false;

  private readonly env: BattleEnv;
  private readonly hooks: BattleHooks;
  private readonly renderer: Renderer;
  private readonly controls: CameraControls;
  private readonly effects: Effects;
  private readonly abilityBar: AbilityBar;
  private readonly prev: Snapshot;
  private readonly myZone: { x: number; y: number; w: number; h: number } | undefined;

  private raf = 0;
  private last = 0;
  /** Undo for the reduced-motion listener. */
  private unwatchMotion: () => void = () => {};
  private accumulator = 0;
  private fps = 0;
  private hudTimer = 0;

  /**
   * How strongly the map still shows where an enemy company was last seen,
   * 0 to 1. Read by the e2e harness to check that marks age on the sim clock
   * and hold still while the battle is paused (RF-06).
   */
  lastSeenFade(group: number): number {
    return this.renderer.lastSeenFade(this.world, group);
  }

  /** For the e2e harness: record a sighting as if the company had just been seen at (x, y) `ageTicks` ago. */
  noteSightingForTest(group: number, x: number, y: number, ageTicks: number): void {
    this.renderer.noteSighting(this.world, group, x, y, ageTicks);
  }
  private cachedHash = "";
  private deployFogTick = 0;
  private lastDust = 0;
  /** The last company to break, shown briefly and then allowed to fade. */
  private lastBreak = "";
  private lastBreakAt = 0;
  /** K10: the HUD's siege line, and the tick (with deploying and outcome) it was read at. */
  private siegeLine = "";
  private siegeLineKey = -1;
  private breaksSeen = 0;

  constructor(config: BattleConfig, env: BattleEnv, hooks: BattleHooks) {
    this.config = config;
    this.env = env;
    this.hooks = hooks;
    const level = config.level;

    // The world and its men, set out from the config (battle-config.ts: the
    // headless suites build battles the same way).
    const built = battleWorld(config);
    this.world = built.world;
    this.fielded = built.fielded;
    this.abilityKeys = distinctAbilities(config.abilities[PLAYER]);
    const world = this.world;
    this.myZone = level.deployment.find((z) => z.player === PLAYER);

    this.cam = new Camera(world.terrain.worldWidth, world.terrain.worldHeight);
    // Open looking at YOUR OWN MEN, not at the middle of your deployment zone.
    // The zone is much taller than the force set out in it, so the camera
    // started well below the army.
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
      const z = this.myZone;
      this.cam.x = n > 0 ? cx / n : (z ? z.x + z.w / 2 : 20) * TILE_SIZE;
      this.cam.y = n > 0 ? cy / n : world.terrain.worldHeight * 0.5;
    }
    this.cam.zoom = 1.1;

    this.renderer = new Renderer(env.ctx, world.terrain, PLAYER);
    this.effects = new Effects(PLAYER);
    this.commander = new Commander(world, PLAYER);
    // Men may be set down only inside the player's own deployment zone. The
    // zone is level data, so the battle supplies the test; the order itself
    // (`place`) is checked again by the world for ground nobody can stand on.
    this.commander.placeable = (x, y) => this.inDeploymentZone(x, y);
    // Attached now but switched off until start(), and removed by teardown()
    // whether or not the battle was ever started.
    this.controls = new CameraControls(env.canvas, this.cam);
    this.pen = new Pen(env.canvas, this.cam, this.commander);
    this.controls.setEnabled(false);
    this.pen.setEnabled(false);

    this.prev = {
      x: new Float64Array(world.soldiers.capacity),
      y: new Float64Array(world.soldiers.capacity),
      facing: new Float64Array(world.soldiers.capacity),
    };
    this.snapshotInto(this.prev);
    // K9: the drill has abilities too (readying and casting one is taught).
    this.abilityBar = new AbilityBar(env.abilityRoot, this.abilityKeys, this.commander);

    this.cachedHash = hashWorld(world);
  }

  /** Attach the page listeners and start the frame loop. */
  start(): void {
    if (this.phase !== "built") throw new Error("battle already started");
    this.phase = "live";
    this.env.win.addEventListener("resize", this.resize);
    this.resize();
    this.frameOpening();
    this.unwatchMotion = watchReducedMotion(this.env.win);
    this.pen.setEnabled(true);
    this.controls.setEnabled(true);
    if (DEV) {
      (this.env.win as unknown as { war: unknown }).war = {
        world: this.world, cam: this.cam, level: this.config.level, commander: this.commander,
        pen: this.pen, hashWorld, UNIT_TYPES,
      };
    }
    this.last = performance.now();
    this.raf = this.env.win.requestAnimationFrame(this.frame);
  }

  /**
   * Stop everything and leave the page as a menu would find it: no loop, no
   * listener, a blank canvas, an empty (and so hidden) HUD, no ability bar.
   */
  teardown(): BattleReport {
    const report: BattleReport = {
      outcome: this.world.outcome, tick: this.world.tick, hash: hashWorld(this.world),
    };
    if (this.phase === "torn-down") return report;
    this.phase = "torn-down";
    this.env.win.cancelAnimationFrame(this.raf);
    this.env.win.removeEventListener("resize", this.resize);
    this.unwatchMotion();
    this.pen.dispose();
    this.controls.dispose();
    this.abilityBar.dispose();
    this.env.hud.textContent = "";
    const { ctx, canvas } = this.env;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = CLEAR_COLOUR;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    if (DEV) delete (this.env.win as unknown as { war?: unknown }).war;
    return report;
  }

  /** The screen on top decides what is live (plan §C.4). */
  setContexts(contexts: readonly InputContext[]): void {
    if (this.phase === "torn-down") return;
    this.pen.setEnabled(contexts.includes("pen"));
    this.controls.setEnabled(contexts.includes("camera"));
  }

  // -- keys (from the router) -------------------------------------------------

  keyDown(k: KeyInput, contexts: readonly InputContext[]): KeyVerdict {
    if (this.phase === "torn-down") return "pass";
    const pen = contexts.includes("pen");
    const world = this.world;

    if (k.code === "Escape") {
      if (k.repeat) return "handled";
      // GK-01 / PC-06 / BS-04: Esc has ONE owner, and works down a list. A
      // stroke in progress claims it first and nothing else sees the press;
      // then an armed ability is put away (GK-06); only then is it "leave",
      // which asks before it throws anything away.
      if (pen && this.pen.cancelStroke()) {
        signal({ kind: "ui", action: "cancelStroke" });
        return "handled";
      }
      if (this.commander.armed !== null) {
        this.commander.arm(this.commander.armed);
        this.pen.lastAction = "put away";
        return "handled";
      }
      this.hooks.requestLeave();
      return "handled";
    }

    if (pen && (k.code === "Enter" || k.code === "NumpadEnter") && world.deploying) {
      if (k.repeat) return "handled";
      world.deploying = false;
      this.pen.lastAction = "battle begins";
      signal({ kind: "ui", action: "beginBattle" });
      return "handled";
    }

    const slot = abilitySlotForCode(k.code);
    if (slot >= 0) {
      // Arm an ability; the next pen stroke says where it goes. The left
      // button stays the only thing that ever points at the world.
      if (!pen || world.deploying || k.repeat) return "handled";
      if (slot < this.abilityKeys.length) {
        this.pen.lastAction = this.commander.arm(this.abilityKeys[slot]);
        if (this.commander.armed !== null) signal({ kind: "ui", action: "abilityArm" });
      }
      return "handled";
    }

    // K10: the defender of a siege opens and shuts its gates (a sally, or a
    // door shut in the stormers' faces). The order is the sim's to refuse:
    // a gate with men standing in it does not shut.
    if (k.code === "KeyG" && pen && world.hasGates(PLAYER)) {
      if (k.repeat || world.deploying || world.outcome) return "handled";
      const open = !world.gatesOpen(PLAYER);
      world.orders.issue({ kind: "gates", open }, PLAYER, world.tick + 1);
      // Audit K10-04: a gate is never shut on men, so say so rather than claim it shut.
      this.pen.lastAction = open ? "gates open" : world.gateHeldOpen(PLAYER) ? "men in the gateway - it stays open" : "gates shut";
      return "handled";
    }

    if (k.code === "F2") {
      k.preventDefault();
      if (!k.repeat) this.showDebug = !this.showDebug;
      return "handled";
    }
    if (k.code === "Space") {
      // Without preventDefault the page would scroll; without the repeat check
      // a held Space flickers the pause (GK-05).
      k.preventDefault();
      if (!k.repeat) {
        this.run = this.run === "paused" ? "running" : "paused";
        if (this.run === "paused") signal({ kind: "time", action: "pause" });
      }
      return "handled";
    }
    if (k.code === "Period" && this.run === "paused") {
      this.snapshotInto(this.prev);
      world.step();
      signal({ kind: "time", action: "step" });
      return "handled";
    }
    if (contexts.includes("camera") && this.controls.keyDown(k.code)) return "handled";
    return "pass";
  }

  keyUp(code: string): void {
    this.controls.keyUp(code);
  }

  releaseAll(): void {
    this.controls.releaseAll();
  }

  // -- the loop -------------------------------------------------------------

  private resize = (): void => {
    const { win, canvas, ctx } = this.env;
    const dpr = Math.min(win.devicePixelRatio || 1, 2);
    const w = win.innerWidth;
    const h = win.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cam.setViewport(w, h);
  };

  /**
   * Open on the player's own army, in the part of the window the HUD furniture
   * leaves clear (audit RT-04). The ability bar runs along the bottom and can
   * be two rows deep; centring the army on the whole window put its rear
   * companies under the bar. The army is centred in the band above the bar,
   * and the camera pulls back (to no wider than 0.6) if it would not fit.
   */
  private frameOpening(): void {
    const { world, cam } = this;
    const s = world.soldiers;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < s.count; i++) {
      if (s.alive[i] !== 1 || s.player[i] !== PLAYER) continue;
      x0 = Math.min(x0, s.x[i]);
      y0 = Math.min(y0, s.y[i]);
      x1 = Math.max(x1, s.x[i]);
      y1 = Math.max(y1, s.y[i]);
    }
    if (!Number.isFinite(x0)) return;
    const bar = this.env.abilityRoot;
    // Plain-object hosts (tools/ui-check.ts) have no layout; treat as no bar.
    const rect = typeof bar.getBoundingClientRect === "function"
      ? bar.getBoundingClientRect()
      : { top: cam.viewH, height: 0 };
    const barShown = bar.style.display !== "none" && rect.height > 0;
    // The usable band, in screen px: clear of the bar, with a margin.
    const margin = 36;
    const bandBottom = barShown ? Math.min(cam.viewH, rect.top) - margin : cam.viewH - margin;
    const bandTop = margin;
    const band = Math.max(120, bandBottom - bandTop);
    const span = 60; // world-unit pad so the outermost men are not on the edge
    const fitY = band / Math.max(1, y1 - y0 + span * 2);
    const fitX = (cam.viewW - margin * 2) / Math.max(1, x1 - x0 + span * 2);
    cam.zoom = Math.max(0.6, Math.min(cam.zoom, fitX, fitY));
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    // Put the army's centre in the middle of the band rather than the window.
    const bandMid = (bandTop + bandBottom) / 2;
    cam.x = cx;
    cam.y = cy - (bandMid - cam.viewH / 2) / cam.zoom;
    cam.setViewport(cam.viewW, cam.viewH);
  }

  private snapshotInto(t: Snapshot): void {
    t.x.set(this.world.soldiers.x);
    t.y.set(this.world.soldiers.y);
    t.facing.set(this.world.soldiers.facing);
  }

  /** Whether the sim is held this frame, by the player or by a screen. */
  private held(): boolean {
    return this.run === "paused" || this.hooks.simHeld();
  }

  private inDeploymentZone(x: number, y: number): boolean {
    const z = this.myZone;
    if (!z) return false;
    return (
      x >= z.x * TILE_SIZE && x <= (z.x + z.w) * TILE_SIZE &&
      y >= z.y * TILE_SIZE && y <= (z.y + z.h) * TILE_SIZE
    );
  }

  private frame = (now: number): void => {
    if (this.phase === "torn-down") return;
    const { world, effects, renderer, commander, pen, cam, prev } = this;
    const ctx = this.env.ctx;
    const dtReal = Math.min((now - this.last) / 1000, 0.25);
    this.last = now;
    this.fps += (1 / Math.max(dtReal, 1e-6) - this.fps) * 0.1;

    this.controls.update(dtReal);
    commander.flushPending(now);

    const held = this.held();
    if (world.deploying && !this.hooks.simHeld()) {
      // Setting out: the clock stands still, but every frame is a tick
      // boundary for the setup orders -- a company being carried, ranks being
      // dressed -- which the world applies in step() (audit PC-05). Running
      // under the player's own pause too: pausing stops a battle, and this is
      // not one yet.
      world.step();
      this.snapshotInto(prev);
    } else if (!held) {
      this.accumulator += dtReal;
      let steps = 0;
      while (this.accumulator >= TICK_DT && steps < MAX_STEPS_PER_FRAME) {
        this.snapshotInto(prev);
        world.step();
        // Events are cleared at the top of every tick, so a frame running
        // several ticks would otherwise see only the last one's blows. Blows
        // you could not see leave nothing above the fog either.
        // One perception predicate for everything drawn over the map (RF-04):
        // a blow by who can be seen in it, a body by whether its man could
        // be, a moment by whether its ground is truly in view.
        const sees = renderer.perception;
        sees.refresh(world, now);
        effects.ingest(world.events, now / 1000, (e) => sees.event(world, e));
        renderer.fallen.ingest(world, world.events, PLAYER, world.tick / TICK_RATE);
        effects.ingestSpecials(
          world.specialEvents.filter((m) => m.player === PLAYER || sees.ground(m.x, m.y)),
          now / 1000,
        );
        // A company that has just ceased to exist leaves nothing behind.
        for (const id of world.disbanded) effects.forgetGroup(id);
        this.accumulator -= TICK_DT;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
    }

    // Pick up any company that broke since the last frame. Only the player's
    // own are announced -- being told the enemy is breaking would hand over
    // information the fog is meant to be keeping.
    while (this.breaksSeen < world.breakages.length) {
      const b = world.breakages[this.breaksSeen++];
      // On the map, for any company the player can see break -- theirs or the
      // enemy's, whose flight is in plain view (RF-09). A company wiped out
      // has no men left to mark.
      const g = world.groupById(b.group);
      if (g) {
        const p = presenceOf(world, g, PLAYER);
        if (p.n > 0) effects.ingestBreak(p.x, p.y, g.player, now / 1000);
      }
      if (b.player !== PLAYER) continue;
      this.lastBreak = b.name + " broke - " + b.cause;
      this.lastBreakAt = now;
    }

    // The match has just ended: tell the controller once. Guarded by the phase
    // rather than by clearing world.outcome, because the outcome is real state
    // that the HUD and the sim both still read.
    if (world.outcome && this.phase === "live") {
      this.phase = "over";
      this.abilityBar.hide();
      this.hooks.onOutcome(world.outcome);
      // The controller may have torn the battle down from inside that call.
      if ((this.phase as BattlePhase) === "torn-down") return;
    }

    // Deployment freezes the match, so the sim's vision sweep never runs and
    // the fog would sit at "never seen" everywhere. Light it from here instead,
    // throttled because there is no reason to re-stamp 160 discs every frame.
    if (world.deploying && this.deployFogTick++ % 6 === 0) world.lightGround();

    this.abilityBar.update(world, PLAYER, commander, TICK_RATE);

    const alpha = held ? 1 : Math.min(this.accumulator / TICK_DT, 1);
    const clock = now / 1000;
    renderer.draw(world, cam, prev, alpha, commander.selected, clock, PLAYER);
    // Companies on the move scuff the ground. Purely visual and driven from
    // the render clock, so it never touches a tick.
    if (!held && now - this.lastDust > 70) {
      this.lastDust = now;
      for (const g of world.groups) {
        if (g.stance !== "move" && g.stance !== "attack" && g.stance !== "retreat") continue;
        const p = presenceOf(world, g, PLAYER, prev);
        if (!isMoving(p)) continue;
        effects.kickDust(p.x, p.y, clock, Math.max(18, Math.min(g.radius, p.spread * 2 + 8)), g.id);
      }
    }
    effects.draw(ctx, cam, clock);
    drawInk(ctx, cam, pen.points, commander.ghost, commander.pendingRail, pen.rejected, now);
    if (this.run === "paused") {
      // BH-01: a paused field must not look like a frozen one. Dimmed, and the
      // HUD says so in words.
      ctx.fillStyle = "rgba(40, 32, 22, 0.16)";
      ctx.fillRect(0, 0, cam.viewW, cam.viewH);
    }

    this.hudTimer += dtReal;
    if (this.hudTimer > 0.5) {
      this.hudTimer = 0;
      this.cachedHash = hashWorld(world);
    }
    this.drawHud();
    this.raf = this.env.win.requestAnimationFrame(this.frame);
  };

  /**
   * The whole interface, deliberately almost nothing.
   *
   * Your own army's nerve and numbers, the clock, and what the pen just did.
   * Everything else -- tick counts, hashes, frame rate, the enemy's strength --
   * is either a debugging aid or information you are supposed to earn by
   * scouting, and neither belongs on the screen during a battle. F2 brings the
   * diagnostics back when they are actually wanted.
   */
  private drawHud(): void {
    const { world, pen, cam } = this;
    const t = world.tick / TICK_RATE;
    const left = Math.max(0, world.duration - t);
    const men = world.soldiersOf(PLAYER).length;
    const morale = world.armyMorale(PLAYER);
    // A lesson has no clock to show (BS-05); six hours counting down would
    // only suggest that it is a race.
    const clock = this.config.mode === "lesson"
      ? "lesson"
      : String(Math.floor(left / 60)).padStart(2, "0") + ":" +
        String(Math.floor(left % 60)).padStart(2, "0");

    const bars = 20;
    const filled = Math.round(morale * bars);
    const bar = "█".repeat(filled) + "░".repeat(bars - filled);

    const lines: string[] = [];
    if (this.run === "paused") lines.push("PAUSED - space to resume", "");
    lines.push(
      clock + "   " + men + " men",
      bar + " " + (morale * 100).toFixed(0) + "%",
    );
    const v = world.victory;
    if (this.config.mode === "lesson") {
      // The lesson's ground has a win condition of its own, which is not what
      // the lesson is about.
    } else if (v.mode === "objectives") {
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
    // K10: a siege's walls, and the defender's gates. Read once per sim tick,
    // not per frame (audit K10-03): walls and gates change only on a tick.
    if (world.siege) {
      const key = world.tick * 4 + (world.deploying ? 1 : 0) + (world.outcome ? 2 : 0);
      if (this.siegeLineKey !== key) {
        this.siegeLineKey = key;
        const down = Math.round(world.wallDamage() / 10);
        // The gates are offered only while G can swing them (audit K10-02):
        // not while deploying, not once the battle is over.
        const live = !world.deploying && !world.outcome && world.hasGates(PLAYER);
        const gates = live ? (world.gatesOpen(PLAYER) ? "gates open - G to shut" : "gates shut - G to open") : "";
        this.siegeLine = ["walls " + (down > 0 ? down + "% down" : "whole"), gates].filter(Boolean).join("   ");
      }
      lines.push(this.siegeLine);
    }
    if (world.deploying) {
      lines.push("", "loop to group - glyph to form up - drag to place", "ENTER to begin");
    } else if (world.outcome) {
      lines.push("", world.outcome.winner === PLAYER ? "VICTORY" : world.outcome.winner < 0 ? "DRAW" : "DEFEAT");
    } else if (this.lastBreak && performance.now() - this.lastBreakAt < BREAK_NOTICE_MS) {
      // A company breaking outranks the pen's own chatter: it is the one thing
      // happening on the field that the player most needs to know about.
      lines.push("", this.lastBreak);
    } else if (pen.lastAction) lines.push("", pen.lastAction);


    if (this.showDebug) {
      lines.push(
        "",
        "tick " + world.tick + "  " + this.cachedHash,
        "groups " + world.groups.length + "  fps " + this.fps.toFixed(0),
        "zoom " + cam.zoom.toFixed(2) + "  foe " + (world.ai[0] ? world.ai[0].style : "-"),
      );
    }
    this.env.hud.textContent = lines.join("\n");
  }
}
