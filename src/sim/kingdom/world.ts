/**
 * The kingdom simulation (PLAN.md §B.10): Layer 3 of three.
 *
 * Same contract as the battle World, one layer up:
 *   - Mutated only by tick(), only at tick boundaries.
 *   - Orders are serialisable, queued to the next boundary and applied in
 *     (tick, player, seq) order -- never arrival order.
 *   - Every entity id comes from one monotonic counter; every list is in id
 *     order; nothing iterates a structure whose order is not defined.
 *   - Randomness only from its own named streams in sim/rng.ts, one per
 *     subsystem, so a new roll in the economy never moves the weather.
 *   - No DOM, no wall clock, no Math outside sim/math.ts. It runs headless,
 *     which is how tools/kingdom-headless.ts drives ten years of it.
 *
 * What K1 actually simulates is small on purpose: the day clock, the weather,
 * the region graph with its owners, and the exiled king's retinue marching by
 * road. Everything else in §B is a later phase; the state already has room
 * for it (state.ts) so the save format and the hash do not change shape when
 * it arrives. The tick body below lists where each phase plugs in.
 */

import { ceil } from "../math.ts";
import { Rng, Stream } from "../rng.ts";
import { FACTION_IDS, KING_PLAYER } from "../../content/kingdom/factions.ts";
import { RIMAROS, holdingSeed, type KingdomMapDef } from "../../content/kingdom/map.ts";
import {
  BIOMES, HOLDING_KINDS, ROAD_TERRAIN, WEATHER, WEATHER_IDS, WEATHER_ODDS, WEATHER_PERSISTENCE,
  type WeatherId,
} from "../../content/kingdom/terrain.ts";
import { levelById } from "../../content/levels/index.ts";
import { TICKS_PER_DAY, calendar, isDayStart, type CalendarDate } from "./clock.ts";
import { KingdomOrderQueue, type KingdomOrder, type KingdomOrderBody } from "./orders.ts";
import {
  advanceMover, buildGraph, findRoute, moverAt, moverPosition, roadLength, setRoute,
  type RoadGraph, type Route,
} from "./graph.ts";
import type { FieldPlot, Holding, KingToken, KingdomEvent, Road } from "./state.ts";

/** Default name of the exiled king (docs/PROVISIONAL.md A.7.3). */
export const DEFAULT_KING_NAME = "Aldric of Rimaros";

/**
 * How far the king's retinue marches in a day of clear weather on a plain
 * road, in miles. Two people on foot with a mule, keeping off the main roads:
 * a little under a fit walker's day. An army (K4) will be slower, set by its
 * slowest company and its wagons.
 */
export const RETINUE_MILES_PER_DAY = 18;

export type KingdomConfig = {
  readonly seed: number;
  /** Defaults to the campaign map. */
  readonly map?: KingdomMapDef;
  readonly kingName?: string;
};

export type KingdomRng = {
  readonly economy: Rng;
  readonly events: Rng;
  readonly kingdomAi: Rng;
  readonly autoresolve: Rng;
  readonly weather: Rng;
};

/** Stream order for hashing and saving. Append only. */
export const KINGDOM_STREAMS: readonly (keyof KingdomRng)[] = [
  "economy", "events", "kingdomAi", "autoresolve", "weather",
];

export class KingdomWorld {
  readonly seed: number;
  readonly map: KingdomMapDef;

  /**
   * Kingdom ticks elapsed. Called `now` rather than `tick` (as the battle
   * World's counter is) because `tick` is the method that advances it.
   */
  now = 0;
  /** The single entity id counter. Ids start at 1, so 0 can mean "none". */
  nextId = 1;

  /** In id order, which is the map's listing order. */
  readonly holdings: Holding[] = [];
  /** In id order. */
  readonly roads: Road[] = [];
  readonly king: KingToken;
  /** Today's weather, rolled on the first tick of each day. */
  weather: WeatherId = "clear";

  readonly rng: KingdomRng;
  readonly orders = new KingdomOrderQueue();
  /**
   * Every order applied since the world began, in the order applied (stamped
   * ticks included). Replaying it into a fresh world of the same seed
   * reproduces this one exactly; the save carries it for that reason.
   */
  readonly log: KingdomOrder[] = [];
  /** What happened on the last tick. Transient; see KingdomEvent. */
  events: KingdomEvent[] = [];

  readonly graph: RoadGraph;
  private readonly byKey = new Map<string, Holding>();

  constructor(config: KingdomConfig) {
    this.seed = config.seed | 0;
    this.map = config.map ?? RIMAROS;
    this.rng = {
      economy: Rng.create(this.seed, Stream.Economy),
      events: Rng.create(this.seed, Stream.Events),
      kingdomAi: Rng.create(this.seed, Stream.KingdomAi),
      autoresolve: Rng.create(this.seed, Stream.Autoresolve),
      weather: Rng.create(this.seed, Stream.Weather),
    };

    // Ids are handed out in a fixed order -- holdings, then roads, then field
    // plots, then the king -- all in the map's listing order. Building the
    // same map always yields the same ids, which is what lets a save store
    // dynamic state only and re-attach it to freshly built content.
    const provinceBiome = new Map(this.map.provinces.map((p) => [p.id, p.biome]));
    for (const def of this.map.holdings) {
      const biome = def.biome ?? (provinceBiome.get(def.province) as Holding["biome"]);
      const level = levelById(BIOMES[biome].level);
      const kind = HOLDING_KINDS[def.kind];
      const h: Holding = {
        id: this.nextId++,
        key: def.key,
        name: def.name,
        province: def.province,
        kind: def.kind,
        biome,
        x: def.x,
        y: def.y,
        seed: holdingSeed(def, level ? level.seed : 0),
        owner: def.owner,
        population: def.population ?? kind.population,
        garrisonSlots: kind.garrisonSlots,
        garrison: [],
        buildings: new Array<string | null>(kind.buildingSlots).fill(null),
        plots: [],
      };
      this.holdings.push(h);
      this.byKey.set(h.key, h);
    }
    for (const [ka, kb, terrain] of this.map.roads) {
      const ha = this.byKey.get(ka) as Holding;
      const hb = this.byKey.get(kb) as Holding;
      const [a, b] = ha.id < hb.id ? [ha, hb] : [hb, ha];
      this.roads.push({
        id: this.nextId++,
        a: a.id,
        b: b.id,
        terrain,
        length: roadLength(a, b),
        cost: ROAD_TERRAIN[terrain].cost,
      });
    }
    for (const h of this.holdings) {
      const n = HOLDING_KINDS[h.kind].fieldPlots;
      for (let i = 0; i < n; i++) {
        const plot: FieldPlot = { id: this.nextId++, crop: null, stage: "empty", progress: 0 };
        h.plots.push(plot);
      }
    }
    const start = this.byKey.get(this.map.start) as Holding;
    this.king = {
      id: this.nextId++,
      name: config.kingName ?? DEFAULT_KING_NAME,
      companions: ["Brother Aldous"],
      mover: moverAt(start.id),
    };

    this.graph = buildGraph(this.holdings, this.roads);
  }

  // -- orders ------------------------------------------------------------------

  /**
   * Stamp an order for the next tick boundary and queue it. Returns the
   * stamped order, which is what a netplay layer would send to the peer.
   */
  issue(body: KingdomOrderBody, player: number = KING_PLAYER): KingdomOrder {
    return this.orders.push(this.orders.stamp(body, player, this.now), this.now);
  }

  /** Queue an already-stamped order (from a log, a peer, or the AI). */
  submit(order: KingdomOrder): KingdomOrder {
    return this.orders.push(order, this.now);
  }

  // -- the tick ----------------------------------------------------------------

  /**
   * Advance one kingdom tick.
   *
   * `orders` are queued first and then everything due is applied in canonical
   * order, so passing a batch here, or submitting the same orders one by one
   * beforehand in any order, comes to the same thing.
   *
   * Returns this tick's events.
   */
  tick(orders: readonly KingdomOrder[] = []): KingdomEvent[] {
    for (const o of orders) this.submit(o);
    this.events = [];

    if (isDayStart(this.now)) this.beginDay();
    // K3: economy (taxes, harvest, consumption) at the day boundary.
    // K8: captains' AI issues orders here, through this.orders, before draining.
    for (const order of this.orders.drain(this.now)) {
      this.log.push(order);
      this.applyOrder(order);
    }
    this.marchKing();
    // K4: armies march (same advanceMover).  K5: contact check, in army-id order.
    // K6: morale and unrest.  K7: contracts and wages.
    this.now++;
    return this.events;
  }

  private beginDay(): void {
    this.weather = this.rollWeather();
    this.events.push({ kind: "dayBegan", day: calendar(this.now).day, weather: this.weather });
  }

  /**
   * Today's weather: a spell of yesterday's, or a fresh draw from the season.
   *
   * Integer odds and an integer draw, so the boundary between two weathers is
   * exact. The persistence roll is only made when yesterday's weather is
   * possible in today's season, which is a deterministic condition, so the
   * stream is consumed identically on every machine.
   */
  private rollWeather(): WeatherId {
    const odds = WEATHER_ODDS[calendar(this.now).season];
    const r = this.rng.weather;
    const current = WEATHER_IDS.indexOf(this.weather);
    if (odds[current] > 0 && r.chance(WEATHER_PERSISTENCE)) return this.weather;
    let total = 0;
    for (const o of odds) total += o;
    let pick = r.int(total);
    for (let i = 0; i < odds.length; i++) {
      if (pick < odds[i]) return WEATHER_IDS[i];
      pick -= odds[i];
    }
    return WEATHER_IDS[0];
  }

  private applyOrder(order: KingdomOrder): void {
    switch (order.kind) {
      case "moveKing": {
        if (order.player !== KING_PLAYER) return this.reject(order, "only the king's seat commands the king");
        const route = findRoute(this.graph, this.king.mover, order.to);
        if (!route) return this.reject(order, "no road leads there");
        setRoute(this.graph, this.king.mover, route);
        return;
      }
      case "haltKing": {
        if (order.player !== KING_PLAYER) return this.reject(order, "only the king's seat commands the king");
        this.king.mover.route = [];
        return;
      }
    }
  }

  private reject(order: KingdomOrder, reason: string): void {
    this.events.push({
      kind: "orderRejected",
      order: { kind: order.kind, player: order.player, seq: order.seq },
      reason,
    });
  }

  private marchKing(): void {
    const m = this.king.mover;
    const leaving = m.road === 0 && m.route.length > 0 ? m.node : 0;
    const heading = m.route[0];
    const reached = advanceMover(this.graph, m, this.retinueEffortPerTick(), WEATHER[this.weather].travel);
    if (leaving !== 0) this.events.push({ kind: "kingDeparted", from: leaving, to: heading });
    for (let i = 0; i < reached.length; i++) {
      const last = i === reached.length - 1 && m.route.length === 0;
      this.events.push({ kind: "kingArrived", at: reached[i], destination: last });
    }
  }

  /** Effort the retinue has per tick in clear weather (miles x surface cost). */
  retinueEffortPerTick(): number {
    return RETINUE_MILES_PER_DAY / TICKS_PER_DAY;
  }

  // -- queries (read-only; for the UI, the AI and the tests) ------------------

  get date(): CalendarDate {
    return calendar(this.now);
  }

  holding(id: number): Holding | undefined {
    return this.graph.holdings.get(id);
  }

  holdingByKey(key: string): Holding | undefined {
    return this.byKey.get(key);
  }

  /** The king's position in map miles, interpolated along his road. */
  kingPosition(): { x: number; y: number } {
    return moverPosition(this.graph, this.king.mover);
  }

  /**
   * The route a moveKing to `to` would take now, and roughly how many ticks it
   * would take at today's weather. For the march preview ghost (K2); changes
   * nothing.
   */
  planKingRoute(to: number): { route: Route; etaTicks: number } | null {
    const route = findRoute(this.graph, this.king.mover, to);
    if (!route) return null;
    const etaTicks = ceil((route.effort * WEATHER[this.weather].travel) / this.retinueEffortPerTick());
    return { route, etaTicks };
  }

  /** Holdings a faction owns, in id order. `null` lists the unclaimed ones. */
  holdingsOf(owner: (typeof FACTION_IDS)[number] | null): Holding[] {
    return this.holdings.filter((h) => h.owner === owner);
  }
}
