/**
 * Words for K7's free companies: the tavern's market, the army card's
 * contract rows and buttons, the feed, and the sim's refusals. Plain data,
 * one place to reword (docs/ui-policy.md: text lives in tables). English
 * only; every line with a value in it is a template.
 */

import type { CompanyLeaving, Reputation } from "./mercenaries.ts";

function days(n: number): string {
  return n + (n === 1 ? " day" : " days");
}

/** Why a mercenary order is refused. The buttons show the same words. */
export const MERC_REFUSAL = {
  noSuchCompany: "there is no such company",
  notOffered: "that company is not drinking in this tavern",
  noTavern: "there is no tavern of yours standing here",
  notYourHolding: "this is not your holding",
  fee: (fee: number) => "the company asks " + fee + " coin to sign",
  notHired: "that company is not in your service",
  notInWindow: (window: number) => "a contract can only be renewed in its last " + days(window),
  arrears: "they will not sign again while wages are owed",
  renewFee: (fee: number) => "renewing costs " + fee + " coin",
  noBid: "nobody is bidding for that company",
  bid: (bid: number) => "matching the bid costs " + bid + " coin",
  companyArmy: "a free company keeps its own ranks: it does not merge, split or take recruits",
} as const;

export const REPUTATION_WORD: Record<Reputation, string> = {
  reliable: "Reliable", bloody: "Bloody", turncoats: "Turncoats",
};
export const REPUTATION_ABOUT: Record<Reputation, string> = {
  reliable: "Keep a contract while they are paid; unpaid, they walk away.",
  bloody: "Keep it, and the towns they stand in hate the king for it. Unpaid, they turn.",
  turncoats: "Cheap, and for sale to the next bidder. Unpaid, they turn.",
};

/** The tavern's market (a choice menu from the city card). */
export const MARKET = {
  button: "Free companies…",
  buttonWhy: "See who is drinking in the tavern and willing to sign.",
  title: "Free companies at the tavern",
  intro: (holding: string) => "Who drinks in " + holding + "'s tavern and will sign. A company brings its own men and arms: no levy, no barracks -- but a fee to sign, a wage every day, and no replacements.",
  none: "Nobody is drinking here who will sign today. Companies come and go: look again in a few days.",
  option: (p: { name: string; reputation: string }) => "Hire " + p.name + " (" + p.reputation + ")",
  lines: (p: { fee: number; wage: number; contract: number; men: number; squads: string; left: number }) => [
    p.fee + " coin to sign, " + p.wage + " a day; " + days(p.contract) + " contract",
    p.men + " men: " + p.squads,
    "Here " + days(p.left) + " more",
  ],
  loyalty: (n: number) => "Loyalty " + n + " of 100",
  cancel: "Leave them to their ale",
  said: (name: string) => name + " sign on.",
} as const;

/** The army card's contract rows and buttons. */
export const CONTRACT = {
  heading: "Free company",
  loyaltyLabel: "Loyalty",
  bidLabel: "Bids",
  captain: (c: string) => "Led by " + c,
  contract: (left: number) => "Contract: " + days(left) + " left",
  loyalty: (n: number, rep: string) => "Loyalty " + n + " of 100 (" + rep + ")",
  bid: (p: { bid: number; left: number }) => "The crown bids " + p.bid + " coin for them: " + days(p.left) + " to match it",
  renew: (fee: number) => "Renew (" + fee + " coin)",
  renewSaid: (name: string) => name + " sign on again.",
  match: (bid: number) => "Match the bid (" + bid + " coin)",
  matchSaid: (name: string) => name + " stay, for now.",
  dismiss: "Dismiss",
  noBid: "No one bids for them",
  sub: "A free company in the king's pay",
  dismissTitle: (name: string) => "Dismiss " + name + "?",
  dismissIntro: (p: { name: string; fee: number }) =>
    p.name + " ride away paid off: their men are not yours to send home, and a new contract would cost " + p.fee + " coin.",
  dismissYes: "Dismiss them",
  dismissKeep: "Keep them",
  dismissSaid: (name: string) => name + " are paid off and ride away.",
  turned: (name: string) => name + " · gone over to the crown",
} as const;

/** The feed: one line per mercenary event. */
export const MERC_FEED = {
  offered: (p: { name: string; holding: string }) => p.name + " are drinking in " + p.holding + "'s tavern, looking for work.",
  offerGone: (name: string) => name + " moved on from the tavern.",
  hired: (p: { name: string; fee: number }) => p.name + " sign on for " + p.fee + " coin.",
  ending: (p: { name: string; left: number }) => p.name + "'s contract ends in " + days(p.left) + ".",
  renewed: (p: { name: string; fee: number }) => p.name + " renew their contract for " + p.fee + " coin.",
  bid: (p: { name: string; bid: number }) => "The crown's agents bid " + p.bid + " coin for " + p.name + ".",
  matched: (name: string) => name + " take the king's coin over the crown's.",
  left: {
    expired: (name: string) => name + "'s contract is over: they ride away.",
    deserted: (name: string) => name + " walk away: unpaid men are no army.",
    defected: (name: string) => name + " turn their coats: unpaid, they go over to the crown!",
    poached: (name: string) => name + " take the crown's coin and its colours.",
    dismissed: (name: string) => name + " are paid off and ride away.",
    broken: (name: string) => name + " are broken: no one is left to hire.",
  } as Record<CompanyLeaving, (name: string) => string>,
} as const;
