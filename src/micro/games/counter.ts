// COUNTER! A Beast with a big type badge charges from the right. Press the type that beats it:
// A = MAGIC, B = HUNTER, C = BRUTE (or tap the buttons). Magic beats Brute beats Hunter beats Magic.
import type { BeastType, RosterEntry } from '../../data/roster.ts';
import { artScale, asType, BUTTON_TYPE, counterOf, TYPE_BUTTON, type TypeButton } from '../cast.ts';
import { H, PAL, W, type Gfx } from '../gfx.ts';
import type { FrameInput, GameCtx } from '../types.ts';
import { BaseGame, botIdle, botPress, clamp, easeIn, typePress, vrand } from './base.ts';
import { abcPad, drawPad, drawShot, drawTriangle, shotPos, type Shot } from './kit.ts';

const GROUND = 138;
const HOME_X = 46;

interface Charger {
  e: RosterEntry;
  type: BeastType;
  k: number;
  w: number;
  h: number;
  x: number;
  /** Play time it started running (-1 = waiting off screen). */
  start: number;
  state: 'wait' | 'run' | 'ko' | 'rammed';
  /** Ambient clock time the KO flight starts (when the shot lands). */
  koClock: number;
}

export class CounterGame extends BaseGame {
  readonly id = 'counter' as const;
  readonly prompt = 'COUNTER!';
  readonly hint = 'abc' as const;
  readonly bg = PAL.ink;
  readonly chargers: Charger[];
  /** Seconds each charger takes from the right edge to the partner. */
  readonly run: number;
  /** Wrong presses forgiven (speed 1 only). */
  readonly forgive: number;
  readonly showTriangle: boolean;
  readonly pad = abcPad(152, 10, 52);
  readonly pk: number;
  idx = 0;
  wrong = 0;
  shots: Shot[] = [];
  lit: { b: TypeButton | null; age: number } = { b: null, age: 9 };
  private readonly lines: { y: number; len: number; speed: number; off: number }[];
  private botNext = 0;

  constructor(ctx: GameCtx) {
    super(ctx);
    const L = this.level;
    const n = L >= 4 ? 3 : L >= 2 ? 2 : 1;
    let prev = -1;
    this.chargers = [];
    for (let i = 0; i < n; i++) {
      let type = asType(this.rng.int(0, 2));
      if (type === prev) type = asType((type + this.rng.int(1, 2)) % 3);
      prev = type;
      const e = ctx.cast.ofType(this.rng, type, 0.5);
      const k = artScale(e, 56);
      this.chargers.push({ e, type, k, w: e.artBox[2] * k, h: e.artBox[3] * k, x: W + 40, start: i === 0 ? 0 : -1, state: i === 0 ? 'run' : 'wait', koClock: 0 });
    }
    this.cast = this.chargers.map((c) => c.e);
    this.run = (this.duration * 0.9) / n;
    this.forgive = L === 0 ? 1 : 0;
    this.showTriangle = ctx.seenBefore < 2;
    this.pk = artScale(ctx.partner, 32);
    this.lines = Array.from({ length: 9 }, (_, i) => ({ y: 18 + i * 13 + this.rng.int(-3, 3), len: this.rng.int(18, 60), speed: this.rng.int(140, 260), off: this.rng.range(0, W) }));
    this.botNext = this.botReaction();
  }

  /** The demo player's reaction time: human-ish, but always inside the charge window. */
  private botReaction(): number {
    return clamp(this.run * 0.42, 0.22, 0.7) * this.rng.range(0.85, 1.1);
  }

  get front(): Charger | null {
    return this.chargers[this.idx] ?? null;
  }

  /** x of a running charger at time t: accelerates toward the partner. */
  private chargeX(c: Charger, t: number): number {
    const u = clamp((t - c.start) / this.run, 0, 1);
    const x0 = W + c.w / 2 + 4;
    const x1 = HOME_X + 20 + c.w / 2;
    return x0 + (x1 - x0) * (0.55 * u + 0.45 * easeIn(u));
  }

  protected play(dt: number, input: FrameInput): void {
    this.tick(dt);
    const c = this.front;
    if (!c) return;
    c.x = this.chargeX(c, this.t);
    const press = typePress(input, this.pad);
    if (press) {
      this.lit = { b: press, age: 0 };
      const need = counterOf(c.type);
      const ok = BUTTON_TYPE[press] === need;
      this.shots.push({ x0: HOME_X + 10, y0: GROUND - 18, x1: c.x - c.w / 4, y1: GROUND - c.h / 2, t: 0, dur: 0.13, type: BUTTON_TYPE[press], bounce: !ok });
      if (ok) {
        c.state = 'ko';
        c.koClock = this.clock + 0.12;
        this.audio.hit(3 + this.idx);
        this.audio.kill(2 + this.idx);
        this.bump(3, 0.06);
        this.fx.pop(c.x, GROUND - c.h - 16, 'COUNTER!', PAL.cab, 8);
        this.fx.burst(c.x, GROUND - c.h / 2, 18, { colors: [PAL.hot, PAL.gold, PAL.cyan, PAL.cab], speed: [70, 180], kind: 'star', size: [1, 2] });
        this.idx++;
        const next = this.front;
        if (next) {
          next.state = 'run';
          next.start = this.t + 0.25;
          this.botNext = next.start + this.botReaction();
        } else this.win();
        return;
      }
      this.wrong++;
      this.audio.sfx('denied');
      this.fx.pop(c.x, GROUND - c.h - 16, 'RESIST!', PAL.hot, 8);
      if (this.wrong > this.forgive) {
        c.state = 'rammed';
        this.bump(6);
        this.lose();
        return;
      }
    }
    if (c.state === 'run' && this.t >= c.start + this.run) {
      c.state = 'rammed';
      this.audio.thud();
      this.bump(6);
      this.lose();
    }
    if (c.state === 'run' && this.t > c.start && Math.random() < 0.5) this.fx.dust(c.x + c.w / 2, GROUND, 1, -1);
  }

  private tick(dt: number) {
    this.lit.age += dt;
    for (const s of this.shots) s.t += dt;
    this.shots = this.shots.filter((s) => !shotPos(s).done);
  }

  protected react(dt: number): void {
    this.tick(dt);
  }

  protected ambient(): void {
    if (this.status === 'won' && Math.random() < 0.2) this.fx.burst(HOME_X + vrand(-8, 8), GROUND - 34, 1, { colors: [PAL.gold], kind: 'star', speed: [10, 30], size: [1, 1.5] });
  }

  draw(g: Gfx): void {
    const time = this.clock;
    // speed lines rushing left
    for (const l of this.lines) {
      const x = W - ((l.off + time * l.speed) % (W + l.len));
      g.rect(x, l.y, l.len, 2, PAL.inkDark);
    }
    // ground strip and the pad
    g.rect(0, GROUND, W, H - GROUND, PAL.cab);
    g.rect(0, GROUND, W, 2, PAL.hot);
    for (let i = 0; i < 12; i++) g.rect(((i * 31 - time * 220) % (W + 31) + W + 31) % (W + 31) - 31, GROUND + 6, 14, 1, '#3a2522');

    // the partner holds the line
    const lost = this.status === 'lost';
    const knock = lost ? clamp(this.since * 4, 0, 1) : 0;
    const bob = this.status === 'won' ? -Math.abs(Math.sin(this.since * 10)) * 8 : Math.sin(time * 6) * 1;
    g.ellipse(HOME_X, GROUND + 1, 12, 3, 'rgba(20,11,11,0.35)');
    g.sprite(this.ctx.partner, HOME_X - knock * 30, GROUND + bob - knock * 10, { k: this.pk, rot: -knock * 1.2, mode: lost && this.since < 0.1 ? 'white' : 'art' });

    // chargers
    for (const c of this.chargers) {
      if (c.state === 'wait') continue;
      if (c.state === 'ko' && this.clock >= c.koClock) {
        const k = this.clock - c.koClock;
        const fx = c.x + k * 240;
        const fy = GROUND - k * 260 + k * k * 300;
        g.sprite(c.e, fx, fy, { k: c.k, rot: k * 14, anchor: 'center', mode: k < 0.08 ? 'white' : 'art' });
        continue;
      }
      const running = c.state === 'run' && this.t >= c.start;
      const bob2 = running ? -Math.abs(Math.sin(time * 16)) * 4 : 0;
      const ramX = c.state === 'rammed' ? -this.since * 60 : 0;
      g.ellipse(c.x + ramX, GROUND + 1, c.w / 2.4, 3, 'rgba(20,11,11,0.35)');
      g.sprite(c.e, c.x + ramX, GROUND + bob2, { k: c.k, flip: true });
      if (c === this.front && c.state !== 'ko') {
        // The badge stays on screen even while its Beast is still coming in from the edge.
        const pulse = 1 + Math.max(0, Math.sin(time * 10)) * 0.06;
        g.at(Math.min(c.x + ramX, W - 42), GROUND - c.h - 16, pulse, 0, () => g.badge(c.type, 0, 0, true));
      }
    }
    for (const s of this.shots) drawShot(g, s, time);

    drawPad(g, this.pad, this.lit);
    if (this.showTriangle) drawTriangle(g, 48, 46);
    if (this.forgive > 0 && this.status === 'playing') g.text(this.wrong ? 'LAST TRY' : '1 FREE MISS', 160, 14, { size: 6, color: PAL.cab });
    this.fx.draw(g);
  }

  protected botPlay(): FrameInput {
    const c = this.front;
    if (!c || c.state !== 'run' || this.t < this.botNext || this.t < c.start) return botIdle();
    this.botNext = 99;
    return botPress(TYPE_BUTTON[counterOf(c.type)]);
  }
}
