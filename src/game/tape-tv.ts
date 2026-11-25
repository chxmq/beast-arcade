// The HUMAN EYES screen for tapes: canvas + presenter + field/CSS coordinate helpers, without its
// own noise field or clock (frames come from the server stream or from a local Tape replay).

import { createPresenter, type Presenter } from '../render/present.ts';
import { TAPE_H, TAPE_W } from '../broadcast/tape.ts';
import { settings } from './settings.ts';

export class TapeTv {
  readonly canvas: HTMLCanvasElement;
  readonly presenter: Presenter;
  private ro: ResizeObserver;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'tv-canvas he-tv';
    parent.appendChild(this.canvas);
    this.presenter = createPresenter(this.canvas);
    this.ro = new ResizeObserver(() => this.presenter.resize());
    this.ro.observe(this.canvas);
  }

  draw(field: Uint8Array) {
    this.presenter.draw(field, TAPE_W, TAPE_H, { calm: settings.calm });
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

  get cssScale(): number {
    return this.presenter.scale / (window.devicePixelRatio || 1);
  }

  stop() {
    this.ro.disconnect();
    this.presenter.destroy();
    this.canvas.remove();
  }
}
