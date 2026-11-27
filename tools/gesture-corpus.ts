/**
 * Synthetic stroke corpus for the gesture confusion matrix.
 *
 * Per-case tests hide exactly the failures that matter here: the three pairs
 * that collide (hold/patrol, formation/hold, move/retreat) only show up when
 * every gesture is classified against every label at once. Strokes carry mouse
 * jitter on purpose -- this game is mouse-first, and a clean synthetic circle is
 * not what a mouse produces.
 */

import type { Point, GestureContext, SquadView } from "../src/input/gestures.ts";
import { formationSlots, formationRadius } from "../src/sim/formations.ts";
import { UNIT_TYPES } from "../src/content/unit-types.ts";
import { KingdomWorld } from "../src/sim/kingdom/world.ts";
import { KingdomCamera, OPENING_MILES } from "../src/render/kingdom/camera.ts";
import { kingdomContext } from "../src/input/kingdom-commander.ts";
import type { KingdomGestureContext } from "../src/input/kingdom-gestures.ts";
import { kingCounterAt } from "../src/render/kingdom/layout.ts";
import { armyCounters, armyPointsOf } from "../src/input/kingdom-commander.ts";
import { raiseArmy } from "../src/sim/kingdom/armies.ts";

export type Case = {
  readonly expected: string;
  readonly points: Point[];
  readonly ctx: GestureContext;
  readonly note: string;
};

/** Reproducible jitter. A flaky corpus is worse than no corpus. */
function makeRng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (((t ^ (t >>> 15)) >>> 0) / 4294967296) * 2 - 1;
  };
}

const FRIEND_X = 1000;
const FRIEND_Y = 1000;
const ENEMY_X = 1900;
const ENEMY_Y = 1000;
const HOME_X = 0;

function squadRadius(type: keyof typeof UNIT_TYPES): number {
  const spec = UNIT_TYPES[type];
  const slots = new Float64Array(spec.soldiers * 2);
  formationSlots(spec.defaultShape, spec.soldiers, slots);
  return formationRadius(slots, spec.soldiers);
}

const R = squadRadius("line");

function context(facing: number): GestureContext {
  const squads: SquadView[] = [
    { id: 1, player: 0, x: FRIEND_X, y: FRIEND_Y, radius: R, size: 20, facing, visible: true },
    { id: 2, player: 1, x: ENEMY_X, y: ENEMY_Y, radius: R, size: 20, facing: Math.PI, visible: true },
  ];
  return { player: 0, squads, selected: [1], homeX: HOME_X };
}

/**
 * A GROUP context: four friendly squads spread out, all selected. The group
 * verbs only unlock here, so every group case is classified against a scene
 * where the single-squad table is also live -- which is the point.
 */
function groupContext(pending: { a: Point; b: Point } | null = null): GestureContext {
  const squads: SquadView[] = [
    { id: 1, player: 0, x: FRIEND_X - 150, y: FRIEND_Y - 150, radius: R, size: 20, facing: 0, visible: true },
    { id: 2, player: 0, x: FRIEND_X + 150, y: FRIEND_Y - 150, radius: R, size: 20, facing: 0, visible: true },
    { id: 3, player: 0, x: FRIEND_X - 150, y: FRIEND_Y + 150, radius: R, size: 20, facing: 0, visible: true },
    { id: 4, player: 0, x: FRIEND_X + 150, y: FRIEND_Y + 150, radius: R, size: 20, facing: 0, visible: true },
    { id: 9, player: 1, x: ENEMY_X, y: ENEMY_Y, radius: R, size: 20, facing: Math.PI, visible: true },
  ];
  return { player: 0, squads, selected: [1, 2, 3, 4], homeX: HOME_X, pendingLine: pending };
}

/** A heart, parameterised so the corpus can vary its size and lean. */
function heart(cx: number, cy: number, size: number, rot: number, steps: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    // Classic parametric heart, scaled into world units.
    const hx = 16 * Math.sin(t) * Math.sin(t) * Math.sin(t);
    const hy = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
    const sx = (hx / 16) * size;
    const sy = (hy / 16) * size;
    const c = Math.cos(rot);
    const s2 = Math.sin(rot);
    out.push({ x: cx + sx * c - sy * s2, y: cy + sx * s2 + sy * c });
  }
  return out;
}

/** Resample a polyline to n points and add jitter, the way a mouse drag looks. */
function stroke(verts: Point[], n: number, jitter: number, rnd: () => number): Point[] {
  const segs: number[] = [0];
  let total = 0;
  for (let i = 1; i < verts.length; i++) {
    total += Math.hypot(verts[i].x - verts[i - 1].x, verts[i].y - verts[i - 1].y);
    segs.push(total);
  }
  const out: Point[] = [];
  for (let k = 0; k < n; k++) {
    const d = (k / (n - 1)) * total;
    let i = 1;
    while (i < segs.length - 1 && segs[i] < d) i++;
    const t = segs[i] === segs[i - 1] ? 0 : (d - segs[i - 1]) / (segs[i] - segs[i - 1]);
    out.push({
      x: verts[i - 1].x + (verts[i].x - verts[i - 1].x) * t + rnd() * jitter,
      y: verts[i - 1].y + (verts[i].y - verts[i - 1].y) * t + rnd() * jitter,
    });
  }
  return out;
}

function rot(p: Point, about: Point, a: number): Point {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = p.x - about.x;
  const dy = p.y - about.y;
  return { x: about.x + dx * c - dy * s, y: about.y + dx * s + dy * c };
}

function circle(cx: number, cy: number, r: number, from: number, turns: number, steps: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + (i / steps) * Math.PI * 2 * turns;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
}

export function buildCorpus(): Case[] {
  const rnd = makeRng(0x9e3779b9);
  const cases: Case[] = [];
  const J = 2.5;
  const here = { x: FRIEND_X, y: FRIEND_Y };

  // -- select: a tap on the squad ------------------------------------------
  for (let i = 0; i < 8; i++) {
    const ctx = context(0);
    const jx = FRIEND_X + (i - 4) * 3;
    const jy = FRIEND_Y + (i % 3) * 2;
    cases.push({
      expected: "select",
      note: "tap on own squad",
      ctx,
      points: stroke([{ x: jx, y: jy }, { x: jx + 4, y: jy + 3 }], 6, 1.2, rnd),
    });
  }

  // -- move: away from home, or lateral ------------------------------------
  const moveDirs = [0, -0.6, 0.6, Math.PI / 2, -Math.PI / 2, 0.3, -0.3, 1.2, -1.2, 0.9];
  for (let i = 0; i < moveDirs.length; i++) {
    const ctx = context(0);
    const len = 380 + (i % 4) * 190;
    const a = moveDirs[i];
    cases.push({
      expected: "move",
      note: "line out at " + a.toFixed(2) + " rad",
      ctx,
      points: stroke(
        [here, { x: FRIEND_X + Math.cos(a) * len, y: FRIEND_Y + Math.sin(a) * len }],
        40,
        J,
        rnd,
      ),
    });
  }
  // A dog-legged move: two straight legs, still a move.
  for (let i = 0; i < 3; i++) {
    const ctx = context(0);
    cases.push({
      expected: "move",
      note: "dog-leg march",
      ctx,
      points: stroke(
        [here, { x: FRIEND_X + 350, y: FRIEND_Y - 260 - i * 40 }, { x: FRIEND_X + 700, y: FRIEND_Y + 120 }],
        50,
        J,
        rnd,
      ),
    });
  }

  // -- attack: ends on the enemy -------------------------------------------
  for (let i = 0; i < 8; i++) {
    const ctx = context(0);
    const offset = (i - 4) * 14;
    cases.push({
      expected: "attack",
      note: "charge ending on enemy",
      ctx,
      points: stroke(
        [here, { x: ENEMY_X + offset, y: ENEMY_Y + offset * 0.6 }],
        45,
        J,
        rnd,
      ),
    });
  }
  // Curved approach that still terminates on the enemy.
  for (let i = 0; i < 3; i++) {
    const ctx = context(0);
    cases.push({
      expected: "attack",
      note: "flanking arc onto enemy",
      ctx,
      points: stroke(
        [here, { x: 1400, y: FRIEND_Y - 300 - i * 60 }, { x: ENEMY_X, y: ENEMY_Y - 10 }],
        50,
        J,
        rnd,
      ),
    });
  }

  return cases.concat(shapeCases(rnd, J)).concat(groupCases());
}

function shapeCases(rnd: () => number, J: number): Case[] {
  const cases: Case[] = [];
  const here = { x: FRIEND_X, y: FRIEND_Y };

  // -- hold: a tight loop drawn out on the map -----------------------------
  for (let i = 0; i < 8; i++) {
    const ctx = context(0);
    const cx = FRIEND_X + 320 + (i % 3) * 90;
    const cy = FRIEND_Y + (i - 4) * 55;
    const r = 85 + (i % 4) * 30;
    cases.push({
      expected: "hold",
      note: "loop of radius " + r + " away from squad",
      ctx,
      points: stroke(circle(cx, cy, r, i * 0.4, 1, 28), 42, J, rnd),
    });
  }

  // -- patrol: a large circuit ---------------------------------------------
  for (let i = 0; i < 5; i++) {
    const ctx = context(0);
    const r = 460 + i * 90;
    cases.push({
      expected: "patrol",
      note: "circuit of radius " + r,
      ctx,
      points: stroke(circle(FRIEND_X + 200, FRIEND_Y, r, i * 0.5, 1, 40), 70, J, rnd),
    });
  }
  // A polygonal beat between distant posts, closing back on itself.
  for (let i = 0; i < 4; i++) {
    const ctx = context(0);
    const s = 520 + i * 110;
    cases.push({
      expected: "patrol",
      note: "polygonal beat, span " + s,
      ctx,
      points: stroke(
        [
          here,
          { x: FRIEND_X + s, y: FRIEND_Y - 120 },
          { x: FRIEND_X + s - 60, y: FRIEND_Y + s * 0.7 },
          { x: FRIEND_X - 40, y: FRIEND_Y + 160 },
          here,
        ],
        80,
        J,
        rnd,
      ),
    });
  }

  // -- retreat: back toward home and away from the enemy -------------------
  const backDirs = [Math.PI, Math.PI - 0.5, Math.PI + 0.5, Math.PI - 0.9, Math.PI + 0.9];
  for (let i = 0; i < backDirs.length; i++) {
    const ctx = context(0);
    const len = 320 + (i % 3) * 160;
    const a = backDirs[i];
    cases.push({
      expected: "retreat",
      note: "fall back at " + a.toFixed(2) + " rad",
      ctx,
      points: stroke(
        [here, { x: FRIEND_X + Math.cos(a) * len, y: FRIEND_Y + Math.sin(a) * len }],
        40,
        J,
        rnd,
      ),
    });
  }
  for (let i = 0; i < 3; i++) {
    const ctx = context(0);
    cases.push({
      expected: "retreat",
      note: "withdraw with a bend",
      ctx,
      points: stroke(
        [here, { x: FRIEND_X - 220, y: FRIEND_Y + 150 + i * 50 }, { x: FRIEND_X - 520, y: FRIEND_Y + 60 }],
        50,
        J,
        rnd,
      ),
    });
  }

  // -- formation glyphs, drawn centred on the squad ------------------------
  // Facings are varied so the line/column split is genuinely tested against
  // the squad's own axis rather than against world axes.
  const facings = [0, 0.6, 1.4, 2.3, 3.0, -0.8, -1.9];

  for (const facing of facings) {
    const ctx = context(facing);
    // line: a stroke across the squad's front (perpendicular to facing)
    const perp = facing + Math.PI / 2;
    const half = 62;
    cases.push({
      expected: "formation:line",
      note: "abreast stroke at facing " + facing.toFixed(2),
      ctx,
      points: stroke(
        [
          { x: FRIEND_X - Math.cos(perp) * half, y: FRIEND_Y - Math.sin(perp) * half },
          { x: FRIEND_X + Math.cos(perp) * half, y: FRIEND_Y + Math.sin(perp) * half },
        ],
        30,
        J,
        rnd,
      ),
    });
    // column: a stroke along the squad's axis
    cases.push({
      expected: "formation:column",
      note: "axial stroke at facing " + facing.toFixed(2),
      ctx,
      points: stroke(
        [
          { x: FRIEND_X - Math.cos(facing) * half, y: FRIEND_Y - Math.sin(facing) * half },
          { x: FRIEND_X + Math.cos(facing) * half, y: FRIEND_Y + Math.sin(facing) * half },
        ],
        30,
        J,
        rnd,
      ),
    });
    // wedge: a chevron pointing along facing
    const tip = { x: FRIEND_X + Math.cos(facing) * 52, y: FRIEND_Y + Math.sin(facing) * 52 };
    const backL = rot({ x: FRIEND_X - 46, y: FRIEND_Y - 52 }, here, facing);
    const backR = rot({ x: FRIEND_X - 46, y: FRIEND_Y + 52 }, here, facing);
    cases.push({
      expected: "formation:wedge",
      note: "chevron at facing " + facing.toFixed(2),
      ctx,
      points: stroke([backL, tip, backR], 34, J, rnd),
    });
    // square: a closed box on the squad
    const corners = [
      rot({ x: FRIEND_X - 52, y: FRIEND_Y - 52 }, here, facing),
      rot({ x: FRIEND_X + 52, y: FRIEND_Y - 52 }, here, facing),
      rot({ x: FRIEND_X + 52, y: FRIEND_Y + 52 }, here, facing),
      rot({ x: FRIEND_X - 52, y: FRIEND_Y + 52 }, here, facing),
    ];
    cases.push({
      expected: "formation:square",
      note: "box at facing " + facing.toFixed(2),
      ctx,
      points: stroke([...corners, corners[0]], 48, J, rnd),
    });
  }

  return cases;
}

/**
 * Group verbs. Every case here is drawn in a scene where four squads are
 * selected, so the classifier has to choose between the group vocabulary and
 * the single-squad one rather than being handed the answer.
 */
export function groupCases(): Case[] {
  const rnd = makeRng(0x51ab3f0d);
  const cases: Case[] = [];
  const J = 2.5;

  // -- recover: a heart drawn on open ground -------------------------------
  for (let i = 0; i < 8; i++) {
    const size = 190 + (i % 4) * 60;
    const rot = (i - 4) * 0.14;
    cases.push({
      expected: "recover",
      note: "heart size " + size + " rot " + rot.toFixed(2),
      ctx: groupContext(),
      points: stroke(heart(FRIEND_X + 500, FRIEND_Y, size, rot, 46), 64, J, rnd),
    });
  }

  // -- patrolArea: a large ring --------------------------------------------
  for (let i = 0; i < 6; i++) {
    const r = 440 + i * 85;
    cases.push({
      expected: "patrolArea",
      note: "area ring radius " + r,
      ctx: groupContext(),
      points: stroke(circle(FRIEND_X + 250, FRIEND_Y, r, i * 0.5, 1, 44), 72, J, rnd),
    });
  }

  // -- hold still wins for a small loop, even with a group selected --------
  for (let i = 0; i < 5; i++) {
    const r = 90 + i * 25;
    cases.push({
      expected: "hold",
      note: "small loop radius " + r + " with a group selected",
      ctx: groupContext(),
      points: stroke(circle(FRIEND_X + 620, FRIEND_Y + 60, r, i * 0.3, 1, 30), 44, J, rnd),
    });
  }

  // -- split: one straight cut across the group ----------------------------
  const cuts = [
    [FRIEND_X, FRIEND_Y - 420, FRIEND_X, FRIEND_Y + 420],
    [FRIEND_X - 420, FRIEND_Y, FRIEND_X + 420, FRIEND_Y],
    [FRIEND_X - 380, FRIEND_Y - 380, FRIEND_X + 380, FRIEND_Y + 380],
    [FRIEND_X + 380, FRIEND_Y - 380, FRIEND_X - 380, FRIEND_Y + 380],
    [FRIEND_X, FRIEND_Y + 420, FRIEND_X, FRIEND_Y - 420],
    [FRIEND_X - 430, FRIEND_Y - 60, FRIEND_X + 430, FRIEND_Y + 60],
  ];
  for (const c of cuts) {
    cases.push({
      expected: "split",
      note: "cut through the group",
      ctx: groupContext(),
      points: stroke([{ x: c[0], y: c[1] }, { x: c[2], y: c[3] }], 34, J, rnd),
    });
  }

  // -- grid: a second line parallel to one already held --------------------
  const rails = [
    [FRIEND_X - 300, FRIEND_Y - 200, FRIEND_X + 300, FRIEND_Y - 200, FRIEND_X - 300, FRIEND_Y + 60, FRIEND_X + 300, FRIEND_Y + 60],
    [FRIEND_X - 260, FRIEND_Y - 260, FRIEND_X + 260, FRIEND_Y - 60, FRIEND_X - 260, FRIEND_Y + 40, FRIEND_X + 260, FRIEND_Y + 240],
    [FRIEND_X - 200, FRIEND_Y + 300, FRIEND_X - 200, FRIEND_Y - 300, FRIEND_X + 90, FRIEND_Y + 300, FRIEND_X + 90, FRIEND_Y - 300],
    [FRIEND_X - 330, FRIEND_Y - 120, FRIEND_X + 330, FRIEND_Y - 300, FRIEND_X - 330, FRIEND_Y + 150, FRIEND_X + 330, FRIEND_Y - 30],
    [FRIEND_X + 300, FRIEND_Y - 220, FRIEND_X - 300, FRIEND_Y - 220, FRIEND_X - 300, FRIEND_Y + 80, FRIEND_X + 300, FRIEND_Y + 80],
  ];
  for (const r of rails) {
    cases.push({
      expected: "grid",
      note: "second rail parallel to the held one",
      ctx: groupContext({ a: { x: r[0], y: r[1] }, b: { x: r[2], y: r[3] } }),
      points: stroke([{ x: r[4], y: r[5] }, { x: r[6], y: r[7] }], 34, J, rnd),
    });
  }

  // -- the subject rule must still win: a line STARTED on a squad is a move,
  //    even with a group selected, or a group could never be sent anywhere.
  for (let i = 0; i < 5; i++) {
    const a = 0.4 - i * 0.2;
    cases.push({
      expected: "move",
      note: "line begun on a squad while a group is selected",
      ctx: groupContext(),
      points: stroke(
        [
          { x: FRIEND_X + 150, y: FRIEND_Y - 150 },
          { x: FRIEND_X + 150 + Math.cos(a) * 620, y: FRIEND_Y - 150 + Math.sin(a) * 620 },
        ],
        40,
        J,
        rnd,
      ),
    });
  }

  return cases.concat(splitAndRecoverCases());
}

/**
 * Adversarial cases for the two verbs reported as colliding.
 *
 * Split and recover are the two most easily stolen readings in the vocabulary.
 * A split is a straight open stroke, which is also what a move and a column
 * glyph look like; a recover is a large closed stroke, which is also what a
 * patrol area and a hold look like -- and heart-versus-ring is decided by a
 * hull-fill margin of only about 0.05.
 *
 * Every case below is classified in a scene where the thing it could be
 * MISTAKEN for is also legal: a heart with the group verbs live so patrolArea
 * competes for it, a cut with the enemy on the board so attack competes for it.
 * A corpus that tests a gesture where nothing else could win hands over the
 * answer.
 */
export function splitAndRecoverCases(): Case[] {
  const rnd = makeRng(0x2f9a71c3);
  const cases: Case[] = [];
  const J = 2.5;

  // -- recover, drawn small: over span > scale but under the hold span, which
  //    is the band where hold competes for it.
  for (let i = 0; i < 6; i++) {
    const size = 95 + i * 18;
    cases.push({
      expected: "recover",
      note: "small heart size " + size + ", hold competing",
      ctx: groupContext(),
      points: stroke(heart(FRIEND_X + 520, FRIEND_Y - 40, size, (i - 3) * 0.1, 44), 60, J, rnd),
    });
  }

  // -- recover with only ONE squad selected. Gating this behind "two or more
  //    selected" is what made recover unusable on the single battered company
  //    you actually wanted to stand down.
  for (let i = 0; i < 5; i++) {
    const size = 170 + i * 45;
    cases.push({
      expected: "recover",
      note: "heart with a single squad selected",
      ctx: context(0),
      points: stroke(heart(FRIEND_X + 430, FRIEND_Y, size, (i - 2) * 0.18, 46), 62, J, rnd),
    });
  }

  // -- recover drawn ON TOP of the group. A heart over your own line begins on
  //    a squad, so this is where the anchor rule and the formation glyph both
  //    get their chance to steal it.
  for (let i = 0; i < 5; i++) {
    const size = 210 + i * 55;
    cases.push({
      expected: "recover",
      note: "heart drawn over the group itself",
      ctx: groupContext(),
      points: stroke(heart(FRIEND_X, FRIEND_Y, size, (i - 2) * 0.12, 46), 66, J, rnd),
    });
  }

  // -- recover drawn hastily. Heavy jitter and few sample points is what a fast
  //    mouse drag produces, and it pushes a heart's hull fill UP toward the
  //    ring threshold.
  for (let i = 0; i < 5; i++) {
    const size = 230 + i * 50;
    cases.push({
      expected: "recover",
      note: "hasty heart, heavy jitter",
      ctx: groupContext(),
      points: stroke(heart(FRIEND_X + 480, FRIEND_Y + 120, size, (i - 2) * 0.2, 34), 30, 9, rnd),
    });
  }

  // -- the dangerous direction: a LUMPY ring must stay a patrol area. A shaky
  //    hand lowers a ring's hull fill, and low fill is the whole heart test.
  for (let i = 0; i < 6; i++) {
    const r = 430 + i * 70;
    const verts: Point[] = [];
    for (let k = 0; k <= 40; k++) {
      const a = (k / 40) * Math.PI * 2;
      const rr = r * (1 + Math.sin(a * 3 + i) * 0.11 + Math.sin(a * 7) * 0.05);
      // Centred well clear of the enemy: a ring that happens to END on an enemy
      // is an attack, and rightly so, which would test nothing about hull fill.
      verts.push({ x: FRIEND_X - 170 + Math.cos(a) * rr, y: FRIEND_Y + Math.sin(a) * rr });
    }
    cases.push({
      expected: "patrolArea",
      note: "lumpy ring radius " + r + " must not read as a heart",
      ctx: groupContext(),
      points: stroke(verts, 70, 7, rnd),
    });
  }

  // -- a lumpy ring with ONE squad selected is an ordinary patrol, not recover.
  for (let i = 0; i < 4; i++) {
    const r = 300 + i * 90;
    const verts: Point[] = [];
    for (let k = 0; k <= 40; k++) {
      const a = (k / 40) * Math.PI * 2;
      const rr = r * (1 + Math.sin(a * 4 + i) * 0.1);
      verts.push({ x: FRIEND_X - 140 + Math.cos(a) * rr, y: FRIEND_Y + Math.sin(a) * rr });
    }
    cases.push({
      expected: "patrol",
      note: "lumpy ring, single squad selected",
      ctx: context(0),
      points: stroke(verts, 66, 6, rnd),
    });
  }

  // -- split at many angles, none beginning on a squad ---------------------
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI;
    const dx = Math.cos(a) * 430;
    const dy = Math.sin(a) * 430;
    cases.push({
      expected: "split",
      note: "cut at " + a.toFixed(2) + " rad",
      ctx: groupContext(),
      points: stroke(
        [{ x: FRIEND_X - dx, y: FRIEND_Y - dy }, { x: FRIEND_X + dx, y: FRIEND_Y + dy }],
        34, J, rnd,
      ),
    });
  }

  // -- a cut passing CLOSE to a squad without beginning on it. A few pixels is
  //    how the formation reading used to steal a split.
  for (let i = 0; i < 5; i++) {
    const off = 70 + i * 22;
    cases.push({
      expected: "split",
      note: "cut passing " + off + " from a squad",
      ctx: groupContext(),
      points: stroke(
        [
          { x: FRIEND_X - 150 + off, y: FRIEND_Y - 430 },
          { x: FRIEND_X - 150 + off, y: FRIEND_Y + 430 },
        ],
        34, J, rnd,
      ),
    });
  }

  // -- a straight stroke ending on the enemy is an ATTACK even with a group
  //    selected. Hard evidence beats shape, or ordering a group to charge
  //    would cut it in half instead.
  for (let i = 0; i < 5; i++) {
    const off = (i - 2) * 16;
    cases.push({
      expected: "attack",
      note: "group charge, straight onto the enemy",
      ctx: groupContext(),
      points: stroke(
        [{ x: FRIEND_X + 200, y: FRIEND_Y + off }, { x: ENEMY_X + off, y: ENEMY_Y + off * 0.5 }],
        44, J, rnd,
      ),
    });
  }

  // -- a straight stroke drawn clean THROUGH your own company is a MARCH.
  //    There is no cutting gesture any more: carving a company in two is done
  //    by looping round the half you want, which works on men rather than on
  //    shapes. These cases exist to pin that a line across your own men does
  //    the ordinary, expected thing rather than something surprising.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI;
    // Always run the stroke AWAY from home. Half these angles pointed back
    // toward the friendly edge, which with an enemy in sight is a withdrawal --
    // correctly read as one, and nothing to do with what this case is pinning.
    const dx = Math.abs(Math.cos(a)) * 300;
    const dy = Math.sin(a) * 300;
    cases.push({
      expected: "move",
      note: "line through a single selected group at " + a.toFixed(2) + " rad",
      ctx: context(0),
      points: stroke(
        [{ x: FRIEND_X - dx, y: FRIEND_Y - dy }, { x: FRIEND_X + dx, y: FRIEND_Y + dy }],
        34, J, rnd,
      ),
    });
  }

  // -- and the whole reason the span test exists: with one group selected, a
  //    straight line drawn in OPEN GROUND is a march, not a cut. This is the
  //    commonest stroke in the game and it must never carve up the group.
  const marches = [
    [FRIEND_X + 300, FRIEND_Y - 380, FRIEND_X + 820, FRIEND_Y - 380],
    [FRIEND_X + 260, FRIEND_Y + 300, FRIEND_X + 900, FRIEND_Y + 520],
    [FRIEND_X - 350, FRIEND_Y + 330, FRIEND_X + 250, FRIEND_Y + 700],
    [FRIEND_X + 200, FRIEND_Y - 600, FRIEND_X + 700, FRIEND_Y - 250],
  ];
  for (const m of marches) {
    cases.push({
      expected: "move",
      note: "straight march clear of the group, one group selected",
      ctx: context(0),
      points: stroke([{ x: m[0], y: m[1] }, { x: m[2], y: m[3] }], 36, J, rnd),
    });
  }

  // -- a line that stops SHORT of the group has not cut it. Both endpoints sit
  //    outside the footprint, so only the segment test separates this from a
  //    genuine cut.
  for (let i = 0; i < 4; i++) {
    const gapFromCentre = 150 + i * 60;
    cases.push({
      expected: "move",
      note: "line stopping " + gapFromCentre + " short of the group",
      ctx: context(0),
      points: stroke(
        [
          { x: FRIEND_X - 620, y: FRIEND_Y - gapFromCentre },
          { x: FRIEND_X - 200, y: FRIEND_Y - gapFromCentre },
        ],
        30, J, rnd,
      ),
    });
  }

  // -- a curved stroke is not a cut. With a group selected it must still be a
  //    move, or a group could never be walked round anything.
  for (let i = 0; i < 5; i++) {
    cases.push({
      expected: "move",
      note: "swept arc with a group selected",
      ctx: groupContext(),
      points: stroke(
        [
          { x: FRIEND_X + 220, y: FRIEND_Y - 40 },
          { x: FRIEND_X + 430, y: FRIEND_Y - 320 - i * 30 },
          // Stops well short of the enemy: ending on one would make this an
          // attack, which is correct behaviour and not what this case probes.
          { x: FRIEND_X + 640, y: FRIEND_Y - 30 },
        ],
        52, J, rnd,
      ),
    });
  }

  // -- STROKE SPEED. A fast drag produces few sample points, a slow one
  //    produces hundreds; the recogniser sees only the polyline, so both must
  //    read the same. This is the one axis the rest of the corpus holds fixed.
  const here = { x: FRIEND_X, y: FRIEND_Y };
  for (const n of [4, 6, 10, 90, 200]) {
    cases.push({
      expected: "move",
      note: "march sampled at " + n + " points",
      ctx: context(0),
      points: stroke([here, { x: FRIEND_X + 700, y: FRIEND_Y - 160 }], n, J, rnd),
    });
    cases.push({
      expected: "attack",
      note: "charge sampled at " + n + " points",
      ctx: context(0),
      points: stroke([here, { x: ENEMY_X, y: ENEMY_Y }], n, J, rnd),
    });
  }
  for (const n of [14, 24, 120, 260]) {
    cases.push({
      expected: "patrol",
      note: "ring sampled at " + n + " points",
      ctx: context(0),
      points: stroke(circle(FRIEND_X - 150, FRIEND_Y, 430, 0, 1, 40), n, J, rnd),
    });
    cases.push({
      expected: "recover",
      note: "heart sampled at " + n + " points",
      ctx: context(0),
      points: stroke(heart(FRIEND_X + 430, FRIEND_Y, 240, 0, 46), n, J, rnd),
    });
  }

  // -- AMBUSH: a zigzag. Nothing else in the vocabulary doubles back more than
  //    once, so this is well clear of the rest -- but it must be drawn where a
  //    march, a glyph and a withdrawal are all still legal readings.
  for (let i = 0; i < 6; i++) {
    const legs: Point[] = [];
    // SEVEN points, not five: reversals are sign changes between consecutive
    // turns, so five points give three turns and at most two changes -- below
    // the three the recogniser asks for. Kept compact and well clear of the
    // enemy, since a stroke ending on one is an attack whatever its shape.
    const amp = 120 + i * 22;
    let x = FRIEND_X - 120;
    const y = FRIEND_Y;
    for (let k = 0; k < 7; k++) {
      legs.push({ x, y: y + (k % 2 === 0 ? -amp : amp) });
      x += 95;
    }
    cases.push({
      expected: "ambush",
      note: "zigzag of 7 points, amplitude " + amp,
      ctx: context(0),
      points: stroke(legs, 64, J, rnd),
    });
  }

  // A dog-legged march has ONE bend and must stay a march -- this is the pair
  // that would collide if reversals were counted loosely.
  for (let i = 0; i < 5; i++) {
    cases.push({
      expected: "move",
      note: "single dog-leg, not a zigzag",
      ctx: context(0),
      points: stroke(
        [here2(), { x: FRIEND_X + 340, y: FRIEND_Y - 240 - i * 30 }, { x: FRIEND_X + 720, y: FRIEND_Y + 60 }],
        48, J, rnd,
      ),
    });
  }

  // -- FEINT: a stroke retracing the route just ordered. Only meaningful with
  //    a pending route, so the same stroke with none must read as a march.
  {
    const outward: number[] = [FRIEND_X, FRIEND_Y, FRIEND_X + 760, FRIEND_Y - 120];
    for (let i = 0; i < 5; i++) {
      const ctxWith: GestureContext = { ...context(0), pendingRoute: outward };
      cases.push({
        expected: "feint",
        note: "retrace of the route just ordered",
        ctx: ctxWith,
        points: stroke(
          [{ x: FRIEND_X + 20, y: FRIEND_Y + (i - 2) * 12 },
           { x: FRIEND_X + 740, y: FRIEND_Y - 120 + (i - 2) * 12 }],
          40, J, rnd,
        ),
      });
      cases.push({
        expected: "move",
        note: "the very same stroke with no route pending is a march",
        ctx: context(0),
        points: stroke(
          [{ x: FRIEND_X + 20, y: FRIEND_Y + (i - 2) * 12 },
           { x: FRIEND_X + 740, y: FRIEND_Y - 120 + (i - 2) * 12 }],
          40, J, rnd,
        ),
      });
    }
    // A march somewhere ELSE while a route is pending is not a retrace of it.
    for (let i = 0; i < 4; i++) {
      cases.push({
        expected: "move",
        note: "a different march while a route is pending",
        ctx: { ...context(0), pendingRoute: outward },
        points: stroke(
          [here2(), { x: FRIEND_X + 200, y: FRIEND_Y + 620 + i * 40 }], 40, J, rnd,
        ),
      });
    }
  }

  return cases;
}

function here2(): Point {
  return { x: FRIEND_X, y: FRIEND_Y };
}

// =============================================================================
// The KINGDOM map's corpus (K2). Its own recogniser (src/input/kingdom-
// gestures.ts) and its own labels, so nothing here can move the battle matrix.
//
// The scene is the real campaign map with every label live at once: the king's
// counter beside his own holding, holdings all round it, and the shapes K4
// will claim (rings and hearts) drawn on top of the same king -- the competing
// vocabulary the march has to be told apart from. It runs at the zoom limits a
// 1280x720 window allows, and at the opening zoom, because the tolerances are
// world bases clamped to pixel floors and ceilings and both ends must hold.
// =============================================================================

export type KingdomCase = {
  /**
   * tapToken, tapHolding:<name>, march:<name>, none:<reason>; for K4 an army
   * label names its army by handle: tapToken:A2, intercept:F1, merge:<into>,
   * join:A2, split:A2, garrison:A2, recover:A2, patrol:A2:<name>,<name>.
   */
  readonly expected: string;
  readonly points: Point[];
  readonly ctx: KingdomGestureContext;
  readonly note: string;
  /** Army handles to ids, for the army scene's cases. */
  readonly armies?: Readonly<Record<string, number>>;
};

/** The zooms (miles per pixel) the kingdom corpus is drawn at, for a 1280x720 window. */
export function kingdomZooms(): { name: string; pxToWorld: number }[] {
  const cam = new KingdomCamera(1000, 700);
  cam.setViewport(1280, 720);
  return [
    { name: "min", pxToWorld: 1 / cam.minZoom },
    { name: "open", pxToWorld: 1 / cam.zoomForSpan(OPENING_MILES) },
    { name: "max", pxToWorld: 1 / cam.maxZoom },
  ];
}

/** A quadratic curve from a to b, bowed sideways by `bow` (a fraction of its length). */
function bowed(a: Point, b: Point, bow: number, steps: number): Point[] {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const c = { x: mx - dy * bow, y: my + dx * bow };
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y });
  }
  return out;
}

/** The emptiest point of a box: farthest from every holding (a place a stroke can end on nothing). */
function emptyCountry(world: KingdomWorld, x0: number, y0: number, x1: number, y1: number): Point {
  let best = { x: x0, y: y0 };
  let bestD = -1;
  for (let x = x0; x <= x1; x += 4) {
    for (let y = y0; y <= y1; y += 4) {
      let d = Infinity;
      for (const h of world.holdings) d = Math.min(d, Math.hypot(h.x - x, h.y - y));
      if (d > bestD) { bestD = d; best = { x, y }; }
    }
  }
  return best;
}

export function buildKingdomCorpus(): KingdomCase[] {
  const out: KingdomCase[] = [];
  const rnd = makeRng(0x6b32);

  // Two scenes: the king standing at Cold Hearth (as a new realm opens), and
  // the king out on the road to Greyshaw, where "already there" cannot apply
  // and the counter is between two holdings.
  const standing = new KingdomWorld({ seed: 7 });
  const onRoad = new KingdomWorld({ seed: 7 });
  const grey = onRoad.holdings.find((h) => h.name === "Greyshaw");
  if (!grey) throw new Error("Greyshaw missing from the map");
  onRoad.issue({ kind: "moveKing", to: grey.id });
  for (let i = 0; i < 12; i++) onRoad.tick();

  const named = (w: KingdomWorld, name: string): Point => {
    const h = w.holdings.find((x) => x.name === name);
    if (!h) throw new Error("no holding " + name);
    return { x: h.x, y: h.y };
  };

  for (const zoom of kingdomZooms()) {
    const px = zoom.pxToWorld;
    for (const [sceneName, world] of [["standing", standing], ["on the road", onRoad]] as const) {
      const king = world.kingPosition();
      const ctx = kingdomContext(world, king, px);
      const counter = kingCounterAt(king, px);
      const tag = (s: string): string => s + " @" + zoom.name + " zoom, king " + sceneName;
      const add = (expected: string, points: Point[], note: string): void => {
        out.push({ expected, points, ctx, note: tag(note) });
      };
      // A mouse tap wanders a pixel between down and up; never more than the tap tolerance.
      const tapAt = (p: Point, n: number): Point[] => {
        const pts: Point[] = [];
        for (let i = 0; i < n; i++) pts.push({ x: p.x + rnd() * 0.8 * px, y: p.y + rnd() * 0.8 * px });
        return pts;
      };
      const jitter = 1.5 * px;

      // -- taps ---------------------------------------------------------------
      for (const n of [1, 2, 4]) add("tapToken", tapAt(counter, n), "tap the king's counter, " + n + " samples");
      add("tapToken", tapAt({ x: counter.x + 6 * px, y: counter.y - 5 * px }, 3), "tap the counter's rim");
      for (const name of ["Greyshaw", "Thornwick", "Fell End", "Rookstead"]) {
        add("tapHolding:" + name, tapAt(named(world, name), 3), "tap " + name);
      }
      if (sceneName === "standing") {
        // Cold Hearth sits under the king: his counter is drawn 30 px above
        // it precisely so the holding can still be tapped.
        add("tapHolding:Cold Hearth", tapAt(named(world, "Cold Hearth"), 2), "tap Cold Hearth, under the king");
      }
      const empty = emptyCountry(world, 280, 240, 420, 360);
      add("none:nothing-there", tapAt(empty, 2), "tap empty parchment");

      // -- marches ------------------------------------------------------------
      const dests = sceneName === "standing"
        ? ["Greyshaw", "Thornwick", "Fell End", "Rookstead"]
        : ["Greyshaw", "Thornwick", "Cold Hearth", "Fell End"];
      for (const name of dests) {
        const to = named(world, name);
        for (const n of [8, 20, 60]) {
          add("march:" + name, stroke([counter, to], n, jitter, rnd), "straight line king -> " + name + ", " + n + " samples");
        }
        for (const bow of [0.25, -0.3]) {
          add("march:" + name, stroke(bowed(counter, to, bow, 24), 30, jitter, rnd), "curved line king -> " + name + " (bow " + bow + ")");
        }
        // Ending a little short of the holding's centre, as a quick hand does.
        const short = { x: to.x + (counter.x - to.x) * (5 * px) / Math.hypot(counter.x - to.x, counter.y - to.y), y: to.y + (counter.y - to.y) * (5 * px) / Math.hypot(counter.x - to.x, counter.y - to.y) };
        add("march:" + name, stroke([counter, short], 16, jitter, rnd), "line king -> just short of " + name);
      }

      // -- strokes that mean nothing ---------------------------------------
      const fromEmpty = emptyCountry(world, 120, 220, 220, 300);
      add("none:not-from-king", stroke([fromEmpty, named(world, "Greyshaw")], 20, jitter, rnd), "line from empty country to Greyshaw");
      add("none:not-from-king", stroke([named(world, "Thornwick"), named(world, "Rookstead")], 20, jitter, rnd), "line between two holdings, not from the king");
      add("none:no-destination", stroke([counter, empty], 30, jitter, rnd), "line from the king into empty country");
      add("none:no-destination", stroke(bowed(counter, empty, 0.3, 24), 30, jitter, rnd), "curved line from the king into empty country");
      if (sceneName === "standing") {
        // Straight down from the counter onto his own holding.
        add("none:already-there", stroke([counter, named(world, "Cold Hearth")], 12, 0.5 * px, rnd), "line from the king onto his own holding");
      }
      // The K4 vocabulary, live in the same scene: rings and hearts from the king.
      for (const r of [40, 60]) {
        const rr = r * px;
        const ring = circle(counter.x + rr, counter.y, rr, Math.PI, 1, 40);
        add("none:closed-no-army", stroke(ring, 48, jitter, rnd), "ring of " + r + " px drawn from the king");
      }
      const h = heart(counter.x, counter.y + 40 * px, 40 * px, 0, 48);
      add("none:closed-no-army", stroke(h, 56, jitter, rnd), "heart drawn from the king");
      const g = named(world, "Greyshaw");
      add("none:closed-no-army", stroke(circle(g.x, g.y, 30 * px, 0, 1, 36), 40, jitter, rnd), "ring round Greyshaw");
    }
  }
  out.push(...armyScene(rnd));
  return out;
}

/**
 * K4: the army scene. The real map with the whole army vocabulary live at
 * once, at the same three zooms: two armies of yours fanned side by side at
 * Cold Hearth under the king (A1 of three squads, A4 of one), A2 at
 * Greyshaw, and at Fell End an army of yours (A3) beside another side's (F1)
 * -- adjacent counters where an intercept, a merge and a tap must each be
 * told apart from the others and from the holding under them.
 */
export function armyWorld(): { world: KingdomWorld; armies: Record<string, number> } {
  const world = new KingdomWorld({ seed: 7 });
  const at = (name: string): number => {
    const h = world.holdings.find((x) => x.name === name);
    if (!h) throw new Error("no holding " + name);
    return h.id;
  };
  const a1 = raiseArmy(world, 0, at("Cold Hearth"), ["line", "slinger", "archer"]);
  const a2 = raiseArmy(world, 0, at("Greyshaw"), ["line", "archer"]);
  const a3 = raiseArmy(world, 0, at("Fell End"), ["line"]);
  const a4 = raiseArmy(world, 0, at("Cold Hearth"), ["slinger"]);
  const f1 = raiseArmy(world, 1, at("Fell End"), ["line", "line"]);
  return { world, armies: { A1: a1.id, A2: a2.id, A3: a3.id, A4: a4.id, F1: f1.id } };
}

function armyScene(rnd: () => number): KingdomCase[] {
  const out: KingdomCase[] = [];
  const { world, armies } = armyWorld();
  const named = (name: string): Point => {
    const h = world.holdings.find((x) => x.name === name);
    if (!h) throw new Error("no holding " + name);
    return { x: h.x, y: h.y };
  };
  for (const zoom of kingdomZooms()) {
    const px = zoom.pxToWorld;
    const king = world.kingPosition();
    const points = armyPointsOf(world);
    const ctx = kingdomContext(world, king, px, points);
    const counters = new Map(armyCounters(world, points, px).map((c) => [c.army.id, c.counter]));
    const C = (handle: string): Point => {
      const p = counters.get(armies[handle]);
      if (!p) throw new Error("army " + handle + " is not drawn (not visible?)");
      return p;
    };
    const kc = kingCounterAt(king, px);
    const add = (expected: string, points: Point[], note: string): void => {
      out.push({ expected, points, ctx, armies, note: note + " @" + zoom.name + " zoom, armies" });
    };
    const tapAt = (p: Point, n: number): Point[] => {
      const pts: Point[] = [];
      for (let i = 0; i < n; i++) pts.push({ x: p.x + rnd() * 0.8 * px, y: p.y + rnd() * 0.8 * px });
      return pts;
    };
    const jitter = 1.5 * px;

    // -- taps: each counter of a fanned pair, the foreign one, and the holdings under them
    for (const hnd of ["A1", "A4", "A2", "A3", "F1"]) add("tapToken:" + hnd, tapAt(C(hnd), 3), "tap " + hnd + "'s counter");
    add("tapToken", tapAt(kc, 2), "tap the king, armies below him");
    add("tapHolding:Fell End", tapAt(named("Fell End"), 3), "tap Fell End, two armies under it");
    add("tapHolding:Cold Hearth", tapAt(named("Cold Hearth"), 3), "tap Cold Hearth, between the king and two armies");

    // -- marches: an army by road, and the king among armies
    for (const n of [12, 40]) {
      add("march:Thornwick", stroke([C("A2"), named("Thornwick")], n, jitter, rnd), "line A2 -> Thornwick, " + n + " samples");
      add("march:Greyshaw", stroke([C("A1"), named("Greyshaw")], n, jitter, rnd), "line A1 -> Greyshaw (A2 stands there)");
      add("march:Rookstead", stroke(bowed(C("A3"), named("Rookstead"), 0.2, 24), n, jitter, rnd), "curved line A3 -> Rookstead");
      add("march:Thornwick", stroke([kc, named("Thornwick")], n, jitter, rnd), "line king -> Thornwick, past his armies");
    }

    // -- intercept, merge, join: lines between counters, near and far
    add("intercept:F1", stroke([C("A3"), C("F1")], 10, 0.5 * px, rnd), "line A3 -> F1, adjacent counters");
    add("intercept:F1", stroke([C("A2"), C("F1")], 30, jitter, rnd), "line A2 -> F1 across the map");
    add("intercept:F1", stroke(bowed(C("A1"), C("F1"), -0.2, 24), 30, jitter, rnd), "curved line A1 -> F1");
    add("merge:A4", stroke([C("A1"), C("A4")], 10, 0.5 * px, rnd), "line A1 -> A4, adjacent counters");
    add("merge:A1", stroke([C("A2"), C("A1")], 30, jitter, rnd), "line A2 -> A1 across the map");
    add("merge:A3", stroke(bowed(C("A2"), C("A3"), 0.25, 24), 30, jitter, rnd), "curved line A2 -> A3, beside F1");
    add("join:A2", stroke([kc, C("A2")], 30, jitter, rnd), "line king -> A2");
    add("join:A1", stroke([kc, C("A1")], 12, 0.5 * px, rnd), "line king -> A1 just below him");

    // -- split: a line across a counter, starting and ending on nothing
    // Across, not along, a fanned pair: a line along the fan crosses both
    // counters, and the pen will not guess which (see the none case below).
    const c2 = C("A2");
    add("split:A2", stroke([{ x: c2.x - 45 * px, y: c2.y - 8 * px }, { x: c2.x + 45 * px, y: c2.y + 8 * px }], 20, 0.8 * px, rnd), "line across A2");
    const c1 = C("A1");
    add("split:A1", stroke([{ x: c1.x - 6 * px, y: c1.y - 40 * px }, { x: c1.x + 4 * px, y: c1.y + 40 * px }], 20, 0.8 * px, rnd), "line down across A1, beside A4");
    const c4 = C("A4");
    add("none:not-from-king", stroke([{ x: c1.x - 40 * px, y: c1.y }, { x: c4.x + 40 * px, y: c4.y }], 24, 0.5 * px, rnd), "line along the fan across A1 and A4");
    add("split:A2", stroke([{ x: c2.x + 10 * px, y: c2.y + 50 * px }, { x: c2.x - 5 * px, y: c2.y - 50 * px }], 20, 0.8 * px, rnd), "upward line across A2");
    // K11 (audit A-07): the cut drawn down across the army under the king starts on the king's counter.
    {
      const len = Math.hypot(c1.x - kc.x, c1.y - kc.y) || 1;
      const ux = (c1.x - kc.x) / len;
      const uy = (c1.y - kc.y) / len;
      add("split:A1", stroke([kc, { x: c1.x + ux * 45 * px, y: c1.y + uy * 45 * px }], 20, 0.6 * px, rnd), "line down from the king across A1 under him");
    }

    // -- closed shapes: garrison rings, patrol rings, hearts
    const g = named("Greyshaw");
    add("garrison:A2", stroke(circle(g.x, g.y + 15 * px, 36 * px, 0, 1, 40), 48, jitter, rnd), "ring round Greyshaw and A2");
    add("garrison:A2", stroke(circle(c2.x + 22 * px, c2.y, 22 * px, Math.PI, 1, 32), 40, 0.8 * px, rnd), "small ring from A2's counter");
    const fe = named("Fell End");
    add("garrison:A3", stroke(circle(fe.x, fe.y + 15 * px, 40 * px, 0.5, 1, 40), 48, jitter, rnd), "ring round Fell End, A3 and F1");
    const r = named("Rookstead");
    const th = named("Thornwick");
    // Large rings. What a ring takes in depends on the zoom -- zoomed out, the
    // same ring in miles holds more of the map -- so each case's label is read
    // off the CLEAN circle (holdings and counters at least 8 px clear of its
    // edge), and the recogniser must read the same off the jittered stroke.
    const own = ["A1", "A2", "A3", "A4"];
    const names = ["Cold Hearth", "Greyshaw", "Thornwick", "Fell End", "Rookstead"];
    const bigRing = (cx: number, cy: number, rad: number, from: number, note: string, startOn: string | null): void => {
      const clear = 8 * px;
      const near = (p: Point): boolean => Math.abs(Math.hypot(p.x - cx, p.y - cy) - rad) < clear;
      const inside = (p: Point): boolean => Math.hypot(p.x - cx, p.y - cy) < rad;
      const pts = [...own.map(C), ...names.map(named)].filter((p) => startOn === null || p !== C(startOn));
      if (pts.some(near)) return; // ambiguous by construction: not a fair case
      const holds = names.filter((n) => inside(named(n)));
      const armiesIn = own.filter((h) => inside(C(h)));
      const subject = startOn ?? (armiesIn.length === 1 ? armiesIn[0] : null);
      const expected = !subject ? (armiesIn.length > 1 ? "none:closed-many-armies" : "none:closed-no-army")
        : holds.length >= 2 ? "patrol:" + subject + ":" + holds.join(",") : "garrison:" + subject;
      add(expected, stroke(circle(cx, cy, rad, from, 1, 64), 72, jitter, rnd), note);
    };
    const mid = { x: (g.x + r.x) / 2, y: (g.y + r.y) / 2 };
    const half = Math.hypot(g.x - r.x, g.y - r.y) / 2;
    bigRing(mid.x, mid.y, half + 30 * px, 1, "large ring round Greyshaw and Rookstead", null);
    const mid3 = { x: (g.x + r.x + th.x) / 3, y: (g.y + r.y + th.y) / 3 };
    const rad3 = Math.max(...[g, r, th].map((p) => Math.hypot(p.x - mid3.x, p.y - mid3.y))) + 30 * px;
    bigRing(mid3.x, mid3.y, rad3, 2, "large ring round Greyshaw, Rookstead and Thornwick", null);
    // ...and rings that START on A2's counter and loop out round holdings:
    // the subject is the army the ring begins on, whatever else it holds.
    for (const [toward, extra] of [[[g, r], 20], [[g, r, th], 20], [[r, th], 30]] as const) {
      const rel = toward.map((p) => ({ x: p.x - c2.x, y: p.y - c2.y }));
      let ux = 0;
      let uy = 0;
      for (const q of rel) { const d = Math.hypot(q.x, q.y); ux += q.x / d; uy += q.y / d; }
      const ul = Math.hypot(ux, uy);
      ux /= ul; uy /= ul;
      let rad = 0;
      for (const q of rel) {
        const dot = q.x * ux + q.y * uy;
        if (dot > 0) rad = Math.max(rad, (q.x * q.x + q.y * q.y) / (2 * dot));
      }
      rad += extra * px;
      const cx = c2.x + ux * rad;
      const cy = c2.y + uy * rad;
      bigRing(cx, cy, rad, Math.atan2(c2.y - cy, c2.x - cx), "large ring from A2's counter round " + toward.length + " holdings", "A2");
    }
    for (const [hnd, sz] of [["A2", 40], ["A1", 46], ["A3", 40]] as const) {
      const c = C(hnd);
      add("recover:" + hnd, stroke(heart(c.x, c.y, sz * px, 0, 48), 56, jitter, rnd), "heart on " + hnd);
    }
    add("none:closed-no-army", stroke(circle(r.x, r.y, 40 * px, 0, 1, 36), 40, jitter, rnd), "ring round Rookstead, no army there");
    const ch = named("Cold Hearth");
    const both = { x: (ch.x + g.x) / 2, y: (ch.y + g.y) / 2 };
    add("none:closed-many-armies", stroke(circle(both.x, both.y, Math.hypot(ch.x - g.x, ch.y - g.y) / 2 + 60 * px, 0.3, 1, 60), 70, jitter, rnd),
      "ring round Cold Hearth and Greyshaw, three armies inside");

    // -- strokes that mean nothing, among armies
    add("none:already-there", stroke([C("A2"), g], 12, 0.5 * px, rnd), "line A2 -> its own Greyshaw");
    add("none:not-from-king", stroke([named("Thornwick"), r], 20, jitter, rnd), "line Thornwick -> Rookstead, no counter");
    const empty = emptyCountry(world, 280, 240, 420, 360);
    add("none:no-destination", stroke([C("A2"), empty], 30, jitter, rnd), "line A2 -> empty country");
    add("none:nothing-there", tapAt(empty, 2), "tap empty country, armies about");
  }
  return out;
}
