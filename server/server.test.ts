// Server library tests: tickets, seeds/tree, and the whole Broadcast flow through the HTTP
// handlers in offchain mode (no contract): start, gated segments, signed submit, seed reveal.
import { readFileSync } from 'node:fs';
import { getStarkKey, sign } from '@scure/starknet';
import type { Roster } from '../src/data/roster.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resultToJson, slotFromJson, type StartResponse, type SubmitResponse } from '../src/broadcast/api.ts';
import { encodeShortString, hex, leafHash, messageHash, tapeIndex } from '../src/broadcast/hashes.ts';
import { buildTree, processProof } from '../src/broadcast/merkle.ts';
import { FRAME_BYTES, MaskBook, renderSegment, SEG_FRAMES, Tape } from '../src/broadcast/tape.ts';
import { Trigger } from '../src/broadcast/trigger.ts';
import { encodeStrike } from '../src/sim/encode.ts';
import { replay } from '../src/sim/replay.ts';
import { expiresAtFor, leaves, seedFor, tapeDayOf, treeFor } from './seeds.ts';
import { signTicket, verifyTicket } from './ticket.ts';

describe('tickets', () => {
  const t = { rootId: 3, day: 20409, k: 17, nonce: '0x2a', pub: '0x1234', t0: 1_763_340_000_000 };
  it('round trip', () => expect(verifyTicket(5n, signTicket(5n, t))).toEqual(t));
  it('rejects tampering and other secrets', () => {
    const s = signTicket(5n, t);
    const [p, mac] = s.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, ...t, k: 18 })).toString('base64url');
    expect(verifyTicket(5n, `${forged}.${mac}`)).toBeNull();
    expect(verifyTicket(6n, s)).toBeNull();
    expect(verifyTicket(5n, `${p}.`)).toBeNull();
    expect(verifyTicket(5n, 42)).toBeNull();
  });
});

describe('seeds', () => {
  it('async cached tree equals the reference tree', async () => {
    for (const n of [1, 5, 8, 13]) expect((await treeFor(9n, 100, n)).root).toBe(buildTree(leaves(9n, 100, n)).root);
  });
  it('tape day round trips through expires_at', () => {
    for (const d of [0, 20409, 20774]) expect(tapeDayOf(expiresAtFor(d))).toBe(d);
  });
});

describe('broadcast handlers (offchain mode)', () => {
  const roster = JSON.parse(readFileSync('public/data/roster.json', 'utf8')) as Roster;
  const saved = { ...process.env };
  let h: typeof import('./handlers.ts');
  const PRIV = '0x3c1e9550e66958296d11b60f8e8e7a7ad990d07fa65d5f7652c4a6c87d4e3b4';
  const pub = BigInt(getStarkKey(PRIV));
  const base = 'http://localhost/api/broadcast';
  const post = (path: string, body: unknown) =>
    h.route(new Request(`${base}/${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));

  beforeAll(async () => {
    for (const k of ['STATIC_CONTRACT', 'RELAYER_ADDRESS', 'RELAYER_PK', 'CRON_SECRET']) delete process.env[k];
    process.env.BROADCAST_OFFCHAIN = '1';
    process.env.BROADCAST_SECRET = '0xabc123';
    process.env.TAPES_PER_DAY = '16';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
    h = await import('./handlers.ts');
  });
  afterAll(() => {
    vi.useRealTimers();
    process.env = saved;
  });

  it('plays a tape end to end and reveals the seed only on submit', async () => {
    const status = await (await h.route(new Request(`${base}/status`))).json();
    expect(status).toMatchObject({ onAir: true, offchain: true, rootId: 0, n: 16 });

    const startRes = await post('start', { pub: hex(pub), nonce: '0x7' });
    expect(startRes.status).toBe(200);
    const st = (await startRes.json()) as StartResponse;
    expect(st).toMatchObject({ fps: 30, segFrames: 150, w: 256, h: 144 });
    expect(JSON.stringify(st)).not.toMatch(/seed/);

    // The signed nonce is server-mixed: the client cannot pick (or re-draw) a tape.
    expect(BigInt(st.nonce)).not.toBe(7n);
    expect(tapeIndex(pub, BigInt(st.nonce), 16)).toBe(st.k);

    // Segment gating: segment 1 is served from t0 + 5 s - 2.5 s, not before.
    const seg = (i: number) => h.route(new Request(`${base}/seg?ticket=${encodeURIComponent(st.ticket)}&i=${i}`));
    expect((await seg(0)).status).toBe(403);
    vi.setSystemTime(st.t0 - 2500);
    expect((await seg(0)).status).toBe(200);
    vi.setSystemTime(st.t0 + 2400);
    expect((await seg(1)).status).toBe(403);
    vi.setSystemTime(st.t0 + 2600);
    const s1 = await seg(1);
    expect(s1.status).toBe(200);
    const bytes = new Uint8Array(await s1.arrayBuffer());
    expect(bytes.length).toBe(SEG_FRAMES * FRAME_BYTES);

    // A strike log paced like the client's (Trigger: type 0, always the after-miss gap), signed
    // and submitted at the end of the tape.
    vi.setSystemTime(st.t0 + (st.frames * 1000) / 30 + 1000);
    const trig = new Trigger();
    for (const [tick, x, y] of [[100, 120, 60], [110, 10, 10], [140, 30, 30], [158, 200, 100]]) trig.fire(tick, x, y);
    const strikes = trig.strikes;
    expect(strikes).toHaveLength(3);
    const signed = (log: number[]) => {
      const s = sign(hex(messageHash(st.rootId, st.k, BigInt(st.nonce), encodeShortString('TESTER1'), log)), PRIV);
      return { ticket: st.ticket, callsign: 'TESTER1', strikes: log, sig: { r: hex(s.r), s: hex(s.s) } };
    };
    // One tick after a strike is too soon whatever it hit (GAP_HIT), and v2 strikes carry no flags.
    const tooSoon = await post('submit', signed([...strikes, encodeStrike({ tick: 159, x: 0, y: 0, type: 0 })]));
    expect(tooSoon.status).toBe(400);
    expect((await tooSoon.json()).error).toMatch(/bad gap/);
    const flagged = await post('submit', signed([strikes[0] + 1]));
    expect(flagged.status).toBe(400);
    expect((await flagged.json()).error).toMatch(/bad type/);
    const res = await post('submit', signed(strikes));
    expect(res.status).toBe(200);
    const sub = (await res.json()) as SubmitResponse;
    expect(sub).toMatchObject({ txHash: null, offchain: true, k: st.k, rootId: 0 });

    // The revealed seed is the committed leaf, and it reproduces the streamed pixels and the result.
    const seed = BigInt(sub.seed);
    expect(processProof(sub.proof.map(BigInt), leafHash(sub.k, seed))).toBe(BigInt(sub.root));
    const slots = sub.roster.map(slotFromJson);
    const local = replay(seed, slots.map((s) => s.entry), sub.nFeatured, strikes);
    expect(sub.result).toEqual(resultToJson(local));
    expect(Object.keys(sub.result).sort()).toEqual(['bestCombo', 'caughtMask', 'dead', 'deathTick', 'digest', 'killer', 'killerRoster', 'kills', 'lives', 'score', 'shinyMask']);
    expect(sub.result.caughtMask).toBe('0x' + local.caughtMask.toString(16));
    expect(sub.result.shinyMask).toBe('0x' + local.shinyMask.toString(16));
    const art = new Map(roster.entries.map((e) => [e.speciesId, e]));
    const tape = new Tape({ seed, slots, nFeatured: sub.nFeatured }, new MaskBook((id) => art.get(id)));
    expect(tape.frames).toBe(st.frames);
    renderSegment(tape, 0);
    expect(Buffer.from(renderSegment(tape, 1)).equals(Buffer.from(bytes))).toBe(true);

    // The board shows the run; the tape is used.
    const board = (await (await h.route(new Request(`${base}/status`))).json()).board;
    expect(board[0]).toMatchObject({ callsign: 'TESTER1', score: sub.result.score });
    // A second submit of the same ticket returns the same answer (idempotent retry).
    const again = await post('submit', signed(strikes));
    expect(((await again.json()) as SubmitResponse).seed).toBe(sub.seed);
    expect(seedFor(0xabc123n, Number(JSON.parse(Buffer.from(st.ticket.split('.')[0], 'base64url').toString()).day), st.k)).toBe(seed);
  });

  it('rejects late submissions and forged signatures', async () => {
    vi.setSystemTime(new Date('2026-11-17T13:00:00Z'));
    const st = (await (await post('start', { pub: hex(pub), nonce: '0x99' })).json()) as StartResponse;
    const strikes = [encodeStrike({ tick: 200, x: 10, y: 10, type: 0 })];
    const wrong = sign(hex(messageHash(st.rootId, st.k, BigInt(st.nonce), encodeShortString('OTHER'), strikes)), PRIV);
    vi.setSystemTime(st.t0 + 10_000);
    const r1 = await post('submit', { ticket: st.ticket, callsign: 'TESTER1', strikes, sig: { r: hex(wrong.r), s: hex(wrong.s) } });
    expect(r1.status).toBe(400);
    vi.setSystemTime(st.t0 + (st.frames * 1000) / 30 + 16_000);
    const ok = sign(hex(messageHash(st.rootId, st.k, BigInt(st.nonce), encodeShortString('TESTER1'), strikes)), PRIV);
    const r2 = await post('submit', { ticket: st.ticket, callsign: 'TESTER1', strikes, sig: { r: hex(ok.r), s: hex(ok.s) } });
    expect(r2.status).toBe(410);
  });
});
