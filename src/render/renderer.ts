/**
 * Draws world state. Never mutates it -- the renderer is a pure function of
 * (world, camera, interpolation alpha), which is what keeps the sim headless.
 *
 * Soldiers are drawn as individual marks when the camera is close enough for
 * them to read, and as a single counter when it is not. That is not only a
 * performance decision: 460 two-pixel dots at low zoom is visual noise, while
 * one counter per squad is exactly how a map table represents a unit.
 */

import type { World, Squad } from "../sim/world.ts";
import { TerrainGrid, TILE_SIZE } from "../sim/terrain.ts";
import { Camera } from "./camera.ts";
import { TerrainLayer } from "./terrain-layer.ts";
import { ink, inkFaint, inkSoft, parchment, playerColor, playerColorSoft } from "./palette.ts";
import { RECOVER_LOCK_SECONDS, TICK_RATE } from "../sim/world.ts";
import { UNIT_TYPES } from "../content/unit-types.ts";
import { FOG_CELL } from "../sim/vision.ts";

/** Matches the recover gesture ink, so the order and its aftermath read alike. */
const RECOVER_COLOR = "#9c3f63";

/** Map grid drawn every N tiles, like the reference squares on a paper map. */
const GRID_TILES = 8;
/** Below this zoom, individual soldiers stop reading and become a counter. */
const SOLDIER_LOD_ZOOM = 0.55;
/** Amplitude of the idle fidget, in world units, per sine term. */
const WANDER = 1.15;
/** Fraction of an attack interval spent visibly swinging. */
const LUNGE_WINDOW = 0.3;
/** How far a soldier throws itself forward mid-blow, in world units. */
const LUNGE_REACH = 5.5;

export type SoldierSnapshot = { x: Float64Array; y: Float64Array; facing: Float64Array };
export type SquadSnapshot = Map<number, { x: number; y: number; facing: number }>;

export type Snapshot = { soldiers: SoldierSnapshot; squads: SquadSnapshot };

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
    /** Render clock in seconds; drives idle wander and attack lunges. */
    now = 0,
    /** Whose eyes we are looking through. */
    viewer = 0,
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = parchment;
    ctx.fillRect(0, 0, cam.viewW, cam.viewH);

    this.terrainLayer.draw(ctx, cam);
    this.drawGrid(world.terrain, cam);
    this.drawWorldEdge(world.terrain, cam);

    // Only your own orders are on the board; you cannot read an enemy's plan.
    for (const q of world.squads) {
      if (q.player === viewer) this.drawOrder(q, cam, prev, alpha, world.tick);
    }
    for (const q of world.squads) {
      if (selected.includes(q.id)) this.drawSelection(q, cam, prev, alpha);
    }

    if (cam.zoom >= SOLDIER_LOD_ZOOM) this.drawSoldiers(world, cam, prev, alpha, now, viewer);
    else {
      for (const q of world.squads) {
        if (q.player === viewer || q.seenBy[viewer]) this.drawCounter(q, cam, prev, alpha);
      }
    }

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

  /** Interpolated squad anchor, so 20 Hz reads as smooth at display rate. */
  private anchor(q: Squad, prev: Snapshot, alpha: number): { x: number; y: number; f: number } {
    const p = prev.squads.get(q.id);
    if (!p) return { x: q.anchorX, y: q.anchorY, f: q.facing };
    return {
      x: p.x + (q.anchorX - p.x) * alpha,
      y: p.y + (q.anchorY - p.y) * alpha,
      f: p.facing + shortestArc(p.facing, q.facing) * alpha,
    };
  }

  private drawSelection(q: Squad, cam: Camera, prev: Snapshot, alpha: number): void {
    const ctx = this.ctx;
    const a = this.anchor(q, prev, alpha);
    const sx = cam.worldToScreenX(a.x);
    const sy = cam.worldToScreenY(a.y);
    const r = (q.radius + 14) * cam.zoom;
    ctx.save();
    ctx.strokeStyle = playerColor[q.player] ?? ink;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(10, r), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Individual soldiers. Batched into one path per player and filled once:
   * 460 separate fill+stroke pairs would cost more than the entire rest of the
   * frame, and every mark is the same colour anyway.
   */
  private drawSoldiers(
    world: World,
    cam: Camera,
    prev: Snapshot,
    alpha: number,
    now: number,
    viewer: number,
  ): void {
    const ctx = this.ctx;
    const s = world.soldiers;
    const size = Math.max(2.2, 4.2 * cam.zoom);
    const b = cam.bounds();
    const margin = 80;

    for (const player of [0, 1]) {
      ctx.beginPath();
      for (const q of world.squads) {
        if (q.player !== player) continue;
        // Enemies are drawn only while actually observed.
        if (q.player !== viewer && !q.seenBy[viewer]) continue;
        if (q.anchorX < b.x0 - q.radius - margin || q.anchorX > b.x1 + q.radius + margin) continue;
        if (q.anchorY < b.y0 - q.radius - margin || q.anchorY > b.y1 + q.radius + margin) continue;

        const spec = UNIT_TYPES[q.type];
        // A settled squad fidgets. Standing perfectly still reads as a
        // screenshot, and the spec asks for troops that look alive.
        const settled = q.stance === "idle" || q.stance === "hold" || q.stance === "recover";

        for (let i = 0; i < q.count; i++) {
          const id = q.first + i;
          if (s.alive[id] !== 1) continue;
          const px = prev.soldiers.x[id];
          const py = prev.soldiers.y[id];
          const pf = prev.soldiers.facing[id];
          let wx = px + (s.x[id] - px) * alpha;
          let wy = py + (s.y[id] - py) * alpha;
          let f = pf + shortestArc(pf, s.facing[id]) * alpha;

          // Idle wander. Deliberately RENDER-ONLY: nudging real positions would
          // feed back into separation, cohesion, combat ranges and the state
          // hash, so a purely cosmetic fidget would end up costing determinism
          // and shaking formations apart. Two out-of-phase sines per axis, keyed
          // off the soldier index, give an unsynchronised drift for free.
          if (settled) {
            const k = id * 0.618;
            wx += (Math.sin(now * 0.6 + k) + Math.sin(now * 0.37 + k * 2.1)) * WANDER;
            wy += (Math.cos(now * 0.53 + k * 1.7) + Math.cos(now * 0.41 + k)) * WANDER;
            f += Math.sin(now * 0.31 + k * 3.3) * 0.14;
          }

          // Attack lunge. cooldown is reset to the full interval the instant a
          // blow lands, so a freshly-struck soldier has a near-full cooldown --
          // that is the animation trigger, with no extra sim state to carry.
          const phase = s.cooldown[id] / Math.max(spec.attackInterval, 1e-6);
          if (phase > 1 - LUNGE_WINDOW) {
            const swing = (phase - (1 - LUNGE_WINDOW)) / LUNGE_WINDOW;
            const push = Math.sin(swing * Math.PI) * LUNGE_REACH;
            wx += Math.cos(f) * push;
            wy += Math.sin(f) * push;
          }

          const sx = cam.worldToScreenX(wx);
          const sy = cam.worldToScreenY(wy);
          const c = Math.cos(f);
          const sf = Math.sin(f);
          // A stubby chevron: enough to read facing at four pixels.
          ctx.moveTo(sx + c * size, sy + sf * size);
          ctx.lineTo(sx - c * size * 0.7 - sf * size * 0.75, sy - sf * size * 0.7 + c * size * 0.75);
          ctx.lineTo(sx - c * size * 0.25, sy - sf * size * 0.25);
          ctx.lineTo(sx - c * size * 0.7 + sf * size * 0.75, sy - sf * size * 0.7 - c * size * 0.75);
          ctx.closePath();
        }
      }
      ctx.fillStyle = playerColor[player] ?? ink;
      ctx.fill();
      if (cam.zoom > 1.1) {
        ctx.strokeStyle = "rgba(35, 28, 18, 0.55)";
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
    }
  }

  /** Zoomed-out stand-in: one wargame counter per squad. */
  /**
   * Workings on the field: a slow ring of the caster's colour, warm for the
   * ones that help you and cold for the ones that do not. Drawn under the fog
   * so a hex you have not spotted stays hidden.
   */
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
      ctx.globalAlpha = 0.32 * fade * pulse;
      ctx.fillStyle = friendly ? "#5b7a5b" : "#7a4a68";
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.7 * fade;
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

  private drawFog(world: World, cam: Camera, viewer: number): void {
    const fog = world.fog[viewer];
    paintFog(
      this.ctx,
      cam,
      (x, y) => fog.at(x, y),
      world.terrain.worldWidth,
      world.terrain.worldHeight,
    );
  }

  private drawCounter(q: Squad, cam: Camera, prev: Snapshot, alpha: number): void {
    const ctx = this.ctx;
    const a = this.anchor(q, prev, alpha);
    const sx = cam.worldToScreenX(a.x);
    const sy = cam.worldToScreenY(a.y);
    if (sx < -60 || sy < -60 || sx > cam.viewW + 60 || sy > cam.viewH + 60) return;

    const r = Math.max(5, q.radius * cam.zoom * 0.8);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.fillStyle = playerColorSoft[q.player] ?? inkFaint;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.3, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(a.f);
    ctx.fillStyle = playerColor[q.player] ?? ink;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(-r * 0.85, -r * 0.6, r * 1.7, r * 1.2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 248, 232, 0.9)";
    ctx.beginPath();
    ctx.moveTo(r * 0.8, 0);
    ctx.lineTo(r * 0.15, -r * 0.38);
    ctx.lineTo(r * 0.15, r * 0.38);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * What each squad has been told to do, drawn on the map in ink.
   *
   * Every order kind gets a distinct mark so a glance at the board reads as a
   * plan rather than a pile of lines: routes are dashed with an arrowhead,
   * attacks are solid and end in a cross, hold is a ring on the ground, patrol
   * is a closed circuit, retreat is chevroned backwards.
   */
  private drawOrder(q: Squad, cam: Camera, prev: Snapshot, alpha: number, tick: number): void {
    if (q.stance === "idle") return;
    const ctx = this.ctx;
    const a = this.anchor(q, prev, alpha);
    const color = playerColor[q.player] ?? ink;

    // A recovering squad is helpless for a fixed term, which is the whole cost
    // of the gesture. Draw the remaining term as a closing arc so the exposure
    // is impossible to lose track of.
    if (q.stance === "recover") {
      const left = Math.max(0, q.recoverUntil - tick) / (RECOVER_LOCK_SECONDS * TICK_RATE);
      const sx = cam.worldToScreenX(a.x);
      const sy = cam.worldToScreenY(a.y);
      const r = Math.max(14, (q.radius + 20) * cam.zoom);
      ctx.save();
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

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = 0.55;

    if (q.stance === "hold") {
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.arc(
        cam.worldToScreenX(q.holdX),
        cam.worldToScreenY(q.holdY),
        Math.max(8, q.holdRadius * cam.zoom),
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }

    if (q.stance === "patrol" && q.patrol.length >= 4) {
      ctx.setLineDash([9, 6]);
      ctx.beginPath();
      ctx.moveTo(cam.worldToScreenX(q.patrol[0]), cam.worldToScreenY(q.patrol[1]));
      for (let i = 2; i < q.patrol.length; i += 2) {
        ctx.lineTo(cam.worldToScreenX(q.patrol[i]), cam.worldToScreenY(q.patrol[i + 1]));
      }
      ctx.closePath();
      ctx.stroke();
    }

    if (q.path.length >= 2) {
      ctx.setLineDash(q.stance === "attack" ? [] : [7, 5]);
      ctx.beginPath();
      ctx.moveTo(cam.worldToScreenX(a.x), cam.worldToScreenY(a.y));
      for (let i = 0; i < q.path.length; i += 2) {
        ctx.lineTo(cam.worldToScreenX(q.path[i]), cam.worldToScreenY(q.path[i + 1]));
      }
      ctx.stroke();
      ctx.setLineDash([]);

      const ex = cam.worldToScreenX(q.path[q.path.length - 2]);
      const ey = cam.worldToScreenY(q.path[q.path.length - 1]);
      const px = q.path.length >= 4 ? cam.worldToScreenX(q.path[q.path.length - 4]) : cam.worldToScreenX(a.x);
      const py = q.path.length >= 4 ? cam.worldToScreenY(q.path[q.path.length - 3]) : cam.worldToScreenY(a.y);
      const heading = Math.atan2(ey - py, ex - px);
      ctx.globalAlpha = 0.8;
      if (q.stance === "attack") crossMark(ctx, ex, ey, 6);
      else if (q.stance === "retreat") chevron(ctx, ex, ey, heading + Math.PI, 7);
      else arrowHead(ctx, ex, ey, heading, 7);
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

/**
 * Fog, painted over everything else.
 *
 * Three states, and the middle one matters: ground you have never seen is
 * fully dark, ground you saw earlier is dimmed but readable, and ground you
 * currently observe is clear. Remembering terrain while forgetting what stands
 * on it is what makes scouting worth doing -- otherwise the map is either a
 * mystery forever or solved once and never again.
 */
function paintFog(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  fogAt: (x: number, y: number) => number,
  worldW: number,
  worldH: number,
): void {
  const b = cam.bounds();
  const x0 = Math.max(0, Math.floor(b.x0 / FOG_CELL) * FOG_CELL);
  const y0 = Math.max(0, Math.floor(b.y0 / FOG_CELL) * FOG_CELL);
  const x1 = Math.min(worldW, b.x1 + FOG_CELL);
  const y1 = Math.min(worldH, b.y1 + FOG_CELL);
  const size = Math.ceil(FOG_CELL * cam.zoom) + 1;

  ctx.save();
  for (let wy = y0; wy < y1; wy += FOG_CELL) {
    for (let wx = x0; wx < x1; wx += FOG_CELL) {
      const state = fogAt(wx + 1, wy + 1);
      if (state === 1) continue;
      ctx.fillStyle = state === 2 ? "rgba(58, 48, 34, 0.30)" : "rgba(44, 37, 26, 0.78)";
      ctx.fillRect(
        Math.floor(cam.worldToScreenX(wx)),
        Math.floor(cam.worldToScreenY(wy)),
        size,
        size,
      );
    }
  }
  ctx.restore();
}
