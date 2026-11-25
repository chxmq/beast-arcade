// Onchain Bestiary: which roster entries a player key has caught in verified ranked runs.
// Reads StaticGame.get_dex(player_pub) -> (u128 caught, u128 shiny, u32 catches) and
// best(player_pub) -> u32 over the same public JSON-RPC endpoint as the receipt check (browser
// CORS-safe). Every failure is a null.

import { keccak } from '@scure/starknet';
import { PUBLIC_RPC } from './receipt.ts';

export interface OnchainDex {
  /** Bit r set: roster index r caught in at least one verified run. */
  caught: bigint;
  /** Bit r set: a shiny of roster index r was caught. */
  shiny: bigint;
  /** Total Beasts caught across verified runs. */
  catches: number;
}

export const GET_DEX_SELECTOR = '0x' + keccak(new TextEncoder().encode('get_dex')).toString(16);

const U128 = (1n << 128n) - 1n;
const CACHE_MS = 20_000;
const RETRIES = 3;

/** Number of set bits. */
export function popcount(mask: bigint): number {
  let n = 0;
  for (let m = mask; m > 0n; m >>= 1n) if (m & 1n) n++;
  return n;
}

/**
 * The three felts of `(u128, u128, u32)` as returned by starknet_call. A u128 is one felt (not a
 * u256 low/high pair). Null on any other shape.
 */
export function decodeDexResult(r: unknown): OnchainDex | null {
  if (!Array.isArray(r) || r.length < 3) return null;
  try {
    const [caught, shiny, catches] = r.slice(0, 3).map((x) => BigInt(x as string));
    if (caught < 0n || shiny < 0n || catches < 0n || caught > U128 || shiny > U128 || catches > 0xffff_ffffn) return null;
    return { caught, shiny, catches: Number(catches) };
  } catch {
    return null;
  }
}

export interface DexOptions {
  /** StaticGame address; default: `contract` of GET /api/broadcast/status. */
  contract?: string;
  rpc?: string;
  /** Skip the 20 s cache. */
  fresh?: boolean;
}

const cache = new Map<string, { at: number; value: Promise<unknown> }>();
let contractMemo: { at: number; value: Promise<string | null> } | null = null;

export function clearDexCache() {
  cache.clear();
  contractMemo = null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The StaticGame address from the broadcast status; null offchain, off air or unreachable. */
async function contractFromStatus(): Promise<string | null> {
  try {
    const res = await fetch('/api/broadcast/status');
    if (!res.ok) return null;
    const j = (await res.json()) as { offchain?: boolean; contract?: string };
    return !j.offchain && typeof j.contract === 'string' && j.contract ? j.contract : null;
  } catch {
    return null;
  }
}

/** starknet_call of a `fn(player_pub)` view; the raw result felts, or null on any failure. */
async function callPlayerView(selector: string, pub: bigint, opts: DexOptions): Promise<unknown> {
  let contract = opts.contract ?? null;
  if (!contract) {
    if (!contractMemo || Date.now() - contractMemo.at > CACHE_MS) contractMemo = { at: Date.now(), value: contractFromStatus() };
    contract = await contractMemo.value;
  }
  if (!contract) return null;
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'starknet_call',
    params: { request: { contract_address: contract, entry_point_selector: selector, calldata: ['0x' + pub.toString(16)] }, block_id: 'latest' },
  });
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetch(opts.rpc ?? PUBLIC_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      if (res.status === 429 || res.status >= 500) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      if (!res.ok) return null;
      const j = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
      if (j.error) {
        // Rate-limit style errors are worth a retry; contract errors (unknown selector) are not.
        if (/rate|limit|too many|busy/i.test(j.error.message ?? '')) {
          await sleep(400 * 2 ** attempt);
          continue;
        }
        return null;
      }
      return j.result ?? null;
    } catch {
      await sleep(400 * 2 ** attempt);
    }
  }
  return null;
}

async function readDex(pub: bigint, opts: DexOptions): Promise<OnchainDex | null> {
  return decodeDexResult(await callPlayerView(GET_DEX_SELECTOR, pub, opts));
}

/** Read a player's onchain bestiary. Resolves null when offchain/unavailable. Never throws. */
export async function fetchOnchainDex(playerPub: string | bigint, opts: DexOptions = {}): Promise<OnchainDex | null> {
  return cachedRead('dex', playerPub, opts, readDex);
}

/** One player view read, cached for 20 s per (view, contract, rpc, player). */
function cachedRead<T>(kind: string, playerPub: string | bigint, opts: DexOptions, read: (pub: bigint, opts: DexOptions) => Promise<T | null>): Promise<T | null> {
  let pub: bigint;
  try {
    pub = BigInt(playerPub);
  } catch {
    return Promise.resolve(null);
  }
  const key = `${kind}|${opts.contract ?? ''}|${opts.rpc ?? ''}|${pub}`;
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T | null>;
  const value = read(pub, opts).catch(() => null);
  cache.set(key, { at: Date.now(), value });
  // A failed read must not stick for 20 s.
  void value.then((v) => {
    if (v === null && cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

// ---------------------------------------------------------------------------------- best

export const BEST_SELECTOR = '0x' + keccak(new TextEncoder().encode('best')).toString(16);

/** `best(player_pub) -> u32` as returned by starknet_call: one felt. Null on any other shape. */
export function decodeBestResult(r: unknown): number | null {
  if (!Array.isArray(r) || r.length < 1) return null;
  try {
    const v = BigInt(r[0] as string);
    return v >= 0n && v <= 0xffff_ffffn ? Number(v) : null;
  } catch {
    return null;
  }
}

/** A player's best verified ranked score (0 = none yet). Null when offchain/unavailable. Never throws. */
export async function fetchRankedBest(playerPub: string | bigint, opts: DexOptions = {}): Promise<number | null> {
  return cachedRead('best', playerPub, opts, async (pub, o) => decodeBestResult(await callPlayerView(BEST_SELECTOR, pub, o)));
}

// ---------------------------------------------------------------------------------- diffing

const before = new Map<string, OnchainDex>();

/** Remember the last dex seen for a key (the lobby does, so Decode can tell which catches are new). */
export function rememberDex(playerPub: string | bigint, dex: OnchainDex | null) {
  if (dex) before.set(String(BigInt(playerPub)), dex);
}

export function rememberedDex(playerPub: string | bigint): OnchainDex | null {
  return before.get(String(BigInt(playerPub))) ?? null;
}

/**
 * Which bits of this run's caught mask were new to the dex. `newSpecies` is what DexUpdated says
 * (the authority); `prior` is the dex seen before the run, used only if it agrees with that count.
 * Null when the per-species split cannot be known.
 */
export function newlyCaught(runCaught: bigint, newSpecies: number, prior: bigint | null): bigint | null {
  if (newSpecies <= 0) return 0n;
  if (newSpecies === popcount(runCaught)) return runCaught;
  if (prior !== null) {
    const d = runCaught & ~prior;
    if (popcount(d) === newSpecies) return d;
  }
  return null;
}
