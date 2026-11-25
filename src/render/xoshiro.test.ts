import { describe, expect, it } from 'vitest';
import { deriveSeed, Xoshiro128 } from './xoshiro.ts';

describe('xoshiro128**', () => {
  it('matches the reference output for state {1,2,3,4}', () => {
    const r = new Xoshiro128(0);
    r.setState([1, 2, 3, 4]);
    const got = Array.from({ length: 10 }, () => r.next());
    expect(got).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597, 4258142804,
    ]);
  });

  it('is deterministic by seed (number and bigint)', () => {
    const a = new Xoshiro128(12345);
    const b = new Xoshiro128(12345);
    const c = new Xoshiro128(12346);
    const sa = Array.from({ length: 50 }, () => a.next());
    expect(Array.from({ length: 50 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 50 }, () => c.next())).not.toEqual(sa);

    const big = (4n << 96n) | (3n << 64n) | (2n << 32n) | 1n;
    const d = new Xoshiro128(big);
    expect(d.getState()).toEqual([1, 2, 3, 4]);
    expect(d.next()).toBe(11520);
    // all-zero 128-bit seed is replaced by a valid state
    const z = new Xoshiro128(0n);
    expect(z.getState().some((v) => v !== 0)).toBe(true);
  });

  it('derives distinct sub-seeds', () => {
    expect(deriveSeed(1, 1)).not.toBe(deriveSeed(1, 2));
    expect(deriveSeed(1, 1)).not.toBe(deriveSeed(2, 1));
    expect(deriveSeed(123n, 5)).toBe(deriveSeed(123n, 5));
  });

  it('fillBits produces fair 0/1 bytes, including odd lengths', () => {
    const r = new Xoshiro128(7);
    const out = new Uint8Array(100_003);
    r.fillBits(out);
    let ones = 0;
    let bad = 0;
    for (const v of out) {
      bad += v === 0 || v === 1 ? 0 : 1;
      ones += v;
    }
    expect(bad).toBe(0);
    const p = ones / out.length;
    expect(Math.abs(p - 0.5)).toBeLessThan(0.006); // ~3.8 sd
  });

  it('fillBitWords produces fair 0/1 bytes and fills the tail', () => {
    const r = new Xoshiro128(99);
    const bytes = new Uint8Array(4 * 1001).fill(7);
    r.fillBitWords(new Uint32Array(bytes.buffer));
    let ones = 0;
    let bad = 0;
    for (const v of bytes) {
      bad += v === 0 || v === 1 ? 0 : 1;
      ones += v;
    }
    expect(bad).toBe(0);
    expect(Math.abs(ones / bytes.length - 0.5)).toBeLessThan(0.03);
    // neighbouring bytes are uncorrelated
    let agree = 0;
    for (let i = 1; i < bytes.length; i++) agree += bytes[i] === bytes[i - 1] ? 1 : 0;
    expect(Math.abs(agree / (bytes.length - 1) - 0.5)).toBeLessThan(0.03);
  });

  it('fillBitWords is deterministic by seed', () => {
    const a = new Uint8Array(256);
    const b = new Uint8Array(256);
    new Xoshiro128(5).fillBitWords(new Uint32Array(a.buffer));
    new Xoshiro128(5).fillBitWords(new Uint32Array(b.buffer));
    expect(a).toEqual(b);
  });
});
