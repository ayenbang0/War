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

import { LEDGER_STOCK_IDS, type LedgerStockId } from "../../content/kingdom/economy.ts";
import { E, STOCK_ABOUT, STOCK_NAME } from "../../content/kingdom/ui-strings.ts";
import { KING_PLAYER } from "../../content/kingdom/factions.ts";
import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import { ledgerValue, netOf } from "../../sim/kingdom/ledger.ts";
import { storageOf } from "../../sim/kingdom/economy.ts";
import { stockIcon } from "./icons.ts";

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

type Cell = { readonly item: HTMLElement; readonly value: HTMLElement; readonly delta: HTMLElement };

export class ResourcesBar {
  readonly root: HTMLElement;
  private readonly cells = new Map<LedgerStockId, Cell>();
  private readonly lasts: HTMLElement;
  private readonly store: HTMLElement;
  private readonly trouble: HTMLElement;

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
    const lines = make(doc, "p", "k-stock-lines");
    this.lasts = make(doc, "span", "k-lasts");
    this.store = make(doc, "span", "k-store");
    lines.append(this.lasts, this.store);
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
    }
    setText(this.lasts, STOCK_NAME.grain + " " + E.grainLasts(grainDays(world)));
    const st = storageOf(world, KING_PLAYER);
    setText(this.store, " · " + E.grainStore(st.granary + st.loose));
    const lines: string[] = [];
    if (e.hunger > 0) lines.push(E.hungry(e.hunger));
    for (const h of world.holdingsOf("king")) if (h.famine > 0) lines.push(E.famineAt({ name: h.name, days: h.famine }));
    const text = lines.join(" · ");
    setText(this.trouble, text);
    this.trouble.style.display = text ? "block" : "none";
  }

  /** A stock's shown value and change, for the tests. */
  shown(s: LedgerStockId): { value: string; delta: string } {
    const c = this.cells.get(s)!;
    return { value: c.value.textContent ?? "", delta: c.delta.textContent ?? "" };
  }

  get troubleText(): string {
    return this.trouble.style.display === "none" ? "" : this.trouble.textContent ?? "";
  }

  get lastsText(): string {
    return this.lasts.textContent ?? "";
  }
}
