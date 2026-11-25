# The kingdom layer — sim core (K1), map (K2) and economy (K3)

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
| `DAYS_PER_SEASON` | 30 | |
| `SEASONS_PER_YEAR` | 4 | spring, summer, autumn, winter |
| `DAYS_PER_YEAR` | 120 | |
| `TICKS_PER_YEAR` | 960 | ten years = 9600 ticks |
| `START_DAY_OF_YEAR` | 60 | the exile begins on the first day of autumn, year 1 |

The tick counter is `world.now` (not `tick`, which is the method). Day, season
and year are derived by `calendar(now)` / `world.date` and never stored.

The kingdom tick is **not** coupled to the 20 Hz battle tick. Only one layer
is live at a time (§B.1): the layer controller simply stops calling
`kingdom.tick()` while a battle runs. **Pause and speed are UI-only**: the UI
decides how many `tick()` calls to make per frame. Suggested: 1× = one day per
2 s (4 ticks/s), 2× and 4× scale that, `.` while paused runs `TICKS_PER_DAY`
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
