import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Roster } from '../data/roster.ts';
import { beats, Cast, counterOf, TYPE_BUTTON } from './cast.ts';
import { gameDuration } from './engine.ts';
import { BossGame } from './games/boss.ts';
import { CatchGame } from './games/catch.ts';
import { CounterGame } from './games/counter.ts';
import { DodgeGame } from './games/dodge.ts';
import { GROUND as DUEL_GROUND, DuelGame } from './games/duel.ts';
import { EyesGame, FS } from './games/eyes.ts';
import { FeedGame } from './games/feed.ts';
import { createGame } from './games/index.ts';
import { MashGame } from './games/mash.ts';
import { ShinyGame } from './games/shiny.ts';
import { Rng } from './rng.ts';
import { noInput, silentAudio, type Btn, type FrameInput, type GameCtx, type GameId, type Microgame, type Pt, type Status } from './types.ts';

const roster = JSON.parse(readFileSync(new URL('../../public/data/roster.json', import.meta.url), 'utf8')) as Roster;
const cast = new Cast(roster.entries);
const ALL: GameId[] = ['catch', 'counter', 'duel', 'shiny', 'eyes', 'dodge', 'mash', 'feed', 'boss'];

function ctxFor(id: GameId, level: number, seed: number, seenBefore = 0): GameCtx {
  return {
    rng: new Rng(seed),
    level,
    duration: gameDuration(id, level),
    cast,
    partner: cast.small[seed % cast.small.length],
    seenBefore,
    audio: silentAudio,
    calm: false,
  };
}

type Policy = (g: Microgame, dt: number) => FrameInput;
const DT = 1 / 60;

/** Play until decided, the way the engine does (expire at the bell). */
function play(g: Microgame, policy: Policy): Status {
  for (let i = 0; i < 60 * 30 && g.status === 'playing'; i++) {
    g.update(DT, policy(g, DT));
    if (g.status === 'playing' && g.t >= g.duration) g.expire();
  }
  return g.status;
}

const idle: Policy = () => noInput();
const bot: Policy = (g, dt) => g.bot(dt);
const tap = (p: Pt): FrameInput => ({ ...noInput(), taps: [p] });
const press = (b: Btn): FrameInput => ({ ...noInput(), presses: [b] });
const wait = (g: Microgame, secs: number) => {
  for (let t = 0; t < secs && g.status === 'playing'; t += DT) g.update(DT, noInput());
};

describe('every microgame', () => {
  it('is winnable: the scripted demo player clears each one at speeds 1 to 5', () => {
    const fails: string[] = [];
    for (const id of ALL) {
      for (let level = id === 'boss' ? 3 : 0; level <= (id === 'boss' ? 6 : 4); level++) {
        for (let seed = 1; seed <= 16; seed++) {
          const g = createGame(id, ctxFor(id, level, seed * 7919));
          if (play(g, bot) !== 'won') fails.push(`${id} L${level} seed ${seed}`);
        }
      }
    }
    expect(fails).toEqual([]);
  });

  it('loses when the player does nothing', () => {
    const wins: string[] = [];
    for (const id of ALL) {
      for (let seed = 1; seed <= 12; seed++) {
        const g = createGame(id, ctxFor(id, id === 'boss' ? 3 : 0, seed * 104729));
        if (play(g, idle) !== 'lost') wins.push(`${id} seed ${seed}`);
      }
    }
    expect(wins).toEqual([]);
  });

  it('is generated from its seed alone', () => {
    for (const id of ALL) {
      const a = createGame(id, ctxFor(id, 2, 99));
      const b = createGame(id, ctxFor(id, 2, 99));
      expect(a.cast.map((e) => e.speciesId)).toEqual(b.cast.map((e) => e.speciesId));
      expect(a.prompt).toMatch(/!$/);
      expect(a.duration).toBe(gameDuration(id, 2));
    }
  });
});

describe('CATCH!', () => {
  it('a tap on the Beast catches it', () => {
    const g = new CatchGame(ctxFor('catch', 0, 5));
    wait(g, 1);
    g.update(DT, tap({ x: g.x, y: g.cy }));
    expect(g.status).toBe('won');
  });
  it('forgives 2 missed taps at speed 1, none from speed 4', () => {
    const g = new CatchGame(ctxFor('catch', 0, 5));
    wait(g, 0.5);
    const far = { x: g.x > 160 ? 10 : 310, y: 20 };
    g.update(DT, tap(far));
    g.update(DT, tap(far));
    expect(g.status).toBe('playing');
    g.update(DT, tap(far));
    expect(g.status).toBe('lost');
    const h = new CatchGame(ctxFor('catch', 3, 5));
    expect(h.forgive).toBe(0);
    wait(h, 0.5);
    h.update(DT, tap({ x: h.x > 160 ? 10 : 310, y: 20 }));
    expect(h.status).toBe('lost');
  });
  it('the Beast gets away before the bell', () => {
    const g = new CatchGame(ctxFor('catch', 0, 8));
    expect(g.cross).toBeLessThan(g.duration);
    wait(g, g.cross + 0.05);
    expect(g.status).toBe('lost');
  });
});

describe('COUNTER!', () => {
  it('more chargers at higher speeds', () => {
    expect(new CounterGame(ctxFor('counter', 0, 1)).chargers).toHaveLength(1);
    expect(new CounterGame(ctxFor('counter', 2, 1)).chargers).toHaveLength(2);
    expect(new CounterGame(ctxFor('counter', 4, 1)).chargers).toHaveLength(3);
  });
  it('the counter type knocks each charger out', () => {
    const g = new CounterGame(ctxFor('counter', 2, 3));
    const policy: Policy = (gg) => {
      const c = (gg as CounterGame).front;
      return c && c.state === 'run' && gg.t >= c.start + 0.1 ? press(TYPE_BUTTON[counterOf(c.type)]) : noInput();
    };
    expect(play(g, policy)).toBe('won');
  });
  it('tapping the on-screen button counts as the press', () => {
    const g = new CounterGame(ctxFor('counter', 0, 4));
    wait(g, 0.3);
    const need = TYPE_BUTTON[counterOf(g.chargers[0].type)];
    const btn = g.pad.find((p) => p.b === need)!;
    g.update(DT, tap({ x: btn.x, y: btn.y }));
    expect(g.status).toBe('won');
  });
  it('one wrong press is forgiven at speed 1 only', () => {
    for (const level of [0, 1]) {
      const g = new CounterGame(ctxFor('counter', level, 6));
      wait(g, 0.3);
      const wrong = TYPE_BUTTON[g.chargers[0].type];
      g.update(DT, press(wrong));
      expect(g.status).toBe(level === 0 ? 'playing' : 'lost');
      if (level === 0) {
        g.update(DT, press(wrong));
        expect(g.status).toBe('lost');
      }
    }
  });
  it('shows the triangle hint the first two times only', () => {
    expect(new CounterGame(ctxFor('counter', 0, 1, 0)).showTriangle).toBe(true);
    expect(new CounterGame(ctxFor('counter', 0, 1, 1)).showTriangle).toBe(true);
    expect(new CounterGame(ctxFor('counter', 0, 1, 2)).showTriangle).toBe(false);
  });
});

describe('DUEL!', () => {
  const tapFighter = (g: DuelGame, i: 0 | 1) => tap({ x: g.pos(i, g.t).x, y: DUEL_GROUND - g.fighters[i].h / 2 });
  it('never pairs the same type, and the winner follows the triangle', () => {
    for (let seed = 1; seed < 60; seed++) {
      const g = new DuelGame(ctxFor('duel', 0, seed));
      const [a, b] = g.fighters;
      expect(a.type).not.toBe(b.type);
      expect(beats(g.fighters[g.winner].type, g.fighters[1 - g.winner].type)).toBe(true);
    }
  });
  it('tapping the winner wins, the loser loses', () => {
    const g = new DuelGame(ctxFor('duel', 0, 11));
    wait(g, 0.3);
    g.update(DT, tapFighter(g, g.winner));
    expect(g.status).toBe('won');
    const h = new DuelGame(ctxFor('duel', 0, 11));
    wait(h, 0.3);
    h.update(DT, tapFighter(h, (1 - h.winner) as 0 | 1));
    expect(h.status).toBe('lost');
  });
  it('LEFT / RIGHT pick a side', () => {
    const g = new DuelGame(ctxFor('duel', 0, 12));
    wait(g, 0.2);
    g.update(DT, press(g.winner === 0 ? 'LEFT' : 'RIGHT'));
    expect(g.status).toBe('won');
  });
  it('from speed 4 they swap sides first, and taps during the swap are ignored', () => {
    const g = new DuelGame(ctxFor('duel', 3, 13));
    expect(g.swapAt).toBeGreaterThanOrEqual(0);
    wait(g, g.swapAt + 0.1);
    g.update(DT, tapFighter(g, g.winner));
    expect(g.status).toBe('playing');
    wait(g, g.swapDur);
    expect(g.onSide(0)).toBe(1);
    g.update(DT, tapFighter(g, g.winner));
    expect(g.status).toBe('won');
  });
});

describe('SHINY!', () => {
  it('a crowd of 6 to 9 with exactly one shiny', () => {
    const sizes = [0, 1, 2, 4].map((l) => new ShinyGame(ctxFor('shiny', l, 3)).walkers.length);
    expect(sizes).toEqual([6, 7, 8, 9]);
    for (let seed = 1; seed < 30; seed++) {
      const g = new ShinyGame(ctxFor('shiny', 2, seed));
      expect(g.walkers.filter((w) => w.shiny)).toHaveLength(1);
    }
  });
  it('tapping the shiny wins; a wrong Beast is forgiven once at speed 1, never from speed 3', () => {
    const g = new ShinyGame(ctxFor('shiny', 0, 21));
    const s = g.walkers[g.shinyIdx];
    g.update(DT, tap({ x: s.x, y: s.y - g.h / 2 }));
    expect(g.status).toBe('won');
    for (const level of [0, 2]) {
      const h = new ShinyGame(ctxFor('shiny', level, 22));
      // a plain Beast with nobody in front of it
      const plain = h.walkers.find((w) => !w.shiny && !h.walkers.some((o) => o !== w && o.y > w.y && Math.abs(o.x - w.x) < h.w + 6 && Math.abs(o.y - w.y) < h.h + 6))!;
      expect(plain).toBeTruthy();
      h.update(0, tap({ x: plain.x, y: plain.y - h.h / 2 }));
      expect(h.status).toBe(level === 0 ? 'playing' : 'lost');
    }
  });
});

describe('HUMAN EYES!', () => {
  it('hides a clean-mask Beast at high clarity with a generous hitbox', () => {
    const g = new EyesGame(ctxFor('eyes', 0, 31));
    expect(g.beast.maskWarning).toBeNull();
    expect(g.persist).toBeCloseTo(0.93, 5);
    expect(g.margin).toBeGreaterThanOrEqual(4);
    const c = g.centre;
    expect(g.hits(c)).toBe(true);
    expect(g.hits({ x: c.x + (g.beast.w / 2 + 4) * FS, y: c.y })).toBe(true);
    expect(g.hits({ x: c.x + (g.beast.w / 2 + 8) * FS, y: c.y })).toBe(false);
  });
  it('a tap on the motion finds it; three misses lose at speed 1', () => {
    const g = new EyesGame(ctxFor('eyes', 0, 32));
    wait(g, 0.8);
    g.update(DT, tap(g.centre));
    expect(g.status).toBe('won');
    const h = new EyesGame(ctxFor('eyes', 0, 33));
    wait(h, 0.5);
    const miss = () => {
      const c = h.centre;
      return { x: c.x > 160 ? 6 : 314, y: c.y > 90 ? 6 : 174 };
    };
    h.update(DT, tap(miss()));
    h.update(DT, tap(miss()));
    expect(h.status).toBe('playing');
    h.update(DT, tap(miss()));
    expect(h.status).toBe('lost');
  });
  it('every frame of the static is balanced noise, inside the Beast as much as outside', () => {
    const g = new EyesGame(ctxFor('eyes', 0, 34));
    let inside = 0;
    let insideN = 0;
    let all = 0;
    let allN = 0;
    for (let f = 0; f < 90; f++) {
      g.preview(DT);
      const rb = g.render();
      const cur = g.field.cur;
      for (let i = 0; i < cur.length; i++) all += cur[i];
      allN += cur.length;
      for (let y = 0; y < rb.h; y++) for (let x = 0; x < rb.w; x++) {
        if (!rb.mask[y * rb.w + x]) continue;
        const fx = rb.px + x;
        const fy = rb.py + y;
        if (fx < 0 || fy < 0 || fx >= g.field.w || fy >= g.field.h) continue;
        inside += cur[fy * g.field.w + fx];
        insideN++;
      }
    }
    expect(all / allN).toBeGreaterThan(0.49);
    expect(all / allN).toBeLessThan(0.51);
    expect(inside / insideN).toBeGreaterThan(0.48);
    expect(inside / insideN).toBeLessThan(0.52);
  });
});

describe('DODGE!', () => {
  it('2 slams at speed 1, 3 from speed 3, and standing still gets you squashed', () => {
    expect(new DodgeGame(ctxFor('dodge', 0, 1)).slams).toBe(2);
    expect(new DodgeGame(ctxFor('dodge', 2, 1)).slams).toBe(3);
    const g = new DodgeGame(ctxFor('dodge', 0, 41));
    expect(play(g, idle)).toBe('lost');
    expect(g.squashed).toBe(true);
  });
  it('stepping out of the shadow survives; surviving to the bell is a win', () => {
    const g = new DodgeGame(ctxFor('dodge', 1, 42));
    const away: Policy = (gg) => {
      const d = gg as DodgeGame;
      if (d.slam.phase !== 'tele') return noInput();
      return { ...noInput(), pointer: { x: d.slam.x > 160 ? 20 : 300, y: 150 }, pointerLead: true };
    };
    expect(play(g, away)).toBe('won');
    expect(g.slam.count).toBe(g.slams);
    const h = new DodgeGame(ctxFor('dodge', 0, 43));
    h.expire();
    expect(h.status).toBe('won');
  });
  it('LEFT/RIGHT steer too', () => {
    const g = new DodgeGame(ctxFor('dodge', 0, 44));
    const x0 = g.px;
    for (let i = 0; i < 20; i++) g.update(DT, { ...noInput(), right: true });
    expect(g.px).toBeGreaterThan(x0 + 40);
  });
});

describe('MASH!', () => {
  it('fills with A presses or taps; B and C do nothing', () => {
    const g = new MashGame(ctxFor('mash', 0, 51));
    expect(g.need).toBe(10);
    expect(g.king.featured && g.king.tier === 1).toBe(true);
    for (let i = 0; i < 4; i++) g.update(DT, press('B'));
    expect(g.presses).toBe(0);
    for (let i = 0; i < 5; i++) g.update(DT, press('A'));
    for (let i = 0; i < 4; i++) g.update(DT, tap({ x: 100, y: 100 }));
    expect(g.status).toBe('playing');
    g.update(DT, press('A'));
    expect(g.status).toBe('won');
  });
  it('the bar drains from speed 3, so slow mashing loses', () => {
    const g = new MashGame(ctxFor('mash', 3, 52));
    expect(g.decay).toBeGreaterThan(0);
    let t = 0;
    const slow: Policy = () => {
      t += DT;
      if (t >= 0.5) {
        t = 0;
        return press('A');
      }
      return noInput();
    };
    expect(play(g, slow)).toBe('lost');
  });
});

describe('FEED!', () => {
  it('three coins in the basket win', () => {
    const g = new FeedGame(ctxFor('feed', 0, 61));
    expect(play(g, bot)).toBe('won');
    expect(g.caught).toBe(3);
  });
  it('a rock in the basket loses (from speed 3)', () => {
    const g = new FeedGame(ctxFor('feed', 2, 62));
    const rock = g.drops.find((d) => d.kind === 'rock')!;
    expect(rock).toBeTruthy();
    const under: Policy = () => ({ ...noInput(), pointer: { x: rock.x, y: 150 }, pointerLead: true });
    expect(play(g, under)).toBe('lost');
    expect(g.caught).toBeLessThan(3);
  });
});

describe('BOSS: KING FIGHT', () => {
  it('a tier 1 Art Hackathon King with an HP bar and a changing stance', () => {
    const g = new BossGame(ctxFor('boss', 3, 71));
    expect(g.king.featured && g.king.tier === 1).toBe(true);
    expect(g.maxHp).toBe(10);
    expect(g.duration).toBeGreaterThanOrEqual(10);
    const stances = new Set<number>();
    for (let i = 0; i < 60 * 5; i++) {
      g.update(DT, noInput());
      stances.add(g.stance);
    }
    expect(stances.size).toBeGreaterThan(1);
  });
  it('the counter lands a hit, a wrong press stuns and does nothing', () => {
    const g = new BossGame(ctxFor('boss', 3, 72));
    wait(g, 0.2);
    expect(g.vulnerable).toBe(true);
    g.update(DT, press(TYPE_BUTTON[counterOf(g.stance)]));
    expect(g.hp).toBe(g.maxHp - 1);
    wait(g, 0.25);
    const hp = g.hp;
    g.update(DT, press(TYPE_BUTTON[g.stance]));
    expect(g.hp).toBe(hp);
    expect(g.stun).toBeGreaterThan(0);
  });
  it('mashing every button is punished (stuns), so it does not win', () => {
    const g = new BossGame(ctxFor('boss', 3, 73));
    let i = 0;
    const spam: Policy = () => press((['A', 'B', 'C'] as const)[i++ % 3]);
    expect(play(g, spam)).toBe('lost');
  });
  it('slams cost hearts and the King outlasts a player who does nothing', () => {
    const g = new BossGame(ctxFor('boss', 3, 74));
    expect(play(g, idle)).toBe('lost');
    expect(g.hearts).toBeLessThan(2);
    expect(g.hp).toBe(g.maxHp);
  });
});
