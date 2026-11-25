/**
 * The region card and the king card (docs/audit/u1-kingdom-map.md), as
 * screens on the stack.
 *
 * NON-MODAL (U1-04). A card is an overlay that leaves the map live under it:
 * its input contexts are pen, camera and ui, so the player can keep panning,
 * tap another holding (which replaces the card) or draw a march while reading.
 * It does not trap focus, and it focuses its HEADING on open (tabindex -1),
 * not its Close button: the key router leaves Space to a focused button, so a
 * focused Close would turn the pause key into "close the card". Close is one
 * Tab away. Esc closes the card -- unless a stroke is being drawn, in which
 * case the stroke claims Esc first (one owner per press).
 *
 * The values are refreshed in place when the layer says something changed
 * (the king moved, a day passed), so focus and the reader's place survive.
 *
 * K3b: the region card of one of the king's own holdings shows a SUMMARY of
 * its economy and an "Enter the city" button; the full economy panels (tax,
 * lots, fields and the build and sow menus) are in the city view now.
 */

import { domScreen } from "../dom-screen.ts";
import type { KeyVerdict, Screen } from "../screen-stack.ts";
import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import { TICKS_PER_DAY } from "../../sim/kingdom/clock.ts";
import { BIOMES, ROAD_TERRAIN, WEATHER_IDS } from "../../content/kingdom/terrain.ts";
import { FACTIONS } from "../../content/kingdom/factions.ts";
import { E, K, KIND_NAME, STAGE_NAME, TASK_NAME, TAX_NAME, WEATHER_LINE, etaWords } from "../../content/kingdom/ui-strings.ts";
import type { KingdomOrderBody } from "../../sim/kingdom/orders.ts";
import type { EconomyHooks } from "./economy-panel.ts";
import { taxPerDay } from "../../sim/kingdom/economy.ts";
import { BUILDINGS, type BuildingId } from "../../content/kingdom/buildings.ts";
import { CROPS, type CropId } from "../../content/kingdom/crops.ts";
import { C } from "../../content/kingdom/city-strings.ts";
import { AC } from "../../content/kingdom/army-strings.ts";
import { LEVY_MIN_MEN } from "../../content/kingdom/armies.ts";
import { armyById } from "../../sim/kingdom/armies.ts";
import { levyMenu, recruitTarget } from "./recruit-menu.ts";
import { INVASION_FEED, RUMOUR } from "../../content/kingdom/invasion-strings.ts";
import { levyMen } from "../../sim/kingdom/invasions.ts";

export type CardHooks = {
  /** Pop this card. */
  close(): void;
  /** True while a pen stroke is being drawn: Esc is the stroke's then. */
  strokeInProgress(): boolean;
  /** Issue a halt for the king (the king card's button). */
  halt(): void;
  /** The card left the stack, however that happened (Close, Esc, or the stack popped past it). */
  closed(): void;
  /** Issue an economy order from a card button, with the line to say (K3). */
  issue(body: KingdomOrderBody, said: string): void;
  /** Menus opened from the region card's economy panel (K3). */
  readonly economy: EconomyHooks;
  /** K3b: open the city view of one of the king's holdings (the economy panels live there now). */
  enterCity?(holding: number): void;
};

export type CardView = {
  readonly screen: Screen;
  readonly kind: "region" | "king" | "army";
  /** The holding shown, or 0 for the king and army cards. */
  readonly holding: number;
  /** The army shown (K4), or 0. */
  readonly army?: number;
  refresh(): void;
};

export function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function capital(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** A labelled row whose value can be refreshed. */
export function row(doc: Document, dl: HTMLElement, label: string): HTMLElement {
  dl.appendChild(make(doc, "dt", undefined, label));
  const dd = make(doc, "dd");
  dl.appendChild(dd);
  return dd;
}

export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * The shared frame: heading, sub-heading, rows, actions; Esc and focus as
 * described above. `back` names where focus goes when a menu opened from the
 * card closes (the control that opened it), before the heading.
 */
/** What the shared card frame needs of its owner (K3b: the city's cards use it too). */
export type FrameHooks = Pick<CardHooks, "close" | "strokeInProgress" | "closed">;

export function cardFrame(
  name: string, root: HTMLElement, doc: Document, hooks: FrameHooks,
  build: (body: HTMLElement, actions: HTMLElement) => void, refresh: () => void,
  back: () => HTMLElement | null = () => null,
): Screen {
  let heading: HTMLElement | null = null;
  let opened = false;
  return domScreen({
    name,
    kind: "overlay",
    root,
    display: "block",
    trapsFocus: false,
    pausesSim: false,
    inputs: ["pen", "camera", "ui"],
    // On open, the heading; on return from a menu, the control that opened it.
    firstFocus: () => (opened ? back() ?? heading : heading),
    revealed: () => refresh(),
    build: () => {
      opened = false;
      root.textContent = "";
      root.setAttribute("aria-labelledby", "k-card-title");
      heading = make(doc, "h2", "k-card-title");
      heading.id = "k-card-title";
      heading.setAttribute("tabindex", "-1");
      const body = make(doc, "div", "k-card-body");
      const actions = make(doc, "div", "k-card-actions");
      root.append(heading, body, actions);
      build(body, actions);
      const close = make(doc, "button", "k-btn", K.close);
      close.onclick = () => hooks.close();
      actions.appendChild(close);
      actions.appendChild(make(doc, "span", "k-hint", K.closeHint));
      refresh();
      opened = true;
    },
    teardown: () => hooks.closed(),
    onKey: (k): KeyVerdict => {
      if (k.code !== "Escape") return "pass";
      if (hooks.strokeInProgress()) return "pass";
      hooks.close();
      return "handled";
    },
  });
}

/**
 * The holding's economy in three short lines, for the region card (K3b: the
 * full panels moved into the city view; the card keeps a summary and the way in).
 */
function summaryLines(world: KingdomWorld, holdingId: number): { tax: string; lots: string; fields: string; famine: string } {
  const h = world.holding(holdingId)!;
  const built: string[] = [];
  let used = 0;
  h.buildings.forEach((b, i) => {
    if (b === null) return;
    used++;
    const name = BUILDINGS[b as BuildingId]?.name ?? b;
    built.push(h.works[i] > 0 ? E.slotBuilding({ name, days: h.works[i] }) : h.idle[i] ? E.slotIdle(name) : name);
  });
  const fields = h.plots.map((p) => {
    const crop = p.crop ? CROPS[p.crop as CropId] : null;
    if (!crop || p.stage === "empty") return STAGE_NAME.empty;
    return crop.name + " " + STAGE_NAME[p.stage] + (p.stage === "growing" ? " " + Math.floor(p.progress * 100) + "%" : "");
  });
  return {
    tax: C.summaryTax({ rate: TAX_NAME[h.tax], coin: E.coinAmount(taxPerDay(h.population, h.tax)) }),
    lots: C.summaryLots({ built: built.join(", "), used, total: h.buildings.length }),
    fields: C.summaryFields(fields),
    famine: h.famine > 0 ? C.famineSummary(h.famine) : "",
  };
}

export function regionCard(root: HTMLElement, doc: Document, world: KingdomWorld, holdingId: number, hooks: CardHooks): CardView {
  const h = world.holding(holdingId);
  if (!h) throw new Error("no holding " + holdingId);
  const def = world.map.holdings.find((d) => d.key === h.key);
  const province = world.map.provinces.find((p) => p.id === h.province);
  let owner: HTMLElement | null = null;
  let people: HTMLElement | null = null;
  let fromKing: HTMLElement | null = null;
  let summary: HTMLElement | null = null;
  let enter: HTMLElement | null = null;
  let heading: HTMLElement | null = null;
  let shownSummary = "";
  // K8: the defence tools a holding of the king's offers (the rumour card offers them too).
  const defence: { el: HTMLElement; order: KingdomOrderBody }[] = [];
  let defenceWhy: HTMLElement | null = null;
  let lastDefence: HTMLElement | null = null;

  const refresh = (): void => {
    if (!owner || !people || !fromKing || !summary || !enter) return;
    {
      const mine = h.owner === "king";
      let reason = "";
      for (const d of defence) {
        const want = mine ? "inline-block" : "none";
        if (d.el.style.display !== want) {
          if (want === "none" && doc.activeElement === d.el) heading?.focus();
          d.el.style.display = want;
        }
        const why = mine ? world.check(d.order) : null;
        if (why) d.el.setAttribute("aria-disabled", "true");
        else d.el.removeAttribute("aria-disabled");
        if (why && d.el === lastDefence) reason = E.notNow(why);
      }
      if (defenceWhy) {
        setText(defenceWhy, reason);
        defenceWhy.style.display = reason ? "block" : "none";
      }
    }
    setText(owner, h.owner === null ? capital(K.unclaimed) : capital(FACTIONS[h.owner].name));
    setText(people, String(h.population));
    const m = world.king.mover;
    if (m.road === 0 && m.node === h.id) setText(fromKing, K.kingHere);
    else {
      const plan = world.planKingRoute(h.id);
      setText(fromKing, plan ? capital(etaWords(plan.etaTicks, TICKS_PER_DAY)) + " by road" : "No road leads here");
    }
    // The holding's economy, for the king's own: a summary; the panels are in the city.
    const mine = h.owner === "king";
    const lines = mine ? summaryLines(world, h.id) : null;
    const sig = lines ? lines.tax + "|" + lines.lots + "|" + lines.fields + "|" + lines.famine : "";
    if (sig !== shownSummary) {
      shownSummary = sig;
      summary.textContent = "";
      summary.style.display = lines ? "block" : "none";
      if (lines) {
        summary.appendChild(make(doc, "h3", "k-section", E.economy));
        const dl = make(doc, "dl", "k-rows");
        row(doc, dl, C.taxRow).textContent = lines.tax;
        row(doc, dl, C.lotsRow).textContent = lines.lots;
        row(doc, dl, C.fieldsRow).textContent = lines.fields;
        summary.appendChild(dl);
        if (lines.famine) summary.appendChild(make(doc, "p", "k-warn", lines.famine));
      }
    }
    const want = mine && hooks.enterCity ? "inline-block" : "none";
    if (enter.style.display !== want) {
      if (want === "none" && doc.activeElement === enter) heading?.focus();
      enter.style.display = want;
    }
  };

  const screen = cardFrame("region-card", root, doc, hooks, (body, actions) => {
    const title = root.querySelector(".k-card-title") as HTMLElement;
    heading = title;
    title.textContent = h.name;
    body.appendChild(make(doc, "p", "k-sub",
      (province ? province.name : "") + (def?.seat ? " · " + K.seat : "")));
    const dl = make(doc, "dl", "k-rows");
    owner = row(doc, dl, K.held);
    row(doc, dl, "Kind").textContent = KIND_NAME[h.kind];
    row(doc, dl, K.country).textContent = capital(BIOMES[h.biome].name);
    people = row(doc, dl, K.people);
    row(doc, dl, K.slots).textContent = K.slotsLine({
      garrison: h.garrisonSlots, buildings: h.buildings.length, fields: h.plots.length,
    });
    const roads: string[] = [];
    for (const [n, rid] of world.graph.links.get(h.id) ?? []) {
      const other = world.holding(n);
      const r = world.graph.roads.get(rid);
      if (other && r) roads.push(K.roadTo({ name: other.name, surface: ROAD_TERRAIN[r.terrain].name }));
    }
    row(doc, dl, K.roads).textContent = roads.join(", ");
    fromKing = row(doc, dl, K.fromKing);
    body.appendChild(dl);
    summary = make(doc, "section", "k-economy");
    shownSummary = "-";
    body.appendChild(summary);
    enter = make(doc, "button", "k-btn k-enter", C.enter);
    enter.setAttribute("type", "button");
    enter.setAttribute("aria-label", C.enterAria(h.name));
    enter.style.display = "none";
    enter.onclick = () => hooks.enterCity?.(h.id);
    actions.appendChild(enter);
    defenceWhy = make(doc, "p", "k-why");
    defenceWhy.style.display = "none";
    body.appendChild(defenceWhy);
    const tool = (text: string, order: KingdomOrderBody, said: () => string): void => {
      const b = make(doc, "button", "k-btn", text);
      b.setAttribute("type", "button");
      b.setAttribute("data-key", order.kind);
      b.style.display = "none";
      b.onclick = () => {
        lastDefence = b;
        const why = world.check(order);
        if (why) {
          if (defenceWhy) { defenceWhy.textContent = E.notNow(why); defenceWhy.style.display = "block"; }
          return;
        }
        hooks.issue(order, said());
      };
      defence.push({ el: b, order });
      actions.appendChild(b);
    };
    tool(RUMOUR.levy, { kind: "callLevy", holding: h.id }, () => INVASION_FEED.levied({ place: h.name, men: levyMen(h) }));
    tool(RUMOUR.burn, { kind: "burnFields", holding: h.id }, () => INVASION_FEED.burned(h.name));
  }, refresh);
  return { screen, kind: "region", holding: holdingId, refresh };
}

export function kingCard(root: HTMLElement, doc: Document, world: KingdomWorld, hooks: CardHooks): CardView {
  let where: HTMLElement | null = null;
  let going: HTMLElement | null = null;
  let weather: HTMLElement | null = null;
  let halt: HTMLElement | null = null;
  let doing: HTMLElement | null = null;
  let heading: HTMLElement | null = null;
  let why: HTMLElement | null = null;
  let rides: HTMLElement | null = null;
  let levy: HTMLElement | null = null;
  const work: { el: HTMLElement; order: () => KingdomOrderBody | null; always: boolean }[] = [];

  /** Show a button when its order applies here; move focus off it first if it is about to vanish. */
  const offer = (b: HTMLElement, on: boolean): void => {
    const want = on ? "inline-block" : "none";
    if (b.style.display === want) return;
    if (!on && doc.activeElement === b) heading?.focus();
    b.style.display = want;
  };

  const refresh = (): void => {
    if (!where || !going || !weather || !halt || !doing || !why) return;
    setText(doing, capital(TASK_NAME[world.king.task]));
    let reason = "";
    for (const w of work) {
      const body = w.order();
      const refusal = body ? world.check(body) : "-";
      // Claim stays on offer at an unclaimed holding even when refused, so the
      // player learns what it needs; forage and rally show only when they apply.
      offer(w.el, body !== null && (refusal === null || w.always));
      if (body && w.always) {
        if (refusal) { w.el.setAttribute("aria-disabled", "true"); reason = E.notNow(refusal); }
        else w.el.removeAttribute("aria-disabled");
      }
      if (body && body.kind === "claimHolding") setText(w.el, E.claim(world.holding(body.holding)?.name ?? "?"));
    }
    // K4: the followers formed where he stands. On offer wherever he stands;
    // refused (and saying why) until there are enough of them.
    if (levy) {
      const at = world.king.mover.road === 0 ? world.king.mover.node : 0;
      offer(levy, at !== 0);
      const refusal = at ? world.check({ kind: "recruit", at, army: recruitTarget(world, at), unit: "line", levy: true }) : null;
      if (refusal) levy.setAttribute("aria-disabled", "true");
      else levy.removeAttribute("aria-disabled");
      if (refusal && !reason && doc.activeElement === levy) reason = E.notNow(refusal);
    }
    if (rides) setText(rides, armyById(world, world.king.army)?.name ?? AC.ridesAlone);
    setText(why, reason);
    why.style.display = reason ? "block" : "none";
    const m = world.king.mover;
    if (m.road === 0) {
      setText(where, K.atHolding(world.holding(m.node)?.name ?? "?"));
    } else {
      const r = world.graph.roads.get(m.road);
      setText(where, K.onRoad({
        surface: r ? ROAD_TERRAIN[r.terrain].name : "road",
        from: world.holding(m.from)?.name ?? "?",
        to: world.holding(m.to)?.name ?? "?",
        miles: Math.round(m.along),
      }));
    }
    const dest = m.route.length > 0 ? m.route[m.route.length - 1] : 0;
    const plan = dest ? world.planKingRoute(dest) : null;
    setText(going, dest && plan
      ? K.marchingTo({ name: world.holding(dest)?.name ?? "?", eta: etaWords(plan.etaTicks, TICKS_PER_DAY) })
      : K.kingStill);
    setText(weather, capital(WEATHER_LINE[WEATHER_IDS.includes(world.weather) ? world.weather : "clear"]));
    offer(halt, dest !== 0);
  };

  const screen = cardFrame("king-card", root, doc, hooks, (body, actions) => {
    const title = root.querySelector(".k-card-title") as HTMLElement;
    heading = title;
    title.textContent = world.king.name;
    body.appendChild(make(doc, "p", "k-sub", capital(FACTIONS.king.title)));
    const dl = make(doc, "dl", "k-rows");
    row(doc, dl, K.with).textContent = world.king.companions.join(", ");
    where = row(doc, dl, K.kingWhere);
    going = row(doc, dl, K.kingGoing);
    doing = row(doc, dl, E.kingTask);
    rides = row(doc, dl, AC.ridesWith);
    weather = row(doc, dl, K.weather);
    body.appendChild(dl);
    why = make(doc, "p", "k-why");
    body.appendChild(why);
    // The exile's work (K3): forage, rally, claim -- each an order through the queue.
    const here = (): number => (world.king.mover.road === 0 && world.king.mover.route.length === 0 ? world.king.mover.node : 0);
    const add = (text: string, order: () => KingdomOrderBody | null, said: string, always = false): void => {
      const b = make(doc, "button", "k-btn", text);
      b.style.display = "none";
      b.onclick = (e) => {
        const body = order();
        if (!body) return;
        const refusal = world.check(body);
        if (refusal) { if (why) { why.textContent = E.notNow(refusal); why.style.display = "block"; } return; }
        hooks.issue(body, said);
        if ((e as MouseEvent).detail > 0) b.blur();
      };
      work.push({ el: b, order, always });
      actions.appendChild(b);
    };
    add(E.forage, () => (here() ? { kind: "forage" } : null), E.forageDone);
    add(E.rally, () => (here() ? { kind: "rally" } : null), E.rallyDone);
    add(E.claim(""), () => {
      const at = here();
      const h = at ? world.holding(at) : undefined;
      return h && h.owner === null ? { kind: "claimHolding", holding: h.id } : null;
    }, E.chosen, true);
    // K4: "raise followers" -- the levy menu, where the king stands.
    const lv = make(doc, "button", "k-btn", AC.raiseLevy);
    lv.setAttribute("aria-haspopup", "dialog");
    lv.style.display = "none";
    lv.onclick = () => {
      const at = world.king.mover.road === 0 ? world.king.mover.node : 0;
      const refusal = at ? world.check({ kind: "recruit", at, army: recruitTarget(world, at), unit: "line", levy: true }) : null;
      if (refusal && world.kingStocks.stocks.levy < LEVY_MIN_MEN) {
        if (why) { why.textContent = E.notNow(refusal); why.style.display = "block"; }
        return;
      }
      hooks.economy.openMenu(levyMenu(doc, world, hooks.economy));
    };
    levy = lv;
    actions.appendChild(lv);
    halt = make(doc, "button", "k-btn", K.halt);
    const h = halt;
    // As in the HUD: a mouse press must not leave the button focused, or the
    // next Space (pause) would press Halt again.
    h.onclick = (e) => { hooks.halt(); if ((e as MouseEvent).detail > 0) h.blur(); };
    actions.appendChild(halt);
  }, refresh);
  return { screen, kind: "king", holding: 0, refresh };
}
