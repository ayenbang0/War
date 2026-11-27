/**
 * K0 scenarios: the layer controller, the screen stack and the key router, as
 * a player meets them. Every input is a real DOM event (see harness.ts).
 *
 * The game is the story only now: Home has no Play or Campaign button, so the
 * battle scenarios start their battle with the test hook's `launchBattle` (the
 * second documented exception to "never drive", test-hook.ts) and then drive
 * it with real strokes and keys exactly as before.
 */

import { UNIT_TYPES } from "../content/unit-types.ts";
import { ABILITY_IDS } from "../content/abilities.ts";
import { K } from "../content/kingdom/ui-strings.ts";
import { homeFigures } from "../ui/home.ts";
import type { BattleLayer } from "../app/battle-layer.ts";
import type { TestBattle } from "../app/test-hook.ts";
import { scenario, type Driver, type Pt } from "./harness.ts";

/** The live battle, or a failure. */
function battleOf(t: Driver): BattleLayer {
  const b = t.hook.battle();
  t.expect(b !== null, "a battle is live");
  return b as BattleLayer;
}

function display(el: HTMLElement): string {
  return getComputedStyle(el).display;
}

/**
 * The test launch over Home, with the old setup screen's defaults unless the
 * spec says otherwise. Leaves it deploying.
 */
async function launchFromPlay(t: Driver, spec?: TestBattle): Promise<BattleLayer> {
  t.expect(t.hook.top() === "home", "the battle is launched from the front screen (top: " + t.hook.top() + ")");
  t.hook.launchBattle(spec);
  await t.waitFor(() => t.hook.top() === "battle", "the battle screen");
  const b = battleOf(t);
  t.expect(b.world.deploying, "a battle opens on deployment");
  return b;
}

/** ...and press Enter to begin it. */
async function begin(t: Driver, b: BattleLayer): Promise<void> {
  t.key("Enter");
  t.expect(!b.world.deploying, "Enter begins the battle");
  const t0 = b.world.tick;
  await t.waitFor(() => b.world.tick > t0 + 2, "the clock to run after Enter");
}

/**
 * Screen-space box round one of the player's companies as set out: the one
 * nearest the middle of the screen, since a large army runs off the top and
 * bottom of the opening view.
 */
function companyOnScreen(t: Driver, b: BattleLayer): { ids: number[]; min: Pt; max: Pt } {
  const s = b.world.soldiers;
  const mine: number[] = [];
  for (let i = 0; i < s.count; i++) if (s.player[i] === 0 && s.alive[i] === 1) mine.push(i);
  // Soldiers were spawned company by company, in list order.
  const blocks: number[][] = [];
  let at = 0;
  for (const type of b.config.armies[0].squads) {
    const n = UNIT_TYPES[type].soldiers;
    blocks.push(mine.slice(at, at + n));
    at += n;
  }
  const mid = { x: innerWidth / 2, y: innerHeight / 2 };
  let best: { ids: number[]; min: Pt; max: Pt; d: number } | null = null;
  for (const ids of blocks) {
    if (ids.length === 0) continue;
    let min = { x: Infinity, y: Infinity };
    let max = { x: -Infinity, y: -Infinity };
    for (const id of ids) {
      const p = t.toScreen(s.x[id], s.y[id]);
      min = { x: Math.min(min.x, p.x), y: Math.min(min.y, p.y) };
      max = { x: Math.max(max.x, p.x), y: Math.max(max.y, p.y) };
    }
    const d = Math.hypot((min.x + max.x) / 2 - mid.x, (min.y + max.y) / 2 - mid.y);
    if (!best || d < best.d) best = { ids, min, max, d };
  }
  t.expect(best !== null, "the player has men on the field");
  const { ids, min, max } = best as { ids: number[]; min: Pt; max: Pt };
  t.expect(min.x > 30 && min.y > 30 && max.x < innerWidth - 30 && max.y < innerHeight - 140,
    "a company is clear of the edges and the ability bar (" + Math.round(min.x) + "," + Math.round(min.y) + " to " +
    Math.round(max.x) + "," + Math.round(max.y) + ")");
  return { ids, min, max };
}

scenario("launch-battle", "the test launch puts a battle over Home, deploying; Enter begins it", async (t) => {
  t.boot();
  t.expect(t.hook.top() === "home", "the app opens on the front screen");
  const b = await launchFromPlay(t);
  t.expect(t.hook.screens().join(">") === "home>battle", "the battle sits over Home (" + t.hook.screens().join(">") + ")");
  await t.waitFor(() => t.hudText().includes("ENTER to begin"), "the HUD to ask for Enter during deployment");
  t.expect(display(t.byId("hud")) !== "none", "the HUD shows during a battle");
  await begin(t, b);
  t.expect(t.hudText().includes("battle begins"), "the HUD says the battle began");
});

scenario("group-and-move", "a loop round your own men makes a company; a line marches it", async (t) => {
  t.boot();
  const b = await launchFromPlay(t);
  await begin(t, b);
  const { ids, min, max } = companyOnScreen(t, b);
  const pad = 22;
  t.stroke(t.loop((min.x + max.x) / 2, (min.y + max.y) / 2, (max.x - min.x) / 2 + pad, (max.y - min.y) / 2 + pad));
  await t.waitFor(() => b.world.groups.some((g) => g.player === 0),
    "a company to be raised by the loop (pen: " + b.pen.lastAction + ")");
  const g = b.world.groups.find((x) => x.player === 0);
  t.expect(g !== undefined, "the player has a company");
  if (!g) return;
  t.expect(g.members.length === ids.length, "the loop took exactly the men inside it (" + g.members.length + " of " + ids.length + ")");
  t.expect(b.commander.selected.includes(g.id), "the new company is selected");

  const from = t.toScreen(g.anchorX, g.anchorY);
  const to = { x: from.x, y: Math.max(40, from.y - 170) };
  const before = g.members.map((id) => [b.world.soldiers.x[id], b.world.soldiers.y[id]]);
  t.stroke(t.line(from, to));
  await t.waitFor(() => g.stance === "move",
    () => "the company to take a march order (stance " + g.stance + ", pen: " + b.pen.lastAction + ")");
  await t.sleep(2000);
  let moved = 0;
  g.members.forEach((id, i) => {
    moved += Math.hypot(b.world.soldiers.x[id] - before[i][0], b.world.soldiers.y[id] - before[i][1]);
  });
  moved /= Math.max(1, g.members.length);
  t.note("mean march " + moved.toFixed(1) + " units");
  t.expect(moved > 8, "its men moved (" + moved.toFixed(1) + " world units on average)");
});

scenario("pause-shows-paused", "Space pauses; the HUD says PAUSED; Space resumes", async (t) => {
  t.boot();
  const b = await launchFromPlay(t);
  await begin(t, b);
  t.key("Space");
  await t.frames(2);
  t.expect(b.run === "paused", "Space pauses");
  t.expect(t.hudText().startsWith("PAUSED"), "BH-01: the HUD says PAUSED (" + t.hudText().split("\n")[0] + ")");
  const tick = b.world.tick;
  await t.frames(20);
  t.expect(b.world.tick === tick, "the clock is stopped while paused");
  t.key("Period");
  t.expect(b.world.tick === tick + 1, "'.' steps a single tick while paused");
  t.key("Space");
  await t.waitFor(() => b.world.tick > tick + 3, "the clock to run again");
  t.expect(!t.hudText().includes("PAUSED"), "the PAUSED line goes when resumed");
});

scenario("second-battle-no-reload", "the report goes back to Home; a second battle starts without reload", async (t) => {
  const marker = "e2e-" + Math.random();
  (window as unknown as { __e2eMarker?: string }).__e2eMarker = marker;
  t.boot();
  const first = await launchFromPlay(t, { commander: "fox", difficulty: "colonel" });
  t.expect(first.config.commander.name === "Fox" && first.config.difficulty === "colonel", "the battle is built from the spec given");
  await begin(t, first);
  t.hook.forceOutcome(0);
  await t.waitFor(() => t.hook.top() === "after-action", "the after-action report");
  t.expect(t.hasButton("Back to the front screen"), "AA-01: the report's button names where it goes");
  t.expect(document.activeElement?.textContent === "Back to the front screen", "the report's button has focus");
  t.expect(t.hook.battle() === first, "the battle stays behind the report until the player moves on");
  t.clickButton("Back to the front screen");
  await t.waitFor(() => t.hook.top() === "home", "the button to return to Home");
  t.expect(t.hook.screens().join(">") === "home", "nothing was left on the stack (" + t.hook.screens().join(">") + ")");
  t.expect(t.hook.battle() === null, "the first battle has been torn down");
  t.expect(first.phase === "torn-down", "its phase says so");
  t.expect(document.activeElement?.textContent === K.homeButton, "focus is back on " + K.homeButton);
  t.expect(display(t.byId("hud")) === "none", "RT-01: the empty HUD is hidden behind Home");
  t.expect(display(t.byId("abilities")) === "none", "the ability bar went with the battle");
  const second = await launchFromPlay(t);
  t.expect(second !== first, "it is a new battle");
  t.expect(second.world.tick === 0 && second.world.deploying, "it starts from the beginning, deploying");
  const firstTick = first.world.tick;
  await begin(t, second);
  t.expect(first.world.tick === firstTick, "the torn-down first battle is not ticking");
  t.expect((window as unknown as { __e2eMarker?: string }).__e2eMarker === marker, "the page was never reloaded");
});

// K9: "tutorial-esc" moved to scenarios-k9.ts as "k9-drill-esc": the lesson is
// the tutorial's drill now, reached through the opening, not from Home.

scenario("home-story-only", "Home offers the Exile and nothing else to play: no Play, no Campaign, no separate lesson", async (t) => {
  t.boot();
  t.expect(t.hook.top() === "home", "the app opens on the front screen");
  t.expect(!t.hasButton("Play"), "there is no Play button (the skirmish setup is gone)");
  t.expect(!t.hasButton("Campaign"), "there is no Campaign button (the old chronicle is gone)");
  t.expect(document.getElementById("menu") === null && document.getElementById("chronicle") === null,
    "the page has no setup or chronicle screen left");
  const exile = t.button(K.homeButton);
  t.expect(exile.classList.contains("home-play"), "the Exile is the primary button");
  t.expect(document.activeElement === exile, "and has focus when the game opens (" + (document.activeElement?.textContent ?? "none") + ")");
  const actions = Array.from(document.querySelectorAll<HTMLElement>("#home .home-actions button")).filter((b) => t.visible(b));
  t.expect(actions[0] === exile, "it comes first in the row");
  // K9: the gestures are taught by the opening's tutorial, replayable from the map's Menu.
  t.expect(!t.hasButton("Learn the gestures"), "Learn the gestures is gone from Home");
  const text = t.byId("home").textContent ?? "";
  for (const stale of ["no economy", "the army you chose", "chronicle"]) {
    t.expect(!text.includes(stale), "the copy no longer says \"" + stale + "\"");
  }
});

scenario("home-figures-counted", "every figure on Home is the count its content gives", async (t) => {
  t.boot();
  const shown = Array.from(document.querySelectorAll("#home .home-figure")).map((f) => ({
    value: f.querySelector(".home-figure-value")?.textContent ?? "",
    label: f.querySelector(".home-figure-label")?.textContent ?? "",
  }));
  const want = homeFigures();
  t.expect(shown.length === want.length, "one box per counted figure (" + shown.length + " of " + want.length + ")");
  want.forEach((f, i) => {
    t.expect(shown[i]?.value === String(f.value) && shown[i]?.label === f.label,
      "\"" + f.label + "\" shows " + f.value + " (shows " + (shown[i]?.value ?? "nothing") + ")");
  });
  for (const gone of ["battlefields", "enemy commanders", "ways to win", "chapters of the chronicle"]) {
    t.expect(!shown.some((f) => f.label === gone), "no figure for a removed mode: " + gone);
  }
});

scenario("ability-keys-and-bar", "every ability has a slot on screen and a key; 0, - and = reach slots 10-12", async (t) => {
  t.boot();
  // One of every ability, on a small army: the bar's layout is the point
  // here, not the budget, and the test launch does not hold it to one.
  const b = await launchFromPlay(t, { squads: ["line", "line", "archer"], abilities: [...ABILITY_IDS] });
  const bought = ABILITY_IDS.length;
  t.note(bought + " distinct abilities");
  t.expect(bought >= 10, "at least ten distinct abilities exist, got " + bought);
  const n = b.abilityKeys.length;
  t.expect(n === bought, "one key per distinct ability (" + n + ")");
  const slots = Array.from(document.querySelectorAll<HTMLElement>("#abilities .ability"));
  t.expect(slots.length === n, "one slot per distinct ability (" + slots.length + " for " + n + ")");
  for (const s of slots) {
    const r = s.getBoundingClientRect();
    t.expect(r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.top >= 0,
      "AB-01: slot " + s.querySelector(".ability-key")?.textContent + " is inside the window (" +
      Math.round(r.left) + ".." + Math.round(r.right) + " of " + innerWidth + ")");
  }
  await begin(t, b);
  t.key("Digit0");
  t.expect(b.commander.armed === b.abilityKeys[9], "AB-01: key 0 arms the tenth (" + b.commander.armed + ")");
  t.expect(slots[9].querySelector(".ability-key")?.textContent === "0", "the tenth slot is labelled 0");
  t.key("Escape");
  t.expect(b.commander.armed === null, "GK-06: Esc puts it away");
  t.expect(t.hook.top() === "battle", "without asking to leave");
  if (n >= 12) {
    t.key("Minus");
    t.expect(b.commander.armed === b.abilityKeys[10], "- arms the eleventh");
    t.key("Equal");
    t.expect(b.commander.armed === b.abilityKeys[11], "= arms the twelfth");
    t.key("Escape");
  }
  t.click(slots[0]);
  t.expect(b.commander.armed === b.abilityKeys[0], "clicking a slot arms it");
  t.expect(document.activeElement !== slots[0], "and does not leave the button focused");
  t.key("Digit1");
  t.expect(b.commander.armed === null, "its key again disarms it");
});

scenario("middle-right-drag-pan", "middle and right drag pan the map; the left button stays the pen", async (t) => {
  t.boot();
  const b = await launchFromPlay(t);
  await begin(t, b);
  const cam = b.cam;
  const x0 = cam.x;
  const y0 = cam.y;
  const c = { x: innerWidth / 2, y: innerHeight / 2 };
  t.drag(t.line(c, { x: c.x - 100, y: c.y - 60 }), { button: 1 });
  t.expect(Math.abs(cam.x - (x0 + 100 / cam.zoom)) < 2 && Math.abs(cam.y - (y0 + 60 / cam.zoom)) < 2,
    "PC-01: middle drag moves the map with the cursor (" + (cam.x - x0).toFixed(1) + ", " + (cam.y - y0).toFixed(1) + ")");
  t.expect(!b.pen.drawing && !b.world.groups.some((g) => g.player === 0), "the middle drag drew nothing");
  t.expect(!t.byId("stage").classList.contains("panning"), "the grab cursor is dropped on release");
  const x1 = cam.x;
  t.drag(t.line(c, { x: c.x + 80, y: c.y }), { button: 2 });
  t.expect(Math.abs(cam.x - (x1 - 80 / cam.zoom)) < 2, "right drag pans too");
  const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  t.byId("stage").dispatchEvent(menu);
  t.expect(menu.defaultPrevented, "the browser's context menu is suppressed on the map");
  const x2 = cam.x;
  t.stroke(t.line(c, { x: c.x + 120, y: c.y }), { release: false });
  t.expect(b.pen.drawing && cam.x === x2, "a left drag is a pen stroke, never a pan");
  t.key("Escape");
});

scenario("overlay-blocks-input", "while a dialog is up the map takes no keys and no strokes", async (t) => {
  t.boot();
  const b = await launchFromPlay(t);
  await begin(t, b);
  t.key("Escape");
  t.expect(t.hook.top() === "confirm", "the leave question is up");
  const x0 = b.cam.x;
  t.keyDown("KeyD");
  await t.frames(20);
  t.keyUp("KeyD");
  t.expect(b.cam.x === x0, "GK-03: WASD does not pan behind the dialog");
  t.keyDown("Space");
  t.keyUp("Space");
  t.expect(b.run === "running", "GK-02: Space on the focused button does not toggle the pause behind it");
  const c = { x: innerWidth / 2, y: innerHeight / 2 };
  t.stroke(t.line(c, { x: c.x + 50, y: c.y }), { release: false });
  t.expect(!b.pen.drawing, "a stroke over the dialog never reaches the pen");
  t.key("Escape");
  t.expect(t.hook.top() === "battle", "Esc closes the dialog");
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  t.keyDown("KeyD");
  await t.frames(20);
  t.keyUp("KeyD");
  t.expect(b.cam.x > x0, "and D pans again once it is gone (" + (b.cam.x - x0).toFixed(1) + ")");
  t.keyDown("KeyD", { ctrl: true });
  const x1 = b.cam.x;
  await t.frames(10);
  t.keyUp("KeyD");
  t.expect(b.cam.x === x1, "PC-22: Ctrl+D is not a pan");
});

scenario("leave-battle-returns-home", "Esc then Leave the field tears the battle down and returns to Home", async (t) => {
  t.boot();
  const b = await launchFromPlay(t, { commander: "owl" });
  t.key("Escape");
  t.expect(t.hook.top() === "confirm", "Esc with nothing to cancel asks before leaving");
  const body = document.querySelector("#dialog")?.textContent ?? "";
  t.expect(body.includes("front screen"), "the question says where leaving goes (" + body + ")");
  t.clickButton("Leave the field");
  await t.waitFor(() => t.hook.top() === "home", "the front screen");
  t.expect(b.phase === "torn-down" && t.hook.battle() === null, "the battle was torn down");
  t.expect(t.hook.screens().join(">") === "home", "nothing was left on the stack");
});

// K9: "lesson-report-home" is gone with the lesson's Home button: nothing ends
// the drill but the coach (app.ts battleEnded), so it has no report to leave by.
