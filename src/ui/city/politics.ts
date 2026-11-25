/**
 * The politics card's K6 section (docs/audit/u2-politics-panel.md): the
 * town's loyalty and unrest, what moves it today, and the levers -- justice,
 * a festival, a pardon -- beside K3's tax (economy-panel.ts draws that).
 *
 * The cause list is morale.ts's `unrestCauses`, the SAME function the day
 * applies: the card never lists a cause the sim does not apply, nor the
 * reverse. Every lever is a button whose refusal is `world.check`, the SAME
 * check the tick makes; a refused press says why instead of acting (the army
 * card's rule, docs/audit/u2-army-panels.md).
 *
 * Built once; refresh changes text and attributes in place, so focus stays
 * on the control the player is using while the days run.
 */

import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { Holding } from "../../sim/kingdom/state.ts";
import type { KingdomOrderBody } from "../../sim/kingdom/orders.ts";
import { festivalCost, isRestless, unrestCauses, unrestReckoned, unrestTrend } from "../../sim/kingdom/morale.ts";
import { standing } from "../../sim/kingdom/economy.ts";
import { FESTIVAL, JUSTICE_IDS, unrestBand, type JusticeId } from "../../content/kingdom/morale.ts";
import {
  BAND_WORD, CAUSE_LABEL, JUSTICE_ABOUT, JUSTICE_NAME, LOYALTY_WORD, MORALE_FEED, P, unrestPoints,
} from "../../content/kingdom/morale-strings.ts";
import { E } from "../../content/kingdom/ui-strings.ts";
import { C } from "../../content/kingdom/city-strings.ts";
import { make, row, setText } from "../kingdom/cards.ts";

export type PoliticsHooks = { issue(body: KingdomOrderBody, said: string): void };

export type PoliticsSection = {
  readonly root: HTMLElement;
  refresh(): void;
  /** The control last pressed, to take focus back to when a menu closes. */
  focusTarget(): HTMLElement | null;
};

function button(doc: Document, text: string, key: string): HTMLElement {
  const b = make(doc, "button", "k-btn", text);
  b.setAttribute("type", "button");
  b.setAttribute("data-key", key);
  return b;
}

function shown(el: HTMLElement, on: boolean, display = "block"): void {
  const want = on ? display : "none";
  if (el.style.display !== want) el.style.display = want;
}

export function politicsSection(doc: Document, world: KingdomWorld, h: Holding, hooks: PoliticsHooks): PoliticsSection {
  const root = make(doc, "div", "c-politics");
  let last: HTMLElement | null = null;

  // -- loyalty and unrest -----------------------------------------------------
  const dl = make(doc, "dl", "k-rows");
  const standingRow = row(doc, dl, C.loyalty);
  standingRow.setAttribute("data-key", "unrest");
  const trend = row(doc, dl, P.today);
  root.appendChild(dl);
  const warn = make(doc, "p", "k-warn");
  const thresholds = make(doc, "p", "k-sub", P.thresholds);
  root.append(warn, thresholds);

  // -- what moves it ----------------------------------------------------------
  root.appendChild(make(doc, "h3", "k-section", P.causes));
  const causes = make(doc, "ul", "k-list c-causes");
  causes.setAttribute("aria-label", P.causes);
  root.appendChild(causes);
  const foraged = make(doc, "p", "k-sub");
  root.appendChild(foraged);

  // -- justice ------------------------------------------------------------------
  root.appendChild(make(doc, "h3", "k-section", P.justice));
  const justice = make(doc, "div", "k-toggles");
  justice.setAttribute("role", "group");
  justice.setAttribute("aria-label", P.justice);
  const jButtons: { id: JusticeId; el: HTMLElement }[] = [];
  for (const id of JUSTICE_IDS) {
    const b = button(doc, JUSTICE_NAME[id], "justice-" + id);
    b.setAttribute("title", JUSTICE_ABOUT[id]);
    b.onclick = (e) => {
      last = b;
      if (h.justice !== id) act({ kind: "setJustice", holding: h.id, justice: id }, MORALE_FEED.justice({ name: h.name, justice: JUSTICE_NAME[id] }));
      if ((e as MouseEvent).detail > 0) b.blur();
    };
    jButtons.push({ id, el: b });
    justice.appendChild(b);
  }
  root.appendChild(justice);
  const justiceAbout = make(doc, "p", "k-sub");
  root.appendChild(justiceAbout);

  // -- the levers ---------------------------------------------------------------
  root.appendChild(make(doc, "h3", "k-section", P.levers));
  const festival = button(doc, P.festival, "festival");
  const festivalAbout = make(doc, "p", "k-sub");
  const pardon = button(doc, P.pardon, "pardon");
  const pardonAbout = make(doc, "p", "k-sub", P.pardonAbout);
  const why = make(doc, "p", "k-warn");
  why.setAttribute("role", "status");
  shown(why, false);
  festival.onclick = (e) => {
    last = festival;
    act({ kind: "holdFestival", holding: h.id }, MORALE_FEED.festival({ name: h.name, days: FESTIVAL.days }));
    if ((e as MouseEvent).detail > 0) festival.blur();
  };
  pardon.onclick = (e) => {
    last = pardon;
    act({ kind: "pardon", holding: h.id }, MORALE_FEED.pardoned(h.name));
    if ((e as MouseEvent).detail > 0) pardon.blur();
  };
  root.append(festival, festivalAbout, pardon, pardonAbout, why);

  // -- shrines and halls -----------------------------------------------------------
  const shrineRows = make(doc, "dl", "k-rows");
  const shrines = row(doc, shrineRows, P.shrines);
  root.appendChild(shrineRows);

  /** Issue the order, or say why it would be refused (the same check the tick makes). */
  function act(body: KingdomOrderBody, said: string): void {
    const refusal = world.check(body);
    if (refusal) {
      setText(why, E.notNow(refusal));
      shown(why, true);
      return;
    }
    shown(why, false);
    hooks.issue(body, said);
  }

  const refresh = (): void => {
    const reckoned = unrestReckoned(h);
    const band = unrestBand(h.unrest);
    setText(standingRow, reckoned
      ? P.standing({ loyalty: LOYALTY_WORD[band], band: BAND_WORD[band], points: unrestPoints(h.unrest) })
      : P.notReckoned);
    const t = reckoned ? unrestTrend(world, h) : 0;
    setText(trend, t > 0 ? P.trendUp(unrestPoints(t)) : t < 0 ? P.trendDown(unrestPoints(-t)) : P.trendFlat);
    setText(warn, isRestless(h) ? P.halfTaxes : "");
    shown(warn, reckoned && isRestless(h));

    const list = reckoned ? unrestCauses(world, h) : [];
    const lines = list.length === 0 ? [P.causesNone]
      : list.map((c) => P.causeRow({ label: CAUSE_LABEL[c.cause], pts: unrestPoints(c.permille < 0 ? -c.permille : c.permille), raises: c.permille > 0 }));
    const have = Array.from(causes.children).map((li) => li.textContent).join("\n");
    if (have !== lines.join("\n")) {
      while (causes.firstChild) causes.removeChild(causes.firstChild);
      list.forEach((c, i) => causes.appendChild(make(doc, "li", c.permille > 0 ? "k-warn" : "k-good", lines[i])));
      if (list.length === 0) causes.appendChild(make(doc, "li", undefined, lines[0]));
    }
    setText(foraged, h.foraged > 0 ? P.foraged(h.foraged) : "");
    shown(foraged, h.foraged > 0);

    for (const j of jButtons) {
      const on = h.justice === j.id;
      j.el.setAttribute("aria-pressed", String(on));
      j.el.classList.toggle("on", on);
      const refusal = on ? null : world.check({ kind: "setJustice", holding: h.id, justice: j.id });
      if (refusal) j.el.setAttribute("aria-disabled", "true");
      else j.el.removeAttribute("aria-disabled");
    }
    setText(justiceAbout, P.justiceSetTo(JUSTICE_NAME[h.justice]) + ". " + JUSTICE_ABOUT[h.justice]);

    const c = festivalCost(h);
    setText(festivalAbout, h.festival > 0 ? P.festivalOn(h.festival) : P.festivalAbout({ ...c, days: FESTIVAL.days }));
    for (const [el, body] of [
      [festival, { kind: "holdFestival", holding: h.id }],
      [pardon, { kind: "pardon", holding: h.id }],
    ] as [HTMLElement, KingdomOrderBody][]) {
      const refusal = world.check(body);
      if (refusal) {
        el.setAttribute("aria-disabled", "true");
        el.setAttribute("aria-description", E.notNow(refusal));
      } else {
        el.removeAttribute("aria-disabled");
        el.removeAttribute("aria-description");
      }
    }

    let n = 0;
    for (const s of standing(h)) if ((s.def.later.unrest ?? 0) < 0 && h.works[s.slot] === 0) n++;
    setText(shrines, n > 0 ? P.shrinesLine(n) : P.shrinesNone);
  };

  refresh();
  return { root, refresh, focusTarget: () => last };
}
