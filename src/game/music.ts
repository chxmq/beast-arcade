// Chiptune score: three menu themes (attract, select, prize counter) and the in-game music, whose
// layers follow the game's intensity: 0 sparse (nothing on screen), 1 groove (Beasts on screen),
// 2 pressure (combo 5+, crowded screen, last life, the King), 3 FEVER (combo 10+): everything,
// plus a lead arpeggio. A tiny step sequencer schedules notes ahead of time on the pulse, triangle
// and noise channels of audio.ts. Only one thing plays at a time; switching crossfades.
import { mf, sound, type Wave } from './audio.ts';

export type Theme = 'attract' | 'select' | 'prizes';

const LOOKAHEAD = 0.12;
const FADE = 0.25;

// ------------------------------------------------------------------ notation

interface TrackDef {
  w: Wave;
  v: number;
  /** One token per 16th step: a note (C5, F#4, Bb3), '.' rest, '-' holds the previous note. '|' is ignored. */
  n: string;
  /** Fraction of a note's length that sounds (staccato < 1). */
  gate?: number;
  /** Volume envelope: decay steps, the level it settles at (fraction), and how long the decay takes. */
  steps?: number;
  sustain?: number;
  decay?: number;
  /** Vibrato depth in cents on notes of 4+ steps. */
  vib?: number;
  /** Shift by this many steps (echo tracks). */
  shift?: number;
  /** Transpose by octaves. */
  oct?: number;
  /** Intensity range this track plays in (game music). */
  min?: number;
  max?: number;
}

/** Drums: one token per step, each letter a hit (k kick, s snare, h hat, g ghost hat, o open hat, t tick), '.' rest. */
interface DrumDef {
  p: string;
  v?: number;
  min?: number;
  max?: number;
}

interface SongDef {
  bpm: number;
  /** Steps per bar (16 for 4/4, 12 for 3/4). Only used to check the notation. */
  bar: number;
  /** Output level of the whole song. */
  gain: number;
  /** Delay of every odd 16th, as a fraction of a step. */
  swing?: number;
  tracks: TrackDef[];
  drums: DrumDef[];
}

interface Ev {
  midi: number;
  len: number;
}
interface Track extends TrackDef {
  ev: (Ev | null)[];
  len: number;
}
interface Drums extends DrumDef {
  ev: (string | null)[];
  len: number;
}
interface Song {
  bpm: number;
  gain: number;
  swing: number;
  tracks: Track[];
  drums: Drums[];
}

const NOTE = /^([A-G])(#|b)?(-?\d)$/;
const SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const tokens = (s: string) => s.split(/\s+/).filter((x) => x && x !== '|');

function midiOf(tok: string): number | null {
  const m = NOTE.exec(tok);
  if (!m) return null;
  return 12 * (Number(m[3]) + 1) + SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

function compile(def: SongDef, name: string): Song {
  const check = (len: number, what: string) => {
    if (len % def.bar) console.warn(`music ${name}: ${what} has ${len} steps, not whole bars of ${def.bar}`);
  };
  const tracks = def.tracks.map((t, ti): Track => {
    const tk = tokens(t.n);
    const len = tk.length;
    const ev: (Ev | null)[] = new Array(len).fill(null);
    for (let i = 0; i < len; i++) {
      const m = midiOf(tk[i]);
      if (m === null) {
        if (tk[i] !== '.' && tk[i] !== '-') console.warn(`music ${name}: bad note ${tk[i]}`);
        continue;
      }
      let l = 1;
      while (i + l < len && tk[i + l] === '-') l++;
      ev[(i + (t.shift ?? 0)) % len] = { midi: m + 12 * (t.oct ?? 0), len: l };
    }
    check(len, `track ${ti}`);
    return { ...t, ev, len };
  });
  const drums = def.drums.map((d, di): Drums => {
    const tk = tokens(d.p);
    check(tk.length, `drums ${di}`);
    return { ...d, ev: tk.map((x) => (x === '.' ? null : x)), len: tk.length };
  });
  return { bpm: def.bpm, gain: def.gain, swing: def.swing ?? 0, tracks, drums };
}

const rep = (s: string, n: number) => Array(n).fill(s).join(' | ');
/** Root-octave-fifth eighth-note bass bar. */
const bass8 = (r: string, o: string, f: string) => `${r} . ${o} . ${f} . ${o} . ${r} . ${o} . ${f} . ${o} .`;
/** A bar of rising 16th arpeggios over four chord tones. */
const arp = (a: string, b: string, c: string, d: string) => rep(`${a} ${b} ${c} ${d}`, 4);

// ------------------------------------------------------------------ attract: heroic C major, 140 BPM

const ATTRACT: SongDef = {
  bpm: 140,
  bar: 16,
  gain: 0.24,
  tracks: [
    {
      // lead
      w: 'p50', v: 0.2, gate: 0.92, steps: 5, sustain: 0.55, decay: 0.1, vib: 18,
      n: `
        E5 . G5 . C6 - - - B5 . G5 . E5 - - . | D5 . G5 . B5 - - - A5 . G5 . D5 - - . |
        C5 . E5 . A5 - - - G5 . E5 . C5 . E5 . | F5 - - - A5 - - - C6 - - - A5 - G5 - |
        E5 . G5 . C6 - - - D6 . C6 . B5 - - . | B5 . D6 . G6 - - - F6 - E6 - D6 - B5 - |
        C6 - A5 - F5 - A5 - B5 - G5 - D6 - B5 - | C6 - - - - - - - G5 . E5 . C5 . . . |
        A5 - - . E5 . A5 . C6 - B5 - A5 - E5 - | F5 - - . C5 . F5 . A5 - G5 - F5 - C5 - |
        E5 - G5 - C6 - E6 - D6 - C6 - G5 - E5 - | D5 - G5 - B5 - D6 - - - - . B5 . D6 . |
        E6 - - . C6 . A5 . C6 - - . E6 . A6 . | A6 - - - G6 - F6 - E6 - C6 - A5 - C6 - |
        D6 . D6 . D6 . E6 . F6 - - . E6 . D6 . | B5 - - - D6 - - - G6 - - - - - - . |`,
    },
    {
      // broken chords under the lead
      w: 'p25', v: 0.07, gate: 0.5, steps: 2,
      n: [
        arp('C4', 'E4', 'G4', 'C5'), arp('G3', 'B3', 'D4', 'G4'), arp('A3', 'C4', 'E4', 'A4'), arp('F3', 'A3', 'C4', 'F4'),
        arp('C4', 'E4', 'G4', 'C5'), arp('G3', 'B3', 'D4', 'G4'), 'F3 A3 C4 F4 F3 A3 C4 F4 G3 B3 D4 G4 G3 B3 D4 G4', arp('C4', 'E4', 'G4', 'C5'),
        arp('A3', 'C4', 'E4', 'A4'), arp('F3', 'A3', 'C4', 'F4'), arp('C4', 'E4', 'G4', 'C5'), arp('G3', 'B3', 'D4', 'G4'),
        arp('A3', 'C4', 'E4', 'A4'), arp('F3', 'A3', 'C4', 'F4'), arp('G3', 'B3', 'D4', 'G4'), arp('G3', 'B3', 'D4', 'G4'),
      ].join(' | '),
    },
    {
      // bass
      w: 'tri', v: 0.55, gate: 0.85,
      n: [
        bass8('C3', 'C4', 'G3'), bass8('G2', 'G3', 'D3'), bass8('A2', 'A3', 'E3'), bass8('F2', 'F3', 'C3'),
        bass8('C3', 'C4', 'G3'), bass8('G2', 'G3', 'D3'), 'F2 . F3 . C3 . F3 . G2 . G3 . D3 . G3 .', 'C3 . C4 . G3 . C4 . C3 . G2 . A2 . B2 .',
        bass8('A2', 'A3', 'E3'), bass8('F2', 'F3', 'C3'), bass8('C3', 'C4', 'G3'), bass8('G2', 'G3', 'D3'),
        bass8('A2', 'A3', 'E3'), bass8('F2', 'F3', 'C3'), bass8('G2', 'G3', 'D3'), 'G2 . G3 . D3 . G3 . G2 . A2 . B2 . D3 .',
      ].join(' | '),
    },
  ],
  drums: [{ p: `${rep('k . h . s . h . k . k h s . h .', 7)} | k . h . s . h . s . s s s s s s` }],
};

// ------------------------------------------------------------------ select: laid-back F major, 112 BPM, swung

const SELECT: SongDef = {
  bpm: 112,
  bar: 16,
  gain: 0.2,
  swing: 0.16,
  tracks: [
    {
      w: 'p25', v: 0.17, gate: 0.95, steps: 6, sustain: 0.5, decay: 0.14, vib: 20,
      n: `
        A5 - - - . . C6 . A5 . G5 - F5 - - - | E5 - - - . . G5 . E5 . D5 - C5 - - - |
        D5 - F5 - A5 - C6 - - - A5 . G5 - F5 - | E5 - - - - - - - . . . . G5 . A5 . |
        Bb5 - - - A5 . G5 . F5 - - - D5 - F5 - | E5 - - - C5 - E5 - A5 - - - G5 - E5 - |
        D5 - - . F5 . Bb5 . A5 - G5 - F5 - E5 - | C5 - - - - - - - . . . . . . . . |`,
    },
    // chord stabs on the off-beats: the 3rd and the 7th of each chord
    ...[
      ['A4', 'C5', 'F4', 'E4', 'D5', 'C5', 'Bb4', 'E4'],
      ['E5', 'G4', 'C5', 'B4', 'A4', 'G4', 'F4', 'Bb4'],
    ].map((notes): TrackDef => ({
      w: 'p12', v: 0.06, gate: 0.7, steps: 2,
      n: notes.map((x) => `. . ${x} . . . ${x} . . . ${x} . . . ${x} .`).join(' | '),
    })),
    {
      w: 'tri', v: 0.55, gate: 0.8,
      n: [
        'F2 . . F3 . . C3 . F2 . . F3 . C3 . .', 'A2 . . A3 . . E3 . A2 . . A3 . E3 . .',
        'D3 . . D4 . . A3 . D3 . . D4 . A3 . .', 'C3 . . C4 . . G3 . C3 . . C4 . G3 . .',
        'Bb2 . . Bb3 . . F3 . Bb2 . . Bb3 . F3 . .', 'A2 . . A3 . . E3 . A2 . . A3 . E3 . .',
        'G2 . . G3 . . D3 . G2 . . G3 . D3 . .', 'C3 . . C4 . . G3 . C3 . . C4 E3 . G3 .',
      ].join(' | '),
    },
  ],
  drums: [{ p: `${rep('k . h . s . h k . k h . s . h .', 7)} | k . h . s . h k . k h . s s s s`, v: 0.8 }],
};

// ------------------------------------------------------------------ prize counter: a music-box waltz in G, 124 BPM

const PRIZE_LEAD = `
  D5 - - - B4 - D5 - G5 - - - | E5 - - - B4 - E5 - G5 - - - | E5 - - - C5 - E5 - G5 - E5 - | F#5 - - - D5 - A4 - D5 - - - |
  B5 - - - G5 - B5 - D6 - - - | C6 - B5 - A5 - G5 - E5 - - - | A5 - - - C6 - F#5 - A5 - D5 - | G5 - - - - - G4 - - - - - |
  G5 - - - B5 - D6 - B5 - G5 - | E5 - - - G5 - B5 - G5 - E5 - | C6 - - - B5 - A5 - G5 - E5 - | F#5 - - - A5 - D6 - C6 - A5 - |
  B5 - - - D6 - G6 - D6 - B5 - | G5 - - - E5 - B5 - A5 - G5 - | A5 - C6 - E6 - D6 - C6 - F#5 - | G5 - - - - - - - - - - - |`;

const PRIZES: SongDef = {
  bpm: 124,
  bar: 12,
  gain: 0.2,
  tracks: [
    // plucked lead: every note decays to silence, like a music box tine
    { w: 'p12', v: 0.16, gate: 1, steps: 8, n: PRIZE_LEAD },
    // its echo, a dotted eighth later and an octave up
    { w: 'p12', v: 0.04, gate: 0.6, steps: 4, n: PRIZE_LEAD, shift: 3, oct: 1 },
    // oom...
    {
      w: 'tri', v: 0.55, gate: 0.9,
      n: [
        'G2 - - - . . . . . . . .', 'E2 - - - . . . . . . . .', 'C3 - - - . . . . . . . .', 'D3 - - - . . . . . . . .',
        'G2 - - - . . . . . . . .', 'E2 - - - . . . . . . . .', 'A2 - - - D3 - - - . . . .', 'G2 - - - D3 - - - G2 - - -',
      ].join(' | '),
    },
    // ...pah pah
    ...[
      ['B3', 'G3', 'C4', 'A3', 'B3', 'G3', 'F#3', 'B3'],
      ['D4', 'B3', 'E4', 'D4', 'D4', 'B3', 'A3', 'D4'],
    ].map((notes): TrackDef => ({
      w: 'p25', v: 0.06, gate: 0.7, steps: 3,
      n: notes.map((x) => `. . . . ${x} - . . ${x} - . .`).join(' | '),
    })),
  ],
  drums: [{ p: 'k . . . t . . . t . . .', v: 0.6 }],
};

// ------------------------------------------------------------------ in-game: A minor drive, 150 BPM, layered by intensity

const GAME: SongDef = {
  bpm: 150,
  bar: 16,
  gain: 0.2,
  tracks: [
    // 0: just the roots
    { w: 'tri', v: 0.5, gate: 0.9, max: 0, n: 'A2 - - - . . . . A2 - - - . . . . | A2 - - - . . . . A2 - - - . . . . | F2 - - - . . . . F2 - - - . . . . | G2 - - - . . . . G2 - - - . . . .' },
    // 1+: driving octave bass
    {
      w: 'tri', v: 0.55, gate: 0.8, min: 1,
      n: 'A2 . A3 . A2 . A3 . A2 . A3 . A2 . A3 . | A2 . A3 . A2 . A3 . A2 . A3 . G2 . G3 . | F2 . F3 . F2 . F3 . F2 . F3 . F2 . F3 . | G2 . G3 . G2 . G3 . G2 . G3 . E2 . E3 .',
    },
    // 1-2: the hook
    {
      w: 'p50', v: 0.13, gate: 0.95, steps: 5, sustain: 0.5, decay: 0.1, vib: 18, min: 1, max: 2,
      n: 'E5 - - - . . D5 . C5 - - - . . . . | A4 - - - . . C5 . E5 - - - . . . . | F5 - - - . . E5 . C5 - - - A4 - - - | B4 - - - . . C5 . D5 - - - . . . .',
    },
    // 2+: the riff
    {
      w: 'p25', v: 0.1, gate: 0.6, steps: 2, min: 2,
      n: 'A4 . C5 . E5 . A4 . C5 . E5 . G5 . E5 . | A4 . C5 . E5 . A5 . G5 . E5 . C5 . E5 . | F4 . A4 . C5 . F5 . E5 . C5 . A4 . C5 . | G4 . B4 . D5 . G5 . F5 . D5 . B4 . D5 .',
    },
    // 3: FEVER lead arpeggio
    {
      w: 'p12', v: 0.09, gate: 0.6, steps: 2, min: 3,
      n: `
        A5 C6 E6 A6 E6 C6 A5 C6 E6 A6 C7 A6 E6 C6 A5 E5 | A5 C6 E6 A6 E6 C6 A5 C6 E6 A6 C7 A6 E6 C6 A5 E5 |
        F5 A5 C6 F6 C6 A5 F5 A5 C6 F6 A6 F6 C6 A5 F5 C5 | G5 B5 D6 G6 D6 B5 G5 B5 D6 G6 B6 G6 D6 B5 G5 D5 |`,
    },
  ],
  drums: [
    { p: 'k . . . . . . . k . . . . . . .', max: 0 },
    { p: 'k . . . k . . . k . . . k . . .', min: 1 },
    { p: '. . h . . . h . . . h . . . h .', min: 1 },
    { p: '. . . . s . . . . . . . s . . .', min: 2 },
    { p: 'g g . g g g . g g g . g g g . g', min: 2, v: 0.8 },
    { p: '. . o . . . o . . . o . . . o .', min: 3 },
  ],
};

const THEMES: Record<Theme, Song> = {
  attract: compile(ATTRACT, 'attract'),
  select: compile(SELECT, 'select'),
  prizes: compile(PRIZES, 'prizes'),
};
const GAME_SONG = compile(GAME, 'game');

// ------------------------------------------------------------------ playback

function drum(kind: string, out: AudioNode, t: number, v: number) {
  switch (kind) {
    case 'k':
      sound.playNote(out, t, 160, 0.11, 'tri', 0.75 * v, { to: 45, steps: 3 });
      sound.playNoise(out, t, 0.012, 0.07 * v, { hold: 1, steps: 0 });
      break;
    case 's':
      sound.playNoise(out, t, 0.12, 0.3 * v, { hold: 2, steps: 5 });
      sound.playNote(out, t, 220, 0.05, 'tri', 0.3 * v, { to: 140, steps: 2 });
      break;
    case 'h':
      sound.playNoise(out, t, 0.03, 0.12 * v, { hold: 1, steps: 2 });
      break;
    case 'g':
      sound.playNoise(out, t, 0.02, 0.06 * v, { hold: 1, steps: 0 });
      break;
    case 'o':
      sound.playNoise(out, t, 0.14, 0.09 * v, { hold: 1, steps: 6 });
      break;
    case 't':
      sound.playNoise(out, t, 0.025, 0.09 * v, { short: true, hold: 1, steps: 2 });
      break;
  }
}

/** Hold an AudioParam at its current value (cancelAndHoldAtTime where supported). */
function holdAt(p: AudioParam, t: number) {
  if (typeof p.cancelAndHoldAtTime === 'function') {
    p.cancelAndHoldAtTime(t);
  } else {
    const v = p.value;
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
  }
}

class Player {
  private readonly out: GainNode;
  private timer = 0;
  private next: number;
  /** Global 16th-step counter; each track loops over its own length. */
  private g = 0;

  constructor(private song: Song, private level: () => number, fadeIn: number) {
    const ctx = sound.ctx!;
    const now = ctx.currentTime;
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0, now);
    this.out.gain.linearRampToValueAtTime(song.gain, now + fadeIn);
    this.out.connect(sound.bus());
    this.next = now + 0.05;
    this.timer = window.setInterval(() => this.schedule(), 25);
    this.schedule();
  }

  stop(fade: number) {
    clearInterval(this.timer);
    this.timer = 0;
    const ctx = sound.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    holdAt(this.out.gain, t);
    this.out.gain.linearRampToValueAtTime(0, t + fade);
    const out = this.out;
    setTimeout(() => out.disconnect(), (fade + LOOKAHEAD + 0.3) * 1000);
  }

  private schedule() {
    const ctx = sound.ctx;
    if (!ctx) return;
    const step = 60 / this.song.bpm / 4;
    // Catch up after a stall (tab in background) without a burst of notes.
    if (this.next < ctx.currentTime - 0.25) this.next = ctx.currentTime + 0.02;
    while (this.next < ctx.currentTime + LOOKAHEAD) {
      const swing = this.g % 2 === 1 ? this.song.swing * step : 0;
      this.play(this.g, this.next + swing, step);
      this.next += step;
      this.g++;
    }
  }

  private play(g: number, t: number, step: number) {
    const lvl = this.level();
    const on = (x: { min?: number; max?: number }) => (x.min === undefined || lvl >= x.min) && (x.max === undefined || lvl <= x.max);
    for (const tr of this.song.tracks) {
      if (!on(tr)) continue;
      const e = tr.ev[g % tr.len];
      if (!e) continue;
      const d = Math.max(0.03, e.len * step * (tr.gate ?? 0.9));
      sound.playNote(this.out, t, mf(e.midi), d, tr.w, tr.v, {
        steps: tr.steps ?? 0,
        sustain: tr.sustain ?? 0,
        decay: tr.decay,
        vib: e.len >= 4 ? tr.vib : undefined,
      });
    }
    for (const dr of this.song.drums) {
      if (!on(dr)) continue;
      const hits = dr.ev[g % dr.len];
      if (hits) for (const k of hits) drum(k, this.out, t, dr.v ?? 1);
    }
  }
}

class Music {
  /** Game music intensity: 0 sparse, 1 groove, 2 pressure, 3 FEVER. */
  intensity = 0;
  private cur: Player | null = null;
  private playing: Theme | 'game' | null = null;
  private pending: Theme | null = null;
  private waiting: (() => void) | null = null;

  /**
   * Loop a menu theme, crossfading from whatever plays. The same theme again is a no-op. Before the
   * first user gesture (no AudioContext yet) the request is kept and starts on unlock.
   */
  theme(name: Theme) {
    if (this.playing === name || this.pending === name) return;
    if (!sound.ctx) {
      this.pending = name;
      this.waiting ??= sound.onUnlock(() => {
        this.waiting = null;
        const p = this.pending;
        this.pending = null;
        if (p) this.theme(p);
      });
      return;
    }
    this.pending = null;
    this.play(name, THEMES[name]);
  }

  /** In-game music (intensity driven). Stops any theme. */
  start() {
    this.pending = null;
    if (!sound.ctx || this.playing === 'game') return;
    this.play('game', GAME_SONG);
  }

  /** Fade out whatever plays and forget a pending theme. */
  stop() {
    this.pending = null;
    this.cur?.stop(0.3);
    this.cur = null;
    this.playing = null;
  }

  setIntensity(n: number) {
    this.intensity = n;
  }

  private play(name: Theme | 'game', song: Song) {
    const crossfade = this.cur !== null;
    this.cur?.stop(FADE);
    this.cur = new Player(song, name === 'game' ? () => this.intensity : () => 0, crossfade ? FADE : 0.05);
    this.playing = name;
  }
}

export const music = new Music();
