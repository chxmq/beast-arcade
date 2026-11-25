// Starknet access for the Broadcast server: typed StaticGame views and the relayer transactions.
//
// JSON-RPC is spoken directly (a small fetch client with 429 backoff) and starknet.js is used for
// selectors, the v3 transaction hash and signing. starknet.js 7 only speaks RPC spec 0.7/0.8
// (it rejects other spec versions and defaults to the 'pending' block tag, removed in 0.9), while
// the public Sepolia endpoints serve 0.9/0.10, so its RpcProvider/Account are not used here.
// The invoke format below is the RPC 0.8+ INVOKE_TXN_V3 (three resource bounds).

import { ec, hash } from 'starknet';
import type { TapeSlot } from '../src/broadcast/tape.ts';
import { decodeShortString, hex } from '../src/broadcast/hashes.ts';
import type { BoardRow } from '../src/broadcast/api.ts';
import type { ServerEnv } from './env.ts';

export interface RootInfo {
  root: bigint;
  n: number;
  postedAt: number;
  expiresAt: number;
  day: number;
  rosterVersion: number;
  rosterLen: number;
  nFeatured: number;
}

class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const big = (v: string) => BigInt(v);
const num = (v: string) => Number(BigInt(v));

const selectors = new Map<string, string>();
const selectorOf = (name: string) => {
  let s = selectors.get(name);
  if (!s) selectors.set(name, (s = hash.getSelectorFromName(name)));
  return s;
};

/** One JSON-RPC request with backoff on HTTP 429 / rate-limit errors / network errors. */
export async function rpc<T>(url: string, method: string, params: unknown, tries = 5): Promise<T> {
  let delay = 400;
  for (let attempt = 1; ; attempt++) {
    let retry = false;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (res.status === 429 || res.status >= 500) retry = true;
      else {
        const j = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
        if (j.error) {
          if (/rate|too many|limit exceeded/i.test(j.error.message)) retry = true;
          else throw new RpcError(`${method}: ${j.error.message}${j.error.data ? ' ' + JSON.stringify(j.error.data).slice(0, 400) : ''}`, j.error.code, j.error.data);
        } else return j.result as T;
      }
    } catch (e) {
      if (e instanceof RpcError) throw e;
      retry = true;
    }
    if (!retry || attempt >= tries) throw new RpcError(`${method}: RPC unavailable`);
    await sleep(delay);
    delay = Math.min(delay * 2, 4000);
  }
}

export interface Submission {
  rootId: number;
  k: number;
  nonce: bigint;
  seed: bigint;
  proof: bigint[];
  pub: bigint;
  callsign: bigint;
  strikes: number[];
  r: bigint;
  s: bigint;
}

/** Raw calldata of `submit_broadcast`, exactly as documented in contracts/README.md:
 *  [root_id, k, nonce, seed, proof_len, ...proof, player_pub, callsign, strikes_len, ...strikes, sig_r, sig_s] */
export function submitCalldata(x: Submission): bigint[] {
  return [
    BigInt(x.rootId), BigInt(x.k), x.nonce, x.seed, BigInt(x.proof.length), ...x.proof,
    x.pub, x.callsign, BigInt(x.strikes.length), ...x.strikes.map((v) => BigInt(v)), x.r, x.s,
  ];
}

const rosterCache = new Map<number, TapeSlot[]>();
const rootCache = new Map<number, RootInfo>();

function parseRootInfo(r: string[], o = 0): RootInfo {
  return {
    root: big(r[o]),
    n: num(r[o + 1]),
    postedAt: num(r[o + 2]),
    expiresAt: num(r[o + 3]),
    day: num(r[o + 4]),
    rosterVersion: num(r[o + 5]),
    rosterLen: num(r[o + 6]),
    nFeatured: num(r[o + 7]),
  };
}

export class Chain {
  private nextNonce: bigint | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private chainId: string | null = null;
  /** Block tag for nonce / fee estimates: 'pre_confirmed' (RPC 0.9+), else 'latest'. */
  private tag: 'pre_confirmed' | 'latest' = 'pre_confirmed';

  constructor(private readonly env: ServerEnv) {
    if (!env.contract) throw new Error('no contract');
  }

  /** starknet_call on the StaticGame contract at the latest block. */
  async call(fn: string, calldata: (bigint | number)[] = []): Promise<string[]> {
    return rpc<string[]>(this.env.rpcUrl, 'starknet_call', {
      request: { contract_address: this.env.contract, entry_point_selector: selectorOf(fn), calldata: calldata.map(hex) },
      block_id: 'latest',
    });
  }

  async latestRoot(): Promise<{ rootId: number; info: RootInfo }> {
    const r = await this.call('latest_root');
    const rootId = num(r[0]);
    const info = parseRootInfo(r, 1);
    if (rootId > 0) rootCache.set(rootId, info);
    return { rootId, info };
  }

  /** Roots are immutable once posted: cached forever. */
  async getRoot(rootId: number): Promise<RootInfo> {
    let info = rootCache.get(rootId);
    if (!info) {
      info = parseRootInfo(await this.call('get_root', [rootId]));
      if (info.root === 0n) throw new Error('unknown root');
      rootCache.set(rootId, info);
    }
    return info;
  }

  /** `get_root_roster`: (species_id, RosterEntry) per roster index, frozen per root (cached forever). */
  async rootRoster(rootId: number): Promise<TapeSlot[]> {
    let slots = rosterCache.get(rootId);
    if (!slots) {
      const r = await this.call('get_root_roster', [rootId]);
      const len = num(r[0]);
      slots = [];
      for (let i = 0; i < len; i++) {
        const o = 1 + i * 8;
        slots.push({
          speciesId: num(r[o]),
          entry: { type: num(r[o + 1]) as 0 | 1 | 2, tier: num(r[o + 2]), health: num(r[o + 3]), aggr: num(r[o + 4]), w: num(r[o + 5]), h: num(r[o + 6]), occ: big(r[o + 7]) },
        });
      }
      rosterCache.set(rootId, slots);
    }
    return slots;
  }

  async isTapeUsed(rootId: number, k: number): Promise<boolean> {
    const r = await this.call('is_tape_used', [rootId, k]);
    return big(r[0]) !== 0n;
  }

  async top(day: number): Promise<BoardRow[]> {
    const r = await this.call('top', [day]);
    const len = num(r[0]);
    const out: BoardRow[] = [];
    for (let i = 0; i < len; i++) {
      const o = 1 + i * 4;
      out.push({ player: r[o], score: num(r[o + 1]), runId: num(r[o + 2]), callsign: decodeShortString(big(r[o + 3])) });
    }
    return out;
  }

  // ------------------------------------------------------------------ relayer

  /** Calls StaticGame.`entrypoint` from the relayer account. Returns the tx hash once the node accepted it. */
  invoke(entrypoint: string, calldata: bigint[]): Promise<string> {
    const run = () => this.sendWithRetry(entrypoint, calldata);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async sendWithRetry(entrypoint: string, calldata: bigint[]): Promise<string> {
    try {
      return await this.send(entrypoint, calldata);
    } catch (e) {
      if (!/nonce/i.test(String(e))) throw e;
      this.nextNonce = null;
      await sleep(1500);
      return this.send(entrypoint, calldata);
    }
  }

  /** RPC call taking a block id; falls back to 'latest' on nodes without 'pre_confirmed'. */
  private async atTag<T>(method: string, params: (tag: string) => unknown): Promise<T> {
    try {
      return await rpc<T>(this.env.rpcUrl, method, params(this.tag));
    } catch (e) {
      if (this.tag === 'latest' || !(e instanceof RpcError) || !/block|invalid param/i.test(e.message)) throw e;
      this.tag = 'latest';
      return rpc<T>(this.env.rpcUrl, method, params(this.tag));
    }
  }

  private async nonce(): Promise<bigint> {
    const chainNonce = big(await this.atTag<string>('starknet_getNonce', (block_id) => ({ block_id, contract_address: this.env.relayerAddress })));
    return this.nextNonce !== null && this.nextNonce > chainNonce ? this.nextNonce : chainNonce;
  }

  /** Dry run: the signed, fully validated fee estimate of a relayer call. Sends nothing. */
  async estimate(entrypoint: string, calldata: bigint[]): Promise<FeeEstimate> {
    return (await this.send(entrypoint, calldata, true)) as FeeEstimate;
  }

  private async send(entrypoint: string, calldata: bigint[]): Promise<string>;
  private async send(entrypoint: string, calldata: bigint[], dryRun: true): Promise<FeeEstimate>;
  private async send(entrypoint: string, calldata: bigint[], dryRun = false): Promise<string | FeeEstimate> {
    const { rpcUrl, relayerAddress, relayerPk, contract } = this.env;
    if (!relayerAddress || !relayerPk || !contract) throw new Error('relayer not configured');
    const chainId = (this.chainId ??= await rpc<string>(rpcUrl, 'starknet_chainId', []));
    const nonce = await this.nonce();
    // Cairo 1 account __execute__(calls: Array<Call { to, selector, calldata }>).
    const execCalldata = [1n, big(contract), big(selectorOf(entrypoint)), BigInt(calldata.length), ...calldata];

    const build = (version: string, bounds: Bounds) => {
      const txHash = hash.calculateInvokeTransactionHash({
        senderAddress: relayerAddress,
        version: version as '0x3',
        compiledCalldata: execCalldata.map(hex),
        chainId: chainId as Parameters<typeof hash.calculateInvokeTransactionHash>[0]['chainId'],
        nonce,
        accountDeploymentData: [],
        nonceDataAvailabilityMode: 0,
        feeDataAvailabilityMode: 0,
        resourceBounds: bounds,
        tip: 0,
        paymasterData: [],
      });
      const sig = ec.starkCurve.sign(txHash, relayerPk);
      return {
        txHash,
        tx: {
          type: 'INVOKE',
          version,
          sender_address: relayerAddress,
          calldata: execCalldata.map(hex),
          signature: [hex(sig.r), hex(sig.s)],
          nonce: hex(nonce),
          resource_bounds: bounds,
          tip: '0x0',
          paymaster_data: [],
          account_deployment_data: [],
          nonce_data_availability_mode: 'L1',
          fee_data_availability_mode: 'L1',
        },
      };
    };

    // 1. Estimate with a signed query-version tx (fully validated, cannot be replayed onchain).
    const zero = { max_amount: '0x0', max_price_per_unit: '0x0' };
    const query = build('0x100000000000000000000000000000003', { l1_gas: zero, l2_gas: zero, l1_data_gas: zero });
    const [est] = await this.atTag<FeeEstimate[]>('starknet_estimateFee', (block_id) => ({ request: [query.tx], simulation_flags: [], block_id }));
    if (dryRun) return est;
    const bound = (amount: string, price: string) => ({
      max_amount: hex((big(amount) * 3n) / 2n + 1000n),
      max_price_per_unit: hex(big(price) * 2n + 1n),
    });
    const bounds: Bounds = {
      l1_gas: bound(est.l1_gas_consumed, est.l1_gas_price),
      l2_gas: bound(est.l2_gas_consumed, est.l2_gas_price),
      l1_data_gas: bound(est.l1_data_gas_consumed, est.l1_data_gas_price),
    };

    // 2. Sign and send the real tx.
    const real = build('0x3', bounds);
    const res = await rpc<{ transaction_hash: string }>(rpcUrl, 'starknet_addInvokeTransaction', { invoke_transaction: real.tx }, 2);
    this.nextNonce = nonce + 1n;
    if (BigInt(res.transaction_hash) !== BigInt(real.txHash)) console.warn('[broadcast] node tx hash differs from local hash');
    return res.transaction_hash;
  }
}

interface Bound { max_amount: string; max_price_per_unit: string }
interface Bounds { l1_gas: Bound; l2_gas: Bound; l1_data_gas: Bound }
export interface FeeEstimate {
  l1_gas_consumed: string;
  l1_gas_price: string;
  l2_gas_consumed: string;
  l2_gas_price: string;
  l1_data_gas_consumed: string;
  l1_data_gas_price: string;
  overall_fee: string;
}

let shared: { key: string; chain: Chain } | null = null;

/** One Chain per configuration (keeps the relayer queue and nonce across requests). */
export function chainFor(env: ServerEnv): Chain {
  const key = `${env.contract}|${env.rpcUrl}|${env.relayerAddress}`;
  if (!shared || shared.key !== key) shared = { key, chain: new Chain(env) };
  return shared.chain;
}
