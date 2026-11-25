/**
 * Kingdom state: plain records, mutated only by KingdomWorld.tick().
 *
 * Every entity -- holding, road, field plot, the king's retinue, and from K4
 * every army -- takes its id from the world's single monotonic counter, and
 * every list here is kept in id order, so "for each holding" means the same
 * sequence on every machine without anyone having to remember to sort.
 *
 * Fields that later phases fill are present now as empty placeholders, so the
 * save format and the hash already cover them and K3/K4 change their
 * contents, not their shape.
 */

import type { FactionId } from "../../content/kingdom/factions.ts";
import type { BiomeId, HoldingKind, RoadTerrainId } from "../../content/kingdom/terrain.ts";
import type { ProvinceId } from "../../content/kingdom/map.ts";
import type { FarmEventId, StockId, TaxRateId } from "../../content/kingdom/economy.ts";
import type { Knowledge } from "../../content/kingdom/exploration.ts";
import type { UpgradeId } from "../../content/story/upgrades.ts";
import type { UnitTypeId } from "../../content/unit-types.ts";
import type { DoctrineId } from "../../content/doctrines.ts";
import type { AbilityId } from "../../content/abilities.ts";

/** The life of a field plot (PLAN.md §B.3; the transitions are in content/kingdom/crops.ts). */
export type PlotStage = "empty" | "sown" | "growing" | "ripe" | "harvested" | "spoiled";
/** Hash code of a stage is its index. Append only. */
export const PLOT_STAGES: readonly PlotStage[] = ["empty", "sown", "growing", "ripe", "harvested", "spoiled"];

export type FieldPlot = {
  readonly id: number;
  /** Crop id from content/kingdom/crops.ts; null while empty. Kept through harvested/spoiled, for the record. */
  crop: string | null;
  stage: PlotStage;
  /**
   * 0..1 through the growing stage. DERIVED from `days` (days / growDays) and
   * written whenever `days` changes, never accumulated, so it is exact.
   */
  progress: number;
  /**
   * Days counted in the current stage: sown -> germination days, growing ->
   * growing-season days, ripe -> days standing ripe.
   */
  days: number;
  /** 0..100: what weather has left of the crop. The yield is scaled by it; 0 spoils it. */
  health: number;
};

export type Holding = {
  readonly id: number;
  /** The content key; what a save and the story refer to. */
  readonly key: string;
  readonly name: string;
  readonly province: ProvinceId;
  readonly kind: HoldingKind;
  readonly biome: BiomeId;
  readonly x: number;
  readonly y: number;
  /** A battle here generates its ground from this (with the biome's level). */
  readonly seed: number;
  /** Null while unclaimed. */
  owner: FactionId | null;
  population: number;
  /** How many armies may stand garrison. */
  readonly garrisonSlots: number;
  /** Ids of armies standing garrison (K4). Never longer than garrisonSlots. */
  garrison: number[];
  /** One entry per building slot: a building id (content/kingdom/buildings.ts), or null for empty. */
  buildings: (string | null)[];
  /** Per slot: days of work left on the building there; 0 = standing (or empty). */
  works: number[];
  /** Per slot: its upkeep went unpaid today, so it did nothing. Rewritten every day. */
  idle: boolean[];
  plots: FieldPlot[];
  /** Tax rate, for an owned holding (content TAX_RATES). */
  tax: TaxRateId;
  /** Pennies of tax owed but not yet a whole coin, x100 (see content/kingdom/economy.ts UNITS). */
  taxCarry: number;
  /** Grain of dole drawn but not yet a whole grain, x100. */
  doleCarry: number;
  /**
   * Consecutive days this holding has gone short of bread. 0 = fed. THE famine
   * signal: K6 turns it into unrest, K4 into desertion of a garrison.
   */
  famine: number;
  /**
   * Days an army has lived off this holding's land this season (K4), reset at
   * each season's turn. THE foraging signal: K6 turns it into unrest -- an
   * army that strips the fields is supply bought with goodwill.
   */
  foraged: number;
};

/**
 * One faction's stores and soft stats (PLAN.md §B.3). Kept for every faction
 * in FACTION_IDS order. Only factions whose economy runs (economy.ts
 * ECONOMY_FACTIONS) see them move in K3; the captains' stores wait for K8's
 * stewards.
 */
export type FactionEconomy = {
  readonly stocks: Record<StockId, number>;
  /** Soft stat, 0..LEGITIMACY_MAX. K6 writes its rules; the ledger already records it. */
  legitimacy: number;
  /**
   * Consecutive days the faction's own party (for the king: the king, the
   * companions and the levy following him) has gone short. 0 = fed. The
   * party's famine signal, beside each holding's own; K4 turns it into
   * desertion and attrition.
   */
  hunger: number;
  /** The rate a holding this faction claims starts at; setTax on the realm sets it. */
  defaultTax: TaxRateId;
};

/** What the king's party is doing where it stands (the from-nothing start, §A.5). */
export type KingTask = "none" | "forage" | "rally";
/** Hash code is the index. Append only. */
export const KING_TASKS: readonly KingTask[] = ["none", "forage", "rally"];

export type Road = {
  readonly id: number;
  /** Holding ids of the two ends, a < b. */
  readonly a: number;
  readonly b: number;
  readonly terrain: RoadTerrainId;
  /** Miles, end to end. */
  readonly length: number;
  /** Effort per mile (content ROAD_TERRAIN). Travel effort = length x cost. */
  readonly cost: number;
};

/**
 * Something that travels the road graph: the king's retinue now, armies from
 * K4. Flat fields rather than a union so the hash and the save read the same
 * shape whatever the mover is doing.
 *
 * Exactly one of `node` and `road` is non-zero (ids start at 1):
 *  - at a holding: node = its id, road = 0;
 *  - on a road:    road = its id, travelling from `from` toward `to`,
 *                  `along` miles from `from` -- continuous, so two movers can
 *                  meet halfway between towns (K5 contact).
 */
export type Mover = {
  node: number;
  road: number;
  from: number;
  to: number;
  along: number;
  /**
   * Holdings still to reach, in order. When on a road, route[0] is `to`.
   * Empty when standing still -- including standing halfway along a road
   * after a halt.
   */
  route: number[];
};

/**
 * The exiled king and whoever is with him (PLAN.md §A.5, "start from
 * nothing"): no holding, no army, no coin -- just the king and Brother Aldous
 * at a node of the map. K4 lets this retinue rally followers into an army.
 */
export type KingToken = {
  readonly id: number;
  /** Chosen at the start (docs/PROVISIONAL.md A.7.3). */
  readonly name: string;
  /** Named people travelling with the king. */
  companions: string[];
  mover: Mover;
  /** Foraging or rallying at the holding he stands in; cleared by marching or halting. */
  task: KingTask;
  /** Whole days spent on the task so far. */
  taskDays: number;
  /**
   * The army the king rides with (K4), or 0 when he travels alone. While he
   * rides with one, his mover is a copy of the army's and his marches are its
   * marches (docs/PROVISIONAL.md K4.1).
   */
  army: number;
};

/** What an army is doing where it stands (K4). Hash code is the index. Append only. */
export type ArmyPosture = "none" | "hold" | "patrol" | "recover";
export const ARMY_POSTURES: readonly ArmyPosture[] = ["none", "hold", "patrol", "recover"];

/**
 * One squad of a campaign army: a battle squad (content/unit-types.ts) that
 * remembers what has happened to it. Its strength persists from day to day
 * and, from K5, from battle to battle: `men` are alive and with the colours
 * (never more than the type's `soldiers`), and `wounded` of them cannot fight
 * yet (sick from hunger, hurt in battle) until they mend.
 */
export type ArmySquad = {
  readonly id: number;
  readonly unit: UnitTypeId;
  men: number;
  /** 0..men. */
  wounded: number;
  /** Raised from the king's followers without a barracks: serves for bread, takes no wage. */
  readonly levy: boolean;
};

/**
 * An army on the kingdom map (PLAN.md §B.4): a battle army list -- doctrine,
 * squads, abilities -- wrapped in what the kingdom knows of it. Kept in
 * world.armies in id order; ids from the world's one counter.
 */
export type Army = {
  readonly id: number;
  /** Faction index (FACTION_IDS). */
  readonly owner: number;
  /** "First Army": the lowest ordinal free when it was raised. */
  name: string;
  doctrine: DoctrineId;
  /** In id order. Never empty while the army is on the map. */
  squads: ArmySquad[];
  /** Battle abilities earned by the kingdom for this army (§B.4), at most MAX_OF_ONE_ABILITY of each. */
  abilities: AbilityId[];
  /** Where it is, and the destination queue (route) it is working through. */
  mover: Mover;
  /** Grain carried in packs and wagons, in person-days. */
  supply: number;
  /** 0..100. A placeholder until K6 writes the rules that move it (§B.6); saved and hashed now. */
  morale: number;
  /** Who commands it when the king does not ride with it: a captain's name, "" for a sergeant. */
  captain: string;
  /** Consecutive days it went short of bread. 0 = fed. K6 reads it as a morale input. */
  hunger: number;
  /** Consecutive days it has had wages owed. 0 = paid up. "Late wages" is unpaid > 0. */
  unpaid: number;
  /** Coin owed in wages and not yet paid; paid first out of the next coin. */
  arrears: number;
  posture: ArmyPosture;
  /** Whole days in the current posture (a hold counts as dug in from HOLD_DIG_IN_DAYS). */
  postureDays: number;
  /** Holdings a patrol walks between, in order (empty unless patrolling). */
  patrol: number[];
  /** The patrol stop it is walking to next. */
  patrolIndex: number;
  /** An army it is marching to meet (intercept or merge), or 0. */
  target: number;
  /** True when `target` is an own army to join on meeting, false for an intercept. */
  mergeInto: boolean;
  /** Per-mille remainders of the daily losses, so they are exact integers with no random draw. */
  desertCarry: number;
  dieCarry: number;
  sickCarry: number;
};

/** Why an army left the map. */
export type ArmyGoneReason = "starved" | "deserted" | "disbanded" | "fell" | "captured";

/**
 * K5: two hostile armies have met (or an army has come to the walls of a
 * hostile holding), and a battle, a withdrawal or an auto-resolve has to
 * settle it (PLAN.md §B.9; sim/kingdom/descent.ts).
 *
 * `sides[0]` is the king's side whenever the king's side is in it, so the
 * battle's player 0 -- the seat a person takes -- is always sides[0]. An
 * assault has no army on the defending side: `sides[1].army` is 0 and the
 * holding's townsmen man its walls.
 */
export type ContactKind = "field" | "assault";
export const CONTACT_KINDS: readonly ContactKind[] = ["field", "assault"];
export type ContactSide = {
  /** Faction index. */
  readonly faction: number;
  /** Army id, or 0 for a holding's townsmen behind its walls. */
  readonly army: number;
};
export type Contact = {
  /** From the world's one counter. */
  readonly id: number;
  readonly kind: ContactKind;
  readonly sides: readonly [ContactSide, ContactSide];
  /** Which side moved into the other: 0 or 1. */
  readonly attacker: number;
  /** The holding the battle is fought at (the nearer end of the road, for a meeting on one). */
  readonly holding: number;
  /** The road it happened on, or 0 at a holding. */
  readonly road: number;
  /** Kingdom tick it happened on. */
  readonly tick: number;
};

/** One army's day, for the feed and the tests. */
export type ArmyDayReport = {
  readonly army: number;
  readonly owner: number;
  /** Coin owed today, and what was paid (arrears first). */
  readonly wage: number;
  readonly paid: number;
  readonly arrears: number;
  /** Grain it needed, and where it came from. */
  readonly ration: number;
  readonly fromWagons: number;
  readonly fromStores: number;
  readonly foraged: number;
  /** Grain it went short. */
  readonly short: number;
  /** Grain loaded into its packs and wagons from the stores. */
  readonly loaded: number;
  readonly deserted: number;
  readonly died: number;
  readonly sickened: number;
  readonly healed: number;
  readonly replaced: number;
  readonly iron: number;
};

/**
 * What a faction found at an exploration site (K3a): the event drawn for it,
 * and what was chosen. One per site per faction, ever -- that is what makes
 * "the first visit triggers its event" exact.
 */
export type Find = {
  /** Holding id of the site. */
  readonly site: number;
  /** Index in content/story STORY_EVENTS; -1 if every fitting event was already drawn. */
  readonly event: number;
  /** Calendar day it was found. */
  readonly day: number;
  /** Index of the choice made; -1 while the letter waits. */
  choice: number;
  /** A gamble's roll went against it (false when there was no gamble). */
  failed: boolean;
};

/**
 * One faction's map knowledge and finds (K3a; content/kingdom/exploration.ts).
 * `holdings[i]` is the knowledge of world.holdings[i], `roads[i]` of
 * world.roads[i]: both are in id order, so the index IS the canonical order.
 */
export type FactionExploration = {
  readonly holdings: Knowledge[];
  readonly roads: Knowledge[];
  /** In the order found. */
  readonly finds: Find[];
  /** Special upgrades held, in the order gained (content/story/upgrades.ts). */
  readonly upgrades: UpgradeId[];
};

/**
 * Something that happened during a tick, for the UI and the chronicle.
 * Transient: rebuilt every tick, never saved, never hashed -- everything it
 * reports is already in the state.
 */
export type KingdomEvent =
  | { kind: "dayBegan"; day: number; weather: string }
  | { kind: "kingDeparted"; from: number; to: number }
  | { kind: "kingArrived"; at: number; destination: boolean }
  | { kind: "orderRejected"; order: { kind: string; player: number; seq: number }; reason: string }
  // -- K3: the economy -----------------------------------------------------------
  /** A faction's stocks changed this tick (the resources bar listens for this). */
  | { kind: "stocksChanged"; faction: number }
  /** Drought, frost or flood today (kingdom-wide; flood only harms flood country). */
  | { kind: "farmWeather"; event: FarmEventId }
  | { kind: "plotStage"; holding: number; plot: number; stage: PlotStage; cause: PlotCause }
  | { kind: "built"; holding: number; slot: number; building: string }
  | { kind: "buildingStarted"; holding: number; slot: number; building: string }
  | { kind: "upkeepUnpaid"; holding: number; slot: number; building: string }
  /** Famine began (days === 1) or ended (days === 0) at a holding, or for the party (holding 0). */
  | { kind: "famine"; faction: number; holding: number; days: number }
  | { kind: "foraged"; grain: number; timber: number }
  | { kind: "rallied"; holding: number; followers: number }
  /** A rally at a hamlet that has no more to give. */
  | { kind: "rallyDone"; holding: number }
  | { kind: "claimed"; holding: number; faction: number }
  | { kind: "harvested"; holding: number; plot: number; gains: Partial<Record<StockId, number>> }
  | { kind: "taxSet"; holding: number; rate: TaxRateId }
  | { kind: "taskSet"; task: KingTask; holding: number }
  // -- K3a: exploration ------------------------------------------------------------
  /** Holdings a faction knew nothing of came into sight or were told of (ids, ascending). */
  | { kind: "sighted"; faction: number; holdings: number[] }
  /** The party set foot in a site for the first time: its letter is waiting (event -1: nothing left to find). */
  | { kind: "siteDiscovered"; faction: number; site: number; event: number }
  | { kind: "eventResolved"; faction: number; site: number; event: number; choice: number; failed: boolean }
  | { kind: "upgradeGained"; faction: number; upgrade: UpgradeId; site: number }
  /** An event's reveal marked these many holdings known. */
  | { kind: "revealed"; faction: number; site: number; holdings: number[] }
  // -- K4: armies ------------------------------------------------------------------
  | { kind: "armyRaised"; army: number; owner: number; at: number }
  | { kind: "recruited"; army: number; squad: number; unit: UnitTypeId; men: number; levy: boolean }
  | { kind: "armyDeparted"; army: number; from: number; to: number }
  | { kind: "armyArrived"; army: number; at: number; destination: boolean }
  | { kind: "armySplit"; army: number; into: number; squads: number[] }
  | { kind: "armiesMerged"; army: number; into: number; owner: number; name: string }
  | { kind: "armyGone"; army: number; owner: number; name: string; reason: ArmyGoneReason }
  | { kind: "armyPosture"; army: number; posture: ArmyPosture }
  /** The king now rides with this army (0: alone). */
  | { kind: "kingJoined"; army: number }
  | { kind: "doctrineSet"; army: number; doctrine: DoctrineId }
  | { kind: "abilityUnlocked"; army: number; ability: AbilityId }
  /** A chasing army reached the one it was sent to meet (K5 turns this into contact). */
  | { kind: "intercepted"; army: number; target: number }
  | ({ kind: "armyDay" } & ArmyDayReport)
  /** Wages fell behind (days === 1) or were paid up (days === 0). */
  | { kind: "wagesLate"; army: number; days: number }
  /** The king's unformed followers walked home from a hungry party. */
  | { kind: "followersDeserted"; faction: number; n: number }
  // -- K5: the descent ---------------------------------------------------------------
  /** Two hostile armies met, or an army came to hostile walls. A contact of the king's side holds the realm until settled. */
  | { kind: "contact"; contact: number; player: boolean }
  /** A contact was settled: by a battle fought (or auto-resolved), or by a withdrawal. */
  | { kind: "contactResolved"; contact: number; how: "fight" | "withdraw" | "auto"; winner: number }
  /** An army fell back from a contact or a lost battle, toward `to` (0: it stands where it is). */
  | { kind: "fellBack"; army: number; to: number }
  /** A holding changed hands by assault. */
  | { kind: "stormed"; holding: number; faction: number };

/** Why a plot changed stage, for the feed. */
export type PlotCause = "sown" | "sprouted" | "ripened" | "harvested" | "overripe" | "weather" | "winter" | "regrew" | "foraged";
