// Leak test for the STATIC perception renderer (src/render).
//
//   npx tsx scripts/leak-test.ts            # full run, exits 1 on FAIL
//   npx tsx scripts/leak-test.ts --control  # injects a deliberate 10% neighbour-copy leak into the
//                                           # analysed frames: the single-frame checks must FAIL
//
// Three Beasts (one per type, tiers cycling, faint/vortex variants) bounce around a 256x144 field
// following SPEC section 6. Masks: synthetic blobs plus public/data/roster.json if present.
//
// Single-frame checks use frames spaced GAP = maxAge + 2 ticks apart. With the renderer's age cap
// such frames are exactly independent, so the usual i.i.d. test statistics are valid.
// Temporal checks follow the renderer's true (value-blind) flow from frame t to t+k and measure
// how often the pixel at t+k equals its motion-compensated origin at t.

import { existsSync, readFileSync } from 'node:fs';
import { NoiseField, persistFor, type RenderBeast } from '../src/render/field.ts';
import { parseRoster, syntheticMasks, Bouncer, type MaskDef } from '../src/render/synth.ts';
import { Xoshiro128 } from '../src/render/xoshiro.ts';

const CONTROL = process.argv.includes('--control');
const W = 256;
const H = 144;
const N = W * H;
const SEED = 0x5747_1c;
const SEG = 600; // ticks per "wave" (new Beasts, new masks, new tiers)
const MAX_K = 120;
const TEMPORAL_FRAMES = 19800;
const TRACK_EVERY = 10;
const SINGLE_FRAMES = 400; // independent frames for single-frame stats

const TYPE_NAMES = ['Magic', 'Hunter', 'Brute'];

interface SlotCfg {
  tier: number;
  faint?: boolean;
  vortex?: boolean;
}
// [Magic, Hunter, Brute] per wave
const WAVES: SlotCfg[][] = [
  [{ tier: 3 }, { tier: 3 }, { tier: 3 }],
  [{ tier: 1 }, { tier: 5 }, { tier: 2 }],
  [{ tier: 5, vortex: true }, { tier: 1 }, { tier: 4 }],
  [{ tier: 3 }, { tier: 3 }, { tier: 3 }],
  [{ tier: 2 }, { tier: 4, faint: true }, { tier: 5 }],
  [{ tier: 4 }, { tier: 2 }, { tier: 1 }],
  [{ tier: 3, faint: true }, { tier: 3 }, { tier: 3, faint: true }],
  [{ tier: 5 }, { tier: 5 }, { tier: 5 }],
];

// ---------------------------------------------------------------- masks
const masks: MaskDef[] = syntheticMasks();
let rosterCount = 0;
const rosterPath = new URL('../public/data/roster.json', import.meta.url);
if (existsSync(rosterPath)) {
  try {
    const roster = parseRoster(JSON.parse(readFileSync(rosterPath, 'utf8')));
    // keep a deterministic spread of real masks
    const step = Math.max(1, Math.floor(roster.length / 12));
    for (let i = 0; i < roster.length && rosterCount < 12; i += step) {
      if (roster[i].w <= W && roster[i].h <= H) {
        masks.push(roster[i]);
        rosterCount++;
      }
    }
  } catch (e) {
    console.warn('roster.json present but unreadable:', (e as Error).message);
  }
}

// ---------------------------------------------------------------- scene
const field = new NoiseField(SEED, W, H, { recordFlow: true });
const GAP = field.maxAge + 2;
const TOTAL = Math.max(TEMPORAL_FRAMES + MAX_K, 60 + GAP * SINGLE_FRAMES);
const sceneRng = new Xoshiro128(SEED ^ 0xabcdef);

interface Slot {
  beast: RenderBeast;
  bouncer: Bouncer;
  key: number;
  cfg: SlotCfg;
}
const keyNames: string[] = [];
function keyOf(type: number, cfg: SlotCfg): number {
  const name = `${TYPE_NAMES[type]} T${cfg.tier}${cfg.faint ? ' faint' : ''}${cfg.vortex ? ' vortex' : ''}`;
  let k = keyNames.indexOf(name);
  if (k < 0) k = keyNames.push(name) - 1;
  return k;
}

let slots: Slot[] = [];
function startWave(wave: number): void {
  const cfgs = WAVES[wave % WAVES.length];
  slots = cfgs.map((cfg, type) => {
    const m = masks[(wave * 3 + type * 2) % masks.length];
    const bouncer = Bouncer.random(sceneRng, W, H, m.w, m.h);
    const beast: RenderBeast = {
      id: wave * 3 + type,
      px: 0,
      py: 0,
      w: m.w,
      h: m.h,
      mask: m.mask,
      type: type as 0 | 1 | 2,
      persist: persistFor(cfg.tier, cfg.faint),
      t: 0,
      vortex: cfg.vortex,
    };
    return { beast, bouncer, key: keyOf(type, cfg), cfg };
  });
}

// ---------------------------------------------------------------- temporal trackers
interface Tracker {
  start: number;
  ref: Uint8Array;
  orig: Int32Array;
  next: Int32Array;
  list: Int32Array;
  nextList: Int32Array;
  count: number;
}
const pool: Tracker[] = [];
const active: Tracker[] = [];
function newTracker(start: number): Tracker {
  const t =
    pool.pop() ??
    ({
      start: 0,
      ref: new Uint8Array(N),
      orig: new Int32Array(N).fill(-1),
      next: new Int32Array(N).fill(-1),
      list: new Int32Array(N),
      nextList: new Int32Array(N),
      count: 0,
    } as Tracker);
  t.start = start;
  t.ref.set(field.cur);
  t.count = -1; // -1: identity origin (first step)
  return t;
}
// agreement accumulators [k][key] and pooled [k]
const MAXKEYS = 32;
const agree = new Float64Array((MAX_K + 1) * MAXKEYS);
const total = new Float64Array((MAX_K + 1) * MAXKEYS);
const agreeAll = new Float64Array(MAX_K + 1);
const totalAll = new Float64Array(MAX_K + 1);

function advanceTracker(tr: Tracker, k: number, slotKeys: Int32Array): void {
  const { flowDst, flowSrc, flowBeast, flowCount } = field;
  const cur = field.cur;
  const ref = tr.ref;
  const orig = tr.orig;
  const next = tr.next;
  const nl = tr.nextList;
  let nc = 0;
  const identity = tr.count < 0;
  const base = k * MAXKEYS;
  let a = 0;
  let c = 0;
  for (let i = 0; i < flowCount; i++) {
    const s = flowSrc[i];
    const o = identity ? s : orig[s];
    if (o < 0) continue;
    const d = flowDst[i];
    next[d] = o;
    nl[nc++] = d;
    const hit = cur[d] === ref[o] ? 1 : 0;
    const key = slotKeys[flowBeast[i]];
    agree[base + key] += hit;
    total[base + key] += 1;
    a += hit;
    c++;
  }
  agreeAll[k] += a;
  totalAll[k] += c;
  // clear old origins
  if (!identity) for (let i = 0; i < tr.count; i++) orig[tr.list[i]] = -1;
  tr.orig = next;
  tr.next = orig;
  tr.nextList = tr.list;
  tr.list = nl;
  tr.count = nc;
}

// ---------------------------------------------------------------- single-frame accumulators
const frameBuf = new Uint8Array(N);
const inMap = new Uint8Array(N); // beast index + 1
const integ = new Int32Array((W + 1) * (H + 1));
let onesIn = 0;
let nIn = 0;
let onesOut = 0;
let nOut = 0;
const h2In = new Float64Array(16);
const h2Out = new Float64Array(16);
const h3In = new Float64Array(512);
const h3Out = new Float64Array(512);
const sob = { band: [0, 0, 0], far: [0, 0, 0], interior: [0, 0, 0] }; // n, sum, sumsq
const NF = 25 + 20 + 20 + 16 + 16;
const featIn: Int8Array[] = [];
const featOut: Int8Array[] = [];
const frameIdxIn: number[] = [];
const frameIdxOut: number[] = [];
let sampledFrames = 0;
const leakRng = new Xoshiro128(99);

function paintMasks(): void {
  inMap.fill(0);
  slots.forEach((sl, bi) => {
    const B = sl.beast;
    for (let y = 0; y < B.h; y++) {
      const fy = B.py + y;
      if (fy < 0 || fy >= H) continue;
      for (let x = 0; x < B.w; x++) {
        const fx = B.px + x;
        if (fx < 0 || fx >= W || !B.mask[y * B.w + x]) continue;
        if (!inMap[fy * W + fx]) inMap[fy * W + fx] = bi + 1;
      }
    }
  });
  // integral image of inside indicator
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += inMap[y * W + x] ? 1 : 0;
      integ[(y + 1) * (W + 1) + x + 1] = integ[y * (W + 1) + x + 1] + row;
    }
  }
}
function boxCount(x: number, y: number, r: number): number {
  const x0 = Math.max(0, x - r);
  const y0 = Math.max(0, y - r);
  const x1 = Math.min(W, x + r + 1);
  const y1 = Math.min(H, y + r + 1);
  return integ[y1 * (W + 1) + x1] - integ[y0 * (W + 1) + x1] - integ[y1 * (W + 1) + x0] + integ[y0 * (W + 1) + x0];
}
function boxArea(x: number, y: number, r: number): number {
  return (Math.min(W, x + r + 1) - Math.max(0, x - r)) * (Math.min(H, y + r + 1) - Math.max(0, y - r));
}

function analyseFrame(fi: number): void {
  const f = frameBuf;
  f.set(field.cur);
  paintMasks();
  if (CONTROL) {
    // deliberate leak: 10% of inside pixels copy their left neighbour
    for (let i = 1; i < N; i++) if (inMap[i] && i % W > 0 && leakRng.next() < 0.1 * 4294967296) f[i] = f[i - 1];
  }
  // 1. density
  for (let i = 0; i < N; i++) {
    if (inMap[i]) {
      nIn++;
      onesIn += f[i];
    } else {
      nOut++;
      onesOut += f[i];
    }
  }
  // 2. block pattern histograms (non-overlapping blocks -> independent samples)
  for (let y = 0; y + 1 < H; y += 2)
    for (let x = 0; x + 1 < W; x += 2) {
      const i = y * W + x;
      const c = (inMap[i] ? 1 : 0) + (inMap[i + 1] ? 1 : 0) + (inMap[i + W] ? 1 : 0) + (inMap[i + W + 1] ? 1 : 0);
      if (c !== 0 && c !== 4) continue;
      const code = f[i] | (f[i + 1] << 1) | (f[i + W] << 2) | (f[i + W + 1] << 3);
      (c === 4 ? h2In : h2Out)[code]++;
    }
  for (let y = 0; y + 2 < H; y += 3)
    for (let x = 0; x + 2 < W; x += 3) {
      let c = 0;
      let code = 0;
      for (let dy = 0; dy < 3; dy++)
        for (let dx = 0; dx < 3; dx++) {
          const i = (y + dy) * W + x + dx;
          if (inMap[i]) c++;
          code = (code << 1) | f[i];
        }
      if (c !== 0 && c !== 9) continue;
      (c === 9 ? h3In : h3Out)[code]++;
    }
  // 3. Sobel energy on a stride-3 grid (non-overlapping 3x3 supports)
  for (let y = 1; y < H - 1; y += 3)
    for (let x = 1; x < W - 1; x += 3) {
      const i = y * W + x;
      const gx = f[i - W + 1] + 2 * f[i + 1] + f[i + W + 1] - f[i - W - 1] - 2 * f[i - 1] - f[i + W - 1];
      const gy = f[i + W - 1] + 2 * f[i + W] + f[i + W + 1] - f[i - W - 1] - 2 * f[i - W] - f[i - W + 1];
      const g = gx * gx + gy * gy;
      const c2 = boxCount(x, y, 2);
      const a2 = boxArea(x, y, 2);
      let acc: number[] | null = null;
      if (c2 > 0 && c2 < a2) acc = sob.band;
      else if (c2 === a2) acc = sob.interior;
      else if (boxCount(x, y, 5) === 0) acc = sob.far;
      if (acc) {
        acc[0]++;
        acc[1] += g;
        acc[2] += g * g;
      }
    }
  // 4. classifier samples: 5x5 windows on a stride-5 grid (non-overlapping), offset varies per frame
  const ox = fi % 5;
  const oy = (fi * 2) % 5;
  for (let y = 2 + oy; y < H - 2; y += 5)
    for (let x = 2 + ox; x < W - 2; x += 5) {
      const inside = inMap[y * W + x] > 0;
      if (!inside && leakRng.next() > 0.25 * 4294967296) continue;
      const v = new Int8Array(NF);
      let k = 0;
      const px = (dx: number, dy: number) => 2 * f[(y + dy) * W + x + dx] - 1;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) v[k++] = px(dx, dy);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx < 2; dx++) v[k++] = px(dx, dy) * px(dx + 1, dy);
      for (let dy = -2; dy < 2; dy++) for (let dx = -2; dx <= 2; dx++) v[k++] = px(dx, dy) * px(dx, dy + 1);
      for (let dy = -2; dy < 2; dy++) for (let dx = -2; dx < 2; dx++) v[k++] = px(dx, dy) * px(dx + 1, dy + 1);
      for (let dy = -2; dy < 2; dy++) for (let dx = -1; dx <= 2; dx++) v[k++] = px(dx, dy) * px(dx - 1, dy + 1);
      if (inside) {
        featIn.push(v);
        frameIdxIn.push(fi);
      } else {
        featOut.push(v);
        frameIdxOut.push(fi);
      }
    }
  sampledFrames++;
}

// ---------------------------------------------------------------- run
const t0 = performance.now();
let stepMs = 0;
let wave = -1;
const slotKeys = new Int32Array(8);
for (let frame = 0; frame < TOTAL; frame++) {
  const w = Math.floor(frame / SEG);
  if (w !== wave) {
    wave = w;
    startWave(w);
  }
  const t = frame - w * SEG;
  for (const sl of slots) {
    const [px, py] = sl.bouncer.pos(t);
    sl.beast.px = px;
    sl.beast.py = py;
    sl.beast.t = t;
  }
  slots.forEach((sl, i) => (slotKeys[i] = sl.key));
  const s0 = performance.now();
  field.step(slots.map((s) => s.beast));
  stepMs += performance.now() - s0;

  // temporal
  if (frame <= TEMPORAL_FRAMES + MAX_K) {
    for (let j = active.length - 1; j >= 0; j--) {
      const tr = active[j];
      const k = frame - tr.start;
      advanceTracker(tr, k, slotKeys);
      if (k >= MAX_K) {
        tr.orig.fill(-1);
        tr.next.fill(-1);
        pool.push(tr);
        active.splice(j, 1);
      }
    }
    if (frame < TEMPORAL_FRAMES && frame % TRACK_EVERY === 0 && frame > 0) active.push(newTracker(frame));
  }
  // single frame
  if (frame >= 60 && (frame - 60) % GAP === 0 && sampledFrames < SINGLE_FRAMES) analyseFrame(sampledFrames);
}
const elapsed = performance.now() - t0;

// ---------------------------------------------------------------- statistics
function chi2Homog(a: Float64Array, b: Float64Array): { chi2: number; df: number; z: number } {
  const na = a.reduce((s, v) => s + v, 0);
  const nb = b.reduce((s, v) => s + v, 0);
  let chi2 = 0;
  let df = -1;
  for (let i = 0; i < a.length; i++) {
    const tot = a[i] + b[i];
    if (tot === 0) continue;
    df++;
    const ea = (tot * na) / (na + nb);
    const eb = (tot * nb) / (na + nb);
    chi2 += (a[i] - ea) ** 2 / ea + (b[i] - eb) ** 2 / eb;
  }
  // Wilson-Hilferty normal approximation of the chi-square upper tail
  const z = (Math.cbrt(chi2 / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  return { chi2, df, z };
}
function meanVar(acc: number[]): { n: number; mean: number; varMean: number } {
  const [n, s, ss] = acc;
  const mean = s / n;
  const v = ss / n - mean * mean;
  return { n, mean, varMean: v / n };
}

function trainAuc(): { auc: number; nTrain: number; nTest: number; aucSd: number } {
  // balance classes
  const rng = new Xoshiro128(7);
  const nPer = Math.min(featIn.length, featOut.length);
  const pick = (arr: Int8Array[], idx: number[]) => {
    const order = arr.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = rng.next() % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order.slice(0, nPer).map((i) => ({ v: arr[i], f: idx[i] }));
  };
  const ins = pick(featIn, frameIdxIn).map((s) => ({ ...s, y: 1 }));
  const outs = pick(featOut, frameIdxOut).map((s) => ({ ...s, y: 0 }));
  const split = Math.floor(sampledFrames * 0.6);
  const all = ins.concat(outs);
  const train = all.filter((s) => s.f < split);
  const test = all.filter((s) => s.f >= split);
  for (let i = train.length - 1; i > 0; i--) {
    const j = rng.next() % (i + 1);
    [train[i], train[j]] = [train[j], train[i]];
  }
  // logistic regression, Adam, L2
  const D = NF + 1;
  const wv = new Float64Array(D);
  const m = new Float64Array(D);
  const v2 = new Float64Array(D);
  const g = new Float64Array(D);
  const lr = 0.005;
  const l2 = 1e-4;
  const B = 256;
  let step = 0;
  for (let epoch = 0; epoch < 6; epoch++) {
    for (let b0 = 0; b0 < train.length; b0 += B) {
      g.fill(0);
      const b1 = Math.min(train.length, b0 + B);
      for (let s = b0; s < b1; s++) {
        const { v, y } = train[s];
        let z = wv[NF];
        for (let k = 0; k < NF; k++) z += wv[k] * v[k];
        const p = 1 / (1 + Math.exp(-z));
        const e = p - y;
        for (let k = 0; k < NF; k++) g[k] += e * v[k];
        g[NF] += e;
      }
      step++;
      for (let k = 0; k < D; k++) {
        const gk = g[k] / (b1 - b0) + (k < NF ? l2 * wv[k] : 0);
        m[k] = 0.9 * m[k] + 0.1 * gk;
        v2[k] = 0.999 * v2[k] + 0.001 * gk * gk;
        const mh = m[k] / (1 - 0.9 ** step);
        const vh = v2[k] / (1 - 0.999 ** step);
        wv[k] -= (lr * mh) / (Math.sqrt(vh) + 1e-8);
      }
    }
  }
  const scored = test.map(({ v, y }) => {
    let z = wv[NF];
    for (let k = 0; k < NF; k++) z += wv[k] * v[k];
    return { z, y };
  });
  scored.sort((a, b) => a.z - b.z);
  // Mann-Whitney U with tie-averaged ranks
  let rankSumPos = 0;
  let nPos = 0;
  for (let i = 0; i < scored.length; ) {
    let j = i;
    while (j < scored.length && scored[j].z === scored[i].z) j++;
    const avg = (i + j + 1) / 2;
    for (let q = i; q < j; q++)
      if (scored[q].y === 1) {
        rankSumPos += avg;
        nPos++;
      }
    i = j;
  }
  const nNeg = scored.length - nPos;
  const auc = (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
  const aucSd = Math.sqrt((nPos + nNeg + 1) / (12 * nPos * nNeg));
  return { auc, nTrain: train.length, nTest: test.length, aucSd };
}

const results: { name: string; value: string; pass: boolean }[] = [];
function check(name: string, value: string, pass: boolean): void {
  results.push({ name, value, pass });
}

// single-frame
const pIn = onesIn / nIn;
const pOut = onesOut / nOut;
const pPool = (onesIn + onesOut) / (nIn + nOut);
const zDen = (pIn - pOut) / Math.sqrt(pPool * (1 - pPool) * (1 / nIn + 1 / nOut));
check('density inside vs outside', `in ${pIn.toFixed(5)} out ${pOut.toFixed(5)}  z=${zDen.toFixed(2)}  (|z|<4)`, Math.abs(zDen) < 4);
const c2 = chi2Homog(h2In, h2Out);
check(
  '2x2 pattern histogram in vs out',
  `chi2=${c2.chi2.toFixed(1)} df=${c2.df}  z=${c2.z.toFixed(2)}  (z<3.5; ${h2In.reduce((a, b) => a + b)} in-blocks)`,
  c2.z < 3.5,
);
const c3 = chi2Homog(h3In, h3Out);
check(
  '3x3 pattern histogram in vs out',
  `chi2=${c3.chi2.toFixed(1)} df=${c3.df}  z=${c3.z.toFixed(2)}  (z<3.5; ${h3In.reduce((a, b) => a + b)} in-blocks)`,
  c3.z < 3.5,
);
const sb = meanVar(sob.band);
const sf = meanVar(sob.far);
const si = meanVar(sob.interior);
const zSob = (sb.mean - sf.mean) / Math.sqrt(sb.varMean + sf.varMean);
const zSobI = (si.mean - sf.mean) / Math.sqrt(si.varMean + sf.varMean);
check(
  'Sobel energy: mask boundary vs far',
  `boundary ${sb.mean.toFixed(4)} (n=${sb.n})  far ${sf.mean.toFixed(4)} (n=${sf.n})  ratio ${(sb.mean / sf.mean).toFixed(4)}  z=${zSob.toFixed(2)}  (|z|<4; iid expectation 6)`,
  Math.abs(zSob) < 4,
);
check(
  'Sobel energy: mask interior vs far',
  `interior ${si.mean.toFixed(4)} (n=${si.n})  z=${zSobI.toFixed(2)}  (|z|<4)`,
  Math.abs(zSobI) < 4,
);
const lr = trainAuc();
check(
  'logistic regression on 5x5 (+72 pair products)',
  `held-out AUC ${lr.auc.toFixed(4)} (sd ${lr.aucSd.toFixed(4)}, train ${lr.nTrain}, test ${lr.nTest})  (in [0.49, 0.51])`,
  lr.auc >= 0.49 && lr.auc <= 0.51,
);

// temporal
const excess = (a: number, t: number) => (t > 0 ? a / t - 0.5 : NaN);
const KS = [1, 2, 4, 8, 16, 32, 48, 49, 60, 90, 120];
const tableRows: string[] = [];
tableRows.push('  ' + 'beast'.padEnd(26) + KS.map((k) => `k=${k}`.padStart(8)).join(''));
const order = keyNames.map((n, i) => ({ n, i })).sort((a, b) => a.n.localeCompare(b.n, 'en', { numeric: true }));
for (const { n, i } of order) {
  tableRows.push(
    '  ' +
      n.padEnd(26) +
      KS.map((k) => {
        const e = excess(agree[k * MAXKEYS + i], total[k * MAXKEYS + i]);
        return (Number.isNaN(e) ? '-' : e.toFixed(4)).padStart(8);
      }).join(''),
  );
}
tableRows.push(
  '  ' + 'ALL (pooled)'.padEnd(26) + KS.map((k) => excess(agreeAll[k], totalAll[k]).toFixed(4).padStart(8)).join(''),
);
for (const tname of TYPE_NAMES) {
  const i = keyNames.indexOf(`${tname} T3`);
  const e = i >= 0 ? excess(agree[MAXKEYS + i], total[MAXKEYS + i]) : NaN;
  check(`k=1 signal, ${tname} T3`, `excess agreement ${e.toFixed(4)}  (>= 0.2)`, e >= 0.2);
}
let maxLate = -Infinity;
let maxLateK = 0;
let lateA = 0;
let lateT = 0;
let minLateN = Infinity;
for (let k = 60; k <= MAX_K; k++) {
  const e = excess(agreeAll[k], totalAll[k]);
  if (Math.abs(e) > maxLate) {
    maxLate = Math.abs(e);
    maxLateK = k;
  }
  lateA += agreeAll[k];
  lateT += totalAll[k];
  minLateN = Math.min(minLateN, totalAll[k]);
}
const lateSd = 0.5 / Math.sqrt(minLateN);
check(
  'k>=60 no signal, each k (pooled)',
  `max |excess| ${maxLate.toFixed(5)} at k=${maxLateK}  (< 0.002; per-k noise sd ~${lateSd.toFixed(5)})`,
  maxLate < 0.002,
);
check(
  'k in [60,120] no signal, mean (pooled)',
  `excess ${(lateA / lateT - 0.5).toFixed(6)} over ${lateT.toExponential(2)} comparisons  (< 0.002)`,
  Math.abs(lateA / lateT - 0.5) < 0.002,
);

// ---------------------------------------------------------------- report
console.log(`STATIC renderer leak test${CONTROL ? '  [CONTROL: deliberate leak injected]' : ''}`);
console.log(
  `field ${W}x${H}, ${TOTAL} frames simulated (${(stepMs / TOTAL).toFixed(4)} ms/step), masks: ${masks.length} (${rosterCount} from roster.json), maxAge ${field.maxAge}`,
);
console.log(`single-frame stats on ${sampledFrames} frames spaced ${GAP} ticks apart (exactly independent)`);
console.log(`temporal stats from ${Math.floor(TEMPORAL_FRAMES / TRACK_EVERY)} start frames, lags 1..${MAX_K}\n`);
console.log('motion-compensated excess agreement over 0.5 (frame t vs t+k, inside masks, true flow):');
console.log(tableRows.join('\n'));
console.log('');
let allPass = true;
for (const r of results) {
  allPass &&= r.pass;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(46)} ${r.value}`);
}
console.log(`\n${allPass ? 'PASS' : 'FAIL'}  (${(elapsed / 1000).toFixed(1)} s)`);
process.exit(allPass ? 0 : 1);
