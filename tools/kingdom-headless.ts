/**
 * Headless harness for the kingdom layer (K1: the kingdom sim core).
 *
 * Same style and same purpose as tools/headless.ts, one layer up: run the
 * kingdom with no browser at all -- possible only because src/sim/kingdom/ is
 * pure -- and hold it to the claims PLAN.md §B.10 makes for it:
 *
 *   - the authored map is valid, and the validator is not dead;
 *   - ten simulated years from one seed are identical twice, and a different
 *     seed is a different decade;
 *   - that decade is anchored in its own golden tier (tools/kingdom-golden.json),
 *     kept apart from the battle's `world` and `stable` tiers so a kingdom
 *     change never moves a battle anchor and vice versa;
 *   - save -> load -> continue equals never having stopped, and a save's own
 *     order log replays to its snapshot;
 *   - orders arriving in a different order within a tick change nothing;
 *   - the king's march follows the roads, continuously, to where it was sent;
 *   - entity ids are monotonic.
 *
 * Regenerate the kingdom golden with UPDATE_KINGDOM_GOLDEN=1 and say why in
 * the commit message. It is EXPECTED to move when a kingdom phase changes what
 * a day does (K3 economy, K4 armies, ...); it must never move because a battle
 * phase changed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as M from "../src/sim/math.ts";
import { Rng, Stream } from "../src/sim/rng.ts";
import { hashRngStream } from "../src/sim/hash.ts";
import { generateTerrain, TERRAIN_INFO } from "../src/sim/terrain.ts";
import { layerHash, driftedLayer } from "../src/sim/layers.ts";
import {
  KingdomWorld, kingdomHash, calendar, isDayStart, KingdomOrderQueue, findRoute, moverAt,
  serialize, deserialize, saveToJson, loadFromJson, migrate, replayLog, mapFingerprint,
  TICKS_PER_DAY, DAYS_PER_SEASON, DAYS_PER_YEAR, TICKS_PER_YEAR, RETINUE_MILES_PER_DAY,
  KINGDOM_SAVE_VERSION, DEFAULT_KING_NAME,
  type KingdomOrder, type KingdomEvent,
} from "../src/sim/kingdom/index.ts";
import {
  RIMAROS, BIOMES, BIOME_IDS, FACTIONS, FACTION_IDS, ROAD_TERRAIN, WEATHER, HOLDING_KINDS,
  validateKingdomMap, holdingSeed, CAMPAIGN_HOLDINGS, KNOW_KNOWN, type KingdomMapDef,
} from "../src/content/kingdom/index.ts";
import { COMMANDERS, COMMANDER_IDS } from "../src/content/commanders.ts";
import { levelById } from "../src/content/levels/index.ts";
import {
  saveKingdom, loadKingdom, clearKingdom, exportKingdom, importKingdom,
  KINGDOM_SAVE_KEY, KINGDOM_SAVE_TEMP_KEY, type StorageLike,
} from "../src/app/kingdom-save.ts";
import { KingdomClock, MAX_TICKS_PER_FRAME, type KingdomSpeed } from "../src/app/kingdom-clock.ts";
import { KingdomCamera, OPENING_MILES, TABLE_MARGIN_MILES } from "../src/render/kingdom/camera.ts";
import { KING_COUNTER_OFFSET_PX, kingCounterAt } from "../src/render/kingdom/layout.ts";
import { interpretStroke, kingdomContext } from "../src/input/kingdom-commander.ts";
import { K, NONE_PLATE, NONE_REASON, WEATHER_LINE, dateLine, etaWords } from "../src/content/kingdom/ui-strings.ts";
import { buildKingdomCorpus } from "./gesture-corpus.ts";
import { KINGDOM_LABELS, printKingdomMatrix, runKingdomConfusionMatrix } from "./test-gestures.ts";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log("  PASS  " + name + (detail ? "  <- " + detail : ""));
  else {
    failures++;
    console.log("  FAIL  " + name + (detail ? "  <- " + detail : ""));
  }
}

function section(name: string): void {
  console.log("");
  console.log(name);
}

const SEED = 0x6b1d0001;
const OTHER_SEED = 0x6b1d0002;
const YEARS = 10;
const DECADE = YEARS * TICKS_PER_YEAR;

/**
 * A scripted decade of marching: every season the king sets out for a new
 * holding; one season in four he is halted partway, and one in four he is
 * turned round a few days out. Built from the test's OWN stream, never the
 * world's, so the script is identical for every seed and only the world's
 * weather differs between seeds. Stamped once, by one queue, exactly as a
 * recorded log would be.
 */
function decadeScript(world: KingdomWorld, years = YEARS): KingdomOrder[] {
  const pick = Rng.create(0x5c417, Stream.Events);
  const q = new KingdomOrderQueue();
  const out: KingdomOrder[] = [];
  const ids = world.holdings.map((h) => h.id);
  const seasons = years * 4;
  for (let s = 0; s < seasons; s++) {
    const t = s * DAYS_PER_SEASON * TICKS_PER_DAY + 3;
    out.push(q.stamp({ kind: "moveKing", to: ids[pick.int(ids.length)] }, 0, t));
    const twist = pick.int(4);
    const later = t + (2 + pick.int(6)) * TICKS_PER_DAY + pick.int(TICKS_PER_DAY);
    if (twist === 0) out.push(q.stamp({ kind: "haltKing" }, 0, later));
    if (twist === 1) out.push(q.stamp({ kind: "moveKing", to: ids[pick.int(ids.length)] }, 0, later));
  }
  return out;
}

/**
 * A world with the fog lifted and every site already found, for the tests
 * of the march itself (K1's): he may be sent anywhere by any road, and never
 * halts to read a letter. The fog and the sites have their own tests
 * (tools/kingdom-explore.ts).
 */
function explored(seed: number): KingdomWorld {
  const w = new KingdomWorld({ seed });
  for (const ex of w.explore) {
    ex.holdings.fill(KNOW_KNOWN);
    ex.roads.fill(KNOW_KNOWN);
  }
  for (const h of w.holdings) {
    if (w.map.holdings[h.id - 1].site !== undefined) w.explore[0].finds.push({ site: h.id, event: -1, day: 0, choice: -1, failed: false });
  }
  return w;
}

/** Where the king stands, exactly, as text. */
function placeOf(world: KingdomWorld): string {
  const m = world.king.mover;
  return m.node + "/" + m.road + "/" + m.along;
}

/**
 * Run to `until`, feeding each order at its own tick. Returns a hash per day;
 * `places`, if given, collects where the king stood each day.
 */
function runTo(world: KingdomWorld, script: readonly KingdomOrder[], until: number, places?: string[]): string[] {
  const trace: string[] = [];
  let i = 0;
  while (i < script.length && script[i].tick < world.now) i++;
  while (world.now < until) {
    const due: KingdomOrder[] = [];
    while (i < script.length && script[i].tick === world.now) due.push(script[i++]);
    world.tick(due);
    if (isDayStart(world.now)) {
      trace.push(kingdomHash(world));
      places?.push(placeOf(world));
    }
  }
  return trace;
}

// -- 1. content ----------------------------------------------------------------

section("content");
{
  const problems = validateKingdomMap(RIMAROS);
  check("the campaign map validates", problems.length === 0, problems.slice(0, 3).join("; "));
  check("72 holdings, twice K1's 36 (docs/PROVISIONAL.md B.12.2, K3a.1)", RIMAROS.holdings.length === CAMPAIGN_HOLDINGS && CAMPAIGN_HOLDINGS === 72,
    String(RIMAROS.holdings.length));

  const provinceNames = RIMAROS.provinces.map((p) => p.name);
  const a3 = ["Red March", "Lisle Bridges", "Hallow Ferry", "Long Wood", "Vale of the Hare",
    "Open Fields", "Stag Heights", "Wolf Moor", "Crow's Reach"];
  // K3a added three wild provinces to explore: the Grey Wold, the Iron Fells, the Saltings.
  check("the eight provinces of A.3, the Farthest Reach, the Crown Seat and K3a's three wilds",
    RIMAROS.provinces.length === 13 &&
    ["Grey Wold", "Iron Fells", "Saltings"].every((n) => provinceNames.some((p) => p.includes(n))) &&
    a3.every((n) => provinceNames.some((p) => p.includes(n))) &&
    provinceNames.some((p) => p.includes("Farthest Reach")) && provinceNames.some((p) => p.includes("Crown Seat")),
    provinceNames.join(", "));

  // Every captain governs exactly one province's seat, and a captain's
  // kingdom persona IS their battle commander's (same object, not a copy).
  const seats = RIMAROS.holdings.filter((h) => h.seat === true);
  const capOk = COMMANDER_IDS.every((c) => seats.filter((h) => h.owner === c).length === 1);
  check("each of the eight captains holds one seat", capOk);
  check("a captain's kingdom persona is their battle commander's",
    COMMANDER_IDS.every((c) => FACTIONS[c].persona?.bias === COMMANDERS[c].bias &&
      FACTIONS[c].persona?.boldness === COMMANDERS[c].boldness));
  const rimaros = RIMAROS.holdings.find((h) => h.key === RIMAROS.crownSeat);
  check("the usurper holds the Crown Seat", rimaros?.owner === "usurper" && rimaros.seat === true);
  // K3a: every settlement of the March is the Margrave's; the Margrave's
  // Folly, an abandoned fort, is a site to explore, held by nobody.
  check("the Margrave holds every settlement of the Red March",
    RIMAROS.holdings.filter((h) => h.province === "red-march" && h.site === undefined).every((h) => h.owner === "margrave") &&
    RIMAROS.holdings.filter((h) => h.province === "red-march" && h.site !== undefined).every((h) => h.owner === null));
  check("every faction has a persona except the human seat and (K8) the commons, who have no steward",
    FACTION_IDS.every((f) => (f === "king" || f === "commons") === (FACTIONS[f].persona === null)));
  check("the king is order player 0", FACTION_IDS[0] === "king");

  // From nothing (PLAN.md §A.5 amendment).
  check("the king owns nothing at the start", RIMAROS.holdings.every((h) => h.owner !== "king"));
  const reach = RIMAROS.holdings.filter((h) => h.province === "farthest-reach");
  check("the Farthest Reach is unclaimed", reach.length >= 3 && reach.every((h) => h.owner === null));
  const start = RIMAROS.holdings.find((h) => h.key === RIMAROS.start);
  check("the king starts in the Reach", start?.province === "farthest-reach" && start.owner === null);
  const near = new Set<string>([RIMAROS.start]);
  for (let hop = 0; hop < 2; hop++) {
    for (const [a, b] of RIMAROS.roads) {
      if (near.has(a)) near.add(b);
      else if (near.has(b)) near.add(a);
    }
  }
  const hamlets = RIMAROS.holdings.filter((h) => near.has(h.key) && h.key !== RIMAROS.start &&
    h.owner === null && h.kind === "hamlet");
  check("unclaimed hamlets within two roads of the start", hamlets.length >= 3, hamlets.map((h) => h.key).join(", "));
  check("an empty holding to claim first", reach.some((h) => h.kind !== "hamlet" && h.population === 0));

  check("every biome fights like an existing battlefield", BIOME_IDS.every((b) => levelById(BIOMES[b].level)));
  check("every road surface costs something positive", Object.values(ROAD_TERRAIN).every((r) => r.cost > 0));
  check("weather never speeds a march", Object.values(WEATHER).every((w) => w.travel >= 1));

  // A battle at a node generates its ground from the holding's seed with the
  // biome's level as template; the same node must always be the same field,
  // and it must be a field you can fight on.
  const t0 = performance.now();
  let worst = 1;
  let worstKey = "";
  let repeatable = true;
  const provinceBiome = new Map(RIMAROS.provinces.map((p) => [p.id, p.biome]));
  for (const h of RIMAROS.holdings) {
    const level = levelById(BIOMES[h.biome ?? provinceBiome.get(h.province)!].level)!;
    const seed = holdingSeed(h, level.seed);
    const g = generateTerrain(level.tilesWide, level.tilesHigh, seed);
    let passable = 0;
    for (let i = 0; i < g.type.length; i++) if (TERRAIN_INFO[g.type[i] as 0].moveScale > 0) passable++;
    const share = passable / g.type.length;
    if (share < worst) { worst = share; worstKey = h.key; }
    if (h === RIMAROS.holdings[0]) {
      const again = generateTerrain(level.tilesWide, level.tilesHigh, seed);
      repeatable = again.type.every((t, i) => t === g.type[i]);
    }
  }
  check("every holding's battlefield is mostly passable ground", worst > 0.8,
    "worst " + worstKey + " " + (worst * 100).toFixed(1) + "% in " + (performance.now() - t0).toFixed(0) + " ms");
  check("a holding's battlefield is the same every time", repeatable);

  // The validator must actually catch things, or the pass above means nothing.
  const broken = (edit: (m: { holdings: object[]; roads: (readonly [string, string, string])[] }) => void): number => {
    const m = JSON.parse(JSON.stringify(RIMAROS)) as KingdomMapDef & { holdings: object[]; roads: [string, string, string][] };
    edit(m);
    return validateKingdomMap(m).length;
  };
  check("validator catches a duplicate key", broken((m) => { m.holdings.push({ ...RIMAROS.holdings[0], x: 999, y: 699 }); }) > 0);
  check("validator catches a road to nowhere", broken((m) => { m.roads.push(["cold-hearth", "atlantis", "road"]); }) > 0);
  check("validator catches a self-loop", broken((m) => { m.roads.push(["lisle", "lisle", "road"]); }) > 0);
  check("validator catches a duplicate road", broken((m) => { m.roads.push(["greyshaw", "cold-hearth", "road"]); }) > 0);
  check("validator catches an island", broken((m) => {
    m.roads.splice(0, m.roads.length, ...m.roads.filter(([a, b]) => a !== "wrackhythe" && b !== "wrackhythe"));
  }) > 0);
  check("validator catches a king who starts with land", broken((m) => {
    (m.holdings[1] as { owner: string }).owner = "king";
  }) > 0);
  check("validator catches a holding off the map", broken((m) => { (m.holdings[3] as { x: number }).x = -5; }) > 0);
  check("validator catches an unknown road surface", broken((m) => { m.roads.push(["lisle", "fell-end", "teleporter"]); }) > 0);
  // K3a: readability and exploration.
  {
    const m = JSON.parse(JSON.stringify(RIMAROS)) as KingdomMapDef & { roads: [string, string, string][] };
    m.roads.push(["cold-hearth", "linnet-cross", "road"]);
    const p = validateKingdomMap(m);
    check("validator catches two roads that cross", p.some((x) => x.includes("crosses")), p.slice(0, 2).join("; "));
  }
  check("validator catches a site somebody holds", broken((m) => {
    (m.holdings.find((h) => (h as { site?: string }).site) as { owner: string }).owner = "wolf";
  }) > 0);
  check("validator catches a king who starts not knowing where he is", broken((m) => {
    (m as unknown as { startKnown: string[] }).startKnown = RIMAROS.startKnown.filter((k) => k !== RIMAROS.start);
  }) > 0);
}

// -- 2. rng streams ------------------------------------------------------------

section("rng streams");
{
  const kingdom = [Stream.Economy, Stream.Events, Stream.KingdomAi, Stream.Autoresolve, Stream.Weather];
  const all = Object.values(Stream);
  check("five kingdom streams, all distinct from each other and the battle's",
    new Set(all).size === all.length && kingdom.every((s) => typeof s === "number"));
  const heads = kingdom.map((s) => hashRngStream(Rng.create(SEED, s), 1000));
  check("each kingdom stream yields its own sequence", new Set(heads).size === kingdom.length);

  // The battle streams are pinned by the `stable` golden tier; recompute it
  // here the same way headless.ts does, so a kingdom edit to rng.ts that
  // moved them fails in this suite too, not only in that one.
  const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./golden.json", import.meta.url)), "utf8"));
  const stableRng = [Stream.Combat, Stream.Morale, Stream.Ai, Stream.Spawn]
    .map((st) => hashRngStream(Rng.create(0x5eed1234, st), 10000))
    .join("-");
  check("battle rng streams unchanged (stable tier)", golden.stable.rng === stableRng, stableRng);

  const w = new KingdomWorld({ seed: SEED });
  check("a kingdom world seeds every stream", Object.values(w.rng).every((r) => r instanceof Rng));
}

// -- 3. the clock --------------------------------------------------------------

section("clock");
{
  check("a day is a fixed number of kingdom ticks", calendar(TICKS_PER_DAY - 1).day === 0 && calendar(TICKS_PER_DAY).day === 1);
  check("a year is four seasons of thirty days", DAYS_PER_YEAR === 120 && TICKS_PER_YEAR === 120 * TICKS_PER_DAY);
  const d0 = calendar(0);
  check("the exile begins on the first day of autumn, year 1",
    d0.year === 1 && d0.season === "autumn" && d0.dayOfSeason === 0 && d0.tickOfDay === 0);
  const winter = calendar(DAYS_PER_SEASON * TICKS_PER_DAY);
  const spring = calendar(2 * DAYS_PER_SEASON * TICKS_PER_DAY);
  check("autumn, then winter, then spring of year 2",
    winter.season === "winter" && winter.year === 1 && spring.season === "spring" && spring.year === 2);
  let ordered = true;
  let prev = calendar(0);
  for (let t = 1; t < 3 * TICKS_PER_YEAR; t++) {
    const c = calendar(t);
    const back = (c.year - 1) * DAYS_PER_YEAR + c.dayOfYear - (prev.year - 1) * DAYS_PER_YEAR - prev.dayOfYear;
    if (c.day < prev.day || back < 0 || back > 1 || c.seasonIndex !== M.floor(c.dayOfYear / DAYS_PER_SEASON)) ordered = false;
    prev = c;
  }
  check("dates only ever run forwards, a day at a time", ordered);
  check("ten years is under ten thousand ticks", DECADE < 10000, String(DECADE));

  // The weather is rolled once a day, and winter brings snow.
  const w = new KingdomWorld({ seed: SEED });
  const bySeason = new Map<string, Set<string>>();
  let rolls = 0;
  for (let t = 0; t < TICKS_PER_YEAR * 2; t++) {
    // The season of the tick being run, read before tick() advances the clock.
    const s = w.date.season;
    const ev = w.tick();
    const day = ev.filter((e) => e.kind === "dayBegan");
    rolls += day.length;
    if (!bySeason.has(s)) bySeason.set(s, new Set());
    bySeason.get(s)!.add(w.weather);
  }
  check("one weather roll per day", rolls === DAYS_PER_YEAR * 2, String(rolls));
  check("snow falls in winter and only in winter",
    bySeason.get("winter")!.has("snow") && ["spring", "summer", "autumn"].every((s) => !bySeason.get(s)!.has("snow")));
}

// -- 4. ids --------------------------------------------------------------------

section("ids");
{
  const w = new KingdomWorld({ seed: SEED });
  const ids: number[] = [
    ...w.holdings.map((h) => h.id),
    ...w.roads.map((r) => r.id),
    ...w.holdings.flatMap((h) => h.plots.map((p) => p.id)),
    w.king.id,
  ];
  check("every entity id is unique", new Set(ids).size === ids.length);
  check("ids are handed out monotonically, in creation order", ids.every((id, i) => i === 0 || id > ids[i - 1]));
  check("ids start at 1, so 0 can mean none", Math.min(...ids) === 1);
  check("the counter is past every id issued", w.nextId === Math.max(...ids) + 1, String(w.nextId));
  check("holdings and roads are kept in id order",
    w.holdings.every((h, i) => i === 0 || h.id > w.holdings[i - 1].id) &&
    w.roads.every((r, i) => i === 0 || r.id > w.roads[i - 1].id));
  const again = new KingdomWorld({ seed: OTHER_SEED });
  check("the same map always gets the same ids, whatever the seed",
    again.holdings.every((h, i) => h.id === w.holdings[i].id) && again.king.id === w.king.id);
  check("each road joins its ends in ascending id", w.roads.every((r) => r.a < r.b));
  check("placeholders for later phases are empty",
    w.holdings.every((h) => h.garrison.length === 0 && h.buildings.every((b) => b === null) &&
      h.plots.every((p) => p.stage === "empty" && p.crop === null) &&
      h.buildings.length === HOLDING_KINDS[h.kind].buildingSlots &&
      h.garrisonSlots === HOLDING_KINDS[h.kind].garrisonSlots));
  check("the king has no holding, no army, no coin -- only Brother Aldous",
    w.holdingsOf("king").length === 0 && w.king.companions.join() === "Brother Aldous" &&
    w.king.name === DEFAULT_KING_NAME && w.king.mover.node === w.holdingByKey(RIMAROS.start)!.id);
}

// -- 5. the king's march -------------------------------------------------------

section("march");
{
  // An independent shortest-path oracle (Floyd-Warshall over the content
  // itself), so the router is checked against something that is not the router.
  const keys = RIMAROS.holdings.map((h) => h.key);
  const n = keys.length;
  const fw: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)));
  for (const [a, b, terrain] of RIMAROS.roads) {
    const i = keys.indexOf(a);
    const j = keys.indexOf(b);
    const ha = RIMAROS.holdings[i];
    const hb = RIMAROS.holdings[j];
    const c = Math.sqrt((ha.x - hb.x) ** 2 + (ha.y - hb.y) ** 2) * ROAD_TERRAIN[terrain].cost;
    fw[i][j] = Math.min(fw[i][j], c);
    fw[j][i] = Math.min(fw[j][i], c);
  }
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (fw[i][k] + fw[k][j] < fw[i][j]) fw[i][j] = fw[i][k] + fw[k][j];
  }

  const base = explored(SEED);
  let optimal = true;
  let worstGap = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const r = findRoute(base.graph, moverAt(base.holdings[i].id), base.holdings[j].id);
      if (!r) { optimal = false; continue; }
      const gap = Math.abs(r.effort - fw[i][j]);
      worstGap = Math.max(worstGap, gap);
      if (gap > 1e-6) optimal = false;
    }
  }
  check("the router finds the cheapest road route between every pair", optimal, "worst gap " + worstGap.toExponential(2));

  // March from the start to every holding in turn and watch every tick.
  const perTick = RETINUE_MILES_PER_DAY / TICKS_PER_DAY;
  const minCost = Math.min(...Object.values(ROAD_TERRAIN).map((r) => r.cost));
  const maxStep = perTick / minCost + 1e-9;
  let allArrived = true;
  let alongRoads = true;
  let continuous = true;
  let onSegment = true;
  let followedPlan = true;
  let etaHonest = true;
  let sawMidRoad = false;
  let worstJump = 0;
  const startId = base.holdingByKey(RIMAROS.start)!.id;
  for (const dest of base.holdings) {
    if (dest.id === startId) continue;
    const w = explored(SEED);
    const plan = w.planKingRoute(dest.id)!;
    w.issue({ kind: "moveKing", to: dest.id });
    const visited: number[] = [];
    let last = w.kingPosition();
    let ticks = 0;
    let arrived = false;
    while (ticks < 5000) {
      const ev = w.tick();
      ticks++;
      for (const e of ev) if (e.kind === "kingArrived") { visited.push(e.at); if (e.destination) arrived = true; }
      const m = w.king.mover;
      const p = w.kingPosition();
      const jump = Math.hypot(p.x - last.x, p.y - last.y);
      worstJump = Math.max(worstJump, jump);
      if (jump > maxStep) continuous = false;
      last = p;
      if (m.road !== 0) {
        sawMidRoad = true;
        const r = w.graph.roads.get(m.road)!;
        if (!((r.a === m.from && r.b === m.to) || (r.a === m.to && r.b === m.from))) alongRoads = false;
        const a = w.holding(m.from)!;
        const b = w.holding(m.to)!;
        const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
        if (Math.abs(cross) / r.length > 1e-6 || m.along < 0 || m.along > r.length) onSegment = false;
      }
      if (arrived) break;
    }
    if (!arrived || w.king.mover.node !== dest.id || w.king.mover.route.length !== 0) allArrived = false;
    if (visited.join() !== plan.route.nodes.join()) followedPlan = false;
    let prevNode = startId;
    for (const v of visited) {
      if (!w.graph.links.get(prevNode)!.some(([nb]) => nb === v)) alongRoads = false;
      prevNode = v;
    }
    // The ETA is quoted at today's weather; weather can only slow a march,
    // and never by more than the worst weather there is.
    const worstWeather = Math.max(...Object.values(WEATHER).map((x) => x.travel));
    const best = plan.route.effort / perTick;
    if (ticks + 1 < best || ticks > best * worstWeather + 2) etaHonest = false;
  }
  check("the king reaches every holding he is sent to", allArrived);
  check("he goes only by road, holding to holding", alongRoads);
  check("he takes the route the planner showed", followedPlan);
  check("progress along a road is continuous, not snapped to towns", sawMidRoad && onSegment);
  check("no tick moves him further than a tick's march", continuous,
    "worst " + worstJump.toFixed(3) + " of " + maxStep.toFixed(3) + " miles");
  check("travel time is the road's effort over his speed, slowed only by weather", etaHonest);

  // Rough country is slower than road: the same distance by a pass takes longer.
  {
    const w = explored(SEED);
    const fell = w.holdingByKey("fell-end")!;
    const lin = w.holdingByKey("linnet-cross")!;
    const r = findRoute(w.graph, moverAt(fell.id), lin.id)!;
    const direct = Math.hypot(fell.x - lin.x, fell.y - lin.y);
    check("a hill pass costs more than its miles", r.effort > direct * 1.5, r.effort.toFixed(1) + " for " + direct.toFixed(1) + " miles");
  }

  // Turned round mid-road: he reverses where he stands, no jump to either end.
  {
    const w = explored(SEED);
    const start = w.king.mover.node;
    const far = w.holdingByKey("harrowfield")!.id;
    w.issue({ kind: "moveKing", to: far });
    for (let i = 0; i < 20; i++) w.tick();
    const roadBefore = w.king.mover.road;
    const toBefore = w.king.mover.to;
    const before = w.kingPosition();
    w.issue({ kind: "moveKing", to: start });
    w.tick();
    const after = w.kingPosition();
    const m = w.king.mover;
    check("a march redirected mid-road turns round where he stands",
      roadBefore !== 0 && m.road === roadBefore && m.to !== toBefore &&
      Math.hypot(after.x - before.x, after.y - before.y) <= maxStep);
    let back = false;
    for (let i = 0; i < 2000 && !back; i++) back = w.tick().some((e) => e.kind === "kingArrived" && e.destination);
    check("and arrives back where he set out", back && w.king.mover.node === start);
  }

  // Halted mid-road: he stays exactly there.
  {
    const w = explored(SEED);
    w.issue({ kind: "moveKing", to: w.holdingByKey("rimaros")!.id });
    for (let i = 0; i < 13; i++) w.tick();
    w.issue({ kind: "haltKing" });
    w.tick();
    const p = w.kingPosition();
    const m = { ...w.king.mover };
    for (let i = 0; i < 200; i++) w.tick();
    const q = w.kingPosition();
    check("a halted king stands still halfway along a road",
      m.road !== 0 && w.king.mover.road === m.road && p.x === q.x && p.y === q.y && w.king.mover.route.length === 0);
    const resume = w.planKingRoute(w.holdingByKey("rimaros")!.id);
    check("and can march on from there", resume !== null && resume.route.nodes.length > 0);
  }

  // Orders the sim must refuse, identically on every machine.
  {
    const w = explored(SEED);
    const where = w.king.mover.node;
    w.issue({ kind: "moveKing", to: 99999 });
    const ev1 = w.tick();
    w.issue({ kind: "moveKing", to: w.holdingByKey("lisle")!.id }, 4);
    const ev2 = w.tick();
    const rejected = (ev: KingdomEvent[]) => ev.some((e) => e.kind === "orderRejected");
    check("a march to nowhere is refused", rejected(ev1) && w.king.mover.node === where && w.king.mover.route.length === 0);
    check("only the king's seat may move the king", rejected(ev2) && w.king.mover.route.length === 0);
    check("refused orders are still in the log, for replay", w.log.length === 2);
  }
}

// -- 6. determinism over a decade ------------------------------------------------

section("ten years");
let decadeHash = "";
{
  const t0 = performance.now();
  const a = new KingdomWorld({ seed: SEED });
  const script = decadeScript(a);
  const placesA: string[] = [];
  const traceA = runTo(a, script, DECADE, placesA);
  const ms = performance.now() - t0;
  const b = new KingdomWorld({ seed: SEED });
  const traceB = runTo(b, script, DECADE);
  const c = new KingdomWorld({ seed: OTHER_SEED });
  const placesC: string[] = [];
  const traceC = runTo(c, script, DECADE, placesC);
  check("the other seed's days differ from the first", traceC[traceC.length - 1] !== traceA[traceA.length - 1]);
  decadeHash = kingdomHash(a);

  check("the script exercises the march", script.length > 40 && a.log.length === script.length,
    script.length + " orders, " + a.log.length + " applied");
  check("ten years, one seed, twice: identical every day", traceA.join() === traceB.join(),
    traceA.length + " days");
  check("and identical at the end", kingdomHash(a) === kingdomHash(b), decadeHash);
  check("a different seed is a different decade", kingdomHash(c) !== decadeHash, kingdomHash(c));
  // Not merely a different rng state in the hash: the weather differs, so the
  // same orders put the king in different places on different days.
  let diverged = -1;
  let differing = 0;
  for (let i = 0; i < placesA.length; i++) {
    if (placesA[i] !== placesC[i]) { differing++; if (diverged < 0) diverged = i; }
  }
  check("the other seed's weather changed where the king was", diverged >= 0,
    "first on day " + diverged + ", " + differing + " of " + placesA.length + " days differ");
  check("the clock ends where ten years ends", a.now === DECADE && a.date.year === YEARS + 1 && a.date.season === "autumn");
  check("ten years run inside a frame budget", ms < 2000, ms.toFixed(0) + " ms");

  // Hash sensitivity: everything that matters must move it.
  const nudged = (f: (w: KingdomWorld) => void): boolean => {
    const w = new KingdomWorld({ seed: SEED });
    runTo(w, script, 500);
    const h0 = kingdomHash(w);
    f(w);
    return kingdomHash(w) !== h0;
  };
  check("hash sees a 1e-9 mile nudge along a road", nudged((w) => { w.king.mover.along += 1e-9; }));
  check("hash sees an owner change", nudged((w) => { w.holdings[5].owner = null; }));
  check("hash sees a population change", nudged((w) => { w.holdings[0].population += 1; }));
  check("hash sees the weather", nudged((w) => { w.weather = w.weather === "fog" ? "rain" : "fog"; }));
  check("hash sees a queued order", nudged((w) => { w.issue({ kind: "haltKing" }); }));
  check("hash sees an rng draw", nudged((w) => { w.rng.economy.nextU32(); }));
  check("hash sees a plot's stage", nudged((w) => { w.holdings[2].plots[0].stage = "sown"; }));
}

// -- 7. golden (kingdom tier) ------------------------------------------------------

section("golden (kingdom tier)");
{
  // Its own file and its own switch, so the battle tiers in golden.json are
  // never rewritten by a kingdom change, and UPDATE_GOLDEN never touches this.
  const path = fileURLToPath(new URL("./kingdom-golden.json", import.meta.url));
  type Golden = { kingdom: { seed: string; years: number; ticks: number; final: string } };
  let existing: Golden | null = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const live: Golden = { kingdom: { seed: "0x" + SEED.toString(16), years: YEARS, ticks: DECADE, final: decadeHash } };
  if (process.env.UPDATE_KINGDOM_GOLDEN || !existing) {
    writeFileSync(path, JSON.stringify(live, null, 2) + "\n");
    console.log("  kingdom golden written");
    existing = live;
  }
  if (existing) {
    check("kingdom decade matches golden",
      existing.kingdom.ticks === DECADE && existing.kingdom.seed === live.kingdom.seed && existing.kingdom.final === decadeHash,
      existing.kingdom.final === decadeHash ? decadeHash
        : "expected " + existing.kingdom.final + ", got " + decadeHash + " (UPDATE_KINGDOM_GOLDEN=1 if intended)");
  }
}

// -- 8. arrival order ------------------------------------------------------------

section("arrival order");
{
  // Three orders for one tick, from two players: the king's two marches (the
  // later seq wins) and a captain's (refused, but still logged).
  const proto = new KingdomWorld({ seed: SEED });
  const q = new KingdomOrderQueue();
  const T = 40;
  // Two places the king knows the way to on day one (K3a: the rest is fog).
  const lisle = proto.holdingByKey("greyshaw")!.id;
  const thorn = proto.holdingByKey("thornwick")!.id;
  const fell = proto.holdingByKey("fell-end")!.id;
  const o1 = q.stamp({ kind: "moveKing", to: lisle }, 0, T);
  const o2 = q.stamp({ kind: "moveKing", to: thorn }, 0, T);
  const o3 = q.stamp({ kind: "moveKing", to: fell }, 5, T);

  const runWith = (feed: (w: KingdomWorld) => void): string => {
    const w = new KingdomWorld({ seed: SEED });
    feed(w);
    while (w.now < 600) w.tick();
    return kingdomHash(w);
  };
  const atTick = (orders: KingdomOrder[]) => (w: KingdomWorld) => {
    while (w.now < T) w.tick();
    w.tick(orders);
  };
  const h123 = runWith(atTick([o1, o2, o3]));
  const h321 = runWith(atTick([o3, o2, o1]));
  const h213 = runWith(atTick([o2, o1, o3]));
  const early = runWith((w) => {
    w.submit(o3);
    while (w.now < 17) w.tick();
    w.submit(o2);
    while (w.now < T) w.tick();
    w.tick([o1]);
  });
  check("same orders, any arrival order within the tick: same kingdom", h123 === h321 && h321 === h213, h123);
  check("queued ahead or handed in on the tick: same kingdom", early === h123, early);

  // Not vacuous: actually reordering the orders (by seq) does change things.
  const q2 = new KingdomOrderQueue();
  const p1 = q2.stamp({ kind: "moveKing", to: thorn }, 0, T);
  const p2 = q2.stamp({ kind: "moveKing", to: lisle }, 0, T);
  check("swapping which order is applied last does change the kingdom", runWith(atTick([p1, p2, o3])) !== h123);

  // A late order is moved to the next boundary on entry, and the log records
  // it as applied, so replaying the log reproduces the live run.
  const late = new KingdomWorld({ seed: SEED });
  while (late.now < 50) late.tick();
  late.submit(q.stamp({ kind: "moveKing", to: lisle }, 0, 10));
  while (late.now < 400) late.tick();
  const replayed = replayLog(SEED, late.log, 400);
  check("an order that arrives late is applied at the next tick, and replays", late.log[0].tick === 50 &&
    kingdomHash(replayed) === kingdomHash(late));
}

// -- 9. save and load ----------------------------------------------------------------

section("save / load");
{
  const ref = new KingdomWorld({ seed: SEED });
  const script = decadeScript(ref);
  const refTrace = runTo(ref, script, DECADE);
  const refHash = kingdomHash(ref);

  // Interrupt the decade at several points -- mid-road, mid-day, with orders
  // queued for later -- save to JSON, load, and carry on.
  const cuts = [1, 333, 2401, 4800 + 5, 7777, DECADE - 1];
  let allEqual = true;
  let sawMidRoad = false;
  let sawPending = false;
  let worstCut = "";
  for (const cut of cuts) {
    const w = new KingdomWorld({ seed: SEED });
    runTo(w, script, cut);
    // Queue something for the future so the snapshot carries pending orders.
    w.submit({ kind: "haltKing", tick: cut + 3 * TICKS_PER_DAY, player: 0, seq: 100000 + cut });
    if (w.king.mover.road !== 0) sawMidRoad = true;
    if (w.orders.size > 0) sawPending = true;
    const json = saveToJson(w);
    const loaded = loadFromJson(json);
    if (!loaded.ok) { allEqual = false; worstCut = cut + ": " + loaded.error; continue; }
    const l = loaded.value;
    if (kingdomHash(l) !== kingdomHash(w)) { allEqual = false; worstCut = cut + ": hash on load"; continue; }
    const restW = runTo(w, script, DECADE);
    const restL = runTo(l, script, DECADE);
    if (restW.join() !== restL.join() || kingdomHash(w) !== kingdomHash(l)) {
      allEqual = false;
      worstCut = cut + ": diverged after load";
    }
  }
  check("save -> load -> continue equals never having stopped, at every cut", allEqual, worstCut || cuts.join(", "));
  check("the cuts include a king halfway along a road", sawMidRoad);
  check("the cuts include orders queued for later", sawPending);

  // The plain cut (no extra order) must land exactly on the reference decade.
  {
    const w = new KingdomWorld({ seed: SEED });
    runTo(w, script, 2401);
    const l = loadFromJson(saveToJson(w));
    if (l.ok) runTo(l.value, script, DECADE);
    check("a save mid-decade resumes to the uninterrupted decade's hash", l.ok && kingdomHash(l.value) === refHash);
  }

  // A save's own log, replayed from day one, reproduces its snapshot.
  {
    const w = new KingdomWorld({ seed: SEED });
    runTo(w, script, 5000);
    w.submit({ kind: "moveKing", to: 3, tick: 5100, player: 0, seq: 999999 });
    const save = serialize(w);
    const replay = replayLog(save.seed, [...save.log, ...save.snapshot.pending], save.snapshot.now);
    check("a save's order log replays to its own snapshot", kingdomHash(replay) === kingdomHash(w));
  }

  check("a save is plain JSON, round-trips through text unchanged",
    JSON.stringify(JSON.parse(saveToJson(ref))) === saveToJson(ref));
  check("the decade survives a save of its final state", (() => {
    const l = loadFromJson(saveToJson(ref));
    return l.ok && kingdomHash(l.value) === refHash && refTrace.length === DECADE / TICKS_PER_DAY;
  })());
  const named = new KingdomWorld({ seed: SEED, kingName: "Edmund the Patient" });
  const nl = loadFromJson(saveToJson(named));
  check("the king's chosen name is saved", nl.ok && nl.value.king.name === "Edmund the Patient");

  // Refusals: every one a reason, never a throw, never a half-loaded world.
  const good = serialize(new KingdomWorld({ seed: SEED }));
  const tamper = (f: (s: any) => void): boolean => {
    const s = JSON.parse(JSON.stringify(good));
    f(s);
    const r = deserialize(s);
    return !r.ok && typeof r.error === "string" && r.error.length > 0;
  };
  check("refuses a save from a newer game", tamper((s) => { s.version = KINGDOM_SAVE_VERSION + 1; }));
  check("refuses a save with no version", tamper((s) => { delete s.version; }));
  check("refuses something that is not a kingdom save", tamper((s) => { s.format = "war.chronicle"; }));
  check("refuses a save made on a different map", tamper((s) => { s.mapFingerprint = "00000000"; }));
  check("refuses a holding that does not match the map", tamper((s) => { s.snapshot.holdings[3].key = "elsewhere"; }));
  check("refuses an unknown owner", tamper((s) => { s.snapshot.holdings[3].owner = "pirates"; }));
  check("refuses a king off the end of his road", tamper((s) => {
    s.snapshot.king.mover = { node: 0, road: 37, from: 1, to: 2, along: 1e6, route: [] };
  }));
  check("refuses a king on a road between towns it does not join", tamper((s) => {
    s.snapshot.king.mover = { node: 0, road: 37, from: 1, to: 30, along: 0, route: [] };
  }));
  check("refuses a route with no road", tamper((s) => { s.snapshot.king.mover.route = [36]; }));
  check("refuses a number that is not finite", tamper((s) => { s.snapshot.holdings[0].population = null; }));
  check("refuses an unknown order", tamper((s) => { s.log.push({ kind: "conjure", tick: 0, player: 0, seq: 1 }); }));
  check("refuses an unknown weather", tamper((s) => { s.snapshot.weather = "frogs"; }));
  check("refuses rubbish", !loadFromJson("{not json").ok && !deserialize(null).ok && !deserialize([]).ok &&
    !deserialize("war").ok && !loadFromJson("").ok);
  check("a refused load leaves no world behind", (() => {
    const r = deserialize({ ...good, snapshot: { ...good.snapshot, king: null } });
    return !r.ok;
  })());

  // The migration machinery itself, with a stand-in table (K3 added the
  // first real step, 1 -> 2; tools/kingdom-economy.ts tests that one).
  const fake = {
    1: (s: Record<string, unknown>) => ({ ...s, version: 2, stockpiles: { coin: 0 } }),
    2: (s: Record<string, unknown>) => ({ ...s, version: 3 }),
  };
  const v1 = (): Record<string, unknown> => ({ ...JSON.parse(JSON.stringify(good)), version: 1 });
  const m = migrate(v1(), fake, 3);
  check("migrate steps a save up one version at a time",
    m.ok && m.value.version === 3 && (m.value.stockpiles as { coin: number }).coin === 0);
  check("migrate refuses a gap in the table", !migrate(v1(), { 1: fake[1] }, 3).ok);
  check("migrate refuses a step that does not advance", !migrate(v1(),
    { 1: (s: Record<string, unknown>) => s }, 2).ok);
  check("a current save needs no migration", migrate(JSON.parse(JSON.stringify(good))).ok);
  check("the save names its map and fingerprint", good.map === "rimaros" &&
    good.mapFingerprint === mapFingerprint(new KingdomWorld({ seed: 1 })));
}

// -- 10. browser storage wrapper (src/app/kingdom-save.ts) ------------------------

section("storage");
{
  /** A localStorage stand-in that can be told to misbehave. */
  class FakeStorage implements StorageLike {
    data = new Map<string, string>();
    failSetOn = -1;
    sets = 0;
    failGet = false;
    getItem(k: string): string | null {
      if (this.failGet) throw new Error("SecurityError: blocked");
      return this.data.get(k) ?? null;
    }
    setItem(k: string, v: string): void {
      this.sets++;
      if (this.failSetOn === this.sets) {
        const e = new Error("the quota has been exceeded");
        e.name = "QuotaExceededError";
        throw e;
      }
      this.data.set(k, v);
    }
    removeItem(k: string): void { this.data.delete(k); }
  }

  const w = new KingdomWorld({ seed: SEED });
  runTo(w, decadeScript(w), 1234);
  const h = kingdomHash(w);

  const s = new FakeStorage();
  const empty = loadKingdom(s);
  check("an empty store is a new game, not an error", empty.ok && empty.world === null);
  const saved = saveKingdom(w, s);
  check("a save writes the kingdom key and clears the temp key",
    saved.ok && s.data.has(KINGDOM_SAVE_KEY) && !s.data.has(KINGDOM_SAVE_TEMP_KEY), KINGDOM_SAVE_KEY);
  const back = loadKingdom(s);
  check("and loads back to the same kingdom", back.ok && back.world !== null && kingdomHash(back.world) === h && !back.recovered);

  // A crash between writing the temp copy and swapping it in.
  const older = new KingdomWorld({ seed: SEED });
  const crash = new FakeStorage();
  crash.data.set(KINGDOM_SAVE_KEY, saveToJson(older));
  crash.data.set(KINGDOM_SAVE_TEMP_KEY, saveToJson(w));
  const rec = loadKingdom(crash);
  check("an interrupted swap is recovered from the temp key",
    rec.ok && rec.world !== null && kingdomHash(rec.world) === h && rec.recovered);
  check("and the swap is completed", crash.data.get(KINGDOM_SAVE_KEY) === saveToJson(w) && !crash.data.has(KINGDOM_SAVE_TEMP_KEY));

  // A crash halfway through writing the temp copy: the old save stands.
  const torn = new FakeStorage();
  torn.data.set(KINGDOM_SAVE_KEY, saveToJson(older));
  torn.data.set(KINGDOM_SAVE_TEMP_KEY, saveToJson(w).slice(0, 200));
  const tr = loadKingdom(torn);
  check("a torn temp copy falls back to the last good save",
    tr.ok && tr.world !== null && kingdomHash(tr.world) === kingdomHash(older) && !tr.recovered);

  // Refusals come back as values.
  const full = new FakeStorage();
  full.data.set(KINGDOM_SAVE_KEY, saveToJson(older));
  full.failSetOn = 1;
  const q1 = saveKingdom(w, full);
  check("a full store refuses the save as a result, not a throw",
    !q1.ok && q1.reason === "refused" && q1.detail.includes("QuotaExceeded"));
  check("and the previous save is untouched", full.data.get(KINGDOM_SAVE_KEY) === saveToJson(older) &&
    !full.data.has(KINGDOM_SAVE_TEMP_KEY));
  const half = new FakeStorage();
  half.failSetOn = 2;
  const q2 = saveKingdom(w, half);
  const q2load = loadKingdom(half);
  check("a refusal at the swap still keeps the verified copy for next load",
    !q2.ok && q2.reason === "refused" && q2load.ok && q2load.world !== null && kingdomHash(q2load.world) === h);
  const none = saveKingdom(w, null);
  const noneLoad = loadKingdom(null);
  check("no storage at all is reported, not thrown", !none.ok && none.reason === "unavailable" &&
    !noneLoad.ok && noneLoad.reason === "unavailable");
  const blocked = new FakeStorage();
  blocked.failGet = true;
  const bl = loadKingdom(blocked);
  check("storage that refuses to be read is reported", !bl.ok && bl.reason === "refused");
  const corrupt = new FakeStorage();
  corrupt.data.set(KINGDOM_SAVE_KEY, "{\"format\":\"war.kingdom\",\"version\":1");
  const cr = loadKingdom(corrupt);
  check("a corrupt save is reported as corrupt", !cr.ok && cr.reason === "corrupt");
  const cl = clearKingdom(s);
  check("clearing removes every copy", cl.ok && s.data.size === 0);

  const text = exportKingdom(w);
  const imp = importKingdom(text);
  check("export / import round-trips as a JSON string", typeof text === "string" && imp.ok && imp.world !== null &&
    kingdomHash(imp.world) === h);
  const bad = importKingdom("hello");
  check("importing a bad file is a corrupt result", !bad.ok && bad.reason === "corrupt");
}

// -- 11. layer hash ------------------------------------------------------------

section("layer hash");
{
  const k = kingdomHash(new KingdomWorld({ seed: SEED }));
  const k2 = kingdomHash(new KingdomWorld({ seed: OTHER_SEED }));
  const b = "0badf00d";
  check("layer hash is deterministic", layerHash(k, b) === layerHash(k, b) && layerHash(k) === layerHash(k));
  check("a battle in progress changes the layer hash", layerHash(k) !== layerHash(k, b));
  check("so does the kingdom under it", layerHash(k, b) !== layerHash(k2, b));
  check("and so does the battle", layerHash(k, b) !== layerHash(k, "0badf00e"));
  check("no battle is not the same as a battle hashing to zero", layerHash(k) !== layerHash(k, "00000000"));
  check("the drifted layer is named",
    driftedLayer({ kingdom: k }, { kingdom: k }) === "none" &&
    driftedLayer({ kingdom: k, battle: b }, { kingdom: k2, battle: b }) === "kingdom" &&
    driftedLayer({ kingdom: k, battle: b }, { kingdom: k, battle: "12345678" }) === "battle" &&
    driftedLayer({ kingdom: k, battle: b }, { kingdom: k2 }) === "both");
  let threw = false;
  try { layerHash("nope"); } catch { threw = true; }
  check("a malformed part is a loud error, not a quiet collision", threw);
}

// -- 12. the kingdom map (K2) ---------------------------------------------------
//
// What K2 adds that can be held without a browser: the kingdom pen's own
// confusion matrix, the single preview/commit function, the real-time clock's
// rates, the camera's zoom bounds, and the strings the map shows.

section("K2 kingdom pen: confusion matrix");
{
  const report = runKingdomConfusionMatrix();
  printKingdomMatrix(report);
  console.log("");
  check("the kingdom confusion matrix is diagonal", report.correct === report.total,
    report.correct + "/" + report.total + (report.offDiagonal.length
      ? "; first miss: " + report.offDiagonal[0].note + " -> " + report.offDiagonal[0].actual : ""));
  const kinds = new Set([...report.matrix.entries()].filter(([, row]) => row.size > 0).map(([k]) => k));
  check("every kingdom label has cases", kinds.size === KINGDOM_LABELS.length, [...kinds].join(", "));
}

section("K2 kingdom pen: one function for preview and commit");
{
  const corpus = buildKingdomCorpus();
  let marches = 0;
  let same = 0;
  let planned = 0;
  let prefixesOk = true;
  let untouched = true;
  for (const c of corpus) {
    // The army scene's cases are held to the same rule in tools/kingdom-armies.ts.
    if (!c.expected.startsWith("march:") || c.armies) continue;
    marches++;
    // The corpus contexts were built from fresh worlds of seed 7; rebuild the
    // world each case belongs to, so the plan is asked of the same state.
    const w = new KingdomWorld({ seed: 7 });
    if (c.note.includes("on the road")) {
      const g = w.holdings.find((h) => h.name === "Greyshaw");
      if (g) w.issue({ kind: "moveKing", to: g.id });
      for (let i = 0; i < 12; i++) w.tick();
    }
    const before = kingdomHash(w);
    const king = w.kingPosition();
    // Preview: every sample as the pen sees it; the last preview is what the player saw on release.
    let preview = null as ReturnType<typeof interpretStroke> | null;
    for (let n = 1; n <= c.points.length; n++) {
      try { preview = interpretStroke(c.points.slice(0, n), c.ctx, w, king); } catch { prefixesOk = false; }
    }
    const commit = interpretStroke(c.points, c.ctx, w, king);
    if (preview && JSON.stringify(preview) === JSON.stringify(commit)) same++;
    if (commit.order && commit.order.kind === "moveKing" && commit.ghost.kind === "march") {
      const plan = w.planKingRoute(commit.order.to);
      const ghostEnd = commit.ghost.route[commit.ghost.route.length - 1];
      const dest = w.holding(commit.order.to);
      if (plan && dest && ghostEnd.x === dest.x && ghostEnd.y === dest.y &&
        commit.ghost.route.length === plan.route.nodes.length + 1 &&
        commit.march?.etaTicks === plan.etaTicks) planned++;
    }
    if (kingdomHash(w) !== before) untouched = false;
  }
  check("every march case was interpreted", marches > 0, marches + " march strokes");
  check("the last preview equals the commit, every time", same === marches, same + "/" + marches);
  check("the ghost's route and ETA are the sim's own plan", planned === marches, planned + "/" + marches);
  check("interpreting a stroke at every sample never throws", prefixesOk);
  check("interpreting never writes the world (hash unchanged)", untouched);

  // And release really issues that order: issue it, tick, and the mover has the route.
  const w = new KingdomWorld({ seed: 7 });
  const c = corpus.find((x) => x.expected === "march:Thornwick" && x.note.includes("standing"));
  if (c) {
    const intent = interpretStroke(c.points, kingdomContext(w, w.kingPosition(), c.ctx.pxToWorld), w, w.kingPosition());
    if (intent.order) w.issue(intent.order);
    w.tick();
    const r = w.king.mover.route;
    const th = w.holdings.find((h) => h.name === "Thornwick");
    check("the committed order sets the king's route on the next tick", !!th && r[r.length - 1] === th.id, r.join(","));
  } else check("the committed order sets the king's route on the next tick", false, "no Thornwick case");
}

section("K2 real-time clock");
{
  const run = (speed: KingdomSpeed, hz: number, seconds: number, paused = false, held = false): number => {
    const c = new KingdomClock();
    c.setSpeed(speed);
    if (paused) c.togglePause();
    let ticks = 0;
    const frames = Math.round(seconds * hz);
    for (let i = 0; i < frames; i++) ticks += c.advance(1 / hz, held);
    return ticks;
  };
  check("1x: one day every two seconds", run(1, 60, 2) === TICKS_PER_DAY, run(1, 60, 2) + " ticks in 2 s");
  check("2x: two days every two seconds", run(2, 60, 2) === 2 * TICKS_PER_DAY, String(run(2, 60, 2)));
  check("4x: four days every two seconds", run(4, 60, 2) === 4 * TICKS_PER_DAY, String(run(4, 60, 2)));
  check("the rate does not depend on the frame rate",
    run(1, 30, 10) === run(1, 144, 10) && run(4, 30, 10) === run(4, 144, 10),
    run(1, 30, 10) + "/" + run(1, 144, 10) + ", " + run(4, 30, 10) + "/" + run(4, 144, 10));
  check("paused: no ticks", run(4, 60, 5, true) === 0);
  check("held by a screen (a confirm): no ticks", run(4, 60, 5, false, true) === 0);
  const c = new KingdomClock();
  check("'.' steps nothing while running", c.stepDay() === 0);
  c.togglePause();
  check("'.' steps one day (eight ticks) while paused", c.stepDay() === TICKS_PER_DAY);
  c.setSpeed(2);
  check("choosing a speed also resumes", c.run === "running" && c.speed === 2);
  const slept = new KingdomClock();
  check("a tab that slept an hour does not run a season in one frame", slept.advance(3600, false) <= MAX_TICKS_PER_FRAME);
}

section("K2 kingdom camera");
{
  const cam = new KingdomCamera(RIMAROS.width, RIMAROS.height);
  cam.setViewport(1280, 720);
  cam.cut(500, 350, cam.minZoom);
  const b = cam.bounds();
  check("at the widest zoom the whole realm is in view",
    b.x0 <= 0 && b.y0 <= 0 && b.x1 >= RIMAROS.width && b.y1 >= RIMAROS.height,
    [b.x0, b.y0, b.x1, b.y1].map((v) => v.toFixed(0)).join(","));
  check("the closest zoom is at least three times the widest", cam.maxZoom >= cam.minZoom * 3,
    cam.minZoom.toFixed(3) + " .. " + cam.maxZoom.toFixed(3) + " px/mile");
  cam.cut(300, 300, cam.zoomForSpan(OPENING_MILES));
  const wx = cam.screenToWorldX(400);
  const wy = cam.screenToWorldY(250);
  cam.zoomAt(400, 250, 1.5);
  check("wheel zoom keeps the point under the cursor",
    Math.abs(cam.screenToWorldX(400) - wx) < 1e-6 && Math.abs(cam.screenToWorldY(250) - wy) < 1e-6);
  cam.zoomAt(400, 250, 1e6);
  check("zoom stops at the closest bound", cam.zoom === cam.maxZoom);
  cam.zoomAt(400, 250, 1e-6);
  check("and at the widest", cam.zoom === cam.minZoom);
  cam.cut(-5000, -5000, cam.maxZoom);
  const c2 = cam.bounds();
  check("panning cannot leave the table", c2.x0 >= -TABLE_MARGIN_MILES - 1e-6 && c2.y0 >= -TABLE_MARGIN_MILES - 1e-6);
  const small = new KingdomCamera(RIMAROS.width, RIMAROS.height);
  small.setViewport(500, 600);
  check("a small window still has sane bounds", small.minZoom > 0 && small.maxZoom > small.minZoom);
  const flying = new KingdomCamera(RIMAROS.width, RIMAROS.height);
  flying.setViewport(1280, 720);
  flying.cut(100, 100, flying.zoomForSpan(OPENING_MILES));
  flying.flyTo(400, 300, flying.zoom, 0.5);
  for (let i = 0; i < 40; i++) flying.update(1 / 60);
  check("F's flight lands where it was sent", Math.abs(flying.x - 400) < 1e-6 && Math.abs(flying.y - 300) < 1e-6 && !flying.flying);
  for (const z of [cam.minZoom, cam.maxZoom]) {
    const at = kingCounterAt({ x: 100, y: 70 }, 1 / z);
    check("the king's counter is drawn 30 px above him at " + z.toFixed(2) + " px/mile",
      Math.abs((70 - at.y) * z - KING_COUNTER_OFFSET_PX) < 1e-9);
  }
}

section("K2 strings");
{
  // The king is never given a pronoun the player did not choose (A.7.3: the
  // king is named at the start). Every string the map can show is checked.
  const sample = {
    name: "Greyshaw", eta: "about 2 days", from: "Cold Hearth", to: "Greyshaw", surface: "cart track", miles: 4,
    garrison: 1, buildings: 2, fields: 3, kind: "Village", owner: "unclaimed",
  };
  const all: string[] = [...Object.values(NONE_REASON), ...Object.values(NONE_PLATE), ...Object.values(WEATHER_LINE)];
  for (const v of Object.values(K)) {
    if (typeof v === "string") all.push(v);
    else if (Array.isArray(v)) all.push(...v);
    else if (typeof v === "function") all.push(String((v as (a: unknown) => string)(sample)), String((v as (a: unknown) => string)("x")));
  }
  const gendered = all.filter((s) => /\b(he|him|his|she|her|hers|himself|herself)\b/i.test(s));
  check("no map string genders the king", gendered.length === 0, gendered.slice(0, 2).join(" | "));
  check("ETA in hours under a day", etaWords(3, TICKS_PER_DAY) === "about 9 hours", etaWords(3, TICKS_PER_DAY));
  check("ETA in half days beyond", etaWords(36, TICKS_PER_DAY) === "about 4½ days", etaWords(36, TICKS_PER_DAY));
  check("ETA of one day", etaWords(8, TICKS_PER_DAY) === "about 1 day", etaWords(8, TICKS_PER_DAY));
  const d = calendar(0);
  check("the date line counts days from 1", dateLine(d).startsWith("Day 1 · "), dateLine(d));
}

// -- summary ---------------------------------------------------------------------

console.log("");
console.log("  seed          0x" + SEED.toString(16));
console.log("  decade        " + DECADE + " kingdom ticks (" + YEARS + " years)");
console.log("  kingdom hash  " + decadeHash);
console.log("");
console.log(failures === 0 ? "all kingdom checks passed" : failures + " kingdom check(s) FAILED");
console.log("");
process.exit(failures === 0 ? 0 : 1);
