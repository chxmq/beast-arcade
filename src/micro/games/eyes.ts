// HUMAN EYES! The screen turns to TV static and one Beast hides in it as pure motion (the STATIC
// renderer: src/render/README.md). Every single frame is uniform noise, so a screenshot shows
// nothing. Until the Beast is found, nothing drawn here depends on where it is: tap rings are the
// same for every tap and misses are only counted in the HUD.
import type { RosterEntry } from '../../data/roster.ts';
import { maskOf } from '../../game/beasts.ts';
import { NoiseField, type RenderBeast } from '../../render/field.ts';
import { artScale, asType } from '../cast.ts';
import { H, PAL, W, type Gfx } from '../gfx.ts';
import type { FrameInput, GameCtx, Pt } from '../types.ts';
import { BaseGame, botIdle, botTap, clamp, easeBack, inBox } from './base.ts';

export const FW = 160;
export const FH = 90;
/** Logical px per field px. */
export const FS = W / FW;
const TICK = 1 / 60;
/** Vertical roaming range in field px: clear of the HUD bands at the top and bottom. */
const TOP_Y = 10;
const BOTTOM_PAD = 6;
const INK: readonly [number, number, number] = [244, 236, 216];
const PAPER: readonly [number, number, number] = [7, 7, 10];

function pack(r: number, g: number, b: number): number {
  const u8 = new Uint8ClampedArray([r, g, b, 255]);
  return new Uint32Array(u8.buffer)[0];
}

export class EyesGame extends BaseGame {
  readonly id = 'eyes' as const;
  readonly prompt = 'HUMAN EYES!';
  readonly hint = 'tap' as const;
  readonly bg = PAL.screen;
  readonly caption = 'NO AI CAN SEE THIS ONE';
  readonly beast: RosterEntry;
  readonly mask: Uint8Array;
  readonly field: NoiseField;
  /** Motion persistence: the share of the static that moves with the body (high = easy). */
  readonly persist: number;
  /** Hitbox slack in field px (generous). */
  readonly margin = 5;
  readonly forgive: number;
  /** First time this run: a one-line explanation in the HUD. */
  readonly explain: boolean;
  /** Top-left of the silhouette in field px. */
  bx: number;
  by: number;
  vx: number;
  vy: number;
  tick = 0;
  missed = 0;
  private acc = 0;
  private readonly botAt: number;
  private botDone = false;
  private off: HTMLCanvasElement | null = null;
  private offCtx: CanvasRenderingContext2D | null = null;
  private img: ImageData | null = null;
  private px32: Uint32Array | null = null;

  constructor(ctx: GameCtx) {
    super(ctx);
    const L = this.level;
    this.beast = ctx.cast.any(this.rng, 0.5, ctx.cast.eyes);
    this.cast = [this.beast];
    this.mask = maskOf(this.beast);
    this.field = new NoiseField(this.rng.int(1, 0x7fffffff), FW, FH);
    this.persist = L >= 5 ? 0.91 : L >= 3 ? 0.92 : 0.93;
    this.forgive = L >= 3 ? 1 : 2;
    this.explain = ctx.seenBefore === 0;
    const e = this.beast;
    this.bx = this.rng.range(4, Math.max(5, FW - e.w - 4));
    this.by = this.rng.range(TOP_Y, Math.max(TOP_Y + 1, FH - e.h - BOTTOM_PAD));
    const a = this.rng.range(0, Math.PI * 2);
    const sp = 9 + 1.5 * Math.min(L, 6);
    this.vx = Math.cos(a) * sp;
    this.vy = Math.sin(a) * sp * 0.7;
    this.botAt = this.rng.range(1.05, 1.4);
  }

  /** The Beast as the noise field carries it this tick. */
  render(): RenderBeast {
    const e = this.beast;
    return { id: 7, px: Math.floor(this.bx), py: Math.floor(this.by), w: e.w, h: e.h, mask: this.mask, type: asType(e.type), persist: this.persist, t: this.tick };
  }

  /** Centre of the silhouette in logical px. */
  get centre(): Pt {
    return { x: (this.bx + this.beast.w / 2) * FS, y: (this.by + this.beast.h / 2) * FS };
  }

  private move(): void {
    const e = this.beast;
    this.bx += this.vx * TICK;
    this.by += this.vy * TICK;
    const maxX = FW - e.w - 2;
    const maxY = Math.max(TOP_Y, FH - e.h - BOTTOM_PAD);
    if (this.bx < 2 || this.bx > maxX) {
      this.vx = -this.vx;
      this.bx = clamp(this.bx, 2, Math.max(2, maxX));
    }
    if (this.by < TOP_Y || this.by > maxY) {
      this.vy = -this.vy;
      this.by = clamp(this.by, TOP_Y, maxY);
    }
  }

  /** Step the field at a fixed 60 Hz (30 Hz in calm mode, same real-time speeds). */
  private advance(dt: number, moving: boolean): void {
    this.acc += dt;
    let n = 0;
    while (this.acc >= TICK && n++ < 5) {
      this.acc -= TICK;
      this.tick++;
      if (moving) this.move();
      if (!this.calm) this.field.step([this.render()], 1);
      else if (this.tick % 2 === 0) this.field.step([this.render()], 2);
    }
    if (n >= 5) this.acc = 0;
  }

  preview(dt: number): void {
    this.clock += dt;
    this.advance(dt, true);
  }

  /** True when a logical point is on the Beast (box plus slack). */
  hits(p: Pt): boolean {
    const e = this.beast;
    const fx = p.x / FS;
    const fy = p.y / FS;
    return inBox({ x: fx, y: fy }, this.bx + e.w / 2, this.by + e.h / 2, e.w, e.h, this.margin);
  }

  protected play(dt: number, input: FrameInput): void {
    this.advance(dt, true);
    for (const tap of input.taps) {
      this.fx.ring(tap.x, tap.y, PAL.cyan, 2, 12, 0.3, 2);
      if (this.hits(tap)) {
        const c = this.centre;
        this.audio.kill(5);
        this.audio.sparkle();
        this.bump(3, 0.08);
        this.fx.ring(c.x, c.y, PAL.lime, 6, 70, 0.5, 3);
        this.fx.burst(c.x, c.y, 30, { colors: [PAL.lime, PAL.ink, PAL.cyan], speed: [60, 190], kind: 'star', size: [1, 2.5] });
        this.fx.pop(c.x, c.y - (this.beast.h * FS) / 2 - 10, 'FOUND!', PAL.lime, 12);
        this.win();
        return;
      }
      this.missed++;
      this.audio.whiff();
      if (this.missed > this.forgive) {
        this.lose();
        return;
      }
    }
  }

  protected react(dt: number): void {
    this.advance(dt, false);
  }

  draw(g: Gfx): void {
    if (!this.off) {
      this.off = document.createElement('canvas');
      this.off.width = FW;
      this.off.height = FH;
      this.offCtx = this.off.getContext('2d');
      if (this.offCtx) {
        this.img = this.offCtx.createImageData(FW, FH);
        this.px32 = new Uint32Array(this.img.data.buffer);
      }
    }
    if (this.offCtx && this.img && this.px32) {
      const k = this.calm ? 0.3 : 1;
      const tone = (c: readonly [number, number, number]) => pack(...(c.map((v) => 127.5 + (v - 127.5) * k) as [number, number, number]));
      const ink = tone(INK);
      const paper = tone(PAPER);
      const cur = this.field.cur;
      const px = this.px32;
      for (let i = 0; i < cur.length; i++) px[i] = cur[i] ? ink : paper;
      this.offCtx.putImageData(this.img, 0, 0);
      const fade = this.status === 'won' ? clamp(1 - this.since * 2.6, 0.18, 1) : this.status === 'lost' ? 0.5 : 1;
      g.alpha(fade, () => g.c.drawImage(this.off!, 0, 0, FW, FH, 0, 0, W, H));
    }

    if (this.status !== 'playing') {
      // Revealed: the Beast's real art exactly where it was hiding.
      const e = this.beast;
      const c = this.centre;
      const k = artScale(e, Math.max(e.w, e.h) * FS);
      const pop = this.status === 'won' ? easeBack(this.since * 4) : 1;
      g.at(c.x, c.y, pop, 0, () => {
        g.circle(0, 0, (Math.max(e.w, e.h) * FS) / 2 + 6, 'rgba(7,7,10,0.75)', this.status === 'won' ? PAL.lime : PAL.hot, 2);
        g.sprite(e, 0, 0, { k, anchor: 'center', mode: this.status === 'won' && this.since < 0.08 ? 'white' : 'art' });
      });
      if (this.status === 'lost') g.text('IT WAS HERE', c.x, Math.min(H - 20, c.y + (e.h * FS) / 2 + 10), { size: 8, color: PAL.hot, outline: PAL.screen, ow: 2 });
    }

    // HUD lines: position-independent.
    if (this.status === 'playing') {
      if (this.explain) {
        g.rrect(40, 20, 240, 12, 3, 'rgba(7,7,10,0.85)');
        g.text('A BEAST MOVES IN THE STATIC. TAP IT.', 160, 26.5, { size: 6, color: PAL.ink });
      }
      for (let i = 0; i < this.forgive; i++) g.text('X', 154 + i * 12 - (this.forgive - 1) * 6 + 6, 12, { size: 8, color: i < this.missed ? PAL.hot : 'rgba(244,236,216,0.25)', outline: PAL.screen, ow: 1.5 });
    }
    this.fx.draw(g);
  }

  protected botPlay(t: number): FrameInput {
    if (this.botDone || t < this.botAt) return botIdle();
    this.botDone = true;
    const c = this.centre;
    return botTap(c.x, c.y);
  }
}
