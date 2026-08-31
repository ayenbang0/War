/**
 * Draws world state. Never mutates it -- the renderer is a pure function of
 * (world, camera, interpolation alpha), which is what keeps the sim headless.
 *
 * Units render as wargame counters rather than little men: a rounded chit in
 * the player's colour with a facing chevron. Phase 1 replaces the chit with the
 * squad's actual soldiers standing in formation.
 */

import type { World, Unit } from "../sim/world.ts";
import { TerrainGrid, TILE_SIZE } from "../sim/terrain.ts";
import { Camera } from "./camera.ts";
import { TerrainLayer } from "./terrain-layer.ts";
import { ink, inkFaint, inkSoft, parchment, playerColor, playerColorSoft } from "./palette.ts";

/** Map grid drawn every N tiles, like the reference squares on a paper map. */
const GRID_TILES = 8;

export type RenderSnapshot = Map<number, { x: number; y: number; facing: number }>;

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly terrainLayer: TerrainLayer;

  constructor(ctx: CanvasRenderingContext2D, terrain: TerrainGrid) {
    this.ctx = ctx;
    this.terrainLayer = new TerrainLayer(terrain);
  }

  draw(world: World, cam: Camera, prev: RenderSnapshot, alpha: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = parchment;
    ctx.fillRect(0, 0, cam.viewW, cam.viewH);

    this.terrainLayer.draw(ctx, cam);
    this.drawGrid(world.terrain, cam);
    this.drawWorldEdge(world.terrain, cam);

    for (const unit of world.units) this.drawPath(unit, cam);
    for (const unit of world.units) this.drawUnit(unit, cam, prev, alpha);
  }

  /** Hairline reference grid, drawn live so it stays crisp at any zoom. */
  private drawGrid(terrain: TerrainGrid, cam: Camera): void {
    const ctx = this.ctx;
    const step = GRID_TILES * TILE_SIZE;
    const b = cam.bounds();
    ctx.strokeStyle = inkFaint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x0 = Math.max(0, Math.floor(b.x0 / step) * step);
    const x1 = Math.min(terrain.worldWidth, b.x1);
    for (let wx = x0; wx <= x1; wx += step) {
      const sx = Math.floor(cam.worldToScreenX(wx)) + 0.5;
      ctx.moveTo(sx, cam.worldToScreenY(0));
      ctx.lineTo(sx, cam.worldToScreenY(terrain.worldHeight));
    }
    const y0 = Math.max(0, Math.floor(b.y0 / step) * step);
    const y1 = Math.min(terrain.worldHeight, b.y1);
    for (let wy = y0; wy <= y1; wy += step) {
      const sy = Math.floor(cam.worldToScreenY(wy)) + 0.5;
      ctx.moveTo(cam.worldToScreenX(0), sy);
      ctx.lineTo(cam.worldToScreenX(terrain.worldWidth), sy);
    }
    ctx.stroke();
  }

  private drawWorldEdge(terrain: TerrainGrid, cam: Camera): void {
    const ctx = this.ctx;
    ctx.strokeStyle = inkSoft;
    ctx.lineWidth = 2;
    ctx.strokeRect(
      cam.worldToScreenX(0),
      cam.worldToScreenY(0),
      terrain.worldWidth * cam.zoom,
      terrain.worldHeight * cam.zoom,
    );
  }

  /** Remaining route as a dashed ink line with a terminus tick. */
  private drawPath(unit: Unit, cam: Camera): void {
    if (unit.path.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = playerColor[unit.player] ?? ink;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(cam.worldToScreenX(unit.x), cam.worldToScreenY(unit.y));
    for (let i = 0; i < unit.path.length; i += 2) {
      ctx.lineTo(cam.worldToScreenX(unit.path[i]), cam.worldToScreenY(unit.path[i + 1]));
    }
    ctx.stroke();
    ctx.setLineDash([]);
    const ex = cam.worldToScreenX(unit.path[unit.path.length - 2]);
    const ey = cam.worldToScreenY(unit.path[unit.path.length - 1]);
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(ex - 5, ey);
    ctx.lineTo(ex + 5, ey);
    ctx.moveTo(ex, ey - 5);
    ctx.lineTo(ex, ey + 5);
    ctx.stroke();
    ctx.restore();
  }

  private drawUnit(unit: Unit, cam: Camera, prev: RenderSnapshot, alpha: number): void {
    const ctx = this.ctx;
    const p = prev.get(unit.id);
    // Interpolate between the last two sim states so 20 Hz reads as smooth at 60 fps.
    const wx = p ? p.x + (unit.x - p.x) * alpha : unit.x;
    const wy = p ? p.y + (unit.y - p.y) * alpha : unit.y;
    const facing = p ? p.facing + shortestArc(p.facing, unit.facing) * alpha : unit.facing;

    const sx = cam.worldToScreenX(wx);
    const sy = cam.worldToScreenY(wy);
    // Cull generously -- counters are small but the margin is cheap.
    if (sx < -60 || sy < -60 || sx > cam.viewW + 60 || sy > cam.viewH + 60) return;

    const r = Math.max(6, 13 * cam.zoom);
    const color = playerColor[unit.player] ?? ink;

    ctx.save();
    ctx.translate(sx, sy);

    // Footprint wash.
    ctx.fillStyle = playerColorSoft[unit.player] ?? inkFaint;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(facing);

    // Counter body.
    ctx.fillStyle = color;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.25;
    roundedRect(ctx, -r, -r * 0.72, r * 2, r * 1.44, Math.max(1.5, r * 0.22));
    ctx.fill();
    ctx.stroke();

    // Facing chevron on the leading edge.
    ctx.fillStyle = "rgba(255, 248, 232, 0.92)";
    ctx.beginPath();
    ctx.moveTo(r * 0.92, 0);
    ctx.lineTo(r * 0.22, -r * 0.44);
    ctx.lineTo(r * 0.22, r * 0.44);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }
}

function shortestArc(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
