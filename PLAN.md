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

**Group verbs** (added on request): with two or more squads selected and the stroke drawn clear of any squad, a straight line **splits** the selection (squads visually left of the stroke are kept, so drawing it the other way keeps the other half); a second parallel line within 1.2s instead lays the group out in **rows and columns**; a large circle becomes a **patrolled area** with the squads spread around one ring as a cordon; and a heart is **recover** — 30 seconds of morale and hit-point regeneration during which the squad accepts no orders at all. The lock is enforced in the simulation, not the UI, so it binds the AI and replayed order logs equally.

Three rules earned their keep and should not be relaxed:
- **The subject rule.** A stroke starting on one of your squads takes that squad as subject and selects it, so ordering is one motion. Anchor tolerance is in **world units, never screen pixels** — otherwise the same stroke means different things at different zooms. Ties break on squad id.
- **Formation glyphs are recognized only when centred ON the squad.** That is what keeps a drawn box from meaning both "form square" and "hold this area". Frontage is deliberately *not* encoded in stroke length: extent is already the hold/patrol discriminator, and overloading it would make a slightly-too-long line flip between two orders.
- **The anchor never claims a large closed stroke.** A ring or a heart drawn across your own line inevitably begins on top of some squad; letting that set the subject turned "recover this group" into "that one squad, patrol". Small closed strokes still anchor, because a drawn box is how a formation glyph is written.

Hearts are told from rings by **convex hull fill**, not by counting concave corners. Corner counting is the obvious approach and it does not survive RDP: the notch is a fine feature, the simplification tolerance scales with stroke size, and on a large heart the cusp is smoothed away entirely — so the same gesture read as a heart at one size and a ring at another. Measured over the corpus, rings fill 0.983–1.000 of their hull and hearts 0.926–0.932.

### Phase 3 — Combat, morale, victory — **DONE**
Per-soldier melee/ranged resolution, frontline engagement and rear ranks, formation deformation under contact and re-forming after, squad morale (casualties, flanking, outnumbering, terrain), global morale aggregation, rout, 15-minute timer, win/loss.
**Runnable:** a complete match against a placeholder AI.
**Turtling: settled.** Morale only ever falls through fighting, so "higher morale at the timer" made not fighting the dominant strategy. Rout is untouched — it is still the instant loss you chose. The timer tiebreak now scores morale **plus the share of the enemy army destroyed**, weighted equally: at parity, wiping out the enemy is worth exactly as much as ending the match untroubled, and an army that inflicted nothing scores its morale and nothing else. A "tiebreak nudge" weight does not work, because any weight small enough to be a nudge leaves hiding dominant.

Three things here would have passed a naive suite and still been wrong:
- **Damage is buffered and applied simultaneously.** Resolving in index order lets player 0, who holds the lower soldier indices, strike first in every mutual engagement and win coin-flip trades — deterministic, reproducible, and silently unfair.
- **Formation slots re-derive from the LIVING count** on every casualty. Otherwise a squad keeps gaps where its dead stood while cohesion still reads 1.00, because cohesion only ever counts survivors.
- **Army morale weights squads by their original roster, not current strength.** Weight by strength and a squad that is wiped out drops to zero morale and zero weight at the same instant, falling clean out of the average — so destroying an enemy squad outright barely moves their army morale.

Ranged attacks pick a target **squad** first and only then a soldier. The soldier spatial hash has 14-unit cells sized for separation distance; a 250-unit bow sweeping that grid would touch hundreds of cells per soldier per tick.

**Verified:** 97 checks. A mirrored 120-second battle trades 65 vs 80 casualties with morale falling to 93%/84%; mutual kills land simultaneously; archers engage without closing; survivors re-form into a tightened line.

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
