# War — master plan

**Status: PLAN ONLY. No code is written by this document.** Branch `main`, fast-forwarded to `a53efc7` (Pages publish) before writing.

Contents
- **Part A — Storyline: The Exile of Rimaros** (new)
- **Part B — The Kingdom layer** (new): design, sim architecture, layer handoff, phased build
- **Part C — UI/UX audit programme** (new): inventory, method, gates
- **Part D — Delivered work, phases 0–10 + content** (the previous PLAN.md, unchanged, below the divider)
- **Appendix — Audit skills, verbatim** (`game-ui-ux`, `create-game-assets`, `game-ai`, `game-feel`, `camera-systems`)

Open questions for the user are collected in **§A.7 / §B.12**. Everything marked *[PROPOSAL]* is a recommendation to be confirmed, not a decision.

---

# Part A — Storyline: The Exile of Rimaros

## A.1 Premise (user-supplied, fixed)
You are the fallen king of **Rimaros**, exiled to the farthest parts of the kingdom. Fight your way back by claiming territory until you are king again.

## A.2 What already exists and how it is reused
The repo already ships a nine-battle campaign, *The Marchwarden's Chronicle* (`src/content/campaign.ts`, `src/ui/campaign.ts`): the **Margrave of the Red March** invades with eight beast-badged captains (Boar, Fox, Badger, Hare, Wolf, Owl, Stag, Crow — `src/content/commanders.ts`), a Regent (Isolde), a chronicler (Brother Aldous), a forged scout letter, one irreversible fork. The player there is a *Marchwarden*, a defender.

**[PROPOSAL] Re-frame, do not discard.** The Marchwarden campaign becomes the *backstory and Act III set-piece content* of the new story; the player's role flips from defender to the deposed king reclaiming ground. Concretely:
- The eight captains are the **usurper's regional governors** ("the Menagerie"). Each holds one region of the kingdom; each already has a distinct AI personality (`bias`, `boldness`) — that personality now also drives their **kingdom-layer** behaviour (§B.8).
- Brother Aldous remains the chronicler; his entries become the narration of the **kingdom ledger** (the chronicle screen). Isolde becomes a pivotal figure (see A.4).
- The ten battlefields map onto regions of the kingdom map (§B.2). The existing nine chapters are rewritten as **scripted first-encounters** with a captain, not a linear chain.
- Anything in the old campaign that contradicts the new premise is rewritten; `Progress`/`recordBattle`/`freshProgress` are replaced by the kingdom save (§B.10). One cutover, no shim.

## A.3 Setting
Rimaros: a river kingdom of **eight provinces around a crown seat**, ruled for generations from the city of Rimaros. Low/medium fantasy (locked, Part D). Magic is rare, feared, and in the hands of Adepts the crown licensed.

*Names below are working names [PROPOSAL]; rename freely.*

| Region | Terrain family (existing `country`) | Governor (existing commander) | Role in the story |
|---|---|---|---|
| **The Farthest Reach** (start) | cold, sparse, broken | none — friendly exile camp | Act I |
| Red March | border hills | Margrave (the face of the coup) | Act II boss |
| Lisle Bridges | river / `the-crossing` | Badger | Act II |
| Hallow Ferry | river town | Owl | Act II choice |
| Long Wood | forest | Boar | Act II |
| Vale of the Hare | open `proving-ground` | Hare | Act I/II |
| Open Fields | open `open-field` | Fox | Act III |
| Stag Heights / Wolf Moor | highland / moor | Stag, Wolf | Act III |
| Crow's Reach | coast / carrion-fields | Crow | Act III |
| **Rimaros, the Crown Seat** | walled city | the usurper | Act IV |

(Region count and mapping to the ten existing levels is finalised in §B.2.)

## A.4 Cast *[PROPOSAL]*
- **The Exiled King** (player). Name chosen by the player at start, default *Aldric of Rimaros* [placeholder]. Has two kingdom-wide stats that story choices move: **Legitimacy** (do the lords believe you are the rightful king) and **Mercy/Terror** (how you treat the conquered). These decide the ending and feed morale (§B.6).
- **The Margrave of the Red March** — the visible architect of the coup, a field commander, not the real power.
- **The Regent, Isolde** — *twist candidate:* she was the king's own regent and signed the exile; whether she is villain, coward or secret ally depends on a mid-game choice. Her letters (already written) are re-read with the new context.
- **Brother Aldous** — chronicler and (new) the king's only literate loyalist in exile; carries the ledger UI voice.
- **The Eight Captains** — Boar, Fox, Badger, Hare, Wolf, Owl, Stag, Crow; each becomes a recurring enemy *with a kingdom-layer habit* (Hare raids, Badger fortifies, Owl sieges, Boar marches straight at the capital of whoever is weakest, etc. — derived from existing `bias`).
- **Mercenary captains** — named free-company leaders (reuse `content/companies.ts` naming); they have loyalty and price, and can betray you (§B.7).
- **The usurper** — identity is an open question (A.7).

## A.5 Structure: four acts, gated by claimed territory

| Act | Title | You hold | Goal to advance | Kingdom-layer lesson |
|---|---|---|---|---|
| I | **The Farthest Reach** | 1 village, 1 army (remnant guard), little coin | Survive winter, win first skirmish, claim 2 neighbouring holdings | economy, farms, one army, first battle descent |
| II | **The Marches** | 3–6 holdings | Take a border governor's seat (a captain) | multiple armies, mercenaries, supply, invasions to defend |
| III | **The Heartland** | ~40% of map | Legitimacy threshold + hold a held region through a season of counter-invasion | morale/unrest, garrison management, two-front war |
| IV | **The Crown** | ≥ N regions incl. a road to Rimaros | Siege and retake Rimaros; coronation | siege layer (needs Phase 8), final defence, endings |

Progress is **earned by territory**, not by a chapter counter: act transitions are triggered by the kingdom state (regions held, legitimacy), narrated by a chronicle entry. Defeat does not end the game (existing design principle): losing an army or a region is written into the chronicle and the war continues; only losing the king (see B.9) or the capital-of-exile ends a run.

## A.6 Delivery of the story in-game (no new engine)
- **Chronicle / ledger screen** (existing `ui/campaign.ts` evolves): dated entries, letters, events.
- **Event cards** on the kingdom layer: story beats, forks, and random events presented as a letter with 2–3 choices. Data-driven in `src/content/story/` (plain data, like `campaign.ts`).
- **Endings (≥3)** by Legitimacy × Mercy: *The Restored King* (just), *The Iron Crown* (feared), *The Hollow Crown* (low legitimacy; held by force, with permanent unrest). Plus the *failure* ending (king captured/slain).
- All text is data in tables keyed by id so it can be localised and audited (§C).

## A.7 Open story questions
1. Reuse Margrave/Beast captains as above, or a fresh cast? (Recommendation: reuse.)
2. Who is the usurper: the Margrave, the Regent, or a third party revealed in Act III?
3. Player gender/name/portrait: fixed or chosen?
4. Tone dial: grim vs. wry (the existing chronicle voice is dry and humane; recommendation: keep).

---

# Part B — The Kingdom layer

## B.1 The three layers
| Layer | Name | Subject | Time | Input | Status |
|---|---|---|---|---|---|
| 3 | **Kingdom** | regions, roads, economy, armies as tokens | days; slow real-time, pausable | pen on a map | **new** |
| 2 | **Army** | squads/companies on a battlefield | 20 Hz tick (`World`) | pen gestures (existing) | exists |
| 1 | **Troop** | individual soldiers, formation slots, steering | 20 Hz tick (inside `World`) | indirect (formations) | exists |

Rule: **one layer is live at a time.** Layer 3 is paused while a Layer-2 battle runs; armies not in that battle are frozen with it. The layers are a typed state machine (`Layer = KingdomLayer | BattleLayer`), never booleans (house rule 2).

## B.2 The kingdom map
- **Graph of regions/holdings** (target 30–50), each a node with: position, biome (maps onto existing `country` presets and level seeds), owner, population, garrison slots, building slots, field plots, and road edges (cost by terrain).
- **Roads** are edges; armies travel along edges at speed set by army composition (slowest squad, doctrine speed, terrain, supply wagon presence). Mid-edge position is continuous so armies *can* meet between towns.
- Generation: **authored** (handmade graph in `src/content/kingdom/`) for the campaign; a seeded procedural graph for skirmish later. Terrain preview for a battle at a node is generated from `region.seed` using the existing terrain generator, so the same node always yields the same battlefield.
- Fog at the kingdom layer: you see your regions + radius around armies and watchtowers; enemy movements are rumours until seen (reuses the three-state fog idea of Phase 4 at graph scale).

## B.3 Resources and economy
Five stockpiles plus two soft stats. Every one must feed a decision, or it is cut.

| Resource | Source | Sink | Why it matters |
|---|---|---|---|
| **Coin** | taxes (population × tax rate), trade routes, plunder | wages, mercenaries, buildings, bribes | hiring and upkeep |
| **Grain** | **farm plots** (seasonal growing), granaries | army rations, town consumption, winter | starvation drives unrest and attrition |
| **Timber** | woodcutters in forest regions | buildings, siege engines, repairs | siege and fort building |
| **Iron/arms** | forges, mines | new squads of heavy types, replacements | replacing losses |
| **Levy (manpower)** | population share per region | recruiting squads | caps growth, depopulates regions |
| **Legitimacy** (soft) | winning, mercy, keeping oaths, ceremony | decays when you lose or break promises | unlocks acts, lords' allegiance |
| **Morale / Unrest** (soft) | per region & per army (§B.6) | — | revolts, desertion |

**Growing plants (explicit request).** Each region has **field plots**. A plot is planted with a crop and follows a **season calendar**:
- Crops *[PROPOSAL]*: wheat/barley (grain, spring→autumn), rye (hardy, winter sowing, low yield), flax (coin + cloth, morale from clothing), herbs/poppy (feeds healer squads' mend strength and `healer`/`mage` upkeep), orchard (slow, multi-year, big). Data-driven in `content/kingdom/crops.ts`.
- State per plot: `empty → sown → growing(progress) → ripe → (harvested|spoiled)`, with weather events (drought, frost, flood — reuse `floodAtSeconds` idea at day-scale) and **raids burn crops**. An army camped in a region **forages** and ruins plots (a deliberate tension: supply vs. local goodwill).
- Winter is the main pressure of Act I: not enough stored grain ⇒ attrition, desertion.

**Buildings** (slots per region): farm/mill, granary, woodcutter, forge, barracks (levy → squads), tavern (mercenary and rumour source), watchtower (vision radius, invasion early warning), palisade/wall/keep (defence value used in battle spawn and siege), shrine/hall (legitimacy, morale), market (coin). Each has cost, build time (days), upkeep, and a **defence/battle effect** where relevant.

## B.4 Armies at the kingdom layer
- An **army token** wraps an existing `ArmyList` (`content/army.ts`: doctrine + squads) plus kingdom state: location/edge progress, destination queue, **supply** (grain carried), **army morale** (§B.6), commander (player/captain), wage status.
- Create by recruiting at a barracks (spends coin + levy + iron per squad type; uses the existing unit costs and caps — one rulebook), or by hiring mercenary companies.
- **Merge/split** armies at a node (reuses the pen's group verbs conceptually: line = split, etc.). Hard cap on armies per side (target ≤ 8) so the layer stays readable.
- **Persistence across battles:** squads keep **current strength**, so a battle result returns survivors; wounded recover over days in a town with healers/hall; losses are replaced from levy+iron. This makes attrition real, a design requirement of "manage resources."
- Doctrine remains a **per-army** choice (already army-wide); abilities become **kingdom-earned** (spend Legitimacy/coin to unlock), replacing the point-buy purse of one-off battles for campaign play. Skirmish mode keeps point-buy.

## B.5 Orders at the kingdom layer (pen-first)
The **left button is the pen** (house rule); the kingdom layer must not break that. Proposed minimal vocabulary, reusing shapes the recogniser already discriminates, in a *separate recogniser context* so it cannot collide with battle gestures:
| Stroke | Meaning |
|---|---|
| Line from army to region/road | **March** there (path preview ghost, ETA label) |
| Line from army to enemy army | **Intercept** |
| Ring on own region | **Garrison / hold** (army digs in, defence bonus) |
| Large ring around region group | **Patrol / screen** |
| Line across an army (split) | **Split** army |
| Stroke between two own armies | **Merge** |
| Heart | **Recover** (reuse; rest & heal at node) |
| Tap region | open **Region card** (economy panel); tap army → **Army card** |

Non-pen actions (hire, build, plant, set tax) are buttons in panels; pen is for *spatial* intent only, which is what the project already commits to. New classes must be added to `tools/gesture-corpus.ts` and the confusion matrix must stay diagonal **with the competing vocabulary live**; additionally drive real strokes in a real browser (CLAUDE.md lesson). Time control: space = pause, speed 1×/2×/4×, `.` steps a day when paused.

## B.6 Morale at the kingdom layer
Three nested morale values, all deterministic and all documented with their inputs:
1. **Army morale** — carries over from battles; modified by pay (late wages ↓), food (hungry ↓), recent victories ↑, retreating ↓, leader presence ↑. Feeds the **starting morale** of squads in the next battle (so the layers are coupled, not merely sequential).
2. **Regional unrest/loyalty** — high taxes, conscription, garrison brutality, hunger, lost battles ↑unrest; shrines, justice, festivals, mercy ↓. Unrest ≥ threshold ⇒ **revolt** (spawns a rebel army or flips the region), ≥ lesser ⇒ lowered income.
3. **Realm Legitimacy** — the king's global standing (see §B.3); gate for allies and acts.
Each effect is a table in `content/kingdom/morale.ts` with unit-tested monotonicity (a test per input proving the sign), following the Phase 6 "no doctrine strictly better" test style.

## B.7 Mercenaries
- Sources: **taverns** and **free-company camps** (roaming nodes that appear/disappear). Each company: type mix (existing 18 unit types), **price (signing fee + wage/day)**, **contract length**, **loyalty** (0–100), reputation (e.g. "reliable", "bloody", "turncoats").
- Lifecycle: `offered → hired → on contract → (renewed | expired | deserted | defected)`. Missed wages drop loyalty; a rival's higher bid can **poach** them; an unpaid company can **turn on you** (a story and AI-drama hook).
- In battle they are ordinary squads with an optional **trait** (e.g. "breaks if outnumbered").
- Distinct from levy: no levy cost, high coin cost, no replacement pipeline.

## B.8 Invasions, defence and the enemy kingdom AI
- Enemy factions (the captains) run a **strategic AI** with the same constraints as the player (kingdom-layer fog, economy, supply). Lives in `src/sim/kingdom/ai.ts`; issues the same `KingdomOrder`s through the same queue (same replay argument as the Phase 5 battle AI), uses its own rng stream, may only act on what it has seen.
- Each captain has a **strategic posture** derived from existing `bias`/`boldness` plus a goal (raid, besiege, consolidate, snipe weakest).
- **Invasions:** scheduled *and* emergent. Scripted waves (story) + opportunistic attacks when a garrison is thin. The player gets **warning** proportional to watchtowers/scouts: a rumour card ("riders seen on the Lisle road, 3 days out").
- **Defence tools:** garrison, levy call (emergency squads, poor quality, fast), burn-the-fields (denies supply, costs unrest), walls/palisades (battle effect), retreat to keep (forces a siege), ambush on road node (battle with deployment advantage).
- A region with no army can be **taken without a battle** if its garrison is empty; with garrison/walls it triggers a Layer-2 **siege or defence battle**.

## B.9 Dropping a layer: kingdom → army (the requested transition)
**Trigger (deterministic, evaluated once per kingdom tick, in army-id order):** two armies of hostile factions are within `ENGAGE_RADIUS` on the same edge/node, *or* an army reaches an enemy-held node that has a garrison/walls.

**Handoff contract** (`src/sim/layers.ts`, types only):
```
BattleSpec  = { seed, terrainSpec(region biome+road/node+fortification), sides[2]: ArmyList + per-squad current strength + start morale + doctrine + commander,
                deployment (attacker/defender, ambush flag), victory (rout | survive | breakthrough | siege), duration, weather/season sight modifiers, reinforcements-from-adjacent }
BattleResult = { winner, per-squad survivors (hp fraction & dead), morale out, captured/fled flags, region damage (crops burned, buildings damaged), legitimacy delta }
```
- `BattleSpec` is built from kingdom state by one pure function; `BattleResult` is applied back by one pure function. Both are unit-tested and hash-covered (roundtrip: spec→result→apply leaves a consistent kingdom; zero-survivor and full-survivor boundaries).
- **Existing `World` stays unchanged** apart from accepting per-squad starting strength/morale and non-point-buy armies (small, additive config; golden `world` tier will move — regenerate with a stated reason; `stable` tier must not).
- **Auto-resolve:** AI-vs-AI engagements the player isn't present at, and optionally the player's "resolve for me", use a deterministic abstract function (strength × doctrine × terrain × morale with rng stream `autoresolve`), documented as *strictly worse in expectation than fighting it yourself* so the player layer is a reward, not a chore. If both are AI they use it by default; headless `World` is too heavy for every AI skirmish.
- **Player experience:** kingdom clock auto-pauses on contact, a **short interstitial** ("Riders on the Lisle road — fight / withdraw?") with the existing deployment screen reduced to a *confirm* (army is pre-built; deploy-zone dragging remains). Withdrawal is allowed with a cost (rearguard losses, morale hit) unless cut off.
- **Reverse transition (back up):** on battle end the after-action report (existing `ui/after-action.ts`, extended) shows kingdom consequences, then returns to the map **at the contact point** with the camera easing (see `camera-systems` in the appendix).
- **Layer hash:** kingdom hash covers state; battle hash covers `World`; combined `layerHash = h(kingdomHash, battleHash?)` so desync tools identify the layer that drifted (same philosophy as the stable/world split).

## B.10 Simulation architecture (obeys CLAUDE.md invariants)
- New `src/sim/kingdom/` — pure, headless, **no DOM**, **no `Math` outside `sim/math.ts`**, no `Date`, no `Math.random`; **own rng streams** (`economy`, `events`, `kingdom-ai`, `autoresolve`, `weather`) via `sim/rng.ts`, so adding a roll in one never shifts another. Entity ids from one monotonic counter; iteration by id order.
- Time: **sim day = fixed number of kingdom ticks**; kingdom tick is not coupled to the 20 Hz battle tick. A `KingdomWorld` has `tick(orders)`; orders are serialisable commands queued to the next tick boundary (same as battle).
- Content in `src/content/kingdom/` as plain data (regions, buildings, crops, goods, events, mercenary tables, story). Validation lives there (like `army.ts`), not in UI.
- Rendering in `src/render/kingdom/` (a new renderer that never writes to sim state); UI in `src/ui/kingdom/`; input in `src/input/` with a kingdom-context recogniser.
- `src/main.ts` today is a linear script (home → menu → one World). It must become a **layer controller** (screen stack, §C.4) owning `KingdomWorld` and an optional `World`; this is the one big refactor and is its own phase (K0).
- **Save/load:** versioned snapshot + order log in localStorage (key `war.kingdom.v1`), plus export/import file; crash-safe (write then swap), migration function per version. Replaces `war.chronicle.v1`.
- **Tests:** `tools/kingdom-headless.ts` (economy conservation, seasons, plot state machine, supply, morale monotonicity, mercenary lifecycle, descent roundtrip), `tools/kingdom-lockstep.ts` (two `KingdomWorld`s + one order log → identical hashes; out-of-order orders change nothing; 0.0001 nudge detected), headless multi-year AI-vs-AI soak (no NaN, no negative stocks, no stuck armies), added to `npm test`.

## B.11 Phased build (every phase ends at something runnable)
| Phase | Deliverable | Runnable proof |
|---|---|---|
| **K0 Layer controller** | Screen stack + `Layer` state machine in `main.ts`; existing game unchanged behind it | all existing tests green; battle still launches |
| **K1 Kingdom sim core** | `KingdomWorld`, region graph, day clock, order queue, hash, save/load | headless: 10 simulated years, deterministic hash |
| **K2 Map view + pen** | kingdom renderer, camera, region/army cards, march orders, ETA ghost | click-through in browser; gesture corpus extended, matrix diagonal |
| **K3 Economy & farming** | stockpiles, taxes, buildings, plots/crops/seasons, famine | headless economy conservation tests; a winter is survivable/unsurvivable by choice |
| **K4 Armies & recruitment** | army tokens, recruit, merge/split, supply, wages, persistence of squad strength | recruit→march→starve test |
| **K5 Descent** | contact detection, `BattleSpec`/`BattleResult`, interstitial, after-action→kingdom, auto-resolve | a march into an enemy army launches a real battle and returns survivors |
| **K6 Morale, unrest, legitimacy** | three morale systems, revolt, desertion, links into battle start morale | monotonicity tests |
| **K7 Mercenaries** | taverns, companies, contracts, loyalty, poaching | lifecycle tests; betrayal scenario |
| **K8 Enemy kingdom AI & invasions** | strategic AI per captain, warning/rumours, defence tools | soak: AI doesn't cheat (acts only on seen info — asserted); 3 invasions repelled/lost both reachable |
| **K9 Story** | acts, event cards, forks, endings, chronicle screen over the kingdom ledger; Marchwarden chapters re-cast | full playthrough script reaches each ending |
| **K10 Sieges (Phase 8 dependency)** | finish Phase 8 destructible terrain → siege battles for walls/capital | Act IV playable |
| **K11 Balance & polish** | tuning pass, difficulty at kingdom layer, tutorial for layer 3, audio | headless balance sweeps; user playtest |
| **K12 Netplay readiness** | kingdom lockstep verification | `kingdom-lockstep.ts` green |

**Dependencies / risks:** (1) Phase 8 is unfinished and Act IV needs it — scope-cut option: capital siege as an *assault with fixed walls* if Phase 8 slips; (2) `main.ts` monolith (512 lines) must be split before K2; (3) World currently assumes point-buy armies and fresh-hp squads — the additive config in B.9 is the only intrusion; (4) economy balance is the long pole — build headless sweeps early; (5) scope: 40-node map × 8 factions in a pen-only UI risks clutter — hard caps on armies.

## B.12 Open design questions
1. Kingdom time: **real-time pausable** (recommended: matches "real-time only" spec and lockstep) vs. turn-based.
2. Scale: 30–50 regions OK? Armies cap of 8/side?
3. Keep point-buy for campaign armies or fully replace with recruitment (recommended: replace; keep point-buy for skirmish)?
4. Auto-resolve: allowed for the player, or only AI-vs-AI?
5. Permadeath of the king: lose the run or just a major setback?
6. Multiplayer: remain a later phase.

---

# Part C — UI/UX audit programme

**Scope:** *all* UI/UX elements and interactions — existing and new — are audited against the skills the user provides. The skills named so far are reproduced **verbatim in the Appendix**; the user will add more. Nothing below presumes findings; the lists are inventories and checks to run.

## C.1 Skills to apply (provided so far)
| Skill | Lens |
|---|---|
| `game-ui-ux` | layout/scaling policy, safe areas, gamepad & keyboard focus, screen stack, event-driven HUD, text size/contrast/colour-blindness, localisation |
| `game-feel` | feedback on every pen stroke, click, hit, order commit, layer transition |
| `camera-systems` | pan/zoom, edge-push, layer-transition framing, follow/lag, no jitter/overshoot |
| `game-ai` | kingdom-layer and battle AI legibility/fairness (what the AI sees/does is visible to the player) |
| `create-game-assets` | procedurally drawn art (no sprite assets): icons, counters, banners, palette consistency, provenance |
| *(to be supplied)* | e.g. accessibility, input-systems, audio — slot in via §C.5 |

Note: several of these skills are written for Godot/Unity. This project is TypeScript + DOM + Canvas 2D; **engine-specific API snippets do not apply — the principles and checks do** (the audit translates, e.g. "focus owner" → `document.activeElement`).

## C.2 Inventory of existing surfaces (from the current repo)
Each row gets an audit sheet. Source files are the places to read.
| Surface | Source | Interactions |
|---|---|---|
| Home screen | `src/ui/home.ts` | play / tutorial / campaign |
| Army setup menu (point buy, doctrine, abilities, commander, difficulty, level) | `src/ui/menu.ts` | many form controls; preset from chapter |
| Chronicle/campaign screen | `src/ui/campaign.ts` | read letters, choose fork |
| Tutorial | `src/ui/tutorial.ts` | stepwise pen lessons |
| Battle HUD (timer, global morale, doctrine) | `src/main.ts drawHud`, `index.html #hud` | read-only text panels, `pointer-events:none` |
| Ability bar (keys 1..5) | `src/ui/ability-bar.ts` | keyboard + click |
| After-action report | `src/ui/after-action.ts` | read, continue |
| Pen strokes, ghost preview, order viz, selection | `src/input/pen.ts`, `gestures.ts`, `commander.ts`, `render/ink.ts` | 14 gesture classes |
| Camera (WASD/arrows, edge push, middle/right drag, wheel zoom) | `src/input/camera-controls.ts`, `render/camera.ts` | |
| Global keys (space, `.`, etc.) | `src/main.ts:264` | |
| Fog/vision, selection, status overlays, effects | `render/*` | feedback legibility |

## C.3 New surfaces to design and audit *before* coding them
Kingdom map & HUD (resources bar, date/season, speed controls, alerts feed), region card, army card, recruit/hire dialog, mercenary market, farm/plot manager, build menu, event/letter card with choices, diplomacy/legitimacy panel, kingdom-to-battle interstitial, after-action with kingdom consequences, chronicle/ledger, save/load/settings, pause, confirm dialogs, tutorial for layer 3, end-of-game screens.

## C.4 Screen architecture (fixes what the audit skill demands)
- A **screen stack** (push overlays, pop back; only the top takes input; focus restored on pop) replacing the current promise-chained script in `main.ts`. Each screen declares: first-focus element, focus trap, whether it pauses the sim, which input contexts are active (pen / camera / UI).
- **HUD event-driven**: sim emits events (`moraleChanged`, `stockChanged`, `armyArrived`…); HUD subscribes and renders on change, not by polling in the frame loop.
- **One scaling policy**: reference size, DPR handling, minimum text sizes; the canvas map stays pen-first; DOM panels follow the policy.
- Strings in tables (story text and UI labels), so localisation and length-testing are possible.

## C.5 Audit method (per surface, per skill)
1. **Static pass** — read the source against the skill's checklist; record findings with file:line.
2. **Runtime pass** — launch (`npm run dev`), drive the surface in a real browser, take screenshots at: 1280×720, 1920×1080, 2560×1080 (ultrawide), 1080×2340 (portrait phone), and at 200% text zoom.
3. **Input pass** — mouse only; keyboard only (Tab order, Esc to back, visible focus); touch/stylus via Pointer Events; gamepad *only if the user wants it a target* (open question C.7).
4. **State pass** — empty, extreme (long names, 0 items, 45 squads, max stock), error (storage refused), pause/resume, window blur, resize mid-stroke.
5. **Findings log** in `docs/audit/<surface>.md`: severity **P0** (blocks play / data loss), **P1** (wrong or confusing), **P2** (friction), **P3** (polish); each with skill rule violated, evidence (screenshot/line), proposed fix, owner phase.
6. **Gate:** no phase K2+ ships with open P0/P1 on the surfaces it touches; P2/P3 are batched in K11.

**Hypotheses to verify in the first static pass** (observations from the repo, *not yet findings*): there are zero `aria-*`, `tabindex` or `role` attributes anywhere in `index.html`, `src/ui/*`, or `main.ts`; HUD/overlay type is 11–13px monospace on a parchment background; there is no `prefers-reduced-motion` or `@media` handling in `index.html`; keyboard handling is ad hoc (`main.ts:264`, `pen.ts:44`, `camera-controls.ts`); one global `keydown` per module suggests overlapping key ownership; colour likely carries player/enemy identity. The audit confirms or refutes each.

## C.6 Audit deliverables and sequencing
- **U0 (before K0):** baseline audit of Part C.2 surfaces → `docs/audit/baseline-*.md`; fix list sized into K0/K2.
- **U1 (K2):** paper/wireframe + audit of kingdom map HUD *before* implementation; re-audit with screenshots after.
- **U2 (K3–K7):** per-panel audits as each lands.
- **U3 (K9):** story/letter/ending screens (text legibility, choice clarity, pacing).
- **U4 (K11):** whole-game sweep with every skill the user has supplied by then; final screenshot matrix archived.
- A reusable **audit checklist template** (one per skill, derived from the Appendix text) lives at `docs/audit/TEMPLATE.md`.

## C.7 Open audit questions
1. Gamepad: a target input device, or mouse/stylus/keyboard only? (The pen design implies pointer-first; `game-ui-ux` assumes gamepad navigability.)
2. Target form factors: desktop only (the spec says PC web), or phone/tablet too?
3. Localisation: planned, or English only (affects string-table work)?
4. Which further skills will be provided, and should they run as additional columns in each audit sheet?

---

# Part D — Delivered work (previous `PLAN.md`, unchanged)

# War — build plan

Design spec: `Idea.txt`. Conventions and invariants: `CLAUDE.md`.

## Locked decisions
| Decision | Choice |
|---|---|
| Scope | Full spec, phased |
| Stack | TypeScript + Vite + Canvas 2D, no engine |
| Sim fidelity | Full per-soldier agents (~10-20/squad, ~150-300/side) |
| Gestures | Pure shape recognition, no modifier keys |
| Determinism | Deterministic lockstep from day one; netplay is a later phase |
| Art | Map-table wargame aesthetic, procedurally drawn |
| Input | Mouse-first, stylus-compatible via Pointer Events |
| Setting | Low/medium fantasy medieval |
| Win condition | Global morale rout, else higher global morale at 15:00 |
| Delivery | This doc, then build Phase 0 onward |

## Movement is three layers, never conflated
1. **Squad route** — coarse grid A* / flow field over terrain cost. Ignores soldiers.
2. **Slot assignment** — soldiers claim positions in the formation template, transformed to the squad's position and facing.
3. **Local avoidance** — per-soldier steering against neighbours and obstacles, resolved through a uniform-grid spatial hash (naive pairwise at 600 agents is 180k checks/tick; the hash makes it trivial).

Collapsing any two of these is the standard way formation movement turns to mush.

## Gesture discrimination table
Six gestures from raw strokes collide in three places. Resolve in this order:

| Order | Test | Beats |
|---|---|---|
| 1 | **Attack** | Stroke endpoint hit-tests a visible enemy. Resolved before any shape classification. |
| 2 | **Formation change** | Stroke is drawn *at* the unit (centroid within footprint radius) and template-matches a formation glyph. |
| 3 | **Hold** vs **Patrol** | Both closed. Small enclosed area, single lobe, tight perimeter → Hold. Large area or multi-lobe circuit → Patrol. |
| 4 | **Move** vs **Retreat** | Both open lines. Direction relative to nearest known enemy and own deployment edge decides. |

During the stroke, render the interpreted order as a ghost preview; commit on release. This is not a UI button — spec §11.2 asks for exactly this feedback.

## Phases
Every phase ends at something runnable.

### Phase 0 — Foundation — **DONE**
Vite + TS scaffold, directory boundaries, `sim/math.ts` (polynomial trig), `sim/rng.ts` (sfc32, per-subsystem streams), fixed-tick loop with render interpolation, order queue, terrain generator, headless Node runner, state-hash replay test, purity scanner, chunked terrain renderer, camera.

**Verified:** 22 headless checks pass; the browser reproduces Node's golden hash `f57db420` bit-for-bit over a scripted 1800-tick run; sim cost is 1.0 ms/frame (6% of a 60 fps budget) and 1800 ticks execute in 11 ms.

### Phase 1 — Squads, formations, movement — **DONE**
Squad and per-soldier entities (soldiers in struct-of-arrays), six formation templates, the three movement layers kept strictly separate, uniform-grid spatial hash, A* with deterministic tie-breaks and string pulling, terrain movement cost, the unit roster.

**Verified:** 460 soldiers at **0.20 ms/tick** (248x real time); squads on open ground hold cohesion > 0.85 through a march and a wheel; formations compress around impassable terrain instead of stranding men; no soldier ever ends a tick on water, including via dense paths.

### Phase 2 — Pen control — **DONE**
Pointer-event capture on the left button (world-space from the first sample), RDP simplification, the six-gesture recognizer, ghost preview with commit-on-release, ink rendering, per-order visualization, selection.

**Verified:** the confusion matrix over 85 synthetic jittered strokes is **fully diagonal** — all six gestures plus four formation glyphs and selection, across seven squad facings. All six drive the sim end-to-end through the real pointer path.

**Group verbs** (added on request): with two or more squads selected and the stroke drawn clear of any squad, a straight line **splits** the selection (squads visually left of the stroke are kept, so drawing it the other way keeps the other half); a second parallel line within 1.2s instead lays the group out in **rows and columns**; a large circle becomes a **patrolled area** with the squads spread around one ring as a cordon; and a heart is **recover** — 30 seconds of morale and hit-point regeneration during which the squad accepts no orders at all. The lock is enforced in the simulation, not the UI, so it binds the AI and replayed order logs equally.

Three rules earned their keep and should not be relaxed:
- **The subject rule.** A stroke starting on one of your squads takes that squad as subject and selects it, so ordering is one motion. Anchor tolerance is in **world units, never screen pixels** — otherwise the same stroke means different things at different zooms. Ties break on squad id.
- **Formation glyphs are recognized only when centred ON the squad.** That is what keeps a drawn box from meaning both "form square" and "hold this area". Frontage is deliberately *not* encoded in stroke length: extent is already the hold/patrol discriminator, and overloading it would make a slightly-too-long line flip between two orders.
- **The anchor never claims a large closed stroke.** A ring or a heart drawn across your own line inevitably begins on top of some squad; letting that set the subject turned "recover this group" into "that one squad, patrol". Small closed strokes still anchor, because a drawn box is how a formation glyph is written.

Hearts are told from rings by **convex hull fill**, not by counting concave corners. Corner counting is the obvious approach and it does not survive RDP: the notch is a fine feature, the simplification tolerance scales with stroke size, and on a large heart the cusp is smoothed away entirely — so the same gesture read as a heart at one size and a ring at another. Measured over the corpus, rings fill 0.983–1.000 of their hull and hearts 0.926–0.932.

### Phase 3 — Combat, morale, victory — **DONE**
Per-soldier melee/ranged resolution, frontline engagement and rear ranks, formation deformation under contact and re-forming after, squad morale (casualties, flanking, outnumbering, terrain), global morale aggregation, rout, 15-minute timer, win/loss.
**Runnable:** a complete match against a placeholder AI.
**Turtling: settled.** Morale only ever falls through fighting, so "higher morale at the timer" made not fighting the dominant strategy. Rout is untouched — it is still the instant loss you chose. The timer tiebreak now scores morale **plus the share of the enemy army destroyed**, weighted equally: at parity, wiping out the enemy is worth exactly as much as ending the match untroubled, and an army that inflicted nothing scores its morale and nothing else. A "tiebreak nudge" weight does not work, because any weight small enough to be a nudge leaves hiding dominant.

Three things here would have passed a naive suite and still been wrong:
- **Damage is buffered and applied simultaneously.** Resolving in index order lets player 0, who holds the lower soldier indices, strike first in every mutual engagement and win coin-flip trades — deterministic, reproducible, and silently unfair.
- **Formation slots re-derive from the LIVING count** on every casualty. Otherwise a squad keeps gaps where its dead stood while cohesion still reads 1.00, because cohesion only ever counts survivors.
- **Army morale weights squads by their original roster, not current strength.** Weight by strength and a squad that is wiped out drops to zero morale and zero weight at the same instant, falling clean out of the average — so destroying an enemy squad outright barely moves their army morale.

Ranged attacks pick a target **squad** first and only then a soldier. The soldier spatial hash has 14-unit cells sized for separation distance; a 250-unit bow sweeping that grid would touch hundreds of cells per soldier per tick.

**Verified:** 97 checks. A mirrored 120-second battle trades 65 vs 80 casualties with morale falling to 93%/84%; mutual kills land simultaneously; archers engage without closing; survivors re-form into a tightened line.

### Phase 4 — Terrain and vision — **DONE**
Per-unit sight, line-of-sight blocked by woods and fortifications, three-state fog (unseen / remembered / lit), elevation raising both sight and ranged reach, cover concealing the unit standing in it. Ranged fire is gated on visibility, and only your own orders are drawn on the board.

Both armies run through **one** vision implementation. The AI being subject to the same fog is only credible if there is not a second, more generous code path for it.

Two subtleties: LOS ignores cover within half a tile of either endpoint, or a squad standing in a wood cannot see its own flank; and fog is stamped as discs rather than raycast per cell, because raycasting every cell against every squad is tens of thousands of casts a tick to decide the shading of a picture. Unit visibility, which decides targeting, is exact.

### Phase 5 — AI — **DONE**
Four postures (aggressive / defensive / maneuver / reactive) chosen from relative strength and morale, with hysteresis so a commander reads as having intent rather than twitching. Flanking swings, target selection that prefers already-weakened squads, withdrawal when a squad breaks, and standing down to recover when badly thinned.

**The AI lives in `sim/` and issues Orders through the same queue the player uses.** Anywhere else and it mutates state outside the order stream, so a replay fed only that stream diverges the moment the AI acts — and lockstep netplay dies with it. It draws from `rng.ai`, so adding a decision never shifts a combat or morale roll.

It reads `visibleEnemies()` and nothing else, and a test asserts it never *orders* an attack on a squad it cannot see at that moment. Losing sight mid-approach is memory, not cheating; it remembers the last known enemy position rather than forgetting them the instant they step behind a wood.

**Verified:** a full 15-minute AI-vs-AI match resolves with 347 casualties and all four postures used, and two matches from one seed stay hash-identical throughout with no orders supplied at all.

### Phase 6 — Army building — **DONE**
Point budget, per-type caps and a squad cap, four doctrines as army-wide trades, and a deployment phase that holds the world until the player gives the off.

Doctrine is **baked into each squad's own stat block at spawn**, not looked up in the hot loops: combat reads a squad's stats thousands of times a tick and a doctrine cannot change mid-match. Validation lives in `content/`, not the UI, so the AI, saved armies and level presets are held to the same rules.

A test asserts **no doctrine is strictly better than another** across every stat pair — a doctrine that wins at everything is not a choice, it is the answer.

`spawnSquad` now throws when the soldier store would overflow. Writing past a `Float64Array` is a silent no-op, so an over-large army would have produced squads whose soldiers all sat at (0, 0) with no error anywhere.

### Phase 7 — Magic and special units — **DONE**
Three workings — ward (soaks damage, steadies nerve), hex (amplifies damage, saps nerve), mend (heals over time) — each capped so none is decisive, plus three special units: Adepts, Outriders (see furthest), Siege Engines (outrange everything). All scarce by `maxPerArmy`.

**Magic deliberately gets no gesture of its own.** The pen vocabulary is fourteen classes wide and provably diagonal; every class added raises collision pressure on all the others, and a spell menu would breach the pen-only rule outright. Adepts work whichever spell suits the order they already have — told to attack they hex, told to hold they ward, left near wounded they mend. You cast by choosing where they stand and what they are told, which is what "tactical, not cinematic" should mean.

A first attempt to test wards through a duel "showed" them costing lives: the control swapped the adepts for a skirmisher, whose fighting swamped the effect being measured. Wards and hexes are now measured directly on damage and morale.

### Phase 8 — Destructible terrain
Damageable fortifications, burnable/clearable forest, destructible bridges, with pathing and vision invalidation on change.

### Phase 9 — Levels and win conditions — **DONE**
Level config format (terrain, objectives, AI doctrine, magic intensity, point budget), alternate win conditions as selectable modes, minimal HUD (unit status, global morale bar, doctrine, timer), audio, tutorial.

### Phase 10 — Lockstep verification — **DONE**
`tools/lockstep.ts` proves the claim the architecture was built for: two `World` instances fed one order stream compute an identical battle. Seven checks, including the two that matter most — a 0.0001 nudge is caught immediately (a desync detector that cannot detect a desync is worse than none), and **orders arriving out of sequence change nothing**, which is what makes real latency survivable.

No relay or matchmaker. Those are infrastructure; what needed proving first is that the simulation is deterministic enough for them to be worth building. If this harness ever fails, no amount of netcode would have saved it. Ask before building the server.


---

# Appendix — Audit skills, verbatim

Each file below is copied byte-for-byte from `~/.agents/skills/<skill>/`. File boundaries are marked by an HTML comment.


<!-- ===== BEGIN game-ui-ux/SKILL.md ===== -->

---
name: game-ui-ux
description: >
  Engine-neutral design rules for game HUDs and menus: anchors and containers, scaling, safe
  areas, gamepad focus, HUDs driven by events instead of polling, and accessibility minimums. Use
  for menus, health bars or inventory screens that break on ultrawide or phones. Pair with
  `godot-ui-control` or `roblox-ui`. Not for button juice (`game-feel`) or rebinding
  (`input-systems`).
---

# Game UI/UX

Make every HUD and menu work on a phone, an ultrawide monitor and a TV, with a mouse or only a
gamepad. This skill decides layout, scaling, focus, screen flow and how UI listens to game
state; the engine UI skill supplies nodes, components and styling.

## When to use

- Building a HUD, a menu, an inventory or shop screen, or any overlay.
- Fixing UI that breaks at other resolutions, ignores safe areas, strands a gamepad user, or
  polls game state every frame.
- Structuring screen flow (title, game, pause, settings, confirm) as a stack.

**Not this skill:** widget APIs and themes (`godot-ui-control`, `roblox-ui`, Unity UGUI or UI
Toolkit through the Unity skills), visual juice (`game-feel`), conversation flow and choice
logic (`dialogue-systems`), rebinding screens' input logic (`input-systems`), UI art and icons
(`create-game-assets`).

## Workflow

1. **Inspect the project's UI first**: stretch or CanvasScaler settings, existing theme, fonts,
   the screen-switching code, and which input devices the game targets.
2. **Lay out with anchors and containers.** Anchor to edges, corners or centre; let rows,
   columns and grids place children. A hard-coded `(x, y)` is correct at one resolution only.
3. **Set one scaling policy for the whole UI**: a reference resolution (usually 1920x1080) that
   scales to fit, plus an aspect rule: `expand` and anchor HUD corners outward (default), or
   letterbox when the design truly needs a fixed frame.
4. **Inset critical UI to the safe area** (health, timers, prompts); decorative art may bleed.
   Reapply on resize and orientation change.
5. **Make every screen gamepad-navigable**: one control focused on open, neighbours fixed where
   the engine guesses wrong, a focus style distinct from hover, focus trapped inside modals.
6. **Model screens as a stack.** Push for overlays, pop for back; only the top screen takes input,
   and the screen below gets its focus back.
7. **Drive the HUD from events.** Subscribe to `health_changed`, `score_changed`; set the initial
   value once on connect, because signals do not replay.
8. **Verify with a runnable check, then on screens.**
   - Headless focus check: a script that opens each screen in turn and fails if
     `get_viewport().gui_get_focus_owner()` (Godot) or
     `EventSystem.current.currentSelectedGameObject` (Unity) is null.
   - Size sweep: launch at 1280x720, 2560x1080 and 1080x2340 (Godot: `--resolution WxH`; needs a
     display or `xvfb-run`, because the headless renderer draws nothing) and save a viewport
     screenshot at each. Inspect them for clipped or overlapping elements.
   - Ask the user to unplug the mouse, play through every menu with a gamepad and report any
     screen where nothing is selected or focus escapes.

## Patterns

### 1. Anchors and containers

```gdscript
# Godot 4.7. Anchor the score to a corner; an HBoxContainer spaces the hearts.
func _ready() -> void:
    $Score.set_anchors_preset(Control.PRESET_TOP_LEFT)
    for i in lives:
        $Hearts.add_child(make_heart())
```

Unity UGUI: anchor the `RectTransform` to the corner and use a `HorizontalLayoutGroup`; set the
pivot to the same corner, or the element grows in every direction when its size changes.

### 2. Scaling settings

```text
Godot 4.7  project.godot [display]:
  window/stretch/mode="canvas_items"   window/stretch/aspect="expand"
  window/size/viewport_width=1920      window/size/viewport_height=1080
Unity 6.3  CanvasScaler: Scale With Screen Size, Reference Resolution 1920x1080,
  Match Width Or Height = 0.5 (1.0 if the layout must never clip vertically)
Unity 6.3  UI Toolkit: the same three settings live on the PanelSettings asset
```

### 3. Safe-area inset

```gdscript
# Godot 4.7. Only Android and iOS report a real safe area; elsewhere the margins come out ~0.
func _apply_safe_area() -> void:
    var safe := Rect2(DisplayServer.get_display_safe_area())           # screen pixels
    var win := Rect2(Rect2i(DisplayServer.window_get_position(), DisplayServer.window_get_size()))
    var inner := safe.intersection(win)
    var to_ui := get_viewport_rect().size / win.size    # window pixels -> UI units under stretch
    $Margin.add_theme_constant_override("margin_left", int((inner.position.x - win.position.x) * to_ui.x))
    $Margin.add_theme_constant_override("margin_top", int((inner.position.y - win.position.y) * to_ui.y))
    $Margin.add_theme_constant_override("margin_right", int((win.end.x - inner.end.x) * to_ui.x))
    $Margin.add_theme_constant_override("margin_bottom", int((win.end.y - inner.end.y) * to_ui.y))
```

Unity: read `Screen.safeArea` and set a panel's `anchorMin`/`anchorMax` to its corners divided
by `Screen.width`/`Screen.height`; recompute when the rect changes, not every frame.

### 4. Focus on open

```gdscript
# Godot 4.7. Focus something on open; fix neighbours only where the automatic guess is wrong.
func _on_screen_shown() -> void:
    $PlayButton.grab_focus()
    $PlayButton.focus_neighbor_bottom = $SettingsButton.get_path()
    $SettingsButton.focus_neighbor_top = $PlayButton.get_path()
```

Unity UGUI: `EventSystem.current.SetSelectedGameObject(playButton)` in `OnEnable`, with
`Navigation` set to Automatic or Explicit. UI Toolkit: call `Focus()` on the first element.

### 5. Event-driven HUD

```gdscript
# RIGHT: HUD reacts to a signal; it updates only when health actually changes.
func _ready() -> void:
    player.health_changed.connect(_on_health_changed)     # emitted by gameplay
    _on_health_changed(player.hp, player.max_hp)           # signals do not replay initial state
func _on_health_changed(current: int, max_health: int) -> void:
    # ratio maps 0..1 to the bar's configured range (default value range is 0..100).
    $HealthBar.ratio = clampf(float(current) / max_health, 0.0, 1.0) if max_health > 0 else 0.0
# WRONG: func _process(dt): $HealthBar.value = player.hp / player.max_hp  # polls every frame,
# couples UI to the player's internals, and runs work even when nothing changed.
```

## Gotchas

- **Nothing focused on open** leaves a gamepad player stuck on the first menu. Every screen
  focuses one control when shown, and again when a screen above it closes.
- **Focus escapes a modal.** Showing a dialog and focusing its button does not stop neighbour
  search from reaching buttons behind it. Disable focus and mouse on the screen below (Godot
  4.5+: `focus_behavior_recursive` and `mouse_behavior_recursive`).
- **`set_process_input(false)` does not disable a Godot menu**: buttons receive GUI input, not
  `_input`. Use the recursive focus and mouse behaviours above.
- **Unity UGUI ignores the gamepad, or throws on start,** after switching Active Input Handling to
  the Input System: the scene still has a `StandaloneInputModule`. Replace it with
  `InputSystemUIInputModule`. UI Toolkit reads the project-wide UI actions and needs no module.
- **Pixel-art UI at a fractional scale** shimmers and blurs. Godot: set
  `window/stretch/scale_mode="integer"`; Unity: pick a reference resolution that divides the
  target displays evenly and use a pixel-perfect canvas.
- **Text too small on a TV.** Default text should be at least 26 px at 1080p on console and TV
  and 18 px at 1080p on PC, scalable to 200 % without losing content.
- **Colour as the only signal** (red equals danger) fails for colour-blind players. Add an icon,
  shape or label. Text that carries gameplay information needs at least 4.5:1 contrast.
- **Hard-coded English sized to fit** overflows in German (often about 30 % longer). Use string
  tables (`tr()`, Unity Localization) and containers that size to content.
- **Menu flow as booleans** (`is_paused`, `in_settings`, `confirm_open`) breaks on the third
  overlay. Use the screen stack.
- **Pause freezes the pause menu.** Godot: `get_tree().paused = true` and the overlay's
  `process_mode = PROCESS_MODE_ALWAYS`; Unity: menu animation must use unscaled time when
  pausing by `Time.timeScale = 0`.
- **Mouse movement clears gamepad focus.** Let the mouse move the selection, but never leave
  the screen with nothing selected after the mouse stops.

## References

- `references/layout-and-flow.md`: read for per-engine stretch and scale settings, safe-area
  maths, the full focus-trap and screen-stack code, diegetic vs world-space UI, accessibility
  details and localization-ready layout.

## Related skills

- `godot-ui-control`, `roblox-ui`: engine widgets, themes and styling; load alongside this one.
- `game-feel`: button pops, transitions and HUD juice on top of this layout.
- `dialogue-systems`: conversation and choice logic inside this UI shell.
- `input-systems`: device switching and rebinding screens.

## Version notes

Last verified: 2026-11-11.

- Text size: Xbox Accessibility Guideline 101 sets 26 px at 1080p (52 px at 4K) for console,
  18 px at 1080p (36 px at 4K) for PC, and scaling to 200 %
  (https://learn.microsoft.com/en-us/xbox/accessibility/xbox-accessibility-guidelines/101).
- Contrast: Xbox Accessibility Guideline 102, 4.5:1 for text, 3:1 for large text and key visuals
  (https://learn.microsoft.com/en-us/xbox/accessibility/xbox-accessibility-guidelines/102).
- Godot 4.7: `Control.focus_behavior_recursive`/`mouse_behavior_recursive` (added in 4.5),
  `DisplayServer.get_display_safe_area()`; stretch settings per
  https://docs.godotengine.org/en/4.7/tutorials/rendering/multiple_resolutions.html.
- Unity 6.3 LTS with the Input System package (1.20.1 is the latest release, October 2026):
  `InputSystemUIInputModule` replaces `StandaloneInputModule`
  (https://docs.unity3d.com/Packages/com.unity.inputsystem@1.19/manual/UISupport.html;
  https://packages.unity.com/com.unity.inputsystem).


<!-- ===== END game-ui-ux/SKILL.md ===== -->


<!-- ===== BEGIN game-ui-ux/references/layout-and-flow.md ===== -->

# Layout, scaling and flow

Contents:
1. Scaling modes per engine
2. Safe-area maths
3. Focus navigation (full pattern, modal focus trap)
4. Screen/menu stack
5. Diegetic vs non-diegetic UI
6. Accessibility
7. Localization-ready layout

Snippets target Godot 4.7 and Unity 6.3 LTS.

## 1. Scaling modes per engine

**Godot 4.7** (Project Settings → Display → Window → Stretch):

| Setting | Choose | Effect |
|---------|--------|--------|
| Mode | `canvas_items` | UI scales with the window (vs `viewport` = pixel-exact, `disabled` = none) |
| Aspect | `expand` | shows more world/UI space on odd ratios; `keep` letterboxes |
| Scale | `1.0`+ | global UI multiplier |
| Scale Mode | `fractional` / `integer` | `integer` keeps pixel-art UI crisp by scaling in whole steps |

Anchor HUD corners so `expand` puts the extra space where you want it. `keep_width`/`keep_height`
pin one axis for hard 16:9 designs.

**Unity 6.3 LTS** (`CanvasScaler` on each Canvas):

- `UI Scale Mode = Scale With Screen Size`.
- `Reference Resolution = 1920×1080` (or your art's design size).
- `Screen Match Mode = Match Width Or Height`, `Match = 0.5` (blend). Use `1.0` if vertical
  layout must never clip, `0.0` if horizontal must not.
- `Reference Pixels Per Unit = 100` for sprite-based UI.

## 2. Safe-area math

The OS reports a safe rectangle inside the screen (excludes notch, rounded corners, and — on TVs
— overscan margins). Inset only **critical** UI (health, timers, prompts); decorative art can
bleed to the edge.

```text
# Normalized anchors from a pixel safe rect (engine-neutral):
anchorMin = (safe.x / screenW,                 safe.y / screenH)
anchorMax = ((safe.x + safe.w) / screenW,       (safe.y + safe.h) / screenH)
# Re-apply on resolution change / orientation change, not once at startup.
```

- **Godot:** `DisplayServer.get_display_safe_area()` → `Rect2i` in pixels; reapply on
  `size_changed`.
- **Unity:** `Screen.safeArea` → `Rect` in pixels; recompute when `Screen.width/height` or
  `Screen.orientation` changes (cache the last applied rect to avoid per-frame work).

## 3. Focus navigation (full pattern)

Requirements for controller/keyboard usability:

1. **Initial focus** on every screen open (`grab_focus()` / `EventSystem.SetSelectedGameObject`).
2. **Explicit neighbors** for predictable movement (Godot `focus_neighbor_*`; Unity `Navigation`
   = Explicit with up/down/left/right, or Automatic for simple grids).
3. **Visible focus style** distinct from hover (theme focus stylebox / Unity Selectable
   transition). Never rely on color alone (see accessibility).
4. **Wrap or stop** intentionally at list ends; trap focus inside modal dialogs.
5. **Device coexistence:** moving the mouse can update selection; a gamepad press acts on the
   focused control. Don't clear focus when the mouse moves.

```gdscript
# Godot 4.7: trap focus inside a modal so the stick can't escape to the menu behind it.
var _prev_focus: Control

func open_modal() -> void:
    _prev_focus = get_viewport().gui_get_focus_owner()
    $Menu.focus_behavior_recursive = Control.FOCUS_BEHAVIOR_DISABLED   # Godot 4.5+
    $Menu.mouse_behavior_recursive = Control.MOUSE_BEHAVIOR_DISABLED
    $Modal.show()
    $Modal/OK.grab_focus()

func close_modal() -> void:
    $Modal.hide()
    $Menu.focus_behavior_recursive = Control.FOCUS_BEHAVIOR_INHERITED
    $Menu.mouse_behavior_recursive = Control.MOUSE_BEHAVIOR_INHERITED
    if is_instance_valid(_prev_focus): _prev_focus.grab_focus()
```

Showing the modal and focusing its button is not a trap on its own: Godot's neighbor search
still reaches visible controls behind it. The two `*_behavior_recursive` switches turn a whole
subtree off without touching each button.

## 4. Screen/menu stack

Model screens as a stack of UI states; the top owns input and is visible. Push for overlays,
pop for "back". This generalizes pause, settings-over-pause, and confirm dialogs.

```gdscript
# Godot 4.7 sketch: screens are Controls under one CanvasLayer; only the top one is interactive.
# Each screen scene marks its default control with the unique name %DefaultFocus.
var _stack: Array[Control] = []

func push(screen: Control) -> void:
    if not _stack.is_empty():
        _set_interactive(_stack.back(), false)
    _stack.append(screen)
    add_child(screen)
    screen.get_node("%DefaultFocus").grab_focus()

func pop() -> void:
    var top: Control = _stack.pop_back()
    top.queue_free()
    if not _stack.is_empty():
        var below: Control = _stack.back()
        _set_interactive(below, true)
        below.get_node("%DefaultFocus").grab_focus()

func _set_interactive(screen: Control, on: bool) -> void:
    # Godot 4.5+. set_process_input(false) would not do this: buttons get GUI input, not _input.
    screen.focus_behavior_recursive = Control.FOCUS_BEHAVIOR_INHERITED if on else Control.FOCUS_BEHAVIOR_DISABLED
    screen.mouse_behavior_recursive = Control.MOUSE_BEHAVIOR_INHERITED if on else Control.MOUSE_BEHAVIOR_DISABLED
# Pause overlay: get_tree().paused = true and set the overlay's process_mode = PROCESS_MODE_ALWAYS.
```

## 5. Diegetic vs non-diegetic UI

- **Non-diegetic:** drawn on the screen plane, outside the fiction (most HUDs). Cheapest, clearest.
- **Diegetic:** UI that exists in the world (ammo counter on the gun, health on the suit). More
  immersive, more work, can hurt readability. Use for key elements, keep a non-diegetic fallback.
- **Spatial/world-space:** floating health bars, damage numbers — anchor to world position,
  clamp to screen edges when off-screen, and scale with distance (3D).

## 6. Accessibility (bake in, don't bolt on)

- **Text size option** and never hardcode tiny fonts; size to a percentage of reference height.
  Xbox Accessibility Guideline 101 floors: 26 px at 1080p (52 px at 4K) on console/TV, 18 px at
  1080p on PC, and player scaling up to 200% without clipping or lost meaning.
- **Contrast & color independence:** text that carries gameplay information needs at least
  4.5:1 contrast with its background, large text and key visual elements at least 3:1 (Xbox
  Accessibility Guideline 102). Don't encode state in color alone — add icon/shape/text.
  Provide colorblind-safe palettes.
- **Scalable hit targets** for touch (≥ ~9 mm); padding around small buttons.
- **Reduce-motion / reduce-flashing** toggles (coordinate with `game-feel`).
- **Full keyboard + gamepad** reachability (section 3); don't gate actions behind mouse-only.

## 7. Localization-ready layout

- Externalize strings (Godot `tr()` + translation CSV/PO; Unity Localization package). Never bake
  display text into layout logic.
- Let containers **size to content** so longer translations (German is ~30% longer) don't clip.
  Avoid fixed-width buttons sized to English.
- Leave room for RTL mirroring and different number/date formats.
- Keep icons separate from text so only strings need translating.

## Primary sources

- [Godot 4.7: Multiple resolutions](https://docs.godotengine.org/en/4.7/tutorials/rendering/multiple_resolutions.html)
- [Unity Input System: UI support](https://docs.unity3d.com/Packages/com.unity.inputsystem@1.19/manual/UISupport.html)
- [Xbox Accessibility Guideline 101: Text display](https://learn.microsoft.com/en-us/xbox/accessibility/xbox-accessibility-guidelines/101)
- [Xbox Accessibility Guideline 102: Contrast](https://learn.microsoft.com/en-us/xbox/accessibility/xbox-accessibility-guidelines/102)
- [Game Accessibility Guidelines](https://gameaccessibilityguidelines.com/)


<!-- ===== END game-ui-ux/references/layout-and-flow.md ===== -->


<!-- ===== BEGIN create-game-assets/SKILL.md ===== -->

---
name: create-game-assets
description: >
  Plans, generates or sources, and validates consistent game art: style guides, sprites, pixel
  art, tilesets, icons and textures, with QA and licence records. Use when making or AI-generating
  game art, fixing fake transparency, or checking Steam AI disclosure. Not for engine import
  (`godot-tilemap`, `godot-animation`, `unity-tilemap-2d`), UI layout (`game-ui-ux`) or sound
  (`audio-design`).
---

# Create Game Assets

Turn a game's visual intent into a consistent, engine-ready asset set. Treat image generation as
one production tool inside a controlled pipeline, never as proof that an asset is shippable.

## When to use

- Defining or refreshing an art direction, or writing a style guide other contributors follow.
- Producing a family of sprites, tiles, icons, backgrounds or textures that must match.
- Generating art with an image tool, or sourcing licensed packs, and making the result usable.
- Auditing what was generated or licensed before release.

**Not this skill:** importing into the engine (`godot-tilemap`, `unity-tilemap-2d`,
`pixijs-rendering`, `threejs-gltf-loading`), animating the sprites (`godot-animation`,
`unity-animation`), atlas and texture-memory budgets at runtime (`performance-optimization`).

## Core workflow

1. **Inspect before inventing.** Find existing screenshots, concept art, sprites, models, fonts,
   import settings, camera framing, target resolution, and naming conventions. Preserve a coherent
   existing direction unless the user asks for a redesign.
2. **Lock the technical frame.** Record engine, 2D/3D, camera/view, native display size, asset
   dimensions, world scale, transparency, palette, filtering, animation frames, texture budget,
   and target platforms. Use `assets/art-direction-brief.md` as a copyable brief.
3. **Name the visual system.** Define shape language, silhouette priorities, value structure,
   palette roles, materials, lighting, detail density, edge treatment, and motion character. Use
   concrete visual properties; do not substitute a living artist's name for an art direction.
4. **Make an asset manifest.** Copy `assets/asset-manifest.json`, then list every required asset,
   state, variant, size, pivot, collision role, source, license, and approval status. Separate
   production assets from disposable greybox placeholders.
5. **Approve one visual target.** Create or select a representative hero asset or small style
   board before producing a full set. Judge it at actual game scale and against a gameplay
   background. If the user delegated the choice, pick the strongest viable direction and record
   the decision instead of blocking.
6. **Produce related assets as families.** Reuse the approved target as an edit/reference input.
   Keep palette, view, proportions, lighting, outline, and texture density invariant. Generate
   small coherent batches; avoid unrelated one-off prompts that drift.
7. **Normalize deterministically.** Crop, size, anchor, slice, name, compress, and check alpha with
   ordinary image/DCC tools. Never trust generated grids, transparency, seams, pivots, topology,
   or dimensions without inspection. Use the bundled scripts for raster QA and contact sheets.
8. **Import with engine-native settings.** Set filtering, mipmaps, pixels-per-unit/world scale,
   color space, compression, sprite slicing, texture types, materials, and collision deliberately.
   Read the relevant engine skill before editing engine files.
9. **Validate in context.** Inspect a contact sheet and the actual game at native resolution.
   Check silhouette, scale, animation stability, seams, legibility, palette, collision fit, memory,
   and compression artifacts. Iterate on the source asset, not only on runtime compensations.
10. **Record provenance.** Keep the source URL/tool, license or generation note, edit history, and
    restrictions beside the manifest. Preserve embedded provenance metadata when the pipeline can.
11. **Finish with the checks.** Run `scripts/asset_report.py` over every file in the batch with
    the manifest's size, alpha and colour limits and `--json`; it must exit 0. Build a contact
    sheet with `scripts/build_preview_sheet.py` and look at it. Confirm every shipped manifest
    entry has a source, licence and `technical_checks_passed: true`. Then ask the user to view
    the assets in the running game at native resolution and report anything that does not read.

## Choose the production path

| Need | Default path |
|------|--------------|
| Existing asset needs a controlled change | Edit the original/reference; state what must remain unchanged |
| New 2D visual family | Approve seed → generate/source family → normalize → preview → import |
| True pixel art | Use generated work as a draft; enforce grid, palette, clusters, and frames with pixel tools |
| Tileable surface or tileset | Produce a small family; repair seams; test repeated 3×3 before approval |
| UI art or icons | Keep text and interaction code-native; prefer SVG/vector for simple geometric symbols |
| 3D model or material | Use concepts as reference; author/clean in a DCC; validate topology, UVs, scale, pivots, and LODs |
| No generation/edit tool is available | Build the brief and manifest; source licensed assets or keep explicit greybox placeholders |
| Audio asset | Route sound implementation and mixing to `audio-design`; still track source/license in the manifest |

## Image-generation handoff

When a capable image generation or editing tool is installed, use it for live visual creation. If
the workspace exposes an `imagegen` skill, read and follow it for the actual generation/edit call;
this skill owns the game-art brief, constraints, normalization, and acceptance gates. Generation
APIs usually bill per image: tell the user the batch size and ask before large or repeated runs.

Build prompts from these blocks:

```text
ROLE/PURPOSE: production asset for [gameplay role]
SUBJECT: [specific object/character and action]
VIEW: [orthographic/top-down/side/three-quarter], [camera and facing]
ART DIRECTION: [shape language], [palette roles], [materials], [edge treatment]
GAME-SCALE READ: [silhouette and focal details that must survive at WxH]
TECHNICAL OUTPUT: [dimensions/aspect], [transparent or scene background], [frame/slot count]
LOCKS: preserve [identity, proportions, palette, costume, lighting, line weight]
EXCLUDE: text, labels, mockup frames, scenery, duplicate objects, cropped edges, signatures
```

For edits, say both what changes and what stays fixed. Ask for transparent output through the
tool's native transparency option when available, then verify the alpha channel—prompt wording
alone does not guarantee transparency.

## Raster QA recipes

Inspect constraints and emit a machine-readable report. `--require-alpha` also fails an RGBA file
whose every pixel is opaque, which is how a baked background or fake checkerboard shows up:

```bash
python scripts/asset_report.py assets/player-idle.png \
  --expect-size 64x64 --require-alpha --max-colors 48 --json
```

Build a nearest-neighbor contact sheet over a checkerboard:

```bash
python scripts/build_preview_sheet.py output/player/*.png \
  --out output/player-preview.png --columns 4 --cell-size 192
```

Run script paths relative to this skill directory, or resolve the installed skill path first.
Both scripts need Python and Pillow (see Version notes). Install the only dependency with
`python -m pip install -r scripts/requirements.txt` when it is not already available.
`asset_report.py` exits 1 when any explicit constraint fails, so it can gate a build.

## Quality gates

- **Cohesion:** related assets share palette roles, line/edge treatment, view, light direction,
  scale, and detail density.
- **Gameplay read:** silhouettes and state changes remain clear at native resolution, in motion,
  and over real backgrounds.
- **Technical fit:** exact size/frame count, usable alpha, stable anchors/pivots, correct color
  space/filtering, no clipped content, no accidental labels or baked mockup chrome.
- **Animation:** identity, volume, proportions, costume, facing, and baseline do not drift; timing
  and anticipation read in an in-engine preview.
- **Tiles/backgrounds:** required edges tile without seams; repetition is tolerable; parallax
  layers have intentional depth and no baked collision cues.
- **3D:** transforms, scale, pivot, normals, UVs, materials, topology, rig, collision proxies,
  LODs, and runtime format are checked rather than inferred from a render.
- **Rights:** every shipped file has recorded provenance and terms compatible with the project.

Do not call an asset production-ready from a prompt result alone. Approval requires the relevant
technical checks plus an in-engine or native-scale visual inspection.

## Gotchas

- **Fake transparency.** Image models often paint a grey-and-white checkerboard or a flat
  backdrop instead of alpha. `asset_report.py --require-alpha` fails a file with no alpha
  channel or with every pixel opaque; remove the background with a real matte, never by trusting
  the prompt.
- **Halos around cut-outs.** Semi-transparent edges keep the old background colour and show as a
  light or dark fringe in the engine. Bleed edge colour outward into transparent pixels (or
  export premultiplied when the engine expects it) and check over a contrasting background.
- **Pseudo pixel art.** Generated "pixel art" has blended in-between colours, off-grid pixels and
  hundreds of near-duplicates. Downscale to the true grid with nearest-neighbour, quantize to
  the palette, then check `--max-colors`.
- **Mipmaps or linear filtering on pixel art** blur and shimmer it. Nearest filtering, no
  mipmaps, integer camera scale.
- **Sprite sheets that do not slice.** Generated grids drift by a few pixels per cell and frames
  change size. Re-slice onto a fixed canvas with one shared anchor (usually bottom-centre) before
  import.
- **Character drift between frames or batches** (head size, outline width, palette). Edit from
  the approved seed each time instead of from the last output.
- **Texture bleeding at tile and atlas edges** under zoom or mipmaps. Pad or extrude tiles by 1-2
  px and test a 3x3 repeat at the game's camera scale.
- **Block-compression sizes.** BC and ETC2 compress in 4x4 blocks (ASTC in its chosen block
  size); other dimensions get padded, or rejected by stricter paths such as WebGL compressed
  textures. Keep textures at multiples of 4, and powers of two where mipmaps are needed.
- **Normal and data maps imported as sRGB** shade wrongly. Only colour textures are sRGB.
- **Generated text and logos** come out as near-letters and invite trademark trouble. Keep text
  code-native and remove marks before approval.
- **Licences that do not survive packing.** Attribution and terms must follow the asset through
  atlases and renames; record them in the manifest, not in a filename.
- **Undeclared AI content.** Steam's Content Survey asks about AI-generated content that ships
  with the game; answer it from the manifest's `source.kind`, so record generation per asset.

## References

- For visual-system decisions and maintaining consistency, read
  `references/art-direction.md`.
- For sprites, animation strips, tiles, backgrounds, UI art, and engine import settings, read
  `references/raster-pipeline.md`.
- For concept-to-mesh, textures, glTF/GLB, LOD, collision, and runtime validation, read
  `references/three-d-pipeline.md`.
- For licenses, generated-media records, and provenance, read
  `references/provenance.md`.

## Related skills

- `game-ui-ux` for layout, navigation, readability, and accessible interaction.
- `game-feel`, `shader-programming`, and `audio-design` for presentation after the source art fits.
- Engine import/rendering skills such as `godot-tilemap`, `unity-tilemap-2d`,
  `pixijs-rendering`, and `threejs-gltf-loading`.

## Version notes

Last verified: 2026-11-11.

- Scripts: Python 3.10+ with Pillow 10 to 13 (`scripts/requirements.txt` pins `Pillow>=10,<14`).
  Pillow 13.0.0 is the latest release and requires Python 3.11+
  (https://pypi.org/project/pillow/).
- Steam Content Survey: the generative AI section separates pre-generated content (made during
  development and shipped) from live-generated content (made while the game runs, which also
  needs a description of guardrails); AI tools used only for efficiency are not its focus
  (https://partner.steamgames.com/doc/gettingstarted/contentsurvey).
- Engine import settings in `references/raster-pipeline.md` target Godot 4.7 and Unity 6.3 LTS.


<!-- ===== END create-game-assets/SKILL.md ===== -->


<!-- ===== BEGIN create-game-assets/references/art-direction.md ===== -->

# Art direction and consistency

Use this reference when a game needs a new visual direction, a style refresh, or a way to keep
many assets coherent across generation sessions and contributors.

## Describe a system, not a mood word

Define each axis explicitly:

| Axis | Questions to settle |
|------|---------------------|
| Shape | Rounded, angular, chunky, slender, geometric, organic? Which shapes signal friendly, dangerous, rare, or interactive? |
| Silhouette | What must read at game scale? Which parts may never merge into the body mass? |
| Value | How many value bands? Is the subject readable in grayscale against common backgrounds? |
| Color | What roles do accent, danger, reward, neutral, environment, and UI colors play? |
| Edge | Hard pixel clusters, clean vector edges, ink line, painterly lost edges, soft 3D bevels? |
| Material | How do metal, cloth, skin, stone, foliage, glass, and magic differ? |
| Light | Direction, softness, contrast, ambient color, rim light, baked shading policy? |
| Detail | Where is detail concentrated? What disappears at the native viewing size? |
| Camera | Orthographic/perspective, angle, focal length, horizon, facing and turn conventions? |
| Motion | Snappy, elastic, weighty, restrained? How far may forms deform in animation? |

Avoid phrases such as “beautiful,” “cinematic,” or “high quality” without observable constraints.
Avoid using a living artist's name as the style definition. Translate references into properties
such as palette, geometry, composition, material, lighting, and mark-making.

## Build a visual target

1. Capture the real game viewport and native resolution.
2. Place a representative character/object, environment patch, effect, and HUD fragment together.
3. Show common and worst-case backgrounds.
4. Add a small palette with semantic roles rather than an unlabelled color cloud.
5. Record do/don't examples: acceptable silhouette, forbidden outline drift, allowed texture noise.
6. Approve this target before producing a large catalog.

The target is a contract, not inspiration. Later outputs should be compared against it at the same
size and under the same background/light assumptions.

## Keep a family coherent

- Reuse one approved seed/reference for related variants.
- Keep a stable prompt card with the invariant blocks separate from the asset-specific block.
- Generate related items in small batches when shared scale and lighting matter.
- Change one variable per edit pass; broad “make it better” edits increase drift.
- Carry explicit color values or a palette image when color identity matters.
- Keep naming, pivots, canvas size, and padding deterministic outside the model.
- Reject outputs that are attractive alone but belong to a different visual system.

## Evaluate at three distances

1. **Thumbnail/native game scale:** gameplay identity and state must read immediately.
2. **Working scale:** edge quality, anatomy, seams, clusters, and material cues are inspectable.
3. **Context:** the asset sits in a real gameplay capture with lighting, effects, UI, and neighbors.

An asset that only succeeds when zoomed in is not successful game art.

## Common drift signals

- character height, head ratio, limb thickness, or costume layers change between states
- outline color/width changes between adjacent assets
- highlights imply different light directions
- palette grows with near-duplicate colors and muddy intermediates
- texture/noise density increases on later generations
- camera angle or object projection changes across an isometric/top-down set
- ground contact and shadow footprint move unpredictably
- UI icons mix filled, outlined, beveled, and painterly treatments

When drift appears, return to the approved seed and use a constrained edit. Do not keep editing a
drifted derivative until it becomes the new accidental reference.


<!-- ===== END create-game-assets/references/art-direction.md ===== -->


<!-- ===== BEGIN create-game-assets/references/provenance.md ===== -->

# Asset rights and provenance

Use this reference for generated, purchased, commissioned, open, or remixed assets. This is a
production recordkeeping workflow, not legal advice.

## Record per shipped asset

- stable asset ID and repository path
- creator/source URL or vendor order
- acquisition or generation date
- source tool/model/version when generated
- original prompt/reference IDs when available
- license name/version and a saved copy or link to the terms
- attribution text and placement requirements
- whether commercial use, modification, redistribution, or AI training is restricted
- edits, derivatives, and the person/tool responsible
- approval status and reviewer

The bundled `assets/asset-manifest.json` has fields for these records. Keep proof of purchase and
license snapshots outside a public repository when they contain personal or account data.

## Decision rules

1. Do not treat “free,” “royalty-free,” search-engine-visible, or model-generated as a license.
2. Verify terms at the original source, not a repost or aggregator preview.
3. Keep attribution through atlas packing, renaming, conversion, and derivative edits.
4. Check whether a marketplace license permits redistribution of raw source files; shipping a game
   and publishing editable source assets can have different permissions.
5. Do not request direct imitation of a living artist. Describe visual properties or use references
   the project has permission to edit.
6. Preserve content credentials/provenance metadata where the file pipeline supports it. If
   optimization strips metadata, retain the corresponding manifest record.
7. Review each store/platform's current disclosure rules before submission; rules change faster
   than this skill. Steam's Content Survey has a required generative-AI section that separates
   content made during development from content generated while the game runs. Record which
   assets were generated so that section can be answered from the manifest, not from memory.

## Useful primary references

- [Creative Commons license chooser](https://creativecommons.org/chooser/)
- [SPDX license list](https://spdx.org/licenses/)
- [C2PA (Content Credentials) specifications](https://spec.c2pa.org/specifications/)
- [OpenAI content provenance](https://openai.com/index/advancing-content-provenance/)
- [Steamworks Content Survey, including the generative AI section](https://partner.steamgames.com/doc/gettingstarted/contentsurvey)

When terms are unclear or the release is commercially important, flag the ambiguity for a human
rights review rather than guessing.


<!-- ===== END create-game-assets/references/provenance.md ===== -->


<!-- ===== BEGIN create-game-assets/references/raster-pipeline.md ===== -->

# Raster, sprite, tile, background, and UI pipeline

Use this reference for production 2D art and raster textures. Generated output is source material;
dimensions, grids, alpha, anchors, and import settings remain deterministic engineering concerns.

## Sprites and animation

1. Approve one idle/neutral seed at the final view and approximate game scale.
2. Lock canvas size, baseline/ground point, facing, palette, outline, proportions, and costume.
3. For a short animation, request the whole action as one strip or sheet referenced to the seed.
   Independent frame requests drift more. Treat the returned grid as a candidate, not exact data.
4. Slice and normalize frames with one shared scale and one shared anchor—usually bottom-center.
5. If frame 1 must equal a shipped idle pose, restore the exact seed after slicing.
6. Preview as a contact sheet and in motion. Check volume, foot sliding, silhouette, and cadence.

For true pixel art, enforce a real pixel grid after generation. Remove blended pseudo-pixels,
single-pixel noise, excess colors, banding, and inconsistent clusters. Resize only with
nearest-neighbor unless a deliberate preprocessing pass says otherwise.

## Tiles and repeatable textures

- Define tile dimensions and neighbor rules before creating art.
- Produce a base, transitions, corners, isolated pieces, and decoration as one visual family.
- Keep gameplay edges and collision meaning legible; decorative shadows must not imply false walls.
- Test seamless materials in a 3×3 repeat at full size and at minified camera scale.
- Inspect terrain combinations in the engine's autotile/terrain system, not only in a sheet.
- Keep padding/extrusion compatible with the engine/atlas tool to prevent texture bleeding.

## Backgrounds and parallax

- Split sky, far, mid, near, and foreground layers according to intended parallax speed.
- Avoid unique landmarks near horizontal seams when layers must scroll/repeat.
- Preserve a low-contrast playfield behind characters and projectiles.
- Keep focal detail away from HUD safe areas and critical navigation silhouettes.
- Export layers independently with overlap so camera movement cannot expose gaps.

## UI art and icons

- Keep labels, numbers, dynamic copy, focus state, and accessibility text code-native.
- Generate or draw ornament, frames, portraits, and texture—not rasterized functional text.
- Prefer one established icon family. Simple geometric symbols should usually be SVG/vector.
- Provide normal, hover/focus, pressed, disabled, selected, and warning states when art changes.
- Design scalable panels as 9-slice/nine-patch assets; verify corners and borders at several sizes.

## Import checkpoints

**Godot 4.7:** 2D filtering and repeat are not import options. Set
`rendering/textures/canvas_textures/default_texture_filter` to Nearest for a pixel-art project (or
`texture_filter` on one `CanvasItem` subtree), and enable `rendering/2d/snap/snap_2d_transforms_to_pixel`
when sprites shimmer while moving. Enable the `mipmaps/generate` import option only for non-pixel
textures that shrink substantially; set `texture_repeat` (or the 3D material's repeat) only for
textures designed to tile. Verify `Sprite2D`, `TileSet`, atlas regions, and animation frames in the
editor.

**Unity 6.3 LTS:** set Texture Type to Sprite (2D and UI), choose Single/Multiple correctly, set a
consistent Pixels Per Unit, filter mode, compression, mipmaps, mesh type, and sprite slicing.
Disable Read/Write unless runtime pixel access is actually required because it adds memory cost.

**Phaser/PixiJS/web:** keep atlas metadata and image filenames stable; use nearest sampling and
integer camera scaling for pixel art; prevent browser/CSS resizing from introducing blur; inspect
texture bleeding under the real renderer.

## Primary documentation

- [Godot 4.7 Image](https://docs.godotengine.org/en/4.7/classes/class_image.html)
- [Godot 4.7 Texture2D](https://docs.godotengine.org/en/4.7/classes/class_texture2d.html)
- [Unity sprite import settings](https://docs.unity3d.com/Manual/texture-type-sprite.html)
- [Phaser asset concepts](https://docs.phaser.io/phaser/concepts/loader)
- [PixiJS Assets guide](https://pixijs.com/8.x/guides/components/assets)


<!-- ===== END create-game-assets/references/raster-pipeline.md ===== -->


<!-- ===== BEGIN create-game-assets/references/three-d-pipeline.md ===== -->

# 3D concept-to-runtime pipeline

Use this reference when the output is a model, material, texture set, rig, animation, or 3D prop
family. An appealing render proves appearance only; it does not prove production geometry.

## Default pipeline

1. Lock camera/view, scale, gameplay footprint, material language, polygon/texture budgets, target
   engine, renderer, and platform.
2. Create or select orthographic/turnaround concepts with consistent proportions. Treat generated
   multi-view sheets as references that still require geometric interpretation.
3. Author or clean the model in a DCC such as Blender. Inspect topology, normals, watertightness,
   UVs, texel density, material slots, rig, weights, and animation clips.
4. Apply/normalize transforms and set a gameplay-meaningful origin and pivot.
5. Create simplified collision proxies. Do not use a detailed render mesh as default collision.
6. Define LODs and material/texture reuse for repeated or distant objects.
7. Export using the engine's preferred interchange path. Use GLB/glTF 2.0 as the general runtime
   delivery default when the target supports it; keep editable DCC sources separately.
8. Import into the real engine, check scale/orientation/materials/animation, profile memory and draw
   calls, and capture representative screenshots before approval.

## Geometry gates

- silhouette fits gameplay and LOD transitions preserve it
- no accidental internal faces, non-manifold regions, inverted normals, or degenerate geometry
- deformation loops support the required rig motion
- pivots/origins support doors, wheels, pickups, weapons, placement, and snapping
- units and forward/up axes match the project convention
- collision proxies match gameplay intent without excessive detail

## Material and texture gates

- use consistent PBR channel conventions and color spaces
- avoid baking lighting into base color unless the art direction explicitly requires it
- pack channels only when the target pipeline documents the mapping
- keep texel density consistent across an asset family
- size textures from on-screen coverage; source resolution is not a runtime budget
- reuse materials/atlases where it reduces draw calls without harming iteration
- validate normal-map orientation and compression in the target renderer

## Generated 3D caution

If a tool can generate meshes, inspect the result with the same gates as an authored mesh. Never
infer clean topology, UVs, rigging, licensing, or efficient materials from a preview render. Keep
the tool/version and generation input in the asset manifest.

## Primary documentation

- [Khronos glTF registry and 2.0.1 specification](https://registry.khronos.org/glTF/)
- [Godot 4.7 importing 3D scenes](https://docs.godotengine.org/en/4.7/tutorials/assets_pipeline/importing_3d_scenes/index.html)
- [Unity 6.3 Model tab import settings](https://docs.unity3d.com/6000.3/Documentation/Manual/FBXImporter-Model.html)
- [Unreal Engine importing static meshes](https://dev.epicgames.com/documentation/en-us/unreal-engine/importing-static-meshes-using-fbx-in-unreal-engine)
- [three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)


<!-- ===== END create-game-assets/references/three-d-pipeline.md ===== -->


<!-- ===== BEGIN game-ai/SKILL.md ===== -->

---
name: game-ai
description: >
  Designs engine-neutral enemy and NPC AI: picks FSM, behavior tree, utility or GOAP, and builds
  perception, steering and A* pathfinding. Use for patrol and chase, "find a path to the player",
  agents stuck on corners or AI that sees through walls. Not for BT or utility code
  (`ai-behavior-trees-utility-ai`), Unreal AI (`unreal-behavior-trees`) or Unity NavMesh
  (`unity-navmesh`).
---

# Game AI architecture

Split every agent into layers that pass one small value to the next: **perceive** (facts on a
Blackboard) → **decide** (an intent such as "go to X", "attack Y") → **path** (waypoints) →
**steer** (a velocity) → **animate**. Most "dumb AI" bugs are a layer doing another layer's job:
a state that raycasts, a pathfinder called every frame, steering that ignores the path.

## When to use

- Choose a decision model, or fix one that has grown into flag soup.
- Build or debug an FSM, perception, steering, A* on a grid or graph, or a flow field.
- Diagnose agents that get stuck, oscillate, react unfairly fast or see through walls.

**Not this skill:** BT and utility runtimes go to `ai-behavior-trees-utility-ai`; Unreal
`BehaviorTree`, EQS and StateTree go to `unreal-behavior-trees`; Unity `NavMeshSurface` and
`NavMeshAgent` go to `unity-navmesh`. Movement and collision feel go to `physics-tuning`.

## Pick the decision model

| Situation | Default |
|---|---|
| 2-6 states, transitions obvious (door, turret, simple guard) | FSM |
| Several states share exits (stunned, dead, alerted from anywhere) | Hierarchical FSM: a parent state owns the shared exits |
| Many prioritized, interruptible behaviors, reused across enemy types | Behavior tree, built with `ai-behavior-trees-utility-ai` |
| Graded trade-offs (which target, heal or attack, needs) | Utility scoring, same skill; usually inside a BT branch |
| Multi-step plans with preconditions the designers want to emerge | GOAP; only if a BT cannot express it, because plans are hard to debug |

Common shipping mix: an FSM for the top mode (Idle, Combat, Dead) with a BT inside Combat.
Start with the FSM; promote a state to a BT when its transitions stop fitting on one screen.

## Workflow

1. **Read the project first.** Engine, existing AI code, navigation (navmesh, `AStarGrid2D`,
   a tile grid), and how enemies find the player today. Extend what exists.
2. **Write perception once.** One sensor per agent writes `target`, `last_known_pos`,
   `can_see`, `heard_at` to a Blackboard on a timer (5-10 Hz). Decisions read those facts; they
   never raycast.
3. **Pick the model** from the table and keep transitions inside states (or a table), not in
   scattered `if state == ...` checks.
4. **Path on the coarsest graph that works** (waypoints or a nav grid beats a dense pixel grid),
   cache the path, and follow the next waypoint with steering.
5. **Add stuck and fairness guards** (see Gotchas) before tuning numbers.
6. **Verify with runnable checks**, not just by watching:
   - A* admissibility: on 50 random grids, the path cost from A* equals Dijkstra's (`h = 0`)
     cost. Any mismatch means the heuristic or step costs are wrong.
   - State flicker: log transitions with timestamps during a scripted run; more than about 2
     transitions per second for one agent means missing hysteresis.
   - Stuck: run agents through the level headless and fail if any makes less than 0.5 units of
     progress toward its waypoint in 2 s.
   Then watch it with the path, current state and sight cone drawn on screen.

## Gotchas

**FSM**
- **The initial state's `enter()` never runs** when the agent assigns `current = Patrol.new()`
  without calling it. Route the first state through the same `change_state()` as every other.
- **Changing state from inside `enter()`/`exit()`** re-enters the machine and runs exits twice.
  Queue the next state and apply it after `update()` returns.
- **Threshold flicker.** Chase at 10 m and give up at 10 m, and the agent toggles every frame
  at the boundary. Use separate enter and exit thresholds (chase at 10, give up at 14) and a
  minimum time in state of about 0.3-0.5 s.

**Perception**
- **Check cheap to expensive:** squared distance, then the view cone (`dot(forward, dir) >
  cos(half_angle)`), then one raycast. Only survivors pay for the ray; stagger rays across frames.
- **One ray to the target's origin** fails behind low cover (origin at the feet) or passes through
  a gap at the waist. Cast to two or three points (head, chest) and accept any hit.
- **Omniscient AI feels like cheating.** Chase the last-known position, then search, instead of
  reading the player's live position after sight is lost. Delay the first reaction by roughly
  0.2-0.5 s, or fill an awareness meter faster at close range, so players can react.

**Steering**
- **Weighted sums cancel.** Seek plus avoid pointing opposite ways sums to zero and the agent
  freezes at the wall. Use priority truncation: apply avoidance first and spend the remaining
  force budget on lower behaviors.
- **Waypoint radius smaller than one tick of travel** (`speed * dt`) makes agents overshoot and
  orbit the point. Advance when within `max(radius, speed * dt)`.
- **Separation over every pair** is O(n²); bucket agents in a spatial hash with cells about the
  neighbor radius.
- **Steering and an engine nav agent both moving the body** jitter. Let the agent compute the
  path and feed its desired velocity into your steering (Godot: `NavigationAgent2D/3D`
  `velocity` and `velocity_computed` when avoidance is on; Unity: see `unity-navmesh`).

**Pathfinding**
- **Inadmissible heuristic** returns fast but longer paths: octile assumes diagonal steps cost
  √2; if diagonals cost 1 use Chebyshev; terrain weights below 1 break every grid heuristic.
- **Diagonal corner cutting** through wall corners: only allow a diagonal when both orthogonal
  neighbors are open. Godot `AStarGrid2D` defaults to `DIAGONAL_MODE_ALWAYS`, which cuts
  corners; set `DIAGONAL_MODE_ONLY_IF_NO_OBSTACLES` (or `NEVER` for 4-way with Manhattan).
- **Godot `AStarGrid2D.update()` clears every solid point and weight.** Call it after setting
  `region`/`cell_size`/`offset`, then mark walls. `jumping_enabled` ignores weight scales.
- **Unreachable goal floods the whole map.** Label connected regions with a flood fill once and
  reject cross-region requests, or cap node expansions per search.
- **Repathing every frame.** Repath when the target moves more than a cell (or 1-2 m), or every
  0.25-0.5 s, staggered, with a per-frame budget of searches. Many agents to one goal: one flow
  field (Dijkstra from the goal) instead of A* per agent.
- **Stuck forever.** If progress toward the next waypoint stalls for about 2 s, repath; after two
  failed repaths, change state (give up, teleport off-screen, or pick a new goal).

## References

- `references/pathfinding.md`: read when writing A* or a grid adapter by hand, choosing a
  heuristic, or deciding between hand-rolled A*, `AStarGrid2D` and an engine navmesh.
- `references/fsm-perception-steering.md`: read when implementing a hierarchical FSM, a
  sight/hearing sensor or priority-truncated steering.

## Related skills

- `ai-behavior-trees-utility-ai`: BT and utility runtimes once the model is chosen.
- `unity-navmesh`, `unreal-behavior-trees`: engine navigation and AI assets.
- `physics-tuning`: agent radius, movement and collision response.
- `procedural-gen`: the level graph the AI navigates.

## Version notes

Last verified: 2026-11-11.

- Godot 4.7 `AStarGrid2D`: default `diagonal_mode` is `DIAGONAL_MODE_ALWAYS`, `update()` clears
  point data, and `jumping_enabled` disables weight scaling
  (https://docs.godotengine.org/en/4.7/classes/class_astargrid2d.html).
- Godot 4.7 `NavigationAgent2D`: `avoidance_enabled`, `velocity`, `velocity_computed`
  (https://docs.godotengine.org/en/4.7/classes/class_navigationagent2d.html).


<!-- ===== END game-ai/SKILL.md ===== -->


<!-- ===== BEGIN game-ai/references/fsm-perception-steering.md ===== -->

# FSM, perception and steering patterns

Contents:
1. State machine with queued transitions and shared exits
2. Sight and hearing sensor
3. Priority-truncated steering

Snippets are Godot 4.7 GDScript; the structure ports directly to C# or any engine.

## 1. State machine with queued transitions and shared exits

The machine owns `change_state()`, so the first state's `enter()` runs like every other. A
transition requested during `enter()`/`exit()`/`update()` is queued and applied once, after the
current call returns. Shared exits (death, stun) live in one place instead of in every state.

```gdscript
# state_machine.gd
class_name StateMachine extends RefCounted

var agent
var current: AIState
var _queued: AIState
var _time_in_state := 0.0

func _init(owner_agent, first: AIState) -> void:
    agent = owner_agent
    request(first)
    _apply_queued()

func request(next: AIState) -> void:
    _queued = next                      # last request in one tick wins

func tick(dt: float) -> void:
    _time_in_state += dt
    var shared := _shared_exit()        # checked before the state, so no state can forget it
    if shared != null and (current == null or shared.get_script() != current.get_script()):
        request(shared)
    elif current != null:
        current.update(self, dt)
    _apply_queued()

func time_in_state() -> float:
    return _time_in_state

func _shared_exit() -> AIState:
    if agent.health <= 0:
        return DeadState.new()
    return null

func _apply_queued() -> void:
    while _queued != null:              # enter() may queue again; apply in order, never recurse
        var next := _queued
        _queued = null
        if current != null:
            current.exit(self)
        current = next
        _time_in_state = 0.0
        current.enter(self)
```

```gdscript
# ai_state.gd: base class. States call machine.request(), never assign machine.current.
class_name AIState extends RefCounted
func enter(_machine: StateMachine) -> void: pass
func update(_machine: StateMachine, _dt: float) -> void: pass
func exit(_machine: StateMachine) -> void: pass
```

```gdscript
# chase_state.gd: hysteresis on distance plus a minimum time in state.
class_name ChaseState extends AIState
const GIVE_UP_DISTANCE := 14.0          # chase starts at 10 (see PatrolState); leave at 14
const MIN_TIME := 0.4

func update(machine: StateMachine, _dt: float) -> void:
    var bb: Dictionary = machine.agent.blackboard
    if machine.time_in_state() < MIN_TIME:
        return
    if not bb.can_see and machine.agent.global_position.distance_to(bb.last_known_pos) < 1.0:
        machine.request(SearchState.new())
    elif machine.agent.global_position.distance_to(bb.last_known_pos) > GIVE_UP_DISTANCE:
        machine.request(PatrolState.new())
```

`PatrolState`, `SearchState` and `DeadState` follow the same shape. Each script holds one
`class_name`, so put each in its own file.

## 2. Sight and hearing sensor

One sensor per agent, ticked on a timer, writes facts the decision layer reads. The order is
cheap to expensive, and only targets that pass the cone test pay for raycasts.

```gdscript
# sensor_3d.gd: attach under the agent; set eye, target and blackboard from the agent.
extends Node3D

@export var sight_range := 20.0
@export var half_angle_deg := 55.0
@export var tick_interval := 0.15           # about 7 Hz; stagger start times across agents
@export_flags_3d_physics var sight_mask := 1
var eye: Node3D
var target: Node3D
var blackboard: Dictionary
var _timer := randf() * 0.15                # random phase so agents don't all raycast together
var _exclude: Array[RID] = []

func _ready() -> void:
    if get_parent() is CollisionObject3D:
        _exclude.append(get_parent().get_rid())  # don't let the ray hit our own body

func _physics_process(dt: float) -> void:
    _timer -= dt
    if _timer > 0.0:
        return
    _timer = tick_interval
    var seen := _can_see(target)
    blackboard.can_see = seen
    if seen:
        blackboard.last_known_pos = target.global_position

func _can_see(t: Node3D) -> bool:
    if t == null:
        return false
    var to := t.global_position - eye.global_position
    if to.length_squared() > sight_range * sight_range:
        return false                         # 1. distance, no sqrt
    var fwd := -eye.global_basis.z
    if fwd.dot(to.normalized()) < cos(deg_to_rad(half_angle_deg)):
        return false                         # 2. view cone
    var space := get_world_3d().direct_space_state
    for offset in [Vector3(0, 1.6, 0), Vector3(0, 1.0, 0)]:   # 3. head, then chest
        var q := PhysicsRayQueryParameters3D.create(
            eye.global_position, t.global_position + offset, sight_mask, _exclude)
        var hit := space.intersect_ray(q)
        if hit.is_empty() or hit.collider == t:
            return true
    return false

# Hearing: gameplay posts sounds; agents never poll for them.
func hear(at: Vector3, loudness_radius: float) -> void:
    if eye.global_position.distance_squared_to(at) <= loudness_radius * loudness_radius:
        blackboard.heard_at = at
```

Post noises through a group call, for example
`get_tree().call_group(&"ai_sensors", &"hear", pos, 12.0)` for a gunshot and a smaller radius for
footsteps. Add an awareness value that rises while `can_see` holds (faster when close) and acts
only past a threshold, so the first sighting is not an instant hit.

## 3. Priority-truncated steering

Blending all behaviors with weights lets opposing forces cancel. Priority truncation spends a
fixed force budget in order: avoidance first, then separation, then path following.

```gdscript
# steering.gd: returns a force; the caller integrates vel += force * dt, pos += vel * dt.
func steer(pos: Vector2, vel: Vector2, wants: Array[Vector2], max_force: float) -> Vector2:
    var total := Vector2.ZERO
    var budget := max_force
    for want in wants:                      # ordered by priority, highest first
        if budget <= 0.0:
            break
        var f := want.limit_length(budget)
        total += f
        budget -= f.length()
    return total

func arrive(pos: Vector2, vel: Vector2, target: Vector2, max_speed: float, slow_radius: float) -> Vector2:
    var offset := target - pos
    var dist := offset.length()
    if dist < 0.001:
        return -vel
    var speed := max_speed * minf(dist / slow_radius, 1.0)
    return offset / dist * speed - vel
```

Call it as `steer(pos, vel, [avoid, separate, arrive_to_waypoint], max_force)`. Separation reads
only neighbors from a spatial hash (cells about the neighbor radius, often 2× the agent radius).


<!-- ===== END game-ai/references/fsm-perception-steering.md ===== -->


<!-- ===== BEGIN game-ai/references/pathfinding.md ===== -->

# Pathfinding: A* in full

Contents:
1. Complete A* (engine-neutral Python) and its correctness points
2. Heuristics by movement type
3. Grid graph adapter (no corner cutting)
4. Admissibility self-test
5. When to use Godot `AStarGrid2D` or an engine navmesh instead
6. Performance notes

A* finds the shortest path on a **graph** (nodes + weighted edges). A grid is
just one kind of graph. The algorithm is the same whether nodes are tiles, rooms,
or navmesh polygons — only `neighbors()` and `cost()` change.

A* keeps a priority queue (the *frontier*) ordered by `f = g + h`, where `g` is
the known cost from the start and `h` is a heuristic estimate to the goal. It is
optimal **if** `h` never overestimates the true remaining cost (it is
*admissible*). With `h = 0`, A* degenerates to Dijkstra's algorithm.

## Complete A* (engine-neutral Python)

```python
import heapq, math

def heuristic(a, b):               # nodes are (x, y) tuples; see the table below
    dx, dy = abs(a[0] - b[0]), abs(a[1] - b[1])
    return (dx + dy) + (math.sqrt(2) - 2) * min(dx, dy)   # octile (8-way grid)

def a_star(graph, start, goal, h=heuristic):   # h=lambda a, b: 0 turns this into Dijkstra
    # Priority queue of (f_score, tie, node). heapq pops the SMALLEST first.
    frontier = [(0, 0, start)]
    came_from = {start: None}      # node -> node we reached it from
    cost_so_far = {start: 0.0}     # node -> best known g cost from start
    counter = 0                    # stable tie-breaker so heapq never compares nodes

    while frontier:
        _, _, current = heapq.heappop(frontier)
        if current == goal:
            break                  # early exit: we popped the goal, path is optimal

        for nxt in graph.neighbors(current):
            new_cost = cost_so_far[current] + graph.cost(current, nxt)
            # Relax: accept this edge only if it improves the best known cost.
            if nxt not in cost_so_far or new_cost < cost_so_far[nxt]:
                cost_so_far[nxt] = new_cost
                priority = new_cost + h(nxt, goal)           # f = g + h
                counter += 1
                heapq.heappush(frontier, (priority, counter, nxt))
                came_from[nxt] = current

    return came_from, cost_so_far

def reconstruct_path(came_from, start, goal):
    if goal not in came_from:
        return None                # unreachable
    path = []
    node = goal
    while node != start:
        path.append(node)
        node = came_from[node]
    path.append(start)
    path.reverse()                 # came_from points backward; flip to start->goal
    return path
```

Key correctness points:

- **Check the goal when *popping*, not when pushing.** Testing on push breaks as
  soon as edges have varying cost; testing on pop is always correct.
- **Relaxation** (`new_cost < cost_so_far[nxt]`) lets a node be improved if a
  cheaper route is found later — essential with non-uniform movement costs.
- **Tie-breaker**: push a monotonic counter alongside the node so the heap never
  has to order two equal-`f` nodes by the node object itself.

## Heuristics by movement type

| Allowed moves | Heuristic | Formula (`dx=|ax-bx|`, `dy=|ay-by|`) |
|---|---|---|
| 4-directional grid | Manhattan | `dx + dy` |
| 8-directional grid | Octile | `(dx + dy) + (sqrt(2) - 2) * min(dx, dy)` |
| Any-angle / Euclidean space | Euclidean | `sqrt(dx*dx + dy*dy)` |

Scale the heuristic by the minimum step cost so it stays in the same units as
`g`. If `h` can exceed the true cost, A* is faster but returns non-optimal paths
(this is the "weighted A*" trade-off — use it deliberately, not by accident).

## Grid graph adapter

```python
class GridGraph:
    def __init__(self, walls, width, height, diagonal=True):
        self.walls, self.w, self.h, self.diagonal = walls, width, height, diagonal
    def in_bounds(self, p): return 0 <= p[0] < self.w and 0 <= p[1] < self.h
    def passable(self, p):  return p not in self.walls
    def open(self, p):      return self.in_bounds(p) and self.passable(p)
    def neighbors(self, p):
        x, y = p
        result = [c for c in [(x+1,y),(x-1,y),(x,y+1),(x,y-1)] if self.open(c)]
        if self.diagonal:
            for dx, dy in [(1,1),(1,-1),(-1,1),(-1,-1)]:
                # No corner cutting: both orthogonal neighbours must be open too.
                if self.open((x+dx, y+dy)) and self.open((x+dx, y)) and self.open((x, y+dy)):
                    result.append((x+dx, y+dy))
        return result
    def cost(self, a, b):
        diagonal = a[0] != b[0] and a[1] != b[1]
        return math.sqrt(2) if diagonal else 1.0   # multiply by a terrain weight >= 1
```

The step costs must match the heuristic: octile assumes diagonal steps cost `sqrt(2)`.
If diagonals cost 1 the true distance is Chebyshev (`max(dx, dy)`) and octile
overestimates; on a 4-way grid (`diagonal=False`) switch the heuristic to Manhattan.
Terrain weights below 1 make any of these heuristics inadmissible.

## Admissibility self-test

Run this whenever the heuristic, step costs or terrain weights change. Dijkstra (`h = 0`) is
always optimal, so any grid where A* returns a higher cost means the heuristic overestimates.

```python
import random

def check_admissible(trials=50, size=20, wall_ratio=0.25, seed=1):
    rng = random.Random(seed)
    for _ in range(trials):
        walls = {(rng.randrange(size), rng.randrange(size))
                 for _ in range(int(size * size * wall_ratio))}
        start, goal = (0, 0), (size - 1, size - 1)
        walls -= {start, goal}
        graph = GridGraph(walls, size, size, diagonal=True)
        _, a_cost = a_star(graph, start, goal)
        _, d_cost = a_star(graph, start, goal, h=lambda a, b: 0.0)
        if goal in d_cost:
            assert abs(a_cost[goal] - d_cost[goal]) < 1e-9, (a_cost[goal], d_cost[goal])
    return True
```

## When to use an engine navmesh instead

Hand-rolled grid A* is ideal for 2D tile games and for understanding the
algorithm. For 3D worlds, arbitrary geometry, dynamic obstacle avoidance, and
agent radius/height, prefer the engine's baked navigation:

- **Unity** — bake a `NavMeshSurface` (AI Navigation package) and drive a
  `NavMeshAgent` (see `unity-navmesh`).
- **Unreal** — Nav Mesh Bounds + `AIController` MoveTo (see `unreal-behavior-trees`).
- **Godot** — `NavigationRegion2D/3D` + `NavigationAgent2D/3D`, querying
  `NavigationServer2D/3D` for paths. For a tile grid, the built-in `AStarGrid2D`
  already implements this file: set `region` and `cell_size`, set `diagonal_mode`
  (the default `DIAGONAL_MODE_ALWAYS` cuts wall corners) and the heuristics, call
  `update()`, and only then mark walls with `set_point_solid()` or
  `fill_solid_region()`, because `update()` clears every solid flag and weight. Read
  paths with `get_id_path(from, to)` or `get_point_path`; pass
  `allow_partial_path = true` to get the closest reachable cell instead of an empty
  array. `jumping_enabled` speeds searches up but ignores weight scales.

These handle path smoothing, off-mesh links, and crowd avoidance you would
otherwise reimplement. Use A* directly when the world is a discrete grid/graph or
when you need full control over the cost function.

## Performance notes

- Shrink the graph before optimizing the search: merge open areas, use waypoint
  graphs instead of dense grids, or precompute connected regions.
- Cap pathfinding work per frame (a budget of N searches), and queue the rest.
- For many agents heading to the same goal, compute one **flow field** (a
  Dijkstra pass from the goal outward) and have every agent follow the gradient,
  instead of running A* per agent.


<!-- ===== END game-ai/references/pathfinding.md ===== -->


<!-- ===== BEGIN game-feel/SKILL.md ===== -->

---
name: game-feel
description: >
  Adds engine-neutral juice to a working mechanic: trauma-based screen shake, hit-stop, eased
  tweens, squash and stretch, and knockback. Use when the game feels flat, weightless or not
  punchy, or hits and jumps should feel satisfying. Not for coyote time (`platformer`), input
  buffering (`input-systems`), camera follow (`camera-systems`) or HUD layout (`game-ui-ux`).
---

# Game feel (juice)

Feedback sells an action: several small, brief, exaggerated responses fired together on one
event. This skill adds that layer on top of a working mechanic. It never changes the
simulation, so shake moves the camera and hit-stop scales time; neither moves bodies or stalls
gameplay logic.

## When to use

- A hit, jump, landing, dash, pickup, death or button press works but feels weak.
- Adding or tuning shake, hit-stop, easing, squash and stretch, flash, knockback, number pops.
- Deciding how much juice is enough, and adding reduce-shake and reduce-flash options.

**Not this skill:** jump controller math (`platformer`), generic input buffering and rebinding
(`input-systems`), camera follow, deadzones and look-ahead (`camera-systems`, which exposes the
offset this skill writes), mixing and ducking (`audio-design`), shader dissolves
(`shader-programming`), tween and particle node APIs (`godot-animation`, `unity-animation`).

## Workflow

1. **Find the event hooks.** Juice attaches to discrete events (`hit`, `landed`, `picked_up`,
   `died`). If the mechanic emits none, add signals or C# events first; never poll for them.
2. **Assign each event a tier** (table below), then fire that tier's bundle from one
   `feedback(tier, pos)` call so the whole game stays proportional.
3. **Start with 2-3 channels per event** (sound, particles, shake), play, and add channels
   until the event reads. Hit-stop and shake are the strongest and most abused; keep them for
   impacts.
4. **Ease everything that moves.** Overshoot (`back`) for pops, ease-out for settling,
   ease-in only for anticipation.
5. **Decide what runs during hit-stop.** Time scale slows timers, tweens and `_process`/`Update`
   delta. Shake decay and UI tweens should usually use real time; the frozen pose should not.
6. **Ship accessibility toggles**: shake strength 0-100 %, reduce flashing, reduce camera motion.
7. **Verify with a headless check, then by eye.** Fire the event twice 30 ms apart and assert
   time scale is back to 1.0 after the longer stop, trauma reaches 0 within `1 / decay`
   seconds, and every scale tween ends at exactly its rest value. Then ask the user to play it
   and report whether the hit reads, whether anything feels nauseating and whether input still
   registers during the freeze.

## Tiers

| Tier | Trauma | Hit-stop | Particles | Extra | Example events |
|------|:------:|:--------:|:---------:|-------|----------------|
| small | 0.10-0.20 | none | 0-4 | tick SFX | footstep, coin, UI hover |
| medium | 0.30-0.50 | 0.04-0.06 s | 6-12 | flash | normal hit, landing, pickup |
| large | 0.70-1.00 | 0.10-0.15 s | 20-40 | flash, zoom, number | crit, boss hit, death, explosion |

## Patterns

### 1. Screen shake from decaying trauma

```gdscript
# Godot 4.7 Camera2D script. Shake = trauma^2, so light hits barely move and heavy hits punch.
# Writes the camera OFFSET (visual only). Uses real time so the shake keeps decaying during
# hit-stop instead of freezing the camera off-centre.
# Camera2D.ignore_rotation defaults to true; set it false or the roll does nothing.
extends Camera2D
@export var decay := 1.2          # trauma lost per real second
@export var max_offset := Vector2(12, 8)
@export var max_roll := 0.1       # radians
@export var strength := 1.0       # player setting, 0..1
var trauma := 0.0
var _t := 0.0

func add_trauma(amount: float) -> void:
    trauma = clampf(trauma + amount, 0.0, 1.0)   # hits add; they don't reset

func _process(dt: float) -> void:
    if trauma <= 0.0:
        return
    var real_dt := dt / maxf(Engine.time_scale, 0.0001)
    trauma = maxf(trauma - decay * real_dt, 0.0)
    var shake := trauma * trauma * strength
    _t += real_dt * 30.0
    # Summed sines at unrelated rates: smooth, never a per-frame random buzz.
    offset = Vector2(max_offset.x * shake * sin(_t * 1.7), max_offset.y * shake * sin(_t * 2.3))
    rotation = max_roll * shake * sin(_t * 1.1)
    if trauma == 0.0:
        offset = Vector2.ZERO
        rotation = 0.0
```

Unity: drive `CinemachineBasicMultiChannelPerlin` `AmplitudeGain`/`FrequencyGain` from
`trauma * trauma`, decaying with `Time.unscaledDeltaTime`; for one-off hits use a
`CinemachineImpulseSource` on the hitter and a `CinemachineImpulseListener` on the camera.

### 2. Hit-stop that survives overlapping hits

```gdscript
# Godot 4.7. Slow time, restore after a REAL-TIME delay; only the newest call restores.
var _hit_stop_id := 0

func hit_stop(duration := 0.08, slow := 0.05) -> void:
    _hit_stop_id += 1
    var my_id := _hit_stop_id
    Engine.time_scale = slow
    # 4th arg ignore_time_scale=true: the timer still fires while the game is slowed.
    await get_tree().create_timer(duration, true, false, true).timeout
    if my_id == _hit_stop_id:       # a newer hit-stop owns the restore
        Engine.time_scale = 1.0
```

```csharp
// Unity. WaitForSecondsRealtime ignores Time.timeScale; WaitForSeconds never finishes at 0.
int _hitStopId;
IEnumerator HitStop(float duration = 0.08f, float slow = 0.05f) {
    int myId = ++_hitStopId;
    Time.timeScale = slow;
    yield return new WaitForSecondsRealtime(duration);
    if (myId == _hitStopId) Time.timeScale = 1f;
}
```

### 3. Squash, stretch and overshoot

```gdscript
# Godot 4.7. Keep area roughly constant: stretch one axis, squash the other, spring back.
func pop(node: Node2D) -> void:
    node.scale = Vector2(1.3, 0.7)
    var tw := node.create_tween()
    tw.tween_property(node, "scale", Vector2.ONE, 0.18) \
      .set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)   # overshoots past 1, settles
```

Kill or reuse the previous tween on the same property (`if _tw: _tw.kill()`) when the event can
retrigger, or two tweens fight and the node ends at the wrong scale.

## Gotchas

- **Shaking the body instead of the camera** desyncs collision and aim. Shake the camera offset
  or a visual-only pivot.
- **Random offset every frame** buzzes like static. Use noise or summed sines under a decaying
  trauma value.
- **Hit-stop never ends**: Unity `WaitForSeconds` or a Godot timer without `ignore_time_scale`
  does not advance at time scale 0, and barely at 0.05. Wait in real time.
- **Overlapping hit-stops** (two hits 30 ms apart) let the first timer restore time during the
  second freeze. Only the newest call restores.
- **Shake freezes off-centre during hit-stop** when it decays with scaled delta. Decay with real
  time (Godot `dt / Engine.time_scale`, Unity `Time.unscaledDeltaTime`).
- **UI and menu tweens crawl during hit-stop.** Godot `Tween.set_ignore_time_scale(true)`; Unity
  coroutines with `Time.unscaledDeltaTime`.
- **Time scale does not slow audio** in Godot or Unity, so a long freeze plays the impact sound
  over a frozen picture. Keep stops short or lower `AudioServer.playback_speed_scale` too.
- **Hit-stop on every frame of a held or multi-hit attack** locks the game. One per impact, and
  skip it on hits that land during an active stop.
- **Juice that never returns to rest** (scale drift, shake that does not decay) stops reading as
  feedback. Snap to the rest value at the end of every effect.
- **Over-juicing routine actions** causes nausea and hides real impacts. Footsteps get the small
  tier or nothing.
- **Feedback that blocks input.** Long freezes and uncancellable animations feel like lag; keep
  freezes under about 0.15 s and buffer input through them.
- **Flashing past the photosensitivity limit.** Large bright flashes must stay at or under three
  per second (WCAG 2.3.1), and a reduce-flashing option should replace them with a tint.

## References

- `references/feedback-recipes.md`: read when you need the easing cheat sheet, an eased pop for
  Unity without a tween package, flash, knockback, number-pop and particle recipes, or the
  per-engine binding summary (Godot, Unity, Phaser).

## Related skills

- `camera-systems`: owns follow and framing; this skill only writes the shake offset.
- `godot-animation`, `unity-animation`: the tween, AnimationPlayer and particle APIs.
- `audio-design`: the sound layer of each feedback bundle.
- `physics-tuning`: knockback forces and a stable timestep.
- `platformer`: jump feel controls that juice sits on top of.

## Version notes

Last verified: 2026-11-11.

- Godot 4.7: `SceneTree.create_timer(time_sec, process_always, process_in_physics,
  ignore_time_scale)`, `Tween.set_ignore_time_scale()`, `Camera2D.ignore_rotation` (default
  `true`); `Engine.time_scale` scales `_process`/`_physics_process` delta, `Timer` and
  `SceneTreeTimer` but not audio (https://docs.godotengine.org/en/4.7/classes/class_engine.html).
- Unity 6.3 LTS with Cinemachine 3.1 (3.1.7 is the latest release, June 2026):
  `CinemachineBasicMultiChannelPerlin`, `CinemachineImpulseSource`,
  `CinemachineImpulseListener` (https://packages.unity.com/com.unity.cinemachine).
- WCAG 2.2 success criterion 2.3.1, three flashes or below threshold
  (https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html).
- Trauma-based shake follows Squirrel Eiserloh's GDC 2016 talk "Math for Game Programmers:
  Juicing Your Cameras With Math".


<!-- ===== END game-feel/SKILL.md ===== -->


<!-- ===== BEGIN game-feel/references/feedback-recipes.md ===== -->

# Feedback recipes

Contents:
1. The trauma model and tuning ranges
2. Easing cheat sheet, plus an eased pop for Unity without a tween package
3. The rest of the feedback menu (flash, knockback, number pop, particles, freeze)
4. Accessibility toggles
5. Per-engine binding summary

Snippets target Godot 4.7 and Unity 6.3 LTS.

## 1. The trauma model (why shake feels good)

Track a single `trauma` value in `[0, 1]`. Events **add** trauma; it **decays** linearly each
frame. The actual shake amount is `trauma^2` (or `trauma^3`) so:

- small/frequent events barely nudge the screen (low trauma, squared → tiny),
- big events punch hard (high trauma, squared → near full),
- shake **always ends** on its own because trauma decays to 0.

Offset and rotation are `max_* * shake * noise(t)`. Sample a noise function or summed sines
across time — never a fresh `rand()` per frame, which produces a harsh buzz instead of a shake.

```gdscript
# 1D value-noise-ish sampler without an addon: layered sines at incommensurate rates.
func _shake_axis(seed: float, t: float) -> float:
    return 0.6 * sin(t * 11.0 + seed) + 0.4 * sin(t * 23.0 + seed * 2.0)
```

Tunable starting points: `max_offset = (8..16, 6..10) px`, `max_roll = 0.05..0.12 rad`,
`decay = 1.0..1.5` trauma/sec, per-hit trauma `0.15` (light) → `0.8` (heavy).

## 2. Easing cheat sheet — which curve for which job

| Goal | Ease | Godot `Tween` | Notes |
|------|------|---------------|-------|
| UI/element "pop" in | overshoot | `TRANS_BACK`, `EASE_OUT` | shoots past target, settles back |
| Bouncy, lively land | bounce/elastic | `TRANS_ELASTIC`/`TRANS_BOUNCE`, `EASE_OUT` | use sparingly; reads as cartoonish |
| Settle / decelerate | ease-out | `TRANS_CUBIC`/`TRANS_QUAD`, `EASE_OUT` | the default for "comes to rest" |
| Anticipation / wind-up | ease-in | `TRANS_CUBIC`, `EASE_IN` | slow start before a fast action |
| Smooth A→B both ends | ease-in-out | `TRANS_SINE`, `EASE_IN_OUT` | camera moves, menu slides |

Unity 6.3 LTS has no built-in tween library; options in order of preference: `Vector3.SmoothDamp`
for spring-like follow, `Mathf.SmoothStep`/hand-rolled ease in a coroutine, Animator curves,
or a third-party tween package if the project already uses one. Keep the *curve choice* the
same regardless of tool.

```csharp
// Unity 6.3 LTS: an eased scale "pop" in a coroutine (no external deps).
static float EaseOutBack(float k) {                     // 0 -> 1, peaks ~10% past 1
    const float c1 = 1.70158f, c3 = c1 + 1f;
    float m = k - 1f;
    return 1f + c3 * m * m * m + c1 * m * m;
}

IEnumerator Pop(Transform t, float dur = 0.18f) {
    var squash = new Vector3(1.3f, 0.7f, 1f);            // squash on the event
    for (float e = 0f; e < dur; e += Time.deltaTime) {
        // Unclamped, so the overshoot past Vector3.one survives the lerp.
        t.localScale = Vector3.LerpUnclamped(squash, Vector3.one, EaseOutBack(e / dur));
        yield return null;
    }
    t.localScale = Vector3.one;
}
```

## 3. The rest of the feedback menu

- **Flash:** tint the sprite/material white for 1–3 frames on hit (`modulate`/material color),
  then tween back. Cheap, hugely legible.
- **Knockback:** apply an impulse away from the hit normal, clamped and short; let
  `physics-tuning` own stability. Pair with brief control lockout, not a long one.
- **Number/text pop:** spawn a damage number that rises, fades, and eases out; randomize the
  horizontal drift so stacked hits fan out.
- **Particles:** a short burst at the contact point (sparks, dust, debris). Pool them
  (`performance-optimization`) — do not instance-and-free per hit.
- **Freeze frame:** the hit-stop in the body; scale duration to importance (0.04 s light →
  0.15 s heavy). Optionally freeze only the attacker+target, not the whole world.
- **Anticipation & follow-through:** a tiny wind-up before a big action and a settle after read
  as weight; this is animation, not code (engine animation skill).
- **Chromatic/vignette/zoom punch:** post-process nudges for big moments; keep brief.

## 4. Accessibility (ship these toggles)

- **Reduce screen shake** (scale trauma output by a 0–100% setting, default ~60–80%).
- **Reduce/disable flashing** (photosensitivity) — replace white flashes with a static tint.
  Even with flashing on, keep any large-area flash at or under three flashes in any one-second
  window ([WCAG 2.3.1](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html)
  general flash threshold; [Xbox Accessibility Guideline 118](https://learn.microsoft.com/en-us/xbox/accessibility/xbox-accessibility-guidelines/118),
  Photosensitivity).
- **Reduce camera motion** — cut shake roll and zoom punches.

These pair with `game-ui-ux` (settings menu) and `input-systems` (accessibility section).

## 5. Per-engine binding summary

- **Godot 4.7:** `create_tween()` + `tween_property().set_trans().set_ease()`; `GPUParticles2D/3D`
  one-shot; `Engine.time_scale` + `ignore_time_scale` timer; shake on `Camera2D.offset`.
- **Unity 6.3 LTS:** coroutines + `SmoothDamp`/curves (or a tween package); `ParticleSystem.Play()`;
  `Time.timeScale` + `WaitForSecondsRealtime`; shake via `CinemachineBasicMultiChannelPerlin`
  amplitude/frequency driven by `trauma^2`, or `CinemachineImpulseSource.GenerateImpulse()` for
  one-off hits (see `camera-systems`).
- **Web (Phaser/Pixi/three):** tween via the engine/library tween; `this.cameras.main.shake()`
  in Phaser; `requestAnimationFrame`-driven eases elsewhere.


<!-- ===== END game-feel/references/feedback-recipes.md ===== -->


<!-- ===== BEGIN camera-systems/SKILL.md ===== -->

---
name: camera-systems
description: >
  Builds and tunes game cameras, engine-neutral with Godot and Cinemachine 3 mappings: 2D follow
  with deadzone and look-ahead, third-person orbit, first-person look and split-screen. Use when
  the camera lags, jitters while following, shows past the level edge, clips through walls or
  changes with frame rate. Not for shake (`game-feel`) or physics timestep jitter
  (`physics-tuning`).
---

# Camera systems

A good camera follows smoothly at any frame rate, leads the action, never shows outside the
level and never clips through walls. This skill owns those techniques and maps them onto each
engine's camera node or rig; prefer the engine's built-in rig before hand-rolling one.

## When to use

- A 2D camera should follow smoothly, ignore small movements, lead motion and stay in bounds.
- A 3D third-person orbit or first-person look controller, or framing several targets.
- Fixing jitter, snapping, motion sickness or a camera that peeks past the level.

**Not this skill:** shake magnitude and triggers (`game-feel`; this skill only exposes the
offset), physics jitter of the body itself (`physics-tuning`), `Camera3D` and environment setup
(`godot-3d-essentials`), player movement (`godot-2d-movement` or the engine movement skill),
look-sensitivity input curves (`input-systems`).

## Core workflow

1. **Decide what the camera serves.** Platformer (lead the jump, see hazards), top-down (centre
   with deadzone), third-person (orbit plus collision), first-person (look only).
2. **Use the built-in rig first**: Godot `Camera2D` smoothing, limits and drag margins, or
   `SpringArm3D`; Unity Cinemachine 3 (`CinemachineCamera` plus Position Composer, Orbital
   Follow, Deoccluder, Confiner). Hand-roll only what the rig cannot do.
3. **Smooth with `1 - exp(-rate * dt)`** or a critically damped spring (`SmoothDamp`), never a
   fixed `lerp(a, b, 0.1)` per frame.
4. **Add a deadzone, then look-ahead** eased toward its goal so direction flips don't whip.
5. **Clamp the view, not the centre**, to the level rectangle, accounting for zoom.
6. **For 3D, separate look from collision**: yaw and pitch on a pivot, a spring arm or ray pulls
   the camera in, pitch clamped.
7. **Update after the target moves** (late update, or after physics) and follow the target's
   interpolated transform when physics interpolation is on.
8. **Verify with a runnable check, then by eye.** Step the follow code headless with a target
   moving at 300 px/s for 2 s at `dt = 1/30` and at `dt = 1/144`, and compare how far the camera
   trails the target. With `rate = 8` exponential smoothing the lag is about 33 px and 37 px; a
   fixed `lerp(..., 0.1)` gives about 90 px and 19 px, a sign the follow is frame-rate
   dependent. Then ask the user to run into corners, walls and level edges at low and high frame
   rates and report any jitter, peeking or snapping.

## Patterns

### 1. Godot 2D built-in follow: smoothing + bounds (don't hand-roll first)

```gdscript
# Godot 4.7 Camera2D. Engine-provided smoothing + hard limits + drag margins.
@onready var cam := $Camera2D
func _ready() -> void:
    cam.make_current()
    cam.position_smoothing_enabled = true
    cam.position_smoothing_speed = 6.0           # higher = snappier; lower = floatier
    cam.limit_left = 0; cam.limit_top = 0        # clamp to the level rect (pixels)
    cam.limit_right = level_width; cam.limit_bottom = level_height
    cam.drag_horizontal_enabled = true           # built-in deadzone via drag margins
```

### 2. Frame-rate-independent smooth follow (when you hand-roll it)

```gdscript
# RIGHT: exponential smoothing — same feel at any FPS. `rate` ~ 5..12.
func _follow(dt: float) -> void:
    var t := 1.0 - exp(-rate * dt)               # converges correctly regardless of dt
    global_position = global_position.lerp(target.global_position, t)
# WRONG: global_position = global_position.lerp(target.global_position, 0.1)
#        → faster smoothing at higher FPS; different feel on every machine.
# Unity 6.3 LTS: Vector3.SmoothDamp(transform.position, target.position, ref vel, smoothTime) in
# LateUpdate gives the same spring behavior with built-in frame-rate correction.
```

### 3. Deadzone + look-ahead (lead the player, ignore jitter)

```gdscript
# Camera only chases once the target leaves the deadzone box, then aims AHEAD of motion.
func _camera_target(dt: float) -> Vector2:
    var to := target.global_position - _focus
    var dz := deadzone_half_extents                  # e.g. Vector2(48, 32)
    # Only move the focus by the overflow beyond the deadzone (per axis).
    _focus.x += clampf(absf(to.x) - dz.x, 0, INF) * signf(to.x)
    _focus.y += clampf(absf(to.y) - dz.y, 0, INF) * signf(to.y)
    var lead := target.velocity.normalized() * look_ahead_dist    # aim ahead of travel
    return _focus + lead
```

### 4. 3D third-person orbit with collision push-in

```gdscript
# Godot 4.7. Yaw/pitch a pivot; a SpringArm3D auto-pulls the camera in when blocked.
func _unhandled_input(e):
    if e is InputEventMouseMotion and Input.mouse_mode == Input.MOUSE_MODE_CAPTURED:
        # screen_relative is unscaled; `relative` is scaled by the stretch settings, so
        # sensitivity would change with window size. The docs recommend screen_relative
        # for captured-mouse aiming.
        _yaw -= e.screen_relative.x * sensitivity
        _pitch = clampf(_pitch - e.screen_relative.y * sensitivity,
                        deg_to_rad(-80.0), deg_to_rad(45.0))       # clamp pitch!
func _process(_dt):
    pivot.rotation = Vector3(_pitch, _yaw, 0)
    # $SpringArm3D handles wall collision: set spring_length + collision_mask; the child
    # Camera3D slides in automatically. RIGHT: spring arm. WRONG: camera clips through walls.
# Unity 6.3 LTS: a Cinemachine 3 CinemachineCamera (namespace Unity.Cinemachine) with an Orbital
# Follow + Cinemachine Deoccluder; the CinemachineBrain on the Camera blends automatically.
```

### 5. Screen shake hook (owned trigger lives in `game-feel`)

```gdscript
# Expose an additive offset the game-feel trauma model writes to; follow + shake compose.
var shake_offset := Vector2.ZERO                 # set each frame by game-feel (trauma^2 * noise)
func _apply(final_focus: Vector2) -> void:
    global_position = final_focus + shake_offset  # shake rides ON TOP of smooth follow
# Unity Cinemachine 3: CinemachineBasicMultiChannelPerlin (AmplitudeGain/FrequencyGain) for
# continuous noise driven by trauma; for one-off impacts, a CinemachineImpulseSource on the
# hitter plus a CinemachineImpulseListener on the camera.
```

## Gotchas

- **`lerp(pos, target, const)` per frame** is frame-rate dependent: floatier at 30 FPS,
  snappier at 144. Use `1 - exp(-rate * dt)` or `SmoothDamp`.
- **Jitter while following a physics body**: the body moves at the physics tick (60 Hz) and the
  camera at the display rate. Turn on physics interpolation (Godot
  `physics/common/physics_interpolation`) and follow the body's interpolated transform in
  `_process` (`get_global_transform_interpolated()` in 3D), or follow in the physics step with
  `Camera2D.process_callback = CAMERA2D_PROCESS_PHYSICS`. Mixing the two is what jitters.
- **One-frame lag** when following in the normal update before the target has moved. Follow in
  `LateUpdate` (Unity) or after movement and physics resolve.
- **Camera parented to the moving player** inherits every bump and fights interpolation. Keep
  the camera on its own branch (or `top_level = true`) and follow in code or with a rig.
- **Clamping the centre instead of the view** shows black past the edge. Clamp to
  `[min + half_view, max - half_view]`, and centre on any axis where the level is smaller than
  the view.
- **No deadzone in twitchy games** makes the camera twitch with every micro-movement; a box
  deadzone and a circular one feel different, so pick deliberately.
- **Unclamped pitch** flips the camera over the top. About -80° to +45° for an orbit, ±80° for
  first-person.
- **Mouse-look sensitivity changes with window size** in Godot: `InputEventMouseMotion.relative`
  is scaled by the stretch settings; read `screen_relative` for captured-mouse aiming.
- **Clipping through walls** in 3D: use a spring arm or occlusion ray, with a probe radius a
  little larger than the camera's near-plane half-size.
- **Slingshot after teleport or respawn**: a smoothed camera whips across the level. Hard-cut and
  reset the smoothing state (Godot `Camera2D.reset_smoothing()`), or fast-ease deliberately.
- **Shake written into the follow target** makes follow fight shake. Smooth follow first, add the
  shake offset last.

## References

- `references/follow-and-framing.md`: read for the smoothing derivation, a full deadzone plus
  look-ahead plus bounds 2D rig, orbit and first-person details, group framing and
  split-screen, cutscene blends, and the Godot/Cinemachine 3 component mapping table.

## Related skills

- `game-feel`: shake trauma and triggers; writes this skill's offset.
- `godot-2d-movement`, `godot-3d-essentials`: the player and world the camera frames.
- `physics-tuning`: timestep and interpolation for the bodies being followed.
- `input-systems`: look sensitivity, invert and stick response curves.

## Version notes

Last verified: 2026-11-11.

- Godot 4.7: `Camera2D.position_smoothing_*`, `limit_*`, `drag_*`, `process_callback`,
  `reset_smoothing()`; `InputEventMouseMotion.screen_relative`; physics interpolation and manual
  camera interpolation per
  https://docs.godotengine.org/en/4.7/tutorials/physics/interpolation/advanced_physics_interpolation.html.
- Unity 6.3 LTS with Cinemachine 3.1 (3.1.7 is the latest release, 9 June 2026; namespace
  `Unity.Cinemachine`). The 2.x names `CinemachineVirtualCamera`, `CinemachineCollider` and
  `CinemachineFramingTransposer` are deprecated in 3.x
  (https://packages.unity.com/com.unity.cinemachine).
- PhantomCamera (Godot addon) latest release v0.11.0.4, October 2026
  (https://github.com/ramokz/phantom-camera/releases).


<!-- ===== END camera-systems/SKILL.md ===== -->


<!-- ===== BEGIN camera-systems/references/follow-and-framing.md ===== -->

# Follow and framing

Contents:
1. Why `1 - exp(-rate*dt)` (frame-rate-independent smoothing)
2. Full 2D rig: deadzone, look-ahead, bounds
3. 3D third-person orbit
4. First-person look
5. Multi-target and group framing, split-screen
6. Cinematic blends and transitions
7. Per-engine rig summary (Godot 4.7, Cinemachine 3)

Snippets target Godot 4.7 and Unity 6.3 LTS with Cinemachine 3.

## 1. Why `1 - exp(-rate*dt)` (frame-rate-independent smoothing)

A naive `pos = lerp(pos, target, k)` applies `k` *per frame*, so at 144 FPS it smooths far more
per second than at 30 FPS — the feel changes with hardware. Exponential smoothing fixes the rate
*per second*:

```text
t = 1 - exp(-rate * dt)      # rate ≈ 5 (floaty) .. 12 (snappy)
pos = lerp(pos, target, t)   # identical convergence at any frame rate
```

A critically-damped spring (Unity `Vector3.SmoothDamp`, or a hand-rolled spring with `smoothTime`)
gives the same frame-rate independence plus velocity continuity (no overshoot). Prefer the
engine's built-in spring/smoothing before hand-rolling.

## 2. Full 2D rig: deadzone + look-ahead + bounds

Order of operations each frame, after the target moves:

1. Compute target overflow beyond the **deadzone** (box or circle) → move the focus by the
   overflow only.
2. Add **look-ahead**: `focus += dir_of_motion * lookAheadDist`, but **ease the look-ahead offset
   itself** toward its goal so a direction flip doesn't snap the view.
3. **Smooth** the camera toward the focus (section 1).
4. **Clamp** so the *visible rectangle* stays in bounds: clamp camera center to
   `[min + halfView, max - halfView]` per axis (clamp the view, not the center).

```gdscript
# Godot 4.7: clamp the VIEW, accounting for zoom and viewport size.
func _clamp_to_level(center: Vector2) -> Vector2:
    var half := get_viewport_rect().size * 0.5 / zoom
    return Vector2(
        clampf(center.x, level_rect.position.x + half.x, level_rect.end.x - half.x),
        clampf(center.y, level_rect.position.y + half.y, level_rect.end.y - half.y))
# If the level is smaller than the view on an axis, center on that axis instead of clamping.
```

Tunables: deadzone `32–64 px`, look-ahead `40–120 px` eased over `0.2–0.4 s`, smoothing
`rate 6–10`.

## 3. 3D third-person orbit

- **Rig:** an invisible pivot at the character's shoulder/head height; yaw on the pivot, pitch on
  a child; the camera sits at `-springLength` on local Z.
- **Collision:** a spring arm (Godot `SpringArm3D`) or occlusion ray casts from pivot to desired
  camera position and shortens to the first hit so the camera never clips through walls.
- **Pitch clamp:** ~`[-80°, +45°]` so the camera can't flip or bury into the floor.
- **Sensitivity & invert:** expose look sensitivity and invert-Y (see `input-systems`).
- **Cinemachine 3 (Unity 6.3 LTS):** a `CinemachineCamera` (namespace `Unity.Cinemachine`) with an
  **Orbital Follow** component and a **Cinemachine Deoccluder** (collision); the
  `CinemachineBrain` on the `Camera` blends between cameras. This replaces the v2
  `CinemachineVirtualCamera` / `CinemachineCollider` names.

## 4. First-person look

- Yaw rotates the body (so movement aligns with view); pitch rotates only the camera head.
- Clamp pitch; never let roll accumulate.
- Mouse: capture the cursor (`Input.mouse_mode = Input.MOUSE_MODE_CAPTURED`) and read
  `InputEventMouseMotion.screen_relative`, which is not scaled by the stretch settings.
- Stick: apply a response curve + deadzone (see `input-systems`) and frame-rate-scaled turn rate.

## 5. Multi-target / group framing

- Compute the bounding box of all targets; place the camera at the box center.
- **2D:** set zoom so the box (plus padding) fits the viewport; clamp zoom min/max.
- **3D:** dolly the camera back / adjust FOV to fit the box. In Cinemachine 3, point the camera's
  Tracking Target at a `CinemachineTargetGroup` and add `CinemachineGroupFraming`.
- **Split-screen:** one camera per player rendering to a viewport rectangle; budget the extra
  render cost (`performance-optimization`).

## 6. Cinematic blends & transitions

- Blend between gameplay and cutscene cameras over a short time (ease-in-out). Cinemachine blends
  automatically when you change the active camera's priority; in Godot, tween a rig between marker
  transforms or swap `current` cameras with a fade.
- Reset smoothing state on hard cuts/teleports so the camera doesn't slingshot across the map.

## 7. Per-engine rig summary

Unity column: Cinemachine 3.x, namespace `Unity.Cinemachine`. The v2 components (`CinemachineVirtualCamera`, `CinemachineCollider`,
`CinemachineFramingTransposer`) are marked deprecated in 3.x and point to `CinemachineCamera`,
`CinemachineDeoccluder` and `CinemachinePositionComposer`; do not use them in new code.
`CinemachineDeoccluder` keeps the target in line of sight; `CinemachineDecollider` only pulls the
camera out of geometry it intersects.

| Need | Godot 4.7 | Unity 6.3 LTS |
|------|-----------|---------|
| 2D follow + smoothing + limits | `Camera2D` (`position_smoothing_*`, `limit_*`, `drag_*`) | `CinemachineCamera` + `CinemachinePositionComposer` (Damping, Dead Zone, Lookahead) + `CinemachineConfiner2D` |
| 3D follow/orbit | pivot + `SpringArm3D` + `Camera3D` | `CinemachineCamera` + `CinemachineOrbitalFollow` + `CinemachineDeoccluder` (or `CinemachineDecollider`) |
| Shake | additive `offset` from `game-feel` | `CinemachineBasicMultiChannelPerlin` (noise); `CinemachineImpulseSource` + `CinemachineImpulseListener` (impacts) |
| Bounds | `limit_*` / manual clamp | `CinemachineConfiner2D/3D` |
| Group framing | manual bounding box + zoom | `CinemachineTargetGroup` + `CinemachineGroupFraming` |
| Addon option | `PhantomCamera` (declarative 2D/3D rigs) | built-in Cinemachine |


<!-- ===== END camera-systems/references/follow-and-framing.md ===== -->
