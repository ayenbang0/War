/**
 * How fast the kingdom runs in real time: pause and 1x/2x/4x (PLAN.md §B.5).
 *
 * UI state, never an order and never saved: the sim only ever sees "one more
 * tick" (docs/kingdom.md, "Time"), so a replay does not care how fast it was
 * played. This class only answers "how many kingdom ticks are due now", from
 * real elapsed seconds, with a fixed-step accumulator like the battle's -- so
 * the rate is the same at 30 Hz and at 144 Hz, and a slow frame catches up
 * rather than slowing the realm down (up to a cap, so a tab that slept for an
 * hour does not run a season in one frame).
 *
 * DOM-free, so tools/kingdom-headless.ts can hold it to the speeds it claims.
 */

import { TICKS_PER_DAY } from "../sim/kingdom/clock.ts";

/**
 * 1x: one day every real second (docs/kingdom.md; PROVISIONAL K1.2, ECON.1).
 * ECON: was two seconds when a year was 120 days; with the twelve-month year
 * a year at 1x is six minutes (it was four), a season a minute and a half.
 */
export const DAY_SECONDS_AT_1X = 1;
export const TICKS_PER_SECOND_AT_1X = TICKS_PER_DAY / DAY_SECONDS_AT_1X;

export type KingdomSpeed = 1 | 2 | 4 | 8;
export const KINGDOM_SPEEDS: readonly KingdomSpeed[] = [1, 2, 4, 8];

export type KingdomRun = "running" | "paused";

/** The most ticks one frame may run: a day at 4x is 8 ticks, so this is a few frames' worth. */
export const MAX_TICKS_PER_FRAME = 24;

export class KingdomClock {
  run: KingdomRun = "running";
  speed: KingdomSpeed = 1;
  /** Fraction of the next tick already elapsed, 0..1: the renderer's interpolation alpha. */
  carry = 0;

  get ticksPerSecond(): number {
    return TICKS_PER_SECOND_AT_1X * this.speed;
  }

  /**
   * Real seconds have passed; how many ticks should run now? `held` is true
   * while a screen on the stack holds the sim (a confirm dialog): time stops
   * exactly as if paused, without changing what the player chose.
   */
  advance(dtReal: number, held: boolean): number {
    if (this.run === "paused" || held) return 0;
    this.carry += Math.max(0, dtReal) * this.ticksPerSecond;
    // The epsilon absorbs binary rounding: 120 frames of 1/60 s at 1x sum
    // to 7.9999999 ticks, and a plain floor would lose the eighth -- a day
    // every 2 s would quietly become a day every 2.0167 s.
    let n = Math.floor(this.carry + 1e-9);
    this.carry = Math.max(0, this.carry - n);
    if (n > MAX_TICKS_PER_FRAME) {
      n = MAX_TICKS_PER_FRAME;
      this.carry = 0;
    }
    return n;
  }

  togglePause(): void {
    this.run = this.run === "paused" ? "running" : "paused";
  }

  /** Choosing a speed also resumes: pressing 2x means "go, at 2x". */
  setSpeed(s: KingdomSpeed): void {
    this.speed = s;
    this.run = "running";
  }

  /** Ticks for one `.` press: a whole day, and only while paused. */
  stepDay(): number {
    return this.run === "paused" ? TICKS_PER_DAY : 0;
  }
}
