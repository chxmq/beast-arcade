// BOSS: KING FIGHT. A giant King Beast (a tier 1 Art Hackathon species) with an HP bar. Its type
// stance changes every ~1.2 s: press the counter (A MAGIC, B HUNTER, C BRUTE) to land hits.
// Now and then it leaps and slams where you stand: dodge with the pointer or LEFT/RIGHT.
import type { BeastType, RosterEntry } from '../../data/roster.ts';
import { artistOf } from '../../game/beasts.ts';
import { artScale, asType, BUTTON_TYPE, counterOf, kingTitle, TYPE_BUTTON, type TypeButton } from '../cast.ts';
import { H, HEART_EMPTY, PAL, W, type Gfx } from '../gfx.ts';
import type { FrameInput, GameCtx } from '../types.ts';
import { BaseGame, botPoint, botPress, clamp, easeIn, easeOut, steer, vrand } from './base.ts';
import { abcPad, drawPad, drawShot, drawSlamShadow, shotPos, Slam, type Shot } from './kit.ts';

const FLOOR = 142;
const HOME_X = 214;
const PLAYER_Y = 142;
const HEARTS = 3;

export class BossGame extends BaseGame {
  readonly id = 'boss' as const;
  readonly prompt = 'KING FIGHT!';
  readonly hint = 'boss' as const;
  readonly bg = PAL.screen;
  readonly king: RosterEntry;
  readonly artist: string;
  readonly kk: number;
  readonly kw: number;
  readonly kh: number;
  readonly maxHp: number;
  readonly stanceEvery: number;
  readonly slamEvery: number;
  readonly slam: Slam;
  readonly halfW = 34;
  readonly pad = abcPad(166, 8, 40);
  readonly pk: number;
  readonly pw: number;
  readonly keySpeed: number;
  hp: number;
  stance: BeastType;
  /** Play time of the last stance change. */
  stanceAt = 0;
  hearts = HEARTS;
  px = 80;
  /** Timers (play seconds): invulnerable after a hit, stunned after a wrong press, attack cooldown. */
  inv = 0;
  stun = 0;
  cool = 0;
  hits = 0;
  shots: Shot[] = [];
  lit: { b: TypeButton | null; age: number } = { b: null, age: 9 };
  private flashAt = -9;
  private nextSlam: number;
  private botAt = 0;
  private botFlee = 0;

  constructor(ctx: GameCtx) {
    super(ctx);
    const L = this.level;
    this.king = ctx.cast.king(this.rng);
    this.cast = [this.king];
    this.artist = artistOf(this.king);
    this.kk = artScale(this.king, 112);
    this.kw = this.king.artBox[2] * this.kk;
    this.kh = this.king.artBox[3] * this.kk;
    this.maxHp = L >= 7 ? 14 : L >= 5 ? 12 : 10;
    this.hp = this.maxHp;
    this.stance = asType(this.king.type);
    const pace = Math.pow(0.92, Math.max(0, L - 3));
    this.stanceEvery = Math.max(0.75, 1.2 * pace);
    this.slamEvery = Math.max(1.9, 2.9 * pace);
    this.slam = new Slam(Math.max(0.45, 0.75 * pace), 0.32, 0.4, 0.5, 120);
    this.nextSlam = 2.2;
    this.pk = artScale(ctx.partner, 32);
    this.pw = ctx.partner.artBox[2] * this.pk;
    this.keySpeed = 230 + 15 * L;
    this.botAt = 0.4;
  }

  /** The King can be hit while it stands at home or sits in its own slam crater. */
  get vulnerable(): boolean {
    return this.slam.phase === 'idle' || this.slam.phase === 'down';
  }

  /** Where the King is: x, bottom y. */
  kingPos(): { x: number; y: number } {
    const s = this.slam;
    switch (s.phase) {
      case 'tele': {
        // it leapt off screen; the shadow follows the player
        return { x: s.x, y: -40 };
      }
      case 'drop':
        return { x: s.x, y: -40 + (FLOOR + 40) * clamp(s.t / 0.09, 0, 1) };
      case 'down':
        return { x: s.x, y: FLOOR };
      case 'lift': {
        const k = easeOut(clamp(s.t / s.lift, 0, 1));
        return { x: s.x + (HOME_X - s.x) * k, y: FLOOR - Math.sin(k * Math.PI) * 40 };
      }
      default:
        return { x: HOME_X, y: FLOOR + (this.status === 'won' ? 0 : Math.sin(this.clock * 3) * 1.5) };
    }
  }

  protected play(dt: number, input: FrameInput): void {
    this.tick(dt);
    // Taps on the A B C pad must not drag the partner down to the buttons.
    const aim = input.pointer && input.pointer.y > 150 ? { ...input, pointer: null } : input;
    if (this.stun <= 0) this.px = steer(this.px, aim, dt, this.keySpeed, this.pw / 2 + 4, W - this.pw / 2 - 4);
    // stance changes
    if (this.t - this.stanceAt >= this.stanceEvery) {
      this.stance = asType((this.stance + this.rng.int(1, 2)) % 3);
      this.stanceAt = this.t;
      this.botAt = this.t + this.rng.range(0.28, 0.45);
    }
    // slams
    if (!this.slam.busy && this.t >= this.nextSlam) {
      this.slam.start(clamp(this.px, this.halfW, W - this.halfW));
      this.audio.warn(clamp((this.px - 160) / 160, -1, 1));
      this.botFlee = this.px > 160 ? this.px - 110 : this.px + 110;
    }
    const wasBusy = this.slam.busy;
    const impact = this.slam.update(dt, this.px, this.halfW, W - this.halfW);
    if (wasBusy && !this.slam.busy) this.nextSlam = this.t + this.slamEvery;
    if (impact) {
      this.audio.thud();
      this.bump(7, 0.05);
      this.fx.dust(this.slam.x - this.halfW, FLOOR, 8, 1);
      this.fx.dust(this.slam.x + this.halfW, FLOOR, 8, -1);
      if (this.inv <= 0 && Math.abs(this.px - this.slam.x) < this.halfW + this.pw * 0.3) {
        this.hearts--;
        this.inv = 1.0;
        this.audio.sfx('denied');
        this.fx.pop(this.px, PLAYER_Y - 40, 'OUCH!', PAL.hot, 10);
        if (this.hearts <= 0) {
          this.lose();
          return;
        }
      }
    }

    // attacks
    const press = this.stun > 0 ? null : this.pressOf(input);
    if (press && this.cool <= 0) {
      this.lit = { b: press, age: 0 };
      this.cool = 0.2;
      const kp = this.kingPos();
      const target = { x: kp.x - this.kw * 0.2, y: kp.y - this.kh * 0.5 };
      const ok = BUTTON_TYPE[press] === counterOf(this.stance) && this.vulnerable;
      this.shots.push({ x0: this.px + 8, y0: PLAYER_Y - 18, x1: target.x, y1: target.y, t: 0, dur: 0.14, type: BUTTON_TYPE[press], bounce: !ok });
      if (ok) {
        this.hp--;
        this.hits++;
        this.flashAt = this.clock + 0.13;
        this.audio.hit(Math.min(10, this.hits));
        this.bump(2.5, 0.04);
        this.fx.burst(target.x, target.y, 10, { colors: [PAL.ink, PAL.gold, PAL.hot], speed: [60, 160], kind: 'star', size: [1, 2] });
        this.fx.pop(target.x + vrand(-10, 10), target.y - 20, 'HIT!', PAL.ink, 8);
        if (this.hp <= 0) {
          this.audio.kingKill();
          this.bump(8, 0.12);
          this.fx.burst(kp.x, kp.y - this.kh / 2, 50, { colors: [PAL.gold, PAL.hot, PAL.ink, PAL.cyan], speed: [80, 260], kind: 'star', size: [1, 3], life: [0.5, 1.1] });
          this.fx.ring(kp.x, kp.y - this.kh / 2, PAL.gold, 10, 120, 0.6, 4);
          this.win();
          return;
        }
      } else if (this.vulnerable) {
        this.stun = 0.5;
        this.audio.sfx('denied');
        this.fx.pop(target.x, target.y - 24, 'RESIST!', PAL.hot, 8);
      }
    }
  }

  private pressOf(input: FrameInput): TypeButton | null {
    for (const p of input.presses) if (p === 'A' || p === 'B' || p === 'C') return p;
    for (const t of input.taps) for (const b of this.pad) if (Math.hypot(t.x - b.x, t.y - b.y) <= b.r + 6) return b.b;
    return null;
  }

  private tick(dt: number) {
    this.inv = Math.max(0, this.inv - dt);
    this.stun = Math.max(0, this.stun - dt);
    this.cool = Math.max(0, this.cool - dt);
    this.lit.age += dt;
    for (const s of this.shots) s.t += dt;
    this.shots = this.shots.filter((s) => !shotPos(s).done);
  }

  protected react(dt: number): void {
    this.tick(dt);
    if (this.status === 'lost') this.slam.update(dt, this.px, this.halfW, W - this.halfW);
  }

  protected ambient(): void {
    if (this.status === 'won' && Math.random() < 0.5) this.fx.burst(HOME_X + vrand(-40, 40), FLOOR - vrand(0, 100), 1, { colors: [PAL.gold, PAL.ink, PAL.hot], kind: 'star', speed: [10, 40], size: [1, 2] });
  }

  draw(g: Gfx): void {
    const time = this.clock;
    // the throne room: dark, a red floor grid in perspective
    g.rect(0, FLOOR, W, H - FLOOR, '#1a0909');
    for (let i = -8; i <= 8; i++) g.line(160 + i * 12, FLOOR, 160 + i * 46, H, 'rgba(255,59,47,0.35)', 1);
    for (let j = 0; j < 4; j++) {
      const y = FLOOR + Math.pow(j / 4, 1.6) * (H - FLOOR) + ((time * 20) % 6) * (j / 4);
      g.line(0, y, W, y, 'rgba(255,59,47,0.3)', 1);
    }
    g.rect(0, FLOOR, W, 2, PAL.hot);
    g.alpha(0.12 + 0.06 * Math.sin(time * 2), () => g.circle(HOME_X, FLOOR - 50, 90, PAL.hot));

    drawSlamShadow(g, this.slam, FLOOR, this.halfW, true);

    // the King
    const kp = this.kingPos();
    const won = this.status === 'won';
    if (!won || this.since < 0.9) {
      const fall = won ? easeIn(clamp(this.since / 0.9, 0, 1)) : 0;
      const flash = this.clock < this.flashAt || (won && Math.floor(this.since * 16) % 2 === 0);
      if (kp.y > -30) g.ellipse(kp.x, FLOOR + 1, this.kw / 2.3, 5, 'rgba(0,0,0,0.5)');
      g.sprite(this.king, kp.x + (won ? Math.sin(this.since * 50) * 2 : 0), kp.y + fall * 20, { k: this.kk, flip: true, mode: flash ? 'white' : 'art', alpha: 1 - fall * 0.7, sy: won ? 1 - fall * 0.5 : undefined, sx: won ? 1 + fall * 0.2 : undefined });
      if (kp.y > 0 && !won) {
        // the crown only when it clears the HP bar (tall Kings wear it off screen)
        if (kp.y - this.kh > 36) g.crown(kp.x, kp.y - this.kh - 2 + Math.sin(time * 4), 2);
        if (this.vulnerable && this.status === 'playing') {
          // the stance badge beside the King, flickering just before it changes
          const left = this.stanceEvery - (this.t - this.stanceAt);
          const flicker = left < 0.22 && Math.floor(time * 24) % 2 === 0;
          const bx = kp.x - this.kw / 2 - 36;
          const by = kp.y - this.kh * 0.62;
          if (!flicker) {
            g.poly([bx + 30, by - 4, bx + 30, by + 4, bx + 40, by], PAL.cab);
            const pulse = 1 + Math.max(0, Math.sin((this.t - this.stanceAt) * 18)) * 0.12 * Math.max(0, 1 - (this.t - this.stanceAt) * 3);
            g.at(bx, by, pulse, 0, () => g.badge(this.stance, 0, 0, true));
          }
        }
      }
    }

    // the partner
    const blink = this.inv > 0 && Math.floor(time * 16) % 2 === 0;
    const lost = this.status === 'lost';
    g.ellipse(this.px, PLAYER_Y + 1, this.pw / 2.4, 2.5, 'rgba(0,0,0,0.5)');
    if (!blink) g.sprite(this.ctx.partner, this.px, PLAYER_Y + (won ? -Math.abs(Math.sin(this.since * 8)) * 10 : 0), { k: this.pk, rot: lost ? -1.2 * clamp(this.since * 3, 0, 1) : undefined });
    if (this.stun > 0) for (let i = 0; i < 3; i++) {
      const a = time * 8 + (i * Math.PI * 2) / 3;
      g.icon('spark', this.px + Math.cos(a) * 10, PLAYER_Y - this.pk * this.ctx.partner.artBox[3] - 4 + Math.sin(a) * 3, 1, PAL.gold);
    }
    for (const s of this.shots) drawShot(g, s, time);

    // HUD: the King's name and HP, the partner's hearts over its head
    const barW = 150;
    const bx = 160 - barW / 2;
    g.text(kingTitle(this.king), 160, 8, { size: 6, color: PAL.gold, maxW: 200 });
    g.rrect(bx - 1, 13, barW + 2, 8, 2, PAL.cab, PAL.ink, 1);
    const seg = barW / this.maxHp;
    for (let i = 0; i < this.maxHp; i++) if (i < this.hp) g.rect(bx + i * seg + 1, 15, seg - 2, 4, PAL.hot);
    const ph = this.ctx.partner.artBox[3] * this.pk;
    for (let i = 0; i < HEARTS; i++) {
      const full = i < this.hearts;
      g.icon(full ? 'heart' : 'heartEmpty', this.px - 11 + i * 11, PLAYER_Y - ph - 9, 1, full ? PAL.hot : HEART_EMPTY, PAL.ink);
    }
    drawPad(g, this.pad, this.lit, false);
    this.fx.draw(g);

    if (won) {
      // KING DOWN: its real art, big, with the artist credit
      const k = clamp((this.since - 0.7) * 3, 0, 1);
      if (k > 0) {
        g.fill(PAL.screen, 0.8 * k);
        // the art in its own column (at most 128 px wide), the words beside it
        const ak = Math.min(artScale(this.king, 100), Math.max(1, Math.floor(128 / this.king.artBox[2])));
        const ax = 78;
        const tx = 230;
        g.alpha(k, () => {
          g.rays(ax, 92, 12, 'rgba(255,198,26,0.12)', time * 0.5);
          g.sprite(this.king, ax, 140, { k: ak });
          g.crown(ax, 140 - this.king.artBox[3] * ak - 4, 2);
          g.text('KING DOWN!', tx, 52, { size: 14, color: PAL.gold, outline: PAL.cab, ow: 3, maxW: 156 });
          g.text(kingTitle(this.king), tx, 78, { size: 10, color: PAL.ink, maxW: 156 });
          g.text(`T${this.king.tier} . ${['MAGIC', 'HUNTER', 'BRUTE'][this.king.type]}`, tx, 94, { size: 6, color: PAL.dim });
          g.text(`ART BY ${this.artist}`, tx, 110, { size: 6, color: PAL.cyan, maxW: 156 });
          g.text('+100 TICKETS', tx, 134, { size: 10, color: PAL.lime, outline: PAL.cab, ow: 2 });
        });
      }
    }
  }

  protected botPlay(): FrameInput {
    if (this.slam.phase === 'tele' || this.slam.phase === 'drop') return botPoint(clamp(this.botFlee, 24, W - 24), 100);
    if (this.vulnerable && this.t >= this.botAt && this.cool <= 0 && this.stun <= 0) {
      this.botAt = this.t + 0.24;
      return botPress(TYPE_BUTTON[counterOf(this.stance)]);
    }
    return botPoint(80, 100);
  }
}
