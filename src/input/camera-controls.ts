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

export class CameraControls {
  private keys = new Set<string>();
  private panning = false;
  private lastX = 0;
  private lastY = 0;
  private pointerX = 0;
  private pointerY = 0;
  private pointerInside = false;
  private activePointer: number | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly cam: Camera;

  constructor(canvas: HTMLCanvasElement, cam: Camera) {
    this.canvas = canvas;
    this.cam = cam;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  private onPointerDown = (e: PointerEvent): void => {
    // button 1 = middle, 2 = right. Left (0) is reserved for pen gestures.
    if (e.button !== 1 && e.button !== 2) return;
    e.preventDefault();
    this.panning = true;
    this.activePointer = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.classList.add("panning");
  };

  private onPointerMove = (e: PointerEvent): void => {
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    this.pointerInside = true;
    if (!this.panning || e.pointerId !== this.activePointer) return;
    this.cam.panByScreen(e.clientX - this.lastX, e.clientY - this.lastY);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.activePointer) return;
    this.panning = false;
    this.activePointer = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.canvas.classList.remove("panning");
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
    this.panning = false;
    this.activePointer = null;
    this.canvas.classList.remove("panning");
  };

  /** Continuous panning. `dt` is real seconds; camera motion is not simulation. */
  update(dt: number): void {
    let dx = 0;
    let dy = 0;
    const k = this.keys;
    if (k.has("a") || k.has("arrowleft")) dx -= 1;
    if (k.has("d") || k.has("arrowright")) dx += 1;
    if (k.has("w") || k.has("arrowup")) dy -= 1;
    if (k.has("s") || k.has("arrowdown")) dy += 1;

    if (dx !== 0 || dy !== 0) {
      const inv = 1 / Math.hypot(dx, dy);
      const speed = (KEY_PAN_SPEED * dt) / this.cam.zoom;
      this.cam.panByWorld(dx * inv * speed, dy * inv * speed);
    }

    if (this.pointerInside && !this.panning) {
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
