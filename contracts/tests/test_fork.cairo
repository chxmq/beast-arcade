//! Fork tests against the live Beasts contracts on Starknet Sepolia. They need network access,
//! so they are ignored by default: `snforge test test_fork --include-ignored`.

use starknet::ContractAddress;
use static_game::interfaces::{
    IBeastRegistryDispatcher, IBeastRegistryDispatcherTrait, IBeastsDispatcher,
    IBeastsDispatcherTrait,
};

fn registry() -> IBeastRegistryDispatcher {
    let addr: ContractAddress = 0x7f6883b4f901ce25aff2b10c876db8dfff68e61ba93102354816519e7fe1f
        .try_into()
        .unwrap();
    IBeastRegistryDispatcher { contract_address: addr }
}

fn nft() -> IBeastsDispatcher {
    let addr: ContractAddress = 0x2e2f3e29a04f92c2b4e8b91fa846d521aea2a682e490bdf46f18da6d0a8bbe1
        .try_into()
        .unwrap();
    IBeastsDispatcher { contract_address: addr }
}

#[test]
#[ignore]
#[fork(url: "https://api.zan.top/public/starknet-sepolia/rpc/v0_10", block_tag: latest)]
fn test_fork_registry_definition_10011() {
    let def = registry().get_definition(10011);
    assert_eq!(def.beast_type, 0);
    assert_eq!(def.tier, 3);
}

#[test]
#[ignore]
#[fork(url: "https://api.zan.top/public/starknet-sepolia/rpc/v0_10", block_tag: latest)]
fn test_fork_unknown_verifier_is_untrusted() {
    let me: ContractAddress = 'static-not-deployed'.try_into().unwrap();
    assert!(!registry().is_kill_verifier(10011, me));
    assert!(!nft().is_kill_credited(me, 1, 10011));
}

#[test]
#[ignore]
#[fork(url: "https://api.zan.top/public/starknet-sepolia/rpc/v0_10", block_tag: latest)]
fn test_fork_genesis_beast_layout() {
    // decodes PackableBeast (incl. CardCondition) from the live NFT
    let genesis = nft().get_genesis_token_id(10011);
    assert!(genesis != 0);
    let beast = nft().get_beast(genesis);
    assert_eq!(beast.species_id, 10011);
    assert_eq!(beast.tier, 3);
    assert_eq!(beast.beast_type, 0);
}
