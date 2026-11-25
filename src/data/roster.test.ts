import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aggrFromKills,
  computeOcc,
  decodeMask,
  dilateMask,
  encodeMask,
  toSimRoster,
  type Roster,
  type RosterEntry,
} from './roster.ts';

function entry(over: Partial<RosterEntry>): RosterEntry {
  const w = over.w ?? 8;
  const h = over.h ?? 8;
  const mask = new Uint8Array(w * h).fill(1);
  return {
    speciesId: 1,
    name: 'Test',
    featured: false,
    type: 0,
    tier: 1,
    health: 100,
    level: 1,
    kills: 0,
    aggr: 0,
    creator: '0x1',
    owner: '0x1',
    description: '',
    genesisTokenId: '0x1',
    art: 'beasts/1.png',
    gif: 'beasts/1.gif',
    artW: 32,
    artH: 32,
    frames: 1,
    artBox: [0, 0, 32, 32],
    w,
    h,
    mask: encodeMask(mask, w, h),
    occ: '0x' + computeOcc(mask, w, h).toString(16),
    maskWarning: null,
    ...over,
  };
}

describe('mask encoding', () => {
  it('round-trips arbitrary masks, including sizes that are not a multiple of 8', () => {
    for (const [w, h] of [
      [1, 1],
      [3, 5],
      [8, 8],
      [13, 7],
      [64, 56],
    ]) {
      const m = new Uint8Array(w * h);
      for (let i = 0; i < m.length; i++) m[i] = (i * 7 + (i >> 3)) % 3 === 0 ? 1 : 0;
      const b64 = encodeMask(m, w, h);
      expect(decodeMask({ mask: b64, w, h })).toEqual(m);
    }
  });

  it('packs row-major, MSB first', () => {
    const m = new Uint8Array(16);
    m[0] = 1; // byte 0 bit 7
    m[9] = 1; // byte 1 bit 6
    expect(atob(encodeMask(m, 4, 4))).toBe(String.fromCharCode(0x80, 0x40));
  });
});

describe('occ', () => {
  it('maps local pixels to cells with integer cx = lx*8/w, cy = ly*8/h', () => {
    const w = 20;
    const h = 12;
    const m = new Uint8Array(w * h);
    m[5 * w + 13] = 1; // lx 13 -> cx 5, ly 5 -> cy 3
    const occ = computeOcc(m, w, h, 0);
    expect(occ).toBe(1n << BigInt(3 * 8 + 5));
  });

  it('dilates by 1 px before binning', () => {
    const w = 16;
    const h = 16;
    const m = new Uint8Array(w * h);
    m[2 * w + 2] = 1; // alone it would only set cell (1,1)
    const occ = computeOcc(m, w, h);
    // dilated to x, y in 1..3; cells are 2 px wide: px 1 -> cell 0, px 2..3 -> cell 1
    const expected = (1n << 0n) | (1n << 1n) | (1n << 8n) | (1n << 9n);
    expect(occ).toBe(expected);
    expect(dilateMask(m, w, h).reduce((a, v) => a + v, 0)).toBe(9);
  });

  it('a full mask sets all 64 bits', () => {
    const m = new Uint8Array(48 * 40).fill(1);
    expect(computeOcc(m, 48, 40)).toBe((1n << 64n) - 1n);
  });

  it('every set mask pixel lands in a set cell', () => {
    const w = 37;
    const h = 29;
    const m = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i += 11) m[i] = 1;
    const occ = computeOcc(m, w, h);
    for (let ly = 0; ly < h; ly++) {
      for (let lx = 0; lx < w; lx++) {
        if (!m[ly * w + lx]) continue;
        const bit = BigInt(Math.floor((ly * 8) / h) * 8 + Math.floor((lx * 8) / w));
        expect((occ >> bit) & 1n).toBe(1n);
      }
    }
  });
});

describe('aggr', () => {
  it('follows SPEC section 3', () => {
    expect([0, 1, 2, 3, 6, 7, 100].map(aggrFromKills)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });
});

describe('toSimRoster', () => {
  const roster: Roster = {
    version: 1,
    generatedAt: '',
    network: 'sepolia',
    nft: '0x0',
    registry: '0x0',
    nFeatured: 2,
    entries: [
      entry({ speciesId: 1, featured: false, type: 1, tier: 2, w: 10, h: 12 }),
      entry({ speciesId: 10011, featured: true, type: 2, tier: 3, kills: 4, aggr: 2 }),
      entry({ speciesId: 2, featured: false, type: 0, tier: 5 }),
      entry({ speciesId: 10013, featured: true, type: 0, tier: 1 }),
    ],
  };

  it('puts featured entries first, preserving relative order, with exactly the sim fields', () => {
    const sim = toSimRoster(roster);
    expect(sim.map((s) => s.tier)).toEqual([3, 1, 2, 5]);
    expect(Object.keys(sim[0]).sort()).toEqual(['aggr', 'h', 'health', 'occ', 'tier', 'type', 'w']);
    expect(sim[0]).toEqual({ type: 2, tier: 3, health: 100, aggr: 2, w: 8, h: 8, occ: (1n << 64n) - 1n });
    expect(typeof sim[2].occ).toBe('bigint');
    expect(sim[2]).toMatchObject({ w: 10, h: 12 });
  });

  it('adds STATIC notoriety to onchain kills when given', () => {
    const sim = toSimRoster(roster, new Map([[10013, 7]]));
    expect(sim.map((s) => s.aggr)).toEqual([2, 3, 0, 0]);
    expect(toSimRoster(roster, { 1: 1 }).map((s) => s.aggr)).toEqual([2, 0, 1, 0]);
  });
});

// Sanity checks on the generated file, when present (run `npm run beasts`).
const ROSTER_PATH = new URL('../../public/data/roster.json', import.meta.url);
describe.runIf(existsSync(ROSTER_PATH))('public/data/roster.json', () => {
  const roster = JSON.parse(readFileSync(ROSTER_PATH, 'utf8')) as Roster;

  it('has the featured (Art Hackathon) entries first, then the 75 Loot Survivor originals', () => {
    const nF = roster.nFeatured;
    expect(nF).toBeGreaterThanOrEqual(22);
    expect(roster.entries).toHaveLength(nF + 75);
    expect(roster.entries.length).toBeLessThanOrEqual(128); // sim/contract caught_mask is u128
    expect(roster.entries.slice(0, nF).every((e) => e.featured)).toBe(true);
    expect(roster.entries.slice(nF).every((e) => !e.featured)).toBe(true);
  });

  it('has valid masks and occ for every entry', () => {
    for (const e of roster.entries) {
      expect(e.w).toBeGreaterThan(0);
      expect(e.w).toBeLessThanOrEqual(64);
      expect(e.h).toBeGreaterThan(0);
      expect(e.h).toBeLessThanOrEqual(56);
      const m = decodeMask(e);
      const n = m.reduce((a, v) => a + v, 0);
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(e.w * e.h);
      expect(BigInt(e.occ)).toBe(computeOcc(m, e.w, e.h));
      expect([0, 1, 2]).toContain(e.type);
      expect(e.tier).toBeGreaterThanOrEqual(1);
      expect(e.tier).toBeLessThanOrEqual(5);
    }
  });
});
