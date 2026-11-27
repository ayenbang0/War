# K5: descent — contact interstitial, battle handoff, the realm in the report

| | |
|---|---|
| **Surface** | The K5 surfaces: the **contact interstitial** (fight / withdraw / resolve for me), the **story battle** a fight goes down into (deployment as a confirm, the leave confirm), the **after-action report's realm section** and "Back to the map", the **feed lines** for contact, withdrawal, resolve and walls taken, and the return to the map |
| **Source files** | `src/ui/kingdom/contact-dialog.ts`, `src/ui/kingdom/consequences.ts`, `src/ui/after-action.ts`, `src/app/kingdom-layer.ts` (contact section, `suspend`, `resumeAt`), `src/app/app.ts` (story origin: `descend`, `settleStory`, `battleEnded`, `requestLeave`, `leaveLayer`), `src/content/kingdom/descent-strings.ts`, `src/ui/kingdom/explore.css`, `src/style.css` |
| **Interactions** | march an army into the Hare's riders (or a hostile walled holding); read the two sides; choose; fight the battle (or leave it); read what it meant for the realm; come back up |
| **Screen contract** | interstitial: overlay, first focus the title (`#k-contact-title`, tabindex −1), traps focus, pauses the sim, inputs `ui` only, Esc does nothing (K5.14). Leave confirm: the shared `confirmScreen` (safe button first focus, Esc = stay). Report: first focus "Back to the map" |
| **Skills applied** | game-ui-ux · game-feel · camera-systems · game-ai (the enemy side's commander and difficulty, K5.10) |
| **Passes done** | static ✓ · runtime ☐ (no browser in this environment) · input: keyboard and mouse by the e2e fake ✓ (`k5-descent-fight`, `k5-descent-withdraw`, `k5-descent-resolve`), touch ☐ · state: field contact, assault, cut off, pending contact across a reboot, leave mid-fight ✓ |
| **Auditor / date** | K5, 2026-11-25 |
| **Build / commit** | branch `k5` |
| **Constraints** | desktop web target; gamepad not a target (P3 info); phone findings ≤ P2; English only, strings in tables |

## Checklist results (static)

### game-ui-ux

| Check | Result |
|---|---|
| Anchored layout, flex/grid, no fixed English widths | ✓ the interstitial reuses `.k-menu` / `.k-event` (centred flex, `max-width` in rem); `.k-contact-sides` is a `dl` in flow |
| One scaling policy; text ≥ 16 px | ✓ rem throughout; body text inherits 1rem, titles 1.3125rem; the report's realm list inherits `--text` |
| Focus on open | ✓ the title, so a screen reader hears who met whom first and a stray Enter cannot choose |
| Tab order = reading order | ✓ fight, withdraw, resolve, in DOM order; each button `aria-describedby` its cost line |
| Trapped focus | ✓ `trapsFocus: true`; the HUD below is inert to keys (`inputs: ["ui"]`) |
| A button never promises what the sim refuses | ✓ withdraw asks `world.check(resolveContact withdraw)`; refused, it is `aria-disabled` with the reason under it, and repeats it in the status line when pressed |
| Strings in tables | ✓ all text from `descent-strings.ts` (one `"?"` fallback for a missing holding, unreachable: KD-04) |
| Esc | ✓ deliberate no-op, documented (K5.14); the battle's Esc goes to the leave confirm, whose Esc is "stay" |
| Re-render restores focus | n/a (the dialog is built once per contact) |

### game-feel

| Check | Result |
|---|---|
| A decision is not interrupted by motion | ✓ the clock pauses on contact (and stays paused, K5.8) |
| Feedback on commit | ✓ the feed says what happened (fell back, held, walls taken); the report lists survivors and consequences |
| Reduced motion | ✓ the return to the map is a cut under reduced motion, an ease otherwise (`resumeAt`) |
| An impact beat when armies meet | ✗ KD-03 (P3) |

### camera-systems

| Check | Result |
|---|---|
| The camera never moves without the player's intent, except at a layer change | ✓ after KD-01's fix: the map stays where it was when the interstitial opens; the layer change back up eases out from the meeting point |
| The player can find the event | ✗ KD-02 (P2): nothing marks the meeting point on the map under the dialog; the dialog names the place in words and F finds the king |

## Findings log

| ID | Sev | Skill rule violated | Evidence | Fix | Owner | Status |
|---|---|---|---|---|---|---|
| KD-01 | P1 | camera-systems: no camera move the player did not ask for; game-ui-ux: the view behind a modal must not jump | `kingdom-layer.ts` `openContact()` cut the camera to the holding when the interstitial opened, throwing away the player's framing mid-march (and contradicting `findKing`'s rule that only F moves the map) | removed the cut; the meeting point is used only for the eased return from a battle | K5 | fixed |
| KD-02 | P2 | camera-systems: an event off screen is signposted | no marker at `contactPoint` under the interstitial | draw a ring at the meeting point while a contact waits | K11 | **fixed K11**: a dashed ring at the meeting point while it waits |
| KD-03 | P3 | game-feel: an arrival beat | the interstitial simply appears | a short pulse on both counters (none under reduced motion) | K11 | **fixed K11**: a pulse where the armies meet (none under reduced motion) |
| KD-04 | P3 | game-ui-ux: no literal strings | `contact-dialog.ts` `placeName` returns `"?"` for a missing holding | unreachable (save validation rejects such a contact); left as a guard | — | wontfix |
| KD-05 | P2 | game-ui-ux: say why a choice is gone | at walls the king defends, withdraw is refused with "the townsmen stay" — correct, but a player defending may not see why fight and resolve are the only choices | covered by the reason under the disabled button; revisit with K8 when captains assault the king's walls | K8 | **closed K11**: the reason under the disabled button stands; the captains now assault the king\'s walls (K8/K10) and the dialog says "the townsmen stay" |
| KD-06 | P1 | game-ui-ux: a fight must not leave the player stranded | the leave paths that existed (the lesson's, the test origin's) return to Home, which from a battle reached from the map would strand the player outside the realm with the contact unsettled | `requestLeave` for a story origin asks the leave confirm, settles the contact as a withdrawal under fire (K5.6) and returns to the realm; e2e `k5-descent-withdraw` leaves mid-fight | K5 | fixed |

Count: P0 0 · P1 2 (both fixed) · P2 2 open · P3 1 open, 1 wontfix. No open P0/P1 on the surfaces K5 touches (§C.6 gate met).

## Pending

- Runtime pass at the five sizes and 200 % text zoom (no browser here): the interstitial's three choices with their cost lines, and the report's realm list, are the two layouts to look at.
- Touch: hit targets reuse `.k-btn` (min-height 2.25rem), not measured on a device.
