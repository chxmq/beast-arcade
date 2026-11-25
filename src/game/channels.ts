// Channels are BEAST CATCH habitats: each one is a sub-roster of the Beast roster. A hunt in a habitat
// runs the normal sim on that sub-roster (rares first, which the sim treats as its "featured" slots), so
// the Beasts that surface belong to a place and the player can aim at completing it.
// Pure: no DOM, no storage.
import { simEntryOf, type Roster, type RosterEntry, type SimRosterEntry } from '../data/roster.ts';
import { MAX_ROSTER } from '../sim/spec.ts';

export type ChannelId = 'snowfall' | 'magic' | 'hunter' | 'brute' | 'hackathon' | 'king';

/** A channel needs at least this many species to be worth a hunt. */
export const MIN_CHANNEL_SPECIES = 8;
/** Distinct species a Tuner must have caught to open the King channel. */
export const KING_UNLOCK_SPECIES = 10;

interface ChannelDef {
  id: ChannelId;
  num: number;
  /** Short tag for tabs and the HUD. */
  label: string;
  name: string;
  lore: string;
  unlockSpecies: number;
  member: (e: RosterEntry) => boolean;
  /** Rare slots: 2 hp, 45% of spawns, leave sooner. The King is drawn from here. */
  rare: (e: RosterEntry) => boolean;
}

export const CHANNEL_DEFS: readonly ChannelDef[] = [
  {
    id: 'snowfall', num: 1, label: 'SNOW', name: 'SNOWFALL', lore: 'Deep snow and slow tempers. The gentle start.', unlockSpecies: 0,
    member: (e) => !e.featured && e.tier >= 4, rare: () => false,
  },
  {
    id: 'magic', num: 2, label: 'MAGIC', name: 'MAGIC GROVE', lore: 'Things that should not float, under a sky full of stars.', unlockSpecies: 0,
    member: (e) => e.type === 0, rare: (e) => e.featured || e.tier === 1,
  },
  {
    id: 'hunter', num: 3, label: 'HUNTER', name: 'HUNTER PLAINS', lore: 'Fast and sideways. Blink and they are gone.', unlockSpecies: 0,
    member: (e) => e.type === 1, rare: (e) => e.featured || e.tier === 1,
  },
  {
    id: 'brute', num: 4, label: 'BRUTE', name: 'BRUTE QUARRY', lore: 'Heavy, stomping, patient. Big targets that hit back hard.', unlockSpecies: 0,
    member: (e) => e.type === 2, rare: (e) => e.featured || e.tier === 1,
  },
  {
    id: 'hackathon', num: 5, label: 'ART', name: 'ART HACKATHON', lore: 'Drawn by hand, then set loose. Fussy, rare, worth it.', unlockSpecies: 0,
    member: (e) => e.featured, rare: (e) => e.tier <= 2,
  },
  {
    id: 'king', num: 6, label: 'KING', name: "KING'S HALL", lore: 'Every Beast in one hall. The King waits at the end.', unlockSpecies: KING_UNLOCK_SPECIES,
    member: () => true, rare: (e) => e.featured || e.tier === 1,
  },
];

export interface Channel {
  id: ChannelId;
  num: number;
  /** Short tag: "SNOW", "MAGIC" ... */
  label: string;
  name: string;
  lore: string;
  /** Distinct species caught needed to open this channel (0 = always open). */
  unlockSpecies: number;
  /** Species of the channel, rares first, then the rest, each group in roster order. Index = the run's rosterIdx. */
  entries: RosterEntry[];
  speciesIds: number[];
  nRares: number;
}

/** What `new Run(seed, run.sim, run.nRares)` takes, plus the mapping back to species. */
export interface ChannelRun {
  channel: Channel;
  sim: SimRosterEntry[];
  nRares: number;
  entries: RosterEntry[];
}

/** Build every channel that has enough species. Deterministic: same roster, same channels. */
export function buildChannels(roster: Roster): Channel[] {
  const out: Channel[] = [];
  for (const def of CHANNEL_DEFS) {
    const members = roster.entries.filter(def.member);
    if (members.length < MIN_CHANNEL_SPECIES || members.length > MAX_ROSTER) continue;
    const rares = members.filter(def.rare);
    const rest = members.filter((e) => !def.rare(e));
    const entries = [...rares, ...rest];
    out.push({
      id: def.id,
      num: def.num,
      label: def.label,
      name: def.name,
      lore: def.lore,
      unlockSpecies: def.unlockSpecies,
      entries,
      speciesIds: entries.map((e) => e.speciesId),
      nRares: rares.length,
    });
  }
  return out;
}

const runCache = new WeakMap<Channel, ChannelRun>();

export function channelRun(channel: Channel): ChannelRun {
  let r = runCache.get(channel);
  if (!r) {
    r = { channel, sim: channel.entries.map((e) => simEntryOf(e)), nRares: channel.nRares, entries: channel.entries };
    runCache.set(channel, r);
  }
  return r;
}

export function channelById(channels: readonly Channel[], id: ChannelId | undefined): Channel {
  return channels.find((c) => c.id === id) ?? channels[0];
}

export function isUnlocked(channel: Channel, distinctCaught: number): boolean {
  return distinctCaught >= channel.unlockSpecies;
}

/** Species of a channel that appear in `caught`. */
export function channelCaught(channel: Channel, caught: ReadonlySet<number>): number {
  let n = 0;
  for (const id of channel.speciesIds) if (caught.has(id)) n++;
  return n;
}

/** Channels a species lives in (for the Bestiary). */
export function channelsOf(channels: readonly Channel[], speciesId: number): Channel[] {
  return channels.filter((c) => c.speciesIds.includes(speciesId));
}

/** True when sub-roster index `rosterIdx` is one of the channel's rare slots. */
export const isRareSlot = (channel: Channel, rosterIdx: number) => rosterIdx < channel.nRares;
