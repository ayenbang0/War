# U3 (K9): the story's screens — audit

| | |
|---|---|
| **Surface** | The opening cutscene; the tutorial's coach over the map, the town and the drill; the letter card; the chronicle; the map's Menu; the end screens; Home without "Learn the gestures" |
| **Source files** | `src/ui/story/cutscene.ts`, `coach.ts`, `letter-card.ts`, `chronicle-screen.ts`, `menu.ts`, `end-screen.ts`, `stroke-figures.ts`, `signals.ts`, `story.css`; `src/render/story/cutscene-art.ts`; `src/app/app.ts` (beginExile, startTutorial, bring, endTutorial, openMenu, storyEnded); `src/app/kingdom-layer.ts` (openLetterSoon, openChronicle, onStoryEvent); `src/content/story/{cutscene,tutorial,strings}.ts` |
| **Interactions** | watch or skip the film; follow each tutorial step with the real control, or skip it; read a letter and choose; read the chronicle; open the Menu, replay the tutorial, save to Home; reach an ending |
| **Screen contract** | see docs/kingdom.md K9 "Screen contracts": every story screen traps focus and holds the clock; the cutscene and the end screen are full screens, the rest overlays; the coach is not a screen (no focus, no trap) and sits under every dialog |
| **Skills applied** | game-ui-ux (text legibility, choice clarity, focus, Esc, state in words, reduced motion) · game-feel (pacing: nothing read or done is hurried away; every step answers the control at once) |
| **Passes done** | static ✓ · runtime: fake DOM only ✓ (`src/e2e/scenarios-k9.ts`, ui-check), real browser ☐ (none in this environment) · input: keyboard and mouse ✓, touch ☐ · state: first run, skip all, skip a step, replay, Continue, an ending ✓ |
| **Auditor / date** | K9, 2026-11-26 |
| **Build / commit** | branch `k9` |
| **Constraints** | desktop web target; gamepad not a target; phone findings ≤ P2; English only, strings in tables |

## Checks

| Check | Result |
|---|---|
| Text floor and contrast | ✓ story.css: rem only, never under 1rem (ui-check). Narration 1.25rem, #f3ecd9 on #1d1912 (15.6:1); coach #f3ecd9 on rgba(29,25,18,0.94) (≥ 14:1); paper panels #3a3124 on #efe8d6 (10.4:1), secondary #5f5138 (6.3:1) — all above 4.5:1 |
| Skippable, Esc | ✓ the cutscene's Skip is the primary button, Esc skips; the tutorial's steps each skip, the whole asks first with "Keep learning" focused; Esc in the practice realm or drill asks the same (e2e `k9-cutscene`, `k9-drill-esc`) |
| Enter never ends the film | ✓ Next has the first focus, not Skip |
| Reduced motion | ✓ the cutscene's camera cuts and its road is drawn whole; no story animation runs under `prefers-reduced-motion` |
| Real input for every step | ✓ the coach hears only signals the layers send when the control did its thing; e2e walks all 69 steps with real strokes, keys, wheels and drags, none skipped within its lesson |
| What to draw is shown | ✓ a figure of the stroke (`stroke-figures.ts`) with alt text, the step in words, a hint after 12 s |
| Choice clarity (letters) | ✓ each answer is a button with its cost, battle and chance said before it is chosen; a refused answer says why, and is asked again at the press; "Decide later" with what it does |
| Focus and modality | ✓ letter, chronicle, menu: title or first button focused, Tab trapped, clock held; the end screen focuses its title |
| State in words | ✓ the chronicle's goals say "done"/"not yet" in words, not a tick alone |
| Live regions | ✓ cutscene narration and coach text are `aria-live="polite"`; the coach is a labelled region |

## Findings

| Id | Sev | Finding | Status |
|---|---|---|---|
| U3-01 | P1 | Cutscene beats moved on by themselves at up to 7.4 words a second (the Menagerie beat: 52 words in 7 s) — gone before a reader finishes | **fixed**: `beatSeconds` holds a beat at least words/3 + 1.5 s (K9.16); ui-check asserts every beat ≤ 3 words/s |
| U3-02 | P1 | The coach sat over the map's feed and result line (both bottom-left), hiding "that line means nothing…" — the tutorial's own feedback for a stroke that missed | **fixed**: while the coach is up, the feed stands above it (`.s-coached .k-foot`, its height measured each step; ui-check) |
| U3-03 | P1 | "Begin a new exile" on the end screen cleared the ended realm and its chronicle at once, with no confirm (Home's own button confirms) | **fixed**: the same confirm (K9.22; e2e `k9-ending`) |
| U3-04 | P1 | Skipping the letter step left the letter card up, over the next step's map | **fixed**: the coach closes a letter it brought when it moves past that step |
| U3-05 | P1 | The drill's last step ("a stroke that ends on the enemy") could not be done where it was set: on The Crossing the enemy stood out of sight at any range short of a melee | **fixed**: the drill is on the Proving Ground with the enemy set out in sight (K9.15; ui-check: seen, nobody fights unbidden) |
| U3-06 | P1 | The feint step could not be done with the march it teaches: a straight march left a one-point route, which can never be retraced | **fixed** in the pen (K9.21; e2e `k9-tutorial-drill`) |
| U3-07 | P1 | The group verbs (split, grid, cordon) need two companies held, and nothing in the pen held two | **fixed** in the pen (commander.ts): a loop round two whole companies holds them (K9.9; e2e `k9-tutorial-drill`) |
| U3-08 | P3 | The lesson's enemy read "the the Boar's outriders" in the feed | **fixed**: named "Outriders" like every army |
| U3-09 | P3 | End-screen buttons had no `type` | **fixed** |
| U3-10 | P2 | Esc on the end screen goes straight to the front screen. Nothing is lost (saved; Continue reopens the ending) but the epilogue can be left by one key | **fixed K11**: the first Esc focuses Home, the second goes (e2e `k9-ending`) |
| U3-11 | P2 | On a short window the coach (with a figure) can reach the bottom of the city panel | **fixed K11**: the coached city panel is capped above the coach; under 680 px tall the figure folds away |
| U3-12 | P3 | The chronicle opened from the Menu closes to the map, not back to the Menu | **fixed K11** (e2e `k9-letter-and-chronicle`) |
| U3-13 | P2 | No real-browser pass: layout, the coach's height and the cutscene's drawing are proved in the fake DOM only | open (environment) |

No P0 found. Every P1 is fixed.
