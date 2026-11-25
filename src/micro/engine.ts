// MICRO MAYHEM run engine: lives, pacing, speed-ups, boss cadence and the ticket payout.
// Pure logic (no DOM, no audio of its own): the screen drives it with update(dt, input) and draws
// whatever phase it is in. Unit tested in engine.test.ts.
import type { RosterEntry } from '../data/roster.ts';
import type { Cast } from './cast.ts';
import { mixSeed, Rng } from './rng.ts';
import { noInput, silentAudio, type Audio, type FrameInput, type GameCtx, type GameId, type Microgame, type Status } from './types.ts';

export const LIVES = 4;
export const SPEEDUP_EVERY = 5;
export const BOSS_EVERY = 15;
/** Every speed-up multiplies durations by this. */
export const DURATION_FACTOR = 0.87;
export const MAX_LEVEL = 10;
export const PROMPT_S = 0.8;
export const CLEAR_TICKETS = 10;
export const BOSS_TICKETS = 100;
export const MIN_DURATION = 1.8;
export const TITLE_S = 2.8;
export const SPEEDUP_S = 1.6;
export const BOSS_INTRO_S = 2.8;
export const OVER_S = 2.2;
export const BEST_KEY = 'beastarcade.micro.best';

/** Seconds of play at speed 1 (each microgame 3.5 to 4.5 s, the boss 12 s). */
export const BASE_DURATION: Record<GameId, number> = {
  catch: 4.0, counter: 4.2, duel: 3.6, shiny: 4.2, eyes: 4.5, dodge: 4.4, mash: 3.8, feed: 4.4, boss: 12,
};

/** The regular deck. HUMAN EYES is dealt on its own schedule, the boss every 15 clears. */
export const REGULAR: readonly GameId[] = ['catch', 'counter', 'duel', 'shiny', 'dodge', 'mash', 'feed'];

const clampLevel = (level: number) => Math.max(0, Math.min(MAX_LEVEL, Math.floor(level)));

export function durationScale(level: number): number {
  return Math.pow(DURATION_FACTOR, clampLevel(level));
}

/** 1.00, 1.15, 1.32, 1.52 ... the speed shown to the player and the ticket multiplier. */
export function speedMult(level: number): number {
  return 1 / durationScale(level);
}

export function speedLabel(level: number): string {
  return `x${speedMult(level).toFixed(2)}`;
}

/** Tickets for one clear at this speed level: 10 x the speed multiplier. */
export function clearTickets(level: number): number {
  return Math.round(CLEAR_TICKETS * speedMult(level));
}

/** Tickets for a run: 10 per clear x the speed multiplier at that clear, plus 100 per boss beaten. */
export function payout(clearLevels: readonly number[], bosses: number): number {
  let n = 0;
  for (const l of clearLevels) n += clearTickets(l);
  return n + Math.max(0, bosses) * BOSS_TICKETS;
}

export function gameDuration(id: GameId, level: number): number {
  if (id === 'boss') return Math.max(10, 12 - 0.4 * Math.max(0, clampLevel(level) - 3));
  return Math.max(MIN_DURATION, BASE_DURATION[id] * durationScale(level));
}

export function promptDuration(level: number): number {
  return Math.max(0.55, PROMPT_S * Math.pow(0.93, clampLevel(level)));
}

export function outroDuration(id: GameId, won: boolean, level: number): number {
  if (id === 'boss') return won ? 3.8 : 2.0;
  return Math.max(0.55, (won ? 0.8 : 0.95) * Math.pow(0.93, clampLevel(level)));
}

// ------------------------------------------------------------------ best score

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export function readBest(st: StorageLike | null): number {
  try {
    const n = Number(st?.getItem(BEST_KEY) ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/** Store `score` when it beats the saved best. The key holds a plain integer (the attract screen reads it). */
export function recordBest(st: StorageLike | null, score: number): { best: number; isNew: boolean } {
  const prev = readBest(st);
  const s = Math.max(0, Math.floor(score));
  if (s <= prev) return { best: prev, isNew: false };
  try {
    st?.setItem(BEST_KEY, String(s));
  } catch {
    /* storage unavailable: the best lasts for this session */
  }
  return { best: s, isNew: true };
}

// ------------------------------------------------------------------ deck

/**
 * Deals microgames: the first is CATCH (the easiest to read), then shuffled bags of the regular
 * games with no immediate repeats, and HUMAN EYES every 4 to 6 games (first as game 4 or 5).
 */
export class Deck {
  private bag: GameId[] = [];
  private last: GameId | null = null;
  private index = 0;
  private nextEyes: number;

  constructor(private readonly rng: Rng, private readonly first: GameId | null = 'catch', private readonly eyes = true) {
    this.nextEyes = rng.int(3, 4);
  }

  next(): GameId {
    let id: GameId;
    if (this.index === 0 && this.first) id = this.first;
    else if (this.eyes && this.index >= this.nextEyes) id = 'eyes';
    else id = this.draw();
    if (id === 'eyes') this.nextEyes = this.index + this.rng.int(4, 6);
    this.index++;
    this.last = id;
    return id;
  }

  private draw(): GameId {
    if (!this.bag.length) this.bag = this.rng.shuffle(REGULAR.slice());
    const top = this.bag.length - 1;
    if (this.bag[top] === this.last) {
      if (this.bag.length === 1) this.bag.unshift(...this.rng.shuffle(REGULAR.filter((g) => g !== this.last)));
      const i = this.bag.length - 1;
      const j = this.rng.int(0, i - 1);
      const t = this.bag[i];
      this.bag[i] = this.bag[j];
      this.bag[j] = t;
    }
    return this.bag.pop()!;
  }
}

// ------------------------------------------------------------------ run

export type Phase = 'title' | 'prompt' | 'play' | 'outro' | 'speedup' | 'boss' | 'over' | 'done';

export interface RunOptions {
  cast: Cast;
  seed: number;
  create: (id: GameId, ctx: GameCtx) => Microgame;
  audio?: Audio;
  /** A species appeared for the first time this run (the screen marks it seen in the book). */
  onSeen?: (e: RosterEntry) => void;
  /** The speed level changed (music tempo follows). */
  onLevel?: (level: number) => void;
  /** Attract-mode demo: lives never run out, no boss. */
  demo?: boolean;
  calm?: boolean;
  skipTitle?: boolean;
  first?: GameId | null;
  partner?: RosterEntry;
}

export class MicroRun {
  phase: Phase = 'title';
  /** Seconds spent in the current phase, and its length. */
  phaseT = 0;
  phaseDur = TITLE_S;
  lives = LIVES;
  /** Microgames won (bosses included): the score. */
  cleared = 0;
  level = 0;
  bosses = 0;
  /** Tickets earned so far. */
  earned = 0;
  /** Speed level of every regular clear (the payout is recomputed from it in tests). */
  readonly clearLevels: number[] = [];
  /** Microgames dealt so far. */
  stage = 0;
  game: Microgame | null = null;
  result: Status | null = null;
  bossPending = false;
  readonly partner: RosterEntry;
  /** Species met this run, in order of appearance. */
  readonly met = new Map<number, RosterEntry>();
  readonly plays: Partial<Record<GameId, number>> = {};
  readonly history: GameId[] = [];
  /** Screen shake amplitude (logical px) and hit-stop seconds. */
  shake = 0;
  hitstop = 0;
  /** Seconds since the run began, and the clock time of the last life lost. */
  clock = 0;
  lostAt = -10;
  private speedPending = false;
  private readonly deck: Deck;
  private readonly audio: Audio;

  constructor(readonly opts: RunOptions) {
    const rng = new Rng(mixSeed(opts.seed, 1));
    this.deck = new Deck(new Rng(mixSeed(opts.seed, 2)), opts.first === undefined ? 'catch' : opts.first);
    this.audio = opts.audio ?? silentAudio;
    this.partner = opts.partner ?? opts.cast.any(rng, 0.2, opts.cast.small);
    this.meet(this.partner);
    if (opts.skipTitle) this.startPrompt();
  }

  get score(): number {
    return this.cleared;
  }

  get over(): boolean {
    return this.phase === 'over' || this.phase === 'done';
  }

  update(dt: number, input: FrameInput): void {
    this.clock += dt;
    this.shake = Math.max(0, this.shake - dt * 24);
    if (this.hitstop > 0) {
      this.hitstop = Math.max(0, this.hitstop - dt);
      return;
    }
    this.phaseT += dt;
    const g = this.game;
    switch (this.phase) {
      case 'title': {
        const skip = this.phaseT > 0.7 && (input.taps.length > 0 || input.presses.includes('START') || input.presses.includes('A'));
        if (this.phaseT >= this.phaseDur || skip) this.startPrompt();
        break;
      }
      case 'prompt':
        g?.preview(dt);
        if (g && this.phaseT >= this.phaseDur) this.setPhase('play', g.duration);
        break;
      case 'play':
        if (!g) break;
        g.update(dt, input);
        this.absorb(g);
        if (g.status === 'playing' && g.t >= g.duration) g.expire();
        if (g.status !== 'playing') this.resolve(g);
        break;
      case 'outro':
        if (g) {
          g.update(dt, noInput());
          this.absorb(g);
        }
        if (this.phaseT >= this.phaseDur) this.afterOutro();
        break;
      case 'speedup':
        if (this.phaseT >= this.phaseDur) {
          if (this.bossPending) this.startBoss();
          else this.startPrompt();
        }
        break;
      case 'boss':
        if (this.phaseT >= this.phaseDur) this.setPhase('prompt', promptDuration(this.level));
        break;
      case 'over':
        if (this.phaseT >= this.phaseDur) this.setPhase('done', Infinity);
        break;
      case 'done':
        break;
    }
  }

  /** The player walked away mid-run (Escape): end it now, keeping what was earned. */
  quit(): void {
    if (this.over) return;
    this.setPhase('over', 0.01);
  }

  private setPhase(p: Phase, dur: number) {
    this.phase = p;
    this.phaseT = 0;
    this.phaseDur = dur;
  }

  private absorb(g: Microgame) {
    if (!this.opts.calm) this.shake = Math.max(this.shake, g.shake);
    this.hitstop = Math.max(this.hitstop, Math.min(0.12, g.hitstop));
    g.shake = 0;
    g.hitstop = 0;
  }

  private resolve(g: Microgame) {
    const won = g.status === 'won';
    this.result = g.status;
    if (won) {
      this.cleared++;
      if (g.id === 'boss') {
        this.bosses++;
        this.earned += BOSS_TICKETS;
      } else {
        this.clearLevels.push(this.level);
        this.earned += clearTickets(this.level);
        if (this.cleared % SPEEDUP_EVERY === 0) this.speedPending = true;
        if (this.cleared % BOSS_EVERY === 0 && !this.opts.demo) this.bossPending = true;
      }
      this.audio.sfx('win');
    } else {
      if (!this.opts.demo) this.lives = Math.max(0, this.lives - 1);
      this.lostAt = this.clock;
      if (!this.opts.calm) this.shake = Math.max(this.shake, 4);
      this.audio.sfx('lose');
    }
    this.setPhase('outro', outroDuration(g.id, won, this.level));
  }

  private afterOutro() {
    if (this.lives <= 0) {
      this.setPhase('over', OVER_S);
      this.audio.sfx('gameover');
      return;
    }
    if (this.speedPending) {
      this.speedPending = false;
      this.level = Math.min(MAX_LEVEL, this.level + 1);
      this.opts.onLevel?.(this.level);
      this.setPhase('speedup', SPEEDUP_S);
      this.audio.sfx('speedup');
      return;
    }
    if (this.bossPending) this.startBoss();
    else this.startPrompt();
  }

  private startPrompt() {
    this.deal(this.deck.next());
    this.setPhase('prompt', promptDuration(this.level));
    this.audio.sfx('prompt');
  }

  private startBoss() {
    this.bossPending = false;
    this.deal('boss');
    this.setPhase('boss', BOSS_INTRO_S);
    this.audio.sfx('boss');
    this.audio.king();
  }

  private deal(id: GameId) {
    const seen = this.plays[id] ?? 0;
    this.plays[id] = seen + 1;
    const ctx: GameCtx = {
      rng: new Rng(mixSeed(this.opts.seed, 1000 + this.stage)),
      level: this.level,
      duration: gameDuration(id, this.level),
      cast: this.opts.cast,
      partner: this.partner,
      seenBefore: seen,
      audio: this.audio,
      calm: !!this.opts.calm,
    };
    this.game = this.opts.create(id, ctx);
    this.stage++;
    this.history.push(id);
    this.result = null;
    for (const e of this.game.cast) this.meet(e);
  }

  private meet(e: RosterEntry) {
    if (this.met.has(e.speciesId)) return;
    this.met.set(e.speciesId, e);
    this.opts.onSeen?.(e);
  }
}
