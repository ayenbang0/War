/**
 * Words for the descent (K5): contact on the kingdom map, the "fight or
 * withdraw?" interstitial, what a battle means for the realm in the
 * after-action report, and the sim's refusals. Plain data, one place to
 * reword (docs/ui-policy.md: text lives in tables).
 */

import { The, agree, its } from "./army-strings.ts";

function capitalise(x: string): string {
  return x.charAt(0).toUpperCase() + x.slice(1);
}

/** Why a `resolveContact` order (or an army order during a contact) is refused. The button shows the same words. */
export const DESCENT_REFUSAL = {
  inContact: "that army has met the enemy: fight, withdraw or have it resolved first",
  noContact: "there is no meeting waiting to be settled",
  notYours: "that meeting is not the king's to settle",
  fightNeedsResult: "a battle fought needs its outcome",
  resultOnlyFought: "only a battle fought has an outcome to bring back",
  townsmenStay: "townsmen do not leave their walls",
  cutOff: "cut off: there is no road to fall back by",
  wrongBattle: "that outcome is of another battle",
  badResult: "that outcome does not fit the battle",
  townsmenOf: (name: string) => "the townsmen of " + name,
} as const;

/** The interstitial: the realm halts and asks. */
export const CONTACT = {
  // "Riders on the Harrowfield road" -- the road named for where the fight would be.
  titleField: (place: string) => "Riders on the " + place + " road",
  titleAssault: (place: string) => "The walls of " + place,
  bodyField: (p: { ours: string; theirs: string; place: string }) =>
    The(p.ours) + " " + agree(p.ours, "has", "have") + " met " + p.theirs + " near " + p.place + ". The realm waits on your word.",
  bodyAssault: (p: { ours: string; theirs: string; place: string }) =>
    The(p.ours) + " " + agree(p.ours, "stands", "stand") + " before " + p.place + ". Behind its walls, " + p.theirs + " will not open the gates.",
  bodyDefend: (p: { ours: string; theirs: string; place: string }) =>
    p.theirs + " has come to the walls of " + p.place + ", and only its townsmen stand to meet it.",
  ourSide: "Yours",
  theirSide: "Theirs",
  men: (men: number, fit: number) => men + " men (" + fit + " fit to fight)",
  morale: (m: number) => "morale " + m,
  dugIn: "dug in: they hold the ground they chose",
  // K10: the keep's siege, and what a siege is won by.
  titleKeep: (place: string) => "The keep of " + place,
  bodyKeep: (p: { ours: string; theirs: string; place: string }) =>
    "The townsmen of " + p.place + " have given up the town and hold the keep. " + p.theirs + " is at its gate.",
  battered: (pct: number) => "its walls " + pct + "% down",
  siegeAttack: (p: { men: number; minutes: number }) =>
    "A siege: get " + p.men + " men inside the walls at once, or break the garrison, within " + p.minutes + " minutes. Batter a breach or force the gate.",
  siegeDefend: (p: { men: number; minutes: number }) =>
    "A siege: hold for " + p.minutes + " minutes. If " + p.men + " of theirs stand inside the walls at once, the walls are lost. Your gates open and shut with G.",
  walls: { none: "", palisade: "behind a palisade", wall: "behind a stone wall", keep: "behind a keep's walls" },
  fight: "Fight",
  fightHint: "Lead the battle yourself. Your army is drawn up; place it and begin.",
  withdraw: "Withdraw",
  withdrawHint: (men: number, morale: number) =>
    "Fall back the way you came. A rearguard of " + men + " stays to cover it; morale falls by " + morale + ".",
  withdrawNo: (why: string) => "Cannot withdraw: " + why + ".",
  auto: "Resolve for me",
  autoHint: "A sergeant fights it without you. Quick, but costlier than leading it yourself.",
  dialogLabel: "Contact: fight or withdraw?",
} as const;

/** The after-action report's kingdom section, and the confirm for leaving a story battle. */
export const DESCENT = {
  heading: "What it means for the realm",
  survivors: (p: { army: string; men: number; was: number; wounded: number }) =>
    The(p.army) + ": " + p.men + " of " + p.was + " men came back" + (p.wounded > 0 ? ", " + p.wounded + " of them wounded." : "."),
  armyLost: (army: string) => "The " + army + " is gone: none of it came off the field.",
  fallsBack: (p: { army: string; to: string }) => The(p.army) + " " + agree(p.army, "falls", "fall") + " back toward " + p.to + ".",
  cutOff: (army: string) => "The " + army + " is cut off and taken.",
  townsmen: (p: { name: string; lost: number }) => p.name + " lost " + p.lost + " of its people on the walls.",
  stormed: (p: { name: string; by: string }) => p.name + " is taken by " + p.by + ".",
  sacked: (p: { name: string; n: number }) =>
    "The sack of " + p.name + " left " + p.n + " of its buildings standing idle.",
  wallsDamaged: (p: { name: string; pct: number; down: number }) =>
    "The siege knocked down " + p.pct + "% of the walls of " + p.name + " (" + p.down + "% down now): they stay down until they are mended in the town.",
  legitimacyUp: (n: number) => "Word of it spreads: legitimacy +" + n + ".",
  legitimacyDown: (n: number) => "Word of it spreads: legitimacy -" + n + ".",
  morale: (p: { army: string; morale: number }) => capitalise(its(p.army)) + " morale is now " + p.morale + ".",
  backToMap: "Back to the map",
  leaveTitle: "Leave the field?",
  leaveBody:
    "Leaving now counts as a withdrawal under fire: the men lost so far stay lost, a rearguard is spent covering the retreat, " +
    "and the army falls back. If there is no road to fall back by, it is taken.",
  leaveYes: "Leave the field",
  leaveNo: "Keep fighting",
} as const;

/** The feed's lines for contact news. */
export const CONTACT_FEED = {
  met: (p: { ours: string; theirs: string }) => The(p.ours) + " " + agree(p.ours, "meets", "meet") + " " + p.theirs + ".",
  walls: (p: { ours: string; place: string }) => The(p.ours) + " " + agree(p.ours, "comes", "come") + " to the walls of " + p.place + ".",
  won: (army: string) => "The " + army + " holds the field.",
  lost: (army: string) => "The " + army + " is beaten.",
  drawn: (army: string) => "The " + army + "'s battle is undecided.",
  withdrew: (army: string) => "The " + army + " withdraws.",
  fellBack: (p: { army: string; to: string }) => The(p.army) + " " + agree(p.army, "falls", "fall") + " back toward " + p.to + ".",
  stormed: (p: { name: string; by: string }) => p.name + " is stormed by " + p.by + ".",
  distant: (p: { a: string; b: string; winner: string }) => "Word comes of a fight between " + p.a + " and " + p.b + ": " + p.winner + " held the field.",
} as const;
