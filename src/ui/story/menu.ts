/**
 * K9: the in-game menu, from the map's top bar (Menu): back to the realm,
 * the chronicle, the tutorial again, or the front screen.
 *
 * "Replay the tutorial" is the one way back into the lessons once the
 * opening has been played or skipped (the owner: the tutorial "can be
 * replayed from an in-game menu"). It saves the realm first and plays the
 * lessons in a practice realm, so nothing learned there touches this one.
 *
 * Modal and clock-holding; focus to the first button (there is nothing to
 * read first); Esc goes back to the realm.
 */

import { domScreen } from "../dom-screen.ts";
import type { KeyVerdict, Screen } from "../screen-stack.ts";
import { STORY_UI } from "../../content/story/strings.ts";

export type MenuHooks = {
  close(screen: Screen): void;
  chronicle(): void;
  tutorial(): void;
  front(): void;
  /** False in the practice realm itself: the tutorial is already running. */
  canReplay: boolean;
};

function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function menuScreen(root: HTMLElement, doc: Document, hooks: MenuHooks): Screen {
  let first: HTMLElement | null = null;
  const screen: Screen = domScreen({
    name: "story-menu",
    kind: "overlay",
    root,
    display: "flex",
    trapsFocus: true,
    pausesSim: true,
    inputs: ["ui"],
    firstFocus: () => first,
    build: () => {
      root.textContent = "";
      const panel = make(doc, "div", "k-menu s-menu");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      const title = make(doc, "h2", "k-menu-title", STORY_UI.menuTitle);
      title.id = "s-menu-title";
      panel.setAttribute("aria-labelledby", title.id);
      panel.appendChild(title);
      const list = make(doc, "div", "s-menu-list");
      const add = (label: string, run: () => void, hint?: string): HTMLElement => {
        const b = make(doc, "button", "k-btn s-menu-btn", label);
        b.setAttribute("type", "button");
        b.onclick = run;
        list.appendChild(b);
        if (hint) {
          const id = "s-menu-hint-" + list.children.length;
          const h = make(doc, "p", "k-hint", hint);
          h.id = id;
          b.setAttribute("aria-describedby", id);
          list.appendChild(h);
        }
        return b;
      };
      first = add(STORY_UI.menuResume, () => hooks.close(screen));
      add(STORY_UI.menuChronicle, () => hooks.chronicle());
      if (hooks.canReplay) add(STORY_UI.menuTutorial, () => hooks.tutorial(), STORY_UI.menuTutorialHint);
      add(STORY_UI.menuFront, () => hooks.front());
      panel.appendChild(list);
      panel.appendChild(make(doc, "p", "k-hint", STORY_UI.menuHint));
      root.appendChild(panel);
    },
    onKey: (k): KeyVerdict => {
      if (k.code !== "Escape") return "pass";
      hooks.close(screen);
      return "handled";
    },
  });
  return screen;
}
