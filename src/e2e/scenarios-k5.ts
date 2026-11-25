/**
 * K5 scenarios: the descent, as a player meets it (PLAN.md §B.9).
 *
 * k5-descent-fight -- the king's army at Rookstead, the Hare's host at
 * Harrowfield (a prepared save, because a new exile takes a season to field
 * an army worth the name). March on Harrowfield with a pen line; the realm
 * halts on contact and asks "Riders on the Harrowfield road" with Fight,
 * Withdraw and Resolve for me; Fight goes down into the battle, deployed,
 * waiting on Enter; the outcome (forced through the hook: it stands for the
 * fifteen minutes of fighting); the after-action says what it meant for the
 * realm; Back to the map comes up at the contact with the survivors applied
 * and the Hare's host falling back.
 *
 * k5-descent-withdraw -- the same contact, left undecided: the game is
 * closed and continued, and the question is asked again; then Withdraw pays
 * its rearguard and falls back. And a battle left mid-fight (Esc, the
 * confirm) counts as a withdrawal under fire.
 *
 * k5-descent-resolve -- Resolve for me settles it without a battle.
 *
 * Every input is a real DOM event (harness.ts): pen strokes on the canvas,
 * clicks, keys. The test hook is only read -- apart from forceOutcome.
 */

import type { KingdomLayer } from "../app/kingdom-layer.ts";
import { KINGDOM_SAVE_KEY } from "../app/kingdom-save.ts";
import { KingdomWorld } from "../sim/kingdom/world.ts";
import { saveToJson } from "../sim/kingdom/save.ts";
import { armyById, armyMen, raiseArmy, standsIn } from "../sim/kingdom/armies.ts";
import { moverAt } from "../sim/kingdom/graph.ts";
import { contactPoint, rearguardOf } from "../sim/kingdom/descent.ts";
import { armyCounters } from "../input/kingdom-commander.ts";
import { CONTACT, DESCENT } from "../content/kingdom/descent-strings.ts";
import { WITHDRAW_MORALE } from "../content/kingdom/descent.ts";
import { K } from "../content/kingdom/ui-strings.ts";
import { memoryStorage, scenario, type Driver, type Pt } from "./harness.ts";
import { holdingNamed, onScreen, stepUntil } from "./scenarios-k3.ts";

const SAVE_SEED = 0x6b5;

/** The king riding with a fed army of four squads at Rookstead; the Hare's host at Harrowfield. */
function descentSave(): string {
  const w = new KingdomWorld({ seed: SAVE_SEED, hosts: true });
  const rook = w.holdingByKey("rookstead")!.id;
  const a = raiseArmy(w, 0, rook, ["line", "line", "slinger", "archer"]);
  a.supply = 2000;
  w.king.mover = moverAt(rook);
  w.king.army = a.id;
  w.events = [];
  return saveToJson(w);
}

/** From Home into the saved realm, whatever is on top once it opens. */
async function openRealm(t: Driver): Promise<KingdomLayer> {
  t.clickButton(K.homeButton);
  await t.waitFor(() => t.hook.kingdom() !== null, () => "the kingdom map (screens: " + t.hook.screens().join(" > ") + ")");
  const k = t.hook.kingdom()!;
  await t.waitFor(() => k.renderer.stats.frames > 2, "the map to draw a few frames");
  return k;
}

function armyOnScreen(t: Driver, k: KingdomLayer, army: number): Pt {
  const c = armyCounters(k.world, k.armiesDrawn(), k.cam.pxToWorld).find((x) => x.army.id === army);
  t.expect(c !== undefined, "army " + army + " is drawn on the map");
  return onScreen(t, k, c!.counter.x, c!.counter.y);
}

/** A wheel notch on the stage at a screen point (positive deltaY zooms out). */
function wheel(t: Driver, p: Pt, deltaY: number): void {
  const W = (globalThis as unknown as { WheelEvent: typeof WheelEvent }).WheelEvent;
  t.byId("stage").dispatchEvent(new W("wheel", {
    bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, deltaY, deltaMode: 0,
  }));
}

/** Inside the view the map is drawn in (the window; the stage fills it). */
function onStage(t: Driver, p: Pt): boolean {
  const r = t.byId("stage").getBoundingClientRect();
  return p.x >= r.left && p.x <= r.left + window.innerWidth && p.y >= r.top && p.y <= r.top + window.innerHeight;
}

/** Pause, and march the king's army on Harrowfield with a pen line from its counter. Steps days until the realm halts on contact. */
async function marchIntoTheHare(t: Driver, k: KingdomLayer): Promise<void> {
  if (k.clock.run !== "paused") t.key("Space");
  const w = k.world;
  const a = w.armies.find((x) => x.owner === 0)!;
  const harrow = holdingNamed(k, "Harrowfield");
  // Wheel out about the army until the road to Harrowfield is all in view.
  for (let i = 0; i < 12 && !onStage(t, onScreen(t, k, harrow.x, harrow.y)); i++) {
    wheel(t, armyOnScreen(t, k, a.id), 120);
    await t.frames(1);
  }
  const from = armyOnScreen(t, k, a.id);
  const to = onScreen(t, k, harrow.x, harrow.y);
  t.expect(onStage(t, to), "Harrowfield is on screen to draw to (" + Math.round(to.x) + ", " + Math.round(to.y) + ")");
  t.stroke(t.line(from, to));
  t.expect(k.committed?.order?.kind === "marchArmy" || k.committed?.order?.kind === "moveKing",
    "the line commits a march (" + (k.committed?.order?.kind ?? "none") + ")");
  stepUntil(t, () => w.contact !== null, 20, "the march meets the Hare's host");
  await t.waitFor(() => t.hook.top() === "kingdom-contact", () => "the contact interstitial (top: " + t.hook.top() + ")");
}

/** The interstitial as a player meets it: the question, the focus, the three choices. */
function checkInterstitial(t: Driver, k: KingdomLayer): void {
  const panel = document.querySelector(".k-contact");
  const text = panel?.textContent ?? "";
  t.expect(text.includes(CONTACT.titleField("Harrowfield")), "it asks about the riders on the Harrowfield road (" + text.slice(0, 80) + ")");
  t.expect(k.clock.run === "paused", "the kingdom clock paused itself");
  t.expect((document.activeElement as HTMLElement | null)?.id === "k-contact-title", "focus is on the question, not on a choice");
  t.expect(t.hasButton(CONTACT.fight) && t.hasButton(CONTACT.withdraw) && t.hasButton(CONTACT.auto), "Fight, Withdraw and Resolve for me are offered");
  t.key("Escape");
  t.expect(t.hook.top() === "kingdom-contact", "Esc does not wave the question away");
  t.key("Tab");
  const focused = document.activeElement as HTMLElement | null;
  t.expect(focused !== null && focused.tagName.toLowerCase() === "button" && (focused.getAttribute("data-key") ?? "").startsWith("contact-"),
    "Tab reaches the choices");
}

scenario("k5-descent-fight", "march into the Hare's host: contact, fight, the battle, the after-action, survivors back on the map", async (t) => {
  const store = memoryStorage({ [KINGDOM_SAVE_KEY]: descentSave() });
  t.boot({ storage: () => store });
  const k = await openRealm(t);
  const w = k.world;
  const a = w.armies.find((x) => x.owner === 0)!;
  const host = w.armies.find((x) => x.owner !== 0)!;
  await marchIntoTheHare(t, k);
  checkInterstitial(t, k);
  const c = w.contact!;
  const at = contactPoint(w, c);
  const men0 = armyMen(a);
  const legit0 = w.kingStocks.legitimacy;

  t.clickButton(CONTACT.fight);
  await t.waitFor(() => t.hook.battle() !== null, () => "the battle (screens: " + t.hook.screens().join(" > ") + ")");
  const b = t.hook.battle()!;
  t.expect(b.world.deploying, "the army arrives drawn up, deploying");
  let fielded = 0;
  for (let i = 0; i < b.world.soldiers.count; i++) if (b.world.soldiers.player[i] === 0) fielded++;
  t.expect(fielded === men0 - a.squads.reduce((n, q) => n + q.wounded, 0), "the king's fit men took the field (" + fielded + ")");
  t.expect(t.hook.realm() === k && k.isSuspended, "the realm waits under the battle, not torn down");
  t.expect(t.hook.layerHash() !== null, "the combined layer hash covers both layers");
  t.key("Enter");
  t.expect(!b.world.deploying, "Enter begins the battle");
  await t.frames(3);
  t.hook.forceOutcome(0);
  await t.waitFor(() => t.hook.top() === "after-action", () => "the after-action report (top: " + t.hook.top() + ")");
  const report = t.byId("report").textContent ?? "";
  t.expect(report.includes(DESCENT.heading), "the report says what it means for the realm");
  t.expect(report.includes(DESCENT.legitimacyUp(2)) && report.includes("came back"), "survivors and legitimacy are in it");
  t.expect(w.contact === null && w.kingStocks.legitimacy === legit0 + 2, "the result is already the realm's (and saved)");

  t.clickButton(DESCENT.backToMap);
  await t.waitFor(() => t.hook.top() === "kingdom" && !k.isSuspended, () => "back on the map (top: " + t.hook.top() + ")");
  t.expect(t.hook.kingdom() === k && t.hook.battle() === null, "the same realm, the battle torn down");
  const mine = armyById(w, a.id);
  let alive = 0;
  for (let i = 0; i < b.world.soldiers.count; i++) if (b.world.soldiers.player[i] === 0 && b.world.soldiers.alive[i] === 1) alive++;
  // The battle's living, and the wounded who waited with the baggage.
  const want = alive + (men0 - fielded);
  t.expect(mine !== undefined && armyMen(mine) === want, "the survivors are the battle's (" + (mine ? armyMen(mine) : 0) + ", battle says " + want + ")");
  const theirs = armyById(w, host.id);
  t.expect(!theirs || theirs.mover.route.length > 0 || standsIn(theirs.mover) !== standsIn(host.mover), "the Hare's host falls back");
  await t.frames(30);
  t.expect(onStage(t, onScreen(t, k, at.x, at.y)), "the map came back at the contact");
  t.expect(k.clock.run === "paused", "and the clock waits for the player to set it going");
});

scenario("k5-descent-withdraw", "leave the question, continue: it is asked again; withdraw; a battle left mid-fight is a withdrawal", async (t) => {
  const store = memoryStorage({ [KINGDOM_SAVE_KEY]: descentSave() });
  t.boot({ storage: () => store });
  let k = await openRealm(t);
  await marchIntoTheHare(t, k);
  const contactId = k.world.contact!.id;

  // Close the game with the question unanswered, and continue it.
  t.boot({ storage: () => store });
  k = await openRealm(t);
  await t.waitFor(() => t.hook.top() === "kingdom-contact", () => "the question again on continue (top: " + t.hook.top() + ")");
  t.expect(k.world.contact?.id === contactId, "the same meeting waits");
  checkInterstitial(t, k);

  // A battle left mid-fight: the losses stand, the rearguard is paid, it falls back.
  const w = k.world;
  const a = w.armies.find((x) => x.owner === 0)!;
  const men0 = armyMen(a);
  const rear = rearguardOf(a);
  t.clickButton(CONTACT.fight);
  await t.waitFor(() => t.hook.battle() !== null, "the battle");
  t.key("Enter");
  await t.frames(2);
  t.key("Escape");
  await t.waitFor(() => t.hasButton(DESCENT.leaveYes), "the leave confirm");
  t.expect((t.byId("dialog").textContent ?? "").includes("withdrawal under fire"), "the confirm says what leaving costs");
  t.clickButton(DESCENT.leaveYes);
  await t.waitFor(() => t.hook.top() === "kingdom" && !k.isSuspended, () => "back on the map (top: " + t.hook.top() + ")");
  t.expect(w.contact === null, "the meeting is settled");
  const after = armyById(w, a.id);
  t.expect(after !== undefined && armyMen(after) <= men0 - rear, "the rearguard was paid (" + men0 + " -> " + (after ? armyMen(after) : 0) + ")");
  t.expect(!!after && after.mover.route.length > 0, "and the army falls back");

  // And Withdraw from the interstitial itself.
  t.boot({ storage: () => memoryStorage({ [KINGDOM_SAVE_KEY]: descentSave() }) });
  const k2 = await openRealm(t);
  await marchIntoTheHare(t, k2);
  const a2 = k2.world.armies.find((x) => x.owner === 0)!;
  const m2 = armyMen(a2);
  const r2 = rearguardOf(a2);
  const mor = a2.morale;
  t.expect((document.querySelector(".k-contact")?.textContent ?? "").includes(CONTACT.withdrawHint(r2, WITHDRAW_MORALE)), "Withdraw says what it costs");
  t.clickButton(CONTACT.withdraw);
  await t.waitFor(() => t.hook.top() === "kingdom", () => "the map again (top: " + t.hook.top() + ")");
  t.expect(k2.world.contact === null && armyMen(a2) === m2 - r2 && a2.morale === mor - WITHDRAW_MORALE, "a rearguard and some nerve");
  t.expect(a2.mover.route.length > 0, "and it falls back");
});

scenario("k5-descent-resolve", "resolve for me: the meeting settled without a battle", async (t) => {
  const store = memoryStorage({ [KINGDOM_SAVE_KEY]: descentSave() });
  t.boot({ storage: () => store });
  const k = await openRealm(t);
  await marchIntoTheHare(t, k);
  const saves = k.saves;
  t.clickButton(CONTACT.auto);
  await t.waitFor(() => t.hook.top() === "kingdom", () => "the map again (top: " + t.hook.top() + ")");
  t.expect(t.hook.battle() === null && k.world.contact === null, "settled with no battle fought");
  t.expect(k.saves > saves, "and saved");
  const feed = document.getElementById("kingdom-ui")?.textContent ?? "";
  t.expect(feed.includes("holds the field") || feed.includes("is beaten"), "the feed says how it went");
});
