/**
 * The pre-match menu: difficulty, doctrine, and the army you will fight with.
 *
 * DOM rather than canvas. A point-buy screen is a list of rows with text and
 * counts -- exactly what HTML is for -- and building it on the canvas would mean
 * reimplementing scrolling, focus and hit-testing to end up somewhere worse.
 * The pen-only rule governs commanding an army in the field, not choosing one
 * beforehand; nothing here is a battlefield action.
 */

import { UNIT_TYPES, UNIT_TYPE_IDS, type UnitTypeId } from "../content/unit-types.ts";
import { DOCTRINES, DOCTRINE_IDS, type DoctrineId } from "../content/doctrines.ts";
import { DIFFICULTIES, DIFFICULTY_IDS, type DifficultyId } from "../content/difficulty.ts";
import { DEFAULT_BUDGET, MAX_SQUADS, cost, validate, type ArmyList } from "../content/army.ts";

export type Setup = {
  readonly difficulty: DifficultyId;
  readonly army: ArmyList;
};

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/**
 * Show the menu and resolve once the player commits.
 *
 * Resolves rather than calling back so main.ts can simply await the setup
 * before building a world -- the world's doctrine and the enemy's budget both
 * depend on choices made here, so there is nothing to construct until then.
 */
export function openMenu(root: HTMLElement): Promise<Setup> {
  return new Promise((resolve) => {
    let difficulty: DifficultyId = "captain";
    let doctrine: DoctrineId = "maneuver";
    const picked: UnitTypeId[] = [];

    root.innerHTML = "";
    root.style.display = "flex";

    const panel = el("div", "menu-panel");
    panel.appendChild(el("h1", undefined, "War"));
    panel.appendChild(el("p", "sub", "A slow, deliberate battle. You command by drawing."));

    // -- difficulty ---------------------------------------------------------
    panel.appendChild(el("h2", undefined, "Opponent"));
    const diffRow = el("div", "choices");
    const diffBlurb = el("p", "blurb");
    for (const id of DIFFICULTY_IDS) {
      const d = DIFFICULTIES[id];
      const b = el("button", "choice", d.name) as HTMLButtonElement;
      b.onclick = () => {
        difficulty = id;
        for (const c of diffRow.children) c.classList.remove("on");
        b.classList.add("on");
        diffBlurb.textContent = d.blurb;
        refresh();
      };
      if (id === difficulty) {
        b.classList.add("on");
        diffBlurb.textContent = d.blurb;
      }
      diffRow.appendChild(b);
    }
    panel.appendChild(diffRow);
    panel.appendChild(diffBlurb);

    // -- doctrine -----------------------------------------------------------
    panel.appendChild(el("h2", undefined, "Doctrine"));
    const docRow = el("div", "choices");
    const docBlurb = el("p", "blurb");
    for (const id of DOCTRINE_IDS) {
      const d = DOCTRINES[id];
      const b = el("button", "choice", d.name) as HTMLButtonElement;
      b.onclick = () => {
        doctrine = id;
        for (const c of docRow.children) c.classList.remove("on");
        b.classList.add("on");
        docBlurb.textContent = d.blurb;
      };
      if (id === doctrine) {
        b.classList.add("on");
        docBlurb.textContent = d.blurb;
      }
      docRow.appendChild(b);
    }
    panel.appendChild(docRow);
    panel.appendChild(docBlurb);

    // -- roster -------------------------------------------------------------
    panel.appendChild(el("h2", undefined, "Your army"));
    const budgetLine = el("p", "budget");
    panel.appendChild(budgetLine);

    const list = el("div", "roster");
    const counters = new Map<UnitTypeId, HTMLElement>();
    for (const id of UNIT_TYPE_IDS) {
      const u = UNIT_TYPES[id];
      const row = el("div", "unit");

      const head = el("div", "unit-head");
      head.appendChild(el("span", "unit-name", u.name));
      head.appendChild(el("span", "unit-cost", u.cost + " pts"));
      row.appendChild(head);
      row.appendChild(el("div", "unit-role", u.role));
      row.appendChild(el("div", "unit-stats",
        u.soldiers + " men   " + u.hp + " hp   atk " + u.attack +
        "   def " + u.defence + "   " + (u.range > 26 ? "range " + u.range : "melee") +
        "   sight " + u.sight + "   max " + u.maxPerArmy));

      const controls = el("div", "unit-controls");
      const minus = el("button", "step", "\u2212") as HTMLButtonElement;
      const count = el("span", "count", "0");
      const plus = el("button", "step", "+") as HTMLButtonElement;
      minus.onclick = () => {
        const at = picked.lastIndexOf(id);
        if (at >= 0) picked.splice(at, 1);
        refresh();
      };
      plus.onclick = () => {
        picked.push(id);
        refresh();
      };
      controls.append(minus, count, plus);
      row.appendChild(controls);
      counters.set(id, count);
      list.appendChild(row);
    }
    panel.appendChild(list);

    const problems = el("p", "problems");
    panel.appendChild(problems);

    const actions = el("div", "actions");
    const auto = el("button", "secondary", "Suggest an army") as HTMLButtonElement;
    const start = el("button", "primary", "Take the field") as HTMLButtonElement;
    actions.append(auto, start);
    panel.appendChild(actions);
    panel.appendChild(el("p", "hint",
      "Then set your men out in your own ground and press ENTER to begin."));

    auto.onclick = () => {
      picked.length = 0;
      // Fill greedily against the budget and the per-type caps, so the
      // suggestion is always legal even after costs are retuned.
      const wish: UnitTypeId[] = [
        "line", "line", "archer", "scout", "line", "skirmisher", "archer",
        "horse", "line", "mage", "skirmisher", "guard", "horse", "siege", "archer",
      ];
      for (const id of wish) {
        picked.push(id);
        if (!validate({ doctrine, squads: picked }).ok) picked.pop();
      }
      refresh();
    };

    start.onclick = () => {
      if (!validate({ doctrine, squads: picked }).ok) return;
      root.style.display = "none";
      resolve({ difficulty, army: { doctrine, squads: picked.slice() } });
    };

    function refresh(): void {
      for (const id of UNIT_TYPE_IDS) {
        const n = picked.filter((p) => p === id).length;
        const c = counters.get(id);
        if (c) c.textContent = String(n);
      }
      const spent = cost({ doctrine, squads: picked });
      const v = validate({ doctrine, squads: picked });
      budgetLine.textContent =
        spent + " of " + DEFAULT_BUDGET + " points   -   " +
        picked.length + " of " + MAX_SQUADS + " companies   -   " +
        picked.reduce((n, p) => n + UNIT_TYPES[p].soldiers, 0) + " men";
      budgetLine.classList.toggle("over", spent > DEFAULT_BUDGET);
      problems.textContent = v.problems.join("   ");
      start.disabled = !v.ok;
    }

    auto.click();
    root.appendChild(panel);
  });
}
