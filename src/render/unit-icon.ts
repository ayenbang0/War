/**
 * A unit type drawn as a standalone counter, for menus and legends.
 *
 * This exists so the point-buy screen can show what it is selling. Reading
 * "Skirmishers -- fast, lightly armed harassers" tells you nothing about the
 * dart-shaped thing you will be looking for on the field two minutes later.
 *
 * It deliberately calls the SAME bodyPath/detailPath the battlefield renderer
 * calls. Hand-drawing a second set of menu icons would be two sources of truth
 * for one silhouette, and the day someone retunes the archer's bow the menu
 * would quietly start lying about it.
 */

import { SIZE, bodyPath, detailPath, type Brush } from "./soldier-art.ts";
import { ink, playerColor } from "./palette.ts";
import type { UnitTypeId } from "../content/unit-types.ts";

/**
 * Sizes are NOT normalised per type. A siege engine looms over a scout in the
 * menu exactly as it will on the field, because relative bulk is real
 * information about what you are buying.
 */
export function drawUnitIcon(
  ctx: CanvasRenderingContext2D, type: UnitTypeId, size: number, player = 0,
): void {
  // Largest type is siege at 1.6, and its body is the widest thing drawn
  // (box side 1.0), so it sets the scale: 0.26 * 1.6 * 2 leaves a little air
  // in the box. Everything else lands smaller, which is the intent.
  const r = size * 0.26 * SIZE[type];
  const brush: Brush = {
    ctx,
    x: size / 2,
    y: size / 2,
    // Facing right: the menu reads left-to-right, so should the counter.
    a: 0,
    r,
    // Weapon at rest. A menu icon caught mid-swing reads as a glitch.
    recover: 1,
    t: 0,
    phase: 0,
  };

  ctx.save();
  ctx.beginPath();
  bodyPath(type, brush);
  ctx.fillStyle = playerColor[player] ?? ink;
  ctx.fill();
  ctx.strokeStyle = "rgba(35, 28, 18, 0.5)";
  ctx.lineWidth = 0.8;
  ctx.stroke();

  ctx.beginPath();
  detailPath(type, brush);
  ctx.strokeStyle = "rgba(28, 22, 14, 0.72)";
  ctx.lineWidth = Math.max(0.9, r * 0.16);
  ctx.stroke();
  ctx.restore();
}

/** The same counter as a ready-to-insert element, at device resolution. */
export function unitIconCanvas(type: UnitTypeId, size = 40, player = 0): HTMLCanvasElement {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = size + "px";
  canvas.style.height = size + "px";
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawUnitIcon(ctx, type, size, player);
  }
  return canvas;
}
