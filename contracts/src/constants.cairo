// Game constants, mirrored 1:1 from SPEC.md (v3.0 "catch every signal"). Changing anything here
// means regenerating the parity vectors from the TypeScript sim (`npm run vectors`).

// §1 Units
pub const FIELD_W: u32 = 256;
pub const FIELD_H: u32 = 144;
pub const TPS: u32 = 60;
pub const N_SPAWNS: u32 = 40;
pub const MAX_TICK: u32 = 4000;
pub const MAX_STRIKES: u32 = 400;
/// Min ticks after a strike that was not a miss (a hit, an overkill, or any strike after death).
pub const GAP_HIT: u32 = 6;
/// Min ticks after a miss.
pub const GAP_MISS: u32 = 18;
pub const REACTION_TICKS: u32 = 8;
pub const PLAYER_LIVES: u32 = 5;
/// Consecutive misses that jam the signal (cost a life).
pub const JAM_MISSES: u32 = 3;
pub const FEATURED_PCT: u128 = 45;

// §2 Types (same encoding as the Beasts registry)
pub const MAGIC: u32 = 0;
pub const HUNTER: u32 = 1;
pub const BRUTE: u32 = 2;
/// `chain_type` before the first kill.
pub const NO_TYPE: u32 = 3;

// §4 RNG tags
pub const T_TICK: felt252 = 1;
pub const T_SPECIES: felt252 = 2;
pub const T_POS_X: felt252 = 3;
pub const T_POS_Y: felt252 = 4;
pub const T_VEL: felt252 = 5;
pub const T_LIFE: felt252 = 6;
pub const T_AFFIX: felt252 = 7;
pub const T_SHINY: felt252 = 8;

// §5 schedule: spawn_tick = 30 + 84 * i - (3 * i * i) / 5 + rnd % 20
pub const SPAWN_BASE: u32 = 30;
pub const SPAWN_STEP: u32 = 84;
pub const SPAWN_CURVE_NUM: u32 = 3;
pub const SPAWN_CURVE_DEN: u32 = 5;
pub const SPAWN_JITTER: u128 = 20;
/// Affixes are rolled when lvl = 1 + i / 4 + aggr reaches this.
pub const AFFIX_MIN_LVL: u32 = 6;
/// life = 180 - 2 * i + rl % 40 - 10 * aggr (boss: 360 + rl % 60)
pub const LIFE_BASE: u32 = 180;
pub const LIFE_STEP: u32 = 2;
pub const LIFE_JITTER: u128 = 40;
pub const LIFE_AGGR: u32 = 10;
pub const BOSS_LIFE_BASE: u32 = 360;
pub const BOSS_LIFE_JITTER: u128 = 60;
/// hp = boss ? 8 : (featured ? 2 : 1), +1 if health >= 150, +1 if Peak
pub const HP_BOSS: u32 = 8;
pub const HP_FEATURED: u32 = 2;
pub const HP_COMMON: u32 = 1;
pub const HP_HEALTH_MIN: u16 = 150;
/// Lives lost when a Beast gets away (Bane: 2).
pub const ESCAPE_COST: u32 = 1;
pub const ESCAPE_COST_BANE: u32 = 2;

// §8 kill scoring
/// base = 50 + 25 * (5 - tier)
pub const KILL_BASE: u32 = 50;
pub const KILL_TIER_STEP: u32 = 25;
/// pts = base * (10 + min(combo, 40)) / 10
pub const COMBO_CAP: u32 = 40;
/// pts = pts * (1 + min(chain, 5)) / 2
pub const CHAIN_CAP: u32 = 5;
pub const BOSS_MULT: u32 = 3;
/// 1 in SHINY_ONE_IN Beasts is shiny (`rnd(T_SHINY, i) % SHINY_ONE_IN == 0`); score x SHINY_MULT.
pub const SHINY_ONE_IN: u128 = 12;
pub const SHINY_MULT: u32 = 3;
/// caught_mask / shiny_mask are u128, so a roster holds at most this many entries.
pub const MAX_ROSTER: u32 = 128;
/// Early-kill bonus `pts += (escape_tick - T) / KILL_LIFE_DIV`.
pub const KILL_LIFE_DIV: u32 = 2;

// §8 / §9 / §10 indices
pub const NO_INDEX: u32 = 255;
pub const MISS_INDEX: u32 = 63;
pub const OVERKILL_INDEX: u32 = 62;

// §9 digest event kinds
pub const EV_STRIKE: felt252 = 1;
pub const EV_ESCAPE: felt252 = 2;
pub const EV_KILL: felt252 = 3;
pub const EV_JAM: felt252 = 4;

// §11 affixes that change the replay
pub const PREFIX_DUSK: u32 = 23;
pub const PREFIX_GALE: u32 = 28;
pub const PREFIX_GLOOM: u32 = 30;
pub const PREFIX_STORM: u32 = 59;
pub const PREFIX_TEMPEST: u32 = 60;
pub const SUFFIX_BANE: u32 = 1;
pub const SUFFIX_SHADOW: u32 = 10;
pub const SUFFIX_PEAK: u32 = 15;
pub const N_PREFIXES: u128 = 69;
pub const N_SUFFIXES: u128 = 18;

// Contract-level constants (not part of the sim)
pub const SECONDS_PER_DAY: u64 = 86400;
/// Submissions are accepted until `expires_at + ROOT_GRACE_SECS`.
pub const ROOT_GRACE_SECS: u64 = 3600;
pub const BOARD_SIZE: u32 = 20;
pub const DEFAULT_HEALTH: u16 = 100;
pub const MAX_W: u8 = 64;
pub const MAX_H: u8 = 56;
/// Domain tag of the player-signed message: 'STATIC' as a Cairo short string (0x535441544943).
pub const MSG_TAG: felt252 = 'STATIC';
/// SRC5 interface id of SRC5 itself.
pub const ISRC5_ID: felt252 = 0x3f918d17e5ee77373b56385708f855659a07f75997f365cf87748628532a055;
/// Beasts kill-verifier interface id: `registry.set_kill_verifier(species, V, true)` requires
/// `V.supports_interface(IKILL_VERIFIER_ID)`.
pub const IKILL_VERIFIER_ID: felt252 =
    0x313dda122083d96f86bf4716425c92976808ec1efc8a3bdf240e163e73118ca;
