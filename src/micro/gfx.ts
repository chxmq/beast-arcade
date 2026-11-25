// Drawing for MICRO MAYHEM: a logical 320x180 screen at an integer device scale (letterbox filled
// with the game's own colour), Beast art at integer art scales with smoothing off, pixel icons,
// type badges and the round cabinet buttons. Text is real Press Start 2P at device resolution.
import type { BeastType, RosterEntry } from '../data/roster.ts';
import { artOf, artSource } from '../game/beasts.ts';
import { TYPE_LABEL } from './cast.ts';
import type { Pt } from './types.ts';

export const W = 320;
export const H = 180;

/** ARCADE.md palette. */
export const PAL = {
  cab: '#140b0b',
  bezel: '#050505',
  ink: '#f4ecd8',
  dim: '#9a8f7a',
  hot: '#ff3b2f',
  gold: '#ffc61a',
  cyan: '#23d5ff',
  lime: '#8dff3a',
  screen: '#07070a',
  // shades used for patterns on the flat colours
  hotDark: '#c8261d',
  goldDark: '#e0a400',
  cyanDark: '#12a9d1',
  limeDark: '#5fd11f',
  inkDark: '#e2d6b8',
  king: '#ff4a3d',
} as const;

/** Type colours follow the buttons: A red = MAGIC, B yellow = HUNTER, C cyan = BRUTE. */
export const TYPE_COLOR = [PAL.hot, PAL.gold, PAL.cyan] as const;
export const BUTTON_COLOR = { A: PAL.hot, B: PAL.gold, C: PAL.cyan } as const;

export const FONT = "'Press Start 2P', 'VT323', ui-monospace, monospace";

// ------------------------------------------------------------------ sprite sources

export type SpriteMode = 'art' | 'shiny' | 'white' | 'dark';

interface Src {
  img: CanvasImageSource;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

const tints = new Map<string, HTMLCanvasElement>();

export function artReady(e: RosterEntry): boolean {
  const img = artOf(e);
  return img.complete && img.naturalWidth > 0;
}

function spriteSrc(e: RosterEntry, mode: SpriteMode): Src | null {
  const img = artOf(e);
  if (!img.complete || !img.naturalWidth) return null;
  const [ax, ay, aw, ah] = e.artBox;
  if (mode === 'art') return { img, sx: ax, sy: ay, sw: aw, sh: ah };
  if (mode === 'shiny') {
    const c = artSource(e, 'shiny');
    return c ? { img: c, sx: 0, sy: 0, sw: aw, sh: ah } : { img, sx: ax, sy: ay, sw: aw, sh: ah };
  }
  const key = `${e.speciesId}:${mode}`;
  let c = tints.get(key);
  if (!c) {
    c = document.createElement('canvas');
    c.width = Math.max(1, aw);
    c.height = Math.max(1, ah);
    const x = c.getContext('2d');
    if (x) {
      x.drawImage(img, ax, ay, aw, ah, 0, 0, aw, ah);
      x.globalCompositeOperation = 'source-in';
      x.fillStyle = mode === 'white' ? '#ffffff' : '#140b0b';
      x.fillRect(0, 0, aw, ah);
    }
    tints.set(key, c);
  }
  return { img: c, sx: 0, sy: 0, sw: aw, sh: ah };
}

// ------------------------------------------------------------------ pixel icons

const ICONS = {
  // 'k' is always the dark outline, so hearts read on every background colour
  heart: ['.kkk.kkk.', 'kXXXkXXXk', 'kXoXXXXXk', 'kXXXXXXXk', '.kXXXXXk.', '..kXXXk..', '...kXk...', '....k....'],
  heartEmpty: ['.kkk.kkk.', 'kXXXkXXXk', 'kXXXXXXXk', 'kXXXXXXXk', '.kXXXXXk.', '..kXXXk..', '...kXk...', '....k....'],
  magic: ['...X...', '...X...', '..XoX..', 'XXoooXX', '..XoX..', '...X...', '...X...'],
  hunter: ['....X..', '....XX.', 'XXXXXXX', 'XooooXX', '....XX.', '....X..'],
  brute: ['.XXXXX.', 'XoXoXoX', 'XXXXXXX', 'XXXXXXX', 'XXXXXX.', '.XXXX..'],
  crown: ['X...X...X', 'XX.XXX.XX', 'XXXXXXXXX', 'XoXXoXXoX', 'XXXXXXXXX'],
  star: ['...X...', '...X...', 'XXXXXXX', '.XXXXX.', '..XXX..', '.XX.XX.', 'XX...XX'],
  spark: ['..X..', '..X..', 'XXXXX', '..X..', '..X..'],
  hand: ['...X....', '...X....', '...XXXX.', '...XXXXX', 'XX.XXXXX', '.XXXXXXX', '..XXXXXX', '...XXXX.'],
  skull: ['.XXXXX.', 'XXXXXXX', 'X..X..X', 'XXXXXXX', '.XX.XX.', '.X.X.X.'],
} as const;

export type IconName = keyof typeof ICONS;
export const TYPE_ICON: readonly IconName[] = ['magic', 'hunter', 'brute'];
/** Fill of an empty heart (the outline stays dark). */
export const HEART_EMPTY = 'rgba(244,236,216,0.28)';

const iconCache = new Map<string, HTMLCanvasElement>();

function iconCanvas(name: IconName, color: string, color2: string): HTMLCanvasElement {
  const key = `${name}|${color}|${color2}`;
  let c = iconCache.get(key);
  if (c) return c;
  const rows = ICONS[name];
  const w = Math.max(...rows.map((r) => r.length));
  c = document.createElement('canvas');
  c.width = w;
  c.height = rows.length;
  const x = c.getContext('2d');
  if (x) {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        if (ch === '.') continue;
        x.fillStyle = ch === 'o' ? color2 : ch === 'k' ? '#140b0b' : color;
        x.fillRect(i, j, 1, 1);
      }
    });
  }
  iconCache.set(key, c);
  return c;
}

export function iconSize(name: IconName): { w: number; h: number } {
  const rows = ICONS[name];
  return { w: Math.max(...rows.map((r) => r.length)), h: rows.length };
}

// ------------------------------------------------------------------ Gfx

export interface TextOpts {
  size?: number;
  color?: string;
  align?: CanvasTextAlign;
  base?: CanvasTextBaseline;
  /** Outline colour and width (logical px). */
  outline?: string;
  ow?: number;
  /** Hard drop shadow colour and offset. */
  shadow?: string;
  sd?: number;
  /** Shrink to fit this width. */
  maxW?: number;
  alpha?: number;
}

export interface SpriteOpts {
  /** Integer art scale (source px to logical px). */
  k?: number;
  flip?: boolean;
  mode?: SpriteMode;
  /** (x, y) is the bottom centre (default) or the centre of the sprite. */
  anchor?: 'bottom' | 'center';
  alpha?: number;
  rot?: number;
  /** Squash and stretch. */
  sx?: number;
  sy?: number;
}

export class Gfx {
  readonly c: CanvasRenderingContext2D;
  /** Device px per logical px and the letterbox offset (device px). */
  s = 1;
  ox = 0;
  oy = 0;
  devW = 1;
  devH = 1;
  /** Seconds, for ambient animation. */
  time = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const c = canvas.getContext('2d', { alpha: false });
    if (!c) throw new Error('MICRO MAYHEM: no 2d canvas');
    this.c = c;
    this.resize();
  }

  /** Match the backing store to the element (CSS size x DPR) and choose the scale. */
  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    // Layout size, not the bounding rect: a CSS transform on the cabinet (its warm-up) must not
    // shrink the backing store, and ResizeObserver never reports transforms.
    const cw = this.canvas.clientWidth || this.canvas.getBoundingClientRect().width || W;
    const ch = this.canvas.clientHeight || this.canvas.getBoundingClientRect().height || H;
    const devW = Math.max(1, Math.round(cw * dpr));
    const devH = Math.max(1, Math.round(ch * dpr));
    if (this.canvas.width !== devW) this.canvas.width = devW;
    if (this.canvas.height !== devH) this.canvas.height = devH;
    this.devW = devW;
    this.devH = devH;
    const fit = Math.min(devW / W, devH / H);
    const whole = Math.floor(fit);
    // Integer scale keeps every art pixel square; fall back to the exact fit when that would waste >10%.
    this.s = whole >= 1 && whole / fit >= 0.9 ? whole : fit;
    this.ox = Math.floor((devW - W * this.s) / 2);
    this.oy = Math.floor((devH - H * this.s) / 2);
  }

  /** Clear to `bg` (letterbox included) and set the logical transform. */
  begin(bg: string, shakeX = 0, shakeY = 0): void {
    const c = this.c;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = bg;
    c.fillRect(0, 0, this.devW, this.devH);
    const s = this.s;
    c.setTransform(s, 0, 0, s, this.ox + Math.round(shakeX * s), this.oy + Math.round(shakeY * s));
    c.imageSmoothingEnabled = false;
  }

  /** Pointer client coordinates to logical coordinates. */
  toLogical(clientX: number, clientY: number): Pt {
    const r = this.canvas.getBoundingClientRect();
    const kx = r.width ? this.devW / r.width : 1;
    const ky = r.height ? this.devH / r.height : 1;
    return { x: ((clientX - r.left) * kx - this.ox) / this.s, y: ((clientY - r.top) * ky - this.oy) / this.s };
  }

  /** Snap a logical coordinate to the device pixel grid (crisp sprites). */
  snap(v: number): number {
    return Math.round(v * this.s) / this.s;
  }

  // ---------------------------------------------------------------- shapes

  rect(x: number, y: number, w: number, h: number, color: string): void {
    this.c.fillStyle = color;
    this.c.fillRect(x, y, w, h);
  }

  fill(color: string, alpha = 1): void {
    const c = this.c;
    c.globalAlpha = alpha;
    c.fillStyle = color;
    c.fillRect(-W, -H, W * 3, H * 3);
    c.globalAlpha = 1;
  }

  circle(x: number, y: number, r: number, fill: string | null, stroke?: string, lw = 1): void {
    const c = this.c;
    c.beginPath();
    c.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
    if (fill) {
      c.fillStyle = fill;
      c.fill();
    }
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = lw;
      c.stroke();
    }
  }

  ellipse(x: number, y: number, rx: number, ry: number, fill: string | null, stroke?: string, lw = 1, rot = 0): void {
    const c = this.c;
    c.beginPath();
    c.ellipse(x, y, Math.max(0, rx), Math.max(0, ry), rot, 0, Math.PI * 2);
    if (fill) {
      c.fillStyle = fill;
      c.fill();
    }
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = lw;
      c.stroke();
    }
  }

  /** Flat polygon from [x0, y0, x1, y1, ...]. */
  poly(pts: readonly number[], fill: string | null, stroke?: string, lw = 1): void {
    const c = this.c;
    c.beginPath();
    c.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
    c.closePath();
    if (fill) {
      c.fillStyle = fill;
      c.fill();
    }
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = lw;
      c.lineJoin = 'round';
      c.stroke();
    }
  }

  line(x1: number, y1: number, x2: number, y2: number, color: string, lw = 1): void {
    const c = this.c;
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.strokeStyle = color;
    c.lineWidth = lw;
    c.lineCap = 'round';
    c.stroke();
  }

  rrect(x: number, y: number, w: number, h: number, r: number, fill: string | null, stroke?: string, lw = 1): void {
    const c = this.c;
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
    if (fill) {
      c.fillStyle = fill;
      c.fill();
    }
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = lw;
      c.stroke();
    }
  }

  alpha(a: number, fn: () => void): void {
    const c = this.c;
    const prev = c.globalAlpha;
    c.globalAlpha = prev * Math.max(0, Math.min(1, a));
    fn();
    c.globalAlpha = prev;
  }

  /** Run `fn` with the origin moved to (x, y), scaled by `k` and rotated by `rot`. */
  at(x: number, y: number, k: number, rot: number, fn: () => void): void {
    const c = this.c;
    c.save();
    c.translate(x, y);
    if (rot) c.rotate(rot);
    if (k !== 1) c.scale(k, k);
    fn();
    c.restore();
  }

  // ---------------------------------------------------------------- patterns

  /** Sunburst rays around (cx, cy). */
  rays(cx: number, cy: number, n: number, color: string, rot: number): void {
    const c = this.c;
    c.fillStyle = color;
    c.beginPath();
    const R = 420;
    for (let i = 0; i < n; i++) {
      const a0 = rot + (i * Math.PI * 2) / n;
      const a1 = a0 + Math.PI / n;
      c.moveTo(cx, cy);
      c.lineTo(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R);
      c.lineTo(cx + Math.cos(a1) * R, cy + Math.sin(a1) * R);
      c.closePath();
    }
    c.fill();
  }

  /** Diagonal stripes of width `w` scrolled by `off`. */
  stripes(color: string, w: number, off: number, slant = 0.6): void {
    const c = this.c;
    c.fillStyle = color;
    c.beginPath();
    const period = w * 2;
    const start = -H * slant - period + (((off % period) + period) % period);
    for (let x = start; x < W + period; x += period) {
      c.moveTo(x, -4);
      c.lineTo(x + w, -4);
      c.lineTo(x + w + (H + 8) * slant, H + 4);
      c.lineTo(x + (H + 8) * slant, H + 4);
      c.closePath();
    }
    c.fill();
  }

  checker(color: string, size: number, offX: number, offY: number, y0 = 0, y1 = H): void {
    const c = this.c;
    c.fillStyle = color;
    const ox = ((offX % (size * 2)) + size * 2) % (size * 2);
    const oy = ((offY % (size * 2)) + size * 2) % (size * 2);
    for (let y = y0 - oy - size * 2; y < y1; y += size) {
      const row = Math.round((y - (y0 - oy - size * 2)) / size);
      for (let x = -ox - size * 2 + (row % 2) * size; x < W + size; x += size * 2) {
        const top = Math.max(y0, y);
        const bot = Math.min(y1, y + size);
        if (bot > top) c.fillRect(x, top, size, bot - top);
      }
    }
  }

  // ---------------------------------------------------------------- text

  text(str: string, x: number, y: number, o: TextOpts = {}): number {
    const c = this.c;
    let size = o.size ?? 8;
    c.font = `${size}px ${FONT}`;
    let w = c.measureText(str).width;
    if (o.maxW && w > o.maxW) {
      size = Math.max(4, (size * o.maxW) / w);
      c.font = `${size}px ${FONT}`;
      w = c.measureText(str).width;
    }
    c.textAlign = o.align ?? 'center';
    c.textBaseline = o.base ?? 'middle';
    const prevA = c.globalAlpha;
    if (o.alpha !== undefined) c.globalAlpha = prevA * Math.max(0, Math.min(1, o.alpha));
    const ow = o.ow ?? Math.max(1, size / 8);
    c.lineJoin = 'round';
    if (o.shadow) {
      const d = o.sd ?? Math.max(1, size / 8);
      if (o.outline) {
        c.lineWidth = ow * 2;
        c.strokeStyle = o.shadow;
        c.strokeText(str, x + d, y + d);
      }
      c.fillStyle = o.shadow;
      c.fillText(str, x + d, y + d);
    }
    if (o.outline) {
      c.lineWidth = ow * 2;
      c.strokeStyle = o.outline;
      c.strokeText(str, x, y);
    }
    c.fillStyle = o.color ?? PAL.ink;
    c.fillText(str, x, y);
    c.globalAlpha = prevA;
    return w;
  }

  measure(str: string, size = 8): number {
    this.c.font = `${size}px ${FONT}`;
    return this.c.measureText(str).width;
  }

  // ---------------------------------------------------------------- sprites

  /** Draw a Beast's art. Returns its logical size (also when the art has not loaded yet). */
  sprite(e: RosterEntry, x: number, y: number, o: SpriteOpts = {}): { w: number; h: number } {
    const k = o.k ?? 1;
    const w = e.artBox[2] * k;
    const h = e.artBox[3] * k;
    const src = spriteSrc(e, o.mode ?? 'art');
    if (!src) return { w, h };
    const c = this.c;
    const prevA = c.globalAlpha;
    if (o.alpha !== undefined) c.globalAlpha = prevA * Math.max(0, Math.min(1, o.alpha));
    const ay = o.anchor === 'center' ? h / 2 : h;
    if (!o.rot && o.sx === undefined && o.sy === undefined) {
      const left = this.snap(x - w / 2);
      const top = this.snap(y - ay);
      if (o.flip) {
        c.save();
        c.translate(left + w, top);
        c.scale(-1, 1);
        c.drawImage(src.img, src.sx, src.sy, src.sw, src.sh, 0, 0, w, h);
        c.restore();
      } else c.drawImage(src.img, src.sx, src.sy, src.sw, src.sh, left, top, w, h);
    } else {
      c.save();
      c.translate(this.snap(x), this.snap(y));
      if (o.rot) c.rotate(o.rot);
      c.scale((o.flip ? -1 : 1) * (o.sx ?? 1), o.sy ?? 1);
      c.drawImage(src.img, src.sx, src.sy, src.sw, src.sh, -w / 2, -ay, w, h);
      c.restore();
    }
    c.globalAlpha = prevA;
    return { w, h };
  }

  // ---------------------------------------------------------------- icons, badges, buttons

  icon(name: IconName, x: number, y: number, px: number, color: string, color2: string = color): void {
    const ic = iconCanvas(name, color, color2);
    const w = ic.width * px;
    const h = ic.height * px;
    this.c.drawImage(ic, this.snap(x - w / 2), this.snap(y - h / 2), w, h);
  }

  /** A type badge: dark pill, coloured border, icon and name. Returns its width. */
  badge(type: BeastType, cx: number, cy: number, big = false, alpha = 1): number {
    const label = TYPE_LABEL[type];
    const color = TYPE_COLOR[type];
    const size = big ? 8 : 6;
    const px = big ? 2 : 1;
    const ic = iconSize(TYPE_ICON[type]);
    const tw = this.measure(label, size);
    const pad = big ? 5 : 3;
    const w = Math.ceil(pad + ic.w * px + (big ? 4 : 3) + tw + pad);
    const h = big ? 20 : 13;
    const x = Math.round(cx - w / 2);
    const y = Math.round(cy - h / 2);
    this.alpha(alpha, () => {
      this.rrect(x + 1, y + 2, w, h, 4, 'rgba(0,0,0,0.35)');
      this.rrect(x, y, w, h, 4, PAL.cab, color, big ? 2 : 1.5);
      this.icon(TYPE_ICON[type], x + pad + (ic.w * px) / 2, cy, px, color, PAL.ink);
      this.text(label, x + pad + ic.w * px + (big ? 4 : 3), cy + 0.5, { size, color, align: 'left' });
    });
    return w;
  }

  /** A round cabinet button (on-screen and tappable in the games that use A B C). */
  button(label: string, cx: number, cy: number, r: number, color: string, pressed = false, sub?: string): void {
    const d = pressed ? 1.5 : 0;
    this.circle(cx, cy + 2.5, r, '#000000');
    this.circle(cx, cy + d, r, color, PAL.cab, 2);
    this.circle(cx - r * 0.3, cy - r * 0.35 + d, r * 0.28, 'rgba(255,255,255,0.35)');
    this.text(label, cx + 0.5, cy + d + 1, { size: Math.round(r * 0.9), color: PAL.cab });
    if (sub) this.text(sub, cx, cy + r + 7, { size: 6, color: PAL.ink, outline: PAL.cab, ow: 1.5 });
  }

  /** A pixel crown above (x, y) (bottom centre of the crown). */
  crown(x: number, y: number, px = 2): void {
    const s = iconSize('crown');
    this.icon('crown', x, y - (s.h * px) / 2, px, PAL.gold, PAL.king);
  }
}
