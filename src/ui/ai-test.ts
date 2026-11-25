import type { App } from '../main.ts';
import { sound } from '../game/audio.ts';
import { Drifter, featured } from '../game/beasts.ts';
import { settings } from '../game/settings.ts';
import { Tv } from '../game/tv.ts';
import { backPrompt, opBar, promptButton, wireOperator } from './about.ts';
import { h } from './dom.ts';
import './operator.css';

const SHOT_EVERY_MS = 2000;
/** The same ink and paper for the live view and the screenshot, so they differ only in time. */
const INK: [number, number, number] = [244, 236, 216];
const PAPER: [number, number, number] = [7, 7, 10];

/** Calm mode draws the field at reduced contrast; a screenshot captures exactly that. */
const shown = (c: number) => (settings.calm ? Math.round(255 * (0.5 + (c / 255 - 0.5) * 0.3)) : c);

/** Paint a 1-bit field into a 2D canvas exactly as a screenshot would capture it. */
function paintFrame(canvas: HTMLCanvasElement, cur: Uint8Array, w: number, hh: number) {
  canvas.width = w;
  canvas.height = hh;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(w, hh);
  const ink = INK.map(shown);
  const paper = PAPER.map(shown);
  for (let i = 0; i < cur.length; i++) {
    const c = cur[i] ? ink : paper;
    img.data[i * 4] = c[0];
    img.data[i * 4 + 1] = c[1];
    img.data[i * 4 + 2] = c[2];
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

export function aiTestScreen(app: App) {
  const wrap = h('div', { class: 'op op-ai' });
  const liveBox = h('div', { class: 'op-tv' });
  const shotBox = h('div', { class: 'op-tv' });
  const shot = h('canvas', { class: 'op-shot' });
  shotBox.append(shot);
  const frozenTag = h('div', { class: 'op-frozen' }, 'FROZEN');
  frozenTag.hidden = true;
  const shotCap = h('div', { class: 'op-figcap' }, 'Waiting for the first screenshot.');

  const freeze = promptButton({ cap: 'A', label: 'FREEZE THE LIVE VIEW', run: () => toggle() }, 'op-cta op-freeze');
  wrap.append(
    opBar('THE AI TEST', [{ cap: 'A', label: 'FREEZE', run: () => toggle() }, backPrompt(app)]),
    h('p', { class: 'op-ai-lead' }, 'Three Beasts are moving in this noise right now. Left is what you see. Right is what an AI agent gets: one screenshot every two seconds, the way computer-use agents look at a screen.'),
    h('div', { class: 'op-ai-grid' },
      h('figure', { class: 'op-fig eyes' },
        h('div', { class: 'op-fig-h' }, h('b', {}, 'YOUR EYES'), h('span', {}, '(LIVE)')),
        liveBox,
        h('div', { class: 'op-figcap' }, 'Your eyes add up the motion. ', h('b', {}, 'Three shapes.'))),
      h('figure', { class: 'op-fig ai' },
        h('div', { class: 'op-fig-h' }, h('b', {}, 'AN AI'), h('span', {}, '(ONE SCREENSHOT EVERY 2 S)')),
        shotBox,
        shotCap)),
    freeze,
    h('section', { class: 'op-sec' },
      h('h2', { class: 'op-h' }, 'WHY IT WORKS'),
      h('p', {}, 'Every frame is fresh random noise. Inside a Beast, a share of last frame\'s dots is carried forward along a flow: a swirl, a streak or a slam. Dots are only ever moved, never copied, so each frame on its own has the same statistics everywhere. There is no edge, no density change, nothing to find.'),
      h('p', {}, 'Carried dots also die off fast. Two frames a second apart share nothing, so even a stack of screenshots is just a stack of noise. Your visual system integrates motion over about a tenth of a second, which is exactly the window the Beasts live in.'),
      h('p', {}, 'This noise only appears where it is the point: the HUMAN EYES ranked cabinet, and the HUMAN EYES! microgame that MICRO MAYHEM keeps dealing. Ranked runs go further: the game streams only pixels, and the answers are committed onchain before play and revealed after. Reading the code or the page gets a bot nothing.'),
      h('p', { class: 'op-dim' }, 'The limit, stated plainly: a purpose-built vision system that reads every frame at full rate and computes motion could decode it. Screenshot agents, and anyone who pauses, see noise.')),
  );
  app.root.append(wrap);

  const tv = new Tv(liveBox, { ink: INK, paper: PAPER });
  liveBox.append(frozenTag); // after the canvas the Tv just added, so it sits on top
  const pool = featured(app.roster);
  const drifters = pool.slice(0, 3).map((e, i) => new Drifter(e, tv.field.w, tv.field.h, i as 0 | 1 | 2, 0.86, 0.3));
  let shots = 0;
  let lastShot = 0;
  let sized = '';
  tv.start(() => drifters.map((d) => d.step()), () => {
    // Draw the screenshot at the same integer scale and letterbox as the live picture.
    const p = tv.presenter;
    const key = `${p.scale}:${p.dpr}`;
    if (key !== sized && p.scale > 0) {
      sized = key;
      shot.style.width = `${(tv.field.w * p.scale) / p.dpr}px`;
      shot.style.height = `${(tv.field.h * p.scale) / p.dpr}px`;
    }
    const now = performance.now();
    if (now - lastShot >= SHOT_EVERY_MS) {
      lastShot = now;
      shots++;
      paintFrame(shot, tv.field.cur, tv.field.w, tv.field.h);
      shotCap.textContent = `Screenshot ${shots}. Find a Beast in it.`;
    }
  });

  const label = freeze.querySelector('.op-plbl')!;
  function toggle() {
    tv.paused = !tv.paused;
    sound.sfx('select');
    frozenTag.hidden = !tv.paused;
    freeze.classList.toggle('on', tv.paused);
    label.textContent = tv.paused ? 'UNFREEZE. THE BEASTS WERE NEVER IN THE PICTURE' : 'FREEZE THE LIVE VIEW';
  }

  const unwire = wireOperator(app, wrap, { A: toggle });
  const onKey = (e: KeyboardEvent) => {
    if ((e.key === 'f' || e.key === 'F') && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) toggle();
  };
  window.addEventListener('keydown', onKey);
  return () => {
    unwire();
    window.removeEventListener('keydown', onKey);
    tv.stop();
  };
}
