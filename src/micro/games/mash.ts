// MASH! A King Beast sleeps in its egg. Mash A (or tap) to fill the bar and hatch it in time.
import type { RosterEntry } from '../../data/roster.ts';
import { artScale, kingTitle } from '../cast.ts';
import { PAL, TYPE_COLOR, type Gfx } from '../gfx.ts';
import type { FrameInput, GameCtx } from '../types.ts';
import { BaseGame, botIdle, botPress, clamp, easeBack, vrand } from './base.ts';

const EX = 160;
const EY = 88;
const RX = 34;
const RY = 44;
const BAR_X = 70;
const BAR_W = 180;
const BAR_Y = 150;

export class MashGame extends BaseGame {
  readonly id = 'mash' as const;
  readonly prompt = 'MASH!';
  readonly hint = 'mash' as const;
  readonly bg = PAL.hot;
  readonly king: RosterEntry;
  readonly kk: number;
  /** Presses needed, and how fast the bar drains at higher speeds (presses per second). */
  readonly need: number;
  readonly decay: number;
  power = 0;
  presses = 0;
  private wob = 0;
  private lastPress = -9;
  private readonly spots: { a: number; r: number; s: number }[];
  private botNext = 0.15;

  constructor(ctx: GameCtx) {
    super(ctx);
    const L = this.level;
    this.king = ctx.cast.king(this.rng);
    this.cast = [this.king];
    this.kk = artScale(this.king, 72);
    this.need = Math.max(8, Math.round(this.duration * Math.min(6, 2.7 + 0.55 * L)));
    this.decay = L >= 2 ? Math.min(2, 1 + 0.2 * (L - 2)) : 0;
    this.spots = Array.from({ length: 6 }, () => ({ a: this.rng.range(0, Math.PI * 2), r: this.rng.range(0.2, 0.75), s: this.rng.range(4, 8) }));
  }

  get frac(): number {
    return clamp(this.power / this.need, 0, 1);
  }

  protected play(dt: number, input: FrameInput): void {
    let n = input.taps.length;
    for (const p of input.presses) if (p === 'A') n++;
    if (n > 0) {
      const before = this.frac;
      this.power += n;
      this.presses += n;
      this.wob = Math.min(1.2, this.wob + 0.45 * n);
      this.lastPress = this.clock;
      this.audio.wobble(Math.min(7, Math.floor(this.frac * 8)));
      for (const th of [1 / 3, 2 / 3]) if (before < th && this.frac >= th) {
        this.audio.sfx('crank');
        this.fx.burst(EX, EY - 10, 8, { colors: [PAL.ink, PAL.inkDark], speed: [40, 100], gravity: 260, size: [2, 3], life: [0.4, 0.7] });
        this.bump(2);
      }
      if (this.power >= this.need) {
        this.audio.sfx('pop');
        this.audio.sparkle();
        this.bump(4, 0.07);
        this.fx.burst(EX, EY, 34, { colors: [PAL.ink, PAL.inkDark, TYPE_COLOR[this.king.type]], speed: [80, 220], gravity: 300, size: [2, 4], life: [0.5, 0.9] });
        this.fx.burst(EX, EY - 20, 20, { colors: [PAL.gold, PAL.ink], speed: [40, 150], kind: 'star', size: [1, 2] });
        this.fx.ring(EX, EY, PAL.gold, 8, 80, 0.5, 3);
        this.win();
        return;
      }
    }
    this.power = Math.max(0, this.power - this.decay * dt);
    this.wob = Math.max(0, this.wob - dt * 3);
  }

  protected react(dt: number): void {
    this.wob = Math.max(0, this.wob - dt * 3);
  }

  protected ambient(): void {
    if (this.status !== 'won' && Math.random() < 0.03) this.fx.pop(EX + 30 + vrand(-4, 4), EY - RY + 4, 'z', PAL.ink, 6, 1.2);
    if (this.status === 'won' && Math.random() < 0.25) this.fx.burst(EX + vrand(-40, 40), EY + vrand(-50, 10), 1, { colors: [PAL.gold, PAL.ink], kind: 'star', speed: [5, 20], size: [1, 1.5] });
  }

  private eggPath(g: Gfx, top = true, bottom = true): void {
    const c = g.c;
    c.beginPath();
    // an egg: narrower on top
    const steps = 40;
    let first = true;
    for (let i = 0; i <= steps; i++) {
      const a = -Math.PI / 2 + (i / steps) * Math.PI * 2;
      const y = Math.sin(a);
      if ((!top && y < 0.05) || (!bottom && y > 0.05)) continue;
      const rx = RX * (y < 0 ? 0.86 + 0.14 * (1 + y) : 1);
      const px = EX + Math.cos(a) * rx;
      const py = EY + y * RY;
      if (first) c.moveTo(px, py);
      else c.lineTo(px, py);
      first = false;
    }
    c.closePath();
  }

  draw(g: Gfx): void {
    const time = this.clock;
    g.rays(EX, EY, 14, PAL.hotDark, time * 0.4);
    g.circle(EX, EY + RY + 6, 46, 'rgba(20,11,11,0.25)');
    g.ellipse(EX, EY + RY + 4, RX + 10, 6, 'rgba(20,11,11,0.45)');
    const won = this.status === 'won';
    const typeCol = TYPE_COLOR[this.king.type];

    if (!won) {
      const rot = Math.sin(time * 34) * 0.12 * this.wob + (this.status === 'lost' ? Math.sin(this.since * 3) * 0.05 : 0);
      g.at(EX, EY + RY, 1, rot, () => {
        g.at(-EX, -EY - RY, 1, 0, () => {
          this.eggPath(g);
          g.c.fillStyle = PAL.ink;
          g.c.fill();
          // the King asleep inside, a shadow through the shell
          g.c.save();
          this.eggPath(g);
          g.c.clip();
          g.sprite(this.king, EX, EY + 4, { k: this.kk, anchor: 'center', mode: 'dark', alpha: 0.16 + 0.1 * this.frac });
          for (const s of this.spots) g.circle(EX + Math.cos(s.a) * RX * s.r, EY + Math.sin(s.a) * RY * s.r, s.s, typeCol);
          g.c.restore();
          this.eggPath(g);
          g.c.strokeStyle = PAL.cab;
          g.c.lineWidth = 2.5;
          g.c.stroke();
          // cracks
          const f = this.frac;
          if (f > 1 / 3) this.crack(g, EX - 20, EY - 18, 6);
          if (f > 2 / 3) this.crack(g, EX - 30, EY + 6, 8);
        });
      });
      // floating crown
      g.crown(EX, EY - RY - 8 + Math.sin(time * 4) * 2, 2);
    } else {
      // hatched: shell halves fly apart, the King pops out crowned
      const k = this.since;
      const out = easeBack(k * 3);
      g.at(EX - k * 60, EY - k * 70 + k * k * 120, 1, -k * 4, () => g.at(-EX, -EY, 1, 0, () => {
        this.eggPath(g, true, false);
        g.c.fillStyle = PAL.ink;
        g.c.fill();
        g.c.strokeStyle = PAL.cab;
        g.c.lineWidth = 2;
        g.c.stroke();
      }));
      g.at(EX, EY + RY, 1, 0, () => g.at(-EX, -EY - RY, 1, 0, () => {
        this.eggPath(g, false, true);
        g.c.fillStyle = PAL.ink;
        g.c.fill();
        g.c.strokeStyle = PAL.cab;
        g.c.lineWidth = 2;
        g.c.stroke();
      }));
      const kh = this.king.artBox[3] * this.kk;
      g.at(EX, EY + 18, out, 0, () => {
        g.sprite(this.king, 0, 0, { k: this.kk, mode: k < 0.08 ? 'white' : 'art' });
        g.crown(0, -kh - 2 + Math.sin(time * 6) * 1.5, 2);
      });
      g.text(kingTitle(this.king), EX, 34, { size: 8, color: PAL.gold, outline: PAL.cab, ow: 2, maxW: 300 });
    }

    // the bar
    const f = this.frac;
    g.rrect(BAR_X - 2, BAR_Y - 2, BAR_W + 4, 14, 3, PAL.cab);
    g.rrect(BAR_X, BAR_Y, Math.max(0, BAR_W * f), 10, 2, f >= 1 ? PAL.gold : PAL.lime);
    for (let i = 1; i < 10; i++) g.rect(BAR_X + (BAR_W * i) / 10, BAR_Y, 1, 10, 'rgba(20,11,11,0.35)');
    // the A button being mashed
    const down = time - this.lastPress < 0.07 || (this.status === 'playing' && Math.floor(time * 7) % 2 === 0);
    g.button('A', BAR_X + BAR_W + 22, BAR_Y + 4, 10, PAL.hot, down);
    g.text('MASH', BAR_X - 22, BAR_Y + 5, { size: 6, color: PAL.ink, outline: PAL.cab, ow: 1.5 });
    if (this.status === 'lost') g.text('STILL ASLEEP...', EX, 34, { size: 8, color: PAL.ink, outline: PAL.cab, ow: 2 });
    this.fx.draw(g);
  }

  private crack(g: Gfx, x: number, y: number, n: number): void {
    const c = g.c;
    c.beginPath();
    c.moveTo(x, y);
    for (let i = 1; i <= n; i++) c.lineTo(x + i * 7, y + (i % 2 ? -5 : 4));
    c.strokeStyle = PAL.cab;
    c.lineWidth = 1.5;
    c.stroke();
  }

  protected botPlay(t: number): FrameInput {
    if (t < this.botNext) return botIdle();
    this.botNext = t + 0.1;
    return botPress('A');
  }
}
