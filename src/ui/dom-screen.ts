/**
 * A Screen backed by one DOM element: the shared plumbing every menu screen
 * needs to sit on the stack (show/hide, inert, the focus ring).
 */

import type { InputContext, KeyInput, KeyVerdict, Screen, ScreenKind } from "./screen-stack.ts";

const FOCUSABLE = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

/** The elements Tab can reach inside `root`, in document order. */
export function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if ((el as HTMLButtonElement).disabled) return false;
    // Hidden rows (a preset menu hides its level row) are not in the ring.
    return el.getClientRects().length > 0;
  });
}

export type DomScreenSpec = {
  readonly name: string;
  readonly kind: ScreenKind;
  readonly root: HTMLElement;
  /** The CSS display the root takes when shown. */
  readonly display?: string;
  readonly trapsFocus?: boolean;
  readonly pausesSim?: boolean;
  readonly inputs?: readonly InputContext[];
  /** Build the content. Called on push. */
  build(): void;
  firstFocus(): HTMLElement | null;
  onKey?(k: KeyInput): KeyVerdict;
  revealed?(): void;
  /** Extra clean-up on pop, after the root is emptied. */
  teardown?(): void;
};

export function domScreen(spec: DomScreenSpec): Screen {
  const root = spec.root;
  return {
    name: spec.name,
    kind: spec.kind,
    trapsFocus: spec.trapsFocus ?? true,
    pausesSim: spec.pausesSim ?? false,
    inputs: spec.inputs ?? ["ui"],
    firstFocus: () => spec.firstFocus(),
    focusables: () => focusablesIn(root),
    mount: () => spec.build(),
    unmount: () => {
      root.textContent = "";
      root.style.display = "none";
      root.inert = false;
      spec.teardown?.();
    },
    setVisible: (v) => {
      root.style.display = v ? (spec.display ?? "flex") : "none";
    },
    setInert: (inert) => {
      root.inert = inert;
    },
    revealed: spec.revealed,
    onKey: spec.onKey,
  };
}

/** Small element factory shared by the screens. */
export const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
