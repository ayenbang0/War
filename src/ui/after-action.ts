/**
 * The after-action report.
 *
 * A battle here is fifteen minutes long and, until now, ended in a single word:
 * VICTORY or DEFEAT. That tells a player nothing they can use. The simulation
 * already knows how every man died, which company broke first and what was
 * doing the killing -- this is where that reaches the player.
 *
 * Deliberately AFTER the match and not during it. The standing rule for the
 * battlefield is as little on screen as possible; detail belongs here, where
 * nothing is competing with it.
 *
 * DOM rather than canvas, for the same reason the menu is: this is a table of
 * text, and reimplementing scrolling and layout on a canvas would land
 * somewhere worse.
 */

import type { World } from "../sim/world.ts";
import type { Group } from "../sim/entities.ts";

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const CAUSE_LABEL = ["hand to hand", "shot", "flanked"];

function minuteOf(tick: number): string {
  const secs = Math.floor(tick / 20);
  return Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0");
}

/** A row of "label  value", the report's basic unit. */
function stat(label: string, value: string): HTMLElement {
  const row = el("div", "aa-stat");
  row.appendChild(el("span", "aa-label", label));
  row.appendChild(el("span", "aa-value", value));
  return row;
}

/**
 * Render the report for a finished match.
 *
 * `onAgain` is wired to a button rather than reloading here, so the caller
 * decides what "again" means.
 */
export function showAfterAction(
  root: HTMLElement, world: World, viewer: number, onAgain: () => void,
): void {
  const outcome = world.outcome;
  if (!outcome) return;
  const foe = 1 - viewer;

  root.textContent = "";
  root.className = "after-action";
  const panel = el("div", "aa-panel");

  const won = outcome.winner === viewer;
  const drew = outcome.winner < 0;
  panel.appendChild(el("h1", "aa-verdict " + (won ? "aa-won" : drew ? "aa-drew" : "aa-lost"),
    drew ? "Stalemate" : won ? "The field is yours" : "The field is lost"));
  const foeAi = world.ai.find((a) => a.player === foe);
  panel.appendChild(el("p", "aa-detail",
    (foeAi ? "Against " + foeAi.who.name + ", " + foeAi.who.epithet + ".  " : "") + outcome.detail));

  // -- what killed your men, and theirs ---------------------------------------
  const mine = world.casualtiesByCause[viewer];
  const theirs = world.casualtiesByCause[foe];
  const myTotal = mine.reduce((a, b) => a + b, 0);
  const theirTotal = theirs.reduce((a, b) => a + b, 0);

  panel.appendChild(el("h2", undefined, "The butcher's bill"));
  const bill = el("div", "aa-cols");
  const yours = el("div", "aa-col");
  yours.appendChild(el("h3", undefined, "Your losses  " + myTotal));
  const foes = el("div", "aa-col");
  foes.appendChild(el("h3", undefined, "Theirs  " + theirTotal));
  for (let c = 0; c < CAUSE_LABEL.length; c++) {
    yours.appendChild(stat(CAUSE_LABEL[c], String(mine[c])));
    foes.appendChild(stat(CAUSE_LABEL[c], String(theirs[c])));
  }
  bill.append(yours, foes);
  panel.appendChild(bill);

  // The one line most likely to change how the next battle is fought.
  if (myTotal > 0) {
    const flankShare = mine[2] / myTotal;
    if (flankShare > 0.3) {
      panel.appendChild(el("p", "aa-lesson",
        Math.round(flankShare * 100) + "% of your losses came from outside your front. " +
        "You were being got around, not simply outfought."));
    } else if (mine[1] > mine[0] * 1.5) {
      panel.appendChild(el("p", "aa-lesson",
        "Most of your men were shot rather than beaten. You spent too long in the open."));
    }
  }

  // -- the companies ----------------------------------------------------------
  // world.raised, not world.groups: a company wiped out is spliced off the live
  // board, and those are exactly the ones worth naming.
  const companies = world.raised.filter((g: Group) => g.player === viewer);
  if (companies.length > 0) {
    panel.appendChild(el("h2", undefined, "Your companies"));
    const list = el("div", "aa-companies");
    for (const g of companies) {
      const row = el("div", "aa-company");
      row.appendChild(el("span", "aa-name", g.name));
      row.appendChild(el("span", "aa-record",
        world.liveCount(g) + " of " + g.raisedWith + " left   " + g.kills + " killed"));
      row.appendChild(el("span", "aa-fate",
        g.destroyedAt >= 0 ? "wiped out " + minuteOf(g.destroyedAt)
          : g.brokeAt >= 0 ? "broke " + minuteOf(g.brokeAt)
            : "held"));
      list.appendChild(row);
    }
    panel.appendChild(list);
  }

  // -- when it turned ---------------------------------------------------------
  const broke = world.breakages.filter((b) => b.player === viewer);
  if (broke.length > 0) {
    panel.appendChild(el("h2", undefined, "When your line gave"));
    const log = el("div", "aa-log");
    for (const b of broke.slice(0, 6)) {
      log.appendChild(el("div", "aa-log-line", minuteOf(b.tick) + "   " + b.name + " — " + b.cause));
    }
    panel.appendChild(log);
  }

  const again = el("button", "aa-again", "Fight again") as HTMLButtonElement;
  again.onclick = onAgain;
  panel.appendChild(again);

  root.appendChild(panel);
  root.style.display = "flex";
}
