//! The verifier's independent derivations against fixed points: the real Proof `PoolConfig` the
//! mainnet DBC binary stored (Q12), the compiler's Public class, and D-017's measured table.

use std::path::PathBuf;

use base64::Engine;
use bytemuck::Zeroable;
use meteora_types::dbc::PoolConfig;
use verifier_core::predict::{config_hash, lower_bound};

fn json(rel: &str) -> serde_json::Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn proof_config() -> PoolConfig {
    let acct = json("evidence/p0/Q12/config-account.json");
    let data = base64::engine::general_purpose::STANDARD
        .decode(acct["dataBase64"].as_str().unwrap())
        .unwrap();
    *meteora_types::decode::<PoolConfig>(&data, &PoolConfig::DISCRIMINATOR).unwrap()
}

fn public_config() -> PoolConfig {
    let c = json("compiler/out/classes.json")["classes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "public")
        .unwrap()
        .clone();
    let num = |v: &serde_json::Value| -> u128 { v.as_str().unwrap().parse().unwrap() };
    let mut cfg = PoolConfig::zeroed();
    cfg.sqrt_start_price = num(&c["sqrtStartPrice"]);
    for (i, p) in c["curve"].as_array().unwrap().iter().enumerate() {
        cfg.curve[i].sqrt_price = num(&p["sqrtPrice"]);
        cfg.curve[i].liquidity = num(&p["liquidity"]);
    }
    cfg.migration_quote_threshold = num(&c["migrationQuoteThreshold"]) as u64;
    cfg.pre_migration_token_supply = num(&c["preMigrationTokenSupply"]) as u64;
    cfg.post_migration_token_supply = num(&c["postMigrationTokenSupply"]) as u64;
    cfg.migration_fee_percentage = 15;
    cfg
}

#[test]
fn proof_hash_over_the_real_config_equals_the_pin() {
    assert_eq!(
        config_hash(&proof_config()),
        ballast::CLASSES[0].config_hash
    );
}

#[test]
fn public_hash_equals_the_pin() {
    assert_eq!(
        config_hash(&public_config()),
        ballast::CLASSES[1].config_hash
    );
}

/// D-017's table: s at both band ends, bit for bit; the pinned prediction sits below both.
#[test]
fn band_ends_match_d017_and_the_pins_are_lower_bounds() {
    let (lo, band_lo, band_hi) = lower_bound(&proof_config()).unwrap();
    assert_eq!(band_lo, 47_811_433_357_069_708);
    assert_eq!(band_hi, 47_811_433_353_714_945);
    assert_eq!(lo, band_hi);
    assert!(ballast::CLASSES[0].predicted_s_open <= lo);

    let (lo, band_lo, band_hi) = lower_bound(&public_config()).unwrap();
    assert_eq!(band_lo, 75_596_513_433_716_731);
    assert_eq!(band_hi, 75_596_513_430_362_024);
    assert!(ballast::CLASSES[1].predicted_s_open <= lo);
}

/// Events are only taken from lines Ballast itself logs: a `Program data:` line under another
/// program (or after Ballast returned) is ignored.
#[test]
fn events_only_from_ballast_frames() {
    use anchor_lang::{AnchorSerialize, Discriminator};
    let launch = anchor_lang::prelude::Pubkey::new_unique();
    let ev = ballast::Deposited {
        launch,
        from: launch,
        amount: 5,
        s_new: 42,
    };
    let mut data = ballast::Deposited::DISCRIMINATOR.to_vec();
    ev.serialize(&mut data).unwrap();
    let line = format!(
        "Program data: {}",
        base64::engine::general_purpose::STANDARD.encode(&data)
    );
    let me = ballast::ID.to_string();
    let other = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
    let logs: Vec<String> = vec![
        format!("Program {me} invoke [1]"),
        format!("Program {other} invoke [2]"),
        line.clone(), // inside DLMM: ignored
        format!("Program {other} success"),
        line.clone(), // Ballast's own: counted
        format!("Program {me} success"),
        line, // after Ballast returned: ignored
    ];
    let got = verifier_core::events::parse(&logs, &ballast::ID, &launch);
    assert_eq!(
        got,
        vec![verifier_core::events::Event::Deposited {
            s_new: 42,
            amount: 5
        }]
    );
}
