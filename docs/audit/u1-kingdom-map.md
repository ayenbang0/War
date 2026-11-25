# U1: kingdom map and HUD — wireframe and pre-implementation audit

| | |
|---|---|
| **Surface** | The kingdom map (Layer 3) and everything on it in K2: map canvas, top bar (stores placeholder, date/season/weather, speed controls, front-screen button), PAUSED banner, alerts feed, pen result line, region card, king card, march ghost with ETA label |
| **Source files** | none yet — this sheet is written *before* K2 (PLAN.md §C.6 U1). Read for it: PLAN.md §B.2, §B.5, Part C; `docs/audit/TEMPLATE.md`; `docs/audit/baseline-pen-camera.md` ("Notes for the kingdom map"); `docs/kingdom.md` (K1 API); `src/app/app.ts`, `src/ui/screen-stack.ts`, `src/ui/keys.ts`, `src/render/camera.ts`, `src/input/{pen,gestures,camera-controls}.ts` |
| **Interactions** | pan/zoom the map; tap a holding or the king to read about it; draw a line from the king to a holding to march; pause, step a day, change speed; leave for the front screen and come back to the same realm |
| **Screen contract** | see "Screen-stack entries" below |
| **Skills applied** | game-ui-ux · game-feel · camera-systems (game-ai: n/a in K2 — no AI acts on the kingdom map until K8; create-game-assets: the procedural map art, briefly) |
| **Passes done** | static (of the wireframe) ✓ · runtime ☐ (after K2: see "Re-audit after K2") · input ☐ · state ☐ |
| **Auditor / date** | U1, 2026-11-25 |
| **Constraints** | desktop web target; gamepad not a target (P3 info); phone findings ≤ P2; English only, strings in a table (docs/PROVISIONAL.md C.7.1–C.7.3) |

## U0 lessons carried in (from `baseline-*.md`)

| Lesson | Source finding | How the kingdom map applies it |
|---|---|---|
| 16 px minimum body text | BH, PC-17 (11 px ghost label) | every DOM text on this surface ≥ 16 px; map labels ≥ 14 px for hamlets, 16 px for everything that carries a decision (ETA label, holding names of seats/towns, the card) |
| 4.5:1 text contrast | PC-16 | panel text `#3a3124` on `#efe8d6` = 10.45:1, secondary `#5f5138` = 6.32:1 (not the 4.40:1 `#7a6848` the battle uses); map ink `#3f3527` on parchment `#d9cbb0` = 7.50:1, with a light halo under every label and line |
| Visible focus | BS (no `:focus-visible`) | authored `:focus-visible`: 3 px `#1f4f86` outline, 2 px offset (6.82:1 on the panel), distinct from the hover tint |
| `prefers-reduced-motion` | PC-33 | read once at layer start; when set, the commit pulse and reject fade are instant, the camera fly-to is a cut, edge push is off |
| One function for ghost preview and commit | PC-03, PC-07 | `KingdomCommander.intent(stroke)` returns `{ ghost, order, message }`; the preview draws `ghost`, the release issues exactly `order` through `world.issue` and shows `message` |
| Identity not by colour alone | hypothesis (blue/red 1.15:1 luminance) | owner is coded by FILL: unclaimed = hollow glyph, the king's = solid with a crown tick, crown-sworn (usurper and his captains) = hatched; the card names the owner in words |
| Zoom bounds from the viewport | PC-20 | `minZoom` fits the whole realm plus a margin in the current viewport; `maxZoom` shows ~140 miles across the shorter side; both recomputed on resize |
| Tap / grab tolerances | PC-14 | every hit radius is a world-unit base clamped between a screen-pixel floor and ceiling (`pxToWorld` in the recogniser context); the corpus runs at both zoom extremes |
| A stroke that means nothing says so | PC-02 | the recogniser returns `{ kind: "none", reason }`, never `null`; the ghost shows the reason while drawing, the line greys and fades on release, the result line repeats it |
| No module-level key listeners | PC-06, PC-22 | the layer implements `LayerKeys` and receives keys from the one router, `e.code` only |
| Cancel on blur | PC-13 | the kingdom pen cancels on `lostpointercapture`, on `buttons === 0` mid-move, and via `releaseAll` on window blur |
| Strokes are never silently truncated | PC-12 | at the sample cap the stroke is decimated (every other interior point dropped), not cut |
| Queued-but-unapplied orders are visible | PC-10 | a `moveKing` still in `world.orders` is drawn as a dotted "queued" route until its tick lands |
| Framing commands | PC-24 | `F` frames the king (eased, cancelled by any manual camera input; a cut under reduced motion) |

## Wireframe (1280 × 720 reference; DOM panels over the canvas)

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ ┌ stores ───────────────────────┐ ┌ date ───────────────────────┐ ┌ speed ──────────────┐ │ top bar
│ │ No stores yet: no coin, grain │ │ Day 3 · 4th of Autumn, Yr 1 │ │[Pause][1×][2×][4×]  │ │ (flex row,
│ │ or followers (K3)             │ │ Weather: rain (marching slow)│ │      [Front screen] │ │  wraps)
│ └───────────────────────────────┘ └─────────────────────────────┘ └─────────────────────┘ │
│                         ┌──────────────── PAUSED — space to resume ─┐                     │ banner (only
│                         └───────────────────────────────────────────┘                     │ when paused)
│     THE FARTHEST REACH                                          ┌ card (right) ─────────┐ │
│        Fell End ○                                               │ Greyshaw            ✕ │ │
│   ┌──┐   ╱                                                      │ The Farthest Reach    │ │
│   │♔ │ (king counter, 30 px above his true point, stem to it)   │ Hamlet · unclaimed    │ │
│   └┬─┘                                                          │ Country: cold, sparse │ │
│ Cold Hearth ○╌╌╌╌╌╌╌╌╌○ Greyshaw     ← march ghost: route along │ People: 50            │ │
│      ╎      ╲          ┌──────────────────────────┐  roads,     │ Slots: 0 garrison,    │ │
│ Thornwick ○  ⌂ Rookstead│ March to Greyshaw        │  ring on    │  1 building, 2 fields │ │
│                         │ about 4½ days (in rain)  │  the goal   │ From the king: 4½ days│ │
│                         └──────────────────────────┘ ETA plate   │ [Close]  Esc closes   │ │
│                           at the pen tip, kept inside the view   └───────────────────────┘ │
│ ┌ alerts (aria-live) ───────────┐                                                          │
│ │ Day 3  The king set out for … │                                                          │
│ │ Day 2  Rain on the roads      │                                                          │
│ └───────────────────────────────┘                                                          │
│ ┌ pen result (aria-live) ─────────────────────┐   keys: space pause · . day · 1 2 3 speed  │
│ │ That line means nothing: draw from the king │   F find the king · Esc close/back         │
│ └─────────────────────────────────────────────┘                                            │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Top bar** — anchored top, `display: flex; flex-wrap: wrap`, so at 1080 × 2340 it stacks. Three groups: the **stores placeholder** (start-from-nothing: it says in words that the king has nothing; K3 fills it), the **date** (day count, day of the season, year, weather and what the weather does), the **speed control** (a radio group of four real buttons with `aria-pressed`; the label is text, never an icon alone) and **Front screen**.
- **PAUSED banner** — top centre, dark plate, light text (10.65:1), plus a light dim over the map. Says what to press.
- **Map** — the canvas, full window. Parchment, province washes and names, roads drawn by surface (highway double line, road solid, track dashed, forest/moor/pass dotted, ford/ferry broken with a crossing tick), holdings drawn by kind (hamlet dot, village ring, town square, keep crenellated square, city walled circle) and filled by owner (hollow / solid with crown tick / hatched). The king's counter and his current route; queued routes dotted.
- **Region card / king card** — right edge, max 26 rem, scrolls inside itself, never covers the top bar. At portrait width it becomes a bottom sheet (P2 cap).
- **Alerts feed** — bottom left, last five events, newest first, each dated; `aria-live="polite"`.
- **Pen result line** — under the alerts; what the last stroke did or why it did nothing; `aria-live="polite"`.
- **Key hint** — bottom right, the keys of this screen, from the same table as the bindings.
- **March ghost** — while the pen is down: the planned route along the roads from the king, a ring on the destination, and an ETA plate at the pen tip (16 px, parchment plate, flips left/up near the right/top edge so it is never clipped). A stroke that means nothing shows a grey plate with the reason instead, and the wet ink turns grey.

## Screen-stack entries and input contexts

| Screen | Kind | First focus | Traps focus | Pauses sim | Inputs | Esc |
|---|---|---|---|---|---|---|
| `home` (existing) | full | Play | no | no | ui | — |
| `confirm` (existing; "Begin a new exile?", "The saved realm cannot be read") | overlay | the safe button | yes | yes | ui | the safe choice |
| `kingdom` (the map; pushed by `App.enterLayer`) | full | none (focus drops to the page, so keys reach the map) | no | no | pen, camera, ui | handled by the layer: cancel the stroke → (no card) save and go back to `home` |
| `region-card` | overlay, **non-modal** | the card's heading (`tabindex="-1"`) | no | no | pen, camera, ui | cancel a stroke if one is being drawn (passes to the layer), else close the card |
| `king-card` | as `region-card` | as `region-card` | no | no | pen, camera, ui | as `region-card` |

At most one card is on the stack; tapping another holding replaces it (pop, push). The HUD's buttons are live exactly while the `pen` context is (so a card leaves them usable and a confirm makes them inert); the `kingdom` screen's own `setInert` does not touch them.

## Keyboard map (physical keys, `e.code`, through `src/ui/keys.ts`)

| Key | Does | Notes |
|---|---|---|
| Space | pause / resume | repeat ignored; `preventDefault` (no page scroll); a focused button keeps Space (router rule) |
| `.` (Period) | while paused: advance one day (8 ticks) | while running it says "pause first (space)" instead of doing nothing |
| 1 / 2 / 3 (and numpad) | speed 1× / 2× / 4×, resuming if paused | the same as pressing the buttons |
| W A S D, arrows | pan | arrows pan here (the battle's arrows-zoom, PC-21, is not copied) |
| `-` / `=` (and numpad − / +) | zoom out / in about the view centre | |
| F | frame the king | eased fly-to; a cut under reduced motion; any camera input cancels it |
| Esc | cancel the stroke → close the card → back to the front screen (autosaved) | one owner per press |
| Tab | the browser's: top bar, card | DOM order = visual order |

Speed: 1× = one day per 2 s (4 kingdom ticks a second, docs/kingdom.md), 2× = 8, 4× = 16 ticks a second. Pause and speed are UI state, never orders, never saved.

## The pen on the kingdom map (B.5, separate recogniser context)

`src/input/kingdom-gestures.ts` is pure and reuses `pathLength`, `simplify` and `pointInPolygon` from `gestures.ts` without modifying it. Discrimination, in order, each step on its own kind of evidence:

1. **Tap** — total length ≤ the tap tolerance → the nearest thing under the tap within its hit radius: a token (the king) before a holding at equal normalised distance; nothing → `none` ("nothing there").
2. **Closed** — endpoint gap ≤ 0.3 × length and big enough → reserved for K4 (ring = garrison, large ring = patrol, heart = recover); in K2 `none` with the reason. Checked BEFORE anchoring: a ring that begins on the king is never a march (CLAUDE.md: a large closed stroke is never claimed by the anchor).
3. **Subject** — the stroke must start on a token (grab tolerance); else `none` ("draw from the king").
4. **Target** — ends on a holding (hit tolerance) → `march`; on the king's own holding → `none` ("already there"); on nothing → `none` ("end the line on a holding"). K4 adds: ends on an enemy army → intercept; on an own army → merge; a line across an army → split.

Then `KingdomCommander.intent` turns `march` into `world.planKingRoute(to)`: no route → `none` ("no road leads there"); a route → ghost (route + ETA) and the order `{ kind: "moveKing", to }`. Preview and commit call that one function.

Tolerances (miles, clamped to screen pixels): tap length 8 mi in [6, 12] px; king grab 10 mi in [16, 26] px; holding hit by kind (hamlet 7, village 8, keep 9, town 10, city 13 mi) in [12, 24] px. The king's counter is drawn 30 px above his true point with a stem down to it, so when he stands in a hamlet the hamlet and the king are two separate targets; recogniser and renderer get that position from one function.

## Feedback (game-feel tiers)

| Event | Tier | Channels |
|---|---|---|
| march committed | small | wet ink eases into the route (fade 220 ms, ease-out); destination ring pulses once (easeOutBack, 320 ms); result line + alert "The king sets out for X (about N days)" |
| stroke means nothing | small | wet ink turns grey and fades (450 ms); result line gives the reason; no shake |
| order rejected by the sim (`orderRejected`) | small | alert with the sim's reason |
| king arrives | small | ring pulse at the holding; alert |
| pause / resume | small | banner + dim; speed control state |
| day passes | none | the date changes in place (no animation; it is routine) |
| save failed | medium (information) | persistent notice in the alerts: "This realm is not being saved: …" |

Nothing changes the sim; all on the render clock (`dtReal`), all returns to rest, retriggering restarts the same animation. Reduced motion: pulses and fades become instant, edge push off, fly-to cuts.

## Audit of the wireframe against each skill

### game-ui-ux

| Check | Verdict | Note |
|---|---|---|
| Panels anchored, not hard-coded x/y | ✓ | top bar `inset: 12px 12px auto`, card `right/top/bottom`, alerts `left/bottom`; flex inside |
| Containers size to content, nothing sized to English | ✓ | `max-width` in rem, wrapping text, `flex-wrap` |
| One scaling policy | ✓ | rem (16 px root), canvas at DPR ≤ 2 as the battle |
| Ultrawide: corners anchored outward | ✓ | groups at the corners; the banner centred on purpose |
| Safe area | ✓ | `env(safe-area-inset-*)` added to every anchored panel |
| Portrait phone | ✗ U1-12 (P2) | the right card would cover the map → bottom sheet under 700 px wide |
| Focus on open | ✓ / ✗ U1-04 | cards focus their heading; see U1-04 for why not the Close button |
| Tab order = visual order | ✓ | DOM order: top bar, card, alerts |
| `:focus-visible` distinct from hover | ✓ | outline vs background tint |
| Focus trapped in modals | ✓ | only `confirm` is modal; cards are not modals and say so |
| Screen stack, Esc pops | ✓ | entries above; Esc chain |
| No boolean menu flow | ✓ | run state is a typed union; cards are stack entries |
| Screen declares whether it pauses | ✓ | table above |
| Destructive actions confirm | ✓ / ✗ U1-10 | "Begin a new exile" confirms on Home; leaving does not need one (nothing is lost) |
| HUD driven by events | ✗ U1-09 (P2) | see finding: date/alerts/king card from tick events, not rebuilt every frame |
| Text ≥ 16 px body / 18 px gameplay at 1080p | ✗ U1-06 (P2) | ETA plate and labels sized up; see finding |
| Contrast ≥ 4.5:1 | ✗ U1-07 (P2) | secondary text colour changed; halos under map ink |
| Not colour alone | ✗ U1-01 (P1) | owner fill coding |
| Reduce motion honoured | ✓ | `prefers-reduced-motion` |
| Semantics (`aria-pressed`, `aria-live`, canvas label) | ✓ | speed group `role="group"`, buttons `aria-pressed`; alerts and result `aria-live="polite"`; canvas `aria-label` while the map is up |
| Strings in a table | ✓ | `src/content/kingdom/ui-strings.ts` with templated parameters |
| Layout survives +30 % text | ✓ | wrapping; the card scrolls |

### game-feel

| Check | Verdict | Note |
|---|---|---|
| Every event has a named hook | ✓ | tick events from `KingdomWorld.tick()` + the commander's intent result |
| One `feedback(tier, pos)` entry | ✓ | `KingdomFeedback.fire(kind, at)` in the renderer side |
| 2–3 channels per event | ✓ | table above (visual + text; no audio in the project yet) |
| Eased motion | ✓ | ease-out fades, easeOutBack pulse, ease-in-out fly-to |
| Juice never touches the sim | ✓ | render clock only |
| Real-time decay, frame-rate independent | ✓ | `dtReal`; the tick accumulator is real-time |
| Returns to rest, retrigger restarts | ✓ | one pulse slot per holding |
| Preview matches outcome | ✗ U1-03 (P1) | one function |
| Feedback for a stroke that means nothing | ✗ U1-05 (P1) | `none` with a reason |
| Commit while paused visible | ✗ U1-08 (P2) | queued route |
| No over-juicing | ✓ | days pass silently |
| Flashing | n/a | no flashes |

### camera-systems

| Check | Verdict | Note |
|---|---|---|
| What it serves | ✓ | a strategic table: free pan/zoom over the realm; opens framed on the king |
| Smoothing frame-rate independent | ✓ | only the fly-to eases (duration-based, real time); pan is direct |
| Pan speed scales with dt and zoom; wheel about the cursor | ✓ | screen px/s ÷ zoom; `deltaMode` normalised |
| View clamped, not the centre; centre when smaller | ✓ | with a 40-mile margin of parchment |
| Zoom limits from the viewport | ✗ U1-02 (P2) | see finding |
| Hard cuts reset state | ✓ | entering the layer cuts to the king; fly-to cancelled by input |
| Shake | n/a | none |
| Keys cleared on blur | ✓ | router `releaseAll` |
| Edge push deliberate | ✗ U1-11 (P3) | dwell + normalised diagonal + off with reduced motion |
| Opening framing on own forces | ✓ | on the king |

### create-game-assets (procedural map art)

| Check | Verdict | Note |
|---|---|---|
| Visual system written down | ✓ | this sheet: parchment, ink, washes per province, glyph per kind, fill per owner |
| Palette in one module | ✓ | kingdom colours in `src/render/kingdom/palette.ts`, base ink/parchment imported from `render/palette.ts` |
| Greyscale read | ✓ (after U1-01) | hollow / solid / hatched |
| Functional text code-native | ✓ | `fillText` / DOM |
| Judged at three distances | runtime: pending | min zoom, opening zoom, max zoom |

## Findings log (of the wireframe; all addressed in the K2 design above)

| ID | Sev | Skill rule | Evidence | Fix in the design | Owner | Status |
|---|---|---|---|---|---|---|
| U1-01 | P1 | ui-ux: colour is never the only signal | the battle's blue `#3b5f8a` and red `#8c3a34` are 1.15:1 in luminance; a map of 36 owners coloured by faction would read as one grey in greyscale | owner coded by fill: hollow (unclaimed), solid + crown tick (the king), hatched (crown-sworn); the card names the owner | K2 | designed |
| U1-02 | P2 | camera: clamp/zoom with the viewport (PC-20) | `render/camera.ts` has module-constant zoom limits in world units per pixel | `KingdomCamera` derives `minZoom` (whole realm + margin fits) and `maxZoom` (~140 mi across the short side) from the viewport on every resize | K2 | designed |
| U1-03 | P1 | feel: the preview must match the outcome (PC-03, PC-07) | the battle computes the ghost in `recognize` + `gestureLabel` and the commit separately in `Commander.commit` | one `intent()` returns ghost, order and message; release issues exactly the previewed order | K2 | designed |
| U1-04 | P1 | ui-ux: focus on open, without breaking the one-owner key rule | if a card focused its Close button, Space (pause) would press Close (the router leaves Space to a focused button); if a card trapped focus, the map would stop taking strokes | cards are non-modal overlays with `inputs: pen, camera, ui`; first focus is the heading (`tabindex=-1`); Close is one Tab away | K2 | designed |
| U1-05 | P1 | feel: every input gets feedback (PC-02) | battle `recognize` returns `null` for a meaningless stroke and the ink just vanishes | `{ kind: "none", reason }`, shown on the ghost, on release and in the result line | K2 | designed |
| U1-06 | P2 | ui-ux: text ≥ 18 px gameplay / 16 px body (PC-17) | battle ghost label 11 px, map labels 11 px | ETA plate 16 px bold, card 16 px, map labels 14–16 px with priority culling | K2 | designed |
| U1-07 | P2 | ui-ux: 4.5:1 | battle secondary text `#7a6848` on `#efe8d6` = 4.40:1 | secondary `#5f5138` (6.32:1); halo under map ink and labels | K2 | designed |
| U1-08 | P2 | feel: a commit reads at once (PC-10) | an order issued while paused only applies on a later tick | dotted queued route from `world.orders.queued()` | K2 | designed |
| U1-09 | P2 | ui-ux: HUD from events | the battle HUD rebuilds its text every frame | the HUD subscribes to the layer's event stream (tick events, speed changes, save results) and sets the initial values once | K2 | designed |
| U1-10 | P2 | ui-ux: confirm only what destroys | Esc-to-leave on the battlefield confirms because a battle is lost; here nothing is (autosave) | Esc goes straight back, saving first; "Begin a new exile" (which throws the realm away) confirms with focus on Keep | K2 | designed |
| U1-11 | P3 | camera: deliberate motion (PC-23) | edge push fires at once and 1.41× on diagonals | 150 ms dwell, normalised, off under reduced motion | K2 | designed |
| U1-12 | P2 | ui-ux: portrait phone | a 26 rem right-hand card on a 1080 px-wide portrait screen covers most of the map | bottom sheet below 700 px wide | K2 | designed |
| U1-13 | P1 | ui-ux: tap targets / CLAUDE.md world units (PC-14) | a tap threshold fixed in world units is 9 px at one zoom and 60 px at another | world base clamped to px floor/ceiling; corpus at both zoom extremes | K2 | designed |
| U1-14 | P1 | feel: unambiguous targets | the king stands ON a holding at the start; a tap there could mean either | the king's counter sits 30 px above his point with a stem; nearest-wins resolution | K2 | designed |
| U1-15 | P0 | ui-ux state pass: data loss | if the save is unreadable and the game starts fresh, the first autosave overwrites the player's realm without a word | an unreadable save is never overwritten silently: the Exile button asks first ("cannot be read — begin a new exile in its place?") | K2 | designed |
| U1-16 | P2 | ui-ux: storage refused (BS-01) | autosave can fail | a standing notice in the alerts; the realm runs from memory | K2 | designed |
| U1-17 | P2 | ui-ux: no silent keys | `.` while running would do nothing | says "pause first (space)" | K2 | designed |
| U1-18 | P2 | state pass: blur mid-stroke (PC-13) | the battle pen keeps drawing after focus loss | cancel on blur / lostpointercapture / `buttons === 0` | K2 | designed |
| U1-19 | P3 | ui-ux §3 gamepad | no gamepad path | not a target (PROVISIONAL C.7.1) | K11 | info |

Count: P0 1, P1 7, P2 9, P3 2 — all addressed in the design before code, so the gate (§C.6: no open P0/P1 on a surface a phase touches) is met for K2 provided the implementation follows this sheet; the re-audit checks that it did.

## Re-audit after K2 (pending)

To be done with screenshots once the surface exists (§C.6 U1, second half): the §C.5 runtime matrix (1280×720, 1920×1080, 2560×1080, 1080×2340, 200 % zoom), the three zoom distances, keyboard-only through every entry above, blur and resize mid-stroke, storage refused, and an unreadable save. The container has no local browser, so this needs either the published build or a browser on the user's machine.
