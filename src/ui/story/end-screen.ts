/**
 * K9: the end screen -- the story over, in one of its four endings
 * (content/story/endings.ts): the Restored King, the Iron Crown, the Hollow
 * Crown, read off Legitimacy x Mercy at the coronation, or the Chronicle
 * Closes, when the king is lost.
 *
 * A full screen over the (stopped) realm: the ending's title, its epilogue
 * -- each beat gated on what was actually done in this run, through the same
 * `holds` the acts and letters use -- and the run in four numbers. Then the
 * chronicle (which ends on this page), the front screen, or a new exile.
 *
 * Focus goes to the title, so a screen reader starts at "The Iron Crown"
 * and not at a button; the body is plain prose at the story's reading size.
 * There is no Esc-to-dismiss: nothing lies behind it to go back to but a
 * realm that has stopped, so Esc means the front screen, as everywhere.
 */

import { domScreen } from "../dom-screen.ts";
import type { KeyVerdict, Screen } from "../screen-stack.ts";
import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import { holds } from "../../sim/kingdom/story.ts";
import { ENDINGS } from "../../content/story/endings.ts";
import { STORY_UI } from "../../content/story/strings.ts";
import { KING_PLAYER } from "../../content/kingdom/factions.ts";

export type EndHooks = {
  chronicle(): void;
  home(): void;
  newExile(): void;
};

function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** The epilogue as it reads for this realm: the beats whose condition holds. Pure. */
export function epilogueOf(world: KingdomWorld, ending: string): string[] {
  const end = ENDINGS.find((e) => e.id === ending);
  if (!end) return [];
  return end.epilogue.filter((b) => !b.when || holds(world, b.when)).map((b) => b.text.split("{king}").join(world.king.name));
}

export function endScreen(root: HTMLElement, doc: Document, world: KingdomWorld, ending: string, hooks: EndHooks): Screen {
  let first: HTMLElement | null = null;
  return domScreen({
    name: "story-end",
    kind: "full",
    root,
    display: "flex",
    trapsFocus: true,
    pausesSim: true,
    inputs: ["ui"],
    firstFocus: () => first,
    build: () => {
      root.textContent = "";
      root.className = "s-end";
      const end = ENDINGS.find((e) => e.id === ending);
      const panel = make(doc, "div", "s-end-panel");
      panel.setAttribute("role", "region");
      panel.setAttribute("data-ending", ending);
      panel.appendChild(make(doc, "p", "s-end-kicker", end?.gate.kind === "failure" ? STORY_UI.endFallen : STORY_UI.endHeading));
      const title = make(doc, "h1", "s-end-title", end ? end.title : ending);
      title.id = "s-end-title";
      title.tabIndex = -1;
      panel.setAttribute("aria-labelledby", title.id);
      panel.appendChild(title);
      for (const line of epilogueOf(world, ending)) panel.appendChild(make(doc, "p", "s-end-text", line));
      const e = world.economy[KING_PLAYER];
      const days = (world.story?.endedDay ?? world.date.day) + 1;
      panel.appendChild(make(doc, "p", "k-sub s-end-stats",
        STORY_UI.endStats(days, world.holdingsOf("king").length, e.legitimacy, e.mercy)));
      const actions = make(doc, "div", "s-end-actions");
      const read = make(doc, "button", "home-play", STORY_UI.endRead);
      read.onclick = () => hooks.chronicle();
      const home = make(doc, "button", "home-teach", STORY_UI.endHome);
      home.onclick = () => hooks.home();
      const again = make(doc, "button", "home-teach", STORY_UI.endNew);
      again.onclick = () => hooks.newExile();
      for (const b of [read, home, again]) b.setAttribute("type", "button");
      actions.append(read, home, again);
      panel.appendChild(actions);
      root.appendChild(panel);
      first = title;
    },
    onKey: (k): KeyVerdict => {
      if (k.code !== "Escape") return "pass";
      hooks.home();
      return "handled";
    },
  });
}
