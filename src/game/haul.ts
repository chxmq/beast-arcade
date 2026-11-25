// What a hunt brought home, as pure data for the Haul screen: the cards and the ticket payout.
import type { CatchKind } from './ceremony.ts';

export interface CatchLike {
  speciesId: number;
  shiny: boolean;
  isNew: boolean;
  kind: CatchKind;
}

export interface HaulCard {
  speciesId: number;
  count: number;
  shiny: boolean;
  isNew: boolean;
  king: boolean;
}

/** Group the catches by species, in the order each species was first caught. */
export function haulCards(catches: readonly CatchLike[]): HaulCard[] {
  const m = new Map<number, HaulCard>();
  for (const c of catches) {
    const cur = m.get(c.speciesId);
    if (cur) {
      cur.count += 1;
      cur.shiny ||= c.shiny;
      cur.isNew ||= c.isNew;
      cur.king ||= c.kind === 'king';
    } else {
      m.set(c.speciesId, { speciesId: c.speciesId, count: 1, shiny: c.shiny, isNew: c.isNew, king: c.kind === 'king' });
    }
  }
  return [...m.values()];
}

/** Species ids in `after` but not in `before`. */
export function addedSpecies(before: ReadonlySet<number>, after: ReadonlySet<number>): number[] {
  return [...after].filter((id) => !before.has(id));
}

// ------------------------------------------------------------------ tickets

export const TICKETS_PER_CATCH = 5;
export const TICKETS_PER_SHINY = 25;
export const TICKETS_FOR_KING = 100;
export const SWEEP_MULTIPLIER = 2;

export interface PayoutLine {
  label: string;
  tickets: number;
}

export interface Payout {
  catches: number;
  shinies: number;
  king: boolean;
  sweep: boolean;
  /** Before the clean-sweep multiplier. */
  subtotal: number;
  total: number;
  /** What the ticket strip prints, in order. The sweep line is the extra it adds. */
  lines: PayoutLine[];
}

/**
 * BEAST CATCH pays 5 tickets per catch, +25 per shiny, +100 for the King, and doubles the lot for a
 * clean sweep (every Beast of the run caught). Paid once per run, at the end.
 */
export function catchPayout(catches: readonly Pick<CatchLike, 'shiny' | 'kind'>[], sweep: boolean): Payout {
  const n = catches.length;
  const shinies = catches.filter((c) => c.shiny).length;
  const king = catches.some((c) => c.kind === 'king');
  const lines: PayoutLine[] = [];
  if (n) lines.push({ label: `${n} CATCH${n === 1 ? '' : 'ES'} x${TICKETS_PER_CATCH}`, tickets: n * TICKETS_PER_CATCH });
  if (shinies) lines.push({ label: `${shinies} SHINY`, tickets: shinies * TICKETS_PER_SHINY });
  if (king) lines.push({ label: 'THE KING', tickets: TICKETS_FOR_KING });
  const subtotal = lines.reduce((a, l) => a + l.tickets, 0);
  const total = sweep && subtotal > 0 ? subtotal * SWEEP_MULTIPLIER : subtotal;
  if (total > subtotal) lines.push({ label: `CLEAN SWEEP x${SWEEP_MULTIPLIER}`, tickets: total - subtotal });
  return { catches: n, shinies, king, sweep: sweep && subtotal > 0, subtotal, total, lines };
}

/**
 * How the strip prints `total` tickets: one stub per `per` tickets, at most `maxStubs` stubs,
 * so a big haul prints fast and a small one ticks out stub by stub.
 */
export function stripPlan(total: number, maxStubs = 24): { stubs: number; per: number } {
  const t = Math.max(0, Math.floor(total));
  if (!t) return { stubs: 0, per: 0 };
  const per = Math.max(TICKETS_PER_CATCH, Math.ceil(t / maxStubs / TICKETS_PER_CATCH) * TICKETS_PER_CATCH);
  return { stubs: Math.ceil(t / per), per };
}

export const RANKED_PER_CATCH = 10;
export const RANKED_KING = 100;

/**
 * HUMAN EYES pays more per catch (no feedback, every run replayed onchain): 10 tickets a catch,
 * +100 for the King, doubled for a clean sweep. Paid once per submitted run, on DECODE.
 */
export function rankedPayout(kills: number, king: boolean, sweep: boolean): Payout {
  const n = Math.max(0, Math.floor(kills));
  const lines: PayoutLine[] = [];
  if (n) lines.push({ label: `${n} CATCH${n === 1 ? '' : 'ES'} x${RANKED_PER_CATCH}`, tickets: n * RANKED_PER_CATCH });
  if (king && n) lines.push({ label: 'THE KING', tickets: RANKED_KING });
  const subtotal = lines.reduce((a, l) => a + l.tickets, 0);
  const total = sweep && subtotal > 0 ? subtotal * SWEEP_MULTIPLIER : subtotal;
  if (total > subtotal) lines.push({ label: `CLEAN SWEEP x${SWEEP_MULTIPLIER}`, tickets: total - subtotal });
  return { catches: n, shinies: 0, king: king && n > 0, sweep: sweep && subtotal > 0, subtotal, total, lines };
}
