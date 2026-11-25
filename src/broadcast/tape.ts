// Broadcast tapes: the deterministic pixel stream of one run. DOM-free; the server renders it to
// stream frames, the browser renders it again for the Decode replay once the seed is revealed.
//
// Frame f shows tick 2f (30 fps): field.step(beasts at tick 2f, 2). Every spawn is on the tape from
// spawnTick until escapeTick, killed or not (a tape cannot react to the player), and looks exactly
// like Open Hunt (`beastVisual`, boost 0). The noise field seed comes from the run seed, so the
// whole tape is a pure function of (seed, root roster, n_featured).

import { poseidonHashMany } from '@scure/starknet';
import { decodeMask } from '../data/roster.ts';
import { beastVisual } from '../game/visual.ts';
import { NoiseField, type RenderBeast } from '../render/field.ts';
import { buildSchedule, type SimRosterEntry, type Spawn } from '../sim/schedule.ts';
import { FIELD_H, FIELD_W } from '../sim/spec.ts';
import { FIELD_TAG } from './hashes.ts';

export const TAPE_FPS = 30;
export const SEG_FRAMES = 150;
export const SEG_MS = (SEG_FRAMES * 1000) / TAPE_FPS;
export const TAPE_W = FIELD_W;
export const TAPE_H = FIELD_H;
export const FRAME_BYTES = (TAPE_W * TAPE_H) / 8;
/** Ticks of plain static after the last escape. */
export const TAIL_TICKS = 30;

/** One slot of a root's roster, in roster index order (contract `get_root_roster`). */
export interface TapeSlot {
  speciesId: number;
  entry: SimRosterEntry;
}

export interface TapeSpec {
  seed: bigint;
  slots: readonly TapeSlot[];
  nFeatured: number;
}

/** Silhouette art for a species: a `public/data/roster.json` entry. */
export type MaskLookup = (speciesId: number) => { w: number; h: number; mask: string } | undefined;

/**
 * Full silhouette masks per species, one Uint8Array object per (species, w, h) for the life of
 * the process (the field and `beastVisual` cache geometry by object identity). If roster.json
 * does not know the species, or its size differs from the onchain entry, the mask is the
 * onchain 8x8 occupancy grid itself, so the tape always matches the hitbox the contract uses.
 */
export class MaskBook {
  private readonly cache = new Map<string, Uint8Array>();
  constructor(private readonly lookup: MaskLookup) {}

  get(slot: TapeSlot): Uint8Array {
    const { w, h, occ } = slot.entry;
    const key = `${slot.speciesId}:${w}x${h}:${occ}`;
    let m = this.cache.get(key);
    if (!m) {
      const art = this.lookup(slot.speciesId);
      m = art && art.w === w && art.h === h ? decodeMask(art) : occMask(w, h, occ);
      this.cache.set(key, m);
    }
    return m;
  }
}

/** w*h mask where a pixel is set iff its SPEC section 3 occupancy cell is set. */
export function occMask(w: number, h: number, occ: bigint): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const cy = Math.floor((y * 8) / h);
    for (let x = 0; x < w; x++) {
      const cx = Math.floor((x * 8) / w);
      m[y * w + x] = Number((occ >> BigInt(cy * 8 + cx)) & 1n);
    }
  }
  return m;
}

/** Noise-field seed of a tape: low 32 bits of poseidon([seed, 'FIELD']). */
export function fieldSeedOf(seed: bigint): number {
  return Number(poseidonHashMany([seed, FIELD_TAG]) & 0xffffffffn);
}

export function tapeFrames(spawns: readonly Spawn[]): number {
  return Math.ceil((Math.max(...spawns.map((s) => s.escapeTick)) + TAIL_TICKS) / 2);
}

export function segmentCount(frames: number): number {
  return Math.ceil(frames / SEG_FRAMES);
}

/** A tape being played from frame 0. Stepping is the only way forward (no random access). */
export class Tape {
  readonly spawns: Spawn[];
  readonly frames: number;
  readonly field: NoiseField;
  /** Frame currently held in `field.cur` (-1 before the first step). */
  frame = -1;
  private readonly masks: Uint8Array[];

  constructor(spec: TapeSpec, book: MaskBook) {
    this.spawns = buildSchedule(spec.seed, spec.slots.map((s) => s.entry), spec.nFeatured);
    this.frames = tapeFrames(this.spawns);
    this.masks = this.spawns.map((s) => book.get(spec.slots[s.rosterIdx]));
    this.field = new NoiseField(fieldSeedOf(spec.seed), TAPE_W, TAPE_H);
  }

  /** Every Beast on the tape at `tick`, in spawn order. */
  beastsAt(tick: number): RenderBeast[] {
    const out: RenderBeast[] = [];
    for (const s of this.spawns) {
      if (s.spawnTick <= tick && tick < s.escapeTick) out.push(beastVisual(s, tick, this.masks[s.i]));
    }
    return out;
  }

  /** Render the next frame; returns the field (0/1 per pixel, row-major). */
  step(): Uint8Array {
    const f = ++this.frame;
    this.field.step(this.beastsAt(2 * f), 2);
    return this.field.cur;
  }

  /** Step until frame `f` is in the field (f >= current frame). */
  seek(f: number): void {
    if (f < this.frame) throw new Error('tape cannot rewind');
    while (this.frame < f) this.step();
  }
}

/** Pack a 0/1 field into 1 bit per pixel, MSB first, row-major. */
export function packFrame(cur: Uint8Array, out: Uint8Array, off: number): void {
  for (let j = 0, p = 0; j < FRAME_BYTES; j++, p += 8) {
    out[off + j] =
      (cur[p] << 7) | (cur[p + 1] << 6) | (cur[p + 2] << 5) | (cur[p + 3] << 4) |
      (cur[p + 4] << 3) | (cur[p + 5] << 2) | (cur[p + 6] << 1) | cur[p + 7];
  }
}

export function unpackFrame(buf: Uint8Array, off: number, out: Uint8Array): void {
  for (let j = 0, p = 0; j < FRAME_BYTES; j++, p += 8) {
    const b = buf[off + j];
    out[p] = (b >> 7) & 1;
    out[p + 1] = (b >> 6) & 1;
    out[p + 2] = (b >> 5) & 1;
    out[p + 3] = (b >> 4) & 1;
    out[p + 4] = (b >> 3) & 1;
    out[p + 5] = (b >> 2) & 1;
    out[p + 6] = (b >> 1) & 1;
    out[p + 7] = b & 1;
  }
}

/** Segment i (frames [150 i, 150 i + 150) clipped to the tape), packed. Advances `tape`. */
export function renderSegment(tape: Tape, i: number): Uint8Array<ArrayBuffer> {
  const first = i * SEG_FRAMES;
  const last = Math.min(tape.frames, first + SEG_FRAMES);
  if (!(i >= 0 && first < tape.frames)) throw new Error('bad segment');
  if (tape.frame >= first) throw new Error('tape is past this segment');
  const out = new Uint8Array((last - first) * FRAME_BYTES);
  tape.seek(first - 1);
  for (let f = first; f < last; f++) packFrame(tape.step(), out, (f - first) * FRAME_BYTES);
  return out;
}
