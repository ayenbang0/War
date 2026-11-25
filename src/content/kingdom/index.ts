/**
 * Kingdom-layer content: plain data plus its validation (PLAN.md §B.10).
 *
 * K3 adds crops.ts and buildings.ts here, K6 morale.ts, K7 the mercenary
 * tables, K9 story/ -- each as a table the sim reads by id.
 */

export * from "./factions.ts";
export * from "./terrain.ts";
export * from "./map.ts";
export * from "./validate.ts";
