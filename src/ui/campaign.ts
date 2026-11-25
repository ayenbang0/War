/**
 * The chronicle screen: where the campaign stands, the letter that opens the
 * next battle, and the choice of road when there is one.
 *
 * Progress lives in localStorage under one key. Nothing here touches the
 * simulation; it only decides which battlefield and which enemy captain the
 * ordinary setup screen opens on.
 */

import {
  CHAPTERS, chapterById, chooseRoad, epilogue, freshProgress, readProgress, recordBattle,
  type Chapter, type Progress,
} from "../content/campaign.ts";
import { COMMANDERS } from "../content/commanders.ts";
import { levelById } from "../content/levels/index.ts";

const KEY = "war.chronicle.v1";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadProgress(): Progress {
  return readProgress(storage()?.getItem(KEY) ?? null);
}

function saveProgress(p: Progress): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(p));
  } catch {
    // A private window with storage refused: the chronicle simply is not kept.
  }
}

/** Called by the battle when it ends. Returns the chronicler's entry. */
export function noteBattle(chapterId: string, won: boolean): string {
  const c = chapterById(chapterId);
  if (!c) return "";
  saveProgress(recordBattle(loadProgress(), chapterId, won));
  return won ? c.won : c.lost;
}

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** Show the chronicle and resolve with the chapter the player marches to. */
export function openCampaign(root: HTMLElement): Promise<Chapter> {
  return new Promise((resolve) => {
    const draw = (): void => {
      const p = loadProgress();
      root.textContent = "";
      root.className = "home";
      const panel = el("div", "home-panel chronicle");
      panel.appendChild(el("h1", "chronicle-title", "The Marchwarden's Chronicle"));
      panel.appendChild(el("p", "home-tagline",
        "The Margrave of the Red March has crossed the border with eight captains. Nine battles. Defeat does not end it."));

      // -- what has been written so far ---------------------------------------
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
              saveProgress(chooseRoad(loadProgress(), o.next));
              draw();
            };
            actions.appendChild(b);
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
          march.onclick = () => {
            root.style.display = "none";
            resolve(c);
          };
          actions.appendChild(march);
        }
      }
      const back = el("button", "home-teach", p.at === "end" ? "Begin again" : "Back") as HTMLButtonElement;
      back.onclick = () => {
        if (p.at === "end") saveProgress(freshProgress());
        window.location.reload();
      };
      actions.appendChild(back);
      panel.appendChild(actions);
      if (p.at !== "end" && p.record.length > 0) {
        const restart = el("button", "chronicle-restart", "Start the chronicle over") as HTMLButtonElement;
        restart.onclick = () => {
          saveProgress(freshProgress());
          draw();
        };
        panel.appendChild(restart);
      }
      panel.appendChild(el("p", "home-foot",
        CHAPTERS.length + " chapters are written; one choice of road means you will fight " +
        (CHAPTERS.length - 1) + " of them in a single chronicle."));
      root.appendChild(panel);
      root.style.display = "flex";
    };
    draw();
  });
}
