// PNG output and the human-review contact sheet.

import { PNG } from 'pngjs';
import type { Rgba } from './gif.ts';

export function encodePng(img: Rgba): Buffer {
  const png = new PNG({ width: img.w, height: img.h, colorType: 6 });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(png, { colorType: 6 });
}

export class Canvas {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    bg: [number, number, number] = [24, 24, 28],
  ) {
    this.data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      this.data[i * 4] = bg[0];
      this.data[i * 4 + 1] = bg[1];
      this.data[i * 4 + 2] = bg[2];
      this.data[i * 4 + 3] = 255;
    }
  }

  /** Alpha-blend a colour onto pixel (x, y). */
  set(x: number, y: number, c: [number, number, number], a = 255): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const t = a / 255;
    for (let k = 0; k < 3; k++) this.data[i + k] = Math.round(this.data[i + k] * (1 - t) + c[k] * t);
  }

  rect(x: number, y: number, w: number, h: number, c: [number, number, number], a = 255): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c, a);
  }

  outline(x: number, y: number, w: number, h: number, c: [number, number, number]): void {
    for (let xx = x; xx < x + w; xx++) {
      this.set(xx, y, c);
      this.set(xx, y + h - 1, c);
    }
    for (let yy = y; yy < y + h; yy++) {
      this.set(x, yy, c);
      this.set(x + w - 1, yy, c);
    }
  }

  /** Nearest-neighbour blit of an RGBA image at integer scale, over a checkerboard. */
  blitRgba(img: Rgba, x: number, y: number, s: number): void {
    for (let py = 0; py < img.h * s; py++) {
      for (let px = 0; px < img.w * s; px++) {
        const checker = ((px >> 3) + (py >> 3)) & 1 ? 90 : 60;
        this.set(x + px, y + py, [checker, checker, checker]);
        const i = (Math.floor(py / s) * img.w + Math.floor(px / s)) * 4;
        const a = img.data[i + 3];
        if (a) this.set(x + px, y + py, [img.data[i], img.data[i + 1], img.data[i + 2]], a);
      }
    }
  }

  blitMask(m: Uint8Array, w: number, h: number, x: number, y: number, s: number, on: [number, number, number]): void {
    for (let py = 0; py < h * s; py++) {
      for (let px = 0; px < w * s; px++) {
        const v = m[Math.floor(py / s) * w + Math.floor(px / s)];
        this.set(x + px, y + py, v ? on : [40, 40, 48]);
      }
    }
  }

  text(str: string, x: number, y: number, s: number, c: [number, number, number]): void {
    let cx = x;
    for (const ch of str.toUpperCase()) {
      const g = FONT[ch];
      if (g) {
        for (let r = 0; r < 5; r++) {
          for (let k = 0; k < 3; k++) if ((g[r] >> (2 - k)) & 1) this.rect(cx + k * s, y + r * s, s, s, c);
        }
      }
      cx += 4 * s;
    }
  }

  toPng(): Buffer {
    return encodePng({ w: this.w, h: this.h, data: this.data });
  }
}

// 3x5 bitmap font: each row is 3 bits, MSB = left column.
const FONT: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7],
  '1': [2, 6, 2, 2, 7],
  '2': [7, 1, 7, 4, 7],
  '3': [7, 1, 7, 1, 7],
  '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7],
  '6': [7, 4, 7, 5, 7],
  '7': [7, 1, 1, 1, 1],
  '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 7],
  A: [2, 5, 7, 5, 5],
  B: [6, 5, 6, 5, 6],
  C: [7, 4, 4, 4, 7],
  D: [6, 5, 5, 5, 6],
  E: [7, 4, 6, 4, 7],
  F: [7, 4, 6, 4, 4],
  G: [7, 4, 5, 5, 7],
  H: [5, 5, 7, 5, 5],
  I: [7, 2, 2, 2, 7],
  J: [1, 1, 1, 5, 7],
  K: [5, 5, 6, 5, 5],
  L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5],
  N: [6, 5, 5, 5, 5],
  O: [7, 5, 5, 5, 7],
  P: [7, 5, 7, 4, 4],
  Q: [7, 5, 5, 7, 1],
  R: [6, 5, 6, 5, 5],
  S: [7, 4, 7, 1, 7],
  T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 7],
  V: [5, 5, 5, 5, 2],
  W: [5, 5, 7, 7, 5],
  X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2],
  Z: [7, 1, 2, 4, 7],
  '!': [2, 2, 2, 0, 2],
  '-': [0, 0, 7, 0, 0],
  ' ': [0, 0, 0, 0, 0],
};
