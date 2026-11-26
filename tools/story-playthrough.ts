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
 * K10 ("Act IV playable", PLAN §B.11) adds a fifth run, the kind king again,
 * in which the stand-in is lifted for the siege of the capital: every assault
 * of the king's on the Crown Seat's walls is fought as a real battle World
 * (app/battle-config.ts, as the descent builds it), the machine commanding
 * both sides, and its result -- walls battered, the capital taken or held --
 * is applied back. That king plays as a careful player would: he does not
 * storm the capital on his way past it before the story brings him there,
 * and he takes a siege train (engines from a barracks of his, iron from his
 * forges) to its walls.
 *
 * Deterministic: a fixed seed and a fixed bot, so each run lands on the same
 * day with the same hash every time.
 */

import {
  KingdomWorld, TICKS_PER_DAY, armiesOf, planArmyRoute, armyById, buildBattleSpec, kingdomHash, replayLog, standsIn,
  resultFromBattle, resultRefusal, hasBarracks,
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
import { battleFromSpec, battleWorld } from "../src/app/battle-config.ts";

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
    damage: { crops: 0, buildings: 0, walls: 0 },
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
/**
 * K10's real run: a king who does not march past the Crown Seat's walls
 * (which would be an assault on them) until the story brings him there.
 */
let avoidSeat = false;
/** The engines the king takes to the capital's walls in the real run. */
const SIEGE_TRAIN = 2;

/** May the king be sent here? (In the real run, not by a road through the Crown Seat before its siege.) */
function viaSeat(w: KingdomWorld, to: number): boolean {
  if (!avoidSeat) return false;
  const siege = ENCOUNTERS.findIndex((x) => x.id === "crown-siege");
  if (w.story!.encounters[siege].state === "armed") return false;
  const seat = w.holdingByKey(w.map.crownSeat)!.id;
  if (to === seat) return true;
  const p = w.planKingRoute(to);
  return !!p && p.route.nodes.includes(seat);
}

function nextTarget(w: KingdomWorld): number {
  const s = w.story!;
  for (let i = 0; i < ENCOUNTERS.length; i++) {
    if (s.encounters[i].state !== "armed") continue;
    const host = armyById(w, s.encounters[i].host);
    const at = host ? standsIn(host.mover) : w.holdingByKey(ENCOUNTERS[i].holding)!.id;
    if (!at) continue;
    if (w.planKingRoute(at) && !viaSeat(w, at)) return at;
    // Not known yet: explore toward it, by the known holding nearest to it that is not where he stands.
    const goal = w.holding(at)!;
    let best = 0;
    let d2 = Infinity;
    for (const h of w.holdings) {
      if (h.id === kingAt(w) || !w.planKingRoute(h.id) || viaSeat(w, h.id)) continue;
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
    if (!p || p.route.nodes.length === 0 || viaSeat(w, h.id)) continue;
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

/** K10: one siege of the capital fought as a real battle World, and what the kingdom made of it. */
type RealSiege = {
  act: number; level: string; fortification: string; victory: string; worn: number; seconds: number;
  winner: number; walls: number; refusal: string | null; wallsBefore: number; wallsAfter: number; owner: string;
  /** Fought as the story's crown-siege encounter (else a plain assault on the capital). */
  encounter: boolean;
};

type Run = {
  w: KingdomWorld; ending: string | null; day: number; acts: number[]; letters: number; encounters: string[]; problem: string;
  sieges: RealSiege[];
};

/**
 * K10: the capital siege fought for real -- the waiting contact's spec built
 * into a battle World (app/battle-config.ts, as the descent does), the
 * machine commanding both sides to the end, its result read back the way a
 * battle reports itself (resultFromBattle).
 */
function fightForReal(w: KingdomWorld): { result: BattleResult; siege: RealSiege } {
  const c = w.contact!;
  const spec = buildBattleSpec(w, c);
  const { world, fielded } = battleWorld(battleFromSpec(spec), { aiPlayers: [0, 1] });
  world.deploying = false;
  const cap = (spec.duration + 30) * 20;
  let ticks = 0;
  while (!world.outcome && ticks < cap) { world.step(); ticks++; }
  const result = resultFromBattle(spec, world, fielded);
  const h = w.holding(c.holding)!;
  return {
    result,
    siege: {
      act: w.story!.act, level: spec.terrain.level, fortification: spec.terrain.fortification, victory: spec.victory.mode,
      worn: spec.terrain.worn, seconds: ticks / 20, winner: result.winner, walls: result.damage.walls,
      refusal: resultRefusal(spec, result), wallsBefore: h.walls, wallsAfter: -1, owner: "", encounter: false,
    },
  };
}

function play(t: Temper, realCapital = false): Run {
  avoidSeat = realCapital;
  const w = new KingdomWorld({ seed: SEED, hosts: true, captains: true, autoFarm: true, story: true });
  const acts: number[] = [1];
  const encounters: string[] = [];
  let letters = 0;
  let problem = "";
  let slOk = true;
  let target = 0;
  let stuck = 0;
  const rallied = new Set<number>();
  const sieges: RealSiege[] = [];
  const crownSiege = ENCOUNTERS.findIndex((x) => x.id === "crown-siege");
  while (w.story!.ending === null && w.date.day < MAX_DAYS) {
    // K10: the siege of the capital, fought as a real battle.
    // Every assault the king's side makes on the Crown Seat is that siege --
    // the story's own (the Chancery Guard, armed by its letter) or a march on
    // the capital's walls before the letter came.
    if (realCapital && w.contact && w.contact.holding === w.holdingByKey(w.map.crownSeat)!.id && w.contact.attacker === 0 &&
        buildBattleSpec(w, w.contact).terrain.fortification !== "none") {
      const encounter = w.story!.encounters[crownSiege].state === "armed";
      // A careful king does not storm the capital on his way past it before
      // the story brings him to its walls: he draws off.
      if ((!encounter || w.contact.sides[0].army !== w.king.army) &&
          issue(w, { kind: "resolveContact", contact: w.contact.id, choice: "withdraw", result: null })) {
        w.tick();
        continue;
      }
      const f = fightForReal(w);
      f.siege.encounter = encounter;
      issue(w, { kind: "resolveContact", contact: w.contact.id, choice: "fight", result: f.result });
      for (const ev of w.tick()) {
        if (ev.kind === "encounterFought") encounters.push(ENCOUNTERS[ev.encounter].id + (ev.won ? "" : " (lost)") + " [real battle]");
      }
      const seat = w.holdingByKey(w.map.crownSeat)!;
      sieges.push({ ...f.siege, wallsAfter: seat.walls, owner: seat.owner ?? "" });
      continue;
    }
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
  return { w, ending: w.story!.ending, day: w.date.day, acts, letters, encounters, problem, sieges };

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
    // K10's real run: stone walls are not stormed with levies alone. Once the
    // story brings the king to the capital, he first takes a siege train into
    // his army -- engines trained at a barracks of his, built where he stands
    // if there is none -- and only then marches on the walls.
    if (avoidSeat && s.encounters[ENCOUNTERS.findIndex((x) => x.id === "crown-siege")].state === "armed" &&
        army.squads.filter((q) => q.unit === "siege").length < SIEGE_TRAIN) {
      if (here === 0) return;
      const h = w.holding(here) as Holding;
      if (h.owner === "king" && hasBarracks(h)) {
        issue(w, { kind: "recruit", at: here, army: army.id, unit: "siege", levy: false });
        return;
      }
      if (h.owner === "king" && (h.buildings.includes("barracks") || issue(w, { kind: "build", holding: here, building: "barracks" }))) return;
      // Nowhere to train them here: to the nearest holding of his with a barracks.
      let best = 0;
      let eta = Infinity;
      for (const x of w.holdingsOf("king")) {
        if (x.id === here || !hasBarracks(x)) continue;
        const p = w.planKingRoute(x.id);
        if (p && p.etaTicks < eta && !p.route.nodes.includes(w.holdingByKey(w.map.crownSeat)!.id)) { eta = p.etaTicks; best = x.id; }
      }
      if (best && w.king.mover.route.length === 0) issue(w, { kind: "moveKing", to: best });
      return;
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
    // K10's real run: timber and iron, for the engines the capital's walls will want.
    for (const b of avoidSeat ? ["granary", "farm", "woodcutter", "forge", "shrine", "watchtower"] as const : ["granary", "farm", "shrine", "watchtower"] as const) {
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

// K10 ("Act IV playable", PLAN §B.11): the kind king again, but the capital
// siege is fought as a real battle World -- the walls of Rimaros raised from
// the holding, the king's host storming them, the machine on both sides --
// and its result (the walls battered, the capital taken or held) applied back.
const real = play("kind", true);
console.log("\nthe kind king, the capital fought for real: " + (real.ending ?? "no ending") + " on day " + real.day + ", acts " + real.acts.join(">"));
console.log("  encounters: " + (real.encounters.join(", ") || "none"));
for (const g of real.sieges) {
  console.log("  siege of the capital (act " + g.act + (g.encounter ? ", the crown-siege encounter" : ", an assault") + "): " + g.level + ", " + g.fortification + " (" + g.worn + "‰ worn), " + g.victory +
    ", " + g.seconds + " s, winner " + g.winner + ", walls +" + g.walls + "‰ -> " + g.wallsAfter + "‰, held by " + g.owner);
}
check("the real run reaches Act IV", real.acts.includes(4));
check("the capital siege is fought as a real battle World", real.sieges.length > 0 && real.sieges.every((g) => g.act === 4 && g.seconds > 0));
check("each is a siege of the capital's stone walls on its own field, won by breaking in or holding out",
  real.sieges.every((g) => (!g.encounter || g.level === "last-wall-siege") && g.fortification === "wall" && g.victory === "breakthrough"),
  real.sieges.map((g) => g.level + "/" + g.fortification + "/" + g.victory).join(" "));
check("each result passes the kingdom's check", real.sieges.every((g) => g.refusal === null), real.sieges.map((g) => g.refusal).join(" "));
check("the walls the battles knocked down are applied back to the capital",
  real.sieges.some((g) => g.walls > 0) && real.sieges.every((g) => g.wallsAfter === Math.min(1000, g.wallsBefore + g.walls)),
  real.sieges.map((g) => g.wallsBefore + "+" + g.walls + "=" + g.wallsAfter).join(" "));
check("a siege laid again meets the walls as the last one left them (raised that battered)",
  real.sieges.every((g, i) => i === 0 || g.worn === real.sieges[i - 1].wallsAfter), real.sieges.map((g) => g.worn).join(" "));
check("the last siege takes the capital for the king", real.sieges.length > 0 && real.sieges[real.sieges.length - 1].winner === 0 &&
  real.w.holdingByKey(real.w.map.crownSeat)!.owner === "king");
check("and the story closes on a crowned ending", ENDINGS.find((e) => e.id === real.ending)?.gate.kind === "crowned", String(real.ending));
check("the real run's order log (battle results and all) replays to the same realm",
  kingdomHash(replayLog(SEED, real.w.log, real.w.now, { hosts: true, captains: true, autoFarm: true, story: true })) === kingdomHash(real.w));

check("every ending is reached by some run", ENDINGS.every((e) => [kind, harsh, careless, doomed].some((r) => r.ending === e.id)));
const again = play("kind");
check("a run is deterministic (same day, same hash)", again.day === kind.day && kingdomHash(again.w) === kingdomHash(kind.w));

console.log("\n" + (failures === 0 ? "all " + checks + " story playthrough checks passed" : failures + " of " + checks + " story playthrough checks FAILED"));
if (failures > 0) process.exit(1);
