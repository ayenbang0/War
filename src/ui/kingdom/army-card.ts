/**
 * The army card (K4; docs/audit/u2-army-panels.md "Army card"): what an army is
 * and every order it can take, as buttons -- the keyboard's way to give each
 * pen order (U2 A-01): march, halt, hold, patrol, rest, split, merge,
 * intercept, doctrine, abilities, the king's place, and standing down.
 *
 * The same non-modal frame as the king and region cards (cards.ts): the map
 * stays live under it, focus goes to its heading, Esc closes it. Orders that
 * need a choice (where to march, whom to meet) open the shared modal choice
 * menu, which holds the realm while it is open. Every button asks
 * KingdomWorld.check -- the same function that applies the order -- and a
 * refused one stays focusable with the reason beside it, as the king card's
 * Claim does, so a button never promises what the sim then refuses.
 *
 * Another faction's army gets a card too, read-only: what the scouts see.
 */

import { armyRestMorale } from "../../sim/kingdom/morale.ts";
import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { KingdomOrderBody } from "../../sim/kingdom/orders.ts";
import type { Army } from "../../sim/kingdom/state.ts";
import { TICKS_PER_DAY } from "../../sim/kingdom/clock.ts";
import { FACTIONS, FACTION_IDS, KING_PLAYER } from "../../content/kingdom/factions.ts";
import { UNIT_TYPES } from "../../content/unit-types.ts";
import { DOCTRINES, DOCTRINE_IDS } from "../../content/doctrines.ts";
import { ABILITIES, ABILITY_IDS } from "../../content/abilities.ts";
import { E, etaWords } from "../../content/kingdom/ui-strings.ts";
import { AC } from "../../content/kingdom/army-strings.ts";
import {
  abilityPrice, armiesOf, armyById, armyFitness, armyFullMen, armyMen, armyVisible, armyWage, planArmyRoute, standsIn,
  supplyDays,
} from "../../sim/kingdom/armies.ts";
import { knowsHolding } from "../../sim/kingdom/explore.ts";
import { cardFrame, make, row, setText, type CardHooks, type CardView } from "./cards.ts";
import { choiceMenu, type Option } from "./economy-panel.ts";

function capital(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** The strength line and bar (U2 A-04: a number of men AND a fit percentage, never a bar alone). */
export function strengthLine(a: Army): string {
  return AC.strengthLine({ men: armyMen(a), full: armyFullMen(a), fit: armyFitness(a) });
}

export function armyCard(root: HTMLElement, doc: Document, world: KingdomWorld, armyId: number, hooks: CardHooks): CardView {
  const army = (): Army | undefined => armyById(world, armyId);
  const first = army();
  if (!first) throw new Error("no army " + armyId);
  const own = first.owner === KING_PLAYER;
  const els: Record<string, HTMLElement> = {};
  let heading: HTMLElement | null = null;
  let why: HTMLElement | null = null;
  let squadList: HTMLElement | null = null;
  let bar: HTMLElement | null = null;
  let shownSquads = "";
  let last: HTMLElement | null = null;
  const buttons: { el: HTMLElement; order: () => KingdomOrderBody | null; show: () => boolean }[] = [];

  const offer = (b: HTMLElement, on: boolean): void => {
    const want = on ? "inline-block" : "none";
    if (b.style.display === want) return;
    if (!on && doc.activeElement === b) heading?.focus();
    b.style.display = want;
  };

  const doingLine = (a: Army): string => {
    const m = a.mover;
    if (a.target) return AC.chasing(armyById(world, a.target)?.name ?? "?");
    if (m.route.length > 0) {
      const dest = m.route[m.route.length - 1];
      const plan = planArmyRoute(world, a, dest);
      const name = world.holding(dest)?.name ?? "?";
      return capital(AC.marching(name)) + (plan ? ", " + etaWords(plan.etaTicks, TICKS_PER_DAY) : "");
    }
    return capital(AC.posture[a.posture]);
  };

  const refresh = (): void => {
    const a = army();
    if (!a || !why) {
      // Gone (merged, starved, stood down): the card says so and offers nothing.
      if (heading) setText(heading, (first.name) + " · gone");
      for (const b of buttons) offer(b.el, false);
      return;
    }
    if (heading) setText(heading, own ? AC.title(a.name) : AC.hostileTitle(a.name, FACTIONS[FACTION_IDS[a.owner]].name));
    const k = world.king;
    setText(els.led, k.army === a.id ? AC.ledByKing(k.name) : a.captain || AC.noCaptain);
    setText(els.doctrine, DOCTRINES[a.doctrine].name);
    setText(els.strength, strengthLine(a));
    if (bar) {
      const full = armyFullMen(a);
      const pct = full > 0 ? Math.round((armyMen(a) * 100) / full) : 0;
      bar.style.width = pct + "%";
      bar.parentElement?.setAttribute("aria-valuenow", String(pct));
    }
    if (own) {
      const at = world.holding(standsIn(a.mover));
      const home = at && at.owner === "king";
      setText(els.supply, AC.supplyLine({ grain: a.supply, days: supplyDays(a) }) + (home || k.army === a.id ? " · " + AC.supplyHome : "") +
        (a.hunger > 0 ? " · " + AC.hunger(a.hunger) : ""));
      const wage = armyWage(a);
      setText(els.wages, wage > 0 ? AC.wagesLine({ coin: wage, unpaid: a.unpaid }) : AC.wagesNone);
      setText(els.morale, AC.moraleLine({ morale: a.morale, rest: armyRestMorale(world, a), falling: a.hunger > 0 || a.unpaid > 0 }));
      setText(els.doing, doingLine(a));
      setText(els.abilities, a.abilities.length ? a.abilities.map((x) => ABILITIES[x].name).join(", ") : AC.abilitiesNone);
    }
    const sig = a.squads.map((s) => s.id + ":" + s.men + ":" + s.wounded).join(",");
    if (squadList && sig !== shownSquads) {
      shownSquads = sig;
      squadList.textContent = "";
      for (const s of a.squads) {
        const u = UNIT_TYPES[s.unit];
        squadList.appendChild(make(doc, "li", undefined, AC.squadRow({ name: u.name, men: s.men, full: u.soldiers, wounded: s.wounded, levy: s.levy })));
      }
    }
    let reason = "";
    for (const b of buttons) {
      const on = b.show();
      offer(b.el, on);
      if (!on) continue;
      const body = b.order();
      const refusal = body ? world.check(body) : null;
      if (refusal) {
        b.el.setAttribute("aria-disabled", "true");
        if (b.el === last) reason = E.notNow(refusal);
      } else b.el.removeAttribute("aria-disabled");
    }
    setText(why, reason);
    why.style.display = reason ? "block" : "none";
  };

  /** A button for an order; a refused press says why instead. */
  const add = (actions: HTMLElement, text: string, order: () => KingdomOrderBody | null, said: () => string, show: () => boolean = () => true): HTMLElement => {
    const b = make(doc, "button", "k-btn", text);
    b.setAttribute("type", "button");
    b.style.display = "none";
    b.onclick = (e) => {
      last = b;
      const body = order();
      if (!body) return;
      const refusal = world.check(body);
      if (refusal) {
        if (why) { why.textContent = E.notNow(refusal); why.style.display = "block"; }
        return;
      }
      hooks.issue(body, said());
      if ((e as MouseEvent).detail > 0) b.blur();
    };
    buttons.push({ el: b, order, show });
    actions.appendChild(b);
    return b;
  };

  /** A button that opens a choice menu (where to, whom). */
  const pick = (actions: HTMLElement, text: string, menu: () => { title: string; intro: string; options: () => Option[]; cancel?: string; safe?: boolean }, show: () => boolean = () => true): HTMLElement => {
    const b = make(doc, "button", "k-btn", text);
    b.setAttribute("type", "button");
    b.setAttribute("aria-haspopup", "dialog");
    b.style.display = "none";
    b.onclick = () => {
      last = b;
      const m = menu();
      hooks.economy.openMenu(choiceMenu(doc, {
        name: "army-menu", title: m.title, intro: m.intro, options: m.options, cancelLabel: m.cancel, focusCancel: m.safe,
      }, hooks.economy));
    };
    buttons.push({ el: b, order: () => null, show });
    actions.appendChild(b);
    return b;
  };

  const screen = cardFrame("army-card", root, doc, hooks, (body, actions) => {
    heading = root.querySelector(".k-card-title") as HTMLElement;
    const a0 = army() as Army;
    body.appendChild(make(doc, "p", "k-sub", own ? capital(FACTIONS.king.name) + "'s army" : AC.hostileNote));
    const dl = make(doc, "dl", "k-rows");
    els.led = row(doc, dl, AC.ledBy);
    els.doctrine = row(doc, dl, AC.doctrine);
    els.strength = row(doc, dl, AC.strength);
    // The bar is a meter, read out as a percentage; the line beside it says the same in words.
    const meter = make(doc, "div", "k-meter");
    meter.setAttribute("role", "meter");
    meter.setAttribute("aria-label", AC.strength);
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", "100");
    bar = make(doc, "div", "k-meter-fill");
    meter.appendChild(bar);
    els.strength.appendChild(meter);
    // The strength line goes in a span so the meter survives setText.
    const line = make(doc, "span");
    els.strength.insertBefore(line, els.strength.firstChild);
    els.strength = line;
    if (own) {
      els.supply = row(doc, dl, AC.supply);
      els.wages = row(doc, dl, AC.wages);
      els.morale = row(doc, dl, AC.morale);
      els.doing = row(doc, dl, AC.doing);
      els.abilities = row(doc, dl, AC.abilities);
    }
    body.appendChild(dl);
    body.appendChild(make(doc, "h3", "k-section", AC.squads));
    squadList = make(doc, "ul", "k-squads");
    body.appendChild(squadList);
    why = make(doc, "p", "k-why");
    body.appendChild(why);
    if (!own) return;

    const id = a0.id;
    const name = (): string => army()?.name ?? a0.name;
    const standing = (): boolean => (army()?.mover.road ?? 1) === 0;
    const moving = (): boolean => (army()?.mover.route.length ?? 0) > 0 || (army()?.target ?? 0) !== 0;

    pick(actions, AC.march, () => ({
      title: AC.pickMarch(name()), intro: "",
      options: () => world.holdings.filter((h) => knowsHolding(world, KING_PLAYER, h.id) && h.id !== standsIn(army()?.mover ?? first.mover)).map((h): Option => {
        const order: KingdomOrderBody = { kind: "marchArmy", army: id, to: h.id };
        const a = army();
        const plan = a ? planArmyRoute(world, a, h.id) : null;
        return {
          key: "march-" + h.id, label: h.name, lines: plan ? [capital(etaWords(plan.etaTicks, TICKS_PER_DAY)) + " by road"] : [],
          why: world.check(order), order, said: AC.arrived({ army: name(), name: h.name }).replace("reaches", "sets out for"),
        };
      }).sort((p, q) => (p.why ? 1 : 0) - (q.why ? 1 : 0)),
    }));
    add(actions, AC.halt, () => ({ kind: "haltArmy", army: id }), () => name() + ": halted.", moving);
    add(actions, AC.hold, () => ({ kind: "garrison", army: id }), () => "The " + name() + " digs in.", standing);
    pick(actions, AC.patrol, () => ({
      title: AC.pickPatrol(name()), intro: "",
      options: () => {
        const here = standsIn(army()?.mover ?? first.mover);
        return world.holdings.filter((h) => knowsHolding(world, KING_PLAYER, h.id) && h.id !== here).map((h): Option => {
          const order: KingdomOrderBody = { kind: "patrol", army: id, holdings: [here, h.id] };
          return {
            key: "patrol-" + h.id, label: (world.holding(here)?.name ?? "?") + " and " + h.name, lines: [],
            why: world.check(order), order, said: "The " + name() + " patrols " + (world.holding(here)?.name ?? "?") + " and " + h.name + ".",
          };
        }).sort((p, q) => (p.why ? 1 : 0) - (q.why ? 1 : 0));
      },
    }), standing);
    add(actions, AC.recover, () => ({ kind: "recover", army: id }), () => "The " + name() + " rests to mend.", standing);
    add(actions, AC.split, () => {
      const a = army();
      if (!a || a.squads.length < 2) return { kind: "split", army: id, squads: [] };
      const n = Math.floor(a.squads.length / 2);
      return { kind: "split", army: id, squads: a.squads.slice(a.squads.length - n).map((s) => s.id) };
    }, () => "Squads part from the " + name() + ".");
    pick(actions, AC.merge, () => ({
      title: AC.pickMerge(name()), intro: "",
      options: () => armiesOf(world, KING_PLAYER).filter((b) => b.id !== id).map((b): Option => {
        const order: KingdomOrderBody = { kind: "merge", army: id, into: b.id };
        return { key: "merge-" + b.id, label: b.name, lines: [strengthLine(b)], why: world.check(order), order, said: AC.mergedNews({ army: name(), into: b.name }) };
      }),
    }), () => armiesOf(world, KING_PLAYER).length > 1);
    pick(actions, AC.intercept, () => ({
      title: AC.pickIntercept(name()), intro: "",
      options: () => world.armies.filter((b) => b.owner !== KING_PLAYER && armyVisible(world, KING_PLAYER, b)).map((b): Option => {
        const order: KingdomOrderBody = { kind: "intercept", army: id, target: b.id };
        const who = AC.hostileTitle(b.name, FACTIONS[FACTION_IDS[b.owner]].name);
        return { key: "intercept-" + b.id, label: who, lines: [strengthLine(b)], why: world.check(order), order, said: "The " + name() + " marches to meet the " + b.name + "." };
      }),
    }), () => world.armies.some((b) => b.owner !== KING_PLAYER && armyVisible(world, KING_PLAYER, b)));
    pick(actions, AC.setDoctrine, () => ({
      title: AC.pickDoctrine(name()), intro: "",
      options: () => DOCTRINE_IDS.map((d): Option => {
        const order: KingdomOrderBody = { kind: "setDoctrine", army: id, doctrine: d };
        return { key: "doctrine-" + d, label: DOCTRINES[d].name, lines: [DOCTRINES[d].blurb], why: world.check(order), order, said: "The " + name() + " will fight " + DOCTRINES[d].name.toLowerCase() + "." };
      }),
    }));
    pick(actions, AC.unlock, () => ({
      title: AC.pickAbility(name()), intro: "",
      options: () => ABILITY_IDS.map((x): Option => {
        const order: KingdomOrderBody = { kind: "unlockAbility", army: id, ability: x };
        const p = abilityPrice(x, army()?.doctrine ?? first.doctrine);
        return { key: "ability-" + x, label: ABILITIES[x].name, lines: [AC.abilityCost(p), ABILITIES[x].blurb], why: world.check(order), order, said: ABILITIES[x].name + " is the " + name() + "'s to call on." };
      }),
    }));
    add(actions, AC.joinKing, () => ({ kind: "kingJoin", army: id }), () => "The king rides with the " + name() + ".", () => world.king.army !== id);
    add(actions, AC.leaveKing, () => ({ kind: "kingJoin", army: 0 }), () => "The king rides alone.", () => world.king.army === id);
    pick(actions, AC.disband, () => {
      const a = army();
      const at = a ? world.holding(standsIn(a.mover)) : undefined;
      const home = !!at && at.owner === "king";
      const men = a ? armyMen(a) : 0;
      const order: KingdomOrderBody = { kind: "disband", army: id };
      return {
        title: AC.disbandTitle(name()),
        intro: home ? AC.disbandHome({ men, grain: a?.supply ?? 0 }) : AC.disbandAway(men),
        options: () => [{ key: "disband", label: AC.disbandYes, lines: [], why: world.check(order), order, said: AC.armyGone.disbanded(name()) }],
        cancel: AC.disbandKeep,
        safe: true,
      };
    });
  }, refresh, () => last);
  return { screen, kind: "army", holding: 0, army: armyId, refresh };
}
