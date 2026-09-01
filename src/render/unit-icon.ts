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

import { SIZE, bodyPath, detailPath, offsetBrush, type Brush } from "./soldier-art.ts";
import { unitEdge, unitFill, unitSheen, unitShadow } from "./palette.ts";
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
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // The same five passes the battlefield uses, in the same order, so the menu
  // counter is the field counter and cannot drift from it.
  ctx.beginPath();
  bodyPath(type, offsetBrush(brush, r * 0.16, r * 0.24));
  ctx.fillStyle = unitShadow;
  ctx.fill();

  ctx.beginPath();
  bodyPath(type, brush);
  ctx.fillStyle = unitFill(player, type);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  bodyPath(type, brush);
  ctx.clip();
  ctx.beginPath();
  bodyPath(type, offsetBrush(brush, -r * 0.17, -r * 0.2));
  ctx.fillStyle = unitSheen;
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  bodyPath(type, brush);
  ctx.strokeStyle = unitEdge(player, type);
  ctx.lineWidth = Math.max(0.8, r * 0.1);
  ctx.stroke();

  ctx.beginPath();
  detailPath(type, brush);
  ctx.strokeStyle = "rgba(31, 25, 16, 0.6)";
  ctx.lineWidth = Math.max(0.9, r * 0.13);
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
