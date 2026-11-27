# U2: the city view (K3b) — wireframes, audit, and static re-audit

| | |
|---|---|
| **Surface** | The K3b **city layer**: the town plan of one owned holding drawn on the canvas, the **city panel** (title, the lots and fields as a list, Politics, Leave the city, key hint), the **lot card** (empty, under construction, standing), the **field card** (the plot manager), the **politics panel**, and the **region card's new summary** with its **Enter the city** button on the kingdom map. The build and sow menus are K3's (`economy-panel.ts`), opened from here |
| **Source files** | `src/app/city-layer.ts`, `src/render/city/layout.ts`, `src/render/city/renderer.ts`, `src/ui/city/panel.ts`, `src/ui/city/cards.ts`, `src/ui/city/city.css`, `src/input/zoom-through.ts`, `src/content/kingdom/city-strings.ts`; edits in `src/app/kingdom-layer.ts` (enter/leave, suspend/resume), `src/app/app.ts`, `src/app/layers.ts`, `src/ui/kingdom/cards.ts` (region summary), `src/ui/kingdom/economy-panel.ts` (sections, lot note) |
| **Interactions** | enter a city (region-card button, double tap on the holding, wheel past the closest map zoom over it); read the town; tap a lot → build menu or the building's card; tap a field → sow / harvest; open Politics (tax, people, bread and famine, and what K6 will add); pan and zoom the plan; keep the realm's time (pause, step, speed); leave (Esc, the button, wheel past the widest city zoom) |
| **Screen contract** | see "Screen-stack entries" below |
| **Skills applied** | game-ui-ux · game-feel (layer transition, tap feedback) · camera-systems (layer-transition framing, zoom-through, clamp) · create-game-assets (town plan, building glyph family). game-ai: n/a (no AI acts until K8) |
| **Passes done** | static (wireframe, before code) ✓ · static (code, after K3b) ✓ · runtime ☐ (no browser in this build environment — see "Pending") · input: keyboard and mouse by the e2e fake ✓, touch ☐ · state: empty lot, works, standing, idle, famine, holding lost ✓ |
| **Auditor / date** | U2 (city), 2026-11-25 |
| **Build / commit** | branch `k3b` |
| **Constraints** | desktop web target; gamepad not a target (P3 info); phone findings ≤ P2; English only, strings in tables (docs/PROVISIONAL.md C.7.1–C.7.3) |

## Lessons carried in (U1 kingdom map, U2 economy panels)

| Lesson | How the city applies it |
|---|---|
| One layer live at a time; layers are a typed union (§B.1) | `Layer = KingdomLayer \| CityLayer \| BattleLayer`. While the city is live the kingdom layer is **suspended**: its frame loop, pen, camera and keys are off. The city's frame loop drives the same `KingdomWorld` through the kingdom layer's one tick runner (`advance`), so the clock, the feed, the autosave and the HUD carry on unchanged |
| A card is non-modal and focuses its heading (U1-04) | lot, field and politics cards are the same non-modal overlays as the region card, drawn in the same card root; Esc closes; the plan stays live under them |
| One check for button and sim (PC-03) | every city button asks `world.check(order)`; the build and sow menus are K3's own, reused |
| A refusal is said (PC-02) | a tap on nothing says so on the result line; a pen line in the city says what the pen does here; refused menu options keep K3's "Not now: …" |
| Re-render restores focus (U2-04) | the city panel's list rebuilds only on a signature change and refocuses the control with the same `data-key` |
| Mouse press must not leave a button focused (Space is pause) | every city button blurs on a mouse press |
| 16 px DOM floor, 13 px canvas labels with a halo | panel and cards in rem; plan labels 14 px on a halo |
| State not by colour alone | a lot's state is drawn by shape (dashed outline + stakes / scaffold hatch + progress bar / solid block + glyph / struck through when idle) AND written in its label; a field's stage by its pattern (furrows, sprouts, stipple, stubble, cross-hatch) AND its label |

## Wireframes (1280 × 720 reference)

### Kingdom map: region card of an owned holding (the economy panel has moved into the city)

```
┌ Greyshaw ──────────────────────────────┐
│ The Farthest Reach                     │
│ Held     The king                      │
│ Kind     Hamlet    Country  cold, …    │
│ People   46        Roads …             │
│ ─ The holding ───────────────────────  │
│ Tax      Normal: 1.8 coin a day        │   short summary, read-only
│ Lots     Granary (1 of 1 used)         │
│ Fields   Rye growing 40%; lying fallow │
│ Famine: 3 days short of bread  (bold)  │   only when true
│ [Enter the city]  [Close]  Esc closes  │   Enter: only for the king's own
└────────────────────────────────────────┘
```

### The city (canvas + panel)

```
┌ top bar (the kingdom HUD, unchanged: stores · date & weather · Pause 1× 2× 4× · Front screen) ┐
┌ city panel ──────────┐                                                         ┌ card ─────┐
│ GREYSHAW (h2, -1)    │        . . field 2 (stubble) . .                        │ (lot,     │
│ Hamlet · the Reach · │     ╭────────────────────────╮                          │  field or │
│ 46 people            │     │  ┌──┐ lot 1 Granary   │  ═══ road to Cold Hearth │  politics)│
│ [Politics] [Leave]   │ ════│  │▣ │  ●green         │═══                       │           │
│ Lots                 │     │  └──┘                 │                          └───────────┘
│ [Lot 1: Granary]     │     ╰──── palisade (if built) ╯
│ Fields               │        field 1 (rye, growing 40 %)
│ [Field 1: Rye, 40%]  │
│ [Field 2: harvested] │
│ tap a lot or a field │
│ · P politics         │
│ · Esc leaves         │
└──────────────────────┘
 feed (bottom left, the kingdom's)                         keys: replaced by the panel's hint
```

- The plan is drawn per holding: kind sets its size and lot count, the biome sets its country
  (trees for forest, a river and bridge for river country, the sea for the coast, contours for
  highland and hills, stones and heather for moor and the Reach, hedgerows for vale and open), and
  the holding's seed jitters the square, the ring, the houses and the fields, so two hamlets of
  the same country still differ. Streets leave the town toward its real roads on the kingdom map.
- **Lots** are laid out round the square in slot order. The sim's `build` takes the FIRST free
  slot, and slots never empty, so free lots are always the last ones: the town builds outward
  from the square. The next free lot is drawn **staked** (corner pegs, "Lot 2 · open, next to
  build"); later free lots are open ground ("not yet staked"). Tapping any free lot opens the build
  menu for the staked one and says so (no sim change; PROVISIONAL K3b.1).
- A palisade, wall or keep is drawn twice: on its lot (gatehouse glyph) and as the town's
  enclosure ring with gates where streets cross it; under construction the ring is dashed.

### Lot card

```
┌ Lot 2 · open ground ─────────────────┐   ┌ Lot 1 · Granary ───────────────────┐
│ The builders take this lot next.     │   │ Stores grain through the winter…   │
│ [Build…]  [Close]   Esc closes       │   │ State    being built, 3 of 4 days  │
└──────────────────────────────────────┘   │ Upkeep   none                      │
┌ Lot 3 · open ground ─────────────────┐   │ (standing palisade: [Build…] for   │
│ Not yet staked: the town builds out  │   │  the wall that goes over it)       │
│ from the square, so the next building│   │ [Close]                            │
│ goes on lot 2.  [Build on lot 2…]    │   └────────────────────────────────────┘
└──────────────────────────────────────┘
```

### Field card (plot manager) and Politics

```
┌ Field 1 ─────────────────────────────┐   ┌ Politics at Greyshaw ──────────────────────┐
│ Rye, growing (40%)                   │   │ People   46                                │
│ Health   100%                        │   │ Tax      Normal: 1.8 coin a day; grow 2%   │
│ [Sow…] or [Harvest] when it applies  │   │ [None][Low][Normal▣][High][Harsh]          │
│ [Close]                              │   │ [Same rate everywhere]                     │
└──────────────────────────────────────┘   │ Bread    1 grain a day from the stores     │
                                           │ Famine: 3 days short (bold, only if true)  │
                                           │ Loyalty and unrest   not yet: K6           │
                                           │ Local lords          none sworn yet        │
                                           │ Laws                 none proclaimed yet   │
                                           │ [Close]                                    │
                                           └────────────────────────────────────────────┘
```

"Not yet" rows are plain words, never a number: there is no loyalty or unrest rule until K6, so
any figure would be invented.

## Screen-stack entries and input contexts

| Screen | Kind | Traps focus | Pauses sim | Inputs | First focus | Esc |
|---|---|---|---|---|---|---|
| kingdom (the realm) | full | no | no | pen, camera, ui | — | (map) stroke, then Home |
| **city** | **overlay** over the realm, so the kingdom HUD stays on view | no | no | pen, camera, ui | the city panel's heading | stroke in progress first, then leaves the city |
| lot-card / field-card / politics-card | overlay | no | no | pen, camera, ui | heading; on return from a menu, the control that opened it | closes the card |
| build-menu / sow-menu (K3) | overlay | yes | yes | ui | first option on offer, else Cancel | cancels |

One owner per Esc press: a menu, then a card, then a stroke, then leaving the city, then (on the
map) Home. The city screen is pushed above the realm screen; popping it (Esc, Leave the city, wheel
out) resumes the map; the Front screen button pops both, and the realm saves as it always does.

## Audit of the wireframes against each skill (before code)

### game-ui-ux

| Check | Result |
|---|---|
| Anchored layout, flex/grid, no fixed widths sized to English | ✓ panel is a left column `width: min(21rem, …)`, rows wrap; cards reuse `.k-card` |
| One scaling policy (rem) | ✓ by design; city.css is to be held to the same ui-check as kingdom.css → **C-01** |
| Safe area, ultrawide | ✓ panel inset by `env(safe-area-inset-left)`; plan centred and clamped by the shared camera |
| Portrait phone | ✓ (P2 cap) at ≤ 700 px the panel becomes a strip above the bottom sheet with its own scroll — runtime: pending (C-09) |
| Focus on open | ✗ → **C-02**: the city has no DOM focus target by itself (the plan is canvas). Fix: the panel heading takes focus (tabindex −1), as cards do, so Space still pauses |
| Every action by keyboard | ✗ → **C-03**: lots and fields exist only on the canvas. Fix: the panel lists every lot and field as buttons that open the same cards as a tap; Politics and Leave are buttons; `P` opens Politics |
| Modal trap | ✓ menus are K3's (trap, hold the clock) |
| Re-render restores focus | ✓ designed in (`data-key`) |
| Back/Esc | ✓ one owner per press (table above) |
| HUD by events | ✓ the realm's HUD is unchanged; the city panel refreshes only after ticks ran, by signature |
| Text ≥ 16 px; contrast ≥ 4.5:1 | ✓ reuses the measured kingdom pairs (`#3a3124` on `#efe8d6` 10.45:1, `#5f5138` 6.32:1, `#8c3a34` 6.20:1); plan labels `#3f3527` on a 0.92 halo |
| Not colour alone | ✓ shape + words for lot and field state |
| Honest placeholders | ✗ → **C-04**: the plan asks for loyalty/unrest, lords and laws before K6 builds them. Fix: say "not yet" in words, never a figure |
| Strings in tables | ✓ `city-strings.ts`, templated |

### game-feel

| Check | Result |
|---|---|
| Each event has a hook | ✓ enter, leave, tap lot/field/square, tap nothing, a pen line in the city, an order from a card (pulse on its lot or field) |
| Tiering | small: hover outline, tap selects (ring), refused tap (result line); medium: an order issued (pulse ring on the lot/field, result line); large: the layer transition |
| Transition eased, real time, honours reduced motion | ✗ → **C-05**: a hard swap between layers loses where you were. Fix: entering scales the plan in from the holding's point on the map (0.45 s ease-in-out); leaving cuts the map to the holding at its closest zoom and eases out (0.45 s). Under `prefers-reduced-motion`, both are cuts |
| Juice never changes the sim | ✓ the transition is render-clock only; the realm's clock runs through it |
| No over-juicing | ✓ hover is an outline only; no pulse for selection |

### camera-systems

| Check | Result |
|---|---|
| What the camera serves | ✓ the city plan: free pan/zoom about the cursor, opening framed on the whole town |
| Bounds from the viewport, view clamped | ✓ the kingdom camera class is reused with the plan's size, so `minZoom` fits the whole town plus a margin |
| Zoom-through between layers | ✗ → **C-06**: a wheel that stops dead at the zoom limit gives no way down or up. Fix: wheeling on past the closest map zoom over an owned holding enters it; past the widest city zoom leaves; the overflow must build up (about two notches) and decays after 0.6 s idle, so one stray notch never changes layer |
| Hard cut resets smoothing | ✓ entering cuts the city camera; leaving starts a fresh fly-out |
| Keys cleared on blur; edge push off under reduced motion | ✓ the kingdom controls class is reused |

### create-game-assets

| Check | Result |
|---|---|
| One family | ✓ building glyphs: one routine, 1.5 px ink, inside a pale disc, same as the stock icons' treatment |
| Map-table look, procedural | ✓ parchment ground, ink streets, hatching, stipple, halo labels; no images |
| Distinct per biome and seed | ✓ by design; ui-check asserts it (C-07 below) |
| Palette in one module | ✓ `render/city/renderer.ts` takes the kingdom palette and adds a small city table at its top (crop and roof colours) — the kingdom-wide U2-08 stands |
| Functional text is code-native | ✓ labels are `fillText`, the panel is DOM |

## Findings log

| ID | Sev | Skill rule violated | Evidence | Fix | Owner | Status |
|---|---|---|---|---|---|---|
| C-01 | P1 | one scaling policy | a new stylesheet would escape `ui-check`'s px floor (it reads only style.css and kingdom.css) | `tools/ui-check.ts` checks `src/ui/city/city.css` for px / sub-1rem font sizes and for the authored focus ring | K3b | closed: ui-check "city.css: no font size in px or under 1rem", "city.css: the panel heading has an authored focus ring", "city.css: index.html and e2e.html load it" |
| C-02 | P1 | focus on open | the city screen's surface is a canvas: `activeElement` would be `body` | panel heading, `tabindex -1`, is the screen's first focus | K3b | closed: `CityLayer.screen.firstFocus` is `panel.heading` (h2, tabindex −1); ui-check "K3b: focus lands on its heading"; e2e `k3b-city-view` "focus is on the city panel's heading" |
| C-03 | P1 | every action reachable by keyboard | lots and fields only on the canvas | panel lists them as buttons; `P` = Politics, `F` frames the town | K3b | closed: `CityPanel` lists every lot and field as a `button[data-key]`; Politics and Leave buttons; `P`, `F`, Esc, Space, `.`, 1/2/3 and the camera keys in `CityLayer.keyDown`; e2e `k3-exile-economy` builds and sows by the panel and Tab |
| C-04 | P1 | don't fake state | loyalty/unrest/lords/laws do not exist yet | "not yet" rows in words | K3b | closed: politics card rows "Loyalty and unrest / Local lords / Laws" say "not yet reckoned … (K6)", "none sworn to you here yet", "none proclaimed yet"; e2e checks the words |
| C-05 | P1 | layer transition framing; reduced motion | layers swap with no framing | eased scale-in / fly-out; cuts under reduced motion | K3b | closed: `CityFrame.intro` scales the plan in from the holding's screen point over 0.45 s (ease-out cubic); `KingdomLayer.resume` cuts to the holding at max zoom and flies out over 0.45 s; both are cuts when `prefers-reduced-motion` matches |
| C-06 | P2 | zoom-through | the wheel stops at the limit | accumulated overflow, decays, needs ~2 notches | K3b | closed: `input/zoom-through.ts` (OVERFLOW_PX 220, IDLE_SECONDS 0.6, cleared by a wheel the other way or a new target); e2e `k3b-zoom-through` "one notch at the limit does not change layer"; another's holding says why |
| C-07 | P2 | asset drift / sameness | 72 holdings drawn by one routine could all look alike | biome features + seed jitter; ui-check: two hamlets of one country differ, a forest and a coast town differ | K3b | closed: ui-check "city plans (K3b)": every holding's plan is its own (36 of 36), water only on river/coast, height lines only in hill country, deterministic |
| C-08 | P2 | lot order honesty | a tap on a far free lot cannot build THERE (the sim takes the first free slot) | the staked lot is drawn and named; the card says where the building will go | K3b | closed: the next lot is staked (pegs + dashed outline) and named "open, next to build"; a later lot's card says "the next building goes on lot N" and its button reads "Build on lot N…"; the build menu says "It goes on lot N." (e2e checks it) |

## Static re-audit after implementation

Read against the code on branch `k3b`, against the same four skills.

| Check | Result |
|---|---|
| Screen contract | ✓ as the table above. The city screen ignores the stack's "inert under the top" (`setInert` is a no-op) and takes its liveness from the input contexts instead: a non-modal card leaves the panel and the HUD's buttons live, a modal menu makes both inert (`CityLayer.setContexts` → `panel.setLive`, `hud.setLive`) |
| One owner per Esc | ✓ menu (its `onKey`) → card (`cardFrame`'s `onKey`; a stroke in progress keeps it) → stroke (`pen.cancelStroke`) → leave; on the map, the K2 order is unchanged. ui-check "K3b: Esc closes the card first", "Esc again leaves the city" |
| Focus on return | ✓ a menu returns to the control that opened it (`cardFrame` `back`); a rebuilt panel refocuses the button with the same `data-key`; a hidden Build…/Sow… hands focus to the card heading, never `body` |
| Space is pause | ✓ the panel heading and card headings take first focus (not buttons); a mouse press blurs a panel button (`pressed`) |
| Realm time | ✓ one clock: the city's frame calls `KingdomLayer.advance`, which runs the same ticks, autosave and HUD; ui-check "the realm's clock runs on in the city", "leaving keeps the realm as the city left it"; e2e "the realm's day steps from inside the city", "the realm's clock to run on the map after the city" |
| Listeners | ✓ the city adds resize (window), pen, camera, zoom-out and hover (canvas) and removes every one on teardown; ui-check counts window, document and canvas listeners before and after, and the frame loops (1, the map's) |
| A holding lost while inside | ✓ the city leaves on its next frame and the map's result line says "… is no longer yours; you are back on the map." (ui-check) |
| Text sizes, contrast, not colour alone | ✓ city.css passes the floor; the panel reuses the kingdom ink pairs; an open item is marked by `aria-current`, a heavier rule and bold; an idle lot is dashed and red and says "idle" |
| Strings | ✓ all in `content/kingdom/city-strings.ts`; unused keys removed |
| Sim purity | ✓ no file under `src/sim` changed; the city issues K3's orders only |

### Still open

| ID | Sev | What | Status |
|---|---|---|---|
| C-09 | P2 | portrait phone: at ≤ 700 px the panel sits above the cards' bottom sheet; whether both fit with the top bar wrapped is unmeasured | open, runtime pass pending (no browser here) |
| C-10 | P2 | the town plan is drawn but not seen: no real canvas in this environment, so its look (labels, glyphs, halo legibility at min zoom) has not been screenshotted | open, runtime pass pending |

No open P0 or P1.
