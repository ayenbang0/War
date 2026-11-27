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
import { armyCounterAt, fanSlots, kingCounterAt, type MapPoint } from "../render/kingdom/layout.ts";
import { isFrontier, knowsHolding } from "../sim/kingdom/explore.ts";
import { armyById, armyPosition, armyVisible, planArmyRoute, standsIn } from "../sim/kingdom/armies.ts";
import type { Army } from "../sim/kingdom/state.ts";
import { ARMY_REFUSAL, PEN } from "../content/kingdom/army-strings.ts";
import { FACTIONS, FACTION_IDS } from "../content/kingdom/factions.ts";
import { X } from "../content/story/strings.ts";
import {
  recognizeKingdom, type HoldingView, type KingdomGesture, type KingdomGestureContext, type Point, type TokenView,
} from "./kingdom-gestures.ts";

export type KingdomGhost =
  /** The road route the march would take, from the king to the destination. */
  | { readonly kind: "march"; readonly route: readonly MapPoint[]; readonly dest: MapPoint; readonly label: string }
  /** The stroke means nothing; the plate says why. */
  | { readonly kind: "none"; readonly label: string }
  /** A tap: names what it will open. */
  | { readonly kind: "tap"; readonly label: string }
  /**
   * An army order that is not a march (intercept, merge, join, split,
   * garrison, patrol, recover): `path` is drawn dashed (the line to meet, the
   * patrol's round), `rings` are circled (where it digs in, what it walks).
   */
  | { readonly kind: "order"; readonly path: readonly MapPoint[]; readonly rings: readonly MapPoint[]; readonly label: string };

export type KingdomCardRequest =
  | { readonly kind: "region"; readonly holding: number }
  | { readonly kind: "king" }
  | { readonly kind: "army"; readonly army: number };

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

/** Where each army the seat sees truly is (interpolated by the layer for drawing; tick-exact by default). */
export type ArmyPoints = ReadonlyMap<number, MapPoint>;

/** The armies `player` can see, in id order. */
export function visibleArmies(world: KingdomWorld, player: number = KING_PLAYER): Army[] {
  return world.armies.filter((a) => armyVisible(world, player, a));
}

/** The true map point of every visible army, tick-exact. */
export function armyPointsOf(world: KingdomWorld, player: number = KING_PLAYER): Map<number, MapPoint> {
  const out = new Map<number, MapPoint>();
  for (const a of visibleArmies(world, player)) out.set(a.id, armyPosition(world, a));
  return out;
}

/**
 * Where each visible army's counter is DRAWN (render/kingdom/layout.ts):
 * below its true point, fanned when several stand together. The renderer and
 * the pen both read this, so what you see is what you can grab.
 */
export function armyCounters(world: KingdomWorld, points: ArmyPoints, pxToWorld: number, player: number = KING_PLAYER):
  { army: Army; at: MapPoint; counter: MapPoint }[] {
  const list = visibleArmies(world, player).filter((a) => points.has(a.id));
  const slots = fanSlots(list.map((a) => ({ id: a.id, x: points.get(a.id)!.x, y: points.get(a.id)!.y })));
  return list.map((a, i) => {
    const at = points.get(a.id)!;
    return { army: a, at, counter: armyCounterAt(at, slots[i].slot, slots[i].count, pxToWorld) };
  });
}

/** The recogniser's view of the world at one zoom, with every counter where it is DRAWN. */
export function kingdomContext(world: KingdomWorld, kingTrue: MapPoint, pxToWorld: number, points?: ArmyPoints): KingdomGestureContext {
  const counter = kingCounterAt(kingTrue, pxToWorld);
  const m = world.king.mover;
  const tokens: TokenView[] = [
    { id: world.king.id, kind: "king", owner: KING_PLAYER, x: counter.x, y: counter.y, at: m.road === 0 ? m.node : 0 },
  ];
  for (const c of armyCounters(world, points ?? armyPointsOf(world), pxToWorld)) {
    tokens.push({ id: c.army.id, kind: "army", owner: c.army.owner, x: c.counter.x, y: c.counter.y, at: standsIn(c.army.mover) });
  }
  // K3a: the pen sees only what the king knows -- known holdings, and the
  // unexplored marks at the ends of roads he knows. A place he has never
  // heard of is not there to tap or march to.
  const holdings: HoldingView[] = world.holdings
    .filter((h) => knowsHolding(world, KING_PLAYER, h.id) || isFrontier(world, KING_PLAYER, h.id))
    .map((h) => ({ id: h.id, x: h.x, y: h.y, kind: h.kind }));
  return { player: KING_PLAYER, tokens, holdings, pxToWorld };
}

/** "the First Army", or for another side's, "the First Army of the Boar". */
export function armyTitle(a: Army, player: number = KING_PLAYER): string {
  if (a.owner === player) return a.name;
  const f = FACTIONS[FACTION_IDS[a.owner]];
  return a.name + " of " + (f ? f.name : "?");
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

/** A recognised army stroke the sim would refuse: the plate and the result line say why. */
function refused(gesture: KingdomGesture, why: string, at: MapPoint | null): KingdomIntent {
  return {
    gesture,
    ghost: { kind: "none", label: PEN.refusedPlate(why) },
    order: null, card: null, at, march: null,
    message: why.charAt(0).toUpperCase() + why.slice(1) + ".",
  };
}

/** An army order, held to the sim's own check: the same check that will judge it on the tick. */
function armyOrder(
  world: KingdomWorld, gesture: KingdomGesture, order: KingdomOrderBody, ghost: KingdomGhost & { kind: "order" },
  message: string, at: MapPoint | null,
): KingdomIntent {
  const why = world.check(order, KING_PLAYER);
  if (why) return refused(gesture, why, at);
  return { gesture, ghost, order, card: null, at, march: null, message };
}

/**
 * THE function: a stroke in, its whole meaning out. Called on every pen
 * sample for the preview and once more on release for the commit.
 */
export function interpretStroke(
  points: readonly Point[], ctx: KingdomGestureContext, world: KingdomWorld, kingTrue: MapPoint, armyPoints?: ArmyPoints,
): KingdomIntent {
  const g = recognizeKingdom(points, ctx);
  const pts = armyPoints ?? armyPointsOf(world);
  const where = (a: Army | undefined): MapPoint | null => (a ? pts.get(a.id) ?? armyPosition(world, a) : null);
  const holdingPoint = (id: number): MapPoint | null => {
    const h = world.holding(id);
    return h ? { x: h.x, y: h.y } : null;
  };
  const nameOf = (id: number): string => {
    const h = world.holding(id);
    return h ? (knowsHolding(world, KING_PLAYER, h.id) ? h.name : X.unexplored) : "";
  };
  switch (g.kind) {
    case "none":
      return none(g);
    case "tapToken": {
      const a = armyById(world, g.token);
      if (a) {
        return {
          gesture: g, ghost: { kind: "tap", label: armyTitle(a) },
          order: null, card: { kind: "army", army: a.id }, at: where(a), march: null, message: "",
        };
      }
      return {
        gesture: g, ghost: { kind: "tap", label: world.king.name },
        order: null, card: { kind: "king" }, at: null, march: null, message: "",
      };
    }
    case "tapHolding": {
      const h = world.holding(g.holding);
      if (h && !knowsHolding(world, KING_PLAYER, h.id)) {
        // An unexplored mark: nothing to show until someone has been there.
        return {
          gesture: g, ghost: { kind: "tap", label: X.unexplored },
          order: null, card: null, at: { x: h.x, y: h.y }, march: null, message: X.unexploredTap,
        };
      }
      return {
        gesture: g, ghost: { kind: "tap", label: h ? h.name : "" },
        order: null, card: { kind: "region", holding: g.holding }, at: h ? { x: h.x, y: h.y } : null, march: null,
        message: "",
      };
    }
    case "march": {
      const army = armyById(world, g.token);
      if (army) return armyMarch(world, g, army, where(army)!, g.to, nameOf(g.to));
      const h = world.holding(g.to);
      const plan = world.planKingRoute(g.to);
      if (!h || !plan) return none({ kind: "none", reason: "no-road" });
      const eta = etaWords(plan.etaTicks, TICKS_PER_DAY);
      const dest = { x: h.x, y: h.y };
      // An unexplored mark has no name yet.
      const name = nameOf(h.id);
      return {
        gesture: g,
        ghost: {
          kind: "march",
          route: routePoints(world, kingTrue, plan.route.nodes),
          dest,
          label: K.marchPlate({ name, eta }),
        },
        order: { kind: "moveKing", to: g.to },
        card: null,
        at: dest,
        march: { to: g.to, name, eta, etaTicks: plan.etaTicks },
        message: K.setOut({ name, eta }),
      };
    }
    case "intercept": {
      const target = armyById(world, g.target);
      const own = armyById(world, g.token) ?? armyById(world, world.king.army);
      const at = where(target);
      if (!target || !at) return none({ kind: "none", reason: "nothing-there" });
      const title = armyTitle(target);
      if (!own) return refused(g, ARMY_REFUSAL.kingAlone, at);
      return armyOrder(world, g, { kind: "intercept", army: own.id, target: target.id },
        { kind: "order", path: [where(own)!, at], rings: [at], label: PEN.interceptPlate({ army: own.name, target: title }) },
        PEN.interceptDone({ army: own.name, target: title }), at);
    }
    case "merge": {
      const a = armyById(world, g.army);
      const into = armyById(world, g.into);
      if (!a || !into) return none({ kind: "none", reason: "nothing-there" });
      const at = where(into)!;
      return armyOrder(world, g, { kind: "merge", army: a.id, into: into.id },
        { kind: "order", path: [where(a)!, at], rings: [at], label: PEN.mergePlate({ army: a.name, into: into.name }) },
        PEN.mergeDone({ army: a.name, into: into.name }), at);
    }
    case "join": {
      const a = armyById(world, g.army);
      if (!a) return none({ kind: "none", reason: "nothing-there" });
      const at = where(a)!;
      return armyOrder(world, g, { kind: "kingJoin", army: a.id },
        { kind: "order", path: [kingTrue, at], rings: [at], label: PEN.joinPlate(a.name) }, PEN.joinDone(a.name), at);
    }
    case "split": {
      const a = armyById(world, g.army);
      if (!a) return none({ kind: "none", reason: "nothing-there" });
      const at = where(a)!;
      if (a.squads.length < 2) return refused(g, PEN.splitOne, at);
      // A line across an army halves it: the later squads (by id) part off,
      // the earlier -- and any odd one -- stay with the army and its name.
      const keep = Math.ceil(a.squads.length / 2);
      const squads = a.squads.slice(keep).map((q) => q.id);
      return armyOrder(world, g, { kind: "split", army: a.id, squads },
        { kind: "order", path: [], rings: [at], label: PEN.splitPlate({ army: a.name, n: squads.length }) },
        PEN.splitDone({ army: a.name, n: squads.length }), at);
    }
    case "garrison": {
      const a = armyById(world, g.army);
      if (!a) return none({ kind: "none", reason: "nothing-there" });
      const stands = standsIn(a.mover);
      const at = (g.holding ? holdingPoint(g.holding) : null) ?? where(a)!;
      // The ring names where to dig in; the army must already be there.
      if (g.holding !== 0 && g.holding !== stands) return refused(g, ARMY_REFUSAL.armyNotThere, at);
      const name = nameOf(stands);
      return armyOrder(world, g, { kind: "garrison", army: a.id },
        { kind: "order", path: [], rings: [at], label: PEN.garrisonPlate({ army: a.name, name }) },
        PEN.garrisonDone({ army: a.name, name }), at);
    }
    case "patrol": {
      const a = armyById(world, g.army);
      if (!a) return none({ kind: "none", reason: "nothing-there" });
      const rings = g.holdings.map(holdingPoint).filter((p): p is MapPoint => p !== null);
      const names = g.holdings.map(nameOf).join(", ");
      return armyOrder(world, g, { kind: "patrol", army: a.id, holdings: [...g.holdings] },
        { kind: "order", path: [...rings, rings[0]], rings, label: PEN.patrolPlate({ army: a.name, n: g.holdings.length }) },
        PEN.patrolDone({ army: a.name, names }), rings[0] ?? null);
    }
    case "recover": {
      const a = armyById(world, g.army);
      if (!a) return none({ kind: "none", reason: "nothing-there" });
      const at = where(a)!;
      return armyOrder(world, g, { kind: "recover", army: a.id },
        { kind: "order", path: [], rings: [at], label: PEN.recoverPlate(a.name) }, PEN.recoverDone(a.name), at);
    }
  }
}

/** A march for an army: the sim's own plan for the ghost, its check for the refusal. */
function armyMarch(world: KingdomWorld, g: KingdomGesture, army: Army, from: MapPoint, to: number, name: string): KingdomIntent {
  const order: KingdomOrderBody = { kind: "marchArmy", army: army.id, to };
  const h = world.holding(to);
  const dest = h ? { x: h.x, y: h.y } : null;
  const why = world.check(order, KING_PLAYER);
  if (why) return refused(g, why, dest);
  const plan = planArmyRoute(world, army, to);
  if (!h || !dest || !plan) return none({ kind: "none", reason: "no-road" });
  const eta = etaWords(plan.etaTicks, TICKS_PER_DAY);
  return {
    gesture: g,
    ghost: { kind: "march", route: routePoints(world, from, plan.route.nodes), dest, label: PEN.armyMarchPlate({ army: army.name, name, eta }) },
    order,
    card: null,
    at: dest,
    march: { to, name, eta, etaTicks: plan.etaTicks },
    message: PEN.armySetOut({ army: army.name, name, eta }),
  };
}
