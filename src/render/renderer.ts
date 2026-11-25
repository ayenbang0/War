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
import { colorFor, foeKeyline, inkFaint, inkSoft, parchment, sideColor, statusColor, unitEdge, unitFill, unitSheen, unitShadow } from "./palette.ts";
import { FOG_CELL } from "../sim/vision.ts";
import { RECOVER_LOCK_SECONDS, TICK_RATE } from "../sim/world.ts";
import { COMPANY_BREAK } from "../sim/morale.ts";
import { Perception, SEEN_BEFORE, SEEN_NOW, SEEN_OBSCURED } from "./perception.ts";
import { animTime, motion } from "./motion.ts";
import { UNIT_TYPE_IDS } from "../content/unit-types.ts";
import { SIZE, bodyPath, detailPath, gait, offsetBrush, type Brush } from "./soldier-art.ts";
import { JUMP, isMoving, presenceOf } from "./presence.ts";
import { CADENCE_RADIUS, RALLY_RADIUS, TERROR_RADIUS } from "../content/specials.ts";
import { Fallen } from "./fallen.ts";

const GRID_TILES = 8;
/** Below this zoom individual soldiers stop reading and become blocks. */
const SOLDIER_LOD_ZOOM = 0.4;
/** Below this zoom, groups get a halo so bodies of troops stay findable. */
const GROUP_HALO_ZOOM = 0.75;
/**
 * How long an enemy's last-seen mark lingers before going cold, in SIM ticks
 * (audit RF-06). It used to age on the wall clock, so pausing to plan -- which
 * is what Space is for -- faded every enemy report away while nothing on the
 * field had moved. Aging on the sim clock freezes memory with the battle.
 */
const MEMORY_TICKS = 14 * TICK_RATE;
/** A mark holds full strength this long before it starts to fade. */
const MEMORY_HOLD_TICKS = TICK_RATE;
/** A mark whose ground has been in plain view, and empty, this long is withdrawn. */
const EMPTY_GROUND_TICKS = 3 * TICK_RATE;
/** Amplitude of the idle fidget, in world units, per sine term. */
const WANDER = 1.15;
const RECOVER_COLOR = statusColor.recover;
/**
 * Smallest canvas label, in CSS px (docs/ui-policy.md, "Canvas text"). Map
 * labels sit on busy ground, so they also get a parchment halo stroke.
 */
export const CANVAS_LABEL_MIN_PX = 13;

/** What the viewer last saw of an enemy company. */
type Sighting = {
  x: number; y: number; tick: number; n: number; radius: number; player: number;
  /** Tick since which the viewer has been looking at this ground and finding nobody, or -1. */
  emptySince: number;
};
/** A piece of enemy works, as last seen. */
type KnownWork = { tx: number; ty: number; kind: string; player: number };

export type Snapshot = { x: Float64Array; y: Float64Array; facing: Float64Array };

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly terrainLayer: TerrainLayer;
  /** Where each enemy group was last seen, so a lost group leaves a report
   *  behind rather than either vanishing or being tracked through the fog.
   *  Stamped and aged in sim ticks. */
  private readonly lastSeen = new Map<number, Sighting>();
  /**
   * Enemy works as last observed, keyed by tile (audit RF-05). Works in ground
   * the viewer is not looking at are drawn from here, never from the live
   * board, so an enemy's digging is learned by watching it, not for free.
   */
  private readonly knownWorks = new Map<string, KnownWork>();
  /** The dead, left where they fell. See fallen.ts. */
  readonly fallen = new Fallen();
  /** The one answer to "can the viewer see that", shared with the effects. */
  readonly perception: Perception;

  constructor(ctx: CanvasRenderingContext2D, terrain: TerrainGrid, viewer = 0) {
    this.ctx = ctx;
    this.terrainLayer = new TerrainLayer(terrain);
    this.perception = new Perception(viewer);
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
    this.perception.refresh(world, now * 1000);
    ctx.fillStyle = parchment;
    ctx.fillRect(0, 0, cam.viewW, cam.viewH);

    this.terrainLayer.draw(ctx, cam);
    this.drawGrid(world.terrain, cam);
    this.drawControlPoints(world, cam, viewer);

    // Only your own orders are on the board; you cannot read an enemy's plan.
    for (const g of world.groups) {
      if (g.player === viewer) this.drawOrder(g, cam);
    }
    for (const g of world.groups) {
      if (selected.includes(g.id)) this.drawSelection(world, g, cam, viewer);
    }

    // Zoomed out far enough that individual men are a smear, groups get a
    // halo. Both armies: knowing roughly where an enemy body of troops is, once
    // you have seen it, is the whole reason to pull the camera back.
    // The fallen fade on the sim clock too, so a pause does not age them.
    this.fallen.draw(this.ctx, cam, world, viewer, world.tick / TICK_RATE);
    this.rememberSightings(world, viewer);
    if (cam.zoom < GROUP_HALO_ZOOM) this.drawGroupHalos(world, cam, viewer);
    else this.drawLastSeen(world, cam, viewer);
    this.drawSoldiers(world, cam, prev, alpha, now, viewer);
    this.drawWorkings(world, cam, viewer, now);
    this.drawFields(world, cam, now, viewer);
    this.drawRecovering(world, cam, viewer);
    this.drawSpecials(world, cam, now, viewer, prev);
    this.drawBreaks(world, cam, viewer);
    this.drawWorks(world, cam, now, viewer);
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

  private drawSelection(world: World, g: Group, cam: Camera, viewer: number): void {
    const ctx = this.ctx;
    // Ring the men, not the anchor that walks ahead of them.
    const p = presenceOf(world, g, viewer);
    if (p.n === 0) return;
    const sx = cam.worldToScreenX(p.x);
    const sy = cam.worldToScreenY(p.y);
    ctx.save();
    ctx.strokeStyle = colorFor(g.player, viewer);
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
    world: World, cam: Camera, prev: Snapshot, alpha: number, now: number, viewer: number,
  ): void {
    const ctx = this.ctx;
    const s = world.soldiers;
    const b = cam.bounds();
    const m = 60 / cam.zoom;
    const detailed = cam.zoom >= SOLDIER_LOD_ZOOM;
    const viewerBit = viewer === 0 ? 1 : 2;

    for (const player of [0, 1]) {
      // Colour seat by side, not by seat number: your men are always the
      // friend colour, whichever side of the table you sit (RF-02).
      const seat = player === viewer ? 0 : 1;
      const foe = player !== viewer;
      for (const type of UNIT_TYPE_IDS) {
        const base = Math.max(1.6, 4.6 * cam.zoom * SIZE[type]);
        const shown: number[] = [];
        for (let id = 0; id < s.count; id++) {
          if (s.alive[id] !== 1 || s.player[id] !== player) continue;
          // YOU CANNOT SEE WHAT NOBODY IS LOOKING AT. An enemy is drawn only
          // while some man of yours actually has eyes on him -- unscouted
          // ground shows you nothing, and a screen of smoke shows you nothing.
          // Without this the fog hid only the ground, scouting bought you
          // nothing, and every counter on the map was legible from the start.
          //
          // They do not simply blink out: a company you have lost keeps a
          // fading mark where you last saw it, drawn below.
          if (player !== viewer && (s.seen[id] & viewerBit) === 0) continue;
          if (world.typeOf(id) !== type) continue;
          if (s.x[id] < b.x0 - m || s.x[id] > b.x1 + m) continue;
          if (s.y[id] < b.y0 - m || s.y[id] > b.y1 + m) continue;
          shown.push(id);
        }
        if (shown.length === 0) continue;

        // The brush is the same for all four passes, so build it once. The
        // shading passes below are the SAME bodyPath drawn from a shifted or
        // shrunken brush -- which is what guarantees the polished counter has
        // exactly the silhouette and proportions of the plain one.
        const brushes = shown.map(
          (id) => this.brushFor(world, id, cam, prev, alpha, now, base),
        );

        // 1. Contact shadow. Cheap, and it is what lifts a counter off the
        //    ground rather than letting it sit flat in the terrain wash --
        //    the single biggest gain in reading a crowded field from above.
        if (detailed && cam.zoom > 0.7) {
          ctx.beginPath();
          for (const brush of brushes) bodyPath(type, offsetBrush(brush, base * 0.16, base * 0.24));
          ctx.fillStyle = unitShadow;
          ctx.fill();
        }

        // 1b. The foe's keyline (RF-01): a pale rim round every enemy counter,
        //     at every zoom, under the body so it reads as an outer edge. It is
        //     the identity channel that survives greyscale and colour-blindness:
        //     friend counters are plain, foe counters are ringed. At strategic
        //     zoom, where silhouettes become blocks, the foe's block is also a
        //     diamond where the friend's is a square.
        if (foe) {
          ctx.beginPath();
          for (const brush of brushes) {
            if (detailed) bodyPath(type, brush);
            else diamond(ctx, brush.x, brush.y, base * 0.85);
          }
          ctx.lineJoin = "round";
          ctx.strokeStyle = foeKeyline;
          ctx.lineWidth = Math.max(1.6, base * 0.42);
          ctx.stroke();
        }

        // 2. The body itself, in this type's tone of its side's colour.
        ctx.beginPath();
        for (const brush of brushes) {
          if (detailed) bodyPath(type, brush);
          else if (foe) diamond(ctx, brush.x, brush.y, base * 0.85);
          else ctx.rect(brush.x - base * 0.6, brush.y - base * 0.6, base * 1.2, base * 1.2);
        }
        ctx.fillStyle = unitFill(seat, type);
        ctx.fill();

        // 3. Top-light, as a bevel rather than a smaller copy floating inside.
        //    Clip to the silhouette, then fill the SAME silhouette shifted
        //    toward the light: the overlap is everything but a rim on the
        //    shaded side, so the counter reads as lit from the top left and the
        //    base colour survives as a rim along the bottom right. A concentric
        //    inset instead reads as a picture frame, which is what this
        //    replaced. No gradient, because one path holds the whole batch and
        //    a gradient would be fixed in screen space rather than to a counter.
        if (detailed && cam.zoom > 0.85) {
          ctx.save();
          ctx.beginPath();
          for (const brush of brushes) bodyPath(type, brush);
          ctx.clip();
          ctx.beginPath();
          for (const brush of brushes) {
            bodyPath(type, offsetBrush(brush, -base * 0.17, -base * 0.2));
          }
          ctx.fillStyle = unitSheen;
          ctx.fill();
          ctx.restore();
        }

        // 4. The outline, derived from the fill rather than a flat black, with
        //    round joins so a wedge's point reads as drawn rather than pricked.
        //    A foe counter keeps its dark edge at every detailed zoom, inside
        //    the pale keyline: dark-in-light is the mark of the enemy.
        if (cam.zoom > 0.85 || (foe && detailed)) {
          ctx.beginPath();
          for (const brush of brushes) {
            if (detailed) bodyPath(type, brush);
            else ctx.rect(brush.x - base * 0.6, brush.y - base * 0.6, base * 1.2, base * 1.2);
          }
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.strokeStyle = unitEdge(seat, type);
          ctx.lineWidth = Math.max(0.6, base * 0.1);
          ctx.stroke();
        }

        // 5. Ornament last and quietest. It was competing with the body for
        //    attention; a weapon is meant to tell you WHICH unit this is once
        //    the counter itself has already read as a unit.
        if (!detailed || cam.zoom < 0.7) continue;
        ctx.beginPath();
        for (const brush of brushes) detailPath(type, brush);
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.strokeStyle = "rgba(31, 25, 16, 0.6)";
        ctx.lineWidth = Math.max(0.6, base * 0.13);
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
    // A man who blinked, or who has only just been raised (a levy, a landing
    // reinforcement), has a stale or zeroed previous point. Interpolating from
    // it drew him streaking in from the map corner for a frame. Snap instead.
    const jump = Math.abs(s.x[id] - px) + Math.abs(s.y[id] - py);
    const snap = jump >= JUMP;
    let wx = snap ? s.x[id] : px + (s.x[id] - px) * alpha;
    let wy = snap ? s.y[id] : py + (s.y[id] - py) * alpha;
    const facing = snap ? s.facing[id] : pf + shortestArc(pf, s.facing[id]) * alpha;

    const phase = id * 0.618;
    const moved = !snap && jump > 0.05;

    if (!moved && !motion.reduced) {
      // Standing men fidget. Perfect stillness reads as a screenshot -- unless
      // the player has asked for less motion, when it reads as calm.
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
  private drawOrder(g: Group, cam: Camera): void {
    // A recovering company's countdown is drawn once, on the men, by
    // drawRecovering. A second ring at the anchor disagreed with it about
    // where the company was whenever the anchor had walked ahead (RF-19).
    if (g.stance === "idle" || g.stance === "recover") return;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = sideColor("friend");
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = 0.55;

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
  /**
   * Bodies of troops, as halos, once individual men stop being legible.
   *
   * Enemy halos are drawn from MEMORY, not from the live board. Drawing every
   * group unconditionally meant that pulling the camera back revealed the whole
   * enemy disposition straight through the fog -- scouting was pointless, since
   * one scroll wheel showed you everything. Gating on current visibility
   * instead would make halos blink in and out as groups cross a sight edge,
   * which is worse to look at and reads as a glitch.
   *
   * So: a group you can see now updates its remembered position, and a group
   * you have lost keeps its halo at the place you last saw it, fading as the
   * report goes stale. That is what a map table actually shows you, and it
   * makes a scout worth buying.
   */
  private drawGroupHalos(world: World, cam: Camera, viewer: number): void {
    const ctx = this.ctx;
    ctx.save();
    // Strongest right at the point where soldiers stop being legible.
    const strength = Math.min(1, (GROUP_HALO_ZOOM - cam.zoom) / (GROUP_HALO_ZOOM - 0.25));

    const halo = (x: number, y: number, radius: number, n: number, side: "friend" | "foe", fade: number): void => {
      const sx = cam.worldToScreenX(x);
      const sy = cam.worldToScreenY(y);
      const r = Math.max(11, (radius + 22) * cam.zoom);
      if (sx < -r || sy < -r || sx > cam.viewW + r || sy > cam.viewH + r) return;
      const shown = strength * fade;
      const grad = ctx.createRadialGradient(sx, sy, r * 0.2, sx, sy, r);
      grad.addColorStop(0, sideColor(side, 0.5 * shown));
      grad.addColorStop(1, sideColor(side, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      // A ring scaled by headcount, so a big body reads as bigger. The foe's
      // is dashed, so the two sides differ in more than colour (RF-01).
      ctx.globalAlpha = 0.55 * shown;
      ctx.strokeStyle = sideColor(side);
      ctx.lineWidth = Math.max(1, Math.min(3, 0.8 + n * 0.09));
      ctx.setLineDash(side === "foe" ? [6, 4] : []);
      ctx.beginPath();
      ctx.arc(sx, sy, r * 0.72, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    };

    for (const g of world.groups) {
      if (g.player !== viewer) continue;
      const p = presenceOf(world, g, viewer);
      if (p.n > 0) halo(p.x, p.y, g.radius, p.n, "friend", 1);
    }
    // Enemies from memory only: a company in view has just been stamped with
    // the present tick, so it draws at full strength where it stands.
    for (const seen of this.lastSeen.values()) {
      const fade = this.memoryFade(world, seen);
      if (fade > 0) halo(seen.x, seen.y, seen.radius, seen.n, "foe", fade);
    }
    ctx.restore();
  }

  /**
   * Keep the record of where each enemy company was last seen.
   *
   * A company in view updates its mark to the present tick. A mark is dropped
   * when it is too old to trust, or once the viewer has been looking at that
   * ground for a few seconds and nobody is there. The same rule holds whether
   * the company moved off or died out of sight, so a report of a company
   * destroyed unseen stays on the map until somebody goes and looks, rather
   * than vanishing the instant it dies and telling you so (RF-10).
   */
  private rememberSightings(world: World, viewer: number): void {
    const inView = new Set<number>();
    for (const g of world.groups) {
      if (g.player === viewer || !g.seenBy[viewer]) continue;
      const p = presenceOf(world, g, viewer);
      if (p.n === 0) continue;
      inView.add(g.id);
      this.lastSeen.set(g.id, {
        x: p.x, y: p.y, tick: world.tick, n: p.n, radius: g.radius, player: g.player, emptySince: -1,
      });
    }
    for (const [id, seen] of this.lastSeen) {
      if (inView.has(id)) continue;
      if (!this.perception.ground(seen.x, seen.y)) seen.emptySince = -1;
      else if (seen.emptySince < 0) seen.emptySince = world.tick;
      const disproved = seen.emptySince >= 0 && world.tick - seen.emptySince > EMPTY_GROUND_TICKS;
      if (world.tick - seen.tick > MEMORY_TICKS || disproved) this.lastSeen.delete(id);
    }
  }

  /** How strongly a mark still shows: 1 while fresh, falling to 0 as it ages. */
  private memoryFade(world: World, seen: Sighting): number {
    const age = world.tick - seen.tick;
    if (age <= MEMORY_HOLD_TICKS) return 1;
    return Math.max(0, 1 - (age - MEMORY_HOLD_TICKS) / (MEMORY_TICKS - MEMORY_HOLD_TICKS));
  }

  /** For tests and the e2e harness: plant a last-seen mark `ageTicks` old. */
  noteSighting(world: World, group: number, x: number, y: number, ageTicks: number): void {
    const g = world.groupById(group);
    if (!g) return;
    this.lastSeen.set(group, {
      x, y, tick: world.tick - ageTicks, n: g.members.length, radius: g.radius, player: g.player, emptySince: -1,
    });
  }

  /** For tests and the e2e harness: how strongly the mark of an enemy company shows. */
  lastSeenFade(world: World, group: number): number {
    const seen = this.lastSeen.get(group);
    return seen ? this.memoryFade(world, seen) : 0;
  }

  /**
   * Ground worth standing on.
   *
   * Drawn under the troops and over the terrain, with the ring coloured by
   * whoever currently holds it. Contested points stay neutral rather than
   * flickering between the two armies -- a point changing hands should be an
   * event you notice, not a strobe.
   */
  private drawControlPoints(world: World, cam: Camera, viewer: number): void {
    if (world.controlPoints.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    for (let i = 0; i < world.controlPoints.length; i++) {
      const cp = world.controlPoints[i];
      const owner = world.heldBy[i];
      const sx = cam.worldToScreenX(cp.x);
      const sy = cam.worldToScreenY(cp.y);
      const r = cp.radius * cam.zoom;
      if (sx < -r || sy < -r || sx > cam.viewW + r || sy > cam.viewH + r) continue;

      // Held ground is the holder's side colour as the viewer sees it; the
      // foe's ring is also double, so who holds it reads without colour.
      const tint = (a: number): string =>
        owner < 0 ? "rgba(120, 104, 74, " + a + ")" : colorFor(owner, viewer, a);
      ctx.fillStyle = tint(0.1);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = tint(0.85);
      ctx.lineWidth = owner < 0 ? 1.5 : 2.5;
      ctx.setLineDash(owner < 0 ? [7, 6] : []);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
      if (owner >= 0 && owner !== viewer) {
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(2, r - 6), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // The objective's name at every zoom -- far out is when objectives
      // matter most -- at the canvas minimum, on a parchment halo (RF-14).
      ctx.font = "600 " + CANVAS_LABEL_MIN_PX + "px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      haloText(ctx, cp.name.toUpperCase(), sx, sy - r - 7, "rgba(46, 38, 27, 0.95)");
      ctx.textAlign = "left";
    }
    ctx.restore();
  }

  private drawWorkings(world: World, cam: Camera, viewer: number, now: number): void {
    if (world.workings.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    const t = animTime(now);
    for (const w of world.workings) {
      const friendly = w.player === viewer;
      // An enemy's working is seen only where the viewer is actually looking:
      // watching enemy adepts mend in ground nobody is watching is free
      // intelligence (RF-05).
      if (!friendly && !this.perception.disc(w.x, w.y, w.radius)) continue;
      const side = friendly ? "friend" : "foe";
      const sx = cam.worldToScreenX(w.x);
      const sy = cam.worldToScreenY(w.y);
      const r = w.radius * cam.zoom;
      if (sx < -r || sy < -r || sx > cam.viewW + r || sy > cam.viewH + r) continue;
      const fade = Math.max(0, Math.min(1, (w.until - world.tick) / (TICK_RATE * 3)));
      const pulse = motion.reduced ? 0.8 : 0.6 + 0.4 * Math.sin(t * 1.6 + w.x * 0.01);

      // Healing is drawn as healing: crosses rising out of a field. The SHAPE
      // says mending; the colour says whose (RF-02). It used to be green for
      // either side, so an enemy's surgeons looked like your own.
      const mending = w.spell === "mend" || w.spell === "succour";
      if (mending) {
        ctx.globalAlpha = 0.2 * fade * pulse;
        ctx.fillStyle = sideColor(side);
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.85 * fade;
        ctx.strokeStyle = sideColor(side);
        ctx.lineWidth = Math.max(1.2, 2 * cam.zoom);
        for (let k = 0; k < 6; k++) {
          // Each cross drifts upward on its own clock and restarts, so the
          // field reads as continuous work rather than a static badge.
          const phase = motion.reduced ? 0.3 : (t * 0.5 + k * 0.37) % 1;
          const a2 = (k / 6) * Math.PI * 2 + w.x * 0.01;
          const cx2 = sx + Math.cos(a2) * r * 0.55;
          const cy2 = sy + Math.sin(a2) * r * 0.55 - phase * r * 0.5;
          const arm = Math.max(2, 5 * cam.zoom) * (1 - phase * 0.4);
          ctx.globalAlpha = 0.9 * fade * (1 - phase);
          ctx.beginPath();
          ctx.moveTo(cx2 - arm, cy2);
          ctx.lineTo(cx2 + arm, cy2);
          ctx.moveTo(cx2, cy2 - arm);
          ctx.lineTo(cx2, cy2 + arm);
          ctx.stroke();
        }
        continue;
      }

      // Any other working: a dashed ring in the caster's side colour.
      ctx.globalAlpha = 0.24 * fade * pulse;
      ctx.fillStyle = sideColor(side);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.75 * fade;
      ctx.strokeStyle = sideColor(side);
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
  /**
   * The commander's abilities, standing on the ground where they were put.
   *
   * Each is drawn as the thing it is rather than as a coloured circle: a
   * barrage is shells falling, a screen is drifting smoke, a shield wall is
   * locked shields. An ability the player paid points for has to be visible
   * enough to be worth the points.
   */
  private drawFields(world: World, cam: Camera, clock: number, viewer: number): void {
    if (world.fields.length === 0) return;
    const ctx = this.ctx;
    // Decoration that flickers or scatters stands still with motion reduced.
    const now = animTime(clock);
    ctx.save();
    for (const f of world.fields) {
      // The enemy's are drawn only on ground the viewer can see (RF-05).
      if (f.player !== viewer && !this.perception.disc(f.x, f.y, f.radius)) continue;
      const side = f.player === viewer ? "friend" : "foe";
      const sx = cam.worldToScreenX(f.x);
      const sy = cam.worldToScreenY(f.y);
      const r = f.radius * cam.zoom;

      if (f.ability === "barrage") {
        // Shells landing: a scatter of bursts that moves every frame, so the
        // ground plainly reads as being under fire rather than merely tinted.
        ctx.globalAlpha = 0.34;
        ctx.fillStyle = "#c4402f";
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#ff6a3d";
        ctx.lineWidth = Math.max(2, 4.5 * cam.zoom);
        for (let k = 0; k < 16; k++) {
          // Deterministic per shell and per moment: stable enough not to
          // strobe, lively enough to read as a bombardment.
          const seed = k * 2.399 + Math.floor(now * 6) * 0.7;
          const a2 = seed % (Math.PI * 2);
          const rad = ((seed * 37) % 100) / 100 * r * 0.9;
          const bx = sx + Math.cos(a2) * rad;
          const by = sy + Math.sin(a2) * rad;
          const burst = Math.max(4, 15 * cam.zoom);
          ctx.beginPath();
          ctx.moveTo(bx - burst, by);
          ctx.lineTo(bx + burst, by);
          ctx.moveTo(bx, by - burst);
          ctx.lineTo(bx, by + burst);
          ctx.stroke();
        }
      } else if (f.ability === "smoke") {
        ctx.globalAlpha = 0.78;
        ctx.fillStyle = "#b3ac9c";
        for (let k = 0; k < 7; k++) {
          const a2 = (k / 7) * Math.PI * 2 + now * 0.25;
          const rad = r * 0.45;
          ctx.beginPath();
          ctx.arc(sx + Math.cos(a2) * rad, sy + Math.sin(a2) * rad, r * 0.55, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (f.ability === "shield") {
        // Whoever raised it: it used to be player-0 blue for either side.
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = sideColor(side);
        ctx.lineWidth = Math.max(3, 6 * cam.zoom);
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.stroke();
        // Overlapping shields around the rim, so it reads as a wall of men.
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = sideColor(side);
        for (let k = 0; k < 16; k++) {
          const a2 = (k / 16) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(sx + Math.cos(a2) * r, sy + Math.sin(a2) * r, Math.max(4, 9 * cam.zoom), 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (f.ability === "bulwark") {
        // A ring of stakes. Drawn from the field's own position so it is stable
        // frame to frame -- works do not shimmer.
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = "#6b5636";
        ctx.lineWidth = Math.max(1.2, 2.2 * cam.zoom);
        for (let k = 0; k < 14; k++) {
          const a2 = (k / 14) * Math.PI * 2;
          const px = sx + Math.cos(a2) * r * 0.85;
          const py = sy + Math.sin(a2) * r * 0.85;
          const h = Math.max(3, 7 * cam.zoom);
          ctx.beginPath();
          ctx.moveTo(px, py + h * 0.4);
          ctx.lineTo(px + h * 0.35, py - h * 0.6);
          ctx.stroke();
        }
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = "#8f8375";
        ctx.beginPath();
        ctx.arc(sx, sy, r * 0.85, 0, Math.PI * 2);
        ctx.fill();
      } else if (f.ability === "caltrops") {
        // Iron sown in the grass: small four-pointed stars, fixed in place.
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = "#4b4237";
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = "#3f3527";
        ctx.lineWidth = Math.max(1, 1.6 * cam.zoom);
        const k0 = Math.max(10, Math.min(60, Math.round(r * r / 900)));
        ctx.beginPath();
        for (let k = 0; k < k0; k++) {
          const seed = (k * 7919 + Math.round(f.x) * 31 + Math.round(f.y)) % 10007;
          const a2 = (seed % 628) / 100;
          const rad = Math.sqrt(((seed * 13) % 1000) / 1000) * r * 0.95;
          const cx = sx + Math.cos(a2) * rad;
          const cy = sy + Math.sin(a2) * rad;
          const h = Math.max(2, 4 * cam.zoom);
          ctx.moveTo(cx - h, cy - h); ctx.lineTo(cx + h, cy + h);
          ctx.moveTo(cx - h, cy + h); ctx.lineTo(cx + h, cy - h);
        }
        ctx.stroke();
      } else if (f.ability === "firepots") {
        // Burning pitch: tongues of flame that lick up and die back.
        ctx.globalAlpha = 0.26;
        ctx.fillStyle = "#b8532a";
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
        for (let k = 0; k < 14; k++) {
          const a2 = k * 2.399;
          const rad = ((k * 37) % 100) / 100 * r * 0.85;
          const fx = sx + Math.cos(a2) * rad;
          const fy = sy + Math.sin(a2) * rad;
          const lick = 0.6 + 0.4 * Math.sin(now * 11 + k * 1.7);
          const h = Math.max(5, 18 * cam.zoom) * lick;
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = k % 3 === 0 ? "#ffcf5a" : "#f0742c";
          ctx.beginPath();
          ctx.moveTo(fx - h * 0.35, fy);
          ctx.quadraticCurveTo(fx, fy - h * 1.4, fx + h * 0.35, fy);
          ctx.closePath();
          ctx.fill();
        }
      } else if (f.ability === "parley") {
        // A truce: a pale ring and a white cloth on a pole at its centre.
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = "#f4efe2";
        ctx.lineWidth = Math.max(2, 4 * cam.zoom);
        ctx.setLineDash([10, 8]);
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        const pole = Math.max(14, 36 * cam.zoom);
        const wave = Math.sin(now * 4) * pole * 0.12;
        ctx.strokeStyle = "#5a4a34";
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx, sy - pole);
        ctx.stroke();
        ctx.fillStyle = "#f8f5ec";
        ctx.beginPath();
        ctx.moveTo(sx, sy - pole);
        ctx.lineTo(sx + pole * 0.6, sy - pole * 0.85 + wave);
        ctx.lineTo(sx, sy - pole * 0.62);
        ctx.closePath();
        ctx.fill();
      } else if (f.ability === "beacon") {
        // A fire you can steer by: a warm glow, and a ring that breathes.
        const pulse = 0.85 + 0.15 * Math.sin(now * 2.2);
        const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
        grad.addColorStop(0, "rgba(255, 196, 92, 0.45)");
        grad.addColorStop(1, "rgba(255, 196, 92, 0)");
        ctx.globalAlpha = 1;
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = "#e3a23c";
        ctx.lineWidth = Math.max(1.5, 3 * cam.zoom);
        ctx.beginPath();
        ctx.arc(sx, sy, r * pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#ffb43c";
        const flame = Math.max(5, 12 * cam.zoom) * (0.8 + 0.2 * Math.sin(now * 13));
        ctx.beginPath();
        ctx.moveTo(sx - flame * 0.5, sy);
        ctx.quadraticCurveTo(sx, sy - flame * 2, sx + flame * 0.5, sy);
        ctx.closePath();
        ctx.fill();
      } else if (f.ability === "flare") {
        // A hanging light with rays going out, and a ring where the light
        // stops -- the edge matters, because it is the edge of what you can see.
        const flicker = 0.82 + 0.18 * Math.sin(now * 9);
        ctx.globalAlpha = 0.3 * flicker;
        ctx.fillStyle = "#ffe89a";
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = flicker;
        ctx.strokeStyle = "#ffc93a";
        ctx.lineWidth = Math.max(2, 4 * cam.zoom);
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.stroke();
        for (let k = 0; k < 12; k++) {
          const a2 = (k / 12) * Math.PI * 2 + now * 0.4;
          ctx.beginPath();
          ctx.moveTo(sx + Math.cos(a2) * r * 0.14, sy + Math.sin(a2) * r * 0.14);
          ctx.lineTo(sx + Math.cos(a2) * r * 0.3, sy + Math.sin(a2) * r * 0.3);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  /**
   * A ring counting down over a company that has stood down.
   *
   * Recovering costs thirty helpless seconds and the only sign of it was a word
   * in the corner. A shrinking arc says both "these men cannot act" and "for
   * this much longer" without the player reading anything.
   */
  private drawRecovering(world: World, cam: Camera, viewer: number): void {
    const ctx = this.ctx;
    ctx.save();
    for (const g of world.groups) {
      if (g.player !== viewer || g.recoverUntil <= world.tick) continue;
      const total = RECOVER_LOCK_SECONDS * 20;
      const frac = (g.recoverUntil - world.tick) / total;
      const p = presenceOf(world, g, viewer);
      if (p.n === 0) continue;
      const sx = cam.worldToScreenX(p.x);
      const sy = cam.worldToScreenY(p.y);
      const r = Math.max(14, (g.radius + 14) * cam.zoom);
      // Violet and dashed under the closing arc: a status, never a side.
      ctx.strokeStyle = RECOVER_COLOR;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = Math.max(1.5, 3 * cam.zoom);
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(sx, sy, r, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * What a company is doing for itself, while it is doing it.
   *
   * Each is drawn as the thing it is: shields up across the front, a company
   * planted behind a solid ring, light troops smeared with after-images, a
   * gallop trailing streaks behind it. A company that has just halved the
   * damage it takes should look different from one that has not, or the player
   * has no way to read the fight.
   */
  private drawSpecials(world: World, cam: Camera, clock: number, viewer: number, prev: Snapshot): void {
    const ctx = this.ctx;
    const now = animTime(clock);
    ctx.save();
    ctx.lineCap = "round";
    for (const g of world.groups) {
      if (g.specialUntil <= world.tick) continue;
      // Drawn on the men who are actually there and actually visible. At the
      // anchor, a gallop kept streaking across the field after the riders
      // under it had been stopped or killed, and an enemy brace ring showed
      // through the fog over a company you could not see.
      const p = presenceOf(world, g, viewer, prev);
      if (p.n === 0) continue;
      const sx = cam.worldToScreenX(p.x);
      const sy = cam.worldToScreenY(p.y);
      const body = Math.min(g.radius, p.spread * 1.5 + 6);
      const r = Math.max(12, (body + 10) * cam.zoom);
      if (sx < -r * 3 || sy < -r * 3 || sx > cam.viewW + r * 3 || sy > cam.viewH + r * 3) continue;
      const tint = colorFor(g.player, viewer);
      const kind = world.specialKind(g);

      if (kind === "brace") {
        // Shields across the front, facing the way the company faces.
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#f0e2b8";
        ctx.lineWidth = Math.max(4, 9 * cam.zoom);
        ctx.beginPath();
        ctx.arc(sx, sy, r, g.facing - 1.1, g.facing + 1.1);
        ctx.stroke();
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = tint;
        ctx.lineWidth = Math.max(2, 5 * cam.zoom);
        ctx.beginPath();
        ctx.arc(sx, sy, r, g.facing - 1.1, g.facing + 1.1);
        ctx.stroke();
      } else if (kind === "fortify") {
        // Planted: a closed, heavy ring with nothing open about it.
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#f0e2b8";
        ctx.lineWidth = Math.max(5, 11 * cam.zoom);
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = tint;
        ctx.lineWidth = Math.max(3, 6 * cam.zoom);
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = tint;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (kind === "dodge") {
        // After-images: the company reads as never quite where you aimed.
        ctx.strokeStyle = tint;
        ctx.lineWidth = Math.max(2, 3.5 * cam.zoom);
        for (let k = 0; k < 4; k++) {
          ctx.globalAlpha = 0.55 - k * 0.1;
          const off = (k + 1) * 9 * cam.zoom;
          const a2 = now * 3 + k * 2.1;
          ctx.beginPath();
          ctx.arc(sx + Math.cos(a2) * off, sy + Math.sin(a2) * off, r * 0.8, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (kind === "dash") {
        // Speed lines, and they must ALWAYS be behind the horses.
        //
        // Two things had them running ahead. The heading came from g.facing --
        // where the company is POINTING, which is not where it is going the
        // moment it wheels or keeps its front to an enemy while moving off --
        // so the streaks could swing round in front. And they began inside the
        // formation radius, so with the men spread out to the full radius the
        // lines overlapped the leaders and read as outrunning them.
        //
        // The heading now comes from the route the company is actually walking,
        // and the streaks start beyond the rear edge of the formation, so
        // nothing is ever drawn in front of a horse.
        //
        // And they are drawn only while the riders are really moving, along
        // the way they are really moving. A charge that has hit home, or whose
        // horses are down, leaves no streaks behind it.
        if (!isMoving(p, 0.8)) continue;
        const head = Math.atan2(p.vy, p.vx);
        const back = head + Math.PI;
        const cb = Math.cos(back);
        const sb = Math.sin(back);
        ctx.strokeStyle = tint;
        ctx.lineWidth = Math.max(2.5, 5 * cam.zoom);
        for (let k = -2; k <= 2; k++) {
          const off = k * 7 * cam.zoom;
          const px = -Math.sin(head) * off;
          const py = Math.cos(head) * off;
          // Clear of the whole formation before the first pixel is drawn.
          const start = r * 1.05;
          const len = (58 - Math.abs(k) * 8) * cam.zoom;
          ctx.globalAlpha = 1 - Math.abs(k) * 0.18;
          ctx.beginPath();
          ctx.moveTo(sx + px + cb * start, sy + py + sb * start);
          ctx.lineTo(sx + px + cb * (start + len), sy + py + sb * (start + len));
          ctx.stroke();
        }
      } else if (kind === "setPikes" || kind === "pavise") {
        // A hedge of points, or a wall of boards, across the front.
        const pikes = kind === "setPikes";
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = pikes ? "#3f3527" : "#8a6a3e";
        ctx.lineWidth = Math.max(pikes ? 1.5 : 4, (pikes ? 2.2 : 8) * cam.zoom);
        const n = pikes ? 11 : 7;
        for (let k = 0; k < n; k++) {
          const a2 = g.facing - 1.0 + (2.0 * k) / (n - 1);
          const x0 = sx + Math.cos(a2) * r;
          const y0 = sy + Math.sin(a2) * r;
          const out = pikes ? r * 0.55 : r * 0.12;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x0 + Math.cos(a2) * out, y0 + Math.sin(a2) * out);
          ctx.stroke();
        }
      } else if (kind === "challenge" || kind === "lastStand") {
        // A champion's ring, or a sworn company's: hard red edges.
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = kind === "challenge" ? "#d6a640" : statusColor.lastStand;
        ctx.lineWidth = Math.max(2.5, 5 * cam.zoom);
        ctx.setLineDash(kind === "challenge" ? [3, 6] : []);
        ctx.beginPath();
        ctx.arc(sx, sy, r * (kind === "challenge" ? 1.25 : 1.05), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (kind === "rally" || kind === "cadence" || kind === "terror") {
        // Auras reach well past the company, so draw their reach, faintly,
        // with a pulse: colours shine, drums beat, the pack's panic spreads.
        const reach = kind === "rally" ? RALLY_RADIUS : kind === "cadence" ? CADENCE_RADIUS : TERROR_RADIUS;
        const beat = motion.reduced ? 0.5 : kind === "cadence" ? (now * 1.4) % 1 : (now * 0.6) % 1;
        ctx.strokeStyle = kind === "rally" ? "#e0b84a" : kind === "cadence" ? tint : statusColor.terror;
        ctx.lineWidth = Math.max(1.5, 3 * cam.zoom);
        ctx.globalAlpha = 0.5 * (1 - beat);
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(r, reach * cam.zoom * (0.35 + 0.65 * beat)), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.18;
        ctx.setLineDash([4, 7]);
        ctx.beginPath();
        ctx.arc(sx, sy, reach * cam.zoom, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (kind === "laager") {
        // Wagons chained in a ring: an angular wall, not a circle.
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = "#6b5636";
        ctx.lineWidth = Math.max(3, 7 * cam.zoom);
        ctx.beginPath();
        for (let k = 0; k <= 8; k++) {
          const a2 = (k / 8) * Math.PI * 2;
          const px = sx + Math.cos(a2) * r * 1.15;
          const py = sy + Math.sin(a2) * r * 1.15;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * Companies whose nerve has gone, marked ON THE MAP (audit RF-09).
   *
   * A break used to be one line of HUD text naming the company, for your own
   * side only, so you had to match a name to a counter -- and an enemy company
   * breaking showed nothing at all, though its flight was plain to see. Now a
   * struck pennant hangs over any broken company the viewer can see: a pole
   * with its flag fallen, the shape saying "broken" and the colour saying
   * whose. Shown for the enemy only while you can see its men, because a
   * company in flight is something you can watch happen.
   */
  private drawBreaks(world: World, cam: Camera, viewer: number): void {
    const ctx = this.ctx;
    const s = world.soldiers;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const g of world.groups) {
      if (g.brokeAt < 0) continue;
      const p = presenceOf(world, g, viewer);
      if (p.n === 0) continue;
      // Broken now, judged on the men the viewer can see.
      let nerve = 0;
      let n = 0;
      for (const m of g.members) {
        if (s.alive[m] !== 1 || !this.perception.soldier(world, m)) continue;
        nerve += s.morale[m];
        n++;
      }
      if (n === 0 || nerve / n >= COMPANY_BREAK) continue;
      const sx = cam.worldToScreenX(p.x);
      const sy = cam.worldToScreenY(p.y) - Math.max(14, (p.spread + 18) * cam.zoom);
      drawStruckPennant(ctx, sx, sy, Math.max(9, 14 * cam.zoom), colorFor(g.player, viewer));
    }
    ctx.restore();
  }

  /**
   * Where an enemy company was when you last had eyes on it.
   *
   * The counters themselves are only drawn while they are actually observed, so
   * without this a company would blink out of existence the moment your scout
   * looked away -- which reads as a glitch and throws away information you
   * genuinely have. A mark on the last known ground is what a map table would
   * show, and it decays, because an old report is worth less than a new one.
   *
   * The halo at low zoom does this same job; this is its close-up twin.
   */
  private drawLastSeen(world: World, cam: Camera, viewer: number): void {
    const ctx = this.ctx;
    ctx.save();
    for (const [id, seen] of this.lastSeen) {
      // A company in view is drawn as itself; the mark is for the lost.
      if (seen.tick === world.tick) {
        const g = world.groupById(id);
        if (g && g.seenBy[viewer]) continue;
      }
      const fade = this.memoryFade(world, seen);
      if (fade <= 0) continue;
      const sx = cam.worldToScreenX(seen.x);
      const sy = cam.worldToScreenY(seen.y);
      const r = Math.max(10, 26 * cam.zoom);
      ctx.globalAlpha = 0.5 * fade;
      ctx.strokeStyle = colorFor(seen.player, viewer);
      ctx.lineWidth = Math.max(1, 1.6 * cam.zoom);
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      // How many were there when you looked, so the mark carries a fact. The
      // ring fades with age; the number keeps a readable floor until the mark
      // goes, because a faint number is a number nobody can read (RF-14).
      const px = Math.max(CANVAS_LABEL_MIN_PX, 13 * cam.zoom);
      ctx.font = "600 " + px + "px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.globalAlpha = Math.max(0.55, fade);
      haloText(ctx, String(seen.n), sx, sy + px * 0.35, colorFor(seen.player, viewer));
    }
    ctx.textAlign = "left";
    ctx.restore();
  }

  /**
   * The works, as a system rather than as a scatter of holes.
   *
   * Neighbouring pieces are joined by a drawn wall, which is what turns a row
   * of separate diggings into a defensive line you can read at a glance -- and
   * a battlement, where several meet, is drawn with crenellations because it is
   * the piece worth holding.
   *
   * Work in progress is drawn too: a pale outline filling up, with the earth
   * piling higher as it goes. Digging used to be completely invisible until the
   * instant a fortification appeared, so the one thing sappers exist to do gave
   * the player nothing to watch.
   */
  private drawWorks(world: World, cam: Camera, clock: number, viewer: number): void {
    const ctx = this.ctx;
    const t = TILE_SIZE;
    const now = animTime(clock);
    const works = this.visibleWorks(world, viewer);
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Walls first, so the pieces sit on top of the line they form.
    ctx.strokeStyle = "#6b5636";
    ctx.lineWidth = Math.max(2, 6 * cam.zoom);
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    for (let i = 0; i < works.length; i++) {
      const a2 = works[i];
      for (let j = i + 1; j < works.length; j++) {
        const b2 = works[j];
        if (b2.player !== a2.player) continue;
        const dx = b2.tx - a2.tx;
        const dy = b2.ty - a2.ty;
        if (dx < -1 || dx > 1 || dy < -1 || dy > 1) continue;
        ctx.moveTo(cam.worldToScreenX((a2.tx + 0.5) * t), cam.worldToScreenY((a2.ty + 0.5) * t));
        ctx.lineTo(cam.worldToScreenX((b2.tx + 0.5) * t), cam.worldToScreenY((b2.ty + 0.5) * t));
      }
    }
    ctx.stroke();

    for (const w of works) {
      const sx = cam.worldToScreenX((w.tx + 0.5) * t);
      const sy = cam.worldToScreenY((w.ty + 0.5) * t);
      const r = t * 0.42 * cam.zoom;
      if (sx < -r * 3 || sy < -r * 3 || sx > cam.viewW + r * 3 || sy > cam.viewH + r * 3) continue;
      const tint = colorFor(w.player, viewer);

      ctx.globalAlpha = 0.9;
      ctx.fillStyle = "#a8977a";
      ctx.strokeStyle = "#5c4a2e";
      ctx.lineWidth = Math.max(1, 1.8 * cam.zoom);
      if (w.kind === "battlement") {
        // Crenellations: the piece worth standing on.
        ctx.beginPath();
        ctx.rect(sx - r, sy - r * 0.7, r * 2, r * 1.4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = tint;
        ctx.globalAlpha = 0.85;
        for (let k = 0; k < 4; k++) {
          const bx = sx - r + (k * 2 + 0.4) * (r / 4);
          ctx.fillRect(bx, sy - r * 1.05, r * 0.4, r * 0.42);
        }
      } else if (w.kind === "wall") {
        ctx.beginPath();
        ctx.rect(sx - r * 0.9, sy - r * 0.42, r * 1.8, r * 0.84);
        ctx.fill();
        ctx.stroke();
      } else {
        // A redoubt: the first thing dug, and squarer than the rest.
        ctx.beginPath();
        ctx.rect(sx - r * 0.75, sy - r * 0.75, r * 1.5, r * 1.5);
        ctx.fill();
        ctx.stroke();
        ctx.globalAlpha = 0.7;
        ctx.fillStyle = tint;
        ctx.fillRect(sx - r * 0.3, sy - r * 0.3, r * 0.6, r * 0.6);
      }
    }

    // Work in progress: earth piling up, and a shovel-stroke of dust.
    for (const b of world.building) {
      // Enemy digging is seen only by watching it (RF-05).
      if (b.player !== viewer && !this.perception.ground((b.tx + 0.5) * t, (b.ty + 0.5) * t)) continue;
      const sx = cam.worldToScreenX((b.tx + 0.5) * t);
      const sy = cam.worldToScreenY((b.ty + 0.5) * t);
      const r = t * 0.42 * cam.zoom;
      const p = Math.max(0, Math.min(1, b.progress));
      ctx.globalAlpha = 0.35 + 0.4 * p;
      ctx.fillStyle = "#a8977a";
      ctx.fillRect(sx - r * 0.85, sy + r * 0.6 - r * 1.2 * p, r * 1.7, r * 1.2 * p);
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = "#5c4a2e";
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = Math.max(1, 1.6 * cam.zoom);
      ctx.strokeRect(sx - r * 0.85, sy - r * 0.6, r * 1.7, r * 1.2);
      ctx.setLineDash([]);
      // A pick swinging, so it reads as men working rather than a ghost box.
      const swing = Math.sin(now * 7 + b.tx) * 0.5;
      ctx.beginPath();
      ctx.moveTo(sx - r * 0.2, sy + r * 0.2);
      ctx.lineTo(sx - r * 0.2 + Math.cos(-1 + swing) * r * 0.8, sy + r * 0.2 + Math.sin(-1 + swing) * r * 0.8);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The works the viewer knows of: their own as they stand, and the enemy's as
   * last observed. Ground in view refreshes the record -- adding what has
   * been dug, dropping what has been razed -- and ground out of view keeps the
   * last report, never the live board (RF-05).
   */
  private visibleWorks(world: World, viewer: number): KnownWork[] {
    const out: KnownWork[] = [];
    const t = TILE_SIZE;
    const live = new Set<string>();
    for (const w of world.works) {
      if (w.player === viewer) {
        out.push(w);
        continue;
      }
      const key = w.tx + "," + w.ty;
      live.add(key);
      if (this.perception.ground((w.tx + 0.5) * t, (w.ty + 0.5) * t)) {
        this.knownWorks.set(key, { tx: w.tx, ty: w.ty, kind: w.kind, player: w.player });
      }
    }
    for (const [key, k] of this.knownWorks) {
      if (!live.has(key) && this.perception.ground((k.tx + 0.5) * t, (k.ty + 0.5) * t)) {
        this.knownWorks.delete(key);
        continue;
      }
      out.push(k);
    }
    return out;
  }

  private drawFog(world: World, cam: Camera, viewer: number): void {
    void viewer; // the perception layer was built for this viewer
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
        // Through the perception layer, so ground the fog disc lit but no man
        // of yours actually has a line to -- the far side of a wood -- shades
        // as remembered, not as seen (RF-03). Lit ground that looks empty now
        // IS empty, as far as anything you could see goes.
        const state = this.perception.shade(world, wx + 1, wy + 1);
        if (state === SEEN_NOW) continue;
        ctx.fillStyle = state === SEEN_BEFORE || state === SEEN_OBSCURED
          ? "rgba(58, 48, 34, 0.30)"
          : "rgba(44, 37, 26, 0.78)";
        ctx.fillRect(
          Math.floor(cam.worldToScreenX(wx)), Math.floor(cam.worldToScreenY(wy)), size, size,
        );
      }
    }
    if (world.sightScale < 1) {
      // Night: a cold wash over the whole field, deeper the darker the night,
      // so a night battle reads as one before anyone notices how little they see.
      const dark = Math.min(0.45, (1 - world.sightScale) * 0.6);
      ctx.fillStyle = "rgba(24, 32, 58, " + dark.toFixed(3) + ")";
      ctx.fillRect(
        cam.worldToScreenX(0), cam.worldToScreenY(0),
        world.terrain.worldWidth * cam.zoom, world.terrain.worldHeight * cam.zoom,
      );
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

/** A diamond, for the foe's block at strategic zoom. */
function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
}

/**
 * Text on a parchment halo, so a map label stays readable over forest, water
 * or a crowd of counters (docs/ui-policy.md, "Canvas text").
 */
export function haloText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string): void {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(243, 236, 219, 0.92)";
  ctx.lineWidth = 4;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * A struck pennant: a pole with its flag hanging down it, drawn in the
 * company's side colour on a pale backing, so "broken" reads by shape.
 */
function drawStruckPennant(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, colour: string): void {
  ctx.save();
  // Pale backing first, so the mark reads over any ground.
  ctx.strokeStyle = "rgba(243, 236, 219, 0.95)";
  ctx.lineWidth = Math.max(4, h * 0.38);
  ctx.beginPath();
  ctx.moveTo(x, y - h);
  ctx.lineTo(x, y + h * 0.4);
  ctx.stroke();
  ctx.fillStyle = "rgba(243, 236, 219, 0.95)";
  ctx.beginPath();
  ctx.moveTo(x - 1, y - h * 0.55);
  ctx.lineTo(x - h * 0.75, y + h * 0.15);
  ctx.lineTo(x - 1, y + h * 0.35);
  ctx.closePath();
  ctx.fill();
  // The pole, and the flag fallen against it.
  ctx.strokeStyle = "#2f2418";
  ctx.lineWidth = Math.max(1.5, h * 0.14);
  ctx.beginPath();
  ctx.moveTo(x, y - h);
  ctx.lineTo(x, y + h * 0.4);
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(x - 1, y - h * 0.45);
  ctx.lineTo(x - h * 0.6, y + h * 0.1);
  ctx.lineTo(x - 1, y + h * 0.25);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
