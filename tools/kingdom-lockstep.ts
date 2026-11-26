/**
 * K12's proof (PLAN.md §B.10, §B.11 "kingdom lockstep verification"): the
 * kingdom layer is as lockstep-safe as the battle layer (tools/lockstep.ts).
 *
 * Two (or more) KingdomWorlds in one process, one of them -- the LEADER --
 * played by a scripted king, the others -- the FOLLOWERS -- never deciding
 * anything: they receive the leader's stamped orders, exactly as a netplay
 * peer would off the wire, and their kingdom hash is compared with the
 * leader's after every tick. The realm is the full campaign: the opening
 * hosts, the captains' AI and their invasion waves, auto-resow and the story,
 * over several in-game years.
 *
 * What it proves, section by section:
 *   1. one order log -> identical hashes, every tick, with every order kind in
 *      the log (story letters, marches, recruits, hires, builds, sowing and
 *      auto-resow, the defence tools, descent results among them);
 *   2. the orders of a tick arriving in any order change nothing -- shuffled
 *      within the tick, spread over the ticks before they fall due (an input
 *      delay), or the whole log submitted backwards up front;
 *   3. a one-ten-thousandth nudge to one world is caught by the very next
 *      check, and every field of the state is covered by the hash (a sweep
 *      that nudges each one in turn, integers by 0.0001 too: a field the hash
 *      cannot see is a desync nobody would ever be told about), and every
 *      field of the world is either swept or set aside with a reason;
 *   4. a save -> load at any point (mid-march, with a contact waiting, with
 *      orders queued for later ticks) continues tick-identical to the world
 *      that was never saved, the save carries every field, and the realm can
 *      be saved at all at the turn of every day and the tick after every
 *      contact (K12 found three states the save refused: see the checks);
 *   5. the layer hash with a battle in progress: BattleSpec -> a real battle
 *      World -> BattleResult, two peers agree on all three, and a nudge on
 *      the battle side is attributed to the battle layer (driftedLayer).
 *
 * No network, on purpose: what needs proving first is that the SIMULATION is
 * deterministic; a relay is infrastructure on top.
 */

import {
  KingdomWorld, TICKS_PER_DAY, armiesOf, armyById, planArmyRoute, buildBattleSpec, kingdomHash, peerHash, resultFromBattle, standsIn,
  checkContactOrder,
  KINGDOM_ORDER_KINDS, type Army, type Holding, type KingdomOrder, type KingdomOrderBody, type KingdomOrderKind,
} from "../src/sim/kingdom/index.ts";
import { offeredChoices } from "../src/sim/kingdom/story.ts";
import { saveToJson, loadFromJson } from "../src/sim/kingdom/save.ts";
import { layerHash, driftedLayer, hashBattleSpec, hashBattleResult, type BattleResult, type BattleSpec } from "../src/sim/layers.ts";
import { hashWorld } from "../src/sim/hash.ts";
import type { World } from "../src/sim/world.ts";
import { battleFromSpec, battleWorld } from "../src/app/battle-config.ts";
import { KING_PLAYER, FACTION_IDS } from "../src/content/kingdom/factions.ts";
import { WIN_LEGITIMACY } from "../src/content/kingdom/descent.ts";
import { STORY_LETTERS, type StoryChoice } from "../src/content/story/letters.ts";
import { DOCTRINE_IDS } from "../src/content/doctrines.ts";
import { ABILITY_IDS } from "../src/content/abilities.ts";
import { MERCENARIES } from "../src/content/story/mercenaries.ts";
import { ENCOUNTERS } from "../src/content/story/encounters.ts";

const SEED = 0x6b120001;
/** Several in-game years (or the story's end, whichever comes first: after it the realm holds). */
const DAYS = 360 * 4;
const CONFIG = { hosts: true, captains: true, autoFarm: true, story: true } as const;

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failures++;
  console.log((ok ? "  ok    " : "  FAIL  ") + name + (detail ? "  <- " + detail : ""));
}
function section(name: string): void {
  console.log("\n" + name);
}

/**
 * The network's whims, from a seed of its own: mulberry32. A tool may use any
 * arithmetic it likes, but a fixed seed keeps a failure reproducible.
 */
function wire(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n: number): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % n);
  };
}
function shuffled<T>(xs: readonly T[], roll: (n: number) => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = roll(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// -- the scripted king ---------------------------------------------------------------------------
//
// A player who only READS the leader to decide and only WRITES it through
// orders: the kind king of tools/story-playthrough.ts, condensed, plus a
// steward that pulls every other lever the panels offer now and then (taxes,
// justice, hand-sowing and auto-resow, a split army that patrols, ambushes and
// rejoins, hired companies, the defence tools). The point is not to play
// well; it is to put every order kind into the log while the realm, the AI
// and the story run as they would.

type Bot = {
  target: number;
  stuck: number;
  rallied: Set<number>;
  contacts: number;
  /** Orders the leader accepted, per kind (a kind refused every time is reported). */
  accepted: Map<KingdomOrderKind, number>;
  issued: Map<KingdomOrderKind, number>;
  /** Real battles fought out on a battle World (section 5 reads the first). */
  battles: number;
  /** Day an exercise of each kind last ran, so each comes round now and then rather than every day. */
  last: Map<string, number>;
  spare: number;
  /** Fight the next field contact out on a real battle World (off by default: the main run keeps the king alive for years). */
  fight: boolean;
  /** Assaults on his townsmen alone, settled so far (they take turns: the keep, the gates, a fight). */
  walls: number;
  /** A squad split off his army, by its id: the spare army is whichever army holds it. */
  splitSquad: number;
  /** The levy army on its way to stand garrison in the capital (0: none). */
  toCapital: number;
};

function newBot(): Bot {
  return { target: 0, stuck: 0, rallied: new Set(), contacts: 0, accepted: new Map(), issued: new Map(), battles: 0, last: new Map(), spare: 0, fight: false, walls: 0, splitSquad: 0, toCapital: 0 };
}

/** Issue an order to the leader if it would be accepted now. Every issued order goes into `out`, the wire. */
function make(w: KingdomWorld, out: KingdomOrder[], bot: Bot, body: KingdomOrderBody, force = false): boolean {
  if (!force && w.check(body) !== null) return false;
  out.push(w.issue(body));
  bot.issued.set(body.kind, (bot.issued.get(body.kind) ?? 0) + 1);
  return true;
}

/** Whether `key` has not run for `days` days (and mark it run). */
function every(w: KingdomWorld, bot: Bot, key: string, days: number): boolean {
  const d = w.date.day;
  const l = bot.last.get(key);
  if (l !== undefined && d - l < days) return false;
  bot.last.set(key, d);
  return true;
}

function kingAt(w: KingdomWorld): number {
  const m = w.king.mover;
  return m.road === 0 && m.route.length === 0 ? m.node : 0;
}

function score(c: StoryChoice): number {
  let s = 0;
  for (const fx of c.effects) {
    if (fx.kind === "mercy") s += fx.delta * 3;
    if (fx.kind === "legitimacy") s += fx.delta;
    if (fx.kind === "battle") s += 100;
    if (fx.kind === "followUp") s -= 50;
    if (fx.kind === "hire") s -= 200;
  }
  return s;
}

/**
 * Eighteen holdings, then he sits on them until the fourth year, his army in his capital: a long stretch of the
 * captains' invasions against a realm that holds still, rather than a story won in two.
 */
function sitting(w: KingdomWorld): boolean {
  return w.holdingsOf("king").length >= 18 && w.date.day < 360 * 3;
}

/** His capital, when it is not his (0 when it is, or there is none yet). */
function lostCapital(w: KingdomWorld): number {
  const cap = w.story!.capital;
  return cap !== 0 && w.holding(cap)!.owner !== "king" ? cap : 0;
}

/**
 * Holdings the encounters are fought at, while their encounter is not yet won
 * and not armed: left for the story (tools/story-playthrough.ts), so its acts
 * move on. The Crown Seat is left alone throughout: its siege would end the
 * story, and this run is to last years.
 */
function storyGround(w: KingdomWorld): Set<number> {
  const out = new Set<number>();
  const s = w.story!;
  ENCOUNTERS.forEach((e, i) => {
    if (s.encounters[i].state === "won") return;
    const h = w.holdingByKey(e.holding);
    if (h && s.encounters[i].state !== "armed") out.add(h.id);
  });
  return out;
}

/** Where an armed encounter's host stands (the Crown Seat's siege aside), if he can march there; else 0. */
function armedEncounter(w: KingdomWorld): number {
  const s = w.story!;
  for (let i = 0; i < ENCOUNTERS.length; i++) {
    if (s.encounters[i].state !== "armed" || ENCOUNTERS[i].id === "crown-siege") continue;
    const host = armyById(w, s.encounters[i].host);
    const at = host ? standsIn(host.mover) : w.holdingByKey(ENCOUNTERS[i].holding)!.id;
    if (at && w.planKingRoute(at)) return at;
  }
  return 0;
}

/** The next holding to take: an armed encounter first, else the nearest one not his (the story's ground and the Crown Seat left alone). */
function nextTarget(w: KingdomWorld): number {
  const enc = armedEncounter(w);
  if (enc) return enc;
  if (sitting(w)) return 0;
  const seat = w.holdingByKey(w.map.crownSeat)!.id;
  const avoid = storyGround(w);
  let best = 0;
  let eta = Infinity;
  for (const h of w.holdings) {
    if (h.owner === "king" || h.id === seat || avoid.has(h.id)) continue;
    if (h.owner !== null && w.story!.sworn.includes(FACTION_IDS.indexOf(h.owner))) continue;
    const p = w.planKingRoute(h.id);
    if (!p || p.route.nodes.length === 0) continue;
    const cost = h.owner === null && h.garrison.length === 0 ? p.etaTicks : p.etaTicks * 2;
    if (cost < eta) { eta = cost; best = h.id; }
  }
  return best;
}

/** The nearest holding not the king's that army `a` can march to (the Crown Seat left alone). */
function nearestFor(w: KingdomWorld, a: Army): number {
  const seat = w.holdingByKey(w.map.crownSeat)!.id;
  const avoid = storyGround(w);
  let best = 0;
  let eta = Infinity;
  for (const h of w.holdings) {
    if (h.owner === "king" || h.id === seat || avoid.has(h.id)) continue;
    const p = planArmyRoute(w, a, h.id);
    if (!p || p.route.nodes.length === 0) continue;
    if (p.etaTicks < eta) { eta = p.etaTicks; best = h.id; }
  }
  return best;
}

/** A battle's report for a field the king's side won outright, as resultFromBattle would build it. */
function wonResult(w: KingdomWorld): BattleResult {
  const c = w.contact!;
  const spec = buildBattleSpec(w, c);
  const king = spec.sides[0].faction === KING_PLAYER;
  return {
    contact: c.id, winner: 0,
    squads: [
      spec.sides[0].squads.map((q) => ({ squad: q.squad, men: q.men, wounded: q.wounded })),
      spec.sides[1].squads.map((q) => ({ squad: q.squad, men: 0, wounded: 0 })),
    ],
    morale: [70, 0], fled: [false, true], left: [false, false],
    damage: { crops: 10, buildings: 0 },
    legitimacy: king ? WIN_LEGITIMACY : 0,
  };
}

/** Fight a spec out on a battle World, the machine commanding both sides; the World and its fielded squads. */
function fieldOf(spec: BattleSpec): { world: World; fielded: ReturnType<typeof battleWorld>["fielded"] } {
  const { world, fielded } = battleWorld(battleFromSpec(spec), { aiPlayers: [0, 1] });
  world.deploying = false;
  return { world, fielded };
}
function battleCap(spec: BattleSpec): number {
  return (spec.duration + 30) * 20;
}

/**
 * Settle the leader's waiting contact, varying how: a real battle now and
 * then (resultFromBattle off a battle World), a won field, "resolve for me",
 * a withdrawal, and at the king's own walls the gates or the keep.
 */
function settle(w: KingdomWorld, out: KingdomOrder[], bot: Bot): void {
  const c = w.contact!;
  const n = bot.contacts++;
  const kings = c.sides[0].faction === KING_PLAYER;
  if (!kings) return;
  const spec = buildBattleSpec(w, c);
  if (bot.fight && c.kind === "field") {
    // A real battle on a battle World, the machine on both sides (the battle suites fight; this proves the handoff).
    const { world, fielded } = fieldOf(spec);
    const cap = battleCap(spec);
    for (let t = 0; t < cap && !world.outcome; t++) world.step();
    bot.battles++;
    bot.fight = false;
    if (make(w, out, bot, { kind: "resolveContact", contact: c.id, choice: "fight", result: resultFromBattle(spec, world, fielded) })) return;
  }
  // The king's own army always wins its field, and his capital holds (the scripted king is to live for years); the
  // rest take their chances. But where he far outnumbers the host he meets, he lets it be resolved for him now and
  // then, and every fourth such field he falls back from instead (the sim's own outcomes, on both peers).
  if ((c.sides[0].army !== 0 && c.sides[0].army === w.king.army) || c.holding === w.story!.capital) {
    const men = (i: number): number => spec.sides[i].squads.reduce((n, q) => n + q.men, 0);
    if (c.sides[0].army === w.king.army && men(0) >= 2 * men(1)) {
      const k = bot.walls + n;
      if (k % 4 === 1 && make(w, out, bot, { kind: "resolveContact", contact: c.id, choice: "auto", result: null })) return;
      if (k % 4 === 3 && make(w, out, bot, { kind: "resolveContact", contact: c.id, choice: "withdraw", result: null })) return;
    }
    make(w, out, bot, { kind: "resolveContact", contact: c.id, choice: "fight", result: wonResult(w) });
    return;
  }
  if (c.kind === "assault" && c.sides[0].army === 0 && c.holding !== w.story!.capital) {
    // His townsmen alone behind his walls (not the capital's): the keep, the gates and a fight, in turn.
    const m = bot.walls++;
    if (m % 3 === 0 && make(w, out, bot, { kind: "resolveContact", contact: c.id, choice: "keep", result: null })) return;
    if (m % 3 === 1 && make(w, out, bot, { kind: "resolveContact", contact: c.id, choice: "yield", result: null })) return;
  }
  if (n % 3 === 0 && make(w, out, bot, { kind: "resolveContact", contact: c.id, choice: "withdraw", result: null })) return;
  if (n % 3 === 1 && make(w, out, bot, { kind: "resolveContact", contact: c.id, choice: "auto", result: null })) return;
  if (make(w, out, bot, { kind: "resolveContact", contact: c.id, choice: "fight", result: wonResult(w) })) return;
  make(w, out, bot, { kind: "resolveContact", contact: c.id, choice: "auto", result: null });
}

/** The day's decisions, on the first tick of the day (as tools/story-playthrough.ts). */
function decide(w: KingdomWorld, out: KingdomOrder[], bot: Bot): void {
  const s = w.story!;
  const e = w.economy[KING_PLAYER];
  const issue = (body: KingdomOrderBody): boolean => make(w, out, bot, body);
  for (const li of [...s.pending]) {
    let pick = -1;
    let best = -Infinity;
    for (const c of offeredChoices(w, li)) {
      if (w.check({ kind: "answerLetter", letter: li, choice: c }) !== null) continue;
      const sc = score(STORY_LETTERS[li].choices[c]);
      if (sc > best) { best = sc; pick = c; }
    }
    if (pick >= 0) issue({ kind: "answerLetter", letter: li, choice: pick });
  }
  // Letters from the exploration sites, the first choice he can pay for.
  for (const f of w.explore[KING_PLAYER].finds) {
    if (f.choice >= 0) continue;
    for (let c = 0; c < 6; c++) if (issue({ kind: "resolveEvent", site: f.site, choice: c })) break;
  }
  steward(w, out, bot);
  const army = armyById(w, w.king.army);
  const here = kingAt(w);
  if (!army) {
    if (here === 0) {
      if (w.king.mover.route.length === 0) {
        let best = 0;
        let eta = Infinity;
        for (const h of w.holdingsOf("king")) {
          const p = w.planKingRoute(h.id);
          if (p && p.etaTicks < eta) { eta = p.etaTicks; best = h.id; }
        }
        if (best) issue({ kind: "moveKing", to: best });
      }
      return;
    }
    const h = w.holding(here) as Holding;
    const go = (key: string): boolean => {
      const x = w.holdingByKey(key)!;
      if (here === x.id) return false;
      if (w.king.mover.route.length === 0) {
        issue({ kind: "moveKing", to: x.id });
        // The first march is also halted and given again in the same tick: a
        // haltKing in the log, and the seq order is what decides the outcome.
        if (every(w, bot, "haltKing", 100000)) { issue({ kind: "haltKing" }); issue({ kind: "moveKing", to: x.id }); }
      }
      return true;
    };
    const armed = s.encounters.some((x) => x.state === "armed");
    if (s.act === 1 && !armed) {
      const greyshaw = w.holdingByKey("greyshaw")!;
      if (greyshaw.owner !== "king") {
        if (e.stocks.levy < 4 && !bot.rallied.has(w.holdingByKey("cold-hearth")!.id)) {
          if (go("cold-hearth")) return;
          if (w.king.task !== "rally") issue({ kind: "rally" });
          return;
        }
        if (e.stocks.grain < 70 || e.stocks.timber < 4) {
          if (w.king.task !== "forage") issue({ kind: "forage" });
          return;
        }
      }
      for (const key of ["greyshaw", "rookstead"]) {
        const x = w.holdingByKey(key)!;
        if (x.owner === "king") continue;
        if (go(key)) return;
        issue({ kind: "claimHolding", holding: x.id });
        return;
      }
      const g = w.holdingByKey("greyshaw")!;
      for (const p of g.plots) if (p.stage === "empty" || p.stage === "harvested" || p.stage === "spoiled") issue({ kind: "sow", plot: p.id, crop: "rye" });
      if (go("greyshaw")) return;
      if (w.king.task !== "forage") issue({ kind: "forage" });
      return;
    }
    if (h.owner === null && h.kind === "hamlet" && !bot.rallied.has(here) && e.stocks.levy < 12) {
      if (w.king.task !== "rally") issue({ kind: "rally" });
      return;
    }
    if (h.owner === null && issue({ kind: "claimHolding", holding: here })) return;
    if (e.stocks.levy >= 4) {
      const own = armiesOf(w, KING_PLAYER).find((a) => standsIn(a.mover) === here && a.company === 0);
      if (own) { issue({ kind: "kingJoin", army: own.id }); return; }
      issue({ kind: "recruit", at: here, army: 0, unit: "line", levy: true });
      return;
    }
    if (w.king.task === "none") issue({ kind: "forage" });
    return;
  }
  armyExercises(w, out, bot, army);
  // The seasonal muster brings more followers than the stores can feed: past what his army needs they are raised
  // as a levy, marched to the next holding not his and sent home from there -- dismissed men eat their own bread
  // (the story playthrough's housekeeping).
  for (const a of armiesOf(w, KING_PLAYER)) {
    if (a.id === w.king.army || a.id === bot.spare || a.company !== 0) continue;
    const at = standsIn(a.mover);
    // One of them stands garrison in his capital: a town with nobody in it is taken by the first host to walk in.
    const cap = w.holding(w.story!.capital);
    if (a.id === bot.toCapital) {
      if (!cap || cap.owner !== "king") bot.toCapital = 0;
      else if (at === cap.id && a.posture !== "hold") issue({ kind: "garrison", army: a.id });
      else if (at !== cap.id && a.mover.route.length === 0) issue({ kind: "marchArmy", army: a.id, to: cap.id });
      continue;
    }
    if (cap && cap.owner === "king" && cap.garrison.length === 0 && bot.toCapital === 0) {
      if (issue({ kind: "marchArmy", army: a.id, to: cap.id })) { bot.toCapital = a.id; continue; }
    }
    // Out on the road, or at a holding not his: sent home from where they stand, the grain with them.
    if (at === 0 || (w.holding(at) as Holding).owner !== "king") { issue({ kind: "disband", army: a.id }); continue; }
    if (a.mover.route.length > 0 || a.target !== 0) continue;
    const to = nearestFor(w, a);
    if (to) issue({ kind: "marchArmy", army: a.id, to });
    else issue({ kind: "disband", army: a.id });
  }
  if (bot.toCapital !== 0 && !armyById(w, bot.toCapital)) bot.toCapital = 0;
  if (here !== 0 && e.stocks.levy >= 8 && army.squads.length < 4) {
    issue({ kind: "recruit", at: here, army: army.id, unit: army.squads.length % 2 ? "slinger" : "line", levy: true });
  } else if (here !== 0 && e.stocks.levy > 12 && (w.holding(here) as Holding).owner === "king") {
    // Followers waiting in camp eat the stores' bread: every season's surplus is raised the day he is in a town of his.
    const room = 5 - armiesOf(w, KING_PLAYER).length;
    for (let i = 0; i < 3 && i < room; i++) issue({ kind: "recruit", at: here, army: 0, unit: "line", levy: true });
  }
  if (here !== 0 && (w.holding(here) as Holding).owner === null) issue({ kind: "claimHolding", holding: here });
  // His capital lost (a revolt, a captain's host): before anything else he rides home and takes it back -- a month
  // without it and the chronicle closes.
  const lost = lostCapital(w);
  if (lost !== 0) {
    if (here !== lost && (bot.target !== lost || w.king.mover.route.length === 0)) { bot.target = lost; issue({ kind: "moveKing", to: lost }); }
    return;
  }
  const enc = armedEncounter(w);
  if (enc !== 0) {
    if (here !== enc && (bot.target !== enc || w.king.mover.route.length === 0)) { bot.target = enc; issue({ kind: "moveKing", to: enc }); }
    return;
  }
  if (sitting(w)) {
    // Home to the capital, and dig in there (a town left empty is taken by the first host to walk in).
    const cap = w.story!.capital;
    if (cap !== 0 && here !== cap && w.king.mover.route.length === 0) issue({ kind: "moveKing", to: cap });
    if (cap !== 0 && here === cap && army.posture !== "hold") issue({ kind: "garrison", army: army.id });
    return;
  }
  if (here === 0 && w.king.mover.route.length === 0) {
    bot.target = nextTarget(w);
    if (bot.target !== 0) issue({ kind: "moveKing", to: bot.target });
  }
  if (here !== 0 && (bot.target === 0 || here === bot.target || w.holding(bot.target)?.owner === "king")) {
    bot.target = nextTarget(w);
    if (bot.target !== 0) issue({ kind: "moveKing", to: bot.target });
    bot.stuck = 0;
  } else if (here !== 0 && bot.target !== 0 && ++bot.stuck > 5) {
    bot.target = nextTarget(w);
    if (bot.target) issue({ kind: "moveKing", to: bot.target });
    bot.stuck = 0;
  }
}

/**
 * The realm's housekeeping, and every lever of the holding and politics
 * cards pulled now and then: builds (a tavern and a barracks among them),
 * taxes, justice, feasts, pardons, auto-resow switched off and on again with
 * hand-sowing between, the free companies, the defence tools.
 */
function steward(w: KingdomWorld, out: KingdomOrder[], bot: Bot): void {
  const issue = (body: KingdomOrderBody): boolean => make(w, out, bot, body);
  const mine = w.holdingsOf("king");
  let built = false;
  for (const h of mine) {
    for (const b of ["granary", "farm", "tavern", "barracks", "shrine", "watchtower", "palisade"] as const) {
      if (h.buildings.includes(b)) continue;
      // One barracks and one tavern in the realm: a barracks doubles a town's muster, and every follower eats.
      if ((b === "barracks" || b === "tavern") && mine.some((x) => x.buildings.includes(b))) continue;
      // And the barracks only once the realm is old enough to feed a bigger muster.
      if (b === "barracks" && w.date.day < 600) continue;
      if (issue({ kind: "build", holding: h.id, building: b })) { built = true; break; }
    }
    if (built) break;
  }
  for (const h of mine) {
    if (h.unrest >= 450 && issue({ kind: "pardon", holding: h.id })) continue;
    if (h.unrest >= 350) issue({ kind: "holdFestival", holding: h.id });
  }
  if (mine.length === 0) return;
  const first = mine[0];
  const e = w.economy[KING_PLAYER];
  // The levers below wait until the realm can bear them: three holdings and a full granary.
  const established = w.date.day > 200 && mine.length >= 3 && e.stocks.grain > 1500;
  // Courts everywhere -- coin is plentiful and every day of them calms a town -- but one town's justices sent home
  // for a day now and then (the next day's round sits them again); and in famine, no tax.
  for (const h of mine) {
    if (h.justice !== "courts" && e.stocks.coin > 50) issue({ kind: "setJustice", holding: h.id, justice: "courts" });
    if (h.famine > 0 && h.tax !== "none") issue({ kind: "setTax", holding: h.id, rate: "none" });
    if (h.famine === 0 && h.tax === "none" && h !== mine[1]) issue({ kind: "setTax", holding: h.id, rate: "normal" });
  }
  // The defence tools, when a host is heard of riding at one of his towns -- sparingly: a levy is more mouths, and
  // burnt fields are a winter's bread.
  for (const r of w.rumours) {
    if (r.target === w.story!.capital && every(w, bot, "levy-capital", 30)) issue({ kind: "callLevy", holding: r.target });
    if (r.target === w.story!.capital) continue;
    if (every(w, bot, "levy", 360)) { if (!issue({ kind: "callLevy", holding: r.target })) bot.last.delete("levy"); }
    if (w.date.day > 150 && every(w, bot, "burn", 100000)) { if (!issue({ kind: "burnFields", holding: r.target })) bot.last.delete("burn"); }
  }
  // No host ever rode at a town of his but the capital: the scorched-earth lever is pulled once anyway, on his last town.
  if (w.date.day > 900 && mine.length >= 2 && !bot.last.has("burn")) {
    if (issue({ kind: "burnFields", holding: mine[mine.length - 1].id })) bot.last.set("burn", w.date.day);
  }
  if (!established) return;
  if (mine.length >= 2 && every(w, bot, "tax", 60)) {
    const h = mine[1];
    issue({ kind: "setTax", holding: h.id, rate: h.tax === "low" ? "normal" : "low" });
  }
  if (mine.length >= 2 && every(w, bot, "justice", 70)) issue({ kind: "setJustice", holding: mine[mine.length - 1].id, justice: "none" });
  if (every(w, bot, "feast", 300)) {
    if (!issue({ kind: "holdFestival", holding: first.id })) bot.last.delete("feast");
  }
  if (every(w, bot, "pardon", 300)) {
    if (!issue({ kind: "pardon", holding: first.id })) bot.last.delete("pardon");
  }
  // Auto-resow off on one holding's fields, sown by hand while off, then on again.
  const handH = mine[mine.length - 1];
  const handDay = w.date.day % 180;
  if (handDay === 10) issue({ kind: "setAutoSow", holding: handH.id, plot: 0, crop: null });
  if (handDay > 10 && handDay < 60) {
    for (const p of handH.plots) {
      if (p.stage === "empty" || p.stage === "harvested" || p.stage === "spoiled") {
        if (!issue({ kind: "sow", plot: p.id, crop: "rye" })) issue({ kind: "sow", plot: p.id, crop: "wheat" });
      }
    }
  }
  if (handDay === 60) issue({ kind: "setAutoSow", holding: 0, plot: 0, crop: "rye" });
  // A ripe field is reaped the day it ripens (ECON), so a hand harvest rarely finds one; it is asked anyway.
  for (const h of mine) for (const p of h.plots) if (p.stage === "ripe") issue({ kind: "harvest", plot: p.id });
  if (every(w, bot, "harvest-ask", 180)) make(w, out, bot, { kind: "harvest", plot: first.plots[0]?.id ?? 0 }, true);
  // Free companies: sign one drinking at a tavern of his, keep it, renew it.
  let hired = w.companies.some((c) => c.state === "hired");
  for (const c of w.companies) {
    // One company at most, and only with bread to spare: a company eats and is paid every day.
    // A turncoat company first (the crown bids for it soon: a bid to match), any other only later.
    const turncoat = MERCENARIES[c.index].reputation === "turncoats";
    if (!hired && c.state === "offered" && w.date.day > (turncoat ? 360 : 900) && e.stocks.grain > 10000) {
      hired = issue({ kind: "hireCompany", company: c.index, at: c.at });
    }
    if (c.state === "hired") {
      issue({ kind: "matchBid", company: c.index });
      // Kept while the stores can feed it; past that, its contract runs out -- or, hungrier still, it is sent away.
      if ((e.stocks.grain > 6000 || !bot.last.has("renewed")) && issue({ kind: "renewContract", company: c.index })) bot.last.set("renewed", w.date.day);
      if (e.stocks.grain < 3000) {
        const camp = w.armies.find((a) => a.owner === KING_PLAYER && a.company === c.index + 1);
        if (camp && camp.id !== w.king.army) issue({ kind: "disband", army: camp.id });
      }
    }
  }
}

/**
 * What the army cards offer beyond marching: a squad split off his army, that
 * army's doctrine, rest, garrison, patrol, ambush, a chase of a hostile host,
 * and its march back to merge; trained recruits at a barracks; a battle
 * ability bought.
 */
function armyExercises(w: KingdomWorld, out: KingdomOrder[], bot: Bot, army: Army): void {
  const issue = (body: KingdomOrderBody): boolean => make(w, out, bot, body);
  const here = kingAt(w);
  if (here !== 0 && (w.holding(here) as Holding).buildings.includes("barracks") && every(w, bot, "trained", 120)) {
    if (!issue({ kind: "recruit", at: here, army: army.id, unit: "archer", levy: false })) bot.last.delete("trained");
  }
  if (w.date.day > 300 && every(w, bot, "ability", 100000)) {
    let done = false;
    for (const ab of ABILITY_IDS) if (!done) done = issue({ kind: "unlockAbility", army: army.id, ability: ab });
    if (!done) bot.last.delete("ability");
  }
  const spare = bot.splitSquad ? w.armies.find((a) => a.owner === KING_PLAYER && a.squads.some((q) => q.id === bot.splitSquad)) : undefined;
  if (spare && spare.id !== army.id) bot.spare = spare.id;
  if (!spare || spare.id === army.id) {
    bot.spare = 0;
    bot.splitSquad = 0;
    if (here !== 0 && army.squads.length >= 3 && w.date.day > 150 && every(w, bot, "split", 90)) {
      const q = army.squads[army.squads.length - 1].id;
      if (issue({ kind: "split", army: army.id, squads: [q] })) {
        bot.splitSquad = q;
        bot.last.set("spare-born", w.date.day);
        // In the same tick, both standing here: the king rides with the new army a moment, then back with his own.
        // The new army's id is the counter's next (checked by the follower's hash, whatever it turns out to be).
        if (every(w, bot, "join", 100000)) {
          make(w, out, bot, { kind: "kingJoin", army: w.nextId }, true);
          make(w, out, bot, { kind: "kingJoin", army: army.id }, true);
        }
      } else bot.last.delete("split");
    }
    return;
  }
  const at = standsIn(spare.mover);
  const age = w.date.day - (bot.last.get("spare-born") ?? w.date.day);
  if (age === 1) issue({ kind: "setDoctrine", army: spare.id, doctrine: DOCTRINE_IDS[(DOCTRINE_IDS.indexOf(spare.doctrine) + 1) % DOCTRINE_IDS.length] });
  if (age === 2 && at) issue({ kind: "recover", army: spare.id });
  if (age === 4 && at) issue({ kind: "garrison", army: spare.id });
  if (age === 6) {
    const mine = w.holdingsOf("king").map((h) => h.id);
    if (at && mine.length >= 2) issue({ kind: "patrol", army: spare.id, holdings: [at, mine.find((x) => x !== at)!] });
  }
  // Off its patrol (halted where it is, mid-road as like as not), marched to the nearest town of his, and lying in
  // wait there: an ambush is laid standing, not on the road.
  if (age === 10) issue({ kind: "haltArmy", army: spare.id });
  const laid = bot.last.has("lay-" + spare.id);
  if (age === 11) {
    let best = 0;
    let eta = Infinity;
    for (const h of w.holdingsOf("king")) {
      const p = planArmyRoute(w, spare, h.id);
      if (p && p.etaTicks < eta) { eta = p.etaTicks; best = h.id; }
    }
    if (best && best !== at) issue({ kind: "marchArmy", army: spare.id, to: best });
  }
  if (age > 11 && age < 36 && !laid && spare.mover.road === 0 && spare.mover.route.length === 0) {
    if (issue({ kind: "ambush", army: spare.id })) bot.last.set("lay-" + spare.id, w.date.day);
  }
  if (age >= 36 && age < 50 && !bot.last.has("chase-" + spare.id)) {
    for (const a of w.armies) {
      if (a.owner === KING_PLAYER) continue;
      if (issue({ kind: "intercept", army: spare.id, target: a.id })) { bot.last.set("chase-" + spare.id, w.date.day); break; }
    }
  }
  if (age === 50) {
    const home = w.holdingsOf("king")[0];
    if (home) issue({ kind: "marchArmy", army: spare.id, to: home.id });
  }
  if (age >= 55 && every(w, bot, "merge", 5)) {
    if (!issue({ kind: "merge", army: spare.id, into: army.id })) {
      if (age > 85) { issue({ kind: "disband", army: spare.id }); }
    }
  }
}

// -- a session: one leader, any number of followers ---------------------------------------------

/** A follower: a world that only ever receives the leader's orders, and how it receives them. */
type Follower = {
  name: string;
  w: KingdomWorld;
  /** Orders in flight to it: delivered (submitted) on the tick given, before it runs that tick. */
  inbox: { at: number; order: KingdomOrder }[];
  /** How a tick's batch reaches it. */
  deliver: (batch: readonly KingdomOrder[], now: number) => { at: number; order: KingdomOrder }[];
  diverged: number;
  compared: number;
  /** K12: under an input delay the full hash would differ while orders are in flight; ticks it would have (wrongly) cried desync. */
  falseAlarms: number;
  /** Retired (compared no more) once the leader passes this tick: a loaded world need only prove it carries on. */
  until: number;
};

type Session = {
  leader: KingdomWorld;
  bot: Bot;
  followers: Follower[];
  /** Every order the leader was given, as stamped -- the wire. */
  wire: KingdomOrder[];
  /** Hooks a section adds: run before the tick, with the batch about to go out. */
  before?: (s: Session, batch: KingdomOrder[]) => void;
  /** Followers past their `until`. */
  retired: Follower[];
  /** Ticks the leader ran. */
  ticks: number;
  /** Ticks spent with a contact waiting (the held realm). */
  held: number;
  contactsSeen: number;
};

function follower(name: string, w: KingdomWorld, deliver: Follower["deliver"]): Follower {
  return { name, w, inbox: [], deliver, diverged: -1, compared: 0, falseAlarms: 0, until: Infinity };
}

/**
 * A follower made from a save of the leader taken in a `before` hook: the
 * save already holds the orders the leader has queued, so the wire must not
 * hand it those again (a transport that delivered a message twice would be
 * a transport bug, not the sim's).
 */
function loadedFollower(name: string, from: KingdomWorld): Follower {
  const back = loadFromJson(saveToJson(from));
  if (!back.ok) throw new Error("save did not load: " + back.error);
  const had = new Set(from.orders.queued().map((o) => o.player + ":" + o.seq));
  return follower(name, back.value, (batch, now) => inOrder(batch.filter((o) => !had.has(o.player + ":" + o.seq)), now));
}

/** Deliver at once, in the order issued (the plain wire). */
const inOrder = (batch: readonly KingdomOrder[], now: number): { at: number; order: KingdomOrder }[] => batch.map((order) => ({ at: now, order }));

/**
 * Run the leader `days` days (or to the story's end), its orders out to every
 * follower and every follower's hash compared with the leader's after every
 * tick. `delay`: orders are stamped that many ticks ahead, the netplay input
 * delay (a contact is settled at once: the held realm does not move the clock).
 */
function run(s: Session, days: number, delay = 0): void {
  const w = s.leader;
  const end = w.now + days * TICKS_PER_DAY;
  while (w.now < end && w.story!.ending === null) {
    const batch: KingdomOrder[] = [];
    if (w.contact) {
      s.held++;
      settle(w, batch, s.bot);
    } else if (w.now % TICKS_PER_DAY === 1) {
      const raw: KingdomOrder[] = [];
      decide(w, raw, s.bot);
      if (delay === 0) batch.push(...raw);
      else {
        // Re-stamp for later: take the leader's orders back out of its queue and send them `delay` ticks on.
        const keep = new Set(raw.map((o) => o.player + ":" + o.seq));
        const queued = w.orders.queued().filter((o) => !keep.has(o.player + ":" + o.seq));
        const later = raw.map((o) => ({ ...o, tick: o.tick + delay }));
        w.orders.restore([...queued, ...later], w.orders.sequences());
        batch.push(...later);
      }
    }
    s.before?.(s, batch);
    s.wire.push(...batch);
    const was = w.contact;
    const t0 = w.now;
    const events = w.tick();
    s.ticks++;
    if (!was && w.contact) s.contactsSeen++;
    for (const ev of events) {
      if (ev.kind === "rallyDone") s.bot.rallied.add(ev.holding);
      if (ev.kind === "orderRejected") {
        const k = ev.order.kind as KingdomOrderKind;
        if (ev.order.player === KING_PLAYER) s.bot.accepted.set(k, (s.bot.accepted.get(k) ?? 0) - 1);
      }
    }
    for (const o of batch) {
      // Counted when applied; a rejection above takes it back off. A delayed order counts the tick it was sent.
      s.bot.accepted.set(o.kind, (s.bot.accepted.get(o.kind) ?? 0) + 1);
    }
    const lh = peerHash(w);
    const full = kingdomHash(w);
    for (const f of s.followers) {
      // The leader's tick t0 (a held tick does not move its clock): what has reached the follower by then, it runs with.
      f.inbox.push(...f.deliver(batch, t0));
      const due = f.inbox.filter((x) => x.at <= t0);
      f.inbox = f.inbox.filter((x) => x.at > t0);
      f.w.tick(due.map((x) => x.order));
      if (f.diverged >= 0) continue;
      f.compared++;
      if (peerHash(f.w) !== lh) f.diverged = w.now;
      else if (kingdomHash(f.w) !== full) f.falseAlarms++;
    }
    for (const f of s.followers.filter((x) => w.now > x.until)) s.retired.push(f);
    s.followers = s.followers.filter((x) => w.now <= x.until);
  }
}

function newSession(): Session {
  return { leader: new KingdomWorld({ seed: SEED, ...CONFIG }), bot: newBot(), followers: [], retired: [], wire: [], ticks: 0, held: 0, contactsSeen: 0 };
}

// -- the state sweep ------------------------------------------------------------------------------
//
// Every leaf of the world's state, nudged in turn (a number by 0.0001, a
// boolean flipped, a string altered) and the hash asked whether it saw. A
// number the hash cannot see at 0.0001 must be an integer by the sim's own
// rules (it is mixed as a 32-bit integer) -- so it is nudged by 1 too, and the
// run checks it really is an integer every time the sweep looks. Anything the
// hash cannot see at all is state two peers could disagree on silently.

/** Content copied onto the records for convenience: fixed by the map, not state (the map's fingerprint is hashed). */
const CONTENT = new Set([
  "holdings[].name", "holdings[].province", "holdings[].kind", "holdings[].biome",
  // A company's index is its place in world.companies (the table's order), which the hash walks in order.
  "companies[].index",
]);

/**
 * Every own field of a KingdomWorld that the sweep does not walk, and why the
 * hash need not see it. The run checks the world has no field outside the
 * sweep's roots and this list, so a field added later must be placed in one
 * or the other -- a new field nobody thought to hash is exactly the silent
 * desync this tool exists to catch.
 */
const NOT_SWEPT: Readonly<Record<string, string>> = {
  map: "mixed as content: its id, and the graph's positions and lengths",
  hosts: "configuration read only by the constructor (the opening hosts); inert after it, and carried by the save",
  rng: "mixed: every kingdom stream's snapshot (KINGDOM_STREAMS)",
  orders: "mixed by kingdomHash (the queue, the sequence counters); left out of peerHash while in flight",
  log: "the king's applied orders, a replay's input: never read by the sim, carried by the save",
  events: "this tick's notices to the UI and the chronicle: cleared every tick, never read back",
  aiOrders: "the AI's orders of the day, for the audit hook: also in the queue (and then state), never read back",
  onAi: "a test hook (a function), never set by the game",
  placesCache: "derived from the map (the AI's places), rebuilt on demand",
  graph: "derived from the map and the roads (the road states are mixed)",
  byKey: "derived: holdings by their map key",
};

/** The world's own scalar fields (the rest of the roots are walked). */
const SCALARS = ["seed", "now", "nextId", "weather", "captains", "autoFarm", "epoch"];

type Leaf = { path: string; get: () => unknown; set: (v: unknown) => void };

function stateRoots(w: KingdomWorld): Record<string, unknown> {
  return {
    seed: w.seed, now: w.now, nextId: w.nextId, weather: w.weather,
    holdings: w.holdings, roads: w.roads, king: w.king, armies: w.armies, companies: w.companies,
    contact: w.contact, disengaged: w.disengaged, economy: w.economy, books: w.books, explore: w.explore,
    minds: w.minds, intel: w.intel, wavesRode: w.wavesRode, rumours: w.rumours, burned: w.burned, levied: w.levied,
    story: w.story, captains: w.captains, autoFarm: w.autoFarm, epoch: w.epoch,
  };
}

function leaves(w: KingdomWorld): Leaf[] {
  const out: Leaf[] = [];
  const roots = stateRoots(w);
  const scalar = (k: string): Leaf => ({ path: k, get: () => (w as unknown as Record<string, unknown>)[k], set: (v) => { (w as unknown as Record<string, unknown>)[k] = v; } });
  for (const k of SCALARS) out.push(scalar(k));
  const walk = (o: unknown, path: string, pattern: string): void => {
    if (o === null || typeof o !== "object") return;
    const rec = o as Record<string, unknown>;
    const keys = Array.isArray(o) ? o.map((_, i) => String(i)) : Object.keys(rec);
    for (const k of keys) {
      const p = path + (Array.isArray(o) ? "[" + k + "]" : "." + k);
      const pat = pattern + (Array.isArray(o) ? "[]" : "." + k);
      if (CONTENT.has(pat)) continue;
      const v = rec[k];
      if (v !== null && typeof v === "object") walk(v, p, pat);
      else if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") {
        out.push({ path: p + "\u0000" + pat, get: () => rec[k], set: (x) => { rec[k] = x; } });
      }
    }
  };
  for (const [k, v] of Object.entries(roots)) {
    if (SCALARS.includes(k)) continue;
    walk(v, k, k);
  }
  return out;
}

type SweepReport = { leaves: number; blind: Set<string>; asInts: Set<string>; fractional: Set<string> };

function sweep(w: KingdomWorld, into: SweepReport): void {
  const base = kingdomHash(w);
  // Every leaf is checked for being what its hashing assumes; a few of each kind (the first, a middle and the last
  // of a list) are nudged -- the hash walks a list uniformly, so three of a pattern stand for all of it.
  const all = leaves(w);
  const byPattern = new Map<string, Leaf[]>();
  for (const leaf of all) {
    const pattern = leaf.path.split("\u0000")[1] ?? leaf.path;
    const list = byPattern.get(pattern) ?? [];
    list.push(leaf);
    byPattern.set(pattern, list);
  }
  const sample: Leaf[] = [];
  for (const list of byPattern.values()) {
    const picks = new Set([0, list.length >> 1, list.length - 1]);
    for (const i of picks) sample.push(list[i]);
  }
  for (const leaf of sample) {
    const [, pattern = leaf.path] = leaf.path.split("\u0000");
    const v = leaf.get();
    into.leaves++;
    let seen = false;
    if (typeof v === "number") {
      leaf.set(v + 0.0001);
      seen = kingdomHash(w) !== base;
      if (!seen) {
        if (!Number.isInteger(v)) into.fractional.add(pattern + " = " + v);
        leaf.set(v + 1);
        if (kingdomHash(w) !== base) { into.asInts.add(pattern); seen = true; }
      }
    } else if (typeof v === "boolean") {
      leaf.set(!v);
      seen = kingdomHash(w) !== base;
    } else if (typeof v === "string") {
      leaf.set(v + "~");
      seen = kingdomHash(w) !== base;
    }
    leaf.set(v);
    if (!seen) into.blind.add(pattern);
  }
  for (const [pattern, list] of byPattern) {
    if (!into.asInts.has(pattern)) continue;
    for (const leaf of list) {
      const v = leaf.get();
      if (typeof v === "number" && !Number.isInteger(v)) into.fractional.add(pattern + " = " + v);
    }
  }
  if (kingdomHash(w) !== base) throw new Error("the sweep left the world changed");
}

// =================================================================================================

console.log("kingdom lockstep: one order log, many peers (seed 0x" + SEED.toString(16) + ")");

// -- 1, 2, 4: the main session ------------------------------------------------------------------

section("1. two peers, one order log, several years (captains, invasions, story)");
const main = newSession();
const net = wire(0x5eed);
main.followers.push(follower("in order", new KingdomWorld({ seed: SEED, ...CONFIG }), inOrder));
main.followers.push(follower("shuffled within the tick", new KingdomWorld({ seed: SEED, ...CONFIG }),
  (batch, now) => shuffled(batch, net).map((order) => ({ at: now, order }))));
const sweepReport: SweepReport = { leaves: 0, blind: new Set(), asInts: new Set(), fractional: new Set() };
const saves: string[] = [];
let savedInContact = false;
let nudge: { caught: number; clean: boolean; fields: string[] } | null = null;
main.before = (s, batch) => {
  const w = s.leader;
  const day = w.date.day;
  const first = w.now % TICKS_PER_DAY === 0;
  // 4: a save -> load joins the run as one more follower: mid-season every season, and the first time a contact waits.
  const atContact = w.contact !== null && !savedInContact;
  if ((first && day % 90 === 47) || atContact) {
    if (atContact) savedInContact = true;
    const f = loadedFollower("loaded day " + day + (atContact ? " (contact waiting)" : ""), w);
    // Two months on is long enough to prove a loaded world carries on: a season's turn, a muster, the AI's goals.
    f.until = w.now + 60 * TICKS_PER_DAY;
    s.followers.push(f);
    saves.push(f.name);
    if (kingdomHash(f.w) !== kingdomHash(w)) saveMismatch.push(day + ": the loaded hash differs");
    if (JSON.stringify(stateRoots(f.w)) !== JSON.stringify(stateRoots(w))) {
      saveMismatch.push(day + ": " + firstDifference(stateRoots(f.w), stateRoots(w)));
    }
  }
  // 4: the realm saves and loads the tick after every contact is settled (K12 found an outright win leaving the
  // fallen host named in the disengaged pairs, which the save refuses).
  if (!w.contact && hadContact) {
    afterContact.n++;
    const r = loadFromJson(saveToJson(w));
    if (!r.ok) afterContact.bad.push(day + ": " + r.error);
  }
  // And at the turn of every day: a save the realm refuses is a game that cannot be resumed, nor a peer resynchronised.
  if (first) {
    daily.n++;
    const r = loadFromJson(saveToJson(w));
    if (!r.ok) daily.bad.push(day + ": " + r.error);
  }
  hadContact = w.contact !== null;
  // 4: an army that falls back off its patrol -- on a fork, so the main run is untouched (see patrolFallsBack).
  if (w.contact && patrolFork === null) patrolFork = patrolFallsBack(w);
  // 3: the sweep, every half-year, on the leader itself (every leaf restored before the tick).
  if (first && day % 120 === 100) sweep(w, sweepReport);
  // 3: the nudge, once, on a pair of extra peers built from the log so far.
  if (first && day === 400 && !nudge) nudge = nudgeTest(s, batch);
};
const saveMismatch: string[] = [];
let patrolFork: string | null = null;
let hadContact = false;
const afterContact = { n: 0, bad: [] as string[] };
const daily = { n: 0, bad: [] as string[] };

/**
 * K12 found it: an army that fell back from a contact (withdrew, or fled the
 * field) had its posture set by hand in descent.ts, not through setPosture --
 * so a patrolling army kept its patrol list, and a garrison its place in the
 * holding's garrison, while it marched off. The save refuses both ("patrols
 * without a patrol", "a garrison that is not ... holding there"), so the game
 * could not be resumed and a peer could not be resynchronised from it. At the
 * first field contact of the king's army a fork of the leader is put on
 * patrol (as the patrol order would: the state an army meeting a host on its
 * rounds is in), checked to save, and withdrawn; its save must load and carry
 * on identical. Null until such a contact comes; the main run is untouched.
 */
function patrolFallsBack(w: KingdomWorld): string | null {
  const c = w.contact!;
  const a = c.kind === "field" && c.sides[0].faction === KING_PLAYER ? armyById(w, c.sides[0].army) : undefined;
  const mine = w.holdingsOf("king");
  if (!a || mine.length < 2) return null;
  const fork = loadFromJson(saveToJson(w));
  if (!fork.ok) return "the fork did not load: " + fork.error;
  const f = fork.value;
  // The leader has already queued its own settling of this contact (settle runs before the hook): not on the fork.
  f.orders.restore(f.orders.queued().filter((o) => o.kind !== "resolveContact"), f.orders.sequences());
  const fa = armyById(f, a.id)!;
  fa.posture = "patrol";
  fa.postureDays = 0;
  fa.patrol = [mine[0].id, mine[1].id];
  fa.patrolIndex = 0;
  const before = loadFromJson(saveToJson(f));
  if (!before.ok) return "a patrolling army in a contact does not save: " + before.error;
  const withdraw = { kind: "resolveContact", contact: c.id, choice: "withdraw", result: null } as const;
  if (checkContactOrder(f, withdraw, KING_PLAYER) !== null) return null;
  f.issue(withdraw);
  const fell = f.tick().some((e) => e.kind === "fellBack" && e.army === a.id);
  const after = armyById(f, a.id);
  if (!after || !fell) return null;
  if (after.posture !== "patrol" && after.patrol.length > 0) return "the army fell back still holding its patrol";
  const back = loadFromJson(saveToJson(f));
  if (!back.ok) return "the save after the withdrawal does not load: " + back.error;
  for (let i = 0; i < 10 * TICKS_PER_DAY; i++) {
    f.tick();
    back.value.tick();
    if (kingdomHash(f) !== kingdomHash(back.value)) return "the loaded fork diverged";
  }
  return "ok: " + a.name + " fell back off its patrol on day " + w.date.day;
}

function firstDifference(a: unknown, b: unknown, path = ""): string {
  if (JSON.stringify(a) === JSON.stringify(b)) return "";
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return path + ": " + JSON.stringify(a)?.slice(0, 80) + " vs " + JSON.stringify(b)?.slice(0, 80);
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  for (const k of [...new Set([...ka, ...kb])]) {
    const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path + "." + k);
    if (d) return d;
  }
  return path + ": key order";
}

/**
 * Two fresh peers replayed from the wire so far, tick by tick, then one is
 * nudged by 0.0001 -- the king's grain, a town's people, a field's growth, a
 * marching army's place on its road, in turn -- and the next check must see it.
 */
function nudgeTest(s: Session, pending: readonly KingdomOrder[]): { caught: number; clean: boolean; fields: string[] } {
  const peer = (): KingdomWorld => {
    const p = new KingdomWorld({ seed: SEED, ...CONFIG });
    for (const o of [...s.wire, ...pending]) p.submit(o);
    while (p.now < s.leader.now) p.tick();
    return p;
  };
  const a = peer();
  const clean = kingdomHash(a) === kingdomHash(s.leader);
  const fields: string[] = [];
  let caught = 0;
  const tries: [string, (w: KingdomWorld) => boolean][] = [
    ["the king's grain", (w) => { w.economy[KING_PLAYER].stocks.grain += 0.0001; return true; }],
    ["a town's people", (w) => { const h = w.holdingsOf("king")[0]; if (!h) return false; h.population += 0.0001; return true; }],
    ["a field's growth", (w) => { for (const h of w.holdings) for (const p of h.plots) if (p.stage === "growing") { p.progress += 0.0001; return true; } return false; }],
    ["an army's place on its road", (w) => { const x = w.armies.find((q) => q.mover.road !== 0); if (!x) return false; x.mover.along += 0.0001; return true; }],
    ["the king's legitimacy", (w) => { w.economy[KING_PLAYER].legitimacy += 0.0001; return true; }],
  ];
  for (const [name, poke] of tries) {
    const b = peer();
    if (!poke(b)) { fields.push(name + " (nothing to nudge)"); continue; }
    fields.push(name);
    if (kingdomHash(b) !== kingdomHash(a)) caught++;
  }
  return { caught, clean, fields };
}

run(main, DAYS);
const L = main.leader;
const years = (L.date.day / 360).toFixed(1);
console.log("  ran " + main.ticks + " ticks (" + L.date.day + " days, " + years + " years), " + main.wire.length + " orders on the wire, " +
  main.contactsSeen + " contacts (" + main.held + " held ticks), " + main.bot.battles + " real battles; story " + (L.story!.ending ?? "act " + L.story!.act));
for (const f of main.followers.slice(0, 2)) {
  check("follower '" + f.name + "' matches the leader after every tick", f.diverged < 0 && f.compared > 0,
    f.diverged >= 0 ? "diverged at tick " + f.diverged : f.compared + " comparisons");
}
check("the run lasted several years with the realm alive", L.date.day >= 360 * 2, L.date.day + " days");
const aiArmies = L.armies.filter((a) => a.owner !== KING_PLAYER).length;
const waves = L.wavesRode.filter(Boolean).length;
check("the captains' AI ran and the invasions rode", L.captains && aiArmies > 0 && waves > 0, aiArmies + " captains' armies, " + waves + " waves rode");
const kinds = KINGDOM_ORDER_KINDS.filter((k) => (main.bot.issued.get(k) ?? 0) > 0);
check("every order kind went over the wire", kinds.length === KINGDOM_ORDER_KINDS.length,
  "missing: " + KINGDOM_ORDER_KINDS.filter((k) => !kinds.includes(k)).join(", "));
const applied = KINGDOM_ORDER_KINDS.filter((k) => (main.bot.accepted.get(k) ?? 0) > 0);
// A ripe field is reaped by itself the day it ripens (ECON), so a hand harvest is the one kind that may only ever be refused.
const mustApply = KINGDOM_ORDER_KINDS.filter((k) => k !== "harvest");
check("every order kind but the hand harvest was applied at least once", mustApply.every((k) => applied.includes(k)),
  "never applied: " + mustApply.filter((k) => !applied.includes(k)).join(", ") + "; applied " + applied.length + "/" + KINGDOM_ORDER_KINDS.length);
const contactChoices = new Set(main.wire.filter((o) => o.kind === "resolveContact").map((o) => (o as { choice: string }).choice));
check("descent results of several kinds went over the wire", contactChoices.has("fight") && contactChoices.has("auto") && contactChoices.size >= 3,
  [...contactChoices].join(", "));
check("the king's log is the wire (every order the leader applied was sent)",
  L.log.every((o) => main.wire.some((x) => x.player === o.player && x.seq === o.seq)), L.log.length + " logged");

section("2. arrival order changes nothing");
{
  const shuffledF = main.followers[1];
  check("orders shuffled within each tick: identical every tick", shuffledF.diverged < 0, shuffledF.compared + " comparisons");
  // The whole wire submitted up front, backwards, and the world run to the leader's tick.
  const back = new KingdomWorld({ seed: SEED, ...CONFIG });
  for (const o of [...main.wire].reverse()) back.submit(o);
  while (back.now < L.now) back.tick();
  while (back.contact && back.orders.queued().some((o) => o.tick <= back.now)) back.tick();
  check("the whole log submitted backwards up front reproduces the run", kingdomHash(back) === kingdomHash(L), kingdomHash(back) + " vs " + kingdomHash(L));
  // The same whole log, but a peer that receives it in a random order in chunks as it plays.
  const chunky = new KingdomWorld({ seed: SEED, ...CONFIG });
  const scattered = shuffled(main.wire, wire(0xc4a05));
  let k = 0;
  while (chunky.now < L.now) {
    // Every order reaches it by its own tick (lockstep's one rule); otherwise arrival is anyone's guess.
    const due = scattered.filter((o, i) => i >= k && o.tick <= chunky.now);
    const rest = scattered.slice(k).filter((o) => o.tick > chunky.now);
    scattered.splice(k, scattered.length - k, ...shuffled(rest, net));
    chunky.tick(shuffled(due, net));
  }
  while (chunky.contact && chunky.orders.queued().some((o) => o.tick <= chunky.now)) chunky.tick();
  check("the log arriving in random chunks reproduces the run", kingdomHash(chunky) === kingdomHash(L), kingdomHash(chunky) + " vs " + kingdomHash(L));
}

section("2b. an input delay: every order sent three ticks ahead, delivered any time before it falls due");
{
  const s = newSession();
  const roll = wire(0xde1a);
  s.followers.push(follower("delayed and scattered", new KingdomWorld({ seed: SEED, ...CONFIG }),
    (batch, now) => shuffled(batch, roll).map((order) => ({ at: order.tick > now ? now + roll(order.tick - now + 1) : now, order }))));
  let savedQueued = false;
  s.before = (ss) => {
    // A save taken while orders wait in the queue for later ticks.
    if (!savedQueued && ss.leader.orders.size > 0 && ss.leader.date.day > 30 && !ss.leader.contact) {
      savedQueued = true;
      ss.followers.push(loadedFollower("loaded with " + ss.leader.orders.size + " orders queued", ss.leader));
    }
  };
  run(s, 360 * 2, 3);
  const f = s.followers[0];
  check("a delayed, scattered wire keeps the peers identical every tick", f.diverged < 0 && f.compared > 0,
    f.diverged >= 0 ? "diverged at tick " + f.diverged : f.compared + " comparisons, " + s.wire.length + " orders");
  check("the netplay comparison (peerHash) ignores only the orders still in flight", f.falseAlarms > 0,
    "the full hash, which mixes the queue, would have cried desync on " + f.falseAlarms + " of " + f.compared + " ticks");
  // Once the wire has drained, the full hash agrees too: the in-flight orders were the only difference.
  for (const x of f.inbox) f.w.submit(x.order);
  f.inbox = [];
  check("with the wire drained, the full hash (queue and counters) agrees too", kingdomHash(f.w) === kingdomHash(s.leader),
    kingdomHash(f.w) + " vs " + kingdomHash(s.leader));
  const q = s.followers[1];
  check("a save with orders queued for later ticks loads and continues identical", !!q && q.diverged < 0 && q.compared > 0,
    q ? (q.diverged >= 0 ? q.name + " diverged at tick " + q.diverged : q.name + ", " + q.compared + " comparisons") : "never saved");
}

section("3. the detector detects");
{
  const n = nudge as { caught: number; clean: boolean; fields: string[] } | null;
  check("peers rebuilt from the log agree before the nudge", !!n && n.clean);
  const tried = n ? n.fields.filter((f) => !f.includes("nothing to nudge")).length : 0;
  check("a 0.0001 nudge is caught by the next check, every time", !!n && tried >= 4 && n.caught === tried,
    n ? n.caught + "/" + tried + " caught: " + n.fields.join(", ") : "never run");
  check("the sweep nudged every kind of leaf of the state", sweepReport.leaves > 500, sweepReport.leaves + " nudges");
  check("no field of the state is blind to the hash", sweepReport.blind.size === 0, [...sweepReport.blind].join(", "));
  const roots = Object.keys(stateRoots(L));
  const stray = Object.keys(L).filter((k) => !roots.includes(k) && !(k in NOT_SWEPT));
  check("every field of the world is swept or set aside with a reason", stray.length === 0, "neither: " + stray.join(", "));
  console.log("        (set aside, not hashed as state: " + Object.keys(NOT_SWEPT).filter((k) => !/^mixed/.test(NOT_SWEPT[k])).join(", ") + ")");
  // K12 closed this: an integer field used to be mixed by `>>> 0`, blind to a fraction -- 101 fields saw a nudge
  // of 1 but not of 0.0001. Now a value that is not a 32-bit integer mixes its exact bits.
  check("a 0.0001 nudge is seen in every numeric field, the integer ones included", sweepReport.asInts.size === 0,
    "seen only at +1: " + [...sweepReport.asInts].slice(0, 8).join(", "));
  check("every field hashed as an integer held an integer", sweepReport.fractional.size === 0, [...sweepReport.fractional].slice(0, 8).join(", "));
}

section("4. save -> load, then on");
{
  const loaded = [...main.followers.slice(2), ...main.retired];
  check("saved and loaded mid-run, every season and with a contact waiting", loaded.length >= 4 && savedInContact, saves.join("; "));
  const bad = loaded.filter((f) => f.diverged >= 0 || f.compared === 0);
  check("every loaded world continued tick-identical to the end", bad.length === 0,
    bad.map((f) => f.name + (f.diverged >= 0 ? " diverged at tick " + f.diverged : " never compared")).join("; ") || loaded.length + " loads");
  check("the save carries every field of the state", saveMismatch.length === 0, saveMismatch.slice(0, 3).join("; "));
  check("the realm saves and loads the tick after every contact is settled", afterContact.n >= 10 && afterContact.bad.length === 0,
    afterContact.bad.length ? afterContact.bad.length + " of " + afterContact.n + " refused, " + afterContact.bad[0] : afterContact.n + " contacts");
  check("the realm saves and loads at the turn of every day", daily.n >= 700 && daily.bad.length === 0,
    daily.bad.length ? daily.bad.length + " of " + daily.n + " refused, " + daily.bad.slice(0, 2).join("; ") : daily.n + " days");
  check("an army that falls back drops its patrol, and the realm saves and loads after", patrolFork !== null && patrolFork.startsWith("ok"),
    patrolFork ?? "no field contact of his army came");
}

// -- 5: the layer hash with a battle in progress -------------------------------------------------

section("5. the layer hash, a battle in progress");
{
  // Two peers to the first contact of the king's in the field, from the wire alone.
  const s = newSession();
  s.followers.push(follower("peer", new KingdomWorld({ seed: SEED, ...CONFIG }), inOrder));
  s.bot.fight = true;
  let found = false;
  s.before = (ss) => { if (ss.leader.contact && ss.leader.contact.kind === "field" && ss.leader.contact.sides[0].faction === KING_PLAYER) found = true; };
  const w = s.leader;
  while (!found && w.date.day < DAYS && w.story!.ending === null) {
    // One tick at a time, stopping BEFORE the leader settles the contact.
    if (w.contact && w.contact.kind === "field" && w.contact.sides[0].faction === KING_PLAYER) { found = true; break; }
    run(s, 0.125);
  }
  const b = s.followers[0].w;
  check("two peers reach a field contact of the king's together", found && kingdomHash(w) === kingdomHash(b) && !!b.contact,
    found ? "day " + w.date.day + ", contact " + w.contact!.id : "no contact");
  if (found && b.contact) {
    const specA = buildBattleSpec(w, w.contact!);
    const specB = buildBattleSpec(b, b.contact);
    check("both build the same BattleSpec", hashBattleSpec(specA) === hashBattleSpec(specB), hashBattleSpec(specA));
    const fa = fieldOf(specA);
    const fb = fieldOf(specB);
    const fc = fieldOf(specB);
    const cap = battleCap(specA);
    let diverged = -1;
    let compared = 0;
    let caught = -1;
    let attributed = "";
    let t = 0;
    const kA = kingdomHash(w);
    const kB = kingdomHash(b);
    for (; t < cap && !fa.world.outcome; t++) {
      fa.world.step();
      fb.world.step();
      fc.world.step();
      if (t === 200) fc.world.soldiers.x[0] += 0.0001;
      if (t % 20 !== 0) continue;
      compared++;
      const hA = hashWorld(fa.world);
      if (diverged < 0 && layerHash(kA, hA) !== layerHash(kB, hashWorld(fb.world))) diverged = t;
      if (t > 200 && caught < 0) {
        const hC = hashWorld(fc.world);
        if (layerHash(kA, hA) !== layerHash(kB, hC)) {
          caught = t;
          attributed = driftedLayer({ kingdom: kA, battle: hA }, { kingdom: kB, battle: hC });
        }
      }
    }
    while (!fb.world.outcome && fb.world.tick < fa.world.tick) fb.world.step();
    check("the layer hash agrees through the battle", diverged < 0 && compared > 10,
      diverged >= 0 ? "diverged at battle tick " + diverged : compared + " comparisons over " + t + " battle ticks, outcome " + JSON.stringify(fa.world.outcome?.winner ?? null));
    check("a 0.0001 nudge to a soldier is caught and blamed on the battle layer", caught >= 0 && attributed === "battle",
      caught >= 0 ? "caught at battle tick " + caught + ", drift: " + attributed : "never caught");
    const rA = resultFromBattle(specA, fa.world, fa.fielded);
    const rB = resultFromBattle(specB, fb.world, fb.fielded);
    check("both read the same BattleResult off the field", hashBattleResult(rA) === hashBattleResult(rB), hashBattleResult(rA));
    // A kingdom-side nudge while the battle runs is blamed on the kingdom.
    const nudged = loadFromJson(saveToJson(b));
    if (nudged.ok) {
      nudged.value.economy[KING_PLAYER].stocks.coin += 0.0001;
      const hA = hashWorld(fa.world);
      const d = driftedLayer({ kingdom: kA, battle: hA }, { kingdom: kingdomHash(nudged.value), battle: hashWorld(fb.world) });
      check("a 0.0001 nudge to the kingdom mid-battle is blamed on the kingdom layer", d === "kingdom", d);
    }
    check("no battle running and a battle running hash apart", layerHash(kA) !== layerHash(kA, hashWorld(fa.world)));
    // The result goes back over the wire, and both kingdoms take it identically.
    const fought = { kind: "resolveContact", contact: w.contact!.id, choice: "fight", result: rA } as const;
    check("the result is a legal order on both peers", checkContactOrder(w, fought, KING_PLAYER) === null && checkContactOrder(b, fought, KING_PLAYER) === null);
    const order = w.issue(fought);
    w.tick();
    b.tick([order]);
    check("both kingdoms apply the battle identically", kingdomHash(w) === kingdomHash(b) && !w.contact && !b.contact, kingdomHash(w) + " vs " + kingdomHash(b));
    let same = true;
    for (let i = 0; i < 30 * TICKS_PER_DAY && same; i++) { w.tick(); b.tick(); same = kingdomHash(w) === kingdomHash(b); }
    check("and stay identical for a month after", same);
  }
}

console.log("\n" + (failures === 0 ? "all " + checks + " kingdom lockstep checks passed" : failures + " of " + checks + " kingdom lockstep checks FAILED"));
if (failures > 0) process.exit(1);
