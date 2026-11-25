/**
 * Draws a city (K3b): the town plan of one holding (layout.ts) in the
 * kingdom map's map-table look -- parchment sheet on the darker table, ink
 * streets, hatching and stipple, halo labels -- with the holding's live
 * state on it: each lot empty, staked, being built (with its progress) or
 * standing (a building block with its glyph and name), the town's palisade
 * or wall when one is built, and each field's crop and stage.
 *
 * NEVER WRITES SIM STATE. It reads the world and the plan it is handed. Unlike
 * the kingdom map, the town is drawn as ground under the camera: a lot grows
 * when you zoom in. Line widths have a pixel floor and labels stay ≥ 14 px on
 * a halo (docs/ui-policy.md), so the plan reads at every zoom.
 *
 * State is never colour alone (U2 C rules): a lot's state is its SHAPE (a
 * dashed outline, corner stakes, scaffold hatching with a progress bar, a
 * solid block with a glyph, a strike when idle) and its label in words; a
 * field's stage is its PATTERN (furrows, sprouts, stipple, stubble,
 * cross-hatch) and its label.
 */

import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { Holding, FieldPlot } from "../../sim/kingdom/state.ts";
import type { KingdomCamera } from "../kingdom/camera.ts";
import type { BiomeId } from "../../content/kingdom/terrain.ts";
import { BUILDINGS, type BuildingId } from "../../content/kingdom/buildings.ts";
import { CROPS, type CropId } from "../../content/kingdom/crops.ts";
import { STAGE_NAME } from "../../content/kingdom/ui-strings.ts";
import { C } from "../../content/kingdom/city-strings.ts";
import * as P from "../kingdom/palette.ts";
import type { CityPick, CityPlan, Pt } from "./layout.ts";

/** A pen stroke being drawn, or fading after release (no order is drawn in a city). */
export type CityInk = { readonly points: readonly Pt[]; readonly start: number; readonly duration: number };
export type CityPulse = { readonly at: Pt; readonly start: number; readonly duration: number };

export type CityFrame = {
  readonly world: KingdomWorld;
  readonly holding: Holding;
  readonly plan: CityPlan;
  readonly cam: KingdomCamera;
  readonly selected: CityPick | null;
  readonly hover: CityPick | null;
  /** The stroke being drawn now, in plan units. */
  readonly stroke: readonly Pt[] | null;
  readonly fades: readonly CityInk[];
  readonly pulses: readonly CityPulse[];
  /** Real seconds. */
  readonly clock: number;
  /**
   * The layer transition (camera-systems: framing between layers): the plan
   * drawn scaled about a screen point, from where the holding sat on the map,
   * up to 1. Null when there is none (and always under reduced motion).
   */
  readonly intro: { readonly x: number; readonly y: number; readonly scale: number; readonly alpha: number } | null;
};

// -- the city's own colours (beside the kingdom palette) -----------------------------

const GROUND: Record<BiomeId, string> = {
  reach: "#d6d1c0", vale: "#dcd7b2", forest: "#d2d4b0", river: "#d7d6bb", "river-town": "#d9d4ba",
  city: "#ddd2b6", open: "#e1d8b0", highland: "#d5cfb8", moor: "#d3cbb8", "border-hills": "#dacfb4", coast: "#dbd6c0",
};
const WATER = "#a5b8bb";
const WATER_EDGE = "rgba(70, 96, 104, 0.7)";
const STREET = "#c9b68f";
const GREEN = "#b8bf8e";
const MARKET = "#d3c29a";
const ROOF = "#a9875f";
const ROOF_CITY = "#9d958a";
const LOT_GROUND = "rgba(242, 234, 214, 0.55)";
const BLOCK = "#c6ae86";
const BLOCK_IDLE = "#b9b2a2";
const DISC = "#f2ead6";
const TREE = "#7f915f";
const TREE_DARK = "#66784c";
const PALISADE = "#7a5a3a";
const STONE = "#8a857a";
const PROGRESS = "#2e4a6d";
const SELECT = "#2e4a6d";

/** Field colours by stage; growing blends sown → green by progress. */
const FIELD_FALLOW = "#cdbb93";
const FIELD_SOWN = "#b99c6c";
const FIELD_GREEN = "#8fa766";
const FIELD_STUBBLE = "#d9c78f";
const FIELD_SPOILED = "#9e9482";
const RIPE: Record<string, string> = { wheat: "#dbb956", rye: "#c3a157", flax: "#8ea7bb", herbs: "#a08aa6", orchard: "#c98f5a" };

const LABEL_PX = 14;
const LABEL_FONT = (px: number, bold = false): string => (bold ? "600 " : "") + px + "px " + P.MAP_FONT;

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * Math.max(0, Math.min(1, t))));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

type Box = { x0: number; y0: number; x1: number; y1: number };
const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** What a lot shows, in words: the same line the panel prints. */
export function lotLine(h: Holding, index: number): string {
  const id = h.buildings[index];
  if (id === null) {
    const next = h.buildings.indexOf(null);
    return next === index ? C.lotNext : C.lotLater;
  }
  const def = BUILDINGS[id as BuildingId];
  const name = def ? def.name : id;
  if (h.works[index] > 0) return C.lotWorks({ name, left: h.works[index] });
  if (h.idle[index]) return C.lotIdle(name);
  return C.lotStanding(name);
}

/** What a field shows, in words. */
export function fieldLine(p: FieldPlot): string {
  const crop = p.crop ? CROPS[p.crop as CropId] : null;
  if (!crop || p.stage === "empty") return STAGE_NAME.empty;
  return crop.name + ", " + STAGE_NAME[p.stage] + (p.stage === "growing" ? " " + Math.floor(p.progress * 100) + "%" : "");
}

export class CityRenderer {
  /** Frames drawn and what the last drew: read by the tests and the e2e harness. */
  readonly stats = { frames: 0, lots: 0, fields: 0, labels: 0, enclosure: "none" as "none" | "palisade" | "wall" | "keep" | "works" };

  private readonly ctx: CanvasRenderingContext2D;
  private grain: CanvasPattern | null;

  constructor(ctx: CanvasRenderingContext2D, doc: Document) {
    this.ctx = ctx;
    this.grain = makeGrain(ctx, doc);
  }

  draw(f: CityFrame): void {
    const { ctx } = this;
    const { cam, plan, holding: h } = f;
    const W = cam.viewW;
    const H = cam.viewH;
    const z = cam.zoom;
    const sx = (x: number): number => cam.worldToScreenX(x);
    const sy = (y: number): number => cam.worldToScreenY(y);
    const px = (v: number, floor = 0): number => Math.max(floor, v * z);
    const path = (pts: readonly Pt[], close: boolean): void => {
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.y)) : ctx.lineTo(sx(p.x), sy(p.y))));
      if (close) ctx.closePath();
    };

    ctx.fillStyle = P.table;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    if (f.intro) {
      ctx.globalAlpha = f.intro.alpha;
      ctx.translate(f.intro.x, f.intro.y);
      ctx.scale(f.intro.scale, f.intro.scale);
      ctx.translate(-f.intro.x, -f.intro.y);
    }

    // -- the sheet ------------------------------------------------------------
    const sheet: Box = { x0: sx(0), y0: sy(0), x1: sx(plan.width), y1: sy(plan.height) };
    ctx.fillStyle = GROUND[plan.biome];
    ctx.fillRect(sheet.x0, sheet.y0, sheet.x1 - sheet.x0, sheet.y1 - sheet.y0);
    if (this.grain) {
      ctx.save();
      ctx.translate(sheet.x0, sheet.y0);
      ctx.fillStyle = this.grain;
      ctx.fillRect(0, 0, sheet.x1 - sheet.x0, sheet.y1 - sheet.y0);
      ctx.restore();
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(sheet.x0, sheet.y0, sheet.x1 - sheet.x0, sheet.y1 - sheet.y0);
    ctx.clip();

    // -- ground marks -------------------------------------------------------------
    ctx.strokeStyle = P.inkLight;
    ctx.lineWidth = 1;
    for (const loop of plan.contours) { path(loop, true); ctx.stroke(); }
    ctx.fillStyle = "rgba(90, 82, 70, 0.55)";
    for (const s of plan.stones) {
      ctx.beginPath();
      ctx.ellipse(sx(s.x), sy(s.y), px(3, 1.5), px(2.2, 1), 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = "rgba(118, 84, 110, 0.55)";
    for (const t of plan.tufts) {
      const x = sx(t.x);
      const y = sy(t.y);
      const r = px(3, 2);
      ctx.beginPath();
      ctx.moveTo(x - r, y); ctx.lineTo(x, y - r); ctx.lineTo(x + r, y);
      ctx.stroke();
    }

    // -- the river under the streets (they cross it; bridges go on top) -------------
    if (plan.water?.kind === "river") {
      const w = plan.water;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      path(w.pts, false);
      ctx.strokeStyle = WATER_EDGE;
      ctx.lineWidth = px(w.width + 4, 4);
      ctx.stroke();
      ctx.strokeStyle = WATER;
      ctx.lineWidth = px(w.width, 3);
      ctx.stroke();
    }

    // -- fields -----------------------------------------------------------------
    let fieldsDrawn = 0;
    for (const fp of plan.fields) {
      const plot = h.plots[fp.index];
      if (!plot) continue;
      fieldsDrawn++;
      this.drawField(f, fp.poly, fp.angle, fp.cx, fp.cy, plot);
    }
    ctx.strokeStyle = "rgba(96, 110, 70, 0.75)";
    ctx.lineWidth = px(2.5, 1.5);
    ctx.setLineDash([px(3, 2), px(2, 1.5)]);
    for (const hedge of plan.hedges) { path(hedge, false); ctx.stroke(); }
    ctx.setLineDash([]);

    // -- streets ------------------------------------------------------------------
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of plan.streets) {
      path(s.pts, false);
      ctx.strokeStyle = P.inkMid;
      ctx.lineWidth = px(s.width + 2, 3);
      ctx.stroke();
      ctx.strokeStyle = STREET;
      ctx.lineWidth = px(s.width, 2);
      ctx.stroke();
    }
    for (const b of plan.bridges) {
      const c = Math.cos(b.angle);
      const s = Math.sin(b.angle);
      const half = (plan.water?.kind === "river" ? plan.water.width : 20) / 2 + 6;
      const n = -s;
      const m = c;
      ctx.strokeStyle = P.inkStrong;
      ctx.lineWidth = px(1.6, 1.2);
      for (const side of [-1, 1]) {
        const ox = n * side * 7;
        const oy = m * side * 7;
        ctx.beginPath();
        ctx.moveTo(sx(b.x - c * half + ox), sy(b.y - s * half + oy));
        ctx.lineTo(sx(b.x + c * half + ox), sy(b.y + s * half + oy));
        ctx.stroke();
      }
    }

    // -- the sea, over the streets that run down to it --------------------------------
    if (plan.water?.kind === "sea") {
      path(plan.water.poly, true);
      ctx.fillStyle = WATER;
      ctx.fill();
      path(plan.water.shore, false);
      ctx.strokeStyle = WATER_EDGE;
      ctx.lineWidth = px(2, 1.5);
      ctx.stroke();
      // Wave strokes, sparse, so the sea reads as water in greyscale too.
      ctx.strokeStyle = "rgba(70, 96, 104, 0.45)";
      ctx.lineWidth = 1;
      const sh = plan.water.shore;
      for (let i = 1; i < sh.length; i += 2) {
        const a = sh[i - 1];
        const b = sh[i];
        for (const k of [1, 2]) {
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const dx = mx - plan.centre.x;
          const dy = my - plan.centre.y;
          const l = Math.hypot(dx, dy) || 1;
          const wx = mx + (dx / l) * 26 * k;
          const wy = my + (dy / l) * 26 * k;
          ctx.beginPath();
          ctx.arc(sx(wx), sy(wy), px(6, 3), Math.PI * 1.15, Math.PI * 1.85);
          ctx.stroke();
        }
      }
    }

    // -- trees ----------------------------------------------------------------------
    for (const t of plan.trees) {
      const x = sx(t.x);
      const y = sy(t.y);
      const r = px(t.r, 2.5);
      ctx.fillStyle = t.conifer ? TREE_DARK : TREE;
      ctx.strokeStyle = P.inkMid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (t.conifer) {
        ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r * 0.8, y + r * 0.7); ctx.lineTo(x - r * 0.8, y + r * 0.7); ctx.closePath();
      } else {
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();
    }

    // -- the enclosure (a palisade, wall or keep standing or being built) ---------------
    const enclosure = this.enclosureOf(h);
    this.stats.enclosure = enclosure;
    if (enclosure !== "none") {
      path(plan.ring, true);
      ctx.setLineDash(enclosure === "works" ? [px(6, 4), px(5, 3)] : []);
      if (enclosure === "palisade" || enclosure === "works") {
        ctx.strokeStyle = PALISADE;
        ctx.lineWidth = px(4, 2.5);
        ctx.stroke();
        if (enclosure === "palisade") {
          // Stakes: short ticks outward round the ring.
          ctx.strokeStyle = P.inkStrong;
          ctx.lineWidth = 1;
          for (let i = 0; i < 80; i++) {
            const a = (i / 80) * Math.PI * 2;
            const r = plan.coreR;
            const x0 = plan.centre.x + Math.cos(a) * r;
            const y0 = plan.centre.y + Math.sin(a) * r;
            ctx.beginPath();
            ctx.moveTo(sx(x0), sy(y0));
            ctx.lineTo(sx(x0 + Math.cos(a) * 5), sy(y0 + Math.sin(a) * 5));
            ctx.stroke();
          }
        }
      } else {
        ctx.strokeStyle = P.inkStrong;
        ctx.lineWidth = px(8, 4);
        ctx.stroke();
        ctx.strokeStyle = STONE;
        ctx.lineWidth = px(6, 3);
        ctx.stroke();
        // Towers at every other ring vertex.
        for (let i = 0; i < plan.ring.length; i += 2) {
          const p = plan.ring[i];
          ctx.fillStyle = STONE;
          ctx.strokeStyle = P.inkStrong;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(sx(p.x), sy(p.y), px(enclosure === "keep" ? 7 : 5.5, 3), 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
      ctx.setLineDash([]);
      // Gates: a break and two posts where each street goes through.
      for (const g of plan.gates) {
        ctx.fillStyle = STREET;
        ctx.beginPath();
        ctx.arc(sx(g.x), sy(g.y), px(7, 3), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = P.inkStrong;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }

    // -- the square -----------------------------------------------------------------
    const sq = plan.square;
    ctx.beginPath();
    if (sq.kind === "green") ctx.arc(sx(sq.x), sy(sq.y), px(sq.r, 4), 0, Math.PI * 2);
    else {
      const r = px(sq.r, 4);
      ctx.rect(sx(sq.x) - r, sy(sq.y) - r * 0.8, r * 2, r * 1.6);
    }
    ctx.fillStyle = sq.kind === "green" ? GREEN : MARKET;
    ctx.fill();
    ctx.strokeStyle = P.inkMid;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    if (sq.kind === "bailey") {
      // A motte in the bailey: concentric rings, the keep's mound.
      for (const k of [0.55, 0.32]) {
        ctx.beginPath();
        ctx.arc(sx(sq.x), sy(sq.y), px(sq.r * k, 2), 0, Math.PI * 2);
        ctx.stroke();
      }
    } else {
      // The well or market cross at its middle.
      ctx.beginPath();
      ctx.arc(sx(sq.x), sy(sq.y), px(2.5, 2), 0, Math.PI * 2);
      ctx.fillStyle = P.inkMid;
      ctx.fill();
    }

    // -- houses -------------------------------------------------------------------
    const roof = plan.kind === "city" ? ROOF_CITY : ROOF;
    for (const hs of plan.houses) {
      this.block(f, hs.x, hs.y, hs.w, hs.h, hs.angle, roof, P.inkMid, true);
    }

    // -- lots ----------------------------------------------------------------------
    const next = h.buildings.indexOf(null);
    let lotsDrawn = 0;
    for (const l of plan.lots) {
      if (l.index >= h.buildings.length) continue;
      lotsDrawn++;
      const id = h.buildings[l.index];
      path(l.poly, true);
      if (id === null) {
        ctx.fillStyle = LOT_GROUND;
        ctx.fill();
        ctx.setLineDash([px(4, 3), px(3, 2)]);
        ctx.strokeStyle = l.index === next ? P.inkStrong : P.inkLight;
        ctx.lineWidth = l.index === next ? 1.6 : 1;
        ctx.stroke();
        ctx.setLineDash([]);
        if (l.index === next) {
          // Stakes at the corners: the surveyed lot the builders take next.
          for (const c of l.poly) {
            ctx.fillStyle = PALISADE;
            ctx.beginPath();
            ctx.arc(sx(c.x), sy(c.y), px(2.2, 2.5), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        continue;
      }
      const def = BUILDINGS[id as BuildingId];
      const works = h.works[l.index];
      if (works > 0) {
        ctx.fillStyle = LOT_GROUND;
        ctx.fill();
        ctx.strokeStyle = P.inkStrong;
        ctx.lineWidth = 1.4;
        ctx.stroke();
        // Scaffold hatching, and a bar of the work done so far.
        ctx.save();
        path(l.poly, true);
        ctx.clip();
        ctx.strokeStyle = P.inkMid;
        ctx.lineWidth = 1;
        const step = Math.max(5, 6 * z);
        const cx = sx(l.x);
        const cy = sy(l.y);
        const span = Math.max(l.w, l.h) * z;
        for (let d = -span; d <= span; d += step) {
          ctx.beginPath();
          ctx.moveTo(cx + d - span, cy - span);
          ctx.lineTo(cx + d + span, cy + span);
          ctx.stroke();
        }
        ctx.restore();
        const done = def ? 1 - works / def.days : 0;
        const bw = Math.max(28, l.w * z);
        const bx = sx(l.x) - bw / 2;
        const by = sy(l.y) + Math.max(10, (l.h * z) / 2) + 3;
        ctx.fillStyle = P.halo;
        ctx.fillRect(bx - 1, by - 1, bw + 2, 7);
        ctx.fillStyle = PROGRESS;
        ctx.fillRect(bx, by, bw * Math.max(0, Math.min(1, done)), 5);
        ctx.strokeStyle = P.inkStrong;
        ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, bw, 5);
        if (def) this.glyphDisc(f, id as BuildingId, l.x, l.y, false);
        continue;
      }
      const idle = h.idle[l.index];
      this.block(f, l.x, l.y, l.w, l.h, l.angle, idle ? BLOCK_IDLE : BLOCK, P.inkStrong, false);
      if (def) this.glyphDisc(f, id as BuildingId, l.x, l.y, idle);
      if (idle) {
        // Idle is struck through, not only greyed (state is never colour alone).
        ctx.strokeStyle = P.inkStrong;
        ctx.lineWidth = 1.6;
        const a = l.poly[0];
        const b = l.poly[2];
        ctx.beginPath();
        ctx.moveTo(sx(a.x), sy(a.y));
        ctx.lineTo(sx(b.x), sy(b.y));
        ctx.stroke();
      }
    }

    // -- hover and selection ------------------------------------------------------------
    const outline = (pick: CityPick, colour: string, width: number, dash: number[]): void => {
      const pts = this.pickOutline(plan, pick);
      if (!pts) return;
      ctx.setLineDash(dash);
      ctx.strokeStyle = P.halo;
      ctx.lineWidth = width + 3;
      path(pts, true);
      ctx.stroke();
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (f.hover && !(f.selected && samePick(f.hover, f.selected))) outline(f.hover, P.inkStrong, 1.5, [4, 3]);
    if (f.selected) outline(f.selected, SELECT, 3, []);

    for (const p of f.pulses) {
      const t = Math.max(0, Math.min(1, (f.clock - p.start) / p.duration));
      ctx.strokeStyle = "rgba(46, 74, 109, " + (1 - t).toFixed(3) + ")";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(sx(p.at.x), sy(p.at.y), 10 + t * 30, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore(); // the sheet clip

    // -- labels (never clipped by the sheet, never under the floor) ------------------------
    const placed: Box[] = [];
    let labels = 0;
    const label = (text: string, x: number, y: number, force: boolean, bold = false): void => {
      ctx.font = LABEL_FONT(LABEL_PX, bold);
      const w = ctx.measureText(text).width;
      const box: Box = { x0: x - w / 2 - 4, y0: y - LABEL_PX / 2 - 3, x1: x + w / 2 + 4, y1: y + LABEL_PX / 2 + 3 };
      if (!force && placed.some((b) => overlaps(b, box))) return;
      placed.push(box);
      labels++;
      ctx.fillStyle = P.halo;
      ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      ctx.fillStyle = P.ink;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x, y);
    };
    const selLot = f.selected?.kind === "lot" ? f.selected.index : -1;
    const selField = f.selected?.kind === "field" ? f.selected.index : -1;
    // The selected thing is lettered first so it is never the one culled.
    const lotLabel = (i: number, force: boolean): void => {
      const l = plan.lots[i];
      if (!l || l.index >= h.buildings.length) return;
      const below = Math.max(12, (l.h * z) / 2) + (h.works[l.index] > 0 ? 20 : 12);
      label(C.lotTitle(l.index + 1) + " · " + lotLine(h, l.index), sx(l.x), sy(l.y) + below, force, force);
    };
    const fieldLabel = (i: number, force: boolean): void => {
      const fp = plan.fields[i];
      const plot = fp ? h.plots[fp.index] : undefined;
      if (!fp || !plot) return;
      label(C.fieldTitle(fp.index + 1) + " · " + fieldLine(plot), sx(fp.cx), sy(fp.cy), force, force);
    };
    if (selLot >= 0) lotLabel(selLot, true);
    if (selField >= 0) fieldLabel(selField, true);
    for (let i = 0; i < plan.lots.length; i++) if (i !== selLot) lotLabel(i, false);
    for (let i = 0; i < plan.fields.length; i++) if (i !== selField) fieldLabel(i, false);

    // -- the pen's ink (no order: a line in a town is said, not drawn as an order) ---------
    const inkLine = (pts: readonly Pt[], alpha: number): void => {
      if (pts.length < 2) return;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = "rgba(95, 81, 56, " + (0.75 * alpha).toFixed(3) + ")";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.y)) : ctx.lineTo(sx(p.x), sy(p.y))));
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (f.stroke) inkLine(f.stroke, 1);
    for (const fd of f.fades) inkLine(fd.points, 1 - Math.max(0, Math.min(1, (f.clock - fd.start) / fd.duration)));

    ctx.restore(); // the intro transform
    this.stats.frames++;
    this.stats.lots = lotsDrawn;
    this.stats.fields = fieldsDrawn;
    this.stats.labels = labels;
  }

  /** Which enclosure stands: the strongest of palisade, wall, keep; "works" while the first is building. */
  private enclosureOf(h: Holding): "none" | "palisade" | "wall" | "keep" | "works" {
    let best: "none" | "palisade" | "wall" | "keep" | "works" = "none";
    const rank = { none: 0, works: 1, palisade: 2, wall: 3, keep: 4 } as const;
    for (let i = 0; i < h.buildings.length; i++) {
      const b = h.buildings[i];
      if (b !== "palisade" && b !== "wall" && b !== "keep") continue;
      // A wall going up over a palisade leaves the palisade standing meanwhile.
      const shown = h.works[i] > 0 ? (b === "palisade" ? "works" : b === "wall" ? "palisade" : "wall") : b;
      if (rank[shown] > rank[best]) best = shown;
    }
    return best;
  }

  private pickOutline(plan: CityPlan, pick: CityPick): readonly Pt[] | null {
    if (pick.kind === "lot") return plan.lots[pick.index]?.poly ?? null;
    if (pick.kind === "field") return plan.fields[pick.index]?.poly ?? null;
    const s = plan.square;
    const pts: Pt[] = [];
    for (let i = 0; i < 24; i++) pts.push({ x: s.x + Math.cos((i / 24) * Math.PI * 2) * (s.r + 3), y: s.y + Math.sin((i / 24) * Math.PI * 2) * (s.r + 3) });
    return pts;
  }

  /** A small roofed block: a house, or a lot's building. */
  private block(f: CityFrame, x: number, y: number, w: number, hgt: number, angle: number, fill: string, edge: string, ridge: boolean): void {
    const { ctx } = this;
    const z = f.cam.zoom;
    ctx.save();
    ctx.translate(f.cam.worldToScreenX(x), f.cam.worldToScreenY(y));
    ctx.rotate(angle);
    const ww = Math.max(3, w * z);
    const hh = Math.max(2, hgt * z);
    ctx.fillStyle = fill;
    ctx.fillRect(-ww / 2, -hh / 2, ww, hh);
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    ctx.strokeRect(-ww / 2, -hh / 2, ww, hh);
    if (ridge && ww > 6) {
      ctx.beginPath();
      ctx.moveTo(-ww / 2, 0);
      ctx.lineTo(ww / 2, 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A building's glyph in a pale disc, one ink family (create-game-assets). */
  private glyphDisc(f: CityFrame, id: BuildingId, x: number, y: number, idle: boolean): void {
    const { ctx } = this;
    const r = Math.max(9, Math.min(18, 14 * f.cam.zoom * 0.6));
    const cx = f.cam.worldToScreenX(x);
    const cy = f.cam.worldToScreenY(y);
    ctx.fillStyle = DISC;
    ctx.strokeStyle = P.inkStrong;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.globalAlpha *= idle ? 0.6 : 1;
    drawGlyph(ctx, id, cx, cy, r * 0.62);
    ctx.restore();
  }

  private drawField(f: CityFrame, poly: readonly Pt[], angle: number, cx: number, cy: number, plot: FieldPlot): void {
    const { ctx } = this;
    const { cam } = f;
    const sx = (x: number): number => cam.worldToScreenX(x);
    const sy = (y: number): number => cam.worldToScreenY(y);
    const crop = plot.crop ?? "";
    const stage = plot.stage;
    let fill = FIELD_FALLOW;
    if (stage === "sown") fill = FIELD_SOWN;
    if (stage === "growing") fill = mix(FIELD_SOWN, crop === "flax" ? "#9fb0a0" : FIELD_GREEN, 0.35 + plot.progress * 0.65);
    if (stage === "ripe") fill = RIPE[crop] ?? RIPE.wheat;
    if (stage === "harvested") fill = crop === "orchard" ? FIELD_GREEN : FIELD_STUBBLE;
    if (stage === "spoiled") fill = FIELD_SPOILED;
    if (f.world.date.season === "winter" && (stage === "empty" || stage === "harvested")) fill = mix(fill, "#eeeae0", 0.45);

    ctx.beginPath();
    poly.forEach((p, i) => (i === 0 ? ctx.moveTo(sx(p.x), sy(p.y)) : ctx.lineTo(sx(p.x), sy(p.y))));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = P.inkMid;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // The pattern inside says the stage without the colour.
    ctx.save();
    ctx.clip();
    const z = cam.zoom;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const ox = sx(cx);
    const oy = sy(cy);
    const span = 260 * z;
    const step = Math.max(5, 8 * z);
    const furrow = (alpha: number, dash: number[] = []): void => {
      ctx.strokeStyle = "rgba(63, 53, 39, " + alpha + ")";
      ctx.lineWidth = 1;
      ctx.setLineDash(dash);
      for (let d = -span; d <= span; d += step) {
        // Lines along the furrow direction, offset across it.
        const bx = ox - s * d;
        const by = oy + c * d;
        ctx.beginPath();
        ctx.moveTo(bx - c * span, by - s * span);
        ctx.lineTo(bx + c * span, by + s * span);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    };
    if (stage === "empty") furrow(0.18);
    if (stage === "sown") furrow(0.35, [2, 4]);
    if (stage === "growing") furrow(0.22 + plot.progress * 0.25, [Math.max(2, 4 * plot.progress + 1), 3]);
    if (stage === "ripe") {
      furrow(0.3);
      ctx.fillStyle = "rgba(63, 53, 39, 0.35)";
      for (let i = 0; i < 70; i++) {
        const u = ((i * 37) % 101) / 101 - 0.5;
        const v = ((i * 61) % 97) / 97 - 0.5;
        ctx.fillRect(ox + u * 220 * z, oy + v * 220 * z, 1.6, 1.6);
      }
    }
    if (stage === "harvested") furrow(0.3, [1, 6]);
    if (stage === "spoiled") {
      furrow(0.3);
      // Cross-hatch: the other way too.
      ctx.strokeStyle = "rgba(63, 53, 39, 0.3)";
      for (let d = -span; d <= span; d += step * 1.4) {
        const bx = ox + c * d;
        const by = oy + s * d;
        ctx.beginPath();
        ctx.moveTo(bx + s * span, by - c * span);
        ctx.lineTo(bx - s * span, by + c * span);
        ctx.stroke();
      }
    }
    if (crop === "orchard" && stage !== "empty" && stage !== "spoiled") {
      ctx.fillStyle = TREE;
      ctx.strokeStyle = P.inkMid;
      for (let i = -3; i <= 3; i++) {
        for (let j = -2; j <= 2; j++) {
          const x = ox + (c * i * 22 - s * j * 18) * z;
          const y = oy + (s * i * 22 + c * j * 18) * z;
          ctx.beginPath();
          ctx.arc(x, y, Math.max(2, 5 * z), 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
}

function samePick(a: CityPick, b: CityPick): boolean {
  return a.kind === b.kind && (a.kind === "square" || (a as { index: number }).index === (b as { index: number }).index);
}

/**
 * The building glyph family: one routine, one ink weight, drawn about (x, y)
 * at size s (half-extent in px). Simple silhouettes that differ in shape, not
 * colour: a mill's sails, a barn, an axe, an anvil, crossed spears, a tankard,
 * a tower, stakes, battlements, a keep, a spire, a long hall, an awning.
 */
export function drawGlyph(ctx: CanvasRenderingContext2D, id: BuildingId, x: number, y: number, s: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = P.ink;
  ctx.fillStyle = P.ink;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const line = (pts: readonly (readonly [number, number])[], close = false): void => {
    ctx.beginPath();
    pts.forEach(([u, v], i) => (i === 0 ? ctx.moveTo(u * s, v * s) : ctx.lineTo(u * s, v * s)));
    if (close) ctx.closePath();
    ctx.stroke();
  };
  switch (id) {
    case "farm": // mill sails
      line([[-1, -1], [1, 1]]); line([[1, -1], [-1, 1]]);
      ctx.beginPath(); ctx.arc(0, 0, s * 0.25, 0, Math.PI * 2); ctx.fill();
      break;
    case "granary": // barn with an arched roof
      line([[-0.9, 0.9], [-0.9, -0.1], [0, -0.9], [0.9, -0.1], [0.9, 0.9]], true);
      line([[-0.3, 0.9], [-0.3, 0.3], [0.3, 0.3], [0.3, 0.9]]);
      break;
    case "woodcutter": // axe
      line([[-0.8, 0.9], [0.5, -0.6]]);
      line([[0.2, -0.9], [0.9, -0.2], [0.6, 0.1], [0.0, -0.5]], true);
      break;
    case "forge": // anvil
      line([[-0.9, -0.3], [0.9, -0.3], [0.5, 0.1], [0.3, 0.1], [0.4, 0.7], [-0.4, 0.7], [-0.3, 0.1], [-0.6, 0.1]], true);
      break;
    case "barracks": // crossed spears
      line([[-0.9, 0.9], [0.8, -0.8]]); line([[0.9, 0.9], [-0.8, -0.8]]);
      line([[0.5, -0.9], [0.9, -0.9], [0.9, -0.5]]); line([[-0.5, -0.9], [-0.9, -0.9], [-0.9, -0.5]]);
      break;
    case "tavern": // tankard
      line([[-0.6, -0.7], [0.4, -0.7], [0.4, 0.8], [-0.6, 0.8]], true);
      line([[0.4, -0.4], [0.85, -0.4], [0.85, 0.4], [0.4, 0.4]]);
      break;
    case "watchtower": // tall tower
      line([[-0.4, 0.95], [-0.3, -0.5], [0.3, -0.5], [0.4, 0.95]]);
      line([[-0.6, -0.5], [0, -1], [0.6, -0.5]], true);
      break;
    case "palisade": // stakes
      for (const u of [-0.7, -0.25, 0.2, 0.65]) line([[u, 0.9], [u, -0.5], [u + 0.12, -0.85], [u + 0.24, -0.5], [u + 0.24, 0.9]]);
      break;
    case "wall": // battlements
      line([[-0.95, 0.8], [-0.95, -0.6], [-0.6, -0.6], [-0.6, -0.25], [-0.2, -0.25], [-0.2, -0.6], [0.2, -0.6], [0.2, -0.25],
        [0.6, -0.25], [0.6, -0.6], [0.95, -0.6], [0.95, 0.8]], true);
      break;
    case "keep": // a keep: a tower with battlements and a door
      line([[-0.6, 0.95], [-0.6, -0.55], [-0.35, -0.55], [-0.35, -0.85], [-0.1, -0.85], [-0.1, -0.55], [0.1, -0.55], [0.1, -0.85],
        [0.35, -0.85], [0.35, -0.55], [0.6, -0.55], [0.6, 0.95]], true);
      line([[-0.2, 0.95], [-0.2, 0.45], [0.2, 0.45], [0.2, 0.95]]);
      break;
    case "shrine": // a spire over a ring
      line([[0, -1], [0, -0.3]]);
      line([[-0.3, -0.7], [0.3, -0.7]]);
      ctx.beginPath(); ctx.arc(0, 0.35, s * 0.5, 0, Math.PI * 2); ctx.stroke();
      break;
    case "hall": // a long hall
      line([[-0.95, 0.8], [-0.95, -0.1], [-0.5, -0.7], [0.5, -0.7], [0.95, -0.1], [0.95, 0.8]], true);
      line([[-0.95, -0.1], [0.95, -0.1]]);
      break;
    case "market": // an awning over a stall
      line([[-0.9, -0.3], [-0.6, -0.8], [0.6, -0.8], [0.9, -0.3]], true);
      line([[-0.6, -0.3], [-0.6, 0.9]]); line([[0.6, -0.3], [0.6, 0.9]]); line([[-0.8, 0.3], [0.8, 0.3]]);
      break;
  }
  ctx.restore();
}

function makeGrain(ctx: CanvasRenderingContext2D, doc: Document): CanvasPattern | null {
  try {
    const c = doc.createElement("canvas") as HTMLCanvasElement;
    c.width = 160;
    c.height = 160;
    const g = c.getContext("2d");
    if (!g) return null;
    let s = 0x1b873593;
    const next = (): number => {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      return ((s >>> 0) % 10000) / 10000;
    };
    for (let i = 0; i < 900; i++) {
      const dark = next() < 0.6;
      g.fillStyle = dark ? "rgba(90, 70, 40, " + (0.04 + next() * 0.06).toFixed(3) + ")"
        : "rgba(255, 250, 235, " + (0.05 + next() * 0.08).toFixed(3) + ")";
      const r = 0.4 + next() * 1.0;
      g.fillRect(next() * 160, next() * 160, r, r);
    }
    return ctx.createPattern(c, "repeat");
  } catch {
    return null;
  }
}
