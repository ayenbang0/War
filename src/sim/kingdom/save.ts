/**
 * Kingdom save format: a versioned snapshot plus the order log (PLAN.md §B.10).
 *
 * Pure: plain objects in, plain objects out, no storage. The browser-side
 * wrapper that puts this in localStorage lives outside sim/ (src/app/
 * kingdom-save.ts), so the format can be round-tripped headless.
 *
 * What is saved is DYNAMIC state only, keyed by entity id, plus a fingerprint
 * of the static map it was played on. Loading rebuilds the map from content
 * (which always yields the same ids) and lays the saved state over it. A save
 * made on a different map -- a town moved, a road added -- is refused by the
 * fingerprint rather than loaded wrong; that is what `migrate` is for.
 *
 * The order log rides along so a save can be replayed from day one and
 * checked against its own snapshot (tools/kingdom-headless.ts does exactly
 * that), and so a desync can be bisected.
 *
 * Numbers survive JSON exactly: every finite double prints as the shortest
 * string that reads back to the same bits. Non-finite numbers never occur in
 * a healthy world and are refused on load.
 */

import { FNV_OFFSET, mixF64, mixU32 } from "../hash.ts";
import type { RngState } from "../rng.ts";
import { FACTIONS, type FactionId } from "../../content/kingdom/factions.ts";
import { KINGDOM_MAPS } from "../../content/kingdom/map.ts";
import { WEATHER_IDS, type WeatherId } from "../../content/kingdom/terrain.ts";
import { BUILDING_IDS, type BuildingId } from "../../content/kingdom/buildings.ts";
import { CROP_IDS, type CropId } from "../../content/kingdom/crops.ts";
import { FACTION_IDS } from "../../content/kingdom/factions.ts";
import {
  DEFAULT_TAX, KING_START, KING_START_LEGITIMACY, LEDGER_CATEGORY_IDS, LEDGER_STOCK_IDS, LEGITIMACY_MAX, STOCK_IDS,
  TAX_RATE_IDS, type StockId, type TaxRateId,
} from "../../content/kingdom/economy.ts";
import { KINGDOM_ORDER_KINDS, type KingdomOrder } from "./orders.ts";
import { KING_TASKS, PLOT_STAGES, type FactionExploration, type Find, type KingTask, type Mover, type PlotStage } from "./state.ts";
import { KNOW_KNOWN, KNOW_SEEN, KNOW_UNKNOWN, type Knowledge } from "../../content/kingdom/exploration.ts";
import { STORY_EVENTS } from "../../content/story/events.ts";
import { UPGRADE_IDS, type UpgradeId } from "../../content/story/upgrades.ts";
import { updateSight } from "./explore.ts";
import type { LedgerDay } from "./ledger.ts";
import { calendar } from "./clock.ts";
import { roadBetween } from "./graph.ts";
import { KINGDOM_STREAMS, KingdomWorld } from "./world.ts";

export const KINGDOM_SAVE_FORMAT = "war.kingdom";
export const KINGDOM_SAVE_VERSION = 3;

export type SavedPlot = { id: number; crop: string | null; stage: PlotStage; progress: number; days: number; health: number };
export type SavedHolding = {
  id: number;
  key: string;
  owner: FactionId | null;
  population: number;
  garrison: number[];
  buildings: (string | null)[];
  works: number[];
  idle: boolean[];
  plots: SavedPlot[];
  tax: TaxRateId;
  taxCarry: number;
  doleCarry: number;
  famine: number;
};
export type SavedEconomy = {
  faction: FactionId;
  stocks: Record<StockId, number>;
  legitimacy: number;
  hunger: number;
  defaultTax: TaxRateId;
  open: LedgerDay;
  closed: LedgerDay | null;
};

export type SavedExploration = {
  faction: FactionId;
  holdings: Knowledge[];
  roads: Knowledge[];
  finds: Find[];
  upgrades: UpgradeId[];
};

/**
 * Version 3 (K3a): the map twice the size (holdings 37-72 appended, so every
 * later id moved: see migrate2to3), three new ledger categories, and every
 * faction's exploration -- map knowledge, finds and special upgrades.
 *
 * (Version 2, K3: version 1 plus the economy -- every faction's stores and
 * ledger pages, and the new fields on holdings (works, idle, tax and its
 * remainders, famine), plots (days, health) and the king (task).)
 */
export type KingdomSaveV3 = {
  format: typeof KINGDOM_SAVE_FORMAT;
  version: 3;
  map: string;
  /** Fingerprint of the static map; see mapFingerprint. */
  mapFingerprint: string;
  seed: number;
  kingName: string;
  snapshot: {
    now: number;
    nextId: number;
    weather: WeatherId;
    rng: Record<string, RngState>;
    seqs: number[];
    pending: KingdomOrder[];
    holdings: SavedHolding[];
    king: { id: number; companions: string[]; mover: Mover; task: KingTask; taskDays: number };
    economy: SavedEconomy[];
    explore: SavedExploration[];
  };
  log: KingdomOrder[];
};

/** The current save shape. */
export type KingdomSave = KingdomSaveV3;

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/**
 * Ledger categories a version-2 page has: those before K3a's first. K3a
 * appended its categories, so an old page is the new one minus its tail.
 */
const V2_CATEGORIES = LEDGER_CATEGORY_IDS.indexOf("finds");

/** A ledger page with nothing on it yet, as a v1 save's economy begins (in the v2 layout). */
function blankPage(day: number, start: number[]): LedgerDay {
  return { day, start, flow: new Array<number>(LEDGER_STOCK_IDS.length * V2_CATEGORIES).fill(0) };
}

/**
 * Version 1 (K1/K2) -> 2 (K3): the realm had no economy, so it gets the one
 * a new exile starts with -- the king's few days of bread, nobody's coin --
 * as of the save's own day. Every holding is taxed at the default rate, no
 * building is under way, every plot is as K1 left it (empty, full health).
 * The order log is kept as it was: replaying it now runs K3's economy from
 * day one, which is the honest meaning of an old log under new rules.
 */
function migrate1to2(save: Record<string, unknown>): Record<string, unknown> {
  const snap = { ...(save.snapshot as Record<string, unknown>) };
  const now = typeof snap.now === "number" ? snap.now : 0;
  const day = calendar(now).day;
  const holdings = Array.isArray(snap.holdings) ? snap.holdings : [];
  snap.holdings = holdings.map((v) => {
    const h = { ...(v as Record<string, unknown>) };
    const slots = Array.isArray(h.buildings) ? h.buildings.length : 0;
    h.works = new Array<number>(slots).fill(0);
    h.idle = new Array<boolean>(slots).fill(false);
    h.tax = DEFAULT_TAX;
    h.taxCarry = 0;
    h.doleCarry = 0;
    h.famine = 0;
    h.plots = (Array.isArray(h.plots) ? h.plots : []).map((p) => ({ ...(p as Record<string, unknown>), days: 0, health: 100 }));
    return h;
  });
  snap.king = { ...(snap.king as Record<string, unknown>), task: "none", taskDays: 0 };
  snap.economy = FACTION_IDS.map((f) => {
    const king = f === "king";
    const stocks: Record<string, number> = {};
    for (const st of STOCK_IDS) stocks[st] = king ? KING_START[st] : 0;
    const legitimacy = king ? KING_START_LEGITIMACY : 0;
    return {
      faction: f, stocks, legitimacy, hunger: 0, defaultTax: DEFAULT_TAX,
      open: blankPage(day, [...STOCK_IDS.map((st) => stocks[st]), legitimacy]), closed: null,
    };
  });
  return { ...save, version: 2, snapshot: snap };
}

/**
 * The K1-K3 campaign map, frozen: its fingerprint and size. A v2 save of the
 * campaign was made on exactly this; K3a appended 36 holdings and 63 roads to
 * it, which moved every id after the holdings (docs/PROVISIONAL.md K3a.1).
 */
export const K3_MAP = { id: "rimaros", fingerprint: "94dd4aa0", holdings: 36, roads: 52 } as const;

/**
 * Version 2 (K3) -> 3 (K3a).
 *
 *  - The map doubled. Holding ids 1-36 are unchanged (the new holdings were
 *    appended), but roads, plots and the king come after them in the id
 *    sequence and all moved. Every id in the save is mapped piecewise: old
 *    roads, old plots, the king and anything after keep their order and gain
 *    the size of what was inserted before them. The new holdings are added
 *    as a new world has them. Only a save of the frozen K3 map is remapped;
 *    one on any other map keeps its ids, and the fingerprint check in build()
 *    refuses it if the map changed under it.
 *  - Ledger pages gain K3a's three categories (finds, boons, offerings), all
 *    zero: a page's flow is re-laid from the old stride to the new.
 *  - Exploration: a K3 player had the whole old map in front of them, so the
 *    king keeps knowing all of it (every old holding and road known), on top
 *    of a new game's knowledge; the new country is unexplored. The captains
 *    know everything, as in a new game. No finds, no upgrades. What is in
 *    sight is worked out on load.
 *
 * The order log is remapped with the same ids and kept: replayed, it runs
 * K3a's rules (the fog included) from day one -- as v1 -> v2 did, the honest
 * meaning of an old log under new rules.
 */
function migrate2to3(save: Record<string, unknown>): Record<string, unknown> {
  const snap = { ...(save.snapshot as Record<string, unknown>) };
  const map = KINGDOM_MAPS[typeof save.map === "string" ? save.map : ""];
  const campaign = save.map === K3_MAP.id && save.mapFingerprint === K3_MAP.fingerprint && map !== undefined;
  const fresh = map ? new KingdomWorld({ seed: typeof save.seed === "number" ? save.seed | 0 : 0, map }) : null;
  let remap = (id: number): number => id;
  if (campaign && fresh) {
    const H0 = K3_MAP.holdings;
    const R0 = K3_MAP.roads;
    const plotsBefore = fresh.holdings.slice(0, H0).reduce((n, h) => n + h.plots.length, 0);
    const oldPlot0 = H0 + R0 + 1;
    const oldKing = oldPlot0 + plotsBefore;
    const roadShift = fresh.roads[0].id - (H0 + 1);
    const plotShift = fresh.holdings[0].plots[0].id - oldPlot0;
    const kingShift = fresh.king.id - oldKing;
    remap = (id) => (id <= H0 ? id : id <= H0 + R0 ? id + roadShift : id < oldKing ? id + plotShift : id + kingShift);
  }
  const holdings = (Array.isArray(snap.holdings) ? snap.holdings : []).map((v) => {
    const h = { ...(v as Record<string, unknown>) };
    h.plots = (Array.isArray(h.plots) ? h.plots : []).map((p) => {
      const po = { ...(p as Record<string, unknown>) };
      if (typeof po.id === "number") po.id = remap(po.id);
      return po;
    });
    return h;
  });
  if (campaign && fresh) holdings.push(...serialize(fresh).snapshot.holdings.slice(K3_MAP.holdings));
  snap.holdings = holdings;
  if (typeof snap.nextId === "number") snap.nextId = remap(snap.nextId - 1) + 1;
  const king = { ...(snap.king as Record<string, unknown>) };
  if (typeof king.id === "number") king.id = remap(king.id);
  const mover = { ...(king.mover as Record<string, unknown>) };
  if (typeof mover.road === "number" && mover.road !== 0) mover.road = remap(mover.road);
  king.mover = mover;
  snap.king = king;
  const order = (v: unknown): unknown => {
    const o = { ...(v as Record<string, unknown>) };
    for (const k of ["to", "holding", "plot"]) if (typeof o[k] === "number") o[k] = remap(o[k] as number);
    return o;
  };
  snap.pending = (Array.isArray(snap.pending) ? snap.pending : []).map(order);
  const relay = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    const d = { ...(v as Record<string, unknown>) };
    const flow = Array.isArray(d.flow) ? d.flow : [];
    const out = new Array<unknown>(LEDGER_STOCK_IDS.length * LEDGER_CATEGORY_IDS.length).fill(0);
    // A page of the wrong shape is left wrong, for readPage to refuse.
    if (flow.length !== LEDGER_STOCK_IDS.length * V2_CATEGORIES) return d;
    for (let st = 0; st < LEDGER_STOCK_IDS.length; st++) {
      for (let c = 0; c < V2_CATEGORIES; c++) out[st * LEDGER_CATEGORY_IDS.length + c] = flow[st * V2_CATEGORIES + c];
    }
    d.flow = out;
    return d;
  };
  snap.economy = (Array.isArray(snap.economy) ? snap.economy : []).map((v) => {
    const e = { ...(v as Record<string, unknown>) };
    e.open = relay(e.open);
    e.closed = relay(e.closed);
    return e;
  });
  snap.explore = fresh
    ? fresh.explore.map((ex, f) => {
      const old = (i: number, n: number): boolean => campaign && i < n;
      // Seen is recomputed on load; the snapshot stores what is remembered.
      const known = (k: Knowledge): Knowledge => (k === KNOW_SEEN ? KNOW_KNOWN : k);
      return {
        faction: FACTION_IDS[f],
        holdings: ex.holdings.map((k, i) => (old(i, K3_MAP.holdings) ? KNOW_KNOWN : known(k))),
        roads: ex.roads.map((k, i) => (old(i, K3_MAP.roads) ? KNOW_KNOWN : known(k))),
        finds: [],
        upgrades: [],
      };
    })
    : [];
  return {
    ...save, version: 3, snapshot: snap,
    mapFingerprint: campaign && fresh ? mapFingerprint(fresh) : save.mapFingerprint,
    log: (Array.isArray(save.log) ? save.log : []).map(order),
  };
}

/**
 * Upgrades, one per version: MIGRATIONS[n] turns a version-n save into a
 * version-(n+1) save. Never edit an old save's meaning in place: add a step.
 */
export const MIGRATIONS: Readonly<Record<number, (save: Record<string, unknown>) => Record<string, unknown>>> = {
  1: migrate1to2,
  2: migrate2to3,
};

/**
 * Bring a parsed save up to `current`, one step at a time.
 *
 * The table and target are parameters so the stepping itself can be tested
 * before any real migration exists.
 */
export function migrate(
  raw: unknown,
  table: Readonly<Record<number, (save: Record<string, unknown>) => Record<string, unknown>>> = MIGRATIONS,
  current: number = KINGDOM_SAVE_VERSION,
): Result<Record<string, unknown>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("not a save: expected an object");
  let save = raw as Record<string, unknown>;
  if (save.format !== KINGDOM_SAVE_FORMAT) return fail("not a kingdom save (format " + String(save.format) + ")");
  if (typeof save.version !== "number" || !Number.isInteger(save.version) || save.version < 1) {
    return fail("save has no valid version");
  }
  if (save.version > current) {
    return fail("save is version " + save.version + ", newer than this game (" + current + ")");
  }
  while ((save.version as number) < current) {
    const step = table[save.version as number];
    if (!step) return fail("no migration from save version " + save.version);
    const from = save.version as number;
    save = step(save);
    if (save.version !== from + 1) return fail("migration from version " + from + " did not advance the version");
  }
  return { ok: true, value: save };
}

/**
 * Fingerprint of the static map a world was built on: holdings, roads and
 * plot ids. A save records it; a load built on different content refuses.
 */
export function mapFingerprint(world: KingdomWorld): string {
  let h = FNV_OFFSET | 0;
  for (const x of world.holdings) {
    h = mixU32(h, x.id);
    for (let i = 0; i < x.key.length; i++) h = mixU32(h, x.key.charCodeAt(i));
    h = mixF64(h, x.x);
    h = mixF64(h, x.y);
    h = mixU32(h, x.seed);
    h = mixU32(h, x.garrisonSlots);
    h = mixU32(h, x.buildings.length);
    for (const p of x.plots) h = mixU32(h, p.id);
  }
  for (const r of world.roads) {
    h = mixU32(h, r.id);
    h = mixU32(h, r.a);
    h = mixU32(h, r.b);
    h = mixF64(h, r.cost);
  }
  h = mixU32(h, world.king.id);
  return (h >>> 0).toString(16).padStart(8, "0");
}

function cloneMover(m: Mover): Mover {
  return { node: m.node, road: m.road, from: m.from, to: m.to, along: m.along, route: [...m.route] };
}

/** Snapshot a world. The result is plain data; JSON.stringify it to store. */
export function serialize(world: KingdomWorld): KingdomSave {
  const rng: Record<string, RngState> = {};
  for (const name of KINGDOM_STREAMS) rng[name] = world.rng[name].snapshot();
  const page = (d: LedgerDay | null): LedgerDay | null => (d === null ? null : { day: d.day, start: [...d.start], flow: [...d.flow] });
  return {
    format: KINGDOM_SAVE_FORMAT,
    version: 3,
    map: world.map.id,
    mapFingerprint: mapFingerprint(world),
    seed: world.seed,
    kingName: world.king.name,
    snapshot: {
      now: world.now,
      nextId: world.nextId,
      weather: world.weather,
      rng,
      seqs: world.orders.sequences(),
      pending: world.orders.queued().map((o) => ({ ...o })),
      holdings: world.holdings.map((h) => ({
        id: h.id,
        key: h.key,
        owner: h.owner,
        population: h.population,
        garrison: [...h.garrison],
        buildings: [...h.buildings],
        works: [...h.works],
        idle: [...h.idle],
        plots: h.plots.map((p) => ({ id: p.id, crop: p.crop, stage: p.stage, progress: p.progress, days: p.days, health: p.health })),
        tax: h.tax,
        taxCarry: h.taxCarry,
        doleCarry: h.doleCarry,
        famine: h.famine,
      })),
      king: {
        id: world.king.id, companions: [...world.king.companions], mover: cloneMover(world.king.mover),
        task: world.king.task, taskDays: world.king.taskDays,
      },
      economy: world.economy.map((e, f) => ({
        faction: FACTION_IDS[f],
        stocks: { ...e.stocks },
        legitimacy: e.legitimacy,
        hunger: e.hunger,
        defaultTax: e.defaultTax,
        open: page(world.books[f].open) as LedgerDay,
        closed: page(world.books[f].closed),
      })),
      explore: world.explore.map((ex, f) => ({
        faction: FACTION_IDS[f],
        holdings: [...ex.holdings],
        roads: [...ex.roads],
        finds: ex.finds.map((x) => ({ ...x })),
        upgrades: [...ex.upgrades],
      })),
    },
    log: world.log.map((o) => ({ ...o })),
  };
}

// -- reading back: every field checked, nothing trusted ------------------------

class Bad extends Error {}

function fail<T>(error: string): Result<T> {
  return { ok: false, error };
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Bad(what + " is not an object");
  return v as Record<string, unknown>;
}
function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Bad(what + " is not a list");
  return v;
}
function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Bad(what + " is not a finite number");
  return v;
}
function int(v: unknown, what: string, lo = 0): number {
  const n = num(v, what);
  if (!Number.isInteger(n) || n < lo) throw new Bad(what + " is not a whole number >= " + lo);
  return n;
}
function u32(v: unknown, what: string): number {
  const n = num(v, what);
  if (!Number.isInteger(n) || n < -2147483648 || n > 4294967295) throw new Bad(what + " is not a 32-bit integer");
  return n;
}
function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Bad(what + " is not text");
  return v;
}
function strOrNull(v: unknown, what: string): string | null {
  return v === null ? null : str(v, what);
}

function readOrder(v: unknown, what: string): KingdomOrder {
  const o = obj(v, what);
  const kind = str(o.kind, what + ".kind");
  if (!(KINGDOM_ORDER_KINDS as readonly string[]).includes(kind)) throw new Bad(what + " has unknown kind " + kind);
  const tick = int(o.tick, what + ".tick");
  const player = int(o.player, what + ".player");
  const seq = int(o.seq, what + ".seq", 1);
  // An order may name a holding or plot that does not exist -- the sim
  // rejects it when applied, and must reject it identically after a load.
  // An id from a content TABLE (rate, building, crop) must be known, though:
  // its hash code is its index there.
  switch (kind) {
    case "moveKing":
      return { kind, to: int(o.to, what + ".to"), tick, player, seq };
    case "haltKing":
    case "forage":
    case "rally":
      return { kind, tick, player, seq };
    case "claimHolding":
      return { kind, holding: int(o.holding, what + ".holding"), tick, player, seq };
    case "setTax":
      return { kind, holding: int(o.holding, what + ".holding"), rate: oneOf(o.rate, TAX_RATE_IDS, what + ".rate"), tick, player, seq };
    case "build":
      return {
        kind, holding: int(o.holding, what + ".holding"), building: oneOf(o.building, BUILDING_IDS, what + ".building"),
        tick, player, seq,
      };
    case "sow":
      return { kind, plot: int(o.plot, what + ".plot"), crop: oneOf(o.crop, CROP_IDS, what + ".crop"), tick, player, seq };
    case "resolveEvent":
      return { kind, site: int(o.site, what + ".site"), choice: int(o.choice, what + ".choice"), tick, player, seq };
    default:
      return { kind: "harvest", plot: int(o.plot, what + ".plot"), tick, player, seq };
  }
}

function oneOf<T extends string>(v: unknown, ids: readonly T[], what: string): T {
  const s = str(v, what);
  if (!(ids as readonly string[]).includes(s)) throw new Bad(what + " is unknown: " + s);
  return s as T;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") throw new Bad(what + " is not true or false");
  return v;
}

function readPage(v: unknown, what: string): LedgerDay {
  const o = obj(v, what);
  const start = arr(o.start, what + ".start").map((n, i) => int(n, what + ".start[" + i + "]"));
  const flow = arr(o.flow, what + ".flow").map((n, i) => int(n, what + ".flow[" + i + "]"));
  if (start.length !== LEDGER_STOCK_IDS.length) throw new Bad(what + ".start has the wrong number of stocks");
  if (flow.length !== LEDGER_STOCK_IDS.length * LEDGER_CATEGORY_IDS.length) throw new Bad(what + ".flow has the wrong shape");
  return { day: int(o.day, what + ".day"), start, flow };
}

function readMover(v: unknown, what: string, world: KingdomWorld): Mover {
  const m = obj(v, what);
  const mover: Mover = {
    node: int(m.node, what + ".node"),
    road: int(m.road, what + ".road"),
    from: int(m.from, what + ".from"),
    to: int(m.to, what + ".to"),
    along: num(m.along, what + ".along"),
    route: arr(m.route, what + ".route").map((n, i) => int(n, what + ".route[" + i + "]")),
  };
  const g = world.graph;
  if ((mover.node === 0) === (mover.road === 0)) throw new Bad(what + " must be at a holding or on a road, not both or neither");
  if (mover.node !== 0) {
    if (!g.holdings.has(mover.node)) throw new Bad(what + " stands at unknown holding " + mover.node);
    if (mover.from !== 0 || mover.to !== 0 || mover.along !== 0) throw new Bad(what + " at a holding has road progress");
  } else {
    const r = g.roads.get(mover.road);
    if (!r) throw new Bad(what + " is on unknown road " + mover.road);
    const ends = (mover.from === r.a && mover.to === r.b) || (mover.from === r.b && mover.to === r.a);
    if (!ends) throw new Bad(what + " travels road " + r.id + " between holdings it does not join");
    if (!(mover.along >= 0 && mover.along <= r.length)) throw new Bad(what + " is off the end of its road");
    if (mover.route.length > 0 && mover.route[0] !== mover.to) throw new Bad(what + "'s route does not continue its road");
  }
  // Every step of the route must be a real road, or advanceMover would stop
  // dead mid-march on a load that "succeeded".
  let at = mover.node !== 0 ? mover.node : mover.to;
  for (let i = mover.node !== 0 ? 0 : 1; i < mover.route.length; i++) {
    const n = mover.route[i];
    if (!roadBetween(g, at, n)) throw new Bad(what + "'s route has no road from " + at + " to " + n);
    at = n;
  }
  return mover;
}

/**
 * Rebuild a world from a save, or say why not.
 *
 * Accepts anything (typically straight out of JSON.parse) and checks every
 * field, so a hand-edited or truncated save fails here with a reason instead
 * of producing a world that misbehaves later.
 */
export function deserialize(raw: unknown): Result<KingdomWorld> {
  const migrated = migrate(raw);
  if (!migrated.ok) return migrated;
  // A save from before the fog (v1, v2) stores no sight; work it out once.
  const resight = (raw as Record<string, unknown>).version !== KINGDOM_SAVE_VERSION;
  try {
    return { ok: true, value: build(migrated.value, resight) };
  } catch (e) {
    if (e instanceof Bad) return fail(e.message);
    throw e;
  }
}

function readKnowledge(v: unknown, what: string): Knowledge {
  const n = int(v, what);
  if (n !== KNOW_UNKNOWN && n !== KNOW_KNOWN && n !== KNOW_SEEN) throw new Bad(what + " is not unknown, known or seen");
  return n as Knowledge;
}

function readExploration(v: unknown, what: string, world: KingdomWorld, faction: number): FactionExploration {
  const o = obj(v, what);
  if (str(o.faction, what + ".faction") !== FACTION_IDS[faction]) throw new Bad(what + " is not " + FACTION_IDS[faction] + "'s");
  const holdings = arr(o.holdings, what + ".holdings").map((k, i) => readKnowledge(k, what + ".holdings[" + i + "]"));
  const roads = arr(o.roads, what + ".roads").map((k, i) => readKnowledge(k, what + ".roads[" + i + "]"));
  if (holdings.length !== world.holdings.length) throw new Bad(what + ".holdings does not match the map");
  if (roads.length !== world.roads.length) throw new Bad(what + ".roads does not match the map");
  const sites = new Set<number>();
  const drawn = new Set<number>();
  const finds = arr(o.finds, what + ".finds").map((f, i) => {
    const fw = what + ".finds[" + i + "]";
    const fo = obj(f, fw);
    const site = int(fo.site, fw + ".site", 1);
    const def = world.map.holdings[site - world.holdings[0].id];
    if (!world.holding(site) || def?.site === undefined) throw new Bad(fw + " is not at an exploration site");
    if (sites.has(site)) throw new Bad(fw + " finds a site twice");
    sites.add(site);
    const event = int(fo.event, fw + ".event", -1);
    if (event >= STORY_EVENTS.length) throw new Bad(fw + " names an unknown event");
    if (event >= 0 && drawn.has(event)) throw new Bad(fw + " draws an event twice");
    drawn.add(event);
    const choice = int(fo.choice, fw + ".choice", -1);
    const choices = event >= 0 ? STORY_EVENTS[event].choices.length : 0;
    if (choice >= choices && !(event < 0 && choice === -1)) throw new Bad(fw + " names a choice its event does not have");
    const failed = bool(fo.failed, fw + ".failed");
    if (failed && (choice < 0 || !STORY_EVENTS[event].choices[choice].chance)) throw new Bad(fw + " failed a gamble it did not take");
    if (holdings[site - world.holdings[0].id] === KNOW_UNKNOWN) throw new Bad(fw + " is at a place the faction does not know");
    return { site, event, day: int(fo.day, fw + ".day"), choice, failed };
  });
  const upgrades = arr(o.upgrades, what + ".upgrades").map((u, i) => oneOf(u, UPGRADE_IDS, what + ".upgrades[" + i + "]"));
  if (new Set(upgrades).size !== upgrades.length) throw new Bad(what + " holds an upgrade twice");
  return { holdings, roads, finds, upgrades };
}

function build(save: Record<string, unknown>, resight = false): KingdomWorld {
  const mapId = str(save.map, "map");
  const map = KINGDOM_MAPS[mapId];
  if (!map) throw new Bad("unknown map " + mapId);
  const world = new KingdomWorld({
    seed: u32(save.seed, "seed"),
    map,
    kingName: str(save.kingName, "kingName"),
  });
  if (str(save.mapFingerprint, "mapFingerprint") !== mapFingerprint(world)) {
    throw new Bad("save was made on a different version of the map " + mapId);
  }

  const s = obj(save.snapshot, "snapshot");
  const now = int(s.now, "snapshot.now");
  const nextId = int(s.nextId, "snapshot.nextId", 1);
  if (nextId < world.nextId) throw new Bad("snapshot.nextId is behind the map's own ids");
  const weather = str(s.weather, "snapshot.weather");
  if (!(WEATHER_IDS as readonly string[]).includes(weather)) throw new Bad("unknown weather " + weather);

  const rng = obj(s.rng, "snapshot.rng");
  const states: RngState[] = KINGDOM_STREAMS.map((name) => {
    const st = obj(rng[name], "snapshot.rng." + name);
    return {
      a: u32(st.a, name + ".a") | 0, b: u32(st.b, name + ".b") | 0,
      c: u32(st.c, name + ".c") | 0, d: u32(st.d, name + ".d") | 0,
    };
  });

  const holdings = arr(s.holdings, "snapshot.holdings");
  if (holdings.length !== world.holdings.length) throw new Bad("snapshot has the wrong number of holdings");
  const saved = holdings.map((v, i) => {
    const what = "holding[" + i + "]";
    const h = obj(v, what);
    const live = world.holdings[i];
    if (int(h.id, what + ".id") !== live.id || str(h.key, what + ".key") !== live.key) {
      throw new Bad(what + " does not match the map (" + live.key + ")");
    }
    const owner = h.owner === null ? null : str(h.owner, what + ".owner");
    if (owner !== null && !(owner in FACTIONS)) throw new Bad(what + " has unknown owner " + owner);
    const garrison = arr(h.garrison, what + ".garrison").map((g, j) => int(g, what + ".garrison[" + j + "]", 1));
    if (garrison.length > live.garrisonSlots) throw new Bad(what + " has more garrison than slots");
    const buildings = arr(h.buildings, what + ".buildings").map((b, j) => {
      const id = strOrNull(b, what + ".buildings[" + j + "]");
      if (id !== null && !(BUILDING_IDS as readonly string[]).includes(id)) throw new Bad(what + " has unknown building " + id);
      return id as BuildingId | null;
    });
    if (buildings.length !== live.buildings.length) throw new Bad(what + " has the wrong number of building slots");
    const works = arr(h.works, what + ".works").map((n, j) => int(n, what + ".works[" + j + "]"));
    const idle = arr(h.idle, what + ".idle").map((b, j) => bool(b, what + ".idle[" + j + "]"));
    if (works.length !== buildings.length || idle.length !== buildings.length) throw new Bad(what + "'s slot records do not match its slots");
    if (works.some((w, j) => w > 0 && buildings[j] === null)) throw new Bad(what + " has work under way in an empty slot");
    const plots = arr(h.plots, what + ".plots").map((p, j) => {
      const pw = what + ".plots[" + j + "]";
      const po = obj(p, pw);
      const stage = str(po.stage, pw + ".stage");
      if (!(PLOT_STAGES as readonly string[]).includes(stage)) throw new Bad(pw + " has unknown stage " + stage);
      const crop = strOrNull(po.crop, pw + ".crop");
      if (crop !== null && !(CROP_IDS as readonly string[]).includes(crop)) throw new Bad(pw + " has unknown crop " + crop);
      if (stage !== "empty" && crop === null) throw new Bad(pw + " is " + stage + " with no crop");
      const health = int(po.health, pw + ".health");
      if (health > 100) throw new Bad(pw + ".health is over 100");
      const progress = num(po.progress, pw + ".progress");
      if (!(progress >= 0 && progress <= 1)) throw new Bad(pw + ".progress is outside 0..1");
      return {
        id: int(po.id, pw + ".id"), crop: crop as CropId | null,
        stage: stage as PlotStage, progress, days: int(po.days, pw + ".days"), health,
      };
    });
    if (plots.length !== live.plots.length || plots.some((p, j) => p.id !== live.plots[j].id)) {
      throw new Bad(what + "'s field plots do not match the map");
    }
    return {
      owner: owner as FactionId | null, population: int(h.population, what + ".population"), garrison, buildings, works, idle, plots,
      tax: oneOf(h.tax, TAX_RATE_IDS, what + ".tax"),
      taxCarry: int(h.taxCarry, what + ".taxCarry"), doleCarry: int(h.doleCarry, what + ".doleCarry"),
      famine: int(h.famine, what + ".famine"),
    };
  });

  const k = obj(s.king, "snapshot.king");
  if (int(k.id, "snapshot.king.id") !== world.king.id) throw new Bad("snapshot.king.id does not match the map");
  const companions = arr(k.companions, "snapshot.king.companions").map((c, i) => str(c, "companion[" + i + "]"));
  const mover = readMover(k.mover, "snapshot.king.mover", world);
  const task = oneOf(k.task, KING_TASKS, "snapshot.king.task");
  const taskDays = int(k.taskDays, "snapshot.king.taskDays");

  const eco = arr(s.economy, "snapshot.economy");
  if (eco.length !== FACTION_IDS.length) throw new Bad("snapshot.economy has the wrong number of factions");
  const economy = eco.map((v, i) => {
    const what = "economy[" + i + "]";
    const o = obj(v, what);
    if (str(o.faction, what + ".faction") !== FACTION_IDS[i]) throw new Bad(what + " is not " + FACTION_IDS[i] + "'s");
    const so = obj(o.stocks, what + ".stocks");
    const stocks = {} as Record<StockId, number>;
    for (const st of STOCK_IDS) stocks[st] = int(so[st], what + ".stocks." + st);
    const legitimacy = int(o.legitimacy, what + ".legitimacy");
    if (legitimacy > LEGITIMACY_MAX) throw new Bad(what + ".legitimacy is over " + LEGITIMACY_MAX);
    return {
      stocks, legitimacy, hunger: int(o.hunger, what + ".hunger"),
      defaultTax: oneOf(o.defaultTax, TAX_RATE_IDS, what + ".defaultTax"),
      open: readPage(o.open, what + ".open"),
      closed: o.closed === null ? null : readPage(o.closed, what + ".closed"),
    };
  });

  const ex = arr(s.explore, "snapshot.explore");
  if (ex.length !== FACTION_IDS.length) throw new Bad("snapshot.explore has the wrong number of factions");
  const explore = ex.map((v, i) => readExploration(v, "explore[" + i + "]", world, i));

  const seqs = arr(s.seqs, "snapshot.seqs").map((n, i) => int(n, "snapshot.seqs[" + i + "]"));
  const pending = arr(s.pending, "snapshot.pending").map((o, i) => readOrder(o, "pending[" + i + "]"));
  for (const o of pending) {
    if (o.tick < now) throw new Bad("a queued order is due before the snapshot's own tick");
  }
  const log = arr(save.log, "log").map((o, i) => readOrder(o, "log[" + i + "]"));

  // Everything checked; only now touch the world, so a refusal never leaves
  // a half-loaded one behind.
  world.now = now;
  world.nextId = nextId;
  world.weather = weather as WeatherId;
  KINGDOM_STREAMS.forEach((name, i) => world.rng[name].restore(states[i]));
  saved.forEach((h, i) => {
    const live = world.holdings[i];
    live.owner = h.owner;
    live.population = h.population;
    live.garrison = h.garrison;
    live.buildings = h.buildings;
    live.works = h.works;
    live.idle = h.idle;
    live.plots = h.plots;
    live.tax = h.tax;
    live.taxCarry = h.taxCarry;
    live.doleCarry = h.doleCarry;
    live.famine = h.famine;
  });
  world.king.companions = companions;
  world.king.mover = mover;
  world.king.task = task;
  world.king.taskDays = taskDays;
  economy.forEach((e, i) => {
    const live = world.economy[i];
    for (const st of STOCK_IDS) live.stocks[st] = e.stocks[st];
    live.legitimacy = e.legitimacy;
    live.hunger = e.hunger;
    live.defaultTax = e.defaultTax;
    world.books[i].open = e.open;
    world.books[i].closed = e.closed;
  });
  explore.forEach((e, i) => {
    const live = world.explore[i];
    live.holdings.splice(0, live.holdings.length, ...e.holdings);
    live.roads.splice(0, live.roads.length, ...e.roads);
    live.finds.splice(0, live.finds.length, ...e.finds);
    live.upgrades.splice(0, live.upgrades.length, ...e.upgrades);
  });
  world.orders.restore(pending, seqs);
  world.log.push(...log);
  if (resight) {
    for (let f = 0; f < FACTION_IDS.length; f++) updateSight(world, f);
    world.events = [];
  }
  return world;
}

/** serialize + JSON, for storage and export. */
export function saveToJson(world: KingdomWorld): string {
  return JSON.stringify(serialize(world));
}

/** JSON + deserialize. Never throws on bad input; says why instead. */
export function loadFromJson(text: string): Result<KingdomWorld> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("save is not valid JSON");
  }
  return deserialize(raw);
}

/**
 * Replay an order log into a fresh world, up to (not including) tick `until`.
 *
 * The log alone, from the seed, must reproduce the snapshot it was saved with;
 * the headless suite holds every save to that.
 */
export function replayLog(
  seed: number, log: readonly KingdomOrder[], until: number,
  config: { map?: KingdomWorld["map"]; kingName?: string } = {},
): KingdomWorld {
  const w = new KingdomWorld({ seed, ...config });
  for (const o of log) w.submit(o);
  while (w.now < until) w.tick();
  return w;
}
