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
import { unitIconCanvas } from "../render/unit-icon.ts";
import { DOCTRINES, DOCTRINE_IDS, type DoctrineId } from "../content/doctrines.ts";
import { DIFFICULTIES, DIFFICULTY_IDS, type DifficultyId } from "../content/difficulty.ts";
import { COMMANDERS, COMMANDER_IDS, type Commander, type CommanderId } from "../content/commanders.ts";
import { MAX_SQUADS, cost, validate, type ArmyList } from "../content/army.ts";
import { LEVELS, type LevelDef } from "../content/levels/index.ts";

export type Setup = {
  readonly level: LevelDef;
  readonly difficulty: DifficultyId;
  readonly army: ArmyList;
  /** Who the machine's army answers to. */
  readonly commander: Commander;
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
    let level: LevelDef = LEVELS[0];
    let difficulty: DifficultyId = level.suggestedDifficulty;
    /** null means "draw one at random", which is the default. */
    let commander: CommanderId | null = null;
    let doctrine: DoctrineId = "maneuver";
    const picked: UnitTypeId[] = [];

    root.innerHTML = "";
    root.style.display = "flex";

    const panel = el("div", "menu-panel");
    panel.appendChild(el("h1", undefined, "War"));
    panel.appendChild(el("p", "sub", "A slow, deliberate battle. You command by drawing."));

    // -- battlefield --------------------------------------------------------
    panel.appendChild(el("h2", undefined, "Battlefield"));
    const lvlRow = el("div", "choices");
    const lvlBlurb = el("p", "blurb");
    const lvlButtons: HTMLButtonElement[] = [];
    for (const l of LEVELS) {
      const b = el("button", "choice", l.name) as HTMLButtonElement;
      b.onclick = () => {
        level = l;
        for (const c of lvlRow.children) c.classList.remove("on");
        b.classList.add("on");
        // The budget and the win condition are the level's, so the army has to
        // be re-checked -- and often re-picked -- when the ground changes.
        showLevel();
        auto.click();
      };
      lvlButtons.push(b);
      lvlRow.appendChild(b);
    }
    panel.appendChild(lvlRow);
    panel.appendChild(lvlBlurb);

    function showLevel(): void {
      lvlBlurb.textContent =
        level.brief + "   -   " + describeVictory(level) +
        "   -   " + level.budget + " points, " + Math.round(level.duration / 60) + " minutes.";
    }

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

    // -- commander ----------------------------------------------------------
    // Separate from difficulty on purpose: difficulty is how well the machine
    // is run, this is who is running it. The blurb states the habit outright,
    // because the whole point of a named opponent is a tendency you can read
    // and then punish.
    panel.appendChild(el("h2", undefined, "Their commander"));
    const cmdRow = el("div", "choices");
    const cmdBlurb = el("p", "blurb");
    const setCommanderBlurb = (): void => {
      cmdBlurb.textContent = commander === null
        ? "Drawn at random. You will not know who you are facing until they show you."
        : "The " + COMMANDERS[commander].name + ", " + COMMANDERS[commander].epithet +
          ". " + COMMANDERS[commander].blurb;
    };
    const commanderChoices: (CommanderId | null)[] = [null, ...COMMANDER_IDS];
    for (const id of commanderChoices) {
      const label = id === null ? "Unknown" : COMMANDERS[id].name;
      const b = el("button", "choice", label) as HTMLButtonElement;
      b.onclick = () => {
        commander = id;
        for (const c of cmdRow.children) c.classList.remove("on");
        b.classList.add("on");
        setCommanderBlurb();
      };
      if (id === commander) b.classList.add("on");
      cmdRow.appendChild(b);
    }
    setCommanderBlurb();
    panel.appendChild(cmdRow);
    panel.appendChild(cmdBlurb);

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

      // The counter you will actually be looking for on the field, drawn by the
      // same code that draws it there.
      const icon = el("div", "unit-icon");
      icon.appendChild(unitIconCanvas(id, 40));
      row.appendChild(icon);

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
        if (!validate({ doctrine, squads: picked }, level.budget).ok) picked.pop();
      }
      refresh();
    };

    start.onclick = () => {
      if (!validate({ doctrine, squads: picked }, level.budget).ok) return;
      root.style.display = "none";
      // "Unknown" draws one now, so the match is still fully determined by the
      // setup that comes out of here -- the world is built from this and
      // nothing may decide it later.
      const chosen = commander ?? COMMANDER_IDS[(Math.random() * COMMANDER_IDS.length) | 0];
      resolve({
        level,
        difficulty,
        army: { doctrine, squads: picked.slice() },
        commander: COMMANDERS[chosen],
      });
    };

    function refresh(): void {
      for (const id of UNIT_TYPE_IDS) {
        const n = picked.filter((p) => p === id).length;
        const c = counters.get(id);
        if (c) c.textContent = String(n);
      }
      const spent = cost({ doctrine, squads: picked });
      const v = validate({ doctrine, squads: picked }, level.budget);
      budgetLine.textContent =
        spent + " of " + level.budget + " points   -   " +
        picked.length + " of " + MAX_SQUADS + " companies   -   " +
        picked.reduce((n, p) => n + UNIT_TYPES[p].soldiers, 0) + " men";
      budgetLine.classList.toggle("over", spent > level.budget);
      problems.textContent = v.problems.join("   ");
      start.disabled = !v.ok;
    }

    lvlButtons[0].classList.add("on");
    showLevel();
    auto.click();
    root.appendChild(panel);
  });
}

/** Plain English for how a level is won, so the mode is never a mystery. */
function describeVictory(level: LevelDef): string {
  const v = level.victory;
  if (v.mode === "objectives") {
    return "hold " + v.required + " of " + level.controlPoints.length +
      " points for " + Math.round(v.holdToWin / 60) + " minutes";
  }
  if (v.mode === "points") {
    return "first to " + v.target + " points, from ground held and men killed";
  }
  return "break the enemy's nerve";
}
