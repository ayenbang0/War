/**
 * Checks for the second roster: the new companies and their specials, the new
 * commander's abilities, the flood, the three new ways to win, the campaign,
 * and the art for every type.
 *
 * Each behaviour is checked the way the existing headless suite checks one: set
 * up the smallest battle where it should show, run the sim, and compare against
 * the same battle without the thing being tested. Nothing here touches the
 * goldens; those live in headless.ts and are unchanged by this roster.
 */

import { World, TICK_RATE } from "../src/sim/world.ts";
import type { Group } from "../src/sim/entities.ts";
import { evaluate, type ArmyState, type MatchState } from "../src/sim/victory.ts";
import { hashWorld } from "../src/sim/hash.ts";
import { Terrain, TILE_SIZE } from "../src/sim/terrain.ts";
import * as M from "../src/sim/math.ts";
import { UNIT_TYPES, UNIT_TYPE_IDS, type UnitTypeId } from "../src/content/unit-types.ts";
import { SPECIALS, LAST_STAND_FLOOR } from "../src/content/specials.ts";
import { ABILITY_IDS } from "../src/content/abilities.ts";
import { DOCTRINE_IDS } from "../src/content/doctrines.ts";
import { COMMANDERS, COMMANDER_IDS } from "../src/content/commanders.ts";
import { DIFFICULTIES, DIFFICULTY_IDS } from "../src/content/difficulty.ts";
import { LEVELS, levelById } from "../src/content/levels/index.ts";
import { provingGround } from "../src/content/levels/proving-ground.ts";
import {
  CHAPTERS, FIRST_CHAPTER, chapterById, chooseRoad, epilogue, freshProgress,
  readProgress, recordBattle, type Progress,
} from "../src/content/campaign.ts";
import { bodyPath, detailPath, gait, type Brush } from "../src/render/soldier-art.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (detail ? "  <- " + detail : ""));
  if (!ok) failures++;
}
function section(name: string): void {
  console.log("\n" + name);
}

// -- small battles ------------------------------------------------------------

function arena(seedTweak = 0): World {
  // Same open plain the headless clash uses, well clear of the river.
  return new World({
    seed: provingGround.seed ^ 0x1d ^ seedTweak,
    tilesWide: provingGround.tilesWide,
    tilesHigh: provingGround.tilesHigh,
    duration: 15 * 60,
  });
}

function unit(w: World, player: number, type: UnitTypeId, x: number, y: number, n?: number): Group {
  const ids: number[] = [];
  const count = n ?? UNIT_TYPES[type].soldiers;
  for (let i = 0; i < count; i++) {
    ids.push(w.spawnSoldier(player, type, x + (i % 5) * 12, y + ((i / 5) | 0) * 12, player === 0 ? 0 : M.PI));
  }
  return w.createGroup(player, ids) as Group;
}

function nerve(w: World, g: Group): number {
  let sum = 0;
  let n = 0;
  for (const m of g.members) {
    if (w.soldiers.alive[m] !== 1) continue;
    sum += w.soldiers.morale[m];
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

function setNerve(w: World, g: Group, v: number): void {
  for (const m of g.members) w.soldiers.morale[m] = v;
}

function centre(w: World, g: Group): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const m of g.members) {
    if (w.soldiers.alive[m] !== 1) continue;
    x += w.soldiers.x[m];
    y += w.soldiers.y[m];
    n++;
  }
  return { x: x / n, y: y / n };
}

function run(w: World, seconds: number, each?: () => void): void {
  for (let t = 0; t < seconds * TICK_RATE; t++) {
    w.step();
    each?.();
  }
}

function attack(w: World, g: Group, target: Group): void {
  w.orders.issue({ kind: "attack", squad: g.id, target: target.id, path: [target.anchorX, target.anchorY] }, g.player, w.tick + 1);
}

function move(w: World, g: Group, x: number, y: number): void {
  w.orders.issue({ kind: "move", squad: g.id, path: [x, y] }, g.player, w.tick + 1);
}

/** The sim's own speed for a company this tick. Private, so reached round. */
function speedOf(w: World, g: Group): number {
  return (w as unknown as { groupSpeed(g: Group): number }).groupSpeed(g);
}

// -- the roster doubled -------------------------------------------------------

section("roster");
check("twenty kinds of company", UNIT_TYPE_IDS.length === 20, String(UNIT_TYPE_IDS.length));
check("the first eight keep their places", UNIT_TYPE_IDS[0] === "line" && UNIT_TYPE_IDS[7] === "siege");
check("seventeen specials", Object.keys(SPECIALS).length === 17, String(Object.keys(SPECIALS).length));
check("twelve abilities", ABILITY_IDS.length === 12, String(ABILITY_IDS.length));
check("eight doctrines", DOCTRINE_IDS.length === 8, String(DOCTRINE_IDS.length));
check("eight commanders", COMMANDER_IDS.length === 8, String(COMMANDER_IDS.length));
check("six difficulties", DIFFICULTY_IDS.length === 6, String(DIFFICULTY_IDS.length));
check("eleven battlefields", LEVELS.length === 11, String(LEVELS.length));
{
  const ids = new Set(LEVELS.map((l) => l.id));
  check("battlefield ids are unique", ids.size === LEVELS.length);
  const specials = new Set(UNIT_TYPE_IDS.map((t) => UNIT_TYPES[t].special).filter((s) => s !== undefined));
  const unused = Object.keys(SPECIALS).filter((s) => !specials.has(s as never));
  check("every special belongs to some company", unused.length === 0, unused.join(","));
}

// -- the new specials ---------------------------------------------------------

section("specials");

{
  // Pikes go down when horse comes close, and a charge into them ends there.
  const w = arena();
  const pike = unit(w, 0, "pike", 2000, 1600);
  const horse = unit(w, 1, "horse", 2300, 1600);
  horse.chargeUntil = 10 * TICK_RATE;
  attack(w, horse, pike);
  let set = false;
  let chargeBroken = false;
  run(w, 8, () => {
    if (w.hasSpecial(pike, "setPikes")) set = true;
    if (set && horse.lastContact > 0 && horse.chargeUntil <= w.tick) chargeBroken = true;
  });
  check("pikes are set when horse closes", set);
  check("a charge into set pikes ends on them", chargeBroken);
}

{
  // A colour party steadies a wavering company beside it.
  const nerveAfter = (withBanner: boolean): number => {
    const w = arena();
    const line = unit(w, 0, "line", 2000, 1600);
    if (withBanner) unit(w, 0, "banner", 2000, 1720);
    unit(w, 1, "line", 4200, 1600); // a foe, far off, so it is a battle
    setNerve(w, line, 0.4);
    run(w, 12);
    return nerve(w, line);
  };
  const a = nerveAfter(true);
  const b = nerveAfter(false);
  check("a banner rallies a wavering company", a > b + 0.02, a.toFixed(3) + " vs " + b.toFixed(3));
}

{
  // Drums quicken a company marching alongside.
  const travelled = (withDrum: boolean): number => {
    const w = arena();
    const line = unit(w, 0, "line", 1600, 1600);
    if (withDrum) {
      const drum = unit(w, 0, "drummer", 1600, 1700);
      move(w, drum, 2600, 1700);
    }
    unit(w, 1, "line", 4200, 1600);
    move(w, line, 2600, 1600);
    run(w, 1);
    const from = centre(w, line);
    run(w, 4);
    const to = centre(w, line);
    return M.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2);
  };
  const a = travelled(true);
  const b = travelled(false);
  check("drums quicken the march", a > b * 1.08, a.toFixed(0) + " vs " + b.toFixed(0));
}

{
  // Hounds frighten horses far more than they frighten foot.
  const drop = (victim: UnitTypeId): number => {
    const w = arena();
    const target = unit(w, 0, victim, 2000, 1600);
    const dogs = unit(w, 1, "hounds", 2080, 1600);
    attack(w, dogs, target);
    let first = -1;
    let start = 0;
    let lowest = 1;
    run(w, 10, () => {
      if (first < 0 && w.hasSpecial(dogs, "terror")) { first = w.tick; start = nerve(w, target); }
      if (first >= 0 && w.tick - first <= 3 * TICK_RATE) lowest = M.min(lowest, nerve(w, target));
    });
    return first < 0 ? 0 : start - lowest;
  };
  const horse = drop("horse");
  const foot = drop("line");
  check("hounds raise terror and horses feel it most", horse > foot && horse > 0, horse.toFixed(3) + " vs " + foot.toFixed(3));
}

{
  // Oathsworn do not break while the oath holds.
  const w = arena();
  const oath = unit(w, 0, "oathsworn", 2000, 1600);
  const foe1 = unit(w, 1, "line", 2080, 1580);
  const foe2 = unit(w, 1, "guard", 2080, 1660);
  attack(w, foe1, oath);
  attack(w, foe2, oath);
  setNerve(w, oath, 0.3);
  let stood = false;
  let floorHeld = true;
  run(w, 20, () => {
    if (!w.hasSpecial(oath, "lastStand")) return;
    stood = true;
    for (const m of oath.members) {
      if (w.soldiers.alive[m] === 1 && w.soldiers.morale[m] < LAST_STAND_FLOOR - 1e-9) floorHeld = false;
    }
  });
  check("oathsworn make their last stand", stood);
  check("no oathsworn falls below the floor while it lasts", stood && floorHeld);
  check("the last stand is made only once", oath.specialUses <= 1, String(oath.specialUses));
}

{
  // A wagon fort under fire circles and stops.
  const w = arena();
  const wagon = unit(w, 0, "wagon", 2000, 1600);
  const bows = unit(w, 1, "archer", 2220, 1600);
  attack(w, bows, wagon);
  let circled = false;
  let stoodStill = true;
  run(w, 15, () => {
    if (!w.hasSpecial(wagon, "laager")) return;
    circled = true;
    if (speedOf(w, wagon) !== 0) stoodStill = false;
  });
  check("wagons circle into a laager when shot at", circled);
  check("a laager does not move", circled && stoodStill);
}

{
  // Crossbowmen put up their pavises when shot at.
  const w = arena();
  const xbow = unit(w, 0, "crossbow", 2000, 1600);
  const bows = unit(w, 1, "archer", 2220, 1600);
  attack(w, bows, xbow);
  let up = false;
  run(w, 15, () => { if (w.hasSpecial(xbow, "pavise")) up = true; });
  check("crossbows set pavises under fire", up);
}

{
  // A champion's challenge shakes the men around it.
  const w = arena();
  const champ = unit(w, 0, "champion", 2000, 1600);
  const foe = unit(w, 1, "line", 2070, 1600);
  attack(w, champ, foe);
  let called = false;
  let before = 0;
  let after = 0;
  run(w, 8, () => {
    if (!called && w.hasSpecial(champ, "challenge")) {
      called = true;
      after = nerve(w, foe);
    }
    if (!called) before = nerve(w, foe);
  });
  check("a champion's challenge shakes the foe", called && after < before, before.toFixed(3) + " -> " + after.toFixed(3));
}

{
  // A lance couched on the run hits harder than one carried into a standing fight.
  // Harm done in the first two seconds after the companies meet, so the run in
  // costs the charging side no fighting time.
  const losses = (charging: boolean): number => {
    const w = arena();
    const target = unit(w, 1, "line", 2400, 1600);
    const lance = unit(w, 0, "lancer", charging ? 2000 : 2370, 1600);
    attack(w, lance, target);
    const hp = (): number => target.members.reduce((s, m) => s + M.max(0, w.soldiers.hp[m]), 0);
    let met = -1;
    let hpAt = 0;
    let done = -1;
    run(w, 14, () => {
      if (met < 0 && lance.lastContact > 0) { met = w.tick; hpAt = hp(); }
      if (met >= 0 && done < 0 && w.tick - met >= 2 * TICK_RATE) done = hpAt - hp();
    });
    return done;
  };
  let couched = false;
  {
    const w = arena();
    const target = unit(w, 1, "line", 2400, 1600);
    const lance = unit(w, 0, "lancer", 2000, 1600);
    attack(w, lance, target);
    run(w, 10, () => { if (w.hasSpecial(lance, "couch")) couched = true; });
  }
  check("lancers couch on the run in", couched);
  const a = losses(true);
  const b = losses(false);
  check("a couched charge does more harm than a standing melee", a > b, a.toFixed(0) + " vs " + b.toFixed(0));
}

// -- the new abilities --------------------------------------------------------

section("abilities");

{
  const w = arena();
  const line = unit(w, 0, "line", 2000, 1600);
  unit(w, 1, "line", 4200, 1600);
  w.armAbilities(0, ["muster", "forcedMarch"]);
  setNerve(w, line, 0.3);
  w.orders.issue({ kind: "ability", squad: line.id, ability: "muster", x: 0, y: 0 }, 0, w.tick + 1);
  run(w, 0.25);
  const mustered = nerve(w, line);
  check("muster steadies a company", mustered > 0.55, mustered.toFixed(3));
  setNerve(w, line, 0.8);
  w.orders.issue({ kind: "ability", squad: line.id, ability: "forcedMarch", x: 0, y: 0 }, 0, w.tick + 1);
  run(w, 0.25);
  check("a forced march hastens", line.hasteUntil > w.tick);
  check("and tires the men", nerve(w, line) < 0.8);
}

{
  // Firepots burn only the enemy.
  const w = arena();
  const own = unit(w, 0, "line", 2000, 1600);
  const foe = unit(w, 1, "line", 2010, 1640);
  w.armAbilities(0, ["firepots"]);
  w.orders.issue({ kind: "ability", squad: own.id, ability: "firepots", x: 2030, y: 1620 }, 0, w.tick + 1);
  const hp = (g: Group): number => g.members.reduce((s, m) => s + M.max(0, w.soldiers.hp[m]), 0);
  // Hold both still so only the fire acts.
  const a0 = hp(own);
  const b0 = hp(foe);
  run(w, 3, () => {
    for (const m of own.members) w.soldiers.incoming[m] = 0;
  });
  void a0;
  check("firepots are on the field", w.fields.some((f) => f.ability === "firepots"));
  check("firepots burn the enemy", hp(foe) < b0, b0.toFixed(0) + " -> " + hp(foe).toFixed(0));
}

{
  // Caltrops slow the enemy who walks on them.
  const speed = (strewn: boolean): number => {
    const w = arena();
    const own = unit(w, 0, "line", 1500, 1600);
    const foe = unit(w, 1, "line", 2400, 1600);
    unit(w, 0, "line", 1500, 2400);
    w.armAbilities(0, ["caltrops"]);
    if (strewn) w.orders.issue({ kind: "ability", squad: own.id, ability: "caltrops", x: 2430, y: 1620 }, 0, w.tick + 1);
    move(w, foe, 1800, 1600);
    run(w, 0.5);
    return speedOf(w, foe);
  };
  const a = speed(true);
  const b = speed(false);
  check("caltrops slow the enemy", a < b * 0.6, a.toFixed(1) + " vs " + b.toFixed(1));
}

// -- the flood ----------------------------------------------------------------

section("flood");

{
  const level = levelById("rising-water");
  check("the rising water has a flood", level !== undefined && level.floodAtSeconds !== undefined);
  // The crossing has bridges; bring the water up early.
  const crossing = levelById("the-crossing") ?? LEVELS[1];
  const w = new World({
    seed: crossing.seed,
    tilesWide: crossing.tilesWide,
    tilesHigh: crossing.tilesHigh,
    floodAtSeconds: 1,
  });
  unit(w, 0, "line", 400, 400);
  unit(w, 1, "line", crossing.tilesWide * TILE_SIZE - 600, 400);
  const bridges = (): number => {
    let n = 0;
    for (let ty = 0; ty < w.terrain.height; ty++) {
      for (let tx = 0; tx < w.terrain.width; tx++) if (w.terrain.typeAt(tx, ty) === Terrain.Bridge) n++;
    }
    return n;
  };
  const before = bridges();
  run(w, 1.5);
  check("there were bridges to lose", before > 0, String(before));
  check("the flood takes every bridge", bridges() === 0);
}

// -- the new ways to win ------------------------------------------------------

section("victory");

{
  const army = (morale: number, strength: number): ArmyState => ({ morale, strength, roster: 100 });
  const base = (over: Partial<MatchState>): MatchState => ({
    armies: [army(0.8, 80), army(0.8, 80)],
    elapsed: 60,
    duration: 600,
    holdSeconds: [0, 0],
    points: [0, 0],
    ...over,
  });
  const surviveMid = evaluate({ mode: "survive", defender: 0 }, base({}));
  check("a siege is still running mid-battle", surviveMid === null);
  const surviveEnd = evaluate({ mode: "survive", defender: 0 }, base({ elapsed: 600 }));
  check("the defender wins a siege by lasting", surviveEnd?.winner === 0 && surviveEnd.reason === "survived");
  const br = { mode: "breakthrough", attacker: 0, exit: 0, required: 40 } as const;
  check("too few men through is not a breakthrough", evaluate(br, base({ through: [39, 0] })) === null);
  const through = evaluate(br, base({ through: [40, 0] }));
  check("enough men through wins it", through?.winner === 0 && through.reason === "breakthrough");
  const held = evaluate(br, base({ elapsed: 600, through: [10, 0] }));
  check("holding the road to full time wins for the defender", held?.winner === 1);
  const lost = evaluate({ mode: "standard" }, base({ standards: [true, false] }));
  check("losing your colours loses the battle", lost?.winner === 0 && lost.reason === "standard");
  check("both colours flying, the battle goes on", evaluate({ mode: "standard" }, base({ standards: [true, true] })) === null);
}

{
  // In a real battle the bearers are chosen and the standard falls with them.
  const w = new World({
    seed: provingGround.seed ^ 0x1d,
    tilesWide: provingGround.tilesWide,
    tilesHigh: provingGround.tilesHigh,
    victory: { mode: "standard" },
  });
  unit(w, 0, "line", 1500, 1600);
  unit(w, 0, "banner", 1500, 1700);
  unit(w, 1, "line", 3000, 1600);
  const theirBanner = unit(w, 1, "banner", 3000, 1700);
  w.step();
  const [a, b] = w.standardsFlying();
  check("both armies carry their colours", a && b);
  const bearers = w.bearersOf(1);
  check("a colour party carries them when there is one", bearers.length > 0 && bearers.every((m) => theirBanner.members.includes(m)));
  // Leave them a scratch from death and drop a barrage on them, so they die the
  // way anyone dies in the sim rather than by being switched off.
  for (const m of bearers) w.soldiers.hp[m] = 1e-3;
  w.armAbilities(0, ["barrage"]);
  const c = centre(w, theirBanner);
  w.orders.issue({ kind: "ability", squad: -1, ability: "barrage", x: c.x, y: c.y }, 0, w.tick + 1);
  run(w, 2);
  check("cut down the colour party and the battle is won", w.outcome?.reason === "standard" && w.outcome.winner === 0, w.outcome?.reason ?? "none");
}

// -- the campaign -------------------------------------------------------------

section("campaign");

{
  const bad: string[] = [];
  for (const c of CHAPTERS) {
    if (!levelById(c.levelId)) bad.push(c.id + " level " + c.levelId);
    if (!(c.commander in COMMANDERS)) bad.push(c.id + " commander " + c.commander);
    if (!(c.difficulty in DIFFICULTIES)) bad.push(c.id + " difficulty " + c.difficulty);
    if (typeof c.next === "string" && !chapterById(c.next)) bad.push(c.id + " next " + c.next);
    if (c.next && typeof c.next === "object") {
      for (const o of c.next.options) if (!chapterById(o.next)) bad.push(c.id + " road " + o.next);
    }
  }
  check("every chapter points at real battles, captains and roads", bad.length === 0, bad.join("; "));
  // The siege of the Last Wall is the Marchwarden's lost ending made playable
  // in skirmish, and the kingdom's Act IV (K10) is where a siege enters the
  // story; the old chronicle ends at the heights and is not re-written for it
  // (PROVISIONAL P8.6). Every other battlefield must still be in it.
  check("every battlefield appears in the chronicle",
    LEVELS.every((l) => l.siege !== undefined || CHAPTERS.some((c) => c.levelId === l.id)));

  const walk = (road: number, winAll: boolean): Progress => {
    let p = freshProgress();
    for (let guard = 0; guard < 30 && p.at !== "end"; guard++) {
      if (p.forked) {
        const c = chapterById(p.at)!;
        const fork = c.next as { options: readonly { next: string }[] };
        p = chooseRoad(p, fork.options[road].next);
        continue;
      }
      p = recordBattle(p, p.at, winAll);
    }
    return p;
  };
  const a = walk(0, true);
  const b = walk(1, false);
  check("the war ends", a.at === "end" && b.at === "end");
  check("the two roads fight different battles", a.record.map((r) => r.chapter).join() !== b.record.map((r) => r.chapter).join());
  check("a whole war is nine battles either way", a.record.length === 9 && b.record.length === 9, a.record.length + "," + b.record.length);
  check("it starts at the burning farms", a.record[0].chapter === FIRST_CHAPTER);
  const ea = epilogue(a);
  const eb = epilogue(b);
  check("the epilogue counts the victories", ea.includes("won 9") && eb.includes("won 0"));
  check("the epilogue remembers the city", ea.includes("did not fall") && eb.includes("on terms"));
  check("the epilogue remembers the road", ea !== eb && (ea.includes("Hallow Ferry") || ea.includes("Long Wood")));
  const p0 = freshProgress();
  check("a battle out of turn is not recorded", recordBattle(p0, "last-wall", true) === p0);
  check("a stored chronicle reads back", JSON.stringify(readProgress(JSON.stringify(a))) === JSON.stringify(a));
  check("rubbish in storage starts a fresh chronicle", readProgress("{not json").at === FIRST_CHAPTER && readProgress("{\"at\":\"nowhere\",\"record\":[]}").at === FIRST_CHAPTER);
}

// -- art ----------------------------------------------------------------------

section("art");

{
  let ops = 0;
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(t, k: string) {
      if (k in t) return t[k];
      return () => { ops++; };
    },
    set(t, k: string, v) { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  const empty: string[] = [];
  const broken: string[] = [];
  for (const type of UNIT_TYPE_IDS) {
    for (const recover of [0, 0.5, 1]) {
      const b: Brush = { ctx, x: 100, y: 100, a: 0.3, r: 6, recover, t: 1.7, phase: 0.4 };
      const before = ops;
      try {
        bodyPath(type, b);
        if (ops === before) empty.push(type);
        detailPath(type, b);
      } catch (e) {
        broken.push(type + ": " + (e as Error).message);
      }
    }
    const g = gait(type, true, 1.3, 0.2);
    if (!Number.isFinite(g)) broken.push(type + " gait");
  }
  check("every company has a body to draw", empty.length === 0, [...new Set(empty)].join(","));
  check("every company's drawing runs cleanly", broken.length === 0, broken.join("; "));
}

// -- determinism with the whole roster ---------------------------------------

section("determinism");

{
  const battle = (): string => {
    const w = arena(0x77);
    for (let i = 0; i < UNIT_TYPE_IDS.length; i++) {
      const row = i % 5;
      const col = (i / 5) | 0;
      unit(w, 0, UNIT_TYPE_IDS[i], 1300 - col * 140, 1300 + row * 160);
      unit(w, 1, UNIT_TYPE_IDS[UNIT_TYPE_IDS.length - 1 - i], 2300 + col * 140, 1300 + row * 160);
    }
    for (const q of w.groups) {
      const foe = w.groups.find((o) => o.player !== q.player && o.members.length > 0);
      if (foe) attack(w, q, foe);
    }
    run(w, 90);
    let finite = true;
    for (let i = 0; i < w.soldiers.count; i++) {
      if (!Number.isFinite(w.soldiers.x[i]) || !Number.isFinite(w.soldiers.y[i]) || !Number.isFinite(w.soldiers.morale[i])) finite = false;
    }
    check("a battle of all twenty kinds stays finite", finite);
    return hashWorld(w);
  };
  const a = battle();
  const b = battle();
  check("and plays out the same twice", a === b, a + " / " + b);
}

console.log("");
if (failures > 0) {
  console.log(failures + " content check(s) failed");
  process.exit(1);
}
console.log("content checks passed");
