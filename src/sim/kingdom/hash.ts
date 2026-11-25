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
import { KINGDOM_ORDER_KINDS, type KingdomOrder } from "./orders.ts";
import { PLOT_STAGES, type Mover } from "./state.ts";
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
  }
}

export function kingdomHash(world: KingdomWorld): string {
  let h = FNV_OFFSET | 0;
  h = mixU32(h, world.now);
  h = mixU32(h, world.seed);
  h = mixU32(h, world.nextId);
  h = mixStr(h, world.map.id);
  h = mixU32(h, WEATHER_IDS.indexOf(world.weather));

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
    h = mixU32(h, x.plots.length);
    for (const p of x.plots) {
      h = mixU32(h, p.id);
      h = mixStr(h, p.crop);
      h = mixU32(h, PLOT_STAGES.indexOf(p.stage));
      h = mixF64(h, p.progress);
    }
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
