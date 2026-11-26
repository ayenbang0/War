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
 * enough that ten years is a few tens of thousands of ticks.
 */
export const TICKS_PER_DAY = 8;

/**
 * ECON (owner, 2026-11-25: "the years in the game should be actual 12 month
 * years rather than the fake 4 month ones"): a year is twelve months of
 * thirty days, three months to a season (docs/PROVISIONAL.md ECON.1). K1's
 * year was four thirty-day seasons -- each season one month long -- so every
 * number keyed to the season's length (crop growth, storage, the story's
 * waves) was scaled by three with it; numbers that are durations of a deed
 * (a march, a building's works, a festival, wages a day) were not.
 */
export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_SEASON = 3;
export const SEASONS_PER_YEAR = 4;
export const MONTHS_PER_YEAR = MONTHS_PER_SEASON * SEASONS_PER_YEAR;
export const DAYS_PER_SEASON = DAYS_PER_MONTH * MONTHS_PER_SEASON;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * SEASONS_PER_YEAR;
export const TICKS_PER_YEAR = DAYS_PER_YEAR * TICKS_PER_DAY;

/**
 * The exile begins on the first day of autumn, year 1 (docs/PROVISIONAL.md).
 *
 * Act I is "survive the winter" (§A.5); starting in autumn gives one season to
 * forage and rally before the snow, which is the whole pressure of the act.
 * The year runs spring, summer, autumn, winter (SEASONS), so autumn's first
 * day is day 180 of the year: 1 Harvestmoon.
 *
 * A realm's own start is its `epoch` (KingdomWorld.epoch): this for every new
 * game, and whatever a save from the old four-month calendar converts to
 * (save.ts migrate8to9), so its date reads the same season and year.
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
  /** 0-based month of the year (content/kingdom/terrain.ts MONTHS), the first of spring = 0. */
  readonly month: number;
  /** 0-based day within the month. */
  readonly dayOfMonth: number;
  /** Days since day 0 of year 1: the realm's calendar position, for dates set in the calendar (K8's waves). */
  readonly absoluteDay: number;
  /** 0-based tick within the day. */
  readonly tickOfDay: number;
};

/**
 * The date at a kingdom tick, for a realm that began on day `epoch` of year 1
 * (default: the first day of autumn). Pure: the same tick is always the same date.
 */
export function calendar(tick: number, epoch: number = START_DAY_OF_YEAR): CalendarDate {
  const day = floor(tick / TICKS_PER_DAY);
  const tickOfDay = tick - day * TICKS_PER_DAY;
  const absolute = epoch + day;
  const yearIndex = floor(absolute / DAYS_PER_YEAR);
  const dayOfYear = absolute - yearIndex * DAYS_PER_YEAR;
  const seasonIndex = floor(dayOfYear / DAYS_PER_SEASON);
  const month = floor(dayOfYear / DAYS_PER_MONTH);
  return {
    day,
    year: yearIndex + 1,
    season: SEASONS[seasonIndex],
    seasonIndex,
    dayOfSeason: dayOfYear - seasonIndex * DAYS_PER_SEASON,
    dayOfYear,
    month,
    dayOfMonth: dayOfYear - month * DAYS_PER_MONTH,
    absoluteDay: absolute,
    tickOfDay,
  };
}

/** Days from `date` to the first day of the next `season` (0 if today is that day). */
export function daysUntilSeason(date: CalendarDate, season: Season): number {
  const target = SEASONS.indexOf(season) * DAYS_PER_SEASON;
  return (target - date.dayOfYear + DAYS_PER_YEAR) % DAYS_PER_YEAR;
}

/**
 * The old four-month calendar (K1-K8 saves, version 8 and before): four
 * seasons of thirty days, the exile beginning on day 60 of its year. Kept
 * only so a save can convert its date (save.ts migrate8to9).
 */
export const OLD_DAYS_PER_SEASON = 30;
export const OLD_START_DAY_OF_YEAR = 60;

/**
 * The epoch that gives an old save's day `day` the same year, season and
 * place in the season under the new calendar: day d of an old thirty-day
 * season is day 3d of a ninety-day one. Only the date the realm stands on
 * is converted -- the days already lived stay lived (`now` and the order log
 * do not move) -- so from here on the realm runs on the new calendar.
 */
export function epochForOldDay(day: number): number {
  const abs = OLD_START_DAY_OF_YEAR + day;
  const oldYear = floor(abs / (OLD_DAYS_PER_SEASON * SEASONS_PER_YEAR));
  const oldDayOfYear = abs - oldYear * OLD_DAYS_PER_SEASON * SEASONS_PER_YEAR;
  const scale = DAYS_PER_SEASON / OLD_DAYS_PER_SEASON;
  const newAbs = oldYear * DAYS_PER_YEAR + oldDayOfYear * scale;
  return newAbs - day;
}

/** True on the first tick of a day: where daily rolls happen. */
export function isDayStart(tick: number): boolean {
  return tick % TICKS_PER_DAY === 0;
}
