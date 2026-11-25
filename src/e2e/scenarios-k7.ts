/**
 * K7 end-to-end: hiring a free company through the tavern, with real events
 * (PLAN.md §B.11 K7, docs/audit/u2-mercenary-market.md).
 *
 * k7-tavern-hire -- a realm that already holds Greyshaw with a standing
 * tavern and coin in the chest (a prepared save, as K4's barracks: a new
 * exile takes a season to afford one). A day passes with the real "." key
 * and a company comes to drink; the city is entered from the map, the
 * tavern's lot opened, "Free companies…", the company chosen -- and its army
 * is on the map, named for the company, the fee gone from the chest, and its
 * card shows the contract and the company's loyalty.
 *
 * Every input is a real DOM event (harness.ts). The test hook is only read.
 */

import type { KingdomLayer } from "../app/kingdom-layer.ts";
import { KINGDOM_SAVE_KEY } from "../app/kingdom-save.ts";
import { KingdomWorld } from "../sim/kingdom/world.ts";
import { saveToJson } from "../sim/kingdom/save.ts";
import { credit, flowOf } from "../sim/kingdom/ledger.ts";
import { armyById, standsIn } from "../sim/kingdom/armies.ts";
import { armyCounters } from "../input/kingdom-commander.ts";
import { MERCENARIES } from "../content/kingdom/mercenaries.ts";
import { CONTRACT, MARKET, REPUTATION_WORD } from "../content/kingdom/mercenary-strings.ts";
import { AC } from "../content/kingdom/army-strings.ts";
import { memoryStorage, scenario, type Driver, type Pt } from "./harness.ts";
import { barMatches, enterByCard, holdingNamed, onScreen, openPaused, panelButton, stepDays, tap } from "./scenarios-k3.ts";

function tavernSave(): string {
  const w = new KingdomWorld({ seed: 0x6b7 });
  const g = w.holdings.find((h) => h.name === "Greyshaw")!;
  g.owner = "king";
  g.tax = "none";
  const slot = g.buildings.indexOf(null);
  g.buildings[slot] = "tavern";
  g.works[slot] = 0;
  const e = w.economy[0];
  const book = w.books[0];
  credit(e, book, "coin", 40, "trade");
  credit(e, book, "grain", 300, "trade");
  return saveToJson(w);
}

function armyOnScreen(t: Driver, k: KingdomLayer, army: number): Pt {
  const c = armyCounters(k.world, k.armiesDrawn(), k.cam.pxToWorld).find((x) => x.army.id === army);
  t.expect(c !== undefined, "army " + army + " is drawn on the map");
  return onScreen(t, k, c!.counter.x, c!.counter.y);
}

scenario("k7-tavern-hire", "a company comes to a tavern; enter the city, open the tavern, hire it; its army is on the map with its contract", async (t) => {
  const store = memoryStorage({ [KINGDOM_SAVE_KEY]: tavernSave() });
  t.boot({ storage: () => store });
  const k = await openPaused(t);
  const w = k.world;
  const def = MERCENARIES[0];
  const g = holdingNamed(k, "Greyshaw");
  const lot = w.holding(g.id)!.buildings.indexOf("tavern");
  t.expect(lot >= 0 && w.armies.length === 0 && w.companies.every((c) => c.state === "waiting"),
    "the realm holds Greyshaw's tavern; no company has come yet");

  stepDays(t, 1);
  const c = w.companies[0];
  t.expect(c.state === "offered" && c.at === g.id, "a day later " + def.name + " are drinking in Greyshaw's tavern (" + c.state + ")");
  const feed = document.body.textContent ?? "";
  t.expect(feed.includes(def.name), "and the feed says so");

  const city = await enterByCard(t, k, "Greyshaw");
  t.click(panelButton(t, "lot-" + lot));
  t.expect(t.hook.top() === "lot-card" && city.card?.index === lot, "the tavern's lot card opens (top: " + t.hook.top() + ")");
  t.expect(t.hasButton(MARKET.button), "a tavern lot offers " + MARKET.button);
  t.clickButton(MARKET.button);
  t.expect(t.hook.top() === "market-menu", "it opens the market (top: " + t.hook.top() + ")");
  const menu = document.querySelector(".k-menu")?.textContent ?? "";
  t.expect(menu.includes(def.fee + " coin to sign") && menu.includes(def.wage + " a day"), "the company's fee and wage are listed");
  t.expect(menu.includes(REPUTATION_WORD[def.reputation]) && menu.includes(MARKET.loyalty(def.loyalty)), "with its reputation and loyalty");
  const label = MARKET.option({ name: def.name, reputation: REPUTATION_WORD[def.reputation] });
  const pick = t.button(label);
  t.expect(document.activeElement === pick, "the first open choice has the focus (keyboard)");
  const coin0 = w.kingStocks.stocks.coin;
  t.clickButton(label);
  t.expect(t.hook.top() === "lot-card", "choosing closes the market");
  stepDays(t, 1);

  t.expect(c.state === "hired" && w.armies.length === 1, "the company is hired (" + c.state + ")");
  const a = armyById(w, c.army)!;
  t.expect(a.name === def.name && a.company === 1 && standsIn(a.mover) === g.id, "its army is raised at Greyshaw, named for it");
  const book = w.books[0];
  const fees = flowOf(book.open, "coin", "hiring") + (book.closed ? flowOf(book.closed, "coin", "hiring") : 0);
  t.expect(fees === def.fee, "the fee is booked under hiring (" + fees + ")");
  t.expect(w.kingStocks.stocks.coin < coin0, "and is gone from the chest (" + coin0 + " -> " + w.kingStocks.stocks.coin + ")");
  barMatches(t, k, "after hiring");

  t.key("Escape");
  t.key("Escape");
  await t.waitFor(() => t.hook.top() === "kingdom" && !k.isSuspended, () => "back on the map (top: " + t.hook.top() + ")");
  await t.waitFor(() => k.renderer.stats.armies === 1, "the company's counter on the map");
  tap(t, armyOnScreen(t, k, a.id));
  t.expect(t.hook.top() === "army-card", "its card opens from the counter (top: " + t.hook.top() + ")");
  const card = document.querySelector(".k-card")?.textContent ?? "";
  t.expect(card.includes(CONTRACT.sub), "the card says it is a free company");
  t.expect(card.includes(CONTRACT.contract(c.days)) && card.includes(CONTRACT.loyalty(c.loyalty, REPUTATION_WORD[def.reputation])),
    "with its contract and loyalty, as the sim has them (" + c.days + " days, " + c.loyalty + ")");
  t.expect(t.hasButton(CONTRACT.dismiss) && !t.hasButton(AC.split), "it can be dismissed, not split");
});
