/**
 * A 32-bit fingerprint of the whole kingdom state.
 *
 * The kingdom's regression anchor and desync detector, as hashWorld is the
 * battle's. Same FNV-1a mixing (sim/hash.ts), same rule: everything that can
 * change what happens next is hashed, floats by their exact bits. That
 * includes orders queued but not yet due and the per-player sequence counters,
 * because a save resumed without them would diverge later -- and it hashes
 * them in canonical order, never arrival order, so two peers that received
 * the same orders differently still agree.
 *
 * The static graph (positions, road lengths) is hashed too. It is content, not
 * state, but a content edit that moves a town legitimately changes every march
 * after it, and the kingdom golden should say so.
 *
 * Not hashed: the order log (history, not state) and the tick's events
 * (derived from state).
 */

import { FNV_OFFSET, mixF64, mixU32 } from "../hash.ts";
import { FACTION_IDS, type FactionId } from "../../content/kingdom/factions.ts";
import { ROAD_TERRAIN_IDS, WEATHER_IDS } from "../../content/kingdom/terrain.ts";
import { BUILDING_IDS } from "../../content/kingdom/buildings.ts";
import { CROP_IDS, type CropId } from "../../content/kingdom/crops.ts";
import { JUSTICE_IDS } from "../../content/kingdom/morale.ts";
import { STOCK_IDS, TAX_RATE_IDS } from "../../content/kingdom/economy.ts";
import { CONTACT_CHOICES, KINGDOM_ORDER_KINDS, type KingdomOrder } from "./orders.ts";
import { mixBattleResult } from "../layers.ts";
import { KING_TASKS, PLOT_CAUSES, PLOT_STAGES, type Mover } from "./state.ts";
import type { LedgerDay } from "./ledger.ts";
import { UPGRADE_IDS } from "../../content/story/upgrades.ts";
import { UNIT_TYPE_IDS } from "../../content/unit-types.ts";
import { DOCTRINE_IDS } from "../../content/doctrines.ts";
import { ABILITY_IDS } from "../../content/abilities.ts";
import { AI_GOALS, ARMY_POSTURES, CONTACT_KINDS, type Army } from "./state.ts";
import { COMPANY_STATES } from "../../content/kingdom/mercenaries.ts";
import { KINGDOM_STREAMS, type KingdomWorld } from "./world.ts";

function mixStr(h: number, s: string | null): number {
  if (s === null) return mixU32(h, 0xffffffff);
  h = mixU32(h, s.length);
  for (let i = 0; i < s.length; i++) h = mixU32(h, s.charCodeAt(i));
  return h;
}

function mixOwner(h: number, owner: FactionId | null): number {
  return mixU32(h, owner === null ? 0xff : FACTION_IDS.indexOf(owner));
}

function mixMover(h: number, m: Mover): number {
  h = mixU32(h, m.node);
  h = mixU32(h, m.road);
  h = mixU32(h, m.from);
  h = mixU32(h, m.to);
  h = mixF64(h, m.along);
  h = mixU32(h, m.route.length);
  for (const n of m.route) h = mixU32(h, n);
  return h;
}

/** Hash one stamped order, every field. Shared with the layer tools. */
export function mixOrder(h: number, o: KingdomOrder): number {
  h = mixU32(h, KINGDOM_ORDER_KINDS.indexOf(o.kind));
  h = mixU32(h, o.tick);
  h = mixU32(h, o.player);
  h = mixU32(h, o.seq);
  switch (o.kind) {
    case "moveKing": return mixU32(h, o.to);
    case "haltKing": return h;
    case "forage": return h;
    case "rally": return h;
    case "claimHolding": return mixU32(h, o.holding);
    case "setTax": return mixU32(mixU32(h, o.holding), TAX_RATE_IDS.indexOf(o.rate));
    case "build": return mixU32(mixU32(h, o.holding), BUILDING_IDS.indexOf(o.building));
    case "sow": return mixU32(mixU32(h, o.plot), CROP_IDS.indexOf(o.crop));
    case "harvest": return mixU32(h, o.plot);
    case "resolveEvent": return mixU32(mixU32(h, o.site), o.choice);
    case "recruit":
      return mixU32(mixU32(mixU32(mixU32(h, o.at), o.army), UNIT_TYPE_IDS.indexOf(o.unit)), o.levy ? 1 : 0);
    case "disband": return mixU32(h, o.army);
    case "marchArmy": return mixU32(mixU32(h, o.army), o.to);
    case "haltArmy": return mixU32(h, o.army);
    case "merge": return mixU32(mixU32(h, o.army), o.into);
    case "split": {
      h = mixU32(mixU32(h, o.army), o.squads.length);
      for (const s of o.squads) h = mixU32(h, s);
      return h;
    }
    case "garrison": return mixU32(h, o.army);
    case "patrol": {
      h = mixU32(mixU32(h, o.army), o.holdings.length);
      for (const x of o.holdings) h = mixU32(h, x);
      return h;
    }
    case "recover": return mixU32(h, o.army);
    case "setDoctrine": return mixU32(mixU32(h, o.army), DOCTRINE_IDS.indexOf(o.doctrine));
    case "unlockAbility": return mixU32(mixU32(h, o.army), ABILITY_IDS.indexOf(o.ability));
    case "intercept": return mixU32(mixU32(h, o.army), o.target);
    case "kingJoin": return mixU32(h, o.army);
    case "resolveContact": {
      h = mixU32(mixU32(h, o.contact), CONTACT_CHOICES.indexOf(o.choice));
      h = mixU32(h, o.result ? 1 : 0);
      return o.result ? mixBattleResult(h, o.result) : h;
    }
    case "setJustice": return mixU32(mixU32(h, o.holding), JUSTICE_IDS.indexOf(o.justice));
    case "holdFestival": return mixU32(h, o.holding);
    case "pardon": return mixU32(h, o.holding);
    case "hireCompany": return mixU32(mixU32(h, o.company), o.at);
    case "renewContract": return mixU32(h, o.company);
    case "matchBid": return mixU32(h, o.company);
    case "callLevy": return mixU32(h, o.holding);
    case "burnFields": return mixU32(h, o.holding);
    case "ambush": return mixU32(h, o.army);
    case "setAutoSow": return mixU32(mixU32(mixU32(h, o.holding), o.plot), o.crop === null ? 0 : CROP_IDS.indexOf(o.crop) + 1);
  }
}

function mixArmy(h: number, a: Army): number {
  h = mixU32(h, a.id);
  h = mixU32(h, a.owner);
  h = mixU32(h, a.company); // K7
  h = mixStr(h, a.name);
  h = mixU32(h, DOCTRINE_IDS.indexOf(a.doctrine));
  h = mixU32(h, a.squads.length);
  for (const s of a.squads) {
    h = mixU32(h, s.id);
    h = mixU32(h, UNIT_TYPE_IDS.indexOf(s.unit));
    h = mixU32(h, s.men);
    h = mixU32(h, s.wounded);
    h = mixU32(h, s.levy ? 1 : 0);
  }
  h = mixU32(h, a.abilities.length);
  for (const x of a.abilities) h = mixU32(h, ABILITY_IDS.indexOf(x));
  h = mixMover(h, a.mover);
  h = mixU32(h, a.supply);
  h = mixU32(h, a.morale);
  h = mixStr(h, a.captain);
  h = mixU32(h, a.hunger);
  h = mixU32(h, a.unpaid);
  h = mixU32(h, a.arrears);
  h = mixU32(h, ARMY_POSTURES.indexOf(a.posture));
  h = mixU32(h, a.postureDays);
  h = mixU32(h, a.patrol.length);
  for (const x of a.patrol) h = mixU32(h, x);
  h = mixU32(h, a.patrolIndex);
  h = mixU32(h, a.target);
  h = mixU32(h, a.mergeInto ? 1 : 0);
  h = mixU32(h, a.desertCarry);
  h = mixU32(h, a.dieCarry);
  h = mixU32(h, a.sickCarry);
  return h;
}

function mixLedgerDay(h: number, d: LedgerDay | null): number {
  if (d === null) return mixU32(h, 0xffffffff);
  h = mixU32(h, d.day);
  h = mixU32(h, d.start.length);
  for (const v of d.start) h = mixF64(h, v);
  h = mixU32(h, d.flow.length);
  for (const v of d.flow) h = mixF64(h, v);
  return h;
}

export function kingdomHash(world: KingdomWorld): string {
  let h = FNV_OFFSET | 0;
  h = mixU32(h, world.now);
  h = mixU32(h, world.seed);
  h = mixU32(h, world.nextId);
  h = mixStr(h, world.map.id);
  h = mixU32(h, WEATHER_IDS.indexOf(world.weather));
  // ECON: the realm's calendar start and whether its fields resow themselves.
  h = mixU32(h, world.epoch);
  h = mixU32(h, world.autoFarm ? 1 : 0);

  h = mixU32(h, world.holdings.length);
  for (const x of world.holdings) {
    h = mixU32(h, x.id);
    h = mixStr(h, x.key);
    h = mixF64(h, x.x);
    h = mixF64(h, x.y);
    h = mixU32(h, x.seed);
    h = mixOwner(h, x.owner);
    h = mixF64(h, x.population);
    h = mixU32(h, x.garrisonSlots);
    h = mixU32(h, x.garrison.length);
    for (const g of x.garrison) h = mixU32(h, g);
    h = mixU32(h, x.buildings.length);
    for (const b of x.buildings) h = mixStr(h, b);
    for (const w of x.works) h = mixU32(h, w);
    for (const i of x.idle) h = mixU32(h, i ? 1 : 0);
    h = mixU32(h, x.plots.length);
    for (const p of x.plots) {
      h = mixU32(h, p.id);
      h = mixStr(h, p.crop);
      h = mixU32(h, PLOT_STAGES.indexOf(p.stage));
      h = mixF64(h, p.progress);
      h = mixU32(h, p.days);
      h = mixU32(h, p.health);
      // ECON: what it resows by itself, and why it was last lost.
      h = mixU32(h, p.auto === null ? 0 : CROP_IDS.indexOf(p.auto as CropId) + 1);
      h = mixU32(h, p.lost === null ? 0 : PLOT_CAUSES.indexOf(p.lost) + 1);
    }
    h = mixU32(h, TAX_RATE_IDS.indexOf(x.tax));
    h = mixU32(h, x.taxCarry);
    h = mixU32(h, x.doleCarry);
    h = mixU32(h, x.famine);
    h = mixU32(h, x.foraged);
    // K6: unrest and the levers pulled here.
    h = mixU32(h, x.unrest);
    h = mixU32(h, JUSTICE_IDS.indexOf(x.justice));
    h = mixU32(h, x.festival);
    h = mixU32(h, x.pardoned);
  }

  h = mixU32(h, world.roads.length);
  for (const r of world.roads) {
    h = mixU32(h, r.id);
    h = mixU32(h, r.a);
    h = mixU32(h, r.b);
    h = mixU32(h, ROAD_TERRAIN_IDS.indexOf(r.terrain));
    h = mixF64(h, r.length);
    h = mixF64(h, r.cost);
  }

  const k = world.king;
  h = mixU32(h, k.id);
  h = mixStr(h, k.name);
  h = mixU32(h, k.companions.length);
  for (const c of k.companions) h = mixStr(h, c);
  h = mixMover(h, k.mover);
  h = mixU32(h, KING_TASKS.indexOf(k.task));
  h = mixU32(h, k.taskDays);
  h = mixU32(h, k.army);

  // K4: every army, in id order.
  h = mixU32(h, world.armies.length);
  for (const a of world.armies) h = mixArmy(h, a);

  // K7: every free company's place in its life with the king, in table order.
  h = mixU32(h, world.companies.length);
  for (const c of world.companies) {
    h = mixU32(h, COMPANY_STATES.indexOf(c.state));
    h = mixU32(h, c.at);
    h = mixU32(h, c.days);
    h = mixU32(h, c.loyalty);
    h = mixU32(h, c.army);
    h = mixU32(h, c.bid);
    h = mixU32(h, c.bidDays);
  }

  // K5: a contact waiting, and the pairs not yet parted. Mixed only when
  // there is something to mix, so a world that has never had a meeting (every
  // K1-K4 world, and the kingdom golden's) hashes exactly as it did before K5.
  if (world.contact || world.disengaged.length > 0) {
    const c = world.contact;
    h = mixU32(h, 0x4b35);
    h = mixU32(h, c ? c.id : 0);
    if (c) {
      h = mixU32(h, CONTACT_KINDS.indexOf(c.kind));
      for (const s of c.sides) { h = mixU32(h, s.faction); h = mixU32(h, s.army); }
      h = mixU32(h, c.attacker);
      h = mixU32(h, c.holding);
      h = mixU32(h, c.road);
      h = mixU32(h, c.tick);
    }
    h = mixU32(h, world.disengaged.length);
    for (const [a, b] of world.disengaged) { h = mixU32(h, a); h = mixU32(h, b); }
  }

  // K8: the captains' minds and memories, the waves, rumours, burned land and
  // levy calls. Mixed only in a realm with captains or once a defence tool has
  // been used, so a K7 realm hashes as it did (but for K8's commons faction,
  // which every realm now has: docs/kingdom.md, K8).
  if (world.captains || world.rumours.length > 0 || world.burned.length > 0 || world.levied.length > 0) {
    h = mixU32(h, 0x4b38);
    h = mixU32(h, world.captains ? 1 : 0);
    h = mixU32(h, world.minds.length);
    for (const m of world.minds) {
      h = mixU32(h, AI_GOALS.indexOf(m.goal));
      h = mixU32(h, m.target);
      h = mixU32(h, m.since);
      h = mixU32(h, m.wave + 1);
      h = mixU32(h, m.rides);
    }
    h = mixU32(h, world.intel.length);
    for (const x of world.intel) {
      h = mixU32(h, x.owner.length);
      for (let i = 0; i < x.owner.length; i++) {
        h = mixU32(h, x.owner[i] + 1);
        h = mixU32(h, x.men[i]);
        h = mixU32(h, x.walls[i]);
        h = mixU32(h, x.seen[i] + 1);
      }
    }
    h = mixU32(h, world.wavesRode.length);
    for (const w of world.wavesRode) h = mixU32(h, w ? 1 : 0);
    h = mixU32(h, world.rumours.length);
    for (const r of world.rumours) { h = mixU32(h, r.army); h = mixU32(h, r.target); h = mixU32(h, r.from); h = mixU32(h, r.days); h = mixU32(h, r.day); }
    h = mixU32(h, world.burned.length);
    for (const b of world.burned) { h = mixU32(h, b.holding); h = mixU32(h, b.days); }
    h = mixU32(h, world.levied.length);
    for (const l of world.levied) { h = mixU32(h, l.holding); h = mixU32(h, l.day); }
  }

  // K3: every faction's stores, soft stats and ledger pages.
  h = mixU32(h, world.economy.length);
  world.economy.forEach((e, f) => {
    for (const s of STOCK_IDS) h = mixF64(h, e.stocks[s]);
    h = mixF64(h, e.legitimacy);
    h = mixU32(h, e.hunger);
    h = mixU32(h, TAX_RATE_IDS.indexOf(e.defaultTax));
    h = mixU32(h, e.mercy + 0x8000); // K6: Mercy/Terror, offset so it is never negative
    h = mixU32(h, e.autoSow === null ? 0 : CROP_IDS.indexOf(e.autoSow as CropId) + 1); // ECON
    h = mixLedgerDay(h, world.books[f].open);
    h = mixLedgerDay(h, world.books[f].closed);
  });

  // K3a: every faction's map knowledge, finds and special upgrades.
  h = mixU32(h, world.explore.length);
  for (const ex of world.explore) {
    h = mixU32(h, ex.holdings.length);
    for (const k of ex.holdings) h = mixU32(h, k);
    h = mixU32(h, ex.roads.length);
    for (const k of ex.roads) h = mixU32(h, k);
    h = mixU32(h, ex.finds.length);
    for (const f of ex.finds) {
      h = mixU32(h, f.site);
      h = mixU32(h, f.event);
      h = mixU32(h, f.day);
      h = mixU32(h, f.choice);
      h = mixU32(h, f.failed ? 1 : 0);
    }
    h = mixU32(h, ex.upgrades.length);
    for (const u of ex.upgrades) h = mixU32(h, UPGRADE_IDS.indexOf(u));
  }

  const queued = world.orders.queued();
  h = mixU32(h, queued.length);
  for (const o of queued) h = mixOrder(h, o);
  const seqs = world.orders.sequences();
  h = mixU32(h, seqs.length);
  for (const s of seqs) h = mixU32(h, s);

  for (const name of KINGDOM_STREAMS) {
    const st = world.rng[name].snapshot();
    h = mixU32(h, st.a);
    h = mixU32(h, st.b);
    h = mixU32(h, st.c);
    h = mixU32(h, st.d);
  }

  return (h >>> 0).toString(16).padStart(8, "0");
}
