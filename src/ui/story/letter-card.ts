/**
 * K9: the letter card -- one of the story's letters (content/story/letters.ts)
 * put to the king, with its answers.
 *
 * Built on the rumour and event cards' rules (ui/kingdom/rumour-card.ts):
 * modal and clock-holding, because an answer is a decision and the realm
 * should not march on while it is read; focus to the TITLE on open, so a
 * reader hears who wrote before the choices and a stray Enter cannot pick
 * one; every answer one Tab away with what it costs said under it; an answer
 * that cannot be given now stays in the ring, aria-disabled, with the sim's
 * own reason (story.ts checkAnswer), and says it again when pressed.
 *
 * An answer is an ORDER (answerLetter), never a direct change: it is checked
 * when drawn and again at the press, hashed and saved like any other, so a
 * story is replayed from its log. What it did is said in the feed when the
 * tick has applied it (the letterAnswered event), not guessed at here -- a
 * gamble's outcome is the sim's to roll.
 *
 * "Decide later" and Esc lay the letter aside: it stays pending, and the
 * top bar's Letters button brings it back.
 */

import { domScreen } from "../dom-screen.ts";
import type { KeyVerdict, Screen } from "../screen-stack.ts";
import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { KingdomOrderBody } from "../../sim/kingdom/orders.ts";
import { offeredChoices, storyChoiceCost } from "../../sim/kingdom/story.ts";
import { STORY_LETTERS } from "../../content/story/letters.ts";
import { ENCOUNTERS } from "../../content/story/encounters.ts";
import { STORY_UI } from "../../content/story/strings.ts";
import { amountsLine } from "../../content/kingdom/ui-strings.ts";
import { signal } from "./signals.ts";

export type LetterCardHooks = {
  /** Pop this card. */
  close(screen: Screen): void;
  /** The card left the stack, however that happened. */
  closed(): void;
  /** Issue the answer, with the line to say. */
  issue(body: KingdomOrderBody, said: string): void;
};

function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** The letter's text with the king's name in it. */
export function letterText(text: string, king: string): string {
  return text.split("{king}").join(king);
}

export function letterCard(
  root: HTMLElement, doc: Document, world: KingdomWorld, letter: number, waiting: number, hooks: LetterCardHooks,
): Screen {
  let first: HTMLElement | null = null;
  let status: HTMLElement | null = null;
  const close = (): void => hooks.close(screen);
  const screen: Screen = domScreen({
    name: "story-letter",
    kind: "overlay",
    root,
    display: "flex",
    trapsFocus: true,
    pausesSim: true,
    inputs: ["ui"],
    firstFocus: () => first,
    build: () => {
      root.textContent = "";
      const l = STORY_LETTERS[letter];
      const king = world.king.name;
      const panel = make(doc, "div", "k-menu k-event s-letter");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("data-letter", l.id);
      const title = make(doc, "h2", "k-menu-title", l.title);
      title.id = "s-letter-title";
      title.tabIndex = -1;
      panel.setAttribute("aria-labelledby", title.id);
      const from = make(doc, "p", "k-sub s-letter-from", STORY_UI.letterFrom(l.from));
      const body = make(doc, "p", "k-event-text s-letter-text", letterText(l.text, king));
      body.id = "s-letter-text";
      panel.setAttribute("aria-describedby", body.id);
      panel.append(title, from, body);

      const list = make(doc, "ul", "k-choices");
      list.setAttribute("aria-labelledby", title.id);
      for (const c of offeredChoices(world, letter)) {
        const choice = l.choices[c];
        const order: KingdomOrderBody = { kind: "answerLetter", letter, choice: c };
        const refusal = world.check(order);
        const li = make(doc, "li", "k-choice" + (refusal ? " unavailable" : ""));
        const b = make(doc, "button", "k-btn k-choice-btn", choice.label);
        b.setAttribute("type", "button");
        b.setAttribute("data-key", "letter-" + c);
        const detailId = "s-letter-" + c;
        b.setAttribute("aria-describedby", detailId);
        if (refusal) b.setAttribute("aria-disabled", "true");
        const detail = make(doc, "div", "k-choice-detail");
        detail.id = detailId;
        // What the answer costs and what it starts, said before it is chosen:
        // the result itself is the chronicle's to write once it has happened.
        const cost = storyChoiceCost(choice.effects);
        if (Object.keys(cost).length > 0) detail.appendChild(make(doc, "span", undefined, STORY_UI.letterCosts(amountsLine(cost))));
        for (const fx of choice.effects) {
          if (fx.kind !== "battle") continue;
          const e = ENCOUNTERS.find((x) => x.id === fx.encounter);
          const h = e ? world.holdingByKey(e.holding) : undefined;
          detail.appendChild(make(doc, "span", undefined, STORY_UI.letterBattle(h ? h.name : "?")));
        }
        if (choice.chance) detail.appendChild(make(doc, "span", undefined, STORY_UI.letterChance(choice.chance.pct)));
        if (refusal) detail.appendChild(make(doc, "span", "k-why", STORY_UI.letterNo(refusal)));
        b.onclick = () => {
          // Asked again at the press: the realm may have changed since.
          const now = world.check(order);
          if (now) {
            if (status) status.textContent = STORY_UI.letterNo(now);
            return;
          }
          close();
          hooks.issue(order, choice.label);
          signal({ kind: "ui", action: "eventChoose" });
        };
        li.append(b, detail);
        list.appendChild(li);
      }
      panel.appendChild(list);

      status = make(doc, "p", "k-menu-status");
      status.setAttribute("role", "status");
      panel.appendChild(status);
      panel.appendChild(make(doc, "p", "k-hint", STORY_UI.letterHeld + (waiting > 0 ? " " + STORY_UI.letterMore(waiting) : "")));
      const actions = make(doc, "div", "k-card-actions");
      const later = make(doc, "button", "k-btn", STORY_UI.letterLater);
      later.setAttribute("type", "button");
      later.setAttribute("data-key", "letter-later");
      later.setAttribute("aria-describedby", "s-letter-later");
      later.onclick = () => close();
      const hint = make(doc, "span", "k-hint", STORY_UI.letterLaterHint);
      hint.id = "s-letter-later";
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
