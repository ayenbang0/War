/**
 * Camera navigation.
 *
 * The LEFT pointer button is deliberately untouched here: it belongs to the pen
 * and nothing else may bind it. Panning therefore lives on the middle and right
 * buttons (drag the map), on the keyboard, and on screen-edge push; the wheel
 * zooms about the cursor.
 *
 * Keys arrive from the key router (ui/keys.ts) rather than from a window
 * listener of our own, matched on `e.code`. Before K0 this class kept its own
 * always-on listener on `e.key`, so every key in the game -- digits, Space,
 * Ctrl+D -- landed in the held set, under menus and modals too, and AZERTY
 * players found WASD scattered.
 */

import type { Camera } from "../render/camera.ts";
import { signal } from "../ui/story/signals.ts";

const KEY_PAN_SPEED = 900; // world units per second at zoom 1
const EDGE_MARGIN = 24; // px
const EDGE_PAN_SPEED = 700;
const ZOOM_STEP = 1.0015;
/** Zoom multiplier per second while an arrow key is held. */
const KEY_ZOOM_RATE = 2.6;

/** The physical keys this class cares about. Anything else is not held. */
const CAMERA_KEYS: ReadonlySet<string> = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
]);

/** A drag of the map in progress on the middle or right button. */
type Drag = { readonly pointerId: number; lastX: number; lastY: number };

export class CameraControls {
  private keys = new Set<string>();
  private pointerX = 0;
  private pointerY = 0;
  private pointerInside = false;
  private drag: Drag | null = null;
  /** Whether the camera context is live; see Pen.setEnabled. */
  private enabled = true;

  private readonly cam: Camera;
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, cam: Camera) {
    // The canvas is still where wheel and pointer-position events arrive.
    this.cam = cam;
    this.canvas = canvas;
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

  /** Turn the camera context on or off. Off drops held keys and any drag. */
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
    if (!this.enabled || !CAMERA_KEYS.has(code)) return false;
    this.keys.add(code);
    // K9: the tutorial hears a camera key taken (ui/story/signals.ts).
    signal({ kind: "camera", action: "keys" });
    return true;
  }

  keyUp(code: string): void {
    this.keys.delete(code);
  }

  /** Dropping keys on blur prevents the camera drifting forever after alt-tab. */
  releaseAll(): void {
    this.keys.clear();
  }

  /** True while the middle or right button is dragging the map. */
  get panning(): boolean {
    return this.drag !== null;
  }

  private onPointerDown = (e: PointerEvent): void => {
    // Left is the pen's. Middle and right drag the map.
    if (e.button !== 1 && e.button !== 2) return;
    if (!this.enabled) return;
    // Middle-button down would otherwise start the browser's autoscroll.
    e.preventDefault();
    this.drag = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    this.canvas.classList.add("panning");
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer the browser is not tracking; the drag still works */
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    this.pointerInside = this.enabled;
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    // Grab-the-paper: the ground under the cursor follows the cursor.
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
    // Right button is a pan, never the browser's menu.
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
    // Exponential in the raw delta so trackpads and notched wheels both feel right.
    this.cam.zoomAt(e.clientX, e.clientY, Math.pow(ZOOM_STEP, -e.deltaY));
    signal({ kind: "camera", action: "zoom" });
  };

  /** Continuous panning. `dt` is real seconds; camera motion is not simulation. */
  update(dt: number): void {
    if (!this.enabled) return;
    let dx = 0;
    let dy = 0;
    const k = this.keys;
    if (k.has("KeyA") || k.has("ArrowLeft")) dx -= 1;
    if (k.has("KeyD") || k.has("ArrowRight")) dx += 1;
    if (k.has("KeyW")) dy -= 1;
    if (k.has("KeyS")) dy += 1;

    // Up and down zoom rather than pan. Zooming is the more common intent on a
    // map this size, and WASD still covers panning in all four directions.
    let zoom = 0;
    if (k.has("ArrowUp")) zoom += 1;
    if (k.has("ArrowDown")) zoom -= 1;
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

    // No edge push while dragging: the cursor is near the edge BECAUSE the
    // player is dragging, and the two would fight.
    if (this.pointerInside && !this.drag) {
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
