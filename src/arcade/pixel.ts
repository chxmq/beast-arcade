// Pixel-art drawing for the cabinet's own screens: low-resolution canvases scaled up with
// image-rendering: pixelated, Beast art at integer scale, crisp circles, rays, noise, and the
// gashapon capsule machine (prize counter and its cover on the select screen).
import type { RosterEntry } from '../data/roster.ts';
import { artOf, artRect, artSource, type ArtMode } from '../game/beasts.ts';

export const PAL = {
  ink: '#f4ecd8', dim: '#9a8f7a', hot: '#ff3b2f', gold: '#ffc61a', cyan: '#23d5ff', lime: '#8dff3a',
  screen: '#07070a', cab: '#140b0b', cream: '#efe6d2', steel: '#c9ccd0', steelDark: '#6f747a', black: '#000000',
} as const;

/** A canvas with a fixed internal resolution, drawn without smoothing. */
export function pixelCanvas(w: number, h: number, cls = ''): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  if (cls) canvas.className = cls;
  const g = canvas.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  return { canvas, g };
}

/** Resize a canvas's internal resolution (keeps smoothing off). */
export function setRes(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  return g;
}

/** Resolves when the Beast's art image has loaded (or failed). */
export function loadArt(e: RosterEntry): Promise<void> {
  const img = artOf(e);
  if (img.complete && img.naturalWidth) return Promise.resolve();
  return new Promise((res) => {
    img.addEventListener('load', () => res(), { once: true });
    img.addEventListener('error', () => res(), { once: true });
  });
}

export function loadAll(es: readonly RosterEntry[]): Promise<void> {
  return Promise.all(es.map(loadArt)).then(() => undefined);
}

const cutouts = new Map<number, boolean>();

/**
 * True when the art has a transparent background (its crop corners are clear), so the Beast can
 * stand on a floor; some Art Hackathon pieces are full square paintings. Null until loaded.
 */
export function isCutout(e: RosterEntry): boolean | null {
  const known = cutouts.get(e.speciesId);
  if (known !== undefined) return known;
  const img = artOf(e);
  if (!img.complete || !img.naturalWidth) return null;
  let v = true;
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0);
    const [x, y, w, hh] = e.artBox;
    let clear = 0;
    for (const [px, py] of [[x, y], [x + w - 1, y], [x, y + hh - 1], [x + w - 1, y + hh - 1]]) {
      if (g.getImageData(px, py, 1, 1).data[3] < 40) clear++;
    }
    v = clear >= 3;
  } catch {
    v = true;
  }
  cutouts.set(e.speciesId, v);
  return v;
}

/** Art size in source pixels (the crop box). */
export function artSize(e: RosterEntry): [number, number] {
  return [Math.max(1, e.artBox[2]), Math.max(1, e.artBox[3])];
}

/** Largest integer scale that fits (or the fraction below 1 when even 1x does not fit). */
export function fitScale(e: RosterEntry, maxW: number, maxH: number): number {
  const [w, h] = artSize(e);
  const s = Math.min(maxW / w, maxH / h);
  return s >= 1 ? Math.floor(s) : s;
}

/**
 * Draw a Beast with its bottom-centre at (cx, by), at `scale` (integers stay crisp).
 * Returns false while its art is still loading.
 */
export function drawBeast(g: CanvasRenderingContext2D, e: RosterEntry, cx: number, by: number, scale: number, mode: ArtMode = 'art', flip = false): boolean {
  const src = artSource(e, mode);
  if (!src) return false;
  const [sx, sy, sw, sh] = artRect(e, mode);
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const x = Math.round(cx - w / 2);
  const y = Math.round(by - h);
  if (flip) {
    g.save();
    g.translate(x + w, y);
    g.scale(-1, 1);
    g.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    g.restore();
  } else {
    g.drawImage(src, sx, sy, sw, sh, x, y, w, h);
  }
  return true;
}

/** Filled pixel circle. */
export function disc(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  g.fillStyle = color;
  const rr = (r + 0.5) * (r + 0.5);
  for (let y = -r; y <= r; y++) {
    const half = Math.floor(Math.sqrt(Math.max(0, rr - y * y)));
    g.fillRect(cx - half, cy + y, half * 2 + 1, 1);
  }
}

/** One-pixel pixel-circle outline. */
export function ring(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  g.fillStyle = color;
  const rr = (r + 0.5) * (r + 0.5);
  const inner = (r - 0.5) * (r - 0.5);
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const d = x * x + y * y;
      if (d <= rr && d > inner) g.fillRect(cx + x, cy + y, 1, 1);
    }
  }
}

/** Sunburst rays filling a rect, per pixel so the edges stay hard. */
export function rays(g: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, cx: number, cy: number, n: number, a: string, b: string, turn = 0) {
  const img = g.createImageData(w, h);
  const ca = hex(a);
  const cb = hex(b);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ang = Math.atan2(y + y0 - cy, x + x0 - cx) / (Math.PI * 2) + 0.5 + turn;
      const c = Math.floor(ang * n * 2) % 2 === 0 ? ca : cb;
      const i = (y * w + x) * 4;
      img.data[i] = c[0];
      img.data[i + 1] = c[1];
      img.data[i + 2] = c[2];
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, x0, y0);
}

/** Black and white noise (only ever used for the HUMAN EYES cabinet, where noise is the point). */
export function noise(g: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, rnd: () => number = Math.random) {
  const img = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = rnd() < 0.5 ? 18 : 228;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, x0, y0);
}

export function hex(c: string): [number, number, number] {
  const s = c.replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((ch) => ch + ch).join('') : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Small deterministic PRNG (covers and machines look the same every visit). */
export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ the capsule machine

export type MachineKind = 'basic' | 'rare' | 'legendary';

export const MACHINE_W = 44;
export const MACHINE_H = 70;

const BODY: Record<MachineKind, [string, string, string]> = {
  basic: [PAL.cyan, '#0f6f88', '#8ff0ff'],
  rare: [PAL.gold, '#8a6400', '#fff0a8'],
  legendary: [PAL.hot, '#7e1a12', '#ff9a8c'],
};

const CAPSULES: Record<MachineKind, string[]> = {
  basic: [PAL.cyan, PAL.lime, PAL.ink, PAL.hot, PAL.cyan, PAL.gold, PAL.lime, PAL.cyan, PAL.ink, PAL.hot, PAL.lime],
  rare: [PAL.gold, PAL.cyan, PAL.gold, PAL.lime, PAL.hot, PAL.gold, PAL.cyan, PAL.gold, PAL.lime, PAL.gold, PAL.cyan],
  legendary: [PAL.gold, PAL.hot, PAL.gold, '#111111', PAL.hot, PAL.gold, PAL.cyan, PAL.hot, PAL.gold, PAL.hot, PAL.gold],
};

/** Where capsules sit inside the dome (offsets from its centre), bottom rows first. */
const SPOTS: [number, number][] = [
  [-9, 9], [0, 10], [9, 9], [-13, 2], [-4, 3], [5, 3], [13, 2], [-8, -4], [1, -4], [10, -5], [-2, -10],
];

export interface MachinePose {
  /** Knob angle, radians. */
  knob: number;
  /** 0..1 shake of the capsules (cranking). */
  shake: number;
  /** Animation clock (ms) for lamps and shake. */
  t: number;
  /** A capsule in the chute: 0 (just out) .. 1 (resting), colour. */
  drop?: { k: number; color: string };
  /** Selected: the lamps chase faster and the plate lights. */
  lit?: boolean;
  /** Capsules left in the dome (the machine looks emptier after a turn). */
  left?: number;
}

export function capsule(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, top: string) {
  disc(g, cx, cy, r, '#2a2320');
  disc(g, cx, cy, r - 1, PAL.cream);
  g.fillStyle = top;
  const rr = (r - 0.5) * (r - 0.5);
  for (let y = -r + 1; y <= 0; y++) {
    const half = Math.floor(Math.sqrt(Math.max(0, rr - y * y)));
    g.fillRect(cx - half, cy + y, half * 2 + 1, 1);
  }
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(cx - Math.max(1, r - 3), cy - Math.max(1, r - 2), 1, 1);
}

/** Draw one machine with its top-left at (x, y), MACHINE_W x MACHINE_H. */
export function drawMachine(g: CanvasRenderingContext2D, x: number, y: number, kind: MachineKind, pose: MachinePose) {
  const [body, dark, light] = BODY[kind];
  const cx = x + 22;
  const dy = y + 19;
  // cap and lamps on top of the dome
  g.fillStyle = dark;
  g.fillRect(cx - 5, y + 0, 10, 3);
  g.fillStyle = body;
  g.fillRect(cx - 4, y + 0, 8, 2);
  if (kind !== 'basic') {
    const on = Math.floor(pose.t / (pose.lit ? 140 : 380)) % 2 === 0;
    g.fillStyle = on ? PAL.gold : '#5a4310';
    g.fillRect(cx - 9, y + 2, 2, 2);
    g.fillStyle = on ? '#5a4310' : PAL.gold;
    g.fillRect(cx + 7, y + 2, 2, 2);
  }
  // the dome
  disc(g, cx, dy, 17, '#0c171c');
  const left = Math.max(0, Math.min(SPOTS.length, pose.left ?? SPOTS.length));
  const cols = CAPSULES[kind];
  for (let i = 0; i < left; i++) {
    const [ox, oy] = SPOTS[i];
    const jx = pose.shake ? Math.round(Math.sin(pose.t / 37 + i * 1.7) * 1.4 * pose.shake) : 0;
    const jy = pose.shake ? Math.round(Math.cos(pose.t / 29 + i * 2.3) * 1.4 * pose.shake) : 0;
    capsule(g, cx + ox + jx, dy + oy + jy, 4, cols[i % cols.length]);
  }
  ring(g, cx, dy, 17, '#d8d2c4');
  ring(g, cx, dy, 18, '#3b3431');
  g.fillStyle = 'rgba(255,255,255,0.9)';
  for (const [hx, hy] of [[-11, -8], [-12, -6], [-10, -10], [-8, -12], [-12, -4]] as const) g.fillRect(cx + hx, dy + hy, 1, 1);
  // collar
  g.fillStyle = dark;
  g.fillRect(x + 9, y + 35, 26, 4);
  g.fillStyle = PAL.steelDark;
  g.fillRect(x + 9, y + 35, 26, 1);
  // body
  g.fillStyle = body;
  g.fillRect(x + 5, y + 39, 34, 30);
  g.fillStyle = light;
  g.fillRect(x + 5, y + 39, 34, 1);
  g.fillStyle = dark;
  g.fillRect(x + 5, y + 67, 34, 2);
  g.fillRect(x + 38, y + 40, 1, 27);
  if (kind === 'legendary') {
    g.fillStyle = PAL.gold;
    g.fillRect(x + 5, y + 41, 34, 1);
    g.fillRect(x + 5, y + 65, 34, 1);
  }
  // label plate
  g.fillStyle = pose.lit ? '#2b1a0c' : '#140b0b';
  g.fillRect(x + 10, y + 42, 24, 4);
  g.fillStyle = pose.lit ? PAL.gold : '#5a4a3a';
  for (let i = 0; i < 5; i++) g.fillRect(x + 12 + i * 4, y + 43, 2, 2);
  // knob
  const kx = cx;
  const ky = y + 53;
  disc(g, kx, ky, 6, '#3a3d40');
  disc(g, kx, ky, 5, PAL.steel);
  ring(g, kx, ky, 5, PAL.steelDark);
  g.fillStyle = '#2a2c2e';
  for (let t = -4; t <= 4; t++) {
    g.fillRect(Math.round(kx + Math.cos(pose.knob) * t) - 1, Math.round(ky + Math.sin(pose.knob) * t) - 1, 2, 2);
  }
  g.fillStyle = PAL.hot;
  g.fillRect(kx - 1, ky - 1, 2, 2);
  // chute
  g.fillStyle = '#000';
  g.fillRect(x + 14, y + 60, 16, 7);
  g.fillStyle = PAL.steelDark;
  g.fillRect(x + 13, y + 59, 18, 1);
  if (pose.drop) {
    const k = Math.max(0, Math.min(1, pose.drop.k));
    const bounce = k < 0.7 ? 0 : Math.round(Math.sin(((k - 0.7) / 0.3) * Math.PI) * -1);
    const cyy = y + 60 + Math.round(Math.min(1, k / 0.7) * 3) + bounce;
    capsule(g, cx, cyy + 1, 3, pose.drop.color);
  }
}
