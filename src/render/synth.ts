// Synthetic silhouettes, roster mask decoding and a SPEC section 6 bouncer.
// Shared by the unit tests, scripts/leak-test.ts and the lab page. No DOM.

import { Xoshiro128 } from './xoshiro.ts';

export interface MaskDef {
  name: string;
  w: number;
  h: number;
  mask: Uint8Array;
  /** Beast type if known (roster entries), else undefined */
  type?: 0 | 1 | 2;
  tier?: number;
}

export function circleMask(d: number): MaskDef {
  const mask = new Uint8Array(d * d);
  const c = d / 2;
  const r2 = (d / 2) * (d / 2);
  for (let y = 0; y < d; y++)
    for (let x = 0; x < d; x++) if ((x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2 <= r2) mask[y * d + x] = 1;
  return { name: `circle ${d}`, w: d, h: d, mask };
}

export function ellipseMask(w: number, h: number): MaskDef {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w - 0.5;
      const v = (y + 0.5) / h - 0.5;
      if (u * u + v * v <= 0.25) mask[y * w + x] = 1;
    }
  return { name: `ellipse ${w}x${h}`, w, h, mask };
}

/** Smooth random blob: thresholded sum of a few Gaussian bumps. */
export function blobMask(seed: number, w = 48, h = 48): MaskDef {
  const rng = new Xoshiro128(seed);
  const k = 5 + (rng.next() % 4);
  const bumps: [number, number, number][] = [];
  for (let i = 0; i < k; i++) {
    const bx = w * (0.25 + 0.5 * rng.nextFloat());
    const by = h * (0.25 + 0.5 * rng.nextFloat());
    const s = Math.min(w, h) * (0.1 + 0.12 * rng.nextFloat());
    bumps.push([bx, by, s]);
  }
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let f = 0;
      for (const [bx, by, s] of bumps) f += Math.exp(-((x + 0.5 - bx) ** 2 + (y + 0.5 - by) ** 2) / (2 * s * s));
      const ex = Math.min(x, w - 1 - x, y, h - 1 - y);
      if (f > 0.55 && ex >= 1) mask[y * w + x] = 1;
    }
  return { name: `blob #${seed}`, w, h, mask };
}

/** Crude two-legged creature: head, torso, two arms, two legs. */
export function creatureMask(w = 40, h = 52): MaskDef {
  const mask = new Uint8Array(w * h);
  const set = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) mask[y * w + x] = 1;
  };
  const cx = w / 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;
      // head
      if ((fx - cx) ** 2 + (fy - h * 0.13) ** 2 <= (h * 0.11) ** 2) set(x, y);
      // torso (ellipse)
      const u = (fx - cx) / (w * 0.3);
      const v = (fy - h * 0.43) / (h * 0.22);
      if (u * u + v * v <= 1) set(x, y);
      // arms: slanted bars
      const ay = fy - h * 0.3;
      if (ay >= 0 && ay <= h * 0.22) {
        const off = w * 0.28 + ay * 0.55;
        if (Math.abs(fx - (cx - off)) <= 2.2 || Math.abs(fx - (cx + off)) <= 2.2) set(x, y);
      }
      // legs
      if (fy >= h * 0.6 && fy <= h) {
        const spread = (fy - h * 0.6) * 0.25;
        const lx = cx - w * 0.14 - spread;
        const rx = cx + w * 0.14 + spread;
        if (Math.abs(fx - lx) <= w * 0.075 || Math.abs(fx - rx) <= w * 0.075) set(x, y);
      }
    }
  return { name: `creature ${w}x${h}`, w, h, mask };
}

export function syntheticMasks(): MaskDef[] {
  return [circleMask(40), blobMask(7, 48, 44), creatureMask(40, 52), ellipseMask(56, 34), blobMask(23, 44, 48)];
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decode a roster mask: base64 of w*h bits packed row-major, MSB-first. */
export function decodeMaskBits(b64: string, w: number, h: number): Uint8Array {
  const bytes = b64ToBytes(b64);
  const n = w * h;
  if (bytes.length * 8 < n) throw new Error(`mask data too short: ${bytes.length * 8} bits for ${w}x${h}`);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return mask;
}

/** Parse roster.json (shape: { entries: [{ mask, w, h, name?, type?, tier? }] }); bad entries are skipped. */
export function parseRoster(json: unknown): MaskDef[] {
  const out: MaskDef[] = [];
  const entries = (json as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return out;
  entries.forEach((e: Record<string, unknown>, i: number) => {
    try {
      const w = Number(e.w);
      const h = Number(e.h);
      if (typeof e.mask !== 'string' || !(w > 0 && h > 0)) return;
      const mask = decodeMaskBits(e.mask, w, h);
      const name = String(e.name ?? e.slug ?? e.id ?? `#${i}`);
      const type = e.type === 0 || e.type === 1 || e.type === 2 ? e.type : undefined;
      const tier = typeof e.tier === 'number' ? e.tier : undefined;
      out.push({ name, w, h, mask, type, tier });
    } catch {
      /* skip */
    }
  });
  return out;
}

/** SPEC section 6 closed-form bouncing motion on one axis (Q4 fixed point). */
export function axisPixel(L: number, s0: number, v: number, d: number, dt: number): number {
  if (L <= 0) return 0;
  const P = 2 * L;
  const u0 = d === 1 ? s0 : (P - s0) % P;
  const u = (((u0 + v * dt) % P) + P) % P;
  const q = u <= L ? u : P - u;
  return Math.floor(q) >> 4;
}

/** A bouncing Beast following SPEC section 6 (speed may be fractional Q4 for the lab). */
export class Bouncer {
  constructor(
    public fieldW: number,
    public fieldH: number,
    public w: number,
    public h: number,
    public x0: number,
    public y0: number,
    public vx: number,
    public vy: number,
    public dx: number,
    public dy: number,
  ) {}

  static random(rng: Xoshiro128, fieldW: number, fieldH: number, w: number, h: number, speedMul = 1): Bouncer {
    const Lx = Math.max(0, (fieldW - w) * 16);
    const Ly = Math.max(0, (fieldH - h) * 16);
    return new Bouncer(
      fieldW,
      fieldH,
      w,
      h,
      rng.next() % (Lx + 1),
      rng.next() % (Ly + 1),
      (3 + (rng.next() % 6)) * speedMul,
      (2 + (rng.next() % 4)) * speedMul,
      rng.next() & 1,
      rng.next() & 1,
    );
  }

  pos(dt: number): [number, number] {
    const Lx = Math.max(0, (this.fieldW - this.w) * 16);
    const Ly = Math.max(0, (this.fieldH - this.h) * 16);
    return [axisPixel(Lx, this.x0, this.vx, this.dx, dt), axisPixel(Ly, this.y0, this.vy, this.dy, dt)];
  }
}
