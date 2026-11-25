/**
 * K2 fix scenarios: pen feedback (PC-02, PC-04), fog honesty (RF-06) and the
 * one scaling policy (BS-06), checked as a player meets them. Every input is a
 * real DOM event (see harness.ts); state is read through the TestHook.
 */

import type { BattleLayer } from "../app/battle-layer.ts";
import { scenario, type Driver, type Pt } from "./harness.ts";

function battleOf(t: Driver): BattleLayer {
  const b = t.hook.battle();
  t.expect(b !== null, "a battle is live");
  return b as BattleLayer;
}

async function launch(t: Driver): Promise<BattleLayer> {
  t.clickButton("Play");
  t.expect(t.hook.top() === "menu", "Play opens the setup screen");
  t.clickButton("Take the field");
  await t.waitFor(() => t.hook.top() === "battle", "the battle screen");
  const b = battleOf(t);
  t.expect(b.world.deploying, "a battle opens on deployment");
  return b;
}

async function begin(t: Driver, b: BattleLayer): Promise<void> {
  t.key("Enter");
  t.expect(!b.world.deploying, "Enter begins the battle");
  const t0 = b.world.tick;
  await t.waitFor(() => b.world.tick > t0 + 2, "the clock to run after Enter");
}

/** Screen box of the player's men nearest the middle of the screen, loose or not. */
function menNearMiddle(t: Driver, b: BattleLayer): { min: Pt; max: Pt } {
  const s = b.world.soldiers;
  const mid = { x: innerWidth / 2, y: innerHeight / 2 };
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < s.count; i++) {
    if (s.player[i] !== 0 || s.alive[i] !== 1) continue;
    const p = t.toScreen(s.x[i], s.y[i]);
    const d = Math.hypot(p.x - mid.x, p.y - mid.y);
    if (d < bestD) { bestD = d; best = i; }
  }
  t.expect(best >= 0, "the player has men on the field");
  const c = t.toScreen(s.x[best], s.y[best]);
  return { min: { x: c.x - 40, y: c.y - 40 }, max: { x: c.x + 40, y: c.y + 40 } };
}

/** Raise one company from the men nearest the middle; returns it. */
async function raiseCompany(t: Driver, b: BattleLayer): Promise<number> {
  const before = new Set(b.world.groups.map((g) => g.id));
  const { min, max } = menNearMiddle(t, b);
  t.stroke(t.loop((min.x + max.x) / 2, (min.y + max.y) / 2, 70, 70));
  await t.waitFor(() => b.world.groups.some((g) => g.player === 0 && !before.has(g.id)),
    () => "a company to be raised by the loop (pen: " + b.pen.lastAction + ")");
  const g = b.world.groups.find((x) => x.player === 0 && !before.has(x.id));
  return g ? g.id : -1;
}

scenario("k2-pen-rejects-visibly", "PC-02: a stroke that does nothing stays on screen as rejected ink, and says why", async (t) => {
  t.boot();
  const b = await launch(t);
  await begin(t, b);
  b.commander.selected = [];
  // A zig-zag on open ground near the top of the view, with nothing selected.
  const pts: Pt[] = [];
  for (let i = 0; i < 24; i++) pts.push({ x: 120 + i * 6, y: 120 + (i % 2) * 30 });
  t.stroke(pts);
  await t.frames(2);
  t.expect(b.pen.rejected !== null, "the pen keeps the refused stroke to draw it greyed (PC-02)");
  const why = b.pen.rejected ? b.pen.rejected.why : "";
  t.expect(why.length > 8, "the refusal carries a reason (" + why + ")");
  await t.waitFor(() => t.hudText().includes(why), () => "the HUD to say why (" + t.hudText().split("\n").slice(-1)[0] + ")", 2000);
});

scenario("k2-deploy-drag-places", "PC-04: dragging a company while setting out moves it and does not change its shape", async (t) => {
  t.boot();
  const b = await launch(t);
  const id = await raiseCompany(t, b);
  const g = b.world.groupById(id);
  t.expect(g !== null, "a company was raised");
  if (!g) return;
  const shape = g.shape;
  const from = t.toScreen(g.anchorX, g.anchorY);
  // A short drag down the zone, kept inside it.
  t.stroke(t.line(from, { x: from.x, y: from.y + 50 }));
  await t.frames(3);
  t.expect(b.pen.lastAction === "placed", "the HUD says the company was placed (" + b.pen.lastAction + ")");
  t.expect(g.shape === shape, "its shape is unchanged (" + shape + " -> " + g.shape + ")");
  const now = t.toScreen(g.anchorX, g.anchorY);
  const moved = Math.hypot(now.x - from.x, now.y - from.y);
  t.expect(moved > 20, "it moved with the pen (" + moved.toFixed(0) + " px)");
  t.expect(b.world.deploying && b.world.tick === 0, "and the battle has not started");
});

scenario("k2-marks-hold-while-paused", "RF-06: a last-seen mark does not fade while the battle is paused, and does once it runs", async (t) => {
  t.boot();
  const b = await launch(t);
  await begin(t, b);
  await t.waitFor(() => b.world.groups.some((g) => g.player === 1 && !g.seenBy[0]),
    "an enemy company out of sight", 8000);
  const foe = b.world.groups.find((g) => g.player === 1 && !g.seenBy[0]);
  if (!foe) return;
  // Plant a mark four seconds old where the company stands, unobserved.
  b.noteSightingForTest(foe.id, foe.anchorX, foe.anchorY, 4 * 20);
  t.key("Space");
  await t.frames(2);
  t.expect(b.run === "paused", "Space pauses");
  const held = b.lastSeenFade(foe.id);
  t.expect(held > 0 && held < 1, "the mark is part-faded (" + held.toFixed(2) + ")");
  await t.sleep(1200);
  const after = b.lastSeenFade(foe.id);
  t.expect(after === held, "it holds still while paused (" + held.toFixed(3) + " -> " + after.toFixed(3) + ")");
  t.key("Space");
  const tick = b.world.tick;
  await t.waitFor(() => b.world.tick > tick + 20, "the clock to run again");
  const later = b.lastSeenFade(foe.id);
  t.expect(later < held, "and fades as the battle runs (" + held.toFixed(3) + " -> " + later.toFixed(3) + ")");
});

/** Every text-bearing element of a screen, by its computed size. */
function smallText(root: Element): string[] {
  const out: string[] = [];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const e = el as HTMLElement;
    if (!e.textContent || e.textContent.trim() === "" || e.children.length > 0) continue;
    // The harness's own results panel is not part of the game.
    if (e.closest("#e2e-results")) continue;
    const size = parseFloat(getComputedStyle(e).fontSize || "");
    if (!Number.isFinite(size)) continue;
    if (size < 16) out.push((e.className || e.tagName) + " " + size + "px");
  }
  return out;
}

scenario("k2-text-floor", "BS-06: body text on the home and setup screens is at least 16 px", async (t) => {
  t.boot();
  const probe = getComputedStyle(document.body).fontSize;
  if (!probe) {
    // The Node fake DOM computes no styles; the static check in ui-check.ts
    // covers the stylesheet there. The browser run is the real check.
    t.note("no computed styles in this DOM: skipped");
    return;
  }
  const home = smallText(document.body);
  t.expect(home.length === 0, "home: no text under 16 px (" + home.slice(0, 4).join(", ") + ")");
  t.clickButton("Play");
  t.expect(t.hook.top() === "menu", "Play opens the setup screen");
  await t.frames(2);
  const setup = smallText(document.body);
  t.expect(setup.length === 0, "setup: no text under 16 px (" + setup.slice(0, 4).join(", ") + ")");
  t.expect(document.documentElement.lang === "en", "the page declares its language");
});
