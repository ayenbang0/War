/**
 * A confirm dialog, as an overlay on the screen stack.
 *
 * Used wherever a single click or key would otherwise throw something away:
 * starting the chronicle over (BS-03), leaving a battle or the lesson with Esc
 * (GK-01, BS-04). Focus starts on the SAFE choice, so a stray Enter keeps what
 * the player has; Esc is the safe choice too; Tab stays inside the dialog; and
 * the battle clock is held while it is up.
 */

import { domScreen, el } from "./dom-screen.ts";
import type { Screen } from "./screen-stack.ts";

export type ConfirmSpec = {
  readonly title: string;
  readonly body: string;
  /** The label of the button that goes ahead. */
  readonly yes: string;
  /** The label of the safe button. */
  readonly no: string;
};

export function confirmScreen(
  root: HTMLElement, spec: ConfirmSpec, onYes: () => void, onNo: () => void,
): Screen {
  let safe: HTMLButtonElement | null = null;
  return domScreen({
    name: "confirm",
    kind: "overlay",
    root,
    pausesSim: true,
    firstFocus: () => safe,
    build: () => {
      root.textContent = "";
      root.className = "dialog";
      const panel = el("div", "dialog-panel");
      panel.setAttribute("role", "alertdialog");
      panel.setAttribute("aria-modal", "true");
      const title = el("h2", "dialog-title", spec.title);
      title.id = "dialog-title";
      panel.setAttribute("aria-labelledby", title.id);
      panel.appendChild(title);
      panel.appendChild(el("p", "dialog-body", spec.body));
      const row = el("div", "dialog-actions");
      safe = el("button", "home-teach dialog-no", spec.no) as HTMLButtonElement;
      const go = el("button", "home-play dialog-yes", spec.yes) as HTMLButtonElement;
      safe.onclick = onNo;
      go.onclick = onYes;
      row.append(safe, go);
      panel.appendChild(row);
      root.appendChild(panel);
    },
    onKey: (k) => {
      if (k.code !== "Escape") return "pass";
      onNo();
      return "handled";
    },
  });
}
