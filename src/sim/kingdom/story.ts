/**
 * The story (PLAN.md §A.4-§A.6, §B.11; phase K9): acts, letters, forks,
 * scripted encounters, the chronicle and the endings, run by the kingdom sim.
 *
 * Everything here is content-driven (src/content/story/): an act ends when
 * every goal of it holds at once, a letter is sent when its trigger first
 * holds, an ending is chosen by Legitimacy x Mercy the day the crown is
 * taken. This module only evaluates those conditions against the kingdom
 * state and applies a choice's effects through the sim's own paths -- the
 * ledger for stocks and legitimacy, morale.ts for mercy, mercenaries.ts for
 * companies, armies.ts for an encounter's host -- so a story run is as
 * deterministic, replayable and saved as any other.
 *
 * Contract (docs/kingdom.md, K9):
 *   - Off unless KingdomConfig.story (a new campaign sets it), so every older
 *     suite and the kingdom golden keep their realm byte for byte.
 *   - Once a day (runStoryDay, after the mercenaries' day): seasons and
 *     winters, follow-ups due, letter triggers in table order, encounter
 *     hosts kept standing, the act's goals, the failure checks.
 *   - Every tick's end (storyTickEnd): the tick's events are written into the
 *     chronicle (holdings won and lost, battles, starving, revolts, hires...).
 *   - The player answers a letter with the order `answerLetter {letter,
 *     choice}`; a gamble rolls once on the events stream, exactly as a K3a
 *     find does. No other story code ever rolls.
 *   - A contact with an armed encounter's host is the encounter: the battle
 *     takes the encounter's battlefield, captain and difficulty
 *     (descent.ts buildBattleSpec asks encounterFor).
 *   - Once an ending is reached the realm holds (world.ts tick): the chronicle
 *     is closed and nothing more can happen in it.
 *
 * Pure and deterministic: no DOM, no clock, no Math; iteration in table,
 * holding-id or province order; the only roll is the gamble's.
 */

import { KING_PLAYER, FACTIONS, FACTION_IDS, type FactionId } from "../../content/kingdom/factions.ts";
import { STOCK_IDS, type StockId } from "../../content/kingdom/economy.ts";
import type { AbilityId } from "../../content/abilities.ts";
import { ACTS } from "../../content/story/acts.ts";
import { STORY_LETTERS, type StoryChoice, type StoryOutcome } from "../../content/story/letters.ts";
import { ENCOUNTERS, type EncounterDef } from "../../content/story/encounters.ts";
import { ENCOUNTER_HOSTS } from "../../content/story/encounter-hosts.ts";
import { ENDINGS, type EndingDef, type StatRange } from "../../content/story/endings.ts";
import { CHRONICLE, type Happening } from "../../content/story/chronicle.ts";
import { MERCENARIES } from "../../content/story/mercenaries.ts";
import { MAX_ARMIES_PER_SIDE } from "../../content/kingdom/armies.ts";
import { STORY_REFUSAL } from "../../content/story/strings.ts";
import type { ActId, StoryCondition, StoryEffect } from "../../content/story/vocab.ts";
import type { KingdomOrder, KingdomOrderBody } from "./orders.ts";
import type { Army, Contact, Holding, KingdomEvent } from "./state.ts";
import { canAfford, credit, debitUpTo, pay } from "./ledger.ts";
import { changeLegitimacy, ownedBy } from "./economy.ts";
import { addUnrest, changeMercy } from "./morale.ts";
import { gainUpgrade, revealAround, updateSight } from "./explore.ts";
import { armiesOf, armyById, armyMen, raiseArmy, setPosture, standsIn } from "./armies.ts";
import { storyCompanyLeaves, storyHire, storyLoyalty } from "./mercenaries.ts";
import { DAYS_PER_SEASON } from "./clock.ts";
import type { KingdomWorld } from "./world.ts";

export type AnswerLetterBody = Extract<KingdomOrderBody, { kind: "answerLetter" }>;

/** An answered letter, as the chronicle and the save keep it. */
export type LetterAnswer = {
  /** Index in STORY_LETTERS. */
  readonly letter: number;
  readonly choice: number;
  readonly day: number;
  /** A gamble that went the other way. */
  readonly failed: boolean;
};

/** Hash and save order of an encounter's states. Append only. */
export const ENCOUNTER_STATES: readonly EncounterState["state"][] = ["idle", "armed", "won"];

/** A scripted encounter's progress, one per ENCOUNTERS row. */
export type EncounterState = {
  /** idle: not offered (or offered and declined); armed: its host stands waiting; won: it is done. */
  state: "idle" | "armed" | "won";
  /** The host's army id while armed, or 0. */
  host: number;
  /** Times fought, won or lost. */
  fought: number;
};

/**
 * One line of Brother Aldous's ledger. `key` names the content it is drawn
 * from (an act, a letter's answer, an encounter, a happening, an ending);
 * `params` fill its placeholders. Text is rendered at read time
 * (chronicleLine), so the save carries no prose.
 */
export type ChronicleEntry = {
  readonly day: number;
  readonly key: string;
  /** [name, value] pairs, sorted by name. */
  readonly params: readonly (readonly [string, string])[];
};

/** How the run ended in failure, for the end screen (docs/PROVISIONAL.md K9.6). */
export type FallCause = "captured" | "slain" | "capital";

export type StoryState = {
  act: ActId;
  /** Story flags set, sorted. */
  flags: string[];
  /** Letters waiting for an answer, indices into STORY_LETTERS, in the order they came. */
  pending: number[];
  /** Per STORY_LETTERS row: sent by its trigger (a trigger sends a letter once). */
  sent: boolean[];
  /** Every answer given, in the order given. */
  answers: LetterAnswer[];
  /** Letters due later (followUp), in the order scheduled. `day` is the day it comes. */
  followUps: { letter: number; day: number }[];
  /** Per ENCOUNTERS row. */
  encounters: EncounterState[];
  battlesWon: number;
  /** Factions the king has beaten in a battle, ascending. */
  beaten: number[];
  /** Factions sworn to the king (captainSworn), ascending. Their armies stand and their AI is off. */
  sworn: number[];
  /** Battle abilities the story has taught the king's armies (unlockAbility), in the order learned. */
  abilities: AbilityId[];
  winters: number;
  /** Per province (map order): held whole every day since its season began. */
  clean: boolean[];
  /** Per province: whole seasons held whole, running. */
  streak: number[];
  /** The king's holdings at the end of the last tick, ascending (for the chronicle's won and lost). */
  held: number[];
  /** The first holding the king ever held: the capital of the exile, or 0. */
  capital: number;
  /** Consecutive days the capital has not been the king's. */
  capitalLost: number;
  /** The king was captured or slain (B.12.5: the run ends). */
  kingLost: boolean;
  fall: FallCause | null;
  /** ENDINGS id once the story has ended, or null. */
  ending: string | null;
  endedDay: number;
  chronicle: ChronicleEntry[];
};

/** Days the capital of the exile may be held by another before the chronicle closes (PROVISIONAL K9.6). */
export const CAPITAL_LOST_DAYS = 30;

export function newStory(world: KingdomWorld): StoryState {
  return {
    act: 1,
    flags: [],
    pending: [],
    sent: STORY_LETTERS.map(() => false),
    answers: [],
    followUps: [],
    encounters: ENCOUNTERS.map(() => ({ state: "idle", host: 0, fought: 0 })),
    battlesWon: 0,
    beaten: [],
    sworn: [],
    abilities: [],
    winters: 0,
    clean: world.map.provinces.map(() => false),
    streak: world.map.provinces.map(() => 0),
    held: ownedBy(world, KING_PLAYER).map((h) => h.id),
    capital: 0,
    capitalLost: 0,
    kingLost: false,
    fall: null,
    ending: null,
    endedDay: 0,
    chronicle: [{ day: 0, key: "act:1:intro", params: [] }],
  };
}

// -- lookups --------------------------------------------------------------------------

export function letterIndex(id: string): number {
  return STORY_LETTERS.findIndex((l) => l.id === id);
}

export function encounterIndex(id: string): number {
  return ENCOUNTERS.findIndex((e) => e.id === id);
}

function companyIndex(id: string): number {
  return MERCENARIES.findIndex((m) => m.id === id);
}

function kingHoldings(world: KingdomWorld): Holding[] {
  return ownedBy(world, KING_PLAYER);
}

function seatOfProvince(world: KingdomWorld, province: string): Holding | undefined {
  const def = world.map.holdings.find((d) => d.province === province && d.seat === true);
  return def ? world.holdingByKey(def.key) : undefined;
}

/** The king holds every holding he owns in the province -- at least one, and its seat if it has one. */
function holdsWhole(world: KingdomWorld, province: string): boolean {
  let any = false;
  for (const h of world.holdings) if (h.province === province && h.owner === "king") { any = true; break; }
  if (!any) return false;
  const seat = seatOfProvince(world, province);
  return !seat || seat.owner === "king";
}

/** Whether the story is running in this realm and not yet over. */
export function storyLive(world: KingdomWorld): boolean {
  return world.story !== null && world.story.ending === null;
}

// -- conditions -----------------------------------------------------------------------

/**
 * The king's followers: the party's levy, and the men of it already formed
 * into levy squads of his armies -- a follower who takes up a spear is still
 * a follower (docs/PROVISIONAL.md K9.3), so forming the levy never undoes
 * Act I's "rally three followers".
 */
export function followers(world: KingdomWorld): number {
  let n = world.economy[KING_PLAYER].stocks.levy;
  for (const a of world.armies) {
    if (a.owner !== KING_PLAYER || a.company !== 0) continue;
    for (const q of a.squads) if (q.levy) n += q.men;
  }
  return n;
}

/** Evaluate a story condition against the kingdom. Pure: never rolls, never writes. */
export function holds(world: KingdomWorld, c: StoryCondition): boolean {
  const s = world.story;
  const e = world.economy[KING_PLAYER];
  switch (c.kind) {
    case "holdingsHeld": return kingHoldings(world).length >= c.n;
    case "holdingHeld": return world.holdingByKey(c.holding)?.owner === "king";
    case "seatHeld": return seatOfProvince(world, c.province)?.owner === "king";
    case "shareHeldAtLeast": return kingHoldings(world).length * 100 >= c.pct * world.holdings.length;
    case "followersAtLeast": return followers(world) >= c.n;
    case "legitimacyAtLeast": return e.legitimacy >= c.n;
    case "legitimacyBelow": return e.legitimacy < c.n;
    case "mercyAtLeast": return e.mercy >= c.n;
    case "mercyBelow": return e.mercy < c.n;
    case "captainDefeated": return !!s && s.beaten.includes(FACTION_IDS.indexOf(c.id));
    case "encounterFought": {
      const i = encounterIndex(c.encounter);
      return !!s && i >= 0 && s.encounters[i].fought > 0;
    }
    case "encounterWon": {
      const i = encounterIndex(c.encounter);
      return !!s && i >= 0 && s.encounters[i].state === "won";
    }
    case "holdRegionThroughSeason": {
      if (!s) return false;
      for (let p = 0; p < world.map.provinces.length; p++) {
        if (c.province !== "any" && world.map.provinces[p].id !== c.province) continue;
        if (s.streak[p] >= c.seasons) return true;
      }
      return false;
    }
    case "winterSurvived": return !!s && s.winters > 0;
    case "season": return world.date.season === c.season;
    case "daysPassed": return world.date.day >= c.n;
    case "battlesWon": return !!s && s.battlesWon >= c.n;
    case "wagesOwedDays": {
      for (const co of world.companies) {
        if (co.state !== "hired") continue;
        const a = armyById(world, co.army);
        if (a && a.unpaid >= c.n) return true;
      }
      return false;
    }
    case "companyHired": {
      const i = companyIndex(c.company);
      return i >= 0 && world.companies[i].state === "hired";
    }
    case "actAtLeast": return !!s && s.act >= c.act;
    case "roadToCrownSeat": {
      const seat = world.holdingByKey(world.map.crownSeat);
      if (!seat) return false;
      for (const r of world.roads) {
        const other = r.a === seat.id ? r.b : r.b === seat.id ? r.a : 0;
        if (other !== 0 && world.holding(other)?.owner === "king") return true;
      }
      return false;
    }
    case "rimarosTaken": return world.holdingByKey(world.map.crownSeat)?.owner === "king";
    case "kingLost": return !!s && s.kingLost;
    case "flag": return !!s && s.flags.includes(c.flag);
    case "notFlag": return !s || !s.flags.includes(c.flag);
    case "all": return c.of.every((x) => holds(world, x));
    case "any": return c.of.some((x) => holds(world, x));
  }
}

function inRange(v: number, r: StatRange): boolean {
  return (r.min === undefined || v >= r.min) && (r.below === undefined || v < r.below);
}

/** The crowned ending Legitimacy x Mercy gives now (the end screen's preview reads it too). */
export function crownedEnding(world: KingdomWorld): EndingDef {
  const e = world.economy[KING_PLAYER];
  for (const end of ENDINGS) {
    if (end.gate.kind === "crowned" && inRange(e.legitimacy, end.gate.legitimacy) && inRange(e.mercy, end.gate.mercy)) return end;
  }
  return ENDINGS[ENDINGS.length - 1];
}

// -- chronicle ------------------------------------------------------------------------

function write(world: KingdomWorld, key: string, params: Record<string, string> = {}): void {
  const s = world.story as StoryState;
  const pairs = Object.keys(params).sort().map((k) => [k, params[k]] as const);
  s.chronicle.push({ day: world.date.day, key, params: pairs });
  world.events.push({ kind: "chronicled", index: s.chronicle.length - 1 });
}

function happen(world: KingdomWorld, h: Happening, params: Record<string, string>, season?: string): void {
  if (!CHRONICLE.some((c) => c.happening === h && (season === undefined || c.season === season))) return;
  const entry = CHRONICLE.find((c) => c.happening === h && (season === undefined || c.season === season)) as (typeof CHRONICLE)[number];
  // A ledger, not a log: the same line is not written twice in a week (one
  // battle reports itself from both sides; a rally brings followers every
  // day), and a famine is written once a day for the realm, not once a town.
  const key = "happening:" + entry.id;
  const pairs = Object.keys(params).sort().map((k) => k + "=" + params[k]).join("&");
  const s = world.story as StoryState;
  for (let i = s.chronicle.length - 1; i >= 0 && s.chronicle[i].day > world.date.day - 7; i--) {
    const c = s.chronicle[i];
    if (c.key !== key) continue;
    if (h === "famine" && c.day === world.date.day) return;
    if (c.params.map(([k, v]) => k + "=" + v).join("&") === pairs) return;
  }
  write(world, key, params);
}

function captainName(f: number): string {
  const id = FACTION_IDS[f];
  return id ? FACTIONS[id].name : "the crown";
}

function fill(text: string, params: readonly (readonly [string, string])[], king: string): string {
  let out = text.split("{king}").join(king);
  for (const [k, v] of params) out = out.split("{" + k + "}").join(v);
  return out;
}

/** One ledger line as the chronicle screen shows it: a title and its text, placeholders filled. Pure. */
export function chronicleLine(entry: ChronicleEntry, king: string): { title: string; text: string } {
  const [kind, id, part] = entry.key.split(":");
  if (kind === "act") {
    const act = ACTS[Number(id) - 1];
    const t = part === "intro" ? act.intro : act.transition;
    return { title: t.title, text: fill(t.text, entry.params, king) };
  }
  if (kind === "letter") {
    const l = STORY_LETTERS[letterIndex(id)];
    const c = l.choices[Number(part)];
    const failed = entry.params.some(([k, v]) => k === "failed" && v === "1");
    const o: StoryOutcome = failed && c.chance ? c.chance.fail : c;
    return { title: l.title, text: fill(o.result, entry.params, king) };
  }
  if (kind === "letterIn") {
    const l = STORY_LETTERS[letterIndex(id)];
    return { title: l.title, text: "A letter from " + l.from + "." };
  }
  if (kind === "encounter") {
    const e = ENCOUNTERS[encounterIndex(id)];
    return { title: part === "won" ? "Victory" : "Defeat", text: fill(part === "won" ? e.won : e.lost, entry.params, king) };
  }
  if (kind === "happening") {
    const c = CHRONICLE.find((x) => x.id === id);
    if (!c) return { title: "", text: "" };
    // The variant is the day modulo the count: no roll (chronicle.ts).
    const v = c.variants[entry.day % c.variants.length];
    return { title: "", text: fill(v, entry.params, king) };
  }
  if (kind === "ending") {
    const end = ENDINGS.find((x) => x.id === id);
    return { title: end ? end.title : "", text: "" };
  }
  return { title: "", text: "" };
}

// -- effects --------------------------------------------------------------------------

/** What a choice costs up front: its `pay` effects summed. */
export function storyChoiceCost(effects: readonly StoryEffect[]): Partial<Record<StockId, number>> {
  const out: Partial<Record<StockId, number>> = {};
  for (const e of effects) {
    if (e.kind !== "pay") continue;
    for (const st of STOCK_IDS) if (e.cost[st]) out[st] = (out[st] ?? 0) + (e.cost[st] as number);
  }
  return out;
}

function addFlag(s: StoryState, f: string): void {
  if (s.flags.includes(f)) return;
  s.flags.push(f);
  s.flags.sort();
}

function kingAt(world: KingdomWorld): number {
  const m = world.king.mover;
  return m.road === 0 ? m.node : 0;
}

function applyEffect(world: KingdomWorld, fx: StoryEffect): void {
  const s = world.story as StoryState;
  const k = KING_PLAYER;
  const e = world.economy[k];
  const book = world.books[k];
  switch (fx.kind) {
    case "pay": return; // paid up front
    case "gain":
      for (const st of STOCK_IDS) credit(e, book, st, fx.gains[st] ?? 0, "finds");
      world.events.push({ kind: "stocksChanged", faction: k });
      return;
    case "lose":
      for (const st of STOCK_IDS) debitUpTo(e, book, st, fx.loss[st] ?? 0, "offerings");
      world.events.push({ kind: "stocksChanged", faction: k });
      return;
    case "legitimacy":
      changeLegitimacy(world, k, fx.delta, fx.delta >= 0 ? "deeds" : "disgrace");
      world.events.push({ kind: "stocksChanged", faction: k });
      return;
    case "upgrade":
      gainUpgrade(world, k, fx.upgrade, kingAt(world));
      return;
    case "reveal": {
      const p = world.kingPosition();
      const found = revealAround(world, k, p.x, p.y, fx.miles);
      world.events.push({ kind: "revealed", faction: k, site: kingAt(world), holdings: found });
      return;
    }
    case "mercy": changeMercy(world, k, fx.delta); return;
    case "flag": addFlag(s, fx.flag); return;
    case "unflag": {
      const i = s.flags.indexOf(fx.flag);
      if (i >= 0) s.flags.splice(i, 1);
      return;
    }
    case "unlockAbility":
      if (!s.abilities.includes(fx.ability)) s.abilities.push(fx.ability);
      world.events.push({ kind: "storyAbility", ability: fx.ability });
      return;
    case "hire": {
      const i = companyIndex(fx.company);
      if (i >= 0) storyHire(world, i);
      return;
    }
    case "companyLeaves": {
      const i = companyIndex(fx.company);
      if (i >= 0) storyCompanyLeaves(world, i, fx.how);
      return;
    }
    case "loyalty": {
      const i = companyIndex(fx.company);
      if (i >= 0) storyLoyalty(world, i, fx.delta);
      return;
    }
    case "battle": armEncounter(world, encounterIndex(fx.encounter)); return;
    case "giveHolding": {
      const h = world.holdingByKey(fx.holding);
      if (h && h.owner !== "king") giveTo(world, h, k);
      return;
    }
    case "loseHolding": {
      const h = world.holdingByKey(fx.holding);
      if (!h || h.owner !== "king") return;
      if (fx.to === null) {
        h.owner = null;
        h.garrison = [];
      } else giveTo(world, h, FACTION_IDS.indexOf(fx.to));
      return;
    }
    case "unrest":
      // The story's unrest is whole points of the K6 0..100 scale; the sim keeps permille.
      for (const h of world.holdings) {
        if (h.owner !== "king" || (fx.province !== "any" && h.province !== fx.province)) continue;
        addUnrest(world, h, fx.delta * 10);
      }
      return;
    case "captainSworn": {
      const f = FACTION_IDS.indexOf(fx.faction);
      if (f < 0 || s.sworn.includes(f)) return;
      s.sworn.push(f);
      s.sworn.sort((a, b) => a - b);
      // The captain's field armies stand where they are (their AI is off, ai.ts), and stop fighting the king.
      for (const a of world.armies) if (a.owner === f) { a.mover.route = []; a.target = 0; a.mergeInto = false; }
      happen(world, "captainSworn", { captain: captainName(f), king: world.king.name });
      return;
    }
    case "followUp": {
      const i = letterIndex(fx.letter);
      if (i >= 0) s.followUps.push({ letter: i, day: world.date.day + fx.days });
      return;
    }
  }
}

/** A holding goes to a faction by the story's word (a gate opened, an encounter won): no battle. */
function giveTo(world: KingdomWorld, h: Holding, f: number): void {
  if (f < 0) return;
  const fid = FACTION_IDS[f] as FactionId;
  h.owner = fid;
  h.garrison = [];
  h.tax = world.economy[f].defaultTax;
  h.taxCarry = 0;
  h.doleCarry = 0;
  h.famine = 0;
  h.festival = 0;
  if (f === KING_PLAYER) for (const p of h.plots) p.auto = world.economy[f].autoSow;
  world.events.push({ kind: "claimed", holding: h.id, faction: f });
  updateSight(world, f);
}

// -- encounters -----------------------------------------------------------------------

/** Raise (or keep) an encounter's host at its holding: dug in, out of its captain's AI. */
function armEncounter(world: KingdomWorld, i: number): void {
  const s = world.story as StoryState;
  if (i < 0) return;
  const st = s.encounters[i];
  if (st.state === "won") return;
  st.state = "armed";
  standHost(world, i);
  world.events.push({ kind: "encounterArmed", encounter: i });
}

function standHost(world: KingdomWorld, i: number): void {
  const s = world.story as StoryState;
  const st = s.encounters[i];
  if (st.host !== 0 && armyById(world, st.host)) return;
  st.host = 0;
  const def = ENCOUNTERS[i];
  const h = world.holdingByKey(def.holding);
  const f = FACTION_IDS.indexOf(def.faction);
  const units = ENCOUNTER_HOSTS[def.id];
  if (!h || f < 0 || !units) return;
  // A faction at its cap of armies cannot field one more: the encounter
  // waits, armed, and its host is raised the first day there is room.
  if (armiesOf(world, f).length >= MAX_ARMIES_PER_SIDE) return;
  const a = raiseArmy(world, f, h.id, units);
  a.name = def.id === "crown-siege" ? "the Chancery Guard" : "the host at " + h.name;
  // A full season's bread, so a host left waiting does not starve away its encounter.
  a.supply = armyMen(a) * DAYS_PER_SEASON;
  setPosture(world, a, "hold");
  st.host = a.id;
}

/** Is this army an encounter's host (its captain's AI leaves it alone)? */
export function isStoryHost(world: KingdomWorld, army: number): boolean {
  const s = world.story;
  if (!s) return false;
  for (const e of s.encounters) if (e.state === "armed" && e.host === army) return true;
  return false;
}

/** Is this faction sworn to the king (its AI is off)? */
export function isSworn(world: KingdomWorld, faction: number): boolean {
  return !!world.story && world.story.sworn.includes(faction);
}

/** Should an AI order be dropped: it moves a story host, or comes from a sworn captain. */
export function storyHoldsAi(world: KingdomWorld, faction: number, body: KingdomOrderBody): boolean {
  if (!world.story) return false;
  if (isSworn(world, faction)) return true;
  const army = (body as { army?: number }).army;
  return typeof army === "number" && isStoryHost(world, army);
}

/**
 * The encounter a contact is, or null: the king's side meeting the host of an
 * armed encounter (in the field or at its walls), or storming the encounter's
 * holding while it is armed. descent.ts gives the battle its battlefield,
 * captain and difficulty from it.
 */
export function encounterFor(world: KingdomWorld, c: Contact): EncounterDef | null {
  const s = world.story;
  if (!s || c.sides[0].faction !== KING_PLAYER) return null;
  for (let i = 0; i < ENCOUNTERS.length; i++) {
    const st = s.encounters[i];
    if (st.state !== "armed") continue;
    const def = ENCOUNTERS[i];
    const h = world.holdingByKey(def.holding);
    const enemy = c.sides[1];
    if (st.host !== 0 && enemy.army === st.host) return def;
    if (h && c.holding === h.id && enemy.faction === FACTION_IDS.indexOf(def.faction)) return def;
  }
  return null;
}

/** The battle abilities the story has taught the king's armies (descent.ts sideOf adds them). */
export function storyAbilities(world: KingdomWorld): readonly AbilityId[] {
  return world.story ? world.story.abilities : [];
}

/**
 * A contact of the king's side is about to be settled by an order. Returns
 * what the story needs to know afterwards (who was where, how many men).
 */
export function beforeContactOrder(world: KingdomWorld): { c: Contact; men: number; enc: number } | null {
  if (!world.story || !world.contact) return null;
  const c = world.contact;
  const a = armyById(world, c.sides[0].army);
  const def = encounterFor(world, c);
  return { c, men: a ? armyMen(a) : 0, enc: def ? ENCOUNTERS.indexOf(def) : -1 };
}

/** The contact snapshotted by beforeContactOrder was settled (or not) by the order just applied. */
export function afterContactOrder(world: KingdomWorld, was: { c: Contact; men: number; enc: number } | null): void {
  if (!was || world.contact?.id === was.c.id) return;
  const s = world.story as StoryState;
  const done = world.events.find((e): e is Extract<KingdomEvent, { kind: "contactResolved" }> => e.kind === "contactResolved" && e.contact === was.c.id);
  if (!done || done.how === "withdraw") return;
  const h = world.holding(was.c.holding) as Holding;
  const enemy = was.c.sides[1].faction;
  const won = done.winner === 0;
  const a = armyById(world, was.c.sides[0].army);
  const after = a ? armyMen(a) : 0;
  const params = {
    holding: h.name, captain: captainName(enemy),
    fallen: String(was.men > after ? was.men - after : 0), survivors: String(after),
  };
  if (won) {
    s.battlesWon++;
    if (!s.beaten.includes(enemy)) { s.beaten.push(enemy); s.beaten.sort((x, y) => x - y); }
  }
  if (was.enc < 0) {
    happen(world, won ? "battleWon" : "battleLost", params);
    return;
  }
  const def = ENCOUNTERS[was.enc];
  const st = s.encounters[was.enc];
  st.fought++;
  write(world, "encounter:" + def.id + ":" + (won ? "won" : "lost"), params);
  world.events.push({ kind: "encounterFought", encounter: was.enc, won });
  if (won) {
    st.state = "won";
    st.host = 0;
    // The field is the king's, and the holding it was fought for opens to him
    // (docs/PROVISIONAL.md K9.4): the Hare's riders gone from Hareford, the
    // Chancery Guard broken in Rimaros.
    const at = world.holdingByKey(def.holding);
    const f = FACTION_IDS.indexOf(def.faction);
    if (at && at.owner !== "king" && (at.owner === null || FACTION_IDS.indexOf(at.owner) === f)) giveTo(world, at, KING_PLAYER);
    for (const fx of def.wonEffects) applyEffect(world, fx);
  } else {
    for (const fx of def.lostEffects) applyEffect(world, fx);
  }
}

// -- letters --------------------------------------------------------------------------

/** The choices of a waiting letter the king may pick now (requires holds), as indices. */
export function offeredChoices(world: KingdomWorld, letter: number): number[] {
  const l = STORY_LETTERS[letter];
  const out: number[] = [];
  if (!l) return out;
  for (let i = 0; i < l.choices.length; i++) {
    const c = l.choices[i];
    if (!c.requires || holds(world, c.requires)) out.push(i);
  }
  return out;
}

/** Why `answerLetter {letter, choice}` would be refused now, or null. The letter card asks this too. */
export function checkAnswer(world: KingdomWorld, body: { letter: number; choice: number }, player: number): string | null {
  const s = world.story;
  if (!s || s.ending !== null) return STORY_REFUSAL.noStory;
  if (player !== KING_PLAYER) return STORY_REFUSAL.notYours;
  if (!s.pending.includes(body.letter)) return STORY_REFUSAL.noSuchLetter;
  const l = STORY_LETTERS[body.letter];
  if (!Number.isInteger(body.choice) || body.choice < 0 || body.choice >= l.choices.length) return STORY_REFUSAL.noSuchChoice;
  const c: StoryChoice = l.choices[body.choice];
  if (c.requires && !holds(world, c.requires)) return STORY_REFUSAL.notOffered;
  if (!canAfford(world.economy[KING_PLAYER], storyChoiceCost(c.effects))) return STORY_REFUSAL.cannotPay;
  return null;
}

/**
 * Answer a letter (checked first). The price is paid, ONE roll on the events
 * stream decides a gamble, then the outcome's effects apply in their order --
 * the same contract as a K3a find (explore.ts applyResolve).
 */
export function applyAnswer(world: KingdomWorld, order: KingdomOrder & AnswerLetterBody): string | null {
  const why = checkAnswer(world, order, order.player);
  if (why) return why;
  const s = world.story as StoryState;
  const l = STORY_LETTERS[order.letter];
  const c = l.choices[order.choice];
  pay(world.economy[KING_PLAYER], world.books[KING_PLAYER], storyChoiceCost(c.effects), "offerings");
  let outcome: StoryOutcome = c;
  let failed = false;
  if (c.chance && world.rng.events.int(100) >= c.chance.pct) {
    outcome = c.chance.fail;
    failed = true;
  }
  s.pending.splice(s.pending.indexOf(order.letter), 1);
  s.answers.push({ letter: order.letter, choice: order.choice, day: world.date.day, failed });
  write(world, "letter:" + l.id + ":" + order.choice, failed ? { failed: "1" } : {});
  world.events.push({ kind: "letterAnswered", letter: order.letter, choice: order.choice, failed });
  for (const fx of outcome.effects) applyEffect(world, fx);
  world.events.push({ kind: "stocksChanged", faction: KING_PLAYER });
  return null;
}

function send(world: KingdomWorld, i: number): void {
  const s = world.story as StoryState;
  if (s.pending.includes(i)) return;
  s.pending.push(i);
  write(world, "letterIn:" + STORY_LETTERS[i].id);
  world.events.push({ kind: "letterArrived", letter: i });
}

// -- the day --------------------------------------------------------------------------

/**
 * The story's day, once a day after the mercenaries' (world.ts): the season's
 * bookkeeping, letters due and letters triggered, encounter hosts kept
 * standing, the act's goals, and the two ways the chronicle can close.
 */
export function runStoryDay(world: KingdomWorld): void {
  const s = world.story;
  if (!s || s.ending !== null) return;
  const d = world.date;

  // Seasons: a winter ends on the first day of spring; a province held whole
  // from a season's first day to its last counts one more season held.
  if (d.dayOfSeason === 0 && d.day > 0) {
    if (d.season === "spring") s.winters++;
    for (let p = 0; p < s.clean.length; p++) if (s.clean[p]) s.streak[p]++;
    happen(world, "seasonTurns", { year: String(d.year) }, d.season);
  }
  for (let p = 0; p < world.map.provinces.length; p++) {
    const whole = holdsWhole(world, world.map.provinces[p].id);
    if (d.dayOfSeason === 0) s.clean[p] = whole;
    else if (!whole) s.clean[p] = false;
    if (!whole) s.streak[p] = 0;
  }

  // Letters: follow-ups due, in the order scheduled; then triggers, in table order.
  for (let i = 0; i < s.followUps.length;) {
    if (s.followUps[i].day <= d.day) {
      send(world, s.followUps[i].letter);
      s.followUps.splice(i, 1);
    } else i++;
  }
  for (let i = 0; i < STORY_LETTERS.length; i++) {
    const l = STORY_LETTERS[i];
    if (s.sent[i] || l.trigger === null || l.act > s.act) continue;
    if (!holds(world, l.trigger)) continue;
    s.sent[i] = true;
    send(world, i);
  }

  // A waiting encounter keeps a host standing.
  for (let i = 0; i < s.encounters.length; i++) if (s.encounters[i].state === "armed") standHost(world, i);

  // The capital of the exile: the first holding he held.
  if (s.capital === 0) s.capital = s.held[0] ?? 0;
  if (s.capital !== 0) s.capitalLost = world.holding(s.capital)?.owner === "king" ? 0 : s.capitalLost + 1;

  // The act's goals, all at once; the fourth act's end is the coronation.
  const act = ACTS[s.act - 1];
  if (act.goals.every((g) => holds(world, g.condition))) {
    write(world, "act:" + s.act + ":end");
    if (s.act < 4) {
      s.act = (s.act + 1) as ActId;
      write(world, "act:" + s.act + ":intro");
      world.events.push({ kind: "actBegan", act: s.act });
    } else {
      return end(world, crownedEnding(world).id);
    }
  }

  checkFailure(world);
}

function checkFailure(world: KingdomWorld): void {
  const s = world.story as StoryState;
  if (s.ending !== null) return;
  if (!s.kingLost && s.capitalLost >= CAPITAL_LOST_DAYS) {
    s.kingLost = true;
    s.fall = "capital";
  }
  if (s.kingLost) {
    const fallen = ENDINGS.find((e) => e.gate.kind === "failure" && holds(world, e.gate.condition));
    if (fallen) end(world, fallen.id);
  }
}

function end(world: KingdomWorld, id: string): void {
  const s = world.story as StoryState;
  s.ending = id;
  s.endedDay = world.date.day;
  s.pending = [];
  s.followUps = [];
  write(world, "ending:" + id);
  world.events.push({ kind: "storyEnded", ending: id });
}

/**
 * The end of every tick (world.ts, also while a contact holds the realm): the
 * tick's events go into the chronicle, the king's holdings are compared with
 * the last tick's, and the king's own fall is noticed at once. `kingArmy` is
 * the army he rode with when the tick began (removeArmy leaves him standing
 * alone before this runs).
 */
export function storyTickEnd(world: KingdomWorld, kingArmy: number): void {
  const s = world.story;
  if (!s || s.ending !== null) return;
  const k = KING_PLAYER;
  for (const ev of [...world.events]) {
    switch (ev.kind) {
      case "armyGone": {
        if (kingArmy !== 0 && ev.army === kingArmy && (ev.reason === "fell" || ev.reason === "captured")) {
          s.kingLost = true;
          s.fall = ev.reason === "fell" ? "slain" : "captured";
        } else if (ev.owner === k && ev.reason === "starved") {
          happen(world, "armyStarved", { army: ev.name, holding: placeName(world), days: "" });
        }
        break;
      }
      case "companyLeft": {
        const name = MERCENARIES[ev.company]?.name ?? "";
        if (ev.how === "deserted") happen(world, "mercenariesDesert", { company: name, days: "" });
        else if (ev.how === "defected" || ev.how === "poached") happen(world, "companyDefects", { company: name, captain: "the crown" });
        break;
      }
      case "companyHired":
        happen(world, "companyHired", { company: MERCENARIES[ev.company]?.name ?? "" });
        break;
      case "rallied":
        if (ev.followers > 0) happen(world, "followersJoin", { holding: world.holding(ev.holding)?.name ?? "", king: world.king.name });
        break;
      case "famine":
        if (ev.faction === k && ev.holding > 0 && ev.days === 1) happen(world, "famine", { holding: world.holding(ev.holding)?.name ?? "", days: "1" });
        break;
      case "revolt": {
        if (ev.from !== k) break;
        const h = world.holding(ev.holding) as Holding;
        const prov = world.map.provinces.find((p) => p.id === h.province);
        happen(world, "revolt", { holding: h.name, province: prov ? prov.name : "" });
        break;
      }
      case "rumour": {
        const t = world.holding(ev.target);
        happen(world, "invasionWarned", { captain: captainName(ev.owner), holding: t ? t.name : "", days: String(ev.days) });
        break;
      }
      case "eventResolved":
        if (ev.faction === k) happen(world, "siteExplored", { holding: world.holding(ev.site)?.name ?? "" });
        break;
      default:
        break;
    }
  }
  // Holdings won and lost since the last tick, in holding-id order.
  const now = kingHoldings(world).map((h) => h.id);
  for (const id of now) {
    if (s.held.includes(id)) continue;
    happen(world, "holdingClaimed", { king: world.king.name, holding: (world.holding(id) as Holding).name });
  }
  for (const id of s.held) {
    if (now.includes(id)) continue;
    const h = world.holding(id) as Holding;
    happen(world, "holdingLost", { holding: h.name, captain: h.owner ? FACTIONS[h.owner].name : "nobody" });
  }
  s.held = now;
  if (s.capital === 0 && now.length > 0) s.capital = now[0];
  checkFailure(world);
}

function placeName(world: KingdomWorld): string {
  const at = kingAt(world);
  return at ? (world.holding(at) as Holding).name : "the road";
}

/** For the act panel: each goal of the current act and whether it holds now. */
export function actProgress(world: KingdomWorld): { text: string; done: boolean }[] {
  const s = world.story;
  if (!s) return [];
  return ACTS[s.act - 1].goals.map((g) => ({ text: g.text, done: holds(world, g.condition) }));
}

/** An army of the king's that is gone (for tests): unused armies are never read. */
export function kingArmyOf(world: KingdomWorld): Army | undefined {
  return armyById(world, world.king.army);
}

/** Where an encounter's host stands now (the map marks it), or 0. */
export function encounterHostAt(world: KingdomWorld, i: number): number {
  const s = world.story;
  if (!s) return 0;
  const a = armyById(world, s.encounters[i].host);
  return a ? standsIn(a.mover) : 0;
}
