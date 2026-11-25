import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toSimRoster, type Roster } from '../data/roster.ts';
import { decodeStrike } from '../sim/encode.ts';
import { occHit, positionAt } from '../sim/motion.ts';
import { replay, Run } from '../sim/replay.ts';
import type { Spawn } from '../sim/schedule.ts';
import { GAP_MISS, JAM_MISSES, MAX_TICK, NO_INDEX, PLAYER_LIVES } from '../sim/spec.ts';
import { decodeShortString, encodeShortString, leafHash, messageHash, nodeHash, tapeIndex } from './hashes.ts';
import { buildTree, processProof, proofFor } from './merkle.ts';
import { maskFromHex, resultToJson } from './api.ts';
import { buildReport } from './report.ts';
import { FRAME_BYTES, MaskBook, occMask, packFrame, renderSegment, SEG_FRAMES, segmentCount, Tape, tapeFrames, unpackFrame, type TapeSlot } from './tape.ts';
import { RANKED_GAP, Trigger } from './trigger.ts';
import { poseidonHashMany } from '@scure/starknet';

// Vectors also asserted in Cairo by contracts/tests/test_broadcast_ts.cairo (verify_poseidon, message_of).
const SECRET = 0x5354415449432d54455354n;
const seed = (k: number) => poseidonHashMany([SECRET, 20409n, BigInt(k)]);

// The real roster, in sim order (featured first), as the offchain server uses it.
const roster = JSON.parse(readFileSync('public/data/roster.json', 'utf8')) as Roster;
const ordered = [...roster.entries.filter((e) => e.featured), ...roster.entries.filter((e) => !e.featured)];
const sim = toSimRoster(roster);
const nF = roster.nFeatured;

/** A pixel of `s` that its hitbox covers at `tick` (occupancy cell centres, nearest the middle first). */
function coveredPixel(s: Spawn, tick: number): { x: number; y: number } | null {
  const { px, py } = positionAt(s, tick);
  const { w, h, occ } = s.entry;
  const cells: [number, number][] = [];
  for (let cy = 0; cy < 8; cy++) for (let cx = 0; cx < 8; cx++) if ((occ >> BigInt(cy * 8 + cx)) & 1n) cells.push([cx, cy]);
  cells.sort((a, b) => Math.hypot(a[0] - 3.5, a[1] - 3.5) - Math.hypot(b[0] - 3.5, b[1] - 3.5));
  for (const [cx, cy] of cells) {
    const lx = Math.floor(((2 * cx + 1) * w) / 16);
    const ly = Math.floor(((2 * cy + 1) * h) / 16);
    if (occHit(occ, w, h, lx, ly)) return { x: px + lx, y: py + ly };
  }
  return null;
}

/** A player who sees every Beast, paced by the ranked Trigger: strikes the oldest live one on even ticks (tape frames). */
function sharpLog(seed: bigint): number[] {
  const run = new Run(seed, sim, nF);
  const trig = new Trigger();
  for (let tick = 0; tick <= run.endTick; tick += 2) {
    run.advanceTo(tick);
    if (run.dead) break;
    if (!trig.ready(tick)) continue;
    const i = run.spawns.findIndex((_, j) => run.isTargetable(j, tick));
    const p = i >= 0 ? coveredPixel(run.spawns[i], tick) : null;
    if (p && trig.fire(tick, p.x, p.y)) run.strike(decodeStrike(trig.strikes[trig.strikes.length - 1]));
  }
  return trig.strikes;
}

describe('merkle (OZ verify_poseidon compatible)', () => {
  it('matches the roots the Cairo test verifies', () => {
    const leaves = Array.from({ length: 5 }, (_, k) => leafHash(k, seed(k)));
    expect(buildTree(leaves.slice(0, 4)).root).toBe(0x106fd2c2450b16ae2147286f44cbe3682e27989a013c11e34c529ba9893f78fn);
    expect(buildTree(leaves).root).toBe(0x6e46575043cd137b6fb600c14b5a7e7c14c872d9fc3ca5f243a1d36dabdf7n);
  });

  it('every proof folds to the root, for every size up to 33', () => {
    for (let n = 1; n <= 33; n++) {
      const leaves = Array.from({ length: n }, (_, k) => leafHash(k, BigInt(1000 + k)));
      const tree = buildTree(leaves);
      for (let k = 0; k < n; k++) expect(processProof(proofFor(tree, k), leaves[k])).toBe(tree.root);
      if (n > 1) expect(processProof(proofFor(tree, 0), leaves[n - 1])).not.toBe(tree.root);
    }
  });

  it('carries an odd node up unchanged and uses sorted pairs', () => {
    const l = [11n, 7n, 5n];
    const tree = buildTree(l);
    expect(tree.root).toBe(nodeHash(nodeHash(11n, 7n), 5n));
    expect(nodeHash(11n, 7n)).toBe(poseidonHashMany([7n, 11n]));
    expect(proofFor(tree, 2)).toEqual([nodeHash(11n, 7n)]);
  });
});

describe('hashes', () => {
  it('message hash and tape index match the Cairo vectors', () => {
    const pub = 0x1ef15c18599971b7beced415a40f0c7deacfd9b0d1819e03d723d8bc943cfcan;
    expect(tapeIndex(pub, 0x2an, 4096)).toBe(1162);
    const strikes = [0, 4 * 262144 + 10 * 1024 + 20 * 4 + 1, 4000 * 262144 - 1];
    expect(messageHash(7, 1234, 0x2an, encodeShortString('ACE42'), strikes)).toBe(0x9c0e201f66e4f9685455ad6df3f254756356dcd1570ead6548ca384507c4dn);
  });

  it('short strings round trip', () => {
    expect(encodeShortString('STATIC')).toBe(0x535441544943n);
    expect(decodeShortString(encodeShortString('ACE42'))).toBe('ACE42');
    expect(() => encodeShortString('x'.repeat(32))).toThrow();
  });
});

describe('tapes', () => {
  const slots: TapeSlot[] = ordered.map((e, i) => ({ speciesId: e.speciesId, entry: sim[i] }));
  const byId = new Map(roster.entries.map((e) => [e.speciesId, e]));
  const spec = (s: bigint) => ({ seed: s, slots, nFeatured: roster.nFeatured });
  const fullRender = (s: bigint) => {
    const tape = new Tape(spec(s), new MaskBook((id) => byId.get(id)));
    const parts = Array.from({ length: segmentCount(tape.frames) }, (_, i) => renderSegment(tape, i));
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
    return { out, frames: tape.frames };
  };

  it('same seed, identical bytes; another seed differs', () => {
    const a = fullRender(777n);
    const b = fullRender(777n);
    expect(a.out.length).toBe(a.frames * FRAME_BYTES);
    expect(Buffer.from(a.out).equals(Buffer.from(b.out))).toBe(true);
    const c = fullRender(778n);
    expect(Buffer.from(a.out.subarray(0, FRAME_BYTES)).equals(Buffer.from(c.out.subarray(0, FRAME_BYTES)))).toBe(false);
  });

  it('segment i rendered from scratch equals the slice of a full render', () => {
    const { out, frames } = fullRender(4242n);
    for (const i of [0, 3, segmentCount(frames) - 1]) {
      const fresh = new Tape(spec(4242n), new MaskBook((id) => byId.get(id)));
      const seg = renderSegment(fresh, i);
      const slice = out.subarray(i * SEG_FRAMES * FRAME_BYTES, i * SEG_FRAMES * FRAME_BYTES + seg.length);
      expect(Buffer.from(seg).equals(Buffer.from(slice))).toBe(true);
    }
  });

  it('frames cover every escape plus a tail, and the tape cannot rewind', () => {
    const tape = new Tape(spec(1n), new MaskBook((id) => byId.get(id)));
    const maxEsc = Math.max(...tape.spawns.map((s) => s.escapeTick));
    expect(tape.frames).toBe(Math.ceil((maxEsc + 30) / 2));
    renderSegment(tape, 1);
    expect(() => renderSegment(tape, 0)).toThrow();
  });

  it('packs 1 bit per pixel MSB first', () => {
    const cur = new Uint8Array(256 * 144);
    cur[0] = 1;
    cur[9] = 1;
    const buf = new Uint8Array(FRAME_BYTES);
    packFrame(cur, buf, 0);
    expect(buf[0]).toBe(0x80);
    expect(buf[1]).toBe(0x40);
    const back = new Uint8Array(256 * 144);
    unpackFrame(buf, 0, back);
    expect(back).toEqual(cur);
  });

  it('falls back to the onchain occupancy grid when the art size differs', () => {
    const slot: TapeSlot = { speciesId: ordered[0].speciesId, entry: { ...sim[0], w: 16, h: 8 } };
    const m = new MaskBook((id) => byId.get(id)).get(slot);
    expect(m).toEqual(occMask(16, 8, sim[0].occ));
    const book = new MaskBook((id) => byId.get(id));
    expect(book.get(slots[0])).toBe(book.get(slots[0]));
  });
});

describe('v2 tape length', () => {
  it('covers the King to the end and every frame is a strikeable tick', () => {
    for (const s of [1n, 2n, 3n, 99n, 4242n]) {
      const spawns = new Run(s, sim, nF).spawns;
      const frames = tapeFrames(spawns);
      const king = spawns[spawns.length - 1];
      expect(king.boss).toBe(true);
      expect(2 * (frames - 1)).toBeGreaterThanOrEqual(king.escapeTick);
      expect(2 * (frames - 1)).toBeLessThan(MAX_TICK);
      expect(frames).toBeGreaterThan(1200);
    }
  });
});

describe('ranked trigger', () => {
  it('always waits the after-miss gap, sends type 0, ignores the letterbox', () => {
    expect(RANKED_GAP).toBe(GAP_MISS);
    const t = new Trigger();
    expect(t.ready(0)).toBe(true);
    expect(t.fire(10, 5, 5)).toBe(true);
    expect(t.cooldown(10)).toBe(GAP_MISS);
    expect(t.charge(10 + GAP_MISS / 2)).toBe(0.5);
    expect(t.fire(10 + GAP_MISS - 1, 5, 5)).toBe(false);
    expect(t.fire(10 + GAP_MISS, 256, 5)).toBe(false);
    expect(t.fire(10 + GAP_MISS, 5, -1)).toBe(false);
    expect(t.fire(10 + GAP_MISS, 4.5, 5)).toBe(false);
    expect(t.fire(10 + GAP_MISS, 255, 143)).toBe(true);
    expect(t.strikes.map(decodeStrike)).toEqual([{ tick: 10, x: 5, y: 5, type: 0 }, { tick: 10 + GAP_MISS, x: 255, y: 143, type: 0 }]);
    expect(t.lastTick).toBe(10 + GAP_MISS);
    expect(t.fire(MAX_TICK, 1, 1)).toBe(false);
    expect(t.left).toBe(398);
  });

  it('every log it lets through replays without error, whatever the strikes hit', () => {
    for (const s of [1n, 2n, 3n, 77n, 4242n]) {
      let a = Number(s) * 7919;
      const rand = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
      const t = new Trigger();
      // Blind clicks, many inside the cooldown or off the field: those are dropped.
      for (let tick = 0; tick < 3000; tick += 2) if (rand() < 0.4) t.fire(tick, Math.floor(rand() * 280) - 12, Math.floor(rand() * 170) - 13);
      expect(t.strikes.length).toBeGreaterThan(60);
      const ticks = t.strikes.map((v) => decodeStrike(v).tick);
      for (let i = 1; i < ticks.length; i++) expect(ticks[i] - ticks[i - 1]).toBeGreaterThanOrEqual(GAP_MISS);
      const r = replay(s, sim, nF, t.strikes);
      expect(r.dead).toBe(true);
    }
    // A sharp player paced the same way: valid too, and it clears the tape.
    const r = replay(4242n, sim, nF, sharpLog(4242n));
    expect(r.kills).toBeGreaterThan(35);
  });
});

describe('decode report', () => {
  it('sharp play: no misses, the numbers add up to the contract result', () => {
    for (const s of [7n, 4242n]) {
      const strikes = sharpLog(s);
      const rep = buildReport(s, sim, nF, strikes);
      expect(rep.result).toEqual(replay(s, sim, nF, strikes));
      expect(rep.marks).toHaveLength(strikes.length);
      expect(rep.counts).toMatchObject({ misses: 0, void: 0, kills: rep.result.kills });
      expect(rep.counts.hits).toBeGreaterThan(rep.result.kills);
      expect(rep.jams).toHaveLength(0);
      expect(rep.livesLost).toHaveLength(PLAYER_LIVES - rep.result.lives);
      expect(rep.livesLost.every((l) => l.cause === 'escape')).toBe(true);
      expect(rep.marks.reduce((a, m) => a + m.pts, 0)).toBe(rep.result.score);
      expect(Math.max(...rep.marks.map((m) => m.combo))).toBe(rep.result.bestCombo);
      expect(rep.bestChain.len).toBeGreaterThan(1);
      expect(rep.verdict).toBe(rep.result.kills === 40 ? 'sweep' : 'survived');
      const last = rep.marks[rep.marks.length - 1];
      expect(rep.comboAt(last.tick)).toBe(last.combo);
      expect(rep.livesAt(rep.run.endTick)).toBe(rep.result.lives);
      // Catches: the masks' bits are the roster indices of the kills, and the JSON mask round trips.
      const killed = new Set(rep.kills.map((k) => rep.run.spawns[k.idx].rosterIdx));
      expect(rep.caught.map((c) => c.rosterIdx)).toEqual([...killed].sort((a, b) => a - b));
      expect(rep.caught.reduce((a, c) => a + c.count, 0)).toBe(rep.result.kills);
      expect(rep.caught.filter((c) => c.shiny).map((c) => c.rosterIdx).every((i) => (rep.result.shinyMask >> BigInt(i)) & 1n)).toBe(true);
      const j = resultToJson(rep.result);
      expect(maskFromHex(j.caughtMask)).toBe(rep.result.caughtMask);
      expect(maskFromHex(j.shinyMask)).toBe(rep.result.shinyMask);
    }
  });

  it('no strikes: every life goes to a Beast that got away', () => {
    const rep = buildReport(7n, sim, nF, []);
    expect(rep.verdict).toBe('lost');
    expect(rep.livesLost).toHaveLength(PLAYER_LIVES);
    expect(rep.livesLost.every((l) => l.cause === 'escape')).toBe(true);
    expect(rep.livesLost[PLAYER_LIVES - 1]).toMatchObject({ idx: rep.result.killer, tick: rep.result.deathTick });
    expect(rep.livesAt(rep.livesLost[0].tick - 1)).toBe(PLAYER_LIVES);
    expect(rep.livesAt(rep.result.deathTick)).toBe(0);
    expect(rep.comboAt(10_000)).toBe(0);
  });

  it('three misses in a row jam the signal; only misses end in a jam', () => {
    let jammed = 0;
    for (let s = 1n; s <= 12n; s++) {
      // Strike static only: a pixel no Beast covers, every GAP_MISS ticks, until the signal dies.
      const run = new Run(s, sim, nF);
      const t = new Trigger();
      for (let tick = 0; !run.dead && tick < MAX_TICK; tick += GAP_MISS) {
        run.advanceTo(tick);
        if (run.dead) break;
        let x = 0;
        let y = 0;
        while (run.targetAt(tick, x, y) >= 0 || run.spawns.some((sp, i) => run.isVisibleWindow(i, tick) && coversBox(sp, tick, x, y))) {
          x = (x + 37) % 256;
          y = (y + 23) % 144;
        }
        t.fire(tick, x, y);
        run.strike(decodeStrike(t.strikes[t.strikes.length - 1]));
      }
      const rep = buildReport(s, sim, nF, t.strikes);
      expect(rep.counts.misses).toBe(t.strikes.length);
      expect(rep.jams.map((j) => j.tick)).toEqual(t.strikes.map((v) => decodeStrike(v).tick).filter((_, i) => i % JAM_MISSES === JAM_MISSES - 1));
      expect(rep.marks.map((m) => m.misses)).toEqual(t.strikes.map((_, i) => (i % JAM_MISSES) + 1));
      const firstJam = rep.jams[0].tick;
      expect(rep.livesLost.find((l) => l.cause === 'jam')!.tick).toBe(firstJam);
      expect(rep.livesAt(firstJam)).toBe(rep.livesAt(firstJam - 1) - 1);
      if (rep.verdict === 'jammed') {
        jammed++;
        expect(rep.result.killer).toBe(NO_INDEX);
        expect(rep.result.killerRoster).toBe(NO_INDEX);
        expect(rep.livesLost[PLAYER_LIVES - 1]).toMatchObject({ cause: 'jam', tick: rep.result.deathTick });
      } else expect(rep.verdict).toBe('lost');
    }
    expect(jammed).toBeGreaterThan(0);
  });

  it('striking a Beast you already killed is an overkill: neutral', () => {
    const s = 4242n;
    const full = sharpLog(s);
    const rep = buildReport(s, sim, nF, full);
    // The first one-hit kill, then the same Beast again one gap later (where no live Beast is).
    for (const k of rep.marks.filter((m) => m.kind === 'kill')) {
      const sp = rep.run.spawns[k.target];
      const T = k.tick + RANKED_GAP;
      if (T >= sp.escapeTick) continue;
      const upTo = full.slice(0, rep.marks.indexOf(k) + 1);
      const run = new Run(s, sim, nF);
      for (const v of upTo) run.strike(decodeStrike(v));
      run.advanceTo(T);
      const p = coveredPixel(sp, T);
      if (!p || run.dead || run.targetAt(T, p.x, p.y) >= 0) continue;
      const t = new Trigger();
      for (const v of upTo) { const d = decodeStrike(v); t.fire(d.tick, d.x, d.y); }
      expect(t.fire(T, p.x, p.y)).toBe(true);
      const again = buildReport(s, sim, nF, t.strikes);
      const m = again.marks[again.marks.length - 1];
      expect(m).toMatchObject({ kind: 'overkill', target: k.target, combo: k.combo, misses: 0 });
      expect(again.counts.overkills).toBe(1);
      expect(again.comboAt(T)).toBe(k.combo);
      return;
    }
    throw new Error('no overkill case found');
  });
});

/** Is (x, y) anywhere inside the w x h box of `s` at `tick` (stricter than the hitbox)? */
function coversBox(s: Spawn, tick: number, x: number, y: number): boolean {
  const { px, py } = positionAt(s, tick);
  return x >= px && y >= py && x < px + s.entry.w && y < py + s.entry.h;
}
