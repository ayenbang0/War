/**
 * K9: the opening cutscene's drawing (content/story/cutscene.ts): the realm's
 * map in ink on parchment, the camera moving over it beat by beat, a road
 * inked in as the exile travels it, and the eight props as inked glyphs.
 *
 * Procedural, like everything drawn in this project (CLAUDE.md, art
 * direction): no sprite, no image file. It reads the map's content table
 * (holdings and roads), never a sim world, because the opening plays before
 * there is a realm to read.
 *
 * Pure drawing: it is handed a camera and a beat and draws one frame. Where
 * the camera is and how fast it moves is the screen's business
 * (ui/story/cutscene.ts), which is also where reduced motion turns pans into
 * cuts.
 */

import type { KingdomMapDef } from "../../content/kingdom/map.ts";
import type { CutsceneProp, StageDirection } from "../../content/story/cutscene.ts";
import { ink, parchment, inkMid, inkLight, sheet, table, kingColor, crownColor } from "../kingdom/palette.ts";

/** Where the cutscene's camera looks: a map point, and how many map miles fit the short side. */
export type CutsceneView = { readonly x: number; readonly y: number; readonly span: number };

/** The road between two holdings along the known roads, as holding keys (breadth first, ties by table order). */
export function roadBetween(map: KingdomMapDef, from: string, to: string): string[] {
  const next = new Map<string, string[]>();
  for (const [a, b] of map.roads) {
    next.set(a, [...(next.get(a) ?? []), b]);
    next.set(b, [...(next.get(b) ?? []), a]);
  }
  const back = new Map<string, string>([[from, ""]]);
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift() as string;
    if (at === to) break;
    for (const n of next.get(at) ?? []) if (!back.has(n)) { back.set(n, at); queue.push(n); }
  }
  if (!back.has(to)) return [from, to];
  const out: string[] = [];
  for (let k = to; k !== ""; k = back.get(k) ?? "") out.unshift(k);
  return out;
}

/** The view a stage direction frames, at the start (t = 0) or end (t = 1) of its beat. */
export function viewFor(map: KingdomMapDef, stage: StageDirection, t: number, last: CutsceneView): CutsceneView {
  const at = (key: string | undefined): { x: number; y: number } | null => {
    const h = key ? map.holdings.find((x) => x.key === key) : undefined;
    return h ? { x: h.x, y: h.y } : null;
  };
  const whole: CutsceneView = { x: map.width / 2, y: map.height / 2, span: map.height * 1.05 };
  switch (stage.shot) {
    case "realm":
    case "title":
      return whole;
    case "holding": {
      const p = at(stage.holding);
      return p ? { x: p.x, y: p.y, span: stage.miles } : whole;
    }
    case "road": {
      const path = roadBetween(map, stage.from, stage.to).map((k) => at(k) as { x: number; y: number });
      const p = pointAlong(path, t);
      return { x: p.x, y: p.y, span: 260 };
    }
    case "prop": {
      const p = at(stage.at);
      return p ? { x: p.x, y: p.y, span: 200 } : last;
    }
  }
}

/** A point `t` (0..1) of the way along a polyline, by length. */
function pointAlong(path: readonly { x: number; y: number }[], t: number): { x: number; y: number } {
  if (path.length === 0) return { x: 0, y: 0 };
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  let want = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    if (want <= d && d > 0) {
      const f = want / d;
      return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * f, y: path[i - 1].y + (path[i].y - path[i - 1].y) * f };
    }
    want -= d;
  }
  return path[path.length - 1];
}

/**
 * One frame: the sheet, the roads, the holdings (named when the camera is
 * close enough to read them), the road travelled so far, and the beat's prop.
 * `t` is how far through the beat (0..1); `w` and `h` the canvas in CSS px.
 */
export function drawCutscene(
  ctx: CanvasRenderingContext2D, map: KingdomMapDef, view: CutsceneView, stage: StageDirection, t: number, w: number, h: number,
): void {
  const scale = Math.min(w, h) / view.span;
  const sx = (x: number): number => w / 2 + (x - view.x) * scale;
  const sy = (y: number): number => h / 2 + (y - view.y) * scale;
  ctx.save();
  ctx.fillStyle = table;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = sheet;
  ctx.fillRect(sx(0), sy(0), map.width * scale, map.height * scale);

  // Roads, faint; holdings as rings, the crown seat larger.
  ctx.strokeStyle = inkLight;
  ctx.lineWidth = 1.2;
  const pos = new Map(map.holdings.map((x) => [x.key, x] as const));
  ctx.beginPath();
  for (const [a, b] of map.roads) {
    const p = pos.get(a);
    const q = pos.get(b);
    if (!p || !q) continue;
    ctx.moveTo(sx(p.x), sy(p.y));
    ctx.lineTo(sx(q.x), sy(q.y));
  }
  ctx.stroke();
  const named = scale > 1.6;
  ctx.font = "13px Georgia, serif";
  ctx.textAlign = "center";
  for (const x of map.holdings) {
    const r = (x.key === map.crownSeat ? 7 : 4) * Math.min(1.6, Math.max(0.7, scale / 1.4));
    ctx.beginPath();
    ctx.arc(sx(x.x), sy(x.y), r, 0, Math.PI * 2);
    ctx.fillStyle = x.key === map.crownSeat ? crownColor : parchment;
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    if (named) {
      ctx.fillStyle = inkMid;
      ctx.fillText(x.name, sx(x.x), sy(x.y) - r - 5);
    }
  }

  // The road travelled so far, inked in the king's colour.
  if (stage.shot === "road") {
    const path = roadBetween(map, stage.from, stage.to).map((k) => pos.get(k)).filter((p) => p !== undefined);
    const tip = pointAlong(path as { x: number; y: number }[], t);
    ctx.strokeStyle = kingColor;
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    let done = false;
    path.forEach((p, i) => {
      if (done || !p) return;
      if (i === 0) { ctx.moveTo(sx(p.x), sy(p.y)); return; }
      const prev = path[i - 1] as { x: number; y: number };
      const seg = Math.hypot(p.x - prev.x, p.y - prev.y);
      const toTip = Math.hypot(tip.x - prev.x, tip.y - prev.y);
      if (toTip < seg - 1e-6 && Math.hypot(p.x - tip.x, p.y - tip.y) > 1e-6) {
        ctx.lineTo(sx(tip.x), sy(tip.y));
        done = true;
      } else ctx.lineTo(sx(p.x), sy(p.y));
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (stage.shot === "prop") {
    const at = stage.at ? pos.get(stage.at) : undefined;
    const cx = at ? sx(at.x) : w / 2;
    const cy = at ? sy(at.y) - Math.min(w, h) * 0.12 : h * 0.4;
    drawProp(ctx, stage.prop, cx, cy, Math.min(w, h) * 0.12, t);
  }
  if (stage.shot === "title") {
    ctx.fillStyle = ink;
    ctx.font = "bold " + Math.round(Math.min(w, h) * 0.08) + "px Georgia, serif";
    ctx.fillText("The Exile of Rimaros", w / 2, h * 0.42);
  }
  ctx.restore();
}

/** One inked prop, `size` px across, drawn in as `t` goes 0..1 (it is simply there at t = 1). */
function drawProp(ctx: CanvasRenderingContext2D, prop: CutsceneProp, cx: number, cy: number, size: number, t: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.globalAlpha = Math.min(1, 0.25 + t * 2);
  ctx.strokeStyle = ink;
  ctx.fillStyle = parchment;
  ctx.lineWidth = 2;
  const s = size / 2;
  ctx.beginPath();
  switch (prop) {
    case "badges": {
      // The eight beasts' roundels in a ring, each with its initial.
      const marks = ["B", "F", "B", "H", "W", "O", "S", "C"];
      ctx.font = "bold " + Math.round(s * 0.32) + "px Georgia, serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      marks.forEach((m, i) => {
        const a = (i / marks.length) * Math.PI * 2 - Math.PI / 2;
        const x = Math.cos(a) * s * 1.2;
        const y = Math.sin(a) * s * 1.2;
        ctx.beginPath();
        ctx.arc(x, y, s * 0.3, 0, Math.PI * 2);
        ctx.fillStyle = parchment;
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = ink;
        ctx.fillText(m, x, y + 1);
      });
      break;
    }
    case "writ":
      ctx.rect(-s * 0.8, -s, s * 1.6, s * 2);
      ctx.fill();
      ctx.stroke();
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.moveTo(-s * 0.55, -s * 0.6 + i * s * 0.3);
        ctx.lineTo(s * 0.55, -s * 0.6 + i * s * 0.3);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(s * 0.35, s * 0.7, s * 0.16, 0, Math.PI * 2);
      ctx.fillStyle = crownColor;
      ctx.fill();
      break;
    case "crown-box":
      ctx.rect(-s, -s * 0.2, s * 2, s);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-s * 0.6, -s * 0.2);
      ctx.lineTo(-s * 0.6, -s * 0.8);
      ctx.lineTo(-s * 0.3, -s * 0.5);
      ctx.lineTo(0, -s * 0.9);
      ctx.lineTo(s * 0.3, -s * 0.5);
      ctx.lineTo(s * 0.6, -s * 0.8);
      ctx.lineTo(s * 0.6, -s * 0.2);
      ctx.stroke();
      break;
    case "ledger":
      ctx.rect(-s, -s * 0.7, s * 2, s * 1.4);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.7);
      ctx.lineTo(0, s * 0.7);
      ctx.stroke();
      break;
    case "horse":
      // A horse in four lines: back, neck and head, and two pairs of legs.
      ctx.moveTo(-s, 0);
      ctx.lineTo(s * 0.5, 0);
      ctx.lineTo(s * 0.9, -s * 0.6);
      ctx.lineTo(s * 1.1, -s * 0.4);
      ctx.moveTo(-s * 0.8, 0);
      ctx.lineTo(-s * 0.9, s * 0.8);
      ctx.moveTo(-s * 0.5, 0);
      ctx.lineTo(-s * 0.4, s * 0.8);
      ctx.moveTo(s * 0.2, 0);
      ctx.lineTo(s * 0.1, s * 0.8);
      ctx.moveTo(s * 0.45, 0);
      ctx.lineTo(s * 0.55, s * 0.8);
      ctx.stroke();
      break;
    case "snow":
      for (let i = 0; i < 24; i++) {
        // A fixed scatter: the same flakes every frame, falling with t.
        const x = (((i * 37) % 23) / 11.5 - 1) * s * 1.4;
        const y = (((i * 53 + t * 40) % 29) / 14.5 - 1) * s * 1.2;
        ctx.moveTo(x + 2, y);
        ctx.arc(x, y, 2, 0, Math.PI * 2);
      }
      ctx.fillStyle = ink;
      ctx.fill();
      break;
    case "keep-ruin":
      // A roofless tower: two walls and a broken top.
      ctx.moveTo(-s * 0.6, s);
      ctx.lineTo(-s * 0.6, -s * 0.6);
      ctx.lineTo(-s * 0.3, -s * 0.8);
      ctx.lineTo(0, -s * 0.5);
      ctx.lineTo(s * 0.2, -s * 0.9);
      ctx.lineTo(s * 0.6, -s * 0.7);
      ctx.lineTo(s * 0.6, s);
      ctx.closePath();
      ctx.stroke();
      break;
    case "quill":
      ctx.moveTo(-s, s);
      ctx.quadraticCurveTo(0, 0, s, -s);
      ctx.quadraticCurveTo(s * 0.2, -s * 0.2, -s, s);
      ctx.fill();
      ctx.stroke();
      break;
  }
  ctx.restore();
}
