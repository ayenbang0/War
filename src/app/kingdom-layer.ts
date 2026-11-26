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
import { E, K, WEATHER_LINE, amountsLine, dateLine } from "../content/kingdom/ui-strings.ts";
import { BUILDINGS, type BuildingId } from "../content/kingdom/buildings.ts";
import { CROPS, type CropId } from "../content/kingdom/crops.ts";
import type { KingdomOrderBody } from "../sim/kingdom/orders.ts";
import { KingdomCamera, OPENING_MILES } from "../render/kingdom/camera.ts";
import { KingdomRenderer, type Fade, type InkStroke, type Pulse } from "../render/kingdom/renderer.ts";
import { kingCounterAt, type MapPoint } from "../render/kingdom/layout.ts";
import { table as TABLE_COLOUR } from "../render/kingdom/palette.ts";
import { KingdomPen, type KingdomStrokeSink } from "../input/kingdom-pen.ts";
import { KingdomCameraControls } from "../input/kingdom-camera-controls.ts";
import {
  armyCounters, armyPointsOf, armyTitle, interpretStroke, kingdomContext, routePoints, type KingdomCardRequest, type KingdomIntent,
} from "../input/kingdom-commander.ts";
import type { ArmyDraw } from "../render/kingdom/renderer.ts";
import { armyCard } from "../ui/kingdom/army-card.ts";
import { AC } from "../content/kingdom/army-strings.ts";
import { ARMY_ORDINALS } from "../content/kingdom/armies.ts";
import { MERCENARIES } from "../content/kingdom/mercenaries.ts";
import { MERC_FEED } from "../content/kingdom/mercenary-strings.ts";
import { FACTIONS, FACTION_IDS } from "../content/kingdom/factions.ts";
import { armyById, armyFullMen, armyMen, armyWounded, supplyDays } from "../sim/kingdom/armies.ts";
import { UNIT_TYPES } from "../content/unit-types.ts";
import type { Point } from "../input/kingdom-gestures.ts";
import { KingdomHud } from "../ui/kingdom/hud.ts";
import { kingCard, regionCard, type CardView } from "../ui/kingdom/cards.ts";
import { KingdomClock, type KingdomSpeed } from "./kingdom-clock.ts";
import { ExploreUi } from "../ui/kingdom/explore-ui.ts";
import { holdingKnowledge, knowsHolding } from "../sim/kingdom/explore.ts";
import { KNOW_SEEN } from "../content/kingdom/exploration.ts";
import { X } from "../content/story/strings.ts";
import { ZoomThrough } from "../input/zoom-through.ts";
import { holdingAt } from "../input/kingdom-gestures.ts";
import { C } from "../content/kingdom/city-strings.ts";
import { saveKingdom, type SaveOutcome, type StorageLike } from "./kingdom-save.ts";
import { contactDialog } from "../ui/kingdom/contact-dialog.ts";
import type { ContactChoice } from "../sim/kingdom/orders.ts";
import type { Contact } from "../sim/kingdom/state.ts";
import type { BattleResult } from "../sim/layers.ts";
import { CONTACT_FEED } from "../content/kingdom/descent-strings.ts";
import { BAND_WORD, MORALE_FEED } from "../content/kingdom/morale-strings.ts";
import { ARMY_MORALE } from "../content/kingdom/morale.ts";
import { rumourCard, type RumourNews } from "../ui/kingdom/rumour-card.ts";
import { INVASION_FEED } from "../content/kingdom/invasion-strings.ts";

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
  /**
   * K5: the king chose to fight the contact that waits: go down a layer into
   * its battle. Without it (a harness with no battle layer) Fight resolves
   * the meeting as "resolve for me" does.
   */
  descend?(contact: Contact): void;
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

/** The king's armies are numbered on their counters. */
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

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
  /** K3a: the event card, the Finds list and exploration's feed lines. */
  readonly explore: ExploreUi;

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
  /** K4: every visible army's position before the last tick ran, for the same. */
  private prevArmies = new Map<number, MapPoint>();
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
  /** K5: the "fight or withdraw?" interstitial, while it is up. */
  private contactScreen: Screen | null = null;
  private readonly contactRoot: HTMLElement;
  /** K5: the contact last opened, for the feed's word on how it ended. */
  private lastContact: Contact | null = null;
  /** K5: the events of the last runTicks batch, for whoever settled a contact. */
  private batchEvents: KingdomEvent[] = [];
  /** K8: the rumour card, while it is up, and the rumours heard and not yet put to the king. */
  private rumourScreen: Screen | null = null;
  private readonly rumourRoot: HTMLElement;
  private rumoursWaiting: RumourNews[] = [];

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
    this.explore = new ExploreUi(env.doc, world, {
      pushScreen: (sc) => this.hooks.pushScreen(sc),
      popScreen: (sc) => this.hooks.popScreen(sc),
      alert: (text) => this.hud.alert(this.world.date.day, text),
      issue: (body, said) => this.issueFromUi(body, said),
    });
    this.explore.attach(this.hud.root);
    this.contactRoot = env.doc.createElement("div");
    this.contactRoot.className = "k-menu-backdrop k-event-backdrop";
    this.contactRoot.style.display = "none";
    this.hud.root.appendChild(this.contactRoot);
    this.rumourRoot = env.doc.createElement("div");
    this.rumourRoot.className = "k-menu-backdrop k-event-backdrop";
    this.rumourRoot.style.display = "none";
    this.hud.root.appendChild(this.rumourRoot);

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
    // K5: a meeting left undecided when the realm was saved asks again.
    if (this.world.contact) this.openContact();
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
    this.batchEvents = [];
    for (let i = 0; i < n; i++) {
      this.prevKing = this.world.kingPosition();
      this.prevArmies = armyPointsOf(this.world);
      const events = this.world.tick();
      this.batchEvents.push(...events);
      for (const e of events) if (this.onEvent(e)) dayTurned = true;
      // K5: a contact holds the realm; the rest of the batch would do nothing.
      if (this.world.contact) break;
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
    // K5: the realm has halted on a meeting: pause, save, and ask.
    if (this.world.contact && !this.contactScreen && !this.suspended && this.phase === "live") this.openContact();
    // K8: word of a host riding at the king's holdings: put it to him (a meeting first).
    else if (!this.world.contact) this.openRumour();
  }

  // -- K8: rumours ------------------------------------------------------------------

  /** Is the rumour card up? */
  get rumourOpen(): boolean {
    return this.rumourScreen !== null;
  }

  /**
   * Put the next rumour heard to the king, if none is up: the card holds the
   * clock while it is read. A rumour whose host has gone, turned aside or
   * arrived since it was heard (sim/kingdom/invasions.ts) is dropped unseen.
   */
  openRumour(): void {
    if (this.rumourScreen || this.contactScreen || this.suspended || this.phase !== "live") return;
    this.rumoursWaiting = this.rumoursWaiting.filter((n) => this.world.rumours.some((r) => r.army === n.army && r.target === n.target));
    const news = this.rumoursWaiting.shift();
    if (!news) return;
    this.pen.cancelStroke();
    this.intent = null;
    this.stroke = null;
    const view = rumourCard(this.rumourRoot, this.env.doc, this.world, news, this.rumoursWaiting.length, {
      close: (sc) => this.hooks.popScreen(sc),
      closed: () => {
        if (this.rumourScreen !== view) return;
        this.rumourScreen = null;
        // The next rumour, once the stack has settled.
        if (this.rumoursWaiting.length > 0) queueMicrotask(() => this.openRumour());
      },
      issue: (body, said) => this.issueFromUi(body, said),
    });
    this.rumourScreen = view;
    this.hooks.pushScreen(view);
  }

  // -- K5: contact --------------------------------------------------------------------

  /** Is the "fight or withdraw?" interstitial up? */
  get contactOpen(): boolean {
    return this.contactScreen !== null;
  }

  /**
   * The realm has halted on a meeting of the king's side: pause the clock
   * (it stays paused after: docs/PROVISIONAL.md K5.8), save -- so leaving now
   * and continuing asks again -- and put the question.
   */
  openContact(): void {
    const c = this.world.contact;
    if (!c || this.contactScreen || this.phase !== "live") return;
    if (this.clock.run !== "paused") this.togglePause();
    this.pen.cancelStroke();
    this.intent = null;
    this.stroke = null;
    this.closeCard();
    this.lastContact = c;
    this.save();
    const view = contactDialog(this.contactRoot, this.env.doc, this.world, {
      choose: (choice) => this.chooseContact(choice),
      close: (sc) => this.hooks.popScreen(sc),
      closed: () => { if (this.contactScreen === view) this.contactScreen = null; },
    });
    this.contactScreen = view;
    // The camera stays where the player left it: it never moves on its own (findKing's rule).
    this.hooks.pushScreen(view);
  }

  private chooseContact(choice: ContactChoice): void {
    const c = this.world.contact;
    if (!c) return;
    if (choice === "fight" && this.hooks.descend) {
      this.hooks.descend(c);
      return;
    }
    this.settle({ kind: "resolveContact", contact: c.id, choice: choice === "fight" ? "auto" : choice, result: null });
  }

  /**
   * Settle the waiting contact with this order, now: the held tick applies
   * it without moving the clock (sim/kingdom/world.ts). Saves, and returns
   * what the tick did, for the after-action report.
   */
  settle(body: Extract<KingdomOrderBody, { kind: "resolveContact" }>): KingdomEvent[] {
    this.world.issue(body);
    this.runTicks(1);
    const events = this.batchEvents;
    this.storesDirty = true;
    this.hud.resources.update(this.world);
    this.save();
    return events;
  }

  /** K5: a battle fought below has come back with its result. */
  settleBattle(result: BattleResult): KingdomEvent[] {
    const c = this.world.contact;
    if (!c || c.id !== result.contact) return [];
    return this.settle({ kind: "resolveContact", contact: c.id, choice: "fight", result });
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
        // K3a: a place not yet found has no name in the feed either.
        this.hud.alert(day, K.departed({ from: name(e.from), to: knowsHolding(w, KING_PLAYER, e.to) ? name(e.to) : X.unexplored }));
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
        // K8: captains take holdings too; theirs is said by its own line (seized, stormed).
        if (e.faction === KING_PLAYER) this.hud.alert(day, E.claimed(name(e.holding)));
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
      case "plotStage": {
        const plot = w.holding(e.holding)?.plots.find((p) => p.id === e.plot);
        const crop = plot?.crop ? CROPS[plot.crop as CropId].name : "";
        // ECON: a field reaped the day it ripens says so once, as its harvest (below).
        if (e.stage === "ripe" && plot?.stage === "ripe") this.hud.alert(day, E.ripe({ crop, name: name(e.holding) }));
        if (e.stage === "sown" && e.cause === "autoSown") this.hud.alert(day, E.autoSown({ crop, name: name(e.holding) }));
        // K8: a burned field has its own line (fieldsBurned).
        if (e.stage === "spoiled" && e.cause !== "burned") this.hud.alert(day, E.spoiled({ crop, name: name(e.holding), cause: E.lostCause(e.cause) }));
        return false;
      }
      case "autoSowSet":
        this.storesDirty = true;
        return false;
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
      // -- K3a: exploration (ui/kingdom/explore-ui.ts) --------------------------
      case "eventResolved":
      case "upgradeGained":
        this.storesDirty = true;
        this.explore.onEvent(e);
        return false;
      case "sighted":
      case "siteDiscovered":
      case "revealed":
        this.explore.onEvent(e);
        return false;
      // -- K4: armies ---------------------------------------------------------------
      default:
        return this.onArmyEvent(e);
    }
  }

  /** K4: an army's news, said in the feed when it is the king's or one his scouts see. */
  private onArmyEvent(e: KingdomEvent): boolean {
    const w = this.world;
    const day = w.date.day;
    const name = (id: number): string => w.holding(id)?.name ?? "?";
    const army = (id: number): string => armyById(w, id)?.name ?? "army";
    const mine = (id: number): boolean => armyById(w, id)?.owner === KING_PLAYER;
    switch (e.kind) {
      case "armyRaised":
        this.storesDirty = true;
        if (e.owner === KING_PLAYER) this.hud.alert(day, AC.armyRaised(army(e.army), name(e.at)));
        return false;
      case "recruited":
        this.storesDirty = true;
        if (mine(e.army)) this.hud.alert(day, AC.recruited({ unit: UNIT_TYPES[e.unit].name, men: e.men, army: army(e.army) }));
        return false;
      case "armyArrived":
        if (mine(e.army) && e.destination && e.army !== w.king.army) {
          this.hud.alert(day, AC.arrived({ army: army(e.army), name: name(e.at) }));
          const h = w.holding(e.at);
          if (h) this.pulse({ x: h.x, y: h.y });
        }
        return false;
      case "armySplit":
        if (mine(e.army)) this.hud.alert(day, AC.splitNews({ army: army(e.army), into: army(e.into) }));
        return false;
      case "armiesMerged":
        this.storesDirty = true;
        if (e.owner === KING_PLAYER) this.hud.alert(day, AC.mergedNews({ army: e.name, into: army(e.into) }));
        if (this.card?.kind === "army" && this.card.army === e.army) this.card.refresh();
        return false;
      case "armyGone":
        this.storesDirty = true;
        // K7: a free company's leaving is told once, by its own line (companyLeft).
        if (e.owner === KING_PLAYER && !w.events.some((x) => x.kind === "companyLeft" && x.army === e.army)) {
          this.hud.alert(day, AC.armyGone[e.reason](e.name));
        }
        return false;
      case "intercepted": {
        const t = armyById(w, e.target);
        if (mine(e.army)) this.hud.alert(day, AC.intercepted({ army: army(e.army), target: t ? armyTitle(t) : "?" }));
        return false;
      }
      case "wagesLate":
        this.storesDirty = true;
        if (mine(e.army) && e.days === 1) this.hud.alert(day, AC.unpaid(army(e.army)));
        return false;
      case "armyDay":
        this.storesDirty = true;
        // Said once, on the first day men leave for hunger (the card shows the rest).
        if (e.owner === KING_PLAYER && e.short > 0 && e.deserted + e.died > 0 && !this.hungerSaid.has(e.army)) {
          this.hungerSaid.add(e.army);
          this.hud.alert(day, AC.hungry(army(e.army)));
        }
        if (e.short === 0) this.hungerSaid.delete(e.army);
        if ((armyById(w, e.army)?.morale ?? 100) >= ARMY_MORALE.desertBelow) this.spiritSaid.delete(e.army);
        return false;
      case "followersDeserted":
        this.storesDirty = true;
        if (e.faction === KING_PLAYER) this.hud.alert(day, AC.followersLeft(e.n));
        return false;
      case "kingJoined":
        this.hud.alert(day, e.army ? AC.kingRidesWith(army(e.army)) : AC.kingAlone);
        return false;
      // -- K5 ----------------------------------------------------------------------
      case "contact": {
        const c = w.contact;
        if (!e.player || !c) return false;
        const ours = army(c.sides[0].army);
        const t = armyById(w, c.sides[1].army);
        this.hud.alert(day, c.kind === "assault" ? CONTACT_FEED.walls({ ours, place: name(c.holding) })
          : CONTACT_FEED.met({ ours, theirs: t ? armyTitle(t) : "?" }));
        return false;
      }
      case "contactResolved": {
        const c = this.lastContact;
        if (!c || c.id !== e.contact) return false;
        const ours = armyById(w, c.sides[0].army)?.name ?? "army";
        this.storesDirty = true;
        this.hud.alert(day, e.how === "withdraw" ? CONTACT_FEED.withdrew(ours)
          : e.winner === 0 ? CONTACT_FEED.won(ours) : e.winner === 1 ? CONTACT_FEED.lost(ours) : CONTACT_FEED.drawn(ours));
        this.lastContact = null;
        return false;
      }
      case "fellBack":
        if (mine(e.army)) this.hud.alert(day, CONTACT_FEED.fellBack({ army: army(e.army), to: name(e.to) }));
        return false;
      case "stormed":
        this.storesDirty = true;
        // K8: captains storm each other's towns too; the king hears of what his men see, or his own.
        if (this.lastContact?.holding !== e.holding && holdingKnowledge(w, KING_PLAYER, e.holding) !== KNOW_SEEN) return false;
        this.hud.alert(day, CONTACT_FEED.stormed({ name: name(e.holding), by: FACTIONS[FACTION_IDS[e.faction]]?.name ?? "?" }));
        return false;
      case "armyDeparted":
      case "armyPosture":
      case "doctrineSet":
      case "abilityUnlocked":
        // Said by the result line of the order that caused it; the card shows the state.
        this.storesDirty = true;
        return false;
      default:
        return this.onMoraleEvent(e);
    }
  }

  /** K6: unrest, revolts, the levers, Mercy/Terror and broken spirits. */
  private onMoraleEvent(e: KingdomEvent): boolean {
    const w = this.world;
    const day = w.date.day;
    const name = (id: number): string => w.holding(id)?.name ?? "?";
    switch (e.kind) {
      case "unrestBand":
        if (w.holding(e.holding)?.owner === "king" && e.band !== "revolt") {
          this.hud.alert(day, MORALE_FEED.band({ name: name(e.holding), band: BAND_WORD[e.band], rising: e.rising }));
        }
        return false;
      case "revolt":
        this.storesDirty = true;
        if (e.from === KING_PLAYER) this.hud.alert(day, MORALE_FEED.revolt({ name: name(e.holding), rebels: e.rebels }));
        return false;
      case "festivalOver":
        if (w.holding(e.holding)?.owner === "king") this.hud.alert(day, MORALE_FEED.festivalOver(name(e.holding)));
        return false;
      case "justiceSet":
      case "festivalHeld":
      case "pardoned":
      case "mercyChanged":
        // The order's own result line said it; the bar and the card show the state.
        this.storesDirty = true;
        return false;
      case "moraleDesertion": {
        const a = armyById(w, e.army);
        if (a && a.owner === KING_PLAYER && !this.spiritSaid.has(e.army)) {
          this.spiritSaid.add(e.army);
          this.hud.alert(day, MORALE_FEED.desertion({ army: a.name, n: e.n }));
        }
        return false;
      }
      default:
        return this.onMercenaryEvent(e);
    }
  }

  /** K7: the free companies -- offers at the taverns, contracts, bids, leavings. */
  private onMercenaryEvent(e: KingdomEvent): boolean {
    const w = this.world;
    const day = w.date.day;
    const company = (i: number): string => MERCENARIES[i]?.name ?? "?";
    switch (e.kind) {
      case "companyOffered":
        this.hud.alert(day, MERC_FEED.offered({ name: company(e.company), holding: w.holding(e.at)?.name ?? "?" }));
        return false;
      case "companyMovedOn":
        this.hud.alert(day, MERC_FEED.offerGone(company(e.company)));
        return false;
      case "companyHired":
      case "contractRenewed":
      case "bidMatched":
        // The order's own result line said it; the bar and the army card show the state.
        this.storesDirty = true;
        return false;
      case "contractEnding":
        this.hud.alert(day, MERC_FEED.ending({ name: company(e.company), left: e.days }));
        return false;
      case "companyBid":
        this.hud.alert(day, MERC_FEED.bid({ name: company(e.company), bid: e.bid }));
        return false;
      case "companyLeft":
        this.storesDirty = true;
        if (e.how !== "dismissed") this.hud.alert(day, MERC_FEED.left[e.how](company(e.company)));
        if (this.card?.kind === "army" && this.card.army === e.army) this.card.refresh();
        return false;
      default:
        return this.onInvasionEvent(e);
    }
  }

  /** K8: rumours, the defence tools, and holdings taken. */
  private onInvasionEvent(e: KingdomEvent): boolean {
    const w = this.world;
    const day = w.date.day;
    const name = (id: number): string => w.holding(id)?.name ?? "?";
    const faction = (f: number): string => FACTIONS[FACTION_IDS[f]]?.name ?? "?";
    switch (e.kind) {
      case "rumour":
        this.hud.alert(day, INVASION_FEED.rumour({ theirs: faction(e.owner), target: name(e.target), days: e.days }));
        this.rumoursWaiting.push({ army: e.army, owner: e.owner, target: e.target, from: e.from, days: e.days });
        return false;
      case "levyCalled":
        this.storesDirty = true;
        this.hud.alert(day, INVASION_FEED.levied({ place: name(e.holding), men: e.men }));
        return false;
      case "fieldsBurned":
        this.hud.alert(day, INVASION_FEED.burned(name(e.holding)));
        return false;
      case "seized":
        this.storesDirty = true;
        // Said when it was the king's, or the king can see it.
        if (e.from === KING_PLAYER || holdingKnowledge(w, KING_PLAYER, e.holding) === KNOW_SEEN) {
          this.hud.alert(day, INVASION_FEED.seized({ place: name(e.holding), by: faction(e.faction) }));
        }
        return false;
      case "yielded":
        this.storesDirty = true;
        this.hud.alert(day, INVASION_FEED.yielded({ place: name(e.holding), by: faction(e.faction) }));
        return false;
      case "siege":
        this.storesDirty = true;
        this.hud.alert(day, INVASION_FEED.siege({ place: name(e.holding), held: e.held }));
        return false;
      case "waveRode":
        this.hud.alert(day, INVASION_FEED.wave(faction(e.faction)));
        return false;
      default:
        return false;
    }
  }

  /** K6: armies whose broken spirit has been said, until it mends (see armyDay). */
  private spiritSaid = new Set<number>();

  /** K4: armies whose hunger has been said, until they eat again. */
  private hungerSaid = new Set<number>();

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

  /** K4: where each visible army is drawn this frame, between its last two tick positions. */
  armiesDrawn(): Map<number, MapPoint> {
    const now = armyPointsOf(this.world);
    if (this.clock.run === "paused") return now;
    const out = new Map<number, MapPoint>();
    for (const [id, p] of now) {
      const prev = this.prevArmies.get(id);
      out.set(id, prev ? lerp(prev, p, this.clock.carry) : p);
    }
    return out;
  }

  /** The stroke's meaning NOW: the same call serves the preview and the commit. */
  interpret(points: readonly Point[]): KingdomIntent {
    const king = this.kingDrawn();
    const armies = this.armiesDrawn();
    return interpretStroke(points, kingdomContext(this.world, king, this.cam.pxToWorld, armies), this.world, king, armies);
  }

  /** K4: what the renderer draws for each visible army (the pen reads the same counters). */
  private armyDraws(points: Map<number, MapPoint>): ArmyDraw[] {
    const w = this.world;
    const selected = this.card && this.card.kind === "army" ? this.card.army ?? 0 : 0;
    return armyCounters(w, points, this.cam.pxToWorld).map(({ army: a, at, counter }) => {
      const own = a.owner === KING_PLAYER;
      const ordinal = ARMY_ORDINALS.findIndex((o) => a.name.startsWith(o + " "));
      const full = armyFullMen(a);
      const f = FACTIONS[FACTION_IDS[a.owner]];
      return {
        id: a.id,
        own,
        // K7: a free company's counter carries its name's initial, not a number.
        mark: own ? (a.company > 0 ? a.name.charAt(0).toUpperCase() : ROMAN[ordinal] ?? String(ordinal + 1)) : (f ? f.name.replace(/^the /, "").charAt(0).toUpperCase() : "?"),
        at,
        counter,
        men: own ? armyMen(a) : Math.max(10, Math.round(armyMen(a) / 10) * 10),
        about: !own,
        kingRides: w.king.army === a.id,
        strengthPct: full > 0 ? Math.round(((armyMen(a) - armyWounded(a)) * 100) / full) : 0,
        supplyDays: own ? supplyDays(a) : -1,
        hungry: own && a.hunger > 0,
        posture: a.posture,
        route: own && a.mover.route.length > 0 ? routePoints(w, at, a.mover.route) : [],
        selected: a.id === selected,
      };
    });
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
      : req.kind === "army"
        ? armyCard(root, this.env.doc, this.world, req.army, hooks)
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
  suspend(below: "city" | "battle" = "city"): void {
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
    // Under a city the kingdom HUD stays over the town; under a battle the stack hides it.
    if (below === "city") this.hud.root.classList.add("in-city");
  }

  /**
   * Back from the city of `holding`: the map again, its camera eased out from
   * the holding at the closest zoom (camera-systems: framing between layers),
   * or cut there under reduced motion.
   */
  resume(holding: number, said: string | null = null): void {
    const h = this.world.holding(holding);
    this.resumeAt(h ? { x: h.x, y: h.y } : null, h ? said ?? C.left(h.name) : null);
  }

  /**
   * Back up from a layer below -- a city (resume), or K5's battle, which
   * comes back to the point the armies met: the map again, its camera eased
   * out from that point at the closest zoom (camera-systems: framing between
   * layers), or cut there under reduced motion.
   */
  resumeAt(at: MapPoint | null, said: string | null = null): void {
    if (this.phase !== "live" || !this.suspended) return;
    this.suspended = false;
    this.hud.root.classList.remove("in-city");
    if (at) {
      const out = Math.min(this.zoomBefore || this.cam.zoom, this.cam.zoomForSpan(RETURN_MILES));
      if (this.reduced) this.cam.cut(at.x, at.y, out);
      else {
        this.cam.cut(at.x, at.y, this.cam.maxZoom);
        this.cam.flyTo(at.x, at.y, out, LAYER_SECONDS);
      }
    }
    if (said) this.hud.result(said);
    this.hud.resources.update(this.world);
    this.hud.setRun(this.clock.run, this.clock.speed);
    this.lastFrame = null;
    this.raf = this.env.win.requestAnimationFrame(this.frame);
    // A meeting still waiting (the battle was left without a result) asks again.
    if (this.world.contact) this.openContact();
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
    const armies = this.armyDraws(this.armiesDrawn());
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
      armies,
      paused: this.clock.run === "paused",
      clock: t,
    });
    this.hud.setRun(this.clock.run, this.clock.speed);
    this.raf = this.env.win.requestAnimationFrame(this.frame);
  };
}
