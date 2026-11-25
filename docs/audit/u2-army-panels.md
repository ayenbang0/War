# U2: armies on the map (K4) — wireframes, audit, and static re-audit

| | |
|---|---|
| **Surface** | The K4 surfaces: **army counters** on the kingdom map (with their route, ETA and the pen's new ghosts), the **army card** (composition, strength, supply, wages, morale placeholder, orders as buttons), the **recruit dialog** opened from a standing barracks in the city view (and the levy dialog opened from the king card), and the **resources bar's** new wage and ration burn |
| **Source files** | `src/render/kingdom/renderer.ts`, `src/render/kingdom/layout.ts`, `src/ui/kingdom/army-card.ts`, `src/ui/kingdom/recruit-menu.ts`, `src/ui/kingdom/resources.ts`, `src/ui/kingdom/cards.ts` (king card), `src/ui/city/cards.ts` (barracks lot), `src/input/kingdom-gestures.ts`, `src/input/kingdom-commander.ts`, `src/app/kingdom-layer.ts`, `src/content/kingdom/army-strings.ts` |
| **Interactions** | raise the first levy companies from the king's followers (king card → Raise followers…); recruit trained companies at a barracks (city barracks lot card → Raise squads…); read an army (tap its counter → card); order it by pen (march, merge, split, garrison ring, patrol ring, heart = recover, line to a hostile = intercept) or by the card's buttons (the keyboard's way to every pen verb); see its route and ETA; watch wages and rations in the bar |
| **Screen contract** | see "Screen-stack entries" below |
| **Skills applied** | game-ui-ux · game-feel (commit pulses, counter movement) · camera-systems (F to a selected army, no auto-follow) · create-game-assets (counter family) · game-ai: hostile armies arrive in K8; the counter for them is designed now (legibility: what the player sees of a hostile is what the fog allows) |
| **Passes done** | static (wireframe, before code) ✓ · static (code, after K4) ✓ (below) · runtime ☐ (no browser in this environment) · input: keyboard and mouse by the e2e fake ✓, touch ☐ · state: no army, one army with the king, 8 armies (cap), starving, unpaid, recovering ✓ |
| **Auditor / date** | U2 (armies), 2026-11-25 |
| **Build / commit** | branch `k4` |
| **Constraints** | desktop web target; gamepad not a target (P3 info); phone findings ≤ P2; English only, strings in tables (docs/PROVISIONAL.md C.7.1–C.7.3) |

## Lessons carried in (U1, U2 economy, U2 city)

| Lesson | How the armies apply it |
|---|---|
| Owner identity is never colour alone (U1-11) | an army counter is a **shield** (the king's is a disc), with the army's ordinal numeral (I–VIII) inside; a hostile army is a **diamond** with a dark keyline. Strength is a number under it, not a shade |
| What you see is what you grab (U1-06, layout.ts) | counters are drawn at offsets from their true point by one shared function (`armyCounterAt`), which the pen's context uses too |
| One function for preview and commit (PC-03) | every K4 stroke goes through `interpretStroke`: the ghost and the order come from the same call |
| A stroke that orders nothing says why (PC-02) | every new reading has a `none` reason with a plate and a result line |
| A large closed stroke is never claimed by the anchor (CLAUDE.md) | rings and hearts are read in step 1, before anyone is grabbed; their subject is who they ENCLOSE |
| A button never promises what the sim refuses | every army button and every recruit option asks `world.check(order)`, the sim's own check |
| Cards are non-modal and focus their heading; menus are modal and hold the clock | the army card is the region card's frame; the recruit dialog is K3's `choiceMenu` |

## Wireframes (1280 × 720 reference)

### Counters on the map

```
                 (K)  <- the king's disc, 30 px above his point, on a stem
                  |
        Cold Hearth ●  (holding glyph at the true point)
                  |
            ⛉ I  ⛉ II     <- army shields fanned below the point, 30 px down,
            38    12          28 px apart; the ordinal inside, men under it
            ▔▔▔▔  ▔▔▔▔       <- strength bar: men alive / full strength, hp tint as hatch
```

- The army the king travels with carries a small crown tick on its shield's top edge, and its
  card says "The king rides with it".
- A route is drawn from the counter's true point along the roads (solid while marching, dotted
  when queued while paused), with an ETA plate at the destination when the army is selected.
- Posture is a glyph on the shield's right shoulder: a palisade tick (holding), a looped arrow
  (patrol), a cross (recovering), a hunger mark (an empty bowl, while hungry) — each also said in
  the card in words.
- A hostile army (K8; a scripted token in K4's tests) is drawn only where the king's fog shows
  "seen": a diamond with a dark keyline and its men rounded to tens ("about 40").

### Pen ghosts (new)

| Stroke | Ghost | Plate |
|---|---|---|
| line army → holding | the road route, dest ring | "March to Greyshaw · about 3 days" |
| line army → own army | a straight dashed link, ring on the target | "Merge into II · 50 men" |
| line king → own army | link to it | "Ride with I" |
| line army → hostile | route toward it | "Intercept the enemy · about 2 days" |
| line across an army | a cut mark across the counter | "Split I in two" |
| ring round a holding where an army stands | ring outline | "Hold Greyshaw (I)" |
| large ring round ≥ 2 holdings, with an army inside | ring + holdings ticked | "Patrol 3 holdings (I)" |
| heart over an army | heart outline | "Rest and recover (I)" |

### Army card

```
┌ I · The First Army ───────────────────────────────┐   heading, tabindex -1
│ The king rides with it · at Greyshaw              │
│ Doctrine   Maneuver            [Doctrine…]        │
│ Strength   38 men of 40 · fit 92 %                │
│ Companies  Levy spears 18/20 (92 %) · Levy …      │   one line per company, words
│ Supply     112 grain: 3 days at 38 a day          │
│ Wages      none (levy companies serve for bread)  │   or "6 coin a day · unpaid 2 days"
│ Morale     not yet reckoned (K6)                  │   placeholder in words, no number
│ Doing      Marching to Thornwick, about 2 days    │
│ Warning    Hungry 3 days: men are deserting       │   only when true
│ [Halt] [Hold here] [Rest & recover] [Split in two]│   every pen verb as a button
│ [Merge into …] [Abilities…] [Disband] [Close]     │
└───────────────────────────────────────────────────┘
```

### Recruit dialog (city: a standing barracks lot → Recruit…; king card → Raise levy…)

```
┌ Recruit at Greyshaw ────────────────────────────────────────┐  modal, holds the clock
│ Companies join the First Army standing here (or form a new  │
│ army if none stands here). 5 of 8 armies raised.            │
│ [Line Infantry]   20 men · 12 coin · 2 iron · wage 2 a day  │  each a button
│ [Archers]         16 men · 16 coin · 1 iron · wage 2 a day  │
│ [Heavy Horse]  -- Not now: the stores are short of iron     │  refused: dashed, why
│ …                                                          │
│ [Cancel]  Esc cancels                                       │
└─────────────────────────────────────────────────────────────┘
```

### Resources bar

The bar's grain and coin rows gain a second line while armies exist: "armies −38 a day" and
"wages −6 a day" — what the armies take from the stores each day, from the same function the
sim uses.

## Screen-stack entries and input contexts

| Screen | Kind | Traps focus | Pauses sim | Inputs | First focus | Esc |
|---|---|---|---|---|---|---|
| army-card | overlay | no | no | pen, camera, ui | heading | closes (a stroke in progress first) |
| recruit-menu / levy-menu / doctrine-menu / ability-menu / merge-menu | overlay (K3 `choiceMenu`) | yes | yes | ui | first option on offer, else Cancel | cancels |
| disband confirm | the app's confirm | yes | yes | ui | the safe choice (Keep) | keeps |

## Audit of the wireframes against each skill (before code)

### game-ui-ux

| Check | Result |
|---|---|
| Anchored layout, no fixed widths | ✓ the card and menus reuse `.k-card` and `.k-menu` |
| Focus on open, Space stays pause | ✓ heading first, buttons blur on mouse press |
| Every action by keyboard | ✗ → **A-01**: the pen verbs (merge, split, garrison, patrol, recover, intercept) have no keyboard path. Fix: the army card offers each as a button; merge/doctrine/abilities open a choice menu |
| Modal trap | ✓ menus are K3's |
| Destructive action confirmed | ✗ → **A-02**: Disband loses men if far from home. Fix: a confirm with focus on "Keep the army", saying what happens to the men |
| Honest placeholders | ✗ → **A-03**: morale is a K6 rule. Fix: "not yet reckoned" in words; the field exists in the sim |
| Not colour alone | ✓ shape (disc / shield / diamond), numeral, men count; posture glyph and words |
| Strength readable | ✗ → **A-04**: a bare count does not say "how hurt". Fix: men of full strength plus fitness %, and a bar under the counter |
| Strings in tables | ✓ `army-strings.ts` |
| Readable with 8 armies | ✗ → **A-05**: counters at one node overlap. Fix: fan up to 4 per row, 28 px apart; label culling never covers a counter |

### game-feel

| Check | Result |
|---|---|
| Hooks | ✓ an order committed pulses at its target; a split, merge, recruit and desertion each write a feed line |
| Movement | ✓ counters interpolate between ticks like the king |
| No over-juicing | ✓ no pulse for selection |

### camera-systems

| Check | Result |
|---|---|
| Camera never moves on its own | ✓ F flies to the king; the army card's "Show on map" flies to that army (user-initiated) |

### create-game-assets

| Check | Result |
|---|---|
| One counter family | ✓ disc, shield and diamond share stroke weight, halo and numeral face |

## Findings log

| ID | Sev | Skill rule violated | Evidence | Fix | Owner | Status |
|---|---|---|---|---|---|---|
| A-01 | P1 | every action reachable by keyboard | pen-only verbs | card buttons + menus | K4 | fixed |
| A-02 | P1 | destructive action confirmed | disband | confirm, safe choice focused | K4 | fixed |
| A-03 | P1 | don't fake state | morale is K6 | words, not a number | K4 | fixed |
| A-04 | P1 | state readable | bare counts | men of full + fit %; bar | K4 | fixed |
| A-05 | P2 | readability under load | stacked counters | fan; labels never cover counters | K4 | fixed (one row, 30 px; see A-08) |
| A-06 | P2 | wages and rations invisible | the bar shows stocks only | burn lines from the sim's own `armyUpkeep` | K4 | fixed (one line, see re-audit) |
| A-07 | P2 | a stroke means the same wherever it is drawn | a VERTICAL line across an army that stands under the king begins on the king's counter (30 px above the point; the army's is 30 px below), so it reads as the king's line, not a split | draw the cut across, not along the stem; the plate says what it will do before release | K4 | open (P2: the ghost shows it) |
| A-08 | P2 | readability under load | eight armies at one holding fan into one 240 px row | two rows past four | K5 | open |
| A-09 | P3 | the card's numbers match the counter's | a hostile counter shows men rounded ("~40"); its card shows the exact count | round on the card too when the fog rules land (K8) | K8 | open |
| A-10 | P3 | camera-systems: user-initiated framing | no "Show on map" (F flies to the king only) | add with K5's army selection | K5 | open |

## Static re-audit (code, after K4)

Read against the source files listed above, and driven through the e2e fake
(`src/e2e/scenarios-k4.ts`: `k4-armies`, `k4-barracks-recruit`).

What changed from the wireframes, and why:

| Wireframe said | Built | Why |
|---|---|---|
| strength bar "men alive / full strength, hp tint as hatch" | men and days of grain as words under the counter ("38 · 6d"), and a bar of FIT men of full strength | the sim keeps wounded as a count, not hp (PROVISIONAL K4.3); words first, the bar second |
| hunger as "an empty bowl" glyph | the numbers under the counter turn red AND gain a "!" | a mark that is not colour alone, readable at 11 px |
| plates such as "Merge into II · 50 men", "Hold Greyshaw (I)" | "Merge the Second Army into the First Army", "First Army: hold Greyshaw" | one table (`PEN` in army-strings.ts), full names, no numerals to decode |
| recruit button "Recruit…", levy "Raise levy…" | "Raise squads…" (barracks lot), "Raise followers…" (king card) | the brief's words |
| a ring's subject is who it ENCLOSES | the army the ring STARTS on, else the one army of yours it encloses; two enclosed and none started on is "which army?" | zoomed out, a ring round two holdings takes in a neighbour's army too; starting on the counter says whom you mean (corpus: rings from A2's counter) |
| a separate disband confirm screen | the shared choice menu, with "Keep the army" as Cancel and focus on it | one modal pattern; the safe choice is still first focus |

Checks, per skill, on the code:

| Skill | Check | Result |
|---|---|---|
| game-ui-ux | every pen verb reachable by keyboard | ✓ the army card: March…, Halt, Hold here, Patrol…, Rest and mend, Split off the rear half, Merge into…, Intercept… (other sides' armies only), Doctrine…, Earn an ability…, King rides with it / alone, Stand down… |
| game-ui-ux | a button never promises what the sim refuses | ✓ every button and option asks `world.check`; refused ones stay focusable, `aria-disabled`, with the sim's reason |
| game-ui-ux | honest placeholders | ✓ morale reads "not yet reckoned (comes with K6)", no number |
| game-ui-ux | identity not by colour alone | ✓ shield + numeral (yours), diamond + initial (another side's), crown tick on the army the king rides with, posture badge drawn as a shape (wall / loop / cross) and said in the card |
| game-ui-ux | strings in tables | ✓ `army-strings.ts` (ARMY_REFUSAL, PEN, AC) and `ui-strings.ts` (NONE reasons) |
| game-ui-ux | every stroke that means nothing says why | ✓ new reasons `closed-no-army`, `closed-many-armies`; a recognised army stroke the sim refuses shows "no order: <the sim's reason>" (tools/kingdom-armies.ts checks all of them) |
| game-ui-ux | modal menus hold the clock | ✓ levy, recruit, march, patrol, merge, intercept, doctrine, ability and stand-down menus are K3's `choiceMenu` (pausesSim) |
| game-feel | commits pulse; news in the feed | ✓ pulse at the order's target; feed lines for raised, recruited, arrived, split, merged, gone, intercepted, unpaid, hungry (once until fed), followers leaving |
| game-feel | counters move smoothly | ✓ interpolated between ticks like the king (`armiesDrawn`) |
| camera-systems | never moves on its own | ✓ no camera code added |
| create-game-assets | one counter family | ✓ shared halo, ink keyline, numeral face; drawn procedurally |
| pen | what you see is what you grab | ✓ `armyCounters` (kingdom-commander.ts) is read by both the renderer's frame and the pen's context; e2e strokes land on the drawn counters |
| pen | one function for preview and commit | ✓ `interpretStroke`; 128 army-scene strokes: last preview equals commit, and the sim accepts every committed order |

**Open P0/P1: none.** Open: A-07, A-08 (P2), A-09, A-10 (P3).
