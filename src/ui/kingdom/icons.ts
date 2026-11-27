/**
 * The stock icons of the resources bar (K3; docs/audit/u2-economy-panels.md).
 *
 * One family, one ink: every glyph is drawn here with the same line weight
 * and the same dark ink on the bar's parchment, on a small fixed canvas
 * (docs/ui-policy.md: menu icons are small canvases at up to 3x). No emoji or
 * font glyph stands in for an icon, and an icon never stands alone -- the bar
 * always puts the stock's name beside it, so the canvas is aria-hidden.
 */

import type { LedgerStockId } from "../../content/kingdom/economy.ts";

/** CSS px of one icon. 20 px sits beside 16 px text. */
export const ICON_PX = 20;
/** The ink: the panel's body text colour (10.4:1 on #efe8d6). */
const INK = "#3a3124";
const FILL = "#c9b48a";

type Ctx = CanvasRenderingContext2D;

/** A bar cell's icon: a ledger stock, or K6's Mercy/Terror (not a stock, but beside them). */
export type IconId = LedgerStockId | "mercy";

/** Each glyph draws in a 20x20 box. */
const GLYPHS: Readonly<Record<IconId, (c: Ctx) => void>> = {
  coin: (c) => {
    c.beginPath(); c.arc(10, 10, 7.5, 0, Math.PI * 2); c.fillStyle = FILL; c.fill(); c.stroke();
    c.beginPath(); c.arc(10, 10, 4.5, 0, Math.PI * 2); c.stroke();
  },
  grain: (c) => {
    // A sheaf: three stalks bound at the waist, ears at the top.
    for (const [x0, x1] of [[10, 10], [7, 4.5], [13, 15.5]] as const) {
      c.beginPath(); c.moveTo(10, 18); c.lineTo(x0, 11); c.lineTo(x1, 5); c.stroke();
      c.beginPath(); c.ellipse(x1, 4.5, 1.6, 3, (x1 - 10) / 12, 0, Math.PI * 2); c.fillStyle = FILL; c.fill(); c.stroke();
    }
    c.beginPath(); c.moveTo(7.5, 12.5); c.lineTo(12.5, 12.5); c.stroke();
  },
  timber: (c) => {
    // Two logs, end-on circles to the right.
    for (const y of [7, 13]) {
      c.beginPath(); c.rect(3, y - 3, 12, 6); c.fillStyle = FILL; c.fill(); c.stroke();
      c.beginPath(); c.arc(15, y, 3, 0, Math.PI * 2); c.fillStyle = "#e6d8b8"; c.fill(); c.stroke();
    }
  },
  iron: (c) => {
    c.beginPath(); c.moveTo(3, 15); c.lineTo(6, 8); c.lineTo(16, 8); c.lineTo(18, 15); c.closePath();
    c.fillStyle = "#8f8a80"; c.fill(); c.stroke();
    c.beginPath(); c.moveTo(6, 8); c.lineTo(5, 15); c.stroke();
  },
  levy: (c) => {
    // A figure with a spear: followers.
    c.beginPath(); c.arc(9, 5, 2.6, 0, Math.PI * 2); c.fillStyle = FILL; c.fill(); c.stroke();
    c.beginPath(); c.moveTo(9, 8); c.lineTo(9, 13); c.moveTo(9, 13); c.lineTo(6, 18); c.moveTo(9, 13); c.lineTo(12, 18);
    c.moveTo(5, 10); c.lineTo(13, 10); c.stroke();
    c.beginPath(); c.moveTo(15, 2); c.lineTo(15, 18); c.stroke();
  },
  legitimacy: (c) => {
    // A crown.
    c.beginPath(); c.moveTo(3, 15); c.lineTo(3, 6); c.lineTo(7, 10); c.lineTo(10, 4); c.lineTo(13, 10); c.lineTo(17, 6);
    c.lineTo(17, 15); c.closePath(); c.fillStyle = FILL; c.fill(); c.stroke();
  },
  mercy: (c) => {
    // A balance: the post, the beam, a pan hung from each end.
    c.beginPath(); c.moveTo(10, 3); c.lineTo(10, 17); c.moveTo(6, 17); c.lineTo(14, 17); c.moveTo(3, 6); c.lineTo(17, 6); c.stroke();
    for (const x of [4.5, 15.5]) {
      c.beginPath(); c.moveTo(x, 6); c.lineTo(x - 2.5, 11); c.moveTo(x, 6); c.lineTo(x + 2.5, 11); c.stroke();
      c.beginPath(); c.moveTo(x - 3, 11); c.quadraticCurveTo(x, 14.5, x + 3, 11); c.closePath(); c.fillStyle = FILL; c.fill(); c.stroke();
    }
  },
};

/** A stock's icon on a fresh canvas, drawn at the device's ratio (capped at 3). */
export function stockIcon(doc: Document, stock: IconId): HTMLCanvasElement {
  const canvas = doc.createElement("canvas") as HTMLCanvasElement;
  const dpr = Math.min(3, Math.max(1, doc.defaultView?.devicePixelRatio ?? 1));
  canvas.width = Math.round(ICON_PX * dpr);
  canvas.height = Math.round(ICON_PX * dpr);
  canvas.className = "k-icon";
  canvas.setAttribute("aria-hidden", "true");
  const c = canvas.getContext("2d");
  if (c) {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.lineWidth = 1.5;
    c.lineJoin = "round";
    c.lineCap = "round";
    c.strokeStyle = INK;
    GLYPHS[stock](c);
  }
  return canvas;
}
