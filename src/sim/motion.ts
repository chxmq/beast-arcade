import type { Spawn } from './schedule.ts';

/** SPEC §6: reflecting linear motion on one axis, Q4 fixed point, unsigned math. */
export function axis(L: number, s0: number, v: number, dir: number, dt: number): number {
  if (L === 0) return 0;
  const P = 2 * L;
  const u0 = dir === 1 ? s0 : (P - s0) % P;
  const u = (u0 + v * dt) % P;
  return u <= L ? u : P - u;
}

/** Top-left of the silhouette in whole field pixels at `tick` (tick >= spawnTick). */
export function positionAt(s: Spawn, tick: number): { px: number; py: number } {
  const dt = tick - s.spawnTick;
  return {
    px: axis(s.Lx, s.x0, s.vx, s.dirX, dt) >> 4,
    py: axis(s.Ly, s.y0, s.vy, s.dirY, dt) >> 4,
  };
}

/** Is local pixel (lx, ly) inside a hittable 8x8 occupancy cell? */
export function occHit(occ: bigint, w: number, h: number, lx: number, ly: number): boolean {
  if (lx < 0 || ly < 0 || lx >= w || ly >= h) return false;
  const cx = Math.floor((lx * 8) / w);
  const cy = Math.floor((ly * 8) / h);
  return ((occ >> BigInt(cy * 8 + cx)) & 1n) === 1n;
}
