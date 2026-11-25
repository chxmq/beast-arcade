//! Contract flow tests for StaticGame (SPEC v3) with mocked Beasts registry / NFT.

use core::poseidon::poseidon_hash_span;
use snforge_std::signature::SignerTrait;
use snforge_std::signature::stark_curve::{
    StarkCurveKeyPair, StarkCurveKeyPairImpl, StarkCurveSignerImpl,
};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, EventSpyAssertionsTrait, EventSpyTrait, declare,
    spy_events, start_cheat_block_timestamp_global, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use starknet::ContractAddress;
use static_game::constants::{GAP_HIT, IKILL_VERIFIER_ID, ISRC5_ID, MAX_ROSTER, NO_INDEX};
use static_game::interfaces::{
    DexUpdated, IBeastsDispatcher, IBeastsDispatcherTrait, IBeastsSafeDispatcher,
    IBeastsSafeDispatcherTrait, IKillVerifierDispatcher, IKillVerifierDispatcherTrait,
    ISRC5Dispatcher, ISRC5DispatcherTrait, IStaticGameDispatcher, IStaticGameDispatcherTrait,
    RosterInput,
};
use static_game::sim::{RosterEntry, RunResult, Spawn, build_schedule, replay};
use static_game::static_game::StaticGame;
use crate::helpers::{bot, jam_bot};
use crate::mocks::{
    IMockBeastsDispatcher, IMockBeastsDispatcherTrait, IMockRegistryDispatcher,
    IMockRegistryDispatcherTrait,
};

const T0: u64 = 1763337600 + 3600; // 2025-11-17 01:00 UTC
const DAY0: u32 = 20409; // T0 / 86400
const N_FEATURED: u32 = 3;
const SPECIES: [u32; 6] = [10011, 10012, 10013, 1, 2, 3];

fn owner() -> ContractAddress {
    'owner'.try_into().unwrap()
}

fn relayer() -> ContractAddress {
    'relayer'.try_into().unwrap()
}

fn stranger() -> ContractAddress {
    'stranger'.try_into().unwrap()
}

#[derive(Drop, Copy)]
struct Env {
    game: IStaticGameDispatcher,
    addr: ContractAddress,
    registry: IMockRegistryDispatcher,
    nft: IMockBeastsDispatcher,
    nft_view: IBeastsDispatcher,
}

fn roster_inputs() -> Array<RosterInput> {
    array![
        // featured
        RosterInput {
            species_id: 10011,
            health: 0,
            w: 48,
            h: 40,
            occ: 0x3c7effffffff7e3c,
            kill_token: 0,
            base_kills: 0,
        },
        RosterInput {
            species_id: 10012,
            health: 120,
            w: 40,
            h: 32,
            occ: 0xffffffffffffffff,
            kill_token: 0,
            base_kills: 1,
        },
        RosterInput {
            species_id: 10013,
            health: 100,
            w: 56,
            h: 48,
            occ: 0x7e7e7e7e7e7e7e7e,
            kill_token: 0,
            base_kills: 7,
        },
        // common
        RosterInput {
            species_id: 1,
            health: 80,
            w: 32,
            h: 32,
            occ: 0x00ffff00ffff00ff,
            kill_token: 0,
            base_kills: 0,
        },
        RosterInput {
            species_id: 2,
            health: 100,
            w: 64,
            h: 56,
            occ: 0xffffffffffffffff,
            kill_token: 0,
            base_kills: 3,
        },
        RosterInput {
            species_id: 3,
            health: 150,
            w: 24,
            h: 24,
            occ: 0x8142241818244281,
            kill_token: 0,
            base_kills: 0,
        },
    ]
}

fn setup() -> Env {
    start_cheat_block_timestamp_global(T0);
    let reg_class = declare("MockRegistry").unwrap().contract_class();
    let (reg_addr, _) = reg_class.deploy(@array![]).unwrap();
    let nft_class = declare("MockBeasts").unwrap().contract_class();
    let (nft_addr, _) = nft_class.deploy(@array![reg_addr.into()]).unwrap();
    let game_class = declare("StaticGame").unwrap().contract_class();
    let (addr, _) = game_class
        .deploy(@array![owner().into(), reg_addr.into(), nft_addr.into()])
        .unwrap();

    let registry = IMockRegistryDispatcher { contract_address: reg_addr };
    registry.set_definition(10011, 0, 3); // Magic T3
    registry.set_definition(10012, 1, 2); // Hunter T2
    registry.set_definition(10013, 2, 4); // Brute T4
    registry.set_definition(1, 0, 1);
    registry.set_definition(2, 1, 5);
    registry.set_definition(3, 2, 3);

    let game = IStaticGameDispatcher { contract_address: addr };
    start_cheat_caller_address(addr, owner());
    game.set_roster(roster_inputs(), N_FEATURED);
    game.set_relayer(relayer(), true);
    stop_cheat_caller_address(addr);
    Env {
        game,
        addr,
        registry,
        nft: IMockBeastsDispatcher { contract_address: nft_addr },
        nft_view: IBeastsDispatcher { contract_address: nft_addr },
    }
}

// ----------------------------------------------------------------------------- Merkle tapes

fn seed_of(salt: felt252, k: u32) -> felt252 {
    poseidon_hash_span(array!['seed', salt, k.into()].span())
}

/// Documented leaf: poseidon_hash_span([k, seed]).
fn leaf(k: u32, seed: felt252) -> felt252 {
    poseidon_hash_span(array![k.into(), seed].span())
}

/// Documented internal node: poseidon_hash_span([min, max]) (integer order).
fn pair(a: felt252, b: felt252) -> felt252 {
    let au: u256 = a.into();
    let bu: u256 = b.into();
    if au < bu {
        poseidon_hash_span(array![a, b].span())
    } else {
        poseidon_hash_span(array![b, a].span())
    }
}

#[derive(Drop)]
struct Tape {
    salt: felt252,
    n: u32,
    levels: Array<Span<felt252>>,
    root: felt252,
}

/// Full binary tree over n (a power of two) leaves.
fn build_tape(salt: felt252, n: u32) -> Tape {
    let mut leaves: Array<felt252> = array![];
    for k in 0..n {
        leaves.append(leaf(k, seed_of(salt, k)));
    }
    let mut levels: Array<Span<felt252>> = array![];
    let mut cur = leaves.span();
    levels.append(cur);
    while cur.len() > 1 {
        let mut next: Array<felt252> = array![];
        let mut i = 0;
        while i < cur.len() {
            next.append(pair(*cur.at(i), *cur.at(i + 1)));
            i += 2;
        }
        cur = next.span();
        levels.append(cur);
    }
    Tape { salt, n, root: *cur.at(0), levels }
}

fn proof_of(t: @Tape, k: u32) -> Array<felt252> {
    let mut out: Array<felt252> = array![];
    let mut idx = k;
    let mut l: u32 = 0;
    while l + 1 < t.levels.len() {
        let level = *t.levels.at(l);
        let sib = if idx % 2 == 0 {
            idx + 1
        } else {
            idx - 1
        };
        out.append(*level.at(sib));
        idx /= 2;
        l += 1;
    }
    out
}

fn post(env: Env, t: @Tape, expires_at: u64) -> u32 {
    start_cheat_caller_address(env.addr, relayer());
    let id = env.game.post_tape_root(*t.root, *t.n, expires_at);
    stop_cheat_caller_address(env.addr);
    id
}

// ----------------------------------------------------------------------------- players

fn player(secret: felt252) -> StarkCurveKeyPair {
    StarkCurveKeyPairImpl::from_secret_key(secret)
}

/// Documented tape index: poseidon_hash_span([player_pub, nonce]) mod n.
fn tape_k(player_pub: felt252, nonce: felt252, n: u32) -> u32 {
    let h: u256 = poseidon_hash_span(array![player_pub, nonce].span()).into();
    (h % n.into()).try_into().unwrap()
}

/// First nonce whose tape is still unused.
fn pick_nonce(env: Env, root_id: u32, n: u32, player_pub: felt252) -> (felt252, u32) {
    let mut nonce: felt252 = 1;
    loop {
        let k = tape_k(player_pub, nonce, n);
        if !env.game.is_tape_used(root_id, k) {
            assert_eq!(env.game.tape_index(root_id, player_pub, nonce), k);
            break (nonce, k);
        }
        nonce += 1;
    }
}

/// Documented message: poseidon_hash_span(['STATIC', root_id, k, nonce, callsign, ...strikes]).
fn message(root_id: u32, k: u32, nonce: felt252, callsign: felt252, strikes: Span<u32>) -> felt252 {
    let mut data: Array<felt252> = array!['STATIC', root_id.into(), k.into(), nonce, callsign];
    for s in strikes {
        data.append((*s).into());
    }
    poseidon_hash_span(data.span())
}

/// The root's roster as plain sim entries (from the view the TS client uses).
fn root_entries(env: Env, root_id: u32) -> Array<RosterEntry> {
    let mut out: Array<RosterEntry> = array![];
    for (_species, e) in env.game.get_root_roster(root_id) {
        out.append(e);
    }
    out
}

fn bot_strikes(env: Env, root_id: u32, seed: felt252, count: u32, mode: u32) -> Array<u32> {
    let entries = root_entries(env, root_id);
    let nf = env.game.get_root(root_id).n_featured;
    let spawns = build_schedule(seed, entries.span(), nf);
    bot(spawns.span(), 72, 20, count, mode)
}

#[derive(Drop, Copy)]
struct Submission {
    root_id: u32,
    k: u32,
    nonce: felt252,
    seed: felt252,
    player_pub: felt252,
    callsign: felt252,
    r: felt252,
    s: felt252,
}

/// Picks a tape for the player, builds `count` bot strikes on its seed and signs the log.
fn prepare(
    env: Env,
    t: @Tape,
    root_id: u32,
    kp: StarkCurveKeyPair,
    callsign: felt252,
    count: u32,
    mode: u32,
) -> (Submission, Array<u32>) {
    let (nonce, k) = pick_nonce(env, root_id, *t.n, kp.public_key);
    let seed = seed_of(*t.salt, k);
    let strikes = bot_strikes(env, root_id, seed, count, mode);
    let msg = message(root_id, k, nonce, callsign, strikes.span());
    assert_eq!(msg, env.game.message_hash(root_id, k, nonce, callsign, strikes.span()));
    let (r, s) = kp.sign(msg).unwrap();
    (Submission { root_id, k, nonce, seed, player_pub: kp.public_key, callsign, r, s }, strikes)
}

fn send(env: Env, t: @Tape, sub: Submission, strikes: Span<u32>) -> u64 {
    start_cheat_caller_address(env.addr, relayer());
    let id = env
        .game
        .submit_broadcast(
            sub.root_id,
            sub.k,
            sub.nonce,
            sub.seed,
            proof_of(t, sub.k).span(),
            sub.player_pub,
            sub.callsign,
            strikes,
            sub.r,
            sub.s,
        );
    stop_cheat_caller_address(env.addr);
    id
}

fn play(
    env: Env, t: @Tape, root_id: u32, secret: felt252, callsign: felt252, count: u32, mode: u32,
) -> u64 {
    let (sub, strikes) = prepare(env, t, root_id, player(secret), callsign, count, mode);
    send(env, t, sub, strikes.span())
}

/// The schedule of the player's next unused tape: (nonce, k, seed, spawns).
fn tape_for(
    env: Env, t: @Tape, root_id: u32, kp: StarkCurveKeyPair,
) -> (felt252, u32, felt252, Array<Spawn>) {
    let (nonce, k) = pick_nonce(env, root_id, *t.n, kp.public_key);
    let seed = seed_of(*t.salt, k);
    let entries = root_entries(env, root_id);
    let spawns = build_schedule(seed, entries.span(), env.game.get_root(root_id).n_featured);
    (nonce, k, seed, spawns)
}

fn sign_sub(
    root_id: u32,
    kp: StarkCurveKeyPair,
    nonce: felt252,
    k: u32,
    seed: felt252,
    callsign: felt252,
    strikes: Span<u32>,
) -> Submission {
    let (r, s) = kp.sign(message(root_id, k, nonce, callsign, strikes)).unwrap();
    Submission { root_id, k, nonce, seed, player_pub: kp.public_key, callsign, r, s }
}

/// A perfect run (aimed clicks every GAP_HIT ticks from tick 0): it clears the broadcast.
fn play_perfect(env: Env, t: @Tape, root_id: u32, secret: felt252) -> u64 {
    let kp = player(secret);
    let (nonce, k, seed, spawns) = tape_for(env, t, root_id, kp);
    let strikes = bot(spawns.span(), 0, GAP_HIT, 400, 0);
    send(env, t, sign_sub(root_id, kp, nonce, k, seed, 'ACE', strikes.span()), strikes.span())
}

/// A run that ends by jamming: five groups of three misses, killing everything in between.
fn play_jammed(env: Env, t: @Tape, root_id: u32, secret: felt252) -> u64 {
    let kp = player(secret);
    let (nonce, k, seed, spawns) = tape_for(env, t, root_id, kp);
    let strikes = jam_bot(spawns.span(), 5);
    send(env, t, sign_sub(root_id, kp, nonce, k, seed, 'JAM', strikes.span()), strikes.span())
}

fn expected(env: Env, root_id: u32, seed: felt252, strikes: Span<u32>) -> RunResult {
    let entries = root_entries(env, root_id);
    replay(seed, entries.span(), env.game.get_root(root_id).n_featured, strikes)
}

// ============================================================================= tests

#[test]
fn test_post_tape_root_snapshot() {
    let env = setup();
    let t = build_tape('a', 4);
    let mut spy = spy_events();
    let root_id = post(env, @t, T0 + 86400);
    assert_eq!(root_id, 1);
    assert_eq!(env.game.root_count(), 1);
    let info = env.game.get_root(1);
    assert_eq!(info.root, t.root);
    assert_eq!(info.n, 4);
    assert_eq!(info.posted_at, T0);
    assert_eq!(info.expires_at, T0 + 86400);
    assert_eq!(info.day, DAY0);
    assert_eq!(info.roster_version, 1);
    assert_eq!(info.roster_len, 6);
    assert_eq!(info.n_featured, 3);
    spy
        .assert_emitted(
            @array![
                (
                    env.addr,
                    StaticGame::Event::TapeRootPosted(
                        StaticGame::TapeRootPosted {
                            root_id: 1,
                            root: t.root,
                            n: 4,
                            expires_at: T0 + 86400,
                            day: DAY0,
                            roster_version: 1,
                        },
                    ),
                ),
            ],
        );

    let roster = env.game.get_root_roster(1);
    assert_eq!(roster.len(), 6);
    let (sp0, e0) = *roster.at(0);
    assert_eq!(sp0, 10011);
    // type/tier from the registry, default health 100, aggr from base_kills + notoriety
    assert_eq!(
        e0,
        RosterEntry {
            beast_type: 0, tier: 3, health: 100, aggr: 0, w: 48, h: 40, occ: 0x3c7effffffff7e3c,
        },
    );
    let (_, e1) = *roster.at(1);
    assert_eq!((e1.beast_type, e1.tier, e1.health, e1.aggr), (1, 2, 120, 1)); // 1 kill
    let (_, e2) = *roster.at(2);
    assert_eq!(e2.aggr, 3); // 7 kills
    let (sp4, e4) = *roster.at(4);
    assert_eq!((sp4, e4.aggr), (2, 2)); // 3 kills

    let v = env.game.get_roster_entry(2);
    assert_eq!((v.species_id, v.beast_type, v.tier, v.base_kills), (10013, 2, 4, 7));
}

#[test]
#[should_panic(expected: 'not relayer')]
fn test_post_requires_relayer() {
    let env = setup();
    let t = build_tape('a', 4);
    start_cheat_caller_address(env.addr, stranger());
    env.game.post_tape_root(t.root, 4, T0 + 100);
}

#[test]
#[should_panic(expected: 'bad expiry')]
fn test_post_rejects_past_expiry() {
    let env = setup();
    let t = build_tape('a', 4);
    post(env, @t, T0);
}

#[test]
fn test_submit_broadcast_full_flow() {
    let env = setup();
    let t = build_tape('flow', 4);
    let root_id = post(env, @t, T0 + 86400);
    let kp = player(0x5ec7e7);
    let (sub, strikes) = prepare(env, @t, root_id, kp, 'CHAMP', 60, 0);
    let exp = expected(env, root_id, sub.seed, strikes.span());
    // the contract's lazy storage-backed schedule matches the in-memory replay
    assert_eq!(env.game.simulate(root_id, sub.seed, strikes.span()), exp);
    assert!(exp.kills > 0);

    let mut spy = spy_events();
    let run_id = send(env, @t, sub, strikes.span());
    assert_eq!(run_id, 1);
    assert_eq!(env.game.run_count(), 1);
    assert!(env.game.is_tape_used(root_id, sub.k));

    let rec = env.game.get_run(1);
    assert_eq!(rec.player_pub, kp.public_key);
    assert_eq!(rec.callsign, 'CHAMP');
    assert_eq!((rec.root_id, rec.k, rec.seed), (root_id, sub.k, sub.seed));
    assert_eq!((rec.day, rec.submitted_at, rec.n_strikes), (DAY0, T0, strikes.len()));
    assert_eq!(rec.score, exp.score);
    assert_eq!(rec.kills, exp.kills);
    assert_eq!(rec.lives, exp.lives);
    assert_eq!(rec.best_combo, exp.best_combo);
    assert!(exp.best_combo > 1);
    assert_eq!(rec.dead, exp.dead);
    assert_eq!(rec.death_tick, exp.death_tick);
    assert_eq!(rec.killer, exp.killer);
    assert_eq!(rec.killer_roster, exp.killer_roster);
    assert_eq!(rec.caught_mask, exp.caught_mask);
    assert!(exp.caught_mask != 0);
    assert_eq!(rec.digest, exp.digest);
    let killer_species = if exp.dead && exp.killer != NO_INDEX {
        *SPECIES.span().at(exp.killer_roster)
    } else {
        0
    };
    assert_eq!(rec.killer_species, killer_species);

    assert_eq!(env.game.best(kp.public_key), exp.score);
    let top = env.game.top(DAY0);
    assert_eq!(top.len(), 1);
    assert_eq!(*top.at(0), (kp.public_key, exp.score, 1, 'CHAMP'));

    spy
        .assert_emitted(
            @array![
                (
                    env.addr,
                    StaticGame::Event::RunVerified(
                        StaticGame::RunVerified {
                            run_id: 1,
                            player_pub: kp.public_key,
                            root_id,
                            k: sub.k,
                            score: exp.score,
                            kills: exp.kills,
                            dead: exp.dead,
                            killer_species,
                            digest: exp.digest,
                        },
                    ),
                ),
            ],
        );
    spy
        .assert_emitted(
            @array![
                (
                    env.addr,
                    StaticGame::Event::BoardUpdated(
                        StaticGame::BoardUpdated {
                            day: DAY0,
                            rank: 0,
                            player_pub: kp.public_key,
                            score: exp.score,
                            run_id: 1,
                        },
                    ),
                ),
            ],
        );
}

#[test]
fn test_merkle_every_leaf_of_four() {
    let env = setup();
    let t = build_tape('four', 4);
    let root_id = post(env, @t, T0 + 86400);
    // play until all four tapes are used, with different players
    let mut secret: felt252 = 100;
    let mut runs: u64 = 0;
    while runs < 4 {
        play(env, @t, root_id, secret, 'P', 0, 0);
        runs += 1;
        secret += 1;
    }
    let mut k: u32 = 0;
    while k < 4 {
        assert!(env.game.is_tape_used(root_id, k));
        k += 1;
    }
    assert_eq!(env.game.leaf_hash(2, 77), leaf(2, 77));
}

#[test]
#[should_panic(expected: 'tape used')]
fn test_double_submit_rejected() {
    let env = setup();
    let t = build_tape('dbl', 4);
    let root_id = post(env, @t, T0 + 86400);
    let (sub, strikes) = prepare(env, @t, root_id, player(77), 'X', 10, 0);
    send(env, @t, sub, strikes.span());
    send(env, @t, sub, strikes.span());
}

#[test]
#[should_panic(expected: 'bad proof')]
fn test_bad_proof_rejected() {
    let env = setup();
    let t = build_tape('pf', 4);
    let root_id = post(env, @t, T0 + 86400);
    let (mut sub, strikes) = prepare(env, @t, root_id, player(77), 'X', 0, 0);
    sub.seed = seed_of('pf', (sub.k + 1) % 4);
    send(env, @t, sub, strikes.span());
}

#[test]
#[should_panic(expected: 'bad signature')]
fn test_tampered_strikes_rejected() {
    let env = setup();
    let t = build_tape('sig', 4);
    let root_id = post(env, @t, T0 + 86400);
    let (sub, strikes) = prepare(env, @t, root_id, player(77), 'X', 20, 0);
    // drop the last strike after signing
    send(env, @t, sub, strikes.span().slice(0, 19));
}

#[test]
#[should_panic(expected: 'bad signature')]
fn test_wrong_signer_rejected() {
    let env = setup();
    let t = build_tape('sig2', 4);
    let root_id = post(env, @t, T0 + 86400);
    let (mut sub, strikes) = prepare(env, @t, root_id, player(77), 'X', 5, 0);
    // claim the run for someone else whose tape index happens to match
    let other = player(78).public_key;
    let mut nonce: felt252 = 1;
    while tape_k(other, nonce, 4) != sub.k {
        nonce += 1;
    }
    sub.player_pub = other;
    sub.nonce = nonce;
    send(env, @t, sub, strikes.span());
}

#[test]
#[should_panic(expected: 'bad k')]
fn test_bad_k_rejected() {
    let env = setup();
    let t = build_tape('k', 4);
    let root_id = post(env, @t, T0 + 86400);
    let (mut sub, strikes) = prepare(env, @t, root_id, player(77), 'X', 0, 0);
    sub.k = (sub.k + 1) % 4;
    send(env, @t, sub, strikes.span());
}

#[test]
#[should_panic(expected: 'unknown root')]
fn test_unknown_root_rejected() {
    let env = setup();
    start_cheat_caller_address(env.addr, relayer());
    env.game.submit_broadcast(9, 0, 1, 1, array![].span(), 1, 1, array![].span(), 1, 1);
}

#[test]
#[should_panic(expected: 'not relayer')]
fn test_submit_requires_relayer() {
    let env = setup();
    env.game.submit_broadcast(1, 0, 1, 1, array![].span(), 1, 1, array![].span(), 1, 1);
}

#[test]
fn test_grace_window_accepts() {
    let env = setup();
    let t = build_tape('grace', 4);
    let root_id = post(env, @t, T0 + 100);
    let (sub, strikes) = prepare(env, @t, root_id, player(77), 'X', 5, 0);
    start_cheat_block_timestamp_global(T0 + 100 + 3600);
    assert_eq!(send(env, @t, sub, strikes.span()), 1);
}

#[test]
#[should_panic(expected: 'root expired')]
fn test_expired_root_rejected() {
    let env = setup();
    let t = build_tape('exp', 4);
    let root_id = post(env, @t, T0 + 100);
    let (sub, strikes) = prepare(env, @t, root_id, player(77), 'X', 5, 0);
    start_cheat_block_timestamp_global(T0 + 100 + 3601);
    send(env, @t, sub, strikes.span());
}

// ----------------------------------------------------------------------------- board

/// (player_pub, best score, run id of the first run reaching it)
fn check_board(env: Env, day: u32, bests: Span<(felt252, u32, u64)>) {
    // expected = bests sorted by (score desc, run_id asc), first 20
    let mut sorted: Array<(felt252, u32, u64)> = array![];
    for b in bests {
        let (_, sc, id) = *b;
        let mut next: Array<(felt252, u32, u64)> = array![];
        let mut placed = false;
        for e in sorted.span() {
            let (_, esc, eid) = *e;
            if !placed && (sc > esc || (sc == esc && id < eid)) {
                next.append(*b);
                placed = true;
            }
            next.append(*e);
        }
        if !placed {
            next.append(*b);
        }
        sorted = next;
    }
    let top = env.game.top(day);
    let n = if sorted.len() < 20 {
        sorted.len()
    } else {
        20
    };
    assert_eq!(top.len(), n);
    let mut i: u32 = 0;
    while i < n {
        let (p, sc, id) = *sorted.at(i);
        let (tp, tsc, tid, _cs) = *top.at(i);
        assert_eq!((tp, tsc, tid), (p, sc, id));
        i += 1;
    }
}

#[test]
fn test_board_ordering_dedupe_and_cap() {
    let env = setup();
    let t = build_tape('board', 32);
    let root_id = post(env, @t, T0 + 86400);
    let mut bests: Array<(felt252, u32, u64)> = array![];
    let mut j: u32 = 0;
    while j < 22 {
        let secret: felt252 = (1000 + j).into();
        let count = (j * 7) % 50;
        let id = play(env, @t, root_id, secret, j.into(), count, j % 3);
        let rec = env.game.get_run(id);
        bests.append((rec.player_pub, rec.score, id));
        j += 1;
    }
    check_board(env, DAY0, bests.span());

    // the leader replays badly: nothing changes
    let top = env.game.top(DAY0);
    let (leader, lead_score, _, _) = *top.at(0);
    let mut leader_secret: felt252 = 0;
    let mut j: u32 = 0;
    while j < 22 {
        let secret: felt252 = (1000 + j).into();
        if player(secret).public_key == leader {
            leader_secret = secret;
        }
        j += 1;
    }
    let id = play(env, @t, root_id, leader_secret, 'again', 0, 0);
    assert!(env.game.get_run(id).score < lead_score);
    check_board(env, DAY0, bests.span());
    assert_eq!(env.game.best(leader), lead_score);

    // the last-placed player improves: their entry moves up, never duplicated
    let (last, _, _, _) = *top.at(19);
    let mut last_secret: felt252 = 0;
    let mut j: u32 = 0;
    let mut last_slot: u32 = 0;
    while j < 22 {
        let secret: felt252 = (1000 + j).into();
        if player(secret).public_key == last {
            last_secret = secret;
            last_slot = j;
        }
        j += 1;
    }
    let id = play(env, @t, root_id, last_secret, 'better', 120, 0);
    let rec = env.game.get_run(id);
    let mut updated: Array<(felt252, u32, u64)> = array![];
    let mut j: u32 = 0;
    for b in bests.span() {
        let (p, sc, rid) = *b;
        if j == last_slot && rec.score > sc {
            updated.append((p, rec.score, id));
        } else {
            updated.append((p, sc, rid));
        }
        j += 1;
    }
    check_board(env, DAY0, updated.span());
}

// ----------------------------------------------------------------------------- kills

#[test]
fn test_death_bumps_notoriety_without_credit() {
    let env = setup();
    let t = build_tape('death', 4);
    let root_id = post(env, @t, T0 + 86400);
    let mut spy = spy_events();
    // an idle run always dies to escapes
    let id = play(env, @t, root_id, 9, 'idle', 0, 0);
    let rec = env.game.get_run(id);
    assert!(rec.dead);
    assert!(rec.killer_species != 0);
    assert_eq!(rec.killer_species, *SPECIES.span().at(rec.killer_roster));
    assert_eq!(env.game.notoriety(rec.killer_species), 1);
    spy
        .assert_emitted(
            @array![
                (
                    env.addr,
                    StaticGame::Event::BeastKill(
                        StaticGame::BeastKill {
                            run_id: id,
                            species_id: rec.killer_species,
                            kill_token: 0,
                            credited: false,
                        },
                    ),
                ),
            ],
        );

    // notoriety feeds the next root's snapshot; the old root keeps its frozen aggr
    let t2 = build_tape('death2', 4);
    let root2 = post(env, @t2, T0 + 86400);
    let old = env.game.get_root_roster(root_id);
    let new = env.game.get_root_roster(root2);
    let (_, eo) = *old.at(rec.killer_roster);
    let (_, en) = *new.at(rec.killer_roster);
    let base = env.game.get_roster_entry(rec.killer_roster).base_kills;
    assert_eq!(eo.aggr, static_game::sim::aggr_from_kills(base));
    assert_eq!(en.aggr, static_game::sim::aggr_from_kills(base + 1));
}

/// Affixes of kill token 5000 + idx.
fn affixes(idx: u32) -> (u8, u8) {
    ((idx + 1).try_into().unwrap(), (idx + 2).try_into().unwrap())
}

/// Maps token 5000 + idx (affixes `affixes(idx)`) to every roster index. With `genesis`, the
/// token is flagged as the species' genesis token *after* mapping (a stale mapping the runtime
/// guard must survive). `trusted` goes through the registry's SRC5 check of STATIC.
fn map_kill_tokens(env: Env, trusted: bool, genesis: bool) {
    let mut idx: u32 = 0;
    while idx < 6 {
        let species = *SPECIES.span().at(idx);
        let token: felt252 = (5000 + idx).into();
        env.nft.set_token(token, species);
        let (prefix, suffix) = affixes(idx);
        env.nft.set_affixes(token, prefix, suffix);
        env.registry.set_kill_verifier(species, env.addr, trusted);
        start_cheat_caller_address(env.addr, owner());
        env.game.set_kill_token(idx, token);
        stop_cheat_caller_address(env.addr);
        if genesis {
            env.nft.set_genesis(species, token);
        }
        idx += 1;
    }
}

#[test]
#[should_panic(expected: 'token species mismatch')]
fn test_set_kill_token_rejects_other_species() {
    let env = setup();
    env.nft.set_token(777, 10012);
    start_cheat_caller_address(env.addr, owner());
    env.game.set_kill_token(0, 777); // roster 0 is species 10011
}

#[test]
#[should_panic(expected: 'genesis token')]
fn test_set_kill_token_rejects_genesis() {
    let env = setup();
    env.nft.set_genesis(10011, 778);
    start_cheat_caller_address(env.addr, owner());
    env.game.set_kill_token(0, 778);
}

#[test]
fn test_untrusted_verifier_not_credited() {
    let env = setup();
    map_kill_tokens(env, false, false);
    let t = build_tape('untrusted', 4);
    let root_id = post(env, @t, T0 + 86400);
    let mut spy = spy_events();
    let id = play(env, @t, root_id, 9, 'idle', 0, 0);
    let rec = env.game.get_run(id);
    let token: felt252 = (5000 + rec.killer_roster).into();
    assert_eq!(env.nft.kill_count(token), 0);
    spy
        .assert_emitted(
            @array![
                (
                    env.addr,
                    StaticGame::Event::BeastKill(
                        StaticGame::BeastKill {
                            run_id: id,
                            species_id: rec.killer_species,
                            kill_token: token,
                            credited: false,
                        },
                    ),
                ),
            ],
        );
}

#[test]
fn test_trusted_verifier_credits_kill() {
    let env = setup();
    map_kill_tokens(env, true, false);
    let t = build_tape('trusted', 4);
    let root_id = post(env, @t, T0 + 86400);
    let mut spy = spy_events();
    let id = play(env, @t, root_id, 9, 'idle', 0, 0);
    let rec = env.game.get_run(id);
    let token: felt252 = (5000 + rec.killer_roster).into();
    assert_eq!(env.nft.kill_count(token), 1);
    assert!(env.nft_view.is_kill_credited(env.addr, id.into(), rec.killer_species));
    spy
        .assert_emitted(
            @array![
                (
                    env.addr,
                    StaticGame::Event::BeastKill(
                        StaticGame::BeastKill {
                            run_id: id,
                            species_id: rec.killer_species,
                            kill_token: token,
                            credited: true,
                        },
                    ),
                ),
            ],
        );
    // a second death credits again under its own run id
    let id2 = play(env, @t, root_id, 10, 'idle2', 0, 0);
    let rec2 = env.game.get_run(id2);
    let token2: felt252 = (5000 + rec2.killer_roster).into();
    assert!(env.nft_view.is_kill_credited(env.addr, id2.into(), rec2.killer_species));
    let expect = if token2 == token {
        2
    } else {
        1
    };
    assert_eq!(env.nft.kill_count(token2), expect);
}

#[test]
fn test_genesis_token_skipped_without_revert() {
    let env = setup();
    map_kill_tokens(env, true, true);
    let t = build_tape('genesis', 4);
    let root_id = post(env, @t, T0 + 86400);
    let id = play(env, @t, root_id, 9, 'idle', 0, 0);
    let rec = env.game.get_run(id);
    assert!(rec.dead);
    let token: felt252 = (5000 + rec.killer_roster).into();
    assert_eq!(env.nft.kill_count(token), 0);
    assert_eq!(env.game.notoriety(rec.killer_species), 1);
}

#[test]
fn test_credit_failure_does_not_revert_submit() {
    let env = setup();
    map_kill_tokens(env, true, false);
    env.nft.set_fail(true);
    let t = build_tape('fail', 4);
    let root_id = post(env, @t, T0 + 86400);
    let mut spy = spy_events();
    let id = play(env, @t, root_id, 9, 'idle', 0, 0);
    let rec = env.game.get_run(id);
    assert!(rec.dead && rec.killer != NO_INDEX);
    let token: felt252 = (5000 + rec.killer_roster).into();
    assert_eq!(env.nft.kill_count(token), 0);
    assert_eq!(env.game.notoriety(rec.killer_species), 1);
    spy
        .assert_emitted(
            @array![
                (
                    env.addr,
                    StaticGame::Event::BeastKill(
                        StaticGame::BeastKill {
                            run_id: id,
                            species_id: rec.killer_species,
                            kill_token: token,
                            credited: false,
                        },
                    ),
                ),
            ],
        );
    // the stored run stays creditable: once the NFT works, anyone can trigger the credit
    env.nft.set_fail(false);
    env.nft_view.add_kill(token, env.addr, id.into());
    assert_eq!(env.nft.kill_count(token), 1);
}

// ----------------------------------------------------------------------------- kill verifier

#[test]
fn test_supports_interface() {
    let env = setup();
    let src5 = ISRC5Dispatcher { contract_address: env.addr };
    assert!(src5.supports_interface(IKILL_VERIFIER_ID));
    assert!(
        src5.supports_interface(0x313dda122083d96f86bf4716425c92976808ec1efc8a3bdf240e163e73118ca)
    );
    assert!(src5.supports_interface(ISRC5_ID));
    assert!(
        src5.supports_interface(0x3f918d17e5ee77373b56385708f855659a07f75997f365cf87748628532a055)
    );
    assert!(!src5.supports_interface(0));
    assert!(!src5.supports_interface(1));
    assert!(!src5.supports_interface(IKILL_VERIFIER_ID + 1));
    // the registry (mock) accepts STATIC as a kill verifier through this check
    env.registry.set_kill_verifier(10011, env.addr, true);
}

#[test]
#[should_panic]
fn test_registry_rejects_verifier_without_src5() {
    let env = setup();
    // the mock NFT has no supports_interface: the registry's check reverts
    env.registry.set_kill_verifier(10011, env.nft.contract_address, true);
}

#[test]
fn test_verify_beast_kill_rules() {
    let env = setup();
    // untrusted at submit time: the run is stored but not credited
    map_kill_tokens(env, false, false);
    let t = build_tape('verify', 4);
    let root_id = post(env, @t, T0 + 86400);
    let id = play(env, @t, root_id, 9, 'idle', 0, 0);
    let rec = env.game.get_run(id);
    assert!(rec.dead && rec.killer != NO_INDEX);
    let v = IKillVerifierDispatcher { contract_address: env.addr };
    let run: felt252 = id.into();
    let sp = rec.killer_species;
    let (p, s) = affixes(rec.killer_roster);
    assert!(v.verify_beast_kill(run, sp, p, s));
    // affixes of another token of the species, another species, unknown runs
    assert!(!v.verify_beast_kill(run, sp, p + 1, s));
    assert!(!v.verify_beast_kill(run, sp, p, s + 1));
    let other = *SPECIES.span().at((rec.killer_roster + 1) % 6);
    let (op, os) = affixes((rec.killer_roster + 1) % 6);
    assert!(!v.verify_beast_kill(run, other, op, os));
    assert!(!v.verify_beast_kill(run, other, p, s));
    assert!(!v.verify_beast_kill(0, sp, p, s));
    assert!(!v.verify_beast_kill(run + 1, sp, p, s));
    assert!(!v.verify_beast_kill(run + 0x10000000000000000, sp, p, s));
    // clearing the species' kill token disables verification
    start_cheat_caller_address(env.addr, owner());
    env.game.set_kill_token(rec.killer_roster, 0);
    stop_cheat_caller_address(env.addr);
    assert!(!v.verify_beast_kill(run, sp, p, s));
}

#[test]
fn test_no_beast_kill_for_survivors_and_jam_deaths() {
    let env = setup();
    map_kill_tokens(env, true, false);
    let t = build_tape('nokill', 8);
    let root_id = post(env, @t, T0 + 86400);
    let v = IKillVerifierDispatcher { contract_address: env.addr };
    let mut spy = spy_events();

    // a perfect run survives: no killer, no notoriety, verify refuses every species
    let id = play_perfect(env, @t, root_id, 41);
    let rec = env.game.get_run(id);
    assert!(!rec.dead);
    assert_eq!((rec.lives, rec.kills, rec.death_tick), (5, 40, 0));
    assert_eq!((rec.killer, rec.killer_roster, rec.killer_species), (NO_INDEX, NO_INDEX, 0));

    // a jam death: dead, but no Beast killed the player
    let jid = play_jammed(env, @t, root_id, 42);
    let jrec = env.game.get_run(jid);
    assert!(jrec.dead);
    assert_eq!(jrec.lives, 0);
    assert_eq!((jrec.killer, jrec.killer_roster, jrec.killer_species), (NO_INDEX, NO_INDEX, 0));
    spy
        .assert_emitted(
            @array![
                (
                    env.addr,
                    StaticGame::Event::RunVerified(
                        StaticGame::RunVerified {
                            run_id: jid,
                            player_pub: player(42).public_key,
                            root_id,
                            k: jrec.k,
                            score: jrec.score,
                            kills: jrec.kills,
                            dead: true,
                            killer_species: 0,
                            digest: jrec.digest,
                        },
                    ),
                ),
            ],
        );

    let mut idx: u32 = 0;
    while idx < 6 {
        let species = *SPECIES.span().at(idx);
        let (p, s) = affixes(idx);
        assert!(!v.verify_beast_kill(id.into(), species, p, s));
        assert!(!v.verify_beast_kill(jid.into(), species, p, s));
        assert_eq!(env.game.notoriety(species), 0);
        assert_eq!(env.nft.kill_count((5000 + idx).into()), 0);
        idx += 1;
    }
    // neither run emitted BeastKill
    let events = spy.get_events();
    let evs = events.events.span();
    let mut i: u32 = 0;
    while i < evs.len() {
        let (from, ev) = evs.at(i);
        if *from == env.addr {
            assert!(*ev.keys.span().at(0) != selector!("BeastKill"), "unexpected BeastKill");
        }
        i += 1;
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_add_kill_callback_checks_species_and_affixes() {
    let env = setup();
    map_kill_tokens(env, false, false);
    let t = build_tape('third', 4);
    let root_id = post(env, @t, T0 + 86400);
    let id = play(env, @t, root_id, 9, 'idle', 0, 0);
    let rec = env.game.get_run(id);
    let idx = rec.killer_roster;
    let species = rec.killer_species;
    let token: felt252 = (5000 + idx).into();
    assert_eq!(env.nft.kill_count(token), 0);
    // the species owners now trust STATIC (each goes through the registry's SRC5 check)
    env.registry.set_kill_verifier(species, env.addr, true);
    let other_idx = (idx + 1) % 6;
    env.registry.set_kill_verifier(*SPECIES.span().at(other_idx), env.addr, true);

    // add_kill has no caller check: here the test contract calls it, as anyone could
    let nft = IBeastsSafeDispatcher { contract_address: env.nft_view.contract_address };
    // another token of the killer species, with other affixes: refused by verify_beast_kill
    env.nft.set_token(7777, species);
    env.nft.set_affixes(7777, 60, 15);
    match nft.add_kill(7777, env.addr, id.into()) {
        Result::Ok(_) => panic!("credited a token with other affixes"),
        Result::Err(data) => assert_eq!(*data.at(0), 'Kill not verified'),
    }
    // the kill token of another species: refused (the run's killer species differs)
    match nft.add_kill((5000 + other_idx).into(), env.addr, id.into()) {
        Result::Ok(_) => panic!("credited another species"),
        Result::Err(data) => assert_eq!(*data.at(0), 'Kill not verified'),
    }
    // the mapped token of the killer species goes through, once
    nft.add_kill(token, env.addr, id.into()).unwrap();
    assert_eq!(env.nft.kill_count(token), 1);
    assert!(env.nft_view.is_kill_credited(env.addr, id.into(), species));
    match nft.add_kill(token, env.addr, id.into()) {
        Result::Ok(_) => panic!("credited twice"),
        Result::Err(data) => assert_eq!(*data.at(0), 'Kill already credited'),
    }
}

// ----------------------------------------------------------------------------- roster admin

#[test]
fn test_roster_version_keeps_old_roots_stable() {
    let env = setup();
    let t = build_tape('ver', 4);
    let root1 = post(env, @t, T0 + 86400);
    let seed = seed_of('ver', 0);
    let strikes = bot_strikes(env, root1, seed, 80, 3);
    let before = env.game.simulate(root1, seed, strikes.span());

    start_cheat_caller_address(env.addr, owner());
    let v = env
        .game
        .set_roster(
            array![
                RosterInput {
                    species_id: 1, health: 300, w: 10, h: 10, occ: 1, kill_token: 0, base_kills: 0,
                },
            ],
            1,
        );
    stop_cheat_caller_address(env.addr);
    assert_eq!(v, 2);
    assert_eq!(env.game.roster_len(), 1);
    assert_eq!(env.game.simulate(root1, seed, strikes.span()), before);

    let t2 = build_tape('ver2', 4);
    let root2 = post(env, @t2, T0 + 86400);
    let info2 = env.game.get_root(root2);
    assert_eq!((info2.roster_version, info2.roster_len, info2.n_featured), (2, 1, 1));
}

#[test]
fn test_extend_roster_appends_commons() {
    let env = setup();
    env.nft.set_token(9, 3);
    start_cheat_caller_address(env.addr, owner());
    env
        .game
        .extend_roster(
            array![
                RosterInput {
                    species_id: 3, health: 0, w: 20, h: 20, occ: 0xff, kill_token: 9, base_kills: 0,
                },
            ],
        );
    stop_cheat_caller_address(env.addr);
    assert_eq!(env.game.roster_len(), 7);
    assert_eq!(env.game.n_featured(), 3);
    let v = env.game.get_roster_entry(6);
    assert_eq!((v.species_id, v.health, v.kill_token, v.w, v.h), (3, 100, 9, 20, 20));
}

#[test]
#[should_panic(expected: 'not owner')]
fn test_set_roster_owner_only() {
    let env = setup();
    start_cheat_caller_address(env.addr, stranger());
    env.game.set_roster(roster_inputs(), 3);
}

#[test]
#[should_panic(expected: 'not owner')]
fn test_set_relayer_owner_only() {
    let env = setup();
    start_cheat_caller_address(env.addr, relayer());
    env.game.set_relayer(stranger(), true);
}

#[test]
#[should_panic(expected: 'bad tier')]
fn test_set_roster_rejects_unregistered_species() {
    let env = setup();
    start_cheat_caller_address(env.addr, owner());
    env
        .game
        .set_roster(
            array![
                RosterInput {
                    species_id: 424242,
                    health: 0,
                    w: 10,
                    h: 10,
                    occ: 1,
                    kill_token: 0,
                    base_kills: 0,
                },
            ],
            1,
        );
}

#[test]
#[should_panic(expected: 'bad h')]
fn test_set_roster_rejects_tall_silhouette() {
    let env = setup();
    start_cheat_caller_address(env.addr, owner());
    env
        .game
        .set_roster(
            array![
                RosterInput {
                    species_id: 1, health: 0, w: 10, h: 57, occ: 1, kill_token: 0, base_kills: 0,
                },
            ],
            1,
        );
}

// ----------------------------------------------------------------------------- cost

/// Cost fixtures: a log of up to `count` clicks every GAP_HIT ticks from tick 0 (mode 1: hits,
/// and overkill clicks on killed Beasts while nothing else is hittable, the costliest case:
/// every click is simulated and every miss-free overkill scans the killed set).
fn cost_log(env: Env, t: @Tape, root_id: u32, count: u32) -> (Submission, Array<u32>) {
    let kp = player(0xc057);
    let (nonce, k, seed, spawns) = tape_for(env, t, root_id, kp);
    let strikes = bot(spawns.span(), 0, GAP_HIT, count, 1);
    (sign_sub(root_id, kp, nonce, k, seed, 'COST', strikes.span()), strikes)
}

/// Baselines for the cost measurement: identical setup and log building, no submit.
#[test]
fn test_cost_baseline_200() {
    let env = setup();
    let t = build_tape('cost', 4);
    let root_id = post(env, @t, T0 + 86400);
    let (_sub, strikes) = cost_log(env, @t, root_id, 200);
    assert_eq!(strikes.len(), 200);
}

#[test]
fn test_cost_baseline_400() {
    let env = setup();
    let t = build_tape('cost', 4);
    let root_id = post(env, @t, T0 + 86400);
    let (_sub, strikes) = cost_log(env, @t, root_id, 400);
    assert_eq!(strikes.len(), 400);
}

/// `snforge test test_cost --detailed-resources` (minus the baseline) = one submit_broadcast.
#[test]
fn test_cost_submit_broadcast_200() {
    let env = setup();
    let t = build_tape('cost', 4);
    let root_id = post(env, @t, T0 + 86400);
    let (sub, strikes) = cost_log(env, @t, root_id, 200);
    assert_eq!(strikes.len(), 200);
    send(env, @t, sub, strikes.span());
    let rec = env.game.get_run(1);
    println!(
        "200 strikes: score {} kills {} lives {} combo {}",
        rec.score,
        rec.kills,
        rec.lives,
        rec.best_combo
    );
}

/// Worst case: MAX_STRIKES (400) clicks, all simulated.
#[test]
fn test_cost_submit_broadcast_400() {
    let env = setup();
    let t = build_tape('cost', 4);
    let root_id = post(env, @t, T0 + 86400);
    let (sub, strikes) = cost_log(env, @t, root_id, 400);
    println!("400-cost log has {} strikes", strikes.len());
    assert!(strikes.len() > 300);
    send(env, @t, sub, strikes.span());
    let rec = env.game.get_run(1);
    println!(
        "{} strikes: score {} kills {} lives {} combo {}",
        rec.n_strikes,
        rec.score,
        rec.kills,
        rec.lives,
        rec.best_combo
    );
}

// ----------------------------------------------------------------------------- server views

#[test]
fn test_snapshot_views_for_server() {
    let env = setup();
    let (none_id, none_info) = env.game.latest_root();
    assert_eq!(none_id, 0);
    assert_eq!(none_info.root, 0);

    // a 97-entry roster (22 featured + 75 commons) must come back in one call
    let mut entries: Array<RosterInput> = array![];
    let mut i: u32 = 0;
    while i < 97 {
        let species = 20000 + i;
        let ty: u8 = (i % 3).try_into().unwrap();
        let tier: u8 = (1 + i % 5).try_into().unwrap();
        env.registry.set_definition(species, ty, tier);
        let w: u8 = (16 + i % 49).try_into().unwrap();
        let h: u8 = (12 + i % 45).try_into().unwrap();
        let health: u16 = (50 + i).try_into().unwrap();
        entries
            .append(
                RosterInput {
                    species_id: species,
                    health,
                    w,
                    h,
                    occ: 0xf0f0f0f0f0f0f0f0 + i.into(),
                    kill_token: 0,
                    base_kills: i % 9,
                },
            );
        i += 1;
    }
    start_cheat_caller_address(env.addr, owner());
    env.game.set_roster(entries, 22);
    stop_cheat_caller_address(env.addr);

    let t = build_tape('snap', 4);
    let root_id = post(env, @t, T0 + 86400);
    let (latest, info) = env.game.latest_root();
    assert_eq!(latest, root_id);
    assert_eq!(info, env.game.get_root(root_id));
    assert_eq!(env.game.root_n_featured(root_id), 22);

    let snap = env.game.get_snapshot(root_id);
    assert_eq!(snap.len(), 97);
    let pairs = env.game.get_root_roster(root_id);
    let mut i: u32 = 0;
    while i < 97 {
        let e = *snap.at(i);
        let (_, p) = *pairs.at(i);
        assert_eq!(e, p);
        assert_eq!(e.beast_type.into(), i % 3);
        assert_eq!(e.tier.into(), 1 + i % 5);
        assert_eq!(e.health.into(), 50 + i);
        assert_eq!(e.aggr, static_game::sim::aggr_from_kills(i % 9));
        assert_eq!(e.w.into(), 16 + i % 49);
        assert_eq!(e.h.into(), 12 + i % 45);
        assert_eq!(e.occ, 0xf0f0f0f0f0f0f0f0 + i.into());
        i += 1;
    }

    // the snapshot + n_featured reproduce the contract's own replay
    let seed = seed_of('snap', 1);
    let strikes = bot(build_schedule(seed, snap.span(), 22).span(), 72, 20, 100, 3);
    assert_eq!(
        replay(seed, snap.span(), 22, strikes.span()),
        env.game.simulate(root_id, seed, strikes.span()),
    );

    // is_used follows submissions
    let (sub, s2) = prepare(env, @t, root_id, player(31337), 'SNAP', 10, 0);
    assert!(!env.game.is_used(root_id, sub.k));
    send(env, @t, sub, s2.span());
    assert!(env.game.is_used(root_id, sub.k));
    assert!(env.game.is_tape_used(root_id, sub.k));
}

// ============================================================================= Bestiary (v3)

/// Popcount by a plain loop (independent of the contract's SWAR version).
fn pc(v: u128) -> u32 {
    let mut n: u32 = 0;
    let mut x = v;
    while x != 0 {
        if x % 2 == 1 {
            n += 1;
        }
        x /= 2;
    }
    n
}

fn dex_event(
    env: Env,
    run_id: u64,
    player_pub: felt252,
    caught_mask: u128,
    shiny_mask: u128,
    new_species: u32,
    total_species: u32,
) -> (ContractAddress, StaticGame::Event) {
    (
        env.addr,
        StaticGame::Event::DexUpdated(
            DexUpdated { run_id, player_pub, caught_mask, shiny_mask, new_species, total_species },
        ),
    )
}

#[test]
fn test_dex_empty_for_new_player() {
    let env = setup();
    assert_eq!(env.game.get_dex(12345), (0, 0, 0));
}

#[test]
fn test_dex_accumulates_across_two_runs() {
    let env = setup();
    let t = build_tape('dex', 4);
    let root_id = post(env, @t, T0 + 86400);
    let kp = player(0xd3c5);
    let other = player(0x07e2);

    // run 1: 60 bot clicks
    let (sub1, strikes1) = prepare(env, @t, root_id, kp, 'DEX', 60, 0);
    let r1 = expected(env, root_id, sub1.seed, strikes1.span());
    assert!(r1.kills > 0 && r1.caught_mask != 0);
    let mut spy = spy_events();
    assert_eq!(send(env, @t, sub1, strikes1.span()), 1);
    let new1 = pc(r1.caught_mask);
    assert_eq!(env.game.get_dex(kp.public_key), (r1.caught_mask, r1.shiny_mask, r1.kills));
    spy
        .assert_emitted(
            @array![dex_event(env, 1, kp.public_key, r1.caught_mask, r1.shiny_mask, new1, new1),],
        );

    // DexUpdated comes right after RunVerified
    let events = spy.get_events().events;
    let mut verified_at = 99;
    let mut dex_at = 99;
    for i in 0..events.len() {
        let (_, ev) = events.at(i);
        let sel = *ev.keys.at(0);
        if sel == selector!("RunVerified") {
            verified_at = i;
        }
        if sel == selector!("DexUpdated") {
            dex_at = i;
        }
    }
    assert_eq!(dex_at, verified_at + 1);

    // run 2 (a different tape, more clicks): bitmaps OR, catches add
    let (sub2, strikes2) = prepare(env, @t, root_id, kp, 'DEX', 120, 0);
    assert!(sub2.k != sub1.k);
    let r2 = expected(env, root_id, sub2.seed, strikes2.span());
    let mut spy = spy_events();
    assert_eq!(send(env, @t, sub2, strikes2.span()), 2);
    let both = r1.caught_mask | r2.caught_mask;
    let both_shiny = r1.shiny_mask | r2.shiny_mask;
    assert_eq!(env.game.get_dex(kp.public_key), (both, both_shiny, r1.kills + r2.kills));
    // new_species counts only the bits that were not set before
    let fresh = pc(both) - pc(r1.caught_mask);
    spy
        .assert_emitted(
            @array![
                dex_event(env, 2, kp.public_key, r2.caught_mask, r2.shiny_mask, fresh, pc(both),),
            ],
        );
    // the run record keeps the run's own mask, not the accumulated one
    assert_eq!(env.game.get_run(1).caught_mask, r1.caught_mask);
    assert_eq!(env.game.get_run(2).caught_mask, r2.caught_mask);

    // another guest key has its own, empty dex
    assert_eq!(env.game.get_dex(other.public_key), (0, 0, 0));
}

#[test]
fn test_dex_bits_only_or_never_clear() {
    let env = setup();
    let t = build_tape('nodrop', 4);
    let root_id = post(env, @t, T0 + 86400);
    let kp = player(0x0123);
    // a big run, then an idle run (no strikes) and a tiny one: the dex never shrinks
    play(env, @t, root_id, 0x0123, 'BIG', 120, 0);
    let (dex1, shiny1, catches1) = env.game.get_dex(kp.public_key);
    assert!(dex1 != 0 && catches1 > 0);

    let mut spy = spy_events();
    play(env, @t, root_id, 0x0123, 'IDLE', 0, 0);
    let (dex2, shiny2, catches2) = env.game.get_dex(kp.public_key);
    assert_eq!((dex2, shiny2, catches2), (dex1, shiny1, catches1));
    // an idle run adds nothing: empty masks, zero new species, same total
    spy.assert_emitted(@array![dex_event(env, 2, kp.public_key, 0, 0, 0, pc(dex1))]);

    play(env, @t, root_id, 0x0123, 'TINY', 3, 0);
    let (dex3, shiny3, catches3) = env.game.get_dex(kp.public_key);
    assert_eq!(dex3 & dex1, dex1);
    assert_eq!(shiny3 & shiny1, shiny1);
    assert!(catches3 >= catches1);
}

#[test]
fn test_dex_jam_death_keeps_earlier_catches() {
    let env = setup();
    let t = build_tape('jam', 4);
    let root_id = post(env, @t, T0 + 86400);
    let kp = player(0x7a3);
    let (nonce, k, seed, spawns) = tape_for(env, @t, root_id, kp);
    let strikes = jam_bot(spawns.span(), 5);
    let exp = expected(env, root_id, seed, strikes.span());
    assert_eq!((exp.dead, exp.killer), (true, NO_INDEX));
    assert!(exp.kills > 0 && exp.caught_mask != 0);
    let id = send(
        env, @t, sign_sub(root_id, kp, nonce, k, seed, 'JAM', strikes.span()), strikes.span(),
    );
    assert_eq!(env.game.get_run(id).caught_mask, exp.caught_mask);
    assert_eq!(env.game.get_dex(kp.public_key), (exp.caught_mask, exp.shiny_mask, exp.kills));
}

#[test]
fn test_dex_shiny_bits_subset_of_caught() {
    // across a few perfect runs the shiny bitmap stays a subset of the caught bitmap
    let env = setup();
    let t = build_tape('shiny', 4);
    let root_id = post(env, @t, T0 + 86400);
    let kp = player(0x51);
    play_perfect(env, @t, root_id, 0x51);
    play_perfect(env, @t, root_id, 0x51);
    let (dex, shiny, catches) = env.game.get_dex(kp.public_key);
    assert_eq!(shiny & dex, shiny);
    assert!(catches > 40);
    // 6 roster entries: no bit above index 5
    assert!(dex < 0x40);
}

#[test]
fn test_species_at_view() {
    let env = setup();
    let t = build_tape('sp', 4);
    let root_id = post(env, @t, T0 + 86400);
    let species = SPECIES.span();
    for i in 0..6_u32 {
        assert_eq!(env.game.species_at(root_id, i), *species.at(i));
    }
    // matches get_root_roster
    let roster = env.game.get_root_roster(root_id);
    for i in 0..roster.len() {
        let (sp, _) = *roster.at(i);
        assert_eq!(env.game.species_at(root_id, i), sp);
    }
    // frozen per root: a new roster version does not change root 1
    start_cheat_caller_address(env.addr, owner());
    env
        .game
        .set_roster(
            array![
                RosterInput {
                    species_id: 3, health: 0, w: 20, h: 20, occ: 0xff, kill_token: 0, base_kills: 0,
                },
            ],
            0,
        );
    stop_cheat_caller_address(env.addr);
    assert_eq!(env.game.species_at(root_id, 0), 10011);
}

#[test]
#[should_panic(expected: 'bad roster idx')]
fn test_species_at_out_of_range() {
    let env = setup();
    let t = build_tape('sp', 4);
    let root_id = post(env, @t, T0 + 86400);
    env.game.species_at(root_id, 6);
}

#[test]
#[should_panic(expected: 'unknown root')]
fn test_species_at_unknown_root() {
    let env = setup();
    env.game.species_at(9, 0);
}

fn n_inputs(n: u32) -> Array<RosterInput> {
    let mut out: Array<RosterInput> = array![];
    for _ in 0..n {
        out
            .append(
                RosterInput {
                    species_id: 1, health: 0, w: 10, h: 10, occ: 1, kill_token: 0, base_kills: 0,
                },
            );
    }
    out
}

#[test]
fn test_roster_of_128_ok() {
    let env = setup();
    start_cheat_caller_address(env.addr, owner());
    env.game.set_roster(n_inputs(MAX_ROSTER), 3);
    assert_eq!(env.game.roster_len(), MAX_ROSTER);
    stop_cheat_caller_address(env.addr);
}

#[test]
#[should_panic(expected: 'roster too long')]
fn test_set_roster_129_rejected() {
    let env = setup();
    start_cheat_caller_address(env.addr, owner());
    env.game.set_roster(n_inputs(MAX_ROSTER + 1), 3);
}

#[test]
fn test_extend_roster_up_to_128() {
    let env = setup();
    start_cheat_caller_address(env.addr, owner());
    env.game.extend_roster(n_inputs(MAX_ROSTER - 6));
    assert_eq!(env.game.roster_len(), MAX_ROSTER);
}

#[test]
#[should_panic(expected: 'roster too long')]
fn test_extend_roster_past_128_rejected() {
    let env = setup();
    start_cheat_caller_address(env.addr, owner());
    env.game.extend_roster(n_inputs(MAX_ROSTER - 5));
}

#[test]
fn test_dex_full_128_roster() {
    // a 128-entry roster posts and replays; indices above 63 fit the u128 masks
    let env = setup();
    start_cheat_caller_address(env.addr, owner());
    env.game.set_roster(n_inputs(MAX_ROSTER), 0);
    stop_cheat_caller_address(env.addr);
    let t = build_tape('big', 4);
    let root_id = post(env, @t, T0 + 86400);
    assert_eq!(env.game.get_root(root_id).roster_len, MAX_ROSTER);
    assert_eq!(env.game.species_at(root_id, 127), 1);
    let kp = player(0xb16);
    let (nonce, k, seed, spawns) = tape_for(env, @t, root_id, kp);
    let strikes = bot(spawns.span(), 0, GAP_HIT, 400, 0);
    let exp = expected(env, root_id, seed, strikes.span());
    assert!(exp.kills > 0);
    send(env, @t, sign_sub(root_id, kp, nonce, k, seed, 'BIG', strikes.span()), strikes.span());
    assert_eq!(env.game.get_dex(kp.public_key), (exp.caught_mask, exp.shiny_mask, exp.kills));
}
