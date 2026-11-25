//! STATIC Broadcast verifier.
//!
//! An operator (relayer) commits a Merkle root of run seeds; after a player plays tape `k`, the
//! relayer submits the player's signed strike log with the revealed seed and proof. The contract
//! re-simulates the run (SPEC.md v3) and records the verified score, the daily board, species
//! notoriety, the player's onchain Bestiary (dex) and, when the Beasts registry trusts this
//! contract, a kill on the Beast NFT.
//!
//! It is a Beasts kill verifier: SRC5 `supports_interface` reports the kill-verifier interface
//! (the registry checks it in `set_kill_verifier`) and `verify_beast_kill` answers the NFT's
//! callback from `add_kill`.

#[starknet::contract]
pub mod StaticGame {
    use core::ecdsa::check_ecdsa_signature;
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use openzeppelin_merkle_tree::merkle_proof::verify_poseidon;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePathEntry,
        StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
    use crate::constants::{
        BOARD_SIZE, DEFAULT_HEALTH, IKILL_VERIFIER_ID, ISRC5_ID, MAX_H, MAX_ROSTER, MAX_STRIKES,
        MAX_W, MSG_TAG, NO_INDEX, N_SPAWNS, ROOT_GRACE_SECS, SECONDS_PER_DAY,
    };
    use crate::interfaces::{
        BoardEntry, DexUpdated, IBeastRegistryDispatcher, IBeastRegistryDispatcherTrait,
        IBeastRegistrySafeDispatcher, IBeastRegistrySafeDispatcherTrait, IBeastsDispatcher,
        IBeastsDispatcherTrait, IBeastsSafeDispatcher, IBeastsSafeDispatcherTrait, IKillVerifier,
        ISRC5, IStaticGame, RootInfo, RosterInput, RosterView, RunRecord,
    };
    use crate::sim::{
        RosterEntry, RunResult, Spawn, aggr_from_kills, build_spawn, check_roster_shape,
        pick_roster_idx, popcount, replay_spawns,
    };

    // Packed roster info (u128): type | tier << 8 | health << 16 | aggr << 32 | species << 40.
    // `roster_info` stores it with aggr = 0; the per-root `snapshot` fills aggr in.
    const SH8: u128 = 0x100;
    const SH16: u128 = 0x10000;
    const SH32: u128 = 0x100000000;
    const SH40: u128 = 0x10000000000;
    // Packed geometry (u128): occ | w << 64 | h << 72.
    const SH64: u128 = 0x10000000000000000;
    const SH72: u128 = 0x1000000000000000000;

    #[storage]
    struct Storage {
        owner: ContractAddress,
        relayers: Map<ContractAddress, bool>,
        beasts_registry: ContractAddress,
        beasts_nft: ContractAddress,
        /// Current roster version (0 = none yet). Each `set_roster` starts a new version, so
        /// roots posted earlier keep replaying against the roster they were posted with.
        roster_version: u32,
        roster_len: Map<u32, u32>,
        roster_n_featured: Map<u32, u32>,
        roster_info: Map<(u32, u32), u128>,
        roster_geom: Map<(u32, u32), u128>,
        /// species_id -> Beasts NFT token credited when that species kills a player.
        kill_token: Map<u32, felt252>,
        roster_base_kills: Map<(u32, u32), u32>,
        roots: Map<u32, RootInfo>,
        root_count: u32,
        /// (root_id, roster_idx) -> packed type/tier/health/aggr/species frozen at post time.
        snapshot: Map<(u32, u32), u128>,
        used: Map<(u32, u32), bool>,
        runs: Map<u64, RunRecord>,
        run_count: u64,
        best: Map<felt252, u32>,
        board: Map<(u32, u32), BoardEntry>,
        board_len: Map<u32, u32>,
        /// (day, player_pub) -> best score that day + 1 (0 = no run that day).
        day_best: Map<(u32, felt252), u32>,
        notoriety: Map<u32, u32>,
        /// Bestiary, per guest key: bit `roster_idx` of the roster snapshot of the root the run
        /// was played on (all-time OR). Only meaningful against that roster version's species.
        dex: Map<felt252, u128>,
        dex_shiny: Map<felt252, u128>,
        /// Total Beasts caught (sum of `kills` over the player's verified runs).
        dex_catches: Map<felt252, u32>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        RosterSet: RosterSet,
        RelayerSet: RelayerSet,
        KillTokenSet: KillTokenSet,
        OwnershipTransferred: OwnershipTransferred,
        TapeRootPosted: TapeRootPosted,
        RunVerified: RunVerified,
        BeastKill: BeastKill,
        BoardUpdated: BoardUpdated,
        DexUpdated: DexUpdated,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RosterSet {
        #[key]
        pub version: u32,
        pub len: u32,
        pub n_featured: u32,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RelayerSet {
        #[key]
        pub addr: ContractAddress,
        pub allowed: bool,
    }

    #[derive(Drop, starknet::Event)]
    pub struct KillTokenSet {
        #[key]
        pub species_id: u32,
        pub token_id: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OwnershipTransferred {
        pub previous: ContractAddress,
        pub new_owner: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct TapeRootPosted {
        #[key]
        pub root_id: u32,
        pub root: felt252,
        pub n: u32,
        pub expires_at: u64,
        pub day: u32,
        pub roster_version: u32,
    }

    #[derive(Drop, starknet::Event)]
    pub struct RunVerified {
        #[key]
        pub run_id: u64,
        #[key]
        pub player_pub: felt252,
        pub root_id: u32,
        pub k: u32,
        pub score: u32,
        pub kills: u32,
        pub dead: bool,
        pub killer_species: u32,
        pub digest: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct BeastKill {
        #[key]
        pub run_id: u64,
        #[key]
        pub species_id: u32,
        pub kill_token: felt252,
        pub credited: bool,
    }

    #[derive(Drop, starknet::Event)]
    pub struct BoardUpdated {
        #[key]
        pub day: u32,
        pub rank: u32,
        pub player_pub: felt252,
        pub score: u32,
        pub run_id: u64,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        beasts_registry: ContractAddress,
        beasts_nft: ContractAddress,
    ) {
        assert(owner.is_non_zero(), 'zero owner');
        self.owner.write(owner);
        self.beasts_registry.write(beasts_registry);
        self.beasts_nft.write(beasts_nft);
    }

    #[abi(embed_v0)]
    impl StaticGameImpl of IStaticGame<ContractState> {
        // ------------------------------------------------------------------ owner

        fn set_roster(
            ref self: ContractState, entries: Array<RosterInput>, n_featured: u32,
        ) -> u32 {
            self.assert_owner();
            let len = entries.len();
            check_roster_shape(len, n_featured);
            let version = self.roster_version.read() + 1;
            self.roster_version.write(version);
            self.append_entries(version, 0, entries.span());
            self.roster_len.write(version, len);
            self.roster_n_featured.write(version, n_featured);
            self.emit(RosterSet { version, len, n_featured });
            version
        }

        fn extend_roster(ref self: ContractState, entries: Array<RosterInput>) {
            self.assert_owner();
            let version = self.roster_version.read();
            assert(version != 0, 'no roster');
            let start = self.roster_len.read(version);
            self.append_entries(version, start, entries.span());
            let len = start + entries.len();
            assert(len <= MAX_ROSTER, 'roster too long');
            self.roster_len.write(version, len);
            self.emit(RosterSet { version, len, n_featured: self.roster_n_featured.read(version) });
        }

        fn set_relayer(ref self: ContractState, addr: ContractAddress, allowed: bool) {
            self.assert_owner();
            self.relayers.write(addr, allowed);
            self.emit(RelayerSet { addr, allowed });
        }

        fn set_kill_token(ref self: ContractState, roster_idx: u32, token_id: felt252) {
            self.assert_owner();
            let version = self.roster_version.read();
            assert(roster_idx < self.roster_len.read(version), 'bad roster idx');
            let info = self.roster_info.read((version, roster_idx));
            let species_id: u32 = (info / SH40).try_into().unwrap();
            if token_id != 0 {
                self.check_kill_token(species_id, token_id);
            }
            self.kill_token.write(species_id, token_id);
            self.emit(KillTokenSet { species_id, token_id });
        }

        fn set_beasts(ref self: ContractState, registry: ContractAddress, nft: ContractAddress) {
            self.assert_owner();
            self.beasts_registry.write(registry);
            self.beasts_nft.write(nft);
        }

        fn transfer_ownership(ref self: ContractState, new_owner: ContractAddress) {
            self.assert_owner();
            assert(new_owner.is_non_zero(), 'zero owner');
            let previous = self.owner.read();
            self.owner.write(new_owner);
            self.emit(OwnershipTransferred { previous, new_owner });
        }

        // ------------------------------------------------------------------ relayer

        fn post_tape_root(ref self: ContractState, root: felt252, n: u32, expires_at: u64) -> u32 {
            self.assert_relayer();
            assert(root != 0, 'zero root');
            assert(n > 0, 'zero n');
            let now = get_block_timestamp();
            assert(expires_at > now, 'bad expiry');
            let version = self.roster_version.read();
            assert(version != 0, 'no roster');
            let len = self.roster_len.read(version);
            let n_featured = self.roster_n_featured.read(version);
            check_roster_shape(len, n_featured);

            let root_id = self.root_count.read() + 1;
            self.root_count.write(root_id);
            for idx in 0..len {
                let info = self.roster_info.read((version, idx));
                let species: u32 = (info / SH40).try_into().unwrap();
                let k = self.roster_base_kills.read((version, idx)) + self.notoriety.read(species);
                let aggr: u128 = aggr_from_kills(k).into();
                self.snapshot.write((root_id, idx), info + aggr * SH32);
            }
            let day: u32 = (now / SECONDS_PER_DAY).try_into().unwrap();
            self
                .roots
                .write(
                    root_id,
                    RootInfo {
                        root,
                        n,
                        posted_at: now,
                        expires_at,
                        day,
                        roster_version: version,
                        roster_len: len,
                        n_featured,
                    },
                );
            self
                .emit(
                    TapeRootPosted { root_id, root, n, expires_at, day, roster_version: version },
                );
            root_id
        }

        fn submit_broadcast(
            ref self: ContractState,
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
        ) -> u64 {
            self.assert_relayer();
            assert(strikes.len() <= MAX_STRIKES, 'too many strikes');

            // 1. Root, expiry, tape index, single use.
            let info = self.roots.read(root_id);
            assert(info.root != 0, 'unknown root');
            let now = get_block_timestamp();
            assert(now <= info.expires_at + ROOT_GRACE_SECS, 'root expired');
            assert(k == tape_index_of(player_pub, nonce, info.n), 'bad k');
            assert(!self.used.read((root_id, k)), 'tape used');
            self.used.write((root_id, k), true);

            // 2. Merkle proof of (k, seed).
            assert(verify_poseidon(proof, info.root, leaf_of(k, seed)), 'bad proof');

            // 3. Player signature over the strike log.
            let msg = message_of(root_id, k, nonce, callsign, strikes);
            assert(check_ecdsa_signature(msg, player_pub, sig_r, sig_s), 'bad signature');

            // 4. Replay.
            let res = replay_spawns(self.load_spawns(root_id, info, seed).span(), strikes);

            // 5. Record. A Beast killed the player only when its escape took the last life; a
            // jam death (killer 255) has no killer species.
            let run_id = self.run_count.read() + 1;
            self.run_count.write(run_id);
            let beast_kill = res.dead && res.killer != NO_INDEX;
            let killer_species = if beast_kill {
                self.species_of(root_id, res.killer_roster)
            } else {
                0
            };
            self
                .runs
                .write(
                    run_id,
                    RunRecord {
                        player_pub,
                        callsign,
                        root_id,
                        k,
                        seed,
                        day: info.day,
                        submitted_at: now,
                        n_strikes: strikes.len(),
                        score: res.score,
                        kills: res.kills,
                        lives: res.lives,
                        best_combo: res.best_combo,
                        dead: res.dead,
                        death_tick: res.death_tick,
                        killer: res.killer,
                        killer_roster: res.killer_roster,
                        killer_species,
                        caught_mask: res.caught_mask,
                        digest: res.digest,
                    },
                );
            if res.score > self.best.read(player_pub) {
                self.best.write(player_pub, res.score);
            }
            self.update_board(info.day, player_pub, res.score, run_id, callsign);

            self
                .emit(
                    RunVerified {
                        run_id,
                        player_pub,
                        root_id,
                        k,
                        score: res.score,
                        kills: res.kills,
                        dead: res.dead,
                        killer_species,
                        digest: res.digest,
                    },
                );

            // 5b. Bestiary: OR the run's masks into the player's dex (bits are never cleared).
            self.update_dex(run_id, player_pub, res.caught_mask, res.shiny_mask, res.kills);

            // 6. Notoriety and the Beast NFT kill credit (the run is stored first: `add_kill`
            // calls back into `verify_beast_kill`).
            if beast_kill {
                self.notoriety.write(killer_species, self.notoriety.read(killer_species) + 1);
                let kill_token = self.kill_token.read(killer_species);
                let credited = self.try_credit_kill(killer_species, kill_token, run_id);
                self.emit(BeastKill { run_id, species_id: killer_species, kill_token, credited });
            }
            run_id
        }

        // ------------------------------------------------------------------ views

        fn simulate(
            self: @ContractState, root_id: u32, seed: felt252, strikes: Span<u32>,
        ) -> RunResult {
            let info = self.roots.read(root_id);
            assert(info.root != 0, 'unknown root');
            replay_spawns(self.load_spawns(root_id, info, seed).span(), strikes)
        }

        fn get_run(self: @ContractState, run_id: u64) -> RunRecord {
            self.runs.read(run_id)
        }

        fn run_count(self: @ContractState) -> u64 {
            self.run_count.read()
        }

        fn top(self: @ContractState, day: u32) -> Array<(felt252, u32, u64, felt252)> {
            let mut out = array![];
            for rank in 0..self.board_len.read(day) {
                let e = self.board.read((day, rank));
                out.append((e.player_pub, e.score, e.run_id, e.callsign));
            }
            out
        }

        fn best(self: @ContractState, player_pub: felt252) -> u32 {
            self.best.read(player_pub)
        }

        fn notoriety(self: @ContractState, species_id: u32) -> u32 {
            self.notoriety.read(species_id)
        }

        fn get_root(self: @ContractState, root_id: u32) -> RootInfo {
            self.roots.read(root_id)
        }

        fn root_count(self: @ContractState) -> u32 {
            self.root_count.read()
        }

        fn roster_len(self: @ContractState) -> u32 {
            self.roster_len.read(self.roster_version.read())
        }

        fn n_featured(self: @ContractState) -> u32 {
            self.roster_n_featured.read(self.roster_version.read())
        }

        fn roster_version(self: @ContractState) -> u32 {
            self.roster_version.read()
        }

        fn get_roster_entry(self: @ContractState, idx: u32) -> RosterView {
            let version = self.roster_version.read();
            assert(idx < self.roster_len.read(version), 'bad roster idx');
            let info = self.roster_info.read((version, idx));
            let (beast_type, tier, health, _aggr, species_id) = unpack_info(info);
            let (w, h, occ) = unpack_geom(self.roster_geom.read((version, idx)));
            RosterView {
                species_id,
                beast_type,
                tier,
                health,
                w,
                h,
                occ,
                kill_token: self.kill_token.read(species_id),
                base_kills: self.roster_base_kills.read((version, idx)),
            }
        }

        fn get_root_roster(self: @ContractState, root_id: u32) -> Array<(u32, RosterEntry)> {
            let info = self.roots.read(root_id);
            assert(info.root != 0, 'unknown root');
            let mut out = array![];
            for idx in 0..info.roster_len {
                let species = self.species_of(root_id, idx);
                out.append((species, self.entry_at(root_id, info.roster_version, idx)));
            }
            out
        }

        fn tape_index(
            self: @ContractState, root_id: u32, player_pub: felt252, nonce: felt252,
        ) -> u32 {
            let info = self.roots.read(root_id);
            assert(info.root != 0, 'unknown root');
            tape_index_of(player_pub, nonce, info.n)
        }

        fn is_tape_used(self: @ContractState, root_id: u32, k: u32) -> bool {
            self.used.read((root_id, k))
        }

        fn is_used(self: @ContractState, root_id: u32, k: u32) -> bool {
            self.used.read((root_id, k))
        }

        fn get_snapshot(self: @ContractState, root_id: u32) -> Array<RosterEntry> {
            let info = self.roots.read(root_id);
            assert(info.root != 0, 'unknown root');
            let mut out = array![];
            for idx in 0..info.roster_len {
                out.append(self.entry_at(root_id, info.roster_version, idx));
            }
            out
        }

        fn root_n_featured(self: @ContractState, root_id: u32) -> u32 {
            let info = self.roots.read(root_id);
            assert(info.root != 0, 'unknown root');
            info.n_featured
        }

        fn latest_root(self: @ContractState) -> (u32, RootInfo) {
            let id = self.root_count.read();
            (id, self.roots.read(id))
        }

        fn get_dex(self: @ContractState, player_pub: felt252) -> (u128, u128, u32) {
            (
                self.dex.read(player_pub),
                self.dex_shiny.read(player_pub),
                self.dex_catches.read(player_pub),
            )
        }

        fn species_at(self: @ContractState, root_id: u32, idx: u32) -> u32 {
            let info = self.roots.read(root_id);
            assert(info.root != 0, 'unknown root');
            assert(idx < info.roster_len, 'bad roster idx');
            self.species_of(root_id, idx)
        }

        fn message_hash(
            self: @ContractState,
            root_id: u32,
            k: u32,
            nonce: felt252,
            callsign: felt252,
            strikes: Span<u32>,
        ) -> felt252 {
            message_of(root_id, k, nonce, callsign, strikes)
        }

        fn leaf_hash(self: @ContractState, k: u32, seed: felt252) -> felt252 {
            leaf_of(k, seed)
        }

        fn is_relayer(self: @ContractState, addr: ContractAddress) -> bool {
            self.relayers.read(addr)
        }

        fn owner(self: @ContractState) -> ContractAddress {
            self.owner.read()
        }

        fn beasts(self: @ContractState) -> (ContractAddress, ContractAddress) {
            (self.beasts_registry.read(), self.beasts_nft.read())
        }

        fn current_day(self: @ContractState) -> u32 {
            (get_block_timestamp() / SECONDS_PER_DAY).try_into().unwrap()
        }
    }

    // ---------------------------------------------------------------------- Beasts kill verifier

    #[abi(embed_v0)]
    impl SRC5Impl of ISRC5<ContractState> {
        fn supports_interface(self: @ContractState, interface_id: felt252) -> bool {
            interface_id == IKILL_VERIFIER_ID || interface_id == ISRC5_ID
        }
    }

    #[abi(embed_v0)]
    impl KillVerifierImpl of IKillVerifier<ContractState> {
        /// True only for a stored run (`adventurer_id` = run id) that a Beast of `species_id`
        /// ended (escape death, killer != 255), and only for the kill token mapped for that
        /// species: `prefix`/`suffix` (the credited token's, passed by the NFT) must equal its
        /// affixes. `add_kill` does not check its caller, so this is what stops anyone from
        /// crediting a STATIC run to another token of the species. Never reverts.
        #[feature("safe_dispatcher")]
        fn verify_beast_kill(
            self: @ContractState, adventurer_id: felt252, species_id: u32, prefix: u8, suffix: u8,
        ) -> bool {
            let run_id: u64 = match adventurer_id.try_into() {
                Option::Some(id) => id,
                Option::None => { return false; },
            };
            if run_id == 0 || run_id > self.run_count.read() {
                return false;
            }
            let run = self.runs.entry(run_id);
            if !run.dead.read() || run.killer.read() == NO_INDEX {
                return false;
            }
            if run.killer_species.read() != species_id {
                return false;
            }
            let token = self.kill_token.read(species_id);
            let nft_addr = self.beasts_nft.read();
            if token == 0 || nft_addr.is_zero() {
                return false;
            }
            let nft = IBeastsSafeDispatcher { contract_address: nft_addr };
            match nft.get_beast(token) {
                Result::Ok(beast) => beast.species_id == species_id
                    && beast.prefix == prefix
                    && beast.suffix == suffix,
                Result::Err(_) => false,
            }
        }
    }

    // ---------------------------------------------------------------------- hashing (documented)

    /// Tape index: `poseidon_hash_span([player_pub, nonce]) mod n` (as an integer).
    pub fn tape_index_of(player_pub: felt252, nonce: felt252, n: u32) -> u32 {
        let h: u256 = poseidon_hash_span(array![player_pub, nonce].span()).into();
        (h % n.into()).try_into().unwrap()
    }

    /// Merkle leaf: `poseidon_hash_span([k, seed])`. Internal nodes: OpenZeppelin
    /// `PoseidonCHasher` = `poseidon_hash_span([min(a, b), max(a, b)])` (integer order).
    pub fn leaf_of(k: u32, seed: felt252) -> felt252 {
        poseidon_hash_span(array![k.into(), seed].span())
    }

    /// Signed message: `poseidon_hash_span(['STATIC', root_id, k, nonce, callsign, ...strikes])`.
    pub fn message_of(
        root_id: u32, k: u32, nonce: felt252, callsign: felt252, strikes: Span<u32>,
    ) -> felt252 {
        let mut data: Array<felt252> = array![MSG_TAG, root_id.into(), k.into(), nonce, callsign];
        for s in strikes {
            data.append((*s).into());
        }
        poseidon_hash_span(data.span())
    }

    // ---------------------------------------------------------------------- packing

    fn pack_info(beast_type: u8, tier: u8, health: u16, aggr: u8, species: u32) -> u128 {
        beast_type.into()
            + tier.into() * SH8
            + health.into() * SH16
            + aggr.into() * SH32
            + species.into() * SH40
    }

    fn unpack_info(v: u128) -> (u8, u8, u16, u8, u32) {
        (
            (v % SH8).try_into().unwrap(),
            ((v / SH8) % SH8).try_into().unwrap(),
            ((v / SH16) % SH16).try_into().unwrap(),
            ((v / SH32) % SH8).try_into().unwrap(),
            (v / SH40).try_into().unwrap(),
        )
    }

    fn pack_geom(w: u8, h: u8, occ: u64) -> u128 {
        occ.into() + w.into() * SH64 + h.into() * SH72
    }

    fn unpack_geom(v: u128) -> (u8, u8, u64) {
        (
            ((v / SH64) % SH8).try_into().unwrap(),
            (v / SH72).try_into().unwrap(),
            (v % SH64).try_into().unwrap(),
        )
    }

    // ---------------------------------------------------------------------- internals

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn assert_owner(self: @ContractState) {
            assert(get_caller_address() == self.owner.read(), 'not owner');
        }

        fn assert_relayer(self: @ContractState) {
            assert(self.relayers.read(get_caller_address()), 'not relayer');
        }

        fn append_entries(
            ref self: ContractState, version: u32, start: u32, entries: Span<RosterInput>,
        ) {
            let registry = IBeastRegistryDispatcher {
                contract_address: self.beasts_registry.read(),
            };
            let mut idx = start;
            for e in entries {
                let e = *e;
                assert(e.w > 0 && e.w <= MAX_W, 'bad w');
                assert(e.h > 0 && e.h <= MAX_H, 'bad h');
                let def = registry.get_definition(e.species_id);
                assert(def.tier >= 1 && def.tier <= 5, 'bad tier');
                assert(def.beast_type <= 2, 'bad beast type');
                let health = if e.health == 0 {
                    DEFAULT_HEALTH
                } else {
                    e.health
                };
                self
                    .roster_info
                    .write(
                        (version, idx),
                        pack_info(def.beast_type, def.tier, health, 0, e.species_id),
                    );
                self.roster_geom.write((version, idx), pack_geom(e.w, e.h, e.occ));
                if e.kill_token != 0 {
                    self.check_kill_token(e.species_id, e.kill_token);
                    self.kill_token.write(e.species_id, e.kill_token);
                    self.emit(KillTokenSet { species_id: e.species_id, token_id: e.kill_token });
                }
                if e.base_kills != 0 {
                    self.roster_base_kills.write((version, idx), e.base_kills);
                }
                idx += 1;
            }
        }

        /// A kill token must be a non-genesis Beast of the roster species, otherwise `add_kill`
        /// could revert ('Genesis has no kills' / 'Not a kill verifier') and block submissions.
        fn check_kill_token(self: @ContractState, species_id: u32, token_id: felt252) {
            let nft = IBeastsDispatcher { contract_address: self.beasts_nft.read() };
            assert(nft.get_beast(token_id).species_id == species_id, 'token species mismatch');
            assert(nft.get_genesis_token_id(species_id) != token_id, 'genesis token');
        }

        fn entry_at(self: @ContractState, root_id: u32, version: u32, idx: u32) -> RosterEntry {
            let (beast_type, tier, health, aggr, _species) = unpack_info(
                self.snapshot.read((root_id, idx)),
            );
            let (w, h, occ) = unpack_geom(self.roster_geom.read((version, idx)));
            RosterEntry { beast_type, tier, health, aggr, w, h, occ }
        }

        fn species_of(self: @ContractState, root_id: u32, idx: u32) -> u32 {
            if idx == NO_INDEX {
                return 0;
            }
            (self.snapshot.read((root_id, idx)) / SH40).try_into().unwrap()
        }

        /// SPEC §5 schedule, loading only the roster entries that are actually drawn.
        fn load_spawns(
            self: @ContractState, root_id: u32, info: RootInfo, seed: felt252,
        ) -> Array<Spawn> {
            let n_featured = info.n_featured;
            let n_common = info.roster_len - n_featured;
            let mut spawns: Array<Spawn> = array![];
            for i in 0..N_SPAWNS {
                let idx = pick_roster_idx(seed, i, n_featured, n_common);
                let e = self.entry_at(root_id, info.roster_version, idx);
                spawns.append(build_spawn(seed, i, idx, n_featured, e));
            }
            spawns
        }

        /// Credits the kill on the Beast NFT; never reverts the submission. `add_kill` is only
        /// attempted when no known path can make it fail (the registry trusts this contract for
        /// the species, a token is mapped, it is not the genesis token, this run was not credited
        /// yet), and every call goes through a safe dispatcher, so an unforeseen panic in the
        /// Beasts contracts comes back as `Err` (Starknet >= 0.13.4) and the run still records.
        /// Returns whether the kill was credited.
        #[feature("safe_dispatcher")]
        fn try_credit_kill(
            ref self: ContractState, species_id: u32, kill_token: felt252, run_id: u64,
        ) -> bool {
            if kill_token == 0 {
                return false;
            }
            let registry_addr = self.beasts_registry.read();
            let nft_addr = self.beasts_nft.read();
            if registry_addr.is_zero() || nft_addr.is_zero() {
                return false;
            }
            let this = get_contract_address();
            let registry = IBeastRegistrySafeDispatcher { contract_address: registry_addr };
            let trusted = match registry.is_kill_verifier(species_id, this) {
                Result::Ok(v) => v,
                Result::Err(_) => false,
            };
            if !trusted {
                return false;
            }
            let nft = IBeastsSafeDispatcher { contract_address: nft_addr };
            let adventurer_id: felt252 = run_id.into();
            let credited = match nft.is_kill_credited(this, adventurer_id, species_id) {
                Result::Ok(v) => v,
                Result::Err(_) => true,
            };
            if credited {
                return false;
            }
            let genesis = match nft.get_genesis_token_id(species_id) {
                Result::Ok(v) => v,
                Result::Err(_) => kill_token,
            };
            if genesis == kill_token {
                return false;
            }
            nft.add_kill(kill_token, this, adventurer_id).is_ok()
        }

        /// Adds a run to the player's Bestiary. A bitmap is written only when the run sets a new
        /// bit, so a repeat-only run costs just the catches counter.
        fn update_dex(
            ref self: ContractState,
            run_id: u64,
            player_pub: felt252,
            caught_mask: u128,
            shiny_mask: u128,
            kills: u32,
        ) {
            let dex = self.dex.read(player_pub);
            let shiny = self.dex_shiny.read(player_pub);
            let (new_dex, new_shiny) = (dex | caught_mask, shiny | shiny_mask);
            if new_dex != dex {
                self.dex.write(player_pub, new_dex);
            }
            if new_shiny != shiny {
                self.dex_shiny.write(player_pub, new_shiny);
            }
            if kills != 0 {
                self.dex_catches.write(player_pub, self.dex_catches.read(player_pub) + kills);
            }
            let total_species = popcount(new_dex);
            self
                .emit(
                    DexUpdated {
                        run_id,
                        player_pub,
                        caught_mask,
                        shiny_mask,
                        new_species: total_species - popcount(dex),
                        total_species,
                    },
                );
        }

        /// Top BOARD_SIZE per day, one entry per player (their best), sorted by score desc;
        /// ties keep the earlier run first.
        fn update_board(
            ref self: ContractState,
            day: u32,
            player_pub: felt252,
            score: u32,
            run_id: u64,
            callsign: felt252,
        ) {
            let prev = self.day_best.read((day, player_pub));
            if prev != 0 && prev - 1 >= score {
                return;
            }
            self.day_best.write((day, player_pub), score + 1);

            let len = self.board_len.read(day);
            // Insertion rank: first entry with a strictly lower score.
            let mut pos = 0;
            while pos < len && self.board.entry((day, pos)).score.read() >= score {
                pos += 1;
            }
            if pos >= BOARD_SIZE {
                return;
            }
            // Existing entry of this player (it has a lower score, so it sits at or after pos).
            let mut old = len;
            if prev != 0 {
                let mut r = pos;
                while r < len {
                    if self.board.entry((day, r)).player_pub.read() == player_pub {
                        old = r;
                        break;
                    }
                    r += 1;
                }
            }
            // Shift [pos, end) down by one, overwriting the old entry or dropping the last one.
            let end = if old < len {
                old
            } else if len < BOARD_SIZE {
                len
            } else {
                BOARD_SIZE - 1
            };
            let mut r = end;
            while r > pos {
                let above = self.board.read((day, r - 1));
                self.board.write((day, r), above);
                r -= 1;
            }
            self.board.write((day, pos), BoardEntry { player_pub, score, run_id, callsign });
            if old == len && len < BOARD_SIZE {
                self.board_len.write(day, len + 1);
            }
            self.emit(BoardUpdated { day, rank: pos, player_pub, score, run_id });
        }
    }
}
