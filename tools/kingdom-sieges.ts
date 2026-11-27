/**
 * K10's proof (PLAN.md Phase 8 finished, §B.8 sieges): the siege battles the
 * kingdom fights at its walls.
 *
 *  1. The field a siege is fought on (app/battle-config.ts siegeFromSpec):
 *     for every level a kingdom battle can borrow, either side attacking,
 *     each kind of works -- nobody set down in a wall, the defender inside
 *     it, the attacker outside, the works raised as battered as the holding's.
 *  2. An assault on a walled town fought for real: kingdom contact -> spec ->
 *     a headless battle World -> result -> applied back; the walls the
 *     battle knocked down stay down on the holding.
 *  3. The townsmen in the keep: going in settles nothing; the keep's siege
 *     is a real battle of two courses of stone.
 *  4. Mending: the repair order, its cost, the masons' days, and walls down
 *     for good (WALLS_DOWN) leaving a holding unwalled.
 *  5. Act IV: the siege of Rimaros launched from the kingdom, played by the
 *     machine on both sides, its result applied back, and the story carried
 *     on from it to an ending.
 *  6. The save (v11): walls, mending and the keep round-trip; a v10 save
 *     migrates to the same realm; tampering is refused.
 *
 * Deterministic: fixed seeds, the machine commanding both sides.
 */

import {
  KingdomWorld, TICKS_PER_DAY, armyById, raiseArmy, standsIn, kingdomHash, serialize, deserialize, migrate,
  buildBattleSpec, resultFromBattle, resultRefusal, fortificationOf,
  type Army, type Contact, type Holding, type KingdomEvent, type KingdomOrderBody,
} from "../src/sim/kingdom/index.ts";
import { sendLetter } from "../src/sim/kingdom/story.ts";
import { ENDINGS } from "../src/content/story/endings.ts";
import { wallRepairCost } from "../src/sim/kingdom/economy.ts";
import { KING_PLAYER, FACTION_IDS } from "../src/content/kingdom/factions.ts";
import { SIEGE_SACK, WALLS_DOWN, WALL_REPAIR } from "../src/content/kingdom/descent.ts";
import { BIOMES } from "../src/content/kingdom/terrain.ts";
import { REFUSAL } from "../src/content/kingdom/ui-strings.ts";
import { STORY_LETTERS } from "../src/content/story/letters.ts";
import { ENCOUNTERS } from "../src/content/story/encounters.ts";
import { LEVELS, levelById } from "../src/content/levels/index.ts";
import { battleFromSpec, battleWorld, siegeFromSpec } from "../src/app/battle-config.ts";
import { hashWorld } from "../src/sim/hash.ts";
import { gateTiles, insideSiege, onSiegeWall, siegeBounds } from "../src/sim/siege.ts";
import { TILE_SIZE } from "../src/sim/terrain.ts";
import type { BattleResult, BattleSpec, BattleSide } from "../src/sim/layers.ts";
import type { UnitTypeId } from "../src/content/unit-types.ts";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (!ok) failures++;
  console.log((ok ? "  ok    " : "  FAIL  ") + name + (detail ? "  <- " + detail : ""));
}
function section(name: string): void {
  console.log("\n[" + name + "]");
}

const SEED = 0x6b313000;
const KING = KING_PLAYER;
const id = (w: KingdomWorld, key: string): number => (w.holdingByKey(key) as Holding).id;

function issue(w: KingdomWorld, body: KingdomOrderBody, player = KING): string | null {
  const why = w.check(body, player);
  if (why === null) w.issue(body, player);
  return why;
}

/** March `a` toward `to` until a contact at `to` waits; other contacts on the way are resolved for the machine. */
function marchToContact(w: KingdomWorld, a: Army, to: number, maxDays = 60): Contact | null {
  w.issue({ kind: "marchArmy", army: a.id, to });
  for (let i = 0; i < maxDays * TICKS_PER_DAY; i++) {
    const c = w.contact;
    if (c && c.holding === to && c.sides[0].army === a.id) return c;
    if (c) {
      w.issue({ kind: "resolveContact", contact: c.id, choice: "auto", result: null });
    } else if (a.mover.route.length === 0 && standsIn(a.mover) !== to) {
      w.issue({ kind: "marchArmy", army: a.id, to });
    }
    w.tick();
    if (!armyById(w, a.id)) return null;
  }
  return null;
}

/** Fight the waiting contact out as a real battle, the machine commanding both sides. */
function fightOut(w: KingdomWorld, c: Contact): { spec: BattleSpec; result: BattleResult; battleHash: string; seconds: number; inside: number } {
  const spec = buildBattleSpec(w, c);
  const { world, fielded } = battleWorld(battleFromSpec(spec), { aiPlayers: [0, 1] });
  world.deploying = false;
  const cap = (spec.duration + 30) * 20;
  let ticks = 0;
  while (!world.outcome && ticks < cap) { world.step(); ticks++; }
  return { spec, result: resultFromBattle(spec, world, fielded), battleHash: hashWorld(world), seconds: ticks / 20, inside: world.wallDamage() };
}

// -- 1. the field ---------------------------------------------------------------------------

section("the field a siege is fought on");
{
  const side = (faction: number, n: number, unit: UnitTypeId): BattleSide => ({
    faction, army: faction === 0 ? 1 : 0, name: "side " + faction, doctrine: "defensive", commander: faction === 0 ? null : "badger",
    difficulty: "captain", abilities: [], morale: 60,
    squads: Array.from({ length: n }, (_, i) => ({ squad: i + 1, unit, men: 20, wounded: 0 })),
  });
  // Every level a kingdom battle can borrow: each country's, and each story encounter's.
  const levels = [...new Set([...Object.values(BIOMES).map((b) => b.level), ...ENCOUNTERS.map((e) => e.levelId)])].sort();
  let fields = 0;
  const problems: string[] = [];
  for (const level of levels) {
    const base = levelById(level);
    if (!base) { problems.push(level + ": no such level"); continue; }
    for (const fort of ["palisade", "wall", "keep"] as const) {
      for (const attacker of [0, 1]) {
        for (const n of [1, 4, 8]) {
          const spec: BattleSpec = {
            contact: 1, seed: 0x5eed + fields, terrain: { level, biome: "x", holding: 1, road: 0, fortification: fort, worn: 0 },
            sides: [side(0, attacker === 0 ? 8 : n, "line"), side(1, attacker === 1 ? 8 : n, "line")],
            deployment: { attacker, ambush: false },
            victory: { mode: "breakthrough", attacker, exit: 0, required: 10 },
            duration: 600, weather: "clear", season: "spring", sightScale: 1, reinforcements: [],
          };
          fields++;
          const tag = level + "/" + fort + "/att" + attacker + "/n" + n;
          const { world } = battleWorld(battleFromSpec(spec), { aiPlayers: [0, 1] });
          const works = world.siege;
          if (!works) { problems.push(tag + ": no works"); continue; }
          const s = world.soldiers;
          let bad = "";
          for (let i = 0; i < s.count && !bad; i++) {
            const tx = Math.floor(s.x[i] / TILE_SIZE);
            const ty = Math.floor(s.y[i] / TILE_SIZE);
            // (Not passableAt: an open field already sets men down on a river or
            // a crag on some grounds -- settleTerrain moves them -- which is
            // not the works' doing. The wall line is.)
            if (onSiegeWall(works, tx, ty)) bad = "a man on the wall line at " + tx + "," + ty;
            else if (s.player[i] === works.defender && !insideSiege(works, tx, ty)) bad = "a defender outside at " + tx + "," + ty;
            else if (s.player[i] !== works.defender && insideSiege(works, tx, ty)) bad = "an attacker inside at " + tx + "," + ty;
          }
          const b = siegeBounds(works);
          if (b.x0 < 1 || b.y0 < 1 || b.x1 > base.tilesWide - 2 || b.y1 > base.tilesHigh - 2) bad ||= "works off the field";
          if (works.gates.length !== (fort === "wall" ? 2 : 1)) bad ||= "gates " + works.gates.length;
          for (let g = 0; g < works.gates.length; g++) {
            if (gateTiles(world.terrain, works, g).length !== 3 * (works.thickness ?? 1)) bad ||= "gate " + g + " is not whole";
          }
          if ((fort === "keep") !== ((works.thickness ?? 1) === 2)) bad ||= "thickness";
          if (world.wallDamage() !== 0) bad ||= "whole works read damaged";
          if (bad) problems.push(tag + ": " + bad);
        }
      }
    }
  }
  check("every level, works, attacker and host size: nobody in a wall, the defender in, the attacker out, the gates whole (" + fields + " fields)",
    problems.length === 0, problems.slice(0, 4).join("; "));
  // Pure: the same spec builds the same walls; and battered works are raised battered.
  const spec: BattleSpec = {
    contact: 1, seed: 77, terrain: { level: levels[0], biome: "x", holding: 1, road: 0, fortification: "wall", worn: 300 },
    sides: [side(0, 6, "line"), side(1, 3, "line")], deployment: { attacker: 0, ambush: false },
    victory: { mode: "breakthrough", attacker: 0, exit: 0, required: 10 }, duration: 600, weather: "clear", season: "spring", sightScale: 1, reinforcements: [],
  };
  const base = levelById(levels[0])!;
  check("the works are the spec's alone (built twice, the same)", JSON.stringify(siegeFromSpec(spec, base)) === JSON.stringify(siegeFromSpec(spec, base)));
  const one = battleWorld(battleFromSpec(spec)).world;
  const two = battleWorld(battleFromSpec(spec)).world;
  check("and so is the field (the same hash)", hashWorld(one) === hashWorld(two));
  check("walls 30% down at the holding are raised 30% down", Math.abs(one.wallDamage() - 300) <= 5, String(one.wallDamage()));
  check("the heart of the works is the breakthrough's exit", battleFromSpec(spec).level.controlPoints.length === 1 &&
    spec.victory.mode === "breakthrough" && battleFromSpec(spec).level.controlPoints[0].id === spec.victory.exit);
  check("an open field has no works", battleFromSpec({ ...spec, terrain: { ...spec.terrain, fortification: "none", worn: 0 }, victory: { mode: "rout" } }).level.siege === undefined);
  void LEVELS;
}

// -- 2. an assault fought for real ----------------------------------------------------------------

section("an assault on a walled town, fought for real");
let assaultSave = "";
{
  const w = new KingdomWorld({ seed: SEED });
  const harrow = w.holding(id(w, "harrowfield")) as Holding;
  const slot = harrow.buildings.indexOf(null);
  harrow.buildings[slot] = "wall"; // test setup: stone walls standing, already battered
  harrow.walls = 200;
  const a = raiseArmy(w, KING, id(w, "rookstead"), ["siege", "siege", "line", "line", "line", "line", "archer", "archer"]);
  a.supply = 5000;
  const c = marchToContact(w, a, harrow.id);
  check("the march halts at the walls: an assault", !!c && c.kind === "assault" && c.attacker === 0);
  if (c) {
    const f = fightOut(w, c);
    check("the battle is a siege of the town's stone walls, raised as battered as they are",
      f.spec.terrain.fortification === "wall" && f.spec.terrain.worn === 200 && f.spec.victory.mode === "breakthrough");
    check("the battle was fought to an end (" + f.seconds + " s, winner " + f.result.winner + ")", f.seconds > 0);
    check("its result carries the walls it knocked down, and passes the kingdom's check",
      resultRefusal(f.spec, f.result) === null && f.result.damage.walls >= 0 && f.result.damage.walls <= WALLS_DOWN - 200,
      "walls " + f.result.damage.walls + " refusal " + resultRefusal(f.spec, f.result));
    check("the battle battered the walls (engines at work)", f.result.damage.walls > 0, String(f.result.damage.walls));
    const ev: KingdomEvent[] = [];
    issue(w, { kind: "resolveContact", contact: c.id, choice: "fight", result: f.result });
    ev.push(...w.tick());
    check("applied back: the holding's walls carry the battle's damage", harrow.walls === 200 + f.result.damage.walls, String(harrow.walls));
    check("and the realm is told", f.result.damage.walls === 0 || ev.some((e) => e.kind === "wallsDamaged" && e.holding === harrow.id));
    // The sack (K10.16): a town stormed through broken walls loses a building's work per quarter of them down.
    check("stormed through walls " + (200 + f.result.damage.walls) + "‰ down, the town is sacked by the rule",
      f.result.damage.buildings === (f.result.winner === 0 ? Math.floor((200 + f.result.damage.walls) / SIEGE_SACK.perBuilding) : 0),
      String(f.result.damage.buildings));
    {
      const spec = { ...f.spec, terrain: { ...f.spec.terrain, worn: 600 } };
      const sack = (winner: number): BattleResult => {
        const { world, fielded } = battleWorld(battleFromSpec(spec), { aiPlayers: [0, 1] });
        world.deploying = false;
        world.outcome = { winner, reason: "rout", detail: "test" };
        return resultFromBattle(spec, world, fielded);
      };
      const stormed = sack(0);
      const held = sack(1);
      check("walls 60% down and stormed: two buildings sacked; held: none", stormed.damage.buildings === 2 && held.damage.buildings === 0 &&
        resultRefusal(spec, stormed) === null, stormed.damage.buildings + " " + held.damage.buildings);
    }
    // Fought twice from the same realm: the same battle, to the man.
    const w2 = new KingdomWorld({ seed: SEED });
    const h2 = w2.holding(id(w2, "harrowfield")) as Holding;
    h2.buildings[slot] = "wall";
    h2.walls = 200;
    const a2 = raiseArmy(w2, KING, id(w2, "rookstead"), ["siege", "siege", "line", "line", "line", "line", "archer", "archer"]);
    a2.supply = 5000;
    const c2 = marchToContact(w2, a2, h2.id);
    const g = c2 ? fightOut(w2, c2) : null;
    check("deterministic: the same siege, the same battle", !!g && g.battleHash === f.battleHash && JSON.stringify(g.result) === JSON.stringify(f.result));
    assaultSave = JSON.stringify(serialize(w));
  }
}

// -- 3. the keep ---------------------------------------------------------------------------------

section("the townsmen in the keep: a real siege of two courses");
{
  const w = new KingdomWorld({ seed: SEED });
  const town = w.holding(id(w, "rookstead")) as Holding;
  town.owner = "king";
  town.population = 240;
  const s = town.buildings.indexOf(null);
  town.buildings[s] = "wall";
  const hare = FACTION_IDS.indexOf("hare");
  const host = raiseArmy(w, hare, id(w, "harrowfield"), ["siege", "line", "line", "line", "archer"], "defensive");
  host.supply = 5000;
  w.issue({ kind: "marchArmy", army: host.id, to: town.id }, hare);
  let c = w.contact;
  for (let i = 0; i < 40 * TICKS_PER_DAY && !c; i++) { w.tick(); c = w.contact; }
  check("the Hare comes to the king's walls", !!c && c.kind === "assault" && c.attacker === 1);
  if (c) {
    check("fall back to the keep: open to townsmen behind stone", issue(w, { kind: "resolveContact", contact: c.id, choice: "keep", result: null }) === null);
    const ev = w.tick();
    const k = w.contact;
    check("the keep settles nothing: the contact waits, in the keep", ev.some((e) => e.kind === "keepRetreat") && !!k && k.keep === true && k.id === c.id);
    if (k) {
      const f = fightOut(w, k);
      const cfg = battleFromSpec(f.spec);
      check("its battle is a siege of the keep: two courses of stone, one gate, the Hare storming",
        f.spec.terrain.fortification === "keep" && cfg.level.siege?.thickness === 2 && cfg.level.siege.gates.length === 1 &&
          f.spec.victory.mode === "breakthrough" && f.spec.victory.attacker === 1);
      check("fought out, its result passes the kingdom's check", resultRefusal(f.spec, f.result) === null, String(resultRefusal(f.spec, f.result)));
      const before = town.walls;
      issue(w, { kind: "resolveContact", contact: k.id, choice: "fight", result: f.result });
      const ev2 = w.tick();
      check("applied back: the siege of the keep is told, its damage on the holding's walls",
        !w.contact && ev2.some((e) => e.kind === "siege") && town.walls === before + f.result.damage.walls,
        "winner " + f.result.winner + " walls " + town.walls);
      check("whoever won, the holding is his", f.result.winner === 1 ? (town.owner as string) === "hare" : town.owner === "king", String(town.owner) + " " + f.result.winner);
    }
  }
}

// -- 3b. the machine's sieges ------------------------------------------------------------------------

section("a siege between two of the machine's sides (the Hare at the commons' walls): still auto-resolved");
{
  const w = new KingdomWorld({ seed: SEED });
  const town = w.holding(id(w, "rookstead")) as Holding;
  // Test setup: a walled town the commons rose and took (K8.6: hostile to the
  // crown's armies alone), the Hare marching to take it back.
  town.owner = "commons";
  town.population = 240;
  town.buildings[town.buildings.indexOf(null)] = "wall";
  const hare = FACTION_IDS.indexOf("hare");
  const host = raiseArmy(w, hare, id(w, "harrowfield"), ["siege", "line", "line", "line", "archer"], "defensive");
  host.supply = 5000;
  w.issue({ kind: "marchArmy", army: host.id, to: town.id }, hare);
  const ev: KingdomEvent[] = [];
  for (let i = 0; i < 40 * TICKS_PER_DAY && !ev.some((e) => e.kind === "contact"); i++) ev.push(...w.tick());
  const met = ev.find((e) => e.kind === "contact");
  check("the Hare meets the commons' walls: nobody waits on the king", !!met && met.kind === "contact" && !met.player && w.contact === null);
  check("settled at once, the walls battered by it", ev.some((e) => e.kind === "wallsDamaged" && e.holding === town.id) && town.walls > 0,
    "walls " + town.walls);
}

// -- 4. mending --------------------------------------------------------------------------------

section("mending the walls");
{
  const w = new KingdomWorld({ seed: SEED });
  const h = w.holding(id(w, "cold-hearth")) as Holding;
  h.owner = "king";
  const s = h.buildings.indexOf(null);
  check("no walls, nothing to mend", issue(w, { kind: "repairWalls", holding: h.id }) === REFUSAL.noWalls);
  h.buildings[s] = "wall";
  check("whole walls need no masons", issue(w, { kind: "repairWalls", holding: h.id }) === REFUSAL.wallsWhole);
  h.walls = 430;
  const cost = wallRepairCost(h);
  const q = WALL_REPAIR.perQuarter.wall;
  check("the cost is by the quarter of the works down (2 quarters of stone walls)",
    cost.coin === 2 * (q.coin ?? 0) && cost.timber === 2 * (q.timber ?? 0) && cost.iron === 2 * (q.iron ?? 0), JSON.stringify(cost));
  check("not the king's, not his to mend", issue(w, { kind: "repairWalls", holding: id(w, "harrowfield") }) === REFUSAL.notYours);
  const coin = w.kingStocks.stocks.coin;
  const timber = w.kingStocks.stocks.timber;
  const iron = w.kingStocks.stocks.iron;
  const enough = coin >= (cost.coin ?? 0) && timber >= (cost.timber ?? 0) && iron >= (cost.iron ?? 0);
  if (!enough) {
    check("too poor to pay the masons", issue(w, { kind: "repairWalls", holding: h.id }) === REFUSAL.cannotAfford);
    w.kingStocks.stocks.coin += cost.coin ?? 0; // test setup (not conserved: the ledger is not under test here)
    w.kingStocks.stocks.timber += cost.timber ?? 0;
    w.kingStocks.stocks.iron += cost.iron ?? 0;
  }
  const paid = { coin: w.kingStocks.stocks.coin, timber: w.kingStocks.stocks.timber, iron: w.kingStocks.stocks.iron };
  check("ordered", issue(w, { kind: "repairWalls", holding: h.id }) === null);
  const ev = w.tick();
  check("paid for, and the masons set to work", ev.some((e) => e.kind === "wallsRepairing" && e.holding === h.id) && h.mend === 430 &&
    w.kingStocks.stocks.coin === paid.coin - (cost.coin ?? 0) && w.kingStocks.stocks.timber === paid.timber - (cost.timber ?? 0));
  check("once is enough", issue(w, { kind: "repairWalls", holding: h.id }) === REFUSAL.wallsMending);
  const days: number[] = [];
  let mended = false;
  for (let d = 0; d < 10 && !mended; d++) {
    const t0 = w.date.day;
    while (w.date.day === t0) {
      for (const e of w.tick()) if (e.kind === "wallsMended" && e.holding === h.id) mended = true;
      if (w.contact) w.issue({ kind: "resolveContact", contact: w.contact.id, choice: "auto", result: null });
    }
    days.push(h.walls);
  }
  check("mended by the day (" + WALL_REPAIR.perDay + " a day): " + days.join(" "),
    mended && h.walls === 0 && h.mend === 0 && days.every((x, i) => i === 0 || x === Math.max(0, days[i - 1] - WALL_REPAIR.perDay)) && days.length >= 5);
  // Walls down for good.
  h.walls = WALLS_DOWN;
  check("walls knocked down to the last stone leave the holding unwalled", fortificationOf(h) === "none");
  h.walls = WALLS_DOWN - 1;
  check("one stone short of that, they still stand", fortificationOf(h) === "wall");
  h.walls = 0;
}

// -- 5. Act IV --------------------------------------------------------------------------------------

section("Act IV: the siege of Rimaros, from the kingdom to an ending");
{
  const w = new KingdomWorld({ seed: SEED, hosts: true, captains: true, autoFarm: true, story: true });
  const s = w.story!;
  const rimaros = w.holding(id(w, "rimaros")) as Holding;
  check("the Crown Seat is walled in stone (K10)", w.map.crownSeat === "rimaros" && fortificationOf(rimaros) === "wall", fortificationOf(rimaros));
  // Test setup: the story brought to its last act, the Last Wall fought (the
  // playthrough suite walks the whole road; this one starts at its end).
  s.act = 4;
  const lw = ENCOUNTERS.findIndex((e) => e.id === "last-wall");
  s.encounters[lw].state = "won";
  s.encounters[lw].fought = 1;
  const li = STORY_LETTERS.findIndex((l) => l.id === "enc-crown-siege");
  sendLetter(w, li);
  check("the letter comes: lay siege to Rimaros", issue(w, { kind: "answerLetter", letter: li, choice: 0 }) === null);
  w.tick();
  const ci = ENCOUNTERS.findIndex((e) => e.id === "crown-siege");
  const guard = armyById(w, s.encounters[ci].host);
  check("the Chancery Guard stands in Rimaros", s.encounters[ci].state === "armed" && !!guard && standsIn(guard.mover) === rimaros.id);
  // The king's siege train, raised at a holding of his on a road into the
  // capital (test setup: the act's first goal, held).
  let near = 0;
  for (const r of w.roads) {
    const other = r.a === rimaros.id ? r.b : r.b === rimaros.id ? r.a : 0;
    if (other === 0 || w.holding(other)!.garrison.length > 0 || w.armies.some((x) => standsIn(x.mover) === other)) continue;
    if (near === 0 || other < near) near = other;
  }
  (w.holding(near) as Holding).owner = "king";
  const army = raiseArmy(w, KING, near, ["siege", "siege", "guard", "guard", "line", "line", "crossbow", "archer"]);
  army.supply = 9000;
  check("a holding on a road into the capital, nobody in it", near !== 0);
  const c = marchToContact(w, army, rimaros.id);
  check("the march on the capital comes to its walls", !!c);
  if (c) {
    const f = fightOut(w, c);
    check("launched from the kingdom: the crown-siege's own field, a siege of stone walls the king must storm",
      f.spec.terrain.level === "last-wall-siege" && f.spec.terrain.fortification === "wall" && f.spec.victory.mode === "breakthrough" &&
        f.spec.victory.attacker === 0 && f.spec.sides[1].difficulty === "marshal",
      f.spec.terrain.level + " " + f.spec.terrain.fortification + " " + JSON.stringify(f.spec.victory) + " " + f.spec.sides[1].difficulty);
    check("played out headless (" + f.seconds + " s, winner " + f.result.winner + ", walls " + f.result.damage.walls + "‰)",
      f.seconds > 0 && resultRefusal(f.spec, f.result) === null, String(resultRefusal(f.spec, f.result)));
    const ev: KingdomEvent[] = [];
    issue(w, { kind: "resolveContact", contact: c.id, choice: "fight", result: f.result });
    ev.push(...w.tick());
    const fought = ev.find((e) => e.kind === "encounterFought");
    check("its result is applied back: the encounter is fought, the capital's walls carry the damage",
      !!fought && fought.kind === "encounterFought" && fought.encounter === ci && fought.won === (f.result.winner === 0) &&
        rimaros.walls === f.result.damage.walls, JSON.stringify(fought) + " walls " + rimaros.walls);
    if (f.result.winner === 0) {
      check("won: the walls are breached, Rimaros is the king's", s.flags.includes("walls-breached") && rimaros.owner === "king");
      const usurper = FACTION_IDS.indexOf("usurper");
      check("and the rest of its garrison gives up the walls (K10.8)",
        !w.armies.some((x) => x.owner === usurper && standsIn(x.mover) === rimaros.id && x.mover.route.length === 0) && ev.some((e) => e.kind === "fellBack" || e.kind === "armyGone"),
        ev.filter((e) => e.kind === "fellBack" || e.kind === "armyGone").map((e) => e.kind).join(","));
    } else {
      check("lost: the king's legitimacy suffers and the letter comes again", s.encounters[ci].state !== "won");
    }
    // On to an ending: the story's days run on; a lost siege is laid again
    // (each time as a real battle) until the capital falls.
    let tries = 1;
    for (let d = 0; d < 400 && s.ending === null; d++) {
      const t0 = w.date.day;
      while (w.date.day === t0 && s.ending === null) {
        const k = w.contact;
        if (k) {
          if (k.holding === rimaros.id && s.encounters[ci].state === "armed") {
            tries++;
            const g = fightOut(w, k);
            issue(w, { kind: "resolveContact", contact: k.id, choice: "fight", result: g.result });
          } else {
            w.issue({ kind: "resolveContact", contact: k.id, choice: "auto", result: null });
          }
        }
        for (const p of [...s.pending]) {
          const l = STORY_LETTERS[p];
          for (let ch = 0; ch < l.choices.length; ch++) if (issue(w, { kind: "answerLetter", letter: p, choice: ch }) === null) break;
        }
        w.tick();
      }
      const army2 = armyById(w, army.id);
      if (s.encounters[ci].state === "armed" && army2 && army2.mover.route.length === 0 && standsIn(army2.mover) !== rimaros.id) {
        w.issue({ kind: "marchArmy", army: army2.id, to: rimaros.id });
      }
    }
    const crowned = ENDINGS.find((e) => e.id === s.ending);
    check("the chronicle closes on a crowned ending (" + s.ending + ", after " + tries + " siege battle(s), day " + w.date.day + ")",
      !!crowned && crowned.gate.kind === "crowned" && s.encounters[ci].state === "won");
  }
}

// -- 6. the save ------------------------------------------------------------------------------------

section("the save: v11");
{
  const w = new KingdomWorld({ seed: SEED });
  const h = w.holding(id(w, "harrowfield")) as Holding;
  h.buildings[h.buildings.indexOf(null)] = "wall";
  h.walls = 640;
  h.mend = 300;
  const raw = serialize(w);
  check("saved as the current version (11 or later)", raw.version >= 11);
  const back = deserialize(JSON.parse(JSON.stringify(raw)));
  check("walls and mending round-trip", back.ok && kingdomHash(back.value) === kingdomHash(w) &&
    (back.value.holding(h.id) as Holding).walls === 640 && (back.value.holding(h.id) as Holding).mend === 300);
  check("the walls are in the realm's hash", (() => { h.walls = 641; const x = kingdomHash(w); h.walls = 640; return x !== kingdomHash(w); })());
  // A v10 save: no walls, no mending, no damage.walls in any result.
  const plain = new KingdomWorld({ seed: SEED });
  const v11 = JSON.parse(JSON.stringify(serialize(plain)));
  const v10 = JSON.parse(JSON.stringify(v11));
  v10.version = 10;
  for (const x of v10.snapshot.holdings) { delete x.walls; delete x.mend; }
  const m = migrate(v10);
  const mw = m.ok ? deserialize(m.value) : null;
  check("a v10 save migrates to the same realm", !!mw && mw.ok && kingdomHash(mw.value) === kingdomHash(plain));
  if (assaultSave) {
    const a10 = JSON.parse(assaultSave);
    a10.version = 10;
    for (const x of a10.snapshot.holdings) { delete x.walls; delete x.mend; }
    for (const o of a10.log) if (o.result) delete o.result.damage.walls;
    const am = migrate(a10);
    check("and a v10 log's battle results knocked down no wall", am.ok && (am.value.log as { result?: BattleResult }[]).every((o) => !o.result || o.result.damage.walls === 0));
  }
  const json = JSON.stringify(raw);
  const bad = (f: (s: Record<string, any>) => void): boolean => { const s = JSON.parse(json); f(s); return !deserialize(s).ok; };
  const at = w.holdings.indexOf(h);
  check("walls past down are refused", bad((s) => { s.snapshot.holdings[at].walls = WALLS_DOWN + 1; }));
  check("mending more than is down is refused", bad((s) => { s.snapshot.holdings[at].mend = 641; }));
  check("walls that are not a whole number are refused", bad((s) => { s.snapshot.holdings[at].walls = 1.5; }));
}

console.log("\n" + (failures === 0 ? "kingdom-sieges: all " + checks + " checks passed" : "kingdom-sieges: " + failures + " of " + checks + " checks FAILED"));
if (failures > 0) process.exit(1);
