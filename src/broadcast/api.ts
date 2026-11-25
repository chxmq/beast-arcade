// JSON shapes of /api/broadcast/*, shared by the server handlers and the browser client.
// Felts travel as 0x-hex strings.

import type { RunResult } from '../sim/replay.ts';
import type { SimRosterEntry } from '../sim/schedule.ts';
import type { TapeSlot } from './tape.ts';

export interface BoardRow {
  callsign: string;
  score: number;
  runId: number;
  player: string;
}

export interface StatusResponse {
  onAir: boolean;
  /** No contract configured: local test mode, runs are not sent to Starknet. */
  offchain?: boolean;
  /** Why the broadcast is off air (when onAir is false). */
  reason?: string;
  rootId: number;
  day: number;
  n: number;
  /** ms since epoch */
  expiresAt: number;
  board: BoardRow[];
  contract?: string;
}

export interface StartRequest {
  pub: string;
  /** Client entropy; the server mixes in its own and returns the nonce to sign. */
  nonce: string;
}

export interface StartResponse {
  ticket: string;
  rootId: number;
  k: number;
  /** The nonce to sign: poseidon([client nonce, server salt]); k = poseidon([pub, nonce]) mod n. */
  nonce: string;
  /** Server time (ms) at which frame 0 plays. */
  t0: number;
  /** Server time (ms) when this response was made (clock offset estimate). */
  now: number;
  fps: number;
  segFrames: number;
  frames: number;
  w: number;
  h: number;
}

export interface SubmitRequest {
  ticket: string;
  callsign: string;
  strikes: number[];
  sig: { r: string; s: string };
}

export interface RosterSlotJson {
  speciesId: number;
  type: number;
  tier: number;
  health: number;
  aggr: number;
  w: number;
  h: number;
  occ: string;
}

/** SPEC v2 §10 RunResult; `killer` / `killerRoster` are 255 when the player survived or jammed. */
export interface RunResultJson {
  score: number;
  kills: number;
  lives: number;
  dead: boolean;
  deathTick: number;
  killer: number;
  killerRoster: number;
  bestCombo: number;
  /** SPEC v3 u128 bitmaps of roster indices caught / caught as a shiny (0x-hex, bigint safe). */
  caughtMask: string;
  shinyMask: string;
  digest: string;
}

/** u128 bitmap <-> 0x-hex string (JSON has no bigint). */
export const maskToHex = (m: bigint): string => '0x' + m.toString(16);

/** Lenient decode: a missing or malformed value is the empty mask; only the low 128 bits count. */
export function maskFromHex(v: unknown): bigint {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) return 0n;
  return BigInt(v) & ((1n << 128n) - 1n);
}

/** Roster indices with their bit set, ascending. */
export function maskBits(m: bigint): number[] {
  const out: number[] = [];
  for (let i = 0; m > 0n; i++, m >>= 1n) if (m & 1n) out.push(i);
  return out;
}

export function resultToJson(r: RunResult): RunResultJson {
  return {
    score: r.score, kills: r.kills, lives: r.lives, dead: r.dead, deathTick: r.deathTick,
    killer: r.killer, killerRoster: r.killerRoster, bestCombo: r.bestCombo,
    caughtMask: maskToHex(r.caughtMask), shinyMask: maskToHex(r.shinyMask), digest: '0x' + r.digest.toString(16),
  };
}

export interface SubmitResponse {
  txHash: string | null;
  offchain?: boolean;
  contract?: string;
  /** Revealed only now. */
  seed: string;
  rootId: number;
  k: number;
  nonce: string;
  root: string;
  proof: string[];
  roster: RosterSlotJson[];
  nFeatured: number;
  result: RunResultJson;
}

export function slotToJson(s: TapeSlot): RosterSlotJson {
  const e = s.entry;
  return { speciesId: s.speciesId, type: e.type, tier: e.tier, health: e.health, aggr: e.aggr, w: e.w, h: e.h, occ: '0x' + e.occ.toString(16) };
}

export function slotFromJson(j: RosterSlotJson): TapeSlot {
  const entry: SimRosterEntry = { type: j.type as 0 | 1 | 2, tier: j.tier, health: j.health, aggr: j.aggr, w: j.w, h: j.h, occ: BigInt(j.occ) };
  return { speciesId: j.speciesId, entry };
}
