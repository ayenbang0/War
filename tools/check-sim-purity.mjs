/**
 * Enforces the determinism and layering rules from CLAUDE.md.
 *
 * These invariants are the kind that get violated quietly months later, by
 * someone reaching for Math.random or importing a renderer helper into the sim
 * for convenience. A grep-level check catches that in CI in milliseconds.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SIM_DIR = join(ROOT, "src", "sim");
const MATH_FILE = join(SIM_DIR, "math.ts");

/** Math members ECMA-262 specifies exactly; safe to use inside math.ts only. */
const EXACT_MATH = new Set([
  "floor", "ceil", "abs", "sqrt", "min", "max", "round", "trunc", "sign", "imul",
]);

const BANNED_GLOBALS = [
  ["Math.random", "seedless and unreproducible -- use sim/rng.ts"],
  ["Date.now", "wall-clock time -- the tick counter is the only clock"],
  ["performance.now", "wall-clock time -- the tick counter is the only clock"],
  ["setTimeout", "the sim advances only via step()"],
  ["setInterval", "the sim advances only via step()"],
  ["requestAnimationFrame", "rendering concern; forbidden in sim/"],
  ["document.", "no DOM in sim/"],
  ["window.", "no browser globals in sim/"],
  ["getContext", "no rendering in sim/"],
];

const FORBIDDEN_LAYERS = /(^|\/)(render|input|net)\//;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Drop comments, so prose explaining a rule never trips that rule. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Additionally blank string literals, for checks that scan for identifiers. */
function stripStrings(src) {
  return src
    .replace(/"[^"\n]*"/g, '""')
    .replace(/'[^'\n]*'/g, "''")
    .replace(/`[^`]*`/g, "``");
}

const violations = [];
const files = walk(SIM_DIR);

for (const file of files) {
  const raw = readFileSync(file, "utf8");
  // Import specifiers live inside string literals, so the import scan must run
  // on decommented-but-unblanked source. Scanning the fully stripped text
  // silently matches nothing -- which is exactly how this check sat dead.
  const decommented = stripComments(raw);
  const code = stripStrings(decommented);
  const rel = relative(ROOT, file).split(sep).join("/");
  const isMathFile = file === MATH_FILE;

  for (const [needle, why] of BANNED_GLOBALS) {
    if (code.includes(needle)) violations.push(rel + ": uses " + needle + " -- " + why);
  }

  for (const m of code.matchAll(/\bMath\s*\.\s*([A-Za-z0-9_]+)/g)) {
    const member = m[1];
    if (!isMathFile) {
      violations.push(
        rel + ": references Math." + member +
          " -- only src/sim/math.ts may touch Math; import from it instead",
      );
    } else if (!EXACT_MATH.has(member)) {
      violations.push(
        rel + ": Math." + member +
          " is implementation-approximated and differs between JS engines -- implement it from arithmetic instead",
      );
    }
  }

  for (const m of decommented.matchAll(/\bfrom\s*["']([^"'\n]+)["']/g)) {
    const spec = m[1];
    if (FORBIDDEN_LAYERS.test(spec)) {
      violations.push(rel + ": imports " + spec + " -- sim/ must not depend on that layer");
    }
  }
}

if (violations.length > 0) {
  console.error("sim purity check FAILED\n");
  for (const v of violations) console.error("  " + v);
  console.error("\n" + violations.length + " violation(s). See CLAUDE.md.");
  process.exit(1);
}

console.log("sim purity check passed (" + files.length + " files in src/sim/)");
