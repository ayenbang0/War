/**
 * Gesture confusion matrix.
 *
 * Classifies the whole synthetic corpus and asserts the matrix is diagonal.
 * A per-case pass rate would look fine while hold quietly ate half of patrol;
 * only the full matrix shows which gesture is stealing from which.
 */

import { recognize, gestureLabel } from "../src/input/gestures.ts";
import { buildCorpus, type Case } from "./gesture-corpus.ts";

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
