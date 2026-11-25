// The BESTIARY: an open book. Left page, a numbered grid of every species in roster order (24 to a
// page); right page, the selected Beast. Unseen Beasts are dark "???" tiles, seen ones a silhouette,
// caught ones their full art (gold when shiny). Catches verified onchain carry a cyan badge.
import type { App } from '../main.ts';
import type { RosterEntry } from '../data/roster.ts';
import { assetUrl } from '../data/roster.ts';
import { fetchOnchainDex } from '../chain/dex.ts';
import { guest } from '../chain/guest.ts';
import { bind, promptBar, ticketReadout, topBar } from '../arcade/ui.ts';
import { sound } from '../game/audio.ts';
import { music } from '../game/music.ts';
import { artCrop, artistOf, MOTION, typeName } from '../game/beasts.ts';
import { channelsOf } from '../game/channels.ts';
import { collection } from '../game/collection.ts';
import { dexIndex, dexLabel, onchainView, type OnchainView } from '../game/dex.ts';
import { makeCard, type CardState } from './card.ts';
import { h } from './dom.ts';

const COLS = 6;
const ROWS = 4;
const PER = COLS * ROWS;

interface Filter { id: string; label: string; test: (e: RosterEntry) => boolean }

const FILTERS: Filter[] = [
  { id: 'all', label: 'ALL', test: () => true },
  { id: 'hack', label: 'ART HACKATHON', test: (e) => e.featured },
  { id: 'magic', label: 'MAGIC', test: (e) => e.type === 0 },
  { id: 'hunter', label: 'HUNTER', test: (e) => e.type === 1 },
  { id: 'brute', label: 'BRUTE', test: (e) => e.type === 2 },
];

export function bestiaryScreen(app: App, route: { focus?: number }) {
  const all: RosterEntry[] = [...app.roster.entries];
  const dex = dexIndex(all);
  const total = all.length;
  let fi = 0;
  let list = all;
  let sel = Math.max(0, all.findIndex((e) => e.speciesId === route.focus));
  let onchain: OnchainView | null = null;
  let zoomed = false;
  let gone = false;

  const stateOf = (e: RosterEntry): CardState => (collection.isCaught(e.speciesId) ? 'caught' : collection.isSeen(e.speciesId) ? 'seen' : 'unseen');
  const shinyOf = (e: RosterEntry) => (collection.state.species[e.speciesId]?.shiny ?? 0) > 0;

  // ------------------------------------------------------------------ DOM
  const tix = ticketReadout();
  const caughtChip = h('span', { class: 'bk-chip' });
  const shinyChip = h('span', { class: 'bk-chip gold' });
  const chainChip = h('span', { class: 'bk-chip cyan', title: 'Species caught in verified ranked HUMAN EYES runs' });
  chainChip.hidden = true;
  const tabEls = FILTERS.map((f, i) => {
    const b = h('button', { class: 'bk-tab', type: 'button', tabindex: '-1' }, h('span', {}, f.label), h('small', {}, ''));
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); setFilter(i); });
    return b;
  });
  const pageLbl = h('span', { class: 'bk-pagelbl' });
  const pgPrev = h('button', { class: 'bk-pg l', type: 'button', tabindex: '-1', 'aria-label': 'Previous page' });
  const pgNext = h('button', { class: 'bk-pg r', type: 'button', tabindex: '-1', 'aria-label': 'Next page' });
  pgPrev.addEventListener('pointerdown', (e) => { e.preventDefault(); turnPage(-1); });
  pgNext.addEventListener('pointerdown', (e) => { e.preventDefault(); turnPage(1); });
  const grid = h('div', { class: 'bk-grid' });
  const detail = h('div', { class: 'bk-detail' });
  const zoom = h('div', { class: 'bk-zoom' });
  zoom.hidden = true;
  zoom.addEventListener('pointerdown', (e) => { e.preventDefault(); closeZoom(); });
  const root = h('div', { class: 'bk' },
    topBar('BESTIARY', caughtChip, shinyChip, chainChip, tix.el),
    h('div', { class: 'bk-tabs' }, ...tabEls, h('span', { class: 'bk-pager' }, pgPrev, pageLbl, pgNext)),
    h('div', { class: 'bk-book' },
      h('div', { class: 'bk-page left' }, grid),
      h('div', { class: 'bk-spine', 'aria-hidden': 'true' }),
      h('div', { class: 'bk-page right' }, detail)),
    promptBar([[['LEFT', 'RIGHT'], 'MOVE'], ['C', 'FILTER'], ['A', 'CARD'], ['B', 'BACK']], 'bk-prompts'),
    zoom);
  app.root.append(root);
  music.theme('select');

  function renderCounts() {
    caughtChip.textContent = `CAUGHT ${collection.distinctCaught()}/${total}`;
    shinyChip.textContent = `SHINY ${collection.shinyIds().size}`;
    const caught = collection.caughtIds();
    FILTERS.forEach((f, i) => {
      const members = all.filter(f.test);
      (tabEls[i].lastChild as HTMLElement).textContent = ` ${members.filter((e) => caught.has(e.speciesId)).length}/${members.length}`;
      tabEls[i].classList.toggle('on', i === fi);
    });
    if (onchain) {
      chainChip.textContent = `ONCHAIN ${onchain.caught.size}/${total}`;
      chainChip.hidden = false;
    }
  }

  // ------------------------------------------------------------------ grid
  const page = () => Math.floor(sel / PER);
  const pages = () => Math.max(1, Math.ceil(list.length / PER));
  let shownPage = -1;
  let tiles: HTMLElement[] = [];

  function buildPage(dir = 0) {
    const p = page();
    shownPage = p;
    grid.innerHTML = '';
    tiles = [];
    for (let k = 0; k < PER; k++) {
      const i = p * PER + k;
      const e = list[i];
      if (!e) {
        grid.append(h('div', { class: 'bk-tile empty', 'aria-hidden': 'true' }));
        continue;
      }
      const st = stateOf(e);
      const shiny = st === 'caught' && shinyOf(e);
      const verified = onchain?.caught.has(e.speciesId) ?? false;
      const t = h('button', { class: `bk-tile ${st} t${e.tier}${shiny ? ' shiny' : ''}${verified ? ' verified' : ''}${e.featured ? ' hack' : ''}`, type: 'button', tabindex: '-1', 'aria-label': st === 'unseen' ? 'Unknown Beast' : e.name },
        h('span', { class: 'n' }, dexLabel(dex.get(e.speciesId) ?? 0).slice(1)),
        st === 'unseen' ? h('span', { class: 'q' }, '???') : artCrop(e, st === 'seen' ? 'silhouette' : shiny ? 'shiny' : 'art'));
      t.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        if (i === sel) openZoom();
        else { sound.sfx('select'); select(i); }
      });
      tiles[k] = t;
      grid.append(t);
    }
    pageLbl.textContent = `PAGE ${p + 1}/${pages()}`;
    pgPrev.disabled = p === 0;
    pgNext.disabled = p >= pages() - 1;
    if (dir) {
      grid.classList.remove('flip-l', 'flip-r');
      void grid.offsetWidth;
      grid.classList.add(dir < 0 ? 'flip-l' : 'flip-r');
    }
  }

  // ------------------------------------------------------------------ detail page
  function renderDetail() {
    const e = list[sel];
    detail.innerHTML = '';
    if (!e) {
      detail.append(h('p', { class: 'bk-empty' }, 'NO BEASTS HERE YET.'));
      return;
    }
    const st = stateOf(e);
    const rec = collection.state.species[e.speciesId];
    const shiny = st === 'caught' && shinyOf(e);
    const verified = onchain?.caught.has(e.speciesId) ?? false;
    const known = st !== 'unseen';

    const art = h('div', { class: `bk-d-art ${st} t${e.tier}${shiny ? ' shiny' : ''}` });
    if (st === 'caught' && e.frames > 1 && e.gif) art.append(h('img', { src: assetUrl(e.gif), alt: e.name, class: shiny ? 'gold' : '' }));
    else if (known) art.append(artCrop(e, st === 'seen' ? 'silhouette' : shiny ? 'shiny' : 'art'));
    else art.append(h('span', { class: 'q' }, '???'));

    const tags = h('div', { class: 'bk-d-tags' });
    if (known) tags.append(h('span', { class: `bk-tag ${e.featured ? 'hack' : 'orig'}` }, e.featured ? 'ART HACKATHON' : 'LOOT SURVIVOR'));
    if (shiny) tags.append(h('span', { class: 'bk-tag gold' }, 'SHINY'));
    if (verified) tags.append(h('span', { class: 'bk-tag cyan' }, 'ONCHAIN'));

    const rows: [string, string][] = [];
    if (known) {
      rows.push(['TYPE', `${typeName(e.type).toUpperCase()} . ${MOTION[e.type]}`]);
      rows.push(['TIER', `T${e.tier} ${'#'.repeat(6 - e.tier)}${'.'.repeat(e.tier - 1)}`]);
      rows.push(['ARTIST', artistOf(e)]);
      rows.push(['CAUGHT', st === 'caught' ? `x${rec?.caught ?? 0}${(rec?.shiny ?? 0) > 0 ? `  (SHINY x${rec?.shiny})` : ''}` : 'NOT YET']);
      if (st === 'caught' && rec?.firstCaught && rec.firstCaught > 1000) {
        rows.push(['FIRST', new Date(rec.firstCaught).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()]);
      }
      const hab = channelsOf(app.channels, e.speciesId).map((c) => c.name);
      if (hab.length) rows.push(['HABITAT', hab.slice(0, 2).join(' . ')]);
    }
    if (onchain) rows.push(['ONCHAIN', verified ? 'VERIFIED CATCH' : 'NOT YET']);

    const table = h('div', { class: 'bk-d-rows' });
    for (const [k, v] of rows) table.append(h('span', { class: 'k' }, k), h('span', { class: 'v' }, v));

    detail.append(
      art,
      h('div', { class: 'bk-d-head' },
        h('span', { class: 'bk-d-n' }, dexLabel(dex.get(e.speciesId) ?? 0)),
        h('span', { class: 'bk-d-name' }, known ? e.name.toUpperCase() : '???')),
      tags,
      table);
    if (st === 'caught' && e.description) detail.append(h('p', { class: 'bk-d-desc' }, e.description));
    if (st === 'seen') detail.append(h('p', { class: 'bk-d-desc' }, 'Seen, not caught. Catch it in BEAST CATCH or win it at the PRIZE COUNTER.'));
    if (st === 'unseen') detail.append(h('p', { class: 'bk-d-desc' }, 'Not seen yet. Play BEAST CATCH or try a capsule at the PRIZE COUNTER.'));
  }

  function select(i: number) {
    if (!list.length) { buildPage(); renderDetail(); return; }
    const before = shownPage;
    sel = Math.max(0, Math.min(list.length - 1, i));
    const p = page();
    if (p !== before) buildPage(p - before);
    tiles.forEach((t, k) => t?.classList.toggle('sel', p * PER + k === sel));
    renderDetail();
  }

  function setFilter(i: number) {
    const keep = list[sel]?.speciesId;
    fi = (i + FILTERS.length) % FILTERS.length;
    list = all.filter(FILTERS[fi].test);
    const at = list.findIndex((e) => e.speciesId === keep);
    sel = at >= 0 ? at : 0;
    sound.sfx('select');
    renderCounts();
    buildPage();
    select(sel);
  }

  function turnPage(d: number) {
    const p = page() + d;
    if (p < 0 || p >= pages()) { sound.sfx('denied'); return; }
    sound.sfx('flip');
    select(Math.min(list.length - 1, p * PER + (sel % PER)));
  }

  function moveSel(dx: number, dy: number) {
    if (!list.length) return;
    const k = sel % PER;
    const col = k % COLS;
    const row = Math.floor(k / COLS);
    const p = page();
    if (dx < 0) {
      if (col > 0) select(sel - 1);
      else if (p > 0) { sound.sfx('flip'); select(Math.min(list.length - 1, (p - 1) * PER + row * COLS + COLS - 1)); return; }
      else return;
    } else if (dx > 0) {
      if (col < COLS - 1 && sel + 1 < list.length) select(sel + 1);
      else if (p < pages() - 1) { sound.sfx('flip'); select(Math.min(list.length - 1, (p + 1) * PER + row * COLS)); return; }
      else return;
    } else if (dy < 0) {
      if (row > 0) select(sel - COLS);
      else return;
    } else if (dy > 0) {
      if (row < ROWS - 1 && sel + COLS < list.length) select(sel + COLS);
      else return;
    }
    sound.sfx('select');
  }

  // ------------------------------------------------------------------ the card, big
  function openZoom() {
    const e = list[sel];
    if (!e) return;
    const st = stateOf(e);
    zoom.innerHTML = '';
    const shiny = st === 'caught' && shinyOf(e);
    const tags = [shiny ? 'SHINY' : '', onchain?.caught.has(e.speciesId) ? 'ONCHAIN' : ''].filter(Boolean);
    zoom.append(makeCard(e, { dex: dexLabel(dex.get(e.speciesId) ?? 0), state: st, shiny, tags }), h('div', { class: 'bk-zoom-hint' }, 'PRESS A OR B'));
    zoom.hidden = false;
    zoomed = true;
    sound.sfx('flip');
  }
  function closeZoom() {
    zoom.hidden = true;
    zoomed = false;
  }

  // ------------------------------------------------------------------ onchain badge
  void (async () => {
    try {
      const d = await fetchOnchainDex('0x' + guest.pub.toString(16));
      if (gone || !d) return;
      onchain = onchainView(app.roster, d);
      renderCounts();
      buildPage();
      select(sel);
    } catch {
      /* offchain or unreachable: no badge */
    }
  })();

  // ------------------------------------------------------------------ input
  const back = () => { sound.sfx('back'); app.go({ name: 'arcade' }); };
  const offKeys = bind({
    LEFT: () => { if (!zoomed) moveSel(-1, 0); },
    RIGHT: () => { if (!zoomed) moveSel(1, 0); },
    UP: () => { if (!zoomed) moveSel(0, -1); },
    DOWN: () => { if (!zoomed) moveSel(0, 1); },
    A: () => { if (zoomed) closeZoom(); else openZoom(); },
    C: () => { if (!zoomed) setFilter(fi + 1); },
    B: () => { if (zoomed) closeZoom(); else back(); },
    START: () => { if (zoomed) closeZoom(); else openZoom(); },
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') { e.preventDefault(); if (zoomed) closeZoom(); else back(); }
    else if (e.key === 'PageDown' || e.key === ']') { e.preventDefault(); turnPage(1); }
    else if (e.key === 'PageUp' || e.key === '[') { e.preventDefault(); turnPage(-1); }
  };
  window.addEventListener('keydown', onKey);
  // A swipe across the book turns the page on touch screens.
  let swipeX: number | null = null;
  grid.addEventListener('pointerdown', (e) => { swipeX = e.clientX; }, { capture: true });
  grid.addEventListener('pointerup', (e) => {
    if (swipeX === null) return;
    const dx = e.clientX - swipeX;
    swipeX = null;
    if (Math.abs(dx) > grid.clientWidth * 0.25) turnPage(dx < 0 ? 1 : -1);
  });
  renderCounts();
  buildPage();
  select(sel);

  return () => {
    gone = true;
    offKeys();
    tix.dispose();
    window.removeEventListener('keydown', onKey);
  };
}
