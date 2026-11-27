/**
 * Balance summary for the economy (not part of `npm test`):
 *
 *   node tools/kingdom-balance.ts [years] [seed]
 *
 * Runs the scripted players of tools/kingdom-strategies.ts for `years`
 * calendar years (default two) and prints one line each: days the party went
 * hungry, days any town of the king's starved, the king's towns and their
 * people, followers, grain and coin at the end. The ECON pass (docs/
 * PROVISIONAL.md ECON.*) is judged by it: a passive king who claims one
 * holding and then does nothing must live through two years; an active one
 * must grow.
 */

import { runStrategy, steward, STRATEGIES } from "./kingdom-strategies.ts";
import { DAYS_PER_YEAR } from "../src/sim/kingdom/index.ts";

const years = Number(process.argv[2] ?? 2);
const seed = Number(process.argv[3] ?? 1);
// "off" runs with field auto-resow off (hand farming only), as every game before ECON.
const autoFarm = process.argv[4] !== "off";
const days = years * DAYS_PER_YEAR;
const keepFields = steward(["cold-hearth", "greyshaw", "rookstead", "thornwick", "fell-end"]);
const pad = (s: string | number, n: number): string => String(s).padStart(n);

console.log("years " + years + " (" + days + " days), seed " + seed + ", auto-resow " + (autoFarm ? "on" : "off"));
console.log(pad("strategy", 10) + pad("hungry", 8) + pad("famine", 8) + pad("towns", 7) + pad("people", 8) + pad("levy", 6) + pad("grain", 8) + pad("coin", 7));
for (const s of STRATEGIES) {
  const r = runStrategy(seed, s, days, s.name === "passive" ? { autoFarm } : { everyDay: keepFields, autoFarm });
  let hungry = 0;
  let famine = 0;
  for (const d of r.days) { if (d.hunger > 0) hungry++; if (d.famine > 0) famine++; }
  const w = r.world;
  const towns = w.holdingsOf("king");
  const people = towns.reduce((n, h) => n + h.population, 0);
  const st = w.kingStocks.stocks;
  console.log(pad(s.name, 10) + pad(hungry, 8) + pad(famine, 8) + pad(towns.length, 7) + pad(people, 8) + pad(st.levy, 6) + pad(st.grain, 8) + pad(st.coin, 7));
}
