// The cabinet: marquee, bezel, the 16:9 CRT screen (app.root), and the control panel with its
// joystick, A B C, START, the coin slot, the CREDITS / TICKETS counters and the player chip
// (callsign, a lit W for a wallet player; opens the PLAYER card). Built once.
// Layout is pure CSS (arcade.css): desktop cabinet scaled to the viewport, phone portrait
// (screen on top, panel below as the touch controller), phone landscape (stick left, buttons right).
import type { RosterEntry } from '../data/roster.ts';
import { account, type AccountState } from '../chain/account.ts';
import { artCrop } from '../game/beasts.ts';
import { settings } from '../game/settings.ts';
import { h } from '../ui/dom.ts';
import { controls, type Button } from './controls.ts';
import { tickets } from './wallet.ts';

// ------------------------------------------------------------------ credits (flavour: free play)

type CreditListener = (n: number) => void;

class Credits {
  private n = 0;
  private listeners = new Set<CreditListener>();
  count(): number {
    return this.n;
  }
  /** A coin went in. */
  add(): number {
    this.n = Math.min(99, this.n + 1);
    this.emit();
    return this.n;
  }
  /** Spend one if there is one. Free play: games start either way. */
  use(): boolean {
    if (this.n <= 0) return false;
    this.n--;
    this.emit();
    return true;
  }
  subscribe(fn: CreditListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of [...this.listeners]) fn(this.n);
  }
}

export const credits = new Credits();

// ------------------------------------------------------------------ cabinet

export interface Cabinet {
  el: HTMLElement;
  /** The CRT screen: `app.root`. */
  screen: HTMLElement;
  /** Quick stepped black flash when the picture changes (route change). */
  transition(): void;
  /** Put two Beasts on the marquee, either side of the title. */
  marqueeArt(left: RosterEntry | undefined, right: RosterEntry | undefined): void;
  /** Re-read settings.calm (bulbs stop chasing, no flashes). */
  syncCalm(): void;
  /** What a tap on the player chip does (main.ts opens the PLAYER card). */
  onPlayer(fn: () => void): void;
  /** Mid-game the chip is dimmed and ignores taps, so a stray touch never ends a run. */
  setPlayerLocked(locked: boolean): void;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let built: Cabinet | null = null;

/** The cabinet, once main.ts has built it (null in tests). */
export function cabinet(): Cabinet | null {
  return built;
}

/** Bulbs around the marquee, numbered clockwise so the chase runs round the sign. */
function bulbs(top: number, side: number): HTMLElement {
  const wrap = h('div', { class: 'cab-bulbs', 'aria-hidden': 'true' });
  let i = 0;
  const bulb = (edge: string, k: number) => {
    const b = h('i', { class: `bulb ${edge} c${i % 3}` });
    b.style.setProperty('--k', String(k));
    i++;
    return b;
  };
  for (let k = 0; k < top; k++) wrap.append(bulb('t', k));
  for (let k = 0; k < side; k++) wrap.append(bulb('r', k));
  for (let k = top - 1; k >= 0; k--) wrap.append(bulb('b', k));
  for (let k = side - 1; k >= 0; k--) wrap.append(bulb('l', k));
  wrap.style.setProperty('--top', String(top));
  wrap.style.setProperty('--side', String(side));
  return wrap;
}

function led(cls: string, label: string, digits: number): { el: HTMLElement; set(v: number): void } {
  const val = h('b', {}, '0'.repeat(digits));
  const el = h('div', { class: `cab-led ${cls}` },
    h('span', { class: 'cab-led-lbl' }, label),
    h('span', { class: 'cab-led-win' }, h('i', { class: 'ghost', 'aria-hidden': 'true' }, '8'.repeat(digits)), val));
  return {
    el,
    set(v: number) {
      val.textContent = String(Math.max(0, Math.min(10 ** digits - 1, Math.floor(v)))).padStart(digits, '0');
    },
  };
}

export function buildCabinet(host: HTMLElement): Cabinet {
  host.innerHTML = '';

  // ---- marquee
  const beastL = h('div', { class: 'cab-mq-beast l' });
  const beastR = h('div', { class: 'cab-mq-beast r' });
  const marquee = h('header', { class: 'cab-marquee' },
    bulbs(26, 3),
    h('div', { class: 'cab-mq-face' },
      beastL,
      h('div', { class: 'cab-mq-mid' },
        h('h1', { class: 'cab-title', 'aria-label': 'Beast Arcade' }, h('span', { class: 'w1' }, 'BEAST'), h('span', { class: 'w2' }, 'ARCADE')),
        h('div', { class: 'cab-strap' }, 'REAL BEASTS . REAL STARKNET . HUMAN PLAYERS ONLY')),
      beastR));

  // ---- bezel and CRT
  const screen = h('div', { class: 'cab-screen', id: 'screen' });
  const wipe = h('div', { class: 'cab-wipe', 'aria-hidden': 'true' });
  const crt = h('div', { class: 'cab-crt' }, screen, h('div', { class: 'cab-glass', 'aria-hidden': 'true' }), wipe);
  const bezel = h('div', { class: 'cab-bezel' }, crt, h('div', { class: 'cab-plate', 'aria-hidden': 'true' }, h('span', {}, '1 PLAYER . FREE PLAY')));

  // ---- player chip
  const chipName = h('b', { class: 'cab-pl-name' }, '');
  const chipW = h('i', { class: 'cab-pl-w', 'aria-hidden': 'true' }, 'W');
  const chip = h('button', { class: 'cab-pl', type: 'button', tabindex: '-1' }, h('span', { class: 'cab-pl-lbl' }, 'P1'), chipName, chipW);
  let openPlayer: (() => void) | null = null;
  chip.addEventListener('click', (e) => {
    e.preventDefault();
    if (!chip.classList.contains('locked')) openPlayer?.();
  });
  const paintChip = (s: AccountState) => {
    const wallet = s.mode === 'wallet';
    chipName.textContent = s.callsign;
    chipW.hidden = !wallet;
    chip.classList.toggle('wallet', wallet);
    const label = `Player ${s.callsign}, ${wallet ? 'wallet connected' : 'guest'}. Open the player card.`;
    chip.setAttribute('aria-label', label);
    chip.title = wallet ? `${s.callsign}: wallet player` : `${s.callsign}: guest player`;
  };
  paintChip(account.state());
  account.subscribe(paintChip);

  // ---- counters
  const credLed = led('credits', 'CREDITS', 2);
  const tixLed = led('tickets', 'TICKETS', 6);

  // ---- joystick
  const lever = h('div', { class: 'cab-lever' }, h('i', { class: 'shaft' }), h('i', { class: 'ball' }));
  const stick = h('div', { class: 'cab-stick', role: 'group', 'aria-label': 'Joystick' },
    h('div', { class: 'cab-stick-zone' }, h('i', { class: 'cab-stick-base' }), h('i', { class: 'cab-stick-dust' }), lever),
    h('span', { class: 'cab-lbl' }, 'MOVE'));

  // ---- buttons
  const btnEls = new Map<Button, HTMLElement>();
  const roundBtn = (b: 'A' | 'B' | 'C') => {
    const el = h('button', { class: `cab-btn k${b.toLowerCase()}`, type: 'button', tabindex: '-1', 'aria-label': `Button ${b}` },
      h('i', { class: 'rim' }), h('i', { class: 'cap' }), h('span', { class: 'cab-lbl' }, b));
    btnEls.set(b, el);
    return el;
  };
  const btns = h('div', { class: 'cab-btns' }, roundBtn('A'), roundBtn('B'), roundBtn('C'));
  const start = h('button', { class: 'cab-start', type: 'button', tabindex: '-1', 'aria-label': 'Start' }, h('i', { class: 'cap' }), h('span', { class: 'cab-lbl' }, 'START'));
  const coin = h('button', { class: 'cab-coin', type: 'button', tabindex: '-1', 'aria-label': 'Insert coin' },
    h('i', { class: 'plate' }, h('i', { class: 'slot' }), h('i', { class: 'lamp' })), h('span', { class: 'cab-lbl' }, 'COIN'));
  btnEls.set('START', start);
  btnEls.set('COIN', coin);
  const sys = h('div', { class: 'cab-sys' }, start, coin);

  const deckBg = h('div', { class: 'cab-deck', 'aria-hidden': 'true' });
  const el = h('div', { class: 'cab' }, marquee, bezel, deckBg, credLed.el, tixLed.el, chip, stick, btns, sys);
  host.append(el);

  // ---- pointer -> controls (multi-touch: every pointer owns what it presses)
  for (const [b, node] of btnEls) {
    const ptrs = new Set<number>();
    const up = (e: PointerEvent) => {
      if (!ptrs.delete(e.pointerId)) return;
      if (!ptrs.size) controls.release(b);
    };
    node.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      ptrs.add(e.pointerId);
      try { node.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      controls.press(b);
    });
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    node.addEventListener('lostpointercapture', up);
    node.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  const zone = stick.querySelector('.cab-stick-zone') as HTMLElement;
  const held = new Map<number, Set<Button>>();
  const dirsAt = (e: PointerEvent): Set<Button> => {
    const r = zone.getBoundingClientRect();
    const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const out = new Set<Button>();
    if (Math.hypot(dx, dy) < 0.28) return out;
    // 8-way: a diagonal within 22.5 degrees of 45 presses both directions.
    const a = Math.atan2(dy, dx) * (180 / Math.PI);
    const sector = Math.round(a / 45);
    const map: Record<number, Button[]> = {
      0: ['RIGHT'], 1: ['RIGHT', 'DOWN'], 2: ['DOWN'], 3: ['DOWN', 'LEFT'],
      4: ['LEFT'], [-4]: ['LEFT'], [-3]: ['LEFT', 'UP'], [-2]: ['UP'], [-1]: ['UP', 'RIGHT'],
    };
    for (const b of map[sector] ?? []) out.add(b);
    return out;
  };
  const applyDirs = (id: number, next: Set<Button>) => {
    const prev = held.get(id) ?? new Set<Button>();
    const others = new Set<Button>();
    for (const [pid, s] of held) if (pid !== id) for (const b of s) others.add(b);
    for (const b of prev) if (!next.has(b) && !others.has(b)) controls.release(b);
    for (const b of next) if (!prev.has(b)) controls.press(b);
    if (next.size) held.set(id, next);
    else held.delete(id);
  };
  zone.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { zone.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    held.set(e.pointerId, held.get(e.pointerId) ?? new Set());
    applyDirs(e.pointerId, dirsAt(e));
  });
  zone.addEventListener('pointermove', (e) => {
    if (held.has(e.pointerId)) applyDirs(e.pointerId, dirsAt(e));
  });
  const zoneUp = (e: PointerEvent) => {
    if (held.has(e.pointerId)) applyDirs(e.pointerId, new Set());
  };
  zone.addEventListener('pointerup', zoneUp);
  zone.addEventListener('pointercancel', zoneUp);
  zone.addEventListener('lostpointercapture', zoneUp);
  zone.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- lights: keyboard, mouse and touch all light the same parts
  const tilt = () => {
    const x = (controls.isDown('RIGHT') ? 1 : 0) - (controls.isDown('LEFT') ? 1 : 0);
    const y = (controls.isDown('DOWN') ? 1 : 0) - (controls.isDown('UP') ? 1 : 0);
    stick.style.setProperty('--jx', String(x));
    stick.style.setProperty('--jy', String(y));
    stick.classList.toggle('on', x !== 0 || y !== 0);
  };
  controls.onVisual((b, down) => {
    const node = btnEls.get(b);
    if (node) node.classList.toggle('on', down);
    else tilt();
  });

  // ---- counters
  credLed.set(credits.count());
  credits.subscribe((n) => {
    credLed.set(n);
    flash(credLed.el);
  });
  let shown = tickets.balance();
  let raf = 0;
  tixLed.set(shown);
  const roll = () => {
    const target = tickets.balance();
    const d = target - shown;
    if (d === 0) { raf = 0; return; }
    // Count like a ticket counter: fast for big payouts, one at a time near the end.
    const step = Math.sign(d) * Math.max(1, Math.floor(Math.abs(d) / 12));
    shown += step;
    tixLed.set(shown);
    raf = requestAnimationFrame(roll);
  };
  tickets.subscribe(() => {
    flash(tixLed.el);
    if (settings.calm || reducedMotion()) {
      shown = tickets.balance();
      tixLed.set(shown);
      return;
    }
    if (!raf) raf = requestAnimationFrame(roll);
  });

  function flash(node: HTMLElement) {
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }

  const syncCalm = () => el.classList.toggle('calm', settings.calm);
  syncCalm();

  // CRT warm-up on first light (clip-path in arcade.css, never a transform: screens measure
  // their own size when they mount).
  if (!settings.calm && !reducedMotion()) {
    crt.classList.add('warm');
    window.setTimeout(() => crt.classList.remove('warm'), 900);
  }

  built = {
    el,
    screen,
    transition() {
      if (settings.calm || reducedMotion()) return;
      wipe.classList.remove('go');
      void wipe.offsetWidth;
      wipe.classList.add('go');
    },
    marqueeArt(left, right) {
      beastL.innerHTML = '';
      beastR.innerHTML = '';
      if (left) beastL.append(artCrop(left));
      if (right) beastR.append(artCrop(right));
    },
    syncCalm,
    onPlayer(fn) {
      openPlayer = fn;
    },
    setPlayerLocked(locked) {
      chip.classList.toggle('locked', locked);
      chip.setAttribute('aria-disabled', String(locked));
    },
  };
  return built;
}
