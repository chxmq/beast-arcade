// What Decode shows: a ranked run replayed with the revealed seed, under exactly the rules the
// contract ran (the shared TS sim), boiled down to per-strike marks, the lives timeline and the
// numbers of the summary. DOM-free.

import { decodeStrike } from '../sim/encode.ts';
import { maskBits } from './api.ts';
import { Run, type RunEvent, type RunResult } from '../sim/replay.ts';
import type { SimRosterEntry } from '../sim/schedule.ts';
import { NO_INDEX, PLAYER_LIVES } from '../sim/spec.ts';

/** 'void': sent after the signal was lost (validated, never scored). */
export type MarkKind = 'hit' | 'kill' | 'overkill' | 'miss' | 'void';

export interface Mark {
  tick: number;
  x: number;
  y: number;
  kind: MarkKind;
  /** Spawn index hit or overkilled; -1 for a miss or after death. */
  target: number;
  /** Combo right after the strike. */
  combo: number;
  /** Misses in a row right after the strike (1 to 3 for a miss). */
  misses: number;
  /** Points scored by this strike (kills only). */
  pts: number;
}

type KillEvent = Extract<RunEvent, { kind: 'kill' }>;
type EscapeEvent = Extract<RunEvent, { kind: 'escape' }>;
type JamEvent = Extract<RunEvent, { kind: 'jam' }>;

export interface LifeLost {
  tick: number;
  cause: 'escape' | 'jam';
  /** Spawn index that got away; -1 for a jam. */
  idx: number;
}

/** sweep: every Beast tuned in. lost: the last life went to a Beast that got away. */
export type Verdict = 'sweep' | 'survived' | 'lost' | 'jammed';

/** A roster entry caught this run (SPEC v3): from `result.caughtMask` / `shinyMask`. */
export interface Caught {
  rosterIdx: number;
  shiny: boolean;
  /** How many Beasts of this roster entry were tuned in. */
  count: number;
}

export interface RunReport {
  run: Run;
  result: RunResult;
  marks: Mark[];
  kills: KillEvent[];
  escapes: EscapeEvent[];
  jams: JamEvent[];
  /** One entry per life actually lost, in order (a Bane that gets away can take two). */
  livesLost: LifeLost[];
  /** Roster entries caught this run, in roster order (bits of caughtMask). */
  caught: Caught[];
  /** Longest run of same-type kills (len 0 without kills). */
  bestChain: { len: number; type: number };
  counts: { hits: number; kills: number; overkills: number; misses: number; void: number };
  verdict: Verdict;
  /** Combo after every event at or before tick T. */
  comboAt(T: number): number;
  /** Lives after every event at or before tick T. */
  livesAt(T: number): number;
}

export function buildReport(seed: bigint, roster: SimRosterEntry[], nFeatured: number, strikes: readonly number[]): RunReport {
  const run = new Run(seed, roster, nFeatured);
  const marks: Mark[] = [];
  for (const v of strikes) {
    const st = decodeStrike(v);
    const ev = run.strike(st);
    if (!ev || ev.kind !== 'strike') {
      marks.push({ tick: st.tick, x: st.x, y: st.y, kind: 'void', target: -1, combo: 0, misses: 0, pts: 0 });
      continue;
    }
    // A lethal hit pushes its kill event right after the strike event.
    const last = run.events[run.events.length - 1];
    const killed = ev.outcome === 'hit' && last.kind === 'kill' && last.idx === ev.target && last.tick === st.tick;
    marks.push({
      tick: st.tick, x: st.x, y: st.y, kind: killed ? 'kill' : ev.outcome, target: ev.target,
      combo: ev.combo, misses: ev.misses, pts: killed ? (last as KillEvent).pts : 0,
    });
  }
  const result = run.finish();

  const kills: KillEvent[] = [];
  const escapes: EscapeEvent[] = [];
  const jams: JamEvent[] = [];
  const livesLost: LifeLost[] = [];
  const comboPts: { tick: number; v: number }[] = [];
  let lives = PLAYER_LIVES;
  let combo = 0;
  for (const e of run.events) {
    if (e.kind === 'kill') kills.push(e);
    else if (e.kind === 'escape') {
      escapes.push(e);
      for (let n = lives - e.lives; n > 0; n--) livesLost.push({ tick: e.tick, cause: 'escape', idx: e.idx });
      lives = e.lives;
      combo = 0;
    } else if (e.kind === 'jam') {
      jams.push(e);
      for (let n = lives - e.lives; n > 0; n--) livesLost.push({ tick: e.tick, cause: 'jam', idx: -1 });
      lives = e.lives;
    } else if (e.kind === 'strike') combo = e.outcome === 'miss' ? 0 : e.combo;
    else continue;
    comboPts.push({ tick: e.tick, v: combo });
  }

  const perRoster = new Map<number, number>();
  for (const k of kills) {
    const r = run.spawns[k.idx].rosterIdx;
    perRoster.set(r, (perRoster.get(r) ?? 0) + 1);
  }
  const caught: Caught[] = maskBits(result.caughtMask).map((rosterIdx) => ({
    rosterIdx, shiny: ((result.shinyMask >> BigInt(rosterIdx)) & 1n) === 1n, count: perRoster.get(rosterIdx) ?? 0,
  }));

  let bestChain = { len: 0, type: -1 };
  for (const k of kills) if (k.chain > bestChain.len) bestChain = { len: k.chain, type: run.spawns[k.idx].entry.type };

  const count = (...kinds: MarkKind[]) => marks.filter((m) => kinds.includes(m.kind)).length;
  const verdict: Verdict = result.dead
    ? result.killer === NO_INDEX ? 'jammed' : 'lost'
    : result.kills === run.spawns.length ? 'sweep' : 'survived';

  return {
    run, result, marks, kills, escapes, jams, livesLost, caught, bestChain, verdict,
    counts: { hits: count('hit', 'kill'), kills: count('kill'), overkills: count('overkill'), misses: count('miss'), void: count('void') },
    comboAt(T) {
      let v = 0;
      for (const p of comboPts) {
        if (p.tick > T) break;
        v = p.v;
      }
      return v;
    },
    livesAt(T) {
      let n = PLAYER_LIVES;
      for (const l of livesLost) if (l.tick <= T) n--;
      return n;
    },
  };
}
