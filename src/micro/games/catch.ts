// CATCH! A Beast hops across the screen in arcs. Tap it before it gets away.
import type { RosterEntry } from '../../data/roster.ts';
import { artScale } from '../cast.ts';
import { H, PAL, W, type Gfx } from '../gfx.ts';
import type { FrameInput, GameCtx } from '../types.ts';
import { BaseGame, botIdle, botTap, clamp, inBox, vrand } from './base.ts';

const GROUND = 150;

export class CatchGame extends BaseGame {
  readonly id = 'catch' as const;
  readonly prompt = 'CATCH!';
  readonly hint = 'tap' as const;
  readonly bg = PAL.lime;
  readonly beast: RosterEntry;
  readonly shiny: boolean;
  readonly k: number;
  readonly w: number;
  readonly h: number;
  /** +1 hops left to right. */
  readonly dir: 1 | -1;
  /** Seconds to cross the whole screen (then it is gone). */
  readonly cross: number;
  readonly hopH: number[];
  /** Extra hitbox margin and how many missed taps are forgiven. */
  readonly margin: number;
  readonly forgive: number;
  readonly wobble: number;
  missed = 0;
  x = 0;
  /** Bottom of the sprite. */
  y = GROUND;
  private hop = 0;
  private landed = 0;
  private caughtX = 0;
  private caughtY = 0;
  private escaped = false;
  private readonly botAt: number;
  private botDone = false;

  constructor(ctx: GameCtx) {
    super(ctx);
    const L = this.level;
    this.beast = ctx.cast.any(this.rng, 0.55);
    this.cast = [this.beast];
    this.shiny = this.rng.chance(0.08);
    this.k = artScale(this.beast, L >= 4 ? 50 : 60);
    this.w = this.beast.artBox[2] * this.k;
    this.h = this.beast.artBox[3] * this.k;
    this.dir = this.rng.sign();
    this.cross = this.duration * (L >= 3 ? 0.8 : 0.88);
    const hops = this.rng.int(3, 4) + (L >= 2 ? 1 : 0);
    this.hopH = Array.from({ length: hops }, () => this.rng.range(42, 76) * (L >= 3 ? this.rng.range(0.75, 1.2) : 1));
    this.margin = L >= 3 ? 4 : L >= 1 ? 6 : 9;
    this.forgive = L >= 3 ? 0 : L >= 1 ? 1 : 2;
    this.wobble = L >= 3 ? this.rng.range(0.05, 0.09) : 0;
    this.botAt = this.rng.range(0.55, 0.95);
    this.place(0);
  }

  /** Where the Beast is at play time t: hops in arcs from one side to the other. */
  place(t: number): void {
    const f = clamp(t / this.cross, 0, 1);
    const pad = this.w / 2 + 4;
    const x0 = this.dir > 0 ? -pad : W + pad;
    const x1 = this.dir > 0 ? W + pad : -pad;
    // Faster speeds add a stutter: the Beast surges and hesitates.
    const fx = clamp(f + Math.sin(f * Math.PI * 3) * this.wobble, 0, 1);
    this.x = x0 + (x1 - x0) * fx;
    const n = this.hopH.length;
    const hf = f * n;
    const i = Math.min(n - 1, Math.floor(hf));
    const p = hf - i;
    this.y = GROUND - this.hopH[i] * 4 * p * (1 - p);
    if (i !== this.hop) {
      this.hop = i;
      this.landed = this.clock;
      this.fx.dust(this.x, GROUND, 6, this.dir);
    }
  }

  get cy(): number {
    return this.y - this.h / 2;
  }

  protected play(_dt: number, input: FrameInput): void {
    this.place(this.t);
    for (const tap of input.taps) {
      this.fx.ring(tap.x, tap.y, PAL.cab, 2, 11, 0.25);
      if (inBox(tap, this.x, this.cy, this.w, this.h, this.margin)) {
        this.caughtX = this.x;
        this.caughtY = this.y;
        this.audio.hit(4);
        this.audio.kill(3);
        this.fx.burst(this.x, this.cy, 22, { colors: [PAL.ink, PAL.gold, PAL.cab], speed: [60, 170], kind: 'star', size: [1, 2] });
        this.fx.ring(this.x, this.cy, PAL.ink, 4, 46, 0.4, 3);
        this.fx.pop(this.x, this.y - this.h - 8, 'GOTCHA!', PAL.ink, 10);
        this.bump(2, 0.07);
        this.win();
        return;
      }
      this.missed++;
      this.audio.whiff();
      this.fx.pop(tap.x, tap.y - 8, 'MISS', PAL.hot, 8);
      if (this.missed > this.forgive) {
        this.lose();
        return;
      }
    }
    if (this.t >= this.cross) {
      this.escaped = true;
      this.lose();
    }
  }

  protected react(): void {
    if (this.status === 'lost' && !this.escaped) this.place(this.t + this.since * 1.6);
  }

  protected ambient(): void {
    if (this.shiny && this.status !== 'won' && Math.random() < 0.3) {
      this.fx.burst(this.x + vrand(-this.w / 2, this.w / 2), this.y - vrand(0, this.h), 1, { colors: [PAL.gold, PAL.ink], kind: 'star', speed: [5, 15], life: [0.3, 0.5], size: [1, 1.5] });
    }
  }

  draw(g: Gfx): void {
    const time = this.clock;
    // horizon bushes and the ground
    for (let i = 0; i < 7; i++) g.circle(((i * 61 + 20) % (W + 40)) - 20, GROUND - 4, 16 + (i % 3) * 5, PAL.limeDark);
    g.rect(0, GROUND, W, H - GROUND, PAL.limeDark);
    g.rect(0, GROUND, W, 2, PAL.cab);
    for (let i = 0; i < 9; i++) {
      const x = (i * 37 + 12) % W;
      g.rect(x, GROUND + 8 + (i % 3) * 7, 6, 2, '#4cb316');
    }

    const won = this.status === 'won';
    let x = this.x;
    let y = this.y;
    let sy = 1;
    if (won) {
      // happy hops on the spot where it was caught
      x = this.caughtX;
      const hopY = Math.abs(Math.sin(this.since * 9)) * 10;
      y = Math.min(GROUND, this.caughtY + (GROUND - this.caughtY) * clamp(this.since * 4, 0, 1)) - hopY;
    } else {
      const sinceLand = time - this.landed;
      if (sinceLand < 0.12 && this.y > GROUND - 6) sy = 0.82 + sinceLand * 1.5;
    }
    const height = clamp((GROUND - y) / 80, 0, 1);
    g.ellipse(x, GROUND + 1, (this.w / 2) * (1 - height * 0.5), 3.5 * (1 - height * 0.4), 'rgba(20,11,11,0.3)');
    const flash = won && this.since < 0.09;
    g.sprite(this.beast, x, y, {
      k: this.k,
      flip: this.dir < 0,
      mode: flash ? 'white' : this.shiny ? 'shiny' : 'art',
      sy: sy !== 1 ? sy : undefined,
      sx: sy !== 1 ? 2 - sy : undefined,
    });
    if (won) g.icon('star', x - this.w / 2 - 6, y - this.h - 2 + Math.sin(this.since * 10) * 2, 1, PAL.gold, PAL.ink);

    // forgiven misses left
    if (this.forgive > 0 && this.status === 'playing') {
      for (let i = 0; i < this.forgive; i++) g.text('X', 152 + i * 12, 22, { size: 8, color: i < this.missed ? PAL.hot : 'rgba(20,11,11,0.25)' });
    }
    this.fx.draw(g);
  }

  protected botPlay(t: number): FrameInput {
    if (!this.botDone && t >= this.botAt) {
      this.botDone = true;
      return botTap(this.x + this.dir * 4, this.cy);
    }
    return botIdle();
  }
}
