// Guest identity for ranked Broadcast runs: a Stark key pair kept in this browser. The public key
// (x-coordinate) is the player id onchain; the private key signs the strike log, so the relayer
// can carry a run to the contract but cannot change it. No wallet, no account.

import { getStarkKey, sign, utils } from '@scure/starknet';
import { CALLSIGN_RE, encodeShortString, FELT_P, hex, messageHash } from '../broadcast/hashes.ts';

const KEY = 'static.guest.v1';

interface Stored {
  pk: string;
  callsign: string;
}

let mem: Stored | null = null;

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
      if (typeof j.pk === 'string' && /^0x[0-9a-f]+$/.test(j.pk)) {
        mem = { pk: j.pk, callsign: typeof j.callsign === 'string' && CALLSIGN_RE.test(j.callsign) ? j.callsign : randomCallsign() };
        return mem;
      }
    }
  } catch {
    /* storage unavailable: a session-only key */
  }
  const pk = '0x' + Array.from(utils.randomPrivateKey(), (b) => b.toString(16).padStart(2, '0')).join('');
  mem = { pk, callsign: randomCallsign() };
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
    return BigInt(getStarkKey(load().pk));
  },
  get callsign(): string {
    return load().callsign;
  },
  setCallsign(cs: string) {
    if (!CALLSIGN_RE.test(cs)) throw new Error('callsign: 1 to 12 of A-Z 0-9');
    load().callsign = cs;
    save();
  },
  /** Stark ECDSA over a message hash (as checked by `check_ecdsa_signature`). */
  sign(msgHash: bigint): { r: string; s: string } {
    const sig = sign(hex(msgHash), load().pk);
    return { r: hex(sig.r), s: hex(sig.s) };
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
