// The cast of MICRO MAYHEM: the real roster, sorted into the pools the microgames draw from,
// plus the Loot Survivor type triangle (Magic beats Brute beats Hunter beats Magic).
import type { BeastType, RosterEntry } from '../data/roster.ts';
import type { Rng } from './rng.ts';

export const MAGIC: BeastType = 0;
export const HUNTER: BeastType = 1;
export const BRUTE: BeastType = 2;

export const TYPE_LABEL = ['MAGIC', 'HUNTER', 'BRUTE'] as const;

/** The cabinet buttons double as the three types: A = MAGIC, B = HUNTER, C = BRUTE. */
export type TypeButton = 'A' | 'B' | 'C';
export const TYPE_BUTTON: readonly TypeButton[] = ['A', 'B', 'C'];
export const BUTTON_TYPE: Record<TypeButton, BeastType> = { A: 0, B: 1, C: 2 };

/** True when type `a` wins against type `b`. */
export function beats(a: BeastType, b: BeastType): boolean {
  return (a === MAGIC && b === BRUTE) || (a === BRUTE && b === HUNTER) || (a === HUNTER && b === MAGIC);
}

/** The type that beats `t`. */
export function counterOf(t: BeastType): BeastType {
  return t === BRUTE ? MAGIC : t === HUNTER ? BRUTE : HUNTER;
}

/** The type that `t` beats. */
export function preyOf(t: BeastType): BeastType {
  return t === MAGIC ? BRUTE : t === BRUTE ? HUNTER : MAGIC;
}

export function asType(n: number): BeastType {
  return (n === 1 ? 1 : n === 2 ? 2 : 0) as BeastType;
}

const artMax = (e: RosterEntry) => Math.max(e.artBox[2], e.artBox[3]);

/** "KING SCYTHAN"; a name that already starts with "The" stands on its own ("THE STATIC"). */
export function kingTitle(e: Pick<RosterEntry, 'name'>): string {
  const n = e.name.toUpperCase();
  return /^THE\s/.test(n) ? n : `KING ${n}`;
}

/** Integer art scale so the sprite is about `target` logical px on its long side (never below 1). */
export function artScale(e: RosterEntry, target: number): number {
  return Math.max(1, Math.round(target / Math.max(1, artMax(e))));
}

export class Cast {
  readonly all: RosterEntry[];
  readonly featured: RosterEntry[];
  readonly commons: RosterEntry[];
  readonly byType: [RosterEntry[], RosterEntry[], RosterEntry[]];
  /** Kings: tier 1 Art Hackathon species (the strongest, and the stars of the show). */
  readonly kings: RosterEntry[];
  /** Clean silhouettes, safe for the HUMAN EYES microgame. */
  readonly eyes: RosterEntry[];
  /** 32 px art: small sprites (partner, crowds). */
  readonly small: RosterEntry[];

  constructor(entries: readonly RosterEntry[]) {
    if (!entries.length) throw new Error('Cast: empty roster');
    this.all = entries.slice();
    this.featured = this.all.filter((e) => e.featured);
    this.commons = this.all.filter((e) => !e.featured);
    this.byType = [0, 1, 2].map((t) => this.all.filter((e) => e.type === t)) as [RosterEntry[], RosterEntry[], RosterEntry[]];
    for (let t = 0; t < 3; t++) if (!this.byType[t].length) this.byType[t] = this.all.slice();
    const kings = this.featured.filter((e) => e.tier === 1);
    this.kings = kings.length ? kings : this.all.filter((e) => e.tier === 1).length ? this.all.filter((e) => e.tier === 1) : this.all.slice();
    const eyes = this.all.filter((e) => !e.maskWarning && e.w >= 20 && e.h >= 20);
    this.eyes = eyes.length ? eyes : this.all.slice();
    const small = this.all.filter((e) => artMax(e) <= 40);
    this.small = small.length ? small : this.all.slice();
  }

  /** Any species; Art Hackathon species with probability `pf` (when there are any). */
  any(rng: Rng, pf = 0.5, pool: readonly RosterEntry[] = this.all): RosterEntry {
    const f = pool.filter((e) => e.featured);
    const c = pool.filter((e) => !e.featured);
    if (f.length && (rng.chance(pf) || !c.length)) return rng.pick(f);
    return rng.pick(c.length ? c : pool);
  }

  ofType(rng: Rng, t: BeastType, pf = 0.5): RosterEntry {
    return this.any(rng, pf, this.byType[t]);
  }

  king(rng: Rng): RosterEntry {
    return rng.pick(this.kings);
  }

  /** `n` distinct species from `pool` (repeats only when the pool is too small). */
  distinct(rng: Rng, n: number, pool: readonly RosterEntry[] = this.all): RosterEntry[] {
    const bag = rng.shuffle(pool.slice());
    const out: RosterEntry[] = [];
    for (let i = 0; i < n; i++) out.push(bag[i % bag.length]);
    return out;
  }
}
