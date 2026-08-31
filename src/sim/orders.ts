/**
 * Orders are the only way anything mutates the world from outside the sim.
 *
 * They are plain serializable data stamped with the tick they take effect on,
 * which is what makes three things possible at once: recorded replays, headless
 * regression tests, and (Phase 10) lockstep netplay where both peers apply an
 * identical order stream. Nothing in render/ or input/ may touch world state
 * directly -- it emits an Order instead.
 *
 * The union already covers all six gestures from the spec. Phase 0 implements
 * Move only; the rest are accepted and ignored until their phase lands.
 */

export type FormationShape = "line" | "column" | "wedge" | "square" | "loose" | "tight";

export type OrderBody =
  | { kind: "move"; unit: number; path: readonly number[] }
  | { kind: "attack"; unit: number; target: number; path: readonly number[] }
  | { kind: "hold"; unit: number; x: number; y: number; radius: number }
  | { kind: "formation"; unit: number; shape: FormationShape }
  | { kind: "retreat"; unit: number; path: readonly number[] }
  | { kind: "patrol"; unit: number; path: readonly number[] };

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

  /** Stamp and enqueue an order for `tick`. Returns the stamped order. */
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

  /** Remove and return every order due at or before `tick`, in canonical order. */
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
