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
 * K1 simulated the day clock, the weather, the region graph with its owners,
 * and the exiled king's retinue marching by road. K3 adds the economy
 * (economy.ts): stockpiles and their ledger, taxes, buildings, field plots and
 * crops, famine, and the orders that start it from nothing. The tick body
 * below lists where each later phase plugs in.
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
import type { Army, FactionEconomy, FactionExploration, FieldPlot, Holding, KingToken, KingdomEvent, Road } from "./state.ts";
import {
  applyArmyOrder, armyById, checkArmyOrder, isArmyOrder, marchArmies, planArmyRoute, raiseArmy, runArmyDay, type ArmyOrderBody,
} from "./armies.ts";
import { DEFAULT_TAX } from "../../content/kingdom/economy.ts";
import type { FactionBook } from "./ledger.ts";
import { snapshotStocks } from "./ledger.ts";
import {
  applyEconomyOrder, checkEconomyOrder, dailyNeed, isEconomyOrder, newBook, newFactionEconomy, runEconomyDay, setTask,
  type EconomyOrderBody,
} from "./economy.ts";
import {
  applyResolve, checkResolve, discover, marchOptions, newExploration, routeOptions, targetRefusal, updateSight,
} from "./explore.ts";
import { EXPLORE_REFUSAL } from "../../content/story/strings.ts";
import { OPENING_HOSTS } from "../../content/kingdom/descent.ts";
import { applyContactOrder, checkContactOrder, detectContacts } from "./descent.ts";
import type { Contact } from "./state.ts";
import { applyMoraleOrder, checkMoraleOrder, isMoraleOrder, runMoraleDay, type MoraleOrderBody } from "./morale.ts";
import { DEFAULT_JUSTICE } from "../../content/kingdom/morale.ts";

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
  /**
   * K5: raise the opening hostile hosts (content/kingdom/descent.ts
   * OPENING_HOSTS) -- the Act I skirmish the king can march into. Off by
   * default, so the K1-K4 tests and the kingdom golden keep their bare world;
   * a new campaign (app/kingdom-layer.ts freshRealm) turns it on, and the save
   * remembers it (docs/PROVISIONAL.md K5.13).
   */
  readonly hosts?: boolean;
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
  /** Every faction's stores, in FACTION_IDS order (K3). */
  readonly economy: FactionEconomy[];
  /** Every faction's ledger, in FACTION_IDS order (K3). */
  readonly books: FactionBook[];
  /** Every faction's map knowledge, finds and special upgrades, in FACTION_IDS order (K3a). */
  readonly explore: FactionExploration[];
  /** Every army on the map, of every faction, in id order (K4; armies.ts). */
  readonly armies: Army[] = [];
  /** Whether this world began with the opening hosts (KingdomConfig.hosts). Set by the constructor, or by a load. */
  hosts: boolean;
  /**
   * K5: the contact the king's side is in and has not yet settled, or null.
   * While one waits the realm holds (tick): orders apply, nothing else moves.
   */
  contact: Contact | null = null;
  /**
   * K5: pairs that settled a contact and have not yet stood apart, [lower id,
   * higher id] (or [army, -holding id] for walls), sorted. They do not meet
   * again until they part (descent.ts detectContacts).
   */
  readonly disengaged: [number, number][] = [];

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
        works: new Array<number>(kind.buildingSlots).fill(0),
        idle: new Array<boolean>(kind.buildingSlots).fill(false),
        plots: [],
        tax: DEFAULT_TAX,
        taxCarry: 0,
        doleCarry: 0,
        famine: 0,
        foraged: 0,
        unrest: 0,
        justice: DEFAULT_JUSTICE,
        festival: 0,
        pardoned: 0,
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
        const plot: FieldPlot = { id: this.nextId++, crop: null, stage: "empty", progress: 0, days: 0, health: 100 };
        h.plots.push(plot);
      }
    }
    const start = this.byKey.get(this.map.start) as Holding;
    this.king = {
      id: this.nextId++,
      name: config.kingName ?? DEFAULT_KING_NAME,
      companions: ["Brother Aldous"],
      mover: moverAt(start.id),
      task: "none",
      taskDays: 0,
      army: 0,
    };

    this.graph = buildGraph(this.holdings, this.roads);
    // Stores are not entities and take no ids: the id sequence above is the
    // same as K1's, which keeps old saves' fingerprints valid (save.ts v1 -> v2).
    this.economy = FACTION_IDS.map((f) => newFactionEconomy(f));
    this.books = this.economy.map((e) => newBook(e));
    // K3a: what each faction knows on day one, then what it can see from there.
    this.explore = FACTION_IDS.map((_, f) => newExploration(this, f));
    for (let f = 0; f < FACTION_IDS.length; f++) updateSight(this, f);
    // K5: the opening hosts, after the start's ids so a bare world's ids are K4's.
    this.hosts = config.hosts === true;
    if (this.hosts) {
      for (const host of OPENING_HOSTS) {
        const at = this.byKey.get(host.at);
        const f = FACTION_IDS.indexOf(host.faction);
        if (at && f >= 0) raiseArmy(this, f, at.id, host.units, host.doctrine);
      }
    }
    // Day one's sightings and musters are the start, not news.
    this.events = [];
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

    // K5: while a contact of the king's side waits, the realm holds. The
    // orders due apply, in canonical order, until one settles the contact;
    // the rest wait for the next tick, which runs as normal. The clock does
    // not move, so the day the battle was fought is the day it was met, and
    // a replay of the log (which submits every order up front) holds and
    // resumes at exactly the same orders.
    if (this.contact) {
      const due = this.orders.drain(this.now);
      let i = 0;
      for (; i < due.length && this.contact; i++) {
        this.log.push(due[i]);
        this.applyOrder(due[i]);
      }
      for (; i < due.length; i++) this.orders.push(due[i], this.now);
      return this.events;
    }

    if (isDayStart(this.now)) {
      this.beginDay();
      // K3: the economy's day -- farm weather, seasons, plots, buildings,
      // taxes, foraging and rallying, bread, spoilage (economy.ts).
      runEconomyDay(this);
      // K4: the armies' day -- wages, bread, hunger and desertion, mending
      // and replacements -- after the party and the towns have eaten.
      runArmyDay(this);
      // K6: morale and unrest -- every town's unrest from today's taxes,
      // famine, foraging and quartering; revolts; the season's legitimacy;
      // every army's morale and the men low spirits cost (morale.ts). After
      // the armies' day, so today's wages and bread are what it reads.
      runMoraleDay(this);
      // K3a: the realm's sight as the day begins (towers built, holdings
      // claimed); the king's is also kept up as he marches, below.
      for (let f = 0; f < FACTION_IDS.length; f++) updateSight(this, f);
    }
    // K8: captains' AI issues orders here, through this.orders, before draining.
    for (const order of this.orders.drain(this.now)) {
      this.log.push(order);
      this.applyOrder(order);
    }
    // The king's retinue marches on its own only while he rides with no army.
    if (this.king.army === 0) this.marchKing();
    // K4: armies march (the same advanceMover), then meetings, in army-id order.
    const marching = new Set<number>();
    for (const a of this.armies) if (a.mover.route.length > 0 || a.target !== 0) marching.add(a.id);
    marchArmies(this);
    // K5: contact, in army-id order (descent.ts). One of the king's side holds the realm from the next tick.
    detectContacts(this, marching);
    // K7: contracts and wages.
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
    // While the king rides with an army, marching or halting the king is
    // marching or halting that army (docs/PROVISIONAL.md K4.1).
    if (order.kind === "resolveContact") {
      const why = applyContactOrder(this, order);
      if (why) this.reject(order, why);
      return;
    }
    if ((order.kind === "moveKing" || order.kind === "haltKing") && order.player === KING_PLAYER && this.king.army !== 0) {
      const body: ArmyOrderBody = order.kind === "moveKing"
        ? { kind: "marchArmy", army: this.king.army, to: order.to }
        : { kind: "haltArmy", army: this.king.army };
      const why = applyArmyOrder(this, { ...order, ...body });
      if (why) this.reject(order, why);
      return;
    }
    if (isArmyOrder(order)) {
      const why = applyArmyOrder(this, order as KingdomOrder & ArmyOrderBody);
      if (why) this.reject(order, why);
      return;
    }
    if (isMoraleOrder(order)) {
      const why = applyMoraleOrder(this, order as KingdomOrder & MoraleOrderBody);
      if (why) this.reject(order, why);
      return;
    }
    switch (order.kind) {
      case "moveKing": {
        if (order.player !== KING_PLAYER) return this.reject(order, "only the king's seat commands the king");
        // K3a: only somewhere the party knows of, by roads it knows.
        const unknown = targetRefusal(this, KING_PLAYER, order.to);
        if (unknown) return this.reject(order, unknown);
        const route = findRoute(this.graph, this.king.mover, order.to, routeOptions(this, KING_PLAYER));
        if (!route) return this.reject(order, EXPLORE_REFUSAL.noKnownRoad);
        setRoute(this.graph, this.king.mover, route);
        // A party on the march neither forages nor rallies.
        setTask(this, "none");
        return;
      }
      case "haltKing": {
        if (order.player !== KING_PLAYER) return this.reject(order, "only the king's seat commands the king");
        this.king.mover.route = [];
        setTask(this, "none");
        return;
      }
      case "resolveEvent": {
        const f = order.player;
        const before = f >= 0 && f < this.economy.length ? snapshotStocks(this.economy[f]).join() : "";
        const why = applyResolve(this, f, order.site, order.choice);
        if (why) return this.reject(order, why);
        if (snapshotStocks(this.economy[f]).join() !== before) this.events.push({ kind: "stocksChanged", faction: f });
        return;
      }
      default: {
        const f = order.player;
        const before = f >= 0 && f < this.economy.length ? snapshotStocks(this.economy[f]).join() : "";
        const why = applyEconomyOrder(this, order);
        if (why) return this.reject(order, why);
        if (snapshotStocks(this.economy[f]).join() !== before) this.events.push({ kind: "stocksChanged", faction: f });
        return;
      }
    }
  }

  /**
   * Why an economy order would be refused right now, or null if it would be
   * applied -- the SAME check the tick makes when the order lands. The panels
   * use it to offer only what will work and to say why the rest will not.
   * (A queued order is checked again when it applies, against the world then.)
   */
  check(body: KingdomOrderBody, player: number = KING_PLAYER): string | null {
    if (body.kind === "resolveEvent") return checkResolve(this, player, body.site, body.choice);
    if (body.kind === "resolveContact") return checkContactOrder(this, body, player);
    if (body.kind === "moveKing") {
      if (this.king.army !== 0) return checkArmyOrder(this, { kind: "marchArmy", army: this.king.army, to: body.to }, player);
      return targetRefusal(this, KING_PLAYER, body.to);
    }
    if (isArmyOrder(body)) return checkArmyOrder(this, body, player);
    if (isMoraleOrder(body)) return checkMoraleOrder(this, body, player);
    if (!isEconomyOrder(body)) return null;
    return checkEconomyOrder(this, body as EconomyOrderBody, player);
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
    const moving = m.route.length > 0;
    const reached = advanceMover(this.graph, m, this.retinueEffortPerTick(), WEATHER[this.weather].travel, marchOptions(this, KING_PLAYER));
    if (leaving !== 0) this.events.push({ kind: "kingDeparted", from: leaving, to: heading });
    for (let i = 0; i < reached.length; i++) {
      const last = i === reached.length - 1 && m.route.length === 0;
      this.events.push({ kind: "kingArrived", at: reached[i], destination: last });
    }
    // K3a: the party sees as it goes, and a site set foot in for the first
    // time is found (advanceMover already halted there). Standing still, the
    // view only changes at the day boundary, so it is not recomputed.
    if (moving) updateSight(this, KING_PLAYER);
    if (reached.length > 0) discover(this, KING_PLAYER, reached[reached.length - 1]);
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
    // Riding with an army, the king goes at the army's pace.
    const army = armyById(this, this.king.army);
    if (army) return planArmyRoute(this, army, to);
    if (targetRefusal(this, KING_PLAYER, to)) return null;
    const route = findRoute(this.graph, this.king.mover, to, routeOptions(this, KING_PLAYER));
    if (!route) return null;
    const etaTicks = ceil((route.effort * WEATHER[this.weather].travel) / this.retinueEffortPerTick());
    return { route, etaTicks };
  }

  /** Grain a faction must find today: its party and its towns' dole. */
  dailyNeed(faction: number = KING_PLAYER): number {
    return dailyNeed(this, faction);
  }

  /** The king's stores. */
  get kingStocks(): FactionEconomy {
    return this.economy[KING_PLAYER];
  }

  /** Holdings a faction owns, in id order. `null` lists the unclaimed ones. */
  holdingsOf(owner: (typeof FACTION_IDS)[number] | null): Holding[] {
    return this.holdings.filter((h) => h.owner === owner);
  }
}
