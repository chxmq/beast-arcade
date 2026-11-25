import { CURVE, getPublicKey, getStarkKey, poseidonHashMany, sign, verify } from '@scure/starknet';
import { typedData as snip12 } from 'starknet';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_KEY,
  AccountError,
  AccountStore,
  AccountVault,
  BACKUP_KEY,
  buildUnlockTypedData,
  derivePlayerKey,
  describeWalletError,
  keyHex,
  networkName,
  NO_WALLET_MESSAGE,
  normalizeAddress,
  normalizeChainId,
  pubOf,
  shortAddress,
  signatureFelts,
  UNLOCK_ACTION,
  unlockWithWallet,
  type KeySlot,
  type StorageLike,
  type WalletEntry,
  type WalletRequestApi,
} from './account.ts';

const SEPOLIA = '0x534e5f5345504f4c4941';
const MAINNET = '0x534e5f4d41494e';
const ADDR = '0x' + '0'.repeat(3) + '4a2b'.repeat(15) + 'c';
const WALLET_PK = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd';

function memStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

function slot(pk: string): KeySlot & { pk: string } {
  const s = { pk, current: () => s.pk, use: (k: string) => { s.pk = k; } };
  return s;
}

/** A wallet that signs like an RFC 6979 Stark signer: same message, same signature. */
function fakeWallet(opts: { chain?: unknown; chainThrows?: boolean; accounts?: unknown; reject?: unknown; pk?: string; extra?: string[] } = {}): WalletRequestApi & { calls: string[]; signed: unknown[] } {
  const calls: string[] = [];
  const signed: unknown[] = [];
  return {
    calls,
    signed,
    async request({ type, params }) {
      calls.push(type);
      if (type === 'wallet_requestAccounts') return opts.accounts ?? [ADDR];
      if (type === 'wallet_requestChainId') {
        if (opts.chainThrows) throw new Error('method not supported');
        return opts.chain ?? SEPOLIA;
      }
      if (type === 'wallet_signTypedData') {
        if (opts.reject) throw opts.reject;
        signed.push(params);
        const hash = snip12.getMessageHash(params as Parameters<typeof snip12.getMessageHash>[0], ADDR);
        const sig = sign(hash.replace(/^0x/, '').padStart(64, '0'), opts.pk ?? WALLET_PK);
        return [...(opts.extra ?? []), '0x' + sig.r.toString(16), '0x' + sig.s.toString(16)];
      }
      throw new Error(`unexpected ${type}`);
    },
  };
}

describe('unlock typed data (SNIP-12 revision 1)', () => {
  it('has a revision 1 domain and a shortstring action', () => {
    const td = buildUnlockTypedData(SEPOLIA, ADDR);
    expect(td.domain).toEqual({ name: 'BEAST ARCADE', version: '1', chainId: SEPOLIA, revision: '1' });
    expect(td.primaryType).toBe('Unlock');
    expect(td.message).toEqual({ action: 'Unlock my BEAST ARCADE player', player: ADDR });
    expect(td.types.StarknetDomain.map((f) => f.name)).toEqual(['name', 'version', 'chainId', 'revision']);
    expect(td.types.StarknetDomain.every((f) => f.type === 'shortstring')).toBe(true);
    expect(td.types.Unlock).toEqual([{ name: 'action', type: 'shortstring' }, { name: 'player', type: 'ContractAddress' }]);
    expect(UNLOCK_ACTION.length).toBeLessThanOrEqual(31);
  });

  it('hashes with starknet.js, binds the chain and the player', () => {
    const h = (chain: string, player: string) => snip12.getMessageHash(buildUnlockTypedData(chain, player), player);
    const a = h(SEPOLIA, ADDR);
    expect(a).toMatch(/^0x[0-9a-f]+$/);
    expect(h(SEPOLIA, ADDR)).toBe(a);
    // The readable and the hex chain id are the same shortstring felt.
    expect(snip12.getMessageHash(buildUnlockTypedData('SN_SEPOLIA', ADDR), ADDR)).toBe(a);
    expect(h(MAINNET, ADDR)).not.toBe(a);
    expect(h(SEPOLIA, '0x1234')).not.toBe(a);
  });
});

describe('felts, chains and addresses', () => {
  it('normalizes chain ids in every form wallets use', () => {
    expect(normalizeChainId(SEPOLIA)).toBe(SEPOLIA);
    expect(normalizeChainId('SN_SEPOLIA')).toBe(SEPOLIA);
    expect(normalizeChainId('starknet:0x534e5f5345504f4c4941')).toBe(SEPOLIA);
    expect(normalizeChainId(BigInt(MAINNET))).toBe(MAINNET);
    for (const bad of ['', '0x', '0xzz', '0x0', null, undefined, {}, 'x'.repeat(40)]) expect(normalizeChainId(bad)).toBeNull();
  });
  it('names networks', () => {
    expect(networkName(SEPOLIA)).toBe('SEPOLIA');
    expect(networkName(MAINNET)).toBe('MAINNET');
    expect(networkName(normalizeChainId('SN_DEVNET')!)).toBe('DEVNET');
    expect(networkName('0x1')).toBe('0x1');
  });
  it('normalizes and shortens addresses', () => {
    expect(normalizeAddress('0xABC')).toBe('0x' + 'abc'.padStart(64, '0'));
    expect(normalizeAddress('0x0')).toBeNull();
    expect(normalizeAddress('hello')).toBeNull();
    expect(normalizeAddress('0x' + 'f'.repeat(64))).toBeNull();
    expect(shortAddress(ADDR)).toBe('0x0004...a2bc');
  });
});

describe('player key from a signature', () => {
  it('parses felt arrays and { r, s } objects', () => {
    expect(signatureFelts(['0x1', '2', 3])).toEqual([1n, 2n, 3n]);
    expect(signatureFelts({ r: '0xa', s: '0xb' })).toEqual([10n, 11n]);
    for (const bad of [[], null, 'nope', ['0xzz'], ['0x0', '0x0'], [-1], ['0x' + 'f'.repeat(64)], {}]) {
      expect(() => signatureFelts(bad)).toThrow(AccountError);
    }
  });

  it('is poseidonHashMany(sig) mod (n - 1) + 1, deterministic and a valid Stark key', () => {
    const sig = [0x1234n, 0xabcdn];
    const k = derivePlayerKey(sig);
    expect(k).toBe((poseidonHashMany(sig) % (CURVE.n - 1n)) + 1n);
    expect(derivePlayerKey([0x1234n, 0xabcdn])).toBe(k);
    expect(derivePlayerKey([0x1234n, 0xabcen])).not.toBe(k);
    expect(k >= 1n && k < CURVE.n).toBe(true);
    expect(keyHex(k)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(getStarkKey(keyHex(k)))).toBeGreaterThan(0n);
    expect(() => derivePlayerKey([])).toThrow(AccountError);
  });
});

describe('unlockWithWallet', () => {
  it('asks for accounts, the chain, then one signature; same wallet, same player', async () => {
    const w = fakeWallet();
    let signing = 0;
    const a = await unlockWithWallet(w, { onSign: () => signing++ });
    expect(w.calls).toEqual(['wallet_requestAccounts', 'wallet_requestChainId', 'wallet_signTypedData']);
    expect(signing).toBe(1);
    expect(a.address).toBe(normalizeAddress(ADDR));
    expect(a.chainId).toBe(SEPOLIA);
    // The wallet signed exactly our typed data, and the signature verifies against its hash.
    const td = w.signed[0] as ReturnType<typeof buildUnlockTypedData>;
    expect(td).toEqual(buildUnlockTypedData(SEPOLIA, a.address));
    // A second device: a fresh session with the same wallet gives the same key.
    const b = await unlockWithWallet(fakeWallet());
    expect(b.priv).toBe(a.priv);
    // A different wallet key gives a different player.
    expect((await unlockWithWallet(fakeWallet({ pk: '0x5' }))).priv).not.toBe(a.priv);
    // A different network gives a different player (the domain binds the chain).
    expect((await unlockWithWallet(fakeWallet({ chain: MAINNET }))).priv).not.toBe(a.priv);
  });

  it('signatures from the fake signer verify (the test signs what the wallet would)', () => {
    const td = buildUnlockTypedData(SEPOLIA, ADDR);
    const hash = snip12.getMessageHash(td, ADDR).replace(/^0x/, '').padStart(64, '0');
    const sig = sign(hash, WALLET_PK);
    expect(verify(sig, hash, getPublicKey(WALLET_PK))).toBe(true);
  });

  it('includes every signature felt (multisig / guardian shapes)', async () => {
    const plain = await unlockWithWallet(fakeWallet());
    const multi = await unlockWithWallet(fakeWallet({ extra: ['0x1', '0x0'] }));
    expect(multi.priv).not.toBe(plain.priv);
  });

  it('falls back to the wallet standard chain when wallet_requestChainId fails', async () => {
    const r = await unlockWithWallet(fakeWallet({ chainThrows: true }), { chainHint: 'starknet:0x534e5f5345504f4c4941' });
    expect(r.chainId).toBe(SEPOLIA);
    await expect(unlockWithWallet(fakeWallet({ chainThrows: true }))).rejects.toMatchObject({ kind: 'network' });
  });

  it('turns rejections and empty answers into plain messages', async () => {
    const refused = await unlockWithWallet(fakeWallet({ reject: { code: 113, message: 'An error occurred (USER_REFUSED_OP)' } })).catch((e) => e);
    expect(describeWalletError(refused)).toBe('Cancelled in the wallet. Still playing as a guest.');
    expect(describeWalletError(new Error('User rejected the request'))).toMatch(/^Cancelled/);
    const none = await unlockWithWallet(fakeWallet({ accounts: [] })).catch((e) => e);
    expect(none).toBeInstanceOf(AccountError);
    expect(describeWalletError(none)).toMatch(/did not share an account/);
    expect(describeWalletError(new Error('boom\u2014bad'))).toBe('Wallet error: boombad. Still playing as a guest.');
    expect(describeWalletError(undefined)).toMatch(/did not answer/);
  });
});

describe('AccountVault persistence', () => {
  const GUEST = '0xabc123';

  it('backs up the guest key on connect and restores it on disconnect', () => {
    const st = memStorage();
    const s = slot(GUEST);
    const v = new AccountVault(st, s);
    expect(v.link()).toBeNull();
    v.connect(WALLET_PK, { address: normalizeAddress(ADDR)!, chainId: SEPOLIA, walletName: 'Ready Wallet', walletId: 'argentX' });
    expect(s.pk).toBe(WALLET_PK);
    expect(v.backup()).toBe(GUEST);
    expect(JSON.parse(st.data.get(BACKUP_KEY)!)).toEqual({ pk: GUEST });
    const link = v.link()!;
    expect(link).toMatchObject({ address: normalizeAddress(ADDR), chainId: SEPOLIA, walletName: 'Ready Wallet', walletId: 'argentX' });
    expect(BigInt(link.pub)).toBe(BigInt(getStarkKey(WALLET_PK)));
    // A reload reads the same link.
    expect(new AccountVault(st, s).link()).toEqual(link);

    // Switching wallets keeps the original guest backup.
    v.connect('0x77', { address: '0x' + '9'.padStart(64, '0'), chainId: MAINNET, walletName: 'Braavos' });
    expect(v.backup()).toBe(GUEST);
    expect(v.link()?.walletName).toBe('Braavos');

    v.disconnect();
    expect(s.pk).toBe(GUEST);
    expect(v.link()).toBeNull();
    expect(st.data.has(ACCOUNT_KEY)).toBe(false);
    expect(st.data.has(BACKUP_KEY)).toBe(false);
  });

  it('ignores corrupt or stale links', () => {
    const st = memStorage();
    const s = slot(GUEST);
    st.setItem(ACCOUNT_KEY, '{not json');
    expect(new AccountVault(st, s).link()).toBeNull();
    // A link for a key that is no longer active (storage was edited) is not a wallet player.
    st.setItem(ACCOUNT_KEY, JSON.stringify({ address: ADDR, chainId: SEPOLIA, walletName: 'X', pub: pubOf(WALLET_PK) }));
    expect(new AccountVault(st, s).link()).toBeNull();
    s.pk = WALLET_PK;
    expect(new AccountVault(st, s).link()?.walletName).toBe('X');
    st.setItem(ACCOUNT_KEY, JSON.stringify({ address: 'nope', chainId: SEPOLIA, walletName: 'X', pub: pubOf(WALLET_PK) }));
    expect(new AccountVault(st, s).link()).toBeNull();
  });

  it('never keeps the wallet key after disconnect, even without a backup', () => {
    const st = memStorage();
    const s = slot(GUEST);
    const v = new AccountVault(st, s);
    v.connect(WALLET_PK, { address: ADDR, chainId: SEPOLIA, walletName: 'W' });
    st.removeItem(BACKUP_KEY);
    v.disconnect();
    expect(s.pk).not.toBe(WALLET_PK);
    expect(s.pk).toMatch(/^0x[0-9a-f]+$/);
    expect(v.link()).toBeNull();
    // Disconnect as a guest changes nothing.
    const before = s.pk;
    v.disconnect();
    expect(s.pk).toBe(before);
  });

  it('works for the session when storage is missing or throws', () => {
    const throwing: StorageLike = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    for (const st of [null, throwing]) {
      const s = slot(GUEST);
      const v = new AccountVault(st, s);
      v.connect(WALLET_PK, { address: ADDR, chainId: SEPOLIA, walletName: 'W' });
      expect(v.link()?.walletName).toBe('W');
      v.disconnect();
      expect(s.pk).toBe(GUEST);
    }
  });
});

describe('AccountStore', () => {
  function setup(wallets: WalletEntry[] | (() => Promise<WalletEntry[]>)) {
    const st = memStorage();
    const s = slot('0xabc123');
    let callsign = 'VIEWER0001';
    const subs = new Set<() => void>();
    const id = {
      callsign: () => callsign,
      setCallsign: (cs: string) => { callsign = cs; subs.forEach((f) => f()); },
      pub: () => BigInt(pubOf(s.pk)),
      subscribe: (fn: () => void) => { subs.add(fn); return () => subs.delete(fn); },
    };
    const vault = new AccountVault(st, { current: s.current, use: (pk) => { s.use(pk); subs.forEach((f) => f()); } });
    const store = new AccountStore(vault, { list: typeof wallets === 'function' ? wallets : async () => wallets }, id);
    return { store, s, st };
  }
  const entry = (api: WalletRequestApi, id = 'argentX'): WalletEntry => ({ id, name: 'Ready Wallet', icon: null, api, chainHint: null });

  it('connects, signs once, becomes a wallet player, and disconnects back to the guest', async () => {
    const { store, s } = setup([entry(fakeWallet())]);
    const seen: string[] = [];
    store.subscribe((st) => seen.push(`${st.mode}:${st.busy ?? '-'}`));
    expect(store.state().mode).toBe('guest');
    expect(await store.wallets()).toEqual([{ id: 'argentX', name: 'Ready Wallet', icon: null }]);
    expect(await store.connect('argentX')).toBe(true);
    const st = store.state();
    expect(st.mode).toBe('wallet');
    expect(st.wallet?.walletName).toBe('Ready Wallet');
    expect(st.pub).toBe(BigInt(pubOf(s.pk)));
    expect(st.callsign).toBe('VIEWER0001');
    expect(seen).toContain('guest:connecting');
    expect(seen).toContain('guest:signing');
    expect(seen[seen.length - 1]).toBe('wallet:-');
    store.disconnect();
    expect(store.state().mode).toBe('guest');
    expect(s.pk).toBe('0xabc123');
  });

  it('says so when no wallet is installed, and stays a guest on rejection', async () => {
    const none = setup([]);
    expect(await none.store.wallets()).toEqual([]);
    expect(await none.store.connect('argentX')).toBe(false);
    expect(none.store.state()).toMatchObject({ mode: 'guest', busy: null, message: NO_WALLET_MESSAGE });

    const refused = setup([entry(fakeWallet({ reject: new Error('User rejected') }))]);
    expect(await refused.store.connect('argentX')).toBe(false);
    expect(refused.store.state()).toMatchObject({ mode: 'guest', busy: null });
    expect(refused.store.state().message).toMatch(/^Cancelled/);
    expect(refused.s.pk).toBe('0xabc123');

    const broken = setup(async () => { throw new Error('discovery exploded'); });
    expect(await broken.store.wallets()).toEqual([]);
    expect(await broken.store.connect('x')).toBe(false);
    expect(broken.store.state().message).toBe(NO_WALLET_MESSAGE);
  });

  it('a cancelled connect stays cancelled even if the wallet answers later', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: WalletRequestApi = {
      async request(call) {
        await gate;
        return fakeWallet().request(call);
      },
    };
    const { store, s } = setup([entry(slow)]);
    const p = store.connect('argentX');
    await Promise.resolve();
    expect(store.state().busy).toBe('connecting');
    store.cancel();
    release();
    expect(await p).toBe(false);
    expect(store.state()).toMatchObject({ mode: 'guest', busy: null });
    expect(s.pk).toBe('0xabc123');
  });

  it('applies the ranked lobby callsign rules', () => {
    const { store } = setup([]);
    expect(store.setCallsign('BEAST01')).toBe(true);
    expect(store.state().callsign).toBe('BEAST01');
    for (const bad of ['', 'lower', 'TOO_LONG_NAME', 'THIRTEENCHARS', 'A B']) expect(store.setCallsign(bad)).toBe(false);
    expect(store.state().callsign).toBe('BEAST01');
  });
});
