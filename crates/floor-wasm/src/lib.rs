//! `ballast-floor` for WebAssembly (§11): F, payouts and the bin check, with the floor crate's own
//! code — nothing reimplemented (§4 rule 1).
//!
//! The exports take and return `u64` halves (`*_lo`, `*_hi`), which JavaScript passes as `BigInt`,
//! so the module needs no allocator, no shared memory and no wasm-bindgen. A u128 is `hi·2^64 + lo`.
//! `sdk/typescript` wraps these into `floor(v, s, l, sMax): bigint`.

// No unsafe code; #[no_mangle] (which the unsafe_code lint counts) is allowed only on the exports.
#![deny(unsafe_code)]

use ballast_floor::{bin_at_or_below, floor_sqrt_q64, redeem_payout, FloorInputs};

fn join(lo: u64, hi: u64) -> u128 {
    (u128::from(hi) << 64) | u128::from(lo)
}

fn floor(v: u64, s: u64, l_lo: u64, l_hi: u64, m_lo: u64, m_hi: u64) -> Option<u128> {
    floor_sqrt_q64(&FloorInputs {
        v,
        s,
        l: join(l_lo, l_hi),
        s_max: join(m_lo, m_hi),
    })
    .ok()
}

/// 1 when the §4 inputs are in range (a floor exists), 0 when the floor crate refuses them.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn floor_ok(v: u64, s: u64, l_lo: u64, l_hi: u64, m_lo: u64, m_hi: u64) -> u32 {
    u32::from(floor(v, s, l_lo, l_hi, m_lo, m_hi).is_some())
}

/// The low 64 bits of `s = ⌊√F · 2^64⌋` (0 when out of range; check `floor_ok`).
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn floor_lo(v: u64, s: u64, l_lo: u64, l_hi: u64, m_lo: u64, m_hi: u64) -> u64 {
    floor(v, s, l_lo, l_hi, m_lo, m_hi).unwrap_or(0) as u64
}

/// The high 64 bits of `s`.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn floor_hi(v: u64, s: u64, l_lo: u64, l_hi: u64, m_lo: u64, m_hi: u64) -> u64 {
    (floor(v, s, l_lo, l_hi, m_lo, m_hi).unwrap_or(0) >> 64) as u64
}

/// §10 payout: `⌊amount · s² · (10⁴ − fee_bps) / (2^128 · 10⁴)⌋`.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn payout(amount: u64, s_lo: u64, s_hi: u64, fee_bps: u32) -> u64 {
    redeem_payout(
        amount,
        join(s_lo, s_hi),
        fee_bps.min(u32::from(u16::MAX)) as u16,
    )
}

/// 1 iff `price ≤ F < next` (DLMM Q64 prices).
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn bin_ok(p_lo: u64, p_hi: u64, n_lo: u64, n_hi: u64, s_lo: u64, s_hi: u64) -> u32 {
    u32::from(bin_at_or_below(
        join(p_lo, p_hi),
        join(n_lo, n_hi),
        join(s_lo, s_hi),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// §27 Proof vector through the exported halves.
    #[test]
    fn proof_vector_round_trips() {
        let l: u128 = 30_640_807_377_189_377_099_685_691_392_000;
        let m = ballast_floor::S_MAX_DAMM_V2;
        let args = (
            1_500_000_000u64,
            865_440_991_257_550u64,
            l as u64,
            (l >> 64) as u64,
            m as u64,
            (m >> 64) as u64,
        );
        assert_eq!(floor_ok(args.0, args.1, args.2, args.3, args.4, args.5), 1);
        let s = join(
            floor_lo(args.0, args.1, args.2, args.3, args.4, args.5),
            floor_hi(args.0, args.1, args.2, args.3, args.4, args.5),
        );
        assert_eq!(s, 47_755_047_807_748_143);
    }
}
