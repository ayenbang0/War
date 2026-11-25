/**
 * K3b scenarios: the city view, as a player meets it. From a new game, claim
 * Greyshaw (the K3 path), then go down into its city by the region card's
 * button, by zooming in past the map's closest zoom, and by a double tap;
 * build a granary on a lot and sow a field by tapping the town plan; see the
 * politics card with its honest "not yet" rows; and come back up by Esc, by
 * zooming out and by the panel's Leave button -- with the realm's date,
 * stocks and clock exactly as the city left them, and running on.
 *
 * Every input is a real DOM event (harness.ts): clicks, keys, pen strokes on
 * the canvas and wheel events. The test hook is only read.
 */

import type { KingdomLayer } from "../app/kingdom-layer.ts";
import type { CityLayer } from "../app/city-layer.ts";
import { C } from "../content/kingdom/city-strings.ts";
import { E } from "../content/kingdom/ui-strings.ts";
import { OVERFLOW_PX } from "../input/zoom-through.ts";
import { scenario, type Driver, type Pt } from "./harness.ts";
import {
  barMatches, claimGreyshaw, enterByCard, holdingNamed, onScreen, openPaused, openRegionCard, panelButton, stepDays, tap,
} from "./scenarios-k3.ts";

/** A wheel notch on the stage at a screen point (negative deltaY zooms in). */
function wheel(t: Driver, p: Pt, deltaY: number): void {
  const W = (globalThis as unknown as { WheelEvent: typeof WheelEvent }).WheelEvent;
  t.byId("stage").dispatchEvent(new W("wheel", {
    bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, deltaY, deltaMode: 0,
  }));
}

function cityOnScreen(t: Driver, c: CityLayer, kind: "lot" | "field", index: number): Pt {
  const at = c.placeOf(kind, index);
  t.expect(at !== null, "the plan has " + kind + " " + (index + 1));
  const r = t.byId("stage").getBoundingClientRect();
  return { x: r.left + c.cam.worldToScreenX(at!.x), y: r.top + c.cam.worldToScreenY(at!.y) };
}

/** What the realm is, to compare across a visit to the city. */
function realmState(k: KingdomLayer): string {
  return JSON.stringify({ now: k.world.now, run: k.clock.run, speed: k.clock.speed, stocks: k.world.kingStocks.stocks });
}

async function backOnMap(t: Driver, k: KingdomLayer, how: string): Promise<void> {
  await t.waitFor(() => t.hook.top() === "kingdom" && t.hook.kingdom() === k && !k.isSuspended,
    () => how + " goes back to the map (top: " + t.hook.top() + ")");
  await t.waitFor(() => k.renderer.stats.frames > 0 && !k.cam.flying, "the map to draw again, eased out");
}

scenario("k3b-city-view", "enter a holding's city, build and sow on its plan, see its politics, leave; the realm runs on", async (t) => {
  t.boot();
  const k = await openPaused(t);
  const w = k.world;
  await claimGreyshaw(t, k);
  const g = holdingNamed(k, "Greyshaw");
  const h = w.holding(g.id)!;

  // -- the region card keeps a summary and the way in --------------------------
  await openRegionCard(t, k, "Greyshaw");
  t.expect((document.querySelector(".k-economy")?.textContent ?? "").includes(C.lotsRow), "the card sums up the holding's lots");
  const before = realmState(k);
  const city = await enterByCard(t, k, "Greyshaw");
  t.expect(city.holding === g.id, "the city is Greyshaw's");
  t.expect(t.hook.kingdom() === null && t.hook.realm() === k && k.isSuspended, "the map is suspended under the city, not torn down");
  t.expect(realmState(k) === before, "entering changed nothing in the realm (" + realmState(k) + ")");
  t.expect(document.activeElement === city.panel.heading, "focus is on the city panel's heading");
  t.expect(t.visible(document.querySelector(".k-top")), "the kingdom's top bar (stores, date, speed) stays over the city");
  t.expect(k.hud.resultText.includes("Greyshaw"), "the result line says where you are (" + k.hud.resultText + ")");
  await t.waitFor(() => city.renderer.stats.frames > 3, "the town plan to draw");
  t.expect(city.renderer.stats.lots === h.buildings.length && city.renderer.stats.fields === h.plots.length,
    "every lot and field is drawn (" + city.renderer.stats.lots + " lots, " + city.renderer.stats.fields + " fields)");

  // -- time is the realm's: "." steps a day from inside the city ---------------
  const day0 = w.date.day;
  stepDays(t, 1);
  t.expect(w.date.day === day0 + 1, "the realm's day steps from inside the city");

  // -- build a granary on the lot, by tapping it on the plan --------------------
  tap(t, cityOnScreen(t, city, "lot", 0));
  t.expect(t.hook.top() === "lot-card" && city.card?.index === 0, "a tap on the lot opens its card (top: " + t.hook.top() + ")");
  t.expect(panelButton(t, "lot-0").getAttribute("aria-current") === "true", "the panel marks the open lot");
  t.click(t.button(E.build));
  t.expect(t.hook.top() === "build-menu", "Build… opens K3's build menu");
  const intro = document.getElementById("k-menu-intro")?.textContent ?? "";
  t.expect(intro.includes(C.buildMenuFor(1)), "the menu says which lot it builds on (" + intro + ")");
  t.click(t.button("Granary"));
  t.expect(t.hook.top() === "lot-card", "choosing closes the menu, back to the lot");
  stepDays(t, 1);
  t.expect(h.buildings[0] === "granary" && h.works[0] > 0, "the granary is going up on lot 1 (" + h.buildings.join(",") + ")");
  t.expect((panelButton(t, "lot-0").textContent ?? "").includes("being built"), "the panel says so in words");
  barMatches(t, k, "after the build order from the city");

  // -- sow a field, by tapping it ----------------------------------------------
  tap(t, cityOnScreen(t, city, "field", 0));
  t.expect(t.hook.top() === "field-card" && city.card?.index === 0, "a tap on the field opens its card (top: " + t.hook.top() + ")");
  t.click(t.button(E.sow));
  t.expect(t.hook.top() === "sow-menu", "Sow… opens the sow menu");
  t.click(t.button("Rye"));
  t.expect(t.hook.top() === "field-card", "choosing rye closes the menu");
  stepDays(t, 1);
  t.expect(h.plots[0].crop === "rye" && h.plots[0].stage !== "empty", "the field is sown with rye (" + h.plots[0].stage + ")");

  // -- politics ----------------------------------------------------------------
  t.key("KeyP");
  t.expect(t.hook.top() === "politics-card", "P opens the politics card (top: " + t.hook.top() + ")");
  const card = document.querySelector(".k-card")?.textContent ?? "";
  t.expect(card.includes(C.people) && card.includes(C.loyalty) && card.includes(C.loyaltyNotYet) &&
    card.includes(C.lordsNotYet) && card.includes(C.lawsNotYet), "it shows people, and says plainly what is not reckoned yet");
  t.click(t.button("Low"));
  stepDays(t, 1);
  t.expect(h.tax === "low", "the tax is set from the city (" + h.tax + ")");
  t.expect(t.button("Low").getAttribute("aria-pressed") === "true", "and the pressed rate says so");

  // -- Esc: the card first, then the city -----------------------------------------
  t.key("Escape");
  t.expect(t.hook.top() === "city" && city.card === null, "Esc closes the card first");
  const inside = realmState(k);
  t.key("Escape");
  await backOnMap(t, k, "Esc");
  t.expect(city.phase === "torn-down" && t.hook.city() === null, "the city is torn down");
  t.expect(realmState(k) === inside, "the realm is as the city left it");
  t.expect(document.querySelector(".c-panel") === null, "the city panel is gone");

  // -- the kingdom continues -----------------------------------------------------
  const now0 = w.now;
  t.key("Space");
  await t.waitFor(() => w.now > now0, "the realm's clock to run on the map after the city");
  t.key("Space");
  t.expect(k.clock.run === "paused", "Space pauses it again");
});

scenario("k3b-zoom-through", "zoom in past the map's closest zoom to enter a city, out past the town to leave; a double tap enters too", async (t) => {
  t.boot();
  const k = await openPaused(t);
  await claimGreyshaw(t, k);
  const g = holdingNamed(k, "Greyshaw");

  // Not over a holding of the king's: zooming on does not enter.
  const cold = holdingNamed(k, "Cold Hearth");
  for (let i = 0; i < 40; i++) wheel(t, onScreen(t, k, cold.x, cold.y), -120);
  t.expect(k.cam.zoom >= k.cam.maxZoom - 1e-9 && t.hook.top() === "kingdom", "at the closest zoom over another's hamlet the map stays");
  t.expect(k.hud.resultText === C.notYours("Cold Hearth") || k.world.holding(cold.id)?.owner === "king",
    "and says why (" + k.hud.resultText + ")");
  for (let i = 0; i < 40; i++) wheel(t, onScreen(t, k, cold.x, cold.y), 120);

  // Over Greyshaw: zoom in to the limit, then on through it.
  const before = realmState(k);
  let notches = 0;
  while (t.hook.top() === "kingdom" && notches < 60) {
    wheel(t, onScreen(t, k, g.x, g.y), -120);
    notches++;
  }
  await t.waitFor(() => t.hook.top() === "city", () => "zooming in on Greyshaw enters its city (top: " + t.hook.top() + ", " + notches + " notches)");
  t.expect(notches >= 3, "one notch at the limit does not change layer (" + notches + " notches)");
  const city = t.hook.city() as CityLayer;
  t.expect(city.holding === g.id && realmState(k) === before, "the city is Greyshaw's, and the realm is untouched");
  t.expect(Math.abs(city.cam.zoom - city.cam.minZoom) < 1e-9, "it opens framed on the whole town");

  // Out past the widest view of the town: back to the map.
  const centre = { x: 640, y: 360 };
  for (let i = 0; i < Math.ceil(OVERFLOW_PX / 120) + 1 && t.hook.top() === "city"; i++) wheel(t, centre, 120);
  await backOnMap(t, k, "zooming out of the town");
  t.expect(realmState(k) === before, "the realm is as it was");

  // A double tap on Greyshaw goes in too; the panel's Leave comes back.
  const p = onScreen(t, k, g.x, g.y);
  tap(t, p);
  t.expect(t.hook.top() === "region-card", "the first tap opens the card");
  tap(t, onScreen(t, k, g.x, g.y));
  await t.waitFor(() => t.hook.top() === "city", () => "a double tap enters the city (top: " + t.hook.top() + ")");
  t.click(panelButton(t, "leave"));
  await backOnMap(t, k, "the Leave button");

  // Two taps far apart in time do not.
  tap(t, onScreen(t, k, g.x, g.y));
  // Far apart on the layer's own clock: frames for the fake DOM, real time
  // for a browser, where 20 frames is only a third of a second.
  await t.frames(20);
  await t.sleep(700);
  await t.frames(2);
  t.key("Escape");
  tap(t, onScreen(t, k, g.x, g.y));
  t.expect(t.hook.top() === "region-card", "two slow taps only open the card");
});
