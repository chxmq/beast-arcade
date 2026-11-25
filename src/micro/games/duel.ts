// DUEL! Two Beasts of different types face off. Tap the one that wins by the triangle
// (LEFT/RIGHT on the joystick pick a side too).
import type { BeastType, RosterEntry } from '../../data/roster.ts';
import { artScale, asType, beats } from '../cast.ts';
import { H, PAL, W, type Gfx } from '../gfx.ts';
import type { FrameInput, GameCtx } from '../types.ts';
import { BaseGame, botIdle, botTap, clamp, easeOut, inBox, vrand } from './base.ts';
import { drawTriangle } from './kit.ts';

export const GROUND = 140;
const SIDE_X = [84, 236];

interface Fighter {
  e: RosterEntry;
  type: BeastType;
  k: number;
  w: number;
  h: number;
}

export class DuelGame extends BaseGame {
  readonly id = 'duel' as const;
  readonly prompt = 'DUEL!';
  readonly hint = 'tap' as const;
  readonly bg = PAL.hot;
  /** fighters[0] starts on the left. */
  readonly fighters: [Fighter, Fighter];
  /** Index (into fighters) of the one that wins by the triangle. */
  readonly winner: 0 | 1;
  /** Faster speeds: the two swap sides once before you can be sure. */
  readonly swapAt: number;
  readonly swapDur = 0.38;
  readonly showTriangle: boolean;
  picked: 0 | 1 | null = null;
  private readonly botAt: number;
  private botDone = false;

  constructor(ctx: GameCtx) {
    super(ctx);
    const L = this.level;
    const ta = asType(this.rng.int(0, 2));
    const tb = asType((ta + this.rng.int(1, 2)) % 3);
    const make = (t: BeastType): Fighter => {
      const e = ctx.cast.ofType(this.rng, t, 0.6);
      const k = artScale(e, 64);
      return { e, type: t, k, w: e.artBox[2] * k, h: e.artBox[3] * k };
    };
    const a = make(ta);
    let b = make(tb);
    if (b.e.speciesId === a.e.speciesId) b = make(tb);
    this.fighters = [a, b];
    this.cast = [a.e, b.e];
    this.winner = beats(ta, tb) ? 0 : 1;
    this.swapAt = L >= 3 ? 0.2 : -1;
    this.showTriangle = ctx.seenBefore < 2;
    this.botAt = (L >= 3 ? 0.65 : 0) + this.rng.range(0.6, 0.85);
  }

  /** 0..1 progress of the side swap (0 = original sides). */
  private swapK(t: number): number {
    if (this.swapAt < 0) return 0;
    return easeOut((t - this.swapAt) / this.swapDur);
  }

  /** Centre x and hop of fighter i at play time t. */
  pos(i: 0 | 1, t: number): { x: number; lift: number } {
    const k = this.swapK(t);
    const from = SIDE_X[i];
    const to = SIDE_X[1 - i];
    return { x: from + (to - from) * k, lift: Math.sin(k * Math.PI) * (i === 0 ? 34 : 18) };
  }

  /** Which fighter stands on screen side s (0 left, 1 right) right now. */
  onSide(s: 0 | 1): 0 | 1 {
    const k = this.swapK(this.t);
    const swapped = k >= 0.5;
    return (swapped ? 1 - s : s) as 0 | 1;
  }

  protected play(_dt: number, input: FrameInput): void {
    if (this.swapAt >= 0 && this.t < this.swapAt + this.swapDur) {
      // still shuffling: taps during the swap are ignored, so nobody can tap blind
      return;
    }
    let pick: 0 | 1 | null = null;
    for (const p of input.presses) {
      if (p === 'LEFT') pick = this.onSide(0);
      if (p === 'RIGHT') pick = this.onSide(1);
    }
    for (const tap of input.taps) {
      for (const i of [0, 1] as const) {
        const f = this.fighters[i];
        const { x } = this.pos(i, this.t);
        if (inBox(tap, x, GROUND - f.h / 2, f.w, f.h, 8)) pick = i;
      }
      if (pick === null) this.fx.ring(tap.x, tap.y, PAL.cab, 2, 10, 0.25);
    }
    if (pick === null) return;
    this.picked = pick;
    const loserIdx = (1 - this.winner) as 0 | 1;
    const lx = this.pos(loserIdx, this.t).x;
    const lf = this.fighters[loserIdx];
    if (pick === this.winner) {
      this.audio.hit(5);
      this.audio.kill(4);
      this.bump(4, 0.08);
      this.fx.burst(lx, GROUND - lf.h / 2, 26, { colors: [PAL.gold, PAL.ink, PAL.cab], speed: [70, 200], kind: 'star', size: [1, 2] });
      this.fx.pop(this.pos(this.winner, this.t).x, GROUND - this.fighters[this.winner].h - 22, 'WINNER!', PAL.ink, 10);
      this.win();
    } else {
      this.audio.sfx('denied');
      this.bump(5);
      this.fx.pop(this.pos(pick, this.t).x, GROUND - this.fighters[pick].h - 22, 'WRONG!', PAL.ink, 10);
      this.lose();
    }
  }

  protected ambient(): void {
    if (this.status === 'playing' && Math.random() < 0.35) this.fx.burst(160 + vrand(-6, 6), 104 + vrand(-10, 10), 1, { colors: [PAL.gold, PAL.ink], speed: [20, 60], kind: 'sq', size: [1, 2], life: [0.2, 0.4] });
  }

  draw(g: Gfx): void {
    const time = this.clock;
    // versus split: red left, gold right, with a jagged seam
    g.rect(0, 0, W, H, PAL.hot);
    const seam: number[] = [W / 2 + 26, -5];
    for (let y = 0; y <= H + 10; y += 15) seam.push(W / 2 + (Math.floor(y / 15) % 2 ? -10 : 10) - (y / H) * 52 + 26, y);
    seam.push(W + 10, H + 10, W + 10, -5);
    g.poly(seam, PAL.gold);
    g.alpha(0.18, () => g.stripes(PAL.cab, 8, time * 30, 0.6));
    g.rect(0, GROUND, W, H - GROUND, PAL.cab);
    g.rect(0, GROUND, W, 2, PAL.ink);

    // VS
    const vsK = 1 + Math.max(0, Math.sin(time * 9)) * 0.1;
    g.at(160, 104, vsK, -0.12, () => g.text('VS', 0, 0, { size: 24, color: PAL.ink, outline: PAL.cab, ow: 3, shadow: PAL.cab, sd: 3 }));

    const decided = this.status !== 'playing';
    const winX = this.pos(this.winner, this.t).x;
    for (const i of [0, 1] as const) {
      const f = this.fighters[i];
      const { x, lift } = this.pos(i, this.t);
      const facingLeft = x > 160;
      let dx = 0;
      let dy = -lift;
      let rot = 0;
      let mode: 'art' | 'white' = 'art';
      if (decided) {
        // The tapped one either wins or gets knocked out; the other reacts.
        const loser = this.status === 'won' ? 1 - this.winner : this.picked;
        const k = clamp(this.since * 3, 0, 1);
        if (i === loser) {
          const dir = x < 160 ? -1 : 1;
          dx = dir * k * 140;
          dy = -Math.sin(k * Math.PI) * 50 + k * 30;
          rot = dir * k * 7;
          if (this.since < 0.08) mode = 'white';
        } else {
          const lunge = Math.sin(clamp(this.since * 5, 0, 1) * Math.PI);
          dx = (x < 160 ? 1 : -1) * lunge * 46;
          dy = -Math.abs(Math.sin(this.since * 8)) * 6 * k;
        }
      } else {
        dy += Math.sin(time * 5 + i * 2) * 1.5;
      }
      g.ellipse(x + dx, GROUND + 1, f.w / 2.4, 3.5, 'rgba(20,11,11,0.4)');
      g.sprite(f.e, x + dx, GROUND + dy, { k: f.k, flip: facingLeft, rot: rot || undefined, mode });
      if (!decided || i === this.winner) {
        const by = GROUND - f.h - 15 + dy * (decided ? 1 : 0.5);
        g.badge(f.type, x + dx, by, true, decided && i !== this.winner ? 0.4 : 1);
      }
      if (decided && i === this.winner && this.status === 'won') g.crown(x + dx, GROUND - f.h - 28 + dy, 1);
    }
    if (decided && this.status === 'lost') {
      // show who should have won
      g.text('THIS ONE', winX, GROUND + 22, { size: 6, color: PAL.gold });
    }
    if (this.showTriangle) drawTriangle(g, 160, 36, 0.94);
    this.fx.draw(g);
  }

  protected botPlay(t: number): FrameInput {
    if (this.botDone || t < this.botAt) return botIdle();
    this.botDone = true;
    const f = this.fighters[this.winner];
    return botTap(this.pos(this.winner, this.t).x, GROUND - f.h / 2);
  }
}
