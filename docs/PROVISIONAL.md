# Provisional choices

The master plan (`PLAN.md`) leaves some questions open (§A.7, §B.12, §C.7). Where it gives a
recommendation, that recommendation is used. Where it gives none, the choice below was made so the
build could go on. Every line here is provisional: change any of them and say so.

| # | Question | Choice | Source |
|---|---|---|---|
| A.7.1 | Reuse the Margrave and beast captains? | Reuse | plan's recommendation |
| A.7.2 | Who is the usurper? | A third party revealed in Act III: **Chancellor Oswin Vael**, who wrote the Regent's orders and paid the Margrave. Placeholder name. | default (no recommendation) |
| A.7.3 | Player name / portrait | Name chosen at start, default *Aldric of Rimaros*; no portrait; the text never assigns a gender beyond the title "king". | default (plan's placeholder name) |
| A.7.4 | Tone | Dry and humane, as the existing chronicle | plan's recommendation |
| B.12.1 | Kingdom time | Real-time, pausable | plan's recommendation |
| B.12.2 | Scale | 36 holdings; cap of 8 armies per side | default within the plan's 30–50 / ≤8 |
| B.12.3 | Point-buy in the campaign | Replaced by recruitment; skirmish keeps point-buy | plan's recommendation |
| B.12.4 | Auto-resolve for the player | Allowed ("resolve for me"), strictly worse in expectation than fighting | default (B.9 lists it as optional) |
| B.12.5 | Permadeath of the king | Losing the king ends the run (the failure ending); the last autosave can be loaded | default, following A.5 |
| B.12.6 | Multiplayer | A later phase | plan |
| C.7.1 | Gamepad | Not a target; mouse, stylus and keyboard only | default (pen-first design) |
| C.7.2 | Form factors | Desktop web is the target; phone/tablet screenshots are taken but findings there are P2 at most | default (spec says PC web) |
| C.7.3 | Localisation | English only, but every string lives in a table so it could be translated | default (C.4 already asks for tables) |
| C.7.4 | Further skills | Added as extra columns of each audit sheet when supplied | default |
| Start | **From nothing** (user's request, 2026-11-25) | The king starts with no holding, army or coin; first followers are rallied from unclaimed hamlets, the first holding is claimed empty. | user |
| K0.1 | Keys for ability slots past 9 (AB-01) | `0` is slot 10, `-` and `=` are 11 and 12 (numpad mirrors); the bar spans the window and wraps (two rows of 12 at 1280 px). No cap on distinct abilities. | default (audit offered cap-or-wrap) |
| K0.2 | What Esc does on the battlefield with nothing to cancel (GK-01) | Opens a "Leave the battle?" confirm that holds the sim; focus on Stay. Leaving a skirmish or a campaign battle returns to the setup screen with the setup kept, and writes nothing in the chronicle. In the lesson it is "Leave the lesson?" and returns Home. | default |
| K0.3 | How the lesson is kept from ending (BS-05) | The lesson runs no enemy AI at all and a 6-hour world clock; the HUD shows "lesson" instead of a countdown. The level's win condition still applies if the player routs the idle enemy themselves. Sim untouched (config only). | default (audit offered either) |
| K0.4 | Where the storage-refused notice shows (BS-01) | On the chronicle screen and on a campaign battle's report; no global banner over the battlefield. Progress lives in memory for the tab's life. | default |
| K0.5 | Space pause (BH-01) | A HUD state ("PAUSED - space to resume" plus a dimmed field), not a screen on the stack; dialogs and the report hold the sim separately via the stack. | default (audit preferred a stack screen) |
| K0.6 | Setup screen first focus | "Take the field", without scrolling the panel, so Enter starts as the hint says. Covered screens are made `inert`. | default |
| K0.7 | Chronicle "Begin again" at the end | Now also confirms (same dialog as "Start the chronicle over"), then returns Home as before. Esc on the chronicle is Back. | default |
| K0.8 | e2e harness | `e2e.html` ships in `dist`; scenarios use in-memory storage by default so they never touch the real chronicle on the published origin. The stylesheet moved to `src/style.css` so both pages share it. | default |
