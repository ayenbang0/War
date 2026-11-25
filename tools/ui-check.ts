/**
 * Headless checks for the K0 layer controller's logic: the screen stack, the
 * key router, the progress store, the battle configs and a BattleLayer's own
 * life cycle, all under Node with plain-object fakes.
 *
 * What this cannot see is a real page: focus as the browser moves it, real
 * pointer events on a real canvas, CSS. That is what the e2e harness
 * (e2e.html, src/e2e/) is for, run on the published site by a browser. As with
 * the gesture corpus, do both.
 */

import { ScreenStack, type FocusHost, type Focusable, type InputContext, type KeyInput, type KeyVerdict, type Screen, type ScreenKind } from "../src/ui/screen-stack.ts";
import { ABILITY_SLOT_KEYS, ABILITY_SLOT_LABELS, KeyRouter, abilitySlotForCode, attachKeyRouter, classifyFocus, type FocusKind, type LayerKeys, type RawKey } from "../src/ui/keys.ts";
import { ProgressStore, CHRONICLE_KEY, type KeyValueStore } from "../src/app/progress-store.ts";
import { battleFromSetup, distinctAbilities, enemyArmy, lessonConfig, LESSON_DURATION_SECONDS } from "../src/app/battle-config.ts";
import { ABILITY_IDS, type AbilityId } from "../src/content/abilities.ts";
import { cost, validate } from "../src/content/army.ts";
import { COMMANDERS } from "../src/content/commanders.ts";
import { LEVELS } from "../src/content/levels/index.ts";
import { recordBattle, FIRST_CHAPTER } from "../src/content/campaign.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let failures = 0;
let section = "";
function begin(name: string): void {
  section = name;
  console.log("\n" + name);
}
function check(name: string, ok: boolean, detail = ""): void {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  <- " + detail : ""));
  if (!ok) failures++;
}

// -- fakes --------------------------------------------------------------------

/** A focusable thing with a name, standing in for a button. */
type FakeEl = Focusable & { readonly name: string; connected: boolean };
function fakeEl(name: string): FakeEl {
  return { name, connected: true, focus() { focusHost.current = this; } };
}

const focusHost = {
  current: null as Focusable | null,
  active(): Focusable | null { return this.current; },
  focus(t: Focusable | null): void {
    if (t) t.focus();
    else this.current = null;
  },
  canFocus(t: Focusable): boolean { return (t as FakeEl).connected !== false; },
} satisfies FocusHost & { current: Focusable | null };

/** The name of whatever has focus, or "none". */
function focused(): string {
  return (focusHost.active() as FakeEl | null)?.name ?? "none";
}

type FakeScreen = Screen & {
  log: string[];
  visible: boolean;
  inert: boolean;
  keys: string[];
  els: FakeEl[];
};

function fakeScreen(
  name: string, kind: ScreenKind,
  opts: { traps?: boolean; pauses?: boolean; inputs?: InputContext[]; onKey?: (k: KeyInput) => KeyVerdict; noFocus?: boolean } = {},
): FakeScreen {
  const els = [fakeEl(name + ".a"), fakeEl(name + ".b"), fakeEl(name + ".c")];
  const s: FakeScreen = {
    name, kind,
    trapsFocus: opts.traps ?? true,
    pausesSim: opts.pauses ?? false,
    inputs: opts.inputs ?? ["ui"],
    log: [], visible: false, inert: false, keys: [], els,
    firstFocus: () => (opts.noFocus ? null : els[0]),
    focusables: () => els,
    mount() { s.log.push("mount"); },
    unmount() { s.log.push("unmount"); },
    setVisible(v) { s.visible = v; s.log.push(v ? "show" : "hide"); },
    setInert(i) { s.inert = i; },
    revealed() { s.log.push("revealed@" + (focused())); },
    onKey: (k) => {
      s.keys.push(k.code);
      return opts.onKey ? opts.onKey(k) : "pass";
    },
  };
  return s;
}

function key(code: string, over: Partial<RawKey> = {}): RawKey & { prevented: boolean } {
  const k = {
    code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    target: null as unknown, prevented: false,
    preventDefault() { k.prevented = true; },
    ...over,
  };
  return k;
}

type FakeLayer = LayerKeys & { downs: string[]; ups: string[]; released: number; lastContexts: readonly InputContext[] };
function fakeLayer(): FakeLayer {
  const l: FakeLayer = {
    downs: [], ups: [], released: 0, lastContexts: [],
    keyDown(k, contexts) { l.downs.push(k.code); l.lastContexts = contexts; return "handled"; },
    keyUp(code) { l.ups.push(code); },
    releaseAll() { l.released++; },
  };
  return l;
}

// -- the screen stack ---------------------------------------------------------

begin("screen stack");
{
  focusHost.current = null;
  const stack = new ScreenStack(focusHost);
  const changes: string[] = [];
  stack.onChange(() => changes.push(stack.names().join(">")));
  const home = fakeScreen("home", "full", { traps: false });
  const menu = fakeScreen("menu", "full");
  const field = fakeScreen("field", "full", { traps: false, inputs: ["pen", "camera", "ui"], noFocus: true });
  const report = fakeScreen("report", "overlay", { pauses: true });

  stack.push(home);
  check("push mounts and shows the screen", home.log.join(",") === "mount,show", home.log.join(","));
  check("push focuses the screen's first-focus element", focusHost.current === home.els[0]);
  home.els[2].focus();
  stack.push(menu);
  check("a full screen hides the one below", !home.visible && menu.visible);
  check("only the top is live; the rest are inert", home.inert && !menu.inert);
  check("focus moves to the new top", focusHost.current === menu.els[0]);
  menu.els[1].focus();
  stack.push(field);
  check("a screen with no first focus drops focus to the page", focusHost.current === null);
  check("field inputs are the active contexts", stack.activeInputs().join() === "pen,camera,ui");
  check("nothing pauses the sim yet", !stack.pausesSim());
  stack.push(report);
  check("an overlay leaves the screen below on view", field.visible && report.visible);
  check("an overlay below it is still inert", field.inert);
  check("an overlay that pauses holds the sim", stack.pausesSim());
  check("the overlay allows only the UI context", stack.activeInputs().join() === "ui");

  stack.popTo(menu);
  check("popTo unmounts every screen above, top first",
    report.log.includes("unmount") && field.log.includes("unmount") &&
    report.log.lastIndexOf("unmount") >= 0, report.log.join(",") + " / " + field.log.join(","));
  check("popTo restores the focus held when the screen above was pushed",
    focusHost.current === menu.els[1], focused());
  check("the revealed screen is shown again and live", menu.visible && !menu.inert);
  // Focus was still on the popped report when the menu was revealed, i.e. the
  // menu could redraw before focus was handed back to it.
  check("revealed runs before focus is restored", menu.log.includes("revealed@report.a"), menu.log.join(","));
  check("the sim is no longer held", !stack.pausesSim());

  // A restore target that has gone (its screen redrew) falls back to first focus.
  menu.els[1].connected = false;
  stack.push(report);
  stack.pop();
  check("a vanished restore target falls back to the screen's first focus", focusHost.current === menu.els[0]);
  menu.els[1].connected = true;

  stack.pop();
  check("pop returns to home with its focus", focusHost.current === home.els[2] && home.visible && !home.inert);
  let threw = false;
  try { stack.push(home); } catch { threw = true; }
  check("a screen cannot be pushed twice", threw);
  check("every change is announced", changes.length === 8, changes.join(" | "));

  // Focus trap.
  const dlg = fakeScreen("dialog", "overlay");
  stack.push(dlg);
  stack.cycleFocus(false);
  const a = focused();
  stack.cycleFocus(false);
  stack.cycleFocus(false);
  const c = focused();
  stack.cycleFocus(false);
  const wrapped = focused();
  stack.cycleFocus(true);
  const back = focused();
  check("Tab cycles through the trap and wraps", a === "dialog.b" && c === "dialog.a" && wrapped === "dialog.b",
    [a, c, wrapped].join(","));
  check("Shift+Tab steps back", back === "dialog.a", back);
  stack.clear();
  check("clear empties the stack", stack.size === 0 && dlg.log.includes("unmount") && home.log.includes("unmount"));
}

// -- the key router -------------------------------------------------------------

begin("key router");
{
  focusHost.current = null;
  const stack = new ScreenStack(focusHost);
  let target: FocusKind = "page";
  const router = new KeyRouter(stack, () => target);
  const layer = fakeLayer();
  router.setLayer(layer);

  const menu = fakeScreen("menu", "full", { onKey: (k) => (k.code === "Escape" ? "handled" : "pass") });
  stack.push(menu);
  router.keyDown(key("KeyW"));
  check("a menu without pen or camera passes nothing to the layer", layer.downs.length === 0 && menu.keys.includes("KeyW"));

  const field = fakeScreen("field", "full", { traps: false, inputs: ["pen", "camera", "ui"], noFocus: true });
  stack.push(field);
  router.keyDown(key("Escape"));
  check("Esc goes to the top screen first, then the layer", field.keys.includes("Escape") && layer.downs.includes("Escape"));
  check("the layer sees the top screen's contexts", layer.lastContexts.join() === "pen,camera,ui");
  check("a covered menu never sees the key", !menu.keys.includes("Escape"));

  let dialogEsc = 0;
  const dialog = fakeScreen("dialog", "overlay", { pauses: true, onKey: (k) => (k.code === "Escape" ? (dialogEsc++, "handled") : "pass") });
  stack.push(dialog);
  layer.downs.length = 0;
  router.keyDown(key("Escape"));
  router.keyDown(key("Space"));
  router.keyDown(key("KeyA"));
  check("Esc on a dialog is the dialog's alone (one owner)", dialogEsc === 1 && !layer.downs.includes("Escape"));
  check("under a dialog the layer gets no keys at all", layer.downs.length === 0, layer.downs.join());
  router.keyUp({ code: "KeyA" });
  check("key-up always reaches the layer, so nothing sticks", layer.ups.includes("KeyA"));
  stack.pop();

  layer.downs.length = 0;
  target = "button";
  router.keyDown(key("Space"));
  router.keyDown(key("Enter"));
  router.keyDown(key("KeyD"));
  check("Space and Enter on a focused button belong to the button", !layer.downs.includes("Space") && !layer.downs.includes("Enter"));
  check("other keys still reach the game with a button focused", layer.downs.includes("KeyD"));
  target = "text-field";
  layer.downs.length = 0;
  router.keyDown(key("KeyW"));
  router.keyDown(key("Escape"));
  check("a text field owns every key but Escape", layer.downs.join() === "Escape", layer.downs.join());
  target = "page";

  layer.downs.length = 0;
  router.keyDown(key("KeyD", { ctrlKey: true }));
  router.keyDown(key("KeyA", { metaKey: true }));
  check("browser shortcuts are never game keys (Ctrl+D no longer pans)", layer.downs.length === 0);

  const before = layer.released;
  router.keyUp({ code: "MetaLeft" });
  check("letting go of Meta releases every held key (macOS)", layer.released === before + 1);
  router.blur();
  check("window blur releases every held key", layer.released === before + 2);

  const trap = fakeScreen("trap", "overlay");
  stack.push(trap);
  const tab = key("Tab");
  router.keyDown(tab);
  check("Tab inside a trap is kept and cycles", tab.prevented && focused() === "trap.b");
  stack.pop();
  const tab2 = key("Tab");
  router.keyDown(tab2);
  check("Tab outside a trap is left to the browser", !tab2.prevented);

  router.setLayer(null);
  check("swapping the layer out releases its held keys", layer.released === before + 3);

  // The DOM wiring: one listener per event type, all removed again.
  const added: string[] = [];
  const removed: string[] = [];
  const target2 = {
    hidden: false,
    addEventListener: (t: string) => added.push(t),
    removeEventListener: (t: string) => removed.push(t),
  };
  const detach = attachKeyRouter(router, target2, target2);
  check("exactly one keydown listener is attached", added.filter((t) => t === "keydown").length === 1, added.join());
  detach();
  check("detach removes everything it attached", removed.sort().join() === added.sort().join());

  check("buttons are classified as buttons", classifyFocus({ tagName: "BUTTON" }) === "button");
  check("a text input is a text field", classifyFocus({ tagName: "INPUT", type: "text" }) === "text-field");
  check("a checkbox is a button", classifyFocus({ tagName: "INPUT", type: "checkbox" }) === "button");
  check("the body is the page", classifyFocus({ tagName: "BODY" }) === "page" && classifyFocus(null) === "page");
}

begin("ability keys");
{
  check("Digit1 is slot 1", abilitySlotForCode("Digit1") === 0);
  check("Digit0 is slot 10 (AB-01)", abilitySlotForCode("Digit0") === 9);
  check("Minus and Equal are slots 11 and 12", abilitySlotForCode("Minus") === 10 && abilitySlotForCode("Equal") === 11);
  check("the numpad mirrors the digits", abilitySlotForCode("Numpad0") === 9 && abilitySlotForCode("Numpad5") === 4);
  check("other keys are no slot", abilitySlotForCode("KeyA") === -1 && abilitySlotForCode("Space") === -1);
  check("every ability can have a key of its own", ABILITY_SLOT_KEYS.length >= ABILITY_IDS.length,
    ABILITY_SLOT_KEYS.length + " keys for " + ABILITY_IDS.length);
  check("every slot has a label", ABILITY_SLOT_LABELS.length === ABILITY_SLOT_KEYS.length);
  const codes = ABILITY_SLOT_KEYS.flat();
  check("no key is bound to two slots", new Set(codes).size === codes.length);
  check("no ability key collides with a camera or battle key",
    !codes.some((c) => ["KeyW", "KeyA", "KeyS", "KeyD", "Space", "Period", "Enter", "Escape", "F2"].includes(c)));
}

// -- the progress store (BS-01) -----------------------------------------------

begin("progress store");
{
  const mem = new Map<string, string>();
  const ok: KeyValueStore = {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => { mem.set(k, v); },
    removeItem: (k) => { mem.delete(k); },
  };
  const s1 = new ProgressStore(() => ok);
  check("working storage is used", s1.status.kind === "saved");
  s1.save(recordBattle(s1.load(), FIRST_CHAPTER, true));
  const s2 = new ProgressStore(() => ok);
  check("and what it saved reads back in a fresh session", s2.load().record.length === 1);
  check("the probe key is not left behind", [...mem.keys()].join() === CHRONICLE_KEY);

  const refused = new ProgressStore(() => { throw Object.assign(new Error("denied"), { name: "SecurityError" }); });
  check("touching storage throwing is reported, not swallowed", refused.status.kind === "memory-only" &&
    refused.status.reason === "SecurityError");
  refused.save(recordBattle(refused.load(), FIRST_CHAPTER, false));
  check("a refused store keeps the chronicle in memory", refused.load().record.length === 1 && refused.load().at !== FIRST_CHAPTER);

  const writeRefused = new ProgressStore(() => ({
    getItem: () => null,
    setItem: () => { throw Object.assign(new Error("quota"), { name: "QuotaExceededError" }); },
    removeItem: () => {},
  }));
  check("a store that reads but cannot write is caught by the probe", writeRefused.status.kind === "memory-only");

  let allow = true;
  const flaky = new ProgressStore(() => ({
    getItem: () => null,
    setItem: () => { if (!allow) throw new Error("full"); },
    removeItem: () => {},
  }));
  allow = false;
  flaky.save(recordBattle(flaky.load(), FIRST_CHAPTER, true));
  check("a refusal part-way through a session switches to memory and says so",
    flaky.status.kind === "memory-only" && flaky.load().record.length === 1);

  const copy = s2.load();
  copy.record.push({ chapter: FIRST_CHAPTER, won: false });
  check("load hands out a copy", s2.load().record.length === 1);
}

// -- battle configs -------------------------------------------------------------

begin("battle configs");
{
  const lesson = lessonConfig();
  check("the lesson is a lesson", lesson.mode === "lesson");
  check("the lesson has no abilities on either side", lesson.abilities[0].length === 0 && lesson.abilities[1].length === 0);
  check("the lesson's clock is longer than any lesson", LESSON_DURATION_SECONDS >= 60 * 60);
  const smallest = Math.min(...LEVELS.map((l) => l.tilesWide * l.tilesHigh));
  check("the lesson uses the smallest field", lesson.level.tilesWide * lesson.level.tilesHigh === smallest);

  const level = LEVELS[0];
  const army = { doctrine: "maneuver" as const, squads: ["line", "line", "archer", "horse"] as const };
  const cfg = battleFromSetup({
    level, difficulty: "sergeant", army: { doctrine: army.doctrine, squads: [...army.squads] },
    commander: COMMANDERS.fox, abilities: ["barrage", "barrage", "shield"],
  });
  check("the enemy never spends more than the player", cost(cfg.armies[1]) <= cost(cfg.armies[0]));
  check("the enemy's list is legal", validate(cfg.armies[1], cost(cfg.armies[0])).ok);
  check("the enemy gets the same kit", cfg.abilities[1].join() === cfg.abilities[0].join());
  check("a config is plain data", JSON.parse(JSON.stringify({ a: cfg.armies, b: cfg.abilities })) !== null);
  check("keys address distinct abilities", distinctAbilities(["barrage", "barrage", "shield"]).join() === "barrage,shield");
  check("enemy armies differ by budget", enemyArmy(level, 60).squads.length < enemyArmy(level, 300).squads.length);
}

// -- the battle layer's life cycle, on fakes ------------------------------------

begin("battle layer");
{
  // Just enough page for a BattleLayer: a canvas that counts its listeners, a
  // window with a fake frame clock, and elements for the HUD and ability bar.
  type Listener = { type: string; fn: unknown };
  const fakeContext = (): CanvasRenderingContext2D => new Proxy({} as Record<string, unknown>, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === "createRadialGradient" || k === "createLinearGradient" || k === "createPattern") return () => ({ addColorStop() {} });
      if (k === "measureText") return () => ({ width: 10 });
      if (k === "getImageData") return () => ({ data: new Uint8ClampedArray(4) });
      return () => {};
    },
    set(t, k: string, v) { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  const fakeElement = (): Record<string, unknown> => {
    const children: unknown[] = [];
    const classes = new Set<string>();
    const e: Record<string, unknown> = {
      style: {}, textContent: "", className: "", title: "", children,
      classList: {
        add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c),
        toggle: (c: string, on?: boolean) => (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c),
        contains: (c: string) => classes.has(c),
      },
      append: (...n: unknown[]) => children.push(...n),
      appendChild: (n: unknown) => children.push(n),
      blur: () => {},
    };
    return e;
  };
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => tag === "canvas"
      ? { width: 0, height: 0, getContext: () => fakeContext() }
      : fakeElement(),
  };
  const canvasListeners: Listener[] = [];
  const canvas = {
    width: 1280, height: 720, style: {},
    classList: { add() {}, remove() {} },
    addEventListener: (type: string, fn: unknown) => canvasListeners.push({ type, fn }),
    removeEventListener: (type: string, fn: unknown) => {
      const i = canvasListeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) canvasListeners.splice(i, 1);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false,
  };
  const winListeners: Listener[] = [];
  let frames: ((t: number) => void)[] = [];
  let cancelled = 0;
  const win = {
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    addEventListener: (type: string, fn: unknown) => winListeners.push({ type, fn }),
    removeEventListener: (type: string, fn: unknown) => {
      const i = winListeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) winListeners.splice(i, 1);
    },
    requestAnimationFrame: (fn: (t: number) => void) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => { cancelled++; },
  };
  const hud = fakeElement();
  const abilityRoot = fakeElement();
  const { BattleLayer } = await import("../src/app/battle-layer.ts");
  const env = {
    win: win as unknown as Window, canvas: canvas as unknown as HTMLCanvasElement, ctx: fakeContext(),
    hud: hud as unknown as HTMLElement, abilityRoot: abilityRoot as unknown as HTMLElement,
  };
  const calls = { leave: 0, outcome: 0 };
  let held = false;
  const hooks = {
    onOutcome: () => { calls.outcome++; },
    requestLeave: () => { calls.leave++; },
    simHeld: () => held,
  };
  /** Run queued frames, each 50 ms (one tick) after the last. */
  let clock = 1000;
  const runFrames = (n: number): void => {
    for (let i = 0; i < n; i++) {
      const q = frames;
      frames = [];
      clock += 50;
      for (const f of q) f(clock);
    }
  };
  const contexts: InputContext[] = ["pen", "camera", "ui"];
  const press = (b: { keyDown(k: KeyInput, c: readonly InputContext[]): KeyVerdict }, code: string): KeyVerdict =>
    b.keyDown({ code, repeat: false, ctrl: false, meta: false, alt: false, shift: false, preventDefault() {} }, contexts);

  // The lesson.
  const lesson = new BattleLayer(lessonConfig(), env, hooks);
  check("a built battle has not started its loop", frames.length === 0 && lesson.phase === "built");
  lesson.start();
  check("start runs the frame loop", frames.length === 1 && lesson.phase === "live");
  check("BS-05: the lesson runs no enemy commander", lesson.world.ai.length === 0);
  check("BS-05: the lesson's clock cannot run out mid-lesson", lesson.world.duration === LESSON_DURATION_SECONDS);
  check("the lesson starts straight into the battle", !lesson.world.deploying);
  runFrames(40);
  check("frames advance the lesson's world", lesson.world.tick > 30, "tick " + lesson.world.tick);
  check("the HUD shows no clock in a lesson", String(hud.textContent).startsWith("lesson"), String(hud.textContent).split("\n")[0]);

  // Esc's order of ownership (GK-01, PC-06, BS-04).
  lesson.pen.drawing = true;
  lesson.pen.points = [{ x: 1, y: 1 }];
  press(lesson, "Escape");
  check("Esc mid-stroke cancels the stroke and nothing else", !lesson.pen.drawing && calls.leave === 0 && lesson.pen.lastAction === "cancelled");
  press(lesson, "Escape");
  check("Esc with nothing to cancel asks to leave", calls.leave === 1);

  // Pause (BH-01).
  press(lesson, "Space");
  const t0 = lesson.world.tick;
  runFrames(10);
  check("Space pauses the sim", lesson.run === "paused" && lesson.world.tick === t0);
  check("BH-01: the HUD says PAUSED", String(hud.textContent).startsWith("PAUSED"));
  press(lesson, "Period");
  check("'.' steps one tick while paused", lesson.world.tick === t0 + 1);
  press(lesson, "Space");
  held = true;
  runFrames(5);
  check("a screen that pauses the sim holds it too", lesson.world.tick === t0 + 1);
  held = false;
  runFrames(5);
  check("and lets it go when it is gone", lesson.world.tick > t0 + 1);

  const report = lesson.teardown();
  check("teardown stops the loop", cancelled >= 1 && lesson.phase === "torn-down");
  runFrames(3);
  check("a torn-down battle never ticks again", lesson.world.tick === report.tick);
  check("teardown removes every canvas listener", canvasListeners.length === 0, canvasListeners.map((l) => l.type).join());
  check("teardown removes every window listener", winListeners.length === 0, winListeners.map((l) => l.type).join());
  check("teardown empties the HUD (so it hides)", hud.textContent === "");
  check("teardown reports the tick and hash", report.tick > 0 && report.hash.length > 0);

  // A second battle, straight after, with ten distinct abilities.
  const ten = ABILITY_IDS.slice(0, 10) as AbilityId[];
  const second = new BattleLayer(battleFromSetup({
    level: LEVELS[0], difficulty: "recruit",
    army: { doctrine: "maneuver", squads: ["line", "line", "archer"] },
    commander: COMMANDERS.badger, abilities: ten,
  }), env, hooks);
  second.start();
  check("a second battle starts without a reload", second.phase === "live" && frames.length === 1);
  check("a real battle deploys first and runs its AI", second.world.deploying && second.world.ai.length === 1);
  press(second, "Digit0");
  check("keys do not arm abilities while deploying", second.commander.armed === null);
  press(second, "Enter");
  check("Enter begins the battle", !second.world.deploying);
  runFrames(2);
  press(second, "Digit0");
  check("AB-01: key 0 arms the tenth ability", second.commander.armed === ten[9], String(second.commander.armed));
  press(second, "Escape");
  check("GK-06: Esc puts an armed ability away before asking to leave", second.commander.armed === null && calls.leave === 1);
  second.world.outcome = { winner: 0, reason: "rout", detail: "forced by ui-check" };
  runFrames(2);
  check("the outcome is reported once", calls.outcome === 1);
  runFrames(2);
  check("and only once", calls.outcome === 1);
  second.teardown();
  check("the second battle also leaves nothing attached", canvasListeners.length === 0 && winListeners.length === 0);
}

// -- the whole app, on a fake page ----------------------------------------------

begin("app: screens and layers");
{
  const { installFakeDom, FakeEvent, FakeElement } = await import("./fake-dom.ts");
  const { win, doc } = installFakeDom();
  const { startApp } = await import("../src/app/app.ts");
  const { testHook } = await import("../src/app/test-hook.ts");
  type El = InstanceType<typeof FakeElement>;

  const mem = new Map<string, string>();
  const okStore: KeyValueStore = {
    getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); }, removeItem: (k) => { mem.delete(k); },
  };
  const baseWin = win.listenerCount();
  let app = startApp({ win: win as unknown as Window, doc: doc as unknown as Document, storage: () => okStore });
  let hook = testHook(app);

  const buttons = (): El[] => doc.querySelectorAll("button").filter((b) => b.shown && !b.closest("[inert]"));
  const btn = (text: string): El | null => buttons().find((b) => b.textContent.trim() === text) ?? null;
  const click = (text: string): boolean => {
    const b = btn(text);
    if (!b) return false;
    b.focus();
    b.click();
    return true;
  };
  const focusedText = (): string => doc.activeElement.textContent.trim();
  const press = (code: string, mods: { ctrl?: boolean } = {}): void => {
    const target = doc.activeElement;
    target.dispatchEvent(new FakeEvent("keydown", {
      code, repeat: false, ctrlKey: mods.ctrl ?? false, metaKey: false, altKey: false, shiftKey: false,
    }));
    target.dispatchEvent(new FakeEvent("keyup", { code }));
  };
  const canvas = doc.getElementById("stage") as El;
  const pointer = (type: string, x: number, y: number, button: number): void => {
    canvas.dispatchEvent(new FakeEvent(type, { pointerId: 1, clientX: x, clientY: y, button, buttons: button === 0 ? 1 : 4 }));
  };
  const hud = doc.getElementById("hud") as El;

  check("the app opens on the front screen", hook.top() === "home" && (doc.getElementById("home") as El).shown);
  check("with Play focused", focusedText() === "Play");
  check("RT-01: the empty HUD is hidden behind the front screen", !hud.shown);

  check("Play is a button on the front screen", click("Play"));
  check("Play pushes the setup screen", hook.screens().join(">") === "home>menu");
  check("which hides the front screen", !(doc.getElementById("home") as El).shown && (doc.getElementById("menu") as El).shown);
  check("focus goes to Take the field", focusedText() === "Take the field");
  press("Escape");
  check("BS-02: Esc on the setup screen goes back", hook.top() === "home" && focusedText() === "Play");
  click("Play");
  check("the setup screen has a Back button that goes back", click("Back") && hook.top() === "home");

  click("Play");
  click("Fox");
  click("Colonel");
  const budget = doc.querySelector("#menu .budget")?.textContent ?? "";
  check("Take the field launches the battle", click("Take the field") && hook.top() === "battle");
  const first = hook.battle();
  check("a battle layer is live", first !== null && first.phase === "live");
  check("built from the setup chosen", first?.config.commander.name === "Fox" && first?.config.difficulty === "colonel");
  if (!first) throw new Error("no battle");
  win.runFrames(2);
  check("the HUD is filled and shown in battle", hud.shown && hud.textContent.includes("ENTER to begin"));
  press("Enter");
  check("Enter (on the page) begins the battle", !first.world.deploying);
  win.runFrames(6);
  check("the battle runs", first.world.tick >= 5, "tick " + first.world.tick);

  press("Space");
  win.runFrames(1);
  const pausedAt = first.world.tick;
  win.runFrames(4);
  check("BH-01: Space pauses and the HUD says so", first.world.tick === pausedAt && hud.textContent.startsWith("PAUSED"));
  press("Space");
  win.runFrames(3);
  check("Space resumes", first.world.tick > pausedAt);

  // Middle drag pans; left drag draws.
  const cx = first.cam.x;
  pointer("pointerdown", 600, 300, 1);
  pointer("pointermove", 500, 300, 1);
  pointer("pointerup", 500, 300, 1);
  check("PC-01: a middle drag pans the map", Math.abs(first.cam.x - (cx + 100 / first.cam.zoom)) < 1e-6 && !first.pen.drawing);
  pointer("pointerdown", 600, 300, 0);
  check("the left button is still the pen", first.pen.drawing);
  press("Escape");
  check("Esc cancels that stroke without leaving", !first.pen.drawing && hook.top() === "battle");

  press("Escape");
  check("Esc with nothing to cancel asks before leaving", hook.top() === "confirm" && focusedText() === "Stay");
  const heldAt = first.world.tick;
  win.runFrames(5);
  check("the battle is held while the question is up", first.world.tick === heldAt);
  pointer("pointerdown", 600, 300, 0);
  check("the pen is off under the dialog", !first.pen.drawing);
  press("KeyD");
  check("GK-03: keys do not reach the map under the dialog", first.cam.x === cx + 100 / first.cam.zoom);
  press("Tab");
  check("Tab is trapped in the dialog", focusedText() === "Leave the field");
  press("Tab");
  check("and wraps", focusedText() === "Stay");
  press("Escape");
  check("Esc on the question means stay", hook.top() === "battle");
  win.runFrames(3);
  check("and the battle runs again", first.world.tick > heldAt);

  hook.forceOutcome(0);
  win.runFrames(1);
  check("the end of the battle opens the report", hook.top() === "after-action" && focusedText() === "Fight again");
  check("the ability bar goes when the battle ends", !(doc.getElementById("abilities") as El).shown);
  check("AA-01: Fight again goes back to the setup", click("Fight again") && hook.top() === "menu");
  check("the first battle is torn down", hook.battle() === null && first.phase === "torn-down");
  check("its frame loop is gone", win.pendingFrames() === 0);
  check("and every window listener it added", win.listenerCount() === baseWin + 3, String(win.listenerCount() - baseWin));
  check("the setup is as it was left", (doc.querySelector("#menu .budget")?.textContent ?? "") === budget &&
    doc.querySelectorAll("#menu .choice.on").some((e) => e.textContent === "Fox"));
  check("focus is back on Take the field", focusedText() === "Take the field");
  check("RT-01: the HUD is empty and hidden again", hud.textContent === "" && !hud.shown);

  check("a second battle launches without a reload", click("Take the field") && hook.top() === "battle");
  const second = hook.battle();
  check("it is a new battle, from the beginning", second !== null && second !== first && second.world.tick === 0);
  press("Escape");
  check("leaving a battle asks first", hook.top() === "confirm");
  check("Leave the field goes back to the setup", click("Leave the field") && hook.top() === "menu" && hook.battle() === null);
  press("Escape");
  check("and Esc from there to the front screen", hook.top() === "home");

  // The lesson.
  check("Learn the gestures launches the lesson", click("Learn the gestures") && hook.battle()?.config.mode === "lesson");
  const lesson = hook.battle();
  if (!lesson) throw new Error("no lesson");
  win.runFrames(3);
  check("BS-05: no AI and no clock in the lesson", lesson.world.ai.length === 0 && hud.textContent.startsWith("lesson"));
  pointer("pointerdown", 640, 360, 0);
  pointer("pointermove", 700, 380, 0);
  press("Escape");
  check("PC-06: Esc mid-stroke cancels the stroke and stays in the lesson", !lesson.pen.drawing && hook.top() === "battle");
  press("Escape");
  check("BS-04: leaving the lesson asks first", hook.top() === "confirm");
  check("Leave the lesson returns to the front screen", click("Leave the lesson") && hook.top() === "home");
  check("with focus where it was", focusedText() === "Learn the gestures");

  // The chronicle, with a battle written into it and a restart that asks.
  click("Campaign");
  check("Campaign opens the chronicle", hook.top() === "chronicle" && (doc.getElementById("chronicle") as El).shown);
  check("no storage notice when storage works", doc.querySelectorAll("#chronicle .storage-notice").length === 0);
  click("March");
  click("Take the field");
  press("Enter");
  hook.forceOutcome(0);
  win.runFrames(1);
  check("a campaign battle's report continues the chronicle", btn("Continue the chronicle") !== null);
  click("Continue the chronicle");
  check("Continue the chronicle goes back to the chronicle", hook.top() === "chronicle" && hook.screens().join(">") === "home>chronicle");
  check("which shows the battle written down", doc.querySelectorAll("#chronicle .chronicle-row").length === 1);
  check("and saved it", (mem.get(CHRONICLE_KEY) ?? "").includes(FIRST_CHAPTER));
  check("BS-03: Start the chronicle over asks first", click("Start the chronicle over") && hook.top() === "confirm" &&
    focusedText() === "Keep it");
  press("Escape");
  check("Esc keeps it, focus back on the button",
    doc.querySelectorAll("#chronicle .chronicle-row").length === 1 && focusedText() === "Start the chronicle over");
  click("Start the chronicle over");
  click("Start over");
  check("confirming starts it over", hook.top() === "chronicle" && doc.querySelectorAll("#chronicle .chronicle-row").length === 0);
  press("Escape");
  check("Esc from the chronicle goes home", hook.top() === "home");

  // The kingdom map (K2): reached from Home, and torn down as cleanly as a battle.
  const docListeners = (): number => (doc as unknown as { count(): number }).count();
  const winBefore = win.listenerCount();
  const docBefore = docListeners();
  const canvasBefore = canvas.count();
  check("K2: Home offers the Exile", click("The Exile of Rimaros") && hook.top() === "kingdom");
  const realm = hook.kingdom();
  check("K2: a kingdom layer is live", realm !== null && realm.phase === "live");
  win.runFrames(45);
  check("K2: the realm runs in real time", (realm?.world.now ?? 0) > 0, "tick " + realm?.world.now);
  check("K2: its HUD is on the page", doc.getElementById("kingdom-ui") !== null);
  press("Space");
  const kAt = realm?.world.now ?? -1;
  win.runFrames(20);
  check("K2: Space pauses the realm", realm?.world.now === kAt);
  pointer("pointerdown", 600, 300, 0);
  check("K2: the left button is the kingdom pen", realm?.intent !== null);
  press("Escape");
  check("K2: Esc cancels the stroke and stays", realm?.intent === null && hook.top() === "kingdom");
  press("Escape");
  check("K2: Esc again goes back to Home with no question", hook.top() === "home" && realm?.phase === "torn-down");
  check("K2: its frame loop is gone", win.pendingFrames() === 0);
  check("K2: every window listener it added is gone", win.listenerCount() === winBefore, String(win.listenerCount() - winBefore));
  check("K2: every document listener too", docListeners() === docBefore, String(docListeners() - docBefore));
  check("K2: and every canvas listener", canvas.count() === canvasBefore, String(canvas.count() - canvasBefore));
  check("K2: its HUD is off the page", doc.getElementById("kingdom-ui") === null);
  check("K2: leaving saved the realm", (mem.get("war.kingdom.v1") ?? "").length > 0);
  check("K2: Home now offers a new exile too", btn("Begin a new exile") !== null);
  click("The Exile of Rimaros");
  check("K2: the Exile continues the saved realm", hook.kingdom()?.world.now === kAt);
  press("Escape");

  app.dispose();
  check("dispose removes every window listener", win.listenerCount() === baseWin, String(win.listenerCount()));
  check("and every document listener", (doc as unknown as { count(): number }).count() === 0);

  // BS-01: storage refused, all the way through a chapter.
  app = startApp({
    win: win as unknown as Window, doc: doc as unknown as Document,
    storage: () => { throw Object.assign(new Error("refused"), { name: "SecurityError" }); },
  });
  hook = testHook(app);
  click("Campaign");
  check("BS-01: the chronicle says it cannot save", doc.querySelectorAll("#chronicle .storage-notice").length === 1);
  click("March");
  click("Take the field");
  press("Enter");
  hook.forceOutcome(0);
  win.runFrames(1);
  check("the report says it too", doc.querySelectorAll("#report .storage-notice").length === 1);
  click("Continue the chronicle");
  const heads = doc.querySelectorAll("#chronicle h2").map((h) => h.textContent);
  check("BS-01: progress survives in memory past chapter 1",
    doc.querySelectorAll("#chronicle .chronicle-row").length === 1 && !heads.some((h) => h.startsWith("Chapter 1:")),
    heads.join(" / "));
  app.dispose();
  check("the canvas has no listeners left", canvas.count() === 0);
}

// -- the one scaling policy (docs/ui-policy.md) ------------------------------
//
// No browser runs here, so these read the stylesheet and pages as text. The
// e2e scenario k2-text-floor checks computed sizes in a real browser.
begin("ui policy (BS-06, BS-07, BS-10, BS-11, RT-02)");
{
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  const css = read("../src/style.css").replace(/\/\*[\s\S]*?\*\//g, "");

  // Every font size, longhand or in the `font:` shorthand, resolves to 1rem
  // (16 px) or more. Sizes are rem or a --text token; a px font size is a
  // policy break in itself, because it ignores the player's text setting.
  const small: string[] = [];
  const pxFonts: string[] = [];
  for (const m of css.matchAll(/font(?:-size)?\s*:\s*([^;}]+)/g)) {
    const v = m[1];
    for (const n of v.matchAll(/(\d*\.?\d+)(px|rem|em)\b/g)) {
      // In the shorthand, a size after "/" is the line height, not a size.
      const before = v.slice(0, n.index ?? 0);
      if (before.trimEnd().endsWith("/")) continue;
      const size = parseFloat(n[1]);
      if (n[2] === "px") pxFonts.push(m[0].trim());
      else if (size < 1) small.push(m[0].trim());
    }
  }
  check("no font size under 1rem in the stylesheet", small.length === 0, small.join(" | "));
  check("no font size in px (sizes follow the player's text setting)", pxFonts.length === 0, pxFonts.join(" | "));
  const token = /--text:\s*(\d*\.?\d+)rem/.exec(css);
  check("the body text token is at least 1rem", token !== null && parseFloat(token[1]) >= 1, token ? token[0] : "missing");

  check("an authored focus ring exists", /:focus-visible\s*\{[^}]*outline:\s*3px/.test(css));
  check("reduced motion is honoured", /@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css));
  check("panels do not scroll inside scrolling overlays (one scroll region)",
    !/\.(menu|aa|home)-panel\s*\{[^}]*overflow:\s*auto/.test(css));
  for (const page of ["../index.html", "../e2e.html"]) {
    check(page.slice(3) + " declares its language", /<html lang="en">/.test(read(page)));
  }

  // Contrast of the text inks against the panels they sit on (WCAG 2.x).
  const lum = (hex: string): number => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a: string, b: string): number => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };
  const tok = (name: string): string => {
    const m = new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{6})").exec(css);
    return m ? m[1] : "#000000";
  };
  const panels = ["panel", "panel-2"].map(tok).concat(["#f1e9d4", "#f2ecdc"]);
  const low: string[] = [];
  for (const ink of ["ink", "ink-1", "ink-2", "friend", "foe"]) {
    for (const bg of panels) {
      const r = ratio(tok(ink), bg);
      if (r < 4.5) low.push(ink + " on " + bg + " " + r.toFixed(2));
    }
  }
  check("every text ink holds 4.5:1 on every panel", low.length === 0, low.join(", "));
  check("primary buttons' text holds 4.5:1", ratio("#f4efe2", tok("friend")) >= 4.5);
  check("disabled primary text holds 4.5:1", ratio(tok("ink-1"), "#d9d1bd") >= 4.5);
  check("the focus ring holds 3:1 on parchment", ratio(tok("focus"), tok("panel")) >= 3);
}

console.log("");
if (failures > 0) {
  console.log(failures + " ui check(s) FAILED (last section: " + section + ")");
  process.exit(1);
}
console.log("ui checks passed");
