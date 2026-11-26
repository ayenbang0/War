# The kingdom layer — sim core (K1), map (K2) and economy (K3, ECON)

For the agents building K2 onwards. PLAN.md Part B is the design; this file is
what K1 actually built and the contracts later phases must keep.

Everything here is headless and pure (`src/sim/kingdom/`, under the same
purity scan as the battle sim: `npm run check:sim` walks `src/sim/`
recursively). The only browser-side piece is `src/app/kingdom-save.ts`.

## Files

| Path | What |
|---|---|
| `src/sim/kingdom/world.ts` | `KingdomWorld`: state, `tick(orders)`, queries |
| `src/sim/kingdom/clock.ts` | tick/day/season/year constants and `calendar(tick)` |
| `src/sim/kingdom/orders.ts` | `KingdomOrder` types and `KingdomOrderQueue` |
| `src/sim/kingdom/state.ts` | entity records (`Holding`, `Road`, `FieldPlot`, `Mover`, `KingToken`, `KingdomEvent`) |
| `src/sim/kingdom/graph.ts` | road graph, Dijkstra router, continuous edge travel |
| `src/sim/kingdom/hash.ts` | `kingdomHash(world)` |
| `src/sim/kingdom/save.ts` | `serialize` / `deserialize` / `migrate` / `replayLog`, JSON helpers |
| `src/sim/layers.ts` | `layerHash(kingdomHash, battleHash?)`, `driftedLayer`; K5 adds `BattleSpec`/`BattleResult` here |
| `src/sim/rng.ts` | five new streams appended: `Economy`, `Events`, `KingdomAi`, `Autoresolve`, `Weather` |
| `src/content/kingdom/` | the authored map, factions, biomes, road surfaces, holding kinds, weather; `validateKingdomMap` |
| `src/app/kingdom-save.ts` | localStorage wrapper (`war.kingdom.v1`), export/import |
| `tools/kingdom-headless.ts` | the K1 test suite (part of `npm test`) |
| `tools/kingdom-golden.json` | the `kingdom` golden tier |

## Time

| Constant | Value | Meaning |
|---|---|---|
| `TICKS_PER_DAY` | 8 | a kingdom tick is three hours |
| `DAYS_PER_MONTH` | 30 | ECON: twelve named months (`MONTHS` in content/kingdom/terrain.ts) |
| `DAYS_PER_SEASON` | 90 | three months: spring, summer, autumn, winter |
| `SEASONS_PER_YEAR` | 4 | |
| `DAYS_PER_YEAR` | 360 | ECON: a real twelve-month year (it was 120, four 30-day "months") |
| `TICKS_PER_YEAR` | 2880 | ten years = 28800 ticks |
| `START_DAY_OF_YEAR` | 180 | the exile begins on 1 Harvestmoon, the first day of autumn, year 1 |

ECON: a realm's dates are read from its `epoch` (`KingdomConfig.epoch`,
default `START_DAY_OF_YEAR`): `calendar(now, epoch)`. A new game never sets
it; an old save gets one that keeps its year, season and share of the season
(see "ECON" below). The HUD reads "14 Harvestmoon, Year 1 · Autumn".

The tick counter is `world.now` (not `tick`, which is the method). Day, season
and year are derived by `calendar(now)` / `world.date` and never stored.

The kingdom tick is **not** coupled to the 20 Hz battle tick. Only one layer
is live at a time (§B.1): the layer controller simply stops calling
`kingdom.tick()` while a battle runs. **Pause and speed are UI-only**: the UI
decides how many `tick()` calls to make per frame. 1× = one day per
second (ECON; it was 2 s, so a 360-day year is six minutes at 1×, 90 s at 4×), 2× and 4× scale that, `.` while paused runs `TICKS_PER_DAY`
ticks. None of this is an order and none of it is saved.

## The tick

`tick(orders = [])`, in this order:

1. queue the given orders (`submit`);
2. on the first tick of a day: roll the day's weather (`weather` stream),
   then run the day's economy (`runEconomyDay`, K3: see "K3 — economy and
   farming" below for its own order);
3. *K8: captains' AI issues orders here, through the same queue*;
4. drain every order due at `now`, sort by `(tick, player, seq)`, append each
   to `world.log`, apply it;
5. march the king's retinue — *K4: armies march; K5: contact check in army-id
   order; K6 morale; K7 contracts*;
6. `now++`. Returns the tick's `KingdomEvent[]` (transient, never saved or hashed).

## Orders

```ts
type KingdomOrderBody =
  | { kind: "moveKing"; to: number }   // holding id
  | { kind: "haltKing" };
type KingdomOrder = KingdomOrderBody & { tick: number; player: number; seq: number };
```

- `player` is the faction's index in `FACTION_IDS` (`content/kingdom/factions.ts`);
  the human king is `KING_PLAYER = 0`. Append factions, never insert.
- `world.issue(body, player = 0)` stamps for the next boundary (`now`) and
  queues; it returns the stamped order (what netplay would send).
- `world.submit(order)` queues an already-stamped order (log replay, a peer,
  the AI). An order stamped for a tick that has already run is moved to `now`
  **on entry**, so the log records it as applied and replays exactly.
- Application order is `(tick, player, seq)`, never arrival order. Two orders
  of the same player in one tick apply in seq order, so the later `moveKing`
  wins.
- Invalid orders (unknown holding, unreachable, wrong player) are rejected
  with an `orderRejected` event and change nothing — but they are still logged.
- New kinds: append to the union **and** to `KINGDOM_ORDER_KINDS` (its index is
  the hash code), add a case to `applyOrder`, to `mixOrder` (hash.ts) and to
  `readOrder` (save.ts).

## Entities and ids

One counter, `world.nextId`, starting at 1 (0 means "none" in `Mover` fields).
Creation order at construction: holdings (map order), roads (map order), field
plots (holding by holding), the king. Building the same map always gives the
same ids, whatever the seed — the save format depends on it. Later entities
(armies, K4) take the next ids. Every list is kept in id order.

`Holding` carries K1 placeholders for later phases, already saved and hashed:
`garrison: number[]` (army ids, ≤ `garrisonSlots`), `buildings: (string|null)[]`
(one per slot), `plots: FieldPlot[]` (`stage: "empty"`, `crop: null`).
`Holding.seed` + `BIOMES[holding.biome].level` (a level id in
`content/levels/`) is what a K5 battle at that node generates its ground from
(`generateTerrain(level.tilesWide, level.tilesHigh, holding.seed)`).

## Movement

`Mover` (`state.ts`) is the shared travel component — the king now, armies in
K4. Flat fields: at a holding `node = id, road = 0`; on a road
`road = id, from, to, along` (miles from `from`, continuous). `route` lists the
holdings still to reach; on a road `route[0] === to`. Empty route = standing
still, possibly mid-road after a halt.

- `findRoute(graph, mover, dest)` — Dijkstra on effort = miles × surface cost;
  from mid-road it starts at both ends (turning round is just another option).
  Ties: least effort, then least node id; equal-effort predecessor replaced only
  by a smaller id; a start node is never re-parented. Weather is ignored (it
  scales every mile alike).
- `setRoute(graph, mover, route)` — installs it, turning round in place if needed.
- `advanceMover(graph, mover, effort, weatherMultiplier)` — spends effort,
  possibly crossing several holdings; returns the holdings reached.
- `moverPosition(graph, mover)` — map position in miles, for the renderer and
  (K5) contact radius.
- Retinue speed: `RETINUE_MILES_PER_DAY = 18` on a plain road in clear weather.
  Surface costs (`ROAD_TERRAIN`): highway 0.8, road 1.0, track 1.4, ferry 1.5,
  ford 1.6, forest 1.7, moor 1.8, pass 2.0. Weather (`WEATHER`): clear 1.0,
  fog 1.1, rain 1.3, storm 1.6, snow 1.8 (snow only in winter).
- `world.planKingRoute(to)` — route + ETA in ticks at today's weather, for the
  K2 march ghost. Read-only.

## Randomness

`world.rng.{economy, events, kingdomAi, autoresolve, weather}`, created from
`world.seed` with the new `Stream` constants. Only `weather` is drawn in K1.
Use the stream your subsystem owns and no other: a new roll in one must never
shift another. The battle streams (`stable` golden tier) are untouched.

## Hashes

- `kingdomHash(world)` — 8 hex digits over the whole state: clock, ids,
  weather, every holding (incl. placeholders), roads, the king and his mover,
  **queued orders (in canonical order) and per-player seq counters**, and all
  five rng states. Not hashed: `log`, `events`. Anything you add to state must
  be added here — the save→load→continue test will catch you if you forget it
  in save.ts, but only this hash catches it in a desync.
- `layerHash(kingdomHash, battleHash?)` — combined fingerprint; `driftedLayer`
  compares two peers' parts and names the layer that drifted.
- Golden: `tools/kingdom-golden.json` holds the `kingdom` tier (seed
  0x6b1d0001, a scripted decade). It is **expected** to move when a kingdom
  phase changes what a day does; regenerate with
  `UPDATE_KINGDOM_GOLDEN=1 node tools/kingdom-headless.ts` and say why in the
  commit. It is separate from `tools/golden.json` so `UPDATE_GOLDEN` never
  touches it and a kingdom change never touches the battle tiers.

## Save format (version 1)

```jsonc
{
  "format": "war.kingdom",
  "version": 1,
  "map": "rimaros",
  "mapFingerprint": "xxxxxxxx",   // static map: holdings, roads, plot ids
  "seed": 123,
  "kingName": "Aldric of Rimaros",
  "snapshot": {
    "now": 0, "nextId": 187, "weather": "clear",
    "rng": { "economy": {"a":0,"b":0,"c":0,"d":0}, "events": {}, "kingdomAi": {}, "autoresolve": {}, "weather": {} },
    "seqs": [3],                    // last seq per player
    "pending": [ /* stamped orders not yet due */ ],
    "holdings": [ { "id", "key", "owner", "population", "garrison", "buildings", "plots": [{ "id", "crop", "stage", "progress" }] } ],
    "king": { "id", "companions": ["Brother Aldous"], "mover": { "node", "road", "from", "to", "along", "route" } }
  },
  "log": [ /* every order applied, as applied */ ]
}
```

- Dynamic state only. `deserialize` rebuilds the map from content (same ids),
  checks the fingerprint, validates **every** field, and only then writes into
  the world; it returns `{ ok: true, value } | { ok: false, error }` and never
  throws on bad input. `loadFromJson` / `saveToJson` wrap JSON.
- `replayLog(seed, log ++ pending, now)` reproduces the snapshot; the suite
  checks it.
- **Changing the format:** bump `KINGDOM_SAVE_VERSION`, add
  `MIGRATIONS[oldVersion]` that returns a save with `version: oldVersion + 1`
  (e.g. K3: fill stockpiles with starting values), and extend `serialize` /
  `build`. Never reinterpret an old version in place. A content change that
  moves ids or positions changes the fingerprint: give it a migration or accept
  that old saves are refused.
- Storage (`src/app/kingdom-save.ts`): `saveKingdom(world, storage?)`,
  `loadKingdom(storage?)`, `clearKingdom`, `exportKingdom(world): string`,
  `importKingdom(text)`. Key `war.kingdom.v1`, temp key `war.kingdom.v1.tmp`,
  write-then-swap (write temp, read back, copy to main, remove temp; a valid
  temp on load wins and the swap is completed). Every failure is a result
  (`unavailable` / `refused` / `unverified` / `corrupt`) with a detail string.
  `storage` defaults to `localStorage` and is injectable for tests.

## The map (content/kingdom/map.ts)

36 holdings in ten provinces: the Farthest Reach (5, all unclaimed: the king
starts at Cold Hearth; Greyshaw, Thornwick and Fell End are hamlets to rally
from; Rookstead is an empty ruined keep to claim first), the Vale of the Hare
(4, Hare), the Long Wood (3, Boar), the Lisle Bridges (3, Badger), Hallow Ferry
(3, Owl), the Red March (4, Margrave), the Open Fields (4, Fox), Stag Heights
and Wolf Moor (4: Stag 2, Wolf 2), Crow's Reach (3, Crow), and Rimaros, the
Crown Seat (3, Chancellor Oswin Vael). 52 roads. Miles on a 1000 × 700 table.

Factions (`FACTION_IDS` order): king, usurper, margrave, boar, fox, badger,
hare, wolf, owl, stag, crow. A captain's `persona` **is** its battle
commander's `bias`/`boldness` (same object) — K8 reads it from there. The
Margrave and the usurper have authored personas.

Always run `validateKingdomMap(map)` before building a world on a new map; the
router and the save format assume a valid graph.

## What K1 does not do (by design)

No economy, stockpiles, buildings or crops (K3); no armies, recruitment or
garrisons (K4; the king is a retinue, not an army); no contact or battles (K5);
no morale (K6); no mercenaries (K7); no AI (K8); no fog of war at the kingdom
layer yet; no renderer or UI (K2). The log grows without bound; a K11 polish
pass may checkpoint it.

## K2 — the kingdom map

K2 makes the sim above playable: a parchment map you read by tapping and
order by pen, running in real time. The UX audit it was built against is
`docs/audit/u1-kingdom-map.md`; the open choices are `K2.x` in
`docs/PROVISIONAL.md`. The sim is unchanged — K2 only *reads* the
`KingdomWorld`, and writes it only through `world.issue` (march, halt) and
`world.tick()`.

### Files

| Path | What |
|---|---|
| `src/app/kingdom-layer.ts` | `KingdomLayer`: frame loop, clock → `world.tick()`, events → HUD, autosave, pen sink, keys, cards; `start()` / `teardown()` like `BattleLayer` |
| `src/app/kingdom-clock.ts` | pause and 1× / 2× / 4×: 1× = one day per 2 s, fixed-step accumulator, ≤ 24 ticks a frame |
| `src/render/kingdom/renderer.ts` | procedural parchment: grain, province washes, roads by surface, holding glyphs (owner by fill), culled labels, the king's counter, routes, ghost and ink |
| `src/render/kingdom/camera.ts` | kingdom camera: zoom bounds from the viewport, zoom about a point, clamp, `flyTo` for F |
| `src/render/kingdom/layout.ts` | where the king's counter is drawn (30 px above him) — shared by the renderer and the pen |
| `src/render/kingdom/palette.ts` | map colours (contrast-checked in U1) |
| `src/input/kingdom-gestures.ts` | the kingdom recogniser (pure; reuses `pathLength`/`simplify` from `gestures.ts`, which it does not modify) |
| `src/input/kingdom-commander.ts` | `interpretStroke`: the ONE function that gives both the preview ghost and the committed order |
| `src/input/kingdom-pen.ts` | left-button strokes in map miles |
| `src/input/kingdom-camera-controls.ts` | middle/right drag, wheel about the cursor, WASD/arrows, -/=, edge push |
| `src/ui/kingdom/hud.ts`, `cards.ts`, `kingdom.css` | top bar (stores, date + weather, speed group, Front screen), PAUSED banner, feed, result line, key hint; region and king cards |
| `src/content/kingdom/ui-strings.ts` | every word the map shows, as a table and templates |
| `src/e2e/scenarios-k2.ts` | browser scenarios (also run by `npm run e2e:fake`) |

### The pen

`recognizeKingdom(points, ctx)` reads, in this order and each on its own
evidence: **tap** (short stroke → nearest token or holding, by normalised
distance), **closed** (ends meet → `none: closed-shape`, reserved for K4's
rings and hearts and never claimed by the king's anchor), **subject** (must
start on the king's drawn counter), **target** (the holding it ends on →
`march`; the king's own holding → `none: already-there`). Every stroke that
orders nothing is `none` *with a reason*, and the result line says it.

`interpretStroke` turns that into `{ghost, order, card, message}`. The pen
calls it on every sample for the ghost (route along the roads from the sim's
`planKingRoute`, ETA plate at the pen tip) and once more on release, issuing
exactly `intent.order`. `tools/kingdom-headless.ts` checks that the last
preview equals the commit for every march in the corpus and that the ghost is
the sim's own plan.

**Adding K4 gestures.** Each new meaning goes in exactly one step: an army as
a token (`TokenView.kind`), intercept/merge as targets in step 3, split as a
line *across* an army before step 2, garrison/patrol/recover as readings of a
closed stroke in step 1 (which today answers `closed-shape`). Add the cases
to `buildKingdomCorpus()` in the same commit; the matrix must stay diagonal.

### Confusion matrix

`buildKingdomCorpus()` (tools/gesture-corpus.ts) draws on the real map with
every label live — the king beside his own holding, neighbours round him, and
rings and hearts drawn from the king — at the widest, opening and closest
zooms of a 1280 × 720 window, with the king standing and out on a road.
`npm test` prints it (in the kingdom-headless output) and fails if any cell
is off the diagonal. A tap or march on the *wrong* holding counts as a miss.

### Time and saving

The layer runs `clock.advance(dt)` ticks per frame (held at zero while a
confirm is up). Space pauses, `.` runs one day while paused, 1/2/3 set the
speed. The date line follows `world.now`. The realm is saved on every day
boundary, on leaving the map and when the page is hidden; Home's Exile button
then continues it. A failed save is shown, never swallowed; an unreadable save
is never replaced without asking.

### What K2 does not do

No armies, garrisons or other K4 gestures (closed strokes say so); no stores
(the box says the king has none); no fog of war; no chronicle of the map.
The real-browser click-through and screenshots of the U1 re-audit are still
to be done on a machine with a browser: `e2e.html` runs every scenario,
the K2 ones included (their names start `k2-`).

## K3 — economy and farming

PLAN §B.3 and §C K3. Everything below is pure sim (`src/sim/kingdom/`) or
content (`src/content/kingdom/`); the UI only reads it and sends orders.

### Files

| Path | What |
|---|---|
| `src/content/kingdom/economy.ts` | stocks, ledger categories, the exile's start, tax rates, dole, storage and spoilage, foraging, rally, claim, farm-event odds and harm, field sizes; `validateEconomy` |
| `src/content/kingdom/buildings.ts` | the 13 buildings: cost, build days, upkeep, slots, economic effect, and battle/defence/vision/morale as data for later phases (`later`); `validateBuildings` |
| `src/content/kingdom/crops.ts` | wheat/barley, rye, flax, herbs/poppy, orchard: sowing and growing seasons, hardiness, days, seed, yield; `validateCrops` |
| `src/sim/kingdom/ledger.ts` | the ONLY way to change a stock (`credit`/`debit`), the per-faction per-day pages, `adjustLegitimacy` |
| `src/sim/kingdom/economy.ts` | `checkEconomyOrder` / `applyEconomyOrder`, `runEconomyDay`, queries (`storageOf`, `dailyNeed`, `taxPerDay`, `seedCost`, `expectedYield`, `famineDeaths`), `changeLegitimacy` (K6's entry point) |
| `tools/kingdom-economy.ts` | the K3 suite (in `npm test`) |
| `tools/kingdom-strategies.ts` | scripted players (careful, careless, idle, forager, builder) shared by the suite and the sweep |
| `tools/kingdom-sweep.ts` | `node tools/kingdom-sweep.ts [days] [seed]`: stock trajectories for every strategy over three years (not in `npm test`) |
| `tools/fixtures/kingdom-save-v1.json` | a real K2 save, for the v1 → v2 migration test |
| `src/ui/kingdom/resources.ts`, `economy-panel.ts`, `icons.ts` | resources bar, region-card economy panel, build and sow menus, stock icons (audit: `docs/audit/u2-economy-panels.md`) |

### Stocks and units

Per faction (`world.economy[f]`, `FACTION_IDS` order): `coin` (pennies),
`grain` (**person-days**: one ration feeds one person a day), `timber`
(cartloads), `iron` (bars), `levy` (followers), all whole numbers ≥ 0; and
`legitimacy` 0..100, a soft stat with one entry point (`changeLegitimacy` →
`adjustLegitimacy`, ledger categories `deeds`/`disgrace`) that K6 fills with
rules. Only the king's economy runs in K3 (`ECONOMY_FACTIONS`); the captains'
are kept at zero until K8 gives them hands. The king starts with nothing but
12 days of bread: no holding, no coin, no followers.

Each stock feeds a decision: coin pays for buildings, seed and upkeep; grain
is everyone's bread and the seed of wheat and rye; timber builds; iron is
made by a forge from timber and built into walls and keeps; followers claim a
holding (`CLAIM_MIN_LEVY` 3), eat, carry (`CARRY_PER_PERSON`) and forage.

### The ledger

`credit(e, book, stock, n, category)` / `debit(...)` are the only writers of a
stock. Each category has a direction (source or sink); a debit below zero, a
non-integer amount or a wrong-direction category throws (a sim bug, never a
state). A faction's book holds two pages: the day being written (`open`) and
the last day closed (`closed`); a page is `{ day, start[], flow[] }` with flow
per stock × category. So, for every faction, stock and day:

    end = start + Σ sources − Σ sinks     (end = the next page's start)

`tools/kingdom-economy.ts` holds three years of four strategies to that on
every day. Categories already present for later phases: `plunder` (K5),
`rations`, `wages`, `recruitment`, `desertion` (K4), `deeds`, `disgrace` (K6).
Older pages are not kept (the save would grow without bound); a test that
wants history reads each page as it closes.

### The economy's day (`runEconomyDay`, first tick of a day, after the weather)

1. turn every faction's ledger page;
2. one farm-weather draw from the `weather` stream (always one draw, so sowing
   never moves the weather): drought, frost or flood by season and weather,
   harming crops in the ground by `FARM_EVENT_HARM` (hardy crops less; floods
   only in low country); a crop beaten to 0 health is `spoiled`;
3. on the first day of a season (not day 0): winter kills tender crops in the
   ground; a harvested orchard regrows in spring; each owned holding not in
   famine grows or shrinks by its tax rate's `growthPct`, then musters
   `MUSTER_PCT` of its people (more with a barracks) into the levy;
4. crops grow (counting only days of a season they grow in): `sown` →
   `growing` after `GERMINATION_DAYS`, `progress` = days / `growDays`, then
   `ripe`; ripe left longer than `ripeDays` spoils;
5. per active faction: buildings (works count down to `built`; a standing
   building pays its upkeep or goes idle; workshops consume and produce;
   markets trade), taxes (pop × rate per 100, remainder carried), the king's
   task (forage or rally, below), everyone eats (below), spoilage;
6. a `stocksChanged` event for a faction whose stocks moved.

Orders then apply as in K1 (drain by `(tick, player, seq)`).

### Eating, storage, famine

Each day the king's party eats `PARTY_RATION` each (king, companions,
followers) and each owned holding draws its dole (`DOLE_PER_100` per season:
peasants feed themselves most of the year; winter's 10 per 100 is the
pressure). Short grain is shared in proportion to need; a short day is a
famine day for every owned holding (`holding.famine` counts the days: the
signal K6 unrest and K4 desertion read) and a hungry day for the party
(`economy.hunger`). A holding in famine pays no tax, does not grow, and loses
`FAMINE_LOSS_PCT` (2 %) of its people a day (`famineDeaths`, spread evenly
with no stored carry). Grain is kept in granaries (`SPOIL_PERMILLE.granary`
3 ‰ a day), then loose (cellars of owned holdings + what the party carries,
15 ‰), then heaped (25 % a day): so autumn's gleanings rot without a granary.

### Orders (appended to `KINGDOM_ORDER_KINDS`, in this order)

| Order | Applies when | Effect |
|---|---|---|
| `forage` | the king is at a holding, not marching | task: each day, grain = people × `FORAGE_PER_PERSON[season]` × fertility, timber = people × wood / 400 |
| `rally` | at an unclaimed hamlet above 60 % of its people | task: each day 1 per 25 people (≥ 1) leaves the hamlet for the levy, bringing 3 grain and 1 coin each; ends itself when the hamlet is spent |
| `claimHolding {holding}` | the king stands there, it is unowned and ungarrisoned, ≥ 3 followers | the holding is the king's, taxed at his default rate; no battle |
| `setTax {holding, rate}` | the holding is the king's (0 = every holding, and the default for later claims) | sets the rate |
| `build {holding, building}` | owned; the country allows it; a free slot (or the building it upgrades, standing); affordable; not a second unique one | pays the cost, works count down `days` |
| `sow {plot, crop}` | owned; the field is empty, harvested or spoiled (a harvested orchard needs no sowing); in the crop's sowing season; seed affordable | pays the seed (× `FIELD_SIZE`), `sown` |
| `harvest {plot}` | owned; ripe | the yield × health × (farm bonus), ±`HARVEST_VARIANCE_PCT` from the `economy` stream, `harvested` |

Marching or halting ends the king's task. `world.check(body, player)` is the
same function the sim applies (`checkEconomyOrder`): the panels call it to
decide what to offer, so a button never promises what the sim refuses.
Sowing and harvesting need no king present (the steward does it).

### Save format version 2

Adds, per holding, `works`, `idle`, `tax`, `taxCarry`, `doleCarry`, `famine`
and, per plot, `days`, `health`; on the king, `task`, `taskDays`; and
`economy[]` per faction (stocks, legitimacy, hunger, default tax, the open
and closed ledger pages). `MIGRATIONS[1]` gives a K2 save the exile's
starting stores as of the save's day, default taxes and empty works; the
order log is kept, and replaying it runs K3's rules (the honest meaning of an
old log under new rules). The map fingerprint is unchanged (K3 adds no ids).

### Determinism and the golden

The economy draws only from the `economy` stream (harvest luck) and the
`weather` stream (one farm draw a day). Iteration is in holding/plot/slot id
order. The kingdom golden moved in K3 (expected): every day now runs the
economy, takes one more weather draw, and hashes the new state. The battle
tiers do not move.

### The proof (tools/kingdom-economy.ts, "first winter")

From the same start (seed `0x6b1d0001`), two scripted order logs:

- **careful**: rally four followers at Cold Hearth, forage to a full pack,
  march to Greyshaw, claim it, build a granary (standing by day 20, before the
  first winter's day 30), sow rye, keep foraging. Grain never reaches zero, no
  hungry day, no famine through day 60.
- **careless**: rally everyone Cold Hearth will give, claim it, forage a
  little, build nothing. The autumn's grain rots in heaps; famine by day ~40.

The same holds on eight other seeds. Both logs replay to the same realm.

### UI

The resources bar (top bar), the economy panel of an owned holding's region
card (tax, bread, building slots with **Build…**, fields with **Sow…** /
**Harvest**), the build and sow menus (modal, trap Tab, hold the clock), and
the king card's **Forage here**, **Rally followers** and **Claim …**. Feed lines
for buildings, harvests, ripe and spoiled fields, farm weather, rallies, claims
and famine. Scenarios `k3-exile-economy` and `k3-menu-esc-and-refusal`.
Audit: `docs/audit/u2-economy-panels.md` (no open P0/P1; runtime pass pending
a real browser).

### What K3 does not do

No armies, rations or wages (K4: the categories exist); no plunder (K5); no
morale or unrest rules (K6: legitimacy and the famine signal are ready); no
captains' economies (K8); building battle/defence/vision values are data only.
Timber and coin have no storage cap.

## K3a — twice the map, exploration, events and special upgrades

PLAN §C K3a (the user's "2x the cities and areas to explore, with events and
special upgrades"). Sim in `src/sim/kingdom/explore.ts`; content in
`src/content/kingdom/` and the new `src/content/story/`; UI in
`src/ui/kingdom/event-card.ts`, `explore-ui.ts`, `explore.css`.

### Files

| Path | What |
|---|---|
| `src/content/kingdom/map.ts` | 72 holdings (K1's 36 first, unchanged, then 36 appended), 115 roads, three wild provinces (the Grey Wold, the Iron Fells, the Saltings), `site` on 25 holdings, `startKnown` |
| `src/content/kingdom/exploration.ts` | the three knowledge states and the sight radii |
| `src/content/kingdom/validate.ts` | now also: holdings ≥ 40 miles apart, no two roads cross, no road passes within 18 miles of a holding it does not join, sites are unowned and not the start, `startKnown` is sane |
| `src/content/story/events.ts` | 28 exploration events (2–3 choices each), by site kind or "any" |
| `src/content/story/upgrades.ts` | 16 special upgrades and their effects |
| `src/content/story/validate.ts` | `validateEvents`, `validateUpgrades`, `validateSites` |
| `src/content/story/strings.ts` | every word of the card, the Finds list, the feed lines and the refusals |
| `src/sim/kingdom/explore.ts` | the fog (`sightSources`, `applySight`, `updateSight`, `revealAround`), targeting and routing under the fog, `discover`, `checkResolve`/`applyResolve`, the upgrade hooks the economy calls |
| `src/ui/kingdom/event-card.ts` | the event card (modal, holds the clock) |
| `src/ui/kingdom/explore-ui.ts` | opens the card on a find, the Finds toggle and list, the feed lines |
| `tools/kingdom-explore.ts` | the K3a suite (in `npm test`) |
| `tools/fixtures/kingdom-save-v2.json` | a real K3 save (made by the K3 code), for the v2 → v3 migration test |
| `src/e2e/scenarios-k3a.ts` | `k3a-fog-and-find`, `k3a-decide-later` |

### The fog

Per faction (`world.explore[f]`, `FACTION_IDS` order), one value per holding
and per road, in id order: **0 unknown**, **1 known** (remembered), **2 seen**.
`applySight(world, f, sources)` is the one function: everything seen falls
back to known, then each holding within a source's radius and each road any
point of which is within it becomes seen. Distances are compared squared, with
only + − × ÷, so the result is exact on every machine. Nothing ever returns to
unknown (the suite checks this every day of a ten-year run).

Sources (`sightSources`), in order: the king's retinue (50 miles, +25 with
the Wayfinder's Map), then each owned holding in id order (hamlet 35, village
40, town 50, keep 55, city 65 miles; a standing, paid-up watchtower lifts its
holding to 80, +30 with the Lantern of the Watch). K4 appends armies.

When: every faction at construction and at each day boundary (after the
economy); the king's also on every tick his party moves. A reveal (an event
choice) marks places **known**, not seen.

At the start the king knows the map's `startKnown` holdings (the Reach and the
great towns) and the roads between two of them. The captains know everything
(their fog matters from K8).

### Marching under the fog

`moveKing` is refused ("nobody in the party knows the way there yet") unless
the destination is known, or is unknown but at the end of a known road whose
other end is known — a **frontier** holding, drawn as an unnamed "?". The route
keeps to known roads and passes only through known holdings
(`routeOptions`: `findRoute` gained `usable`, `through` and `cost` options;
`advanceMover` gained `cost` and `stopAt`). The planner, the ghost and the
check the UI uses are the same calls.

### Sites and events

A holding with a `site` (ruin, shrine, mine, forest, coast, fort) holds one
event. The first time the king's party sets foot there — as its destination
or on the way — it **halts** (`stopAt`), and `discover` draws an event on the
**events stream** (the only user of that stream so far): uniformly from the
events of the site's kind and the "any" events that faction has not yet
drawn, in table order. The find (`{site, event, day, choice: -1, failed}`) is
kept for ever, so a site's event fires exactly once.

### Resolving: `resolveEvent {site, choice}` (appended to `KINGDOM_ORDER_KINDS`)

Refused if there is no waiting letter there for that player, if the choice
index is not one, or if the stores cannot pay its price. Otherwise: the price
(`pay`) is paid (ledger: **offerings**), whatever comes of a gamble; one roll
on the events stream decides a gamble (`int(100) < pct`); then the outcome's
effects in order: `gain` (ledger: **finds**), `lose` (as much as there is,
**offerings**), `legitimacy` (**deeds** / **disgrace**), `upgrade` (kept for
good; a one-off `grant` lands under **boons**), `reveal`. A waiting letter
blocks nothing: the sim runs on; the card is what holds the clock.

### Special upgrades

Effects are read by the economy's own formulas, so with no upgrade held every
formula is K3's exactly: harvest yield %, forage %, tax %, muster %, granary
storage, loose-grain spoilage %, a one-off grant, a daily boon (ledger:
boons), legitimacy per standing building each season (deeds), road cost % for
the party, sight. `later` effects (armies, battle) are recorded for K4–K7.

### Save format version 3

Adds `snapshot.explore[]` per faction (knowledge arrays, finds, upgrades) and
three ledger categories. `MIGRATIONS[2]`: a save of the frozen K3 map
(`K3_MAP`, fingerprint `94dd4aa0`) keeps holding ids 1–36; every later id
moves piecewise (old roads +36, old plots +99, the king and after by the
inserted plots), in the snapshot and in the order log alike; holdings 37–72
are added as a new world has them; ledger pages are re-laid for the new
categories; the king knows the whole old map (a K3 player saw it), the new
country is unexplored; sight is worked out on load. The log is kept and
replays under K3a's rules.

### Determinism and the golden

The kingdom golden moved in K3a (expected, regenerated with
`UPDATE_KINGDOM_GOLDEN=1`): the map is twice the size and is hashed, the fog
and the finds are hashed, and the decade script's marches to places the king
does not know are now refused while those that reach a site halt there and
draw on the events stream. The battle tiers do not move.

### UI

The renderer draws only what the king knows: unknown holdings and roads are
bare parchment, frontier holdings a ringed "?", remembered roads fainter,
province washes and names once one of their holdings is known, and a small
diamond on a known site not yet visited. The pen only offers known places and
frontier marks; tapping a mark opens nothing and says what it is. Arriving at
a site opens the **event card**: modal, traps Tab, holds the kingdom clock
(`pausesSim`), focus on the letter's title; each choice a button with its
cost and odds in words; a price the stores cannot pay is dashed, says why and
refuses; **Decide later** / Esc leave the letter waiting. The **Finds** toggle
in the top bar (a disclosure, not a screen) lists waiting letters (each
reopens its card) and the upgrades held.

### What K3a does not do

No armies seeing (K4 adds sources); captains do not explore; no event chains
or story beats (K9); `later` upgrade effects are data only.
## K3b — the city view

The layer below the kingdom map: one holding of the king's, drawn as a town
plan, where its lots are built on, its fields sown and reaped and its tax set.
`Layer = KingdomLayer | CityLayer | BattleLayer` (`src/app/layers.ts`).

### A view of the same realm

The city has no world of its own. `CityLayer` (`src/app/city-layer.ts`)
reads the kingdom's `KingdomWorld` and issues K3's orders (`build`, `sow`,
`harvest`, `setTax`) through the realm's `issueFromUi`. While it is live the
kingdom layer is **suspended** (`suspend()`): no frame loop, pen, camera or
zoom-through, its card closed, but not torn down. The city's frame calls
`realm.advance(dt)`, which is the map's own clock, ticks, autosave and HUD,
so pause, speed, the date, the stores and the alerts stay where they were.
`resume(holding)` brings the map back. No sim file changed.

### Going in and out

| In | Out |
|---|---|
| **Enter the city** on an owned holding's region card | **Esc** (after a menu, a card and a stroke have had theirs) |
| a **double tap** on the holding (two taps within 0.45 s) | **Leave the city** in the panel |
| the **wheel past the map's closest zoom** over it (`input/zoom-through.ts`: 220 wheel px build up at the limit, forgotten after 0.6 s) | the **wheel past the town's widest zoom**, or `-` held there for 0.6 s |

Another's holding is refused in words. A holding lost while inside sends you
back up, and the map says why. Entering scales the plan in from the
holding's place on the map (0.45 s); leaving cuts the map to the holding at
its closest zoom and eases out (0.45 s); both are cuts under reduced motion.

### The town plan (`src/render/city/`)

`layout.ts` is pure: `cityPlan({key, seed, biome, kind, slots, plots,
roadAngles})` → streets along the real roads out, a square (green, market or
bailey), one lot per building slot clockwise from the main street, fields
outside the core (never across the water), the ring a palisade or wall
follows, houses, trees, a river or the sea for river and coast country,
height lines for hill country, stones and heather for moor and the Reach,
hedgerows for farmland. Seeded by the holding's seed and key, so a town
looks the same each visit and no two look alike. `pickAt` hit-tests lots
(first), the square, then fields. `renderer.ts` draws it in the map-table
look with the holding's live state: a lot empty, staked (next to build),
being built (scaffold hatch and a progress bar), standing (block, glyph,
name) or idle (struck through); the enclosure once built; each field's crop
by pattern and label.

**Lot order.** The sim's `build` takes the first free slot, so a town builds
round its square in turn: the next free lot is staked, and a later free lot's
card and the build menu say which lot the building will go on.

### The UI (`src/ui/city/`)

The **city panel** (left): name, kind, province and people; Politics and
Leave buttons; every lot and field as a button (the keyboard's way to what
the plan offers the pen). The **lot card** (state, upkeep, what it does,
Build… / Build on lot N…), the **field card** (crop, stage, health, Sow…,
Harvest) and the **politics card** (people; K3's tax section with bread and
famine; loyalty, lords and laws said plainly to be not yet reckoned, K6)
are non-modal cards in the region card's frame; the build and sow menus are
K3's. The region card now shows a summary (tax, lots, fields, famine) and
the way in. Keys in the city: Esc, Space, `.`, 1 2 3, `P` politics, `F` the
whole town, the camera keys. The pen taps; a longer line does nothing in a
town and says so.

Tests: ui-check "K3b" (start/teardown leaves no listener; the realm's clock
and state kept; a lost holding leaves) and "city plans (K3b)"
(deterministic, distinct, no overlaps, picks); e2e `k3b-city-view`,
`k3b-zoom-through`, and K3's two scenarios now run through the city. Audit:
`docs/audit/u2-city-view.md` (no open P0/P1; runtime pass pending a real
browser).

## K4 — armies and recruitment

Army tokens on the kingdom map (PLAN.md §B.4, §B.5), the battle game's
rulebook carried onto the map: a squad costs what a battle says it costs,
and the battle's caps hold.

### Files

| File | What |
|---|---|
| `src/content/kingdom/armies.ts` | every army number: caps, costs, wages, rations, carry, speed, sight, hunger, pay, recovery (all provisional, docs/PROVISIONAL.md K4.x) |
| `src/content/kingdom/army-strings.ts` | the sim's refusals (`ARMY_REFUSAL`), the pen's plates (`PEN`), the card and dialogs (`AC`) |
| `src/sim/kingdom/armies.ts` | queries, `checkArmyOrder` / `applyArmyOrder` (one validation path), `marchArmies` (every tick), `runArmyDay` (once a day) |
| `src/input/kingdom-gestures.ts`, `kingdom-commander.ts` | the army vocabulary; `interpretStroke` stays the one function for ghost and order |
| `src/render/kingdom/layout.ts`, `renderer.ts` | where counters are drawn (`armyCounterAt`, `fanSlots`); how |
| `src/ui/kingdom/army-card.ts`, `recruit-menu.ts` | the army card; the levy and recruit dialogs |
| `tools/kingdom-armies.ts` | the K4 suite (in `npm test`) |
| `src/e2e/scenarios-k4.ts` | `k4-armies`, `k4-barracks-recruit` |

### The army

`Army {id, owner, name, doctrine, squads, abilities, mover, supply, morale,
captain, hunger, unpaid, arrears, posture, …}` wraps a battle `ArmyList`
(`armyList(a)`) with per-squad current strength (`ArmySquad {id, unit, men,
wounded, levy}`; `squadStrengths(a)` for K5). Armies and squads take ids
from the world's one counter and are kept in id order; at most 8 a side.
Morale is kept (K6 gives it rules). An army is a sight source (45 miles).

**The king rides with at most one army** (`king.army`): his mover copies
its mover each tick, and his march and halt orders become its. The first
army raised where he stands alone takes him in; `kingJoin` moves him.

### Raising an army

- **From nothing**: the king's followers (the levy he rallied) form a levy
  squad of spears or slingers where he stands, no barracks, coin or iron;
  at least 4 men, up to a full squad. It takes no wage.
- **At a barracks**: a standing, paid-up barracks in a holding of the
  king's raises trained squads for their men in followers, battle points ×
  4 coin, and iron by type. They draw a wage.

### Orders (appended to `KINGDOM_ORDER_KINDS`)

`recruit {at, army, unit, levy}` · `disband {army}` · `marchArmy {army, to}` ·
`haltArmy {army}` · `merge {army, into}` · `split {army, squads}` ·
`garrison {army}` · `patrol {army, holdings}` · `recover {army}` ·
`setDoctrine {army, doctrine}` · `unlockAbility {army, ability}` ·
`intercept {army, target}` (another side's army, in sight) · `kingJoin {army}`.
Every one is checked by `checkArmyOrder`, the function the card's buttons
and the pen's ghost ask, and applied at the tick boundary.

### The army day (after the economy's day)

1. **Wages**: what is owed first, then today's, from coin (`wages`); unpaid
   days are counted and the first flagged (`wagesLate`).
2. **Bread**: packs and wagons first, then the stores (at home or with the
   king, `rations`), then forage where it stands (it strips the fields and
   bumps the holding's `foraged`, K6's unrest hook). At home or with the
   king the packs are refilled (`provisions`).
3. **Hunger** past 2 days: desertion, death (wounded first) and sickness at
   per-mille rates with stored remainders, so losses are exact and need no
   random draw. **Unpaid** past 3 days: trained men desert.
4. **Recovery** while resting in a town of yours (faster with a hall, or with
   healers anywhere) mends the wounded; at a barracks, gaps are refilled
   from the followers and iron (`recruitment`).
5. An army with no men left is gone (`armyGone`: starved / deserted).

The king's unformed followers also walk home from a hungry party (K4.5).

### The proof: "recruit → march → starve" (tools/kingdom-armies.ts)

The first army is raised at Cold Hearth and marched alone to Rookstead with
what its packs hold. It eats them empty, goes hungry, loses no one in the
grace, then loses men to desertion, death and sickness every day until it
has starved away -- the same men on the same days on every run, and on
another seed too; the same army kept by full stores is not short (two weeks; loose grain spoils).

### The pen (§B.5)

| Stroke | Order |
|---|---|
| line from an army (or the king) to a holding | march |
| line from a counter to another side's army | intercept |
| line from one army of yours to another | merge (from the king: he rides with it) |
| line across an army of yours, starting on no counter | split (the later half of its squads) |
| ring round its holding, or round the army alone | garrison |
| large ring round two or more holdings | patrol, in the order the ring passed them |
| heart on an army | recover |
| tap | the army's card |

Closed strokes are read before anyone is grabbed; their subject is the army
the ring starts on, else the one army of yours it encloses. A stroke the sim
would refuse shows "no order: <the sim's reason>". The kingdom matrix
(`tools/gesture-corpus.ts` army scene: two armies fanned under the king, one
at Greyshaw, one of yours beside another side's at Fell End, at three zooms)
stays diagonal; the battle matrix is untouched (`hullFill` is only exported).

### Save format version 4

Adds the armies, `king.army`, each holding's `foraged`, and the three new
ledger categories (`provisions`, `disbanded`, `favours`) on every page.
`migrate3to4` fills them empty; v2 → v3 now re-lays pages to K3's own width.
Every army field is validated on load (ids, caps, men ≤ a full squad,
wounded ≤ men, the king's army standing where he is, garrisons).

### Determinism and the golden

The kingdom golden moved (884fd624 → c4706524): the hash now covers army
state, `king.army` and `foraged`, and K4.5 (followers leaving a hungry
party) changes the decade's levy. The battle tiers did not move.

### UI

Counters (shield and numeral for yours, diamond and initial for another
side's, crown tick on the king's army, posture badge, men and days of grain
in words, a strength bar), the live route of each marching army, the army
card with every pen verb as a button, "Raise followers…" on the king card,
"Raise squads…" on a barracks lot in the city, and the armies' daily coin
and grain on the resources bar. Audit: docs/audit/u2-army-panels.md.

### What K4 does not do

Battles when armies meet (K5: `intercepted` is the hook); morale rules and
unrest from foraging (K6); captains' armies moving on their own (K8).

## K5 — descent: armies meet, and a battle is fought

When two hostile armies meet on the map, the realm stops and the king is asked
what to do; a battle fought below comes back up as a result the kingdom
applies (PLAN.md §B.9). Every number is provisional (docs/PROVISIONAL.md
K5.1–K5.18).

### Files

| File | What |
|---|---|
| `src/content/kingdom/descent.ts` | the numbers: engagement radius, withdrawal cost, militia, nerve mapping, `AUTORESOLVE`, commanders and difficulty by faction, `OPENING_HOSTS` |
| `src/content/kingdom/descent-strings.ts` | the sim's refusals (`DESCENT_REFUSAL`), the interstitial (`CONTACT`), the report's realm lines and the leave confirm (`DESCENT`), the feed (`CONTACT_FEED`) |
| `src/sim/layers.ts` | `BattleSpec`, `BattleResult` and their hashes; `layerHash` |
| `src/sim/kingdom/descent.ts` | contact detection, `buildBattleSpec`, `resultFromBattle`, `applyBattleResult`, withdrawal and fall-back, the `resolveContact` order |
| `src/sim/kingdom/autoresolve.ts` | "Resolve for me" |
| `src/app/battle-config.ts` | `battleFromSpec` (the battle a spec is fought as), `battleWorld` (spawning, shared with the battle layer) |
| `src/ui/kingdom/contact-dialog.ts`, `consequences.ts` | the interstitial; the report's "What it means for the realm" |
| `tools/kingdom-descent.ts` | the K5 suite and the proof (in `npm test`) |
| `src/e2e/scenarios-k5.ts` | `k5-descent-fight`, `k5-descent-withdraw`, `k5-descent-resolve` |

### Contact

After the armies march each tick, `detectContacts` looks at every pair of
hostile armies (K5.1) in id order. A pair is **engaged** when they stand at
one holding; are on one road within `ENGAGE_RADIUS` miles of each other;
are on two roads meeting at a holding with their distances to it summing to
no more than that; or one is intercepting the other and they are in contact.
An army that reaches a hostile **walled** holding with none of the owner's
armies there stops at the gate and **assaults** it: the townsmen defend
(K5.5). Both armies halt. A contact names its holding (K5.3), the road
(0 at a holding), the attacker (the one that marched into the other) and
both sides `{faction, army}`, the king's side first.

A contact with the king's side **holds the realm**: `world.contact` is set and
from the next tick `tick()` does nothing but apply due orders, in canonical
order, until one settles it; `now` does not advance, so no grain is eaten and
no army moves while the king decides. There is at most one (K5.15). Orders
naming an army in contact are refused (`inContact`), the king's own march
included when he rides with it (K5.18). A contact between two armies of the
crown's (none yet, K5.1) is resolved on the spot, on the `autoresolve` stream.
A pair that has settled a contact is kept in `world.disengaged` until they
stand apart, so they do not meet again on the next tick.

### The order: `resolveContact {contact, choice, result}`

| Choice | What happens |
|---|---|
| `fight` | `result` must be the `BattleResult` of the battle fought for this contact's spec; refused otherwise (`resultRefusal`: wrong contact, more survivors than went in, a squad that was not there, a winner that is not a side) |
| `withdraw` | the king's army leaves a rearguard and loses morale (K5.7) and falls back; refused when cut off, and when the king's side is townsmen behind their own walls |
| `auto` | the battle is resolved without the player (below) |

### The handoff

`buildBattleSpec(world, contact)` is pure: the same world and contact build
the same spec, which `hashBattleSpec` covers whole. It carries the ground
(level, biome, holding, road, fortification), the seed (the holding's, K5.3),
both sides (name, commander and difficulty, doctrine, per-squad men and
wounded, morale), the deployment (who attacks; whether the defender is dug
in), the victory rule (rout in the field; the defender survives behind
walls), duration, weather, season, night and reinforcements (none, K5.9).

The battle side takes a spec through `battleFromSpec`: a derived level with
no control points, flood or siege, and each squad spawned with its fit men
only (a squad of 0 fields nobody) at the nerve its morale gives (K5.4);
`battleWorld` returns which soldiers each squad became (`FieldedSquad`).
`resultFromBattle(spec, world, fielded, leftBy)` counts them back: the
living, the wounded (below half health), the winner, and whether a side left
the field. `applyBattleResult` then writes survivors back squad by squad
(never more than went in; the wounded among them kept), sets morale, moves
legitimacy (+2 a win, −1 a loss), sends the side that fled back along a road
away from the enemy, or has it **captured** if there is none; an army with no
one left **fell**. Walls stormed change hands. Zero survivors and full
survivors are both tested boundaries.

`layerHash(kingdomHash, battleHash?)` is the one hash of the whole game: the
kingdom alone on the map, the kingdom and the battle together while one is
fought, so a drift is caught in whichever layer it started
(`driftedLayer`).

### Resolve for me

`autoResolve(spec, rng, forPlayer)` draws exactly two numbers from the
`autoresolve` stream, whatever the spec, so a resolve never shifts another
draw. The definition of **strictly worse in expectation** (K5.11): on the same
two draws, the resolve for the king's side (under a sergeant) is never better
than the even-handed resolve of the same battle, in winner or in fit men
brought home, and over many seeds it wins less often and brings fewer men
home. The suite checks all three over 400 seeds.

### Player experience

1. The army meets the enemy; the clock pauses (and stays paused after,
   K5.8); the interstitial opens: "Riders on the Harrowfield road", both
   sides in words (men, fit, morale, walls, dug in), and three choices, each
   saying what it costs. Withdraw, when cut off, says why and stays in the
   Tab ring. Esc does nothing (K5.14).
2. **Fight** goes down a layer into the battle the spec builds. The army is
   already deployed; deployment is a confirm. Leaving mid-fight asks first
   and counts as a withdrawal under fire (K5.6).
3. **Withdraw** and **Resolve for me** settle at once; the feed says how.
4. After a battle, the after-action report adds "What it means for the
   realm" (survivors, an army lost, a fall-back, walls taken, legitimacy,
   morale), and "Back to the map" comes up to the realm, its camera eased
   out from where the armies met (a cut under reduced motion).

A contact met while the player is in a city opens when they come back up
(K5.16). The game is saved as the interstitial opens, so a reload asks again.

### Save format version 5

Adds `hosts` (K5.13), the waiting `contact` and `disengaged`. Every contact
field is validated on load (id below the counter, both sides' armies there
and hostile, the king's side first, kind and army consistent). `migrate4to5`
sets no contact, no pairs and `hosts: false`, adding no army, so a v4 log
replays exactly. `replayLog` keeps applying held ticks while a contact waits
and orders remain.

### Determinism and the golden

No golden moved. The contact and the disengaged pairs are mixed into
`kingdomHash` only when not empty, and headless worlds have no hosts unless
asked (`hosts: true`), so the K1–K4 decade and every battle tier hash as
before. `spawnSoldier` takes a nerve that defaults to 1.

### The proof (tools/kingdom-descent.ts)

"march → contact → battle → survivors home": the king's army marches from
Rookstead on Harrowfield, meets the Hare's riders, the battle its spec
builds is fought out headless with both sides under the AI, the result is
applied and the realm runs a day. Run twice, the spec hash, the result hash
and the layer hashes before and after all agree.

### What K5 does not do

Captains' armies that move and choose battles (K8); reinforcements from
nearby armies (K5.9); damage to crops and buildings (K5.17); morale rules
beyond a battle's (K6).

## K6 — morale, unrest and legitimacy

The three morale systems of PLAN.md §B.6, nested: an army's morale, a town's
unrest, the realm's legitimacy -- and the realm's Mercy/Terror (§A.4), which
touches the first two. Every number is provisional (docs/PROVISIONAL.md
K6.1–K6.12).

### Files

| File | What |
|---|---|
| `src/content/kingdom/morale.ts` | the tables: unrest's scale, bands and thresholds, every cause's pressure, justice, festivals, pardons, the muster, a lost battle, revolts, army morale, the season's legitimacy; `validateMorale` |
| `src/content/kingdom/morale-strings.ts` | the refusals (`MORALE_REFUSAL`), the politics card (`P`, cause labels, justice names), the HUD (`MERCY`), the army card (`MORALE_WORDS`), the feed (`MORALE_FEED`) |
| `src/sim/kingdom/morale.ts` | `unrestCauses` (the one list), `runMoraleDay`, revolts, army morale, `changeMercy`, `battleLostUnrest`, the three politics orders |
| `src/sim/kingdom/unrest.ts` | `moveUnrest`, the one writer of a town's unrest (so the muster and foraging can stir a town without importing the morale rules) |
| `src/ui/city/politics.ts` | the politics card's K6 section |
| `tools/kingdom-morale.ts` | the K6 suite and the proof (in `npm test`) |
| `src/e2e/scenarios-k6.ts` | `k6-politics-levers` |

### State

`Holding` gains `unrest` (permille 0..1000), `justice` (`none | courts |
rope`), `festival` (days left) and `pardoned` (1 + the absolute season of
the last pardon, 0 never). `FactionEconomy` gains `mercy` (−100..100; not a
ledger stock: no flows, no day's change). Army morale is K4's `morale`
field, 0..100, now moved.

### The day

`runMoraleDay` runs on a day's first tick after the economy's day and the
armies' day, so it reads today's famine, wages and bread. For each
economy-run faction (K6.11), in id order:

1. every town it owns: the courts are paid if they sit (ledger `justice`),
   then `unrestCauses` is summed and applied; a festival counts down;
2. at a season's turn: legitimacy from shrines and halls (capped, `deeds`),
   and the rope's terror;
3. every army's morale (below), the men low spirits cost, and armies with
   nobody left removed (`deserted`);
4. revolts: every town at or above `REVOLT_AT`.

Outside that day: `collectTaxes` halves a restless town's taxes; the
season's muster (`turnSeason`) and an army foraging (`runArmyDay`) stir a
town through `moveUnrest`; `claimHolding` sets a new town's unrest to 10,
walls stormed to 30; `applyBattleResult` stirs the province of a battle the
king's side lost (`battleLostUnrest`) and lifts the winner's morale.

### One list

`unrestCauses(world, h)` returns every cause moving the town today, with its
pressure in permille, in `UNREST_CAUSE_IDS` order: taxes, famine,
quartering, the king's standing, custom, shrines, a hall, justice, a
festival, mercy. The day applies its sum; the politics card lists its rows
and its trend (`unrestTrend`). So the card never lists a cause the sim does
not apply. The happenings (foraging, the muster, a battle, a pardon) move
unrest when they happen and are not on the list; the card says how many days
armies have foraged there this season.

### Army morale and the battle

Hungry −4 a day, unpaid −3; fed and paid it moves a point a day toward its
rest level (`armyRestMorale`: 55, +15 with the king, + legitimacy/10, +
terror/20). Below 20, 3% of its fit men desert a day. This is the morale
`buildBattleSpec` gives a side, and K5's `nerveFromMorale` turns it into
every soldier's starting nerve: a hungry, unpaid army fights shaken. A
victory adds 8 on top of what the field left; K5's withdrawal already costs
10.

### Orders

| Order | Check (one function for the button and the tick) |
|---|---|
| `setJustice {holding, justice}` | the king's town; a known justice; not the one it has |
| `holdFestival {holding}` | the king's town; none running; the stores can pay `festivalCost` |
| `pardon {holding}` | the king's town; not yet this season; it has unrest to pardon |

Taxes are K3's `setTax`; shrines and halls are K3's `build`.

### Revolt

A town at the threshold becomes nobody's; its garrison is cleared; one in ten
of its people (up to two squads of levy spears) stands in it as a rebel host
of its old lord's banner from the map, or the Chancellor's (`rebelFaction`);
too few, or the crown at its army cap, and it only flips. Legitimacy −3
(`disgrace`). No random draw anywhere in K6.

### Player experience

The city's politics card (P) shows loyalty and unrest in words and numbers,
the thresholds, today's trend and each cause raising or calming it; K3's tax;
justice as a toggle group; Hold a festival and Pardon the prisoners, each
marked unavailable with its reason and saying why when pressed; shrines and
halls standing. The HUD's top bar shows Mercy (or Terror) beside the stocks.
The army card's morale line says where it is heading. The feed says when a
town changes band, revolts, a festival ends, or an army's men start to slip
away.

### Save format version 6

Adds the four holding fields and `mercy`; the ledger gains two sink
categories (`festivals`, `justice`), so pages are re-laid. `migrate5to6`
makes every town calm with no justice, festival or pardon, and mercy 0
(K6.12). Unrest and mercy are bounds-checked on load; a justice must be
known, in the snapshot and in every logged order.

### Determinism and the golden

The kingdom golden moved (`c4706524` → `c3917824`): `kingdomHash` now mixes
the four holding fields and mercy. The decade's own play is unchanged (it
holds no town), so only the hash's input grew. The battle tiers did not
move.

### The proof (tools/kingdom-morale.ts)

Monotonicity, a test per input: the same town twice, a day apart, differing
in ONE input -- each tax rate, famine, an army quartered unpaid, the king's
standing, a shrine, a hall, courts paid and unpaid, the rope, mercy, terror,
foraging -- and the town's unrest moves the way the cause's row says, by
exactly its row, and nothing else K6 owns moves but what the row declares
(its coin, its grain). Then the levers as orders, the thresholds, army
morale and desertion, the battle's starting morale both ways, save v6 and
the v5 migration, and the ledger balancing with festivals and justices on it.

## K7 — mercenaries

Free companies (PLAN.md §B.7): the tavern as their source, the contract,
price and loyalty, the crown's poaching, and betrayal. The companies
themselves are the story's table (`src/content/story/mercenaries.ts`, seven
of them); K7 writes the rules of their life with the king. Every number is
provisional (docs/PROVISIONAL.md K7.1–K7.12).

```
waiting -> offered (a king's tavern, 20 days) -> hired -> renewed | expired | deserted | defected | poached | dismissed | broken
             \-> moved on (away 30 days) -> waiting
```

### Files

| File | What |
|---|---|
| `src/content/kingdom/mercenaries.ts` | the lifecycle's rules: offer and absence days, the act gate, renewal window and fee, loyalty's daily moves, how each reputation leaves, poaching, the bloody company's unrest; `validateMercenaryRules` |
| `src/content/kingdom/mercenary-strings.ts` | refusals (`MERC_REFUSAL`), the market (`MARKET`), the army card (`CONTRACT`), the feed (`MERC_FEED`) |
| `src/sim/kingdom/mercenaries.ts` | `runMercenaryDay`, the three orders (`hireCompany`, `renewContract`, `matchBid`), dismissal, betrayal (`turnCoat`), the queries the UI reads |
| `src/ui/kingdom/mercenary-menu.ts` | the market: a choice menu from the tavern's lot |
| `tools/kingdom-mercenaries.ts` | the K7 suite and the proof (in `npm test`) |
| `src/e2e/scenarios-k7.ts` | `k7-tavern-hire` |

### State

`world.companies`: one `Company` per row of the table, in its order --
`state`, `at` (the tavern, offered), `days` (offer, contract or absence),
`loyalty`, `army`, the crown's `bid` and `bidDays`. `Army` gains `company`
(1 + the table index, 0 for the faction's own men), and its `owner` is no
longer read-only: a company that turns goes over whole.

### The day

After K6's morale day, so loyalty reads today's pay: every hired company's
loyalty moves (+1 paid, −8 owed); at 0 it leaves by reputation; a bloody
company stirs the town it stands in; a standing bid counts down, or a new
one is made on the season's bid days; the contract counts down (word at 15
days left, gone at 0). Offers and absences count down; free taverns take
the next company free to come. No dice anywhere.

### Hiring and the army

The fee is paid (`hiring`), and `raiseArmy` puts the company on the map at
the tavern, whole and trained, named for itself, led by its captain. It is
paid the contract's wage through K4's army day; K4's unpaid trickle and
barracks replacements do not apply (§B.7: no replacement pipeline). It keeps
its own ranks: no merge, split or recruits. Disbanding is dismissal.

### Betrayal

A bloody or turncoat company whose loyalty is spent, or one the crown has
poached, changes `owner` where it stands: out of the garrison, out from
under the king, its arrears forgotten. If the king's own army stands with
it, K5's `detectContacts` finds the two face to face that same tick and the
realm halts for the battle; if it stands alone in a walled town of the
king's, the town is assaulted.

### Player experience

The feed says when a company comes to a tavern, moves on, nears the end of
its contract, is bid for, and leaves (each way in its own words). In a city,
a tavern's lot offers **Free companies…**: the market lists who drinks
there, with fee, wage, contract, men, reputation, loyalty and a line about
them; a hire the sim would refuse stays listed and says why. A company's army
card shows its contract, loyalty and any bid, with **Renew** (in the window),
**Match the bid** and **Dismiss**; split and merge are not offered. Its
counter carries its initial. Audit: docs/audit/u2-mercenary-market.md.

### Save format version 7

Adds `companies` and every army's `company`; the ledger gains one sink
(`hiring`), so pages are re-laid. `migrate6to7` makes every company waiting
(K7.12). On load a hired company's army must be the king's army of that
company, and no king's army may be a company's that does not serve.

### Determinism and the golden

The kingdom golden moved (`c3917824` → `de3d690f`): `kingdomHash` now mixes
the companies and `army.company`, and the ledger page is one category wider.
The decade's own play is unchanged (it builds no tavern, so no company ever
comes). The battle tiers did not move.

### The proof (tools/kingdom-mercenaries.ts)

The lifecycle, step by step against its rule: offers (tavern, act gate,
moving on, coming back, a tavern lost), hire (fee, a whole company, no
levy, one check for the button and the tick), paid upkeep (the contract's
wage, loyalty rising, its own ranks, no replacements), contract end
(renewal window and fee, refused with arrears; expiry), unpaid (loyalty
falling; reliable desert, turncoats defect), poaching (bid, matched,
unmatched), a bloody company's unrest, dismissal and a broken company. Then
THE BETRAYAL SCENARIO: turncoats hired beside the king's First Army in Fell
End go unpaid and turn; the same morning the realm halts on a field contact,
the king's army against the company it paid; the same on every run, and a
save on the contact loads as the same realm. Save v7 and the v6 migration,
tampering refused, the log replaying, and the ledger balancing every day.

## K8 — enemy kingdom AI and invasions

The rival lords play the realm (PLAN.md §B.8): one strategic mind per
faction with a persona (the usurper, the Margrave and the eight captains),
under the king's own rules, and invasions of the king's holdings, both
scheduled (the story's three waves) and emergent (a thin garrison invites a
raid), heard of as rumours as far ahead as his watchtowers and scouts
allow, and answered with the defence tools. Every number is provisional
(docs/PROVISIONAL.md K8.1–K8.22).

```
day start: weather, economy, armies, morale, companies, sight, invasion day
        -> runAi (each persona faction: remember, perceive, decide -> seq-0 orders)
        -> drain orders (the king's and the captains', one queue, one check)
        -> updateRumours (captains realms)
every tick: march, chase, detectContacts, seizeUndefended (captains realms)
```

### Files

| File | What |
|---|---|
| `src/content/kingdom/invasions.ts` | the captains' start (`CAPTAIN_START`, seat works and garrison, `FIELD_HOSTS`), the AI's temperament (`AI`), `INVASION_WAVES` and `WAVE_DAYS`, `WARNING`, the defence tools (`LEVY_CALL`, `BURN_FIELDS`, `WALL_NERVE`, `AMBUSHED_NERVE`, `KEEP_RETREAT`, `YIELD_LEGITIMACY`), `SEIZED_UNREST` |
| `src/content/kingdom/invasion-strings.ts` | refusals (`INVASION_REFUSAL`), the rumour card (`RUMOUR`), the defender's choices (`DEFEND`), the feed (`INVASION_FEED`) |
| `src/sim/kingdom/ai.ts` | `remember`, `perceive`, `decide`, `runAi`: the strategic AI |
| `src/sim/kingdom/invasions.ts` | the captains' setup (`setupCaptains`), warning and rumours (`warningDays`, `threatOf`, `updateRumours`), the three orders (`callLevy`, `burnFields`, `ambush`), burned land, `seizeUndefended` |
| `src/ui/kingdom/rumour-card.ts` | the rumour card |
| `tools/kingdom-ai.ts` | the K8 suite and the proof (in `npm test`) |
| `src/e2e/scenarios-k8.ts` | `k8-rumour-levy` |

### State

`KingdomConfig.captains` (saved): off for every realm K1–K7 made and for the
tests' bare worlds; a new game turns it on (app.ts). A captains realm gives
each persona faction stores, a seat with barracks, palisade and granary, a
seat garrison and a field host (`setupCaptains`), and runs its economy
(`economyActive`: the king, and persona factions when there are captains).
Crown towns pay the crown a grain tithe; only the king draws the dole.

`world.minds` (`AiMind`: goal, target, since, wave, the army its lord rides
with), `world.intel` (`FactionIntel`: per holding, owner, men, walls and
the day last seen), `world.waves` (which story waves have ridden),
`world.rumours`, `world.burned`, `world.levied`. A twelfth faction is
appended: **the commons** (no persona, not of the crown), the banner a crown
town raises when it throws off its captain (K6's revolt in a captains
realm), so a captain must come and put it down -- the AI-against-AI fight.
`ArmyPosture` appends `ambush`; `CONTACT_CHOICES` appends `yield`, `keep`.

### The AI contract

- **Same orders, same queue.** `decide` returns ordinary `KingdomOrderBody`s
  (`marchArmy`, `haltArmy`, `garrison`, `recruit`, `disband`, `intercept`,
  `claimHolding`, ...). `runAi` checks each with `world.check(body, f)` and
  submits it to the one queue; `applyOrder` applies it as it does the king's.
  Wages, bread, recruiting costs, hunger and the army cap bind it as they
  bind him. A refused order is dropped.
- **Its own stream.** Every draw is on `kingdomAi`; no other stream moves.
- **It acts only on what it has seen.** `remember` writes to a faction's
  `FactionIntel` only what its sight shows today (explore knowledge 2), and
  owner-only news of its own holdings (a lord hears when a town of his
  revolts or falls). `perceive` builds a plain-data `Perception` from that
  memory, the hostile armies it can see now (`armyVisible`: an ambush is
  hidden from all but an army in the same holding), its own armies, holdings
  and stores, and the static map. `decide` is a pure function of the
  Perception, the mind, the places and the rng: it never holds the world.
  A chase (`intercept`) also follows only what the chaser can still see.
- **Replay.** The AI runs inside the tick from sim state and its stream, so
  its orders are stamped `seq` 0 and never logged; a replay of the king's
  log regenerates them.
- **Test hook.** `world.onAi(faction, perception, orders)` is called each
  day for each persona faction (null outside tests): the suite audits every
  order against what the faction saw.

Goals, weighed every `AI.goalDays` with jitter and hysteresis from the
persona's bias and boldness: **consolidate** (stay home, retake what was
lost, recruit when fed), **raid** (an open town of the king's), **besiege**
(a walled one), **snipe** (a weak hostile army in sight), **explore** (send
scouts to holdings it does not know). No captain moves on the king before
`AI.graceDays`. A wave (`INVASION_WAVES`) makes the king the goal of one
faction from its day for `WAVE_DAYS`, against the nearest town it knows
of that its field host can take (men against what it remembers standing
there, with `AI.margin`); a garrison it cannot beat ends the wave
(repelled). The lord rides with his host and its stores ride with it.
Hungry armies go home; scouts ride only with bread for the way back.

### Invasions and the defence

- **Warning.** `warningDays(target)` = 1 + 2 per standing watchtower of the
  king's within 80 miles + 1 per fit scout of his within 60, at most 7. A
  host riding at a town of his raises a rumour the morning it falls within
  that many days, or comes into his sight (`updateRumours`); the event is
  `rumour`, and the card says "Riders seen on the X road, N days out".
- **Taken without a battle.** A hostile army standing in a holding with no
  garrison and no army of its lord's takes it (`seizeUndefended`, unrest
  set high).
- **Defence battle.** A garrison or walls means K5's assault contact; a
  wall's nerve (`WALL_NERVE`) steadies the defenders (`fieldNerve`).
- **AI against AI.** Every contact without the king's side is auto-resolved
  by K5 on the spot.
- **The tools.** Garrison (K4); **Call the levy** (`callLevy`: a holding's
  people turned out as raw levy squads, one per 8 people up to 3 squads,
  unrest, 30 days before it can be called again); **Burn the fields**
  (`burnFields`: what is in the ground spoils, no army forages there for 30
  days, unrest); **Lay an ambush** (`ambush`: a halted army in a holding
  lies hidden and an attacker who walks in is caught -- K5's ambush
  deployment and `AMBUSHED_NERVE`); walls; and at an assault on townsmen
  alone, **Open the gates** (`yield`, legitimacy −3) or **Retreat to the
  keep** (`keep`: needs a wall or keep; the town is sacked and the siege
  auto-resolved -- the real siege is K10).

### Player experience

A rumour opens the rumour card: modal, the clock held, focus on its title;
it names the road, days out, the faction and the town, the host's strength
only if the king's men can see it, and how he heard. Its tools (levy, burn,
ambush with an army standing there, march the nearest army to defend) are
one Tab apart, each with what it does; a tool that cannot be used stays in
the ring with the reason. "Let it come" and Esc close it. The region card
of a town of the king's offers Call the levy and Burn the fields; the army
card offers Lay an ambush; the contact dialog offers Open the gates and
Retreat to the keep at the king's own walls. The feed says each rumour,
levy, burning, seizure, yielding, siege and wave. Text lives in
invasion-strings.ts. Audit: docs/audit/k8-ai-invasions.md.

### Save format version 8

Adds `captains` and `snapshot.k8` (minds, intel, waves, rumours, burned,
levied) and the commons' economy and exploration entries; validated on load
(minds per faction, intel per holding, a rider that is one of the faction's
own armies, targets that exist). `migrate7to8` gives a K7 realm no captains,
idle minds, no memory, no rumour, burned land or levy call, and the commons'
entries: empty stores, ledger pages of the king's days, the map known.

### Determinism and the golden

The kingdom golden moved (`de3d690f` → `51e0098e`): every realm now has the
commons faction, whose economy and exploration entries are hashed. The
decade runs without captains, so its play is unchanged; the K8 block is
mixed only with captains or once a defence tool is used. The battle tiers
did not move (`fieldNerve` is 0 without walls).

### The proof (tools/kingdom-ai.ts)

The content table; the captains' start; **no cheating** -- every order of
every persona faction over a 360-day run on two seeds is audited as it is
decided against that day's Perception (memory changes only where it saw
today), and a world changed only where a faction cannot see leaves its
Perception and orders unchanged (with a control, and an ambush hidden at
Linnet Cross); a **five-year AI-against-AI soak** on three seeds (ledger
balanced daily, no NaN, no negative stock, no stuck army, the same hash
twice, the log replaying, every wave ridden, the factions still fielding
armies); a revolt put down by its captain through K5's auto-resolve; the
**three waves**, each LOST undefended (taken without a battle) and REPELLED
garrisoned, and a thin garrison fought; rumours against `warningDays`
(towers, scouts, the cap, never before it is due); each defence tool; save
v8, the v7 migration (to the same hash) and tampering refused.

## ECON — a real year, a real granary, fields that farm themselves

The owner's four steers (PLAN.md, amendment 7): a twelve-month year; a granary
that really stores food the king can use, and no crop dying without a reason;
fields reaped by themselves and resown by the king's say-so; and resources far
easier to manage. Choices are `ECON.n` in docs/PROVISIONAL.md.

### The calendar
Twelve months of thirty days (Thawmoon, Seedmoon, Blossommoon — spring;
Sunmoon, Haymoon, Reapmoon — summer; Harvestmoon, Leafmoon, Mistmoon —
autumn; Frostmoon, Snowmoon, Wolfmoon — winter). Everything keyed to the old
120-day year is rescaled by three: crop growing and ripe days, the AI's grace
(300 days) and the invasion waves (days 360, 600, 840), the story letters'
days, the mercenaries' poaching days. Things measured in plain days (a march,
a contract, hunger and wage graces) keep their day counts.

### The granary and the stores
Grain is one realm pool per faction (`grainStores()`: granary, loose, heap,
capacity, spoiling today). A granary holds 1500 and never rots it; a holding's
own cellars hold more than before (hamlet 1500 … city 7200) and lose 1‰ a
day; only grain past all storage (the heap) rots, 1% a day. Once the king holds
a town his own barns add 1500 of granary room (`KING_BARNS`). The resources bar
says how much is stored, of how much, how many days it lasts, and warns before
winter if it will not last; each stock's tooltip lists the day's sources and
sinks from the ledger. Nothing leaves the stores without a ledger entry.

### Crops: no random death
Farm weather is gone: no draw decides a field's fate (one weather draw a day
is still taken, so the weather stream is unchanged for everything else). A
crop is lost only to winter (a tender crop still standing), an army foraging
or a battle trampling it, burning, or standing ripe too long — and the field
card says which ("Last lost"). A sowing that could not ripen before winter is
refused (`REFUSAL.tooLate`), and the sow menu says when each crop would ripen.

### Auto-harvest and auto-resow
A ripe field is reaped the day it ripens, into the stores (`autoReaped`),
always, for every lord whose economy runs. Each field may resow a crop by
itself in its season (`FieldPlot.auto`), paying its seed from the stores; the
city panel's "Resow all fields automatically" switch sets every field of the
realm at once (`setAutoSow {holding: 0, plot: 0, crop}`, appended to the
orders), and the field card's "Resow automatically…" sets one. The card says
why an auto-sown field waits (out of season, too late to ripen, no seed…).
Sowing by hand still works. A new game starts with the switch on, sowing rye
(`KingdomConfig.autoFarm`); an old save loads with it off.

### Easier numbers
The first holding brings 2000 grain, 30 coin and 20 timber, plus 8 grain a
head claimed; yields are scaled to the longer year; the winter dole is
smaller and famine takes 1% of the people a day, not 2%; the king's party carries three times as much; trained squads cost a third of their old daily wage; hunger and
unpaid graces are longer. With `node tools/kingdom-balance.ts 2 1` (two years,
seed 1) a passive king who claims Cold Hearth and does nothing else ends with
0 hungry days and 2728 grain (before: 235 hungry days, 49 of famine, the
holding lost); a careful player ends with 7599 grain and 1438 coin.

### Save format version 9
Adds `epoch`, `autoFarm`, each plot's `auto` and `lost`, and each economy's
`autoSow`. `migrate8to9` gives an old save an epoch that keeps its date's year,
season and share of the season, triples the days counted on growing and ripe
plots, and leaves auto-resow off. tools/fixtures/kingdom-save-v8.json is a
real v8 save; the economy suite loads it.

### Determinism and the golden
The kingdom golden is now ten 360-day years (28800 ticks, `bf9431cc`): the
year, the crops and the economy changed. The battle goldens did not move.

### The proof
tools/kingdom-economy.ts (164 checks) has "two years, passive and active",
"no random death" and "migration v8 -> v9"; src/e2e/scenarios-econ.ts
(`econ-auto-farm`) turns the switch on in a city with real clicks and keys,
runs at 4x through the turn of summer, and sees the wheat reaped into the
stores, the field resown with rye in autumn and a twelve-month date on the HUD.

## K9 — the story, its opening and its tutorial

The owner: "There should be no more battle/campaign. ONLY the storyline
gameplay"; the king "has nothing, to ruling"; "The game should also start with
a storyline animation/cutscene and then a tutorial to teach ALL gestures
controls". K9 runs the story in the kingdom sim and puts the opening in front
of it. Choices are in docs/PROVISIONAL.md K9s.1–9 and K9.1–22.

### The story in the sim (`sim/kingdom/story.ts`, `content/story/`)
- Off unless `KingdomConfig.story` (K9.1); a new campaign sets it. Every older
  suite and the kingdom golden keep their realm byte for byte.
- **Acts by state.** Four acts; an act ends the day all its goals hold against
  the realm (K9.2). `actBegan` is the event.
- **Letters as orders.** 53 letters, each sent once when its trigger first
  holds (daily, table order); `letterArrived`. The player answers with the
  order `answerLetter {letter, choice}` -- checked, logged, hashed, saved --
  whose effects go through the sim's own paths (ledger, morale, mercenaries,
  armies). A gamble rolls once on the events stream; no other story code rolls.
  Forks are letters whose choices set flags later triggers read.
- **Encounters.** The Marchwarden chapters re-cast as 13 scripted battles: a
  `battle` effect stands a host at the encounter's holding; a contact with it
  is fought on the encounter's level under its captain (K9.4). The capital
  siege is an assault on fixed walls (K9.8, the plan's named scope cut).
- **The chronicle** is written from the tick's events at its end, as a ledger
  (K9.10). **Endings**: Restored King, Iron Crown, Hollow Crown (Legitimacy ×
  Mercy the day the crown is taken), The Chronicle Closes (the king lost, or
  the capital another's for 30 days, K9.6); `storyEnded`, and the realm holds.
- **Save version 10**: `story` (null for every v9 save, `migrate9to10`, K9.12).

### The opening (`app/app.ts`, `ui/story/`)
1. **The cutscene** (`ui/story/cutscene.ts`, art in `render/story/`): twelve
   beats of Brother Aldous over the realm's map. Skip (the primary button) and
   Esc end it at any beat; Next, any other key or a tap go on a beat; a beat
   moves on by itself no sooner than it can be read (K9.16). Narration is DOM
   text at 1.25rem in a live region (15.6:1); reduced motion cuts the camera.
2. **The tutorial** (`content/story/tutorial.ts`, runner `ui/story/coach.ts`):
   69 steps in four lessons -- the map, the town, the drill, armies on the map
   -- in a practice realm that is never saved (K9.11; `sim/kingdom/tutorial.ts`
   sets each lesson up). Every step waits for the real control: the layers
   emit `TutorialSignal`s (`ui/story/signals.ts`) only when the control did its
   thing -- a stroke the pen accepted, an order the world allowed, a camera that
   moved -- and camera, key and time signals count only on the step's own
   layer. Each step shows what to draw, a hint after 12 s, "Skip this step" and
   "Skip the tutorial" (asks first). Fight in the armies lesson ends it (K9.19).
3. **The king's own realm** begins at day one, story running.

Continue goes straight to the saved realm. Home has no "Learn the gestures"
(K9.14); the map's **Menu** (Back to the realm · Read the chronicle · Replay
the tutorial · Save and go to the front screen) replays the tutorial in a
fresh practice realm and returns to the realm as it was.

### On the map
The top bar gains a story group: **Letters** (only while one waits),
**Chronicle**, **Menu**. A letter opens by itself (K9.7) as a modal card that
holds the clock: who wrote, the letter, each answer with its cost, battle or
chance, a refused answer saying why; "Decide later". The chronicle screen
shows what the act asks and the book so far. An ending pushes the end screen
(title, epilogue for this realm, days and holdings; Read the chronicle, Back to
the front screen, Begin a new exile behind a confirm, K9.22).

### Screen contracts
| Screen | First focus | Traps | Holds the clock | Esc |
|---|---|---|---|---|
| `story-cutscene` (full) | Next | yes | yes | skips the film |
| coach (not a screen) | -- | no | no | -- (Esc in the practice realm or drill asks to skip) |
| `story-letter` (overlay) | title | yes | yes | decide later |
| `story-chronicle` (overlay) | title | yes | yes | close |
| `story-menu` (overlay) | Back to the realm | yes | yes | close |
| `story-end` (full) | title | yes | yes | front screen |

### Testing
`AppEnv.skipOpening` is the documented test path (K9.13): the harness's
`boot()` opens a new exile straight on the map with no story, as K8 did, so
the K2–K8 scenarios are unchanged; `boot({ opening: true })` is the real flow.

### The proof
- `tools/story-check.ts` (98 checks): content, the lesson realm (deterministic,
  idempotent, every lesson's set-up), the coach's matcher.
- `tools/story-playthrough.ts` (33 checks): four scripted runs through
  `world.issue`, one per ending, replayed from their logs and round-tripped
  through the save every season.
- `src/e2e/scenarios-k9.ts` (9 scenarios): the cutscene; each lesson by real
  pointer and key events -- a real stroke for every battle gesture and glyph
  and every map order, real wheel notches and drags; a letter answered and the
  chronicle read; Continue skipping the opening; a replay from the Menu; Esc in
  the drill; an ending.
- `tools/ui-check.ts`: the opening, skip, replay and Continue through the app;
  the drill's config and enemy in sight; story.css floor, focus and motion.

### Determinism and the golden
No golden moved: the story is off in the golden realm, and the drill's
config is not a golden battle.
