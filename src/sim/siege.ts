/**
 * Siege works: walls and gates laid round a defended place before battle.
 *
 * The one hook a siege battle needs (PLAN.md Part D Phase 8, and §B.11 K10).
 * A level, or the kingdom layer building a `BattleSpec` for an assault on a
 * walled holding (§B.8, §B.9: "terrainSpec ... + fortification"), describes
 * the circuit as plain data; `raiseSiegeWorks` builds it on the generated
 * terrain inside the World constructor, before a single man is set down.
 * Nothing else in sim/ knows it is a siege: walls are terrain, and every rule
 * about terrain -- impassable, sight, cover, wear, rubble -- already applies.
 *
 * The circuit is a rectangle of curtain one tile thick, centred on the place
 * being defended. Rivers and mountains it crosses are left as they are (they
 * are already walls). Gates are the weak points: a third of a wall's strength,
 * and timber, so fire takes them too. They are raised SHUT. K10 lifts the
 * Phase 8 scope cut (P8.1): the side holding the walls may swing its gates
 * open to sally and shut again behind it (World `gates` order); the
 * attacker can only break them (docs/PROVISIONAL.md K10.1).
 *
 * K10 also lets a circuit be THICK (a keep: two courses of stone, so a breach
 * takes twice the battering) and lets it be raised already battered, with the
 * damage a holding's walls took in an earlier battle and nobody mended
 * (`worn`). Both are plain data on the record, so the same works on the same
 * seed are still the same walls.
 */

import { max, min, round } from "./math.ts";
import { STRUCTURE, Terrain, isCurtain, type TerrainGrid, type TerrainType } from "./terrain.ts";

export type SiegeSide = "north" | "south" | "east" | "west";

export type SiegeGate = {
  readonly side: SiegeSide;
  /**
   * Tile coordinate along that side where the gate is centred: a column for
   * north/south, a row for east/west. Defaults to the middle of the side, but
   * a gate belongs where the road comes in, so levels usually name it.
   */
  readonly at?: number;
};

export type SiegeWorks = {
  /** The side holding the walls. Engines never batter their own. */
  readonly defender: number;
  /** Centre of the circuit, in tiles: the place being defended. */
  readonly cx: number;
  readonly cy: number;
  /** Half-width and half-height of the circuit, in tiles, to the wall line. */
  readonly rx: number;
  readonly ry: number;
  /** Stone curtain, or a timber stockade that burns. */
  readonly kind: "wall" | "palisade";
  readonly gates: readonly SiegeGate[];
  /** Gate width in tiles. Three lets a formed company through a broken gate. */
  readonly gateWidth?: number;
  /** K10: courses of curtain, inward from the wall line. 1 if absent; a keep is 2. */
  readonly thickness?: number;
  /**
   * K10: wear already on the works when they are raised, per mille of each
   * tile's strength (0..1000): the holding's unmended battle damage. Every
   * curtain and gate tile takes the same share, so it is order-free; 1000
   * leaves the whole circuit in rubble.
   */
  readonly worn?: number;
};

/** The tile rectangle a circuit's wall line runs along. */
export function siegeBounds(w: SiegeWorks): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: w.cx - w.rx, y0: w.cy - w.ry, x1: w.cx + w.rx, y1: w.cy + w.ry };
}

/** Courses of curtain (1 unless the record says otherwise). */
export function siegeThickness(w: SiegeWorks): number {
  return max(1, w.thickness ?? 1);
}

/** Is a tile strictly inside the circuit (not on the wall line, nor in a thick wall)? */
export function insideSiege(w: SiegeWorks, tx: number, ty: number): boolean {
  const b = siegeBounds(w);
  const k = siegeThickness(w) - 1;
  return tx > b.x0 + k && tx < b.x1 - k && ty > b.y0 + k && ty < b.y1 - k;
}

/** Is a tile on the circuit's curtain (any of its courses)? */
export function onSiegeWall(w: SiegeWorks, tx: number, ty: number): boolean {
  const b = siegeBounds(w);
  if (tx < b.x0 || tx > b.x1 || ty < b.y0 || ty > b.y1) return false;
  return !insideSiege(w, tx, ty);
}

/**
 * The tiles of one gate (index into `works.gates`), ascending by tile index:
 * every course it passes through. What the `gates` order swings, and what a
 * battle reads back as the gate's state.
 */
export function gateTiles(grid: TerrainGrid, works: SiegeWorks, gate: number): number[] {
  const g = works.gates[gate];
  if (!g) return [];
  const b = siegeBounds(works);
  const half = ((works.gateWidth ?? 3) - 1) / 2;
  const k = siegeThickness(works);
  const along = g.side === "north" || g.side === "south";
  const at = g.at ?? (along ? works.cx : works.cy);
  const out: number[] = [];
  for (let c = 0; c < k; c++) {
    for (let d = -half; d <= half; d++) {
      let tx: number;
      let ty: number;
      if (g.side === "north") { tx = at + d; ty = b.y0 + c; }
      else if (g.side === "south") { tx = at + d; ty = b.y1 - c; }
      else if (g.side === "west") { tx = b.x0 + c; ty = at + d; }
      else { tx = b.x1 - c; ty = at + d; }
      if (grid.inBounds(tx, ty)) out.push(ty * grid.width + tx);
    }
  }
  return out.sort((p, q) => p - q);
}

/**
 * Build the circuit on a grid. Returns the number of tiles raised.
 *
 * Deterministic and order-free: every tile's fate is a function of its
 * position alone, so the same works on the same seed are the same walls.
 */
export function raiseSiegeWorks(grid: TerrainGrid, works: SiegeWorks): number {
  const b = siegeBounds(works);
  const x0 = max(0, b.x0);
  const y0 = max(0, b.y0);
  const x1 = min(grid.width - 1, b.x1);
  const y1 = min(grid.height - 1, b.y1);
  const curtain: TerrainType = works.kind === "palisade" ? Terrain.Palisade : Terrain.Wall;
  const half = ((works.gateWidth ?? 3) - 1) / 2;
  const k = siegeThickness(works);
  const worn = min(1000, max(0, works.worn ?? 0));
  let raised = 0;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (!onSiegeWall(works, tx, ty)) continue;
      const t = isGateTile(works, b, tx, ty, half, k) ? Terrain.Gate : curtain;
      if (!grid.raise(tx, ty, t, works.defender)) continue;
      raised++;
      // K10: old damage nobody mended. A share of the tile's own strength,
      // so stone and timber are weakened alike; all of it is rubble.
      if (worn > 0) {
        const hp = STRUCTURE[t]?.hp ?? 0;
        grid.damage(tx, ty, worn >= 1000 ? hp : (hp * worn) / 1000);
      }
    }
  }
  return raised;
}

/**
 * K10: how badly the works of a circuit were battered, per mille (0..1000):
 * the share of the circuit's whole strength gone, a fallen tile counting as
 * all of its strength. Read off a finished battle and handed back to the
 * holding as its wall damage (BattleResult `damage.walls`). Tiles that were
 * never raised (a river, a cliff on the line) count for nothing either way.
 */
export function siegeDamage(grid: TerrainGrid, works: SiegeWorks): number {
  const b = siegeBounds(works);
  const half = ((works.gateWidth ?? 3) - 1) / 2;
  const k = siegeThickness(works);
  const curtain: TerrainType = works.kind === "palisade" ? Terrain.Palisade : Terrain.Wall;
  let whole = 0;
  let gone = 0;
  for (let ty = max(0, b.y0); ty <= min(grid.height - 1, b.y1); ty++) {
    for (let tx = max(0, b.x0); tx <= min(grid.width - 1, b.x1); tx++) {
      if (!onSiegeWall(works, tx, ty)) continue;
      const planned: TerrainType = isGateTile(works, b, tx, ty, half, k) ? Terrain.Gate : curtain;
      const t = grid.typeAt(tx, ty);
      const hp = STRUCTURE[planned]?.hp ?? 0;
      if (t === Terrain.Rubble || t === Terrain.Clearing) {
        whole += hp;
        gone += hp;
        continue;
      }
      const st = STRUCTURE[t];
      if (st === undefined || (!isCurtain(t))) continue;
      whole += st.hp;
      gone += grid.wear[ty * grid.width + tx];
    }
  }
  if (whole <= 0) return 0;
  return min(1000, round((gone * 1000) / whole));
}

function isGateTile(
  works: SiegeWorks,
  b: { x0: number; y0: number; x1: number; y1: number },
  tx: number,
  ty: number,
  half: number,
  k: number,
): boolean {
  for (const g of works.gates) {
    const along = g.side === "north" || g.side === "south";
    const at = g.at ?? (along ? works.cx : works.cy);
    // Every course of a thick wall has the gate through it.
    if (g.side === "north" && (ty < b.y0 || ty > b.y0 + k - 1)) continue;
    if (g.side === "south" && (ty > b.y1 || ty < b.y1 - k + 1)) continue;
    if (g.side === "west" && (tx < b.x0 || tx > b.x0 + k - 1)) continue;
    if (g.side === "east" && (tx > b.x1 || tx < b.x1 - k + 1)) continue;
    const d = (along ? tx : ty) - at;
    if (d >= -half && d <= half) return true;
  }
  return false;
}
