/**
 * Who can own ground in Rimaros.
 *
 * A faction is anyone who can hold a holding or (from K4) field an army: the
 * exiled king, the usurper in the Crown Seat, the Margrave who fronted the
 * coup, and the eight beast captains he governs through (PLAN.md §A.2, §A.4).
 *
 * The captains are NOT re-described here. Their personalities already live in
 * content/commanders.ts, where they drive the battle AI; the kingdom-layer AI
 * (K8) reads the same `bias` and `boldness` so a Badger who digs in on the
 * battlefield also digs in on the map. One rulebook, not two that drift.
 *
 * The order of FACTION_IDS is load-bearing: a faction's index is the `player`
 * number its orders are stamped with and the number the kingdom hash mixes,
 * so the king is 0 (the human seat, as player 0 is in battle) and new
 * factions are appended, never inserted.
 */

import { COMMANDERS, type CommanderId } from "../commanders.ts";
import type { Playstyle } from "../../sim/ai.ts";

export type FactionId = "king" | "usurper" | "margrave" | CommanderId | "commons";

/** The leanings the strategic AI (K8) weighs. Same shape as a Commander's. */
export type Persona = {
  readonly bias: Record<Playstyle, number>;
  readonly boldness: number;
};

export type FactionDef = {
  readonly id: FactionId;
  /** Short name used on the map and in the ledger. */
  readonly name: string;
  /** How Brother Aldous writes them. */
  readonly title: string;
  /** The battle commander whose habits this faction shares, if any. */
  readonly commander: CommanderId | null;
  /** Strategic leanings. Null for the human seat. */
  readonly persona: Persona | null;
  /** Serves the usurper. Everyone but the king does, at the start. */
  readonly crown: boolean;
};

function captain(id: CommanderId): FactionDef {
  const c = COMMANDERS[id];
  return {
    id,
    name: "the " + c.name,
    title: "the " + c.name + ", " + c.epithet,
    commander: id,
    // Reused by reference, not copied, so retuning a captain's battle habits
    // retunes their kingdom habits in the same edit.
    persona: { bias: c.bias, boldness: c.boldness },
    crown: true,
  };
}

export const FACTIONS: Record<FactionId, FactionDef> = {
  king: {
    id: "king",
    name: "the King",
    title: "the exiled King of Rimaros",
    commander: null,
    persona: null,
    crown: false,
  },
  usurper: {
    id: "usurper",
    // Provisional (docs/PROVISIONAL.md A.7.2): revealed in Act III.
    name: "the Chancellor",
    title: "Chancellor Oswin Vael, who holds the Crown Seat",
    commander: null,
    // Authored, because he has no battle commander of his own: a man who
    // works through others sits still, waits, and answers.
    persona: { bias: { aggressive: 0.5, defensive: 1.8, maneuver: 0.8, reactive: 1.6 }, boldness: 0.75 },
    crown: true,
  },
  margrave: {
    id: "margrave",
    name: "the Margrave",
    title: "the Margrave of the Red March",
    commander: null,
    // The face of the coup and a field commander: bold, direct, and happy to
    // send a captain round the side. Authored; provisional (docs/PROVISIONAL.md).
    persona: { bias: { aggressive: 1.7, defensive: 0.9, maneuver: 1.2, reactive: 0.8 }, boldness: 1.2 },
    crown: true,
  },
  boar: captain("boar"),
  fox: captain("fox"),
  badger: captain("badger"),
  hare: captain("hare"),
  wolf: captain("wolf"),
  owl: captain("owl"),
  stag: captain("stag"),
  crow: captain("crow"),
  // K8: the people of a crown town that threw off its captain. They serve no
  // one -- not the crown, and not (yet) the king, whom they have never seen --
  // so they are hostile to the crown's armies and to no one else. A revolt in
  // a captain's town raises them (morale.ts rebelFaction); a captain marching
  // to take it back is the first meeting of two machine sides, settled by the
  // auto-resolve (docs/PROVISIONAL.md K8.6). They keep no stores and no AI.
  commons: {
    id: "commons",
    name: "the commons",
    title: "the commons in arms",
    commander: null,
    persona: null,
    crown: false,
  },
};

/** Index = order `player` number = hash code. Append only. */
export const FACTION_IDS: readonly FactionId[] = [
  "king", "usurper", "margrave",
  "boar", "fox", "badger", "hare", "wolf", "owl", "stag", "crow",
  // K8, appended.
  "commons",
];

/** The human seat's order `player` number. */
export const KING_PLAYER = 0;

export function factionIndex(id: FactionId): number {
  return FACTION_IDS.indexOf(id);
}
