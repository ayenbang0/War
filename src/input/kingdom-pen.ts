/**
 * The pen on the kingdom map: pointer capture on the LEFT button, which the
 * game reserves for drawing on every layer (CLAUDE.md). The camera has the
 * middle and right buttons, the wheel and the keyboard.
 *
 * Same contract as the battle's input/pen.ts -- points go to MAP space the
 * moment they arrive, so the recogniser's thresholds mean the same at every
 * zoom -- with the U0 findings against that pen fixed here rather than copied:
 *  - a stroke is cancelled when the browser takes the pointer away
 *    (`lostpointercapture`, `pointercancel`) or a move arrives with no button
 *    held (focus was lost mid-stroke and the up never came) -- PC-13, U1-18;
 *  - at the sample cap the stroke is thinned, not truncated, so the ink and
 *    the ghost keep following the pen -- PC-12;
 *  - a second pointer while drawing is ignored instead of replacing the
 *    stroke -- PC-29.
 *
 * No keyboard listener: the key router calls `cancelStroke()` (ui/keys.ts).
 */

import type { KingdomCamera } from "../render/kingdom/camera.ts";
import type { Point } from "./kingdom-gestures.ts";

/** Minimum screen travel, in pixels, before a new sample is kept. */
const MIN_SAMPLE_PX = 2;
/** Past this many samples the stroke is thinned to half. */
const MAX_POINTS = 600;

/** Who hears about the stroke. The layer. */
export interface KingdomStrokeSink {
  strokeChanged(points: readonly Point[]): void;
  strokeEnded(points: readonly Point[]): void;
  strokeCancelled(): void;
}

export class KingdomPen {
  /** The stroke being drawn, in map miles. Empty when idle. */
  points: Point[] = [];
  drawing = false;

  private readonly canvas: HTMLCanvasElement;
  private readonly cam: KingdomCamera;
  private readonly sink: KingdomStrokeSink;
  private pointerId: number | null = null;
  private lastSx = 0;
  private lastSy = 0;
  private enabled = true;

  constructor(canvas: HTMLCanvasElement, cam: KingdomCamera, sink: KingdomStrokeSink) {
    this.canvas = canvas;
    this.cam = cam;
    this.sink = sink;
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointercancel", this.onCancel);
    canvas.addEventListener("lostpointercapture", this.onCancel);
  }

  dispose(): void {
    this.cancelStroke();
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.onDown);
    c.removeEventListener("pointermove", this.onMove);
    c.removeEventListener("pointerup", this.onUp);
    c.removeEventListener("pointercancel", this.onCancel);
    c.removeEventListener("lostpointercapture", this.onCancel);
  }

  /** The pen context on or off (the screen on top decides). Off abandons any stroke. */
  setEnabled(on: boolean): void {
    if (!on) this.cancelStroke();
    this.enabled = on;
  }

  private toMap(e: PointerEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return { x: this.cam.screenToWorldX(e.clientX - r.left), y: this.cam.screenToWorldY(e.clientY - r.top) };
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.enabled) return;
    if (this.drawing) return; // a second finger does not replace the stroke
    e.preventDefault();
    this.drawing = true;
    this.pointerId = e.pointerId;
    this.lastSx = e.clientX;
    this.lastSy = e.clientY;
    this.points = [this.toMap(e)];
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* a synthetic pointer the browser is not tracking; the stroke still works */
    }
    this.sink.strokeChanged(this.points);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.drawing || e.pointerId !== this.pointerId) return;
    // The button came up somewhere we never heard about (alt-tab, a devtools
    // click): end it as a cancel, not as an order the player never finished.
    if (typeof e.buttons === "number" && (e.buttons & 1) === 0) {
      this.cancelStroke();
      return;
    }
    if (Math.hypot(e.clientX - this.lastSx, e.clientY - this.lastSy) < MIN_SAMPLE_PX) return;
    this.lastSx = e.clientX;
    this.lastSy = e.clientY;
    this.points.push(this.toMap(e));
    if (this.points.length > MAX_POINTS) {
      // Keep both ends and every other point between: the shape survives,
      // the length halves, and the tip keeps tracking the pen.
      const thin: Point[] = [this.points[0]];
      for (let i = 1; i < this.points.length - 1; i += 2) thin.push(this.points[i]);
      thin.push(this.points[this.points.length - 1]);
      this.points = thin;
    }
    this.sink.strokeChanged(this.points);
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.drawing || e.pointerId !== this.pointerId) return;
    const pts = this.points;
    this.release(e.pointerId);
    this.points = [];
    this.sink.strokeEnded(pts);
  };

  private onCancel = (e: PointerEvent): void => {
    if (!this.drawing || e.pointerId !== this.pointerId) return;
    this.cancelStroke();
  };

  /** Abandon a stroke without issuing anything. Returns whether there was one. */
  cancelStroke(): boolean {
    if (!this.drawing) return false;
    const id = this.pointerId;
    this.drawing = false;
    this.pointerId = null;
    this.points = [];
    if (id !== null) {
      try {
        if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
      } catch { /* nothing to release */ }
    }
    this.sink.strokeCancelled();
    return true;
  }

  private release(id: number): void {
    this.drawing = false;
    this.pointerId = null;
    try {
      if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
    } catch {
      /* nothing to release */
    }
  }
}
