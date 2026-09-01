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
    { id: 1, player: 0, x: FRIEND_X, y: FRIEND_Y, radius: R, facing, visible: true },
    { id: 2, player: 1, x: ENEMY_X, y: ENEMY_Y, radius: R, facing: Math.PI, visible: true },
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
    { id: 1, player: 0, x: FRIEND_X - 150, y: FRIEND_Y - 150, radius: R, facing: 0, visible: true },
    { id: 2, player: 0, x: FRIEND_X + 150, y: FRIEND_Y - 150, radius: R, facing: 0, visible: true },
    { id: 3, player: 0, x: FRIEND_X - 150, y: FRIEND_Y + 150, radius: R, facing: 0, visible: true },
    { id: 4, player: 0, x: FRIEND_X + 150, y: FRIEND_Y + 150, radius: R, facing: 0, visible: true },
    { id: 9, player: 1, x: ENEMY_X, y: ENEMY_Y, radius: R, facing: Math.PI, visible: true },
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

  return cases;
}
