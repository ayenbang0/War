/**
 * The dead, left lying where they fell.
 *
 * In the sim a man who dies simply stops existing, which on screen meant a
 * melee ate its own casualties without trace: a scrum of forty became a scrum
 * of twelve and nothing showed where the other twenty-eight had gone. A field
 * with its fallen on it tells you where the fighting was and how it went.
 *
 * Bodies are the same silhouette the man had alive (soldier-art.ts), turned
 * across his facing, drained of colour and fading into the ground over a long
 * minute. They have no gait and no fidget: nothing on them moves, which is the
 * point. Presentation only: nothing here is read back by the simulation.
 *
 * You only see bodies where you could see the death. An enemy who died in the
 * fog leaves nothing for you to find, or the dead would map the enemy for you.
 */

import type { CombatEvent, World } from "../sim/world.ts";
import type { UnitTypeId } from "../content/unit-types.ts";
import { UNIT_TYPE_IDS } from "../content/unit-types.ts";
import type { Camera } from "./camera.ts";
import { SIZE, bodyPath, type Brush } from "./soldier-art.ts";

/** Seconds a body lies at full strength before it starts to fade. */
const LIE = 20;
/** Seconds the fade takes after that. */
const FADE = 40;
/** Oldest bodies go first past this, so a long battle stays cheap to draw. */
const MAX_BODIES = 900;

type Body = {
  x: number; y: number; a: number;
  type: UnitTypeId; player: number; born: number; phase: number;
};

const BODY_TINT: Record<number, string> = {
  0: "rgb(92, 102, 112)",
  1: "rgb(112, 88, 80)",
};
const STAIN = "rgba(74, 40, 28, 0.22)";

export class Fallen {
  private bodies: Body[] = [];

  /** Take one tick's killing blows. Call after every world.step(). */
  ingest(world: World, events: readonly CombatEvent[], viewer: number, now: number): void {
    const s = world.soldiers;
    const fog = world.fog[viewer];
    for (const e of events) {
      if (!e.lethal || e.victim < 0 || s.alive[e.victim] === 1) continue;
      const id = e.victim;
      const x = Number.isFinite(s.x[id]) ? s.x[id] : e.x1;
      const y = Number.isFinite(s.y[id]) ? s.y[id] : e.y1;
      const player = s.player[id];
      if (player !== viewer && fog.at(x, y) !== 1) continue;
      this.bodies.push({
        x, y,
        // Fallen across the way he faced, a little askew.
        a: s.facing[id] + Math.PI / 2 + ((id * 0.618) % 1 - 0.5) * 0.9,
        type: world.typeOf(id), player, born: now, phase: id * 0.618,
      });
    }
    if (this.bodies.length > MAX_BODIES) this.bodies.splice(0, this.bodies.length - MAX_BODIES);
  }

  /** How many bodies are on the field; for tests. */
  get count(): number {
    return this.bodies.length;
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, _world: World, _viewer: number, now: number): void {
    // Expire.
    let drop = 0;
    while (drop < this.bodies.length && now - this.bodies[drop].born > LIE + FADE) drop++;
    if (drop > 0) this.bodies.splice(0, drop);
    if (this.bodies.length === 0 || cam.zoom < 0.35) return;

    const b = cam.bounds();
    ctx.save();
    ctx.lineJoin = "round";
    // Fade buckets keep it to a handful of fills however many lie on the field.
    for (const bucket of [1, 0.66, 0.33]) {
      for (const player of [0, 1]) {
        for (const type of UNIT_TYPE_IDS) {
          const r = Math.max(1.4, 4.2 * cam.zoom * SIZE[type]);
          let any = false;
          ctx.beginPath();
          const stains: Brush[] = [];
          for (const d of this.bodies) {
            if (d.player !== player || d.type !== type) continue;
            const age = now - d.born;
            const life = age < LIE ? 1 : 1 - (age - LIE) / FADE;
            const q = life > 0.66 ? 1 : life > 0.33 ? 0.66 : 0.33;
            if (q !== bucket) continue;
            if (d.x < b.x0 - 40 || d.x > b.x1 + 40 || d.y < b.y0 - 40 || d.y > b.y1 + 40) continue;
            const brush: Brush = {
              ctx, x: cam.worldToScreenX(d.x), y: cam.worldToScreenY(d.y),
              // Flattened: the counter is drawn lying down, weapon at rest.
              a: d.a, r: r * 0.92, recover: 1, t: 0, phase: d.phase,
            };
            bodyPath(type, brush);
            stains.push(brush);
            any = true;
          }
          if (!any) continue;
          ctx.globalAlpha = 0.55 * bucket;
          ctx.fillStyle = BODY_TINT[player] ?? BODY_TINT[0];
          ctx.fill();
          ctx.globalAlpha = 0.5 * bucket;
          ctx.lineWidth = Math.max(0.5, r * 0.08);
          ctx.strokeStyle = "rgba(40, 32, 22, 0.7)";
          ctx.stroke();
          // A dark patch of churned earth under each, which is what makes the
          // pile read as a body rather than a dropped counter.
          ctx.beginPath();
          for (const s of stains) {
            ctx.moveTo(s.x + s.r * 1.3, s.y + s.r * 0.3);
            ctx.ellipse(s.x, s.y + s.r * 0.3, s.r * 1.3, s.r * 0.75, s.a, 0, Math.PI * 2);
          }
          ctx.globalAlpha = bucket;
          ctx.fillStyle = STAIN;
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }
}
