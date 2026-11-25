// xoshiro128** (Blackman & Vigna), 32-bit output, period 2^128 - 1.
// Seedable from a 32-bit number (expanded with splitmix32) or a 128-bit bigint
// (used directly as the state; an all-zero state is replaced by a fixed one).

function splitmix32(state: { x: number }): number {
  state.x = (state.x + 0x9e3779b9) | 0;
  let z = state.x;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

/** NIB[n] is a little/big-endian-agnostic uint32 whose 4 bytes are the 4 bits of n (byte k = bit k). */
const NIB = (() => {
  const u8 = new Uint8Array(4);
  const u32 = new Uint32Array(u8.buffer);
  const out = new Uint32Array(16);
  for (let n = 0; n < 16; n++) {
    for (let k = 0; k < 4; k++) u8[k] = (n >> k) & 1;
    out[n] = u32[0];
  }
  return out;
})();

export type Seed = number | bigint;

export class Xoshiro128 {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  constructor(seed: Seed = 0x2545f491) {
    this.seed(seed);
  }

  /** Re-seed. number -> splitmix32 expansion of its low 32 bits; bigint -> low 128 bits as state (s0 = lowest word). */
  seed(seed: Seed): void {
    if (typeof seed === 'bigint') {
      const m = (1n << 32n) - 1n;
      const v = BigInt.asUintN(128, seed);
      this.s0 = Number(v & m) >>> 0;
      this.s1 = Number((v >> 32n) & m) >>> 0;
      this.s2 = Number((v >> 64n) & m) >>> 0;
      this.s3 = Number((v >> 96n) & m) >>> 0;
      if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.seed(0);
    } else {
      const st = { x: seed | 0 };
      this.s0 = splitmix32(st);
      this.s1 = splitmix32(st);
      this.s2 = splitmix32(st);
      this.s3 = splitmix32(st);
    }
  }

  /** Raw state access (4 x uint32), mainly for tests. */
  getState(): [number, number, number, number] {
    return [this.s0 >>> 0, this.s1 >>> 0, this.s2 >>> 0, this.s3 >>> 0];
  }

  setState(s: ArrayLike<number>): void {
    this.s0 = s[0] | 0;
    this.s1 = s[1] | 0;
    this.s2 = s[2] | 0;
    this.s3 = s[3] | 0;
  }

  /** Next uint32. */
  next(): number {
    const s1 = this.s1;
    const r = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return r;
  }

  /** Uniform float in [0, 1) with 32 bits of resolution. */
  nextFloat(): number {
    return this.next() / 4294967296;
  }

  /** Fill out[start, end) with independent fair bits (values 0|1). */
  fillBits(out: Uint8Array, start = 0, end = out.length): void {
    let i = start;
    while (i + 32 <= end) {
      const r = this.next();
      for (let b = 0; b < 32; b++) out[i + b] = (r >>> b) & 1;
      i += 32;
    }
    if (i < end) {
      const r = this.next();
      for (let b = 0; i < end; b++, i++) out[i] = (r >>> b) & 1;
    }
  }

  /**
   * Fast path: fill a Uint32Array view over a byte buffer so that every byte becomes an
   * independent fair bit (0|1). One next() call produces 8 words = 32 bytes.
   */
  fillBitWords(words: Uint32Array): void {
    const n = words.length;
    const full = n & ~7;
    let i = 0;
    for (; i < full; i += 8) {
      const r = this.next();
      words[i] = NIB[r & 15];
      words[i + 1] = NIB[(r >>> 4) & 15];
      words[i + 2] = NIB[(r >>> 8) & 15];
      words[i + 3] = NIB[(r >>> 12) & 15];
      words[i + 4] = NIB[(r >>> 16) & 15];
      words[i + 5] = NIB[(r >>> 20) & 15];
      words[i + 6] = NIB[(r >>> 24) & 15];
      words[i + 7] = NIB[r >>> 28];
    }
    if (i < n) {
      let r = this.next();
      for (; i < n; i++, r >>>= 4) words[i] = NIB[r & 15];
    }
  }
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/** Derive an independent 32-bit sub-seed from a seed and a salt (for separate streams). */
export function deriveSeed(seed: Seed, salt: number): number {
  let x: number;
  if (typeof seed === 'bigint') {
    const v = BigInt.asUintN(128, seed);
    const m = (1n << 32n) - 1n;
    x = 0;
    for (let k = 0n; k < 4n; k++) {
      const st = { x: x ^ Number((v >> (32n * k)) & m) };
      x = splitmix32(st);
    }
  } else {
    x = seed | 0;
  }
  const st = { x: x ^ Math.imul(salt | 0, 0x27d4eb2d) };
  splitmix32(st);
  return splitmix32(st);
}
