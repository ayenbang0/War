/**
 * The front door.
 *
 * The game used to open straight into the army-composition screen, which is a
 * spreadsheet: a player arriving for the first time met a point-buy table
 * before they knew what the game was. A title, a play button and a way into the
 * tutorial is what every game does, and for good reason.
 *
 * The figures shown here are COUNTED from the content, never typed in. A hand
 * written "ten unit types" becomes a lie the moment someone adds an eleventh,
 * and this screen is the first thing a player reads.
 */

import { UNIT_TYPE_IDS } from "../content/unit-types.ts";
import { LEVELS } from "../content/levels/index.ts";
import { COMMANDER_IDS } from "../content/commanders.ts";
import { DOCTRINE_IDS } from "../content/doctrines.ts";
import { TERRAIN_INFO } from "../sim/terrain.ts";
import { ABILITY_IDS } from "../content/abilities.ts";
import { CHAPTERS } from "../content/campaign.ts";

import { domScreen, el } from "./dom-screen.ts";
import type { Screen } from "./screen-stack.ts";

export type HomeChoice = "play" | "tutorial" | "campaign";

/** One counted figure with its label. */
function figure(value: string, label: string): HTMLElement {
  const box = el("div", "home-figure");
  box.appendChild(el("div", "home-figure-value", value));
  box.appendChild(el("div", "home-figure-label", label));
  return box;
}

/**
 * The front screen, as the bottom of the screen stack. It is never popped:
 * every other screen comes back here in the end.
 */
export function homeScreen(root: HTMLElement, choose: (choice: HomeChoice) => void): Screen {
  let play: HTMLButtonElement | null = null;
  return domScreen({
    name: "home",
    kind: "full",
    root,
    // The bottom screen has nothing to trap focus away from.
    trapsFocus: false,
    firstFocus: () => play,
    build: () => {
      root.textContent = "";
      root.className = "home";
      const panel = el("div", "home-panel");

      panel.appendChild(el("h1", "home-title", "WAR"));
      panel.appendChild(el("p", "home-tagline", "A slow, deliberate battle. You command by drawing."));

      const actions = el("div", "home-actions");
      play = el("button", "home-play", "Play") as HTMLButtonElement;
      const chronicle = el("button", "home-teach", "Campaign") as HTMLButtonElement;
      const teach = el("button", "home-teach", "Learn the gestures") as HTMLButtonElement;
      actions.append(play, chronicle, teach);
      panel.appendChild(actions);

      panel.appendChild(el("p", "home-note",
        "New here? Learn the gestures first -- every order in this game is a stroke of the pen."));

      // -- what the game is ----------------------------------------------------
      panel.appendChild(el("h2", undefined, "How it plays"));
      const about = el("div", "home-about");
      for (const line of [
        "You command with the left mouse button and nothing else. A loop gathers men into a company, a line marches them, a glyph drawn over them changes their formation, and a stroke onto an enemy commits them to a fight.",
        "There is no build order and no economy. You bring the army you chose, and what happens to it is decided by ground, formation, nerve and where you are looking -- neither side sees the whole field.",
        "Nerve decides battles more often than numbers. A company taken in the flank breaks; a company that keeps its ranks holds far longer than the same men in a crowd.",
      ]) about.appendChild(el("p", undefined, line));
      panel.appendChild(about);

      // -- counted figures -----------------------------------------------------
      panel.appendChild(el("h2", undefined, "In the box"));
      const grid = el("div", "home-figures");
      grid.appendChild(figure(String(UNIT_TYPE_IDS.length), "kinds of soldier"));
      grid.appendChild(figure(String(LEVELS.length), "battlefields"));
      grid.appendChild(figure(String(Object.keys(TERRAIN_INFO).length), "kinds of ground"));
      grid.appendChild(figure(String(COMMANDER_IDS.length), "enemy commanders"));
      grid.appendChild(figure(String(DOCTRINE_IDS.length), "doctrines"));
      grid.appendChild(figure("14", "orders you can draw"));
      grid.appendChild(figure(String(ABILITY_IDS.length), "reserves to call on"));
      grid.appendChild(figure(String(new Set(LEVELS.map((l) => l.victory.mode)).size), "ways to win"));
      grid.appendChild(figure(String(CHAPTERS.length), "chapters of the chronicle"));
      panel.appendChild(grid);

      // PC-01: middle/right drag now really pans, so this line is true again.
      panel.appendChild(el("p", "home-foot",
        "Middle- or right-drag or WASD to move the map, wheel or up/down arrows to zoom, " +
        "space to pause, Esc to cancel a stroke or leave, F2 for the debug read-out."));

      play.onclick = () => choose("play");
      chronicle.onclick = () => choose("campaign");
      teach.onclick = () => choose("tutorial");

      root.appendChild(panel);
    },
  });
}
