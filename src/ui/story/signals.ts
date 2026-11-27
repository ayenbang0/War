/**
 * K9: what the tutorial hears (content/story/tutorial.ts `TutorialSuccess`).
 *
 * Each place in the app where a control DOES something -- a camera actually
 * panned, an order the world accepted, a card that opened -- says so here in
 * one line, and the tutorial runner (ui/story/coach.ts), when one is running,
 * matches it against the step it is waiting on. Nothing here decides
 * anything: an emit with nobody listening costs one empty loop.
 *
 * A bus rather than a hook threaded through every layer's constructor,
 * because the signals come from deep inside classes (the camera controls,
 * the battle commander, the city's taps) that know nothing of the tutorial
 * and should not: the old lesson watched the board from outside for the same
 * reason (src/ui/tutorial.ts). The signal is sent only for what HAPPENED --
 * a refused stroke, a refused order, a button that did nothing are silent --
 * so a step can never be ticked off by a stroke that went nowhere.
 *
 * UI only (never src/sim/): the sim stays ignorant of who is watching.
 */

import type { TutorialSuccess } from "../../content/story/tutorial.ts";

/** A thing that happened, in the tutorial table's own terms. */
export type TutorialSignal = TutorialSuccess;

type Listener = (s: TutorialSignal) => void;

const listeners: Listener[] = [];

/** Say that a control did what it does. */
export function signal(s: TutorialSignal): void {
  // A copy: a listener may finish the tutorial and unsubscribe mid-loop.
  for (const l of listeners.slice()) l(s);
}

/** Listen; the returned function stops listening. */
export function onSignal(l: Listener): () => void {
  listeners.push(l);
  return () => {
    const i = listeners.indexOf(l);
    if (i >= 0) listeners.splice(i, 1);
  };
}
