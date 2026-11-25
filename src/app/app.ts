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
import { homeScreen, type ExileStatus, type HomeChoice } from "../ui/home.ts";
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
import { KingdomWorld } from "../sim/kingdom/world.ts";
import { K, dateLine } from "../content/kingdom/ui-strings.ts";
import { KingdomLayer, type KingdomOpening } from "./kingdom-layer.ts";
import { CityLayer } from "./city-layer.ts";
import type { MapPoint } from "../render/kingdom/layout.ts";
import { clearKingdom, loadKingdom, type StorageLike } from "./kingdom-save.ts";

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

  /**
   * The kingdom map's place on the stack, as `field` is the battle's. Unlike
   * the battle it hides its HUD while a full screen covers it, because the
   * kingdom HUD is its own DOM rather than the shared #hud.
   */
  private readonly realm: Screen = {
    name: "kingdom",
    kind: "full",
    trapsFocus: false,
    pausesSim: false,
    inputs: ["pen", "camera", "ui"],
    firstFocus: () => null,
    mount: () => { /* the layer is started by enterRealm() */ },
    unmount: () => this.leaveLayer(),
    setVisible: (v) => {
      if (this.live?.kind === "kingdom") this.live.setShown(v);
      else if (this.live?.kind === "city") this.live.realm.setShown(v);
    },
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
    this.home = homeScreen(this.els.home, (c) => this.choose(c), () => this.exileStatus());
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
    else if (choice === "exile") this.openExile();
    else if (choice === "exile-new") this.newExile();
    else this.launch(lessonConfig(), { kind: "lesson" });
  }

  // -- the kingdom (K2) ---------------------------------------------------------

  /**
   * The kingdom save's storage. Touching localStorage can itself throw, so
   * the provider is asked inside a try; null means "nowhere to save", which
   * the layer then says (U1-14) rather than pretending.
   */
  private kingdomStorage(): StorageLike | null {
    try {
      return (this.env.storage ?? (() => this.env.win.localStorage))();
    } catch {
      return null;
    }
  }

  /** For the front screen. */
  private exileStatus(): ExileStatus {
    const r = loadKingdom(this.kingdomStorage());
    if (r.ok) return r.world ? { kind: "saved", when: dateLine(r.world.date) } : { kind: "none" };
    return r.reason === "corrupt" ? { kind: "unreadable" } : { kind: "none" };
  }

  /** Continue the saved realm, or begin one if there is none. */
  private openExile(): void {
    const storage = this.kingdomStorage();
    const r = loadKingdom(storage);
    if (r.ok) {
      if (r.world) this.enterRealm(r.world, "resumed", storage);
      else this.enterRealm(freshRealm(), "begun", storage);
      return;
    }
    if (r.reason === "corrupt") {
      // U1-15 (P0): an unreadable save is never overwritten without asking.
      this.confirm({
        title: K.unreadableTitle, body: K.unreadableBody(r.detail), yes: K.unreadableYes, no: K.unreadableNo,
      }, () => this.enterRealm(freshRealm(), "begun", storage));
      return;
    }
    // Storage could not even be read: play in memory, and say so.
    this.enterRealm(freshRealm(), "begun", null, K.notSaved(r.detail));
  }

  /** "Begin a new exile": always behind a confirm, because it throws a realm away. */
  private newExile(): void {
    this.confirm({ title: K.newTitle, body: K.newBody, yes: K.newYes, no: K.newNo }, () => {
      const storage = this.kingdomStorage();
      const cleared = clearKingdom(storage);
      this.enterRealm(freshRealm(), "begun", storage, cleared.ok ? null : K.notSaved(cleared.detail));
    });
  }

  private enterRealm(world: KingdomWorld, opening: KingdomOpening, storage: StorageLike | null, notice: string | null = null): KingdomLayer {
    if (this.live) throw new Error("a layer is already live");
    const layer = new KingdomLayer(world, {
      win: this.env.win, doc: this.env.doc, canvas: this.els.canvas, ctx: this.els.ctx, storage,
    }, {
      // Leaving the map needs no confirm: it saves, and Continue brings it back
      // exactly (docs/PROVISIONAL.md K2.3).
      requestLeave: () => this.stack.popTo(this.home),
      simHeld: () => this.stack.pausesSim(),
      pushScreen: (s) => this.stack.push(s),
      popScreen: (s) => { if (this.stack.top === s) this.stack.pop(); },
      enterCity: (holding, from) => this.enterCity(layer, holding, from),
    }, opening, notice);
    this.enterLayer(layer);
    return layer;
  }

  // -- the city (K3b) -------------------------------------------------------------

  /**
   * Down a layer: the city of one of the king's holdings. The kingdom layer
   * is suspended, not torn down; the city's screen goes above the kingdom's,
   * so the kingdom HUD (date, speed, stores, alerts) stays over the town.
   */
  enterCity(realm: KingdomLayer, holding: number, from: MapPoint): CityLayer | null {
    if (this.live !== realm || realm.phase !== "live") return null;
    // Whatever was over the map (its card) goes first.
    if (this.stack.has(this.realm) && this.stack.top !== this.realm) this.stack.popTo(this.realm);
    realm.suspend();
    const city = new CityLayer(realm, holding, {
      win: this.env.win, doc: this.env.doc, canvas: this.els.canvas, ctx: this.els.ctx,
    }, {
      requestLeave: () => { if (this.stack.has(city.screen)) this.stack.popTo(this.realm); },
      pushScreen: (s) => this.stack.push(s),
      popScreen: (s) => { if (this.stack.top === s) this.stack.pop(); },
    }, from);
    city.onUnmount = () => this.cityLeft(city);
    this.enterLayer(city);
    return city;
  }

  /** The city screen left the stack, however that happened: back up to the map. */
  private cityLeft(city: CityLayer): void {
    if (this.live !== city) return;
    const realm = city.realm;
    city.teardown();
    this.live = realm;
    this.router.setLayer(realm);
    realm.resume(city.holding, city.leftWith);
    // The stack's change (this pop) hands the realm its input contexts.
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
        this.live = layer;
        this.router.setLayer(layer);
        this.stack.push(this.realm);
        layer.start();
        layer.setContexts(this.stack.activeInputs());
        return;
      case "city":
        // Started before the push: the push focuses the panel's heading.
        this.live = layer;
        this.router.setLayer(layer);
        layer.start();
        this.stack.push(layer.screen);
        layer.setContexts(this.stack.activeInputs());
        return;
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
      case "city":
        // Not reached in play (the city's screen is above the realm's and
        // leaves first), but never leave a realm running under a dead city.
        layer.teardown();
        layer.realm.teardown();
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

/**
 * A new realm. The seed is the wall clock mixed with Math.random: the app may
 * use both (only src/sim/ may not), and the seed is saved with the realm, so
 * a continued game is the same game (docs/PROVISIONAL.md K2.7).
 */
function freshRealm(): KingdomWorld {
  return new KingdomWorld({ seed: (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) | 0 });
}

/** Boot the game on a page. main.ts and the e2e harness both call this. */
export function startApp(env: AppEnv): App {
  return new App(env);
}
