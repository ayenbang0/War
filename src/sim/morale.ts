/**
 * Morale, per squad and army-wide.
 *
 * Global morale is the only value that decides the match (spec section 7.2),
 * and it is a strength-weighted average rather than a plain one: a wiped-out
 * squad sitting at zero should not drag the army down as hard as a full
 * twenty-man line breaking, and a lone surviving skirmisher should not prop the
 * average up either.
 */

import { clamp } from "./math.ts";

/**
 * Morale lost for losing the WHOLE squad, apportioned per casualty.
 *
 * Expressed against the roster fraction rather than a flat per-man figure: a
 * flat rate has to be tuned for one squad size and is wrong for every other,
 * and at any rate small enough not to shatter a ten-man troop it left a
 * twenty-man line shrugging off half its strength.
 */
export const SHOCK_PER_CASUALTY = 1.2;
/**
 * Morale gained for killing a squad's worth of enemies, apportioned per kill.
 *
 * Deliberately a quarter of the shock. Winning steadies troops; it does not
 * make losses free. Set these close together and an even trade RAISES morale,
 * which is how 144 men died in an even battle with both armies still reading
 * 100% -- casualties have to dominate or morale stops meaning anything.
 */
export const HEART_PER_KILL = 0.3;
/** Morale drained per second while being flanked. */
export const FLANK_DRAIN = 0.09;
/**
 * Extra shock, per roster fraction, for men cut down from outside the front.
 *
 * A burst rather than a drain, and on top of the ordinary casualty shock. Being
 * got around is qualitatively worse than being beaten from the front: it is the
 * thing that actually breaks a formation, and a slow per-second trickle never
 * conveyed that. This is what makes a well-executed flank decisive rather than
 * merely efficient, and so what makes manoeuvring worth the trouble.
 */
export const FLANK_SHOCK_PER_CASUALTY = 1.1;
/** Morale drained per second while locally outnumbered. */
export const OUTNUMBER_DRAIN = 0.07;
/** Morale recovered per second while out of contact. */
export const REST_RECOVERY = 0.012;
/** Ceiling that resting alone can restore. Only recover reaches full. */
export const REST_CEILING = 0.72;
/** Bonus morale per second for holding high or fortified ground. */
export const GROUND_BONUS = 0.02;
/** Below this, the army routs and the match ends. */
export const ROUT_THRESHOLD = 0.1;
/**
 * Below this, a single COMPANY is considered broken.
 *
 * Deliberately far above the army threshold. A company whose nerve is at a
 * quarter has stopped being a fighting body long before the army as a whole is
 * routing, and the after-action report is about the moment it stopped holding,
 * not the moment the match ended.
 */
export const COMPANY_BREAK = 0.28;

export type MoraleInputs = {
  /** Soldiers lost this tick. */
  readonly casualties: number;
  /** Enemies killed this tick. */
  readonly kills: number;
  /** Of the casualties, how many fell to blows from outside the front. */
  readonly flankCasualties: number;
  /** Living soldiers, before this tick's casualties. */
  readonly strength: number;
  /** Full-strength roster size. */
  readonly roster: number;
  readonly flanked: boolean;
  readonly outnumbered: boolean;
  readonly inContact: boolean;
  /** Terrain cover fraction under the squad. */
  readonly cover: number;
  readonly dt: number;
  /** Doctrine multiplier on casualty shock. Below 1 means steadier troops. */
  readonly resolve: number;
};

/** One tick of morale change for a squad. */
export function nextMorale(current: number, i: MoraleInputs): number {
  let m = current;

  // Both scale by roster fraction: losing three men out of ten is a rout in
  // the making, losing three out of twenty is a bad morning.
  if (i.roster > 0) {
    if (i.casualties > 0) m -= SHOCK_PER_CASUALTY * i.resolve * (i.casualties / i.roster);
    if (i.flankCasualties > 0) {
      m -= FLANK_SHOCK_PER_CASUALTY * i.resolve * (i.flankCasualties / i.roster);
    }
    if (i.kills > 0) m += HEART_PER_KILL * (i.kills / i.roster);
  }

  if (i.flanked) m -= FLANK_DRAIN * i.dt;
  if (i.outnumbered) m -= OUTNUMBER_DRAIN * i.dt;
  if (i.cover > 0) m += GROUND_BONUS * i.cover * i.dt;

  // Out of contact a squad steadies itself, but only so far. Standing down to
  // recover is the only way back to full, and that costs 30 helpless seconds.
  if (!i.inContact && m < REST_CEILING) {
    m += REST_RECOVERY * i.dt;
    if (m > REST_CEILING) m = REST_CEILING;
  }

  return clamp(m, 0, 1);
}

/**
 * Army morale: squad morale weighted by each squad's ORIGINAL roster.
 *
 * Weighting by current strength is the obvious choice and it is wrong. A squad
 * that gets wiped out falls to zero morale and, at the same instant, to zero
 * weight -- so it drops clean out of the average and destroying an enemy squad
 * outright barely moves their army morale at all. Weighting by the roster keeps
 * the dead on the books, which is the point: losing a whole squad is one of the
 * heaviest things that can happen to an army's nerve.
 */
export function globalMorale(
  squadMorale: readonly number[],
  squadRoster: readonly number[],
): number {
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < squadMorale.length; i++) {
    weighted += squadMorale[i] * squadRoster[i];
    total += squadRoster[i];
  }
  return total > 0 ? weighted / total : 0;
}
