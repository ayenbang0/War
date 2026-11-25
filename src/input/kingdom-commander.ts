/**
 * Turns a pen stroke on the kingdom map into what it will do: ONE function,
 * `interpretStroke`, decides both the ghost the player sees while drawing and
 * the order issued on release (U0 PC-03/PC-07, U1-03). The battle computed its
 * preview and its commit along two different paths, and they disagreed (an
 * armed ability previewed as MOVE and landed as a barrage; a carve previewed
 * as GROUP 0). Here the pen calls `interpretStroke` on every sample, draws
 * `ghost`, and on release issues exactly `order` -- the same value, from the
 * same call, on the same stroke.
 *
 * Reads the KingdomWorld, never writes it: the only write is the caller's
 * `world.issue(intent.order)`, which queues for the next tick boundary like
 * every other order.
 */

import type { KingdomWorld } from "../sim/kingdom/world.ts";
import type { KingdomOrderBody } from "../sim/kingdom/orders.ts";
import { TICKS_PER_DAY } from "../sim/kingdom/clock.ts";
import { KING_PLAYER } from "../content/kingdom/factions.ts";
import { K, NONE_PLATE, NONE_REASON, etaWords } from "../content/kingdom/ui-strings.ts";
import { kingCounterAt, type MapPoint } from "../render/kingdom/layout.ts";
import {
  recognizeKingdom, type HoldingView, type KingdomGesture, type KingdomGestureContext, type Point, type TokenView,
} from "./kingdom-gestures.ts";

export type KingdomGhost =
  /** The road route the march would take, from the king to the destination. */
  | { readonly kind: "march"; readonly route: readonly MapPoint[]; readonly dest: MapPoint; readonly label: string }
  /** The stroke means nothing; the plate says why. */
  | { readonly kind: "none"; readonly label: string }
  /** A tap: names what it will open. */
  | { readonly kind: "tap"; readonly label: string };

export type KingdomCardRequest = { readonly kind: "region"; readonly holding: number } | { readonly kind: "king" };

export type KingdomIntent = {
  readonly gesture: KingdomGesture;
  readonly ghost: KingdomGhost;
  /** What release issues through world.issue. Null when the stroke orders nothing. */
  readonly order: KingdomOrderBody | null;
  /** What release opens. */
  readonly card: KingdomCardRequest | null;
  /** The result line after release. */
  readonly message: string;
  /** Where commit feedback lands (the destination), if anywhere. */
  readonly at: MapPoint | null;
  /** For a march: the destination's name and the ETA in words. */
  readonly march: { readonly to: number; readonly name: string; readonly eta: string; readonly etaTicks: number } | null;
};

/** The recogniser's view of the world at one zoom, with the king's counter where it is DRAWN. */
export function kingdomContext(world: KingdomWorld, kingTrue: MapPoint, pxToWorld: number): KingdomGestureContext {
  const counter = kingCounterAt(kingTrue, pxToWorld);
  const m = world.king.mover;
  const tokens: TokenView[] = [
    { id: world.king.id, kind: "king", owner: KING_PLAYER, x: counter.x, y: counter.y, at: m.road === 0 ? m.node : 0 },
  ];
  const holdings: HoldingView[] = world.holdings.map((h) => ({ id: h.id, x: h.x, y: h.y, kind: h.kind }));
  return { player: KING_PLAYER, tokens, holdings, pxToWorld };
}

/** Map points of a route: from where the king stands, through each holding still to reach. */
export function routePoints(world: KingdomWorld, from: MapPoint, nodes: readonly number[]): MapPoint[] {
  const out: MapPoint[] = [from];
  for (const id of nodes) {
    const h = world.holding(id);
    if (h) out.push({ x: h.x, y: h.y });
  }
  return out;
}

function none(gesture: KingdomGesture & { kind: "none" }): KingdomIntent {
  return {
    gesture,
    ghost: { kind: "none", label: NONE_PLATE[gesture.reason] },
    order: null, card: null, at: null, march: null,
    message: NONE_REASON[gesture.reason],
  };
}

/**
 * THE function: a stroke in, its whole meaning out. Called on every pen
 * sample for the preview and once more on release for the commit.
 */
export function interpretStroke(
  points: readonly Point[], ctx: KingdomGestureContext, world: KingdomWorld, kingTrue: MapPoint,
): KingdomIntent {
  const g = recognizeKingdom(points, ctx);
  switch (g.kind) {
    case "none":
      return none(g);
    case "tapToken":
      return {
        gesture: g, ghost: { kind: "tap", label: world.king.name },
        order: null, card: { kind: "king" }, at: null, march: null, message: "",
      };
    case "tapHolding": {
      const h = world.holding(g.holding);
      return {
        gesture: g, ghost: { kind: "tap", label: h ? h.name : "" },
        order: null, card: { kind: "region", holding: g.holding }, at: h ? { x: h.x, y: h.y } : null, march: null,
        message: "",
      };
    }
    case "march": {
      const h = world.holding(g.to);
      const plan = world.planKingRoute(g.to);
      if (!h || !plan) return none({ kind: "none", reason: "no-road" });
      const eta = etaWords(plan.etaTicks, TICKS_PER_DAY);
      const dest = { x: h.x, y: h.y };
      return {
        gesture: g,
        ghost: {
          kind: "march",
          route: routePoints(world, kingTrue, plan.route.nodes),
          dest,
          label: K.marchPlate({ name: h.name, eta }),
        },
        order: { kind: "moveKing", to: g.to },
        card: null,
        at: dest,
        march: { to: g.to, name: h.name, eta, etaTicks: plan.etaTicks },
        message: K.setOut({ name: h.name, eta }),
      };
    }
  }
}
