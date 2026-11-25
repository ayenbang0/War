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
| K1.1 | Kingdom clock | 8 kingdom ticks per day, 30-day seasons, 4 seasons (120-day year); the exile begins on the first day of autumn, year 1, so Act I's first winter is one season away | default (plan fixes only "day = fixed number of ticks") |
| K1.2 | Real-time speed | UI-only: suggested 1× = one day per 2 s, 2×/4× multiply; `.` steps a day when paused | default (B.5 names the speeds, not the rate) |
| K1.3 | Map scale and units | Miles on a 1000 × 700 table; 36 holdings and 52 roads; the king's retinue marches 18 miles a day on a plain road | default |
| K1.4 | Holdings per province | Reach 5, Vale 4, Long Wood 3, Lisle 3, Hallow Ferry 3, Red March 4, Open Fields 4, Stag Heights & Wolf Moor 4, Crow's Reach 3, Crown Seat 3 | default (B.12.2 gives the total) |
| K1.5 | Stag Heights / Wolf Moor | One province (A.3 gives it one row) with two governors: the Stag holds the Heights, the Wolf the Moor, each with a seat | default |
| K1.6 | Factions | 11, each able to own ground: king, usurper, Margrave, the eight captains. A captain's kingdom persona is its battle commander's `bias`/`boldness`; the Margrave's and the usurper's are authored | default |
| K1.7 | Start | The king and Brother Aldous at Cold Hearth, a Reach hamlet he does not own; the whole Reach unclaimed; Rookstead is an empty ruined keep (population 0) to claim first | follows the "start from nothing" amendment |
| K1.8 | Biome → battlefield | Each biome fights like an existing level (reach/moor → Night at the Stones, vale → Proving Ground, forest → Long Vigil, river → The Crossing, river-town → Ferry Road, city → Last Wall, open → Open Field, highland → High Ground, border-hills → Rising Water, coast → The Colours); a holding's own seed is FNV(key) xor that level's seed | default |
| K1.9 | Road surfaces | highway 0.8, road 1.0, track 1.4, ferry 1.5, ford 1.6, forest 1.7, moor 1.8, pass 2.0 effort per mile | default |
| K1.10 | Weather | One kingdom-wide weather a day from the `weather` stream: seasonal integer odds, 55% chance a spell continues; slows every march alike (fog 1.1, rain 1.3, storm 1.6, snow 1.8; snow only in winter) | default (B.3 names weather, not its model) |
| K1.11 | Order issuer | An order's `player` is the faction's index in `FACTION_IDS`; the king is 0 | default, mirroring battle player 0 |
| K1.12 | Kingdom golden | Its own file, `tools/kingdom-golden.json`, regenerated by `UPDATE_KINGDOM_GOLDEN=1`; the battle tiers in `golden.json` are untouched | default (brief) |
| K2f.1 | What the battle AI assumes about an enemy it has not seen (RF-07) | Parity: with no sighting it takes the enemy to be its own strength and nerve. A sighting of a company is remembered for 60 s of sim time, then forgotten; loose men count only while in view | default (audit asked for "visible plus decayed memory", not the prior) |
| K2f.2 | When the map withdraws a last-seen mark (RF-06, RF-10) | After 14 s of sim time, or once the viewer has looked at that ground and found it empty for 3 s, whether the company moved off or died unseen | default |
| K2f.3 | Deployment pen (PC-04) | A stroke that starts on one of your companies carries it (a `place` order, by the point you took hold of); formation glyphs are drawn starting off the company. A short touch on a company still selects it | default (audit's proposed fix) |
| K2f.4 | Text size setting (BS-06) | The browser's own text size and zoom are the setting: rem off a 100 % root, 16 px floor, no in-game slider and no viewport-scaled root | default (audit suggested 18 px; brief fixes 16 px) |
| K2f.5 | Breaks on the map (RF-09) | A struck pennant over any company in view whose seen men are below the company break threshold, enemy as well as own, plus a ring flash in its side colour when it breaks | default |
| K2f.6 | Identity colours (RF-01, RF-02) | Viewer-relative friend/foe roles everywhere (no fixed player-0 blue); the foe also has a pale keyline and dark edge on each man, and diamonds at far zoom | default |
| K2f.7 | Refused stroke (PC-02) | The ink stays for 900 ms, greyed and dashed with the reason beside it; a small shake unless reduced motion is set | default |
| K2f.8 | Canvas label floor (RF-14) | 13 px with a pale halo for map labels, 14 px on a plate for pen labels; control-point names at every zoom | default |
| K2f.9 | Place orders after the battle starts | Ignored; non-setup orders stamped while deploying stay queued for the battle (the commander never issues them) | default |
