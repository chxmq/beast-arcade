import { describe, expect, it } from 'vitest';
import { NoiseField, persistFor, type RenderBeast } from './field.ts';
import { blobMask, circleMask, creatureMask, Bouncer } from './synth.ts';
import { Xoshiro128 } from './xoshiro.ts';

function makeScene(seed: number, persist = 0.82) {
  const rng = new Xoshiro128(seed);
  const ms = [circleMask(44), creatureMask(), blobMask(5)];
  const bouncers = ms.map((m) => Bouncer.random(rng, 256, 144, m.w, m.h, 2));
  const beasts: RenderBeast[] = ms.map((m, i) => ({
    id: i,
    px: 0,
    py: 0,
    w: m.w,
    h: m.h,
    mask: m.mask,
    type: i as 0 | 1 | 2,
    persist,
    t: 0,
  }));
  const update = (t: number) =>
    beasts.forEach((b, i) => {
      [b.px, b.py] = bouncers[i].pos(t);
      b.t = t;
    });
  return { beasts, update };
}

describe('NoiseField', () => {
  it('persistFor follows SPEC section 12', () => {
    expect([1, 2, 3, 4, 5].map((t) => persistFor(t))).toEqual([0.7, 0.76, 0.82, 0.88, 0.93]);
    expect(persistFor(3, true)).toBeCloseTo(0.74);
  });

  it('is deterministic by seed', () => {
    const run = (seed: number | bigint) => {
      const f = new NoiseField(seed);
      const { beasts, update } = makeScene(1);
      const frames: Uint8Array[] = [f.cur.slice()];
      for (let t = 0; t < 120; t++) {
        update(t);
        f.step(beasts);
        if (t % 20 === 0) frames.push(f.cur.slice());
      }
      return frames;
    };
    const a = run(77);
    const b = run(77);
    const c = run(78);
    a.forEach((fr, i) => expect(fr).toEqual(b[i]));
    expect(a[3]).not.toEqual(c[3]);
    expect(run(123456789012345678901234567890n)[2]).toEqual(run(123456789012345678901234567890n)[2]);
  });

  it('keeps density ~0.5 inside and outside masks', () => {
    const f = new NoiseField(3);
    const { beasts, update } = makeScene(2, 0.93);
    let onesIn = 0;
    let nIn = 0;
    let ones = 0;
    let n = 0;
    for (let t = 0; t < 600; t++) {
      update(t);
      f.step(beasts);
      if (t % 50 !== 49) continue; // independent frames (age cap 48)
      for (const v of f.cur) ones += v;
      n += f.cur.length;
      for (const b of beasts)
        for (let y = 0; y < b.h; y++)
          for (let x = 0; x < b.w; x++)
            if (b.mask[y * b.w + x]) {
              onesIn += f.cur[(b.py + y) * f.w + b.px + x];
              nIn++;
            }
    }
    expect(Math.abs(ones / n - 0.5)).toBeLessThan(0.005);
    expect(Math.abs(onesIn / nIn - 0.5)).toBeLessThan(0.015);
  });

  it('claims every source and destination at most once per frame, even with overlapping Beasts', () => {
    const f = new NoiseField(4, 256, 144, { recordFlow: true });
    const m = circleMask(48);
    const beasts: RenderBeast[] = [0, 1, 2, 0, 1].map((type, i) => ({
      id: i,
      px: 100 + i * 6,
      py: 40 + (i % 2) * 5,
      w: 48,
      h: 48,
      mask: m.mask,
      type: type as 0 | 1 | 2,
      persist: 0.9,
      t: 0,
    }));
    for (let t = 0; t < 200; t++) {
      beasts.forEach((b, i) => {
        b.t = t;
        b.px = 100 + i * 6 + Math.floor(t / 7) * (i % 2 ? 1 : -1);
        b.py = 40 + (i % 2) * 5 + (Math.floor(t / 11) % 3);
      });
      f.step(beasts);
      const src = new Uint8Array(f.w * f.h);
      const dst = new Uint8Array(f.w * f.h);
      let dup = 0;
      for (let i = 0; i < f.flowCount; i++) {
        dup += src[f.flowSrc[i]] + dst[f.flowDst[i]];
        src[f.flowSrc[i]] = 1;
        dst[f.flowDst[i]] = 1;
      }
      expect(dup).toBe(0);
      expect(f.flowCount).toBeGreaterThan(1000);
    }
  });

  it('copies prev[src] -> cur[dst] for claimed pairs (persist 1) and moves texture with the body', () => {
    const f = new NoiseField(5, 256, 144, { recordFlow: true, maxAge: 250 });
    const { beasts, update } = makeScene(3, 1);
    for (let t = 0; t < 100; t++) {
      update(t);
      const prev = f.cur.slice();
      f.step(beasts);
      let bad = 0;
      for (let i = 0; i < f.flowCount; i++) bad += f.cur[f.flowDst[i]] === prev[f.flowSrc[i]] ? 0 : 1;
      expect(bad).toBe(0);
    }
    // a static Brute with persist 1 and no internal shift keeps its pixels exactly in place
    const g = new NoiseField(6, 64, 64, { params: { bruteSpeed: 0, slamStep: 0 }, maxAge: 250 });
    const m = circleMask(20);
    const b: RenderBeast = { id: 1, px: 10, py: 10, w: 20, h: 20, mask: m.mask, type: 2, persist: 1, t: 0 };
    g.step([b]);
    const snap = g.cur.slice();
    for (let t = 1; t < 30; t++) {
      b.t = t;
      b.px = 10 + t; // body moves right 1 px per tick: texture must follow
      g.step([b]);
    }
    let moved = 0;
    for (let y = 0; y < 20; y++)
      for (let x = 0; x < 20; x++)
        if (m.mask[y * 20 + x]) moved += g.cur[(10 + y) * 64 + 10 + 29 + x] === snap[(10 + y) * 64 + 10 + x] ? 0 : 1;
    expect(moved).toBe(0);
  });

  it('agreement with the previous frame along the flow is ~0.5 + persist/2', () => {
    for (const persist of [0, 0.7, 0.93]) {
      const f = new NoiseField(8, 256, 144, { recordFlow: true });
      const { beasts, update } = makeScene(4, persist);
      let agree = 0;
      let n = 0;
      for (let t = 0; t < 120; t++) {
        update(t);
        const prev = f.cur.slice();
        f.step(beasts);
        if (t < 60) continue; // past the age cap's influence at start
        for (let i = 0; i < f.flowCount; i++) {
          agree += f.cur[f.flowDst[i]] === prev[f.flowSrc[i]] ? 1 : 0;
          n++;
        }
      }
      // age cap trims a little at high persist
      expect(Math.abs(agree / n - (0.5 + persist / 2))).toBeLessThan(0.02);
    }
  });

  it('age cap: frames more than maxAge apart are uncorrelated along the flow', () => {
    const maxAge = 10;
    const f = new NoiseField(9, 128, 96, { recordFlow: true, maxAge });
    const m = circleMask(60);
    const b: RenderBeast = { id: 2, px: 30, py: 20, w: 60, h: 60, mask: m.mask, type: 0, persist: 1, t: 0 };
    let res: number[] = [];
    for (let rep = 0; rep < 20; rep++) {
      const ref = f.cur.slice();
      let origin = new Int32Array(f.w * f.h).fill(-1);
      const agreeAt: number[] = [];
      for (let k = 1; k <= maxAge + 3; k++) {
        b.t++;
        f.step([b]);
        const next = new Int32Array(f.w * f.h).fill(-1);
        let a = 0;
        let c = 0;
        for (let i = 0; i < f.flowCount; i++) {
          const o = k === 1 ? f.flowSrc[i] : origin[f.flowSrc[i]];
          if (o < 0) continue;
          next[f.flowDst[i]] = o;
          a += f.cur[f.flowDst[i]] === ref[o] ? 1 : 0;
          c++;
        }
        origin = next;
        agreeAt.push(a / c);
      }
      res = res.length ? res.map((v, i) => v + agreeAt[i]) : agreeAt;
    }
    res = res.map((v) => v / 20);
    // during the first maxAge steps after a reference frame, survival can still be high...
    expect(res[0]).toBeGreaterThan(0.9);
    // ...but beyond maxAge nothing from the reference frame can survive
    expect(Math.abs(res[maxAge] - 0.5)).toBeLessThan(0.02);
    expect(Math.abs(res[maxAge + 2] - 0.5)).toBeLessThan(0.02);
  });

  it('handles Beasts partially outside the field, empty masks and dt = 2', () => {
    const f = new NoiseField(10, 64, 48, { recordFlow: true });
    const m = circleMask(40);
    const beasts: RenderBeast[] = [
      { id: 0, px: -20, py: -10, w: 40, h: 40, mask: m.mask, type: 0, persist: 0.9, t: 0 },
      { id: 1, px: 40, py: 30, w: 40, h: 40, mask: m.mask, type: 1, persist: 0.9, t: 0 },
      { id: 2, px: 10, py: 10, w: 5, h: 5, mask: new Uint8Array(25), type: 2, persist: 0.9, t: 0 },
    ];
    for (let t = 0; t < 100; t += 2) {
      beasts.forEach((b) => (b.t = t));
      f.step(beasts, 2);
      for (let i = 0; i < f.flowCount; i++) if (!(f.flowDst[i] >= 0 && f.flowDst[i] < 64 * 48)) throw new Error('dst out of field');
    }
    let ones = 0;
    for (const v of f.cur) ones += v;
    expect(ones).toBeGreaterThan(64 * 48 * 0.4);
  });

  it('steps fast (3 Beasts of ~48x48)', () => {
    const f = new NoiseField(11);
    const { beasts, update } = makeScene(5);
    for (let t = 0; t < 200; t++) {
      update(t);
      f.step(beasts);
    }
    const t0 = performance.now();
    for (let t = 200; t < 1200; t++) {
      update(t);
      f.step(beasts);
    }
    const ms = (performance.now() - t0) / 1000;
    expect(ms).toBeLessThan(4); // ~0.1 ms idle; generous so a busy machine does not flake
  });
});
