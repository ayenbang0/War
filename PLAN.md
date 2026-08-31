# War — build plan

Design spec: `Idea.txt`. Conventions and invariants: `CLAUDE.md`.

## Locked decisions
| Decision | Choice |
|---|---|
| Scope | Full spec, phased |
| Stack | TypeScript + Vite + Canvas 2D, no engine |
| Sim fidelity | Full per-soldier agents (~10-20/squad, ~150-300/side) |
| Gestures | Pure shape recognition, no modifier keys |
| Determinism | Deterministic lockstep from day one; netplay is a later phase |
| Art | Map-table wargame aesthetic, procedurally drawn |
| Input | Mouse-first, stylus-compatible via Pointer Events |
| Setting | Low/medium fantasy medieval |
| Win condition | Global morale rout, else higher global morale at 15:00 |
| Delivery | This doc, then build Phase 0 onward |

## Movement is three layers, never conflated
1. **Squad route** — coarse grid A* / flow field over terrain cost. Ignores soldiers.
2. **Slot assignment** — soldiers claim positions in the formation template, transformed to the squad's position and facing.
3. **Local avoidance** — per-soldier steering against neighbours and obstacles, resolved through a uniform-grid spatial hash (naive pairwise at 600 agents is 180k checks/tick; the hash makes it trivial).

Collapsing any two of these is the standard way formation movement turns to mush.

## Gesture discrimination table
Six gestures from raw strokes collide in three places. Resolve in this order:

| Order | Test | Beats |
|---|---|---|
| 1 | **Attack** | Stroke endpoint hit-tests a visible enemy. Resolved before any shape classification. |
| 2 | **Formation change** | Stroke is drawn *at* the unit (centroid within footprint radius) and template-matches a formation glyph. |
| 3 | **Hold** vs **Patrol** | Both closed. Small enclosed area, single lobe, tight perimeter → Hold. Large area or multi-lobe circuit → Patrol. |
| 4 | **Move** vs **Retreat** | Both open lines. Direction relative to nearest known enemy and own deployment edge decides. |

During the stroke, render the interpreted order as a ghost preview; commit on release. This is not a UI button — spec §11.2 asks for exactly this feedback.

## Phases
Every phase ends at something runnable.

### Phase 0 — Foundation — **DONE**
Vite + TS scaffold, directory boundaries, `sim/math.ts` (polynomial trig), `sim/rng.ts` (sfc32, per-subsystem streams), fixed-tick loop with render interpolation, order queue, terrain generator, headless Node runner, state-hash replay test, purity scanner, chunked terrain renderer, camera.

**Verified:** 22 headless checks pass; the browser reproduces Node's golden hash `f57db420` bit-for-bit over a scripted 1800-tick run; sim cost is 1.0 ms/frame (6% of a 60 fps budget) and 1800 ticks execute in 11 ms.

### Phase 1 — Squads, formations, movement — **DONE**
Squad and per-soldier entities (soldiers in struct-of-arrays), six formation templates, the three movement layers kept strictly separate, uniform-grid spatial hash, A* with deterministic tie-breaks and string pulling, terrain movement cost, the unit roster.

**Verified:** 460 soldiers at **0.20 ms/tick** (248x real time); squads on open ground hold cohesion > 0.85 through a march and a wheel; formations compress around impassable terrain instead of stranding men; no soldier ever ends a tick on water, including via dense paths.

### Phase 2 — Pen control — **DONE**
Pointer-event capture on the left button (world-space from the first sample), RDP simplification, the six-gesture recognizer, ghost preview with commit-on-release, ink rendering, per-order visualization, selection.

**Verified:** the confusion matrix over 85 synthetic jittered strokes is **fully diagonal** — all six gestures plus four formation glyphs and selection, across seven squad facings. All six drive the sim end-to-end through the real pointer path.

Two rules earned their keep and should not be relaxed:
- **The subject rule.** A stroke starting on one of your squads takes that squad as subject and selects it, so ordering is one motion. Anchor tolerance is in **world units, never screen pixels** — otherwise the same stroke means different things at different zooms. Ties break on squad id.
- **Formation glyphs are recognized only when centred ON the squad.** That is what keeps a drawn box from meaning both "form square" and "hold this area". Frontage is deliberately *not* encoded in stroke length: extent is already the hold/patrol discriminator, and overloading it would make a slightly-too-long line flip between two orders.

### Phase 3 — Combat, morale, victory — NEXT
Per-soldier melee/ranged resolution, frontline engagement and rear ranks, formation deformation under contact and re-forming after, squad morale (casualties, flanking, outnumbering, terrain), global morale aggregation, rout, 15-minute timer, win/loss.
**Runnable:** a complete match against a placeholder AI.
*Known design hole to revisit here:* "higher global morale at timer" rewards turtling. Likely fix is morale decay out of contact, or a different tiebreak. Flagged, not solved.

### Phase 4 — Terrain and vision
Forest/hill/river/plain/fortification behaviors, elevation effects on range and speed, bridges as chokepoints, per-unit vision radius, line-of-sight blocking, fog of war for both sides.

### Phase 5 — AI
Aggressive / defensive / maneuver / reactive playstyles, mid-match switching, macro rules (protect objectives, exploit flanks), intent prediction from observed positions under the same fog constraints. Cannot see drawn paths.

### Phase 6 — Army building
Unit roster and costs, point budget, per-type caps, doctrines (aggressive/defensive/maneuver/magic) as army-wide modifiers, deployment-zone placement phase.

### Phase 7 — Magic and special units
Medium-intensity tactical spells: area buffs/debuffs, temporary cover, heal-over-time, morale boosts. Special units tied to doctrines (siege, elite guard, mage, scout).

### Phase 8 — Destructible terrain
Damageable fortifications, burnable/clearable forest, destructible bridges, with pathing and vision invalidation on change.

### Phase 9 — Levels and polish
Level config format (terrain, objectives, AI doctrine, magic intensity, point budget), alternate win conditions as selectable modes, minimal HUD (unit status, global morale bar, doctrine, timer), audio, tutorial.

### Phase 10 — Netplay (optional)
Node relay, matchmaking, lockstep order exchange, desync detection via periodic state hash. Enabled by the Phase 0 determinism work; no sim rewrite required.
