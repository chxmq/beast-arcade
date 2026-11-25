import { NoiseField, type RenderBeast } from '../render/field.ts';
import { createPresenter, type Presenter } from '../render/present.ts';
import { FIELD_H, FIELD_W } from '../sim/spec.ts';
import { settings } from './settings.ts';

const STEP_MS = 1000 / 60;

export interface TvOptions {
  seed?: number;
  w?: number;
  h?: number;
  ink?: [number, number, number];
  paper?: [number, number, number];
}

/**
 * One TV screen: a noise field, a presenter and a fixed 60 Hz clock.
 * `onTick(tick)` returns the Beasts to carry in the static for that tick.
 * In calm mode the field only advances every other tick (30 Hz) while game time stays at 60 Hz.
 */
export class Tv {
  readonly canvas: HTMLCanvasElement;
  readonly field: NoiseField;
  readonly presenter: Presenter;
  /** Next tick to simulate. */
  tick = 0;
  /** Tick whose state the field holds: the frame on screen. -1 before the first step. */
  shownTick = -1;
  paused = false;
  /** Hit-stop: until this time (performance.now) the clock and the picture both hold. */
  holdUntil = 0;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private onTick: (tick: number) => RenderBeast[] = () => [];
  private onFrame: ((tick: number) => void) | null = null;
  private ro: ResizeObserver;

  constructor(parent: HTMLElement, public opts: TvOptions = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'tv-canvas';
    parent.appendChild(this.canvas);
    this.field = new NoiseField(opts.seed ?? (Math.random() * 2 ** 32) >>> 0, opts.w ?? FIELD_W, opts.h ?? FIELD_H);
    this.presenter = createPresenter(this.canvas);
    this.ro = new ResizeObserver(() => this.presenter.resize());
    this.ro.observe(this.canvas);
  }

  /** Freeze game time and picture for `ms` (a true hit-stop: nothing moves, nothing is missed). */
  hold(ms: number) {
    this.holdUntil = Math.max(this.holdUntil, performance.now() + ms);
  }

  start(onTick: (tick: number) => RenderBeast[], onFrame?: (tick: number) => void) {
    this.onTick = onTick;
    this.onFrame = onFrame ?? null;
    this.last = performance.now();
    this.acc = 0;
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      let dt = now - this.last;
      this.last = now;
      if (this.paused) return;
      if (now < this.holdUntil) {
        this.onFrame?.(this.tick);
        return;
      }
      if (dt > 250) dt = STEP_MS; // tab was hidden: do not fast-forward
      this.acc += dt;
      let stepped = false;
      let guard = 0;
      while (this.acc >= STEP_MS && guard++ < 5) {
        this.acc -= STEP_MS;
        const t = this.tick;
        const beasts = this.onTick(t);
        if (!settings.calm) {
          this.field.step(beasts, 1);
          this.shownTick = t;
          stepped = true;
        } else if ((t & 1) === 0) {
          this.field.step(beasts, 2);
          this.shownTick = t;
          stepped = true;
        }
        this.tick++;
        // A hit-stop requested inside onTick takes effect immediately.
        if (performance.now() < this.holdUntil) { this.acc = 0; break; }
      }
      if (guard >= 5) this.acc = 0;
      if (stepped) this.draw();
      this.onFrame?.(this.tick);
    };
    this.raf = requestAnimationFrame(loop);
  }

  draw() {
    this.presenter.draw(this.field.cur, this.field.w, this.field.h, { calm: settings.calm, ink: this.opts.ink, paper: this.opts.paper });
  }

  /** CSS pixel position (relative to the canvas) to field pixel. */
  cssToField(cx: number, cy: number): { x: number; y: number } {
    const p = this.presenter;
    const dpr = window.devicePixelRatio || 1;
    return { x: Math.floor((cx * dpr - p.offsetX) / p.scale), y: Math.floor((cy * dpr - p.offsetY) / p.scale) };
  }

  /** Field pixel to CSS pixel (relative to the canvas). */
  fieldToCss(x: number, y: number): { x: number; y: number } {
    const p = this.presenter;
    const dpr = window.devicePixelRatio || 1;
    return { x: (x * p.scale + p.offsetX) / dpr, y: (y * p.scale + p.offsetY) / dpr };
  }

  /** CSS pixels per field pixel. */
  get cssScale(): number {
    return this.presenter.scale / (window.devicePixelRatio || 1);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.presenter.destroy();
    // Release the GL context now instead of at GC time: quick retunes would otherwise pile up
    // contexts until the browser starts dropping the oldest ones. (Null for the 2D fallback.)
    const gl = this.presenter.kind === 'webgl2' ? (this.canvas.getContext('webgl2') as WebGL2RenderingContext | null) : null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }
}
