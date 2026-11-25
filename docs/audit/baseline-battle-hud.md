# U0 baseline audit: Battle HUD, ability bar, after-action report, global keys

- **Surfaces:** Battle HUD (`src/main.ts` `drawHud` and `frame`, `index.html` `#hud`); ability bar (`src/ui/ability-bar.ts`); after-action report (`src/ui/after-action.ts`); global keys (every `keydown`/`keyup` listener in `src/`).
- **Sources read:** `src/main.ts` (all), `index.html` (all), `src/ui/ability-bar.ts`, `src/ui/after-action.ts`, `src/input/pen.ts`, `src/input/camera-controls.ts`, `src/input/commander.ts` (arm/commit), `src/ui/tutorial.ts` (`lines()`), `src/sim/world.ts` (`step`, `armyMorale`, `soldiersOf`), `src/content/army.ts` (caps), `docs/PROVISIONAL.md`.
- **Skills applied:** game-ui-ux (main lens), game-feel, camera-systems, game-ai, create-game-assets. The principles are translated to DOM/Canvas: "focus owner" means `document.activeElement`, and the "screen stack" is the K0 screen stack.
- **Pass:** static only. Nothing here was run in a browser.
- **Date:** 2026-11-25
- **Policy:** desktop web is the target. Gamepad is not a target (P3 info only). English only, but strings should live in tables.
- **Contrast:** ratios are WCAG values computed from the CSS colours. Translucent backgrounds were blended over the `#d9cbb0` page base.

## Key ownership map

All of these listeners sit on `window`. They are attached once the menus resolve and are never removed. None of them checks `e.target`, `document.activeElement`, `e.repeat` or `e.isComposing`.

| Key | Owner (file:line) | When active | Conflict |
|---|---|---|---|
| Enter | main.ts:265 | deploying | `NumpadEnter` ignored |
| Escape | main.ts:268 (reloads page) | tutorial, always | **clashes with pen.ts:98** (cancel stroke) |
| Escape | pen.ts:98-104 | while drawing | in the tutorial both run, so the page reloads |
| Digit1..9 | main.ts:270-276 (`e.code`) | not deploying | Digit0 maps to -1 (ignored); numpad ignored; slots 10-12 unreachable |
| F2 | main.ts:277 | always | auto-repeat toggles it |
| Space | main.ts:280 (`preventDefault`) | always | fights native activation of a focused `<button>` (ability, report) |
| Period | main.ts:283 | paused | none |
| w a s d, arrows | camera-controls.ts:55-76 (`e.key`, keydown + keyup) | always, even under a modal | layout-dependent (`e.key`), unlike main.ts (`e.code`) |
| (blur) | camera-controls.ts:36 clears keys | always | pen has no blur handler |
| Tab, Space/Enter on buttons | browser default | always | no focus management (see AA-02) |

## Findings

| id | sev | skill rule | evidence | proposed fix | owner |
|---|---|---|---|---|---|
| GK-01 | P1 | game-ui-ux: one input owner per context; Esc = back | main.ts:268-269 `e.code === "Escape" && tutorial` calls `window.location.reload()`. pen.ts:98-104 documents Esc as "abandons a stroke mid-draw". Both listeners fire on the same press, so cancelling a stroke ends the lesson, with no confirmation. | One key router with contexts. Esc cancels the stroke if one is being drawn, else disarms an armed ability, else opens a pause/leave screen that asks for confirmation. | K0 |
| BH-01 | P1 | game-ui-ux: state must be visible; game-feel: feedback on every input | main.ts:280-282 toggles `paused`, but `drawHud` (443-510) never reads it. Nothing on screen says the game is paused. An accidental Space looks like a freeze. | Add a "PAUSED: space to resume" line and dim the canvas while paused. Better, make pause a screen on the K0 stack. | K0 |
| AA-01 | P1 | game-ui-ux: screen stack (push/pop, no reload) | main.ts:364 passes `() => window.location.reload()` as `onAgain` for both labels, "Fight again" and "Continue the chronicle" (after-action.ts:137). A reload lands on the home screen with the setup lost. The label promises a different destination. | Pop to the screen the label names (the chronicle, or the menu pre-filled with the last setup) through the screen stack. | K0 |
| AB-01 | P1 (runtime: confirm) | game-ui-ux: anchors/containers; full keyboard reachability | There are 12 abilities and no cap on distinct ones (army.ts:33 caps copies per ability only). Keys reach Digit1-9 only (main.ts:273-274). The bar is one centred flex row that never wraps (index.html:133-137, `left:50%; translateX(-50%)`), so 10-12 slots at about 150 px each can overflow both edges at 1280 px. Slots 10-12 would then be reachable by neither key nor click. | Cap distinct abilities at 9 in `validate`, or let the bar wrap/scroll inside the safe width, and map Digit0 to slot 10. | K0 |
| GK-02 | P2 | game-ui-ux: focus owner decides who gets the key | main.ts:280-282 calls `preventDefault` on Space at window level. When Tab has focused "Fight again" or an ability button, Space toggles pause behind it and probably suppresses the click (runtime: pending). | Route keys only when `document.activeElement` is the body/canvas. Let buttons keep Space/Enter. | K0 |
| GK-03 | P2 | game-ui-ux: only the top screen takes input | camera-controls.ts:55-61 and main.ts:264 run under the after-action modal: WASD pans behind it, digits arm abilities (main.ts:270 checks only `deploying`), and F2 and Space still toggle. | Each screen declares its active input contexts. The battle context is off while a modal is up. | K0 |
| GK-04 | P2 | game-ui-ux: input ownership / device coexistence | camera-controls.ts:56, 73-76 bind on `e.key` (`"w"`, `"a"`), which is layout-dependent, so AZERTY users get scattered keys. main.ts binds on `e.code`. The two modules disagree. | Bind physical keys on `e.code` everywhere, in one binding table. | K0 |
| GK-05 | P2 | game-feel: an input should do one thing per press | main.ts:277-282 does not check `e.repeat`. Holding Space or F2 auto-repeats and flickers pause or debug. | Ignore `e.repeat` for toggles. Allow it only for `.` single-step if that is wanted. | K0 |
| GK-06 | P2 | game-ui-ux: Esc = back/cancel | commander.ts:168-172: only re-pressing the same digit or button disarms. pen.ts:99 returns unless drawing, so Esc does nothing to an armed ability, which then eats the next stroke. | Esc disarms (via the router in GK-01). Right-click could also disarm. | K0 |
| GK-07 | P2 | game-ui-ux: screen stack (pause, settings, confirm) | Outside the tutorial, Esc is a no-op (main.ts:264-287). There is no pause menu, no settings screen and no way to quit to home mid-battle except a browser reload. | A pause screen on the stack with resume, settings and leave (with confirmation). | K0 |
| FL-01 | P2 (runtime: river) | game-ui-ux/feel never mutate sim; CLAUDE.md "orders ... never applied mid-tick" | main.ts:381-403 writes `world.soldiers.x/y` straight from the render loop during deployment. The drag is not an Order, so it is unrecorded for replay/netplay. Only the stroke tip is zone-checked (`inDeploymentZone`), not the terrain under each man, so men may be dropped on water. | Make placement an Order applied at the tick boundary, and validate each soldier's tile. | K0 |
| BH-02 | P2 | game-ui-ux: drive the HUD from events, not polling | main.ts:430 `drawHud()` runs every frame and rewrites `hud.textContent` (509) even when nothing changed. It calls `soldiersOf` (world.ts:830) and `armyMorale` (world.ts:803), two full 4096-slot scans that allocate arrays every frame. `AbilityBar.update` (ability-bar.ts:91-104, called from main.ts:377) rewrites 2 text nodes per slot per frame. | The sim emits `moraleChanged`, `strengthChanged`, `abilityStateChanged` and `paused`. The HUD subscribes, sets its initial values once, and writes on change only. | K2 |
| BH-03 | P2 | game-ui-ux: 18 px floor at 1080p on PC, scalable to 200 % | Sizes: `.panel` 11px (index.html:11); `#hud` 13px mono (20); ability bar 12px (136); report body 13px with 11px h2 (25, 38); ability key 15px. There is no text-size option. | One type scale from the K0 scaling policy: 18 px minimum for gameplay text, plus a user text-size setting. | K0 |
| BH-04 | P2 | game-ui-ux: one scaling policy; safe-area inset | The HUD is fixed at `left:12px; top:12px` (index.html:20) and the bar at `bottom:14px`. There is no `env(safe-area-inset-*)`. DPR handling is canvas-only, capped at 2 (main.ts:224), and DOM panels do not scale with the viewport. | Set a reference size (1920x1080), a scale factor for DOM panels and safe-area insets. Reapply on resize. | K0 |
| BH-05 | P2 | game-ui-ux: localisation-ready (strings in tables) | Sentences are built by concatenation in `drawHud` (main.ts:457-496, e.g. `"holding " + n + "/" + m + "   " + s + "s of "`), in after-action.ts:63-132, in commander.ts:174-180 and in ability-bar.ts:62. Only `CAUSE_LABEL` (after-action.ts:28) is a table. | A string table with named placeholders. The kingdom HUD reuses it. | K2 |
| BH-06 | P2 | game-ui-ux: consistent, labelled readouts | The HUD clock is unlabelled and counts *down* (`left = duration - t`, main.ts:445-450). The report's times count *up* (`minuteOf(tick)`, after-action.ts:30-33, e.g. "broke 3:12"), so a player cannot match the report to what they saw. | Label the HUD clock ("12:34 left") and print both clocks in the report, or use one base. | K11 |
| BH-07 | P2 | game-feel: distinct feedback per outcome | There is one message slot. Refusals ("not ready", "none left", commander.ts:175-177) share text and style with successes. `pen.lastAction` never expires (main.ts:496). A break notice hides an order's confirmation for 4.2 s (main.ts:490-496). | Separate the confirmation and warning channels (icon or style, not colour alone). Let messages expire. Queue messages instead of overriding them. | K11 |
| BH-08 | P2 (runtime) | game-feel: large-tier events get a bundle (sound, flash, camera) | A company breaking reaches the HUD only as one 13 px line, `name + " broke - " + cause` (main.ts:347-352, 490-495). Whether the renderer adds a visual is runtime: pending. | Give breakage a medium/large feedback bundle: a marker at the company, a sound, and an off-screen indicator (camera-systems). | K11 |
| AB-02 | P2 | game-feel: every click gets feedback | ability-bar.ts:81-84 throws away the return value of `commander.arm(id)`, so clicking a spent or cooling ability gives no message. The key path shows it (main.ts:275 `pen.lastAction = commander.arm(...)`). | Route both paths through one `armAbility()` that reports the result. | K11 |
| AB-03 | P2 | game-ui-ux: 4.5:1 for gameplay text; not colour alone | Contrast: `.ability-key` #8a7856 at 3.19:1, `.ability-count` #7a6848 at 4.01:1, and the `.spent` state (opacity .42) at about 2.3:1 (index.html:147-155). Spent and cooling share one class (ability-bar.ts:102) and differ only by the seconds text. | Darken the label colours. Give spent and cooling distinct styles plus a shape (strike or hatch for spent, a sweep for cooling). | K11 |
| AB-04 | P2 | game-ui-ux: consistent state rules across input paths | The click path arms during deployment (no check in ability-bar.ts:81), but the digit path is blocked (main.ts:270). The armed ability then eats the next deployment drag stroke ("not until the battle begins", commander.ts placeArmed). | Disable the buttons (`disabled`) while deploying. Apply one rule to both paths. | K11 |
| AA-02 | P2 | game-ui-ux: focus on open, focus trap, Esc/Enter | after-action.ts:137-142 gives the panel no initial `focus()`, no trap and no Enter/Esc handling. There is no `role="dialog"` or `aria-modal`. Only home.ts:102 focuses anything in the whole UI. | On open, push the report on the stack and focus the primary button. Trap Tab inside it, Enter activates, and focus returns to the prior element on close. | K0 |
| AA-03 | P2 | game-ui-ux: contrast 4.5:1 | Contrast: `.aa-fate` #8a7856 on #efe8d6 at 3.51:1; `h2` 11px #8a7856 at 3.23:1; `.aa-detail` #7a6848 at 4.05:1 (index.html:36-39, 59-60). | Darken to at least #6b5c40 (4.9:1). | K11 |
| AB-05 | P3 | create-game-assets: owned and consistent icon set; one source | Ability marks are font glyphs (⚇ ♆ ⁂ ♨ ◧), which may render as tofu or in mixed fonts (runtime: pending). The map is duplicated in menu.ts:19-32 and ability-bar.ts:22-35. | Draw the marks procedurally, like the counters, from one exported table in `content/abilities.ts`. | K11 |
| AB-06 | P3 | game-ui-ux: accessibility | The armed state is a class only (no `aria-pressed`). Labels are tooltips via `title` only (ability-bar.ts:62). | Add `aria-pressed`, a visible blurb on hover/focus, and `aria-label`. | K11 |
| AB-07 | P3 | game-feel: small-tier feedback on state change | Nothing marks an ability coming off cooldown. The text silently clears (ability-bar.ts:99). | Add a brief pop on the slot when it is ready. | K11 |
| AA-04 | P3 | game-ui-ux: no silent truncation; consistent terms | The breakage log is cut to `slice(0, 6)` with no "and N more" (after-action.ts:131). `minuteOf` hard-codes 20 instead of `TICK_RATE` (31). The verdict wording "Stalemate" differs from the HUD's "DRAW" (main.ts:489). | Show a count of the rest, import `TICK_RATE`, and use one term. | K11 |
| AA-05 | P3 | game-feel: beat before a layer transition | The report opens on the very frame `world.outcome` is set (main.ts:357-367) and covers the field at the decisive moment. | Hold about 1-2 s with the HUD verdict, then fade the report in (and respect reduced motion). | K11 |
| BH-09 | P3 | game-ui-ux: accessibility | The morale bar is built from U+2588/U+2591 characters (main.ts:452-454). There is no `aria-live` region for the break notices. | Use a real bar element with a label, and a polite live region for notices. | K11 |
| BH-10 | P3 | game-ai: legibility of the opponent | The HUD shows neither your doctrine nor the opposing commander (the PLAN §C.2 inventory says "doctrine"; it is not drawn). The enemy commander is named only after the battle (after-action.ts:65-67). F2 shows `world.ai[0].style` (main.ts:506) for debugging only. | Decide whether "who you face" belongs on the deployment HUD. Correct the inventory row. | K11 |
| GK-08 | P3 | game-ui-ux: input coverage | The numpad digits and `NumpadEnter` are ignored (main.ts:265, 270). | Accept both in the binding table. | K11 |
| GK-09 | P3 | game-ui-ux: window blur | There is no auto-pause on `blur` or `visibilitychange`. The rAF clamp (main.ts:313, 341) hides most of this. The break notice fades on real time while paused (main.ts:490). | Auto-pause on hidden/blur, and age notices by sim time. | K11 |
| GK-10 | P3 info | game-ui-ux: gamepad focus | There is no gamepad support anywhere. It is not a target (PROVISIONAL C.7.1). | None for now. | K11 |

**Count:** P0 0, P1 4, P2 19, P3 10 (total 33).

## Hypotheses (PLAN §C.5)

| Hypothesis | Verdict on these surfaces |
|---|---|
| Zero `aria-*`/`tabindex`/`role` | **Confirmed.** A grep finds 0 hits in index.html, main.ts, ability-bar.ts and after-action.ts (and in all of `src/`). The only focus call in the UI is home.ts:102. |
| HUD/overlay type is 11-13px monospace on parchment | **Confirmed.** `.panel` is 11px; `#hud` 13px; the ability bar 12px; the report 13px with 11px headings. All are `ui-monospace` on translucent parchment. The HUD body text itself passes contrast (about 7.7:1, or about 6:1 over darker relief). The secondary labels fail (AB-03, AA-03). |
| No `prefers-reduced-motion`/`@media` in index.html | **Confirmed.** There are 0 `@media` rules and 0 `matchMedia` calls. These DOM surfaces have no CSS animation today, so the gap bites in canvas effects and in AA-05 once a transition is added. |
| Ad hoc keyboard handling (main.ts:264, pen.ts:44, camera-controls.ts) | **Confirmed.** There are three independent `window` listeners (plus a keyup and a blur in camera-controls.ts:34-36). They use mixed `e.code` and `e.key`, and there is no router, binding table or context. |
| One keydown per module leads to overlapping key ownership | **Confirmed, narrowly.** The key sets are mostly disjoint. The real collisions are Escape (main and pen, GK-01) and Space against a focused button (GK-02). The structural overlap is that every listener is always live regardless of which screen is up (GK-03). |
| Colour carries player/enemy identity | **Refuted for these surfaces.** The HUD is monochrome. The report's verdict colour (blue/red) is backed by distinct text, and the armed ability has a ring as well as a tint. Unit identity colour is in `render/*` (another sheet). |

## Runtime pass: pending

- AB-01: the width of the bar with 10-12 abilities at 1280x720 and 1920x1080, and whether slots clip.
- GK-02: whether Space on a focused "Fight again" or ability button activates it, given the window-level `preventDefault`.
- FL-01: dragging a selected group over a river during deployment, and whether men land on water.
- BH-08: whether a breakage has any on-field visual or sound.
- AB-05: glyph rendering (tofu) on Windows/Chrome, macOS/Safari and Linux/Firefox.
- BH-03/BH-04: screenshots at 1280x720, 1920x1080, 2560x1080 and 1080x2340, and at 200 % text zoom. Check for HUD overflow from the 58-column tutorial lines (`white-space: pre`).
- Keyboard-only pass: Tab order through the ability bar and report, visible focus style, and Esc/Enter on the report.
- State pass: 45 squads in "Your companies", 12 abilities, pause then blur then resume, resize mid-stroke, window blur mid-stroke (the pen has no blur handler), and `localStorage` refused at `noteBattle`.
- Perf: frame cost of the per-frame `soldiersOf`/`armyMorale` scans and DOM rewrites at 4096 soldiers (BH-02).
