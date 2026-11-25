// FEED! Gold coins rain down. Move the basket (pointer or LEFT/RIGHT) and catch three.
// From speed 3 on, rocks fall too: catch one and it is over.
import { artScale } from '../cast.ts';
import { H, PAL, W, type Gfx } from '../gfx.ts';
import type { FrameInput, GameCtx } from '../types.ts';
import { BaseGame, botIdle, botPoint, clamp, steer } from './base.ts';

const GROUND = 162;
/** The basket's rim: items crossing it inside the basket are caught. */
const RIM = 136;
const TOP = -10;

export interface Drop {
  kind: 'coin' | 'rock';
  x: number;
  y: number;
  /** Play time it starts falling. */
  at: number;
  state: 'wait' | 'fall' | 'caught' | 'missed';
  spin: number;
}

export class FeedGame extends BaseGame {
  readonly id = 'feed' as const;
  readonly prompt = 'FEED!';
  readonly hint = 'move' as const;
  readonly bg = PAL.cyan;
  readonly need = 3;
  readonly drops: Drop[];
  /** Fall speed (px/s), basket half width, key speed. */
  readonly speed: number;
  readonly half: number;
  readonly keySpeed: number;
  readonly pk: number;
  px = 160;
  caught = 0;
  private hit: Drop | null = null;
  private readonly clouds: { x: number; y: number; r: number; v: number }[];

  constructor(ctx: GameCtx) {
    super(ctx);
    const L = this.level;
    this.cast = [ctx.partner];
    const fall = this.duration * 0.36;
    this.speed = (RIM - TOP) / fall;
    this.half = L >= 2 ? 16 : 19;
    this.keySpeed = 220 + 22 * L;
    this.pk = artScale(ctx.partner, 32);
    this.px = this.rng.range(120, 200);
    const gap = this.duration * 0.11;
    const coins = Math.max(4, Math.floor((this.duration - 0.15 - fall) / gap) + 1);
    const rocks = L >= 4 ? 3 : L >= 2 ? 2 : 0;
    this.drops = [];
    let x = this.px + this.rng.range(-70, 70);
    for (let i = 0; i < coins; i++) {
      x = clamp(x + this.rng.range(-95, 95), 18, W - 18);
      this.drops.push({ kind: 'coin', x, y: TOP, at: 0.05 + i * gap, state: 'wait', spin: this.rng.range(0, 6) });
    }
    for (let r = 0; r < rocks; r++) {
      // a rock right in the path between two coins
      const i = 1 + Math.min(coins - 2, Math.floor(((r + 0.5) * (coins - 1)) / rocks));
      const a = this.drops[i - 1];
      const b = this.drops[i];
      this.drops.push({ kind: 'rock', x: clamp((a.x + b.x) / 2 + this.rng.range(-12, 12), 18, W - 18), y: TOP, at: (a.at + b.at) / 2, state: 'wait', spin: this.rng.range(0, 6) });
    }
    this.clouds = Array.from({ length: 3 }, (_, i) => ({ x: this.rng.range(0, W), y: 26 + i * 22, r: this.rng.range(10, 16), v: this.rng.range(4, 10) }));
  }

  protected play(dt: number, input: FrameInput): void {
    this.px = steer(this.px, input, dt, this.keySpeed, this.half + 4, W - this.half - 4);
    for (const d of this.drops) {
      if (d.state === 'wait' && this.t >= d.at) d.state = 'fall';
      if (d.state !== 'fall') continue;
      const prev = d.y;
      d.y += this.speed * dt;
      d.spin += dt * 9;
      if (prev < RIM && d.y >= RIM) {
        if (Math.abs(d.x - this.px) <= this.half + 3) {
          d.state = 'caught';
          if (d.kind === 'rock') {
            this.hit = d;
            this.audio.thud();
            this.bump(5);
            this.fx.pop(this.px, RIM - 30, 'OUCH!', PAL.hot, 10);
            this.lose();
            return;
          }
          this.caught++;
          this.audio.sfx('coin');
          this.fx.burst(d.x, RIM, 8, { colors: [PAL.gold, PAL.ink], kind: 'star', speed: [30, 90], size: [1, 1.5] });
          this.fx.pop(this.px, RIM - 30, `${this.caught}`, PAL.cab, 10);
          if (this.caught >= this.need) {
            this.bump(2, 0.05);
            this.win();
            return;
          }
        }
      }
      if (d.y >= GROUND) {
        d.state = 'missed';
        if (d.kind === 'coin') this.fx.burst(d.x, GROUND, 4, { colors: [PAL.gold], speed: [20, 50], gravity: 200, size: [1, 2] });
      }
    }
  }

  protected react(dt: number): void {
    for (const d of this.drops) if (d.state === 'fall') d.y = Math.min(GROUND, d.y + this.speed * dt * 0.4);
  }

  draw(g: Gfx): void {
    const time = this.clock;
    for (const c of this.clouds) {
      const x = ((c.x + time * c.v) % (W + 60)) - 30;
      g.circle(x, c.y, c.r, PAL.ink);
      g.circle(x + c.r, c.y + 3, c.r * 0.8, PAL.ink);
      g.circle(x - c.r, c.y + 4, c.r * 0.7, PAL.ink);
    }
    g.rect(0, GROUND, W, H - GROUND, PAL.lime);
    g.rect(0, GROUND, W, 2, PAL.cab);

    // falling things
    for (const d of this.drops) {
      if (d.state === 'wait' || d.state === 'caught') continue;
      const a = d.state === 'missed' ? 0 : 1;
      if (!a) continue;
      if (d.kind === 'coin') {
        const rx = Math.max(1.2, 5.5 * Math.abs(Math.cos(d.spin)));
        g.ellipse(d.x, d.y, rx, 5.5, PAL.gold, PAL.cab, 1.5);
        if (rx > 3) g.rect(d.x - 1, d.y - 3, 1.5, 4, PAL.ink);
      } else {
        g.at(d.x, d.y, 1, d.spin * 0.3, () => {
          g.poly([-7, -2, -3, -7, 4, -6, 7, -1, 5, 6, -4, 7], PAL.dim, PAL.cab, 1.5);
          g.rect(-3, -2, 2, 2, PAL.cab);
          g.rect(2, -2, 2, 2, PAL.cab);
        });
      }
    }

    // the partner rides in its basket, head and arms over the rim
    const won = this.status === 'won';
    const hop = won ? -Math.abs(Math.sin(this.since * 9)) * 8 : 0;
    const bx = this.px;
    const top = RIM + hop;
    g.ellipse(this.px, GROUND + 1, this.half + 4, 3, 'rgba(20,11,11,0.3)');
    g.ellipse(bx, top + 1, this.half + 2, 3, '#7a5200');
    const ph = this.ctx.partner.artBox[3] * this.pk;
    g.sprite(this.ctx.partner, bx, top + Math.min(10, ph * 0.4) + Math.sin(time * 8) * 0.8, { k: this.pk });
    g.poly([bx - this.half - 3, top, bx + this.half + 3, top, bx + this.half - 3, top + 18, bx - this.half + 3, top + 18], PAL.goldDark, PAL.cab, 2);
    for (let i = 1; i < 4; i++) g.line(bx - this.half + i * ((this.half * 2) / 4), top + 2, bx - this.half + 2 + i * ((this.half * 2 - 4) / 4), top + 16, '#9c6d00', 1);
    g.rect(bx - this.half - 4, top - 1, this.half * 2 + 8, 3, PAL.cab);
    // coins already in the basket
    for (let i = 0; i < Math.min(this.caught, 3); i++) g.ellipse(bx - 8 + i * 8, top - 2, 4, 3, PAL.gold, PAL.cab, 1);

    // counter
    for (let i = 0; i < this.need; i++) {
      const x = 160 - (this.need - 1) * 9 + i * 18;
      g.ellipse(x, 14, 5.5, 5.5, i < this.caught ? PAL.gold : 'rgba(20,11,11,0.25)', PAL.cab, 1.5);
    }
    if (this.hit) g.text('ROCK!', this.px, RIM - 16, { size: 6, color: PAL.cab });
    this.fx.draw(g);
  }

  /** Seconds until a drop reaches the rim. */
  private eta(d: Drop): number {
    return d.state === 'wait' ? d.at - this.t + (RIM - TOP) / this.speed : (RIM - d.y) / this.speed;
  }

  protected botPlay(): FrameInput {
    const coin = this.drops.filter((d) => d.kind === 'coin' && (d.state === 'fall' || d.state === 'wait') && d.y < RIM).sort((a, b) => a.at - b.at)[0];
    if (!coin) return botIdle();
    let target = coin.x;
    const minX = this.half + 4;
    const maxX = W - this.half - 4;
    // Never be under a rock when it lands (rocks that land after the next coin can wait).
    for (const r of this.drops) {
      if (r.kind !== 'rock' || r.state !== 'fall' || r.y >= RIM || this.eta(r) > this.eta(coin)) continue;
      const lo = r.x - this.half - 14;
      const hi = r.x + this.half + 14;
      const under = (x: number) => x > lo && x < hi;
      const crosses = (this.px - r.x) * (target - r.x) < 0;
      if (!under(target) && !(crosses && this.eta(r) < 0.35)) continue;
      const sides = [lo, hi].filter((x) => x >= minX && x <= maxX).sort((a, b) => Math.abs(a - this.px) - Math.abs(b - this.px));
      target = sides[0] ?? (lo < minX ? hi : lo);
    }
    return botPoint(clamp(target, minX, maxX));
  }

}
