// BEAST CATCH renderer: every visible spawn drawn as its full-colour art over a pixel backdrop.
// The sim (src/sim) decides everything; this file only draws it. A sprite sits on its sim
// position (positionAt) and is centred on its full w x h hitbox at an integer art scale, so what
// you see is what the replay scores. Layout math, poses and the backdrop pixels are pure and
// tested (sprites.test.ts); the canvas parts are at the bottom.
import type { RosterEntry } from '../data/roster.ts';
import { FIELD_H, FIELD_W, REACTION_TICKS } from '../sim/spec.ts';
import { artOf, maskOf, shinyPixels } from './beasts.ts';
import type { ChannelId } from './channels.ts';
import { settings } from './settings.ts';

/** The arcade palette (ARCADE.md section 2), for canvas drawing. */
export const ARC = {
  hot: '#ff3b2f',
  gold: '#ffc61a',
  cyan: '#23d5ff',
  lime: '#8dff3a',
  ink: '#f4ecd8',
  dim: '#9a8f7a',
  screen: '#07070a',
  bezel: '#050505',
} as const;

/** Type colours: Magic, Hunter, Brute. Rims, shadows, chain text. */
export const TYPE_COLOR = [ARC.cyan, ARC.lime, ARC.hot] as const;
/** Dark body plates behind the line art, tinted by type. */
const PLATE: readonly [number, number, number][] = [[6, 22, 30], [12, 24, 8], [30, 10, 8]];

/** Ticks before an escape when a Beast starts to tremble and shows "!". */
export const WARN_TICKS = 45;

// ------------------------------------------------------------------ layout (pure)

export interface StageLayout {
  /** Backing store size in device px. */
  devW: number;
  devH: number;
  dpr: number;
  /** Device px per field px. Fractional: the field fills the screen, sprites stay integer. */
  s: number;
  /** Device-px offset of the field's top-left (letterbox when the screen is not 16:9). */
  offX: number;
  offY: number;
  fw: number;
  fh: number;
}

export function stageLayout(cssW: number, cssH: number, dpr = 1, fw = FIELD_W, fh = FIELD_H): StageLayout {
  const devW = Math.max(1, Math.round(cssW * dpr));
  const devH = Math.max(1, Math.round(cssH * dpr));
  const s = Math.max(1e-3, Math.min(devW / fw, devH / fh));
  return { devW, devH, dpr, s, offX: Math.round((devW - fw * s) / 2), offY: Math.round((devH - fh * s) / 2), fw, fh };
}

/** Field px to device px (top-left corner of that field pixel). */
export function fieldToDev(L: StageLayout, x: number, y: number): { x: number; y: number } {
  return { x: L.offX + x * L.s, y: L.offY + y * L.s };
}

/** Device px to the field pixel under it. */
export function devToField(L: StageLayout, dx: number, dy: number): { x: number; y: number; inside: boolean } {
  const x = Math.floor((dx - L.offX) / L.s);
  const y = Math.floor((dy - L.offY) / L.s);
  return { x, y, inside: x >= 0 && y >= 0 && x < L.fw && y < L.fh };
}

/** Backdrop pixel size in device px: the nearest whole number to one field pixel. */
export function pixelSize(L: StageLayout): number {
  return Math.max(1, Math.round(L.s));
}

/** Integer device px per art px that fills a w x h field-px hitbox most closely. */
export function artScale(s: number, w: number, h: number, aw: number, ah: number): number {
  const target = Math.min((w * s) / Math.max(1, aw), (h * s) / Math.max(1, ah));
  return Math.max(1, Math.round(target));
}

export interface Rect { x: number; y: number; w: number; h: number }

/** The hitbox (w x h field px at px, py) in whole device px. */
export function boxRect(L: StageLayout, px: number, py: number, w: number, h: number): Rect {
  const x0 = Math.round(L.offX + px * L.s);
  const y0 = Math.round(L.offY + py * L.s);
  return { x: x0, y: y0, w: Math.round(L.offX + (px + w) * L.s) - x0, h: Math.round(L.offY + (py + h) * L.s) - y0 };
}

/** Where the art (aw x ah art px) is drawn: integer scale k, centred on the hitbox, whole device px. */
export function spriteRect(L: StageLayout, px: number, py: number, w: number, h: number, aw: number, ah: number): Rect & { k: number } {
  const b = boxRect(L, px, py, w, h);
  const k = artScale(L.s, w, h, aw, ah);
  const dw = aw * k;
  const dh = ah * k;
  return { x: Math.round(b.x + (b.w - dw) / 2), y: Math.round(b.y + (b.h - dh) / 2), w: dw, h: dh, k };
}

// ------------------------------------------------------------------ poses (pure)

/** Offsets in field px, scales around the sprite's feet. */
export interface Pose { dx: number; dy: number; sx: number; sy: number; alpha: number; flash: boolean }

export const REST: Pose = { dx: 0, dy: 0, sx: 1, sy: 1, alpha: 1, flash: false };

/** Pop-in scale: from a quarter to a little overshoot and back to 1 within the reaction window. */
export function popScale(age: number): number {
  if (age >= REACTION_TICKS) return 1;
  if (age <= 0) return 0.25;
  const k = age / REACTION_TICKS - 1;
  const c1 = 1.70158;
  return 0.25 + 0.75 * (1 + (c1 + 1) * k * k * k + c1 * k * k);
}

/** Idle motion by type: Magic floats, Hunter hops, Brute stomps. Small enough to stay on the hitbox. */
export function idlePose(type: number, age: number, phase: number, calm = false): Pose {
  const amp = calm ? 0.5 : 1;
  const t = age + phase * 120;
  if (type === 0) {
    const f = 0.5 - 0.5 * Math.cos((t / 84) * Math.PI * 2);
    return { ...REST, dy: -1.2 * f * amp };
  }
  if (type === 1) {
    const p = (t % 26) / 26;
    const hop = Math.sin(p * Math.PI);
    const land = p < 0.12 ? 1 - p / 0.12 : 0;
    return { ...REST, dy: -1.3 * hop * amp, sx: 1 + 0.05 * land * amp, sy: 1 - 0.06 * land * amp };
  }
  const p = (t % 44) / 44;
  const stomp = p < 0.18 ? Math.sin((p / 0.18) * Math.PI) : 0;
  return { ...REST, sx: 1 + 0.06 * stomp * amp, sy: 1 - 0.08 * stomp * amp };
}

/** A hit: a white blink for 45 ms, then a squash that springs back over 160 ms. */
export function hitPose(ms: number): { sx: number; sy: number; flash: boolean } {
  if (ms < 0 || ms >= 160) return { sx: 1, sy: 1, flash: false };
  const k = 1 - ms / 160;
  const e = k * k;
  return { sx: 1 + 0.24 * e, sy: 1 - 0.2 * e, flash: ms < 45 };
}

/** The catch: the Beast turns to light and shrinks into the card (k 0..1). */
export function catchPose(k: number): Pose {
  const c = Math.max(0, Math.min(1, k));
  const s = Math.max(0, 1 - c) ** 0.8;
  return { ...REST, sx: s * (1 + 0.15 * Math.sin(c * Math.PI)), sy: s, flash: true, alpha: 1 };
}

/** The flee (k 0..1): crouch, jump, dash off the side it is nearest to. `dist` field px to clear the screen. */
export function fleePose(k: number, side: -1 | 1, dist: number): Pose {
  const c = Math.max(0, Math.min(1, k));
  if (c < 0.18) {
    const q = c / 0.18;
    return { ...REST, sx: 1 + 0.14 * q, sy: 1 - 0.18 * q };
  }
  if (c < 0.4) {
    const q = (c - 0.18) / 0.22;
    return { ...REST, dy: -9 * Math.sin(q * Math.PI * 0.5), sx: 0.92, sy: 1.12 };
  }
  const q = (c - 0.4) / 0.6;
  return { ...REST, dy: -9 * (1 - q) ** 2, dx: side * dist * q * q, sx: 1.18, sy: 0.9, alpha: Math.max(0, 1 - Math.max(0, q - 0.55) / 0.45) };
}

/** Reflecting walk for menu Beasts (the same movement language as the sim, slowed). Integer field px inside the field. */
export function wanderPos(type: number, t: number, w: number, h: number, fw: number, fh: number, phase = 0): { px: number; py: number } {
  const [vx, vy] = type === 0 ? [0.32, 0.26] : type === 1 ? [0.85, 0.07] : [0.2, 0.1];
  const tri = (u: number, L: number) => {
    if (L <= 0) return 0;
    const m = ((u % (2 * L)) + 2 * L) % (2 * L);
    return m <= L ? m : 2 * L - m;
  };
  const Lx = Math.max(0, fw - w);
  const Ly = Math.max(0, fh - h);
  return { px: Math.floor(tri(t * vx + phase * 2 * Lx, Lx)), py: Math.floor(tri(t * vy + phase * 1.3 * Ly, Ly)) };
}

// ------------------------------------------------------------------ silhouettes (pure)

/** True when the art fills its border (a painting on a background, not a cut-out sprite). */
export function isOpaqueArt(rgba: ArrayLike<number>, aw: number, ah: number): boolean {
  let n = 0;
  let solid = 0;
  for (let x = 0; x < aw; x++) {
    for (const y of [0, ah - 1]) { n++; if (rgba[(y * aw + x) * 4 + 3] > 200) solid++; }
  }
  for (let y = 1; y < ah - 1; y++) {
    for (const x of [0, aw - 1]) { n++; if (rgba[(y * aw + x) * 4 + 3] > 200) solid++; }
  }
  return n > 0 && solid / n >= 0.6;
}

/**
 * The body at art resolution with a 1 px margin ((aw + 2) x (ah + 2)): the roster silhouette
 * (the same mask the hitbox comes from) resampled to the art grid. A cut-out sprite also keeps
 * every visible art pixel; a painting is clipped to the silhouette so its background drops away.
 */
export function silhouette(mask: ArrayLike<number>, w: number, h: number, rgba: ArrayLike<number>, aw: number, ah: number, opaque: boolean, margin = 1): Uint8Array {
  const W = aw + 2 * margin;
  const out = new Uint8Array(W * (ah + 2 * margin));
  for (let y = 0; y < ah; y++) {
    const my = Math.min(h - 1, Math.floor(((y + 0.5) * h) / ah));
    for (let x = 0; x < aw; x++) {
      const mx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / aw));
      const inMask = mask[my * w + mx] ? 1 : 0;
      const visible = rgba[(y * aw + x) * 4 + 3] > 24 ? 1 : 0;
      out[(y + margin) * W + x + margin] = opaque ? inMask : inMask | visible;
    }
  }
  return out;
}

/** Square dilation by one pixel. */
export function dilate1(m: Uint8Array, W: number, H: number): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!m[y * W + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < W) out[yy * W + xx] = 1;
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ habitats (pure)

export interface Habitat {
  /** Flat colours, indexed by habitatPixels. */
  palette: readonly string[];
  /** Ambient particles drawn every frame. */
  ambient: 'snow' | 'stars' | 'pollen' | 'dust' | 'confetti' | 'glints';
}

export const HABITATS: Record<ChannelId, Habitat> = {
  snowfall: { palette: ['#0e1a33', '#22345c', '#e9eef5', '#b9c6da', '#1a2b4f', '#dfe8f2', '#b4c6dc', '#0a1328', '#ffffff'], ambient: 'snow' },
  magic: { palette: ['#061923', '#0d3141', '#23d5ff', '#f4ecd8', '#08222b', '#0f3a45', '#5ee8ff', '#04131b', '#ff6a5e'], ambient: 'stars' },
  hunter: { palette: ['#5aa0e6', '#f4f8fd', '#c4dbf2', '#3f8a49', '#4b9c37', '#6dbd45', '#2f7027', '#ffe066', '#3a6e9e'], ambient: 'pollen' },
  brute: { palette: ['#36271f', '#4a372b', '#21160f', '#160e09', '#2a1f18', '#5c4636', '#6f5642', '#7d2a1c', '#40302a'], ambient: 'dust' },
  hackathon: { palette: ['#efe6d2', '#ddd1b6', '#c9b994', '#ff3b2f', '#ffc61a', '#23d5ff', '#8dff3a', '#2a2620', '#e4d9c0'], ambient: 'confetti' },
  king: { palette: ['#2a0812', '#1c050c', '#7a5a10', '#ffc61a', '#8f1020', '#ffc61a', '#120308', '#c99a16', '#5e0a18'], ambient: 'glints' },
};

/** Gold ramp for FEVER: every habitat colour is re-toned by its brightness. */
const GOLD_RAMP = ['#170e00', '#352200', '#5c3c00', '#8a5a00', '#b97c00', '#e8a400', '#ffc61a', '#ffdd6b', '#fff3c4'];

function rgbOf(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Palette re-toned to gold by luminance (FEVER tints the backdrop instead of the static). */
export function goldify(palette: readonly string[]): string[] {
  return palette.map((c) => {
    const [r, g, b] = rgbOf(c);
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const i = Math.round(Math.min(1, Math.max(0, (l - 0.04) * 1.25)) * (GOLD_RAMP.length - 1));
    return GOLD_RAMP[i];
  });
}

/** Deterministic 0..1 hash of a cell. */
export function hash2(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const TAU = Math.PI * 2;

/**
 * The habitat backdrop as palette indices, `cols` x `rows` backdrop pixels: flat fields plus a
 * pixel pattern (dither, stars, grass tiles, bricks). Deterministic; no gradients, no noise.
 */
export function habitatPixels(id: ChannelId, cols: number, rows: number): Uint8Array {
  const C = Math.max(1, cols | 0);
  const R = Math.max(1, rows | 0);
  const out = new Uint8Array(C * R);
  const put = (x: number, y: number, c: number) => { if (x >= 0 && y >= 0 && x < C && y < R) out[y * C + x] = c; };
  const disc = (cx: number, cy: number, r: number, c: number) => {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) put(x, y, c);
    }
  };
  const fill = (fn: (x: number, y: number) => number) => {
    for (let y = 0; y < R; y++) for (let x = 0; x < C; x++) out[y * C + x] = fn(x, y);
  };

  if (id === 'snowfall') {
    const horizon = Math.round(R * 0.6);
    const hill = (x: number) => horizon - Math.round(R * 0.05 + R * 0.06 * (0.5 + 0.5 * Math.sin((x / C) * TAU * 1.4 + 0.8)) + R * 0.025 * Math.sin((x / C) * TAU * 4.6));
    fill((x, y) => {
      if (y >= horizon) {
        const crest = horizon + Math.round(R * 0.11 + 2 * Math.sin(x / 9) + 1.5 * Math.sin(x / 23 + 1));
        const crest2 = horizon + Math.round(R * 0.27 + 2 * Math.sin(x / 13 + 2));
        if (y === crest || y === crest2) return 6;
        if ((y === crest + 1 || y === crest2 + 1) && (x + y) % 2 === 0) return 6;
        if (hash2(x, y, 3) < 0.004) return 8;
        return 5;
      }
      if (y >= hill(x)) return 4;
      return hash2(x, y, 1) < 0.005 ? 1 : 0;
    });
    // pines on the horizon, snow on their shoulders
    for (let i = 0; i < 16; i++) {
      const cx = Math.round(((i + 0.5) / 16) * C + (hash2(i, 0, 5) - 0.5) * (C / 20));
      const th = Math.round(R * (0.07 + 0.07 * hash2(i, 1, 5)));
      const top = horizon - th;
      for (let y = top; y < horizon; y++) {
        const half = Math.floor((y - top) * 0.42);
        for (let x = cx - half; x <= cx + half; x++) put(x, y, (y - top) % 4 === 1 && x === cx - half ? 6 : 7);
      }
    }
    const mr = Math.max(3, R * 0.075);
    const mx = C * 0.8;
    const my = R * 0.19;
    disc(mx, my, mr, 2);
    disc(mx + mr * 0.45, my + mr * 0.15, mr * 0.28, 3);
    disc(mx - mr * 0.35, my - mr * 0.35, mr * 0.18, 3);
    return out;
  }

  if (id === 'magic') {
    const horizon = Math.round(R * 0.74);
    const band = (x: number, base: number, ph: number) => base + R * 0.045 * Math.sin((x / C) * TAU * 1.3 + ph) + R * 0.02 * Math.sin((x / C) * TAU * 3.7 + ph * 2);
    fill((x, y) => {
      if (y >= horizon) {
        if ((y - horizon) % 6 === 0 && (x + (y >> 1)) % 4 < 2) return 5;
        return (x + y) % 2 === 0 && hash2(x >> 2, y >> 2, 9) < 0.18 ? 5 : 4;
      }
      for (const [base, ph] of [[R * 0.2, 0.3], [R * 0.36, 2.1]] as const) {
        const d = Math.abs(y - band(x, base, ph));
        if (d < 1.6) return 1;
        if (d < 3.6 && (x + y) % 2 === 0) return 1;
      }
      const r = hash2(x, y, 2);
      return r < 0.0035 ? 3 : r < 0.007 ? 2 : 0;
    });
    // tree line and glowing mushrooms
    for (let x = 0; x < C; x++) {
      const top = horizon - Math.round(R * 0.05 + R * 0.05 * (0.5 + 0.5 * Math.sin(x / 7)) * (0.6 + 0.4 * Math.sin(x / 19 + 1)));
      for (let y = top; y < horizon; y++) put(x, y, 7);
    }
    for (let i = 0; i < 9; i++) {
      const cx = Math.round(((i + 0.5) / 9) * C + (hash2(i, 2, 4) - 0.5) * (C / 12));
      const cy = horizon + Math.round(R * (0.05 + 0.16 * hash2(i, 3, 4)));
      for (let y = cy; y < cy + 3; y++) put(cx, y, 3);
      for (let x = cx - 2; x <= cx + 2; x++) put(x, cy - 1, 6);
      for (let x = cx - 1; x <= cx + 1; x++) put(x, cy - 2, 6);
      put(cx - 1, cy - 1, 8);
    }
    return out;
  }

  if (id === 'hunter') {
    const horizon = Math.round(R * 0.36);
    fill((x, y) => {
      if (y < horizon) {
        const hill = horizon - Math.round(R * 0.04 + R * 0.05 * (0.5 + 0.5 * Math.sin((x / C) * TAU * 1.1 + 2)));
        if (y >= hill) return 3;
        if (y >= hill - 2 && (x + y) % 2 === 0) return 3;
        return 0;
      }
      // grass tiles: a tuft per 12 x 8 tile, offset every other row
      const ty = Math.floor((y - horizon) / 8);
      const off = ty % 2 ? 6 : 0;
      const tx = Math.floor((x + off) / 12);
      const lx = (x + off) % 12;
      const ly = (y - horizon) % 8;
      const hx = 3 + Math.floor(hash2(tx, ty, 6) * 6);
      if (ly === 5 && (lx === hx - 1 || lx === hx + 1)) return 5;
      if (ly === 4 && lx === hx) return 5;
      if (ly === 6 && lx >= hx - 1 && lx <= hx + 1) return 6;
      if (hash2(x, y, 8) < 0.01) return 7;
      return 4;
    });
    for (const [cx, cy, s] of [[0.18, 0.12, 1], [0.55, 0.07, 0.8], [0.84, 0.17, 1.1]] as const) {
      const r = R * 0.045 * s;
      disc(C * cx, R * cy, r, 1);
      disc(C * cx - r * 1.2, R * cy + r * 0.35, r * 0.75, 1);
      disc(C * cx + r * 1.25, R * cy + r * 0.3, r * 0.8, 1);
      for (let x = Math.floor(C * cx - r * 2); x <= Math.ceil(C * cx + r * 2); x++) {
        const y = Math.round(R * cy + r * 0.95);
        if (out[y * C + x] === 1) put(x, y, 2);
      }
    }
    return out;
  }

  if (id === 'brute') {
    const floor = Math.round(R * 0.72);
    fill((x, y) => {
      if (y >= floor) {
        if (y === floor) return 2;
        if (y === floor + 1) return 6;
        return hash2(x >> 1, y >> 1, 11) < 0.07 ? 5 : (x + y) % 2 === 0 && hash2(x >> 3, y >> 3, 12) < 0.3 ? 8 : 4;
      }
      const bh = 7;
      const bw = 16;
      const row = Math.floor(y / bh);
      const off = row % 2 ? bw / 2 : 0;
      const col = Math.floor((x + off) / bw);
      const lx = (x + off) % bw;
      const ly = y % bh;
      if (ly === 0 || lx === 0) return 2;
      const tone = hash2(col, row, 13);
      if (ly === 1 && tone > 0.45) return 6;
      if (tone < 0.06 && lx > 3 && lx < bw - 3 && ly > 1 && ly < bh - 1) return 7;
      return tone < 0.35 ? 0 : 1;
    });
    // cracks
    for (let i = 0; i < 7; i++) {
      let x = Math.floor(hash2(i, 0, 14) * C);
      let y = Math.floor(hash2(i, 1, 14) * floor * 0.8);
      for (let s = 0; s < 14; s++) {
        put(x, y, 3);
        y += 1;
        x += hash2(i, s, 15) < 0.5 ? -1 : 1;
      }
    }
    return out;
  }

  if (id === 'hackathon') {
    fill((x, y) => (x % 32 === 0 || y % 32 === 0 ? 2 : x % 8 === 0 || y % 8 === 0 ? 1 : 0));
    for (let i = 0; i < 9; i++) {
      const cx = ((i + 0.5) / 9) * C + (hash2(i, 0, 21) - 0.5) * (C / 10);
      const cy = R * (0.15 + 0.7 * hash2(i, 1, 21));
      const r = Math.max(2, R * (0.025 + 0.03 * hash2(i, 2, 21)));
      const c = 3 + (i % 4);
      disc(cx, cy, r, c);
      disc(cx + r * 0.9, cy - r * 0.4, r * 0.55, c);
      disc(cx - r * 0.8, cy + r * 0.5, r * 0.5, c);
      const drip = Math.round(r * (1 + 2.5 * hash2(i, 3, 21)));
      for (let y = Math.round(cy + r); y < Math.round(cy + r + drip); y++) put(Math.round(cx - r * 0.2), y, c);
      put(Math.round(cx - r * 0.2), Math.round(cy + r + drip), c);
      for (let k = 0; k < 4; k++) {
        const a = hash2(i, 10 + k, 21) * TAU;
        put(Math.round(cx + Math.cos(a) * r * 2.1), Math.round(cy + Math.sin(a) * r * 2.1), c);
      }
    }
    return out;
  }

  // king: a throne hall. Gold lattice on red, pillars at the sides, a carpet at the foot.
  const carpet = Math.round(R * 0.78);
  fill((x, y) => {
    if (y >= carpet) {
      if (y === carpet || y === carpet + 2) return 5;
      if (y === carpet + 1) return 4;
      return (x + y * 3) % 10 === 0 && (y - carpet) % 4 === 2 ? 5 : 4;
    }
    const a = (x + y) % 12;
    const b = (x - y + 12 * 1000) % 12;
    if (a === 0 && b === 0) return 3;
    if (a === 0 || b === 0) return 2;
    return (x + y) % 2 === 0 && (a === 6 || b === 6) ? 8 : 0;
  });
  const pw = Math.max(4, Math.round(C * 0.055));
  for (const left of [true, false]) {
    for (let y = 0; y < carpet; y++) {
      for (let k = 0; k < pw; k++) {
        const x = left ? k : C - 1 - k;
        put(x, y, k === pw - 1 ? 7 : (y % 10 === 0 ? 7 : 6));
      }
    }
  }
  for (const fx of [0.22, 0.78]) {
    const bw = Math.max(5, Math.round(C * 0.07));
    const x0 = Math.round(C * fx - bw / 2);
    const bot = Math.round(R * 0.34);
    for (let y = 0; y < bot; y++) for (let x = x0; x < x0 + bw; x++) put(x, y, x === x0 || x === x0 + bw - 1 ? 5 : 4);
    for (let x = x0; x < x0 + bw; x++) if ((x - x0) % 2 === 0) { put(x, bot, 5); put(x, bot + 1, 5); }
    disc(x0 + bw / 2 - 0.5, bot * 0.45, Math.max(1, bw * 0.22), 3);
  }
  return out;
}

// ------------------------------------------------------------------ canvas helpers

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

function paintRGBA(w: number, h: number, fn: (i: number, out: Uint8ClampedArray) => void): HTMLCanvasElement {
  const c = canvas(w, h);
  const g = c.getContext('2d');
  if (!g) return c;
  const id = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) fn(i, id.data);
  g.putImageData(id, 0, 0);
  return c;
}

// ------------------------------------------------------------------ sprite art (cached per species)

/** Art-pixel margin around every sprite canvas: room for the rim and the King's outer aura. */
export const MARGIN = 2;

export interface SpriteArt {
  aw: number;
  ah: number;
  /** (aw + 2 * MARGIN) x (ah + 2 * MARGIN): the dark body plate with the art on it. */
  body: HTMLCanvasElement;
  shiny: HTMLCanvasElement;
  /** The body plus its 1 px rim, all white (hit flash, catch). */
  flash: HTMLCanvasElement;
  /** The 1 px rim just outside the body. */
  rim(color: string): HTMLCanvasElement;
  /** A second ring outside the rim (the King's aura). */
  aura(color: string): HTMLCanvasElement;
}

const artCache = new Map<number, SpriteArt>();

/** The species' sprite canvases, or null until its art has loaded. */
export function spriteArt(e: RosterEntry): SpriteArt | null {
  const hit = artCache.get(e.speciesId);
  if (hit) return hit;
  const img = artOf(e);
  if (!img.complete || !img.naturalWidth) return null;
  const built = buildArt(e, img);
  if (built) artCache.set(e.speciesId, built);
  return built;
}

function buildArt(e: RosterEntry, img: HTMLImageElement): SpriteArt | null {
  const [ax, ay, aw0, ah0] = e.artBox;
  const aw = Math.max(1, aw0);
  const ah = Math.max(1, ah0);
  const src = canvas(aw, ah);
  const sg = src.getContext('2d', { willReadFrequently: true });
  if (!sg) return null;
  sg.drawImage(img, ax, ay, aw, ah, 0, 0, aw, ah);
  let px: Uint8ClampedArray;
  try {
    px = sg.getImageData(0, 0, aw, ah).data;
  } catch {
    return null;
  }
  const W = aw + 2 * MARGIN;
  const H = ah + 2 * MARGIN;
  const opaque = isOpaqueArt(px, aw, ah);
  const core = silhouette(maskOf(e), e.w, e.h, px, aw, ah, opaque, MARGIN);
  const halo = dilate1(core, W, H);
  const halo2 = dilate1(halo, W, H);
  const plate = PLATE[e.type] ?? PLATE[0];
  const gold = new Uint8ClampedArray(px);
  shinyPixels(gold);
  const body = (art: Uint8ClampedArray) => paintRGBA(W, H, (i, o) => {
    if (!core[i]) return;
    const x = (i % W) - MARGIN;
    const y = Math.floor(i / W) - MARGIN;
    let r = plate[0];
    let g = plate[1];
    let b = plate[2];
    if (x >= 0 && y >= 0 && x < aw && y < ah) {
      const j = (y * aw + x) * 4;
      const a = art[j + 3] / 255;
      if (a > 0.09) {
        r = art[j] * a + r * (1 - a);
        g = art[j + 1] * a + g * (1 - a);
        b = art[j + 2] * a + b * (1 - a);
      }
    }
    o[i * 4] = r;
    o[i * 4 + 1] = g;
    o[i * 4 + 2] = b;
    o[i * 4 + 3] = 255;
  });
  const rims = new Map<string, HTMLCanvasElement>();
  const auras = new Map<string, HTMLCanvasElement>();
  return {
    aw,
    ah,
    body: body(px),
    shiny: body(gold),
    flash: paintRGBA(W, H, (i, o) => { if (halo[i]) o.set([255, 255, 255, 255], i * 4); }),
    rim(color: string) {
      let c = rims.get(color);
      if (!c) {
        const [r, g, b] = rgbOf(color);
        c = paintRGBA(W, H, (i, o) => { if (halo[i] && !core[i]) o.set([r, g, b, 255], i * 4); });
        rims.set(color, c);
      }
      return c;
    },
    aura(color: string) {
      let c = auras.get(color);
      if (!c) {
        const [r, g, b] = rgbOf(color);
        c = paintRGBA(W, H, (i, o) => { if (halo2[i] && !halo[i]) o.set([r, g, b, 255], i * 4); });
        auras.set(color, c);
      }
      return c;
    },
  };
}

/**
 * A Beast as the game draws it (rim, body plate, art) on its own small canvas, for the HUD rail,
 * banners and menus. Scale it with CSS (image-rendering: pixelated). Null until the art loads.
 */
export function spriteThumb(e: RosterEntry, shiny = false, rim: string | null = null): HTMLCanvasElement | null {
  const art = spriteArt(e);
  if (!art) return null;
  const c = canvas(art.aw + 2, art.ah + 2);
  const g = c.getContext('2d');
  if (!g) return null;
  const o = 1 - MARGIN;
  g.drawImage(art.rim(rim ?? (shiny ? ARC.gold : (TYPE_COLOR[e.type] ?? ARC.ink))), o, o);
  g.drawImage(shiny ? art.shiny : art.body, o, o);
  c.className = 'cx-thumb';
  return c;
}

// ------------------------------------------------------------------ drawing

/** What the stage needs to draw one live Beast. Built by the game from the sim every frame. */
export interface SpriteSpec {
  /** Stable id (spawn index). */
  key: number;
  entry: RosterEntry;
  /** Sim position (top-left of the hitbox) in field px. */
  px: number;
  py: number;
  /** Ticks since it surfaced, and until it escapes. */
  age: number;
  left: number;
  shiny: boolean;
  king: boolean;
  hp: number;
  maxHp: number;
  /** performance.now() of its last hit (-Infinity if never). */
  hitAt: number;
  /** 0..1 animation phase so a crowd does not bob in step. */
  phase: number;
}

/** The pixel crown worn by the King: 0 empty, 1 gold, 2 jewel, 3 shade. */
const CROWN = [
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  [1, 1, 0, 1, 1, 1, 0, 1, 1],
  [1, 1, 1, 1, 2, 1, 1, 1, 1],
  [1, 2, 1, 1, 1, 1, 1, 2, 1],
  [3, 3, 3, 3, 3, 3, 3, 3, 3],
];

function rimColor(s: SpriteSpec, now: number): string {
  if (s.king) return Math.floor(now / 160) % 2 ? ARC.gold : ARC.hot;
  if (s.shiny) return ARC.gold;
  return TYPE_COLOR[s.entry.type] ?? ARC.ink;
}

/**
 * Where a sprite lands this frame: its integer-scale rect with the pose applied around its feet.
 * Returned rect is the art area; the 1-art-px rim lies just outside it.
 */
export function posedRect(L: StageLayout, e: { w: number; h: number }, aw: number, ah: number, px: number, py: number, p: Pose): Rect & { k: number; kx: number; ky: number } {
  const r = spriteRect(L, px, py, e.w, e.h, aw, ah);
  const w = Math.max(1, Math.round(r.w * p.sx));
  const h = Math.max(1, Math.round(r.h * p.sy));
  const cx = r.x + r.w / 2;
  const bottom = r.y + r.h;
  return {
    x: Math.round(cx - w / 2 + p.dx * L.s),
    y: Math.round(bottom - h + p.dy * L.s),
    w,
    h,
    k: r.k,
    kx: w / aw,
    ky: h / ah,
  };
}

/** One sprite with its rim (and an outer aura for the King). `art` must already be loaded. */
export function drawArt(g: CanvasRenderingContext2D, art: SpriteArt, r: Rect & { kx: number; ky: number }, rim: string | null, mode: 'art' | 'shiny' | 'flash', alpha = 1, aura: string | null = null) {
  const mx = Math.round(r.kx * MARGIN);
  const my = Math.round(r.ky * MARGIN);
  const x = r.x - mx;
  const y = r.y - my;
  const w = r.w + 2 * mx;
  const h = r.h + 2 * my;
  g.globalAlpha = alpha;
  if (aura && mode !== 'flash') g.drawImage(art.aura(aura), x, y, w, h);
  if (rim && mode !== 'flash') g.drawImage(art.rim(rim), x, y, w, h);
  g.drawImage(mode === 'flash' ? art.flash : mode === 'shiny' ? art.shiny : art.body, x, y, w, h);
  g.globalAlpha = 1;
}

/** A flat pixel ellipse (rows of P device px). */
function pixelEllipse(g: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, P: number, color: string) {
  g.fillStyle = color;
  const rows = Math.max(1, Math.round(ry / P));
  for (let i = -rows; i <= rows; i++) {
    const t = i / (rows + 0.5);
    const half = rx * Math.sqrt(Math.max(0, 1 - t * t));
    const w = Math.round(half / P) * P * 2;
    if (w <= 0) continue;
    g.fillRect(Math.round(cx - w / 2), Math.round(cy + i * P - P / 2), w, P);
  }
}

/** Ground shadow under a Beast: dark, with a type-coloured glow ring. */
export function drawShadow(g: CanvasRenderingContext2D, L: StageLayout, e: RosterEntry, px: number, py: number, scale: number, color: string, king = false) {
  const P = pixelSize(L);
  const b = boxRect(L, px, py, e.w, e.h);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h - P;
  const rx = b.w * 0.44 * scale * (king ? 1.25 : 1);
  const ry = Math.max(P, b.h * 0.07 * scale * (king ? 1.3 : 1));
  g.globalAlpha = 0.45;
  pixelEllipse(g, cx, cy, rx + P, ry + P, P, color);
  g.globalAlpha = 0.5;
  pixelEllipse(g, cx, cy, rx, ry, P, '#000');
  g.globalAlpha = 1;
}

/** Four-point pixel star. */
export function pixelStar(g: CanvasRenderingContext2D, x: number, y: number, arm: number, P: number, color: string) {
  g.fillStyle = color;
  const cx = Math.round(x / P) * P;
  const cy = Math.round(y / P) * P;
  g.fillRect(cx - arm * P, cy, (arm * 2 + 1) * P, P);
  g.fillRect(cx, cy - arm * P, P, (arm * 2 + 1) * P);
  g.fillStyle = '#fff';
  g.fillRect(cx, cy, P, P);
}

/** The pose of a live Beast this frame (pop-in, idle, hit squash, pre-escape tremble). */
export function livePose(s: SpriteSpec, now: number, calm: boolean): Pose {
  const idle = idlePose(s.entry.type, s.age, s.phase, calm);
  const pop = popScale(s.age);
  const hit = hitPose(now - s.hitAt);
  const tremble = s.left <= WARN_TICKS && !calm ? ((s.age >> 1) & 1 ? 0.6 : -0.6) : 0;
  // The King breathes: a slow swell that keeps it on its hitbox.
  const breathe = s.king && !calm ? 1 + 0.03 * Math.sin(s.age / 9) : 1;
  return { dx: idle.dx + tremble, dy: idle.dy, sx: idle.sx * pop * hit.sx * breathe, sy: idle.sy * pop * hit.sy * breathe, alpha: 1, flash: hit.flash || s.age < 2 };
}

/** Draw a live Beast: rim, body (or flash), shiny gold. Shadow and decorations are separate passes. */
export function drawLive(g: CanvasRenderingContext2D, L: StageLayout, s: SpriteSpec, now: number, calm: boolean): boolean {
  const art = spriteArt(s.entry);
  const pose = livePose(s, now, calm);
  if (!art) {
    // Art still loading: a type-coloured block on the hitbox, never nothing.
    const b = boxRect(L, s.px, s.py, s.entry.w, s.entry.h);
    g.fillStyle = TYPE_COLOR[s.entry.type] ?? ARC.ink;
    g.globalAlpha = 0.6;
    g.fillRect(b.x, b.y, b.w, b.h);
    g.globalAlpha = 1;
    return false;
  }
  const r = posedRect(L, s.entry, art.aw, art.ah, s.px, s.py, pose);
  const rim = rimColor(s, now);
  drawArt(g, art, r, rim, s.shiny ? 'shiny' : 'art', 1, s.king ? (rim === ARC.hot ? ARC.gold : ARC.hot) : null);
  // The hit blink lies over the art so the Beast stays readable under fast tapping.
  if (pose.flash) drawArt(g, art, r, null, 'flash', s.age < 2 ? 1 : 0.7);
  return true;
}

/** HP pips, the King's crown, shiny sparkles and the pre-escape "!" (drawn above every sprite). */
export function drawDecor(g: CanvasRenderingContext2D, L: StageLayout, s: SpriteSpec, now: number, calm: boolean) {
  const P = pixelSize(L);
  const art = spriteArt(s.entry);
  const pose = livePose(s, now, calm);
  const r = art ? posedRect(L, s.entry, art.aw, art.ah, s.px, s.py, pose) : { ...boxRect(L, s.px, s.py, s.entry.w, s.entry.h), k: 1, kx: 1, ky: 1 };
  const cx = r.x + r.w / 2;
  let top = r.y - Math.round(r.ky) - P;
  if (s.age < REACTION_TICKS) {
    // pop-in burst
    const k = s.age / REACTION_TICKS;
    const rad = (0.3 + 0.9 * k) * Math.max(r.w, r.h) * 0.6;
    g.globalAlpha = 1 - k;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      g.fillStyle = i % 2 ? ARC.ink : (TYPE_COLOR[s.entry.type] ?? ARC.ink);
      g.fillRect(Math.round(cx + Math.cos(a) * rad - P / 2), Math.round(r.y + r.h / 2 + Math.sin(a) * rad - P / 2), P * 2, P * 2);
    }
    g.globalAlpha = 1;
  }
  if (s.king) {
    const cp = Math.max(2, Math.round(L.s * 1.05));
    const cw = CROWN[0].length * cp;
    const ch = CROWN.length * cp;
    const x0 = Math.round(cx - cw / 2);
    const y0 = Math.round(r.y - ch + cp);
    const bob = calm ? 0 : Math.round(Math.sin(now / 220) * cp * 0.5);
    for (let y = 0; y < CROWN.length; y++) {
      for (let x = 0; x < CROWN[y].length; x++) {
        const v = CROWN[y][x];
        if (!v) continue;
        g.fillStyle = v === 2 ? ARC.hot : v === 3 ? '#a87a00' : ARC.gold;
        g.fillRect(x0 + x * cp, y0 + y * cp + bob, cp, cp);
      }
    }
    top = y0 + bob - P;
  }
  if (s.maxHp > 1) {
    const pip = Math.max(3, Math.round(L.s * (s.king ? 1.9 : 1.7)));
    const gap = Math.max(1, Math.round(pip * 0.4));
    const total = s.maxHp * pip + (s.maxHp - 1) * gap;
    const y = top - pip - Math.round(P * 0.5);
    let x = Math.round(cx - total / 2);
    for (let i = 0; i < s.maxHp; i++) {
      g.fillStyle = '#000';
      g.fillRect(x - 1, y - 1, pip + 2, pip + 2);
      g.fillStyle = i < s.hp ? (s.king ? ARC.hot : ARC.gold) : '#3a352c';
      g.fillRect(x, y, pip, pip);
      x += pip + gap;
    }
    top = y - P;
  }
  if (s.shiny) {
    for (let i = 0; i < 5; i++) {
      const tw = Math.sin(now / 130 + i * 2.1 + s.phase * 7);
      if (tw < 0.1) continue;
      const a = i * 2.4 + s.phase * 6 + (calm ? 0 : now / 1400);
      const sx = cx + Math.cos(a) * r.w * 0.62;
      const sy = r.y + r.h / 2 + Math.sin(a) * r.h * 0.6;
      pixelStar(g, sx, sy, tw > 0.7 ? 2 : 1, P, i % 2 ? ARC.gold : '#fff3c4');
    }
  }
  if (s.left <= WARN_TICKS && Math.floor(now / 120) % 2 === 0) {
    // "!" bubble at the top-right corner: it is about to flee
    const u = Math.max(2, Math.round(L.s * 0.9));
    const bx = Math.round(r.x + r.w - u);
    const by = Math.round(r.y - u * 6);
    g.fillStyle = '#000';
    g.fillRect(bx - u, by - u, u * 5, u * 9);
    g.fillStyle = ARC.hot;
    g.fillRect(bx, by, u * 3, u * 7);
    g.fillStyle = '#fff';
    g.fillRect(bx + u, by + u, u, u * 3);
    g.fillRect(bx + u, by + u * 5, u, u);
  }
}

// ------------------------------------------------------------------ exits (catch, flee)

interface Exit { s: SpriteSpec; kind: 'catch' | 'flee'; t0: number; dur: number; side: -1 | 1 }

function drawExit(g: CanvasRenderingContext2D, L: StageLayout, x: Exit, now: number, calm: boolean): boolean {
  const k = (now - x.t0) / x.dur;
  if (k >= 1) return false;
  if (k < 0) return true;
  const art = spriteArt(x.s.entry);
  const P = pixelSize(L);
  const e = x.s.entry;
  if (x.kind === 'catch') {
    const pose = catchPose(k);
    if (art) drawArt(g, art, posedRect(L, e, art.aw, art.ah, x.s.px, x.s.py, { ...pose, dy: -(e.h / 2) * (1 - pose.sy) }), null, 'flash', 1);
    const b = boxRect(L, x.s.px, x.s.py, e.w, e.h);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    g.globalAlpha = 1 - k;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU + 0.3;
      const d = (0.25 + k * 1.1) * Math.max(b.w, b.h) * 0.7;
      g.fillStyle = i % 2 ? ARC.gold : '#fff';
      const len = Math.max(1, Math.round(3 * (1 - k)));
      for (let j = 0; j < len; j++) {
        g.fillRect(Math.round(cx + Math.cos(a) * (d + j * P * 1.5)), Math.round(cy + Math.sin(a) * (d + j * P * 1.5)), P, P);
      }
    }
    g.globalAlpha = 1;
    return true;
  }
  // flee
  const b = boxRect(L, x.s.px, x.s.py, e.w, e.h);
  const toEdge = x.side < 0 ? x.s.px + e.w + 8 : L.fw - x.s.px + 8;
  const pose = fleePose(calm ? Math.min(1, k * 1.2) : k, x.side, toEdge);
  if (k < 0.5) {
    // dust puffs where it took off
    const q = k / 0.5;
    g.globalAlpha = 1 - q;
    g.fillStyle = '#d8d0bd';
    for (let i = 0; i < 5; i++) {
      const dx = (i - 2) * P * 3 * (1 + q * 2);
      const sz = Math.round(P * (2 - q));
      g.fillRect(Math.round(b.x + b.w / 2 + dx), Math.round(b.y + b.h - P * (1 + q * 3)), sz, sz);
    }
    g.globalAlpha = 1;
  }
  if (art) {
    const r = posedRect(L, e, art.aw, art.ah, x.s.px, x.s.py, pose);
    if (k > 0.4 && pose.alpha > 0) {
      // speed lines trailing behind
      g.globalAlpha = pose.alpha * 0.8;
      g.fillStyle = ARC.ink;
      for (let i = 0; i < 3; i++) {
        const ly = Math.round(r.y + r.h * (0.25 + i * 0.25));
        const len = Math.round(r.w * (0.5 + 0.2 * i));
        g.fillRect(x.side > 0 ? r.x - len - P * 2 : r.x + r.w + P * 2, ly, len, P);
      }
      g.globalAlpha = 1;
    }
    drawArt(g, art, r, ARC.hot, x.s.shiny ? 'shiny' : 'art', pose.alpha);
  }
  return true;
}

// ------------------------------------------------------------------ ambient (drawn every frame)

function drawAmbient(g: CanvasRenderingContext2D, L: StageLayout, kind: Habitat['ambient'], fever: boolean, t: number, calm: boolean) {
  const P = pixelSize(L);
  const C = Math.ceil(L.devW / P);
  const R = Math.ceil(L.devH / P);
  const n = Math.round((calm ? 0.5 : 1) * (kind === 'snow' ? 90 : kind === 'stars' || kind === 'glints' ? 40 : 26) * (C / 260));
  const speed = calm ? 0.5 : 1;
  for (let i = 0; i < n; i++) {
    const hx = hash2(i, 1, 77);
    const hy = hash2(i, 2, 77);
    const hz = hash2(i, 3, 77);
    let x = 0;
    let y = 0;
    let color: string = ARC.ink;
    let size = 1;
    let alpha = 1;
    if (kind === 'snow') {
      const v = (0.08 + 0.12 * hz) * speed;
      y = (hy * R + t * v) % R;
      x = (hx * C + Math.sin(t / 40 + i) * 2 + t * 0.03 * speed) % C;
      color = '#ffffff';
      size = hz > 0.8 ? 2 : 1;
      alpha = 0.55 + 0.45 * hz;
    } else if (kind === 'stars' || kind === 'glints') {
      const tw = Math.sin(t / (14 + hz * 18) + i * 1.7);
      if (tw < 0.55) continue;
      x = hx * C;
      y = (kind === 'stars' ? hy * 0.7 : hy * 0.75) * R;
      color = kind === 'stars' ? (i % 3 ? ARC.cyan : ARC.ink) : ARC.gold;
      size = tw > 0.9 ? 2 : 1;
      if (size === 2) {
        pixelStar(g, Math.round(x) * P, Math.round(y) * P, 1, P, fever ? ARC.gold : color);
        continue;
      }
    } else if (kind === 'pollen') {
      x = (hx * C + t * (0.15 + 0.2 * hz) * speed) % C;
      y = hy * R + Math.sin(t / 30 + i) * 3;
      color = i % 2 ? '#fff3b0' : '#e8ffd0';
      alpha = 0.8;
    } else if (kind === 'dust') {
      x = (hx * C + Math.sin(t / 50 + i) * 4) % C;
      y = (hy * R + t * (0.02 + 0.04 * hz) * speed) % R;
      color = '#8a7360';
      alpha = 0.7;
    } else {
      x = (hx * C + Math.sin(t / 35 + i * 3) * 3) % C;
      y = (hy * R + t * (0.05 + 0.06 * hz) * speed) % R;
      color = [ARC.hot, ARC.gold, ARC.cyan, ARC.lime][i % 4];
    }
    g.globalAlpha = alpha;
    g.fillStyle = fever ? (i % 2 ? ARC.gold : '#fff3c4') : color;
    g.fillRect(Math.round(x) * P, Math.round(y) * P, P * size, P * size);
  }
  g.globalAlpha = 1;
}

/** Paint a habitat backdrop into a canvas of the stage's device size. */
export function paintBackdrop(target: HTMLCanvasElement, L: StageLayout, id: ChannelId, fever: boolean) {
  const P = pixelSize(L);
  const cols = Math.ceil(L.devW / P);
  const rows = Math.ceil(L.devH / P);
  const pix = habitatPixels(id, cols, rows);
  const pal = (fever ? goldify(HABITATS[id].palette) : HABITATS[id].palette).map(rgbOf);
  const small = paintRGBA(cols, rows, (i, o) => {
    const c = pal[pix[i]] ?? pal[0];
    o[i * 4] = c[0];
    o[i * 4 + 1] = c[1];
    o[i * 4 + 2] = c[2];
    o[i * 4 + 3] = 255;
  });
  target.width = L.devW;
  target.height = L.devH;
  const g = target.getContext('2d');
  if (!g) return;
  g.imageSmoothingEnabled = false;
  g.drawImage(small, 0, 0, cols * P, rows * P);
}

// ------------------------------------------------------------------ the stage

const STEP_MS = 1000 / 60;

export interface StageOptions {
  habitat: ChannelId;
  fieldW?: number;
  fieldH?: number;
  className?: string;
}

/**
 * The BEAST CATCH screen: a canvas, a fixed 60 Hz clock with hit-stop and pause, the habitat
 * backdrop, and the sprites the game hands it each frame. Same clock contract the old TV had:
 * `onTick(t)` advances the game, `shownTick` is the tick on screen (strikes are stamped with it).
 */
export class SpriteStage {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  L: StageLayout;
  /** Next tick to simulate, and the tick whose state is on screen (-1 before the first). */
  tick = 0;
  shownTick = -1;
  paused = false;
  holdUntil = 0;
  habitat: ChannelId;
  fever = false;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private onTick: (tick: number) => void = () => {};
  private scene: (tick: number) => SpriteSpec[] = () => [];
  private onFrame: (() => void) | null = null;
  private ro: ResizeObserver | null = null;
  private dirty = true;
  private backdrop: HTMLCanvasElement | null = null;
  private backdropKey = '';
  private exits: Exit[] = [];
  private readonly onResize = () => { this.dirty = true; };

  constructor(parent: HTMLElement, opts: StageOptions) {
    this.habitat = opts.habitat;
    this.canvas = document.createElement('canvas');
    this.canvas.className = opts.className ?? 'cx-canvas';
    parent.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d', { alpha: false }) ?? this.canvas.getContext('2d')!;
    this.L = stageLayout(1, 1, 1, opts.fieldW ?? FIELD_W, opts.fieldH ?? FIELD_H);
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(this.onResize);
      this.ro.observe(this.canvas);
    }
    window.addEventListener('resize', this.onResize);
  }

  private measure() {
    this.dirty = false;
    const cssW = this.canvas.clientWidth || 1;
    const cssH = this.canvas.clientHeight || 1;
    this.L = stageLayout(cssW, cssH, window.devicePixelRatio || 1, this.L.fw, this.L.fh);
    if (this.canvas.width !== this.L.devW) this.canvas.width = this.L.devW;
    if (this.canvas.height !== this.L.devH) this.canvas.height = this.L.devH;
  }

  /** Freeze game time for `ms` (a true hit-stop: nothing moves, nothing is missed). */
  hold(ms: number) {
    this.holdUntil = Math.max(this.holdUntil, performance.now() + ms);
  }

  start(onTick: (tick: number) => void, scene: (tick: number) => SpriteSpec[], onFrame?: () => void) {
    this.onTick = onTick;
    this.scene = scene;
    this.onFrame = onFrame ?? null;
    this.last = performance.now();
    this.acc = 0;
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      let dt = now - this.last;
      this.last = now;
      if (this.paused) return;
      if (now < this.holdUntil) {
        this.render(now);
        this.onFrame?.();
        return;
      }
      if (dt > 250) dt = STEP_MS; // tab was hidden: do not fast-forward
      this.acc += dt;
      let guard = 0;
      while (this.acc >= STEP_MS && guard++ < 5) {
        this.acc -= STEP_MS;
        const t = this.tick;
        this.onTick(t);
        this.shownTick = t;
        this.tick++;
        // A hit-stop requested inside onTick takes effect at once.
        if (performance.now() < this.holdUntil) { this.acc = 0; break; }
      }
      if (guard >= 5) this.acc = 0;
      this.render(now);
      this.onFrame?.();
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** The exit animation of a Beast that just left the sim: caught (light, then the card) or fled. */
  exit(s: SpriteSpec, kind: 'catch' | 'flee', now: number, dur = kind === 'catch' ? 190 : 560) {
    const side: -1 | 1 = s.px + s.entry.w / 2 < this.L.fw / 2 ? -1 : 1;
    this.exits.push({ s, kind, t0: now, dur, side });
  }

  render(now: number) {
    if (this.dirty) this.measure();
    const g = this.g;
    const L = this.L;
    const calm = settings.calm;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = false;
    const key = `${this.habitat}|${this.fever}|${L.devW}x${L.devH}|${L.fw}`;
    if (key !== this.backdropKey || !this.backdrop) {
      this.backdrop ??= document.createElement('canvas');
      paintBackdrop(this.backdrop, L, this.habitat, this.fever);
      this.backdropKey = key;
    }
    g.drawImage(this.backdrop, 0, 0);
    const t = Math.max(0, this.shownTick);
    drawAmbient(g, L, HABITATS[this.habitat].ambient, this.fever, t, calm);
    const list = this.scene(this.shownTick).slice().sort((a, b) => a.py + a.entry.h - (b.py + b.entry.h) || a.key - b.key);
    for (const s of list) drawShadow(g, L, s.entry, s.px, s.py, popScale(s.age), s.king ? ARC.hot : s.shiny ? ARC.gold : (TYPE_COLOR[s.entry.type] ?? ARC.ink), s.king);
    for (const s of list) drawLive(g, L, s, now, calm);
    for (const s of list) drawDecor(g, L, s, now, calm);
    this.exits = this.exits.filter((x) => drawExit(g, L, x, now, calm));
  }

  /** Client px to the field pixel under it. */
  toField(clientX: number, clientY: number): { x: number; y: number; inside: boolean } {
    const rect = this.canvas.getBoundingClientRect();
    const kx = rect.width ? this.L.devW / rect.width : this.L.dpr;
    const ky = rect.height ? this.L.devH / rect.height : this.L.dpr;
    return devToField(this.L, (clientX - rect.left) * kx, (clientY - rect.top) * ky);
  }

  /** Field px to CSS px relative to the canvas (layout px, before any CSS transform). */
  fieldToCss(x: number, y: number): { x: number; y: number } {
    const d = fieldToDev(this.L, x, y);
    const k = (this.canvas.clientWidth || 1) / this.L.devW;
    return { x: d.x * k, y: d.y * k };
  }

  /** CSS px per field px. */
  get cssScale(): number {
    return (this.L.s * (this.canvas.clientWidth || 1)) / this.L.devW;
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    window.removeEventListener('resize', this.onResize);
    this.canvas.remove();
  }
}
