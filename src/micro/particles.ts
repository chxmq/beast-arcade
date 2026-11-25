// Visual-only particles and floating text for the microgames (Math.random is fine here: nothing
// in the game logic depends on them).
import { FONT, PAL, type Gfx } from './gfx.ts';

type Kind = 'sq' | 'star' | 'ring' | 'text' | 'coin';

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  g: number;
  drag: number;
  kind: Kind;
  text?: string;
  r1?: number;
}

export interface BurstOpts {
  colors?: readonly string[];
  speed?: [number, number];
  life?: [number, number];
  size?: [number, number];
  gravity?: number;
  drag?: number;
  kind?: Kind;
  /** Emission angle range in radians (default all around). */
  angle?: [number, number];
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export class Particles {
  list: P[] = [];

  burst(x: number, y: number, n: number, o: BurstOpts = {}): void {
    const colors = o.colors ?? [PAL.ink, PAL.gold];
    const [a0, a1] = o.angle ?? [0, Math.PI * 2];
    for (let i = 0; i < n; i++) {
      const a = rnd(a0, a1);
      const sp = rnd(...(o.speed ?? [40, 120]));
      const life = rnd(...(o.life ?? [0.3, 0.7]));
      this.list.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life,
        size: rnd(...(o.size ?? [1, 3])), color: colors[i % colors.length], g: o.gravity ?? 0, drag: o.drag ?? 1.5, kind: o.kind ?? 'sq',
      });
    }
  }

  ring(x: number, y: number, color: string, r0: number, r1: number, life = 0.35, width = 2): void {
    this.list.push({ x, y, vx: 0, vy: 0, life, max: life, size: r0, r1, color, g: 0, drag: 0, kind: 'ring', text: String(width) });
  }

  /** Floating text that rises and fades (kept clear of the screen edges and the HUD row). */
  pop(x: number, y: number, text: string, color: string = PAL.ink, size = 8, life = 0.7): void {
    const half = (text.length * size) / 2 + 4;
    const cx = Math.max(half, Math.min(320 - half, x));
    const cy = Math.max(30 + size / 2, Math.min(166, y));
    this.list.push({ x: cx, y: cy, vx: 0, vy: -26, life, max: life, size, color, g: 0, drag: 2.2, kind: 'text', text });
  }

  /** Dust puffs along the ground. */
  dust(x: number, y: number, n: number, dir = 0, color = 'rgba(244,236,216,0.9)'): void {
    const angle: [number, number] = dir > 0 ? [-Math.PI * 0.95, -Math.PI * 0.55] : dir < 0 ? [-Math.PI * 0.45, -Math.PI * 0.05] : [-Math.PI, 0];
    this.burst(x, y, n, { colors: [color], speed: [20, 70], life: [0.25, 0.5], size: [2, 5], gravity: 30, drag: 3, angle });
  }

  update(dt: number): void {
    const out: P[] = [];
    for (const p of this.list) {
      p.life -= dt;
      if (p.life <= 0) continue;
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy = p.vy * k + p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      out.push(p);
    }
    this.list = out;
  }

  clear(): void {
    this.list = [];
  }

  draw(g: Gfx): void {
    const c = g.c;
    for (const p of this.list) {
      const f = p.life / p.max;
      c.globalAlpha = Math.min(1, f * 1.6);
      if (p.kind === 'sq') {
        const s = p.size * (0.5 + f * 0.5);
        c.fillStyle = p.color;
        c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      } else if (p.kind === 'star') {
        const s = Math.max(1, Math.round(p.size));
        c.fillStyle = p.color;
        c.fillRect(p.x - s * 1.5, p.y - s / 2, s * 3, s);
        c.fillRect(p.x - s / 2, p.y - s * 1.5, s, s * 3);
      } else if (p.kind === 'coin') {
        const s = p.size;
        c.fillStyle = PAL.cab;
        c.fillRect(p.x - s / 2 - 0.5, p.y - s / 2 - 0.5, s + 1, s + 1);
        c.fillStyle = p.color;
        c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      } else if (p.kind === 'ring') {
        const r = (p.r1 ?? p.size) + (p.size - (p.r1 ?? p.size)) * f;
        c.beginPath();
        c.arc(p.x, p.y, Math.max(0.1, r), 0, Math.PI * 2);
        c.strokeStyle = p.color;
        c.lineWidth = Number(p.text ?? 2) * f + 0.5;
        c.stroke();
      } else if (p.kind === 'text' && p.text) {
        c.font = `${p.size}px ${FONT}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.lineJoin = 'round';
        c.lineWidth = Math.max(2, p.size / 3);
        c.strokeStyle = p.color === PAL.cab ? PAL.ink : PAL.cab;
        c.strokeText(p.text, p.x, p.y);
        c.fillStyle = p.color;
        c.fillText(p.text, p.x, p.y);
      }
    }
    c.globalAlpha = 1;
  }
}
