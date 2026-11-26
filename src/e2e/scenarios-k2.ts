/**
 * K2 scenarios: the kingdom map as a player meets it -- reached from Home,
 * drawn, read by tapping, ordered by pen, run in real time, paused, stepped,
 * left and continued. Every input is a real DOM event (see harness.ts); the
 * test hook is only read, to find where the king and the holdings are drawn.
 */

import type { KingdomLayer } from "../app/kingdom-layer.ts";
import { kingCounterAt } from "../render/kingdom/layout.ts";
import { K, NONE_REASON } from "../content/kingdom/ui-strings.ts";
import { MONTHS } from "../content/kingdom/terrain.ts";
import { KINGDOM_SAVE_KEY } from "../app/kingdom-save.ts";
import { memoryStorage, scenario, type Driver, type Pt } from "./harness.ts";

function realmOf(t: Driver): KingdomLayer {
  const k = t.hook.kingdom();
  t.expect(k !== null, "the kingdom map is live (screens: " + t.hook.screens().join(" > ") + ")");
  return k as KingdomLayer;
}

/** Home -> The Exile of Rimaros. */
async function openExile(t: Driver): Promise<KingdomLayer> {
  t.clickButton(K.homeButton);
  await t.waitFor(() => t.hook.top() === "kingdom", () => "the kingdom screen (top: " + t.hook.top() + ")");
  const k = realmOf(t);
  await t.waitFor(() => k.renderer.stats.frames > 2, "the map to draw a few frames");
  return k;
}

/** A map point on screen, through the kingdom camera. */
function onScreen(t: Driver, k: KingdomLayer, x: number, y: number): Pt {
  const r = t.byId("stage").getBoundingClientRect();
  return { x: r.left + k.cam.worldToScreenX(x), y: r.top + k.cam.worldToScreenY(y) };
}

function holdingNamed(k: KingdomLayer, name: string): { id: number; x: number; y: number } {
  const h = k.world.holdings.find((x) => x.name === name);
  if (!h) throw new Error("no holding " + name);
  return h;
}

/** The king's counter, where it is drawn (30 px above his true point). */
function kingOnScreen(t: Driver, k: KingdomLayer): Pt {
  const c = kingCounterAt(k.kingDrawn(), k.cam.pxToWorld);
  return onScreen(t, k, c.x, c.y);
}

function tap(t: Driver, p: Pt): void {
  t.stroke([p, { x: p.x + 1, y: p.y }]);
}

/** Lift a held stroke with a real pointerup on the element that got the stroke. */
function release(target: EventTarget, p: Pt): void {
  target.dispatchEvent(new PointerEvent("pointerup", {
    bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true,
    clientX: p.x, clientY: p.y, button: 0, buttons: 0,
  }));
}

/** The visible text of the kingdom HUD. */
function kingdomText(t: Driver): string {
  const ui = document.getElementById("kingdom-ui");
  return ui && t.visible(ui) ? ui.textContent ?? "" : "";
}

scenario("k2-open-exile", "Home's Exile button opens the kingdom map over Home", async (t) => {
  t.boot();
  t.expect(t.hasButton(K.homeButton), "Home offers " + K.homeButton);
  t.expect(!t.hasButton("Campaign") && !t.hasButton("Play"), "the story is the game: no Campaign or Play beside it");
  t.expect(!t.hasButton(K.homeNew), "no 'Begin a new exile' before there is a realm to replace");
  const k = await openExile(t);
  t.expect(t.hook.screens().join(">") === "home>kingdom", "stack is home>kingdom (" + t.hook.screens().join(">") + ")");
  t.expect(k.world.now === 0, "a fresh realm starts at tick 0 (was " + k.world.now + ")");
  t.expect(kingdomText(t).includes("1 Harvestmoon, Year 1"), "the HUD shows the twelve-month date (" + kingdomText(t).slice(0, 80) + ")");
});

scenario("k2-map-renders", "the parchment map draws, with the king's counter on it", async (t) => {
  t.boot();
  const k = await openExile(t);
  const s = k.renderer.stats;
  t.expect(s.holdings > 0 && s.roads > 0, "holdings and roads are drawn (" + s.holdings + ", " + s.roads + ")");
  t.expect(s.king, "the king's counter is drawn");
  t.expect(s.labels > 0, "some names are lettered");
  const canvas = t.byId("stage") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d");
  const probe = ctx ? ctx.getImageData(0, 0, Math.max(1, canvas.width), Math.max(1, canvas.height)) : null;
  if (!probe || probe.data.length < 64) {
    t.note("pixel check skipped: this page has no real canvas pixels");
  } else {
    // Non-blank: sample a grid and require several distinct colours.
    const seen = new Set<number>();
    const w = canvas.width;
    const h = canvas.height;
    for (let gy = 1; gy < 8; gy++) {
      for (let gx = 1; gx < 8; gx++) {
        const i = ((Math.floor((gy * h) / 8) * w) + Math.floor((gx * w) / 8)) * 4;
        seen.add((probe.data[i] << 16) | (probe.data[i + 1] << 8) | probe.data[i + 2]);
      }
    }
    t.expect(seen.size >= 3, "the canvas is not blank (" + seen.size + " colours in a 7x7 sample)");
  }
});

scenario("k2-region-card", "tapping a holding opens its card; Esc closes it", async (t) => {
  t.boot();
  const k = await openExile(t);
  const g = holdingNamed(k, "Greyshaw");
  tap(t, onScreen(t, k, g.x, g.y));
  await t.waitFor(() => t.hook.top() === "region-card", () => "the region card (top: " + t.hook.top() + ")");
  const text = kingdomText(t);
  t.expect(text.includes("Greyshaw"), "the card names the holding");
  t.expect(text.includes(K.held) && text.includes(K.people) && text.includes(K.slots), "the card shows owner, people and slots");
  t.expect(k.card !== null && k.card.holding === g.id, "the layer knows which card is open");
  t.key("Escape");
  t.expect(t.hook.top() === "kingdom", "Esc closes the card (top: " + t.hook.top() + ")");
  t.expect(k.card === null, "and the layer forgets it");
  // The king's card, by tapping his counter.
  tap(t, kingOnScreen(t, k));
  await t.waitFor(() => t.hook.top() === "king-card", () => "the king card (top: " + t.hook.top() + ")");
  t.expect(kingdomText(t).includes(k.world.king.name), "the king card names the king");
  t.key("Escape");
  t.expect(t.hook.top() === "kingdom", "Esc closes the king card");
});

scenario("k2-march-ghost", "a line from the king to a neighbour shows a ghost and ETA, and release sets the route", async (t) => {
  t.boot();
  const k = await openExile(t);
  const dest = holdingNamed(k, "Thornwick");
  const from = kingOnScreen(t, k);
  const to = onScreen(t, k, dest.x, dest.y);
  const target = t.stroke(t.line(from, to), { release: false });
  const preview = k.intent;
  t.expect(preview !== null && preview.ghost.kind === "march", "the stroke previews a march (" + (preview ? preview.ghost.kind : "none") + ")");
  const label = preview && preview.ghost.kind === "march" ? preview.ghost.label : "";
  t.expect(label.startsWith("March to Thornwick") && label.includes("about"), "the ghost plate names the place and an ETA (" + label + ")");
  t.expect(preview !== null && preview.order !== null && preview.order.kind === "moveKing", "the preview's order is a moveKing");
  release(target, to);
  const done = k.committed;
  t.expect(done !== null && JSON.stringify(done.order) === JSON.stringify(preview?.order), "release commits exactly the previewed order");
  await t.waitFor(() => {
    const r = k.world.king.mover.route;
    return r.length > 0 && r[r.length - 1] === dest.id;
  }, "the king's mover to take the route to Thornwick");
  t.expect(kingdomText(t).includes("sets out for Thornwick"), "the result line says so");
  // The king's card shows the march and can halt it.
  t.key("Space");
  tap(t, kingOnScreen(t, k));
  t.expect(t.hook.top() === "king-card", "tapping the marching king opens the king card (top: " + t.hook.top() + ")");
  t.expect(kingdomText(t).includes("Thornwick, about"), "the card says where the king is marching");
  t.clickButton(K.halt);
  t.key("Period");
  t.expect(k.world.king.mover.route.length === 0, "Halt stops the march once the clock moves");
});

scenario("k2-stroke-means-nothing", "a stroke that orders nothing says why", async (t) => {
  t.boot();
  const k = await openExile(t);
  const a = onScreen(t, k, 600, 400);
  const b = onScreen(t, k, 640, 420);
  t.stroke(t.line(a, b));
  t.expect(k.committed !== null && k.committed.order === null, "no order is issued");
  t.expect(kingdomText(t).includes(NONE_REASON["not-from-king"]), "the result line explains (" + kingdomText(t).slice(-120) + ")");
  t.expect(k.world.orders.queued().length === 0, "nothing is queued");
});

scenario("k2-pause", "Space pauses, PAUSED shows, and the date stands still", async (t) => {
  t.boot();
  const k = await openExile(t);
  t.key("Space");
  t.expect(k.clock.run === "paused", "Space pauses");
  t.expect(k.hud.bannerShown && kingdomText(t).includes("PAUSED"), "PAUSED is shown");
  const now = k.world.now;
  const date = k.hud.dateText;
  await t.frames(60);
  t.expect(k.world.now === now, "no tick while paused (" + now + " -> " + k.world.now + ")");
  t.expect(k.hud.dateText === date, "the date does not move");
  t.key("Space");
  t.expect(k.clock.run === "running" && !k.hud.bannerShown, "Space again resumes");
});

scenario("k2-step-day", "'.' steps exactly one day while paused, and asks to pause otherwise", async (t) => {
  t.boot();
  const k = await openExile(t);
  t.key("Period");
  t.expect(k.hud.resultText === K.pauseFirst, "'.' while running says to pause first");
  t.key("Space");
  const now = k.world.now;
  const day = k.world.date.day;
  t.key("Period");
  t.expect(k.world.now === now + 8, "one day is eight ticks (" + now + " -> " + k.world.now + ")");
  t.expect(k.world.date.day === day + 1, "the day advances by one");
  // ECON: the HUD reads the twelve-month date ("2 Harvestmoon, Year 1 · Autumn").
  t.expect(k.hud.dateText.startsWith((k.world.date.dayOfMonth + 1) + " " + MONTHS[k.world.date.month].name + ", Year "),
    "the HUD shows it (" + k.hud.dateText + ")");
});

scenario("k2-speed", "4x runs the realm faster than 1x", async (t) => {
  t.boot();
  const k = await openExile(t);
  t.key("Digit1");
  t.expect(k.clock.speed === 1, "1 sets 1x");
  let n0 = k.world.now;
  await t.frames(120);
  const slow = k.world.now - n0;
  t.clickButton("4×");
  t.expect(k.clock.speed === 4 && k.clock.run === "running", "the 4x button sets 4x");
  n0 = k.world.now;
  await t.frames(120);
  const fast = k.world.now - n0;
  t.note("ticks in 120 frames: 1x " + slow + ", 4x " + fast);
  t.expect(slow > 0, "1x moves the clock");
  t.expect(fast > slow * 2.5, "4x is clearly faster (1x " + slow + ", 4x " + fast + ")");
  t.key("Digit2");
  t.expect(k.clock.speed === 2, "2 sets 2x");
});

scenario("k2-continue", "leaving to Home saves, and the Exile button continues the same realm", async (t) => {
  t.boot();
  let k = await openExile(t);
  const dest = holdingNamed(k, "Greyshaw");
  t.stroke(t.line(kingOnScreen(t, k), onScreen(t, k, dest.x, dest.y)));
  await t.waitFor(() => k.world.king.mover.route.length > 0, "the march to start");
  await t.waitFor(() => k.world.now >= 10, "a day to pass");
  t.expect(k.saves > 0 && k.lastSave !== null && k.lastSave.ok, "the day boundary autosaved");
  t.key("Escape");
  t.expect(t.hook.top() === "home", "Esc with nothing to cancel goes back to Home (top: " + t.hook.top() + ")");
  t.expect(k.phase === "torn-down", "the kingdom layer is torn down");
  const at = k.world.now;
  const route = k.world.king.mover.route.join(",");
  t.expect(document.getElementById("kingdom-ui") === null, "the kingdom HUD is gone from the page");
  t.expect(t.hasButton(K.homeNew), "Home now offers 'Begin a new exile'");
  t.expect((t.byId("home").textContent ?? "").includes("Continue:"), "Home says where the realm stands");

  // A new exile sits behind a confirm, and keeping is the safe answer.
  t.clickButton(K.homeNew);
  t.expect(t.hook.top() === "confirm", "'Begin a new exile' asks first (top: " + t.hook.top() + ")");
  t.clickButton(K.newNo);
  t.expect(t.hook.top() === "home", "'Keep my realm' goes back to Home");

  k = await openExile(t);
  // A tick or two may run in the frames openExile waits for; never fewer, and never a fresh realm.
  t.expect(k.world.now >= at && k.world.now <= at + 3, "the realm continues where it was left (" + at + " -> " + k.world.now + ")");
  t.expect(k.world.king.mover.route.join(",") === route, "the march continues too");
});

scenario("k2-unreadable-save-asks", "an unreadable save is never replaced without asking (U1-15)", async (t) => {
  const store = memoryStorage({ [KINGDOM_SAVE_KEY]: "{ not a save" });
  t.boot({ storage: () => store });
  t.clickButton(K.homeButton);
  t.expect(t.hook.top() === "confirm", "the Exile button asks first (top: " + t.hook.top() + ")");
  t.expect((t.byId("dialog").textContent ?? "").includes(K.unreadableTitle), "and says the save cannot be read");
  t.clickButton(K.unreadableNo);
  t.expect(t.hook.top() === "home", "keeping it goes back to Home");
  t.expect(store.getItem(KINGDOM_SAVE_KEY) === "{ not a save", "the damaged save is untouched");
  t.clickButton(K.homeButton);
  t.clickButton(K.unreadableYes);
  const k = realmOf(t);
  t.expect(k.world.now === 0, "the other answer begins a new exile");
});

scenario("k2-no-storage-says-so", "with no storage the realm runs in memory and says it is not being saved", async (t) => {
  t.boot({ storage: () => null });
  const k = await openExile(t);
  t.expect(k.hud.noticeText.includes("not being saved"), "a standing notice says so (" + k.hud.noticeText + ")");
});

scenario("k2-esc-order", "Esc closes a card before it leaves the map; the Front screen button leaves too", async (t) => {
  t.boot();
  const k = await openExile(t);
  const g = holdingNamed(k, "Greyshaw");
  tap(t, onScreen(t, k, g.x, g.y));
  t.expect(t.hook.top() === "region-card", "a card is open");
  // Space with the card open still pauses: the card focuses its heading, not a button.
  t.key("Space");
  t.expect(k.clock.run === "paused", "Space pauses with a card open");
  t.key("Escape");
  t.expect(t.hook.top() === "kingdom", "the first Esc closes the card");
  t.clickButton(K.frontScreen);
  t.expect(t.hook.top() === "home", "the Front screen button goes back to Home");
});
