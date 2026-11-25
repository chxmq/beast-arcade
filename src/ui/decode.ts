import type { App } from '../main.ts';
import type { RosterEntry } from '../data/roster.ts';
import { maskFromHex, slotFromJson, type SubmitResponse } from '../broadcast/api.ts';
import { leafHash } from '../broadcast/hashes.ts';
import { processProof } from '../broadcast/merkle.ts';
import { buildReport, type MarkKind, type RunReport } from '../broadcast/report.ts';
import { MaskBook, Tape, TAPE_FPS } from '../broadcast/tape.ts';
import { newlyCaught, popcount, rememberDex, rememberedDex } from '../chain/dex.ts';
import { guest } from '../chain/guest.ts';
import { checkReceipt, voyagerTx, type DexUpdated, type ReceiptState } from '../chain/receipt.ts';
import { tickets } from '../arcade/wallet.ts';
import { sound } from '../game/audio.ts';
import { rankedPayout, stripPlan } from '../game/haul.ts';
import { artOf, beastName, typeName } from '../game/beasts.ts';
import { TapeTv } from '../game/tape-tv.ts';
import { positionAt } from '../sim/motion.ts';
import type { Spawn } from '../sim/schedule.ts';
import { JAM_MISSES, PLAYER_LIVES } from '../sim/spec.ts';
import { h, pad, timecode } from './dom.ts';
import './broadcast.css';

export interface DecodeData {
  sub: SubmitResponse;
  strikes: number[];
  callsign: string;
  frames: number;
}

// Arcade palette (ARCADE.md). Gold = you got it, hot = it cost you, type colours as in BEAST CATCH.
const GREEN = '#8dff3a';
const AMBER = '#ffc61a';
const RED = '#ff3b2f';
const INK = '#f4ecd8';
const FAINT = '#4a4150';
const MARK_COLOR: Record<MarkKind, string> = { hit: AMBER, kill: AMBER, overkill: INK, miss: RED, void: FAINT };
const TYPE_COLOR = ['#23d5ff', GREEN, RED];
const DISPLAY = "'Press Start 2P', ui-monospace, monospace";
/** How long overlay callouts stay on screen, in ticks. */
const MARK_TICKS = 70;
const CALLOUT_TICKS = 60;

/** Ranked runs already paid this session: DECODE pays a run's tickets once. */
const paidRuns = new Set<string>();

const mmss = (tick: number) => timecode(tick).slice(3, 8);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const setText = (el: HTMLElement, s: string) => { if (el.textContent !== s) el.textContent = s; };

/** DECODE: the tape replayed now that its seed is public, with every Beast's true position and art. */
export function decodeScreen(app: App, route: { data: DecodeData }) {
  const { sub, strikes, callsign } = route.data;
  const seed = BigInt(sub.seed);
  const slots = sub.roster.map(slotFromJson);
  const art = new Map(app.roster.entries.map((e) => [e.speciesId, e]));
  const entryOf = (rosterIdx: number): RosterEntry | undefined => art.get(slots[rosterIdx].speciesId);
  const nameOf = (s: Spawn) => {
    const e = entryOf(s.rosterIdx);
    return e ? beastName(e, s.prefix, s.suffix) : `species ${slots[s.rosterIdx].speciesId}`;
  };

  // Local replay: the same rules the contract ran, for every strike outcome.
  let report: RunReport;
  try {
    report = buildReport(seed, slots.map((s) => s.entry), sub.nFeatured, strikes);
  } catch (e) {
    return decodeFailed(app, sub, e instanceof Error ? e.message : String(e));
  }
  const { run, result, marks, counts } = report;
  const matchesServer = result.score === sub.result.score && result.digest === BigInt(sub.result.digest)
    && result.caughtMask === maskFromHex(sub.result.caughtMask) && result.shinyMask === maskFromHex(sub.result.shinyMask);
  const proofOk = processProof(sub.proof.map(BigInt), leafHash(sub.k, seed)) === BigInt(sub.root);
  const endTick = run.endTick;
  const boss = run.spawns[run.spawns.length - 1];
  /** Ticks of the hits each Beast took (for its hit pips). */
  const hitTicks = run.spawns.map((s) => marks.filter((m) => m.target === s.i && (m.kind === 'hit' || m.kind === 'kill')).map((m) => m.tick));

  // ------------------------------------------------------------------ layout
  const wrap = h('div', { class: 'he he-decode' });
  const tvBox = h('div', { class: 'he-decode-tv' });
  const tv = new TapeTv(tvBox);
  const overlay = h('canvas', { class: 'he-overlay' });
  tvBox.appendChild(overlay);
  const octx = overlay.getContext('2d')!;
  const hudTime = h('span', {});
  const hudMode = h('span', { class: 'dim' });
  const hudBars = Array.from({ length: PLAYER_LIVES }, () => h('i', {}));
  const hudLives = h('span', { class: 'he-lifebar', title: 'lives' }, ...hudBars);
  const hudCombo = h('span', { class: 'he-dcombo' });
  const hudLost = h('span', { class: 'bad' });
  const tvHud = h('div', { class: 'he-decode-hud' }, hudTime, hudLives, hudCombo, hudMode, hudLost);
  tvBox.appendChild(tvHud);
  const side = h('div', { class: 'he-side' });
  wrap.append(tvBox, side);
  app.root.append(wrap);

  // ------------------------------------------------------------------ summary
  const VERDICT = {
    sweep: { word: 'CLEAN SWEEP', line: `All ${run.spawns.length} Beasts caught, ${plural(result.lives, 'life', 'lives')} left.` },
    survived: { word: 'SURVIVED', line: `${result.kills} of ${run.spawns.length} caught, ${plural(result.lives, 'life', 'lives')} left.` },
    lost: { word: 'TAKEN', line: `${result.kills} of ${run.spawns.length} caught before ${mmss(result.deathTick)}.` },
    jammed: { word: 'JAMMED', line: `${result.kills} of ${run.spawns.length} caught before ${mmss(result.deathTick)}.` },
  }[report.verdict];
  const chain = report.bestChain;

  const stat = (label: string, value: string, cls = '') => h('div', { class: `he-stat ${cls}` }, h('span', {}, label), h('b', {}, value));
  /** Swatches drawn like their overlay marks: rings for strikes, a dashed box for a Beast that got away. */
  const legendItem = (swatch: string, label: string, n: number, title: string) =>
    h('span', { title }, h('i', { style: swatch }), `${label} ${n}`);
  const ring = (c: string, dash = false) => `border:2px ${dash ? 'dashed' : 'solid'} ${c};border-radius:50%`;
  const chainName = chain.len ? `${chain.len} ${typeName(chain.type).toUpperCase()}${chain.len > 1 && chain.type !== 0 ? 'S' : ''}` : 'none';

  // Lives timeline: one lane per life, filled until the moment it was lost.
  const lanes = h('div', { class: 'he-lanes' });
  const laneLabels = h('div', { class: 'he-lane-labels' });
  const playhead = h('div', { class: 'he-playhead' });
  for (let i = 0; i < PLAYER_LIVES; i++) {
    const lost = report.livesLost[i];
    const until = lost ? lost.tick : endTick;
    const pct = Math.max(1.5, Math.min(100, (100 * until) / endTick));
    lanes.append(h('div', { class: 'he-lane' }, h('i', { class: lost ? 'lost' : 'kept', style: `width:${pct.toFixed(2)}%` })));
    const label = !lost
      ? h('div', { class: 'kept' }, 'KEPT')
      : lost.cause === 'jam'
        ? h('div', { class: 'bad' }, `${mmss(lost.tick)} JAMMED`)
        : h('div', { title: nameOf(run.spawns[lost.idx]) }, `${mmss(lost.tick)} `, h('span', { class: 'dim' }, nameOf(run.spawns[lost.idx]).toUpperCase()));
    laneLabels.append(label);
  }
  lanes.append(playhead);
  const livesEl = h('div', { class: 'he-lives', title: 'click to jump' }, lanes, laneLabels);

  const killerCard = () => {
    if (report.verdict === 'jammed') {
      return h('div', { class: 'he-killer jam' }, h('div', { class: 'jam-box' }, 'JAM'),
        h('div', {}, h('div', {}, `JAMMED at ${mmss(result.deathTick)}`),
          h('div', { class: 'dim' }, `${JAM_MISSES} misses in a row on the last life. No Beast took this one.`)));
    }
    if (report.verdict !== 'lost') return null;
    const s = run.spawns[result.killer];
    const e = entryOf(s.rosterIdx);
    const img = e ? (artOf(e).cloneNode() as HTMLImageElement) : null;
    return h('div', { class: 'he-killer' }, img ?? '',
      h('div', {}, h('div', {}, `TAKEN at ${mmss(result.deathTick)}`),
        h('div', { class: 'dim' }, `${nameOf(s)} got away with the last life. ${e ? `${typeName(e.type)} T${e.tier}.` : ''}`)));
  };
  const kingLine = () => {
    const k = report.kills.find((x) => x.idx === boss.i);
    if (k) return h('div', { class: 'he-king won' }, `THE KING fell at ${mmss(k.tick)}: +${k.pts}`);
    if (run.killedBy[boss.i] === 'escaped') return h('div', { class: 'he-king' }, `THE KING got away at ${mmss(boss.escapeTick)}`);
    if (result.deathTick < boss.spawnTick) return h('div', { class: 'he-king' }, 'THE KING never came: the run ended first');
    return h('div', { class: 'he-king' }, 'THE KING outlasted your lives');
  };

  // TICKETS: the arcade pays every run once (local wallet; nothing here touches the ranked protocol).
  const payout = rankedPayout(result.kills, report.kills.some((x) => x.idx === boss.i), report.verdict === 'sweep');
  const runKey = `${sub.rootId}:${sub.k}:${sub.nonce}`;
  const payNow = !paidRuns.has(runKey);
  if (payNow) {
    paidRuns.add(runKey);
    if (payout.total > 0) tickets.add(payout.total, 'eyes');
  }
  const tixCount = h('b', {}, `+${payNow ? 0 : payout.total}`);
  const tixStrip = h('div', { class: 'he-tix-strip' });
  const tixEl = h('div', { class: 'he-tix' },
    h('div', { class: 'he-tix-head' }, h('span', {}, 'TICKETS'), tixCount),
    tixStrip,
    h('div', { class: 'he-tix-lines' }, payout.lines.length ? payout.lines.map((l) => `${l.label} +${l.tickets}`).join(' . ') : 'Catch a Beast to earn tickets.'));
  const tixTimers: number[] = [];
  const plan = stripPlan(payout.total, 16);
  for (let i = 0; i < plan.stubs; i++) {
    tixTimers.push(window.setTimeout(() => {
      tixStrip.append(h('i', { class: 'he-stub' }));
      tixCount.textContent = `+${Math.min(payout.total, (i + 1) * plan.per)}`;
      if (payNow) sound.sfx('ticket');
      if (i === plan.stubs - 1) tixEl.classList.add('done');
    }, (payNow ? 700 : 100) + i * (payNow ? 90 : 10)));
  }

  // CAUGHT THIS RUN: one card per roster entry caught at least once (bits of caughtMask).
  const rosterSize = app.roster.entries.length;
  const cards = new Map<number, HTMLElement>();
  const caughtRow = h('div', { class: 'dex-caught' });
  for (const c of report.caught) {
    const e = entryOf(c.rosterIdx);
    const img = e ? (artOf(e).cloneNode() as HTMLImageElement) : null;
    const name = e ? e.name : `species ${slots[c.rosterIdx]?.speciesId ?? c.rosterIdx}`;
    if (img) img.alt = name;
    const card = h('div', { class: `dex-card${c.shiny ? ' shiny' : ''}`, title: `${name}${c.shiny ? ' (shiny)' : ''}${c.count > 1 ? `, caught ${c.count}x` : ''}` },
      img ?? h('div', { class: 'dex-noart' }, '?'),
      h('span', { class: 'dex-name' }, name),
      c.shiny ? h('span', { class: 'dex-shiny' }, 'SHINY') : null,
      c.count > 1 ? h('span', { class: 'dex-n' }, `x${c.count}`) : null);
    cards.set(c.rosterIdx, card);
    caughtRow.append(card);
  }
  const dexEl = h('div', { class: 'dex-line' });
  const markNew = (d: DexUpdated) => {
    const fresh = newlyCaught(result.caughtMask, d.newSpecies, rememberedDex(guest.pub)?.caught ?? null);
    if (fresh !== null) {
      for (const [r, card] of cards) {
        if (((fresh >> BigInt(r)) & 1n) === 1n && !card.classList.contains('new')) {
          card.classList.add('new');
          card.append(h('span', { class: 'dex-badge' }, 'NEW ONCHAIN'));
        }
      }
    }
    // The dex after this run, if the dex before it was known and consistent.
    const prior = rememberedDex(guest.pub);
    if (prior && fresh !== null && popcount(prior.caught | result.caughtMask) === d.totalSpecies) {
      rememberDex(guest.pub, { caught: prior.caught | result.caughtMask, shiny: prior.shiny | result.shinyMask, catches: prior.catches + result.kills });
    }
    dexEl.className = 'dex-line done';
    dexEl.textContent = `ONCHAIN BESTIARY +${d.newSpecies} new, ${d.totalSpecies}/${rosterSize} total`;
  };

  const statusEl = h('div', { class: 'he-status' });
  const txEl = h('div', {});
  if (sub.txHash) {
    txEl.append('TX ', h('a', { href: voyagerTx(sub.txHash), target: '_blank', rel: 'noopener' }, `${sub.txHash.slice(0, 10)}..${sub.txHash.slice(-6)}`), h('span', { class: 'dim' }, ' on Voyager'));
  } else txEl.append(h('span', { class: 'dim' }, 'TX none'));

  const btn = (label: string, fn: () => void) => {
    const b = h('button', { class: 'he-dbtn' }, label);
    b.addEventListener('click', fn);
    return b;
  };
  const pauseBtn = btn('[SPACE] PAUSE', () => togglePause());
  const speedBtns = [1, 4].map((v) => btn(`[${v}] ${v}X`, () => setSpeed(v)));

  side.append(
    h('div', { class: 'he-dtitle' }, h('h1', {}, 'DECODE'), h('span', { class: 'dim' }, `HUMAN EYES . ${callsign} . TAPE ${sub.k} . ${sub.offchain ? 'OFFCHAIN TEST' : `ROOT #${sub.rootId}`}`)),
    h('div', { class: `he-verdict ${report.verdict}` }, VERDICT.word),
    h('div', { class: 'he-vline' }, VERDICT.line),
    h('div', { class: 'he-score' }, h('span', {}, 'SCORE'), h('b', {}, pad(result.score, 6))),
    h('div', { class: 'he-stats' },
      stat('KILLS', `${result.kills}/${run.spawns.length}`),
      stat('BEST COMBO', `x${result.bestCombo}`),
      stat('BEST CHAIN', chainName),
      stat('LIVES', `${result.lives}/${PLAYER_LIVES}`, result.lives ? '' : 'bad'),
    ),
    kingLine(),
    tixEl,
    killerCard() ?? '',
    h('h2', {}, `CAUGHT THIS RUN ${report.caught.length}`),
    report.caught.length ? caughtRow : h('div', { class: 'dim' }, 'Nothing caught this run.'),
    dexEl,
    h('h2', {}, 'LIVES'),
    livesEl,
    h('h2', {}, `STRIKES ${strikes.length}`),
    h('div', { class: 'he-legend' },
      legendItem(ring(AMBER), 'HIT', counts.hits, 'struck a live Beast'),
      legendItem(ring(INK, true), 'OVERKILL', counts.overkills, 'struck a Beast already caught: never hurts'),
      legendItem(ring(RED), 'MISS', counts.misses, `struck empty noise: breaks the combo, ${JAM_MISSES} in a row jam`),
      legendItem(`background:${RED}`, 'JAMS', report.jams.length, `${JAM_MISSES} misses in a row: one life each`),
      legendItem(`border:2px dashed ${RED}`, 'GOT AWAY', report.escapes.length, 'Beasts that escaped: one life each, two for a Bane'),
      counts.void ? legendItem(ring(FAINT), 'AFTER DEATH', counts.void, 'sent after the last life was gone') : null,
    ),
    h('h2', {}, 'THE REVEAL'),
    h('div', { class: 'he-mono' }, `seed ${sub.seed.slice(0, 12)}..${sub.seed.slice(-8)}`),
    h('div', { class: 'he-mono dim' }, `${proofOk ? 'proof folds to' : 'PROOF DOES NOT MATCH'} root ${sub.root.slice(0, 10)}..${sub.root.slice(-6)} (${sub.proof.length} siblings)`),
    h('div', { class: 'he-mono dim' }, matchesServer ? 'this replay matches the relayer\'s result' : 'this replay DIFFERS from the relayer\'s result'),
    txEl,
    statusEl,
    h('div', { class: 'he-ctrl' },
      pauseBtn, ...speedBtns,
      btn('[N] NEXT STRIKE', () => nextStrike()),
      btn('[B] HUMAN EYES', () => app.go({ name: 'broadcast' })),
      btn('[ESC] ARCADE', () => app.go({ name: 'arcade' }))),
    h('div', { class: 'he-keys dim' }, h('b', {}, 'LEFT'), ' / ', h('b', {}, 'RIGHT'), ' skip 10 s  ', h('b', {}, 'R'), ' restart'),
  );

  // ------------------------------------------------------------------ receipt
  let receiptTimer = 0;
  const setStatus = (s: ReceiptState | { kind: 'offchain' }) => {
    statusEl.className = `he-status ${s.kind}`;
    if (s.kind === 'offchain') statusEl.textContent = 'offchain test: not sent to Starknet (no relayer configured)';
    else if (s.kind === 'pending') statusEl.textContent = `verifying on Starknet... (${s.note})`;
    else if (s.kind === 'verified') {
      const same = s.event.score === result.score && s.event.kills === result.kills;
      statusEl.textContent = `verified onchain: RunVerified, score ${s.event.score}, run #${s.event.runId}${same ? '' : ' (differs from this replay)'}`;
      if (s.dex) markNew(s.dex);
      else {
        dexEl.className = 'dex-line';
        dexEl.textContent = 'ONCHAIN BESTIARY: this contract did not report a dex update for the run';
      }
    } else if (s.kind === 'reverted') statusEl.textContent = `reverted onchain: ${s.reason.slice(0, 160)}`;
    else statusEl.textContent = s.reason;
  };
  let disposed = false;
  if (!sub.txHash) {
    setStatus({ kind: 'offchain' });
    dexEl.textContent = 'ONCHAIN BESTIARY: not written (offchain test)';
  } else {
    setStatus({ kind: 'pending', note: 'sent' });
    dexEl.textContent = 'ONCHAIN BESTIARY: written once the run is verified';
    let polls = 0;
    const poll = async () => {
      const s = await checkReceipt(sub.txHash!, sub.contract);
      if (disposed) return;
      setStatus(s);
      if (s.kind === 'pending' && ++polls < 200) receiptTimer = window.setTimeout(() => void poll(), 3000);
    };
    receiptTimer = window.setTimeout(() => void poll(), 1500);
  }

  // ------------------------------------------------------------------ playback
  const total = route.data.frames;
  const spec = { seed, slots, nFeatured: sub.nFeatured };
  const book = new MaskBook((id) => art.get(id));
  let tape = new Tape(spec, book);
  let paused = false;
  let speed = 1;
  let acc = 0;
  let last = performance.now();
  for (const s of run.spawns) { const e = entryOf(s.rosterIdx); if (e) artOf(e); }

  const seek = (f: number) => {
    f = Math.max(0, Math.min(tape.frames - 1, Math.round(f)));
    if (f < tape.frame) tape = new Tape(spec, book);
    tape.seek(f);
    tv.draw(tape.field.cur);
  };
  seek(0);
  const togglePause = () => { paused = !paused; setText(pauseBtn, paused ? '[SPACE] PLAY' : '[SPACE] PAUSE'); };
  const setSpeed = (v: number) => {
    speed = v;
    speedBtns.forEach((b, i) => b.classList.toggle('on', [1, 4][i] === v));
  };
  setSpeed(1);
  const nextStrike = () => {
    const next = marks.find((m) => m.tick > 2 * tape.frame + 1);
    if (next) seek(next.tick / 2 - 15);
  };
  livesEl.addEventListener('pointerdown', (e) => {
    const r = lanes.getBoundingClientRect();
    const k = (e.clientX - r.left) / r.width;
    if (k >= 0 && k <= 1) seek((k * endTick) / 2);
  });

  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    let dt = now - last;
    last = now;
    if (dt > 250) dt = 1000 / TAPE_FPS;
    if (!paused && tape.frame < tape.frames - 1) {
      acc += (dt * TAPE_FPS * speed) / 1000;
      const n = Math.min(Math.floor(acc), 12);
      acc -= Math.floor(acc);
      if (n > 0) {
        for (let i = 0; i < n && tape.frame < tape.frames - 1; i++) tape.step();
        tv.draw(tape.field.cur);
      }
    }
    drawOverlay();
  };
  let raf = requestAnimationFrame(loop);

  function drawOverlay() {
    const c = overlay;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(c.clientWidth * dpr);
    const H = Math.round(c.clientHeight * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const g = octx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, c.clientWidth, c.clientHeight);
    g.imageSmoothingEnabled = false;
    const sc = tv.cssScale;
    const T = 2 * Math.max(0, tape.frame);
    const fontPx = Math.max(14, Math.round(5 * sc));
    g.font = `${fontPx}px VT323, monospace`;
    g.textBaseline = 'bottom';
    g.lineJoin = 'round';
    /** Text with a black outline, readable on static. */
    const label = (text: string, x: number, y: number, color: string, outline = 3) => {
      g.strokeStyle = '#000';
      g.lineWidth = outline;
      g.strokeText(text, x, y);
      g.fillStyle = color;
      g.fillText(text, x, y);
    };

    // Every Beast on the tape, with its art, box and name. Killed ones stay on the tape (it
    // cannot react): clicking them again is an overkill, which never hurts.
    for (const s of run.spawns) {
      if (T < s.spawnTick || T >= s.escapeTick) continue;
      const e = entryOf(s.rosterIdx);
      const { px, py } = positionAt(s, T);
      const p = tv.fieldToCss(px, py);
      const w = s.entry.w * sc;
      const hh = s.entry.h * sc;
      const tuned = run.killedBy[s.i] === 'player' && run.resolvedAt[s.i] <= T;
      g.globalAlpha = tuned ? 0.25 : 0.55;
      const img = e ? artOf(e) : null;
      if (img && img.complete && img.naturalWidth) {
        const [bx, by, bw, bh] = e!.artBox;
        g.drawImage(img, bx, by, bw, bh, p.x, p.y, w, hh);
      }
      const color = tuned ? AMBER : TYPE_COLOR[s.entry.type];
      g.globalAlpha = 0.9;
      g.strokeStyle = color;
      g.lineWidth = 1;
      g.setLineDash(tuned ? [4, 3] : []);
      g.strokeRect(p.x + 0.5, p.y + 0.5, w, hh);
      g.setLineDash([]);
      // Hit pips for Beasts that take more than one hit (featured: 2, the King: 8+).
      if (s.hp > 1) {
        const taken = hitTicks[s.i].filter((t) => t <= T).length;
        const d = Math.max(3, Math.round(1.6 * sc));
        for (let j = 0; j < s.hp; j++) {
          const x = p.x + 3 + j * (d + 2);
          const y = p.y + hh - d - 3;
          g.fillStyle = '#000';
          g.fillRect(x - 1, y - 1, d + 2, d + 2);
          g.fillStyle = j < taken ? AMBER : FAINT;
          g.fillRect(x, y, d, d);
        }
      }
      g.textAlign = 'left';
      label(`${tuned ? 'CAUGHT ' : ''}${nameOf(s).toUpperCase()}${s.boss ? ' . KING' : ''}`, p.x, p.y - 2, color);
    }

    // Beasts that got away: a life each (two for a Bane).
    for (const ev of report.escapes) {
      if (T < ev.tick || T > ev.tick + CALLOUT_TICKS) continue;
      const s = run.spawns[ev.idx];
      const { px, py } = positionAt(s, ev.tick - 1);
      const p = tv.fieldToCss(px, py);
      const k = (T - ev.tick) / CALLOUT_TICKS;
      g.globalAlpha = 1 - k;
      g.strokeStyle = RED;
      g.lineWidth = 2;
      g.setLineDash([3, 3]);
      g.strokeRect(p.x + 0.5, p.y + 0.5, s.entry.w * sc, s.entry.h * sc);
      g.setLineDash([]);
      g.textAlign = 'center';
      label(`GOT AWAY -${ev.cost}`, p.x + (s.entry.w * sc) / 2, p.y + (s.entry.h * sc) / 2 + fontPx / 2, RED);
    }

    for (const k of report.kills) {
      if (T < k.tick || T > k.tick + CALLOUT_TICKS) continue;
      const s = run.spawns[k.idx];
      const { px, py } = positionAt(s, k.tick);
      const p = tv.fieldToCss(px + s.entry.w / 2, py);
      g.globalAlpha = 1 - (T - k.tick) / CALLOUT_TICKS;
      g.textAlign = 'center';
      const extra = k.chain > 1 ? `  CHAIN ${k.chain}` : '';
      label(`+${k.pts}${extra}`, p.x, p.y - (6 + (T - k.tick) / 6) * sc, AMBER);
    }

    for (const m of marks) {
      const age = T - m.tick;
      if (age < 0 || age > MARK_TICKS) continue;
      const k = age / MARK_TICKS;
      const color = MARK_COLOR[m.kind];
      const p = tv.fieldToCss(m.x + 0.5, m.y + 0.5);
      g.globalAlpha = 1 - k * 0.8;
      const r = (3 + 4 * Math.min(1, k * 3)) * sc;
      for (const [stroke, width] of [['#000', 5], [color, 2]] as const) {
        g.strokeStyle = stroke;
        g.lineWidth = width;
        g.setLineDash(m.kind === 'overkill' ? [3, 3] : []);
        g.beginPath();
        g.arc(p.x, p.y, r, 0, Math.PI * 2);
        g.stroke();
      }
      g.setLineDash([]);
      g.fillStyle = color;
      g.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
      g.textAlign = 'left';
      const text = m.kind === 'hit' ? `HIT x${m.combo}`
        : m.kind === 'kill' ? `KILL x${m.combo}`
          : m.kind === 'overkill' ? 'OVERKILL'
            : m.kind === 'miss' ? `MISS ${m.misses}/${JAM_MISSES}`
              : 'AFTER DEATH';
      label(text, p.x + r + 3, p.y + 4, color);
    }

    // Jams and the end of the signal, across the screen.
    g.textAlign = 'center';
    const mid = tv.fieldToCss(128, 40);
    const big = (n: number) => `${Math.max(8, Math.round((fontPx * n) / 16) * 8)}px ${DISPLAY}`;
    for (const j of report.jams) {
      if (T < j.tick || T > j.tick + CALLOUT_TICKS) continue;
      g.globalAlpha = 1 - (T - j.tick) / CALLOUT_TICKS;
      g.font = big(2);
      label('JAMMED -1', mid.x, mid.y, RED, 6);
    }
    if (result.dead && T >= result.deathTick && T < result.deathTick + 3 * CALLOUT_TICKS) {
      g.globalAlpha = 1;
      g.font = big(3);
      label(report.verdict === 'jammed' ? 'JAMMED OUT' : 'TAKEN', mid.x, tv.fieldToCss(128, 78).y, RED, 7);
    }
    g.globalAlpha = 1;

    // HUD: timecode, lives as five bars, combo, speed.
    const lives = report.livesAt(T);
    const lost = result.dead && T >= result.deathTick;
    setText(hudTime, `${timecode(T)} / ${timecode(2 * (total - 1)).slice(3)}`);
    hudBars.forEach((b, i) => b.classList.toggle('off', i >= lives));
    hudLives.classList.toggle('low', lives <= 1);
    const combo = lost ? 0 : report.comboAt(T);
    setText(hudCombo, combo > 1 ? `COMBO x${combo}` : '');
    setText(hudMode, `${paused ? 'PAUSED' : `${speed}x`}${tape.frame >= tape.frames - 1 ? ' . END' : ''}`);
    setText(hudLost, lost ? (report.verdict === 'jammed' ? 'JAMMED' : 'TAKEN') : '');
    playhead.style.left = `${Math.min(100, (100 * T) / endTick).toFixed(2)}%`;
  }

  const onKey = (e: KeyboardEvent) => {
    const k = e.key;
    if (k === ' ') { e.preventDefault(); togglePause(); }
    else if (k === '1') setSpeed(1);
    else if (k === '4') setSpeed(4);
    else if (k === 'ArrowRight') seek(tape.frame + 10 * TAPE_FPS);
    else if (k === 'ArrowLeft') seek(tape.frame - 10 * TAPE_FPS);
    else if (k === 'n' || k === 'N') nextStrike();
    else if (k === 'Home' || k === 'r' || k === 'R') seek(0);
    else if (k === 'b' || k === 'B') app.go({ name: 'broadcast' });
    else if (k === 'Escape') app.go({ name: 'arcade' });
  };
  // Small delay so a key still held from the run does not skip the screen.
  const keyTimer = setTimeout(() => window.addEventListener('keydown', onKey), 500);

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    clearTimeout(keyTimer);
    tixTimers.forEach((t) => clearTimeout(t));
    clearTimeout(receiptTimer);
    window.removeEventListener('keydown', onKey);
    tv.stop();
  };
}

/** The local replay could not run (a client older than the rules): show the reveal and the tx only. */
function decodeFailed(app: App, sub: SubmitResponse, reason: string) {
  const tx = sub.txHash
    ? h('a', { href: voyagerTx(sub.txHash), target: '_blank', rel: 'noopener' }, `${sub.txHash.slice(0, 10)}..${sub.txHash.slice(-6)}`)
    : h('span', { class: 'dim' }, 'none (offchain test)');
  const back = h('button', { class: 'he-btn' }, '[ESC] ARCADE');
  back.addEventListener('click', () => app.go({ name: 'arcade' }));
  app.root.append(h('div', { class: 'he he-fail' },
    h('h1', {}, 'DECODE'),
    h('p', {}, `The relayer scored this run ${sub.result.score}, but this page could not replay it (${reason}). Reload to get the current rules.`),
    h('p', {}, 'TX ', tx),
    back));
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') app.go({ name: 'arcade' }); };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
