/**
 * Kingdom orders: the only way anything outside the sim changes the kingdom.
 *
 * The same contract as battle orders (sim/orders.ts): plain serialisable data,
 * stamped with the tick it takes effect on, the issuing player and a
 * per-player sequence number, and applied at a tick boundary in
 * (tick, player, seq) order -- never in the order it arrived, which differs
 * between a live game, a replay and two netplay peers. The pen (K2), the
 * panels (K3+) and the captains' AI (K8) all emit these, so a recorded log
 * replays the whole campaign.
 *
 * `player` is a faction's index in FACTION_IDS; the human king is 0.
 *
 * Pause and game speed are NOT orders. They decide how often the UI calls
 * tick(), which a replay does not care about.
 */

import type { BuildingId } from "../../content/kingdom/buildings.ts";
import type { CropId } from "../../content/kingdom/crops.ts";
import type { TaxRateId } from "../../content/kingdom/economy.ts";

export type KingdomOrderBody =
  /** March the king's retinue by road to a holding. Replaces any march, and ends a forage or rally. */
  | { kind: "moveKing"; to: number }
  /** Stop where the retinue stands, even halfway along a road; also ends a forage or rally. */
  | { kind: "haltKing" }
  // -- K3: the economy, from nothing (PLAN.md §A.5, §B.3) --
  /** The king's party gathers food and deadwood where it stands, each day until told otherwise. */
  | { kind: "forage" }
  /** At an unclaimed hamlet: spend days winning followers to the levy. */
  | { kind: "rally" }
  /** Take an unowned holding with no garrison and no army, without a battle (§B.8). The king must be there. */
  | { kind: "claimHolding"; holding: number }
  /** Set the tax of one owned holding, or of every one (holding 0, which also sets the default for new claims). */
  | { kind: "setTax"; holding: number; rate: TaxRateId }
  /** Start a building in a free slot (or over the building it upgrades) of an owned holding. */
  | { kind: "build"; holding: number; building: BuildingId }
  /** Sow a crop in a plot of an owned holding: empty, harvested or spoiled. */
  | { kind: "sow"; plot: number; crop: CropId }
  /** Reap a ripe plot. */
  | { kind: "harvest"; plot: number }
  // -- K3a: exploration --
  /** Answer the letter waiting from a site: pick choice `choice` (0-based) of its event. */
  | { kind: "resolveEvent"; site: number; choice: number };
  // K4: recruit / march / merge / split.  K7: hire / pay.
  // Append new kinds; never renumber the existing ones.

export type KingdomOrderKind = KingdomOrderBody["kind"];

export const KINGDOM_ORDER_KINDS: readonly KingdomOrderKind[] = [
  "moveKing", "haltKing", "forage", "rally", "claimHolding", "setTax", "build", "sow", "harvest",
  "resolveEvent",
];

export type KingdomOrder = KingdomOrderBody & {
  /** Kingdom tick at which this order takes effect. */
  readonly tick: number;
  /** Issuing faction's index in FACTION_IDS. */
  readonly player: number;
  /** Per-player monotonic counter; breaks ties deterministically. */
  readonly seq: number;
};

/** The canonical application order. Shared by the queue, the hash and the log. */
export function compareOrders(a: KingdomOrder, b: KingdomOrder): number {
  return a.tick - b.tick || a.player - b.player || a.seq - b.seq;
}

/**
 * Holds orders until their tick arrives.
 *
 * Unlike the battle queue its contents and sequence counters are exposed,
 * because a kingdom save must carry orders that were issued but are not due
 * yet -- a campaign is saved and resumed, a battle is not.
 */
export class KingdomOrderQueue {
  private pending: KingdomOrder[] = [];
  /** Last seq stamped per player, indexed by player. */
  private seqs: number[] = [];

  /** Stamp a body for `tick`. Returns the stamped order; does not enqueue it. */
  stamp(body: KingdomOrderBody, player: number, tick: number): KingdomOrder {
    const seq = (this.seqs[player] ?? 0) + 1;
    this.seqs[player] = seq;
    return { ...body, tick, player, seq };
  }

  /**
   * Enqueue a stamped order, no earlier than `now`.
   *
   * An order stamped for a tick that has already run is moved to `now`, the
   * next boundary, rather than lost or applied retroactively. It is moved HERE,
   * on entry, so the order the log records is the order as applied, and a
   * replay of the log reproduces the live run exactly.
   */
  push(order: KingdomOrder, now: number): KingdomOrder {
    const o = order.tick < now ? { ...order, tick: now } : order;
    // Keep the counter ahead of anything seen, so a locally stamped order
    // never reuses a seq that arrived from elsewhere (a log, a peer).
    if ((this.seqs[o.player] ?? 0) < o.seq) this.seqs[o.player] = o.seq;
    this.pending.push(o);
    return o;
  }

  /** Remove and return every order due at or before tick, in canonical order. */
  drain(tick: number): KingdomOrder[] {
    if (this.pending.length === 0) return [];
    const due: KingdomOrder[] = [];
    const rest: KingdomOrder[] = [];
    for (const o of this.pending) (o.tick <= tick ? due : rest).push(o);
    this.pending = rest;
    due.sort(compareOrders);
    return due;
  }

  /** Orders not yet due, in canonical order (independent of arrival order). */
  queued(): KingdomOrder[] {
    return [...this.pending].sort(compareOrders);
  }

  /** Last seq stamped per player, for saving. Holes are 0. */
  sequences(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.seqs.length; i++) out.push(this.seqs[i] ?? 0);
    return out;
  }

  /** Restore from a save. */
  restore(pending: readonly KingdomOrder[], seqs: readonly number[]): void {
    this.pending = [...pending];
    this.seqs = [...seqs];
  }

  get size(): number {
    return this.pending.length;
  }
}
