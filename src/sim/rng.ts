import { poseidonHashMany } from '@scure/starknet';

const MASK128 = (1n << 128n) - 1n;

/** SPEC §4: low 128 bits of poseidon_hash_span([seed, tag, i]). */
export function rnd(seed: bigint, tag: bigint, i: number | bigint): bigint {
  return poseidonHashMany([seed, tag, BigInt(i)]) & MASK128;
}

/** poseidon_hash_span over felts, as used for the digest and message hashes. */
export function poseidon(values: bigint[]): bigint {
  return poseidonHashMany(values);
}

/** Small helper: rnd(...) % m as a JS number. */
export function rndMod(seed: bigint, tag: bigint, i: number, m: number): number {
  return Number(rnd(seed, tag, i) % BigInt(m));
}
