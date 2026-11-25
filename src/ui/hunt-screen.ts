// BEAST CATCH cabinet: the habitat select (route `hunt` with no habitat), then the run itself.
import type { App, Route } from '../main.ts';
import type { RosterEntry } from '../data/roster.ts';
import { controls, type Button } from '../arcade/controls.ts';
import { sound } from '../game/audio.ts';
import { pick } from '../game/beasts.ts';
import { channelById, channelCaught, channelRun, isUnlocked, type Channel, type ChannelId } from '../game/channels.ts';
import { collection } from '../game/collection.ts';
import { Hunt, randomSeed } from '../game/hunt.ts';
import { meter } from '../game/hud.ts';
import { settings } from '../game/settings.ts';
import { SpriteStage, wanderPos, type SpriteSpec } from '../game/sprites.ts';
import { h, pad } from './dom.ts';
import { howToPlay } from './primer.ts';
import './catch.css';

const LAST_KEY = 'beastarcade.catch.habitat';
const COLS = 3;

function lastHabitat(): ChannelId | null {
  try {
    return (localStorage.getItem(LAST_KEY) as ChannelId | null) ?? null;
  } catch {
    return null;
  }
}

function rememberHabitat(id: ChannelId) {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

export function huntScreen(app: App, route: Extract<Route, { name: 'hunt' }>) {
  if (route.channel) {
    const channel = channelById(app.channels, route.channel);
    if (isUnlocked(channel, collection.distinctCaught())) return playScreen(app, channel);
  }
  return selectScreen(app);
}

function playScreen(app: App, channel: Channel) {
  rememberHabitat(channel.id);
  const hunt = new Hunt(app.root, app.roster, channelRun(channel), randomSeed(), (outcome, next) => {
    if (next === 'retune') app.go({ name: 'hunt', channel: channel.id });
    else if (next === 'arcade') app.go({ name: 'arcade' });
    else app.go({ name: 'results', outcome });
  });
  return () => hunt.destroy();
}

/** A Beast from the habitat to stand on its card: one you caught if you have any, else any member. */
function mascot(c: Channel, caught: ReadonlySet<number>): RosterEntry | null {
  const fit = c.entries.filter((e) => e.w <= 60 && !e.maskWarning);
  const mine = fit.filter((e) => caught.has(e.speciesId));
  const pool = mine.length ? mine : fit;
  return pool.length ? pick(pool) : null;
}

function selectScreen(app: App) {
  const caught = collection.caughtIds();
  const distinct = caught.size;
  const channels = app.channels;
  const remembered = channels.findIndex((c) => c.id === lastHabitat());
  let sel = Math.max(0, remembered >= 0 && isUnlocked(channels[remembered], distinct) ? remembered : 0);
  let overlay: (() => void) | null = null;
  const stages: SpriteStage[] = [];
  const offs: (() => void)[] = [];

  const back = h('button', { class: 'cx-back' }, '< ARCADE');
  const howBtn = h('button', { class: 'cx-btn' }, '[C] HOW TO PLAY');
  const bookBtn = h('button', { class: 'cx-btn' }, '[B] BESTIARY');
  const grid = h('div', { class: 'cx-habs' });
  const cards = channels.map((c, i) => {
    const locked = !isUnlocked(c, distinct);
    const n = channelCaught(c, caught);
    const best = collection.bestFor(c.id);
    const box = h('div', { class: 'cx-hab-view' });
    const card = h('button', { class: `cx-hab${locked ? ' locked' : ''}`, 'data-i': String(i) },
      box,
      h('div', { class: 'cx-hab-name' }, c.name),
      locked
        ? h('div', { class: 'cx-hab-lock' }, `LOCKED . CATCH ${c.unlockSpecies} SPECIES`, h('span', {}, ` ${Math.min(distinct, c.unlockSpecies)}/${c.unlockSpecies}`))
        : h('div', { class: 'cx-hab-meta' }, h('span', {}, `${n}/${c.entries.length}`), h('span', { class: 'hi' }, best > 0 ? `HI ${pad(best, 6)}` : 'NEW'), meter(c.entries.length ? n / c.entries.length : 0, 0, n === c.entries.length ? 'done' : '')),
      h('div', { class: 'cx-hab-lore' }, c.lore));
    if (locked) box.append(h('div', { class: 'cx-hab-padlock' }, '?'));
    const e = mascot(c, caught);
    const stage = new SpriteStage(box, { habitat: c.id, fieldW: 160, fieldH: 90, className: 'cx-mini' });
    stages.push(stage);
    const phase = (i * 0.37) % 1;
    stage.start(() => {}, (tick): SpriteSpec[] => {
      if (!e || tick < 0 || locked) return [];
      const { px, py } = wanderPos(e.type, tick, e.w, e.h, 160, 90, phase);
      return [{ key: i, entry: e, px, py, age: tick, left: 999, shiny: false, king: c.id === 'king', hp: 1, maxHp: 1, hitAt: -Infinity, phase }];
    });
    card.addEventListener('pointerenter', () => setSel(i));
    card.addEventListener('click', () => { setSel(i, true); play(); });
    grid.append(card);
    return card;
  });

  const daily = collection.daily();
  const wrap = h('div', { class: 'cx cx-select' },
    h('div', { class: 'cx-select-head' }, back,
      h('div', { class: 'cx-logo' }, h('span', { class: 'a' }, 'BEAST'), h('span', { class: 'b' }, 'CATCH')),
      h('div', { class: 'cx-select-tag' }, 'Catch wild Beasts before they flee. Pick a habitat.')),
    grid,
    h('div', { class: 'cx-select-foot' },
      h('div', { class: `cx-goal${daily.done ? ' done' : ''}` }, h('span', { class: 'lbl' }, 'TODAY'), h('span', {}, daily.goal.text), h('b', {}, daily.done ? 'DONE' : `${daily.progress}/${daily.goal.target}`)),
      h('div', { class: 'cx-select-btns' }, howBtn, bookBtn),
      h('div', { class: 'cx-select-keys' }, h('b', {}, 'ARROWS'), ' choose  ', h('b', {}, 'A'), ' play  ', h('b', {}, 'ESC'), ' arcade')));
  app.root.append(wrap);

  function setSel(i: number, quiet = false) {
    const n = Math.max(0, Math.min(cards.length - 1, i));
    if (n !== sel && !quiet) sound.sfx('select');
    sel = n;
    cards.forEach((c, k) => c.classList.toggle('sel', k === sel));
  }
  setSel(sel, true);

  function play() {
    if (overlay) return;
    const c = channels[sel];
    if (!isUnlocked(c, distinct)) {
      sound.sfx('denied');
      cards[sel].classList.remove('nope');
      void cards[sel].offsetWidth;
      cards[sel].classList.add('nope');
      return;
    }
    sound.sfx('start');
    app.go({ name: 'hunt', channel: c.id });
  }

  function openHowTo() {
    if (overlay) return;
    sound.sfx('select');
    overlay = howToPlay(wrap, app.roster, () => closeHowTo(), () => closeHowTo());
  }
  function closeHowTo() {
    const o = overlay;
    overlay = null;
    o?.();
  }

  const move = (b: Button) => {
    if (overlay) return;
    const d = b === 'LEFT' ? -1 : b === 'RIGHT' ? 1 : b === 'UP' ? -COLS : COLS;
    setSel(sel + d);
  };
  const shownAt = performance.now();
  const fresh = () => performance.now() - shownAt < 250;
  offs.push(
    controls.on('LEFT', move), controls.on('RIGHT', move), controls.on('UP', move), controls.on('DOWN', move),
    controls.on('A', () => { if (!overlay && !fresh()) play(); }),
    controls.on('START', () => { if (!overlay && !fresh()) play(); }),
    controls.on('C', () => openHowTo()),
    controls.on('B', () => { if (!overlay) app.go({ name: 'bestiary' }); }),
  );
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || overlay) return;
    if (e.key === 'Escape') { sound.sfx('back'); app.go({ name: 'arcade' }); }
    else if (e.key === 'h' || e.key === 'H') openHowTo();
  };
  window.addEventListener('keydown', onKey);
  back.addEventListener('click', () => { sound.sfx('back'); app.go({ name: 'arcade' }); });
  howBtn.addEventListener('click', () => openHowTo());
  bookBtn.addEventListener('click', () => app.go({ name: 'bestiary' }));
  if (!settings.primerSeen) openHowTo();

  return () => {
    overlay?.();
    overlay = null;
    window.removeEventListener('keydown', onKey);
    offs.forEach((f) => f());
    stages.forEach((s) => s.stop());
  };
}
