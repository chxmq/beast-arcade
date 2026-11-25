// Merkle tree over tape leaves, verified onchain by OpenZeppelin `verify_poseidon`
// (openzeppelin_merkle_tree 4.0.1): the proof is the list of sibling hashes bottom-up, folded
// with the commutative PoseidonCHasher, with no index bits. Any tree shape works as long as the
// fold reaches the root, so for an odd count the unpaired last node is carried up unchanged and
// its proof simply has one sibling fewer at that level.

import { nodeHash } from './hashes.ts';

export interface MerkleTree {
  /** levels[0] = leaves, last level = [root]. */
  levels: bigint[][];
  root: bigint;
}

export function buildTree(leaves: readonly bigint[]): MerkleTree {
  if (leaves.length === 0) throw new Error('empty tree');
  const levels: bigint[][] = [leaves.slice()];
  for (let cur = levels[0]; cur.length > 1; ) {
    const next: bigint[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? nodeHash(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
    cur = next;
  }
  return { levels, root: levels[levels.length - 1][0] };
}

export function proofFor(tree: MerkleTree, index: number): bigint[] {
  if (!(index >= 0 && index < tree.levels[0].length)) throw new Error('bad leaf index');
  const out: bigint[] = [];
  let idx = index;
  for (let l = 0; l < tree.levels.length - 1; l++) {
    const sib = idx ^ 1;
    if (sib < tree.levels[l].length) out.push(tree.levels[l][sib]);
    idx >>= 1;
  }
  return out;
}

/** OZ `process_proof`: fold the siblings into the leaf. Valid iff the result equals the root. */
export function processProof(proof: readonly bigint[], leaf: bigint): bigint {
  return proof.reduce((acc, p) => nodeHash(acc, p), leaf);
}
