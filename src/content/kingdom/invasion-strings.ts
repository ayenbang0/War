/**
 * Words for K8: the rumour card (warning of a host riding at one of the
 * king's holdings), the defence tools it offers, the defender's two new
 * choices at the contact interstitial (KD-05), the sim's refusals, and the
 * feed. Plain data, one place to reword (docs/ui-policy.md).
 */

/** Why a K8 order is refused. The buttons show the same words. */
export const INVASION_REFUSAL = {
  notYours: "that holding is not yours",
  noSuchHolding: "there is no such holding",
  tooFew: "too few people are left there to answer a levy call",
  calledLately: (days: number) => "its people were called out lately; they can be called again in " + days + " days",
  armyCap: (n: number) => "you already have " + n + " armies in the field",
  nothingToBurn: "there is nothing in the ground there to burn",
  burning: "its fields are already burned",
  noArmy: "there is no such army of yours",
  ambushOnRoad: "an ambush is laid in a holding, not on the open road",
  ambushMarching: "halt the army first: an ambush is laid by men standing still",
  alreadyAmbush: "that army already lies in wait",
  // The defender's choices (KD-05).
  yieldOnlyWalls: "only townsmen behind their walls can open the gates",
  noKeep: (name: string) => name + " has no keep or stone wall to retreat behind",
} as const;

/** The rumour card. */
export const RUMOUR = {
  // "Riders seen on the Lisle road, 3 days out" (PLAN §B.8, verbatim in shape).
  title: (road: string, days: number) =>
    "Riders seen on the " + road + " road, " + (days <= 0 ? "at the gates" : days === 1 ? "a day out" : days + " days out"),
  body: (p: { theirs: string; target: string; men: string }) =>
    "Word comes that " + p.theirs + " rides for " + p.target + ", " + p.men + ". What will you do?",
  menGuess: (men: number) => men > 0 ? "some " + men + " strong" : "strength unknown",
  heard: (p: { source: string }) => "You hear of it from " + p.source + ".",
  sourceSeen: "your own men, who can see them",
  sourceTowers: "the watch on your towers and your scouts",
  sourceTalk: "travellers on the road",
  dialogLabel: "Rumour: a host rides at your holding",
  levy: "Call the levy",
  levyHint: (men: number) => "Turn out " + men + " of the townsmen now, as levy squads: raw men, but there today. The town will not like it.",
  burn: "Burn the fields",
  burnHint: "Burn what is in the ground so no army can live off it there. The people lose their own bread too.",
  ambush: "Lay an ambush",
  ambushHint: (army: string) => "The " + army + " lies in wait where it stands: hidden, and it strikes first.",
  defend: "March to defend",
  defendHint: (army: string) => "Send the " + army + " to stand in the town.",
  dismiss: "Let it come",
  dismissHint: "Do nothing yet. The realm goes on.",
  no: (why: string) => "Not possible: " + why + ".",
  noArmyThere: (place: string) => "no army of yours stands in " + place,
  noArmyToSend: "you have no army free to send",
  heldClock: "The realm waits while you decide.",
  dismissKey: "Esc does the same.",
  more: (n: number) => n === 1 ? "One more rumour waits after this." : n + " more rumours wait after this.",
} as const;

/** The defender's two choices at a holding's walls (docs/audit/k5-descent.md KD-05). */
export const DEFEND = {
  yield: "Open the gates",
  yieldHint: (legitimacy: number) => "Yield the town without a fight. No one dies; legitimacy -" + legitimacy + ".",
  keep: "Retreat to the keep",
  keepHint: "Give up the town and hold the keep. A siege follows (it is resolved for you for now); the town outside is sacked.",
} as const;

/** The feed. */
export const INVASION_FEED = {
  rumour: (p: { theirs: string; target: string; days: number }) =>
    "Riders of " + p.theirs + " are said to be riding for " + p.target + ", " + p.days + " days out.",
  levied: (p: { place: string; men: number }) => p.place + " turns out " + p.men + " men at the call.",
  burned: (place: string) => "The fields of " + place + " are burned.",
  ambush: (army: string) => "The " + army + " lies in wait.",
  seized: (p: { place: string; by: string }) => p.place + " is taken by " + p.by + ": there was no one to hold it.",
  yielded: (p: { place: string; by: string }) => p.place + " opens its gates to " + p.by + ".",
  siege: (p: { place: string; held: boolean }) => p.held ? "The keep of " + p.place + " holds." : "The keep of " + p.place + " falls.",
  wave: (theirs: string) => "It is said " + theirs + " has called its men to arms.",
} as const;
