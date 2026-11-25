// SHINY! A crowd of the same Beast wanders about. One of them is shiny (gold, sparkling). Tap it.
import type { RosterEntry } from '../../data/roster.ts';
import { PAL, W, type Gfx } from '../gfx.ts';
import type { FrameInput, GameCtx } from '../types.ts';
import { BaseGame, botIdle, botTap, clamp, inBox, vrand } from './base.ts';

const TOP = 34;
const BOTTOM = 168;

interface Walker {
  x: number;
  /** Bottom of the sprite. */
  y: number;
  vx: number;
  vy: number;
  shiny: boolean;
  /** Next play time it picks a new heading. */
  turn: number;
  /** Clock time it was wrongly tapped (red flash). */
  nope: number;
}

export class ShinyGame extends BaseGame {
  readonly id = 'shiny' as const;
  readonly prompt = 'SHINY!';
  readonly hint = 'tap' as const;
  readonly bg = PAL.screen;
  readonly species: RosterEntry;
  readonly k: number;
  readonly w: number;
  readonly h: number;
  readonly walkers: Walker[];
  readonly shinyIdx: number;
  readonly speed: number;
  /** Wrong taps forgiven. */
  readonly forgive: number;
  /** Sparkles only now and then at higher speeds. */
  readonly sparkleDuty: number;
  wrongs = 0;
  private readonly botAt: number;
  private botDone = false;

  constructor(ctx: GameCtx) {
    super(ctx);
    const L = this.level;
    const n = L >= 4 ? 9 : L >= 2 ? 8 : L >= 1 ? 7 : 6;
    this.species = ctx.cast.any(this.rng, 0.35, ctx.cast.small);
    this.cast = [this.species];
    this.k = n <= 7 ? 2 : 1;
    this.w = this.species.artBox[2] * this.k;
    this.h = this.species.artBox[3] * this.k;
    this.speed = 16 + 7 * L;
    this.forgive = L <= 1 ? 1 : 0;
    this.sparkleDuty = L >= 3 ? 0.35 : 1;
    this.shinyIdx = this.rng.int(0, n - 1);
    this.walkers = this.layout(n);
    this.botAt = this.rng.range(0.75, 1.05);
  }

  /** Spread the crowd on a jittered grid so nobody starts hidden behind another. */
  private layout(n: number): Walker[] {
    const cols = Math.ceil(n / 2);
    const out: Walker[] = [];
    const cellW = (W - 40) / cols;
    for (let i = 0; i < n; i++) {
      const row = i % 2;
      const col = Math.floor(i / 2);
      const x = 20 + cellW * (col + 0.5) + this.rng.range(-cellW * 0.2, cellW * 0.2);
      const y = row === 0 ? TOP + this.h + this.rng.range(4, 14) : BOTTOM - this.rng.range(0, 10);
      const a = this.rng.range(0, Math.PI * 2);
      out.push({ x, y: clamp(y, TOP + this.h, BOTTOM), vx: Math.cos(a) * this.speed, vy: Math.sin(a) * this.speed * 0.6, shiny: i === this.shinyIdx, turn: this.rng.range(0.4, 1.1), nope: -9 });
    }
    return out;
  }

  private move(dt: number) {
    const lo = this.w / 2 + 4;
    const hi = W - this.w / 2 - 4;
    for (const wk of this.walkers) {
      if (this.t >= wk.turn) {
        const a = this.rng.range(0, Math.PI * 2);
        wk.vx = Math.cos(a) * this.speed;
        wk.vy = Math.sin(a) * this.speed * 0.6;
        wk.turn = this.t + this.rng.range(0.5, 1.2);
      }
      wk.x += wk.vx * dt;
      wk.y += wk.vy * dt;
      if (wk.x < lo || wk.x > hi) {
        wk.vx = -wk.vx;
        wk.x = clamp(wk.x, lo, hi);
      }
      if (wk.y < TOP + this.h || wk.y > BOTTOM) {
        wk.vy = -wk.vy;
        wk.y = clamp(wk.y, TOP + this.h, BOTTOM);
      }
    }
  }

  /** Walkers front (largest y) to back. */
  private frontToBack(): Walker[] {
    return this.walkers.slice().sort((a, b) => b.y - a.y);
  }

  protected play(dt: number, input: FrameInput): void {
    this.move(dt);
    for (const tap of input.taps) {
      const hit = this.frontToBack().find((wk) => inBox(tap, wk.x, wk.y - this.h / 2, this.w, this.h, 3));
      if (!hit) {
        this.fx.ring(tap.x, tap.y, PAL.ink, 2, 10, 0.25);
        continue;
      }
      if (hit.shiny) {
        this.audio.sparkle();
        this.audio.hit(6);
        this.bump(2, 0.06);
        this.fx.burst(hit.x, hit.y - this.h / 2, 30, { colors: [PAL.gold, PAL.ink, PAL.gold], speed: [50, 170], kind: 'star', size: [1, 2.5], life: [0.4, 0.9] });
        this.fx.ring(hit.x, hit.y - this.h / 2, PAL.gold, 4, 50, 0.45, 3);
        this.fx.pop(hit.x, hit.y - this.h - 10, 'SHINY!', PAL.gold, 10);
        this.win();
        return;
      }
      hit.nope = this.clock;
      this.wrongs++;
      this.audio.sfx('denied');
      this.fx.pop(hit.x, hit.y - this.h - 6, 'NOPE', PAL.hot, 8);
      if (this.wrongs > this.forgive) {
        this.lose();
        return;
      }
    }
  }

  protected react(dt: number): void {
    if (this.status === 'lost') this.move(dt * 0.3);
  }

  protected ambient(): void {
    const s = this.walkers[this.shinyIdx];
    const on = this.status === 'won' || this.sparkleDuty >= 1 || (this.clock % 1.4) < 1.4 * this.sparkleDuty;
    if (on && Math.random() < 0.45) {
      this.fx.burst(s.x + vrand(-this.w / 2, this.w / 2), s.y - vrand(0, this.h), 1, { colors: [PAL.gold, PAL.ink], kind: 'star', speed: [4, 14], life: [0.25, 0.5], size: [1, 1.6], drag: 3 });
    }
  }

  draw(g: Gfx): void {
    const time = this.clock;
    // a night plaza: dark, a soft spotlight and a tiled floor
    g.circle(160, 104, 120, PAL.cab);
    g.alpha(0.5, () => g.checker('#1f1414', 12, 0, 0, 40, 180));
    g.circle(160, 104, 120, null, '#2a1a18', 2);
    const won = this.status === 'won';
    const lost = this.status === 'lost';
    const sorted = this.walkers.slice().sort((a, b) => a.y - b.y);
    for (const wk of sorted) {
      const bob = Math.abs(Math.sin(time * 9 + wk.x * 0.1)) * 2;
      const dim = won && !wk.shiny ? 0.35 : 1;
      let y = wk.y - bob;
      if (won && wk.shiny) y = wk.y - Math.abs(Math.sin(this.since * 10)) * 12;
      g.ellipse(wk.x, wk.y + 1, this.w / 2.5, 2.5, 'rgba(0,0,0,0.5)');
      const blink = time - wk.nope < 0.3 && Math.floor((time - wk.nope) * 20) % 2 === 0;
      g.sprite(this.species, wk.x, y, { k: this.k, flip: wk.vx < 0, mode: blink ? 'white' : wk.shiny ? 'shiny' : 'art', alpha: dim });
      if (lost && wk.shiny) {
        const ay = wk.y - this.h - 10 + Math.sin(time * 10) * 2;
        g.poly([wk.x - 5, ay - 6, wk.x + 5, ay - 6, wk.x, ay], PAL.gold, PAL.cab, 1);
        g.text('THIS ONE', wk.x, ay - 12, { size: 6, color: PAL.gold, outline: PAL.cab, ow: 1.5 });
      }
    }
    if (this.forgive > 0 && this.status === 'playing') g.text(this.wrongs ? 'LAST TRY' : '1 FREE MISS', 160, 14, { size: 6, color: PAL.dim });
    this.fx.draw(g);
  }

  protected botPlay(t: number): FrameInput {
    if (this.botDone || t < this.botAt) return botIdle();
    this.botDone = true;
    const s = this.walkers[this.shinyIdx];
    return botTap(s.x, s.y - this.h / 2);
  }
}
