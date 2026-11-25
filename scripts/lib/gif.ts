// GIF decoding (frame 0 composited onto a transparent canvas).

import { GifReader, GifWriter } from 'omggif';
import { PNG } from 'pngjs';

export interface Rgba {
  w: number;
  h: number;
  /** RGBA, row-major, w*h*4 bytes. */
  data: Uint8Array;
}

export interface DecodedGif {
  frame0: Rgba;
  frames: number;
}

/**
 * Decode frame 0 of a GIF. The canvas starts fully transparent; frame 0 is
 * blitted at its (x, y) offset, so pixels outside its rectangle and pixels
 * using the transparent palette index stay alpha 0. (Frame 0's disposal method
 * only affects how frame 1 is composited, so it is irrelevant here.)
 */
export function decodeGif(bytes: Uint8Array): DecodedGif {
  const reader = new GifReader(bytes);
  const w = reader.width;
  const h = reader.height;
  const data = new Uint8Array(w * h * 4);
  reader.decodeAndBlitFrameRGBA(0, data);
  return { frame0: { w, h, data }, frames: reader.numFrames() };
}

export function decodePng(bytes: Uint8Array): DecodedGif {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { frame0: { w: png.width, h: png.height, data: new Uint8Array(png.data) }, frames: 1 };
}

export type ArtFormat = 'gif' | 'png';

export function sniffFormat(bytes: Uint8Array): ArtFormat | null {
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}

/**
 * Encode a single-frame GIF from RGBA (alpha < 128 becomes transparent).
 * Used when the onchain art is a PNG so every entry still has a GIF.
 * Throws if the image has more than 255 opaque colours.
 */
export function encodeGif(img: Rgba): Uint8Array {
  const colors = new Map<number, number>();
  const idx = new Uint8Array(img.w * img.h);
  let hasTransparent = false;
  for (let p = 0; p < img.w * img.h; p++) {
    if (img.data[p * 4 + 3] < 128) {
      hasTransparent = true;
      continue;
    }
    const c = (img.data[p * 4] << 16) | (img.data[p * 4 + 1] << 8) | img.data[p * 4 + 2];
    if (!colors.has(c)) colors.set(c, colors.size + 1);
  }
  if (colors.size > 255) throw new Error(`encodeGif: ${colors.size} colours (max 255)`);
  let size = 2;
  while (size < colors.size + 1) size *= 2;
  const palette = new Array<number>(size).fill(0);
  for (const [c, i] of colors) palette[i] = c;
  for (let p = 0; p < img.w * img.h; p++) {
    if (img.data[p * 4 + 3] < 128) continue;
    const c = (img.data[p * 4] << 16) | (img.data[p * 4 + 1] << 8) | img.data[p * 4 + 2];
    idx[p] = colors.get(c) as number;
  }
  const buf = new Uint8Array(1024 + img.w * img.h * 2);
  const writer = new GifWriter(buf, img.w, img.h, { palette });
  writer.addFrame(0, 0, img.w, img.h, idx, hasTransparent ? { transparent: 0 } : {});
  return buf.slice(0, writer.end());
}
