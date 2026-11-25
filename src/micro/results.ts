// MICRO MAYHEM results in the cabinet: cleared, best, speed, Beasts met, then the ticket payout
// printed as a strip out of the dispenser. [A]/START plays again, [B]/Escape goes back.
import type { RosterEntry } from '../data/roster.ts';
import { artCrop } from '../game/beasts.ts';
import { h } from '../ui/dom.ts';

export interface ResultsData {
  cleared: number;
  best: number;
  newBest: boolean;
  speed: string;
  met: RosterEntry[];
  bosses: number;
  /** Regular clears and the tickets they paid. */
  clears: number;
  clearPay: number;
  earned: number;
}

export interface ResultsHooks {
  again(): void;
  back(): void;
  /** One ticket segment printed (sound). */
  tick(): void;
}

export interface ResultsView {
  /** Route a cabinet button: A/START = again, B = back (the first press finishes the printing). */
  press(b: 'A' | 'B' | 'START' | 'ESC'): void;
  destroy(): void;
}

/** How the payout is printed: segment count and the counter value after each segment. */
export function printPlan(earned: number, maxSegments = 36): number[] {
  const n = Math.max(0, Math.floor(earned));
  if (!n) return [];
  const segs = Math.min(maxSegments, Math.max(1, Math.ceil(n / 10)));
  const out: number[] = [];
  for (let i = 1; i <= segs; i++) out.push(i === segs ? n : Math.round((n * i) / segs));
  return out;
}

export function showResults(parent: HTMLElement, d: ResultsData, hooks: ResultsHooks): ResultsView {
  const stat = (k: string, v: string, extra?: HTMLElement) => h('div', { class: 'mm-stat' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v), extra ?? null);
  const best = d.newBest ? h('span', { class: 'mm-tag' }, 'NEW BEST') : null;
  const met = h('div', { class: 'mm-met' });
  for (const e of d.met.slice(0, 14)) {
    const c = artCrop(e, 'art');
    c.title = e.name;
    met.append(h('span', { class: 'mm-thumb' }, c));
  }
  if (d.met.length > 14) met.append(h('span', { class: 'mm-more' }, `+${d.met.length - 14}`));

  const strip = h('div', { class: 'mm-strip' });
  const count = h('span', { class: 'n' }, '0');
  const total = h('div', { class: 'mm-total' }, count, h('span', { class: 'u' }, ' TICKETS'));
  const parts: string[] = [];
  if (d.clears) parts.push(`${d.clears} CLEAR${d.clears === 1 ? '' : 'S'} x SPEED = ${d.clearPay}`);
  if (d.bosses) parts.push(`${d.bosses} KING${d.bosses === 1 ? '' : 'S'} x 100 = ${d.bosses * 100}`);
  const breakdown = h('div', { class: 'mm-break' }, parts.length ? parts.join('  +  ') : 'CLEAR A GAME TO EARN TICKETS');
  const againBtn = h('button', { class: 'mm-btn a', type: 'button' }, h('i', {}, 'A'), ' PLAY AGAIN');
  const backBtn = h('button', { class: 'mm-btn b', type: 'button' }, h('i', {}, 'B'), ' BACK');

  const el = h('div', { class: 'mm-results' },
    h('div', { class: 'mm-card' },
      h('div', { class: 'mm-title' }, 'GAME OVER'),
      h('div', { class: 'mm-stats' },
        stat('CLEARED', String(d.cleared), best ?? undefined),
        stat('BEST', String(d.best)),
        stat('SPEED', d.speed),
        stat('BEASTS MET', String(d.met.length))),
      met,
      h('div', { class: 'mm-pay' },
        h('div', { class: 'mm-dispenser' }, h('span', { class: 'mm-slot' }), strip),
        total),
      breakdown,
      h('div', { class: 'mm-actions' }, againBtn, backBtn)));
  parent.append(el);

  const plan = printPlan(d.earned);
  let printed = 0;
  let timer = 0;
  const born = performance.now();
  const addSegment = () => {
    const seg = h('span', { class: 'mm-ticket' }, h('b', {}, 'BEAST'), h('b', {}, 'ARCADE'));
    strip.prepend(seg);
    while (strip.children.length > 40) strip.lastElementChild?.remove();
    count.textContent = String(plan[printed]);
    printed++;
    hooks.tick();
    if (printed >= plan.length) {
      total.classList.add('done');
      clearInterval(timer);
      timer = 0;
    }
  };
  const finish = () => {
    if (timer) clearInterval(timer);
    timer = 0;
    while (printed < plan.length) {
      const seg = h('span', { class: 'mm-ticket' }, h('b', {}, 'BEAST'), h('b', {}, 'ARCADE'));
      strip.prepend(seg);
      printed++;
    }
    while (strip.children.length > 40) strip.lastElementChild?.remove();
    count.textContent = String(d.earned);
    total.classList.add('done');
  };
  const startDelay = window.setTimeout(() => {
    if (!plan.length) {
      total.classList.add('done');
      return;
    }
    timer = window.setInterval(addSegment, plan.length > 20 ? 55 : 85);
  }, 650);

  const press = (b: 'A' | 'B' | 'START' | 'ESC') => {
    if (performance.now() - born < 600) return;
    if (b === 'B' || b === 'ESC') return hooks.back();
    if (printed < plan.length) return finish();
    hooks.again();
  };
  againBtn.addEventListener('click', () => press('A'));
  backBtn.addEventListener('click', () => press('B'));

  return {
    press,
    destroy() {
      clearTimeout(startDelay);
      if (timer) clearInterval(timer);
      el.remove();
    },
  };
}
