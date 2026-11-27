/**
 * K11: the game's sound. Every cue is made here, in code, with WebAudio:
 * oscillators and a little filtered noise under short envelopes. No files,
 * no dependencies.
 *
 * Presentation only. Nothing here is read by src/sim, and nothing in
 * src/sim calls in here (tools/check-sim-purity.mjs keeps the sim free of
 * the DOM; a cue is played by the layers, from what the sim already said).
 *
 * The owner's rules: on by default at a low volume; a mute and a volume in
 * the in-game Menu; remembered in localStorage; and independent of
 * prefers-reduced-motion (that setting is about motion, not sound, so it is
 * never consulted here).
 *
 * Browsers start an AudioContext suspended until the page has been
 * interacted with; the context is made on the first cue and resumed on
 * every one, so the first click after load is heard (or, at worst, the one
 * after it). Where there is no WebAudio (the fake DOM the e2e runs in, an
 * old browser) every cue is a silent no-op.
 */

/** The cues the game plays. */
export type SoundCue = "click" | "stroke" | "refused" | "clash" | "march" | "letter" | "season" | "done";

export const SOUND_CUES: readonly SoundCue[] = ["click", "stroke", "refused", "clash", "march", "letter", "season", "done"];

/** What is remembered between visits. */
export type SoundSettings = { readonly on: boolean; readonly volume: number };

export const SOUND_KEY = "war.sound";
/** On, and quiet: a quarter of full. */
export const SOUND_DEFAULTS: SoundSettings = { on: true, volume: 25 };
/** The Menu's volume buttons move it this much. */
export const VOLUME_STEP = 10;

/** The least time between two plays of the same cue, in ms: a melee of a hundred blows is one clash, not a hundred. */
export const CUE_GAP_MS: Readonly<Record<SoundCue, number>> = {
  click: 40, stroke: 60, refused: 120, clash: 220, march: 300, letter: 600, season: 1500, done: 400,
};

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };

/** Read the settings, falling back to the defaults for anything missing or malformed. */
export function readSoundSettings(store: Store | null): SoundSettings {
  if (!store) return SOUND_DEFAULTS;
  try {
    const raw = store.getItem(SOUND_KEY);
    if (!raw) return SOUND_DEFAULTS;
    const v = JSON.parse(raw) as Partial<SoundSettings>;
    const on = typeof v.on === "boolean" ? v.on : SOUND_DEFAULTS.on;
    const volume = typeof v.volume === "number" && Number.isFinite(v.volume) ? clampVolume(v.volume) : SOUND_DEFAULTS.volume;
    return { on, volume };
  } catch {
    return SOUND_DEFAULTS;
  }
}

export function writeSoundSettings(store: Store | null, s: SoundSettings): void {
  if (!store) return;
  try {
    store.setItem(SOUND_KEY, JSON.stringify({ on: s.on, volume: s.volume }));
  } catch {
    /* private mode or full: the setting lasts this visit */
  }
}

export function clampVolume(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** One note of a cue: an oscillator (or noise) under an attack/decay envelope. */
type Voice = {
  readonly wave: OscillatorType | "noise";
  readonly freq: number;
  /** Frequency at the end, for a sweep. */
  readonly to?: number;
  readonly at: number;
  readonly dur: number;
  readonly gain: number;
  /** A band-pass for noise. */
  readonly band?: number;
};

/** The cues, as notes. Kept short and soft: they sit under the game, not over it. */
export const CUE_VOICES: Readonly<Record<SoundCue, readonly Voice[]>> = {
  // A dry tick, like a quill set down.
  click: [{ wave: "triangle", freq: 1250, to: 900, at: 0, dur: 0.045, gain: 0.35 }],
  // An order taken: a short rising pair.
  stroke: [
    { wave: "sine", freq: 520, at: 0, dur: 0.09, gain: 0.4 },
    { wave: "sine", freq: 780, at: 0.07, dur: 0.12, gain: 0.35 },
  ],
  // An order refused: low, falling, muffled.
  refused: [{ wave: "square", freq: 220, to: 150, at: 0, dur: 0.16, gain: 0.18 }],
  // Steel on steel: a bright noise burst over a ringing partial.
  clash: [
    { wave: "noise", freq: 0, at: 0, dur: 0.08, gain: 0.5, band: 3200 },
    { wave: "triangle", freq: 1900, to: 1700, at: 0, dur: 0.18, gain: 0.12 },
  ],
  // A march ordered: two soft drum beats.
  march: [
    { wave: "noise", freq: 0, at: 0, dur: 0.09, gain: 0.45, band: 180 },
    { wave: "noise", freq: 0, at: 0.18, dur: 0.09, gain: 0.4, band: 180 },
  ],
  // A letter: a seal broken, and a small bell.
  letter: [
    { wave: "noise", freq: 0, at: 0, dur: 0.05, gain: 0.3, band: 1400 },
    { wave: "sine", freq: 880, at: 0.06, dur: 0.5, gain: 0.3 },
    { wave: "sine", freq: 1320, at: 0.06, dur: 0.35, gain: 0.12 },
  ],
  // Work done (a building standing, a harvest in): a soft knock and a low chime.
  done: [
    { wave: "noise", freq: 0, at: 0, dur: 0.06, gain: 0.3, band: 600 },
    { wave: "sine", freq: 330, at: 0.05, dur: 0.35, gain: 0.25 },
    { wave: "sine", freq: 495, at: 0.05, dur: 0.3, gain: 0.12 },
  ],
  // The season turns: three slow, open notes.
  season: [
    { wave: "sine", freq: 392, at: 0, dur: 0.6, gain: 0.25 },
    { wave: "sine", freq: 523, at: 0.25, dur: 0.6, gain: 0.22 },
    { wave: "sine", freq: 659, at: 0.5, dur: 0.8, gain: 0.2 },
  ],
};

type AudioCtor = new () => AudioContext;

export class Sound {
  private settings: SoundSettings;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly last = new Map<SoundCue, number>();
  /** Cues asked for, for tests (the fake DOM plays nothing). */
  readonly played: SoundCue[] = [];
  private failed = false;

  private readonly store: Store | null;
  private readonly Ctor: AudioCtor | null;

  constructor(store: Store | null, Ctor: AudioCtor | null) {
    this.store = store;
    this.Ctor = Ctor;
    this.settings = readSoundSettings(store);
  }

  get on(): boolean { return this.settings.on; }
  get volume(): number { return this.settings.volume; }

  setOn(on: boolean): void {
    this.settings = { ...this.settings, on };
    writeSoundSettings(this.store, this.settings);
    this.applyVolume();
  }

  setVolume(v: number): void {
    this.settings = { ...this.settings, volume: clampVolume(v) };
    writeSoundSettings(this.store, this.settings);
    this.applyVolume();
  }

  /** Play a cue now, if sound is on and the cue has rested long enough. `now` is ms (performance.now()). */
  play(cue: SoundCue, now: number): void {
    if (!this.settings.on || this.settings.volume === 0) return;
    const prev = this.last.get(cue);
    if (prev !== undefined && now - prev < CUE_GAP_MS[cue]) return;
    this.last.set(cue, now);
    this.played.push(cue);
    if (this.played.length > 64) this.played.splice(0, this.played.length - 64);
    const ctx = this.context();
    if (!ctx || !this.master) return;
    try {
      if (ctx.state === "suspended") void ctx.resume();
      const t0 = ctx.currentTime + 0.005;
      for (const v of CUE_VOICES[cue]) this.voice(ctx, this.master, v, t0);
    } catch {
      /* a cue is never worth an error */
    }
  }

  private context(): AudioContext | null {
    if (this.ctx || this.failed) return this.ctx;
    if (!this.Ctor) { this.failed = true; return null; }
    try {
      this.ctx = new this.Ctor();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.applyVolume();
      // One second of white noise, made once, for the drums, seals and clashes.
      const n = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, n, n);
      const d = this.noise.getChannelData(0);
      let seed = 0x9e3779b9;
      for (let i = 0; i < n; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        d[i] = seed / 0x80000000 - 1;
      }
    } catch {
      this.failed = true;
      this.ctx = null;
      this.master = null;
    }
    return this.ctx;
  }

  private applyVolume(): void {
    if (!this.master || !this.ctx) return;
    // Perceived loudness is roughly the square of the gain: a squared curve
    // makes the Menu's steps sound even.
    const v = this.settings.on ? this.settings.volume / 100 : 0;
    this.master.gain.setValueAtTime(v * v * 0.6, this.ctx.currentTime);
  }

  private voice(ctx: AudioContext, out: AudioNode, v: Voice, t0: number): void {
    const start = t0 + v.at;
    const end = start + v.dur;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(v.gain, start + Math.min(0.012, v.dur / 4));
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    env.connect(out);
    if (v.wave === "noise") {
      if (!this.noise) return;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.setValueAtTime(v.band ?? 1000, start);
      f.Q.setValueAtTime(1.2, start);
      src.connect(f);
      f.connect(env);
      src.start(start, Math.random() * 0.5, v.dur + 0.02);
      return;
    }
    const osc = ctx.createOscillator();
    osc.type = v.wave;
    osc.frequency.setValueAtTime(v.freq, start);
    if (v.to) osc.frequency.exponentialRampToValueAtTime(v.to, end);
    osc.connect(env);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

let shared: Sound | null = null;

/** The game's one Sound, made on first use from the page's storage and AudioContext. */
export function sound(): Sound {
  if (shared) return shared;
  const g = globalThis as unknown as {
    localStorage?: Store;
    AudioContext?: AudioCtor;
    webkitAudioContext?: AudioCtor;
  };
  let store: Store | null = null;
  try { store = g.localStorage ?? null; } catch { store = null; }
  shared = new Sound(store, g.AudioContext ?? g.webkitAudioContext ?? null);
  return shared;
}

/** Play a cue on the shared Sound. */
export function cue(c: SoundCue): void {
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  sound().play(c, now);
}

/** For tests: forget the shared Sound so the next one reads storage afresh. */
export function resetSoundForTests(): void {
  shared = null;
}
