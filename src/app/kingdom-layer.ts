/**
 * Layer 3, the kingdom map (PLAN.md §B, phase K2).
 *
 * Owns, for as long as the kingdom is live: the frame loop that runs the
 * KingdomWorld in real time (kingdom-clock.ts), the parchment renderer, the
 * kingdom camera and its controls, the kingdom pen, the HUD and the cards.
 * `start()` attaches everything and `teardown()` removes every listener,
 * cancels the loop, saves, and leaves the canvas blank -- the same contract as
 * BattleLayer, so the controller can move between layers without a reload.
 *
 * The world is written in exactly two ways, both of them orders through
 * `world.issue` (the march and the halt) plus `world.tick()` from the clock.
 * The renderer, the cards and the HUD only read it.
 *
 * Saving (U1-14, U1-15): on every day boundary, on leaving the layer and when
 * the page is hidden or closed. A failed save is SAID, as a standing notice
 * that stays until a save succeeds again -- never swallowed.
 */

import type { InputContext, KeyInput, KeyVerdict, Screen } from "../ui/screen-stack.ts";
import type { LayerKeys } from "../ui/keys.ts";
import type { KingdomWorld } from "../sim/kingdom/world.ts";
import type { KingdomEvent } from "../sim/kingdom/state.ts";
import { KING_PLAYER } from "../content/kingdom/factions.ts";
import { E, FARM_EVENT_LINE, K, WEATHER_LINE, amountsLine, dateLine } from "../content/kingdom/ui-strings.ts";
import { BUILDINGS, type BuildingId } from "../content/kingdom/buildings.ts";
import { CROPS, type CropId } from "../content/kingdom/crops.ts";
import type { KingdomOrderBody } from "../sim/kingdom/orders.ts";
import { KingdomCamera, OPENING_MILES } from "../render/kingdom/camera.ts";
import { KingdomRenderer, type Fade, type InkStroke, type Pulse } from "../render/kingdom/renderer.ts";
import { kingCounterAt, type MapPoint } from "../render/kingdom/layout.ts";
import { table as TABLE_COLOUR } from "../render/kingdom/palette.ts";
import { KingdomPen, type KingdomStrokeSink } from "../input/kingdom-pen.ts";
import { KingdomCameraControls } from "../input/kingdom-camera-controls.ts";
import { interpretStroke, kingdomContext, routePoints, type KingdomCardRequest, type KingdomIntent } from "../input/kingdom-commander.ts";
import type { Point } from "../input/kingdom-gestures.ts";
import { KingdomHud } from "../ui/kingdom/hud.ts";
import { kingCard, regionCard, type CardView } from "../ui/kingdom/cards.ts";
import { KingdomClock, type KingdomSpeed } from "./kingdom-clock.ts";
import { ZoomThrough } from "../input/zoom-through.ts";
import { holdingAt } from "../input/kingdom-gestures.ts";
import { C } from "../content/kingdom/city-strings.ts";
import { saveKingdom, type SaveOutcome, type StorageLike } from "./kingdom-save.ts";

/** Where the kingdom layer is in its life; mirrors BattlePhase. */
export type KingdomPhase = "built" | "live" | "torn-down";

/** What leaving the kingdom layer hands back. */
export type KingdomReport = {
  /** Whole days elapsed since the exile began. */
  readonly days: number;
  /** The last save attempt (the one made on leaving). */
  readonly saved: SaveOutcome | null;
};

export type KingdomEnv = {
  readonly win: Window;
  readonly doc: Document;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  /** Where the realm is saved. Null runs it in memory only (and says so). */
  readonly storage: StorageLike | null;
};

export type KingdomHooks = {
  /** Esc with nothing to cancel, or the Front screen button: back to Home. */
  requestLeave(): void;
  /** True while a screen on the stack holds the sim (a confirm). */
  simHeld(): boolean;
  pushScreen(s: Screen): void;
  /** Pop `s` if it is on top; otherwise do nothing. */
  popScreen(s: Screen): void;
  /**
   * K3b: go down a layer, into the city of one of the king's holdings.
   * `from` is where the holding is on screen, for the transition.
   */
  enterCity?(holding: number, from: MapPoint): void;
};

/** How the realm was opened, for the first line in the feed. */
export type KingdomOpening = "begun" | "resumed";

const PULSE_SECONDS = 0.45;
const FADE_SECONDS = 0.6;
/** Flight time for F (find the king), and for nothing else: the camera never moves on its own. */
const FIND_KING_SECONDS = 0.5;
/** Longest frame step fed to the clock and the camera: a tab that slept resumes, it does not leap. */
const MAX_FRAME_SECONDS = 0.25;
/** K3b: two taps on one holding this close together enter its city. */
const DOUBLE_TAP_SECONDS = 0.45;
/** K3b: the eased zoom out to the map on leaving a city (instant under reduced motion). */
const LAYER_SECONDS = 0.45;
/** K3b: on leaving a city the map eases out to at least this many miles across. */
const RETURN_MILES = 260;

export function reducedMotion(win: Window): boolean {
  try {
    return typeof win.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function lerp(a: MapPoint, b: MapPoint, t: number): MapPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export class KingdomLayer implements LayerKeys {
  readonly kind = "kingdom" as const;
  phase: KingdomPhase = "built";

  readonly world: KingdomWorld;
  readonly cam: KingdomCamera;
  readonly clock = new KingdomClock();
  readonly hud: KingdomHud;
  readonly renderer: KingdomRenderer;
  /** The stroke's current meaning (preview), or the last committed one until the next stroke. */
  intent: KingdomIntent | null = null;
  /** The last committed intent, kept for the tests and the result line. */
  committed: KingdomIntent | null = null;
  /** The open card, if any. */
  card: CardView | null = null;
  /** Last save outcome; null before the first. */
  lastSave: SaveOutcome | null = null;
  /** Saves made (or tried) so far, for the tests. */
  saves = 0;

  private readonly env: KingdomEnv;
  private readonly hooks: KingdomHooks;
  private readonly pen: KingdomPen;
  private readonly controls: KingdomCameraControls;
  private readonly reduced: boolean;
  private raf = 0;
  private lastFrame: number | null = null;
  private clockSeconds = 0;
  /** King position before the last tick ran, for drawing him between ticks. */
  private prevKing: MapPoint;
  private stroke: InkStroke | null = null;
  private fades: Fade[] = [];
  private pulses: Pulse[] = [];
  private lastWeather: string;
  private saveFailing = false;
  /** Set by an event that changes what the resources bar shows. */
  private storesDirty = false;
  private oldCanvasLabel: string | null = null;
  /** K3b: a city is open over the map. The realm still runs (the city drives `advance`); the map is not drawn and takes no input. */
  private suspended = false;
  /** K3b: the map's zoom when a city was entered, to ease back out to. */
  private zoomBefore = 0;
  /** K3b: the last tap on a holding, for a double tap. */
  private lastTap: { holding: number; at: number } | null = null;
  private readonly zoomIn: ZoomThrough;

  constructor(world: KingdomWorld, env: KingdomEnv, hooks: KingdomHooks, opening: KingdomOpening, notice: string | null = null) {
    this.world = world;
    this.env = env;
    this.hooks = hooks;
    this.reduced = reducedMotion(env.win);
    this.cam = new KingdomCamera(world.map.width, world.map.height);
    this.prevKing = world.kingPosition();
    this.lastWeather = world.weather;

    this.hud = new KingdomHud(env.doc, {
      setSpeed: (s) => this.setSpeed(s),
      pause: () => this.togglePause(),
      leave: () => this.hooks.requestLeave(),
    });
    this.hud.setShown(false);
    this.hud.setDate(world.date, world.weather);
    this.hud.setRun(this.clock.run, this.clock.speed);
    this.hud.resources.update(world);
    this.hud.alert(world.date.day, opening === "begun" ? K.begun : K.resumed(dateLine(world.date)));
    if (notice) this.hud.setNotice(notice);

    this.renderer = new KingdomRenderer(env.ctx, world, env.doc);
    const sink: KingdomStrokeSink = {
      strokeChanged: (pts) => this.strokeChanged(pts),
      strokeEnded: (pts) => this.strokeEnded(pts),
      strokeCancelled: () => this.strokeCancelled(),
    };
    // Built now but off until start(), and removed by teardown() whether or
    // not the layer was ever started -- the battle layer's rule.
    this.pen = new KingdomPen(env.canvas, this.cam, sink);
    // K3b: wheeling on past the closest zoom over a holding of the king's
    // goes down into its city. Added before the camera's controls, so it sees
    // whether the camera was already at its limit before this notch.
    this.zoomIn = new ZoomThrough(env.canvas, {
      direction: "in",
      atLimit: () => this.cam.zoom >= this.cam.maxZoom - 1e-9,
      target: (sx, sy) => {
        const p = { x: this.cam.screenToWorldX(sx), y: this.cam.screenToWorldY(sy) };
        const hv = holdingAt(kingdomContext(this.world, this.kingDrawn(), this.cam.pxToWorld), p);
        if (!hv) return null;
        return this.world.holding(hv.id)?.owner === "king" ? hv.id : "refused";
      },
      through: (id) => this.requestCity(id),
      refused: (sx, sy) => {
        const hv = holdingAt(kingdomContext(this.world, this.kingDrawn(), this.cam.pxToWorld),
          { x: this.cam.screenToWorldX(sx), y: this.cam.screenToWorldY(sy) });
        if (hv) this.hud.result(C.notYours(this.world.holding(hv.id)?.name ?? "?"));
      },
    });
    this.controls = new KingdomCameraControls(env.canvas, this.cam, !this.reduced);
    this.pen.setEnabled(false);
    this.controls.setEnabled(false);
  }

  /** Attach the page listeners and start the frame loop. */
  start(): void {
    if (this.phase !== "built") throw new Error("kingdom already started");
    this.phase = "live";
    const { win, doc, canvas } = this.env;
    doc.body.appendChild(this.hud.root);
    this.hud.setShown(true);
    this.oldCanvasLabel = canvas.getAttribute("aria-label");
    canvas.setAttribute("aria-label", K.canvasLabel);
    win.addEventListener("resize", this.resize);
    win.addEventListener("pagehide", this.onPageHide);
    doc.addEventListener("visibilitychange", this.onVisibility);
    this.resize();
    // The opening view: the king's corner of the realm, near enough to read
    // the hamlets round him, with the map still recognisably a map (U1-02).
    const k = this.world.kingPosition();
    this.cam.cut(k.x, k.y, this.cam.zoomForSpan(OPENING_MILES));
    this.pen.setEnabled(true);
    this.controls.setEnabled(true);
    this.raf = win.requestAnimationFrame(this.frame);
  }

  teardown(): KingdomReport {
    if (this.phase === "torn-down") return { days: this.world.date.day, saved: this.lastSave };
    const wasLive = this.phase === "live";
    this.phase = "torn-down";
    const { win, doc, canvas, ctx } = this.env;
    // Save first, while everything is still intact (U1-14: leaving saves).
    if (wasLive) this.save();
    win.cancelAnimationFrame(this.raf);
    win.removeEventListener("resize", this.resize);
    win.removeEventListener("pagehide", this.onPageHide);
    doc.removeEventListener("visibilitychange", this.onVisibility);
    this.pen.dispose();
    this.zoomIn.dispose();
    this.controls.dispose();
    this.hud.root.parentNode?.removeChild(this.hud.root);
    if (this.oldCanvasLabel === null) canvas.removeAttribute("aria-label");
    else canvas.setAttribute("aria-label", this.oldCanvasLabel);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = TABLE_COLOUR;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    return { days: this.world.date.day, saved: this.lastSave };
  }

  /** The screen on top decides what is live (plan §C.4). */
  setContexts(contexts: readonly InputContext[]): void {
    // While a city is open its layer decides (and lends the HUD's buttons out).
    if (this.phase === "torn-down" || this.suspended) return;
    const pen = contexts.includes("pen");
    this.pen.setEnabled(pen && this.phase === "live");
    this.controls.setEnabled(contexts.includes("camera") && this.phase === "live");
    this.zoomIn.setEnabled(contexts.includes("camera") && this.phase === "live");
    // The HUD's buttons are usable exactly while the map is: under a card
    // (non-modal) yes, under a confirm no.
    this.hud.setLive(pen);
  }

  /** The kingdom screen shown or hidden by the stack. */
  setShown(shown: boolean): void {
    if (this.phase === "live") this.hud.setShown(shown);
  }

  // -- keys (from the router) -------------------------------------------------

  keyDown(k: KeyInput, contexts: readonly InputContext[]): KeyVerdict {
    if (this.phase !== "live") return "pass";
    const pen = contexts.includes("pen");
    switch (k.code) {
      case "Escape":
        if (k.repeat) return "handled";
        // One owner per press: a stroke in progress first, then leaving. (A
        // card, when open, is on top of the stack and saw Esc before us.)
        if (pen && this.pen.cancelStroke()) {
          this.hud.result("Stroke cancelled.");
          return "handled";
        }
        this.hooks.requestLeave();
        return "handled";
      case "Space":
        // Without preventDefault the page scrolls; without the repeat check
        // a held Space flickers the pause.
        k.preventDefault();
        if (!k.repeat) this.togglePause();
        return "handled";
      case "Period":
      case "NumpadDecimal":
        if (k.repeat) return "handled";
        this.stepDay();
        return "handled";
      case "Digit1": case "Numpad1":
        if (!k.repeat) this.setSpeed(1);
        return "handled";
      case "Digit2": case "Numpad2":
        if (!k.repeat) this.setSpeed(2);
        return "handled";
      case "Digit3": case "Numpad3":
        if (!k.repeat) this.setSpeed(4);
        return "handled";
      case "KeyF":
        if (!k.repeat) this.findKing();
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

  // -- time -------------------------------------------------------------------

  togglePause(): void {
    this.clock.togglePause();
    this.hud.setRun(this.clock.run, this.clock.speed);
  }

  setSpeed(s: KingdomSpeed): void {
    this.clock.setSpeed(s);
    this.hud.setRun(this.clock.run, this.clock.speed);
  }

  /** `.`: one day, only while paused -- otherwise say how. */
  stepDay(): void {
    const n = this.clock.stepDay();
    if (n === 0) {
      this.hud.result(K.pauseFirst);
      return;
    }
    this.runTicks(n);
    this.hud.result(K.steppedDay);
  }

  /**
   * K3b: run the realm's clock for `dt` real seconds and return the ticks it
   * ran. The map's own frame calls it; so does an open city's, because the
   * city is a view of the same realm and its time does not stop there.
   */
  advance(dt: number): number {
    const n = this.clock.advance(dt, this.hooks.simHeld());
    this.runTicks(n);
    this.hud.setRun(this.clock.run, this.clock.speed);
    return n;
  }

  /** Run `n` ticks and react to what they did. The only caller of world.tick(). */
  private runTicks(n: number): void {
    let dayTurned = false;
    this.storesDirty = false;
    for (let i = 0; i < n; i++) {
      this.prevKing = this.world.kingPosition();
      const events = this.world.tick();
      for (const e of events) if (this.onEvent(e)) dayTurned = true;
    }
    // The resources bar is written once per batch of ticks, and only when an
    // event said the stocks (or what they mean) changed -- never per frame.
    if (this.storesDirty) this.hud.resources.update(this.world);
    if (n > 0) {
      // The calendar turns when `now` crosses a day, one tick before that
      // day's dayBegan event fires (the event comes from the day's first
      // tick), so the date line follows `now`, not the event.
      this.hud.setDate(this.world.date, this.world.weather);
      this.card?.refresh();
    }
    if (dayTurned) this.save();
  }

  /** Returns true for a day boundary. */
  private onEvent(e: KingdomEvent): boolean {
    const w = this.world;
    const day = w.date.day;
    const name = (id: number): string => w.holding(id)?.name ?? "?";
    switch (e.kind) {
      case "dayBegan":
        // A new day changes "since yesterday" even when no stock moved.
        this.storesDirty = true;
        this.hud.setDate(w.date, w.weather);
        if (w.weather !== this.lastWeather) {
          this.lastWeather = w.weather;
          this.hud.alert(day, K.weatherTurned(WEATHER_LINE[w.weather]));
        }
        return true;
      case "kingDeparted":
        this.hud.alert(day, K.departed({ from: name(e.from), to: name(e.to) }));
        return false;
      case "kingArrived": {
        const h = w.holding(e.at);
        this.hud.alert(day, e.destination ? K.arrived(name(e.at)) : K.passed(name(e.at)));
        if (h && e.destination) this.pulse({ x: h.x, y: h.y });
        return false;
      }
      case "orderRejected":
        this.hud.alert(day, K.rejected(e.reason));
        this.hud.result(K.rejected(e.reason));
        return false;
      // -- K3: the economy's news ---------------------------------------------
      case "stocksChanged":
      case "taxSet":
        this.storesDirty = true;
        return false;
      case "claimed":
        this.storesDirty = true;
        this.hud.alert(day, E.claimed(name(e.holding)));
        return false;
      case "famine":
        this.storesDirty = true;
        if (e.holding === 0) this.hud.alert(day, e.days > 0 ? E.hungerBegins : E.hungerEnds);
        else this.hud.alert(day, e.days > 0 ? E.famineBegins(name(e.holding)) : E.famineEnds(name(e.holding)));
        return false;
      case "buildingStarted":
        this.hud.alert(day, E.buildingStarted({
          building: BUILDINGS[e.building as BuildingId].name, name: name(e.holding), days: BUILDINGS[e.building as BuildingId].days,
        }));
        return false;
      case "built":
        this.storesDirty = true;
        this.hud.alert(day, E.built({ building: BUILDINGS[e.building as BuildingId].name, name: name(e.holding) }));
        return false;
      case "upkeepUnpaid":
        this.hud.alert(day, E.upkeepUnpaid({ building: BUILDINGS[e.building as BuildingId].name, name: name(e.holding) }));
        return false;
      case "farmWeather":
        this.hud.alert(day, FARM_EVENT_LINE[e.event]);
        return false;
      case "plotStage": {
        const plot = w.holding(e.holding)?.plots.find((p) => p.id === e.plot);
        const crop = plot?.crop ? CROPS[plot.crop as CropId].name : "";
        if (e.stage === "ripe") this.hud.alert(day, E.ripe({ crop, name: name(e.holding) }));
        if (e.stage === "spoiled") {
          const cause = e.cause === "winter" ? E.causeWinter : e.cause === "overripe" ? E.causeOverripe : E.causeWeather;
          this.hud.alert(day, E.spoiled({ crop, name: name(e.holding), cause }));
        }
        return false;
      }
      case "harvested":
        this.hud.alert(day, E.harvestDone({ name: name(e.holding), gains: amountsLine(e.gains) }));
        return false;
      case "rallied":
        this.hud.alert(day, E.rallied({ n: e.followers, name: name(e.holding) }));
        return false;
      case "rallyDone":
        this.hud.alert(day, E.rallySpent(name(e.holding)));
        return false;
      case "foraged":
      case "taskSet":
        // Daily work is shown by the bar's numbers and the king card's "Doing", not the feed.
        return false;
    }
  }

  /** An order from a card or menu button (K3): to the queue, and say so. */
  issueFromUi(body: KingdomOrderBody, said: string): void {
    this.world.issue(body);
    this.hud.result(this.clock.run === "paused" ? E.queued(said) : said);
  }

  // -- saving -----------------------------------------------------------------

  save(): SaveOutcome {
    const out = saveKingdom(this.world, this.env.storage);
    this.lastSave = out;
    this.saves++;
    if (!out.ok) {
      this.saveFailing = true;
      this.hud.setNotice(K.notSaved(out.detail));
    } else if (this.saveFailing) {
      this.saveFailing = false;
      this.hud.setNotice(null);
      this.hud.alert(this.world.date.day, K.savedAgain);
    }
    return out;
  }

  private onPageHide = (): void => {
    if (this.phase === "live") this.save();
  };

  private onVisibility = (): void => {
    if (this.phase === "live" && this.env.doc.hidden) this.save();
  };

  // -- the pen ----------------------------------------------------------------

  /** Where the king is drawn this frame: between his last two tick positions. */
  kingDrawn(): MapPoint {
    const now = this.world.kingPosition();
    if (this.clock.run === "paused") return now;
    return lerp(this.prevKing, now, this.clock.carry);
  }

  /** The stroke's meaning NOW: the same call serves the preview and the commit. */
  interpret(points: readonly Point[]): KingdomIntent {
    const king = this.kingDrawn();
    return interpretStroke(points, kingdomContext(this.world, king, this.cam.pxToWorld), this.world, king);
  }

  private strokeChanged(points: readonly Point[]): void {
    this.intent = this.interpret(points);
    this.stroke = { points: points.slice(), style: this.intent.order ? "march" : this.intent.card ? "tap" : "none" };
  }

  private strokeEnded(points: readonly Point[]): void {
    const intent = this.interpret(points);
    this.intent = null;
    this.stroke = null;
    this.committed = intent;
    const style: InkStroke["style"] = intent.order ? "march" : intent.card ? "tap" : "none";
    if (style !== "tap") this.fades.push({ stroke: { points: points.slice(), style }, start: this.clockSeconds, duration: FADE_SECONDS });

    if (intent.order) {
      this.world.issue(intent.order);
      const m = intent.march;
      if (m && this.clock.run === "paused") this.hud.result(K.queuedOut({ name: m.name, eta: m.eta }));
      else this.hud.result(intent.message);
      if (intent.at) this.pulse(intent.at);
    } else if (intent.card) {
      // K3b: a second tap on the same holding of the king's, soon after the
      // first, goes into its city (the first opened its card, as ever).
      const c = intent.card;
      const last = this.lastTap;
      if (c.kind === "region" && last && last.holding === c.holding && this.clockSeconds - last.at <= DOUBLE_TAP_SECONDS &&
        this.world.holding(c.holding)?.owner === "king" && this.hooks.enterCity) {
        this.lastTap = null;
        this.requestCity(c.holding);
        return;
      }
      this.lastTap = c.kind === "region" ? { holding: c.holding, at: this.clockSeconds } : null;
      this.openCard(intent.card);
    } else {
      this.hud.result(intent.message);
    }
  }

  private strokeCancelled(): void {
    this.intent = null;
    this.stroke = null;
  }

  private pulse(at: MapPoint): void {
    if (this.reduced) return;
    this.pulses.push({ at, start: this.clockSeconds, duration: PULSE_SECONDS });
  }

  // -- cards ------------------------------------------------------------------

  openCard(req: KingdomCardRequest): void {
    // A second tap replaces the card rather than stacking another on it.
    if (this.card) this.closeCard();
    const hooks = {
      close: () => this.closeCard(),
      strokeInProgress: () => this.pen.drawing,
      halt: () => {
        this.world.issue({ kind: "haltKing" });
        this.hud.result(K.haltDone);
      },
      closed: () => { if (this.card === view) this.card = null; },
      enterCity: (id: number) => this.requestCity(id),
      issue: (body: KingdomOrderBody, said: string) => this.issueFromUi(body, said),
      economy: {
        issue: (body: KingdomOrderBody, said: string) => this.issueFromUi(body, said),
        openMenu: (s: Screen) => this.hooks.pushScreen(s),
        closeMenu: (s: Screen) => this.hooks.popScreen(s),
        menuRoot: this.hud.menuRoot,
      },
    };
    const root = this.hud.cardRoot;
    const view: CardView = req.kind === "king"
      ? kingCard(root, this.env.doc, this.world, hooks)
      : regionCard(root, this.env.doc, this.world, req.holding, hooks);
    this.card = view;
    this.hooks.pushScreen(view.screen);
  }

  closeCard(): void {
    const c = this.card;
    if (!c) return;
    this.hooks.popScreen(c.screen);
    this.card = null;
  }

  // -- K3b: the city layer below ------------------------------------------------

  /** Go into the city of a holding: only the king's own, and only where the app offers a city. */
  requestCity(id: number): void {
    const h = this.world.holding(id);
    if (!h || !this.hooks.enterCity || this.phase !== "live" || this.suspended) return;
    if (h.owner !== "king") {
      this.hud.result(C.notYours(h.name));
      return;
    }
    this.pen.cancelStroke();
    this.closeCard();
    this.hooks.enterCity(id, { x: this.cam.worldToScreenX(h.x), y: this.cam.worldToScreenY(h.y) });
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  /**
   * A city opens over the map: stop drawing the map and taking input, keep
   * the realm (its clock runs on through `advance`, called by the city), the
   * HUD, the autosave and the page listeners.
   */
  suspend(): void {
    if (this.phase !== "live" || this.suspended) return;
    this.suspended = true;
    this.env.win.cancelAnimationFrame(this.raf);
    this.pen.setEnabled(false);
    this.controls.setEnabled(false);
    this.zoomIn.setEnabled(false);
    this.closeCard();
    this.intent = null;
    this.stroke = null;
    this.lastTap = null;
    this.zoomBefore = this.cam.zoom;
    this.hud.root.classList.add("in-city");
  }

  /**
   * Back from the city of `holding`: the map again, its camera eased out from
   * the holding at the closest zoom (camera-systems: framing between layers),
   * or cut there under reduced motion.
   */
  resume(holding: number, said: string | null = null): void {
    if (this.phase !== "live" || !this.suspended) return;
    this.suspended = false;
    this.hud.root.classList.remove("in-city");
    const h = this.world.holding(holding);
    if (h) {
      const out = Math.min(this.zoomBefore || this.cam.zoom, this.cam.zoomForSpan(RETURN_MILES));
      if (this.reduced) this.cam.cut(h.x, h.y, out);
      else {
        this.cam.cut(h.x, h.y, this.cam.maxZoom);
        this.cam.flyTo(h.x, h.y, out, LAYER_SECONDS);
      }
      this.hud.result(said ?? C.left(h.name));
    }
    this.lastFrame = null;
    this.raf = this.env.win.requestAnimationFrame(this.frame);
  }

  // -- camera -----------------------------------------------------------------

  findKing(): void {
    const k = this.kingDrawn();
    if (this.reduced) this.cam.cut(k.x, k.y);
    else this.cam.flyTo(k.x, k.y, this.cam.zoom, FIND_KING_SECONDS);
  }

  // -- the loop ---------------------------------------------------------------

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

  /** Queued (not yet applied) march, as route points: what a paused order will do. */
  private queuedRoute(from: MapPoint): MapPoint[] {
    const q = this.world.orders.queued();
    for (let i = q.length - 1; i >= 0; i--) {
      const o = q[i];
      if (o.player !== KING_PLAYER) continue;
      if (o.kind === "haltKing") return [];
      if (o.kind === "moveKing") {
        const plan = this.world.planKingRoute(o.to);
        return plan ? routePoints(this.world, from, plan.route.nodes) : [];
      }
    }
    return [];
  }

  private frame = (now: number): void => {
    if (this.phase !== "live" || this.suspended) return;
    const dt = this.lastFrame === null ? 0 : Math.min(Math.max(0, (now - this.lastFrame) / 1000), MAX_FRAME_SECONDS);
    this.lastFrame = now;
    this.clockSeconds += dt;

    this.runTicks(this.clock.advance(dt, this.hooks.simHeld()));
    this.controls.update(dt);
    this.zoomIn.update(dt);
    this.cam.update(dt);

    const king = this.kingDrawn();
    const m = this.world.king.mover;
    const t = this.clockSeconds;
    this.fades = this.fades.filter((f) => t - f.start < f.duration);
    this.pulses = this.pulses.filter((p) => t - p.start < p.duration);
    const ghost = this.intent ? this.intent.ghost : null;
    const tip = this.stroke && this.stroke.points.length > 0 ? this.stroke.points[this.stroke.points.length - 1] : null;
    const queued = this.queuedRoute(king);
    this.renderer.draw({
      world: this.world,
      cam: this.cam,
      king,
      counter: kingCounterAt(king, this.cam.pxToWorld),
      route: m.route.length > 0 ? routePoints(this.world, king, m.route) : [],
      queued,
      stroke: this.stroke,
      ghost,
      tip,
      fades: this.fades,
      pulses: this.pulses,
      selectedHolding: this.card && this.card.kind === "region" ? this.card.holding : 0,
      kingSelected: this.card !== null && this.card.kind === "king",
      paused: this.clock.run === "paused",
      clock: t,
    });
    this.hud.setRun(this.clock.run, this.clock.speed);
    this.raf = this.env.win.requestAnimationFrame(this.frame);
  };
}
