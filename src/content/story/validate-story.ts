/**
 * Validation of the story (phase K9 content): the cutscene, the acts, the
 * letters, the encounters, the free companies, the chronicle, the endings and
 * the tutorial, against each other and against the map, the factions, the
 * levels, the old campaign and the abilities they name.
 *
 * Like content/kingdom/validate.ts and ./validate.ts, it lives with the
 * content so a bad edit fails `npm test` (tools/story-check.ts) before K9's
 * evaluator is ever handed it. Every function returns a list of problems;
 * empty means valid.
 *
 * What "valid" means here, beyond ids existing:
 *   - every act can be FINISHED with the story's own content: each goal's
 *     flags are set by something in that act or before, each encounter it
 *     needs is offered by a letter, and the legitimacy it asks for can be
 *     earned from letters and battles alone (a lower bound on the real game,
 *     where buildings and upgrades add more);
 *   - a letter that offers a battle an act depends on never dead-ends: each of
 *     its choices fights it or follows up to a letter that does;
 *   - every crowned ending is reachable from where the story can leave the
 *     king when Act IV begins, and the crowned endings' thresholds cover the
 *     whole (legitimacy, mercy) plane exactly once;
 *   - every story flag is declared, set by something, and read by something;
 *   - the tutorial teaches every control (all fourteen battle gestures, every
 *     glyph, every kingdom pen order, the camera in each layer, the clock);
 *   - and no story string guesses anyone's gender.
 */

import { ABILITY_IDS } from "../abilities.ts";
import { CHAPTERS, chapterById } from "../campaign.ts";
import { COMMANDER_IDS } from "../commanders.ts";
import { companyName } from "../companies.ts";
import { DIFFICULTY_IDS } from "../difficulty.ts";
import { levelById } from "../levels/index.ts";
import { UNIT_TYPE_IDS } from "../unit-types.ts";
import { KING_START_LEGITIMACY, LEGITIMACY_MAX } from "../kingdom/economy.ts";
import { FACTION_IDS, type FactionId } from "../kingdom/factions.ts";
import { RIMAROS, type KingdomMapDef } from "../kingdom/map.ts";
import { BIOMES, SEASONS } from "../kingdom/terrain.ts";
import { effectProblems } from "./validate.ts";
import {
  ACT_IDS, LETTER_PLACEHOLDERS, MERCY_MAX, MERCY_MIN, MERCY_START, STORY_EFFECT_KINDS,
  type ActId, type StoryCondition, type StoryEffect,
} from "./vocab.ts";
import { STORY_FLAGS } from "./flags.ts";
import { ACTS, type ActDef } from "./acts.ts";
import { STORY_LETTERS, type StoryLetterDef, type StoryChoice } from "./letters.ts";
import { ENCOUNTERS, type EncounterDef } from "./encounters.ts";
import { MERCENARIES, type MercenaryDef } from "./mercenaries.ts";
import { CHRONICLE, CHRONICLE_PARAMS, type ChronicleEntryDef, type Happening } from "./chronicle.ts";
import { ENDINGS, type EndingDef, type StatRange } from "./endings.ts";
import { CUTSCENE, CUTSCENE_PROPS, type CutsceneBeat } from "./cutscene.ts";
import {
  BATTLE_GESTURE_CLASSES, GLYPH_SHAPES, KINGDOM_PEN_CLASSES, TUTORIAL, TUTORIAL_LESSONS, TUTORIAL_UI_ACTIONS,
  type TutorialLesson, type TutorialStep,
} from "./tutorial.ts";

/** The whole story, as one value, so tests can hand the validators a broken copy. */
export type StoryContent = {
  readonly map: KingdomMapDef;
  readonly flags: Readonly<Record<string, string>>;
  readonly acts: readonly ActDef[];
  readonly letters: readonly StoryLetterDef[];
  readonly encounters: readonly EncounterDef[];
  readonly mercenaries: readonly MercenaryDef[];
  readonly chronicle: readonly ChronicleEntryDef[];
  readonly endings: readonly EndingDef[];
  readonly cutscene: { readonly beats: readonly CutsceneBeat[]; readonly skippable: boolean };
  readonly tutorial: readonly TutorialStep[];
  readonly lessons: readonly TutorialLesson[];
};

export const STORY: StoryContent = {
  map: RIMAROS, flags: STORY_FLAGS, acts: ACTS, letters: STORY_LETTERS, encounters: ENCOUNTERS,
  mercenaries: MERCENARIES, chronicle: CHRONICLE, endings: ENDINGS, cutscene: CUTSCENE,
  tutorial: TUTORIAL, lessons: TUTORIAL_LESSONS,
};

// -- text helpers ---------------------------------------------------------------------

/**
 * How many sentences a line holds: a break after . ! ? (and any closing
 * quote or bracket) followed by white space. Good enough for this prose,
 * which has no abbreviations with full stops in it.
 */
export function sentenceCount(s: string): number {
  return s.split(/(?<=[.!?])["')\]]*\s+/).filter((p) => p.trim().length > 0).length;
}

/** The {placeholders} a line uses. */
export function placeholdersOf(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/\{(\w+)\}/g)) out.push(m[1]);
  return out;
}

/** The house rule: no gendered pronoun or title for anyone (as tools/kingdom-explore.ts). */
export const GENDERED = /\b(he|she|him|her|hers|his|himself|herself|man|woman|monk|nun|lord|lady|sire|madam|queen)\b/i;

// -- walking conditions and effects -------------------------------------------------------

function eachCondition(c: StoryCondition, f: (c: StoryCondition) => void): void {
  f(c);
  if (c.kind === "all" || c.kind === "any") for (const d of c.of) eachCondition(d, f);
}

function choiceOutcomes(c: StoryChoice): { result: string; effects: readonly StoryEffect[] }[] {
  return c.chance ? [c, c.chance.fail] : [c];
}

function letterEffects(l: StoryLetterDef): StoryEffect[] {
  return l.choices.flatMap((c) => choiceOutcomes(c).flatMap((o) => o.effects));
}

function legitimacyOf(effects: readonly StoryEffect[]): number {
  let n = 0;
  for (const e of effects) if (e.kind === "legitimacy") n += e.delta;
  return n;
}

function mercyOf(effects: readonly StoryEffect[]): number {
  let n = 0;
  for (const e of effects) if (e.kind === "mercy") n += e.delta;
  return n;
}

// -- the context every check reads ---------------------------------------------------------

type Ctx = {
  readonly s: StoryContent;
  readonly holdings: ReadonlySet<string>;
  readonly provinces: ReadonlySet<string>;
  readonly seatProvinces: ReadonlySet<string>;
  readonly letters: ReadonlyMap<string, StoryLetterDef>;
  readonly encounters: ReadonlyMap<string, EncounterDef>;
  readonly companies: ReadonlySet<string>;
};

function context(s: StoryContent): Ctx {
  return {
    s,
    holdings: new Set(s.map.holdings.map((h) => h.key)),
    provinces: new Set(s.map.provinces.map((p) => p.id)),
    seatProvinces: new Set(s.map.holdings.filter((h) => h.seat).map((h) => h.province)),
    letters: new Map(s.letters.map((l) => [l.id, l])),
    encounters: new Map(s.encounters.map((e) => [e.id, e])),
    companies: new Set(s.mercenaries.map((m) => m.id)),
  };
}

const whole = (n: number, lo: number, hi: number): boolean => Number.isInteger(n) && n >= lo && n <= hi;
const isFaction = (f: string): f is FactionId => (FACTION_IDS as readonly string[]).includes(f);

function conditionProblems(where: string, c: StoryCondition, x: Ctx): string[] {
  const p: string[] = [];
  eachCondition(c, (d) => {
    switch (d.kind) {
      case "holdingsHeld": if (!whole(d.n, 1, x.s.map.holdings.length)) p.push(where + ": holdingsHeld must be 1.." + x.s.map.holdings.length); break;
      case "holdingHeld": if (!x.holdings.has(d.holding)) p.push(where + ": unknown holding " + d.holding); break;
      case "seatHeld": if (!x.seatProvinces.has(d.province)) p.push(where + ": province " + d.province + " has no seat"); break;
      case "shareHeldAtLeast": if (!whole(d.pct, 1, 100)) p.push(where + ": a share is 1..100 %"); break;
      case "followersAtLeast": case "battlesWon": case "wagesOwedDays": if (!whole(d.n, 1, 10000)) p.push(where + ": " + d.kind + " must be a whole number >= 1"); break;
      case "daysPassed": if (!whole(d.n, 0, 100000)) p.push(where + ": daysPassed must be a whole number >= 0"); break;
      case "legitimacyAtLeast": case "legitimacyBelow": if (!whole(d.n, 0, LEGITIMACY_MAX)) p.push(where + ": legitimacy is 0.." + LEGITIMACY_MAX); break;
      case "mercyAtLeast": case "mercyBelow": if (!whole(d.n, MERCY_MIN, MERCY_MAX)) p.push(where + ": mercy is " + MERCY_MIN + ".." + MERCY_MAX); break;
      case "captainDefeated":
        if (!isFaction(d.id) || d.id === "king") p.push(where + ": " + d.id + " is not an enemy faction");
        else if (!x.s.encounters.some((e) => e.faction === d.id)) p.push(where + ": no encounter is ever fought against " + d.id);
        break;
      case "encounterFought": case "encounterWon": if (!x.encounters.has(d.encounter)) p.push(where + ": unknown encounter " + d.encounter); break;
      case "holdRegionThroughSeason":
        if (d.province !== "any" && !x.provinces.has(d.province)) p.push(where + ": unknown province " + d.province);
        if (!whole(d.seasons, 1, 4)) p.push(where + ": hold a region 1..4 seasons");
        break;
      case "season": if (!SEASONS.includes(d.season)) p.push(where + ": unknown season " + d.season); break;
      case "companyHired": if (!x.companies.has(d.company)) p.push(where + ": unknown company " + d.company); break;
      case "actAtLeast": if (!ACT_IDS.includes(d.act)) p.push(where + ": unknown act " + d.act); break;
      case "flag": case "notFlag": if (!(d.flag in x.s.flags)) p.push(where + ": undeclared flag " + d.flag); break;
      case "all": case "any": if (d.of.length === 0) p.push(where + ": an empty " + d.kind); break;
      case "winterSurvived": case "roadToCrownSeat": case "rimarosTaken": case "kingLost": break;
    }
  });
  return p;
}

function storyEffectProblems(where: string, e: StoryEffect, x: Ctx): string[] {
  const p: string[] = [];
  switch (e.kind) {
    case "gain": case "pay": case "lose": case "legitimacy": case "upgrade": case "reveal":
      return effectProblems(where, e);
    case "mercy": if (!(whole(e.delta, -10, 10) && e.delta !== 0)) p.push(where + ": mercy moves by a whole 1..10 either way"); break;
    case "flag": case "unflag": if (!(e.flag in x.s.flags)) p.push(where + ": undeclared flag " + e.flag); break;
    case "unlockAbility": if (!(ABILITY_IDS as readonly string[]).includes(e.ability)) p.push(where + ": unknown ability " + e.ability); break;
    case "hire": case "companyLeaves": if (!x.companies.has(e.company)) p.push(where + ": unknown company " + e.company); break;
    case "loyalty":
      if (!x.companies.has(e.company)) p.push(where + ": unknown company " + e.company);
      if (!(whole(e.delta, -50, 50) && e.delta !== 0)) p.push(where + ": loyalty moves by a whole 1..50 either way");
      break;
    case "battle": if (!x.encounters.has(e.encounter)) p.push(where + ": unknown encounter " + e.encounter); break;
    case "giveHolding": if (!x.holdings.has(e.holding)) p.push(where + ": unknown holding " + e.holding); break;
    case "loseHolding":
      if (!x.holdings.has(e.holding)) p.push(where + ": unknown holding " + e.holding);
      if (e.to !== null && (!isFaction(e.to) || e.to === "king")) p.push(where + ": a holding is lost to an enemy faction or to nobody");
      break;
    case "unrest":
      if (e.province !== "any" && !x.provinces.has(e.province)) p.push(where + ": unknown province " + e.province);
      if (!(whole(e.delta, -20, 20) && e.delta !== 0)) p.push(where + ": unrest moves by a whole 1..20 either way");
      break;
    case "captainSworn": if (!isFaction(e.faction) || e.faction === "king" || e.faction === "usurper") p.push(where + ": only a captain or the Margrave can swear to the king"); break;
    case "followUp":
      if (!x.letters.has(e.letter)) p.push(where + ": follow-up to unknown letter " + e.letter);
      if (!whole(e.days, 1, 120)) p.push(where + ": a follow-up comes 1..120 days later");
      break;
    default: {
      const never: never = e;
      p.push(where + ": unknown effect " + JSON.stringify(never));
    }
  }
  return p;
}

function textProblems(where: string, text: string, maxSentences: number, allowed: readonly string[]): string[] {
  const p: string[] = [];
  if (!text || !text.trim()) return [where + ": empty text"];
  if (sentenceCount(text) > maxSentences) p.push(where + ": " + sentenceCount(text) + " sentences; at most " + maxSentences);
  for (const ph of placeholdersOf(text)) if (!allowed.includes(ph)) p.push(where + ": unknown placeholder {" + ph + "}");
  return p;
}

function uniqueIds(what: string, ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const p: string[] = [];
  for (const id of ids) {
    if (!id) p.push(what + " with no id");
    if (seen.has(id)) p.push(what + " " + id + " is listed twice");
    seen.add(id);
  }
  return p;
}

// -- the cutscene ---------------------------------------------------------------------

export const CUTSCENE_BEATS_MIN = 8;
export const CUTSCENE_BEATS_MAX = 14;

export function validateCutscene(s: StoryContent = STORY): string[] {
  const x = context(s);
  const beats = s.cutscene.beats;
  const p = uniqueIds("cutscene beat", beats.map((b) => b.id));
  if (!s.cutscene.skippable) p.push("the cutscene must be skippable");
  if (beats.length < CUTSCENE_BEATS_MIN || beats.length > CUTSCENE_BEATS_MAX) p.push("the cutscene has " + beats.length + " beats; " + CUTSCENE_BEATS_MIN + ".." + CUTSCENE_BEATS_MAX);
  // Roads, for "road" shots: the route must exist on the map.
  const adj = new Map<string, string[]>();
  for (const [a, b] of s.map.roads) { (adj.get(a) ?? adj.set(a, []).get(a)!).push(b); (adj.get(b) ?? adj.set(b, []).get(b)!).push(a); }
  const joined = (a: string, b: string): boolean => {
    const seen = new Set([a]);
    const q = [a];
    while (q.length > 0) { const h = q.shift()!; if (h === b) return true; for (const n of adj.get(h) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); } }
    return false;
  };
  for (const b of beats) {
    const where = "cutscene " + b.id;
    p.push(...textProblems(where, b.text, 2, LETTER_PLACEHOLDERS));
    if (!whole(b.seconds, 2, 15)) p.push(where + ": a beat holds 2..15 s");
    const st = b.stage;
    switch (st.shot) {
      case "holding":
        if (!x.holdings.has(st.holding)) p.push(where + ": unknown holding " + st.holding);
        if (!whole(st.miles, 40, 1000)) p.push(where + ": a shot is 40..1000 miles across");
        break;
      case "road":
        if (!x.holdings.has(st.from) || !x.holdings.has(st.to)) p.push(where + ": unknown holding on the road");
        else if (!joined(st.from, st.to)) p.push(where + ": no road joins " + st.from + " and " + st.to);
        break;
      case "prop":
        if (!CUTSCENE_PROPS.includes(st.prop)) p.push(where + ": unknown prop " + st.prop);
        if (st.at !== undefined && !x.holdings.has(st.at)) p.push(where + ": unknown holding " + st.at);
        break;
      case "realm": case "title": break;
    }
  }
  return p;
}

// -- letters ------------------------------------------------------------------------

/** Letters that start this encounter, directly. */
function lettersStarting(x: Ctx, encounter: string): StoryLetterDef[] {
  return x.s.letters.filter((l) => letterEffects(l).some((e) => e.kind === "battle" && e.encounter === encounter));
}

/** Can this letter be sent at all: a trigger, or a follow-up from a letter or encounter that can. */
function sendable(x: Ctx): Set<string> {
  const ok = new Set<string>();
  for (const l of x.s.letters) if (l.trigger) ok.add(l.id);
  let grew = true;
  while (grew) {
    grew = false;
    const from = (effects: readonly StoryEffect[]): void => {
      for (const e of effects) if (e.kind === "followUp" && !ok.has(e.letter)) { ok.add(e.letter); grew = true; }
    };
    for (const l of x.s.letters) if (ok.has(l.id)) from(letterEffects(l));
    for (const e of x.s.encounters) if (lettersStarting(x, e.id).some((l) => ok.has(l.id))) { from(e.wonEffects); from(e.lostEffects); }
  }
  return ok;
}

/**
 * Every choice of this letter fights `encounter`, or follows up to a letter
 * that (in turn) always does. "Not yet" brings the same letter back, which is
 * fine: it never closes the road.
 */
function neverDeadEnds(x: Ctx, letter: StoryLetterDef, encounter: string, seen = new Set<string>()): boolean {
  if (seen.has(letter.id)) return true;
  seen.add(letter.id);
  return letter.choices.every((c) => choiceOutcomes(c).every((o) =>
    o.effects.some((e) => e.kind === "battle" && e.encounter === encounter) ||
    o.effects.some((e) => {
      if (e.kind !== "followUp") return false;
      const next = x.letters.get(e.letter);
      return next !== undefined && neverDeadEnds(x, next, encounter, seen);
    })));
}

export function validateLetters(s: StoryContent = STORY): string[] {
  const x = context(s);
  const p = uniqueIds("letter", s.letters.map((l) => l.id));
  const ok = sendable(x);
  for (const l of s.letters) {
    const where = "letter " + l.id;
    if (!ACT_IDS.includes(l.act)) p.push(where + ": unknown act");
    if (!l.from || !l.title) p.push(where + ": needs a writer and a title");
    p.push(...textProblems(where, l.text, 3, LETTER_PLACEHOLDERS));
    if (l.trigger) p.push(...conditionProblems(where + " trigger", l.trigger, x));
    if (!ok.has(l.id)) p.push(where + ": nothing ever sends it (no trigger, and no follow-up reaches it)");
    if (l.choices.length < 2 || l.choices.length > 3) p.push(where + ": needs two or three choices");
    // A card must never trap the player: one choice needs nothing and costs nothing.
    if (!l.choices.some((c) => !c.requires && !c.effects.some((e) => e.kind === "pay"))) p.push(where + ": every choice has a price or a requirement; one must be free");
    l.choices.forEach((c, i) => {
      const cw = where + " choice " + (i + 1);
      if (!c.label) p.push(cw + ": needs a label");
      if (c.requires) p.push(...conditionProblems(cw + " requires", c.requires, x));
      for (const o of choiceOutcomes(c)) {
        p.push(...textProblems(cw, o.result, 3, LETTER_PLACEHOLDERS));
        for (const e of o.effects) p.push(...storyEffectProblems(cw, e, x));
      }
      if (c.effects.some((e) => e.kind === "lose")) p.push(cw + ": a loss belongs to a gamble's failure, not a choice");
      if (c.chance && !whole(c.chance.pct, 1, 99)) p.push(cw + ": a gamble's odds are 1..99 %");
      const hires = c.effects.filter((e) => e.kind === "hire");
      if (hires.length > 0 && !c.effects.some((e) => e.kind === "pay")) p.push(cw + ": a hire must pay the company's fee");
    });
    if (l.kind === "encounter" && !letterEffects(l).some((e) => e.kind === "battle")) p.push(where + ": an encounter letter must offer its battle");
  }
  return p;
}

// -- encounters -----------------------------------------------------------------------

export function validateEncounters(s: StoryContent = STORY): string[] {
  const x = context(s);
  const p = uniqueIds("encounter", s.encounters.map((e) => e.id));
  const diff = (d: string): number => (DIFFICULTY_IDS as readonly string[]).indexOf(d);
  for (const e of s.encounters) {
    const where = "encounter " + e.id;
    const h = s.map.holdings.find((k) => k.key === e.holding);
    if (!h) p.push(where + ": unknown holding " + e.holding);
    if (!isFaction(e.faction) || e.faction === "king") p.push(where + ": the king cannot be the enemy");
    if (!COMMANDER_IDS.includes(e.commander)) p.push(where + ": unknown commander " + e.commander);
    // A captain fights with their own habits; only the Margrave and the Chancellor borrow one.
    if ((COMMANDER_IDS as readonly string[]).includes(e.faction) && e.faction !== e.commander) p.push(where + ": the " + e.faction + " must fight as the " + e.faction);
    const level = levelById(e.levelId);
    if (!level) p.push(where + ": unknown level " + e.levelId);
    if (diff(e.difficulty) < 0) p.push(where + ": unknown difficulty " + e.difficulty);
    if (h) {
      const biome = h.biome ?? s.map.provinces.find((q) => q.id === h.province)?.biome;
      const fights = biome ? BIOMES[biome].level : "";
      if (e.levelId !== fights && e.levelId !== fights + "-siege") p.push(where + ": " + e.holding + " fights like " + fights + ", not " + e.levelId);
    }
    if (e.chapter !== null) {
      const ch = chapterById(e.chapter);
      if (!ch) p.push(where + ": unknown chapter " + e.chapter);
      else {
        // Re-cast, not re-invented: the chapter's battle setup is reused.
        if (ch.levelId !== e.levelId) p.push(where + ": chapter " + ch.id + " is fought on " + ch.levelId);
        if (ch.commander !== e.commander) p.push(where + ": chapter " + ch.id + " is the " + ch.commander + "'s");
        if (diff(e.difficulty) < diff(ch.difficulty)) p.push(where + ": easier than chapter " + ch.id);
      }
    }
    p.push(...textProblems(where + " won", e.won, 3, LETTER_PLACEHOLDERS));
    p.push(...textProblems(where + " lost", e.lost, 3, LETTER_PLACEHOLDERS));
    for (const fx of [...e.wonEffects, ...e.lostEffects]) {
      p.push(...storyEffectProblems(where, fx, x));
      if (fx.kind === "pay") p.push(where + ": a battle's aftermath charges no price");
    }
    if (lettersStarting(x, e.id).length === 0) p.push(where + ": no letter ever starts it");
  }
  // Every Marchwarden chapter comes back, and every captain is met.
  for (const ch of CHAPTERS) if (!s.encounters.some((e) => e.chapter === ch.id)) p.push("chapter " + ch.id + " is not re-cast as an encounter");
  for (const c of COMMANDER_IDS) if (!s.encounters.some((e) => e.faction === c && e.first)) p.push("the " + c + " has no first encounter");
  return p;
}

// -- free companies -------------------------------------------------------------------

export function validateMercenaries(s: StoryContent = STORY): string[] {
  const p = uniqueIds("company", s.mercenaries.map((m) => m.id));
  for (const m of s.mercenaries) {
    const where = "company " + m.id;
    if (!(UNIT_TYPE_IDS as readonly string[]).includes(m.dominant)) p.push(where + ": unknown type " + m.dominant);
    else if (companyName(m.nameId, m.dominant) !== m.name) p.push(where + ": companies.ts names it " + companyName(m.nameId, m.dominant) + ", not " + m.name);
    if (m.mix.length === 0 || m.mix.some((t) => !(UNIT_TYPE_IDS as readonly string[]).includes(t))) p.push(where + ": unknown squad type in its mix");
    if (!m.mix.includes(m.dominant)) p.push(where + ": its mix has none of the type it is named for");
    if (!whole(m.fee, 1, 1000) || !whole(m.wage, 1, 100) || !whole(m.contractDays, 10, 365)) p.push(where + ": fee, wage and contract are whole and positive");
    if (!whole(m.loyalty, 0, 100)) p.push(where + ": loyalty is 0..100");
    if (!m.captain || !m.about) p.push(where + ": needs a captain and an about line");
    if (!s.letters.some((l) => l.act <= m.act + 1 && letterEffects(l).some((e) => e.kind === "hire" && e.company === m.id))) p.push(where + ": no letter ever offers it");
    const fee = s.letters.flatMap((l) => l.choices).find((c) => c.effects.some((e) => e.kind === "hire" && e.company === m.id));
    const paid = fee?.effects.find((e) => e.kind === "pay");
    if (fee && paid && paid.kind === "pay" && paid.cost.coin !== m.fee) p.push(where + ": its letter charges " + paid.cost.coin + " coin, not its fee of " + m.fee);
  }
  return p;
}

// -- the chronicle ---------------------------------------------------------------------

const HAPPENINGS: readonly Happening[] = [
  "holdingClaimed", "holdingLost", "battleWon", "battleLost", "armyStarved", "revolt",
  "seasonTurns", "mercenariesDesert", "companyDefects", "companyHired", "followersJoin",
  "famine", "invasionWarned", "captainSworn", "siteExplored",
];

export function validateChronicle(s: StoryContent = STORY): string[] {
  const p = uniqueIds("chronicle entry", s.chronicle.map((c) => c.id));
  for (const c of s.chronicle) {
    const where = "chronicle " + c.id;
    if (!HAPPENINGS.includes(c.happening)) p.push(where + ": unknown happening " + c.happening);
    for (const k of c.params) if (!(k in CHRONICLE_PARAMS)) p.push(where + ": K9 cannot fill {" + k + "}");
    if (c.variants.length < 2) p.push(where + ": needs at least two variants");
    c.variants.forEach((v, i) => p.push(...textProblems(where + " variant " + (i + 1), v, 3, c.params)));
    if ((c.happening === "seasonTurns") !== (c.season !== undefined)) p.push(where + ": a season entry, and only a season entry, names its season");
  }
  for (const h of HAPPENINGS) if (!s.chronicle.some((c) => c.happening === h)) p.push("no chronicle entry for " + h);
  for (const season of SEASONS) if (!s.chronicle.some((c) => c.happening === "seasonTurns" && c.season === season)) p.push("no chronicle entry for the turn to " + season);
  return p;
}

// -- acts ------------------------------------------------------------------------

/** What the story alone can do by the end of act `a`. */
type Reach = {
  readonly flags: ReadonlySet<string>;
  readonly encounters: ReadonlySet<string>;
  /** Most legitimacy the story's own choices and battles can add by then. */
  readonly legitimacyGain: number;
};

function reachBy(x: Ctx, a: ActId): Reach {
  const letters = x.s.letters.filter((l) => l.act <= a);
  const flags = new Set<string>();
  const encounters = new Set<string>();
  let gain = 0;
  for (const l of letters) {
    for (const e of letterEffects(l)) {
      if (e.kind === "flag") flags.add(e.flag);
      if (e.kind === "battle" && (x.encounters.get(e.encounter)?.act ?? 9) <= a) encounters.add(e.encounter);
    }
    gain += Math.max(0, ...l.choices.flatMap((c) => choiceOutcomes(c).map((o) => legitimacyOf(o.effects))));
  }
  for (const id of encounters) {
    const e = x.encounters.get(id)!;
    for (const fx of [...e.wonEffects, ...e.lostEffects]) if (fx.kind === "flag") flags.add(fx.flag);
    gain += Math.max(0, legitimacyOf(e.wonEffects), legitimacyOf(e.lostEffects));
  }
  return { flags, encounters, legitimacyGain: gain };
}

function satisfiable(c: StoryCondition, r: Reach, x: Ctx): boolean {
  switch (c.kind) {
    case "all": return c.of.every((d) => satisfiable(d, r, x));
    case "any": return c.of.some((d) => satisfiable(d, r, x));
    case "flag": return r.flags.has(c.flag);
    case "encounterFought": case "encounterWon": return r.encounters.has(c.encounter);
    case "captainDefeated": return [...r.encounters].some((id) => x.encounters.get(id)!.faction === c.id);
    case "legitimacyAtLeast": return KING_START_LEGITIMACY + r.legitimacyGain >= c.n;
    case "legitimacyBelow": return c.n > 0;
    case "mercyBelow": return c.n > MERCY_MIN;
    default: return true;
  }
}

export function validateActs(s: StoryContent = STORY): string[] {
  const x = context(s);
  const p: string[] = [];
  if (s.acts.length !== ACT_IDS.length || s.acts.some((a, i) => a.id !== ACT_IDS[i])) p.push("the acts must be I, II, III and IV, in order");
  for (const a of s.acts) {
    const where = "act " + a.id;
    if (!a.title || !a.lesson) p.push(where + ": needs a title and a lesson");
    p.push(...textProblems(where + " intro", a.intro.text, 3, LETTER_PLACEHOLDERS));
    p.push(...textProblems(where + " transition", a.transition.text, 3, LETTER_PLACEHOLDERS));
    if (!a.intro.title || !a.transition.title) p.push(where + ": entries need titles");
    if (a.goals.length === 0) p.push(where + ": an act with no goal never ends");
    p.push(...uniqueIds(where + " goal", a.goals.map((g) => g.id)));
    const r = reachBy(x, a.id);
    for (const g of a.goals) {
      if (!g.text) p.push(where + " goal " + g.id + ": needs its text");
      p.push(...conditionProblems(where + " goal " + g.id, g.condition, x));
      if (!satisfiable(g.condition, r, x)) p.push(where + " goal " + g.id + ": the story cannot satisfy it by the end of act " + a.id);
      // A battle an act needs must never be closed off by declining its letter.
      eachCondition(g.condition, (d) => {
        if (d.kind !== "encounterWon" && d.kind !== "encounterFought") return;
        // Every letter that can offer it first (by trigger) must keep offering it.
        const first = lettersStarting(x, d.encounter).filter((l) => l.act <= a.id && l.trigger !== null);
        if (first.length === 0) p.push(where + " goal " + g.id + ": no letter of act " + a.id + " or before offers " + d.encounter);
        for (const l of first) if (!neverDeadEnds(x, l, d.encounter)) p.push(where + " goal " + g.id + ": letter " + l.id + " can decline " + d.encounter + " for good");
        // ...nor by losing it: a lost battle an act needs must come round again.
        const e = x.encounters.get(d.encounter);
        if (d.kind === "encounterWon" && e && !e.lostEffects.some((fx) => {
          if (fx.kind !== "followUp") return false;
          const next = x.letters.get(fx.letter);
          return next !== undefined && neverDeadEnds(x, next, d.encounter);
        })) p.push(where + " goal " + g.id + ": losing " + d.encounter + " closes the act for good");
      });
    }
  }
  return p;
}

// -- endings ------------------------------------------------------------------------

const inRange = (v: number, r: StatRange): boolean => (r.min === undefined || v >= r.min) && (r.below === undefined || v < r.below);

/**
 * Where the story can leave the two stats on the day Rimaros falls: legitimacy
 * from the Act III gate (the highest legitimacy any goal up to Act III asks
 * for) down by everything Act IV can take, up to the cap; mercy across every
 * letter's most merciful and most terrible choices.
 */
export function coronationRange(s: StoryContent = STORY): { legitimacy: [number, number]; mercy: [number, number] } {
  let gate = 0;
  for (const a of s.acts) if (a.id < 4) for (const g of a.goals) eachCondition(g.condition, (d) => { if (d.kind === "legitimacyAtLeast") gate = Math.max(gate, d.n); });
  let drop = 0;
  let up = 0;
  let down = 0;
  for (const l of s.letters) {
    const legit = l.choices.flatMap((c) => choiceOutcomes(c).map((o) => legitimacyOf(o.effects)));
    if (l.act === 4) drop += Math.max(0, -Math.min(0, ...legit));
    const mercy = l.choices.flatMap((c) => choiceOutcomes(c).map((o) => mercyOf(o.effects)));
    up += Math.max(0, ...mercy);
    down += Math.max(0, -Math.min(0, ...mercy));
  }
  for (const e of s.encounters) {
    if (e.act === 4) drop += Math.max(0, -legitimacyOf(e.lostEffects));
    up += Math.max(0, mercyOf(e.wonEffects), mercyOf(e.lostEffects));
    down += Math.max(0, -Math.min(mercyOf(e.wonEffects), mercyOf(e.lostEffects)));
  }
  return {
    legitimacy: [Math.max(0, gate - drop), LEGITIMACY_MAX],
    mercy: [Math.max(MERCY_MIN, MERCY_START - down), Math.min(MERCY_MAX, MERCY_START + up)],
  };
}

export function validateEndings(s: StoryContent = STORY): string[] {
  const x = context(s);
  const p = uniqueIds("ending", s.endings.map((e) => e.id));
  const crowned = s.endings.filter((e) => e.gate.kind === "crowned");
  const failures = s.endings.filter((e) => e.gate.kind === "failure");
  for (const t of ["The Restored King", "The Iron Crown", "The Hollow Crown"]) if (!crowned.some((e) => e.title === t)) p.push("no crowned ending titled " + t);
  if (failures.length !== 1) p.push("needs exactly one failure ending");
  for (const e of failures) {
    if (e.gate.kind !== "failure") continue;
    p.push(...conditionProblems("ending " + e.id, e.gate.condition, x));
    let lost = false;
    eachCondition(e.gate.condition, (d) => { if (d.kind === "kingLost") lost = true; });
    if (!lost) p.push("ending " + e.id + ": the failure ending is the king lost");
  }
  for (const e of s.endings) {
    const where = "ending " + e.id;
    if (!e.title) p.push(where + ": needs a title");
    if (e.epilogue.length < 3) p.push(where + ": an epilogue is a short sequence, three beats at least");
    if (!e.epilogue.some((b) => !b.when)) p.push(where + ": at least one beat is always read");
    e.epilogue.forEach((b, i) => {
      p.push(...textProblems(where + " beat " + (i + 1), b.text, 2, LETTER_PLACEHOLDERS));
      if (b.when) p.push(...conditionProblems(where + " beat " + (i + 1), b.when, x));
    });
  }
  // The crowned endings partition the plane: every (legitimacy, mercy) pair has exactly one.
  let gaps = 0;
  let overlaps = 0;
  for (let l = 0; l <= LEGITIMACY_MAX; l++) {
    for (let m = MERCY_MIN; m <= MERCY_MAX; m++) {
      const n = crowned.filter((e) => e.gate.kind === "crowned" && inRange(l, e.gate.legitimacy) && inRange(m, e.gate.mercy)).length;
      if (n === 0) gaps++;
      if (n > 1) overlaps++;
    }
  }
  if (gaps > 0) p.push("the crowned endings leave " + gaps + " (legitimacy, mercy) pairs with no ending");
  if (overlaps > 0) p.push("the crowned endings overlap on " + overlaps + " (legitimacy, mercy) pairs");
  // Each is reachable from where the story can leave the king.
  const r = coronationRange(s);
  for (const e of crowned) {
    if (e.gate.kind !== "crowned") continue;
    let reachable = false;
    for (let l = r.legitimacy[0]; l <= r.legitimacy[1] && !reachable; l++) {
      for (let m = r.mercy[0]; m <= r.mercy[1] && !reachable; m++) if (inRange(l, e.gate.legitimacy) && inRange(m, e.gate.mercy)) reachable = true;
    }
    if (!reachable) p.push("ending " + e.id + " cannot be reached: at the coronation legitimacy is " + r.legitimacy.join("..") + " and mercy " + r.mercy.join(".."));
  }
  return p;
}

// -- the tutorial ---------------------------------------------------------------------

export function validateTutorial(s: StoryContent = STORY): string[] {
  const p = uniqueIds("tutorial step", s.tutorial.map((t) => t.id));
  p.push(...uniqueIds("tutorial lesson", s.lessons.map((l) => l.id)));
  const lessons = new Map(s.lessons.map((l) => [l.id, l]));
  for (const l of s.lessons) p.push(...textProblems("lesson " + l.id, l.intro, 2, []));
  for (const t of s.tutorial) {
    const where = "tutorial " + t.id;
    const lesson = lessons.get(t.lesson);
    if (!lesson) p.push(where + ": unknown lesson " + t.lesson);
    else if (lesson.layer !== t.layer) p.push(where + ": a " + t.layer + " step in a " + lesson.layer + " lesson");
    p.push(...textProblems(where, t.text, 2, []));
    p.push(...textProblems(where + " hint", t.hint, 2, []));
    const sc = t.success;
    if (sc.kind === "gesture" && t.layer !== "battle") p.push(where + ": battle strokes are taught on the battlefield");
    if (sc.kind === "kingdomGesture" && t.layer !== "kingdom") p.push(where + ": map strokes are taught on the map");
    if (sc.kind === "cityTap" && t.layer !== "city") p.push(where + ": town taps are taught in a town");
    if (sc.kind === "gesture" && sc.shape && sc.class !== "formation") p.push(where + ": only a formation stroke has a shape");
    if (sc.kind === "ui" && !TUTORIAL_UI_ACTIONS.includes(sc.action)) p.push(where + ": unknown action " + sc.action);
  }
  for (const l of s.lessons) if (!s.tutorial.some((t) => t.lesson === l.id)) p.push("lesson " + l.id + " teaches nothing");
  // Every control.
  const has = (f: (t: TutorialStep) => boolean): boolean => s.tutorial.some(f);
  for (const c of BATTLE_GESTURE_CLASSES) if (!has((t) => t.success.kind === "gesture" && t.success.class === c)) p.push("the tutorial never teaches the battle stroke " + c);
  for (const g of GLYPH_SHAPES) if (!has((t) => t.success.kind === "gesture" && t.success.shape === g)) p.push("the tutorial never teaches the " + g + " glyph");
  for (const c of KINGDOM_PEN_CLASSES) if (!has((t) => t.success.kind === "kingdomGesture" && t.success.class === c)) p.push("the tutorial never teaches the map order " + c);
  for (const layer of ["kingdom", "city", "battle"] as const) {
    for (const a of ["drag", "zoom"] as const) if (!has((t) => t.layer === layer && t.success.kind === "camera" && t.success.action === a)) p.push("the tutorial never teaches camera " + a + " in the " + layer);
  }
  for (const layer of ["kingdom", "battle"] as const) {
    if (!has((t) => t.layer === layer && t.success.kind === "camera" && t.success.action === "keys")) p.push("the tutorial never teaches the camera keys in the " + layer);
    for (const a of ["pause", "step"] as const) if (!has((t) => t.layer === layer && t.success.kind === "time" && t.success.action === a)) p.push("the tutorial never teaches " + a + " in the " + layer);
  }
  if (!has((t) => t.success.kind === "time" && t.success.action === "speed")) p.push("the tutorial never teaches the realm's speeds");
  for (const a of TUTORIAL_UI_ACTIONS) if (!has((t) => t.success.kind === "ui" && t.success.action === a)) p.push("the tutorial never teaches " + a);
  for (const sel of ["cleared", "picked"] as const) if (!has((t) => t.success.kind === "gesture" && t.success.class === "select" && t.success.detail === sel)) p.push("the tutorial never teaches a tap that " + sel);
  for (const target of ["lot", "field", "square"] as const) if (!has((t) => t.success.kind === "cityTap" && t.success.target === target)) p.push("the tutorial never teaches tapping a town's " + target);
  return p;
}

// -- flags ------------------------------------------------------------------------

export function validateFlags(s: StoryContent = STORY): string[] {
  const p: string[] = [];
  const set = new Set<string>();
  const read = new Set<string>();
  const readIn = (c: StoryCondition | null | undefined): void => {
    if (c) eachCondition(c, (d) => { if (d.kind === "flag" || d.kind === "notFlag") read.add(d.flag); });
  };
  const setIn = (effects: readonly StoryEffect[]): void => {
    for (const e of effects) if (e.kind === "flag") set.add(e.flag);
  };
  for (const l of s.letters) {
    readIn(l.trigger);
    for (const c of l.choices) readIn(c.requires);
    setIn(letterEffects(l));
  }
  for (const e of s.encounters) { setIn(e.wonEffects); setIn(e.lostEffects); }
  for (const a of s.acts) for (const g of a.goals) readIn(g.condition);
  for (const e of s.endings) {
    if (e.gate.kind === "failure") readIn(e.gate.condition);
    for (const b of e.epilogue) readIn(b.when);
  }
  for (const f of Object.keys(s.flags)) {
    if (!s.flags[f]) p.push("flag " + f + " needs a line saying what it records");
    if (!set.has(f)) p.push("flag " + f + " is set by nothing");
    if (!read.has(f)) p.push("flag " + f + " is read by nothing: the choice that sets it changes nothing");
  }
  for (const f of [...set, ...read]) if (!(f in s.flags)) p.push("flag " + f + " is not declared in flags.ts");
  return p;
}

// -- every word --------------------------------------------------------------------

/** Every string the story shows, for the gender check (and anyone auditing the text). */
export function storyStrings(s: StoryContent = STORY): string[] {
  const out: string[] = [];
  for (const b of s.cutscene.beats) out.push(b.text);
  for (const a of s.acts) { out.push(a.title, a.lesson, a.intro.title, a.intro.text, a.transition.title, a.transition.text); for (const g of a.goals) out.push(g.text); }
  for (const l of s.letters) {
    out.push(l.from, l.title, l.text);
    for (const c of l.choices) { out.push(c.label); for (const o of choiceOutcomes(c)) out.push(o.result); }
  }
  for (const e of s.encounters) out.push(e.won, e.lost);
  for (const m of s.mercenaries) out.push(m.name, m.captain, m.about);
  for (const c of s.chronicle) out.push(...c.variants);
  for (const e of s.endings) { out.push(e.title); for (const b of e.epilogue) out.push(b.text); }
  for (const t of s.tutorial) out.push(t.text, t.hint);
  for (const l of s.lessons) out.push(l.title, l.intro);
  out.push(...Object.values(s.flags));
  return out;
}

export function validateWords(s: StoryContent = STORY): string[] {
  return storyStrings(s).filter((t) => GENDERED.test(t)).map((t) => "a story string guesses a gender: " + t.slice(0, 80));
}

/** Every problem with the whole story. Empty means valid. */
export function validateStory(s: StoryContent = STORY): string[] {
  // Exhaustiveness: the effect kinds list is the union (a typo here is a compile error).
  const kinds: readonly StoryEffect["kind"][] = STORY_EFFECT_KINDS;
  void kinds;
  return [
    ...validateCutscene(s), ...validateActs(s), ...validateLetters(s), ...validateEncounters(s),
    ...validateMercenaries(s), ...validateChronicle(s), ...validateEndings(s), ...validateTutorial(s),
    ...validateFlags(s), ...validateWords(s),
  ];
}
