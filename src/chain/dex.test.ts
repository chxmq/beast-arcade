import { keccak } from '@scure/starknet';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { maskBits, maskFromHex, maskToHex, resultToJson } from '../broadcast/api.ts';
import { clearDexCache, decodeDexResult, fetchOnchainDex, GET_DEX_SELECTOR, newlyCaught, popcount, rememberDex, rememberedDex } from './dex.ts';
import { parseDexUpdated, parseReceipt } from './receipt.ts';

const sel = (name: string) => '0x' + keccak(new TextEncoder().encode(name)).toString(16);
const CONTRACT = '0x1234abcd';
const PUB = '0x0abc';
const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });

describe('hex masks', () => {
  it('round trip u128 values without precision loss', () => {
    for (const m of [0n, 1n, (1n << 97n) | 5n, (1n << 128n) - 1n]) expect(maskFromHex(maskToHex(m))).toBe(m);
    expect(maskToHex(1n << 100n)).toBe('0x10000000000000000000000000');
  });
  it('decodes leniently', () => {
    expect(maskFromHex(undefined)).toBe(0n);
    expect(maskFromHex('12')).toBe(0n);
    expect(maskFromHex('0xzz')).toBe(0n);
    expect(maskFromHex('0x' + 'f'.repeat(40))).toBe((1n << 128n) - 1n);
  });
  it('lists set bits ascending', () => {
    expect(maskBits((1n << 97n) | (1n << 3n) | 1n)).toEqual([0, 3, 97]);
    expect(maskBits(0n)).toEqual([]);
  });
  it('RunResult json carries both masks', () => {
    const j = resultToJson({ score: 1, kills: 2, lives: 3, dead: false, deathTick: 0, killer: 255, killerRoster: 255, bestCombo: 1, caughtMask: 1n << 96n, shinyMask: 3n, digest: 9n });
    expect(j.caughtMask).toBe('0x1000000000000000000000000');
    expect(j.shinyMask).toBe('0x3');
  });
});

describe('popcount', () => {
  it('counts bits up to 128', () => {
    expect(popcount(0n)).toBe(0);
    expect(popcount(0b1011n)).toBe(3);
    expect(popcount((1n << 128n) - 1n)).toBe(128);
  });
});

describe('newlyCaught', () => {
  it('trusts DexUpdated.new_species and a consistent prior dex', () => {
    expect(newlyCaught(0b110n, 0, null)).toBe(0n);
    expect(newlyCaught(0b110n, 2, null)).toBe(0b110n);
    expect(newlyCaught(0b110n, 1, 0b010n)).toBe(0b100n);
    expect(newlyCaught(0b110n, 1, null)).toBeNull();
    expect(newlyCaught(0b110n, 1, 0b001n)).toBeNull();
  });
});

describe('get_dex call', () => {
  beforeEach(() => clearDexCache());
  afterEach(() => vi.unstubAllGlobals());

  it('uses the starknet_keccak selector', () => expect(GET_DEX_SELECTOR).toBe(sel('get_dex')));

  it('decodes (u128, u128, u32) felts', () => {
    expect(decodeDexResult(['0x5', '0x1', '0x7'])).toEqual({ caught: 5n, shiny: 1n, catches: 7 });
    const big = '0x' + 'f'.repeat(32);
    expect(decodeDexResult([big, '0x0', '0x0'])).toEqual({ caught: (1n << 128n) - 1n, shiny: 0n, catches: 0 });
    expect(decodeDexResult(['0x5'])).toBeNull();
    expect(decodeDexResult('nope')).toBeNull();
    expect(decodeDexResult(['0x1' + '0'.repeat(32), '0x0', '0x0'])).toBeNull();
  });

  it('calls the contract over JSON-RPC and caches for 20 s', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe('starknet_call');
      expect(body.params.request).toEqual({ contract_address: CONTRACT, entry_point_selector: sel('get_dex'), calldata: [PUB.replace('0x0', '0x')] });
      expect(body.params.block_id).toBe('latest');
      return ok(['0x7', '0x2', '0x9']);
    });
    vi.stubGlobal('fetch', fetchMock);
    const a = await fetchOnchainDex(PUB, { contract: CONTRACT, rpc: 'http://rpc.test' });
    expect(a).toEqual({ caught: 7n, shiny: 2n, catches: 9 });
    await fetchOnchainDex(PUB, { contract: CONTRACT, rpc: 'http://rpc.test' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchOnchainDex(PUB, { contract: CONTRACT, rpc: 'http://rpc.test', fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('takes the contract from /api/broadcast/status and is null offchain', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/broadcast/status')) return new Response(JSON.stringify({ onAir: true, offchain: true, board: [] }));
      throw new Error('must not reach the rpc');
    });
    expect(await fetchOnchainDex(PUB)).toBeNull();
    expect(calls).toEqual(['/api/broadcast/status']);

    clearDexCache();
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/broadcast/status')) return new Response(JSON.stringify({ onAir: true, contract: CONTRACT, board: [] }));
      expect(JSON.parse(String(init?.body)).params.request.contract_address).toBe(CONTRACT);
      return ok(['0x1', '0x0', '0x1']);
    });
    expect(await fetchOnchainDex(BigInt(PUB))).toEqual({ caught: 1n, shiny: 0n, catches: 1 });
  });

  it('backs off on 429 and never throws', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      vi.stubGlobal('fetch', async () => (++n < 3 ? new Response('slow', { status: 429 }) : ok(['0x3', '0x0', '0x2'])));
      const p = fetchOnchainDex(PUB, { contract: CONTRACT, rpc: 'http://rpc.test' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await p).toEqual({ caught: 3n, shiny: 0n, catches: 2 });
      expect(n).toBe(3);

      clearDexCache();
      vi.stubGlobal('fetch', async () => {
        throw new Error('network down');
      });
      const q = fetchOnchainDex(PUB, { contract: CONTRACT, rpc: 'http://rpc.test' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await q).toBeNull();

      clearDexCache();
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 40, message: 'Contract error' } })));
      expect(await fetchOnchainDex(PUB, { contract: CONTRACT, rpc: 'http://rpc.test' })).toBeNull();
      expect(await fetchOnchainDex('not a felt', { contract: CONTRACT })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('remembers the last dex per key', () => {
    rememberDex('0x5', { caught: 1n, shiny: 0n, catches: 1 });
    expect(rememberedDex(5n)?.caught).toBe(1n);
    rememberDex(5n, null);
    expect(rememberedDex('0x5')?.caught).toBe(1n);
  });
});

describe('DexUpdated receipt event', () => {
  const runVerified = {
    from_address: CONTRACT,
    keys: [sel('RunVerified'), '0x2a', '0x99'],
    data: ['0x3', '0x10', '1500', '12', '0x0', '0xff', '0xdead'],
  };
  const dexUpdated = { from_address: CONTRACT, keys: [sel('DexUpdated'), '0x2a', '0x99'], data: ['0x1000000000000000000000005', '0x4', '0x2', '0x11'] };

  it('parses the event fields', () => {
    expect(parseDexUpdated(dexUpdated)).toEqual({
      runId: 42, playerPub: 0x99n, caughtMask: (1n << 96n) | 5n, shinyMask: 4n, newSpecies: 2, totalSpecies: 17,
    });
    expect(parseDexUpdated({ ...dexUpdated, data: ['0x1'] })).toBeNull();
    expect(parseDexUpdated(runVerified)).toBeNull();
  });

  it('exposes it next to RunVerified, only from the game contract and for the same run', () => {
    const s = parseReceipt([{ from_address: '0x1', keys: ['0x1'], data: [] }, runVerified, dexUpdated], CONTRACT);
    expect(s.kind).toBe('verified');
    if (s.kind !== 'verified') return;
    expect(s.event).toMatchObject({ runId: 42, score: 1500, kills: 12, dead: false, killerSpecies: 255 });
    expect(s.dex).toMatchObject({ newSpecies: 2, totalSpecies: 17, shinyMask: 4n });

    const other = parseReceipt([runVerified, { ...dexUpdated, from_address: '0x777' }], CONTRACT);
    expect(other.kind === 'verified' && other.dex).toBeUndefined();
    const wrongRun = parseReceipt([runVerified, { ...dexUpdated, keys: [sel('DexUpdated'), '0x2b', '0x99'] }], CONTRACT);
    expect(wrongRun.kind === 'verified' && wrongRun.dex).toBeUndefined();
  });

  it('still verifies on a contract that emits no DexUpdated', () => {
    const s = parseReceipt([runVerified], CONTRACT);
    expect(s.kind).toBe('verified');
    expect(s.kind === 'verified' && s.dex).toBeUndefined();
    expect(parseReceipt([], CONTRACT).kind).toBe('error');
  });
});
