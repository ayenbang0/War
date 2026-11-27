# UI policy: one scaling, text, contrast and motion rule

This is the policy that audit finding group K2 asked for (BS-06, BS-07, BS-08, RT-02, RT-04, and RF-14 for canvas text). The battle screens follow it, and the kingdom screens should too. `tools/ui-check.ts` ("ui policy") checks the stylesheet against it, and the e2e scenario `k2-text-floor` checks computed sizes in a real browser.

## Reference size and scaling

- **Reference viewport:** 1920 × 1080 CSS px. Layouts must also work at **1280 × 720**, and at **200 % browser zoom** on 1280 × 720 (an effective 640 × 360). At that size content reflows and nothing is cut off.
- **One unit: rem off the browser's root size.** `html { font-size: 100% }`, so the player's own browser text size and zoom are the game's text-size setting. There is no in-game scale slider and no root size tied to the viewport (`vw`). A root tied to the viewport would ignore the player's setting and shrink text on small windows. See PROVISIONAL K2f.4.
- DOM text sizes are rem values or the tokens `--text` (1rem) and `--text-lg` (1.125rem). **px font sizes are not allowed** in `src/style.css`.
- **Device pixel ratio:** the canvas backing store is `cssSize × min(devicePixelRatio, 2)` (`src/app/battle-layer.ts` `resize`), and drawing is in CSS px. Above 2× the extra fill cost buys nothing you can see. Menu unit icons are small fixed canvases and use up to 3×. DOM text needs no DPR handling.

## Minimum text sizes

| Where | Minimum | Notes |
|---|---|---|
| DOM body text, labels, buttons, HUD, ability bar, dialogs | **16 px** (1rem) | Section labels in capitals included. Nothing a player reads is smaller. |
| Headings | larger than body | 1.125–3.6rem |
| Canvas labels on the map (control-point names, last-seen headcounts) | **13 px** (`CANVAS_LABEL_MIN_PX`, `src/render/renderer.ts`) | Drawn with a pale halo (`haloText`), so they read over forest and water as well as parchment. Control-point names show at every zoom. |
| Pen ink labels (the ghost's reading and the reason for a refusal) | **14 px** (`LABEL_PX`, `src/render/ink.ts`) | Dark text on a light plate, so it is above 7:1 wherever the pen is. |

Canvas text has a lower floor than DOM text because it labels the map and is not prose, and because it scales with nothing the browser controls. The floor ensures it never shrinks with the camera zoom. Below the floor the label is held at the floor.

## Contrast

WCAG 2.x relative-luminance ratios. Inks are CSS custom properties in `:root` (`src/style.css`):

| Token | Value | Use | Worst panel ratio |
|---|---|---|---|
| `--ink` | `#3a3124` | body text | > 9:1 |
| `--ink-1` | `#5f5138` | secondary prose, disabled primary label | 5.07:1 on the disabled fill `#d9d1bd` |
| `--ink-2` | `#6d5c40` | captions, section labels, stats | 4.7:1 or better on every panel |
| `--friend` | `#30507c` | own side, primary buttons (text `#f4efe2` 7.1:1) | 5.1:1 |
| `--foe` | `#7a3029` | enemy side, errors | 6.9:1 |
| `--focus` | `#1f3f66` | focus ring | 3.2:1 even on the darkest panel border |

- **Text: 4.5:1** against the panel it sits on. **Large text (≥ 24 px, or ≥ 18.7 px bold) and UI glyphs: 3:1.**
- Translucent panels over the map (`.panel`, the HUD) are 0.92 opaque, so their text keeps its ratio over the darkest terrain.
- **State is never carried by colour or fade alone.** A disabled primary button is also dashed. An exhausted ability's name is struck through. On the map, the enemy has its own keyline and silhouette (below).

## Focus

`:focus-visible` draws a 3 px `--focus` ring, offset 2 px, over a 2 px pale halo (`--focus-halo`). Because it is two-tone, it holds 3:1 on parchment, on the blue primary buttons and over the map. It differs from hover in kind: hover changes the fill, and focus draws a ring. Mouse clicks do not show it.

## Scrolling and reflow

- **One scroll region per screen.** Each full-screen overlay (`.home`, `.menu`, `.after-action`, `.dialog`) scrolls. Its panel does not, and is centred with `margin: auto` under `align-items: flex-start`, so a tall panel is never cut off at the top. `html, body` stay `overflow: hidden`, so there is never a page scrollbar beside a panel scrollbar (RT-02).
- Rows that can be wider than the window wrap: action rows, figures, after-action columns and dialog buttons.
- The HUD wraps (`white-space: pre-wrap`, `max-width: min(34rem, 100vw − 24px)`). The lesson text is no longer hard-wrapped in code (BS-08).
- The battle opens with the player's army framed in the band above the ability bar (`BattleLayer.frameOpening`), not under it (RT-04). The bar is one line per slot, and the cooldown takes a second line only while there is one.

## Motion

- `prefers-reduced-motion: reduce` is honoured in both places that animate:
  - CSS: transitions and animations are cut to a single near-instant frame.
  - Canvas: `src/render/motion.ts` follows the media query live. When it is set, men do not fidget, rings and status glyphs do not pulse, effect flashes do not grow, and a refused stroke greys out and fades without the shake.
- **Game-time feedback runs on the sim clock**, not on the wall clock, so it holds still while the battle is paused. This covers last-seen marks, the fallen and enemy works memory. Only UI motion (pen ink, refusal fade) runs on real time.

## Identity: friend and foe

- Colours are **relative to the viewer**: `friend` blue `#30507c` and `foe` red `#aa4838` (`src/render/palette.ts` `colorFor`). These are never "player 0" and "player 1". Workings, mends, shields, fields, halos and held ground all use these two roles.
- Colour is never the only channel. Enemy men carry a pale keyline and a dark edge at every detailed zoom, and draw as diamonds at far zoom. Enemy last-seen marks are dashed. Ground the enemy holds gets a double ring.

## Fog: one perception rule

The renderer asks one question, "can the viewer see this?", through `src/render/perception.ts`. A soldier is seen if he is the viewer's own or carries the viewer's sight bit. Ground is observed if it is lit and in line of sight of one of the viewer's men. Effects, bodies, enemy works, workings and fields are drawn only where that rule says so. Lit ground that no one actually sees is shaded as remembered, not shown as clear.
