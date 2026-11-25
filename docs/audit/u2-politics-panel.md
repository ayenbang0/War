# U2: the politics panel (K6) — wireframe, audit, and static re-audit

| | |
|---|---|
| **Surface** | The city's **politics card** as K6 fills it: loyalty and unrest, today's trend, what moves it, K3's tax, **justice**, **Hold a festival**, **Pardon the prisoners**, shrines and halls; the HUD's new **Mercy/Terror** cell; the army card's **morale** line; the feed's K6 lines |
| **Source files** | `src/ui/city/politics.ts`, `src/ui/city/cards.ts` (politicsCard), `src/ui/kingdom/resources.ts`, `src/ui/kingdom/icons.ts` (balance glyph), `src/ui/kingdom/army-card.ts`, `src/app/kingdom-layer.ts` (feed), `src/content/kingdom/morale-strings.ts`, `src/content/kingdom/city-strings.ts`, `src/content/kingdom/army-strings.ts` |
| **Interactions** | open a town (city view) and press P (or the panel's Politics); read loyalty, the trend and its causes; set the tax (K3's toggles); set justice (three toggles); hold a festival; pardon the prisoners; read Mercy/Terror on the top bar; read an army's morale on its card |
| **Screen contract** | the politics card is the region card's non-modal frame (focus on its heading, Esc closes, the plan stays live); no new screen-stack entry |
| **Skills applied** | game-ui-ux · game-feel (the trend line answers a lever before the day turns) · camera-systems: n/a (no camera change) · create-game-assets (one new glyph, the balance, in the stock family's ink) · game-ai: n/a (no AI acts until K8) |
| **Passes done** | static (wireframe, before code) ✓ · static (code, after K6) ✓ · runtime ☐ (no browser in this environment) · input: keyboard and mouse by the e2e fake ✓, touch ☐ · state: calm, rising, restless (half taxes), unreckoned (not the king's), festival running, pardoned this season, unaffordable, mercy and terror ✓ |
| **Auditor / date** | U2 (politics), 2026-11-25 |
| **Build / commit** | branch `k6` |
| **Constraints** | desktop web target; gamepad not a target (P3 info); phone findings ≤ P2; English only, strings in tables (docs/PROVISIONAL.md C.7.1–C.7.3) |

## Lessons carried in (U2 city view, U2 army panels)

| Lesson | How the politics card applies it |
|---|---|
| Don't fake state (C-04) | K3b's "not yet reckoned" loyalty row is gone because the rule now exists; the one placeholder left (Local lords, K8) still says so in words |
| One check for button and sim (PC-03) | every lever's refusal is `world.check(order)`; the cause list is `unrestCauses`, the function the day applies |
| A refusal is said (PC-02) | a refused lever stays focusable, is `aria-disabled`, carries its reason as an accessible description, and a press writes "Not now: …" in a status line |
| Re-render restores focus (U2-04) | the section is built once and updated in place; K3's tax section refocuses by `data-key` |
| Mouse press must not leave a button focused (Space is pause) | every lever blurs on a mouse press (detail > 0), never on a key press |
| State not by colour alone | each cause says "raises" or "calms" in words; the band is a word (calm, uneasy, restless, in open revolt) beside its number; Mercy and Terror are named, not tinted |

## Wireframe (the politics card, 1280 × 720)

```
┌ Politics at Greyshaw ───────────────────────────┐
│ People   46                                      │
│ Tax      Normal: 1.8 coin a day …   (K3)         │
│ [None][Low][Normal][High][Harsh]  [Same for all] │
│ Loyalty and unrest  Grumbling: unrest 23.5 of    │
│                     100 (uneasy)                 │
│ Today    Rising 0.5 a day.                       │
│ Restless: the town pays only half its taxes.     │  only when true (bold)
│ At 50 the town pays half its taxes; at 80 …      │
│ ─ What moves it ─────────────────────────────── │
│ • Taxes: raises 0.8 a day                        │
│ • The king's standing: raises 0.2 a day          │
│ • Growing used to their lord: calms 0.3 a day    │
│ • Shrines: calms 0.5 a day                       │
│ Armies have lived off its fields 3 days …        │  only when true
│ ─ Justice ───────────────────────────────────── │
│ [None][Courts][The rope]   (aria-pressed)        │
│ Justice: courts. Justices sit every day for …    │
│ ─ Levers ────────────────────────────────────── │
│ [Hold a festival]                                │
│ Bread and ale for 7 days: 3 coin and 11 grain …  │
│ [Pardon the prisoners]                           │
│ Unrest falls at once and the realm's mercy …     │
│ Not now: the prisoners here were pardoned …      │  status line, on a refused press
│ Shrines and halls  1 standing, calming the town. │
│ Local lords  none sworn to you here yet          │
│ [Close]  Esc closes                              │
└──────────────────────────────────────────────────┘
top bar:  (coin) Coin 34 · … · (crown) Legitimacy 12 · (balance) Mercy 2
```

## Audit of the wireframe against each skill (before code)

| Check | Result |
|---|---|
| The player can tell what to do next | ✓ the trend line and the cause list say which way the town is going and why; each lever says what it does and costs before it is pressed |
| Feedback before the day turns | ✓ a lever's order applies on the next tick; the card's trend and cause list update on refresh, so "Rising 2 a day" becomes "Rising 0.5 a day" when the rope is set, before the day moves the number |
| Thresholds legible | ✓ said as a sentence; the half-tax state is a bold line in words |
| Keyboard | ✓ every lever is a `button`; the toggles are a labelled `role=group`; P opens the card from the city; Tab reaches every control; Esc closes |
| 16 px floor | ✓ the section uses the kingdom stylesheet's rem classes (`k-rows`, `k-sub`, `k-warn`, `k-list`, `k-toggles`, `k-section`); no new CSS |
| Reduced motion | ✓ nothing animates; no new motion |
| Portrait phone | ✓ (P2 cap) the card is the K3b bottom sheet; the section is taller, so it scrolls with the card (P-05) |

## Findings log

| ID | Sev | Skill rule violated | Evidence | Fix | Owner | Status |
|---|---|---|---|---|---|---|
| P-01 | P1 | one list for the card and the sim | a hand-written cause list would drift from the day's sum | `unrestCauses` is the one function: the day sums it, the card lists it, `unrestTrend` is its sum | K6 | closed: tools/kingdom-morale.ts "the trend the card shows is the day's move", "listed in the content's order"; e2e `k6-politics-levers` "a day under it moves unrest by the trend the card showed" |
| P-02 | P1 | a refusal is said | a disabled `button` drops out of the Tab ring and says nothing | `aria-disabled` + `aria-description` with the reason; a press writes "Not now: …" in a `role=status` line and sends nothing | K6 | closed: e2e "the pardon button is marked unavailable", "a refused press says why, in words", "and sends no order" |
| P-03 | P1 | pressed state not by colour alone | justice toggles | `aria-pressed` plus the `on` class plus the "Justice: …" sentence under them | K6 | closed: e2e "and the pressed toggle says so" |
| P-04 | P1 | focus is kept across refreshes | the card refreshes every day while time runs; a rebuild would drop focus | the section is built once and changed in place (text, attributes, the cause list's items, which hold no control) | K6 | closed: `politicsSection` never replaces a button; e2e presses toggles and levers across day steps |
| P-05 | P2 | portrait phone | the card is now long; whether the bottom sheet's scroll keeps the levers reachable with the top bar wrapped is unmeasured | none in code | — | open, runtime pass pending (no browser here) |
| P-06 | P2 | HUD density | a seventh cell on the top bar | Mercy/Terror sits after the stocks with the same icon family and its name in words; one value, no day's change | K6 | closed: `ResourcesBar.mercyText`; e2e "the HUD shows the realm's mercy" |
| P-07 | P2 | don't fake state | the army card's morale row said "comes with K6" | it now says the number and where it is heading ("52 of 100, rising toward 56"; "falling" when hungry or unpaid; the desertion floor in words) | K6 | closed: `AC.moraleLine` reads `armyRestMorale` |
| P-08 | P3 | feed noise | a band line every day would flood the feed | the feed speaks on a band change (both ways), a revolt, a festival's end, and the first night an army's men slip away (once until its spirit mends) | K6 | closed: `KingdomLayer.onMoraleEvent` |

No P0 found. Every P1 is closed.

## Static re-audit after implementation

| Check | Result |
|---|---|
| Every string in a table | ✓ `morale-strings.ts` (`P`, `MORALE_REFUSAL`, `CAUSE_LABEL`, `JUSTICE_NAME/ABOUT`, `MERCY`, `MORALE_WORDS`, `MORALE_FEED`); `C.loyalty`, `C.lords` reused |
| No pronoun guesses the king's gender | ✓ the new lines speak of "the king" and "their lord" |
| A number is never shown without its scale | ✓ "unrest 23.5 of 100"; morale "52 of 100"; Mercy/Terror named |
| The card agrees with the sim | ✓ P-01 |
| The HUD reads the world, never writes it | ✓ `ResourcesBar.update` only reads `mercy` |

| ID | Sev | What | Status |
|---|---|---|---|
| P-05 | P2 | portrait phone scroll of the longer card | open, runtime pass pending (no browser here) |
