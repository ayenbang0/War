/**
 * Balance sweep for the K3 economy (not part of `npm test`).
 *
 *   node tools/kingdom-sweep.ts            three years, every strategy, seed 1
 *   node tools/kingdom-sweep.ts 360 7      days, seed
 *
 * Prints each scripted strategy's stocks every fifteen days, with hunger,
 * famine and the king's holdings, so a change to a number in
 * src/content/kingdom/economy.ts, buildings.ts or crops.ts can be judged by
 * eye: does the careful exile still get through the first winter, does the
 * careless one still starve, does anything run away over three years?
 * The strategies are the ones the economy test uses (tools/kingdom-strategies.ts).
 */

import { runStrategy, steward, STRATEGIES } from "./kingdom-strategies.ts";
import { STOCK_IDS } from "../src/content/kingdom/economy.ts";

const days = Number(process.argv[2] ?? 360 * 3);
const seed = Number(process.argv[3] ?? 1);
const keepFields = steward(["cold-hearth", "greyshaw", "rookstead", "thornwick", "fell-end"]);

const pad = (s: string | number, n: number): string => String(s).padStart(n);

for (const s of STRATEGIES) {
  const r = runStrategy(seed, s, days, { everyDay: keepFields });
  console.log("\n== " + s.name + " -- " + s.about);
  console.log("   " + r.trace.slice(0, 14).join(" | ") + (r.trace.length > 14 ? " | ..." : ""));
  console.log(pad("day", 5) + STOCK_IDS.map((k) => pad(k, 8)).join("") + pad("need", 6) + pad("hungry", 8) + pad("famine", 8) + "  holdings");
  let hungryDays = 0;
  let famineDays = 0;
  for (const d of r.days) {
    if (d.hunger > 0) hungryDays++;
    if (d.famine > 0) famineDays++;
    if (d.day % 15 !== 0) continue;
    console.log(pad(d.day, 5) + STOCK_IDS.map((k) => pad(d.stocks[k], 8)).join("") + pad(d.need, 6) + pad(d.hunger, 8) + pad(d.famine, 8) + "  " + d.owned);
  }
  const w = r.world;
  console.log("   days hungry " + hungryDays + ", days with a holding in famine " + famineDays + ", legitimacy " + w.kingStocks.legitimacy);
  for (const h of w.holdingsOf("king")) {
    console.log("   " + h.name + ": " + h.population + " people, " + h.buildings.map((b) => b ?? "-").join(",") +
      "; fields " + h.plots.map((p) => (p.crop ?? "-") + " " + p.stage).join(", "));
  }
}
