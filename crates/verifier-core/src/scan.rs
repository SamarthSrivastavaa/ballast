//! The Floor Scanner (D-006, D-019): the floor that permanently locked liquidity alone holds under
//! real Meteora launches — Ballast Lite's floor (D-008: `V = 0`), computed with `ballast-floor`.
//!
//! Read-only, built for the free RPC tier: no `getProgramAccounts`. Every DBC launch that migrates
//! to DAMM v2 does so through one of DBC's seven DAMM v2 migration configs, and each migration
//! transaction names its pool and the two positions it creates — so paging those configs'
//! signatures finds the launches, one `getTransaction` each (cached across runs), and one batched
//! `getMultipleAccounts` reads their current state. Only `permanent_locked_liquidity` counts: an
//! unlocked or vesting position can be withdrawn and holds no floor.

use std::collections::BTreeMap;

use anchor_lang::prelude::Pubkey;
use ballast_floor::{floor_sqrt_q64, FloorInputs};
use meteora_types::damm_v2::{Pool as DammPool, Position};
use serde_json::{json, Value};

use crate::layout;
use crate::rpc::{Rpc, Tx};
use crate::Error;

/// DBC's DAMM v2 migration configs (`DAMM_V2_MIGRATION_FEE_ADDRESS`, DBC SDK): FixedBps25, 30, 100,
/// 200, 400, 600 and Customizable.
pub const DBC_DAMM_V2_CONFIGS: [Pubkey; 7] = [
    anchor_lang::pubkey!("7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd"),
    anchor_lang::pubkey!("2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k"),
    anchor_lang::pubkey!("Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp"),
    anchor_lang::pubkey!("2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq"),
    anchor_lang::pubkey!("AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD"),
    anchor_lang::pubkey!("DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u"),
    anchor_lang::pubkey!("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck"),
];
/// DBC `migration_damm_v2` (vendored IDL discriminator).
const MIGRATION_DAMM_V2: [u8; 8] = [156, 169, 230, 103, 53, 228, 80, 64];

/// One DBC → DAMM v2 migration, from its transaction.
#[derive(Clone, Debug, PartialEq)]
pub struct Migration {
    pub signature: String,
    pub slot: u64,
    pub dbc_pool: Pubkey,
    pub damm_pool: Pubkey,
    pub positions: [Pubkey; 2],
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
}

/// The migration a transaction performed, if any (IDL account order: virtual_pool 0, pool 4,
/// first_position 7, second_position 10, base_mint 13, quote_mint 14).
pub fn migration_in(tx: &Tx, signature: &str) -> Option<Migration> {
    let (_, accts, _) = tx.instructions.iter().find(|(p, a, d)| {
        *p == ballast::DBC_PROGRAM_ID && d.len() >= 8 && d[..8] == MIGRATION_DAMM_V2 && a.len() > 14
    })?;
    Some(Migration {
        signature: signature.to_string(),
        slot: tx.slot,
        dbc_pool: accts[0],
        damm_pool: accts[4],
        positions: [accts[7], accts[10]],
        base_mint: accts[13],
        quote_mint: accts[14],
    })
}

/// One pool's locked-liquidity floor, now.
#[derive(Clone, Debug)]
pub struct Row {
    pub m: Migration,
    /// Σ `permanent_locked_liquidity` over the migration's two positions.
    pub l_permanent: u128,
    /// The pool's total liquidity (permanent + anything withdrawable).
    pub l_pool: u128,
    pub supply: u64,
    pub s_price: u128,
    pub s_max: u128,
    /// `s` of the locked-liquidity floor, or why there is none.
    pub s_floor: Result<u128, String>,
}

impl Row {
    /// F ÷ the pool price (both in quote per base unit), in ppm.
    pub fn floor_over_price_ppm(&self) -> Option<u64> {
        let s = *self.s_floor.as_ref().ok()?;
        let r = (s as f64 / self.s_price.max(1) as f64).powi(2);
        Some((r * 1e6).round() as u64)
    }
    /// The share of the pool's liquidity that is permanently locked, in ppm.
    pub fn permanent_share_ppm(&self) -> u64 {
        ((self.l_permanent as f64 / self.l_pool.max(1) as f64) * 1e6).round() as u64
    }
}

/// Migrations already read, keyed by signature (the cache file's content).
#[derive(Default)]
pub struct Cache {
    pub migrations: BTreeMap<String, Migration>,
    /// Signatures that turned out not to be migrations (other uses of a config account).
    pub other: BTreeMap<String, u64>,
}

impl Cache {
    pub fn load(path: &str) -> Cache {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Cache::default();
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            return Cache::default();
        };
        let mut c = Cache::default();
        let key = |x: &Value| x.as_str().and_then(|s| s.parse::<Pubkey>().ok());
        for m in v["migrations"].as_array().cloned().unwrap_or_default() {
            let parsed = (|| {
                Some(Migration {
                    signature: m["signature"].as_str()?.to_string(),
                    slot: m["slot"].as_u64()?,
                    dbc_pool: key(&m["dbc_pool"])?,
                    damm_pool: key(&m["damm_pool"])?,
                    positions: [key(&m["positions"][0])?, key(&m["positions"][1])?],
                    base_mint: key(&m["base_mint"])?,
                    quote_mint: key(&m["quote_mint"])?,
                })
            })();
            if let Some(m) = parsed {
                c.migrations.insert(m.signature.clone(), m);
            }
        }
        for (k, s) in v["other"].as_object().cloned().unwrap_or_default() {
            c.other.insert(k, s.as_u64().unwrap_or(0));
        }
        c
    }

    pub fn save(&self, path: &str) -> std::io::Result<()> {
        let migrations: Vec<Value> = self
            .migrations
            .values()
            .map(|m| {
                json!({
                    "signature": m.signature, "slot": m.slot, "dbc_pool": m.dbc_pool.to_string(),
                    "damm_pool": m.damm_pool.to_string(),
                    "positions": [m.positions[0].to_string(), m.positions[1].to_string()],
                    "base_mint": m.base_mint.to_string(), "quote_mint": m.quote_mint.to_string(),
                })
            })
            .collect();
        if let Some(dir) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(
            path,
            serde_json::to_string_pretty(&json!({ "migrations": migrations, "other": self.other }))
                .unwrap_or_default(),
        )
    }
}

/// The newest `limit` migrations across DBC's DAMM v2 configs (reading only transactions the cache
/// has not seen).
pub fn discover(rpc: &Rpc, cache: &mut Cache, limit: usize) -> Result<Vec<Migration>, Error> {
    let mut found: Vec<Migration> = Vec::new();
    for config in DBC_DAMM_V2_CONFIGS.iter() {
        let mut before: Option<String> = None;
        let mut taken = 0;
        while taken < limit {
            let page = rpc.signatures_page(config, before.as_deref(), 200)?;
            if page.is_empty() {
                break;
            }
            for sig in &page {
                if sig.failed || cache.other.contains_key(&sig.signature) {
                    continue;
                }
                let m = match cache.migrations.get(&sig.signature) {
                    Some(m) => Some(m.clone()),
                    None => {
                        let m = rpc
                            .transaction(&sig.signature)?
                            .and_then(|tx| migration_in(&tx, &sig.signature));
                        match &m {
                            Some(m) => {
                                cache.migrations.insert(sig.signature.clone(), m.clone());
                            }
                            None => {
                                cache.other.insert(sig.signature.clone(), sig.slot);
                            }
                        }
                        m
                    }
                };
                if let Some(m) = m {
                    found.push(m);
                    taken += 1;
                    if taken >= limit {
                        break;
                    }
                }
            }
            before = page.last().map(|s| s.signature.clone());
            if page.len() < 200 {
                break;
            }
        }
    }
    found.sort_by(|a, b| b.slot.cmp(&a.slot));
    found.truncate(limit);
    Ok(found)
}

/// Read each migration's pool, positions and base mint now (batched), and compute its
/// locked-liquidity floor with the floor crate.
pub fn evaluate(rpc: &Rpc, migrations: &[Migration]) -> Result<Vec<Row>, Error> {
    let mut keys = Vec::new();
    for m in migrations {
        keys.extend([m.damm_pool, m.positions[0], m.positions[1], m.base_mint]);
    }
    let accts = rpc.accounts(&keys)?;
    let mut rows = Vec::new();
    for (i, m) in migrations.iter().enumerate() {
        let [pool, p1, p2, mint] = [
            &accts[4 * i],
            &accts[4 * i + 1],
            &accts[4 * i + 2],
            &accts[4 * i + 3],
        ];
        let (Some(pool), Some(mint)) = (pool, mint) else {
            continue;
        };
        let Ok(pool) =
            layout::meteora::<DammPool>(&pool.data, &DammPool::DISCRIMINATOR, "DAMM v2 Pool")
        else {
            continue;
        };
        let Ok(mint) = layout::mint(&mint.data) else {
            continue;
        };
        let mut l_permanent = 0u128;
        for p in [p1, p2].into_iter().flatten() {
            if let Ok(pos) =
                layout::meteora::<Position>(&p.data, &Position::DISCRIMINATOR, "DAMM v2 Position")
            {
                if layout::pk(pos.pool) == m.damm_pool {
                    l_permanent = l_permanent.saturating_add(pos.permanent_locked_liquidity);
                }
            }
        }
        let (s_max, s_price, l_pool) = (pool.sqrt_max_price, pool.sqrt_price, pool.liquidity);
        let s_floor = floor_sqrt_q64(&FloorInputs {
            v: 0,
            s: mint.supply,
            l: l_permanent,
            s_max,
        })
        .map_err(|e| format!("{e:?} (outside §4's bounds)"));
        rows.push(Row {
            m: m.clone(),
            l_permanent,
            l_pool,
            supply: mint.supply,
            s_price,
            s_max,
            s_floor,
        });
    }
    Ok(rows)
}
