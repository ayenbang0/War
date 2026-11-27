/**
 * Camera navigation on the kingdom map.
 *
 * Built on the battle's input/camera-controls.ts (left button untouched --
 * it is the pen; middle/right drag pans; the wheel zooms about the cursor;
 * keys arrive from the one key router on `e.code`), with the U0 findings
 * against it fixed for this layer instead of inherited:
 *  - ARROWS PAN, like WASD; `-` and `=` zoom about the view centre (PC-21:
 *    the battle's arrows-up/down zoom is unconventional and undocumented);
 *  - edge push waits EDGE_DWELL seconds before it starts, normalises the
 *    diagonal, and is off when the player asked for reduced motion (PC-23,
 *    PC-33, U1-11);
 *  - the wheel's delta is normalised across line and page modes (PC-25);
 *  - any manual camera input cancels a fly-to (the camera does it).
 */

import type { KingdomCamera } from "../render/kingdom/camera.ts";
import { signal } from "../ui/story/signals.ts";

/** Screen pixels per second, at any zoom. */
const KEY_PAN_SPEED = 820;
const EDGE_MARGIN = 20;
const EDGE_PAN_SPEED = 620;
/** The pointer must rest in the margin this long before the map moves. */
const EDGE_DWELL = 0.15;
const WHEEL_STEP = 1.0015;
const LINE_PX = 16;
/** Zoom multiplier per second while - or = is held. */
const KEY_ZOOM_RATE = 2.4;

const PAN_KEYS: ReadonlySet<string> = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
]);
const ZOOM_KEYS: ReadonlySet<string> = new Set(["Minus", "Equal", "NumpadSubtract", "NumpadAdd"]);

type Drag = { readonly pointerId: number; lastX: number; lastY: number };

export class KingdomCameraControls {
  private keys = new Set<string>();
  private pointerX = 0;
  private pointerY = 0;
  private pointerInside = false;
  private edgeFor = 0;
  private drag: Drag | null = null;
  private enabled = true;
  /** Edge push is off under reduced motion; the keys and the drag remain. */
  edgePush: boolean;

  private readonly cam: KingdomCamera;
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, cam: KingdomCamera, edgePush: boolean) {
    this.cam = cam;
    this.canvas = canvas;
    this.edgePush = edgePush;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContextMenu);
  }

  dispose(): void {
    this.endDrag();
    this.releaseAll();
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointercancel", this.onPointerUp);
    c.removeEventListener("pointerleave", this.onPointerLeave);
    c.removeEventListener("wheel", this.onWheel);
    c.removeEventListener("contextmenu", this.onContextMenu);
  }

  setEnabled(on: boolean): void {
    if (!on) {
      this.releaseAll();
      this.endDrag();
      this.pointerInside = false;
    }
    this.enabled = on;
  }

  /** A key went down. Returns whether the camera took it. */
  keyDown(code: string): boolean {
    if (!this.enabled || !(PAN_KEYS.has(code) || ZOOM_KEYS.has(code))) return false;
    this.keys.add(code);
    // K9: the tutorial hears a camera key taken (ui/story/signals.ts).
    signal({ kind: "camera", action: ZOOM_KEYS.has(code) ? "zoom" : "keys" });
    return true;
  }

  keyUp(code: string): void {
    this.keys.delete(code);
  }

  releaseAll(): void {
    this.keys.clear();
  }

  get panning(): boolean {
    return this.drag !== null;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 1 && e.button !== 2) return;
    if (!this.enabled) return;
    e.preventDefault();
    this.drag = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    this.canvas.classList.add("panning");
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer; the drag still works */
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    this.pointerInside = this.enabled;
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.cam.panByScreen(e.clientX - d.lastX, e.clientY - d.lastY);
    if (e.clientX !== d.lastX || e.clientY !== d.lastY) signal({ kind: "camera", action: "drag" });
    d.lastX = e.clientX;
    d.lastY = e.clientY;
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.drag && e.pointerId === this.drag.pointerId) this.endDrag();
  };

  private onPointerLeave = (): void => {
    this.pointerInside = false;
  };

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private endDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.canvas.classList.remove("panning");
    try {
      if (this.canvas.hasPointerCapture(d.pointerId)) this.canvas.releasePointerCapture(d.pointerId);
    } catch {
      /* nothing to release */
    }
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (!this.enabled) return;
    // deltaMode 1 = lines, 2 = pages; bring both to pixels so every wheel and
    // trackpad zooms at the same rate.
    const dy = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * this.cam.viewH : e.deltaY;
    const r = this.canvas.getBoundingClientRect();
    this.cam.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(WHEEL_STEP, -dy));
    signal({ kind: "camera", action: "zoom" });
  };

  /** Continuous pan, zoom and edge push. `dt` is real seconds. */
  update(dt: number): void {
    if (!this.enabled) return;
    const k = this.keys;
    let dx = 0;
    let dy = 0;
    if (k.has("KeyA") || k.has("ArrowLeft")) dx -= 1;
    if (k.has("KeyD") || k.has("ArrowRight")) dx += 1;
    if (k.has("KeyW") || k.has("ArrowUp")) dy -= 1;
    if (k.has("KeyS") || k.has("ArrowDown")) dy += 1;
    if (dx !== 0 || dy !== 0) {
      const inv = 1 / Math.hypot(dx, dy);
      const speed = (KEY_PAN_SPEED * dt) / this.cam.zoom;
      this.cam.panByWorld(dx * inv * speed, dy * inv * speed);
    }

    let zoom = 0;
    if (k.has("Equal") || k.has("NumpadAdd")) zoom += 1;
    if (k.has("Minus") || k.has("NumpadSubtract")) zoom -= 1;
    if (zoom !== 0) this.cam.zoomAt(this.cam.viewW / 2, this.cam.viewH / 2, Math.pow(KEY_ZOOM_RATE, zoom * dt));

    if (!this.edgePush || !this.pointerInside || this.drag) {
      this.edgeFor = 0;
      return;
    }
    let ex = 0;
    let ey = 0;
    if (this.pointerX < EDGE_MARGIN) ex -= 1;
    if (this.pointerX > this.cam.viewW - EDGE_MARGIN) ex += 1;
    if (this.pointerY < EDGE_MARGIN) ey -= 1;
    if (this.pointerY > this.cam.viewH - EDGE_MARGIN) ey += 1;
    if (ex === 0 && ey === 0) {
      this.edgeFor = 0;
      return;
    }
    this.edgeFor += dt;
    if (this.edgeFor < EDGE_DWELL) return;
    const inv = 1 / Math.hypot(ex, ey);
    const speed = (EDGE_PAN_SPEED * dt) / this.cam.zoom;
    this.cam.panByWorld(ex * inv * speed, ey * inv * speed);
  }
}
