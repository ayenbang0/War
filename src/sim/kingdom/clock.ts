/**
 * The kingdom's clock.
 *
 * The kingdom tick is the only clock the kingdom layer has, exactly as the
 * battle tick is the only clock a battle has. It is deliberately NOT coupled to
 * the 20 Hz battle tick: one layer is live at a time (PLAN.md §B.1), and the
 * kingdom does not advance while a battle runs, so there is nothing to keep
 * in step. How many kingdom ticks run per wall-clock second (pause, 1x, 2x,
 * 4x) is a UI decision and never an order -- the sim only ever sees "one more
 * tick", which is what keeps a replay independent of how fast it was played.
 *
 * Everything coarser than a tick -- day, season, year -- is derived from the
 * tick counter, never stored, so it can never disagree with it.
 */

import { floor } from "../math.ts";
import { SEASONS, type Season } from "../../content/kingdom/terrain.ts";

/**
 * Kingdom ticks per sim day.
 *
 * Eight: a tick is three hours of marching. Fine enough that an army's
 * position on a road moves visibly between frames at 1x and two armies on one
 * road meet within a few miles of the true crossing point (K5 contact), coarse
 * enough that ten years is under ten thousand ticks.
 */
export const TICKS_PER_DAY = 8;
export const DAYS_PER_SEASON = 30;
export const SEASONS_PER_YEAR = 4;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * SEASONS_PER_YEAR;
export const TICKS_PER_YEAR = DAYS_PER_YEAR * TICKS_PER_DAY;

/**
 * The exile begins on the first day of autumn, year 1 (docs/PROVISIONAL.md).
 *
 * Act I is "survive the winter" (§A.5); starting in autumn gives one season to
 * forage and rally before the snow, which is the whole pressure of the act.
 */
export const START_DAY_OF_YEAR = 2 * DAYS_PER_SEASON;

export type CalendarDate = {
  /** Days since the exile began; day 0 is the first day. */
  readonly day: number;
  /** 1-based, as the chronicle writes it. */
  readonly year: number;
  readonly season: Season;
  /** 0-based index into SEASONS. */
  readonly seasonIndex: number;
  /** 0-based day within the season. */
  readonly dayOfSeason: number;
  /** 0-based day within the year, spring 0 = day 0. */
  readonly dayOfYear: number;
  /** 0-based tick within the day. */
  readonly tickOfDay: number;
};

/** The date at a kingdom tick. Pure: the same tick is always the same date. */
export function calendar(tick: number): CalendarDate {
  const day = floor(tick / TICKS_PER_DAY);
  const tickOfDay = tick - day * TICKS_PER_DAY;
  const absolute = START_DAY_OF_YEAR + day;
  const yearIndex = floor(absolute / DAYS_PER_YEAR);
  const dayOfYear = absolute - yearIndex * DAYS_PER_YEAR;
  const seasonIndex = floor(dayOfYear / DAYS_PER_SEASON);
  return {
    day,
    year: yearIndex + 1,
    season: SEASONS[seasonIndex],
    seasonIndex,
    dayOfSeason: dayOfYear - seasonIndex * DAYS_PER_SEASON,
    dayOfYear,
    tickOfDay,
  };
}

/** True on the first tick of a day: where daily rolls happen. */
export function isDayStart(tick: number): boolean {
  return tick % TICKS_PER_DAY === 0;
}
