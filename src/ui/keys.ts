/**
 * The one keyboard router.
 *
 * Before K0 there were three always-on window listeners (main.ts, pen.ts and
 * camera-controls.ts), mixing `e.code` and `e.key`, with nothing deciding who
 * owned a key. Escape went to BOTH the pen (cancel the stroke) and main.ts
 * (reload the tutorial), so cancelling a stroke threw the lesson away; every key
 * also landed in the camera's held set, under menus and modals alike.
 *
 * Now one listener receives every key and offers it, in order, to:
 *  1. the TOP screen of the stack (a dialog's Esc, the setup menu's Esc), then
 *  2. the live layer -- but only with the input contexts the top screen allows,
 *     so a modal over the battlefield turns the pen and camera off by itself.
 *
 * Physical keys are matched on `e.code`, never `e.key`, so the bindings sit in
 * the same place on AZERTY as on QWERTY. Space and Enter on a focused button
 * belong to the button (that is how buttons are pressed from the keyboard), and
 * every key belongs to a focused text field, so neither double-fires a game
 * action behind the control.
 *
 * DOM-free apart from `attachKeyRouter`, which only adds listeners to whatever
 * event targets it is handed, so tools/ui-check.ts drives this under Node.
 */

import type { InputContext, KeyInput, KeyVerdict, ScreenStack } from "./screen-stack.ts";

/** What has focus when a key arrives, as far as routing cares. */
export type FocusKind = "page" | "button" | "text-field";

/** The live layer's side of the router. */
export interface LayerKeys {
  /** A key the top screen passed on. `contexts` is what the top screen allows. */
  keyDown(k: KeyInput, contexts: readonly InputContext[]): KeyVerdict;
  /** Always delivered, whatever is on top, so a held key can never stick. */
  keyUp(code: string): void;
  /** Drop every held key: focus left the window, or a modal took the input. */
  releaseAll(): void;
}

/** Keys a focused button acts on itself. */
const ACTIVATES_BUTTON: ReadonlySet<string> = new Set(["Space", "Enter", "NumpadEnter"]);

/**
 * Physical keys for ability slots 1..12, in slot order.
 *
 * The digit row gives ten (1..9 then 0, as on every keyboard); Minus and Equal
 * sit next to 0 and give the last two, since there are twelve abilities and the
 * setup screen does not cap how many distinct ones are bought. The numpad
 * mirrors the first ten.
 */
export const ABILITY_SLOT_KEYS: readonly (readonly string[])[] = [
  ["Digit1", "Numpad1"], ["Digit2", "Numpad2"], ["Digit3", "Numpad3"],
  ["Digit4", "Numpad4"], ["Digit5", "Numpad5"], ["Digit6", "Numpad6"],
  ["Digit7", "Numpad7"], ["Digit8", "Numpad8"], ["Digit9", "Numpad9"],
  ["Digit0", "Numpad0"], ["Minus", "NumpadSubtract"], ["Equal", "NumpadAdd"],
];

/** The label printed on each slot, matching ABILITY_SLOT_KEYS. */
export const ABILITY_SLOT_LABELS: readonly string[] = [
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=",
];

/** Which ability slot a physical key selects, or -1. */
export function abilitySlotForCode(code: string): number {
  for (let i = 0; i < ABILITY_SLOT_KEYS.length; i++) {
    if (ABILITY_SLOT_KEYS[i].includes(code)) return i;
  }
  return -1;
}

/** A keyboard event as the router reads it. A real KeyboardEvent fits. */
export type RawKey = {
  readonly code: string;
  readonly repeat: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly target: unknown;
  preventDefault(): void;
};

export class KeyRouter {
  private readonly stack: ScreenStack;
  private readonly classify: (target: unknown) => FocusKind;
  private layer: LayerKeys | null = null;

  constructor(stack: ScreenStack, classify: (target: unknown) => FocusKind) {
    this.stack = stack;
    this.classify = classify;
  }

  /** The layer that gets what the screens pass on. Null while none is live. */
  setLayer(layer: LayerKeys | null): void {
    this.layer?.releaseAll();
    this.layer = layer;
  }

  keyDown(e: RawKey): void {
    const top = this.stack.top;
    const focus = this.classify(e.target);
    const k: KeyInput = {
      code: e.code, repeat: e.repeat,
      ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, shift: e.shiftKey,
      preventDefault: () => e.preventDefault(),
    };

    // A trap keeps Tab inside the dialog. Everywhere else Tab is the browser's.
    if (e.code === "Tab") {
      if (top?.trapsFocus) {
        e.preventDefault();
        this.stack.cycleFocus(e.shiftKey);
      }
      return;
    }
    // A text field owns every key but Escape; a button owns the keys that press
    // it. Without this, Space on a focused "Fight again" both pressed it and
    // toggled the pause behind it.
    if (focus === "text-field" && e.code !== "Escape") return;
    if (focus === "button" && ACTIVATES_BUTTON.has(e.code)) return;

    if (top?.onKey?.(k) === "handled") return;

    // Browser and OS shortcuts (Ctrl+S, Cmd+A, Alt+Tab) are never game keys.
    // Ctrl+D used to pan the map right.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const contexts = this.stack.activeInputs();
    if (!this.layer || !contexts.some((c) => c === "pen" || c === "camera")) return;
    this.layer.keyDown(k, contexts);
  }

  keyUp(e: { readonly code: string }): void {
    if (!this.layer) return;
    // macOS sends no keyup for a key released while Meta is held, so letting go
    // of Meta has to let go of everything or the camera pans until blur.
    if (e.code === "MetaLeft" || e.code === "MetaRight") this.layer.releaseAll();
    else this.layer.keyUp(e.code);
  }

  /** Focus left the window, or the tab was hidden. */
  blur(): void {
    this.layer?.releaseAll();
  }
}

/** Minimal event-target shape, so this can be wired to fakes as well as window. */
type Listenable = {
  addEventListener(type: string, fn: (e: Event) => void): void;
  removeEventListener(type: string, fn: (e: Event) => void): void;
};

/**
 * Wire the router to the page: the ONE keydown listener in the game. Returns a
 * function that removes every listener it added.
 */
export function attachKeyRouter(router: KeyRouter, win: Listenable, doc: Listenable & { readonly hidden?: boolean }): () => void {
  const down = (e: Event): void => router.keyDown(e as unknown as RawKey);
  const up = (e: Event): void => router.keyUp(e as unknown as RawKey);
  const blur = (): void => router.blur();
  const vis = (): void => {
    if (doc.hidden) router.blur();
  };
  win.addEventListener("keydown", down);
  win.addEventListener("keyup", up);
  win.addEventListener("blur", blur);
  doc.addEventListener("visibilitychange", vis);
  return () => {
    win.removeEventListener("keydown", down);
    win.removeEventListener("keyup", up);
    win.removeEventListener("blur", blur);
    doc.removeEventListener("visibilitychange", vis);
  };
}

/** How the browser build classifies the focused element. */
export function classifyFocus(target: unknown): FocusKind {
  const el = target as { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  if (!el || typeof el.tagName !== "string") return "page";
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return "text-field";
  if (tag === "INPUT") {
    const t = (el.type ?? "text").toLowerCase();
    return t === "button" || t === "submit" || t === "reset" || t === "checkbox" || t === "radio"
      ? "button" : "text-field";
  }
  if (tag === "BUTTON" || tag === "A" || tag === "SUMMARY") return "button";
  return "page";
}
