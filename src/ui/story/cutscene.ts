/**
 * K9: the opening cutscene screen (content/story/cutscene.ts): Brother
 * Aldous tells how the king came to the Reach, over the realm's map, before
 * the tutorial and the first day at Cold Hearth.
 *
 * The owner: "The game should also start with a storyline animation/
 * cutscene". So it moves -- the camera eases between beats and follows the
 * road north-west, props ink themselves in -- and it is a film nobody is
 * made to sit through:
 *  - a clear Skip button, always on screen and in the focus ring, and Esc,
 *    end it at any beat;
 *  - Next, any other key (Enter, Space, the arrows) or a tap on the picture
 *    moves on a beat; each beat also moves on by itself, never sooner than
 *    its words can be read (beatSeconds);
 *  - under prefers-reduced-motion the camera CUTS to each beat's framing and
 *    the road is drawn whole, nothing pans or eases.
 * The narration is real text in the DOM (never painted into the canvas), at
 * the story's reading size (20px, never below 16) in dark ink on parchment
 * (about 13:1), in an aria-live region so a screen reader hears each beat.
 *
 * The camera and the timing are here; the drawing is render/story/
 * cutscene-art.ts.
 */

import { domScreen } from "../dom-screen.ts";
import type { KeyVerdict, Screen } from "../screen-stack.ts";
import { CUTSCENE } from "../../content/story/cutscene.ts";
import { RIMAROS } from "../../content/kingdom/map.ts";
import { STORY_UI } from "../../content/story/strings.ts";
import { drawCutscene, viewFor, type CutsceneView } from "../../render/story/cutscene-art.ts";

export type CutsceneHooks = {
  /** The cutscene is over: played to the end, or skipped. */
  done(skipped: boolean): void;
};

/** Seconds the camera takes to ease from one beat's framing to the next. */
const EASE_SECONDS = 1.2;

/**
 * U3: how long a beat stays before it moves on by itself. Its own seconds
 * pace the picture, but a beat of fifty words went by at seven words a second
 * -- gone before it could be read. So never faster than a slow reader: three
 * words a second, and a breath at the end (docs/PROVISIONAL.md K9.16).
 */
export const READING_WORDS_PER_SECOND = 3;
export function beatSeconds(b: { readonly seconds: number; readonly text: string }): number {
  const words = b.text.split(/\s+/).filter((w) => w.length > 0).length;
  return Math.max(b.seconds, words / READING_WORDS_PER_SECOND + 1.5);
}

function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function reduced(win: Window): boolean {
  try {
    return typeof win.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** The cutscene's state, for the tests (e2e reads the beat it is on). */
export type CutsceneState = { beat: number; finished: boolean };

export function cutsceneScreen(root: HTMLElement, win: Window, doc: Document, king: string, hooks: CutsceneHooks): Screen & { readonly state: CutsceneState } {
  const state: CutsceneState = { beat: 0, finished: false };
  const still = reduced(win);
  let skip: HTMLElement | null = null;
  let nextButton: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let text: HTMLElement | null = null;
  let raf = 0;
  let last: number | null = null;
  let inBeat = 0;
  let from: CutsceneView = viewFor(RIMAROS, CUTSCENE.beats[0].stage, 0, { x: 500, y: 350, span: 700 });

  const view = (): CutsceneView => {
    const b = CUTSCENE.beats[state.beat];
    const t = Math.min(1, inBeat / beatSeconds(b));
    const to = viewFor(RIMAROS, b.stage, still ? 1 : t, from);
    if (still) return to;
    const e = Math.min(1, inBeat / EASE_SECONDS);
    const k = e * e * (3 - 2 * e);
    return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, span: from.span + (to.span - from.span) * k };
  };

  const show = (): void => {
    const b = CUTSCENE.beats[state.beat];
    if (text) text.textContent = b.text.split("{king}").join(king);
    root.setAttribute("data-beat", b.id);
  };

  const finish = (skipped: boolean): void => {
    if (state.finished) return;
    state.finished = true;
    win.cancelAnimationFrame(raf);
    hooks.done(skipped);
  };

  const next = (): void => {
    if (state.finished) return;
    if (state.beat >= CUTSCENE.beats.length - 1) {
      finish(false);
      return;
    }
    from = view();
    state.beat++;
    inBeat = 0;
    show();
  };

  const draw = (): void => {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 450;
    const dpr = Math.min(win.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const b = CUTSCENE.beats[state.beat];
    drawCutscene(ctx, RIMAROS, view(), b.stage, still ? 1 : Math.min(1, inBeat / beatSeconds(b)), w, h);
  };

  const frame = (now: number): void => {
    if (state.finished) return;
    const dt = last === null ? 0 : Math.min(0.25, (now - last) / 1000);
    last = now;
    inBeat += dt;
    if (inBeat >= beatSeconds(CUTSCENE.beats[state.beat])) next();
    if (state.finished) return;
    draw();
    raf = win.requestAnimationFrame(frame);
  };

  const screen = domScreen({
    name: "story-cutscene",
    kind: "full",
    root,
    display: "flex",
    trapsFocus: true,
    pausesSim: true,
    inputs: ["ui"],
    // Next, not Skip, takes the focus: Enter on a focused button presses it,
    // and the key a reader reaches for to go on must never end the film.
    firstFocus: () => nextButton,
    build: () => {
      root.textContent = "";
      root.className = "s-cutscene";
      root.setAttribute("role", "region");
      root.setAttribute("aria-label", STORY_UI.cutsceneLabel);
      canvas = make(doc, "canvas", "s-cutscene-picture") as HTMLCanvasElement;
      canvas.setAttribute("aria-hidden", "true");
      canvas.onpointerdown = (e) => {
        // The left button only: the picture is tapped on, never dragged.
        if ((e as PointerEvent).button === 0) next();
      };
      const bar = make(doc, "div", "s-cutscene-bar");
      text = make(doc, "p", "s-cutscene-text");
      text.setAttribute("aria-live", "polite");
      const controls = make(doc, "div", "s-cutscene-controls");
      const nextB = make(doc, "button", "home-teach", STORY_UI.cutsceneNext);
      nextB.setAttribute("type", "button");
      nextB.onclick = () => next();
      nextButton = nextB;
      skip = make(doc, "button", "home-play s-skip", CUTSCENE.skip);
      skip.setAttribute("type", "button");
      skip.onclick = () => finish(true);
      controls.append(skip, nextB, make(doc, "span", "k-hint", CUTSCENE.skipHint));
      bar.append(text, controls);
      root.append(canvas, bar);
      state.beat = 0;
      state.finished = false;
      inBeat = 0;
      last = null;
      show();
      raf = win.requestAnimationFrame(frame);
    },
    teardown: () => {
      win.cancelAnimationFrame(raf);
      root.removeAttribute("data-beat");
      root.removeAttribute("role");
      root.removeAttribute("aria-label");
      root.className = "";
    },
    onKey: (k): KeyVerdict => {
      if (k.repeat) return "handled";
      if (k.code === "Escape") {
        finish(true);
        return "handled";
      }
      // Enter and Space on a focused button never get here (the key router
      // leaves them to the button: a focused Skip skips); any other key goes on.
      next();
      return "handled";
    },
  });
  return Object.assign(screen, { state });
}
