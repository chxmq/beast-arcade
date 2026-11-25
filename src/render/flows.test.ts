import { describe, expect, it } from 'vitest';
import {
  computeFlow,
  DEFAULT_FLOW_PARAMS,
  FlowScratch,
  getMaskInfo,
  hunterX,
  isSlamTick,
  type BeastType,
  type FlowParams,
} from './flows.ts';
import { blobMask, circleMask, creatureMask, ellipseMask } from './synth.ts';
import { Xoshiro128 } from './xoshiro.ts';

function randomMask(rng: Xoshiro128): { w: number; h: number; mask: Uint8Array } {
  const w = 1 + (rng.next() % 64);
  const h = 1 + (rng.next() % 56);
  const mask = new Uint8Array(w * h);
  const kind = rng.next() % 4;
  if (kind === 0) {
    const d = rng.nextFloat();
    for (let i = 0; i < mask.length; i++) mask[i] = rng.nextFloat() < d ? 1 : 0;
  } else if (kind === 1) {
    const m = blobMask(rng.next(), Math.max(3, w), Math.max(3, h));
    return m;
  } else if (kind === 2) {
    // rectangles with holes
    mask.fill(1);
    for (let k = 0; k < 6; k++) {
      const x0 = rng.next() % w;
      const y0 = rng.next() % h;
      const x1 = Math.min(w, x0 + 1 + (rng.next() % 8));
      const y1 = Math.min(h, y0 + 1 + (rng.next() % 8));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask[y * w + x] = 0;
    }
  } else {
    // thin random strokes
    for (let k = 0; k < 4; k++) {
      let x = rng.next() % w;
      let y = rng.next() % h;
      for (let s = 0; s < 60; s++) {
        mask[y * w + x] = 1;
        x = Math.min(w - 1, Math.max(0, x + (rng.next() % 3) - 1));
        y = Math.min(h - 1, Math.max(0, y + (rng.next() % 3) - 1));
      }
    }
  }
  return { w, h, mask };
}

const fixed = [
  circleMask(40),
  creatureMask(),
  ellipseMask(64, 20),
  blobMask(3),
  { name: 'single', w: 1, h: 1, mask: Uint8Array.of(1) },
  { name: 'empty', w: 5, h: 4, mask: new Uint8Array(20) },
  { name: 'full', w: 64, h: 56, mask: new Uint8Array(64 * 56).fill(1) },
  { name: 'row', w: 64, h: 1, mask: new Uint8Array(64).fill(1) },
  { name: 'col', w: 1, h: 56, mask: new Uint8Array(56).fill(1) },
];

const stamp = { arr: new Int32Array(0), gen: 0 };
const M = 256; // horizontal margin for Hunter sources outside the box

/** Throws (no per-pixel expect: that is far too slow here) unless the flow is injective and well-formed. */
function checkFlow(m: { w: number; h: number; mask: Uint8Array }, type: BeastType, t: number, tPrev: number, id: number, vortex: boolean, p: FlowParams) {
  const info = getMaskInfo(m.mask, m.w, m.h);
  const out = new FlowScratch();
  computeFlow(info, type, t, tPrev, id, vortex, p, out);
  const GW = m.w + 2 * M;
  if (stamp.arr.length < GW * m.h) stamp.arr = new Int32Array(GW * m.h);
  const g = ++stamp.gen;
  const ctx = () => `type ${type} mask ${m.w}x${m.h} t ${t} tPrev ${tPrev} id ${id}`;
  for (let i = 0; i < info.n; i++) {
    const sx = out.sx[i];
    const sy = out.sy[i];
    if (sy < 0 || sy >= m.h || sx < -M || sx >= m.w + M) throw new Error(`source out of range: ${ctx()}`);
    const key = sy * GW + sx + M;
    if (stamp.arr[key] === g) throw new Error(`non-injective: ${ctx()} pixel ${i}`);
    stamp.arr[key] = g;
    if (type === 1) {
      if (sy !== info.ys[i]) throw new Error(`Hunter moved vertically: ${ctx()}`);
      // same shift for every pixel of a row (row-major order: compare with the previous pixel of the row)
      if (i > 0 && info.ys[i - 1] === sy && info.xs[i - 1] - out.sx[i - 1] !== info.xs[i] - sx)
        throw new Error(`Hunter row not rigid: ${ctx()}`);
    } else if (!(sx >= 0 && sx < m.w && m.mask[sy * m.w + sx])) {
      throw new Error(`source outside mask (must be a permutation): ${ctx()} pixel ${i}`);
    }
  }
}

describe('flows are injective', () => {
  it('for fixed masks, all types, many phases', () => {
    const p = { ...DEFAULT_FLOW_PARAMS };
    for (const m of fixed)
      for (const type of [0, 1, 2] as BeastType[])
        for (let t = 0; t < 200; t += 1)
          for (const dt of [1, 2, 3]) checkFlow(m, type, t, t - dt, t % 7, (t & 8) !== 0, p);
  });

  it('for 300 random masks and random phases/params', () => {
    const rng = new Xoshiro128(2024);
    for (let k = 0; k < 300; k++) {
      const m = randomMask(rng);
      const p: FlowParams = {
        ...DEFAULT_FLOW_PARAMS,
        magicEdgeSpeed: 0.2 + 3 * rng.nextFloat(),
        hunterSpeed: 0.3 + 4 * rng.nextFloat(),
        hunterRowJitter: rng.nextFloat() * 0.8,
        bruteSpeed: 0.2 + 2.5 * rng.nextFloat(),
        slamStep: 1 + (rng.next() % 4),
      };
      for (let j = 0; j < 12; j++) {
        const t = rng.next() % 5000;
        const dt = 1 + (rng.next() % 3);
        for (const type of [0, 1, 2] as BeastType[]) checkFlow(m, type, t, t - dt, rng.next() % 1000, (rng.next() & 1) === 1, p);
      }
    }
  });
});

describe('flow character', () => {
  it('Magic: outer ring moves at about magicEdgeSpeed, inner ring barely moves', () => {
    const m = circleMask(40);
    const info = getMaskInfo(m.mask, m.w, m.h);
    const out = new FlowScratch();
    let outer = 0;
    let nOuter = 0;
    let inner = 0;
    let nInner = 0;
    for (let t = 1; t <= 60; t++) {
      computeFlow(info, 0, t, t - 1, 0, false, DEFAULT_FLOW_PARAMS, out);
      for (let i = 0; i < info.n; i++) {
        const r = Math.hypot(info.xs[i] + 0.5 - info.cx, info.ys[i] + 0.5 - info.cy);
        const d = Math.hypot(info.xs[i] - out.sx[i], info.ys[i] - out.sy[i]);
        if (r > info.rMax - 2) {
          outer += d;
          nOuter++;
        } else if (r < 3) {
          inner += d;
          nInner++;
        }
      }
    }
    const vOut = outer / nOuter;
    expect(vOut).toBeGreaterThan(DEFAULT_FLOW_PARAMS.magicEdgeSpeed * 0.6);
    expect(vOut).toBeLessThan(DEFAULT_FLOW_PARAMS.magicEdgeSpeed * 1.8);
    expect(inner / nInner).toBeLessThan(vOut / 2);
  });

  it('Magic vortex swirls twice as fast', () => {
    const m = circleMask(40);
    const info = getMaskInfo(m.mask, m.w, m.h);
    const out = new FlowScratch();
    const speed = (vortex: boolean) => {
      let s = 0;
      for (let t = 1; t <= 60; t++) {
        computeFlow(info, 0, t, t - 1, 0, vortex, DEFAULT_FLOW_PARAMS, out);
        for (let i = 0; i < info.n; i++) s += Math.hypot(info.xs[i] - out.sx[i], info.ys[i] - out.sy[i]);
      }
      return s;
    };
    const r = speed(true) / speed(false);
    expect(r).toBeGreaterThan(1.6);
    expect(r).toBeLessThan(2.4);
  });

  it('Hunter: fast lateral motion with occasional direction flips', () => {
    let flips = 0;
    for (let id = 0; id < 20; id++) {
      let last = 0;
      for (let t = 1; t < 600; t++) {
        const d = Math.sign(hunterX(t, id, DEFAULT_FLOW_PARAMS) - hunterX(t - 1, id, DEFAULT_FLOW_PARAMS));
        expect(d).not.toBe(0);
        if (last && d !== last) flips++;
        last = d;
      }
    }
    // 20 ids x 13 boundaries x 0.35 ~ 91
    expect(flips).toBeGreaterThan(40);
    expect(flips).toBeLessThan(150);
  });

  it('Brute: slam ticks come in bursts of slamTicks per slamPeriod', () => {
    for (const id of [0, 1, 5, 17]) {
      let n = 0;
      for (let t = 0; t < DEFAULT_FLOW_PARAMS.slamPeriod * 10; t++) n += isSlamTick(t, id, DEFAULT_FLOW_PARAMS) ? 1 : 0;
      expect(n).toBe(DEFAULT_FLOW_PARAMS.slamTicks * 10);
    }
  });

  it('Brute: adjacent bands move in opposite directions outside slams', () => {
    const m = { w: 30, h: 12, mask: new Uint8Array(360).fill(1) };
    const info = getMaskInfo(m.mask, m.w, m.h);
    const out = new FlowScratch();
    let t = 1;
    while (isSlamTick(t, 0, DEFAULT_FLOW_PARAMS) || Math.floor(DEFAULT_FLOW_PARAMS.bruteSpeed * t) === Math.floor(DEFAULT_FLOW_PARAMS.bruteSpeed * (t - 1))) t++;
    computeFlow(info, 2, t, t - 1, 0, false, DEFAULT_FLOW_PARAMS, out);
    const shiftAt = (y: number) => (info.xs[y * 30 + 10] - out.sx[y * 30 + 10] + 30) % 30;
    expect(shiftAt(0)).toBe(shiftAt(2));
    expect(shiftAt(0)).not.toBe(shiftAt(3));
    expect((shiftAt(0) + shiftAt(3)) % 30).toBe(0);
  });

  it('caches geometry by mask identity', () => {
    const m = circleMask(20);
    expect(getMaskInfo(m.mask, 20, 20)).toBe(getMaskInfo(m.mask, 20, 20));
  });
});
