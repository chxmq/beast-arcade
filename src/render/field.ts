// The 1-bit noise field. NO DOM: runs in browsers and in Node (server-side tapes).
//
// Every step:
//   1. prev <- cur; cur <- fresh i.i.d. fair bits (age 0 everywhere).
//   2. For each Beast, for each mask pixel (destination d, this frame's position) the flow names a
//      source s in the previous frame's coordinates (previous top-left + local flow source).
//      The pair is claimed only if d and s are inside the field and neither was claimed earlier
//      this frame (per-frame `used` stamps), so the global map d -> s is injective.
//   3. With probability `persist` (a draw independent of every pixel value) and if the carried
//      value is younger than `maxAge` ticks, cur[d] = prev[s]; otherwise cur[d] keeps its fresh bit.
// Since prev is i.i.d. Bernoulli(1/2) and the copy map is injective and value-blind, cur is again
// i.i.d. Bernoulli(1/2): a single frame carries zero information about the masks. The age cap
// makes frames more than `maxAge` ticks apart exactly independent. See README.md.

import { computeFlow, DEFAULT_FLOW_PARAMS, FlowScratch, getMaskInfo, type BeastType, type FlowParams } from './flows.ts';
import { deriveSeed, Xoshiro128, type Seed } from './xoshiro.ts';

export interface RenderBeast {
  /** stable spawn index while on screen */
  id: number;
  /** integer top-left in field pixels, this frame */
  px: number;
  py: number;
  w: number;
  h: number;
  /** w*h, 1 = inside silhouette (row-major). Pass the SAME Uint8Array every frame (geometry is cached by identity). */
  mask: Uint8Array;
  type: BeastType;
  /** 0..1, see persistFor() */
  persist: number;
  /** ticks since spawn (flow phase) */
  t: number;
  /** Magic swirls twice as fast */
  vortex?: boolean;
}

/** SPEC section 12: persistence by tier (1..5), minus 0.08 when faint. */
export function persistFor(tier: number, faint = false): number {
  const table = [0.7, 0.76, 0.82, 0.88, 0.93];
  const p = table[Math.min(5, Math.max(1, Math.round(tier))) - 1];
  return faint ? p - 0.08 : p;
}

export interface NoiseFieldOptions {
  /** Max age (in ticks) a carried value may reach; older values are refreshed. Default 48 (0.8 s). Max 250. */
  maxAge?: number;
  /** Override flow tuning (defaults: DEFAULT_FLOW_PARAMS). */
  params?: Partial<FlowParams>;
  /** Record the (dst, src, beast) pairs of each step's flow in flowDst/flowSrc/flowBeast (for analysis). */
  recordFlow?: boolean;
}

interface BeastState {
  px: number;
  py: number;
  t: number;
  mask: Uint8Array;
  seen: number;
}

export class NoiseField {
  readonly w: number;
  readonly h: number;
  /** w*h values 0|1, valid after construction (pure noise) and after each step(). Same array object forever. */
  readonly cur: Uint8Array;
  /** Values carried for more than maxAge ticks are refreshed (exact decorrelation beyond it). */
  maxAge: number;
  /** Flow tuning; may be mutated live (the lab does). */
  params: FlowParams;
  /** When true, step() records its claimed flow pairs (field indices) below. */
  recordFlow: boolean;
  flowDst: Int32Array;
  flowSrc: Int32Array;
  flowBeast: Uint8Array;
  flowCount = 0;
  /** Number of steps taken. */
  frame = 0;

  private readonly prev: Uint8Array;
  private readonly cur32: Uint32Array;
  private age: Uint8Array;
  private agePrev: Uint8Array;
  private readonly srcStamp: Uint32Array;
  private readonly dstStamp: Uint32Array;
  private gen = 0;
  private readonly noise: Xoshiro128;
  private readonly dec: Xoshiro128;
  private readonly states = new Map<number, BeastState>();
  private readonly scratch = new FlowScratch();

  constructor(seed: Seed, w = 256, h = 144, opts: NoiseFieldOptions = {}) {
    if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0)) throw new Error('bad field size');
    this.w = w;
    this.h = h;
    const n = w * h;
    const padded = (n + 31) & ~31;
    const buf = new ArrayBuffer(padded);
    this.cur = new Uint8Array(buf, 0, n);
    this.cur32 = new Uint32Array(buf);
    this.prev = new Uint8Array(n);
    this.age = new Uint8Array(n);
    this.agePrev = new Uint8Array(n);
    this.srcStamp = new Uint32Array(n);
    this.dstStamp = new Uint32Array(n);
    this.flowDst = new Int32Array(n);
    this.flowSrc = new Int32Array(n);
    this.flowBeast = new Uint8Array(n);
    this.maxAge = Math.min(250, Math.max(1, Math.round(opts.maxAge ?? 48)));
    this.params = { ...DEFAULT_FLOW_PARAMS, ...(opts.params ?? {}) };
    this.recordFlow = !!opts.recordFlow;
    this.noise = new Xoshiro128(seed);
    this.dec = new Xoshiro128(deriveSeed(seed, 0x0dec1de5));
    this.noise.fillBitWords(this.cur32);
  }

  /**
   * Advance one frame. `dt` = number of 60 Hz ticks this step represents (default 1; use 2 when
   * stepping at 30 Hz in calm mode). It only affects the age cap; flow phases come from each
   * Beast's own `t` (difference to the t it had at the previous step).
   */
  step(beasts: readonly RenderBeast[], dt = 1): void {
    const W = this.w;
    const H = this.h;
    const cur = this.cur;
    const prev = this.prev;
    prev.set(cur);
    const tmp = this.agePrev;
    this.agePrev = this.age;
    this.age = tmp;
    const age = this.age;
    const agePrev = this.agePrev;
    age.fill(0);
    this.noise.fillBitWords(this.cur32);

    let gen = ++this.gen;
    if (gen >= 0xfffffff0) {
      this.srcStamp.fill(0);
      this.dstStamp.fill(0);
      gen = this.gen = 1;
    }
    const srcStamp = this.srcStamp;
    const dstStamp = this.dstStamp;
    const record = this.recordFlow;
    const flowDst = this.flowDst;
    const flowSrc = this.flowSrc;
    const flowBeast = this.flowBeast;
    let fc = 0;
    const maxAge = this.maxAge;
    const ddt = Math.max(1, Math.round(dt));
    const dec = this.dec;
    const out = this.scratch;

    for (let b = 0; b < beasts.length; b++) {
      const B = beasts[b];
      const info = getMaskInfo(B.mask, B.w, B.h);
      let st = this.states.get(B.id);
      let ppx: number;
      let ppy: number;
      let tPrev: number;
      if (!st || st.mask !== B.mask) {
        ppx = B.px;
        ppy = B.py;
        tPrev = B.t - ddt;
        st = { px: B.px, py: B.py, t: B.t, mask: B.mask, seen: gen };
        this.states.set(B.id, st);
      } else {
        ppx = st.px;
        ppy = st.py;
        tPrev = st.t;
      }
      st.px = B.px;
      st.py = B.py;
      st.t = B.t;
      st.seen = gen;
      if (info.n === 0) continue;

      computeFlow(info, B.type, B.t, tPrev, B.id, !!B.vortex, this.params, out);
      const { xs, ys, n } = info;
      const sxs = out.sx;
      const sys = out.sy;
      const thr = Math.round(Math.min(1, Math.max(0, B.persist)) * 65536);
      const px = B.px | 0;
      const py = B.py | 0;
      let r = 0;
      for (let i = 0; i < n; i++) {
        // One 16-bit uniform per mask pixel, drawn unconditionally (stream use is value-blind).
        let u: number;
        if ((i & 1) === 0) {
          r = dec.next();
          u = r & 0xffff;
        } else u = r >>> 16;
        const dx = px + xs[i];
        const dy = py + ys[i];
        if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue;
        const d = dy * W + dx;
        if (dstStamp[d] === gen) continue;
        const sx = ppx + sxs[i];
        const sy = ppy + sys[i];
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        const s = sy * W + sx;
        if (srcStamp[s] === gen) continue;
        srcStamp[s] = gen;
        dstStamp[d] = gen;
        if (record) {
          flowDst[fc] = d;
          flowSrc[fc] = s;
          flowBeast[fc] = b;
          fc++;
        }
        if (u < thr) {
          const a = agePrev[s] + ddt;
          if (a <= maxAge) {
            cur[d] = prev[s];
            age[d] = a;
          }
        }
      }
    }
    this.flowCount = fc;
    if (this.states.size > beasts.length) {
      for (const [id, s] of this.states) if (s.seen !== gen) this.states.delete(id);
    }
    this.frame++;
  }

  /** Forget all per-Beast history (next step treats every Beast as newly spawned). */
  resetBeasts(): void {
    this.states.clear();
  }
}
