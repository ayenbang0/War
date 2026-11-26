/**
 * The exploration layer's UI on the kingdom map (K3a): it opens the event card
 * when the party finds a site, writes exploration's lines into the feed, and
 * keeps the Finds toggle in the top bar -- an unobtrusive list of the letters
 * still waiting and the special upgrades held.
 *
 * Kept out of kingdom-layer.ts on purpose: the layer only forwards
 * exploration's events here and lends its hooks, so the city view (K3b) and
 * this can grow without editing each other's code.
 *
 * The Finds list is a disclosure, not a screen: a button with aria-expanded
 * that shows a small panel under the top bar. It changes nothing in the
 * realm and holds no clock; the letters in it reopen their card.
 */

import { signal } from "../story/signals.ts";
import type { Screen } from "../screen-stack.ts";
import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { KingdomEvent } from "../../sim/kingdom/state.ts";
import type { KingdomOrderBody } from "../../sim/kingdom/orders.ts";
import { eventOf, explorationCounts, findAt, pendingFinds } from "../../sim/kingdom/explore.ts";
import { KING_PLAYER } from "../../content/kingdom/factions.ts";
import { UPGRADES } from "../../content/story/upgrades.ts";
import { X } from "../../content/story/strings.ts";
import { eventCard } from "./event-card.ts";

export type ExploreHooks = {
  pushScreen(s: Screen): void;
  popScreen(s: Screen): void;
  /** A dated line in the feed. */
  alert(text: string): void;
  /** Issue an order from a button, with the line to say. */
  issue(body: KingdomOrderBody, said: string): void;
};

function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export class ExploreUi {
  /** The open event card's site (holding id), or 0. */
  cardSite = 0;
  private card: Screen | null = null;
  private readonly cardRoot: HTMLElement;
  private readonly toggle: HTMLElement;
  private readonly panel: HTMLElement;
  private open = false;
  private readonly doc: Document;
  private readonly world: KingdomWorld;
  private readonly hooks: ExploreHooks;

  constructor(doc: Document, world: KingdomWorld, hooks: ExploreHooks) {
    this.doc = doc;
    this.world = world;
    this.hooks = hooks;
    this.cardRoot = make(doc, "div", "k-menu-backdrop k-event-backdrop");
    this.cardRoot.style.display = "none";
    this.toggle = make(doc, "button", "k-btn k-finds-toggle");
    this.toggle.setAttribute("type", "button");
    this.toggle.setAttribute("aria-expanded", "false");
    this.toggle.setAttribute("aria-controls", "k-finds");
    this.toggle.setAttribute("aria-label", X.findsLabel);
    this.toggle.onclick = (e) => {
      this.setOpen(!this.open);
      // As the HUD's own buttons: a mouse press leaves no focus (Space is pause).
      if ((e as MouseEvent).detail > 0) this.toggle.blur();
    };
    this.panel = make(doc, "section", "k-finds");
    this.panel.id = "k-finds";
    this.panel.setAttribute("aria-label", X.findsTitle);
    this.panel.style.display = "none";
    this.refresh();
  }

  /** Put the toggle in the HUD's top bar and the card root in the HUD. */
  attach(hudRoot: HTMLElement): void {
    const top = hudRoot.querySelector(".k-top") ?? hudRoot;
    const box = make(this.doc, "div", "k-box k-finds-box");
    box.append(this.toggle, this.panel);
    top.appendChild(box);
    hudRoot.appendChild(this.cardRoot);
  }

  /** Exploration's events, forwarded by the layer. */
  onEvent(e: KingdomEvent): void {
    const w = this.world;
    const name = (id: number): string => w.holding(id)?.name ?? "?";
    switch (e.kind) {
      case "sighted":
        if (e.faction !== KING_PLAYER) return;
        this.hooks.alert(e.holdings.length === 1 ? X.sighted(name(e.holdings[0])) : X.sightedMany(e.holdings.length));
        return;
      case "siteDiscovered":
        if (e.faction !== KING_PLAYER) return;
        this.hooks.alert(X.found(name(e.site)));
        this.refresh();
        if (e.event >= 0) this.openCard(e.site);
        return;
      case "eventResolved": {
        if (e.faction !== KING_PLAYER) return;
        const find = findAt(w, e.faction, e.site);
        const def = find ? eventOf(find) : undefined;
        const c = def?.choices[e.choice];
        if (c) this.hooks.alert(X.resolved({ name: name(e.site), result: e.failed && c.chance ? c.chance.fail.result : c.result }));
        this.refresh();
        return;
      }
      case "upgradeGained":
        if (e.faction !== KING_PLAYER) return;
        this.hooks.alert(X.upgrade(UPGRADES[e.upgrade].name));
        this.refresh();
        return;
      case "revealed":
        if (e.faction !== KING_PLAYER || e.holdings.length === 0) return;
        this.hooks.alert(X.revealed(e.holdings.length));
        return;
      default:
        return;
    }
  }

  /** Open the letter from `site` (replacing any open one). */
  openCard(site: number): void {
    if (this.card) this.closeCard();
    const view = eventCard(this.cardRoot, this.doc, this.world, site, {
      close: (s) => this.hooks.popScreen(s),
      closed: () => {
        if (this.card === view) {
          this.card = null;
          this.cardSite = 0;
          this.refresh();
        }
      },
      issue: (body, said) => this.hooks.issue(body, said),
    });
    this.card = view;
    this.cardSite = site;
    this.setOpen(false);
    this.hooks.pushScreen(view);
  }

  closeCard(): void {
    if (this.card) this.hooks.popScreen(this.card);
  }

  get cardOpen(): boolean {
    return this.card !== null;
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.toggle.setAttribute("aria-expanded", String(open));
    this.panel.style.display = open ? "block" : "none";
    if (open) this.refresh();
    // K9: the tutorial's "open Finds" step (ui/story/coach.ts).
    if (open) signal({ kind: "ui", action: "openFinds" });
  }

  /** Redraw the toggle's count and, if shown, the list. */
  refresh(): void {
    const ex = this.world.explore[KING_PLAYER];
    const waiting = pendingFinds(this.world, KING_PLAYER);
    this.toggle.textContent = X.findsButton(waiting.length, ex.upgrades.length);
    if (!this.open) return;
    const doc = this.doc;
    this.panel.textContent = "";
    this.panel.appendChild(make(doc, "h2", "k-finds-title", X.findsTitle));
    const counts = explorationCounts(this.world, KING_PLAYER);
    this.panel.appendChild(make(doc, "p", "k-sub", X.explored(counts.found, counts.sitesKnown)));
    this.panel.appendChild(make(doc, "h3", "k-finds-heading", X.lettersHeading));
    if (waiting.length === 0) this.panel.appendChild(make(doc, "p", "k-sub", X.noLetters));
    else {
      const list = make(doc, "ul", "k-list k-finds-letters");
      for (const f of waiting) {
        const li = make(doc, "li");
        const name = this.world.holding(f.site)?.name ?? "?";
        const b = make(doc, "button", "k-btn", X.readLetter(name));
        b.setAttribute("type", "button");
        b.setAttribute("data-site", String(f.site));
        b.onclick = () => this.openCard(f.site);
        li.appendChild(b);
        list.appendChild(li);
      }
      this.panel.appendChild(list);
    }
    this.panel.appendChild(make(doc, "h3", "k-finds-heading", X.upgradesHeading));
    if (ex.upgrades.length === 0) this.panel.appendChild(make(doc, "p", "k-sub", X.noUpgrades));
    else {
      const list = make(doc, "ul", "k-list k-finds-upgrades");
      for (const id of ex.upgrades) {
        const li = make(doc, "li");
        li.append(make(doc, "strong", undefined, UPGRADES[id].name), doc.createTextNode(": " + UPGRADES[id].about));
        list.appendChild(li);
      }
      this.panel.appendChild(list);
    }
  }
}
