/**
 * Layer 3, the kingdom -- a typed stub.
 *
 * K0 only gives the layer controller its shape: `Layer = KingdomLayer |
 * BattleLayer`, so that the controller's switch over layers is exhaustive from
 * the start and K1/K2 fill this in without touching the controller's structure.
 * Nothing in the UI can reach it yet: no screen pushes it and the controller
 * refuses to enter it (see App.enterLayer).
 */

import type { InputContext, KeyInput, KeyVerdict } from "../ui/screen-stack.ts";
import type { LayerKeys } from "../ui/keys.ts";

/** Where the kingdom layer is in its life; mirrors BattlePhase. */
export type KingdomPhase = "built" | "live" | "torn-down";

/** What leaving the kingdom layer hands back. Empty until K1 has a KingdomWorld. */
export type KingdomReport = { readonly days: number };

export class KingdomLayer implements LayerKeys {
  readonly kind = "kingdom" as const;
  phase: KingdomPhase = "built";

  start(): void {
    throw new Error("the kingdom layer is not built yet (plan phases K1-K2)");
  }

  teardown(): KingdomReport {
    this.phase = "torn-down";
    return { days: 0 };
  }

  setContexts(_contexts: readonly InputContext[]): void {
    /* K2: the kingdom map's pen and camera */
  }

  keyDown(_k: KeyInput, _contexts: readonly InputContext[]): KeyVerdict {
    return "pass";
  }

  keyUp(_code: string): void {
    /* nothing held yet */
  }

  releaseAll(): void {
    /* nothing held yet */
  }
}
