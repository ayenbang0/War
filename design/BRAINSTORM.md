# Brainstorm: new content for War, Alien-style

This note records how the second roster, the new battlefields and the campaign
were chosen, and how each idea could be tested.

## What was and was not run

The method is the one in
[alejandrohdez00/alien-space-of-science](https://github.com/alejandrohdez00/alien-space-of-science)
(paper: *The Alien Space of Science*, arXiv:2603.01092). It breaks a field into
small "idea atoms", samples combinations of them, and ranks each combination by
two scores. **Coherence** asks whether the parts make sense together.
**Unavailability** asks whether any single author already holds most of the
combination. The fused score is

    fused = (1 - beta) * z(coherence) + beta * z(unavailability),   beta = 0.7

with both scores z-scored over the whole candidate pool. The formula matches
`generation/sample.py` in that repository.

**What was not done.** The released models and data were not downloaded or run.
That is about 358 MB of models plus data tarballs, and they are trained on about
16,000 LLM research papers, so their atoms are ML-research ideas, not game
design. Rebuilding the pipeline for games would need paid LLM calls. Neither was
done without Ayden's yes.

**What was done instead.** The repository's selection step was applied by hand
to War's own design space:

- `design/alien/atoms.json` holds 38 hand-written game-design atoms, each with
  tags and a commonness estimate. **The commonness values are my judgment
  (speculation), not measurements.**
- Eight reference games stand in for the paper's "authors". A combination counts
  as available when one of them already has most of it. Their feature lists are
  limited to what the sources below support.
- `design/alien/brainstorm.py` (standard library only) scores every 3-atom
  combination, 8,436 of them, with a tag-overlap coherence heuristic and the
  availability above, fuses them with beta = 0.7, then keeps the top sets with
  each atom used once (a diversity pass that the paper does not have).
  Run it with `python3 design/alien/brainstorm.py`; the output is
  `design/alien/results.json`.

So the ranking below is the paper's workflow with hand-made stand-ins for its
two learned models. It is a structured brainstorm, not a reproduction of the
paper's results.

## Evidence for claims about prior work

The availability score rests on what these sources say the reference games do.

| Reference | Atoms credited | Source |
|---|---|---|
| Total War series | army morale, flank and rear shock, panic spreading, rallying | Total War Warhammer wiki, "Break": totalwarwarhammer.gamepedia.com/Break |
| Ultimate General: Gettysburg | orders drawn as paths, morale from flanks and losses, units that carry over | store page: gog.com/en/game/ultimate_general_gettysburg |
| Black & White | spells cast by drawing gestures | Wikipedia, "Black & White (video game)" |
| Into the Breach | enemy intent shown before it acts | Game Informer review |
| The Banner Saga | caravan to protect, costly choices, heroes lost for good | bannersaga.fandom.com/wiki/Caravan; PC Gamer review |
| Darkest Dungeon | a breaking point that can turn into heroism (affliction or virtue at 100 stress) | darkestdungeon.wiki.gg, Affliction and Virtue pages |
| Battle Brothers | a persistent company with permadeath | Wikipedia, "Battle Brothers" |
| War itself, before this change | fog with last sightings, pen orders, fieldworks, reinforcements, and more | this repo's README, PLAN and `src/content` |

Where this note says a combination is "less explored", it means only that none
of these eight holds most of it. **That is not a survey of all games, so every
"less explored" below is speculation within that limit.**

## The ranked ideas

Fused scores are from `results.json`. For each: the parts, why they fit, why the
combination is less explored, and a concrete test.

### 1. Champions, parley and desertion (fused +3.54)

- **Parts:** a duel of champions that sways both armies' nerve; parley and
  surrender instead of fighting to the last; beaten men who desert.
- **Why it coheres:** all three turn a battle on nerve rather than numbers. A
  champion falling is the moment a parley gets offered and men start slipping
  away.
- **Why less explored:** the reference games treat morale as a bar that empties
  (Total War's "Break"). None of the eight lets a single fight or a truce decide
  it. *(Speculation, see the limit above.)*
- **Test:** in the headless sim, give one side a champion and measure how often
  the foe breaks within 30 seconds of the champion's challenge, against the same
  battle without it. If it never changes the outcome, the challenge is
  decoration.
- **Built:** the `champion` company and its `challenge` special (a blow to enemy
  nerve within 140 units, and harder strikes), and the `parley` ability (a
  ground where nobody strikes). Desertion was not built.

### 2. Weather, rising water and seasons (+2.50)

- **Parts:** a weather front crossing mid-battle; a river that rises on a clock;
  seasons changing the ground over a campaign.
- **Why it coheres:** all three make the map itself a clock. The player has to
  be on the right side of the ground when it changes.
- **Why less explored:** none of the eight reference games changes its terrain
  on a timer during a battle. *(Speculation.)*
- **Test:** on The Rising Water, count how many of the player's men are
  stranded on the far bank at seven minutes across 20 AI-vs-AI runs. If the
  number is near zero or near everyone, the warning or the timing is wrong.
- **Built:** the flood (bridges and marsh turn to water at a set second, and
  companies reroute) and The Rising Water battlefield. Weather and seasons were
  not built.

### 3. Colours, drums and war beasts (+2.41)

- **Parts:** a standard-bearer whose banner steadies nearby men; war drums that
  set the pace in earshot; war beasts that terrify horses.
- **Why it coheres:** each is an aura that works on nerve or pace rather than
  hit points, so they read and play as one family.
- **Why less explored:** Total War has morale auras around generals, but none of
  the eight pairs a colour party with drums and horse-specific terror.
  *(Speculation.)*
- **Test:** `tools/content-check.ts` already checks that a banner raises a
  wavering company's nerve, drums quicken a march, and hounds shake horses more
  than foot. A play test would ask whether players protect the banner without
  being told to.
- **Built:** the `banner`, `drummer` and `hounds` companies with `rally`,
  `cadence` and `terror`, and the "Take the colours" way to win, where losing
  your colour party loses the battle.

### 4. Couriers, a map drawn as you scout, and running ink (+1.70)

- **Parts:** orders carried by riders who can be cut down; a map drawn as you
  scout; orders that smudge when the commander's nerve fails.
- **Why it coheres:** all three are about information being physical and
  fragile, which suits War's pen controls.
- **Why less explored:** none of the eight delays or degrades orders.
  *(Speculation.)*
- **Test:** add a courier delay to the order queue in a branch and compare how
  often AI-vs-AI pincers succeed with and without it.
- **Built:** not yet. It needs changes to the order queue and the gesture
  recognizer, which this work did not touch.

### 5. Letters, a hostage and wrong scout reports (+1.53)

- **Parts:** a named commander whose story is told in letters; a hostage to
  recover; scout reports that can be wrong.
- **Why it coheres:** each makes the war personal and uncertain between
  battles.
- **Why less explored:** The Banner Saga has a written story and costly
  choices, but not deliberately false intelligence. *(Speculation.)*
- **Test:** in play tests, ask after chapter 6 whether players believed the
  forged report, and whether finding out changed how they read later letters.
- **Built:** the campaign, *The Marchwarden's Chronicle*. Nine battles, letters
  before each, a chronicler's entry after, one fork, a forged scout report
  before The Standing Stones, and an epilogue shaped by the record. The hostage
  was not built.

### 6. Night, standing stones and the fallen (+1.23)

- **Parts:** night falling so sight shrinks; standing stones that strengthen
  magic; the dead left on the field.
- **Why it coheres:** it is one eerie battlefield, and each part changes what the
  player can see or trust.
- **Why less explored:** none of the eight combines a night battle with places
  of power. *(Speculation.)*
- **Test:** on Night at the Stones, measure how often each side's first contact
  is an ambush compared with the same map by day.
- **Built:** night (sight scaled down, with a cold wash over the field), The
  Standing Stones battlefield with magic at 1.5, and the fallen, who now lie
  where they died instead of vanishing.

### 7. Panic, a breaking point that turns to heroism, feigned retreat (+0.99)

- **Parts:** panic spreading between companies; a breaking point that can turn
  to heroism; a feigned retreat.
- **Why it coheres:** all three are about the moment a company nearly breaks.
- **Why less explored:** Darkest Dungeon has the affliction-or-virtue turn, but
  for a party of heroes, not an army. *(Speculation.)*
- **Test:** count how often oathsworn hold after their last stand in AI-vs-AI
  runs, against line infantry in the same spot.
- **Built:** the `oathsworn` and their `lastStand`, a once-a-battle floor on
  nerve with harder strikes. War already had feints.

### 8. Rally, an escort column and a pincer (+0.30)

- **Built:** the pincer, as hounds and lancers arriving round both ends of the
  line on The Rising Water, and the "Get through" way to win on The Ferry Road,
  which plays like an escort. Rallying broken companies already existed.

Ideas 9 and 10 (shown intent with battle-as-history and a costly choice, and
glyph spells with veterans and fieldworks) scored low because War or a single
reference game already holds most of each. The campaign's fork and its
after-battle chronicle borrow from idea 9 anyway.

## What else came out of it

The companies not tied to a ranked idea came from filling gaps the brainstorm
exposed in the roster: something to stop a charge (pikes), something to stand
and shoot from cover (crossbows with pavises), a charge that rewards distance
(lancers with a couched lance), cheap missiles (slingers) and a mobile fort
(wagons in a laager).
