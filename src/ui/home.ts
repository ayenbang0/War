/**
 * The front door.
 *
 * The game used to open straight into the army-composition screen, which is a
 * spreadsheet: a player arriving for the first time met a point-buy table
 * before they knew what the game was. A title, a play button and a way into the
 * tutorial is what every game does, and for good reason.
 *
 * The game is the story only now (the owner's amendment to PLAN.md): the old
 * skirmish setup ("Play") and the Marchwarden chronicle ("Campaign") are gone,
 * and The Exile of Rimaros is the play button. Learn the gestures stays beside
 * it as the tutorial until K9 folds the lesson into the story's opening
 * (docs/PROVISIONAL.md).
 *
 * The figures shown here are COUNTED from the content, never typed in. A hand
 * written "ten unit types" becomes a lie the moment someone adds an eleventh,
 * and this screen is the first thing a player reads. Only what the story game
 * really has is counted: nothing that belonged to the removed modes.
 */

import { UNIT_TYPE_IDS } from "../content/unit-types.ts";
import { DOCTRINE_IDS } from "../content/doctrines.ts";
import { TERRAIN_INFO } from "../sim/terrain.ts";
import { ABILITY_IDS } from "../content/abilities.ts";
import { RIMAROS } from "../content/kingdom/map.ts";
import { BUILDING_IDS } from "../content/kingdom/buildings.ts";
import { CROP_IDS } from "../content/kingdom/crops.ts";
import { FACTION_IDS } from "../content/kingdom/factions.ts";
import { STORY_EVENTS } from "../content/story/events.ts";
import { UPGRADE_IDS } from "../content/story/upgrades.ts";
import { BATTLE_GESTURE_CLASSES, KINGDOM_PEN_CLASSES } from "../content/story/tutorial.ts";

import { K } from "../content/kingdom/ui-strings.ts";

import { domScreen, el } from "./dom-screen.ts";
import type { Screen } from "./screen-stack.ts";

export type HomeChoice = "exile" | "exile-new" | "tutorial";

/**
 * What the front screen says about the kingdom save (K2). Asked again every
 * time Home comes back to the top, because leaving the kingdom saves it.
 */
export type ExileStatus =
  | { readonly kind: "none" }
  | { readonly kind: "saved"; readonly when: string }
  /** A save is there but cannot be read; the Exile button asks before replacing it. */
  | { readonly kind: "unreadable" };

/** One counted figure with its label. */
function figure(value: number, label: string): HTMLElement {
  const box = el("div", "home-figure");
  box.appendChild(el("div", "home-figure-value", String(value)));
  box.appendChild(el("div", "home-figure-label", label));
  return box;
}

/**
 * The counted figures, in the order they are shown. Exported so the checks
 * can hold each one to its source.
 */
export function homeFigures(): readonly { readonly value: number; readonly label: string }[] {
  return [
    { value: RIMAROS.holdings.length, label: "holdings on the map" },
    { value: RIMAROS.provinces.length, label: "provinces" },
    { value: FACTION_IDS.length, label: "powers in the realm" },
    { value: STORY_EVENTS.length, label: "things to find exploring" },
    { value: UPGRADE_IDS.length, label: "special upgrades" },
    { value: BUILDING_IDS.length, label: "buildings to raise" },
    { value: CROP_IDS.length, label: "crops to sow" },
    { value: UNIT_TYPE_IDS.length, label: "kinds of soldier" },
    { value: DOCTRINE_IDS.length, label: "doctrines" },
    { value: ABILITY_IDS.length, label: "reserves to call on" },
    { value: Object.keys(TERRAIN_INFO).length, label: "kinds of ground" },
    // Taps select; the rest are orders (content/story/tutorial.ts names them).
    { value: KINGDOM_PEN_CLASSES.filter((c) => !c.startsWith("tap")).length, label: "orders you can draw on the map" },
    { value: BATTLE_GESTURE_CLASSES.length, label: "orders you can draw in battle" },
  ];
}

/**
 * The front screen, as the bottom of the screen stack. It is never popped:
 * every other screen comes back here in the end.
 */
export function homeScreen(
  root: HTMLElement, choose: (choice: HomeChoice) => void, exile: () => ExileStatus = () => ({ kind: "none" }),
): Screen {
  let play: HTMLButtonElement | null = null;
  let exileNew: HTMLElement | null = null;
  let exileLine: HTMLElement | null = null;
  // Updated in place, never rebuilt: rebuilding would drop the focus the
  // stack restores to the button the player left Home by.
  const showExile = (): void => {
    if (!exileNew || !exileLine) return;
    const s = exile();
    exileLine.textContent = s.kind === "saved" ? K.homeContinue(s.when)
      : s.kind === "unreadable" ? K.homeUnreadable : K.homeFresh;
    exileNew.style.display = s.kind === "saved" ? "inline-block" : "none";
  };
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
      panel.appendChild(el("p", "home-tagline", "A fallen king, a realm to win back, and a pen to command it with."));

      // The Exile is the game: it is the play button, and the first focus.
      // "Begin a new exile" shows only while there is a realm to replace.
      const actions = el("div", "home-actions");
      play = el("button", "home-play", K.homeButton) as HTMLButtonElement;
      exileNew = el("button", "home-teach", K.homeNew);
      const teach = el("button", "home-teach", "Learn the gestures") as HTMLButtonElement;
      actions.append(play, exileNew, teach);
      panel.appendChild(actions);
      exileLine = el("p", "home-note k-home-line");
      panel.appendChild(exileLine);
      play.onclick = () => choose("exile");
      exileNew.onclick = () => choose("exile-new");
      teach.onclick = () => choose("tutorial");
      showExile();

      panel.appendChild(el("p", "home-note",
        "New here? Learn the gestures first -- every order, on the map and on the field, is a stroke of the pen."));

      // -- what the game is ----------------------------------------------------
      panel.appendChild(el("h2", undefined, "How it plays"));
      const about = el("div", "home-about");
      for (const line of [
        "You are the fallen king of Rimaros, exiled to the farthest reach with one companion and nothing else: no holding, no army, no coin. Rally followers from the hamlets, claim an empty keep, and take the realm back a holding at a time.",
        "The realm runs in real time, and you can pause it. Every holding of yours has a town to go down into, with lots to build on, fields to sow and people to carry through the winter. Beyond what you know lie ruins, shrines and old forts, and what you find there can turn the war.",
        "You command with the left mouse button and nothing else. On the map a line marches an army and a ring sets it to guard; on the field a loop gathers men into a company, a line marches them, a glyph changes their formation, and a stroke onto an enemy commits them to a fight. There, nerve decides more often than numbers.",
      ]) about.appendChild(el("p", undefined, line));
      panel.appendChild(about);

      // -- counted figures -----------------------------------------------------
      panel.appendChild(el("h2", undefined, "In the box"));
      const grid = el("div", "home-figures");
      for (const f of homeFigures()) grid.appendChild(figure(f.value, f.label));
      panel.appendChild(grid);

      panel.appendChild(el("p", "home-foot",
        "Middle- or right-drag or WASD to move the map, the wheel to zoom, " +
        "space to pause, Esc to cancel a stroke or leave."));

      root.appendChild(panel);
    },
    revealed: () => showExile(),
  });
}
