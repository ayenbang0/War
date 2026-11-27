/**
 * Validation of the story tables (K3a): exploration events and special
 * upgrades, against the map they are found on.
 *
 * Lives with the content, like content/kingdom/validate.ts, so an edit that
 * breaks a table fails `npm test` before the sim is ever handed it.
 */

import { STOCK_IDS } from "../kingdom/economy.ts";
import { BUILDING_IDS } from "../kingdom/buildings.ts";
import { CROP_IDS } from "../kingdom/crops.ts";
import { ROAD_TERRAIN_IDS } from "../kingdom/terrain.ts";
import { SITE_KINDS, type KingdomMapDef } from "../kingdom/map.ts";
import { STORY_EVENTS, type EventEffect, type StoryEventDef } from "./events.ts";
import { UPGRADES, UPGRADE_IDS, type UpgradeDef } from "./upgrades.ts";

/** At least this many of each (the K3a brief). */
export const MIN_EVENTS = 24;
export const MIN_UPGRADES = 12;

function wholeCost(c: Readonly<Partial<Record<string, number>>>): boolean {
  const keys = Object.keys(c);
  return keys.length > 0 && keys.every((k) => (STOCK_IDS as readonly string[]).includes(k)) &&
    Object.values(c).every((v) => Number.isInteger(v) && (v as number) > 0);
}

export function effectProblems(where: string, e: EventEffect): string[] {
  switch (e.kind) {
    case "gain": return wholeCost(e.gains) ? [] : [where + ": a gain must be whole stocks > 0"];
    case "pay": return wholeCost(e.cost) ? [] : [where + ": a price must be whole stocks > 0"];
    case "lose": return wholeCost(e.loss) ? [] : [where + ": a loss must be whole stocks > 0"];
    case "legitimacy": return Number.isInteger(e.delta) && e.delta !== 0 && e.delta >= -10 && e.delta <= 10 ? [] : [where + ": legitimacy moves by a whole 1..10 either way"];
    case "upgrade": return UPGRADES[e.upgrade] ? [] : [where + ": unknown upgrade " + e.upgrade];
    case "reveal": return Number.isInteger(e.miles) && e.miles > 0 && e.miles <= 400 ? [] : [where + ": a reveal reaches 1..400 miles"];
  }
}

/** Every problem with the events table. Empty means valid. */
export function validateEvents(events: readonly StoryEventDef[] = STORY_EVENTS): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  if (events.length < MIN_EVENTS) problems.push("only " + events.length + " events; at least " + MIN_EVENTS);
  for (const ev of events) {
    if (ids.has(ev.id)) problems.push("event " + ev.id + " is listed twice");
    ids.add(ev.id);
    if (ev.site !== "any" && !(SITE_KINDS as readonly string[]).includes(ev.site)) problems.push(ev.id + ": unknown site kind " + ev.site);
    if (!ev.title || !ev.text) problems.push(ev.id + ": needs a title and a letter");
    if (ev.choices.length < 2 || ev.choices.length > 3) problems.push(ev.id + ": needs two or three choices");
    // A card must never trap a player with an empty store.
    if (!ev.choices.some((c) => !c.effects.some((e) => e.kind === "pay"))) problems.push(ev.id + ": every choice has a price; one must be free");
    ev.choices.forEach((c, i) => {
      const where = ev.id + " choice " + (i + 1);
      if (!c.label || !c.result) problems.push(where + ": needs a label and a result");
      for (const e of c.effects) problems.push(...effectProblems(where, e));
      if (c.effects.some((e) => e.kind === "lose")) problems.push(where + ": a loss belongs to a gamble's failure, not a choice");
      if (c.chance) {
        if (!(Number.isInteger(c.chance.pct) && c.chance.pct > 0 && c.chance.pct < 100)) problems.push(where + ": a gamble's odds are 1..99 %");
        if (!c.chance.fail.result) problems.push(where + ": a gamble needs a result for failure");
        for (const e of c.chance.fail.effects) {
          problems.push(...effectProblems(where + " (failure)", e));
          if (e.kind === "pay" || e.kind === "upgrade") problems.push(where + ": a failure pays nothing more and grants no upgrade");
        }
      }
    });
  }
  // Every upgrade can be found somewhere, or it is dead content.
  for (const id of UPGRADE_IDS) {
    const found = events.some((ev) => ev.choices.some((c) => c.effects.some((e) => e.kind === "upgrade" && e.upgrade === id)));
    if (!found) problems.push("upgrade " + id + " is granted by no event");
  }
  return problems;
}

/** Every problem with the upgrades table. Empty means valid. */
export function validateUpgrades(table: Readonly<Record<string, UpgradeDef>> = UPGRADES): string[] {
  const problems: string[] = [];
  const ids = Object.keys(table);
  if (ids.length < MIN_UPGRADES) problems.push("only " + ids.length + " upgrades; at least " + MIN_UPGRADES);
  for (const id of ids) if (!(UPGRADE_IDS as readonly string[]).includes(id)) problems.push("upgrade " + id + " has no code in UPGRADE_IDS");
  for (const id of UPGRADE_IDS) if (!table[id]) problems.push("UPGRADE_IDS lists " + id + ", which is not in the table");
  for (const [key, u] of Object.entries(table)) {
    if (u.id !== key) problems.push("upgrade " + u.id + " is filed under " + key);
    if (!u.name || !u.about) problems.push(u.id + " needs a name and an about line");
    if (u.effects.length === 0) problems.push(u.id + " does nothing");
    for (const e of u.effects) {
      const pct = (v: number, lo: number, hi: number): void => {
        if (!(Number.isInteger(v) && v >= lo && v <= hi && v !== 0)) problems.push(u.id + ": " + e.kind + " out of range");
      };
      switch (e.kind) {
        case "yieldPct":
          pct(e.pct, 1, 200);
          if (e.crop && !(CROP_IDS as readonly string[]).includes(e.crop)) problems.push(u.id + ": unknown crop " + e.crop);
          if (e.withBuilding && !(BUILDING_IDS as readonly string[]).includes(e.withBuilding)) problems.push(u.id + ": unknown building " + e.withBuilding);
          break;
        case "foragePct": case "taxPct": case "musterPct": pct(e.pct, 1, 200); break;
        case "spoilagePct": pct(e.pct, -90, -1); break;
        case "storage": if (!(Number.isInteger(e.grain) && e.grain > 0)) problems.push(u.id + ": storage must be whole grain > 0"); break;
        case "grant": case "daily": if (!wholeCost(e.gains)) problems.push(u.id + ": " + e.kind + " must be whole stocks > 0"); break;
        case "legitimacyPerBuilding":
          if (!(BUILDING_IDS as readonly string[]).includes(e.building)) problems.push(u.id + ": unknown building " + e.building);
          pct(e.perSeason, 1, 5);
          break;
        case "roadCostPct":
          pct(e.pct, -80, -1);
          if (e.terrains.length === 0 || e.terrains.some((t) => !(ROAD_TERRAIN_IDS as readonly string[]).includes(t))) problems.push(u.id + ": unknown road surface");
          break;
        case "sightMiles": pct(e.miles, 1, 100); break;
        case "later": if (!e.note) problems.push(u.id + ": a later effect needs a note"); break;
      }
    }
  }
  return problems;
}

/**
 * Every problem with the events against a map: each site must be able to
 * draw an event of its own kind however the others were drawn, so each kind
 * needs at least as many events of its own as there are sites of that kind
 * (the "any" events are spare, never relied on).
 */
export function validateSites(map: KingdomMapDef, events: readonly StoryEventDef[] = STORY_EVENTS): string[] {
  const problems: string[] = [];
  for (const kind of SITE_KINDS) {
    const sites = map.holdings.filter((h) => h.site === kind).length;
    const own = events.filter((e) => e.site === kind).length;
    if (own < sites) problems.push(sites + " " + kind + " sites but only " + own + " " + kind + " events");
  }
  return problems;
}
