/**
 * Draws world state. Never mutates it -- the renderer is a pure function of
 * (world, camera, interpolation alpha), which is what keeps the sim headless.
 *
 * Soldiers are drawn individually, each with its own type's silhouette, gait
 * and weapon animation. Bodies are batched per (player, type) and filled in one
 * pass; ornament is stroked in a second. Doing a fill+stroke per soldier would
 * cost more than the rest of the frame put together.
 */

import type { World } from "../sim/world.ts";
import type { Group } from "../sim/entities.ts";
import { TerrainGrid, TILE_SIZE } from "../sim/terrain.ts";
import { Camera } from "./camera.ts";
import { TerrainLayer } from "./terrain-layer.ts";
import { ink, inkFaint, inkSoft, parchment, playerColor } from "./palette.ts";
import { FOG_CELL } from "../sim/vision.ts";
import { RECOVER_LOCK_SECONDS, TICK_RATE } from "../sim/world.ts";
import { UNIT_TYPE_IDS } from "../content/unit-types.ts";
import { SIZE, bodyPath, detailPath, gait, type Brush } from "./soldier-art.ts";

const GRID_TILES = 8;
/** Below this zoom individual soldiers stop reading and become blocks. */
const SOLDIER_LOD_ZOOM = 0.4;
/** Below this zoom, groups get a halo so bodies of troops stay findable. */
const GROUP_HALO_ZOOM = 0.75;
/** Amplitude of the idle fidget, in world units, per sine term. */
const WANDER = 1.15;
const RECOVER_COLOR = "#9c3f63";

export type Snapshot = { x: Float64Array; y: Float64Array; facing: Float64Array };

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly terrainLayer: TerrainLayer;

  constructor(ctx: CanvasRenderingContext2D, terrain: TerrainGrid) {
    this.ctx = ctx;
    this.terrainLayer = new TerrainLayer(terrain);
  }

  draw(
    world: World,
    cam: Camera,
    prev: Snapshot,
    alpha: number,
    selected: readonly number[],
    now: number,
    viewer: number,
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = parchment;
    ctx.fillRect(0, 0, cam.viewW, cam.viewH);

    this.terrainLayer.draw(ctx, cam);
    this.drawGrid(world.terrain, cam);

    // Only your own orders are on the board; you cannot read an enemy's plan.
    for (const g of world.groups) {
      if (g.player === viewer) this.drawOrder(g, cam, world.tick);
    }
    for (const g of world.groups) {
      if (selected.includes(g.id)) this.drawSelection(g, cam);
    }

    // Zoomed out far enough that individual men are a smear, groups get a
    // halo. Both armies: knowing roughly where an enemy body of troops is, once
    // you have seen it, is the whole reason to pull the camera back.
    if (cam.zoom < GROUP_HALO_ZOOM) this.drawGroupHalos(world, cam, viewer);
    this.drawSoldiers(world, cam, prev, alpha, now);
    this.drawWorkings(world, cam, viewer, now);
    this.drawFog(world, cam, viewer);
  }

  private drawGrid(terrain: TerrainGrid, cam: Camera): void {
    const ctx = this.ctx;
    const step = GRID_TILES * TILE_SIZE;
    const b = cam.bounds();
    ctx.strokeStyle = inkFaint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let wx = Math.max(0, Math.floor(b.x0 / step) * step); wx <= Math.min(terrain.worldWidth, b.x1); wx += step) {
      const sx = Math.floor(cam.worldToScreenX(wx)) + 0.5;
      ctx.moveTo(sx, cam.worldToScreenY(0));
      ctx.lineTo(sx, cam.worldToScreenY(terrain.worldHeight));
    }
    for (let wy = Math.max(0, Math.floor(b.y0 / step) * step); wy <= Math.min(terrain.worldHeight, b.y1); wy += step) {
      const sy = Math.floor(cam.worldToScreenY(wy)) + 0.5;
      ctx.moveTo(cam.worldToScreenX(0), sy);
      ctx.lineTo(cam.worldToScreenX(terrain.worldWidth), sy);
    }
    ctx.stroke();
    ctx.strokeStyle = inkSoft;
    ctx.lineWidth = 2;
    ctx.strokeRect(
      cam.worldToScreenX(0), cam.worldToScreenY(0),
      terrain.worldWidth * cam.zoom, terrain.worldHeight * cam.zoom,
    );
  }

  private drawSelection(g: Group, cam: Camera): void {
    const ctx = this.ctx;
    const sx = cam.worldToScreenX(g.anchorX);
    const sy = cam.worldToScreenY(g.anchorY);
    ctx.save();
    ctx.strokeStyle = playerColor[g.player] ?? ink;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(12, (g.radius + 16) * cam.zoom), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Every soldier, batched by (player, type).
   *
   * Batching matters: a fill and a stroke per soldier at several hundred
   * soldiers costs more than everything else on the frame combined. Bodies of
   * one type go into one path and fill once; ornament -- bows, lances, staves,
   * wheels -- strokes once more.
   */
  private drawSoldiers(
    world: World, cam: Camera, prev: Snapshot, alpha: number, now: number,
  ): void {
    const ctx = this.ctx;
    const s = world.soldiers;
    const b = cam.bounds();
    const m = 60 / cam.zoom;
    const detailed = cam.zoom >= SOLDIER_LOD_ZOOM;

    for (const player of [0, 1]) {
      for (const type of UNIT_TYPE_IDS) {
        const base = Math.max(1.6, 4.6 * cam.zoom * SIZE[type]);
        const shown: number[] = [];
        for (let id = 0; id < s.count; id++) {
          if (s.alive[id] !== 1 || s.player[id] !== player) continue;
          if (world.typeOf(id) !== type) continue;
          if (s.x[id] < b.x0 - m || s.x[id] > b.x1 + m) continue;
          if (s.y[id] < b.y0 - m || s.y[id] > b.y1 + m) continue;
          shown.push(id);
        }
        if (shown.length === 0) continue;

        ctx.beginPath();
        for (const id of shown) {
          const brush = this.brushFor(world, id, cam, prev, alpha, now, base);
          if (detailed) bodyPath(type, brush);
          else ctx.rect(brush.x - base * 0.6, brush.y - base * 0.6, base * 1.2, base * 1.2);
        }
        ctx.fillStyle = playerColor[player] ?? ink;
        ctx.fill();
        if (cam.zoom > 0.85) {
          ctx.strokeStyle = "rgba(35, 28, 18, 0.5)";
          ctx.lineWidth = 0.7;
          ctx.stroke();
        }

        if (!detailed || cam.zoom < 0.7) continue;
        ctx.beginPath();
        for (const id of shown) {
          detailPath(type, this.brushFor(world, id, cam, prev, alpha, now, base));
        }
        ctx.strokeStyle = "rgba(28, 22, 14, 0.72)";
        ctx.lineWidth = Math.max(0.7, base * 0.16);
        ctx.stroke();
      }
    }
  }

  /**
   * Where and how one soldier is drawn this frame.
   *
   * The wander and the gait are RENDER-ONLY. Nudging real positions would feed
   * back into separation, cohesion, combat range and the state hash, so a
   * purely cosmetic fidget would cost determinism and shake formations apart.
   */
  private brushFor(
    world: World, id: number, cam: Camera,
    prev: Snapshot, alpha: number, now: number, base: number,
  ): Brush {
    const s = world.soldiers;
    const px = prev.x[id];
    const py = prev.y[id];
    const pf = prev.facing[id];
    let wx = px + (s.x[id] - px) * alpha;
    let wy = py + (s.y[id] - py) * alpha;
    const facing = pf + shortestArc(pf, s.facing[id]) * alpha;

    const phase = id * 0.618;
    const moved = Math.abs(s.x[id] - px) + Math.abs(s.y[id] - py) > 0.05;

    if (!moved) {
      // Standing men fidget. Perfect stillness reads as a screenshot.
      wx += (Math.sin(now * 0.6 + phase) + Math.sin(now * 0.37 + phase * 2.1)) * WANDER;
      wy += (Math.cos(now * 0.53 + phase * 1.7) + Math.cos(now * 0.41 + phase)) * WANDER;
    }

    // cooldown is set to the full interval the instant a blow lands, so a high
    // cooldown means "just struck" -- the animation trigger, with no extra state.
    const st = world.stats(id);
    const recover = 1 - Math.min(1, s.cooldown[id] / Math.max(st.attackInterval, 1e-6));
    const bob = gait(world.typeOf(id), moved, now, phase);

    return {
      ctx: this.ctx,
      x: cam.worldToScreenX(wx),
      y: cam.worldToScreenY(wy) + bob * cam.zoom,
      a: facing,
      r: base,
      recover,
      t: now,
      phase,
    };
  }

  /** What each group has been told to do, drawn on the map in ink. */
  private drawOrder(g: Group, cam: Camera, tick: number): void {
    if (g.stance === "idle") return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = playerColor[g.player] ?? ink;
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = 0.55;

    if (g.stance === "recover") {
      // The remaining term of helplessness, closing like a clock. The whole
      // cost of the gesture is exposure, so it must not be easy to forget.
      const left = Math.max(0, g.recoverUntil - tick) / (RECOVER_LOCK_SECONDS * TICK_RATE);
      const sx = cam.worldToScreenX(g.anchorX);
      const sy = cam.worldToScreenY(g.anchorY);
      const r = Math.max(14, (g.radius + 20) * cam.zoom);
      ctx.strokeStyle = RECOVER_COLOR;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(sx, sy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (g.stance === "hold") {
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.arc(
        cam.worldToScreenX(g.holdX), cam.worldToScreenY(g.holdY),
        Math.max(8, g.holdRadius * cam.zoom), 0, Math.PI * 2,
      );
      ctx.stroke();
    }
    if (g.stance === "patrol" && g.patrol.length >= 4) {
      ctx.setLineDash([9, 6]);
      ctx.beginPath();
      ctx.moveTo(cam.worldToScreenX(g.patrol[0]), cam.worldToScreenY(g.patrol[1]));
      for (let i = 2; i < g.patrol.length; i += 2) {
        ctx.lineTo(cam.worldToScreenX(g.patrol[i]), cam.worldToScreenY(g.patrol[i + 1]));
      }
      ctx.closePath();
      ctx.stroke();
    }
    if (g.path.length >= 2) {
      ctx.setLineDash(g.stance === "attack" ? [] : [7, 5]);
      ctx.beginPath();
      ctx.moveTo(cam.worldToScreenX(g.anchorX), cam.worldToScreenY(g.anchorY));
      for (let i = 0; i < g.path.length; i += 2) {
        ctx.lineTo(cam.worldToScreenX(g.path[i]), cam.worldToScreenY(g.path[i + 1]));
      }
      ctx.stroke();
      ctx.setLineDash([]);
      const ex = cam.worldToScreenX(g.path[g.path.length - 2]);
      const ey = cam.worldToScreenY(g.path[g.path.length - 1]);
      const qx = g.path.length >= 4 ? cam.worldToScreenX(g.path[g.path.length - 4]) : cam.worldToScreenX(g.anchorX);
      const qy = g.path.length >= 4 ? cam.worldToScreenY(g.path[g.path.length - 3]) : cam.worldToScreenY(g.anchorY);
      const heading = Math.atan2(ey - qy, ex - qx);
      ctx.globalAlpha = 0.8;
      if (g.stance === "attack") crossMark(ctx, ex, ey, 6);
      else if (g.stance === "retreat") chevron(ctx, ex, ey, heading + Math.PI, 7);
      else arrowHead(ctx, ex, ey, heading, 7);
    }
    ctx.restore();
  }

  /**
   * A soft disc under each group, sized to the men in it.
   *
   * At low zoom a formation is a few grey pixels and armies become impossible
   * to pick out against terrain; the halo restores the thing a wargame table
   * gives you for free, which is seeing where the mass is.
   */
  private drawGroupHalos(world: World, cam: Camera, viewer: number): void {
    const ctx = this.ctx;
    ctx.save();
    // Strongest right at the point where soldiers stop being legible.
    const strength = Math.min(1, (GROUP_HALO_ZOOM - cam.zoom) / (GROUP_HALO_ZOOM - 0.25));
    for (const g of world.groups) {
      const n = world.liveCount(g);
      if (n === 0) continue;
      const sx = cam.worldToScreenX(g.anchorX);
      const sy = cam.worldToScreenY(g.anchorY);
      const r = Math.max(11, (g.radius + 22) * cam.zoom);
      if (sx < -r || sy < -r || sx > cam.viewW + r || sy > cam.viewH + r) continue;

      const grad = ctx.createRadialGradient(sx, sy, r * 0.2, sx, sy, r);
      const tint = g.player === viewer ? "59, 95, 138" : "140, 58, 52";
      grad.addColorStop(0, "rgba(" + tint + "," + (0.5 * strength).toFixed(3) + ")");
      grad.addColorStop(1, "rgba(" + tint + ", 0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();

      // A ring scaled by headcount, so a big body reads as bigger.
      ctx.globalAlpha = 0.55 * strength;
      ctx.strokeStyle = g.player === viewer ? "#3b5f8a" : "#8c3a34";
      ctx.lineWidth = Math.max(1, Math.min(3, 0.8 + n * 0.09));
      ctx.beginPath();
      ctx.arc(sx, sy, r * 0.72, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  private drawWorkings(world: World, cam: Camera, viewer: number, now: number): void {
    if (world.workings.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    for (const w of world.workings) {
      const friendly = w.player === viewer;
      const sx = cam.worldToScreenX(w.x);
      const sy = cam.worldToScreenY(w.y);
      const r = w.radius * cam.zoom;
      if (sx < -r || sy < -r || sx > cam.viewW + r || sy > cam.viewH + r) continue;
      const fade = Math.max(0, Math.min(1, (w.until - world.tick) / (TICK_RATE * 3)));
      const pulse = 0.6 + 0.4 * Math.sin(now * 1.6 + w.x * 0.01);
      ctx.globalAlpha = 0.28 * fade * pulse;
      ctx.fillStyle = friendly ? "#5b7a5b" : "#7a4a68";
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.65 * fade;
      ctx.strokeStyle = friendly ? "#456b45" : "#6b3a58";
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 6]);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  /**
   * Fog, painted over everything else. Ground once seen stays readable but dim;
   * ground never seen is dark. Remembering the terrain while forgetting what
   * stands on it is what makes scouting worth doing.
   */
  private drawFog(world: World, cam: Camera, viewer: number): void {
    const fog = world.fog[viewer];
    const ctx = this.ctx;
    const b = cam.bounds();
    const x0 = Math.max(0, Math.floor(b.x0 / FOG_CELL) * FOG_CELL);
    const y0 = Math.max(0, Math.floor(b.y0 / FOG_CELL) * FOG_CELL);
    const x1 = Math.min(world.terrain.worldWidth, b.x1 + FOG_CELL);
    const y1 = Math.min(world.terrain.worldHeight, b.y1 + FOG_CELL);
    const size = Math.ceil(FOG_CELL * cam.zoom) + 1;
    ctx.save();
    for (let wy = y0; wy < y1; wy += FOG_CELL) {
      for (let wx = x0; wx < x1; wx += FOG_CELL) {
        const state = fog.at(wx + 1, wy + 1);
        if (state === 1) continue;
        ctx.fillStyle = state === 2 ? "rgba(58, 48, 34, 0.30)" : "rgba(44, 37, 26, 0.78)";
        ctx.fillRect(
          Math.floor(cam.worldToScreenX(wx)), Math.floor(cam.worldToScreenY(wy)), size, size,
        );
      }
    }
    ctx.restore();
  }
}

export function shortestArc(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function arrowHead(ctx: CanvasRenderingContext2D, x: number, y: number, a: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - Math.cos(a - 0.4) * r * 1.6, y - Math.sin(a - 0.4) * r * 1.6);
  ctx.moveTo(x, y);
  ctx.lineTo(x - Math.cos(a + 0.4) * r * 1.6, y - Math.sin(a + 0.4) * r * 1.6);
  ctx.stroke();
}

function chevron(ctx: CanvasRenderingContext2D, x: number, y: number, a: number, r: number): void {
  for (let k = 0; k < 2; k++) {
    const ox = x + Math.cos(a) * k * r;
    const oy = y + Math.sin(a) * k * r;
    ctx.beginPath();
    ctx.moveTo(ox - Math.cos(a - 0.5) * r, oy - Math.sin(a - 0.5) * r);
    ctx.lineTo(ox, oy);
    ctx.lineTo(ox - Math.cos(a + 0.5) * r, oy - Math.sin(a + 0.5) * r);
    ctx.stroke();
  }
}

function crossMark(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x - r, y - r);
  ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r);
  ctx.lineTo(x - r, y + r);
  ctx.stroke();
}
