// Attract-mode demo: MICRO MAYHEM playing itself. Random microgames with a scripted player,
// labelled DEMO. No sound, no tickets, no collection writes. Sized to its container.
import '../ui/micro.css';
import { loadRoster, type Roster } from '../data/roster.ts';
import { settings } from '../game/settings.ts';
import { h } from '../ui/dom.ts';
import { whenAssetsReady } from './assets.ts';
import { Cast } from './cast.ts';
import { MicroRun, REGULAR } from './engine.ts';
import { createGame } from './games/index.ts';
import { Gfx, PAL } from './gfx.ts';
import { randomSeed } from './rng.ts';
import { noInput } from './types.ts';
import { drawRun } from './view.ts';

let rosterP: Promise<Roster> | null = null;
const roster = () => (rosterP ??= loadRoster());

/** Restart the demo after this many microgames so it stays at friendly speeds. */
const GAMES_PER_RUN = 9;

export function microDemo(container: HTMLElement): () => void {
  const root = h('div', { class: 'micro micro-demo' });
  if (getComputedStyle(container).position === 'static') root.classList.add('micro-flow');
  const canvas = h('canvas', { class: 'micro-canvas' });
  root.append(canvas);
  container.append(root);

  const g = new Gfx(canvas);
  let raf = 0;
  let stopped = false;
  let last = performance.now();
  let run: MicroRun | null = null;
  let cast: Cast | null = null;

  const fresh = () => {
    if (!cast) return;
    const seed = randomSeed();
    run = new MicroRun({ cast, seed, create: createGame, demo: true, skipTitle: true, first: REGULAR[seed % REGULAR.length], calm: settings.calm });
  };

  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    g.time += dt;
    if (!run) {
      g.begin(PAL.screen);
      return;
    }
    const game = run.game;
    const inp = run.phase === 'play' && game ? game.bot(dt) : noInput();
    run.update(dt, inp);
    if (run.phase === 'prompt' && run.stage > GAMES_PER_RUN) fresh();
    if (run) drawRun(g, run, { demo: true });
  };

  const ro = new ResizeObserver(() => g.resize());
  ro.observe(canvas);
  const onResize = () => g.resize(); // devicePixelRatio changes (another display) skip the observer
  window.addEventListener('resize', onResize);
  roster()
    .then(async (r) => {
      if (stopped) return;
      await whenAssetsReady(r.entries, 2000);
      if (stopped) return;
      cast = new Cast(r.entries);
      fresh();
    })
    .catch(() => {
      /* no roster: the demo stays dark */
    });
  raf = requestAnimationFrame(loop);

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    ro.disconnect();
    window.removeEventListener('resize', onResize);
    root.remove();
  };
}
