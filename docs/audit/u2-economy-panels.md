# U2: economy panels — wireframes, audit, and static re-audit

| | |
|---|---|
| **Surface** | The K3 economy UI on the kingdom map: the **resources bar** (replaces K2's "No stores yet" box), the **economy panel** of the region card for a holding the king owns, the **build menu**, the **plot manager** (the panel's fields with Sow… / Harvest, and the sow menu), and the king card's **Forage / Rally / Claim** buttons |
| **Source files** | `src/ui/kingdom/resources.ts`, `src/ui/kingdom/economy-panel.ts`, `src/ui/kingdom/icons.ts`, `src/ui/kingdom/cards.ts`, `src/ui/kingdom/hud.ts`, `src/ui/kingdom/kingdom.css`, `src/app/kingdom-layer.ts` (`onEvent`, `issueFromUi`, `openCard`), strings in `src/content/kingdom/ui-strings.ts` (`E`, `REFUSAL`, `STOCK_NAME`, …) |
| **Interactions** | read the stores and their change since yesterday; set a holding's tax (or the realm's); open the build menu and pick a building; sow a field from the sow menu; harvest a ripe field; forage, rally followers, claim an empty holding from the king card |
| **Screen contract** | see "Screen-stack entries" below |
| **Skills applied** | game-ui-ux · game-feel (feed tiers) · create-game-assets (the stock icon family). camera-systems: n/a (no camera change in K3). game-ai: n/a (no AI acts until K8) |
| **Passes done** | static (wireframe) ✓ · static (code, after K3) ✓ · runtime ☐ (no browser in the K3 build environment — see "Pending") · input: keyboard and mouse by the e2e fake ✓, touch ☐ · state: empty/famine/refused ✓ |
| **Auditor / date** | U2, 2026-11-25 |
| **Build / commit** | branch `k3` |
| **Constraints** | desktop web target; gamepad not a target (P3 info); phone findings ≤ P2; English only, strings in tables (docs/PROVISIONAL.md C.7.1–C.7.3) |

**Order of work, stated plainly.** PLAN §C.6 asks for this sheet *before* the panels are coded. In
the K3 session the economy sim and its balance were built first, and the wireframes below were drawn
up from the U1 sheet's lessons and the K3 plan before the panel code was written, but this file was
written down in the same session after the code. The "pre-implementation" sections record the
design as it was decided; the static re-audit at the end checks the code against it.

## U1 lessons carried in (from `u1-kingdom-map.md`)

| Lesson | How the economy panels apply it |
|---|---|
| HUD driven by events, not frames (U1-09) | the bar is written by `ResourcesBar.update`, called only after a batch of ticks in which an event (`stocksChanged`, `dayBegan`, `famine`, `claimed`, `built`, `taxSet`) said something it shows changed, and once at build |
| A card is non-modal, focuses its heading (U1-04) | the economy panel lives inside the region card and inherits that; the two MENUS are modal (they spend coin), trap Tab, and hold the clock like a confirm |
| One function for preview and commit (PC-03) | every economy button and every menu option asks `world.check(order)`, which IS the sim's `checkEconomyOrder`; the sim applies the same check |
| A refusal is said, not silent (PC-02) | an option the sim would refuse stays listed, focusable, marked `aria-disabled`, with "Not now: <reason>" printed under it; pressing it repeats the reason in the menu's status line |
| Identity/state not by colour alone | the change since yesterday is written with its sign ("+6", "−3"); unavailable options are dashed AND say "Not now"; famine is a bold line in words |
| 16 px floor, 4.5:1 contrast | all text ≥ 1rem; measured pairs below |
| A mouse press must not leave a button focused (Space is pause) | every economy button blurs on a mouse press (`detail > 0`), keeps focus on a keyboard press |

## Wireframes (1280 × 720 reference)

### Resources bar (top bar, left; replaces the stores placeholder)

```
┌ The king's stores (role=group) ───────────────────────────────────────────────┐
│ (◎) Coin 4 +1   (⚘) Grain 82 +6   (≡) Timber 4   (▱) Iron 0   (♙) Followers 4  │  one <li> per stock:
│ (♔) Legitimacy 10                                                              │  icon (aria-hidden) + name
│ Grain lasts about 13 days · stores hold 78                                     │  + value + signed change
│ Hungry: the party has gone short 2 days · Famine at Greyshaw (3 days)          │  (shown only when true)
└────────────────────────────────────────────────────────────────────────────────┘
```

- Each `<li>` has the accessible name "Grain 82, +6 since yesterday" and a title with what the stock is for.
- The change is yesterday's ledger page (`netOf(books.closed)`), so it is exactly the ledger.
- Wraps on narrow windows; at ≤ 700 px it takes the full row (K2 hid the box there: U2-02).

### Economy panel (inside the region card, only for the king's holdings)

```
│ The holding ───────────────────────── (h3, section labelled) │
│ Tax     2 coin a day; people grow 2% each season             │
│ Bread   1 grain a day from the king's stores                 │
│         Famine: 3 days short of bread          (bold, words) │
│ Tax rate: [None][Low][Normal▣][High][Harsh] [Same rate everywhere]
│           (role=group, aria-pressed; the pressed one is filled AND bold)
│ Buildings                                                    │
│   • Granary: being built, 3 days left                        │
│ [Build…]  (aria-haspopup=dialog, name "Build at Greyshaw")   │
│ Fields                                                       │
│   Field 1: Rye, growing (40%)                        [Sow…]  │  Sow… only when the field is open,
│   Field 2: Wheat and barley, ripe                 [Harvest]  │  Harvest only when ripe;
│                                                              │  names "Sow field 1", "Harvest field 2"
```

### Build menu (modal overlay, centred)

```
┌ Build at Greyshaw (dialog, aria-modal) ──────────────────────────────┐
│ Each takes one slot. Costs are paid when the work starts.            │
│ [Farm      ]  More bread from every field.                           │
│               Costs 10 coin, 8 timber · 6 days to build              │
│               Not now: the stores cannot pay for it.   (dashed btn)  │
│ [Granary   ]  Keeps grain from rotting.                              │  ← first focus: the
│               Costs 4 coin, 4 timber · 4 days to build               │    first option on offer
│ …  every building, in table order …                                  │
│ (status line, role=status: "Not now: …" when a refused one is pressed)│
│ [Cancel]  Esc cancels                                                │
└──────────────────────────────────────────────────────────────────────┘
```

### Plot manager: sow menu (same component as the build menu)

```
┌ Sow Field 1 at Greyshaw ─────────────────────────────────────────────┐
│ What can be sown now. Seed is paid when it goes in.                  │
│ [Wheat and barley] Sown in spring … · Costs 30 grain · Yields about  │
│                    420 grain · Sow in Spring · Not now: … this season│
│ [Rye             ] Hardy: sown in autumn … · Costs 20 grain · …      │
│ …                                                                    │
│ [Cancel]                                                             │
└──────────────────────────────────────────────────────────────────────┘
```

### King card additions

```
│ Doing    Foraging                                            │
│ Not now: a holding needs hands: the king needs 3 followers…  │  (only for a refused claim)
│ [Halt] [Forage here] [Rally followers] [Claim Greyshaw] [Close]
```
Forage and Rally appear only when the order would be applied there; Claim appears at any unclaimed
holding the king stands at, `aria-disabled` with its reason when it would be refused, so the player
learns what a claim needs.

## Screen-stack entries and input contexts

| Screen | Kind | Traps focus | Pauses sim | Inputs | First focus | Esc |
|---|---|---|---|---|---|---|
| region-card (with economy panel) | overlay | no | no | pen, camera, ui | heading; on return from a menu, the control that opened it | closes the card (a stroke in progress claims Esc first) |
| king-card | overlay | no | no | pen, camera, ui | heading | closes |
| build-menu | overlay | **yes** | **yes** | ui | first option on offer, else Cancel | cancels |
| sow-menu | overlay | **yes** | **yes** | ui | first crop on offer, else Cancel | cancels |

The menus hold the clock because what they offer depends on the stores at this moment; a choice
made with the realm moving underneath could be refused a tick later.

## Audit of the wireframes against each skill

### game-ui-ux

| Check | Result |
|---|---|
| Anchored layout, flex/grid, no fixed widths sized to English | ✓ bar is a wrapping flex list; menu rows are a two-column grid that collapses to one column ≤ 700 px; widths are `min(…rem, 100%)` |
| One scaling policy (rem) | ✗ → U2-01 (kingdom.css had 12–15 px fonts from K2) — fixed |
| Safe area, ultrawide | ✓ the bar sits in K2's top bar (already inset by `env(safe-area-inset-*)`); the menu is centred in the full viewport with 1rem padding |
| Portrait phone | ✓ (P2 cap) bar takes the full width; the card is the K2 bottom sheet; menu is one column and scrolls as one region — runtime: pending |
| Focus on open, Tab order, visible focus | ✓ menus focus their first live option; DOM order = visual order; no positive tabindex; two-tone ring (`#1f4f86` 3 px + pale halo) |
| Modal trap | ✓ menus `trapsFocus: true`; the stack makes the card and map inert under them |
| Re-render restores focus | ✗ → U2-04 — designed in: controls carry `data-key`, the panel refocuses the same key after a rebuild, the card's first focus on return is the opener |
| Back/Esc | ✓ Esc and Cancel pop the menu; focus back to Build…/Sow… |
| HUD by events | ✓ see U1 lessons |
| Text ≥ 16 px; contrast ≥ 4.5:1 | ✓ after U2-01 — body `#3a3124`/`#efe8d6` 10.45:1; secondary `#5f5138` 6.32:1; warning `#8c3a34` 6.20:1; good `#2f5a2a` 6.57:1; unavailable button text `#5f5138` on `#e6dfcf` 5.82:1; "Not now" `#8c3a34` on `#efe8d6` 6.20:1 |
| Not colour alone | ✓ signs written; unavailable = dashed + words; pressed tax = filled + bold + `aria-pressed` |
| Semantics | ✓ native buttons; `role=group` with labels for the bar and the tax rates; `aria-pressed`; menus `role=dialog` `aria-modal` labelled and described; options `aria-describedby` their detail; status line `role=status`; icons `aria-hidden` and never alone |
| Disabled controls | ✗ → U2-03 — a `disabled` button leaves the Tab ring and says nothing; use `aria-disabled` + printed reason |
| Strings in tables, templated | ✓ every word in `ui-strings.ts` (`E`, `REFUSAL`, `STOCK_NAME`, `STOCK_ABOUT`, `TAX_NAME`, `STAGE_NAME`, `FARM_EVENT_LINE`, `TASK_NAME`); `amountsLine` formats every cost and gain |

### game-feel

| Check | Result |
|---|---|
| Each event has a named hook | ✓ sim events `built`, `buildingStarted`, `upkeepUnpaid`, `famine`, `plotStage`, `harvested`, `farmWeather`, `rallied`, `rallyDone`, `claimed` → one feed line each in `KingdomLayer.onEvent` |
| Tiering | small: a tax change / an order (result line only); medium: a building stands, a harvest, ripe/spoiled, rally (feed line); large: famine begins/ends (feed line + the bar's bold trouble line). No sound or motion in K3 |
| No over-juicing | ✓ daily foraging and task changes write no feed line (the bar's numbers and the card's "Doing" show them) |
| Reduced motion | ✓ nothing in K3 moves |

### create-game-assets (stock icons)

| Check | Result |
|---|---|
| One icon family, same ink and weight | ✓ `icons.ts`: one canvas routine, 1.5 px ink `#3a3124`, one fill |
| No emoji / font glyphs as icons | ✓ |
| Icon never alone | ✓ always beside the stock's name; `aria-hidden` |
| DPR-aware | ✓ backing store at `min(3, devicePixelRatio)` |
| Palette in one module | ✗ → U2-08 (icon colours are literals in `icons.ts`, as K2's CSS colours are) |

## Findings log

| ID | Sev | Skill rule violated | Evidence | Fix | Owner | Status |
|---|---|---|---|---|---|---|
| U2-01 | P1 | one scaling policy; 16 px floor | `kingdom.css` (K2): `.k-stores { font-size: 14px }`, `.k-label { font-size: 12px }`, `.k-btn { font-size: 15px }`, `.k-keys { 13px }`, `.k-hint { 13px }`, `.k-alerts`, `.k-notice`, `.k-weather` 14 px | every size in rem ≥ 1rem; `tools/ui-check.ts` now checks `kingdom.css` for px or sub-1rem font sizes and for the focus ring | K3 | **fixed** |
| U2-02 | P1 | critical UI must not vanish on small windows | `kingdom.css` (K2) `@media (max-width: 700px) { .k-stores { display: none } }` — harmless for a placeholder, wrong for the stores | the bar stays, full width, wrapping | K3 | **fixed** |
| U2-03 | P1 | focus ring / say why | a `disabled` option would drop out of Tab and give no reason | `aria-disabled="true"`, still focusable, "Not now: …" printed and repeated on press; never applied | K3 | **fixed** |
| U2-04 | P1 | re-render restores focus | the panel rebuilds when the holding changes (a day's work) — focus would fall to `body` | `data-key` on every control; rebuild refocuses the same key (or the tax group / Build… for a vanished one); the card's first focus on return from a menu is the opener | K3 | **fixed** |
| U2-05 | P2 | one check for button and sim | while paused, orders sit in the queue unapplied, so the menu checks the stores as they are; two builds queued while paused can both be offered and the second is refused when time runs (said in the feed) | show queued economy orders in the panel, or check against stores less queued costs | K11 | **fixed K11** (`checkCountingQueued`; kingdom-economy) |
| U2-06 | P2 | (runtime) layout | the region card with a full economy panel is long: at 1280×720 and on the ≤ 700 px bottom sheet it scrolls (the card is the one scroll region) | runtime check; consider collapsing Fields/Buildings | K11 | runtime: pending |
| U2-07 | P2 | keyboard activation | Enter/Space on a focused menu option is the browser's own button activation; the e2e fake cannot synthesize it, so `k3-exile-economy` Tabs to "Granary" and clicks the focused button | confirm in a real browser run of `e2e.html?k3` | K11 | runtime: pending |
| U2-08 | P3 | palette in one module | `icons.ts` literals `#3a3124`, `#c9b48a`, `#8f8a80` | move kingdom UI colours to a palette module read by CSS custom properties | K11 | open: three literal colours in icons.ts, cosmetic; left (K11.10) |
| U2-09 | P3 | feed chattiness | a rally writes a line each day it brings someone | fold a rally into one line per rally | K11 | **fixed K11** (one feed line per rally; e2e `k3-exile-economy`) |
| U2-10 | P3 | game-feel | no sound or motion on a building standing or a harvest (text only) | K11 polish | K11 | **fixed K11** (sound: a building standing and a harvest have a cue) |

Count: P0 0 · P1 4 (all fixed) · P2 3 (1 open, 2 runtime pending) · P3 3 open. **No open P0/P1.**

## Static re-audit after implementation (2026-11-25)

Read against the code as committed on `k3`:

| Claim | Where | Result |
|---|---|---|
| Bar written only on events | `kingdom-layer.ts` `runTicks`: `storesDirty` set by `stocksChanged`/`taxSet`/`claimed`/`famine`/`built`/`dayBegan`, `resources.update` once per batch; once in the constructor | ✓ |
| Bar reads only | `resources.ts` uses `ledgerValue`, `netOf`, `storageOf`, `dailyNeed`; writes nothing to the world | ✓ |
| One check for buttons and sim | `economy-panel.ts` and `cards.ts` call `world.check`; `world.ts` `applyOrder` → `applyEconomyOrder` → `checkEconomyOrder` (same function); `tools/kingdom-economy.ts` "the sim refuses with the check's own reason" | ✓ |
| Every change is an order through the queue | `issueFromUi` → `world.issue`; no UI writes the world | ✓ |
| Menus trap Tab and hold the clock | `choiceMenu`: `trapsFocus: true`, `pausesSim: true`; e2e "Tab reaches the granary and stays inside the menu", "nothing runs while the menu is up" | ✓ |
| Esc/Cancel pop and focus returns to the opener | `cardFrame` `firstFocus` uses `back()`; e2e `k3-menu-esc-and-refusal` "focus returns to Build…" | ✓ |
| Refused options focusable, say why | `aria-disabled`, `.k-why` "Not now: …", status line on press; e2e "pressing it says why, and does nothing" | ✓ |
| Rebuild keeps focus | `economyPanel.refresh` (`data-key`) | ✓ (by reading; exercised by e2e "focus is back on Build…") |
| No px font sizes in kingdom.css | `tools/ui-check.ts` "kingdom.css: no font size in px or under 1rem" | ✓ |
| Focus ring | `.k-btn:focus-visible` 3 px `#1f4f86` + 5 px pale halo; ui-check "kingdom.css: an authored focus ring" | ✓ |
| Strings in tables; no gendered pronouns | `tools/kingdom-economy.ts` [strings] | ✓ |
| Mouse press does not leave focus | economy and king-card buttons blur on `detail > 0` | ✓ |

Open after the re-audit: U2-05 (P2), U2-08/09/10 (P3); runtime U2-06, U2-07 and the runtime
table below.

## Pending (runtime pass, needs a real browser)

| State \ size | 1280×720 | 1920×1080 | 2560×1080 | 1080×2340 | 200 % zoom @1280×720 |
|---|---|---|---|---|---|
| bar, no trouble | ☐ | ☐ | ☐ | ☐ | ☐ |
| bar with hunger + famine line | ☐ | ☐ | ☐ | ☐ | ☐ |
| region card, owned, two fields | ☐ | ☐ | ☐ | ☐ | ☐ |
| build menu (13 rows) | ☐ | ☐ | ☐ | ☐ | ☐ |
| sow menu | ☐ | ☐ | ☐ | ☐ | ☐ |

Also: computed focus ring on a Tabbed menu option (the `k3-exile-economy` scenario checks it when
`getComputedStyle` reports an outline), touch targets of the tax buttons (2.25 rem tall), and the
`k2-text-floor` style check extended to the kingdom HUD.
