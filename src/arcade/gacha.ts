// Prize counter rules: three capsule machines, their prices, pools, odds, shiny rates and the
// duplicate refund. Pure (no DOM, no storage) so the odds shown on screen are the odds used,
// computed from the live roster: a pool with no species simply drops out and the rest renormalise.
import type { Roster, RosterEntry } from '../data/roster.ts';

export type MachineId = 'basic' | 'rare' | 'legendary';

/** Our own registered species. Looked up in the roster, never assumed present. */
export const THE_STATIC_ID = 10091;

/** Share of the price paid back for a duplicate card. */
export const REFUND_RATE = 0.25;

export interface Pool {
  id: string;
  label: string;
  weight: number;
  member: (e: RosterEntry) => boolean;
}

export interface MachineDef {
  id: MachineId;
  name: string;
  price: number;
  /** One capsule in `shinyOneIn` holds a shiny card. */
  shinyOneIn: number;
  pools: Pool[];
}

const isStatic = (e: RosterEntry) => e.speciesId === THE_STATIC_ID;
const original = (e: RosterEntry) => !e.featured && !isStatic(e);
const hackathon = (e: RosterEntry) => e.featured && !isStatic(e);

export const MACHINES: readonly MachineDef[] = [
  {
    id: 'basic', name: 'BASIC', price: 100, shinyOneIn: 40,
    pools: [
      { id: 'orig-low', label: 'LOOT SURVIVOR T3-T5', weight: 82, member: (e) => original(e) && e.tier >= 3 },
      { id: 'orig-high', label: 'LOOT SURVIVOR T1-T2', weight: 14, member: (e) => original(e) && e.tier <= 2 },
      { id: 'hack', label: 'ART HACKATHON', weight: 4, member: hackathon },
    ],
  },
  {
    id: 'rare', name: 'RARE', price: 300, shinyOneIn: 12,
    pools: [
      { id: 'hack', label: 'ART HACKATHON', weight: 55, member: hackathon },
      { id: 'orig-high', label: 'LOOT SURVIVOR T1-T2', weight: 45, member: (e) => original(e) && e.tier <= 2 },
    ],
  },
  {
    id: 'legendary', name: 'LEGENDARY', price: 800, shinyOneIn: 5,
    pools: [
      { id: 'static', label: 'THE STATIC', weight: 8, member: isStatic },
      { id: 'hack-t1', label: 'ART HACKATHON T1', weight: 62, member: (e) => hackathon(e) && e.tier === 1 },
      { id: 'hack-rest', label: 'ART HACKATHON T2-T5', weight: 18, member: (e) => hackathon(e) && e.tier >= 2 },
      { id: 'orig-t1', label: 'LOOT SURVIVOR T1', weight: 12, member: (e) => original(e) && e.tier === 1 },
    ],
  },
];

export function machine(id: MachineId): MachineDef {
  const m = MACHINES.find((x) => x.id === id);
  if (!m) throw new Error(`unknown machine ${id}`);
  return m;
}

export function refundFor(id: MachineId): number {
  return Math.floor(machine(id).price * REFUND_RATE);
}

export interface PoolOdds {
  pool: Pool;
  members: RosterEntry[];
  /** Probability of this pool, 0..1, after empty pools dropped out. */
  p: number;
}

/** The live odds of a machine for this roster. Probabilities sum to 1 (empty list if nothing can drop). */
export function machineOdds(roster: Roster, id: MachineId): PoolOdds[] {
  const live = machine(id).pools
    .map((pool) => ({ pool, members: roster.entries.filter(pool.member) }))
    .filter((x) => x.members.length > 0 && x.pool.weight > 0);
  const total = live.reduce((s, x) => s + x.pool.weight, 0);
  return live.map((x) => ({ ...x, p: total ? x.pool.weight / total : 0 }));
}

/** Probability that one capsule holds this species (pool share / pool size, summed over pools). */
export function speciesChance(odds: readonly PoolOdds[], speciesId: number): number {
  let p = 0;
  for (const o of odds) if (o.members.some((e) => e.speciesId === speciesId)) p += o.p / o.members.length;
  return p;
}

export interface Prize {
  entry: RosterEntry;
  shiny: boolean;
  pool: Pool;
  /** Rare for the collection's goals: Art Hackathon, our species or tier 1-2. */
  rare: boolean;
}

export const isRarePrize = (e: RosterEntry) => e.featured || isStatic(e) || e.tier <= 2;

/** Open one capsule. `rng` returns [0, 1). Null only if the roster has nothing this machine can drop. */
export function drawPrize(roster: Roster, id: MachineId, rng: () => number = Math.random): Prize | null {
  const odds = machineOdds(roster, id);
  if (!odds.length) return null;
  let r = rng();
  let pick = odds[odds.length - 1];
  for (const o of odds) {
    if (r < o.p) { pick = o; break; }
    r -= o.p;
  }
  const entry = pick.members[Math.min(pick.members.length - 1, Math.floor(rng() * pick.members.length))];
  const shiny = rng() < 1 / machine(id).shinyOneIn;
  return { entry, shiny, pool: pick.pool, rare: isRarePrize(entry) };
}

/** A card you already had (same species, and not a first shiny of it) pays part of the price back. */
export function isDuplicate(r: { isNew: boolean; newShiny: boolean }): boolean {
  return !r.isNew && !r.newShiny;
}

/** "62%", "4.5%", "<1%". */
export function pct(p: number): string {
  const v = p * 100;
  if (v > 0 && v < 1) return '<1%';
  if (v < 10 && Math.abs(v - Math.round(v)) > 0.05) return `${v.toFixed(1)}%`;
  return `${Math.round(v)}%`;
}
