/**
 * The motion setting every animated thing on the battlefield reads.
 *
 * One switch, defaulted from the player's `prefers-reduced-motion` and kept in
 * step with it (docs/ui-policy.md, "Motion"). With it on, nothing that is
 * decoration moves on its own: men stop fidgeting, a barrage's bursts and a
 * fire's flames stand still, auras stop beating, after-images stop orbiting, a
 * rejected stroke greys out without shaking, and kill flashes become a steady
 * mark instead of an expanding pop. What carries information -- men marching,
 * arrows flying, a countdown ring closing -- still moves, because freezing it
 * would hide the battle rather than calm it.
 *
 * A plain mutable object rather than a parameter threaded through every draw
 * call, because it is a property of the player, not of any one frame, and the
 * renderer, the ink and the effects all need the same answer. Render-side only;
 * the sim never reads it.
 */

export const motion = { reduced: false };

/** Phase of an animated loop: real time normally, frozen when motion is reduced. */
export function animTime(now: number): number {
  return motion.reduced ? 0 : now;
}

/**
 * Follow the page's `prefers-reduced-motion`. Returns an undo, so a torn-down
 * battle leaves no listener behind. A no-op where matchMedia does not exist
 * (the Node test page).
 */
export function watchReducedMotion(win: { matchMedia?: (q: string) => MediaQueryList }): () => void {
  if (typeof win.matchMedia !== "function") return () => {};
  const q = win.matchMedia("(prefers-reduced-motion: reduce)");
  motion.reduced = q.matches;
  const on = (e: MediaQueryListEvent): void => {
    motion.reduced = e.matches;
  };
  // Older Safari has only addListener.
  if (typeof q.addEventListener === "function") {
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }
  q.addListener(on);
  return () => q.removeListener(on);
}
