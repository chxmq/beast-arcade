// Browser-side check of a submitted run: polls the transaction receipt on a public Starknet RPC
// and reads the RunVerified event the contract emitted. Plain JSON-RPC (spec 0.9/0.10).

import { keccak } from '@scure/starknet';

export const PUBLIC_RPC: string = (import.meta.env?.VITE_STARKNET_RPC as string | undefined) || 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10';

export const voyagerTx = (hash: string) => `https://sepolia.voyager.online/tx/${hash}`;

const RUN_VERIFIED = keccak(new TextEncoder().encode('RunVerified'));
const DEX_UPDATED = keccak(new TextEncoder().encode('DexUpdated'));

export interface RunVerified {
  runId: number;
  playerPub: bigint;
  rootId: number;
  k: number;
  score: number;
  kills: number;
  dead: boolean;
  killerSpecies: number;
  digest: bigint;
}

/** Emitted right after RunVerified: the player's Bestiary after the run (bits are roster indices). */
export interface DexUpdated {
  runId: number;
  playerPub: bigint;
  caughtMask: bigint;
  shinyMask: bigint;
  /** Bits of caughtMask that were not yet in the player's dex. */
  newSpecies: number;
  /** Popcount of the dex after this run. */
  totalSpecies: number;
}

export type ReceiptState =
  | { kind: 'pending'; note: string }
  | { kind: 'verified'; event: RunVerified; dex?: DexUpdated; finality: string }
  | { kind: 'reverted'; reason: string }
  | { kind: 'error'; reason: string };

interface Receipt {
  execution_status?: string;
  finality_status?: string;
  revert_reason?: string;
  events?: RawEvent[];
}

/** One receipt lookup. Pending while the node does not know the tx or it is not on L2 yet. */
export async function checkReceipt(txHash: string, contract: string | undefined): Promise<ReceiptState> {
  let j: { result?: Receipt; error?: { code: number; message: string } };
  try {
    const res = await fetch(PUBLIC_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'starknet_getTransactionReceipt', params: { transaction_hash: txHash } }),
    });
    if (!res.ok) return { kind: 'pending', note: `rpc ${res.status}` };
    j = await res.json();
  } catch {
    return { kind: 'pending', note: 'rpc unreachable' };
  }
  if (j.error) return { kind: 'pending', note: j.error.code === 29 ? 'not seen yet' : j.error.message };
  const r = j.result!;
  if (r.execution_status === 'REVERTED') return { kind: 'reverted', reason: r.revert_reason ?? 'reverted' };
  const finality = r.finality_status ?? '';
  if (finality !== 'ACCEPTED_ON_L2' && finality !== 'ACCEPTED_ON_L1') return { kind: 'pending', note: finality.toLowerCase().replace(/_/g, ' ') || 'pending' };
  return parseReceipt(r.events ?? [], contract, finality);
}

type RawEvent = { from_address: string; keys: string[]; data: string[] };

/** DexUpdated(run_id key, player_pub key; caught_mask, shiny_mask, new_species, total_species). Null if malformed. */
export function parseDexUpdated(ev: RawEvent): DexUpdated | null {
  try {
    if (BigInt(ev.keys[0]) !== DEX_UPDATED || ev.keys.length < 3 || ev.data.length < 4) return null;
    const d = ev.data.map((x) => BigInt(x));
    return {
      runId: Number(BigInt(ev.keys[1])), playerPub: BigInt(ev.keys[2]),
      caughtMask: d[0], shinyMask: d[1], newSpecies: Number(d[2]), totalSpecies: Number(d[3]),
    };
  } catch {
    return null;
  }
}

/** The RunVerified (and, when the contract emits it, DexUpdated) events of an accepted receipt. */
export function parseReceipt(events: RawEvent[], contract: string | undefined, finality = 'ACCEPTED_ON_L2'): ReceiptState {
  const from = (e: RawEvent) => !contract || BigInt(e.from_address) === BigInt(contract);
  const ev = events.find((e) => BigInt(e.keys[0]) === RUN_VERIFIED && from(e));
  if (!ev) return { kind: 'error', reason: 'accepted, but no RunVerified event' };
  const d = ev.data.map((x) => BigInt(x));
  const runId = BigInt(ev.keys[1]);
  const dexEv = events.find((e) => from(e) && e.keys[0] !== undefined && BigInt(e.keys[0]) === DEX_UPDATED && BigInt(e.keys[1] ?? -1) === runId);
  const dex = dexEv ? parseDexUpdated(dexEv) ?? undefined : undefined;
  return {
    kind: 'verified',
    finality,
    event: {
      runId: Number(runId), playerPub: BigInt(ev.keys[2]),
      rootId: Number(d[0]), k: Number(d[1]), score: Number(d[2]), kills: Number(d[3]), dead: d[4] !== 0n, killerSpecies: Number(d[5]), digest: d[6],
    },
    ...(dex ? { dex } : {}),
  };
}
