// The catch ceremony as data: how long each beat lasts and where the card is at time t.
// Pure, so the timing can be tested and the canvas code in fx.ts only has to draw a pose.
// Presentation only: the sim has already resolved the catch, and input is never blocked.

export type CatchKind = 'common' | 'rare' | 'shiny' | 'king';

/** Tier frame colours in the arcade palette (T1 is the rarest). The haul cards use the same (catch.css). */
export const TIER_COLOR = ['', '#ff8a1f', '#23d5ff', '#8dff3a', '#f4ecd8', '#9a8f7a'] as const;
export const SHINY_COLOR = '#ffc61a';
export const KING_COLOR = '#ff3b2f';

export function tierColor(tier: number): string {
  return TIER_COLOR[Math.max(1, Math.min(5, Math.round(tier)))];
}

export function catchKind(s: { boss: boolean; shiny: boolean; featured: boolean }): CatchKind {
  if (s.boss) return 'king';
  if (s.shiny) return 'shiny';
  if (s.featured) return 'rare';
  return 'common';
}

export interface CatchPlan {
  kind: CatchKind;
  /** Wobble beats before the flip (0 for a plain catch). */
  wobbles: number;
  implodeMs: number;
  beatMs: number;
  flipMs: number;
  holdMs: number;
  flyMs: number;
  /** Start of each phase, ms from the catch. */
  wobbleAt: number;
  flipAt: number;
  holdAt: number;
  flyAt: number;
  total: number;
}

export function planCatch(kind: CatchKind): CatchPlan {
  const wobbles = kind === 'common' ? 0 : 3;
  const implodeMs = 190;
  const beatMs = 270;
  const flipMs = kind === 'common' ? 190 : 230;
  const holdMs = kind === 'common' ? 230 : kind === 'king' ? 620 : 420;
  const flyMs = 340;
  const wobbleAt = implodeMs;
  const flipAt = wobbleAt + wobbles * beatMs;
  const holdAt = flipAt + flipMs;
  const flyAt = holdAt + holdMs;
  return { kind, wobbles, implodeMs, beatMs, flipMs, holdMs, flyMs, wobbleAt, flipAt, holdAt, flyAt, total: flyAt + flyMs };
}

export type Phase = 'implode' | 'wobble' | 'flip' | 'hold' | 'fly' | 'done';

export interface CardPose {
  phase: Phase;
  /** 0..1 inside the phase. */
  k: number;
  face: 'back' | 'front';
  /** Horizontal squash for the flip, 0..1. */
  scaleX: number;
  /** Radians of tilt during a wobble beat. */
  angle: number;
  /** Index of the wobble beat in progress (-1 outside the wobble). */
  beat: number;
  /** 0..1 progress of the flight to the tray (0 before it starts). */
  fly: number;
  /** Card scale-in during the implode (0..1), then 1. */
  pop: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function poseAt(plan: CatchPlan, t: number): CardPose {
  const base: CardPose = { phase: 'implode', k: 0, face: 'back', scaleX: 1, angle: 0, beat: -1, fly: 0, pop: 1 };
  if (t < plan.implodeMs) {
    const k = clamp01(t / plan.implodeMs);
    return { ...base, k, pop: k };
  }
  if (t < plan.flipAt) {
    const local = t - plan.wobbleAt;
    const beat = Math.min(plan.wobbles - 1, Math.floor(local / plan.beatMs));
    const inBeat = (local - beat * plan.beatMs) / plan.beatMs;
    // A tilt that swings out and back inside the first 70% of the beat, then rests: tick... tick... tick...
    const swing = inBeat < 0.7 ? Math.sin((inBeat / 0.7) * Math.PI * 2) * (1 - inBeat / 0.7) : 0;
    return { ...base, phase: 'wobble', k: clamp01(local / (plan.wobbles * plan.beatMs)), beat, angle: swing * 0.32 };
  }
  if (t < plan.holdAt) {
    const k = clamp01((t - plan.flipAt) / plan.flipMs);
    return { ...base, phase: 'flip', k, face: k < 0.5 ? 'back' : 'front', scaleX: Math.abs(Math.cos(Math.PI * k)) };
  }
  if (t < plan.flyAt) return { ...base, phase: 'hold', k: clamp01((t - plan.holdAt) / plan.holdMs), face: 'front' };
  if (t < plan.total) {
    const k = clamp01((t - plan.flyAt) / plan.flyMs);
    return { ...base, phase: 'fly', k, face: 'front', fly: k * k };
  }
  return { ...base, phase: 'done', k: 1, face: 'front', fly: 1 };
}

/** Ms after the catch at which wobble beat `i` lands (for scheduling its tick). */
export function beatTime(plan: CatchPlan, i: number): number {
  return plan.wobbleAt + i * plan.beatMs;
}

// ------------------------------------------------------------------ encounter text

/** "A wild KURAMA appeared!": the species name for the lower third. */
export function encounterLine(name: string): string {
  return `A wild ${name.toUpperCase()} appeared!`;
}

export interface Alert {
  text: string;
  sub: string;
  cls: 'rare' | 'shiny' | 'king';
}

/** The HUD alert for a rare, shiny or King Beast (`typeWord` is Magic, Hunter or Brute), or null for a plain one. */
export function alertFor(kind: CatchKind, typeWord: string, hits: number): Alert | null {
  const taps = `${hits} tap${hits === 1 ? '' : 's'}`;
  if (kind === 'king') return { text: 'THE KING', sub: `${typeWord} . ${taps} . pays triple`, cls: 'king' };
  if (kind === 'shiny') return { text: 'SHINY!', sub: `${typeWord} . ${taps} . pays triple`, cls: 'shiny' };
  if (kind === 'rare') return { text: 'RARE BEAST', sub: `${typeWord} . ${taps} . leaves sooner`, cls: 'rare' };
  return null;
}

/** Text over the card once it shows its face. */
export function catchLabel(isNew: boolean, shiny: boolean, king: boolean, dex: string): string {
  if (shiny) return isNew ? `SHINY! NEW ${dex}` : 'SHINY!';
  if (king) return isNew ? `KING CAUGHT! NEW ${dex}` : 'KING CAUGHT!';
  return isNew ? `NEW ENTRY ${dex}` : 'CAUGHT!';
}
