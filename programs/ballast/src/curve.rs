//! §7 "Encoding the curve": the capacity a DBC curve can absorb, and the structural checks on it.
//!
//! §7 gives, for segment `i` running from `P_{i-1}` to `P_i` and carrying quote `q_i`:
//!
//! ```text
//! L_i = q_i · 2^128 / (s_i − s_{i−1})      (Q64 units, mirroring DAMM's Δb)
//! ```
//!
//! so the quote a segment absorbs is `q_i = L_i · (s_i − s_{i−1}) / 2^128`, and the curve's total
//! capacity is the sum over segments with `s_0 = sqrt_start_price`.
//!
//! `L_i` and the sqrt-price differences are both up to `2^128`, so the product needs 256 bits.
//! `ruint`'s `U256` is used rather than hand-split `u128` arithmetic: it is exact, obvious, and
//! already proven to compile for SBF under platform-tools rustc 1.79 (D-002 condition 3).
//!
//! Rounding is **down** at every step, so the computed capacity is a lower bound — the direction
//! that makes "capacity ≥ threshold" conservative.

use ruint::aliases::U256;

/// `⌊L · Δs / 2^128⌋` — the quote one segment absorbs, rounded down.
fn segment_quote(liquidity: u128, delta_sqrt_price: u128) -> U256 {
    (U256::from(liquidity).saturating_mul(U256::from(delta_sqrt_price))) >> 128
}

/// Total quote the curve can absorb, rounded down, or `None` on overflow.
///
/// `points` is the leading run of non-zero curve entries as `(sqrt_price, liquidity)`.
pub fn capacity(sqrt_start_price: u128, points: &[(u128, u128)]) -> Option<u128> {
    let mut total = U256::ZERO;
    let mut prev = sqrt_start_price;
    for &(sqrt_price, liquidity) in points {
        // A non-ascending curve is rejected before this is called; guard anyway rather than wrap.
        let delta = sqrt_price.checked_sub(prev)?;
        total = total.checked_add(segment_quote(liquidity, delta))?;
        prev = sqrt_price;
    }
    u128::try_from(total).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The §7 encoding is an identity: a segment built to carry `q` must report `q` back, up to
    /// the one unit that flooring can lose.
    #[test]
    fn segment_round_trips_its_quote() {
        let two_128 = U256::from(1u8) << 128;
        for &(q, ds) in &[
            (1_000_000_000u128, 1u128 << 60),
            (10_000_000_000, 1u128 << 64),
            (25_000_000_000, (1u128 << 64) + 12_345),
            (1, 1u128 << 70),
        ] {
            // L = q·2^128 / Δs, as §7 prescribes.
            let l = u128::try_from((U256::from(q).saturating_mul(two_128)) / U256::from(ds))
                .expect("L fits u128 at launch scale");
            let back = u128::try_from(segment_quote(l, ds)).unwrap();
            assert!(
                back <= q && q - back <= 1,
                "q={q} ds={ds}: expected {q} back (±1), got {back}"
            );
        }
    }

    #[test]
    fn capacity_sums_segments_and_rounds_down() {
        let s0 = 1u128 << 64;
        // Three segments each carrying ~1 SOL.
        let two_128 = U256::from(1u8) << 128;
        let mut pts = Vec::new();
        let mut prev = s0;
        for i in 1..=3u128 {
            let s = s0 + i * (1u128 << 60);
            let ds = s - prev;
            let l = u128::try_from(
                (U256::from(1_000_000_000u128).saturating_mul(two_128)) / U256::from(ds),
            )
            .unwrap();
            pts.push((s, l));
            prev = s;
        }
        let cap = capacity(s0, &pts).expect("no overflow");
        assert!(
            (3_000_000_000 - 3..=3_000_000_000).contains(&cap),
            "cap = {cap}"
        );
    }

    #[test]
    fn non_ascending_curve_is_none_not_a_wrap() {
        let s0 = 1u128 << 64;
        assert_eq!(capacity(s0, &[(s0 - 1, 1)]), None);
    }

    #[test]
    fn zero_liquidity_absorbs_nothing() {
        let s0 = 1u128 << 64;
        assert_eq!(capacity(s0, &[(s0 + (1u128 << 60), 0)]), Some(0));
    }
}
