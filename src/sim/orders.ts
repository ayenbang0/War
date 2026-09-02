/**
 * Orders are the only way anything mutates the world from outside the sim.
 *
 * They are plain serializable data stamped with the tick they take effect on,
 * which is what makes three things possible at once: recorded replays, headless
 * regression tests, and (Phase 10) lockstep netplay where both peers apply an
 * identical order stream. Nothing in render/ or input/ may touch world state
 * directly -- it emits an Order instead.
 *
 * The six bodies map one-to-one onto the six pen gestures in spec section 5.2.
 * The recognizer in input/gestures.ts produces exactly these and nothing else,
 * so the gesture vocabulary and the simulation's command vocabulary cannot
 * drift apart.
 */

import type { FormationShape } from "./formations.ts";
import type { AbilityId } from "../content/abilities.ts";

export type OrderBody =
  /** Walk the route. Paths are world-space [x0, y0, x1, y1, ...]. */
  | { kind: "move"; squad: number; path: readonly number[] }
  /** Close on an enemy squad and engage it. */
  | { kind: "attack"; squad: number; target: number; path: readonly number[] }
  /** Occupy an area and stand: no pursuit beyond radius. */
  | { kind: "hold"; squad: number; x: number; y: number; radius: number }
  /** Re-form into a different shape in place. */
  | { kind: "formation"; squad: number; shape: FormationShape }
  /** Disengage and fall back along the route. */
  | { kind: "retreat"; squad: number; path: readonly number[] }
  /** Walk the circuit forever, reversing at the ends of an open route. */
  | { kind: "patrol"; squad: number; path: readonly number[] }
  /** Stand down, close ranks, regain morale and hit points. */
  | { kind: "recover"; squad: number }
  /** Lie in wait: hold fire, keep still, and strike whoever walks into it. */
  | { kind: "ambush"; squad: number }
  /** Advance the route, wait to be seen, then withdraw the way you came. */
  | { kind: "feint"; squad: number; path: readonly number[] }
  /**
   * Spend a commander's ability on a patch of ground.
   *
   * `squad` is the company it attaches to for the ones that need one (a charge
   * is given TO somebody), or -1 for the ones that simply land somewhere.
   */
  | { kind: "ability"; squad: number; ability: AbilityId; x: number; y: number };

export type OrderKind = OrderBody["kind"];

export const ORDER_KINDS: readonly OrderKind[] = [
  "move", "attack", "hold", "formation", "retreat", "patrol", "recover",
  "ambush", "feint", "ability",
];

export type Order = OrderBody & {
  /** Tick at which this order takes effect. */
  readonly tick: number;
  /** Issuing player. */
  readonly player: number;
  /** Per-player monotonic counter, breaks ties deterministically. */
  readonly seq: number;
};

/**
 * Holds orders until their tick arrives.
 *
 * Ordering is (tick, player, seq) -- never insertion order and never the order
 * they arrived over a network, both of which vary between peers.
 */
export class OrderQueue {
  private pending: Order[] = [];
  private seqByPlayer = new Map<number, number>();

  /** Stamp and enqueue an order for tick. Returns the stamped order. */
  issue(body: OrderBody, player: number, tick: number): Order {
    const seq = (this.seqByPlayer.get(player) ?? 0) + 1;
    this.seqByPlayer.set(player, seq);
    const order: Order = { ...body, tick, player, seq };
    this.pending.push(order);
    return order;
  }

  /** Re-enqueue an already-stamped order. Used when replaying a recorded log. */
  push(order: Order): void {
    this.pending.push(order);
  }

  /** Remove and return every order due at or before tick, in canonical order. */
  drain(tick: number): Order[] {
    if (this.pending.length === 0) return [];
    const due: Order[] = [];
    const rest: Order[] = [];
    for (const o of this.pending) {
      if (o.tick <= tick) due.push(o);
      else rest.push(o);
    }
    this.pending = rest;
    due.sort((a, b) => a.tick - b.tick || a.player - b.player || a.seq - b.seq);
    return due;
  }

  get size(): number {
    return this.pending.length;
  }
}
