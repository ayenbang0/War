/**
 * The pen's own layer: the wet stroke, and the ghost preview of what the
 * recognizer currently thinks it means.
 *
 * The preview is not a convenience -- it is what makes pure shape recognition
 * usable. Six gestures inferred from freehand strokes will occasionally read as
 * the wrong one, and without seeing the interpretation before releasing, a
 * player has no way to tell a misread from a misdraw. Spec section 11.2 asks
 * for exactly this: recognized gestures highlighted, errors gently corrected.
 * It is not a UI button, so it does not breach the pen-only rule.
 */

import type { Point, Recognized } from "../input/gestures.ts";
import type { PenGhost } from "../input/commander.ts";
import type { Camera } from "./camera.ts";
import { ink, sideColor } from "./palette.ts";
import { motion } from "./motion.ts";

/** The ghost's label size, in CSS px: the canvas text floor (ui-policy.md). */
const LABEL_PX = 14;
/** How long a stroke that meant nothing stays on the map, fading, in ms. */
export const REJECT_FADE_MS = 900;
/** Ink for a stroke that reads as nothing: a muted grey, not an alarm. */
const NOTHING = "#7d7362";
/** An armed ability's ghost. */
const ABILITY_INK = "#7a4a1e";

/** A stroke the Commander refused, left to fade (audit PC-02). */
export type RejectedStroke = { readonly points: readonly Point[]; readonly why: string; readonly at: number };

/** Colour per interpretation, so intent is readable before the pen lifts. */
const GESTURE_COLOR: Record<string, string> = {
  select: "#5a6b7d",
  move: "#3b5f8a",
  attack: "#8c3a34",
  hold: "#6b5a2f",
  patrol: "#4a6b52",
  retreat: "#7a5230",
  formation: "#5b4a7a",
  split: "#8a5a2b",
  grid: "#3f6b74",
  patrolArea: "#4a6b52",
  recover: "#9c3f63",
};

/**
 * Draw the pen's layer: the held split rail, a refused stroke fading out, and
 * the stroke in progress with the ghost of what it will do.
 *
 * `ghost` comes from the Commander, which is the one place that knows what a
 * stroke will actually do -- an armed ability takes it whatever its shape, a
 * deployment drag carries a company, a loop takes so many men -- so the
 * preview cannot promise one thing and the commit do another (PC-03, PC-07).
 */
export function drawInk(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  points: readonly Point[],
  ghost: PenGhost | null,
  pendingRail: { a: Point; b: Point } | null = null,
  rejected: RejectedStroke | null = null,
  nowMs = 0,
): void {
  if (rejected) drawRejected(ctx, cam, rejected, nowMs);
  // A held split rail stays on the map so the player can see what a second,
  // parallel line would pair with.
  if (pendingRail) {
    ctx.save();
    ctx.strokeStyle = GESTURE_COLOR.split;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(cam.worldToScreenX(pendingRail.a.x), cam.worldToScreenY(pendingRail.a.y));
    ctx.lineTo(cam.worldToScreenX(pendingRail.b.x), cam.worldToScreenY(pendingRail.b.y));
    ctx.stroke();
    ctx.restore();
  }
  if (points.length === 0) return;
  const color = !ghost ? ink
    : ghost.mode === "order" ? (GESTURE_COLOR[ghost.read.kind] ?? ink)
      : ghost.mode === "ability" ? ABILITY_INK
        : ghost.mode === "place" ? (ghost.ok ? sideColor("friend") : NOTHING)
          : NOTHING;

  // The raw stroke, drawn wet.
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // A stroke that so far means nothing is drawn dashed as well as grey, so
  // "no order" reads without relying on the colour (PC-02).
  if (ghost && ghost.mode === "none") ctx.setLineDash([6, 5]);
  strokePath(ctx, cam, points, 0, 0);
  ctx.restore();

  if (!ghost) return;
  const tip = points[points.length - 1];
  if (ghost.mode === "order") drawGhost(ctx, cam, points, ghost.read, color);
  else if (ghost.mode === "ability") {
    // The footprint the ability will land with, at the pen tip: this stroke
    // spends it, whatever shape it has (PC-03).
    ctx.save();
    ctx.strokeStyle = ABILITY_INK;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(cam.worldToScreenX(tip.x), cam.worldToScreenY(tip.y), Math.max(10, ghost.radius * cam.zoom), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  drawLabel(ctx, cam, tip, ghost.label.toUpperCase(), color, ghost.mode === "none");
}

function strokePath(ctx: CanvasRenderingContext2D, cam: Camera, points: readonly Point[], ox: number, oy: number): void {
  ctx.beginPath();
  ctx.moveTo(cam.worldToScreenX(points[0].x) + ox, cam.worldToScreenY(points[0].y) + oy);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(cam.worldToScreenX(points[i].x) + ox, cam.worldToScreenY(points[i].y) + oy);
  }
  ctx.stroke();
}

/**
 * A refused stroke: it greys, gives a small sideways shake -- a head shaken,
 * not an alarm -- and fades over a second, with the reason beside it. With
 * motion reduced it only greys and fades.
 */
function drawRejected(ctx: CanvasRenderingContext2D, cam: Camera, r: RejectedStroke, nowMs: number): void {
  if (r.points.length === 0) return;
  const t = (nowMs - r.at) / REJECT_FADE_MS;
  if (t < 0 || t >= 1) return;
  const shake = motion.reduced || t > 0.35 ? 0 : Math.sin(t * 60) * 3 * (1 - t / 0.35);
  ctx.save();
  ctx.strokeStyle = NOTHING;
  ctx.globalAlpha = 0.55 * (1 - t);
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.setLineDash([6, 5]);
  strokePath(ctx, cam, r.points, shake, 0);
  ctx.restore();
  if (r.why) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, 1.6 * (1 - t));
    drawLabel(ctx, cam, r.points[r.points.length - 1], r.why.toUpperCase(), NOTHING, true);
    ctx.restore();
  }
}

/** A label pinned beside the pen tip, on a parchment plate. */
function drawLabel(
  ctx: CanvasRenderingContext2D, cam: Camera, tip: Point, text: string, color: string, quiet: boolean,
): void {
  const lx = cam.worldToScreenX(tip.x) + 14;
  const ly = cam.worldToScreenY(tip.y) - 12;
  ctx.save();
  ctx.font = (quiet ? "500 " : "600 ") + LABEL_PX + "px ui-monospace, Menlo, monospace";
  const w = ctx.measureText(text).width;
  ctx.globalAlpha *= 0.94;
  ctx.fillStyle = "rgba(243, 236, 219, 0.95)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash(quiet ? [3, 3] : []);
  ctx.beginPath();
  ctx.rect(lx - 5, ly - LABEL_PX - 1, w + 10, LABEL_PX + 7);
  ctx.fill();
  ctx.stroke();
  // Label text is drawn in a darkened ink of the ghost's colour family: the
  // light gesture inks alone do not reach 4.5:1 on the parchment plate.
  ctx.fillStyle = quiet ? "#4f4636" : "#2e261b";
  ctx.fillText(text, lx, ly);
  ctx.restore();
}

/** The interpreted order, drawn over the raw stroke as it will be executed. */
function drawGhost(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  points: readonly Point[],
  preview: Recognized,
  color: string,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.95;

  if (preview.kind === "patrolArea") {
    ctx.setLineDash([9, 6]);
    ctx.beginPath();
    ctx.arc(
      cam.worldToScreenX(preview.x),
      cam.worldToScreenY(preview.y),
      Math.max(12, preview.radius * cam.zoom),
      0,
      Math.PI * 2,
    );
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(
      cam.worldToScreenX(preview.x),
      cam.worldToScreenY(preview.y),
      Math.max(8, preview.radius * 0.62 * cam.zoom),
      0,
      Math.PI * 2,
    );
    ctx.globalAlpha = 0.4;
    ctx.stroke();
    ctx.globalAlpha = 0.95;
  } else if (preview.kind === "split") {
    // Draw the cut, and ring the squads that survive it.
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(cam.worldToScreenX(preview.line[0]), cam.worldToScreenY(preview.line[1]));
    ctx.lineTo(cam.worldToScreenX(preview.line[2]), cam.worldToScreenY(preview.line[3]));
    ctx.stroke();
  } else if (preview.kind === "grid") {
    ctx.setLineDash([]);
    for (let i = 0; i < preview.places.length; i += 2) {
      const px = cam.worldToScreenX(preview.places[i]);
      const py = cam.worldToScreenY(preview.places[i + 1]);
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (preview.kind === "hold") {
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.arc(
      cam.worldToScreenX(preview.x),
      cam.worldToScreenY(preview.y),
      Math.max(10, preview.radius * cam.zoom),
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  } else if (preview.kind === "move" || preview.kind === "attack" || preview.kind === "retreat" || preview.kind === "patrol") {
    const path = preview.path;
    if (path.length >= 2) {
      ctx.setLineDash(preview.kind === "attack" ? [] : [8, 5]);
      ctx.beginPath();
      ctx.moveTo(cam.worldToScreenX(points[0].x), cam.worldToScreenY(points[0].y));
      for (let i = 0; i < path.length; i += 2) {
        ctx.lineTo(cam.worldToScreenX(path[i]), cam.worldToScreenY(path[i + 1]));
      }
      if (preview.kind === "patrol") ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      // Mark the simplified vertices: this is the cleaned-up route the squad
      // will actually walk, not the scribble.
      for (let i = 0; i < path.length; i += 2) {
        ctx.beginPath();
        ctx.arc(cam.worldToScreenX(path[i]), cam.worldToScreenY(path[i + 1]), 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.restore();
}
