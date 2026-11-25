// Shared plumbing for the microgames: status, clocks, juice, particles and input helpers.
// Logic lives in play()/react(); draw() only reads state. No DOM is touched outside draw().
import type { RosterEntry } from '../../data/roster.ts';
import type { Gfx } from '../gfx.ts';
import { Particles } from '../particles.ts';
import type { Rng } from '../rng.ts';
import { noInput, type Audio, type Btn, type FrameInput, type GameCtx, type GameId, type Hint, type Microgame, type Pt, type Status } from '../types.ts';

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeIn = (t: number) => Math.pow(clamp(t, 0, 1), 3);
/** Overshooting ease for pops. */
export const easeBack = (t: number) => {
  const x = clamp(t, 0, 1);
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
};

/** Point inside a box given by its centre and size, grown by `m` on every side. */
export function inBox(p: Pt, cx: number, cy: number, w: number, h: number, m = 0): boolean {
  return Math.abs(p.x - cx) <= w / 2 + m && Math.abs(p.y - cy) <= h / 2 + m;
}

/** Move `x` with LEFT/RIGHT (held) or toward the pointer when it leads. */
export function steer(x: number, input: FrameInput, dt: number, keySpeed: number, lo: number, hi: number, pointerSpeed = 560): number {
  let nx = x;
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (dir !== 0) nx += dir * keySpeed * dt;
  else if (input.pointer && input.pointerLead) {
    const d = input.pointer.x - x;
    nx += clamp(d, -pointerSpeed * dt, pointerSpeed * dt);
  }
  return clamp(nx, lo, hi);
}

/** First A/B/C press of the frame, including taps on on-screen buttons. */
export function typePress(input: FrameInput, buttons: readonly { b: 'A' | 'B' | 'C'; x: number; y: number; r: number }[]): 'A' | 'B' | 'C' | null {
  for (const p of input.presses) if (p === 'A' || p === 'B' || p === 'C') return p;
  for (const t of input.taps) {
    for (const b of buttons) if (Math.hypot(t.x - b.x, t.y - b.y) <= b.r + 5) return b.b;
  }
  return null;
}

// Bot input builders (attract-mode demo).
export function botTap(x: number, y: number): FrameInput {
  return { ...noInput(), taps: [{ x, y }] };
}
export function botPress(b: Btn): FrameInput {
  return { ...noInput(), presses: [b] };
}
export function botPoint(x: number, y = 150): FrameInput {
  return { ...noInput(), pointer: { x, y }, pointerLead: true };
}
export const botIdle = noInput;

/** Uniform in [a, b) from Math.random: visual effects only. */
export const vrand = (a: number, b: number) => a + Math.random() * (b - a);

export abstract class BaseGame implements Microgame {
  abstract readonly id: GameId;
  abstract readonly prompt: string;
  abstract readonly hint: Hint;
  abstract readonly bg: string;
  readonly duration: number;
  cast: RosterEntry[] = [];
  status: Status = 'playing';
  t = 0;
  /** Seconds since the game was decided (drives the outro reaction). */
  since = 0;
  shake = 0;
  hitstop = 0;
  readonly fx = new Particles();
  protected readonly level: number;
  protected readonly rng: Rng;
  protected readonly audio: Audio;
  protected readonly calm: boolean;
  /** Ambient clock (prompt + play + outro), for idle animation. */
  protected clock = 0;
  protected botT = 0;

  constructor(protected readonly ctx: GameCtx) {
    this.duration = ctx.duration;
    this.level = ctx.level;
    this.rng = ctx.rng;
    this.audio = ctx.audio;
    this.calm = ctx.calm;
  }

  preview(dt: number): void {
    this.clock += dt * 0.25;
  }

  update(dt: number, input: FrameInput): void {
    this.clock += dt;
    if (this.status === 'playing') {
      this.t += dt;
      this.play(dt, input);
    } else {
      this.since += dt;
      this.react(dt);
    }
    this.ambient(dt);
    this.fx.update(dt);
  }

  protected abstract play(dt: number, input: FrameInput): void;

  /** Outro animation after the game was decided. */
  protected react(_dt: number): void {}

  /** Visual-only effects every frame of play and outro (use Math.random here, never this.rng). */
  protected ambient(_dt: number): void {}

  expire(): void {
    if (this.status === 'playing') this.lose();
  }

  protected win(): void {
    if (this.status !== 'playing') return;
    this.status = 'won';
    this.since = 0;
  }

  protected lose(): void {
    if (this.status !== 'playing') return;
    this.status = 'lost';
    this.since = 0;
  }

  protected bump(shake: number, stop = 0): void {
    if (!this.calm) this.shake = Math.max(this.shake, shake);
    this.hitstop = Math.max(this.hitstop, stop);
  }

  abstract draw(g: Gfx): void;

  bot(dt: number): FrameInput {
    this.botT += dt;
    if (this.status !== 'playing') return noInput();
    return this.botPlay(this.botT);
  }

  protected abstract botPlay(t: number): FrameInput;
}
