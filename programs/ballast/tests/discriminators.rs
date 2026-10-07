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

/// `dbc_cpi` builds settle/burn CPIs by hand: discriminators, the constant pool authority and the
/// event-authority PDA must match the vendored IDL, or the CPI would hit the wrong instruction.
#[test]
fn dbc_cpi_constants_match_the_vendored_idl() {
    use anchor_lang::prelude::Pubkey;
    use ballast::dbc_cpi::{self, disc as d};
    let i = idl("dynamic_bonding_curve.json");
    assert_eq!(
        d::WITHDRAW_MIGRATION_FEE,
        disc_of(&i, "withdraw_migration_fee")
    );
    assert_eq!(d::CLAIM_TRADING_FEE, disc_of(&i, "claim_trading_fee"));
    assert_eq!(
        d::CLAIM_CREATOR_TRADING_FEE,
        disc_of(&i, "claim_creator_trading_fee")
    );
    assert_eq!(d::WITHDRAW_LEFTOVER, disc_of(&i, "withdraw_leftover"));
    assert_eq!(
        d::PARTNER_WITHDRAW_SURPLUS,
        disc_of(&i, "partner_withdraw_surplus")
    );

    let ix = i["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == "withdraw_leftover")
        .unwrap();
    let pool_authority = ix["accounts"][0]["address"].as_str().unwrap();
    assert_eq!(dbc_cpi::DBC_POOL_AUTHORITY.to_string(), pool_authority);

    let (event_authority, _) =
        Pubkey::find_program_address(&[b"__event_authority"], &ballast::DBC_PROGRAM_ID);
    assert_eq!(dbc_cpi::DBC_EVENT_AUTHORITY, event_authority);
}

/// Part 2 CPI builders (`dlmm.rs`, `damm.rs`) against the vendored IDLs.
#[test]
fn part2_cpi_discriminators_match_the_vendored_idls() {
    let l = idl("lb_clmm.json");
    assert_eq!(
        ballast::dlmm::disc::PLACE_LIMIT_ORDER,
        disc_of(&l, "place_limit_order")
    );
    assert_eq!(
        ballast::dlmm::disc::CANCEL_LIMIT_ORDER,
        disc_of(&l, "cancel_limit_order")
    );
    assert_eq!(
        ballast::dlmm::disc::CLOSE_LIMIT_ORDER_IF_EMPTY,
        disc_of(&l, "close_limit_order_if_empty")
    );
    let c = idl("cp_amm.json");
    assert_eq!(
        ballast::damm::CLAIM_POSITION_FEE,
        disc_of(&c, "claim_position_fee")
    );
}
