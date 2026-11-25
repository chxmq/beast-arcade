// BEAST CATCH: one input. Click (or tap) a Beast to catch it. The sim (src/sim/replay.ts) decides
// everything; this file draws it as full-colour sprites (sprites.ts) and turns its events into an
// arcade run you can feel: hit-stop, cards flying to the tray, chains, FEVER, tickets at the end.
import type { Roster, RosterEntry } from '../data/roster.ts';
import { controls } from '../arcade/controls.ts';
import { tickets } from '../arcade/wallet.ts';
import { encodeStrike } from '../sim/encode.ts';
import { positionAt } from '../sim/motion.ts';
import { Run, type RunEvent, type RunResult } from '../sim/replay.ts';
import {
  FIELD_H, FIELD_W, JAM_MISSES, MAX_STRIKES, MAX_TICK, N_SPAWNS, NO_INDEX, NO_TYPE, PLAYER_LIVES, PREFIXES, SUFFIX_SHOUT, SUFFIX_WHISPER, SUFFIXES,
} from '../sim/spec.ts';
import { h, pad } from '../ui/dom.ts';
import { alertFor, beatTime, catchKind, catchLabel, encounterLine, planCatch, type CatchKind } from './ceremony.ts';
import { collection, type Snapshot } from './collection.ts';
import { dexIndex, dexLabel } from './dex.ts';
import type { ChannelRun } from './channels.ts';
import { sound } from './audio.ts';
import { artistOf, artOf, beastName, strengthOf, typeName } from './beasts.ts';
import { C, drawReticle, FxLayer, type View } from './fx.ts';
import { catchPayout, type Payout } from './haul.ts';
import { HuntHud } from './hud.ts';
import { music } from './music.ts';
import { settings } from './settings.ts';
import { SpriteStage, TYPE_COLOR, WARN_TICKS, type SpriteSpec } from './sprites.ts';

/** One Beast caught during a hunt, in order. */
export interface CatchRecord {
  /** Spawn index in the run. */
  idx: number;
  speciesId: number;
  shiny: boolean;
  /** First time this species was ever caught. */
  isNew: boolean;
  kind: CatchKind;
  pts: number;
  tick: number;
}

export interface HuntOutcome {
  channel: ChannelRun['channel'];
  catches: CatchRecord[];
  /** Spawn index of the last Beast that got away (-1 if none). */
  lastEscape: number;
  /** Collection before the hunt and after it. */
  before: Snapshot;
  after: Snapshot;
  seed: bigint;
  result: RunResult;
  run: Run;
  strikes: number[];
  /** Longest run of same-type kills and its type (NO_TYPE when nothing was caught). */
  bestChain: number;
  bestChainType: number;
  /** A new best score in this habitat, and the best before this run. */
  isBest: boolean;
  prevBest: number;
  /** Tickets this run paid (already added to the wallet, exactly once). */
  payout: Payout;
}

/** Where to go once a run is over. */
export type HuntNext = 'results' | 'retune' | 'arcade';

/** A click this many ticks or fewer before the cooldown ends is kept and fired when it ends. */
const BUFFER_TICKS = 6;
const FEVER_COMBO = 10;
const HIT_STOP_MS = 70;
const KING_STOP_MS = 150;
/** At most one big flash per this many ms. */
const FLASH_GAP_MS = 333;
/** READY / GO before the clock starts. */
const INTRO_MS = 1150;
const DEBUG = import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug');

type Voice = { setPan(p: number): void; stop(): void };
type Ev<K extends RunEvent['kind']> = Extract<RunEvent, { kind: K }>;

const comboMult = (combo: number) => (10 + Math.min(combo, 40)) / 10;
const TYPE_WORD = ['MAGIC', 'HUNTER', 'BRUTE'] as const;

export class Hunt {
  private stage: SpriteStage;
  private run: Run;
  private entries: RosterEntry[];
  private layer: HTMLElement;
  private stageWrap: HTMLElement;
  private overlay: HTMLCanvasElement;
  private octx: CanvasRenderingContext2D;
  private fx = new FxLayer();
  private hud: HuntHud;
  private strikes: number[] = [];
  /** Mouse aim in field pixels. */
  private aim = { x: 128, y: 72, seen: false, inside: false, touch: false };
  /** Last touch point (touch players get the combo readout there). */
  private tap = { x: 0, y: 0, at: -1e9 };
  private pending: { x: number; y: number; atAim: boolean } | null = null;
  private cdTotal = 1;
  private voices = new Map<number, Voice | null>();
  private surfaced = new Set<number>();
  /** Spawn idx -> performance.now() of its last hit (flash and squash). */
  private hitAt = new Map<number, number>();
  private catches: CatchRecord[] = [];
  private lastEscape = -1;
  private before: Snapshot;
  private dexIdx: Map<number, number>;
  private warned = new Set<number>();
  private seenEvents = 0;
  private ended = false;
  private endAt = -1;
  private skipAfter = 0;
  private finished = false;
  private fever = false;
  private bestChain = 0;
  private bestChainType = NO_TYPE;
  private lastBeat = -999;
  private lastFlash = -1e9;
  private comboAt = 0;
  private shownCombo = 0;
  private shake = { until: 0, dur: 1, mag: 0, t: '' };
  private paid: Payout | null = null;
  private timers: number[] = [];
  private cleanups: (() => void)[] = [];
  private readonly prevBest: number;
  private readonly firstRun = collection.state.stats.runs === 0;

  constructor(parent: HTMLElement, roster: Roster, private cr: ChannelRun, readonly seed: bigint, private onEnd: (o: HuntOutcome, next: HuntNext) => void) {
    // The run's rosterIdx indexes the habitat's sub-roster; entries[rosterIdx] is the species.
    this.entries = cr.entries;
    this.run = new Run(seed, cr.sim, cr.nRares);
    this.dexIdx = dexIndex(roster.entries);
    this.before = collection.snapshot();
    this.prevBest = collection.bestFor(cr.channel.id);
    this.layer = h('div', { class: 'cx cx-play' });
    this.stageWrap = h('div', { class: 'cx-stage' });
    this.layer.appendChild(this.stageWrap);
    parent.appendChild(this.layer);
    this.stage = new SpriteStage(this.stageWrap, { habitat: cr.channel.id });
    this.overlay = h('canvas', { class: 'cx-overlay' });
    this.stageWrap.appendChild(this.overlay);
    this.octx = this.overlay.getContext('2d')!;
    this.hud = new HuntHud(cr.channel.name, N_SPAWNS, PLAYER_LIVES);
    this.layer.appendChild(this.hud.el);
    this.bindInput();
    for (const s of this.run.spawns) artOf(this.entries[s.rosterIdx]);
    this.hud.lives(PLAYER_LIVES);
    this.hud.kills(0, N_SPAWNS);
    this.hud.score(0, this.prevBest);
    this.hud.misses(0);
    if (typeof document !== 'undefined' && document.fonts) void document.fonts.load(`16px 'Press Start 2P'`).catch(() => {});
    music.start();
    music.setIntensity(0);
    sound.sfx('start');
    this.hud.shout('READY?', cr.channel.name, 'ready', INTRO_MS - 250);
    this.later(INTRO_MS - 200, () => this.hud.shout('GO!', '', 'go', 600));
    if (this.firstRun) this.later(INTRO_MS, () => this.hud.alert('TAP A BEAST TO CATCH IT', `Three misses in a row jam: -1 life. Don't let them flee.`, 'hint', 6000));
    if (DEBUG) this.exposeDebug();
    this.stage.hold(INTRO_MS);
    this.stage.start((tick) => this.onTick(tick), (tick) => this.scene(tick), () => this.onFrame());
  }

  // ------------------------------------------------------------------ input

  private bindInput() {
    const layer = this.layer;
    const toField = (e: PointerEvent) => this.stage.toField(e.clientX, e.clientY);
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const p = toField(e);
      this.aim = { x: p.x, y: p.y, seen: true, inside: p.inside, touch: false };
    };
    const onLeave = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') this.aim.inside = false;
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      if (this.ended) return this.skipEnd();
      if (this.stage.paused) return this.togglePause();
      const p = toField(e);
      const touch = e.pointerType !== 'mouse';
      if (touch) this.tap = { x: p.x, y: p.y, at: performance.now() };
      this.aim = { x: p.x, y: p.y, seen: true, inside: p.inside, touch };
      if (p.inside) this.tryStrike(p.x, p.y, !touch);
    };
    // A and START fire at the cursor (trackpads, the cabinet panel), or move the menus on.
    const fire = () => {
      if (this.finished) return;
      if (this.ended) return this.skipEnd();
      if (this.stage.paused) return this.togglePause();
      if (this.aim.seen && !this.aim.touch && this.aim.inside) this.tryStrike(this.aim.x, this.aim.y, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || this.finished) return;
      const k = e.key.toLowerCase();
      if (this.ended) {
        if (k === 'r') this.finishNow('retune');
        else if (k === 'escape') this.finishNow('arcade');
        return;
      }
      if (this.stage.paused) {
        if (k === 'escape' || k === 'q') this.finish('arcade');
        else if (k === 'r') this.finish('retune');
        else if (k === 'p') this.togglePause();
        return;
      }
      if (k === 'escape' || k === 'p') this.togglePause();
    };
    const onVis = () => {
      if (document.hidden && !this.stage.paused && !this.ended) this.togglePause();
    };
    const noMenu = (e: Event) => e.preventDefault();
    const stopDown = (e: Event) => e.stopPropagation();
    const pauseClick = (e: Event) => { e.stopPropagation(); this.hud.pauseBtn.blur(); if (!this.ended) this.togglePause(); };
    layer.addEventListener('pointermove', onMove);
    layer.addEventListener('pointerleave', onLeave);
    layer.addEventListener('pointerdown', onDown);
    layer.addEventListener('contextmenu', noMenu);
    this.hud.pauseBtn.addEventListener('pointerdown', stopDown);
    this.hud.pauseBtn.addEventListener('click', pauseClick);
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onVis);
    this.cleanups.push(
      controls.on('A', fire),
      controls.on('START', fire),
      () => {
        window.removeEventListener('keydown', onKey);
        document.removeEventListener('visibilitychange', onVis);
      },
    );
  }

  /** The frame on screen shows this tick; strikes are stamped with it. */
  private get shownTick() {
    return this.stage.shownTick;
  }

  private tryStrike(x: number, y: number, atAim: boolean) {
    if (this.ended || this.stage.paused) return;
    const T = this.shownTick;
    if (T < 0 || T >= MAX_TICK || this.strikes.length >= MAX_STRIKES) return;
    if (!this.run.canStrike(T)) {
      // Too soon. Keep the click if the cooldown is nearly over, so fast clicking never feels eaten.
      if (this.run.cooldown(T) <= BUFFER_TICKS) this.pending = { x, y, atAim };
      return;
    }
    this.fire(T, x, y);
  }

  private firePending() {
    const p = this.pending;
    if (!p) return;
    const T = this.shownTick;
    if (this.strikes.length >= MAX_STRIKES || T >= MAX_TICK) { this.pending = null; return; }
    if (!this.run.canStrike(T)) return;
    this.pending = null;
    // Mouse players keep tracking the Beast, so a held-over click fires where the cursor is now.
    const useAim = p.atAim && this.aim.seen && !this.aim.touch && this.aim.inside;
    this.fire(T, useAim ? this.aim.x : p.x, useAim ? this.aim.y : p.y);
  }

  private fire(T: number, x: number, y: number) {
    x = Math.max(0, Math.min(FIELD_W - 1, x));
    y = Math.max(0, Math.min(FIELD_H - 1, y));
    const st = { tick: T, x, y, type: 0 as const };
    const comboBefore = this.run.combo;
    const ev = this.run.strike(st);
    this.strikes.push(encodeStrike(st));
    this.cdTotal = Math.max(1, this.run.cooldown(T));
    if (ev && ev.kind === 'strike') this.onStrike(ev, x, y, comboBefore);
    this.drainEvents();
  }

  // ------------------------------------------------------------------ feedback

  private onStrike(ev: Ev<'strike'>, x: number, y: number, comboBefore: number) {
    const now = performance.now();
    if (ev.outcome === 'hit') {
      const s = this.run.spawns[ev.target];
      const left = this.run.beastHp[ev.target];
      sound.hit(ev.combo);
      this.comboAt = now;
      this.hitAt.set(ev.target, now);
      this.fx.ring(x, y, C.gold, now, 200, 2, 9);
      this.fx.sparks(x + 0.5, y + 0.5, left > 0 ? 8 : 12, [C.gold, C.ink, TYPE_COLOR[s.entry.type] ?? C.ink], now, 55, 320);
      if (left > 0) {
        this.fx.text(x, y - 6, `${left} MORE`, C.ink, now, { size: 5.5, dur: 600, rise: 6 });
        if (s.boss) this.hud.king(left, s.hp);
      }
      if (ev.combo === FEVER_COMBO) this.hud.shout('FEVER!', 'combo 10: the habitat turns gold', 'gold', 900);
      else if (ev.combo >= 20 && ev.combo % 10 === 0) this.hud.shout(`COMBO ${ev.combo}!`, '', 'gold', 700);
      if (collection.combo(ev.combo)) this.goalDone();
      return;
    }
    if (ev.outcome === 'overkill') {
      sound.overkill();
      this.fx.ring(x, y, C.dim, now, 180, 2, 6, 1);
      return;
    }
    // miss
    if (ev.misses >= JAM_MISSES) {
      this.fx.ring(x, y, C.hot, now, 320, 3, 16);
    } else if (ev.misses === JAM_MISSES - 1) {
      sound.missWarn();
      this.fx.ring(x, y, C.hot, now, 300, 3, 14);
      this.fx.text(x, y - 5, 'MISS', C.hot, now, { size: 6, dur: 900, rise: 6, sub: '1 more miss jams!' });
    } else {
      sound.miss();
      this.fx.ring(x, y, C.dim, now, 260, 3, 12);
      this.fx.text(x, y - 5, 'MISS', C.ink, now, { size: 6, dur: 550, rise: 6 });
    }
    if (comboBefore >= 5) this.fx.text(x, y + 16, `COMBO ${comboBefore} LOST`, C.dim, now, { size: 4.5, dur: 800, rise: 4, delay: 60 });
  }

  private drainEvents() {
    const evs = this.run.events;
    for (; this.seenEvents < evs.length; this.seenEvents++) {
      const ev = evs[this.seenEvents];
      if (ev.kind === 'kill') this.onKill(ev);
      else if (ev.kind === 'escape') this.onEscape(ev);
      else if (ev.kind === 'jam') this.onJam(ev);
      else if (ev.kind === 'death') this.onDeath(ev);
    }
  }

  private bigFlash(now: number): boolean {
    if (settings.calm || now - this.lastFlash < FLASH_GAP_MS) return false;
    this.lastFlash = now;
    return true;
  }

  /** A sprite spec for spawn i at `tick`, as the stage draws it. */
  private specOf(i: number, tick: number): SpriteSpec {
    const s = this.run.spawns[i];
    const { px, py } = positionAt(s, Math.max(s.spawnTick, tick));
    return {
      key: i,
      entry: this.entries[s.rosterIdx],
      px,
      py,
      age: tick - s.spawnTick,
      left: s.escapeTick - tick,
      shiny: s.shiny,
      king: s.boss,
      hp: this.run.beastHp[i],
      maxHp: s.hp,
      hitAt: this.hitAt.get(i) ?? -Infinity,
      phase: (i * 0.6180339) % 1,
    };
  }

  private onKill(ev: Ev<'kill'>) {
    const s = this.run.spawns[ev.idx];
    const e = this.entries[s.rosterIdx];
    const { px, py } = positionAt(s, ev.tick);
    const now = performance.now();
    const cx = px + e.w / 2;
    const kind = catchKind(s);
    const res = collection.catch(e.speciesId, { type: e.type, shiny: s.shiny, rare: s.featured });
    const dex = dexLabel(this.dexIdx.get(e.speciesId) ?? 0);
    this.catches.push({ idx: ev.idx, speciesId: e.speciesId, shiny: s.shiny, isNew: res.isNew, kind, pts: ev.pts, tick: ev.tick });
    const spec = this.specOf(ev.idx, ev.tick);
    this.hitAt.delete(ev.idx);

    // Hit-stop, then the ceremony: the Beast turns to light, becomes a card, the card flips and flies
    // to the tray. All of it is overlay and sound; input and the clock are never blocked for long.
    this.stage.hold(s.boss ? KING_STOP_MS : HIT_STOP_MS);
    this.stage.exit(spec, 'catch', now);
    const plan = planCatch(kind);
    const mult = comboMult(ev.combo) * ((1 + Math.min(ev.chain, 5)) / 2) * (s.faint ? 1.25 : 1) * (s.boss ? 3 : 1) * (s.shiny ? 3 : 1);
    this.fx.card({
      x: px, y: py, w: e.w, h: e.h, entry: e, plan, shiny: s.shiny, king: s.boss, dex, artist: artistOf(e), typeWord: typeName(e.type),
      label: catchLabel(res.isNew, s.shiny, s.boss, dex), pts: `+${ev.pts}`, ptsSub: mult >= 1.05 ? `x${mult.toFixed(1)}` : undefined,
      target: this.trayTarget(ev.idx),
    }, now);
    const tc = TYPE_COLOR[e.type] ?? C.ink;
    this.fx.sparks(cx, py + e.h / 2, s.boss ? 48 : 14, s.boss ? [C.gold, C.ink, C.hot] : [C.gold, C.ink, tc], now, s.boss ? 120 : 70, s.boss ? 850 : 420);
    if (ev.chain >= 2) {
      this.fx.text(cx, Math.min(FIELD_H - 3, py + e.h + 9), `${TYPE_WORD[e.type]} CHAIN x${ev.chain}`, tc, now, { size: 5.5, dur: 900, rise: 5, delay: 90 + plan.flipAt });
    }
    if (plan.wobbles > 0) {
      for (let i = 0; i < plan.wobbles; i++) this.later(beatTime(plan, i), () => sound.wobble(i));
      this.later(plan.flipAt, () => this.caughtSound(s.boss, s.shiny, res.isNew, ev.combo, ev.chain));
    } else {
      this.caughtSound(false, false, res.isNew, ev.combo, ev.chain);
    }
    if (ev.chain > this.bestChain) {
      this.bestChain = ev.chain;
      this.bestChainType = e.type;
    }
    this.stopVoice(ev.idx);
    // The tray slot fills when the card lands in it.
    this.later(plan.total - 30, () => {
      this.hud.slot(ev.idx, e, true, s.shiny);
      sound.tray();
    });
    if (res.goalDone) this.later(plan.total + 100, () => this.goalDone());
    if (s.boss) {
      this.hud.kingHide();
      this.shakeScreen(9, 260);
      this.fx.flash('#ffffff', now, 260, 0.45);
    }
  }

  private caughtSound(king: boolean, shiny: boolean, isNew: boolean, combo: number, chain: number) {
    if (king) sound.kingKill();
    else sound.caught(isNew, combo, chain);
    if (shiny) sound.sparkle();
  }

  private goalDone() {
    const d = collection.daily();
    this.hud.shout('DAILY GOAL!', d.goal.text, 'gold', 1800);
    sound.goal();
  }

  /** Centre and width of this Beast's tray slot, in overlay CSS px (null if the HUD cannot say). */
  private trayTarget(i: number): { x: number; y: number; size: number } | null {
    const r = this.hud.slotRect(i);
    if (!r || r.width === 0) return null;
    const o = this.overlay.getBoundingClientRect();
    if (!o.width) return null;
    const k = this.overlay.clientWidth / o.width;
    return { x: (r.left + r.width / 2 - o.left) * k, y: (r.top + r.height / 2 - o.top) * k, size: r.width * k };
  }

  private onEscape(ev: Ev<'escape'>) {
    const s = this.run.spawns[ev.idx];
    const e = this.entries[s.rosterIdx];
    const spec = this.specOf(ev.idx, ev.tick - 1);
    const now = performance.now();
    this.stage.exit(spec, 'flee', now);
    this.lastEscape = ev.idx;
    this.hitAt.delete(ev.idx);
    sound.escape();
    const big = this.bigFlash(now);
    this.shakeScreen(big ? 10 : 5, 180);
    if (big) this.fx.flash(C.hot, now, 200, 0.22);
    this.fx.text(spec.px + e.w / 2, spec.py + e.h / 2, `-${ev.cost}`, C.hot, now, { size: 12, dur: 800 });
    if (this.shownCombo >= 5) this.fx.text(spec.px + e.w / 2, spec.py + e.h / 2 + 14, `COMBO ${this.shownCombo} LOST`, C.dim, now, { size: 4.5, dur: 800, rise: 4, delay: 80 });
    this.hud.lives(ev.lives);
    this.hud.hurt();
    this.hud.caption(`${beastName(e, s.prefix, s.suffix).toUpperCase()} FLED!`, `-${ev.cost} ${ev.cost === 1 ? 'life' : 'lives'} . ${typeName(e.type)} T${e.tier}`, 'bad', 1700);
    this.hud.slot(ev.idx, e, false);
    this.stopVoice(ev.idx);
    if (s.boss) this.hud.kingHide();
  }

  private onJam(ev: Ev<'jam'>) {
    const now = performance.now();
    sound.jam();
    this.shakeScreen(8, 240);
    if (!settings.calm) {
      this.lastFlash = now;
      this.fx.flash(C.hot, now, 260, 0.3);
    }
    this.hud.shout('JAMMED!', 'three misses in a row . -1 life', 'bad', 1100);
    this.hud.lives(ev.lives);
    this.hud.hurt();
  }

  /** Beasts still out when the run ends all run off. */
  private scatter(now: number) {
    const T = Math.max(0, this.shownTick);
    for (let i = 0; i < this.run.spawns.length; i++) {
      if (this.run.isVisible(i, T)) this.stage.exit(this.specOf(i, T), 'flee', now + Math.random() * 180);
    }
  }

  /** What this run will pay (final once the run has ended). */
  private payoutNow(): Payout {
    return catchPayout(this.catches, !this.run.dead && this.run.kills === N_SPAWNS);
  }

  /** Pay the run's tickets, exactly once. */
  private settle(): Payout {
    if (this.paid) return this.paid;
    const p = this.payoutNow();
    this.paid = p;
    if (p.total > 0) tickets.add(p.total, 'catch');
    return p;
  }

  private endActions(): { label: string; run: () => void; primary?: boolean }[] {
    return [
      { label: 'HAUL', run: () => this.finishNow('results'), primary: true },
      { label: 'AGAIN', run: () => this.finishNow('retune') },
      { label: 'ARCADE', run: () => this.finishNow('arcade') },
    ];
  }

  private prize(): { prize: string; prizeNone: boolean } {
    const t = this.payoutNow().total;
    return { prize: t > 0 ? `+${t} TICKETS` : 'NO TICKETS THIS TIME', prizeNone: t === 0 };
  }

  private onDeath(ev: Ev<'death'>) {
    const now = performance.now();
    this.ended = true;
    this.endAt = now + 3600;
    this.skipAfter = now + 700;
    this.setFever(false, false);
    this.silence();
    this.scatter(now);
    sound.sfx('gameover');
    this.hud.quiet();
    const r = this.run;
    const line = `SCORE ${pad(r.score, 6)} . ${r.kills}/${N_SPAWNS} CAUGHT`;
    const hint = '[A] HAUL   [R] AGAIN   [ESC] ARCADE';
    const prize = this.prize();
    if (ev.killer === NO_INDEX) {
      this.hud.banner('GAME OVER', { sub: 'Jammed: three misses in a row on your last life.', lines: [line], ...prize, hint, cls: 'lost', actions: this.endActions() });
    } else {
      const s = r.spawns[ev.killer];
      const e = this.entries[s.rosterIdx];
      const credit = e.featured ? [`art by ${artistOf(e)}`] : [];
      this.hud.banner('GAME OVER', { art: e, sub: `${beastName(e, s.prefix, s.suffix)} got away with your last life.`, lines: [line, ...credit], ...prize, hint, cls: 'lost', actions: this.endActions() });
    }
  }

  private survive() {
    const now = performance.now();
    this.ended = true;
    this.endAt = now + 4200;
    this.skipAfter = now + 900;
    this.setFever(false, false);
    this.silence();
    this.hud.quiet();
    const r = this.run;
    const perfect = r.kills === N_SPAWNS;
    // Let the last catch (often the King's) play before the banner covers the picture.
    this.later(900, () => {
      sound.fanfare(perfect);
      this.hud.banner(perfect ? 'PERFECT!' : 'STAGE CLEAR', {
        sub: perfect ? `All ${N_SPAWNS} Beasts caught. Clean sweep: tickets x2.` : `${this.cr.channel.name} cleared with ${r.lives} ${r.lives === 1 ? 'life' : 'lives'} left.`,
        lines: [`SCORE ${pad(r.score, 6)} . ${r.kills}/${N_SPAWNS} CAUGHT`],
        ...this.prize(),
        hint: '[A] HAUL   [R] AGAIN   [ESC] ARCADE',
        cls: 'won',
        actions: this.endActions(),
      });
    });
  }

  private setFever(on: boolean, withSound = true) {
    if (on === this.fever) return;
    this.fever = on;
    this.stage.fever = on;
    this.hud.fever(on);
    if (withSound) (on ? sound.feverOn() : sound.feverOff());
  }

  private shakeScreen(px: number, ms: number) {
    if (settings.calm) return;
    const now = performance.now();
    this.shake.until = now + ms;
    this.shake.dur = ms;
    this.shake.mag = px;
  }

  private stopVoice(i: number) {
    this.voices.get(i)?.stop();
    this.voices.set(i, null);
  }

  private silence() {
    for (const v of this.voices.values()) v?.stop();
    for (const k of this.voices.keys()) this.voices.set(k, null);
    music.stop();
  }

  private later(ms: number, fn: () => void) {
    this.timers.push(window.setTimeout(fn, ms));
  }

  // ------------------------------------------------------------------ flow

  private togglePause() {
    if (this.ended) return;
    this.stage.paused = !this.stage.paused;
    this.layer.classList.toggle('paused', this.stage.paused);
    if (this.stage.paused) {
      this.pending = null;
      for (const v of this.voices.values()) v?.stop();
      this.voices.clear();
      music.stop();
      this.stageWrap.style.transform = '';
      this.shake.t = '';
      sound.sfx('select');
      this.hud.banner('PAUSED', {
        sub: `${this.cr.channel.name} . score ${pad(this.run.score, 6)} . ${this.run.kills}/${N_SPAWNS} caught`,
        actions: [
          { label: 'RESUME', run: () => this.togglePause(), primary: true },
          { label: 'RESTART', run: () => this.finish('retune') },
          { label: 'QUIT', run: () => this.finish('arcade') },
        ],
        hint: '[ENTER] RESUME   [R] RESTART   [ESC] QUIT TO ARCADE',
        cls: 'paused',
      });
    } else {
      this.hud.hideBanner();
      sound.sfx('select');
      music.start();
    }
  }

  private skipEnd() {
    if (this.ended && performance.now() >= this.skipAfter) this.finish('results');
  }

  private finishNow(next: HuntNext) {
    if (this.ended) this.finish(next);
  }

  private finish(next: HuntNext) {
    if (this.finished) return;
    this.finished = true;
    this.ended = true;
    this.silence();
    const result = this.run.finish();
    const isBest = collection.finishRun(result.score, this.cr.channel.id);
    const payout = this.settle();
    this.onEnd({
      channel: this.cr.channel, catches: this.catches, lastEscape: this.lastEscape, before: this.before, after: collection.snapshot(), seed: this.seed,
      result, run: this.run, strikes: this.strikes, bestChain: this.bestChain, bestChainType: this.bestChainType, isBest, prevBest: this.prevBest, payout,
    }, next);
  }

  // ------------------------------------------------------------------ clock

  private onTick(tick: number) {
    if (this.ended) return;
    const r = this.run;
    r.advanceTo(tick);
    this.drainEvents();
    if (this.ended) return;
    if (r.resolvedAt.every((t) => t >= 0) || tick > r.endTick + 20) {
      this.survive();
      return;
    }
    let visible = 0;
    let king = false;
    for (let i = 0; i < r.spawns.length; i++) {
      if (!r.isVisible(i, tick)) continue;
      visible++;
      const s = r.spawns[i];
      const e = this.entries[s.rosterIdx];
      if (s.boss) king = true;
      if (!this.surfaced.has(i)) this.surface(i);
      if (!this.voices.has(i)) this.voices.set(i, s.suffix === SUFFIX_WHISPER ? null : sound.voice(e.type, s.suffix === SUFFIX_SHOUT ? 1 : strengthOf(e.tier)));
      const { px } = positionAt(s, tick);
      const pan = ((px + e.w / 2) / FIELD_W) * 2 - 1;
      this.voices.get(i)?.setPan(pan);
      if (s.escapeTick - tick === WARN_TICKS && !this.warned.has(i)) {
        this.warned.add(i);
        sound.warn(pan);
        this.fx.edge(pan < 0 ? -1 : 1, performance.now());
      }
    }
    music.setIntensity(this.fever ? 3 : r.combo >= 5 || visible >= 3 || r.lives <= 1 || king ? 2 : visible > 0 ? 1 : 0);
    if (r.lives === 1 && tick - this.lastBeat >= 54) {
      this.lastBeat = tick;
      sound.heartbeat();
    }
  }

  /** The Beasts on screen at `tick`, for the stage. Nothing once the run has ended (they scattered). */
  private scene(tick: number): SpriteSpec[] {
    const out: SpriteSpec[] = [];
    if (tick < 0 || this.ended) return out;
    for (let i = 0; i < this.run.spawns.length; i++) if (this.run.isVisible(i, tick)) out.push(this.specOf(i, tick));
    return out;
  }

  /** First tick a Beast is on screen: a wild encounter. A rare, shiny or King gets a sting and an alert. */
  private surface(i: number) {
    this.surfaced.add(i);
    const s = this.run.spawns[i];
    const e = this.entries[s.rosterIdx];
    const kind = catchKind(s);
    const word = typeName(e.type);
    collection.seen(e.speciesId);
    const alert = alertFor(kind, word, s.hp);
    if (alert) {
      this.hud.alert(alert.text, alert.sub, alert.cls, kind === 'king' ? 2600 : 1700);
      sound.sting(kind === 'shiny' ? 'shiny' : kind === 'king' ? 'king' : 'rare');
    } else {
      sound.wild();
    }
    if (kind === 'king') {
      this.hud.king(s.hp, s.hp);
      this.shakeScreen(6, 300);
    }
    const affix = s.prefix && s.suffix ? ` . ${PREFIXES[s.prefix]} ${SUFFIXES[s.suffix]}` : '';
    this.hud.caption(encounterLine(e.name), `${word} . T${e.tier}${s.hp > 1 ? ` . ${s.hp} taps` : ''}${affix}`, kind === 'common' ? '' : kind, kind === 'king' ? 2600 : 1400, TYPE_COLOR[e.type]);
  }

  private onFrame() {
    const now = performance.now();
    if (this.finished) return;
    if (this.ended && this.endAt > 0 && now >= this.endAt) {
      this.finish('results');
      return;
    }
    if (!this.ended) {
      this.setFever(this.run.combo >= FEVER_COMBO);
      this.firePending();
    }
    this.drawHud();
    this.applyShake(now);
    this.drawOverlay(now);
    this.shownCombo = this.run.combo;
  }

  private drawHud() {
    const r = this.run;
    this.hud.score(r.score, this.prevBest);
    this.hud.lives(r.lives);
    this.hud.kills(r.kills, N_SPAWNS);
    this.hud.combo(r.combo, comboMult(r.combo), this.fever);
    this.hud.chain(r.chain, TYPE_WORD[r.chainType] ?? '', TYPE_COLOR[r.chainType] ?? C.ink);
    this.hud.misses(this.ended ? 0 : r.misses);
    this.hud.warn(!this.ended && r.misses === JAM_MISSES - 1 ? '1 MORE MISS JAMS!' : null);
  }

  private applyShake(now: number) {
    const f = this.shake;
    let t = '';
    if (now < f.until) {
      const m = (f.mag * (f.until - now)) / f.dur;
      t = `translate(${((Math.random() * 2 - 1) * m).toFixed(1)}px, ${((Math.random() * 2 - 1) * m * 0.5).toFixed(1)}px)`;
    }
    if (t !== f.t) {
      this.stageWrap.style.transform = t;
      f.t = t;
    }
  }

  // ------------------------------------------------------------------ overlay

  private drawOverlay(now: number) {
    const c = this.overlay;
    const dpr = window.devicePixelRatio || 1;
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    const W = Math.round(cw * dpr);
    const H = Math.round(ch * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const g = this.octx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    g.imageSmoothingEnabled = false;
    const view: View = { toCss: (x, y) => this.stage.fieldToCss(x, y), sc: this.stage.cssScale, W: cw, H: ch, calm: settings.calm };
    const r = this.run;

    // Last life: a red frame pulses with the heartbeat.
    if (!this.ended && r.lives === 1) {
      const beat = settings.calm ? 0.35 : Math.max(0, 1 - (this.stage.tick - this.lastBeat) / 30);
      const lw = Math.max(6, cw * 0.008);
      g.strokeStyle = `rgba(255,59,47,${0.2 + 0.5 * beat})`;
      g.lineWidth = lw;
      g.strokeRect(lw / 2, lw / 2, cw - lw, ch - lw);
    }

    this.fx.draw(g, view, now);
    if (DEBUG) this.drawDebug(g, view);

    if (!this.ended && !this.stage.paused) {
      const pop = Math.max(0, 1 - (now - this.comboAt) / 140);
      if (this.aim.seen && !this.aim.touch && this.aim.inside) {
        const cd = r.cooldown(Math.max(0, this.shownTick));
        drawReticle(g, view, this.aim.x, this.aim.y, cd > 0 ? cd / this.cdTotal : 0, r.misses === JAM_MISSES - 1, r.combo, pop, this.fever);
      } else if (this.aim.touch && now - this.tap.at < 900 && r.combo >= 2) {
        const p = view.toCss(this.tap.x, this.tap.y);
        g.font = `${Math.round(Math.max(14, 4 * view.sc) * (1 + 0.5 * pop))}px 'Press Start 2P', monospace`;
        g.textAlign = 'center';
        g.globalAlpha = 1 - (now - this.tap.at) / 900;
        g.fillStyle = '#000';
        g.fillText(String(r.combo), p.x + 2, p.y - 14 * view.sc + 2);
        g.fillStyle = this.fever ? C.gold : C.ink;
        g.fillText(String(r.combo), p.x, p.y - 14 * view.sc);
        g.globalAlpha = 1;
      }
    }
  }

  // ------------------------------------------------------------------ dev only

  /** `?debug` in dev builds: outline every Beast's hitbox so effects can be tested by a machine. */
  private drawDebug(g: CanvasRenderingContext2D, v: View) {
    if (this.ended) return;
    const T = this.shownTick;
    g.lineWidth = 1;
    g.font = '13px monospace';
    g.textAlign = 'left';
    for (let i = 0; i < this.run.spawns.length; i++) {
      if (!this.run.isVisible(i, T)) continue;
      const s = this.run.spawns[i];
      const { px, py } = positionAt(s, T);
      const a = v.toCss(px, py);
      g.strokeStyle = '#ff00ff';
      g.strokeRect(a.x, a.y, s.entry.w * v.sc, s.entry.h * v.sc);
      g.fillStyle = '#ff00ff';
      g.fillText(`${TYPE_WORD[s.entry.type]} #${i} hp${this.run.beastHp[i]}`, a.x + 2, a.y + 13);
    }
  }

  private exposeDebug() {
    if (!import.meta.env.DEV) return;
    const toClient = (fx: number, fy: number) => {
      const rect = this.stage.canvas.getBoundingClientRect();
      const k = rect.width / (this.stage.canvas.clientWidth || 1);
      const c = this.stage.fieldToCss(fx, fy);
      return { x: rect.left + c.x * k, y: rect.top + c.y * k };
    };
    const api = {
      run: this.run,
      tick: () => this.shownTick,
      /** Visible Beasts, with a hittable point (centre of an occupied cell) in client pixels. */
      targets: () => {
        const T = this.shownTick;
        const out: { i: number; type: number; boss: boolean; shiny: boolean; hp: number; ready: boolean; x: number; y: number }[] = [];
        for (let i = 0; i < this.run.spawns.length; i++) {
          if (!this.run.isVisible(i, T)) continue;
          const s = this.run.spawns[i];
          const { px, py } = positionAt(s, T);
          let best: [number, number] | null = null;
          let bestD = Infinity;
          for (let cy = 0; cy < 8; cy++) {
            for (let cx = 0; cx < 8; cx++) {
              if (((s.entry.occ >> BigInt(cy * 8 + cx)) & 1n) === 0n) continue;
              const d = (cx - 3.5) ** 2 + (cy - 3.5) ** 2;
              if (d < bestD) { bestD = d; best = [cx, cy]; }
            }
          }
          if (!best) continue;
          const lx = Math.floor(((best[0] + 0.5) * s.entry.w) / 8);
          const ly = Math.floor(((best[1] + 0.5) * s.entry.h) / 8);
          const c = toClient(px + lx + 0.5, py + ly + 0.5);
          out.push({ i, type: s.entry.type, boss: s.boss, shiny: s.shiny, hp: this.run.beastHp[i], ready: this.run.isTargetable(i, T), x: c.x, y: c.y });
        }
        return out;
      },
      /** Client position of a field pixel. */
      client: (x: number, y: number) => toClient(x + 0.5, y + 0.5),
    };
    const w = window as unknown as { __hunt?: typeof api };
    w.__hunt = api;
    this.cleanups.push(() => { if (w.__hunt === api) delete w.__hunt; });
  }

  destroy() {
    // A run left by any route still pays for what it caught.
    if (!this.finished) this.settle();
    this.finished = true;
    this.silence();
    this.timers.forEach((t) => clearTimeout(t));
    this.cleanups.forEach((f) => f());
    this.hud.destroy();
    this.stage.stop();
    this.layer.remove();
  }
}

export function randomSeed(): bigint {
  const b = new Uint8Array(31);
  crypto.getRandomValues(b);
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v >> 3n; // < 2^245, a valid felt
}
