// MICRO MAYHEM: the cabinet screen. Owns the canvas, the loop, the music, the payout and the
// results. Everything is sized to app.root (the cabinet's 16:9 screen), never to the window.
import '../ui/micro.css';
import { tickets } from '../arcade/wallet.ts';
import { sound } from '../game/audio.ts';
import { collection } from '../game/collection.ts';
import { settings } from '../game/settings.ts';
import type { App } from '../main.ts';
import { h } from '../ui/dom.ts';
import { whenAssetsReady } from './assets.ts';
import { Beat } from './beat.ts';
import { Cast } from './cast.ts';
import { clearTickets, MicroRun, recordBest, speedLabel, type StorageLike } from './engine.ts';
import { createGame } from './games/index.ts';
import { Gfx, PAL } from './gfx.ts';
import { MicroInput } from './input.ts';
import { randomSeed } from './rng.ts';
import { showResults, type ResultsView } from './results.ts';
import type { Audio } from './types.ts';
import { drawRun } from './view.ts';

/** The games' sound hooks, voiced by the shared synth (src/game/audio.ts). */
export const cabinetAudio: Audio = {
  sfx: (n) => sound.sfx(n),
  hit: (n) => sound.hit(n),
  kill: (n) => sound.kill(n),
  sparkle: () => sound.sparkle(),
  wobble: (i) => sound.wobble(i),
  warn: (p) => sound.warn(p),
  thud: () => sound.escape(),
  whiff: () => sound.overkill(),
  king: () => sound.king(),
  kingKill: () => sound.kingKill(),
  fanfare: () => sound.fanfare(),
};

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function microScreen(app: App) {
  const root = h('div', { class: 'micro' });
  const canvas = h('canvas', { class: 'micro-canvas', 'aria-label': 'MICRO MAYHEM' });
  root.append(canvas);
  app.root.append(root);

  const g = new Gfx(canvas);
  const cast = new Cast(app.roster.entries);
  const storage = browserStorage();
  const beat = new Beat();
  const input = new MicroInput(canvas, (x, y) => g.toLogical(x, y));
  let ready = false;
  let raf = 0;
  let last = performance.now();
  let results: ResultsView | null = null;
  let musicOn = false;

  const newRun = () =>
    new MicroRun({
      cast,
      seed: randomSeed(),
      create: createGame,
      audio: cabinetAudio,
      calm: settings.calm,
      onSeen: (e) => collection.seen(e.speciesId),
      onLevel: (l) => beat.setLevel(l),
    });
  let run = newRun();
  let paid = false;

  const openResults = () => {
    if (!paid) {
      paid = true;
      tickets.add(run.earned, 'micro');
    }
    const best = recordBest(storage, run.cleared);
    const clears = run.clearLevels.length;
    results = showResults(root, {
      cleared: run.cleared,
      best: best.best,
      newBest: best.isNew,
      speed: speedLabel(run.level),
      met: [...run.met.values()],
      bosses: run.bosses,
      clears,
      clearPay: run.clearLevels.reduce((s, l) => s + clearTickets(l), 0),
      earned: run.earned,
    }, {
      again: playAgain,
      back: () => app.go({ name: 'arcade' }),
      tick: () => sound.sfx('ticket'),
    });
  };

  const playAgain = () => {
    results?.destroy();
    results = null;
    run = newRun();
    paid = false;
    input.flush();
    beat.setLevel(0);
    sound.sfx('start');
  };

  input.onButton = (b) => {
    if (!results) return;
    if (b === 'A' || b === 'START') results.press(b);
    else if (b === 'B') results.press('B');
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (results) results.press('ESC');
    else if (run.cleared === 0 && run.phase !== 'over' && run.phase !== 'done') app.go({ name: 'arcade' });
    else run.quit();
  };
  window.addEventListener('keydown', onKey);

  const music = () => {
    const live = ready && !results && !document.hidden && run.phase !== 'over' && run.phase !== 'done';
    if (live && !musicOn && sound.ctx) {
      beat.start();
      musicOn = true;
    } else if (!live && musicOn) {
      beat.stop();
      musicOn = false;
    }
    const bossy = run.phase === 'boss' || run.game?.id === 'boss' && (run.phase === 'prompt' || run.phase === 'play' || run.phase === 'outro');
    beat.setMood(run.phase === 'title' ? 'quiet' : bossy ? 'boss' : 'groove');
  };

  const drawLoading = (t: number) => {
    g.begin(PAL.screen);
    g.text('MICRO MAYHEM', 160, 80, { size: 12, color: PAL.gold });
    const w = 120;
    g.rect(160 - w / 2, 100, w, 4, PAL.cab);
    g.rect(160 - w / 2, 100, ((t * 1.4) % 1) * w, 4, PAL.hot);
    g.text('LOADING BEASTS', 160, 116, { size: 6, color: PAL.dim });
  };

  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    g.time += dt;
    if (!ready) {
      drawLoading(g.time);
      return;
    }
    const frame = input.frame();
    if (run.phase !== 'done') run.update(dt, frame);
    music();
    drawRun(g, run);
    if (run.phase === 'done' && !results) openResults();
  };

  const ro = new ResizeObserver(() => g.resize());
  ro.observe(canvas);
  const onResize = () => g.resize(); // devicePixelRatio changes (another display) skip the observer
  window.addEventListener('resize', onResize);
  const onVis = () => {
    last = performance.now();
    music();
  };
  document.addEventListener('visibilitychange', onVis);

  // Dev builds only: a handle for test drivers (read the run, map logical px to the page).
  const dbg = window as unknown as { __micro?: unknown };
  if (import.meta.env.DEV) dbg.__micro = { run: () => run, gfx: g, results: () => results };

  void whenAssetsReady(app.roster.entries, 2500).then(() => {
    ready = true;
    last = performance.now();
    input.flush();
  });
  raf = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    input.destroy();
    beat.stop();
    results?.destroy();
    root.remove();
    if (import.meta.env.DEV) delete dbg.__micro;
  };
}
