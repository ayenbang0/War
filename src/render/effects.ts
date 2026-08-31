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
/** Hard cap so a long battle cannot grow the list without bound. */
const MAX_EFFECTS = 900;

type Shot = {
  x0: number; y0: number; x1: number; y1: number;
  born: number; player: number; lethal: boolean;
};

type Impact = { x: number; y: number; born: number; player: number; lethal: boolean };

export class Effects {
  private shots: Shot[] = [];
  private impacts: Impact[] = [];

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
    }
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, now: number): void {
    this.expire(now);

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
      ctx.globalAlpha = 0.85 * (1 - t * 0.35);
      ctx.lineWidth = Math.max(0.8, 1.5 * cam.zoom);
      ctx.beginPath();
      ctx.moveTo(cam.worldToScreenX(tx), cam.worldToScreenY(ty));
      ctx.lineTo(cam.worldToScreenX(hx), cam.worldToScreenY(hy));
      ctx.stroke();
    }

    // Impacts: a small burst, heavier when the blow was fatal.
    for (const im of this.impacts) {
      const t = (now - im.born) / IMPACT_LIFE;
      if (t >= 1) continue;
      const sx = cam.worldToScreenX(im.x);
      const sy = cam.worldToScreenY(im.y);
      const r = (im.lethal ? 6 : 3) * cam.zoom * (0.5 + t * 1.4);
      ctx.globalAlpha = (1 - t) * (im.lethal ? 0.9 : 0.55);
      ctx.strokeStyle = im.lethal ? "#7d2b24" : (playerColor[im.player] ?? "#3f3527");
      ctx.lineWidth = Math.max(0.8, (im.lethal ? 1.8 : 1.1) * cam.zoom);
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
    ctx.restore();
  }

  private expire(now: number): void {
    if (this.shots.length > 0) {
      this.shots = this.shots.filter((s) => now - s.born < SHOT_FLIGHT);
    }
    if (this.impacts.length > 0) {
      this.impacts = this.impacts.filter((i) => now - i.born < IMPACT_LIFE);
    }
  }

  get count(): number {
    return this.shots.length + this.impacts.length;
  }
}
