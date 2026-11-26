/**
 * K5 test suite: the descent (PLAN.md §B.9, §B.11 K5). Part of `npm test`;
 * headless, no DOM -- the battle is a real battle World, built by the same
 * battleWorld() the BattleLayer builds it with, fought by the machine on
 * both sides.
 *
 * What it holds the sim to:
 *   - contact: two hostile armies within ENGAGE_RADIUS on one road or one
 *     holding meet, once per tick, in army-id order; both halt; the realm
 *     holds (the clock does not move, orders still apply) until it is
 *     settled; an army in the contact answers to nothing else;
 *   - walls: a march halts at hostile walls and the townsmen man them;
 *   - the handoff: buildBattleSpec is pure and its hash says so; a result
 *     round-trips; the zero-survivor and full-survivor boundaries hold;
 *     applyBattleResult never makes a man;
 *   - auto-resolve: deterministic, two draws on its own stream and none on
 *     any other, and strictly worse in expectation for the player than the
 *     even-handed resolve that stands for fighting it yourself;
 *   - withdraw: a rearguard and some nerve, a fall back away from the enemy;
 *     cut off, it cannot withdraw, and an army beaten cut off is taken;
 *   - save v5: a waiting contact survives save and load, the v4 -> v5
 *     migration, the log (resolveContact included) replays exactly;
 *   - THE PROOF: a march into an enemy army launches a real battle and its
 *     survivors come back to the kingdom, the same on every run (layerHash).
 */

import {
  KingdomWorld, kingdomHash, loadFromJson, saveToJson, serialize, deserialize, replayLog, migrate, KINGDOM_SAVE_VERSION,
  TICKS_PER_DAY, armyById, armyMen, raiseArmy, standsIn,
  buildBattleSpec, resultFromBattle, resultRefusal, retreatTarget, hostile, engaged, fortificationOf,
  autoResolve, resolvePowers, contactPoint, moraleFromNerve, rearguardOf,
  type Army, type KingdomEvent, type KingdomOrderBody, type Contact,
} from "../src/sim/kingdom/index.ts";
import {
  FACTION_IDS, DESCENT_REFUSAL, MILITIA_SQUADS, WITHDRAW_MORALE, WITHDRAW_REARGUARD_PERMILLE, OPENING_HOSTS,
  ENGAGE_RADIUS, nerveFromMorale, AUTORESOLVE,
} from "../src/content/kingdom/index.ts";
import { hashBattleSpec, hashBattleResult, layerHash, type BattleResult, type BattleSpec } from "../src/sim/layers.ts";
import { Rng, Stream } from "../src/sim/rng.ts";
import { hashWorld } from "../src/sim/hash.ts";
import { battleFromSpec, battleWorld } from "../src/app/battle-config.ts";
import { UNIT_TYPES } from "../src/content/unit-types.ts";

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

const SEED = 0x6b1d0005;
const KING = 0;
const HARE = FACTION_IDS.indexOf("hare");
const BOAR = FACTION_IDS.indexOf("boar");
const id = (w: KingdomWorld, key: string): number => w.holdingByKey(key)!.id;
function issue(w: KingdomWorld, body: KingdomOrderBody, player = KING): KingdomEvent[] {
  w.issue(body, player);
  return w.tick();
}
const men = (a: Army | undefined): number => (a ? armyMen(a) : 0);

/** A realm with the opening host at Harrowfield and the king's army at Rookstead, fed (test setup). */
function hostWorld(seed = SEED, units: readonly ("line" | "slinger" | "archer" | "scout")[] = ["line", "line", "slinger"]): { w: KingdomWorld; a: Army } {
  const w = new KingdomWorld({ seed, hosts: true });
  const a = raiseArmy(w, KING, id(w, "rookstead"), units);
  a.supply = 3000;
  return { w, a };
}

/** March `a` toward `to` until a contact waits (re-issuing past a site found on the way); the ticks it took, or -1. */
function marchToContact(w: KingdomWorld, a: Army, to: number, maxDays = 40): number {
  const t0 = w.now;
  w.issue({ kind: "marchArmy", army: a.id, to });
  for (let i = 0; i < maxDays * TICKS_PER_DAY && !w.contact; i++) {
    w.tick();
    if (!w.contact && a.mover.route.length === 0 && standsIn(a.mover) !== to) w.issue({ kind: "marchArmy", army: a.id, to });
  }
  return w.contact ? w.now - t0 : -1;
}

/** Fight the waiting contact out as a real battle, the machine commanding both sides. */
function fightOut(w: KingdomWorld): { spec: BattleSpec; result: BattleResult; battleHash: string; ticks: number } {
  const spec = buildBattleSpec(w, w.contact as Contact);
  const { world, fielded } = battleWorld(battleFromSpec(spec), { aiPlayers: [0, 1] });
  world.deploying = false;
  const cap = (spec.duration + 30) * 20;
  let ticks = 0;
  while (!world.outcome && ticks < cap) { world.step(); ticks++; }
  return { spec, result: resultFromBattle(spec, world, fielded), battleHash: hashWorld(world), ticks };
}

/** A result in which nobody was touched: every man back as he went, nobody won. */
function untouched(spec: BattleSpec): BattleResult {
  return {
    contact: spec.contact, winner: -1,
    squads: [spec.sides[0].squads.map((q) => ({ squad: q.squad, men: q.men, wounded: q.wounded })),
      spec.sides[1].squads.map((q) => ({ squad: q.squad, men: q.men, wounded: q.wounded }))],
    morale: [spec.sides[0].morale, spec.sides[1].morale], fled: [false, false], left: [false, false],
    damage: { crops: 0, buildings: 0, walls: 0 }, legitimacy: 0,
  };
}
/** A result in which `side` was wiped out and the other won untouched. */
function wipedOut(spec: BattleSpec, side: number): BattleResult {
  const r = untouched(spec);
  const squads: [BattleResult["squads"][0], BattleResult["squads"][1]] = [r.squads[0], r.squads[1]];
  squads[side] = spec.sides[side].squads.map((q) => ({ squad: q.squad, men: 0, wounded: 0 }));
  const fled: [boolean, boolean] = [side === 0, side === 1];
  return { ...r, winner: 1 - side, squads, fled, legitimacy: side === 1 ? 2 : -1 };
}

// -- 1. who fights whom -----------------------------------------------------------------------

section("hostility and the opening host");
{
  check("the king and the crown's captains are enemies", hostile(KING, HARE) && hostile(BOAR, KING));
  check("two of the crown's are not", !hostile(HARE, BOAR) && !hostile(KING, KING));
  const bare = new KingdomWorld({ seed: SEED });
  check("a bare world has no armies (K1-K4 worlds and the golden are untouched)", bare.armies.length === 0 && !bare.hosts);
  const w = new KingdomWorld({ seed: SEED, hosts: true });
  const host = w.armies[0];
  check("a new campaign opens with the Hare's host at Harrowfield", w.armies.length === OPENING_HOSTS.length &&
    host.owner === HARE && standsIn(host.mover) === id(w, "harrowfield") && w.events.length === 0);
  check("raised after every map id, so the map's ids are K4's", host.id > w.king.id);
}

// -- 2. contact ---------------------------------------------------------------------------------

section("contact: a march into an enemy army");
{
  const { w, a } = hostWorld();
  const host = w.armies[0];
  const took = marchToContact(w, a, id(w, "harrowfield"));
  const c = w.contact;
  check("a march into the Hare's host meets it", took > 0 && c !== null, "ticks " + took);
  check("the king's side is sides[0], and the marcher is the attacker",
    !!c && c.sides[0].army === a.id && c.sides[1].army === host.id && c.attacker === 0 && c.kind === "field");
  check("within ENGAGE_RADIUS by road (" + ENGAGE_RADIUS + " miles)", engaged(w, a, host));
  check("both halt where they stand", a.mover.route.length === 0 && host.mover.route.length === 0);
  check("it is fought at Harrowfield, on the road it was met on", !!c && c.holding === id(w, "harrowfield") && c.road === a.mover.road);
  const now = w.now;
  const h0 = kingdomHash(w);
  const weather = w.rng.weather.snapshot();
  for (let i = 0; i < 50; i++) w.tick();
  check("the realm holds: fifty ticks later nothing has moved", w.now === now && kingdomHash(w) === h0 &&
    JSON.stringify(w.rng.weather.snapshot()) === JSON.stringify(weather));
  const harrow = w.holding(id(w, "rookstead"))!;
  w.issue({ kind: "claimHolding", holding: harrow.id });
  const ev = w.tick();
  check("orders still apply while it holds (and the clock still does not move)", w.now === now && ev.some((e) => e.kind === "orderRejected" || e.kind === "claimed"));
  const refuse = (body: KingdomOrderBody): string | null => w.check(body);
  check("the army in it can be marched nowhere", refuse({ kind: "marchArmy", army: a.id, to: id(w, "rookstead") }) === DESCENT_REFUSAL.inContact);
  check("nor halted, split, garrisoned or stood down", [
    { kind: "haltArmy", army: a.id }, { kind: "split", army: a.id, squads: [a.squads[0].id] },
    { kind: "garrison", army: a.id }, { kind: "disband", army: a.id },
  ].every((b) => refuse(b as KingdomOrderBody) === DESCENT_REFUSAL.inContact));
  issue(w, { kind: "kingJoin", army: a.id });
  check("the king riding with it marches with it: refused too",
    w.king.army === 0 || refuse({ kind: "moveKing", to: id(w, "rookstead") }) === DESCENT_REFUSAL.inContact);
  check("a settlement for another contact is refused",
    refuse({ kind: "resolveContact", contact: 9999, choice: "auto", result: null }) === DESCENT_REFUSAL.noContact);
  check("only the king's seat settles it",
    w.check({ kind: "resolveContact", contact: c!.id, choice: "auto", result: null }, HARE) === DESCENT_REFUSAL.notYours);
  check("a fight needs its outcome", refuse({ kind: "resolveContact", contact: c!.id, choice: "fight", result: null }) === DESCENT_REFUSAL.fightNeedsResult);
  const spec = buildBattleSpec(w, c!);
  const fat = untouched(spec);
  const tooMany = { ...fat, squads: [fat.squads[0].map((q) => ({ ...q, men: q.men + 1 })), fat.squads[1]] as BattleResult["squads"] };
  check("an outcome with a man more than went in is refused", resultRefusal(spec, tooMany) === DESCENT_REFUSAL.badResult);
  check("an outcome of another battle is refused", resultRefusal(spec, { ...fat, contact: fat.contact + 1 }) === DESCENT_REFUSAL.wrongBattle);
  check("a withdrawal brings no outcome", refuse({ kind: "resolveContact", contact: c!.id, choice: "withdraw", result: fat }) === DESCENT_REFUSAL.resultOnlyFought);
}

section("contact: one at a time, in id order, and not again until parted");
{
  const { w, a } = hostWorld();
  // The same march at the same pace, a step behind in id: both come within reach on one tick.
  const b = raiseArmy(w, KING, id(w, "rookstead"), a.squads.map((q) => q.unit));
  b.supply = 3000;
  w.issue({ kind: "marchArmy", army: b.id, to: id(w, "harrowfield") });
  marchToContact(w, a, id(w, "harrowfield"));
  const c = w.contact!;
  check("two of the king's armies on the same road: the lower id meets first", c.sides[0].army === a.id);
  check("the other is in reach too, but waits its turn", c.sides[0].army !== b.id && engaged(w, b, armyById(w, c.sides[1].army)!));
  issue(w, { kind: "resolveContact", contact: c.id, choice: "withdraw", result: null });
  const next = w.contact as Contact | null;
  check("settled, the pair is disengaged", w.disengaged.some(([x, y]) => x === Math.min(a.id, c.sides[1].army) && y === Math.max(a.id, c.sides[1].army)));
  for (let i = 0; i < 3 && !w.contact; i++) w.tick();
  const second = w.contact as Contact | null;
  check("and meets the enemy once the first is settled", next === null && second !== null && second.sides[0].army === b.id);
  if (second) issue(w, { kind: "resolveContact", contact: second.id, choice: "withdraw", result: null });
  let again = false;
  for (let i = 0; i < 3 && !w.contact; i++) { w.tick(); if (w.contact && (w.contact as Contact).sides[0].army === a.id) again = true; }
  check("and does not meet again the moment it settles", !again);
}

// -- 3. walls -----------------------------------------------------------------------------------

section("walls: an assault on the townsmen");
{
  const w = new KingdomWorld({ seed: SEED });
  const harrow = w.holding(id(w, "harrowfield"))!;
  const slot = harrow.buildings.indexOf(null);
  harrow.buildings[slot] = "palisade"; // test setup: a palisade standing
  check("a palisade is a fortification", fortificationOf(harrow) === "palisade");
  const a = raiseArmy(w, KING, id(w, "rookstead"), ["line", "line", "line", "archer"]);
  a.supply = 3000;
  marchToContact(w, a, harrow.id);
  const c = w.contact;
  check("the march halts at the walls, and the townsmen come out", !!c && c.kind === "assault" && standsIn(a.mover) === harrow.id &&
    c.sides[1].army === 0 && c.sides[1].faction === HARE && c.attacker === 0);
  const spec = buildBattleSpec(w, c!);
  let townsmen = 0;
  for (const q of spec.sides[1].squads) townsmen += q.men;
  check("so many squads as its walls allow, from its people", spec.sides[1].squads.length === MILITIA_SQUADS.palisade &&
    townsmen > 0 && townsmen <= harrow.population / 10, townsmen + " men of " + harrow.population);
  check("and it is a siege: the defender wins by holding out, the attacker by getting men inside (K10)",
    spec.victory.mode === "breakthrough" && spec.victory.attacker === 0 && spec.terrain.fortification === "palisade" && spec.terrain.worn === 0);
  check("the townsmen cannot withdraw from their own walls; the attacker can",
    w.check({ kind: "resolveContact", contact: c!.id, choice: "withdraw", result: null }) === null);
  const pop0 = harrow.population;
  const r = wipedOut(spec, 1);
  issue(w, { kind: "resolveContact", contact: c!.id, choice: "fight", result: r });
  check("walls stormed change hands", harrow.owner === "king" && w.contact === null);
  check("and the townsmen who fell were its people", harrow.population === pop0 - townsmen);
}

// -- 4. the handoff ---------------------------------------------------------------------------

section("the handoff: spec, result, boundaries");
{
  const { w, a } = hostWorld();
  marchToContact(w, a, id(w, "harrowfield"));
  const c = w.contact!;
  const s1 = buildBattleSpec(w, c);
  const s2 = buildBattleSpec(w, c);
  check("the spec is pure: built twice, the same battle", hashBattleSpec(s1) === hashBattleSpec(s2) && JSON.stringify(s1) === JSON.stringify(s2));
  check("on the holding's own ground", s1.seed === w.holding(c.holding)!.seed && s1.terrain.level === "proving-ground");
  check("with the armies as they are, squad by squad", s1.sides[0].squads.every((q, i) =>
    q.squad === a.squads[i].id && q.men === a.squads[i].men && q.wounded === a.squads[i].wounded));
  check("the machine's side has its captain's habits", s1.sides[0].commander === null && s1.sides[1].commander === "hare");
  const before = s1.sides[0].morale;
  a.morale = before - 1;
  check("the hash sees every field (a point of morale)", hashBattleSpec(buildBattleSpec(w, c)) !== hashBattleSpec(s1));
  a.morale = before;
  const cfg = battleFromSpec(s1);
  check("the battle fields the fit men, with the army's nerve", cfg.field!.men[0].every((n, i) => n === a.squads[i].men - a.squads[i].wounded) &&
    cfg.field!.nerve[0] === nerveFromMorale(a.morale));
  check("nerve and morale round-trip", [0, 1, 37, 60, 99, 100].every((m) => moraleFromNerve(nerveFromMorale(m)) === m));

  // Full-survivor boundary: everyone back as he went -- nothing changes but who stands where.
  const full = untouched(s1);
  const mens0 = a.squads.map((q) => [q.men, q.wounded].join());
  const host = armyById(w, c.sides[1].army)!;
  const host0 = host.squads.map((q) => [q.men, q.wounded].join());
  const json = JSON.stringify(full);
  issue(w, { kind: "resolveContact", contact: c.id, choice: "fight", result: full });
  check("full survivors: every squad as it was", a.squads.map((q) => [q.men, q.wounded].join()).join() === mens0.join() &&
    host.squads.map((q) => [q.men, q.wounded].join()).join() === host0.join());
  check("the result is plain data and survives JSON", hashBattleResult(JSON.parse(json)) === hashBattleResult(full));

  // Zero-survivor boundary, both ways.
  const z = hostWorld();
  marchToContact(z.w, z.a, id(z.w, "harrowfield"));
  const zs = buildBattleSpec(z.w, z.w.contact!);
  const zHost = z.w.contact!.sides[1].army;
  issue(z.w, { kind: "resolveContact", contact: z.w.contact!.id, choice: "fight", result: wipedOut(zs, 1) });
  check("no survivors: the enemy's army is gone from the map", !armyById(z.w, zHost) && armyById(z.w, z.a.id) !== undefined);
  const z2 = hostWorld();
  issue(z2.w, { kind: "kingJoin", army: z2.a.id });
  issue(z2.w, { kind: "haltArmy", army: z2.a.id });
  marchToContact(z2.w, z2.a, id(z2.w, "harrowfield"));
  const z2s = buildBattleSpec(z2.w, z2.w.contact!);
  const ev = issue(z2.w, { kind: "resolveContact", contact: z2.w.contact!.id, choice: "fight", result: wipedOut(z2s, 0) });
  check("no survivors of the king's: his army fell, and he rides alone",
    !armyById(z2.w, z2.a.id) && z2.w.king.army === 0 && ev.some((e) => e.kind === "armyGone" && e.reason === "fell"));
  check("and the realm is free again", z2.w.contact === null);
}

section("the handoff: a real battle round-trips");
{
  const { w, a } = hostWorld();
  marchToContact(w, a, id(w, "harrowfield"));
  const c = w.contact!;
  const hostId = c.sides[1].army;
  const before = [men(a), men(armyById(w, hostId))];
  const { spec, result } = fightOut(w);
  check("the battle was fought to a decision", result.winner === 0 || result.winner === 1, "winner " + result.winner);
  check("never more men out than went in", [0, 1].every((s) => result.squads[s].every((q, j) => q.men <= spec.sides[s].squads[j].men)));
  check("the outcome fits its spec", resultRefusal(spec, result) === null);
  issue(w, { kind: "resolveContact", contact: c.id, choice: "fight", result });
  const after = [men(armyById(w, a.id)), men(armyById(w, hostId))];
  const want = [0, 1].map((s) => result.squads[s].reduce((n, q) => n + q.men, 0));
  check("the survivors in the kingdom are the battle's", after[0] === want[0] && after[1] === want[1],
    before.join("/") + " -> " + after.join("/") + " (battle said " + want.join("/") + ")");
  const loser = result.winner === 0 ? hostId : a.id;
  const lost = armyById(w, loser);
  check("the beaten side falls back from the field", !lost || lost.mover.route.length > 0);
}

// -- 5. auto-resolve ----------------------------------------------------------------------------

section("auto-resolve: deterministic, its own stream, worse for the player");
{
  const { w, a } = hostWorld();
  marchToContact(w, a, id(w, "harrowfield"));
  const spec = buildBattleSpec(w, w.contact!);
  const r1 = autoResolve(spec, Rng.create(9, Stream.Autoresolve), true);
  const r2 = autoResolve(spec, Rng.create(9, Stream.Autoresolve), true);
  check("the same draws, the same outcome", hashBattleResult(r1) === hashBattleResult(r2));
  const rng = Rng.create(9, Stream.Autoresolve);
  autoResolve(spec, rng, true);
  const twice = Rng.create(9, Stream.Autoresolve);
  twice.nextFloat(); twice.nextFloat();
  check("always exactly two draws", JSON.stringify(rng.snapshot()) === JSON.stringify(twice.snapshot()));
  check("its outcome fits its spec", resultRefusal(spec, r1) === null);

  const others = (["economy", "events", "kingdomAi", "weather"] as const).map((s) => JSON.stringify(w.rng[s].snapshot()));
  const auto0 = JSON.stringify(w.rng.autoresolve.snapshot());
  issue(w, { kind: "resolveContact", contact: w.contact!.id, choice: "auto", result: null });
  check("resolving for the king draws on the autoresolve stream", JSON.stringify(w.rng.autoresolve.snapshot()) !== auto0);
  check("and on no other", (["economy", "events", "kingdomAi", "weather"] as const).every((s, i) => JSON.stringify(w.rng[s].snapshot()) === others[i]));

  // Strictly worse in expectation, and never better on the same draws, over many fights of many shapes.
  const gen = Rng.create(0x5eed, Stream.Autoresolve);
  let n = 0;
  let dominated = true;
  let winsMine = 0;
  let winsEven = 0;
  let menMine = 0;
  let menEven = 0;
  for (let i = 0; i < 400; i++) {
    const shaped: BattleSpec = {
      ...spec,
      sides: [
        { ...spec.sides[0], morale: gen.int(101), squads: spec.sides[0].squads.map((q) => { const m = 1 + gen.int(UNIT_TYPES[q.unit].soldiers); return { ...q, men: m, wounded: gen.int(m) }; }) },
        { ...spec.sides[1], morale: gen.int(101), squads: spec.sides[1].squads.map((q) => { const m = 1 + gen.int(UNIT_TYPES[q.unit].soldiers); return { ...q, men: m, wounded: gen.int(m) }; }) },
      ],
      deployment: { attacker: gen.int(2), ambush: gen.chance(0.3) },
    };
    const seed = 1000 + i;
    const mine = autoResolve(shaped, Rng.create(seed, Stream.Autoresolve), true);
    const even = autoResolve(shaped, Rng.create(seed, Stream.Autoresolve), false);
    const mMine = mine.squads[0].reduce((s, q) => s + q.men - q.wounded, 0);
    const mEven = even.squads[0].reduce((s, q) => s + q.men - q.wounded, 0);
    if (mMine > mEven || (mine.winner === 0 && even.winner !== 0) || mine.morale[0] > even.morale[0]) dominated = false;
    if (mine.winner === 0) winsMine++;
    if (even.winner === 0) winsEven++;
    menMine += mMine;
    menEven += mEven;
    n++;
  }
  check("on the same draws, resolve-for-me is never better than the even-handed fight", dominated);
  check("and wins less often", winsMine < winsEven, winsMine + " vs " + winsEven + " of " + n);
  check("and brings fewer fit men home on average", menMine < menEven, (menMine / n).toFixed(2) + " vs " + (menEven / n).toFixed(2));
  const [p0, p1] = resolvePowers(spec, true);
  const [e0, e1] = resolvePowers(spec, false);
  check("the king's side counts for " + AUTORESOLVE.playerPower + " under a sergeant", Math.abs(p0 - e0 * AUTORESOLVE.playerPower) < 1e-9 && p1 === e1);
}

// -- 6. withdraw ----------------------------------------------------------------------------------

section("withdraw: a rearguard, some nerve, and a road back");
{
  const { w, a } = hostWorld(SEED, ["line", "line", "line", "slinger", "slinger"]);
  marchToContact(w, a, id(w, "harrowfield"));
  const c = w.contact!;
  const men0 = armyMen(a);
  const morale0 = a.morale;
  const rear = rearguardOf(a);
  check("the rearguard is " + WITHDRAW_REARGUARD_PERMILLE / 10 + "% of the army, at least one", rear === Math.max(1, Math.floor((men0 * WITHDRAW_REARGUARD_PERMILLE) / 1000)));
  const ev = issue(w, { kind: "resolveContact", contact: c.id, choice: "withdraw", result: null });
  check("withdrawing costs the rearguard", armyMen(a) === men0 - rear, men0 + " -> " + armyMen(a));
  check("and " + WITHDRAW_MORALE + " morale", a.morale === Math.max(0, morale0 - WITHDRAW_MORALE));
  const fell = ev.find((e) => e.kind === "fellBack");
  check("and it falls back, away from the enemy", !!fell && fell.kind === "fellBack" && fell.to === id(w, "rookstead") && a.mover.route.length > 0);
  check("the realm goes on", w.contact === null && ev.some((e) => e.kind === "contactResolved" && e.how === "withdraw"));
  const now = w.now;
  w.tick();
  check("and the clock moves again", w.now === now + 1);
}

section("withdraw: cut off");
{
  const { w, a } = hostWorld();
  // Block the road back: a second host at Rookstead, behind the king's army (test setup).
  w.issue({ kind: "marchArmy", army: a.id, to: id(w, "harrowfield") });
  // Out past the reach of Rookstead first, so the host raised there is behind it, not upon it.
  for (let i = 0; i < 6 * TICKS_PER_DAY && (a.mover.road === 0 || a.mover.along <= ENGAGE_RADIUS + 1); i++) w.tick();
  raiseArmy(w, BOAR, id(w, "rookstead"), ["line"]);
  for (let i = 0; i < 40 * TICKS_PER_DAY && !w.contact; i++) w.tick();
  const c = w.contact!;
  check("met on the road with an enemy behind", !!c && c.sides[1].faction === HARE && a.mover.road !== 0);
  check("there is no road back", retreatTarget(w, a, c.sides[1].army) === null);
  check("so it cannot withdraw, and says why",
    w.check({ kind: "resolveContact", contact: c.id, choice: "withdraw", result: null }) === DESCENT_REFUSAL.cutOff);
  const spec = buildBattleSpec(w, c);
  const lose = untouched(spec);
  const ev = issue(w, { kind: "resolveContact", contact: c.id, choice: "fight", result: { ...lose, winner: 1, fled: [true, false], legitimacy: -1 } });
  check("beaten and cut off, it is taken", !armyById(w, a.id) && ev.some((e) => e.kind === "armyGone" && e.reason === "captured"));
}

// -- 7. save --------------------------------------------------------------------------------------

section("save v5: a waiting contact survives, and the log replays");
{
  // By orders only, so the log alone rebuilds it: rally, claim, form a levy, march on the Hare.
  const w = new KingdomWorld({ seed: SEED, hosts: true });
  issue(w, { kind: "rally" });
  while (w.kingStocks.stocks.levy < 12 && w.king.task === "rally") w.tick();
  issue(w, { kind: "claimHolding", holding: id(w, "cold-hearth") });
  issue(w, { kind: "recruit", at: id(w, "cold-hearth"), army: 0, unit: "line", levy: true });
  const a = w.armies.find((x) => x.owner === KING)!;
  issue(w, { kind: "kingJoin", army: a.id });
  marchToContact(w, a, id(w, "harrowfield"), 80);
  check("the levy reaches the Hare (hungry, but there)", w.contact !== null && armyMen(a) > 0);
  const json = saveToJson(w);
  check("the save is version " + KINGDOM_SAVE_VERSION, JSON.parse(json).version === KINGDOM_SAVE_VERSION && KINGDOM_SAVE_VERSION >= 5 && JSON.parse(json).hosts === true);
  const l = loadFromJson(json);
  check("and loads with the contact waiting", l.ok && l.value.contact !== null && l.value.contact.id === w.contact!.id && kingdomHash(l.value) === kingdomHash(w),
    l.ok ? "" : l.error);
  const replay = replayLog(SEED, w.log, w.now, { hosts: true });
  check("the log replays to it, held on the same contact", kingdomHash(replay) === kingdomHash(w) && replay.contact !== null);
  if (l.ok) {
    const b = l.value;
    const cont = (x: KingdomWorld): string => {
      x.issue({ kind: "resolveContact", contact: x.contact!.id, choice: "auto", result: null });
      for (let i = 0; i < 3 * TICKS_PER_DAY; i++) x.tick();
      return kingdomHash(x);
    };
    check("settled after the load, as it would have been before it", cont(b) === cont(w));
    const r2 = replayLog(SEED, w.log, w.now, { hosts: true });
    check("and the log, resolveContact in it, replays to that too", kingdomHash(r2) === kingdomHash(w));
  }
  const bad = (f: (s: Record<string, any>) => void): boolean => { const s = JSON.parse(json); f(s); return !deserialize(s).ok; };
  check("a contact naming no army is refused", bad((s) => { s.snapshot.contact.sides[1].army = 99999; }));
  check("a contact between friends is refused", bad((s) => { s.snapshot.contact.sides[1].faction = KING; s.snapshot.contact.sides[1].army = 0; s.snapshot.contact.kind = "assault"; }));
  check("a contact not the king's is refused", bad((s) => { const t = s.snapshot.contact.sides[0]; s.snapshot.contact.sides[0] = s.snapshot.contact.sides[1]; s.snapshot.contact.sides[1] = t; }));
  check("a disengaged pair out of order is refused", bad((s) => { s.snapshot.disengaged = [[a.id, a.id]]; }));
  check("hosts must be said", bad((s) => { delete s.hosts; }));
  // Settled on the snapshot's own tick: the held tick ran, the clock did not.
  const y = new KingdomWorld({ seed: SEED, hosts: true });
  issue(y, { kind: "rally" });
  while (y.kingStocks.stocks.levy < 12 && y.king.task === "rally") y.tick();
  issue(y, { kind: "claimHolding", holding: id(y, "cold-hearth") });
  issue(y, { kind: "recruit", at: id(y, "cold-hearth"), army: 0, unit: "line", levy: true });
  const ya = y.armies.find((q) => q.owner === KING)!;
  marchToContact(y, ya, id(y, "harrowfield"), 80);
  const yNow = y.now;
  issue(y, { kind: "resolveContact", contact: y.contact!.id, choice: "withdraw", result: null });
  check("a settlement on the tick it was met leaves the clock where it was", y.now === yNow && y.contact === null);
  check("and the log replays to it", kingdomHash(replayLog(SEED, y.log, y.now, { hosts: true })) === kingdomHash(y));
}

section("migration v4 -> v5");
{
  const w = new KingdomWorld({ seed: SEED });
  for (let i = 0; i < 2 * TICKS_PER_DAY; i++) w.tick();
  const v4 = serialize(w) as unknown as Record<string, any>;
  v4.version = 4;
  delete v4.hosts;
  delete v4.snapshot.contact;
  delete v4.snapshot.disengaged;
  const m = migrate(JSON.parse(JSON.stringify(v4)));
  check("a version-4 save migrates to 5 and on to " + KINGDOM_SAVE_VERSION, m.ok && m.value.version === KINGDOM_SAVE_VERSION);
  check("no contact waits, nobody is disengaged, no hosts", m.ok && (m.value.snapshot as any).contact === null &&
    (m.value.snapshot as any).disengaged.length === 0 && m.value.hosts === false);
  const l = deserialize(JSON.parse(JSON.stringify(v4)));
  check("and loads as the same realm", l.ok && kingdomHash(l.value) === kingdomHash(w), l.ok ? "" : l.error);
}

// -- 8. THE PROOF ---------------------------------------------------------------------------------

section("THE PROOF: march -> contact -> battle -> survivors home");
{
  const run = (): { hashes: string[]; line: string } => {
    const { w, a } = hostWorld(0x6b1d0042, ["line", "line", "archer", "slinger"]);
    const hostId = w.armies[0].id;
    const took = marchToContact(w, a, id(w, "harrowfield"));
    const c = w.contact!;
    const at = contactPoint(w, c);
    const fought = fightOut(w);
    const before = layerHash(kingdomHash(w), fought.battleHash);
    issue(w, { kind: "resolveContact", contact: c.id, choice: "fight", result: fought.result });
    for (let i = 0; i < TICKS_PER_DAY; i++) w.tick();
    const after = layerHash(kingdomHash(w));
    const mine = men(armyById(w, a.id));
    const theirs = men(armyById(w, hostId));
    return {
      hashes: [hashBattleSpec(fought.spec), hashBattleResult(fought.result), before, after],
      line: "met after " + took + " ticks at (" + at.x.toFixed(0) + ", " + at.y.toFixed(0) + "); battle " + fought.ticks +
        " ticks, winner " + fought.result.winner + "; home: king's " + mine + ", Hare's " + theirs,
    };
  };
  const one = run();
  const two = run();
  console.log("        " + one.line);
  check("the same march, the same battle, the same survivors: every hash agrees", one.hashes.join() === two.hashes.join(), one.hashes.join(" "));
  check("the combined layer hash sees the battle while it is fought", one.hashes[2] !== one.hashes[3]);
}

console.log("\n" + (failures === 0 ? "all " + checks + " descent checks passed" : failures + " of " + checks + " descent check(s) FAILED"));
if (failures > 0) process.exitCode = 1;
