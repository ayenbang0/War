/**
 * Checks for the story content written ahead of K9 (src/content/story/:
 * cutscene, acts, letters, encounters, free companies, chronicle, endings,
 * tutorial). Part of `npm test`.
 *
 * Holds the content to what the plan asks of it (PLAN.md Part A, §B.11a K9):
 *   - it validates: every id it names exists (holdings, provinces, captains,
 *     levels, chapters, companies, abilities, letters, flags), every effect is
 *     in range, every act can be finished, every ending can be reached and the
 *     endings' thresholds cover the plane exactly once, the tutorial teaches
 *     every control, and no string guesses anyone's gender;
 *   - it is the right size: an 8-14 beat cutscene, four acts, the nine
 *     Marchwarden battles re-cast with every captain met, three crowned endings
 *     and a failure ending, all fourteen battle strokes taught;
 *   - it is plain data: it survives a JSON round trip unchanged, so K9 can
 *     save, hash and localise it;
 *   - and the validators are not dead: each kind of mistake they claim to
 *     catch, planted in a copy, is caught.
 *
 * No sim runs here; K9's own playthrough proof will drive these tables
 * through the kingdom.
 */

import {
  STORY, validateStory, validateCutscene, validateActs, validateLetters, validateEncounters,
  validateMercenaries, validateChronicle, validateEndings, validateTutorial, validateFlags, validateWords,
  coronationRange, sentenceCount, BATTLE_GESTURE_CLASSES, KINGDOM_PEN_CLASSES, CUTSCENE, ACTS, ENDINGS,
  ENCOUNTERS, STORY_LETTERS, TUTORIAL, MERCENARIES, CROWN_LEGITIMACY, CROWN_MERCY, type StoryContent,
} from "../src/content/story/index.ts";
import { CHAPTERS } from "../src/content/campaign.ts";
import { COMMANDER_IDS } from "../src/content/commanders.ts";
import { ENCOUNTER_HOSTS } from "../src/content/story/encounter-hosts.ts";
import { UNIT_TYPE_IDS } from "../src/content/unit-types.ts";
import { MAX_SQUADS } from "../src/content/army.ts";
import { LESSON_ENEMY, LESSON_LETTER, LESSON_PLACES, lessonArmies, lessonLetter, lessonRealm, lessonTown } from "../src/sim/kingdom/tutorial.ts";
import { kingdomHash } from "../src/sim/kingdom/hash.ts";
import { armyVisible } from "../src/sim/kingdom/armies.ts";
import { FACTION_IDS as KFACTIONS, KING_PLAYER } from "../src/content/kingdom/factions.ts";
import { STORY_LETTERS as LETTERS_TABLE } from "../src/content/story/letters.ts";
import { TUTORIAL as TUTORIAL_TABLE } from "../src/content/story/tutorial.ts";
import { satisfies } from "../src/ui/story/coach.ts";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  <- " + detail : ""));
  if (!ok) failures++;
}
function section(name: string): void {
  console.log("\n" + name);
}

// -- 1. the content validates ----------------------------------------------------------

section("validity");
const parts: [string, () => string[]][] = [
  ["cutscene", validateCutscene], ["acts", validateActs], ["letters", validateLetters],
  ["encounters", validateEncounters], ["free companies", validateMercenaries], ["chronicle", validateChronicle],
  ["endings", validateEndings], ["tutorial", validateTutorial], ["flags", validateFlags], ["words", validateWords],
];
for (const [name, f] of parts) {
  const p = f();
  check(name + " valid", p.length === 0, p.slice(0, 3).join(" | "));
}
check("the whole story valid", validateStory().length === 0);

// -- 2. the right size --------------------------------------------------------------

section("shape");
check("the cutscene has 8-14 beats, each at most two sentences", CUTSCENE.beats.length >= 8 && CUTSCENE.beats.length <= 14 &&
  CUTSCENE.beats.every((b) => sentenceCount(b.text) <= 2), CUTSCENE.beats.length + " beats");
check("the cutscene is skippable", CUTSCENE.skippable === true);
check("four acts, I to IV", ACTS.map((a) => a.id).join() === "1,2,3,4");
check("act I starts from nothing: no goal is already met on day one", ACTS[0].goals.every((g) => g.condition.kind !== "holdingsHeld" || g.condition.n >= 1));
check("every Marchwarden chapter is re-cast", CHAPTERS.every((c) => ENCOUNTERS.some((e) => e.chapter === c.id)), CHAPTERS.length + " chapters");
check("every captain has a first encounter", COMMANDER_IDS.every((c) => ENCOUNTERS.some((e) => e.faction === c && e.first)));
const crowned = ENDINGS.filter((e) => e.gate.kind === "crowned").map((e) => e.title).sort().join(", ");
// K9: every encounter puts a host in the field (encounter-hosts.ts), of real units and an army's size.
check("every encounter has a host, and only encounters do", ENCOUNTERS.every((e) => (ENCOUNTER_HOSTS[e.id]?.length ?? 0) > 0) &&
  Object.keys(ENCOUNTER_HOSTS).every((id) => ENCOUNTERS.some((e) => e.id === id)));
check("every host is of real units and fits one army", Object.values(ENCOUNTER_HOSTS).every((h) =>
  h.length <= MAX_SQUADS && h.every((u) => (UNIT_TYPE_IDS as readonly string[]).includes(u))));
check("three crowned endings and a failure", crowned === "The Hollow Crown, The Iron Crown, The Restored King" && ENDINGS.some((e) => e.gate.kind === "failure"), crowned);
check("the battle recogniser has fourteen classes and the tutorial teaches each", BATTLE_GESTURE_CLASSES.length === 14 &&
  BATTLE_GESTURE_CLASSES.every((c) => TUTORIAL.some((t) => t.success.kind === "gesture" && t.success.class === c)));
check("every kingdom pen order of §B.5 is taught", KINGDOM_PEN_CLASSES.every((c) => TUTORIAL.some((t) => t.success.kind === "kingdomGesture" && t.success.class === c)));
check("the tutorial covers all three layers", ["kingdom", "city", "battle"].every((l) => TUTORIAL.some((t) => t.layer === l)));
for (const kind of ["reread", "fork", "demand", "forgery", "offer", "betrayal", "reveal", "encounter"] as const) {
  check("there are " + kind + " letters", STORY_LETTERS.some((l) => l.kind === kind));
}
check("Isolde's mid-game fork has the three answers (villain, coward, secret ally)", (() => {
  const f = STORY_LETTERS.find((l) => l.id === "isolde-fork");
  const flags = f ? f.choices.flatMap((c) => c.effects.filter((e) => e.kind === "flag").map((e) => (e as { flag: string }).flag)) : [];
  return ["isolde-villain", "isolde-coward", "isolde-ally"].every((x) => flags.includes(x));
})());
check("the usurper is revealed in Act III", STORY_LETTERS.some((l) => l.kind === "reveal" && l.act === 3 && /Oswin Vael/.test(l.text)));
check("every free company is offered and betrays or tests the king somewhere, or is reliable",
  MERCENARIES.every((m) => m.reputation === "reliable" || STORY_LETTERS.some((l) => l.kind === "betrayal" && l.choices.some((c) => c.effects.some((e) => (e.kind === "companyLeaves" || e.kind === "loyalty") && e.company === m.id)))));
const r = coronationRange();
check("the coronation range straddles both ending lines", r.legitimacy[0] < CROWN_LEGITIMACY && r.legitimacy[1] >= CROWN_LEGITIMACY &&
  r.mercy[0] < CROWN_MERCY && r.mercy[1] >= CROWN_MERCY, "legitimacy " + r.legitimacy.join("..") + ", mercy " + r.mercy.join(".."));
check("no text reads as a sandbox battler", !/\b(skirmish mode|point-buy|sandbox|custom battle|quick battle)\b/i.test(JSON.stringify(STORY.letters) + JSON.stringify(STORY.tutorial) + JSON.stringify(CUTSCENE)));

// -- 3. plain data ------------------------------------------------------------------

section("plain data");
const clone = (): StoryContent => JSON.parse(JSON.stringify(STORY)) as StoryContent;
check("the story survives a JSON round trip", JSON.stringify(clone()) === JSON.stringify(STORY));
check("and the copy validates too", validateStory(clone()).length === 0);

// -- 4. the validators are not dead -------------------------------------------------

section("validators catch");
// Loose on purpose: the mutations write fields the readonly types forbid.
type Loose = any;
function caught(name: string, mutate: (s: Loose) => void): void {
  const s = clone() as Loose;
  mutate(s);
  const p = validateStory(s as StoryContent);
  check(name, p.length > 0, p[0] ?? "nothing reported");
}
const letter = (s: Loose, id: string): Loose => s.letters.find((l: Loose) => l.id === id);
const enc = (s: Loose, id: string): Loose => s.encounters.find((e: Loose) => e.id === id);

caught("a letter listed twice", (s) => { s.letters.push(JSON.parse(JSON.stringify(s.letters[0]))); });
caught("an encounter at a holding that does not exist", (s) => { enc(s, "three-bridges").holding = "atlantis"; });
caught("an encounter not on its chapter's battlefield", (s) => { enc(s, "three-bridges").levelId = "open-field"; });
caught("an encounter easier than its chapter", (s) => { enc(s, "rising-water").difficulty = "levy"; });
caught("an encounter on ground that fights like another level", (s) => { enc(s, "the-stones").holding = "lisle"; });
caught("a captain fighting with another's habits", (s) => { enc(s, "long-wood").commander = "fox"; });
caught("a chapter nobody re-casts", (s) => { s.encounters = s.encounters.filter((e: Loose) => e.chapter !== "rising-water"); s.letters = s.letters.filter((l: Loose) => l.id !== "enc-rising-water"); });
caught("an undeclared flag in a trigger", (s) => { letter(s, "ferry-falls").trigger.of[0].flag = "road-swamp"; });
caught("a declared flag nothing reads", (s) => { s.flags["nobody-reads-this"] = "a note"; s.letters[0].choices[0].effects.push({ kind: "flag", flag: "nobody-reads-this" }); });
caught("a declared flag nothing sets", (s) => { s.flags["nobody-sets-this"] = "a note"; s.endings[0].epilogue.push({ text: "Never read.", when: { kind: "flag", flag: "nobody-sets-this" } }); });
caught("a letter whose every choice costs", (s) => { for (const c of letter(s, "first-follower").choices) c.effects.push({ kind: "pay", cost: { coin: 1 } }); });
caught("a letter with one choice", (s) => { letter(s, "first-follower").choices.splice(1); });
caught("a letter nothing sends", (s) => { letter(s, "first-follower").trigger = null; });
caught("a follow-up to a letter that does not exist", (s) => { letter(s, "offer-harker").choices[1].effects[0].letter = "lost-in-the-post"; });
caught("an ability that does not exist", (s) => { enc(s, "burning-farms").wonEffects.push({ kind: "unlockAbility", ability: "teleport" }); });
caught("mercy out of range", (s) => { letter(s, "winter-bread").choices[2].effects[1].delta = -40; });
caught("a hire that pays nothing", (s) => { letter(s, "offer-harker").choices[0].effects.shift(); });
caught("an act goal the story cannot reach", (s) => { s.acts[0].goals.push({ id: "saint", text: "Be a saint", condition: { kind: "legitimacyAtLeast", n: 100 } }); });
caught("an act goal needing a flag only a later act sets", (s) => { s.acts[0].goals.push({ id: "early", text: "Too early", condition: { kind: "flag", flag: "isolde-ally" } }); });
caught("a battle an act needs that can be declined for good", (s) => { letter(s, "enc-burning-farms").choices[1].effects = [{ kind: "legitimacy", delta: -1 }]; });
caught("a battle an act needs that closes the act when lost", (s) => { enc(s, "burning-farms").lostEffects = []; });
caught("endings that overlap", (s) => { s.endings.find((e: Loose) => e.id === "iron-crown").gate.mercy = { below: CROWN_MERCY + 5 }; });
caught("endings that leave a gap", (s) => { s.endings.find((e: Loose) => e.id === "hollow-crown").gate.legitimacy = { below: CROWN_LEGITIMACY - 5 }; });
caught("an ending the story cannot reach", (s) => {
  s.endings.find((e: Loose) => e.id === "hollow-crown").gate.legitimacy = { below: 5 };
  s.endings.find((e: Loose) => e.id === "iron-crown").gate.legitimacy = { min: 5 };
  s.endings.find((e: Loose) => e.id === "restored-king").gate.legitimacy = { min: 5 };
});
caught("a crowned ending missing", (s) => { s.endings = s.endings.filter((e: Loose) => e.id !== "iron-crown"); });
caught("a tutorial that skips a stroke", (s) => { s.tutorial = s.tutorial.filter((t: Loose) => t.id !== "drill-feint"); });
caught("a tutorial that skips a glyph", (s) => { s.tutorial = s.tutorial.filter((t: Loose) => t.id !== "drill-wedge"); });
caught("a tutorial that skips a map order", (s) => { s.tutorial = s.tutorial.filter((t: Loose) => t.id !== "army-merge"); });
caught("a tutorial step of three sentences", (s) => { s.tutorial[0].text = "One. Two. Three."; });
caught("a battle stroke taught on the map", (s) => { s.tutorial.find((t: Loose) => t.id === "drill-hold").layer = "kingdom"; });
caught("a cutscene too short", (s) => { s.cutscene.beats = s.cutscene.beats.slice(0, 5); });
caught("a cutscene beat of three sentences", (s) => { s.cutscene.beats[1].text = "One. Two. Three."; });
caught("a cutscene road nobody can travel", (s) => { s.cutscene.beats.find((b: Loose) => b.stage.shot === "road").stage.to = "atlantis"; });
caught("a cutscene that cannot be skipped", (s) => { s.cutscene.skippable = false; });
caught("a chronicle line with a placeholder it did not declare", (s) => { s.chronicle[0].variants[0] += " {weather}"; });
caught("a season with no chronicle entry", (s) => { s.chronicle = s.chronicle.filter((c: Loose) => c.season !== "winter"); });
caught("a free company not named the companies.ts way", (s) => { s.mercenaries[0].name = "The Golden Company"; });
caught("a free company whose letter charges the wrong fee", (s) => { letter(s, "offer-harker").choices[0].effects[0].cost.coin = 99; });
caught("a gendered pronoun", (s) => { s.letters[0].text = "The shepherd came, and he brought a dog."; });
caught("a gendered title", (s) => { s.acts[1].intro.text = "My lord, the Marches."; });
caught("a captain sworn who cannot swear", (s) => { letter(s, "stag-yields").choices[0].effects[0].faction = "usurper"; });

// -- K9: the tutorial's practice realm (sim/kingdom/tutorial.ts) -----------------------

{
  const a = lessonRealm();
  const b = lessonRealm();
  check("the practice realm is the same realm every time", kingdomHash(a) === kingdomHash(b));
  check("the practice realm has the story on", a.story !== null && a.story.act === 1);
  check("and holds its letters until a lesson asks for one", a.story !== null && a.story.sent.every((x) => x) && a.story.pending.length === 0);
  for (let i = 0; i < 8 * 40; i++) a.tick();
  check("forty days alone send it no letter and arm no encounter", a.story !== null && a.story.pending.length === 0 &&
    a.story.encounters.every((e) => e.host === 0) && a.story.ending === null);
  const li = lessonLetter(a);
  check("the map lesson's letter comes when asked", li >= 0 && LETTERS_TABLE[li].id === LESSON_LETTER && a.story?.pending[0] === li);
  check("its places are on the map", Object.values(LESSON_PLACES).every((k) => a.holdingByKey(k) !== undefined));
  const keep = lessonTown(a);
  check("a skipped claim still leaves Rookstead the king's for the town lesson", keep.owner === "king");
  check("with a tavern standing in it", keep.buildings.includes("tavern") && keep.buildings.some((x) => x === null));
  lessonArmies(a, "raise");
  check("the armies lesson finds followers to raise", a.kingStocks.stocks.levy >= 4);
  lessonArmies(a, "armies");
  const own = a.armies.filter((x) => x.owner === KING_PLAYER);
  const foe = a.armies.filter((x) => x.owner === KFACTIONS.indexOf(LESSON_ENEMY));
  check("and an army of two companies to split", own.some((x) => x.squads.length >= 2));
  check("and an enemy to intercept, in the king's sight", foe.length === 1 && armyVisible(a, KING_PLAYER, foe[0]));
  lessonArmies(a, "armies");
  check("asked again, it raises nothing more", a.armies.filter((x) => x.owner === KING_PLAYER).length === own.length &&
    a.armies.filter((x) => x.owner === KFACTIONS.indexOf(LESSON_ENEMY)).length === 1);
  for (let i = 0; i < 8 * 10; i++) a.tick();
  check("the practice realm runs on with them", a.story?.ending === null, a.story?.ending ?? "");
}

// The coach's matcher against its own table: every step is satisfied by
// exactly what it names, and a near miss (another glyph, another tap) is not.
{
  let ok = 0;
  const bad: string[] = [];
  for (const t of TUTORIAL_TABLE) {
    if (satisfies(t.success, t.success as never)) ok++;
    else bad.push(t.id);
  }
  check("every tutorial step is satisfied by what it names", bad.length === 0, bad.join(", "));
  check("a line glyph does not pass for a wedge", !satisfies({ kind: "gesture", class: "formation", shape: "wedge" }, { kind: "gesture", class: "formation", shape: "line" }));
  check("a plain lasso does not pass for carving", !satisfies({ kind: "gesture", class: "lasso", detail: "carve" }, { kind: "gesture", class: "lasso" }));
  check("a tap on a lot does not pass for the square", !satisfies({ kind: "cityTap", target: "square" }, { kind: "cityTap", target: "lot" }));
  check("a march does not pass for an intercept", !satisfies({ kind: "kingdomGesture", class: "intercept" }, { kind: "kingdomGesture", class: "march" }));
  check("the matcher saw " + ok + " steps", ok === TUTORIAL_TABLE.length);
}

// -- summary ------------------------------------------------------------------------

console.log("");
if (failures > 0) {
  console.log(failures + " of " + checks + " story check(s) FAILED");
  process.exit(1);
}
console.log("all " + checks + " story checks passed");
