// BEAST CATCH heads-up display: arcade DOM over the playfield. Values are written only when they
// change, so the 60 Hz loop never churns the DOM. Styles live in src/ui/catch.css (cx- classes).
import type { RosterEntry } from '../data/roster.ts';
import { h, pad } from '../ui/dom.ts';
import { artCrop } from './beasts.ts';
import { spriteThumb } from './sprites.ts';

export interface BannerAction {
  label: string;
  run: () => void;
  primary?: boolean;
}

export interface BannerOpts {
  sub?: string;
  art?: RosterEntry;
  lines?: string[];
  /** A highlighted line (the ticket payout). */
  prize?: string;
  /** The run paid nothing: the prize line is dimmed. */
  prizeNone?: boolean;
  hint?: string;
  cls?: string;
  actions?: BannerAction[];
}

const HEART = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];

/** A pixel heart as inline SVG (our own 7 x 6 bitmap, coloured by CSS currentColor). */
export function heartSvg(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 7 6');
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  HEART.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== 'X') return;
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', String(x));
      r.setAttribute('y', String(y));
      r.setAttribute('width', '1');
      r.setAttribute('height', '1');
      if (x === 1 && y === 1) r.setAttribute('class', 'shine');
      svg.appendChild(r);
    });
  });
  return svg;
}

/** A chunky progress meter. `gain` is the part just added (drawn in gold after the base). */
export function meter(frac: number, gain = 0, cls = ''): HTMLElement {
  const base = Math.max(0, Math.min(1, frac - gain));
  const g = Math.max(0, Math.min(1 - base, gain));
  return h('span', { class: `cx-meter ${cls}` },
    h('i', { class: 'base', style: `width:${(base * 100).toFixed(1)}%` }),
    h('i', { class: 'gain', style: `left:${(base * 100).toFixed(1)}%;width:${(g * 100).toFixed(1)}%` }));
}

/** Retrigger a one-shot CSS animation class. */
function pulse(el: Element, cls: string) {
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}

export class HuntHud {
  readonly el: HTMLElement;
  private scoreEl: HTMLElement;
  private hiEl: HTMLElement;
  private habEl: HTMLElement;
  private countEl: HTMLElement;
  readonly pauseBtn: HTMLButtonElement;
  private livesEl: HTMLElement;
  private hearts: HTMLElement[] = [];
  private jamEl: HTMLElement;
  private jamPips: HTMLElement[] = [];
  private warnEl: HTMLElement;
  private comboEl: HTMLElement;
  private comboNum: HTMLElement;
  private multEl: HTMLElement;
  private chainEl: HTMLElement;
  private slots: HTMLElement[] = [];
  private osdEl: HTMLElement;
  private feverEl: HTMLElement;
  private kingEl: HTMLElement;
  private kingSegsEl: HTMLElement;
  private kingSegs: HTMLElement[] = [];
  private captionEl: HTMLElement;
  private alertEl: HTMLElement;
  private shoutEl: HTMLElement;
  private bannerEl: HTMLElement;
  private cache = new Map<string, string>();
  private timers = new Map<string, number>();
  private lastCombo = 0;

  constructor(habitat: string, nSlots: number, lives: number) {
    this.scoreEl = h('b', {}, '000000');
    this.hiEl = h('div', { class: 'cx-hi' });
    const tl = h('div', { class: 'cx-tl' }, h('div', { class: 'cx-score' }, h('span', { class: 'cx-lbl' }, 'SCORE'), this.scoreEl), this.hiEl);

    this.habEl = h('div', { class: 'cx-habname' }, habitat);
    this.countEl = h('div', { class: 'cx-count' });
    this.pauseBtn = h('button', { class: 'cx-pause', 'aria-label': 'Pause', title: 'Pause (Esc)' }, h('i', {}), h('i', {}));
    const tr = h('div', { class: 'cx-tr' }, h('div', { class: 'cx-trtext' }, this.habEl, this.countEl), this.pauseBtn);

    const rail = h('div', { class: 'cx-rail', 'aria-hidden': 'true' });
    for (let i = 0; i < nSlots; i++) {
      const s = h('i', { class: i === nSlots - 1 ? 'king' : '' });
      this.slots.push(s);
      rail.append(s);
    }

    this.osdEl = h('div', { class: 'cx-osd' });
    this.osdEl.hidden = true;
    this.feverEl = h('div', { class: 'cx-fever' }, 'FEVER!');
    this.feverEl.hidden = true;
    this.kingSegsEl = h('span', { class: 'segs' });
    this.kingEl = h('div', { class: 'cx-kingbar' }, h('span', { class: 'kname' }, 'KING'), this.kingSegsEl);
    this.kingEl.hidden = true;

    this.livesEl = h('div', { class: 'cx-lives', title: 'Lives' });
    for (let i = 0; i < lives; i++) {
      const hEl = h('span', { class: 'heart on' });
      hEl.appendChild(heartSvg());
      this.hearts.push(hEl);
      this.livesEl.append(hEl);
    }
    this.jamEl = h('div', { class: 'cx-jam', title: 'Three misses in a row jam: -1 life' }, h('span', { class: 'cx-lbl' }, 'JAM'));
    for (let i = 0; i < 3; i++) {
      const p = h('i', {});
      this.jamPips.push(p);
      this.jamEl.append(p);
    }
    this.warnEl = h('div', { class: 'cx-warn' });
    this.warnEl.hidden = true;
    const bl = h('div', { class: 'cx-bl' }, this.warnEl, this.livesEl, this.jamEl);

    this.comboNum = h('b', {}, '0');
    this.multEl = h('span', { class: 'mult' });
    this.comboEl = h('div', { class: 'cx-combo' }, this.comboNum, h('span', { class: 'clbl' }, 'COMBO ', this.multEl));
    this.comboEl.hidden = true;
    this.chainEl = h('div', { class: 'cx-chain' });
    this.chainEl.hidden = true;
    const br = h('div', { class: 'cx-br' }, this.chainEl, this.comboEl);

    this.captionEl = h('div', { class: 'cx-caption' });
    this.captionEl.hidden = true;
    this.alertEl = h('div', { class: 'cx-alert' });
    this.alertEl.hidden = true;
    this.shoutEl = h('div', { class: 'cx-shout' });
    this.shoutEl.hidden = true;
    this.bannerEl = h('div', { class: 'cx-banner' });
    this.bannerEl.hidden = true;

    this.el = h('div', { class: 'cx-hud' }, tl, rail, tr, this.osdEl, this.feverEl, this.kingEl, this.alertEl, bl, br, this.captionEl, this.shoutEl, this.bannerEl);
  }

  private put(key: string, value: string): boolean {
    if (this.cache.get(key) === value) return false;
    this.cache.set(key, value);
    return true;
  }

  private later(key: string, ms: number, fn: () => void) {
    clearTimeout(this.timers.get(key));
    if (ms > 0) this.timers.set(key, window.setTimeout(fn, ms));
  }

  score(score: number, best: number) {
    if (this.put('score', String(score))) {
      this.scoreEl.textContent = pad(score, 6);
      if (score > 0) pulse(this.scoreEl, 'tick');
    }
    const b = best <= 0 ? (score > 0 ? 'FIRST RUN HERE' : '') : score > best ? 'NEW HI SCORE!' : `HI ${pad(best, 6)}`;
    if (this.put('best', b)) {
      this.hiEl.textContent = b;
      this.hiEl.hidden = !b;
      this.hiEl.classList.toggle('new', best > 0 && score > best);
    }
  }

  lives(n: number) {
    if (!this.put('lives', String(n))) return;
    this.hearts.forEach((el, i) => el.classList.toggle('on', i < n));
    this.livesEl.classList.toggle('low', n <= 1);
  }

  /** A life was lost: the hearts flash. */
  hurt() {
    pulse(this.livesEl, 'hurt');
  }

  /** Consecutive misses: three jam. */
  misses(n: number) {
    if (!this.put('misses', String(n))) return;
    this.jamPips.forEach((p, i) => p.classList.toggle('on', i < n));
    this.jamEl.classList.toggle('danger', n >= 2);
  }

  warn(text: string | null) {
    const t = text ?? '';
    if (!this.put('warn', t)) return;
    this.warnEl.textContent = t;
    this.warnEl.hidden = !t;
  }

  combo(n: number, mult: number, fever: boolean) {
    if (this.put('combo', `${n}|${fever}`)) {
      this.comboEl.hidden = n < 2;
      this.comboNum.textContent = String(n);
      this.multEl.textContent = `x${mult.toFixed(1)}`;
      this.comboEl.classList.toggle('hot', fever);
      if (n > this.lastCombo && n >= 2) pulse(this.comboEl, 'bump');
      this.lastCombo = n;
    }
  }

  chain(n: number, word: string, color: string) {
    const t = n >= 2 ? `${word} CHAIN x${n}` : '';
    if (!this.put('chain', t)) return;
    this.chainEl.textContent = t;
    this.chainEl.hidden = !t;
    this.chainEl.style.color = color;
    if (t) pulse(this.chainEl, 'bump');
  }

  kills(k: number, total: number) {
    if (this.put('kills', String(k))) this.countEl.textContent = `${k}/${total} CAUGHT`;
  }

  /** Where rail slot i is on screen (client px), for the card that flies into it. */
  slotRect(i: number): DOMRect | null {
    return this.slots[i]?.getBoundingClientRect() ?? null;
  }

  /** Rail slot i: the Beast's sprite if caught, a crossed-out slot if it fled. */
  slot(i: number, e: RosterEntry, got: boolean, shiny = false) {
    const s = this.slots[i];
    if (!s) return;
    s.innerHTML = '';
    s.classList.add(got ? 'got' : 'lost');
    s.classList.toggle('shiny', got && shiny);
    if (got) s.append(spriteThumb(e, shiny) ?? artCrop(e, shiny ? 'shiny' : 'art'));
  }

  osd(text: string, ms = 1500) {
    this.osdEl.textContent = text;
    this.osdEl.hidden = false;
    pulse(this.osdEl, 'in');
    this.later('osd', ms, () => { this.osdEl.hidden = true; });
  }

  fever(on: boolean) {
    this.feverEl.hidden = !on;
    this.el.classList.toggle('fevered', on);
  }

  king(hp: number, max: number) {
    if (this.kingSegs.length !== max) {
      this.kingSegsEl.innerHTML = '';
      this.kingSegs = Array.from({ length: max }, () => this.kingSegsEl.appendChild(h('i', {})));
    }
    if (!this.put('king', `${hp}/${max}`)) return;
    this.kingSegs.forEach((s, i) => s.classList.toggle('on', i < hp));
    if (!this.kingEl.hidden) pulse(this.kingEl, 'bump');
    this.kingEl.hidden = false;
  }

  kingHide() {
    this.kingEl.hidden = true;
  }

  /** The wild-encounter lower third. */
  caption(who: string, meta: string, cls = '', ms = 1500, color?: string) {
    const el = this.captionEl;
    el.className = `cx-caption ${cls}`;
    el.innerHTML = '';
    const whoEl = h('div', { class: 'who' }, who);
    el.append(whoEl, h('div', { class: 'meta' }, meta));
    if (color) el.style.setProperty('--tc', color);
    else el.style.removeProperty('--tc');
    el.hidden = false;
    pulse(el, 'in');
    this.later('caption', ms, () => { el.hidden = true; });
  }

  /** Rare, shiny and King alerts under the rail. */
  alert(text: string, sub: string, cls: string, ms = 1500) {
    const el = this.alertEl;
    el.className = `cx-alert ${cls}`;
    el.innerHTML = '';
    el.append(h('div', { class: 'alert-t' }, text), h('div', { class: 'alert-s' }, sub));
    el.hidden = false;
    pulse(el, 'in');
    this.later('alert', ms, () => { el.hidden = true; });
  }

  /** Big transient text in the middle of the screen. */
  shout(text: string, sub = '', cls = '', ms = 900) {
    const el = this.shoutEl;
    el.className = `cx-shout ${cls}`;
    el.innerHTML = '';
    el.append(h('div', { class: 'shout-t' }, text));
    if (sub) el.append(h('div', { class: 'shout-sub' }, sub));
    el.hidden = false;
    pulse(el, 'in');
    this.later('shout', ms, () => { el.hidden = true; });
  }

  banner(title: string, o: BannerOpts = {}) {
    const el = this.bannerEl;
    el.className = `cx-banner ${o.cls ?? ''}`;
    el.innerHTML = '';
    el.append(h('div', { class: 'banner-title' }, title));
    if (o.art) {
      const art = spriteThumb(o.art, false) ?? artCrop(o.art);
      art.classList.add('banner-art');
      el.append(art);
    }
    if (o.sub) el.append(h('div', { class: 'banner-sub' }, o.sub));
    for (const l of o.lines ?? []) el.append(h('div', { class: 'banner-line' }, l));
    if (o.prize) el.append(h('div', { class: `banner-prize${o.prizeNone ? ' none' : ''}` }, o.prize));
    if (o.actions?.length) {
      const row = h('div', { class: 'banner-actions' });
      for (const a of o.actions) {
        const b = h('button', { class: `cx-btn${a.primary ? ' primary' : ''}` }, a.label);
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => { e.stopPropagation(); b.blur(); a.run(); });
        row.append(b);
      }
      el.append(row);
    }
    if (o.hint) el.append(h('div', { class: 'banner-hint' }, o.hint));
    el.hidden = false;
    pulse(el, 'in');
  }

  hideBanner() {
    this.bannerEl.hidden = true;
  }

  /** Hide the transient overlays (used when the run ends). */
  quiet() {
    this.captionEl.hidden = true;
    this.shoutEl.hidden = true;
    this.alertEl.hidden = true;
    this.osdEl.hidden = true;
    this.warnEl.hidden = true;
    this.kingEl.hidden = true;
    this.feverEl.hidden = true;
    this.el.classList.add('ended');
  }

  destroy() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
