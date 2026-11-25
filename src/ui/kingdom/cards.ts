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
 */

import { domScreen } from "../dom-screen.ts";
import type { KeyVerdict, Screen } from "../screen-stack.ts";
import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import { TICKS_PER_DAY } from "../../sim/kingdom/clock.ts";
import { BIOMES, ROAD_TERRAIN, WEATHER_IDS } from "../../content/kingdom/terrain.ts";
import { FACTIONS } from "../../content/kingdom/factions.ts";
import { K, KIND_NAME, WEATHER_LINE, etaWords } from "../../content/kingdom/ui-strings.ts";

export type CardHooks = {
  /** Pop this card. */
  close(): void;
  /** True while a pen stroke is being drawn: Esc is the stroke's then. */
  strokeInProgress(): boolean;
  /** Issue a halt for the king (the king card's button). */
  halt(): void;
  /** The card left the stack, however that happened (Close, Esc, or the stack popped past it). */
  closed(): void;
};

export type CardView = {
  readonly screen: Screen;
  readonly kind: "region" | "king";
  /** The holding shown, or 0 for the king card. */
  readonly holding: number;
  refresh(): void;
};

function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function capital(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** A labelled row whose value can be refreshed. */
function row(doc: Document, dl: HTMLElement, label: string): HTMLElement {
  dl.appendChild(make(doc, "dt", undefined, label));
  const dd = make(doc, "dd");
  dl.appendChild(dd);
  return dd;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** The shared frame: heading, sub-heading, rows, actions; Esc and focus as described above. */
function cardFrame(
  name: string, root: HTMLElement, doc: Document, hooks: CardHooks,
  build: (body: HTMLElement, actions: HTMLElement) => void, refresh: () => void,
): Screen {
  let heading: HTMLElement | null = null;
  return domScreen({
    name,
    kind: "overlay",
    root,
    display: "block",
    trapsFocus: false,
    pausesSim: false,
    inputs: ["pen", "camera", "ui"],
    firstFocus: () => heading,
    build: () => {
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

export function regionCard(root: HTMLElement, doc: Document, world: KingdomWorld, holdingId: number, hooks: CardHooks): CardView {
  const h = world.holding(holdingId);
  if (!h) throw new Error("no holding " + holdingId);
  const def = world.map.holdings.find((d) => d.key === h.key);
  const province = world.map.provinces.find((p) => p.id === h.province);
  let owner: HTMLElement | null = null;
  let people: HTMLElement | null = null;
  let fromKing: HTMLElement | null = null;

  const refresh = (): void => {
    if (!owner || !people || !fromKing) return;
    setText(owner, h.owner === null ? capital(K.unclaimed) : capital(FACTIONS[h.owner].name));
    setText(people, String(h.population));
    const m = world.king.mover;
    if (m.road === 0 && m.node === h.id) setText(fromKing, K.kingHere);
    else {
      const plan = world.planKingRoute(h.id);
      setText(fromKing, plan ? capital(etaWords(plan.etaTicks, TICKS_PER_DAY)) + " by road" : "No road leads here");
    }
  };

  const screen = cardFrame("region-card", root, doc, hooks, (body) => {
    const title = root.querySelector(".k-card-title") as HTMLElement;
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
  }, refresh);
  return { screen, kind: "region", holding: holdingId, refresh };
}

export function kingCard(root: HTMLElement, doc: Document, world: KingdomWorld, hooks: CardHooks): CardView {
  let where: HTMLElement | null = null;
  let going: HTMLElement | null = null;
  let weather: HTMLElement | null = null;
  let halt: HTMLElement | null = null;

  const refresh = (): void => {
    if (!where || !going || !weather || !halt) return;
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
    halt.style.display = dest ? "inline-block" : "none";
  };

  const screen = cardFrame("king-card", root, doc, hooks, (body, actions) => {
    const title = root.querySelector(".k-card-title") as HTMLElement;
    title.textContent = world.king.name;
    body.appendChild(make(doc, "p", "k-sub", capital(FACTIONS.king.title)));
    const dl = make(doc, "dl", "k-rows");
    row(doc, dl, K.with).textContent = world.king.companions.join(", ");
    where = row(doc, dl, K.kingWhere);
    going = row(doc, dl, K.kingGoing);
    weather = row(doc, dl, K.weather);
    body.appendChild(dl);
    halt = make(doc, "button", "k-btn", K.halt);
    const h = halt;
    // As in the HUD: a mouse press must not leave the button focused, or the
    // next Space (pause) would press Halt again.
    h.onclick = (e) => { hooks.halt(); if ((e as MouseEvent).detail > 0) h.blur(); };
    actions.appendChild(halt);
  }, refresh);
  return { screen, kind: "king", holding: 0, refresh };
}
