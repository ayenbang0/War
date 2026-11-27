/**
 * K9: the chronicle screen -- Brother Aldous's ledger of the exile, over the
 * kingdom's own ledger (sim/kingdom/story.ts writes it from the realm's
 * events: acts begun and ended, letters and their answers, encounters,
 * holdings won and lost, famines, the seasons).
 *
 * Reached from the map's top bar (Chronicle) and the in-game menu, and from
 * the end screen. It is a book, so it reads in order, oldest first, under the
 * act each entry was written in; the act now being played heads it with its
 * goals and whether each holds today -- the story moves on territory, not on
 * a counter, and this is where the player sees what it is waiting for.
 *
 * Modal and clock-holding (the realm does not march on while you read);
 * focus to the title on open; Esc and Close go back. Every line is
 * chronicleLine's, so the screen, the feed and the tests read one text.
 */

import { domScreen } from "../dom-screen.ts";
import type { KeyVerdict, Screen } from "../screen-stack.ts";
import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import { actProgress, chronicleLine } from "../../sim/kingdom/story.ts";
import { calendar, TICKS_PER_DAY } from "../../sim/kingdom/clock.ts";
import { ACTS } from "../../content/story/acts.ts";
import { STORY_UI } from "../../content/story/strings.ts";
import { dateLine } from "../../content/kingdom/ui-strings.ts";

export type ChronicleHooks = {
  close(screen: Screen): void;
};

function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function chronicleScreen(root: HTMLElement, doc: Document, world: KingdomWorld, hooks: ChronicleHooks): Screen {
  let first: HTMLElement | null = null;
  const close = (): void => hooks.close(screen);
  const screen: Screen = domScreen({
    name: "story-chronicle",
    kind: "overlay",
    root,
    display: "flex",
    trapsFocus: true,
    pausesSim: true,
    inputs: ["ui"],
    firstFocus: () => first,
    build: () => {
      root.textContent = "";
      const s = world.story;
      const panel = make(doc, "div", "k-menu s-chronicle");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      const title = make(doc, "h2", "k-menu-title", STORY_UI.chronicleTitle);
      title.id = "s-chronicle-title";
      title.tabIndex = -1;
      panel.setAttribute("aria-labelledby", title.id);
      panel.append(title, make(doc, "p", "k-sub", STORY_UI.chronicleBy));

      if (s) {
        // What the act now being played waits for.
        const act = ACTS[s.act - 1];
        const goals = make(doc, "section", "s-goals");
        goals.setAttribute("aria-label", STORY_UI.chronicleGoals);
        goals.appendChild(make(doc, "h3", "s-act-title", STORY_UI.chronicleAct(act.id, act.title)));
        goals.appendChild(make(doc, "p", "k-sub", STORY_UI.chronicleGoals));
        const ul = make(doc, "ul", "s-goal-list");
        for (const g of actProgress(world)) {
          const li = make(doc, "li", "s-goal" + (g.done ? " done" : ""));
          // Said in words, not by a tick mark alone (game-ui-ux: never colour or a glyph only).
          li.append(make(doc, "span", "s-goal-text", g.text), make(doc, "span", "s-goal-state", " -- " + (g.done ? STORY_UI.goalDone : STORY_UI.goalOpen)));
          ul.appendChild(li);
        }
        goals.appendChild(ul);
        panel.appendChild(goals);
      }

      const book = make(doc, "div", "s-book");
      book.tabIndex = 0;
      book.setAttribute("role", "region");
      book.setAttribute("aria-label", STORY_UI.chronicleTitle);
      const entries = s ? s.chronicle : [];
      if (entries.length === 0) book.appendChild(make(doc, "p", "k-sub", STORY_UI.chronicleEmpty));
      let list: HTMLElement | null = null;
      for (const e of entries) {
        // Each act's intro starts a new chapter of the book.
        const [kind, id, part] = e.key.split(":");
        if (!list || (kind === "act" && part === "intro")) {
          if (kind === "act" && part === "intro") {
            const a = ACTS[Number(id) - 1];
            book.appendChild(make(doc, "h3", "s-act-title", STORY_UI.chronicleAct(a.id, a.title)));
          }
          list = make(doc, "ol", "s-entries");
          book.appendChild(list);
        }
        const line = chronicleLine(e, world.king.name);
        const li = make(doc, "li", "s-entry");
        li.setAttribute("data-key", e.key);
        li.appendChild(make(doc, "span", "s-entry-date", STORY_UI.chronicleDay(dateLine(calendar(e.day * TICKS_PER_DAY, world.epoch)))));
        if (line.title) li.appendChild(make(doc, "strong", "s-entry-title", line.title));
        if (line.text) li.appendChild(make(doc, "span", "s-entry-text", line.text));
        list.appendChild(li);
      }
      panel.appendChild(book);
      panel.appendChild(make(doc, "p", "k-hint", STORY_UI.chronicleCount(entries.length) + " " + STORY_UI.chronicleCloseHint));
      const actions = make(doc, "div", "k-card-actions");
      const done = make(doc, "button", "k-btn", STORY_UI.chronicleClose);
      done.setAttribute("type", "button");
      done.onclick = () => close();
      actions.appendChild(done);
      panel.appendChild(actions);
      root.appendChild(panel);
      first = title;
      // Open at the latest page: the book is long, and the reader came for the news.
      book.scrollTop = book.scrollHeight;
    },
    onKey: (k): KeyVerdict => {
      if (k.code !== "Escape") return "pass";
      close();
      return "handled";
    },
  });
  return screen;
}
