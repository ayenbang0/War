/**
 * The kingdom ledger: every change to every stock, by category, per faction
 * per day (PLAN.md §B.3; docs/kingdom.md "K3").
 *
 * There is exactly ONE way to change a stock -- `credit` or `debit` here -- and
 * both write the ledger as they go. Nothing else in the sim assigns to a
 * stock. So for every faction, stock and day:
 *
 *     end = start + Σ sources − Σ sinks        (exactly: stocks are integers)
 *
 * and a debit can never take a stock below zero (it throws: that is a sim
 * bug, never a game state). tools/kingdom-economy.ts holds every day of a
 * multi-year run to both.
 *
 * A "day" of the ledger runs from the first tick of a day (before that day's
 * economy) to the first tick of the next, so it covers the day boundary's
 * economy AND the orders applied during the day (seed, construction). The
 * book keeps the day being written (`open`) and the last day closed
 * (`closed`), which is what the resources bar's "since yesterday" reads.
 * Older days are not kept: the save would grow without bound, and a test
 * that wants history reads each day as it closes.
 */

import {
  LEDGER_CATEGORIES, LEDGER_CATEGORY_IDS, LEDGER_STOCK_IDS, LEGITIMACY_MAX, STOCK_IDS,
  type LedgerCategoryId, type LedgerStockId, type StockId,
} from "../../content/kingdom/economy.ts";
import { min } from "../math.ts";
import type { FactionEconomy } from "./state.ts";

const NS = LEDGER_STOCK_IDS.length;
const NC = LEDGER_CATEGORY_IDS.length;

export type LedgerDay = {
  /** The day (calendar day index) this page is for. */
  day: number;
  /** Each ledger stock at the start of the day, LEDGER_STOCK_IDS order. */
  readonly start: number[];
  /**
   * Flow per stock per category, flattened: index = stock * categories +
   * category. Always >= 0; the category's direction says whether it added or took.
   */
  readonly flow: number[];
};

export type FactionBook = {
  open: LedgerDay;
  /** The last finished day, or null before the first day boundary. */
  closed: LedgerDay | null;
};

export function stockIndex(s: LedgerStockId): number {
  return LEDGER_STOCK_IDS.indexOf(s);
}

export function categoryIndex(c: LedgerCategoryId): number {
  return LEDGER_CATEGORY_IDS.indexOf(c);
}

export function categoryDir(c: LedgerCategoryId): "source" | "sink" {
  return LEDGER_CATEGORIES[categoryIndex(c)].dir;
}

/** Current value of a ledger stock (a stock or legitimacy). */
export function ledgerValue(e: FactionEconomy, s: LedgerStockId): number {
  return s === "legitimacy" ? e.legitimacy : e.stocks[s];
}

export function snapshotStocks(e: FactionEconomy): number[] {
  return LEDGER_STOCK_IDS.map((s) => ledgerValue(e, s));
}

export function newLedgerDay(day: number, e: FactionEconomy): LedgerDay {
  return { day, start: snapshotStocks(e), flow: new Array<number>(NS * NC).fill(0) };
}

/** Flow of one stock in one category on a ledger day. */
export function flowOf(d: LedgerDay, s: LedgerStockId, c: LedgerCategoryId): number {
  return d.flow[stockIndex(s) * NC + categoryIndex(c)];
}

/** Net change of a stock over a ledger day: Σ sources − Σ sinks. */
export function netOf(d: LedgerDay, s: LedgerStockId): number {
  const si = stockIndex(s);
  let n = 0;
  for (let c = 0; c < NC; c++) {
    const v = d.flow[si * NC + c];
    n += LEDGER_CATEGORIES[c].dir === "source" ? v : -v;
  }
  return n;
}

function record(book: FactionBook, s: LedgerStockId, c: LedgerCategoryId, amount: number): void {
  book.open.flow[stockIndex(s) * NC + categoryIndex(c)] += amount;
}

function assertWhole(amount: number, what: string): void {
  if (!(Number.isInteger(amount) && amount >= 0)) throw new Error("ledger: " + what + " must be a whole number >= 0, got " + amount);
}

/**
 * Add `amount` of a stock under a SOURCE category. Returns what was added
 * (all of it). Amount 0 is a no-op and records nothing.
 */
export function credit(e: FactionEconomy, book: FactionBook, s: StockId, amount: number, c: LedgerCategoryId): number {
  assertWhole(amount, "credit of " + s);
  if (categoryDir(c) !== "source") throw new Error("ledger: " + c + " is not a source");
  if (amount === 0) return 0;
  e.stocks[s] += amount;
  record(book, s, c, amount);
  return amount;
}

/**
 * Take `amount` of a stock under a SINK category. Taking more than there is
 * is a sim bug and throws; callers that may be short use `debitUpTo`.
 */
export function debit(e: FactionEconomy, book: FactionBook, s: StockId, amount: number, c: LedgerCategoryId): number {
  assertWhole(amount, "debit of " + s);
  if (categoryDir(c) !== "sink") throw new Error("ledger: " + c + " is not a sink");
  if (amount > e.stocks[s]) throw new Error("ledger: debit of " + amount + " " + s + " from " + e.stocks[s]);
  if (amount === 0) return 0;
  e.stocks[s] -= amount;
  record(book, s, c, amount);
  return amount;
}

/** Take as much of `amount` as there is. Returns what was taken. */
export function debitUpTo(e: FactionEconomy, book: FactionBook, s: StockId, amount: number, c: LedgerCategoryId): number {
  return debit(e, book, s, min(amount, e.stocks[s]), c);
}

/** Can the faction pay all of `cost` now? */
export function canAfford(e: FactionEconomy, cost: Readonly<Partial<Record<StockId, number>>>): boolean {
  for (const s of STOCK_IDS) if ((cost[s] ?? 0) > e.stocks[s]) return false;
  return true;
}

/** Pay a whole cost under one category. Check `canAfford` first. */
export function pay(e: FactionEconomy, book: FactionBook, cost: Readonly<Partial<Record<StockId, number>>>, c: LedgerCategoryId): void {
  for (const s of STOCK_IDS) debit(e, book, s, cost[s] ?? 0, c);
}

/** Receive a whole bundle under one category. */
export function receive(e: FactionEconomy, book: FactionBook, gains: Readonly<Partial<Record<StockId, number>>>, c: LedgerCategoryId): void {
  for (const s of STOCK_IDS) credit(e, book, s, gains[s] ?? 0, c);
}

/**
 * THE entry point for legitimacy (K6 writes the rules that call it): move it
 * by `delta`, kept within 0..LEGITIMACY_MAX, under a source category for a
 * rise and a sink for a fall. Returns the change actually made after clamping.
 */
export function adjustLegitimacy(e: FactionEconomy, book: FactionBook, delta: number, c: LedgerCategoryId): number {
  if (!Number.isInteger(delta)) throw new Error("ledger: legitimacy moves in whole points");
  const want = categoryDir(c) === "source" ? 1 : -1;
  if (delta !== 0 && (delta > 0 ? 1 : -1) !== want) throw new Error("ledger: " + c + " cannot move legitimacy that way");
  const next = delta > 0 ? min(LEGITIMACY_MAX, e.legitimacy + delta) : e.legitimacy + delta < 0 ? 0 : e.legitimacy + delta;
  const moved = next - e.legitimacy;
  if (moved === 0) return 0;
  e.legitimacy = next;
  record(book, "legitimacy", c, moved > 0 ? moved : -moved);
  return moved;
}

/** Close the open day and open the next. */
export function turnPage(book: FactionBook, day: number, e: FactionEconomy): void {
  book.closed = book.open;
  book.open = newLedgerDay(day, e);
}
