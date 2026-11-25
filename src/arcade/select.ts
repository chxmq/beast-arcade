// Game select: big cabinet cards with pixel covers made from real Beast art, a carousel driven by
// the joystick (or taps), and a small operator row (PLAYER, THE AI TEST, ABOUT, SOUND, CALM).
import type { App, Route } from '../main.ts';
import type { RosterEntry } from '../data/roster.ts';
import { account } from '../chain/account.ts';
import { sound } from '../game/audio.ts';
import { music } from '../game/music.ts';
import { channelCaught, isUnlocked, type Channel } from '../game/channels.ts';
import { collection } from '../game/collection.ts';
import { saveSettings, settings } from '../game/settings.ts';
import { fetchBoard, microBest, type Board } from '../ui/boot.ts';
import { h } from '../ui/dom.ts';
import { cabinet } from './cabinet.ts';
import { controls } from './controls.ts';
import { MACHINES } from './gacha.ts';
import { capsule, drawBeast, drawMachine, fitScale, loadAll, mulberry, noise, PAL, pixelCanvas, rays, ring } from './pixel.ts';
import { bind, commas, keycap, promptBar, reducedMotion, ticketReadout, topBar } from './ui.ts';
import { tickets } from './wallet.ts';

type CardId = 'micro' | 'catch' | 'eyes' | 'prizes' | 'book';

interface GameCard {
  id: CardId;
  name: string;
  pitch: string;
  tag?: string;
  cover: (g: CanvasRenderingContext2D, w: number, h: number) => void;
}

const COVER_W = 128;
const COVER_H = 72;
const IDLE_MS = 90_000;
const HAB_KEY = 'beastarcade.habitat';

function payoutLine(id: string): string {
  const p = tickets.payouts(id);
  return p.runs ? `LAST RUN PAID ${commas(p.last)} TICKETS` : 'PAYS TICKETS EVERY RUN';
}

function storedHabitat(): string | null {
  try { return localStorage.getItem(HAB_KEY); } catch { return null; }
}
function storeHabitat(id: string) {
  try { localStorage.setItem(HAB_KEY, id); } catch { /* storage unavailable */ }
}

export function arcadeScreen(app: App) {
  const roster = app.roster;
  const entries = roster.entries;
  const featured = entries.filter((e) => e.featured);
  const originals = entries.filter((e) => !e.featured);
  const byId = (id: number) => entries.find((e) => e.speciesId === id);
  const rnd = mulberry(1234);
  const pick = <T,>(arr: T[], fallback: T): T => (arr.length ? arr[Math.floor(rnd() * arr.length)] : fallback);
  const caughtIds = collection.caughtIds();
  const anyCaught = entries.find((e) => caughtIds.has(e.speciesId));
  const anyUncaught = entries.find((e) => !caughtIds.has(e.speciesId) && e.featured) ?? entries.find((e) => !caughtIds.has(e.speciesId));

  const microTrio = [pick(originals, entries[0]), byId(10032) ?? pick(featured, entries[0]), pick(originals, entries[1])];
  const runner = byId(10031) ?? byId(10037) ?? byId(10034) ?? pick(featured, entries[0]);
  const bookArt = anyCaught ?? byId(10032) ?? featured[0];
  const coverArt: RosterEntry[] = [...microTrio, runner, ...(bookArt ? [bookArt] : []), ...(anyUncaught ? [anyUncaught] : [])];

  const CARDS: GameCard[] = [
    {
      id: 'micro', name: 'MICRO MAYHEM', pitch: 'Four-second Beast microgames, faster and faster. Boss every 15.',
      cover(g, w, hh) {
        rays(g, 0, 0, w, hh, w / 2, hh * 0.62, 9, '#7e1a12', '#3a0c08', 0.02);
        const [a, b, c] = microTrio;
        drawBeast(g, a, w * 0.2, hh - 9, fitScale(a, 30, 28), 'art', true);
        drawBeast(g, c, w * 0.8, hh - 9, fitScale(c, 30, 28));
        drawBeast(g, b, w / 2, hh - 7, fitScale(b, 54, 52));
        for (let i = 0; i < 12; i++) {
          g.fillStyle = i < 8 ? PAL.gold : '#5a4310';
          g.fillRect(10 + i * 9, hh - 5, 7, 3);
        }
      },
    },
    {
      id: 'catch', name: 'BEAST CATCH', pitch: 'Tap the wild Beasts before they flee. Every catch fills your book.',
      cover(g, w, hh) {
        g.fillStyle = '#0d1a10';
        g.fillRect(0, 0, w, hh);
        g.fillStyle = '#1d3a12';
        g.fillRect(0, hh - 16, w, 16);
        g.fillStyle = '#2f5d1a';
        for (let x = 0; x < w; x += 6) g.fillRect(x, hh - 16, 3, 1);
        g.fillStyle = 'rgba(244,236,216,0.35)';
        for (const [y, len, x0] of [[18, 26, 6], [30, 38, 2], [42, 22, 10], [52, 30, 4]] as const) g.fillRect(x0, y, len, 1);
        drawBeast(g, runner, w * 0.6, hh - 12, fitScale(runner, 56, 50), 'art', true);
        const cx = Math.round(w * 0.6);
        const cy = Math.round(hh - 12 - 24);
        ring(g, cx, cy, 15, PAL.gold);
        ring(g, cx, cy, 14, PAL.gold);
        g.fillStyle = PAL.gold;
        g.fillRect(cx - 20, cy, 8, 1); g.fillRect(cx + 13, cy, 8, 1);
        g.fillRect(cx, cy - 20, 1, 8); g.fillRect(cx, cy + 13, 1, 8);
      },
    },
    {
      id: 'eyes', name: 'HUMAN EYES', tag: 'ONCHAIN', pitch: 'Beasts hide as motion in noise. Human eyes only. Every run replayed in Cairo.',
      cover(g, w, hh) {
        noise(g, 0, 0, w, hh, mulberry(99));
        const cx = Math.round(w / 2);
        const cy = Math.round(hh / 2);
        // a pixel eye: black lids, white ball, cyan iris, black pupil
        for (let y = -15; y <= 15; y++) {
          const half = Math.round(34 * Math.sqrt(Math.max(0, 1 - (y / 15.5) ** 2)) * (1 - Math.abs(y) / 40));
          g.fillStyle = '#000';
          g.fillRect(cx - half - 3, cy + y, half * 2 + 7, 1);
        }
        for (let y = -12; y <= 12; y++) {
          const half = Math.round(30 * Math.sqrt(Math.max(0, 1 - (y / 12.5) ** 2)) * (1 - Math.abs(y) / 40));
          g.fillStyle = PAL.ink;
          g.fillRect(cx - half, cy + y, half * 2 + 1, 1);
        }
        for (let y = -10; y <= 10; y++) {
          const half = Math.round(Math.sqrt(Math.max(0, 110 - y * y)));
          g.fillStyle = PAL.cyan;
          g.fillRect(cx - half, cy + y, half * 2 + 1, 1);
        }
        for (let y = -5; y <= 5; y++) {
          const half = Math.round(Math.sqrt(Math.max(0, 30 - y * y)));
          g.fillStyle = '#000';
          g.fillRect(cx - half, cy + y, half * 2 + 1, 1);
        }
        g.fillStyle = '#fff';
        g.fillRect(cx + 3, cy - 6, 3, 3);
      },
    },
    {
      id: 'prizes', name: 'PRIZE COUNTER', pitch: 'Spend tickets on Beast capsules. Every capsule is a card for your book.',
      cover(g, w, hh) {
        for (let x = 0; x < w; x += 8) {
          g.fillStyle = ((x / 8) | 0) % 2 ? '#3a0c08' : '#5e1610';
          g.fillRect(x, 0, 8, hh);
        }
        g.fillStyle = '#1b0f0e';
        g.fillRect(0, hh - 6, w, 6);
        drawMachine(g, Math.round(w / 2 - 22), 1, 'legendary', { knob: 0.6, shake: 0, t: 0, lit: true });
        const cols = [PAL.cyan, PAL.gold, PAL.lime, PAL.hot, PAL.ink];
        [[14, hh - 9], [26, hh - 8], [100, hh - 9], [113, hh - 8], [20, hh - 16]].forEach(([x, y], i) => capsule(g, x, y, 4, cols[i % cols.length]));
      },
    },
    {
      id: 'book', name: 'BESTIARY', pitch: 'Every Beast, numbered. Unseen ones are ???. Fill the book.',
      cover(g, w, hh) {
        g.fillStyle = '#2a1610';
        g.fillRect(0, 0, w, hh);
        g.fillStyle = '#4a2a1c';
        g.fillRect(10, 6, w - 20, hh - 12);
        g.fillStyle = PAL.cream;
        g.fillRect(13, 8, w / 2 - 15, hh - 16);
        g.fillRect(w / 2 + 2, 8, w / 2 - 15, hh - 16);
        g.fillStyle = '#b9ab8e';
        g.fillRect(w / 2 - 2, 8, 4, hh - 16);
        const card = (x: number, e: RosterEntry | undefined, mode: 'art' | 'silhouette') => {
          const cw = 38;
          const ch = 46;
          const y = 13;
          g.fillStyle = mode === 'art' ? (e && e.tier <= 1 ? '#ffb000' : '#6ee7ff') : '#4a3a34';
          g.fillRect(x, y, cw, ch);
          g.fillStyle = '#16110f';
          g.fillRect(x + 2, y + 2, cw - 4, ch - 4);
          if (e) drawBeast(g, e, x + cw / 2, y + ch - 5, fitScale(e, cw - 8, ch - 10), mode);
          if (!e || mode === 'silhouette') {
            g.fillStyle = '#6a5e50';
            g.fillRect(x + cw / 2 - 1, y + 10, 3, 3);
          }
        };
        card(20, anyCaught ?? byId(10032) ?? featured[0], 'art');
        card(w / 2 + 9, anyUncaught, 'silhouette');
      },
    },
  ];

  // ------------------------------------------------------------------ habitats (BEAST CATCH)
  const distinct = collection.distinctCaught();
  const channels: Channel[] = app.channels ?? [];
  let hab = (() => {
    const saved = storedHabitat();
    const i = channels.findIndex((c) => c.id === saved && isUnlocked(c, distinct));
    if (i >= 0) return i;
    return Math.max(0, channels.findIndex((c) => isUnlocked(c, distinct)));
  })();

  // ------------------------------------------------------------------ DOM
  const tix = ticketReadout();
  const root = h('div', { class: 'sel-root' });
  const track = h('div', { class: 'sel-track' });
  const stage = h('div', { class: 'sel-stage' }, track);
  const cardEls: HTMLElement[] = [];
  const statEls: HTMLElement[] = [];
  const covers: { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; card: GameCard }[] = [];
  let habName: HTMLElement | null = null;
  let habInfo: HTMLElement | null = null;

  CARDS.forEach((c, i) => {
    const cv = pixelCanvas(COVER_W, COVER_H, 'sel-cover-canvas');
    covers.push({ ...cv, card: c });
    const stats = h('div', { class: 'sel-stats' });
    statEls.push(stats);
    const body = h('div', { class: 'sel-body' },
      h('div', { class: 'sel-name' }, c.name, c.tag ? h('span', { class: 'sel-tag' }, c.tag) : null),
      h('p', { class: 'sel-pitch' }, c.pitch),
      stats);
    if (c.id === 'catch' && channels.length) {
      habName = h('b', { class: 'sel-hab-name' }, '');
      habInfo = h('span', { class: 'sel-hab-info' }, '');
      const prev = h('button', { class: 'sel-hab-arrow l', type: 'button', tabindex: '-1', 'aria-label': 'Previous habitat' });
      const next = h('button', { class: 'sel-hab-arrow r', type: 'button', tabindex: '-1', 'aria-label': 'Next habitat' });
      prev.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); setCard(i); cycleHab(-1); });
      next.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); setCard(i); cycleHab(1); });
      body.append(h('div', { class: 'sel-hab' }, h('span', { class: 'sel-hab-lbl' }, 'HABITAT'), prev, habName, next), habInfo);
    }
    const el = h('div', { class: `sel-card c-${c.id}`, 'data-i': String(i) },
      h('div', { class: 'sel-cover' }, cv.canvas),
      body,
      h('div', { class: 'sel-go' }, h('span', { class: 'blink' }, 'PRESS A')));
    el.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      if (zone === 'cards' && i === cardIdx) activate();
      else { setCard(i); sound.sfx('select'); }
    });
    cardEls.push(el);
    track.append(el);
  });

  const arrowL = h('button', { class: 'sel-arrow l', type: 'button', tabindex: '-1', 'aria-label': 'Previous game' });
  const arrowR = h('button', { class: 'sel-arrow r', type: 'button', tabindex: '-1', 'aria-label': 'Next game' });
  arrowL.addEventListener('pointerdown', (e) => { e.preventDefault(); move(-1); });
  arrowR.addEventListener('pointerdown', (e) => { e.preventDefault(); move(1); });
  stage.append(arrowL, arrowR);

  // operator row
  interface Op { label: () => string; run: () => void }
  const OPS: Op[] = [
    { label: () => (account.state().mode === 'wallet' ? 'PLAYER W' : 'PLAYER'), run: () => launch({ name: 'player', back: 'arcade' }) },
    { label: () => 'THE AI TEST', run: () => launch({ name: 'ai-test' }) },
    { label: () => 'ABOUT', run: () => launch({ name: 'about' }) },
    { label: () => `SOUND ${settings.muted ? 'OFF' : 'ON'}`, run: () => { sound.setMuted(!settings.muted); saveSettings(); if (!settings.muted) sound.sfx('select'); renderOps(); } },
    { label: () => `CALM ${settings.calm ? 'ON' : 'OFF'}`, run: () => { settings.calm = !settings.calm; saveSettings(); cabinet()?.syncCalm(); root.classList.toggle('calm', settings.calm); sound.sfx('select'); renderOps(); } },
  ];
  const opEls = OPS.map((op, i) => {
    const b = h('button', { class: 'sel-op', type: 'button', tabindex: '-1' }, op.label());
    b.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      e.stopPropagation();
      zone = 'ops';
      opIdx = i;
      render();
      op.run();
    });
    return b;
  });
  const renderOps = () => opEls.forEach((b, i) => { b.textContent = OPS[i].label(); });
  const ops = h('div', { class: 'sel-ops' }, h('span', { class: 'sel-ops-lbl' }, 'OPERATOR'), ...opEls);

  const habCap = keycap('C', 'HABITAT', 'sel-habcap');
  const prompts = promptBar([[['LEFT', 'RIGHT'], 'CHOOSE'], ['A', 'PLAY'], ['B', 'EXIT']], 'sel-prompts');
  prompts.append(habCap);
  root.append(topBar('SELECT GAME', tix.el), stage, ops, prompts);
  root.classList.toggle('calm', settings.calm);
  app.root.append(root);
  music.theme('select');

  // ------------------------------------------------------------------ state
  let zone: 'cards' | 'ops' = 'cards';
  let cardIdx = 0;
  let opIdx = 0;
  let launching = false;
  let board: Board | null | undefined;

  function renderStats() {
    const lines: Record<CardId, string[]> = {
      micro: [microBest() ? `YOUR BEST ${commas(microBest())}` : 'NO SCORE YET', payoutLine('micro')],
      catch: (() => {
        const c = channels[hab];
        const best = c ? collection.bestFor(c.id) : collection.state.stats.bestScore;
        return [best ? `BEST HERE ${commas(best)}` : 'NO RUNS HERE YET', `BOOK ${collection.distinctCaught()}/${entries.length}`];
      })(),
      eyes: [
        board === undefined ? 'READING TODAY\'S BOARD' : board === null ? 'BOARD OFFLINE' : board.rows.length ? `TODAY'S TOP ${commas(board.rows[0].score)} ${board.rows[0].callsign}` : 'NO RANKED RUNS YET TODAY',
        payoutLine('eyes'),
      ],
      prizes: [`CAPSULES ${MACHINES.map((m) => m.price).join(' . ')}`, `YOU HAVE ${commas(tickets.balance())} TICKETS`],
      book: [`CAUGHT ${collection.distinctCaught()}/${entries.length}`, `SHINY ${collection.shinyIds().size}`],
    };
    CARDS.forEach((c, i) => {
      statEls[i].innerHTML = '';
      for (const l of lines[c.id]) statEls[i].append(h('span', {}, l));
    });
    if (habName && habInfo && channels[hab]) {
      const c = channels[hab];
      const locked = !isUnlocked(c, distinct);
      habName.textContent = c.name;
      habInfo.textContent = locked
        ? `LOCKED: CATCH ${c.unlockSpecies} KINDS (${Math.min(distinct, c.unlockSpecies)}/${c.unlockSpecies})`
        : `${channelCaught(c, caughtIds)}/${c.entries.length} CAUGHT HERE`;
      habInfo.classList.toggle('locked', locked);
    }
  }

  function render() {
    const n = CARDS.length;
    cardEls.forEach((el, i) => {
      let off = i - cardIdx;
      if (off > n / 2) off -= n;
      if (off < -n / 2) off += n;
      el.style.setProperty('--off', String(off));
      el.classList.toggle('sel', off === 0 && zone === 'cards');
      el.classList.toggle('cur', off === 0);
      el.classList.toggle('far', Math.abs(off) > 1);
    });
    opEls.forEach((b, i) => b.classList.toggle('sel', zone === 'ops' && i === opIdx));
    root.classList.toggle('zone-ops', zone === 'ops');
    habCap.hidden = !(CARDS[cardIdx].id === 'catch' && channels.length > 1 && zone === 'cards');
  }

  function setCard(i: number) {
    zone = 'cards';
    cardIdx = (i + CARDS.length) % CARDS.length;
    render();
  }

  function move(d: number) {
    if (launching) return;
    if (zone === 'cards') setCard(cardIdx + d);
    else { opIdx = (opIdx + d + OPS.length) % OPS.length; render(); }
    sound.sfx('select');
  }

  function cycleHab(d: number) {
    if (!channels.length) return;
    hab = (hab + d + channels.length) % channels.length;
    if (isUnlocked(channels[hab], distinct)) storeHabitat(channels[hab].id);
    sound.sfx('select');
    renderStats();
  }

  function launch(route: Route) {
    if (launching) return;
    launching = true;
    sound.sfx('start');
    root.classList.add('launching');
    window.setTimeout(() => app.go(route), settings.calm || reducedMotion() ? 0 : 260);
  }

  function activate() {
    if (launching) return;
    if (zone === 'ops') { OPS[opIdx].run(); return; }
    const c = CARDS[cardIdx];
    if (c.id === 'catch') {
      const ch = channels[hab];
      if (ch && !isUnlocked(ch, distinct)) { sound.sfx('denied'); cardEls[cardIdx].classList.remove('shake'); void cardEls[cardIdx].offsetWidth; cardEls[cardIdx].classList.add('shake'); return; }
      return launch(ch ? { name: 'hunt', channel: ch.id } : { name: 'hunt' });
    }
    const routes: Record<Exclude<CardId, 'catch'>, Route> = { micro: { name: 'micro' }, eyes: { name: 'broadcast' }, prizes: { name: 'prizes' }, book: { name: 'bestiary' } };
    launch(routes[c.id]);
  }

  // ------------------------------------------------------------------ covers
  const paint = () => covers.forEach(({ g, card }) => {
    g.clearRect(0, 0, COVER_W, COVER_H);
    card.cover(g, COVER_W, COVER_H);
  });
  paint();
  let gone = false;
  void loadAll(coverArt).then(() => { if (!gone) paint(); });

  void fetchBoard().then((b) => { board = b; if (!gone) renderStats(); });

  // ------------------------------------------------------------------ input
  let idle = 0;
  const bump = () => {
    clearTimeout(idle);
    idle = window.setTimeout(() => { if (!launching) app.go({ name: 'boot' }); }, IDLE_MS);
  };
  bump();
  const offAny = controls.onAny(bump);
  const onPtr = () => bump();
  root.addEventListener('pointerdown', onPtr, { capture: true });
  const offTix = tickets.subscribe(() => renderStats());

  const offKeys = bind({
    LEFT: () => move(-1),
    RIGHT: () => move(1),
    DOWN: () => { if (zone === 'cards') { zone = 'ops'; render(); sound.sfx('select'); } },
    UP: () => { if (zone === 'ops') { zone = 'cards'; render(); sound.sfx('select'); } },
    A: activate,
    START: activate,
    C: () => { if (zone === 'cards' && CARDS[cardIdx].id === 'catch') cycleHab(1); },
    B: () => { if (!launching) { sound.sfx('back'); app.go({ name: 'boot' }); } },
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !launching) { sound.sfx('back'); app.go({ name: 'boot' }); }
  };
  window.addEventListener('keydown', onKey);

  renderStats();
  render();

  return () => {
    gone = true;
    clearTimeout(idle);
    offAny();
    offKeys();
    offTix();
    tix.dispose();
    window.removeEventListener('keydown', onKey);
  };
}
