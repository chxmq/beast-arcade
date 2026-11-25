import { decodeStrike, type Strike } from './encode.ts';
import { occHit, positionAt } from './motion.ts';
import { poseidon } from './rng.ts';
import { buildSchedule, type SimRosterEntry, type Spawn } from './schedule.ts';
import {
  EV_ESCAPE, EV_JAM, EV_KILL, EV_STRIKE, FIELD_H, FIELD_W, GAP_HIT, GAP_MISS, JAM_MISSES, MAX_STRIKES, MAX_TICK,
  MISS_INDEX, NO_INDEX, NO_TYPE, OVERKILL_INDEX, PLAYER_LIVES, REACTION_TICKS,
} from './spec.ts';

/** SPEC §10. */
export interface RunResult {
  score: number;
  kills: number;
  lives: number;
  dead: boolean;
  deathTick: number;
  killer: number;
  killerRoster: number;
  bestCombo: number;
  /** Bit r set: a Beast of roster index r was caught this run (SPEC §10). */
  caughtMask: bigint;
  shinyMask: bigint;
  digest: bigint;
}

export type StrikeKind = 'hit' | 'overkill' | 'miss';

export type RunEvent =
  | { kind: 'strike'; tick: number; outcome: StrikeKind; target: number; combo: number; misses: number }
  | { kind: 'kill'; tick: number; idx: number; pts: number; combo: number; chain: number }
  | { kind: 'escape'; tick: number; idx: number; cost: number; lives: number }
  | { kind: 'jam'; tick: number; lives: number }
  | { kind: 'death'; tick: number; killer: number };

/**
 * Incremental run state machine (SPEC §8). The live game drives it with advanceTo()/strike(),
 * the verifier drives it with replay(). Both paths share every rule.
 */
export class Run {
  readonly spawns: Spawn[];
  readonly beastHp: number[];
  readonly alive: boolean[];
  readonly killed: boolean[];
  /** Tick each Beast was killed or escaped at (-1 while unresolved). */
  readonly resolvedAt: number[];
  readonly killedBy: ('player' | 'escaped' | null)[];
  lives = PLAYER_LIVES;
  score = 0;
  kills = 0;
  combo = 0;
  bestCombo = 0;
  caughtMask = 0n;
  shinyMask = 0n;
  misses = 0;
  chain = 0;
  chainType = NO_TYPE;
  dead = false;
  deathTick = 0;
  killer = NO_INDEX;
  digest = 0n;
  events: RunEvent[] = [];
  private lastStrikeTick = -1;
  private lastMiss = false;
  private strikeCount = 0;

  constructor(readonly seed: bigint, readonly roster: SimRosterEntry[], readonly nFeatured: number) {
    this.spawns = buildSchedule(seed, roster, nFeatured);
    this.beastHp = this.spawns.map((s) => s.hp);
    this.alive = this.spawns.map(() => true);
    this.killed = this.spawns.map(() => false);
    this.resolvedAt = this.spawns.map(() => -1);
    this.killedBy = this.spawns.map(() => null);
  }

  private log(kind: number, idx: number, tick: number, value: number) {
    const ev = BigInt(kind) + 8n * BigInt(idx) + 512n * BigInt(tick) + (1n << 24n) * BigInt(value);
    this.digest = poseidon([this.digest, ev]);
  }

  isVisibleWindow(i: number, tick: number): boolean {
    const s = this.spawns[i];
    return s.spawnTick <= tick && tick < s.escapeTick;
  }

  isTargetable(i: number, tick: number): boolean {
    return this.alive[i] && this.isVisibleWindow(i, tick) && tick >= this.spawns[i].spawnTick + REACTION_TICKS;
  }

  /** On screen in a live game (spawned, not resolved). */
  isVisible(i: number, tick: number): boolean {
    return this.alive[i] && this.isVisibleWindow(i, tick);
  }

  private covers(i: number, tick: number, x: number, y: number): boolean {
    const s = this.spawns[i];
    const { px, py } = positionAt(s, tick);
    return occHit(s.entry.occ, s.entry.w, s.entry.h, x - px, y - py);
  }

  /** SPEC §8: process escapes with escape_tick <= T, in (escape_tick, index) order. */
  advanceTo(T: number): void {
    while (!this.dead) {
      let best = -1;
      for (let i = 0; i < this.spawns.length; i++) {
        if (!this.alive[i]) continue;
        const e = this.spawns[i].escapeTick;
        if (e > T) continue;
        if (best === -1 || e < this.spawns[best].escapeTick) best = i;
      }
      if (best === -1) return;
      const s = this.spawns[best];
      this.alive[best] = false;
      this.resolvedAt[best] = s.escapeTick;
      this.killedBy[best] = 'escaped';
      this.lives = Math.max(0, this.lives - s.escapeCost);
      this.combo = 0;
      this.log(EV_ESCAPE, best, s.escapeTick, this.lives);
      this.events.push({ kind: 'escape', tick: s.escapeTick, idx: best, cost: s.escapeCost, lives: this.lives });
      if (this.lives === 0) {
        this.die(s.escapeTick, best);
        return;
      }
    }
  }

  private die(tick: number, killer: number) {
    this.dead = true;
    this.deathTick = tick;
    this.killer = killer;
    this.events.push({ kind: 'death', tick, killer });
  }

  /** Lowest-index targetable (alive) Beast covering (x, y), or -1. */
  targetAt(tick: number, x: number, y: number): number {
    for (let i = 0; i < this.spawns.length; i++) {
      if (this.isTargetable(i, tick) && this.covers(i, tick, x, y)) return i;
    }
    return -1;
  }

  private overkillAt(tick: number, x: number, y: number): number {
    for (let i = 0; i < this.spawns.length; i++) {
      if (this.killed[i] && this.isVisibleWindow(i, tick) && this.covers(i, tick, x, y)) return i;
    }
    return -1;
  }

  private gapAfterLast(): number {
    return this.lastMiss ? GAP_MISS : GAP_HIT;
  }

  /** SPEC §7 validation; throws like the Cairo contract panics. */
  validate(st: Strike): void {
    if (this.strikeCount >= MAX_STRIKES) throw new Error('too many strikes');
    if (st.tick >= MAX_TICK) throw new Error('bad tick');
    if (st.x >= FIELD_W) throw new Error('bad x');
    if (st.y >= FIELD_H) throw new Error('bad y');
    if (st.type !== 0) throw new Error('bad type');
    if (this.lastStrikeTick >= 0 && st.tick < this.lastStrikeTick + this.gapAfterLast()) throw new Error('bad gap');
  }

  /** Can the live game accept a strike at this tick? */
  canStrike(tick: number): boolean {
    return this.strikeCount < MAX_STRIKES && tick < MAX_TICK && (this.lastStrikeTick < 0 || tick >= this.lastStrikeTick + this.gapAfterLast());
  }

  /** Ticks until the next strike is allowed (0 = now). */
  cooldown(tick: number): number {
    if (this.lastStrikeTick < 0) return 0;
    return Math.max(0, this.lastStrikeTick + this.gapAfterLast() - tick);
  }

  strike(st: Strike): RunEvent | null {
    this.validate(st);
    this.strikeCount++;
    this.lastStrikeTick = st.tick;
    if (this.dead) {
      this.lastMiss = false;
      return null;
    }
    const T = st.tick;
    this.advanceTo(T);
    if (this.dead) {
      this.lastMiss = false;
      return null;
    }

    const b = this.targetAt(T, st.x, st.y);
    if (b >= 0) {
      this.lastMiss = false;
      this.beastHp[b] -= 1;
      this.combo += 1;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      this.misses = 0;
      this.log(EV_STRIKE, b, T, this.combo);
      const ev: RunEvent = { kind: 'strike', tick: T, outcome: 'hit', target: b, combo: this.combo, misses: 0 };
      this.events.push(ev);
      if (this.beastHp[b] === 0) this.kill(b, T);
      return ev;
    }

    const o = this.overkillAt(T, st.x, st.y);
    if (o >= 0) {
      this.lastMiss = false;
      this.log(EV_STRIKE, OVERKILL_INDEX, T, this.combo);
      const ev: RunEvent = { kind: 'strike', tick: T, outcome: 'overkill', target: o, combo: this.combo, misses: this.misses };
      this.events.push(ev);
      return ev;
    }

    this.lastMiss = true;
    this.combo = 0;
    this.misses += 1;
    this.log(EV_STRIKE, MISS_INDEX, T, this.misses);
    const ev: RunEvent = { kind: 'strike', tick: T, outcome: 'miss', target: -1, combo: 0, misses: this.misses };
    this.events.push(ev);
    if (this.misses === JAM_MISSES) {
      this.misses = 0;
      this.lives = Math.max(0, this.lives - 1);
      this.log(EV_JAM, MISS_INDEX, T, this.lives);
      this.events.push({ kind: 'jam', tick: T, lives: this.lives });
      if (this.lives === 0) this.die(T, NO_INDEX);
    }
    return ev;
  }

  private kill(b: number, T: number) {
    const s = this.spawns[b];
    this.alive[b] = false;
    this.killed[b] = true;
    this.resolvedAt[b] = T;
    this.killedBy[b] = 'player';
    this.kills += 1;
    this.chain = s.entry.type === this.chainType ? this.chain + 1 : 1;
    this.chainType = s.entry.type;
    const base = 50 + 25 * (5 - s.entry.tier);
    let pts = Math.floor((base * (10 + Math.min(this.combo, 40))) / 10);
    pts = Math.floor((pts * (1 + Math.min(this.chain, 5))) / 2);
    if (s.faint) pts = Math.floor((pts * 5) / 4);
    if (s.boss) pts *= 3;
    if (s.shiny) pts *= 3;
    pts += Math.floor((s.escapeTick - T) / 2);
    this.score += pts;
    this.caughtMask |= 1n << BigInt(s.rosterIdx);
    if (s.shiny) this.shinyMask |= 1n << BigInt(s.rosterIdx);
    this.log(EV_KILL, b, T, pts);
    this.events.push({ kind: 'kill', tick: T, idx: b, pts, combo: this.combo, chain: this.chain });
  }

  /** After the last strike: every remaining Beast escapes. */
  finish(): RunResult {
    if (!this.dead) this.advanceTo(Number.MAX_SAFE_INTEGER);
    return this.result();
  }

  result(): RunResult {
    const killer = this.dead ? this.killer : NO_INDEX;
    return {
      score: this.score,
      kills: this.kills,
      lives: this.lives,
      dead: this.dead,
      deathTick: this.dead ? this.deathTick : 0,
      killer,
      killerRoster: killer === NO_INDEX ? NO_INDEX : this.spawns[killer].rosterIdx,
      bestCombo: this.bestCombo,
      caughtMask: this.caughtMask,
      shinyMask: this.shinyMask,
      digest: this.digest,
    };
  }

  /** Last tick anything can happen (all Beasts resolved). */
  get endTick(): number {
    return Math.max(...this.spawns.map((s) => s.escapeTick));
  }
}

/** SPEC §8 replay of an encoded strike log. Throws on invalid input. */
export function replay(seed: bigint, roster: SimRosterEntry[], nFeatured: number, strikes: number[]): RunResult {
  const run = new Run(seed, roster, nFeatured);
  for (const v of strikes) run.strike(decodeStrike(v));
  return run.finish();
}
