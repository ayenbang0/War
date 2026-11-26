/**
 * Auto-resolve (PLAN.md §B.9): a battle settled in the abstract, on the
 * kingdom's `autoresolve` rng stream, for a meeting of two of the machine's
 * sides and for the player's "resolve for me".
 *
 * The model is deliberately small -- it is a stand-in for a battle nobody
 * watches, not a second combat system:
 *
 *  - A side's power is its fit men weighted by what each kind of man costs to
 *    field (UNIT_TYPES cost per soldier), times its nerve (0.5 at morale 0, 1
 *    at morale 100). A defender behind walls or dug in counts for more
 *    (content/kingdom/descent.ts AUTORESOLVE).
 *  - Exactly two draws, always, whatever happens: one picks the winner with
 *    odds p0^2 : p1^2 (Lanchester's square law, the textbook reading of
 *    ranged and massed fights), the other how costly it was. A fixed count of
 *    draws means one resolve never shifts what the next one rolls.
 *  - The loser loses between 30% and 60% of its fit men, the winner between
 *    5% and 25%; the more lopsided the fight, the cheaper for the winner and
 *    the dearer for the loser. Half of those lost are dead, half come home
 *    wounded.
 *
 * "Strictly worse in expectation than fighting it yourself" (§B.9): for the
 * player the same fight is resolved with the king's side at
 * AUTORESOLVE.playerPower of its strength and AUTORESOLVE.playerLosses of
 * its losses -- a sergeant's battle, not the king's. With the same draws the
 * player's outcome is never better than the even-handed resolve and is
 * worse on average (tools/kingdom-descent.ts proves both, over many seeds):
 * the winner is monotone in power, and a loss always costs more than any win.
 * The even-handed resolve is the stand-in for "the battle as the player could
 * fight it" (docs/PROVISIONAL.md K5.11).
 */

import { max, min, round } from "../math.ts";
import type { Rng } from "../rng.ts";
import { UNIT_TYPES } from "../../content/unit-types.ts";
import { KING_PLAYER } from "../../content/kingdom/factions.ts";
import { AUTORESOLVE, AUTORESOLVE_WALLS, LOSS_LEGITIMACY, WALLS_DOWN, WIN_LEGITIMACY } from "../../content/kingdom/descent.ts";
import type { BattleResult, BattleSpec, ResultSquad } from "../layers.ts";

/** A side's fighting strength for the auto-resolve (before walls and the sergeant's penalty). */
export function sidePower(spec: BattleSpec, side: number): number {
  const s = spec.sides[side];
  let p = 0;
  for (const q of s.squads) {
    const u = UNIT_TYPES[q.unit];
    p += (q.men - q.wounded) * (u.cost / u.soldiers);
  }
  return p * (0.5 + s.morale / 200);
}

/** Both sides' power as the auto-resolve weighs them. */
export function resolvePowers(spec: BattleSpec, forPlayer: boolean): [number, number] {
  const p: [number, number] = [sidePower(spec, 0), sidePower(spec, 1)];
  const d = 1 - spec.deployment.attacker;
  p[d] *= AUTORESOLVE.walls[spec.terrain.fortification] * (spec.deployment.ambush ? AUTORESOLVE.dugIn : 1);
  if (forPlayer && spec.sides[0].faction === KING_PLAYER) p[0] *= AUTORESOLVE.playerPower;
  return p;
}

/**
 * Settle a battle without fighting it. `forPlayer`: the king asked for it
 * ("resolve for me"), so his side fights under a sergeant. Pure apart from
 * the two draws it always takes from `rng`.
 */
export function autoResolve(spec: BattleSpec, rng: Rng, forPlayer: boolean): BattleResult {
  const uWin = rng.nextFloat();
  const uCost = rng.nextFloat();
  const [p0, p1] = resolvePowers(spec, forPlayer);
  const sq0 = p0 * p0;
  const sq1 = p1 * p1;
  const win0 = sq0 + sq1 === 0 ? 0.5 : sq0 / (sq0 + sq1);
  // Nobody fit on either side: nobody wins and nobody is hurt.
  const nobody = p0 === 0 && p1 === 0;
  const winner: number = nobody ? -1 : uWin < win0 ? 0 : 1;
  const powers = [p0, p1];
  const share = [0, 0];
  if (winner >= 0) {
    const loser = 1 - winner;
    // How lopsided it was, 0..1, from the winner's side: 0.5 an even fight.
    const edge = powers[winner] / (powers[winner] + powers[loser]);
    const t = 0.5 * edge + 0.5 * uCost;
    const [l0, l1] = AUTORESOLVE.loserLoss;
    const [w0, w1] = AUTORESOLVE.winnerLoss;
    share[loser] = l0 + (l1 - l0) * t;
    share[winner] = w1 - (w1 - w0) * t;
  }
  if (forPlayer && spec.sides[0].faction === KING_PLAYER) share[0] = min(1, share[0] * AUTORESOLVE.playerLosses);
  const squads: [ResultSquad[], ResultSquad[]] = [[], []];
  for (let side = 0; side < 2; side++) {
    for (const q of spec.sides[side].squads) {
      const fit = q.men - q.wounded;
      const lost = min(fit, round(fit * share[side]));
      const dead = round(lost * AUTORESOLVE.deadShare);
      const men = q.men - dead;
      squads[side].push({ squad: q.squad, men, wounded: min(men, q.wounded + (lost - dead)) });
    }
  }
  const morale: [number, number] = [spec.sides[0].morale, spec.sides[1].morale];
  if (winner >= 0) {
    morale[winner] = min(100, morale[winner] + AUTORESOLVE.winnerMorale);
    morale[1 - winner] = max(0, morale[1 - winner] - AUTORESOLVE.loserMorale);
  }
  // K10: a siege nobody watched still batters the walls -- a share of their
  // strength by who won, placed in its range by the cost draw already taken
  // (so the resolve still draws exactly two numbers).
  let walls = 0;
  if (spec.terrain.fortification !== "none" && winner >= 0) {
    const [lo, hi] = winner === spec.deployment.attacker ? AUTORESOLVE_WALLS.stormed : AUTORESOLVE_WALLS.held;
    walls = min(WALLS_DOWN - spec.terrain.worn, max(0, round(lo + (hi - lo) * uCost)));
  }
  const king = spec.sides[0].faction === KING_PLAYER;
  return {
    contact: spec.contact,
    winner,
    squads,
    morale,
    fled: [winner === 1, winner === 0],
    left: [false, false],
    damage: { crops: 0, buildings: 0, walls },
    legitimacy: !king ? 0 : winner === 0 ? WIN_LEGITIMACY : winner === 1 ? -LOSS_LEGITIMACY : 0,
  };
}
