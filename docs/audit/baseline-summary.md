# U0 baseline audit: summary and fix list

Date 2026-11-25. Plan §C.6: baseline audit of the §C.2 surfaces before K0, with the fix list sized into K0 and K2.

Sheets: [screens](baseline-screens.md) · [battle HUD and keys](baseline-battle-hud.md) · [pen and camera](baseline-pen-camera.md) · [render feedback](baseline-render-feedback.md) · [template](TEMPLATE.md)

## Counts (static pass)
| Sheet | P0 | P1 | P2 | P3 |
|---|---|---|---|---|
| screens | 1 | 7 | 14 | 11 |
| battle HUD | 0 | 4 | 19 | 10 |
| pen & camera | 0 | 7 | 17 | 9 |
| render feedback | 0 | 9 | 11 | 5 |
| **total** | **1** | **27** | **61** | **35** |

## Runtime pass (live site, 2026-11-25)
The container has no local browser (browser downloads are disabled in this environment), so the runtime pass used a cloud browser against the published site, ayenbang0.github.io/War, at 1280x720. Findings:
- **RT-01 (P2)** The empty `#hud` box shows as a dark rectangle at the top left behind the home and setup screens.
- **RT-02 (P2)** Home and setup screens show two vertical scrollbars (page and panel) at 1280x720.
- **RT-03 (P1, confirms AB-01)** The default suggested army buys ten distinct reserves; the bar shows nine (keys 1–9) and the tenth cannot be reached.
- **RT-04 (P2)** At 1280x720 the ability bar covers the bottom ~110 px of the field, where the opening camera puts part of the player's own army.
- Resolutions above 1920x992, the 1080x2340 portrait size and 200% text zoom cannot be reproduced in that browser (its window is capped); they stay pending for U4.

## Hypotheses (§C.5)
| Hypothesis | Result |
|---|---|
| No `aria-*`, `tabindex`, `role` anywhere | confirmed (and `<html>` has no `lang`) |
| HUD/overlay type 11–13 px monospace on parchment | confirmed; menu labels go down to 10 px, canvas headcounts 9 px |
| No `prefers-reduced-motion` / `@media` | confirmed |
| Keyboard handling ad hoc | confirmed: three always-on window listeners mixing `e.code` and `e.key` |
| Overlapping key ownership | confirmed for Esc (stroke cancel vs tutorial reload) and for every key reaching the camera's held set; refuted for home/menu/chronicle (no listeners there) |
| Colour carries player/enemy identity | confirmed on the map (blue/red counters are 1.15:1 in luminance, identical in greyscale); refuted for the HUD |

## Fix list
**K0 (screen stack and input ownership)** — the refactor that removes the reloads fixes most of these by construction:
- BS-01 **P0** storage refused leaves the campaign stuck silently → the save layer reports failure and the game runs from memory with a visible notice.
- AA-01 / BS (reload on every return) → screens pop back instead of `location.reload()`.
- BS-02 menu has no Back / Esc · BS-03 "start over" without confirm · GK-01 / PC-06 / BS-04 Esc owned twice · BH-01 pause not shown · AB-01 / RT-03 abilities past key 9 unreachable · PC-01 advertised middle/right-drag pan missing · BS-05 tutorial can be ended by the clock or an attack · RT-01 empty HUD box visible behind screens.
- One keyboard router owned by the screen stack; `e.code` everywhere; keys ignored when a form control has focus.

**K2 (shared with the kingdom map)**:
- One scaling policy: 16 px minimum body text, 4.5:1 contrast, `lang`, `prefers-reduced-motion`, focus rings (BS-06, BS-07, BS-08, RT-02, RT-04).
- Pen feedback: a stroke that means nothing says so (PC-02); armed ability shows in the ghost (PC-03); deploy drag is not also a gesture and goes through the order queue (PC-04, PC-05); lasso ghost counts men (PC-07).
- Identity not by colour alone: enemy counters get a distinct outline/shape; one palette role per side for magic and shields (RF-01, RF-02).
- Fog honesty: one perception predicate for effects, bodies and enemy works; last-seen marks age on the sim clock (RF-03, RF-04, RF-05, RF-06); breaks shown on the map (RF-09).
- AI fairness: the battle AI judges strength and aims from what it can see, not from the player's orders (RF-07, RF-08). This moves the `world` golden hash.

P2 and P3 findings are batched into K11 as the plan says.

## K2 status

Findings fixed by K2 (branch `k2fix`). Anything not listed keeps its original owner.

| id | status | how |
|---|---|---|
| RT-02 | fixed in K2 (91ac90c) | one scroll region: overlays scroll, panels do not |
| RT-04 | fixed in K2 (91ac90c) | opening camera frames the army in the band above the ability bar; bar slots are one line |

The whole K2 fix list above is done in 91ac90c: BS-06, BS-07, BS-08, RT-02, RT-04, PC-02, PC-03, PC-04, PC-05, PC-07, RF-01 to RF-09 (see each sheet's K2 status). Also fixed in passing: FL-01, RF-10, RF-14, RF-19, BS-10, BS-30, and the `lang` part of BS-11. The `world` golden did not move after all, because neither golden scenario runs an AI player.
