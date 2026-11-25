import { rnd } from './rng.ts';
import {
  FEATURED_PCT, FIELD_H, FIELD_W, N_SPAWNS,
  PREFIX_DUSK, PREFIX_GALE, PREFIX_GLOOM, PREFIX_STORM, PREFIX_TEMPEST,
  SUFFIX_BANE, SUFFIX_PEAK, SUFFIX_SHADOW,
  MAX_ROSTER, SHINY_ONE_IN, T_AFFIX, T_LIFE, T_POS_X, T_POS_Y, T_SHINY, T_SPECIES, T_TICK, T_VEL,
  type BeastType,
} from './spec.ts';

/** SPEC §3. */
export interface SimRosterEntry {
  type: BeastType;
  tier: number;
  health: number;
  aggr: number;
  w: number;
  h: number;
  occ: bigint;
}

export interface Spawn {
  i: number;
  rosterIdx: number;
  entry: SimRosterEntry;
  boss: boolean;
  featured: boolean;
  spawnTick: number;
  escapeTick: number;
  lvl: number;
  prefix: number;
  suffix: number;
  swift: boolean;
  faint: boolean;
  peak: boolean;
  bane: boolean;
  shiny: boolean;
  vx: number;
  vy: number;
  dirX: number;
  dirY: number;
  x0: number;
  y0: number;
  Lx: number;
  Ly: number;
  hp: number;
  /** Lives lost when this Beast gets away. */
  escapeCost: number;
}

export function aggrFromKills(k: number): number {
  if (k <= 0) return 0;
  if (k < 3) return 1;
  if (k < 7) return 2;
  return 3;
}

/** SPEC §5: the full spawn schedule, a pure function of (seed, roster, nFeatured). */
export function buildSchedule(seed: bigint, roster: SimRosterEntry[], nFeatured: number): Spawn[] {
  const nF = BigInt(nFeatured);
  const nC = BigInt(roster.length - nFeatured);
  if (roster.length === 0) throw new Error('empty roster');
  if (roster.length > MAX_ROSTER) throw new Error('roster too long');
  const out: Spawn[] = [];
  for (let i = 0; i < N_SPAWNS; i++) {
    const boss = i === N_SPAWNS - 1;
    const spawnTick = 30 + 84 * i - Math.floor((3 * i * i) / 5) + Number(rnd(seed, T_TICK, i) % 20n);

    const r = rnd(seed, T_SPECIES, i);
    let rosterIdx: number;
    if (nF === 0n) rosterIdx = Number(r % nC);
    else if (nC === 0n || boss) rosterIdx = Number(r % nF);
    else if (r % 100n < BigInt(FEATURED_PCT)) rosterIdx = Number((r / 100n) % nF);
    else rosterIdx = Number(nF + ((r / 100n) % nC));
    const featured = rosterIdx < nFeatured;
    const entry = roster[rosterIdx];

    const lvl = 1 + Math.floor(i / 4) + entry.aggr;
    let prefix = 0;
    let suffix = 0;
    if (lvl >= 6) {
      const ra = rnd(seed, T_AFFIX, i);
      prefix = 1 + Number(ra % 69n);
      suffix = 1 + Number((ra / 69n) % 18n);
    }
    const swift = prefix === PREFIX_GALE || prefix === PREFIX_STORM || prefix === PREFIX_TEMPEST;
    const faint = prefix === PREFIX_DUSK || prefix === PREFIX_GLOOM || suffix === SUFFIX_SHADOW;
    const peak = suffix === SUFFIX_PEAK;
    const bane = suffix === SUFFIX_BANE;
    const shiny = rnd(seed, T_SHINY, i) % SHINY_ONE_IN === 0n;

    const rv = rnd(seed, T_VEL, i);
    let vx: number;
    let vy: number;
    if (entry.type === 0) {
      vx = 4 + Number(rv % 4n) + 2 * entry.aggr;
      vy = 4 + Number((rv >> 8n) % 4n) + entry.aggr;
    } else if (entry.type === 1) {
      vx = 8 + Number(rv % 5n) + 2 * entry.aggr;
      vy = 1 + Number((rv >> 8n) % 2n) + entry.aggr;
    } else {
      vx = 3 + Number(rv % 3n) + entry.aggr;
      vy = 2 + Number((rv >> 8n) % 3n) + entry.aggr;
    }
    if (swift) {
      vx = Math.floor((vx * 3) / 2);
      vy = Math.floor((vy * 3) / 2);
    }
    const dirX = Number((rv >> 16n) & 1n);
    const dirY = Number((rv >> 17n) & 1n);

    const Lx = (FIELD_W - entry.w) * 16;
    const Ly = (FIELD_H - entry.h) * 16;
    const x0 = Number(rnd(seed, T_POS_X, i) % BigInt(Lx + 1));
    const y0 = Number(rnd(seed, T_POS_Y, i) % BigInt(Ly + 1));

    const rl = rnd(seed, T_LIFE, i);
    const life = boss ? 360 + Number(rl % 60n) : 180 - 2 * i + Number(rl % 40n) - 10 * entry.aggr;
    const escapeTick = spawnTick + life;

    let hp = boss ? 8 : featured ? 2 : 1;
    if (entry.health >= 150) hp += 1;
    if (peak) hp += 1;
    const escapeCost = bane ? 2 : 1;

    out.push({
      i, rosterIdx, entry, boss, featured, spawnTick, escapeTick, lvl, prefix, suffix,
      swift, faint, peak, bane, shiny, vx, vy, dirX, dirY, x0, y0, Lx, Ly, hp, escapeCost,
    });
  }
  return out;
}
