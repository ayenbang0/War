/**
 * Zoom-through between layers (K3b; camera-systems: layer-transition framing).
 *
 * The wheel zooms the map about the cursor and stops at the camera's limit.
 * Wheeling ON past that limit is how the player asks to go a layer down (past
 * the kingdom map's closest zoom, over a holding of theirs: into its city) or
 * up (past the city's widest zoom: back to the map). It must be deliberate:
 * the overflow is ADDED UP from wheel deltas that arrive while the camera is
 * already at its limit, and only a build-up of OVERFLOW_PX (about two notches
 * of a mouse wheel; many small trackpad deltas) goes through. It is cleared by
 * a wheel the other way, by the pointer leaving the target, and by
 * IDLE_SECONDS without a qualifying wheel -- so the one notch that brought the
 * camera to its limit, or a stray flick, never changes layer.
 *
 * Its own wheel listener, which reads the camera but never moves it: the
 * camera's controls keep the wheel's zoom. It must be attached BEFORE those
 * controls, so that it sees whether the camera was at its limit before this
 * very event zoomed it (listeners on one target run in the order added).
 */

/** Wheel pixels past the limit that take you through. */
export const OVERFLOW_PX = 220;
/** A build-up is forgotten after this long with no wheel past the limit. */
export const IDLE_SECONDS = 0.6;
const LINE_PX = 16;
const PAGE_PX = 400;

export type ZoomThroughSpec = {
  /** "in" counts wheel-toward (deltaY < 0); "out" counts wheel-away. */
  readonly direction: "in" | "out";
  /** True while the camera is at the limit in that direction. Read before the camera moves. */
  atLimit(): boolean;
  /**
   * What the pointer is over, at screen point (sx, sy) in canvas pixels:
   * a target to go through to (any number, e.g. a holding id), "refused" for
   * something that cannot be entered (said once per build-up), or null.
   */
  target(sx: number, sy: number): number | "refused" | null;
  through(target: number, sx: number, sy: number): void;
  refused?(sx: number, sy: number): void;
};

export class ZoomThrough {
  /** The overflow built up so far, in wheel pixels (read by the tests). */
  push = 0;
  private idle = 0;
  private target: number | null = null;
  private saidRefused = false;
  private enabled = true;
  private readonly canvas: HTMLCanvasElement;
  private readonly spec: ZoomThroughSpec;

  constructor(canvas: HTMLCanvasElement, spec: ZoomThroughSpec) {
    this.canvas = canvas;
    this.spec = spec;
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  dispose(): void {
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.reset();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.reset();
  }

  reset(): void {
    this.push = 0;
    this.idle = 0;
    this.target = null;
    this.saidRefused = false;
  }

  /** Real seconds: forget a build-up that stopped. */
  update(dt: number): void {
    if (this.push === 0) return;
    this.idle += dt;
    if (this.idle > IDLE_SECONDS) this.reset();
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    const raw = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * PAGE_PX : e.deltaY;
    const toward = this.spec.direction === "in" ? -raw : raw;
    if (!(toward > 0)) {
      if (toward < 0) this.reset();
      return;
    }
    if (!this.spec.atLimit()) {
      // This notch is still zooming the camera: nothing builds up yet.
      this.reset();
      return;
    }
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const t = this.spec.target(sx, sy);
    if (t === null) {
      this.reset();
      return;
    }
    if (t === "refused") {
      if (!this.saidRefused) this.spec.refused?.(sx, sy);
      this.saidRefused = true;
      this.push = 0;
      this.target = null;
      return;
    }
    if (this.target !== t) {
      this.push = 0;
      this.target = t;
    }
    this.push += toward;
    this.idle = 0;
    if (this.push >= OVERFLOW_PX) {
      this.reset();
      this.spec.through(t, sx, sy);
    }
  };
}
