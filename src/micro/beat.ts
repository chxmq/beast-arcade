// MICRO MAYHEM's own chiptune loop (square, triangle and noise on the shared WebAudio bus).
// Tempo follows the speed level: every SPEED UP plays it faster. Mood shifts for the boss.
import { sound } from '../game/audio.ts';

const LOOKAHEAD = 0.12;
const E2 = 82.41;
// 16-step patterns, semitones over E2 (E minor, bright and bouncy).
const BASS = [0, 12, 0, 12, 3, 15, 3, 15, 5, 17, 5, 17, 7, 19, 10, 22];
const LEAD = [24, -1, 27, 24, 31, -1, 29, 27, 24, -1, 22, 24, 27, -1, 19, -1];
const BOSS_BASS = [0, 0, 12, 0, 1, 1, 13, 1, 0, 0, 12, 0, 6, 6, 5, 3];
const hz = (semi: number) => E2 * Math.pow(2, semi / 12);

export type Mood = 'groove' | 'boss' | 'quiet';

export class Beat {
  private timer = 0;
  private next = 0;
  private step = 0;
  private bar = 0;
  private out: GainNode | null = null;
  bpm = 124;
  mood: Mood = 'groove';

  start(): void {
    const ctx = sound.ctx;
    if (!ctx || this.timer) return;
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.gain.setTargetAtTime(0.22, ctx.currentTime, 0.2);
    this.out.connect(sound.bus());
    this.next = ctx.currentTime + 0.05;
    this.step = 0;
    this.bar = 0;
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = 0;
    const ctx = sound.ctx;
    const out = this.out;
    this.out = null;
    if (!ctx || !out) return;
    out.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
    setTimeout(() => out.disconnect(), 600);
  }

  /** Tempo for a speed level (durations x0.87 per level, so the beat speeds up by 1/0.87). */
  setLevel(level: number): void {
    this.bpm = Math.min(232, 124 / Math.pow(0.87, Math.max(0, level)));
  }

  setMood(m: Mood): void {
    this.mood = m;
  }

  private schedule(): void {
    const ctx = sound.ctx;
    if (!ctx || !this.out) return;
    if (this.next < ctx.currentTime - 0.25) this.next = ctx.currentTime + 0.02;
    const step = 60 / this.bpm / 4;
    while (this.next < ctx.currentTime + LOOKAHEAD) {
      this.play(this.step, this.next);
      this.next += step;
      this.step = (this.step + 1) % 16;
      if (this.step === 0) this.bar++;
    }
  }

  private play(i: number, t: number): void {
    const m = this.mood;
    if (m === 'quiet') {
      if (i % 8 === 0) this.kick(t, 0.6);
      return;
    }
    const boss = m === 'boss';
    if (i % 4 === 0) this.kick(t, 1);
    if (i === 4 || i === 12) this.snare(t);
    if (i % 2 === 1) this.hat(t, 0.5);
    const shift = !boss && this.bar % 4 === 3 ? -2 : 0;
    const bassSemi = (boss ? BOSS_BASS : BASS)[i] + shift;
    this.bass(t, hz(bassSemi), boss ? 0.13 : 0.1);
    if (!boss) {
      const n = LEAD[i];
      if (n >= 0 && this.bar % 2 === 1) this.lead(t, hz(n + shift), 0.035);
    } else if (i % 4 === 2) this.lead(t, hz(24 + (this.bar % 2 ? 1 : 0)), 0.03);
  }

  private env(t: number, peak: number, dur: number): GainNode {
    const g = sound.ctx!.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this.out!);
    return g;
  }

  private kick(t: number, v: number): void {
    const o = sound.ctx!.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.1);
    o.connect(this.env(t, 0.5 * v, 0.18));
    o.start(t);
    o.stop(t + 0.2);
  }

  private snare(t: number): void {
    const ctx = sound.ctx!;
    const n = sound.noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2000;
    n.connect(f).connect(this.env(t, 0.2, 0.1));
    n.start(t);
    n.stop(t + 0.12);
  }

  private hat(t: number, v: number): void {
    const ctx = sound.ctx!;
    const n = sound.noiseSource();
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7500;
    n.connect(f).connect(this.env(t, 0.1 * v, 0.03));
    n.start(t);
    n.stop(t + 0.05);
  }

  private bass(t: number, f: number, v: number): void {
    const o = sound.ctx!.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const lp = sound.ctx!.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1200, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + 0.09);
    o.connect(lp).connect(this.env(t, v, 0.1));
    o.start(t);
    o.stop(t + 0.12);
  }

  private lead(t: number, f: number, v: number): void {
    const o = sound.ctx!.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    o.connect(this.env(t, v * 2, 0.12));
    o.start(t);
    o.stop(t + 0.14);
  }
}
