/**
 * Viewport over the battlefield.
 *
 * The player never sees the whole map at once (spec section 8.1), so the camera
 * is clamped to map bounds and the zoom range is deliberately narrow -- wide
 * enough to read a flank, never wide enough to survey everything.
 */

export const MIN_ZOOM = 0.35;
export const MAX_ZOOM = 2.4;

export class Camera {
  /** World-space point at the centre of the viewport. */
  x = 0;
  y = 0;
  zoom = 1;
  viewW = 1;
  viewH = 1;

  private readonly worldW: number;
  private readonly worldH: number;

  constructor(worldW: number, worldH: number) {
    this.worldW = worldW;
    this.worldH = worldH;
  }

  setViewport(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
    this.clampToWorld();
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

  panByScreen(dxScreen: number, dyScreen: number): void {
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
    this.clampToWorld();
  }

  panByWorld(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
    this.clampToWorld();
  }

  /** Zoom about a screen point, so the world under the cursor stays put. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const wx = this.screenToWorldX(sx);
    const wy = this.screenToWorldY(sy);
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    if (next === this.zoom) return;
    this.zoom = next;
    // Solve for the camera centre that keeps (wx, wy) under (sx, sy).
    this.x = wx - (sx - this.viewW / 2) / this.zoom;
    this.y = wy - (sy - this.viewH / 2) / this.zoom;
    this.clampToWorld();
  }

  /** Visible world-space rectangle. */
  bounds(): { x0: number; y0: number; x1: number; y1: number } {
    const hw = this.viewW / 2 / this.zoom;
    const hh = this.viewH / 2 / this.zoom;
    return { x0: this.x - hw, y0: this.y - hh, x1: this.x + hw, y1: this.y + hh };
  }

  private clampToWorld(): void {
    const hw = this.viewW / 2 / this.zoom;
    const hh = this.viewH / 2 / this.zoom;
    // When the map is narrower than the viewport, centre it rather than jamming
    // it to an edge.
    this.x = hw * 2 >= this.worldW ? this.worldW / 2 : Math.min(this.worldW - hw, Math.max(hw, this.x));
    this.y = hh * 2 >= this.worldH ? this.worldH / 2 : Math.min(this.worldH - hh, Math.max(hh, this.y));
  }
}
