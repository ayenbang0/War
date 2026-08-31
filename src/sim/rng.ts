/**
 * Deterministic pseudo-random numbers.
 *
 * sfc32 (small-fast-counter, 32-bit) seeded by splitmix32. Both use only
 * exactly-specified 32-bit integer operations (^ | << >>> and Math.imul), so
 * every engine produces an identical stream -- unlike Math.random, which is
 * seedless and unreproducible and is therefore banned in src/sim/.
 *
 * Each subsystem owns its own stream. That matters: if combat, morale and AI
 * all pulled from one generator, adding a single roll to combat would shift
 * every later morale and AI decision and invalidate all recorded replays.
 */

import { imul } from "./math.ts";

export type RngState = { a: number; b: number; c: number; d: number };

/** Named streams. Add new ones freely; existing streams are unaffected. */
export const Stream = {
  Terrain: 0x7e881a01,
  Combat: 0x2c9e11b7,
  Morale: 0x51ab3f0d,
  Ai: 0x9d2c5e83,
  Spawn: 0x4f1bbcdd,
} as const;

export type StreamId = (typeof Stream)[keyof typeof Stream];

function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

export class Rng {
  a = 0;
  b = 0;
  c = 0;
  d = 0;

  /** Seed a stream. The same (seed, stream) pair always yields the same run. */
  static create(seed: number, stream: StreamId): Rng {
    const r = new Rng();
    const mix = splitmix32((seed | 0) ^ stream);
    r.a = mix() | 0;
    r.b = mix() | 0;
    r.c = mix() | 0;
    r.d = mix() | 0;
    // Discard early output; sfc32 needs a short warm-up to decorrelate.
    for (let i = 0; i < 12; i++) r.nextU32();
    return r;
  }

  nextU32(): number {
    let { a, b, c, d } = this;
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    return t >>> 0;
  }

  /** Uniform in [0, 1). */
  nextFloat(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return (this.nextFloat() * n) | 0;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + this.nextFloat() * (hi - lo);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.nextFloat() < p;
  }

  snapshot(): RngState {
    return { a: this.a, b: this.b, c: this.c, d: this.d };
  }

  restore(s: RngState): void {
    this.a = s.a;
    this.b = s.b;
    this.c = s.c;
    this.d = s.d;
  }
}
