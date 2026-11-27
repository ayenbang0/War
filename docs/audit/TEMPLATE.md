# Audit sheet template (PLAN.md §C.5–C.6)

Copy this file to `docs/audit/<surface>.md` (or `baseline-<group>.md`) and fill in one sheet per
surface. The checklists come from the skill text reproduced in the PLAN.md Appendix and are
translated to this project's stack: **TypeScript + DOM + Canvas 2D, no engine**. Engine API
snippets in the skills (Godot, Unity, Cinemachine) do not apply; their principles do. Translation
key:

| Skill term | Here |
|---|---|
| focus owner / `gui_get_focus_owner()` / `currentSelectedGameObject` | `document.activeElement` (never `document.body` while a screen is open) |
| `grab_focus()` on open | `el.focus()` on the screen's declared first-focus element when it is pushed or uncovered |
| `focus_behavior_recursive = DISABLED` (modal trap) | `inert` on everything below the top screen, or a Tab/Shift+Tab trap inside the modal |
| stretch mode / CanvasScaler reference resolution | one CSS scaling policy (rem/clamp against a 1920×1080 reference) + canvas DPR handling (`resize()` in `main.ts`) |
| safe area | `env(safe-area-inset-*)` with `viewport-fit=cover`; re-check on `resize`/`orientationchange` |
| signal / event (`health_changed`) | sim event list or an emitter the HUD subscribes to; no per-frame polling in `drawHud` |
| `_process(dt)` / `Update` | the rAF `frame(now)` in `main.ts`; real `dtReal`, not frames |
| `Engine.time_scale` / hit-stop | the render clock only. The 20 Hz sim tick must never be slowed or skipped by juice |
| Camera2D offset / shake hook | an additive screen-space offset in `render/camera.ts`, applied after follow/clamp |
| tween / `TRANS_BACK` | hand-rolled ease functions on the render clock, or CSS transitions for DOM |
| `tr()` / Localization | a string table under `src/content/` with templated parameters |
| sprite / texture import | procedural Canvas drawing (`render/*`), offscreen chunk bake, DPR-aware sizing |

---

## Sheet header (fill one per surface)

| | |
|---|---|
| **Surface** | e.g. Army setup menu |
| **Source files** | `src/...` (file:line ranges read) |
| **Interactions** | what the player does here |
| **Screen contract** | first-focus element · traps focus? · pauses sim? · active input contexts (pen / camera / UI) · Esc does what |
| **Skills applied** | game-ui-ux · game-feel · camera-systems · game-ai · create-game-assets · *(future skills)* |
| **Passes done** | static ☐ runtime ☐ input ☐ state ☐ |
| **Auditor / date** | |
| **Build / commit** | |
| **Constraints** | target devices and form factors per `docs/PROVISIONAL.md` (desktop web target; gamepad not a target → P3 info; phone findings ≤ P2; English only, strings in tables) |

Severity: **P0** blocks play / data loss · **P1** wrong or confusing · **P2** friction · **P3** polish.
Owner phase: **K0** screen stack, focus, keyboard ownership, scaling policy · **K2** reused by the kingdom map · **K11** P2/P3 polish (or the phase that touches the surface).
Gate (§C.6): no phase K2+ ships with open P0/P1 on the surfaces it touches.

---

## Pass 1 — Static (read source against each skill checklist below)

Record every failed check in the findings log with file:line and a short quote. Mark a check
`n/a` when the surface has nothing it applies to, and `runtime: pending` when you need to see it running to decide.

## Pass 2 — Runtime (`npm run dev`, real browser)

Save a screenshot of each state of the surface at each size and note clipping, overlap,
cut-off text, scrollbars and empty space:

| State \ size | 1280×720 | 1920×1080 | 2560×1080 (ultrawide) | 1080×2340 (portrait phone) | 200 % text zoom (at 1280×720) |
|---|---|---|---|---|---|
| default | ☐ | ☐ | ☐ | ☐ | ☐ |
| *(other states)* | ☐ | ☐ | ☐ | ☐ | ☐ |

Also: DPR 1 vs 2 (canvas crispness, hairline grid), resize while the surface is open.

## Pass 3 — Input

| Mode | Checks |
|---|---|
| Mouse only | every action reachable; hover and pressed states visible; left button never bound to camera/UI on the battlefield (pen rule) |
| Keyboard only | Tab order follows reading order; `document.activeElement` never `body` on open; visible `:focus-visible` distinct from hover; Enter/Space activate; Esc goes back or cancels; no key is also handled by another live module |
| Touch / stylus (Pointer Events) | hit targets ≥ ~9 mm (≈ 34 CSS px); `touch-action` correct; pointercancel handled; no hover-only affordance |
| Gamepad | only if it becomes a target (C.7.1); until then log gaps as P3 info |

## Pass 4 — State

| State | Checks |
|---|---|
| Empty | 0 items, no save, first launch, nothing selected |
| Extreme | long names/strings (+30 %), 0 or max squads (45), max stock, all abilities |
| Error | storage refused / quota full, missing content id, bad saved JSON |
| Pause / resume | Space pause; overlays above a paused sim still animate; resume restores focus |
| Window blur | alt-tab mid-stroke, mid-pan, with a key held; keys cleared on blur |
| Resize mid-action | mid-stroke, mid-drag, with a modal open; layout and camera clamp re-applied |

## Pass 5 — Findings log

| ID | Sev | Skill rule violated | Evidence (file:line quote / screenshot) | Proposed fix | Owner | Status |
|---|---|---|---|---|---|---|
| | | | | | | open |

Then: count by severity, the hypotheses checked (confirmed/refuted with evidence), and the list of
runtime/input/state checks still pending.

---

## Skill checklists

Each row: tick ✓ (pass), ✗ (finding — give its ID), `n/a`, or `runtime: pending`.
Future skills are added as **extra columns** in the matrix at the end and as a new section here.

### game-ui-ux

**Layout and scaling**
- [ ] Panels are positioned by anchoring (CSS `inset`/flex/grid aligned to an edge, corner or centre), not by hard-coded `left/top` px that only fit one resolution.
- [ ] Rows/columns/grids place children (`flex`, `grid`); containers size to content (`auto-fit`, `minmax`, `max-width` in `ch`); nothing fixed-width sized to English.
- [ ] One scaling policy for the whole UI: a 1920×1080 reference, text in rem/clamp, canvas at `devicePixelRatio` (capped deliberately), with DOM and canvas following the same rule.
- [ ] Aspect rule chosen: HUD corners anchored outward on ultrawide (2560×1080), with nothing stranded in the middle and no letterbox unless intended.
- [ ] Critical UI (timers, morale, prompts, lesson text) is inset by `env(safe-area-inset-*)` and re-applied on resize/orientation; decorative art may bleed.
- [ ] Usable at 1080×2340 portrait (P2 cap): wraps, no horizontal overflow, nothing hidden by `overflow: hidden` on `body`.

**Focus and keyboard (gamepad stand-in)**
- [ ] One control is focused when the screen opens (`el.focus()`), and again when a screen above it closes. Headless/DOM check: `document.activeElement !== document.body`.
- [ ] Tab order is sensible; DOM order matches visual order; explicit `tabindex` only where needed (never positive).
- [ ] An authored `:focus-visible` style, different from `:hover`, ≥3:1 against the panel, not shown by colour alone.
- [ ] Focus is trapped inside modals (`inert` on the screen below, or a Tab trap); it can't reach buttons behind an overlay.
- [ ] Wrap or stop at list ends is intentional.
- [ ] Moving the mouse never leaves the screen with nothing focused.
- [ ] Re-rendering a panel (`textContent = ""` + rebuild) restores focus to the equivalent control.

**Screen flow**
- [ ] The surface is a screen on the stack: push for overlays, pop for back; only the top screen takes input (pointer and keys); the screen below gets its focus back.
- [ ] Back/Esc exists and pops; it doesn't navigate by `window.location.reload()`.
- [ ] No menu flow built from booleans or promise chains (`paused`, `inSettings`, `confirmOpen`, top-level `await` chains).
- [ ] The screen declares whether it pauses the sim; the pause overlay itself keeps running (render clock, not sim tick).
- [ ] Destructive or irreversible actions (reset progress, abandon battle) go through a confirm screen with focus on the safe choice.

**HUD driven by events**
- [ ] HUD values change on events (`moraleChanged`, `stockChanged`, …), not by rebuilding strings every rAF frame.
- [ ] The initial value is set once on subscribe (events don't replay).
- [ ] The HUD doesn't reach into sim internals beyond a read-only view.

**Text, contrast, colour**
- [ ] Default text ≥ 18 px at 1080p (PC); no gameplay text below that; scalable to 200 % (browser zoom and a text-size setting) without clipping or lost meaning.
- [ ] Text carrying gameplay information ≥ 4.5:1 against its real background (for HUD over canvas: over the darkest and lightest terrain); large text and key visuals ≥ 3:1.
- [ ] State is never shown by colour alone: selected/armed/danger/owner also gets an icon, shape, label or pattern; there is a colour-blind-safe palette option; the pair reads in greyscale.
- [ ] Reduce-motion / reduce-flashing are honoured (`prefers-reduced-motion` plus an in-game toggle).
- [ ] Semantics: `lang` set; native `<button>`/`<input>`; `aria-pressed`/`radiogroup` for toggles; `aria-live` for changing status lines; canvas-only information also available as text.

**Localisation-ready**
- [ ] Every string lives in a table under `src/content/`; no display text built by concatenation in UI code (use templates with named parameters).
- [ ] Layout survives +30 % string length; numbers/dates go through one formatter; icons kept separate from text.

### game-feel

- [ ] Each discrete event on the surface (click, toggle, commit, pen stroke recognised, order committed, hit, break, lesson step done, layer/screen transition) has a named hook (event/callback). Nothing is detected by polling.
- [ ] Each event is assigned a tier (small / medium / large) and fires one bundle via a single `feedback(tier, pos)` entry, so the game stays proportional.
- [ ] 2–3 channels per event to start (visual pop/flash, sound, particle/ink); UI hover and toggles stay in the small tier.
- [ ] Everything that moves is eased: overshoot (`easeOutBack`) for pops, ease-out for settling, ease-in only for anticipation, ease-in-out for camera and panel slides.
- [ ] Juice never changes the simulation: no sim tick slowed, skipped or reordered; shake/hit-stop live on the render clock and camera offset only.
- [ ] Decays use real time (`dtReal`), not frame counts; nothing is frame-rate dependent (check 60 vs 144 Hz).
- [ ] Every effect returns exactly to rest (scale 1, offset 0, opacity final); retriggering cancels or reuses the previous animation instead of stacking.
- [ ] Shake = trauma² with a smooth noise/summed-sine source; no per-frame `random()` buzz; trauma adds and decays to 0 within `1/decay` s.
- [ ] Freezes are under ~0.15 s and never block or drop input (buffer pen samples through them); one per impact.
- [ ] Large flashes ≤ 3 per second (WCAG 2.3.1); reduce-flashing swaps flashes for a tint.
- [ ] Accessibility toggles exist: shake strength 0–100 %, reduce flashing, reduce camera motion; respect `prefers-reduced-motion`.
- [ ] No over-juicing of routine actions (stepping, hovering, repeated toggles).

### camera-systems

- [ ] What the camera serves is stated for the surface (top-down RTS: free pan/zoom with edge push; layer transition framing; tutorial pointing).
- [ ] Smoothing uses `1 - Math.exp(-rate * dt)` (rate ~5–12) or a critically damped spring; never `lerp(a, b, const)` per frame. Check: lag the same at dt = 1/30 and 1/144.
- [ ] Pan/zoom speeds scale with `dtReal` and with zoom (world-units per second / `cam.zoom`); wheel zoom is about the cursor; keyboard zoom about the view centre.
- [ ] The *view* is clamped, not the centre: `[min + halfView, max - halfView]` per axis at the current zoom; if the map is smaller than the view on an axis, centre on it.
- [ ] Zoom limits are clamped; zooming at the edge doesn't show past the map.
- [ ] Deadzone/look-ahead (if following anything) is eased so direction flips don't whip.
- [ ] Camera update order: after the sim tick and interpolation alpha, before drawing; following interpolated positions, not raw tick positions (no jitter at 20 Hz sim vs 60+ Hz render).
- [ ] Hard cuts (new battle, layer switch, teleport) reset the smoothing state; deliberate transitions blend with ease-in-out.
- [ ] The shake offset is added last, on top of follow and clamp; never written into the follow target.
- [ ] Keys are cleared on `blur`; no drift after alt-tab; edge push off when the pointer leaves the window.
- [ ] Group framing (fit a set of squads or a region) pads the bounding box and clamps the zoom.
- [ ] Opening framing is on the player's own forces / the thing the screen asks about.

### game-ai

- [ ] AI layers are separate: perceive (facts) → decide (intent) → path → steer. The surface shows the *intent*, not internals.
- [ ] The AI acts only on what it has perceived (fog-respecting); asserted, not assumed (K8 soak).
- [ ] Legibility: what the AI is doing or about to do can be read by the player (commander habits stated, telegraphed commits, visible orders where seen).
- [ ] Fairness is disclosed: what the AI gets (budget, abilities, reinforcements, vision) is stated on the setup or briefing surface.
- [ ] Reaction delay: no instant response to player actions (≈0.2–0.5 s or an awareness build-up); chases the last-known position, then searches.
- [ ] No state flicker: hysteresis (separate enter/exit thresholds) and a minimum time in state (~0.3–0.5 s); check ≤2 transitions/s per agent.
- [ ] No stuck agents: progress check (≥0.5 units toward the waypoint in 2 s), repath, then give up or change goal.
- [ ] Pathing: admissible heuristic (A* cost == Dijkstra on random grids), no diagonal corner cutting, unreachable goals rejected by region label, repaths throttled and staggered.
- [ ] Steering uses priority truncation (avoid first), not weighted sums that cancel; separation bucketed spatially.
- [ ] The debug overlay can draw path, current state and sight cone for a chosen agent (F2).
- [ ] Difficulty changes how well the AI commands, not how much it gets (unless disclosed).

### create-game-assets

(This project draws everything procedurally; read "asset" as a drawing routine, glyph, icon,
palette entry or font.)
- [ ] The visual system is written down: shape language, silhouette priorities, value bands, palette roles (accent, danger, reward, neutral, environment, UI, own/enemy), edge/ink treatment, detail density, motion character.
- [ ] Palette lives in one module (`render/palette.ts`) and CSS reads it through custom properties; no duplicated raw hex values that can drift.
- [ ] Roles aren't overloaded: one colour doesn't mean "you", "won", "move" and "primary" at once without a second cue.
- [ ] Greyscale read: own vs enemy, states and icons are distinguishable by value/shape as well as hue (luminance contrast between the identity pair ≥ 3:1, or a shape/pattern cue).
- [ ] One icon family: every UI symbol drawn by the same ink code (Canvas/SVG), same line weight and fill treatment; no platform font glyphs or emoji standing in for icons (or `U+FE0E` text presentation enforced and tested).
- [ ] Menu/legend icons call the same drawing code as the battlefield (single source of truth for silhouettes).
- [ ] Functional text is code-native (DOM text or `fillText`), never baked into drawings.
- [ ] States exist for each interactive visual: normal, hover, focus, pressed, disabled, selected, warning.
- [ ] Judged at three distances: native/thumbnail game scale (zoom 0.35), working scale (zoom 2.4), and in context with real terrain, fog and HUD; nothing only reads when zoomed in.
- [ ] Technical fit: DPR-aware drawing, no blurry CSS-scaled canvases, baked chunks re-baked on revision, hairlines crisp, no default/empty canvas showing through overlays.
- [ ] Drift signals checked across a family (counter sizes, outline width, light direction, palette growth, icon treatment).
- [ ] Provenance: fonts and any outside resource listed with source and licence (system font stacks noted as such); no generated or licensed raster assets shipped without a manifest entry.

### *(future skills — add a section per skill here)*

- [ ] *(checks derived from the skill's Appendix text, translated to TS/DOM/Canvas)*

---

## Skill × check matrix (one row per check group, one column per skill)

Add a column for each newly supplied skill (e.g. accessibility, input-systems, audio-design) per
PROVISIONAL C.7.4. Cells: ✓ / ✗ (finding IDs) / n/a / pending.

| Check group | game-ui-ux | game-feel | camera-systems | game-ai | create-game-assets | *(skill 6)* | *(skill 7)* |
|---|---|---|---|---|---|---|---|
| Layout / scaling | | | | | | | |
| Focus / keyboard | | | | | | | |
| Screen flow / stack | | | | | | | |
| Events not polling | | | | | | | |
| Text / contrast / colour | | | | | | | |
| Feedback / easing | | | | | | | |
| Camera / framing | | | | | | | |
| AI legibility / fairness | | | | | | | |
| Visual system / icons | | | | | | | |
| Localisation | | | | | | | |
