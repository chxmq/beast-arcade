// All sound is synthesised chiptune, voiced like an 8-bit arcade board: pulse channels at 12.5, 25
// and 50% duty, a 4-bit stepped triangle and a 15-bit LFSR noise channel. No samples, no filters.
// Each Beast type also has its own little motif while it is on screen: a second, human-only
// channel (agents act on screenshots and hear nothing) carrying the same information as the motion.
import { settings } from './settings.ts';

type Voice = { setPan(p: number): void; stop(): void };

/** Chip channels: pulse waves by duty cycle, and the stepped triangle. */
export type Wave = 'p12' | 'p25' | 'p50' | 'tri';

export type SfxName = 'coin' | 'start' | 'select' | 'back' | 'win' | 'lose' | 'speedup' | 'prompt' | 'boss' | 'gameover' | 'ticket' | 'crank' | 'pop' | 'flip' | 'denied';

export interface NoteOpts {
  /** Hard volume steps of the decay (0 = flat until the release). */
  steps?: number;
  /** Level the decay settles at, as a fraction of the peak (0 = decays to silence). */
  sustain?: number;
  /** Seconds the stepped decay takes (default: the whole note). */
  decay?: number;
  /** Pitch slide target in Hz, exponential over the note. */
  to?: number;
  /** Vibrato depth in cents; it kicks in after a short delay, like a chip driver's. */
  vib?: number;
}

export interface NoiseOpts {
  /** Short-mode LFSR: a metallic, pitched loop instead of white noise. */
  short?: boolean;
  /** Samples each LFSR step is held for (1, 2, 4, 8, 16): higher is lower and crunchier. */
  hold?: number;
  /** Playback rate, optionally sliding to `rateTo` over the hit (noise sweeps). */
  rate?: number;
  rateTo?: number;
  steps?: number;
}

/** MIDI note number to Hz (A4 = 69 = 440 Hz). */
export const mf = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** A minor pentatonic, in semitones: hits and kills climb it as the combo grows. */
const PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];
const comboSemi = (combo: number) => PENTA[Math.max(0, Math.min(PENTA.length - 1, combo - 1))];
const clampPan = (p: number) => Math.max(-1, Math.min(1, p));

const DUTY = { p12: 0.125, p25: 0.25, p50: 0.5 } as const;
/** Loudness trim per wave: normalised thin pulses sound quieter than a square. */
const WAVE_GAIN: Record<Wave, number> = { p12: 1.4, p25: 1.1, p50: 0.85, tri: 1.15 };
const HOLDS = [1, 2, 4, 8, 16];

/** One period of a wave at phase 0..1, DC removed. */
function waveAt(w: Wave, ph: number): number {
  if (w === 'tri') {
    const tri = ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph;
    return Math.round((tri + 1) * 7.5) / 7.5 - 1; // 16 levels, like the 2A03 triangle
  }
  const d = DUTY[w];
  return ((ph < d ? 1 : 0) - d) * 2;
}

const DFT_N = 2048;
let cosT: Float32Array | null = null;
let sinT: Float32Array | null = null;

/** Band-limited PeriodicWave of a chip wave (Fourier series by table DFT). */
function makeWave(ctx: BaseAudioContext, w: Wave, harmonics = 64): PeriodicWave {
  if (!cosT || !sinT) {
    cosT = new Float32Array(DFT_N);
    sinT = new Float32Array(DFT_N);
    for (let k = 0; k < DFT_N; k++) {
      cosT[k] = Math.cos((2 * Math.PI * k) / DFT_N);
      sinT[k] = Math.sin((2 * Math.PI * k) / DFT_N);
    }
  }
  const xs = new Float32Array(DFT_N);
  for (let k = 0; k < DFT_N; k++) xs[k] = waveAt(w, k / DFT_N);
  const re = new Float32Array(harmonics + 1);
  const im = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    let a = 0;
    let b = 0;
    for (let k = 0; k < DFT_N; k++) {
      const j = (n * k) & (DFT_N - 1);
      a += xs[k] * cosT[j];
      b += xs[k] * sinT[j];
    }
    re[n] = (2 * a) / DFT_N;
    im[n] = (2 * b) / DFT_N;
  }
  return ctx.createPeriodicWave(re, im);
}

/**
 * Chip volume envelope on `p`: on at `v`, down in `steps` hard steps over `decay` seconds to
 * `sustain` (a fraction of v), held, then a 4 ms release at the end so notes do not click.
 */
function env(p: AudioParam, t: number, v: number, d: number, steps: number, sustain = 0, decay = d) {
  const end = t + Math.max(0.012, d);
  p.setValueAtTime(v, t);
  let last = v;
  const n = Math.min(steps, Math.floor(decay / 0.008));
  for (let i = 1; i <= n; i++) {
    const at = t + (decay * i) / n;
    if (at >= end - 0.006) break;
    last = v * (1 - (1 - sustain) * (i / n));
    p.setValueAtTime(last, at);
  }
  p.setValueAtTime(last, end - 0.004);
  p.linearRampToValueAtTime(0, end);
}

interface LoopNote {
  t: number;
  d: number;
  f: number;
  w: Wave;
  v: number;
  to?: number;
  vibHz?: number;
  vibCents?: number;
  /** Stepped decay to silence over the note (8 steps). */
  decay?: boolean;
}

/** Render a short seamless loop of chip notes into a buffer (the Beast motifs). */
function renderLoop(ctx: BaseAudioContext, seconds: number, notes: LoopNote[]): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.round(seconds * sr));
  const buf = ctx.createBuffer(1, len, sr);
  const out = buf.getChannelData(0);
  const att = Math.max(1, Math.round(0.002 * sr));
  const rel = Math.max(1, Math.round(0.005 * sr));
  for (const n of notes) {
    const i0 = Math.round(n.t * sr);
    const i1 = Math.min(len, Math.round((n.t + n.d) * sr));
    const span = Math.max(1, i1 - i0);
    let ph = 0;
    for (let i = i0; i < i1; i++) {
      const k = (i - i0) / span;
      let f = n.to ? n.f * Math.pow(n.to / n.f, k) : n.f;
      // Vibrato on absolute time, so it stays continuous across notes and the loop seam.
      if (n.vibHz && n.vibCents) f *= Math.pow(2, (n.vibCents / 1200) * Math.sin((2 * Math.PI * n.vibHz * i) / sr));
      ph += f / sr;
      ph -= Math.floor(ph);
      let e = Math.min(1, (i - i0) / att, (i1 - i) / rel);
      if (n.decay) e *= 1 - Math.floor(k * 8) / 8;
      out[i] += waveAt(n.w, ph) * n.v * e;
    }
  }
  return buf;
}

class Sound {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private waves = new Map<Wave, PeriodicWave>();
  private noiseBufs = new Map<string, AudioBuffer>();
  private motifs: (AudioBuffer | null)[] = [null, null, null];
  private unlockFns = new Set<() => void>();

  /** True once the AudioContext exists (after the first user gesture). */
  get unlocked(): boolean {
    return this.ctx !== null;
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = settings.muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    this.master.connect(comp).connect(ctx.destination);
    const fns = [...this.unlockFns];
    this.unlockFns.clear();
    for (const fn of fns) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
  }

  /** Run `fn` once the AudioContext exists (right away if it already does). Returns an unsubscribe. */
  onUnlock(fn: () => void): () => void {
    if (this.ctx) {
      fn();
      return () => {};
    }
    this.unlockFns.add(fn);
    return () => {
      this.unlockFns.delete(fn);
    };
  }

  setMuted(m: boolean) {
    settings.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  /** Output bus for other modules (music). */
  bus(): AudioNode {
    return this.master;
  }

  /** A looping source on the LFSR noise (long mode by default). The caller starts and stops it. */
  noiseSource(short = false, hold = 1): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuffer(short, hold);
    src.loop = true;
    return src;
  }

  /** The PeriodicWave of a chip wave, built once per context. */
  wave(w: Wave): PeriodicWave {
    let p = this.waves.get(w);
    if (!p) {
      p = makeWave(this.ctx!, w);
      this.waves.set(w, p);
    }
    return p;
  }

  /**
   * 15-bit LFSR noise as on the 2A03: long mode taps bits 0 and 1 (32767-step white noise), short
   * mode taps bits 0 and 6 (a short metallic loop). Each step is held for `hold` samples.
   */
  private noiseBuffer(short: boolean, hold: number): AudioBuffer {
    const h = HOLDS.reduce((a, b) => (Math.abs(b - hold) < Math.abs(a - hold) ? b : a));
    const key = `${short ? 's' : 'l'}${h}`;
    let buf = this.noiseBufs.get(key);
    if (buf) return buf;
    const ctx = this.ctx!;
    let reg = 1;
    const step = () => {
      const fb = (reg ^ (reg >> (short ? 6 : 1))) & 1;
      reg = (reg >> 1) | (fb << 14);
      return reg & 1 ? -0.8 : 0.8;
    };
    const seq: number[] = [];
    if (short) {
      for (let i = 0; i < 300; i++) step();
      const start = reg;
      do seq.push(step());
      while (reg !== start && seq.length < 32767);
    } else {
      for (let i = 0; i < 32767; i++) seq.push(step());
    }
    const period = seq.length * h;
    const want = Math.ceil(ctx.sampleRate * (short ? 0.25 : 0.75));
    // Short mode keeps whole periods so its loop is seamless; long mode is noise either way.
    const len = short ? Math.max(1, Math.round(want / period)) * period : Math.min(want, period);
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = seq[Math.floor(i / h) % seq.length];
    this.noiseBufs.set(key, buf);
    return buf;
  }

  /** Low level (also used by music.ts): one chip note at absolute time `at` into `out`. */
  playNote(out: AudioNode, at: number, f: number, d: number, w: Wave, v: number, o: NoteOpts = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(this.wave(w));
    osc.frequency.setValueAtTime(f, at);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, at + d);
    const g = ctx.createGain();
    env(g.gain, at, v * WAVE_GAIN[w], d, o.steps ?? 0, o.sustain ?? 0, o.decay ?? d);
    osc.connect(g).connect(out);
    let lfo: OscillatorNode | null = null;
    let lg: GainNode | null = null;
    if (o.vib && d > 0.12) {
      lfo = ctx.createOscillator();
      lfo.type = 'triangle';
      lfo.frequency.value = 6;
      lg = ctx.createGain();
      lg.gain.setValueAtTime(0, at);
      lg.gain.setValueAtTime(o.vib, at + Math.min(0.12, d * 0.3));
      lfo.connect(lg).connect(osc.detune);
      lfo.start(at);
      lfo.stop(at + d + 0.02);
    }
    osc.start(at);
    osc.stop(at + d + 0.02);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
      lfo?.disconnect();
      lg?.disconnect();
    };
  }

  /** Low level (also used by music.ts): one noise hit at absolute time `at` into `out`. */
  playNoise(out: AudioNode, at: number, d: number, v: number, o: NoiseOpts = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    const buf = this.noiseBuffer(o.short ?? false, o.hold ?? 1);
    src.buffer = buf;
    src.loop = true;
    if (o.rate) {
      src.playbackRate.setValueAtTime(o.rate, at);
      if (o.rateTo) src.playbackRate.exponentialRampToValueAtTime(o.rateTo, at + d);
    }
    const g = ctx.createGain();
    env(g.gain, at, v, d, o.steps ?? 3);
    src.connect(g).connect(out);
    src.start(at, Math.random() * buf.duration);
    src.stop(at + d + 0.02);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
  }

  /** A note `t` seconds from now, into the master bus (or `out`). */
  private note(f: number, d: number, w: Wave, v: number, t = 0, o?: NoteOpts, out?: AudioNode) {
    if (!this.ctx) return;
    this.playNote(out ?? this.master, this.ctx.currentTime + t, f, d, w, v, o);
  }

  /** A noise hit `t` seconds from now. */
  private nz(d: number, v: number, t = 0, o?: NoiseOpts) {
    if (!this.ctx) return;
    this.playNoise(this.master, this.ctx.currentTime + t, d, v, o);
  }

  /** Background hiss of the old TV theme. Retired: the arcade has no hiss. Kept so callers compile. */
  hiss(_level: number) {}

  /** Broadcast test tone of the old TV theme. Retired. Kept so callers compile. */
  tone(_on: boolean) {}

  /** The looping motif of a Beast type, rendered once. */
  private motif(kind: 0 | 1 | 2): AudioBuffer {
    const have = this.motifs[kind];
    if (have) return have;
    const ctx = this.ctx!;
    const notes: LoopNote[] = [];
    let seconds: number;
    if (kind === 0) {
      // Magic: a shimmering major arpeggio, 25 notes a second, under a slow vibrato.
      seconds = 0.64;
      const arp = [0, 7, 12, 16];
      for (let i = 0; i < 16; i++) notes.push({ t: i * 0.04, d: 0.033, f: mf(76 + arp[i % 4]), w: 'p25', v: i % 4 === 0 ? 0.3 : 0.2, vibHz: 6.25, vibCents: 22 });
    } else if (kind === 1) {
      // Hunter: a quick whistled trill, then a breath.
      seconds = 0.6;
      for (let i = 0; i < 6; i++) notes.push({ t: i * 0.05, d: 0.044, f: mf(i % 2 ? 85 : 83), w: 'tri', v: 0.75 });
      notes.push({ t: 0, d: 0.03, f: mf(95), w: 'p12', v: 0.12 });
    } else {
      // Brute: a low thump and grunt at the slam rate (1.25 Hz).
      seconds = 0.8;
      notes.push({ t: 0, d: 0.14, f: 120, to: 42, w: 'tri', v: 0.95 });
      notes.push({ t: 0.02, d: 0.26, f: mf(33), w: 'p50', v: 0.16, decay: true });
      notes.push({ t: 0.4, d: 0.08, f: 80, to: 40, w: 'tri', v: 0.4 });
    }
    const buf = renderLoop(ctx, seconds, notes);
    this.motifs[kind] = buf;
    return buf;
  }

  /** A Beast's motif while it is on screen. `strength` 0..1 follows its signal (tier). */
  voice(type: number, strength: number): Voice | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const buf = this.motif(type === 0 ? 0 : type === 1 ? 1 : 2);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    // A touch of detune and a random start, so two Beasts of a type never phase-lock.
    src.playbackRate.value = 0.985 + Math.random() * 0.03;
    const out = ctx.createGain();
    const pan = ctx.createStereoPanner();
    src.connect(out).connect(pan).connect(this.master);
    const now = ctx.currentTime;
    const level = 0.035 + 0.045 * Math.max(0, Math.min(1, strength));
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(level, now + 0.15);
    src.start(now, Math.random() * buf.duration);
    let stopped = false;
    return {
      setPan: (p: number) => pan.pan.setTargetAtTime(clampPan(p), ctx.currentTime, 0.05),
      stop: () => {
        if (stopped) return;
        stopped = true;
        const t = ctx.currentTime;
        out.gain.cancelScheduledValues(t);
        out.gain.setTargetAtTime(0, t, 0.04);
        src.onended = () => {
          src.disconnect();
          out.disconnect();
          pan.disconnect();
        };
        src.stop(t + 0.3);
      },
    };
  }

  /** A strike landed: crisp tick, higher with every hit of the combo. */
  hit(combo: number) {
    const m = 84 + comboSemi(combo);
    this.note(mf(m), 0.05, 'p25', 0.07, 0, { to: mf(m - 5), steps: 3 });
    this.nz(0.025, 0.1, 0, { hold: 1, steps: 2 });
  }
  /** A wild Beast surfaced: a soft bip-bip, so the player knows something is out there. */
  wild() {
    this.note(mf(83), 0.045, 'p12', 0.035);
    this.note(mf(88), 0.05, 'p12', 0.03, 0.05, { steps: 2 });
  }
  /** A rare signal surfaced (2-3 taps, fainter, leaves sooner). */
  sting(kind: 'rare' | 'shiny' | 'king') {
    if (kind === 'king') return this.king();
    if (kind === 'rare') {
      [76, 81, 88].forEach((m, i) => this.note(mf(m), 0.09, 'p25', 0.07, i * 0.065, { steps: 3 }));
      this.nz(0.08, 0.07, 0.13, { short: true, hold: 1 });
      return;
    }
    this.sparkle();
  }
  /** Shiny: a glassy rising arpeggio with an echo. */
  sparkle() {
    [91, 95, 98, 100, 103].forEach((m, i) => {
      this.note(mf(m), 0.16, 'p12', 0.05, i * 0.05, { steps: 6 });
      this.note(mf(m), 0.12, 'p12', 0.018, i * 0.05 + 0.12, { steps: 4 });
    });
  }
  /** Wobble beat `i` of a rare catch: tick... tick... tick..., each higher. */
  wobble(i: number) {
    const m = 81 + i * 4;
    this.note(mf(m), 0.05, 'p25', 0.07, 0, { to: mf(m - 3), steps: 2 });
    this.nz(0.02, 0.09, 0, { short: true, hold: 1, steps: 1 });
  }
  /** The card flips: caught. `isNew` adds a rising answer. */
  caught(isNew: boolean, combo: number, chain = 1) {
    this.kill(combo, chain);
    if (isNew) [81, 85, 88].forEach((m, i) => this.note(mf(m), 0.16, 'p25', 0.06, 0.16 + i * 0.07, { steps: 5 }));
  }
  /** The card lands in the tray. */
  tray() {
    this.note(mf(93), 0.025, 'p12', 0.04);
    this.nz(0.015, 0.07, 0, { short: true, hold: 1, steps: 1 });
  }
  levelUp() {
    [72, 76, 79, 84].forEach((m, i) => this.note(mf(m), 0.08, 'p25', 0.07, i * 0.085));
    this.note(mf(88), 0.7, 'p25', 0.07, 0.34, { steps: 8, sustain: 0.5, decay: 0.3, vib: 25 });
    this.note(mf(79), 0.7, 'p12', 0.04, 0.34, { steps: 8, sustain: 0.4, decay: 0.3 });
    this.note(mf(48), 0.7, 'tri', 0.22, 0.34, { steps: 6 });
  }
  /** Daily goal complete. */
  goal() {
    [79, 83, 86, 91].forEach((m, i) => this.note(mf(m), 0.12, 'p25', 0.065, i * 0.075, { steps: 4 }));
    this.note(mf(55), 0.35, 'tri', 0.2, 0.225, { steps: 4 });
  }
  /** Clicked a Beast you already caught: soft and harmless. */
  overkill() {
    this.note(mf(94), 0.02, 'p12', 0.028);
  }
  /** A strike that hit nothing: a dull low bonk. */
  miss() {
    this.note(mf(50), 0.08, 'p50', 0.07, 0, { to: mf(43), steps: 2 });
    this.nz(0.05, 0.1, 0, { hold: 8, steps: 3 });
  }
  /** Second miss in a row: one more jams the game. */
  missWarn() {
    this.miss();
    this.note(mf(78), 0.06, 'p25', 0.065, 0.06);
    this.note(mf(78), 0.06, 'p25', 0.065, 0.18);
  }
  /** Three misses in a row: jammed. A grinding fall. */
  jam() {
    this.nz(0.45, 0.24, 0, { short: true, hold: 2, rate: 1, rateTo: 0.15, steps: 8 });
    this.note(mf(57), 0.4, 'p50', 0.09, 0, { to: mf(33), steps: 6 });
    this.note(mf(45), 0.4, 'tri', 0.25, 0, { to: mf(28), steps: 6 });
  }
  /** A Beast caught: a chord that climbs with the combo. */
  kill(combo: number, chain = 1) {
    const m = 64 + comboSemi(combo);
    this.nz(0.05, 0.12, 0, { hold: 2, steps: 3 });
    this.note(mf(m), 0.12, 'tri', 0.25, 0, { steps: 3 });
    this.note(mf(m + 7), 0.14, 'p25', 0.07, 0.045, { steps: 4 });
    this.note(mf(m + 12), 0.22, 'p25', 0.065, 0.09, { steps: 6 });
    if (chain >= 2) this.note(mf(m + 19 + (Math.min(chain, 5) - 2) * 2), 0.18, 'p12', 0.05, 0.13, { steps: 5 });
  }
  /** The King goes down. */
  kingKill() {
    this.nz(0.5, 0.26, 0, { hold: 16, steps: 10 });
    this.note(mf(45), 0.9, 'tri', 0.3, 0, { to: mf(33), steps: 8 });
    [69, 73, 76, 81].forEach((m, i) => this.note(mf(m), 0.36, 'p25', 0.075, 0.08 + i * 0.07, { steps: 6 }));
  }
  /** A Beast got away: a falling whoop. */
  escape() {
    this.note(mf(79), 0.28, 'p50', 0.075, 0, { to: mf(55), steps: 4 });
    this.nz(0.18, 0.1, 0, { hold: 4, rate: 1, rateTo: 0.3, steps: 4 });
  }
  /** The King arrives: dun, dun, dunnn. */
  king() {
    for (const t of [0, 0.2]) {
      this.note(mf(40), 0.15, 'p50', 0.08, t);
      this.note(mf(28), 0.15, 'tri', 0.3, t);
    }
    this.note(mf(34), 1.2, 'p50', 0.08, 0.42, { steps: 10, sustain: 0.4, decay: 0.5, vib: 35 });
    this.note(mf(22), 1.2, 'tri', 0.32, 0.42, { steps: 6, sustain: 0.5, decay: 0.6 });
    this.nz(0.3, 0.14, 0.42, { hold: 16, steps: 5 });
  }
  /** Out of lives: a long falling wail and two last thumps. */
  death() {
    this.nz(0.5, 0.22, 0, { hold: 8, steps: 8 });
    this.note(mf(84), 1.1, 'p25', 0.075, 0.1, { to: mf(48), steps: 10, sustain: 0.3, vib: 60 });
    this.note(mf(36), 0.2, 'tri', 0.25, 1.25, { steps: 3 });
    this.note(mf(36), 0.35, 'tri', 0.25, 1.5, { steps: 5 });
  }
  /** Survived the whole run. */
  fanfare(perfect = false) {
    [69, 73, 76, 81, 85].forEach((m, i) => this.note(mf(m), 0.1, 'p25', 0.07, i * 0.09));
    this.note(mf(81), 1.0, 'p25', 0.07, 0.48, { steps: 10, sustain: 0.45, decay: 0.4, vib: 25 });
    this.note(mf(76), 1.0, 'p12', 0.04, 0.48, { steps: 10, sustain: 0.4, decay: 0.4 });
    this.note(mf(57), 1.0, 'tri', 0.25, 0.48, { steps: 6 });
    if (perfect) [93, 97, 100].forEach((m, i) => this.note(mf(m), 0.3, 'p12', 0.045, 0.75 + i * 0.08, { steps: 6 }));
  }
  feverOn() {
    this.note(mf(57), 0.4, 'p25', 0.065, 0, { to: mf(81) });
    this.nz(0.35, 0.08, 0, { hold: 1, rate: 0.2, rateTo: 1, steps: 6 });
    this.note(mf(81), 0.08, 'p25', 0.07, 0.4);
    this.note(mf(88), 0.25, 'p25', 0.07, 0.48, { steps: 6 });
  }
  feverOff() {
    this.note(mf(76), 0.35, 'p25', 0.06, 0, { to: mf(52), steps: 6 });
  }
  /** A Beast is about to get away: short alarm panned to its side. */
  warn(pan: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const p = ctx.createStereoPanner();
    p.pan.value = clampPan(pan);
    p.connect(this.master);
    for (const d of [0, 0.12]) this.note(mf(86), 0.08, 'p50', 0.05, d, undefined, p);
    setTimeout(() => p.disconnect(), 600);
  }
  heartbeat() {
    this.note(90, 0.12, 'tri', 0.4, 0, { to: 48, steps: 3 });
    this.note(82, 0.12, 'tri', 0.3, 0.16, { to: 44, steps: 3 });
  }
  /** Screen change blip. */
  channel() {
    this.note(mf(76), 0.04, 'p25', 0.06);
    this.note(mf(83), 0.06, 'p25', 0.06, 0.045, { steps: 2 });
    this.nz(0.03, 0.07, 0, { short: true, hold: 1, steps: 1 });
  }
  /** Arcade sound effects (ARCADE.md section 3). */
  sfx(name: SfxName) {
    switch (name) {
      case 'coin':
        // The classic two-note coin ding: B5, then a ringing E6.
        this.note(mf(83), 0.07, 'p25', 0.085);
        this.note(mf(88), 0.42, 'p25', 0.085, 0.07, { steps: 10 });
        break;
      case 'start':
        [72, 76, 79].forEach((m, i) => {
          this.note(mf(m), 0.065, 'p50', 0.07, i * 0.07);
          this.note(mf(m - 24), 0.065, 'tri', 0.2, i * 0.07);
        });
        this.note(mf(84), 0.38, 'p25', 0.08, 0.21, { steps: 8, sustain: 0.4, decay: 0.2, vib: 25 });
        this.note(mf(60), 0.38, 'tri', 0.22, 0.21, { steps: 6 });
        break;
      case 'select':
        this.note(mf(88), 0.035, 'p12', 0.055);
        break;
      case 'back':
        this.note(mf(81), 0.04, 'p25', 0.055);
        this.note(mf(74), 0.06, 'p25', 0.055, 0.045, { steps: 3 });
        break;
      case 'win':
        this.note(mf(79), 0.065, 'p25', 0.08);
        this.note(mf(84), 0.065, 'p25', 0.08, 0.07);
        this.note(mf(88), 0.26, 'p25', 0.08, 0.14, { steps: 6 });
        this.note(mf(60), 0.3, 'tri', 0.2, 0.14, { steps: 5 });
        break;
      case 'lose':
        this.note(mf(55), 0.42, 'p50', 0.075, 0, { to: mf(43), steps: 6 });
        this.note(mf(55) * 1.03, 0.42, 'p12', 0.045, 0, { to: mf(43) * 1.03, steps: 6 });
        break;
      case 'speedup':
        [72, 74, 76, 77, 79, 81, 83, 84, 88].forEach((m, i) => this.note(mf(m), 0.04, 'p25', 0.055, i * 0.035));
        break;
      case 'prompt':
        this.note(mf(88), 0.05, 'p12', 0.07);
        this.note(mf(95), 0.07, 'p12', 0.07, 0.08, { steps: 2 });
        break;
      case 'boss':
        [40, 40, 41, 40].forEach((m, i) => {
          this.note(mf(m), 0.1, 'p50', 0.075, i * 0.12);
          this.note(mf(m - 12), 0.1, 'tri', 0.26, i * 0.12);
        });
        this.note(mf(28), 0.6, 'tri', 0.28, 0.5, { steps: 6 });
        this.note(mf(40), 0.6, 'p25', 0.055, 0.5, { steps: 6, vib: 40 });
        this.nz(0.25, 0.13, 0.5, { hold: 16, steps: 4 });
        break;
      case 'gameover': {
        let t = 0;
        for (const [m, d] of [[67, 0.16], [64, 0.16], [60, 0.16], [62, 0.12], [59, 0.6]] as const) {
          const last = m === 59;
          this.note(mf(m), d * 0.92, 'p50', 0.075, t, last ? { steps: 8, sustain: 0.3, decay: 0.3, vib: 30 } : undefined);
          this.note(mf(m - 24), d * 0.92, 'tri', 0.22, t, last ? { steps: 6 } : undefined);
          t += d;
        }
        break;
      }
      case 'ticket':
        this.note(mf(100), 0.018, 'p12', 0.03);
        break;
      case 'crank':
        for (let i = 0; i < 3; i++) {
          this.nz(0.03, 0.16, i * 0.09, { short: true, hold: 2, steps: 2 });
          this.note(mf(50 + i), 0.015, 'p12', 0.05, i * 0.09);
        }
        break;
      case 'pop':
        this.note(mf(57), 0.09, 'p25', 0.085, 0, { to: mf(93) });
        this.nz(0.06, 0.2, 0.07, { hold: 1, steps: 4 });
        break;
      case 'flip':
        this.nz(0.12, 0.11, 0, { hold: 1, rate: 0.12, rateTo: 1, steps: 6 });
        break;
      case 'denied':
        for (const [t, m, d] of [[0, 45, 0.12], [0.16, 44, 0.18]] as const) {
          this.note(mf(m), d, 'p50', 0.075, t, { steps: t ? 3 : 0 });
          this.note(mf(m) * 1.02, d, 'p12', 0.045, t, { steps: t ? 3 : 0 });
        }
        break;
    }
  }
  select() {
    this.sfx('select');
  }
  /** Confirm: a quick rising two-note blip (formerly the TV tune-in). */
  tune() {
    this.note(mf(79), 0.05, 'p25', 0.065);
    this.note(mf(86), 0.12, 'p25', 0.065, 0.055, { steps: 4 });
    this.nz(0.03, 0.07, 0, { hold: 1, steps: 1 });
  }
}

export const sound = new Sound();
