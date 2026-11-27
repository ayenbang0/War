/**
 * ECON scenario: the owner's farming steers, as a player meets them.
 *
 * econ-auto-farm -- a realm that holds Greyshaw late in summer, its field of
 * wheat a few days from ripe and every field still sown by hand (a prepared
 * save, as an old game is: a new game starts with the switch on). The player
 * opens the city, turns on "Resow all fields automatically", sets the realm
 * running at 4x and lets the season turn: the wheat is reaped by itself the
 * day it ripens, into the stores the panel and the bar show; when autumn
 * comes the field resows itself with rye; and the HUD reads a 12-month date
 * throughout ("21 Reapmoon, Year 1" ... "1 Harvestmoon, Year 1").
 *
 * Every input is a real DOM event (harness.ts): clicks and keys. The test
 * hook is only read.
 */

import { KINGDOM_SAVE_KEY } from "../app/kingdom-save.ts";
import { KingdomWorld } from "../sim/kingdom/world.ts";
import { saveToJson } from "../sim/kingdom/save.ts";
import { credit } from "../sim/kingdom/ledger.ts";
import { DAYS_PER_SEASON } from "../sim/kingdom/clock.ts";
import { CROPS } from "../content/kingdom/crops.ts";
import { MONTHS } from "../content/kingdom/terrain.ts";
import { C } from "../content/kingdom/city-strings.ts";
import { memoryStorage, scenario, type Driver } from "./harness.ts";
import { barMatches, enterByCard, holdingNamed, openPaused, panelButton } from "./scenarios-k3.ts";

/** Days before autumn the prepared realm starts on. */
const BEFORE_AUTUMN = 10;
/** Days the wheat still needs when the game is loaded. */
const WHEAT_LEFT = 4;

function lateSummerSave(): string {
  // epoch: day of year 1 the realm began on -- ten days before autumn (doy 180).
  const w = new KingdomWorld({ seed: 0xec0, epoch: 2 * DAYS_PER_SEASON - BEFORE_AUTUMN });
  const g = w.holdings.find((h) => h.name === "Greyshaw")!;
  g.owner = "king";
  const p = g.plots[0];
  const wheat = CROPS.wheat;
  p.crop = wheat.id;
  p.stage = "growing";
  p.days = wheat.growDays - WHEAT_LEFT;
  p.progress = p.days / wheat.growDays;
  p.health = 100;
  for (const q of g.plots) q.auto = null;
  w.kingStocks.autoSow = null;
  credit(w.economy[0], w.books[0], "grain", 300, "trade");
  return saveToJson(w);
}

/** The HUD's date: "<day> <month>, Year <n>", a month of the twelve. */
function twelveMonthDate(t: Driver, text: string, when: string): void {
  const m = /^(\d+) (\w+), Year (\d+)/.exec(text);
  t.expect(m !== null && MONTHS.some((x) => x.name === m[2]) && Number(m[1]) >= 1 && Number(m[1]) <= 30,
    "the HUD shows a 12-month date " + when + " (" + text + ")");
}

const storesLine = (): string => document.querySelector(".c-panel .c-stores")?.textContent ?? "";
const fieldText = (): string => document.querySelector(".k-card")?.textContent ?? "";

scenario("econ-auto-farm", "turn on auto-resow in the city, let summer turn at 4x: the harvest reaps itself into the stores and the field resows", async (t) => {
  const store = memoryStorage({ [KINGDOM_SAVE_KEY]: lateSummerSave() });
  t.boot({ storage: () => store });
  const k = await openPaused(t);
  const w = k.world;
  const g = holdingNamed(k, "Greyshaw");
  const plot = w.holding(g.id)!.plots[0];
  t.expect(w.date.season === "summer" && plot.stage === "growing" && plot.crop === "wheat", "late summer, wheat growing at Greyshaw");
  twelveMonthDate(t, k.hud.dateText, "on load");
  t.expect(k.hud.dateText.startsWith((w.date.dayOfMonth + 1) + " " + MONTHS[w.date.month].name + ", Year 1"),
    "the date is the realm's own (" + k.hud.dateText + ")");

  // -- the city: the switch is off; press it ---------------------------------------------------
  await enterByCard(t, k, "Greyshaw");
  const sw = panelButton(t, "resow-all");
  t.expect(sw.textContent === C.resowAll && sw.getAttribute("aria-pressed") === "false", "the city offers " + C.resowAll + ", off");
  t.expect((document.querySelector(".c-resow-state")?.textContent ?? "") === C.resowAllOff, "and says the fields are sown by hand");
  t.click(sw);
  t.key("Period");
  t.expect(w.kingStocks.autoSow === "rye" && plot.auto === "rye", "the switch sets every field to resow rye (" + w.kingStocks.autoSow + ", " + plot.auto + ")");
  await t.waitFor(() => panelButton(t, "resow-all").getAttribute("aria-pressed") === "true", "the switch to read pressed");
  t.expect((document.querySelector(".c-resow-state")?.textContent ?? "") === C.resowAllOn(CROPS.rye.name), "the panel says every field resows rye");

  // The field card says so too: ripe soon, reaped by itself, resows rye.
  t.click(panelButton(t, "field-0"));
  t.expect(t.hook.top() === "field-card", "the field's card opens (top: " + t.hook.top() + ")");
  t.expect(fieldText().includes(C.reapedAuto) && fieldText().includes(C.resowsCrop(CROPS.rye.name)),
    "the field card says it is reaped by itself and resows rye");
  t.key("Escape");
  t.expect(t.hook.top() === "city", "Esc closes the card (top: " + t.hook.top() + ")");

  // -- let the season turn at 4x ---------------------------------------------------------------
  const grain0 = w.kingStocks.stocks.grain;
  const yieldNow = (CROPS.wheat.yield.grain ?? 0) / 2;
  t.key("Digit3"); // choosing a speed also resumes (kingdom-clock.ts)
  t.expect(k.clock.run === "running" && k.clock.speed === 4, "the realm runs at 4x (" + k.clock.run + ", " + k.clock.speed + "x)");
  await t.waitFor(() => plot.stage === "harvested" || plot.crop === "rye", () => "the wheat to be reaped (" + plot.stage + ", " + k.hud.dateText + ")", 8000);
  t.expect(w.kingStocks.stocks.grain > grain0 + yieldNow, "the harvest went into the stores (" + grain0 + " -> " + w.kingStocks.stocks.grain + ")");
  await t.waitFor(() => storesGrain(storesLine()) > grain0 + yieldNow,
    () => "the city panel to show the harvest in the realm's stores (" + storesLine() + ")", 3000);

  await t.waitFor(() => w.date.season === "autumn" && plot.crop === "rye" && (plot.stage === "sown" || plot.stage === "growing"),
    () => "autumn, and the field resown (" + w.date.season + ", " + plot.crop + " " + plot.stage + ")", 8000);
  t.key("Space");
  t.expect(k.clock.run === "paused", "Space pauses again");
  barMatches(t, k, "after the harvest and the resowing");

  t.click(panelButton(t, "field-0"));
  t.expect(fieldText().includes(CROPS.rye.name), "the field card shows the rye it resowed (" + fieldText().slice(0, 120) + ")");
  t.key("Escape");

  twelveMonthDate(t, k.hud.dateText, "in autumn");
  t.expect(k.hud.dateText.includes(MONTHS[w.date.month].name) && MONTHS[w.date.month].season === "autumn",
    "the month is an autumn month (" + k.hud.dateText + ")");
});

/** The grain in the panel's store line (C.realmStores). */
function storesGrain(line: string): number {
  const m = /: (\d+) grain of \d+/.exec(line);
  return m ? Number(m[1]) : -1;
}
