// Arcade tickets: earned by playing any cabinet, spent at the prize counter.
// Per-viewer and local by design (prizes are cards in your local book; ranked catches go onchain).

export const KEY = 'beastarcade.tickets.v1';
export const PAYOUT_KEY = 'beastarcade.payouts.v1';

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

type Listener = (balance: number, delta: number, reason: string) => void;

/** What one cabinet has paid out: the select screen shows real numbers, not promises. */
export interface PayoutStats {
  runs: number;
  total: number;
  best: number;
  last: number;
}

const EMPTY: PayoutStats = { runs: 0, total: 0, best: 0, last: 0 };

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export class Wallet {
  private value = 0;
  private listeners = new Set<Listener>();
  private source: string | null = null;
  private stats: Record<string, PayoutStats> = {};

  constructor(private storage: StorageLike | null = browserStorage()) {
    try {
      const raw = storage?.getItem(KEY);
      this.value = raw ? count(Number(raw)) : 0;
    } catch {
      this.value = 0;
    }
    try {
      const raw = storage?.getItem(PAYOUT_KEY);
      const j = raw ? (JSON.parse(raw) as Record<string, Partial<PayoutStats>>) : {};
      for (const [k, v] of Object.entries(j ?? {})) {
        if (v && typeof v === 'object') this.stats[k] = { runs: count(v.runs), total: count(v.total), best: count(v.best), last: count(v.last) };
      }
    } catch {
      this.stats = {};
    }
  }

  balance(): number {
    return this.value;
  }

  add(n: number, reason = 'play'): void {
    const d = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
    if (!d) return;
    this.value += d;
    if (this.source) {
      const s = (this.stats[this.source] ??= { ...EMPTY });
      s.runs += 1;
      s.total += d;
      s.last = d;
      s.best = Math.max(s.best, d);
    }
    this.save();
    this.emit(d, reason);
  }

  /** Returns false (and changes nothing) when the balance is too low. */
  spend(n: number, reason = 'prize'): boolean {
    const d = Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));
    if (d > this.value) return false;
    this.value -= d;
    this.save();
    this.emit(-d, reason);
    return true;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Which cabinet is on screen (set by the shell on every route change), so a payout can be
   * credited to the game that paid it. Null: not a game (prize refunds are not payouts).
   */
  setSource(id: string | null): void {
    this.source = id;
  }

  payouts(id: string): PayoutStats {
    return { ...(this.stats[id] ?? EMPTY) };
  }

  private emit(delta: number, reason: string) {
    for (const fn of [...this.listeners]) fn(this.value, delta, reason);
  }

  private save() {
    try {
      this.storage?.setItem(KEY, String(this.value));
      this.storage?.setItem(PAYOUT_KEY, JSON.stringify(this.stats));
    } catch {
      /* storage unavailable: tickets last for this session */
    }
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

export const tickets = new Wallet();
