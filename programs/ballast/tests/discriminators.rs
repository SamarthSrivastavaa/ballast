//! The discriminators `introspect.rs` hard-codes must equal the vendored IDLs' (and
//! `sha256("global:<name>")[..8]`), so a typo cannot silently disable a D-011 check.

use ballast::introspect::disc;
use std::path::PathBuf;

fn idl(file: &str) -> serde_json::Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../crates/meteora-types/idl")
        .join(file);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn disc_of(idl: &serde_json::Value, name: &str) -> [u8; 8] {
    let ix = idl["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == name)
        .unwrap_or_else(|| panic!("{name} not in IDL"));
    let v: Vec<u8> = ix["discriminator"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect();
    v.try_into().unwrap()
}

#[test]
fn dbc_discriminators_match_the_vendored_idl() {
    let i = idl("dynamic_bonding_curve.json");
    assert_eq!(
        disc::DBC_INIT_POOL_SPL,
        disc_of(&i, "initialize_virtual_pool_with_spl_token")
    );
    assert_eq!(
        disc::DBC_INIT_POOL_TOKEN2022,
        disc_of(&i, "initialize_virtual_pool_with_token2022")
    );
    assert_eq!(
        disc::DBC_CREATE_POOL_METADATA,
        disc_of(&i, "create_virtual_pool_metadata")
    );
    assert_eq!(disc::DBC_SWAP, disc_of(&i, "swap"));
    assert_eq!(disc::DBC_SWAP2, disc_of(&i, "swap2"));
    assert_eq!(
        disc::DBC_TRANSFER_POOL_CREATOR,
        disc_of(&i, "transfer_pool_creator")
    );
}

#[test]
fn dlmm_discriminators_match_the_vendored_idl() {
    let i = idl("lb_clmm.json");
    assert_eq!(
        disc::DLMM_INIT_CUSTOMIZABLE_PAIR,
        disc_of(&i, "initialize_customizable_permissionless_lb_pair")
    );
    assert_eq!(
        disc::DLMM_INIT_CUSTOMIZABLE_PAIR2,
        disc_of(&i, "initialize_customizable_permissionless_lb_pair2")
    );
}
