/**
 * Static terrain, pre-rendered into cached offscreen chunks.
 *
 * The battlefield is 6144x4096 world pixels. One offscreen canvas that size
 * would be ~100 MB, and re-filling ~16k tile rects every frame at low zoom is
 * wasteful, so terrain is baked into 512px chunks and only the visible ones are
 * kept. When TerrainGrid.revision moves, a chunk re-bakes only if a tile in
 * it (or on its one-tile border, since walls and rubble draw against their
 * neighbours) changed since it was baked -- read from the grid's per-tile
 * revision stamps. A breach re-bakes one chunk, not the sixty-four in view.
 * Live state that changes every tick (cracks as a wall is battered, flames)
 * is not baked at all; the renderer draws it over the chunks.
 *
 * Map grid lines are deliberately NOT baked -- they are drawn live in screen
 * space by the renderer so they stay hairline-crisp at every zoom level.
 */

import { TerrainGrid, TILE_SIZE } from "../sim/terrain.ts";
import { terrainFill } from "./palette.ts";
import type { Camera } from "./camera.ts";

const CHUNK_WORLD = 512;
const TILES_PER_CHUNK = CHUNK_WORLD / TILE_SIZE;
/** ~1 MB per chunk; this cap bounds the layer at roughly 64 MB. */
const MAX_CACHED_CHUNKS = 64;

type Chunk = { canvas: HTMLCanvasElement; revision: number };

/** Stable per-tile jitter. Must not be random: chunks re-bake after eviction,
 *  and a reshuffled texture would visibly shimmer as the player pans. */
function tileHash(x: number, y: number, salt: number): number {
  let h = (salt ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

export class TerrainLayer {
  private cache = new Map<string, Chunk>();
  private readonly terrain: TerrainGrid;
  /** Chunks baked so far. Read by tools/render-check.ts; nothing else. */
  bakes = 0;

  constructor(terrain: TerrainGrid) {
    this.terrain = terrain;
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera): void {
    const b = cam.bounds();
    const cx0 = Math.max(0, Math.floor(b.x0 / CHUNK_WORLD));
    const cy0 = Math.max(0, Math.floor(b.y0 / CHUNK_WORLD));
    const cx1 = Math.min(
      Math.ceil(this.terrain.worldWidth / CHUNK_WORLD) - 1,
      Math.floor(b.x1 / CHUNK_WORLD),
    );
    const cy1 = Math.min(
      Math.ceil(this.terrain.worldHeight / CHUNK_WORLD) - 1,
      Math.floor(b.y1 / CHUNK_WORLD),
    );

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const chunk = this.chunk(cx, cy);
        const sx = cam.worldToScreenX(cx * CHUNK_WORLD);
        const sy = cam.worldToScreenY(cy * CHUNK_WORLD);
        const size = CHUNK_WORLD * cam.zoom;
        // Round outward by a hair so neighbouring chunks never show a seam.
        ctx.drawImage(chunk, Math.floor(sx), Math.floor(sy), Math.ceil(size) + 1, Math.ceil(size) + 1);
      }
    }

    this.evict();
  }

  private chunk(cx: number, cy: number): HTMLCanvasElement {
    const key = cx + ":" + cy;
    const hit = this.cache.get(key);
    if (hit && hit.revision !== this.terrain.revision && !this.changedSince(cx, cy, hit.revision)) {
      // The ground moved somewhere else on the map; this chunk is still true.
      hit.revision = this.terrain.revision;
    }
    if (hit && hit.revision === this.terrain.revision) {
      // Refresh LRU position.
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.canvas;
    }
    const canvas = this.bake(cx, cy);
    this.cache.set(key, { canvas, revision: this.terrain.revision });
    return canvas;
  }

  /** Has any tile in this chunk, or on its border, changed since `revision`? */
  private changedSince(cx: number, cy: number, revision: number): boolean {
    const t = this.terrain;
    const tx0 = Math.max(0, cx * TILES_PER_CHUNK - 1);
    const ty0 = Math.max(0, cy * TILES_PER_CHUNK - 1);
    const tx1 = Math.min(t.width - 1, (cx + 1) * TILES_PER_CHUNK);
    const ty1 = Math.min(t.height - 1, (cy + 1) * TILES_PER_CHUNK);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (t.tileRevision[ty * t.width + tx] > revision) return true;
      }
    }
    return false;
  }

  private evict(): void {
    while (this.cache.size > MAX_CACHED_CHUNKS) {
      const oldest = this.cache.keys().next();
      if (oldest.done) return;
      this.cache.delete(oldest.value);
    }
  }

  private bake(cx: number, cy: number): HTMLCanvasElement {
    this.bakes++;
    const canvas = document.createElement("canvas");
    canvas.width = CHUNK_WORLD;
    canvas.height = CHUNK_WORLD;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");

    const t = this.terrain;
    const tx0 = cx * TILES_PER_CHUNK;
    const ty0 = cy * TILES_PER_CHUNK;

    for (let j = 0; j < TILES_PER_CHUNK; j++) {
      for (let i = 0; i < TILES_PER_CHUNK; i++) {
        const tx = tx0 + i;
        const ty = ty0 + j;
        if (!t.inBounds(tx, ty)) continue;

        const type = t.typeAt(tx, ty);
        const px = i * TILE_SIZE;
        const py = j * TILE_SIZE;

        ctx.fillStyle = terrainFill[type];
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);

        // Relief shading: high ground catches light, low ground sits in shadow.
        // This does most of the work of making the map readable as terrain.
        const relief = (t.elevationAt(tx, ty) - 128) / 127;
        if (relief > 0) {
          ctx.fillStyle = "rgba(255,250,235," + (relief * 0.22).toFixed(3) + ")";
        } else {
          ctx.fillStyle = "rgba(74,60,40," + (-relief * 0.16).toFixed(3) + ")";
        }
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);

        // Parchment fibre: deliberately near-invisible per tile. Anything
        // stronger reads as a checkerboard once the map is zoomed out.
        const grain = tileHash(tx, ty, 0x51ab) - 0.5;
        ctx.fillStyle = grain > 0
          ? "rgba(255,252,240," + (grain * 0.05).toFixed(3) + ")"
          : "rgba(70,58,40," + (-grain * 0.045).toFixed(3) + ")";
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);

        this.decorate(ctx, type, tx, ty, px, py);
      }
    }

    this.drawContours(ctx, tx0, ty0);
    return canvas;
  }

  private decorate(
    ctx: CanvasRenderingContext2D,
    type: number,
    tx: number,
    ty: number,
    px: number,
    py: number,
  ): void {
    if (type === 1) {
      // Forest: a few ink stipples per tile, jittered but stable.
      ctx.fillStyle = "rgba(48, 62, 36, 0.55)";
      for (let k = 0; k < 3; k++) {
        const ox = tileHash(tx, ty, 0x1000 + k) * (TILE_SIZE - 6) + 3;
        const oy = tileHash(tx, ty, 0x2000 + k) * (TILE_SIZE - 6) + 3;
        ctx.beginPath();
        ctx.arc(px + ox, py + oy, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (type === 3) {
      // Water: horizontal hatching, the standard map convention.
      ctx.strokeStyle = "rgba(60, 96, 120, 0.32)";
      ctx.lineWidth = 1;
      const rows = 2;
      for (let k = 0; k < rows; k++) {
        const oy = py + ((k + 0.5) * TILE_SIZE) / rows;
        const inset = tileHash(tx, ty, 0x3000 + k) * 10;
        ctx.beginPath();
        ctx.moveTo(px + inset, oy);
        ctx.lineTo(px + TILE_SIZE - inset * 0.5, oy);
        ctx.stroke();
      }
    } else if (type === 6) {
      // Mountains get hatched peaks, the map convention, so impassable rock
      // never reads as merely "darker hill".
      ctx.strokeStyle = "rgba(48, 43, 38, 0.75)";
      ctx.lineWidth = 1.2;
      for (let k = 0; k < 2; k++) {
        const ox = px + 6 + k * 12;
        const oy = py + TILE_SIZE - 6;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(ox + 5, oy - 13);
        ctx.lineTo(ox + 10, oy);
        ctx.stroke();
      }
    } else if (type === 7) {
      // Marsh: tussock dashes, the standard wetland mark.
      ctx.strokeStyle = "rgba(58, 76, 48, 0.5)";
      ctx.lineWidth = 1;
      for (let k = 0; k < 3; k++) {
        const ox = px + tileHash(tx, ty, 0x4000 + k) * (TILE_SIZE - 10) + 3;
        const oy = py + tileHash(tx, ty, 0x5000 + k) * (TILE_SIZE - 8) + 4;
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(ox + 7, oy);
        ctx.stroke();
      }
    } else if (type === 9) {
      // Scree: scattered stones.
      ctx.fillStyle = "rgba(70, 62, 52, 0.45)";
      for (let k = 0; k < 4; k++) {
        const ox = px + tileHash(tx, ty, 0x6000 + k) * (TILE_SIZE - 5) + 2;
        const oy = py + tileHash(tx, ty, 0x7000 + k) * (TILE_SIZE - 5) + 2;
        ctx.fillRect(ox, oy, 2, 2);
      }
    } else if (type === 8) {
      // Road: a dashed centre line, so it reads as a route rather than a field.
      ctx.strokeStyle = "rgba(120, 98, 62, 0.4)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, py + TILE_SIZE / 2);
      ctx.lineTo(px + TILE_SIZE, py + TILE_SIZE / 2);
      ctx.stroke();
    } else if (type === 10 || type === 11 || type === 12) {
      this.decorateCurtain(ctx, type, tx, ty, px, py);
    } else if (type === 13) {
      // Rubble: tumbled blocks, drawn as small ink-edged squares at odd angles
      // so a breach reads as broken stone, not as a field that happens to be
      // grey.
      ctx.fillStyle = "rgba(118, 108, 92, 0.75)";
      ctx.strokeStyle = "rgba(63, 53, 39, 0.55)";
      ctx.lineWidth = 0.8;
      for (let k = 0; k < 5; k++) {
        const ox = px + tileHash(tx, ty, 0x8000 + k) * (TILE_SIZE - 8) + 2;
        const oy = py + tileHash(tx, ty, 0x9000 + k) * (TILE_SIZE - 8) + 2;
        const sz = 3 + tileHash(tx, ty, 0xa000 + k) * 4;
        ctx.save();
        ctx.translate(ox + sz / 2, oy + sz / 2);
        ctx.rotate(tileHash(tx, ty, 0xb000 + k) * Math.PI);
        ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
        ctx.strokeRect(-sz / 2, -sz / 2, sz, sz);
        ctx.restore();
      }
    } else if (type === 14) {
      // A clearing: stumps -- a ring with a dot, the map mark for felled wood
      // -- and a smudge of ash.
      ctx.fillStyle = "rgba(70, 62, 52, 0.12)";
      ctx.beginPath();
      ctx.arc(px + TILE_SIZE / 2, py + TILE_SIZE / 2, TILE_SIZE * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(72, 56, 36, 0.6)";
      ctx.fillStyle = "rgba(72, 56, 36, 0.6)";
      ctx.lineWidth = 0.9;
      for (let k = 0; k < 2; k++) {
        const ox = px + tileHash(tx, ty, 0x1000 + k) * (TILE_SIZE - 8) + 4;
        const oy = py + tileHash(tx, ty, 0x2000 + k) * (TILE_SIZE - 8) + 4;
        ctx.beginPath();
        ctx.arc(ox, oy, 2.2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillRect(ox - 0.5, oy - 0.5, 1, 1);
      }
    } else if (type === 4) {
      // Bridge: planking across the span.
      ctx.strokeStyle = "rgba(72, 55, 36, 0.5)";
      ctx.lineWidth = 1;
      for (let k = 0; k < 4; k++) {
        const ox = px + (k + 0.5) * (TILE_SIZE / 4);
        ctx.beginPath();
        ctx.moveTo(ox, py + 2);
        ctx.lineTo(ox, py + TILE_SIZE - 2);
        ctx.stroke();
      }
    }
  }

  /**
   * Walls, gates and palisades, drawn as the map convention for works: a
   * heavy ink face on every side that does not continue the curtain, with
   * crenels on stone, stakes on timber, and planks and bands on a gate. Drawn
   * against its neighbours, which is why a chunk re-bakes when the tile
   * beside it falls.
   */
  private decorateCurtain(
    ctx: CanvasRenderingContext2D,
    type: number,
    tx: number,
    ty: number,
    px: number,
    py: number,
  ): void {
    const t = this.terrain;
    const s = TILE_SIZE;
    const curtain = (x: number, y: number): boolean => {
      const k = t.typeAt(x, y);
      return k === 10 || k === 11 || k === 12;
    };
    if (type === 12) {
      // Stakes: a row of ink circles along the run of the stockade.
      ctx.fillStyle = "rgba(92, 70, 42, 0.85)";
      ctx.strokeStyle = "rgba(52, 40, 24, 0.8)";
      ctx.lineWidth = 0.9;
      for (let k = 0; k < 4; k++) {
        for (let j = 0; j < 2; j++) {
          const ox = px + (k + 0.5) * (s / 4);
          const oy = py + (j + 0.5) * (s / 2);
          ctx.beginPath();
          ctx.arc(ox, oy, 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    } else if (type === 11) {
      // A gate: planks one way, two iron bands the other.
      ctx.strokeStyle = "rgba(48, 34, 20, 0.7)";
      ctx.lineWidth = 1;
      for (let k = 1; k < 4; k++) {
        ctx.beginPath();
        ctx.moveTo(px + (k * s) / 4, py + 2);
        ctx.lineTo(px + (k * s) / 4, py + s - 2);
        ctx.stroke();
      }
      ctx.strokeStyle = "rgba(40, 38, 36, 0.85)";
      ctx.lineWidth = 2;
      for (const f of [0.3, 0.7]) {
        ctx.beginPath();
        ctx.moveTo(px + 2, py + s * f);
        ctx.lineTo(px + s - 2, py + s * f);
        ctx.stroke();
      }
    } else {
      // Dressed stone: courses of ashlar, offset row to row.
      ctx.strokeStyle = "rgba(60, 54, 46, 0.45)";
      ctx.lineWidth = 0.8;
      for (let row = 0; row < 3; row++) {
        const y = py + ((row + 1) * s) / 4;
        ctx.beginPath();
        ctx.moveTo(px, y);
        ctx.lineTo(px + s, y);
        const off = row % 2 === 0 ? s / 4 : s / 2;
        for (let x = px + off; x < px + s; x += s / 2) {
          ctx.moveTo(x, y - s / 4);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    // The face: heavy ink wherever the curtain ends, with crenels on stone.
    ctx.strokeStyle = "rgba(40, 33, 24, 0.9)";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    const faces: [boolean, number, number, number, number][] = [
      [!curtain(tx, ty - 1), px, py, px + s, py],
      [!curtain(tx, ty + 1), px, py + s, px + s, py + s],
      [!curtain(tx - 1, ty), px, py, px, py + s],
      [!curtain(tx + 1, ty), px + s, py, px + s, py + s],
    ];
    for (const [open, x0, y0, x1, y1] of faces) {
      if (!open) continue;
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    ctx.stroke();
    if (type === 10) {
      ctx.fillStyle = "rgba(40, 33, 24, 0.85)";
      for (const [open, x0, y0, x1, y1] of faces) {
        if (!open) continue;
        for (let k = 0; k < 4; k += 2) {
          const f0 = (k + 0.5) / 4;
          const cx = x0 + (x1 - x0) * f0;
          const cy = y0 + (y1 - y0) * f0;
          ctx.fillRect(cx - 2.5, cy - 2.5, 5, 5);
        }
      }
    }
  }

  /**
   * Topographic contour lines: ink an edge wherever adjacent tiles fall in
   * different elevation bands. Cheap, and it does more to make high ground
   * legible than any amount of shading.
   */
  private drawContours(ctx: CanvasRenderingContext2D, tx0: number, ty0: number): void {
    const t = this.terrain;
    const band = 24;
    ctx.strokeStyle = "rgba(92, 72, 44, 0.42)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let j = 0; j < TILES_PER_CHUNK; j++) {
      for (let i = 0; i < TILES_PER_CHUNK; i++) {
        const tx = tx0 + i;
        const ty = ty0 + j;
        if (!t.inBounds(tx, ty)) continue;
        const e = (t.elevationAt(tx, ty) / band) | 0;
        const px = i * TILE_SIZE;
        const py = j * TILE_SIZE;
        if (t.inBounds(tx + 1, ty) && ((t.elevationAt(tx + 1, ty) / band) | 0) !== e) {
          ctx.moveTo(px + TILE_SIZE, py);
          ctx.lineTo(px + TILE_SIZE, py + TILE_SIZE);
        }
        if (t.inBounds(tx, ty + 1) && ((t.elevationAt(tx, ty + 1) / band) | 0) !== e) {
          ctx.moveTo(px, py + TILE_SIZE);
          ctx.lineTo(px + TILE_SIZE, py + TILE_SIZE);
        }
      }
    }
    ctx.stroke();
  }
}
