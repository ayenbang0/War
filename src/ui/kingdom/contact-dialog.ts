/**
 * The contact interstitial (K5, PLAN.md §B.9): two armies have met, the realm
 * has halted, and the king is asked "Riders on the Harrowfield road -- fight
 * or withdraw?", with "Resolve for me" beside them.
 *
 * Modal and clock-holding, like the event card (event-card.ts), and for the
 * same reason: it is a decision, and nothing on the map may move while it is
 * made -- the sim holds the realm on its own anyway (sim/kingdom/descent.ts),
 * so this only keeps the clock's display honest. Focus goes to the TITLE on
 * open (tabindex -1), so a reader hears who has met whom before the choices
 * and a stray Enter cannot pick one. Each choice is one Tab away, with what
 * it costs said under it. Withdraw, when there is no road back, stays in the
 * ring but is aria-disabled with the reason, and says it again when pressed.
 *
 * Esc does nothing here: there is no "later" -- the realm cannot go on until
 * the meeting is settled, and leaving the map is one Esc further only after
 * it is (docs/PROVISIONAL.md K5.14).
 *
 * K8 adds the defender's two choices at its own walls (KD-05) when the
 * king's side is the townsmen alone: open the gates, or retreat to the keep
 * (refused, with the reason, where there is no keep or stone wall).
 *
 * K10: behind walls it is a siege, and the dialog says how it is won and
 * how battered the walls already are. Townsmen who fell back to the keep
 * face the siege of the keep: Fight, Withdraw (refused: townsmen do not
 * leave their walls) and Resolve -- the keep is not offered twice.
 *
 * Text comes from content/kingdom/descent-strings.ts and invasion-strings.ts.
 */

import { domScreen } from "../dom-screen.ts";
import type { KeyVerdict, Screen } from "../screen-stack.ts";
import type { KingdomWorld } from "../../sim/kingdom/world.ts";
import type { Contact } from "../../sim/kingdom/state.ts";
import type { ContactChoice } from "../../sim/kingdom/orders.ts";
import { armyById, armyMen, armyWounded } from "../../sim/kingdom/armies.ts";
import { buildBattleSpec, withdrawalCost } from "../../sim/kingdom/descent.ts";
import { CONTACT } from "../../content/kingdom/descent-strings.ts";
import { WITHDRAW_MORALE } from "../../content/kingdom/descent.ts";
import { FACTIONS, FACTION_IDS } from "../../content/kingdom/factions.ts";
import { DEFEND, RUMOUR } from "../../content/kingdom/invasion-strings.ts";
import { YIELD_LEGITIMACY } from "../../content/kingdom/invasions.ts";

export type ContactDialogHooks = {
  /** The player chose. The dialog has already asked to be popped. */
  choose(choice: ContactChoice): void;
  /** Pop this dialog. */
  close(screen: Screen): void;
  /** The dialog left the stack, however that happened. */
  closed(): void;
};

function make(doc: Document, tag: string, cls?: string, text?: string): HTMLElement {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** "the Hare's Raiders" for another side's army; the townsmen for walls. */
function theirName(world: KingdomWorld, c: Contact): string {
  const s = c.sides[1];
  const spec = buildBattleSpec(world, c);
  const a = armyById(world, s.army);
  if (!a) return spec.sides[1].name;
  const f = FACTIONS[FACTION_IDS[s.faction]];
  return f ? f.name : spec.sides[1].name;
}

/** The place a contact is named for: the holding it was met at, or nearest to on the road. */
function placeName(world: KingdomWorld, c: Contact): string {
  const h = world.holding(c.holding);
  return h ? h.name : "?";
}

export function contactDialog(root: HTMLElement, doc: Document, world: KingdomWorld, hooks: ContactDialogHooks): Screen {
  let first: HTMLElement | null = null;
  let status: HTMLElement | null = null;
  const close = (): void => hooks.close(screen);
  const screen: Screen = domScreen({
    name: "kingdom-contact",
    kind: "overlay",
    root,
    display: "flex",
    trapsFocus: true,
    pausesSim: true,
    inputs: ["ui"],
    firstFocus: () => first,
    build: () => {
      root.textContent = "";
      const c = world.contact;
      if (!c) return;
      const spec = buildBattleSpec(world, c);
      const place = placeName(world, c);
      const ours = spec.sides[0];
      const panel = make(doc, "div", "k-menu k-event k-contact");
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
      panel.setAttribute("data-contact", String(c.id));
      const title = make(doc, "h2", "k-menu-title",
        c.keep ? CONTACT.titleKeep(place) : c.kind === "assault" ? CONTACT.titleAssault(place) : CONTACT.titleField(place));
      title.id = "k-contact-title";
      title.tabIndex = -1;
      panel.setAttribute("aria-labelledby", title.id);
      const words = { ours: ours.name, theirs: theirName(world, c), place };
      const body = make(doc, "p", "k-event-text",
        c.keep ? CONTACT.bodyKeep(words) : c.kind === "field" ? CONTACT.bodyField(words) : ours.army === 0 ? CONTACT.bodyDefend(words) : CONTACT.bodyAssault(words));
      body.id = "k-contact-text";
      panel.setAttribute("aria-describedby", body.id);
      panel.append(title, body);
      // K10: a siege, and how it is won.
      if (spec.victory.mode === "breakthrough") {
        const p = { men: spec.victory.required, minutes: Math.round(spec.duration / 60) };
        const how = make(doc, "p", "k-event-text k-contact-siege",
          spec.deployment.attacker === 0 ? CONTACT.siegeAttack(p) : CONTACT.siegeDefend(p));
        how.setAttribute("data-key", "contact-siege");
        panel.appendChild(how);
      }

      // The two sides, in words: men, fit men, morale, and what the defender has on its side.
      const sides = make(doc, "dl", "k-contact-sides");
      const side = (label: string, i: number): void => {
        const s = spec.sides[i];
        let men = 0;
        let wounded = 0;
        for (const q of s.squads) { men += q.men; wounded += q.wounded; }
        const a = armyById(world, s.army);
        if (a) { men = armyMen(a); wounded = armyWounded(a); }
        const bits = [CONTACT.men(men, men - wounded), CONTACT.morale(s.morale)];
        if (i !== spec.deployment.attacker) {
          if (spec.deployment.ambush) bits.push(CONTACT.dugIn);
          const wall = CONTACT.walls[spec.terrain.fortification];
          if (wall) bits.push(wall);
          if (wall && spec.terrain.worn > 0) bits.push(CONTACT.battered(Math.round(spec.terrain.worn / 10)));
        }
        sides.append(make(doc, "dt", undefined, label + ": " + s.name), make(doc, "dd", undefined, bits.join(", ")));
      };
      side(CONTACT.ourSide, 0);
      side(CONTACT.theirSide, 1);
      panel.appendChild(sides);

      const list = make(doc, "ul", "k-choices");
      list.setAttribute("aria-labelledby", title.id);
      const cost = withdrawalCost(world);
      const noWithdraw = world.check({ kind: "resolveContact", contact: c.id, choice: "withdraw", result: null });
      const add = (choice: ContactChoice, label: string, hint: string, why: string | null): void => {
        const li = make(doc, "li", "k-choice" + (why ? " unavailable" : ""));
        const b = make(doc, "button", "k-btn k-choice-btn", label);
        b.setAttribute("type", "button");
        b.setAttribute("data-key", "contact-" + choice);
        const detailId = "k-contact-" + choice;
        b.setAttribute("aria-describedby", detailId);
        if (why) b.setAttribute("aria-disabled", "true");
        const detail = make(doc, "div", "k-choice-detail");
        detail.id = detailId;
        detail.appendChild(make(doc, "span", why ? "k-why" : undefined, why ?? hint));
        b.onclick = () => {
          if (why) {
            if (status) status.textContent = why;
            return;
          }
          close();
          hooks.choose(choice);
        };
        li.append(b, detail);
        list.appendChild(li);
      };
      // Fight needs a battle to bring back a result; only the withdrawal can be refused here.
      add("fight", CONTACT.fight, CONTACT.fightHint, null);
      add("withdraw", CONTACT.withdraw, cost > 0 ? CONTACT.withdrawHint(cost, WITHDRAW_MORALE) : "",
        noWithdraw ? CONTACT.withdrawNo(noWithdraw) : null);
      add("auto", CONTACT.auto, CONTACT.autoHint, null);
      // K8 (KD-05): townsmen alone behind their own walls may also open the gates, or fall back to the keep.
      if (c.kind === "assault" && c.sides[0].army === 0 && !c.keep) {
        const noYield = world.check({ kind: "resolveContact", contact: c.id, choice: "yield", result: null });
        add("yield", DEFEND.yield, DEFEND.yieldHint(YIELD_LEGITIMACY), noYield ? RUMOUR.no(noYield) : null);
        const noKeep = world.check({ kind: "resolveContact", contact: c.id, choice: "keep", result: null });
        add("keep", DEFEND.keep, DEFEND.keepHint, noKeep ? RUMOUR.no(noKeep) : null);
      }
      panel.appendChild(list);
      status = make(doc, "p", "k-menu-status");
      status.setAttribute("role", "status");
      panel.appendChild(status);
      root.appendChild(panel);
      first = title;
    },
    teardown: () => hooks.closed(),
    // No "later": the realm cannot go on until this is settled.
    onKey: (k): KeyVerdict => (k.code === "Escape" ? "handled" : "pass"),
  });
  return screen;
}
