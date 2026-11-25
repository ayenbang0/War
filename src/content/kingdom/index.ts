/**
 * Kingdom-layer content: plain data plus its validation (PLAN.md §B.10).
 *
 * K3 added economy.ts, buildings.ts and crops.ts; K6 adds morale.ts, K7 the
 * mercenary tables, K9 story/ -- each as a table the sim reads by id.
 */

export * from "./factions.ts";
export * from "./terrain.ts";
export * from "./map.ts";
export * from "./validate.ts";
export * from "./economy.ts";
export * from "./buildings.ts";
export * from "./crops.ts";
export * from "./exploration.ts";
export * from "./armies.ts";
export * from "./army-strings.ts";
export * from "./descent.ts";
export * from "./descent-strings.ts";
export * from "./morale.ts";
export * from "./morale-strings.ts";
export * from "./mercenaries.ts";
export * from "./mercenary-strings.ts";
