// Hashing schemes shared by the Broadcast server, the browser client and the tests.
// Every formula mirrors `contracts/src/static_game.cairo` exactly (see contracts/README.md):
// always the Poseidon "many" form (poseidon_hash_span), never the 2-input Hades shortcut.

import { poseidonHashMany } from '@scure/starknet';

/** Stark field prime. */
export const FELT_P = 2n ** 251n + 17n * 2n ** 192n + 1n;
/** Cairo short string 'STATIC': domain tag of the player-signed message. */
export const MSG_TAG = 0x535441544943n;
/** Short string 'FIELD': derives the noise-field seed of a tape from its run seed. */
export const FIELD_TAG = 0x4649454c44n;

/** Tape index of a player: poseidon([player_pub, nonce]) mod n (integer mod). */
export function tapeIndex(pub: bigint, nonce: bigint, n: number): number {
  return Number(poseidonHashMany([pub, nonce]) % BigInt(n));
}

/** Merkle leaf: poseidon([k, seed]). */
export function leafHash(k: number, seed: bigint): bigint {
  return poseidonHashMany([BigInt(k), seed]);
}

/** Merkle node, OpenZeppelin PoseidonCHasher: poseidon([min, max]) comparing as integers. */
export function nodeHash(a: bigint, b: bigint): bigint {
  return a < b ? poseidonHashMany([a, b]) : poseidonHashMany([b, a]);
}

/** Signed message: poseidon(['STATIC', root_id, k, nonce, callsign, ...strikes]). */
export function messageHash(rootId: number, k: number, nonce: bigint, callsign: bigint, strikes: readonly number[]): bigint {
  return poseidonHashMany([MSG_TAG, BigInt(rootId), BigInt(k), nonce, callsign, ...strikes.map((s) => BigInt(s))]);
}

/** Callsigns: 1 to 12 characters, A-Z and 0-9. */
export const CALLSIGN_RE = /^[A-Z0-9]{1,12}$/;

/** Cairo short string (ASCII, at most 31 chars) as a felt. */
export function encodeShortString(s: string): bigint {
  if (s.length > 31 || !/^[\x00-\x7f]*$/.test(s)) throw new Error('bad short string');
  let v = 0n;
  for (let i = 0; i < s.length; i++) v = (v << 8n) | BigInt(s.charCodeAt(i));
  return v;
}

export function decodeShortString(v: bigint): string {
  let s = '';
  while (v > 0n) {
    s = String.fromCharCode(Number(v & 0xffn)) + s;
    v >>= 8n;
  }
  return s;
}

/** Parses a felt given as a 0x-hex or decimal string (or a safe integer). Null if invalid. */
export function parseFelt(v: unknown): bigint | null {
  try {
    if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
    if (typeof v !== 'string' || !/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(v)) return null;
    const x = BigInt(v);
    return x < FELT_P ? x : null;
  } catch {
    return null;
  }
}

export const hex = (v: bigint | number): string => '0x' + BigInt(v).toString(16);
