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

## Controls

The **left button is the pen**, and it is the only way to command the army.
Draw from one of your squads and it becomes the subject of the order:

| Draw | Order |
|---|---|
| A line out to open ground | **move** |
| A line ending on an enemy | **attack** |
| A line back toward your own edge | **retreat** |
| A small closed loop on the map | **hold** that area |
| A large closed circuit | **patrol** it |
| A glyph *on top of* a squad | **re-form** it |
| A tap on a squad / on the ground | select / clear |

Formation glyphs, drawn centred on the squad: a stroke **across** its front
forms line, **along** its axis forms column, a **chevron** forms wedge, a
**box** forms square.

The interpretation appears as a labelled ghost while you draw — release to
commit, `esc` to abandon.

Camera: middle or right drag, WASD/arrows, or push the screen edge; wheel zooms
about the cursor. `space` pauses, `.` single-steps while paused.

## Why the simulation looks over-engineered

`src/sim/` is a pure, deterministic, fixed-timestep simulation with no access to
`Math.sin`, `Math.random`, the clock, or the DOM. That discipline costs very
little now and buys three things that are extremely expensive to retrofit:
replays, a cheap and total regression suite (record orders, replay, compare one
hash), and lockstep multiplayer. See CLAUDE.md for the rules and the reasoning.
