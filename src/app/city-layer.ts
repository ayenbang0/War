/**
 * The city layer (K3b; PLAN.md §B.1's "zoom down a level"; docs/audit/
 * u2-city-view.md): one holding of the king's, seen as a town plan, where its
 * lots are built on, its fields sown and reaped, and its tax set.
 *
 * A VIEW OF THE SAME REALM. The city has no world of its own: it reads the
 * kingdom's KingdomWorld and issues the K3 orders (build, sow, harvest,
 * setTax) into its queue. The realm's clock keeps running while the city is
 * open -- the city's frame calls `realm.advance(dt)`, which is the map's own
 * clock, tick loop, autosave and HUD -- so pause, speed, the date and the
 * alerts stay where they were, on the kingdom HUD over the city.
 *
 * While the city is live the kingdom layer is SUSPENDED: it does not draw or
 * take input, but it is not torn down. Leaving the city resumes it, eased out
 * from the holding (instant under reduced motion).
 *
 * The pen is the left button, as everywhere: a TAP picks a lot, a field or
 * the square (politics). Anything longer than a tap is said to be a map
 * gesture and does nothing here. The camera is the kingdom's camera class over
 * the plan (middle/right drag, wheel, keys); wheeling out past its widest zoom
 * goes back up to the map (input/zoom-through.ts), as do Esc and the panel's
 * Leave button.
 */

import type { InputContext, KeyInput, KeyVerdict, Screen } from "../ui/screen-stack.ts";
import type { KingdomOrderBody } from "../sim/kingdom/orders.ts";
import type { Holding } from "../sim/kingdom/state.ts";
import type { KingdomWorld } from "../sim/kingdom/world.ts";
import { KingdomCamera } from "../render/kingdom/camera.ts";
import { KingdomCameraControls } from "../input/kingdom-camera-controls.ts";
import { KingdomPen, type KingdomStrokeSink } from "../input/kingdom-pen.ts";
import { TAP_TOLERANCE, tolerance, type Point } from "../input/kingdom-gestures.ts";
import { ZoomThrough } from "../input/zoom-through.ts";
import { CityRenderer, type CityInk, type CityPulse } from "../render/city/renderer.ts";
import { pickAt, planFor, type CityPick, type CityPlan } from "../render/city/layout.ts";
import { CityPanel, type CityOpen } from "../ui/city/panel.ts";
import { fieldCard, lotCard, politicsCard, type CityCardHooks, type CityCardView } from "../ui/city/cards.ts";
import { C } from "../content/kingdom/city-strings.ts";
import { AUTO_SOW_DEFAULT } from "../content/kingdom/economy.ts";
import { reducedMotion, type KingdomLayer } from "./kingdom-layer.ts";

export type CityEnv = {
  readonly win: Window;
  readonly doc: Document;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
};

export type CityHooks = {
  /** Esc with nothing to close, Leave, or zooming out past the town: back to the map. */
  requestLeave(): void;
  pushScreen(s: Screen): void;
  /** Pop `s` if it is on top. */
  popScreen(s: Screen): void;
};

export type CityPhase = "built" | "live" | "torn-down";

/** Longest frame step: a tab that slept resumes, it does not leap. */
const MAX_FRAME_SECONDS = 0.25;
/** The zoom-in from the holding's place on the map (camera-systems: layer transition). */
const INTRO_SECONDS = 0.45;
const INTRO_SCALE = 0.12;
const FADE_SECONDS = 0.6;
const PULSE_SECONDS = 0.9;
/** Hit tolerance round a lot or field, in screen pixels. */
const PICK_PX = 8;
/** The zoom-out key held at the widest zoom this long goes back to the map. */
const HOLD_OUT_SECONDS = 0.6;
const OUT_KEYS: ReadonlySet<string> = new Set(["Minus", "NumpadSubtract"]);

function pathLength(pts: readonly Point[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return d;
}

export class CityLayer {
  readonly kind = "city" as const;
  phase: CityPhase = "built";
  readonly realm: KingdomLayer;
  readonly world: KingdomWorld;
  /** The holding this city is. */
  readonly holding: number;
  plan: CityPlan;
  readonly cam: KingdomCamera;
  readonly renderer: CityRenderer;
  readonly panel: CityPanel;
  /** The city's place on the stack: an overlay above the kingdom's, so the kingdom HUD stays. */
  readonly screen: Screen;
  card: CityCardView | null = null;
  /** The last thing the pen said, for the tests. */
  lastPick: CityPick | null = null;

  private readonly env: CityEnv;
  private readonly hooks: CityHooks;
  private readonly pen: KingdomPen;
  private readonly controls: KingdomCameraControls;
  private readonly zoomOut: ZoomThrough;
  private readonly panelRoot: HTMLElement;
  private readonly reduced: boolean;
  private readonly from: Point;
  private raf = 0;
  private lastFrame: number | null = null;
  private clockSeconds = 0;
  private introT = 1;
  private stroke: Point[] | null = null;
  private fades: CityInk[] = [];
  private pulses: CityPulse[] = [];
  private hover: CityPick | null = null;
  private outHeld = new Set<string>();
  private outHold = 0;
  private oldCanvasLabel: string | null = null;
  private leaving = false;
  /** Why the city closed, when it was not the player's choice: the map's result line says it. */
  leftWith: string | null = null;

  constructor(realm: KingdomLayer, holding: number, env: CityEnv, hooks: CityHooks, from: Point) {
    const h = realm.world.holding(holding);
    if (!h) throw new Error("no holding " + holding);
    this.realm = realm;
    this.world = realm.world;
    this.holding = holding;
    this.env = env;
    this.hooks = hooks;
    this.from = from;
    this.reduced = reducedMotion(env.win);
    this.plan = planFor(this.world, holding);
    this.cam = new KingdomCamera(this.plan.width, this.plan.height);
    this.renderer = new CityRenderer(env.ctx, env.doc);

    this.panelRoot = env.doc.createElement("aside");
    this.panelRoot.className = "c-panel";
    this.panelRoot.style.display = "none";
    this.panel = new CityPanel(this.panelRoot, env.doc, this.world, h, {
      lot: (i) => this.openLot(i),
      field: (i) => this.openField(i),
      politics: () => this.openPolitics(),
      leave: () => this.leave(),
      // ECON: the realm's switch -- on resows every field with the realm's crop (rye unless one was chosen).
      resowAll: (on) => this.issue(
        { kind: "setAutoSow", holding: 0, plot: 0, crop: on ? AUTO_SOW_DEFAULT : null }, C.resowAllSaid(on)),
    });

    const sink: KingdomStrokeSink = {
      strokeChanged: (pts) => { this.stroke = pts.slice(); },
      strokeEnded: (pts) => this.strokeEnded(pts),
      strokeCancelled: () => { this.stroke = null; },
    };
    this.pen = new KingdomPen(env.canvas, this.cam, sink);
    // Before the camera's controls: it must see whether the camera was
    // already at its widest before this notch of the wheel.
    this.zoomOut = new ZoomThrough(env.canvas, {
      direction: "out",
      atLimit: () => this.cam.zoom <= this.cam.minZoom + 1e-9,
      target: () => this.holding,
      through: () => this.leave(),
    });
    this.controls = new KingdomCameraControls(env.canvas, this.cam, !this.reduced);
    this.pen.setEnabled(false);
    this.controls.setEnabled(false);
    this.zoomOut.setEnabled(false);

    const panelRoot = this.panelRoot;
    this.screen = {
      name: "city",
      kind: "overlay",
      trapsFocus: false,
      pausesSim: false,
      inputs: ["pen", "camera", "ui"],
      firstFocus: () => this.panel.heading,
      mount: () => { /* started by the app before the push */ },
      unmount: () => this.onUnmount?.(),
      setVisible: (v) => { panelRoot.style.display = v ? "flex" : "none"; },
      // Inert follows the input contexts (setContexts), not "under the top":
      // a lot card over the panel leaves it usable, a menu does not.
      setInert: () => { /* see setContexts */ },
      revealed: () => this.panel.refresh(),
    };
  }

  /** Set by the app: the city screen left the stack, however that happened. */
  onUnmount: (() => void) | null = null;

  get holdingState(): Holding {
    return this.world.holding(this.holding) as Holding;
  }

  // -- life -------------------------------------------------------------------

  start(): void {
    if (this.phase !== "built") throw new Error("city already started");
    this.phase = "live";
    const { win, canvas } = this.env;
    this.realm.hud.root.appendChild(this.panelRoot);
    this.panelRoot.style.display = "flex";
    this.panel.refresh();
    this.oldCanvasLabel = canvas.getAttribute("aria-label");
    const h = this.holdingState;
    canvas.setAttribute("aria-label", C.canvasLabel(h.name));
    win.addEventListener("resize", this.resize);
    canvas.addEventListener("pointermove", this.onHover);
    canvas.addEventListener("pointerleave", this.onHoverOut);
    this.resize();
    this.frameTown();
    this.introT = this.reduced ? 1 : 0;
    this.realm.hud.result(C.entered(h.name));
    this.raf = win.requestAnimationFrame(this.frame);
  }

  teardown(): void {
    if (this.phase === "torn-down") return;
    this.phase = "torn-down";
    const { win, canvas } = this.env;
    win.cancelAnimationFrame(this.raf);
    win.removeEventListener("resize", this.resize);
    canvas.removeEventListener("pointermove", this.onHover);
    canvas.removeEventListener("pointerleave", this.onHoverOut);
    if (this.card) this.closeCard();
    this.pen.dispose();
    this.zoomOut.dispose();
    this.controls.dispose();
    this.panelRoot.parentNode?.removeChild(this.panelRoot);
    if (this.oldCanvasLabel === null) canvas.removeAttribute("aria-label");
    else canvas.setAttribute("aria-label", this.oldCanvasLabel);
  }

  /** Go back up to the map (the app pops the city screen, which tears this down). */
  leave(): void {
    if (this.phase !== "live" || this.leaving) return;
    this.leaving = true;
    this.hooks.requestLeave();
  }

  setContexts(contexts: readonly InputContext[]): void {
    if (this.phase !== "live") return;
    const pen = contexts.includes("pen");
    const camera = contexts.includes("camera");
    this.pen.setEnabled(pen);
    this.controls.setEnabled(camera);
    this.zoomOut.setEnabled(camera);
    this.panel.setLive(pen);
    this.realm.hud.setLive(pen);
    if (!camera) this.outHeld.clear();
  }

  // -- keys -------------------------------------------------------------------

  keyDown(k: KeyInput, contexts: readonly InputContext[]): KeyVerdict {
    if (this.phase !== "live") return "pass";
    const pen = contexts.includes("pen");
    switch (k.code) {
      case "Escape":
        if (k.repeat) return "handled";
        // One owner per press: a stroke first, then leaving. (A card or menu,
        // when open, is on top of the stack and saw Esc before us.)
        if (pen && this.pen.cancelStroke()) {
          this.realm.hud.result("Stroke cancelled.");
          return "handled";
        }
        this.leave();
        return "handled";
      case "Space":
        k.preventDefault();
        if (!k.repeat) this.realm.togglePause();
        return "handled";
      case "Period":
      case "NumpadDecimal":
        if (k.repeat) return "handled";
        this.realm.stepDay();
        this.refreshUi();
        return "handled";
      case "Digit1": case "Numpad1":
        if (!k.repeat) this.realm.setSpeed(1);
        return "handled";
      case "Digit2": case "Numpad2":
        if (!k.repeat) this.realm.setSpeed(2);
        return "handled";
      case "Digit3": case "Numpad3":
        if (!k.repeat) this.realm.setSpeed(4);
        return "handled";
      case "KeyP":
        if (!k.repeat && pen) this.openPolitics();
        return "handled";
      case "KeyF":
        if (!k.repeat) {
          this.frameTown(!this.reduced);
          this.realm.hud.result(C.framed);
        }
        return "handled";
    }
    if (contexts.includes("camera") && this.controls.keyDown(k.code)) {
      if (OUT_KEYS.has(k.code)) this.outHeld.add(k.code);
      return "handled";
    }
    return "pass";
  }

  keyUp(code: string): void {
    this.controls.keyUp(code);
    this.outHeld.delete(code);
    if (this.outHeld.size === 0) this.outHold = 0;
  }

  releaseAll(): void {
    this.controls.releaseAll();
    this.outHeld.clear();
    this.outHold = 0;
  }

  // -- the pen ----------------------------------------------------------------

  private strokeEnded(pts: readonly Point[]): void {
    this.stroke = null;
    if (pts.length === 0) return;
    const px = this.cam.pxToWorld;
    const tap = tolerance(TAP_TOLERANCE.miles, TAP_TOLERANCE.minPx, TAP_TOLERANCE.maxPx, px);
    if (pathLength(pts) > tap) {
      this.fades.push({ points: pts.slice(), start: this.clockSeconds, duration: FADE_SECONDS });
      this.realm.hud.result(C.lineInCity);
      return;
    }
    const a = pts[0];
    const b = pts[pts.length - 1];
    this.tapAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }

  /** A tap at a plan point: the lot, field or square there. Public for the tests. */
  tapAt(p: Point): CityPick | null {
    const pick = pickAt(this.plan, p, PICK_PX * this.cam.pxToWorld);
    this.lastPick = pick;
    if (!pick) {
      this.realm.hud.result(C.tapNothing);
      return null;
    }
    this.pulses.push({ at: p, start: this.clockSeconds, duration: PULSE_SECONDS });
    if (pick.kind === "lot") this.openLot(pick.index);
    else if (pick.kind === "field") this.openField(pick.index);
    else this.openPolitics();
    return pick;
  }

  /** The plan point at the middle of a lot or field, for the tests and the e2e. */
  placeOf(kind: "lot" | "field", index: number): Point | null {
    if (kind === "lot") {
      const l = this.plan.lots.find((x) => x.index === index);
      return l ? { x: l.x, y: l.y } : null;
    }
    const f = this.plan.fields.find((x) => x.index === index);
    return f ? { x: f.cx, y: f.cy } : null;
  }

  // -- cards ------------------------------------------------------------------

  private cardHooks(): CityCardHooks {
    const hooks: CityCardHooks = {
      close: () => this.closeCard(),
      strokeInProgress: () => this.pen.drawing,
      closed: () => {
        this.card = null;
        this.panel.setOpen(null);
      },
      issue: (body: KingdomOrderBody, said: string) => this.issue(body, said),
      economy: {
        issue: (body: KingdomOrderBody, said: string) => this.issue(body, said),
        openMenu: (s: Screen) => this.hooks.pushScreen(s),
        closeMenu: (s: Screen) => this.hooks.popScreen(s),
        menuRoot: this.realm.hud.menuRoot,
      },
    };
    return hooks;
  }

  private show(view: CityCardView, open: CityOpen): void {
    if (this.card) this.closeCard();
    this.card = view;
    this.hooks.pushScreen(view.screen);
    this.panel.setOpen(open);
  }

  openLot(index: number): void {
    if (this.phase !== "live" || index < 0 || index >= this.holdingState.buildings.length) return;
    const root = this.realm.hud.cardRoot;
    this.show(lotCard(root, this.env.doc, this.world, this.holding, index, this.cardHooks()), { kind: "lot", index });
  }

  openField(index: number): void {
    if (this.phase !== "live" || index < 0 || index >= this.holdingState.plots.length) return;
    const root = this.realm.hud.cardRoot;
    this.show(fieldCard(root, this.env.doc, this.world, this.holding, index, this.cardHooks()), { kind: "field", index });
  }

  openPolitics(): void {
    if (this.phase !== "live") return;
    const root = this.realm.hud.cardRoot;
    this.show(politicsCard(root, this.env.doc, this.world, this.holding, this.cardHooks()), { kind: "politics" });
  }

  closeCard(): void {
    const c = this.card;
    if (!c) return;
    this.card = null;
    this.hooks.popScreen(c.screen);
    this.panel.setOpen(null);
  }

  private issue(body: KingdomOrderBody, said: string): void {
    this.realm.issueFromUi(body, said);
    const at = this.orderPlace(body);
    if (at) this.pulses.push({ at, start: this.clockSeconds, duration: PULSE_SECONDS });
  }

  /** Where on the plan an order lands, for its pulse. */
  private orderPlace(body: KingdomOrderBody): Point | null {
    const h = this.holdingState;
    if (body.kind === "build") {
      const next = h.buildings.indexOf(null);
      return next >= 0 ? this.placeOf("lot", next) : null;
    }
    if (body.kind === "sow" || body.kind === "harvest") {
      const i = h.plots.findIndex((p) => p.id === body.plot);
      return i >= 0 ? this.placeOf("field", i) : null;
    }
    if (body.kind === "setTax") return { x: this.plan.square.x, y: this.plan.square.y };
    return null;
  }

  // -- camera -----------------------------------------------------------------

  /** The whole town in the window. */
  frameTown(ease = false): void {
    const { x, y } = this.plan.centre;
    if (ease) this.cam.flyTo(x, y, this.cam.minZoom, INTRO_SECONDS);
    else this.cam.cut(x, y, this.cam.minZoom);
  }

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

  private onHover = (e: PointerEvent): void => {
    if (this.phase !== "live") return;
    const p = { x: this.cam.screenToWorldX(e.clientX), y: this.cam.screenToWorldY(e.clientY) };
    this.hover = pickAt(this.plan, p, PICK_PX * this.cam.pxToWorld);
  };

  private onHoverOut = (): void => {
    this.hover = null;
  };

  // -- the frame --------------------------------------------------------------

  private refreshUi(): void {
    this.panel.refresh();
    this.card?.refresh();
  }

  private frame = (now: number): void => {
    if (this.phase !== "live") return;
    const dt = this.lastFrame === null ? 0 : Math.min(Math.max(0, (now - this.lastFrame) / 1000), MAX_FRAME_SECONDS);
    this.lastFrame = now;
    this.clockSeconds += dt;

    // The realm's time, as on the map.
    const ticks = this.realm.advance(dt);
    if (this.phase !== "live") return; // the realm's events may have ended things
    const h = this.holdingState;
    if (h.owner !== "king") {
      // Lost while we were inside: back to the map, and say why.
      this.leftWith = C.lost(h.name);
      this.leave();
      return;
    }
    if (h.buildings.length !== this.plan.lots.length || h.plots.length !== this.plan.fields.length) {
      this.plan = planFor(this.world, this.holding);
    }
    if (ticks > 0) this.refreshUi();

    this.controls.update(dt);
    this.zoomOut.update(dt);
    this.cam.update(dt);
    if (this.outHeld.size > 0 && this.cam.zoom <= this.cam.minZoom + 1e-9) {
      this.outHold += dt;
      if (this.outHold >= HOLD_OUT_SECONDS) {
        this.leave();
        return;
      }
    } else this.outHold = 0;

    if (this.introT < 1) this.introT = Math.min(1, this.introT + dt / INTRO_SECONDS);
    const t = this.clockSeconds;
    this.fades = this.fades.filter((f) => t - f.start < f.duration);
    this.pulses = this.pulses.filter((p) => t - p.start < p.duration);
    const e = 1 - Math.pow(1 - this.introT, 3);
    const c = this.card;
    this.renderer.draw({
      world: this.world,
      holding: h,
      plan: this.plan,
      cam: this.cam,
      selected: c ? (c.kind === "politics" ? { kind: "square" } : { kind: c.kind, index: c.index }) : null,
      hover: this.hover,
      stroke: this.stroke,
      fades: this.fades,
      pulses: this.pulses,
      clock: t,
      intro: this.introT < 1
        ? { x: this.from.x, y: this.from.y, scale: INTRO_SCALE + (1 - INTRO_SCALE) * e, alpha: 0.35 + 0.65 * e }
        : null,
    });
    this.raf = this.env.win.requestAnimationFrame(this.frame);
  };
}
