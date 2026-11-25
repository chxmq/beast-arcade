// Canvas2D fallback presenter: the field is expanded to an integer-scaled ImageData in JS and
// written with putImageData (exact pixels: no resampling, so no edge blending of any kind;
// imageSmoothingEnabled is also off). Plain black/white (or calm greys); no effects.

import { Layout, resolveColors, watchResize, type PresentOpts, type Presenter } from './present-common.ts';

function packRGBA(c: [number, number, number]): number {
  const b = new Uint8ClampedArray(4);
  b[0] = Math.round(c[0] * 255);
  b[1] = Math.round(c[1] * 255);
  b[2] = Math.round(c[2] * 255);
  b[3] = 255;
  return new Uint32Array(b.buffer)[0]; // endianness-agnostic
}

export function create2DPresenter(canvas: HTMLCanvasElement): Presenter {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('no 2d context');
  const layout = new Layout(canvas);
  let img: ImageData | null = null;
  let px32: Uint32Array | null = null;
  let lastKey = '';
  const lut = new Uint32Array(2);

  layout.measure();
  const unwatch = watchResize(canvas, () => layout.measure());

  return {
    kind: '2d',
    get scale() {
      return layout.devScale;
    },
    get offsetX() {
      return layout.devOffX;
    },
    get offsetY() {
      return layout.devOffY;
    },
    get dpr() {
      return layout.dpr;
    },
    resize() {
      layout.measure();
    },
    toField(cx: number, cy: number) {
      return layout.toField(cx, cy);
    },
    draw(field: Uint8Array, w: number, h: number, opts: PresentOpts) {
      layout.setField(w, h, opts.maxScale ?? 0);
      const s = layout.devScale;
      const SW = w * s;
      const SH = h * s;
      if (!img || img.width !== SW || img.height !== SH) {
        img = ctx.createImageData(SW, SH);
        px32 = new Uint32Array(img.data.buffer);
      }
      const { ink, paper } = resolveColors(opts);
      const key = ink.join() + '|' + paper.join();
      if (key !== lastKey) {
        lut[0] = packRGBA(paper);
        lut[1] = packRGBA(ink);
        lastKey = key;
      }
      const p = px32!;
      for (let y = 0; y < h; y++) {
        // expand one field row horizontally, then replicate it s-1 times
        const r0 = y * s * SW;
        let o = r0;
        for (let x = 0, i = y * w; x < w; x++, i++) {
          const c = lut[field[i] & 1];
          for (let k = 0; k < s; k++) p[o++] = c;
        }
        for (let k = 1; k < s; k++) p.copyWithin(r0 + k * SW, r0, r0 + SW);
      }
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#000';
      const { devW, devH, devOffX: ox, devOffY: oy } = layout;
      if (oy > 0) ctx.fillRect(0, 0, devW, oy);
      if (oy + SH < devH) ctx.fillRect(0, oy + SH, devW, devH - oy - SH);
      if (ox > 0) ctx.fillRect(0, oy, ox, SH);
      if (ox + SW < devW) ctx.fillRect(ox + SW, oy, devW - ox - SW, SH);
      ctx.putImageData(img, ox, oy);
    },
    destroy() {
      unwatch();
    },
  };
}
