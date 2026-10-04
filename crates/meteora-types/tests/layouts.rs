//! Q12 (STEP 3): the vendored layouts against REAL accounts created by the mainnet-dumped Meteora
//! binaries on the local validator (D-001). Evidence is read from `evidence/p0/`, so this runs
//! offline and is rerunnable by anyone from a clean checkout.
//!
//! For each account: discriminator, exact size, and every field decoded by the vendored struct
//! equal to the SDK's decode of the same bytes (`sdk-decode.json`, camelCase paths).

use std::collections::BTreeMap;
use std::path::PathBuf;

pub trait Flatten {
    fn flatten(&self, path: &str, out: &mut Vec<(String, String)>);
}

pub fn bs58(bytes: &[u8; 32]) -> String {
    const A: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = Vec::new();
    for &b in bytes {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let zeros = bytes.iter().take_while(|&&b| b == 0).count();
    let mut s = "1".repeat(zeros);
    s.extend(digits.iter().rev().map(|&d| A[d as usize] as char));
    s
}

include!("support/generated_fields.rs");

fn evidence(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../evidence/p0")
        .join(rel)
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
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= val(c) << (18 - 6 * i);
        }
        let take = chunk.len() - 1;
        for i in 0..take {
            out.push((n >> (16 - 8 * i)) as u8);
        }
    }
    out
}

/// Flatten the SDK decode JSON into the same `a.b[i].c` paths the generated code emits.
fn flatten_json(v: &serde_json::Value, path: String, out: &mut BTreeMap<String, String>) {
    match v {
        serde_json::Value::Object(m) => {
            for (k, x) in m {
                let p = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                flatten_json(x, p, out);
            }
        }
        serde_json::Value::Array(a) => {
            for (i, x) in a.iter().enumerate() {
                flatten_json(x, format!("{path}[{i}]"), out);
            }
        }
        serde_json::Value::String(s) => {
            out.insert(path, s.clone());
        }
        serde_json::Value::Number(n) => {
            out.insert(path, n.to_string());
        }
        serde_json::Value::Bool(b) => {
            out.insert(path, (*b as u8).to_string());
        }
        serde_json::Value::Null => {}
    }
}

fn load(rel: &str) -> serde_json::Value {
    serde_json::from_str(&std::fs::read_to_string(evidence(rel)).unwrap()).unwrap()
}

/// Returns (fields compared, mismatches).
fn compare<T: bytemuck::Pod + Flatten>(
    account_json: &str,
    sdk_json: &str,
    disc: [u8; 8],
    size: usize,
) -> (usize, Vec<String>) {
    compare_values::<T>(&load(account_json), &load(sdk_json), "", disc, size)
}

/// Same, from already-loaded JSON; `prefix` is prepended to SDK paths (e.g. "poolState").
fn compare_values<T: bytemuck::Pod + Flatten>(
    acct: &serde_json::Value,
    sdk: &serde_json::Value,
    prefix: &str,
    disc: [u8; 8],
    size: usize,
) -> (usize, Vec<String>) {
    let account_json = acct["address"].as_str().unwrap_or("account");
    let data = b64(acct["dataBase64"].as_str().unwrap());
    assert_eq!(&data[..8], &disc, "{account_json}: discriminator");
    assert_eq!(
        data.len() - 8,
        size,
        "{account_json}: size (on-chain minus discriminator) vs vendored"
    );
    let decoded: &T = meteora_types::decode(&data, &disc).expect("decode");
    let mut ours = Vec::new();
    decoded.flatten("", &mut ours);
    let ours: BTreeMap<String, String> = ours.into_iter().collect();

    let mut theirs = BTreeMap::new();
    flatten_json(sdk, prefix.to_string(), &mut theirs);

    let mut bad = Vec::new();
    for (k, v) in &theirs {
        match ours.get(k) {
            Some(o) if o == v => {}
            Some(o) => bad.push(format!("{k}: vendored={o} sdk={v}")),
            None => bad.push(format!("{k}: missing from vendored decode")),
        }
    }
    (theirs.len(), bad)
}

#[test]
fn generator_offsets_equal_compiler_offsets() {
    dbc_fields::offsets_poolconfig();
    dbc_fields::offsets_virtualpool();
    damm_v2_fields::offsets_pool();
    damm_v2_fields::offsets_position();
    dlmm_fields::offsets_lbpair();
    dlmm_fields::offsets_limitorder();
}

#[test]
fn q12_pool_config_matches_sdk_decode() {
    use meteora_types::dbc::PoolConfig;
    let (n, bad) = compare::<PoolConfig>(
        "Q12/config-account.json",
        "Q12/sdk-decode.json",
        PoolConfig::DISCRIMINATOR,
        PoolConfig::SIZE,
    );
    assert!(
        bad.is_empty(),
        "{} of {} fields differ:\n{}",
        bad.len(),
        n,
        bad.join("\n")
    );
    assert!(n > 100, "compared only {n} fields");
    println!(
        "PoolConfig: {n} fields identical (vendored vs SDK), size {}, discriminator ok",
        PoolConfig::SIZE
    );
}

fn assert_matches(what: &str, (n, bad): (usize, Vec<String>)) {
    assert!(
        bad.is_empty(),
        "{what}: {} of {} fields differ:\n{}",
        bad.len(),
        n,
        bad.join("\n")
    );
    assert!(n > 20, "{what}: compared only {n} fields");
    println!("{what}: {n} fields identical (vendored vs SDK)");
}

#[test]
fn q12_virtual_pool_matches_sdk_decode() {
    use meteora_types::dbc::VirtualPool;
    let r = compare_values::<VirtualPool>(
        &load("Q12/virtual-pool-account.json"),
        &load("Q12/virtual-pool-sdk-decode.json"),
        "poolState",
        VirtualPool::DISCRIMINATOR,
        VirtualPool::SIZE,
    );
    assert_matches("VirtualPool", r);
}

#[test]
fn damm_v2_pool_matches_sdk_decode() {
    use meteora_types::damm_v2::Pool;
    let raw = load("Q1/positions-raw.json");
    let r = compare_values::<Pool>(
        &raw["dammPool"],
        &load("Q2/pool-after-migration.json"),
        "",
        Pool::DISCRIMINATOR,
        Pool::SIZE,
    );
    assert_matches("DAMM v2 Pool", r);
}

#[test]
fn damm_v2_positions_match_sdk_decode() {
    use meteora_types::damm_v2::Position;
    let raw = load("Q1/positions-raw.json");
    let sdk = load("Q1/positions-sdk-decode.json");
    for which in ["first", "second"] {
        let r = compare_values::<Position>(
            &raw[which],
            &sdk[which]["state"],
            "",
            Position::DISCRIMINATOR,
            Position::SIZE,
        );
        assert_matches(&format!("DAMM v2 Position ({which})"), r);
    }
}
