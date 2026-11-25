// HOW TO PLAY BEAST CATCH: one screen, three live art Beasts (one per type) you can practise on.
// Used as an overlay by the BEAST CATCH select screen (first visit, or C) and as the `primer` route.
import type { App } from '../main.ts';
import type { Roster, RosterEntry } from '../data/roster.ts';
import { controls } from '../arcade/controls.ts';
import { sound } from '../game/audio.ts';
import { pick } from '../game/beasts.ts';
import { saveSettings, settings } from '../game/settings.ts';
import { SpriteStage, TYPE_COLOR, wanderPos, type SpriteSpec } from '../game/sprites.ts';
import { h } from './dom.ts';
import './catch.css';

const CELLS = [
  { type: 0 as const, word: 'MAGIC', how: 'floats around', hab: 'magic' as const },
  { type: 1 as const, word: 'HUNTER', how: 'darts sideways', hab: 'hunter' as const },
  { type: 2 as const, word: 'BRUTE', how: 'stomps along', hab: 'brute' as const },
];
const FW = 140;
const FH = 72;

/** A Beast of each type to show off: Art Hackathon art when there is some, else an original. */
function showcase(roster: Roster, type: number): RosterEntry | null {
  const ok = (e: RosterEntry) => e.type === type && e.w <= 60 && !e.maskWarning;
  const feat = roster.entries.filter((e) => ok(e) && e.featured);
  const any = roster.entries.filter(ok);
  return feat.length && Math.random() < 0.6 ? pick(feat) : any.length ? pick(any) : null;
}

/**
 * Mount the HOW TO PLAY card into `parent`. `onDone` runs when the player is ready (A, START,
 * the button). Returns the cleanup.
 */
export function howToPlay(parent: HTMLElement, roster: Roster, onDone: () => void, onBack?: () => void): () => void {
  const stages: SpriteStage[] = [];
  const timers: number[] = [];
  const offs: (() => void)[] = [];
  const row = h('div', { class: 'cx-howto-row' });
  CELLS.forEach((c, n) => {
    const e = showcase(roster, c.type);
    const box = h('div', { class: 'cx-howto-box' });
    const tag = h('div', { class: 'cx-howto-tag' }, 'CAUGHT!');
    tag.hidden = true;
    const cell = h('div', { class: 'cx-howto-cell', style: `--tc:${TYPE_COLOR[c.type]}` }, box,
      h('div', { class: 'cx-howto-label' }, h('b', {}, c.word), ` ${c.how}`));
    box.append(tag);
    row.append(cell);
    if (!e) return;
    const stage = new SpriteStage(box, { habitat: c.hab, fieldW: FW, fieldH: FH, className: 'cx-mini' });
    stages.push(stage);
    let bornAt = 0;
    let hitAt = -Infinity;
    let hp = 2;
    let gone = false;
    const phase = 0.23 + n * 0.31;
    const spec = (tick: number): SpriteSpec => {
      const t = tick - bornAt;
      const { px, py } = wanderPos(c.type, tick, e.w, e.h, FW, FH, phase);
      return { key: n, entry: e, px, py, age: t, left: 999, shiny: false, king: false, hp, maxHp: 2, hitAt, phase };
    };
    stage.start(() => {}, (tick) => (gone || tick < 0 ? [] : [spec(tick)]));
    // Practice: tap the Beast. Two taps catch it. Nothing is scored or collected here.
    box.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (gone) return;
      const p = stage.toField(ev.clientX, ev.clientY);
      const s = spec(Math.max(0, stage.shownTick));
      const inside = p.x >= s.px - 2 && p.y >= s.py - 2 && p.x < s.px + e.w + 2 && p.y < s.py + e.h + 2;
      if (!inside) {
        sound.miss();
        return;
      }
      hitAt = performance.now();
      if (--hp > 0) {
        sound.hit(1);
        return;
      }
      sound.caught(false, 2);
      stage.exit(s, 'catch', performance.now());
      gone = true;
      tag.hidden = false;
      timers.push(window.setTimeout(() => {
        tag.hidden = true;
        gone = false;
        hp = 2;
        hitAt = -Infinity;
        bornAt = Math.max(0, stage.shownTick);
      }, 900));
    });
  });

  const go = h('button', { class: 'cx-btn primary' }, "[A] LET'S GO");
  const wrap = h('div', { class: 'cx cx-howto' },
    h('div', { class: 'cx-howto-card' },
      h('div', { class: 'cx-howto-head' }, h('h1', {}, 'HOW TO PLAY'), h('span', { class: 'cx-howto-game' }, 'BEAST CATCH')),
      row,
      h('ol', { class: 'cx-howto-rules' },
        h('li', {}, h('b', {}, 'TAP A BEAST TO CATCH IT.'), ' Mouse: click it, or aim and press A.'),
        h('li', {}, h('b', { class: 'hot' }, '3 MISSES IN A ROW JAM.'), ' A jam costs a life, so never tap blind.'),
        h('li', {}, h('b', { class: 'hot' }, 'A BEAST THAT FLEES COSTS A LIFE.'), ' You have five. Watch for the "!".')),
      h('p', { class: 'cx-howto-small' },
        'Rares take 2 taps. ', h('b', { class: 'gold' }, 'Shiny'), ' Beasts pay triple. ', h('b', { class: 'hot' }, 'The King'), ' takes 8. ',
        'Same type in a row builds a chain. Combo 10 is ', h('b', { class: 'gold' }, 'FEVER'), '. Every run pays tickets.'),
      h('div', { class: 'cx-howto-foot' }, go, h('span', { class: 'cx-dim' }, 'Try it: tap the Beasts above.'))));
  parent.append(wrap);

  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    settings.primerSeen = true;
    saveSettings();
    sound.sfx('start');
    onDone();
  };
  go.addEventListener('click', (e) => { e.stopPropagation(); done(); });
  const shownAt = performance.now();
  const ready = () => performance.now() - shownAt > 300;
  offs.push(controls.on('A', () => ready() && done()), controls.on('START', () => ready() && done()));
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    if (e.key === 'Escape') {
      if (onBack) { closed = true; onBack(); } else done();
    }
  };
  window.addEventListener('keydown', onKey);
  return () => {
    closed = true;
    window.removeEventListener('keydown', onKey);
    offs.forEach((f) => f());
    timers.forEach((t) => clearTimeout(t));
    stages.forEach((s) => s.stop());
    wrap.remove();
  };
}

/** The `primer` route: the HOW TO PLAY card on its own, then BEAST CATCH. */
export function primerScreen(app: App) {
  return howToPlay(app.root, app.roster, () => app.go({ name: 'hunt' }), () => app.go({ name: 'arcade' }));
}
