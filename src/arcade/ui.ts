// Shared bits for the cabinet's own screens (attract, select, prizes, bestiary): on-screen key
// caps that press the real cabinet buttons (so a tap lights the panel too), the title bar, and a
// live ticket readout.
import { h } from '../ui/dom.ts';
import { controls, type Button } from './controls.ts';
import { tickets } from './wallet.ts';

const CAP_TEXT: Partial<Record<Button, string>> = { A: 'A', B: 'B', C: 'C', START: 'START', COIN: 'COIN' };

/** An arcade key cap and its label. Pressing it presses the cabinet button on the controls bus. */
export function keycap(b: Button, label: string, extra = ''): HTMLButtonElement {
  const dir = b === 'LEFT' || b === 'RIGHT' || b === 'UP' || b === 'DOWN';
  const cap = h('i', { class: `ak-cap${dir ? ` dir ${b.toLowerCase()}` : ''}` }, CAP_TEXT[b] ?? '');
  const el = h('button', { class: `ak ak-${b.toLowerCase()} ${extra}`.trim(), type: 'button', tabindex: '-1' }, cap, label ? h('span', { class: 'ak-lbl' }, label) : null);
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // The press may change screens and remove this cap, so the release is caught on the window.
    const id = e.pointerId;
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      controls.release(b);
    };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    controls.press(b);
  });
  el.addEventListener('click', (e) => e.stopPropagation());
  return el;
}

/** A row of key-cap prompts. A pair of directions shares one label: [['LEFT', 'RIGHT'], 'PICK']. */
export function promptBar(items: [Button | [Button, Button], string][], cls = ''): HTMLElement {
  const bar = h('div', { class: `ak-bar ${cls}`.trim() });
  for (const [b, label] of items) {
    if (Array.isArray(b)) {
      bar.append(h('span', { class: 'ak-pair' }, keycap(b[0], ''), keycap(b[1], label)));
    } else {
      bar.append(keycap(b, label));
    }
  }
  return bar;
}

/** A live TICKETS readout. */
export function ticketReadout(): { el: HTMLElement; dispose: () => void } {
  const num = h('b', {}, '');
  const el = h('span', { class: 'scr-tix' }, h('i', { class: 'scr-tix-ico', 'aria-hidden': 'true' }), num);
  const set = (v: number) => { num.textContent = String(v).padStart(5, '0'); };
  set(tickets.balance());
  const off = tickets.subscribe((v, d) => {
    set(v);
    el.classList.remove('up', 'down');
    void el.offsetWidth;
    el.classList.add(d >= 0 ? 'up' : 'down');
  });
  return { el, dispose: off };
}

/** Screen title bar: title on the left, anything on the right. */
export function topBar(title: string, ...right: (Node | string)[]): HTMLElement {
  return h('div', { class: 'scr-top' }, h('h1', { class: 'scr-title' }, title), h('div', { class: 'scr-right' }, ...right));
}

/** Subscribe several handlers at once; returns one cleanup. */
export function bind(map: Partial<Record<Button, () => void>>): () => void {
  const offs = (Object.entries(map) as [Button, () => void][]).map(([b, fn]) => controls.on(b, () => fn()));
  return () => offs.forEach((o) => o());
}

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** "12,340". */
export const commas = (n: number) => Math.floor(n).toLocaleString('en-US');
