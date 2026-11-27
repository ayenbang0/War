# K10: sieges — audit and static re-audit

| | |
|---|---|
| **Surface** | Everything K10 puts in front of the player: the contact dialog's **siege line** (how a siege is won, walls already battered) and the **keep's dialog**; the battle at a holding's walls (the works on the field, the open gate drawn, the HUD's walls-and-gates line, the **G** key); the after-action's wall, sack and keep lines; the feed's K10 lines; the region card's **Walls** row; the town plan's breaches; the wall lot's state, cost and **Repair walls** |
| **Source files** | `src/ui/kingdom/contact-dialog.ts`, `src/app/battle-layer.ts` (onKey KeyG, drawHud), `src/app/battle-config.ts` (siegeFromSpec), `src/render/terrain-layer.ts` (open gate), `src/ui/kingdom/consequences.ts`, `src/app/kingdom-layer.ts` (onEvent K10 cases), `src/ui/kingdom/cards.ts` (regionCard walls), `src/ui/city/cards.ts` (lotCard walls, repair), `src/render/city/renderer.ts` (breaches), `src/content/kingdom/descent-strings.ts`, `invasion-strings.ts`, `city-strings.ts`, `ui-strings.ts`; the battle AI as it meets works (`src/sim/world.ts` engines) |
| **Interactions** | march on a walled town; read the dialog; Fight; deploy and begin; press G to open and shut the gates (as their holder); fight to an end; read the report; back on the map, open the region card and the city; press Repair walls; at the king's own walls retreat to the keep and fight its siege |
| **Screen contract** | unchanged from K5/K8/K3b: contact dialog modal (`kingdom-contact`, first focus its title, traps, holds the clock, Esc does nothing -- the realm cannot go on until it is settled); battle layer (pen + camera + keys; G is a battle key, not a pen binding); after-action (`after-action`); city lot card (`lot-card`). The keep's dialog is the same screen pushed again for the same contact |
| **Skills applied** | game-ui-ux (state in words, refusals said, focus, event-driven HUD, text in tables) · game-feel (an order answers at once, and truthfully) · game-ai (the machine at walls: readability, fairness, no degenerate play) · create-game-assets (the open gate and the breach read apart) · camera-systems (n/a: K10 adds no camera behaviour) |
| **Passes done** | static (code) ✓ · runtime ☐ (no browser in this environment) · input: pen, keys and clicks by the e2e fake ✓ (`k10-siege-walls`, `k10-keep-gates`), touch ☐ · state: walls whole / battered / mending / down for good, keep entered, gate open / shut / held open by men, attacker and defender seats, AI against AI ✓ |
| **Auditor / date** | K10, 2026-11-26 |
| **Build / commit** | branch `k10` |
| **Constraints** | desktop web target; gamepad not a target; phone findings ≤ P2; English only, strings in tables |

## game-ui-ux

| Check | Result |
|---|---|
| The player knows what kind of battle this is before it starts | ✓ the dialog says "A siege: get N men inside the walls at once, or break the garrison, within M minutes. Batter a breach or force the gate." (attacker) or "hold for M minutes ... Your gates open and shut with G" (defender), and "its walls N% down" when battered (e2e reads it) |
| The keep is asked about, not settled behind the player's back | ✓ Retreat to the keep pushes the dialog again for the keep ("The keep of X"); the keep is not offered twice (e2e) |
| State in words, not colour | ✓ HUD "walls whole" / "walls N% down"; "gates shut - G to open"; the breakthrough line "through to inside the walls: n/N" / "keep them from ..." |
| Controls offered only when they work | fixed (K10-02): the HUD offered "G to open" while deploying and after the outcome, when G did nothing |
| The HUD reacts to the sim, it does not poll it | fixed (K10-03): the walls figure walked the whole circuit every frame; now read once per sim tick (and when deploying or the outcome changes) |
| Costs said in the card's own words | fixed (K10-01): what mending costs was only in the button's `title`; the wall lot now says it ("Mending costs ..., paid now; the masons put back a tenth of the works a day") |
| Refusals said | ✓ Repair walls refused stays in the card, `aria-disabled`, the reason in the note (not yours, whole, already paid, cannot afford); the keep refused says why; a second keep refused |
| Consequences reported where they are decided | ✓ the after-action says what the siege knocked down, the sack, and whether the keep held; the feed repeats it; the region card and the lot card show the walls' state until mended (e2e) |
| Text in tables | ✓ every new line is in `descent-strings.ts`, `invasion-strings.ts`, `city-strings.ts`, `ui-strings.ts`; the HUD's siege line is plain English in battle-layer like its other HUD lines (the battle HUD has no string table yet: existing, K11) |
| A pointer way to the gates | open (K10-05, P2): G is keyboard-only; the left button is the pen's and the battle HUD is canvas text with no buttons. K10.15 |

## game-feel

| Check | Result |
|---|---|
| An order answers at once | ✓ G issues the order for the next tick; the gate redraws (chunk re-bake on the tile's revision), the HUD line flips, the pen's action line says "gates open" / "gates shut" |
| The answer is true | fixed (K10-04): shutting a gate with men in it said "gates shut" while the sim (rightly) left it open; now "men in the gateway - it stays open" (`World.gateHeldOpen`) |
| Damage reads | ✓ the HUD gives the walls' state in figures from the first frame; old damage stands as rubble where whole tiles fell and as wear on the rest (drawn as cracks on the holder's own walls, P8.10); the town plan draws one breach per quarter down |

## game-ai

| Check | Result |
|---|---|
| The machine storms walls sensibly | ✓ engines go for gates first (open or shut), then curtain; real headless sieges are won by the machine attacking (an assault on Harrowfield, the crown-siege twice in the playthrough) and lost when it brings no engines (the playthrough's levy-only king is held: that is why the real run's bot takes a siege train) |
| The machine holds walls sensibly | ✓ the defender holds inside its works; it never swings its gates (K10.15), so it never opens a door to a stronger host -- no sally either (P3, K10-06) |
| Same rules as the player | ✓ the `gates` order is refused to the besieger for both; the captains mend walls through the same `repairWalls` order and price (K10.18) |
| AI against AI | ✓ still auto-resolved on the spot (K10.10), battering the walls by the resolve's own draws; `tools/kingdom-sieges.ts` checks it at the commons' walls |
| Deterministic | ✓ the works are a pure function of the spec; the same siege twice is the same battle to the man (hash and result); gates swing the same on two peers; the playthrough's real run replays from its log |

## create-game-assets

| Check | Result |
|---|---|
| An open gate never reads as a breach | ✓ the open gate is drawn as a paved arch with its leaves folded against the jambs (a dark bar each end), on its own palette entry; a breach is rubble (P8's rubble tile) |
| The town plan's breach reads as one | ✓ a gap in the ring in ground colour with stones in it, palisade or stone by the work |

## Findings log

| Id | Sev | Finding | Status |
|---|---|---|---|
| K10-01 | P1 | The wall lot's Repair walls said its cost only in the button's tooltip: a keyboard or touch player could not see what it would take before pressing (`src/ui/city/cards.ts`) | fixed: the walls row says the cost; the e2e reads it |
| K10-02 | P1 | The HUD said "gates shut - G to open" while deploying and after the outcome, when G is ignored (`battle-layer.ts` drawHud) | fixed: the gates are offered only while G can swing them; the e2e checks both |
| K10-03 | P2 | The HUD's walls figure walked the whole circuit every frame (polling, against the event-driven HUD rule) | fixed: read once per sim tick |
| K10-04 | P1 | Shutting a gate with men in the gateway reported "gates shut" though the gate (rightly) stayed open | fixed: "men in the gateway - it stays open"; `siege-check` checks `gateHeldOpen` |
| K10-05 | P2 | The gates have no pointer control (keyboard G only) | **fixed K11**: a gate button on the ability bar for the defender, the same path as G (e2e `k10-keep-gates`) |
| K10-06 | P3 | The machine never sallies from its gates | open: a sally is battle-AI work that would move the battle goldens; left for the AI pass (K11.10) |
| K10-07 | P2 | Runtime pass at the five sizes not done (no browser here) | open, the next browser run |

Gate (§C.6): no open P0/P1 on the surfaces K10 touches.
