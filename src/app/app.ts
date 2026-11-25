/**
 * The layer controller: owns the screen stack, the one key router and the live
 * layer, and moves the player between them.
 *
 * This is what main.ts used to be as a linear script -- home, then campaign,
 * then menu, then exactly one World, then an after-action report whose every
 * button called `location.reload()`. Now each of those is a screen on the stack
 * and each layer has a start and a teardown, so:
 *
 *  - the kingdom map, and the city below it, are entered from Home and leave
 *    back to it, saving on the way;
 *  - leaving the lesson or a battle goes through a confirm on the stack;
 *  - a second battle is built without a reload, because the first one tore
 *    down every listener and loop it had.
 *
 * The game is the story only (the owner's amendment to PLAN.md): the old
 * skirmish setup and the Marchwarden chronicle are gone as modes. A battle is
 * reached from the lesson today, from the story when armies meet (K5), and in
 * tests through `launch` with the "test" origin (test-hook.ts).
 *
 * Layers (plan §B.1) are a typed union: kingdom, city and battle.
 */

import { homeScreen, type ExileStatus, type HomeChoice } from "../ui/home.ts";
import { afterActionScreen } from "../ui/after-action.ts";
import { confirmScreen, type ConfirmSpec } from "../ui/dialog.ts";
import { ScreenStack, type FocusHost, type Focusable, type Screen } from "../ui/screen-stack.ts";
import { KeyRouter, attachKeyRouter, classifyFocus } from "../ui/keys.ts";
import { BattleLayer, PLAYER, type BattleEnv } from "./battle-layer.ts";
import { battleFromSpec, lessonConfig, type BattleConfig } from "./battle-config.ts";
import type { Contact } from "../sim/kingdom/state.ts";
import type { BattleResult, BattleSpec } from "../sim/layers.ts";
import { buildBattleSpec, contactPoint, resultFromBattle } from "../sim/kingdom/descent.ts";
import { DESCENT } from "../content/kingdom/descent-strings.ts";
import { consequenceLines } from "../ui/kingdom/consequences.ts";
import type { Layer } from "./layers.ts";
import { KingdomWorld } from "../sim/kingdom/world.ts";
import { K, dateLine } from "../content/kingdom/ui-strings.ts";
import { KingdomLayer, type KingdomOpening } from "./kingdom-layer.ts";
import { CityLayer } from "./city-layer.ts";
import type { MapPoint } from "../render/kingdom/layout.ts";
import { clearKingdom, loadKingdom, type StorageLike } from "./kingdom-save.ts";

export type AppEnv = {
  readonly win: Window;
  readonly doc: Document;
  /** Where the realm is saved. Defaults to the window's localStorage. */
  readonly storage?: () => StorageLike | null;
};

/**
 * Where a battle was launched from, so its end knows where to go back to.
 *
 * "lesson" is Home's Learn the gestures (until K9 folds it into the story's
 * opening). "test" is the e2e and ui-check launch (TestHook.launchBattle): a
 * normal battle with no story behind it, which goes back to Home. "story"
 * (K5) is a contact on the kingdom map fought as a battle: its end applies
 * the result to the realm and goes back to the map, at the point the armies
 * met.
 */
export type BattleOrigin =
  | { readonly kind: "lesson" }
  | { readonly kind: "test" }
  | StoryOrigin;

/** K5: a battle descended into from the kingdom map. */
export type StoryOrigin = {
  readonly kind: "story";
  readonly realm: KingdomLayer;
  readonly contact: Contact;
  readonly spec: BattleSpec;
  /** Where on the map the armies met: the camera comes back here. */
  readonly at: MapPoint;
  /** The result taken back to the realm, once it has been. */
  result: BattleResult | null;
};

/** The page elements the app draws into. All exist in index.html and e2e.html. */
type Elements = {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly home: HTMLElement;
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
    home: byId("home"), report: byId("report"),
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
      // preventScroll: a screen's first focus may sit below the fold of a
      // long panel, and the panel must still open at its top.
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
  /** The live layer, or null while only menu screens are up. */
  live: Layer | null = null;
  /** Where the current battle came from. Null while no battle is live. */
  origin: BattleOrigin | null = null;
  /** K5: the realm suspended under a story battle, or null. */
  descended: KingdomLayer | null = null;

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
      else if (this.descended) this.descended.setShown(v);
    },
  };

  constructor(env: AppEnv) {
    this.env = env;
    this.els = lookUp(env.doc);
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
    if (choice === "exile") this.openExile();
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
      descend: () => { this.descend(layer); },
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

  // -- the descent (K5) -----------------------------------------------------------

  /**
   * Down a layer from the map into the battle the waiting contact is fought
   * as (PLAN.md §B.9). The realm is suspended, not torn down, as under a
   * city; it is held anyway (the sim does not move while a contact waits).
   * The army arrives pre-built from the kingdom, so deployment is only the
   * zone and the confirm (Enter), never a purse.
   */
  descend(realm: KingdomLayer): BattleLayer | null {
    const c = realm.world.contact;
    if (!c || this.live !== realm || realm.phase !== "live") return null;
    if (this.stack.has(this.realm) && this.stack.top !== this.realm) this.stack.popTo(this.realm);
    const spec = buildBattleSpec(realm.world, c);
    const at = contactPoint(realm.world, c);
    realm.suspend("battle");
    this.live = null;
    this.router.setLayer(null);
    this.descended = realm;
    return this.launch(battleFromSpec(spec), { kind: "story", realm, contact: c, spec, at, result: null });
  }

  /** Take a story battle's result back to the realm, once. */
  private settleStory(origin: StoryOrigin, battle: BattleLayer, leftBy: number | null): string[] {
    if (origin.result) return [];
    const result = resultFromBattle(origin.spec, battle.world, battle.fielded, leftBy);
    origin.result = result;
    const events = origin.realm.settleBattle(result);
    return consequenceLines(origin.realm.world, origin.spec, result, events);
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
      onOutcome: () => this.battleEnded(),
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
    const origin = this.origin;
    this.live = null;
    this.origin = null;
    this.router.setLayer(null);
    switch (layer.kind) {
      case "battle":
        layer.teardown();
        // K5: back up to the map, at the point the armies met.
        if (origin?.kind === "story" && this.descended === origin.realm) {
          const realm = origin.realm;
          this.descended = null;
          if (realm.phase !== "live") return;
          this.live = realm;
          this.router.setLayer(realm);
          realm.resumeAt(origin.at);
        }
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

  /** The battle has an outcome; the report reads it from the world. */
  private battleEnded(): void {
    const origin = this.origin;
    const battle = this.live;
    if (!origin || !battle || battle.kind !== "battle") return;
    if (origin.kind === "story") {
      // K5: the result goes back to the realm now (and is saved), and the
      // report says what it meant there before the button takes you back.
      const lines = this.settleStory(origin, battle, null);
      this.stack.push(afterActionScreen(this.els.report, battle.world, PLAYER, {
        again: DESCENT.backToMap,
        onAgain: () => this.returnFromBattle(),
        realm: { heading: DESCENT.heading, lines },
      }));
      return;
    }
    // AA-01: the label names where the button goes, and it goes there. The
    // lesson and the test launch go back to the front screen.
    const again = origin.kind === "lesson" ? "Leave the lesson" : "Back to the front screen";
    this.stack.push(afterActionScreen(this.els.report, battle.world, PLAYER, {
      again,
      onAgain: () => this.returnFromBattle(),
    }));
  }

  /** Esc on the field with nothing to cancel. */
  private requestLeave(): void {
    const origin = this.origin;
    if (!origin) return;
    if (origin.kind === "story") {
      // K5: leaving a story battle mid-fight is a withdrawal under fire
      // (docs/PROVISIONAL.md K5.6): the losses so far stand, the rearguard
      // is paid, the army falls back -- or is taken, cut off.
      this.confirm({ title: DESCENT.leaveTitle, body: DESCENT.leaveBody, yes: DESCENT.leaveYes, no: DESCENT.leaveNo }, () => {
        const battle = this.live;
        if (battle?.kind === "battle") this.settleStory(origin, battle, 0);
        this.returnFromBattle();
      });
      return;
    }
    const spec: ConfirmSpec = origin.kind === "lesson"
      ? {
        title: "Leave the lesson?",
        body: "You go back to the front screen. The lesson starts from the beginning next time.",
        yes: "Leave the lesson", no: "Stay",
      }
      : {
        title: "Leave the battle?",
        body: "The battle is abandoned and you go back to the front screen.",
        yes: "Leave the field", no: "Stay",
      };
    this.confirm(spec, () => this.returnFromBattle());
  }

  /** Back down the stack from a battle, finished or left: to the front screen, or (K5) to the map. */
  private returnFromBattle(): void {
    if (!this.origin) return;
    if (this.origin.kind === "story") this.stack.popTo(this.realm);
    else this.stack.popTo(this.home);
  }
}

/**
 * A new realm. The seed is the wall clock mixed with Math.random: the app may
 * use both (only src/sim/ may not), and the seed is saved with the realm, so
 * a continued game is the same game (docs/PROVISIONAL.md K2.7).
 */
function freshRealm(): KingdomWorld {
  // K5: a new campaign opens with its first enemy in the field (content/kingdom/descent.ts OPENING_HOSTS).
  return new KingdomWorld({ seed: (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) | 0, hosts: true });
}

/** Boot the game on a page. main.ts and the e2e harness both call this. */
export function startApp(env: AppEnv): App {
  return new App(env);
}
