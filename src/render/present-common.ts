// Shared presenter types and layout (integer scaling, letterboxing, colour handling).

export type RGB = [number, number, number];

export interface PresentOpts {
  /** Calm mode: grey levels 0.35/0.65 instead of black/white (caller also steps at 30 Hz). */
  calm: boolean;
  /** Colour of 1-pixels, 0..255 per channel (default white). */
  ink?: RGB;
  /** Colour of 0-pixels, 0..255 per channel (default black). */
  paper?: RGB;
  /** Cap on the integer scale in DEVICE pixels per field pixel (default: as large as fits). */
  maxScale?: number;
  /** Static, mask-independent CRT touches (faint scanlines at scale >= 4, faint vignette). Default true. WebGL only. */
  fx?: boolean;
}

export interface Presenter {
  draw(field: Uint8Array, w: number, h: number, opts: PresentOpts): void;
  /** Re-read the canvas CSS size and devicePixelRatio (also done automatically via ResizeObserver). */
  resize(): void;
  /** Integer DEVICE pixels per field pixel (CSS px per field px = scale / dpr). */
  readonly scale: number;
  /** DEVICE-pixel offset of the field's top-left inside the canvas backing store (letterbox). */
  readonly offsetX: number;
  readonly offsetY: number;
  /** devicePixelRatio used for the backing store (canvas.width = CSS width x dpr). */
  readonly dpr: number;
  readonly kind: 'webgl2' | '2d';
  /**
   * Map a pointer event's clientX/clientY to integer field coordinates. Equivalent to
   * floor(((clientX - rect.left) * dpr - offsetX) / scale) with rect = canvas.getBoundingClientRect().
   */
  toField(clientX: number, clientY: number): { x: number; y: number; inside: boolean };
  destroy(): void;
}

export const DEFAULT_INK: RGB = [255, 255, 255];
export const DEFAULT_PAPER: RGB = [0, 0, 0];

/** Final 0..1 colours for 1-pixels and 0-pixels. Calm compresses contrast around mid-grey (white/black -> 0.65/0.35). */
export function resolveColors(opts: PresentOpts): { ink: RGB; paper: RGB } {
  const f = (c: RGB): RGB => {
    const v = c.map((x) => Math.min(255, Math.max(0, x)) / 255) as RGB;
    return opts.calm ? (v.map((x) => 0.5 + (x - 0.5) * 0.3) as RGB) : v;
  };
  return { ink: f(opts.ink ?? DEFAULT_INK), paper: f(opts.paper ?? DEFAULT_PAPER) };
}

/** Integer-scale letterbox layout in device pixels. */
export class Layout {
  dpr = 1;
  cssW = 0;
  cssH = 0;
  devW = 1;
  devH = 1;
  fieldW = 256;
  fieldH = 144;
  maxScale = 0;
  devScale = 1;
  devOffX = 0;
  devOffY = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** Measure the element; resize the backing store to CSS size x DPR. Returns true if it changed. */
  measure(): boolean {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const rect = this.canvas.getBoundingClientRect();
    const cssW = rect.width || this.canvas.clientWidth || this.canvas.width;
    const cssH = rect.height || this.canvas.clientHeight || this.canvas.height;
    const devW = Math.max(1, Math.round(cssW * dpr));
    const devH = Math.max(1, Math.round(cssH * dpr));
    const changed = devW !== this.canvas.width || devH !== this.canvas.height || dpr !== this.dpr;
    this.dpr = dpr;
    this.cssW = cssW;
    this.cssH = cssH;
    this.devW = devW;
    this.devH = devH;
    if (this.canvas.width !== devW) this.canvas.width = devW;
    if (this.canvas.height !== devH) this.canvas.height = devH;
    this.fit();
    return changed;
  }

  setField(w: number, h: number, maxScale = 0): void {
    if (w === this.fieldW && h === this.fieldH && maxScale === this.maxScale) return;
    this.fieldW = w;
    this.fieldH = h;
    this.maxScale = maxScale;
    this.fit();
  }

  private fit(): void {
    let s = Math.max(1, Math.floor(Math.min(this.devW / this.fieldW, this.devH / this.fieldH)));
    if (this.maxScale > 0) s = Math.max(1, Math.min(s, Math.floor(this.maxScale)));
    this.devScale = s;
    this.devOffX = Math.floor((this.devW - this.fieldW * s) / 2);
    this.devOffY = Math.floor((this.devH - this.fieldH * s) / 2);
  }

  toField(clientX: number, clientY: number): { x: number; y: number; inside: boolean } {
    const rect = this.canvas.getBoundingClientRect();
    const kx = rect.width ? this.devW / rect.width : this.dpr;
    const ky = rect.height ? this.devH / rect.height : this.dpr;
    const x = Math.floor(((clientX - rect.left) * kx - this.devOffX) / this.devScale);
    const y = Math.floor(((clientY - rect.top) * ky - this.devOffY) / this.devScale);
    return { x, y, inside: x >= 0 && y >= 0 && x < this.fieldW && y < this.fieldH };
  }
}

/** Calls cb when the canvas element changes size (ResizeObserver) or DPR changes (window resize). */
export function watchResize(canvas: HTMLCanvasElement, cb: () => void): () => void {
  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => cb());
    ro.observe(canvas);
  }
  const onWin = () => cb();
  if (typeof window !== 'undefined') window.addEventListener('resize', onWin);
  return () => {
    ro?.disconnect();
    if (typeof window !== 'undefined') window.removeEventListener('resize', onWin);
  };
}
