// THE STATIC: a new Beast species whose onchain "Adventurers Killed" grows when it kills a STATIC
// player. This script prepares (and in phase 2 executes) every transaction, all sent from the
// relayer account, which is the species owner and its minter.
//
// Species steps (Beasts registry / NFT). Steps 1-2 do not depend on the game contract:
//   1. registry.register_beast_with_art       art encoded exactly like beasts.app
//   2. nft.mint x3                             named variants (prefix/suffix, level >= 20)
//   3. registry.set_kill_verifier(sp, GAME, true)
//        Redo this for every new GAME address. The registry calls
//        GAME.supports_interface(KILL_VERIFIER_INTERFACE_ID) and reverts unless it returns true,
//        and add_kill later calls GAME.verify_beast_kill(adventurer_id, species, prefix, suffix).
//        The StaticGame deployed at the time of writing has neither entrypoint.
// Roster steps (StaticGame at GAME):
//   4. GAME.set_roster(98 entries, n_featured 23)   the 22 featured species, THE STATIC at
//                                                     index 22, then the 75 commons
//   5. GAME.set_kill_token(22, token)                a minted, non-genesis token of the species
//
// Usage (from the repo root; --game defaults to $STATIC_GAME, then to the deployed v1 game):
//   npx tsx scripts/static-species.ts [--game 0x..]                    plan: calls, calldata, ids
//   npx tsx scripts/static-species.ts [--game 0x..] --dry-run          + simulate steps 1-5 in
//        sequence with starknet_simulateTransactions (SKIP_VALIDATE: unsigned, nothing is sent),
//        plus sncast --dry-run (signed estimates) where a step can stand alone
//   npx tsx scripts/static-species.ts --roster-preview                 write
//        scripts/out/roster.static-preview.json, the roster.json that --apply-roster writes
//
// Phase 2 only (these send transactions through `sncast --account static-relayer`; state is kept
// in scripts/out/static-species-state.json, so a step that already succeeded is skipped):
//   npx tsx scripts/static-species.ts --execute species  --game 0x..   steps 1-3
//   npx tsx scripts/static-species.ts --execute verifier --game 0x..   step 3 only (new GAME)
//   npx tsx scripts/static-species.ts --execute roster   --game 0x..   steps 4-5
//   npx tsx scripts/static-species.ts --apply-roster                   write public/data/roster.json
//        and copy the art to public/beasts/<species>.{png,gif}
//
// This script never reads a private key: sncast signs with its own account file.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { byteArray, CallData, hash, shortString, transaction } from 'starknet';
import { computeOcc, encodeMask, type Roster, type RosterEntry } from '../src/data/roster.ts';
import { decodeGif, decodePng } from './lib/gif.ts';
import { computeMask, DEFAULT_PARAMS } from './lib/mask.ts';

// ---------------------------------------------------------------------------------- config

const RPC_URL = 'https://api.zan.top/public/starknet-sepolia/rpc/v0_10';
const REGISTRY = '0x7f6883b4f901ce25aff2b10c876db8dfff68e61ba93102354816519e7fe1f';
const NFT = '0x2e2f3e29a04f92c2b4e8b91fa846d521aea2a682e490bdf46f18da6d0a8bbe1';
/** StaticGame v1 (deployed, cannot be a kill verifier). Override with --game or $STATIC_GAME. */
const GAME_V1 = '0x01009d6b1abe4adb3c75a25828f5b0c6027583f7499eb8936b19e8fc6794cb29';
/** Relayer = StaticGame owner = species owner = minter. */
const RELAYER = '0x06ab7d632f9493b6b4ab511dca121a1a2b51b55ae2273cb38abf22d7bcba3106';
const SNCAST_ACCOUNT = 'static-relayer';

/** Interface id the registry asks a kill verifier for (read from a Sepolia fork trace). */
const KILL_VERIFIER_INTERFACE_ID = '0x313dda122083d96f86bf4716425c92976808ec1efc8a3bdf240e163e73118ca';

const SPECIES = {
  /** felt252 short string; beasts.app allows [A-Za-z0-9 '-], <= 31 bytes, no edge spaces. */
  name: 'THE STATIC',
  /** Fixed forever at registration. 0 Magic (floats diagonally), 1 Hunter (darts sideways), 2 Brute. */
  beastType: 0,
  /** Fixed forever. SPEC v2: base points 50 + 25 * (5 - tier), so tier 1 is the most valuable kill. */
  tier: 1,
  description:
    'Dead air with a grudge. THE STATIC lives in the snow between channels, a hunched thing of ' +
    'black and white noise that only shows its shape when it moves. If you catch the amber ' +
    'scanline of its smile, it has already seen you.',
};

/** beasts.app defaults for a drawn Beast (mD() in its bundle), except minter (ours, to mint). */
const REGISTER_DEFAULTS = {
  genesisTransferDamageChance: 0,
  soundManager: '0x0', // beasts.app passes its sound manager only when a sound was chosen
  genesisRecipient: '0x0', // genesis goes to the caller
  royaltyBps: 500,
  renderer: '0x0', // NFT default renderer
  genesisVisualEffects: 0,
  genesisSoundEffects: 0,
  reserved: false,
};

/** Perfect card (what genesis tokens carry): centering 10000/10000 bps, no defects. */
const PERFECT_CONDITION = [10000, 0, 10000, 0, 0, 0, 0, 0, 0, 0, 0, 0];

interface Variant {
  label: string;
  prefix: number;
  suffix: number;
  level: number;
  health: number;
  /** Bit 0 = shiny art (checked against the art provider's get_data_uri). */
  visualEffects: number;
  killToken?: boolean;
}

/** Names show as `"<prefix> <suffix>" THE STATIC`; SPEC section 11 affix tables. */
const VARIANTS: Variant[] = [
  { label: 'Mind Bender', prefix: 42, suffix: 9, level: 42, health: 120, visualEffects: 0, killToken: true },
  { label: 'Hypnotic Whisper', prefix: 38, suffix: 11, level: 30, health: 100, visualEffects: 1 },
  { label: 'Vortex Shout', prefix: 65, suffix: 12, level: 24, health: 90, visualEffects: 0 },
];

/** THE STATIC becomes the last featured entry (featured entries come first, SPEC section 3). */
const NEW_FEATURED_INDEX = 22;
/** RosterInput.health: 0 = 100. SPEC v2: health >= 150 adds 1 hp (a 3-hp featured Beast). */
const ROSTER_HEALTH = 0;
/**
 * Silhouette extraction (scripts/lib/mask.ts). The art is solid pixel art, not line art, so the
 * line-art ray fill is off: with it, the hook of the bent right antenna fills in as a solid blob.
 */
const MASK_PARAMS = { ...DEFAULT_PARAMS, rayFill: 0 };
/** beasts.app: 2 * (len(regular uri) + len(shiny uri)) <= 57600 (its "Fits onchain" meter). */
const ART_LIMIT = 57600;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ART_DIR = join(ROOT, 'public/beasts/static-species');
const ROSTER_PATH = join(ROOT, 'public/data/roster.json');
const OUT_DIR = join(ROOT, 'scripts/out');
const STATE_PATH = join(OUT_DIR, 'static-species-state.json');
const PREVIEW_PATH = join(OUT_DIR, 'roster.static-preview.json');

// ------------------------------------------------------------------------------------- rpc

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hex = (x: bigint | number | string) => '0x' + BigInt(x).toString(16);

async function rpc<T>(method: string, params: unknown): Promise<T> {
  let delay = 1500;
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    let text = '';
    try {
      const r = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      status = r.status;
      text = await r.text();
    } catch (e) {
      text = String(e);
    }
    if (status === 200) {
      const j = JSON.parse(text) as { result?: T; error?: { code: number; message: string; data?: unknown } };
      const limited = j.error && /rate|limit|too many|too fast/i.test(j.error.message);
      if (!limited) {
        if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 4000)}`);
        return j.result as T;
      }
    }
    if (attempt >= 8) throw new Error(`${method}: giving up (HTTP ${status}) ${text.slice(0, 300)}`);
    await sleep(delay);
    delay = Math.min(delay * 2, 30000);
  }
}

type Felt = string | number | bigint;

const call = (contract: string, fn: string, calldata: Felt[] = [], block: unknown = 'latest') =>
  rpc<string[]>('starknet_call', {
    request: { contract_address: contract, entry_point_selector: hash.getSelectorFromName(fn), calldata: calldata.map(hex) },
    block_id: block,
  });

/** Sequential calls with a pause (the public endpoint rate-limits bursts). */
async function callAll(calls: [string, string, Felt[]][]): Promise<string[][]> {
  const out: string[][] = [];
  for (const [c, f, d] of calls) {
    out.push(await call(c, f, d));
    await sleep(250);
  }
  return out;
}

// ------------------------------------------------------------------------------------- art

interface Art {
  regularUri: string;
  shinyUri: string;
  /** Characters counted by beasts.app's meter: the same uri goes in the png_* and gif_* slots. */
  onchainChars: number;
}

function loadArt(): Art {
  const uri = (f: string) => `data:image/gif;base64,${readFileSync(join(ART_DIR, f)).toString('base64')}`;
  const regularUri = uri('static_regular.gif');
  const shinyUri = uri('static_shiny.gif');
  return { regularUri, shinyUri, onchainChars: 2 * (regularUri.length + shinyUri.length) };
}

// ---------------------------------------------------------------------------------- roster

interface RosterInput {
  speciesId: number;
  health: number;
  w: number;
  h: number;
  occ: bigint;
  killToken: bigint;
  baseKills: number;
}

function loadRoster(): Roster {
  return JSON.parse(readFileSync(ROSTER_PATH, 'utf8')) as Roster;
}

/** Roster entry for THE STATIC, computed from frame 0 exactly like scripts/fetch-beasts.ts does. */
function staticEntry(speciesId: number, genesisTokenId: string): RosterEntry {
  const png = decodePng(readFileSync(join(ART_DIR, 'static_regular.png')));
  const gif = decodeGif(readFileSync(join(ART_DIR, 'static_regular.gif')));
  const m = computeMask(png.frame0, MASK_PARAMS);
  return {
    speciesId,
    name: SPECIES.name,
    featured: true,
    type: SPECIES.beastType as 0 | 1 | 2,
    tier: SPECIES.tier,
    health: 100,
    level: 1,
    kills: 0,
    aggr: 0,
    creator: hex(RELAYER),
    owner: hex(RELAYER),
    description: SPECIES.description,
    genesisTokenId,
    art: `beasts/${speciesId}.png`,
    gif: `beasts/${speciesId}.gif`,
    artW: png.frame0.w,
    artH: png.frame0.h,
    frames: gif.frames,
    artBox: m.artBox,
    w: m.w,
    h: m.h,
    mask: encodeMask(m.mask, m.w, m.h),
    occ: '0x' + computeOcc(m.mask, m.w, m.h, 1).toString(16),
    maskWarning: m.warning,
  };
}

/** roster.json with THE STATIC inserted at NEW_FEATURED_INDEX (featured), nFeatured + 1. */
function rosterWithStatic(roster: Roster, entry: RosterEntry): Roster {
  const featured = roster.entries.filter((e) => e.featured);
  const common = roster.entries.filter((e) => !e.featured);
  if (featured.length !== roster.nFeatured || roster.entries.slice(0, roster.nFeatured).some((e) => !e.featured)) {
    throw new Error('roster.json: featured entries must come first');
  }
  if (roster.entries.some((e) => e.speciesId === entry.speciesId)) throw new Error(`roster.json already has ${entry.speciesId}`);
  if (featured.length !== NEW_FEATURED_INDEX) throw new Error(`expected ${NEW_FEATURED_INDEX} featured entries, found ${featured.length}`);
  return { ...roster, generatedAt: new Date().toISOString(), nFeatured: featured.length + 1, entries: [...featured, entry, ...common] };
}

/** Same layout as fetch-beasts.ts: header, then one entry per line. */
function serializeRoster(roster: Roster): string {
  const { entries, ...header } = roster;
  const json = JSON.stringify(header).replace(/\}$/, ',"entries":[\n') + entries.map((e) => JSON.stringify(e)).join(',\n') + '\n]}\n';
  JSON.parse(json);
  return json;
}

/** RosterInput list for set_roster, in roster.json order (health 0 = 100, kill_token 0 = keep). */
function rosterInputs(roster: Roster): RosterInput[] {
  return roster.entries.map((e, i) => ({
    speciesId: e.speciesId,
    health: i === NEW_FEATURED_INDEX ? ROSTER_HEALTH : 0,
    w: e.w,
    h: e.h,
    occ: BigInt(e.occ),
    killToken: 0n,
    baseKills: 0,
  }));
}

// -------------------------------------------------------------------------------- calldata

interface Step {
  name: string;
  contract: string;
  fn: string;
  calldata: string[];
  /** Needs the result of an earlier step (species id / token id). */
  dependsOn?: string;
}

const felts = (xs: (Felt | boolean)[]) => CallData.compile(xs.map((x) => (typeof x === 'boolean' ? (x ? 1 : 0) : x)) as never).map(hex);

function registerStep(art: Art): Step {
  // Mirrors beasts.app registerWithArtCall(mD(...)): name short string, enum index, tier, minter,
  // U2 fields, then the four art ByteArrays (regular uri, shiny uri, regular uri, shiny uri), reserved.
  const calldata = CallData.compile([
    shortString.encodeShortString(SPECIES.name),
    SPECIES.beastType,
    SPECIES.tier,
    RELAYER, // minter (beasts.app passes 0x0, which leaves minting paused: 'Species minting paused')
    REGISTER_DEFAULTS.genesisTransferDamageChance,
    REGISTER_DEFAULTS.soundManager,
    REGISTER_DEFAULTS.genesisRecipient,
    RELAYER, // species_owner
    REGISTER_DEFAULTS.royaltyBps,
    byteArray.byteArrayFromString(SPECIES.description),
    REGISTER_DEFAULTS.renderer,
    REGISTER_DEFAULTS.genesisVisualEffects,
    REGISTER_DEFAULTS.genesisSoundEffects,
    byteArray.byteArrayFromString(art.regularUri), // png_regular
    byteArray.byteArrayFromString(art.shinyUri), // png_shiny
    byteArray.byteArrayFromString(art.regularUri), // gif_regular
    byteArray.byteArrayFromString(art.shinyUri), // gif_shiny
    REGISTER_DEFAULTS.reserved ? 1 : 0,
  ]).map(hex);
  return { name: 'register_beast_with_art', contract: REGISTRY, fn: 'register_beast_with_art', calldata };
}

function mintStep(speciesId: number, v: Variant): Step {
  return {
    name: `mint "${v.label}" ${SPECIES.name}`,
    contract: NFT,
    fn: 'mint',
    calldata: felts([RELAYER, speciesId, v.prefix, v.suffix, v.level, v.health, v.visualEffects, 0, 0, 0, 0, ...PERFECT_CONDITION]),
    dependsOn: 'species id',
  };
}

function killVerifierStep(speciesId: number, game: string, trusted = true): Step {
  return {
    name: `set_kill_verifier(species, GAME, ${trusted})`,
    contract: REGISTRY,
    fn: 'set_kill_verifier',
    calldata: felts([speciesId, game, trusted]),
    dependsOn: 'species id',
  };
}

function setRosterStep(game: string, inputs: RosterInput[], nFeatured: number): Step {
  const flat: Felt[] = [inputs.length];
  for (const e of inputs) flat.push(e.speciesId, e.health, e.w, e.h, e.occ, e.killToken, e.baseKills);
  flat.push(nFeatured);
  return { name: `set_roster(${inputs.length} entries, n_featured ${nFeatured})`, contract: game, fn: 'set_roster', calldata: felts(flat), dependsOn: 'species id' };
}

function killTokenStep(game: string, tokenId: bigint): Step {
  return { name: `set_kill_token(${NEW_FEATURED_INDEX}, token)`, contract: game, fn: 'set_kill_token', calldata: felts([NEW_FEATURED_INDEX, tokenId]), dependsOn: 'token id' };
}

interface Plan {
  speciesId: number;
  species: Step[];
  roster: Step[];
  entry: RosterEntry;
}

function buildPlan(art: Art, game: string, speciesId: number, killToken: bigint, genesisTokenId = 'TBD'): Plan {
  const entry = staticEntry(speciesId, genesisTokenId);
  const roster = rosterWithStatic(loadRoster(), entry);
  return {
    speciesId,
    entry,
    species: [registerStep(art), ...VARIANTS.map((v) => mintStep(speciesId, v)), killVerifierStep(speciesId, game)],
    roster: [setRosterStep(game, rosterInputs(roster), roster.nFeatured), killTokenStep(game, killToken)],
  };
}

// ------------------------------------------------------------------------------ simulation

interface FeeEstimate {
  l1_gas_consumed: string;
  l2_gas_consumed: string;
  l1_data_gas_consumed: string;
  overall_fee: string;
}

interface Invocation {
  result: string[];
  calls: Invocation[];
}

interface SimResult {
  transaction_trace: { execute_invocation: Invocation | { revert_reason: string } };
  fee_estimation: FeeEstimate;
}

interface BlockHeader {
  block_number: number;
  l1_gas_price: { price_in_fri: string };
  l2_gas_price: { price_in_fri: string };
  l1_data_gas_price: { price_in_fri: string };
}

function invokeTx(step: Step, nonce: bigint, block: BlockHeader) {
  const calldata = transaction.getExecuteCalldata([{ contractAddress: step.contract, entrypoint: step.fn, calldata: step.calldata }], '1').map(hex);
  const bound = (amount: bigint, price: string) => ({ max_amount: hex(amount), max_price_per_unit: hex(BigInt(price) * 2n) });
  return {
    type: 'INVOKE',
    version: '0x3',
    sender_address: RELAYER,
    calldata,
    signature: [],
    nonce: hex(nonce),
    resource_bounds: {
      l1_gas: bound(100_000n, block.l1_gas_price.price_in_fri),
      l2_gas: bound(1_000_000_000n, block.l2_gas_price.price_in_fri),
      l1_data_gas: bound(1_000_000n, block.l1_data_gas_price.price_in_fri),
    },
    tip: '0x0',
    paymaster_data: [],
    account_deployment_data: [],
    nonce_data_availability_mode: 'L1',
    fee_data_availability_mode: 'L1',
  };
}

/** Simulate `steps` as consecutive transactions from the relayer, on top of `block`. */
async function simulate(steps: Step[], block: BlockHeader): Promise<SimResult[]> {
  const blockId = { block_number: block.block_number };
  const nonce = BigInt(await rpc<string>('starknet_getNonce', { block_id: blockId, contract_address: RELAYER }));
  const txs = steps.map((s, i) => invokeTx(s, nonce + BigInt(i), block));
  return rpc<SimResult[]>('starknet_simulateTransactions', { block_id: blockId, transactions: txs, simulation_flags: ['SKIP_VALIDATE', 'SKIP_FEE_CHARGE'] });
}

/** The single inner call of a one-call multicall (account -> target). */
function innerResult(sim: SimResult): { ok: true; result: string[] } | { ok: false; reason: string } {
  const ex = sim.transaction_trace.execute_invocation;
  if ('revert_reason' in ex) return { ok: false, reason: ex.revert_reason };
  return { ok: true, result: ex.calls[0]?.result ?? [] };
}

/** Short, readable revert reason: the innermost quoted messages of a nested error. */
function shortReason(reason: string): string {
  const msgs = [...reason.matchAll(/\('([^']+)'\)/g)].map((m) => m[1]);
  const selectors = [...reason.matchAll(/selector: (0x[0-9a-f]+)/g)].map((m) => m[1]);
  const last = selectors[selectors.length - 1];
  const named = last && BigInt(last) === BigInt(hash.getSelectorFromName('supports_interface')) ? ' in GAME.supports_interface' : '';
  return msgs.length ? `${[...new Set(msgs)].join(' / ')}${named}` : reason.slice(0, 300);
}

const strk = (fri: bigint) => (Number(fri) / 1e18).toFixed(4);

// ---------------------------------------------------------------------------------- sncast

function sncast(args: string[], opts: { json?: boolean } = {}): { status: number; out: string } {
  const env = { ...process.env, PATH: `${process.env.HOME}/.asdf/shims:${process.env.HOME}/.local/bin:${process.env.PATH}` };
  const full = ['--account', SNCAST_ACCOUNT, ...(opts.json ? ['--json'] : []), ...args];
  const r = spawnSync('sncast', full, { cwd: join(ROOT, 'contracts'), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function sncastInvokeArgs(step: Step, extra: string[]): string[] {
  return ['invoke', '--url', RPC_URL, '--contract-address', step.contract, '--function', step.fn, '--calldata', ...step.calldata, ...extra];
}

/** sncast --dry-run of a multicall file (one transaction with several calls). */
function sncastMulticallDryRun(steps: Step[]): { status: number; out: string } {
  const toml = steps
    .map((s) => `[[call]]\ncall_type = "invoke"\ncontract_address = "${s.contract}"\nfunction = "${s.fn}"\ninputs = [${s.calldata.map((c) => `"${c}"`).join(', ')}]\n`)
    .join('\n');
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, 'static-species-multicall.toml');
  writeFileSync(path, toml);
  return sncast(['multicall', 'run', '--url', RPC_URL, '--path', path, '--dry-run', '--detailed']);
}

const indent = (s: string) =>
  s
    .split('\n')
    .map((l) => '     ' + l)
    .join('\n');

// ------------------------------------------------------------------------------ chain state

async function readChainState(game: string) {
  const [open, cursors, count, owner, rosterLen, nFeatured, rootCount] = await callAll([
    [REGISTRY, 'is_registration_open', []],
    [REGISTRY, 'get_species_id_cursors', []],
    [REGISTRY, 'species_count', []],
    [game, 'owner', []],
    [game, 'roster_len', []],
    [game, 'n_featured', []],
    [game, 'root_count', []],
  ]);
  let supportsKv: boolean | string;
  try {
    supportsKv = BigInt((await call(game, 'supports_interface', [KILL_VERIFIER_INTERFACE_ID]))[0]) === 1n;
  } catch (e) {
    supportsKv = /ENTRYPOINT_NOT_FOUND|not found/i.test(String(e)) ? 'no supports_interface entrypoint' : String(e).slice(0, 120);
  }
  return {
    registrationOpen: BigInt(open[0]) === 1n,
    /** get_species_id_cursors returns (next original id, next community id). */
    nextSpeciesId: Number(BigInt(cursors[1])),
    speciesCount: Number(BigInt(count[0])),
    gameOwner: BigInt(owner[0]),
    rosterLen: Number(BigInt(rosterLen[0])),
    nFeatured: Number(BigInt(nFeatured[0])),
    rootCount: Number(BigInt(rootCount[0])),
    supportsKv,
  };
}

/** If GAME already holds the 97-entry roster, it must equal roster.json (set_roster replaces it). */
async function checkOnchainRoster(game: string, roster: Roster): Promise<string[]> {
  const problems: string[] = [];
  const views = await callAll(roster.entries.map((_, i) => [game, 'get_roster_entry', [i]] as [string, string, Felt[]]));
  roster.entries.forEach((e, i) => {
    const v = views[i].map((x) => BigInt(x));
    // RosterView { species_id, beast_type, tier, health, w, h, occ, kill_token, base_kills }
    const want = [BigInt(e.speciesId), BigInt(e.type), BigInt(e.tier), 100n, BigInt(e.w), BigInt(e.h), BigInt(e.occ), 0n, 0n];
    if (want.some((x, k) => x !== v[k])) problems.push(`idx ${i} species ${e.speciesId}: chain [${v.join(',')}] vs roster.json [${want.join(',')}]`);
  });
  return problems;
}

function printPlan(plan: Plan, art: Art, game: string): void {
  const e = plan.entry;
  console.log(`\nTHE STATIC: species ${plan.speciesId} (predicted), type ${SPECIES.beastType} tier ${SPECIES.tier}, GAME ${game}`);
  console.log(`art: regular ${art.regularUri.length} + shiny ${art.shinyUri.length} chars, beasts.app meter ${art.onchainChars} / ${ART_LIMIT}`);
  console.log(`roster entry: idx ${NEW_FEATURED_INDEX} featured, ${e.w}x${e.h} occ ${e.occ} artBox [${e.artBox.join(',')}] frames ${e.frames}${e.maskWarning ? ' WARN ' + e.maskWarning : ''}`);
  const show = (title: string, steps: Step[], first: number) => {
    console.log(`\n${title}`);
    steps.forEach((s, i) => {
      const target = s.contract === REGISTRY ? 'registry' : s.contract === NFT ? 'nft' : 'GAME';
      console.log(`  ${first + i}. ${target}.${s.fn}  ${s.name}  calldata ${s.calldata.length} felts${s.dependsOn ? `  (needs ${s.dependsOn})` : ''}`);
    });
  };
  show('Species steps (registry / NFT; step 3 must be redone for every new GAME):', plan.species, 1);
  show('Roster steps (StaticGame at GAME):', plan.roster, plan.species.length + 1);
}

async function dryRun(art: Art, game: string, nextSpeciesId: number): Promise<void> {
  const block = await rpc<BlockHeader>('starknet_getBlockWithTxHashes', { block_id: 'latest' });
  console.log(`\nSimulating on block ${block.block_number} (l2 gas ${BigInt(block.l2_gas_price.price_in_fri)} fri, l1 data gas ${BigInt(block.l1_data_gas_price.price_in_fri)} fri)`);

  // Pass 1: register + mints, to learn the species id and the minted token ids.
  const plan0 = buildPlan(art, game, nextSpeciesId, 0n);
  const sim1 = await simulate(plan0.species.slice(0, 1 + VARIANTS.length), block);
  const reg = innerResult(sim1[0]);
  if (!reg.ok) throw new Error(`register reverted: ${reg.reason}`);
  const speciesId = Number(BigInt(reg.result[0]));
  if (speciesId !== nextSpeciesId) console.log(`  note: simulated species id ${speciesId} != cursor ${nextSpeciesId}`);
  const tokens: bigint[] = [];
  for (let k = 0; k < VARIANTS.length; k++) {
    const r = innerResult(sim1[1 + k]);
    if (!r.ok) throw new Error(`mint ${VARIANTS[k].label} reverted: ${r.reason}`);
    tokens.push(BigInt(r.result[0]));
  }
  const killToken = tokens[VARIANTS.findIndex((v) => v.killToken)];

  // Pass 2: steps 1-5 (same block, so the token ids are the same).
  const plan = buildPlan(art, game, speciesId, killToken);
  const steps = [...plan.species, ...plan.roster];
  const sims = await simulate(steps, block);
  let total = 0n;
  console.log('\nSimulated sequence (starknet_simulateTransactions, SKIP_VALIDATE + SKIP_FEE_CHARGE, unsigned):');
  sims.forEach((s, i) => {
    const r = innerResult(s);
    const f = s.fee_estimation;
    total += BigInt(f.overall_fee);
    const res = r.ok ? `ok -> [${r.result.map((x) => (x.length > 20 ? x.slice(0, 18) + '..' : x)).join(', ')}]` : `REVERTED: ${shortReason(r.reason)}`;
    if (i === plan.species.length) console.log('  -- roster steps');
    console.log(
      `  ${i + 1}. ${steps[i].name.padEnd(44)} ${strk(BigInt(f.overall_fee)).padStart(8)} STRK  ` +
        `(l2 ${BigInt(f.l2_gas_consumed)}, l1 data ${BigInt(f.l1_data_gas_consumed)})  ${res}`,
    );
  });
  console.log(`  total ${strk(total)} STRK`);
  console.log(`  species ${speciesId}; tokens ${VARIANTS.map((v, k) => `${v.label}=${hex(tokens[k])}`).join(', ')}`);
  console.log(`  kill token (${VARIANTS.find((v) => v.killToken)?.label}) ${hex(killToken)}; token ids embed the mint block, so the real ones differ`);

  console.log('\nsncast --dry-run (signed estimates through the static-relayer account):');
  const r1 = sncast(sncastInvokeArgs(plan.species[0], ['--dry-run', '--detailed']));
  console.log(`  step 1 alone (register_beast_with_art): ${r1.status === 0 ? '' : 'FAILED'}\n${indent(r1.out)}`);
  // Steps 2 and 4 need the species to exist, so they can only be estimated batched with step 1.
  // Step 3 is left out (it reverts unless GAME is a kill verifier) and step 5 needs a real token id.
  const mcSteps = [...plan.species.slice(0, 1 + VARIANTS.length), plan.roster[0]];
  const mc = sncastMulticallDryRun(mcSteps);
  console.log(`\n  steps 1, 2 and 4 in ONE multicall (register + 3 mints + set_roster): ${mc.status === 0 ? '' : 'FAILED'}\n${indent(mc.out)}`);
}

// --------------------------------------------------------------------------------- execute

interface State {
  speciesId?: number;
  registerTx?: string;
  mints?: Record<string, { tx: string; tokenId: string }>;
  /** GAME address -> set_kill_verifier tx. */
  verifiers?: Record<string, string>;
  /** GAME address -> roster txs. */
  rosters?: Record<string, { setRosterTx?: string; killTokenTx?: string }>;
}

function loadState(): State {
  return existsSync(STATE_PATH) ? (JSON.parse(readFileSync(STATE_PATH, 'utf8')) as State) : {};
}

function saveState(s: State): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n');
}

function invokeOrThrow(step: Step): string {
  const r = sncast(sncastInvokeArgs(step, []), { json: true });
  if (r.status !== 0) throw new Error(`${step.name} failed:\n${r.out}`);
  const m = /"transaction_hash"\s*:\s*"(0x[0-9a-fA-F]+)"/.exec(r.out) ?? /transaction[_ ]hash:?\s*(0x[0-9a-fA-F]+)/i.exec(r.out);
  if (!m) throw new Error(`${step.name}: no transaction hash in sncast output:\n${r.out}`);
  return m[1];
}

interface Receipt {
  execution_status: string;
  finality_status: string;
  revert_reason?: string;
  events: { from_address: string; keys: string[]; data: string[] }[];
}

async function waitReceipt(tx: string): Promise<Receipt> {
  for (let i = 0; i < 120; i++) {
    let r: Receipt | null = null;
    try {
      r = await rpc<Receipt>('starknet_getTransactionReceipt', { transaction_hash: tx });
    } catch {
      r = null; // not known yet
    }
    if (r && r.finality_status !== 'RECEIVED') {
      if (r.execution_status !== 'SUCCEEDED') throw new Error(`tx ${tx} reverted: ${r.revert_reason}`);
      return r;
    }
    await sleep(3000);
  }
  throw new Error(`tx ${tx}: no receipt after 6 minutes`);
}

async function executeSpecies(art: Art, game: string, st: State, withVerifier: boolean): Promise<void> {
  if (st.speciesId === undefined) {
    const [open] = await call(REGISTRY, 'is_registration_open');
    if (BigInt(open) !== 1n) throw new Error('registry registration is closed');
    const step = registerStep(art);
    console.log(`1. ${step.name} ...`);
    const tx = invokeOrThrow(step);
    const rc = await waitReceipt(tx);
    const sel = BigInt(hash.getSelectorFromName('BeastRegistered'));
    const ev = rc.events.find((e) => BigInt(e.from_address) === BigInt(REGISTRY) && BigInt(e.keys[0]) === sel);
    if (!ev) throw new Error(`register ${tx}: no BeastRegistered event`);
    st.speciesId = Number(BigInt(ev.keys[1]));
    st.registerTx = tx;
    saveState(st);
    console.log(`   species ${st.speciesId} (tx ${tx})`);
  }
  const sid = st.speciesId;
  st.mints ??= {};
  for (const v of VARIANTS) {
    if (st.mints[v.label]) continue;
    const step = mintStep(sid, v);
    console.log(`2. ${step.name} ...`);
    const tx = invokeOrThrow(step);
    await waitReceipt(tx);
    // The public RPC can serve a node that has not seen the mint yet: retry before giving up.
    let tok = '0x0';
    for (let attempt = 0; attempt < 10 && BigInt(tok) === 0n; attempt++) {
      if (attempt) await sleep(3000);
      [tok] = await call(NFT, 'get_token_id_by_affixes', [sid, v.prefix, v.suffix]);
    }
    if (BigInt(tok) === 0n) throw new Error(`mint ${v.label}: token id not found`);
    st.mints[v.label] = { tx, tokenId: hex(tok) };
    saveState(st);
    console.log(`   token ${hex(tok)} (tx ${tx})`);
  }
  if (withVerifier) await executeVerifier(game, st);
}

async function executeVerifier(game: string, st: State): Promise<void> {
  if (st.speciesId === undefined) throw new Error('no species yet: run --execute species first');
  st.verifiers ??= {};
  const key = hex(game);
  if (st.verifiers[key]) return;
  const [ok] = await call(game, 'supports_interface', [KILL_VERIFIER_INTERFACE_ID]).catch(() => ['0x0']);
  if (BigInt(ok) !== 1n) throw new Error(`GAME ${game} does not answer supports_interface(${KILL_VERIFIER_INTERFACE_ID}) = true; set_kill_verifier would revert`);
  const step = killVerifierStep(st.speciesId, game);
  console.log(`3. ${step.name} ...`);
  st.verifiers[key] = invokeOrThrow(step);
  await waitReceipt(st.verifiers[key]);
  saveState(st);
  const [kv] = await call(REGISTRY, 'is_kill_verifier', [st.speciesId, game]);
  console.log(`   is_kill_verifier(${st.speciesId}, GAME) = ${BigInt(kv)}`);
}

async function executeRoster(art: Art, game: string, st: State): Promise<void> {
  if (st.speciesId === undefined || !st.mints) throw new Error('no species yet: run --execute species first');
  const [owner] = await call(game, 'owner');
  if (BigInt(owner) !== BigInt(RELAYER)) throw new Error(`relayer is not the owner of GAME ${game}`);
  st.rosters ??= {};
  const key = hex(game);
  const rs = (st.rosters[key] ??= {});
  const label = VARIANTS.find((v) => v.killToken)?.label as string;
  const plan = buildPlan(art, game, st.speciesId, BigInt(st.mints[label].tokenId));
  if (!rs.setRosterTx) {
    console.log(`4. ${plan.roster[0].name} ...`);
    rs.setRosterTx = invokeOrThrow(plan.roster[0]);
    await waitReceipt(rs.setRosterTx);
    saveState(st);
  }
  if (!rs.killTokenTx) {
    console.log(`5. ${plan.roster[1].name} ...`);
    rs.killTokenTx = invokeOrThrow(plan.roster[1]);
    await waitReceipt(rs.killTokenTx);
    saveState(st);
  }
  const [len, nf, view] = await callAll([
    [game, 'roster_len', []],
    [game, 'n_featured', []],
    [game, 'get_roster_entry', [NEW_FEATURED_INDEX]],
  ]);
  console.log(`verify: roster_len ${BigInt(len[0])}, n_featured ${BigInt(nf[0])}, entry 22 [${view.map((x) => BigInt(x)).join(', ')}]`);
  console.log('next: --apply-roster, rebuild the API bundle and deploy, all before the next post_tape_root');
}

async function applyRoster(): Promise<void> {
  const st = loadState();
  if (st.speciesId === undefined) throw new Error('no species id in state; run --execute species first');
  const [gen] = await call(NFT, 'get_genesis_token_id', [st.speciesId]);
  const roster = rosterWithStatic(loadRoster(), staticEntry(st.speciesId, hex(gen)));
  writeFileSync(ROSTER_PATH, serializeRoster(roster));
  copyFileSync(join(ART_DIR, 'static_regular.png'), join(ROOT, 'public/beasts', `${st.speciesId}.png`));
  copyFileSync(join(ART_DIR, 'static_regular.gif'), join(ROOT, 'public/beasts', `${st.speciesId}.gif`));
  console.log(`roster.json: ${roster.entries.length} entries, nFeatured ${roster.nFeatured}; art copied to public/beasts/${st.speciesId}.{png,gif}`);
}

// ------------------------------------------------------------------------------------ main

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const game = hex(argValue('--game') ?? process.env.STATIC_GAME ?? GAME_V1);
  const art = loadArt();
  if (art.onchainChars > ART_LIMIT) throw new Error(`art too large for beasts.app's limit: ${art.onchainChars} > ${ART_LIMIT}`);

  const exec = argValue('--execute');
  if (exec) {
    const st = loadState();
    if (exec === 'species') return executeSpecies(art, game, st, true);
    if (exec === 'verifier') return executeVerifier(game, st);
    if (exec === 'roster') return executeRoster(art, game, st);
    throw new Error(`--execute species | verifier | roster (got ${exec})`);
  }
  if (args.has('--apply-roster')) return applyRoster();

  const chain = await readChainState(game);
  console.log(
    `registry: registration ${chain.registrationOpen ? 'open' : 'CLOSED'}, ${chain.speciesCount} species, next community id ${chain.nextSpeciesId}\n` +
      `GAME ${game}: owner ${chain.gameOwner === BigInt(RELAYER) ? 'relayer' : hex(chain.gameOwner) + ' (NOT the relayer)'}, ` +
      `roster ${chain.rosterLen} (${chain.nFeatured} featured), roots ${chain.rootCount}, ` +
      `kill verifier interface: ${chain.supportsKv === true ? 'yes' : chain.supportsKv === false ? 'NO (supports_interface = false)' : 'NO (' + chain.supportsKv + ')'}`,
  );
  const plan = buildPlan(art, game, chain.nextSpeciesId, 0n);
  printPlan(plan, art, game);

  if (args.has('--roster-preview')) {
    const roster = rosterWithStatic(loadRoster(), plan.entry);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(PREVIEW_PATH, serializeRoster(roster));
    console.log(`\nwrote ${PREVIEW_PATH} (${roster.entries.length} entries, nFeatured ${roster.nFeatured}; genesisTokenId is filled in by --apply-roster)`);
  }
  if (args.has('--dry-run')) {
    const roster = loadRoster();
    if (chain.rosterLen === roster.entries.length) {
      const problems = await checkOnchainRoster(game, roster);
      console.log(problems.length ? `\nGAME roster differs from roster.json:\n  ${problems.join('\n  ')}` : `\nGAME roster == roster.json (all ${roster.entries.length} entries)`);
    }
    await dryRun(art, game, chain.nextSpeciesId);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
