import { describe, expect, it } from 'vitest';
import {
  catchesForLevel, Collection, dailyGoalFor, dateKey, GOALS, KEY, levelTitle, migrateLegacy, normalizeState, progressAfter,
  tunerLevel, type StorageLike,
} from './collection.ts';

class MemStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
}

const day = (s: string) => () => new Date(`${s}T12:00:00`);

describe('tuner level', () => {
  it('thresholds grow and level is monotonic in catches', () => {
    expect([1, 2, 3, 4, 5, 6].map(catchesForLevel)).toEqual([0, 5, 15, 30, 50, 75]);
    let last = 0;
    for (let n = 0; n < 600; n++) {
      const l = tunerLevel(n).level;
      expect(l).toBeGreaterThanOrEqual(last);
      last = l;
    }
  });
  it('0 catches is level 1, a boundary lands on the new level', () => {
    expect(tunerLevel(0)).toMatchObject({ level: 1, title: 'Snow Watcher', base: 0, next: 5, frac: 0 });
    expect(tunerLevel(4).level).toBe(1);
    expect(tunerLevel(5).level).toBe(2);
    expect(tunerLevel(15).level).toBe(3);
    expect(tunerLevel(15).frac).toBe(0);
    expect(tunerLevel(22).frac).toBeCloseTo(7 / 15);
  });
  it('titles advance and cap at Channel Master', () => {
    expect([1, 2, 3, 5, 7, 9, 12, 40].map(levelTitle)).toEqual([
      'Snow Watcher', 'Snow Watcher', 'Dial Turner', 'Signal Seeker', 'Tuner', 'Static Veteran', 'Channel Master', 'Channel Master',
    ]);
  });
  it('ignores negative and fractional input', () => {
    expect(tunerLevel(-3).level).toBe(1);
    expect(tunerLevel(5.9).level).toBe(2);
  });
});

describe('daily goal', () => {
  it('picks the same goal for the same date and varies across dates', () => {
    expect(dailyGoalFor('2026-11-18')).toBe(dailyGoalFor('2026-11-18'));
    const ids = new Set<string>();
    for (let d = 1; d <= 60; d++) ids.add(dailyGoalFor(`2026-12-${String(d).padStart(2, '0')}`).id);
    expect(ids.size).toBeGreaterThan(3);
    for (const id of ids) expect(GOALS.some((g) => g.id === id)).toBe(true);
  });
  it('dateKey is local YYYY-MM-DD', () => {
    expect(dateKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
  it('catch goals add up and cap, combo goals keep the best', () => {
    const hunters = GOALS.find((g) => g.id === 'hunters3')!;
    let p = 0;
    p = progressAfter(hunters, p, { kind: 'catch', type: 0, rare: false });
    expect(p).toBe(0);
    for (let i = 0; i < 5; i++) p = progressAfter(hunters, p, { kind: 'catch', type: 1, rare: false });
    expect(p).toBe(3);
    const rare = GOALS.find((g) => g.id === 'rare1')!;
    expect(progressAfter(rare, 0, { kind: 'catch', type: 1, rare: false })).toBe(0);
    expect(progressAfter(rare, 0, { kind: 'catch', type: 1, rare: true })).toBe(1);
    const combo = GOALS.find((g) => g.id === 'combo15')!;
    expect(progressAfter(combo, 4, { kind: 'combo', n: 9 })).toBe(9);
    expect(progressAfter(combo, 9, { kind: 'combo', n: 3 })).toBe(9);
    expect(progressAfter(combo, 9, { kind: 'catch', type: 1, rare: true })).toBe(9);
    expect(progressAfter(combo, 9, { kind: 'combo', n: 99 })).toBe(15);
  });
  it('completes once, resets on a new date', () => {
    const st = new MemStorage();
    const date = '2026-11-18';
    const c = new Collection(st, day(date));
    const goal = dailyGoalFor(date);
    expect(c.daily()).toMatchObject({ progress: 0, done: false });
    let doneCount = 0;
    for (let i = 0; i < 80; i++) {
      // feed every kind of event so any goal can complete
      if (goal.kind === 'combo') { if (c.combo(i + 1)) doneCount++; }
      else if (c.catch(1000 + i, { type: goal.type ?? 0, shiny: false, rare: true }).goalDone) doneCount++;
    }
    expect(doneCount).toBe(1);
    expect(c.daily().done).toBe(true);
    const next = new Collection(st, day('2026-11-19'));
    expect(next.daily()).toMatchObject({ progress: 0, done: false });
  });
});

describe('collection', () => {
  it('records seen, first catch, repeat catch and shiny', () => {
    const c = new Collection(new MemStorage(), day('2026-11-18'));
    expect(c.isSeen(5)).toBe(false);
    c.seen(5);
    expect(c.isSeen(5)).toBe(true);
    expect(c.isCaught(5)).toBe(false);
    const a = c.catch(5, { type: 1, shiny: false, rare: false, now: 1000 });
    expect(a).toMatchObject({ isNew: true, newShiny: false });
    expect(c.state.species[5]).toMatchObject({ seen: 1, caught: 1, shiny: 0, firstCaught: 1000 });
    const b = c.catch(5, { type: 1, shiny: true, rare: false, now: 2000 });
    expect(b).toMatchObject({ isNew: false, newShiny: true });
    const d = c.catch(5, { type: 1, shiny: true, rare: false });
    expect(d).toMatchObject({ isNew: false, newShiny: false });
    expect(c.state.species[5]).toMatchObject({ caught: 3, shiny: 2, firstCaught: 1000 });
    expect(c.state.stats.catches).toBe(3);
    expect(c.distinctCaught()).toBe(1);
    expect([...c.shinyIds()]).toEqual([5]);
  });
  it('a catch without a prior sighting still counts as seen', () => {
    const c = new Collection(new MemStorage());
    c.catch(9, { type: 0, shiny: false, rare: false });
    expect(c.isSeen(9)).toBe(true);
  });
  it('tracks runs, best per channel and best overall', () => {
    const c = new Collection(new MemStorage());
    expect(c.finishRun(500, 'snowfall')).toBe(true);
    expect(c.finishRun(300, 'snowfall')).toBe(false);
    expect(c.finishRun(300, 'magic')).toBe(true);
    expect(c.bestFor('snowfall')).toBe(500);
    expect(c.bestFor('magic')).toBe(300);
    expect(c.bestFor('brute')).toBe(0);
    expect(c.state.stats).toMatchObject({ runs: 3, bestScore: 500 });
    c.combo(7);
    c.combo(4);
    expect(c.state.stats.bestCombo).toBe(7);
  });
  it('persists and reloads, and a snapshot is independent of later changes', () => {
    const st = new MemStorage();
    const c = new Collection(st, day('2026-11-18'));
    c.catch(1, { type: 0, shiny: false, rare: false });
    const snap = c.snapshot();
    c.catch(2, { type: 1, shiny: true, rare: true });
    c.finishRun(100, 'snowfall');
    expect(snap.caught).toEqual(new Set([1]));
    expect(snap.catches).toBe(1);
    const again = new Collection(st, day('2026-11-18'));
    expect(again.caughtIds()).toEqual(new Set([1, 2]));
    expect(again.state.stats).toMatchObject({ catches: 2, runs: 1, bestScore: 100 });
    expect(again.snapshot().level.level).toBe(1);
  });
  it('survives missing, broken and hostile storage', () => {
    expect(new Collection(null).state.stats.catches).toBe(0);
    const bad = new MemStorage();
    bad.setItem(KEY, '{not json');
    expect(new Collection(bad).state.stats.catches).toBe(0);
    const throwing: StorageLike = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
    const c = new Collection(throwing);
    expect(() => c.catch(1, { type: 0, shiny: false, rare: false })).not.toThrow();
    expect(c.distinctCaught()).toBe(1);
  });
  it('normalizes junk', () => {
    const s = normalizeState({ species: { '4': { seen: -2, caught: 'x', shiny: 1.9 }, abc: {} }, stats: { catches: 'n' }, daily: { date: 1 } });
    expect(s.species[4]).toEqual({ seen: 0, caught: 0, shiny: 1, firstCaught: 0 });
    expect(Object.keys(s.species)).toEqual(['4']);
    expect(s.stats.catches).toBe(0);
    expect(s.daily).toBeNull();
    expect(normalizeState(null).v).toBe(1);
  });
  it('migrates the v1 progress record once', () => {
    const st = new MemStorage();
    st.setItem('static.progress.v1', JSON.stringify({ tuned: { '3': 4, '7': 1 }, seen: { '3': 6, '8': 2 }, best: 900, runs: 5 }));
    const c = new Collection(st);
    expect(c.state.stats).toMatchObject({ catches: 5, runs: 5, bestScore: 900 });
    expect(c.caughtIds()).toEqual(new Set([3, 7]));
    expect(c.isSeen(8)).toBe(true);
    expect(c.isCaught(8)).toBe(false);
    expect(migrateLegacy({})).toBeNull();
    c.save();
    st.setItem('static.progress.v1', JSON.stringify({ tuned: { '99': 50 } }));
    expect(new Collection(st).isCaught(99)).toBe(false);
  });
});
