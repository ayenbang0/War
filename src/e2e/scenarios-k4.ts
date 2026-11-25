/**
 * K4 scenarios: armies, as a player meets them.
 *
 * k4-armies -- from a new game: rally followers at Cold Hearth and raise the
 * first army from the king card's "Raise followers"; see its counter on the
 * map; march it with a pen line (the ghost first, then the commit); rally
 * again and form a second squad; split it with a line across its counter;
 * merge the two with a stroke between them; ring it to dig in; draw a heart
 * on it to rest; tap it for its card.
 *
 * k4-barracks-recruit -- trained squads at a barracks in a city: a realm that
 * already holds Greyshaw with a standing barracks (a prepared save, because a
 * new exile takes seasons to afford one), its city entered from the map, the
 * barracks' lot opened, Raise squads, Line Infantry -- and the new army on
 * the map with the coin and iron gone from the bar.
 *
 * Every input is a real DOM event (harness.ts): clicks, keys and pen strokes
 * on the canvas. The test hook is only read.
 */

import type { KingdomLayer } from "../app/kingdom-layer.ts";
import { KINGDOM_SAVE_KEY } from "../app/kingdom-save.ts";
import { KingdomWorld } from "../sim/kingdom/world.ts";
import { saveToJson } from "../sim/kingdom/save.ts";
import { credit } from "../sim/kingdom/ledger.ts";
import { armyById, armyMen, standsIn } from "../sim/kingdom/armies.ts";
import { armyCounters } from "../input/kingdom-commander.ts";
import { AC, PEN } from "../content/kingdom/army-strings.ts";
import { LEVY_MIN_MEN } from "../content/kingdom/armies.ts";
import { UNIT_TYPES } from "../content/unit-types.ts";
import { E } from "../content/kingdom/ui-strings.ts";
import { memoryStorage, scenario, type Driver, type Pt } from "./harness.ts";
import {
  barMatches, enterByCard, holdingNamed, kingOnScreen, onScreen, openPaused, panelButton, stepDays, stepUntil, tap,
} from "./scenarios-k3.ts";

async function openKingCard(t: Driver, k: KingdomLayer): Promise<void> {
  if (t.hook.top() !== "kingdom") t.key("Escape");
  tap(t, kingOnScreen(t, k));
  await t.waitFor(() => t.hook.top() === "king-card", () => "the king card (top: " + t.hook.top() + ")");
}

/** Where an army's counter is drawn, on screen -- the same layout the pen reads. */
function armyOnScreen(t: Driver, k: KingdomLayer, army: number): Pt {
  const c = armyCounters(k.world, k.armiesDrawn(), k.cam.pxToWorld).find((x) => x.army.id === army);
  t.expect(c !== undefined, "army " + army + " is drawn on the map");
  return onScreen(t, k, c!.counter.x, c!.counter.y);
}

function release(target: EventTarget, p: Pt): void {
  target.dispatchEvent(new PointerEvent("pointerup", {
    bubbles: true, cancelable: true, composed: true, pointerId: 1, pointerType: "mouse", isPrimary: true,
    clientX: p.x, clientY: p.y, button: 0, buttons: 0,
  }));
}

/** A heart in screen space, as a hand draws it: from the notch, round, and back. */
function heartAt(c: Pt, size: number): Pt[] {
  const out: Pt[] = [];
  const steps = 64;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const hx = 16 * Math.sin(a) ** 3;
    const hy = -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a));
    out.push({ x: c.x + (hx / 16) * size, y: c.y + (hy / 16) * size });
  }
  return out;
}

function kingdomText(t: Driver): string {
  const ui = document.getElementById("kingdom-ui");
  return ui && t.visible(ui) ? ui.textContent ?? "" : "";
}

/** The king card's "Raise followers", and the levy squad it forms. */
async function raiseFollowers(t: Driver, k: KingdomLayer, unit: "line" | "slinger"): Promise<void> {
  await openKingCard(t, k);
  t.expect(t.hasButton(AC.raiseLevy), "the king card offers " + AC.raiseLevy + " where he stands");
  t.clickButton(AC.raiseLevy);
  t.expect(t.hook.top() === "levy-menu", "it opens the levy menu (top: " + t.hook.top() + ")");
  const menu = document.querySelector(".k-menu")?.textContent ?? "";
  t.expect(menu.includes(UNIT_TYPES.line.name) && menu.includes(UNIT_TYPES.slinger.name), "the followers can form spears or slings");
  t.clickButton(UNIT_TYPES[unit].name);
  t.expect(t.hook.top() === "king-card", "choosing closes the menu");
  stepDays(t, 1);
}

scenario("k4-armies", "from a new game: raise the first army, march it by pen, split, merge, ring, heart, open its card", async (t) => {
  t.boot();
  const k = await openPaused(t);
  const w = k.world;
  t.expect(w.armies.length === 0, "a new exile has no army");

  // -- rally followers, and raise them where the king stands --------------------
  await openKingCard(t, k);
  t.clickButton(E.forage);
  stepDays(t, 3);
  t.clickButton(E.rally);
  stepUntil(t, () => w.kingStocks.stocks.levy >= LEVY_MIN_MEN, 12, "rallying brings at least " + LEVY_MIN_MEN + " followers");
  t.clickButton(E.forage);
  stepDays(t, 6);
  const followers = w.kingStocks.stocks.levy;
  await raiseFollowers(t, k, "line");
  t.expect(w.armies.length === 1, "the followers form the first army (" + w.armies.length + ")");
  const army = w.armies[0];
  t.expect(army.name === "First Army" && army.squads[0].men === followers && army.squads[0].levy,
    "the First Army: one levy squad of the " + followers + " followers");
  t.expect(w.king.army === army.id, "the king rides with it");
  t.expect(kingdomText(t).includes(AC.armyRaised(army.name, "Cold Hearth")), "the feed says it was raised");
  t.expect(kingdomText(t).includes(army.name), "the king card says whom he rides with");
  barMatches(t, k, "after raising the army");
  t.expect(k.hud.resources.burnText.includes("Armies:"), "the bar says what armies cost a day (" + k.hud.resources.burnText + ")");

  // -- see it -------------------------------------------------------------------
  t.key("Escape");
  const frames = k.renderer.stats.frames;
  await t.waitFor(() => k.renderer.stats.frames > frames + 1 && k.renderer.stats.armies === 1, "the army's counter to be drawn");

  // -- march it with a pen line: ghost, then commit ---------------------------------
  const dest = holdingNamed(k, "Greyshaw");
  const from = armyOnScreen(t, k, army.id);
  const to = onScreen(t, k, dest.x, dest.y);
  const held = t.stroke(t.line(from, to), { release: false });
  const preview = k.intent;
  t.expect(preview !== null && preview.ghost.kind === "march", "the stroke previews a march (" + (preview ? preview.ghost.kind : "none") + ")");
  const label = preview && preview.ghost.kind === "march" ? preview.ghost.label : "";
  t.expect(label.startsWith(army.name + ": march to Greyshaw") && label.includes("about"), "the ghost names the army, the place and an ETA (" + label + ")");
  t.expect(preview?.order?.kind === "marchArmy", "the preview's order is the army's march");
  release(held, to);
  t.expect(k.committed !== null && JSON.stringify(k.committed.order) === JSON.stringify(preview?.order), "release commits exactly the previewed order");
  stepUntil(t, () => standsIn(army.mover) === dest.id && army.mover.route.length === 0, 24, "the army marches to Greyshaw");
  t.expect(standsIn(w.king.mover) === dest.id, "and the king with it");

  // -- a second squad from new followers -------------------------------------------------
  await openKingCard(t, k);
  t.clickButton(E.rally);
  stepUntil(t, () => w.kingStocks.stocks.levy >= LEVY_MIN_MEN, 12, "rallying at Greyshaw brings more followers");
  await raiseFollowers(t, k, "slinger");
  t.expect(w.armies.length === 1 && army.squads.length === 2, "the slings join the king's army (" + army.squads.length + " squads)");
  t.key("Escape");
  await t.frames(2);

  // -- split: a line across its counter --------------------------------------------------
  const c = armyOnScreen(t, k, army.id);
  t.stroke(t.line({ x: c.x - 50, y: c.y - 4 }, { x: c.x + 50, y: c.y + 4 }));
  t.expect(k.committed?.order?.kind === "split", "a line across the army orders a split (" + (k.committed?.gesture.kind ?? "") + ")");
  stepDays(t, 1);
  t.expect(w.armies.length === 2, "the army splits in two (" + w.armies.length + ")");
  const second = w.armies[1];
  t.expect(second.name === "Second Army" && second.squads.length === 1 && army.squads.length === 1, "the Second Army takes the rear squad");
  t.expect(w.king.army === army.id, "the king stays with the First");
  t.expect(k.committed?.message === PEN.splitDone({ army: army.name, n: 1 }), "the result line said what the stroke did");
  t.expect(kingdomText(t).includes(AC.splitNews({ army: army.name, into: second.name })), "the feed says it happened");
  await t.frames(2);
  t.expect(k.renderer.stats.armies === 2, "both counters are drawn, side by side");

  // -- merge: a stroke from one to the other -------------------------------------------------
  const menBefore = armyMen(army) + armyMen(second);
  t.stroke(t.line(armyOnScreen(t, k, second.id), armyOnScreen(t, k, army.id), 3));
  t.expect(k.committed?.order?.kind === "merge", "a stroke between the two orders a merge (" + (k.committed?.gesture.kind ?? "") + ")");
  stepDays(t, 1);
  t.expect(w.armies.length === 1 && armyById(w, second.id) === undefined, "the Second folds into the First");
  t.expect(armyMen(army) <= menBefore && army.squads.length === 2, "with its squad (" + armyMen(army) + " of " + menBefore + " men)");
  await t.frames(2);

  // -- ring: dig in ---------------------------------------------------------------------------
  const c2 = armyOnScreen(t, k, army.id);
  const g = onScreen(t, k, dest.x, dest.y);
  t.stroke(t.loop((c2.x + g.x) / 2, (c2.y + g.y) / 2, 40, 40));
  t.expect(k.committed?.order?.kind === "garrison", "a ring round the army and its holding orders it to hold (" + (k.committed?.gesture.kind ?? "") + ")");
  stepDays(t, 1);
  t.expect(army.posture === "hold", "the army digs in (" + army.posture + ")");

  // -- heart: rest and mend --------------------------------------------------------------------
  t.stroke(heartAt(armyOnScreen(t, k, army.id), 42));
  t.expect(k.committed?.order?.kind === "recover", "a heart on the army orders it to rest (" + (k.committed?.gesture.kind ?? "") + ")");
  stepDays(t, 1);
  t.expect(army.posture === "recover", "the army rests to mend (" + army.posture + ")");

  // -- tap: its card -----------------------------------------------------------------------
  tap(t, armyOnScreen(t, k, army.id));
  t.expect(t.hook.top() === "army-card" && k.card?.kind === "army", "a tap on the counter opens the army card (top: " + t.hook.top() + ")");
  const card = document.querySelector(".k-card")?.textContent ?? "";
  t.expect(card.includes(army.name) && card.includes(AC.strength) && card.includes(AC.supply) && card.includes(AC.ledByKing(w.king.name)),
    "the card names the army, its strength, its supply and who leads it");
  t.expect(card.includes(UNIT_TYPES.line.name) && card.includes(UNIT_TYPES.slinger.name), "and lists its squads");
  for (const b of [AC.march, AC.patrol, AC.split, AC.setDoctrine, AC.disband]) t.expect(t.hasButton(b), "the card offers " + b);
  // Keyboard parity: the card's Split does what the pen did.
  t.clickButton(AC.split);
  stepDays(t, 1);
  t.expect(w.armies.length === 2, "the card's Split parts the army too");
  t.key("Escape");
  t.expect(t.hook.top() === "kingdom", "Esc closes the card");
});

/** A realm that already holds Greyshaw with a standing barracks, followers, coin and iron. */
function barracksSave(): string {
  const w = new KingdomWorld({ seed: 0x6b4 });
  const g = w.holdings.find((h) => h.name === "Greyshaw")!;
  g.owner = "king";
  const slot = g.buildings.indexOf(null);
  g.buildings[slot] = "barracks";
  g.works[slot] = 0;
  const e = w.economy[0];
  const book = w.books[0];
  credit(e, book, "coin", 60, "trade");
  credit(e, book, "iron", 6, "trade");
  credit(e, book, "levy", 30, "trade");
  credit(e, book, "grain", 200, "trade");
  return saveToJson(w);
}

scenario("k4-barracks-recruit", "enter a city with a barracks, open its lot, raise a trained squad; the army is on the map", async (t) => {
  const store = memoryStorage({ [KINGDOM_SAVE_KEY]: barracksSave() });
  t.boot({ storage: () => store });
  const k = await openPaused(t);
  const w = k.world;
  const g = holdingNamed(k, "Greyshaw");
  const lot = w.holding(g.id)!.buildings.indexOf("barracks");
  t.expect(lot >= 0 && w.armies.length === 0, "the realm holds Greyshaw's barracks, and no army yet");
  const coin0 = w.kingStocks.stocks.coin;
  const iron0 = w.kingStocks.stocks.iron;

  const city = await enterByCard(t, k, "Greyshaw");
  t.click(panelButton(t, "lot-" + lot));
  t.expect(t.hook.top() === "lot-card" && city.card?.index === lot, "the barracks' lot card opens (top: " + t.hook.top() + ")");
  t.expect(t.hasButton(AC.recruitButton), "a barracks lot offers " + AC.recruitButton);
  t.clickButton(AC.recruitButton);
  t.expect(t.hook.top() === "recruit-menu", "it opens the recruit dialog (top: " + t.hook.top() + ")");
  const menu = document.querySelector(".k-menu")?.textContent ?? "";
  t.expect(menu.includes(AC.recruitNew), "the dialog says the squad forms a new army");
  t.expect(menu.includes(UNIT_TYPES.horse.name) && menu.includes("coin"), "every kind of squad is listed with its cost");
  t.clickButton(UNIT_TYPES.line.name);
  t.expect(t.hook.top() === "lot-card", "choosing closes the dialog");
  stepDays(t, 1);
  t.expect(w.armies.length === 1 && w.armies[0].squads[0].unit === "line" && w.armies[0].squads[0].men === UNIT_TYPES.line.soldiers,
    "a full company of line infantry is raised (" + w.armies.length + ")");
  const a = w.armies[0];
  t.expect(standsIn(a.mover) === g.id && w.king.army === 0, "at Greyshaw, while the king is away at Cold Hearth");
  t.expect(w.kingStocks.stocks.coin < coin0 && w.kingStocks.stocks.iron < iron0, "its coin and iron are spent (" +
    coin0 + " -> " + w.kingStocks.stocks.coin + " coin)");
  barMatches(t, k, "after recruiting");

  // Back up to the map: the army's counter is there.
  t.key("Escape");
  t.key("Escape");
  await t.waitFor(() => t.hook.top() === "kingdom" && !k.isSuspended, () => "back on the map (top: " + t.hook.top() + ")");
  await t.waitFor(() => k.renderer.stats.armies === 1, "the new army's counter on the map");
  tap(t, armyOnScreen(t, k, a.id));
  t.expect(t.hook.top() === "army-card", "and its card opens from it (top: " + t.hook.top() + ")");
  t.expect((document.querySelector(".k-card")?.textContent ?? "").includes(AC.wagesLine({ coin: 2, unpaid: 0 }).split(" ")[0]),
    "a trained squad draws a wage");
});
