// Guest identity for ranked Broadcast runs: a Stark key pair kept in this browser. The public key
// (x-coordinate) is the player id onchain; the private key signs the strike log, so the relayer
// can carry a run to the contract but cannot change it. No wallet needed: by default the key is
// random. The optional account layer (account.ts) may swap in a key unlocked by a wallet
// signature; everything here keeps working on whichever key is active.

import { getStarkKey, sign, utils } from '@scure/starknet';
import { CALLSIGN_RE, encodeShortString, FELT_P, hex, messageHash } from '../broadcast/hashes.ts';

export const GUEST_KEY = 'static.guest.v1';
const KEY = GUEST_KEY;
/** Private keys as stored: 0x and lowercase hex. */
export const PK_RE = /^0x[0-9a-f]+$/;

interface Stored {
  pk: string;
  callsign: string;
}

let mem: Stored | null = null;
let pubMemo: { pk: string; pub: bigint } | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* a listener's bug must not break the caller */
    }
  }
}

/** A fresh random private key, 0x hex. */
export function randomPrivateKey(): string {
  return '0x' + Array.from(utils.randomPrivateKey(), (b) => b.toString(16).padStart(2, '0')).join('');
}

function randomCallsign(): string {
  const n = crypto.getRandomValues(new Uint16Array(1))[0] % 10000;
  return `VIEWER${String(n).padStart(4, '0')}`;
}

function load(): Stored {
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<Stored>;
      if (typeof j.pk === 'string' && PK_RE.test(j.pk)) {
        mem = { pk: j.pk, callsign: typeof j.callsign === 'string' && CALLSIGN_RE.test(j.callsign) ? j.callsign : randomCallsign() };
        return mem;
      }
    }
  } catch {
    /* storage unavailable: a session-only key */
  }
  mem = { pk: randomPrivateKey(), callsign: randomCallsign() };
  save();
  return mem;
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(mem));
  } catch {
    /* storage unavailable */
  }
}

export const guest = {
  /** Stark public key (x-coordinate), the player id onchain. */
  get pub(): bigint {
    const pk = load().pk;
    if (pubMemo?.pk !== pk) pubMemo = { pk, pub: BigInt(getStarkKey(pk)) };
    return pubMemo.pub;
  },
  get callsign(): string {
    return load().callsign;
  },
  setCallsign(cs: string) {
    if (!CALLSIGN_RE.test(cs)) throw new Error('callsign: 1 to 12 of A-Z 0-9');
    if (load().callsign === cs) return;
    load().callsign = cs;
    save();
    emit();
  },
  /** Stark ECDSA over a message hash (as checked by `check_ecdsa_signature`). */
  sign(msgHash: bigint): { r: string; s: string } {
    const sig = sign(hex(msgHash), load().pk);
    return { r: hex(sig.r), s: hex(sig.s) };
  },
  /** The active private key. Only the account layer reads it (to keep a backup). */
  secret(): string {
    return load().pk;
  },
  /** Make `pk` the active key, keeping the callsign. Only the account layer calls this. */
  useSecret(pk: string) {
    if (!PK_RE.test(pk)) throw new Error('guest key: 0x lowercase hex');
    if (load().pk === pk) return;
    load().pk = pk;
    save();
    emit();
  },
  /** Called after the callsign or the active key changed. */
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

/** Callsign as the Cairo short-string felt the contract stores. */
export const callsignFelt = (cs: string): bigint => encodeShortString(cs);

/** The exact message the contract verifies (`message_hash` view). */
export function runMessage(rootId: number, k: number, nonce: bigint, callsign: string, strikes: readonly number[]): bigint {
  return messageHash(rootId, k, nonce, callsignFelt(callsign), strikes);
}

/** A fresh random felt nonce (picks the tape: k = poseidon([pub, nonce]) mod n). */
export function randomNonce(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v % FELT_P;
}
