/**
 * The camera over the kingdom map: the battle camera's maths, one layer up,
 * with the two things U0 found wrong with it fixed for this layer.
 *
 *  - ZOOM BOUNDS COME FROM THE VIEWPORT (PC-20, U1-02). The battle's limits are
 *    module constants in world units per pixel, so a bigger monitor sees more
 *    of the field. Here `minZoom` is whatever fits the whole realm (plus a
 *    margin) in the current window, and `maxZoom` shows about MAX_ZOOM_MILES
 *    across the window's shorter side; both are recomputed on every resize, so
 *    the same zoom level means the same thing on every screen. The strategic
 *    layer may show the whole realm at once (it has no fog until a later
 *    phase; docs/PROVISIONAL.md K2.4).
 *  - AN EASED FLY-TO EXISTS (PC-24) for framing the king, duration-based on
 *    real time, ease-in-out, cancelled by any manual camera input, and a cut
 *    when the player asked for reduced motion.
 *
 * The view, not the centre, is clamped to the map plus a margin of table, and
 * an axis the view is wider than is centred (camera-systems: "clamp the view,
 * not the centre").
 *
 * Zoom is screen pixels per map mile. Render side only: nothing here is sim
 * state, and nothing in the sim reads it.
 */

/** Miles of table shown beyond the map's edge, so an edge holding is never jammed against the HUD. */
export const TABLE_MARGIN_MILES = 40;
/** At most zoom, this many miles span the window's shorter side. */
export const MAX_ZOOM_MILES = 140;
/** The opening view spans about this many miles across the shorter side: the Reach and its roads out. */
export const OPENING_MILES = 330;

type Flight = {
  readonly x0: number; readonly y0: number; readonly z0: number;
  readonly x1: number; readonly y1: number; readonly z1: number;
  readonly duration: number;
  t: number;
};

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export class KingdomCamera {
  /** Map point (miles) at the centre of the view. */
  x = 0;
  y = 0;
  /** Screen pixels per mile. */
  zoom = 1;
  viewW = 1;
  viewH = 1;
  minZoom = 0.5;
  maxZoom = 6;

  private readonly mapW: number;
  private readonly mapH: number;
  private flight: Flight | null = null;

  constructor(mapW: number, mapH: number) {
    this.mapW = mapW;
    this.mapH = mapH;
    this.x = mapW / 2;
    this.y = mapH / 2;
  }

  /** Miles per screen pixel at the current zoom: what the recogniser's pixel tolerances scale by. */
  get pxToWorld(): number {
    return 1 / this.zoom;
  }

  setViewport(w: number, h: number): void {
    this.viewW = Math.max(1, w);
    this.viewH = Math.max(1, h);
    const m = TABLE_MARGIN_MILES * 2;
    this.minZoom = Math.min(this.viewW / (this.mapW + m), this.viewH / (this.mapH + m));
    // Never let the two bounds cross on a tiny window.
    this.maxZoom = Math.max(this.minZoom * 3, Math.min(this.viewW, this.viewH) / MAX_ZOOM_MILES);
    this.zoom = this.clampZoom(this.zoom);
    this.clampToMap();
  }

  /** Zoom that shows about `miles` across the shorter side, inside the bounds. */
  zoomForSpan(miles: number): number {
    return this.clampZoom(Math.min(this.viewW, this.viewH) / miles);
  }

  worldToScreenX(wx: number): number {
    return (wx - this.x) * this.zoom + this.viewW / 2;
  }

  worldToScreenY(wy: number): number {
    return (wy - this.y) * this.zoom + this.viewH / 2;
  }

  screenToWorldX(sx: number): number {
    return (sx - this.viewW / 2) / this.zoom + this.x;
  }

  screenToWorldY(sy: number): number {
    return (sy - this.viewH / 2) / this.zoom + this.y;
  }

  /** Grab-the-paper pan: the ground under the cursor follows the cursor. */
  panByScreen(dx: number, dy: number): void {
    this.flight = null;
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clampToMap();
  }

  panByWorld(dx: number, dy: number): void {
    this.flight = null;
    this.x += dx;
    this.y += dy;
    this.clampToMap();
  }

  /** Zoom about a screen point, so the map under the cursor stays put. */
  zoomAt(sx: number, sy: number, factor: number): void {
    this.flight = null;
    const wx = this.screenToWorldX(sx);
    const wy = this.screenToWorldY(sy);
    const next = this.clampZoom(this.zoom * factor);
    if (next === this.zoom) return;
    this.zoom = next;
    this.x = wx - (sx - this.viewW / 2) / this.zoom;
    this.y = wy - (sy - this.viewH / 2) / this.zoom;
    this.clampToMap();
  }

  /** Jump straight there: entering the layer, or a fly-to under reduced motion. */
  cut(x: number, y: number, zoom: number = this.zoom): void {
    this.flight = null;
    this.zoom = this.clampZoom(zoom);
    this.x = x;
    this.y = y;
    this.clampToMap();
  }

  /** Ease to a framing over `duration` real seconds. A new manual input cancels it. */
  flyTo(x: number, y: number, zoom: number, duration: number): void {
    if (duration <= 0) {
      this.cut(x, y, zoom);
      return;
    }
    this.flight = { x0: this.x, y0: this.y, z0: this.zoom, x1: x, y1: y, z1: this.clampZoom(zoom), duration, t: 0 };
  }

  get flying(): boolean {
    return this.flight !== null;
  }

  /** Advance a fly-to. `dt` is real seconds; camera motion is not simulation. */
  update(dt: number): void {
    const f = this.flight;
    if (!f) return;
    f.t = Math.min(1, f.t + dt / f.duration);
    const e = easeInOut(f.t);
    this.zoom = f.z0 + (f.z1 - f.z0) * e;
    this.x = f.x0 + (f.x1 - f.x0) * e;
    this.y = f.y0 + (f.y1 - f.y0) * e;
    this.clampToMap();
    if (f.t >= 1) this.flight = null;
  }

  /** Visible map rectangle, in miles. */
  bounds(): { x0: number; y0: number; x1: number; y1: number } {
    const hw = this.viewW / 2 / this.zoom;
    const hh = this.viewH / 2 / this.zoom;
    return { x0: this.x - hw, y0: this.y - hh, x1: this.x + hw, y1: this.y + hh };
  }

  private clampZoom(z: number): number {
    return Math.min(this.maxZoom, Math.max(this.minZoom, z));
  }

  private clampToMap(): void {
    const m = TABLE_MARGIN_MILES;
    const hw = this.viewW / 2 / this.zoom;
    const hh = this.viewH / 2 / this.zoom;
    const w = this.mapW + 2 * m;
    const h = this.mapH + 2 * m;
    this.x = hw * 2 >= w ? this.mapW / 2 : Math.min(this.mapW + m - hw, Math.max(-m + hw, this.x));
    this.y = hh * 2 >= h ? this.mapH / 2 : Math.min(this.mapH + m - hh, Math.max(-m + hh, this.y));
  }
}
