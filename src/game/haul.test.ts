import { describe, expect, it } from 'vitest';
import { addedSpecies, catchPayout, haulCards, rankedPayout, RANKED_KING, RANKED_PER_CATCH, stripPlan, TICKETS_FOR_KING, TICKETS_PER_CATCH, TICKETS_PER_SHINY } from './haul.ts';
import type { CatchKind } from './ceremony.ts';

describe('haul', () => {
  it('groups catches by species in first-caught order and merges flags', () => {
    const cards = haulCards([
      { speciesId: 7, shiny: false, isNew: true, kind: 'common' },
      { speciesId: 3, shiny: false, isNew: false, kind: 'rare' },
      { speciesId: 7, shiny: true, isNew: false, kind: 'shiny' },
      { speciesId: 9, shiny: false, isNew: true, kind: 'king' },
      { speciesId: 7, shiny: false, isNew: false, kind: 'common' },
    ]);
    expect(cards.map((c) => c.speciesId)).toEqual([7, 3, 9]);
    expect(cards[0]).toEqual({ speciesId: 7, count: 3, shiny: true, isNew: true, king: false });
    expect(cards[1]).toMatchObject({ count: 1, isNew: false, shiny: false });
    expect(cards[2].king).toBe(true);
    expect(haulCards([])).toEqual([]);
  });
  it('finds species added during a hunt', () => {
    expect(addedSpecies(new Set([1, 2]), new Set([1, 2, 5, 8]))).toEqual([5, 8]);
    expect(addedSpecies(new Set([1]), new Set([1]))).toEqual([]);
  });
});

const c = (kind: CatchKind, shiny = kind === 'shiny') => ({ kind, shiny });

describe('ticket payout', () => {
  it('pays 5 a catch, +25 a shiny, +100 for the King', () => {
    const p = catchPayout([c('common'), c('rare'), c('shiny'), c('common')], false);
    expect(p.total).toBe(4 * TICKETS_PER_CATCH + TICKETS_PER_SHINY);
    expect(p).toMatchObject({ catches: 4, shinies: 1, king: false, sweep: false });
    const k = catchPayout([c('common'), c('king')], false);
    expect(k.total).toBe(2 * TICKETS_PER_CATCH + TICKETS_FOR_KING);
    // a shiny King earns both bonuses
    const sk = catchPayout([{ kind: 'king', shiny: true }], false);
    expect(sk.total).toBe(TICKETS_PER_CATCH + TICKETS_PER_SHINY + TICKETS_FOR_KING);
  });

  it('doubles everything for a clean sweep, and the lines add up to the total', () => {
    const all = [...Array.from({ length: 36 }, () => c('common')), c('shiny'), c('shiny'), c('rare'), c('king')];
    const p = catchPayout(all, true);
    expect(p.subtotal).toBe(40 * 5 + 2 * 25 + 100);
    expect(p.total).toBe(p.subtotal * 2);
    expect(p.sweep).toBe(true);
    expect(p.lines.reduce((a, l) => a + l.tickets, 0)).toBe(p.total);
    expect(p.lines.at(-1)?.label).toMatch(/CLEAN SWEEP/);
    expect(catchPayout(all, false).lines.reduce((a, l) => a + l.tickets, 0)).toBe(p.subtotal);
  });

  it('pays nothing for nothing, even on a "sweep"', () => {
    expect(catchPayout([], false)).toMatchObject({ total: 0, lines: [] });
    expect(catchPayout([], true)).toMatchObject({ total: 0, sweep: false, lines: [] });
  });

  it('the strip prints every ticket in a bounded number of stubs', () => {
    expect(stripPlan(0)).toEqual({ stubs: 0, per: 0 });
    for (const total of [5, 10, 35, 120, 455, 900, 3]) {
      const s = stripPlan(total);
      expect(s.stubs * s.per).toBeGreaterThanOrEqual(total);
      expect((s.stubs - 1) * s.per).toBeLessThan(total);
      expect(s.stubs).toBeLessThanOrEqual(24);
      expect(s.per % 5).toBe(0);
    }
    expect(stripPlan(35)).toEqual({ stubs: 7, per: 5 });
  });
});

describe('ranked (HUMAN EYES) payout', () => {
  it('pays 10 a catch, +100 for the King, x2 for a clean sweep', () => {
    expect(rankedPayout(0, false, false)).toMatchObject({ total: 0, lines: [] });
    expect(rankedPayout(7, false, false).total).toBe(7 * RANKED_PER_CATCH);
    expect(rankedPayout(12, true, false).total).toBe(12 * RANKED_PER_CATCH + RANKED_KING);
    const sweep = rankedPayout(40, true, true);
    expect(sweep.total).toBe((40 * RANKED_PER_CATCH + RANKED_KING) * 2);
    expect(sweep.lines.reduce((a, l) => a + l.tickets, 0)).toBe(sweep.total);
    // nothing caught pays nothing, whatever the flags say
    expect(rankedPayout(0, true, true).total).toBe(0);
  });
});
