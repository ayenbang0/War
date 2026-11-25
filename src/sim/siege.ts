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
 * and timber, so fire takes them too. They are CLOSED to both sides -- this is
 * an assault, and the garrison is not sallying -- so a gate is where the
 * attacker breaks in, not a door either side walks through (PROVISIONAL P8.1).
 */

import { max, min } from "./math.ts";
import { Terrain, type TerrainGrid, type TerrainType } from "./terrain.ts";

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
};

/** The tile rectangle a circuit's wall line runs along. */
export function siegeBounds(w: SiegeWorks): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: w.cx - w.rx, y0: w.cy - w.ry, x1: w.cx + w.rx, y1: w.cy + w.ry };
}

/** Is a tile strictly inside the circuit (not on the wall line)? */
export function insideSiege(w: SiegeWorks, tx: number, ty: number): boolean {
  const b = siegeBounds(w);
  return tx > b.x0 && tx < b.x1 && ty > b.y0 && ty < b.y1;
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
  let raised = 0;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const onWall = tx === b.x0 || tx === b.x1 || ty === b.y0 || ty === b.y1;
      if (!onWall) continue;
      const t = isGate(works, b, tx, ty, half) ? Terrain.Gate : curtain;
      if (grid.raise(tx, ty, t, works.defender)) raised++;
    }
  }
  return raised;
}

function isGate(
  works: SiegeWorks,
  b: { x0: number; y0: number; x1: number; y1: number },
  tx: number,
  ty: number,
  half: number,
): boolean {
  for (const g of works.gates) {
    const along = g.side === "north" || g.side === "south";
    const at = g.at ?? (along ? works.cx : works.cy);
    if (g.side === "north" && ty !== b.y0) continue;
    if (g.side === "south" && ty !== b.y1) continue;
    if (g.side === "west" && tx !== b.x0) continue;
    if (g.side === "east" && tx !== b.x1) continue;
    const d = (along ? tx : ty) - at;
    if (d >= -half && d <= half) return true;
  }
  return false;
}
