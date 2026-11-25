# U2: the mercenary market (K7) — wireframe, audit, and static re-audit

| | |
|---|---|
| **Surface** | The tavern lot's **Free companies…** button and the **market** it opens; the army card of a hired company (contract, loyalty, the crown's bid; **Renew**, **Match the bid**, **Dismiss**); the company's map counter; the feed's K7 lines |
| **Source files** | `src/ui/kingdom/mercenary-menu.ts`, `src/ui/city/cards.ts` (lotCard), `src/ui/kingdom/army-card.ts`, `src/app/kingdom-layer.ts` (feed, counter mark), `src/content/kingdom/mercenary-strings.ts` |
| **Interactions** | enter a town with a tavern; open the tavern's lot; Free companies…; read each company; hire one (or read why not); Esc; on the map, open the company's card; renew in the window; match a bid; dismiss |
| **Screen contract** | the market is the shared choice menu (modal overlay, traps focus, pauses the sim, Esc cancels); the army card is unchanged in frame; no new screen-stack kind |
| **Skills applied** | game-ui-ux · game-feel (a hire answers at once: the menu closes, the result line says it, the next day the counter is on the map) · game-ai: n/a (the crown's bids are rules, not an agent, until K8) |
| **Passes done** | static (wireframe, before code) ✓ · static (code, after K7) ✓ · runtime ☐ (no browser in this environment) · input: keyboard and mouse by the e2e fake ✓, touch ☐ · state: no company here, one offered, unaffordable, army cap, hired, in the renewal window, owed wages, bid standing, turned while the card is open ✓ |
| **Auditor / date** | U2 (market), 2026-11-25 |
| **Build / commit** | branch `k6` (K7 on top of K6) |
| **Constraints** | desktop web target; gamepad not a target; phone findings ≤ P2; English only, strings in tables |

## Lessons carried in (U2 army panels, U2 politics panel)

| Lesson | How the market applies it |
|---|---|
| One check for button and sim | every hire, renewal and match is `world.check(order)`, the function the tick applies (`checkMercenaryOrder`) |
| A refusal is said | an unaffordable company stays listed, focusable, `aria-disabled`, with "Not now: the company asks 8 coin to sign"; a press writes it in the status line and sends nothing |
| Don't fake state | the tavern's purpose line no longer says "hired swords (later)"; an empty tavern says nobody is there, and to look again |
| State not by colour alone | reputation is a word (Reliable, Bloody, Turncoats) with a sentence of what it means; loyalty is "60 of 100" |
| Mouse press must not leave a button focused | the shared menu and the army card's `add` buttons blur on a mouse press only |

## Wireframe (the market, 1280 × 720)

```
┌ Free companies at the tavern ─────────────────────────────┐
│ Who drinks in Greyshaw's tavern and will sign. A company  │
│ brings its own men and arms: no levy, no barracks -- but  │
│ a fee to sign, a wage every day, and no replacements.     │
│ ┌───────────────────────────────────────────────────────┐ │
│ │ [Hire Harker's Outriders (Reliable)]                  │ │  focus starts here
│ │ 8 coin to sign, 1 a day; 60 days contract             │ │
│ │ 46 men: 2 Scouts, 1 Horse                             │ │
│ │ Here 20 days more                                     │ │
│ │ Loyalty 60 of 100 · Keep a contract while they are…   │ │
│ │ A handful of scouts who outlived their last employer… │ │
│ └───────────────────────────────────────────────────────┘ │
│ (status line)                                             │
│ [Leave them to their ale]   Esc cancels                   │
└───────────────────────────────────────────────────────────┘
```

The army card of a hired company adds three rows under Abilities: **Free
company** (Contract: 44 days left), **Loyalty** (61 of 100 (Reliable)),
**Bids** (No one bids for them / The crown bids 7 coin for them: 4 days to
match it); and the buttons Renew (12 coin) — only in the window — Match the
bid (7 coin) — only while a bid stands — and Dismiss (for Stand down).

## Audit of the wireframe against each skill (before code)

- game-ui-ux: every number the player decides on is in the row (fee, wage,
  contract, men, reputation, loyalty, days left); the cost of the decision
  that cannot be undone (signing) is on the button's own line, not a tooltip.
- game-feel: the hire closes the menu and says it in the result line; the
  counter appears with the next day; the bid has a countdown in words.
- Accessibility: the choice is a real button with its details as its
  accessible description; the menu is a labelled, described dialog.

## Findings log

| ID | Sev | Area | Finding | Fix | Phase | State |
|---|---|---|---|---|---|---|
| M-01 | P1 | one check | a market drawn from its own rules would drift from the sim | `Option.why = world.check(order)`; the tick applies `checkMercenaryOrder`, the same function | K7 | closed: tools/kingdom-mercenaries.ts "the same refusal when the order lands"; e2e `k7-tavern-hire` |
| M-02 | P1 | refusal said | a tavern still being built, or no company there | the lot's button stays, `aria-disabled` while the tavern is not standing, a press writes "Not now: there is no tavern of yours standing here"; an empty tavern's menu says nobody is there | K7 | closed: `lotCard` market button; `MARKET.none` |
| M-03 | P1 | stale controls | a company that turns its coat while its card is open would keep the king's buttons | the card re-reads the owner on refresh: "· gone over to the crown", every button withdrawn (focus to the heading) | K7 | closed: `armyCard` refresh |
| M-04 | P1 | a moving price on a button | "Match the bid" must say what it costs, and the bid only exists once made | the label is re-set on every refresh from the sim's bid | K7 | closed: `labels` in `armyCard` |
| M-05 | P2 | wrong action word | "Stand down" for a company sends nobody home and returns no levy | the button is **Dismiss**; its confirmation says the men are not the king's to send home and what a new contract would cost; focus starts on Keep them | K7 | closed |
| M-06 | P2 | counter mark | a company has no ordinal, so the Roman numeral was blank | the counter carries the company's initial | K7 | closed |
| M-07 | P2 | feed noise | a hire, renewal or matched bid said twice (result line and feed) | the feed is silent on those; it speaks on offers, moving on, the contract's last 15 days, a bid, and a leaving, each in its own words, and K4's generic "army gone" line is suppressed for a company's leaving | K7 | closed |
| M-08 | P2 | portrait phone | the market rows are long (six lines) | none in code: the shared menu scrolls | — | open, runtime pass pending (no browser here) |
| M-09 | P3 | grammar | K4's said-lines ("The Harker's Outriders digs in.") read oddly for a company's plural name | none yet | — | open (K10 text pass) |
| M-10 | P3 | touch | hiring by touch | the same buttons; no gesture is added | — | open, runtime pass pending |

No P0. Every P1 is fixed.

## Static re-audit after implementation

| ID | Sev | Note | State |
|---|---|---|---|
| M-01..M-07 | P1–P2 | as fixed above; text sizes are the shared menu's and card's (16px floor, ui-check); no animation is added, so reduced motion is unaffected | closed |
| M-08 | P2 | portrait phone scroll of the market | open, runtime pass pending |
| M-09 | P3 | said-line grammar for plural company names | open |
| M-10 | P3 | touch | open |
