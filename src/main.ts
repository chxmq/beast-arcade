import './ui/styles.css';
import './ui/meta.css';
import './ui/arcade.css';
import { loadRoster, type Roster, type RosterEntry } from './data/roster.ts';
import { sound } from './game/audio.ts';
import { music } from './game/music.ts';
import { buildChannels, type Channel, type ChannelId } from './game/channels.ts';
import { buildCabinet } from './arcade/cabinet.ts';
import { tickets } from './arcade/wallet.ts';
import { bootScreen } from './ui/boot.ts';
import { storyScreen } from './ui/story.ts';
import { guideScreen } from './ui/guide.ts';
import { huntScreen } from './ui/hunt-screen.ts';
import { resultsScreen } from './ui/results.ts';
import { primerScreen } from './ui/primer.ts';
import { aiTestScreen } from './ui/ai-test.ts';
import { aboutScreen } from './ui/about.ts';
import { bestiaryScreen } from './ui/bestiary.ts';
import { broadcastScreen } from './ui/broadcast-screen.ts';
import { decodeScreen, type DecodeData } from './ui/decode.ts';
import type { HuntOutcome } from './game/hunt.ts';
import { arcadeScreen } from './arcade/select.ts';
import { prizesScreen } from './arcade/prizes.ts';
import { microScreen } from './micro/screen.ts';

export type Route =
  | { name: 'boot' }
  | { name: 'guide' }
  | { name: 'primer' }
  | { name: 'story' }
  | { name: 'hunt'; channel?: ChannelId }
  | { name: 'results'; outcome: HuntOutcome }
  | { name: 'bestiary'; focus?: number }
  | { name: 'ai-test' }
  | { name: 'about' }
  | { name: 'broadcast' }
  | { name: 'decode'; data: DecodeData }
  | { name: 'arcade' }
  | { name: 'micro' }
  | { name: 'prizes' };

export interface App {
  /** The cabinet's CRT screen. Every screen renders inside it and sizes itself to it. */
  root: HTMLElement;
  roster: Roster;
  /** The playable channels (habitats), in hub order. */
  channels: Channel[];
  go(route: Route): void;
}

type Screen = (app: App, route: any) => () => void;

const screens: Record<Route['name'], Screen> = {
  boot: bootScreen,
  story: storyScreen,
  guide: guideScreen,
  primer: primerScreen,
  hunt: huntScreen,
  results: resultsScreen,
  bestiary: bestiaryScreen,
  'ai-test': aiTestScreen,
  about: aboutScreen,
  broadcast: broadcastScreen,
  decode: decodeScreen,
  arcade: arcadeScreen,
  micro: microScreen,
  prizes: prizesScreen,
};

/** Menu screens play their own theme; every other screen starts in silence and runs its own music. */
const MENU = new Set<Route['name']>(['boot', 'arcade', 'prizes', 'bestiary', 'about', 'ai-test', 'guide', 'story']);

/** Which cabinet a route belongs to, so a payout (tickets.add) is credited to the game that paid it. */
const CABINET: Partial<Record<Route['name'], string>> = {
  micro: 'micro', hunt: 'catch', results: 'catch', primer: 'catch', broadcast: 'eyes', decode: 'eyes',
};

/** Deep links: #arcade, #prizes, #bestiary, #micro, #broadcast, #about, #ai-test. */
const LINKS: Partial<Record<string, Route>> = {
  arcade: { name: 'arcade' }, prizes: { name: 'prizes' }, bestiary: { name: 'bestiary' }, micro: { name: 'micro' },
  broadcast: { name: 'broadcast' }, about: { name: 'about' }, 'ai-test': { name: 'ai-test' }, catch: { name: 'hunt' },
};

/** The marquee Beasts: two Art Hackathon species if the roster has them. */
function marqueePair(roster: Roster): [RosterEntry | undefined, RosterEntry | undefined] {
  const byId = (id: number) => roster.entries.find((e) => e.speciesId === id);
  const feat = roster.entries.filter((e) => e.featured && !e.maskWarning);
  return [byId(10032) ?? feat[0] ?? roster.entries[0], byId(10034) ?? feat[1] ?? roster.entries[1]];
}

async function main() {
  const host = document.getElementById('app')!;
  const cabinet = buildCabinet(host);
  const root = cabinet.screen;
  root.innerHTML = '<div class="cab-msg"><b>BEAST ARCADE</b><span class="blink">LOADING</span></div>';

  // Audio may only start after a user gesture: the first tap or key unlocks it (and the waiting theme).
  const unlock = () => sound.unlock();
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });

  let roster: Roster;
  try {
    roster = await loadRoster();
  } catch (e) {
    root.innerHTML = '<div class="cab-msg bad"><b>OUT OF ORDER</b><span>The Beast roster failed to load. Reload to try again.</span></div>';
    throw e;
  }
  cabinet.marqueeArt(...marqueePair(roster));

  let cleanup: (() => void) | null = null;
  let generation = 0;
  const app: App = {
    root,
    roster,
    channels: buildChannels(roster),
    go(route) {
      // Retired TV-era screens fold into the game select.
      if (route.name === 'guide' || route.name === 'story') route = { name: 'arcade' };
      const prev = cleanup;
      cleanup = null;
      prev?.();
      root.innerHTML = '';
      root.className = 'cab-screen';
      root.removeAttribute('style');
      cabinet.transition();
      cabinet.syncCalm();
      if (!MENU.has(route.name)) music.stop();
      tickets.setSource(CABINET[route.name] ?? null);
      const gen = ++generation;
      const done = screens[route.name](app, route);
      // A screen that redirected while it was being built has already been replaced.
      if (gen === generation) cleanup = done;
      else done();
    },
  };

  const link = LINKS[location.hash.replace('#', '')];
  app.go(link ?? { name: 'boot' });
}

void main();
