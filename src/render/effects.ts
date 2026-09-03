/**
 * Transient combat visuals: arrows in flight, and the marks a blow leaves.
 *
 * Fed from World.events, which the simulation writes and never reads back.
 * Everything here lives on real render time rather than sim ticks, because it
 * is pure presentation -- an arrow's flight has no bearing on when its damage
 * landed. The damage was applied the instant it was rolled; the arrow is just
 * catching up visually.
 */

import type { CombatEvent } from "../sim/world.ts";
import type { Camera } from "./camera.ts";
import { playerColor } from "./palette.ts";

/** Seconds an arrow takes to cross, regardless of distance. */
const SHOT_FLIGHT = 0.28;
/** Seconds an impact mark lingers. */
const IMPACT_LIFE = 0.42;
/** Seconds a thrown spark lives. */
const SPARK_LIFE = 0.62;
/** Seconds a scuff of dust lingers. */
const DUST_LIFE = 1.1;
/** Seconds the flash of a special lasts. Short and sharp on purpose. */
const FLASH_LIFE = 0.55;
/** A kill flashes and is gone. Short, so a scrum stays legible. */
const KILL_FLASH_LIFE = 0.3;
/** Hard cap so a long battle cannot grow the list without bound. */
const MAX_EFFECTS = 900;

type Shot = {
  x0: number; y0: number; x1: number; y1: number;
  born: number; player: number; lethal: boolean;
};

type Impact = { x: number; y: number; born: number; player: number; lethal: boolean };

/** A short-lived spray of debris thrown out from a blow. */
type Spark = { x: number; y: number; vx: number; vy: number; born: number; life: number; hot: boolean };

/** Dust kicked up by men on the move. */
type Dust = { x: number; y: number; born: number; r: number; group: number };

/** The moment a company does something for itself, drawn once and sharply. */
type Flash = { x: number; y: number; born: number; kind: string; player: number };

export class Effects {
  private shots: Shot[] = [];
  private impacts: Impact[] = [];
  private sparks: Spark[] = [];
  private dust: Dust[] = [];
  private flashes: Flash[] = [];
  /** Deterministic-enough jitter for the sprays. Presentation only. */
  private seed = 0x9e3779b9;

  /** A small, cheap, repeatable random. Never touches the simulation. */
  private rand(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  /** Take the one-shot moments: a bow thrown down, adepts stepping out. */
  ingestSpecials(
    moments: readonly { kind: string; x: number; y: number; player: number }[], now: number,
  ): void {
    for (const m of moments) {
      if (this.flashes.length > MAX_EFFECTS) return;
      this.flashes.push({ x: m.x, y: m.y, born: now, kind: m.kind, player: m.player });
      // A sharp burst of shards outward, so the moment reads even at a glance.
      const n = m.kind === "blink" ? 18 : 10;
      for (let k = 0; k < n; k++) {
        if (this.sparks.length > MAX_EFFECTS) break;
        const a2 = (k / n) * Math.PI * 2;
        const sp = m.kind === "blink" ? 150 : 90;
        this.sparks.push({
          x: m.x, y: m.y,
          vx: Math.cos(a2) * sp, vy: Math.sin(a2) * sp,
          born: now, life: FLASH_LIFE, hot: m.kind !== "blink",
        });
      }
    }
  }

  /** Men on the move scuff the ground. Called by the renderer, not the sim. */
  /**
   * Forget everything a company left behind, the moment it ceases to exist.
   *
   * Dust hangs for over a second, so a company wiped out went on kicking up a
   * cloud from ground where there was nobody left to kick anything -- the
   * marching animation of an army that no longer existed.
   */
  forgetGroup(id: number): void {
    if (this.dust.length > 0) this.dust = this.dust.filter((d) => d.group !== id);
  }

  kickDust(x: number, y: number, now: number, radius: number, group: number): void {
    if (this.dust.length > MAX_EFFECTS) return;
    this.dust.push({
      group,
      x: x + (this.rand() - 0.5) * radius,
      y: y + (this.rand() - 0.5) * radius,
      born: now,
      // Deliberately small. Marching is the background of the picture, not the
      // event -- it should never compete with a blow landing.
      r: radius * (0.14 + this.rand() * 0.16),
    });
  }

  /** Take one tick's worth of blows. Call after every world.step(). */
  ingest(events: readonly CombatEvent[], now: number): void {
    for (const e of events) {
      if (this.shots.length + this.impacts.length > MAX_EFFECTS) return;
      if (e.kind === "shot") {
        this.shots.push({
          x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1,
          born: now, player: e.player, lethal: e.lethal,
        });
      } else {
        // A melee blow has no travel; it lands where it was struck. The lunge
        // itself is animated on the soldier, not here.
        this.impacts.push({ x: e.x1, y: e.y1, born: now, player: e.player, lethal: e.lethal });
      }
      // Every blow throws something out. A killing blow throws more, and hotter
      // -- the difference between "hit" and "killed" has to be legible at a
      // glance without reading a number anywhere.
      const n = e.lethal ? 11 : 6;
      for (let k = 0; k < n; k++) {
        if (this.sparks.length > MAX_EFFECTS) break;
        const a2 = this.rand() * Math.PI * 2;
        const sp = (e.lethal ? 190 : 95) * (0.4 + this.rand());
        this.sparks.push({
          x: e.x1, y: e.y1,
          vx: Math.cos(a2) * sp, vy: Math.sin(a2) * sp,
          born: now, life: SPARK_LIFE * (0.6 + this.rand() * 0.7), hot: e.lethal,
        });
      }
      // A kill gets its own ring, so a death reads instantly from across the
      // field rather than having to be picked out of the scrum.
      if (e.lethal && this.flashes.length <= MAX_EFFECTS) {
        this.flashes.push({ x: e.x1, y: e.y1, born: now, kind: "kill", player: e.player });
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, now: number): void {
    this.expire(now);

    // Dust first: it belongs on the ground, under everything else.
    ctx.save();
    for (const d of this.dust) {
      const t = (now - d.born) / DUST_LIFE;
      if (t >= 1) continue;
      ctx.globalAlpha = 0.09 * (1 - t);
      ctx.fillStyle = "#8a7a5c";
      ctx.beginPath();
      ctx.arc(cam.worldToScreenX(d.x), cam.worldToScreenY(d.y),
        Math.max(1, d.r * (0.6 + t * 1.5) * cam.zoom), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Arrows, drawn as short streaks along their line of flight.
    ctx.save();
    ctx.lineCap = "round";
    for (const s of this.shots) {
      const t = (now - s.born) / SHOT_FLIGHT;
      if (t >= 1) continue;
      const hx = s.x0 + (s.x1 - s.x0) * t;
      const hy = s.y0 + (s.y1 - s.y0) * t;
      // Tail lags the head, so the streak reads as motion rather than a dash.
      const lag = Math.max(0, t - 0.16);
      const tx = s.x0 + (s.x1 - s.x0) * lag;
      const ty = s.y0 + (s.y1 - s.y0) * lag;
      ctx.strokeStyle = playerColor[s.player] ?? "#3f3527";
      ctx.globalAlpha = 1 - t * 0.25;
      ctx.lineWidth = Math.max(1.4, 3 * cam.zoom);
      ctx.beginPath();
      ctx.moveTo(cam.worldToScreenX(tx), cam.worldToScreenY(ty));
      ctx.lineTo(cam.worldToScreenX(hx), cam.worldToScreenY(hy));
      ctx.stroke();
      // A bright head, so a volley in flight reads as a volley.
      ctx.globalAlpha = 1 - t * 0.4;
      ctx.fillStyle = "#f0e2b8";
      ctx.beginPath();
      ctx.arc(cam.worldToScreenX(hx), cam.worldToScreenY(hy), Math.max(1.2, 2.4 * cam.zoom), 0, Math.PI * 2);
      ctx.fill();
    }

    // Impacts: a small burst, heavier when the blow was fatal.
    for (const im of this.impacts) {
      const t = (now - im.born) / IMPACT_LIFE;
      if (t >= 1) continue;
      const sx = cam.worldToScreenX(im.x);
      const sy = cam.worldToScreenY(im.y);
      const r = (im.lethal ? 13 : 7) * cam.zoom * (0.5 + t * 2.2);
      ctx.globalAlpha = (1 - t) * (im.lethal ? 1 : 0.8);
      ctx.strokeStyle = im.lethal ? "#e0452f" : (playerColor[im.player] ?? "#3f3527");
      ctx.lineWidth = Math.max(1.4, (im.lethal ? 3.4 : 2.2) * cam.zoom);
      if (im.lethal) {
        // A fallen soldier gets a cross, which reads at a glance as a loss.
        ctx.beginPath();
        ctx.moveTo(sx - r, sy - r);
        ctx.lineTo(sx + r, sy + r);
        ctx.moveTo(sx + r, sy - r);
        ctx.lineTo(sx - r, sy + r);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Sparks thrown out of every blow.
    ctx.lineCap = "round";
    for (const sp of this.sparks) {
      const t = (now - sp.born) / sp.life;
      if (t >= 1) continue;
      const x = sp.x + sp.vx * t * 0.5;
      const y = sp.y + sp.vy * t * 0.5;
      ctx.globalAlpha = (1 - t) * (sp.hot ? 1 : 0.8);
      ctx.strokeStyle = sp.hot ? "#e0452f" : "#c08a3a";
      ctx.lineWidth = Math.max(1.2, (sp.hot ? 3 : 2) * cam.zoom);
      ctx.beginPath();
      ctx.moveTo(cam.worldToScreenX(x), cam.worldToScreenY(y));
      // A long tail: the streak is most of what reads at speed.
      ctx.lineTo(cam.worldToScreenX(x - sp.vx * 0.16), cam.worldToScreenY(y - sp.vy * 0.16));
      ctx.stroke();
    }

    // The moment itself: an expanding ring, hard-edged and quick.
    for (const f of this.flashes) {
      // A kill is snappier than a special. Many men die at once in a scrum, and
      // at the full length the rings stacked into a wall that buried the
      // counters underneath -- you could not see the fight for the effects.
      const life = f.kind === "kill" ? KILL_FLASH_LIFE : FLASH_LIFE;
      const t = (now - f.born) / life;
      if (t >= 1) continue;
      const sx = cam.worldToScreenX(f.x);
      const sy = cam.worldToScreenY(f.y);
      const colour = f.kind === "blink" ? "#a86fd0"
        : f.kind === "kill" ? "#e0452f"
          : f.kind === "breakBow" ? "#e8a33a"
            : "#f4d76a";
      const grow = f.kind === "kill" ? 46 : 150;
      const rr = Math.max(5, (14 + t * grow) * cam.zoom);
      // A filled core that dies fast, under a ring that keeps going: the pop.
      ctx.globalAlpha = (1 - t) * (1 - t) * (f.kind === "kill" ? 0.42 : 0.7);
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(sx, sy, rr * 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = (1 - t) * (f.kind === "kill" ? 0.8 : 1);
      ctx.strokeStyle = colour;
      ctx.lineWidth = Math.max(1.5, (1 - t) * (f.kind === "kill" ? 4.5 : 9) * cam.zoom);
      ctx.beginPath();
      ctx.arc(sx, sy, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private expire(now: number): void {
    if (this.flashes.length > 0) {
      this.flashes = this.flashes.filter(
        (f) => now - f.born < (f.kind === "kill" ? KILL_FLASH_LIFE : FLASH_LIFE),
      );
    }
    if (this.sparks.length > 0) {
      this.sparks = this.sparks.filter((sp) => now - sp.born < sp.life);
    }
    if (this.dust.length > 0) {
      this.dust = this.dust.filter((d) => now - d.born < DUST_LIFE);
    }
    if (this.shots.length > 0) {
      this.shots = this.shots.filter((s) => now - s.born < SHOT_FLIGHT);
    }
    if (this.impacts.length > 0) {
      this.impacts = this.impacts.filter((i) => now - i.born < IMPACT_LIFE);
    }
  }

  get count(): number {
    return this.shots.length + this.impacts.length + this.sparks.length +
      this.dust.length + this.flashes.length;
  }
}
