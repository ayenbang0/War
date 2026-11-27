/**
 * The rumour card (K8, PLAN §B.8): "Riders seen on the Lisle road, 3 days
 * out" -- word that a host rides at one of the king's holdings, heard as far
 * ahead as his watchtowers and scouts allow (sim/kingdom/invasions.ts
 * warningDays), and the defence tools that answer it.
 *
 * Modal and clock-holding, like the event card (event-card.ts) and for the
 * same reason: it is a decision, and the realm should not march on while it
 * is read. Focus goes to the TITLE on open (tabindex -1), so a reader hears
 * who rides where before the choices and a stray Enter cannot pick one.
 * Every tool is one Tab away with what it does said under it; a tool that
 * cannot be used now stays in the ring, aria-disabled, with the reason, and
 * says it again when pressed. "Let it come" and Esc close the card; the
 * rumour stays in the feed.
 *
 * Each tool is an ordinary order (callLevy, burnFields, ambush, marchArmy),
 * checked with the sim's own check when drawn and again at the press. What
 * the card says of the host is only what the king knows: its strength only
 * if his men can see it (the AI's fog applies to him as well).
 *
 * Text comes from content/kingdom/invasion-strings.ts.
 */

import { domScreen } from "../dom-screen.ts";
import type { KeyVerdict, Screen } from "../screen-stack.ts";
import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { KingdomOrderBody } from "../../sim/kingdom/orders.ts";
import type { Army } from "../../sim/kingdom/state.ts";
import { armiesOf, armyById, armyMen, armyVisible, planArmyRoute } from "../../sim/kingdom/armies.ts";
import { knowsHolding } from "../../sim/kingdom/explore.ts";
import { levyMen, warningDays } from "../../sim/kingdom/invasions.ts";
import { FACTIONS, FACTION_IDS, KING_PLAYER } from "../../content/kingdom/factions.ts";
import { WARNING } from "../../content/kingdom/invasions.ts";
import { INVASION_FEED, INVASION_REFUSAL, RUMOUR } from "../../content/kingdom/invasion-strings.ts";

/** What the card is about: the rumour event's own fields. */
export type RumourNews = { army: number; owner: number; target: number; from: number; days: number };

export type RumourCardHooks = {
  /** Pop this card. */
  close(screen: Screen): void;
  /** The card left the stack, however that happened. */
  closed(): void;
  /** Issue a defence order, with the line to say. */
  issue(body: KingdomOrderBody, said: string): void;
};

function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** The king's army standing still in `holding`, if any (an ambush is laid where men stand). */
function armyIn(world: KingdomWorld, holding: number): Army | null {
  for (const a of armiesOf(world, KING_PLAYER)) {
    if (a.mover.road === 0 && a.mover.node === holding && a.mover.route.length === 0) return a;
  }
  return null;
}

/** The king's army nearest (by road) to `holding` that is not already there, if any. */
function nearestArmy(world: KingdomWorld, holding: number): Army | null {
  let best: Army | null = null;
  let bestTicks = Infinity;
  for (const a of armiesOf(world, KING_PLAYER)) {
    if (a.mover.road === 0 && a.mover.node === holding) continue;
    const plan = planArmyRoute(world, a, holding);
    if (plan && plan.etaTicks < bestTicks) { best = a; bestTicks = plan.etaTicks; }
  }
  return best;
}

export function rumourCard(root: HTMLElement, doc: Document, world: KingdomWorld, news: RumourNews, waiting: number, hooks: RumourCardHooks): Screen {
  let first: HTMLElement | null = null;
  let status: HTMLElement | null = null;
  const close = (): void => hooks.close(screen);
  const screen: Screen = domScreen({
    name: "kingdom-rumour",
    kind: "overlay",
    root,
    display: "flex",
    trapsFocus: true,
    pausesSim: true,
    inputs: ["ui"],
    firstFocus: () => first,
    build: () => {
      root.textContent = "";
      const target = world.holding(news.target);
      const place = target?.name ?? "?";
      const road = knowsHolding(world, KING_PLAYER, news.from) ? world.holding(news.from)?.name ?? place : place;
      const theirs = FACTIONS[FACTION_IDS[news.owner]]?.name ?? "?";
      const host = armyById(world, news.army);
      const seen = host ? armyVisible(world, KING_PLAYER, host) : false;

      const panel = make(doc, "div", "k-menu k-event k-rumour");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("data-army", String(news.army));
      panel.setAttribute("data-target", String(news.target));
      const title = make(doc, "h2", "k-menu-title", RUMOUR.title(road, news.days));
      title.id = "k-rumour-title";
      title.tabIndex = -1;
      panel.setAttribute("aria-labelledby", title.id);
      const body = make(doc, "p", "k-event-text", RUMOUR.body({
        theirs, target: place, men: RUMOUR.menGuess(seen && host ? armyMen(host) : 0),
      }));
      body.id = "k-rumour-text";
      panel.setAttribute("aria-describedby", body.id);
      const source = seen ? RUMOUR.sourceSeen : warningDays(world, news.target) > WARNING.baseDays ? RUMOUR.sourceTowers : RUMOUR.sourceTalk;
      panel.append(title, body, make(doc, "p", "k-sub", RUMOUR.heard({ source })));

      const list = make(doc, "ul", "k-choices");
      list.setAttribute("aria-labelledby", title.id);
      const add = (key: string, label: string, hint: string, order: KingdomOrderBody | null, why: string | null, said: () => string): void => {
        const refusal = why ?? (order ? world.check(order) : null);
        const li = make(doc, "li", "k-choice" + (refusal ? " unavailable" : ""));
        const b = make(doc, "button", "k-btn k-choice-btn", label);
        b.setAttribute("type", "button");
        b.setAttribute("data-key", "rumour-" + key);
        const detailId = "k-rumour-" + key;
        b.setAttribute("aria-describedby", detailId);
        if (refusal) b.setAttribute("aria-disabled", "true");
        const detail = make(doc, "div", "k-choice-detail");
        detail.id = detailId;
        detail.appendChild(make(doc, "span", undefined, hint));
        if (refusal) detail.appendChild(make(doc, "span", "k-why", RUMOUR.no(refusal)));
        b.onclick = () => {
          // Asked again at the press: the realm may have changed since.
          const now = why ?? (order ? world.check(order) : null);
          if (now) {
            if (status) status.textContent = RUMOUR.no(now);
            return;
          }
          close();
          if (order) hooks.issue(order, said());
        };
        li.append(b, detail);
        list.appendChild(li);
      };
      const mine = target?.owner === "king";
      const men = target ? levyMen(target) : 0;
      add("levy", RUMOUR.levy, RUMOUR.levyHint(men), mine ? { kind: "callLevy", holding: news.target } : null,
        mine ? null : INVASION_REFUSAL.notYours, () => INVASION_FEED.levied({ place, men }));
      add("burn", RUMOUR.burn, RUMOUR.burnHint, mine ? { kind: "burnFields", holding: news.target } : null,
        mine ? null : INVASION_REFUSAL.notYours, () => INVASION_FEED.burned(place));
      const there = armyIn(world, news.target);
      add("ambush", RUMOUR.ambush, RUMOUR.ambushHint(there?.name ?? "army"), there ? { kind: "ambush", army: there.id } : null,
        there ? null : RUMOUR.noArmyThere(place), () => INVASION_FEED.ambush(there?.name ?? "army"));
      const near = nearestArmy(world, news.target);
      add("defend", RUMOUR.defend, RUMOUR.defendHint(near?.name ?? "army"), near ? { kind: "marchArmy", army: near.id, to: news.target } : null,
        near ? null : RUMOUR.noArmyToSend, () => RUMOUR.defendHint(near?.name ?? "army"));
      panel.appendChild(list);

      status = make(doc, "p", "k-menu-status");
      status.setAttribute("role", "status");
      panel.appendChild(status);
      panel.appendChild(make(doc, "p", "k-hint", RUMOUR.heldClock + (waiting > 0 ? " " + RUMOUR.more(waiting) : "")));
      const actions = make(doc, "div", "k-card-actions");
      const dismiss = make(doc, "button", "k-btn", RUMOUR.dismiss);
      dismiss.setAttribute("type", "button");
      dismiss.setAttribute("data-key", "rumour-dismiss");
      dismiss.setAttribute("aria-describedby", "k-rumour-dismiss");
      dismiss.onclick = () => close();
      const hint = make(doc, "span", "k-hint", RUMOUR.dismissHint + " " + RUMOUR.dismissKey);
      hint.id = "k-rumour-dismiss";
      actions.append(dismiss, hint);
      panel.appendChild(actions);
      root.appendChild(panel);
      first = title;
    },
    teardown: () => hooks.closed(),
    onKey: (k): KeyVerdict => {
      if (k.code !== "Escape") return "pass";
      close();
      return "handled";
    },
  });
  return screen;
}
