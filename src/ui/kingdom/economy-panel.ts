/**
 * The economy panel, and its two choice menus: the build menu and the plot
 * manager's sow menu (K3; docs/audit/u2-economy-panels.md).
 *
 * K3b: the region card no longer carries the panel (it shows a summary and
 * "Enter the city"); the city view's cards use these pieces instead -- the
 * politics card draws only the tax section (`sections`, no heading), and the
 * lot card opens `buildMenu` with a note naming the lot it builds on.
 *
 * THE PANEL, shown for a holding the king owns, has its tax (a group of toggle buttons with aria-pressed, plus "Same
 * rate everywhere"), its bread and any famine, its building slots with a
 * Build… button, and its fields with Sow… and Harvest. It is rebuilt only
 * when what it shows changes (a signature of the holding's state), and a
 * rebuild puts focus back on the control with the same key, so a keyboard
 * player who pressed "Low" or "Harvest" keeps their place (U1 rule:
 * re-rendering restores focus to the equivalent control).
 *
 * THE MENUS are modal overlays on the screen stack: they trap Tab, hold the
 * realm's clock while open (as a confirm does: a choice that spends coin is
 * made with the world still), and Esc or Cancel closes them. Every option is
 * listed, with its cost and what it does; an option the sim would refuse
 * stays in the list as a focusable button marked aria-disabled, and pressing
 * it says why, in the same words the sim uses -- because the panel and the
 * sim call ONE check (KingdomWorld.check), a button never promises what the
 * sim then refuses.
 *
 * The panel and menus only read the world; every change goes out as an order
 * through the layer's `issue` (the queue), like the march.
 */

import { domScreen } from "../dom-screen.ts";
import type { KeyVerdict, Screen } from "../screen-stack.ts";
import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { KingdomOrderBody } from "../../sim/kingdom/orders.ts";
import type { Holding } from "../../sim/kingdom/state.ts";
import { seedCost, taxPerDay } from "../../sim/kingdom/economy.ts";
import { BUILDINGS, BUILDING_IDS, type BuildingId, type Cost } from "../../content/kingdom/buildings.ts";
import { CROPS, CROP_IDS, type CropId } from "../../content/kingdom/crops.ts";
import { DOLE_PER_100, FIELD_SIZE, TAX_RATES, TAX_RATE_IDS } from "../../content/kingdom/economy.ts";
import { E, SEASON_NAME, STAGE_NAME, TAX_NAME, amountsLine } from "../../content/kingdom/ui-strings.ts";

export type EconomyHooks = {
  /** Send an order to the queue (and say so on the result line). */
  issue(body: KingdomOrderBody, said: string): void;
  /** Open a menu on top of the stack. */
  openMenu(s: Screen): void;
  /** Close a menu (pop it if it is on top). */
  closeMenu(s: Screen): void;
  /** Where menus are drawn. */
  readonly menuRoot: HTMLElement;
};

function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function button(doc: Document, text: string, key: string, cls = "k-btn"): HTMLElement {
  const b = make(doc, "button", cls, text);
  b.setAttribute("type", "button");
  b.setAttribute("data-key", key);
  return b;
}

/** A mouse press does not leave the button focused (Space is the pause key). */
function pressed(b: HTMLElement, e: Event): void {
  if ((e as MouseEvent).detail > 0) b.blur();
}

function inside(el: Element | null, root: HTMLElement): boolean {
  let n: Node | null = el;
  while (n) {
    if (n === root) return true;
    n = n.parentNode;
  }
  return false;
}

function byKey(root: HTMLElement, key: string): HTMLElement | null {
  for (const b of Array.from(root.querySelectorAll<HTMLElement>("button"))) if (b.getAttribute("data-key") === key) return b;
  return null;
}

// -- the panel ---------------------------------------------------------------------

export type EconomyPanel = {
  readonly root: HTMLElement;
  /** Rebuild if anything shown changed; keeps focus on the same control. */
  refresh(): void;
  /** The control that had focus before a menu opened, for the card's first focus on return. */
  focusTarget(): HTMLElement | null;
};

function signature(world: KingdomWorld, h: Holding): string {
  // Only what the panel shows (and what decides which buttons it offers).
  return [
    h.owner, h.tax, h.population, h.famine, world.date.season,
    h.buildings.join(","), h.works.join(","), h.idle.join(","),
    h.plots.map((p) => p.crop + ":" + p.stage + ":" + Math.floor(p.progress * 100) + ":" + p.health).join(","),
  ].join("|");
}

/** Which parts of the panel to draw (K3b: the city's politics card draws only the tax). */
export type EconomySection = "tax" | "buildings" | "fields";

export type EconomyPanelOptions = {
  readonly sections?: readonly EconomySection[];
  /** The section's heading; null for none (the card it sits in has its own). */
  readonly title?: string | null;
};

export function economyPanel(
  doc: Document, world: KingdomWorld, holdingId: number, hooks: EconomyHooks, opts: EconomyPanelOptions = {},
): EconomyPanel {
  const h = world.holding(holdingId) as Holding;
  const root = make(doc, "section", "k-economy");
  const sections = opts.sections ?? ["tax", "buildings", "fields"];
  const heading = opts.title === undefined ? E.economy : opts.title;
  let shown = "";
  /** The key of the last control the player used here, so a menu's return lands on it. */
  let lastKey = "";

  const build = (): void => {
    root.textContent = "";
    if (h.owner !== "king") {
      root.style.display = "none";
      return;
    }
    root.style.display = "block";
    if (heading !== null) {
      root.setAttribute("aria-labelledby", "k-economy-title");
      const title = make(doc, "h3", "k-section", heading);
      title.id = "k-economy-title";
      root.appendChild(title);
    }
    if (sections.includes("tax")) buildTax();
    if (sections.includes("buildings")) buildBuildings();
    if (sections.includes("fields")) buildFields();
  };

  const buildTax = (): void => {

    // Tax.
    const rate = TAX_RATES[TAX_RATE_IDS.indexOf(h.tax)];
    const dl = make(doc, "dl", "k-rows");
    dl.appendChild(make(doc, "dt", undefined, E.tax));
    dl.appendChild(make(doc, "dd", undefined, E.taxLine({ coin: E.coinAmount(taxPerDay(h.population, h.tax)), growth: E.growth(rate.growthPct) })));
    dl.appendChild(make(doc, "dt", undefined, E.bread));
    dl.appendChild(make(doc, "dd", undefined, E.breadLine(Math.round((h.population * DOLE_PER_100[world.date.season]) / 100))));
    if (h.famine > 0) {
      dl.appendChild(make(doc, "dt", undefined, ""));
      dl.appendChild(make(doc, "dd", "k-warn", E.famineNow(h.famine)));
    }
    root.appendChild(dl);

    const taxes = make(doc, "div", "k-toggles");
    taxes.setAttribute("role", "group");
    taxes.setAttribute("aria-label", E.taxGroup);
    for (const id of TAX_RATE_IDS) {
      const b = button(doc, TAX_NAME[id], "tax-" + id);
      const on = h.tax === id;
      b.setAttribute("aria-pressed", String(on));
      if (on) b.classList.add("on");
      const r = TAX_RATES[TAX_RATE_IDS.indexOf(id)];
      b.setAttribute("title", E.taxLine({ coin: E.coinAmount(taxPerDay(h.population, id)), growth: E.growth(r.growthPct) }));
      b.onclick = (e) => {
        lastKey = "tax-" + id;
        if (!on) hooks.issue({ kind: "setTax", holding: h.id, rate: id }, E.taxSetDone({ name: h.name, rate: TAX_NAME[id] }));
        pressed(b, e);
      };
      taxes.appendChild(b);
    }
    const realm = button(doc, E.taxRealm, "tax-realm");
    realm.onclick = (e) => {
      lastKey = "tax-realm";
      hooks.issue({ kind: "setTax", holding: 0, rate: h.tax }, E.taxRealmDone(TAX_NAME[h.tax]));
      pressed(realm, e);
    };
    taxes.appendChild(realm);
    root.appendChild(taxes);
  };

  const buildBuildings = (): void => {
    root.appendChild(make(doc, "h3", "k-section", E.buildings));
    const slots = make(doc, "ul", "k-list");
    h.buildings.forEach((b, i) => {
      const def = b ? BUILDINGS[b as BuildingId] : null;
      const text = !def ? E.slotEmpty
        : h.works[i] > 0 ? E.slotBuilding({ name: def.name, days: h.works[i] })
          : h.idle[i] ? E.slotIdle(def.name) : E.slotStanding(def.name);
      slots.appendChild(make(doc, "li", h.idle[i] ? "k-warn" : undefined, text));
    });
    root.appendChild(slots);
    const buildBtn = button(doc, E.build, "build");
    buildBtn.setAttribute("aria-haspopup", "dialog");
    buildBtn.setAttribute("aria-label", E.buildAt(h.name));
    buildBtn.onclick = () => { lastKey = "build"; hooks.openMenu(buildMenu(doc, world, h, hooks)); };
    root.appendChild(buildBtn);
  };

  const buildFields = (): void => {
    root.appendChild(make(doc, "h3", "k-section", E.fields));
    const fields = make(doc, "ul", "k-list k-fields");
    h.plots.forEach((p, i) => {
      const li = make(doc, "li", "k-field");
      const crop = p.crop ? CROPS[p.crop as CropId] : null;
      const line = crop
        ? E.plotLine({ crop: crop.name, stage: STAGE_NAME[p.stage], pct: Math.floor(p.progress * 100), health: p.health })
        : E.plotEmpty;
      li.appendChild(make(doc, "span", p.stage === "spoiled" ? "k-warn" : p.stage === "ripe" ? "k-good" : undefined,
        E.field(i + 1) + ": " + line));
      const open = p.stage === "empty" || p.stage === "harvested" || p.stage === "spoiled";
      if (open && !(p.stage === "harvested" && crop?.regrowDays)) {
        const sow = button(doc, E.sow, "sow-" + p.id);
        sow.setAttribute("aria-haspopup", "dialog");
        sow.setAttribute("aria-label", E.sowField(i + 1));
        sow.onclick = () => { lastKey = "sow-" + p.id; hooks.openMenu(sowMenu(doc, world, h, i, hooks)); };
        li.appendChild(sow);
      }
      if (p.stage === "ripe") {
        const hv = button(doc, E.harvest, "harvest-" + p.id);
        hv.setAttribute("aria-label", E.harvestField(i + 1));
        hv.onclick = (e) => {
          lastKey = "harvest-" + p.id;
          hooks.issue({ kind: "harvest", plot: p.id }, E.chosen);
          pressed(hv, e);
        };
        li.appendChild(hv);
      }
      fields.appendChild(li);
    });
    root.appendChild(fields);
  };

  const refresh = (): void => {
    const sig = signature(world, h);
    if (sig === shown) return;
    shown = sig;
    const active = doc.activeElement as HTMLElement | null;
    const hadFocus = active && inside(active, root) ? active.getAttribute("data-key") : null;
    build();
    if (hadFocus) {
      // The same control if it still exists; otherwise the section's heading
      // (never the page body).
      const again = byKey(root, hadFocus) ?? byKey(root, hadFocus.startsWith("tax-") ? "tax-" + h.tax : "build");
      if (again) again.focus();
    }
  };

  return {
    root,
    refresh,
    focusTarget: () => (lastKey ? byKey(root, lastKey) : null),
  };
}

// -- the menus ---------------------------------------------------------------------

export type Option = {
  readonly key: string;
  readonly label: string;
  readonly lines: readonly string[];
  /** Why the sim would refuse it now, or null. */
  readonly why: string | null;
  readonly order: KingdomOrderBody;
  readonly said: string;
};

export type MenuSpec = {
  readonly name: string;
  readonly title: string;
  readonly intro: string;
  readonly options: () => Option[];
  /** The cancel button's words (default "Cancel"): "Keep the army" on a stand-down. */
  readonly cancelLabel?: string;
  /** Start focus on Cancel, not the first choice: for a choice that cannot be undone (U2 A-05). */
  readonly focusCancel?: boolean;
};

/** A modal list of choices (see the file comment). */
export function choiceMenu(doc: Document, spec: MenuSpec, hooks: EconomyHooks): Screen {
  const root = hooks.menuRoot;
  let first: HTMLElement | null = null;
  let status: HTMLElement | null = null;
  const close = (): void => hooks.closeMenu(screen);
  const screen: Screen = domScreen({
    name: spec.name,
    kind: "overlay",
    root,
    display: "flex",
    trapsFocus: true,
    pausesSim: true,
    inputs: ["ui"],
    firstFocus: () => first,
    build: () => {
      root.textContent = "";
      const panel = make(doc, "div", "k-menu");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      const title = make(doc, "h2", "k-menu-title", spec.title);
      title.id = "k-menu-title";
      panel.setAttribute("aria-labelledby", title.id);
      const intro = make(doc, "p", "k-sub", spec.intro);
      intro.id = "k-menu-intro";
      panel.setAttribute("aria-describedby", intro.id);
      panel.append(title, intro);
      const list = make(doc, "ul", "k-choices");
      list.setAttribute("aria-label", E.menuGroup);
      let firstOpen: HTMLElement | null = null;
      for (const o of spec.options()) {
        const li = make(doc, "li", "k-choice" + (o.why ? " unavailable" : ""));
        const b = button(doc, o.label, o.key, "k-btn k-choice-btn");
        const detailId = "k-choice-" + o.key;
        b.setAttribute("aria-describedby", detailId);
        if (o.why) b.setAttribute("aria-disabled", "true");
        const detail = make(doc, "div", "k-choice-detail");
        detail.id = detailId;
        for (const line of o.lines) detail.appendChild(make(doc, "span", undefined, line));
        if (o.why) detail.appendChild(make(doc, "span", "k-why", E.notNow(o.why)));
        b.onclick = () => {
          // Asked again at the press: the world may have moved since the list was drawn.
          if (o.why) {
            if (status) status.textContent = E.notNow(o.why);
            return;
          }
          close();
          hooks.issue(o.order, o.said);
        };
        li.append(b, detail);
        list.appendChild(li);
        if (!firstOpen && !o.why) firstOpen = b;
      }
      panel.appendChild(list);
      status = make(doc, "p", "k-menu-status");
      status.setAttribute("role", "status");
      panel.appendChild(status);
      const actions = make(doc, "div", "k-card-actions");
      const cancel = button(doc, spec.cancelLabel ?? E.cancel, "cancel");
      cancel.onclick = () => close();
      actions.append(cancel, make(doc, "span", "k-hint", "Esc cancels"));
      panel.appendChild(actions);
      root.appendChild(panel);
      // Focus starts on the first thing that can be chosen, or on Cancel.
      first = spec.focusCancel ? cancel : firstOpen ?? cancel;
    },
    onKey: (k): KeyVerdict => {
      if (k.code !== "Escape") return "pass";
      close();
      return "handled";
    },
  });
  return screen;
}

function costOf(c: Cost): string {
  return amountsLine(c);
}

/** `note` adds a line to the intro (K3b: which lot of the city the building goes on). */
export function buildMenu(doc: Document, world: KingdomWorld, h: Holding, hooks: EconomyHooks, note = ""): Screen {
  return choiceMenu(doc, {
    name: "build-menu",
    title: E.buildTitle(h.name),
    intro: note ? E.buildIntro + " " + note : E.buildIntro,
    options: () => BUILDING_IDS.map((id): Option => {
      const def = BUILDINGS[id];
      const order: KingdomOrderBody = { kind: "build", holding: h.id, building: id };
      const upkeep = Object.values(def.upkeep).some((v) => (v ?? 0) > 0) ? costOf(def.upkeep) : "";
      return {
        key: "build-" + id,
        label: def.name,
        lines: [def.purpose, E.costLine(costOf(def.cost)), E.daysLine({ days: def.days, upkeep })],
        why: world.check(order),
        order,
        said: E.chosen,
      };
    }),
  }, hooks);
}

export function sowMenu(doc: Document, world: KingdomWorld, h: Holding, index: number, hooks: EconomyHooks): Screen {
  const plot = h.plots[index];
  return choiceMenu(doc, {
    name: "sow-menu",
    title: E.sowTitle({ field: E.field(index + 1), name: h.name }),
    intro: E.sowIntro,
    options: () => CROP_IDS.map((id): Option => {
      const crop = CROPS[id];
      const order: KingdomOrderBody = { kind: "sow", plot: plot.id, crop: id };
      const f = FIELD_SIZE[h.kind];
      const yields: Partial<Record<keyof Cost & string, number>> = {};
      for (const [s, v] of Object.entries(crop.yield)) if (v) (yields as Record<string, number>)[s] = v * f;
      return {
        key: "sow-" + id,
        label: crop.name,
        lines: [
          crop.about,
          E.costLine(costOf(seedCost(crop, h))),
          E.yieldLine(costOf(yields as Cost)),
          E.seasonLine(E.seasons(crop.sow.map((s) => SEASON_NAME[s]))),
        ],
        why: world.check(order),
        order,
        said: E.chosen,
      };
    }),
  }, hooks);
}
