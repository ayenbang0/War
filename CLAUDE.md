# War — project conventions

Top-down tactical RTS web app. Design source of truth: `Idea.txt`. Roadmap: `PLAN.md`.

## Stack
TypeScript + Vite, Canvas 2D. No game engine. No runtime dependencies in `sim/`.

## Directory boundaries (hard rules)
- `src/sim/` — pure simulation. **No DOM, no canvas, no browser globals.** Must run headless in Node.
- `src/render/` — draws sim state. Never writes to sim state.
- `src/input/` — pointer capture, stroke recognition, emits Orders.
- `src/content/` — units, doctrines, levels, formations as plain data.
- `src/net/` — (later) transport only.

`sim/` imports nothing from `render/`, `input/` or `net/`. Enforced by `tools/check-sim-purity.mjs`, and again by the fact that `tools/headless.ts` runs the sim under Node with no DOM at all.

## Determinism invariants
The sim is deterministic lockstep so netplay, replays, and regression tests stay possible. Inside `src/sim/`:

- **`src/sim/math.ts` is the only file permitted to reference `Math`,** and only its exactly-specified members: `floor`, `ceil`, `abs`, `sqrt`, `min`, `max`, `round`, `trunc`, `sign`, `imul`. Every other sim file imports from it.
- **Transcendentals are banned outright, including inside math.ts.** IEEE 754 makes `+ - * / sqrt` bit-exact across engines, but ECMA-262 explicitly leaves `sin`, `cos`, `tan`, `atan`, `atan2`, `pow`, `exp`, `log` and `hypot` implementation-approximated; they differ between V8, SpiderMonkey and JSC, and between versions of one engine. `math.ts` implements them from polynomials (degree-15 Taylor for `sin`, degree-9 minimax for `atan`), so they are deterministic by construction. Accuracy is approximate and that is fine — determinism is the requirement, not precision.
- **Banned: `Math.random`.** Use `sim/rng.ts` — sfc32 seeded by splitmix32, both built purely from exactly-specified 32-bit integer ops. (PCG32 was the original intent; it needs 64-bit state, which JS cannot do without BigInt's overhead.) One independent stream per subsystem, so adding a roll to combat never shifts morale or AI and never invalidates recorded replays.
- **Banned: `Date.now`, `performance.now`, timers.** Sim time is the tick counter only.
- **Banned: iteration whose order affects results** where that order is not insertion-defined. Use arrays, or sort by entity id first.
- Entity ids are monotonic integers from a single counter.

`npm run check:sim` enforces all of the above by static scan; it runs as part of `npm test`.

## Loop
Fixed sim tick at 20 Hz. Render at rAF (~60fps) interpolating between the last two sim states. Orders are serializable commands queued to the next tick boundary — never applied mid-tick.

## Testing
`npm test` runs the purity scan and then `tools/headless.ts`, which exercises the sim with no browser at all. 28 checks across math, rng, replay, terrain and movement.

The regression suite is a command log plus state hashes, kept in `tools/golden.json` in **two deliberately separate tiers**:

- **`world`** — the full state hash after a scripted 1800-tick match. This is *expected* to move whenever a phase changes movement, combat or morale. Regenerate with `UPDATE_GOLDEN=1 node tools/headless.ts` and say why in the commit message.
- **`stable`** — the terrain generator's output and the four PRNG streams. No later phase should change these. A move here is a bug until proven otherwise, and needs `UPDATE_STABLE=1` to rewrite.

The split exists because a single anchor that legitimately moves every commit trains everyone to regenerate reflexively, and then it stops catching anything. Keep the tiers apart.

The same hash function detects netplay desync in Phase 10, and the stable tier tells you which layer drifted.

## Movement invariant
A unit may never advance more than half a tile without re-testing the ground beneath it (`MAX_SUBSTEP` in `world.ts`). Consuming a whole waypoint unchecked lets a unit land wherever the waypoint points — including mid-river — whenever that waypoint falls inside one tick's step budget. Dense paths are not hypothetical: a drawn pen stroke is a dense polyline. Any future pathing layer must keep this bounded-substep shape.

## Art direction
Map-table wargame aesthetic: parchment ground, relief shading, topographic contours, unit counters, ink-drawn strokes. All procedurally drawn — there are no sprite assets in this project.

Static terrain is baked into cached 512px offscreen chunks (a single canvas for the 6144x4096 map would be ~100 MB), capped at 64 chunks LRU and re-baked when `TerrainGrid.revision` changes. Map grid lines are drawn live in screen space instead of baked, so they stay hairline-crisp at every zoom.

## Controls
The **left pointer button belongs to the pen** and is reserved for Phase 2 gesture strokes — never bind camera or UI actions to it. Panning lives on middle/right drag, WASD/arrows, and screen-edge push; the wheel zooms about the cursor. `space` pauses, `.` single-steps while paused. In dev builds `window.war` exposes `{ world, cam, level, hashWorld }` for console poking.
