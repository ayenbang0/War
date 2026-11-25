/**
 * The story's shared vocabulary (PLAN.md §A.5, §A.6; phase K9): the
 * conditions an act, a letter or an ending is gated on, the effects a story
 * choice has, and the flags the story remembers.
 *
 * Written ahead of K9, which wires it up. Plain data only: K9's evaluator
 * reads a condition against the kingdom state and applies an effect through
 * the sim's own paths (the ledger for stocks and legitimacy, the order queue
 * for a battle), so nothing here can move a hash by itself.
 *
 * The effect union is the K3a event vocabulary (events.ts `EventEffect`)
 * extended ADDITIVELY: every K3a effect means here exactly what it means on an
 * exploration card, and the new kinds only add what a story beat needs
 * (mercy, flags, mercenaries, a battle, a holding that opens its gates). The
 * K3a union itself is untouched, so the exploration sim's exhaustive switch
 * never sees a kind it does not know.
 *
 * Validation lives in validate-story.ts; every id named here is checked
 * against the map, the factions, the levels and the other story tables.
 */

import type { AbilityId } from "../abilities.ts";
import type { FactionId } from "../kingdom/factions.ts";
import type { ProvinceId } from "../kingdom/map.ts";
import type { Season } from "../kingdom/terrain.ts";
import type { EventEffect } from "./events.ts";

// -- the two soft stats a story choice moves (PLAN.md §A.4) -------------------------

/**
 * Mercy/Terror: how the king treats the conquered. One number, mercy up and
 * terror down, kept in MERCY_MIN..MERCY_MAX and starting at 0 (neither yet).
 * Legitimacy keeps its K3 range, 0..LEGITIMACY_MAX (economy.ts).
 * PROVISIONAL (docs/PROVISIONAL.md K9s.1).
 */
export const MERCY_MIN = -100;
export const MERCY_MAX = 100;
export const MERCY_START = 0;

/** The four acts of §A.5. */
export type ActId = 1 | 2 | 3 | 4;
export const ACT_IDS: readonly ActId[] = [1, 2, 3, 4];

/** A province a condition can name, or any province at all. */
export type ProvinceRef = ProvinceId | "any";

// -- conditions ---------------------------------------------------------------------

/**
 * A checkable fact about the kingdom. Every kind is answerable from the
 * kingdom state plus the story's own record (flags, encounters fought, the
 * act reached); none needs a roll, so evaluating one never touches a stream.
 *
 *   holdingsHeld          the king owns at least n holdings
 *   holdingHeld           the king owns this holding (by map key)
 *   seatHeld              the king owns this province's seat
 *   shareHeldAtLeast      the king owns at least pct % of the map's holdings
 *   followersAtLeast      the party's levy is at least n
 *   legitimacyAtLeast / legitimacyBelow
 *   mercyAtLeast / mercyBelow
 *   captainDefeated       the king has won a battle against this faction
 *   encounterFought       a scripted encounter has been fought (won or lost)
 *   encounterWon          ...and won
 *   holdRegionThroughSeason  the king held every holding they owned in the
 *                         province (at least one, and its seat if it has
 *                         one) from the first day of a season to the last,
 *                         `seasons` times running
 *   winterSurvived        a winter has ended with the king alive
 *   season                it is this season now
 *   daysPassed            at least n days since the exile began
 *   battlesWon            the king has won at least n battles of any kind
 *   wagesOwedDays         some hired company has gone unpaid n days (K7)
 *   companyHired          this free company is on contract now
 *   actAtLeast            the story has reached this act
 *   roadToCrownSeat       the king owns a holding joined by a road to the Crown Seat
 *   rimarosTaken          the king owns the Crown Seat
 *   kingLost              the king has been captured or slain (B.12.5: the run ends)
 *   flag / notFlag        a story flag is (not) set
 *   all / any             every / at least one of
 */
export type StoryCondition =
  | { readonly kind: "holdingsHeld"; readonly n: number }
  | { readonly kind: "holdingHeld"; readonly holding: string }
  | { readonly kind: "seatHeld"; readonly province: ProvinceId }
  | { readonly kind: "shareHeldAtLeast"; readonly pct: number }
  | { readonly kind: "followersAtLeast"; readonly n: number }
  | { readonly kind: "legitimacyAtLeast"; readonly n: number }
  | { readonly kind: "legitimacyBelow"; readonly n: number }
  | { readonly kind: "mercyAtLeast"; readonly n: number }
  | { readonly kind: "mercyBelow"; readonly n: number }
  | { readonly kind: "captainDefeated"; readonly id: FactionId }
  | { readonly kind: "encounterFought"; readonly encounter: string }
  | { readonly kind: "encounterWon"; readonly encounter: string }
  | { readonly kind: "holdRegionThroughSeason"; readonly province: ProvinceRef; readonly seasons: number }
  | { readonly kind: "winterSurvived" }
  | { readonly kind: "season"; readonly season: Season }
  | { readonly kind: "daysPassed"; readonly n: number }
  | { readonly kind: "battlesWon"; readonly n: number }
  | { readonly kind: "wagesOwedDays"; readonly n: number }
  | { readonly kind: "companyHired"; readonly company: string }
  | { readonly kind: "actAtLeast"; readonly act: ActId }
  | { readonly kind: "roadToCrownSeat" }
  | { readonly kind: "rimarosTaken" }
  | { readonly kind: "kingLost" }
  | { readonly kind: "flag"; readonly flag: string }
  | { readonly kind: "notFlag"; readonly flag: string }
  | { readonly kind: "all"; readonly of: readonly StoryCondition[] }
  | { readonly kind: "any"; readonly of: readonly StoryCondition[] };

// -- effects ------------------------------------------------------------------------

/**
 * What a story choice does. The K3a kinds (gain, pay, lose, legitimacy,
 * upgrade, reveal) are unchanged; added:
 *
 *   mercy          Mercy/Terror moves by a whole 1..10 either way
 *   flag / unflag  set / clear a story flag (flags.ts)
 *   unlockAbility  a commander's ability becomes available to the king's
 *                  armies (B.4: abilities are kingdom-earned)
 *   hire           a free company (mercenaries.ts) signs on; its fee is a
 *                  separate `pay` on the same choice, so the card can show it
 *   companyLeaves  a company goes: its contract ends, it deserts, or it
 *                  defects to the crown
 *   loyalty        a hired company's loyalty moves (K7, 0..100)
 *   battle         a scripted encounter (encounters.ts) is fought now
 *   giveHolding    a holding opens its gates to the king without a battle
 *   loseHolding    a holding the king owns is lost to a faction (or to nobody)
 *   unrest         unrest in a province's holdings moves (K6), whole 1..20
 *   captainSworn   a defeated captain swears to the king; what that gives is
 *                  K8's to decide (their holdings stop fighting the king)
 *   followUp       another letter arrives after `days` days (a letter may
 *                  follow itself: "not yet" brings the same choice back)
 */
export type StoryOnlyEffect =
  | { readonly kind: "mercy"; readonly delta: number }
  | { readonly kind: "flag"; readonly flag: string }
  | { readonly kind: "unflag"; readonly flag: string }
  | { readonly kind: "unlockAbility"; readonly ability: AbilityId }
  | { readonly kind: "hire"; readonly company: string }
  | { readonly kind: "companyLeaves"; readonly company: string; readonly how: "expired" | "deserted" | "defected" }
  | { readonly kind: "loyalty"; readonly company: string; readonly delta: number }
  | { readonly kind: "battle"; readonly encounter: string }
  | { readonly kind: "giveHolding"; readonly holding: string }
  | { readonly kind: "loseHolding"; readonly holding: string; readonly to: FactionId | null }
  | { readonly kind: "unrest"; readonly province: ProvinceRef; readonly delta: number }
  | { readonly kind: "captainSworn"; readonly faction: FactionId }
  | { readonly kind: "followUp"; readonly letter: string; readonly days: number };

export type StoryEffect = EventEffect | StoryOnlyEffect;

/** Every kind a story effect can be, for the validator's exhaustiveness check. */
export const STORY_EFFECT_KINDS: readonly StoryEffect["kind"][] = [
  "gain", "pay", "lose", "legitimacy", "upgrade", "reveal",
  "mercy", "flag", "unflag", "unlockAbility", "hire", "companyLeaves", "loyalty",
  "battle", "giveHolding", "loseHolding", "unrest", "captainSworn", "followUp",
];

/** The placeholders story text may use; K9 fills them. `{king}` is the player's chosen name. */
export const LETTER_PLACEHOLDERS: readonly string[] = ["king"];
