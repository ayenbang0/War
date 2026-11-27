/**
 * The resources bar (K3; docs/audit/u2-economy-panels.md, "Resources bar"):
 * the king's stocks, each with its icon, its name and its value, the change
 * since yesterday, and under them how long the bread lasts and what is going
 * hungry. It replaces K2's "No stores yet" box in the HUD's top bar.
 *
 * DRIVEN BY EVENTS like the rest of the HUD (U1-09): the layer calls
 * `update` when the sim says the stocks changed, a day began, a famine began
 * or ended, or a holding or a granary came to the king -- and once when the
 * bar is built, because events do not replay. Each cell is written only when
 * its text changes. It reads the world and never writes it.
 *
 * The bar is not a live region: it changes every day, and the feed already
 * says the news worth hearing (a famine, a building, a harvest). Each value
 * carries its full meaning as text ("Grain 82, +6 since yesterday") for a
 * screen reader, and the sign of a change is written, never shown by colour
 * alone.
 */

import { LEDGER_CATEGORIES, LEDGER_STOCK_IDS, type LedgerStockId } from "../../content/kingdom/economy.ts";
import { E, STOCK_ABOUT, STOCK_NAME } from "../../content/kingdom/ui-strings.ts";
import { KING_PLAYER } from "../../content/kingdom/factions.ts";
import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import { flowOf, ledgerValue, netOf } from "../../sim/kingdom/ledger.ts";
import { dailyNeed, grainStores } from "../../sim/kingdom/economy.ts";
import { DAYS_PER_SEASON, daysUntilSeason } from "../../sim/kingdom/clock.ts";
import type { LedgerDay } from "../../sim/kingdom/ledger.ts";
import { stockIcon } from "./icons.ts";

import { armiesOf, armyUpkeep } from "../../sim/kingdom/armies.ts";
import { AC } from "../../content/kingdom/army-strings.ts";
import { MERCY } from "../../content/kingdom/morale-strings.ts";

function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Grain lasts this many days at today's need; 999 means nothing eats it. */
export function grainDays(world: KingdomWorld): number {
  const need = world.dailyNeed(KING_PLAYER);
  return need <= 0 ? 999 : Math.floor(world.kingStocks.stocks.grain / need);
}

/** Warn of the coming winter this many days ahead, when the stores will not see the king's towns through it. */
const WINTER_WARNING_DAYS = 30;
/** Warn that the bread runs out when it lasts fewer days than this. */
const BREAD_WARNING_DAYS = 20;

/**
 * ECON (owner: "a lot easier with managing resources"): a stock's day in
 * words for its tooltip -- yesterday's net and what moved it, the biggest
 * movers first (ties in ledger order, so the same day reads the same).
 */
export function flowParts(day: LedgerDay, s: LedgerStockId): { label: string; n: number }[] {
  const parts: { label: string; n: number }[] = [];
  for (const c of LEDGER_CATEGORIES) {
    const v = flowOf(day, s, c.id);
    if (v !== 0) parts.push({ label: c.label, n: c.dir === "source" ? v : -v });
  }
  return parts.sort((a, b) => Math.abs(b.n) - Math.abs(a.n));
}

type Cell = { readonly item: HTMLElement; readonly value: HTMLElement; readonly delta: HTMLElement };

export class ResourcesBar {
  readonly root: HTMLElement;
  private readonly cells = new Map<LedgerStockId, Cell>();
  private readonly lasts: HTMLElement;
  private readonly store: HTMLElement;
  private readonly burn: HTMLElement;
  private readonly trouble: HTMLElement;
  /** K6: the realm's Mercy/Terror, after the stocks (it is not one: no ledger, no day's change). */
  private readonly mercyItem: HTMLElement;
  private readonly mercyName: HTMLElement;
  private readonly mercyValue: HTMLElement;

  constructor(doc: Document) {
    this.root = make(doc, "div", "k-box k-stores");
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", E.resourcesGroup);
    const list = make(doc, "ul", "k-stocks");
    for (const s of LEDGER_STOCK_IDS) {
      const item = make(doc, "li", "k-stock k-stock-" + s);
      item.setAttribute("title", STOCK_NAME[s] + ": " + STOCK_ABOUT[s]);
      item.appendChild(stockIcon(doc, s));
      item.appendChild(make(doc, "span", "k-stock-name", STOCK_NAME[s]));
      const value = make(doc, "span", "k-stock-value", "0");
      const delta = make(doc, "span", "k-stock-delta");
      item.append(value, delta);
      list.appendChild(item);
      this.cells.set(s, { item, value, delta });
    }
    this.mercyItem = make(doc, "li", "k-stock k-stock-mercy");
    this.mercyItem.setAttribute("title", MERCY.name + " / " + MERCY.terror + ": " + MERCY.about);
    this.mercyItem.appendChild(stockIcon(doc, "mercy"));
    this.mercyName = make(doc, "span", "k-stock-name", MERCY.name);
    this.mercyValue = make(doc, "span", "k-stock-value", "0");
    this.mercyItem.append(this.mercyName, this.mercyValue);
    list.appendChild(this.mercyItem);
    const lines = make(doc, "p", "k-stock-lines");
    this.lasts = make(doc, "span", "k-lasts");
    this.store = make(doc, "span", "k-store");
    // K4: what the armies cost a day, beside what the stores last.
    this.burn = make(doc, "span", "k-burn");
    lines.append(this.lasts, this.store, this.burn);
    this.trouble = make(doc, "p", "k-trouble");
    this.trouble.style.display = "none";
    this.root.append(list, lines, this.trouble);
  }

  /** Read the world and write whatever changed. */
  update(world: KingdomWorld): void {
    const e = world.kingStocks;
    const yesterday = world.books[KING_PLAYER].closed;
    for (const s of LEDGER_STOCK_IDS) {
      const cell = this.cells.get(s)!;
      const v = ledgerValue(e, s);
      setText(cell.value, String(v));
      const d = yesterday ? netOf(yesterday, s) : 0;
      setText(cell.delta, d === 0 ? "" : E.deltaShort(d));
      cell.delta.className = "k-stock-delta" + (d > 0 ? " up" : d < 0 ? " down" : "");
      // The whole cell's meaning as one accessible name.
      const label = STOCK_NAME[s] + " " + v + ", " + (d === 0 ? E.noChange : E.sinceYesterday(d));
      if (cell.item.getAttribute("aria-label") !== label) cell.item.setAttribute("aria-label", label);
      // ECON: the tooltip says where yesterday's change came from (the main cause first).
      const parts = yesterday ? flowParts(yesterday, s).slice(0, 4).map(E.flowPart) : [];
      let title = E.flowTitle({ name: STOCK_NAME[s], value: v, net: d, parts }) + " " + STOCK_ABOUT[s];
      if (s === "grain") title += " " + this.grainTitle(world);
      if (cell.item.getAttribute("title") !== title) cell.item.setAttribute("title", title);
    }
    // K6: Mercy above zero, Terror below -- named by which it is, never by colour alone.
    const m = e.mercy;
    setText(this.mercyName, m >= 0 ? MERCY.name : MERCY.terror);
    setText(this.mercyValue, String(m < 0 ? -m : m));
    const ml = MERCY.label(m);
    if (this.mercyItem.getAttribute("aria-label") !== ml) this.mercyItem.setAttribute("aria-label", ml);
    setText(this.lasts, STOCK_NAME.grain + " " + E.grainLasts(grainDays(world)));
    // ECON: the realm's granary as a store -- what is in it and how much it holds.
    const gs = grainStores(world, KING_PLAYER);
    setText(this.store, " · " + E.storedOf({ grain: gs.grain, capacity: gs.capacity }) + " (" + E.granaryHolds(gs) + ")");
    const up = armyUpkeep(world, KING_PLAYER);
    setText(this.burn, armiesOf(world, KING_PLAYER).length > 0 ? " · " + AC.burnLine(up) : "");
    const lines: string[] = [];
    if (e.hunger > 0) lines.push(E.hungry(e.hunger));
    // ECON: warnings before trouble, not only after it.
    const owned = world.holdingsOf("king");
    const days = grainDays(world);
    if (e.hunger === 0 && owned.length > 0 && days < BREAD_WARNING_DAYS) lines.push(E.breadRunsOut(days));
    if (gs.heap > 0) lines.push(E.overflow({ heap: gs.heap, spoils: gs.spoilsToday }));
    const toWinter = daysUntilSeason(world.date, "winter");
    if (owned.length > 0 && toWinter > 0 && toWinter <= WINTER_WARNING_DAYS) {
      const need = dailyNeed(world, KING_PLAYER, "winter");
      // Only when the stores will not see the winter out at the winter's need.
      if (gs.grain < need * (toWinter + DAYS_PER_SEASON)) lines.push(E.winterComing({ days: toWinter, need }));
    }
    for (const h of world.holdingsOf("king")) if (h.famine > 0) lines.push(E.famineAt({ name: h.name, days: h.famine }));
    const text = lines.join(" · ");
    setText(this.trouble, text);
    this.trouble.style.display = text ? "block" : "none";
  }

  /** The grain cell's tooltip tail: the store and its granaries. */
  private grainTitle(world: KingdomWorld): string {
    const gs = grainStores(world, KING_PLAYER);
    return E.grainTitle({ stored: E.storedOf(gs), granary: E.granaryHolds(gs), spoils: gs.spoilsToday });
  }

  /** A stock's tooltip, for the tests. */
  titleOf(s: LedgerStockId): string {
    return this.cells.get(s)!.item.getAttribute("title") ?? "";
  }

  get storeText(): string {
    return this.store.textContent ?? "";
  }

  /** A stock's shown value and change, for the tests. */
  shown(s: LedgerStockId): { value: string; delta: string } {
    const c = this.cells.get(s)!;
    return { value: c.value.textContent ?? "", delta: c.delta.textContent ?? "" };
  }

  /** The Mercy/Terror cell as shown, for the tests ("Mercy 2", "Terror 3"). */
  get mercyText(): string {
    return (this.mercyName.textContent ?? "") + " " + (this.mercyValue.textContent ?? "");
  }

  get troubleText(): string {
    return this.trouble.style.display === "none" ? "" : this.trouble.textContent ?? "";
  }

  get burnText(): string {
    return this.burn.textContent ?? "";
  }

  get lastsText(): string {
    return this.lasts.textContent ?? "";
  }
}
