/**
 * Words for armies on the kingdom map (K4): the sim's refusals, which the
 * army card and the recruit dialog show as each button's reason, and the
 * card's labels. Plain data; one place to reword.
 */

import { ARMY_ORDINALS } from "./armies.ts";
import { MORALE_WORDS } from "./morale-strings.ts";
import { ARMY_MORALE } from "./morale.ts";

/** Why an army order is refused. The same string disables the button and rejects the order. */
export const ARMY_REFUSAL = {
  noSuchArmy: "there is no such army",
  notYourArmy: "that army is not yours to command",
  tooManyArmies: (n: number) => "a side may field at most " + n + " armies; merge or stand one down first",
  noSuchUnit: "there is no such kind of squad",
  notLevyType: "the followers can only be formed into spearmen or slingers without a barracks",
  levyKingThere: "the king must be standing there to form his followers",
  levyTooFew: (n: number) => "it takes at least " + n + " followers to form a squad",
  needsBarracks: "trained squads are raised at a barracks, standing and kept up, in a holding of yours",
  notYourHolding: "it is not the king's",
  armyNotThere: "the army must be standing in that holding",
  tooManySquads: (n: number) => "an army may have at most " + n + " squads",
  typeCap: (name: string, n: number) => "an army may have at most " + n + " of " + name,
  needLevy: (n: number) => "it needs " + n + " followers",
  needCoin: (n: number) => "it costs " + n + " coin",
  needIron: (n: number) => "it needs " + n + " iron",
  standing: "the army must be standing in a holding, not on the road",
  sameArmy: "an army cannot do that with itself",
  splitNone: "choose some squads to part off, and leave some behind",
  splitNotHers: "those squads are not in that army",
  patrolNeedsTwo: "a patrol needs at least two holdings to walk between",
  noSuchDoctrine: "there is no such doctrine",
  sameDoctrine: "it already fights that way",
  noSuchAbility: "there is no such ability",
  abilityCap: (n: number) => "an army may hold at most " + n + " of one ability",
  abilityCost: (coin: number, legit: number) => "it takes " + coin + " coin and " + legit + " legitimacy",
  notSeen: "no one has eyes on that army now",
  interceptOwn: "that army is yours: draw from one to the other to merge them",
  alreadyThere: "the army is already there",
  splitOne: "an army of one squad cannot be split",
  kingElsewhere: "the king must be standing where the army stands",
  kingAlready: "the king already rides with that army",
  kingAlone: "the king rides with no army",
  kingRides: "the king rides with an army; command it instead",
} as const;

/** "First Army". */
export function armyName(ordinal: number): string {
  return (ARMY_ORDINALS[ordinal] ?? String(ordinal + 1) + "th") + " Army";
}

/** The pen's plates (at the pen tip while drawing) and result lines (after release), for army orders. */
export const PEN = {
  armyMarchPlate: (p: { army: string; name: string; eta: string }) => p.army + ": march to " + p.name + " · " + p.eta,
  armySetOut: (p: { army: string; name: string; eta: string }) => "The " + p.army + " sets out for " + p.name + ": " + p.eta + " by road.",
  armyQueuedOut: (p: { army: string; name: string; eta: string }) =>
    "Ordered: the " + p.army + " sets out for " + p.name + " (" + p.eta + ") when the clock runs.",
  interceptPlate: (p: { army: string; target: string }) => p.army + ": intercept the " + p.target,
  interceptDone: (p: { army: string; target: string }) => "The " + p.army + " marches to meet the " + p.target + ".",
  mergePlate: (p: { army: string; into: string }) => "Merge the " + p.army + " into the " + p.into,
  mergeDone: (p: { army: string; into: string }) => "The " + p.army + " will join the " + p.into + ".",
  joinPlate: (army: string) => "The king rides with the " + army,
  joinDone: (army: string) => "The king rides with the " + army + ".",
  splitPlate: (p: { army: string; n: number }) => "Split " + p.n + " squad" + (p.n === 1 ? "" : "s") + " off the " + p.army,
  splitDone: (p: { army: string; n: number }) => p.n + " squad" + (p.n === 1 ? "" : "s") + " part from the " + p.army + " as a new army.",
  garrisonPlate: (p: { army: string; name: string }) => p.army + ": hold " + p.name,
  garrisonDone: (p: { army: string; name: string }) => "The " + p.army + " digs in at " + p.name + ".",
  patrolPlate: (p: { army: string; n: number }) => p.army + ": patrol " + p.n + " holdings",
  patrolDone: (p: { army: string; names: string }) => "The " + p.army + " patrols " + p.names + ".",
  recoverPlate: (army: string) => army + ": rest and mend",
  recoverDone: (army: string) => "The " + army + " rests to mend its wounded.",
  refusedPlate: (why: string) => "no order: " + why,
  splitOne: "an army of one squad cannot be split",
} as const;

/** The army card (ui/kingdom/army-card.ts) and the recruit dialog. */
export const AC = {
  title: (name: string) => name,
  hostileTitle: (name: string, owner: string) => name + " of " + owner,
  ledBy: "Led by",
  ledByKing: (king: string) => king + " rides with it",
  noCaptain: "a sergeant (no captain yet)",
  doctrine: "Doctrine",
  squads: "Squads",
  strength: "Strength",
  strengthLine: (p: { men: number; full: number; fit: number }) => p.men + " men of " + p.full + " · " + p.fit + "% fit",
  supply: "Supply",
  supplyLine: (p: { grain: number; days: number }) => p.grain + " grain · " + p.days + " day" + (p.days === 1 ? "" : "s"),
  supplyHome: "fed from the stores here",
  wages: "Wages",
  wagesLine: (p: { coin: number; unpaid: number }) => p.coin + " coin a day" + (p.unpaid > 0 ? " · unpaid " + p.unpaid + " day" + (p.unpaid === 1 ? "" : "s") : ""),
  wagesNone: "none: the levy serve for bread",
  hunger: (days: number) => "Hungry " + days + " day" + (days === 1 ? "" : "s"),
  morale: "Morale",
  /** Morale is kept in the sim (K6 gives it rules); until then the card says so in words, with no number to read into. */
  /** K6: the army's spirit, and where pay, bread and the king are taking it (MORALE_WORDS). */
  moraleLine: (p: { morale: number; rest: number; falling: boolean }) => MORALE_WORDS.line(p) + (p.morale < ARMY_MORALE.desertBelow ? ". " + MORALE_WORDS.breaking : ""),
  doing: "Doing",
  posture: { none: "standing", hold: "holding, dug in", patrol: "patrolling", recover: "resting to mend" } as const,
  marching: (name: string) => "marching to " + name,
  chasing: (name: string) => "marching to meet the " + name,
  abilities: "Abilities",
  abilitiesNone: "none earned yet",
  squadRow: (p: { name: string; men: number; full: number; wounded: number; levy: boolean }) =>
    p.name + (p.levy ? " (levy)" : "") + " · " + p.men + " of " + p.full + " men" + (p.wounded > 0 ? ", " + p.wounded + " wounded" : ""),
  orders: "Orders",
  march: "March…",
  halt: "Halt",
  hold: "Hold here",
  patrol: "Patrol…",
  recover: "Rest and mend",
  split: "Split off the rear half",
  merge: "Merge into…",
  intercept: "Intercept…",
  setDoctrine: "Doctrine…",
  unlock: "Earn an ability…",
  joinKing: "King rides with it",
  leaveKing: "King rides alone",
  disband: "Stand down…",
  disbandTitle: (name: string) => "Stand down the " + name + "?",
  disbandHome: (p: { men: number; grain: number }) => "Its " + p.men + " men rejoin your followers and its " + p.grain + " grain goes to the stores.",
  disbandAway: (men: number) => "Away from your holdings its " + men + " men simply go home, and its grain with them.",
  disbandKeep: "Keep the army",
  disbandYes: "Stand it down",
  hostileNote: "Not yours: what your scouts can tell.",
  pickMarch: (name: string) => "Choose where the " + name + " marches",
  pickPatrol: (name: string) => "Choose two holdings for the " + name + " to patrol between",
  pickPatrolSecond: (first: string) => "…and the holding to walk to from " + first,
  pickMerge: (name: string) => "Choose the army the " + name + " joins",
  pickIntercept: (name: string) => "Choose the army the " + name + " marches to meet",
  pickDoctrine: (name: string) => "How the " + name + " fights",
  pickAbility: (name: string) => "An ability for the " + name,
  abilityCost: (p: { coin: number; legitimacy: number }) => p.coin + " coin, " + p.legitimacy + " legitimacy",
  // The recruit dialog at a barracks, and the levy at the king's card.
  recruitTitle: (name: string) => "Raise a squad at " + name,
  recruitIntro: "Trained squads take followers, coin and iron. Choose the army they join.",
  recruitCost: (p: { levy: number; coin: number; iron: number }) =>
    p.levy + " followers, " + p.coin + " coin" + (p.iron > 0 ? ", " + p.iron + " iron" : ""),
  recruitInto: (army: string) => "Into the " + army,
  recruitNew: "Into a new army",
  levyTitle: "Form the followers into a squad",
  levyIntro: "Men who came because the king asked: no barracks, no coin, no armour. A squad needs at least four.",
  levyCost: (n: number) => n + " followers",
  raiseLevy: "Raise followers…",
  ridesWith: "Rides with",
  ridesAlone: "no army: his party alone",
  recruitButton: "Raise squads…",
  armyRaised: (name: string, at: string) => "The " + name + " is raised at " + at + ".",
  recruited: (p: { unit: string; men: number; army: string }) => p.unit + ", " + p.men + " men, join the " + p.army + ".",
  armyGone: {
    starved: (n: string) => "The " + n + " has starved away.",
    deserted: (n: string) => "The " + n + " has melted away.",
    disbanded: (n: string) => "The " + n + " is stood down.",
    // K5: lost in battle, or cut off and taken.
    fell: (n: string) => "The " + n + " is gone: none of it came off the field.",
    captured: (n: string) => "The " + n + " was cut off and taken.",
    // K7 (a company army's leaving has its own line in MERC_FEED; this is the fallback).
    expired: (n: string) => n + " rode away at the end of their contract.",
  },
  mergedNews: (p: { army: string; into: string }) => "The " + p.army + " joins the " + p.into + ".",
  splitNews: (p: { army: string; into: string }) => "The " + p.into + " parts from the " + p.army + ".",
  intercepted: (p: { army: string; target: string }) => "The " + p.army + " meets the " + p.target + ".",
  hungry: (n: string) => "The " + n + " is going hungry; men are leaving.",
  unpaid: (n: string) => "The " + n + " has not been paid; trained men are leaving.",
  arrived: (p: { army: string; name: string }) => "The " + p.army + " reaches " + p.name + ".",
  followersLeft: (n: number) => n + " follower" + (n === 1 ? "" : "s") + " walked home from a hungry camp.",
  kingAlone: "The king rides alone again.",
  kingRidesWith: (army: string) => "The king rides with the " + army + ".",
  burnLine: (p: { wage: number; ration: number }) => "Armies: " + p.wage + " coin, " + p.ration + " grain a day",
} as const;
