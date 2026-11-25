/**
 * The event card (K3a): Brother Aldous's letter from an exploration site, and
 * its two or three choices, as a MODAL screen on the stack.
 *
 * Modal and clock-holding, unlike the region card (cards.ts): a letter is a
 * decision, and the realm should not march on while it is being read, so the
 * screen has pausesSim (the kingdom clock is held while it is anywhere on the
 * stack -- kingdom-layer's simHeld) and traps focus. It follows the ui policy
 * (docs/ui-policy.md) as the economy's choice menus do: rem text, the same
 * panel and choice-list classes, state said in words as well as by style.
 *
 * Focus goes to the letter's TITLE on open (tabindex -1), so a reader hears
 * the title and the letter before the choices, and a stray Enter or Space
 * cannot pick one. Every choice is a button one Tab away; "Decide later" and
 * Esc close the card and leave the letter waiting under Finds.
 *
 * A choice is an order (`resolveEvent`), checked with the sim's own check
 * (world.check) when drawn and again at the press: a choice the stores cannot
 * pay is offered dashed, with why, and refuses in words.
 */

import { domScreen } from "../dom-screen.ts";
import type { KeyVerdict, Screen } from "../screen-stack.ts";
import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { KingdomOrderBody } from "../../sim/kingdom/orders.ts";
import { choiceCost, eventOf, findAt } from "../../sim/kingdom/explore.ts";
import { KING_PLAYER } from "../../content/kingdom/factions.ts";
import { amountsLine } from "../../content/kingdom/ui-strings.ts";
import { SITE_NAME, X } from "../../content/story/strings.ts";

export type EventCardHooks = {
  /** Pop this card. */
  close(screen: Screen): void;
  /** The card left the stack, however that happened. */
  closed(): void;
  /** Issue the choice. */
  issue(body: KingdomOrderBody, said: string): void;
};

function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function button(doc: Document, text: string, key: string, cls = "k-btn"): HTMLElement {
  const b = make(doc, "button", cls, text);
  b.setAttribute("type", "button");
  b.setAttribute("data-key", key);
  return b;
}

/** The letter waiting from `site` (a holding id), as a screen to push. */
export function eventCard(root: HTMLElement, doc: Document, world: KingdomWorld, site: number, hooks: EventCardHooks): Screen {
  let first: HTMLElement | null = null;
  let status: HTMLElement | null = null;
  const close = (): void => hooks.close(screen);
  const screen: Screen = domScreen({
    name: "kingdom-event",
    kind: "overlay",
    root,
    display: "flex",
    trapsFocus: true,
    pausesSim: true,
    inputs: ["ui"],
    firstFocus: () => first,
    build: () => {
      root.textContent = "";
      const find = findAt(world, KING_PLAYER, site);
      const def = find ? eventOf(find) : undefined;
      const h = world.holding(site);
      const kind = world.map.holdings.find((d) => d.key === h?.key)?.site;
      const panel = make(doc, "div", "k-menu k-event");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("data-site", String(site));
      panel.appendChild(make(doc, "p", "k-event-from", X.cardFrom));
      const title = make(doc, "h2", "k-menu-title", def ? def.title : h?.name ?? "");
      title.id = "k-event-title";
      title.tabIndex = -1;
      panel.setAttribute("aria-labelledby", title.id);
      const where = make(doc, "p", "k-sub", X.cardAt({ name: h?.name ?? "", site: kind ? SITE_NAME[kind] : "" }));
      const letter = make(doc, "p", "k-event-text", def ? def.text : X.noLetters);
      letter.id = "k-event-text";
      panel.setAttribute("aria-describedby", letter.id);
      panel.append(title, where, letter);

      if (def && find && find.choice < 0) {
        const group = make(doc, "p", "k-event-ask", X.choicesGroup);
        group.id = "k-event-ask";
        const list = make(doc, "ul", "k-choices");
        list.setAttribute("aria-labelledby", group.id);
        def.choices.forEach((c, i) => {
          const why = world.check({ kind: "resolveEvent", site, choice: i });
          const li = make(doc, "li", "k-choice" + (why ? " unavailable" : ""));
          const b = button(doc, c.label, "choice-" + i, "k-btn k-choice-btn");
          const detailId = "k-event-choice-" + i;
          b.setAttribute("aria-describedby", detailId);
          if (why) b.setAttribute("aria-disabled", "true");
          const detail = make(doc, "div", "k-choice-detail");
          detail.id = detailId;
          const cost = choiceCost(c.effects);
          if (Object.keys(cost).length > 0) detail.appendChild(make(doc, "span", undefined, X.costs(amountsLine(cost))));
          if (c.chance) detail.appendChild(make(doc, "span", undefined, X.gamble(c.chance.pct)));
          if (why) detail.appendChild(make(doc, "span", "k-why", X.cannotPay(amountsLine(cost))));
          b.onclick = () => {
            // Asked again at the press: the stores may have changed since.
            const now = world.check({ kind: "resolveEvent", site, choice: i });
            if (now) {
              if (status) status.textContent = X.cannotPay(amountsLine(cost));
              return;
            }
            close();
            hooks.issue({ kind: "resolveEvent", site, choice: i }, X.chose(c.label));
          };
          li.append(b, detail);
          list.appendChild(li);
        });
        panel.append(group, list);
      }

      status = make(doc, "p", "k-menu-status");
      status.setAttribute("role", "status");
      panel.appendChild(status);
      panel.appendChild(make(doc, "p", "k-hint", X.heldClock));
      const actions = make(doc, "div", "k-card-actions");
      const later = button(doc, X.later, "later");
      later.setAttribute("aria-describedby", "k-event-later");
      later.onclick = () => close();
      const hint = make(doc, "span", "k-hint", X.laterHint + " " + X.laterKey);
      hint.id = "k-event-later";
      actions.append(later, hint);
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
