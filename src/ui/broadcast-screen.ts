import type { App } from '../main.ts';
import type { StatusResponse } from '../broadcast/api.ts';
import { CALLSIGN_RE } from '../broadcast/hashes.ts';
import { account, shortAddress } from '../chain/account.ts';
import { fetchOnchainDex, popcount, rememberDex } from '../chain/dex.ts';
import { guest } from '../chain/guest.ts';
import { controls } from '../arcade/controls.ts';
import { sound } from '../game/audio.ts';
import { BroadcastPlayer, fetchStatus, startTape, submitRun, type Ticketed } from '../game/broadcast.ts';
import { h, pad, shortAddr } from './dom.ts';
import './broadcast.css';

/** HUMAN EYES (ranked): the lobby (callsign, today's board), then the streamed tape, then submit and Decode. */
export function broadcastScreen(app: App) {
  let player: BroadcastPlayer | null = null;
  let disposed = false;
  let busy = false;
  const keyHandlers: ((e: KeyboardEvent) => void)[] = [];
  const onKey = (e: KeyboardEvent) => keyHandlers[keyHandlers.length - 1]?.(e);
  window.addEventListener('keydown', onKey);
  const offs: (() => void)[] = [];

  // ------------------------------------------------------------------ lobby
  const statusTag = h('span', { class: 'he-tag' }, 'CHECKING');
  const rootLine = h('p', { class: 'he-root' }, "Checking today's tapes...");
  const input = h('input', { class: 'he-callsign', maxlength: '12', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Callsign' });
  input.value = guest.callsign;
  const go = h('button', { class: 'he-btn primary' }, '[START] PLAY RANKED');
  const back = h('button', { class: 'he-back' }, '< ARCADE');
  const msg = h('p', { class: 'he-msg' });
  const board = h('div', { class: 'he-board' });
  const dexLine = h('p', { class: 'he-dex dim' }, 'YOUR ONCHAIN BESTIARY ...');
  // Who is playing: the guest key, or the player a wallet unlocked. The PLAYER card manages it.
  const asName = h('b', {}, '');
  const asWho = h('span', { class: 'he-as-who' }, '');
  const asLink = h('button', { class: 'he-link', type: 'button' }, 'PLAYER CARD >');
  const asLine = h('p', { class: 'he-as' }, 'PLAYING AS ', asName, ' ', asWho, asLink);
  const paintAs = () => {
    const s = account.state();
    asName.textContent = CALLSIGN_RE.test(input.value) ? input.value : s.callsign;
    asWho.textContent = s.mode === 'wallet' && s.wallet ? `(WALLET ${shortAddress(s.wallet.address)})` : '(GUEST)';
    asWho.classList.toggle('wallet', s.mode === 'wallet');
  };

  const lobby = h('div', { class: 'he he-lobby' },
    h('div', { class: 'he-head' }, back,
      h('div', { class: 'he-title' }, h('span', { class: 'eyes', 'aria-hidden': 'true' }, h('i', {}), h('i', {})), 'HUMAN EYES'),
      h('div', { class: 'he-sub' }, h('span', { class: 'he-ranked' }, 'RANKED . ONCHAIN'), statusTag),
      h('p', { class: 'he-line' }, 'The one cabinet no AI can see. Every run is replayed onchain.')),
    h('div', { class: 'he-cols' },
      h('div', { class: 'he-col' },
        h('h2', {}, 'HOW TO PLAY'),
        h('ul', { class: 'he-rules' },
          h('li', {}, h('b', {}, 'THE BEASTS ARE MOTION IN NOISE.'), ' Any single frame is pure static. Your eyes see them move.'),
          h('li', {}, h('b', {}, 'CLICK OR TAP A BEAST TO STRIKE.'), ' Space or A fires at the cursor. One strike every 0.3 s.'),
          h('li', {}, h('b', { class: 'hot' }, 'FIVE LIVES.'), ' A Beast that gets away costs one. Three misses in a row jam and cost one too.'),
          h('li', {}, h('b', {}, 'NO FEEDBACK UNTIL THE END.'), ' The contract decodes your run, then DECODE shows every strike.')),
        h('div', { class: 'he-form' }, h('label', { for: 'he-cs' }, 'CALLSIGN'), input, h('span', { class: 'dim' }, 'A-Z 0-9, up to 12')),
        asLine,
        h('div', { class: 'he-actions' }, go),
        msg,
        dexLine),
      h('div', { class: 'he-col' },
        h('h2', {}, "TODAY'S BOARD"),
        board,
        rootLine,
        h('h2', {}, 'WHY IT IS FAIR'),
        h('ol', { class: 'he-steps' },
          h('li', {}, "Today's tapes were committed onchain before anyone played: one Merkle root over every tape seed."),
          h('li', {}, 'You receive pixels only, a few seconds at a time. Your device never learns where the Beasts are.'),
          h('li', {}, 'Your strike log is signed by your player key, kept in this browser (a guest key, or the one your wallet unlocked). The relayer submits it with the revealed seed, and Starknet replays your run in Cairo before it records the score.')))),
  );
  input.id = 'he-cs';
  app.root.append(lobby);

  input.addEventListener('input', () => {
    const v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (v !== input.value) input.value = v;
    paintAs();
  });
  paintAs();
  offs.push(account.subscribe(() => {
    if (document.activeElement !== input) input.value = account.state().callsign;
    paintAs();
  }));
  asLink.addEventListener('click', () => {
    if (busy) return;
    // Keep a callsign typed here: the card edits the same one.
    if (CALLSIGN_RE.test(input.value)) account.setCallsign(input.value);
    sound.sfx('select');
    app.go({ name: 'player', back: 'broadcast' });
  });
  const toArcade = () => { sound.sfx('back'); app.go({ name: 'arcade' }); };
  go.addEventListener('click', () => void tuneIn());
  back.addEventListener('click', toArcade);
  keyHandlers.push((e) => {
    if (e.key === 'Enter') void tuneIn();
    else if (e.key === 'Escape') toArcade();
  });
  // START on the cabinet panel (the keyboard already reaches the handler above).
  offs.push(controls.on('START', () => { if (!player && document.activeElement !== input) void tuneIn(); }));

  let status: StatusResponse | null = null;
  function renderStatus(s: StatusResponse | null) {
    status = s;
    if (!s || !s.onAir) {
      statusTag.textContent = 'CLOSED';
      statusTag.className = 'he-tag off';
      rootLine.textContent = s?.reason ? `No ranked tapes right now (${s.reason}).` : 'No ranked tapes right now.';
      go.hidden = true;
    } else {
      statusTag.textContent = s.offchain ? 'OFFCHAIN TEST' : 'OPEN';
      statusTag.className = `he-tag${s.offchain ? ' test' : ''}`;
      const left = Math.max(0, s.expiresAt - Date.now());
      rootLine.textContent = s.offchain
        ? `Test mode: no contract is configured, so runs are replayed by the server and never sent to Starknet. ${s.n} tapes.`
        : `Tape root #${s.rootId} . ${s.n} tapes . closes in ${Math.floor(left / 3_600_000)}h ${pad(Math.floor(left / 60_000) % 60, 2)}m . contract ${shortAddr(s.contract ?? '')}`;
      go.hidden = false;
    }
    board.innerHTML = '';
    const rows = s?.board ?? [];
    if (!rows.length) board.append(h('p', { class: 'dim' }, 'No verified runs yet today. The first one tops the board.'));
    else {
      const t = h('table', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'CALLSIGN'), h('th', {}, 'SCORE'), h('th', {}, 'PLAYER'), h('th', {}, 'RUN')));
      const me = '0x' + guest.pub.toString(16);
      rows.forEach((r, i) => {
        const mine = BigInt(r.player) === BigInt(me);
        t.append(h('tr', mine ? { class: 'me' } : {}, h('td', {}, String(i + 1)), h('td', {}, r.callsign || '?'), h('td', {}, pad(r.score, 6)),
          h('td', { class: 'dim' }, shortAddr(r.player)), h('td', { class: 'dim' }, `#${r.runId}`)));
      });
      board.append(t);
    }
  }
  const refresh = async () => {
    const s = await fetchStatus();
    if (!disposed && !player) renderStatus(s);
  };
  void refresh();
  /** The player's onchain Bestiary; also the "before" snapshot Decode diffs the run's catches against. */
  const showDex = async (fresh = false) => {
    const total = app.roster.entries.length;
    const dex = await fetchOnchainDex(guest.pub, { fresh });
    if (disposed) return;
    if (!dex) {
      dexLine.className = 'he-dex dim';
      dexLine.textContent = 'YOUR ONCHAIN BESTIARY unavailable right now (offchain test or no connection)';
      return;
    }
    rememberDex(guest.pub, dex);
    const shinies = popcount(dex.shiny);
    dexLine.className = 'he-dex';
    dexLine.replaceChildren('YOUR ONCHAIN BESTIARY ', h('b', {}, `${popcount(dex.caught)}/${total}`), shinies ? ` . ${shinies} shiny` : '');
  };
  void showDex(true);
  const refreshTimer = setInterval(() => void refresh(), 20_000);
  setTimeout(() => input.focus(), 50);

  // ------------------------------------------------------------------ tape
  async function tuneIn() {
    if (busy || !status?.onAir) return;
    const cs = input.value;
    if (!CALLSIGN_RE.test(cs)) {
      msg.textContent = 'Pick a callsign first: 1 to 12 letters or digits.';
      sound.sfx('denied');
      return;
    }
    guest.setCallsign(cs);
    void fetchOnchainDex(guest.pub, { fresh: true }).then((d) => rememberDex(guest.pub, d));
    busy = true;
    msg.textContent = 'Requesting a tape...';
    sound.sfx('start');
    let t: Ticketed;
    try {
      t = await startTape();
    } catch (e) {
      busy = false;
      msg.textContent = `Could not start: ${e instanceof Error ? e.message : e}`;
      return;
    }
    if (disposed) return;
    lobby.remove();
    keyHandlers.length = 0;
    player = new BroadcastPlayer(app.root, t, (strikes) => void submit(t, cs, strikes), () => app.go({ name: 'broadcast' }));
  }

  async function submit(t: Ticketed, callsign: string, strikes: number[]) {
    const p = player!;
    p.status('END OF TAPE', `${strikes.length} strike${strikes.length === 1 ? '' : 's'}. Signing and sending to the relayer...`);
    try {
      const sub = await submitRun(t, callsign, strikes);
      if (!disposed) app.go({ name: 'decode', data: { sub, strikes, callsign, frames: t.start.frames } });
    } catch (e) {
      if (disposed) return;
      const retry = () => {
        keyHandlers.length = 0;
        void submit(t, callsign, strikes);
      };
      const leave = () => app.go({ name: 'arcade' });
      p.status('NOT SENT', `${e instanceof Error ? e.message : e}`, [{ label: '[R] RETRY', run: retry }, { label: '[ESC] ARCADE', run: leave }]);
      keyHandlers.length = 0;
      keyHandlers.push((ev) => {
        if (ev.key === 'r' || ev.key === 'R') retry();
        else if (ev.key === 'Escape') leave();
      });
    }
  }

  return () => {
    disposed = true;
    clearInterval(refreshTimer);
    window.removeEventListener('keydown', onKey);
    offs.forEach((f) => f());
    player?.destroy();
  };
}
