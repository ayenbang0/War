/**
 * The explicit window the e2e harness (src/e2e/) is given into the app.
 *
 * Scenarios READ app state through this -- which screen is on top, the live
 * battle's world and camera -- so they can find the player's men on screen and
 * check what a stroke did. They never DRIVE the app through it: every input in
 * a scenario is a real PointerEvent or KeyboardEvent dispatched on the page.
 * The single exception is `forceOutcome`, which stands in for fifteen minutes
 * of fighting so the after-action path can be reached at all.
 *
 * The game page (main.ts) never builds one.
 */

import type { App } from "./app.ts";
import type { BattleLayer } from "./battle-layer.ts";
import type { StorageStatus } from "./progress-store.ts";

export type TestHook = {
  readonly app: App;
  /** Screen names, bottom to top. */
  screens(): string[];
  top(): string | null;
  /** The live battle, or null. */
  battle(): BattleLayer | null;
  storage(): StorageStatus;
  /** End the live battle now with this winner (0 is the player). */
  forceOutcome(winner: number): void;
};

export function testHook(app: App): TestHook {
  const battle = (): BattleLayer | null => (app.live && app.live.kind === "battle" ? app.live : null);
  return {
    app,
    screens: () => app.stack.names(),
    top: () => app.stack.top?.name ?? null,
    battle,
    storage: () => app.store.status,
    forceOutcome: (winner) => {
      const b = battle();
      if (!b) throw new Error("no battle is live");
      b.world.outcome = { winner, reason: "rout", detail: "ended by the e2e harness" };
    },
  };
}
