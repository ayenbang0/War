# U4 (K11): the whole game — audit

| | |
|---|---|
| **Surface** | Everything a player meets, front to back: Home (with K11's difficulty choice); the cutscene; the tutorial's coach over the map, the town and the drill; the kingdom map (top bar, resources, feed, key fold, cards, menus, rumour, event, contact, letter, chronicle, Menu); the city view; the battle (deployment, the pen, the ability bar and K11's gate button, the HUD, the leave confirm); the after-action report; the end screens |
| **Source files** | `src/ui/**`, `src/app/**`, `src/render/**`, `src/input/**`, `src/audio/sound.ts` (new), the CSS (`src/style.css`, `src/ui/kingdom/kingdom.css`, `explore.css`, `src/ui/story/story.css`, the city sheet) and every string table under `src/content/` |
| **Interactions** | the whole loop: a new exile on each difficulty, the tutorial (all 69 steps), forage/rally/claim, build/sow/tax, armies and the pen's map vocabulary, mercenaries, politics, a meeting and its battle, a siege from both sides, letters, an ending; the Menu's sound |
| **Screen contract** | as the per-surface sheets (U1, U2, U3, K5, K8, K10) and docs/kingdom.md; nothing new is a screen except none — the gate button is a bar button, the sound controls live inside the Menu |
| **Skills applied** | every Appendix skill: game-ui-ux · game-feel · camera-systems · game-ai · create-game-assets |
| **Passes done** | static ✓ (all sources and sheets re-read) · runtime: fake DOM ✓ (52 e2e scenarios; ui-check; the headless suites) · real browser ☐ in this environment (the matrix below is what the next browser run must capture) · input: keyboard and mouse ✓, pointer-only for every battle order ✓ (K10-05 fixed), touch ☐ · state: first run, each difficulty, a save from v11, paused queues, an ending ✓ |
| **Auditor / date** | K11, 2026-11-26 |
| **Build / commit** | branch `k11` |
| **Constraints** | desktop web target; gamepad not a target; phone findings ≤ P2; English only, strings in tables; no browser in this environment, so no screenshots are archived here |

## The screenshot and state matrix

There is no browser in this environment, so this is the matrix to capture, not a capture. The
next browser run (`npm run e2e` with a real Chromium) archives one PNG per cell under
`docs/audit/u4-shots/<screen>-<w>x<h>.png`. Sizes: **1920×1080** (the reference), **1440×900**,
**1280×720**, **1024×640**, **800×600**.

| Screen / state | What to check at every size |
|---|---|
| Home, first visit (no save) | the three difficulty buttons fit on one or two rows; Gentle is pressed (bold, bordered); the blurb under them names the pressed one; nothing clipped; the panel scrolls at 800×600 rather than cuts |
| Home, with a save | Continue is first and focused; the difficulty choice says it applies to a new exile only |
| Cutscene | narration legible (≥ 1.25rem), Skip and Next both visible above the fold, the art scales |
| Coach over the map (map lesson) | the coach never covers the feed or the result line; strokes drawn **under** it reach the map (the K11 real-browser fix) |
| Coach over the city (town lesson) | at 1024×640 and 800×600 the city panel stops above the coach; under 680 px tall the figure is folded away (U3-11) |
| Coach over the drill | the split step's line can start anywhere on the field, under the coach included |
| Kingdom map, opening zoom | province names never overlap (U1-R1); at 1024×640 and 800×600 the key hint is the folded "Keys" tab, not the panel (U1-R2); top bar wraps without hiding the clock |
| Kingdom map, a meeting waiting | the dashed ring at the meeting point shows round the dialog's edge or beside it; the dialog fits |
| Region card (king's holding) | the defence-cost line (levy / burn) wraps inside the card; buttons reachable without scrolling the map |
| Build / sow menus while paused with an order queued | the second unaffordable choice reads "already promised to orders waiting on the clock" |
| Army card and its menus | company names read "Harker's Outriders dig in", never "The Harker's…" |
| Rumour card over the city view | it opens over the city (KA-06), the city stays below |
| Letter, chronicle, Menu | the Menu shows the difficulty line and the sound row (Sound: on · Quieter · Volume 25% · Louder) without wrapping off the panel at 800×600 |
| City view | lots and fields legible at min zoom (C-10), the panel and bottom sheet both fit (C-09) |
| Battle, deploying | HUD lines, the ability bar; in a siege the gate button is present but greyed until Enter |
| Battle, a siege defended | the gate button reads "Open the gates" / "Shut the gates" with the state; the HUD's "G to open" agrees |
| After-action report | the realm lines fit; the Back button focused |
| End screen | epilogue legible; the first Esc lands on Home, the second leaves (U3-10) |
| Reduced motion (each size once) | no pulse at a meeting, camera cuts; **sound still plays** (it is independent of the setting) |

## Checks, by skill

### game-ui-ux

| Check | Result |
|---|---|
| Text floor | ✓ every CSS file re-read: every font size is rem or a `--text` token, none under 1rem (ui-check keeps style.css to it; the rest re-read by hand) |
| Contrast | ✓ unchanged palettes (U1–U3 measured ≥ 4.5:1); the new meeting ring is a mark, not text; the difficulty choice's pressed state is bold and bordered, not colour alone |
| State in words | ✓ difficulty: aria-pressed and the blurb; sound: "Sound: on/off" with aria-pressed and "Volume N%" in a live region; the gate button's label is its next action and its state ("Open the gates" while shut) |
| A refused choice says why | ✓ the new "promised to orders waiting on the clock" (U2-05); the gate button greys (disabled) while it cannot swing, and the HUD says why a gate stays open on men (K10-04) |
| Every control reachable by pointer and by key | ✓ gates were the last keyboard-only battle control (K10-05, fixed); the key hint folds but is a click away |
| Esc has one meaning per screen | ✓ end screen fixed (U3-10); the chronicle from the Menu returns to the Menu (U3-12) |
| Focus never left on a game button | ✓ the gate button blurs after a press (as the ability buttons do) so Space and the digits still reach the game; the Keys fold's tab blurs too |
| Grammar of said-lines | ✓ company names (M-09) |
| Feed chattiness | ✓ a rally is one line (U2-09) |

### game-feel

| Check | Result |
|---|---|
| Every commit answers at once on more than one channel | ✓ K11 adds sound to the ink and the HUD text: a stroke heard has a rising pair, a refusal a low fall, a march its drum, a tap a tick (PC-09's "no audio anywhere in src/" is closed) |
| Impact beats | ✓ a clash when steel meets steel in view (throttled to one per 220 ms); a pulse where armies meet on the map (KD-03); a chime for a building standing or a harvest in (U2-10) |
| Pacing of news | ✓ a letter has its seal and bell; the season turning has three slow notes; none repeats faster than its rest (`CUE_GAP_MS`) |
| Juice never touches the sim | ✓ sound is played by the layers from what the sim already said; ui-check proves no `src/sim` file mentions `audio/` |
| Defaults that respect the player | ✓ on, at 25%, remembered on the device; independent of reduced motion (ui-check: the module never asks) |

### camera-systems

| Check | Result |
|---|---|
| An off-screen event is signposted | ✓ the meeting ring (KD-02) under the contact dialog, and the camera already flies there |
| Labels never fight | ✓ province names are placed against each other (U1-R1); the holding labels already culled by priority |
| HUD never covers the thing it describes | ✓ the key fold (U1-R2); the coach under the city panel (U3-11) |

### game-ai

| Check | Result |
|---|---|
| The machine is beatable and readable on every difficulty | ✓ tools/kingdom-difficulty.ts: on Gentle every strategy keeps a holding two years; on Standard a passive king is fed through the first year and loses his one holding to the Hare's wave in year two (by design, K11.4); Hard falls no later than Standard |
| The machine does not cheat | ✓ the difficulty scales only the king's own economy and the captains' timing; the AI still reads a Perception (graceDays now comes through it) |
| Sieges | ✗ K10-06 (P3) the machine never sallies; left: it is battle-AI work that would move the battle goldens (K11.10) |

### create-game-assets

| Check | Result |
|---|---|
| Assets made in code, one style | ✓ sound joins the art in being generated (oscillators and noise, no files); the gate button's mark is a glyph like the abilities' |
| Palette in one module | ✗ U2-08 (P3) three icon colours are literals in icons.ts; left, cosmetic |

## Findings

| Id | Sev | Finding | Status |
|---|---|---|---|
| U4-01 | P1 | In a real browser the tutorial's coach swallowed every stroke that began under it: at 1280×720 the drill's split step starts at the field's left edge, under the coach, so the step could not be done (`k9-tutorial-drill` failed waiting on drill-split) | **fixed** (805bd89): the coach is `pointer-events: none` except its buttons; ui-check holds the rule |
| U4-02 | P1 | Resources were hard to manage for a new player (the owner: "a lot easier") with no way to choose | **fixed**: Gentle/Standard/Hard, Gentle the default (K11.1–K11.4); sweeps in npm test |
| U4-03 | P2 | No sound anywhere (PC-09) | **fixed**: src/audio/sound.ts, eight cues, Menu controls |
| U4-04 | P2 | The difficulty of a running realm is nowhere to be read | **fixed**: the Menu says it under its title |
| U4-05 | P3 | Sound can be muted only from the map's Menu, not from inside a battle | open: the battle has no menu of its own; a battle is minutes long and the setting holds across it |
| U4-06 | P3 | Buttons built in `keys.ts`, `after-action.ts`, `dialog.ts`, `ability-bar.ts`, `home.ts` carry no `type` | open: none sits in a form, so none can submit; cosmetic |
| U4-07 | P2 | No real-browser pass of the matrix above | open (environment), as U3-13, KA-09, C-09/C-10, M-08, P-05 |

No P0 found. Both P1s are fixed. Every P2/P3 from the earlier sheets is now fixed or left with
its reason in its own sheet (and listed in docs/kingdom.md K11).
