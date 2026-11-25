// Shared shapes for MICRO MAYHEM. Game logic only sees these (no DOM), so it runs under vitest.
import type { RosterEntry } from '../data/roster.ts';
import type { SfxName } from '../game/audio.ts';
import type { Cast } from './cast.ts';
import type { Gfx } from './gfx.ts';
import type { Rng } from './rng.ts';

export type GameId = 'catch' | 'counter' | 'duel' | 'shiny' | 'eyes' | 'dodge' | 'mash' | 'feed' | 'boss';
export type Status = 'playing' | 'won' | 'lost';
export type Btn = 'A' | 'B' | 'C' | 'START' | 'LEFT' | 'RIGHT' | 'UP' | 'DOWN';
/** Which control hint the interstitial shows. */
export type Hint = 'tap' | 'abc' | 'move' | 'mash' | 'boss';

export interface Pt {
  x: number;
  y: number;
}

/** Everything a microgame may read from the player in one frame. Coordinates are logical (320x180). */
export interface FrameInput {
  taps: Pt[];
  presses: Btn[];
  /** Latest pointer position (mouse hover or touch drag); null before the pointer was used. */
  pointer: Pt | null;
  /** True when the pointer moved more recently than LEFT/RIGHT were pressed. */
  pointerLead: boolean;
  left: boolean;
  right: boolean;
}

export function noInput(): FrameInput {
  return { taps: [], presses: [], pointer: null, pointerLead: false, left: false, right: false };
}

/** Sound hooks the games use. The screen maps them to `sound`; tests and the demo stay silent. */
export interface Audio {
  sfx(name: SfxName): void;
  /** Crisp hit tick, higher with `n`. */
  hit(n: number): void;
  /** A Beast is knocked out / found. */
  kill(n: number): void;
  sparkle(): void;
  /** Rising tick (mash, wobble). */
  wobble(i: number): void;
  /** Short alarm panned to -1..1 (telegraphs). */
  warn(pan: number): void;
  /** Heavy impact (slams). */
  thud(): void;
  /** A soft whiff for a harmless miss. */
  whiff(): void;
  king(): void;
  kingKill(): void;
  fanfare(): void;
}

export const silentAudio: Audio = {
  sfx() {}, hit() {}, kill() {}, sparkle() {}, wobble() {}, warn() {}, thud() {}, whiff() {}, king() {}, kingKill() {}, fanfare() {},
};

export interface GameCtx {
  rng: Rng;
  /** Speed level (0 at the start, +1 every 5 clears). Drives difficulty inside each game. */
  level: number;
  /** Seconds of play for this game (already scaled by the speed level). */
  duration: number;
  cast: Cast;
  /** The run's partner Beast ("YOUR BEAST"): stars in DODGE, FEED, COUNTER and the boss. */
  partner: RosterEntry;
  /** How many times this game was already dealt in this run (tutorial hints for the first two). */
  seenBefore: number;
  audio: Audio;
  /** Reduced motion: no screen shake, softer flashes, 30 Hz static. */
  calm: boolean;
}

export interface Microgame {
  readonly id: GameId;
  readonly prompt: string;
  readonly hint: Hint;
  /** Optional line under the hint in the interstitial. */
  readonly caption?: string;
  /** Flat background colour (also fills the letterbox). */
  readonly bg: string;
  readonly duration: number;
  /** Species that appear in this game (marked seen in the book). */
  readonly cast: RosterEntry[];
  status: Status;
  /** Seconds since play started. */
  t: number;
  /** Juice requests, read and cleared by the engine every frame. */
  shake: number;
  hitstop: number;
  /** Called during the interstitial (the scene is frozen; HUMAN EYES keeps its static moving). */
  preview(dt: number): void;
  /** Advance play (input) or the outro reaction (empty input). */
  update(dt: number, input: FrameInput): void;
  /** Time ran out while still playing: decide (most games lose, survival games win). */
  expire(): void;
  draw(g: Gfx): void;
  /** Scripted player for the attract-mode demo: the input it would give this frame. */
  bot(dt: number): FrameInput;
}
