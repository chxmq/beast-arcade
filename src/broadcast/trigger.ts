// The ranked trigger: which strikes a Broadcast client may send. DOM-free (tested in Node).
//
// SPEC §7 gap rule: after a hit or an overkill the next strike may come GAP_HIT ticks later,
// after a miss only GAP_MISS ticks later. A ranked tape gives no feedback, so the client never
// knows whether a strike missed. It therefore always waits GAP_MISS, which makes every log it
// can produce valid, whatever the strikes turned out to be. Strikes are type 0 (v2 flags are 0).

import { encodeStrike } from '../sim/encode.ts';
import { FIELD_H, FIELD_W, GAP_MISS, MAX_STRIKES, MAX_TICK } from '../sim/spec.ts';

/** Ticks between two ranked strikes (18 ticks = 9 tape frames = 300 ms). */
export const RANKED_GAP = GAP_MISS;

export class Trigger {
  /** Encoded strikes, in order (SPEC §7 u32s). */
  readonly strikes: number[] = [];
  private last = -1;

  /** Tick of the last strike, -1 before the first. */
  get lastTick(): number {
    return this.last;
  }

  get left(): number {
    return MAX_STRIKES - this.strikes.length;
  }

  /** Ticks until a strike is allowed at `tick` (0 = now). */
  cooldown(tick: number): number {
    return this.last < 0 ? 0 : Math.max(0, this.last + RANKED_GAP - tick);
  }

  /** 0 right after a strike, 1 once the next one is allowed. */
  charge(tick: number): number {
    return this.last < 0 ? 1 : Math.max(0, Math.min(1, (tick - this.last) / RANKED_GAP));
  }

  ready(tick: number): boolean {
    return this.left > 0 && tick < MAX_TICK && this.cooldown(tick) === 0;
  }

  /**
   * Records a strike at field pixel (x, y) on `tick`. False (nothing recorded) during the
   * cooldown, past the limits, or outside the field: a click in the letterbox is not a strike.
   */
  fire(tick: number, x: number, y: number): boolean {
    if (!Number.isInteger(tick) || tick < 0 || !this.ready(tick)) return false;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= FIELD_W || y >= FIELD_H) return false;
    this.strikes.push(encodeStrike({ tick, x, y, type: 0 }));
    this.last = tick;
    return true;
  }
}
