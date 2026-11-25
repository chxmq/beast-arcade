// Draws a MICRO MAYHEM run: the title card, the interstitial (big prompt, control hint, lives,
// score), the play HUD with its bomb fuse, the win/lose stamps, SPEED UP, the boss intro and
// GAME OVER. Pure drawing: reads the run, never changes it.
import { artistOf } from '../game/beasts.ts';
import { artScale, kingTitle, TYPE_LABEL } from './cast.ts';
import { LIVES, speedLabel, type MicroRun } from './engine.ts';
import { clamp, easeBack, easeOut } from './games/base.ts';
import { BUTTON_COLOR, H, HEART_EMPTY, PAL, W, type Gfx } from './gfx.ts';
import type { Microgame } from './types.ts';

export interface ViewOpts {
  demo?: boolean;
}

export function drawRun(g: Gfx, run: MicroRun, o: ViewOpts = {}): void {
  const game = run.game;
  const sh = run.shake;
  const sx = sh ? (Math.random() * 2 - 1) * sh : 0;
  const sy = sh ? (Math.random() * 2 - 1) * sh : 0;
  switch (run.phase) {
    case 'title':
      drawTitle(g, run);
      break;
    case 'prompt':
      if (!game) break;
      g.begin(game.bg, sx, sy);
      game.draw(g);
      drawPrompt(g, run, game);
      break;
    case 'play':
      if (!game) break;
      g.begin(game.bg, sx, sy);
      game.draw(g);
      drawHud(g, run, game);
      break;
    case 'outro':
      if (!game) break;
      g.begin(game.bg, sx, sy);
      game.draw(g);
      drawHud(g, run, game);
      drawOutro(g, run, game);
      break;
    case 'speedup':
      drawSpeedUp(g, run);
      break;
    case 'boss':
      drawBossIntro(g, run);
      break;
    case 'over':
    case 'done':
      g.begin(game?.bg ?? PAL.screen, sx, sy);
      if (game) game.draw(g);
      drawOver(g, run);
      break;
  }
  if (o.demo) drawDemoTag(g, run.clock);
}

// ------------------------------------------------------------------ HUD pieces

function hearts(g: Gfx, run: MicroRun, x: number, y: number, px: number, gap: number): void {
  const since = run.clock - run.lostAt;
  for (let i = 0; i < LIVES; i++) {
    const cx = x + i * gap;
    if (i < run.lives) {
      const beat = run.lives === 1 ? 1 + Math.max(0, Math.sin(run.clock * 9)) * 0.25 : 1;
      g.at(cx, y, beat, 0, () => g.icon('heart', 0, 0, px, PAL.hot, PAL.ink));
    } else if (i === run.lives && since < 0.7) {
      // the heart that was just lost splits and falls
      const k = since / 0.7;
      g.alpha(1 - k, () => {
        g.at(cx - 3 * px * k * 2, y + 14 * px * k * k, 1, -k, () => g.icon('heart', 0, 0, px, PAL.hot, PAL.ink));
        g.at(cx + 3 * px * k * 2, y + 14 * px * k * k, 1, k, () => g.icon('heart', 0, 0, px, PAL.hot, PAL.ink));
      });
    } else {
      g.icon('heartEmpty', cx, y, px, HEART_EMPTY);
    }
  }
}

function scoreText(g: Gfx, run: MicroRun, x: number, y: number, size: number, align: CanvasTextAlign = 'right'): void {
  g.text(String(run.cleared).padStart(2, '0'), x, y, { size, color: PAL.ink, align, outline: PAL.cab, ow: Math.max(1.5, size / 6) });
}

function drawHud(g: Gfx, run: MicroRun, game: Microgame): void {
  if (game.id === 'eyes') {
    // fixed dark bands under the HUD so it reads over the static (the same every frame, everywhere)
    g.rect(0, 0, W, 19, 'rgba(7,7,10,0.82)');
    g.rect(0, H - 10, W, 10, 'rgba(7,7,10,0.82)');
  }
  hearts(g, run, 10, 9, 1, 11);
  scoreText(g, run, W - 8, 9, 8);
  // bomb fuse: burns right to left
  const r = clamp(1 - game.t / game.duration, 0, 1);
  const x0 = 16;
  const x1 = W - 8;
  const y = 176;
  const end = x0 + (x1 - x0) * r;
  const hurry = r < 0.25 && game.status === 'playing';
  g.rect(x0, y - 1, x1 - x0, 3, 'rgba(20,11,11,0.35)');
  g.rect(x0, y - 1, end - x0, 3, hurry && Math.floor(run.clock * 10) % 2 ? PAL.hot : PAL.ink);
  g.rect(x0, y - 1, end - x0, 1, 'rgba(255,255,255,0.35)');
  if (game.status === 'playing') {
    const f = Math.floor(run.clock * 30) % 3;
    g.rect(end - 2, y - 2 - f, 3, 3, PAL.gold);
    g.rect(end - 1, y - 3 - f, 1, 1, PAL.ink);
  }
  g.circle(9, y, 5, PAL.cab, PAL.ink, 1);
  g.rect(8, y - 7, 3, 2, PAL.cab);
  g.circle(7.5, y - 1.5, 1.2, 'rgba(255,255,255,0.6)');
}

// ------------------------------------------------------------------ interstitial

function hintRow(g: Gfx, game: Microgame, cx: number, cy: number): void {
  const label = (s: string, x: number) => g.text(s, x, cy + 1, { size: 8, color: PAL.ink, align: 'left', outline: PAL.cab, ow: 2 });
  switch (game.hint) {
    case 'tap': {
      g.icon('hand', cx - 18, cy, 2, PAL.ink, PAL.ink);
      label('TAP', cx - 4);
      break;
    }
    case 'abc':
      (['A', 'B', 'C'] as const).forEach((b, i) => g.button(b, cx - 20 + i * 20, cy, 7, BUTTON_COLOR[b]));
      break;
    case 'move':
      g.text('<    >', cx, cy + 1, { size: 10, color: PAL.ink, outline: PAL.cab, ow: 2 });
      g.icon('hand', cx, cy, 1, PAL.ink);
      break;
    case 'mash':
      g.button('A', cx - 22, cy, 7, PAL.hot, Math.floor(g.time * 10) % 2 === 0);
      label('MASH', cx - 10);
      break;
    case 'boss':
      (['A', 'B', 'C'] as const).forEach((b, i) => g.button(b, cx - 44 + i * 18, cy, 7, BUTTON_COLOR[b]));
      g.text('+  < >', cx + 30, cy + 1, { size: 8, color: PAL.ink, outline: PAL.cab, ow: 2 });
      break;
  }
}

function drawPrompt(g: Gfx, run: MicroRun, game: Microgame): void {
  const t = run.phaseT;
  const d = run.phaseDur;
  const inK = easeOut(t / 0.12);
  const outK = clamp((t - (d - 0.1)) / 0.1, 0, 1);
  g.fill(PAL.cab, 0.28 * (1 - outK));
  // the slash band
  const off = (1 - inK) * -W + outK * W;
  g.at(off, 0, 1, 0, () => {
    g.poly([-20, 58, W + 20, 46, W + 20, 128, -20, 140], 'rgba(20,11,11,0.94)');
    g.poly([-20, 54, W + 20, 42, W + 20, 46, -20, 58], game.id === 'eyes' ? PAL.cyan : game.id === 'boss' ? PAL.hot : PAL.gold);
    g.poly([-20, 140, W + 20, 128, W + 20, 132, -20, 144], game.id === 'eyes' ? PAL.cyan : game.id === 'boss' ? PAL.hot : PAL.gold);
  });
  // the word slams in
  const k = t < 0.16 ? 2.3 - 1.3 * easeOut(t / 0.16) : 1 + Math.sin(t * 22) * 0.02 * (1 - clamp((t - 0.16) / 0.3, 0, 1));
  g.alpha(1 - outK, () => {
    g.at(160 + outK * 80, 82, k, -0.045, () => {
      g.text(game.prompt, 0, 0, { size: 28, color: PAL.ink, outline: PAL.cab, ow: 4, shadow: PAL.hot, sd: 3, maxW: 290 });
    });
    if (t > 0.08) hintRow(g, game, 160, 113);
    const cap = game.caption;
    if (cap) g.text(cap, 160, 150, { size: 6, color: PAL.cyan, outline: PAL.cab, ow: 2 });
  });
  // big HUD: lives and score
  hearts(g, run, 16, 14, 2, 21);
  g.text('CLEARED', W - 10, 8, { size: 6, color: PAL.ink, align: 'right', outline: PAL.cab, ow: 1.5 });
  scoreText(g, run, W - 10, 23, 16);
  if (run.level > 0) g.text(`SPEED ${speedLabel(run.level)}`, W - 10, 38, { size: 6, color: PAL.gold, align: 'right', outline: PAL.cab, ow: 1.5 });
}

// ------------------------------------------------------------------ outro

function drawOutro(g: Gfx, run: MicroRun, game: Microgame): void {
  const t = run.phaseT;
  const won = run.result === 'won';
  if (game.id === 'boss' && won) return; // the game shows KING DOWN itself
  if (t < 0.12) g.fill(won ? PAL.lime : PAL.hot, (0.28 * (0.12 - t)) / 0.12);
  const word = won ? 'NICE!' : game.id === 'boss' ? 'THE KING WINS' : 'MISS!';
  const k = t < 0.14 ? 1.9 - 0.9 * easeOut(t / 0.14) : 1;
  g.at(160, 44, k, won ? -0.06 : 0.05, () => {
    g.text(word, 0, 0, { size: won ? 22 : 18, color: won ? PAL.lime : PAL.ink, outline: PAL.cab, ow: 3, shadow: won ? PAL.cab : PAL.hot, sd: 3, maxW: 280 });
  });
  if (won && game.id !== 'boss') {
    const pop = easeBack(t * 5);
    g.at(W - 10, 22, pop, 0, () => g.text('+1', 0, 0, { size: 8, color: PAL.lime, align: 'right', outline: PAL.cab, ow: 2 }));
  }
}

// ------------------------------------------------------------------ banners

function drawTitle(g: Gfx, run: MicroRun): void {
  const t = run.phaseT;
  g.begin(PAL.hot);
  g.rays(160, 92, 16, PAL.hotDark, t * 0.5);
  const a = easeBack(t * 3);
  const b = easeBack((t - 0.15) * 3);
  g.at(160, 40, Math.max(0.01, a), -0.06, () => g.text('MICRO', 0, 0, { size: 30, color: PAL.gold, outline: PAL.cab, ow: 4, shadow: PAL.cab, sd: 4 }));
  g.at(160, 72, Math.max(0.01, b), -0.06, () => g.text('MAYHEM', 0, 0, { size: 30, color: PAL.ink, outline: PAL.cab, ow: 4, shadow: PAL.cab, sd: 4 }));
  const p = run.partner;
  const pk = artScale(p, 44);
  const bob = Math.abs(Math.sin(t * 7)) * 5;
  const px = 160;
  if (t > 0.45) {
    g.text('YOUR BEAST', px, 98, { size: 6, color: PAL.ink, outline: PAL.cab, ow: 1.5 });
    g.ellipse(px, 146, 18, 3, 'rgba(20,11,11,0.4)');
    g.sprite(p, px, 145 - bob, { k: pk });
    g.text(p.name.toUpperCase(), px, 156, { size: 8, color: PAL.gold, outline: PAL.cab, ow: 2, maxW: 200 });
  }
  g.text('4 LIVES. DO WHAT IT SAYS. FAST.', 160, 170, { size: 6, color: PAL.ink, outline: PAL.cab, ow: 1.5 });
  if (t > run.phaseDur - 0.6 && Math.floor(t * 8) % 2 === 0) g.text('GET READY', 160, 124 - 4, { size: 8, color: PAL.gold, outline: PAL.cab, ow: 2 });
}

function drawSpeedUp(g: Gfx, run: MicroRun): void {
  const t = run.phaseT;
  g.begin(PAL.gold);
  g.stripes(PAL.hot, 12, t * 420, 0.5);
  g.fill(PAL.cab, 0.15);
  const inX = (1 - easeBack(t * 3.2)) * 320;
  g.at(160 + inX, 70, 1 + Math.sin(t * 18) * 0.03, -0.08, () => g.text('SPEED UP!', 0, 0, { size: 28, color: PAL.ink, outline: PAL.cab, ow: 4, shadow: PAL.hot, sd: 4, maxW: 300 }));
  if (t > 0.3) g.text(speedLabel(run.level), 160, 104, { size: 16, color: PAL.gold, outline: PAL.cab, ow: 3 });
  const chev = Math.floor(t * 10) % 4;
  for (let i = 0; i < 3; i++) g.text('>', 112 + i * 10, 104, { size: 10, color: i <= chev ? PAL.ink : 'rgba(20,11,11,0.3)', outline: PAL.cab, ow: 1 });
  for (let i = 0; i < 3; i++) g.text('<', 208 - i * 10, 104, { size: 10, color: i <= chev ? PAL.ink : 'rgba(20,11,11,0.3)', outline: PAL.cab, ow: 1 });
  // the partner sprints past
  const p = run.partner;
  const x = -30 + (t / run.phaseDur) * 380;
  g.sprite(p, x, 160 - Math.abs(Math.sin(t * 20)) * 6, { k: artScale(p, 32) });
  g.text('MORE TICKETS PER CLEAR', 160, 128, { size: 6, color: PAL.cab });
}

function drawBossIntro(g: Gfx, run: MicroRun): void {
  const t = run.phaseT;
  const game = run.game;
  g.begin(PAL.screen);
  // hazard bands
  for (const y of [0, H - 18]) {
    g.c.save();
    g.c.beginPath();
    g.c.rect(0, y, W, 18);
    g.c.clip();
    g.rect(0, y, W, 18, PAL.cab);
    g.stripes(PAL.hot, 8, t * 120 * (y ? -1 : 1), 1);
    g.c.restore();
  }
  if (Math.floor(t * 6) % 2 === 0) g.text('WARNING', 160, 10, { size: 8, color: PAL.ink, outline: PAL.cab, ow: 2 });
  if (!game || game.id !== 'boss') return;
  const king = game.cast[0];
  const k = artScale(king, 104);
  const rise = easeOut((t - 0.2) / 0.5);
  g.alpha(0.2, () => g.rays(92, 100, 12, PAL.hot, t * 0.6));
  if (t > 0.2) {
    const flash = t < 0.3;
    g.sprite(king, 92, 160 - 2 + (1 - rise) * 120, { k, mode: flash ? 'white' : 'art' });
    g.crown(92, 158 - king.artBox[3] * k - 4 + (1 - rise) * 120, 2);
  }
  const tx = 228;
  const s1 = easeBack((t - 0.5) * 3);
  if (t > 0.5) g.at(tx, 48, s1, -0.05, () => g.text('BOSS STAGE', 0, 0, { size: 14, color: PAL.hot, outline: PAL.cab, ow: 3, shadow: PAL.cab, sd: 2, maxW: 170 }));
  if (t > 0.9) {
    g.text(kingTitle(king), tx, 76, { size: 8, color: PAL.gold, maxW: 170 });
    g.text(`T${king.tier} ${TYPE_LABEL[king.type]}`, tx, 92, { size: 6, color: PAL.ink });
    g.text(`ART BY ${artistOf(king)}`, tx, 106, { size: 6, color: PAL.cyan, maxW: 170 });
  }
  if (t > 1.3) {
    g.text('COUNTER ITS STANCE', tx, 126, { size: 6, color: PAL.ink });
    g.text('DODGE ITS SLAM', tx, 138, { size: 6, color: PAL.ink });
  }
}

function drawOver(g: Gfx, run: MicroRun): void {
  const t = run.phase === 'done' ? 9 : run.phaseT;
  g.fill(PAL.screen, Math.min(0.78, t * 1.6));
  const word = 'GAME OVER';
  const size = 24;
  const total = g.measure(word, size);
  let x = 160 - total / 2;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    const w = g.measure(ch, size);
    const k = clamp((t - 0.1 - i * 0.06) / 0.3, 0, 1);
    const y = 70 - (1 - easeBack(k)) * 80;
    if (k > 0) g.text(ch, x + w / 2, y, { size, color: i < 4 ? PAL.hot : PAL.ink, outline: PAL.cab, ow: 3, shadow: PAL.cab, sd: 3 });
    x += w;
  }
  if (t > 0.8) g.text(`CLEARED ${run.cleared}`, 160, 106, { size: 10, color: PAL.gold, outline: PAL.cab, ow: 2 });
}

function drawDemoTag(g: Gfx, time: number): void {
  g.rrect(W - 46, H - 20, 38, 12, 3, PAL.cab, PAL.gold, 1);
  if (Math.floor(time * 2) % 2 === 0) g.text('DEMO', W - 27, H - 13.5, { size: 6, color: PAL.gold });
}
