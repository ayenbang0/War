/**
 * Kingdom orders: the only way anything outside the sim changes the kingdom.
 *
 * The same contract as battle orders (sim/orders.ts): plain serialisable data,
 * stamped with the tick it takes effect on, the issuing player and a
 * per-player sequence number, and applied at a tick boundary in
 * (tick, player, seq) order -- never in the order it arrived, which differs
 * between a live game, a replay and two netplay peers. The pen (K2), the
 * panels (K3+) and the captains' AI (K8) all emit these, so a recorded log
 * replays the whole campaign.
 *
 * `player` is a faction's index in FACTION_IDS; the human king is 0.
 *
 * Pause and game speed are NOT orders. They decide how often the UI calls
 * tick(), which a replay does not care about.
 */

import type { BuildingId } from "../../content/kingdom/buildings.ts";
import type { CropId } from "../../content/kingdom/crops.ts";
import type { TaxRateId } from "../../content/kingdom/economy.ts";
import type { UnitTypeId } from "../../content/unit-types.ts";
import type { DoctrineId } from "../../content/doctrines.ts";
import type { AbilityId } from "../../content/abilities.ts";
import type { BattleResult } from "../layers.ts";
import type { JusticeId } from "../../content/kingdom/morale.ts";

/** How a contact is settled (K5). Hash code is the index. Append only. */
export type ContactChoice = "fight" | "withdraw" | "auto" | "yield" | "keep";
/**
 * Append only (the hash and the save use the index). K8 appends the
 * defender's two choices at its own walls (KD-05): `yield` opens the gates,
 * `keep` gives up the town and holds the keep (a siege; auto-resolved until K10).
 */
export const CONTACT_CHOICES: readonly ContactChoice[] = ["fight", "withdraw", "auto", "yield", "keep"];

export type KingdomOrderBody =
  /** March the king's retinue by road to a holding. Replaces any march, and ends a forage or rally. */
  | { kind: "moveKing"; to: number }
  /** Stop where the retinue stands, even halfway along a road; also ends a forage or rally. */
  | { kind: "haltKing" }
  // -- K3: the economy, from nothing (PLAN.md §A.5, §B.3) --
  /** The king's party gathers food and deadwood where it stands, each day until told otherwise. */
  | { kind: "forage" }
  /** At an unclaimed hamlet: spend days winning followers to the levy. */
  | { kind: "rally" }
  /** Take an unowned holding with no garrison and no army, without a battle (§B.8). The king must be there. */
  | { kind: "claimHolding"; holding: number }
  /** Set the tax of one owned holding, or of every one (holding 0, which also sets the default for new claims). */
  | { kind: "setTax"; holding: number; rate: TaxRateId }
  /** Start a building in a free slot (or over the building it upgrades) of an owned holding. */
  | { kind: "build"; holding: number; building: BuildingId }
  /** Sow a crop in a plot of an owned holding: empty, harvested or spoiled. */
  | { kind: "sow"; plot: number; crop: CropId }
  /** Reap a ripe plot. */
  | { kind: "harvest"; plot: number }
  // -- K3a: exploration --
  /** Answer the letter waiting from a site: pick choice `choice` (0-based) of its event. */
  | { kind: "resolveEvent"; site: number; choice: number }
  // -- K4: armies (PLAN.md §B.4, §B.5; src/sim/kingdom/armies.ts) --
  /**
   * Raise one squad at holding `at` into army `army` (0: a new army there).
   * `levy`: formed from the king's followers where he stands, no barracks,
   * coin or iron; otherwise trained at a barracks of yours for followers,
   * coin and iron by the battle rulebook's costs.
   */
  | { kind: "recruit"; at: number; army: number; unit: UnitTypeId; levy: boolean }
  /** Stand an army down: at home its men rejoin the followers and its grain the stores. */
  | { kind: "disband"; army: number }
  /** March an army by road to a holding. Replaces any march, chase or patrol. */
  | { kind: "marchArmy"; army: number; to: number }
  | { kind: "haltArmy"; army: number }
  /** Fold `army` into `into`: at once if they have met, else it marches to join it. */
  | { kind: "merge"; army: number; into: number }
  /** Part `squads` off `army` as a new army where it stands. */
  | { kind: "split"; army: number; squads: number[] }
  /** Dig in where it stands (a garrison, in a holding of yours). */
  | { kind: "garrison"; army: number }
  /** Walk between these holdings, in this order, round and round. */
  | { kind: "patrol"; army: number; holdings: number[] }
  /** Rest where it stands: the wounded mend, and at a barracks the gaps are filled. */
  | { kind: "recover"; army: number }
  | { kind: "setDoctrine"; army: number; doctrine: DoctrineId }
  /** Spend coin and legitimacy so the army can call on a battle ability (§B.4). */
  | { kind: "unlockAbility"; army: number; ability: AbilityId }
  /** March to meet an army that is not yours (K8's enemies; any other side's army now). */
  | { kind: "intercept"; army: number; target: number }
  /** The king rides with `army` (both must stand in the same holding), or alone again (0). */
  | { kind: "kingJoin"; army: number }
  // -- K5: the descent (sim/kingdom/descent.ts) --
  /**
   * Settle the waiting contact: fought (with the battle's result, which the
   * app read off the battlefield), withdrawn from, or resolved for the king
   * by the auto-resolve. While a contact waits the realm is held, so the
   * result applies to exactly the armies the battle was built from.
   */
  | { kind: "resolveContact"; contact: number; choice: ContactChoice; result: BattleResult | null }
  // -- K6: a town's politics (sim/kingdom/morale.ts) --
  /** Set how an owned holding's quarrels are judged. */
  | { kind: "setJustice"; holding: number; justice: JusticeId }
  /** Feast an owned holding for a week: coin and grain for calm and a little legitimacy. */
  | { kind: "holdFestival"; holding: number }
  /** Pardon an owned holding's prisoners: calm at once, and Mercy; once a season. */
  | { kind: "pardon"; holding: number }
  // K7: hire / pay. `company` is the index in MERCENARIES (sim/kingdom/mercenaries.ts applies them).
  /** Sign the company drinking at this holding's tavern: its fee now, its wage every day. */
  | { kind: "hireCompany"; company: number; at: number }
  /** Sign a hired company on again, in the contract's last days, for part of its fee. */
  | { kind: "renewContract"; company: number }
  /** Pay the crown's bid for a hired company, to keep it. */
  | { kind: "matchBid"; company: number }
  // K8: the defence tools (sim/kingdom/invasions.ts). Garrisoning is K4's `garrison`.
  | { kind: "callLevy"; holding: number }
  | { kind: "burnFields"; holding: number }
  | { kind: "ambush"; army: number }
  // ECON: auto-farming (sim/kingdom/economy.ts autoSow).
  /**
   * Set the crop a field resows by itself when its season comes (null: by
   * hand only). `plot` 0 sets every field of `holding`; `holding` 0 as well
   * sets every field the king holds and the crop his later claims start with.
   */
  | { kind: "setAutoSow"; holding: number; plot: number; crop: CropId | null }
  // K9: the story (sim/kingdom/story.ts).
  /** Answer a waiting story letter: pick choice `choice` (0-based) of STORY_LETTERS[letter]. */
  | { kind: "answerLetter"; letter: number; choice: number };
  // Append new kinds; never renumber the existing ones.

export type KingdomOrderKind = KingdomOrderBody["kind"];

export const KINGDOM_ORDER_KINDS: readonly KingdomOrderKind[] = [
  "moveKing", "haltKing", "forage", "rally", "claimHolding", "setTax", "build", "sow", "harvest",
  "resolveEvent",
  // K4
  "recruit", "disband", "marchArmy", "haltArmy", "merge", "split", "garrison", "patrol", "recover",
  "setDoctrine", "unlockAbility", "intercept", "kingJoin",
  // K5
  "resolveContact",
  // K6
  "setJustice", "holdFestival", "pardon",
  "hireCompany", "renewContract", "matchBid",
  // K8
  "callLevy", "burnFields", "ambush",
  // ECON
  "setAutoSow",
  // K9
  "answerLetter",
];

/** The K6 order kinds (src/sim/kingdom/morale.ts applies them). */
export const MORALE_ORDER_KIND_SET: ReadonlySet<KingdomOrderKind> = new Set(["setJustice", "holdFestival", "pardon"]);
/** The K7 order kinds. */
export const MERCENARY_ORDER_KIND_SET: ReadonlySet<KingdomOrderKind> = new Set(["hireCompany", "renewContract", "matchBid"]);

/** The K4 order kinds (src/sim/kingdom/armies.ts applies them). */
export const ARMY_ORDER_KINDS: readonly KingdomOrderKind[] = KINGDOM_ORDER_KINDS.slice(
  KINGDOM_ORDER_KINDS.indexOf("recruit"), KINGDOM_ORDER_KINDS.indexOf("kingJoin") + 1,
);
export const ARMY_ORDER_KIND_SET: ReadonlySet<KingdomOrderKind> = new Set(ARMY_ORDER_KINDS);

export type KingdomOrder = KingdomOrderBody & {
  /** Kingdom tick at which this order takes effect. */
  readonly tick: number;
  /** Issuing faction's index in FACTION_IDS. */
  readonly player: number;
  /** Per-player monotonic counter; breaks ties deterministically. */
  readonly seq: number;
};

/** The canonical application order. Shared by the queue, the hash and the log. */
export function compareOrders(a: KingdomOrder, b: KingdomOrder): number {
  return a.tick - b.tick || a.player - b.player || a.seq - b.seq;
}

/**
 * Holds orders until their tick arrives.
 *
 * Unlike the battle queue its contents and sequence counters are exposed,
 * because a kingdom save must carry orders that were issued but are not due
 * yet -- a campaign is saved and resumed, a battle is not.
 */
export class KingdomOrderQueue {
  private pending: KingdomOrder[] = [];
  /** Last seq stamped per player, indexed by player. */
  private seqs: number[] = [];

  /** Stamp a body for `tick`. Returns the stamped order; does not enqueue it. */
  stamp(body: KingdomOrderBody, player: number, tick: number): KingdomOrder {
    const seq = (this.seqs[player] ?? 0) + 1;
    this.seqs[player] = seq;
    return { ...body, tick, player, seq };
  }

  /**
   * Enqueue a stamped order, no earlier than `now`.
   *
   * An order stamped for a tick that has already run is moved to `now`, the
   * next boundary, rather than lost or applied retroactively. It is moved HERE,
   * on entry, so the order the log records is the order as applied, and a
   * replay of the log reproduces the live run exactly.
   */
  push(order: KingdomOrder, now: number): KingdomOrder {
    const o = order.tick < now ? { ...order, tick: now } : order;
    // Keep the counter ahead of anything seen, so a locally stamped order
    // never reuses a seq that arrived from elsewhere (a log, a peer).
    if ((this.seqs[o.player] ?? 0) < o.seq) this.seqs[o.player] = o.seq;
    this.pending.push(o);
    return o;
  }

  /** Remove and return every order due at or before tick, in canonical order. */
  drain(tick: number): KingdomOrder[] {
    if (this.pending.length === 0) return [];
    const due: KingdomOrder[] = [];
    const rest: KingdomOrder[] = [];
    for (const o of this.pending) (o.tick <= tick ? due : rest).push(o);
    this.pending = rest;
    due.sort(compareOrders);
    return due;
  }

  /** Orders not yet due, in canonical order (independent of arrival order). */
  queued(): KingdomOrder[] {
    return [...this.pending].sort(compareOrders);
  }

  /** Last seq stamped per player, for saving. Holes are 0. */
  sequences(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.seqs.length; i++) out.push(this.seqs[i] ?? 0);
    return out;
  }

  /** Restore from a save. */
  restore(pending: readonly KingdomOrder[], seqs: readonly number[]): void {
    this.pending = [...pending];
    this.seqs = [...seqs];
  }

  get size(): number {
    return this.pending.length;
  }
}
