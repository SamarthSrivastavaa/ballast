//! The prediction and the config hash, recomputed from the DBC config's raw fields — independent of
//! the program's and the compiler's code (§20 step 2).
//!
//! Prediction (§7, D-017): the (V, S, L) a class config yields at `open`, at both ends of the
//! rule-4 band, with every rounding toward a LOWER floor (V and L down, S up), exactly as
//! `tests/reference/floor.py::prediction_inputs` derives them. The recorded prediction must not
//! exceed the lower of the two resulting `s` values: the prediction is a lower bound (canon
//! correction 6).

use ballast_floor::{floor_sqrt_q64, FloorInputs, S_MAX_DAMM_V2};
use meteora_types::dbc::PoolConfig;
use ruint::aliases::U256;
use sha2::{Digest, Sha256};

/// DAMM v2 `MIN_SQRT_PRICE`.
pub const S_MIN_DAMM_V2: u128 = 4_295_048_016;
/// D-017's band width: the largest shortfall of DBC's migration price below the last curve point
/// measured on the mainnet DBC binary, + 2 units.
pub const MIGRATION_PRICE_TOLERANCE: u128 = 4_580_461;
/// Q14: Meteora's 0.2% migration protocol share, taken in tokens.
pub const PROTOCOL_SHARE_BPS: u128 = 20;

fn ceil_div(a: U256, b: U256) -> U256 {
    a.div_ceil(b)
}

/// The non-zero curve points `(sqrt_price, liquidity)`.
pub fn curve(cfg: &PoolConfig) -> Vec<(u128, u128)> {
    cfg.curve
        .iter()
        .map(|p| (p.sqrt_price, p.liquidity))
        .take_while(|&(s, _)| s != 0)
        .collect()
}

/// `(V, S, L)` at `open` if DBC migrates at `s_mig`.
pub fn inputs_at(cfg: &PoolConfig, s_mig: u128) -> Option<(u64, u64, u128)> {
    let threshold = cfg.migration_quote_threshold as u128;
    let v = threshold * cfg.migration_fee_percentage as u128 / 100;
    let q_mig = threshold - v;
    let q_protocol = (q_mig * PROTOCOL_SHARE_BPS).div_ceil(10_000);
    let span = U256::from(s_mig.checked_sub(S_MIN_DAMM_V2)?);
    let l = (U256::from(q_mig - q_protocol) << 128) / span;

    let mut sold = U256::ZERO;
    let mut lo = cfg.sqrt_start_price;
    for (s_pt, l_seg) in curve(cfg) {
        let hi = s_pt.min(s_mig);
        if hi > lo {
            sold += ceil_div(
                U256::from(l_seg) * U256::from(hi - lo),
                U256::from(lo) * U256::from(hi),
            );
        }
        lo = s_pt;
        if s_pt >= s_mig {
            break;
        }
    }
    let l_full = ceil_div(U256::from(q_mig) << 128, span);
    let base_mig = ceil_div(
        l_full * U256::from(S_MAX_DAMM_V2 - s_mig),
        U256::from(s_mig) * U256::from(S_MAX_DAMM_V2),
    );
    Some((
        u64::try_from(v).ok()?,
        u64::try_from(sold + base_mig).ok()?,
        u128::try_from(l).ok()?,
    ))
}

/// `s` at the lower-F end of the band, and both ends `(band_lo, band_hi)`.
pub fn lower_bound(cfg: &PoolConfig) -> Option<(u128, u128, u128)> {
    let last = curve(cfg).last()?.0;
    let s_at = |s_mig: u128| -> Option<u128> {
        let (v, s, l) = inputs_at(cfg, s_mig)?;
        floor_sqrt_q64(&FloorInputs {
            v,
            s,
            l,
            s_max: S_MAX_DAMM_V2,
        })
        .ok()
    };
    let lo = s_at(last.checked_sub(MIGRATION_PRICE_TOLERANCE)?)?;
    let hi = s_at(last)?;
    Some((lo.min(hi), lo, hi))
}

/// §7 rule 3: `sha256(sqrt_start_price ‖ curve[0..20] ‖ migration_quote_threshold ‖
/// pre_migration_token_supply ‖ post_migration_token_supply)`, little-endian — 680 bytes.
pub fn config_hash(cfg: &PoolConfig) -> [u8; 32] {
    let mut h = Sha256::new();
    let start = cfg.sqrt_start_price;
    h.update(start.to_le_bytes());
    for p in cfg.curve.iter() {
        let (s, l) = (p.sqrt_price, p.liquidity);
        h.update(s.to_le_bytes());
        h.update(l.to_le_bytes());
    }
    let (t, pre, post) = (
        cfg.migration_quote_threshold,
        cfg.pre_migration_token_supply,
        cfg.post_migration_token_supply,
    );
    h.update(t.to_le_bytes());
    h.update(pre.to_le_bytes());
    h.update(post.to_le_bytes());
    h.finalize().into()
}
