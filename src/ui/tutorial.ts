/**
 * The gesture tutorial.
 *
 * Teaches the pen vocabulary and NOTHING else -- no doctrines, no commanders,
 * no point-buy. A player who cannot group and march men has no use for any of
 * that yet, and every extra idea in a first lesson is one more thing to drop.
 *
 * Each step watches the BOARD, not the recogniser. A step completes when the
 * thing it asked for has actually happened to the world -- a company exists,
 * a company is marching, a company has changed shape. Watching the recogniser's
 * own answer would let the tutorial congratulate a player for a stroke that was
 * classified correctly and then did nothing, which is exactly the failure mode
 * that has bitten this project before.
 *
 * There is no scripted input anywhere here: the player performs every stroke.
 */

import type { World } from "../sim/world.ts";
import type { Commander } from "../input/commander.ts";

type Step = {
  /** What to ask for. One sentence, imperative. */
  readonly ask: string;
  /** The stroke, described. */
  readonly how: string;
  /** True once the world shows it was done. */
  readonly done: (t: Tutorial) => boolean;
};

const STEPS: readonly Step[] = [
  {
    ask: "Draw a loop around some of your men.",
    how: "A closed loop with nothing selected gathers everyone inside it into one company. This is the only way a company is ever made.",
    done: (t) => t.myCompanies() >= 1,
  },
  {
    // Deliberately clear-then-select, not the other way round: drawing the loop
    // has already selected the company, so asking to select it would tick
    // itself off before the player had done anything.
    ask: "Tap empty ground to let that company go.",
    how: "Tapping away from your men clears the selection. Nothing selected means the next loop you draw makes a new company instead of giving an order.",
    done: (t) => t.sawSelection && t.commander.selected.length === 0,
  },
  {
    ask: "Now tap the company to pick it up again.",
    how: "A short tap selects whatever is under the pen. Orders go to whatever you are holding.",
    done: (t) => t.clearedOnce && t.commander.selected.length > 0,
  },
  {
    ask: "With it selected, draw a line out across the field.",
    how: "With a company selected, a stroke drawn away from it is a march. It will find its own way round rivers and woods.",
    done: (t) => t.anyStance("move"),
  },
  {
    ask: "Draw a short stroke ACROSS your company, right on top of it.",
    how: "A glyph drawn over your own men changes their formation rather than ordering them anywhere. Across their front makes a line; along it makes a column.",
    done: (t) => t.anyShapeOtherThan("square"),
  },
  {
    ask: "Draw a small loop out on open ground.",
    how: "A small closed loop is an order to hold that ground and not chase anything beyond it.",
    done: (t) => t.anyStance("hold"),
  },
  {
    ask: "Draw a big ring somewhere on the map.",
    how: "A large ring is a patrol. Your company will walk it until told otherwise.",
    done: (t) => t.anyStance("patrol"),
  },
  {
    ask: "Draw a loop around only PART of one of your companies.",
    how: "A loop that takes in some of a company's men cuts exactly those men out into a company of their own. That is how you split a force -- there is no separate command for it.",
    done: (t) => t.myCompanies() >= 2,
  },
  {
    ask: "Draw a heart over your men.",
    how: "A heart stands a company down: it stops fighting for thirty seconds, closes ranks, and recovers its wounds and its nerve. It cannot take orders while it does.",
    done: (t) => t.anyRecovering(),
  },
  {
    ask: "Last one. Draw a stroke that ENDS on the enemy.",
    how: "A stroke ending on an enemy commits your company to attacking it, whatever shape the stroke was.",
    done: (t) => t.anyStance("attack"),
  },
];

export class Tutorial {
  readonly world: World;
  readonly commander: Commander;
  private index = 0;
  /** Set once the player has selected anything, so "now clear it" is fair. */
  sawSelection = false;
  /** Set once the selection has been emptied, so "now select again" is fair. */
  clearedOnce = false;
  private held = 0;

  constructor(world: World, commander: Commander) {
    this.world = world;
    this.commander = commander;
  }

  get finished(): boolean {
    return this.index >= STEPS.length;
  }

  /** Companies belonging to the player. */
  myCompanies(): number {
    return this.world.groups.filter((g) => g.player === 0).length;
  }

  anyStance(stance: string): boolean {
    return this.world.groups.some((g) => g.player === 0 && g.stance === stance);
  }

  anyShapeOtherThan(shape: string): boolean {
    return this.world.groups.some((g) => g.player === 0 && g.shape !== shape);
  }

  anyRecovering(): boolean {
    return this.world.groups.some((g) => g.player === 0 && g.recoverUntil > this.world.tick);
  }

  /** Call once a frame. Advances when the current step has actually happened. */
  update(): void {
    if (this.finished) return;
    if (this.commander.selected.length > 0) this.sawSelection = true;
    else if (this.sawSelection) this.clearedOnce = true;
    if (STEPS[this.index].done(this)) {
      // Hold the "done" line briefly so a step that completes the instant it is
      // asked does not flash past unread.
      this.held++;
      if (this.held > 40) {
        this.held = 0;
        this.index++;
      }
    }
  }

  /** What to show, as HUD lines. */
  lines(): string[] {
    if (this.finished) {
      return ["", "That is the whole vocabulary.", "Press ESC to leave the lesson."];
    }
    const step = STEPS[this.index];
    const ticked = step.done(this);
    return [
      "",
      "LESSON " + (this.index + 1) + " of " + STEPS.length + (ticked ? "   done" : ""),
      step.ask,
      "",
      // Not hard-wrapped: the HUD panel wraps its own text to the window, so
      // the lesson reflows at 200% zoom instead of running off the edge
      // (audit BS-08, docs/ui-policy.md).
      step.how,
    ];
  }
}
