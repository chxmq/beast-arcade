// Optional account layer. Guest play stays the instant default: a random Stark key kept in this
// browser (guest.ts). CONNECT WALLET asks an injected Starknet wallet for ONE typed-data signature
// (SNIP-12 revision 1: no transaction, no gas) and derives the player key from it:
//   priv = poseidonHashMany(signature felts) mod (curve order - 1) + 1
// A wallet that signs deterministically (RFC 6979 Stark signers do) gives the same player key on
// any device. The derived key becomes the active guest key, so ranked runs are signed exactly as
// before; the previous random key waits in a backup slot and DISCONNECT puts it back.
// Nothing here throws into the game: wallet problems end as a plain message in the state.

import { CURVE, getStarkKey, poseidonHashMany } from '@scure/starknet';
import type { WalletWithStarknetFeatures } from '@starknet-io/get-starknet-core';
import { CALLSIGN_RE, decodeShortString, encodeShortString, FELT_P } from '../broadcast/hashes.ts';
import { guest, PK_RE, randomPrivateKey } from './guest.ts';

// ---------------------------------------------------------------------------------- typed data

export const UNLOCK_DOMAIN_NAME = 'BEAST ARCADE';
export const UNLOCK_ACTION = 'Unlock my BEAST ARCADE player';

export interface UnlockTypedData {
  types: {
    StarknetDomain: { name: string; type: string }[];
    Unlock: { name: string; type: string }[];
  };
  primaryType: 'Unlock';
  domain: { name: string; version: string; chainId: string; revision: string };
  message: { action: string; player: string };
}

/**
 * The one message a wallet signs to unlock its player (SNIP-12 revision 1). Revision 1 domains are
 * typed `StarknetDomain` with shortstring fields and `revision: '1'`. The action fits a
 * shortstring (31 ASCII characters at most), which every revision 1 wallet displays as text.
 */
export function buildUnlockTypedData(chainId: string, player: string): UnlockTypedData {
  return {
    types: {
      StarknetDomain: [
        { name: 'name', type: 'shortstring' },
        { name: 'version', type: 'shortstring' },
        { name: 'chainId', type: 'shortstring' },
        { name: 'revision', type: 'shortstring' },
      ],
      Unlock: [
        { name: 'action', type: 'shortstring' },
        { name: 'player', type: 'ContractAddress' },
      ],
    },
    primaryType: 'Unlock',
    domain: { name: UNLOCK_DOMAIN_NAME, version: '1', chainId, revision: '1' },
    message: { action: UNLOCK_ACTION, player },
  };
}

// ---------------------------------------------------------------------------------- felts

/** A felt from a wallet: 0x hex, decimal string, safe integer or bigint. Null if not a felt. */
function felt(v: unknown): bigint | null {
  try {
    let x: bigint;
    if (typeof v === 'bigint') x = v;
    else if (typeof v === 'number' && Number.isSafeInteger(v)) x = BigInt(v);
    else if (typeof v === 'string' && /^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(v.trim())) x = BigInt(v.trim());
    else return null;
    return x >= 0n && x < FELT_P ? x : null;
  } catch {
    return null;
  }
}

/** An account address as stored and shown: 0x and 64 lowercase hex digits. Null if invalid. */
export function normalizeAddress(a: unknown): string | null {
  const x = felt(a);
  return x === null || x === 0n ? null : '0x' + x.toString(16).padStart(64, '0');
}

/**
 * A Starknet chain id as a 0x felt: wallets answer `0x534e5f5345504f4c4941`, some `SN_SEPOLIA`, the
 * wallet standard says `starknet:0x...`. All are the same shortstring felt. Null if unreadable.
 */
export function normalizeChainId(c: unknown): string | null {
  if (typeof c === 'string') {
    const s = c.trim().replace(/^starknet:/i, '');
    if (/^0x/i.test(s) || /^[0-9]+$/.test(s)) {
      const x = felt(s);
      return x !== null && x > 0n ? '0x' + x.toString(16) : null;
    }
    if (/^[\x20-\x7e]{1,31}$/.test(s)) return '0x' + encodeShortString(s).toString(16);
    return null;
  }
  const x = felt(c);
  return x !== null && x > 0n ? '0x' + x.toString(16) : null;
}

/** "SEPOLIA", "MAINNET", another chain's readable name, or its short hex. */
export function networkName(chainId: string): string {
  const x = felt(chainId);
  if (x === null) return 'UNKNOWN NETWORK';
  const s = decodeShortString(x);
  if (s === 'SN_MAIN') return 'MAINNET';
  if (s === 'SN_SEPOLIA') return 'SEPOLIA';
  if (/^[\x20-\x7e]{1,31}$/.test(s)) return s.replace(/^SN_/, '').toUpperCase();
  const h = chainId.toLowerCase();
  return h.length > 12 ? `${h.slice(0, 6)}..${h.slice(-4)}` : h;
}

/** "0x1234...abcd". */
export function shortAddress(a: string): string {
  const x = felt(a);
  if (x === null) return a;
  const h = x.toString(16).padStart(64, '0');
  return `0x${h.slice(0, 4)}...${h.slice(-4)}`;
}

export class AccountError extends Error {
  constructor(readonly kind: 'rejected' | 'no-account' | 'network' | 'bad-signature' | 'no-wallet' | 'gone', message: string) {
    super(message);
  }
}

/**
 * The signature as felts. The wallet API answers a felt array ([r, s] for a plain account, longer
 * for multisig or guardian accounts); a few wallets answer an { r, s } object.
 */
export function signatureFelts(sig: unknown): bigint[] {
  let parts: unknown[] | null = null;
  if (Array.isArray(sig)) parts = sig;
  else if (sig && typeof sig === 'object' && 'r' in sig && 's' in sig) parts = [(sig as { r: unknown }).r, (sig as { s: unknown }).s];
  if (!parts || parts.length === 0 || parts.length > 64) throw new AccountError('bad-signature', 'The wallet returned no usable signature.');
  const out = parts.map(felt);
  if (out.some((x) => x === null) || out.every((x) => x === 0n)) throw new AccountError('bad-signature', 'The wallet returned no usable signature.');
  return out as bigint[];
}

/** The player private key from the signature felts: in [1, n - 1], so always a valid Stark key. */
export function derivePlayerKey(felts: readonly bigint[]): bigint {
  if (!felts.length) throw new AccountError('bad-signature', 'The wallet returned no usable signature.');
  return (poseidonHashMany([...felts]) % (CURVE.n - 1n)) + 1n;
}

export const keyHex = (k: bigint): string => '0x' + k.toString(16).padStart(64, '0');

const pubMemo = new Map<string, string>();
/** Stark public key of a private key, 0x hex (memoised: the cabinet asks often). */
export function pubOf(pk: string): string {
  let p = pubMemo.get(pk);
  if (!p) {
    p = '0x' + BigInt(getStarkKey(pk)).toString(16);
    if (pubMemo.size > 8) pubMemo.clear();
    pubMemo.set(pk, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------- unlock

/** The part of the Starknet wallet API this layer uses (`request` of the injected wallet). */
export interface WalletRequestApi {
  request(call: { type: string; params?: unknown }): Promise<unknown>;
}

export interface Unlocked {
  address: string;
  chainId: string;
  /** Player private key, 0x and 64 hex digits. */
  priv: string;
}

/**
 * wallet_requestAccounts, wallet_requestChainId, then one wallet_signTypedData. Throws AccountError
 * or the wallet's own error (see describeWalletError).
 */
export async function unlockWithWallet(api: WalletRequestApi, opts: { chainHint?: string | null; onSign?: () => void } = {}): Promise<Unlocked> {
  const accounts = await api.request({ type: 'wallet_requestAccounts' });
  const address = normalizeAddress(Array.isArray(accounts) ? accounts[0] : null);
  if (!address) throw new AccountError('no-account', 'The wallet did not share an account. Still playing as a guest.');
  let chainId: string | null = null;
  try {
    chainId = normalizeChainId(await api.request({ type: 'wallet_requestChainId' }));
  } catch {
    chainId = null;
  }
  chainId ??= normalizeChainId(opts.chainHint ?? null);
  if (!chainId) throw new AccountError('network', "Could not read the wallet's network. Still playing as a guest.");
  opts.onSign?.();
  const sig = await api.request({ type: 'wallet_signTypedData', params: buildUnlockTypedData(chainId, address) });
  return { address, chainId, priv: keyHex(derivePlayerKey(signatureFelts(sig))) };
}

/** Plain words for whatever a wallet threw. */
export function describeWalletError(e: unknown): string {
  if (e instanceof AccountError) return e.message;
  const o = (e && typeof e === 'object' ? e : {}) as { code?: unknown; message?: unknown; data?: unknown };
  const msg = typeof e === 'string' ? e : typeof o.message === 'string' ? o.message : '';
  if (o.code === 113 || o.code === 4001 || /reject|refus|cancel|denied|declin|abort|closed|USER_REFUSED/i.test(msg)) {
    return 'Cancelled in the wallet. Still playing as a guest.';
  }
  if (o.code === 112 || /not supported|unsupported|API_VERSION/i.test(msg)) {
    return 'This wallet could not sign the message. Try another wallet, or keep playing as a guest.';
  }
  const clean = msg.replace(/\s+/g, ' ').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 90);
  return clean ? `Wallet error: ${clean}. Still playing as a guest.` : 'The wallet did not answer. Still playing as a guest.';
}

// ---------------------------------------------------------------------------------- persistence

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** What is remembered about the connected wallet (never the signature). */
export interface WalletLink {
  address: string;
  chainId: string;
  walletName: string;
  walletId?: string;
  /** Public key of the player key this wallet unlocked; a link is live only while it is active. */
  pub: string;
}

export const ACCOUNT_KEY = 'beastarcade.account.v1';
export const BACKUP_KEY = 'static.guest.backup.v1';

/** The active guest key slot (guest.ts in the browser, a fake in tests). */
export interface KeySlot {
  current(): string;
  use(pk: string): void;
}

function parseLink(raw: string | null): WalletLink | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<WalletLink>;
    const address = normalizeAddress(j.address);
    const chainId = normalizeChainId(j.chainId);
    const pub = felt(j.pub);
    if (!address || !chainId || pub === null || typeof j.walletName !== 'string') return null;
    const walletName = j.walletName.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 40) || 'WALLET';
    return { address, chainId, walletName, ...(typeof j.walletId === 'string' ? { walletId: j.walletId.slice(0, 80) } : {}), pub: '0x' + pub.toString(16) };
  } catch {
    return null;
  }
}

/**
 * The wallet link and the backup guest key. Storage may be missing or throw: then both live in
 * memory for this session (the active key in guest.ts does the same).
 */
export class AccountVault {
  private mem = new Map<string, string>();

  constructor(private storage: StorageLike | null, private slot: KeySlot) {}

  private read(k: string): string | null {
    try {
      if (this.storage) return this.storage.getItem(k);
    } catch {
      /* fall through to memory */
    }
    return this.mem.get(k) ?? null;
  }

  private write(k: string, v: string | null) {
    if (v === null) this.mem.delete(k);
    else this.mem.set(k, v);
    try {
      if (v === null) this.storage?.removeItem(k);
      else this.storage?.setItem(k, v);
    } catch {
      /* memory copy above */
    }
  }

  /** The wallet link, only while the active key is still the one that wallet unlocked. */
  link(): WalletLink | null {
    const l = parseLink(this.read(ACCOUNT_KEY));
    if (!l) return null;
    try {
      return BigInt(pubOf(this.slot.current())) === BigInt(l.pub) ? l : null;
    } catch {
      return null;
    }
  }

  /** The random guest key kept while a wallet player is active. */
  backup(): string | null {
    try {
      const j = JSON.parse(this.read(BACKUP_KEY) ?? 'null') as { pk?: unknown } | null;
      return j && typeof j.pk === 'string' && PK_RE.test(j.pk) ? j.pk : null;
    } catch {
      return null;
    }
  }

  /** Make the wallet's player key active. From guest play, the guest key goes to the backup slot. */
  connect(priv: string, info: Omit<WalletLink, 'pub'>) {
    if (!PK_RE.test(priv)) throw new AccountError('bad-signature', 'The wallet returned no usable signature.');
    // From guest play, the guest key goes to the backup slot. Switching wallets keeps that backup
    // (a wallet key is never written there).
    if (!this.link()) this.write(BACKUP_KEY, JSON.stringify({ pk: this.slot.current() }));
    this.slot.use(priv);
    this.write(ACCOUNT_KEY, JSON.stringify({ ...info, pub: pubOf(priv) }));
  }

  /** Back to the backup guest key (a fresh one if the backup is gone). Never keeps the wallet key. */
  disconnect() {
    const live = this.link() !== null;
    this.write(ACCOUNT_KEY, null);
    if (!live) return;
    this.slot.use(this.backup() ?? randomPrivateKey());
    this.write(BACKUP_KEY, null);
  }
}

// ---------------------------------------------------------------------------------- discovery

export interface WalletChoice {
  id: string;
  name: string;
  /** data:image/... from the wallet itself, or null. */
  icon: string | null;
}

export interface WalletEntry extends WalletChoice {
  api: WalletRequestApi;
  /** The wallet standard's account chain, used if wallet_requestChainId is not supported. */
  chainHint: string | null;
}

export interface WalletSource {
  list(): Promise<WalletEntry[]>;
}

function toEntry(w: WalletWithStarknetFeatures): WalletEntry | null {
  try {
    const api = w.features['starknet:walletApi'];
    if (!api || typeof api.request !== 'function') return null;
    const name = String(w.name ?? '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 40) || 'Starknet wallet';
    const icon = typeof w.icon === 'string' && /^data:image\/(svg\+xml|png|webp|gif|jpeg)[;,]/.test(w.icon) ? w.icon : null;
    const chain = w.accounts?.[0]?.chains?.[0] ?? null;
    return {
      id: String(api.id || name),
      name,
      icon,
      api: { request: (call) => (api.request as (c: unknown) => Promise<unknown>)(call) },
      chainHint: typeof chain === 'string' ? chain : null,
    };
  } catch {
    return null;
  }
}

/** Injected Starknet wallets (Ready / Argent X, Braavos, any other), via get-starknet discovery. */
export function browserWalletSource(): WalletSource {
  type Store = { getWallets(): WalletWithStarknetFeatures[]; _refreshInjectedWallets(): void };
  let store: Promise<Store | null> | null = null;
  // Loaded on first use so guest play never pays for it. No EIP-1193 adapters: injected wallets only.
  const get = () =>
    (store ??= import('@starknet-io/get-starknet-core')
      .then((m) => m.createStore({ eip1193Adapters: [] }) as Store)
      .catch(() => {
        store = null;
        return null;
      }));
  return {
    async list() {
      if (typeof window === 'undefined') return [];
      const s = await get();
      if (!s) return [];
      try {
        s._refreshInjectedWallets();
      } catch {
        /* a broken injected object */
      }
      // Wallet-standard wallets answer the app-ready event at once; give late injectors a beat.
      await new Promise((r) => setTimeout(r, 120));
      const seen = new Set<string>();
      const out: WalletEntry[] = [];
      let all: WalletWithStarknetFeatures[] = [];
      try {
        all = s.getWallets();
      } catch {
        all = [];
      }
      for (const w of all) {
        const e = toEntry(w);
        if (e && !seen.has(e.id)) {
          seen.add(e.id);
          out.push(e);
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------- the store

export const NO_WALLET_MESSAGE = 'No Starknet wallet found. Install Ready or Braavos, or keep playing as a guest.';

export type AccountBusy = 'connecting' | 'signing' | null;

export interface AccountState {
  mode: 'guest' | 'wallet';
  callsign: string;
  /** Public key of the active player key: the player id onchain. */
  pub: bigint;
  wallet: WalletLink | null;
  busy: AccountBusy;
  /** The last problem in plain words, or null. */
  message: string | null;
}

export interface Identity {
  callsign(): string;
  setCallsign(cs: string): void;
  pub(): bigint;
  subscribe(fn: () => void): () => void;
}

type Listener = (s: AccountState) => void;

export class AccountStore {
  private listeners = new Set<Listener>();
  private busy: AccountBusy = null;
  private message: string | null = null;
  private gen = 0;
  private snap: AccountState;

  constructor(private vault: AccountVault, private source: WalletSource, private id: Identity) {
    this.snap = this.compute();
    id.subscribe(() => this.refresh());
  }

  private compute(): AccountState {
    let wallet: WalletLink | null = null;
    let pub = 0n;
    let callsign = 'PLAYER';
    try {
      wallet = this.vault.link();
      pub = this.id.pub();
      callsign = this.id.callsign();
    } catch {
      /* keep the defaults: the screen still renders */
    }
    return { mode: wallet ? 'wallet' : 'guest', callsign, pub, wallet, busy: this.busy, message: this.message };
  }

  private refresh() {
    this.snap = this.compute();
    for (const fn of [...this.listeners]) {
      try {
        fn(this.snap);
      } catch {
        /* a listener's bug must not break the store */
      }
    }
  }

  state(): AccountState {
    return this.snap;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Discover wallets. Never throws: [] when there are none or discovery failed. */
  async wallets(): Promise<WalletChoice[]> {
    try {
      return (await this.source.list()).map(({ id, name, icon }) => ({ id, name, icon }));
    } catch {
      return [];
    }
  }

  /** Connect a wallet and unlock its player with one signature. Never throws; true on success. */
  async connect(walletId: string): Promise<boolean> {
    if (this.busy) return false;
    const gen = ++this.gen;
    this.busy = 'connecting';
    this.message = null;
    this.refresh();
    const fail = (msg: string) => {
      if (gen !== this.gen) return false;
      this.busy = null;
      this.message = msg;
      this.refresh();
      return false;
    };
    try {
      const list = await this.source.list().catch(() => [] as WalletEntry[]);
      if (gen !== this.gen) return false;
      if (!list.length) return fail(NO_WALLET_MESSAGE);
      const w = list.find((x) => x.id === walletId);
      if (!w) return fail('That wallet is not available any more. Pick another one, or keep playing as a guest.');
      const r = await unlockWithWallet(w.api, {
        chainHint: w.chainHint,
        onSign: () => {
          if (gen !== this.gen) return;
          this.busy = 'signing';
          this.refresh();
        },
      });
      if (gen !== this.gen) return false;
      this.vault.connect(r.priv, { address: r.address, chainId: r.chainId, walletName: w.name, walletId: w.id });
      this.busy = null;
      this.message = null;
      this.refresh();
      return true;
    } catch (e) {
      return fail(describeWalletError(e));
    }
  }

  /** Abandon a pending connect (the wallet popup was closed, or the player left the card). */
  cancel() {
    if (!this.busy) return;
    this.gen++;
    this.busy = null;
    this.message = 'Cancelled. Still playing as a guest.';
    this.refresh();
  }

  /** Back to the backup guest key. */
  disconnect() {
    if (this.busy) this.gen++;
    this.busy = null;
    this.message = null;
    try {
      this.vault.disconnect();
    } catch {
      /* storage trouble: the state below says what is active */
    }
    this.refresh();
  }

  /** Same rules as the ranked lobby: A-Z 0-9, up to 12. False if refused. */
  setCallsign(cs: string): boolean {
    if (!CALLSIGN_RE.test(cs)) return false;
    try {
      this.id.setCallsign(cs);
    } catch {
      return false;
    }
    this.refresh();
    return true;
  }

  clearMessage() {
    if (this.message === null) return;
    this.message = null;
    this.refresh();
  }
}

function browserStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    localStorage.getItem(ACCOUNT_KEY);
    return localStorage;
  } catch {
    return null;
  }
}

export const account = new AccountStore(
  new AccountVault(browserStorage(), { current: () => guest.secret(), use: (pk) => guest.useSecret(pk) }),
  browserWalletSource(),
  { callsign: () => guest.callsign, setCallsign: (cs) => guest.setCallsign(cs), pub: () => guest.pub, subscribe: (fn) => guest.subscribe(fn) },
);
