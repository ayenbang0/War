/**
 * K9 scenarios: the story's opening, as a new player meets it.
 *
 * The cutscene, then the tutorial -- every one of its steps done with real
 * pointer and key events (harness.ts): a real stroke for every battle
 * gesture and every map order, real wheel notches, real middle drags, real
 * keys. Nothing here tells the coach a step is done; the coach hears it from
 * the app (ui/story/signals.ts) only when the control really did its thing.
 * Then one letter answered, and the chronicle read, in the king's own realm;
 * Continue skipping the opening; the tutorial replayed from the Menu; Esc in
 * the drill; and an ending's screen.
 *
 * The tutorial is long, so it is walked lesson by lesson, one scenario each;
 * a scenario reaches its lesson with the coach's own "Skip this step" button
 * (itself a control the tutorial offers, and a real click), so every lesson
 * is proven from where a player arrives at it.
 */

import { VOLUME_STEP, sound } from "../audio/sound.ts";
import type { KingdomLayer } from "../app/kingdom-layer.ts";
import type { CityLayer } from "../app/city-layer.ts";
import type { BattleLayer } from "../app/battle-layer.ts";
import { C } from "../content/kingdom/city-strings.ts";
import { MARKET } from "../content/kingdom/mercenary-strings.ts";
import { panelButton } from "./scenarios-k3.ts";
import { KINGDOM_SAVE_KEY } from "../app/kingdom-save.ts";
import { KingdomWorld } from "../sim/kingdom/world.ts";
import { saveToJson } from "../sim/kingdom/save.ts";
import { ENDINGS } from "../content/story/endings.ts";
import { AC } from "../content/kingdom/army-strings.ts";
import { CONTACT } from "../content/kingdom/descent-strings.ts";
import { UNIT_TYPES } from "../content/unit-types.ts";
import { CROPS, CROP_IDS } from "../content/kingdom/crops.ts";
import type { Coach } from "../ui/story/coach.ts";
import { TUTORIAL, type TutorialStep } from "../content/story/tutorial.ts";
import { CUTSCENE } from "../content/story/cutscene.ts";
import { STORY_UI } from "../content/story/strings.ts";
import { STORY_LETTERS } from "../content/story/letters.ts";
import { E, K } from "../content/kingdom/ui-strings.ts";
import { armyCounters } from "../input/kingdom-commander.ts";
import { kingCounterAt } from "../render/kingdom/layout.ts";
import { memoryStorage, scenario, type Driver, type Pt } from "./harness.ts";

// -- getting about -------------------------------------------------------------------

function coachOf(t: Driver): Coach {
  const c = t.hook.coach();
  t.expect(c !== null, "the tutorial is running (screens: " + t.hook.screens().join(" > ") + ")");
  return c as Coach;
}

function stepOf(t: Driver): TutorialStep | null {
  return coachOf(t).step;
}

/** From a fresh boot with the opening: the Exile, the cutscene skipped by its button, the coach on step one. */
async function intoTutorial(t: Driver): Promise<Coach> {
  t.boot({ opening: true });
  t.clickButton(K.homeButton);
  await t.waitFor(() => t.hook.top() === "story-cutscene", () => "the cutscene (top: " + t.hook.top() + ")");
  t.clickButton(CUTSCENE.skip);
  await t.waitFor(() => t.hook.coach() !== null && t.hook.top() === "kingdom", () => "the tutorial on the map (top: " + t.hook.top() + ")");
  return coachOf(t);
}

/** Skip steps with the coach's own button until `id` is the step waited on, and the app has brought the player to it. */
async function skipTo(t: Driver, id: string): Promise<void> {
  const target = TUTORIAL.findIndex((s) => s.id === id);
  t.expect(target >= 0, "the tutorial has a step " + id);
  const c = coachOf(t);
  while (c.index < target) {
    const at = c.index;
    t.click(skipButton(t));
    await t.waitFor(() => c.index > at, "Skip this step to go on from " + TUTORIAL[at].id);
  }
  await settle(t);
}

/** A coach button by its data-key (the fake DOM's selectors take no attribute values, so filter by hand). */
function coachButton(t: Driver, key: string): HTMLElement {
  const b = [...document.querySelectorAll(".s-coach button")].find((x) => x.getAttribute("data-key") === key) as HTMLElement | undefined;
  t.expect(b !== undefined && t.visible(b), "the coach has a live " + key + " button");
  return b as HTMLElement;
}

function skipButton(t: Driver): HTMLElement {
  return coachButton(t, "coach-skip-step");
}

/** Let the coach's deferred move between layers land, and a few frames draw. */
async function settle(t: Driver): Promise<void> {
  await Promise.resolve();
  await t.frames(3);
}

/** The step `id` is done -- by the player, not skipped -- and the coach has moved on. */
async function done(t: Driver, id: string, what: string): Promise<void> {
  const c = coachOf(t);
  await t.waitFor(() => c.done.includes(id), () => what + " completes the step " + id + " (waiting on " + (c.step?.id ?? "none") + ")");
  t.expect(!c.skipped.includes(id), id + " was done, not skipped");
  await settle(t);
}

function expectStep(t: Driver, id: string): void {
  const s = stepOf(t);
  t.expect(s?.id === id, "the coach is on " + id + " (on " + (s?.id ?? "none") + ")");
  const text = document.querySelector(".s-coach-text")?.textContent ?? "";
  t.expect(s !== null && text.includes(s.text), "the coach shows the step's words (" + text.slice(0, 60) + ")");
}

// -- the map -------------------------------------------------------------------------

function realmOf(t: Driver): KingdomLayer {
  const k = t.hook.kingdom();
  t.expect(k !== null, "the kingdom map is live (screens: " + t.hook.screens().join(" > ") + ")");
  return k as KingdomLayer;
}

function onMap(t: Driver, k: KingdomLayer, x: number, y: number): Pt {
  const r = t.byId("stage").getBoundingClientRect();
  return { x: r.left + k.cam.worldToScreenX(x), y: r.top + k.cam.worldToScreenY(y) };
}

function place(t: Driver, k: KingdomLayer, name: string): Pt {
  const h = k.world.holdings.find((x) => x.name === name);
  t.expect(h !== undefined, "the map has " + name);
  return onMap(t, k, h!.x, h!.y);
}

function kingAt(t: Driver, k: KingdomLayer): Pt {
  const c = kingCounterAt(k.kingDrawn(), k.cam.pxToWorld);
  return onMap(t, k, c.x, c.y);
}

function armyAt(t: Driver, k: KingdomLayer, army: number): Pt {
  const c = armyCounters(k.world, k.armiesDrawn(), k.cam.pxToWorld).find((x) => x.army.id === army);
  t.expect(c !== undefined, "army " + army + " is drawn on the map");
  return onMap(t, k, c!.counter.x, c!.counter.y);
}

function tap(t: Driver, p: Pt): void {
  t.stroke([p, { x: p.x + 1, y: p.y }]);
}

function wheel(t: Driver, p: Pt, deltaY: number): void {
  const W = (globalThis as unknown as { WheelEvent: typeof WheelEvent }).WheelEvent;
  t.byId("stage").dispatchEvent(new W("wheel", {
    bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, deltaY, deltaMode: 0,
  }));
}

/** Pause the realm if it runs (Space), so the days can be stepped with "." -- the player's way. */
function pauseRealm(t: Driver, k: KingdomLayer): void {
  if (k.clock.run !== "paused") t.key("Space");
  t.expect(k.clock.run === "paused", "the realm is paused");
}

function stepUntil(t: Driver, ok: () => boolean, max: number, what: string): void {
  for (let i = 0; i < max && !ok(); i++) t.key("Period");
  t.expect(ok(), what);
}

/** Close whatever card is over the map with Esc, leaving the map itself. */
function closeCards(t: Driver): void {
  for (let i = 0; i < 4 && t.hook.top() !== "kingdom" && t.hook.top() !== "city"; i++) t.key("Escape");
}

async function kingCard(t: Driver, k: KingdomLayer): Promise<void> {
  closeCards(t);
  tap(t, kingAt(t, k));
  await t.waitFor(() => t.hook.top() === "king-card", () => "the king card (top: " + t.hook.top() + ")");
}

/** A heart in screen space, from the notch round and back. */
function heartAt(c: Pt, size: number): Pt[] {
  const out: Pt[] = [];
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const hx = 16 * Math.sin(a) ** 3;
    const hy = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
    out.push({ x: c.x + (hx / 16) * size, y: c.y + (hy / 16) * size });
  }
  return out;
}

// -- the cutscene --------------------------------------------------------------------

scenario("k9-cutscene", "a new exile opens on the cutscene: Next goes on, it can be skipped by its button or Esc, then the tutorial", async (t) => {
  t.boot({ opening: true });
  t.clickButton(K.homeButton);
  await t.waitFor(() => t.hook.top() === "story-cutscene", () => "a new exile to open on the cutscene (top: " + t.hook.top() + ")");
  const app = t.hook.app;
  const scene = app.cutscene;
  t.expect(scene !== null && scene.state.beat === 0, "on its first beat");
  const skip = t.button(CUTSCENE.skip);
  t.expect(skip.classList.contains("home-play"), "Skip is a plain, primary button");
  t.expect(document.activeElement === t.button(STORY_UI.cutsceneNext), "Next has the focus, so Enter never ends the film");
  const narration = (): string => document.querySelector(".s-cutscene-text")?.textContent ?? "";
  t.expect(narration().includes(CUTSCENE.beats[0].text.slice(0, 20)), "the first beat is read out (" + narration().slice(0, 40) + ")");
  t.expect(document.querySelector(".s-cutscene-text")?.getAttribute("aria-live") === "polite", "the narration is a live region");
  t.clickButton(STORY_UI.cutsceneNext);
  t.expect(scene!.state.beat === 1, "Next goes on a beat");
  t.key("KeyN");
  t.expect(scene!.state.beat === 2, "and any key but Esc does too");
  t.expect(narration().includes(CUTSCENE.beats[2].text.slice(0, 20)), "each beat's words are shown");
  await t.frames(5);
  t.expect(t.hook.coach() === null, "the tutorial waits for the film");
  t.key("Escape");
  await t.waitFor(() => t.hook.coach() !== null, "Esc skips the cutscene into the tutorial");
  t.expect(app.cutscene === null && t.hook.top() === "kingdom", "the cutscene is gone, the practice map is up");
  t.expect(app.practice !== null && t.hook.kingdom() === app.practice, "the tutorial's map is the practice realm");
  expectStep(t, TUTORIAL[0].id);
  const lesson = document.querySelector(".s-coach-lesson")?.textContent ?? "";
  t.expect(lesson.includes("The Map"), "the coach names the lesson (" + lesson + ")");
  t.expect((document.querySelector(".s-coach-count")?.textContent ?? "").includes("of " + TUTORIAL.length), "and says how far through it is");
  t.expect(document.querySelector(".s-coach")?.getAttribute("aria-label") === STORY_UI.coachLabel, "the coach is a labelled region");

  // Skipping the whole tutorial asks first, then begins the king's own exile.
  t.click(coachButton(t, "coach-skip-all"));
  t.expect(t.hook.top() === "confirm", "Skip the tutorial asks first");
  t.expect(document.activeElement?.textContent === STORY_UI.coachSkipNo, "with the safe answer focused");
  t.clickButton(STORY_UI.coachSkipYes);
  await t.waitFor(() => t.hook.coach() === null && t.hook.kingdom() !== null && t.hook.kingdom() !== app.practice,
    "the king's own realm after skipping");
  const real = realmOf(t);
  t.expect(real.world.story !== null && real.world.date.day === 0, "it begins at day one, with the story running");
  t.expect(document.querySelector(".s-coach") === null, "the coach is gone");
});

// -- lesson 1: the map ---------------------------------------------------------------

scenario("k9-tutorial-map", "the map lesson, every step by real input: camera, F, taps, forage, clock, march, rally, claim, a letter, Finds", async (t) => {
  const c = await intoTutorial(t);
  const k = realmOf(t);
  const w = k.world;
  const mid = { x: innerWidth / 2, y: innerHeight / 2 };

  expectStep(t, "map-drag");
  t.drag(t.line(mid, { x: mid.x - 120, y: mid.y + 40 }), { button: 1 });
  await done(t, "map-drag", "a middle-button drag");
  t.keyDown("KeyD");
  await t.frames(3);
  t.keyUp("KeyD");
  await done(t, "map-keys", "the D key");
  wheel(t, mid, -120);
  await done(t, "map-zoom", "a wheel notch");
  t.key("KeyF");
  await done(t, "map-find", "F");
  await t.waitFor(() => !k.cam.flying, "the camera to reach the king");

  tap(t, place(t, k, "Cold Hearth"));
  await done(t, "map-tap-holding", "a tap on Cold Hearth");
  t.expect(t.hook.top() === "region-card", "it opened the holding's card");
  tap(t, kingAt(t, k));
  await done(t, "map-tap-king", "a tap on the king's counter");
  t.expect(t.hook.top() === "king-card", "it opened the king's card");
  t.clickButton(E.forage);
  await done(t, "map-forage", "Forage here");
  closeCards(t);

  // The clock: Space until it stops, then "." and a speed.
  for (let i = 0; i < 2 && !c.done.includes("map-pause"); i++) t.key("Space");
  await done(t, "map-pause", "Space");
  t.expect(k.clock.run === "paused", "the realm is stopped");
  t.key("Period");
  await done(t, "map-step", "'.' while stopped");
  t.key("Digit1");
  await done(t, "map-speed", "the 1 key");

  // March to Greyshaw with a line from the king.
  pauseRealm(t, k);
  const grey = w.holdings.find((h) => h.name === "Greyshaw")!;
  t.stroke(t.line(kingAt(t, k), place(t, k, "Greyshaw")));
  await done(t, "map-march", "a line from the king to Greyshaw");
  stepUntil(t, () => w.king.mover.road === 0 && w.king.mover.node === grey.id && w.king.mover.route.length === 0, 20, "the king reaches Greyshaw");

  await kingCard(t, k);
  t.clickButton(E.rally);
  await done(t, "map-rally", "Rally followers at Greyshaw");
  stepUntil(t, () => w.kingStocks.stocks.levy >= 3, 14, "three followers rally");
  closeCards(t);
  const rook = w.holdings.find((h) => h.name === "Rookstead")!;
  t.stroke(t.line(kingAt(t, k), place(t, k, "Rookstead")));
  stepUntil(t, () => w.king.mover.road === 0 && w.king.mover.node === rook.id && w.king.mover.route.length === 0, 24, "the king reaches Rookstead");
  await kingCard(t, k);
  t.clickButton(E.claim("Rookstead"));
  await done(t, "map-claim", "claiming Rookstead");

  // The coach brings the lesson's letter up at once, over the map; answer it.
  await t.waitFor(() => t.hook.top() === "story-letter", () => "the lesson's letter (top: " + t.hook.top() + ")");
  const title = document.querySelector(".s-letter .k-menu-title, .s-letter h2")?.textContent ?? "";
  t.expect(title.includes(STORY_LETTERS.find((l) => l.id === "first-follower")!.title), "it is the first follower's letter (" + title + ")");
  t.clickButton(STORY_LETTERS.find((l) => l.id === "first-follower")!.choices[0].label);
  await done(t, "map-letter", "answering the letter");
  closeCards(t);
  t.key("Period");
  t.expect(rook.owner === "king", "Rookstead is the king's");
  t.expect((w.story?.answers.length ?? 0) === 1, "the answer went through the order queue");

  closeCards(t);
  t.click(document.querySelector(".k-finds-toggle") as HTMLElement);
  await done(t, "map-finds", "the Finds button");
  t.expect(c.step?.lesson === "town", "the map lesson is done, on to the town (" + c.step?.id + ")");
  t.expect(c.skipped.length === 0, "nothing was skipped (" + c.skipped.join(",") + ")");
});

// -- lesson 2: the town --------------------------------------------------------------

function cityAt(t: Driver, c: CityLayer, x: number, y: number): Pt {
  const r = t.byId("stage").getBoundingClientRect();
  return { x: r.left + c.cam.worldToScreenX(x), y: r.top + c.cam.worldToScreenY(y) };
}

function cityPlace(t: Driver, c: CityLayer, kind: "lot" | "field", index: number): Pt {
  const at = c.placeOf(kind, index);
  t.expect(at !== null, "the plan has " + kind + " " + (index + 1));
  return cityAt(t, c, at!.x, at!.y);
}

function cityOf(t: Driver): CityLayer {
  const c = t.hook.city();
  t.expect(c !== null, "the town is open (top: " + t.hook.top() + ")");
  return c as CityLayer;
}

/** Back to the town plan itself, any card over it closed. */
function closeCityCards(t: Driver): void {
  for (let i = 0; i < 4 && t.hook.top() !== "city"; i++) t.key("Escape");
  t.expect(t.hook.top() === "city", "back on the town plan (top: " + t.hook.top() + ")");
}

scenario("k9-tutorial-town", "the town lesson by real input: zoom through, look, build, sow, resow, the tavern, politics by tap and P, F, Esc, in and out again", async (t) => {
  await intoTutorial(t);
  await skipTo(t, "town-enter");
  const k = realmOf(t);
  const w = k.world;
  const rook = w.holdings.find((h) => h.name === "Rookstead")!;
  t.expect(rook.owner === "king", "the practice keep is the king's, though its claim was skipped");
  expectStep(t, "town-enter");

  let notches = 0;
  while (t.hook.top() === "kingdom" && notches < 60) {
    wheel(t, place(t, k, "Rookstead"), -120);
    notches++;
  }
  await done(t, "town-enter", "wheeling in on through Rookstead");
  const city = cityOf(t);
  t.expect(city.holding === rook.id, "the town is Rookstead's");

  const mid = { x: innerWidth / 2, y: innerHeight / 2 };
  t.drag(t.line(mid, { x: mid.x + 80, y: mid.y - 30 }), { button: 2 });
  await done(t, "town-look", "a right-button drag");
  wheel(t, mid, -120);
  await done(t, "town-zoom", "a wheel notch");

  const empty = rook.buildings.findIndex((b) => b === null);
  t.expect(empty >= 0, "the keep has an empty lot");
  tap(t, cityPlace(t, city, "lot", empty));
  await done(t, "town-lot", "a tap on a lot");
  t.expect(t.hook.top() === "lot-card", "the lot's card is open");
  t.clickButton(E.build);
  t.clickButton("Granary");
  await done(t, "town-build", "Build and Granary");
  closeCityCards(t);
  tap(t, cityPlace(t, city, "field", 0));
  await done(t, "town-field", "a tap on a field");
  t.clickButton(E.sow);
  // A crop of this season that the stores can seed: what a player picks from the menu's own lines.
  const plot = rook.plots[0];
  const crop = CROP_IDS.find((id) => w.check({ kind: "sow", plot: plot.id, crop: id }) === null);
  t.expect(crop !== undefined, "something can be sown now");
  t.clickButton(CROPS[crop!].name);
  await done(t, "town-sow", "sowing the field");
  closeCityCards(t);
  t.click(panelButton(t, "resow-all"));
  await done(t, "town-resow", "the panel's resow switch");
  closeCityCards(t);

  const tavern = rook.buildings.indexOf("tavern");
  t.expect(tavern >= 0, "the practice keep has a tavern");
  tap(t, cityPlace(t, city, "lot", tavern));
  t.clickButton(MARKET.button);
  await done(t, "town-tavern", "the tavern's Free companies");
  closeCityCards(t);

  tap(t, cityAt(t, city, city.plan.square.x, city.plan.square.y));
  await done(t, "town-square", "a tap on the square");
  t.expect(t.hook.top() === "politics-card", "the square opens politics");
  t.key("Escape");
  t.key("KeyP");
  await done(t, "town-politics-key", "P");
  t.key("Escape");
  t.key("KeyF");
  await done(t, "town-whole", "F in the town");
  closeCityCards(t);
  t.key("Escape");
  await done(t, "town-leave", "Esc out of the town");
  await t.waitFor(() => t.hook.top() === "kingdom" && !k.isSuspended, "back on the map");

  tap(t, place(t, k, "Rookstead"));
  await t.waitFor(() => t.hook.top() === "region-card", "Rookstead's card");
  t.clickButton(C.enter);
  await done(t, "town-back", "Enter the city");
  t.expect(t.hook.top() === "city", "in the town again");
  t.key("Escape");
  await done(t, "town-out", "Esc");
  const c = coachOf(t);
  t.expect(c.step?.lesson === "drill", "on to the drill (" + c.step?.id + ")");
  t.expect(c.skipped.every((id) => TUTORIAL.find((s) => s.id === id)!.lesson === "map"), "only the map lesson was skipped (" + c.skipped.join(",") + ")");
  t.expect(rook.buildings.includes("granary") || rook.works.some((x) => x > 0), "the granary order went into the practice realm");
});

// -- lesson 3: the drill -------------------------------------------------------------

type W = { x: number; y: number };

function battleOf(t: Driver): BattleLayer {
  const b = t.hook.battle();
  t.expect(b !== null, "the drill is live (top: " + t.hook.top() + ")");
  return b as BattleLayer;
}

/** Resample a world polyline to `n` points, as a mouse drag samples it. */
function dense(verts: readonly W[], n: number): W[] {
  const segs = [0];
  for (let i = 1; i < verts.length; i++) segs.push(segs[i - 1] + Math.hypot(verts[i].x - verts[i - 1].x, verts[i].y - verts[i - 1].y));
  const total = segs[segs.length - 1];
  const out: W[] = [];
  for (let k = 0; k < n; k++) {
    const d = (k / (n - 1)) * total;
    let i = 1;
    while (i < segs.length - 1 && segs[i] < d) i++;
    const f = segs[i] === segs[i - 1] ? 0 : (d - segs[i - 1]) / (segs[i] - segs[i - 1]);
    out.push({ x: verts[i - 1].x + (verts[i].x - verts[i - 1].x) * f, y: verts[i - 1].y + (verts[i].y - verts[i - 1].y) * f });
  }
  return out;
}

function ring(cx: number, cy: number, r: number, from: number, steps: number): W[] {
  const out: W[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + (i / steps) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
}

function heartW(cx: number, cy: number, size: number): W[] {
  return heartAt({ x: cx, y: cy }, size);
}

/** A stroke drawn in world units, through the drill's camera onto the screen. */
function strokeW(t: Driver, pts: readonly W[], opts: { release?: boolean } = {}): EventTarget {
  return t.stroke(pts.map((p) => t.toScreen(p.x, p.y)), opts);
}

function companies(b: BattleLayer): { id: number; x: number; y: number; facing: number; radius: number; members: number[] }[] {
  return b.world.groups
    .filter((g) => g.player === 0 && b.world.liveCount(g) > 0)
    .map((g) => ({ id: g.id, x: g.anchorX, y: g.anchorY, facing: g.facing, radius: g.radius, members: g.members.slice() }));
}

function company(t: Driver, b: BattleLayer, id: number): { id: number; x: number; y: number; facing: number; radius: number; members: number[] } {
  const c = companies(b).find((x) => x.id === id);
  t.expect(c !== undefined, "company " + id + " is on the field");
  return c!;
}

/** The middle of some men, in world units. */
function middleOf(b: BattleLayer, ids: readonly number[]): W & { r: number } {
  const s = b.world.soldiers;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of ids) {
    x0 = Math.min(x0, s.x[i]); y0 = Math.min(y0, s.y[i]);
    x1 = Math.max(x1, s.x[i]); y1 = Math.max(y1, s.y[i]);
  }
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, r: Math.max(x1 - x0, y1 - y0) / 2 };
}

function looseMen(b: BattleLayer, player: number): number[] {
  const s = b.world.soldiers;
  const out: number[] = [];
  for (let i = 0; i < s.count; i++) if (s.player[i] === player && s.alive[i] === 1 && s.group[i] < 0) out.push(i);
  return out;
}

/** A tap in world units, where nobody stands. */
function tapW(t: Driver, p: W): void {
  const a = t.toScreen(p.x, p.y);
  t.stroke([a, { x: a.x + 1, y: a.y }]);
}

/** The four formation glyphs, centred on a company and turned to its facing (tools/gesture-corpus.ts). */
function glyph(c: { x: number; y: number; facing: number }, shape: "line" | "column" | "wedge" | "square"): W[] {
  const f = c.facing;
  const at = (dx: number, dy: number): W => ({ x: c.x + dx * Math.cos(f) - dy * Math.sin(f), y: c.y + dx * Math.sin(f) + dy * Math.cos(f) });
  if (shape === "line") return dense([at(0, -62), at(0, 62)], 30);
  if (shape === "column") return dense([at(-62, 0), at(62, 0)], 30);
  if (shape === "wedge") return dense([at(-46, -52), at(52, 0), at(-46, 52)], 34);
  const corners = [at(-52, -52), at(52, -52), at(52, 52), at(-52, 52)];
  return dense([...corners, corners[0]], 48);
}

scenario("k9-tutorial-drill", "the drill by real strokes: deploy, begin, camera, every battle gesture and glyph, an ability, Esc mid-stroke, pause, step, attack", async (t) => {
  await intoTutorial(t);
  await skipTo(t, "drill-deploy");
  const b = battleOf(t);
  t.expect(b.config.mode === "lesson" && b.world.deploying, "the drill opens setting out");
  expectStep(t, "drill-deploy");
  const [first, second] = companies(b);
  t.expect(first !== undefined && second !== undefined, "the drill hands over two companies");

  strokeW(t, dense([{ x: first.x, y: first.y }, { x: first.x, y: first.y + 60 }], 12));
  await done(t, "drill-deploy", "a deployment drag");
  t.key("Enter");
  await done(t, "drill-begin", "Enter");
  t.expect(!b.world.deploying, "the drill has begun");

  const mid = { x: innerWidth / 2, y: innerHeight / 2 };
  t.drag(t.line(mid, { x: mid.x + 60, y: mid.y + 20 }), { button: 1 });
  await done(t, "drill-drag", "a middle drag");
  t.keyDown("ArrowLeft");
  await t.frames(3);
  t.keyUp("ArrowLeft");
  await done(t, "drill-keys", "an arrow key");
  wheel(t, mid, 120);
  await done(t, "drill-zoom", "a wheel notch");

  // Stopped from here, so every stroke below is drawn on men standing still;
  // the coach does not count this pause, it waits for its own step.
  t.key("Space");
  t.expect(b.run === "paused", "the drill is paused while the strokes are drawn");
  for (let i = 0; i < 6; i++) t.key("Period");
  t.expect(looseMen(b, 1).some((i) => b.world.canSee(0, i)), "the enemy is in sight of the drill ground");

  // A loop round the loose men.
  if (b.commander.selected.length > 0) tapW(t, { x: second.x, y: second.y + 400 });
  const loose = looseMen(b, 0);
  const m = middleOf(b, loose);
  strokeW(t, ring(m.x, m.y, m.r + 24, 0, 60));
  await done(t, "drill-lasso", "a loop round loose men");
  t.expect(b.world.groups.filter((g) => g.player === 0).length === 3, "the loop made a third company");
  tapW(t, { x: second.x, y: second.y + 400 });
  await done(t, "drill-clear", "a tap on empty ground");
  tapW(t, { x: second.x, y: second.y });
  await done(t, "drill-pick", "a tap on the company");

  // Second company: march it out sideways, then the four glyphs on it.
  const c2 = company(t, b, second.id);
  strokeW(t, dense([{ x: c2.x, y: c2.y }, { x: c2.x, y: c2.y - 420 }], 40));
  await done(t, "drill-move", "a line out from the company");
  for (const shape of ["line", "column", "wedge", "square"] as const) {
    strokeW(t, glyph(company(t, b, second.id), shape));
    await done(t, "drill-" + shape, "a " + shape + " glyph on the company");
  }
  const c2b = company(t, b, second.id);
  strokeW(t, ring(c2b.x + 340, c2b.y + 180, 100, 0.4, 32));
  await done(t, "drill-hold", "a small loop on open ground");
  strokeW(t, ring(c2b.x, c2b.y + 900, 470, 0.5, 60));
  await done(t, "drill-patrol", "a big ring");
  const c2c = company(t, b, second.id);
  strokeW(t, dense([{ x: c2c.x, y: c2c.y }, { x: c2c.x - 320, y: c2c.y + 40 }], 40));
  await done(t, "drill-retreat", "a line back toward home");

  // Feint: a march, then the same route again inside the pair window.
  const c2d = company(t, b, second.id);
  const out = [{ x: c2d.x, y: c2d.y }, { x: c2d.x + 20, y: c2d.y + 520 }];
  strokeW(t, dense(out, 40));
  strokeW(t, dense([{ x: out[0].x + 10, y: out[0].y + 8 }, { x: out[1].x + 8, y: out[1].y - 8 }], 40));
  await done(t, "drill-feint", "a march retraced at once");

  const c2e = company(t, b, second.id);
  const zig: W[] = [];
  for (let k = 0; k < 7; k++) zig.push({ x: c2e.x - 120 + k * 95, y: c2e.y + (k % 2 === 0 ? -130 : 130) });
  strokeW(t, dense(zig, 64));
  await done(t, "drill-ambush", "a zigzag");

  // Carve: let go, then loop half of the first company.
  tapW(t, { x: first.x, y: first.y + 700 });
  const c1 = company(t, b, first.id);
  const half = middleOf(b, c1.members.filter((i) => b.world.soldiers.y[i] <= c1.y));
  strokeW(t, ring(half.x, half.y - 4, half.r + 10, 0, 48));
  await done(t, "drill-carve", "a loop round part of a company");

  // Group: a loop round the first company's two halves, and nobody else.
  tapW(t, { x: first.x, y: first.y + 700 });
  const both = companies(b).filter((c) => c.id !== second.id && c.members.every((i) => Math.abs(b.world.soldiers.x[i] - c1.x) < 200));
  t.expect(both.length >= 2, "the first company is now two (" + both.length + ")");
  const pair = middleOf(b, both.slice(0, 2).flatMap((c) => c.members));
  strokeW(t, ring(pair.x, pair.y, pair.r + 22, 0, 60));
  await done(t, "drill-group", "a loop round two companies");
  t.expect(b.commander.selected.length >= 2, "both are held");

  strokeW(t, dense([{ x: pair.x - 300, y: pair.y + 360 }, { x: pair.x + 300, y: pair.y + 360 }], 34));
  await done(t, "drill-split", "a straight line clear of the group");
  // Grid: take the group again, a line, then its partner.
  tapW(t, { x: first.x, y: first.y + 700 });
  const pair2 = middleOf(b, both.slice(0, 2).flatMap((c) => company(t, b, c.id).members));
  strokeW(t, ring(pair2.x, pair2.y, pair2.r + 22, 0, 60));
  t.expect(b.commander.selected.length >= 2, "the group is held again");
  strokeW(t, dense([{ x: pair2.x - 300, y: pair2.y - 200 }, { x: pair2.x + 300, y: pair2.y - 200 }], 34));
  strokeW(t, dense([{ x: pair2.x - 300, y: pair2.y + 60 }, { x: pair2.x + 300, y: pair2.y + 60 }], 34));
  await done(t, "drill-grid", "two parallel lines");
  t.expect(b.commander.selected.length >= 2, "the group is still held after the grid");
  strokeW(t, ring(pair2.x + 250, pair2.y + 600, 470, 0.5, 72));
  await done(t, "drill-cordon", "a large circle with the group held");

  // A heart over one company only: the others stay free for the attack.
  const third = companies(b).find((c) => c.id !== second.id && !both.some((x) => x.id === c.id));
  t.expect(third !== undefined, "the loose men's company is on the field");
  tapW(t, { x: third!.x, y: third!.y });
  t.expect(b.commander.selected.length === 1 && b.commander.selected[0] === third!.id, "the third company is picked");
  const c3 = company(t, b, third!.id);
  strokeW(t, dense(heartW(c3.x + 430, c3.y, 220), 62));
  await done(t, "drill-recover", "a heart");

  t.key("Digit1");
  await done(t, "drill-arm", "the 1 key");
  t.expect(b.commander.armed !== null, "an ability is armed");
  strokeW(t, dense([{ x: second.x + 300, y: second.y }, { x: second.x + 600, y: second.y }], 20));
  await done(t, "drill-cast", "a stroke placing it");

  const c2f = company(t, b, second.id);
  const held = strokeW(t, dense([{ x: c2f.x, y: c2f.y }, { x: c2f.x + 200, y: c2f.y + 200 }], 20), { release: false });
  t.key("Escape");
  await done(t, "drill-cancel", "Esc before letting go");
  t.expect(t.hook.top() === "battle", "Esc mid-stroke only cancels the stroke");
  const end = t.toScreen(c2f.x + 200, c2f.y + 200);
  held.dispatchEvent(new PointerEvent("pointerup", {
    bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true,
    clientX: end.x, clientY: end.y, button: 0, buttons: 0,
  }));

  // The pause the strokes were drawn under: run, then stop it -- the step's own.
  t.key("Space");
  t.key("Space");
  await done(t, "drill-pause", "Space");
  t.key("Period");
  await done(t, "drill-step", "'.' while paused");

  // Attack: from the first company's free half to the nearest enemy seen.
  const free = companies(b).find((c) => c.id !== third!.id && b.world.groups.find((g) => g.id === c.id)!.recoverUntil <= b.world.tick);
  t.expect(free !== undefined, "a company is free to attack");
  const seen = looseMen(b, 1).filter((i) => b.world.canSee(0, i));
  t.expect(seen.length > 0, "an enemy is seen");
  const foe = middleOf(b, seen);
  strokeW(t, dense([{ x: free!.x, y: free!.y }, { x: foe.x, y: foe.y }], 50));
  await done(t, "drill-attack", "a stroke ending on the enemy");
  const c = coachOf(t);
  t.expect(c.step?.lesson === "armies", "on to the armies lesson (" + c.step?.id + ")");
  t.expect(c.skipped.every((id) => TUTORIAL.find((s) => s.id === id)!.lesson !== "drill"), "nothing in the drill was skipped (" + c.skipped.join(",") + ")");
  await t.waitFor(() => t.hook.top() === "kingdom", () => "the drill gives way to the map (top: " + t.hook.top() + ")");
});

// -- lesson 4: armies on the map -----------------------------------------------------

/** A ring in screen space, starting at angle `from`. */
function ringPx(cx: number, cy: number, r: number, from: number, steps = 64): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + (i / steps) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
}

/** The smallest ring that starts on `from` and takes in every point of `toward`, with room to spare (gesture-corpus.ts). */
function ringFrom(from: Pt, toward: readonly Pt[], extra: number): Pt[] {
  let ux = 0;
  let uy = 0;
  for (const q of toward) {
    const dx = q.x - from.x;
    const dy = q.y - from.y;
    const d = Math.hypot(dx, dy) || 1;
    ux += dx / d;
    uy += dy / d;
  }
  const ul = Math.hypot(ux, uy) || 1;
  ux /= ul;
  uy /= ul;
  let rad = 0;
  for (const q of toward) {
    const dx = q.x - from.x;
    const dy = q.y - from.y;
    const dot = dx * ux + dy * uy;
    if (dot > 0) rad = Math.max(rad, (dx * dx + dy * dy) / (2 * dot));
  }
  rad += extra;
  const cx = from.x + ux * rad;
  const cy = from.y + uy * rad;
  return ringPx(cx, cy, rad, Math.atan2(from.y - cy, from.x - cx), 72);
}

scenario("k9-tutorial-armies", "the armies lesson by real input: raise, the army card, ring, patrol, split, merge, heart, intercept, Fight, and the way on", async (t) => {
  await intoTutorial(t);
  await skipTo(t, "army-raise");
  const k = realmOf(t);
  const w = k.world;
  expectStep(t, "army-raise");
  pauseRealm(t, k);
  const own = (): typeof w.armies => w.armies.filter((a) => a.owner === 0);

  await kingCard(t, k);
  t.clickButton(AC.raiseLevy);
  t.expect(t.hook.top() === "levy-menu", "the levy menu (top: " + t.hook.top() + ")");
  t.clickButton(UNIT_TYPES.line.name);
  await done(t, "army-raise", "raising followers");
  closeCards(t);
  t.key("Period");
  t.expect(own().length >= 2, "the levy's army and the lesson's company stand at the keep (" + own().length + ")");
  await t.frames(2);

  const pair = own().find((a) => a.squads.length >= 2)!;
  tap(t, armyAt(t, k, pair.id));
  await done(t, "army-card", "a tap on an army");
  t.expect(t.hook.top() === "army-card", "it opened the army's card");
  closeCards(t);

  // Closer in, as a player would to draw among counters fanned at one keep;
  // stopping short of the closest zoom, past which the wheel goes into the town.
  for (let i = 0; i < 3 && k.cam.zoom < k.cam.maxZoom * 0.7; i++) wheel(t, place(t, k, "Rookstead"), -120);
  await t.waitFor(() => !k.cam.flying, "the zoom to settle");
  await t.frames(2);

  // A small ring from the army's own counter: hold the keep.
  const c = armyAt(t, k, pair.id);
  t.stroke(ringPx(c.x + 22, c.y, 22, Math.PI, 36));
  await done(t, "army-garrison", "a small ring on the keep");

  // A large ring from the counter, round the keep and the hamlet.
  const c1 = armyAt(t, k, pair.id);
  t.stroke(ringFrom(c1, [place(t, k, "Rookstead"), place(t, k, "Greyshaw")], 30));
  await done(t, "army-patrol", "a large ring round two holdings");

  // A line across the counter, starting and ending on nothing: of the
  // directions a hand might take, the one that passes furthest from every
  // other counter (a line begun on the king's counter is the king's march).
  const c2 = armyAt(t, k, pair.id);
  const clear = [...own().filter((a) => a.id !== pair.id).map((a) => armyAt(t, k, a.id)), kingAt(t, k)];
  let best: Pt[] = [];
  let bestGap = -1;
  for (let deg = 0; deg < 180; deg += 10) {
    const r = (deg * Math.PI) / 180;
    const pts = t.line({ x: c2.x - Math.cos(r) * 45, y: c2.y - Math.sin(r) * 45 }, { x: c2.x + Math.cos(r) * 45, y: c2.y + Math.sin(r) * 45 }, 4);
    const gap = Math.min(...clear.map((q) => Math.min(...pts.map((p) => Math.hypot(p.x - q.x, p.y - q.y)))));
    if (gap > bestGap) { bestGap = gap; best = pts; }
  }
  t.stroke(best);
  await done(t, "army-split", "a line across an army");
  t.key("Period");
  await t.frames(2);

  // A stroke from one army of the king's to another.
  const mine = own();
  t.expect(mine.length >= 2, "two armies to merge (" + mine.length + ")");
  t.stroke(t.line(armyAt(t, k, mine[1].id), armyAt(t, k, mine[0].id), 3));
  await done(t, "army-merge", "a stroke between two armies");
  t.key("Period");
  await t.frames(2);

  const rest = own()[own().length - 1];
  t.stroke(heartAt(armyAt(t, k, rest.id), 42));
  await done(t, "army-recover", "a heart on an army");
  await t.frames(2);

  // Intercept: from an army that is not resting, to the Boar's outriders.
  const foe = w.armies.find((a) => a.owner !== 0 && a.name === "Outriders");
  t.expect(foe !== undefined, "the outriders are in the field");
  const free = own().find((a) => a.posture !== "recover");
  t.expect(free !== undefined, "an army of the king's is free to ride");
  t.stroke(t.line(armyAt(t, k, free!.id), armyAt(t, k, foe!.id), 4));
  await done(t, "army-intercept", "a line onto the enemy");

  for (let i = 0; i < 40 && t.hook.top() !== "kingdom-contact"; i++) t.key("Period");
  await t.waitFor(() => t.hook.top() === "kingdom-contact", () => "the armies meet (top: " + t.hook.top() + ")");
  t.clickButton(CONTACT.fight);
  await t.waitFor(() => t.hook.coach() === null && t.hook.top() === "confirm", () => "Fight ends the tutorial and asks how to go on (top: " + t.hook.top() + ")");
  t.expect((document.querySelector(".dialog")?.textContent ?? "").includes(STORY_UI.coachFinishedTitle), "it says the tutorial is done");
  t.clickButton(STORY_UI.coachBegin);
  await t.waitFor(() => t.hook.kingdom() !== null && t.hook.app.practice === null, "the king's own exile begins");
  const real = realmOf(t);
  t.expect(real.world.story !== null && real.world.date.day === 0 && real !== k, "a fresh realm with the story, not the practice one");
  t.expect(real.world.armies.filter((a) => a.owner === 0).length === 0, "nothing from the lesson came with it");
});

// -- the story proper: a letter answered, the chronicle read --------------------------

scenario("k9-letter-and-chronicle", "after the tutorial, in the king's own realm: a letter comes, an answer is chosen and lands; the chronicle shows it", async (t) => {
  await intoTutorial(t);
  t.click(coachButton(t, "coach-skip-all"));
  t.clickButton(STORY_UI.coachSkipYes);
  await t.waitFor(() => t.hook.coach() === null && t.hook.kingdom() !== null, "the king's own realm");
  const k = realmOf(t);
  const w = k.world;
  const s = w.story!;
  t.expect(s !== null && s.act === 1, "the story is in its first act");
  pauseRealm(t, k);
  t.expect(document.querySelector('.k-story button') !== null, "the map's top bar has the story's buttons");

  // Days go by, the player's way, until a letter comes -- and opens itself.
  for (let i = 0; i < 12 && t.hook.top() !== "story-letter"; i++) t.key("Period");
  await t.waitFor(() => t.hook.top() === "story-letter", () => "a letter to arrive and open (top: " + t.hook.top() + ", day " + w.date.day + ")");
  const letter = STORY_LETTERS[s.pending[0]];
  t.expect(letter !== undefined, "it is a letter of the story's (" + s.pending.join(",") + ")");
  const card = document.querySelector(".s-letter")?.textContent ?? "";
  t.expect(card.includes(letter.title) && card.includes(letter.from), "the card shows who wrote and its title");
  t.expect(letter.choices.every((c) => t.hasButton(c.label)), "every answer is a button");
  const choice = letter.choices[0];
  t.clickButton(choice.label);
  await t.waitFor(() => t.hook.top() !== "story-letter", "the answer closes the letter");
  closeCards(t);
  t.key("Period");
  const ans = s.answers.find((a) => a.letter === STORY_LETTERS.indexOf(letter) || (a.letter as unknown) === letter.id);
  t.expect(ans !== undefined && !ans.failed, "the answer went through the order queue and held (" + JSON.stringify(s.answers) + ")");
  t.expect(!s.pending.includes(STORY_LETTERS.indexOf(letter)), "the letter is no longer waiting");
  const feed = document.getElementById("kingdom-ui")?.textContent ?? "";
  t.expect(feed.includes(choice.result.slice(0, 30).replace("{king}", w.king.name)), "the feed tells what came of it");

  // The chronicle, from the map's own button.
  const chron = [...document.querySelectorAll(".k-story button")].find((b) => b.getAttribute("data-key") === "chronicle") as HTMLElement;
  t.expect(chron !== undefined, "the map has a Chronicle button");
  t.click(chron);
  await t.waitFor(() => t.hook.top() === "story-chronicle", () => "the chronicle opens (top: " + t.hook.top() + ")");
  const book = document.querySelector(".s-chronicle")?.textContent ?? "";
  t.expect(book.includes(STORY_UI.chronicleTitle), "it is the chronicle");
  t.expect(book.includes(letter.title), "it has the letter in it (" + book.slice(0, 120) + ")");
  t.expect(book.includes(choice.result.slice(0, 30).replace("{king}", w.king.name)), "with what the answer did");
  t.expect(book.includes(STORY_UI.chronicleGoals), "and what the act asks");
  t.key("Escape");
  t.expect(t.hook.top() === "kingdom", "Esc closes it");

  // And from the Menu.
  const menu = [...document.querySelectorAll(".k-story button")].find((b) => b.getAttribute("data-key") === "menu") as HTMLElement;
  t.click(menu);
  await t.waitFor(() => t.hook.top() === "story-menu", "the map's menu");
  // K11: the sound's mute and volume, in place, focus kept; pressed twice each, so the setting is left as found.
  const snd = sound();
  const on0 = snd.on;
  const vol0 = snd.volume;
  const toggle = document.querySelector<HTMLElement>(".s-sound-toggle");
  t.expect(t.visible(toggle) && toggle.textContent === (on0 ? STORY_UI.menuSoundOn : STORY_UI.menuSoundOff), "the Menu says whether sound is on");
  t.click(toggle!);
  t.expect(snd.on === !on0 && toggle!.textContent === (snd.on ? STORY_UI.menuSoundOn : STORY_UI.menuSoundOff) &&
    toggle!.getAttribute("aria-pressed") === String(snd.on), "Sound toggles, and the button says so");
  t.click(toggle!);
  t.expect(snd.on === on0, "and back");
  const louder = document.querySelector<HTMLElement>(".s-sound-louder")!;
  const quieter = document.querySelector<HTMLElement>(".s-sound-quieter")!;
  const level = (): string => document.querySelector(".s-sound-volume")?.textContent ?? "";
  if (vol0 < 100) {
    t.click(louder);
    t.expect(snd.volume === Math.min(100, vol0 + VOLUME_STEP) && level() === STORY_UI.menuVolume(snd.volume), "Louder raises the volume (" + level() + ")");
    t.click(quieter);
  } else {
    t.click(quieter);
    t.expect(snd.volume === vol0 - VOLUME_STEP && level() === STORY_UI.menuVolume(snd.volume), "Quieter lowers the volume (" + level() + ")");
    t.click(louder);
  }
  t.expect(snd.volume === vol0 && t.hook.top() === "story-menu", "and back, the Menu still up");
  t.clickButton(STORY_UI.menuChronicle);
  await t.waitFor(() => t.hook.top() === "story-chronicle", "the menu's Read the chronicle");
  t.key("Escape");
  // K11 (U3-12): back to the Menu it was opened from, then Esc to the map.
  t.expect(t.hook.top() === "story-menu", "closing it comes back to the Menu (top: " + t.hook.top() + ")");
  t.key("Escape");
  t.expect(t.hook.top() === "kingdom", "and Esc on the Menu goes back to the map");
});

// -- Esc in the drill (was K0's tutorial-esc) ------------------------------------------

scenario("k9-drill-esc", "in the drill Esc cancels a stroke first, then asks before skipping the tutorial; Skip it begins the exile", async (t) => {
  await intoTutorial(t);
  await skipTo(t, "drill-begin");
  const b = battleOf(t);
  t.expect(b.config.mode === "lesson", "the drill is the lesson");
  t.expect(b.world.ai.length === 0, "BS-05: no enemy commander can attack the drill");
  t.expect(b.world.duration >= 3600, "BS-05: no clock can end the drill (" + b.world.duration + "s)");
  t.key("Enter");
  await done(t, "drill-begin", "Enter");
  await t.waitFor(() => t.hudText().startsWith("lesson"), () => "the HUD to show no countdown (" + t.hudText().split("\n")[0] + ")");

  const c = { x: innerWidth / 2, y: innerHeight / 2 };
  t.stroke(t.line(c, { x: c.x + 80, y: c.y + 30 }), { release: false });
  t.expect(b.pen.drawing, "a stroke is being drawn");
  t.key("Escape");
  t.expect(!b.pen.drawing, "Esc cancels the stroke");
  t.expect(t.hook.top() === "battle", "and does not leave the drill (PC-06/BS-04)");

  t.key("Escape");
  t.expect(t.hook.top() === "confirm", "Esc with nothing to cancel asks before skipping");
  t.expect((document.querySelector(".dialog")?.textContent ?? "").includes(STORY_UI.coachSkipTitle), "it asks whether to skip the tutorial");
  t.expect(document.activeElement?.textContent === STORY_UI.coachSkipNo, "focus starts on the safe choice");
  const tick = b.world.tick;
  await t.frames(15);
  t.expect(b.world.tick === tick, "the drill is held while the question is up");
  t.key("Tab");
  t.expect(document.activeElement?.textContent === STORY_UI.coachSkipYes, "Tab moves within the dialog");
  t.key("Tab");
  t.expect(document.activeElement?.textContent === STORY_UI.coachSkipNo, "and stays trapped inside it");
  t.key("Escape");
  t.expect(t.hook.top() === "battle", "Esc on the question means keep learning");
  await t.waitFor(() => b.world.tick > tick, "the drill to run again");
  t.expect(t.hook.coach() !== null, "the tutorial goes on");

  t.key("Escape");
  t.clickButton(STORY_UI.coachSkipYes);
  await t.waitFor(() => t.hook.coach() === null && t.hook.kingdom() !== null, "skipping to begin the exile");
  t.expect(t.hook.battle() === null && b.phase === "torn-down", "the drill was torn down");
  t.expect(realmOf(t).world.story !== null, "on the king's own map, with the story");
  t.expect(t.hook.screens().join(">") === "home>kingdom", "nothing of the practice left on the stack (" + t.hook.screens().join(">") + ")");
});

scenario("k9-continue-skips-opening", "once begun, the Menu saves to Home; Continue goes straight to the map, with no cutscene and no tutorial; the Menu replays the tutorial", async (t) => {
  await intoTutorial(t);
  t.click(coachButton(t, "coach-skip-all"));
  t.clickButton(STORY_UI.coachSkipYes);
  await t.waitFor(() => t.hook.coach() === null && t.hook.kingdom() !== null, "the king's own realm");
  const k = realmOf(t);
  pauseRealm(t, k);
  t.key("Period");
  const day = k.world.date.day;
  const menu = [...document.querySelectorAll(".k-story button")].find((b) => b.getAttribute("data-key") === "menu") as HTMLElement;
  t.click(menu);
  t.clickButton(STORY_UI.menuFront);
  await t.waitFor(() => t.hook.top() === "home", "the front screen");
  t.expect((t.byId("home").textContent ?? "").includes("Continue:"), "Home offers to continue");
  t.clickButton(K.homeButton);
  await t.waitFor(() => t.hook.kingdom() !== null, () => "Continue opens the map (top: " + t.hook.top() + ")");
  t.expect(t.hook.app.cutscene === null && t.hook.coach() === null, "with no cutscene and no tutorial");
  const back = realmOf(t);
  t.expect(back.world.date.day === day && back.world.story !== null, "the same realm, story and all (day " + back.world.date.day + ")");

  // Replay from the Menu: the practice realm, then back to this one, untouched.
  const menu2 = [...document.querySelectorAll(".k-story button")].find((b) => b.getAttribute("data-key") === "menu") as HTMLElement;
  t.click(menu2);
  t.clickButton(STORY_UI.menuTutorial);
  await t.waitFor(() => t.hook.coach() !== null && t.hook.kingdom() === t.hook.app.practice, "the tutorial replays in its practice realm");
  t.click(coachButton(t, "coach-skip-all"));
  t.clickButton(STORY_UI.coachSkipYes);
  await t.waitFor(() => t.hook.coach() === null && t.hook.kingdom() !== null, "back to the realm");
  t.expect(realmOf(t).world.date.day === day && realmOf(t).world.story !== null, "the king's realm as it was left");
});

// -- an ending -------------------------------------------------------------------------

/** A story realm on the day its king is lost: the next day's story closes it. */
function fallenSave(): string {
  const w = new KingdomWorld({ seed: 0x6b9, hosts: true, captains: true, autoFarm: true, story: true });
  w.story!.kingLost = true;
  w.events = [];
  return saveToJson(w);
}

scenario("k9-ending", "the story ends: its end screen over the map, the chronicle from it, a new exile only behind a confirm, Continue shows it again", async (t) => {
  const store = memoryStorage({ [KINGDOM_SAVE_KEY]: fallenSave() });
  t.boot({ storage: () => store });
  t.clickButton(K.homeButton);
  await t.waitFor(() => t.hook.kingdom() !== null, "the saved realm");
  const k = realmOf(t);
  closeCards(t);
  pauseRealm(t, k);
  t.key("Period");
  await t.waitFor(() => t.hook.top() === "story-end", () => "the end screen (top: " + t.hook.top() + ")");
  const end = ENDINGS.find((e) => e.id === "the-fallen")!;
  const text = document.querySelector(".s-end-panel")?.textContent ?? "";
  t.expect(text.includes(end.title), "it names the ending (" + text.slice(0, 60) + ")");
  t.expect(text.includes(end.epilogue[0].text), "and reads its epilogue");
  t.expect(document.activeElement?.id === "s-end-title", "focus on its title");
  t.expect(k.world.story?.ending === "the-fallen", "the story has ended");

  t.clickButton(STORY_UI.endRead);
  await t.waitFor(() => t.hook.top() === "story-chronicle", "the chronicle from the end screen");
  t.key("Escape");
  t.expect(t.hook.top() === "story-end", "Esc goes back to the end screen");

  t.clickButton(STORY_UI.endNew);
  t.expect(t.hook.top() === "confirm", "a new exile asks first: it throws this realm away");
  t.clickButton(K.newNo);
  t.expect(t.hook.top() === "story-end" && store.getItem(KINGDOM_SAVE_KEY) !== null, "keeping it keeps the realm and its save");

  // K11 (U3-10): one stray Esc does not take the epilogue away -- it puts
  // focus on the way home; a second Esc goes.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  t.key("Escape");
  t.expect(t.hook.top() === "story-end", "the first Esc stays on the end screen");
  t.expect(document.activeElement?.textContent === STORY_UI.endHome, "and puts focus on the way to the front screen");
  t.key("Escape");
  await t.waitFor(() => t.hook.top() === "home", "the front screen, at the second Esc");
  t.clickButton(K.homeButton);
  await t.waitFor(() => t.hook.top() === "story-end", () => "Continue opens on the ending again (top: " + t.hook.top() + ")");

  t.clickButton(STORY_UI.endHome);
  await t.waitFor(() => t.hook.top() === "home", "the front screen");
  t.clickButton(K.homeButton);
  await t.waitFor(() => t.hook.top() === "story-end", () => "Continue opens on the ending again (top: " + t.hook.top() + ")");
});
