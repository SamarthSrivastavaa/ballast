//! §9 / D-021 bin rules that the program, verifier and app share (§4 rule 1: one implementation).

use ballast_floor::{bin_at_or_below, f_q64, is_floor_bin, price_at_or_below};

/// §27 Proof: s = 47,755,047,807,748,143; F's bin at 10 bps = −11,920 (DLMM SDK prices, exact).
const S: u128 = 47_755_047_807_748_143;
const P_11920: u128 = 123_513_995_008_195; // getQPriceFromId(−11,920, 10), dlmm.rs vectors
const P_11919: u128 = 123_637_509_003_203; // getQPriceFromId(−11,919, 10)

#[test]
fn defined_prices_agree_with_bin_at_or_below() {
    assert!(bin_at_or_below(P_11920, P_11919, S));
    assert!(is_floor_bin(Some(P_11920), Some(P_11919), -11_920, S));
    assert!(price_at_or_below(Some(P_11920), -11_920, S));
    assert!(!price_at_or_below(Some(P_11919), -11_919, S));
}

/// D-021: an undefined price is ≈ 0 at a negative bin (at or below F) and huge at a non-negative
/// one (above F), so no bin a third party can pin the active bin to makes the rule an error.
#[test]
fn undefined_prices_are_classified_by_sign() {
    assert!(price_at_or_below(None, -50_000, S));
    assert!(!price_at_or_below(None, 20_000, S));
    // A bin with no price below a bin that has one above F: the floor bin by this rule.
    assert!(is_floor_bin(None, Some(u128::MAX), -50_000, S));
    // Both undefined at negative bins: the next bin is also ≤ F, so this is not the floor bin.
    assert!(!is_floor_bin(None, None, -60_000, S));
}

#[test]
fn f_q64_is_s_squared_over_2_64_floored() {
    assert_eq!(f_q64(1 << 64), 1 << 64); // F = 1
    assert_eq!(f_q64(S), (S * S) >> 64);
    assert_eq!(f_q64(u128::MAX), u128::MAX); // saturates, never wraps
                                             // F's bin satisfies price ≤ F_q64 < next price, in the same unit.
    assert!(P_11920 <= f_q64(S) && f_q64(S) < P_11919);
}
