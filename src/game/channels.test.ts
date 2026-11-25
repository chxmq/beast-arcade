import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodeMask, computeOcc, type Roster, type RosterEntry } from '../data/roster.ts';
import { Run } from '../sim/replay.ts';
import { MAX_ROSTER, N_SPAWNS } from '../sim/spec.ts';
import { buildChannels, channelById, channelCaught, channelRun, channelsOf, isRareSlot, isUnlocked, KING_UNLOCK_SPECIES, MIN_CHANNEL_SPECIES } from './channels.ts';
import { dexIndex, dexLabel, onchainView, simOrder, speciesInMask } from './dex.ts';

function entry(i: number, over: Partial<RosterEntry>): RosterEntry {
  const mask = new Uint8Array(64).fill(1);
  return {
    speciesId: i, name: `B${i}`, featured: false, type: 0, tier: 3, health: 100, level: 1, kills: 0, aggr: 0,
    creator: '0x1', owner: '0x1', description: '', genesisTokenId: '0x1', art: `beasts/${i}.png`, gif: `beasts/${i}.gif`,
    artW: 8, artH: 8, frames: 1, artBox: [0, 0, 8, 8], w: 8, h: 8, mask: encodeMask(mask, 8, 8),
    occ: '0x' + computeOcc(mask, 8, 8).toString(16), maskWarning: null, ...over,
  };
}

/** Featured first like the generated roster: 10 featured, 60 originals over all types and tiers. */
function fakeRoster(): Roster {
  const entries: RosterEntry[] = [];
  for (let i = 0; i < 10; i++) entries.push(entry(10000 + i, { featured: true, type: (i % 3) as 0 | 1 | 2, tier: 1 + (i % 5) }));
  for (let i = 0; i < 60; i++) entries.push(entry(i + 1, { type: (i % 3) as 0 | 1 | 2, tier: 1 + (Math.floor(i / 3) % 5) }));
  return { version: 1, generatedAt: '', network: '', nft: '', registry: '', nFeatured: 10, entries };
}

describe('channels (synthetic roster)', () => {
  const roster = fakeRoster();
  const channels = buildChannels(roster);

  it('builds every channel with at least the minimum species, in order', () => {
    expect(channels.map((c) => c.id)).toEqual(['snowfall', 'magic', 'hunter', 'brute', 'hackathon', 'king']);
    for (const c of channels) expect(c.entries.length).toBeGreaterThanOrEqual(MIN_CHANNEL_SPECIES);
    expect(channels.map((c) => c.label)).toEqual(['SNOW', 'MAGIC', 'HUNTER', 'BRUTE', 'ART', 'KING']);
  });

  it('is deterministic', () => {
    const again = buildChannels(roster);
    expect(again.map((c) => c.speciesIds)).toEqual(channels.map((c) => c.speciesIds));
    expect(again.map((c) => c.nRares)).toEqual(channels.map((c) => c.nRares));
  });

  it('snowfall is originals of tier 4-5 with no rares', () => {
    const c = channelById(channels, 'snowfall');
    expect(c.nRares).toBe(0);
    for (const e of c.entries) { expect(e.featured).toBe(false); expect(e.tier).toBeGreaterThanOrEqual(4); }
  });

  it('type bands hold every species of the type, rares first', () => {
    for (const [id, t] of [['magic', 0], ['hunter', 1], ['brute', 2]] as const) {
      const c = channelById(channels, id);
      expect(c.entries.length).toBe(roster.entries.filter((e) => e.type === t).length);
      c.entries.forEach((e, i) => {
        expect(e.type).toBe(t);
        expect(isRareSlot(c, i)).toBe(e.featured || e.tier === 1);
      });
    }
  });

  it('hackathon is the featured species, rares are tier <= 2', () => {
    const c = channelById(channels, 'hackathon');
    expect(c.entries.every((e) => e.featured)).toBe(true);
    expect(c.entries.length).toBe(roster.nFeatured);
    c.entries.forEach((e, i) => expect(isRareSlot(c, i)).toBe(e.tier <= 2));
  });

  it('king channel has every species and unlocks after the right number of species', () => {
    const c = channelById(channels, 'king');
    expect(c.entries.length).toBe(roster.entries.length);
    expect(isUnlocked(c, KING_UNLOCK_SPECIES - 1)).toBe(false);
    expect(isUnlocked(c, KING_UNLOCK_SPECIES)).toBe(true);
    expect(isUnlocked(channels[0], 0)).toBe(true);
  });

  it('sub-roster index maps back to the species, and the run draws only from it', () => {
    for (const c of channels) {
      const cr = channelRun(c);
      expect(cr.sim.length).toBe(c.entries.length);
      expect(c.entries.length).toBeLessThanOrEqual(MAX_ROSTER);
      const run = new Run(12345n, cr.sim, cr.nRares);
      expect(run.spawns.length).toBe(N_SPAWNS);
      for (const s of run.spawns) {
        const e = c.entries[s.rosterIdx];
        expect(c.speciesIds[s.rosterIdx]).toBe(e.speciesId);
        expect(s.entry.type).toBe(e.type);
        expect(s.entry.tier).toBe(e.tier);
        expect(s.featured).toBe(isRareSlot(c, s.rosterIdx));
      }
      // the King is drawn from the rares when a channel has some
      const king = run.spawns[N_SPAWNS - 1];
      if (c.nRares > 0) expect(king.rosterIdx).toBeLessThan(c.nRares);
    }
  });

  it('counts caught species per channel and finds a species\' channels', () => {
    const hunter = channelById(channels, 'hunter');
    const caught = new Set([hunter.speciesIds[0], hunter.speciesIds[1], 999999]);
    expect(channelCaught(hunter, caught)).toBe(2);
    expect(channelsOf(channels, hunter.speciesIds[0]).map((c) => c.id)).toContain('king');
    expect(channelsOf(channels, hunter.speciesIds[0]).map((c) => c.id)).toContain('hunter');
  });

  it('drops a channel that has too few species', () => {
    const small: Roster = { ...roster, entries: roster.entries.slice(0, 12), nFeatured: 10 };
    const ids = buildChannels(small).map((c) => c.id);
    expect(ids).not.toContain('snowfall');
    expect(ids).not.toContain('brute');
    expect(ids).toContain('king');
  });
});

describe('dex numbering and onchain mask', () => {
  const roster = fakeRoster();
  it('numbers entries in roster order, three digits', () => {
    expect(dexLabel(0)).toBe('#001');
    expect(dexLabel(11)).toBe('#012');
    expect(dexLabel(97)).toBe('#098');
    expect(dexLabel(1234)).toBe('#1235');
    const idx = dexIndex(roster.entries);
    expect(idx.get(roster.entries[11].speciesId)).toBe(11);
    expect(idx.size).toBe(roster.entries.length);
  });
  it('maps mask bits to species by sim order', () => {
    const order = simOrder(roster);
    const set = speciesInMask(roster, (1n << 0n) | (1n << 12n));
    expect(set).toEqual(new Set([order[0].speciesId, order[12].speciesId]));
    const v = onchainView(roster, { caught: 0b101n, shiny: 0b100n, catches: 7 });
    expect(v.caught.size).toBe(2);
    expect(v.shiny).toEqual(new Set([order[2].speciesId]));
    expect(v.catches).toBe(7);
  });
});

const ROSTER_PATH = new URL('../../public/data/roster.json', import.meta.url);
describe.runIf(existsSync(ROSTER_PATH))('channels over public/data/roster.json', () => {
  const roster = JSON.parse(readFileSync(ROSTER_PATH, 'utf8')) as Roster;
  const channels = buildChannels(roster);
  it('has all six channels, each with enough species, and the King channel covers the whole roster', () => {
    expect(channels.map((c) => c.id)).toEqual(['snowfall', 'magic', 'hunter', 'brute', 'hackathon', 'king']);
    for (const c of channels) expect(c.entries.length).toBeGreaterThanOrEqual(MIN_CHANNEL_SPECIES);
    expect(channelById(channels, 'king').entries.length).toBe(roster.entries.length);
    expect(channelById(channels, 'hackathon').entries.length).toBe(roster.nFeatured);
  });
  it('every channel simulates and the mapping is consistent', () => {
    for (const c of channels) {
      const cr = channelRun(c);
      const run = new Run(777n, cr.sim, cr.nRares);
      for (const s of run.spawns) expect(roster.entries.find((e) => e.speciesId === c.speciesIds[s.rosterIdx])!.type).toBe(s.entry.type);
    }
  });
  it('dex order is the sim order (featured first), so onchain bits line up', () => {
    expect(simOrder(roster).map((e) => e.speciesId)).toEqual(roster.entries.map((e) => e.speciesId));
  });
});
