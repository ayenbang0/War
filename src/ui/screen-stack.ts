/**
 * The screen stack: every screen and overlay the player can be looking at, in
 * the order they were opened.
 *
 * It replaces the promise chain main.ts used to be, where each screen resolved
 * once and the only way "back" was `location.reload()`. Push opens a screen on
 * top, pop closes it and returns to exactly what was underneath -- with that
 * screen's own state intact and the keyboard focus where the player left it.
 *
 * Rules the stack enforces (plan §C.4, and the game-ui-ux skill's §4):
 *  - ONLY THE TOP SCREEN TAKES INPUT. Everything below it is marked inert, and
 *    the key router asks the top screen which input contexts are live.
 *  - A "full" screen hides everything beneath it; an "overlay" (a dialog, the
 *    after-action report) leaves what is beneath it on view but inert.
 *  - Focus goes to the new top's declared first-focus element on push and is
 *    restored to what had it before on pop, so a keyboard player never lands on
 *    a button that has just been hidden.
 *  - A screen that traps focus keeps Tab cycling inside itself.
 *  - The sim is held while ANY screen on the stack says it pauses the sim, so a
 *    confirm dialog over the battlefield stops the clock even though the
 *    battlefield stays drawn behind it.
 *
 * Deliberately DOM-free. Focus targets are anything with a `focus()` method and
 * the focus host is injected, so the whole stack runs under Node in
 * tools/ui-check.ts with plain-object fakes.
 */

/** Who may receive input while a screen is on top. */
export type InputContext = "pen" | "camera" | "ui";

export type ScreenKind = "full" | "overlay";

/** Anything that can take keyboard focus. In the browser, an HTMLElement. */
export interface Focusable {
  focus(): void;
}

/**
 * Where focus currently is, and how to move it. In the browser this wraps
 * `document.activeElement`; in tests it is a plain variable.
 */
export interface FocusHost {
  active(): Focusable | null;
  /** Move focus to `target`, or drop it back to the page when null. */
  focus(target: Focusable | null): void;
  /** Whether `target` can still take focus (still in the page, still shown). */
  canFocus(target: Focusable): boolean;
}

/** What a screen does with a key it was offered. */
export type KeyVerdict = "handled" | "pass";

/** The subset of a keyboard event the screens and the router look at. */
export type KeyInput = {
  readonly code: string;
  readonly repeat: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  preventDefault(): void;
};

export interface Screen {
  /** For debugging and the e2e harness; not shown to the player. */
  readonly name: string;
  readonly kind: ScreenKind;
  /** Keep Tab inside this screen while it is on top. */
  readonly trapsFocus: boolean;
  /** Hold the battle clock while this screen is anywhere on the stack. */
  readonly pausesSim: boolean;
  /** Input contexts live while this screen is on top. */
  readonly inputs: readonly InputContext[];
  /** Where focus goes when this screen comes up. Null drops focus to the page. */
  firstFocus(): Focusable | null;
  /** The focus ring a trap cycles through, in tab order. */
  focusables?(): readonly Focusable[];
  /** Called once, when pushed. Build or reset the screen's content here. */
  mount(): void;
  /** Called once, when popped. Release whatever mount took. */
  unmount(): void;
  /** Shown or hidden by a full screen above it. */
  setVisible(visible: boolean): void;
  /** Made inert (or live again) when something is pushed over it. */
  setInert?(inert: boolean): void;
  /** Called when the screen becomes the top again after something above it popped. */
  revealed?(): void;
  /** Offered every key while on top. "pass" lets the live layer have it. */
  onKey?(k: KeyInput): KeyVerdict;
}

type Entry = {
  readonly screen: Screen;
  /** What had focus when this screen was pushed, to be given back on pop. */
  readonly restoreFocus: Focusable | null;
  visible: boolean;
  inert: boolean;
};

export class ScreenStack {
  private readonly entries: Entry[] = [];
  private readonly listeners: (() => void)[] = [];
  private readonly host: FocusHost;

  constructor(host: FocusHost) {
    this.host = host;
  }

  get top(): Screen | null {
    const e = this.entries[this.entries.length - 1];
    return e ? e.screen : null;
  }

  get size(): number {
    return this.entries.length;
  }

  has(screen: Screen): boolean {
    return this.entries.some((e) => e.screen === screen);
  }

  /** Bottom-to-top names, for tests and the e2e harness. */
  names(): string[] {
    return this.entries.map((e) => e.screen.name);
  }

  /** Whether the screen is currently drawn (not hidden by a full screen above). */
  isVisible(screen: Screen): boolean {
    return this.entries.find((e) => e.screen === screen)?.visible ?? false;
  }

  /** True while any screen on the stack holds the sim. */
  pausesSim(): boolean {
    return this.entries.some((e) => e.screen.pausesSim);
  }

  /** The input contexts live right now: the top screen's, or none at all. */
  activeInputs(): readonly InputContext[] {
    return this.top?.inputs ?? [];
  }

  /** Called after every push and pop. */
  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  push(screen: Screen): void {
    if (this.has(screen)) throw new Error("screen " + screen.name + " is already on the stack");
    const restoreFocus = this.host.active();
    this.entries.push({ screen, restoreFocus, visible: false, inert: false });
    screen.mount();
    this.relayout();
    this.host.focus(screen.firstFocus());
    this.emit();
  }

  /** Close the top screen. Returns it, or null when the stack was empty. */
  pop(): Screen | null {
    const e = this.popEntry();
    if (!e) return null;
    this.relayout();
    // Revealed before focus is restored: a screen that redraws on reveal must
    // have its new buttons in place for focus to land on.
    this.top?.revealed?.();
    this.restore(e.restoreFocus);
    this.emit();
    return e.screen;
  }

  /**
   * Pop until `screen` is on top. Focus is restored once, to whatever had it
   * when the screen directly above `screen` was pushed -- the intermediate
   * screens are going away and must not each grab focus on the way down.
   */
  popTo(screen: Screen): void {
    if (!this.has(screen)) throw new Error("screen " + screen.name + " is not on the stack");
    if (this.top === screen) return;
    let restore: Focusable | null = null;
    while (this.top !== screen) {
      const e = this.popEntry();
      if (!e) break;
      restore = e.restoreFocus;
    }
    this.relayout();
    screen.revealed?.();
    this.restore(restore);
    this.emit();
  }

  /** Pop everything, top first. Used when the app is torn down. */
  clear(): void {
    while (this.popEntry()) { /* unmounting as it goes */ }
    this.emit();
  }

  /**
   * Move focus one step round the top screen's ring, for a screen that traps
   * it. Starts from the first element when focus is outside the ring.
   */
  cycleFocus(backwards: boolean): void {
    const ring = this.top?.focusables?.() ?? [];
    if (ring.length === 0) return;
    const at = ring.indexOf(this.host.active() as Focusable);
    let next: number;
    if (at < 0) next = backwards ? ring.length - 1 : 0;
    else next = (at + (backwards ? ring.length - 1 : 1)) % ring.length;
    this.host.focus(ring[next]);
  }

  private popEntry(): Entry | null {
    const e = this.entries.pop();
    if (!e) return null;
    e.screen.setInert?.(false);
    e.screen.setVisible(false);
    e.screen.unmount();
    return e;
  }

  private restore(target: Focusable | null): void {
    if (target && this.host.canFocus(target)) this.host.focus(target);
    else this.host.focus(this.top?.firstFocus() ?? null);
  }

  /**
   * Recompute who is shown and who is inert. A screen is visible when no full
   * screen sits above it; every screen but the top is inert.
   */
  private relayout(): void {
    let covered = false;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      const visible = !covered;
      if (visible !== e.visible) {
        e.visible = visible;
        e.screen.setVisible(visible);
      }
      const inert = i !== this.entries.length - 1;
      if (inert !== e.inert) {
        e.inert = inert;
        e.screen.setInert?.(inert);
      }
      if (e.screen.kind === "full") covered = true;
    }
  }

  private emit(): void {
    for (const fn of this.listeners.slice()) fn();
  }
}
