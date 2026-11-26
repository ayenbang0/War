/**
 * The browser end-to-end harness: a scenario registry, a driver that sends
 * REAL DOM events, and a runner that writes a compact PASS/FAIL list.
 *
 * Why it exists: the headless checks (tools/*.ts) feed hand-built contexts, and
 * CLAUDE.md records three group verbs that shipped broken past a 100% gesture
 * matrix and were only caught by driving real strokes through the browser. This
 * is that driving, written down so it can be re-run.
 *
 * How it is run: open e2e.html (on the published site, or `npm run dev`).
 *   e2e.html             run every scenario
 *   e2e.html?only=name   run one (comma-separate for several)
 *   e2e.html?list        list the scenario names
 * Results go into #e2e-results, one line per scenario, and document.title
 * ends as "E2E PASS n/m" or "E2E FAIL k/m" so a browser driver can read the
 * verdict from the tab title alone.
 *
 * Rules for scenarios:
 *  - Input goes ONLY through the driver's real events (pointer strokes on the
 *    canvas in screen coordinates, keys on the focused element, clicks).
 *  - State is READ through the TestHook (src/app/test-hook.ts).
 *  - Every scenario boots a fresh app and never touches the real save:
 *    storage is an in-memory stand-in unless the scenario supplies its own.
 */

import { startApp } from "../app/app.ts";
import type { StorageLike } from "../app/kingdom-save.ts";
import { testHook, type TestHook } from "../app/test-hook.ts";

export type Pt = { readonly x: number; readonly y: number };

export type Scenario = {
  readonly name: string;
  /** One line saying what is being shown. */
  readonly about: string;
  run(t: Driver): Promise<void>;
};

const registry: Scenario[] = [];

/** Add a scenario. Later phases register theirs the same way. */
export function scenario(name: string, about: string, run: (t: Driver) => Promise<void>): void {
  if (registry.some((s) => s.name === name)) throw new Error("duplicate scenario " + name);
  registry.push({ name, about, run });
}

export function scenarios(): readonly Scenario[] {
  return registry;
}

/** A failed expectation. */
class Failure extends Error {}

/** An in-memory stand-in for localStorage, fresh per boot. */
export function memoryStorage(seed: Record<string, string> = {}): StorageLike {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

/** Physical key -> the `key` value a real keyboard would send with it. */
const KEY_OF: Record<string, string> = {
  Space: " ", Enter: "Enter", Escape: "Escape", Tab: "Tab", Period: ".", F2: "F2",
  Minus: "-", Equal: "=", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", MetaLeft: "Meta",
};

function keyFor(code: string): string {
  if (KEY_OF[code]) return KEY_OF[code];
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

/** Mouse button -> the `buttons` bit it sets while held. */
const BUTTON_BIT = [1, 4, 2];

export class Driver {
  /** The hook into the current app. Throws before boot(). */
  private current: TestHook | null = null;
  /**
   * Set once the runner has moved on (the scenario finished or timed out). A
   * timed-out scenario is still running in the background; from here on every
   * input it tries throws, so it cannot reach into the next scenario's app.
   */
  private retired = false;
  readonly log: string[] = [];

  retire(): void {
    this.retired = true;
  }

  private live(): void {
    if (this.retired) throw new Failure("scenario retired");
  }

  get hook(): TestHook {
    if (!this.current) throw new Error("boot() first");
    return this.current;
  }

  /**
   * Boot a fresh app, disposing of the last one. A new exile opens straight
   * on the map -- K9's documented test path (AppEnv.skipOpening), which the
   * K2-K8 scenarios were written against -- unless `opening` asks for the
   * cutscene and the tutorial, as K9's own scenarios do.
   */
  boot(opts: { storage?: () => StorageLike | null; opening?: boolean } = {}): TestHook {
    this.live();
    this.dispose();
    const fresh = memoryStorage();
    const app = startApp({ win: window, doc: document, storage: opts.storage ?? (() => fresh), skipOpening: opts.opening !== true });
    this.current = testHook(app);
    return this.current;
  }

  dispose(): void {
    this.current?.app.dispose();
    this.current = null;
    // Leave no focus behind on a screen that has just been emptied.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  note(line: string): void {
    this.log.push(line);
  }

  // -- expectations -----------------------------------------------------------

  expect(ok: boolean, what: string): void {
    if (!ok) throw new Failure(what);
  }

  /**
   * Wait (frame by frame) until `pred` holds, or fail saying `what` -- given as
   * a function when the message should describe the state at the timeout.
   */
  async waitFor(pred: () => boolean, what: string | (() => string), timeoutMs = 5000): Promise<void> {
    const until = performance.now() + timeoutMs;
    while (!pred()) {
      this.live();
      if (performance.now() > until) {
        throw new Failure("timed out waiting for " + (typeof what === "string" ? what : what()));
      }
      await this.frames(1);
    }
  }

  frames(n: number): Promise<void> {
    return new Promise((resolve) => {
      let left = n;
      const tick = (): void => {
        if (--left <= 0) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // -- DOM queries ------------------------------------------------------------

  /** Shown on screen and not under an inert screen. */
  visible(el: Element | null): el is HTMLElement {
    return el instanceof HTMLElement && el.getClientRects().length > 0 && !el.closest("[inert]");
  }

  /** A live button by its exact text. */
  button(text: string): HTMLButtonElement {
    const all = Array.from(document.querySelectorAll("button"));
    const b = all.find((x) => this.visible(x) && x.textContent?.trim() === text);
    if (!b) {
      const seen = all.filter((x) => this.visible(x)).map((x) => x.textContent?.trim()).slice(0, 12);
      throw new Failure("no live button \"" + text + "\" (live: " + seen.join(" | ") + ")");
    }
    return b;
  }

  hasButton(text: string): boolean {
    return Array.from(document.querySelectorAll("button")).some((x) => this.visible(x) && x.textContent?.trim() === text);
  }

  byId(id: string): HTMLElement {
    const n = document.getElementById(id);
    if (!n) throw new Failure("no #" + id);
    return n;
  }

  hudText(): string {
    return this.byId("hud").textContent ?? "";
  }

  // -- input: real events only ------------------------------------------------

  /** A real click: pointer and mouse down/up at the element's centre, then click. */
  click(el: HTMLElement): void {
    this.live();
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
    // A real press focuses the button before the click lands.
    el.focus();
    el.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0, detail: 1 }));
  }

  clickButton(text: string): void {
    this.click(this.button(text));
  }

  /** Where a key goes in a real browser: the focused element, else the body. */
  private keyTarget(): EventTarget {
    return document.activeElement ?? document.body;
  }

  keyDown(code: string, mods: { shift?: boolean; ctrl?: boolean; meta?: boolean; repeat?: boolean } = {}): KeyboardEvent {
    this.live();
    const e = new KeyboardEvent("keydown", {
      code, key: keyFor(code), bubbles: true, cancelable: true, composed: true,
      shiftKey: mods.shift ?? false, ctrlKey: mods.ctrl ?? false, metaKey: mods.meta ?? false,
      repeat: mods.repeat ?? false,
    });
    this.keyTarget().dispatchEvent(e);
    return e;
  }

  keyUp(code: string): void {
    this.keyTarget().dispatchEvent(new KeyboardEvent("keyup", {
      code, key: keyFor(code), bubbles: true, cancelable: true, composed: true,
    }));
  }

  /** Press and release. */
  key(code: string, mods: { shift?: boolean; ctrl?: boolean; meta?: boolean } = {}): KeyboardEvent {
    const e = this.keyDown(code, mods);
    this.keyUp(code);
    return e;
  }

  /**
   * A pointer drag along a polyline in SCREEN coordinates. Goes to whatever is
   * on top at the first point -- the canvas, or an overlay covering it, exactly
   * as a real pointer would -- and stays with that target, as pointer capture
   * would keep it. `release: false` leaves the button held (a stroke mid-draw).
   */
  drag(points: readonly Pt[], opts: { button?: number; release?: boolean } = {}): EventTarget {
    this.live();
    if (points.length === 0) throw new Error("empty stroke");
    const button = opts.button ?? 0;
    const bit = BUTTON_BIT[button] ?? 1;
    const p0 = points[0];
    const target = document.elementFromPoint(p0.x, p0.y) ?? this.byId("stage");
    const fire = (type: string, p: Pt, b: number, buttons: number): void => {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: 1, pointerType: "mouse", isPrimary: true,
        clientX: p.x, clientY: p.y, screenX: p.x, screenY: p.y,
        button: b, buttons,
      }));
    };
    fire("pointerdown", p0, button, bit);
    for (let i = 1; i < points.length; i++) fire("pointermove", points[i], -1, bit);
    if (opts.release !== false) fire("pointerup", points[points.length - 1], button, 0);
    return target;
  }

  /** A left-button pen stroke. */
  stroke(points: readonly Pt[], opts: { release?: boolean } = {}): EventTarget {
    return this.drag(points, { button: 0, release: opts.release });
  }

  // -- geometry helpers (screen space) ---------------------------------------

  /** A dense closed loop: an ellipse, sampled every few pixels. */
  loop(cx: number, cy: number, rx: number, ry: number): Pt[] {
    const n = Math.max(24, Math.ceil((2 * Math.PI * Math.max(rx, ry)) / 5));
    const out: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * 2 * Math.PI;
      out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
    }
    return out;
  }

  /** A dense straight line, a point every `step` pixels. */
  line(a: Pt, b: Pt, step = 5): Pt[] {
    const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    const out: Pt[] = [];
    for (let i = 0; i <= n; i++) out.push({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n });
    return out;
  }

  /** A world point on screen, through the live battle's camera. */
  toScreen(wx: number, wy: number): Pt {
    const b = this.hook.battle();
    if (!b) throw new Failure("no battle is live");
    const rect = this.byId("stage").getBoundingClientRect();
    return { x: rect.left + b.cam.worldToScreenX(wx), y: rect.top + b.cam.worldToScreenY(wy) };
  }
}

export type Result = { readonly name: string; readonly ok: boolean; readonly detail: string; readonly ms: number };

/** Run the scenarios the query string asks for and report. */
export async function runFromQuery(search: string, out: HTMLElement): Promise<Result[]> {
  const q = new URLSearchParams(search);
  const all = scenarios();
  if (q.has("list")) {
    out.textContent = all.map((s) => s.name + "  -  " + s.about).join("\n");
    document.title = "E2E LIST " + all.length;
    return [];
  }
  const only = q.get("only");
  const wanted = only ? only.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const chosen = wanted ? all.filter((s) => wanted.includes(s.name)) : all.slice();
  if (wanted && chosen.length !== wanted.length) {
    const missing = wanted.filter((w) => !all.some((s) => s.name === w));
    out.textContent = "FAIL  unknown scenario: " + missing.join(", ");
    document.title = "E2E FAIL " + missing.length + "/" + wanted.length;
    return [];
  }

  const results: Result[] = [];
  const lines: string[] = [];
  const show = (): void => {
    out.textContent = lines.join("\n");
  };
  for (let i = 0; i < chosen.length; i++) {
    const s = chosen[i];
    document.title = "E2E RUNNING " + (i + 1) + "/" + chosen.length + " " + s.name;
    lines.push("....  " + s.name);
    show();
    const t = new Driver();
    const start = performance.now();
    let ok = true;
    let detail = "";
    try {
      await withTimeout(s.run(t), 30000, s.name);
    } catch (err) {
      ok = false;
      detail = err instanceof Error ? (err instanceof Failure ? "" : err.name + ": ") + err.message : String(err);
    } finally {
      t.retire();
      try { t.dispose(); } catch (err) {
        ok = false;
        detail += " (dispose threw: " + String(err) + ")";
      }
    }
    const ms = Math.round(performance.now() - start);
    results.push({ name: s.name, ok, detail, ms });
    lines[lines.length - 1] = (ok ? "PASS  " : "FAIL  ") + s.name + "  " + ms + "ms" +
      (detail ? "  <- " + detail : "") + (t.log.length ? "  [" + t.log.join("; ") + "]" : "");
    show();
  }
  const failed = results.filter((r) => !r.ok).length;
  lines.push("", failed === 0 ? "ALL " + results.length + " PASSED" : failed + " of " + results.length + " FAILED");
  show();
  document.title = failed === 0
    ? "E2E PASS " + results.length + "/" + results.length
    : "E2E FAIL " + failed + "/" + results.length;
  return results;
}

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(name + " took longer than " + ms + "ms")), ms);
    p.then((v) => { clearTimeout(id); resolve(v); }, (e) => { clearTimeout(id); reject(e); });
  });
}
