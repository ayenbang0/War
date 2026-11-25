/**
 * The seam between the kingdom layer and the battle layer (PLAN.md §B.9).
 *
 * K1 puts one thing here: the combined layer hash. K5 adds the handoff
 * contract -- `BattleSpec` built from kingdom state by one pure function,
 * `BattleResult` applied back by another -- as types in this same file.
 *
 * Why a combined hash with the parts kept visible: a desync report that says
 * only "the hashes differ" leaves you bisecting two simulations at once. The
 * kingdom hash covers KingdomWorld, the battle hash covers the live World (if
 * one is running), and comparing the parts names the layer that drifted --
 * the same philosophy as the stable/world split of the battle goldens.
 */

import { FNV_OFFSET, mixU32 } from "./hash.ts";

/** Which layer two peers disagree about, if any. */
export type Drift = "none" | "kingdom" | "battle" | "both";

function parseHex32(h: string): number {
  // Both hashes are 8 lowercase hex digits by construction; anything else is
  // a caller bug, and folding it to a fixed value would hide the drift.
  if (!/^[0-9a-f]{8}$/.test(h)) throw new Error("not a layer hash part: " + h);
  return parseInt(h, 16) | 0;
}

/**
 * h(kingdomHash, battleHash?): one 8-hex-digit fingerprint of the whole game.
 *
 * "No battle running" is mixed in as its own marker, so a kingdom alone never
 * collides with the same kingdom plus a battle whose hash happens to be zero.
 */
export function layerHash(kingdomHash: string, battleHash?: string): string {
  let h = FNV_OFFSET | 0;
  h = mixU32(h, 0x4b494e47); // "KING"
  h = mixU32(h, parseHex32(kingdomHash));
  if (battleHash === undefined) {
    h = mixU32(h, 0);
  } else {
    h = mixU32(h, 1);
    h = mixU32(h, parseHex32(battleHash));
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export type LayerHashes = { readonly kingdom: string; readonly battle?: string };

/** Compare two peers' layer hashes and name the layer that drifted. */
export function driftedLayer(a: LayerHashes, b: LayerHashes): Drift {
  const k = a.kingdom !== b.kingdom;
  const w = a.battle !== b.battle;
  return k && w ? "both" : k ? "kingdom" : w ? "battle" : "none";
}
