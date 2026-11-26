/**
 * K9's proof (PLAN.md §B.11: "full playthrough script reaches each ending"):
 * four headless runs of the Exile of Rimaros, from the first day at Cold
 * Hearth to an end screen, one per ending -- the Restored King, the Iron
 * Crown, the Hollow Crown, and the chronicle closing on a fallen king.
 *
 * Each run is a scripted player that only READS the world to decide and only
 * WRITES it through `world.issue` -- the orders a person at the panels would
 * give: rally, claim, raise a levy, march, answer every letter. So the act
 * goals, letter triggers, encounters, effects and endings are the real sim's,
 * and each run's order log replays to the same realm (checked below).
 *
 * The one stand-in: a battle. Headless there is nobody to draw the strokes,
 * so a contact is settled with `fight` and a result built the way a won (or,
 * for the fallen king, a lost) battle reports itself -- every man of the
 * winning side standing, the loser broken, the legitimacy the field gives
 * (descent.ts resultFromBattle). It passes the same check a real battle's
 * result does (resultRefusal). Fighting real battles is the battle suites'
 * job; this one proves the STORY can be finished every way it can end.
 *
 * The runs differ only in how the letters are answered (the forks are
 * where an ending is chosen): kindly, harshly, or carelessly with the
 * realm's trust -- and in one run, the king rides into a battle he loses.
 *
 * Deterministic: a fixed seed and a fixed bot, so each run lands on the same
 * day with the same hash every time.
 */

import {
  KingdomWorld, TICKS_PER_DAY, armiesOf, planArmyRoute, armyById, buildBattleSpec, kingdomHash, replayLog, standsIn,
  type Holding, type KingdomOrderBody,
} from "../src/sim/kingdom/index.ts";
import type { BattleResult } from "../src/sim/layers.ts";
import { holds, offeredChoices, chronicleLine } from "../src/sim/kingdom/story.ts";
import { KING_PLAYER, FACTION_IDS } from "../src/content/kingdom/factions.ts";
import { WIN_LEGITIMACY, LOSS_LEGITIMACY } from "../src/content/kingdom/descent.ts";
import { STORY_LETTERS, type StoryChoice } from "../src/content/story/letters.ts";
import { ENCOUNTERS } from "../src/content/story/encounters.ts";
import { ENDINGS } from "../src/content/story/endings.ts";
import { ACTS } from "../src/content/story/acts.ts";
import { LEDGER_CATEGORY_IDS } from "../src/content/kingdom/economy.ts";
import { saveToJson, loadFromJson } from "../src/sim/kingdom/save.ts";
import { ABILITY_IDS } from "../src/content/abilities.ts";

const SEED = 0x5709;
const MAX_DAYS = 360 * 8;
const VERBOSE = process.env.STORY_VERBOSE === "1";

type Temper = "kind" | "harsh" | "careless" | "doomed";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failures++;
  console.log((ok ? "  ok    " : "  FAIL  ") + name + (detail ? "  <- " + detail : ""));
}

/** How a temper weighs a choice: by what it does to Mercy and Legitimacy, and whether it moves the story on. */
function score(c: StoryChoice, t: Temper): number {
  let mercy = 0;
  let legit = 0;
  let onward = 0;
  for (const fx of c.effects) {
    if (fx.kind === "mercy") mercy += fx.delta;
    if (fx.kind === "legitimacy") legit += fx.delta;
    // A battle offered is a battle taken, and "not yet" is never the answer: the story must move.
    if (fx.kind === "battle") onward += 100;
    if (fx.kind === "followUp" && STORY_LETTERS.find((l) => l.id === fx.letter)?.id === undefined) onward -= 0;
    if (fx.kind === "followUp") onward -= 50;
    if (fx.kind === "flag" && (fx.flag === "vael-named" || fx.flag === "vael-secret")) onward += 20;
    // Free companies eat and are paid: none before the first harvest is in.
    if (fx.kind === "hire") onward -= 200;
  }
  switch (t) {
    case "kind": return onward + mercy * 3 + legit;
    case "harsh": return onward - mercy * 3 + legit;
    case "careless": return onward - legit * 3;
    case "doomed": return onward + legit;
  }
}

function issue(w: KingdomWorld, body: KingdomOrderBody): boolean {
  if (w.check(body) !== null) return false;
  w.issue(body);
  return true;
}

/** A battle's report for a field the king's side won (or lost), as resultFromBattle would build it. */
function result(w: KingdomWorld, kingWins: boolean): BattleResult {
  const c = w.contact!;
  const spec = buildBattleSpec(w, c);
  const win = kingWins ? 0 : 1;
  const king = spec.sides[0].faction === KING_PLAYER;
  return {
    contact: c.id,
    winner: win,
    squads: [
      spec.sides[0].squads.map((q) => ({ squad: q.squad, men: kingWins ? q.men : 0, wounded: 0 })),
      spec.sides[1].squads.map((q) => ({ squad: q.squad, men: kingWins ? 0 : q.men, wounded: 0 })),
    ],
    morale: [kingWins ? 70 : 0, kingWins ? 0 : 70],
    fled: [!kingWins, kingWins],
    left: [false, false],
    damage: { crops: 0, buildings: 0 },
    legitimacy: !king ? 0 : kingWins ? WIN_LEGITIMACY : -LOSS_LEGITIMACY,
  };
}

function kingAt(w: KingdomWorld): number {
  const m = w.king.mover;
  return m.road === 0 && m.route.length === 0 ? m.node : 0;
}

/** Holdings the encounters are fought at, while their encounter is not yet won (the bot leaves them for the story). */
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

/** The next holding to take: an armed encounter first, else the nearest one not his that the march can reach. */
function nextTarget(w: KingdomWorld): number {
  const s = w.story!;
  for (let i = 0; i < ENCOUNTERS.length; i++) {
    if (s.encounters[i].state !== "armed") continue;
    const host = armyById(w, s.encounters[i].host);
    const at = host ? standsIn(host.mover) : w.holdingByKey(ENCOUNTERS[i].holding)!.id;
    if (!at) continue;
    if (w.planKingRoute(at)) return at;
    // Not known yet: explore toward it, by the known holding nearest to it that is not where he stands.
    const goal = w.holding(at)!;
    let best = 0;
    let d2 = Infinity;
    for (const h of w.holdings) {
      if (h.id === kingAt(w) || !w.planKingRoute(h.id)) continue;
      const d = (h.x - goal.x) ** 2 + (h.y - goal.y) ** 2;
      if (d < d2) { d2 = d; best = h.id; }
    }
    if (best) return best;
  }
  const avoid = storyGround(w);
  const seat = w.holdingByKey(w.map.crownSeat)!.id;
  let best = 0;
  let eta = Infinity;
  for (const h of w.holdings) {
    if (h.owner === "king" || avoid.has(h.id) || h.id === seat) continue;
    if (h.owner !== null && s.sworn.includes(FACTION_IDS.indexOf(h.owner))) continue;
    const p = w.planKingRoute(h.id);
    if (!p || p.route.nodes.length === 0) continue;
    // An empty holding is claimed for the asking (and its cellars with it); a held one is a battle.
    const cost = h.owner === null && h.garrison.length === 0 ? p.etaTicks : p.etaTicks * 2;
    if (cost < eta) { eta = cost; best = h.id; }
  }
  return best;
}

/** The nearest holding not the king's that army `id` can march to (leaving the story's ground and the Crown Seat alone). */
function nearestFor(w: KingdomWorld, id: number): number {
  const a = armyById(w, id)!;
  const avoid = storyGround(w);
  const seat = w.holdingByKey(w.map.crownSeat)!.id;
  let best = 0;
  let eta = Infinity;
  for (const h of w.holdings) {
    if (h.owner === "king" || avoid.has(h.id) || h.id === seat) continue;
    if (h.owner !== null && w.story!.sworn.includes(FACTION_IDS.indexOf(h.owner))) continue;
    const p = planArmyRoute(w, a, h.id);
    if (!p || p.route.nodes.length === 0) continue;
    if (p.etaTicks < eta) { eta = p.etaTicks; best = h.id; }
  }
  return best;
}

type Run = { w: KingdomWorld; ending: string | null; day: number; acts: number[]; letters: number; encounters: string[]; problem: string };

function play(t: Temper): Run {
  const w = new KingdomWorld({ seed: SEED, hosts: true, captains: true, autoFarm: true, story: true });
  const acts: number[] = [1];
  const encounters: string[] = [];
  let letters = 0;
  let problem = "";
  let slOk = true;
  let target = 0;
  let stuck = 0;
  const rallied = new Set<number>();
  while (w.story!.ending === null && w.date.day < MAX_DAYS) {
    if (w.contact) {
      // The doomed king loses the first battle of the second act he rides into, and is taken with his army.
      const lose = t === "doomed" && w.story!.act >= 2;
      issue(w, { kind: "resolveContact", contact: w.contact.id, choice: "fight", result: result(w, !lose) });
      for (const ev of w.tick()) {
        if (ev.kind === "encounterFought") encounters.push(ENCOUNTERS[ev.encounter].id + (ev.won ? "" : " (lost)"));
      }
      continue;
    }
    if (w.now % TICKS_PER_DAY === 1) {
      // Every season the save round-trips mid-story too, letters pending and hosts afield.
      if (w.date.day % 90 === 45 && slOk) {
        const b = loadFromJson(saveToJson(w));
        if (!b.ok || kingdomHash(b.value) !== kingdomHash(w)) { slOk = false; problem = "save/load differs on day " + w.date.day + (b.ok ? "" : ": " + b.error); }
      }
      decide(w);
      if (process.env.STORY_TRACE === "1" && w.date.day % 10 === 0) {
        const e = w.economy[KING_PLAYER];
        console.log("  d" + w.date.day + " act " + w.story!.act + " grain " + e.stocks.grain + " coin " + e.stocks.coin + " levy " + e.stocks.levy +
          " legit " + e.legitimacy + " mercy " + e.mercy + " need " + w.dailyNeed() + " holdings " + w.holdingsOf("king").length +
          " flows " + (w.books[0].closed ? LEDGER_CATEGORY_IDS.map((c, i) => [c, w.books[0].closed!.flow[1 * LEDGER_CATEGORY_IDS.length + i]]).filter((x) => x[1] !== 0).map((x) => x.join(":")).join(" ") : "") +
          " goals " + ACTS[w.story!.act - 1].goals.map((g) => g.id + "=" + (holds(w, g.condition) ? 1 : 0)).join(",") +
          " enc " + w.story!.encounters.map((x, i) => x.state !== "idle" ? ENCOUNTERS[i].id + ":" + x.state + "@" + (armyById(w, x.host) ? standsIn(armyById(w, x.host)!.mover) : 0) : "").filter(Boolean).join(",") +
          " king@" + kingAt(w) + "->" + target + " pending " + w.story!.pending.map((i) => STORY_LETTERS[i].id).join(",") +
          " armies " + armiesOf(w, KING_PLAYER).map((a) => a.name + ":" + a.squads.reduce((n, q) => n + q.men, 0) + "/s" + a.supply).join(","));
      }
    }
    for (const ev of w.tick()) {
      if (ev.kind === "rallyDone") rallied.add(ev.holding);
      if (ev.kind === "actBegan") acts.push(ev.act);
      if (ev.kind === "letterAnswered") letters++;
    }
  }
  return { w, ending: w.story!.ending, day: w.date.day, acts, letters, encounters, problem };

  /**
   * What a temper does with the realm besides its letters: the harsh king
   * keeps the rope in every town he holds (Mercy falls each season, K6); the
   * careless one, once the realm believes in him (Act IV), spends that belief
   * on his army's tricks (an ability costs Legitimacy, K4) as if it would
   * never run out.
   */
  function temperRealm(w: KingdomWorld): void {
    if (t === "harsh" && w.story!.act >= 2) {
      for (const h of w.holdingsOf("king")) if (h.justice !== "rope") issue(w, { kind: "setJustice", holding: h.id, justice: "rope" });
    }
    if (t === "careless" && w.story!.act >= 4) {
      for (const a of armiesOf(w, KING_PLAYER)) {
        for (const ab of ABILITY_IDS) {
          if (w.economy[KING_PLAYER].legitimacy <= 41) return;
          issue(w, { kind: "unlockAbility", army: a.id, ability: ab });
        }
      }
    }
  }

  function decide(w: KingdomWorld): void {
    const s = w.story!;
    const e = w.economy[KING_PLAYER];
    // Every letter, answered the temper's way, from what it can afford.
    for (const li of [...s.pending]) {
      const l = STORY_LETTERS[li];
      let pick = -1;
      let best = -Infinity;
      for (const c of offeredChoices(w, li)) {
        if (w.check({ kind: "answerLetter", letter: li, choice: c }) !== null) continue;
        const sc = score(l.choices[c], t);
        if (sc > best) { best = sc; pick = c; }
      }
      if (pick >= 0) issue(w, { kind: "answerLetter", letter: li, choice: pick });
    }
    steward(w, t);
    temperRealm(w);
    const army = armyById(w, w.king.army);
    const here = kingAt(w);
    // No army yet. In the Reach, before the first battle: rally and claim its
    // hamlets and the empty keep, then sit at home foraging -- every mouth
    // counts through the first winter. Once a battle is offered (or the Reach
    // is held): raise the levy and ride with it.
    if (!army) {
      if (here === 0) {
        // Alone on a road (his army starved or fell under him): home to the nearest holding of his.
        if (w.king.mover.route.length === 0) {
          let best = 0;
          let eta = Infinity;
          for (const h of w.holdingsOf("king")) {
            const p = w.planKingRoute(h.id);
            if (p && p.etaTicks < eta) { eta = p.etaTicks; best = h.id; }
          }
          if (best) issue(w, { kind: "moveKing", to: best });
        }
        return;
      }
      const h = w.holding(here) as Holding;
      const armed = s.encounters.some((x) => x.state === "armed");
      if (s.act === 1 && !armed) {
        // The careful first winter (tools/kingdom-strategies.ts CAREFUL): a
        // few followers from Cold Hearth, Greyshaw claimed with a granary and
        // rye in its fields, the empty keep at Rookstead for a roof, and
        // foraging until the spring.
        const go = (key: string): boolean => {
          const x = w.holdingByKey(key)!;
          if (here === x.id) return false;
          if (w.king.mover.route.length === 0) issue(w, { kind: "moveKing", to: x.id });
          return true;
        };
        const greyshaw = w.holdingByKey("greyshaw")!;
        if (greyshaw.owner !== "king") {
          if (e.stocks.levy < 4 && !rallied.has(w.holdingByKey("cold-hearth")!.id)) {
            if (go("cold-hearth")) return;
            if (w.king.task !== "rally") issue(w, { kind: "rally" });
            return;
          }
          if (e.stocks.grain < 70 || e.stocks.timber < 4) {
            if (w.king.task !== "forage") issue(w, { kind: "forage" });
            return;
          }
        }
        for (const key of ["greyshaw", "rookstead"]) {
          const x = w.holdingByKey(key)!;
          if (x.owner === "king") continue;
          if (go(key)) return;
          issue(w, { kind: "claimHolding", holding: x.id });
          return;
        }
        const g = w.holdingByKey("greyshaw")!;
        for (const p of g.plots) if (p.stage === "empty" || p.stage === "harvested" || p.stage === "spoiled") issue(w, { kind: "sow", plot: p.id, crop: "rye" });
        if (go("greyshaw")) return;
        if (w.king.task !== "forage") issue(w, { kind: "forage" });
        return;
      }
      if (h.owner === null && h.kind === "hamlet" && !rallied.has(here) && e.stocks.levy < 12) {
        if (w.king.task !== "rally") issue(w, { kind: "rally" });
        return;
      }
      if (h.owner === null && issue(w, { kind: "claimHolding", holding: here })) return;
      if (e.stocks.levy >= 4) {
        const own = armiesOf(w, KING_PLAYER).find((a) => standsIn(a.mover) === here && a.company === 0);
        if (own) { issue(w, { kind: "kingJoin", army: own.id }); return; }
        issue(w, { kind: "recruit", at: here, army: 0, unit: "line", levy: true });
        return;
      }
      if (w.king.task === "none") issue(w, { kind: "forage" });
      return;
    }
    // The seasonal muster brings more followers than the stores can feed (a
    // follower eats a day's bread, ECON). Past what the king's own army needs,
    // they are raised as a levy where he stands and sent home from the next
    // holding not his -- dismissed men eat their own bread.
    for (const a of armiesOf(w, KING_PLAYER)) {
      if (a.id === w.king.army || a.company !== 0 || a.mover.route.length > 0 || a.target !== 0) continue;
      const at = standsIn(a.mover);
      if (at !== 0 && (w.holding(at) as Holding).owner !== "king") { issue(w, { kind: "disband", army: a.id }); continue; }
      const to = nearestFor(w, a.id);
      if (to) issue(w, { kind: "marchArmy", army: a.id, to });
      else issue(w, { kind: "disband", army: a.id });
    }
    if (here !== 0 && e.stocks.levy > 24 && army.squads.length >= 4) {
      for (let i = 0; i < 3; i++) issue(w, { kind: "recruit", at: here, army: 0, unit: "line", levy: true });
    }
    // Riding: fill the ranks from the followers, claim what is empty, march on the next.
    if (here !== 0 && e.stocks.levy >= 8 && army.squads.length < 4) issue(w, { kind: "recruit", at: here, army: army.id, unit: army.squads.length % 2 ? "slinger" : "line", levy: true });
    if (here !== 0) {
      const h = w.holding(here) as Holding;
      if (h.owner === null) issue(w, { kind: "claimHolding", holding: here });
    }
    // Halted on a road (a contact settled there): take up the march again.
    if (here === 0 && w.king.mover.route.length === 0) {
      target = nextTarget(w);
      if (target !== 0) issue(w, { kind: "moveKing", to: target });
    }
    if (here !== 0 && (target === 0 || here === target || (w.holding(target)?.owner === "king"))) {
      target = nextTarget(w);
      if (target !== 0) issue(w, { kind: "moveKing", to: target });
      stuck = 0;
    } else if (here !== 0 && target !== 0) {
      if (++stuck > 5) { target = nextTarget(w); if (target) issue(w, { kind: "moveKing", to: target }); stuck = 0; }
    }
    // The Crown Seat waits for its own letter: then it is the target.
    const siege = ENCOUNTERS.findIndex((x) => x.id === "crown-siege");
    if (s.encounters[siege].state === "armed" && here !== 0) {
      const seat = w.holdingByKey(w.map.crownSeat)!.id;
      if (target !== seat) { target = seat; issue(w, { kind: "moveKing", to: seat }); }
    }
  }
}

/**
 * The realm's housekeeping, as a careful player keeps it: a granary in every
 * holding so the harvest keeps, a farm and a shrine where there is room, a
 * feast or a pardon where a town grows restless.
 */
function steward(w: KingdomWorld, t: Temper): void {
  for (const h of w.holdingsOf("king")) {
    for (const b of ["granary", "farm", "shrine", "watchtower"] as const) {
      if (h.buildings.includes(b)) continue;
      if (issue(w, { kind: "build", holding: h.id, building: b })) return;
    }
  }
  for (const h of w.holdingsOf("king")) {
    // A pardon is mercy; the harsh king hangs instead (temperRealm).
    if (t !== "harsh" && h.unrest >= 450 && issue(w, { kind: "pardon", holding: h.id })) continue;
    if (h.unrest >= 350) issue(w, { kind: "holdFestival", holding: h.id });
  }
}

function report(name: string, r: Run, want: string): void {
  const s = r.w.story!;
  const e = r.w.economy[KING_PLAYER];
  console.log("\n" + name + ": " + (r.ending ?? "no ending") + " on day " + r.day + " (year " + r.w.date.year + "), acts " + r.acts.join(">") +
    ", " + r.letters + " letters answered, legitimacy " + e.legitimacy + ", mercy " + e.mercy +
    ", holdings " + r.w.holdingsOf("king").length + "/" + r.w.holdings.length);
  console.log("  encounters: " + (r.encounters.join(", ") || "none"));
  if (VERBOSE) for (const c of s.chronicle) { const l = chronicleLine(c, r.w.king.name); console.log("    d" + c.day + " " + l.title + ": " + l.text); }
  check(name + " reaches " + want, r.ending === want, r.ending ?? "act " + s.act + " goals " + ACTS[s.act - 1].goals.map((g) => g.id + "=" + holds(r.w, g.condition)).join(" "));
  if (want !== "the-fallen") check(name + " passes through all four acts", r.acts.join() === "1,2,3,4");
  check(name + " writes a chronicle (an entry for every act begun)", s.chronicle.filter((c) => c.key.endsWith(":intro")).length === r.acts.length);
  check(name + " ends with the ending in the ledger", s.chronicle[s.chronicle.length - 1]?.key === "ending:" + want);
  // The log alone reproduces the run; the save round-trips it.
  const replay = replayLog(SEED, r.w.log, r.w.now, { hosts: true, captains: true, autoFarm: true, story: true });
  check(name + ": its order log replays to the same realm", kingdomHash(replay) === kingdomHash(r.w));
  const back = loadFromJson(saveToJson(r.w));
  check(name + ": it saves and loads to the same hash", back.ok && kingdomHash(back.value) === kingdomHash(r.w));
  check(name + ": it saves and loads to the same hash every season on the way", r.problem === "", r.problem);
  const before = kingdomHash(r.w);
  for (let i = 0; i < TICKS_PER_DAY * 3; i++) r.w.tick();
  check(name + ": after the end the realm holds", kingdomHash(r.w) === before);
}

console.log("story playthrough: four runs, one per ending");
const kind = play("kind");
if (process.env.STORY_TRACE === "1") process.exit(0);
report("the kind king", kind, "restored-king");
const harsh = play("harsh");
report("the harsh king", harsh, "iron-crown");
const careless = play("careless");
report("the careless king", careless, "hollow-crown");
const doomed = play("doomed");
report("the doomed king", doomed, "the-fallen");
check("every ending is reached by some run", ENDINGS.every((e) => [kind, harsh, careless, doomed].some((r) => r.ending === e.id)));
const again = play("kind");
check("a run is deterministic (same day, same hash)", again.day === kind.day && kingdomHash(again.w) === kingdomHash(kind.w));

console.log("\n" + (failures === 0 ? "all " + checks + " story playthrough checks passed" : failures + " of " + checks + " story playthrough checks FAILED"));
if (failures > 0) process.exit(1);
