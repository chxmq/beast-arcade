// Broadcast HTTP API as Web-standard handlers (Request -> Response). Used as-is by the Vite dev
// server (vite.config.ts) and bundled per route for Vercel (scripts/build-api.ts).
//
// Commit / reveal: tape seeds are committed onchain (daily Merkle root) before anyone plays. The
// client only ever receives pixels. A seed is revealed in the /submit response only after the
// relayer's submit_broadcast tx was accepted by the node, so every revealed tape is used onchain.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { poseidonHashMany, Signature, verify as starkVerify } from '@scure/starknet';
import rosterJson from '../public/data/roster.json';
import { toSimRoster, type Roster } from '../src/data/roster.ts';
import { resultToJson, slotToJson, type BoardRow, type StartResponse, type StatusResponse, type SubmitResponse } from '../src/broadcast/api.ts';
import { CALLSIGN_RE, encodeShortString, hex, leafHash, messageHash, parseFelt, tapeIndex } from '../src/broadcast/hashes.ts';
import { proofFor, processProof } from '../src/broadcast/merkle.ts';
import { MaskBook, renderSegment, SEG_FRAMES, SEG_MS, segmentCount, Tape, TAPE_FPS, TAPE_H, TAPE_W, type TapeSlot } from '../src/broadcast/tape.ts';
import { decodeStrike } from '../src/sim/encode.ts';
import { replay } from '../src/sim/replay.ts';
import { MAX_STRIKES } from '../src/sim/spec.ts';
import { chainFor, submitCalldata, type RootInfo } from './chain.ts';
import { readEnv, type ServerEnv } from './env.ts';
import { expiresAtFor, seedFor, tapeDayOf, treeFor, utcDay } from './seeds.ts';
import { signTicket, verifyTicket, type Ticket } from './ticket.ts';

const COUNTDOWN_MS = 3000;
const PREFETCH_MS = 2500;
const SUBMIT_GRACE_MS = 15_000;

// ---------------------------------------------------------------------------------- roots

interface RootCtx {
  rootId: number;
  /** Seed derivation day (from expires_at for chain roots). */
  tapeDay: number;
  /** Daily board the root's runs land on (contract RootInfo.day). */
  boardDay: number;
  n: number;
  /** ms */
  expiresAt: number;
  /** Onchain root (null offchain: computed locally). */
  root: bigint | null;
  slots: TapeSlot[];
  nFeatured: number;
  offchain: boolean;
}

const roster = rosterJson as unknown as Roster;
const speciesArt = new Map(roster.entries.map((e) => [e.speciesId, e]));
const book = new MaskBook((id) => speciesArt.get(id));

/** Offchain test mode: the local roster.json in sim order (featured first), root id 0. */
const offchainSlots: TapeSlot[] = (() => {
  const ordered = [...roster.entries.filter((e) => e.featured), ...roster.entries.filter((e) => !e.featured)];
  const sim = toSimRoster(roster);
  return ordered.map((e, i) => ({ speciesId: e.speciesId, entry: sim[i] }));
})();

function offchainRoot(env: ServerEnv, day: number): RootCtx {
  return {
    rootId: 0, tapeDay: day, boardDay: day, n: env.tapesPerDay, expiresAt: expiresAtFor(day) * 1000,
    root: null, slots: offchainSlots, nFeatured: roster.nFeatured, offchain: true,
  };
}

let latestCache: { at: number; value: { rootId: number; info: RootInfo } } | null = null;

async function liveRoot(env: ServerEnv): Promise<RootCtx | string> {
  if (env.mode === 'off') return env.reason ?? 'off air';
  const now = Date.now();
  if (env.mode === 'offchain') return offchainRoot(env, utcDay(now));
  const chain = chainFor(env);
  if (!latestCache || now - latestCache.at > 15_000) latestCache = { at: now, value: await chain.latestRoot() };
  const { rootId, info } = latestCache.value;
  if (rootId === 0) return 'no tape root posted yet';
  if (now >= info.expiresAt * 1000) return 'today\'s tape root is not posted yet';
  return rootById(env, rootId);
}

async function rootById(env: ServerEnv, rootId: number, day?: number): Promise<RootCtx> {
  if (env.mode === 'offchain') return offchainRoot(env, day ?? utcDay());
  const chain = chainFor(env);
  const info = await chain.getRoot(rootId);
  return {
    rootId, tapeDay: tapeDayOf(info.expiresAt), boardDay: info.day, n: info.n, expiresAt: info.expiresAt * 1000,
    root: info.root, slots: await chain.rootRoster(rootId), nFeatured: info.nFeatured, offchain: false,
  };
}

// ---------------------------------------------------------------------------------- state
// Per-instance memory. Best effort only: the contract is the authority on used tapes.

const tapeKey = (rootId: number, day: number, k: number) => `${rootId}:${day}:${k}`;
/** Tapes handed out and not yet past their submit deadline. */
const reserved = new Map<string, number>();
/** Tape renderers by tape key: consecutive segments continue instead of re-simulating. */
const tapes = new Map<string, Tape>();
/** Submit responses by tape key (an idempotent retry gets the same answer). */
const submitted = new Map<string, SubmitResponse>();
const offchainUsed = new Set<string>();
let offchainBoard: BoardRow[] = [];
let offchainRuns = 0;
const hits = new Map<string, number[]>();

function remember<V>(m: Map<string, V>, key: string, v: V, max: number) {
  m.delete(key);
  m.set(key, v);
  while (m.size > max) m.delete(m.keys().next().value!);
}

/** The tape of ticket `t`; a cached renderer is reused if it has not passed `fromFrame` yet. */
function tapeFor(ctx: RootCtx, secret: bigint, t: { day: number; k: number }, fromFrame = Infinity): Tape {
  const key = tapeKey(ctx.rootId, t.day, t.k);
  let tape = tapes.get(key);
  if (!tape || tape.frame >= fromFrame) {
    tape = new Tape({ seed: seedFor(secret, t.day, t.k), slots: ctx.slots, nFeatured: ctx.nFeatured }, book);
  }
  remember(tapes, key, tape, 24);
  return tape;
}

function deadlineOf(t0: number, frames: number): number {
  return t0 + (frames * 1000) / TAPE_FPS + SUBMIT_GRACE_MS;
}

function rateLimited(req: Request, bucket: string, max: number, windowMs = 60_000): boolean {
  const ip = (req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'local').split(',')[0].trim();
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  remember(hits, key, list, 5000);
  return list.length > max;
}

// ---------------------------------------------------------------------------------- http

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status: number, error: string) => json({ error }, status);

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (text.length > 64_000) return null;
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

type Handler = (req: Request) => Promise<Response>;

function safe(fn: Handler): Handler {
  return async (req) => {
    try {
      return await fn(req);
    } catch (e) {
      console.error('[broadcast]', new URL(req.url).pathname, e instanceof Error ? e.message : e);
      return fail(502, 'upstream error, try again');
    }
  };
}

/** Cairo `check_ecdsa_signature` takes the public key as an x-coordinate and accepts either y. */
function verifySig(msg: bigint, pub: bigint, r: bigint, s: bigint): boolean {
  const x = pub.toString(16).padStart(64, '0');
  for (const prefix of ['02', '03']) {
    try {
      if (starkVerify(new Signature(r, s), hex(msg), prefix + x)) return true;
    } catch {
      /* not a point for this parity */
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------- handlers

let statusCache: { at: number; body: StatusResponse } | null = null;

export const status = safe(async () => {
  const env = readEnv();
  const now = Date.now();
  if (env.mode === 'chain' && statusCache && now - statusCache.at < 10_000) return json(statusCache.body);
  const ctx = await liveRoot(env);
  let body: StatusResponse;
  if (typeof ctx === 'string') {
    body = { onAir: false, reason: ctx, rootId: 0, day: utcDay(now), n: 0, expiresAt: 0, board: [] };
  } else {
    const board = ctx.offchain ? offchainBoard : await chainFor(env).top(ctx.boardDay);
    body = {
      onAir: true, rootId: ctx.rootId, day: ctx.boardDay, n: ctx.n, expiresAt: ctx.expiresAt, board,
      ...(ctx.offchain ? { offchain: true } : { contract: env.contract! }),
    };
  }
  if (env.mode === 'chain') statusCache = { at: now, body };
  return json(body);
});

export const start = safe(async (req) => {
  const env = readEnv();
  if (rateLimited(req, 'start', 10)) return fail(429, 'slow down');
  const body = await readJson(req);
  const pub = parseFelt(body?.pub);
  const clientNonce = parseFelt(body?.nonce);
  if (!pub || clientNonce === null) return fail(400, 'pub and nonce must be felts');
  const ctx = await liveRoot(env);
  if (typeof ctx === 'string') return fail(503, `off air: ${ctx}`);

  // The signed nonce mixes server randomness into the client's, so a player can neither choose a
  // tape nor draw the same one again after watching it (k = poseidon([pub, nonce]) mod n).
  const now = Date.now();
  for (const [kk, until] of reserved) if (until < now) reserved.delete(kk);
  let pick: { nonce: bigint; k: number; key: string } | null = null;
  for (let attempt = 0; attempt < 4 && !pick; attempt++) {
    const salt = BigInt('0x' + randomBytes(31).toString('hex'));
    const nonce = poseidonHashMany([clientNonce, salt]);
    const k = tapeIndex(pub, nonce, ctx.n);
    const key = tapeKey(ctx.rootId, ctx.tapeDay, k);
    const used = reserved.has(key) || (ctx.offchain ? offchainUsed.has(key) : await chainFor(env).isTapeUsed(ctx.rootId, k));
    if (!used) pick = { nonce, k, key };
  }
  if (!pick) return fail(409, 'no free tape drawn, retry');

  const { nonce, k, key } = pick;
  const tape = tapeFor(ctx, env.secret!, { day: ctx.tapeDay, k });
  const t0 = now + COUNTDOWN_MS;
  reserved.set(key, deadlineOf(t0, tape.frames));
  const t: Ticket = { rootId: ctx.rootId, day: ctx.tapeDay, k, nonce: hex(nonce), pub: hex(pub), t0 };
  const res: StartResponse = {
    ticket: signTicket(env.secret!, t), rootId: ctx.rootId, k, nonce: hex(nonce), t0, now,
    fps: TAPE_FPS, segFrames: SEG_FRAMES, frames: tape.frames, w: TAPE_W, h: TAPE_H,
  };
  return json(res);
});

export const seg = safe(async (req) => {
  const env = readEnv();
  if (env.mode === 'off') return fail(503, 'off air');
  const url = new URL(req.url);
  const t = verifyTicket(env.secret!, url.searchParams.get('ticket'));
  const i = Number(url.searchParams.get('i'));
  if (!t) return fail(403, 'bad ticket');
  if (!Number.isInteger(i) || i < 0) return fail(400, 'bad segment');
  const now = Date.now();
  // No downloading ahead: segment i plays at t0 + i * 5 s and is served 2.5 s before that.
  if (now < t.t0 + i * SEG_MS - PREFETCH_MS) return fail(403, 'too early');

  const ctx = await rootById(env, t.rootId, t.day);
  const tape = tapeFor(ctx, env.secret!, t, i * SEG_FRAMES);
  if (i >= segmentCount(tape.frames)) return fail(404, 'no such segment');
  if (now > deadlineOf(t.t0, tape.frames)) return fail(410, 'tape is over');
  const bytes = renderSegment(tape, i);
  return new Response(bytes, {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-frames': String(Math.min(SEG_FRAMES, tape.frames - i * SEG_FRAMES)) },
  });
});

export const submit = safe(async (req) => {
  const env = readEnv();
  if (env.mode === 'off') return fail(503, 'off air');
  if (rateLimited(req, 'submit', 12)) return fail(429, 'slow down');
  const body = await readJson(req);
  const t = verifyTicket(env.secret!, body?.ticket);
  if (!t) return fail(403, 'bad ticket');
  const callsign = body?.callsign;
  if (typeof callsign !== 'string' || !CALLSIGN_RE.test(callsign)) return fail(400, 'callsign: 1 to 12 of A-Z 0-9');
  const strikes = body?.strikes;
  if (!Array.isArray(strikes) || strikes.length > MAX_STRIKES || !strikes.every((v) => Number.isSafeInteger(v) && v >= 0 && v < 2 ** 32)) {
    return fail(400, 'bad strikes');
  }
  const sig = body?.sig as { r?: unknown; s?: unknown } | undefined;
  const r = parseFelt(sig?.r);
  const s = parseFelt(sig?.s);
  if (!r || !s) return fail(400, 'bad signature');

  const key = tapeKey(t.rootId, t.day, t.k);
  const done = submitted.get(key);
  if (done) return json(done);

  const ctx = await rootById(env, t.rootId, t.day);
  const seed = seedFor(env.secret!, t.day, t.k);
  const frames = tapeFor(ctx, env.secret!, t).frames;
  if (Date.now() > deadlineOf(t.t0, frames)) return fail(410, 'too late: the submit window closed');
  if (strikes.some((v) => decodeStrike(v).tick > 2 * (frames - 1))) return fail(400, 'strike after the end of the tape');

  // Same rules as the contract (throws like its panics).
  let result;
  try {
    result = replay(seed, ctx.slots.map((x) => x.entry), ctx.nFeatured, strikes);
  } catch (e) {
    return fail(400, `invalid strike log: ${e instanceof Error ? e.message : e}`);
  }
  const callsignFelt = encodeShortString(callsign);
  const nonce = BigInt(t.nonce);
  const pub = BigInt(t.pub);
  if (!verifySig(messageHash(t.rootId, t.k, nonce, callsignFelt, strikes), pub, r, s)) return fail(400, 'bad signature');

  const tree = await treeFor(env.secret!, t.day, ctx.n);
  if (ctx.root !== null && tree.root !== ctx.root) {
    console.error(`[broadcast] root ${t.rootId} does not match the tree of day ${t.day} (wrong secret or TAPES_PER_DAY?)`);
    return fail(500, 'tape root mismatch');
  }
  const proof = proofFor(tree, t.k);
  if (processProof(proof, leafHash(t.k, seed)) !== tree.root) return fail(500, 'bad proof');

  let txHash: string | null = null;
  if (ctx.offchain) {
    if (offchainUsed.has(key)) return fail(409, 'tape already used');
    offchainUsed.add(key);
    const row: BoardRow = { callsign, score: result.score, runId: ++offchainRuns, player: t.pub };
    const prev = offchainBoard.find((b) => b.player === t.pub);
    if (!prev || row.score > prev.score) {
      offchainBoard = [...offchainBoard.filter((b) => b !== prev), row].sort((a, b) => b.score - a.score || a.runId - b.runId).slice(0, 20);
    }
  } else {
    const calldata = submitCalldata({ rootId: t.rootId, k: t.k, nonce, seed, proof, pub, callsign: callsignFelt, strikes, r, s });
    try {
      txHash = await chainFor(env).invoke('submit_broadcast', calldata);
    } catch (e) {
      console.error('[broadcast] submit_broadcast failed:', e instanceof Error ? e.message : e);
      return fail(502, 'relayer could not submit the run, try again');
    }
    statusCache = null;
  }

  const res: SubmitResponse = {
    txHash,
    ...(ctx.offchain ? { offchain: true } : { contract: env.contract! }),
    seed: hex(seed), rootId: t.rootId, k: t.k, nonce: t.nonce, root: hex(tree.root), proof: proof.map(hex),
    roster: ctx.slots.map(slotToJson), nFeatured: ctx.nFeatured,
    result: resultToJson(result),
  };
  remember(submitted, key, res, 500);
  reserved.delete(key);
  return json(res);
});

let postedDay = -1;

export const postRoot = safe(async (req) => {
  const env = readEnv();
  if (!env.cronSecret) return fail(503, 'CRON_SECRET not set');
  const digest = (v: string) => createHash('sha256').update(v).digest();
  if (!timingSafeEqual(digest(req.headers.get('authorization') ?? ''), digest(`Bearer ${env.cronSecret}`))) {
    return fail(401, 'unauthorized');
  }
  if (env.mode !== 'chain') return fail(503, `not configured: ${env.reason ?? 'offchain mode'}`);
  const chain = chainFor(env);
  const day = utcDay();
  const { rootId, info } = await chain.latestRoot();
  if ((rootId > 0 && tapeDayOf(info.expiresAt) === day) || postedDay === day) {
    return json({ posted: false, day, rootId, reason: 'already posted for today' });
  }
  const n = env.tapesPerDay;
  const tree = await treeFor(env.secret!, day, n);
  const txHash = await chain.invoke('post_tape_root', [tree.root, BigInt(n), BigInt(expiresAtFor(day))]);
  postedDay = day;
  latestCache = null;
  statusCache = null;
  return json({ posted: true, day, n, root: hex(tree.root), expiresAt: expiresAtFor(day), txHash });
});

export const routes: Record<string, Partial<Record<'GET' | 'POST', Handler>>> = {
  '/api/broadcast/status': { GET: status },
  '/api/broadcast/start': { POST: start },
  '/api/broadcast/seg': { GET: seg },
  '/api/broadcast/submit': { POST: submit },
  // Vercel cron jobs call GET (with "Authorization: Bearer $CRON_SECRET").
  '/api/cron/post-root': { GET: postRoot, POST: postRoot },
};

/** Dev router: dispatch a request to its handler. */
export async function route(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  const r = routes[path];
  if (!r) return fail(404, 'not found');
  const h = r[req.method as 'GET' | 'POST'];
  return h ? h(req) : fail(405, 'method not allowed');
}
