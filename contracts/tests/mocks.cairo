//! Minimal stand-ins for the Beasts registry and NFT, mirroring the behaviour STATIC relies on:
//! - `set_kill_verifier(species, V, true)` requires `V.supports_interface(IKILL_VERIFIER_ID)`
//!   ('Registry: bad kill verifier'),
//! - `add_kill(token, V, adventurer_id)` does not check its caller, reverts with 'Genesis has no
//!   kills' / 'Not a kill verifier' / 'Kill already credited', and calls back
//!   `V.verify_beast_kill(adventurer_id, species, prefix, suffix)` with the token's species and
//!   affixes, requiring `true` ('Kill not verified').

use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockRegistry<TState> {
    fn set_definition(ref self: TState, species_id: u32, beast_type: u8, tier: u8);
    fn set_kill_verifier(
        ref self: TState, species_id: u32, verifier: ContractAddress, trusted: bool,
    );
}

#[starknet::interface]
pub trait IMockBeasts<TState> {
    fn set_token(ref self: TState, token_id: felt252, species_id: u32);
    fn set_affixes(ref self: TState, token_id: felt252, prefix: u8, suffix: u8);
    fn set_genesis(ref self: TState, species_id: u32, token_id: felt252);
    /// Makes every `add_kill` revert (an unforeseen failure in the NFT).
    fn set_fail(ref self: TState, fail: bool);
    fn kill_count(self: @TState, token_id: felt252) -> u64;
}

#[starknet::contract]
pub mod MockRegistry {
    use starknet::ContractAddress;
    use starknet::storage::{Map, StorageMapReadAccess, StorageMapWriteAccess};
    use static_game::constants::IKILL_VERIFIER_ID;
    use static_game::interfaces::{
        BeastDefinition, IBeastRegistry, ISRC5Dispatcher, ISRC5DispatcherTrait,
    };

    #[storage]
    struct Storage {
        types: Map<u32, u8>,
        tiers: Map<u32, u8>,
        verifiers: Map<(u32, ContractAddress), bool>,
    }

    #[abi(embed_v0)]
    impl AdminImpl of super::IMockRegistry<ContractState> {
        fn set_definition(ref self: ContractState, species_id: u32, beast_type: u8, tier: u8) {
            self.types.write(species_id, beast_type);
            self.tiers.write(species_id, tier);
        }

        fn set_kill_verifier(
            ref self: ContractState, species_id: u32, verifier: ContractAddress, trusted: bool,
        ) {
            if trusted {
                let src5 = ISRC5Dispatcher { contract_address: verifier };
                assert(src5.supports_interface(IKILL_VERIFIER_ID), 'Registry: bad kill verifier');
            }
            self.verifiers.write((species_id, verifier), trusted);
        }
    }

    #[abi(embed_v0)]
    impl RegistryImpl of IBeastRegistry<ContractState> {
        fn get_definition(self: @ContractState, species_id: u32) -> BeastDefinition {
            let zero: ContractAddress = 0.try_into().unwrap();
            BeastDefinition {
                name: 'mock',
                beast_type: self.types.read(species_id),
                tier: self.tiers.read(species_id),
                minter: zero,
                sound_manager: zero,
                species_owner: zero,
                art_provider: zero,
                stats_source: zero,
                factory_provider: false,
                art_locked: false,
                minter_locked: false,
            }
        }

        fn is_kill_verifier(
            self: @ContractState, species_id: u32, verifier: ContractAddress,
        ) -> bool {
            self.verifiers.read((species_id, verifier))
        }
    }
}

#[starknet::contract]
pub mod MockBeasts {
    use starknet::ContractAddress;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use static_game::interfaces::{
        BeastLiveStats, CardCondition, IBeastRegistryDispatcher, IBeastRegistryDispatcherTrait,
        IBeasts, IKillVerifierDispatcher, IKillVerifierDispatcherTrait, PackableBeast,
    };

    #[storage]
    struct Storage {
        registry: ContractAddress,
        token_species: Map<felt252, u32>,
        prefix: Map<felt252, u8>,
        suffix: Map<felt252, u8>,
        genesis: Map<u32, felt252>,
        kills: Map<felt252, u64>,
        credited: Map<(ContractAddress, felt252, u32), bool>,
        fail: bool,
    }

    #[constructor]
    fn constructor(ref self: ContractState, registry: ContractAddress) {
        self.registry.write(registry);
    }

    #[abi(embed_v0)]
    impl AdminImpl of super::IMockBeasts<ContractState> {
        fn set_token(ref self: ContractState, token_id: felt252, species_id: u32) {
            self.token_species.write(token_id, species_id);
        }

        fn set_affixes(ref self: ContractState, token_id: felt252, prefix: u8, suffix: u8) {
            self.prefix.write(token_id, prefix);
            self.suffix.write(token_id, suffix);
        }

        fn set_genesis(ref self: ContractState, species_id: u32, token_id: felt252) {
            self.genesis.write(species_id, token_id);
            self.token_species.write(token_id, species_id);
        }

        fn set_fail(ref self: ContractState, fail: bool) {
            self.fail.write(fail);
        }

        fn kill_count(self: @ContractState, token_id: felt252) -> u64 {
            self.kills.read(token_id)
        }
    }

    #[abi(embed_v0)]
    impl BeastsImpl of IBeasts<ContractState> {
        fn add_kill(
            ref self: ContractState,
            token_id: felt252,
            verifier: ContractAddress,
            adventurer_id: felt252,
        ) {
            assert(!self.fail.read(), 'mock add_kill failure');
            let species = self.token_species.read(token_id);
            assert(self.genesis.read(species) != token_id, 'Genesis has no kills');
            let registry = IBeastRegistryDispatcher { contract_address: self.registry.read() };
            assert(registry.is_kill_verifier(species, verifier), 'Not a kill verifier');
            assert(
                !self.credited.read((verifier, adventurer_id, species)), 'Kill already credited',
            );
            let v = IKillVerifierDispatcher { contract_address: verifier };
            let ok = v
                .verify_beast_kill(
                    adventurer_id, species, self.prefix.read(token_id), self.suffix.read(token_id),
                );
            assert(ok, 'Kill not verified');
            self.credited.write((verifier, adventurer_id, species), true);
            self.kills.write(token_id, self.kills.read(token_id) + 1);
        }

        fn is_kill_credited(
            self: @ContractState,
            verifier: ContractAddress,
            adventurer_id: felt252,
            species_id: u32,
        ) -> bool {
            self.credited.read((verifier, adventurer_id, species_id))
        }

        fn get_genesis_token_id(self: @ContractState, species_id: u32) -> felt252 {
            self.genesis.read(species_id)
        }

        fn get_beast(self: @ContractState, token_id: felt252) -> PackableBeast {
            PackableBeast {
                species_id: self.token_species.read(token_id),
                prefix: self.prefix.read(token_id),
                suffix: self.suffix.read(token_id),
                level: 1,
                health: 100,
                visual_effects: 0,
                sound_effects: 0,
                tier: 0,
                beast_type: 0,
                minted_at_block_number: 0,
                transfer_damage_chance: 0,
                transfer_lock_hours: 0,
                minted_at_minute: 0,
                minter_data: 0,
                condition: CardCondition {
                    centering_x_bps: 0,
                    centering_x_direction: 0,
                    centering_y_bps: 0,
                    centering_y_direction: 0,
                    hickey_count: 0,
                    hickeys_in_art: 0,
                    void_level: 0,
                    voids_in_art: 0,
                    roller_level: 0,
                    rollers_in_art: 0,
                    edge_chip_level: 0,
                    corner_chip_level: 0,
                },
            }
        }

        fn get_beast_stats(self: @ContractState, entity_hash: felt252) -> BeastLiveStats {
            BeastLiveStats { adventurers_killed: 0, last_killed_by: 0, last_killed_timestamp: 0 }
        }
    }
}
