/**
 * K8 end-to-end: a rumour of a host riding at the king's holding, and a
 * defence tool used through the UI (PLAN.md §B.11 K8, docs/audit/k8-ai-invasions.md).
 *
 * k8-rumour-levy -- a realm with captains (sim/kingdom/ai.ts) in which the
 * king holds the Reach, run on to the morning before word first comes of a
 * host riding at one of his towns (a prepared save, played forward by the
 * sim itself: the captains' own orders bring the host, nothing is placed by
 * hand). One day passes with the real "." key; the rumour card comes up,
 * holds the clock and takes focus on its title; Tab reaches the tools and
 * stays in the card; "Call the levy" is pressed -- and the town's levy
 * stands in it the next day, dug in, its men taken from the people.
 *
 * Every input is a real DOM event (harness.ts). The test hook is only read.
 */

import type { KingdomLayer } from "../app/kingdom-layer.ts";
import { KINGDOM_SAVE_KEY } from "../app/kingdom-save.ts";
import { KingdomWorld } from "../sim/kingdom/world.ts";
import { saveToJson } from "../sim/kingdom/save.ts";
import { credit } from "../sim/kingdom/ledger.ts";
import { updateSight } from "../sim/kingdom/explore.ts";
import { armiesOf, standsIn } from "../sim/kingdom/armies.ts";
import { TICKS_PER_DAY } from "../sim/kingdom/clock.ts";
import { KING_PLAYER } from "../content/kingdom/factions.ts";
import { RUMOUR } from "../content/kingdom/invasion-strings.ts";
import { K } from "../content/kingdom/ui-strings.ts";
import { memoryStorage, scenario, type Driver } from "./harness.ts";
import { stepDays, stepUntil } from "./scenarios-k3.ts";

const SAVE_SEED = 0x6b8;
/** The Reach: the king's five towns in the south-west (as tools/kingdom-ai.ts). */
const REACH = ["cold-hearth", "greyshaw", "thornwick", "rookstead", "fell-end"];

/**
 * A captains realm in which the king holds the Reach, kept fed and calm by
 * hand, played on by the sim until the tick that first raises a rumour; the
 * save is the realm as it stood just before that tick (at a day's start).
 */
function rumourSave(): string {
  const w = new KingdomWorld({ seed: SAVE_SEED, hosts: true, captains: true });
  for (const key of REACH) {
    const h = w.holdingByKey(key);
    if (!h) continue;
    h.owner = "king";
    if (h.population < 40) h.population = 40;
  }
  updateSight(w, KING_PLAYER);
  let before = "";
  while (w.date.day < 400) {
    if (w.now % TICKS_PER_DAY === 0 && !w.contact) {
      const e = w.economy[KING_PLAYER];
      const b = w.books[KING_PLAYER];
      if (e.stocks.grain < 600) credit(e, b, "grain", 600 - e.stocks.grain, "trade");
      if (e.stocks.coin < 400) credit(e, b, "coin", 400 - e.stocks.coin, "trade");
      for (const h of w.holdings) if (h.owner === "king") h.unrest = 0;
      w.events = [];
      before = saveToJson(w);
    }
    if (w.contact) w.issue({ kind: "resolveContact", contact: w.contact.id, choice: "auto", result: null });
    if (w.tick().some((e) => e.kind === "rumour")) return before;
  }
  throw new Error("no rumour came in 400 days");
}

/** From Home into the saved realm, whatever is on top once it opens. */
async function openRealm(t: Driver): Promise<KingdomLayer> {
  t.clickButton(K.homeButton);
  await t.waitFor(() => t.hook.kingdom() !== null, () => "the kingdom map (screens: " + t.hook.screens().join(" > ") + ")");
  const k = t.hook.kingdom()!;
  await t.waitFor(() => k.renderer.stats.frames > 2, "the map to draw a few frames");
  return k;
}

scenario("k8-rumour-levy", "word comes of a host riding at the king's town; the rumour card asks; Call the levy turns the town out", async (t) => {
  const store = memoryStorage({ [KINGDOM_SAVE_KEY]: rumourSave() });
  t.boot({ storage: () => store });
  const k = await openRealm(t);
  const w = k.world;
  t.expect(w.captains, "the realm has captains");
  if (!k.rumourOpen) {
    if (k.clock.run !== "paused") t.key("Space");
    stepUntil(t, () => k.rumourOpen, 2, "a day on, word comes of a host");
  }
  t.expect(t.hook.top() === "kingdom-rumour", "the rumour card is on top (top: " + t.hook.top() + ")");
  t.expect(w.rumours.length > 0, "the sim has the rumour (" + w.rumours.length + ")");
  const r = w.rumours[0];
  const target = w.holding(r.target)!;
  t.expect(target.owner === "king", "it rides at a town of the king's: " + target.name);

  const panel = document.querySelector(".k-rumour") as HTMLElement | null;
  const title = document.getElementById("k-rumour-title");
  t.expect(t.visible(panel) && panel!.getAttribute("role") === "dialog", "the card is a dialog on screen");
  t.expect((title?.textContent ?? "").startsWith("Riders seen on the") && (title?.textContent ?? "").includes(" road, "),
    "its title says where they were seen and how far out (" + (title?.textContent ?? "") + ")");
  t.expect((panel?.textContent ?? "").includes(target.name), "it names the town they ride for");
  // The 16px floor, where this DOM computes styles (the fake DOM does not: ui-check covers the CSS there).
  const size = typeof getComputedStyle === "function" ? parseFloat(getComputedStyle(title!).fontSize || "") : NaN;
  if (Number.isFinite(size)) t.expect(size >= 16, "the title is at least 16px (" + size + ")");
  else t.note("no computed styles in this DOM: the 16px floor is checked in the browser run and by ui-check");
  t.expect(document.activeElement === title, "focus is on the title, not on a tool (" + (document.activeElement?.textContent ?? "body") + ")");
  for (const label of [RUMOUR.levy, RUMOUR.burn, RUMOUR.ambush, RUMOUR.defend, RUMOUR.dismiss]) {
    t.expect(t.hasButton(label), "the card offers " + label);
  }

  // The realm is held while the card is read.
  const now0 = w.now;
  await t.frames(6);
  t.expect(w.now === now0, "the clock is held while the card is up");

  // Keyboard reachable: Tab reaches the first tool and stays inside the card.
  t.key("Tab");
  t.expect((document.activeElement as HTMLElement | null)?.getAttribute("data-key") === "rumour-levy",
    "Tab reaches Call the levy first (" + (document.activeElement?.textContent ?? "body") + ")");
  for (let i = 0; i < 9; i++) t.key("Tab");
  let n: Node | null = document.activeElement;
  while (n && n !== panel) n = n.parentNode;
  t.expect(n === panel, "and Tab stays inside the card");

  const people0 = target.population;
  const armies0 = armiesOf(w, KING_PLAYER).length;
  t.click(t.button(RUMOUR.levy));
  t.expect(!k.rumourOpen, "choosing closes the card (top: " + t.hook.top() + ")");
  if (k.clock.run !== "paused" && t.hook.top() === "kingdom") t.key("Space");
  stepDays(t, 1);

  const levy = armiesOf(w, KING_PLAYER).find((a) => standsIn(a.mover) === target.id && a.squads.every((q) => q.levy));
  t.expect(armiesOf(w, KING_PLAYER).length === armies0 + 1 && levy !== undefined, "a levy army stands in " + target.name);
  t.expect(levy !== undefined && levy.posture === "hold" && (target.garrisonSlots === 0 || target.garrison.includes(levy.id)),
    "and holds it, dug in (in its garrison where it has room: " + target.garrisonSlots + " slots)");
  const men = levy ? levy.squads.reduce((n, q) => n + q.men, 0) : 0;
  t.expect(men > 0 && target.population <= people0 - men, "its " + men + " men came from the town's people (" + people0 + " -> " + target.population + ")");
  t.expect(w.levied.some((l) => l.holding === target.id), "the town is marked as called out");
  t.expect(w.check({ kind: "callLevy", holding: target.id }) !== null, "and cannot be called again at once");
});
