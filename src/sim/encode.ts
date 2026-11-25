import type { BeastType } from './spec.ts';

export interface Strike {
  tick: number;
  x: number;
  y: number;
  type: BeastType;
}

/** SPEC §7: tick << 18 | x << 10 | y << 2 | type, as an unsigned 32-bit number. */
export function encodeStrike(s: Strike): number {
  return s.tick * 262144 + s.x * 1024 + s.y * 4 + s.type;
}

export function decodeStrike(v: number): Strike {
  return {
    tick: Math.floor(v / 262144),
    x: Math.floor(v / 1024) % 256,
    y: Math.floor(v / 4) % 256,
    type: (v % 4) as BeastType,
  };
}
