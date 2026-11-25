// Pieces shared by several microgames: the slam telegraph (DODGE, the boss), typed shots
// (COUNTER, the boss), the on-screen A B C buttons and the type triangle hint.
import type { BeastType } from '../../data/roster.ts';
import { TYPE_LABEL, type TypeButton } from '../cast.ts';
import { BUTTON_COLOR, PAL, TYPE_COLOR, TYPE_ICON, type Gfx } from '../gfx.ts';
import { clamp } from './base.ts';

// ------------------------------------------------------------------ slam

export type SlamPhase = 'idle' | 'tele' | 'drop' | 'down' | 'lift';
export const SLAM_DROP = 0.09;

/**
 * A stomp from above: a shadow telegraph on the ground (optionally homing on the player for the
 * first `track` share of it), a fast drop, the impact, and the lift. Pure logic.
 */
export class Slam {
  phase: SlamPhase = 'idle';
  t = 0;
  x = 160;
  /** Impacts so far. */
  count = 0;

  constructor(public tele: number, public down: number, public lift: number, public track = 0, public trackSpeed = 120) {}

  start(x: number): void {
    this.phase = 'tele';
    this.t = 0;
    this.x = x;
  }

  get busy(): boolean {
    return this.phase !== 'idle';
  }

  /** 0..1 through the telegraph (0 outside it). */
  get teleFrac(): number {
    return this.phase === 'tele' ? clamp(this.t / this.tele, 0, 1) : 0;
  }

  /** Advance; returns true on the frame of the impact. */
  update(dt: number, targetX: number, lo: number, hi: number): boolean {
    if (this.phase === 'idle') return false;
    this.t += dt;
    switch (this.phase) {
      case 'tele':
        if (this.t < this.tele * this.track) {
          const step = this.trackSpeed * dt;
          this.x = clamp(this.x + clamp(targetX - this.x, -step, step), lo, hi);
        }
        if (this.t >= this.tele) this.go('drop');
        return false;
      case 'drop':
        if (this.t >= SLAM_DROP) {
          this.go('down');
          this.count++;
          return true;
        }
        return false;
      case 'down':
        if (this.t >= this.down) this.go('lift');
        return false;
      case 'lift':
        if (this.t >= this.lift) this.go('idle');
        return false;
    }
  }

  private go(p: SlamPhase) {
    this.phase = p;
    this.t = 0;
  }
}

/** Ground shadow of a coming slam: grows and darkens through the telegraph. */
export function drawSlamShadow(g: Gfx, slam: Slam, groundY: number, halfW: number, flash: boolean): void {
  if (slam.phase === 'idle' || slam.phase === 'lift') return;
  const f = slam.phase === 'tele' ? slam.teleFrac : 1;
  const rx = halfW * (0.35 + 0.65 * f);
  g.ellipse(slam.x, groundY + 1, rx, 3 + 3 * f, `rgba(20,11,11,${(0.25 + 0.45 * f).toFixed(3)})`);
  if (slam.phase === 'tele' && flash && Math.floor(slam.t * 12) % 2 === 0) g.ellipse(slam.x, groundY + 1, rx, 3 + 3 * f, null, PAL.hot, 1.5);
}

// ------------------------------------------------------------------ shots

export interface Shot {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t: number;
  dur: number;
  type: BeastType;
  /** Bounces off (wrong type). */
  bounce: boolean;
}

export function shotPos(s: Shot): { x: number; y: number; done: boolean } {
  const f = clamp(s.t / s.dur, 0, 1);
  if (!s.bounce) return { x: s.x0 + (s.x1 - s.x0) * f, y: s.y0 + (s.y1 - s.y0) * f - Math.sin(f * Math.PI) * 10, done: f >= 1 };
  // Wrong type: flies to the target, then ricochets up and away.
  if (f < 0.6) {
    const k = f / 0.6;
    return { x: s.x0 + (s.x1 - s.x0) * k, y: s.y0 + (s.y1 - s.y0) * k - Math.sin(k * Math.PI) * 10, done: false };
  }
  const k = (f - 0.6) / 0.4;
  return { x: s.x1 - 40 * k, y: s.y1 - 50 * k + 40 * k * k, done: f >= 1 };
}

export function drawShot(g: Gfx, s: Shot, time: number): void {
  const p = shotPos(s);
  if (p.done) return;
  const col = TYPE_COLOR[s.type];
  g.at(p.x, p.y, 1, s.type === 1 ? 0 : time * 14, () => {
    if (s.type === 0) {
      g.icon('magic', 0, 0, 2, col, PAL.ink);
    } else if (s.type === 1) {
      g.icon('hunter', 0, 0, 2, col, PAL.ink);
    } else {
      g.circle(0, 0, 6, col, PAL.cab, 2);
      g.rect(-2, -3, 2, 2, PAL.ink);
    }
  });
  // trail
  g.alpha(0.5, () => g.circle(p.x - 6, p.y, 2.5, col));
}

// ------------------------------------------------------------------ buttons

export interface PadButton {
  b: TypeButton;
  x: number;
  y: number;
  r: number;
}

export function abcPad(y: number, r = 11, gap = 50): PadButton[] {
  return [
    { b: 'A', x: 160 - gap, y, r },
    { b: 'B', x: 160, y, r },
    { b: 'C', x: 160 + gap, y, r },
  ];
}

/** The A B C pad with each button's type under it. `lit` is the button pressed last and how long ago. */
export function drawPad(g: Gfx, pad: readonly PadButton[], lit: { b: TypeButton | null; age: number }, labels = true): void {
  pad.forEach((p, i) => {
    const pressed = lit.b === p.b && lit.age < 0.12;
    g.button(p.b, p.x, p.y, p.r, BUTTON_COLOR[p.b], pressed, labels ? TYPE_LABEL[i] : undefined);
  });
}

// ------------------------------------------------------------------ triangle hint

/** The type triangle: MAGIC beats BRUTE beats HUNTER beats MAGIC, as icons and arrows. */
export function drawTriangle(g: Gfx, cx: number, cy: number, alpha = 1): void {
  g.alpha(alpha, () => {
    g.rrect(cx - 40, cy - 27, 80, 56, 5, 'rgba(20,11,11,0.92)', PAL.ink, 1);
    g.text('BEATS', cx, cy - 19, { size: 6, color: PAL.ink });
    const pts: [number, number][] = [
      [cx, cy - 6], // MAGIC (top)
      [cx + 22, cy + 17], // BRUTE (bottom right)
      [cx - 22, cy + 17], // HUNTER (bottom left)
    ];
    const types: BeastType[] = [0, 2, 1];
    for (let i = 0; i < 3; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % 3];
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      const ux = dx / len;
      const uy = dy / len;
      const ax = x0 + ux * 9;
      const ay = y0 + uy * 9;
      const bx = x1 - ux * 10;
      const by = y1 - uy * 10;
      g.line(ax, ay, bx, by, PAL.ink, 1.5);
      g.poly([bx + ux * 4, by + uy * 4, bx - uy * 3, by + ux * 3, bx + uy * 3, by - ux * 3], PAL.ink);
    }
    pts.forEach(([x, y], i) => {
      const t = types[i];
      g.circle(x, y, 7, PAL.cab, TYPE_COLOR[t], 1.5);
      g.icon(TYPE_ICON[t], x, y, 1, TYPE_COLOR[t], PAL.ink);
    });
  });
}
