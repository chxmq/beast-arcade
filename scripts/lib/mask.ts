// Silhouette extraction: background removal, cleanup, crop + area-average scaling.

import type { Rgba } from './gif.ts';

/**
 * How the background is identified:
 * - alpha:     background = transparent pixels.
 * - floodfill: background = pixels connected to the border whose colour is close
 *              to the most common border colour.
 * - local:     foreground = pixels that differ from the local median colour
 *              (ink / sketch on uneven paper, e.g. photos).
 */
export type BgMethod = 'alpha' | 'floodfill' | 'local';

export interface MaskParams {
  /** RGB distance threshold for floodfill (to the border colour) and local (to the local median). */
  bgTolerance: number;
  /** Drop foreground components smaller than this (source px). */
  minComponent: number;
  /** Always fill enclosed background holes smaller than this (source px). */
  maxHole: number;
  /**
   * Also fill enclosed holes smaller than this fraction of the filled silhouette.
   * Much of the art is outline / dithered pixel art whose interior is
   * transparent; a motion silhouette must be solid.
   */
  holeFraction: number;
  /**
   * Seal 1 px gaps before hole filling: a background pixel becomes foreground
   * when it is sandwiched horizontally or vertically between foreground pixels
   * (striped / dithered shading, broken outlines). Unlike a square closing it
   * never bridges 2 px gaps, so separate limbs stay separate.
   */
  sealGaps: boolean;
  /**
   * Line-art interior fill: a background pixel becomes foreground when at least
   * this many of the 8 rays cast from it (orthogonal + diagonal) hit foreground.
   * Fills outlined bodies even when the outline has gaps, while open concavities
   * (between legs, inside a C) stay open. 0 = off.
   */
  rayFill: number;
  /** Max ray length for rayFill, as a fraction of the art's larger side. */
  rayReach: number;
  /** Square morphological closing radius (source px), for sketchy ink lines; 0 = off. */
  close: number;
  /** Keep components at least this fraction of the largest one. */
  keepFraction: number;
  /** Target silhouette height in field pixels. */
  targetH: number;
  maxW: number;
  maxH: number;
  /** Force a background method (default: alpha if the border is mostly transparent, else floodfill). */
  method?: BgMethod;
  /** Region of interest [x, y, w, h] in art pixels; everything outside is background. */
  roi?: [number, number, number, number];
  /** Window radius for the local method. */
  localRadius: number;
  /** Drop checkerboard-dithered pixels (no 4-connected foreground neighbour) first; for dithered scenery. */
  dropDither?: boolean;
  /** Always report this as the mask warning (manual review notes). */
  note?: string;
}

export const DEFAULT_PARAMS: MaskParams = {
  bgTolerance: 24,
  minComponent: 4,
  maxHole: 6,
  holeFraction: 0.35,
  sealGaps: true,
  rayFill: 8,
  rayReach: 0.3,
  close: 0,
  keepFraction: 0.1,
  targetH: 48,
  maxW: 64,
  maxH: 56,
  localRadius: 6,
};

export interface MaskResult {
  method: BgMethod;
  bgColor: [number, number, number] | null;
  /** Full-resolution cleaned mask (art size). */
  full: Uint8Array;
  /** Crop rectangle in art pixels. */
  artBox: [number, number, number, number];
  w: number;
  h: number;
  /** Scaled mask, w*h 0/1. */
  mask: Uint8Array;
  warning: string | null;
  stats: { fill: number; pixels: number; fullPixels: number; scale: number };
}

type Rgb = [number, number, number];

const dist = (d: Uint8Array, i: number, c: Rgb) => {
  const dr = d[i] - c[0];
  const dg = d[i + 1] - c[1];
  const db = d[i + 2] - c[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
};

function borderIndices(w: number, h: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < w; x++) {
    out.push(x);
    if (h > 1) out.push((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    out.push(y * w);
    if (w > 1) out.push(y * w + w - 1);
  }
  return out;
}

function cropRgba(img: Rgba, [x0, y0, w, h]: [number, number, number, number]): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * img.w + x0) * 4;
    data.set(img.data.subarray(s, s + w * 4), y * w * 4);
  }
  return { w, h, data };
}

/** Most common opaque colour among border pixels (null if the border is all transparent). */
function borderMode(img: Rgba): Rgb | null {
  const counts = new Map<number, number>();
  for (const p of borderIndices(img.w, img.h)) {
    const i = p * 4;
    if (img.data[i + 3] === 0) continue;
    const key = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = -1;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best < 0 ? null : [(best >> 16) & 255, (best >> 8) & 255, best & 255];
}

interface Components {
  labels: Int32Array;
  sizes: number[];
  touchesBorder: boolean[];
}

/** Label connected components of pixels where `m[i] === value` (label 0 = not in set). */
function components(m: Uint8Array, w: number, h: number, value: number, conn8: boolean): Components {
  const labels = new Int32Array(w * h);
  const sizes: number[] = [0];
  const touches: boolean[] = [false];
  const stack: number[] = [];
  let next = 1;
  for (let s = 0; s < w * h; s++) {
    if (m[s] !== value || labels[s] !== 0) continue;
    const id = next++;
    let size = 0;
    let touch = false;
    labels[s] = id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop() as number;
      size++;
      const x = p % w;
      const y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touch = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (!conn8 && dx !== 0 && dy !== 0) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (m[q] === value && labels[q] === 0) {
            labels[q] = id;
            stack.push(q);
          }
        }
      }
    }
    sizes.push(size);
    touches.push(touch);
  }
  return { labels, sizes, touchesBorder: touches };
}

function floodFillForeground(img: Rgba, tol: number): { fg: Uint8Array; bg: Rgb } {
  const { w, h, data } = img;
  const n = w * h;
  const bg = borderMode(img) ?? [0, 0, 0];
  const isBg = new Uint8Array(n);
  const stack: number[] = [];
  const bgLike = (q: number) => data[q * 4 + 3] === 0 || dist(data, q * 4, bg) < tol;
  for (const q of borderIndices(w, h)) {
    if (!isBg[q] && bgLike(q)) {
      isBg[q] = 1;
      stack.push(q);
    }
  }
  while (stack.length) {
    const q = stack.pop() as number;
    const x = q % w;
    const y = (q - x) / w;
    const nb = [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1];
    for (const r of nb) {
      if (r >= 0 && !isBg[r] && bgLike(r)) {
        isBg[r] = 1;
        stack.push(r);
      }
    }
  }
  const fg = new Uint8Array(n);
  for (let q = 0; q < n; q++) fg[q] = isBg[q] ? 0 : 1;
  return { fg, bg };
}

function localContrastForeground(img: Rgba, tol: number, r: number): Uint8Array {
  const { w, h, data } = img;
  const fg = new Uint8Array(w * h);
  const med = (vals: number[]) => {
    vals.sort((a, b) => a - b);
    return vals[vals.length >> 1];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] === 0) continue;
      const rs: number[] = [];
      const gs: number[] = [];
      const bs: number[] = [];
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) {
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
          const j = (yy * w + xx) * 4;
          if (data[j + 3] === 0) continue;
          rs.push(data[j]);
          gs.push(data[j + 1]);
          bs.push(data[j + 2]);
        }
      }
      fg[y * w + x] = dist(data, i, [med(rs), med(gs), med(bs)]) > tol ? 1 : 0;
    }
  }
  return fg;
}

/** Raw foreground (before cleanup), honouring `roi` and `method`. */
export function rawForeground(img: Rgba, p: MaskParams): { fg: Uint8Array; method: BgMethod; bgColor: Rgb | null } {
  const roi = p.roi ?? [0, 0, img.w, img.h];
  const sub = cropRgba(img, roi);
  const n = sub.w * sub.h;
  let method = p.method;
  if (!method) {
    const border = borderIndices(sub.w, sub.h);
    const transparentBorder = border.filter((q) => sub.data[q * 4 + 3] === 0).length;
    // Alpha when the border is mostly transparent; an art with a few transparent
    // pixels but an opaque backdrop is flood-filled instead.
    method = transparentBorder >= border.length * 0.5 ? 'alpha' : 'floodfill';
  }
  let fg: Uint8Array;
  let bgColor: Rgb | null = null;
  if (method === 'alpha') {
    fg = new Uint8Array(n);
    for (let q = 0; q < n; q++) fg[q] = sub.data[q * 4 + 3] > 0 ? 1 : 0;
  } else if (method === 'floodfill') {
    const r = floodFillForeground(sub, p.bgTolerance);
    fg = r.fg;
    bgColor = r.bg;
  } else {
    fg = localContrastForeground(sub, p.bgTolerance, p.localRadius);
  }
  const full = new Uint8Array(img.w * img.h);
  for (let y = 0; y < sub.h; y++) full.set(fg.subarray(y * sub.w, (y + 1) * sub.w), (roi[1] + y) * img.w + roi[0]);
  return { fg: full, method, bgColor };
}

/** Square dilation (grow = true) or erosion; out-of-bounds counts as `oob`. */
function morph(m: Uint8Array, w: number, h: number, r: number, grow: boolean, oob: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let dy = -r; dy <= r && v === (grow ? 0 : 1); dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          const s = xx < 0 || yy < 0 || xx >= w || yy >= h ? oob : m[yy * w + xx];
          if (grow && s) {
            v = 1;
            break;
          }
          if (!grow && !s) {
            v = 0;
            break;
          }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** Morphological closing (never removes original pixels). */
function closing(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return m;
  const c = morph(morph(m, w, h, r, true, 0), w, h, r, false, 1);
  for (let q = 0; q < m.length; q++) c[q] |= m[q];
  return c;
}

/** Fill background pixels sandwiched between foreground pixels (left+right or up+down). */
function sealGaps(m: Uint8Array, w: number, h: number): Uint8Array {
  const out = Uint8Array.from(m);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = y * w + x;
      if (m[q]) continue;
      const horiz = x > 0 && x < w - 1 && m[q - 1] && m[q + 1];
      const vert = y > 0 && y < h - 1 && m[q - w] && m[q + w];
      if (horiz || vert) out[q] = 1;
    }
  }
  return out;
}

/** See MaskParams.rayFill. Diagonal rays are 4-connected-thick so they cannot slip through diagonal outlines. */
function rayFill(m: Uint8Array, w: number, h: number, minHits: number, reach: number): Uint8Array {
  const out = Uint8Array.from(m);
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (m[y * w + x]) continue;
      let hits = 0;
      for (let d = 0; d < 8 && hits + (8 - d) >= minHits; d++) {
        const [dx, dy] = dirs[d];
        let px = x;
        let py = y;
        for (let step = 0; step < reach; step++) {
          if (dx !== 0 && dy !== 0 && at(px + dx, py)) {
            hits++;
            break;
          }
          px += dx;
          py += dy;
          if (px < 0 || py < 0 || px >= w || py >= h) break;
          if (at(px, py)) {
            hits++;
            break;
          }
        }
      }
      if (hits >= minHits) out[y * w + x] = 1;
    }
  }
  return out;
}

/**
 * Cleanup: drop specks, seal 1 px gaps, fill enclosed holes (small ones, and
 * line-art interiors up to holeFraction of the silhouette), keep significant
 * components only.
 */
export function cleanMask(fg: Uint8Array, w: number, h: number, p: MaskParams): Uint8Array {
  let m: Uint8Array = Uint8Array.from(fg);
  if (p.dropDither) {
    const src = Uint8Array.from(m);
    const at = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && src[y * w + x] === 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (src[y * w + x] && !at(x - 1, y) && !at(x + 1, y) && !at(x, y - 1) && !at(x, y + 1)) m[y * w + x] = 0;
      }
    }
  }
  // 1. drop tiny specks
  let cc = components(m, w, h, 1, true);
  for (let q = 0; q < m.length; q++) if (m[q] && cc.sizes[cc.labels[q]] < p.minComponent) m[q] = 0;
  // 2. seal gaps (striped / dithered shading, broken outlines)
  if (p.sealGaps) m = sealGaps(m, w, h);
  if (p.rayFill > 0) m = rayFill(m, w, h, p.rayFill, Math.max(4, Math.round(p.rayReach * Math.max(w, h))));
  m = closing(m, w, h, p.close);
  // 3. fill enclosed holes (4-connected background regions not touching the border)
  const holes = components(m, w, h, 0, false);
  let filledArea = 0;
  for (let q = 0; q < m.length; q++) {
    const l = holes.labels[q];
    if (m[q] || (l && !holes.touchesBorder[l])) filledArea++;
  }
  for (let q = 0; q < m.length; q++) {
    const l = holes.labels[q];
    if (!l || holes.touchesBorder[l]) continue;
    const s = holes.sizes[l];
    if (s < p.maxHole || s < p.holeFraction * filledArea) m[q] = 1;
  }
  // 4. keep significant components only
  cc = components(m, w, h, 1, true);
  const largest = Math.max(0, ...cc.sizes);
  for (let q = 0; q < m.length; q++) {
    if (m[q] && cc.sizes[cc.labels[q]] < largest * p.keepFraction) m[q] = 0;
  }
  return m;
}

export function bbox(m: Uint8Array, w: number, h: number): [number, number, number, number] | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

/**
 * Area-average resample of the crop [cx, cy, cw, ch] of a w-wide 0/1 mask to
 * ow x oh, then threshold at 0.5.
 */
export function resampleMask(
  m: Uint8Array,
  w: number,
  crop: [number, number, number, number],
  ow: number,
  oh: number,
): Uint8Array {
  const [cx, cy, cw, ch] = crop;
  const sx = cw / ow;
  const sy = ch / oh;
  const out = new Uint8Array(ow * oh);
  for (let oy = 0; oy < oh; oy++) {
    const fy0 = oy * sy;
    const fy1 = (oy + 1) * sy;
    for (let ox = 0; ox < ow; ox++) {
      const fx0 = ox * sx;
      const fx1 = (ox + 1) * sx;
      let acc = 0;
      for (let y = Math.floor(fy0); y < Math.ceil(fy1); y++) {
        const wy = Math.min(fy1, y + 1) - Math.max(fy0, y);
        if (wy <= 0) continue;
        for (let x = Math.floor(fx0); x < Math.ceil(fx1); x++) {
          const wx = Math.min(fx1, x + 1) - Math.max(fx0, x);
          if (wx <= 0) continue;
          if (m[(cy + y) * w + cx + x]) acc += wx * wy;
        }
      }
      out[oy * ow + ox] = acc / (sx * sy) >= 0.5 ? 1 : 0;
    }
  }
  return out;
}

export function computeMask(img: Rgba, p: MaskParams = DEFAULT_PARAMS): MaskResult {
  const { w: W, h: H } = img;
  const raw = rawForeground(img, p);
  const full = cleanMask(raw.fg, W, H, p);
  let fullPixels = 0;
  for (const v of full) fullPixels += v;
  const warnings: string[] = [];
  if (p.note) warnings.push(p.note);

  let box = bbox(full, W, H);
  if (!box) {
    warnings.push('empty mask');
    box = [0, 0, W, H];
  }
  // 1 px margin, clamped to the art.
  const x0 = Math.max(0, box[0] - 1);
  const y0 = Math.max(0, box[1] - 1);
  const x1 = Math.min(W, box[0] + box[2] + 1);
  const y1 = Math.min(H, box[1] + box[3] + 1);
  const artBox: [number, number, number, number] = [x0, y0, x1 - x0, y1 - y0];

  // Crop height -> targetH, keeping aspect, clamped to maxW x maxH.
  const scale = Math.min(p.targetH / artBox[3], p.maxW / artBox[2], p.maxH / artBox[3]);
  const ow = Math.max(1, Math.min(p.maxW, Math.round(artBox[2] * scale)));
  const oh = Math.max(1, Math.min(p.maxH, Math.round(artBox[3] * scale)));
  const mask = resampleMask(full, W, artBox, ow, oh);

  let pixels = 0;
  for (const v of mask) pixels += v;
  const tb = bbox(mask, ow, oh);
  const fill = tb ? pixels / (tb[2] * tb[3]) : 0;
  const coverage = fullPixels / (W * H);
  if (pixels > 0) {
    if (coverage > 0.97) warnings.push(`background not removed (${Math.round(coverage * 100)}% of art)`);
    if (fill < 0.15) warnings.push(`sparse silhouette (fill ${Math.round(fill * 100)}%)`);
    if (fill > 0.85) warnings.push(`blocky silhouette (fill ${Math.round(fill * 100)}%)`);
    if (pixels < 80 || (tb && (tb[2] < 8 || tb[3] < 8))) warnings.push(`tiny silhouette (${pixels} px)`);
  } else if (!warnings.includes('empty mask')) {
    warnings.push('empty mask after scaling');
  }

  return {
    method: raw.method,
    bgColor: raw.bgColor,
    full,
    artBox,
    w: ow,
    h: oh,
    mask,
    warning: warnings.length ? warnings.join('; ') : null,
    stats: { fill, pixels, fullPixels, scale },
  };
}
