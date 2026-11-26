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
import { CROPS, CROP_IDS, type CropId } from "../../content/kingdom/crops.ts";
import { FACTION_IDS } from "../../content/kingdom/factions.ts";
import {
  DEFAULT_TAX, KING_START, KING_START_LEGITIMACY, LEDGER_CATEGORY_IDS, LEDGER_STOCK_IDS, LEGITIMACY_MAX, STOCK_IDS,
  TAX_RATE_IDS, type StockId, type TaxRateId,
} from "../../content/kingdom/economy.ts";
import { CONTACT_CHOICES, KINGDOM_ORDER_KINDS, type KingdomOrder } from "./orders.ts";
import type { BattleResult, ResultSquad } from "../layers.ts";
import {
  AI_GOALS, ARMY_POSTURES, CONTACT_KINDS, KING_TASKS, PLOT_STAGES, type AiMind, type Army, type ArmyPosture, type Burned,
  type Contact, type FactionExploration, type FactionIntel, type Company, type Find, type KingTask, type Levied, type Mover,
  PLOT_CAUSES, type PlotCause, type PlotStage, type Rumour,
} from "./state.ts";
import { INVASION_WAVES } from "../../content/kingdom/invasions.ts";
import { FORTIFICATIONS } from "../../content/kingdom/descent.ts";
import { COMPANY_STATES, LOYALTY, MERCENARIES, type CompanyState } from "../../content/kingdom/mercenaries.ts";
import { UNIT_TYPES, UNIT_TYPE_IDS, type UnitTypeId } from "../../content/unit-types.ts";
import { DOCTRINE_IDS, type DoctrineId } from "../../content/doctrines.ts";
import { ABILITY_IDS, type AbilityId } from "../../content/abilities.ts";
import { MAX_OF_ONE_ABILITY } from "../../content/army.ts";
import { MAX_ARMIES_PER_SIDE } from "../../content/kingdom/armies.ts";
import { KNOW_KNOWN, KNOW_SEEN, KNOW_UNKNOWN, type Knowledge } from "../../content/kingdom/exploration.ts";
import { STORY_EVENTS } from "../../content/story/events.ts";
import { UPGRADE_IDS, type UpgradeId } from "../../content/story/upgrades.ts";
import { updateSight } from "./explore.ts";
import {
  DEFAULT_JUSTICE, JUSTICE_IDS, MERCY_MAX, MERCY_MIN, MERCY_START, UNREST_MAX, type JusticeId,
} from "../../content/kingdom/morale.ts";
import type { LedgerDay } from "./ledger.ts";
import { floor, min } from "../math.ts";
import { DAYS_PER_SEASON, OLD_DAYS_PER_SEASON, TICKS_PER_DAY, calendar, epochForOldDay } from "./clock.ts";
import { roadBetween } from "./graph.ts";
import { KINGDOM_STREAMS, KingdomWorld } from "./world.ts";

export const KINGDOM_SAVE_FORMAT = "war.kingdom";
export const KINGDOM_SAVE_VERSION = 9;

export type SavedPlot = {
  id: number; crop: string | null; stage: PlotStage; progress: number; days: number; health: number;
  /** ECON (v9): the crop it resows by itself, and why it was last lost. */
  auto: string | null; lost: PlotCause | null;
};
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
  foraged: number;
  unrest: number;
  justice: JusticeId;
  festival: number;
  pardoned: number;
};
export type SavedSquad = { id: number; unit: UnitTypeId; men: number; wounded: number; levy: boolean };
export type SavedArmy = {
  id: number;
  owner: FactionId;
  /** K7: 1 + the index in MERCENARIES of the free company it is, or 0. */
  company: number;
  name: string;
  doctrine: DoctrineId;
  squads: SavedSquad[];
  abilities: AbilityId[];
  mover: Mover;
  supply: number;
  morale: number;
  captain: string;
  hunger: number;
  unpaid: number;
  arrears: number;
  posture: ArmyPosture;
  postureDays: number;
  patrol: number[];
  patrolIndex: number;
  target: number;
  mergeInto: boolean;
  desertCarry: number;
  dieCarry: number;
  sickCarry: number;
};
export type SavedEconomy = {
  faction: FactionId;
  stocks: Record<StockId, number>;
  legitimacy: number;
  hunger: number;
  defaultTax: TaxRateId;
  mercy: number;
  /** ECON (v9): the crop the faction's new holdings resow by themselves. */
  autoSow: string | null;
  open: LedgerDay;
  closed: LedgerDay | null;
};

/** K7: one free company, by its id in MERCENARIES (the list is in the table's order). */
export type SavedCompany = {
  company: string;
  state: CompanyState;
  at: number;
  days: number;
  loyalty: number;
  army: number;
  bid: number;
  bidDays: number;
};

export type SavedExploration = {
  faction: FactionId;
  holdings: Knowledge[];
  roads: Knowledge[];
  finds: Find[];
  upgrades: UpgradeId[];
};

/**
 * Version 8 (K8): the captains -- whether the realm runs them
 * (KingdomConfig.captains, which a replay of the log needs, as `hosts`), each
 * faction's strategic AI's goal and its memory of the map, which story waves
 * have ridden, the rumours the king has heard, burned land and levy calls;
 * and a twelfth faction, the commons (economy and exploration entries).
 * Every army's posture may now be `ambush`; a contact's choice `yield` or `keep`.
 *
 * (Version 7 (K7): free companies -- every company of the story's table and
 * where it is in its life with the king (waiting, offered at a tavern, hired
 * with its army and contract days, its loyalty and the crown's bid, away,
 * turned or broken); every army's `company`; one new ledger category
 * (hiring).
 *
 * (Version 6 (K6): morale -- every holding's unrest (permille), its justice,
 * the days left of a festival and the season of its last pardon; every
 * faction's Mercy/Terror; two new ledger categories (festivals, justice).
 * Army morale was already saved (K4).
 *
 * (Version 5 (K5): the descent -- the contact the realm is held on, if any
 * (so a meeting left undecided reappears on continue), the pairs that have
 * settled a contact and not yet parted, and whether the world began with the
 * opening hosts (KingdomConfig.hosts), which a replay of the log needs. A
 * battle being fought when the game was left is not saved: the save is made
 * as the realm halts, so continuing asks "fight or withdraw?" again.
 *
 * (Version 4 (K4): armies -- every army on the map with its squads' strength,
 * supply, wages and orders; the army the king rides with; each holding's
 * days foraged this season; three new ledger categories (provisions,
 * disbanded, favours).
 *
 * (Version 3 (K3a): the map twice the size (holdings 37-72 appended, so every
 * later id moved: see migrate2to3), three new ledger categories, and every
 * faction's exploration -- map knowledge, finds and special upgrades.)
 *
 * (Version 2, K3: version 1 plus the economy -- every faction's stores and
 * ledger pages, and the new fields on holdings (works, idle, tax and its
 * remainders, famine), plots (days, health) and the king (task).)
 */
export type KingdomSaveV7 = {
  format: typeof KINGDOM_SAVE_FORMAT;
  version: 7;
  map: string;
  /** Fingerprint of the static map; see mapFingerprint. */
  mapFingerprint: string;
  seed: number;
  kingName: string;
  hosts: boolean;
  snapshot: {
    now: number;
    nextId: number;
    weather: WeatherId;
    rng: Record<string, RngState>;
    seqs: number[];
    pending: KingdomOrder[];
    holdings: SavedHolding[];
    king: { id: number; companions: string[]; mover: Mover; task: KingTask; taskDays: number; army: number };
    economy: SavedEconomy[];
    explore: SavedExploration[];
    armies: SavedArmy[];
    contact: Contact | null;
    disengaged: [number, number][];
    companies: SavedCompany[];
  };
  log: KingdomOrder[];
};

/** K8's sim state (see KingdomWorld). */
export type SavedK8 = {
  minds: AiMind[];
  intel: FactionIntel[];
  waves: boolean[];
  rumours: Rumour[];
  burned: Burned[];
  levied: Levied[];
};

export type KingdomSaveV8 = Omit<KingdomSaveV7, "version" | "snapshot"> & {
  version: 8;
  captains: boolean;
  snapshot: KingdomSaveV7["snapshot"] & { k8: SavedK8 };
};

/**
 * Version 9 (ECON): the twelve-month calendar and auto-farming -- the realm's
 * `epoch` (the day of year 1 it began on, which the calendar reads every date
 * from) and `autoFarm` (KingdomConfig.autoFarm, which a replay needs, as
 * `hosts`); every field's `auto` crop and the cause it was last `lost` to;
 * every faction's `autoSow`.
 */
export type KingdomSaveV9 = Omit<KingdomSaveV8, "version"> & {
  version: 9;
  epoch: number;
  autoFarm: boolean;
};

/** The current save shape. */
export type KingdomSave = KingdomSaveV9;

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/**
 * Ledger categories a version-2 page has: those before K3a's first. K3a
 * appended its categories, so an old page is the new one minus its tail.
 */
const V2_CATEGORIES = LEDGER_CATEGORY_IDS.indexOf("finds");
/** ...and a version-3 page those before K4's first. */
const V3_CATEGORIES = LEDGER_CATEGORY_IDS.indexOf("provisions");
/** ...and a version-5 page (K4 and K5 alike) those before K6's first. */
const V5_CATEGORIES = LEDGER_CATEGORY_IDS.indexOf("festivals");
/** ...and a version-6 page those before K7's first. */
const V6_CATEGORIES = LEDGER_CATEGORY_IDS.indexOf("hiring");

/** Re-lay a ledger page's flow from `from` categories wide to `to` wide (the new ones zero). */
function relayPage(v: unknown, from: number, to: number): unknown {
  if (v === null || typeof v !== "object") return v;
  const d = { ...(v as Record<string, unknown>) };
  const flow = Array.isArray(d.flow) ? d.flow : [];
  // A page of the wrong shape is left wrong, for readPage to refuse.
  if (flow.length !== LEDGER_STOCK_IDS.length * from) return d;
  const out = new Array<unknown>(LEDGER_STOCK_IDS.length * to).fill(0);
  for (let st = 0; st < LEDGER_STOCK_IDS.length; st++) {
    for (let c = 0; c < from; c++) out[st * to + c] = flow[st * from + c];
  }
  d.flow = out;
  return d;
}

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
  const relay = (v: unknown): unknown => relayPage(v, V2_CATEGORIES, V3_CATEGORIES);
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
  3: migrate3to4,
  4: migrate4to5,
  5: migrate5to6,
  6: migrate6to7,
  7: migrate7to8,
  8: migrate8to9,
};

/**
 * Version 8 (K8) -> 9 (ECON): the old four-month calendar to the twelve-month
 * one (owner, 2026-11-25). The days already lived stay lived -- `now`, every
 * tick in the log and the queue, every day counted (famine, contracts,
 * works) are untouched -- and only the DATE converts: the realm is given the
 * epoch (clock.ts epochForOldDay) that keeps it in the same year and season,
 * at the same share of the season (the 10th of an old 30-day spring is the
 * 30th of a 90-day one). A field part-grown keeps its share of its growth
 * (its days scaled with the crops' growth, clock ECON.2). Nothing resows
 * itself (`autoFarm` false, every field and faction `auto` null) until the
 * player turns it on; ripe fields are reaped by themselves from now on. The
 * season of each town's last pardon was counted from the old start and is
 * forgotten (a pardon is open again). The log replays under the new rules
 * from the converted epoch, which is the honest meaning of an old log under
 * new rules, as in every earlier step; the load takes the snapshot.
 */
function migrate8to9(save: Record<string, unknown>): Record<string, unknown> {
  // A save that already carries its epoch was written on the twelve-month
  // calendar (the tools write older version numbers onto new saves to test
  // each step): its dates and fields need no conversion, only the version.
  const converting = typeof save.epoch !== "number";
  const snap = { ...(save.snapshot as Record<string, unknown>) };
  const now = typeof snap.now === "number" ? snap.now : 0;
  const epoch = converting ? epochForOldDay(floor(now / TICKS_PER_DAY)) : save.epoch;
  const scale = converting ? DAYS_PER_SEASON / OLD_DAYS_PER_SEASON : 1;
  snap.holdings = (Array.isArray(snap.holdings) ? snap.holdings : []).map((v) => {
    const h: Record<string, unknown> = { ...(v as Record<string, unknown>) };
    if (converting) h.pardoned = 0;
    h.plots = (Array.isArray(h.plots) ? h.plots : []).map((pv: unknown) => {
      const p: Record<string, unknown> = { ...(pv as Record<string, unknown>) };
      p.auto = p.auto ?? null;
      p.lost = p.lost ?? null;
      if ((p.stage === "growing" || p.stage === "ripe") && typeof p.days === "number") p.days = p.days * scale;
      // Its share of its growth, on the new crop table (the days above are on it now).
      const crop = typeof p.crop === "string" ? CROPS[p.crop as CropId] : undefined;
      if (converting && p.stage === "growing" && crop && typeof p.days === "number") p.progress = min(1, p.days / crop.growDays);
      return p;
    });
    return h;
  });
  snap.economy = (Array.isArray(snap.economy) ? snap.economy : []).map((v) => {
    const e = v as Record<string, unknown>;
    return { ...e, autoSow: e.autoSow ?? null };
  });
  return { ...save, version: 9, epoch, autoFarm: save.autoFarm === true, snapshot: snap };
}

/**
 * Version 7 (K7) -> 8 (K8). A K7 realm had no captains, and is not given them
 * now (a seat's garrison conjured into a saved game would change what the
 * player left): `captains` false, every mind idle, no memories, no wave
 * ridden, no rumour, no burned land, no levy called. K8 appended a faction
 * (the commons), so the economy and exploration lists gain its entry: no
 * stores, an empty ledger page of the save's day, the whole map known (it is
 * their country too). No id moves; the log replays unchanged.
 */
function migrate7to8(save: Record<string, unknown>): Record<string, unknown> {
  const snap = { ...(save.snapshot as Record<string, unknown>) };
  const economy = Array.isArray(snap.economy) ? [...snap.economy] : [];
  const explore = Array.isArray(snap.explore) ? [...snap.explore] : [];
  // Every faction's pages turn together, so the commons' pages are the king's days, empty.
  const kingPage = (economy[0] as Record<string, unknown> | undefined) ?? {};
  const pageDay = (pg: unknown, fallback: number): number =>
    pg && typeof pg === "object" && typeof (pg as Record<string, unknown>).day === "number" ? ((pg as Record<string, unknown>).day as number) : fallback;
  const day = pageDay(kingPage.open, typeof snap.now === "number" ? calendar(snap.now).day : 0);
  const emptyPage = (d: number) => ({ day: d, start: new Array<number>(LEDGER_STOCK_IDS.length).fill(0), flow: new Array<number>(LEDGER_STOCK_IDS.length * LEDGER_CATEGORY_IDS.length).fill(0) });
  for (let f = economy.length; f < FACTION_IDS.length; f++) {
    const stocks: Record<string, number> = {};
    for (const st of STOCK_IDS) stocks[st] = 0;
    economy.push({
      faction: FACTION_IDS[f], stocks, legitimacy: 0, hunger: 0, defaultTax: DEFAULT_TAX, mercy: MERCY_START,
      open: emptyPage(day),
      closed: kingPage.closed ? emptyPage(pageDay(kingPage.closed, day - 1)) : null,
    });
  }
  const king = explore[0] as Record<string, unknown> | undefined;
  const nh = king && Array.isArray(king.holdings) ? king.holdings.length : 0;
  const nr = king && Array.isArray(king.roads) ? king.roads.length : 0;
  for (let f = explore.length; f < FACTION_IDS.length; f++) {
    explore.push({ faction: FACTION_IDS[f], holdings: new Array(nh).fill(KNOW_KNOWN), roads: new Array(nr).fill(KNOW_KNOWN), finds: [], upgrades: [] });
  }
  snap.economy = economy;
  snap.explore = explore;
  snap.k8 = {
    minds: FACTION_IDS.map(() => ({ goal: "consolidate", target: 0, since: 0, wave: -1, rides: 0 })),
    intel: FACTION_IDS.map(() => ({ owner: [], men: [], walls: [], seen: [] })),
    waves: INVASION_WAVES.map(() => false),
    rumours: [], burned: [], levied: [],
  };
  return { ...save, version: 8, captains: false, snapshot: snap };
}

/**
 * Version 6 (K6) -> 7 (K7). Before K7 no company had come to a tavern: every
 * company is waiting, no army is a company's, and ledger pages gain K7's one
 * category (hiring) at zero. No id moves. The order log holds no hiring
 * orders; a replay under K7's rules may see a company offered at a tavern
 * that the snapshot never saw -- the load takes the snapshot (as every step).
 */
function migrate6to7(save: Record<string, unknown>): Record<string, unknown> {
  const snap = { ...(save.snapshot as Record<string, unknown>) };
  snap.armies = (Array.isArray(snap.armies) ? snap.armies : []).map((v) => ({ ...(v as Record<string, unknown>), company: 0 }));
  snap.companies = MERCENARIES.map((m) => ({ company: m.id, state: "waiting", at: 0, days: 0, loyalty: 0, army: 0, bid: 0, bidDays: 0 }));
  snap.economy = (Array.isArray(snap.economy) ? snap.economy : []).map((v) => {
    const e: Record<string, unknown> = { ...(v as Record<string, unknown>) };
    e.open = relayPage(e.open, V6_CATEGORIES, LEDGER_CATEGORY_IDS.length);
    e.closed = relayPage(e.closed, V6_CATEGORIES, LEDGER_CATEGORY_IDS.length);
    return e;
  });
  return { ...save, version: 7, snapshot: snap };
}

/**
 * Version 5 (K5) -> 6 (K6). Before K6 no town's unrest was reckoned: every
 * holding starts calm (0), with no justice, no festival and no pardon given;
 * every faction's Mercy/Terror is the story's start (0); ledger pages gain
 * K6's two categories (festivals, justice) at zero. No id moves. The order
 * log holds no politics orders, so it replays -- under K6's daily rules,
 * which are the honest meaning of an old log under new rules: a replay from
 * day 0 reckons unrest from the start, so the snapshot and a replay may
 * differ in unrest only, and the load takes the snapshot (as every step).
 */
function migrate5to6(save: Record<string, unknown>): Record<string, unknown> {
  const snap = { ...(save.snapshot as Record<string, unknown>) };
  snap.holdings = (Array.isArray(snap.holdings) ? snap.holdings : []).map((v) => ({
    ...(v as Record<string, unknown>), unrest: 0, justice: DEFAULT_JUSTICE, festival: 0, pardoned: 0,
  }));
  snap.economy = (Array.isArray(snap.economy) ? snap.economy : []).map((v) => {
    const e: Record<string, unknown> = { ...(v as Record<string, unknown>), mercy: MERCY_START };
    // To the v6 width (K7's category comes in migrate6to7).
    e.open = relayPage(e.open, V5_CATEGORIES, V6_CATEGORIES);
    e.closed = relayPage(e.closed, V5_CATEGORIES, V6_CATEGORIES);
    return e;
  });
  return { ...save, version: 6, snapshot: snap };
}

/**
 * Version 4 (K4) -> 5 (K5). Before K5 no army had met another: no contact
 * waits and no pair is disengaged. The world did not begin with the opening
 * hosts (K4 had none), and it is not given them now: a host conjured into an
 * old campaign would take ids its own log never handed out, and the log
 * would no longer replay to the snapshot. A new campaign has them
 * (docs/PROVISIONAL.md K5.13). Nothing else moves.
 */
function migrate4to5(save: Record<string, unknown>): Record<string, unknown> {
  const snap = { ...(save.snapshot as Record<string, unknown>), contact: null, disengaged: [] };
  return { ...save, version: 5, hosts: false, snapshot: snap };
}

/**
 * Version 3 (K3a) -> 4 (K4). Before K4 nobody had an army: the snapshot gets
 * none, the king rides alone, no holding has been foraged, and ledger pages
 * gain K4's three categories (provisions, disbanded, favours) at zero. No id
 * moves (armies take ids after everything a v3 save holds). The order log is
 * kept; it holds no army orders, so it replays exactly as before -- K4's
 * daily rules (the followers' desertion when the party goes hungry) are the
 * honest meaning of an old log under new rules, as in every earlier step.
 */
function migrate3to4(save: Record<string, unknown>): Record<string, unknown> {
  const snap = { ...(save.snapshot as Record<string, unknown>) };
  snap.holdings = (Array.isArray(snap.holdings) ? snap.holdings : []).map((v) => ({ ...(v as Record<string, unknown>), foraged: 0 }));
  snap.king = { ...(snap.king as Record<string, unknown>), army: 0 };
  snap.armies = [];
  snap.economy = (Array.isArray(snap.economy) ? snap.economy : []).map((v) => {
    const e = { ...(v as Record<string, unknown>) };
    // To the v4 width (K6's categories come in migrate5to6).
    e.open = relayPage(e.open, V3_CATEGORIES, V5_CATEGORIES);
    e.closed = relayPage(e.closed, V3_CATEGORIES, V5_CATEGORIES);
    return e;
  });
  return { ...save, version: 4, snapshot: snap };
}

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
    version: 9,
    epoch: world.epoch,
    autoFarm: world.autoFarm,
    map: world.map.id,
    mapFingerprint: mapFingerprint(world),
    seed: world.seed,
    kingName: world.king.name,
    hosts: world.hosts,
    captains: world.captains,
    snapshot: {
      now: world.now,
      nextId: world.nextId,
      weather: world.weather,
      rng,
      seqs: world.orders.sequences(),
      pending: world.orders.queued().map((o) => ({ ...o, ...("squads" in o ? { squads: [...o.squads] } : {}), ...("holdings" in o ? { holdings: [...o.holdings] } : {}) })),
      holdings: world.holdings.map((h) => ({
        id: h.id,
        key: h.key,
        owner: h.owner,
        population: h.population,
        garrison: [...h.garrison],
        buildings: [...h.buildings],
        works: [...h.works],
        idle: [...h.idle],
        plots: h.plots.map((p) => ({
          id: p.id, crop: p.crop, stage: p.stage, progress: p.progress, days: p.days, health: p.health, auto: p.auto, lost: p.lost,
        })),
        tax: h.tax,
        taxCarry: h.taxCarry,
        doleCarry: h.doleCarry,
        famine: h.famine,
        foraged: h.foraged,
        unrest: h.unrest,
        justice: h.justice,
        festival: h.festival,
        pardoned: h.pardoned,
      })),
      king: {
        id: world.king.id, companions: [...world.king.companions], mover: cloneMover(world.king.mover),
        task: world.king.task, taskDays: world.king.taskDays, army: world.king.army,
      },
      economy: world.economy.map((e, f) => ({
        faction: FACTION_IDS[f],
        stocks: { ...e.stocks },
        legitimacy: e.legitimacy,
        hunger: e.hunger,
        defaultTax: e.defaultTax,
        mercy: e.mercy,
        autoSow: e.autoSow,
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
      armies: world.armies.map((a) => ({
        id: a.id, owner: FACTION_IDS[a.owner], company: a.company, name: a.name, doctrine: a.doctrine,
        squads: a.squads.map((q) => ({ id: q.id, unit: q.unit, men: q.men, wounded: q.wounded, levy: q.levy })),
        abilities: [...a.abilities], mover: cloneMover(a.mover), supply: a.supply, morale: a.morale, captain: a.captain,
        hunger: a.hunger, unpaid: a.unpaid, arrears: a.arrears, posture: a.posture, postureDays: a.postureDays,
        patrol: [...a.patrol], patrolIndex: a.patrolIndex, target: a.target, mergeInto: a.mergeInto,
        desertCarry: a.desertCarry, dieCarry: a.dieCarry, sickCarry: a.sickCarry,
      })),
      contact: world.contact ? { ...world.contact, sides: [{ ...world.contact.sides[0] }, { ...world.contact.sides[1] }] } : null,
      disengaged: world.disengaged.map(([a, b]) => [a, b] as [number, number]),
      companies: world.companies.map((c) => ({
        company: MERCENARIES[c.index].id, state: c.state, at: c.at, days: c.days, loyalty: c.loyalty,
        army: c.army, bid: c.bid, bidDays: c.bidDays,
      })),
      k8: {
        minds: world.minds.map((m) => ({ ...m })),
        intel: world.intel.map((x) => ({ owner: [...x.owner], men: [...x.men], walls: [...x.walls], seen: [...x.seen] })),
        waves: [...world.wavesRode],
        rumours: world.rumours.map((r) => ({ ...r })),
        burned: world.burned.map((b) => ({ ...b })),
        levied: world.levied.map((l) => ({ ...l })),
      },
    },
    log: world.log.map((o) => ({ ...o, ...("squads" in o ? { squads: [...o.squads] } : {}), ...("holdings" in o ? { holdings: [...o.holdings] } : {}) })),
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
/** K6: unrest in permille, 0..UNREST_MAX. */
function unrestOf(v: unknown, what: string): number {
  const n = int(v, what);
  if (n > UNREST_MAX) throw new Bad(what + " is over " + UNREST_MAX);
  return n;
}
/** K6: Mercy/Terror, MERCY_MIN..MERCY_MAX. */
function mercyOf(v: unknown, what: string): number {
  const n = int(v, what, MERCY_MIN);
  if (n > MERCY_MAX) throw new Bad(what + " is over " + MERCY_MAX);
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
    // K4. Army and squad ids may name nothing (the sim refuses them); unit,
    // doctrine and ability ids must be known (their hash code is their index).
    case "recruit":
      return {
        kind, at: int(o.at, what + ".at"), army: int(o.army, what + ".army"), unit: oneOf(o.unit, UNIT_TYPE_IDS, what + ".unit"),
        levy: bool(o.levy, what + ".levy"), tick, player, seq,
      };
    case "disband":
    case "haltArmy":
    case "garrison":
    case "recover":
      return { kind, army: int(o.army, what + ".army"), tick, player, seq };
    case "marchArmy":
      return { kind, army: int(o.army, what + ".army"), to: int(o.to, what + ".to"), tick, player, seq };
    case "merge":
      return { kind, army: int(o.army, what + ".army"), into: int(o.into, what + ".into"), tick, player, seq };
    case "split":
      return {
        kind, army: int(o.army, what + ".army"),
        squads: arr(o.squads, what + ".squads").map((n, i) => int(n, what + ".squads[" + i + "]")), tick, player, seq,
      };
    case "patrol":
      return {
        kind, army: int(o.army, what + ".army"),
        holdings: arr(o.holdings, what + ".holdings").map((n, i) => int(n, what + ".holdings[" + i + "]")), tick, player, seq,
      };
    case "setDoctrine":
      return { kind, army: int(o.army, what + ".army"), doctrine: oneOf(o.doctrine, DOCTRINE_IDS, what + ".doctrine"), tick, player, seq };
    case "unlockAbility":
      return { kind, army: int(o.army, what + ".army"), ability: oneOf(o.ability, ABILITY_IDS, what + ".ability"), tick, player, seq };
    case "intercept":
      return { kind, army: int(o.army, what + ".army"), target: int(o.target, what + ".target"), tick, player, seq };
    case "kingJoin":
      return { kind, army: int(o.army, what + ".army"), tick, player, seq };
    // K5. The contact may name nothing (the sim refuses it); a result must be
    // well-formed (its numbers are hashed), and the sim checks it fits.
    case "resolveContact":
      return {
        kind, contact: int(o.contact, what + ".contact"), choice: oneOf(o.choice, CONTACT_CHOICES, what + ".choice"),
        result: o.result === null ? null : readResult(o.result, what + ".result"), tick, player, seq,
      };
    // K6. The holding may name nothing (the sim refuses it); a justice is from a table.
    case "setJustice":
      return { kind, holding: int(o.holding, what + ".holding"), justice: oneOf(o.justice, JUSTICE_IDS, what + ".justice"), tick, player, seq };
    case "holdFestival":
    case "pardon":
      return { kind, holding: int(o.holding, what + ".holding"), tick, player, seq };
    // K7. A company index past the table is the sim's to refuse, like an unknown holding.
    case "hireCompany":
      return { kind, company: int(o.company, what + ".company"), at: int(o.at, what + ".at"), tick, player, seq };
    case "renewContract":
    case "matchBid":
      return { kind, company: int(o.company, what + ".company"), tick, player, seq };
    // K8. The holding or army may name nothing (the sim refuses it).
    case "callLevy":
    case "burnFields":
      return { kind, holding: int(o.holding, what + ".holding"), tick, player, seq };
    case "ambush":
      return { kind, army: int(o.army, what + ".army"), tick, player, seq };
    case "setAutoSow":
      return {
        kind, holding: int(o.holding, what + ".holding"), plot: int(o.plot, what + ".plot"),
        crop: o.crop === null ? null : oneOf(o.crop, CROP_IDS, what + ".crop"), tick, player, seq,
      };
    default:
      return { kind: "harvest", plot: int(o.plot, what + ".plot"), tick, player, seq };
  }
}

function readResult(v: unknown, what: string): BattleResult {
  const o = obj(v, what);
  const pair = <T>(x: unknown, w: string, f: (y: unknown, w: string) => T): [T, T] => {
    const a = arr(x, w);
    if (a.length !== 2) throw new Bad(w + " is not a pair");
    return [f(a[0], w + "[0]"), f(a[1], w + "[1]")];
  };
  const squad = (x: unknown, w: string): ResultSquad => {
    const q = obj(x, w);
    return { squad: int(q.squad, w + ".squad"), men: int(q.men, w + ".men"), wounded: int(q.wounded, w + ".wounded") };
  };
  const winner = int(o.winner, what + ".winner", -1);
  if (winner > 1) throw new Bad(what + ".winner is not a side");
  const d = obj(o.damage, what + ".damage");
  return {
    contact: int(o.contact, what + ".contact"),
    winner,
    squads: pair(o.squads, what + ".squads", (x, w) => arr(x, w).map((q, i) => squad(q, w + "[" + i + "]"))),
    morale: pair(o.morale, what + ".morale", (x, w) => int(x, w)),
    fled: pair(o.fled, what + ".fled", bool),
    left: pair(o.left, what + ".left", bool),
    damage: { crops: int(d.crops, what + ".damage.crops"), buildings: int(d.buildings, what + ".damage.buildings") },
    legitimacy: int(o.legitimacy, what + ".legitimacy", -1000000),
  };
}

/** The waiting contact: of the king's side (only those wait), between real sides, at a real place. */
function readContact(v: unknown, world: KingdomWorld, armies: readonly Army[], nextId: number): Contact | null {
  if (v === null) return null;
  const what = "snapshot.contact";
  const o = obj(v, what);
  const id = int(o.id, what + ".id", 1);
  if (id < world.nextId || id >= nextId) throw new Bad(what + " has an id outside the counter's range");
  if (armies.some((a) => a.id === id || a.squads.some((q) => q.id === id))) throw new Bad(what + " reuses id " + id);
  const kind = oneOf(o.kind, CONTACT_KINDS, what + ".kind");
  const sv = arr(o.sides, what + ".sides");
  if (sv.length !== 2) throw new Bad(what + ".sides is not a pair");
  const sides = sv.map((x, i) => {
    const so = obj(x, what + ".sides[" + i + "]");
    const faction = int(so.faction, what + ".sides[" + i + "].faction");
    if (faction >= FACTION_IDS.length) throw new Bad(what + ".sides[" + i + "] has an unknown faction");
    const army = int(so.army, what + ".sides[" + i + "].army");
    if (army !== 0 && !armies.some((a) => a.id === army && a.owner === faction)) {
      throw new Bad(what + ".sides[" + i + "] names an army not on the map, or not that side's");
    }
    return { faction, army };
  }) as [Contact["sides"][0], Contact["sides"][1]];
  if (sides[0].faction !== 0) throw new Bad(what + " is not the king's: only the king's contacts wait");
  if (sides[0].army === 0 && sides[1].army === 0) throw new Bad(what + " has no army on either side");
  if (sides[0].army === sides[1].army) throw new Bad(what + " meets an army with itself");
  if (FACTIONS[FACTION_IDS[sides[0].faction]].crown === FACTIONS[FACTION_IDS[sides[1].faction]].crown) {
    throw new Bad(what + " is between two sides that are not enemies");
  }
  const attacker = int(o.attacker, what + ".attacker");
  if (attacker > 1) throw new Bad(what + ".attacker is not a side");
  const holding = int(o.holding, what + ".holding", 1);
  if (!world.holding(holding)) throw new Bad(what + " is at an unknown holding");
  const road = int(o.road, what + ".road");
  if (road !== 0 && !world.graph.roads.get(road)) throw new Bad(what + " is on an unknown road");
  if (kind === "assault" && sides[1 - attacker].army !== 0) throw new Bad(what + " is an assault with an army defending");
  if (kind === "field" && (sides[0].army === 0 || sides[1].army === 0)) throw new Bad(what + " is a field fight without two armies");
  return { id, kind, sides, attacker, holding, road, tick: int(o.tick, what + ".tick") };
}

function readDisengaged(v: unknown, world: KingdomWorld, armies: readonly Army[]): [number, number][] {
  const out: [number, number][] = [];
  arr(v, "snapshot.disengaged").forEach((x, i) => {
    const what = "snapshot.disengaged[" + i + "]";
    const p = arr(x, what);
    if (p.length !== 2) throw new Bad(what + " is not a pair");
    const a = int(p[0], what + "[0]", 1);
    const b = int(p[1], what + "[1]", -1000000);
    if (!armies.some((y) => y.id === a)) throw new Bad(what + " names an army not on the map");
    if (b < 0 ? !world.holding(-b) : b <= a) throw new Bad(what + " is not an army and a later army, or an army and a holding");
    const prev = out[out.length - 1];
    if (prev && (prev[0] > a || (prev[0] === a && prev[1] >= b))) throw new Bad(what + " is out of order");
    out.push([a, b]);
  });
  return out;
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

function readArmies(v: unknown, world: KingdomWorld, nextId: number): Army[] {
  const list = arr(v, "snapshot.armies");
  const ids = new Set<number>();
  const perSide = new Array<number>(FACTION_IDS.length).fill(0);
  const firstFree = world.nextId;
  const fresh = (id: number, what: string): void => {
    if (id < firstFree || id >= nextId) throw new Bad(what + " has an id outside the counter's range");
    if (ids.has(id)) throw new Bad(what + " reuses id " + id);
    ids.add(id);
  };
  let last = 0;
  return list.map((x, i) => {
    const what = "army[" + i + "]";
    const o = obj(x, what);
    const id = int(o.id, what + ".id", 1);
    fresh(id, what);
    if (id <= last) throw new Bad(what + " is out of id order");
    last = id;
    const ownerId = oneOf(o.owner, FACTION_IDS, what + ".owner");
    const owner = FACTION_IDS.indexOf(ownerId);
    if (++perSide[owner] > MAX_ARMIES_PER_SIDE) throw new Bad(what + " is past the cap of " + MAX_ARMIES_PER_SIDE + " armies a side");
    let lastSquad = 0;
    const squads = arr(o.squads, what + ".squads").map((q, j) => {
      const qw = what + ".squads[" + j + "]";
      const qo = obj(q, qw);
      const sid = int(qo.id, qw + ".id", 1);
      fresh(sid, qw);
      if (sid <= lastSquad) throw new Bad(qw + " is out of id order");
      lastSquad = sid;
      const unit = oneOf(qo.unit, UNIT_TYPE_IDS, qw + ".unit");
      const men = int(qo.men, qw + ".men", 1);
      if (men > UNIT_TYPES[unit].soldiers) throw new Bad(qw + " has more men than a full squad");
      const wounded = int(qo.wounded, qw + ".wounded");
      if (wounded > men) throw new Bad(qw + " has more wounded than men");
      return { id: sid, unit, men, wounded, levy: bool(qo.levy, qw + ".levy") };
    });
    if (squads.length === 0) throw new Bad(what + " has no squads");
    const abilities = arr(o.abilities, what + ".abilities").map((ab, j) => oneOf(ab, ABILITY_IDS, what + ".abilities[" + j + "]"));
    for (const ab of abilities) {
      if (abilities.filter((y) => y === ab).length > MAX_OF_ONE_ABILITY) throw new Bad(what + " holds too many of one ability");
    }
    const morale = int(o.morale, what + ".morale");
    if (morale > 100) throw new Bad(what + ".morale is over 100");
    const patrol = arr(o.patrol, what + ".patrol").map((n, j) => {
      const hid = int(n, what + ".patrol[" + j + "]", 1);
      if (!world.holding(hid)) throw new Bad(what + " patrols an unknown holding");
      return hid;
    });
    const patrolIndex = int(o.patrolIndex, what + ".patrolIndex");
    if (patrol.length > 0 ? patrolIndex >= patrol.length : patrolIndex !== 0) throw new Bad(what + ".patrolIndex is off its patrol");
    const company = int(o.company, what + ".company");
    if (company > MERCENARIES.length) throw new Bad(what + " is a company the story does not have");
    const a: Army = {
      id, owner, company, name: str(o.name, what + ".name"), doctrine: oneOf(o.doctrine, DOCTRINE_IDS, what + ".doctrine"),
      squads, abilities, mover: readMover(o.mover, what + ".mover", world), supply: int(o.supply, what + ".supply"),
      morale, captain: str(o.captain, what + ".captain"), hunger: int(o.hunger, what + ".hunger"),
      unpaid: int(o.unpaid, what + ".unpaid"), arrears: int(o.arrears, what + ".arrears"),
      posture: oneOf(o.posture, ARMY_POSTURES, what + ".posture") as ArmyPosture, postureDays: int(o.postureDays, what + ".postureDays"),
      patrol, patrolIndex, target: int(o.target, what + ".target"), mergeInto: bool(o.mergeInto, what + ".mergeInto"),
      desertCarry: int(o.desertCarry, what + ".desertCarry"), dieCarry: int(o.dieCarry, what + ".dieCarry"),
      sickCarry: int(o.sickCarry, what + ".sickCarry"),
    };
    if (a.desertCarry >= 1000 || a.dieCarry >= 1000 || a.sickCarry >= 1000) throw new Bad(what + " has a remainder of a whole man or more");
    if ((a.posture === "patrol") !== (a.patrol.length > 0)) throw new Bad(what + " patrols without a patrol, or the reverse");
    if (a.target === a.id) throw new Bad(what + " chases itself");
    return a;
  });
}

/**
 * K7: one record per company of the table, in its order; a hired company's
 * army is the king's and is that company's; no army is a hired company's but
 * its own; an offer is at a holding.
 */
/** K8's state, every field checked. */
function readK8(v: unknown, world: KingdomWorld, armies: readonly Army[], captains: boolean): SavedK8 {
  const o = obj(v, "snapshot.k8");
  const nh = world.holdings.length;
  const holdingId = (n: unknown, what: string): number => {
    const id = int(n, what, 1);
    if (!world.holding(id)) throw new Bad(what + " is not a holding");
    return id;
  };
  const minds = arr(o.minds, "snapshot.k8.minds").map((m, i) => {
    const what = "snapshot.k8.minds[" + i + "]";
    const mo = obj(m, what);
    const wave = int(mo.wave, what + ".wave", -1);
    if (wave >= INVASION_WAVES.length) throw new Bad(what + ".wave is not a wave");
    const rides = int(mo.rides, what + ".rides");
    if (rides !== 0 && !armies.some((a) => a.id === rides && a.owner === i)) throw new Bad(what + ".rides is not one of its armies");
    return {
      goal: oneOf(mo.goal, AI_GOALS, what + ".goal"), target: int(mo.target, what + ".target"), since: int(mo.since, what + ".since"),
      wave, rides,
    };
  });
  if (minds.length !== FACTION_IDS.length) throw new Bad("snapshot.k8.minds has the wrong number of factions");
  const intel = arr(o.intel, "snapshot.k8.intel").map((x, f) => {
    const what = "snapshot.k8.intel[" + f + "]";
    const xo = obj(x, what);
    const owner = arr(xo.owner, what + ".owner").map((n, i) => int(n, what + ".owner[" + i + "]", -1));
    const men = arr(xo.men, what + ".men").map((n, i) => int(n, what + ".men[" + i + "]"));
    const walls = arr(xo.walls, what + ".walls").map((n, i) => int(n, what + ".walls[" + i + "]"));
    const seen = arr(xo.seen, what + ".seen").map((n, i) => int(n, what + ".seen[" + i + "]", -1));
    const want = captains && FACTIONS[FACTION_IDS[f]].persona ? nh : 0;
    for (const l of [owner, men, walls, seen]) if (l.length !== want) throw new Bad(what + " does not match the map");
    if (owner.some((n) => n >= FACTION_IDS.length)) throw new Bad(what + ".owner names an unknown faction");
    if (walls.some((n) => n >= FORTIFICATIONS.length)) throw new Bad(what + ".walls names unknown walls");
    return { owner, men, walls, seen };
  });
  if (intel.length !== FACTION_IDS.length) throw new Bad("snapshot.k8.intel has the wrong number of factions");
  const waves = arr(o.waves, "snapshot.k8.waves").map((b, i) => bool(b, "snapshot.k8.waves[" + i + "]"));
  if (waves.length !== INVASION_WAVES.length) throw new Bad("snapshot.k8.waves does not match the story's waves");
  const ids = new Set(armies.map((a) => a.id));
  const rumours = arr(o.rumours, "snapshot.k8.rumours").map((r, i) => {
    const what = "snapshot.k8.rumours[" + i + "]";
    const ro = obj(r, what);
    const army = int(ro.army, what + ".army", 1);
    if (!ids.has(army)) throw new Bad(what + " is of an army that is not on the map");
    return {
      army, target: holdingId(ro.target, what + ".target"), from: holdingId(ro.from, what + ".from"),
      days: int(ro.days, what + ".days"), day: int(ro.day, what + ".day"),
    };
  });
  const burned = arr(o.burned, "snapshot.k8.burned").map((b, i) => {
    const what = "snapshot.k8.burned[" + i + "]";
    const bo = obj(b, what);
    return { holding: holdingId(bo.holding, what + ".holding"), days: int(bo.days, what + ".days", 1) };
  });
  const levied = arr(o.levied, "snapshot.k8.levied").map((l, i) => {
    const what = "snapshot.k8.levied[" + i + "]";
    const lo = obj(l, what);
    return { holding: holdingId(lo.holding, what + ".holding"), day: int(lo.day, what + ".day") };
  });
  return { minds, intel, waves, rumours, burned, levied };
}

function readCompanies(v: unknown, world: KingdomWorld, armies: Army[]): Company[] {
  const list = arr(v, "snapshot.companies");
  if (list.length !== MERCENARIES.length) throw new Bad("snapshot.companies does not match the story's companies");
  const out = list.map((x, i) => {
    const what = "company[" + i + "]";
    const o = obj(x, what);
    if (str(o.company, what + ".company") !== MERCENARIES[i].id) throw new Bad(what + " is not " + MERCENARIES[i].id);
    const state = oneOf(o.state, COMPANY_STATES, what + ".state") as CompanyState;
    const c: Company = {
      index: i, state, at: int(o.at, what + ".at"), days: int(o.days, what + ".days"),
      loyalty: int(o.loyalty, what + ".loyalty"), army: int(o.army, what + ".army"),
      bid: int(o.bid, what + ".bid"), bidDays: int(o.bidDays, what + ".bidDays"),
    };
    if (c.loyalty > LOYALTY.max) throw new Bad(what + ".loyalty is over " + LOYALTY.max);
    if ((state === "offered") !== (c.at !== 0)) throw new Bad(what + " is at a tavern without an offer, or the reverse");
    if (state === "offered" && !world.holding(c.at)) throw new Bad(what + " is offered at an unknown holding");
    if ((state === "hired") !== (c.army !== 0)) throw new Bad(what + " has an army without a contract, or the reverse");
    if (state !== "hired" && (c.bid !== 0 || c.bidDays !== 0)) throw new Bad(what + " has a bid out of service");
    if (state === "hired") {
      const a = armies.find((y) => y.id === c.army);
      if (!a || a.owner !== 0 || a.company !== i + 1) throw new Bad(what + "'s army is not the king's army of that company");
    }
    return c;
  });
  for (const a of armies) {
    if (a.company === 0 || a.owner !== 0) continue;
    if (out[a.company - 1].army !== a.id) throw new Bad("army " + a.id + " is a company's that does not serve the king");
  }
  return out;
}

function build(save: Record<string, unknown>, resight = false): KingdomWorld {
  const mapId = str(save.map, "map");
  const map = KINGDOM_MAPS[mapId];
  if (!map) throw new Bad("unknown map " + mapId);
  const world = new KingdomWorld({
    seed: u32(save.seed, "seed"),
    map,
    kingName: str(save.kingName, "kingName"),
    autoFarm: bool(save.autoFarm, "autoFarm"),
    epoch: int(save.epoch, "epoch"),
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
      const auto = strOrNull(po.auto, pw + ".auto");
      if (auto !== null && !(CROP_IDS as readonly string[]).includes(auto)) throw new Bad(pw + " resows an unknown crop " + auto);
      const lost = strOrNull(po.lost, pw + ".lost");
      if (lost !== null && !(PLOT_CAUSES as readonly string[]).includes(lost)) throw new Bad(pw + " was lost to an unknown cause " + lost);
      return {
        id: int(po.id, pw + ".id"), crop: crop as CropId | null,
        stage: stage as PlotStage, progress, days: int(po.days, pw + ".days"), health,
        auto: auto as CropId | null, lost: lost as PlotCause | null,
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
      foraged: int(h.foraged, what + ".foraged"),
      unrest: unrestOf(h.unrest, what + ".unrest"),
      justice: oneOf(h.justice, JUSTICE_IDS, what + ".justice"),
      festival: int(h.festival, what + ".festival"),
      pardoned: int(h.pardoned, what + ".pardoned"),
    };
  });

  const k = obj(s.king, "snapshot.king");
  if (int(k.id, "snapshot.king.id") !== world.king.id) throw new Bad("snapshot.king.id does not match the map");
  const companions = arr(k.companions, "snapshot.king.companions").map((c, i) => str(c, "companion[" + i + "]"));
  const mover = readMover(k.mover, "snapshot.king.mover", world);
  const task = oneOf(k.task, KING_TASKS, "snapshot.king.task");
  const taskDays = int(k.taskDays, "snapshot.king.taskDays");
  const kingArmy = int(k.army, "snapshot.king.army");

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
      mercy: mercyOf(o.mercy, what + ".mercy"),
      autoSow: ((): string | null => {
        const c = strOrNull(o.autoSow, what + ".autoSow");
        if (c !== null && !(CROP_IDS as readonly string[]).includes(c)) throw new Bad(what + " resows an unknown crop " + c);
        return c;
      })(),
      open: readPage(o.open, what + ".open"),
      closed: o.closed === null ? null : readPage(o.closed, what + ".closed"),
    };
  });

  const ex = arr(s.explore, "snapshot.explore");
  if (ex.length !== FACTION_IDS.length) throw new Bad("snapshot.explore has the wrong number of factions");
  const explore = ex.map((v, i) => readExploration(v, "explore[" + i + "]", world, i));

  const armies = readArmies(s.armies, world, nextId);
  const contact = readContact(s.contact, world, armies, nextId);
  const disengaged = readDisengaged(s.disengaged, world, armies);
  const companies = readCompanies(s.companies, world, armies);
  const hosts = bool(save.hosts, "hosts");
  const captains = bool(save.captains, "captains");
  const k8 = readK8(s.k8, world, armies, captains);
  if (kingArmy !== 0) {
    const a = armies.find((x) => x.id === kingArmy);
    if (!a || a.owner !== 0) throw new Bad("snapshot.king.army is not one of the king's armies");
    const same = a.mover.node === mover.node && a.mover.road === mover.road && a.mover.along === mover.along;
    if (!same) throw new Bad("snapshot.king is not where the army he rides with is");
  }
  const armyIds = new Map(armies.map((a) => [a.id, a]));
  saved.forEach((h, i) => {
    for (const g of h.garrison) {
      const a = armyIds.get(g);
      const live = world.holdings[i];
      if (!a || FACTION_IDS[a.owner] !== h.owner || a.mover.node !== live.id || a.posture !== "hold") {
        throw new Bad("holding[" + i + "] has a garrison that is not an army of its owner holding there");
      }
    }
  });
  for (const a of armies) {
    if (a.target !== 0 && !armyIds.has(a.target)) throw new Bad("army " + a.id + " chases an army that is not on the map");
  }

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
    live.foraged = h.foraged;
    live.unrest = h.unrest;
    live.justice = h.justice;
    live.festival = h.festival;
    live.pardoned = h.pardoned;
  });
  world.king.companions = companions;
  world.king.mover = mover;
  world.king.task = task;
  world.king.taskDays = taskDays;
  world.king.army = kingArmy;
  world.armies.push(...armies);
  world.contact = contact;
  world.disengaged.push(...disengaged);
  world.companies.splice(0, world.companies.length, ...companies);
  world.hosts = hosts;
  world.captains = captains;
  world.minds.splice(0, world.minds.length, ...k8.minds);
  world.intel.splice(0, world.intel.length, ...k8.intel);
  world.wavesRode.splice(0, world.wavesRode.length, ...k8.waves);
  world.rumours.push(...k8.rumours);
  world.burned.push(...k8.burned);
  world.levied.push(...k8.levied);
  economy.forEach((e, i) => {
    const live = world.economy[i];
    for (const st of STOCK_IDS) live.stocks[st] = e.stocks[st];
    live.legitimacy = e.legitimacy;
    live.hunger = e.hunger;
    live.defaultTax = e.defaultTax;
    live.mercy = e.mercy;
    live.autoSow = e.autoSow;
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
  config: { map?: KingdomWorld["map"]; kingName?: string; hosts?: boolean; captains?: boolean; autoFarm?: boolean; epoch?: number } = {},
): KingdomWorld {
  const w = new KingdomWorld({ seed, ...config });
  for (const o of log) w.submit(o);
  while (w.now < until) w.tick();
  // K5: a contact settled on the snapshot's own tick was settled by a held
  // tick, which does not move the clock: run those too, while logged orders
  // are still waiting and the realm is still held.
  while (w.contact && w.log.length < log.length && w.orders.queued().some((o) => o.tick <= w.now)) w.tick();
  return w;
}
