# War

A slow, deliberate top-down tactical RTS for the browser. You command ~15 squads
on a large battlefield by drawing with a pen — no box-select, no click-spam.
Formations, morale, terrain and doctrine decide matches, not APM.

- **Design spec:** [Idea.txt](Idea.txt)
- **Roadmap and locked decisions:** [PLAN.md](PLAN.md)
- **Conventions and hard invariants:** [CLAUDE.md](CLAUDE.md)

## Running

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

`npm test` needs no browser: it scans `src/sim/` for determinism violations, then
runs the simulation headless under Node and checks a scripted 90-second match
against a committed state hash.

## Controls (Phase 0)

Middle or right drag pans, as do WASD/arrows and pushing the screen edge. The
wheel zooms about the cursor. `space` pauses; `.` single-steps while paused.

The **left button is deliberately unbound** — it belongs to the pen, and Phase 2
gives it the six gesture strokes.

## Why the simulation looks over-engineered

`src/sim/` is a pure, deterministic, fixed-timestep simulation with no access to
`Math.sin`, `Math.random`, the clock, or the DOM. That discipline costs very
little now and buys three things that are extremely expensive to retrofit:
replays, a cheap and total regression suite (record orders, replay, compare one
hash), and lockstep multiplayer. See CLAUDE.md for the rules and the reasoning.
