// Asset readiness for MICRO MAYHEM: every Beast's art (pixel PNGs) and the display font.
import type { RosterEntry } from '../data/roster.ts';
import { artOf } from '../game/beasts.ts';

/** Resolve when every Beast's art and the display font are ready, or after `ms` at the latest. */
export function whenAssetsReady(entries: readonly RosterEntry[], ms: number): Promise<void> {
  const art = Promise.all(entries.map((e) => {
    const img = artOf(e);
    if (img.complete) return Promise.resolve();
    return new Promise<void>((res) => {
      img.addEventListener('load', () => res(), { once: true });
      img.addEventListener('error', () => res(), { once: true });
    });
  }));
  const font = typeof document !== 'undefined' && document.fonts
    ? document.fonts.load("16px 'Press Start 2P'").then(() => undefined, () => undefined)
    : Promise.resolve();
  return Promise.race([Promise.all([art, font]).then(() => undefined), new Promise<void>((res) => setTimeout(res, ms))]);
}
