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
import { gestureLabel } from "../input/gestures.ts";
import type { Camera } from "./camera.ts";
import { ink } from "./palette.ts";

/** Colour per interpretation, so intent is readable before the pen lifts. */
const GESTURE_COLOR: Record<string, string> = {
  select: "#5a6b7d",
  move: "#3b5f8a",
  attack: "#8c3a34",
  hold: "#6b5a2f",
  patrol: "#4a6b52",
  retreat: "#7a5230",
  formation: "#5b4a7a",
};

export function drawInk(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  points: readonly Point[],
  preview: Recognized | null,
): void {
  if (points.length === 0) return;
  const color = preview ? (GESTURE_COLOR[preview.kind] ?? ink) : ink;

  // The raw stroke, drawn wet.
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cam.worldToScreenX(points[0].x), cam.worldToScreenY(points[0].y));
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(cam.worldToScreenX(points[i].x), cam.worldToScreenY(points[i].y));
  }
  ctx.stroke();
  ctx.restore();

  if (!preview) return;
  drawGhost(ctx, cam, points, preview, color);
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

  if (preview.kind === "hold") {
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

  // Label, pinned at the pen tip.
  const tip = points[points.length - 1];
  const lx = cam.worldToScreenX(tip.x) + 14;
  const ly = cam.worldToScreenY(tip.y) - 12;
  const text = gestureLabel(preview).toUpperCase();
  ctx.font = "600 11px ui-monospace, Menlo, monospace";
  const w = ctx.measureText(text).width;
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = "rgba(243, 236, 219, 0.94)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(lx - 5, ly - 12, w + 10, 17);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(text, lx, ly);
  ctx.restore();
}
