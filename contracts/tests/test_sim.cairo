//! Hand-written rule tests for `static_game::sim` (SPEC.md v3.0).
//!
//! Besides targeted scenarios, a deliberately naive oracle (`Oracle`: per-Beast dicts, linear
//! scans, no pointers, no bitmasks, no precomputed escape order) re-implements SPEC §7-§8
//! literally and is compared field for field with the event-driven `replay_spawns` on many seeds
//! and strike logs. The oracle also builds valid logs (it knows when the last strike missed, so
//! it can use the tight GAP_HIT after hits and overkills).

use core::dict::Felt252Dict;
use core::poseidon::poseidon_hash_span;
use static_game::constants::{
    EV_ESCAPE, EV_JAM, EV_KILL, EV_STRIKE, GAP_HIT, GAP_MISS, MAX_ROSTER, MAX_STRIKES, MISS_INDEX,
    NO_INDEX, N_SPAWNS, OVERKILL_INDEX, REACTION_TICKS, T_SHINY,
};
use static_game::rng::rnd;
use static_game::sim::{
    RosterEntry, RunResult, Spawn, aggr_from_kills, axis, bit128, build_schedule, build_spawn,
    covers, decode_strike, digest_step, encode_strike, event_word, kill_points, occ_hit, popcount,
    position_at, replay, replay_spawns,
};
use crate::helpers::{aim, bot, covered, jam_bot, miss_at, mk};

const FULL: u64 = 0xffffffffffffffff;

fn entry(beast_type: u8, tier: u8, health: u16, aggr: u8, w: u8, h: u8, occ: u64) -> RosterEntry {
    RosterEntry { beast_type, tier, health, aggr, w, h, occ }
}

fn mixed_roster() -> Span<RosterEntry> {
    array![
        entry(0, 3, 100, 0, 40, 30, 0x7e7e7e7e7e7e7e7e), entry(1, 2, 150, 1, 32, 48, FULL),
        entry(2, 5, 80, 0, 56, 24, 0x00ffff00ffff00ff),
        entry(1, 1, 100, 2, 24, 24, 0x3c7effffffff7e3c),
        entry(0, 4, 120, 3, 64, 56, 0x8142241818244281), entry(2, 2, 100, 0, 48, 40, FULL),
    ]
        .span()
}

/// Big, fully hittable Beasts of two types, all hp 1 below spawn 20 (health 100, nF = 0).
fn duo_roster() -> Span<RosterEntry> {
    array![entry(0, 3, 100, 0, 48, 40, FULL), entry(2, 4, 100, 0, 40, 36, FULL)].span()
}

fn u(v: u128) -> u32 {
    v.try_into().unwrap()
}

// ---------------------------------------------------------------------------------------------
// Naive oracle (SPEC §7-§8 read literally)
// ---------------------------------------------------------------------------------------------

const O_NONE: u8 = 0; // the player was already dead: validated only
const O_HIT: u8 = 1;
const O_OVERKILL: u8 = 2;
const O_MISS: u8 = 3;

#[derive(Destruct)]
struct Oracle {
    spawns: Span<Spawn>,
    alive: Felt252Dict<u8>,
    killed: Felt252Dict<u8>,
    /// roster idx -> 1 when a Beast of it was killed / killed shiny (masks are built in `finish`).
    caught: Felt252Dict<u8>,
    shiny_caught: Felt252Dict<u8>,
    bhp: Felt252Dict<u32>,
    lives: u32,
    score: u32,
    kills: u32,
    combo: u32,
    best_combo: u32,
    misses: u32,
    chain: u32,
    chain_type: u32,
    dead: bool,
    death_tick: u32,
    killer: u32,
    digest: felt252,
    count: u32,
    last_tick: u32,
    last_miss: bool,
    jams: u32,
    overkills: u32,
}

fn o_covers(s: @Spawn, t: u32, x: u32, y: u32) -> bool {
    let (px, py) = position_at(s, t);
    occ_hit(*s.occ, *s.w, *s.h, x, y, px, py)
}

#[generate_trait]
impl OracleImpl of OracleTrait {
    fn new(spawns: Span<Spawn>) -> Oracle {
        let mut alive: Felt252Dict<u8> = Default::default();
        let mut bhp: Felt252Dict<u32> = Default::default();
        let mut i: u32 = 0;
        for s in spawns {
            alive.insert(i.into(), 1);
            bhp.insert(i.into(), *s.hp);
            i += 1;
        }
        Oracle {
            spawns,
            alive,
            killed: Default::default(),
            caught: Default::default(),
            shiny_caught: Default::default(),
            bhp,
            lives: 5,
            score: 0,
            kills: 0,
            combo: 0,
            best_combo: 0,
            misses: 0,
            chain: 0,
            chain_type: 3,
            dead: false,
            death_tick: 0,
            killer: NO_INDEX,
            digest: 0,
            count: 0,
            last_tick: 0,
            last_miss: false,
            jams: 0,
            overkills: 0,
        }
    }

    fn log(ref self: Oracle, kind: felt252, idx: u32, tick: u32, value: u32) {
        let ev = kind + 8 * idx.into() + 512 * tick.into() + 0x1000000 * value.into();
        self.digest = poseidon_hash_span(array![self.digest, ev].span());
    }

    /// Min tick of the next strike.
    fn next_tick(self: @Oracle) -> u32 {
        if *self.count == 0 {
            0
        } else if *self.last_miss {
            *self.last_tick + 18
        } else {
            *self.last_tick + 6
        }
    }

    /// Escapes up to `t`: repeatedly the alive Beast with the smallest escape_tick <= t.
    fn escapes(ref self: Oracle, t: u32) {
        while !self.dead {
            let mut best: u32 = NO_INDEX;
            let mut i: u32 = 0;
            while i < self.spawns.len() {
                let e = *self.spawns.at(i).escape_tick;
                if self.alive.get(i.into()) == 1 && e <= t {
                    if best == NO_INDEX || e < *self.spawns.at(best).escape_tick {
                        best = i;
                    }
                }
                i += 1;
            }
            if best == NO_INDEX {
                break;
            }
            let s = self.spawns.at(best);
            self.alive.insert(best.into(), 0);
            let cost = *s.escape_cost;
            self.lives = if self.lives > cost {
                self.lives - cost
            } else {
                0
            };
            self.combo = 0;
            self.log(EV_ESCAPE, best, *s.escape_tick, self.lives);
            if self.lives == 0 {
                self.dead = true;
                self.death_tick = *s.escape_tick;
                self.killer = best;
            }
        }
    }

    fn kill(ref self: Oracle, b: u32, t: u32) {
        let s = *self.spawns.at(b);
        self.alive.insert(b.into(), 0);
        self.killed.insert(b.into(), 1);
        self.kills += 1;
        self.chain = if s.beast_type == self.chain_type {
            self.chain + 1
        } else {
            1
        };
        self.chain_type = s.beast_type;
        let base = 50 + 25 * (5 - s.tier);
        let c = if self.combo < 40 {
            self.combo
        } else {
            40
        };
        let mut pts = base * (10 + c) / 10;
        let ch = if self.chain < 5 {
            self.chain
        } else {
            5
        };
        pts = pts * (1 + ch) / 2;
        if s.faint {
            pts = pts * 5 / 4;
        }
        if s.boss {
            pts = pts * 3;
        }
        if s.shiny {
            pts = pts * 3;
        }
        pts += (s.escape_tick - t) / 2;
        self.caught.insert(s.roster_idx.into(), 1);
        if s.shiny {
            self.shiny_caught.insert(s.roster_idx.into(), 1);
        }
        self.score += pts;
        self.log(EV_KILL, b, t, pts);
    }

    /// One encoded strike: SPEC §7 validation, then §8. Returns the outcome.
    fn strike_raw(ref self: Oracle, raw: u32) -> u8 {
        let (t, x, y, flags) = decode_strike(raw);
        assert(self.count < MAX_STRIKES, 'too many strikes');
        assert(t < 4000, 'bad tick');
        assert(x < 256, 'bad x');
        assert(y < 144, 'bad y');
        assert(flags == 0, 'bad type');
        assert(t >= self.next_tick(), 'bad gap');
        self.count += 1;
        self.last_tick = t;
        if self.dead {
            self.last_miss = false;
            return O_NONE;
        }
        self.escapes(t);
        if self.dead {
            self.last_miss = false;
            return O_NONE;
        }
        let n = self.spawns.len();
        let mut hit = NO_INDEX;
        let mut b: u32 = 0;
        while b < n {
            let s = self.spawns.at(b);
            let visible = *s.spawn_tick <= t && t < *s.escape_tick;
            if visible && self.alive.get(b.into()) == 1 && t >= *s.spawn_tick
                + REACTION_TICKS && o_covers(s, t, x, y) {
                hit = b;
                break;
            }
            b += 1;
        }
        if hit != NO_INDEX {
            let left = self.bhp.get(hit.into()) - 1;
            self.bhp.insert(hit.into(), left);
            self.combo += 1;
            if self.combo > self.best_combo {
                self.best_combo = self.combo;
            }
            self.misses = 0;
            self.log(EV_STRIKE, hit, t, self.combo);
            if left == 0 {
                self.kill(hit, t);
            }
            self.last_miss = false;
            return O_HIT;
        }
        let mut over = false;
        let mut b: u32 = 0;
        while b < n {
            let s = self.spawns.at(b);
            let visible = *s.spawn_tick <= t && t < *s.escape_tick;
            if self.killed.get(b.into()) == 1 && visible && o_covers(s, t, x, y) {
                over = true;
                break;
            }
            b += 1;
        }
        if over {
            self.overkills += 1;
            self.log(EV_STRIKE, OVERKILL_INDEX, t, self.combo);
            self.last_miss = false;
            return O_OVERKILL;
        }
        self.combo = 0;
        self.misses += 1;
        self.log(EV_STRIKE, MISS_INDEX, t, self.misses);
        if self.misses == 3 {
            self.misses = 0;
            self.lives -= 1;
            self.jams += 1;
            self.log(EV_JAM, MISS_INDEX, t, self.lives);
            if self.lives == 0 {
                self.dead = true;
                self.death_tick = t;
                self.killer = NO_INDEX;
            }
        }
        self.last_miss = true;
        O_MISS
    }

    fn strike(ref self: Oracle, t: u32, x: u32, y: u32) -> u8 {
        self.strike_raw(encode_strike(t, x, y))
    }

    fn feed(ref self: Oracle, strikes: Span<u32>) {
        for s in strikes {
            self.strike_raw(*s);
        }
    }

    fn finish(ref self: Oracle) -> RunResult {
        if !self.dead {
            self.escapes(0xffffffff);
        }
        let killer = if self.dead {
            self.killer
        } else {
            NO_INDEX
        };
        let killer_roster = if killer == NO_INDEX {
            NO_INDEX
        } else {
            *self.spawns.at(killer).roster_idx
        };
        let death_tick = if self.dead {
            self.death_tick
        } else {
            0
        };
        // Masks by plain summation of 2^r over a roster index scan.
        let mut caught_mask: u128 = 0;
        let mut shiny_mask: u128 = 0;
        let mut p: u128 = 1;
        let mut r: u32 = 0;
        while r < 128 {
            if self.caught.get(r.into()) == 1 {
                caught_mask += p;
            }
            if self.shiny_caught.get(r.into()) == 1 {
                shiny_mask += p;
            }
            if r < 127 {
                p *= 2;
            }
            r += 1;
        }
        RunResult {
            score: self.score,
            kills: self.kills,
            lives: self.lives,
            dead: self.dead,
            death_tick,
            killer,
            killer_roster,
            best_combo: self.best_combo,
            caught_mask,
            shiny_mask,
            digest: self.digest,
        }
    }
}

fn naive_replay(spawns: Span<Spawn>, strikes: Span<u32>) -> RunResult {
    let mut o = OracleImpl::new(spawns);
    o.feed(strikes);
    o.finish()
}

/// A valid log built against the oracle. Each strike goes at the earliest legal tick plus a
/// random delay in [0, max_delay]; `aim_pct`% aim at a targetable Beast, `ok_pct`% at a killed
/// Beast still on screen (overkill), the rest at a random pixel.
fn gen_log(
    spawns: Span<Spawn>, salt: felt252, count: u32, aim_pct: u32, ok_pct: u32, max_delay: u32,
) -> Array<u32> {
    let mut o = OracleImpl::new(spawns);
    let mut out: Array<u32> = array![];
    let mut i: u32 = 0;
    while i < count {
        let r = rnd(salt, 100, i);
        let t = o.next_tick() + u(r % (max_delay.into() + 1));
        if t >= 4000 {
            break;
        }
        let kind = u((r / 0x10000) % 100);
        let start = u((r / 0x1000000) % 40);
        let mut x = u((r / 0x100000000) % 256);
        let mut y = u((r / 0x10000000000) % 144);
        if kind < aim_pct + ok_pct {
            let want_alive = kind < aim_pct;
            let mut k: u32 = 0;
            while k < N_SPAWNS {
                let b = (start + k) % N_SPAWNS;
                let s = spawns.at(b);
                let in_window = *s.spawn_tick <= t && t < *s.escape_tick;
                let ok = if want_alive {
                    in_window && t >= *s.spawn_tick + REACTION_TICKS && o.alive.get(b.into()) == 1
                } else {
                    in_window && o.killed.get(b.into()) == 1
                };
                if ok {
                    let (ax, ay) = aim(s, t);
                    x = ax;
                    y = ay;
                    break;
                }
                k += 1;
            }
        }
        o.strike(t, x, y);
        out.append(encode_strike(t, x, y));
        i += 1;
    }
    out
}

/// `count` guaranteed misses, GAP_MISS apart, starting at tick 0.
fn misses_from_zero(spawns: Span<Spawn>, count: u32) -> Array<u32> {
    let mut out: Array<u32> = array![];
    let mut t: u32 = 0;
    while out.len() < count {
        out.append(miss_at(spawns, t));
        t += GAP_MISS;
    }
    out
}

/// A schedule where 15 misses from tick 0 (the last at tick 252) end the run by jamming before
/// any Beast escapes: only spawn 0 can escape that early.
fn jam_death_schedule() -> Array<Spawn> {
    let mut seed: felt252 = 1;
    loop {
        let spawns = build_schedule(seed, duo_roster(), 0);
        if *spawns.at(0).escape_tick > 252 {
            break spawns;
        }
        seed += 1;
    }
}

fn concat(a: Span<u32>, b: Span<u32>) -> Array<u32> {
    let mut out: Array<u32> = array![];
    for v in a {
        out.append(*v);
    }
    for v in b {
        out.append(*v);
    }
    out
}

fn compare(seed: felt252, n_featured: u32, salt: felt252, aim_pct: u32, ok_pct: u32, delay: u32) {
    let roster = mixed_roster();
    let spawns = build_schedule(seed, roster, n_featured);
    let log = gen_log(spawns.span(), salt, 400, aim_pct, ok_pct, delay);
    let fast = replay_spawns(spawns.span(), log.span());
    assert_eq!(fast, naive_replay(spawns.span(), log.span()));
    assert_eq!(fast, replay(seed, roster, n_featured, log.span()));
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

#[test]
fn test_aggr_thresholds() {
    assert_eq!(aggr_from_kills(0), 0);
    assert_eq!(aggr_from_kills(1), 1);
    assert_eq!(aggr_from_kills(2), 1);
    assert_eq!(aggr_from_kills(3), 2);
    assert_eq!(aggr_from_kills(6), 2);
    assert_eq!(aggr_from_kills(7), 3);
    assert_eq!(aggr_from_kills(1000), 3);
}

#[test]
fn test_strike_encoding_roundtrip() {
    let s = encode_strike(3999, 255, 143);
    assert_eq!(s, 3999 * 262144 + 255 * 1024 + 143 * 4);
    assert_eq!(decode_strike(s), (3999, 255, 143, 0));
    assert_eq!(decode_strike(s + 3), (3999, 255, 143, 3));
    assert_eq!(decode_strike(encode_strike(0, 0, 0)), (0, 0, 0, 0));
    // the tick field is not masked: values above 4095 decode as such (and fail validation)
    assert_eq!(decode_strike(0xffffffff), (16383, 255, 255, 3));
}

#[test]
fn test_axis_motion() {
    assert_eq!(axis(0, 0, 9, 1, 1234), 0);
    // L = 100, forward from 10 at speed 7
    assert_eq!(axis(100, 10, 7, 1, 0), 10);
    assert_eq!(axis(100, 10, 7, 1, 10), 80);
    assert_eq!(axis(100, 10, 7, 1, 20), 50); // 150 -> reflected to 200 - 150
    assert_eq!(axis(100, 10, 7, 1, 30), 20); // 220 % 200 = 20
    // backward from 10: u0 = 190, after dt=1 at v=7 -> u = 197 -> q = 3
    assert_eq!(axis(100, 10, 7, 0, 0), 10);
    assert_eq!(axis(100, 10, 7, 0, 1), 3);
    assert_eq!(axis(100, 10, 7, 0, 2), 4); // 204 % 200 = 4, bounced off 0
    // backward from 0: (P - 0) % P = 0
    assert_eq!(axis(100, 0, 5, 0, 3), 15);
    // endpoint L stays L
    assert_eq!(axis(100, 100, 5, 1, 0), 100);
    // TS reference values (src/sim/sim.test.ts)
    assert_eq!(axis(100, 0, 10, 1, 5), 50);
    assert_eq!(axis(100, 0, 10, 1, 15), 50);
    assert_eq!(axis(100, 30, 10, 0, 2), 10);
}

#[test]
fn test_occ_hit_cells() {
    // 16x8 silhouette, only cell (cx=1, cy=0) set: local x in [2, 4), y in [0, 1)
    let occ: u64 = 0x2;
    assert!(occ_hit(occ, 16, 8, 12, 20, 10, 20));
    assert!(occ_hit(occ, 16, 8, 13, 20, 10, 20));
    assert!(!occ_hit(occ, 16, 8, 11, 20, 10, 20));
    assert!(!occ_hit(occ, 16, 8, 14, 20, 10, 20));
    assert!(!occ_hit(occ, 16, 8, 12, 21, 10, 20));
    // outside the box, even with a full grid
    assert!(!occ_hit(FULL, 16, 8, 9, 20, 10, 20));
    assert!(!occ_hit(FULL, 16, 8, 26, 20, 10, 20));
    assert!(!occ_hit(FULL, 16, 8, 10, 28, 10, 20));
    assert!(occ_hit(FULL, 16, 8, 25, 27, 10, 20));
    // last cell (63) = bottom-right
    assert!(occ_hit(0x8000000000000000, 16, 8, 25, 27, 10, 20));
    assert!(!occ_hit(0x7fffffffffffffff, 16, 8, 25, 27, 10, 20));
}

#[test]
fn test_covers_matches_occ_hit() {
    let spawns = build_schedule(31, mixed_roster(), 2);
    let mut n: u32 = 0;
    let mut i: u32 = 0;
    while i < 600 {
        let r = rnd(77, 1, i);
        let b = u(r % 40);
        let s = spawns.at(b);
        let t = *s.spawn_tick + u((r / 0x100) % 300);
        let (px, py) = position_at(s, t);
        // half the probes near the silhouette, half anywhere
        let (x, y) = if i % 2 == 0 {
            (u((r / 0x1000000) % 256), u((r / 0x10000000000) % 144))
        } else {
            let dx = u((r / 0x1000000) % 80);
            let dy = u((r / 0x10000000000) % 70);
            let x = if px + dx >= 8 {
                px + dx - 8
            } else {
                0
            };
            let y = if py + dy >= 8 {
                py + dy - 8
            } else {
                0
            };
            (if x > 255 {
                255
            } else {
                x
            }, if y > 143 {
                143
            } else {
                y
            })
        };
        let expect = occ_hit(*s.occ, *s.w, *s.h, x, y, px, py);
        assert_eq!(covers(s, t, x, y), expect);
        if expect {
            n += 1;
        }
        i += 1;
    }
    assert!(n > 50, "covers rarely true");
}

#[test]
fn test_kill_points_formula() {
    // base = 50 + 25 * (5 - tier): T1 150, T3 100, T5 50; combo x(10 + min(combo, 40)) / 10
    assert_eq!(kill_points(3, 1, 1, false, false, false, 100, 100), 110);
    assert_eq!(kill_points(1, 1, 1, false, false, false, 100, 100), 165);
    assert_eq!(kill_points(5, 1, 1, false, false, false, 100, 100), 55);
    assert_eq!(kill_points(3, 0, 1, false, false, false, 100, 100), 100);
    // combo multiplier caps at x5.0 (combo 40)
    assert_eq!(kill_points(3, 40, 1, false, false, false, 100, 100), 500);
    assert_eq!(kill_points(3, 41, 1, false, false, false, 100, 100), 500);
    assert_eq!(kill_points(3, 1000, 1, false, false, false, 100, 100), 500);
    // chain multiplier (1 + min(chain, 5)) / 2: x1, x1.5, x2, x2.5, x3, capped
    assert_eq!(kill_points(3, 1, 2, false, false, false, 100, 100), 165);
    assert_eq!(kill_points(3, 1, 3, false, false, false, 100, 100), 220);
    assert_eq!(kill_points(3, 1, 4, false, false, false, 100, 100), 275);
    assert_eq!(kill_points(3, 1, 5, false, false, false, 100, 100), 330);
    assert_eq!(kill_points(3, 1, 9, false, false, false, 100, 100), 330);
    // integer division order: 75 * 13 / 10 = 97, 97 * 3 / 2 = 145 (not 75 * 13 * 3 / 20 = 146),
    // faint 145 * 5 / 4 = 181, boss x3 = 543, early bonus (107 - 100) / 2 = 3
    assert_eq!(kill_points(4, 3, 2, false, false, false, 107, 100), 148);
    assert_eq!(kill_points(4, 3, 2, true, false, false, 107, 100), 184);
    assert_eq!(kill_points(4, 3, 2, true, true, false, 107, 100), 546);
    assert_eq!(kill_points(4, 3, 2, false, true, false, 107, 100), 438);
    // shiny x3 right after the boss multiplier: 145 * 3 = 435 + 3, boss and shiny 145 * 9 = 1305
    // + 3, faint boss shiny 181 * 9 = 1629 + 3; the early bonus is never multiplied
    assert_eq!(kill_points(4, 3, 2, false, false, true, 107, 100), 438);
    assert_eq!(kill_points(4, 3, 2, false, true, true, 107, 100), 1308);
    assert_eq!(kill_points(4, 3, 2, true, true, true, 107, 100), 1632);
    assert_eq!(kill_points(3, 1, 1, false, false, true, 100, 100), 330);
    // early-kill bonus (escape_tick - T) / 2
    assert_eq!(kill_points(5, 0, 1, false, false, false, 300, 100), 150);
    assert_eq!(kill_points(5, 0, 1, false, false, false, 301, 100), 150);
}

#[test]
fn test_event_word_layout_and_digest_step() {
    assert_eq!(event_word(EV_KILL, 25, 3000, 2500), 3 + 8 * 25 + 512 * 3000 + 0x1000000 * 2500);
    assert_eq!(event_word(EV_JAM, 63, 36, 4), 4 + 8 * 63 + 512 * 36 + 0x1000000 * 4);
    // idx < 64 and tick < 4096 never reach the value field
    let top: u256 = event_word(EV_JAM, 63, 4095, 0).into();
    assert!(top < 0x1000000);
    let a = 0x1234;
    let b = event_word(EV_STRIKE, OVERKILL_INDEX, 10, 7);
    assert_eq!(digest_step(a, b), poseidon_hash_span(array![a, b].span()));
    assert_eq!(digest_step(0, 0), poseidon_hash_span(array![0, 0].span()));
}

// ---------------------------------------------------------------------------------------------
// Schedule (SPEC §5)
// ---------------------------------------------------------------------------------------------

/// SPEC v2 §5 per-type velocity before the swift multiplier.
fn expected_velocity(beast_type: u32, aggr: u32, rv: u128) -> (u32, u32) {
    let rv8 = rv / 256;
    if beast_type == 0 {
        (4 + u(rv % 4) + 2 * aggr, 4 + u(rv8 % 4) + aggr)
    } else if beast_type == 1 {
        (8 + u(rv % 5) + 2 * aggr, 1 + u(rv8 % 2) + aggr)
    } else {
        (3 + u(rv % 3) + aggr, 2 + u(rv8 % 3) + aggr)
    }
}

/// Every field of every spawn against the SPEC formulas.
fn check_schedule(seed: felt252, roster: Span<RosterEntry>, nf: u32) {
    let spawns = build_schedule(seed, roster, nf);
    assert_eq!(spawns.len(), N_SPAWNS);
    let mut prev: u32 = 0;
    let mut i: u32 = 0;
    for s in spawns.span() {
        let s = *s;
        let e = *roster.at(s.roster_idx);
        let aggr: u32 = e.aggr.into();
        assert_eq!(s.spawn_tick, 30 + 84 * i - (3 * i * i) / 5 + u(rnd(seed, 1, i) % 20));
        assert!(i == 0 || s.spawn_tick > prev, "spawn ticks must strictly increase");
        assert_eq!(s.boss, i == N_SPAWNS - 1);
        assert_eq!(s.featured, s.roster_idx < nf);
        let ty: u32 = e.beast_type.into();
        let tier: u32 = e.tier.into();
        let w: u32 = e.w.into();
        let h: u32 = e.h.into();
        assert_eq!((s.beast_type, s.tier, s.w, s.h, s.occ), (ty, tier, w, h, e.occ));
        assert_eq!(s.lvl, 1 + i / 4 + aggr);
        if s.lvl >= 6 {
            let ra = rnd(seed, 7, i);
            assert_eq!(s.prefix, 1 + u(ra % 69));
            assert_eq!(s.suffix, 1 + u((ra / 69) % 18));
        } else {
            assert_eq!((s.prefix, s.suffix), (0, 0));
        }
        assert_eq!(s.swift, s.prefix == 28 || s.prefix == 59 || s.prefix == 60);
        assert_eq!(s.faint, s.prefix == 23 || s.prefix == 30 || s.suffix == 10);
        assert_eq!(s.peak, s.suffix == 15);
        assert_eq!(s.bane, s.suffix == 1);
        let rv = rnd(seed, 5, i);
        let (vx, vy) = expected_velocity(s.beast_type, aggr, rv);
        if s.swift {
            assert_eq!((s.vx, s.vy), (vx * 3 / 2, vy * 3 / 2));
        } else {
            assert_eq!((s.vx, s.vy), (vx, vy));
        }
        assert_eq!((s.dir_x, s.dir_y), (u((rv / 65536) % 2), u((rv / 131072) % 2)));
        assert_eq!((s.lx, s.ly), ((256 - s.w) * 16, (144 - s.h) * 16));
        assert_eq!(s.x0, u(rnd(seed, 3, i) % (s.lx + 1).into()));
        assert_eq!(s.y0, u(rnd(seed, 4, i) % (s.ly + 1).into()));
        let rl = rnd(seed, 6, i);
        let life = if s.boss {
            360 + u(rl % 60)
        } else {
            180 - 2 * i + u(rl % 40) - 10 * aggr
        };
        assert_eq!(s.escape_tick, s.spawn_tick + life);
        let mut hp = if s.boss {
            8
        } else if s.featured {
            2
        } else {
            1
        };
        if e.health >= 150 {
            hp += 1;
        }
        if s.peak {
            hp += 1;
        }
        assert_eq!(s.hp, hp);
        assert_eq!(s.escape_cost, if s.bane {
            2
        } else {
            1
        });
        prev = s.spawn_tick;
        i += 1;
    }
    if nf > 0 {
        // the King is always drawn from the featured pool
        assert!((*spawns.at(N_SPAWNS - 1)).roster_idx < nf);
    }
}

#[test]
fn test_schedule_formulas() {
    check_schedule(77, mixed_roster(), 2);
    check_schedule(78, mixed_roster(), 0);
    check_schedule(79, mixed_roster(), 6);
    check_schedule(
        0x7f6883b4f901ce25aff2b10c876db8dfff68e61ba93102354816519e7fe1f, mixed_roster(), 1,
    );
}

#[test]
fn test_roster_pools() {
    // nF == 0: everything from commons, the King included
    let spawns = build_schedule(5, mixed_roster(), 0);
    for s in spawns.span() {
        assert!(*s.roster_idx < 6 && !*s.featured);
    }
    // nC == 0: all featured
    let spawns = build_schedule(5, mixed_roster(), 6);
    for s in spawns.span() {
        assert!(*s.roster_idx < 6 && *s.featured);
    }
    // explicit draw for spawn 3 with nF = 2, nC = 4
    let r = rnd(5, 2, 3);
    let expected: u128 = if r % 100 < 45 {
        (r / 100) % 2
    } else {
        2 + (r / 100) % 4
    };
    let spawns = build_schedule(5, mixed_roster(), 2);
    let got: u128 = (*spawns.at(3)).roster_idx.into();
    assert_eq!(got, expected);
}

#[test]
fn test_hp_rules_boss_featured_common() {
    let normal = entry(1, 2, 149, 0, 30, 30, FULL);
    let sturdy = entry(1, 2, 150, 0, 30, 30, FULL);
    let mut boss_peak = false;
    let mut seed: felt252 = 1;
    while seed != 100 {
        // the King (i = 39): 8 hp, +1 for health >= 150, +1 for Peak; life 360 + rl % 60
        let k = build_spawn(seed, 39, 0, 1, normal);
        assert!(k.boss && k.featured);
        let peak: u32 = if k.peak {
            1
        } else {
            0
        };
        boss_peak = boss_peak || k.peak;
        assert_eq!(k.hp, 8 + peak);
        assert_eq!(build_spawn(seed, 39, 0, 1, sturdy).hp, 9 + peak);
        // the King is 8 hp even when drawn from commons (nF = 0)
        assert_eq!(build_spawn(seed, 39, 0, 0, normal).hp, 8 + peak);
        let life = k.escape_tick - k.spawn_tick;
        assert!(life >= 360 && life < 420);
        // spawn 5 has no affixes (lvl 2): featured 2, common 1, +1 health bonus
        assert_eq!(build_spawn(seed, 5, 0, 1, normal).hp, 2);
        assert_eq!(build_spawn(seed, 5, 1, 1, normal).hp, 1);
        assert_eq!(build_spawn(seed, 5, 0, 1, sturdy).hp, 3);
        assert_eq!(build_spawn(seed, 5, 1, 1, sturdy).hp, 2);
        seed += 1;
    }
    assert!(boss_peak, "no Peak King in the sample");
}

#[test]
fn test_velocity_by_type() {
    let mut ty: u8 = 0;
    while ty < 3 {
        let mut aggr: u8 = 0;
        while aggr < 4 {
            let e = entry(ty, 3, 100, aggr, 30, 30, FULL);
            let mut i: u32 = 0;
            while i < 8 { // lvl = 1 + i / 4 + aggr < 6: no affixes, so never swift
                let s = build_spawn(1234, i, 0, 0, e);
                assert!(!s.swift);
                let (vx, vy) = expected_velocity(ty.into(), aggr.into(), rnd(1234, 5, i));
                assert_eq!((s.vx, s.vy), (vx, vy));
                i += 1;
            }
            aggr += 1;
        }
        ty += 1;
    }
    // ranges: Magic floats diagonally, Hunter darts sideways, Brute lumbers
    let m = build_spawn(5, 0, 0, 0, entry(0, 3, 100, 0, 30, 30, FULL));
    assert!(m.vx >= 4 && m.vx <= 7 && m.vy >= 4 && m.vy <= 7);
    let h = build_spawn(5, 0, 0, 0, entry(1, 3, 100, 0, 30, 30, FULL));
    assert!(h.vx >= 8 && h.vx <= 12 && h.vy >= 1 && h.vy <= 2);
    let b = build_spawn(5, 0, 0, 0, entry(2, 3, 100, 0, 30, 30, FULL));
    assert!(b.vx >= 3 && b.vx <= 5 && b.vy >= 2 && b.vy <= 4);
}

#[test]
fn test_affix_effects() {
    let e = entry(2, 1, 100, 0, 20, 20, FULL);
    let mut swift: u32 = 0;
    let mut faint: u32 = 0;
    let mut peak: u32 = 0;
    let mut bane: u32 = 0;
    let mut seed: felt252 = 1;
    while seed != 30 {
        // lvl = 1 + i / 4 >= 6 from spawn 20 (aggr 0); with aggr 3 from spawn 8
        assert_eq!(build_spawn(seed, 19, 1, 0, e).prefix, 0);
        assert!(build_spawn(seed, 20, 1, 0, e).prefix != 0);
        assert!(build_spawn(seed, 8, 1, 0, entry(2, 1, 100, 3, 20, 20, FULL)).prefix != 0);
        let mut i: u32 = 20;
        while i < 39 {
            let s = build_spawn(seed, i, 1, 0, e);
            let ra = rnd(seed, 7, i);
            assert_eq!(s.prefix, 1 + u(ra % 69));
            assert_eq!(s.suffix, 1 + u((ra / 69) % 18));
            let (vx, vy) = expected_velocity(2, 0, rnd(seed, 5, i));
            if s.swift {
                swift += 1;
                assert_eq!((s.vx, s.vy), (vx * 3 / 2, vy * 3 / 2));
            } else {
                assert_eq!((s.vx, s.vy), (vx, vy));
            }
            if s.faint {
                faint += 1;
            }
            if s.peak {
                peak += 1;
                assert_eq!(s.hp, 2);
            } else {
                assert_eq!(s.hp, 1);
            }
            if s.bane {
                bane += 1;
                assert_eq!(s.escape_cost, 2);
            } else {
                assert_eq!(s.escape_cost, 1);
            }
            i += 1;
        }
        seed += 1;
    }
    assert!(swift > 0 && faint > 0 && peak > 0 && bane > 0, "affix not exercised");
}

// ---------------------------------------------------------------------------------------------
// Replay rules (SPEC §8)
// ---------------------------------------------------------------------------------------------

#[test]
fn test_idle_runs_escape_order_and_killer() {
    let mut seed: felt252 = 100;
    while seed != 108 {
        let spawns = build_schedule(seed, mixed_roster(), 2);
        let res = replay_spawns(spawns.span(), array![].span());
        assert_eq!(res, naive_replay(spawns.span(), array![].span()));
        assert!(res.dead);
        assert_eq!((res.score, res.kills, res.lives, res.best_combo), (0, 0, 0, 0));
        assert!(res.killer < N_SPAWNS);
        assert_eq!(res.death_tick, (*spawns.at(res.killer)).escape_tick);
        assert_eq!(res.killer_roster, (*spawns.at(res.killer)).roster_idx);
        seed += 1;
    }
}

#[test]
fn test_three_misses_jam() {
    let spawns = build_schedule(5, duo_roster(), 0);
    // nothing is targetable before tick 38 (first spawn >= 30, reaction 8): three misses
    let three = array![encode_strike(0, 0, 0), encode_strike(18, 9, 9), encode_strike(36, 0, 143)];
    let mut o = OracleImpl::new(spawns.span());
    o.feed(three.span());
    let mut d: felt252 = 0;
    d = digest_step(d, event_word(EV_STRIKE, MISS_INDEX, 0, 1));
    d = digest_step(d, event_word(EV_STRIKE, MISS_INDEX, 18, 2));
    d = digest_step(d, event_word(EV_STRIKE, MISS_INDEX, 36, 3));
    d = digest_step(d, event_word(EV_JAM, MISS_INDEX, 36, 4));
    assert_eq!(o.digest, d);
    assert_eq!((o.lives, o.misses, o.combo, o.jams), (4, 0, 0, 1));
    let r3 = replay_spawns(spawns.span(), three.span());
    assert_eq!(r3, o.finish());

    // two misses cost nothing: same ending as the idle run (all escape costs are 1 early on)
    let idle = replay_spawns(spawns.span(), array![].span());
    let r2 = replay_spawns(spawns.span(), three.span().slice(0, 2));
    assert_eq!(
        (r2.dead, r2.death_tick, r2.killer, r2.lives), (idle.dead, idle.death_tick, idle.killer, 0),
    );
    assert!(r2.digest != idle.digest);
    // the jam cost a life: the run ends one escape earlier, to a different Beast
    assert!(r3.dead && r3.killer != idle.killer && r3.death_tick <= idle.death_tick);
}

#[test]
fn test_hit_resets_misses_overkill_does_not() {
    let spawns = build_schedule(5, duo_roster(), 0);
    let s0 = spawns.at(0);
    let th = *s0.spawn_tick + REACTION_TICKS;
    assert_eq!(*s0.hp, 1);
    // miss, miss, kill, miss, miss: no jam
    let log = array![
        miss_at(spawns.span(), th - 36), miss_at(spawns.span(), th - 18), mk(s0, th),
        miss_at(spawns.span(), th + 6), miss_at(spawns.span(), th + 24),
    ];
    let mut o = OracleImpl::new(spawns.span());
    o.feed(log.span());
    assert_eq!((o.jams, o.misses, o.lives, o.kills), (0, 2, 5, 1));
    assert_eq!(replay_spawns(spawns.span(), log.span()), o.finish());

    // kill, miss, overkill, miss, miss: the overkill keeps the miss count, so the 5th jams
    let log = array![
        mk(s0, th), miss_at(spawns.span(), th + 6), mk(s0, th + 24),
        miss_at(spawns.span(), th + 30), miss_at(spawns.span(), th + 48),
    ];
    let mut o = OracleImpl::new(spawns.span());
    o.feed(log.span());
    assert_eq!((o.overkills, o.jams, o.misses, o.lives), (1, 1, 0, 4));
    assert_eq!(replay_spawns(spawns.span(), log.span()), o.finish());
}

#[test]
fn test_overkill_is_neutral() {
    let spawns = build_schedule(5, duo_roster(), 0);
    let s0 = spawns.at(0);
    let s1 = spawns.at(1);
    let t0 = *s0.spawn_tick + REACTION_TICKS;
    let t1 = *s1.spawn_tick + REACTION_TICKS;
    assert!(*s0.hp == 1 && *s1.hp == 1 && t0 + 12 < *s1.spawn_tick);

    // kill 0, overkill 0 (no combo or miss change), miss: exact digest
    let log = array![mk(s0, t0), mk(s0, t0 + 6), miss_at(spawns.span(), t0 + 12)];
    let mut o = OracleImpl::new(spawns.span());
    assert_eq!(o.strike_raw(*log.at(0)), O_HIT);
    assert_eq!(o.strike_raw(*log.at(1)), O_OVERKILL);
    assert_eq!((o.combo, o.misses), (1, 0));
    assert_eq!(o.strike_raw(*log.at(2)), O_MISS);
    let pts = kill_points(*s0.tier, 1, 1, *s0.faint, false, *s0.shiny, *s0.escape_tick, t0);
    let mut d: felt252 = 0;
    d = digest_step(d, event_word(EV_STRIKE, 0, t0, 1));
    d = digest_step(d, event_word(EV_KILL, 0, t0, pts));
    d = digest_step(d, event_word(EV_STRIKE, OVERKILL_INDEX, t0 + 6, 1));
    d = digest_step(d, event_word(EV_STRIKE, MISS_INDEX, t0 + 12, 1));
    assert_eq!(o.digest, d);
    assert_eq!(replay_spawns(spawns.span(), log.span()), o.finish());

    // the combo survives an overkill but not a miss
    let with_overkill = array![mk(s0, t0), mk(s0, t0 + 6), mk(s1, t1)];
    let with_miss = array![mk(s0, t0), miss_at(spawns.span(), t0 + 6), mk(s1, t1)];
    let a = replay_spawns(spawns.span(), with_overkill.span());
    let b = replay_spawns(spawns.span(), with_miss.span());
    assert_eq!((a.kills, a.best_combo), (2, 2));
    assert_eq!((b.kills, b.best_combo), (2, 1));
    assert!(a.score > b.score);
    assert_eq!(a, naive_replay(spawns.span(), with_overkill.span()));
    assert_eq!(b, naive_replay(spawns.span(), with_miss.span()));

    // once its window closed, a killed Beast is no overkill target: a click there misses
    let e0 = *s0.escape_tick;
    let mut t = e0;
    loop {
        let (x, y) = aim(s0, t);
        if !covered(spawns.span(), t, x, y) {
            break;
        }
        t += 1;
    }
    let mut o = OracleImpl::new(spawns.span());
    o.strike_raw(mk(s0, t0));
    assert_eq!(o.strike_raw(mk(s0, t)), O_MISS);
    let late = array![mk(s0, t0), mk(s0, t)];
    assert_eq!(replay_spawns(spawns.span(), late.span()), o.finish());
}

#[test]
fn test_combo_and_chain_scoring() {
    // A perfect bot (every 6 ticks, aimed) kills all 40 Beasts: no miss, no escape, so combo
    // counts every hit and chain follows the type sequence. Recompute SPEC §8 click by click.
    let roster = array![
        entry(0, 2, 100, 0, 64, 56, FULL), entry(0, 4, 160, 1, 60, 50, FULL),
        entry(2, 3, 100, 0, 56, 48, FULL),
    ]
        .span();
    let spawns = build_schedule(42, roster, 1);
    let strikes = bot(spawns.span(), 0, GAP_HIT, 400, 0);
    let res = replay_spawns(spawns.span(), strikes.span());
    assert_eq!((res.kills, res.lives, res.dead), (40, 5, false));
    assert_eq!((res.killer, res.killer_roster, res.death_tick), (NO_INDEX, NO_INDEX, 0));

    let mut taken: Felt252Dict<u32> = Default::default();
    let mut combo: u32 = 0;
    let mut chain: u32 = 0;
    let mut chain_type: u32 = 3;
    let mut score: u32 = 0;
    let mut max_chain: u32 = 0;
    let mut switches: u32 = 0;
    let mut total_hp: u32 = 0;
    for s in spawns.span() {
        total_hp += *s.hp;
    }
    for raw in strikes.span() {
        let (t, x, y, _) = decode_strike(*raw);
        // the lowest-index targetable, alive Beast under the click
        let mut b: u32 = 0;
        loop {
            let s = spawns.at(b);
            if *s.spawn_tick
                + REACTION_TICKS <= t
                    && t < *s.escape_tick
                    && taken.get(b.into()) < *s.hp
                    && covers(s, t, x, y) {
                break;
            }
            b += 1;
        }
        let s = *spawns.at(b);
        let hits = taken.get(b.into()) + 1;
        taken.insert(b.into(), hits);
        combo += 1;
        if hits == s.hp {
            if s.beast_type == chain_type {
                chain += 1;
            } else {
                chain = 1;
                if chain_type != 3 {
                    switches += 1;
                }
            }
            chain_type = s.beast_type;
            if chain > max_chain {
                max_chain = chain;
            }
            let base = 50 + 25 * (5 - s.tier);
            let c = if combo < 40 {
                combo
            } else {
                40
            };
            let ch = if chain < 5 {
                chain
            } else {
                5
            };
            let mut pts = base * (10 + c) / 10 * (1 + ch) / 2;
            if s.faint {
                pts = pts * 5 / 4;
            }
            if s.boss {
                pts *= 3;
            }
            if s.shiny {
                pts *= 3;
            }
            score += pts + (s.escape_tick - t) / 2;
        }
    }
    assert_eq!(res.score, score);
    assert_eq!(res.best_combo, total_hp);
    assert!(total_hp > 40 && combo == total_hp, "multi-hit Beasts expected");
    assert!(max_chain >= 5 && switches > 0, "chain cap and type switch not exercised");
    assert_eq!(res, naive_replay(spawns.span(), strikes.span()));
}

#[test]
fn test_escape_and_miss_reset_combo_not_chain() {
    // Find a schedule whose first three spawns have types A, B, A (duo roster, all hp 1).
    let mut seed: felt252 = 1;
    let spawns = loop {
        let sp = build_schedule(seed, duo_roster(), 0);
        let (a, b, c) = (*sp.at(0).beast_type, *sp.at(1).beast_type, *sp.at(2).beast_type);
        let s2 = sp.at(2);
        // spawn 2 must still be on screen after spawn 1 escapes
        let late = if *sp.at(1).escape_tick > *s2.spawn_tick + REACTION_TICKS {
            *sp.at(1).escape_tick
        } else {
            *s2.spawn_tick + REACTION_TICKS
        };
        if a == c && a != b && late + 1 < *s2.escape_tick {
            break sp;
        }
        seed += 1;
    };
    let s0 = spawns.at(0);
    let s1 = spawns.at(1);
    let s2 = spawns.at(2);
    let t0 = *s0.spawn_tick + REACTION_TICKS;
    // after spawn 1's escape (combo 0) kill spawn 2: combo 1, chain 2 (same type as spawn 0)
    let mut t2 = *s1.escape_tick;
    if t2 < *s2.spawn_tick + REACTION_TICKS {
        t2 = *s2.spawn_tick + REACTION_TICKS;
    }
    let log = array![mk(s0, t0), mk(s2, t2)];
    let res = replay_spawns(spawns.span(), log.span());
    let p0 = kill_points(*s0.tier, 1, 1, *s0.faint, false, *s0.shiny, *s0.escape_tick, t0);
    let p2 = kill_points(*s2.tier, 1, 2, *s2.faint, false, *s2.shiny, *s2.escape_tick, t2);
    assert_eq!((res.kills, res.best_combo), (2, 1));
    assert_eq!(res.score, p0 + p2);
    assert!(p2 != kill_points(*s2.tier, 1, 1, *s2.faint, false, *s2.shiny, *s2.escape_tick, t2));
    let mut o = OracleImpl::new(spawns.span());
    o.feed(log.span());
    assert_eq!((o.chain, o.combo, o.lives), (2, 1, 4));
    assert_eq!(res, o.finish());

    // kill A, miss, (B escapes), kill A: the miss also resets only the combo
    let log = array![mk(s0, t0), miss_at(spawns.span(), t0 + 6), mk(s2, t2)];
    let res = replay_spawns(spawns.span(), log.span());
    assert_eq!(res.score, p0 + p2);
    assert_eq!(res, naive_replay(spawns.span(), log.span()));

    // kill A, kill B: a new type restarts the chain at 1 (combo 2)
    let t1 = *s1.spawn_tick + REACTION_TICKS;
    let log = array![mk(s0, t0), mk(s1, t1)];
    let res = replay_spawns(spawns.span(), log.span());
    let p1 = kill_points(*s1.tier, 2, 1, *s1.faint, false, *s1.shiny, *s1.escape_tick, t1);
    assert_eq!(res.score, p0 + p1);
    assert_eq!(res.best_combo, 2);
}

#[test]
fn test_bane_escape_cost_and_lives_floor() {
    // every Beast Bane (escape cost 2): idle lives go 5 -> 3 -> 1 -> 0 (floored), the third
    // escape ends the run
    let real = build_schedule(9, duo_roster(), 0);
    let mut spawns: Array<Spawn> = array![];
    for s in real.span() {
        let mut s = *s;
        s.bane = true;
        s.escape_cost = 2;
        spawns.append(s);
    }
    let res = replay_spawns(spawns.span(), array![].span());
    assert_eq!(res, naive_replay(spawns.span(), array![].span()));
    // the first three escapes in (escape_tick, index) order
    let mut order: Array<u32> = array![];
    let mut used: Felt252Dict<u8> = Default::default();
    while order.len() < 3 {
        let mut best: u32 = NO_INDEX;
        let mut i: u32 = 0;
        while i < N_SPAWNS {
            if used.get(i.into()) == 0
                && (best == NO_INDEX || *spawns.at(i).escape_tick < *spawns.at(best).escape_tick) {
                best = i;
            }
            i += 1;
        }
        used.insert(best.into(), 1);
        order.append(best);
    }
    let mut d: felt252 = 0;
    let mut lives: u32 = 3;
    for b in order.span() {
        d = digest_step(d, event_word(EV_ESCAPE, *b, *spawns.at(*b).escape_tick, lives));
        lives = if lives > 2 {
            lives - 2
        } else {
            0
        };
    }
    let third = *order.at(2);
    assert_eq!(res.digest, d);
    assert_eq!((res.dead, res.lives, res.killer), (true, 0, third));
    assert_eq!(res.death_tick, *spawns.at(third).escape_tick);

    // the real schedule (all cost 1) survives two more escapes
    let idle = replay_spawns(real.span(), array![].span());
    assert!(idle.death_tick >= res.death_tick && idle.killer != third);
}

#[test]
fn test_jam_death_has_no_killer() {
    let spawns = jam_death_schedule();
    let log = misses_from_zero(spawns.span(), 15);
    let res = replay_spawns(spawns.span(), log.span());
    assert_eq!(res.dead, true);
    assert_eq!(res.lives, 0);
    assert_eq!(res.death_tick, 14 * GAP_MISS);
    assert_eq!((res.killer, res.killer_roster), (NO_INDEX, NO_INDEX));
    assert_eq!((res.kills, res.score, res.best_combo), (0, 0, 0));
    assert_eq!(res, naive_replay(spawns.span(), log.span()));
    // 14 misses leave one life: the run then ends on an escape, with a killer
    let res14 = replay_spawns(spawns.span(), log.span().slice(0, 14));
    assert!(res14.dead && res14.killer != NO_INDEX && res14.death_tick > 14 * GAP_MISS);
}

#[test]
fn test_survivor_run() {
    // a perfect bot clears the broadcast: not dead, all lives, no killer, death_tick 0
    let roster = array![entry(0, 1, 100, 0, 64, 56, FULL), entry(1, 5, 100, 0, 56, 48, FULL)]
        .span();
    let spawns = build_schedule(4, roster, 1);
    let strikes = bot(spawns.span(), 0, GAP_HIT, 400, 0);
    let res = replay(4, roster, 1, strikes.span());
    assert_eq!(res, naive_replay(spawns.span(), strikes.span()));
    assert!(!res.dead);
    assert_eq!(res.lives, 5);
    assert_eq!(res.kills, N_SPAWNS);
    assert_eq!((res.killer, res.killer_roster, res.death_tick), (NO_INDEX, NO_INDEX, 0));
    assert_eq!(res.best_combo, strikes.len());
}

#[test]
fn test_strikes_after_death_are_ignored() {
    let spawns = build_schedule(8, mixed_roster(), 2);
    let idle = replay_spawns(spawns.span(), array![].span());
    let d = idle.death_tick;
    assert!(idle.dead && d + 30 < 4000);
    // a strike on the death tick finds the player dead (escapes run first): not a miss, so the
    // next one may follow GAP_HIT later; nothing changes the result
    let late = array![
        encode_strike(d, 0, 0), encode_strike(d + 6, 0, 0), encode_strike(d + 12, 1, 1)
    ];
    assert_eq!(replay_spawns(spawns.span(), late.span()), idle);
    assert_eq!(replay_spawns(spawns.span(), array![encode_strike(3999, 10, 10)].span()), idle);
}

#[test]
fn test_strikes_after_jam_death_validated() {
    let spawns = jam_death_schedule();
    let log = misses_from_zero(spawns.span(), 15);
    let dead = replay_spawns(spawns.span(), log.span());
    // the jam-death strike was a miss: GAP_MISS, then dead strikes need only GAP_HIT
    let tail = array![encode_strike(252 + 18, 0, 0), encode_strike(252 + 24, 0, 0)];
    assert_eq!(replay_spawns(spawns.span(), concat(log.span(), tail.span()).span()), dead);
}

#[test]
fn test_digest_changes() {
    // (a log is only valid for the schedule it was made on: gaps depend on outcomes, so compare
    // logs of one schedule, and prefixes, which are always valid)
    let roster = mixed_roster();
    let spawns = build_schedule(42, roster, 2);
    let a = gen_log(spawns.span(), 1, 50, 70, 10, 5);
    let b = gen_log(spawns.span(), 2, 50, 70, 10, 5);
    let r1 = replay(42, roster, 2, a.span());
    assert_eq!(r1.digest, replay(42, roster, 2, a.span()).digest);
    assert!(r1.digest != 0);
    assert!(r1.digest != replay(42, roster, 2, b.span()).digest);
    assert!(r1.digest != replay(42, roster, 2, a.span().slice(0, 1)).digest);
    assert!(r1.digest != replay(42, roster, 2, array![].span()).digest);
    // a hit vs a miss at the same tick
    let duo = build_schedule(11, duo_roster(), 0);
    let s0 = duo.at(0);
    let t0 = *s0.spawn_tick + REACTION_TICKS;
    let hit = replay_spawns(duo.span(), array![mk(s0, t0)].span());
    let miss = replay_spawns(duo.span(), array![miss_at(duo.span(), t0)].span());
    assert!(hit.digest != miss.digest);
}

// ---------------------------------------------------------------------------------------------
// Event-driven replay vs the naive oracle
// ---------------------------------------------------------------------------------------------

// Mostly aimed, tight gaps: long runs, kills, combos, chains, some overkills.
#[test]
fn test_matches_oracle_clean_1() {
    compare(1, 2, 11, 92, 4, 3);
}

#[test]
fn test_matches_oracle_clean_2() {
    compare(2, 0, 12, 96, 0, 1);
}

#[test]
fn test_matches_oracle_clean_3() {
    compare(3, 6, 13, 90, 5, 8);
}

// Half aimed, many overkills.
#[test]
fn test_matches_oracle_mixed_1() {
    compare(4, 1, 21, 60, 25, 10);
}

#[test]
fn test_matches_oracle_mixed_2() {
    compare(5, 3, 22, 55, 30, 4);
}

#[test]
fn test_matches_oracle_mixed_3() {
    compare(6, 2, 23, 70, 20, 20);
}

// Many misses: jams, jam deaths, and validated strikes after death.
#[test]
fn test_matches_oracle_sloppy_1() {
    compare(7, 2, 31, 35, 15, 25);
}

#[test]
fn test_matches_oracle_sloppy_2() {
    compare(8, 4, 32, 20, 30, 6);
}

#[test]
fn test_matches_oracle_sloppy_3() {
    compare(9, 1, 33, 0, 0, 2);
}

/// Bot logs (modes: 0 clean, 1 busy with overkills, 2 sloppy with misses, 3 mixed).
fn bot_vs_oracle(seed: felt252, mode: u32) {
    let spawns = build_schedule(seed, mixed_roster(), 3);
    let strikes = bot(spawns.span(), 30 + mode, GAP_HIT + mode, 400, mode);
    assert_eq!(
        replay_spawns(spawns.span(), strikes.span()), naive_replay(spawns.span(), strikes.span()),
    );
}

#[test]
fn test_matches_oracle_bot_clean_1() {
    bot_vs_oracle(1, 0);
}

#[test]
fn test_matches_oracle_bot_clean_2() {
    bot_vs_oracle(2, 0);
}

#[test]
fn test_matches_oracle_bot_busy_1() {
    bot_vs_oracle(3, 1);
}

#[test]
fn test_matches_oracle_bot_busy_2() {
    bot_vs_oracle(4, 1);
}

#[test]
fn test_matches_oracle_bot_sloppy_1() {
    bot_vs_oracle(5, 2);
}

#[test]
fn test_matches_oracle_bot_sloppy_2() {
    bot_vs_oracle(6, 2);
}

#[test]
fn test_matches_oracle_bot_mixed_1() {
    bot_vs_oracle(7, 3);
}

#[test]
fn test_matches_oracle_bot_mixed_2() {
    bot_vs_oracle(8, 3);
}

// ---------------------------------------------------------------------------------------------
// Validation (SPEC §7)
// ---------------------------------------------------------------------------------------------

/// The 15-miss jam death (last strike at tick 252) followed by dead strikes GAP_HIT apart, for
/// `total` strikes in all.
fn long_log(spawns: Span<Spawn>, total: u32) -> Array<u32> {
    let mut log = misses_from_zero(spawns, 15);
    let mut t: u32 = 252 + GAP_MISS;
    while log.len() < total {
        log.append(encode_strike(t, 7, 7));
        t += GAP_HIT;
    }
    log
}

#[test]
fn test_max_strikes_ok() {
    let spawns = jam_death_schedule();
    let log = long_log(spawns.span(), MAX_STRIKES);
    assert_eq!(log.len(), 400);
    let res = replay_spawns(spawns.span(), log.span());
    assert_eq!(res, replay_spawns(spawns.span(), log.span().slice(0, 15)));
}

#[test]
#[should_panic(expected: 'too many strikes')]
fn test_too_many_strikes() {
    let spawns = jam_death_schedule();
    replay_spawns(spawns.span(), long_log(spawns.span(), MAX_STRIKES + 1).span());
}

#[test]
#[should_panic(expected: 'bad gap')]
fn test_gap_after_miss_17_rejected() {
    // tick 0: nothing on screen, a miss; the next strike needs GAP_MISS
    replay(1, duo_roster(), 0, array![encode_strike(0, 0, 0), encode_strike(17, 0, 0)].span());
}

#[test]
fn test_gap_after_miss_18_ok() {
    let res = replay(
        1, duo_roster(), 0, array![encode_strike(0, 0, 0), encode_strike(18, 0, 0)].span(),
    );
    assert!(res.dead);
}

#[test]
#[should_panic(expected: 'bad gap')]
fn test_gap_after_hit_5_rejected() {
    let spawns = build_schedule(5, duo_roster(), 0);
    let s0 = spawns.at(0);
    let t0 = *s0.spawn_tick + REACTION_TICKS;
    replay_spawns(spawns.span(), array![mk(s0, t0), encode_strike(t0 + 5, 0, 0)].span());
}

#[test]
fn test_gap_after_hit_and_overkill_6_ok() {
    let spawns = build_schedule(5, duo_roster(), 0);
    let s0 = spawns.at(0);
    let t0 = *s0.spawn_tick + REACTION_TICKS;
    // kill, overkill 6 ticks later, then a miss 6 ticks after the overkill
    let log = array![mk(s0, t0), mk(s0, t0 + 6), miss_at(spawns.span(), t0 + 12)];
    let mut o = OracleImpl::new(spawns.span());
    assert_eq!(o.strike_raw(*log.at(0)), O_HIT);
    assert_eq!(o.strike_raw(*log.at(1)), O_OVERKILL);
    assert_eq!(o.strike_raw(*log.at(2)), O_MISS);
    assert_eq!(replay_spawns(spawns.span(), log.span()), o.finish());
}

#[test]
#[should_panic(expected: 'bad gap')]
fn test_gap_after_hit_then_miss_needs_18() {
    let spawns = build_schedule(5, duo_roster(), 0);
    let s0 = spawns.at(0);
    let t0 = *s0.spawn_tick + REACTION_TICKS;
    let log = array![mk(s0, t0), miss_at(spawns.span(), t0 + 6), encode_strike(t0 + 23, 0, 0)];
    replay_spawns(spawns.span(), log.span());
}

#[test]
#[should_panic(expected: 'bad gap')]
fn test_equal_ticks_rejected() {
    let spawns = build_schedule(5, duo_roster(), 0);
    let s0 = spawns.at(0);
    let t0 = *s0.spawn_tick + REACTION_TICKS;
    replay_spawns(spawns.span(), array![mk(s0, t0), mk(s0, t0)].span());
}

#[test]
#[should_panic(expected: 'bad gap')]
fn test_gap_after_jam_death_strike_is_miss_gap() {
    let spawns = jam_death_schedule();
    let log = misses_from_zero(spawns.span(), 15);
    // the jam-death strike itself missed: 6 ticks later is too early
    let tail = array![encode_strike(252 + 6, 0, 0)];
    replay_spawns(spawns.span(), concat(log.span(), tail.span()).span());
}

#[test]
#[should_panic(expected: 'bad gap')]
fn test_gap_after_death_is_hit_gap() {
    let spawns = jam_death_schedule();
    let log = misses_from_zero(spawns.span(), 15);
    let tail = array![encode_strike(270, 0, 0), encode_strike(275, 0, 0)];
    replay_spawns(spawns.span(), concat(log.span(), tail.span()).span());
}

#[test]
#[should_panic(expected: 'bad tick')]
fn test_bad_tick() {
    replay(1, duo_roster(), 0, array![encode_strike(4000, 0, 0)].span());
}

#[test]
#[should_panic(expected: 'bad y')]
fn test_bad_y() {
    replay(1, duo_roster(), 0, array![encode_strike(10, 0, 144)].span());
}

#[test]
#[should_panic(expected: 'bad type')]
fn test_bad_type_flag_1() {
    replay(1, duo_roster(), 0, array![encode_strike(10, 0, 0) + 1].span());
}

#[test]
#[should_panic(expected: 'bad type')]
fn test_bad_type_flag_3() {
    replay(1, duo_roster(), 0, array![encode_strike(10, 255, 143) + 3].span());
}

#[test]
#[should_panic(expected: 'bad tick')]
fn test_validation_order_tick_first() {
    // bad tick, bad y and bad flags at once: the tick is checked first (TS Run.validate order)
    replay(1, duo_roster(), 0, array![encode_strike(4000, 0, 144) + 3].span());
}

#[test]
#[should_panic(expected: 'bad tick')]
fn test_bad_tick_after_death_still_reverts() {
    let spawns = jam_death_schedule();
    let log = misses_from_zero(spawns.span(), 15);
    let tail = array![encode_strike(4095, 0, 0)];
    replay_spawns(spawns.span(), concat(log.span(), tail.span()).span());
}

#[test]
#[should_panic(expected: 'bad type')]
fn test_bad_type_after_death_still_reverts() {
    let spawns = jam_death_schedule();
    let log = misses_from_zero(spawns.span(), 15);
    let tail = array![encode_strike(300, 0, 0) + 2];
    replay_spawns(spawns.span(), concat(log.span(), tail.span()).span());
}

#[test]
#[should_panic(expected: 'bad y')]
fn test_bad_y_after_death_still_reverts() {
    let spawns = jam_death_schedule();
    let log = misses_from_zero(spawns.span(), 15);
    let tail = array![encode_strike(300, 0, 200)];
    replay_spawns(spawns.span(), concat(log.span(), tail.span()).span());
}

#[test]
#[should_panic(expected: 'empty roster')]
fn test_empty_roster() {
    replay(1, array![].span(), 0, array![].span());
}

#[test]
#[should_panic(expected: 'bad n_featured')]
fn test_n_featured_too_big() {
    replay(1, duo_roster(), 3, array![].span());
}

// ---------------------------------------------------------------------------------------------
// SPEC v3: shiny Beasts, caught_mask / shiny_mask, roster limit
// ---------------------------------------------------------------------------------------------

/// A big roster of `n` fully hittable common Beasts (types and tiers cycle).
fn big_roster(n: u32) -> Array<RosterEntry> {
    let mut out: Array<RosterEntry> = array![];
    for i in 0..n {
        out
            .append(
                entry(
                    (i % 3).try_into().unwrap(),
                    (1 + i % 5).try_into().unwrap(),
                    100,
                    0,
                    64,
                    56,
                    FULL,
                ),
            );
    }
    out
}

/// The masks a run that kills exactly the Beasts in `killed` (spawn indices) must report, built
/// by summing powers of two (independent of the `bit128` helper).
fn masks_of(spawns: Span<Spawn>, killed: Span<u32>) -> (u128, u128) {
    let mut seen: Felt252Dict<u8> = Default::default();
    let mut seen_shiny: Felt252Dict<u8> = Default::default();
    for b in killed {
        let s = spawns.at(*b);
        seen.insert((*s.roster_idx).into(), 1);
        if *s.shiny {
            seen_shiny.insert((*s.roster_idx).into(), 1);
        }
    }
    let mut caught: u128 = 0;
    let mut shiny: u128 = 0;
    let mut p: u128 = 1;
    let mut r: u32 = 0;
    while r < 128 {
        if seen.get(r.into()) == 1 {
            caught += p;
        }
        if seen_shiny.get(r.into()) == 1 {
            shiny += p;
        }
        if r < 127 {
            p *= 2;
        }
        r += 1;
    }
    (caught, shiny)
}

fn all_spawns(n: u32) -> Array<u32> {
    let mut out: Array<u32> = array![];
    for i in 0..n {
        out.append(i);
    }
    out
}

#[test]
fn test_bit128_and_popcount() {
    assert_eq!(bit128(0), 1);
    assert_eq!(bit128(63), 0x8000000000000000);
    assert_eq!(bit128(64), 0x10000000000000000);
    assert_eq!(bit128(127), 0x80000000000000000000000000000000);
    let mut p: u128 = 1;
    for i in 0..128_u32 {
        assert_eq!(bit128(i), p);
        assert_eq!(popcount(p), 1);
        if i < 127 {
            p *= 2;
        }
    }
    assert_eq!(popcount(0), 0);
    assert_eq!(popcount(0xff), 8);
    assert_eq!(popcount(0xffffffffffffffffffffffffffffffff), 128);
    assert_eq!(popcount(0x80000000000000000000000000000001), 2);
    assert_eq!(popcount(0xa45), 5);
    assert_eq!(popcount(0x5555555555555555aaaaaaaaaaaaaaaa), 64);
    assert_eq!(popcount(0xf0f0f0f0f0f0f0f00f0f0f0f0f0f0f0e), 63);
}

#[test]
fn test_shiny_flag_is_one_in_twelve() {
    // shiny = rnd(seed, T_SHINY, i) % 12 == 0, for every spawn including the King
    let roster = mixed_roster();
    let mut shinies: u32 = 0;
    let mut total: u32 = 0;
    let mut boss_shiny = false;
    for seed in 1..60_u32 {
        let spawns = build_schedule(seed.into(), roster, 2);
        let mut i: u32 = 0;
        for s in spawns.span() {
            let want = rnd(seed.into(), T_SHINY, i) % 12 == 0;
            assert_eq!(*s.shiny, want);
            if want {
                shinies += 1;
                if *s.boss {
                    boss_shiny = true;
                }
            }
            total += 1;
            i += 1;
        }
    }
    // 59 * 40 = 2360 Beasts, expected ~197
    assert!(shinies > 150 && shinies < 250, "shiny rate off");
    assert_eq!(total, 2360);
    // shiny does not change the schedule otherwise (it is not part of the Spawn draw order)
    let _ = boss_shiny;
}

/// First seed in `from..` whose spawn 0 is shiny (`want`) or not.
fn seed_with_first_shiny(want: bool) -> felt252 {
    let mut seed: u32 = 1;
    loop {
        if (rnd(seed.into(), T_SHINY, 0) % 12 == 0) == want {
            break seed.into();
        }
        seed += 1;
    }
}

#[test]
fn test_shiny_kill_scores_triple() {
    // spawn 0 (hp 1, no affix: lvl < 6): one aimed hit at its reaction tick
    let seed = seed_with_first_shiny(true);
    let spawns = build_schedule(seed, duo_roster(), 0);
    let s0 = *spawns.at(0);
    assert!(s0.shiny && s0.hp == 1 && !s0.faint && !s0.boss);
    let t = s0.spawn_tick + REACTION_TICKS;
    let strikes = array![mk(@s0, t)];
    let res = replay_spawns(spawns.span(), strikes.span());
    assert_eq!(res.kills, 1);
    // pts without the early bonus (escape_tick = tick): base * 1.1, chain 1, x3 shiny
    let plain = kill_points(s0.tier, 1, 1, false, false, false, t, t);
    let bonus = (s0.escape_tick - t) / 2;
    assert_eq!(res.score, plain * 3 + bonus);
    let (caught, shiny) = masks_of(spawns.span(), array![0].span());
    assert_eq!((res.caught_mask, res.shiny_mask), (caught, shiny));
    assert_eq!(res.shiny_mask, res.caught_mask);

    // same click on a non-shiny first spawn: no x3, shiny_mask stays empty
    let seed2 = seed_with_first_shiny(false);
    let spawns2 = build_schedule(seed2, duo_roster(), 0);
    let s2 = *spawns2.at(0);
    assert!(!s2.shiny);
    let t2 = s2.spawn_tick + REACTION_TICKS;
    let res2 = replay_spawns(spawns2.span(), array![mk(@s2, t2)].span());
    assert_eq!(res2.kills, 1);
    assert_eq!(res2.score, kill_points(s2.tier, 1, 1, false, false, false, s2.escape_tick, t2));
    assert_eq!(res2.shiny_mask, 0);
    assert_eq!(res2.caught_mask, bit128(s2.roster_idx));
}

/// Perfect bot on `duo_roster`: every Beast dies, masks equal the drawn indices. Returns the
/// shiny mask.
fn check_survivor_masks(seed: felt252, oracle: bool) -> u128 {
    let roster = duo_roster();
    let spawns = build_schedule(seed, roster, 0);
    let strikes = bot(spawns.span(), 0, GAP_HIT, 400, 0);
    let res = replay(seed, roster, 0, strikes.span());
    assert_eq!(res.kills, N_SPAWNS);
    let (caught, shiny) = masks_of(spawns.span(), all_spawns(N_SPAWNS).span());
    assert_eq!((res.caught_mask, res.shiny_mask), (caught, shiny));
    if oracle {
        assert_eq!(res, naive_replay(spawns.span(), strikes.span()));
    }
    // shiny_mask is a subset of caught_mask
    assert_eq!(res.shiny_mask & res.caught_mask, res.shiny_mask);
    res.shiny_mask
}

/// First seed whose 40 spawns contain a shiny Beast.
fn seed_with_any_shiny() -> felt252 {
    let mut seed: u32 = 1;
    loop {
        let mut found = false;
        for i in 0..N_SPAWNS {
            if rnd(seed.into(), T_SHINY, i) % 12 == 0 {
                found = true;
            }
        }
        if found {
            break seed.into();
        }
        seed += 1;
    }
}

#[test]
fn test_masks_survivor_run_and_oracle() {
    // seed 1 against the naive oracle, then a seed that is known to contain shinies
    check_survivor_masks(1, true);
    let shiny = check_survivor_masks(seed_with_any_shiny(), false);
    assert!(shiny != 0);
}

#[test]
fn test_masks_idle_run_is_empty() {
    let spawns = build_schedule(8, mixed_roster(), 2);
    let res = replay_spawns(spawns.span(), array![].span());
    assert_eq!((res.kills, res.caught_mask, res.shiny_mask), (0, 0, 0));
}

#[test]
fn test_masks_partial_kills_only_count_killed() {
    // featured Beasts have hp 2: one hit hurts but does not catch
    let roster = mixed_roster();
    let spawns = build_schedule(11, roster, 2);
    let s0 = *spawns.at(0);
    let t = s0.spawn_tick + REACTION_TICKS;
    let res = replay_spawns(spawns.span(), array![mk(@s0, t)].span());
    if s0.hp == 1 {
        assert_eq!(res.caught_mask, bit128(s0.roster_idx));
    } else {
        assert_eq!((res.kills, res.caught_mask, res.shiny_mask), (0, 0, 0));
    }
}

#[test]
fn test_masks_survive_jam_death() {
    // a jam death keeps the catches made before it
    let roster = duo_roster();
    let spawns = build_schedule(5, roster, 0);
    let strikes = jam_bot(spawns.span(), 5);
    let res = replay_spawns(spawns.span(), strikes.span());
    assert_eq!((res.dead, res.killer, res.killer_roster), (true, NO_INDEX, NO_INDEX));
    assert!(res.kills > 0);
    assert!(res.caught_mask != 0);
    assert!(popcount(res.caught_mask) <= res.kills);
    assert_eq!(res, naive_replay(spawns.span(), strikes.span()));
}

#[test]
fn test_masks_high_roster_indices() {
    // a full 128-entry roster: bits above 63 are set and match the drawn indices
    let roster = big_roster(128);
    let mut high = false;
    for seed in 1..4_u32 {
        let spawns = build_schedule(seed.into(), roster.span(), 0);
        let strikes = bot(spawns.span(), 0, GAP_HIT, 400, 0);
        let res = replay_spawns(spawns.span(), strikes.span());
        assert_eq!(res.kills, N_SPAWNS);
        let (caught, shiny) = masks_of(spawns.span(), all_spawns(N_SPAWNS).span());
        assert_eq!((res.caught_mask, res.shiny_mask), (caught, shiny));
        if res.caught_mask >= 0x10000000000000000 {
            high = true;
        }
    }
    assert!(high);
}

#[test]
fn test_roster_of_128_is_ok() {
    assert_eq!(MAX_ROSTER, 128);
    let roster = big_roster(128);
    let res = replay(3, roster.span(), 0, array![].span());
    assert_eq!(res.kills, 0);
}

#[test]
#[should_panic(expected: 'roster too long')]
fn test_roster_of_129_rejected() {
    let roster = big_roster(129);
    replay(3, roster.span(), 0, array![].span());
}
