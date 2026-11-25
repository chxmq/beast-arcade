//! Shared test helpers: aimed strike bots over a built schedule (SPEC v2).

use core::dict::Felt252Dict;
use static_game::constants::{GAP_HIT, GAP_MISS, JAM_MISSES, MAX_TICK, NO_INDEX, REACTION_TICKS};
use static_game::sim::{Spawn, covers, encode_strike, position_at};

pub fn first_cell(occ: u64) -> u32 {
    let mut idx: u32 = 0;
    let mut v = occ;
    while idx < 64 && v % 2 == 0 {
        v /= 2;
        idx += 1;
    }
    idx
}

/// A pixel inside the first set occupancy cell of spawn `s` at tick `t` (exact for w, h >= 8).
pub fn aim(s: @Spawn, t: u32) -> (u32, u32) {
    let (px, py) = position_at(s, t);
    let c = first_cell(*s.occ);
    let cx = c % 8;
    let cy = c / 8;
    (px + (2 * cx + 1) * *s.w / 16, py + (2 * cy + 1) * *s.h / 16)
}

/// A click on spawn `s` at tick `t`.
pub fn mk(s: @Spawn, t: u32) -> u32 {
    let (x, y) = aim(s, t);
    encode_strike(t, x, y)
}

/// Does any Beast in its visible window cover (x, y) at `t`? (Geometry only: alive or not.)
pub fn covered(spawns: Span<Spawn>, t: u32, x: u32, y: u32) -> bool {
    let mut found = false;
    for s in spawns {
        if *s.spawn_tick <= t && t < *s.escape_tick && covers(s, t, x, y) {
            found = true;
            break;
        }
    }
    found
}

/// A pixel no visible Beast covers at `t`: a click there is a guaranteed miss.
pub fn blank(spawns: Span<Spawn>, t: u32) -> (u32, u32) {
    let mut y: u32 = 0;
    loop {
        assert(y < 144, 'no blank pixel');
        let mut x: u32 = 0;
        while x < 256 && covered(spawns, t, x, y) {
            x += 8;
        }
        if x < 256 {
            break (x, y);
        }
        y += 8;
    }
}

/// A guaranteed miss at `t`.
pub fn miss_at(spawns: Span<Spawn>, t: u32) -> u32 {
    let (x, y) = blank(spawns, t);
    encode_strike(t, x, y)
}

/// Lowest-index Beast the bot can hit at `t`: targetable and not yet killed by its own clicks.
/// While the player lives, a click on it hits exactly it, because every lower-index Beast still
/// in its window was killed by earlier clicks (spawn ticks strictly increase).
fn live_target(spawns: Span<Spawn>, ref hits: Felt252Dict<u32>, t: u32) -> u32 {
    let mut b: u32 = 0;
    let mut found = NO_INDEX;
    while b < spawns.len() {
        let s = spawns.at(b);
        if *s.spawn_tick + REACTION_TICKS > t {
            break;
        }
        if t < *s.escape_tick && hits.get(b.into()) < *s.hp {
            found = b;
            break;
        }
        b += 1;
    }
    found
}

/// Lowest-index Beast the bot killed that is still on screen at `t` (an overkill target).
fn killed_on_screen(spawns: Span<Spawn>, ref hits: Felt252Dict<u32>, t: u32) -> u32 {
    let mut b: u32 = 0;
    let mut found = NO_INDEX;
    while b < spawns.len() {
        let s = spawns.at(b);
        if *s.spawn_tick > t {
            break;
        }
        if t < *s.escape_tick && hits.get(b.into()) >= *s.hp {
            found = b;
            break;
        }
        b += 1;
    }
    found
}

/// Aimed bot. From tick `start` it clicks the lowest-index Beast it can hit and then waits
/// `step` ticks (>= GAP_HIT). With nothing to hit: mode 0 waits a tick, mode 1 clicks a Beast it
/// already killed that is still on screen (overkill), mode 2 clicks a blank pixel (a miss, then
/// waits GAP_MISS). Mode 3 is mode 1 plus a deliberate miss on every 4th click. It knows the
/// outcome of every click, so its logs always respect the gap rule. Stops after `max` clicks or
/// once every Beast is gone.
pub fn bot(spawns: Span<Spawn>, start: u32, step: u32, max: u32, mode: u32) -> Array<u32> {
    let mut out: Array<u32> = array![];
    let mut hits: Felt252Dict<u32> = Default::default();
    let miss_wait = if step > GAP_MISS {
        step
    } else {
        GAP_MISS
    };
    let mut end: u32 = 0;
    for s in spawns {
        if *s.escape_tick > end {
            end = *s.escape_tick;
        }
    }
    let mut t = start;
    while out.len() < max && t < MAX_TICK && t < end {
        let sloppy = mode == 3 && out.len() % 4 == 3;
        if sloppy {
            out.append(miss_at(spawns, t));
            t += miss_wait;
            continue;
        }
        let target = live_target(spawns, ref hits, t);
        if target != NO_INDEX {
            out.append(mk(spawns.at(target), t));
            hits.insert(target.into(), hits.get(target.into()) + 1);
            t += step;
            continue;
        }
        if mode == 1 || mode == 3 {
            let k = killed_on_screen(spawns, ref hits, t);
            if k != NO_INDEX {
                out.append(mk(spawns.at(k), t));
                t += step;
                continue;
            }
        }
        if mode == 2 {
            out.append(miss_at(spawns, t));
            t += miss_wait;
            continue;
        }
        t += 1;
    }
    out
}

/// Jam bot: while its miss counter is 0 it hits whatever it can; otherwise (or with nothing to
/// hit) it clicks blank pixels, so misses come in groups of three. Hits right after a jam lose
/// nothing, and killing every Beast early keeps escapes away, so `jams = 5` ends the run by
/// jamming (killer 255).
pub fn jam_bot(spawns: Span<Spawn>, jams: u32) -> Array<u32> {
    let mut out: Array<u32> = array![];
    let mut hits: Felt252Dict<u32> = Default::default();
    let mut misses: u32 = 0;
    let mut done: u32 = 0;
    let mut t: u32 = 0;
    while done < jams && t < MAX_TICK {
        if misses == 0 {
            let b = live_target(spawns, ref hits, t);
            if b != NO_INDEX {
                out.append(mk(spawns.at(b), t));
                hits.insert(b.into(), hits.get(b.into()) + 1);
                t += GAP_HIT;
                continue;
            }
        }
        out.append(miss_at(spawns, t));
        misses += 1;
        if misses == JAM_MISSES {
            misses = 0;
            done += 1;
        }
        t += GAP_MISS;
    }
    out
}
