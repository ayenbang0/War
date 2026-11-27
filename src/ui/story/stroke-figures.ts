/**
 * K9: "what to draw" -- a small inked figure of the stroke a tutorial step
 * asks for (the owner: each step "shows what to draw").
 *
 * One SVG per pen class, battle and kingdom alike: the company (or army) as a
 * counter, the stroke as an ink line with its end marked, so the shape is
 * seen before it is drawn. Plain path data in a 120 x 80 box; the coach puts
 * it in the DOM with a text description beside it, because a picture alone is
 * not an instruction (game-ui-ux: never meaning by image only).
 */

import type { TutorialSuccess } from "../../content/story/tutorial.ts";

/** A company or army counter, at (x, y). */
const counter = (x: number, y: number, enemy = false): string =>
  `<rect x="${x - 10}" y="${y - 6}" width="20" height="12" rx="2" class="${enemy ? "fig-enemy" : "fig-own"}"/>`;
const stroke = (d: string): string => `<path d="${d}" class="fig-ink"/>`;
const dot = (x: number, y: number): string => `<circle cx="${x}" cy="${y}" r="3" class="fig-end"/>`;
const heart = (cx: number, cy: number, s: number): string =>
  stroke(`M${cx} ${cy + s} C${cx - s * 1.6} ${cy - s * 0.2} ${cx - s * 0.7} ${cy - s * 1.4} ${cx} ${cy - s * 0.5} C${cx + s * 0.7} ${cy - s * 1.4} ${cx + s * 1.6} ${cy - s * 0.2} ${cx} ${cy + s}`);
const ring = (cx: number, cy: number, r: number): string => `<circle cx="${cx}" cy="${cy}" r="${r}" class="fig-ink"/>`;

/** The figure's SVG body (no wrapper) for a step's success, or null where there is no stroke to draw. */
export function strokeFigure(s: TutorialSuccess): string | null {
  if (s.kind === "gesture") {
    switch (s.class) {
      case "lasso":
        if (s.detail === "carve") return counter(50, 40) + counter(62, 40) + stroke("M38 30 C30 40 38 52 52 50 C60 48 60 30 50 28 C44 27 40 28 38 30");
        if (s.detail === "group") return counter(40, 40) + counter(80, 40) + ring(60, 40, 32);
        return `<g class="fig-men">${[34, 44, 54, 64, 74].map((x) => `<circle cx="${x}" cy="40" r="2"/>`).join("")}</g>` + stroke("M28 40 C28 22 80 22 82 40 C84 58 28 58 28 40");
      case "select":
        return s.detail === "cleared" ? counter(40, 40) + dot(90, 40) : counter(60, 40) + dot(60, 40);
      case "move": return counter(20, 40) + stroke("M20 40 C50 30 80 50 105 38") + dot(105, 38);
      case "attack": return counter(20, 40) + counter(100, 40, true) + stroke("M20 40 L100 40") + dot(100, 40);
      case "retreat": return counter(60, 25) + stroke("M60 25 L60 72") + dot(60, 72) + `<text x="64" y="76" class="fig-label">your edge</text>`;
      case "hold": return ring(60, 40, 10);
      case "patrol": return ring(60, 40, 30);
      case "patrolArea": return counter(45, 40) + counter(75, 40) + ring(60, 40, 34);
      case "formation":
        switch (s.shape) {
          case "column": return counter(60, 40) + stroke("M60 26 L60 54") + dot(60, 54);
          case "wedge": return counter(60, 40) + stroke("M44 50 L60 30 L76 50") + dot(76, 50);
          case "square": return counter(60, 40) + stroke("M52 32 L68 32 L68 48 L52 48 Z");
          default: return counter(60, 40) + stroke("M44 40 L76 40") + dot(76, 40);
        }
      case "feint": return counter(20, 40) + stroke("M20 40 L90 40") + stroke("M90 46 L28 46") + dot(28, 46);
      case "ambush": return counter(60, 40) + stroke("M40 48 L50 32 L60 48 L70 32 L80 48") + dot(80, 48);
      case "split": return counter(40, 30) + counter(40, 52) + stroke("M70 15 L70 68") + dot(70, 68);
      case "grid": return counter(30, 40) + counter(46, 40) + stroke("M70 15 L70 68") + stroke("M90 15 L90 68") + dot(90, 68);
      case "recover": return counter(60, 44) + heart(60, 40, 18);
    }
  }
  if (s.kind === "kingdomGesture") {
    switch (s.class) {
      case "tapHolding": return ring(60, 40, 8) + dot(60, 40);
      case "tapToken": return counter(60, 34) + dot(60, 34);
      case "march": return counter(20, 40) + ring(100, 40, 6) + stroke("M20 40 C50 28 80 52 100 40") + dot(100, 40);
      case "intercept": return counter(20, 40) + counter(100, 40, true) + stroke("M20 40 L100 40") + dot(100, 40);
      case "garrison": return counter(60, 40) + ring(60, 40, 16);
      case "patrol": return ring(35, 40, 5) + ring(85, 40, 5) + ring(60, 20, 5) + ring(60, 40, 34);
      case "split": return counter(60, 40) + stroke("M36 40 L84 40") + dot(84, 40);
      case "merge": return counter(25, 40) + counter(95, 40) + stroke("M25 40 L95 40") + dot(95, 40);
      case "recover": return counter(60, 44) + heart(60, 40, 18);
    }
  }
  return null;
}

/** The figure as a whole SVG document, its own styles inside (it is shown as an image). */
export function strokeFigureSvg(s: TutorialSuccess): string | null {
  const body = strokeFigure(s);
  if (body === null) return null;
  // Ink on parchment, the counters in the map's own colours; 7:1 and better.
  const style = "<style>.fig-ink{fill:none;stroke:#2e4a6d;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}" +
    ".fig-own{fill:#f2ead6;stroke:#3f3527;stroke-width:1.5}.fig-enemy{fill:#e6c9c0;stroke:#7a2a1f;stroke-width:1.5}" +
    ".fig-end{fill:#2e4a6d}.fig-men circle{fill:#3f3527}.fig-label{font:9px Georgia,serif;fill:#3f3527}</style>";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80" width="120" height="80"><rect width="120" height="80" fill="#efe6cf"/>${style}${body}</svg>`;
}
