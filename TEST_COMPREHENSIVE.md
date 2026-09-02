# War — Comprehensive Testing & Debugging Guide

A systematic checklist to verify every feature, constraint, and invariant in War.

---

## TIER 1: FOUNDATIONAL ARCHITECTURE & PURITY

### Simulation Purity (`src/sim/`)
- [ ] Run `npm run check:sim` — must pass with zero violations
- [ ] Verify `src/sim/` has no imports from `src/render/`, `src/input/`, or `src/net/`
- [ ] Verify `src/sim/` has no references to DOM, window, document, canvas
- [ ] Verify `src/sim/` has no async code, timers, or I/O
- [ ] Run `node tools/headless.ts` — must execute the full sim without a browser
- [ ] Confirm sim produces identical output on Node.js and in browser

### Math Determinism (`src/sim/math.ts`)
- [ ] Verify only `Math.floor`, `ceil`, `abs`, `sqrt`, `min`, `max`, `round`, `trunc`, `sign`, `imul` are used
- [ ] Grep for transcendentals (`sin`, `cos`, `tan`, `atan`, `atan2`, `pow`, `exp`, `log`, `hypot`) — must only appear in `math.ts` polynomial implementations
- [ ] Verify no `Math.random()` anywhere in `src/sim/` — all randomness must use `src/sim/rng.ts`
- [ ] Verify no `Date.now()`, `performance.now()`, or timers in sim
- [ ] Test same operation on different engines (V8, SpiderMonkey if possible) produces bit-exact results

### RNG Determinism (`src/sim/rng.ts`)
- [ ] Confirm RNG is seeded with same value → same sequence always (test 1000+ ticks)
- [ ] Verify each subsystem has independent RNG stream (morale, combat, AI, etc.)
- [ ] Replay same command log → verify RNG state matches exactly
- [ ] Replay with one RNG stream disabled → verify other streams unaffected

### Iteration Order Invariants
- [ ] Verify all loops that affect results iterate in defined order (by id, by insertion)
- [ ] Search for object key iteration — must be explicit, not implicit
- [ ] Confirm entity ids monotonically increase from single counter
- [ ] No `Math.random()` ordering or async ordering of entity updates

---

## TIER 2: SIMULATION CORRECTNESS

### Golden State Hashing
- [ ] Run `npm test` — verify golden.json hashes match (both `world` and `stable`)
- [ ] If hashes differ, identify which phase changed (movement, combat, morale)
- [ ] `stable` tier hash (terrain, RNG streams) must never move — if it does, investigate as bug
- [ ] Document any intentional `world` hash changes in commit messages

### Headless Test Suite (`tools/headless.ts`)
- [ ] Run all 28 regression checks
  - [ ] Math functions match expected outputs within polynomial accuracy
  - [ ] RNG sequences are deterministic
  - [ ] Replay system reproduces exact sequence
  - [ ] Terrain generation produces stable output
  - [ ] Movement paths are collision-free and reach targets

### Sim Tick Loop (Fixed 20 Hz)
- [ ] Measure tick duration — must be <50ms on target hardware
- [ ] Verify no ticks are dropped under normal gameplay
- [ ] Pause/resume cycle → verify state intact after resume
- [ ] Run 10,000 ticks → verify no numeric drift or NaN propagation
- [ ] Check for accumulation of floating-point errors over long matches

### Movement System (`src/sim/movement.ts`)
- [ ] Verify all movement goes through `advanceToward()`
- [ ] Movers never advance >0.5 tiles without retesting ground
- [ ] Test dense polyline paths (10+ waypoints per tile) — must not skip collisions
- [ ] Verify no position ever lands mid-river or off-map unexpectedly
- [ ] Formation movement stays coherent after obstacles
- [ ] Soldiers respect `SEPARATION_RADIUS` — formations don't oscillate

### Squad Route & Slot Assignment (`src/sim/movement.ts`)
- [ ] A* pathfinding produces shortest valid path
- [ ] No path skips walkable tiles or cuts corners illegally
- [ ] Slot assignment respects formation shape exactly
- [ ] Soldiers converge to slots and hold formation on flat terrain
- [ ] On slopes/terrain, formation deforms predictably (test on Idea.txt terrain samples)

### Local Avoidance & Collision
- [ ] Soldiers stop before collision, not after
- [ ] Two units at same position → one yields smoothly
- [ ] Crowded passages (chokepoints) → movement slows but doesn't deadlock
- [ ] SEPARATION_RADIUS < tightest rank spacing in any formation (measure via formations.json)

### Combat (`src/sim/combat.ts` or equivalent)
- [ ] Attack range correct per unit type and doctrine
- [ ] Accuracy with distance, terrain, morale factors
- [ ] Casualties remove soldiers from squad in stable order
- [ ] Morale check → rout/hold results deterministic
- [ ] Firepower calculation consistent (replay → same casualties at same tick)

### Morale System
- [ ] Casualties trigger morale check at correct threshold
- [ ] Rout/hold decision deterministic per RNG stream
- [ ] Routed units move to map edge consistently
- [ ] Rally conditions (distance from enemy, orders) work as documented
- [ ] Leader death → squad morale penalty

### AI (`src/sim/ai.ts` or equivalent)
- [ ] Enemy commander personality (aggression, formations) consistent across replays
- [ ] No hidden state — pure function of world state + RNG stream
- [ ] Pathfinding and positioning decisions match Idea.txt spec
- [ ] AI never cheats (no hidden vision, no perfect information)

---

## TIER 3: RENDERING

### Terrain Rendering
- [ ] Static terrain chunks cached at 512px, max 64 LRU chunks
- [ ] Terrain revision change → all chunks rebaked automatically
- [ ] Topographic contours visible and correct elevation-wise
- [ ] Relief shading follows light direction consistently
- [ ] Parchment ground texture visible at all zoom levels
- [ ] No tearing, gaps, or overlap between chunks

### Grid Lines (Live, Screen-Space)
- [ ] Grid lines render hairline-thin at every zoom (0.35x to 2.4x tested)
- [ ] Grid never jitters or flickers while panning/zooming
- [ ] Grid color matches design (test light + dark themes)

### Unit Rendering (Counters)
- [ ] Each squad draws as single counter (size by unit count)
- [ ] Counter glyph unique per unit type (rifleman, cavalry, artillery, etc.)
- [ ] Squad name/command visible without overlapping others
- [ ] Morale state (normal/routing) changes counter appearance
- [ ] Selected squad highlights correctly (glow, border, or other indicator)

### Formation Display
- [ ] Formation shape renders as overlay when squad selected or moving
- [ ] Slot positions correct for current squad count
- [ ] Formation adapts to terrain (rotates, deforms) correctly
- [ ] No formation occludes unit glyph entirely

### Rendering Performance
- [ ] rAF-driven render loop at ~60fps (or monitor refresh rate)
- [ ] Interpolation between last two sim states smooth (not jittery)
- [ ] 100+ units on screen → no visible frame drops
- [ ] Zoom in/out → no pop-in or lag
- [ ] Pan across map edge → smooth, no flicker

### Theme Support (Light/Dark)
- [ ] All map elements (terrain, grid, units) readable in light mode
- [ ] All map elements readable in dark mode
- [ ] Theme toggle → immediate redraw, no artifacts
- [ ] Glyph contrast sufficient in both themes

---

## TIER 4: INPUT & GESTURE RECOGNITION

### Pen Control (Left Pointer Button)
- [ ] Left button exclusively bound to pen strokes
- [ ] No other control binds to left button (camera, UI, etc.)
- [ ] Stroke captured in world space, not screen space
- [ ] Same stroke at zoom 0.35x and 2.4x mean identical things
- [ ] Stroke threshold (distance, velocity) in world units

### Gesture Recognition (`src/input/gestures.ts`)
- [ ] Confusion matrix diagonal (test `tools/gesture-corpus.ts`)
  - [ ] Move ≠ Retreat
  - [ ] Hold ≠ Patrol
  - [ ] Formation (ring/heart) ≠ Hold
  - [ ] Ring ≠ Heart
- [ ] Recognizer pure (no state, deterministic per stroke)
- [ ] Headless gesture test passes (corpus confusion matrix)

### Movement Gesture (Line Stroke)
- [ ] Straight line → Move order to endpoint
- [ ] Curved line → Route following curve
- [ ] Dense polyline (pen test) → Path stays within tile precision
- [ ] Very short line → Does not trigger (test min threshold)
- [ ] Line drawn off-map → Clipped to map boundary

### Patrol Gesture (Loop or Closed Curve)
- [ ] Small closed loop at destination → Patrol there
- [ ] Loop not closed → Interpreted as move or formation (test threshold)
- [ ] Patrol → Squad circles waypoint after reaching
- [ ] Cancel patrol with new order

### Hold Gesture (Short Cross or X)
- [ ] Small cross over squad → Hold position
- [ ] Hold persists until new order
- [ ] Held unit still rotates to face threats

### Formation Gesture (Ring or Heart)
- [ ] Ring drawn → Formation becomes ring (line formation in circle)
- [ ] Heart drawn → Formation becomes heart (wedge-like)
- [ ] Large closed stroke over own line → Anchors on top squad, not collapsing entire order
- [ ] Formation changes mid-movement smoothly
- [ ] Formation shape scales with unit count

### Subject Resolution (Squad Selection)
- [ ] Stroke over squad → That squad receives order (tested by gesture corpus)
- [ ] Stroke over empty space → No-op or selects nearest (per design)
- [ ] Stroke over multiple squads → Topmost squad gets order
- [ ] Squad id tiebreak when footprints overlap

### Pan & Zoom
- [ ] Middle mouse drag → Pan
- [ ] Right mouse drag → Pan (alternative)
- [ ] WASD keys → Pan (incremental)
- [ ] Arrow keys → Pan (incremental)
- [ ] Screen edge push → Pan (hold pointer near edge)
- [ ] Mouse wheel over cursor → Zoom in/out about cursor
- [ ] Zoom range: 0.35x to 2.4x (test extremes)
- [ ] Panning and zooming don't interrupt pen mode

### Pause & Step
- [ ] `space` key → Pause (sim tick stops, render continues)
- [ ] `.` key while paused → Single step (one sim tick)
- [ ] Resume after pause → No state corruption
- [ ] Step 10 times manually → Matches 10-tick replay

### Console Access (Dev Builds)
- [ ] `window.war.world` → Current sim state readable
- [ ] `window.war.cam` → Camera (zoom, pan) state
- [ ] `window.war.level` → Current level/map data
- [ ] `window.war.hashWorld()` → Compute state hash (verify matches golden)

---

## TIER 5: CONTENT & DATA INTEGRITY

### Units (`src/content/units.json` or equivalent)
- [ ] Each unit type has name, glyph, base morale, firepower, range, armor
- [ ] Glyph renders correctly (matches class)
- [ ] Stats match Idea.txt design doc
- [ ] No undefined fields or type mismatches
- [ ] Adding/removing unit types doesn't break simulation

### Formations (`src/content/formations.json` or equivalent)
- [ ] Ring, column, line, wedge all defined with correct slot counts
- [ ] Slot positions match visual representation
- [ ] Formation switch mid-order works
- [ ] SEPARATION_RADIUS documented and correct
- [ ] Formations scale sensibly for 1 to 200+ unit squads

### Doctrines (`src/content/doctrines.json` or equivalent)
- [ ] Each doctrine has distinct morale, formation, AI flavor
- [ ] Doctrine assignment affects AI behavior visibly
- [ ] Doctrine switch works in running game
- [ ] Enemy has named doctrine (test multiple)

### Levels/Maps (`src/content/levels/`)
- [ ] Terrain loads correctly (hills, rivers, forests, etc.)
- [ ] Spawn positions valid and walkable
- [ ] Objectives or victory conditions match design
- [ ] Test smallest, medium, largest map sizes
- [ ] All known levels load without error

### Data Serialization
- [ ] Export game state → Valid JSON
- [ ] Import state → Reproduces original
- [ ] Test with all unit counts (1, 10, 50, 200+)
- [ ] Replay log loads and plays back exactly

---

## TIER 6: GAMEPLAY FEATURES

### Game Phases (per Idea.txt)
- [ ] All documented phases present (setup, briefing, gameplay, resolution, etc.)
- [ ] Phase transitions happen at correct times
- [ ] Each phase enforces correct UI/input mode
- [ ] Phase changes don't corrupt state

### Tutorial (if implemented, per `src/ui/tutorial.ts`)
- [ ] Tutorial loads automatically for new player
- [ ] Each gesture (move, hold, formation, etc.) has tutorial explanation
- [ ] Skip tutorial button works
- [ ] Replay tutorial anytime from menu

### Home/Menu (`src/ui/home.ts`)
- [ ] Menu renders without errors
- [ ] New game → Launches with random level
- [ ] Load game → Restores from saved state
- [ ] Settings → Applies immediately
- [ ] Quit → Closes gracefully

### Victory/Defeat
- [ ] Victory condition checked each tick (per Idea.txt)
- [ ] Defeat condition checked each tick
- [ ] State transitions to end-screen correctly
- [ ] Can restart or load new level from end-screen

### Save/Load
- [ ] Save during gameplay → File created
- [ ] Load saved game → Continues from tick where saved
- [ ] Replay matches original play (tick-by-tick)
- [ ] Multiple saves → Don't overwrite each other

### Replay System
- [ ] Record command log + initial state hash
- [ ] Replay from file → Matches original tick-by-tick
- [ ] Stable tier hash (terrain, RNG) unchanged
- [ ] World hash may differ (intentional changes allowed if documented)

---

## TIER 7: EDGE CASES & STRESS TESTS

### Large Battles
- [ ] 200+ total squads on screen → No sim slowdown
- [ ] 50+ squads with active orders → Responsive input
- [ ] Dense formations → No collision system deadlock
- [ ] Measure: sim tick time stays <50ms

### Terrain Extremes
- [ ] Mountain chains → Pathfinding navigates sensibly
- [ ] River networks → Units don't cross without bridges (if applicable)
- [ ] Chokepoints → No infinite deadlocking, units queue
- [ ] Edge of map → No units wander off

### Movement Pathologies
- [ ] Unreachable goal → Order times out or squad stands (per design)
- [ ] Goal inside obstacle → Pathfinding returns nearest valid
- [ ] Order to past location → Squad reroutes smoothly
- [ ] Rapid re-ordering → No animation glitches, state stays clean

### Formation Edge Cases
- [ ] 1-unit squad → Formation slot = squad position
- [ ] 1000-unit squad → Formation scales, slots computed correctly
- [ ] Formation change while moving → Smooth transition
- [ ] Formation change while under fire → Units reposition under cover (if smart)

### Gesture Recognition Edge Cases
- [ ] Stroke with jitter noise → Still recognized
- [ ] Very fast stroke → Recognized correctly
- [ ] Very slow stroke → Recognized correctly
- [ ] Stroke with pressure variation (touchscreen) → Pressure ignored, path only
- [ ] Multi-touch (if supported) → Only primary pointer processed

### Multiplayer Desync (Phase 10, if netplay implemented)
- [ ] Both clients compute same state hash at checkpoints
- [ ] Desync detected → Game halts, error shown
- [ ] Stable tier drift → Identifies which subsystem (terrain, RNG) failed

---

## TIER 8: BROWSER & PLATFORM COMPATIBILITY

### Browser Engines
- [ ] Chromium (Chrome, Edge) — v120+: Full features
- [ ] Firefox — v121+: Full features (test RNG determinism, transcendental accuracy)
- [ ] Safari — v17+: Full features (test Canvas 2D, math accuracy)

### Operating Systems
- [ ] Windows 11 (primary dev environment)
- [ ] macOS (Chromium + Safari)
- [ ] Linux (Chromium + Firefox)

### Input Devices
- [ ] Mouse (3-button) with wheel
- [ ] Touchpad (two-finger pan/zoom)
- [ ] Pen/Stylus (if supported)
- [ ] Touch screen (single touch as pointer, multi-touch ignored)
- [ ] Keyboard (all bindings tested)

### Display
- [ ] 16:9 monitors (1080p, 1440p, 2160p)
- [ ] High DPI (2x, 3x pixel ratios) — rendering crisp, no blurring
- [ ] Wide ultrawide (21:9) — UI doesn't stretch
- [ ] Fullscreen mode → No glitches on alt-tab

### Network (if applicable)
- [ ] LAN play → No desync in first 1800 ticks (golden test)
- [ ] Internet play → Latency compensation works
- [ ] Disconnect → Graceful disconnect, can rejoin
- [ ] Reconnect → Replay brings both players in sync

---

## TIER 9: PERFORMANCE PROFILING

### CPU
- [ ] Idle (paused) → CPU ~0%
- [ ] Gameplay (1-stop), 50 squads → CPU <5% (single core)
- [ ] Gameplay, 200+ squads → CPU <15%
- [ ] Headless test (10,000 ticks) → <1 second

### Memory
- [ ] Idle load → <50 MB
- [ ] Playing → <150 MB (50-100 squads)
- [ ] Large battle (200+ squads) → <300 MB
- [ ] Replay playback → No memory leak over 10,000 ticks

### GPU
- [ ] Terrain chunks rendered once per change
- [ ] Live grid drawn every frame (screen-space)
- [ ] Units rendered every frame
- [ ] 100+ units at 60 FPS → GPU <20%

### Network (if applicable)
- [ ] Command packet <100 bytes
- [ ] State sync <1 KB
- [ ] 60 Hz send rate at <100 Kbps bandwidth

---

## TIER 10: REGRESSION TESTS & KNOWN ISSUES

### Historical Bugs (per commits)
- [ ] **"Glyph and cut never overlap"** (928015b) — Verify with visual test: pen stroke never erases unit counter
- [ ] **Enemy commanders have names** (ea71d33) — Load multiple levels, verify each enemy has unique name in UI
- [ ] **Terrain work happens** (0f0a053) — Surgeons reduce casualties, sappers clear obstacles (if feature shipped)
- [ ] **Company carving by half-loop** (9a4b3f8) — Draw half-loop over squad → Squad splits correctly

### Regression Suite
- [ ] Stable tier unchanged (terrain generator, RNG streams)
- [ ] World hash matches unless intentional change documented
- [ ] Add new regression test for each bug fix

---

## TIER 11: DOCUMENTATION & COMPLIANCE

### Idea.txt (Design Source of Truth)
- [ ] All implemented features match Idea.txt
- [ ] Feature order/priority per Idea.txt
- [ ] Aesthetic (parchment, wargame look) matches

### PLAN.md (Roadmap)
- [ ] Features implemented in planned order
- [ ] Completed features marked done
- [ ] No features shipped ahead of plan without approval

### Code Comments
- [ ] No unexplained hacks or TODOs in shipped code
- [ ] Comments explain WHY, not WHAT
- [ ] Movement invariants documented in code
- [ ] RNG usage documented per subsystem

### Test Coverage
- [ ] `npm test` passes (purity + headless + golden)
- [ ] Gesture corpus covers all gesture types + confusion pairs
- [ ] Replay regression suite exercised in CI
- [ ] Console errors on startup: 0 (warnings acceptable in dev)

---

## TEST EXECUTION CHECKLIST

### Before Each Build/Release

1. **Purity & Determinism**
   ```bash
   npm run check:sim    # Must pass
   npm test             # Must pass
   node tools/headless.ts  # All 28 checks pass
   ```

2. **Manual Smoke Tests** (10 min)
   - [ ] Launch game, see home screen
   - [ ] Start new game
   - [ ] Draw move stroke → Squad moves
   - [ ] Draw hold stroke → Squad stops
   - [ ] Draw formation stroke → Formation changes
   - [ ] Pause/resume works
   - [ ] Zoom/pan works
   - [ ] Load and replay saved game
   - [ ] Enemy moves and takes damage
   - [ ] Victory or defeat occurs at expected conditions

3. **Automated Suite**
   - [ ] Unit tests (if any)
   - [ ] Golden hash verification
   - [ ] Gesture confusion matrix diagonal

4. **Manual Full Campaign** (30–60 min, varies per level)
   - [ ] Play one full level to victory
   - [ ] Verify no crashes or undefined states
   - [ ] Observe movement quality (no teleporting, clipping)
   - [ ] Verify combat feels balanced
   - [ ] Check UI responsiveness

5. **Cross-Browser Check** (if automated, run; if manual)
   - [ ] Chrome latest
   - [ ] Firefox latest
   - [ ] Safari (macOS)

---

## Debug Tools & Commands

### Console
```javascript
// View world state
window.war.world

// View camera
window.war.cam

// View current level
window.war.level

// Compute and log state hash
console.log(window.war.hashWorld())

// Run a single tick while paused
// (spacebar first to pause, then . to step)
```

### Headless Testing
```bash
# Run all regression checks
node tools/headless.ts

# Update golden hashes (document why in commit)
UPDATE_GOLDEN=1 node tools/headless.ts

# Preserve stable tier only
# (stable hash should never change; if it does, investigate as bug)
```

### Purity Scan
```bash
# Verify sim has no DOM, no async, no banned Math calls
npm run check:sim
```

### Gesture Testing
```bash
# Test confusion matrix diagonal (move ≠ retreat, hold ≠ patrol, etc.)
# Corpus in tools/gesture-corpus.ts
node tools/headless.ts  # Includes gesture tests
```

---

## Success Criteria

✅ **Every test in this document passes.**
✅ **No console errors on startup.**
✅ **Golden hashes match (or intentionally changed with documented reason).**
✅ **Gameplay feels responsive, smooth, and bug-free.**
✅ **Determinism verified: replay matches original tick-for-tick.**
✅ **Purity scan passes: sim is headless-ready.**

---

## Notes

- Tiers are **not** priority order; run all before shipping.
- Edge cases in **TIER 7** often catch bugs that smoke tests miss.
- **TIER 2** (determinism) is load-bearing; a single RNG or collision bug can cascade into undetectable state corruption.
- Document any intentional hash changes in commit messages (Idea.txt changes, algorithm tweaks, etc.).
- Add regression tests for each bug fix (update `tools/golden.json` + commit message).
