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
import { KINGDOM_ORDER_KINDS, type KingdomOrder } from "./orders.ts";
import { PLOT_STAGES, type Mover, type PlotStage } from "./state.ts";
import { roadBetween } from "./graph.ts";
import { KINGDOM_STREAMS, KingdomWorld } from "./world.ts";

export const KINGDOM_SAVE_FORMAT = "war.kingdom";
export const KINGDOM_SAVE_VERSION = 1;

export type SavedPlot = { id: number; crop: string | null; stage: PlotStage; progress: number };
export type SavedHolding = {
  id: number;
  key: string;
  owner: FactionId | null;
  population: number;
  garrison: number[];
  buildings: (string | null)[];
  plots: SavedPlot[];
};

export type KingdomSaveV1 = {
  format: typeof KINGDOM_SAVE_FORMAT;
  version: 1;
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
    king: { id: number; companions: string[]; mover: Mover };
  };
  log: KingdomOrder[];
};

/** The current save shape. */
export type KingdomSave = KingdomSaveV1;

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/**
 * Upgrades, one per version: MIGRATIONS[n] turns a version-n save into a
 * version-(n+1) save. Empty while there is only version 1. When K3 adds
 * stockpiles, bump KINGDOM_SAVE_VERSION to 2 and add MIGRATIONS[1] that fills
 * them with their starting values -- never edit an old save's meaning in place.
 */
export const MIGRATIONS: Readonly<Record<number, (save: Record<string, unknown>) => Record<string, unknown>>> = {};

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
  return {
    format: KINGDOM_SAVE_FORMAT,
    version: 1,
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
        plots: h.plots.map((p) => ({ id: p.id, crop: p.crop, stage: p.stage, progress: p.progress })),
      })),
      king: { id: world.king.id, companions: [...world.king.companions], mover: cloneMover(world.king.mover) },
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
  switch (kind) {
    case "moveKing": {
      // An order may name a holding that does not exist -- the sim rejects it
      // when applied, and must reject it identically after a load.
      return { kind, to: int(o.to, what + ".to"), tick, player, seq };
    }
    default:
      return { kind: "haltKing", tick, player, seq };
  }
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
  try {
    return { ok: true, value: build(migrated.value) };
  } catch (e) {
    if (e instanceof Bad) return fail(e.message);
    throw e;
  }
}

function build(save: Record<string, unknown>): KingdomWorld {
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
    const buildings = arr(h.buildings, what + ".buildings").map((b, j) => strOrNull(b, what + ".buildings[" + j + "]"));
    if (buildings.length !== live.buildings.length) throw new Bad(what + " has the wrong number of building slots");
    const plots = arr(h.plots, what + ".plots").map((p, j) => {
      const pw = what + ".plots[" + j + "]";
      const po = obj(p, pw);
      const stage = str(po.stage, pw + ".stage");
      if (!(PLOT_STAGES as readonly string[]).includes(stage)) throw new Bad(pw + " has unknown stage " + stage);
      return {
        id: int(po.id, pw + ".id"), crop: strOrNull(po.crop, pw + ".crop"),
        stage: stage as PlotStage, progress: num(po.progress, pw + ".progress"),
      };
    });
    if (plots.length !== live.plots.length || plots.some((p, j) => p.id !== live.plots[j].id)) {
      throw new Bad(what + "'s field plots do not match the map");
    }
    return { owner: owner as FactionId | null, population: num(h.population, what + ".population"), garrison, buildings, plots };
  });

  const k = obj(s.king, "snapshot.king");
  if (int(k.id, "snapshot.king.id") !== world.king.id) throw new Bad("snapshot.king.id does not match the map");
  const companions = arr(k.companions, "snapshot.king.companions").map((c, i) => str(c, "companion[" + i + "]"));
  const mover = readMover(k.mover, "snapshot.king.mover", world);

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
    live.plots = h.plots;
  });
  world.king.companions = companions;
  world.king.mover = mover;
  world.orders.restore(pending, seqs);
  world.log.push(...log);
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
