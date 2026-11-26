/**
 * K10 end-to-end: a siege launched from the map, and its walls followed back
 * to the holding (PLAN.md Phase 8, docs/audit/k10-sieges.md).
 *
 * k10-siege-walls -- the king's army with two siege engines at Rookstead,
 * Harrowfield behind a stone wall with only its townsmen (a prepared save).
 * March on Harrowfield with a pen line; the realm halts at its walls and the
 * interstitial says it is a siege and how one is won; Fight goes down into a
 * battle fought at the town's walls (raised, gated, the HUD saying how much
 * of them stands); Enter begins it; the outcome is forced through the hook,
 * which also knocks down a stretch of the wall line (it stands for the
 * engines' work in fifteen minutes of fighting); the after-action report says
 * what the siege knocked down; back on the map the feed says so, the region
 * card shows the walls down, and in the city the plan draws the breach and
 * the wall's lot mends it -- the masons' order paid and the walls going up a
 * day at a time.
 *
 * Every input is a real DOM event (harness.ts): pen strokes, clicks, keys.
 * The test hook is only read -- apart from forceOutcome.
 */

import type { KingdomLayer } from "../app/kingdom-layer.ts";
import { KINGDOM_SAVE_KEY } from "../app/kingdom-save.ts";
import { KingdomWorld } from "../sim/kingdom/world.ts";
import { saveToJson } from "../sim/kingdom/save.ts";
import { raiseArmy } from "../sim/kingdom/armies.ts";
import { credit } from "../sim/kingdom/ledger.ts";
import { moverAt } from "../sim/kingdom/graph.ts";
import { CONTACT, DESCENT } from "../content/kingdom/descent-strings.ts";
import { C } from "../content/kingdom/city-strings.ts";
import { DEFEND, INVASION_FEED } from "../content/kingdom/invasion-strings.ts";
import { FACTION_IDS, KING_PLAYER } from "../content/kingdom/factions.ts";
import { gateTiles } from "../sim/siege.ts";
import { Terrain } from "../sim/terrain.ts";
import { WALL_REPAIR } from "../content/kingdom/descent.ts";
import { memoryStorage, scenario, type Driver } from "./harness.ts";
import { enterByCard, holdingNamed, onScreen, openRegionCard, panelButton, stepDays, stepUntil } from "./scenarios-k3.ts";
import { armyOnScreen, onStage, openRealm, wheel } from "./scenarios-k5.ts";

const SAVE_SEED = 0x6b10;

/** The king riding with a siege train at Rookstead; Harrowfield walled in stone, its townsmen on the walls. */
function siegeSave(): string {
  const w = new KingdomWorld({ seed: SAVE_SEED });
  const harrow = w.holdingByKey("harrowfield")!;
  harrow.buildings[harrow.buildings.indexOf(null)] = "wall";
  harrow.population = Math.max(harrow.population, 120);
  const rook = w.holdingByKey("rookstead")!.id;
  const a = raiseArmy(w, KING_PLAYER, rook, ["siege", "siege", "line", "line", "line", "archer"]);
  a.supply = 3000;
  w.king.mover = moverAt(rook);
  w.king.army = a.id;
  // The masons' pay, for after (test setup, through the ledger).
  const e = w.economy[KING_PLAYER];
  credit(e, w.books[KING_PLAYER], "coin", 3000, "trade");
  credit(e, w.books[KING_PLAYER], "timber", 60, "trade");
  credit(e, w.books[KING_PLAYER], "iron", 20, "trade");
  w.events = [];
  return saveToJson(w);
}

async function marchOnTheWalls(t: Driver, k: KingdomLayer): Promise<void> {
  if (k.clock.run !== "paused") t.key("Space");
  const w = k.world;
  const a = w.armies.find((x) => x.owner === KING_PLAYER)!;
  const harrow = holdingNamed(k, "Harrowfield");
  for (let i = 0; i < 12 && !onStage(t, onScreen(t, k, harrow.x, harrow.y)); i++) {
    wheel(t, armyOnScreen(t, k, a.id), 120);
    await t.frames(1);
  }
  const from = armyOnScreen(t, k, a.id);
  const to = onScreen(t, k, harrow.x, harrow.y);
  t.expect(onStage(t, to), "Harrowfield is on screen to draw to");
  t.stroke(t.line(from, to));
  t.expect(k.committed?.order?.kind === "marchArmy" || k.committed?.order?.kind === "moveKing",
    "the line commits a march (" + (k.committed?.order?.kind ?? "none") + ")");
  stepUntil(t, () => w.contact !== null, 20, "the march comes to Harrowfield's walls");
  await t.waitFor(() => t.hook.top() === "kingdom-contact", () => "the contact interstitial (top: " + t.hook.top() + ")");
}

scenario("k10-siege-walls", "march on a walled town: a siege battle at its walls; what it knocks down stays down, and is mended in the city", async (t) => {
  const store = memoryStorage({ [KINGDOM_SAVE_KEY]: siegeSave() });
  t.boot({ storage: () => store });
  const k = await openRealm(t);
  const w = k.world;
  const harrow = w.holding(holdingNamed(k, "Harrowfield").id)!;
  t.expect(harrow.walls === 0, "Harrowfield's walls start whole");
  await marchOnTheWalls(t, k);

  // -- the interstitial: a siege, and how it is won ------------------------------
  const c = w.contact!;
  t.expect(c.kind === "assault", "the march halts at the walls: an assault");
  const panel = document.querySelector(".k-contact")?.textContent ?? "";
  t.expect(panel.includes(CONTACT.titleAssault("Harrowfield")), "it asks about the walls of Harrowfield");
  const how = document.querySelector(".k-contact-siege")?.textContent ?? "";
  t.expect(how.startsWith("A siege: get ") && how.includes("inside the walls"), "and says it is a siege, and how it is won (" + how + ")");
  t.expect(panel.includes(CONTACT.walls.wall), "the townsmen are behind a stone wall");

  // -- the battle at the walls --------------------------------------------------
  t.clickButton(CONTACT.fight);
  await t.waitFor(() => t.hook.battle() !== null, () => "the battle (screens: " + t.hook.screens().join(" > ") + ")");
  const b = t.hook.battle()!;
  const works = b.world.siege;
  t.expect(works !== null && works.kind === "wall" && works.defender === 1 && works.gates.length === 2,
    "it is fought at the town's stone walls, two gates, the townsmen behind them");
  t.expect(b.world.victory.mode === "breakthrough", "won by getting men inside, or held by holding out");
  await t.frames(2);
  t.expect(t.hudText().includes("walls whole"), "the HUD says how much of the walls stands (" + t.hudText().split("\n").join(" | ") + ")");
  t.expect(!t.hudText().includes("G to open"), "and offers the gates only to their defender");
  t.key("Enter");
  t.expect(!b.world.deploying, "Enter begins the siege");
  await t.frames(3);
  t.hook.forceOutcome(0, { breach: 24 });
  t.expect(b.world.wallDamage() > 0, "a stretch of the wall line is down (" + b.world.wallDamage() + "‰)");
  await t.waitFor(() => t.hook.top() === "after-action", () => "the after-action report (top: " + t.hook.top() + ")");
  const report = t.byId("report").textContent ?? "";
  t.expect(report.includes("The siege knocked down ") && report.includes("walls of Harrowfield"),
    "the report says what the siege knocked down");
  const down = harrow.walls;
  t.expect(down > 0 && down === b.world.wallDamage(), "and the holding's walls carry the battle's damage (" + down + "‰)");
  t.expect(harrow.owner === "king", "the walls stormed, Harrowfield is the king's");

  // -- back on the map: the feed and the region card ----------------------------
  t.clickButton(DESCENT.backToMap);
  await t.waitFor(() => t.hook.top() === "kingdom" && !k.isSuspended, () => "back on the map (top: " + t.hook.top() + ")");
  const feed = document.getElementById("kingdom-ui")?.textContent ?? "";
  t.expect(feed.includes(INVASION_FEED.wallsDamaged({ place: "Harrowfield", pct: Math.round(down / 10) })), "the feed says the walls are down");
  await openRegionCard(t, k, "Harrowfield");
  const wallsRow = document.querySelector(".k-card .k-walls")?.textContent ?? "";
  t.expect(wallsRow.includes(C.wallsDown(Math.round(down / 10))), "the region card shows the walls down (" + wallsRow + ")");

  // -- the city: the breach drawn, the wall's lot mends it ----------------------
  const city = await enterByCard(t, k, "Harrowfield");
  await t.waitFor(() => city.renderer.stats.frames > 2, "the town plan to draw");
  t.expect(city.renderer.stats.enclosure === "wall" && city.renderer.stats.breaches > 0,
    "the plan draws the stone wall with its breach (" + city.renderer.stats.breaches + ")");
  const lot = harrow.buildings.indexOf("wall");
  t.click(panelButton(t, "lot-" + lot));
  await t.waitFor(() => t.hook.top() === "lot-card" && city.card?.index === lot, () => "the wall's lot card (top: " + t.hook.top() + ")");
  const card = document.querySelector(".k-card")?.textContent ?? "";
  t.expect(card.includes(C.walls) && card.includes(C.wallsDown(Math.round(down / 10))), "the lot card says how much of the wall is down (" + card + ")");
  t.expect(card.includes("Mending costs "), "and, in its own words, what mending it costs (audit K10-01)");
  const timber0 = w.kingStocks.stocks.timber;
  t.clickButton(C.repairWalls);
  stepDays(t, 1);
  const feed2 = document.getElementById("kingdom-ui")?.textContent ?? "";
  t.expect(harrow.mend > 0 && w.kingStocks.stocks.timber < timber0 && feed2.includes(INVASION_FEED.wallsMending("Harrowfield")),
    "Repair walls pays the masons and sets them to work (timber " + timber0 + " -> " + w.kingStocks.stocks.timber + ", mend " + harrow.mend + ")");
  const before = harrow.walls;
  stepDays(t, 1);
  t.expect(harrow.walls === Math.max(0, before - WALL_REPAIR.perDay), "a day on, the walls are going up (" + before + " -> " + harrow.walls + ")");
});

/**
 * k10-keep-gates -- the king's Rookstead behind a stone wall, its townsmen
 * alone, the Hare's host (with an engine) on the road at it (a prepared
 * save). Days pass with the real "." key until the host is at the walls;
 * Retreat to the keep gives the town up and puts the keep's siege to the
 * king (the interstitial asks again, about the keep); Fight goes down into a
 * siege of two courses of stone with one gate, the king's townsmen holding
 * it; the real G key swings the gate open (the HUD and the terrain say so)
 * and shut again; the outcome is forced through the hook (the keep holds, a
 * stretch of it battered down); the report and the feed say the keep held,
 * and the holding is still the king's, its walls carrying the damage.
 */
function keepSave(): string {
  const w = new KingdomWorld({ seed: SAVE_SEED });
  const town = w.holdingByKey("rookstead")!;
  town.owner = "king";
  town.population = Math.max(town.population, 240);
  town.buildings[town.buildings.indexOf(null)] = "wall";
  const hare = FACTION_IDS.indexOf("hare");
  const host = raiseArmy(w, hare, w.holdingByKey("harrowfield")!.id, ["siege", "line", "line", "line", "archer"], "defensive");
  host.supply = 5000;
  w.issue({ kind: "marchArmy", army: host.id, to: town.id }, hare);
  w.tick();
  w.events = [];
  return saveToJson(w);
}

scenario("k10-keep-gates", "the Hare at the king's walls: retreat to the keep, a real siege of the keep, its gate swung with G, the keep holds", async (t) => {
  const store = memoryStorage({ [KINGDOM_SAVE_KEY]: keepSave() });
  t.boot({ storage: () => store });
  const k = await openRealm(t);
  const w = k.world;
  const town = w.holding(holdingNamed(k, "Rookstead").id)!;
  if (k.clock.run !== "paused") t.key("Space");
  // Days pass with the real key; word of the host may come first (K8's rumour card), and is put away.
  for (let i = 0; i < 40 && !w.contact; i++) {
    if (t.hook.top() === "kingdom-rumour") t.key("Escape");
    t.key("Period");
  }
  t.expect(w.contact !== null && w.contact.kind === "assault" && w.contact.attacker === 1, "the Hare's host comes to Rookstead's walls");
  await t.waitFor(() => t.hook.top() === "kingdom-contact", () => "the contact interstitial (top: " + t.hook.top() + ")");

  // -- the keep ------------------------------------------------------------------
  t.clickButton(DEFEND.keep);
  await t.waitFor(() => t.hook.top() === "kingdom-contact" && (document.querySelector(".k-contact h2")?.textContent ?? "") === CONTACT.titleKeep("Rookstead"),
    () => "the interstitial again, for the keep (top: " + t.hook.top() + ", title: " + (document.querySelector(".k-contact h2")?.textContent ?? "") + ")");
  t.expect(w.contact !== null && w.contact.keep === true, "the contact waits, the townsmen in the keep");
  const how = document.querySelector(".k-contact-siege")?.textContent ?? "";
  t.expect(how.startsWith("A siege: hold for "), "it says the keep is to be held, and how (" + how + ")");
  t.expect(!(document.querySelector(".k-contact")?.textContent ?? "").includes(DEFEND.keep), "the keep is not offered twice");
  const feed = document.getElementById("kingdom-ui")?.textContent ?? "";
  t.expect(feed.includes(INVASION_FEED.keepRetreat("Rookstead")), "the feed says the town outside is given up");

  // -- the siege of the keep -----------------------------------------------------
  t.clickButton(CONTACT.fight);
  await t.waitFor(() => t.hook.battle() !== null, () => "the battle (screens: " + t.hook.screens().join(" > ") + ")");
  const b = t.hook.battle()!;
  const works = b.world.siege;
  t.expect(works !== null && works.defender === 0 && works.thickness === 2 && works.gates.length === 1,
    "a siege of the keep: two courses, one gate, the king's townsmen holding it");
  await t.frames(2);
  t.expect(t.hudText().includes("walls whole") && !t.hudText().includes("G to open"), "deploying, the HUD says the walls stand, and offers no gate yet");
  t.key("Enter");
  t.expect(!b.world.deploying, "Enter begins the siege");
  await t.frames(2);
  t.expect(t.hudText().includes("gates shut - G to open"), "the HUD offers the gate to its holder (" + t.hudText().split("\n").join(" | ") + ")");
  const gate = gateTiles(b.world.terrain, works!, 0);
  t.key("KeyG");
  await t.waitFor(() => b.world.gatesOpen(0), "the gate to swing open");
  t.expect(gate.every((i) => b.world.terrain.type[i] === Terrain.GateOpen), "every course of the gateway stands open");
  await t.frames(2);
  t.expect(t.hudText().includes("gates open - G to shut"), "and the HUD says so");
  t.key("KeyG");
  await t.waitFor(() => !b.world.gatesOpen(0), "the gate to swing shut");
  t.expect(gate.every((i) => b.world.terrain.type[i] === Terrain.Gate), "the gateway is shut again");
  t.hook.forceOutcome(0, { breach: 12 });
  t.expect(b.world.wallDamage() > 0, "a stretch of the keep is battered down (" + b.world.wallDamage() + "‰)");
  await t.waitFor(() => t.hook.top() === "after-action", () => "the after-action report (top: " + t.hook.top() + ")");
  const report = t.byId("report").textContent ?? "";
  t.expect(report.includes(INVASION_FEED.siege({ place: "Rookstead", held: true })), "the report says the keep held");
  t.expect(report.includes("walls of Rookstead"), "and what the siege knocked down");
  t.expect(w.contact === null && town.owner === "king", "Rookstead is still the king's");
  t.expect(town.walls > 0 && town.walls === b.world.wallDamage(), "its walls carry the siege's damage (" + town.walls + "‰)");
  t.clickButton(DESCENT.backToMap);
  await t.waitFor(() => t.hook.top() === "kingdom" && !k.isSuspended, () => "back on the map (top: " + t.hook.top() + ")");
  const feed2 = document.getElementById("kingdom-ui")?.textContent ?? "";
  t.expect(feed2.includes(INVASION_FEED.siege({ place: "Rookstead", held: true })), "the feed says the keep held");
});
