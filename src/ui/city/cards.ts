/**
 * The city's cards (K3b; docs/audit/u2-city-view.md): a LOT, a FIELD and
 * the town's POLITICS. They share the region card's frame (ui/kingdom/
 * cards.ts): non-modal overlays that leave the plan live under them, focus
 * on their heading, Esc or Close shuts them, and a tap on another lot
 * replaces the card. The build and sow menus they open are K3's modal menus,
 * unchanged, so a choice is checked by the same KingdomWorld.check the sim
 * uses and goes out as the same order.
 *
 * LOT ORDER (docs/PROVISIONAL.md K3b.1): the sim's build order takes the
 * holding's first free slot, so a town builds round its square in turn. The
 * card says so: a free lot that is not next opens the build menu FOR THE
 * NEXT LOT, and the menu says which lot that is. No lot ever promises a
 * building it would not get.
 */

import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { Holding } from "../../sim/kingdom/state.ts";
import type { KingdomOrderBody } from "../../sim/kingdom/orders.ts";
import type { Screen } from "../screen-stack.ts";
import { cardFrame, make, row, setText, type FrameHooks } from "../kingdom/cards.ts";
import { buildMenu, economyPanel, sowMenu, type EconomyHooks, type EconomyPanel } from "../kingdom/economy-panel.ts";
import { BUILDINGS, BUILDING_IDS, type BuildingId } from "../../content/kingdom/buildings.ts";
import { CROPS, type CropId } from "../../content/kingdom/crops.ts";
import { E, STAGE_NAME, amountsLine } from "../../content/kingdom/ui-strings.ts";
import { C } from "../../content/kingdom/city-strings.ts";
import { AC, ARMY_REFUSAL } from "../../content/kingdom/army-strings.ts";
import { hasBarracks } from "../../sim/kingdom/armies.ts";
import { recruitMenu } from "../kingdom/recruit-menu.ts";
import { politicsSection, type PoliticsSection } from "./politics.ts";

export type CityCardHooks = FrameHooks & {
  issue(body: KingdomOrderBody, said: string): void;
  readonly economy: EconomyHooks;
};

export type CityCardView = {
  readonly screen: Screen;
  readonly kind: "lot" | "field" | "politics";
  /** The lot or field shown (0-based), or -1 for politics. */
  readonly index: number;
  refresh(): void;
};

function button(doc: Document, text: string, key: string): HTMLElement {
  const b = make(doc, "button", "k-btn", text);
  b.setAttribute("type", "button");
  b.setAttribute("data-key", key);
  return b;
}

function pressed(b: HTMLElement, e: Event): void {
  if ((e as MouseEvent).detail > 0) b.blur();
}

function show(el: HTMLElement, on: boolean, display = "inline-block"): void {
  const want = on ? display : "none";
  if (el.style.display !== want) el.style.display = want;
}

/** The building that can go over the one on this lot, if any. */
function upgradeOf(id: BuildingId): BuildingId | null {
  return BUILDING_IDS.find((b) => BUILDINGS[b].upgrades === id) ?? null;
}

// -- a lot -------------------------------------------------------------------------

export function lotCard(root: HTMLElement, doc: Document, world: KingdomWorld, holdingId: number, index: number, hooks: CityCardHooks): CityCardView {
  const h = world.holding(holdingId) as Holding;
  let state: HTMLElement | null = null;
  let upkeep: HTMLElement | null = null;
  let about: HTMLElement | null = null;
  let note: HTMLElement | null = null;
  let build: HTMLElement | null = null;
  let recruit: HTMLElement | null = null;
  let heading: HTMLElement | null = null;
  let buildLabel = "";
  let buildNote = "";

  const refresh = (): void => {
    if (!state || !upkeep || !about || !note || !build) return;
    const id = h.buildings[index] as BuildingId | null;
    const next = h.buildings.indexOf(null);
    if (id === null) {
      setText(state, next === index ? C.lotNext : C.lotLater);
      setText(upkeep, C.upkeepNone);
      setText(about, "");
      setText(note, next === index ? C.lotCardNext : C.lotCardLater(next + 1));
      buildLabel = next === index ? C.buildHere : C.buildOn(next + 1);
      buildNote = C.buildMenuFor(next + 1);
    } else {
      const def = BUILDINGS[id];
      setText(state, h.works[index] > 0 ? C.stateWorks({ left: h.works[index], total: def.days })
        : h.idle[index] ? C.stateIdle : C.stateStanding);
      const paid = Object.values(def.upkeep).some((v) => (v ?? 0) > 0);
      setText(upkeep, paid ? C.upkeepLine(amountsLine(def.upkeep)) : C.upkeepNone);
      setText(about, def.purpose);
      const up = h.works[index] > 0 ? null : upgradeOf(id);
      const ring = id === "palisade" || id === "wall" || id === "keep";
      setText(note, [up ? C.upgrade(BUILDINGS[up].name) : "", ring ? C.enclosure : ""].filter(Boolean).join(" ")
        || (next < 0 ? C.lotCardFull : ""));
      if (up) {
        buildLabel = C.buildHere;
        buildNote = C.upgrade(BUILDINGS[up].name);
      } else if (next >= 0) {
        // The town still has room: the menu is reachable from every lot, and says where it goes.
        buildLabel = C.buildOn(next + 1);
        buildNote = C.buildMenuFor(next + 1);
      } else {
        buildLabel = "";
      }
    }
    const offer = buildLabel !== "" && h.owner === "king";
    if (!offer && doc.activeElement === build) heading?.focus();
    show(build, offer);
    // K4: a barracks lot raises trained squads -- on offer while it stands,
    // refused (and saying why) while it is still being built or unpaid.
    if (recruit) {
      const isBarracks = id === "barracks" && h.owner === "king";
      if (!isBarracks && doc.activeElement === recruit) heading?.focus();
      show(recruit, isBarracks);
      const why = isBarracks && !hasBarracks(h) ? ARMY_REFUSAL.needsBarracks : null;
      if (why) recruit.setAttribute("aria-disabled", "true");
      else recruit.removeAttribute("aria-disabled");
    }
    setText(build, buildLabel || C.buildHere);
    build.setAttribute("aria-label", (buildLabel || C.buildHere) + " " + h.name);
    if (heading) setText(heading, C.lotTitle(index + 1) + " · " + h.name);
  };

  const screen = cardFrame("lot-card", root, doc, hooks, (body, actions) => {
    heading = root.querySelector(".k-card-title") as HTMLElement;
    const dl = make(doc, "dl", "k-rows");
    state = row(doc, dl, C.state);
    upkeep = row(doc, dl, C.upkeep);
    body.appendChild(dl);
    about = make(doc, "p", "k-sub");
    note = make(doc, "p", "c-note");
    body.append(about, note);
    build = button(doc, C.buildHere, "build");
    build.setAttribute("aria-haspopup", "dialog");
    build.onclick = () => hooks.economy.openMenu(buildMenu(doc, world, h, hooks.economy, buildNote));
    actions.appendChild(build);
    const rb = button(doc, AC.recruitButton, "recruit");
    rb.setAttribute("aria-haspopup", "dialog");
    rb.onclick = () => {
      if (!hasBarracks(h)) {
        if (note) setText(note, E.notNow(ARMY_REFUSAL.needsBarracks));
        return;
      }
      hooks.economy.openMenu(recruitMenu(doc, world, h.id, hooks.economy));
    };
    recruit = rb;
    actions.appendChild(rb);
  }, refresh, () => build);
  return { screen, kind: "lot", index, refresh };
}

// -- a field -----------------------------------------------------------------------

export function fieldCard(root: HTMLElement, doc: Document, world: KingdomWorld, holdingId: number, index: number, hooks: CityCardHooks): CityCardView {
  const h = world.holding(holdingId) as Holding;
  const plot = h.plots[index];
  let crop: HTMLElement | null = null;
  let stage: HTMLElement | null = null;
  let health: HTMLElement | null = null;
  let sow: HTMLElement | null = null;
  let harvest: HTMLElement | null = null;
  let heading: HTMLElement | null = null;
  let last: HTMLElement | null = null;

  const refresh = (): void => {
    if (!crop || !stage || !health || !sow || !harvest) return;
    const p = h.plots[index];
    const def = p.crop ? CROPS[p.crop as CropId] : null;
    setText(crop, def && p.stage !== "empty" ? def.name : C.nothingSown);
    setText(stage, STAGE_NAME[p.stage] + (p.stage === "growing" ? " " + Math.floor(p.progress * 100) + "%" : ""));
    setText(health, C.healthLine(p.health));
    const open = p.stage === "empty" || p.stage === "harvested" || p.stage === "spoiled";
    const canSow = open && !(p.stage === "harvested" && def?.regrowDays) && h.owner === "king";
    const canReap = p.stage === "ripe" && h.owner === "king";
    if (!canSow && doc.activeElement === sow) heading?.focus();
    if (!canReap && doc.activeElement === harvest) heading?.focus();
    show(sow, canSow);
    show(harvest, canReap);
    if (heading) setText(heading, C.fieldTitle(index + 1) + " · " + h.name);
  };

  const screen = cardFrame("field-card", root, doc, hooks, (body, actions) => {
    heading = root.querySelector(".k-card-title") as HTMLElement;
    const dl = make(doc, "dl", "k-rows");
    crop = row(doc, dl, C.crop);
    stage = row(doc, dl, C.stage);
    health = row(doc, dl, C.health);
    body.appendChild(dl);
    sow = button(doc, E.sow, "sow");
    sow.setAttribute("aria-haspopup", "dialog");
    sow.setAttribute("aria-label", E.sowField(index + 1));
    sow.onclick = () => { last = sow; hooks.economy.openMenu(sowMenu(doc, world, h, index, hooks.economy)); };
    harvest = button(doc, E.harvest, "harvest");
    harvest.setAttribute("aria-label", E.harvestField(index + 1));
    harvest.onclick = (e) => {
      last = harvest;
      hooks.issue({ kind: "harvest", plot: plot.id }, E.chosen);
      pressed(harvest as HTMLElement, e);
    };
    actions.append(sow, harvest);
  }, refresh, () => (last && last.style.display !== "none" ? last : null));
  return { screen, kind: "field", index, refresh };
}

// -- politics ----------------------------------------------------------------------

export function politicsCard(root: HTMLElement, doc: Document, world: KingdomWorld, holdingId: number, hooks: CityCardHooks): CityCardView {
  const h = world.holding(holdingId) as Holding;
  let people: HTMLElement | null = null;
  let panel: EconomyPanel | null = null;
  let morale: PoliticsSection | null = null;
  let heading: HTMLElement | null = null;

  const refresh = (): void => {
    if (!people || !panel) return;
    setText(people, String(h.population));
    panel.refresh();
    morale?.refresh();
    if (heading) setText(heading, C.politicsTitle(h.name));
  };

  const screen = cardFrame("politics-card", root, doc, hooks, (body) => {
    heading = root.querySelector(".k-card-title") as HTMLElement;
    const dl = make(doc, "dl", "k-rows");
    people = row(doc, dl, C.people);
    body.appendChild(dl);
    // Tax, bread and famine: K3's own section, the same buttons and orders.
    panel = economyPanel(doc, world, holdingId, hooks.economy, { sections: ["tax"], title: null });
    body.appendChild(panel.root);
    // K6: loyalty and unrest, what moves it, and the levers (politics.ts).
    morale = politicsSection(doc, world, h, hooks);
    body.appendChild(morale.root);
    // What the realm does not reckon yet, said plainly (audit C-04): the lords are K8's.
    const later = make(doc, "dl", "k-rows c-later");
    row(doc, later, C.lords).textContent = C.lordsNotYet;
    body.appendChild(later);
  }, refresh, () => morale?.focusTarget() ?? panel?.focusTarget() ?? null);
  return { screen, kind: "politics", index: -1, refresh };
}
