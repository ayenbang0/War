/**
 * Uniform-grid spatial hash for soldier neighbour queries.
 *
 * Local avoidance asks "who is near me" once per soldier per tick. At ~600
 * soldiers a naive pairwise sweep is 180k distance checks every tick; bucketing
 * by cell makes it proportional to actual local density instead.
 *
 * Query results come back in cell-scan order, which is deterministic given a
 * deterministic insertion order -- so this stays safe for lockstep.
 */

import { floor, max } from "./math.ts";

export class SpatialHash {
  private readonly cellSize: number;
  private readonly cols: number;
  private readonly rows: number;
  /** Head of the bucket chain per cell, -1 when empty. */
  private readonly heads: Int32Array;
  /** Next entry in the same bucket, indexed by item id. */
  private next: Int32Array;

  constructor(worldW: number, worldH: number, cellSize: number, capacity: number) {
    this.cellSize = cellSize;
    this.cols = max(1, floor(worldW / cellSize) + 1);
    this.rows = max(1, floor(worldH / cellSize) + 1);
    this.heads = new Int32Array(this.cols * this.rows).fill(-1);
    this.next = new Int32Array(capacity).fill(-1);
  }

  clear(): void {
    this.heads.fill(-1);
  }

  ensureCapacity(n: number): void {
    if (n <= this.next.length) return;
    this.next = new Int32Array(n).fill(-1);
  }

  insert(id: number, x: number, y: number): void {
    const cx = this.clampCol(floor(x / this.cellSize));
    const cy = this.clampRow(floor(y / this.cellSize));
    const cell = cy * this.cols + cx;
    this.next[id] = this.heads[cell];
    this.heads[cell] = id;
  }

  /**
   * Append the ids within radius of (x, y) to out, returning how many were
   * written. Candidates are cell-filtered only; the caller does the exact
   * distance test it needs.
   */
  query(x: number, y: number, radius: number, out: Int32Array): number {
    const minCx = this.clampCol(floor((x - radius) / this.cellSize));
    const maxCx = this.clampCol(floor((x + radius) / this.cellSize));
    const minCy = this.clampRow(floor((y - radius) / this.cellSize));
    const maxCy = this.clampRow(floor((y + radius) / this.cellSize));

    let n = 0;
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        let id = this.heads[cy * this.cols + cx];
        while (id !== -1) {
          if (n >= out.length) return n;
          out[n++] = id;
          id = this.next[id];
        }
      }
    }
    return n;
  }

  private clampCol(c: number): number {
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  private clampRow(r: number): number {
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }
}
