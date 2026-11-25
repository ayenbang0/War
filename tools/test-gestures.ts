/**
 * Gesture confusion matrix.
 *
 * Classifies the whole synthetic corpus and asserts the matrix is diagonal.
 * A per-case pass rate would look fine while hold quietly ate half of patrol;
 * only the full matrix shows which gesture is stealing from which.
 */

import { recognize, gestureLabel } from "../src/input/gestures.ts";
import { buildCorpus, type Case } from "./gesture-corpus.ts";
import { recognizeKingdom } from "../src/input/kingdom-gestures.ts";
import { buildKingdomCorpus, type KingdomCase } from "./gesture-corpus.ts";
import { KingdomWorld } from "../src/sim/kingdom/world.ts";

const LABELS = [
  "select", "move", "attack", "hold", "patrol", "retreat",
  "formation:line", "formation:column", "formation:wedge", "formation:square",
  "split", "grid", "patrolArea", "recover", "ambush", "feint",
] as const;

function actualLabel(c: Case): string {
  const r = recognize(c.points, c.ctx);
  if (!r) return "none";
  if (r.kind === "formation") return "formation:" + r.shape;
  if (
    r.kind === "split" || r.kind === "grid" || r.kind === "patrolArea" ||
    r.kind === "recover" || r.kind === "ambush" || r.kind === "feint"
  ) {
    return r.kind;
  }
  return gestureLabel(r);
}

export type MatrixReport = {
  total: number;
  correct: number;
  offDiagonal: { expected: string; actual: string; note: string }[];
  matrix: Map<string, Map<string, number>>;
};

export function runConfusionMatrix(): MatrixReport {
  const corpus = buildCorpus();
  const matrix = new Map<string, Map<string, number>>();
  for (const l of LABELS) matrix.set(l, new Map());

  let correct = 0;
  const offDiagonal: { expected: string; actual: string; note: string }[] = [];

  for (const c of corpus) {
    const actual = actualLabel(c);
    const row = matrix.get(c.expected);
    if (row) row.set(actual, (row.get(actual) ?? 0) + 1);
    if (actual === c.expected) correct++;
    else offDiagonal.push({ expected: c.expected, actual, note: c.note });
  }

  return { total: corpus.length, correct, offDiagonal, matrix };
}

export function printMatrix(report: MatrixReport): void {
  const short = (s: string): string => s.replace("formation:", "f:");
  const cols = LABELS.map(short);
  const width = 8;
  console.log("");
  console.log(
    "  " + "expected".padEnd(14) + cols.map((c) => c.slice(0, width - 1).padStart(width)).join(""),
  );
  for (const l of LABELS) {
    const row = report.matrix.get(l);
    if (!row) continue;
    const cells = LABELS.map((a) => {
      const n = row.get(a) ?? 0;
      if (n === 0) return ".".padStart(width);
      return (l === a ? String(n) : String(n) + "!").padStart(width);
    });
    console.log("  " + short(l).padEnd(14) + cells.join(""));
  }
  const stray = new Map<string, number>();
  for (const row of report.matrix.values()) {
    for (const [a, n] of row) {
      if (!(LABELS as readonly string[]).includes(a)) stray.set(a, (stray.get(a) ?? 0) + n);
    }
  }
  for (const [a, n] of stray) console.log("  (also classified as " + a + ": " + n + ")");
}

// -- the kingdom map (K2) -------------------------------------------------------

export const KINGDOM_LABELS = [
  "tapToken", "tapHolding", "march",
  "none:nothing-there", "none:closed-shape", "none:not-from-king", "none:no-destination", "none:already-there",
] as const;

/**
 * The kingdom label of a case: the gesture's kind, or none with its reason.
 * A tap or march at the WRONG holding is its own column ("march?"), so a
 * march that lands on the neighbour shows as a miss, not as a march.
 */
function kingdomActual(c: KingdomCase): string {
  const g = recognizeKingdom(c.points, c.ctx);
  const nameOf = (id: number): string => {
    const h = c.ctx.holdings.find((x) => x.id === id);
    return h ? String(h.id) : "?";
  };
  const [kind, target] = c.expected.split(":");
  switch (g.kind) {
    case "none":
      return "none:" + g.reason;
    case "tapToken":
      return "tapToken";
    case "tapHolding":
      return kind === "tapHolding" && targetId(c, target) === g.holding ? "tapHolding" : "tapHolding?" + nameOf(g.holding);
    case "march":
      return kind === "march" && targetId(c, target) === g.to ? "march" : "march?" + nameOf(g.to);
  }
}

/** Corpus cases name their holding; the context only carries ids, in map order. */
let holdingIds: Map<string, number> | null = null;
function targetId(_c: KingdomCase, name: string | undefined): number {
  if (!holdingIds) {
    holdingIds = new Map();
    const w = new KingdomWorld({ seed: 7 });
    for (const h of w.holdings) holdingIds.set(h.name, h.id);
  }
  return name ? holdingIds.get(name) ?? -1 : -1;
}

/** The expected column of a case: its label without the holding's name. */
function kingdomExpected(c: KingdomCase): string {
  const [kind, rest] = c.expected.split(":");
  return kind === "none" ? "none:" + rest : kind;
}

export function runKingdomConfusionMatrix(): MatrixReport {
  const corpus = buildKingdomCorpus();
  const matrix = new Map<string, Map<string, number>>();
  for (const l of KINGDOM_LABELS) matrix.set(l, new Map());
  let correct = 0;
  const offDiagonal: { expected: string; actual: string; note: string }[] = [];
  for (const c of corpus) {
    const expected = kingdomExpected(c);
    const actual = kingdomActual(c);
    const row = matrix.get(expected);
    if (row) row.set(actual, (row.get(actual) ?? 0) + 1);
    if (actual === expected) correct++;
    else offDiagonal.push({ expected: c.expected, actual, note: c.note });
  }
  return { total: corpus.length, correct, offDiagonal, matrix };
}

export function printKingdomMatrix(report: MatrixReport): void {
  const short = (s: string): string => s.replace("none:", "-").replace("nothing-there", "nothing")
    .replace("closed-shape", "closed").replace("not-from-king", "notking").replace("no-destination", "nodest")
    .replace("already-there", "already");
  const width = 11;
  console.log("");
  console.log("  " + "expected".padEnd(14) + KINGDOM_LABELS.map((c) => short(c).padStart(width)).join(""));
  for (const l of KINGDOM_LABELS) {
    const row = report.matrix.get(l);
    if (!row) continue;
    const cells = KINGDOM_LABELS.map((a) => {
      const n = row.get(a) ?? 0;
      if (n === 0) return ".".padStart(width);
      return (l === a ? String(n) : String(n) + "!").padStart(width);
    });
    console.log("  " + short(l).padEnd(14) + cells.join(""));
  }
  for (const row of report.matrix.values()) {
    for (const [a, n] of row) {
      if (!(KINGDOM_LABELS as readonly string[]).includes(a)) console.log("  (also classified as " + a + ": " + n + ")");
    }
  }
}
