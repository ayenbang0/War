/**
 * Draws the kingdom map: the map-table look of the battlefield, one layer up
 * (CLAUDE.md "Art direction"): parchment sheet on a darker table, province
 * washes, roads inked by surface, holdings as glyphs by kind and filled by
 * owner, province names lettered across their country, the king's counter
 * and his route, and the pen's ghost. Everything is procedural; there are no
 * image assets.
 *
 * NEVER WRITES SIM STATE. It reads the KingdomWorld it is handed and draws;
 * the only state it keeps is its own (a paper-grain pattern, label culling
 * scratch, and a few counters the e2e harness reads).
 *
 * Everything is drawn in SCREEN pixels from map positions through the camera,
 * rather than under a world transform, so line widths, glyphs and text stay
 * the same size at every zoom -- a road is a pen line on the table, not paint
 * on the ground -- and labels stay ≥ 14 px (U1-06).
 *
 * Owner identity is never colour alone (U1-01): hollow = unclaimed, solid with
 * a crown tick = the king's, hatched = sworn to the crown.
 *
 * The fog (K3a) is the king's knowledge (sim/kingdom/explore.ts): a holding
 * or road he has never seen or been told of is not drawn at all -- the sheet
 * there is bare parchment, as an explorer's map is -- except an unknown
 * holding at the end of a road he knows, which is drawn as an unnamed "?" so
 * the way to it can be seen and marched. Roads he remembers but cannot see
 * now are drawn fainter. A province's wash and name appear once one of its
 * holdings is known. A known site not yet set foot in carries a small
 * diamond: something to find there.
 */

import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { Holding } from "../../sim/kingdom/state.ts";
import type { RoadTerrainId } from "../../content/kingdom/terrain.ts";
import type { KingdomCamera } from "./camera.ts";
import { ARMY_COUNTER_RADIUS_PX, KING_COUNTER_RADIUS_PX, type MapPoint } from "./layout.ts";
import type { ArmyPosture } from "../../sim/kingdom/state.ts";
import * as P from "./palette.ts";
import { KING_PLAYER } from "../../content/kingdom/factions.ts";
import { KNOW_SEEN, KNOW_UNKNOWN } from "../../content/kingdom/exploration.ts";
import { holdingKnowledge, isFrontier, isUnfoundSite, roadKnowledge } from "../../sim/kingdom/explore.ts";

/** A stroke being drawn, or one fading out after release. */
export type InkStroke = {
  readonly points: readonly MapPoint[];
  /** march: ink; none: grey and dashed; tap: not drawn. */
  readonly style: "march" | "none" | "tap";
};

export type GhostView =
  | { readonly kind: "march"; readonly route: readonly MapPoint[]; readonly dest: MapPoint; readonly label: string }
  | { readonly kind: "none"; readonly label: string }
  | { readonly kind: "tap"; readonly label: string }
  | { readonly kind: "order"; readonly path: readonly MapPoint[]; readonly rings: readonly MapPoint[]; readonly label: string };

/**
 * One army counter as the layer hands it over (K4): the renderer reads no
 * army state itself, so what is drawn is exactly what the pen was given.
 * Identity is never colour alone: the king's armies are SHIELDS with their
 * ordinal numeral, another side's are DIAMONDS with its initial.
 */
export type ArmyDraw = {
  readonly id: number;
  readonly own: boolean;
  /** "I".."VIII" for the king's; a faction's initial for another's. */
  readonly mark: string;
  /** The true point (stem foot) and the counter's centre, in miles. */
  readonly at: MapPoint;
  readonly counter: MapPoint;
  readonly men: number;
  /** Another side's numbers are what scouts can count: rounded, and drawn as "~40". */
  readonly about: boolean;
  /** The king rides with this army: a crown tick on its shield. */
  readonly kingRides: boolean;
  /** Fit men as a percentage of a full army: the bar. */
  readonly strengthPct: number;
  /** Days of grain in its packs; -1 for another side's (unknown). */
  readonly supplyDays: number;
  readonly hungry: boolean;
  readonly posture: ArmyPosture;
  /** Its live march, from it through each holding still to reach (own armies only). */
  readonly route: readonly MapPoint[];
  readonly selected: boolean;
};

/** Short render-clock effects (game-feel small tier). Owned by the layer, drawn here. */
export type Pulse = { readonly at: MapPoint; readonly start: number; readonly duration: number };
export type Fade = { readonly stroke: InkStroke; readonly start: number; readonly duration: number };

export type KingdomFrame = {
  readonly world: KingdomWorld;
  readonly cam: KingdomCamera;
  /** The king's true map position, interpolated between ticks. */
  readonly king: MapPoint;
  /** Where his counter is drawn (layout.ts). */
  readonly counter: MapPoint;
  /** The march he is on: map points from him to the destination. Empty when still. */
  readonly route: readonly MapPoint[];
  /** A march ordered but not yet applied (issued while paused): drawn dotted. */
  readonly queued: readonly MapPoint[];
  readonly stroke: InkStroke | null;
  readonly ghost: GhostView | null;
  /** Tip of the pen, for the ghost's plate. */
  readonly tip: MapPoint | null;
  readonly fades: readonly Fade[];
  readonly pulses: readonly Pulse[];
  /** The holding whose card is open, or 0. */
  readonly selectedHolding: number;
  readonly kingSelected: boolean;
  /** K4: every army the king can see, in id order. */
  readonly armies?: readonly ArmyDraw[];
  readonly paused: boolean;
  /** Real seconds, for the effects. */
  readonly clock: number;
};

type Rect = { x0: number; y0: number; x1: number; y1: number };

const GLYPH_PX: Record<Holding["kind"], number> = { hamlet: 5, village: 6.5, town: 8, keep: 8, city: 11 };
const LABEL_PX: Record<Holding["kind"], number> = { hamlet: 14, village: 15, town: 16, keep: 16, city: 17 };
const LABEL_RANK: Record<Holding["kind"], number> = { city: 0, town: 1, keep: 1, village: 2, hamlet: 3 };
/** Below this zoom (px per mile) hamlet names are left to the card unless they matter right now. */
const HAMLET_LABEL_ZOOM = 1.5;
const WASH_MILES = 58;

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export class KingdomRenderer {
  /** Frames drawn, and what the last one drew: read by the e2e harness. */
  readonly stats = { frames: 0, holdings: 0, roads: 0, labels: 0, king: false, frontier: 0, hidden: 0, armies: 0 };

  private readonly ctx: CanvasRenderingContext2D;
  private grain: CanvasPattern | null = null;
  private readonly provinceLabels: { name: string; x: number; y: number; holdings: number[] }[] = [];
  private readonly seats = new Set<number>();

  constructor(ctx: CanvasRenderingContext2D, world: KingdomWorld, doc: Document) {
    this.ctx = ctx;
    this.grain = makeGrain(ctx, doc);
    for (const p of world.map.provinces) {
      const hs = world.holdings.filter((h) => h.province === p.id);
      if (hs.length === 0) continue;
      let x = 0;
      let y = 0;
      for (const h of hs) { x += h.x; y += h.y; }
      // Lettered a little below the province's middle, where its holdings
      // usually are not, so the name and the towns do not fight.
      this.provinceLabels.push({ name: p.name.toUpperCase(), x: x / hs.length, y: y / hs.length + 26, holdings: hs.map((h) => h.id) });
    }
    for (const def of world.map.holdings) {
      if (!def.seat) continue;
      const h = world.holdingByKey(def.key);
      if (h) this.seats.add(h.id);
    }
  }

  draw(f: KingdomFrame): void {
    const { ctx } = this;
    const { cam, world } = f;
    const W = cam.viewW;
    const H = cam.viewH;
    const sx = (x: number): number => cam.worldToScreenX(x);
    const sy = (y: number): number => cam.worldToScreenY(y);
    // K3a: what the king knows, read once per frame.
    const known = new Set<number>();
    const frontier = new Set<number>();
    for (const h of world.holdings) {
      if (holdingKnowledge(world, KING_PLAYER, h.id) !== KNOW_UNKNOWN) known.add(h.id);
      else if (isFrontier(world, KING_PLAYER, h.id)) frontier.add(h.id);
    }
    this.stats.frontier = frontier.size;
    this.stats.hidden = world.holdings.length - known.size - frontier.size;

    // -- the table and the sheet --------------------------------------------
    ctx.fillStyle = P.table;
    ctx.fillRect(0, 0, W, H);
    const map: Rect = { x0: sx(0), y0: sy(0), x1: sx(world.map.width), y1: sy(world.map.height) };
    ctx.fillStyle = P.sheet;
    ctx.fillRect(map.x0, map.y0, map.x1 - map.x0, map.y1 - map.y0);
    if (this.grain) {
      // Paper grain is the paper's, not the land's: it stays fine at every
      // zoom and slides with the sheet (anchored to the map's corner).
      ctx.save();
      ctx.translate(map.x0, map.y0);
      ctx.fillStyle = this.grain;
      ctx.fillRect(Math.max(0, -map.x0), Math.max(0, -map.y0),
        Math.min(map.x1, W) - Math.max(map.x0, 0), Math.min(map.y1, H) - Math.max(map.y0, 0));
      ctx.restore();
    }

    // -- province washes ------------------------------------------------------
    const washR = WASH_MILES * cam.zoom;
    for (const h of world.holdings) {
      if (!known.has(h.id)) continue;
      const x = sx(h.x);
      const y = sy(h.y);
      if (x < -washR || y < -washR || x > W + washR || y > H + washR) continue;
      const g = ctx.createRadialGradient(x, y, 0, x, y, washR);
      const c = P.PROVINCE_WASH[h.province] ?? P.inkLight;
      g.addColorStop(0, c);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - washR, y - washR, washR * 2, washR * 2);
    }

    // The sheet's frame: a double rule, as a printed map has.
    ctx.strokeStyle = P.inkMid;
    ctx.lineWidth = 2;
    ctx.strokeRect(map.x0, map.y0, map.x1 - map.x0, map.y1 - map.y0);
    ctx.lineWidth = 1;
    ctx.strokeRect(map.x0 + 5, map.y0 + 5, map.x1 - map.x0 - 10, map.y1 - map.y0 - 10);

    this.drawCompass(sx(52), sy(world.map.height - 52), Math.max(18, Math.min(46, 30 * cam.zoom)));

    // -- province names -------------------------------------------------------
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "italic 600 20px " + P.MAP_FONT;
    for (const p of this.provinceLabels) {
      if (!p.holdings.some((id) => known.has(id))) continue;
      const x = sx(p.x);
      const y = sy(p.y);
      if (x < -200 || x > W + 200 || y < -40 || y > H + 40) continue;
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(226, 214, 187, 0.7)";
      ctx.strokeText(spaced(p.name), x, y);
      ctx.fillStyle = P.inkMid;
      ctx.fillText(spaced(p.name), x, y);
    }

    // -- roads ---------------------------------------------------------------
    let roads = 0;
    for (const r of world.roads) {
      const a = world.holding(r.a);
      const b = world.holding(r.b);
      if (!a || !b) continue;
      const x0 = sx(a.x); const y0 = sy(a.y); const x1 = sx(b.x); const y1 = sy(b.y);
      if (Math.max(x0, x1) < -10 || Math.min(x0, x1) > W + 10 || Math.max(y0, y1) < -10 || Math.min(y0, y1) > H + 10) continue;
      const k = roadKnowledge(world, KING_PLAYER, r.id);
      if (k === KNOW_UNKNOWN) continue;
      // Remembered, not in sight: drawn fainter (and the sight edge is where it changes).
      ctx.save();
      if (k !== KNOW_SEEN) ctx.globalAlpha = 0.55;
      this.drawRoad(x0, y0, x1, y1, r.terrain);
      ctx.restore();
      roads++;
    }

    // -- routes: the queued one dotted, the one under way solid ----------------
    if (f.queued.length > 1) this.drawRoute(f.queued, f.cam, "queued");
    if (f.route.length > 1) this.drawRoute(f.route, f.cam, "live");

    // -- holdings --------------------------------------------------------------
    let holdings = 0;
    for (const h of world.holdings) {
      const x = sx(h.x);
      const y = sy(h.y);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      if (frontier.has(h.id)) {
        this.drawUnexplored(x, y);
        continue;
      }
      if (!known.has(h.id)) continue;
      this.drawHolding(h, x, y, h.id === f.selectedHolding);
      if (isUnfoundSite(world, KING_PLAYER, h.id)) this.drawSiteMark(x + GLYPH_PX[h.kind] + 3, y - GLYPH_PX[h.kind] - 3);
      holdings++;
    }

    // -- labels, by priority, culled where they would overlap -------------------
    const m = world.king.mover;
    const important = new Set<number>([f.selectedHolding, m.node, ...m.route]);
    if (f.ghost?.kind === "march" && f.stroke) {
      const end = f.ghost.dest;
      for (const h of world.holdings) if (h.x === end.x && h.y === end.y) important.add(h.id);
    }
    const order = world.holdings
      .filter((h) => {
        // Only what the king knows is named; an unexplored mark has no name.
        if (!known.has(h.id)) return false;
        const x = sx(h.x);
        const y = sy(h.y);
        return x > -150 && y > -30 && x < W + 30 && y < H + 30;
      })
      .sort((p, q) => {
        const ip = important.has(p.id) ? 0 : 1;
        const iq = important.has(q.id) ? 0 : 1;
        return ip - iq || LABEL_RANK[p.kind] - LABEL_RANK[q.kind] || p.id - q.id;
      });
    const taken: Rect[] = [];
    // The king's counter is never covered by a name, nor are the armies'.
    taken.push(circleRect(sx(f.counter.x), sy(f.counter.y), KING_COUNTER_RADIUS_PX + 4));
    for (const a of f.armies ?? []) taken.push(circleRect(sx(a.counter.x), sy(a.counter.y), ARMY_COUNTER_RADIUS_PX + 6));
    let labels = 0;
    for (const h of order) {
      if (h.kind === "hamlet" && cam.zoom < HAMLET_LABEL_ZOOM && !important.has(h.id)) continue;
      const size = LABEL_PX[h.kind];
      const bold = this.seats.has(h.id) || h.kind === "city";
      ctx.font = (bold ? "700 " : "500 ") + size + "px " + P.MAP_FONT;
      const w = ctx.measureText(h.name).width;
      const gx = sx(h.x);
      const gy = sy(h.y);
      const off = GLYPH_PX[h.kind] + 6;
      // Right of the glyph if it fits there, else left.
      let rect: Rect = { x0: gx + off, y0: gy - size * 0.62, x1: gx + off + w, y1: gy + size * 0.62 };
      let align: CanvasTextAlign = "left";
      if (taken.some((t) => overlaps(t, rect))) {
        rect = { x0: gx - off - w, y0: rect.y0, x1: gx - off, y1: rect.y1 };
        align = "right";
        if (taken.some((t) => overlaps(t, rect)) && !important.has(h.id)) continue;
      }
      taken.push(rect);
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = 4;
      ctx.strokeStyle = P.halo;
      const tx = align === "left" ? rect.x0 : rect.x1;
      ctx.strokeText(h.name, tx, gy);
      ctx.fillStyle = P.ink;
      ctx.fillText(h.name, tx, gy);
      labels++;
    }

    // -- armies (K4): their marches under them, then the counters ----------------
    const armies = f.armies ?? [];
    for (const a of armies) if (a.own && a.route.length > 1) this.drawRoute(a.route, f.cam, "live");
    for (const a of armies) this.drawArmy(a, sx(a.at.x), sy(a.at.y), sx(a.counter.x), sy(a.counter.y));

    // -- the king --------------------------------------------------------------
    this.drawKing(sx(f.king.x), sy(f.king.y), sx(f.counter.x), sy(f.counter.y), f.kingSelected);

    // -- feedback that outlives a stroke ----------------------------------------
    for (const fd of f.fades) {
      const t = Math.min(1, (f.clock - fd.start) / fd.duration);
      if (t >= 1) continue;
      this.drawStroke(fd.stroke, f.cam, 1 - t);
    }
    for (const p of f.pulses) {
      const t = Math.min(1, (f.clock - p.start) / p.duration);
      if (t >= 1) continue;
      const r = 10 + 18 * easeOutBack(t);
      ctx.beginPath();
      ctx.arc(sx(p.at.x), sy(p.at.y), r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(46, 74, 109, " + (0.85 * (1 - t)).toFixed(3) + ")";
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // -- the pen: ghost under the wet ink, plate on top ---------------------------
    if (f.ghost && f.ghost.kind === "march" && f.stroke) {
      this.drawRoute(f.ghost.route, f.cam, "ghost");
      const d = f.ghost.dest;
      ctx.beginPath();
      ctx.arc(sx(d.x), sy(d.y), 15, 0, Math.PI * 2);
      ctx.lineWidth = 5;
      ctx.strokeStyle = P.halo;
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = P.marchInk;
      ctx.stroke();
    }
    if (f.ghost && f.ghost.kind === "order" && f.stroke) {
      if (f.ghost.path.length > 1) this.drawRoute(f.ghost.path, f.cam, "ghost");
      for (const r of f.ghost.rings) {
        ctx.beginPath();
        ctx.arc(sx(r.x), sy(r.y), 17, 0, Math.PI * 2);
        ctx.lineWidth = 5;
        ctx.strokeStyle = P.halo;
        ctx.stroke();
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = P.marchInk;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (f.stroke) this.drawStroke(f.stroke, f.cam, 1);
    if (f.ghost && f.stroke && f.tip && f.ghost.kind !== "tap") {
      this.drawPlate(f.ghost.label, sx(f.tip.x), sy(f.tip.y), W, H, f.ghost.kind === "none");
    }

    if (f.paused) {
      ctx.fillStyle = "rgba(40, 32, 22, 0.14)";
      ctx.fillRect(0, 0, W, H);
    }

    this.stats.frames++;
    this.stats.armies = armies.length;
    this.stats.holdings = holdings;
    this.stats.roads = roads;
    this.stats.labels = labels;
    this.stats.king = sx(f.counter.x) > -KING_COUNTER_RADIUS_PX && sx(f.counter.x) < W + KING_COUNTER_RADIUS_PX &&
      sy(f.counter.y) > -KING_COUNTER_RADIUS_PX && sy(f.counter.y) < H + KING_COUNTER_RADIUS_PX;
  }

  // -- pieces -------------------------------------------------------------------

  private drawRoad(x0: number, y0: number, x1: number, y1: number, surface: RoadTerrainId): void {
    const { ctx } = this;
    ctx.save();
    ctx.lineCap = "round";
    const line = (w: number, style: string, dash: number[]): void => {
      ctx.setLineDash(dash);
      ctx.lineWidth = w;
      ctx.strokeStyle = style;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    };
    switch (surface) {
      case "highway":
        // A cased double line: the king's highway.
        line(5, P.inkStrong, []);
        line(2, P.sheet, []);
        break;
      case "road":
        line(2.4, P.inkStrong, []);
        break;
      case "track":
        line(2, P.inkMid, [7, 5]);
        break;
      case "forest":
        line(2.6, "rgba(60, 86, 52, 0.8)", [1, 5]);
        break;
      case "moor":
      case "pass":
        line(2, P.inkMid, [8, 3, 2, 3]);
        break;
      case "ford":
      case "ferry": {
        line(2.4, "rgba(60, 92, 120, 0.85)", [4, 4]);
        // A crossing tick at the middle: where the water is.
        const mx = (x0 + x1) / 2;
        const my = (y0 + y1) / 2;
        const len = Math.hypot(x1 - x0, y1 - y0) || 1;
        const nx = (-(y1 - y0) / len) * 6;
        const ny = ((x1 - x0) / len) * 6;
        ctx.setLineDash([]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "rgba(60, 92, 120, 0.85)";
        ctx.beginPath();
        ctx.moveTo(mx - nx, my - ny);
        ctx.lineTo(mx + nx, my + ny);
        ctx.stroke();
        break;
      }
    }
    ctx.restore();
  }

  private drawRoute(pts: readonly MapPoint[], cam: KingdomCamera, kind: "live" | "queued" | "ghost"): void {
    const { ctx } = this;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const trace = (): void => {
      ctx.beginPath();
      ctx.moveTo(cam.worldToScreenX(pts[0].x), cam.worldToScreenY(pts[0].y));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(cam.worldToScreenX(pts[i].x), cam.worldToScreenY(pts[i].y));
    };
    // PC-16: a light halo under the ink, so the route reads over any wash.
    ctx.setLineDash([]);
    ctx.lineWidth = kind === "ghost" ? 8 : 7;
    ctx.strokeStyle = P.halo;
    trace();
    ctx.stroke();
    ctx.lineWidth = kind === "ghost" ? 3.5 : 3;
    ctx.strokeStyle = P.marchInk;
    ctx.globalAlpha = kind === "queued" ? 0.85 : 0.95;
    ctx.setLineDash(kind === "queued" ? [2, 7] : kind === "ghost" ? [11, 6] : []);
    trace();
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (kind === "live") {
      // A pennant at the destination.
      const d = pts[pts.length - 1];
      const x = cam.worldToScreenX(d.x);
      const y = cam.worldToScreenY(d.y);
      ctx.setLineDash([]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = P.ink;
      ctx.beginPath();
      ctx.moveTo(x, y - 4);
      ctx.lineTo(x, y - 26);
      ctx.stroke();
      ctx.fillStyle = P.kingColor;
      ctx.beginPath();
      ctx.moveTo(x, y - 26);
      ctx.lineTo(x + 14, y - 21);
      ctx.lineTo(x, y - 16);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /** An unknown holding at the end of a known road: a ringed "?" (K3a). */
  private drawUnexplored(x: number, y: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = P.halo;
    ctx.fill();
    ctx.setLineDash([2.5, 2.5]);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = P.inkMid;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "700 13px " + P.MAP_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = P.ink;
    ctx.fillText("?", x, y + 0.5);
    ctx.restore();
  }

  /** A known site the party has not yet set foot in: a small diamond by its glyph (K3a). */
  private drawSiteMark(x: number, y: number): void {
    const { ctx } = this;
    const r = 4;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.fillStyle = P.marchInk;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = P.halo;
    ctx.stroke();
    ctx.restore();
  }

  private drawHolding(h: Holding, x: number, y: number, selected: boolean): void {
    const { ctx } = this;
    const r = GLYPH_PX[h.kind];
    const owner = h.owner === null ? "none" : h.owner === "king" ? "king" : "crown";
    ctx.save();
    // The glyph's outline, by kind.
    const outline = (): void => {
      ctx.beginPath();
      switch (h.kind) {
        case "hamlet":
        case "village":
          ctx.arc(x, y, r, 0, Math.PI * 2);
          break;
        case "town":
          ctx.rect(x - r, y - r, r * 2, r * 2);
          break;
        case "keep": {
          // A square with two merlons: a tower seen from above, as a map draws it.
          const m = r * 0.55;
          ctx.moveTo(x - r, y + r);
          ctx.lineTo(x - r, y - r);
          ctx.lineTo(x - r + m, y - r);
          ctx.lineTo(x - r + m, y - r + m * 0.7);
          ctx.lineTo(x + r - m, y - r + m * 0.7);
          ctx.lineTo(x + r - m, y - r);
          ctx.lineTo(x + r, y - r);
          ctx.lineTo(x + r, y + r);
          ctx.closePath();
          break;
        }
        case "city":
          ctx.arc(x, y, r, 0, Math.PI * 2);
          break;
      }
    };
    // Fill by owner.
    outline();
    ctx.fillStyle = owner === "king" ? P.kingColor : P.sheet;
    ctx.fill();
    if (owner === "crown") {
      ctx.save();
      outline();
      ctx.clip();
      ctx.strokeStyle = P.crownColor;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let k = -2 * r; k <= 2 * r; k += 3.6) {
        ctx.moveTo(x + k - r, y + r);
        ctx.lineTo(x + k + r, y - r);
      }
      ctx.stroke();
      ctx.restore();
    }
    outline();
    ctx.lineWidth = h.kind === "city" ? 2.6 : 1.8;
    ctx.strokeStyle = P.ink;
    ctx.stroke();
    if (h.kind === "village") {
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = P.ink;
      ctx.fill();
    }
    if (h.kind === "city") {
      // Wall ticks round the city.
      ctx.beginPath();
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        ctx.lineTo(x + Math.cos(a) * (r + 3.5), y + Math.sin(a) * (r + 3.5));
      }
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    if (owner === "king") {
      // The crown tick: a small chevron above the glyph.
      ctx.beginPath();
      ctx.moveTo(x - 4, y - r - 3);
      ctx.lineTo(x - 2, y - r - 7);
      ctx.lineTo(x, y - r - 4);
      ctx.lineTo(x + 2, y - r - 7);
      ctx.lineTo(x + 4, y - r - 3);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (this.seats.has(h.id)) {
      // A seat: a second ring, so it reads at a glance and in greyscale.
      ctx.beginPath();
      ctx.arc(x, y, r + (h.kind === "city" ? 7 : 4.5), 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = P.inkMid;
      ctx.stroke();
    }
    if (selected) {
      // Selection is a SOLID double ring; dashes are kept for orders (PC-15).
      for (const [rr, w, c] of [[r + 10, 5, P.halo], [r + 10, 2.5, P.marchInk]] as const) {
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.lineWidth = w;
        ctx.strokeStyle = c;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawKing(tx: number, ty: number, cx: number, cy: number, selected: boolean): void {
    const { ctx } = this;
    const r = KING_COUNTER_RADIUS_PX;
    ctx.save();
    // The stem, from the counter down to where the king actually is.
    ctx.lineWidth = 4;
    ctx.strokeStyle = P.halo;
    ctx.beginPath();
    ctx.moveTo(cx, cy + r);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = P.ink;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tx, ty, 3, 0, Math.PI * 2);
    ctx.fillStyle = P.ink;
    ctx.fill();
    // The counter.
    ctx.beginPath();
    ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
    ctx.fillStyle = P.halo;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = P.kingColor;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = P.ink;
    ctx.stroke();
    // A crown, in parchment on the blue: three points on a band.
    ctx.beginPath();
    ctx.moveTo(cx - 7, cy + 4);
    ctx.lineTo(cx - 7, cy - 4);
    ctx.lineTo(cx - 3.5, cy);
    ctx.lineTo(cx, cy - 6);
    ctx.lineTo(cx + 3.5, cy);
    ctx.lineTo(cx + 7, cy - 4);
    ctx.lineTo(cx + 7, cy + 4);
    ctx.closePath();
    ctx.fillStyle = "#f2ead6";
    ctx.fill();
    if (selected) {
      for (const [w, c] of [[5, P.halo], [2.5, P.marchInk]] as const) {
        ctx.beginPath();
        ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
        ctx.lineWidth = w;
        ctx.strokeStyle = c;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * An army counter (K4): a stem from its true point, the counter (shield or
   * diamond, with its mark), a posture badge, and under it the men, a
   * strength bar and the days of grain -- numbers in words, not a bar alone.
   */
  private drawArmy(a: ArmyDraw, tx: number, ty: number, cx: number, cy: number): void {
    const { ctx } = this;
    const r = ARMY_COUNTER_RADIUS_PX;
    ctx.save();
    ctx.lineWidth = 4;
    ctx.strokeStyle = P.halo;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(cx, cy - r);
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = P.ink;
    ctx.stroke();
    const shape = (grow: number): void => {
      ctx.beginPath();
      const g = r + grow;
      if (a.own) {
        // A shield: square shoulders, a point below.
        ctx.moveTo(cx - g, cy - g);
        ctx.lineTo(cx + g, cy - g);
        ctx.lineTo(cx + g, cy + g * 0.25);
        ctx.quadraticCurveTo(cx + g * 0.8, cy + g * 0.9, cx, cy + g * 1.2);
        ctx.quadraticCurveTo(cx - g * 0.8, cy + g * 0.9, cx - g, cy + g * 0.25);
        ctx.closePath();
      } else {
        ctx.moveTo(cx, cy - g * 1.15);
        ctx.lineTo(cx + g * 1.15, cy);
        ctx.lineTo(cx, cy + g * 1.15);
        ctx.lineTo(cx - g * 1.15, cy);
        ctx.closePath();
      }
    };
    shape(3);
    ctx.fillStyle = P.halo;
    ctx.fill();
    shape(0);
    ctx.fillStyle = a.own ? P.kingColor : P.crownColor;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = P.ink;
    ctx.stroke();
    ctx.fillStyle = "#f2ead6";
    ctx.font = "700 " + (a.mark.length > 2 ? 10 : 12) + "px " + P.MAP_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(a.mark, cx, cy + 0.5);
    // Posture: a small badge at the top right (hold: a wall; patrol: a loop; recover: a cross).
    if (a.posture !== "none") {
      const bx = cx + r + 1;
      const by = cy - r - 1;
      ctx.beginPath();
      ctx.arc(bx, by, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = P.plate;
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = P.ink;
      ctx.stroke();
      ctx.beginPath();
      if (a.posture === "hold") {
        ctx.rect(bx - 3.5, by - 1.5, 7, 4);
        ctx.moveTo(bx - 3.5, by - 1.5); ctx.lineTo(bx - 3.5, by - 3.5);
        ctx.moveTo(bx, by - 1.5); ctx.lineTo(bx, by - 3.5);
        ctx.moveTo(bx + 3.5, by - 1.5); ctx.lineTo(bx + 3.5, by - 3.5);
      } else if (a.posture === "patrol") {
        ctx.arc(bx, by, 3.2, -Math.PI * 0.2, Math.PI * 1.5);
        ctx.moveTo(bx + 3.2, by - 2.5); ctx.lineTo(bx + 3.2, by); ctx.lineTo(bx + 0.8, by - 0.6);
      } else {
        ctx.moveTo(bx - 3.5, by); ctx.lineTo(bx + 3.5, by);
        ctx.moveTo(bx, by - 3.5); ctx.lineTo(bx, by + 3.5);
      }
      ctx.stroke();
    }
    // Under it: men and grain in words, and the strength bar.
    if (a.kingRides) {
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy - r - 1);
      ctx.lineTo(cx - 5, cy - r - 6);
      ctx.lineTo(cx - 2.5, cy - r - 3.5);
      ctx.lineTo(cx, cy - r - 7.5);
      ctx.lineTo(cx + 2.5, cy - r - 3.5);
      ctx.lineTo(cx + 5, cy - r - 6);
      ctx.lineTo(cx + 5, cy - r - 1);
      ctx.closePath();
      ctx.fillStyle = P.kingColor;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = P.halo;
      ctx.stroke();
    }
    const label = (a.about ? "~" : "") + a.men + (a.supplyDays >= 0 ? " · " + a.supplyDays + "d" : "");
    ctx.font = "600 11px " + P.MAP_FONT;
    const ly = cy + r * 1.2 + 9;
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = P.halo;
    ctx.strokeText(label, cx, ly);
    ctx.fillStyle = a.hungry ? P.crownColor : P.ink;
    ctx.fillText(label, cx, ly);
    if (a.hungry) {
      // Hunger in a glyph as well as a colour: a mark after the numbers.
      ctx.font = "700 11px " + P.MAP_FONT;
      const w = ctx.measureText(label).width;
      ctx.strokeText("!", cx + w / 2 + 5, ly);
      ctx.fillText("!", cx + w / 2 + 5, ly);
    }
    const bw = 26;
    const by2 = ly + 7;
    ctx.fillStyle = P.halo;
    ctx.fillRect(cx - bw / 2 - 1, by2 - 1, bw + 2, 6);
    ctx.fillStyle = P.inkLight;
    ctx.fillRect(cx - bw / 2, by2, bw, 4);
    ctx.fillStyle = a.own ? P.kingColor : P.crownColor;
    ctx.fillRect(cx - bw / 2, by2, Math.round((bw * Math.max(0, Math.min(100, a.strengthPct))) / 100), 4);
    if (a.selected) {
      for (const [w, c] of [[5, P.halo], [2.5, P.marchInk]] as const) {
        ctx.beginPath();
        ctx.arc(cx, cy, r + 9, 0, Math.PI * 2);
        ctx.lineWidth = w;
        ctx.strokeStyle = c;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawStroke(s: InkStroke, cam: KingdomCamera, alpha: number): void {
    if (s.style === "tap" || s.points.length < 2) return;
    const { ctx } = this;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const trace = (): void => {
      ctx.beginPath();
      ctx.moveTo(cam.worldToScreenX(s.points[0].x), cam.worldToScreenY(s.points[0].y));
      for (let i = 1; i < s.points.length; i++) {
        ctx.lineTo(cam.worldToScreenX(s.points[i].x), cam.worldToScreenY(s.points[i].y));
      }
    };
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 6;
    ctx.strokeStyle = P.halo;
    trace();
    ctx.stroke();
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = s.style === "march" ? P.marchInk : P.noneInk;
    if (s.style === "none") ctx.setLineDash([6, 5]);
    trace();
    ctx.stroke();
    ctx.restore();
  }

  /** The ghost's label at the pen tip, kept inside the view (PC-17). */
  private drawPlate(text: string, x: number, y: number, W: number, H: number, muted: boolean): void {
    const { ctx } = this;
    ctx.save();
    ctx.font = "700 16px " + P.MAP_FONT;
    const w = ctx.measureText(text).width + 18;
    const h = 28;
    let px = x + 18;
    let py = y - 18 - h;
    if (px + w > W - 8) px = x - 18 - w;
    if (px < 8) px = 8;
    if (py < 8) py = y + 18;
    if (py + h > H - 8) py = H - 8 - h;
    ctx.fillStyle = P.plate;
    ctx.strokeStyle = muted ? P.noneInk : P.plateEdge;
    ctx.lineWidth = 1.5;
    if (muted) ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.rect(px, py, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = muted ? "#5f5138" : P.ink;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, px + 9, py + h / 2 + 1);
    ctx.restore();
  }

  private drawCompass(x: number, y: number, size: number): void {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = P.inkMid;
    ctx.fillStyle = P.inkMid;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x, y, size * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 - Math.PI / 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(x + ca * size, y + sa * size);
      ctx.lineTo(x - sa * size * 0.16, y + ca * size * 0.16);
      ctx.lineTo(x + sa * size * 0.16, y - ca * size * 0.16);
      ctx.closePath();
      if (i === 0) ctx.fill();
      else ctx.stroke();
    }
    ctx.font = "700 15px " + P.MAP_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("N", x, y - size - 2);
    ctx.restore();
  }
}

function spaced(s: string): string {
  return s.split("").join(" ");
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function circleRect(x: number, y: number, r: number): Rect {
  return { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
}

/**
 * Paper grain: a small tile of faint flecks, drawn once. Deterministic (a
 * fixed integer hash, not Math.random) so the paper never shimmers between
 * sessions -- it is the same sheet every time.
 */
function makeGrain(ctx: CanvasRenderingContext2D, doc: Document): CanvasPattern | null {
  try {
    const c = doc.createElement("canvas") as HTMLCanvasElement;
    c.width = 192;
    c.height = 192;
    const g = c.getContext("2d");
    if (!g) return null;
    let s = 0x2545f491;
    const next = (): number => {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      return ((s >>> 0) % 10000) / 10000;
    };
    for (let i = 0; i < 1400; i++) {
      const dark = next() < 0.6;
      g.fillStyle = dark ? "rgba(90, 70, 40, " + (0.04 + next() * 0.07).toFixed(3) + ")"
        : "rgba(255, 250, 235, " + (0.06 + next() * 0.1).toFixed(3) + ")";
      const r = 0.4 + next() * 1.1;
      g.fillRect(next() * 192, next() * 192, r, r);
    }
    return ctx.createPattern(c, "repeat");
  } catch {
    return null;
  }
}
