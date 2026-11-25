use starknet::ContractAddress;
use crate::sim::{RosterEntry, RunResult};

// ---------------------------------------------------------------------------------------------
// STATIC types
// ---------------------------------------------------------------------------------------------

/// Owner input for one roster slot. Featured entries come first (see SPEC §3).
/// `beast_type` and `tier` are not inputs: they are read from the Beasts registry.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct RosterInput {
    /// Beasts registry species id (e.g. 10011 for an Art Hackathon species, 1..75 originals).
    pub species_id: u32,
    /// Health stat (SPEC §5: `health >= 150` gives the Beast one extra hp). 0 means the default
    /// of 100.
    pub health: u16,
    /// Silhouette size in field pixels (1..=64 x 1..=56).
    pub w: u8,
    pub h: u8,
    /// 8x8 occupancy grid, bit `cy * 8 + cx`.
    pub occ: u64,
    /// Beasts NFT token id credited when this species kills a player. Stored per species;
    /// 0 leaves an existing mapping unchanged (clear it with `set_kill_token(idx, 0)`).
    pub kill_token: felt252,
    /// Off-chain "Adventurers Killed" count snapshot, added to STATIC notoriety for `aggr`.
    pub base_kills: u32,
}

/// Current-version roster slot as stored (view).
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct RosterView {
    pub species_id: u32,
    pub beast_type: u8,
    pub tier: u8,
    pub health: u16,
    pub w: u8,
    pub h: u8,
    pub occ: u64,
    pub kill_token: felt252,
    pub base_kills: u32,
}

#[derive(Copy, Drop, Serde, starknet::Store, PartialEq, Debug)]
pub struct RootInfo {
    /// Merkle root of the tape leaves `poseidon_hash_span([k, seed])` for k in 0..n.
    pub root: felt252,
    /// Number of tapes (leaves) under this root.
    pub n: u32,
    pub posted_at: u64,
    pub expires_at: u64,
    /// `posted_at / 86400`; the daily board this root's runs compete on.
    pub day: u32,
    /// Roster version, length and featured count frozen for this root.
    pub roster_version: u32,
    pub roster_len: u32,
    pub n_featured: u32,
}

#[derive(Copy, Drop, Serde, starknet::Store, PartialEq, Debug)]
pub struct RunRecord {
    pub player_pub: felt252,
    pub callsign: felt252,
    pub root_id: u32,
    pub k: u32,
    pub seed: felt252,
    pub day: u32,
    pub submitted_at: u64,
    pub n_strikes: u32,
    pub score: u32,
    pub kills: u32,
    /// Lives left (0 if dead).
    pub lives: u32,
    pub best_combo: u32,
    pub dead: bool,
    pub death_tick: u32,
    /// Spawn index of the Beast that took the last life (255 if survived or jammed to death).
    pub killer: u32,
    /// Roster index of that Beast (255 if none).
    pub killer_roster: u32,
    /// Registry species id of that Beast (0 if none).
    pub killer_species: u32,
    /// Bit `roster_idx` set for every roster entry with at least one Beast caught (SPEC §10).
    pub caught_mask: u128,
    pub digest: felt252,
}

/// Emitted by `submit_broadcast` right after `RunVerified`: the player's Bestiary (dex) after
/// the run. Bit `i` of the masks is the roster index `i` of the root's roster snapshot (see
/// `IStaticGame::species_at(root_id, i)` for the species id), so a bitmap is only meaningful
/// against the roster version it was recorded under; the roster is kept append-only.
#[derive(Drop, starknet::Event)]
pub struct DexUpdated {
    #[key]
    pub run_id: u64,
    #[key]
    pub player_pub: felt252,
    /// Roster indices caught in this run.
    pub caught_mask: u128,
    /// Roster indices caught as a shiny in this run.
    pub shiny_mask: u128,
    /// Bits of `caught_mask` that were not yet set in the player's dex (popcount).
    pub new_species: u32,
    /// Popcount of the player's dex after this run.
    pub total_species: u32,
}

#[derive(Copy, Drop, Serde, starknet::Store, PartialEq, Debug)]
pub struct BoardEntry {
    pub player_pub: felt252,
    pub score: u32,
    pub run_id: u64,
    pub callsign: felt252,
}

#[starknet::interface]
pub trait IStaticGame<TState> {
    // ----- owner -----
    /// Starts a new roster version. Reads type and tier of each species from the registry.
    fn set_roster(ref self: TState, entries: Array<RosterInput>, n_featured: u32) -> u32;
    /// Appends common entries to the current roster version (for rosters too big for one tx).
    fn extend_roster(ref self: TState, entries: Array<RosterInput>);
    fn set_relayer(ref self: TState, addr: ContractAddress, allowed: bool);
    /// Maps the species at `roster_idx` (current version) to a Beasts NFT token (0 = none).
    fn set_kill_token(ref self: TState, roster_idx: u32, token_id: felt252);
    fn set_beasts(ref self: TState, registry: ContractAddress, nft: ContractAddress);
    fn transfer_ownership(ref self: TState, new_owner: ContractAddress);

    // ----- relayer -----
    fn post_tape_root(ref self: TState, root: felt252, n: u32, expires_at: u64) -> u32;
    fn submit_broadcast(
        ref self: TState,
        root_id: u32,
        k: u32,
        nonce: felt252,
        seed: felt252,
        proof: Span<felt252>,
        player_pub: felt252,
        callsign: felt252,
        strikes: Span<u32>,
        sig_r: felt252,
        sig_s: felt252,
    ) -> u64;

    // ----- views -----
    fn simulate(self: @TState, root_id: u32, seed: felt252, strikes: Span<u32>) -> RunResult;
    fn get_run(self: @TState, run_id: u64) -> RunRecord;
    fn run_count(self: @TState) -> u64;
    fn top(self: @TState, day: u32) -> Array<(felt252, u32, u64, felt252)>;
    fn best(self: @TState, player_pub: felt252) -> u32;
    fn notoriety(self: @TState, species_id: u32) -> u32;
    fn get_root(self: @TState, root_id: u32) -> RootInfo;
    fn root_count(self: @TState) -> u32;
    fn roster_len(self: @TState) -> u32;
    fn n_featured(self: @TState) -> u32;
    fn roster_version(self: @TState) -> u32;
    fn get_roster_entry(self: @TState, idx: u32) -> RosterView;
    /// The exact roster the replay uses for `root_id`: (species_id, RosterEntry) per index.
    fn get_root_roster(self: @TState, root_id: u32) -> Array<(u32, RosterEntry)>;
    fn tape_index(self: @TState, root_id: u32, player_pub: felt252, nonce: felt252) -> u32;
    fn is_tape_used(self: @TState, root_id: u32, k: u32) -> bool;
    /// Alias of `is_tape_used`.
    fn is_used(self: @TState, root_id: u32, k: u32) -> bool;
    /// The full roster exactly as `replay` sees it for `root_id`, in roster index order
    /// (type/tier/health/aggr from the per-root snapshot, w/h/occ from the frozen roster version).
    /// Pair it with `root_n_featured(root_id)` (= `get_root(root_id).n_featured`).
    fn get_snapshot(self: @TState, root_id: u32) -> Array<RosterEntry>;
    /// n_featured frozen for `root_id` (the current-roster `n_featured()` may differ).
    fn root_n_featured(self: @TState, root_id: u32) -> u32;
    /// `(root_count, get_root(root_count))`; `(0, zeroed RootInfo)` before the first root.
    fn latest_root(self: @TState) -> (u32, RootInfo);
    /// The player's Bestiary: `(caught bitmap, shiny bitmap, total Beasts caught)`. Keyed by
    /// guest key (`player_pub`). Bit `i` is roster index `i` (all-time OR of the runs' masks);
    /// look the species up with `species_at(root_id, i)` for any root, or `get_root_roster`.
    fn get_dex(self: @TState, player_pub: felt252) -> (u128, u128, u32);
    /// Registry species id at roster index `idx` of `root_id`'s roster snapshot.
    fn species_at(self: @TState, root_id: u32, idx: u32) -> u32;
    fn message_hash(
        self: @TState, root_id: u32, k: u32, nonce: felt252, callsign: felt252, strikes: Span<u32>,
    ) -> felt252;
    fn leaf_hash(self: @TState, k: u32, seed: felt252) -> felt252;
    fn is_relayer(self: @TState, addr: ContractAddress) -> bool;
    fn owner(self: @TState) -> ContractAddress;
    fn beasts(self: @TState) -> (ContractAddress, ContractAddress);
    fn current_day(self: @TState) -> u32;
}

/// SRC5 introspection. The Beasts registry only trusts a kill verifier that reports
/// `supports_interface(IKILL_VERIFIER_ID) == true`.
#[starknet::interface]
pub trait ISRC5<TState> {
    fn supports_interface(self: @TState, interface_id: felt252) -> bool;
}

/// Beasts kill-verifier callback. `IBeasts.add_kill(token_id, verifier, adventurer_id)` calls
/// `verifier.verify_beast_kill(adventurer_id, species_id, prefix, suffix)` with the credited
/// token's species and affixes and requires `true`. For STATIC, `adventurer_id` is the run id.
#[starknet::interface]
pub trait IKillVerifier<TState> {
    fn verify_beast_kill(
        self: @TState, adventurer_id: felt252, species_id: u32, prefix: u8, suffix: u8,
    ) -> bool;
}

// ---------------------------------------------------------------------------------------------
// External Beasts contracts (Starknet Sepolia). Struct layouts copied from the deployed ABIs.
// ---------------------------------------------------------------------------------------------

/// `beasts_core::interfaces::BeastDefinition`
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct BeastDefinition {
    pub name: felt252,
    pub beast_type: u8,
    pub tier: u8,
    pub minter: ContractAddress,
    pub sound_manager: ContractAddress,
    pub species_owner: ContractAddress,
    pub art_provider: ContractAddress,
    pub stats_source: ContractAddress,
    pub factory_provider: bool,
    pub art_locked: bool,
    pub minter_locked: bool,
}

/// `beasts_core::interfaces::BeastLiveStats`
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct BeastLiveStats {
    pub adventurers_killed: u64,
    pub last_killed_by: u64,
    pub last_killed_timestamp: u64,
}

/// `beasts_core::pack::CardCondition`
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct CardCondition {
    pub centering_x_bps: u16,
    pub centering_x_direction: u8,
    pub centering_y_bps: u16,
    pub centering_y_direction: u8,
    pub hickey_count: u8,
    pub hickeys_in_art: u8,
    pub void_level: u8,
    pub voids_in_art: u8,
    pub roller_level: u8,
    pub rollers_in_art: u8,
    pub edge_chip_level: u8,
    pub corner_chip_level: u8,
}

/// `beasts_core::pack::PackableBeast`
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct PackableBeast {
    pub species_id: u32,
    pub prefix: u8,
    pub suffix: u8,
    pub level: u16,
    pub health: u16,
    pub visual_effects: u8,
    pub sound_effects: u8,
    pub tier: u8,
    pub beast_type: u8,
    pub minted_at_block_number: u64,
    pub transfer_damage_chance: u16,
    pub transfer_lock_hours: u64,
    pub minted_at_minute: u32,
    pub minter_data: u32,
    pub condition: CardCondition,
}

/// Subset of `beasts_core::interfaces::IBeastRegistry`
/// (Sepolia 0x7f6883b4f901ce25aff2b10c876db8dfff68e61ba93102354816519e7fe1f).
#[starknet::interface]
pub trait IBeastRegistry<TState> {
    fn get_definition(self: @TState, species_id: u32) -> BeastDefinition;
    fn is_kill_verifier(self: @TState, species_id: u32, verifier: ContractAddress) -> bool;
}

/// Subset of `beasts_core::interfaces::IBeasts` + `IBeastStats`
/// (Sepolia 0x2e2f3e29a04f92c2b4e8b91fa846d521aea2a682e490bdf46f18da6d0a8bbe1).
#[starknet::interface]
pub trait IBeasts<TState> {
    fn add_kill(
        ref self: TState, token_id: felt252, verifier: ContractAddress, adventurer_id: felt252,
    );
    fn is_kill_credited(
        self: @TState, verifier: ContractAddress, adventurer_id: felt252, species_id: u32,
    ) -> bool;
    fn get_genesis_token_id(self: @TState, species_id: u32) -> felt252;
    fn get_beast(self: @TState, token_id: felt252) -> PackableBeast;
    fn get_beast_stats(self: @TState, entity_hash: felt252) -> BeastLiveStats;
}
