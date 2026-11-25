// Per-type flow builders. A "flow" assigns to every mask pixel i (the destination, in the
// Beast's local box this frame) a source position (sx[i], sy[i]) in the Beast's local box of
// the PREVIOUS frame. The caller adds the previous top-left to get field coordinates.
//
// Invariant (tested): for every type and every (t, tPrev) the map i -> (sx[i], sy[i]) is
// injective. Magic and Brute flows are permutations of the mask's own pixels; Hunter is an
// integer translation per row (sources may lie outside the mask, which is fine because the
// field's `used` bitmap guarantees no source is read twice in a frame).
//
// Nothing here ever looks at pixel values: flows depend only on the mask, t and the Beast id.

export type BeastType = 0 | 1 | 2;

export interface FlowParams {
  /** Magic: arc speed of the outermost ring, field px per 60 Hz tick. */
  magicEdgeSpeed: number;
  /** Magic: clamp for the angular speed (rad per tick) so tiny/huge masks still read as swirl. */
  magicMinOmega: number;
  magicMaxOmega: number;
  /** Hunter: lateral speed in px per tick. */
  hunterSpeed: number;
  /** Hunter: per-row speed variation (0 = rigid slab, 0.3 = rows differ by up to +-30%): gives the streak look. */
  hunterRowJitter: number;
  /** Hunter: direction can flip at multiples of this many ticks... */
  hunterFlipPeriod: number;
  /** ...with this probability per boundary (deterministic per Beast id). */
  hunterFlipChance: number;
  /** Brute: shear speed of each band, px per tick (alternate bands move in opposite directions). */
  bruteSpeed: number;
  /** Brute: band height in rows. */
  bruteBand: number;
  /** Brute: slam period in ticks, number of slam ticks per period, vertical px per slam tick. */
  slamPeriod: number;
  slamTicks: number;
  slamStep: number;
}

export const DEFAULT_FLOW_PARAMS: Readonly<FlowParams> = Object.freeze({
  magicEdgeSpeed: 1.1,
  magicMinOmega: 0.025,
  magicMaxOmega: 0.09,
  hunterSpeed: 2.0,
  hunterRowJitter: 0.3,
  hunterFlipPeriod: 45,
  hunterFlipChance: 0.35,
  bruteSpeed: 1.0,
  bruteBand: 3,
  slamPeriod: 48,
  slamTicks: 3,
  slamStep: 2,
});

/** Precomputed, value-independent geometry of one mask. Cached by mask identity. */
export interface MaskInfo {
  readonly w: number;
  readonly h: number;
  /** number of mask pixels */
  readonly n: number;
  /** local coords of mask pixel i, row-major order */
  readonly xs: Int16Array;
  readonly ys: Int16Array;
  /** silhouette centroid (pixel centres at +0.5) and max radius */
  readonly cx: number;
  readonly cy: number;
  readonly rMax: number;
  /** rings: pixels with floor(r) == k, sorted by angle; ringOrder[ringStart[k] .. ringStart[k+1]) */
  readonly ringStart: Int32Array;
  readonly ringOrder: Int32Array;
  /** mean radius of ring k */
  readonly ringR: Float64Array;
  /** horizontal runs: contiguous index ranges [rowRunStart[r], +rowRunLen[r]) of the row-major list */
  readonly rowRunStart: Int32Array;
  readonly rowRunLen: Int32Array;
  /** vertical runs over colOrder (pixel indices sorted by column, then row) */
  readonly colOrder: Int32Array;
  readonly colRunStart: Int32Array;
  readonly colRunLen: Int32Array;
}

const cache = new WeakMap<Uint8Array, MaskInfo>();

/** Geometry for a mask; computed once per mask object (masks must not be mutated after first use). */
export function getMaskInfo(mask: Uint8Array, w: number, h: number): MaskInfo {
  const hit = cache.get(mask);
  if (hit && hit.w === w && hit.h === h) return hit;
  const info = buildMaskInfo(mask, w, h);
  cache.set(mask, info);
  return info;
}

export function buildMaskInfo(mask: Uint8Array, w: number, h: number): MaskInfo {
  if (!(w >= 0 && h >= 0) || mask.length < w * h) throw new Error(`mask too small: ${mask.length} < ${w}x${h}`);
  let n = 0;
  for (let k = 0; k < w * h; k++) if (mask[k]) n++;
  const xs = new Int16Array(n);
  const ys = new Int16Array(n);
  const idxOf = new Int32Array(w * h).fill(-1);
  let sx = 0;
  let sy = 0;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      xs[i] = x;
      ys[i] = y;
      idxOf[y * w + x] = i;
      sx += x + 0.5;
      sy += y + 0.5;
      i++;
    }
  }
  const cx = n ? sx / n : w / 2;
  const cy = n ? sy / n : h / 2;

  // Rings.
  const r = new Float64Array(n);
  const ring = new Int32Array(n);
  let rMax = 0;
  let maxRing = -1;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] + 0.5 - cx;
    const dy = ys[i] + 0.5 - cy;
    r[i] = Math.hypot(dx, dy);
    ring[i] = Math.floor(r[i]);
    if (r[i] > rMax) rMax = r[i];
    if (ring[i] > maxRing) maxRing = ring[i];
  }
  const R = maxRing + 1;
  const ringStart = new Int32Array(R + 1);
  for (let i = 0; i < n; i++) ringStart[ring[i] + 1]++;
  for (let k = 0; k < R; k++) ringStart[k + 1] += ringStart[k];
  const ringR = new Float64Array(R);
  const key = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.atan2(ys[i] + 0.5 - cy, xs[i] + 0.5 - cx) + Math.PI; // [0, 2pi]
    key[i] = ring[i] * 8 + a;
    ringR[ring[i]] += r[i];
  }
  for (let k = 0; k < R; k++) {
    const c = ringStart[k + 1] - ringStart[k];
    ringR[k] = c ? ringR[k] / c : k + 0.5;
  }
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => key[a] - key[b] || a - b);
  const ringOrder = Int32Array.from(order);

  // Horizontal runs (contiguous in the row-major list).
  const rs: number[] = [];
  const rl: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0 && ys[i] === ys[i - 1] && xs[i] === xs[i - 1] + 1) rl[rl.length - 1]++;
    else {
      rs.push(i);
      rl.push(1);
    }
  }

  // Vertical runs over column-major order.
  const colOrder = new Int32Array(n);
  const cs: number[] = [];
  const cl: number[] = [];
  let c = 0;
  for (let x = 0; x < w; x++) {
    let prevY = -2;
    for (let y = 0; y < h; y++) {
      const i = idxOf[y * w + x];
      if (i < 0) continue;
      if (y === prevY + 1) cl[cl.length - 1]++;
      else {
        cs.push(c);
        cl.push(1);
      }
      colOrder[c++] = i;
      prevY = y;
    }
  }

  return {
    w,
    h,
    n,
    xs,
    ys,
    cx,
    cy,
    rMax,
    ringStart,
    ringOrder,
    ringR,
    rowRunStart: Int32Array.from(rs),
    rowRunLen: Int32Array.from(rl),
    colOrder,
    colRunStart: Int32Array.from(cs),
    colRunLen: Int32Array.from(cl),
  };
}

/** Reusable output buffers for computeFlow. */
export class FlowScratch {
  sx = new Int32Array(4096);
  sy = new Int32Array(4096);
  rowStep = new Int32Array(64);

  ensure(n: number, h: number): void {
    if (this.sx.length < n) {
      this.sx = new Int32Array(n);
      this.sy = new Int32Array(n);
    }
    if (this.rowStep.length < h) this.rowStep = new Int32Array(h);
  }
}

/** 32-bit integer hash (value-independent determinism for per-Beast choices). */
export function hash32(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * Compute the flow for one Beast between tick tPrev (previous step) and t (this step).
 * Writes out.sx[i], out.sy[i] for i in [0, info.n). Phases are pure functions of t, so a caller
 * stepping at 30 Hz (t advancing by 2) gets the same real-time speeds.
 */
export function computeFlow(
  info: MaskInfo,
  type: BeastType,
  t: number,
  tPrev: number,
  id: number,
  vortex: boolean,
  p: Readonly<FlowParams>,
  out: FlowScratch,
): void {
  out.ensure(info.n, info.h);
  if (type === 0) magicFlow(info, t, tPrev, id, vortex, p, out);
  else if (type === 1) hunterFlow(info, t, tPrev, id, p, out);
  else bruteFlow(info, t, tPrev, id, p, out);
}

export function magicOmega(info: MaskInfo, id: number, vortex: boolean, p: Readonly<FlowParams>): number {
  const base = Math.min(p.magicMaxOmega, Math.max(p.magicMinOmega, p.magicEdgeSpeed / Math.max(info.rMax, 4)));
  return base * (vortex ? 2 : 1) * (id & 1 ? -1 : 1);
}

function magicFlow(
  info: MaskInfo,
  t: number,
  tPrev: number,
  id: number,
  vortex: boolean,
  p: Readonly<FlowParams>,
  out: FlowScratch,
): void {
  const { xs, ys, ringStart, ringOrder, ringR } = info;
  const { sx, sy } = out;
  const omega = magicOmega(info, id, vortex, p);
  const a1 = omega * t;
  const a0 = omega * tPrev;
  const R = ringR.length;
  for (let k = 0; k < R; k++) {
    const base = ringStart[k];
    const n = ringStart[k + 1] - base;
    if (n === 0) continue;
    // Cyclic shift in angle order by the arc length a rigid rotation would cover at this radius.
    const rk = ringR[k];
    let s = (Math.round(a1 * rk) - Math.round(a0 * rk)) % n;
    if (s < 0) s += n;
    for (let j = 0; j < n; j++) {
      let q = j - s;
      if (q < 0) q += n;
      const i = ringOrder[base + j];
      const si = ringOrder[base + q];
      sx[i] = xs[si];
      sy[i] = ys[si];
    }
  }
}

/** Hunter lateral position (px, before row jitter) as a pure function of t. */
export function hunterX(t: number, id: number, p: Readonly<FlowParams>): number {
  const L = Math.max(1, Math.round(p.hunterFlipPeriod));
  const thr = Math.floor(p.hunterFlipChance * 4294967296);
  let dir = id & 1 ? -1 : 1;
  let x = 0;
  const segs = Math.floor(t / L);
  for (let s = 0; s < segs; s++) {
    x += dir * L;
    if (hash32(id, s + 1) < thr) dir = -dir;
  }
  x += dir * (t - Math.max(0, segs) * L);
  return x * p.hunterSpeed;
}

function hunterFlow(info: MaskInfo, t: number, tPrev: number, id: number, p: Readonly<FlowParams>, out: FlowScratch): void {
  const { xs, ys, h, n } = info;
  const { sx, sy, rowStep } = out;
  const x1 = hunterX(t, id, p);
  const x0 = hunterX(tPrev, id, p);
  const jit = p.hunterRowJitter;
  for (let y = 0; y < h; y++) {
    const f = 1 + jit * ((hash32(y, 0x51ed) / 4294967296) * 2 - 1);
    rowStep[y] = Math.floor(x1 * f) - Math.floor(x0 * f);
  }
  for (let i = 0; i < n; i++) {
    sx[i] = xs[i] - rowStep[ys[i]];
    sy[i] = ys[i];
  }
}

/** Number of slam ticks in (-inf, t] relative to a phase offset (difference of two calls = slam ticks in between). */
function slamCount(t: number, off: number, P: number, F: number): number {
  const u = t + off + 1;
  const q = Math.floor(u / P);
  return q * F + Math.min(u - q * P, F);
}

/** True when tick t is inside a Brute slam for this id (exported for the lab / tests). */
export function isSlamTick(t: number, id: number, p: Readonly<FlowParams>): boolean {
  const P = Math.max(1, Math.round(p.slamPeriod));
  const F = Math.min(P, Math.max(0, Math.round(p.slamTicks)));
  const off = (id * 17) % P;
  return slamCount(t, off, P, F) - slamCount(t - 1, off, P, F) > 0;
}

function bruteFlow(info: MaskInfo, t: number, tPrev: number, id: number, p: Readonly<FlowParams>, out: FlowScratch): void {
  const { xs, ys, n } = info;
  const { sx, sy } = out;
  const P = Math.max(1, Math.round(p.slamPeriod));
  const F = Math.min(P, Math.max(0, Math.round(p.slamTicks)));
  const off = (id * 17) % P;
  const v = Math.round(p.slamStep) * (slamCount(t, off, P, F) - slamCount(tPrev, off, P, F));
  if (v !== 0) {
    // Slam: cyclic shift down each vertical run.
    const { colOrder, colRunStart, colRunLen } = info;
    for (let r = 0; r < colRunStart.length; r++) {
      const base = colRunStart[r];
      const len = colRunLen[r];
      let s = v % len;
      if (s < 0) s += len;
      for (let j = 0; j < len; j++) {
        let q = j - s;
        if (q < 0) q += len;
        const i = colOrder[base + j];
        const si = colOrder[base + q];
        sx[i] = xs[si];
        sy[i] = ys[si];
      }
    }
    return;
  }
  const st = Math.floor(p.bruteSpeed * t) - Math.floor(p.bruteSpeed * tPrev);
  if (st === 0) {
    for (let i = 0; i < n; i++) {
      sx[i] = xs[i];
      sy[i] = ys[i];
    }
    return;
  }
  // Grind: each row run is cyclically shifted; bands of `bruteBand` rows alternate direction.
  const band = Math.max(1, Math.round(p.bruteBand));
  const { rowRunStart, rowRunLen } = info;
  for (let r = 0; r < rowRunStart.length; r++) {
    const base = rowRunStart[r];
    const len = rowRunLen[r];
    const y = ys[base];
    const d = Math.floor(y / band) & 1 ? -st : st;
    let s = d % len;
    if (s < 0) s += len;
    for (let j = 0; j < len; j++) {
      let q = j - s;
      if (q < 0) q += len;
      const si = base + q;
      sx[base + j] = xs[si];
      sy[base + j] = y;
    }
  }
}
