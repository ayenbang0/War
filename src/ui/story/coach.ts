/**
 * K9: the tutorial runner and its coach panel -- the lessons of
 * content/story/tutorial.ts, one step at a time, after the opening cutscene.
 *
 * The owner: "a tutorial to teach ALL gestures controls". Each step
 *  - WAITS FOR REAL INPUT: it is done only when the control it teaches has
 *    actually done its thing, as the app says through ui/story/signals.ts (a
 *    camera that moved, an order the world accepted, a card that opened);
 *    nothing here simulates a stroke or reads the recogniser's guess;
 *  - SHOWS WHAT TO DO: the step's sentence, and for a pen step an inked
 *    figure of the stroke (stroke-figures.ts) described in words beside it;
 *    after a while without success its hint is added (the step's `hint`);
 *  - CAN BE SKIPPED: "Skip this step" goes on to the next, "Skip the
 *    tutorial" (behind a confirm) ends it.
 *
 * The panel is not a screen on the stack: it sits over whatever is live --
 * map, town or field -- and never takes the pen, the camera or the keys, so
 * it cannot get in the way of the control it is teaching. Its two buttons are
 * real buttons; its text is an aria-live region, so each new step is read
 * out. Camera, clock and key signals count only on the step's own layer (a
 * wheel in the town is not the map's lesson); everything else is specific
 * enough on its own.
 *
 * Where the next step needs another layer (the town, the drill field, the map
 * again), the runner asks the app to take the player there (`hooks.bring`):
 * a lesson's first step is never "find the town first".
 */

import { TUTORIAL, TUTORIAL_LESSONS, type TutorialLayer, type TutorialStep, type TutorialSuccess } from "../../content/story/tutorial.ts";
import { STORY_UI } from "../../content/story/strings.ts";
import { onSignal, type TutorialSignal } from "./signals.ts";
import { strokeFigureSvg } from "./stroke-figures.ts";

export type CoachHooks = {
  /** The layer the player is on now, or null between layers. */
  layer(): TutorialLayer | null;
  /** Take the player to where `step` is played (a no-op when already there). */
  bring(step: TutorialStep): void;
  /** Ask whether to skip the rest; `yes` ends it. */
  confirmSkip(yes: () => void): void;
  /** The last step is done or the rest skipped. */
  finished(skipped: boolean): void;
};

/** Seconds on one step before its hint is shown too. */
export const HINT_SECONDS = 12;

/** Does what happened satisfy what the step waits for? Pure (the tests hold it to the table). */
export function satisfies(want: TutorialSuccess, got: TutorialSignal): boolean {
  if (want.kind !== got.kind) return false;
  switch (want.kind) {
    case "gesture": {
      const g = got as Extract<TutorialSignal, { kind: "gesture" }>;
      return g.class === want.class && (want.shape === undefined || g.shape === want.shape) &&
        (want.detail === undefined || g.detail === want.detail);
    }
    case "kingdomGesture": return (got as typeof want).class === want.class;
    case "cityTap": return (got as typeof want).target === want.target;
    case "camera": return (got as typeof want).action === want.action;
    case "time": return (got as typeof want).action === want.action;
    case "key": return (got as typeof want).code === want.code;
    case "ui": return (got as typeof want).action === want.action;
  }
}

/** Signals that only count on the step's own layer (the same key or wheel means something on every layer). */
function layerBound(s: TutorialSuccess): boolean {
  return s.kind === "camera" || s.kind === "time" || s.kind === "key";
}

function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export class Coach {
  /** The step being waited on (index into TUTORIAL). */
  index = 0;
  /** Steps done by the player, and skipped, for the tests and the report. */
  readonly done: string[] = [];
  readonly skipped: string[] = [];
  finished = false;
  readonly root: HTMLElement;

  private readonly win: Window;
  private readonly hooks: CoachHooks;
  private readonly unlisten: () => void;
  private readonly lesson: HTMLElement;
  private readonly count: HTMLElement;
  private readonly text: HTMLElement;
  private readonly figure: HTMLImageElement;
  private readonly hint: HTMLElement;
  private hintTimer = 0;
  private readonly doc: Document;

  constructor(doc: Document, win: Window, hooks: CoachHooks, from = 0) {
    this.win = win;
    this.hooks = hooks;
    this.index = from;
    this.root = make(doc, "aside", "s-coach");
    this.root.setAttribute("aria-label", STORY_UI.coachLabel);
    this.lesson = make(doc, "p", "s-coach-lesson");
    this.count = make(doc, "p", "s-coach-count");
    this.text = make(doc, "p", "s-coach-text");
    this.text.setAttribute("aria-live", "polite");
    this.figure = make(doc, "img", "s-coach-figure") as HTMLImageElement;
    this.hint = make(doc, "p", "s-coach-hint");
    const actions = make(doc, "div", "s-coach-actions");
    const skipStep = make(doc, "button", "k-btn", STORY_UI.coachSkipStep);
    skipStep.setAttribute("type", "button");
    skipStep.setAttribute("data-key", "coach-skip-step");
    skipStep.onclick = (e) => { this.skipStep(); if ((e as MouseEvent).detail > 0) skipStep.blur(); };
    const skipAll = make(doc, "button", "k-btn", STORY_UI.coachSkipAll);
    skipAll.setAttribute("type", "button");
    skipAll.setAttribute("data-key", "coach-skip-all");
    skipAll.onclick = () => this.askSkip();
    actions.append(skipStep, skipAll);
    this.root.append(this.lesson, this.count, this.text, this.figure, this.hint, actions);
    doc.body.appendChild(this.root);
    // U3: the coach sits bottom-left, where the map's feed and result line
    // are -- and the result line is how the tutorial tells a stroke that did
    // nothing. While the coach is up, story.css lifts them clear of it.
    this.doc = doc;
    doc.documentElement?.classList.add("s-coached");
    this.unlisten = onSignal((s) => this.heard(s));
    this.show();
  }

  get step(): TutorialStep | null {
    return this.finished ? null : TUTORIAL[this.index] ?? null;
  }

  /** Something happened: if it is what the step waits for, go on. */
  heard(s: TutorialSignal): void {
    const step = this.step;
    if (!step || !satisfies(step.success, s)) return;
    if (layerBound(step.success) && this.hooks.layer() !== step.layer) return;
    this.done.push(step.id);
    this.advance();
  }

  /** Ask whether to skip the rest (the Skip the tutorial button; Esc with nothing to leave). */
  askSkip(): void {
    if (!this.finished) this.hooks.confirmSkip(() => this.finish(true));
  }

  skipStep(): void {
    const step = this.step;
    if (!step) return;
    this.skipped.push(step.id);
    this.advance();
  }

  dispose(): void {
    this.unlisten();
    this.stopHint();
    this.root.parentNode?.removeChild(this.root);
    const top = this.doc.documentElement;
    top?.classList.remove("s-coached");
    if (top && typeof top.style.removeProperty === "function") top.style.removeProperty("--s-coach-h");
  }

  private stopHint(): void {
    if (typeof this.win.clearTimeout === "function") this.win.clearTimeout(this.hintTimer);
  }

  private advance(): void {
    this.index++;
    if (this.index >= TUTORIAL.length) {
      this.finish(false);
      return;
    }
    this.show();
  }

  private finish(skipped: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.dispose();
    this.hooks.finished(skipped);
  }

  private show(): void {
    const step = TUTORIAL[this.index];
    if (!step) return;
    const lesson = TUTORIAL_LESSONS.find((l) => l.id === step.lesson);
    const firstOfLesson = this.index === 0 || TUTORIAL[this.index - 1].lesson !== step.lesson;
    this.lesson.textContent = lesson ? STORY_UI.coachLesson(lesson.title) : "";
    this.count.textContent = STORY_UI.coachStep(this.index + 1, TUTORIAL.length);
    // A lesson opens with Aldous's line about it, then the step.
    this.text.textContent = (firstOfLesson && lesson ? lesson.intro + " " : "") + step.text;
    this.root.setAttribute("data-step", step.id);
    const svg = strokeFigureSvg(step.success);
    if (svg) {
      this.figure.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      this.figure.alt = STORY_UI.coachDraw + " " + step.text;
      this.figure.style.display = "block";
    } else {
      this.figure.removeAttribute("src");
      this.figure.alt = "";
      this.figure.style.display = "none";
    }
    this.hint.textContent = "";
    this.stopHint();
    // A page with no timers (the headless fake DOM) simply never shows the hint.
    if (typeof this.win.setTimeout === "function") {
      this.hintTimer = this.win.setTimeout(() => { if (this.step === step) this.hint.textContent = step.hint; }, HINT_SECONDS * 1000);
    }
    // How far to lift the feed: the coach's own height as this step lays it out.
    const h = this.root.offsetHeight;
    const top = this.doc.documentElement;
    if (h > 0 && top && typeof top.style.setProperty === "function") top.style.setProperty("--s-coach-h", h + "px");
    this.hooks.bring(step);
  }
}
