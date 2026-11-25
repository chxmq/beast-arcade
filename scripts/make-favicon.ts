// Builds public/favicon.svg: a real Beast's full-colour art, downscaled to pixel size, on a dark
// rounded cabinet tile with a lit frame. No noise.
//   npx tsx scripts/make-favicon.ts                      writes public/favicon.svg
//   npx tsx scripts/make-favicon.ts --id 10034 --frame hot --preview out.png --dry
//   npx tsx scripts/make-favicon.ts --sheet sheet.png --ids 10032,10034,10036 --dry
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

type RGBA = [number, number, number, number];
type Grid = (RGBA | null)[][];

const N = 32;
const RADIUS = 5;
const FRAME_W = 2;
const ART_MAX = 26;
const COLORS = { gold: [255, 198, 26, 255] as RGBA, hot: [255, 59, 47, 255] as RGBA, cyan: [35, 213, 255, 255] as RGBA };
const TILE: RGBA = [20, 11, 11, 255]; // --cab
const DEFAULT_ID = 61; // Oni: a horned Beast head that still reads at 16 px
const DEFAULT_FRAME: keyof typeof COLORS = 'hot';

interface Entry { speciesId: number; name: string; art: string; artBox: [number, number, number, number] }

const root = new URL('../', import.meta.url);
const roster = JSON.parse(readFileSync(new URL('public/data/roster.json', root), 'utf8')) as { entries: Entry[] };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The art crop, downscaled to fit ART_MAX: a source pixel block becomes opaque when at least
 *  `cover` of it is opaque, and takes the most common opaque colour in the block (keeps the palette). */
function downscale(e: Entry, cover = 0.45): Grid {
  const png = PNG.sync.read(readFileSync(new URL(`public/${e.art}`, root)));
  const [ax, ay, aw, ah] = e.artBox;
  const s = Math.min(1, ART_MAX / Math.max(aw, ah));
  const tw = Math.max(1, Math.round(aw * s));
  const th = Math.max(1, Math.round(ah * s));
  const out: Grid = [];
  for (let ty = 0; ty < th; ty++) {
    const row: (RGBA | null)[] = [];
    for (let tx = 0; tx < tw; tx++) {
      const x0 = ax + Math.floor((tx * aw) / tw), x1 = ax + Math.max(Math.floor((tx * aw) / tw) + 1, Math.floor(((tx + 1) * aw) / tw));
      const y0 = ay + Math.floor((ty * ah) / th), y1 = ay + Math.max(Math.floor((ty * ah) / th) + 1, Math.floor(((ty + 1) * ah) / th));
      const counts = new Map<number, number>();
      let opaque = 0, total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          total++;
          const i = (y * png.width + x) * 4;
          if (png.data[i + 3] < 128) continue;
          opaque++;
          const key = (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2];
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      if (!opaque || opaque / total < cover) { row.push(null); continue; }
      let best = 0, bestN = -1;
      for (const [k, n] of counts) {
        // Ties go to the darker colour, so outlines survive the shrink.
        const lum = ((k >> 16) & 255) + ((k >> 8) & 255) + (k & 255);
        const bl = ((best >> 16) & 255) + ((best >> 8) & 255) + (best & 255);
        if (n > bestN || (n === bestN && lum < bl)) { best = k; bestN = n; }
      }
      row.push([(best >> 16) & 255, (best >> 8) & 255, best & 255, 255]);
    }
    out.push(row);
  }
  return out;
}

/** Inside a rounded rect [x0, x0 + size) with corner radius r, at pixel centres. */
function inRounded(x: number, y: number, x0: number, size: number, r: number): boolean {
  const px = x + 0.5, py = y + 0.5;
  if (px < x0 || py < x0 || px > x0 + size || py > x0 + size) return false;
  const cx = Math.min(Math.max(px, x0 + r), x0 + size - r);
  const cy = Math.min(Math.max(py, x0 + r), x0 + size - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

function compose(art: Grid, frame: RGBA): Grid {
  const g: Grid = [];
  for (let y = 0; y < N; y++) {
    const row: (RGBA | null)[] = [];
    for (let x = 0; x < N; x++) {
      if (!inRounded(x, y, 0, N, RADIUS)) row.push(null);
      else if (!inRounded(x, y, FRAME_W, N - 2 * FRAME_W, RADIUS - FRAME_W)) row.push(frame);
      else row.push(TILE);
    }
    g.push(row);
  }
  const th = art.length, tw = art[0]?.length ?? 0;
  const ox = Math.floor((N - tw) / 2);
  const oy = Math.ceil((N - th) / 2);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) if (art[y][x]) g[oy + y][ox + x] = art[y][x];
  return g;
}

const hex = (c: RGBA) => '#' + c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');

function toSvg(g: Grid): string {
  let rects = '';
  for (let y = 0; y < N; y++) {
    let x = 0;
    while (x < N) {
      const c = g[y][x];
      if (!c) { x++; continue; }
      let w = 1;
      while (x + w < N && g[y][x + w] && hex(g[y][x + w]!) === hex(c)) w++;
      rects += `<rect x="${x}" y="${y}" width="${w}" height="1" fill="${hex(c)}"/>`;
      x += w;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" shape-rendering="crispEdges">${rects}</svg>\n`;
}

/** Paint a grid into a PNG at `scale`, on a backdrop colour; `half` previews the 16 px tab size. */
function paint(png: PNG, g: Grid, ox: number, oy: number, scale: number, half = false) {
  const n = half ? N / 2 : N;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let c: RGBA | null;
      if (!half) c = g[y][x];
      else {
        const px = [g[2 * y][2 * x], g[2 * y][2 * x + 1], g[2 * y + 1][2 * x], g[2 * y + 1][2 * x + 1]];
        const on = px.filter((p): p is RGBA => !!p);
        c = on.length < 2 ? null : ([0, 1, 2].map((k) => Math.round(on.reduce((a, p) => a + p[k], 0) / on.length)).concat(255) as RGBA);
      }
      if (!c) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = ((oy + y * scale + dy) * png.width + ox + x * scale + dx) * 4;
          png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = 255;
        }
      }
    }
  }
}

function blank(w: number, h: number, bg: RGBA): PNG {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) png.data.set(bg, i * 4);
  return png;
}

const entryOf = (id: number) => {
  const e = roster.entries.find((x) => x.speciesId === id);
  if (!e) throw new Error(`species ${id} is not in the roster`);
  return e;
};

const frameName = (arg('frame') ?? DEFAULT_FRAME) as keyof typeof COLORS;
const frame = COLORS[frameName] ?? COLORS[DEFAULT_FRAME];
const sheet = arg('sheet');
if (sheet) {
  // One row per candidate: the 32 px icon at x6, then the 16 px tab size at x12, on a light and a dark tab.
  const ids = (arg('ids') ?? `${DEFAULT_ID}`).split(',').map(Number);
  const frames = (arg('frames') ?? frameName).split(',') as (keyof typeof COLORS)[];
  const rows = ids.flatMap((id) => frames.map((f) => ({ id, f })));
  const png = blank(4 * 200 + 40, rows.length * 200 + 8, [60, 60, 66, 255]);
  rows.forEach(({ id, f }, r) => {
    const g = compose(downscale(entryOf(id)), COLORS[f]);
    const y = r * 200 + 8;
    for (const [col, bg] of [[0, [222, 225, 230, 255]], [2, [32, 33, 36, 255]]] as [number, RGBA][]) {
      const tab = blank(192, 192, bg);
      paint(tab, g, 0, 0, 6);
      PNG.bitblt(tab, png, 0, 0, 192, 192, col * 200 + 8, y);
      const tab2 = blank(192, 192, bg);
      paint(tab2, g, 0, 0, 12, true);
      PNG.bitblt(tab2, png, 0, 0, 192, 192, (col + 1) * 200 + 8, y);
    }
    console.log(`row ${r}: ${entryOf(id).name} (${id}) frame ${f}`);
  });
  writeFileSync(sheet, PNG.sync.write(png));
}

const e = entryOf(Number(arg('id') ?? DEFAULT_ID));
const grid = compose(downscale(e), frame);
const svg = toSvg(grid);
const preview = arg('preview');
if (preview) {
  const png = blank(256, 256, [0, 0, 0, 0]);
  paint(png, grid, 0, 0, 8);
  writeFileSync(preview, PNG.sync.write(png));
}
if (!process.argv.includes('--dry')) writeFileSync(new URL('public/favicon.svg', root), svg);
console.log(`favicon from ${e.name} (${e.speciesId}), ${frameName} frame: ${svg.length} bytes${process.argv.includes('--dry') ? ' (dry run)' : ''}`);
