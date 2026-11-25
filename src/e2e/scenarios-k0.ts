/**
 * K0 scenarios: the layer controller, the screen stack and the key router, as
 * a player meets them. Every input is a real DOM event (see harness.ts).
 */

import { UNIT_TYPES } from "../content/unit-types.ts";
import { FIRST_CHAPTER, freshProgress, recordBattle } from "../content/campaign.ts";
import { CHRONICLE_KEY } from "../app/progress-store.ts";
import type { BattleLayer } from "../app/battle-layer.ts";
import { memoryStorage, scenario, type Driver, type Pt } from "./harness.ts";

/** The live battle, or a failure. */
function battleOf(t: Driver): BattleLayer {
  const b = t.hook.battle();
  t.expect(b !== null, "a battle is live");
  return b as BattleLayer;
}

function display(el: HTMLElement): string {
  return getComputedStyle(el).display;
}

/** Home -> Play -> Take the field with the suggested army. Leaves it deploying. */
async function launchFromPlay(t: Driver): Promise<BattleLayer> {
  t.clickButton("Play");
  t.expect(t.hook.top() === "menu", "Play opens the setup screen (top: " + t.hook.top() + ")");
  t.clickButton("Take the field");
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

scenario("launch-battle", "Play with the suggested army launches a battle; Enter begins it", async (t) => {
  t.boot();
  t.expect(t.hook.top() === "home", "the app opens on the front screen");
  const b = await launchFromPlay(t);
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

scenario("second-battle-no-reload", "after-action Fight again returns to the setup as left; a second battle starts without reload", async (t) => {
  const marker = "e2e-" + Math.random();
  (window as unknown as { __e2eMarker?: string }).__e2eMarker = marker;
  t.boot();
  t.clickButton("Play");
  // Choices that leave the army legal: a doctrine re-prices the reserve and
  // can put the suggested army over budget.
  t.clickButton("Fox");
  t.clickButton("Colonel");
  const budget = document.querySelector("#menu .budget")?.textContent ?? "";
  const chosen = Array.from(document.querySelectorAll("#menu .choice.on")).map((e) => e.textContent).join("|");
  t.clickButton("Take the field");
  await t.waitFor(() => t.hook.top() === "battle", "the first battle");
  const first = battleOf(t);
  t.expect(first.config.commander.name === "Fox" && first.config.difficulty === "colonel", "the battle is built from the setup chosen");
  await begin(t, first);
  t.hook.forceOutcome(0);
  await t.waitFor(() => t.hook.top() === "after-action", "the after-action report");
  t.expect(t.hasButton("Fight again"), "the report offers Fight again");
  t.expect(document.activeElement?.textContent === "Fight again", "the report's button has focus");
  t.expect(t.hook.battle() === first, "the battle stays behind the report until the player moves on");
  t.clickButton("Fight again");
  await t.waitFor(() => t.hook.top() === "menu", "Fight again to return to the setup");
  t.expect(t.hook.battle() === null, "the first battle has been torn down");
  t.expect(first.phase === "torn-down", "its phase says so");
  t.expect((document.querySelector("#menu .budget")?.textContent ?? "") === budget, "the army is as it was left");
  t.expect(Array.from(document.querySelectorAll("#menu .choice.on")).map((e) => e.textContent).join("|") === chosen,
    "the choices (Fox, Colonel) are as they were left");
  t.expect(document.activeElement?.textContent === "Take the field", "focus is back on Take the field");
  t.expect(display(t.byId("hud")) === "none", "RT-01: the empty HUD is hidden behind the setup");
  t.expect(display(t.byId("abilities")) === "none", "the ability bar went with the battle");
  t.clickButton("Take the field");
  await t.waitFor(() => t.hook.top() === "battle", "the second battle");
  const second = battleOf(t);
  t.expect(second !== first, "it is a new battle");
  t.expect(second.world.tick === 0 && second.world.deploying, "it starts from the beginning, deploying");
  const firstTick = first.world.tick;
  await begin(t, second);
  t.expect(first.world.tick === firstTick, "the torn-down first battle is not ticking");
  t.expect((window as unknown as { __e2eMarker?: string }).__e2eMarker === marker, "the page was never reloaded");
});

scenario("tutorial-esc", "in the lesson Esc cancels a stroke first, then asks before leaving", async (t) => {
  t.boot();
  t.clickButton("Learn the gestures");
  await t.waitFor(() => t.hook.top() === "battle", "the lesson");
  const b = battleOf(t);
  t.expect(b.config.mode === "lesson", "it is the lesson");
  t.expect(b.world.ai.length === 0, "BS-05: no enemy commander can attack the lesson");
  t.expect(b.world.duration >= 3600, "BS-05: no clock can end the lesson (" + b.world.duration + "s)");
  await t.waitFor(() => t.hudText().startsWith("lesson"), () => "the HUD to show no countdown (" + t.hudText().split("\n")[0] + ")");

  const c = { x: innerWidth / 2, y: innerHeight / 2 };
  t.stroke(t.line(c, { x: c.x + 80, y: c.y + 30 }), { release: false });
  t.expect(b.pen.drawing, "a stroke is being drawn");
  t.key("Escape");
  t.expect(!b.pen.drawing, "Esc cancels the stroke");
  t.expect(t.hook.top() === "battle", "and does not leave the lesson (PC-06/BS-04)");
  t.expect(b.phase === "live", "the lesson is still running");

  t.key("Escape");
  t.expect(t.hook.top() === "confirm", "Esc with nothing to cancel asks before leaving");
  t.expect(document.activeElement?.textContent === "Stay", "focus starts on the safe choice");
  const tick = b.world.tick;
  await t.frames(15);
  t.expect(b.world.tick === tick, "the lesson is held while the question is up");
  t.key("Tab");
  t.expect(document.activeElement?.textContent === "Leave the lesson", "Tab moves within the dialog");
  t.key("Tab");
  t.expect(document.activeElement?.textContent === "Stay", "and stays trapped inside it");
  t.key("Escape");
  t.expect(t.hook.top() === "battle", "Esc on the question means stay");
  await t.waitFor(() => b.world.tick > tick, "the lesson to run again");

  t.key("Escape");
  t.clickButton("Leave the lesson");
  await t.waitFor(() => t.hook.top() === "home", "leaving to reach the front screen");
  t.expect(t.hook.battle() === null && b.phase === "torn-down", "the lesson was torn down");
  t.expect(display(t.byId("hud")) === "none", "the HUD is hidden on the front screen");
  t.expect(document.activeElement?.textContent === "Learn the gestures", "focus is back where the player left it");
});

scenario("storage-refused", "with storage refused the chronicle says so and keeps progress in memory", async (t) => {
  t.boot({ storage: () => { throw new DOMException("storage refused by e2e", "SecurityError"); } });
  t.expect(t.hook.storage().kind === "memory-only", "the store reports the refusal");
  t.clickButton("Campaign");
  t.expect(t.hook.top() === "chronicle", "Campaign opens the chronicle");
  const notice = document.querySelector("#chronicle .storage-notice");
  t.expect(t.visible(notice), "BS-01: the chronicle says progress cannot be saved");
  t.clickButton("March");
  t.expect(t.hook.top() === "menu", "March opens the chapter's setup");
  t.clickButton("Take the field");
  await t.waitFor(() => t.hook.top() === "battle", "the chapter's battle");
  const b = battleOf(t);
  await begin(t, b);
  t.hook.forceOutcome(0);
  await t.waitFor(() => t.hook.top() === "after-action", "the report");
  t.expect(t.visible(document.querySelector("#report .storage-notice")), "the report repeats the notice");
  t.clickButton("Continue the chronicle");
  await t.waitFor(() => t.hook.top() === "chronicle", "Continue to return to the chronicle");
  const rows = document.querySelectorAll("#chronicle .chronicle-row");
  t.expect(rows.length === 1 && rows[0].classList.contains("won"), "the won battle is written down, from memory");
  const heads = Array.from(document.querySelectorAll("#chronicle h2")).map((h) => h.textContent ?? "");
  t.expect(!heads.some((h) => h.startsWith("Chapter 1:")), "the chronicle has moved past chapter 1 (" + heads.join(" / ") + ")");
});

scenario("storage-write-refused", "storage that reads but will not write is caught too", async (t) => {
  t.boot({
    storage: () => ({
      getItem: () => null,
      setItem: () => { throw new DOMException("full", "QuotaExceededError"); },
      removeItem: () => {},
    }),
  });
  t.expect(t.hook.storage().kind === "memory-only", "a write refusal is detected up front");
  t.clickButton("Campaign");
  t.expect(t.visible(document.querySelector("#chronicle .storage-notice")), "and shown");
});

scenario("menu-back-esc", "Back and Esc leave the setup screen and the chronicle", async (t) => {
  t.boot();
  t.clickButton("Play");
  t.expect(t.hook.top() === "menu", "the setup screen is up");
  t.key("Escape");
  t.expect(t.hook.top() === "home", "BS-02: Esc goes back from the setup screen");
  t.expect(document.activeElement?.textContent === "Play", "focus returns to Play");
  t.clickButton("Play");
  t.clickButton("Back");
  t.expect(t.hook.top() === "home", "BS-02: Back goes back from the setup screen");
  t.clickButton("Campaign");
  t.key("Escape");
  t.expect(t.hook.top() === "home", "Esc goes back from the chronicle");
  t.clickButton("Campaign");
  t.clickButton("March");
  t.key("Escape");
  t.expect(t.hook.top() === "chronicle", "Esc from a chapter's setup goes back to the chronicle");
  t.expect(t.hook.screens().join(">") === "home>chronicle", "nothing was left on the stack");
});

scenario("chronicle-restart-confirm", "Start the chronicle over asks first, focused on keeping it", async (t) => {
  const seeded = JSON.stringify(recordBattle(freshProgress(), FIRST_CHAPTER, true));
  const store = memoryStorage({ [CHRONICLE_KEY]: seeded });
  t.boot({ storage: () => store });
  t.clickButton("Campaign");
  t.expect(document.querySelectorAll("#chronicle .chronicle-row").length === 1, "one battle is written down");
  t.clickButton("Start the chronicle over");
  t.expect(t.hook.top() === "confirm", "BS-03: it asks first");
  t.expect(document.activeElement?.textContent === "Keep it", "focus starts on keeping it");
  t.key("Escape");
  t.expect(t.hook.top() === "chronicle", "Esc keeps it");
  t.expect(document.querySelectorAll("#chronicle .chronicle-row").length === 1, "and the record is intact");
  t.expect(document.activeElement?.textContent === "Start the chronicle over", "focus goes back to the button");
  t.clickButton("Start the chronicle over");
  t.clickButton("Keep it");
  t.expect(document.querySelectorAll("#chronicle .chronicle-row").length === 1, "Keep it keeps it");
  t.clickButton("Start the chronicle over");
  t.clickButton("Start over");
  t.expect(t.hook.top() === "chronicle", "confirming returns to the chronicle");
  t.expect(document.querySelectorAll("#chronicle .chronicle-row").length === 0, "which starts again");
  t.expect(store.getItem(CHRONICLE_KEY) !== seeded, "and the fresh chronicle is saved");
});

/**
 * On the setup screen, buy one of every ability with the store's own + buttons,
 * then pay for them by sending companies home with the roster's - buttons, the
 * way a player would. Returns how many distinct abilities ended up bought.
 */
function buyEveryAbility(t: Driver): number {
  const rosters = document.querySelectorAll("#menu .roster");
  t.expect(rosters.length === 2, "the setup screen has a roster and a store");
  const rowsOf = (r: Element): HTMLElement[] => Array.from(r.querySelectorAll<HTMLElement>(".unit"));
  const count = (row: HTMLElement): number => Number(row.querySelector(".count")?.textContent ?? "0");
  const minus = (row: HTMLElement): HTMLElement => row.querySelectorAll<HTMLElement>("button")[0];
  const plus = (row: HTMLElement): HTMLElement => row.querySelectorAll<HTMLElement>("button")[1];
  const start = t.button("Take the field");
  const units = rowsOf(rosters[0]);
  const store = rowsOf(rosters[1]);
  for (const row of store) if (count(row) === 0) t.click(plus(row));
  const squads = (): number => units.reduce((n, r) => n + count(r), 0);
  for (const row of units.slice().reverse()) {
    while (start.disabled && count(row) > 0 && squads() > 1) t.click(minus(row));
  }
  // Should the whole store still not be affordable, give back the dearest
  // last few until it is.
  for (const row of store.slice().reverse()) {
    if (!start.disabled) break;
    while (start.disabled && count(row) > 0) t.click(minus(row));
  }
  t.expect(!start.disabled, "a legal army with the abilities bought (" +
    (document.querySelector("#menu .problems")?.textContent ?? "") + ")");
  return store.filter((r) => count(r) > 0).length;
}

scenario("ability-keys-and-bar", "every bought ability has a slot on screen and a key; 0, - and = reach slots 10-12", async (t) => {
  t.boot();
  t.clickButton("Play");
  const bought = buyEveryAbility(t);
  t.note(bought + " distinct abilities bought");
  t.expect(bought >= 10, "at least ten distinct abilities could be bought, got " + bought);
  t.clickButton("Take the field");
  await t.waitFor(() => t.hook.top() === "battle", "the battle");
  const b = battleOf(t);
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

scenario("leave-battle-keeps-setup", "Esc then Leave the field returns to the setup as it was", async (t) => {
  t.boot();
  t.clickButton("Play");
  t.clickButton("Owl");
  t.clickButton("Take the field");
  await t.waitFor(() => t.hook.top() === "battle", "the battle");
  const b = battleOf(t);
  t.key("Escape");
  t.clickButton("Leave the field");
  await t.waitFor(() => t.hook.top() === "menu", "the setup screen");
  t.expect(b.phase === "torn-down", "the battle was torn down");
  const on = Array.from(document.querySelectorAll("#menu .choice.on")).map((e) => e.textContent);
  t.expect(on.includes("Owl"), "the commander chosen is still chosen");
});
