// PRIZE COUNTER: three gashapon machines. Spend tickets, turn the crank, a capsule drops, pop it
// and a Beast card goes into your book. Duplicates pay a quarter of the price back. The odds table
// is computed from the live roster by gacha.ts, so what it says is exactly what the machine does.
import type { App } from '../main.ts';
import { sound } from '../game/audio.ts';
import { music } from '../game/music.ts';
import { artistOf } from '../game/beasts.ts';
import { collection } from '../game/collection.ts';
import { dexIndex, dexLabel } from '../game/dex.ts';
import { settings } from '../game/settings.ts';
import { makeCard } from '../ui/card.ts';
import { h } from '../ui/dom.ts';
import { drawPrize, isDuplicate, machineOdds, MACHINES, pct, refundFor, speciesChance, THE_STATIC_ID, type MachineId, type Prize } from './gacha.ts';
import { drawMachine, MACHINE_H, MACHINE_W, PAL, setRes, type MachinePose } from './pixel.ts';
import { bind, commas, promptBar, reducedMotion, ticketReadout, topBar } from './ui.ts';
import { tickets } from './wallet.ts';

const VW = 184;
const VH = 92;
const GAP = 16;
const MX = Math.round((VW - 3 * MACHINE_W - 2 * GAP) / 2);
const MY = 12;
const CAP_COLOR: Record<MachineId, string> = { basic: PAL.cyan, rare: PAL.gold, legendary: PAL.hot };

type Phase = 'idle' | 'crank' | 'present' | 'reveal' | 'done';

export function prizesScreen(app: App) {
  const roster = app.roster;
  const dex = dexIndex(roster.entries);
  const calm = () => settings.calm || reducedMotion();

  let sel = 1;
  let phase: Phase = 'idle';
  let gone = false;
  const timers: number[] = [];
  const later = (fn: () => void, ms: number) => { timers.push(window.setTimeout(() => { if (!gone) fn(); }, calm() ? Math.min(ms, 60) : ms)); };

  // ------------------------------------------------------------------ DOM
  const tix = ticketReadout();
  const canvas = h('canvas', { class: 'prz-canvas' });
  const labels = MACHINES.map((m, i) => {
    const el = h('button', { class: `prz-label m-${m.id}`, type: 'button', tabindex: '-1' },
      h('b', {}, m.name), h('span', { class: 'prz-price' }, h('i', { class: 'scr-tix-ico', 'aria-hidden': 'true' }), String(m.price)));
    el.style.left = `${((MX + i * (MACHINE_W + GAP) + MACHINE_W / 2) / VW) * 100}%`;
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); pickOrTurn(i); });
    return el;
  });
  const msg = h('div', { class: 'prz-msg' });
  const rig = h('div', { class: 'prz-rig' }, canvas, ...labels);
  const floor = h('div', { class: 'prz-floor' }, rig, msg);
  const odds = h('div', { class: 'prz-odds' });
  const reveal = h('div', { class: 'prz-reveal' });
  reveal.hidden = true;
  const prompts = promptBar([[['LEFT', 'RIGHT'], 'PICK'], ['A', 'TURN'], ['B', 'BACK']], 'prz-prompts');
  const root = h('div', { class: 'prz' }, topBar('PRIZE COUNTER', tix.el), h('div', { class: 'prz-main' }, floor, odds), prompts, reveal);
  app.root.append(root);
  music.theme('prizes');

  // ------------------------------------------------------------------ odds panel
  function renderOdds() {
    const m = MACHINES[sel];
    const live = machineOdds(roster, m.id);
    const caught = collection.caughtIds();
    const kinds = new Set<number>();
    for (const o of live) for (const e of o.members) kinds.add(e.speciesId);
    let pNew = 0;
    for (const id of kinds) if (!caught.has(id)) pNew += speciesChance(live, id);
    const fresh = [...kinds].filter((id) => !caught.has(id)).length;
    odds.innerHTML = '';
    odds.className = `prz-odds m-${m.id}`;
    odds.append(
      h('div', { class: 'prz-odds-h' }, h('b', {}, `${m.name} CAPSULE`), h('span', {}, `${m.price} TICKETS`)),
      h('div', { class: 'prz-odds-rows' }, ...live.map((o) => h('div', { class: `prz-row${o.pool.id === 'static' ? ' static' : ''}` },
        h('span', { class: 'prz-pool' }, o.pool.label, h('small', {}, ` ${o.members.length} KIND${o.members.length === 1 ? '' : 'S'}`)),
        h('i', { class: 'prz-dots', 'aria-hidden': 'true' }),
        h('b', {}, pct(o.p))))),
      h('div', { class: 'prz-row' }, h('span', { class: 'prz-pool shiny' }, 'SHINY'), h('i', { class: 'prz-dots', 'aria-hidden': 'true' }), h('b', {}, `1 IN ${m.shinyOneIn}`)),
      h('div', { class: 'prz-row' }, h('span', { class: 'prz-pool' }, 'DUPLICATE PAYS BACK'), h('i', { class: 'prz-dots', 'aria-hidden': 'true' }), h('b', {}, String(refundFor(m.id)))),
      h('div', { class: 'prz-new' }, fresh ? `NEW CARD CHANCE ${pct(pNew)}  (${fresh} OF ${kinds.size} NOT IN YOUR BOOK)` : 'YOU HAVE EVERY CARD IN THIS MACHINE'));
    labels.forEach((l, i) => {
      l.classList.toggle('sel', i === sel);
      l.classList.toggle('short', tickets.balance() < MACHINES[i].price);
    });
  }

  // ------------------------------------------------------------------ the machines (pixel canvas)
  const poses: MachinePose[] = MACHINES.map(() => ({ knob: 0, shake: 0, t: 0, left: 11 }));
  let g: CanvasRenderingContext2D | null = null;
  const fit = () => {
    g = setRes(canvas, VW, VH);
    const fw = floor.clientWidth;
    const fh = floor.clientHeight;
    if (!fw || !fh) return;
    // Integer scale from 3x up (crisp); below that a fractional scale keeps the machines big.
    const s = Math.min(fw / VW, (fh * 0.84) / VH);
    const k = s >= 3 ? Math.floor(s) : s;
    canvas.style.width = `${Math.round(VW * k)}px`;
    canvas.style.height = `${Math.round(VH * k)}px`;
  };
  const ro = new ResizeObserver(fit);
  ro.observe(floor);
  fit();

  let raf = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (!g) return;
    g.fillStyle = PAL.screen;
    g.fillRect(0, 0, VW, VH);
    // back wall stripes and the counter top
    for (let x = 0; x < VW; x += 8) {
      g.fillStyle = ((x / 8) | 0) % 2 ? '#120808' : '#170a09';
      g.fillRect(x, 0, 8, MY + MACHINE_H - 6);
    }
    g.fillStyle = '#3a1f14';
    g.fillRect(0, MY + MACHINE_H - 6, VW, VH - (MY + MACHINE_H - 6));
    g.fillStyle = '#5e3420';
    g.fillRect(0, MY + MACHINE_H - 6, VW, 2);
    g.fillStyle = '#24130c';
    g.fillRect(0, VH - 4, VW, 4);
    MACHINES.forEach((m, i) => {
      const p = poses[i];
      p.t = now;
      p.lit = i === sel;
      const x = MX + i * (MACHINE_W + GAP);
      drawMachine(g!, x, MY, m.id, p);
      if (i === sel && phase === 'idle') {
        const bob = calm() ? 0 : Math.floor(now / 260) % 2;
        g!.fillStyle = PAL.gold;
        const ax = x + MACHINE_W / 2;
        for (let r = 0; r < 4; r++) g!.fillRect(ax - 3 + r, 2 + r + bob, 7 - r * 2, 1);
      }
    });
  };
  raf = requestAnimationFrame(frame);

  // ------------------------------------------------------------------ a turn
  let current: { prize: Prize; machine: MachineId; isNew: boolean; newShiny: boolean; dupe: boolean; refund: number } | null = null;
  let pendingRefund = 0;
  const flushRefund = () => {
    if (pendingRefund > 0) tickets.add(pendingRefund, 'refund');
    pendingRefund = 0;
  };

  const say = (text: string, bad = false) => {
    msg.textContent = text;
    msg.className = `prz-msg on${bad ? ' bad' : ''}`;
    clearTimeout(sayT);
    sayT = window.setTimeout(() => { msg.className = 'prz-msg'; }, 1800);
  };
  let sayT = 0;

  function pickOrTurn(i: number) {
    if (phase !== 'idle') return;
    if (i === sel) return turn();
    sel = i;
    sound.sfx('select');
    renderOdds();
  }

  function turn() {
    if (phase !== 'idle') return;
    const m = MACHINES[sel];
    const short = m.price - tickets.balance();
    if (short > 0) {
      sound.sfx('denied');
      say(`NEED ${commas(short)} MORE TICKETS. PLAY A GAME!`, true);
      labels[sel].classList.remove('shake');
      void labels[sel].offsetWidth;
      labels[sel].classList.add('shake');
      return;
    }
    const prize = drawPrize(roster, m.id);
    if (!prize || !tickets.spend(m.price, `capsule:${m.id}`)) { sound.sfx('denied'); return; }
    // Commit at once: leaving mid-animation never loses a paid prize.
    const res = collection.catch(prize.entry.speciesId, { type: prize.entry.type, shiny: prize.shiny, rare: prize.rare });
    const dupe = isDuplicate(res);
    current = { prize, machine: m.id, isNew: res.isNew, newShiny: res.newShiny, dupe, refund: dupe ? refundFor(m.id) : 0 };
    pendingRefund = current.refund;
    phase = 'crank';
    root.classList.add('busy');
    const p = poses[sel];
    const t0 = performance.now();
    const dur = calm() ? 200 : 1000;
    for (let k = 0; k < 3; k++) later(() => sound.sfx('crank'), k * 330);
    const spin = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      p.knob = k * Math.PI * 2;
      p.shake = k < 1 ? 1 : 0;
      if (k < 1 && !gone) requestAnimationFrame(spin);
    };
    requestAnimationFrame(spin);
    later(() => {
      p.left = Math.max(3, (p.left ?? 11) - 1);
      const d0 = performance.now();
      p.drop = { k: 0, color: capColor() };
      const fall = (now: number) => {
        if (!p.drop) return;
        p.drop.k = Math.min(1, (now - d0) / (calm() ? 60 : 420));
        if (p.drop.k < 1 && !gone) requestAnimationFrame(fall);
      };
      requestAnimationFrame(fall);
    }, 1000);
    later(() => sound.tray(), 1380);
    later(present, 1650);
  }

  const capColor = () => {
    if (!current) return PAL.cream;
    if (current.prize.entry.speciesId === THE_STATIC_ID) return '#161616';
    if (current.prize.shiny) return PAL.gold;
    return CAP_COLOR[current.machine];
  };

  // ------------------------------------------------------------------ the reveal
  let autoOpen = 0;
  function present() {
    if (!current) return;
    phase = 'present';
    poses[sel].drop = undefined;
    const c = current;
    const special = c.prize.shiny || c.prize.entry.featured || c.machine === 'legendary';
    reveal.innerHTML = '';
    reveal.className = `prz-reveal m-${c.machine}${c.prize.shiny ? ' shiny' : ''}${special ? ' special' : ''}${calm() ? ' calm' : ''}`;
    const cap = h('div', { class: 'prz-cap' }, h('i', { class: 'top' }), h('i', { class: 'bot' }), h('i', { class: 'band' }));
    cap.style.setProperty('--cap', capColor());
    const tap = h('div', { class: 'prz-tap blink' }, 'PRESS A TO OPEN');
    reveal.append(h('div', { class: 'prz-burst', 'aria-hidden': 'true' }), cap, tap);
    reveal.hidden = false;
    const wobbles = special ? 3 : 2;
    for (let i = 0; i < wobbles; i++) later(() => { cap.classList.remove('wob'); void cap.offsetWidth; cap.classList.add('wob'); sound.wobble(i); }, 420 + i * 520);
    autoOpen = window.setTimeout(() => open(), calm() ? 300 : 420 + wobbles * 520 + 700);
  }

  function open() {
    if (phase !== 'present' || !current) return;
    clearTimeout(autoOpen);
    phase = 'reveal';
    const c = current;
    const e = c.prize.entry;
    sound.sfx('pop');
    reveal.classList.add('open');
    reveal.querySelector('.prz-tap')?.remove();
    const tags = [c.isNew ? 'NEW' : '', c.prize.shiny ? 'SHINY' : '', c.dupe ? 'DUPE' : ''].filter(Boolean);
    const card = makeCard(e, { dex: dexLabel(dex.get(e.speciesId) ?? 0), state: 'caught', shiny: c.prize.shiny, tags });
    const lines = h('div', { class: 'prz-result' });
    const wrap = h('div', { class: 'prz-cardwrap' }, card);
    reveal.append(wrap, lines);
    later(() => sound.sfx('flip'), 140);
    later(() => {
      if (c.isNew || c.newShiny) {
        sound.sfx('win');
        if (c.prize.shiny) later(() => sound.sparkle(), 220);
      }
      const head = c.isNew ? 'NEW BEAST FOR YOUR BOOK!' : c.newShiny ? 'FIRST SHINY OF THIS BEAST!' : 'ALREADY IN YOUR BOOK';
      lines.append(h('div', { class: `prz-head${c.isNew || c.newShiny ? ' new' : ''}` }, head));
      lines.append(h('div', { class: 'prz-sub' }, `${e.name.toUpperCase()} . ${c.prize.pool.label}${e.featured ? ` . ART BY ${artistOf(e)}` : ''}`));
      if (c.dupe) {
        const n = c.refund;
        const refundEl = h('div', { class: 'prz-refund' }, `+${n} TICKETS BACK`);
        lines.append(refundEl);
        for (let i = 0; i < 5; i++) later(() => sound.sfx('ticket'), i * 70);
        flushRefund();
      }
      done();
    }, 520);
  }

  function done() {
    phase = 'done';
    renderOdds();
    const m = MACHINES[sel];
    const again = promptBar([['A', `AGAIN ${m.price}`], ['B', 'DONE']], 'prz-again');
    reveal.append(again);
  }

  function closeReveal() {
    flushRefund();
    reveal.hidden = true;
    reveal.innerHTML = '';
    phase = 'idle';
    current = null;
    root.classList.remove('busy');
    renderOdds();
  }

  // ------------------------------------------------------------------ input
  const back = () => { sound.sfx('back'); app.go({ name: 'arcade' }); };
  const offKeys = bind({
    LEFT: () => { if (phase === 'idle') { sel = (sel + 2) % 3; sound.sfx('select'); renderOdds(); } },
    RIGHT: () => { if (phase === 'idle') { sel = (sel + 1) % 3; sound.sfx('select'); renderOdds(); } },
    A: () => {
      if (phase === 'idle') turn();
      else if (phase === 'present') open();
      else if (phase === 'done') { closeReveal(); turn(); }
    },
    START: () => { if (phase === 'present') open(); else if (phase === 'done') closeReveal(); else if (phase === 'idle') turn(); },
    B: () => {
      if (phase === 'idle') back();
      else if (phase === 'present') open();
      else if (phase === 'done') closeReveal();
    },
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (phase === 'idle') back();
    else if (phase === 'done') closeReveal();
  };
  window.addEventListener('keydown', onKey);
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * VW;
    const i = Math.floor((vx - MX + GAP / 2) / (MACHINE_W + GAP));
    if (i >= 0 && i < 3) pickOrTurn(i);
  });
  reveal.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (phase === 'present') open();
    else if (phase === 'done') closeReveal();
  });
  const offTix = tickets.subscribe(() => renderOdds());

  renderOdds();

  return () => {
    gone = true;
    flushRefund();
    cancelAnimationFrame(raf);
    clearTimeout(autoOpen);
    clearTimeout(sayT);
    timers.forEach((t) => clearTimeout(t));
    ro.disconnect();
    offKeys();
    offTix();
    tix.dispose();
    window.removeEventListener('keydown', onKey);
  };
}
