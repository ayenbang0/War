/**
 * The endings (PLAN.md §A.6; phase K9): what kind of king comes home, by
 * Legitimacy x Mercy, and the failure ending if the king is lost.
 *
 * The three crowned endings are chosen on the day Rimaros is taken, from the
 * two soft stats as they stand then:
 *   - The Hollow Crown:  legitimacy below 45, however merciful -- held by
 *                        force, with unrest that never quite ends;
 *   - The Restored King: legitimacy 45 or more and mercy 10 or more -- just;
 *   - The Iron Crown:    legitimacy 45 or more and mercy below 10 -- feared.
 * The thresholds are data, and validate-story.ts proves they cover every
 * (legitimacy, mercy) pair exactly once and that each crowned ending can be
 * reached from the state the story can leave the king in when Act IV begins.
 * The failure ending is gated on the king being captured or slain instead,
 * whenever that happens.
 *
 * Each ending is a short epilogue sequence, read one beat at a time. A beat
 * with `when` is read only if its condition holds, which is how the epilogue
 * remembers what was done along the way: the reeve of Hallow Ferry, the Stag,
 * the Margrave, Isolde, the Chancellor. Beats are read in order.
 *
 * Every threshold is PROVISIONAL (docs/PROVISIONAL.md K9s.3).
 */

import type { StoryCondition } from "./vocab.ts";

/** A closed-open range on one stat: min <= value < below. Either end may be left open. */
export type StatRange = { readonly min?: number; readonly below?: number };

export type EndingGate =
  | { readonly kind: "crowned"; readonly legitimacy: StatRange; readonly mercy: StatRange }
  | { readonly kind: "failure"; readonly condition: StoryCondition };

export type EpilogueBeat = {
  readonly text: string;
  readonly when?: StoryCondition;
};

export type EndingDef = {
  readonly id: string;
  readonly title: string;
  readonly gate: EndingGate;
  readonly epilogue: readonly EpilogueBeat[];
};

const flag = (f: string): StoryCondition => ({ kind: "flag", flag: f });
const all = (...of: StoryCondition[]): StoryCondition => ({ kind: "all", of });

/** The 45 line on legitimacy and the 10 line on mercy. */
export const CROWN_LEGITIMACY = 45;
export const CROWN_MERCY = 10;

/**
 * What the chronicle remembers, whichever crown it is: read in the middle of
 * every crowned epilogue. Each beat is gated on what was actually done.
 */
const REMEMBERED: readonly EpilogueBeat[] = [
  { when: flag("customs-sworn"), text: "The Reach kept its customs, because a king once swore at the Thornwick stone and did not forget it." },
  { when: flag("banner-raised"), text: "The cloak that flew over Rookstead the first winter hangs in the chapel at Rimaros now, and is smaller than anyone remembers." },
  { when: flag("quiet-winter"), text: "Rookstead flew nothing the first winter, and the Hare rode past it twice without looking up; it is still the king's favourite story." },
  { when: flag("ferry-relieved"), text: "At Hallow Ferry they bake a loaf with a letter in it every year, on the day the boats came across." },
  { when: flag("mallow-dead"), text: "Edric Mallow's name is cut in the stone of the ferry landing, and the king paid for the stone." },
  { when: all(flag("oath-ferry"), { kind: "holdingHeld", holding: "hallow-ferry" }), text: "The oath to take Hallow Ferry back was kept, which the ferry people mention more often than the king does." },
  { when: flag("fell-for-forgery"), text: "We went into the Wold in the dark once because a letter told us to; I have read every letter twice since." },
  { when: flag("forgery-spotted"), text: "A forged letter once tried to send us into the Wold in the dark, and it is the only time the ledger records its keeper being thanked." },
  { when: flag("stag-sworn"), text: "The Stag carries the king's colours now, and has never once been asked to give ground." },
  { when: flag("stag-paroled"), text: "The Stag kept the parole and keeps Stagcrown, and sends a herald every midsummer to say so." },
  { when: flag("stag-hanged"), text: "Nobody climbs the hill above High Tarn now; the Stag's people say it is still being held." },
  { when: flag("margrave-pardoned"), text: "The Margrave guards the March for the crown the Margrave once overthrew, and does it well, which nobody quite forgives." },
  { when: flag("margrave-tried"), text: "The Margrave lives in the Reach, at Cold Hearth, and is said to be a poor shepherd and a good neighbour." },
  { when: flag("margrave-hanged"), text: "The gate of Redcastle was taken down and burned after the war, because nobody would walk under it." },
  { when: flag("isolde-answered"), text: "{king} never told anyone what the one line to Isolde said, and I have stopped asking." },
  { when: flag("isolde-ally"), text: "Isolde was the king's eyes in Rimaros until the end, and asked for nothing after, and was given the Vale." },
  { when: flag("isolde-shielded"), text: "The page that would have hanged Isolde was burned to keep Isolde safe; the king has never said whether it was worth the lords' doubt." },
  { when: flag("isolde-coward"), text: "Isolde took ship at Wrackhythe and was not heard of again, though a letter in that hand comes every year with no name on it." },
  { when: flag("isolde-villain"), text: "Isolde was named traitor and became one, and stood on the gate of Rimaros beside the Chancellor to prove it." },
  { when: flag("gatehouse-threatened"), text: "The gatehouse of Rimaros was promised fire in front of the whole city, and the city has not forgotten the promise." },
  { when: flag("vael-named"), text: "Chancellor Oswin Vael's name was read out at the coronation, with the Chancery's own figures beside it." },
  { when: flag("lords-convinced"), text: "The lords who saw the Regent's hand laid beside the forger's were the first to kneel." },
  { when: { kind: "notFlag", flag: "vael-named" }, text: "The Chancellor's part was never proclaimed, and there are people in Rimaros who still think the Margrave did it all." },
  { when: flag("lied-to-vael"), text: "The king lied to the Chancellor for a month to bring the army up the road; it is told as a clever story, and it is a little less clever every time." },
  { when: flag("fields-burned"), text: "The fields along the Lisle road were burned to starve an army, and starved a valley." },
  { when: flag("adepts-promised"), text: "The unlicensed Adepts were given their licence at the coronation, which frightened everyone but the Adepts." },
  { when: flag("kingsmere-sacked"), text: "Kingsmere was given to the army for a day, and has been paying for it since." },
  { when: flag("lords-rights-restored"), text: "The lords have their courts and tolls and levies back, and the villages under them have the lords back." },
  { when: flag("walls-breached"), text: "The breach in the river wall was left open for a year, so that nobody would forget how the king came home." },
];

export const ENDINGS: readonly EndingDef[] = [
  {
    id: "restored-king",
    title: "The Restored King",
    gate: { kind: "crowned", legitimacy: { min: CROWN_LEGITIMACY }, mercy: { min: CROWN_MERCY } },
    epilogue: [
      { text: "Here ends the chronicle of the exile, kept by Aldous, lay brother, who walked out to the Reach with a ledger because nobody thought a ledger dangerous." },
      { text: "{king} came home to Rimaros believed, and the realm opened its gates rather than having them opened for it." },
      ...REMEMBERED,
      { text: "It was a just reign as reigns go, which is not very far; but the roads are safe, the winter dole is paid, and nobody in the Reach is frightened of the king's bread." },
    ],
  },
  {
    id: "iron-crown",
    title: "The Iron Crown",
    gate: { kind: "crowned", legitimacy: { min: CROWN_LEGITIMACY }, mercy: { below: CROWN_MERCY } },
    epilogue: [
      { text: "Here ends the chronicle of the exile, kept by Aldous, lay brother, who has written down everything, including the hangings." },
      { text: "{king} came home to Rimaros believed, and feared, and found that the two do not cancel out." },
      ...REMEMBERED,
      { text: "The realm is quiet the way a held breath is quiet; nobody rises against the Iron Crown, and nobody sings about it either." },
    ],
  },
  {
    id: "hollow-crown",
    title: "The Hollow Crown",
    gate: { kind: "crowned", legitimacy: { below: CROWN_LEGITIMACY }, mercy: {} },
    epilogue: [
      { text: "Here ends the chronicle of the exile, kept by Aldous, lay brother, who has kept it honestly even where it did not flatter anyone." },
      { text: "{king} took Rimaros, and sits in the hall where the council once decided it no longer needed a king, and the council is still not convinced." },
      ...REMEMBERED,
      { text: "The crown is held by the garrisons that hold the towns, and every spring there is unrest somewhere; it is a crown, but it is hollow, and everyone can hear it." },
    ],
  },
  {
    id: "the-fallen",
    title: "The Chronicle Closes",
    gate: { kind: "failure", condition: { kind: "kingLost" } },
    epilogue: [
      { text: "Here ends the chronicle of the exile, sooner than its keeper hoped." },
      { text: "{king} was lost to the crown's soldiers, and the people who had followed the banner went home in ones and twos, the way they came." },
      { when: { kind: "actAtLeast", act: 3 }, text: "It came close: two holdings in every five, and the lords beginning to kneel. The Chancellor does not sleep well, I am told." },
      { when: { kind: "notFlag", flag: "vael-named" }, text: "The Chancellor's part in it was never proclaimed, and now perhaps never will be." },
      { when: flag("vael-named"), text: "But the Chancellor's name was said aloud, in every market, and a name said aloud cannot be unsaid." },
      { when: flag("isolde-ally"), text: "Isolde is still in Rimaros, still watching, and has asked me for a copy of this ledger." },
      { text: "I am keeping it anyway. A chronicle is for whoever comes next, and somebody always does." },
    ],
  },
];
