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

import { TICKS_PER_DAY, kingdomHash, replayLog } from "../src/sim/kingdom/index.ts";
import { holds, chronicleLine } from "../src/sim/kingdom/story.ts";
import { KING_PLAYER } from "../src/content/kingdom/factions.ts";
import { ENDINGS } from "../src/content/story/endings.ts";
import { ACTS } from "../src/content/story/acts.ts";
import { saveToJson, loadFromJson } from "../src/sim/kingdom/save.ts";
import { SEED, VERBOSE, play, type Run } from "./story-bot.ts";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failures++;
  console.log((ok ? "  ok    " : "  FAIL  ") + name + (detail ? "  <- " + detail : ""));
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
