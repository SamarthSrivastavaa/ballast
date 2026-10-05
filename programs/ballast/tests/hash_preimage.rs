//! §7 rule 3: the `config_hash` preimage layout, pinned across languages and against real bytes.
//!
//! The program's `config_hash_preimage` / `config_hash_of` run over the **raw** `PoolConfig` bytes
//! that the mainnet DBC binary stored in STEP 3 (Q12, `evidence/p0/Q12/config-account.json`),
//! decoded with the vendored `meteora-types` layout. The result must equal, byte for byte, what the
//! TypeScript compiler emits (`compiler/out/classes.json`) and what `CLASSES` pins. The Public size
//! (never created on-chain yet) is checked by building its `PoolConfig` from the compiler output.

use std::path::PathBuf;

fn repo(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel)
}

fn json(rel: &str) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(repo(rel)).unwrap()).unwrap()
}

fn b64(s: &str) -> Vec<u8> {
    let val = |c: u8| -> u32 {
        match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a' + 26) as u32,
            b'0'..=b'9' => (c - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            _ => panic!("bad base64"),
        }
    };
    let bytes: Vec<u8> = s.bytes().filter(|&c| c != b'=').collect();
    let mut out = Vec::new();
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= val(c) << (18 - 6 * i);
        }
        for i in 0..chunk.len() - 1 {
            out.push((n >> (16 - 8 * i)) as u8);
        }
    }
    out
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn class(name: &str) -> serde_json::Value {
    json("compiler/out/classes.json")["classes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap()
        .clone()
}

#[test]
fn proof_hash_over_the_real_on_chain_config_equals_compiler_and_pin() {
    let acct = json("evidence/p0/Q12/config-account.json");
    let data = b64(acct["dataBase64"].as_str().unwrap());
    let cfg = meteora_types::decode::<meteora_types::dbc::PoolConfig>(
        &data,
        &meteora_types::dbc::PoolConfig::DISCRIMINATOR,
    )
    .expect("decode the Q12 PoolConfig");

    let c = class("proof");
    let preimage = ballast::config_hash_preimage(cfg);
    assert_eq!(preimage.len(), 680);
    assert_eq!(
        hex(&preimage),
        c["preimageHex"].as_str().unwrap(),
        "preimage layout"
    );
    let h = ballast::config_hash_of(cfg);
    assert_eq!(
        hex(&h),
        c["configHash"].as_str().unwrap(),
        "hash vs compiler"
    );
    assert_eq!(h, ballast::CLASSES[0].config_hash, "hash vs pinned CLASSES");
    assert_eq!({ cfg.sqrt_start_price }, ballast::CLASSES[0].sqrt_start_price);
}

#[test]
fn public_hash_from_compiler_fields_equals_pin() {
    use bytemuck::Zeroable;
    let c = class("public");
    let num = |v: &serde_json::Value| -> u128 { v.as_str().unwrap().parse().unwrap() };
    let mut cfg = meteora_types::dbc::PoolConfig::zeroed();
    cfg.sqrt_start_price = num(&c["sqrtStartPrice"]);
    for (i, p) in c["curve"].as_array().unwrap().iter().enumerate() {
        cfg.curve[i].sqrt_price = num(&p["sqrtPrice"]);
        cfg.curve[i].liquidity = num(&p["liquidity"]);
    }
    cfg.migration_quote_threshold = num(&c["migrationQuoteThreshold"]) as u64;
    cfg.pre_migration_token_supply = num(&c["preMigrationTokenSupply"]) as u64;
    cfg.post_migration_token_supply = num(&c["postMigrationTokenSupply"]) as u64;
    let h = ballast::config_hash_of(&cfg);
    assert_eq!(
        hex(&ballast::config_hash_preimage(&cfg)),
        c["preimageHex"].as_str().unwrap()
    );
    assert_eq!(hex(&h), c["configHash"].as_str().unwrap());
    assert_eq!(h, ballast::CLASSES[1].config_hash);
}
