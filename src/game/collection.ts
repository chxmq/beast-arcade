// The Tuner's collection: which species were seen and caught, shinies, tuner stats, level and the
// daily goal. Per-viewer convenience stored in localStorage (every access guarded); the game
// works the same without storage. The logic is pure and storage is injected, so it is unit tested.

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export interface SpeciesRecord {
  seen: number;
  caught: number;
  shiny: number;
  /** Epoch ms of the first catch (0 = never). */
  firstCaught: number;
}

export interface TunerStats {
  catches: number;
  runs: number;
  bestScore: number;
  bestCombo: number;
  /** Best score per channel id. */
  best: Record<string, number>;
}

export interface DailyState {
  date: string;
  goalId: string;
  progress: number;
  done: boolean;
}

export interface CollectionState {
  v: 1;
  species: Record<number, SpeciesRecord>;
  stats: TunerStats;
  daily: DailyState | null;
}

export const KEY = 'static.collection.v1';
const LEGACY_KEY = 'static.progress.v1';

// ------------------------------------------------------------------ tuner level

export const LEVEL_TITLES: readonly { from: number; title: string }[] = [
  { from: 1, title: 'Snow Watcher' },
  { from: 3, title: 'Dial Turner' },
  { from: 5, title: 'Signal Seeker' },
  { from: 7, title: 'Tuner' },
  { from: 9, title: 'Static Veteran' },
  { from: 12, title: 'Channel Master' },
];

/** Catches needed to reach level L: 5 * (L - 1) * L / 2  (L2 5, L3 15, L4 30, L5 50, L6 75 ...). */
export function catchesForLevel(level: number): number {
  const l = Math.max(1, Math.floor(level));
  return (5 * (l - 1) * l) / 2;
}

export function levelTitle(level: number): string {
  let t = LEVEL_TITLES[0].title;
  for (const b of LEVEL_TITLES) if (level >= b.from) t = b.title;
  return t;
}

export interface TunerLevel {
  level: number;
  title: string;
  /** Catches at the start of this level and at the start of the next. */
  base: number;
  next: number;
  /** 0..1 progress through this level. */
  frac: number;
}

export function tunerLevel(totalCatches: number): TunerLevel {
  const n = Math.max(0, Math.floor(totalCatches));
  let level = 1;
  while (catchesForLevel(level + 1) <= n) level++;
  const base = catchesForLevel(level);
  const next = catchesForLevel(level + 1);
  return { level, title: levelTitle(level), base, next, frac: (n - base) / (next - base) };
}

// ------------------------------------------------------------------ daily goal

export interface GoalDef {
  id: string;
  text: string;
  target: number;
  kind: 'type' | 'rare' | 'combo' | 'catches';
  type?: 0 | 1 | 2;
}

export const GOALS: readonly GoalDef[] = [
  { id: 'hunters3', text: 'Catch 3 Hunters', target: 3, kind: 'type', type: 1 },
  { id: 'magic3', text: 'Catch 3 Magic Beasts', target: 3, kind: 'type', type: 0 },
  { id: 'brutes3', text: 'Catch 3 Brutes', target: 3, kind: 'type', type: 2 },
  { id: 'rare1', text: 'Catch a rare', target: 1, kind: 'rare' },
  { id: 'rare3', text: 'Catch 3 rares', target: 3, kind: 'rare' },
  { id: 'combo15', text: 'Reach combo 15', target: 15, kind: 'combo' },
  { id: 'catch20', text: 'Catch 20 Beasts', target: 20, kind: 'catches' },
  { id: 'combo25', text: 'Reach combo 25', target: 25, kind: 'combo' },
];

export function goalById(id: string): GoalDef {
  return GOALS.find((g) => g.id === id) ?? GOALS[0];
}

/** Local calendar date as YYYY-MM-DD. */
export function dateKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** FNV-1a, so the same date picks the same goal for everyone. */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function dailyGoalFor(date: string): GoalDef {
  return GOALS[hashStr(`static-daily:${date}`) % GOALS.length];
}

export type GoalEvent = { kind: 'catch'; type: number; rare: boolean } | { kind: 'combo'; n: number };

/** Progress after one event. Catch goals add up across the day, combo goals keep the best. */
export function progressAfter(goal: GoalDef, progress: number, ev: GoalEvent): number {
  if (goal.kind === 'combo') return ev.kind === 'combo' ? Math.min(goal.target, Math.max(progress, ev.n)) : progress;
  if (ev.kind !== 'catch') return progress;
  const hit = goal.kind === 'catches' || (goal.kind === 'rare' && ev.rare) || (goal.kind === 'type' && ev.type === goal.type);
  return hit ? Math.min(goal.target, progress + 1) : progress;
}

// ------------------------------------------------------------------ state

function emptyState(): CollectionState {
  return { v: 1, species: {}, stats: { catches: 0, runs: 0, bestScore: 0, bestCombo: 0, best: {} }, daily: null };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** Accept anything that was stored, keep only what is well formed. */
export function normalizeState(raw: unknown): CollectionState {
  const out = emptyState();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<CollectionState>;
  if (r.species && typeof r.species === 'object') {
    for (const [k, v] of Object.entries(r.species)) {
      const id = Number(k);
      if (!Number.isInteger(id) || !v || typeof v !== 'object') continue;
      const s = v as Partial<SpeciesRecord>;
      out.species[id] = { seen: num(s.seen), caught: num(s.caught), shiny: num(s.shiny), firstCaught: num(s.firstCaught) };
    }
  }
  if (r.stats && typeof r.stats === 'object') {
    const s = r.stats as Partial<TunerStats>;
    out.stats = { catches: num(s.catches), runs: num(s.runs), bestScore: num(s.bestScore), bestCombo: num(s.bestCombo), best: {} };
    if (s.best && typeof s.best === 'object') for (const [k, v] of Object.entries(s.best)) out.stats.best[k] = num(v);
  }
  if (r.daily && typeof r.daily === 'object') {
    const d = r.daily as Partial<DailyState>;
    if (typeof d.date === 'string' && typeof d.goalId === 'string') {
      out.daily = { date: d.date, goalId: d.goalId, progress: num(d.progress), done: d.done === true };
    }
  }
  return out;
}

/** The v1 game kept `tuned` (kills per species), `seen`, `best`, `runs`. Carry it over once. */
export function migrateLegacy(raw: unknown): CollectionState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { tuned?: Record<string, unknown>; seen?: Record<string, unknown>; best?: unknown; runs?: unknown };
  const out = emptyState();
  let any = false;
  for (const [k, v] of Object.entries(r.seen ?? {})) {
    const id = Number(k);
    if (Number.isInteger(id)) { out.species[id] = { seen: num(v), caught: 0, shiny: 0, firstCaught: 0 }; any = true; }
  }
  for (const [k, v] of Object.entries(r.tuned ?? {})) {
    const id = Number(k);
    if (!Number.isInteger(id)) continue;
    const c = num(v);
    const s = (out.species[id] ??= { seen: c, caught: 0, shiny: 0, firstCaught: 0 });
    s.caught = c;
    s.seen = Math.max(s.seen, c);
    if (c > 0) s.firstCaught = 1;
    out.stats.catches += c;
    any = true;
  }
  out.stats.bestScore = num(r.best);
  out.stats.runs = num(r.runs);
  return any || out.stats.runs > 0 ? out : null;
}

export interface CatchInput {
  type: number;
  shiny: boolean;
  rare: boolean;
  now?: number;
}

export interface CatchResult {
  /** First time this species is caught. */
  isNew: boolean;
  /** First time a shiny of this species is caught. */
  newShiny: boolean;
  /** The daily goal was completed by this catch. */
  goalDone: boolean;
}

export interface Snapshot {
  catches: number;
  runs: number;
  caught: Set<number>;
  seen: Set<number>;
  shiny: Set<number>;
  daily: { goal: GoalDef; progress: number; done: boolean };
  level: TunerLevel;
}

export class Collection {
  state: CollectionState;

  constructor(private storage: StorageLike | null = null, private clock: () => Date = () => new Date()) {
    this.state = this.load();
  }

  private load(): CollectionState {
    const st = this.storage;
    if (!st) return emptyState();
    try {
      const raw = st.getItem(KEY);
      if (raw) return normalizeState(JSON.parse(raw));
    } catch {
      return emptyState();
    }
    try {
      const old = st.getItem(LEGACY_KEY);
      if (old) {
        const m = migrateLegacy(JSON.parse(old));
        if (m) return m;
      }
    } catch {
      /* ignore */
    }
    return emptyState();
  }

  save() {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* storage unavailable */
    }
  }

  record(id: number): SpeciesRecord {
    return (this.state.species[id] ??= { seen: 0, caught: 0, shiny: 0, firstCaught: 0 });
  }

  /** A Beast of this species surfaced. */
  seen(id: number) {
    this.record(id).seen += 1;
    this.save();
  }

  isSeen(id: number): boolean {
    const r = this.state.species[id];
    return !!r && (r.seen > 0 || r.caught > 0);
  }

  isCaught(id: number): boolean {
    return (this.state.species[id]?.caught ?? 0) > 0;
  }

  caughtIds(): Set<number> {
    const s = new Set<number>();
    for (const [k, v] of Object.entries(this.state.species)) if (v.caught > 0) s.add(Number(k));
    return s;
  }

  seenIds(): Set<number> {
    const s = new Set<number>();
    for (const [k, v] of Object.entries(this.state.species)) if (v.seen > 0 || v.caught > 0) s.add(Number(k));
    return s;
  }

  shinyIds(): Set<number> {
    const s = new Set<number>();
    for (const [k, v] of Object.entries(this.state.species)) if (v.shiny > 0) s.add(Number(k));
    return s;
  }

  distinctCaught(): number {
    return this.caughtIds().size;
  }

  /** Today's daily goal state, starting a fresh one when the date changed. */
  daily(): { goal: GoalDef; progress: number; done: boolean } {
    const date = dateKey(this.clock());
    let d = this.state.daily;
    if (!d || d.date !== date) {
      d = { date, goalId: dailyGoalFor(date).id, progress: 0, done: false };
      this.state.daily = d;
    }
    return { goal: goalById(d.goalId), progress: d.progress, done: d.done };
  }

  private bump(ev: GoalEvent): boolean {
    this.daily();
    const d = this.state.daily!;
    if (d.done) return false;
    const goal = goalById(d.goalId);
    d.progress = progressAfter(goal, d.progress, ev);
    if (d.progress >= goal.target) {
      d.done = true;
      return true;
    }
    return false;
  }

  /** A Beast was caught. */
  catch(id: number, c: CatchInput): CatchResult {
    const r = this.record(id);
    const isNew = r.caught === 0;
    const newShiny = c.shiny && r.shiny === 0;
    r.caught += 1;
    r.seen = Math.max(r.seen, 1);
    if (c.shiny) r.shiny += 1;
    if (isNew) r.firstCaught = c.now ?? this.clock().getTime();
    this.state.stats.catches += 1;
    const goalDone = this.bump({ kind: 'catch', type: c.type, rare: c.rare });
    this.save();
    return { isNew, newShiny, goalDone };
  }

  /** A hit raised the combo to `n`. Returns true when that completed the daily goal. */
  combo(n: number): boolean {
    const before = this.state.stats.bestCombo;
    if (n > before) this.state.stats.bestCombo = n;
    const d0 = this.state.daily?.progress;
    const done = this.bump({ kind: 'combo', n });
    if (done || n > before || this.state.daily?.progress !== d0) this.save();
    return done;
  }

  /** The run is over. Returns true when `score` is a new best on that channel. */
  finishRun(score: number, channelId: string): boolean {
    const s = this.state.stats;
    s.runs += 1;
    const prev = s.best[channelId] ?? 0;
    const isBest = score > prev;
    if (isBest) s.best[channelId] = score;
    if (score > s.bestScore) s.bestScore = score;
    this.save();
    return isBest;
  }

  bestFor(channelId: string): number {
    return this.state.stats.best[channelId] ?? 0;
  }

  snapshot(): Snapshot {
    const daily = this.daily();
    return {
      catches: this.state.stats.catches,
      runs: this.state.stats.runs,
      caught: this.caughtIds(),
      seen: this.seenIds(),
      shiny: this.shinyIds(),
      daily: { ...daily },
      level: tunerLevel(this.state.stats.catches),
    };
  }
}

function browserStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    localStorage.getItem(KEY);
    return localStorage;
  } catch {
    return null;
  }
}

export const collection = new Collection(browserStorage());
