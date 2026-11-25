/**
 * The explicit window the e2e harness (src/e2e/) is given into the app.
 *
 * Scenarios READ app state through this -- which screen is on top, the live
 * battle's world and camera -- so they can find the player's men on screen and
 * check what a stroke did. They never DRIVE the app through it: every input in
 * a scenario is a real PointerEvent or KeyboardEvent dispatched on the page.
 * There are exactly two exceptions:
 *
 *  - `forceOutcome`, which stands in for fifteen minutes of fighting so the
 *    after-action path can be reached at all;
 *  - `launchBattle`, which stands in for the march that brings two armies
 *    together. The game is the story only (the owner's amendment, PLAN.md):
 *    there is no skirmish button left to press, and until K5 the story
 *    launches no battle itself, yet the battle layer must stay covered. So a
 *    test launches one here, through the very `App.launch` the story will use,
 *    and then drives it with real events like any other.
 *
 * The game page (main.ts) never builds one.
 */

import type { App } from "./app.ts";
import type { BattleLayer } from "./battle-layer.ts";
import { battleFromSetup, type BattleConfig } from "./battle-config.ts";
import type { CityLayer } from "./city-layer.ts";
import type { KingdomLayer } from "./kingdom-layer.ts";
import type { AbilityId } from "../content/abilities.ts";
import { adviseFor, suggestArmy } from "../content/army.ts";
import { COMMANDERS, COMMANDER_IDS, type CommanderId } from "../content/commanders.ts";
import type { DifficultyId } from "../content/difficulty.ts";
import type { DoctrineId } from "../content/doctrines.ts";
import { LEVELS, levelById } from "../content/levels/index.ts";
import type { UnitTypeId } from "../content/unit-types.ts";
import { layerHash } from "../sim/layers.ts";
import { kingdomHash } from "../sim/kingdom/hash.ts";
import { hashWorld } from "../sim/hash.ts";

/**
 * What a test battle is fought with. Everything is optional: the defaults are
 * what the old setup screen opened on (the first battlefield at its suggested
 * difficulty, the manoeuvre doctrine, the army and reserve it suggested), with
 * the first captain instead of a random draw so a run is repeatable. Nothing
 * here checks the budget: a test may want an army no purse would buy.
 */
export type TestBattle = {
  /** A level id; the first level if left out. */
  readonly level?: string;
  readonly difficulty?: DifficultyId;
  readonly commander?: CommanderId;
  readonly doctrine?: DoctrineId;
  readonly squads?: readonly UnitTypeId[];
  readonly abilities?: readonly AbilityId[];
};

/** The config a TestBattle stands for. */
export function testBattleConfig(spec: TestBattle = {}): BattleConfig {
  const level = spec.level === undefined ? LEVELS[0] : levelById(spec.level);
  if (!level) throw new Error("no level " + spec.level);
  const doctrine = spec.doctrine ?? "maneuver";
  const suggested = suggestArmy(doctrine, level.budget, adviseFor(level));
  const abilities = [...(spec.abilities ?? suggested.abilities ?? [])];
  return battleFromSetup({
    level,
    difficulty: spec.difficulty ?? level.suggestedDifficulty,
    army: { doctrine, squads: [...(spec.squads ?? suggested.squads)], abilities },
    commander: COMMANDERS[spec.commander ?? COMMANDER_IDS[0]],
    abilities,
  });
}

export type TestHook = {
  readonly app: App;
  /** Screen names, bottom to top. */
  screens(): string[];
  top(): string | null;
  /** The live battle, or null. */
  battle(): BattleLayer | null;
  /** The live kingdom map, or null. */
  kingdom(): KingdomLayer | null;
  /** K3b: the live city view, or null. */
  city(): CityLayer | null;
  /** K3b: the realm, live on the map or suspended under a city (or, K5, a story battle); null with none. */
  realm(): KingdomLayer | null;
  /**
   * K5: the combined layer hash (sim/layers.ts): the realm's, with the live
   * battle's folded in while one is being fought. Null with no realm.
   */
  layerHash(): string | null;
  /** End the live battle now with this winner (0 is the player). */
  forceOutcome(winner: number): void;
  /**
   * TEST ONLY: launch a normal battle over whatever is on top (Home, in
   * practice), with the "test" origin, whose report and leave both go back
   * to Home. Returns the live battle, deploying, exactly as the old Take the
   * field button left it. See the header for why this exists.
   */
  launchBattle(spec?: TestBattle): BattleLayer;
};

export function testHook(app: App): TestHook {
  const battle = (): BattleLayer | null => (app.live && app.live.kind === "battle" ? app.live : null);
  return {
    app,
    screens: () => app.stack.names(),
    top: () => app.stack.top?.name ?? null,
    battle,
    kingdom: () => (app.live && app.live.kind === "kingdom" ? app.live : null),
    city: () => (app.live && app.live.kind === "city" ? app.live : null),
    realm: () => (app.live?.kind === "kingdom" ? app.live : app.live?.kind === "city" ? app.live.realm : app.descended),
    layerHash: () => {
      const r = app.live?.kind === "kingdom" ? app.live : app.live?.kind === "city" ? app.live.realm : app.descended;
      if (!r) return null;
      const b = battle();
      return layerHash(kingdomHash(r.world), b ? hashWorld(b.world) : undefined);
    },
    forceOutcome: (winner) => {
      const b = battle();
      if (!b) throw new Error("no battle is live");
      b.world.outcome = { winner, reason: "rout", detail: "ended by the e2e harness" };
    },
    launchBattle: (spec) => app.launch(testBattleConfig(spec), { kind: "test" }),
  };
}
