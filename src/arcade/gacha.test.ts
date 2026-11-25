import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Roster, RosterEntry } from '../data/roster.ts';
import {
  drawPrize, isDuplicate, isRarePrize, machine, machineOdds, MACHINES, pct, REFUND_RATE, refundFor, speciesChance, THE_STATIC_ID,
  type MachineId,
} from './gacha.ts';

const real = JSON.parse(readFileSync(new URL('../../public/data/roster.json', import.meta.url), 'utf8')) as Roster;

function entry(speciesId: number, featured: boolean, tier: number, type: 0 | 1 | 2 = 0): RosterEntry {
  return { ...real.entries[0], speciesId, featured, tier, type, name: `S${speciesId}` };
}

/** A small hand-made roster: every pool has members, plus THE STATIC. */
function tiny(withStatic = true): Roster {
  const entries: RosterEntry[] = [
    entry(10001, true, 1), entry(10002, true, 1), entry(10003, true, 2), entry(10004, true, 4),
    entry(1, false, 1), entry(2, false, 2), entry(3, false, 3), entry(4, false, 4), entry(5, false, 5),
  ];
  if (withStatic) entries.push(entry(THE_STATIC_ID, true, 1));
  return { ...real, entries, nFeatured: entries.filter((e) => e.featured).length };
}

/** Deterministic rng over a fixed list of values. */
const seq = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };

/** mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('prices and refunds', () => {
  it('BASIC 100, RARE 300, LEGENDARY 800', () => {
    expect(MACHINES.map((m) => [m.id, m.price])).toEqual([['basic', 100], ['rare', 300], ['legendary', 800]]);
  });
  it('a duplicate pays back a quarter of the price', () => {
    expect(REFUND_RATE).toBe(0.25);
    expect(refundFor('basic')).toBe(25);
    expect(refundFor('rare')).toBe(75);
    expect(refundFor('legendary')).toBe(200);
  });
  it('a duplicate is a species you had, unless it is your first shiny of it', () => {
    expect(isDuplicate({ isNew: true, newShiny: false })).toBe(false);
    expect(isDuplicate({ isNew: false, newShiny: true })).toBe(false);
    expect(isDuplicate({ isNew: false, newShiny: false })).toBe(true);
    expect(isDuplicate({ isNew: true, newShiny: true })).toBe(false);
  });
  it('RARE is 1 in 12 shiny, and rarer machines are shinier', () => {
    expect(machine('rare').shinyOneIn).toBe(12);
    expect(machine('basic').shinyOneIn).toBeGreaterThan(machine('rare').shinyOneIn);
    expect(machine('legendary').shinyOneIn).toBeLessThan(machine('rare').shinyOneIn);
  });
});

describe('odds from the live roster', () => {
  for (const id of ['basic', 'rare', 'legendary'] as MachineId[]) {
    it(`${id}: pool odds sum to 1 and every pool has members`, () => {
      const odds = machineOdds(real, id);
      expect(odds.length).toBeGreaterThan(0);
      expect(sum(odds.map((o) => o.p))).toBeCloseTo(1, 10);
      for (const o of odds) expect(o.members.length).toBeGreaterThan(0);
      // species chances add up to 1 too
      const ids = new Set(odds.flatMap((o) => o.members.map((e) => e.speciesId)));
      expect(sum([...ids].map((s) => speciesChance(odds, s)))).toBeCloseTo(1, 10);
    });
  }

  it('BASIC is mostly tier 3-5 Loot Survivor originals', () => {
    const odds = machineOdds(real, 'basic');
    const low = odds.find((o) => o.pool.id === 'orig-low')!;
    expect(low.p).toBeGreaterThanOrEqual(0.75);
    for (const e of low.members) expect(!e.featured && e.tier >= 3).toBe(true);
  });

  it('RARE holds Art Hackathon species and tier 1-2 only', () => {
    for (const o of machineOdds(real, 'rare')) {
      for (const e of o.members) expect(e.featured || e.tier <= 2).toBe(true);
    }
  });

  it('THE STATIC drops only from LEGENDARY', () => {
    expect(real.entries.some((e) => e.speciesId === THE_STATIC_ID)).toBe(true);
    expect(speciesChance(machineOdds(real, 'basic'), THE_STATIC_ID)).toBe(0);
    expect(speciesChance(machineOdds(real, 'rare'), THE_STATIC_ID)).toBe(0);
    expect(speciesChance(machineOdds(real, 'legendary'), THE_STATIC_ID)).toBeCloseTo(0.08, 10);
  });

  it('LEGENDARY gives the best odds for every tier 1 Art Hackathon species', () => {
    const t1 = real.entries.filter((e) => e.featured && e.tier === 1 && e.speciesId !== THE_STATIC_ID);
    expect(t1.length).toBeGreaterThan(0);
    const [b, r, l] = (['basic', 'rare', 'legendary'] as MachineId[]).map((id) => machineOdds(real, id));
    for (const e of t1) {
      expect(speciesChance(l, e.speciesId)).toBeGreaterThan(speciesChance(r, e.speciesId));
      expect(speciesChance(r, e.speciesId)).toBeGreaterThan(speciesChance(b, e.speciesId));
    }
  });

  it('without THE STATIC in the roster its pool drops out and the rest renormalise', () => {
    const odds = machineOdds(tiny(false), 'legendary');
    expect(odds.some((o) => o.pool.id === 'static')).toBe(false);
    expect(sum(odds.map((o) => o.p))).toBeCloseTo(1, 10);
    expect(odds.find((o) => o.pool.id === 'hack-t1')!.p).toBeCloseTo(62 / 92, 10);
    const withIt = machineOdds(tiny(true), 'legendary');
    expect(withIt.find((o) => o.pool.id === 'static')!.p).toBeCloseTo(0.08, 10);
  });

  it('an empty roster yields no odds and no prize', () => {
    const empty = { ...real, entries: [], nFeatured: 0 };
    expect(machineOdds(empty, 'basic')).toEqual([]);
    expect(drawPrize(empty, 'basic')).toBeNull();
  });
});

describe('drawing a capsule', () => {
  it('the first roll picks the pool, the second the species, the third the shine', () => {
    const r = tiny();
    // legendary pools in order: static .08, hack-t1 .62, hack-rest .18, orig-t1 .12
    const a = drawPrize(r, 'legendary', seq(0.01, 0.5, 0.9))!;
    expect(a.entry.speciesId).toBe(THE_STATIC_ID);
    expect(a.pool.id).toBe('static');
    expect(a.shiny).toBe(false);
    const b = drawPrize(r, 'legendary', seq(0.5, 0.99, 0.1))!;
    expect(b.pool.id).toBe('hack-t1');
    expect(b.entry.speciesId).toBe(10002);
    expect(b.shiny).toBe(true);
    const c = drawPrize(r, 'legendary', seq(0.999999, 0, 0.5))!;
    expect(c.pool.id).toBe('orig-t1');
    expect(c.entry.speciesId).toBe(1);
  });

  it('prizes are marked rare for Art Hackathon, THE STATIC and tier 1-2', () => {
    expect(isRarePrize(entry(10001, true, 4))).toBe(true);
    expect(isRarePrize(entry(7, false, 2))).toBe(true);
    expect(isRarePrize(entry(8, false, 3))).toBe(false);
    expect(drawPrize(tiny(), 'basic', seq(0.1, 0.7, 0.9))!.rare).toBe(false);
  });

  it('20,000 draws land on the stated odds (seeded)', () => {
    const R = rng(42);
    for (const id of ['basic', 'rare', 'legendary'] as MachineId[]) {
      const odds = machineOdds(real, id);
      const members = new Map(odds.map((o) => [o.pool.id, new Set(o.members.map((e) => e.speciesId))]));
      const hits = new Map<string, number>();
      let shiny = 0;
      let strays = 0;
      const N = 20000;
      for (let i = 0; i < N; i++) {
        const p = drawPrize(real, id, R)!;
        hits.set(p.pool.id, (hits.get(p.pool.id) ?? 0) + 1);
        if (p.shiny) shiny++;
        if (!members.get(p.pool.id)?.has(p.entry.speciesId)) strays++;
      }
      expect(strays).toBe(0);
      for (const o of odds) expect(Math.abs((hits.get(o.pool.id) ?? 0) / N - o.p)).toBeLessThan(0.015);
      expect(Math.abs(shiny / N - 1 / machine(id).shinyOneIn)).toBeLessThan(0.01);
    }
  });
});

describe('pct', () => {
  it('formats shares for the odds table', () => {
    expect(pct(0.62)).toBe('62%');
    expect(pct(0.045)).toBe('4.5%');
    expect(pct(0.04)).toBe('4%');
    expect(pct(0.004)).toBe('<1%');
    expect(pct(1)).toBe('100%');
    expect(pct(0)).toBe('0%');
  });
});
