// Decoders for Cairo return values (felt short strings, ByteArray, u256 split).

const MASK128 = (1n << 128n) - 1n;

export const toHex = (x: bigint | string): string => '0x' + BigInt(x).toString(16);

/** Split a felt/u256 value into [low, high] 128-bit halves, as hex calldata. */
export function u256Calldata(x: bigint | string): [string, string] {
  const v = BigInt(x);
  return [toHex(v & MASK128), toHex(v >> 128n)];
}

function pushWord(out: number[], word: bigint, len: number): void {
  for (let i = len - 1; i >= 0; i--) out.push(Number((word >> BigInt(8 * i)) & 0xffn));
}

/** Decode a felt252 short string (big-endian ASCII, leading zero bytes dropped). */
export function decodeShortString(felt: string): string {
  const v = BigInt(felt);
  const bytes: number[] = [];
  pushWord(bytes, v, 31);
  let s = 0;
  while (s < bytes.length && bytes[s] === 0) s++;
  return Buffer.from(bytes.slice(s)).toString('utf8');
}

/**
 * Decode a serialized ByteArray starting at `offset`:
 * [n_full_words, word_0..word_{n-1} (31 bytes each), pending_word, pending_len].
 * Returns the bytes and the number of felts consumed.
 */
export function decodeByteArray(felts: string[], offset = 0): { bytes: Buffer; used: number } {
  const n = Number(BigInt(felts[offset]));
  const out: number[] = [];
  for (let i = 0; i < n; i++) pushWord(out, BigInt(felts[offset + 1 + i]), 31);
  const pending = BigInt(felts[offset + 1 + n]);
  const pendingLen = Number(BigInt(felts[offset + 2 + n]));
  pushWord(out, pending, pendingLen);
  return { bytes: Buffer.from(out), used: n + 3 };
}

export function decodeByteArrayString(felts: string[], offset = 0): string {
  return decodeByteArray(felts, offset).bytes.toString('utf8');
}

/** Decode a `data:<mime>[;base64],<payload>` URI into its mime type and raw bytes. */
export function decodeDataUri(uri: string): { mime: string; bytes: Buffer } {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),/.exec(uri);
  if (!m) throw new Error(`not a data URI: ${uri.slice(0, 60)}`);
  const payload = uri.slice(m[0].length);
  const isB64 = m[2].split(';').includes('base64');
  const bytes = isB64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { mime: m[1], bytes };
}
