// THE STATIC: a Beast made of TV static, drawn for the Beasts V3 registry (64x64 community art).
//
// Writes public/beasts/static-species/:
//   static_regular.png / static_shiny.png   frame 0, 64x64 RGBA, transparent background
//   static_regular.gif / static_shiny.gif   animated loop (noise re-rolls, eyes flicker, mouth blips)
//   preview.png                             review sheet: 8x and 4x on black and on a light card
//
// The silhouette is the hand-authored GRID below (one char per pixel); shading, noise, outline,
// glow and animation are computed. Everything is deterministic (seeded PRNG).
//
// Usage: npx tsx scripts/make-static-species.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GifWriter } from 'omggif';
import { PNG } from 'pngjs';
import { Canvas } from './lib/png.ts';

// ------------------------------------------------------------------------------------- grid
//
//  .  empty                    B  body (shoulders, torso)     L  arms and fists
//  d  crease in the body (always in deep shadow)
//  H  hood around the face     S  dissolve zone: the body breaks up into static streaks
//  F  face (dark screen)       R  glint on the screen glass   E  eye
//  M  mouth scanline           m  mouth ends
//  C  claw                     A  antenna rod                 T  antenna tip      N  antenna base
//  o  forced outline pixel
//
// Z order (for the dark contour where a part overlaps another): B,S < L < H < C < A,T,N.

const GRID = `
................................................................
................................................................
....................T...........................................
...................TTT..........................................
....................T.AA........................................
........................A.......................................
.........................A............AAA.......................
..........................A..........A...AA.....................
...........................A........A......AA..T................
...........................A........A........ATTT...............
............................A......A...........T................
.............................A....A.............................
.............................A....A.............................
..............................A..A..............................
.................BBBBBB........NN........BBBBBB.................
..............BBBBBBBBBBBB....NNNN....BBBBBBBBBBBB..............
.............BBBBBBBBBBBBBB..HHHHHH..BBBBBBBBBBBBBB.............
............BBBBBBBBBBBBBBHHHHHHHHHHHHBBBBBBBBBBBBBB............
...........BBBBBBBBBBBBBBHHHHHHHHHHHHHHBBBBBBBBBBBBBB...........
..........BBBBBBBBBBBBBBHHHHHHHHHHHHHHHHBBBBBBBBBBBBBB..........
..........BBBLLLLBBBBBBHHFFFFFHHHHFFFFFHHBBBBBBLLLLBBB..........
.........BBLLLLLLLLBBBBHHFRRFFFFFFFFFFFHHBBBBLLLLLLLLBB.........
.........BLLLLLLLLLLBBHHHRFFFFFFFFFFFFFHHHBBLLLLLLLLLLB.........
.........BLLLLLLLLLLBBHHHFFEEFFFFFFEEFFHHHBBLLLLLLLLLLB.........
.........LLLLLLLLLLLLBHHHFFFEEFFFFEEFFFHHHBLLLLLLLLLLLL.........
.........LLLLLLLLLLLLBHHHFFFFFFFFFFFFFFHHHBLLLLLLLLLLLL.........
........LLLLLLLLLLLLLBHHHHFFFFFFFFFFFFHHHHBLLLLLLLLLLLLL........
........LLLLLLLLLLLLLBHHHHmMMMMMMMMMMmHHHHBLLLLLLLLLLLLL........
.......LLLLLLLLLLLLLBBBHHHHFFFFFFFFFFHHHHBBBLLLLLLLLLLLLL.......
.......LLLLLLLLLLLLLBBBHHHHHFFFFFFFFHHHHHBBBLLLLLLLLLLLLL.......
.......LLLLLLLLLLLLBBBBBHHHHHHHHHHHHHHHHBBBBBLLLLLLLLLLLL.......
......LLLLLLLLLLLLLBBBBBBHHHHHHHHHHHHHHBBBBBBLLLLLLLLLLLLL......
......LLLLLLLLLLLLBBBBBBBBHHHHHHHHHHHHBBBBBBBBLLLLLLLLLLLL......
.....LLLLLLLLLLLLLBBBBBBBBBBBHHHHHHBBBBBBBBBBBLLLLLLLLLLLLL.....
.....LLLLLLLLLLLLBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBLLLLLLLLLLLL.....
....LLLLLLLLLLLLBBBBBBBBBBBBBBBdBBBBBBBBBBBBBBBBLLLLLLLLLLLL....
....LLLLLLLLLLLLBBBBBBBBBBBBBBBdBBBBBBBBBBBBBBBBLLLLLLLLLLLL....
....LLLLLLLLLLL.BBBddBBBBBBBBBBdBBBBBBBBBBBddBBB.LLLLLLLLLLL....
...LLLLLLLLLLLL..BBBBdddBBBBBBBdBBBBBBBBdddBBBB..LLLLLLLLLLLL...
...LLLLLLLLLLL...BBBBBBBdddBBBBBBBBBBdddBBBBBBB...LLLLLLLLLLL...
...LLLLLLLLLLL...BBBBBBBBBBddddBBddddBBBBBBBBBB...LLLLLLLLLLL...
...LLLLLLLLLLL....BBBBBBBBBBBBBBBBBBBBBBBBBBBB....LLLLLLLLLLL...
...LLLLLLLLLLL.....BBBBBBBBBBBBBBBBBBBBBBBBBB.....LLLLLLLLLLL...
....LLLLLLLLLLL.....BBBBBBBBBBBBBBBBBBBBBBBB.....LLLLLLLLLLL....
....LLLLLLLLLLL......BBBBBBBBBBBBBBBBBBBBBB......LLLLLLLLLLL....
....LLLLLLLLLLLL.....BBBBBBBBBBBBBBBBBBBBBB.....LLLLLLLLLLLL....
.....LLLLLLLLLLL.....SBBBBBBBBBBBBBBBBBBBBS.....LLLLLLLLLLL.....
.....LLLLLLLLLLLL....SSBBBBBBBBBBBBBBBBBBSS....LLLLLLLLLLLL.....
.....LLLLLLLLLLLL....SSSBBBBBBBBBBBBBBBBSSS....LLLLLLLLLLLL.....
.....LLLLLLLLLLLL....SSSSSBBBBBBBBBBBBSSSSS....LLLLLLLLLLLL.....
.....LLLLLLLLLLLL....SSSSSSSSSSSSSSSSSSSSSS....LLLLLLLLLLLL.....
.....LLLLLLLLLLLLL...SSSSSSSSSSSSSSSSSSSSSS...LLLLLLLLLLLLL.....
.....LLLLLLLLLLLLL....SSSSSSSSSSSSSSSSSSSS....LLLLLLLLLLLLL.....
.....LLLLLLLLLLLLL....SSSSSSSSSSSSSSSSSSSS....LLLLLLLLLLLLL.....
....LLLLLLLLLLLLLL.....SSSSSSSSSSSSSSSSSS.....LLLLLLLLLLLLLL....
....LLLLLLLLLLLLLL.....SSSSSSSSSSSSSSSSSS.....LLLLLLLLLLLLLL....
.....LLLLLLLLLLLL.......SSSSSSSSSSSSSSSS.......LLLLLLLLLLLL.....
.....CC..CC..CC..........SSSSSSSSSSSSSS..........CC..CC..CC.....
......C...C...C..........SSSSSSSSSSSSSS..........C...C...C......
.......C...C...C..........SSSSSSSSSSSS..........C...C...C.......
..........................SSSSSSSSSSSS..........................
...........................SSSSSSSSSS...........................
................................................................
................................................................
`;

// ----------------------------------------------------------------------------------- palette

type Rgb = [number, number, number];

interface Palette {
  outline: Rgb;
  /** Noise levels, dark to light. */
  levels: Rgb[];
  /** Optional channel-split alternates for levels (left-facing / right-facing surfaces). */
  splitLeft?: Partial<Record<number, Rgb>>;
  splitRight?: Partial<Record<number, Rgb>>;
  face: Rgb;
  faceScan: Rgb;
  /** CRT glass glint in the corner of the face. */
  glint: Rgb;
  glow1: Rgb;
  glow2: Rgb;
  /** Face light spilling onto the hood rim. */
  spill: Rgb;
  eye: Rgb;
  eyeHot: Rgb;
  eyeDim: Rgb;
  mouth: Rgb;
  mouthHot: Rgb;
  mouthEnd: Rgb;
  claw: Rgb;
  clawShade: Rgb;
  rodLight: Rgb;
  rodDark: Rgb;
  tipLeft: Rgb;
  tipRight: Rgb;
  tipHot: Rgb;
  knob: Rgb;
}

const REGULAR: Palette = {
  outline: [10, 10, 14],
  levels: [
    [16, 17, 24],
    [58, 60, 74],
    [112, 114, 130],
    [174, 176, 190],
    [238, 238, 244],
  ],
  face: [7, 7, 10],
  faceScan: [17, 17, 23],
  glint: [64, 66, 80],
  glow1: [110, 66, 0],
  glow2: [44, 28, 4],
  spill: [255, 160, 30],
  eye: [255, 176, 0],
  eyeHot: [255, 232, 150],
  eyeDim: [120, 72, 0],
  mouth: [255, 176, 0],
  mouthHot: [255, 220, 120],
  mouthEnd: [170, 104, 0],
  claw: [234, 228, 212],
  clawShade: [146, 140, 128],
  rodLight: [200, 200, 210],
  rodDark: [124, 124, 138],
  tipLeft: [160, 160, 174],
  tipRight: [160, 160, 174],
  tipHot: [244, 244, 250],
  knob: [92, 92, 104],
};

const SHINY: Palette = {
  outline: [20, 6, 30],
  levels: [
    [24, 6, 42],
    [84, 22, 122],
    [150, 70, 200],
    [200, 170, 255],
    [246, 242, 255],
  ],
  splitLeft: { 2: [226, 40, 170], 3: [255, 128, 222] },
  splitRight: { 2: [30, 190, 232], 3: [130, 240, 255] },
  face: [10, 3, 18],
  faceScan: [20, 8, 32],
  glint: [84, 52, 128],
  glow1: [30, 120, 150],
  glow2: [18, 44, 66],
  spill: [90, 230, 255],
  eye: [255, 255, 255],
  eyeHot: [255, 255, 255],
  eyeDim: [70, 170, 200],
  mouth: [150, 246, 255],
  mouthHot: [255, 255, 255],
  mouthEnd: [50, 160, 205],
  claw: [246, 236, 255],
  clawShade: [160, 128, 204],
  rodLight: [206, 190, 255],
  rodDark: [118, 92, 188],
  tipLeft: [255, 70, 206],
  tipRight: [60, 226, 255],
  tipHot: [255, 255, 255],
  knob: [96, 60, 150],
};

// ------------------------------------------------------------------------------- animation

const N_FRAMES = 6;
/** Shown on the preview card (the registry name is set in scripts/static-species.ts). */
const SPECIES_NAME = 'THE STATIC';
/** Frame delays in GIF centiseconds: the last frame is a short signal drop. */
const DELAYS_CS = [10, 10, 10, 10, 10, 6];
/** Eye state per frame. */
const EYES: ('on' | 'hot' | 'dim' | 'off')[] = ['on', 'hot', 'on', 'on', 'on', 'off'];
/** Mouth: 'on', 'blip' (a square-wave bump in the scanline), 'dim'. */
const MOUTH: ('on' | 'blip' | 'dim')[] = ['on', 'on', 'blip', 'on', 'on', 'dim'];
/** Horizontal sync tears per frame: [firstRow, rows, dx]. */
const TEARS: [number, number, number][][] = [[], [], [], [[33, 2, 2]], [], [[42, 2, -2]]];
/** Rolling brighter band (vertical hold drift), first row per frame. */
const ROLL_Y = [14, 22, 30, 38, 46, 54];

/** Static strength: random spread added to the shaded value before quantizing (0 = smooth). */
const NOISE = 0.7;
/** Value thresholds between the noise levels, dark to light (wide ends = more black and white). */
const THRESHOLDS = [0.24, 0.42, 0.58, 0.76];
/** Shading contrast around mid grey. */
const CONTRAST = 1.3;
/** Shade the hood as its own dome (reads as a helmet) or as part of the body mass. */
const HOOD_DOME = false;
/** The hood's dark contour starts this many rows above the mouth (the top merges into the hump). */
const HOOD_CONTOUR_ABOVE_MOUTH = 4;
/** How much of the face light tints the hood pixels touching the face (0..1). */
const SPILL = 0.1;
/** Edge crackle: chance per empty edge pixel (rows above CRACKLE_ROWS) to fizz with static. */
const CRACKLE = 0.09;
const CRACKLE_ROWS = 40;
/** Light direction (from top-left, towards the viewer). */
const LIGHT = norm3([-0.55, -0.75, 0.6]);

// ------------------------------------------------------------------------------------ setup

const W = 64;
const H = 64;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/beasts/static-species');

function norm3(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function parseGrid(src: string): string[] {
  const rows = src.split('\n').filter((r) => r.length > 0);
  if (rows.length !== H) throw new Error(`grid: expected ${H} rows, got ${rows.length}`);
  rows.forEach((r, y) => {
    if (r.length !== W) throw new Error(`grid row ${y}: expected ${W} chars, got ${r.length}`);
    if (!/^[.BLHSdFREMmCATNo]+$/.test(r)) throw new Error(`grid row ${y}: unknown char in "${r}"`);
  });
  return rows;
}

const grid = parseGrid(GRID);
const at = (x: number, y: number): string => (x < 0 || y < 0 || x >= W || y >= H ? '.' : grid[y][x]);

/** Seeded PRNG (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --------------------------------------------------------------------------------- shading

const FACE_CHARS = new Set(['F', 'E', 'M', 'm', 'R']);
const isHead = (c: string) => c === 'H' || FACE_CHARS.has(c);
const isBodyish = (c: string) => c === 'B' || c === 'S' || c === 'd' || c === 'L' || isHead(c);

/** Chamfer distance (3-4) to the nearest pixel outside `inside`, in pixels. */
function distance(inside: (x: number, y: number) => boolean): Float32Array {
  const d = new Float32Array(W * H);
  const INF = 1e9;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = inside(x, y) ? INF : 0;
  const get = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : d[y * W + x]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i], get(x - 1, y) + 3, get(x, y - 1) + 3, get(x - 1, y - 1) + 4, get(x + 1, y - 1) + 4);
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(d[i], get(x + 1, y) + 3, get(x, y + 1) + 3, get(x + 1, y + 1) + 4, get(x - 1, y + 1) + 4);
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

interface Shade {
  /** Brightness 0..1 per pixel (noise parts only). */
  v: Float32Array;
  /** Surface normal x component (for the shiny channel split). */
  nx: Float32Array;
}

function computeShade(): Shade {
  const dBody = distance((x, y) => isBodyish(at(x, y)) && at(x, y) !== 'S');
  const dArm = distance((x, y) => at(x, y) === 'L');
  const dHead = distance((x, y) => isHead(at(x, y)));
  const v = new Float32Array(W * H);
  const nxs = new Float32Array(W * H);
  const height = (d: Float32Array, r: number) => (x: number, y: number) => {
    const xx = Math.max(0, Math.min(W - 1, x));
    const yy = Math.max(0, Math.min(H - 1, y));
    return Math.sqrt(Math.min(d[yy * W + xx], r) / r);
  };
  const hBody = height(dBody, 9);
  const hArm = height(dArm, 5);
  const hHead = height(dHead, 6);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = at(x, y);
      let h: (x: number, y: number) => number;
      let bias: number;
      let k: number;
      if (c === 'B' || c === 'S' || c === 'd') {
        h = hBody;
        bias = 0.03;
        k = 7;
      } else if (c === 'L') {
        h = hArm;
        bias = 0.06;
        k = 4;
      } else if (c === 'H') {
        h = HOOD_DOME ? hHead : hBody;
        bias = 0.02;
        k = HOOD_DOME ? 5 : 7;
      } else continue;
      const gx = (h(x + 1, y) - h(x - 1, y)) / 2;
      const gy = (h(x, y + 1) - h(x, y - 1)) / 2;
      const n = norm3([-gx * k, -gy * k, 1]);
      const diffuse = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
      let s = 0.08 + 0.92 * diffuse + bias;
      // Lower is darker (the light comes from above the screen).
      s *= 1 - 0.3 * (y / H);
      // Contact shadow: below / right of a part that sits higher in the stack.
      const z = zOf(c);
      for (const [dx, dy, amt] of [
        [0, -1, 0.16],
        [-1, -1, 0.1],
        [0, -2, 0.06],
        [-1, 0, 0.06],
      ] as const) {
        if (zOf(at(x + dx, y + dy)) > z) s -= amt;
      }
      s = (s - 0.5) * CONTRAST + 0.5;
      if (c === 'd') s = 0.04; // crease
      v[y * W + x] = Math.max(0, Math.min(1, s));
      nxs[y * W + x] = n[0];
    }
  }
  return { v, nx: nxs };
}

function zOf(c: string): number {
  switch (c) {
    case 'B':
    case 'S':
    case 'd':
      return 1;
    case 'L':
      return 2;
    case 'H':
    case 'F':
    case 'R':
    case 'E':
    case 'M':
    case 'm':
      return 3;
    case 'C':
      return 4;
    case 'A':
    case 'T':
    case 'N':
      return 5;
    default:
      return 0;
  }
}

const SHADE = computeShade();

// ---------------------------------------------------------------------------------- render

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((k) => Math.round(a[k] * (1 - t) + b[k] * t)) as Rgb;

function nearFace(x: number, y: number): boolean {
  return [at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)].some((c) => FACE_CHARS.has(c));
}

type Px = Rgb | null;

/** Distance (Manhattan, up to 2) from each face pixel to the nearest eye / mouth pixel. */
function glowDistance(lit: (x: number, y: number) => boolean): Uint8Array {
  const d = new Uint8Array(W * H).fill(9);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!lit(x, y)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const r = Math.abs(dx) + Math.abs(dy);
          const i = yy * W + xx;
          if (r < d[i]) d[i] = r;
        }
      }
    }
  }
  return d;
}

function renderFrame(pal: Palette, frame: number): Px[] {
  const rnd = prng(0x57a71c + frame * 7919 + (pal === SHINY ? 104729 : 0));
  const px: Px[] = new Array(W * H).fill(null);
  const solid = new Uint8Array(W * H);

  // 1. Dissolve streaks: each row of the S zone gets random horizontal runs, sparser lower down.
  const sRows: { y: number; x0: number; x1: number }[] = [];
  for (let y = 0; y < H; y++) {
    let x0 = -1;
    let x1 = -1;
    for (let x = 0; x < W; x++) {
      if (at(x, y) === 'S') {
        if (x0 < 0) x0 = x;
        x1 = x;
      }
    }
    if (x0 >= 0) sRows.push({ y, x0, x1 });
  }
  const sTop = sRows.length ? sRows[0].y : 0;
  const sBot = sRows.length ? sRows[sRows.length - 1].y : 0;
  const streak = new Uint8Array(W * H);
  for (const { y, x0, x1 } of sRows) {
    const t = (y - sTop) / Math.max(1, sBot - sTop);
    // Lower down the signal breaks into separate scanlines: odd rows drop out.
    if (t > 0.2 && (y - sTop) % 2 === 1) continue;
    let x = x0 - Math.floor(rnd() * 3);
    let on = rnd() < 0.7;
    while (x <= x1) {
      const run = on ? 2 + Math.floor(rnd() * (2 + 9 * (1 - t))) : 1 + Math.floor(rnd() * (1 + 6 * t));
      if (on) for (let k = 0; k < run; k++) if (at(x + k, y) === 'S') streak[y * W + x + k] = 1;
      x += run;
      on = !on;
    }
  }

  // 2. Base pixels.
  const glowEyes = glowDistance((x, y) => at(x, y) === 'E');
  const eyes = EYES[frame];
  const mouth = MOUTH[frame];
  const roll = ROLL_Y[frame];
  const mouthRow = grid.findIndex((r) => r.includes('M'));
  const mouthX0 = grid[mouthRow].indexOf('M');
  const mouthX1 = grid[mouthRow].lastIndexOf('M');
  const blipX0 = Math.round((mouthX0 + mouthX1) / 2) - 1;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = at(x, y);
      if (c === '.') continue;
      if (c === 'S' && !streak[i]) continue;
      solid[i] = 1;
      if (c === 'B' || c === 'S' || c === 'd' || c === 'L' || c === 'H') {
        let s = SHADE.v[i];
        if (c === 'S') s = 0.3 + 0.45 * rnd() - 0.25 * ((y - sTop) / Math.max(1, sBot - sTop));
        if (y % 2 === 1) s *= 0.86; // scanlines
        if (y >= roll && y < roll + 3) s = Math.min(1, s + 0.18); // rolling bar
        const v = s + (rnd() - 0.5) * NOISE;
        let lvl = 0;
        while (lvl < THRESHOLDS.length && v >= THRESHOLDS[lvl]) lvl++;
        let col = pal.levels[lvl];
        const nx = SHADE.nx[i];
        if (pal.splitLeft && pal.splitRight && (pal.splitLeft[lvl] || pal.splitRight[lvl])) {
          const pLeft = Math.max(0.12, Math.min(0.88, 0.5 - nx * 1.6));
          col = (rnd() < pLeft ? pal.splitLeft[lvl] : pal.splitRight[lvl]) ?? col;
        }
        // Light from the face spills onto the rim of the hood.
        if (c === 'H' && nearFace(x, y)) col = mix(col, pal.spill, SPILL);
        px[i] = col;
      } else if (c === 'F') {
        // Eyes glow onto their 4-neighbours; the mouth stays a crisp scanline.
        const g = eyes === 'off' || eyes === 'dim' ? 9 : glowEyes[i];
        px[i] = g === 1 ? pal.glow2 : y % 2 === 0 ? pal.faceScan : pal.face;
      } else if (c === 'R') {
        px[i] = pal.glint;
      } else if (c === 'E') {
        const topLeft = at(x - 1, y) !== 'E' && at(x, y - 1) !== 'E';
        if (eyes === 'off') px[i] = pal.eyeDim;
        else if (eyes === 'dim') px[i] = pal.glow1;
        else px[i] = (eyes === 'hot' || topLeft) && rnd() < (eyes === 'hot' ? 1 : 0.7) ? pal.eyeHot : pal.eye;
      } else if (c === 'M' || c === 'm') {
        const center = Math.abs(x - (mouthX0 + mouthX1) / 2) <= 2;
        let col = c === 'm' ? pal.mouthEnd : center ? pal.mouthHot : pal.mouth;
        if (mouth === 'dim') col = c === 'm' ? pal.glow1 : pal.mouthEnd;
        px[i] = col;
      } else if (c === 'C') {
        px[i] = at(x, y + 1) === 'C' && at(x - 1, y) !== 'C' ? pal.claw : pal.clawShade;
        if (at(x, y - 1) !== 'C') px[i] = pal.claw;
      } else if (c === 'A') {
        px[i] = (x + y) % 3 === 0 ? pal.rodDark : pal.rodLight;
      } else if (c === 'T') {
        const left = x < W / 2;
        const hot = at(x - 1, y) !== 'T' && at(x, y - 1) !== 'T' && at(x + 1, y) === 'T';
        px[i] = hot ? pal.tipHot : left ? pal.tipLeft : pal.tipRight;
      } else if (c === 'N') {
        px[i] = at(x, y - 1) === '.' ? pal.rodLight : pal.knob;
      } else if (c === 'o') {
        px[i] = pal.outline;
      }
    }
  }

  // Mouth blip: a 4 px segment of the scanline steps up one row (oscilloscope bump).
  if (mouth === 'blip') {
    for (let k = 0; k < 4; k++) {
      const x = blipX0 + k;
      const lo = mouthRow * W + x;
      const hi = (mouthRow - 1) * W + x;
      px[hi] = k === 0 || k === 3 ? pal.mouth : pal.mouthHot;
      px[lo] = pal.glow1;
    }
  }

  // Edge crackle: the silhouette fizzes, a few empty pixels along the upper edges become static.
  const crackle: number[] = [];
  for (let y = 0; y < CRACKLE_ROWS; y++) {
    for (let x = 0; x < W; x++) {
      if (at(x, y) !== '.') continue;
      const touches = [at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)].some((n) => n === 'B' || n === 'L' || n === 'H');
      if (touches && rnd() < CRACKLE) crackle.push(y * W + x);
    }
  }
  for (const i of crackle) {
    solid[i] = 1;
    px[i] = pal.levels[1 + Math.floor(rnd() * (pal.levels.length - 1))];
  }

  // 3. Internal contour: an edge pixel of a higher part next to a lower (non-empty) part.
  const contour = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = at(x, y);
      const z = zOf(c);
      if (c !== 'L' && c !== 'H') continue;
      if (c === 'H' && y < mouthRow - HOOD_CONTOUR_ABOVE_MOUTH) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const n = at(x + dx, y + dy);
        const zn = zOf(n);
        if (zn > 0 && zn < z && !(n === 'S' && !streak[(y + dy) * W + x + dx])) contour[y * W + x] = 1;
      }
    }
  }
  for (let i = 0; i < W * H; i++) if (contour[i]) px[i] = pal.outline;

  // 4. Outer outline: empty pixels 4-adjacent to a solid pixel (streaks in the lower dissolve
  // band only get an outline on their upper rows, so the bottom stays ragged).
  const outlineStop = sTop + Math.round((sBot - sTop) * 0.35);
  const out = px.slice();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (solid[i]) continue;
      let hit = false;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx;
        if (!solid[j]) continue;
        if (at(xx, yy) === 'S' && yy > outlineStop) continue;
        hit = true;
      }
      if (hit) out[i] = pal.outline;
    }
  }

  // 5. Tears: shift whole rows sideways.
  for (const [y0, n, dx] of TEARS[frame]) {
    for (let y = y0; y < y0 + n; y++) {
      const row = out.slice(y * W, y * W + W);
      for (let x = 0; x < W; x++) {
        const sx = x - dx;
        out[y * W + x] = sx >= 0 && sx < W ? row[sx] : null;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------- encode

function toRgba(px: Px[]): Uint8Array {
  const data = new Uint8Array(W * H * 4);
  px.forEach((c, i) => {
    if (!c) return;
    data[i * 4] = c[0];
    data[i * 4 + 1] = c[1];
    data[i * 4 + 2] = c[2];
    data[i * 4 + 3] = 255;
  });
  return data;
}

function encodePng(w: number, h: number, data: Uint8Array): Buffer {
  const png = new PNG({ width: w, height: h, colorType: 6 });
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return PNG.sync.write(png, { colorType: 6, deflateLevel: 9 });
}

/** Animated GIF, global palette, index 0 transparent, full frames restored to background. */
function encodeGif(frames: Px[][]): Buffer {
  const key = (c: Rgb) => (c[0] << 16) | (c[1] << 8) | c[2];
  const colors = new Map<number, number>();
  for (const f of frames) for (const c of f) if (c && !colors.has(key(c))) colors.set(key(c), colors.size + 1);
  if (colors.size > 255) throw new Error(`gif: ${colors.size} colours (max 255)`);
  let size = 2;
  while (size < colors.size + 1) size *= 2;
  const palette = new Array<number>(size).fill(0);
  for (const [c, i] of colors) palette[i] = c;
  const buf = new Uint8Array(64 * 1024 + frames.length * W * H * 2);
  const gw = new GifWriter(buf, W, H, { palette, loop: 0 });
  for (const [k, f] of frames.entries()) {
    const idx = new Uint8Array(W * H);
    f.forEach((c, i) => {
      if (c) idx[i] = colors.get(key(c)) as number;
    });
    gw.addFrame(0, 0, W, H, idx, { delay: DELAYS_CS[k % DELAYS_CS.length], disposal: 2, transparent: 0 });
  }
  return Buffer.from(buf.slice(0, gw.end()));
}

// --------------------------------------------------------------------------------- preview

/** Draw art at any scale (nearest neighbour, like CSS `image-rendering: pixelated`). */
function blitArt(c: Canvas, px: Px[], x: number, y: number, size: number, bg?: Rgb): void {
  if (bg) c.rect(x, y, size, size, bg);
  for (let yy = 0; yy < size; yy++) {
    for (let xx = 0; xx < size; xx++) {
      const p = px[Math.floor((yy * H) / size) * W + Math.floor((xx * W) / size)];
      if (p) c.set(x + xx, y + yy, p);
    }
  }
}

/** A simplified beasts.app card: gold frame, dark pin-stripe panel, black art box (art at 160 px). */
function card(c: Canvas, px: Px[], x: number, y: number, shiny: boolean): void {
  const CW = 250;
  const CH = 350;
  for (let yy = 0; yy < CH; yy++) {
    const t = yy / CH;
    const gold: Rgb = [Math.round(229 - 90 * t), Math.round(216 - 107 * t), Math.round(178 - 119 * t)];
    c.rect(x, y + yy, CW, 1, gold);
  }
  c.rect(x + 7, y + 7, CW - 14, CH - 14, [27, 27, 31]);
  for (let yy = 0; yy < CH - 14; yy += 6) c.rect(x + 7, y + 7 + yy, CW - 14, 3, [36, 36, 40]);
  const name = SPECIES_NAME;
  c.text(name, x + Math.round((CW - name.length * 12) / 2), y + 22, 3, [255, 255, 255]);
  c.rect(x + 15, y + 54, 220, 170, [0, 0, 0]);
  blitArt(c, px, x + 45, y + 59, 160);
  if (shiny) c.text('SHINY', x + CW - 15 - 5 * 8, y + 232, 2, [255, 128, 222]);
  const stat = (label: string, value: string, sx: number) => {
    c.rect(x + sx, y + 254, 68, 40, [40, 40, 46]);
    c.text(label, x + sx + Math.round((68 - label.length * 8) / 2), y + 260, 2, [201, 201, 209]);
    c.text(value, x + sx + Math.round((68 - value.length * 8) / 2), y + 276, 2, [255, 255, 255]);
  };
  stat('TIER', '1', 15);
  stat('LEVEL', '1', 91);
  stat('TYPE', 'MAGIC', 167);
}

function preview(reg: Px[][], shiny: Px[][]): Buffer {
  const G = 16;
  const L = 18; // label strip
  const BLACK: Rgb = [0, 0, 0];
  const LIGHT: Rgb = [229, 216, 178]; // beasts.app card gold (light end of its gradient)
  const INK: Rgb = [210, 210, 220];
  const w = G + 512 + G + 512 + G;
  const row2 = G + L + 512 + G;
  const row3 = row2 + L + 350 + G;
  const row4 = row3 + L + 128 + G;
  const h = row4 + L + 128 + G;
  const c = new Canvas(w, h, [44, 44, 50]);
  // Row 1: 8x on black.
  c.text('REGULAR  8X', G, G, 2, INK);
  c.text('SHINY  8X', G + 512 + G, G, 2, INK);
  blitArt(c, reg[0], G, G + L, 512, BLACK);
  blitArt(c, shiny[0], G + 512 + G, G + L, 512, BLACK);
  // Row 2: 4x on the light card colour, then the beasts.app card mock-ups.
  const gap = Math.floor((w - 2 * 256 - 2 * 250) / 5);
  c.text('4X ON LIGHT', gap, row2, 2, INK);
  c.text('BEASTS-APP CARD  ART 64 TO 160 PX', gap * 3 + 512, row2, 2, INK);
  blitArt(c, reg[0], gap, row2 + L, 256, LIGHT);
  blitArt(c, shiny[0], gap * 2 + 256, row2 + L, 256, LIGHT);
  card(c, reg[0], gap * 3 + 512, row2 + L, false);
  card(c, shiny[0], gap * 4 + 512 + 250, row2 + L, true);
  // Rows 3-4: every animation frame at 2x, with its delay.
  const fgap = Math.floor((w - N_FRAMES * 128) / (N_FRAMES + 1));
  c.text(`GIF FRAMES  ${DELAYS_CS.map((d) => d * 10).join(' ')} MS`, fgap, row3, 2, INK);
  c.text('SHINY GIF FRAMES', fgap, row4, 2, INK);
  for (let f = 0; f < N_FRAMES; f++) {
    blitArt(c, reg[f], fgap + f * (128 + fgap), row3 + L, 128, BLACK);
    blitArt(c, shiny[f], fgap + f * (128 + fgap), row4 + L, 128, BLACK);
  }
  return c.toPng();
}

// ------------------------------------------------------------------------------------ main

function main(): void {
  mkdirSync(OUT, { recursive: true });
  const reg = Array.from({ length: N_FRAMES }, (_, f) => renderFrame(REGULAR, f));
  const shiny = Array.from({ length: N_FRAMES }, (_, f) => renderFrame(SHINY, f));
  const files: Record<string, Buffer> = {
    'static_regular.png': encodePng(W, H, toRgba(reg[0])),
    'static_shiny.png': encodePng(W, H, toRgba(shiny[0])),
    'static_regular.gif': encodeGif(reg),
    'static_shiny.gif': encodeGif(shiny),
    'preview.png': preview(reg, shiny),
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(OUT, name), bytes);

  // beasts.app sends each art as a base64 data URI, the same URI in the png_* and gif_* slots,
  // and caps 2 * (len(regular) + len(shiny)) at 57600 characters.
  const uri = (b: Buffer, mime: string) => `data:${mime};base64,${b.toString('base64')}`;
  const r = uri(files['static_regular.gif'], 'image/gif').length;
  const s = uri(files['static_shiny.gif'], 'image/gif').length;
  const total = 2 * (r + s);
  for (const [name, bytes] of Object.entries(files)) console.log(`${name.padEnd(20)} ${String(bytes.length).padStart(7)} bytes`);
  console.log(`onchain art (beasts.app encoding): 2 * (${r} + ${s}) = ${total} / 57600 chars ${total <= 57600 ? 'OK' : 'TOO LARGE'}`);
  if (total > 57600) process.exitCode = 1;
}

main();
