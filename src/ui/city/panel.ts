/**
 * The city panel (K3b; docs/audit/u2-city-view.md, C-02 and C-03): the
 * town's name, what it is, and every lot and field as a BUTTON, so all that
 * the plan offers to the pen is in the tab order too. It sits at the left of
 * the city view and stays up while the city does; the lot, field and politics
 * cards open beside it.
 *
 * Focus lands on the heading when the city opens (tabindex -1: the key router
 * leaves Space to a focused button, and Space is pause). It is rebuilt only
 * when what it shows changes, and a rebuild puts focus back on the button
 * with the same key. Its liveness follows the input contexts the layer is
 * given (live while the pen is), not the stack's "inert under the top": a
 * non-modal card above it leaves it usable, a modal menu does not.
 */

import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { Holding } from "../../sim/kingdom/state.ts";
import { C, KIND_PLACE } from "../../content/kingdom/city-strings.ts";
import { CROPS, type CropId } from "../../content/kingdom/crops.ts";
import { KING_PLAYER } from "../../content/kingdom/factions.ts";
import { grainStores } from "../../sim/kingdom/economy.ts";
import { fieldLine, lotLine } from "../../render/city/renderer.ts";

export type CityPanelHooks = {
  lot(index: number): void;
  field(index: number): void;
  politics(): void;
  leave(): void;
  /** ECON: the realm's "resow all fields automatically" switch, turned on or off. */
  resowAll(on: boolean): void;
};

/** What is open beside the panel, marked aria-current on its button. */
export type CityOpen = { readonly kind: "lot" | "field"; readonly index: number } | { readonly kind: "politics" } | null;

function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
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

export class CityPanel {
  readonly root: HTMLElement;
  /** The heading, focused when the city opens. */
  heading: HTMLElement | null = null;
  private readonly doc: Document;
  private readonly world: KingdomWorld;
  private readonly holding: Holding;
  private readonly hooks: CityPanelHooks;
  private shown = "";
  private open: CityOpen = null;

  constructor(root: HTMLElement, doc: Document, world: KingdomWorld, holding: Holding, hooks: CityPanelHooks) {
    this.root = root;
    this.doc = doc;
    this.world = world;
    this.holding = holding;
    this.hooks = hooks;
  }

  /** The button with this key (lot-0, field-1, politics, leave), if drawn. */
  byKey(key: string): HTMLElement | null {
    for (const b of Array.from(this.root.querySelectorAll<HTMLElement>("button"))) if (b.getAttribute("data-key") === key) return b;
    return null;
  }

  setOpen(open: CityOpen): void {
    this.open = open;
    this.refresh();
  }

  setLive(live: boolean): void {
    this.root.inert = !live;
  }

  private signature(): string {
    const h = this.holding;
    const o = this.open;
    return [
      h.name, h.kind, h.population, h.famine,
      h.buildings.map((_, i) => lotLine(h, i)).join(","),
      h.plots.map((p) => fieldLine(p) + ":" + p.health + ":" + p.auto).join(","),
      o ? o.kind + ("index" in o ? o.index : "") : "",
      this.world.kingStocks.autoSow, grainStores(this.world, KING_PLAYER).grain, grainStores(this.world, KING_PLAYER).capacity,
    ].join("|");
  }

  /** Rebuild if anything shown changed; keeps focus on the same control. */
  refresh(): void {
    const sig = this.signature();
    if (sig === this.shown) return;
    this.shown = sig;
    const active = this.doc.activeElement as HTMLElement | null;
    const inPanel = active && inside(active, this.root);
    const hadKey = inPanel ? active.getAttribute("data-key") : null;
    const hadHeading = inPanel && active === this.heading;
    this.build();
    if (hadKey) (this.byKey(hadKey) ?? this.heading)?.focus();
    else if (hadHeading) this.heading?.focus();
  }

  private build(): void {
    const { doc, holding: h, world } = this;
    const root = this.root;
    root.textContent = "";
    root.setAttribute("role", "region");
    root.setAttribute("aria-labelledby", "c-title");
    const title = make(doc, "h2", "c-title", h.name);
    title.id = "c-title";
    title.setAttribute("tabindex", "-1");
    this.heading = title;
    const province = world.map.provinces.find((p) => p.id === h.province);
    const sub = make(doc, "p", "c-sub", C.sub({ kind: KIND_PLACE[h.kind], province: province?.name ?? "", people: h.population }));
    root.append(make(doc, "p", "c-eyebrow", C.panelLabel), title, sub);
    if (h.famine > 0) root.appendChild(make(doc, "p", "k-warn", C.famineSummary(h.famine)));

    const actions = make(doc, "div", "c-actions");
    actions.appendChild(this.button(C.politics, "politics", () => this.hooks.politics(), this.open?.kind === "politics"));
    actions.appendChild(this.button(C.leave, "leave", () => this.hooks.leave(), false));
    root.appendChild(actions);

    root.appendChild(make(doc, "h3", "k-section", C.lots));
    const lots = make(doc, "ul", "c-list");
    h.buildings.forEach((_, i) => {
      const li = make(doc, "li");
      const o = this.open;
      const b = this.button(C.lotButton({ n: i + 1, what: lotLine(h, i) }), "lot-" + i, () => this.hooks.lot(i),
        o?.kind === "lot" && o.index === i);
      if (h.idle[i]) b.classList.add("c-warn");
      li.appendChild(b);
      lots.appendChild(li);
    });
    root.appendChild(lots);

    root.appendChild(make(doc, "h3", "k-section", C.fields));
    const fields = make(doc, "ul", "c-list");
    h.plots.forEach((p, i) => {
      const li = make(doc, "li");
      const o = this.open;
      const b = this.button(C.fieldButton({ n: i + 1, what: fieldLine(p) }), "field-" + i, () => this.hooks.field(i),
        o?.kind === "field" && o.index === i);
      if (p.stage === "spoiled") b.classList.add("c-warn");
      if (p.stage === "ripe") b.classList.add("c-good");
      li.appendChild(b);
      fields.appendChild(li);
    });
    root.appendChild(fields);
    // ECON (owner: "the king can automatically make them sowed"): one switch for
    // every field of the realm, a pressed/not-pressed button so its state is read.
    const auto = world.kingStocks.autoSow;
    const sw = this.button(C.resowAll, "resow-all", () => this.hooks.resowAll(auto === null), false);
    sw.setAttribute("aria-pressed", auto !== null ? "true" : "false");
    sw.setAttribute("aria-label", C.resowAllAria(auto !== null));
    sw.classList.add("c-switch");
    root.appendChild(sw);
    root.appendChild(make(doc, "p", "c-sub c-resow-state", auto !== null ? C.resowAllOn(CROPS[auto as CropId].name) : C.resowAllOff));
    const gs = grainStores(world, KING_PLAYER);
    root.appendChild(make(doc, "p", "c-sub c-stores", C.realmStores({ grain: gs.grain, capacity: gs.capacity })));
    root.appendChild(make(doc, "p", "c-keys", C.keyHint));
  }

  private button(text: string, key: string, onPress: () => void, current: boolean): HTMLElement {
    const b = make(this.doc, "button", "k-btn c-item", text);
    b.setAttribute("type", "button");
    b.setAttribute("data-key", key);
    if (current) b.setAttribute("aria-current", "true");
    b.onclick = (e) => {
      onPress();
      pressed(b, e);
    };
    return b;
  }
}
