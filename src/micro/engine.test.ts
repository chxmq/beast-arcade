import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Roster } from '../data/roster.ts';
import { beats, BUTTON_TYPE, Cast, counterOf, preyOf, TYPE_BUTTON } from './cast.ts';
import {
  BASE_DURATION, BEST_KEY, BOSS_EVERY, BOSS_TICKETS, clearTickets, Deck, durationScale, gameDuration, LIVES, MicroRun, payout,
  readBest, recordBest, REGULAR, SPEEDUP_EVERY, speedLabel, speedMult, type Phase, type StorageLike,
} from './engine.ts';
import { mixSeed, Rng } from './rng.ts';
import { printPlan } from './results.ts';
import { noInput, type GameCtx, type GameId, type Microgame, type Status } from './types.ts';

const roster = JSON.parse(readFileSync(new URL('../../public/data/roster.json', import.meta.url), 'utf8')) as Roster;
const cast = new Cast(roster.entries);

class MemStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
}

/** A microgame that resolves the way the test script says, on its first update. */
class Stub implements Microgame {
  readonly prompt = 'STUB!';
  readonly hint = 'tap' as const;
  readonly bg = '#000';
  readonly duration: number;
  readonly cast;
  status: Status = 'playing';
  t = 0;
  shake = 0;
  hitstop = 0;
  constructor(readonly id: GameId, ctx: GameCtx, private readonly outcome: Status) {
    this.duration = ctx.duration;
    this.cast = [ctx.cast.all[ctx.rng.int(0, ctx.cast.all.length - 1)]];
  }
  preview() {}
  update(dt: number) {
    if (this.status !== 'playing') return;
    this.t += dt;
    if (this.outcome !== 'playing') this.status = this.outcome;
  }
  expire() { if (this.status === 'playing') this.status = 'lost'; }
  draw() {}
  bot() { return noInput(); }
}

type Script = (id: GameId, index: number) => Status;

function makeRun(script: Script, extra: Partial<ConstructorParameters<typeof MicroRun>[0]> = {}) {
  const dealt: { id: GameId; ctx: GameCtx }[] = [];
  const levels: number[] = [];
  const seen: number[] = [];
  const run = new MicroRun({
    cast,
    seed: 1234,
    create: (id, ctx) => {
      dealt.push({ id, ctx });
      return new Stub(id, ctx, script(id, dealt.length - 1));
    },
    onLevel: (l) => levels.push(l),
    onSeen: (e) => seen.push(e.speciesId),
    ...extra,
  });
  return { run, dealt, levels, seen };
}

const DT = 1 / 30;
function until(run: MicroRun, pred: () => boolean, max = 600): void {
  let t = 0;
  while (!pred() && t < max) {
    run.update(DT, noInput());
    t += DT;
  }
  expect(pred()).toBe(true);
}
const phaseIs = (run: MicroRun, p: Phase) => () => run.phase === p;

describe('type triangle', () => {
  it('Magic beats Brute beats Hunter beats Magic, and exactly one side wins', () => {
    expect(beats(0, 2)).toBe(true);
    expect(beats(2, 1)).toBe(true);
    expect(beats(1, 0)).toBe(true);
    for (const a of [0, 1, 2] as const) {
      expect(beats(a, a)).toBe(false);
      for (const b of [0, 1, 2] as const) if (a !== b) expect(beats(a, b) !== beats(b, a)).toBe(true);
      expect(beats(counterOf(a), a)).toBe(true);
      expect(beats(a, preyOf(a))).toBe(true);
    }
  });
  it('buttons are the types: A MAGIC, B HUNTER, C BRUTE', () => {
    expect(BUTTON_TYPE).toEqual({ A: 0, B: 1, C: 2 });
    expect(TYPE_BUTTON).toEqual(['A', 'B', 'C']);
  });
  it('the cast has kings (tier 1 Art Hackathon) and clean HUMAN EYES masks', () => {
    expect(cast.kings.length).toBeGreaterThan(0);
    for (const k of cast.kings) expect(k.featured && k.tier === 1).toBe(true);
    for (const e of cast.eyes) expect(e.maskWarning).toBeNull();
  });
});

describe('rng', () => {
  it('is deterministic per seed and stays in range', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 200; i++) {
      const x = a.next();
      expect(x).toBe(b.next());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      const n = a.int(3, 6);
      b.int(3, 6);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(6);
    }
    expect(mixSeed(1, 2)).not.toBe(mixSeed(1, 3));
  });
});

describe('pacing and payout math', () => {
  it('each speed-up multiplies durations by 0.87', () => {
    expect(durationScale(0)).toBe(1);
    expect(durationScale(1)).toBeCloseTo(0.87, 10);
    expect(durationScale(3)).toBeCloseTo(0.87 ** 3, 10);
    expect(speedMult(2)).toBeCloseTo(1 / 0.87 ** 2, 10);
    expect(speedLabel(0)).toBe('x1.00');
    expect(speedLabel(1)).toBe('x1.15');
  });
  it('speed 1 microgames last 3.5 to 4.5 s, the boss 10 to 12 s', () => {
    for (const id of [...REGULAR, 'eyes'] as GameId[]) {
      expect(gameDuration(id, 0)).toBeGreaterThanOrEqual(3.5);
      expect(gameDuration(id, 0)).toBeLessThanOrEqual(4.5);
      expect(gameDuration(id, 1)).toBeCloseTo(BASE_DURATION[id] * 0.87, 10);
    }
    for (let l = 0; l < 12; l++) {
      expect(gameDuration('boss', l)).toBeGreaterThanOrEqual(10);
      expect(gameDuration('boss', l)).toBeLessThanOrEqual(12);
    }
  });
  it('a clear pays 10 x the speed multiplier, a boss 100', () => {
    expect([0, 1, 2, 3, 4, 5].map(clearTickets)).toEqual([10, 11, 13, 15, 17, 20]);
    expect(payout([], 0)).toBe(0);
    expect(payout([0, 0, 1], 1)).toBe(10 + 10 + 11 + BOSS_TICKETS);
    expect(payout([2, 2, 2, 2, 2], 2)).toBe(5 * 13 + 200);
  });
});

describe('run engine', () => {
  it('starts on a title card, then deals CATCH first', () => {
    const { run, dealt } = makeRun(() => 'won');
    expect(run.phase).toBe('title');
    expect(run.lives).toBe(LIVES);
    until(run, phaseIs(run, 'prompt'));
    expect(dealt[0].id).toBe('catch');
    expect(dealt[0].ctx.level).toBe(0);
  });

  it('speeds up every 5 clears and scales the next durations', () => {
    const { run, dealt, levels } = makeRun(() => 'won');
    until(run, () => run.cleared === SPEEDUP_EVERY);
    expect(run.level).toBe(0);
    until(run, phaseIs(run, 'speedup'));
    expect(run.level).toBe(1);
    expect(levels).toEqual([1]);
    until(run, phaseIs(run, 'prompt'));
    const next = dealt[dealt.length - 1];
    expect(next.ctx.level).toBe(1);
    expect(next.ctx.duration).toBeCloseTo(gameDuration(next.id, 1), 10);
    until(run, () => run.cleared === 10);
    until(run, phaseIs(run, 'speedup'));
    expect(run.level).toBe(2);
  });

  it('deals the boss after 15 clears (after the SPEED UP); beating it pays 100', () => {
    const { run, dealt } = makeRun(() => 'won');
    until(run, () => run.cleared === BOSS_EVERY);
    expect(run.bossPending).toBe(true);
    until(run, phaseIs(run, 'speedup'));
    until(run, phaseIs(run, 'boss'));
    expect(run.game?.id).toBe('boss');
    expect(dealt.filter((d) => d.id === 'boss')).toHaveLength(1);
    const before = run.earned;
    until(run, () => run.bosses === 1);
    expect(run.earned - before).toBe(BOSS_TICKETS);
    expect(run.cleared).toBe(BOSS_EVERY + 1);
    until(run, phaseIs(run, 'prompt'));
    expect(run.game?.id).not.toBe('boss');
    // the next boss comes at 30 clears, not before
    until(run, () => run.cleared === 29);
    expect(dealt.filter((d) => d.id === 'boss')).toHaveLength(1);
    until(run, phaseIs(run, 'boss'));
    expect(run.cleared).toBe(30);
  });

  it('a lost boss costs a life and the run goes on', () => {
    const { run } = makeRun((id) => (id === 'boss' ? 'lost' : 'won'));
    until(run, phaseIs(run, 'boss'));
    until(run, () => run.result === 'lost');
    expect(run.lives).toBe(LIVES - 1);
    expect(run.bosses).toBe(0);
    until(run, phaseIs(run, 'prompt'));
  });

  it('4 lives: each loss costs one, zero ends the run with no tickets', () => {
    const { run, levels } = makeRun(() => 'lost');
    for (let lives = LIVES - 1; lives >= 0; lives--) {
      until(run, () => run.lives === lives);
      expect(run.phase).toBe('outro');
    }
    until(run, phaseIs(run, 'over'));
    until(run, phaseIs(run, 'done'));
    expect(run.earned).toBe(0);
    expect(run.cleared).toBe(0);
    expect(levels).toEqual([]);
  });

  it('earned tickets always equal the payout formula', () => {
    const { run } = makeRun((id, i) => (id === 'boss' ? 'won' : i % 7 === 3 ? 'lost' : 'won'));
    until(run, () => run.over, 3000);
    expect(run.bosses).toBeGreaterThan(0);
    expect(run.earned).toBe(payout(run.clearLevels, run.bosses));
    expect(run.clearLevels.length + run.bosses).toBe(run.cleared);
    // clears at higher speed pay more
    expect(Math.max(...run.clearLevels)).toBeGreaterThan(0);
  });

  it('marks each species seen once per run', () => {
    const { run, seen } = makeRun(() => 'won');
    until(run, () => run.stage >= 30);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(run.met.size);
    expect(seen).toContain(run.partner.speciesId);
  });

  it('quit ends the run and keeps what was earned', () => {
    const { run } = makeRun(() => 'won');
    until(run, () => run.cleared === 3);
    const earned = run.earned;
    run.quit();
    expect(run.phase).toBe('over');
    until(run, phaseIs(run, 'done'));
    expect(run.earned).toBe(earned);
  });

  it('demo runs never lose lives and never deal a boss', () => {
    const { run, dealt } = makeRun((_, i) => (i % 2 ? 'lost' : 'won'), { demo: true, skipTitle: true, first: null });
    expect(run.phase).toBe('prompt');
    until(run, () => run.stage >= 40);
    expect(run.lives).toBe(LIVES);
    expect(dealt.some((d) => d.id === 'boss')).toBe(false);
  });

  it('hit-stop freezes the phase clock', () => {
    const { run } = makeRun(() => 'won');
    run.hitstop = 0.1;
    const t0 = run.phaseT;
    run.update(0.05, noInput());
    expect(run.phaseT).toBe(t0);
    run.update(0.05, noInput());
    run.update(0.05, noInput());
    expect(run.phaseT).toBeGreaterThan(t0);
  });
});

describe('deck', () => {
  it('CATCH first, no immediate repeats, HUMAN EYES every 4 to 6 games', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const deck = new Deck(new Rng(seed));
      const ids = Array.from({ length: 160 }, () => deck.next());
      expect(ids[0]).toBe('catch');
      for (let i = 1; i < ids.length; i++) expect(ids[i]).not.toBe(ids[i - 1]);
      const eyes = ids.flatMap((id, i) => (id === 'eyes' ? [i] : []));
      expect([3, 4]).toContain(eyes[0]);
      for (let i = 1; i < eyes.length; i++) {
        expect(eyes[i] - eyes[i - 1]).toBeGreaterThanOrEqual(4);
        expect(eyes[i] - eyes[i - 1]).toBeLessThanOrEqual(6);
      }
      expect(ids).not.toContain('boss');
      // every regular game shows up early
      for (const g of REGULAR) expect(ids.slice(0, 12)).toContain(g);
    }
  });
});

describe('best score', () => {
  it('stores a plain integer under beastarcade.micro.best, only when beaten', () => {
    const st = new MemStorage();
    expect(readBest(st)).toBe(0);
    expect(recordBest(st, 7)).toEqual({ best: 7, isNew: true });
    expect(st.getItem(BEST_KEY)).toBe('7');
    expect(recordBest(st, 5)).toEqual({ best: 7, isNew: false });
    expect(recordBest(st, 7)).toEqual({ best: 7, isNew: false });
    expect(recordBest(st, 12)).toEqual({ best: 12, isNew: true });
    st.setItem(BEST_KEY, 'garbage');
    expect(readBest(st)).toBe(0);
    expect(recordBest(null, 3)).toEqual({ best: 3, isNew: true });
  });
});

describe('ticket strip', () => {
  it('prints in segments that end exactly on the payout', () => {
    expect(printPlan(0)).toEqual([]);
    expect(printPlan(7)).toEqual([7]);
    const p = printPlan(287);
    expect(p).toHaveLength(29);
    expect(p[p.length - 1]).toBe(287);
    for (let i = 1; i < p.length; i++) expect(p[i]).toBeGreaterThan(p[i - 1]);
    expect(printPlan(5000)).toHaveLength(36);
  });
});
