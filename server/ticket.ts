// Signed play tickets: base64url(JSON payload) + '.' + base64url(HMAC-SHA256(key, payload)).
// The key is derived from BROADCAST_SECRET, so tickets need no server-side storage and any
// instance can check them.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface Ticket {
  rootId: number;
  /** Tape day (seed derivation). */
  day: number;
  k: number;
  /** 0x-hex felts */
  nonce: string;
  pub: string;
  /** Server ms at which frame 0 plays. */
  t0: number;
}

function keyOf(secret: bigint): Buffer {
  return createHash('sha256').update(`STATIC ticket v1 ${secret.toString(16)}`).digest();
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signTicket(secret: bigint, t: Ticket): string {
  const payload = b64url(JSON.stringify({ v: 1, ...t }));
  const mac = createHmac('sha256', keyOf(secret)).update(payload).digest();
  return `${payload}.${b64url(mac)}`;
}

export function verifyTicket(secret: bigint, s: unknown): Ticket | null {
  if (typeof s !== 'string' || s.length > 1024) return null;
  const [payload, mac, extra] = s.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  const want = createHmac('sha256', keyOf(secret)).update(payload).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const j = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const ints = [j.rootId, j.day, j.k, j.t0].every((x) => Number.isSafeInteger(x) && x >= 0);
    if (j.v !== 1 || !ints || typeof j.nonce !== 'string' || typeof j.pub !== 'string') return null;
    return { rootId: j.rootId, day: j.day, k: j.k, nonce: j.nonce, pub: j.pub, t0: j.t0 };
  } catch {
    return null;
  }
}
