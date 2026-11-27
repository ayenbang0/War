/**
 * K11's balance proof (PLAN.md §B.11: "headless balance sweeps"): the kingdom
 * layer's difficulty, swept across seeds and players, in the realm a NEW
 * GAME plays -- the opening hosts, the rival captains and their invasion
 * waves, fields that farm themselves, and the story.
 *
 *   node tools/kingdom-difficulty.ts          the sweep and its checks (in npm test)
 *   node tools/kingdom-difficulty.ts quick    one seed only
 *
 * Two parts.
 *
 *  1. The economy players of tools/kingdom-strategies.ts -- passive (claims
 *     Cold Hearth and does nothing more), careful, careless and builder --
 *     for two calendar years on each difficulty and several seeds. A host
 *     that meets them is auto-resolved (a player who never draws a battle).
 *     Held to: on Gentle and Standard the passive and the careful king live
 *     through both years without the realm going hungry for long, and keep a
 *     holding; the builder ends with more people than the passive king; and
 *     every difficulty is no easier than the one below it (the passive king's
 *     grain at the end falls from Gentle to Standard to Hard).
 *
 *  2. The story bot of tools/story-playthrough.ts (tools/story-bot.ts, the
 *     kind king) plays the whole story on each difficulty and two seeds; the
 *     day each act begins and the day the story ends are printed. Held to: on
 *     Gentle and Standard the story reaches its fourth act within four years
 *     -- a sensible playtime at the speeds the map offers.
 *
 * Battles are settled without a field here (auto-resolve, or the bot's
 * stand-in result), so the difficulty's battle shift is not what is measured;
 * tools/kingdom-descent.ts holds the spec to it.
 */

import {
  DAYS_PER_YEAR, KingdomWorld, TICKS_PER_DAY, kingdomHash, saveToJson, loadFromJson, deserialize, serialize, replayLog,
} from "../src/sim/kingdom/index.ts";
import { battleDifficultyShifted } from "../src/sim/kingdom/descent.ts";
import { KINGDOM_DIFFICULTY_IDS, type KingdomDifficultyId } from "../src/content/kingdom/difficulty.ts";
import { CAREFUL, CARELESS, BUILDER, PASSIVE, runStrategy, steward, type Strategy } from "./kingdom-strategies.ts";
import { play, SEED } from "./story-bot.ts";
import { KING_PLAYER } from "../src/content/kingdom/factions.ts";

const quick = process.argv[2] === "quick";
const SEEDS = quick ? [1] : [1, 2, 3];
const STORY_SEEDS = quick ? [SEED] : [SEED, 7];
const YEARS = 2;

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failures++;
  console.log((ok ? "  ok    " : "  FAIL  ") + name + (detail ? "  <- " + detail : ""));
}
const pad = (s: string | number, n: number): string => String(s).padStart(n);

type Row = {
  diff: KingdomDifficultyId; strategy: string; seed: number;
  hungry: number; famine: number; towns: number; people: number; grain: number; coin: number; fallen: boolean; waves: number;
  /** The last day played (the story ends the run if the king falls), and the king's holdings on day 360. */
  lastDay: number; townsYear1: number;
};

// -- the knobs themselves -------------------------------------------------------------
console.log("the knobs");
{
  const make = (difficulty: KingdomDifficultyId): KingdomWorld => new KingdomWorld({ seed: 11, difficulty });
  check("a world built without saying is Standard (every older suite and the golden)", new KingdomWorld({ seed: 11 }).difficulty === "standard");
  const g = make("gentle"), st = make("standard"), h = make("hard");
  check("a Standard world hashes as a world that never heard of difficulty", kingdomHash(st) === kingdomHash(new KingdomWorld({ seed: 11 })));
  check("worlds that differ only in difficulty hash apart", new Set([kingdomHash(g), kingdomHash(st), kingdomHash(h)]).size === 3);
  // Claim Cold Hearth the way a player does, and compare what each realm is given and eats.
  const claimed = (w: KingdomWorld): KingdomWorld => {
    w.issue({ kind: "rally" });
    for (let i = 0; i < TICKS_PER_DAY * 6; i++) w.tick();
    w.issue({ kind: "claimHolding", holding: w.holdingByKey("cold-hearth")!.id });
    for (let i = 0; i < 2; i++) w.tick();
    return w;
  };
  const [cg, cs, ch] = [claimed(make("gentle")), claimed(make("standard")), claimed(make("hard"))];
  check("the first holding's gift is bigger on Gentle and smaller on Hard",
    cg.kingStocks.stocks.grain > cs.kingStocks.stocks.grain && cs.kingStocks.stocks.grain > ch.kingStocks.stocks.grain,
    cg.kingStocks.stocks.grain + " > " + cs.kingStocks.stocks.grain + " > " + ch.kingStocks.stocks.grain);
  // A town's dole is a fraction of a grain a head and carries its remainder,
  // so it is compared over a season of days, not one.
  const eaten = (w: KingdomWorld): number => {
    let n = 0;
    for (let d = 0; d < 90; d++) {
      for (let i = 0; i < TICKS_PER_DAY; i++) w.tick();
      n += w.dailyNeed();
    }
    return n;
  };
  const [eg, es, eh] = [eaten(cg), eaten(cs), eaten(ch)];
  check("the king's realm eats less on Gentle and more on Hard (a season's need)", eg < es && es < eh, eg + " < " + es + " < " + eh);
  check("the machine's commander steps down on Gentle and up on Hard, clamped at the ends",
    battleDifficultyShifted(g, "sergeant") === "recruit" && battleDifficultyShifted(st, "sergeant") === "sergeant" &&
    battleDifficultyShifted(h, "sergeant") === "captain" && battleDifficultyShifted(g, "levy") === "levy" && battleDifficultyShifted(h, "marshal") === "marshal");
  // The save carries it, and an older save keeps the numbers it was played under.
  const back = loadFromJson(saveToJson(cg));
  check("a Gentle realm saves and loads as Gentle, to the same hash", back.ok && back.value.difficulty === "gentle" && kingdomHash(back.value) === kingdomHash(cg));
  check("a Gentle realm's log replays to the same realm at its difficulty",
    kingdomHash(replayLog(11, cg.log, cg.now, { difficulty: "gentle" })) === kingdomHash(cg));
  const old = JSON.parse(JSON.stringify(serialize(cg))) as Record<string, unknown>;
  old.version = 11;
  delete old.difficulty;
  const mig = deserialize(old);
  check("a version-11 save loads as Standard (a game under way is never made easier behind the player's back)",
    mig.ok && mig.value.difficulty === "standard", mig.ok ? "" : mig.error);
  const bad = JSON.parse(JSON.stringify(serialize(cg))) as Record<string, unknown>;
  bad.difficulty = "nightmare";
  check("a save with no known difficulty is refused, not guessed", !deserialize(bad).ok);
}

const keepFields = steward(["cold-hearth", "greyshaw", "rookstead", "thornwick", "fell-end"]);
const players: readonly Strategy[] = [PASSIVE, CAREFUL, CARELESS, BUILDER];
const rows: Row[] = [];
const t0 = Date.now();

console.log("K11 difficulty sweep: " + YEARS + " years, seeds " + SEEDS.join(",") + ", the new game's realm (hosts, captains, story, auto-farming)");
console.log(pad("difficulty", 10) + pad("player", 10) + pad("seed", 5) + pad("hungry", 8) + pad("famine", 8) + pad("towns", 7) +
  pad("people", 8) + pad("grain", 8) + pad("coin", 7) + pad("waves", 7) + "  king");
for (const diff of KINGDOM_DIFFICULTY_IDS) {
  for (const s of players) {
    for (const seed of SEEDS) {
      const r = runStrategy(seed, s, YEARS * DAYS_PER_YEAR, {
        autoFarm: true,
        everyDay: s.name === "passive" ? undefined : keepFields,
        config: { hosts: true, captains: true, story: true, difficulty: diff },
      });
      let hungry = 0;
      let famine = 0;
      for (const d of r.days) { if (d.hunger > 0) hungry++; if (d.famine > 0) famine++; }
      const w = r.world;
      const towns = w.holdingsOf("king");
      const st = w.economy[KING_PLAYER].stocks;
      const row: Row = {
        diff, strategy: s.name, seed, hungry, famine, towns: towns.length,
        people: towns.reduce((n, h) => n + h.population, 0), grain: st.grain, coin: st.coin,
        fallen: w.story?.ending === "the-fallen", waves: w.wavesRode.filter(Boolean).length,
        lastDay: w.date.day, townsYear1: r.days.find((d) => d.day === DAYS_PER_YEAR)?.owned ?? 0,
      };
      rows.push(row);
      console.log(pad(diff, 10) + pad(s.name, 10) + pad(seed, 5) + pad(hungry, 8) + pad(famine, 8) + pad(row.towns, 7) +
        pad(row.people, 8) + pad(row.grain, 8) + pad(row.coin, 7) + pad(row.waves, 7) + "  " + (row.fallen ? "fell on day " + row.lastDay : "lives"));
    }
  }
}

const of = (diff: KingdomDifficultyId, strategy: string): Row[] => rows.filter((r) => r.diff === diff && r.strategy === strategy);
const sum = (rs: Row[], k: "grain" | "people" | "hungry" | "famine" | "lastDay"): number => rs.reduce((n, r) => n + r[k], 0);

console.log("\nthe economy");
// Gentle, the new game's default: every player who claims a holding lives
// through both years, fed. Standard and Hard are the realm as it was
// balanced before K11 and harder: a king who raises no army at all keeps his
// first holding through the first year and its winter, and loses it to the
// first story wave in the second summer -- the war the story is about, and
// the reason Gentle is the default (docs/PROVISIONAL.md K11.4).
for (const name of ["passive", "careful", "careless", "builder"]) {
  const rs = of("gentle", name);
  check("gentle: the " + name + " king lives through " + YEARS + " years with a holding on every seed",
    rs.every((r) => !r.fallen && r.towns >= 1), rs.map((r) => r.seed + ":" + r.towns + (r.fallen ? "F" + r.lastDay : "")).join(" "));
}
for (const name of ["passive", "careful"]) {
  const rs = of("gentle", name);
  check("gentle: the " + name + " king's realm is never hungry for long (under 30 days of " + YEARS * DAYS_PER_YEAR + ")",
    rs.every((r) => r.hungry < 30 && r.famine < 30), rs.map((r) => r.seed + ":" + r.hungry + "/" + r.famine).join(" "));
  const st = of("standard", name);
  check("standard: the " + name + " king keeps his holding through the first year and its winter, fed",
    st.every((r) => r.lastDay > DAYS_PER_YEAR && r.townsYear1 >= 1 && r.hungry < 30), st.map((r) => r.seed + ":" + r.lastDay + "/" + r.townsYear1 + "/" + r.hungry).join(" "));
}
check("gentle: the builder grows past the passive king (people at the end, every seed)",
  of("gentle", "builder").every((b) => b.people > (of("gentle", "passive").find((p) => p.seed === b.seed)?.people ?? 0)),
  of("gentle", "builder").map((b) => b.seed + ":" + b.people + ">" + (of("gentle", "passive").find((p) => p.seed === b.seed)?.people ?? 0)).join(" "));
for (const diff of KINGDOM_DIFFICULTY_IDS) {
  check(diff + ": the builder holds more than the passive king at the end of the first year (every seed)",
    of(diff, "builder").every((b) => b.townsYear1 > (of(diff, "passive").find((p) => p.seed === b.seed)?.townsYear1 ?? 0)),
    of(diff, "builder").map((b) => b.seed + ":" + b.townsYear1).join(" "));
}
check("gentle is a lot easier than standard: the passive king's grain at the end is higher on every seed",
  of("gentle", "passive").every((g) => g.grain > (of("standard", "passive").find((x) => x.seed === g.seed)?.grain ?? Infinity)),
  of("gentle", "passive").map((g) => g.seed + ":" + g.grain + ">" + (of("standard", "passive").find((x) => x.seed === g.seed)?.grain ?? "?")).join(" "));
check("hard is no easier than standard: the passive king falls no later (summed over seeds)",
  sum(of("hard", "passive"), "lastDay") <= sum(of("standard", "passive"), "lastDay"),
  sum(of("hard", "passive"), "lastDay") + " <= " + sum(of("standard", "passive"), "lastDay"));

console.log("\nthe story (the kind king of tools/story-bot.ts)");
type StoryRow = { diff: KingdomDifficultyId; seed: number; actDays: number[]; ending: string | null; day: number };
const story: StoryRow[] = [];
for (const diff of KINGDOM_DIFFICULTY_IDS) {
  for (const seed of STORY_SEEDS) {
    const r = play("kind", false, { seed, difficulty: diff, maxDays: DAYS_PER_YEAR * 6 });
    // The chronicle opens each act on the day it began.
    const actDays = [1, 2, 3, 4].map((a) => r.w.story!.chronicle.find((c) => c.key === "act:" + a + ":intro")?.day ?? -1);
    story.push({ diff, seed, actDays, ending: r.ending, day: r.day });
    console.log("  " + pad(diff, 8) + " seed " + pad(seed, 5) + ": acts began on days " + actDays.map((d) => (d < 0 ? "-" : d)).join(", ") +
      "; " + (r.ending ? r.ending + " on day " + r.day + " (year " + r.w.date.year + ")" : "no ending by day " + r.day) +
      "; holdings " + r.w.holdingsOf("king").length);
  }
}
for (const diff of ["gentle", "standard"] as const) {
  const rs = story.filter((r) => r.diff === diff);
  check(diff + ": the story reaches its fourth act within four years on every seed",
    rs.every((r) => r.actDays[3] >= 0 && r.actDays[3] < DAYS_PER_YEAR * 4), rs.map((r) => r.seed + ":" + r.actDays[3]).join(" "));
}

console.log("\n(" + ((Date.now() - t0) / 1000).toFixed(1) + " s)");
console.log(failures === 0 ? "all " + checks + " difficulty checks passed" : failures + " of " + checks + " difficulty checks FAILED");
if (failures > 0) process.exit(1);
