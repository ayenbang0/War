/**
 * The chronicle screen: where the campaign stands, the letter that opens the
 * next battle, and the choice of road when there is one.
 *
 * Progress lives in a ProgressStore (app/progress-store.ts): localStorage when
 * the browser allows it, memory always. Nothing here touches the simulation; it
 * only decides which battlefield and which enemy captain the ordinary setup
 * screen opens on.
 *
 * On the screen stack this sits above Home. "Back" pops to Home; "March" pushes
 * the setup screen over it, and after the battle the stack pops back down to
 * here, which redraws with the new entry -- no reload, so the memory copy of
 * the chronicle survives even when storage is refused (BS-01).
 */

import {
  CHAPTERS, chapterById, chooseRoad, epilogue, freshProgress, recordBattle, type Chapter,
} from "../content/campaign.ts";
import { COMMANDERS } from "../content/commanders.ts";
import { levelById } from "../content/levels/index.ts";
import { MEMORY_ONLY_NOTICE, type ProgressStore } from "../app/progress-store.ts";
import { domScreen, el } from "./dom-screen.ts";
import type { Screen } from "./screen-stack.ts";

/** Called by the battle when it ends. Returns the chronicler's entry. */
export function noteBattle(store: ProgressStore, chapterId: string, won: boolean): string {
  const c = chapterById(chapterId);
  if (!c) return "";
  store.save(recordBattle(store.load(), chapterId, won));
  return won ? c.won : c.lost;
}

export type ChronicleActions = {
  /** The player marches to this chapter's battle. */
  march(chapter: Chapter): void;
  /** Back to the front screen. */
  back(): void;
  /**
   * Ask before something that cannot be undone. `onYes` runs only if the
   * player confirms; focus starts on the safe choice.
   */
  confirm(spec: { title: string; body: string; yes: string; no: string; onYes: () => void }): void;
};

export function chronicleScreen(root: HTMLElement, store: ProgressStore, act: ChronicleActions): Screen {
  let focusFirst: HTMLElement | null = null;
  /** What was last drawn, so a reveal redraws only when the record moved. */
  let drawn = "";

  const draw = (): void => {
    const p = store.load();
    drawn = JSON.stringify(p) + store.status.kind;
    root.textContent = "";
    root.className = "home";
    const panel = el("div", "home-panel chronicle");
    panel.appendChild(el("h1", "chronicle-title", "The Marchwarden's Chronicle"));
    panel.appendChild(el("p", "home-tagline",
      "The Margrave of the Red March has crossed the border with eight captains. Nine battles. Defeat does not end it."));
    if (store.status.kind === "memory-only") {
      // BS-01: said where the player would otherwise assume it was kept.
      const n = el("p", "storage-notice", MEMORY_ONLY_NOTICE);
      n.setAttribute("role", "status");
      panel.appendChild(n);
    }

    // -- what has been written so far -----------------------------------------
    if (p.record.length > 0) {
      panel.appendChild(el("h2", undefined, "Written so far"));
      const list = el("div", "chronicle-record");
      for (const r of p.record) {
        const c = chapterById(r.chapter);
        if (!c) continue;
        const row = el("div", "chronicle-row " + (r.won ? "won" : "lost"));
        row.appendChild(el("span", "chronicle-num", String(c.number)));
        row.appendChild(el("span", "chronicle-name", c.title));
        row.appendChild(el("span", "chronicle-fate", r.won ? "won" : "lost"));
        list.appendChild(row);
      }
      panel.appendChild(list);
    }

    focusFirst = null;
    const actions = el("div", "home-actions");
    if (p.at === "end") {
      panel.appendChild(el("h2", undefined, "The last entry"));
      panel.appendChild(el("p", "chronicle-letter", epilogue(p)));
    } else {
      const c = chapterById(p.at);
      if (!c) return;
      if (p.forked && typeof c.next === "object" && c.next !== null) {
        panel.appendChild(el("h2", undefined, "Two roads"));
        panel.appendChild(el("p", "chronicle-letter", c.next.prompt));
        for (const o of c.next.options) {
          const b = el("button", "home-teach chronicle-road") as HTMLButtonElement;
          b.appendChild(el("strong", undefined, o.label));
          b.appendChild(el("span", "chronicle-road-blurb", o.blurb));
          b.onclick = () => {
            store.save(chooseRoad(store.load(), o.next));
            draw();
            // The buttons just pressed are gone; land on the March that replaced them.
            focusFirst?.focus();
          };
          actions.appendChild(b);
          focusFirst ??= b;
        }
      } else {
        const level = levelById(c.levelId);
        const foe = COMMANDERS[c.commander];
        panel.appendChild(el("h2", undefined, "Chapter " + c.number + ": " + c.title));
        panel.appendChild(el("p", "chronicle-from", "From " + c.letter.from));
        panel.appendChild(el("p", "chronicle-letter", c.letter.body));
        panel.appendChild(el("p", "chronicle-meta",
          (level ? level.name + "   -   " : "") + "against the " + foe.name + ", " + foe.epithet));
        const march = el("button", "home-play", "March") as HTMLButtonElement;
        march.onclick = () => act.march(c);
        actions.appendChild(march);
        focusFirst = march;
      }
    }
    const back = el("button", "home-teach", p.at === "end" ? "Begin again" : "Back") as HTMLButtonElement;
    back.onclick = () => {
      if (p.at !== "end") {
        act.back();
        return;
      }
      act.confirm({
        title: "Begin the chronicle again?",
        body: "The finished chronicle is put away and a fresh one starts at chapter 1.",
        yes: "Begin again", no: "Keep it",
        onYes: () => {
          store.save(freshProgress());
          act.back();
        },
      });
    };
    actions.appendChild(back);
    focusFirst ??= back;
    panel.appendChild(actions);
    if (p.at !== "end" && p.record.length > 0) {
      // BS-03: one click used to wipe the chronicle with no way back.
      const restart = el("button", "chronicle-restart", "Start the chronicle over") as HTMLButtonElement;
      restart.onclick = () => act.confirm({
        title: "Start the chronicle over?",
        body: "Everything written so far (" + p.record.length +
          (p.record.length === 1 ? " battle" : " battles") + ") is lost, and the war begins again at chapter 1.",
        yes: "Start over", no: "Keep it",
        onYes: () => {
          store.save(freshProgress());
          draw();
        },
      });
      panel.appendChild(restart);
    }
    panel.appendChild(el("p", "home-foot",
      CHAPTERS.length + " chapters are written; one choice of road means you will fight " +
      (CHAPTERS.length - 1) + " of them in a single chronicle."));
    root.appendChild(panel);
  };

  return domScreen({
    name: "chronicle",
    kind: "full",
    root,
    firstFocus: () => focusFirst,
    build: draw,
    // Back from a battle, or from a confirm: the record may have changed. Left
    // alone when it has not, so focus goes back to the very button it left.
    revealed: () => {
      if (JSON.stringify(store.load()) + store.status.kind !== drawn) draw();
    },
    onKey: (k) => {
      // BS-02's rule for every screen: Esc is Back.
      if (k.code !== "Escape") return "pass";
      act.back();
      return "handled";
    },
  });
}
