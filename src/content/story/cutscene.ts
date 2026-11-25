/**
 * The opening cutscene (PLAN.md amendment 3, §B.11a K9): the story told in
 * Brother Aldous's voice before the tutorial, over the kingdom map drawn the
 * way everything in this game is drawn -- procedurally, in ink on parchment.
 *
 * A script, not a film: each beat is one or two sentences of narration and a
 * STAGE DIRECTION a procedural renderer can carry out with what the kingdom
 * renderer already draws (the map, a holding, a road) plus a small set of
 * inked props (the eight badges, the writ, the boxed crown, the ledger...). No sprite, no
 * image file: a prop is a name the renderer draws a glyph for, which keeps the
 * project's "no sprite assets" rule (CLAUDE.md, art direction).
 *
 * The whole scene is skippable at any beat (`SKIP` is the button), and a beat
 * advances on its own after `seconds` or on any key or tap; under reduced
 * motion, pans become cuts. {king} is the player's chosen name.
 */

export type CutsceneProp =
  | "badges" | "writ" | "crown-box" | "ledger" | "horse" | "snow" | "keep-ruin" | "quill";

/** The props the renderer must be able to ink: the eight beast badges, the writ of exile, the boxed crown... */
export const CUTSCENE_PROPS: readonly CutsceneProp[] = [
  "badges", "writ", "crown-box", "ledger", "horse", "snow", "keep-ruin", "quill",
];

/**
 * What the renderer does for one beat.
 *   realm    the whole map, framed as at widest zoom
 *   holding  pan and zoom to a holding, `miles` across the short side
 *   road     the camera follows a line of travel from one holding to another
 *            along the known roads, inking the route as it goes
 *   prop     an inked prop drawn over the map, at a holding or centred
 *   title    the title card over the map
 */
export type StageDirection =
  | { readonly shot: "realm" }
  | { readonly shot: "holding"; readonly holding: string; readonly miles: number }
  | { readonly shot: "road"; readonly from: string; readonly to: string }
  | { readonly shot: "prop"; readonly prop: CutsceneProp; readonly at?: string }
  | { readonly shot: "title" };

export type CutsceneBeat = {
  readonly id: string;
  /** Narration: at most two sentences. */
  readonly text: string;
  readonly stage: StageDirection;
  /** How long it holds before moving on by itself. */
  readonly seconds: number;
};

export const CUTSCENE = {
  id: "opening",
  skippable: true,
  /** The skip control's label, and its key hint. */
  skip: "Skip",
  skipHint: "Esc skips · any key or tap goes on",
  beats: [
    {
      id: "realm", stage: { shot: "realm" }, seconds: 7,
      text: "This is Rimaros as it was drawn when it was whole: eight provinces round a crown seat, and the rivers that feed them. I have kept its chronicle for twenty years, and I did not expect to write this part.",
    },
    {
      id: "council", stage: { shot: "holding", holding: "rimaros", miles: 160 }, seconds: 6,
      text: "On the first day of autumn the council met in the Crown Seat and found that it no longer needed a king.",
    },
    {
      id: "menagerie", stage: { shot: "prop", prop: "badges", at: "rimaros" }, seconds: 7,
      text: "The Margrave of the Red March held the gates, and the eight captains of the Menagerie held the provinces, as they had since the old war ended on terms. Boar, Fox, Badger, Hare, Wolf, Owl, Stag and Crow: I knew every one of them by their habits before I knew their faces.",
    },
    {
      id: "writ", stage: { shot: "prop", prop: "writ", at: "rimaros" }, seconds: 6,
      text: "The order of exile was signed by the Regent, Isolde, in a steady hand. I know that hand; I copied its letters through a whole war.",
    },
    {
      id: "crown", stage: { shot: "prop", prop: "crown-box", at: "rimaros" }, seconds: 6,
      text: "The crown was lifted off its cushion and put in a box, which is how such things are done when nobody wishes to be seen doing them.",
    },
    {
      id: "road", stage: { shot: "road", from: "rimaros", to: "cold-hearth" }, seconds: 9,
      text: "{king} was given a horse, a cloak and a road: the long road north-west to the Farthest Reach, where nobody governs because nobody wants to.",
    },
    {
      id: "aldous", stage: { shot: "prop", prop: "ledger" }, seconds: 6,
      text: "I asked to go too, and nobody stopped me. A lay brother with a ledger is not thought dangerous, which has always been our advantage.",
    },
    {
      id: "horse", stage: { shot: "prop", prop: "horse", at: "greyshaw" }, seconds: 6,
      text: "The horse was sold at Greyshaw for bread. By Cold Hearth we had a cloak each, twelve days of grain, and nothing else at all.",
    },
    {
      id: "snow", stage: { shot: "prop", prop: "snow", at: "cold-hearth" }, seconds: 6,
      text: "Winter is a season away, and the Reach does not forgive a poor harvest or an empty barn.",
    },
    {
      id: "rookstead", stage: { shot: "prop", prop: "keep-ruin", at: "rookstead" }, seconds: 7,
      text: "From the hamlet you can see Rookstead on its hill, a keep with no roof and nobody in it. Everything has to start somewhere.",
    },
    {
      id: "page", stage: { shot: "prop", prop: "quill" }, seconds: 7,
      text: "So I have opened a new book. Its first page says what we own, which is nothing, and what we mean to do, which is everything.",
    },
    {
      id: "title", stage: { shot: "title" }, seconds: 5,
      text: "The Exile of Rimaros.",
    },
  ] as readonly CutsceneBeat[],
} as const;
