// Dex numbering and the onchain mask mapping. Pure.
import type { Roster, RosterEntry } from '../data/roster.ts';
import type { OnchainDex } from '../chain/dex.ts';

/** "#012": the Dex number of the entry at roster position `index` (0-based). */
export function dexLabel(index: number): string {
  return `#${String(index + 1).padStart(3, '0')}`;
}

/** speciesId -> 0-based roster position (the Dex number minus one). */
export function dexIndex(entries: readonly RosterEntry[]): Map<number, number> {
  const m = new Map<number, number>();
  entries.forEach((e, i) => m.set(e.speciesId, i));
  return m;
}

/**
 * Sim roster order (featured first, then common), which is what the contract's caught_mask bits
 * index. The generated roster is already in this order, but never rely on it.
 */
export function simOrder(roster: Roster): RosterEntry[] {
  return [...roster.entries.filter((e) => e.featured), ...roster.entries.filter((e) => !e.featured)];
}

/** Species ids set in an onchain mask (bit r = sim roster index r). */
export function speciesInMask(roster: Roster, mask: bigint): Set<number> {
  const out = new Set<number>();
  simOrder(roster).forEach((e, r) => {
    if ((mask >> BigInt(r)) & 1n) out.add(e.speciesId);
  });
  return out;
}

export interface OnchainView {
  caught: Set<number>;
  shiny: Set<number>;
  catches: number;
}

export function onchainView(roster: Roster, dex: OnchainDex): OnchainView {
  return { caught: speciesInMask(roster, dex.caught), shiny: speciesInMask(roster, dex.shiny), catches: dex.catches };
}
