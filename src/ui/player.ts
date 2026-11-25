// PLAYER card: who is playing (callsign, guest or wallet), the optional CONNECT WALLET flow, and
// what this player has: Tuner level, tickets, the book, and the ranked record onchain. Joystick
// UP/DOWN picks a row, A acts, B goes back; everything is also a tap target.
import type { App, PlayerBack } from '../main.ts';
import { CALLSIGN_RE } from '../broadcast/hashes.ts';
import { account, NO_WALLET_MESSAGE, networkName, shortAddress, type AccountState, type WalletChoice } from '../chain/account.ts';
import { fetchOnchainDex, fetchRankedBest, popcount } from '../chain/dex.ts';
import { bind, commas, promptBar, ticketReadout, topBar } from '../arcade/ui.ts';
import { tickets } from '../arcade/wallet.ts';
import { sound } from '../game/audio.ts';
import { collection, tunerLevel } from '../game/collection.ts';
import { h, pad } from './dom.ts';
import './player.css';

type Slot = 'callsign' | 'wallet';
type PickView = 'looking' | 'list' | 'none' | 'busy';

export function playerScreen(app: App, route: { name: 'player'; back?: PlayerBack }) {
  const total = app.roster.entries.length;
  let gone = false;

  // ------------------------------------------------------------------ identity column
  const modeTag = h('span', { class: 'pl-mode' }, 'GUEST');
  const tix = ticketReadout();

  const input = h('input', { class: 'pl-cs', id: 'pl-cs', maxlength: '12', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'characters', enterkeyhint: 'done', 'aria-label': 'Callsign' });
  const csBox = h('div', { class: 'pl-slot pl-cs-box', 'data-slot': 'callsign' },
    h('label', { class: 'pl-lbl', for: 'pl-cs' }, 'CALLSIGN'),
    input,
    h('span', { class: 'pl-hint' }, 'A-Z 0-9, up to 12'));

  const whoTag = h('span', { class: 'pl-tag' }, 'GUEST');
  const whoMain = h('span', { class: 'pl-who-main' }, '');
  const whoSub = h('span', { class: 'pl-who-sub' }, '');
  const who = h('div', { class: 'pl-who' }, whoTag, h('div', { class: 'pl-who-txt' }, whoMain, whoSub));

  const btnLabel = h('span', { class: 'pl-btn-main' }, 'CONNECT WALLET');
  const btnSub = h('span', { class: 'pl-btn-sub' }, 'OPTIONAL . ONE SIGNATURE . NO GAS');
  const walletBtn = h('button', { class: 'pl-slot pl-btn', type: 'button', 'data-slot': 'wallet' }, btnLabel, btnSub);

  const msg = h('p', { class: 'pl-msg', role: 'status' });
  const why = h('p', { class: 'pl-why' },
    'Play as a guest instantly. Connect a Starknet wallet to make this player yours: one signature, no gas, and your onchain Bestiary and ranked scores follow your wallet. ',
    h('b', {}, 'Same wallet, same player on any device.'));

  const idCol = h('section', { class: 'pl-id' }, csBox, who, walletBtn, msg, why);

  // ------------------------------------------------------------------ stats column
  const row = (label: string, value: HTMLElement, extra?: HTMLElement) =>
    h('div', { class: 'pl-row' }, h('span', { class: 'pl-lbl' }, label), h('span', { class: 'pl-val-wrap' }, value, extra ?? null));
  const lvVal = h('b', { class: 'pl-val' }, '');
  const lvTitle = h('span', { class: 'pl-title' }, '');
  const lvBar = h('span', { class: 'pl-bar', 'aria-hidden': 'true' });
  const tixVal = h('b', { class: 'pl-val gold' }, '');
  const bookVal = h('b', { class: 'pl-val' }, '');
  const shinyVal = h('b', { class: 'pl-val gold' }, '');
  const dexVal = h('b', { class: 'pl-val cyan' }, '...');
  const bestVal = h('b', { class: 'pl-val cyan' }, '...');
  const rankNote = h('p', { class: 'pl-note' }, 'Reading the contract...');

  const statCol = h('section', { class: 'pl-stats' },
    h('h2', { class: 'pl-h' }, 'ARCADE'),
    h('div', { class: 'pl-row pl-lv' }, h('span', { class: 'pl-lbl' }, 'TUNER'), h('span', { class: 'pl-val-wrap' }, lvVal, lvTitle), lvBar),
    row('TICKETS', tixVal),
    row('BOOK', bookVal),
    row('SHINY', shinyVal),
    h('h2', { class: 'pl-h' }, 'RANKED ', h('span', { class: 'pl-h-sub' }, 'HUMAN EYES')),
    row('ONCHAIN BESTIARY', dexVal),
    row('BEST RANKED SCORE', bestVal),
    rankNote);

  const main = h('div', { class: 'pl-main' }, idCol, statCol);

  // ------------------------------------------------------------------ wallet picker
  const pickTitle = h('h2', { class: 'pl-pick-title' }, 'CONNECT WALLET');
  const pickBody = h('div', { class: 'pl-pick-body' });
  const pickCancel = h('button', { class: 'pl-pick-cancel', type: 'button' }, h('span', { class: 'pl-cap' }, 'B'), 'BACK');
  const pick = h('div', { class: 'pl-pick', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Connect a wallet' },
    h('div', { class: 'pl-pick-panel' }, pickTitle, pickBody, pickCancel));
  pick.hidden = true;

  const prompts = promptBar([[['UP', 'DOWN'], 'CHOOSE'], ['A', 'SELECT'], ['B', 'BACK']], 'pl-prompts');
  const root = h('div', { class: 'pl' }, topBar('PLAYER', modeTag, tix.el), main, prompts, pick);
  app.root.append(root);

  // ------------------------------------------------------------------ state
  let slot: Slot = 'callsign';
  let pickOpen = false;
  let pickView: PickView = 'looking';
  let choices: WalletChoice[] = [];
  let pickIdx = 0;
  let rankedFor: bigint | null = null;
  let note: { text: string; tone: 'ok' | 'bad' | 'info' } | null = null;
  let noteTimer = 0;

  function say(text: string | null, tone: 'ok' | 'bad' | 'info' = 'info', ms = 0) {
    clearTimeout(noteTimer);
    note = text ? { text, tone } : null;
    paintMsg();
    if (text && ms) noteTimer = window.setTimeout(() => { note = null; paintMsg(); }, ms);
  }

  function paintMsg() {
    const s = account.state();
    const text = note?.text ?? s.message ?? '';
    msg.textContent = text;
    msg.className = `pl-msg ${note ? note.tone : s.message ? 'bad' : ''}`.trim();
  }

  function paintStats() {
    const lv = tunerLevel(collection.state.stats.catches);
    lvVal.textContent = `LV ${lv.level}`;
    lvTitle.textContent = lv.title.toUpperCase();
    lvBar.replaceChildren(...Array.from({ length: 10 }, (_, i) => h('i', i < Math.round(lv.frac * 10) ? { class: 'on' } : {})));
    lvBar.title = `${collection.state.stats.catches} catches, LV ${lv.level + 1} at ${lv.next}`;
    tixVal.textContent = commas(tickets.balance());
    bookVal.textContent = `${collection.distinctCaught()}/${total}`;
    shinyVal.textContent = String(collection.shinyIds().size);
  }

  async function loadRanked(pub: bigint, fresh: boolean) {
    rankedFor = pub;
    dexVal.textContent = '...';
    bestVal.textContent = '...';
    dexVal.classList.add('dim');
    bestVal.classList.add('dim');
    rankNote.textContent = 'Reading the contract...';
    rankNote.className = 'pl-note';
    const [dex, best] = await Promise.all([fetchOnchainDex(pub, { fresh }), fetchRankedBest(pub, { fresh })]);
    if (gone || rankedFor !== pub) return;
    dexVal.textContent = dex ? `${popcount(dex.caught)}/${total}` : '--';
    bestVal.textContent = best === null ? '--' : best ? pad(best, 6) : 'NONE YET';
    dexVal.classList.toggle('dim', !dex);
    bestVal.classList.toggle('dim', !best);
    if (!dex && best === null) {
      rankNote.textContent = 'Onchain record unavailable right now (offchain test or no connection).';
      rankNote.className = 'pl-note dim';
    } else {
      const shinies = dex ? popcount(dex.shiny) : 0;
      rankNote.textContent = `Player ${shortAddress('0x' + pub.toString(16))}${shinies ? ` . ${shinies} shiny onchain` : ''}. Read from the contract.`;
      rankNote.className = 'pl-note dim';
    }
  }

  function paint(s: AccountState = account.state()) {
    const wallet = s.mode === 'wallet' && s.wallet;
    modeTag.textContent = wallet ? 'WALLET' : 'GUEST';
    modeTag.classList.toggle('wallet', !!wallet);
    if (document.activeElement !== input) input.value = s.callsign;
    whoTag.textContent = wallet ? 'WALLET' : 'GUEST';
    whoTag.classList.toggle('wallet', !!wallet);
    if (wallet) {
      whoMain.textContent = `${shortAddress(wallet.address)} on ${networkName(wallet.chainId)}`;
      whoSub.textContent = `Unlocked with ${wallet.walletName}. Player ${shortAddress('0x' + s.pub.toString(16))}`;
      btnLabel.textContent = 'DISCONNECT';
      btnSub.textContent = 'BACK TO YOUR GUEST KEY';
      walletBtn.classList.add('off');
    } else {
      whoMain.textContent = 'This browser only';
      whoSub.textContent = `Random key kept here. Player ${shortAddress('0x' + s.pub.toString(16))}`;
      btnLabel.textContent = 'CONNECT WALLET';
      btnSub.textContent = 'OPTIONAL . ONE SIGNATURE . NO GAS';
      walletBtn.classList.remove('off');
    }
    walletBtn.disabled = s.busy !== null;
    paintMsg();
    if (rankedFor !== s.pub) void loadRanked(s.pub, true);
    if (pickOpen && s.busy) {
      pickView = 'busy';
      paintPick();
    }
  }

  function paintSlots() {
    csBox.classList.toggle('sel', !pickOpen && slot === 'callsign');
    walletBtn.classList.toggle('sel', !pickOpen && slot === 'wallet');
  }

  // ------------------------------------------------------------------ picker
  function paintPick() {
    pick.hidden = !pickOpen;
    paintSlots();
    if (!pickOpen) return;
    pickBody.replaceChildren();
    pickCancel.lastChild!.textContent = pickView === 'busy' ? 'CANCEL' : 'BACK';
    if (pickView === 'looking') {
      pickTitle.textContent = 'CONNECT WALLET';
      pickBody.append(h('p', { class: 'pl-pick-line blink' }, 'LOOKING FOR WALLETS...'));
    } else if (pickView === 'none') {
      pickTitle.textContent = 'NO WALLET';
      pickBody.append(h('p', { class: 'pl-pick-none' }, NO_WALLET_MESSAGE));
    } else if (pickView === 'busy') {
      const s = account.state();
      const signing = s.busy === 'signing';
      pickTitle.textContent = 'CHECK YOUR WALLET';
      pickBody.append(
        h('ol', { class: 'pl-steps' },
          h('li', { class: signing ? 'done' : 'now' }, h('b', {}, '1'), 'Approve the connection'),
          h('li', { class: signing ? 'now' : '' }, h('b', {}, '2'), 'Sign one message. No transaction, no gas.')),
        h('p', { class: 'pl-pick-line dim' }, 'Your player key is made from that signature.'));
    } else {
      pickTitle.textContent = 'CHOOSE A WALLET';
      const list = h('div', { class: 'pl-wallets', role: 'listbox' });
      choices.forEach((c, i) => {
        const b = h('button', { class: `pl-wallet${i === pickIdx ? ' sel' : ''}`, type: 'button', role: 'option', 'aria-selected': String(i === pickIdx) },
          c.icon ? h('img', { class: 'pl-wallet-ico', src: c.icon, alt: '' }) : h('span', { class: 'pl-wallet-ico none' }),
          h('span', { class: 'pl-wallet-name' }, c.name.toUpperCase()),
          h('span', { class: 'pl-wallet-go' }, 'CONNECT'));
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          pickIdx = i;
          void choose();
        });
        list.append(b);
      });
      pickBody.append(list, h('p', { class: 'pl-pick-line dim' }, 'One signature. No transaction, no gas.'));
    }
  }

  async function openPicker() {
    if (pickOpen || account.state().busy) return;
    account.clearMessage();
    say(null);
    pickOpen = true;
    pickView = 'looking';
    pickIdx = 0;
    paintPick();
    sound.sfx('select');
    const found = await account.wallets();
    if (gone || !pickOpen || pickView !== 'looking') return;
    choices = found;
    pickView = found.length ? 'list' : 'none';
    if (!found.length) sound.sfx('denied');
    paintPick();
  }

  function closePicker() {
    if (!pickOpen) return;
    if (account.state().busy) account.cancel();
    pickOpen = false;
    paintPick();
  }

  async function choose() {
    const c = choices[pickIdx];
    if (!c || account.state().busy) return;
    sound.sfx('start');
    pickView = 'busy';
    paintPick();
    const ok = await account.connect(c.id);
    if (gone) return;
    pickOpen = false;
    paintPick();
    if (ok) {
      sound.sfx('win');
      say('Wallet player unlocked. Same wallet, same player on any device.', 'ok', 6000);
    } else {
      const m = account.state().message;
      if (m === NO_WALLET_MESSAGE) {
        pickOpen = true;
        pickView = 'none';
        paintPick();
      }
      sound.sfx('denied');
    }
  }

  // ------------------------------------------------------------------ callsign
  input.addEventListener('input', () => {
    const v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (v !== input.value) input.value = v;
  });
  const commit = () => {
    const v = input.value;
    if (v === account.state().callsign) return;
    if (CALLSIGN_RE.test(v) && account.setCallsign(v)) {
      say('Callsign saved.', 'ok', 2500);
      sound.sfx('select');
    } else {
      input.value = account.state().callsign;
      say('A callsign is 1 to 12 letters or digits.', 'bad', 3500);
      sound.sfx('denied');
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      input.value = account.state().callsign;
      input.blur();
    }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('focus', () => {
    slot = 'callsign';
    paintSlots();
  });

  // ------------------------------------------------------------------ actions
  const back = () => {
    if (gone) return;
    sound.sfx('back');
    app.go({ name: route.back ?? 'arcade' });
  };

  function walletAction() {
    const s = account.state();
    if (s.busy) return;
    if (s.mode === 'wallet') {
      account.disconnect();
      sound.sfx('back');
      say('Disconnected. Playing as your guest again.', 'info', 5000);
    } else {
      void openPicker();
    }
  }

  function activate() {
    if (pickOpen) {
      if (pickView === 'list') void choose();
      else if (pickView === 'none') closePicker();
      return;
    }
    if (slot === 'callsign') {
      input.focus();
      input.select();
    } else walletAction();
  }

  function move(d: number) {
    if (pickOpen) {
      if (pickView !== 'list' || !choices.length) return;
      pickIdx = (pickIdx + d + choices.length) % choices.length;
      paintPick();
      sound.sfx('select');
      return;
    }
    // Two rows to pick; past them the stick scrolls the card (small screens show part of it).
    if (d > 0 && slot === 'wallet') {
      main.scrollBy({ top: main.clientHeight * 0.45 });
      return;
    }
    if (d < 0 && slot === 'callsign') {
      main.scrollTo({ top: 0 });
      return;
    }
    slot = d > 0 ? 'wallet' : 'callsign';
    paintSlots();
    (slot === 'callsign' ? csBox : walletBtn).scrollIntoView({ block: 'nearest' });
    sound.sfx('select');
  }

  csBox.addEventListener('pointerdown', () => {
    slot = 'callsign';
    paintSlots();
  });
  walletBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    slot = 'wallet';
    paintSlots();
    walletAction();
  });
  pickCancel.addEventListener('click', (e) => {
    e.stopPropagation();
    sound.sfx('back');
    closePicker();
  });
  pick.addEventListener('pointerdown', (e) => {
    if (e.target === pick) {
      sound.sfx('back');
      closePicker();
    }
  });

  const offKeys = bind({
    UP: () => move(-1),
    DOWN: () => move(1),
    LEFT: () => { if (pickOpen) move(-1); },
    RIGHT: () => { if (pickOpen) move(1); },
    A: activate,
    START: activate,
    B: () => {
      if (pickOpen) {
        sound.sfx('back');
        closePicker();
      } else back();
    },
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.repeat || e.target === input) return;
    e.preventDefault();
    if (pickOpen) {
      sound.sfx('back');
      closePicker();
    } else back();
  };
  window.addEventListener('keydown', onKey);

  const offAccount = account.subscribe((s) => paint(s));
  const offTix = tickets.subscribe(() => paintStats());

  paintStats();
  paint();
  paintSlots();

  return () => {
    gone = true;
    clearTimeout(noteTimer);
    offAccount();
    // Leaving mid-connect abandons it: a key must never change under a run started elsewhere.
    if (account.state().busy) account.cancel();
    account.clearMessage();
    offKeys();
    offTix();
    tix.dispose();
    window.removeEventListener('keydown', onKey);
  };
}
