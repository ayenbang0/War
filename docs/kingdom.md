# The kingdom layer — sim core (K1) and map (K2)

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
2. on the first tick of a day: roll the day's weather (`weather` stream) —
   *K3: economy at the day boundary goes here*;
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
