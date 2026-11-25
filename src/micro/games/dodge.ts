// DODGE! A giant Brute stomps down where you stand. Its shadow warns you first. Move (pointer or
// LEFT/RIGHT) and survive every slam.
import type { RosterEntry } from '../../data/roster.ts';
import { artScale } from '../cast.ts';
import { H, PAL, W, type Gfx } from '../gfx.ts';
import type { FrameInput, GameCtx } from '../types.ts';
import { BaseGame, botIdle, botPoint, clamp, easeIn, steer } from './base.ts';
import { drawSlamShadow, Slam } from './kit.ts';

const GROUND = 150;
/** Brute's bottom edge while hovering: its legs loom over the top of the screen. */
const HOVER = 46;
const LEAD = 0.35;

export class DodgeGame extends BaseGame {
  readonly id = 'dodge' as const;
  readonly prompt = 'DODGE!';
  readonly hint = 'move' as const;
  readonly bg = PAL.gold;
  readonly brute: RosterEntry;
  readonly bk: number;
  readonly bw: number;
  readonly bh: number;
  /** Half width of the danger zone under the feet. */
  readonly halfW: number;
  readonly slams: number;
  readonly slam: Slam;
  readonly pk: number;
  readonly pw: number;
  readonly keySpeed: number;
  px = 160;
  squashed = false;
  private nextAt = LEAD;
  private botTarget = 160;

  constructor(ctx: GameCtx) {
    super(ctx);
    const L = this.level;
    this.brute = ctx.cast.ofType(this.rng, 2, 0.6);
    this.cast = [this.brute];
    this.bk = artScale(this.brute, 104);
    this.bw = this.brute.artBox[2] * this.bk;
    this.bh = this.brute.artBox[3] * this.bk;
    this.halfW = clamp(this.bw * 0.36, 26, 44);
    const want = L >= 2 ? 3 : 2;
    // Fit every slam in the time: telegraph about 55% of each slot, never shorter than 0.36 s.
    const fit = Math.max(1, Math.floor((this.duration - LEAD - 0.15) / 0.66));
    this.slams = Math.min(want, fit);
    const slot = (this.duration - LEAD - 0.15) / this.slams;
    this.slam = new Slam(Math.max(0.36, slot * 0.55), slot * 0.17, slot * 0.2, L >= 3 ? 0.45 : 0, 90 + 12 * L);
    this.pk = artScale(ctx.partner, 32);
    this.pw = ctx.partner.artBox[2] * this.pk;
    this.keySpeed = 210 + 22 * L;
    this.px = this.rng.range(110, 210);
    this.slam.x = clamp(this.px + this.rng.range(-40, 40), this.halfW, W - this.halfW);
  }

  /** Between slams the Brute drifts over the player, so every stomp starts from above them. */
  private hover(dt: number): void {
    if (this.slam.busy) return;
    const step = 150 * dt;
    this.slam.x = clamp(this.slam.x + clamp(this.px - this.slam.x, -step, step), this.halfW, W - this.halfW);
  }

  protected play(dt: number, input: FrameInput): void {
    this.px = steer(this.px, input, dt, this.keySpeed, this.pw / 2 + 2, W - this.pw / 2 - 2);
    this.hover(dt);
    if (!this.slam.busy && this.slam.count < this.slams && this.t >= this.nextAt) {
      this.slam.start(clamp(this.px, this.halfW, W - this.halfW));
      this.audio.warn(clamp((this.px - 160) / 160, -1, 1));
      this.botTarget = this.slam.x > 160 ? this.slam.x - this.halfW - 56 : this.slam.x + this.halfW + 56;
    }
    const impact = this.slam.update(dt, this.px, this.halfW, W - this.halfW);
    if (impact) {
      this.audio.thud();
      this.bump(7, 0.05);
      this.fx.dust(this.slam.x - this.halfW, GROUND, 8, 1);
      this.fx.dust(this.slam.x + this.halfW, GROUND, 8, -1);
      this.fx.pop(this.slam.x, GROUND - 40, 'STOMP!', PAL.cab, 10);
      if (Math.abs(this.px - this.slam.x) < this.halfW + this.pw * 0.3) {
        this.squashed = true;
        this.lose();
        return;
      }
      if (this.slam.count >= this.slams) {
        this.fx.pop(this.px, GROUND - 44, 'SAFE!', PAL.cab, 10);
        this.win();
        return;
      }
      this.nextAt = this.t + this.slam.down + this.slam.lift;
    }
  }

  protected react(dt: number): void {
    this.slam.update(dt, this.px, this.halfW, W - this.halfW);
  }

  /** Surviving until the bell is a win. */
  expire(): void {
    if (this.status === 'playing') this.win();
  }

  /** Bottom edge of the Brute right now. */
  private bruteY(): number {
    const s = this.slam;
    switch (s.phase) {
      case 'tele':
        return HOVER + 18 * easeIn(s.teleFrac);
      case 'drop':
        return HOVER + 18 + (GROUND - HOVER - 18) * clamp(s.t / 0.09, 0, 1);
      case 'down':
        return GROUND;
      case 'lift':
        return GROUND - (GROUND - HOVER) * easeIn(clamp(s.t / s.lift, 0, 1));
      default:
        return HOVER;
    }
  }

  draw(g: Gfx): void {
    const time = this.clock;
    g.alpha(0.25, () => g.stripes(PAL.goldDark, 10, time * 8, 0.35));
    g.rect(0, GROUND, W, H - GROUND, PAL.goldDark);
    g.rect(0, GROUND, W, 2, PAL.cab);
    for (let i = 0; i < 10; i++) g.rect((i * 33 + 7) % W, GROUND + 9 + (i % 3) * 6, 9, 2, '#b98500');

    drawSlamShadow(g, this.slam, GROUND, this.halfW, true);

    // the partner
    const won = this.status === 'won';
    const pb = won ? -Math.abs(Math.sin(this.since * 9)) * 10 : Math.abs(Math.sin(time * 14)) * -1.5;
    if (!this.squashed) {
      g.ellipse(this.px, GROUND + 1, this.pw / 2.4, 2.5, 'rgba(20,11,11,0.35)');
      g.sprite(this.ctx.partner, this.px, GROUND + pb, { k: this.pk });
      if (this.slam.phase === 'tele' && Math.abs(this.px - this.slam.x) < this.halfW + this.pw * 0.3) {
        g.text('!', this.px, GROUND - this.pk * this.ctx.partner.artBox[3] - 10, { size: 10, color: PAL.hot, outline: PAL.cab, ow: 2 });
      }
    } else {
      g.sprite(this.ctx.partner, this.px, GROUND, { k: this.pk, sy: 0.22, sx: 1.6 });
    }

    // the Brute hanging above, feet first
    const by = this.bruteY();
    const shake = this.slam.phase === 'tele' ? Math.sin(time * 60) * 1.2 : 0;
    g.sprite(this.brute, this.slam.x + shake, by, { k: this.bk });

    // stomps still to survive
    const left = this.slams - this.slam.count;
    for (let i = 0; i < this.slams; i++) {
      const x = 160 - (this.slams - 1) * 10 + i * 20;
      const on = i < left;
      g.circle(x, 13, 8, on ? PAL.cab : 'rgba(20,11,11,0.18)');
      g.icon('brute', x, 13, 1, on ? PAL.gold : 'rgba(20,11,11,0.3)', on ? PAL.ink : 'rgba(20,11,11,0.3)');
    }
    if (this.squashed && this.status === 'lost') g.text('SQUISH', this.px, GROUND - 16, { size: 8, color: PAL.hot, outline: PAL.cab, ow: 2 });
    this.fx.draw(g);
  }

  protected botPlay(): FrameInput {
    if (this.slam.phase === 'tele' || this.slam.phase === 'drop') return botPoint(clamp(this.botTarget, 24, W - 24));
    return botIdle();
  }
}
