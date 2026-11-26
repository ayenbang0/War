/**
 * K9: the practice realm the tutorial is played in (ui/story/coach.ts).
 *
 * The owner wanted a tutorial that teaches every control, each step waiting
 * for the real input. Real input needs a real realm under it -- a holding to
 * claim, a town to build in, an army to split -- and the king's own new
 * realm must not be spent on lessons (a skipped claim would have to be
 * forged in it; a practice army would eat his first winter's bread). So the
 * lessons run in a realm of their own: the same map, with the story on so a
 * letter can come, never saved (the app's kingdom layer is told so), and
 * thrown away when the tutorial ends. The king's realm begins afterwards,
 * untouched, from day one.
 *
 * Everything here is set-up, like the map's starting owners and K4's
 * raiseArmy: it writes the realm directly, once, before the player acts, so
 * that a step skipped never strands the next one (a skipped claim still
 * leaves a town for the town lesson). Pure and deterministic like the rest of
 * src/sim -- the lesson realm's seed is fixed (docs/PROVISIONAL.md K9.11).
 */

import { KingdomWorld } from "./world.ts";
import { KING_PLAYER, FACTION_IDS } from "../../content/kingdom/factions.ts";
import { STORY_LETTERS } from "../../content/story/letters.ts";
import { applyEconomyOrder, hasStanding } from "./economy.ts";
import { armiesOf, raiseArmy, setPosture, armyMen } from "./armies.ts";
import { moverAt } from "./graph.ts";
import { letterIndex, sendLetter } from "./story.ts";
import { DAYS_PER_SEASON } from "./clock.ts";
import type { Holding } from "./state.ts";
import type { BuildingId } from "../../content/kingdom/buildings.ts";
import { holdingKnowledge, updateSight } from "./explore.ts";
import { KNOW_SEEN } from "../../content/kingdom/exploration.ts";

/** The lesson realm's seed: one practice realm for everyone, so the lessons read the same. */
export const LESSON_SEED = 0x4b39;

/** The places the lessons name (content/story/tutorial.ts): the king's camp, the hamlet to rally at, the keep to claim. */
export const LESSON_PLACES = { camp: "cold-hearth", hamlet: "greyshaw", keep: "rookstead" } as const;

/** The letter the map lesson reads: the first follower's, which is the story's own first. */
export const LESSON_LETTER = "first-follower";

/** The stores the practice king starts with besides the usual: enough to build, sow and raise in every lesson. */
export const LESSON_STORES = { coin: 300, grain: 400, timber: 120, iron: 40, levy: 0 } as const;

/** The enemy whose host stands in the armies lesson (at Greyshaw), to be intercepted and fought. */
export const LESSON_ENEMY = "boar";

/**
 * A new practice realm. The story is on (a letter has to come) but holds its
 * letters and encounters: the lessons put one letter in the king's hand when
 * the map lesson asks for it, and nothing else arrives to cover a step.
 * Fields are sown by hand, so the town lesson can turn their resowing on.
 */
export function lessonRealm(seed: number = LESSON_SEED): KingdomWorld {
  const w = new KingdomWorld({ seed, story: true, autoFarm: false });
  const st = w.kingStocks.stocks;
  st.coin += LESSON_STORES.coin;
  st.grain += LESSON_STORES.grain;
  st.timber += LESSON_STORES.timber;
  st.iron += LESSON_STORES.iron;
  const s = w.story;
  if (s) {
    s.sent = s.sent.map(() => true);
    for (const e of s.encounters) e.state = "won";
  }
  return w;
}

function place(w: KingdomWorld, key: string): Holding {
  const h = w.holdingByKey(key);
  if (!h) throw new Error("lesson realm: no holding " + key);
  return h;
}

/**
 * The town lesson needs Rookstead the king's, with a tavern standing (the
 * free companies are one of its steps). A claim made in the map lesson is
 * kept; a claim skipped is made here, by the claim order's own rules, with
 * the three followers it needs.
 */
export function lessonTown(w: KingdomWorld): Holding {
  const h = place(w, LESSON_PLACES.keep);
  if (h.owner !== FACTION_IDS[KING_PLAYER]) {
    h.owner = null;
    h.garrison = [];
    const st = w.kingStocks.stocks;
    if (st.levy < 3) st.levy = 3;
    // The claim's own rule: the king stands there. A skipped march is walked for him.
    if (w.king.army === 0) w.king.mover = moverAt(h.id);
    const why = applyEconomyOrder(w, { kind: "claimHolding", holding: h.id, tick: w.now, player: KING_PLAYER, seq: 0 });
    if (why) throw new Error("lesson realm: Rookstead cannot be claimed: " + why);
  }
  stand(h, "tavern");
  return h;
}

/**
 * A building standing on a lot of the keep, finished: the last empty lot, so
 * the first stays free for the town lesson's own building (and, all taken,
 * the last lot is rebuilt -- it is a practice realm).
 */
function stand(h: Holding, id: BuildingId): void {
  if (hasStanding(h, id)) return;
  let slot = -1;
  for (let i = h.buildings.length - 1; i >= 0; i--) if (h.buildings[i] === null) { slot = i; break; }
  if (slot < 0) slot = h.buildings.length - 1;
  h.buildings[slot] = id;
  h.works[slot] = 0;
}

/** The map lesson's letter, put in the king's hand if it is not there yet. Its index in STORY_LETTERS. */
export function lessonLetter(w: KingdomWorld): number {
  const i = letterIndex(LESSON_LETTER);
  const s = w.story;
  if (!s || i < 0) return -1;
  if (!s.pending.includes(i)) {
    // An earlier answer is forgotten: the lesson is about answering.
    s.answers = s.answers.filter((a) => a.letter !== i);
    sendLetter(w, i);
  }
  return i;
}

/**
 * The armies lesson: the king at Rookstead with followers enough to raise a
 * company or two, and an enemy host standing two roads off to intercept.
 * Run when the lesson begins and again on each step, so a step skipped
 * leaves what the next needs: an army of the king's with two companies (to
 * split), and the host.
 */
export function lessonArmies(w: KingdomWorld, forStep: "raise" | "armies"): void {
  const keep = lessonTown(w);
  // The king stands in his keep (an army he rides with carries him).
  if (w.king.army === 0 && !(w.king.mover.road === 0 && w.king.mover.node === keep.id)) {
    w.king.mover = moverAt(keep.id);
  }
  const st = w.kingStocks.stocks;
  if (st.levy < 12) st.levy = 12;
  if (forStep === "armies") {
    const own = armiesOf(w, KING_PLAYER);
    if (!own.some((a) => a.squads.length >= 2)) {
      const a = raiseArmy(w, KING_PLAYER, keep.id, ["line", "line"]);
      a.supply = armyMen(a) * DAYS_PER_SEASON;
    }
  }
  // A watchtower on the keep, so the enemy two roads off is in sight: an army
  // the king cannot see cannot be intercepted (armies.ts), and the lesson is
  // the intercept. Then what he sees from where he now stands.
  stand(keep, "watchtower");
  updateSight(w, KING_PLAYER);
  const f = FACTION_IDS.indexOf(LESSON_ENEMY);
  if (armiesOf(w, f).length === 0) {
    const at = enemyGround(w, keep);
    const host = raiseArmy(w, f, at.id, ["line", "archer"]);
    // Bare, as every army name is: the feed says "the Outriders of the Boar".
    host.name = "Outriders";
    host.supply = armyMen(host) * DAYS_PER_SEASON;
    setPosture(w, host, "hold");
  }
}

/**
 * Where the enemy waits: Greyshaw, the hamlet of the map lesson, while it is
 * nobody's -- the coach says so -- else the nearest holding to the keep that
 * is nobody's and in the king's sight. Sight matters: an army he cannot see
 * cannot be intercepted (armies.ts), and the lesson is the intercept.
 */
function enemyGround(w: KingdomWorld, keep: Holding): Holding {
  const hamlet = place(w, LESSON_PLACES.hamlet);
  if (hamlet.owner === null && holdingKnowledge(w, KING_PLAYER, hamlet.id) === KNOW_SEEN) return hamlet;
  let best: Holding | null = null;
  let bestD = Infinity;
  for (const h of w.holdings) {
    if (h.owner !== null || h.id === keep.id) continue;
    if (holdingKnowledge(w, KING_PLAYER, h.id) !== KNOW_SEEN) continue;
    const d = (h.x - keep.x) * (h.x - keep.x) + (h.y - keep.y) * (h.y - keep.y);
    if (d < bestD) { bestD = d; best = h; }
  }
  if (!best) throw new Error("lesson realm: nowhere for the enemy to stand");
  return best;
}

/** For tools/story-check.ts: the letter exists. */
export function lessonLetterExists(): boolean {
  return STORY_LETTERS.some((l) => l.id === LESSON_LETTER);
}
