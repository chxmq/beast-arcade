import type { App } from '../main.ts';
import type { RosterEntry } from '../data/roster.ts';
import { controls, type Button } from '../arcade/controls.ts';
import { sound } from '../game/audio.ts';
import { artCrop, artistOf, typeName } from '../game/beasts.ts';
import { settings } from '../game/settings.ts';
import { h, shortAddr } from './dom.ts';
import './operator.css';

/** Our own registered species (looked up in the roster, never assumed present). */
const THE_STATIC = 10091;

// ------------------------------------------------------------------ shared operator chrome

export interface Prompt {
  cap: 'A' | 'B' | 'C';
  label: string;
  run: () => void;
}

/** An arcade key cap and its label, clickable. */
export function promptButton(p: Prompt, extraClass = ''): HTMLButtonElement {
  const b = h('button', { class: `op-prompt op-k${p.cap.toLowerCase()} ${extraClass}`.trim(), type: 'button' },
    h('span', { class: 'op-cap' }, p.cap), h('span', { class: 'op-plbl' }, p.label));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    p.run();
  });
  return b;
}

/** Sticky top bar: page title on the left, button prompts on the right. */
export function opBar(title: string, prompts: Prompt[]): HTMLElement {
  return h('div', { class: 'op-bar' }, h('h1', { class: 'op-title' }, title), h('div', { class: 'op-prompts' }, ...prompts.map((p) => promptButton(p))));
}

/** B and Escape go back to the arcade, UP and DOWN scroll the page. Returns the cleanup. */
export function wireOperator(app: App, scroller: HTMLElement, extra: Partial<Record<Button, () => void>> = {}): () => void {
  let gone = false;
  const back = () => {
    if (gone) return;
    gone = true;
    sound.sfx('back');
    app.go({ name: 'arcade' });
  };
  const still = settings.calm || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const scroll = (dir: number) => scroller.scrollBy({ top: dir * scroller.clientHeight * 0.4, behavior: still ? 'auto' : 'smooth' });
  const offs = [
    controls.on('B', back),
    controls.on('UP', () => scroll(-1)),
    controls.on('DOWN', () => scroll(1)),
    ...(Object.entries(extra) as [Button, () => void][]).map(([b, fn]) => controls.on(b, fn)),
  ];
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.repeat) return;
    e.preventDefault();
    back();
  };
  window.addEventListener('keydown', onKey);
  return () => {
    gone = true;
    offs.forEach((off) => off());
    window.removeEventListener('keydown', onKey);
  };
}

/** Back to the arcade from a clickable prompt. */
export function backPrompt(app: App): Prompt {
  return { cap: 'B', label: 'BACK', run: () => { sound.sfx('back'); app.go({ name: 'arcade' }); } };
}

// ------------------------------------------------------------------ ABOUT

const sec = (n: number, title: string, ...body: (Node | string)[]) =>
  h('section', { class: 'op-sec' }, h('h2', { class: 'op-h' }, h('span', { class: 'op-n' }, String(n).padStart(2, '0')), ` ${title}`), ...body);

const GAMES: { cls: string; name: string; tag?: string; text: string }[] = [
  { cls: 'g-micro', name: 'MICRO MAYHEM', text: 'Four-second Beast microgames that speed up every round, with a boss every 15. Read it, hit it, next.' },
  { cls: 'g-catch', name: 'BEAST CATCH', text: 'Wild Beasts roam a habitat. Tap them before they flee and every catch goes into your book. It runs on the same rules as the ranked game.' },
  { cls: 'g-eyes', name: 'HUMAN EYES', tag: 'ONCHAIN', text: 'The ranked cabinet. Beasts exist only as motion in noise, you play a tape of pure pixels, and Starknet replays your run in Cairo before the score counts.' },
  { cls: 'g-prizes', name: 'PRIZE COUNTER', text: 'Every game pays tickets. Spend them on Beast capsules from the BASIC, RARE and LEGENDARY machines. A duplicate pays a quarter of its price back.' },
  { cls: 'g-book', name: 'BESTIARY', text: 'Every species, numbered. Unseen ones are ???. Catches and capsules fill it, and species you caught in verified ranked runs carry an ONCHAIN badge.' },
];

const META: [string, string][] = [
  ['ART', 'Every sprite, card and capsule prize is the Beast\'s own onchain pixel art, drawn at whole-pixel scale. Shinies are the same art toned gold.'],
  ['TYPE', 'How it moves: Magic swirls, Hunter streaks, Brute slams. Catch the same type in a row for a chain bonus up to x3. The Bestiary files Beasts by type.'],
  ['TIER', 'Power rank, T1 at the top. T1 scores the most (150 base points, T5 scores 50) and sets the card frame colour. It decides the capsule odds: T3 to T5 originals fill the BASIC machine, T1 and T2 the RARE one, T1 Art Hackathon Beasts lead the LEGENDARY one. In HUMAN EYES it is also signal strength: T1 is the faintest.'],
  ['HEALTH', 'Taps to catch: one, two for a rare, one more from 150 health. A King takes eight.'],
  ['ADVENTURERS KILLED', 'Aggression. Beasts with more kills on their record move faster, level up sooner and flee sooner, for everyone.'],
  ['LEVEL, PREFIX, SUFFIX', 'In ranked runs a Beast from level 24 carries a Loot Survivor name. Gale, Storm and Tempest move faster. Dusk, Gloom and Shadow are fainter and pay a quarter more. Peak takes an extra tap. Bane costs two lives when it escapes.'],
  ['SHINY', 'The gold variant. In a run, 1 Beast in 12 is shiny and scores triple. At the PRIZE COUNTER, 1 RARE capsule in 12.'],
  ['SPECIES CREATOR', 'Artist credit, shown wherever an Art Hackathon Beast appears big.'],
];

function credit(e: RosterEntry, ours = false): HTMLElement {
  const thumb = h('div', { class: 'op-thumb' }, artCrop(e, 'art'));
  return h('div', { class: `op-credit op-t${Math.max(1, Math.min(5, e.tier))}${ours ? ' ours' : ''}` },
    thumb,
    h('div', { class: 'op-cname' }, e.name),
    h('div', { class: 'op-cmeta' }, `${typeName(e.type).toUpperCase()} T${e.tier}  #${e.speciesId}`),
    h('div', { class: 'op-cby' }, ours ? 'OUR SPECIES, MADE FOR THIS GAME' : `art ${artistOf(e)}`));
}

export function aboutScreen(app: App) {
  const r = app.roster;
  const wrap = h('div', { class: 'op op-about' });
  const toTest = () => { sound.sfx('select'); app.go({ name: 'ai-test' }); };

  wrap.append(
    opBar('ABOUT BEAST ARCADE', [{ cap: 'A', label: 'THE AI TEST', run: toTest }, backPrompt(app)]),
    h('p', { class: 'op-lead' }, 'One cabinet, three Beast games, a prize counter and a book to fill. Every Beast in it is a real Beast NFT read from Starknet: its art, type, tier and kill record decide how it moves, how rare it is and what it is worth.'),
  );

  wrap.append(sec(1, 'THE GAMES', h('div', { class: 'op-games' }, ...GAMES.map((g) =>
    h('div', { class: `op-game ${g.cls}` },
      h('div', { class: 'op-gname' }, g.name, g.tag ? h('span', { class: 'op-tag' }, g.tag) : null),
      h('div', {}, g.text))))));

  const meta = h('dl', { class: 'op-meta' });
  for (const [k, v] of META) meta.append(h('dt', {}, k), h('dd', {}, v));
  wrap.append(sec(2, 'BEAST METADATA AT WORK', meta));

  wrap.append(sec(3, 'WHY NO AI CAN PLAY',
    h('ul', { class: 'op-list' },
      h('li', {}, h('b', {}, 'Real time. '), 'Every game asks for decisions in under a second. An AI agent acts on one screenshot every 1 to 3 seconds, and MICRO MAYHEM changes the rules every 4.'),
      h('li', {}, h('b', {}, 'Human eyes. '), 'MICRO MAYHEM keeps dealing the HUMAN EYES! microgame: find the Beast hidden as motion in noise. A screenshot shows nothing, because every single frame is uniform noise.'),
      h('li', {}, h('b', {}, 'Blind input loses. '), 'BEAST CATCH jams after three misses in a row, and a wrong tap fails a microgame.'),
      h('li', {}, h('b', {}, 'Pixels only. '), 'The ranked cabinet streams pixels and nothing else, and the contract replays every run in Cairo. Reading the page or the code gets a bot nothing.')),
    promptButton({ cap: 'A', label: 'SEE THE AI TEST', run: toTest }, 'op-cta')));

  wrap.append(sec(4, 'WHY IT IS ONCHAIN',
    h('ul', { class: 'op-list cyan' },
      h('li', {}, h('b', {}, 'The cast is real. '), 'Every Beast is a Beast NFT read from Starknet. Its art, type, tier, shiny state and kill record drive every cabinet.'),
      h('li', {}, h('b', {}, 'Ranked runs cannot be faked. '), 'Each day\'s tape seeds are committed onchain as one Merkle root before anyone plays. You receive pixels only. Your strike log is signed by a guest key kept in this browser, a relayer carries it and pays the gas, and the contract replays the whole run in Cairo before it records a score. Nobody can post a number they did not play, and the operator cannot pick seeds after the fact.'),
      h('li', {}, h('b', {}, 'Catches you can prove. '), 'Verified catches go into your onchain Bestiary, a bitmap of every species you caught in ranked runs, next to the daily board.'),
      h('li', {}, h('b', {}, 'The Beasts remember. '), 'When a Beast takes you down in a ranked run, the kill is recorded onchain and makes it more aggressive in future tapes. THE STATIC (species 10091), our own registered species, trusts the game as its kill verifier, so its kills are written onto the NFT itself, where beasts.app and any other app can read them.'))));

  const hack = r.entries.filter((e) => e.featured && e.speciesId !== THE_STATIC);
  const ours = r.entries.find((e) => e.speciesId === THE_STATIC);
  const originals = r.entries.filter((e) => !e.featured).length;
  const net = r.network ? r.network.charAt(0).toUpperCase() + r.network.slice(1) : 'Sepolia';
  wrap.append(sec(5, 'ART HACKATHON CREDITS',
    h('p', {}, `These ${hack.length} species were drawn at the Devcon 8 Beast Art Hackathon and registered onchain at beasts.app. In BEAST ARCADE they are the rare Beasts, the Kings and the best capsules at the PRIZE COUNTER.`),
    h('div', { class: 'op-credits' }, ...hack.map((e) => credit(e)), ours ? credit(ours, true) : null),
    h('p', { class: 'op-src' }, `The ${originals} original Beasts come from Loot Survivor. Data: Beasts V3 on Starknet ${net}, NFT ${shortAddr(r.nft)}, registry ${shortAddr(r.registry)}.`)));

  app.root.append(wrap);
  return wireOperator(app, wrap, { A: toTest });
}
