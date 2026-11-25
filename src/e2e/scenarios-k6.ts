/**
 * K6 end-to-end: the politics card's levers, driven with real events (PLAN.md
 * §B.11 K6, docs/audit/u2-politics-panel.md). Open a city, press P, pull a
 * lever with a real click, step a day with the real "." key, and see the
 * town's unrest answer -- on the card, in the sim, and in the HUD's Mercy.
 */

import { scenario } from "./harness.ts";
import { claimGreyshaw, enterByCard, holdingNamed, openPaused, stepDays } from "./scenarios-k3.ts";
import { E } from "../content/kingdom/ui-strings.ts";
import { CAUSE_LABEL, JUSTICE_NAME, MERCY, MORALE_REFUSAL, P, unrestPoints } from "../content/kingdom/morale-strings.ts";
import { JUSTICE, PARDON, TAX_UNREST } from "../content/kingdom/morale.ts";
import { unrestTrend } from "../sim/kingdom/morale.ts";

scenario("k6-politics-levers", "open a city's politics, pull tax, justice and a pardon with real events, and see unrest respond", async (t) => {
  t.boot();
  const k = await openPaused(t);
  const w = k.world;
  await claimGreyshaw(t, k);
  const h = w.holding(holdingNamed(k, "Greyshaw").id)!;
  await enterByCard(t, k, "Greyshaw");
  t.key("KeyP");
  t.expect(t.hook.top() === "politics-card", "P opens the politics card (top: " + t.hook.top() + ")");
  const card = (): string => document.querySelector(".k-card")?.textContent ?? "";
  t.expect(card().includes("unrest " + unrestPoints(h.unrest) + " of 100"), "the card shows the town's unrest as the sim has it (" + h.unrest + ")");
  t.expect(card().includes(P.thresholds), "and says where the thresholds are");

  // -- a harsh tax: the trend turns up, and the day moves it by just that ----------
  const calm = unrestTrend(w, h);
  t.click(t.button("Harsh"));
  stepDays(t, 1);
  t.expect(h.tax === "harsh", "the harsh tax is set from the politics card (" + h.tax + ")");
  const harsh = unrestTrend(w, h);
  t.expect(harsh - calm === TAX_UNREST.harsh - TAX_UNREST.normal, "the town's trend rises by the tax's row (" + calm + " -> " + harsh + ")");
  t.expect(card().includes(CAUSE_LABEL.tax + ": raises"), "the card lists the taxes as raising unrest");
  const u1 = h.unrest;
  stepDays(t, 1);
  t.expect(h.unrest - u1 === harsh, "a day under it moves unrest by the trend the card showed (" + u1 + " -> " + h.unrest + ")");
  t.expect(card().includes("unrest " + unrestPoints(h.unrest) + " of 100"), "and the card follows (" + unrestPoints(h.unrest) + ")");

  // -- the rope: justice calms it, and the pressed toggle says so ------------------
  t.click(t.button(JUSTICE_NAME.rope));
  stepDays(t, 1);
  t.expect(h.justice === "rope", "the rope is set (" + h.justice + ")");
  t.expect(t.button(JUSTICE_NAME.rope).getAttribute("aria-pressed") === "true", "and the pressed toggle says so");
  t.expect(unrestTrend(w, h) - harsh === JUSTICE.rope.unrest, "justice calms the trend by its row (" + harsh + " -> " + unrestTrend(w, h) + ")");
  t.expect(card().includes(CAUSE_LABEL.justice + ": calms"), "the card lists justice as calming");

  // -- a pardon: at once, and the realm's mercy shows on the HUD --------------------
  const u2 = h.unrest;
  const t2 = unrestTrend(w, h);
  t.click(t.button(P.pardon));
  stepDays(t, 1);
  t.expect(h.unrest === Math.max(0, u2 + PARDON.unrest + t2) || h.unrest === Math.max(0, u2 + PARDON.unrest), "the pardon calms the town at once (" + u2 + " -> " + h.unrest + ")");
  t.expect(k.hud.resources.mercyText === MERCY.name + " " + PARDON.mercy, "the HUD shows the realm's mercy (" + k.hud.resources.mercyText + ")");

  // -- a second pardon this season: refused, and the press says why -----------------
  const pardon = t.button(P.pardon);
  t.expect(pardon.getAttribute("aria-disabled") === "true", "the pardon button is marked unavailable");
  const queued = w.orders.queued().length;
  t.click(pardon);
  t.expect(card().includes(E.notNow(MORALE_REFUSAL.pardonedThisSeason)), "a refused press says why, in words");
  t.expect(w.orders.queued().length === queued, "and sends no order");

  t.key("Escape");
  t.expect(t.hook.top() !== "politics-card", "Esc closes the politics card");
});
