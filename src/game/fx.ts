// Overlay effects for BEAST CATCH, drawn on a 2D canvas above the sprites: rings, floating text,
// sparks, screen flashes and the catch ceremony (card back, wobble, flip, flight to the tray).
// Positions are in field pixels and mapped through a View, so the overlay matches the sprites.
import type { RosterEntry } from '../data/roster.ts';
import { artRect, artSource } from './beasts.ts';
import { KING_COLOR, poseAt, SHINY_COLOR, tierColor, type CardPose, type CatchPlan } from './ceremony.ts';
import { ARC, TYPE_COLOR } from './sprites.ts';

export const C = {
  ink: ARC.ink,
  dim: ARC.dim,
  faint: '#3a352c',
  amber: ARC.gold,
  gold: ARC.gold,
  red: ARC.hot,
  hot: ARC.hot,
  green: ARC.lime,
  lime: ARC.lime,
  cyan: ARC.cyan,
} as const;

export const DISPLAY_FONT = "'Press Start 2P', ui-monospace, monospace";
export const BODY_FONT = "VT323, ui-monospace, monospace";

export interface View {
  /** Field pixel to overlay CSS pixel. */
  toCss(x: number, y: number): { x: number; y: number };
  /** CSS pixels per field pixel. */
  sc: number;
  /** Overlay size in CSS pixels. */
  W: number;
  H: number;
  calm: boolean;
}

interface Spark { vx: number; vy: number; c: string; s: number }
interface Imp { a: number; r: number; c: string; s: number }

/** Everything the card ceremony needs, in field coordinates for the Beast and CSS px for the tray. */
export interface CardSpec {
  /** Field position of the Beast's top-left, and its size. */
  x: number;
  y: number;
  w: number;
  h: number;
  entry: RosterEntry;
  plan: CatchPlan;
  shiny: boolean;
  king: boolean;
  /** "#012". */
  dex: string;
  artist: string;
  typeWord: string;
  /** Text over the face, e.g. "NEW ENTRY #012". */
  label: string;
  /** Points line under the face, e.g. "+420". */
  pts?: string;
  ptsSub?: string;
  /** Tray slot centre and width in overlay CSS px (null: fade in place). */
  target: { x: number; y: number; size: number } | null;
  parts: Imp[];
}

type Fx =
  | { kind: 'ring'; t0: number; dur: number; x: number; y: number; color: string; r0: number; r1: number; lw: number }
  | { kind: 'text'; t0: number; dur: number; x: number; y: number; color: string; text: string; size: number; rise: number; sub?: string; subColor?: string }
  | { kind: 'sparks'; t0: number; dur: number; x: number; y: number; parts: Spark[] }
  | { kind: 'card'; t0: number; dur: number; c: CardSpec }
  | { kind: 'edge'; t0: number; dur: number; side: -1 | 1 }
  | { kind: 'flash'; t0: number; dur: number; color: string; max: number };

/** Press Start 2P drops pixels below 8 px, so it never goes smaller. */
const display = (px: number) => `${Math.max(8, Math.round(px))}px ${DISPLAY_FONT}`;
const body = (px: number) => `${Math.max(8, Math.round(px))}px ${BODY_FONT}`;

export class FxLayer {
  private list: Fx[] = [];

  clear() {
    this.list = [];
  }

  ring(x: number, y: number, color: string, now: number, dur = 260, r0 = 3, r1 = 11, lw = 2) {
    this.list.push({ kind: 'ring', t0: now, dur, x, y, color, r0, r1, lw });
  }

  /** Floating text in field coordinates. `size` grows with the screen. */
  text(x: number, y: number, text: string, color: string, now: number, opts: { size?: number; dur?: number; rise?: number; sub?: string; subColor?: string; delay?: number } = {}) {
    this.list.push({ kind: 'text', t0: now + (opts.delay ?? 0), dur: opts.dur ?? 750, x, y, color, text, size: opts.size ?? 9, rise: opts.rise ?? 10, sub: opts.sub, subColor: opts.subColor });
  }

  sparks(x: number, y: number, n: number, colors: readonly string[], now: number, speed = 60, dur = 420) {
    const parts: Spark[] = [];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.75);
      parts.push({ vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.35, c: colors[i % colors.length], s: Math.random() < 0.3 ? 2 : 1 });
    }
    this.list.push({ kind: 'sparks', t0: now, dur, x, y, parts });
  }

  /** The catch ceremony for one Beast: stars rush in, card back, wobble beats, flip, label, flight to the tray. */
  card(spec: Omit<CardSpec, 'parts'>, now: number) {
    const parts: Imp[] = [];
    const tc = TYPE_COLOR[spec.entry.type] ?? C.ink;
    for (let i = 0; i < 36; i++) {
      parts.push({ a: Math.random() * Math.PI * 2, r: 22 + Math.random() * 40, c: i % 3 === 0 ? C.gold : i % 3 === 1 ? C.ink : tc, s: Math.random() < 0.35 ? 2 : 1 });
    }
    this.list.push({ kind: 'card', t0: now, dur: spec.plan.total, c: { ...spec, parts } });
  }

  /** A red bar at the screen edge: a Beast on that side is about to flee. */
  edge(side: -1 | 1, now: number) {
    this.list.push({ kind: 'edge', t0: now, dur: 700, side });
  }

  /** Whole-screen colour flash (jam, escape, the King going down). */
  flash(color: string, now: number, dur = 220, max = 0.35) {
    this.list.push({ kind: 'flash', t0: now, dur, color, max });
  }

  draw(g: CanvasRenderingContext2D, v: View, now: number) {
    const alive: Fx[] = [];
    for (const f of this.list) {
      const k = (now - f.t0) / f.dur;
      if (k >= 1) continue;
      alive.push(f);
      if (k < 0) continue;
      g.globalAlpha = 1;
      switch (f.kind) {
        case 'ring': {
          const p = v.toCss(f.x + 0.5, f.y + 0.5);
          g.strokeStyle = f.color;
          g.globalAlpha = 1 - k;
          g.lineWidth = f.lw * Math.max(1, v.sc / 3);
          g.beginPath();
          g.arc(p.x, p.y, (f.r0 + (f.r1 - f.r0) * easeOut(k)) * v.sc, 0, Math.PI * 2);
          g.stroke();
          break;
        }
        case 'text':
          drawText(g, v, f, k);
          break;
        case 'sparks': {
          const t = (k * f.dur) / 1000;
          g.globalAlpha = 1 - k * k;
          for (const s of f.parts) {
            const p = v.toCss(f.x + s.vx * t, f.y + s.vy * t + 90 * t * t);
            const sz = Math.max(2, s.s * v.sc);
            g.fillStyle = s.c;
            g.fillRect(Math.round(p.x - sz / 2), Math.round(p.y - sz / 2), Math.ceil(sz), Math.ceil(sz));
          }
          break;
        }
        case 'edge': {
          g.globalAlpha = (1 - k) * (Math.floor(k * 6) % 2 === 0 ? 0.9 : 0.35);
          g.fillStyle = C.hot;
          const wpx = Math.max(6, v.W * 0.012);
          g.fillRect(f.side < 0 ? 0 : v.W - wpx, v.H * 0.2, wpx, v.H * 0.6);
          break;
        }
        case 'flash': {
          if (v.calm) break;
          g.globalAlpha = f.max * (1 - k);
          g.fillStyle = f.color;
          g.fillRect(0, 0, v.W, v.H);
          break;
        }
        case 'card':
          drawCardFx(g, v, f.c, now - f.t0);
          break;
      }
    }
    this.list = alive;
    g.globalAlpha = 1;
  }
}

function easeOut(k: number) {
  return 1 - (1 - k) * (1 - k);
}

/** Text with a hard black drop, readable on any backdrop. */
function outlined(g: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, off = 2) {
  g.fillStyle = '#000';
  g.fillText(text, x + off, y + off);
  g.fillText(text, x - 1, y);
  g.fillText(text, x, y - 1);
  g.fillStyle = color;
  g.fillText(text, x, y);
}

function drawText(g: CanvasRenderingContext2D, v: View, f: Extract<Fx, { kind: 'text' }>, k: number) {
  const scale = Math.max(1, v.sc / 2.5);
  const pop = k < 0.12 && !v.calm ? 1 + 0.5 * (1 - k / 0.12) : 1;
  const size = f.size * scale * 1.25 * pop;
  const p = v.toCss(f.x, f.y);
  const y = p.y - f.rise * v.sc * easeOut(k);
  g.globalAlpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.font = display(size);
  const half = g.measureText(f.text).width / 2;
  const x = Math.min(v.W - 6 - half, Math.max(6 + half, p.x));
  outlined(g, f.text, x, y, f.color, Math.max(2, Math.round(size / 8)));
  if (f.sub) {
    const s2 = Math.max(13, size * 1.05);
    g.font = body(s2);
    outlined(g, f.sub, x, y + s2 * 0.95, f.subColor ?? C.ink, 2);
  }
}

/** The aiming reticle: corner brackets and a dot. Gold when ready, dim while it recharges, red when one more miss jams. */
export function drawReticle(g: CanvasRenderingContext2D, v: View, x: number, y: number, cool: number, danger: boolean, combo: number, comboPop: number, fever: boolean) {
  const p = v.toCss(x + 0.5, y + 0.5);
  const r = Math.max(9, 5.5 * v.sc);
  const arm = r * 0.5;
  const lw = Math.max(2, Math.round(v.sc * 0.7));
  const color = cool > 0 ? C.dim : danger ? C.hot : fever ? '#fff3c4' : C.gold;
  const brackets = (ox: number, oy: number) => {
    g.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      g.moveTo(p.x + ox + sx * r, p.y + oy + sy * (r - arm));
      g.lineTo(p.x + ox + sx * r, p.y + oy + sy * r);
      g.lineTo(p.x + ox + sx * (r - arm), p.y + oy + sy * r);
    }
    g.stroke();
  };
  g.lineCap = 'square';
  g.lineJoin = 'miter';
  g.lineWidth = lw + 2;
  g.strokeStyle = '#000';
  brackets(1, 1);
  g.lineWidth = lw;
  g.strokeStyle = color;
  brackets(0, 0);
  const d = Math.max(2, Math.round(lw * 1.2));
  g.fillStyle = '#000';
  g.fillRect(Math.round(p.x - d / 2) - 1, Math.round(p.y - d / 2) - 1, d + 2, d + 2);
  g.fillStyle = color;
  g.fillRect(Math.round(p.x - d / 2), Math.round(p.y - d / 2), d, d);
  if (cool > 0) {
    g.lineWidth = lw;
    g.strokeStyle = C.gold;
    g.beginPath();
    g.arc(p.x, p.y, r * 1.35, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - cool));
    g.stroke();
  }
  if (combo >= 2) {
    const size = Math.max(12, 3.6 * v.sc) * (1 + 0.45 * comboPop);
    g.font = display(size);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    outlined(g, String(combo), p.x + r + 6, p.y - r * 0.3, fever ? C.gold : C.ink, 2);
  }
}

// ------------------------------------------------------------------ catch ceremony

const clampN = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Shrink `text` until it fits `maxW`. */
function fitText(g: CanvasRenderingContext2D, text: string, maxW: number, px: number, fontOf = display): number {
  let size = px;
  g.font = fontOf(size);
  while (size > 8 && g.measureText(text).width > maxW) {
    size -= 1;
    g.font = fontOf(size);
  }
  return size;
}

/** A four-point pixel star. */
function star(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  const t = Math.max(2, Math.round(r / 3));
  g.fillStyle = color;
  g.fillRect(Math.round(x - r), Math.round(y - t / 2), Math.round(r * 2), t);
  g.fillRect(Math.round(x - t / 2), Math.round(y - r), t, Math.round(r * 2));
  g.fillStyle = '#fff';
  g.fillRect(Math.round(x - t / 2), Math.round(y - t / 2), t, t);
}

/** The card back: red with a gold lattice and a big "?". */
function drawBack(g: CanvasRenderingContext2D, cw: number, ch: number, frame: string) {
  g.fillStyle = '#3a0d0b';
  g.fillRect(-cw / 2, -ch / 2, cw, ch);
  const cell = Math.max(6, Math.round(cw / 9));
  g.fillStyle = '#571512';
  for (let y = -ch / 2 + 6; y < ch / 2 - 6; y += cell) {
    for (let x = -cw / 2 + 6; x < cw / 2 - 6; x += cell) {
      if ((Math.round((x + cw) / cell) + Math.round((y + ch) / cell)) % 2 === 0) g.fillRect(Math.round(x), Math.round(y), cell, cell);
    }
  }
  const bw = Math.max(3, Math.round(cw * 0.035));
  g.fillStyle = C.gold;
  g.fillRect(-cw / 2, -ch / 2, cw, bw);
  g.fillRect(-cw / 2, ch / 2 - bw, cw, bw);
  g.fillRect(-cw / 2, -ch / 2, bw, ch);
  g.fillRect(cw / 2 - bw, -ch / 2, bw, ch);
  g.fillStyle = frame;
  g.fillRect(-cw / 2 + bw * 2, -ch / 2 + bw * 2, cw - bw * 4, bw);
  g.fillRect(-cw / 2 + bw * 2, ch / 2 - bw * 3, cw - bw * 4, bw);
  // badge
  const r = cw * 0.24;
  g.fillStyle = '#000';
  g.fillRect(-r, -r, r * 2, r * 2);
  g.fillStyle = C.gold;
  g.fillRect(-r + bw, -r + bw, r * 2 - bw * 2, r * 2 - bw * 2);
  g.fillStyle = '#3a0d0b';
  g.fillRect(-r + bw * 2, -r + bw * 2, r * 2 - bw * 4, r * 2 - bw * 4);
  g.font = display(cw * 0.26);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = C.gold;
  g.fillText('?', cw * 0.01, cw * 0.015);
  g.textBaseline = 'alphabetic';
}

function drawFront(g: CanvasRenderingContext2D, cw: number, ch: number, c: CardSpec, frame: string) {
  const e = c.entry;
  const bw = Math.max(3, Math.round(cw * 0.035));
  g.fillStyle = frame;
  g.fillRect(-cw / 2, -ch / 2, cw, ch);
  g.fillStyle = '#0b0a0e';
  g.fillRect(-cw / 2 + bw, -ch / 2 + bw, cw - bw * 2, ch - bw * 2);
  const pad = cw * 0.08;
  const left = -cw / 2 + pad;
  const inner = cw - pad * 2;
  // name bar
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  const nameSize = fitText(g, e.name.toUpperCase(), inner * 0.72, cw * 0.085);
  const nameY = -ch / 2 + pad + nameSize;
  g.fillStyle = C.ink;
  g.fillText(e.name.toUpperCase(), left, nameY);
  g.font = body(cw * 0.12);
  g.textAlign = 'right';
  g.fillStyle = C.dim;
  g.fillText(c.dex, cw / 2 - pad, nameY);
  // art window
  const wy = nameY + pad * 0.7;
  const wh = ch * 0.55;
  g.fillStyle = '#16141c';
  g.fillRect(left, wy, inner, wh);
  g.fillStyle = '#1d1a25';
  const cell = Math.max(4, Math.round(inner / 10));
  for (let y = 0; y < wh; y += cell) for (let x = 0; x < inner; x += cell) if (((x + y) / cell) % 2 === 0) g.fillRect(left + x, wy + y, Math.min(cell, inner - x), Math.min(cell, wh - y));
  const mode = c.shiny ? 'shiny' : 'art';
  const src = artSource(e, mode);
  if (src) {
    const [sx, sy, sw, sh] = artRect(e, mode);
    const k = Math.max(1, Math.floor(Math.min((inner - 8) / sw, (wh - 8) / sh)));
    const fit = Math.min((inner - 8) / sw, (wh - 8) / sh);
    const kk = fit >= 1 ? k : fit;
    const dw = Math.max(1, Math.round(sw * kk));
    const dh = Math.max(1, Math.round(sh * kk));
    g.imageSmoothingEnabled = false;
    g.drawImage(src, sx, sy, sw, sh, Math.round(left + (inner - dw) / 2), Math.round(wy + (wh - dh) / 2), dw, dh);
  }
  g.fillStyle = frame;
  g.fillRect(left, wy + wh, inner, Math.max(2, bw - 1));
  // type, tier, artist
  const ty = wy + wh + cw * 0.15;
  g.textAlign = 'left';
  g.font = display(cw * 0.075);
  g.fillStyle = TYPE_COLOR[e.type] ?? frame;
  g.fillText(c.typeWord.toUpperCase(), left, ty);
  g.textAlign = 'right';
  g.fillStyle = frame;
  g.fillText(`T${e.tier}`, cw / 2 - pad, ty);
  g.textAlign = 'left';
  g.font = body(cw * 0.11);
  g.fillStyle = C.dim;
  g.fillText(`art ${c.artist}`, left, ty + cw * 0.12);
}

function drawCardFx(g: CanvasRenderingContext2D, v: View, c: CardSpec, ms: number) {
  const pose: CardPose = poseAt(c.plan, ms);
  if (pose.phase === 'done') return;
  const beast = v.toCss(c.x + c.w / 2, c.y + c.h / 2);
  const cw = clampN(v.W * 0.13, 84, 190);
  const ch = cw * 1.4;
  // Keep the card on screen, with room above it for the label.
  const cx0 = clampN(beast.x, cw / 2 + 10, v.W - cw / 2 - 10);
  // (the top band of the screen is the HUD: keep the label below it)
  const cy0 = clampN(beast.y, ch / 2 + Math.max(cw * 0.5, v.H * 0.13 + cw * 0.3), v.H - ch / 2 - cw * 0.4);
  const frame = c.shiny ? SHINY_COLOR : c.king ? KING_COLOR : tierColor(c.entry.tier);

  // 1. Stars rush into the Beast while it turns to light (the stage draws the light).
  if (pose.phase === 'implode') {
    const k = pose.k;
    const ease = k * k;
    for (const p of c.parts) {
      const r = p.r * (1 - ease);
      const q = v.toCss(c.x + c.w / 2 + Math.cos(p.a) * r, c.y + c.h / 2 + Math.sin(p.a) * r);
      const sz = Math.max(2, p.s * v.sc);
      g.globalAlpha = 0.5 + 0.5 * k;
      g.fillStyle = p.c;
      g.fillRect(Math.round(q.x - sz / 2), Math.round(q.y - sz / 2), Math.ceil(sz), Math.ceil(sz));
    }
    g.globalAlpha = 1;
  }

  // 2. The card: back while it wobbles, flipping to the face, then flying to the tray.
  let cx = cx0;
  let cy = cy0;
  let sc = 1;
  if (pose.fly > 0 && c.target) {
    cx = cx0 + (c.target.x - cx0) * pose.fly;
    cy = cy0 + (c.target.y - cy0) * pose.fly;
    sc = 1 + (c.target.size / cw - 1) * pose.fly;
  }
  const alpha = c.target ? 1 : 1 - pose.fly;
  g.save();
  g.globalAlpha = alpha * (pose.phase === 'implode' ? clampN((pose.k - 0.35) / 0.65, 0, 1) : 1);
  g.translate(Math.round(cx), Math.round(cy));
  g.rotate(v.calm ? 0 : pose.angle);
  const pop = pose.phase === 'implode' ? 0.3 + 0.7 * pose.pop : 1;
  g.scale(sc * pop * Math.max(0.02, pose.scaleX), sc * pop);
  g.imageSmoothingEnabled = false;
  // drop shadow
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fillRect(-cw / 2 + 6, -ch / 2 + 6, cw, ch);
  if (pose.face === 'back') drawBack(g, cw, ch, frame);
  else drawFront(g, cw, ch, c, frame);
  g.restore();
  g.globalAlpha = 1;

  // 3. Text: ticks while it wobbles, then the verdict over the face, points under it.
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  const above = cy0 - ch / 2 - cw * 0.14;
  if (pose.phase === 'wobble' && pose.beat >= 0) {
    const local = ms - c.plan.wobbleAt - pose.beat * c.plan.beatMs;
    g.globalAlpha = clampN(1 - local / (c.plan.beatMs * 0.9), 0, 1);
    g.font = display(cw * 0.09);
    outlined(g, ['.', '. .', '. . .'][Math.min(2, pose.beat)], cx0, above, C.gold);
    g.globalAlpha = 1;
  }
  const showText = pose.phase === 'hold' || pose.phase === 'fly' || (pose.phase === 'flip' && pose.k >= 0.5);
  if (showText) {
    const t = pose.phase === 'flip' ? (pose.k - 0.5) * 2 : 1;
    const out = pose.phase === 'fly' ? clampN(1 - pose.k * 2.2, 0, 1) : 1;
    g.globalAlpha = clampN(t * 4, 0, 1) * out;
    const big = c.shiny || c.king || c.label.startsWith('NEW');
    const grow = 1 + 0.3 * Math.max(0, 1 - t * 3) * (v.calm ? 0.3 : 1);
    const size = fitText(g, c.label, Math.max(160, v.W * 0.46), cw * (big ? 0.12 : 0.105) * grow);
    g.font = display(size);
    const half = g.measureText(c.label).width / 2;
    outlined(g, c.label, clampN(cx0, half + 8, v.W - half - 8), above, c.shiny ? SHINY_COLOR : c.king ? KING_COLOR : c.label.startsWith('NEW') ? C.lime : C.ink, Math.max(2, Math.round(size / 7)));
    if (c.pts) {
      g.font = display(cw * 0.11);
      outlined(g, c.pts, cx0, cy0 + ch / 2 + cw * 0.18, C.gold, 2);
      if (c.ptsSub) {
        g.font = body(cw * 0.15);
        outlined(g, c.ptsSub, cx0, cy0 + ch / 2 + cw * 0.32, C.ink, 2);
      }
    }
    g.globalAlpha = 1;
  }

  // 4. Shiny: sparkles around the card.
  if (c.shiny && pose.phase !== 'implode') {
    for (let i = 0; i < 9; i++) {
      const tw = Math.sin(ms / 110 + i * 2.3);
      if (tw < 0) continue;
      const ang = i * 2.399963 + ms / 900;
      const rad = (0.55 + (0.25 * ((i * 37) % 10)) / 10) * ch * 0.8;
      g.globalAlpha = tw * (pose.phase === 'fly' ? 1 - pose.fly : 1);
      star(g, cx + Math.cos(ang) * rad * 0.62 * sc, cy + Math.sin(ang) * rad * 0.62 * sc, 3 + tw * 5, SHINY_COLOR);
    }
    g.globalAlpha = 1;
  }
}
