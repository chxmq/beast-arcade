// Beast data pipeline for STATIC.
//
// Reads Beast definitions, genesis token metadata and art straight from the
// Beasts V3 contracts on Starknet Sepolia, computes motion-silhouette masks and
// writes:
//   public/data/roster.json          roster consumed by the game (src/data/roster.ts)
//   public/beasts/<id>.png           frame 0, full colour, original resolution
//   public/beasts/<id>.gif           original GIF bytes (PNG-only art is re-encoded)
//   scripts/out/contact-sheet.png    art | kept pixels | mask + occ, for human review
//
// Usage: npm run beasts   (raw RPC responses are cached in scripts/.cache/)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggrFromKills, computeOcc, encodeMask, type BeastType, type Roster, type RosterEntry } from '../src/data/roster.ts';
import { attr, extractArt, fetchBeasts, type RawBeast } from './lib/chain.ts';
import { decodeGif, decodePng, encodeGif, sniffFormat, type ArtFormat, type DecodedGif } from './lib/gif.ts';
import { computeMask, DEFAULT_PARAMS, type MaskParams, type MaskResult } from './lib/mask.ts';
import { Canvas, encodePng } from './lib/png.ts';
import { CachedRpc } from './lib/rpc.ts';

const RPC_URL = 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10';
const REGISTRY = '0x7f6883b4f901ce25aff2b10c876db8dfff68e61ba93102354816519e7fe1f';
const NFT = '0x2e2f3e29a04f92c2b4e8b91fa846d521aea2a682e490bdf46f18da6d0a8bbe1';

/** Art Hackathon species, in roster order. */
const FEATURED = [
  10011, 10013, 10014, 10023, 10024, 10025, 10026, 10027, 10028, 10029, 10030, 10031, 10032, 10033, 10034, 10035,
  10036, 10037, 10038, 10039, 10040, 10069,
];
/** Original 75 species. */
const COMMON = Array.from({ length: 75 }, (_, i) => i + 1);

/** Per-species mask parameter overrides (tuned by inspecting the contact sheet). */
const OVERRIDES: Record<number, Partial<MaskParams>> = {
  // Doodle on cream paper inside a sparkly blue frame: take the figure (head,
  // body, bone) and drop the frame, the handwriting column and the lower doodles.
  10029: {
    roi: [14, 1, 44, 39],
    bgTolerance: 40,
    note: 'doodle on paper inside a frame: silhouette is the stick figure only (manual ROI)',
  },
  // Photo of a pencil sketch on paper with a shadow gradient: local-contrast ink
  // detection around the knight, interior filled.
  10038: {
    roi: [25, 6, 22, 52],
    method: 'local',
    close: 1,
    bgTolerance: 18,
    note: 'photo of a pencil sketch: silhouette approximated from ink lines (manual ROI)',
  },
  // Full-bleed card illustration on a nebula background: the subject is the
  // central hexagon portrait; ornaments, text and halo dots are dropped.
  10040: {
    roi: [19, 17, 29, 31],
    bgTolerance: 48,
    note: 'full-bleed card art: silhouette is the central hexagon portrait (manual ROI)',
  },
  // Originals drawn as sparse / broken outlines: square closing bridges the gaps
  // (radius 1 = 2 px gaps, radius 2 = 4 px) so the body fills.
  5: { close: 1 },
  11: { close: 1 },
  19: { close: 1 },
  30: { close: 2, rayReach: 0.5 },
  38: { close: 2, rayReach: 0.5 },
  // Colossus stands on a bridge under a bar: keep the figure band only.
  52: { roi: [0, 3, 32, 20], close: 1 },
  // Bigfoot stands in checkerboard-dithered foliage and ground: drop the dither.
  72: { dropDither: true },
};

const DESCRIPTION_MAX = 400;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = {
  cache: join(ROOT, 'scripts/.cache'),
  out: join(ROOT, 'scripts/out'),
  beasts: join(ROOT, 'public/beasts'),
  data: join(ROOT, 'public/data'),
};

interface Processed {
  raw: RawBeast;
  featured: boolean;
  format: ArtFormat;
  art: DecodedGif;
  m: MaskResult;
  entry: RosterEntry;
}

function trimDescription(s: string): string {
  const t = s.trim();
  if (t.length <= DESCRIPTION_MAX) return t;
  const cut = t.slice(0, DESCRIPTION_MAX);
  const sp = cut.lastIndexOf(' ');
  return (sp > DESCRIPTION_MAX * 0.7 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

function intAttr(b: RawBeast, name: string, fallback: number): number {
  const v = attr(b.token, name);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function processBeast(b: RawBeast, featured: boolean, boilerplate: string | null): Processed {
  const sid = b.speciesId;
  const arts = extractArt(b.token);
  if (arts.length !== 1) throw new Error(`species ${sid}: expected 1 embedded image, found ${arts.length}`);
  const bytes = arts[0].bytes;
  const format = sniffFormat(bytes);
  if (!format) throw new Error(`species ${sid}: unknown art format (${arts[0].mime})`);
  const art = format === 'gif' ? decodeGif(bytes) : decodePng(bytes);
  const gifBytes = format === 'gif' ? bytes : encodeGif(art.frame0);

  writeFileSync(join(P.beasts, `${sid}.png`), encodePng(art.frame0));
  writeFileSync(join(P.beasts, `${sid}.gif`), gifBytes);

  const m = computeMask(art.frame0, { ...DEFAULT_PARAMS, ...(OVERRIDES[sid] ?? {}) });
  const kills = intAttr(b, 'Adventurers Killed', 0);
  const tokenDesc = b.token.description === boilerplate ? '' : b.token.description;
  const entry: RosterEntry = {
    speciesId: sid,
    name: b.def.name || b.token.name,
    featured,
    type: b.def.beastType as BeastType,
    tier: b.def.tier,
    health: intAttr(b, 'Health', 100),
    level: intAttr(b, 'Level', 1),
    kills,
    aggr: aggrFromKills(kills),
    creator: b.creator,
    owner: b.owner,
    description: trimDescription(b.registryDescription || tokenDesc),
    genesisTokenId: b.genesisTokenId,
    art: `beasts/${sid}.png`,
    gif: `beasts/${sid}.gif`,
    artW: art.frame0.w,
    artH: art.frame0.h,
    frames: art.frames,
    artBox: m.artBox,
    w: m.w,
    h: m.h,
    mask: encodeMask(m.mask, m.w, m.h),
    occ: '0x' + computeOcc(m.mask, m.w, m.h, 1).toString(16),
    maskWarning: m.warning,
  };
  return { raw: b, featured, format, art, m, entry };
}

// ---------------------------------------------------------------- contact sheet

const PANEL = 128;
const GAP = 6;
const CELL_W = PANEL * 3 + GAP * 4;
const CELL_H = 16 + PANEL + 14;

function drawCell(c: Canvas, p: Processed, ox: number, oy: number): void {
  const { art, m, entry } = p;
  const img = art.frame0;
  const warn = entry.maskWarning !== null;
  c.rect(ox, oy, CELL_W, CELL_H, warn ? [70, 24, 24] : p.featured ? [34, 34, 52] : [30, 30, 34]);
  c.text(`${entry.speciesId} ${entry.name}`.slice(0, 44), ox + GAP, oy + 4, 2, p.featured ? [255, 214, 102] : [220, 220, 230]);

  const s = Math.max(1, Math.floor(PANEL / Math.max(img.w, img.h)));
  const py = oy + 16;
  // 1. art with artBox outline
  const ax = ox + GAP;
  c.blitRgba(img, ax, py, s);
  const [bx, by, bw, bh] = m.artBox;
  c.outline(ax + bx * s, py + by * s, bw * s, bh * s, [255, 230, 0]);
  // 2. kept pixels: art with removed pixels dimmed, outside-mask shown in magenta tint
  const kx = ax + PANEL + GAP;
  c.blitRgba(img, kx, py, s);
  for (let y = 0; y < img.h * s; y++) {
    for (let x = 0; x < img.w * s; x++) {
      if (!m.full[Math.floor(y / s) * img.w + Math.floor(x / s)]) c.set(kx + x, py + y, [255, 0, 200], 170);
    }
  }
  // 3. scaled mask (x2) with occupied occ cells tinted
  const mx = kx + PANEL + GAP;
  c.blitMask(m.mask, m.w, m.h, mx, py, 2, [235, 235, 235]);
  const occ = BigInt(entry.occ);
  for (let ly = 0; ly < m.h; ly++) {
    for (let lx = 0; lx < m.w; lx++) {
      const bit = Math.floor((ly * 8) / m.h) * 8 + Math.floor((lx * 8) / m.w);
      if ((occ >> BigInt(bit)) & 1n && !m.mask[ly * m.w + lx]) c.rect(mx + lx * 2, py + ly * 2, 2, 2, [40, 90, 160]);
    }
  }
  c.text(`${m.w}X${m.h}`, mx, py + m.h * 2 + 2, 1, [150, 150, 160]);
  const foot = `${p.format} ${img.w}X${img.h} F${art.frames} ${m.method}${warn ? ' ! ' + (entry.maskWarning ?? '') : ''}`;
  c.text(foot.replace(/[^A-Z0-9 !-]/gi, ' ').slice(0, 96), ox + GAP, oy + 16 + PANEL + 4, 1, warn ? [255, 120, 120] : [150, 150, 160]);
}

function contactSheet(items: Processed[], cols: number): Buffer {
  const rows = Math.ceil(items.length / cols);
  const c = new Canvas(cols * (CELL_W + 4) + 4, rows * (CELL_H + 4) + 4, [12, 12, 14]);
  items.forEach((p, i) => drawCell(c, p, 4 + (i % cols) * (CELL_W + 4), 4 + Math.floor(i / cols) * (CELL_H + 4)));
  return c.toPng();
}

// ------------------------------------------------------------------------ main

async function main(): Promise<void> {
  for (const d of Object.values(P)) mkdirSync(d, { recursive: true });
  const rpc = new CachedRpc({ url: RPC_URL, cacheDir: P.cache });
  const ids = [...FEATURED, ...COMMON];
  const raws = await fetchBeasts(rpc, REGISTRY, NFT, ids);

  // The token JSON description is the collection blurb shared by every species;
  // only keep a token description if it is specific to the species.
  const descCounts = new Map<string, number>();
  for (const r of raws) descCounts.set(r.token.description, (descCounts.get(r.token.description) ?? 0) + 1);
  let boilerplate: string | null = null;
  for (const [d, n] of descCounts) if (n > raws.length / 2) boilerplate = d;

  const featuredSet = new Set(FEATURED);
  const items = raws.map((r) => processBeast(r, featuredSet.has(r.speciesId), boilerplate));
  const entries = items.map((p) => p.entry);
  const nFeatured = entries.filter((e) => e.featured).length;

  const roster: Roster = {
    version: 1,
    generatedAt: new Date().toISOString(),
    network: 'sepolia',
    nft: NFT,
    registry: REGISTRY,
    nFeatured,
    entries,
  };
  // One entry per line: compact but still diffable.
  const { entries: _e, ...header } = roster;
  const json = JSON.stringify(header).replace(/\}$/, ',"entries":[\n') + entries.map((e) => JSON.stringify(e)).join(',\n') + '\n]}\n';
  JSON.parse(json);
  writeFileSync(join(P.data, 'roster.json'), json);
  writeFileSync(join(P.out, 'contact-sheet.png'), contactSheet(items, 4));
  // Smaller pages of the same sheet, easier to inspect at full resolution.
  const PAGE = 24;
  for (let i = 0; i * PAGE < items.length; i++) {
    writeFileSync(join(P.out, `contact-sheet-${i + 1}.png`), contactSheet(items.slice(i * PAGE, (i + 1) * PAGE), 4));
  }
  const reviewed = items.filter((p) => OVERRIDES[p.entry.speciesId] || p.entry.maskWarning);
  if (reviewed.length) writeFileSync(join(P.out, 'contact-sheet-overrides.png'), contactSheet(reviewed, 4));

  console.log(`\nWrote ${entries.length} entries (${nFeatured} featured, ${entries.length - nFeatured} common).`);
  for (const p of items) {
    const e = p.entry;
    const s = p.m.stats;
    console.log(
      `${String(e.speciesId).padStart(5)} ${e.name.padEnd(20)} ${p.format} ${e.artW}x${e.artH} f${e.frames} ` +
        `${p.m.method.padEnd(9)} box ${e.artBox.join(',').padEnd(12)} -> ${e.w}x${e.h} fill ${(s.fill * 100).toFixed(0)}%` +
        `${e.maskWarning ? '  WARN ' + e.maskWarning : ''}`,
    );
  }
  const warned = entries.filter((e) => e.maskWarning);
  console.log(`\n${warned.length} mask warnings.`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
