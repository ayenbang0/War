/**
 * The layer controller: owns the screen stack, the one key router and the live
 * layer, and moves the player between them.
 *
 * This is what main.ts used to be as a linear script -- home, then campaign,
 * then menu, then exactly one World, then an after-action report whose every
 * button called `location.reload()`. Now each of those is a screen on the stack
 * and the battle is a layer with a start and a teardown, so:
 *
 *  - "Fight again" pops back to the setup screen, still holding the setup;
 *  - "Continue the chronicle" pops back to the chronicle, which redraws with
 *    the new entry -- from memory if the browser refused storage (BS-01);
 *  - leaving the lesson or a battle goes through a confirm on the stack;
 *  - a second battle is built without a reload, because the first one tore
 *    down every listener and loop it had.
 *
 * Layers (plan §B.1) are a typed union; only the battle is reachable for now.
 */

import type { Chapter } from "../content/campaign.ts";
import { levelById } from "../content/levels/index.ts";
import { homeScreen, type HomeChoice } from "../ui/home.ts";
import { chronicleScreen, noteBattle } from "../ui/campaign.ts";
import { menuScreen, type MenuPreset } from "../ui/menu.ts";
import { afterActionScreen } from "../ui/after-action.ts";
import { confirmScreen, type ConfirmSpec } from "../ui/dialog.ts";
import { ScreenStack, type FocusHost, type Focusable, type Screen } from "../ui/screen-stack.ts";
import { KeyRouter, attachKeyRouter, classifyFocus } from "../ui/keys.ts";
import type { Outcome } from "../sim/victory.ts";
import { BattleLayer, PLAYER, type BattleEnv } from "./battle-layer.ts";
import { battleFromSetup, lessonConfig, type BattleConfig } from "./battle-config.ts";
import type { Layer } from "./layers.ts";
import { MEMORY_ONLY_NOTICE, ProgressStore, type KeyValueStore } from "./progress-store.ts";

export type AppEnv = {
  readonly win: Window;
  readonly doc: Document;
  /** Where the chronicle is kept. Defaults to the window's localStorage. */
  readonly storage?: () => KeyValueStore | null;
};

/** Where a battle was launched from, so its end knows where to go back to. */
export type BattleOrigin =
  | { readonly kind: "skirmish"; readonly menu: Screen }
  | { readonly kind: "campaign"; readonly chapter: Chapter; readonly chronicle: Screen; readonly menu: Screen }
  | { readonly kind: "lesson" };

/** The page elements the app draws into. All exist in index.html and e2e.html. */
type Elements = {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly home: HTMLElement;
  readonly chronicle: HTMLElement;
  readonly menu: HTMLElement;
  readonly report: HTMLElement;
  readonly dialog: HTMLElement;
  readonly hud: HTMLElement;
  readonly abilities: HTMLElement;
};

function lookUp(doc: Document): Elements {
  const byId = (id: string): HTMLElement => {
    const n = doc.getElementById(id);
    if (!n) throw new Error("missing #" + id + " in the page");
    return n;
  };
  const canvas = byId("stage") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2d canvas context unavailable");
  return {
    canvas, ctx,
    home: byId("home"), chronicle: byId("chronicle"), menu: byId("menu"), report: byId("report"),
    dialog: byId("dialog"), hud: byId("hud"), abilities: byId("abilities"),
  };
}

/** Focus as the stack needs it, over the real document. */
function documentFocus(doc: Document): FocusHost {
  return {
    active: () => {
      const a = doc.activeElement;
      return a && a !== doc.body && a instanceof HTMLElement ? a : null;
    },
    focus: (t: Focusable | null) => {
      // preventScroll: the setup screen's first focus is "Take the field" at
      // the foot of a long panel, and the panel must still open at its top.
      if (t instanceof HTMLElement) t.focus({ preventScroll: true });
      else if (t) t.focus();
      else if (doc.activeElement instanceof HTMLElement) doc.activeElement.blur();
    },
    canFocus: (t: Focusable) => {
      const e = t as HTMLElement;
      return e.isConnected && e.getClientRects().length > 0 && !e.closest("[inert]");
    },
  };
}

export class App {
  readonly stack: ScreenStack;
  readonly router: KeyRouter;
  readonly store: ProgressStore;
  /** The live layer, or null while only menu screens are up. */
  live: Layer | null = null;
  /** Where the current battle came from. Null while no battle is live. */
  origin: BattleOrigin | null = null;

  private readonly env: AppEnv;
  private readonly els: Elements;
  private readonly home: Screen;
  private readonly detachKeys: () => void;
  private readonly unwatchStack: () => void;

  /**
   * The battlefield's place on the stack. It draws nothing itself (the canvas
   * and HUD are the layer's), but being a screen is what lets overlays go over
   * it and turn its input off, and popping it is what tears the battle down.
   */
  private readonly field: Screen = {
    name: "battle",
    kind: "full",
    trapsFocus: false,
    pausesSim: false,
    inputs: ["pen", "camera", "ui"],
    firstFocus: () => null,
    mount: () => { /* the layer is started by launch() */ },
    unmount: () => this.leaveLayer(),
    setVisible: () => { /* the canvas is always under everything */ },
  };

  constructor(env: AppEnv) {
    this.env = env;
    this.els = lookUp(env.doc);
    this.store = new ProgressStore(env.storage ?? (() => env.win.localStorage));
    this.stack = new ScreenStack(documentFocus(env.doc));
    this.router = new KeyRouter(this.stack, classifyFocus);
    this.detachKeys = attachKeyRouter(this.router, env.win, env.doc);
    // Whatever is on top decides which input contexts the live layer has.
    this.unwatchStack = this.stack.onChange(() => this.live?.setContexts(this.stack.activeInputs()));
    this.home = homeScreen(this.els.home, (c) => this.choose(c));
    this.stack.push(this.home);
  }

  /** Tear the whole app down: every screen, the layer, the key listener. */
  dispose(): void {
    this.stack.clear();
    this.unwatchStack();
    this.detachKeys();
  }

  // -- menus ------------------------------------------------------------------

  private choose(choice: HomeChoice): void {
    if (choice === "play") this.openMenu(this.home, undefined, (menu) => ({ kind: "skirmish", menu }));
    else if (choice === "campaign") this.openChronicle();
    else this.launch(lessonConfig(), { kind: "lesson" });
  }

  private openChronicle(): void {
    const chronicle: Screen = chronicleScreen(this.els.chronicle, this.store, {
      march: (chapter) => this.march(chapter, chronicle),
      back: () => this.stack.popTo(this.home),
      confirm: (spec) => this.confirm(spec, spec.onYes),
    });
    this.stack.push(chronicle);
  }

  /** A campaign chapter: the setup screen, opened on the chapter's ground and captain. */
  private march(chapter: Chapter, chronicle: Screen): void {
    const level = levelById(chapter.levelId);
    if (!level) return;
    const preset: MenuPreset = {
      title: "Chapter " + chapter.number + ": " + chapter.title,
      level,
      commander: chapter.commander,
      difficulty: chapter.difficulty,
    };
    this.openMenu(chronicle, preset, (menu) => ({ kind: "campaign", chapter, chronicle, menu }));
  }

  private openMenu(opener: Screen, preset: MenuPreset | undefined, origin: (menu: Screen) => BattleOrigin): void {
    const menu: Screen = menuScreen(this.els.menu, {
      start: (setup) => this.launch(battleFromSetup(setup), origin(menu)),
      back: () => this.stack.popTo(opener),
    }, preset);
    this.stack.push(menu);
  }

  /**
   * Push a confirm dialog. The safe choice pops it; the other runs `onYes`
   * first (which may itself move the stack) and then pops the dialog if it is
   * still there.
   */
  confirm(spec: ConfirmSpec, onYes: () => void): void {
    const dialog: Screen = confirmScreen(this.els.dialog, spec, () => {
      onYes();
      if (this.stack.top === dialog) this.stack.pop();
    }, () => {
      if (this.stack.top === dialog) this.stack.pop();
    });
    this.stack.push(dialog);
  }

  // -- layers -----------------------------------------------------------------

  /** Build and start a battle from a plain config, over the current screen. */
  launch(config: BattleConfig, origin: BattleOrigin): BattleLayer {
    if (this.live) throw new Error("a layer is already live");
    const env: BattleEnv = {
      win: this.env.win, canvas: this.els.canvas, ctx: this.els.ctx,
      hud: this.els.hud, abilityRoot: this.els.abilities,
    };
    const battle = new BattleLayer(config, env, {
      onOutcome: (o) => this.battleEnded(o),
      requestLeave: () => this.requestLeave(),
      simHeld: () => this.stack.pausesSim(),
    });
    this.origin = origin;
    this.enterLayer(battle);
    return battle;
  }

  private enterLayer(layer: Layer): void {
    switch (layer.kind) {
      case "battle":
        this.live = layer;
        this.router.setLayer(layer);
        this.stack.push(this.field);
        layer.start();
        layer.setContexts(this.stack.activeInputs());
        return;
      case "kingdom":
        // Typed, but not reachable until K1/K2 build it.
        throw new Error("the kingdom layer is not available yet");
    }
  }

  /** Called when the field screen is popped, however that happened. */
  private leaveLayer(): void {
    const layer = this.live;
    if (!layer) return;
    this.live = null;
    this.origin = null;
    this.router.setLayer(null);
    switch (layer.kind) {
      case "battle":
        layer.teardown();
        return;
      case "kingdom":
        layer.teardown();
        return;
    }
  }

  private battleEnded(outcome: Outcome): void {
    const origin = this.origin;
    const battle = this.live;
    if (!origin || !battle || battle.kind !== "battle") return;
    let chronicle: { entry: string; note?: string } | undefined;
    if (origin.kind === "campaign") {
      // A campaign battle is written into the chronicle the moment it ends,
      // win or lose, and the chronicler's entry heads the report.
      const entry = noteBattle(this.store, origin.chapter.id, outcome.winner === PLAYER);
      chronicle = {
        entry,
        note: this.store.status.kind === "memory-only" ? MEMORY_ONLY_NOTICE : undefined,
      };
    }
    // AA-01: the label names where the button goes, and it goes there.
    const again = origin.kind === "campaign" ? "Continue the chronicle"
      : origin.kind === "lesson" ? "Leave the lesson"
        : "Fight again";
    this.stack.push(afterActionScreen(this.els.report, battle.world, PLAYER, {
      again,
      onAgain: () => this.returnFromBattle("finished"),
      chronicle,
    }));
  }

  /** Esc on the field with nothing to cancel. */
  private requestLeave(): void {
    const origin = this.origin;
    if (!origin) return;
    const spec: ConfirmSpec = origin.kind === "lesson"
      ? {
        title: "Leave the lesson?",
        body: "You go back to the front screen. The lesson starts from the beginning next time.",
        yes: "Leave the lesson", no: "Stay",
      }
      : {
        title: "Leave the battle?",
        body: (origin.kind === "campaign" ? "Nothing is written in the chronicle. " : "") +
          "The battle is abandoned and you go back to the setup, with your army as you left it.",
        yes: "Leave the field", no: "Stay",
      };
    this.confirm(spec, () => this.returnFromBattle("left"));
  }

  /**
   * Back down the stack from a battle. A finished campaign battle goes back to
   * the chronicle; everything else goes back to the screen that launched it.
   */
  private returnFromBattle(how: "finished" | "left"): void {
    const origin = this.origin;
    if (!origin) return;
    switch (origin.kind) {
      case "skirmish":
        this.stack.popTo(origin.menu);
        return;
      case "campaign":
        this.stack.popTo(how === "finished" ? origin.chronicle : origin.menu);
        return;
      case "lesson":
        this.stack.popTo(this.home);
        return;
    }
  }
}

/** Boot the game on a page. main.ts and the e2e harness both call this. */
export function startApp(env: AppEnv): App {
  return new App(env);
}
