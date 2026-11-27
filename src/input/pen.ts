/**
 * The pen: pointer capture on the LEFT button, which this game reserves
 * entirely for drawing (camera lives on middle/right drag and the keyboard).
 *
 * Points are converted to WORLD space as they arrive, not screen space. That
 * matters for more than convenience: the recognizer's thresholds are all in
 * world units, so a stroke drawn at zoom 0.35 and the same stroke drawn at 2.4
 * must classify identically. Converting late would make zoom change meaning.
 *
 * Works with a mouse, a trackpad, or a stylus -- Pointer Events unify all
 * three. Tuned for the mouse, which is jitterier than a pen and is what most
 * players will actually use.
 *
 * The pen owns no keyboard listener. Escape used to be caught here AND by
 * main.ts, so one press both cancelled the stroke and reloaded the tutorial;
 * now the key router calls `cancelStroke()` and a stroke in progress claims the
 * key before anything else sees it.
 */

import { cue } from "../audio/sound.ts";
import type { Camera } from "../render/camera.ts";
import type { Point } from "./gestures.ts";
import type { Commander } from "./commander.ts";

/** Minimum world-space travel before a new sample is kept. */
const MIN_SAMPLE_DISTANCE = 3;
/** Hard cap so a slow, meandering stroke cannot grow without bound. */
const MAX_POINTS = 600;

export class Pen {
  /** The stroke being drawn right now, in world space. Empty when idle. */
  points: Point[] = [];
  drawing = false;
  /** Label of the last committed gesture, for the HUD. */
  lastAction = "";
  /**
   * The last stroke, if it meant nothing: kept, with the reason, so it can
   * fade out in grey instead of vanishing (audit PC-02). `at` is real ms.
   */
  rejected: { points: Point[]; why: string; at: number } | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly cam: Camera;
  private readonly commander: Commander;
  private pointerId: number | null = null;
  /**
   * Whether the pen context is live. Off while a screen that does not allow it
   * is on top -- the canvas is still under a dialog, and a stroke begun there
   * must not reach the world.
   */
  private enabled = true;

  constructor(canvas: HTMLCanvasElement, cam: Camera, commander: Commander) {
    this.canvas = canvas;
    this.cam = cam;
    this.commander = commander;
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerup", this.onUp);
    canvas.addEventListener("pointercancel", this.onCancel);
  }

  /** Remove every listener, so a torn-down battle leaves nothing on the canvas. */
  dispose(): void {
    this.cancelStroke();
    this.canvas.removeEventListener("pointerdown", this.onDown);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerup", this.onUp);
    this.canvas.removeEventListener("pointercancel", this.onCancel);
  }

  /** Turn the pen context on or off. Turning it off abandons any stroke. */
  setEnabled(on: boolean): void {
    if (!on) this.cancelStroke();
    this.enabled = on;
  }

  private toWorld(e: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: this.cam.screenToWorldX(e.clientX - rect.left),
      y: this.cam.screenToWorldY(e.clientY - rect.top),
    };
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.enabled) return;
    e.preventDefault();
    this.drawing = true;
    this.pointerId = e.pointerId;
    this.points = [this.toWorld(e)];
    // Capture keeps a stroke alive if the pen leaves the canvas mid-draw. It
    // throws for a pointer the browser is not actually tracking, which happens
    // with synthetic events, so a failure here must not abort the stroke.
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* not a live pointer; the stroke still works */
    }
    this.commander.update(this.points);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.drawing || e.pointerId !== this.pointerId) return;
    const p = this.toWorld(e);
    const last = this.points[this.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < MIN_SAMPLE_DISTANCE) return;
    if (this.points.length < MAX_POINTS) this.points.push(p);
    // Re-classify every sample so the ghost preview tracks the pen. The
    // recognizer is pure, so this is just arithmetic over a few hundred points.
    this.commander.update(this.points);
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.drawing || e.pointerId !== this.pointerId) return;
    this.release(e.pointerId);
    const stroke = this.points;
    this.lastAction = this.commander.commit(stroke);
    // A tap that merely cleared or selected is not a refusal; a drawn stroke
    // that did nothing is, and is shown as one.
    this.rejected = this.commander.rejected && stroke.length > 1
      ? { points: stroke, why: this.lastAction, at: performance.now() }
      : null;
    // K11: a stroke heard, or refused; a tap is a tick.
    cue(this.rejected ? "refused" : stroke.length > 1 ? "stroke" : "click");
    this.points = [];
  };

  private onCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.release(e.pointerId);
    this.points = [];
    this.commander.cancel();
  };

  /**
   * Abandon a stroke mid-draw without issuing anything. Returns whether there
   * was one, so Escape can stop there instead of also opening the leave screen.
   */
  cancelStroke(): boolean {
    if (!this.drawing) return false;
    if (this.pointerId !== null) this.release(this.pointerId);
    this.drawing = false;
    this.points = [];
    this.commander.cancel();
    this.lastAction = "cancelled";
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
