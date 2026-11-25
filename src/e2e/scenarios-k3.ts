/**
 * K3 scenarios: the exile's economy as a player meets it -- from a new game,
 * forage for grain, rally followers at the hamlet, march to an empty holding
 * and claim it, build a granary from the build menu (reached and moved
 * through by keyboard, with focus shown), sow a field, and watch the
 * resources bar follow along. Every input is a real DOM event (see
 * harness.ts); the test hook is only read.
 *
 * Time is paused throughout and stepped a day at a time with "." -- the
 * player's own way to step -- so each day's change can be checked exactly.
 */

import type { KingdomLayer } from "../app/kingdom-layer.ts";
import { kingCounterAt } from "../render/kingdom/layout.ts";
import { E, K, STOCK_NAME } from "../content/kingdom/ui-strings.ts";
import { scenario, type Driver, type Pt } from "./harness.ts";

function realmOf(t: Driver): KingdomLayer {
  const k = t.hook.kingdom();
  t.expect(k !== null, "the kingdom map is live (screens: " + t.hook.screens().join(" > ") + ")");
  return k as KingdomLayer;
}

async function openPaused(t: Driver): Promise<KingdomLayer> {
  t.clickButton(K.homeButton);
  await t.waitFor(() => t.hook.top() === "kingdom", () => "the kingdom screen (top: " + t.hook.top() + ")");
  const k = realmOf(t);
  await t.waitFor(() => k.renderer.stats.frames > 2, "the map to draw a few frames");
  t.key("Space");
  t.expect(k.clock.run === "paused", "Space pauses the realm");
  return k;
}

function onScreen(t: Driver, k: KingdomLayer, x: number, y: number): Pt {
  const r = t.byId("stage").getBoundingClientRect();
  return { x: r.left + k.cam.worldToScreenX(x), y: r.top + k.cam.worldToScreenY(y) };
}

function holdingNamed(k: KingdomLayer, name: string): { id: number; x: number; y: number } {
  const h = k.world.holdings.find((x) => x.name === name);
  if (!h) throw new Error("no holding " + name);
  return h;
}

function kingOnScreen(t: Driver, k: KingdomLayer): Pt {
  const c = kingCounterAt(k.kingDrawn(), k.cam.pxToWorld);
  return onScreen(t, k, c.x, c.y);
}

function tap(t: Driver, p: Pt): void {
  t.stroke([p, { x: p.x + 1, y: p.y }]);
}

/** One day, the player's way: "." while paused. */
function stepDays(t: Driver, n: number): void {
  for (let i = 0; i < n; i++) t.key("Period");
}

/** Step days until `ok`, at most `max`. */
function stepUntil(t: Driver, ok: () => boolean, max: number, what: string): void {
  for (let i = 0; i < max && !ok(); i++) t.key("Period");
  t.expect(ok(), what);
}

const shown = (k: KingdomLayer, s: "coin" | "grain" | "timber" | "iron" | "levy"): number => Number(k.hud.resources.shown(s).value);

/** The bar shows exactly the king's stocks. */
function barMatches(t: Driver, k: KingdomLayer, when: string): void {
  const st = k.world.kingStocks.stocks;
  const ok = (["coin", "grain", "timber", "iron", "levy"] as const).every((s) => shown(k, s) === st[s]);
  t.expect(ok, "the resources bar shows the stores " + when + " (" + JSON.stringify(st) + ")");
}

async function openKingCard(t: Driver, k: KingdomLayer): Promise<void> {
  if (t.hook.top() !== "kingdom") t.key("Escape");
  tap(t, kingOnScreen(t, k));
  await t.waitFor(() => t.hook.top() === "king-card", () => "the king card (top: " + t.hook.top() + ")");
}

async function openRegionCard(t: Driver, k: KingdomLayer, name: string): Promise<void> {
  if (t.hook.top() !== "kingdom") t.key("Escape");
  const h = holdingNamed(k, name);
  tap(t, onScreen(t, k, h.x, h.y));
  await t.waitFor(() => t.hook.top() === "region-card" && k.card?.holding === h.id, () => "the card of " + name + " (top: " + t.hook.top() + ")");
}

/** From a new game: forage, rally, forage, march to Greyshaw, claim it. */
async function claimGreyshaw(t: Driver, k: KingdomLayer): Promise<void> {
  const w = k.world;
  t.expect(w.holdingsOf("king").length === 0 && w.kingStocks.stocks.coin === 0 && w.kingStocks.stocks.levy === 0,
    "a new exile has no holding, no coin and no followers");
  t.expect(t.visible(document.querySelector(".k-stores")), "the resources bar is on screen");
  t.expect((document.querySelector(".k-stores")?.textContent ?? "").includes(STOCK_NAME.grain), "it names the stocks in words");
  barMatches(t, k, "at the start");

  await openKingCard(t, k);
  t.expect(t.hasButton(E.forage) && t.hasButton(E.rally), "the king card offers Forage and Rally at Cold Hearth");
  const grain0 = shown(k, "grain");
  t.clickButton(E.forage);
  stepDays(t, 3);
  t.expect(w.king.task === "forage", "the party is foraging");
  t.expect(shown(k, "grain") > grain0, "foraging adds grain (" + grain0 + " -> " + shown(k, "grain") + ")");
  t.expect(k.hud.resources.shown("grain").delta.startsWith("+"), "the bar shows the change since yesterday (" +
    k.hud.resources.shown("grain").delta + ")");
  barMatches(t, k, "after foraging");

  t.clickButton(E.rally);
  stepUntil(t, () => w.kingStocks.stocks.levy >= 4, 10, "rallying at the hamlet brings followers");
  t.expect(shown(k, "levy") >= 4, "the bar counts the followers (" + shown(k, "levy") + ")");
  t.expect(w.holding(w.king.mover.node)!.population < 30, "the followers came from the hamlet's people");

  t.clickButton(E.forage);
  stepUntil(t, () => w.kingStocks.stocks.grain >= 70 && w.kingStocks.stocks.timber >= 4, 14, "foraging gathers grain and deadwood for the road");
  t.key("Escape");

  // March: a line from the king to Greyshaw, then step the days of the road.
  const dest = holdingNamed(k, "Greyshaw");
  t.stroke(t.line(kingOnScreen(t, k), onScreen(t, k, dest.x, dest.y)));
  stepUntil(t, () => w.king.mover.road === 0 && w.king.mover.node === dest.id && w.king.mover.route.length === 0, 14,
    "the king marches to Greyshaw");
  t.expect(w.king.task === "none", "marching ended the foraging");

  await openKingCard(t, k);
  const claim = E.claim("Greyshaw");
  t.expect(t.hasButton(claim), "at an empty holding the king card offers " + claim);
  t.clickButton(claim);
  stepDays(t, 1);
  t.expect(w.holding(dest.id)!.owner === "king", "Greyshaw is the king's: claimed with no battle");
  t.expect(!t.hasButton(claim), "and the card stops offering the claim");
  // Keep the party foraging while the holding is put in order.
  t.clickButton(E.forage);
  t.key("Escape");
}

scenario("k3-exile-economy", "from a new game: forage, rally, march, claim, build a granary, sow a field", async (t) => {
  t.boot();
  const k = await openPaused(t);
  const w = k.world;
  await claimGreyshaw(t, k);
  const g = holdingNamed(k, "Greyshaw");
  const h = w.holding(g.id)!;

  await openRegionCard(t, k, "Greyshaw");
  const panel = document.querySelector(".k-economy");
  t.expect(t.visible(panel), "an owned holding's card shows its economy panel");
  const text = panel?.textContent ?? "";
  t.expect(text.includes(E.tax) && text.includes(E.buildings) && text.includes(E.fields), "with tax, buildings and fields");
  t.expect(t.hasButton("Normal") && t.hasButton(E.taxRealm), "tax rates are buttons, with the realm-wide one");

  // Build a granary from the build menu, by keyboard.
  const build = t.button(E.build);
  t.expect(build.getAttribute("tabindex") !== "-1" && !build.disabled, "Build… is in the tab order");
  t.click(build);
  t.expect(t.hook.top() === "build-menu", "Build… opens the build menu (top: " + t.hook.top() + ")");
  const menu = document.querySelector(".k-menu") as HTMLElement | null;
  const inMenu = (): boolean => { let n: Node | null = document.activeElement; while (n) { if (n === menu) return true; n = n.parentNode; } return false; };
  t.expect(inMenu(), "focus is inside the menu when it opens (" + (document.activeElement?.textContent ?? "body") + ")");
  const cs = typeof getComputedStyle === "function" ? getComputedStyle(document.activeElement as Element) : null;
  if (cs && cs.outlineStyle !== undefined && cs.outlineStyle !== "") {
    t.expect(cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2, "the focused choice shows a focus ring (" + cs.outlineStyle + " " + cs.outlineWidth + ")");
  } else {
    t.note("no computed outline in this DOM: the ring is checked in the browser run and by ui-check");
  }
  let found = false;
  for (let i = 0; i < 30 && !found; i++) {
    if (document.activeElement?.textContent === "Granary") found = true;
    else t.key("Tab");
  }
  t.expect(found && inMenu(), "Tab reaches the granary and stays inside the menu");
  const tick0 = w.now;
  t.key("Tab", { shift: true });
  t.key("Tab");
  t.expect(document.activeElement?.textContent === "Granary", "Shift+Tab goes back, Tab forward");
  t.expect(w.now === tick0, "nothing runs while the menu is up");
  const timber0 = w.kingStocks.stocks.timber;
  t.click(document.activeElement as HTMLElement);
  t.expect(t.hook.top() === "region-card", "choosing closes the menu");
  t.expect((document.activeElement as HTMLElement | null)?.getAttribute("data-key") === "build", "focus is back on Build…");
  stepDays(t, 1);
  const slot = h.buildings.indexOf("granary");
  t.expect(slot >= 0 && h.works[slot] > 0, "the granary is being built");
  t.expect(w.kingStocks.stocks.timber < timber0 && shown(k, "timber") === w.kingStocks.stocks.timber, "its timber left the stores, and the bar says so");
  t.expect((document.querySelector(".k-economy")?.textContent ?? "").includes("being built"), "the panel shows the works");
  stepUntil(t, () => h.works[slot] === 0, 8, "the granary stands after its build days");

  // Sow the first field with rye.
  await openRegionCard(t, k, "Greyshaw");
  t.click(t.button(E.sow));
  t.expect(t.hook.top() === "sow-menu", "Sow… opens the sow menu");
  const options = Array.from(document.querySelectorAll(".k-choice-btn")).map((b) => b.textContent ?? "");
  t.expect(options.includes("Rye") && options.includes("Wheat and barley"), "it lists the crops (" + options.join(", ") + ")");
  const wheat = t.button("Wheat and barley");
  t.expect(wheat.getAttribute("aria-disabled") === "true", "wheat is not on offer in autumn");
  t.click(wheat);
  t.expect(t.hook.top() === "sow-menu" && (document.querySelector(".k-menu-status")?.textContent ?? "").includes("Not now"),
    "pressing it says why, and does nothing");
  t.click(t.button("Rye"));
  t.expect(t.hook.top() === "region-card", "choosing rye closes the menu (top " + t.hook.top() + ", " +
    (document.querySelector(".k-menu-status")?.textContent ?? "") + "; " + k.hud.resultText + ")");
  stepDays(t, 1);
  t.expect(h.plots[0].crop === "rye" && (h.plots[0].stage === "sown" || h.plots[0].stage === "growing"), "the field is sown with rye (" + h.plots[0].crop + " " + h.plots[0].stage + "; " + k.hud.resultText + ")");
  barMatches(t, k, "after building and sowing");
});

scenario("k3-menu-esc-and-refusal", "the build menu: Esc cancels and hands focus back; a refused choice says why", async (t) => {
  t.boot();
  const k = await openPaused(t);
  await claimGreyshaw(t, k);
  await openRegionCard(t, k, "Greyshaw");
  t.click(t.button(E.build));
  t.expect(t.hook.top() === "build-menu", "the build menu is open");
  t.key("Escape");
  t.expect(t.hook.top() === "region-card", "Esc closes it");
  t.expect((document.activeElement as HTMLElement | null)?.getAttribute("data-key") === "build", "and focus returns to Build…");
  t.click(t.button(E.build));
  const keep = t.button("Keep");
  t.expect(keep.getAttribute("aria-disabled") === "true", "a keep is not on offer at a hamlet with no wall");
  t.click(keep);
  t.expect((document.querySelector(".k-menu-status")?.textContent ?? "").startsWith("Not now"), "pressing it says why");
  t.expect(t.hook.top() === "build-menu", "and the menu stays open");
  t.clickButton(E.cancel);
  t.expect(t.hook.top() === "region-card", "Cancel closes it");
});
