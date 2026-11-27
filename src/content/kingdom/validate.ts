/**
 * Validation for a kingdom map.
 *
 * Lives with the content, as army validation does (content/army.ts), so the
 * authored campaign, a future procedural skirmish graph and a hand-edited map
 * are all held to the same rules before the sim is ever handed one. A map that
 * fails here must never reach KingdomWorld: the router and the save format
 * both assume the graph is well formed.
 */

import { LEVELS } from "../levels/index.ts";
import { FACTIONS, type FactionId } from "./factions.ts";
import { BIOMES, HOLDING_KINDS, ROAD_TERRAIN } from "./terrain.ts";
import { SITE_KINDS, holdingSeed, type KingdomMapDef } from "./map.ts";

/** Target size of the campaign map (docs/PROVISIONAL.md B.12.2): twice the first 36 (K3a). */
export const CAMPAIGN_HOLDINGS = 72;

/**
 * Readability (K3a, twice the map): holdings at least this far apart, so two
 * names and two glyphs never sit on each other at the opening zoom, and no
 * road may pass closer than ROAD_CLEARANCE_MILES to a holding it does not
 * join, or a march would seem to go through a town it does not visit.
 */
export const MIN_HOLDING_SPACING_MILES = 40;
export const ROAD_CLEARANCE_MILES = 18;

/**
 * Every problem with the map, in a stable order. Empty means valid.
 *
 * Returns all of them rather than the first, so a broken edit shows its whole
 * extent at once.
 */
export function validateKingdomMap(map: KingdomMapDef): string[] {
  const problems: string[] = [];
  const keys = new Map<string, number>();
  const provinces = new Set<string>();
  const levelIds = new Set(LEVELS.map((l) => l.id));

  for (const p of map.provinces) {
    if (provinces.has(p.id)) problems.push("province " + p.id + " is listed twice");
    provinces.add(p.id);
    if (!BIOMES[p.biome]) problems.push("province " + p.id + " has unknown biome " + p.biome);
    for (const g of p.governors) {
      if (!FACTIONS[g]) problems.push("province " + p.id + " has unknown governor " + g);
      if (g === "king") problems.push("province " + p.id + " is governed by the king at the start");
    }
  }

  map.holdings.forEach((h, i) => {
    if (keys.has(h.key)) problems.push("holding key " + h.key + " is used twice");
    keys.set(h.key, i);
    if (!provinces.has(h.province)) problems.push(h.key + ": unknown province " + h.province);
    if (!HOLDING_KINDS[h.kind]) problems.push(h.key + ": unknown kind " + h.kind);
    if (h.biome !== undefined && !BIOMES[h.biome]) problems.push(h.key + ": unknown biome " + h.biome);
    if (!(h.x >= 0 && h.x <= map.width && h.y >= 0 && h.y <= map.height)) {
      problems.push(h.key + ": position (" + h.x + ", " + h.y + ") is off the map");
    }
    if (h.population !== undefined && !(h.population >= 0 && Number.isInteger(h.population))) {
      problems.push(h.key + ": population must be a whole number >= 0");
    }
    if (h.owner !== null && !FACTIONS[h.owner]) problems.push(h.key + ": unknown owner " + h.owner);
    if (h.owner === "king") problems.push(h.key + ": the king owns nothing at the start (PLAN.md §A.5)");
  });

  for (const b of Object.values(BIOMES)) {
    if (!levelIds.has(b.level)) problems.push("biome " + b.id + " fights like unknown level " + b.level);
  }

  // Two holdings on one spot would make a zero-length road and an ambiguous
  // map click; keep them far enough apart that their names read (K3a).
  const spacing = MIN_HOLDING_SPACING_MILES;
  for (let i = 0; i < map.holdings.length; i++) {
    for (let j = i + 1; j < map.holdings.length; j++) {
      const a = map.holdings[i];
      const b = map.holdings[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      if (dx * dx + dy * dy < spacing * spacing) problems.push(a.key + " and " + b.key + " are closer than " + spacing + " miles");
    }
  }

  // K3a: exploration sites and what the king knows on day one.
  map.holdings.forEach((h) => {
    if (h.site === undefined) return;
    if (!(SITE_KINDS as readonly string[]).includes(h.site)) problems.push(h.key + ": unknown site kind " + h.site);
    // A site is found by going there; one already held would be found by its holder.
    if (h.owner !== null) problems.push(h.key + ": an exploration site is nobody's at the start");
    if (h.key === map.start) problems.push(h.key + ": the king cannot start on a site he has not found");
  });
  const known = new Set<string>();
  for (const k of map.startKnown) {
    if (!keys.has(k)) problems.push("startKnown names unknown holding " + k);
    if (known.has(k)) problems.push("startKnown lists " + k + " twice");
    known.add(k);
    if (map.holdings[keys.get(k) ?? -1]?.site !== undefined) problems.push("startKnown names " + k + ", a site still to be found");
  }
  if (!known.has(map.start)) problems.push("the king does not know the holding he starts in");

  const pairs = new Set<string>();
  const adjacency = map.holdings.map(() => [] as number[]);
  for (const [a, b, terrain] of map.roads) {
    const ia = keys.get(a);
    const ib = keys.get(b);
    if (ia === undefined) problems.push("road " + a + "-" + b + ": unknown end " + a);
    if (ib === undefined) problems.push("road " + a + "-" + b + ": unknown end " + b);
    if (!ROAD_TERRAIN[terrain]) problems.push("road " + a + "-" + b + ": unknown surface " + terrain);
    if (a === b) problems.push("road " + a + "-" + b + " goes nowhere");
    const pair = a < b ? a + "|" + b : b + "|" + a;
    if (pairs.has(pair)) problems.push("road " + a + "-" + b + " is listed twice");
    pairs.add(pair);
    if (ia !== undefined && ib !== undefined && ia !== ib) {
      adjacency[ia].push(ib);
      adjacency[ib].push(ia);
    }
  }

  // Readability: roads do not cross (the map is a planar drawing, as the
  // hand-drawn one was), and none grazes a holding it does not join.
  const ends = map.roads.map(([a, b]) => [map.holdings[keys.get(a) ?? -1], map.holdings[keys.get(b) ?? -1]] as const);
  for (let i = 0; i < ends.length; i++) {
    const [p, q] = ends[i];
    if (!p || !q) continue;
    for (let j = i + 1; j < ends.length; j++) {
      const [r, t] = ends[j];
      if (!r || !t || r === p || r === q || t === p || t === q) continue;
      if (segmentsCross(p, q, r, t)) problems.push("road " + p.key + "-" + q.key + " crosses road " + r.key + "-" + t.key);
    }
    for (const h of map.holdings) {
      if (h === p || h === q) continue;
      if (segmentDistance(p, q, h) < ROAD_CLEARANCE_MILES) problems.push("road " + p.key + "-" + q.key + " passes too close to " + h.key);
    }
  }

  // Every holding must be reachable from the king's start: an island is a
  // place the story can never send him, and a router that silently returns no
  // route is a bug report waiting to happen.
  const start = keys.get(map.start);
  if (start === undefined) problems.push("start " + map.start + " is not a holding");
  else {
    const seen = new Set<number>([start]);
    const frontier = [start];
    while (frontier.length > 0) {
      const n = frontier.pop() as number;
      for (const m of adjacency[n]) if (!seen.has(m)) { seen.add(m); frontier.push(m); }
    }
    for (const [key, i] of keys) if (!seen.has(i)) problems.push(key + " cannot be reached by road from " + map.start);

    const s = map.holdings[start];
    if (s.owner !== null) problems.push("the king starts at " + map.start + ", which is already held");
  }

  const crown = keys.get(map.crownSeat);
  if (crown === undefined) problems.push("crown seat " + map.crownSeat + " is not a holding");
  else if (map.holdings[crown].owner !== "usurper") problems.push("the usurper does not hold the crown seat");

  // A governor without a seat in their province has nowhere to rule from.
  for (const p of map.provinces) {
    const mine = map.holdings.filter((h) => h.province === p.id);
    if (mine.length < 2) problems.push("province " + p.id + " has fewer than two holdings");
    for (const g of p.governors) {
      if (!mine.some((h) => h.seat === true && h.owner === g)) {
        problems.push("governor " + g + " has no seat in " + p.id);
      }
    }
    for (const h of mine) {
      if (h.owner !== null && !p.governors.includes(h.owner as FactionId)) {
        problems.push(h.key + " is held by " + h.owner + ", who does not govern " + p.id);
      }
    }
  }

  // Distinct battlefields: two holdings sharing a seed would share a field.
  const seeds = new Map<number, string>();
  for (const h of map.holdings) {
    const province = map.provinces.find((p) => p.id === h.province);
    const biome = BIOMES[h.biome ?? province?.biome ?? "reach"];
    const level = LEVELS.find((l) => l.id === biome?.level);
    if (!level) continue;
    const seed = holdingSeed(h, level.seed);
    const other = seeds.get(seed);
    if (other !== undefined) problems.push(h.key + " and " + other + " share a battlefield seed");
    seeds.set(seed, h.key);
  }

  return problems;
}

type XY = { readonly x: number; readonly y: number };

/** Do two segments cross at a point inside both (touching at an end does not count)? */
function segmentsCross(p: XY, q: XY, r: XY, s: XY): boolean {
  const d = (q.x - p.x) * (s.y - r.y) - (q.y - p.y) * (s.x - r.x);
  if (d === 0) return false;
  const t = ((r.x - p.x) * (s.y - r.y) - (r.y - p.y) * (s.x - r.x)) / d;
  const u = ((r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x)) / d;
  return t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999;
}

/** Miles from a point to a segment. */
function segmentDistance(a: XY, b: XY, p: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = a.x + t * dx - p.x;
  const ey = a.y + t * dy - p.y;
  return Math.sqrt(ex * ex + ey * ey);
}
