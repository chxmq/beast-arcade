// Tape seeds and the daily Merkle tree.
//
//   seed(day, k) = poseidon([secret, day, k])     k in [0, n)
//   leaf(k)      = poseidon([k, seed(day, k)])     (contract `leaf_of`)
//   root         = Merkle root, OZ PoseidonCHasher  (see src/broadcast/merkle.ts)
//
// Only the root is published (post_tape_root). A seed leaves the server only after its run was
// submitted. Building a 4096-leaf tree costs ~12k Poseidon hashes (~4 s in JS), so trees are built
// in chunks that yield to the event loop (other requests keep flowing) and cached per (day, n).

import { poseidonHashMany } from '@scure/starknet';
import { leafHash, nodeHash } from '../src/broadcast/hashes.ts';
import type { MerkleTree } from '../src/broadcast/merkle.ts';

export const SECONDS_PER_DAY = 86400;

export function seedFor(secret: bigint, day: number, k: number): bigint {
  return poseidonHashMany([secret, BigInt(day), BigInt(k)]);
}

export function leaves(secret: bigint, day: number, n: number): bigint[] {
  const out: bigint[] = new Array(n);
  for (let k = 0; k < n; k++) out[k] = leafHash(k, seedFor(secret, day, k));
  return out;
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/** Same tree as `buildTree(leaves(secret, day, n))`, yielding every 128 hashes. */
async function buildTreeAsync(secret: bigint, day: number, n: number): Promise<MerkleTree> {
  let ops = 0;
  const step = async () => {
    if ((++ops & 127) === 0) await yieldNow();
  };
  const level0: bigint[] = new Array(n);
  for (let k = 0; k < n; k++) {
    level0[k] = leafHash(k, seedFor(secret, day, k));
    await step();
  }
  const levels = [level0];
  for (let cur = level0; cur.length > 1; ) {
    const next: bigint[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? nodeHash(cur[i], cur[i + 1]) : cur[i]);
      await step();
    }
    levels.push(next);
    cur = next;
  }
  return { levels, root: levels[levels.length - 1][0] };
}

const trees = new Map<string, { secret: bigint; tree: Promise<MerkleTree> }>();

export function treeFor(secret: bigint, day: number, n: number): Promise<MerkleTree> {
  const key = `${day}:${n}`;
  const hit = trees.get(key);
  if (hit && hit.secret === secret) return hit.tree;
  const tree = buildTreeAsync(secret, day, n);
  tree.catch(() => trees.delete(key));
  trees.delete(key);
  if (trees.size >= 3) trees.delete(trees.keys().next().value!);
  trees.set(key, { secret, tree });
  return tree;
}

/** Roots are posted with expires_at = end of tape day + 1 h, so the tape day is recoverable from it. */
export function expiresAtFor(day: number): number {
  return (day + 1) * SECONDS_PER_DAY + 3600;
}

export function tapeDayOf(expiresAt: number): number {
  return Math.floor(expiresAt / SECONDS_PER_DAY) - 1;
}

export function utcDay(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / SECONDS_PER_DAY);
}
