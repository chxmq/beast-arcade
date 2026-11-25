//! STATIC replay, SPEC.md v3.0 ("catch every signal"). Bit-for-bit mirror of the TypeScript sim in
//! `src/sim/` (schedule.ts, replay.ts).
//!
//! Event driven: the 40-spawn schedule is computed once, escapes are processed through a
//! precomputed (escape_tick, index) order, and motion is closed form, so the replay never loops
//! over ticks. Strike validation runs inside the replay loop because the gap a strike needs
//! depends on whether the previous one missed (SPEC §7).
//!
//! Target search relies on spawn ticks strictly increasing with the index (SPEC §5: base step
//! >= 37 ticks, jitter < 20): once a Beast is still in its reaction window (or not spawned yet),
//! every later Beast is too. Beasts whose window closed before the current strike are skipped
//! for good (strike ticks strictly increase).

use core::dict::Felt252Dict;
use core::hash::HashStateTrait;
use core::poseidon::PoseidonTrait;
use crate::constants::{
    AFFIX_MIN_LVL, BOSS_LIFE_BASE, BOSS_LIFE_JITTER, BOSS_MULT, CHAIN_CAP, COMBO_CAP, ESCAPE_COST,
    ESCAPE_COST_BANE, EV_ESCAPE, EV_JAM, EV_KILL, EV_STRIKE, FEATURED_PCT, FIELD_H, FIELD_W,
    GAP_HIT, GAP_MISS, HP_BOSS, HP_COMMON, HP_FEATURED, HP_HEALTH_MIN, JAM_MISSES, KILL_BASE,
    KILL_LIFE_DIV, KILL_TIER_STEP, LIFE_AGGR, LIFE_BASE, LIFE_JITTER, LIFE_STEP, MAX_ROSTER,
    MAX_STRIKES, MAX_TICK, MISS_INDEX, NO_INDEX, NO_TYPE, N_PREFIXES, N_SPAWNS, N_SUFFIXES,
    OVERKILL_INDEX, PLAYER_LIVES, PREFIX_DUSK, PREFIX_GALE, PREFIX_GLOOM, PREFIX_STORM,
    PREFIX_TEMPEST, REACTION_TICKS, SHINY_MULT, SHINY_ONE_IN, SPAWN_BASE, SPAWN_CURVE_DEN,
    SPAWN_CURVE_NUM, SPAWN_JITTER, SPAWN_STEP, SUFFIX_BANE, SUFFIX_PEAK, SUFFIX_SHADOW, T_AFFIX,
    T_LIFE, T_POS_X, T_POS_Y, T_SHINY, T_SPECIES, T_TICK, T_VEL,
};
use crate::rng::rnd;

/// SPEC §3 roster entry, as the sim sees it.
#[derive(Copy, Drop, Serde, starknet::Store, PartialEq, Debug)]
pub struct RosterEntry {
    pub beast_type: u8,
    pub tier: u8,
    pub health: u16,
    pub aggr: u8,
    pub w: u8,
    pub h: u8,
    pub occ: u64,
}

/// SPEC §10.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct RunResult {
    pub score: u32,
    pub kills: u32,
    pub lives: u32,
    pub dead: bool,
    /// 0 when the player survives.
    pub death_tick: u32,
    /// Spawn index of the Beast whose escape took the last life; 255 if none (survived or jam).
    pub killer: u32,
    /// Roster index of that Beast; 255 if none.
    pub killer_roster: u32,
    pub best_combo: u32,
    /// Bit `roster_idx` set for every roster entry with a Beast caught (killed) this run.
    pub caught_mask: u128,
    /// Same, for shiny catches only.
    pub shiny_mask: u128,
    pub digest: felt252,
}

/// One scheduled Beast (SPEC §5), fully resolved.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Spawn {
    pub roster_idx: u32,
    pub beast_type: u32,
    pub tier: u32,
    pub w: u32,
    pub h: u32,
    pub occ: u64,
    pub boss: bool,
    pub featured: bool,
    pub spawn_tick: u32,
    pub escape_tick: u32,
    pub lvl: u32,
    pub prefix: u32,
    pub suffix: u32,
    pub swift: bool,
    pub faint: bool,
    pub peak: bool,
    pub bane: bool,
    pub shiny: bool,
    pub vx: u32,
    pub vy: u32,
    pub dir_x: u32,
    pub dir_y: u32,
    pub x0: u32,
    pub y0: u32,
    pub lx: u32,
    pub ly: u32,
    pub hp: u32,
    /// Lives lost when it gets away.
    pub escape_cost: u32,
}

const U32_MAX: u32 = 0xffffffff;
/// Escape order keys are `escape_tick * ESC_KEY + index` (N_SPAWNS <= ESC_KEY).
const ESC_KEY: u32 = 64;

const POW2_64: [u64; 64] = [
    0x1, 0x2, 0x4, 0x8, 0x10, 0x20, 0x40, 0x80, 0x100, 0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000,
    0x8000, 0x10000, 0x20000, 0x40000, 0x80000, 0x100000, 0x200000, 0x400000, 0x800000, 0x1000000,
    0x2000000, 0x4000000, 0x8000000, 0x10000000, 0x20000000, 0x40000000, 0x80000000, 0x100000000,
    0x200000000, 0x400000000, 0x800000000, 0x1000000000, 0x2000000000, 0x4000000000, 0x8000000000,
    0x10000000000, 0x20000000000, 0x40000000000, 0x80000000000, 0x100000000000, 0x200000000000,
    0x400000000000, 0x800000000000, 0x1000000000000, 0x2000000000000, 0x4000000000000,
    0x8000000000000, 0x10000000000000, 0x20000000000000, 0x40000000000000, 0x80000000000000,
    0x100000000000000, 0x200000000000000, 0x400000000000000, 0x800000000000000, 0x1000000000000000,
    0x2000000000000000, 0x4000000000000000, 0x8000000000000000,
];

fn bit(i: u32) -> u64 {
    *POW2_64.span().at(i)
}

const POW2_64_U128: u128 = 0x10000000000000000;

/// `1 << i` as u128 (`i < 128`).
pub fn bit128(i: u32) -> u128 {
    if i < 64 {
        (*POW2_64.span().at(i)).into()
    } else {
        let hi: u128 = (*POW2_64.span().at(i - 64)).into();
        hi * POW2_64_U128
    }
}

/// Number of set bits (SWAR; no overflow: every partial sum fits its field).
pub fn popcount(v: u128) -> u32 {
    let x = v - ((v / 2) & 0x55555555555555555555555555555555);
    let x = (x & 0x33333333333333333333333333333333)
        + ((x / 4) & 0x33333333333333333333333333333333);
    let x = (x + x / 16) & 0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f;
    let x = x + x / 0x100;
    let x = x + x / 0x10000;
    let x = x + x / 0x100000000;
    let x = x + x / 0x10000000000000000;
    (x & 0xff).try_into().unwrap()
}

// ---------------------------------------------------------------------------------------------
// Small pure helpers (public so unit tests and the contract can use them)
// ---------------------------------------------------------------------------------------------

/// SPEC §3: aggression from kill count.
pub fn aggr_from_kills(k: u32) -> u8 {
    if k == 0 {
        0
    } else if k < 3 {
        1
    } else if k < 7 {
        2
    } else {
        3
    }
}

/// SPEC §7: `tick << 18 | x << 10 | y << 2` (the 2 flag bits must be 0 in v2).
pub fn encode_strike(tick: u32, x: u32, y: u32) -> u32 {
    tick * 0x40000 + x * 0x400 + y * 4
}

/// SPEC §7: returns `(tick, x, y, flags)`.
pub fn decode_strike(s: u32) -> (u32, u32, u32, u32) {
    (s / 0x40000, (s / 0x400) % 256, (s / 4) % 256, s % 4)
}

/// SPEC §5: roster index of spawn `i` given `n_featured` (nF) and `n_common` (nC).
pub fn pick_roster_idx(seed: felt252, i: u32, n_featured: u32, n_common: u32) -> u32 {
    let r = rnd(seed, T_SPECIES, i);
    let nf: u128 = n_featured.into();
    let nc: u128 = n_common.into();
    let boss = i == N_SPAWNS - 1;
    let idx: u128 = if nf == 0 {
        r % nc
    } else if nc == 0 || boss {
        r % nf
    } else if r % 100 < FEATURED_PCT {
        (r / 100) % nf
    } else {
        nf + (r / 100) % nc
    };
    idx.try_into().unwrap()
}

fn rnd_mod(seed: felt252, tag: felt252, i: u32, m: u128) -> u32 {
    (rnd(seed, tag, i) % m).try_into().unwrap()
}

fn mod_u32(v: u128, m: u128) -> u32 {
    (v % m).try_into().unwrap()
}

/// SPEC §5: everything about spawn `i`, drawn at roster index `roster_idx` (entry `e`).
/// `featured = roster_idx < n_featured`. Requires `e.aggr <= 3` and `1 <= e.tier <= 5`.
pub fn build_spawn(
    seed: felt252, i: u32, roster_idx: u32, n_featured: u32, e: RosterEntry,
) -> Spawn {
    let aggr: u32 = e.aggr.into();
    let tier: u32 = e.tier.into();
    let w: u32 = e.w.into();
    let h: u32 = e.h.into();
    let boss = i == N_SPAWNS - 1;
    let featured = roster_idx < n_featured;
    let spawn_tick = SPAWN_BASE
        + SPAWN_STEP * i
        - (SPAWN_CURVE_NUM * i * i) / SPAWN_CURVE_DEN
        + rnd_mod(seed, T_TICK, i, SPAWN_JITTER);

    let lvl = 1 + i / 4 + aggr;
    let mut prefix: u32 = 0;
    let mut suffix: u32 = 0;
    if lvl >= AFFIX_MIN_LVL {
        let ra = rnd(seed, T_AFFIX, i);
        prefix = 1 + mod_u32(ra, N_PREFIXES);
        suffix = 1 + mod_u32(ra / N_PREFIXES, N_SUFFIXES);
    }
    let swift = prefix == PREFIX_GALE || prefix == PREFIX_STORM || prefix == PREFIX_TEMPEST;
    let faint = prefix == PREFIX_DUSK || prefix == PREFIX_GLOOM || suffix == SUFFIX_SHADOW;
    let peak = suffix == SUFFIX_PEAK;
    let bane = suffix == SUFFIX_BANE;
    let shiny = rnd(seed, T_SHINY, i) % SHINY_ONE_IN == 0;

    // Magic floats diagonally, Hunter darts sideways, Brute lumbers (any type other than 0 / 1
    // takes the Brute branch, like the TS `else`).
    let rv = rnd(seed, T_VEL, i);
    let rv8 = rv / 0x100;
    let (mut vx, mut vy): (u32, u32) = if e.beast_type == 0 {
        (4 + mod_u32(rv, 4) + 2 * aggr, 4 + mod_u32(rv8, 4) + aggr)
    } else if e.beast_type == 1 {
        (8 + mod_u32(rv, 5) + 2 * aggr, 1 + mod_u32(rv8, 2) + aggr)
    } else {
        (3 + mod_u32(rv, 3) + aggr, 2 + mod_u32(rv8, 3) + aggr)
    };
    if swift {
        vx = vx * 3 / 2;
        vy = vy * 3 / 2;
    }
    let dir_x = mod_u32(rv / 0x10000, 2);
    let dir_y = mod_u32(rv / 0x20000, 2);

    let lx = (FIELD_W - w) * 16;
    let ly = (FIELD_H - h) * 16;
    let x0 = rnd_mod(seed, T_POS_X, i, (lx + 1).into());
    let y0 = rnd_mod(seed, T_POS_Y, i, (ly + 1).into());

    let rl = rnd(seed, T_LIFE, i);
    let life = if boss {
        BOSS_LIFE_BASE + mod_u32(rl, BOSS_LIFE_JITTER)
    } else {
        LIFE_BASE - LIFE_STEP * i + mod_u32(rl, LIFE_JITTER) - LIFE_AGGR * aggr
    };
    let escape_tick = spawn_tick + life;

    let mut hp = if boss {
        HP_BOSS
    } else if featured {
        HP_FEATURED
    } else {
        HP_COMMON
    };
    if e.health >= HP_HEALTH_MIN {
        hp += 1;
    }
    if peak {
        hp += 1;
    }
    let escape_cost = if bane {
        ESCAPE_COST_BANE
    } else {
        ESCAPE_COST
    };

    Spawn {
        roster_idx,
        beast_type: e.beast_type.into(),
        tier,
        w,
        h,
        occ: e.occ,
        boss,
        featured,
        spawn_tick,
        escape_tick,
        lvl,
        prefix,
        suffix,
        swift,
        faint,
        peak,
        bane,
        shiny,
        vx,
        vy,
        dir_x,
        dir_y,
        x0,
        y0,
        lx,
        ly,
        hp,
        escape_cost,
    }
}

/// Asserts the roster shape the schedule needs (TS throws on an empty roster too).
pub fn check_roster_shape(roster_len: u32, n_featured: u32) {
    assert(roster_len > 0, 'empty roster');
    assert(n_featured <= roster_len, 'bad n_featured');
    assert(roster_len <= MAX_ROSTER, 'roster too long');
}

/// SPEC §5: full schedule from an in-memory roster.
pub fn build_schedule(seed: felt252, roster: Span<RosterEntry>, n_featured: u32) -> Array<Spawn> {
    check_roster_shape(roster.len(), n_featured);
    let n_common = roster.len() - n_featured;
    let mut out: Array<Spawn> = array![];
    for i in 0..N_SPAWNS {
        let idx = pick_roster_idx(seed, i, n_featured, n_common);
        out.append(build_spawn(seed, i, idx, n_featured, *roster.at(idx)));
    }
    out
}

/// SPEC §6: reflecting motion on one axis, Q4. Returns q (not yet shifted to pixels).
pub fn axis(l: u32, s0: u32, v: u32, d: u32, dt: u32) -> u32 {
    if l == 0 {
        return 0;
    }
    let p = 2 * l;
    let u0 = if d == 1 {
        s0
    } else {
        (p - s0) % p
    };
    let u = (u0 + v * dt) % p;
    if u <= l {
        u
    } else {
        p - u
    }
}

/// Top-left pixel of the silhouette at `tick` (requires `tick >= spawn_tick`).
pub fn position_at(s: @Spawn, tick: u32) -> (u32, u32) {
    let dt = tick - *s.spawn_tick;
    let qx = axis(*s.lx, *s.x0, *s.vx, *s.dir_x, dt);
    let qy = axis(*s.ly, *s.y0, *s.vy, *s.dir_y, dt);
    (qx / 16, qy / 16)
}

/// SPEC §3/§8: is field pixel (x, y) inside a set occupancy cell of a silhouette at (px, py)?
pub fn occ_hit(occ: u64, w: u32, h: u32, x: u32, y: u32, px: u32, py: u32) -> bool {
    if x < px || y < py {
        return false;
    }
    let lx = x - px;
    let ly = y - py;
    if lx >= w || ly >= h {
        return false;
    }
    let cx = lx * 8 / w;
    let cy = ly * 8 / h;
    occ & bit(cy * 8 + cx) != 0
}

/// SPEC §8: does Beast `s` cover (x, y) at `tick` (`tick >= spawn_tick`)? Same as
/// `occ_hit(position_at(s, tick))`, but the y axis is only evaluated when x is inside the box.
pub fn covers(s: @Spawn, tick: u32, x: u32, y: u32) -> bool {
    let dt = tick - *s.spawn_tick;
    let px = axis(*s.lx, *s.x0, *s.vx, *s.dir_x, dt) / 16;
    if x < px {
        return false;
    }
    let lx = x - px;
    let w = *s.w;
    if lx >= w {
        return false;
    }
    let py = axis(*s.ly, *s.y0, *s.vy, *s.dir_y, dt) / 16;
    if y < py {
        return false;
    }
    let ly = y - py;
    let h = *s.h;
    if ly >= h {
        return false;
    }
    let occ: u64 = *s.occ;
    (occ & bit((ly * 8 / h) * 8 + lx * 8 / w)) != 0
}

/// SPEC §8 kill points, with the exact integer division order of the spec.
pub fn kill_points(
    tier: u32,
    combo: u32,
    chain: u32,
    faint: bool,
    boss: bool,
    shiny: bool,
    escape_tick: u32,
    tick: u32,
) -> u32 {
    let base = KILL_BASE + KILL_TIER_STEP * (5 - tier);
    let c = if combo < COMBO_CAP {
        combo
    } else {
        COMBO_CAP
    };
    let mut pts = base * (10 + c) / 10;
    let ch = if chain < CHAIN_CAP {
        chain
    } else {
        CHAIN_CAP
    };
    pts = pts * (1 + ch) / 2;
    if faint {
        pts = pts * 5 / 4;
    }
    if boss {
        pts = pts * BOSS_MULT;
    }
    if shiny {
        pts = pts * SHINY_MULT;
    }
    pts + (escape_tick - tick) / KILL_LIFE_DIV
}

/// SPEC §9 event word: `kind + 8 * idx + 512 * tick + 2^24 * value`.
pub fn event_word(kind: felt252, idx: u32, tick: u32, value: u32) -> felt252 {
    kind + 8 * idx.into() + 0x200 * tick.into() + 0x1000000 * value.into()
}

/// SPEC §9: `poseidon_hash_span([digest, ev])` (the streaming form below is the same function).
pub fn digest_step(digest: felt252, ev: felt252) -> felt252 {
    PoseidonTrait::new().update(digest).update(ev).finalize()
}

/// Spawn indices sorted by (escape_tick, index), encoded as `escape_tick * ESC_KEY + index`.
fn escape_order(spawns: Span<Spawn>) -> Span<u32> {
    let mut sorted: Array<u32> = array![];
    let mut i: u32 = 0;
    for s in spawns {
        let key = *s.escape_tick * ESC_KEY + i;
        let mut next: Array<u32> = array![];
        let mut placed = false;
        for v in sorted.span() {
            if !placed && key < *v {
                next.append(key);
                placed = true;
            }
            next.append(*v);
        }
        if !placed {
            next.append(key);
        }
        sorted = next;
        i += 1;
    }
    sorted.span()
}

// ---------------------------------------------------------------------------------------------
// Replay state machine (SPEC §8)
// ---------------------------------------------------------------------------------------------

#[derive(Destruct)]
struct Sim {
    spawns: Span<Spawn>,
    esc_order: Span<u32>,
    esc_ptr: u32,
    /// Every Beast below `lo` has `escape_tick <= ` the current strike tick: never visible again.
    lo: u32,
    /// Bit b: Beast b is alive (not escaped, not killed).
    alive: u64,
    /// Bit b: Beast b was killed by the player.
    killed: u64,
    /// Hits taken by each Beast.
    taken: Felt252Dict<u32>,
    lives: u32,
    score: u32,
    kills: u32,
    /// Bit r: a Beast of roster index r was killed (u128, roster <= 128 entries).
    caught_mask: u128,
    shiny_mask: u128,
    combo: u32,
    best_combo: u32,
    /// Consecutive misses.
    misses: u32,
    chain: u32,
    chain_type: u32,
    dead: bool,
    death_tick: u32,
    killer: u32,
    digest: felt252,
}

#[generate_trait]
impl SimImpl of SimTrait {
    fn log(ref self: Sim, kind: felt252, idx: u32, tick: u32, value: u32) {
        self.digest = digest_step(self.digest, event_word(kind, idx, tick, value));
    }

    /// Process escapes with `escape_tick <= limit`, in (escape_tick, index) order.
    fn process_escapes(ref self: Sim, limit: u32) {
        let n = self.esc_order.len();
        while self.esc_ptr < n {
            let key = *self.esc_order.at(self.esc_ptr);
            let et = key / ESC_KEY;
            if et > limit {
                break;
            }
            self.esc_ptr += 1;
            let b = key % ESC_KEY;
            let m = bit(b);
            if self.alive & m == 0 {
                continue;
            }
            self.alive -= m;
            let cost = *self.spawns.at(b).escape_cost;
            self.lives = if self.lives > cost {
                self.lives - cost
            } else {
                0
            };
            self.combo = 0;
            self.log(EV_ESCAPE, b, et, self.lives);
            if self.lives == 0 {
                self.dead = true;
                self.death_tick = et;
                self.killer = b;
                break;
            }
        }
    }

    /// Lowest-index targetable Beast covering (x, y) at `tick`, or NO_INDEX.
    fn find_hit(ref self: Sim, tick: u32, x: u32, y: u32) -> u32 {
        let n = self.spawns.len();
        while self.lo < n && *self.spawns.at(self.lo).escape_tick <= tick {
            self.lo += 1;
        }
        let mut b = self.lo;
        while b < n {
            let s = self.spawns.at(b);
            if *s.spawn_tick + REACTION_TICKS > tick {
                break;
            }
            if tick < *s.escape_tick && self.alive & bit(b) != 0 && covers(s, tick, x, y) {
                return b;
            }
            b += 1;
        }
        NO_INDEX
    }

    /// Does a killed Beast that is still in its visible window cover (x, y) at `tick`?
    /// (Called right after `find_hit`, which advanced `lo` for this tick.)
    fn any_overkill(self: @Sim, tick: u32, x: u32, y: u32) -> bool {
        let killed = *self.killed;
        if killed == 0 {
            return false;
        }
        let spawns = *self.spawns;
        let n = spawns.len();
        let mut b = *self.lo;
        while b < n {
            let s = spawns.at(b);
            if *s.spawn_tick > tick {
                break;
            }
            if tick < *s.escape_tick && killed & bit(b) != 0 && covers(s, tick, x, y) {
                return true;
            }
            b += 1;
        }
        false
    }

    fn kill(ref self: Sim, b: u32, tick: u32) {
        let s = self.spawns.at(b);
        let m = bit(b);
        self.alive -= m;
        self.killed += m;
        self.kills += 1;
        let t = *s.beast_type;
        self.chain = if t == self.chain_type {
            self.chain + 1
        } else {
            1
        };
        self.chain_type = t;
        let pts = kill_points(
            *s.tier, self.combo, self.chain, *s.faint, *s.boss, *s.shiny, *s.escape_tick, tick,
        );
        self.score += pts;
        let rm = bit128(*s.roster_idx);
        if self.caught_mask / rm % 2 == 0 {
            self.caught_mask += rm;
        }
        if *s.shiny && self.shiny_mask / rm % 2 == 0 {
            self.shiny_mask += rm;
        }
        self.log(EV_KILL, b, tick, pts);
    }

    /// One strike while the player is alive (SPEC §8 steps 1-4). Returns whether it was a miss.
    fn strike(ref self: Sim, tick: u32, x: u32, y: u32) -> bool {
        self.process_escapes(tick);
        if self.dead {
            return false;
        }

        let b = self.find_hit(tick, x, y);
        if b != NO_INDEX {
            let taken = self.taken.get(b.into()) + 1;
            self.taken.insert(b.into(), taken);
            self.combo += 1;
            if self.combo > self.best_combo {
                self.best_combo = self.combo;
            }
            self.misses = 0;
            self.log(EV_STRIKE, b, tick, self.combo);
            if taken == *self.spawns.at(b).hp {
                self.kill(b, tick);
            }
            return false;
        }

        if self.any_overkill(tick, x, y) {
            self.log(EV_STRIKE, OVERKILL_INDEX, tick, self.combo);
            return false;
        }

        self.combo = 0;
        self.misses += 1;
        self.log(EV_STRIKE, MISS_INDEX, tick, self.misses);
        if self.misses == JAM_MISSES {
            self.misses = 0;
            self.lives -= 1; // lives >= 1 while alive
            self.log(EV_JAM, MISS_INDEX, tick, self.lives);
            if self.lives == 0 {
                self.dead = true;
                self.death_tick = tick;
                self.killer = NO_INDEX;
            }
        }
        true
    }
}

/// SPEC §7-§10 over an already-built schedule. The contract builds the schedule lazily from
/// storage (only the 40 drawn roster entries) and calls this directly.
///
/// Validation per strike, in the TS `Run.validate` order: count, tick, x, y, flags, gap. Every
/// strike is validated, also those after the player died (they count as "not a miss").
pub fn replay_spawns(spawns: Span<Spawn>, strikes: Span<u32>) -> RunResult {
    assert(spawns.len() == N_SPAWNS, 'bad schedule');
    let mut sim = Sim {
        spawns,
        esc_order: escape_order(spawns),
        esc_ptr: 0,
        lo: 0,
        alive: bit(N_SPAWNS) - 1,
        killed: 0,
        taken: Default::default(),
        lives: PLAYER_LIVES,
        score: 0,
        kills: 0,
        caught_mask: 0,
        shiny_mask: 0,
        combo: 0,
        best_combo: 0,
        misses: 0,
        chain: 0,
        chain_type: NO_TYPE,
        dead: false,
        death_tick: 0,
        killer: NO_INDEX,
        digest: 0,
    };
    let mut count: u32 = 0;
    let mut last_tick: u32 = 0;
    let mut last_miss = false;
    for s in strikes {
        assert(count < MAX_STRIKES, 'too many strikes');
        let (tick, x, y, flags) = decode_strike(*s);
        assert(tick < MAX_TICK, 'bad tick');
        assert(x < FIELD_W, 'bad x'); // unreachable with an 8-bit x field, kept for the spec
        assert(y < FIELD_H, 'bad y');
        assert(flags == 0, 'bad type');
        if count != 0 {
            let gap = if last_miss {
                GAP_MISS
            } else {
                GAP_HIT
            };
            assert(tick >= last_tick + gap, 'bad gap');
        }
        count += 1;
        last_tick = tick;
        last_miss = if sim.dead {
            false
        } else {
            sim.strike(tick, x, y)
        };
    }
    if !sim.dead {
        sim.process_escapes(U32_MAX);
    }
    let (death_tick, killer, killer_roster) = if !sim.dead {
        (0, NO_INDEX, NO_INDEX)
    } else if sim.killer == NO_INDEX {
        (sim.death_tick, NO_INDEX, NO_INDEX)
    } else {
        (sim.death_tick, sim.killer, *spawns.at(sim.killer).roster_idx)
    };
    RunResult {
        score: sim.score,
        kills: sim.kills,
        lives: sim.lives,
        dead: sim.dead,
        death_tick,
        killer,
        killer_roster,
        best_combo: sim.best_combo,
        caught_mask: sim.caught_mask,
        shiny_mask: sim.shiny_mask,
        digest: sim.digest,
    }
}

/// SPEC §8 replay of an encoded strike log against an in-memory roster.
pub fn replay(
    seed: felt252, roster: Span<RosterEntry>, n_featured: u32, strikes: Span<u32>,
) -> RunResult {
    let spawns = build_schedule(seed, roster, n_featured);
    replay_spawns(spawns.span(), strikes)
}
