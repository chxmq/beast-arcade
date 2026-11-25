// Attract mode: the cabinet idling. Cycles the logo with a Beast parade, HOW TO PLAY, a featured
// Art Hackathon Beast, HIGH SCORES (local and today's onchain board) and, when MICRO ships one, a
// demo. COIN drops a credit; START (or A, or a tap) starts. Chiptune attract theme.
import type { App } from '../main.ts';
import type { RosterEntry } from '../data/roster.ts';
import { assetUrl } from '../data/roster.ts';
import { cabinet, credits } from '../arcade/cabinet.ts';
import { drawBeast, isCutout, loadAll, mulberry, setRes } from '../arcade/pixel.ts';
import { bind, commas, reducedMotion } from '../arcade/ui.ts';
import { sound } from '../game/audio.ts';
import { music } from '../game/music.ts';
import { artCrop, artistOf, MOTION, typeName } from '../game/beasts.ts';
import { collection } from '../game/collection.ts';
import { dexIndex, dexLabel } from '../game/dex.ts';
import { saveSettings, settings } from '../game/settings.ts';
import { h } from './dom.ts';

export const STORY_LINE = 'The Beasts of Loot Survivor got loose in the arcade. Win tickets, catch them all.';

/** MICRO MAYHEM's local best, if it has stored one (a number, or JSON with score/best). */
export function microBest(): number {
  try {
    const raw = localStorage.getItem('beastarcade.micro.best');
    if (!raw) return 0;
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
    const j = JSON.parse(raw) as { score?: unknown; best?: unknown };
    const v = Number(j?.score ?? j?.best ?? 0);
    return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
  } catch {
    return 0;
  }
}

export interface BoardRow { callsign: string; score: number; player?: string }
export interface Board { rows: BoardRow[]; offchain: boolean; onAir: boolean }

/** Today's HUMAN EYES board from the server. Null when unreachable. */
export async function fetchBoard(timeoutMs = 4000): Promise<Board | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch('/api/broadcast/status', { signal: ctl.signal });
    if (!res.ok) return null;
    const j = (await res.json()) as { board?: unknown; offchain?: boolean; onAir?: boolean };
    const rows = Array.isArray(j.board)
      ? (j.board as BoardRow[]).filter((r) => r && typeof r.callsign === 'string' && Number.isFinite(r.score)).sort((a, b) => b.score - a.score)
      : [];
    return { rows, offchain: j.offchain === true, onAir: j.onAir === true };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

type Demo = (container: HTMLElement) => () => void;

/** MICRO MAYHEM's attract demo, if src/micro/demo.ts exists (the build never depends on it). */
async function loadDemo(): Promise<Demo | null> {
  try {
    const mods = import.meta.glob<{ microDemo?: Demo }>('../micro/demo.ts');
    const load = mods['../micro/demo.ts'];
    if (!load) return null;
    const m = await load();
    return typeof m.microDemo === 'function' ? m.microDemo : null;
  } catch {
    return null;
  }
}

type SegId = 'logo' | 'how' | 'meet' | 'scores' | 'demo';
const SEG_MS: Record<SegId, number> = { logo: 11000, how: 8500, meet: 7000, scores: 8500, demo: 15000 };

const ORD = ['1ST', '2ND', '3RD', '4TH', '5TH'];

export function bootScreen(app: App) {
  const roster = app.roster;
  const calm = () => settings.calm || reducedMotion();
  const featured = roster.entries.filter((e) => e.featured);
  const rnd = mulberry((Date.now() / 1000) | 0);
  const pickOne = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];

  const stage = h('div', { class: 'att-stage' });
  const footMsg = h('span', { class: 'att-insert blink' }, 'INSERT COIN');
  const credEl = h('span', { class: 'att-cred' }, '');
  const foot = h('div', { class: 'att-foot' }, h('span', { class: 'att-free' }, 'FREE PLAY'), footMsg, credEl);
  const creditBox = h('div', { class: 'att-credit' });
  creditBox.hidden = true;
  const root = h('div', { class: 'att' }, stage, creditBox, foot);
  app.root.append(root);
  music.theme('attract');

  const timers: number[] = [];
  const later = (fn: () => void, ms: number) => { timers.push(window.setTimeout(fn, ms)); };
  let segCleanup: (() => void) | null = null;
  let segTimer = 0;
  let gone = false;

  // ------------------------------------------------------------------ credits and start
  const renderCredits = () => {
    const n = credits.count();
    credEl.textContent = `CREDIT ${String(n).padStart(2, '0')}`;
    footMsg.textContent = n > 0 ? 'PRESS START' : 'INSERT COIN';
    root.classList.toggle('has-credit', n > 0);
  };
  renderCredits();
  const offCredits = credits.subscribe(renderCredits);

  let starting = false;
  const showCredit = (line: string) => {
    creditBox.hidden = false;
    creditBox.innerHTML = '';
    creditBox.append(
      h('div', { class: 'att-credit-n' }, `CREDIT ${credits.count()}`),
      h('div', { class: 'att-credit-go blink' }, line));
  };
  const coin = () => {
    if (starting) return;
    sound.sfx('coin');
    credits.add();
    showCredit('PRESS START');
  };
  const begin = () => {
    starting = true;
    sound.sfx('start');
    credits.use();
    creditBox.hidden = false;
    creditBox.innerHTML = '';
    creditBox.append(h('div', { class: 'att-credit-n ready' }, 'PLAYER 1'), h('div', { class: 'att-credit-go' }, 'GET READY'));
    root.classList.add('starting');
    later(() => { if (!gone) app.go({ name: 'arcade' }); }, calm() ? 250 : 700);
  };
  const start = () => {
    if (starting) return;
    if (credits.count() > 0) return begin();
    // Free play: START with no credit drops the coin for you.
    starting = true;
    sound.sfx('coin');
    credits.add();
    showCredit('PRESS START');
    later(() => { if (!gone) begin(); }, 420);
  };

  // ------------------------------------------------------------------ segments
  let board: Board | null | undefined;
  void fetchBoard().then((b) => { board = b; });
  let demo: Demo | null = null;
  void loadDemo().then((d) => { demo = d; });

  const order = (): SegId[] => (demo ? ['logo', 'how', 'meet', 'scores', 'demo'] : ['logo', 'how', 'meet', 'scores']);
  let seg: SegId = 'logo';

  function show(id: SegId) {
    segCleanup?.();
    segCleanup = null;
    clearTimeout(segTimer);
    stage.innerHTML = '';
    seg = id;
    root.dataset.seg = id;
    cabinet()?.transition();
    const build = { logo: segLogo, how: segHow, meet: segMeet, scores: segScores, demo: segDemo }[id];
    segCleanup = build();
    segTimer = window.setTimeout(() => step(1), SEG_MS[id]);
  }
  function step(d: number) {
    if (gone) return;
    const list = order();
    const i = Math.max(0, list.indexOf(seg));
    show(list[(i + d + list.length) % list.length]);
  }

  // ---- LOGO: title over a parade of Beasts marching along the arcade floor
  function segLogo(): () => void {
    const canvas = h('canvas', { class: 'att-parade' });
    const word = (w: string, cls: string) => h('span', { class: `att-word ${cls}` }, ...[...w].map((ch, i) => {
      const s = h('span', { class: 'att-ch' }, ch);
      s.style.setProperty('--i', String(i + (cls === 'w2' ? 5 : 0)));
      return s;
    }));
    const story = h('p', { class: 'att-story' });
    const logo = h('div', { class: 'att-logo' },
      h('div', { class: 'att-title' }, word('BEAST', 'w1'), word('ARCADE', 'w2')),
      h('div', { class: 'att-sub' }, `${roster.entries.length} REAL BEASTS FROM STARKNET`),
      story);
    stage.append(canvas, logo);

    // First launch: one line of story, typed out.
    let typer = 0;
    if (!settings.storySeen) {
      let n = 0;
      const tick = () => {
        n++;
        story.textContent = STORY_LINE.slice(0, n);
        if (n < STORY_LINE.length) typer = window.setTimeout(tick, calm() ? 0 : 34);
        else { settings.storySeen = true; saveSettings(); }
      };
      typer = window.setTimeout(tick, 900);
    } else {
      story.textContent = 'MICRO MAYHEM . BEAST CATCH . HUMAN EYES';
      story.classList.add('dim');
    }

    // The parade: Art Hackathon Beasts lead, Loot Survivor originals follow, now and then a giant.
    interface Walker { e: RosterEntry; x: number; speed: number; scale: number; phase: number; flip: boolean }
    const pool = [...featured, ...roster.entries.filter((e) => !e.featured)];
    const walkers: Walker[] = [];
    let W = 320;
    let H = 180;
    let floor = 150;
    const stars: [number, number, number][] = [];
    let ctx: CanvasRenderingContext2D | null = null;
    const resize = () => {
      // Layout size, not the on-screen rect: the CRT warm-up scales the screen for a moment.
      const cw = canvas.clientWidth;
      const chh = canvas.clientHeight;
      if (!cw || !chh) return;
      const p = Math.max(1, Math.round(chh / 170));
      W = Math.round(cw / p);
      H = Math.round(chh / p);
      floor = H - Math.round(H * 0.16);
      ctx = setRes(canvas, W, H);
      stars.length = 0;
      const sr = mulberry(7);
      for (let i = 0; i < Math.round(W * H / 900); i++) stars.push([Math.floor(sr() * W), Math.floor(sr() * (floor - 20)), sr()]);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    let spawnGap = 0;
    const choose = (giant: boolean): RosterEntry => {
      // Only Beasts drawn on a clear background walk the floor (some Art Hackathon pieces are square paintings).
      let e = pool[0];
      for (let tries = 0; tries < 12; tries++) {
        e = giant ? pickOne(featured.length ? featured : pool) : pool[Math.floor(rnd() * Math.min(pool.length, rnd() < 0.55 ? Math.max(1, featured.length) : pool.length))];
        if (isCutout(e) === true) break;
      }
      return e;
    };
    const spawn = () => {
      const giant = rnd() < 0.14;
      const e = choose(giant);
      const ah = e.artBox[3];
      const scale = giant ? Math.max(1, Math.floor((H * 0.42) / ah)) : Math.max(1, Math.floor((H * 0.2) / ah));
      walkers.push({ e, x: W + e.artBox[2] * scale, speed: (giant ? 14 : 20 + rnd() * 16), scale, phase: rnd() * 1000, flip: false });
      spawnGap = (e.artBox[2] * scale) + 10 + rnd() * 26;
    };
    void loadAll(pool.slice(0, 40));
    let raf = 0;
    let last = performance.now();
    let t = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      t += dt;
      if (!ctx) return;
      const g = ctx;
      g.fillStyle = '#07070a';
      g.fillRect(0, 0, W, H);
      for (const [sx, sy, k] of stars) {
        const on = Math.sin(t * (1.5 + k * 3) + k * 40) > 0.2;
        if (!on && !calm()) continue;
        g.fillStyle = k > 0.85 ? '#ffc61a' : k > 0.6 ? '#23d5ff' : '#5c544a';
        g.fillRect(sx, sy, 1, 1);
      }
      // floor: a lit edge and a row of tiles
      g.fillStyle = '#ff3b2f';
      g.fillRect(0, floor + 1, W, 1);
      for (let x = 0; x < W; x += 8) {
        g.fillStyle = ((x / 8) | 0) % 2 ? '#1d0d0b' : '#2b1310';
        g.fillRect(x - ((t * 24) % 16), floor + 2, 8, H - floor - 2);
      }
      // march
      const move = calm() ? 0.5 : 1;
      if (!walkers.length || walkers[walkers.length - 1].x < W - spawnGap) spawn();
      for (const w of walkers) w.x -= w.speed * dt * move;
      while (walkers.length && walkers[0].x < -walkers[0].e.artBox[2] * walkers[0].scale) walkers.shift();
      for (const w of walkers) {
        const bob = calm() ? 0 : (Math.floor((t * 1000 + w.phase) / 180) % 2) * w.scale;
        const width = w.e.artBox[2] * w.scale;
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(Math.round(w.x - width * 0.35), floor - 1, Math.round(width * 0.7), 2);
        drawBeast(g, w.e, w.x, floor - bob, w.scale, 'art', w.flip);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      clearTimeout(typer);
    };
  }

  // ---- HOW TO PLAY: three cabinets, one line each
  function segHow(): () => void {
    const orig = roster.entries.filter((e) => !e.featured);
    const rows: [string, string, string, RosterEntry | undefined][] = [
      ['g-micro', 'MICRO MAYHEM', 'Four-second Beast microgames. Read the prompt, hit the button. Faster every round.', pickOne(orig.length ? orig : roster.entries)],
      ['g-catch', 'BEAST CATCH', 'Wild Beasts run loose. Tap them before they flee. Every catch fills your book.', pickOne(featured.length ? featured : roster.entries)],
      ['g-eyes', 'HUMAN EYES', 'Beasts hidden as motion in noise. Only human eyes can see them. Ranked onchain.', undefined],
    ];
    const list = h('div', { class: 'att-how-list' });
    for (const [cls, name, line, e] of rows) {
      const ico = h('div', { class: `att-how-ico ${cls}` });
      if (e) ico.append(artCrop(e));
      else ico.append(h('i', { class: 'att-eye', 'aria-hidden': 'true' }));
      list.append(h('div', { class: `att-how-row ${cls}` }, ico, h('div', { class: 'att-how-txt' }, h('b', {}, name), h('span', {}, line))));
    }
    stage.append(h('div', { class: 'att-card att-how' },
      h('h2', { class: 'att-h' }, 'HOW TO PLAY'),
      list,
      h('p', { class: 'att-how-foot' }, 'EVERY GAME PAYS ', h('b', {}, 'TICKETS'), '. TRADE THEM FOR BEAST CAPSULES AT THE ', h('b', {}, 'PRIZE COUNTER'), '.'),
      h('p', { class: 'att-how-keys' }, 'JOYSTICK AND A B C, OR TAP THE SCREEN')));
    return () => {};
  }

  // ---- MEET: one Art Hackathon Beast, big, with its artist
  function segMeet(): () => void {
    const e = pickOne(featured.length ? featured : roster.entries);
    const dex = dexIndex(roster.entries);
    const art = h('div', { class: 'att-meet-art' });
    if (e.frames > 1 && e.gif) {
      const img = h('img', { src: assetUrl(e.gif), alt: '' });
      art.append(img);
    } else {
      art.append(artCrop(e));
    }
    const caught = collection.isCaught(e.speciesId);
    stage.append(h('div', { class: 'att-meet' },
      art,
      h('div', { class: 'att-meet-info' },
        h('span', { class: 'att-tag' }, e.featured ? 'ART HACKATHON' : 'LOOT SURVIVOR'),
        h('div', { class: 'att-meet-name' }, e.name.toUpperCase()),
        h('div', { class: 'att-meet-row' }, `${typeName(e.type).toUpperCase()} . ${MOTION[e.type]} . TIER ${e.tier}`),
        h('div', { class: 'att-meet-by' }, 'ART BY ', h('b', {}, artistOf(e))),
        h('div', { class: 'att-meet-dex' }, `${dexLabel(dex.get(e.speciesId) ?? 0)} IN THE BESTIARY . ${caught ? 'CAUGHT' : 'NOT CAUGHT YET'}`))));
    return () => {};
  }

  // ---- HIGH SCORES: local bests and today's onchain board
  function segScores(): () => void {
    const local = h('div', { class: 'att-col' });
    const micro = microBest();
    local.append(h('h3', { class: 'att-colh g-micro' }, 'MICRO MAYHEM'));
    local.append(h('div', { class: 'att-line' }, h('span', {}, 'YOUR BEST'), h('b', {}, micro ? commas(micro) : '---')));
    local.append(h('h3', { class: 'att-colh g-catch' }, 'BEAST CATCH'));
    const bests = app.channels
      .map((c) => ({ name: c.name, v: collection.bestFor(c.id) }))
      .filter((x) => x.v > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, 3);
    if (!bests.length) local.append(h('div', { class: 'att-line dim' }, h('span', {}, 'NO RUNS YET'), h('b', {}, '---')));
    for (const b of bests) local.append(h('div', { class: 'att-line' }, h('span', {}, b.name), h('b', {}, commas(b.v))));
    local.append(h('div', { class: 'att-line' }, h('span', {}, 'BOOK'), h('b', {}, `${collection.distinctCaught()}/${roster.entries.length}`)));

    const chain = h('div', { class: 'att-col chain' });
    const renderBoard = () => {
      chain.innerHTML = '';
      chain.append(h('h3', { class: 'att-colh g-eyes' }, 'TODAY ON STARKNET', board?.offchain ? h('span', { class: 'att-test' }, 'TEST') : null));
      if (board === undefined) { chain.append(h('div', { class: 'att-line dim' }, h('span', { class: 'blink' }, 'READING THE CHAIN'))); return; }
      if (board === null) { chain.append(h('div', { class: 'att-line dim' }, h('span', {}, 'BOARD OFFLINE'))); return; }
      if (!board.rows.length) { chain.append(h('div', { class: 'att-line dim' }, h('span', {}, 'NO RANKED RUNS YET TODAY')), h('div', { class: 'att-line dim' }, h('span', {}, 'BE THE FIRST HUMAN'))); return; }
      board.rows.slice(0, 5).forEach((r, i) => chain.append(h('div', { class: `att-line rank r${i + 1}` }, h('i', {}, ORD[i]), h('span', {}, r.callsign), h('b', {}, commas(r.score)))));
    };
    renderBoard();
    let poll = 0;
    if (board === undefined) poll = window.setInterval(() => { if (board !== undefined) { clearInterval(poll); renderBoard(); } }, 250);
    stage.append(h('div', { class: 'att-card att-scores' }, h('h2', { class: 'att-h' }, 'HIGH SCORES'), h('div', { class: 'att-cols' }, local, chain)));
    return () => clearInterval(poll);
  }

  // ---- DEMO: MICRO MAYHEM plays itself
  function segDemo(): () => void {
    if (!demo) { later(() => step(1), 0); return () => {}; }
    const box = h('div', { class: 'att-demo' });
    stage.append(box, h('div', { class: 'att-demo-tag' }, 'DEMO PLAY'));
    let stop: (() => void) | null = null;
    try {
      stop = demo(box);
    } catch {
      later(() => step(1), 0);
    }
    return () => { try { stop?.(); } catch { /* demo cleanup failed: ignore */ } };
  }

  // ------------------------------------------------------------------ input
  const offKeys = bind({
    COIN: coin,
    START: start,
    A: start,
    RIGHT: () => { if (!starting) step(1); },
    LEFT: () => { if (!starting) step(-1); },
  });
  const onTap = (e: PointerEvent) => {
    if (e.button > 0) return;
    start();
  };
  root.addEventListener('pointerdown', onTap);

  show('logo');

  return () => {
    gone = true;
    offKeys();
    offCredits();
    clearTimeout(segTimer);
    timers.forEach((t) => clearTimeout(t));
    segCleanup?.();
    root.removeEventListener('pointerdown', onTap);
  };
}
