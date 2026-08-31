/**
 * Camera navigation.
 *
 * The LEFT pointer button is deliberately untouched here: it belongs to the pen,
 * and Phase 2 binds it to gesture strokes. Panning therefore lives on the middle
 * and right buttons, on the keyboard, and on screen-edge push. Wiring pan to
 * left-drag now would mean tearing it out again in one phase's time.
 */

import type { Camera } from "../render/camera.ts";

const KEY_PAN_SPEED = 900; // world units per second at zoom 1
const EDGE_MARGIN = 24; // px
const EDGE_PAN_SPEED = 700;
const ZOOM_STEP = 1.0015;
/** Zoom multiplier per second while an arrow key is held. */
const KEY_ZOOM_RATE = 2.6;

export class CameraControls {
  private keys = new Set<string>();
  private pointerX = 0;
  private pointerY = 0;
  private pointerInside = false;

  private readonly cam: Camera;

  constructor(canvas: HTMLCanvasElement, cam: Camera) {
    // The canvas is still where wheel and pointer-position events arrive.
    this.cam = cam;
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  private onPointerMove = (e: PointerEvent): void => {
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    this.pointerInside = true;
  };

  private onPointerLeave = (): void => {
    this.pointerInside = false;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // Exponential in the raw delta so trackpads and notched wheels both feel right.
    this.cam.zoomAt(e.clientX, e.clientY, Math.pow(ZOOM_STEP, -e.deltaY));
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.key.toLowerCase());
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  /** Dropping keys on blur prevents the camera drifting forever after alt-tab. */
  private onBlur = (): void => {
    this.keys.clear();
  };

  /** Continuous panning. `dt` is real seconds; camera motion is not simulation. */
  update(dt: number): void {
    let dx = 0;
    let dy = 0;
    const k = this.keys;
    if (k.has("a") || k.has("arrowleft")) dx -= 1;
    if (k.has("d") || k.has("arrowright")) dx += 1;
    if (k.has("w")) dy -= 1;
    if (k.has("s")) dy += 1;

    // Up and down zoom rather than pan. Zooming is the more common intent on a
    // map this size, and WASD still covers panning in all four directions.
    let zoom = 0;
    if (k.has("arrowup")) zoom += 1;
    if (k.has("arrowdown")) zoom -= 1;
    if (zoom !== 0) {
      // About the viewport centre, since the keyboard has no cursor to zoom at.
      this.cam.zoomAt(
        this.cam.viewW / 2, this.cam.viewH / 2,
        Math.pow(KEY_ZOOM_RATE, zoom * dt),
      );
    }

    if (dx !== 0 || dy !== 0) {
      const inv = 1 / Math.hypot(dx, dy);
      const speed = (KEY_PAN_SPEED * dt) / this.cam.zoom;
      this.cam.panByWorld(dx * inv * speed, dy * inv * speed);
    }

    if (this.pointerInside) {
      let ex = 0;
      let ey = 0;
      if (this.pointerX < EDGE_MARGIN) ex -= 1;
      if (this.pointerX > this.cam.viewW - EDGE_MARGIN) ex += 1;
      if (this.pointerY < EDGE_MARGIN) ey -= 1;
      if (this.pointerY > this.cam.viewH - EDGE_MARGIN) ey += 1;
      if (ex !== 0 || ey !== 0) {
        const speed = (EDGE_PAN_SPEED * dt) / this.cam.zoom;
        this.cam.panByWorld(ex * speed, ey * speed);
      }
    }
  }
}
