use core::poseidon::poseidon_hash_span;

/// SPEC §4: `rnd(seed, tag, i) = low128(poseidon_hash_span([seed, tag, i]))`.
pub fn rnd(seed: felt252, tag: felt252, i: u32) -> u128 {
    let h: u256 = poseidon_hash_span(array![seed, tag, i.into()].span()).into();
    h.low
}
