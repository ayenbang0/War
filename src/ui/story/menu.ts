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
 *
 * K11: the sound's mute and volume live here too (src/audio/sound.ts),
 * changed in place so focus stays on the button pressed.
 */

import { domScreen } from "../dom-screen.ts";
import type { KeyVerdict, Screen } from "../screen-stack.ts";
import { STORY_UI } from "../../content/story/strings.ts";
import { VOLUME_STEP, sound } from "../../audio/sound.ts";

export type MenuHooks = {
  close(screen: Screen): void;
  chronicle(): void;
  tutorial(): void;
  front(): void;
  /** False in the practice realm itself: the tutorial is already running. */
  canReplay: boolean;
  /** K11: the realm's difficulty by name, said under the title. */
  difficulty?: string;
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
      if (hooks.difficulty) panel.appendChild(make(doc, "p", "k-sub s-menu-difficulty", STORY_UI.menuDifficulty(hooks.difficulty)));
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

      // -- sound --
      const snd = sound();
      const group = make(doc, "div", "s-menu-sound");
      group.setAttribute("role", "group");
      const head = make(doc, "h3", "s-menu-sound-title", STORY_UI.menuSoundTitle);
      head.id = "s-menu-sound-title";
      group.setAttribute("aria-labelledby", head.id);
      const toggle = make(doc, "button", "k-btn s-sound-toggle");
      toggle.setAttribute("type", "button");
      const quieter = make(doc, "button", "k-btn s-sound-quieter", STORY_UI.menuQuieter);
      quieter.setAttribute("type", "button");
      const louder = make(doc, "button", "k-btn s-sound-louder", STORY_UI.menuLouder);
      louder.setAttribute("type", "button");
      const level = make(doc, "span", "s-sound-volume");
      level.setAttribute("aria-live", "polite");
      const show = (): void => {
        toggle.textContent = snd.on ? STORY_UI.menuSoundOn : STORY_UI.menuSoundOff;
        toggle.setAttribute("aria-pressed", snd.on ? "true" : "false");
        level.textContent = STORY_UI.menuVolume(snd.volume);
        quieter.setAttribute("aria-disabled", snd.volume <= 0 ? "true" : "false");
        louder.setAttribute("aria-disabled", snd.volume >= 100 ? "true" : "false");
      };
      toggle.onclick = () => { snd.setOn(!snd.on); show(); };
      quieter.onclick = () => { snd.setVolume(snd.volume - VOLUME_STEP); show(); };
      louder.onclick = () => { snd.setVolume(snd.volume + VOLUME_STEP); show(); };
      show();
      const row = make(doc, "div", "s-menu-sound-row");
      row.append(toggle, quieter, level, louder);
      group.append(head, row, make(doc, "p", "k-hint", STORY_UI.menuSoundHint));
      panel.appendChild(group);
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
