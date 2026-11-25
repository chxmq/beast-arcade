import { describe, expect, it } from 'vitest';
import { decodeStrike, encodeStrike, type Strike } from './encode.ts';
import { axis, positionAt } from './motion.ts';
import { replay, Run } from './replay.ts';
import { aggrFromKills, buildSchedule, type SimRosterEntry } from './schedule.ts';
import { GAP_HIT, GAP_MISS, N_SPAWNS, PLAYER_LIVES, REACTION_TICKS, type BeastType } from './spec.ts';

const FULL = (1n << 64n) - 1n;
export function testRoster(nF = 4, nC = 6): SimRosterEntry[] {
  const out: SimRosterEntry[] = [];
  for (let k = 0; k < nF + nC; k++) {
    out.push({ type: (k % 3) as BeastType, tier: 1 + (k % 5), health: 100, aggr: k % 4 === 3 ? 1 : 0, w: 40 + (k % 3) * 4, h: 44 + (k % 2) * 4, occ: FULL });
  }
  return out;
}

/** An oracle that knows every Beast: clicks the centre of the oldest targetable one. */
export function oracleStrikes(seed: bigint, roster: SimRosterEntry[], nF: number, delay = REACTION_TICKS + 4): number[] {
  const run = new Run(seed, roster, nF);
  const strikes: number[] = [];
  for (let tick = 0; tick <= run.endTick; tick++) {
    run.advanceTo(tick);
    if (run.dead) break;
    if (!run.canStrike(tick)) continue;
    const target = run.spawns.findIndex((s, i) => run.isTargetable(i, tick) && tick >= s.spawnTick + delay);
    if (target < 0) continue;
    const s = run.spawns[target];
    const { px, py } = positionAt(s, tick);
    const st: Strike = { tick, x: px + (s.entry.w >> 1), y: py + (s.entry.h >> 1), type: 0 };
    run.strike(st);
    strikes.push(encodeStrike(st));
  }
  return strikes;
}

describe('encode', () => {
  it('round-trips', () => {
    const s: Strike = { tick: 3999, x: 255, y: 143, type: 0 };
    expect(decodeStrike(encodeStrike(s))).toEqual(s);
    expect(encodeStrike(s)).toBeLessThan(2 ** 32);
  });
});

describe('schedule', () => {
  it('is deterministic, increasing, and in bounds', () => {
    const r = testRoster();
    const a = buildSchedule(42n, r, 4);
    expect(buildSchedule(42n, r, 4)).toEqual(a);
    expect(a.length).toBe(N_SPAWNS);
    expect(a[N_SPAWNS - 1].boss).toBe(true);
    expect(a[N_SPAWNS - 1].hp).toBeGreaterThanOrEqual(8);
    for (let i = 1; i < a.length; i++) expect(a[i].spawnTick).toBeGreaterThan(a[i - 1].spawnTick);
    for (const s of a) {
      expect(s.escapeTick).toBeGreaterThan(s.spawnTick + 50);
      expect(s.hp).toBe(s.boss ? 8 + (s.peak ? 1 : 0) : (s.featured ? 2 : 1) + (s.peak ? 1 : 0));
      for (let t = s.spawnTick; t < s.escapeTick; t += 7) {
        const { px, py } = positionAt(s, t);
        expect(px).toBeGreaterThanOrEqual(0);
        expect(px + s.entry.w).toBeLessThanOrEqual(256);
        expect(py + s.entry.h).toBeLessThanOrEqual(144);
      }
    }
    expect(buildSchedule(43n, r, 4)).not.toEqual(a);
  });

  it('reflects on axis bounds', () => {
    expect(axis(100, 0, 10, 1, 5)).toBe(50);
    expect(axis(100, 0, 10, 1, 15)).toBe(50);
    expect(axis(100, 30, 10, 0, 2)).toBe(10);
    expect(axis(0, 0, 10, 1, 99)).toBe(0);
  });

  it('maps kills to aggression', () => {
    expect([0, 1, 2, 3, 6, 7, 100].map(aggrFromKills)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });
});

describe('replay', () => {
  const roster = testRoster();

  it('no strikes: Beasts escape until the lives run out', () => {
    const r = replay(7n, roster, 4, []);
    expect(r.kills).toBe(0);
    expect(r.dead).toBe(true);
    expect(r.lives).toBe(0);
    expect(r.killer).toBeLessThan(N_SPAWNS);
  });

  it('oracle play clears the broadcast and is deterministic', () => {
    const strikes = oracleStrikes(7n, roster, 4);
    const r1 = replay(7n, roster, 4, strikes);
    expect(replay(7n, roster, 4, strikes)).toEqual(r1);
    expect(r1.dead).toBe(false);
    expect(r1.kills).toBe(N_SPAWNS);
    expect(r1.lives).toBe(PLAYER_LIVES);
    expect(r1.bestCombo).toBeGreaterThan(30);
  });

  it('three misses in a row jam the signal', () => {
    const run = new Run(7n, roster, 4);
    // tick 0: nothing has spawned yet, so these are misses
    run.strike({ tick: 0, x: 0, y: 0, type: 0 });
    run.strike({ tick: GAP_MISS, x: 0, y: 0, type: 0 });
    expect(run.lives).toBe(PLAYER_LIVES);
    run.strike({ tick: 2 * GAP_MISS, x: 0, y: 0, type: 0 });
    expect(run.lives).toBe(PLAYER_LIVES - 1);
    expect(run.misses).toBe(0);
  });

  it('a blind spam-clicker dies fast', () => {
    let a = 99;
    const rand = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
    const run = new Run(11n, roster, 4);
    for (let t = 0; t < 3000 && !run.dead; t++) {
      run.advanceTo(t);
      if (run.canStrike(t)) run.strike({ tick: t, x: Math.floor(rand() * 256), y: Math.floor(rand() * 144), type: 0 });
    }
    expect(run.dead).toBe(true);
    expect(run.deathTick).toBeLessThan(1200);
  });

  it('enforces the gap rules', () => {
    // after a miss the gap is GAP_MISS
    expect(() => replay(1n, roster, 4, [encodeStrike({ tick: 0, x: 0, y: 0, type: 0 }), encodeStrike({ tick: GAP_HIT, x: 0, y: 0, type: 0 })])).toThrow('bad gap');
    expect(() => replay(1n, roster, 4, [encodeStrike({ tick: 10, x: 0, y: 150, type: 0 })])).toThrow('bad y');
    expect(() => replay(1n, roster, 4, [10 * 262144 + 1])).toThrow('bad type');
    expect(() => replay(1n, roster, 4, [4000 * 262144])).toThrow('bad tick');
  });

  it('overkill clicks on a Beast you already killed are neutral', () => {
    const run = new Run(5n, roster, 4);
    const i = run.spawns.findIndex((s) => s.hp === 1);
    const s = run.spawns[i];
    const t = s.spawnTick + REACTION_TICKS;
    run.advanceTo(t);
    const p = positionAt(s, t);
    const hit = run.strike({ tick: t, x: p.px + 2, y: p.py + 2, type: 0 });
    expect(hit && hit.kind === 'strike' && hit.outcome).toBe('hit');
    expect(run.killed[i]).toBe(true);
    const combo = run.combo;
    const p2 = positionAt(s, t + GAP_HIT);
    const again = run.strike({ tick: t + GAP_HIT, x: p2.px + 2, y: p2.py + 2, type: 0 });
    // either another live Beast overlapped (hit) or it is an overkill; never a miss
    expect(again && again.kind === 'strike' && again.outcome).not.toBe('miss');
    if (again && again.kind === 'strike' && again.outcome === 'overkill') expect(run.combo).toBe(combo);
  });

  it('digest changes with play', () => {
    expect(replay(7n, roster, 4, []).digest).not.toBe(replay(7n, roster, 4, oracleStrikes(7n, roster, 4)).digest);
  });
});
