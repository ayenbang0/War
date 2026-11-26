/**
 * Destructible terrain checks (PLAN Part D, Phase 8).
 *
 * Every claim Phase 8 makes about ground that changes under men's feet, run
 * headless: walls wear and fall, a breach re-routes an assault, a breach or a
 * burnt wood changes what can be seen, fire spreads and burns out the same way
 * every time, a broken bridge stops a crossing, and -- the invariant the whole
 * phase is built around -- no man ever ends a tick on water or inside a wall.
 *
 * One small battlefield is used throughout: seed 52 at 120x80, with a stone
 * circuit round (16, 40) and its one gate on the east side where the road
 * comes in. Picked by printing candidate seeds: the ring's interior is open
 * ground and hill, the road runs straight through the gate, a single isolated
 * wood (x 30-42, y 32-38) stands just outside it, and the river to the east
 * has three bridges, the middle one (x 70-75, y 39-41) on the same road.
 */

import { World, TICK_RATE } from "../src/sim/world.ts";
import type { Group } from "../src/sim/entities.ts";
import { hashWorld } from "../src/sim/hash.ts";
import { Terrain, TERRAIN_INFO, TILE_SIZE, STRUCTURE, TerrainGrid, generateTerrain } from "../src/sim/terrain.ts";
import { findPath, findPathPartial } from "../src/sim/pathfind.ts";
import { hasLineOfSight, parapetCover, PARAPET_REACH } from "../src/sim/vision.ts";
import { stepFire, FIRE_INTERVAL } from "../src/sim/fire.ts";
import { insideSiege, type SiegeWorks } from "../src/sim/siege.ts";
import { UNIT_TYPES, type UnitTypeId } from "../src/content/unit-types.ts";
import { LEVELS } from "../src/content/levels/index.ts";
import { enemyArmy } from "../src/app/battle-config.ts";
import { defaultArmy } from "../src/content/army.ts";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
let current = "";
function section(name: string): void {
  current = name;
  console.log("\n" + name);
}
function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name: current + ": " + name, ok, detail });
  console.log("  " + (ok ? "PASS  " : "FAIL  ") + name + (detail ? "  <- " + detail : ""));
}

const T = TILE_SIZE;
const SEED = 52;
const RING: SiegeWorks = {
  defender: 0, cx: 16, cy: 40, rx: 9, ry: 9, kind: "wall", gates: [{ side: "east" }],
};
/** The east wall line, and the gate's three tiles on it. */
const EAST = RING.cx + RING.rx;
const GATE_ROWS = [39, 40, 41];

/**
 * The test field. A rout or an empty side ends a match on the spot (victory.ts),
 * and a world that has ended stops stepping -- so unless a test brings both
 * armies itself, each side gets one idle company far off in a corner to keep
 * the battle open while the test watches the ground.
 */
function siegeWorld(extra: Partial<ConstructorParameters<typeof World>[0]> = {}, sentinels = true): World {
  const w = new World({
    seed: SEED, tilesWide: 120, tilesHigh: 80, soldierCapacity: 1024, duration: 30 * 60,
    siege: RING, ...extra,
  });
  if (sentinels) {
    const a = w.standingGround(114.5 * T, 74.5 * T);
    const b = w.standingGround(114.5 * T, 6.5 * T);
    company(w, 0, "line", Math.floor(a.x / T), Math.floor(a.y / T));
    company(w, 1, "line", Math.floor(b.x / T), Math.floor(b.y / T));
  }
  return w;
}

/** A company set out in a block centred on a tile. */
function company(w: World, player: number, type: UnitTypeId, tx: number, ty: number): Group {
  const ids: number[] = [];
  const n = UNIT_TYPES[type].soldiers;
  for (let k = 0; k < n; k++) {
    ids.push(w.spawnSoldier(player, type, (tx + 0.5) * T + ((k % 5) - 2) * 9,
      (ty + 0.5) * T + (((k / 5) | 0) - 1) * 9, player === 0 ? 0 : Math.PI));
  }
  const g = w.createGroup(player, ids);
  if (!g) throw new Error("could not form a company");
  return g;
}

/** Alive soldiers standing on ground nobody can stand on (water, wall, gate). */
function stranded(w: World): number[] {
  const s = w.soldiers;
  const out: number[] = [];
  for (let i = 0; i < s.count; i++) {
    if (s.alive[i] !== 1) continue;
    if (!w.terrain.passableAt(Math.floor(s.x[i] / T), Math.floor(s.y[i] / T))) out.push(i);
  }
  return out;
}

function tileOf(t: TerrainGrid, tx: number, ty: number): number {
  return ty * t.width + tx;
}

/** Every tile a route passes over, sampled at quarter-tile steps. */
function routeTiles(t: TerrainGrid, fromX: number, fromY: number, route: readonly number[]): Set<number> {
  const out = new Set<number>();
  let px = fromX;
  let py = fromY;
  for (let k = 0; k + 1 < route.length; k += 2) {
    const qx = route[k];
    const qy = route[k + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(qx - px, qy - py) / (T * 0.25)));
    for (let j = 0; j <= n; j++) {
      const x = px + ((qx - px) * j) / n;
      const y = py + ((qy - py) * j) / n;
      out.add(tileOf(t, Math.floor(x / T), Math.floor(y / T)));
    }
    px = qx;
    py = qy;
  }
  return out;
}

function anyWear(t: TerrainGrid): number {
  let n = 0;
  for (let i = 0; i < t.wear.length; i++) if (t.wear[i] > 0) n++;
  return n;
}

function count(t: TerrainGrid, type: number): number {
  let n = 0;
  for (const v of t.type) if (v === type) n++;
  return n;
}

function liveIn(w: World, g: Group, test: (tx: number, ty: number) => boolean): number {
  const s = w.soldiers;
  let n = 0;
  for (const m of g.members) {
    if (s.alive[m] === 1 && test(Math.floor(s.x[m] / T), Math.floor(s.y[m] / T))) n++;
  }
  return n;
}

// -- 1. the works themselves ----------------------------------------------------

section("works");
{
  const w = siegeWorld();
  const t = w.terrain;
  check("the stable generator is untouched by a siege",
    generateTerrain(120, 80, SEED).type.every((v, i) => {
      const x = i % 120;
      const y = (i / 120) | 0;
      const onRing = (x === EAST || x === RING.cx - RING.rx || y === RING.cy - RING.ry || y === RING.cy + RING.ry) &&
        x >= RING.cx - RING.rx && x <= EAST && y >= RING.cy - RING.ry && y <= RING.cy + RING.ry;
      return onRing || t.type[i] === v;
    }), "only the circuit's own tiles differ from the plain field");
  const gates = GATE_ROWS.filter((y) => t.typeAt(EAST, y) === Terrain.Gate).length;
  check("the circuit is raised with its gate where the road comes in",
    count(t, Terrain.Wall) > 60 && gates === 3,
    count(t, Terrain.Wall) + " wall tiles, " + gates + " gate tiles");
  check("the works belong to the defender", t.ownerAt(EAST, 40) === 0 && t.ownerAt(RING.cx, RING.cy - RING.ry) === 0);
  check("an intact wall is impassable and blocks sight",
    !t.passableAt(EAST, 30 + 15) && TERRAIN_INFO[Terrain.Wall].blocksSight);
  check("raising the works counted as no change for anyone to settle", w.tick === 0 && t.revision > 0);

  // Wear a curtain tile down by hand: it holds until its full strength is
  // spent, then falls to rubble -- one revision, stamped on that tile, and
  // recorded as an opening (routes) and a sight change (vision).
  const tx = EAST;
  const ty = 46;
  const hp = STRUCTURE[Terrain.Wall]!.hp;
  const rev0 = t.revision;
  const fell1 = t.damage(tx, ty, hp * 0.5);
  const half = t.integrityAt(tx, ty);
  const fell2 = t.damage(tx, ty, hp * 0.49);
  const still = t.typeAt(tx, ty) === Terrain.Wall && t.revision === rev0;
  const fell3 = t.damage(tx, ty, hp * 0.02);
  check("a wall wears without changing until its strength is spent",
    !fell1 && !fell2 && still && Math.abs(half - 0.5) < 1e-9, "integrity " + half.toFixed(2) + " at half wear");
  check("a wall that is spent falls to passable rubble",
    fell3 && t.typeAt(tx, ty) === Terrain.Rubble && t.passableAt(tx, ty) &&
      TERRAIN_INFO[Terrain.Rubble].cover < TERRAIN_INFO[Terrain.Wall].cover);
  check("the fall is one revision, stamped on its tile, marked opened and sight",
    t.revision === rev0 + 1 && t.tileRevision[tileOf(t, tx, ty)] === t.revision &&
      t.openedAt === t.revision && t.sightAt === t.revision && t.closedAt < t.revision);
  check("rubble can be dug again but not worn further", t.fortifiableAt(tx, ty) && !t.damage(tx, ty, 1e9));
}

// -- 2. engines batter, and never their own ------------------------------------

section("battering");
{
  // Four engines outside the gate, ordered into the town. They cannot get in,
  // so they march to the wall and wait; meanwhile they batter the gate (gates
  // outrank the curtain) until it falls.
  const w = siegeWorld();
  const g = company(w, 1, "siege", 34, 45);
  w.orders.issue({ kind: "move", squad: g.id, path: [RING.cx * T, RING.cy * T] }, 1, 0);
  let firstWear = -1;
  let fell = -1;
  for (let k = 0; k < TICK_RATE * 90 && fell < 0; k++) {
    w.step();
    const t = w.terrain;
    if (firstWear < 0 && GATE_ROWS.some((y) => t.integrityAt(EAST, y) < 1)) firstWear = w.tick;
    if (GATE_ROWS.some((y) => t.typeAt(EAST, y) === Terrain.Rubble)) fell = w.tick;
  }
  check("engines in reach wear the gate down", firstWear >= 0 && firstWear < TICK_RATE * 5,
    "first wear at tick " + firstWear);
  check("the gate falls to them", fell > 0, fell > 0 ? "fell at " + (fell / TICK_RATE).toFixed(1) + " s" : "never fell");
  let curtainWear = 0;
  for (let y = RING.cy - RING.ry; y <= RING.cy + RING.ry; y++) {
    if (!GATE_ROWS.includes(y) && w.terrain.integrityAt(EAST, y) < 1) curtainWear++;
  }
  check("the gate is taken before the curtain beside it", curtainWear === 0, curtainWear + " curtain tiles worn");

  // The defender's own engines, marching the same road, touch nothing.
  const own = siegeWorld();
  const og = company(own, 0, "siege", 34, 45);
  own.orders.issue({ kind: "move", squad: og.id, path: [40 * T, 60 * T] }, 0, 0);
  for (let k = 0; k < TICK_RATE * 40; k++) own.step();
  check("a side's engines never batter its own walls", anyWear(own.terrain) === 0,
    anyWear(own.terrain) + " tiles worn");

  // A barrage wears every work under it, whoever's, and fires nothing stone.
  const b = siegeWorld();
  const bg = company(b, 1, "line", 60, 60);
  b.armAbilities(1, ["barrage"]);
  b.orders.issue({ kind: "ability", squad: bg.id, ability: "barrage", x: (EAST + 0.5) * T, y: 45 * T }, 1, 0);
  for (let k = 0; k < TICK_RATE * 6; k++) b.step();
  check("a barrage batters the walls it falls on", anyWear(b.terrain) >= 5 && b.terrain.burning.length === 0,
    anyWear(b.terrain) + " tiles worn, " + b.terrain.burning.length + " alight");
}

// -- 3. a breach re-routes an assault ------------------------------------------

section("breach");
{
  // Close the gate off for this test (wall it up) so the only way in is a
  // breach we make, on the far side from where the road comes in.
  const w = siegeWorld({ siege: { ...RING, gates: [] } });
  const t = w.terrain;
  const fromX = 40 * T;
  const fromY = 58 * T;
  const goalX = RING.cx * T;
  const goalY = RING.cy * T;
  const before = findPathPartial(t, fromX, fromY, goalX, goalY);
  check("a closed circuit cannot be routed into", !before.reached && before.route.length > 0,
    "partial route of " + before.route.length / 2 + " waypoints");

  const g = company(w, 1, "line", 40, 58);
  w.orders.issue({ kind: "move", squad: g.id, path: [goalX, goalY] }, 1, 0);
  for (let k = 0; k < TICK_RATE * 40; k++) w.step();
  const waiting = g.routeShort && g.stance === "move";
  const insideBefore = liveIn(w, g, (x, y) => insideSiege(RING, x, y));
  check("the assault marches to the wall and waits there, still under orders",
    waiting && insideBefore === 0, "routeShort " + g.routeShort + ", stance " + g.stance + ", " + insideBefore + " inside");
  check("nobody waiting at the wall is inside it", stranded(w).length === 0);

  // Breach the south wall: three tiles, broken outright.
  const breach = [15, 16, 17].map((x) => tileOf(t, x, RING.cy + RING.ry));
  for (const i of breach) t.damage(i % t.width, (i / t.width) | 0, 1e9);
  const after = findPathPartial(t, fromX, fromY, goalX, goalY);
  const tiles = routeTiles(t, fromX, fromY, after.route);
  check("the breach opens a route, and the route goes through it",
    after.reached && breach.some((i) => tiles.has(i)), after.route.length / 2 + " waypoints");

  const pathRev = g.pathRevision;
  w.step();
  check("the waiting company re-plans the tick after the breach",
    !g.routeShort && g.pathRevision !== pathRev, "pathRevision " + pathRev + " -> " + g.pathRevision);
  let inside = 0;
  let worst = 0;
  for (let k = 0; k < TICK_RATE * 120; k++) {
    w.step();
    worst = Math.max(worst, stranded(w).length);
    inside = liveIn(w, g, (x, y) => insideSiege(RING, x, y));
    if (inside >= g.members.length * 0.8) break;
  }
  check("the company goes in through the breach", inside >= g.members.length * 0.8,
    inside + " of " + g.members.length + " inside");
  check("nobody stood in the wall on the way in", worst === 0, worst + " at worst");

  // The same breach made on a second world plans the same route: re-planning
  // is a pure function of the grid, not of when anyone looked.
  const w2 = siegeWorld({ siege: { ...RING, gates: [] } });
  for (const i of breach) w2.terrain.damage(i % w2.terrain.width, (i / w2.terrain.width) | 0, 1e9);
  const again = findPathPartial(w2.terrain, fromX, fromY, goalX, goalY);
  check("a breach re-plans identically on another peer", JSON.stringify(again) === JSON.stringify(after));
}

// -- 4. sight through a breach and through a burnt wood ------------------------

section("vision");
{
  const w = siegeWorld();
  const t = w.terrain;
  // Inside, five tiles behind the east wall; outside, five tiles in front.
  const ax = (EAST - 5 + 0.5) * T;
  const bx = (EAST + 5 + 0.5) * T;
  const y = (45 + 0.5) * T;
  check("an intact wall blocks a line of sight across it", !hasLineOfSight(t, ax, y, bx, y));
  check("a man on the parapet sees out over it",
    hasLineOfSight(t, (EAST - 1 + 0.5) * T, y, bx, y) && PARAPET_REACH === 2 * T);
  check("a missile at a man behind the wall loses the wall's cover",
    parapetCover(t, bx, y, (EAST - 1 + 0.5) * T, y) === TERRAIN_INFO[Terrain.Wall].cover &&
      parapetCover(t, ax, y, bx, y) === 0);

  // A world view of the same thing: a scout inside cannot see a scout outside
  // until the wall between them falls -- and sees him the very next tick.
  const me = company(w, 0, "scout", EAST - 5, 45);
  const foe = company(w, 1, "scout", EAST + 5, 45);
  w.orders.issue({ kind: "hold", squad: me.id, x: me.anchorX, y: me.anchorY, radius: 40 }, 0, 0);
  w.orders.issue({ kind: "hold", squad: foe.id, x: foe.anchorX, y: foe.anchorY, radius: 40 }, 1, 0);
  for (let k = 0; k < 10; k++) w.step();
  const seenBefore = foe.members.filter((m) => w.canSee(0, m)).length;
  for (let ty = 43; ty <= 47; ty++) t.damage(EAST, ty, 1e9);
  w.step();
  const seenAfter = foe.members.filter((m) => w.canSee(0, m)).length;
  check("a breach opens sight at once", seenBefore === 0 && seenAfter > 0,
    seenBefore + " seen before, " + seenAfter + " the tick after");
  check("the breach clears the line itself", hasLineOfSight(t, ax, y, bx, y));

  // A wood blocks sight until it burns out; the clearing it leaves does not.
  const v = siegeWorld();
  const vt = v.terrain;
  const wy = (35 + 0.5) * T;
  const wx0 = 28.5 * T;
  const wx1 = 45.5 * T;
  check("a standing wood blocks sight through it", !hasLineOfSight(vt, wx0, wy, wx1, wy));
  vt.ignite(36, 35);
  let ticks = 0;
  while (vt.burning.length > 0 && ticks < TICK_RATE * 600) {
    v.step();
    ticks++;
  }
  check("the wood burns itself out", vt.burning.length === 0 && vt.typeAt(36, 35) === Terrain.Clearing,
    (ticks / TICK_RATE).toFixed(0) + " s");
  check("sight runs clear through the burnt-out wood", hasLineOfSight(vt, wx0, wy, wx1, wy));

  // Sappers told to hold in the edge of a wood -- ground that cannot be dug --
  // fell it instead, a tile at a time, without fire.
  const f = siegeWorld();
  const ft = f.terrain;
  const sap = company(f, 0, "builder", 30, 35);
  f.orders.issue({ kind: "hold", squad: sap.id, x: 30.5 * T, y: 35.5 * T, radius: T * 2 }, 0, 0);
  const forest0 = count(ft, Terrain.Forest);
  for (let k = 0; k < TICK_RATE * 60; k++) f.step();
  check("sappers holding by a wood fell it into clearing",
    count(ft, Terrain.Clearing) > 0 && count(ft, Terrain.Forest) < forest0 && ft.burning.length === 0,
    count(ft, Terrain.Clearing) + " tiles felled");
}

// -- 5. fire -------------------------------------------------------------------

section("fire");
{
  function burnOut(t: TerrainGrid, seed: number, maxTicks: number): { ticks: number; lit: number } {
    let tick = 0;
    let lit = 0;
    while (t.burning.length > 0 && tick < maxTicks) {
      if (tick % FIRE_INTERVAL === 0) {
        stepFire(t, tick, seed);
        lit = Math.max(lit, t.burning.length);
      }
      tick++;
    }
    return { ticks: tick, lit };
  }

  const a = generateTerrain(120, 80, SEED);
  const forest = count(a, Terrain.Forest);
  const woodTiles: number[] = [];
  for (let y = 32; y <= 38; y++) for (let x = 30; x <= 42; x++) if (a.typeAt(x, y) === Terrain.Forest) woodTiles.push(tileOf(a, x, y));
  a.ignite(36, 35);
  const ra = burnOut(a, SEED, 20000);
  check("fire spreads through a wood", ra.lit > 5, "up to " + ra.lit + " tiles alight at once");
  check("and burns out", a.burning.length === 0, ra.ticks + " ticks");
  const cleared = count(a, Terrain.Clearing);
  check("what burnt is cleared ground, and only forest burnt",
    cleared > 0 && cleared === forest - count(a, Terrain.Forest) &&
      woodTiles.every((i) => a.type[i] === Terrain.Clearing),
    cleared + " tiles cleared; the whole wood went");
  check("fire stops at a firebreak",
    count(a, Terrain.Forest) > 0 && cleared <= woodTiles.length,
    cleared + " cleared of a " + woodTiles.length + "-tile wood; " + count(a, Terrain.Forest) + " forest elsewhere untouched");

  // The same fire, twice: identical ground and identical timing.
  const b = generateTerrain(120, 80, SEED);
  b.ignite(36, 35);
  const rb = burnOut(b, SEED, 20000);
  check("the same fire burns the same way twice",
    ra.ticks === rb.ticks && a.type.every((v, i) => v === b.type[i]));

  // Lighting the same tiles in a different order changes nothing: fire is
  // rolled per tile from a hash, never drawn from a stream in visit order.
  const c = generateTerrain(120, 80, SEED);
  const d = generateTerrain(120, 80, SEED);
  for (const [x, y] of [[32, 33], [40, 36], [36, 35]]) c.ignite(x, y);
  for (const [x, y] of [[36, 35], [40, 36], [32, 33]]) d.ignite(x, y);
  let same = true;
  for (let tick = 0; tick < 4000; tick += FIRE_INTERVAL) {
    stepFire(c, tick, SEED);
    stepFire(d, tick, SEED);
    if (!c.burn.every((v, i) => v === d.burn[i]) || !c.type.every((v, i) => v === d.type[i])) {
      same = false;
      break;
    }
  }
  check("the order fires are lit in changes nothing", same);

  // Another seed is another fire: the rolls really are seeded.
  const e = generateTerrain(120, 80, SEED);
  e.ignite(36, 35);
  const re = burnOut(e, SEED + 1, 20000);
  check("a different battle seed burns differently", re.ticks !== ra.ticks || !e.burn.every((v, i) => v === a.burn[i]) ||
    !e.type.every((v, i) => v === a.type[i]), ra.ticks + " vs " + re.ticks + " ticks");

  // Firepots thrown into the wood set it alight, and the men in it burn.
  const w = siegeWorld();
  const thrower = company(w, 1, "line", 46, 44);
  const victims = company(w, 0, "line", 34, 34);
  w.orders.issue({ kind: "hold", squad: victims.id, x: victims.anchorX, y: victims.anchorY, radius: 30 }, 0, 0);
  w.armAbilities(1, ["firepots"]);
  w.orders.issue({ kind: "ability", squad: thrower.id, ability: "firepots", x: 36.5 * T, y: 35.5 * T }, 1, 0);
  w.step();
  const lit = w.terrain.burning.length;
  check("firepots set a wood alight", lit > 0, lit + " tiles");
  let hp0 = 0;
  for (const m of victims.members) hp0 += w.soldiers.hp[m];
  for (let k = 0; k < TICK_RATE * 20; k++) w.step();
  let hp1 = 0;
  for (const m of victims.members) hp1 += w.soldiers.alive[m] === 1 ? w.soldiers.hp[m] : 0;
  check("men standing in a burning wood are hurt by it", hp1 < hp0, hp0.toFixed(0) + " -> " + hp1.toFixed(0) + " hp");

  // A stone wall does not burn; a palisade and its gate do, down to rubble.
  const p = siegeWorld({ siege: { ...RING, kind: "palisade" } });
  const pt = p.terrain;
  check("stone does not take fire", !generateTerrain(1, 1, 1).flammableAt(0, 0) && !siegeWorld().terrain.ignite(EAST, 46));
  pt.ignite(EAST, 46);
  let pticks = 0;
  while (pt.burning.length > 0 && pticks < TICK_RATE * 900) {
    p.step();
    pticks++;
  }
  check("a fired palisade burns along its length and leaves rubble",
    count(pt, Terrain.Rubble) > 3 && pt.typeAt(EAST, 46) === Terrain.Rubble,
    count(pt, Terrain.Rubble) + " tiles fell in " + (pticks / TICK_RATE).toFixed(0) + " s");
}

// -- 6. bridges ----------------------------------------------------------------

section("bridges");
{
  const w = siegeWorld();
  const t = w.terrain;
  const middle: number[] = [];
  const all: number[] = [];
  for (let i = 0; i < t.type.length; i++) {
    if (t.type[i] !== Terrain.Bridge) continue;
    all.push(i);
    const y = (i / t.width) | 0;
    if (y >= 38 && y <= 42) middle.push(i);
  }
  const fromX = 60.5 * T;
  const fromY = 40.5 * T;
  const toX = 85.5 * T;
  const toY = 40.5 * T;
  const before = findPath(t, fromX, fromY, toX, toY);
  const beforeTiles = routeTiles(t, fromX, fromY, before);
  check("the road crosses by the middle bridge", middle.some((i) => beforeTiles.has(i)),
    middle.length + " tiles of bridge");

  for (const i of middle) t.damage(i % t.width, (i / t.width) | 0, 1e9);
  check("a broken bridge is river again", middle.every((i) => t.type[i] === Terrain.Water));
  const after = findPath(t, fromX, fromY, toX, toY);
  const afterTiles = routeTiles(t, fromX, fromY, after);
  let wet = 0;
  for (const i of afterTiles) if (!t.passableAt(i % t.width, (i / t.width) | 0)) wet++;
  check("the crossing goes round by another bridge", after.length > 0 && !middle.some((i) => afterTiles.has(i)) && wet === 0,
    before.length / 2 + " -> " + after.length / 2 + " waypoints, " + wet + " wet tiles on the way");

  // This river can be walked round at its southern end, so the clean case is
  // a field of its own: one river from edge to edge, one bridge across it.
  const g = new TerrainGrid(24, 12);
  for (let y = 0; y < 12; y++) g.type[y * 24 + 12] = Terrain.Water;
  g.type[6 * 24 + 12] = Terrain.Bridge;
  const open = findPathPartial(g, 3 * T, 6.5 * T, 20 * T, 6.5 * T);
  g.damage(12, 6, 1e9);
  const shut = findPathPartial(g, 3 * T, 6.5 * T, 20 * T, 6.5 * T);
  const shutTiles = routeTiles(g, 3 * T, 6.5 * T, shut.route);
  check("with its only bridge down the river cannot be crossed",
    open.reached && !shut.reached && findPath(g, 3 * T, 6.5 * T, 20 * T, 6.5 * T).length === 0 &&
      [...shutTiles].every((i) => i % 24 < 12),
    "partial route stops on the near bank");

  // Sappers told to hold on a bridge -- ground that cannot be dug -- break it.
  const s = siegeWorld();
  const st = s.terrain;
  const sap = company(s, 0, "builder", 71, 40);
  s.orders.issue({ kind: "hold", squad: sap.id, x: 71.5 * T, y: 40.5 * T, radius: T * 3 }, 0, 0);
  let broke = -1;
  let worst = 0;
  for (let k = 0; k < TICK_RATE * 120; k++) {
    s.step();
    worst = Math.max(worst, stranded(s).length);
    if (broke < 0 && middle.some((i) => st.type[i] === Terrain.Water)) broke = s.tick;
  }
  check("sappers holding on a bridge break it", broke > 0,
    broke > 0 ? "first span fell at " + (broke / TICK_RATE).toFixed(1) + " s" : "never");
  check("and none of them went into the river with it", worst === 0);

  // A company standing ON the span when it falls. Handling, documented on
  // World.settleTerrain: every man is put on the nearest standing ground
  // (closest passable tile, ties to the lower tile index) and loses nerve.
  function onTheSpan(): { w: World; g: Group; nerve0: number } {
    const w = siegeWorld();
    const g = company(w, 1, "line", 72, 40);
    w.orders.issue({ kind: "hold", squad: g.id, x: g.anchorX, y: g.anchorY, radius: 40 }, 1, 0);
    for (let k = 0; k < 5; k++) w.step();
    let nerve0 = 0;
    for (const m of g.members) nerve0 += w.soldiers.morale[m];
    for (const i of middle) w.terrain.damage(i % w.terrain.width, (i / w.terrain.width) | 0, 1e9);
    w.step();
    return { w, g, nerve0 };
  }
  const x = onTheSpan();
  const y2 = onTheSpan();
  let nerve1 = 0;
  for (const m of x.g.members) nerve1 += x.w.soldiers.morale[m];
  const alive = x.g.members.filter((m) => x.w.soldiers.alive[m] === 1).length;
  check("a company on a falling span is put ashore, not drowned",
    stranded(x.w).length === 0 && alive === x.g.members.length, alive + " of " + x.g.members.length + " alive and dry");
  check("and is shaken by it", nerve1 < x.nerve0, (x.nerve0 / alive).toFixed(2) + " -> " + (nerve1 / alive).toFixed(2));
  check("the same fall puts every man in the same place on another peer", hashWorld(x.w) === hashWorld(y2.w));
}

// -- 7. the invariant, under a destruction-heavy battle ------------------------

section("nobody on water or in a wall");
{
  // Engines, sappers and foot assault the ring while firepots and a barrage
  // land on the wood and the walls, and the defender holds inside. Checked at
  // the end of every single tick.
  const w = siegeWorld({ aiPlayers: [0, 1] }, false);
  company(w, 0, "line", 14, 38);
  company(w, 0, "archer", 18, 44);
  company(w, 0, "line", 20, 36);
  company(w, 0, "pike", 12, 44);
  company(w, 0, "guard", 16, 41);
  company(w, 1, "siege", 34, 45);
  company(w, 1, "siege", 34, 50);
  company(w, 1, "builder", 33, 42);
  company(w, 1, "line", 36, 46);
  company(w, 1, "line", 38, 52);
  const fp = company(w, 1, "archer", 44, 44);
  w.armAbilities(1, ["firepots", "barrage"]);
  w.orders.issue({ kind: "ability", squad: fp.id, ability: "firepots", x: 36.5 * T, y: 35.5 * T }, 1, 2);
  // The barrage goes on the empty north-east corner of the circuit: on the
  // garrison it is simply a massacre, and the battle is over before the ground
  // has had time to change.
  w.orders.issue({ kind: "ability", squad: fp.id, ability: "barrage", x: (EAST + 0.5) * T, y: (RING.cy - RING.ry + 0.5) * T }, 1, 200);
  const rev0 = w.terrain.revision;
  let bad = 0;
  let firstBad = -1;
  let burnt = 0;
  for (let k = 0; k < TICK_RATE * 300 && !w.outcome; k++) {
    w.step();
    const n = stranded(w).length;
    if (n > 0 && firstBad < 0) firstBad = w.tick;
    bad += n;
    burnt = Math.max(burnt, w.terrain.burning.length);
  }
  const changed = w.terrain.revision - rev0;
  check("the ground really changed under them", changed > 5 && burnt > 0,
    changed + " tile changes, up to " + burnt + " alight");
  check("no man ended any tick on water or inside a wall", bad === 0,
    bad === 0 ? w.tick + " ticks checked" : bad + " man-ticks, first at tick " + firstBad);
}

// -- 8. the siege battlefield --------------------------------------------------

section("the siege level");
{
  const level = LEVELS.find((l) => l.siege !== undefined);
  check("a siege battlefield is in the level list", level !== undefined, level?.id ?? "none");
  if (level && level.siege) {
    const w = new World({
      seed: level.seed, tilesWide: level.tilesWide, tilesHigh: level.tilesHigh, duration: level.duration,
      soldierCapacity: 4096, aiPlayers: [0, 1], victory: level.victory, controlPoints: level.controlPoints,
      reinforcements: level.reinforcements, siege: level.siege,
    });
    const t = w.terrain;
    let walled = 0;
    for (const z of level.deployment) {
      for (let y = z.y; y < z.y + z.h; y++) for (let x = z.x; x < z.x + z.w; x++) if (!t.passableAt(x, y) && t.typeAt(x, y) >= Terrain.Wall) walled++;
    }
    check("no deployment ground is inside a wall", walled === 0, walled + " tiles");
    const defender = level.deployment.find((z) => z.player === level.siege!.defender)!;
    check("the defender deploys inside the circuit",
      insideSiege(level.siege, defender.x, defender.y) && insideSiege(level.siege, defender.x + defender.w - 1, defender.y + defender.h - 1));
    const cp = level.controlPoints[0];
    check("what is held is inside the walls", cp !== undefined && insideSiege(level.siege, Math.floor(cp.x / T), Math.floor(cp.y / T)));

    // Set both armies out as the battle layer does and let the machine fight it.
    const armies = [defaultArmy("defensive", level.budget), enemyArmy(level, level.budget)];
    check("the besieger brings engines", armies[1].squads.filter((s) => s === "siege").length >= 2,
      armies[1].squads.join(" "));
    for (const zone of level.deployment) {
      let n = 0;
      for (const type of armies[zone.player].squads) {
        const bx = (zone.x + 3 + (n % 4) * 5) * T;
        const by = (zone.y + 4 + ((n / 4) | 0) * 9) * T;
        for (let i = 0; i < UNIT_TYPES[type].soldiers; i++) {
          w.spawnSoldier(zone.player, type, bx + (i % 5) * 14, by + ((i / 5) | 0) * 14, zone.player === 0 ? 0 : Math.PI);
        }
        n++;
      }
    }
    check("nobody is set out in a wall", stranded(w).length === 0, stranded(w).length + " stranded");
    const rev0 = t.revision;
    let bad = 0;
    for (let k = 0; k < TICK_RATE * 240 && !w.outcome; k++) {
      w.step();
      bad += stranded(w).length;
    }
    check("the machine's assault damages the walls", anyWear(t) > 0 || t.revision > rev0,
      anyWear(t) + " tiles worn, " + (t.revision - rev0) + " fallen in " + (w.tick / TICK_RATE).toFixed(0) + " s");
    check("and nobody ends a tick in the works", bad === 0, bad + " man-ticks");
  }
}

// -- K10. gates that open, keeps, and walls that remember -------------------------

section("K10 gates");
{
  // The garrison opens its gate: the gateway is passable and open to sight,
  // the wear on it is kept, and a route from outside now goes in through it.
  const w = siegeWorld();
  const t = w.terrain;
  t.damage(EAST, 40, 300);
  const fromX = 40 * T;
  const fromY = 40.5 * T;
  const shut = findPathPartial(t, fromX, fromY, RING.cx * T, RING.cy * T);
  w.orders.issue({ kind: "gates", open: true }, 1, 0);
  w.step();
  check("the besieger cannot open the garrison's gates",
    GATE_ROWS.every((y) => t.typeAt(EAST, y) === Terrain.Gate) && !w.gatesOpen(1));
  w.orders.issue({ kind: "gates", open: true }, 0, w.tick);
  w.step();
  const open = GATE_ROWS.every((y) => t.typeAt(EAST, y) === Terrain.GateOpen);
  check("the garrison opens its gate", open && w.gatesOpen(0) && GATE_ROWS.every((y) => t.passableAt(EAST, y)));
  check("an open gate keeps its wear and its owner",
    Math.abs(t.integrityAt(EAST, 40) - (1 - 300 / STRUCTURE[Terrain.Gate]!.hp)) < 1e-9 && t.ownerAt(EAST, 40) === 0);
  const through = findPathPartial(t, fromX, fromY, RING.cx * T, RING.cy * T);
  check("a shut gate is no way in, an open one is",
    !shut.reached && through.reached && routeTiles(t, fromX, fromY, through.route).has(tileOf(t, EAST, 40)));
  check("an open gateway does not block sight",
    hasLineOfSight(t, (EAST - 5 + 0.5) * T, 40.5 * T, (EAST + 5 + 0.5) * T, 40.5 * T));

  // A sally: a company of the garrison marches out through the open gate.
  const g = company(w, 0, "line", RING.cx, RING.cy);
  w.orders.issue({ kind: "move", squad: g.id, path: [34 * T, 40.5 * T] }, 0, w.tick);
  let out = 0;
  let worst = 0;
  let inGate = false;
  for (let k = 0; k < TICK_RATE * 60; k++) {
    w.step();
    worst = Math.max(worst, stranded(w).length);
    if (!inGate && liveIn(w, g, (x, y) => x === EAST && GATE_ROWS.includes(y)) > 0) {
      inGate = true;
      // Try to shut it on them: refused while anyone stands in the gateway.
      w.orders.issue({ kind: "gates", open: false }, 0, w.tick + 1);
      w.step();
      check("a gate is not shut on men standing in it", GATE_ROWS.every((y) => t.typeAt(EAST, y) === Terrain.GateOpen));
    }
    out = liveIn(w, g, (x) => x > EAST);
    if (out >= g.members.length * 0.8) break;
  }
  check("the garrison sallies out through its open gate", out >= g.members.length * 0.8,
    out + " of " + g.members.length + " outside");
  check("nobody stood in the wall on the way out", worst === 0);
  // Clear of the gateway, it shuts behind them.
  for (let k = 0; k < TICK_RATE * 5; k++) w.step();
  w.orders.issue({ kind: "gates", open: false }, 0, w.tick);
  w.step();
  check("with the gateway clear the gate shuts again",
    GATE_ROWS.every((y) => t.typeAt(EAST, y) === Terrain.Gate) && !w.gatesOpen(0) && stranded(w).length === 0);
  check("and the wear on it is still there",
    Math.abs(t.integrityAt(EAST, 40) - (1 - 300 / STRUCTURE[Terrain.Gate]!.hp)) < 1e-9);

  // Engines go for an open gate as for a shut one.
  const e = siegeWorld();
  e.orders.issue({ kind: "gates", open: true }, 0, 0);
  e.step();
  const eg = company(e, 1, "siege", 34, 45);
  e.orders.issue({ kind: "hold", squad: eg.id, x: eg.anchorX, y: eg.anchorY, radius: 30 }, 1, e.tick);
  e.orders.issue({ kind: "move", squad: eg.id, path: [30 * T, 45 * T] }, 1, e.tick + 1);
  for (let k = 0; k < TICK_RATE * 5; k++) e.step();
  check("an open gate is battered like a shut one", GATE_ROWS.some((y) => e.terrain.integrityAt(EAST, y) < 1));
  check("an open gate burns", e.terrain.ignite(EAST, 40) || e.terrain.burningAt(EAST, 40));

  // Two peers, one log, the same gates.
  const a = siegeWorld();
  const b = siegeWorld();
  for (const x of [a, b]) {
    x.orders.issue({ kind: "gates", open: true }, 0, 3);
    x.orders.issue({ kind: "gates", open: false }, 0, 40);
  }
  for (let k = 0; k < 60; k++) { a.step(); b.step(); }
  check("gates swing the same on two peers", hashWorld(a) === hashWorld(b));
}

section("K10 keeps and old damage");
{
  // A keep: two courses of stone, its gate through both.
  const KEEP: SiegeWorks = { ...RING, thickness: 2 };
  const w = siegeWorld({ siege: KEEP });
  const t = w.terrain;
  check("a keep's wall is two courses thick",
    t.typeAt(EAST, 46) === Terrain.Wall && t.typeAt(EAST - 1, 46) === Terrain.Wall && t.passableAt(EAST - 2, 46) &&
      !insideSiege(KEEP, EAST - 1, 46) && insideSiege(KEEP, EAST - 2, 46));
  check("its gate runs through both courses",
    GATE_ROWS.every((y) => t.typeAt(EAST, y) === Terrain.Gate && t.typeAt(EAST - 1, y) === Terrain.Gate));
  const k2 = siegeWorld({ siege: { ...KEEP, gates: [] } });
  k2.terrain.damage(EAST, 46, 1e9);
  const one = findPathPartial(k2.terrain, 40 * T, 46.5 * T, RING.cx * T, RING.cy * T).reached;
  k2.terrain.damage(EAST - 1, 46, 1e9);
  const two = findPathPartial(k2.terrain, 40 * T, 46.5 * T, RING.cx * T, RING.cy * T).reached;
  check("a keep is breached only through both courses", !one && two);

  // Works raised already battered: the holding's unmended wall damage.
  const half = siegeWorld({ siege: { ...RING, worn: 500 } });
  const ht = half.terrain;
  check("walls raised at 500 per mille are half worn, the gate too",
    Math.abs(ht.integrityAt(EAST, 46) - 0.5) < 1e-9 && Math.abs(ht.integrityAt(EAST, 40) - 0.5) < 1e-9 &&
      ht.typeAt(EAST, 46) === Terrain.Wall);
  check("the battle reads its own old damage back", half.wallDamage() === 500, half.wallDamage() + " per mille");
  const gone = siegeWorld({ siege: { ...RING, worn: 1000 } });
  check("walls raised at 1000 per mille are rubble", gone.terrain.typeAt(EAST, 46) === Terrain.Rubble &&
    gone.terrain.typeAt(RING.cx, RING.cy - RING.ry) === Terrain.Rubble && gone.wallDamage() === 1000);
  const whole = siegeWorld();
  check("whole walls read 0", whole.wallDamage() === 0);
  whole.terrain.damage(EAST, 46, 1e9);
  const one2 = whole.wallDamage();
  check("one fallen tile reads as a little damage", one2 > 0 && one2 < 30, one2 + " per mille");
  check("a field with no works has no wall damage", new World({ seed: SEED, tilesWide: 120, tilesHigh: 80 }).wallDamage() === 0);
  check("raising old damage is the same on two peers",
    hashWorld(siegeWorld({ siege: { ...RING, worn: 333 } })) === hashWorld(siegeWorld({ siege: { ...RING, worn: 333 } })));
}

// -- 9. the hash sees the ground ------------------------------------------------

section("hash");
{
  const a = siegeWorld();
  const b = siegeWorld();
  check("two sieges from one seed hash alike", hashWorld(a) === hashWorld(b));
  b.terrain.wear[tileOf(b.terrain, EAST, 46)] += 0.001;
  check("a thousandth of wear on one wall is caught", hashWorld(a) !== hashWorld(b));
  const c = siegeWorld();
  c.terrain.ignite(36, 35);
  check("a single tile alight is caught", hashWorld(a) !== hashWorld(c));
  const plain = new World({ seed: SEED, tilesWide: 120, tilesHigh: 80 });
  check("a field nothing has touched does not hash its terrain state", !plain.terrain.dynamic);
}

const failed = checks.filter((c) => !c.ok);
console.log("");
console.log(failed.length === 0
  ? "siege: all " + checks.length + " checks passed"
  : "SIEGE: " + failed.length + " of " + checks.length + " checks FAILED");
console.log("");
process.exit(failed.length === 0 ? 0 : 1);
