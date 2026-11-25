/**
 * The commander's ability bar.
 *
 * Buttons you click, the way any game does it. Keys 1..n still work for anyone
 * who wants them, but an ability the player has to remember a number for is an
 * ability they will not use.
 *
 * These are the COMMANDER's, not a unit's: no company casts a barrage, and
 * nothing on the field has to be selected to spend one. Clicking a button arms
 * it; the next click on the map says where it goes. That keeps the left button
 * the only thing that ever points at the world.
 *
 * DOM rather than canvas, like the menu and the report: a row of buttons with
 * labels, counts and a cooldown is what HTML already does well.
 */

import { ABILITIES, type AbilityId } from "../content/abilities.ts";
import type { World } from "../sim/world.ts";
import type { Commander } from "../input/commander.ts";

/** A one-glyph mark per ability, so a button reads before its label does. */
const MARK: Record<AbilityId, string> = {
  barrage: "✹",
  charge: "➤",
  shield: "◧",
  smoke: "░",
  flare: "☀",
  levy: "⚇",
  muster: "⚑",
  caltrops: "⁂",
  firepots: "♨",
  forcedMarch: "»",
  parley: "⚐",
  beacon: "♆",
};

type Slot = {
  readonly id: AbilityId;
  readonly root: HTMLButtonElement;
  readonly count: HTMLElement;
  readonly cool: HTMLElement;
};

export class AbilityBar {
  private readonly slots: Slot[] = [];
  private readonly root: HTMLElement;

  constructor(root: HTMLElement, ids: readonly AbilityId[], commander: Commander) {
    this.root = root;
    root.textContent = "";
    root.className = "ability-bar";
    if (ids.length === 0) {
      root.style.display = "none";
      return;
    }
    root.style.display = "flex";

    ids.forEach((id, i) => {
      const a = ABILITIES[id];
      const b = document.createElement("button");
      b.className = "ability";
      b.title = a.name + " - " + a.blurb;

      const key = document.createElement("span");
      key.className = "ability-key";
      key.textContent = String(i + 1);
      const mark = document.createElement("span");
      mark.className = "ability-mark";
      mark.textContent = MARK[id];
      const name = document.createElement("span");
      name.className = "ability-name";
      name.textContent = a.name;
      const count = document.createElement("span");
      count.className = "ability-count";
      const cool = document.createElement("span");
      cool.className = "ability-cool";

      b.append(key, mark, name, count, cool);
      // Arming must not leave the button focused, or the next space or number
      // key goes to it instead of to the game.
      b.onclick = () => {
        commander.arm(id);
        b.blur();
      };
      root.appendChild(b);
      this.slots.push({ id, root: b, count, cool });
    });
  }

  /** Refresh counts, cooldowns and which one is armed. Called once a frame. */
  update(world: World, player: number, commander: Commander, tickRate: number): void {
    for (const s of this.slots) {
      const c = world.abilityState[player].get(s.id);
      const left = c ? c.left : 0;
      const cooling = c && world.tick < c.readyAt
        ? Math.ceil((c.readyAt - world.tick) / tickRate)
        : 0;
      s.count.textContent = "x" + left;
      s.cool.textContent = cooling > 0 ? cooling + "s" : "";
      s.root.classList.toggle("armed", commander.armed === s.id);
      // Spent or cooling reads as unavailable rather than merely unhelpful.
      s.root.classList.toggle("spent", left <= 0 || cooling > 0);
    }
  }

  /** Hide the bar, for the tutorial and once the match is over. */
  hide(): void {
    this.root.style.display = "none";
  }
}
