/**
 * Static terrain, pre-rendered into cached offscreen chunks.
 *
 * The battlefield is 6144x4096 world pixels. One offscreen canvas that size
 * would be ~100 MB, and re-filling ~16k tile rects every frame at low zoom is
 * wasteful, so terrain is baked into 512px chunks and only the visible ones are
 * kept. Chunks re-bake when TerrainGrid.revision changes, which is what makes
 * Phase 8 destructible terrain a one-line invalidation rather than a rewrite.
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

  private evict(): void {
    while (this.cache.size > MAX_CACHED_CHUNKS) {
      const oldest = this.cache.keys().next();
      if (oldest.done) return;
      this.cache.delete(oldest.value);
    }
  }

  private bake(cx: number, cy: number): HTMLCanvasElement {
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
