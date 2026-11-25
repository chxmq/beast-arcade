// HUMAN EYES (ranked) playback. The client receives only pixels: pre-rendered tape frames streamed
// by the server, at most 2.5 s ahead of playback. One input: a click or tap strikes where it
// points (keys fire at the cursor). Strikes get a local ripple and nothing else (any hit feedback
// would be a label oracle for a bot). The Trigger always waits the after-miss gap, so the log is
// valid whatever the strikes hit. The log is signed and submitted at the end; the contract
// replays it against the revealed seed.

import type { StartResponse, StatusResponse, SubmitResponse } from '../broadcast/api.ts';
import { FRAME_BYTES, SEG_MS, segmentCount, TAPE_H, TAPE_W, unpackFrame } from '../broadcast/tape.ts';
import { hex } from '../broadcast/hashes.ts';
import { Trigger } from '../broadcast/trigger.ts';
import { guest, randomNonce, runMessage } from '../chain/guest.ts';
import { NoiseField } from '../render/field.ts';
import { MAX_STRIKES } from '../sim/spec.ts';
import { h, pad, timecode } from '../ui/dom.ts';
import { sound } from './audio.ts';
import { TapeTv } from './tape-tv.ts';

// ---------------------------------------------------------------------------------- API

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T & { error?: string } }> {
  const res = await fetch(`/api/broadcast/${path}`, init);
  let body: T & { error?: string };
  try {
    body = await res.json();
  } catch {
    body = { error: `HTTP ${res.status}` } as T & { error?: string };
  }
  return { status: res.status, body };
}

export async function fetchStatus(): Promise<StatusResponse | null> {
  try {
    const { status, body } = await api<StatusResponse>('status');
    return status === 200 ? body : null;
  } catch {
    return null;
  }
}

export interface Ticketed {
  start: StartResponse;
  /** Signed nonce (server-mixed). */
  nonce: bigint;
  /** performance.now() domain time at which frame 0 plays. */
  playStart: number;
}

/** POST /start, retrying while no free tape was drawn. */
export async function startTape(): Promise<Ticketed> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const nonce = randomNonce();
    const sent = performance.now();
    const { status, body } = await api<StartResponse>('start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pub: hex(guest.pub), nonce: hex(nonce) }),
    });
    const recv = performance.now();
    if (status === 409) continue;
    if (status !== 200) throw new Error(body.error ?? `HTTP ${status}`);
    // Server time at `recv` is about body.now + rtt / 2.
    const playStart = recv + (body.t0 - (body.now + (recv - sent) / 2));
    return { start: body, nonce: BigInt(body.nonce), playStart };
  }
  throw new Error('no free tape, try again');
}

export async function submitRun(t: Ticketed, callsign: string, strikes: number[]): Promise<SubmitResponse> {
  const sig = guest.sign(runMessage(t.start.rootId, t.start.k, t.nonce, callsign, strikes));
  const { status, body } = await api<SubmitResponse>('submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: t.start.ticket, callsign, strikes, sig }),
  });
  if (status !== 200) throw new Error(body.error ?? `HTTP ${status}`);
  return body;
}

// ---------------------------------------------------------------------------------- player

/** Keys that fire at the cursor (any of them, both hands). */
const FIRE_KEYS = new Set([' ', 'a', 's', 'd', 'f', 'j', 'k', 'l']);
const AMBER = '#ffc61a';
const DIM = '#9a8f7a';
const INK = '#f4ecd8';

interface Ripple { t0: number; x: number; y: number }

/** A button shown in the status banner (keyboard shortcut plus tap target). */
export interface BannerAction { label: string; run: () => void }

export class BroadcastPlayer {
  private tv: TapeTv;
  private layer: HTMLElement;
  private overlay: HTMLCanvasElement;
  private octx: CanvasRenderingContext2D;
  private hud: Record<string, HTMLElement> = {};
  private hudText = new Map<HTMLElement, string>();
  private segs: (Uint8Array | null)[];
  private inflight: boolean[];
  private retryAt: number[];
  private shown = -1;
  private frameBuf = new Uint8Array(TAPE_W * TAPE_H);
  private preroll = new NoiseField((Math.random() * 2 ** 32) >>> 0, TAPE_W, TAPE_H);
  private prerollAt = 0;
  private trigger = new Trigger();
  private ripples: Ripple[] = [];
  private reticle = { x: 128, y: 72, visible: false };
  /** performance.now() of the last press that came during the cooldown. */
  private deniedAt = -Infinity;
  private raf = 0;
  private fetchTimer = 0;
  private escAt = 0;
  private done = false;
  private cleanups: (() => void)[] = [];
  private readonly totalCode: string;
  private readonly coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  constructor(parent: HTMLElement, private t: Ticketed, private onEnd: (strikes: number[]) => void, private onAbort: () => void) {
    const n = segmentCount(t.start.frames);
    this.segs = new Array(n).fill(null);
    this.inflight = new Array(n).fill(false);
    this.retryAt = new Array(n).fill(0);
    this.totalCode = timecode(2 * (t.start.frames - 1)).slice(3);
    this.layer = h('div', { class: 'he he-play' });
    parent.appendChild(this.layer);
    this.tv = new TapeTv(this.layer);
    this.overlay = h('canvas', { class: 'he-overlay' });
    this.layer.appendChild(this.overlay);
    this.octx = this.overlay.getContext('2d')!;
    this.buildHud();
    this.bindInput();
    this.fetchTimer = window.setInterval(() => this.pump(), 100);
    this.pump();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  /**
   * performance.now() at which segment i may be requested (server gate t0 + 5 s i - 2.5 s, plus margin).
   * The margin covers clock-sync error: the start call does chain reads before the server samples `now`,
   * so the RTT/2 estimate runs a few hundred ms ahead and a tight margin hits the "too early" gate.
   */
  private segOpensAt(i: number) {
    return this.t.playStart + i * SEG_MS - 2500 + 700;
  }

  private pump() {
    const now = performance.now();
    for (let i = 0; i < this.segs.length; i++) {
      if (this.segs[i] || this.inflight[i] || now < this.segOpensAt(i) || now < this.retryAt[i]) continue;
      this.inflight[i] = true;
      void this.fetchSeg(i);
    }
  }

  private async fetchSeg(i: number) {
    try {
      const res = await fetch(`/api/broadcast/seg?ticket=${encodeURIComponent(this.t.start.ticket)}&i=${i}`);
      if (res.ok) this.segs[i] = new Uint8Array(await res.arrayBuffer());
      else this.retryAt[i] = performance.now() + (res.status === 403 ? 300 : 1000);
    } catch {
      this.retryAt[i] = performance.now() + 1000;
    } finally {
      this.inflight[i] = false;
    }
  }

  private hasFrame(f: number) {
    const seg = this.segs[Math.floor(f / this.t.start.segFrames)];
    return !!seg && seg.length >= ((f % this.t.start.segFrames) + 1) * FRAME_BYTES;
  }

  /** Live TV: show the frame the clock says, or hold the last one we have if the stream lags. */
  private frame() {
    if (this.done) return;
    const now = performance.now();
    const rt = Math.floor(((now - this.t.playStart) * this.t.start.fps) / 1000);
    const frames = this.t.start.frames;
    if (rt < 0) {
      if (now - this.prerollAt >= 1000 / 30) {
        this.prerollAt = now;
        this.preroll.step([], 2);
        this.tv.draw(this.preroll.cur);
      }
      if (now >= this.bannerUntil) this.banner(String(Math.ceil(-rt / this.t.start.fps)), this.coarse ? 'TAP EVERY BEAST YOU SEE MOVING' : 'CLICK EVERY BEAST YOU SEE MOVING', 0, [], 'count');
    } else {
      if (!this.bannerUntil) this.hud.banner.hidden = true;
      let target = Math.min(rt, frames - 1);
      while (target > this.shown && !this.hasFrame(target)) target--;
      if (target > this.shown) {
        const per = this.t.start.segFrames;
        unpackFrame(this.segs[Math.floor(target / per)]!, (target % per) * FRAME_BYTES, this.frameBuf);
        this.shown = target;
        this.tv.draw(this.frameBuf);
      }
      this.hud.weak.hidden = this.shown >= Math.min(rt, frames - 1) - 3;
      // Stream stalled for good: submit what we have before the server's window closes.
      if (this.shown === frames - 1 || now > this.t.playStart + (frames * 1000) / this.t.start.fps + 9000) {
        this.finish();
        return;
      }
    }
    this.drawHud();
    this.drawOverlay(now);
  }

  private finish() {
    this.done = true;
    this.layer.classList.add('ended');
    this.hud.hint.hidden = true;
    this.drawHud();
    this.drawOverlay(performance.now());
    this.onEnd(this.trigger.strikes.slice());
  }

  /** Strike at the reticle on the frame on screen (tick 2f). Identical feedback for every strike. */
  private fire() {
    if (this.done || this.shown < 0) return;
    const now = performance.now();
    if (!this.trigger.fire(2 * this.shown, this.reticle.x, this.reticle.y)) {
      if (this.trigger.cooldown(2 * this.shown) > 0) this.deniedAt = now;
      return;
    }
    this.ripples.push({ t0: now, x: this.reticle.x, y: this.reticle.y });
    sound.select();
  }

  private buildHud() {
    const hud = h('div', { class: 'he-hud' });
    const mk = (k: string, cls: string) => { const el = h('div', { class: cls }); this.hud[k] = el; hud.appendChild(el); return el; };
    mk('tl', 'he-tl').innerHTML = `<b>HUMAN EYES</b><span>RANKED . TAPE ${this.t.start.k}</span>`;
    mk('tr', 'he-tr');
    mk('bl', 'he-bl');
    mk('br', 'he-br').innerHTML = 'NO FEEDBACK UNTIL THE END<br>THE CONTRACT DECODES IT';
    mk('hint', 'he-hint').textContent = this.coarse
      ? 'TAP A BEAST TO STRIKE . ONE STRIKE EVERY 0.3 S'
      : 'CLICK A BEAST TO STRIKE . SPACE FIRES AT THE CURSOR';
    const weak = mk('weak', 'he-lag');
    weak.textContent = 'STREAM LAG';
    weak.hidden = true;
    const ban = mk('banner', 'he-banner');
    ban.hidden = true;
    this.layer.appendChild(hud);
  }

  private bindInput() {
    const toField = (e: PointerEvent) => {
      const r = this.tv.canvas.getBoundingClientRect();
      return this.tv.cssToField(e.clientX - r.left, e.clientY - r.top);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const p = toField(e);
      this.reticle = { x: p.x, y: p.y, visible: true };
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      const p = toField(e);
      this.reticle = { x: p.x, y: p.y, visible: true };
      this.fire();
    };
    const onKey = (e: KeyboardEvent) => {
      if (this.done) return;
      if (e.key === 'Escape') {
        if (e.repeat) return;
        const now = performance.now();
        if (now - this.escAt < 2500) {
          this.done = true;
          this.onAbort();
          return;
        }
        this.escAt = now;
        this.banner('ESC AGAIN TO LEAVE', 'The tape keeps playing. Leaving discards this run.', 2500);
        return;
      }
      if (!FIRE_KEYS.has(e.key.toLowerCase())) return;
      e.preventDefault();
      // No autofire: a held key would spray blind strikes, and blind strikes jam the signal.
      if (!e.repeat && this.reticle.visible) this.fire();
    };
    const noMenu = (e: Event) => e.preventDefault();
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') this.reticle.visible = false;
    };
    this.layer.addEventListener('pointermove', onMove);
    this.layer.addEventListener('pointerdown', onDown);
    this.layer.addEventListener('pointerleave', onLeave);
    this.layer.addEventListener('contextmenu', noMenu);
    window.addEventListener('keydown', onKey);
    this.cleanups.push(() => window.removeEventListener('keydown', onKey));
  }

  private bannerUntil = 0;
  private bannerKey = '';
  private banner(text: string, sub?: string, ms = 0, actions: BannerAction[] = [], cls = '') {
    const now = performance.now();
    if (!sub && now < this.bannerUntil) return;
    const el = this.hud.banner;
    const key = `${text}\u0000${sub ?? ''}\u0000${actions.map((a) => a.label).join()}`;
    if (key !== this.bannerKey || el.hidden) {
      this.bannerKey = key;
      el.className = `he-banner ${cls}`;
      el.innerHTML = '';
      el.append(h('div', { class: 'he-banner-t' }, text));
      if (sub) el.append(h('div', { class: 'he-banner-sub' }, sub));
      if (actions.length) {
        const row = h('div', { class: 'he-banner-actions' });
        for (const a of actions) {
          const b = h('button', { class: 'he-btn' }, a.label);
          b.addEventListener('pointerdown', (e) => e.stopPropagation());
          b.addEventListener('click', () => a.run());
          row.append(b);
        }
        el.append(row);
      }
      el.hidden = false;
    }
    this.bannerUntil = ms ? now + ms : 0;
  }

  private setHud(el: HTMLElement, html: string) {
    if (this.hudText.get(el) === html) return;
    this.hudText.set(el, html);
    el.innerHTML = html;
  }

  private drawHud() {
    const tick = Math.max(0, 2 * this.shown);
    this.setHud(this.hud.tr, `<b>${timecode(tick).slice(3)}</b><span>/ ${this.totalCode}</span><i>${this.t.start.rootId ? `ROOT #${this.t.start.rootId}` : 'OFFCHAIN TEST'}</i>`);
    const left = this.trigger.left;
    this.setHud(this.hud.bl, `<span>STRIKES</span><b>${pad(this.trigger.strikes.length, 3)}</b><span class="dim">/${MAX_STRIKES}</span>${left ? '' : ' <span class="bad">NONE LEFT</span>'}`);
    if (this.bannerUntil && performance.now() > this.bannerUntil) {
      this.bannerUntil = 0;
      this.hud.banner.hidden = true;
    }
  }

  private drawOverlay(now: number) {
    const c = this.overlay;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(c.clientWidth * dpr);
    const H = Math.round(c.clientHeight * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = this.octx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, c.clientWidth, c.clientHeight);
    const sc = this.tv.cssScale;
    this.ripples = this.ripples.filter((r) => now - r.t0 < 320);
    for (const r of this.ripples) {
      const k = (now - r.t0) / 320;
      const p = this.tv.fieldToCss(r.x + 0.5, r.y + 0.5);
      g.strokeStyle = AMBER;
      g.globalAlpha = 1 - k;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(p.x, p.y, (4 + 10 * k) * sc, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = 1;
    if (this.reticle.visible && !this.done) this.drawReticle(g, now, sc);
  }

  /**
   * Crosshair at the pointer. Amber when a strike is allowed; dim while the trigger recharges,
   * with a ring that fills over the 0.3 s cooldown (it flashes if pressed too early). It never
   * reacts to what is under it.
   */
  private drawReticle(g: CanvasRenderingContext2D, now: number, sc: number) {
    const p = this.tv.fieldToCss(this.reticle.x + 0.5, this.reticle.y + 0.5);
    const tick = 2 * this.shown;
    const live = this.shown >= 0;
    const ready = live && this.trigger.ready(tick);
    const r = 7 * sc;
    g.lineCap = 'butt';
    g.strokeStyle = '#000';
    g.lineWidth = 4;
    const cross = () => {
      g.beginPath();
      g.moveTo(p.x - r, p.y); g.lineTo(p.x - r / 3, p.y);
      g.moveTo(p.x + r / 3, p.y); g.lineTo(p.x + r, p.y);
      g.moveTo(p.x, p.y - r); g.lineTo(p.x, p.y - r / 3);
      g.moveTo(p.x, p.y + r / 3); g.lineTo(p.x, p.y + r);
      g.stroke();
    };
    cross();
    g.strokeStyle = ready ? AMBER : DIM;
    g.lineWidth = 2;
    cross();
    if (!live || this.trigger.left === 0) return;
    const ring = r + 3 * sc;
    if (!ready) {
      const k = this.trigger.charge(tick);
      g.lineWidth = 2;
      g.strokeStyle = now - this.deniedAt < 160 ? INK : AMBER;
      g.globalAlpha = now - this.deniedAt < 160 ? 1 : 0.75;
      g.beginPath();
      g.arc(p.x, p.y, ring, -Math.PI / 2, -Math.PI / 2 + Math.max(0.05, k) * Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
    }
  }

  /** Show a status banner over the frozen last frame (used while signing / submitting). */
  status(text: string, sub?: string, actions: BannerAction[] = []) {
    this.banner(text, sub, 0, actions);
  }

  destroy() {
    this.done = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.fetchTimer);
    this.cleanups.forEach((f) => f());
    this.tv.stop();
    this.layer.remove();
  }
}
