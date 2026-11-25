// Batched, cached, rate-limit-aware Starknet JSON-RPC `starknet_call` client.
// The public endpoint returns HTTP 429 under parallel load, so calls go out as
// sequential JSON-RPC batches with a pause between them and backoff on 429.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash } from 'starknet';

export interface Call {
  contract: string;
  fn: string;
  calldata: string[];
}

export interface RpcOptions {
  url: string;
  cacheDir: string;
  batchSize?: number;
  pauseMs?: number;
  maxRetries?: number;
  log?: (msg: string) => void;
}

interface RpcResponse {
  id: number;
  result?: string[];
  error?: { code: number; message: string; data?: unknown };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const norm = (h: string) => '0x' + BigInt(h).toString(16);

export function callKey(c: Call): string {
  const s = [norm(c.contract), c.fn, ...c.calldata.map(norm)].join('|');
  return createHash('sha1').update(s).digest('hex');
}

export class CachedRpc {
  private readonly opts: Required<RpcOptions>;
  constructor(opts: RpcOptions) {
    this.opts = {
      batchSize: 12,
      pauseMs: 1000,
      maxRetries: 8,
      log: (m) => console.log(m),
      ...opts,
    };
    mkdirSync(this.opts.cacheDir, { recursive: true });
  }

  private cachePath(c: Call): string {
    return join(this.opts.cacheDir, `${c.fn}-${callKey(c)}.json`);
  }

  private readCache(c: Call): string[] | undefined {
    const p = this.cachePath(c);
    if (!existsSync(p)) return undefined;
    const j = JSON.parse(readFileSync(p, 'utf8')) as { call: Call; result: string[] };
    return j.result;
  }

  private writeCache(c: Call, result: string[]): void {
    writeFileSync(this.cachePath(c), JSON.stringify({ call: c, result }));
  }

  /** Execute calls (cache first), returning results in the same order. Throws on contract errors. */
  async callMany(calls: Call[], batchSize = this.opts.batchSize): Promise<string[][]> {
    const out: (string[] | undefined)[] = calls.map((c) => this.readCache(c));
    const todo = calls.map((_, i) => i).filter((i) => out[i] === undefined);
    if (todo.length > 0) {
      this.opts.log(`  rpc: ${calls.length - todo.length} cached, ${todo.length} to fetch`);
    }
    for (let s = 0; s < todo.length; s += batchSize) {
      const idx = todo.slice(s, s + batchSize);
      const res = await this.sendBatch(idx.map((i) => calls[i]));
      idx.forEach((i, k) => {
        out[i] = res[k];
        this.writeCache(calls[i], res[k]);
      });
      if (s + batchSize < todo.length) await sleep(this.opts.pauseMs);
    }
    return out as string[][];
  }

  async call(c: Call): Promise<string[]> {
    return (await this.callMany([c]))[0];
  }

  private async sendBatch(calls: Call[]): Promise<string[][]> {
    const body = calls.map((c, id) => ({
      jsonrpc: '2.0',
      id,
      method: 'starknet_call',
      params: {
        request: {
          contract_address: c.contract,
          entry_point_selector: hash.getSelectorFromName(c.fn),
          calldata: c.calldata,
        },
        block_id: 'latest',
      },
    }));
    let delay = 1500;
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      let text = '';
      try {
        const r = await fetch(this.opts.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        status = r.status;
        text = await r.text();
      } catch (e) {
        text = String(e);
      }
      if (status === 200) {
        const parsed = JSON.parse(text) as RpcResponse[] | RpcResponse;
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        const byId = new Map(arr.map((r) => [r.id, r]));
        const rateLimited = arr.some((r) => r.error && /rate|limit|too many/i.test(r.error.message));
        if (!rateLimited) {
          return calls.map((c, id) => {
            const r = byId.get(id);
            if (!r) throw new Error(`rpc: missing response for ${c.fn}(${c.calldata.join(',')})`);
            if (r.error || !r.result) {
              throw new Error(`rpc: ${c.fn}(${c.calldata.join(',')}) failed: ${JSON.stringify(r.error)}`);
            }
            return r.result;
          });
        }
      }
      if (attempt >= this.opts.maxRetries) {
        throw new Error(`rpc: giving up after ${attempt + 1} attempts (status ${status}): ${text.slice(0, 300)}`);
      }
      this.opts.log(`  rpc: status ${status}, retrying in ${delay} ms`);
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
    }
  }
}
