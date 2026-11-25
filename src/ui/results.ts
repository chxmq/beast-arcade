// BEAST CATCH haul: what the run caught (cards, NEW tags), habitat progress, catcher level, the
// daily goal, and the ticket payout printing out of the machine. The tickets were already added
// to the wallet (once) when the run ended; this screen shows them.
import type { App } from '../main.ts';
import type { RosterEntry } from '../data/roster.ts';
import { controls } from '../arcade/controls.ts';
import { tickets } from '../arcade/wallet.ts';
import { sound } from '../game/audio.ts';
import { artistOf, artCrop, beastName, typeName } from '../game/beasts.ts';
import { tierColor, KING_COLOR, SHINY_COLOR } from '../game/ceremony.ts';
import { channelCaught } from '../game/channels.ts';
import { dexIndex, dexLabel } from '../game/dex.ts';
import type { HuntOutcome } from '../game/hunt.ts';
import { addedSpecies, haulCards, stripPlan } from '../game/haul.ts';
import { heartSvg, meter } from '../game/hud.ts';
import { settings } from '../game/settings.ts';
import { spriteThumb, TYPE_COLOR } from '../game/sprites.ts';
import { N_SPAWNS, PLAYER_LIVES } from '../sim/spec.ts';
import { h, pad, timecode } from './dom.ts';
import './catch.css';

const TYPE_WORD = ['MAGIC', 'HUNTER', 'BRUTE'] as const;

/** A caught card in the same frame as the catch ceremony draws. */
function haulCard(e: RosterEntry, dex: string, o: { shiny: boolean; king: boolean; tags: string[] }): HTMLElement {
  const frame = o.shiny ? SHINY_COLOR : o.king ? KING_COLOR : tierColor(e.tier);
  const art = spriteThumb(e, o.shiny) ?? artCrop(e, o.shiny ? 'shiny' : 'art');
  return h('div', { class: `cx-card${o.shiny ? ' shiny' : ''}${o.king ? ' king' : ''}`, style: `--frame:${frame};--tc:${TYPE_COLOR[e.type] ?? '#fff'}`, title: `${e.name} . art ${artistOf(e)}` },
    h('div', { class: 'cx-card-top' }, h('span', { class: 'n' }, e.name.toUpperCase()), h('span', { class: 'd' }, dex)),
    h('div', { class: 'cx-card-art' }, art),
    h('div', { class: 'cx-card-foot' }, h('span', { class: 't' }, TYPE_WORD[e.type] ?? '?'), h('span', {}, `T${e.tier}`)),
    o.tags.length ? h('div', { class: 'cx-card-tags' }, ...o.tags.map((t) => h('span', { class: `tag ${t.toLowerCase().replace(/[^a-z]/g, '') || 'n'}` }, t))) : null);
}

export function resultsScreen(app: App, route: { outcome: HuntOutcome }) {
  const o = route.outcome;
  const { result, run, bestChain, bestChainType, isBest, prevBest, channel, before, after, payout } = o;
  const byId = new Map(app.roster.entries.map((e) => [e.speciesId, e]));
  const dex = dexIndex(app.roster.entries);
  const perfect = !result.dead && result.kills === N_SPAWNS;
  const calm = settings.calm;
  const timers: number[] = [];
  const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));

  // ---- verdict and score
  const verdict = result.dead ? 'GAME OVER' : perfect ? 'PERFECT!' : 'STAGE CLEAR';
  const left = h('div', { class: 'cx-haul-left' },
    h('div', { class: 'cx-haul-tag' }, `BEAST CATCH . ${channel.name}`),
    h('h1', { class: `cx-verdict ${result.dead ? 'lost' : perfect ? 'perfect' : 'won'}` }, verdict),
    h('div', { class: 'cx-haul-score' },
      h('span', { class: 'lbl' }, 'SCORE'),
      h('b', {}, pad(result.score, 6)),
      isBest && result.score > 0
        ? h('span', { class: 'cx-newhi' }, prevBest > 0 ? `NEW HI! was ${pad(prevBest, 6)}` : 'FIRST HI SCORE HERE')
        : prevBest > 0 ? h('span', { class: 'cx-hi' }, `HI ${pad(prevBest, 6)}`) : null));

  // ---- the ticket strip
  const count = h('b', { class: 'cx-tix-count' }, '+0');
  const strip = h('div', { class: 'cx-tix-strip' });
  const lineEls = payout.lines.map((l) => {
    const el = h('div', { class: `cx-tix-line${/SWEEP/.test(l.label) ? ' sweep' : ''}` }, h('span', {}, l.label), h('b', {}, `+${l.tickets}`));
    el.hidden = true;
    return el;
  });
  const balance = h('div', { class: 'cx-tix-balance' });
  balance.hidden = true;
  const tix = h('div', { class: 'cx-tix' },
    h('div', { class: 'cx-tix-head' }, h('span', {}, 'TICKETS'), count),
    h('div', { class: 'cx-tix-slot' }, h('i', {})),
    strip,
    h('div', { class: 'cx-tix-lines' }, ...lineEls),
    balance);
  if (!payout.total) {
    strip.append(h('div', { class: 'cx-dim' }, 'No catches, no tickets. Catch one to get paid.'));
  }
  left.append(tix);

  // ---- run stats
  const hearts = h('span', { class: 'cx-mini-hearts' });
  for (let i = 0; i < PLAYER_LIVES; i++) {
    const s = h('span', { class: `heart${i < result.lives ? ' on' : ''}` });
    s.appendChild(heartSvg());
    hearts.append(s);
  }
  const t = result.dead ? result.deathTick : Math.max(...run.resolvedAt);
  left.append(h('div', { class: 'cx-haul-stats' },
    h('div', {}, h('span', {}, 'BEST COMBO'), h('b', {}, String(result.bestCombo))),
    h('div', {}, h('span', {}, 'LONGEST CHAIN'), h('b', { style: `color:${TYPE_COLOR[bestChainType] ?? 'inherit'}` }, bestChain >= 2 ? `${TYPE_WORD[bestChainType] ?? ''} x${bestChain}` : bestChain === 1 ? 'x1' : '-')),
    h('div', {}, h('span', {}, 'LIVES LEFT'), hearts),
    h('div', {}, h('span', {}, 'TIME'), h('b', {}, timecode(Math.max(0, t)).slice(3, 8)))));

  // ---- the cards
  const cards = haulCards(o.catches);
  const newSpecies = addedSpecies(before.caught, after.caught);
  const shinyNew = addedSpecies(before.shiny, after.shiny);
  const right = h('div', { class: 'cx-haul-right' });
  right.append(h('h2', {}, `CAUGHT ${result.kills}`, newSpecies.length ? h('span', { class: 'cx-new' }, `${newSpecies.length} NEW`) : null));
  const grid = h('div', { class: 'cx-cards' });
  if (!cards.length) grid.append(h('p', { class: 'cx-dim' }, 'Nothing caught this time. Tap the Beasts themselves, and never tap blind: three misses in a row jam.'));
  cards.forEach((c, i) => {
    const e = byId.get(c.speciesId);
    if (!e) return;
    const tags: string[] = [];
    if (c.isNew) tags.push('NEW');
    if (c.shiny) tags.push('SHINY');
    if (c.king) tags.push('KING');
    if (c.count > 1) tags.push(`x${c.count}`);
    const card = haulCard(e, dexLabel(dex.get(e.speciesId) ?? 0), { shiny: c.shiny, king: c.king, tags });
    card.style.setProperty('--i', String(Math.min(i, 24)));
    grid.append(card);
  });
  right.append(grid);

  // ---- progress: habitat, catcher level, daily goal
  const chTotal = channel.entries.length;
  const chBefore = channelCaught(channel, before.caught);
  const chAfter = channelCaught(channel, after.caught);
  const lvB = before.level;
  const lvA = after.level;
  const levelUp = lvA.level > lvB.level;
  const dB = before.daily;
  const dA = after.daily;
  const goalJustDone = !dB.done && dA.done;
  right.append(h('div', { class: 'cx-prog' },
    h('div', { class: 'cx-prow' },
      h('span', { class: 'plbl' }, channel.name),
      h('span', { class: 'pcnt' }, `${chAfter}/${chTotal}`, chAfter > chBefore ? h('b', {}, ` +${chAfter - chBefore}`) : null, chAfter === chTotal ? h('b', { class: 'done' }, ' COMPLETE') : null),
      meter(chAfter / chTotal, (chAfter - chBefore) / chTotal, chAfter === chTotal ? 'done' : '')),
    h('div', { class: `cx-prow${levelUp ? ' up' : ''}` },
      h('span', { class: 'plbl' }, `CATCHER LV ${lvA.level}`, h('small', {}, ` ${lvA.title}`)),
      h('span', { class: 'pcnt' }, `${after.catches - lvA.base}/${lvA.next - lvA.base}`, levelUp ? h('b', { class: 'up' }, ` LEVEL UP!`) : null),
      meter(lvA.frac, levelUp ? lvA.frac : Math.max(0, lvA.frac - lvB.frac))),
    h('div', { class: `cx-prow${dA.done ? ' done' : ''}` },
      h('span', { class: 'plbl' }, `TODAY: ${dA.goal.text}`),
      h('span', { class: 'pcnt' }, dA.done ? (goalJustDone ? h('b', { class: 'done' }, 'DONE!') : 'DONE') : `${dA.progress}/${dA.goal.target}`, !dA.done && dA.progress > dB.progress ? h('b', {}, ` +${dA.progress - dB.progress}`) : null),
      meter(dA.progress / dA.goal.target, dA.done ? (goalJustDone ? 1 - dB.progress / dA.goal.target : 0) : (dA.progress - dB.progress) / dA.goal.target, dA.done ? 'done' : '')),
    shinyNew.length ? h('div', { class: 'cx-prow shiny' }, h('span', { class: 'plbl' }, `${shinyNew.length} NEW SHINY IN THE BESTIARY`)) : null));

  // ---- the one that took you, or got away
  const story = (s: (typeof run.spawns)[number], text: string, sub: string, cls: string) => {
    const e = channel.entries[s.rosterIdx];
    const art = spriteThumb(e, s.shiny, '#ff3b2f') ?? artCrop(e);
    return h('div', { class: `cx-story ${cls}` }, art,
      h('div', {}, h('div', { class: 'who' }, text), h('div', { class: 'cx-dim' }, sub), h('div', { class: 'cx-dim' }, `${typeName(e.type)} T${e.tier} . art ${artistOf(e)}`)));
  };
  if (result.dead && result.killer !== 255) {
    const s = run.spawns[result.killer];
    right.append(story(s, `${beastName(channel.entries[s.rosterIdx], s.prefix, s.suffix)} got away with your last life`, 'A Beast that flees costs a life. Watch for the "!" and get it first.', 'took'));
  } else if (result.dead) {
    right.append(h('div', { class: 'cx-story jam' }, h('div', { class: 'jam-box' }, 'JAM'), h('div', {}, h('div', { class: 'who' }, 'Jammed on your last life'), h('div', { class: 'cx-dim' }, 'Three misses in a row cost a life. Tap only the Beasts.'))));
  } else if (o.lastEscape >= 0) {
    const s = run.spawns[o.lastEscape];
    right.append(story(s, `${beastName(channel.entries[s.rosterIdx], s.prefix, s.suffix)} got away`, 'Next time.', 'away'));
  }

  // ---- buttons
  const again = h('button', { class: 'cx-btn primary' }, '[A] PLAY AGAIN');
  const habs = h('button', { class: 'cx-btn' }, '[C] HABITATS');
  const book = h('button', { class: 'cx-btn' }, '[B] BESTIARY');
  const arcade = h('button', { class: 'cx-btn' }, '[ESC] ARCADE');
  const goAgain = () => app.go({ name: 'hunt', channel: channel.id });
  const goHabs = () => app.go({ name: 'hunt' });
  const goBook = () => app.go({ name: 'bestiary', focus: newSpecies[0] });
  const goArcade = () => { sound.sfx('back'); app.go({ name: 'arcade' }); };
  again.addEventListener('click', goAgain);
  habs.addEventListener('click', goHabs);
  book.addEventListener('click', goBook);
  arcade.addEventListener('click', goArcade);
  left.append(h('div', { class: 'cx-haul-btns' }, again, habs, book, arcade));

  const panel = h('div', { class: `cx cx-haul${calm ? ' calm' : ''}` }, h('div', { class: 'cx-haul-grid' }, left, right));
  app.root.append(panel);

  // ---- print the tickets
  const plan = stripPlan(payout.total);
  let printed = 0;
  const step = calm ? 45 : 95;
  const showLines = () => {
    let acc = 0;
    payout.lines.forEach((l, i) => {
      acc += l.tickets;
      if (printed >= acc || printed >= payout.total) lineEls[i].hidden = false;
    });
  };
  for (let i = 0; i < plan.stubs; i++) {
    later(450 + i * step, () => {
      printed = Math.min(payout.total, printed + plan.per);
      const stub = h('i', { class: 'cx-stub' }, h('span', {}, String(plan.per)));
      strip.append(stub);
      count.textContent = `+${printed}`;
      showLines();
      sound.sfx('ticket');
      if (printed >= payout.total) {
        tix.classList.add('done');
        balance.hidden = false;
        balance.textContent = `YOU HAVE ${tickets.balance()} TICKETS`;
        later(160, () => sound.sfx(perfect ? 'win' : 'coin'));
      }
    });
  }
  if (levelUp) later(450 + plan.stubs * step + 350, () => sound.levelUp());
  else if (goalJustDone) later(450 + plan.stubs * step + 350, () => sound.goal());

  // R goes again at once (fast retry). Buttons wait a beat, so keys still mashed from the run
  // cannot skip the screen.
  const shownAt = performance.now();
  const settled = () => performance.now() - shownAt >= 450;
  const offs = [
    controls.on('A', () => settled() && goAgain()),
    controls.on('START', () => settled() && goAgain()),
    controls.on('B', () => settled() && goBook()),
    controls.on('C', () => settled() && goHabs()),
  ];
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'r') return goAgain();
    if (!settled()) return;
    if (k === 'escape') goArcade();
  };
  window.addEventListener('keydown', onKey);
  return () => {
    window.removeEventListener('keydown', onKey);
    offs.forEach((f) => f());
    timers.forEach((x) => clearTimeout(x));
  };
}
