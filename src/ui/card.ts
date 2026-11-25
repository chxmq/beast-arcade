// A Beast card as DOM: the same frame the catch ceremony draws on the canvas, used by the Haul
// screen and the Bestiary. Frame colour follows the tier, shiny cards are gold, the King is red.
import type { RosterEntry } from '../data/roster.ts';
import { artistOf, artCrop, typeName } from '../game/beasts.ts';
import { h } from './dom.ts';

export type CardState = 'unseen' | 'seen' | 'caught';

export interface CardOpts {
  /** "#012". */
  dex: string;
  state?: CardState;
  shiny?: boolean;
  king?: boolean;
  /** Small tags under the card: NEW, SHINY, x3 ... */
  tags?: string[];
}

export function makeCard(e: RosterEntry, o: CardOpts): HTMLElement {
  const state = o.state ?? 'caught';
  const cls = ['card', `t${e.tier}`, state];
  if (o.shiny && state === 'caught') cls.push('shiny');
  if (o.king) cls.push('king');
  const art = h('div', { class: 'card-art' });
  if (state === 'unseen') art.append(h('span', { class: 'card-q' }, '???'));
  else art.append(artCrop(e, state === 'seen' ? 'silhouette' : o.shiny ? 'shiny' : 'art'));
  const known = state !== 'unseen';
  const card = h('div', { class: cls.join(' ') },
    h('div', { class: 'card-top' }, h('span', { class: 'card-name' }, known ? e.name.toUpperCase() : '???'), h('span', { class: 'card-dex' }, o.dex)),
    art,
    h('div', { class: 'card-foot' },
      h('span', { class: 'card-type' }, known ? `${typeName(e.type).toUpperCase()}  T${e.tier}` : '- - -'),
      h('span', { class: 'card-by' }, state === 'caught' ? `art ${artistOf(e)}` : '')),
  );
  if (o.tags?.length) card.append(h('div', { class: 'card-tags' }, ...o.tags.map((t) => h('span', { class: `tag ${t.toLowerCase().replace(/[^a-z]/g, '')}` }, t))));
  return card;
}

/** A thin progress bar. `gain` is the part just added (drawn in amber after the base). */
export function bar(frac: number, gain = 0, cls = ''): HTMLElement {
  const base = Math.max(0, Math.min(1, frac - gain));
  const g = Math.max(0, Math.min(1 - base, gain));
  return h('span', { class: `bar ${cls}` },
    h('i', { class: 'base', style: `width:${(base * 100).toFixed(1)}%` }),
    h('i', { class: 'gain', style: `left:${(base * 100).toFixed(1)}%;width:${(g * 100).toFixed(1)}%` }));
}
