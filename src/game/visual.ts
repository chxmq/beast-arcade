// How a Beast looks in the static at a given tick. Pure and DOM-free: Open Hunt and the
// server-side Broadcast tape renderer both use it, so ranked tapes look exactly like play.
//
// v2 ("easy and fast"): a Beast surfaces already readable at 80% size, reaches full size and
// clarity within the first 30% of its life, then keeps sharpening a little until it gets away.
// Clarity is motion persistence (the share of the static that moves with the body), never
// brightness, contrast or an outline, so every single frame stays uniform noise at any setting.
import type { RenderBeast } from '../render/field.ts';
import type { Spawn } from '../sim/schedule.ts';
import { positionAt } from '../sim/motion.ts';
import { PREFIX_VORTEX, type BeastType } from '../sim/spec.ts';

/** Visual size steps while a Beast surfaces. The hitbox is always the full w x h box. */
export const APPROACH_LEVELS = [0.8, 0.87, 0.94, 1] as const;
/** Share of its life a Beast takes to reach full size and base clarity. */
export const SURFACE_FRACTION = 0.3;
/** Motion persistence by tier (index 1..5). T1 is the faintest and pays the most. */
export const CLARITY_BY_TIER = [0, 0.86, 0.885, 0.905, 0.93, 0.95] as const;
/** Dusk, Gloom and Shadow Beasts carry less of their motion. */
export const FAINT_DROP = 0.06;
/** FEVER (combo 10+) clears the static a little for every Beast on screen. */
export const FEVER_CLARITY = 0.04;
/** How much fainter a Beast is at the moment it surfaces. */
const SURFACE_DIP = 0.04;
/** Extra clarity gained over the rest of its life, so a Beast about to escape is easiest to see. */
const LATE_GAIN = 0.02;
const MIN_CLARITY = 0.6;
const MAX_CLARITY = 0.985;

export interface ScaledMask { mask: Uint8Array; w: number; h: number; ox: number; oy: number }

const scaledCache = new WeakMap<Uint8Array, ScaledMask[]>();

/** Nearest-neighbour downscale of a silhouette, centred in its full box. Cached per mask object. */
export function scaledMask(full: Uint8Array, w: number, h: number, level: number): ScaledMask {
  let levels = scaledCache.get(full);
  if (!levels) {
    levels = APPROACH_LEVELS.map((s) => {
      if (s === 1) return { mask: full, w, h, ox: 0, oy: 0 };
      const ws = Math.max(4, Math.round(w * s));
      const hs = Math.max(4, Math.round(h * s));
      const m = new Uint8Array(ws * hs);
      for (let y = 0; y < hs; y++) {
        const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / hs));
        for (let x = 0; x < ws; x++) {
          const sx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / ws));
          m[y * ws + x] = full[sy * w + sx];
        }
      }
      return { mask: m, w: ws, h: hs, ox: (w - ws) >> 1, oy: (h - hs) >> 1 };
    });
    scaledCache.set(full, levels);
  }
  return levels[Math.max(0, Math.min(levels.length - 1, level))];
}

/** 0 when the Beast surfaces, ~1 just before it gets away. */
export function lifeFraction(s: Spawn, tick: number): number {
  return Math.max(0, Math.min(1, (tick - s.spawnTick) / (s.escapeTick - s.spawnTick)));
}

/** Index into APPROACH_LEVELS: steps up quickly, full size from SURFACE_FRACTION of life on. */
export function approachLevel(f: number): number {
  const last = APPROACH_LEVELS.length - 1;
  return Math.max(0, Math.min(last, Math.floor((f / SURFACE_FRACTION) * last)));
}

/** Base clarity of a tier, as shown in the Bestiary (no approach, no fever). */
export function tierClarity(tier: number, faint = false): number {
  const t = Math.max(1, Math.min(5, Math.round(tier)));
  return CLARITY_BY_TIER[t] - (faint ? FAINT_DROP : 0);
}

/** Motion persistence at life fraction `f`. `bonus` is added on top (FEVER). */
export function clarity(tier: number, faint: boolean, f: number, bonus = 0): number {
  const surfaced = Math.min(1, Math.max(0, f) / SURFACE_FRACTION);
  const p = tierClarity(tier, faint) - SURFACE_DIP * (1 - surfaced) + LATE_GAIN * Math.min(1, Math.max(0, f)) + bonus;
  return Math.max(MIN_CLARITY, Math.min(MAX_CLARITY, p));
}

/** The Beast as the noise field carries it at `tick`. Broadcast tapes call this with bonus 0. */
export function beastVisual(s: Spawn, tick: number, fullMask: Uint8Array, bonus = 0): RenderBeast {
  const e = s.entry;
  const f = lifeFraction(s, tick);
  const sm = scaledMask(fullMask, e.w, e.h, approachLevel(f));
  const { px, py } = positionAt(s, tick);
  return {
    id: s.i,
    px: px + sm.ox,
    py: py + sm.oy,
    w: sm.w,
    h: sm.h,
    mask: sm.mask,
    type: e.type as BeastType,
    persist: clarity(e.tier, s.faint, f, bonus),
    t: tick - s.spawnTick,
    vortex: s.prefix === PREFIX_VORTEX,
  };
}
