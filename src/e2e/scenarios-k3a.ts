/**
 * K3a scenarios: exploring the doubled realm as a player meets it -- the fog
 * hides what the exile has never seen, a march to an unexplored mark reveals
 * the country round it, arriving at a site opens Brother Aldous's letter (a
 * modal card that holds the clock and takes focus), and the choice made on it
 * lands in the stores. A second scenario puts a letter off and reopens it
 * from the Finds list. Every input is a real DOM event (see harness.ts); the
 * test hook is only read.
 */

import type { KingdomLayer } from "../app/kingdom-layer.ts";
import { kingCounterAt } from "../render/kingdom/layout.ts";
import { kingdomContext } from "../input/kingdom-commander.ts";
import { findAt, isFrontier, knowsHolding, pendingFinds } from "../sim/kingdom/explore.ts";
import { flowOf } from "../sim/kingdom/ledger.ts";
import { K } from "../content/kingdom/ui-strings.ts";
import { STORY_EVENTS, X } from "../content/story/index.ts";
import { scenario, type Driver, type Pt } from "./harness.ts";

const KING = 0;

function realmOf(t: Driver): KingdomLayer {
  const k = t.hook.kingdom();
  t.expect(k !== null, "the kingdom map is live (screens: " + t.hook.screens().join(" > ") + ")");
  return k as KingdomLayer;
}

async function openRealm(t: Driver): Promise<KingdomLayer> {
  t.clickButton(K.homeButton);
  await t.waitFor(() => t.hook.top() === "kingdom", () => "the kingdom screen (top: " + t.hook.top() + ")");
  const k = realmOf(t);
  await t.waitFor(() => k.renderer.stats.frames > 2, "the map to draw a few frames");
  return k;
}

function onScreen(t: Driver, k: KingdomLayer, x: number, y: number): Pt {
  const r = t.byId("stage").getBoundingClientRect();
  return { x: r.left + k.cam.worldToScreenX(x), y: r.top + k.cam.worldToScreenY(y) };
}

function kingOnScreen(t: Driver, k: KingdomLayer): Pt {
  const c = kingCounterAt(k.kingDrawn(), k.cam.pxToWorld);
  return onScreen(t, k, c.x, c.y);
}

function tap(t: Driver, p: Pt): void {
  t.stroke([p, { x: p.x + 1, y: p.y }]);
}

/** Is focus inside the open event card? */
function focusInCard(): boolean {
  const card = document.querySelector(".k-event");
  let n: Node | null = document.activeElement;
  while (n) { if (n === card) return true; n = n.parentNode; }
  return false;
}

/** March the king, the clock running at 4x, until a site's letter opens. */
async function marchToSite(t: Driver, k: KingdomLayer, key: string): Promise<number> {
  const w = k.world;
  const site = w.holdingByKey(key)!;
  t.expect(isFrontier(w, KING, site.id), site.name + " is an unexplored mark at the end of a known road");
  t.stroke(t.line(kingOnScreen(t, k), onScreen(t, k, site.x, site.y)));
  t.expect(k.committed?.order?.kind === "moveKing", "a line to the mark orders a march (" + k.hud.resultText + ")");
  t.expect(k.committed?.march?.name === X.unexplored, "the march names it only as unexplored, not by a name the king cannot know");
  if (k.clock.run === "paused") t.key("Space");
  t.key("Digit3");
  await t.waitFor(() => t.hook.top() === "kingdom-event", () => "the letter from " + site.name + " (top: " + t.hook.top() +
    ", king at " + w.king.mover.node + "/" + w.king.mover.road + ")", 30000);
  return site.id;
}

scenario("k3a-fog-and-find", "the fog hides the unknown; a march reveals; a site's letter holds the clock; a choice lands", async (t) => {
  t.boot();
  const k = await openRealm(t);
  const w = k.world;
  t.key("Space");
  t.expect(k.clock.run === "paused", "Space pauses the realm");

  // -- the fog at the start --------------------------------------------------
  const hidden0 = k.renderer.stats.hidden;
  t.expect(hidden0 >= 30, "most of the realm is not drawn at the start (" + hidden0 + " of " + w.holdings.length + " hidden)");
  t.expect(k.renderer.stats.frontier >= 1, "the ends of known roads show unexplored marks (" + k.renderer.stats.frontier + ")");
  const deep = w.holdingByKey("copperdale")!;
  t.expect(!knowsHolding(w, KING, deep.id) && !isFrontier(w, KING, deep.id), "Copperdale, far off, is unknown");
  const ctx = kingdomContext(w, w.kingPosition(), k.cam.pxToWorld);
  t.expect(!ctx.holdings.some((h) => h.id === deep.id), "and the pen has nothing there to tap or march to");
  t.expect(w.check({ kind: "moveKing", to: deep.id }) !== null, "a march there would be refused");

  // Tapping an unexplored mark says what it is, and opens nothing.
  const tower = w.holdingByKey("weather-tower")!;
  tap(t, onScreen(t, k, tower.x, tower.y));
  t.expect(t.hook.top() === "kingdom", "tapping an unexplored mark opens no card (top: " + t.hook.top() + ")");
  t.expect(k.hud.resultText === X.unexploredTap, "and says it is unexplored (" + k.hud.resultText + ")");

  // -- marching reveals; arriving opens the letter -------------------------------
  const known0 = w.explore[KING].holdings.filter((v) => v !== 0).length;
  const site = await marchToSite(t, k, "weather-tower");
  t.expect(knowsHolding(w, KING, site), "arriving, the king knows the place");
  t.expect(w.explore[KING].holdings.filter((v) => v !== 0).length > known0 && k.renderer.stats.hidden <= hidden0,
    "the march revealed country (" + known0 + " -> " + w.explore[KING].holdings.filter((v) => v !== 0).length + " known)");
  t.expect(w.king.mover.node === site && w.king.mover.route.length === 0, "the party halted at the site");
  const find = findAt(w, KING, site)!;
  const def = STORY_EVENTS[find.event];
  const card = document.querySelector(".k-event") as HTMLElement | null;
  t.expect(t.visible(card), "the event card is on screen");
  t.expect(card?.getAttribute("role") === "dialog" && card.getAttribute("aria-modal") === "true", "as a modal dialog");
  t.expect((card?.textContent ?? "").includes(def.title) && (card?.textContent ?? "").includes(def.text), "with the letter's title and text");
  t.expect((document.activeElement as HTMLElement | null)?.id === "k-event-title", "focus is on the letter's title when it opens (" +
    (document.activeElement?.textContent ?? "body") + ")");

  // The clock is held while the card is up, though the realm is running.
  t.expect(k.clock.run === "running", "the realm was left running");
  const now0 = w.now;
  await t.frames(20);
  await t.sleep(250);
  await t.frames(5);
  t.expect(w.now === now0, "nothing runs while the letter is open (tick " + now0 + " -> " + w.now + ")");

  // Keyboard reachable: Tab moves through the choices and stays in the card.
  t.key("Tab");
  t.expect(focusInCard() && (document.activeElement as HTMLElement | null)?.getAttribute("data-key") === "choice-0",
    "Tab reaches the first choice (" + (document.activeElement?.textContent ?? "body") + ")");
  for (let i = 0; i < 8; i++) t.key("Tab");
  t.expect(focusInCard(), "and Tab stays inside the card");

  // Choose: a choice whose effect can be seen in the stores (a gain, an upgrade or standing).
  let pick = def.choices.findIndex((c) => !c.chance && !c.effects.some((e) => e.kind === "pay") &&
    c.effects.some((e) => e.kind === "gain" || e.kind === "upgrade" || e.kind === "legitimacy"));
  if (pick < 0) pick = def.choices.findIndex((c) => !c.effects.some((e) => e.kind === "pay"));
  const choice = def.choices[pick];
  t.click(t.button(choice.label));
  t.expect(t.hook.top() === "kingdom", "choosing closes the letter (top: " + t.hook.top() + ")");
  await t.waitFor(() => findAt(w, KING, site)!.choice === pick, "the choice to be applied at the next tick");
  t.key("Space");
  const page = w.books[KING].open;
  const prev = w.books[KING].closed;
  const flow = (s: Parameters<typeof flowOf>[1], c: Parameters<typeof flowOf>[2]): number => flowOf(page, s, c) + (prev ? flowOf(prev, s, c) : 0);
  for (const e of choice.effects) {
    if (e.kind === "gain") {
      for (const [s, n] of Object.entries(e.gains)) {
        t.expect(flow(s as "coin", "finds") >= (n as number), "the find put " + n + " " + s + " in the stores, through the ledger");
      }
    }
    if (e.kind === "upgrade") t.expect(w.explore[KING].upgrades.includes(e.upgrade), "the special upgrade " + e.upgrade + " is held");
    if (e.kind === "legitimacy") {
      t.expect(flow("legitimacy", e.delta > 0 ? "deeds" : "disgrace") >= Math.abs(e.delta), "the realm's standing moved by " + e.delta);
    }
  }
  t.expect(t.hudText().includes(choice.result) || (document.querySelector(".k-alerts")?.textContent ?? "").includes(choice.result),
    "the feed tells what came of it");
  t.expect(pendingFinds(w, KING).length === 0, "and no letter is waiting");
});

scenario("k3a-decide-later", "a letter put off waits under Finds, and reopens from there by keyboard", async (t) => {
  t.boot();
  const k = await openRealm(t);
  const w = k.world;
  const site = await marchToSite(t, k, "hermits-cell");
  t.expect(t.hasButton(X.later), "the card offers to decide later");
  t.key("Escape");
  t.expect(t.hook.top() === "kingdom", "Esc puts the letter off (top: " + t.hook.top() + ")");
  t.key("Space");
  t.expect(k.clock.run === "paused", "pause again");
  t.expect(pendingFinds(w, KING).some((f) => f.site === site), "the letter waits");
  const toggle = document.querySelector(".k-finds-toggle") as HTMLElement | null;
  t.expect(t.visible(toggle) && (toggle?.textContent ?? "") === X.findsButton(1, w.explore[KING].upgrades.length),
    "the Finds button counts it (" + (toggle?.textContent ?? "") + ")");
  t.expect(toggle?.getAttribute("aria-expanded") === "false", "the list is shut");
  t.click(toggle as HTMLElement);
  t.expect(toggle?.getAttribute("aria-expanded") === "true" && t.visible(document.querySelector(".k-finds")), "the button opens the Finds list");
  const name = w.holding(site)!.name;
  const read = t.button(X.readLetter(name));
  t.expect((document.querySelector(".k-finds")?.textContent ?? "").includes(X.upgradesHeading), "the list shows the special upgrades too");
  read.focus();
  t.key("Enter");
  if (t.hook.top() !== "kingdom-event") t.click(read);
  t.expect(t.hook.top() === "kingdom-event", "the letter reopens from the list (top: " + t.hook.top() + ")");
  t.expect((document.activeElement as HTMLElement | null)?.id === "k-event-title", "with focus on its title");
  t.click(t.button(X.later));
  t.expect(t.hook.top() === "kingdom", "Decide later closes it again");
  t.expect(pendingFinds(w, KING).length === 1, "and the letter still waits");
});
