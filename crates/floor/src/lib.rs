//! The Ballast floor engine — the only implementation of `F` (BUILD_SPEC.md §4, §11).
//!
//! `F` is the price at which the permanently locked DAMM v2 liquidity plus the vault's resting
//! DLMM bid can absorb the entire outstanding supply. It is defined as the floor of the positive
//! root of an integer quadratic in Q64 sqrt-price units, so that "F never falls" holds bit for
//! bit across Rust, WASM, TypeScript and the verifier.
//!
//! # The equation (§4)
//!
//! ```text
//! V/F + L_real·(1/√F − 1/√P_max) = S          L_real = L / 2^64
//! ⟺  A·s² − B·s − C = 0      A = S + ⌈L/s_max⌉,  B = L,  C = V·2^128
//! ```
//!
//! with `s = ⌊√F · 2^64⌋` and `F = s² / 2^128` in lamports per base unit. `s` is defined as
//! `max{s : P(s) ≤ 0}` where `P(s) = A·s² − B·s − C`.
//!
//! # Rounding
//!
//! Toward the protocol, everywhere (§4): `⌈L/s_max⌉` in `A` (a larger `A` lowers `s`), `⌊root⌋`
//! for `s`, `⌊·⌋` on payouts, bid bin at or below `F`. There is no floating point in this crate
//! — `float_arithmetic` is denied at the lint level.
//!
//! # Why the correction loop is not optional
//!
//! `isqrt` is exact, but the outer division in `(B + isqrt(D)) / 2A` truncates, so the estimate
//! can land on either side of the true floor. Without step 3 the result is *nearly* right, and a
//! value that is nearly right is worse than useless here: the monotone check `s_new >= s_last`
//! would fire on rounding noise, and Rust, WASM and Python would disagree in the last digit.

#![no_std]
#![forbid(unsafe_code)]

use core::cmp::Ordering;

use ruint::aliases::U256;

// ---------------------------------------------------------------------------
// Bounds (§4)
// ---------------------------------------------------------------------------

/// `S ≤ 2^50` (inclusive). 2^50 base units is ~1.126e15, above the 1e15 fixed supply of §7.
pub const SUPPLY_MAX: u64 = 1 << 50;

/// `L ≤ 2^120`.
///
/// §4 writes this bound as `L < 2^120`, strictly. §27's boundary vector
/// "Max supply, 1,000 SOL vault, L = 2^120" uses `L` at exactly 2^120 and §27 requires Rust to
/// reproduce its `s` exactly, so the two sections disagree by one. Treated as **inclusive**
/// here, which is the reading that keeps the spec self-consistent, and which is safe: §4's
/// headroom argument needs `B² < 2^240`, and at `L = 2^120` exactly, `B² = 2^240 < 2^256`.
/// Recorded in DECISIONS.md under "§4 vs §27 L bound" — pending approval.
pub const L_MAX: u128 = 1 << 120;

/// `s_max < 2^97` (strict).
pub const S_MAX_BOUND: u128 = 1 << 97;

/// DAMM v2's maximum sqrt price, Q64.64 (§2, §27).
///
/// Present for tests and vectors only. The engine takes `s_max` as an **input** and the program
/// re-reads it from `pool.sqrt_max_price` every time (§4 correction 1, §8): a hard-coded range
/// would silently produce a wrong `F` if Meteora ever migrated into a bounded pool.
pub const S_MAX_DAMM_V2: u128 = 79_226_673_521_066_979_257_578_248_091;

/// Redemption fee, basis points (§10). The fee is never transferred: it stays in the vault.
pub const REDEEM_FEE_BPS: u16 = 50;

const BPS_DENOM: u64 = 10_000;

// ---------------------------------------------------------------------------
// Types (§11)
// ---------------------------------------------------------------------------

/// Inputs to the floor computation, all read live from accounts in the same instruction (§4 rule 2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FloorInputs {
    /// Vault lamports + `launch.bid_quote_committed`.
    pub v: u64,
    /// Outstanding supply in base units: `base_mint.supply` − PDA-held base.
    ///
    /// Named `s` to match §11's published API. Not to be confused with the returned `s`, which
    /// is the Q64 sqrt price.
    pub s: u64,
    /// Σ `permanent_locked_liquidity` over the **two recorded positions only** (§8).
    pub l: u128,
    /// `pool.sqrt_max_price`, Q64.64.
    pub s_max: u128,
}

/// Out-of-range input returns an error, never a value (§4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FloorError {
    /// `S == 0`: the quadratic degenerates and `F` is unbounded.
    SupplyZero,
    /// An input violated a §4 bound.
    OutOfRange,
}

// ---------------------------------------------------------------------------
// Public API (§11)
// ---------------------------------------------------------------------------

/// `s = ⌊√F · 2^64⌋`, exactly the floor of the positive root (§4).
///
/// # Errors
///
/// [`FloorError::SupplyZero`] if `S == 0`; [`FloorError::OutOfRange`] if any §4 bound is violated.
///
/// # Arithmetic
///
/// Every multiplication on input-derived values is `checked_*`. The bare operators that remain
/// are the correction loop's `s ± 1` (the decrement is guarded by `!s.is_zero()`, the increment
/// is bounded above by the root) and the division by `two_a`, which cannot be zero because
/// `A ≥ S ≥ 1` after the bounds check. `overflow-checks` is on in every profile.
#[allow(clippy::arithmetic_side_effects)]
pub fn floor_sqrt_q64(i: &FloorInputs) -> Result<u128, FloorError> {
    // §4 rule 5: bounds asserts precede all arithmetic.
    let (a, b, c) = coefficients(i)?;

    // 1. D = B² + 4AC in U256.
    let d = b
        .checked_mul(b)
        .and_then(|bb| {
            a.checked_mul(c)
                .and_then(|ac| ac.checked_mul(U256::from(4u8)))
                .and_then(|four_ac| bb.checked_add(four_ac))
        })
        .ok_or(FloorError::OutOfRange)?;

    // 2. First estimate. The division truncates; step 3 repairs it.
    let two_a = a
        .checked_mul(U256::from(2u8))
        .ok_or(FloorError::OutOfRange)?;
    let mut s = b.checked_add(isqrt(d)).ok_or(FloorError::OutOfRange)? / two_a;

    // 3. Correction loop, both directions (§4).
    while !s.is_zero() && residual(a, b, c, s) == Ordering::Greater {
        s -= U256::from(1u8);
    }
    while residual(a, b, c, s + U256::from(1u8)) != Ordering::Greater {
        s += U256::from(1u8);
    }

    // 4. `s` is now max{s : P(s) ≤ 0}.
    //
    // It fits u128: from C alone s ≤ √(V·2^128/A) ≤ 2^96, and from B alone s ≤ B/A ≤ 2^120.
    u128::try_from(s).map_err(|_| FloorError::OutOfRange)
}

/// `⌊amount · s² · (10_000 − fee_bps) / (2^128 · 10_000)⌋` (§10, §11).
///
/// The §11 signature returns a bare `u64`. A payout that does not fit `u64` saturates to
/// [`u64::MAX`], which is deliberately an **un-payable sentinel** rather than a truncation: no
/// vault can hold `u64::MAX` lamports, so §10's `payout ≤ vault balance` check rejects it and the
/// instruction reverts. Saturation here can only cause a revert, never an overpayment.
/// `BPS_DENOM - fee_bps` is guarded by the early return above it, and `denom` is a non-zero
/// constant; every multiplication saturates deliberately (see the sentinel note).
#[allow(clippy::arithmetic_side_effects)]
pub fn redeem_payout(amount: u64, s: u128, fee_bps: u16) -> u64 {
    if fee_bps as u64 > BPS_DENOM {
        return 0;
    }
    let s = U256::from(s);
    let numer = U256::from(amount)
        .saturating_mul(s)
        .saturating_mul(s)
        .saturating_mul(U256::from(BPS_DENOM - fee_bps as u64));
    let denom = two_128().saturating_mul(U256::from(BPS_DENOM));
    u64::try_from(numer / denom).unwrap_or(u64::MAX)
}

/// True iff `price(bin) ≤ F < price(bin + 1)`, prices in DLMM Q64 form (§9, §11).
///
/// `F = s²/2^128` and the prices are scaled by `2^64`, so the comparison is
/// `price · 2^64 ≤ s² < next · 2^64` — integers, no division, no precision loss.
/// The `<< 64` shifts cannot lose bits: both operands come from `u128`, so the result is at
/// most `2^192`, well inside `U256`.
#[allow(clippy::arithmetic_side_effects)]
pub fn bin_at_or_below(bin_price_q64: u128, next_bin_price_q64: u128, s: u128) -> bool {
    let f_scaled = U256::from(s).saturating_mul(U256::from(s)); // F · 2^128
    let lo = U256::from(bin_price_q64) << 64;
    let hi = U256::from(next_bin_price_q64) << 64;
    lo <= f_scaled && f_scaled < hi
}

/// True iff `price(bin) ≤ F` (§9, D-021), with DLMM's price possibly undefined (`None`).
///
/// DLMM's price function has no value where its fixed-point result underflows to 0 (far below
/// bin 0) or overflows (far above it). The bin's sign decides those cases: an undefined price at a
/// negative bin is ≈ 0, at or below any F; at a non-negative bin it is above any F. This is the one
/// place the rule lives, so the program, the verifier and the app classify every bin a third party
/// can pin the active bin to in exactly the same way (§4 rule 1).
#[allow(clippy::arithmetic_side_effects)]
pub fn price_at_or_below(price_q64: Option<u128>, bin_id: i32, s: u128) -> bool {
    match price_q64 {
        Some(p) => (U256::from(p) << 64) <= U256::from(s).saturating_mul(U256::from(s)),
        None => bin_id < 0,
    }
}

/// True iff `bin` is the highest bin at or below F: `price(bin) ≤ F < price(bin + 1)` (§9), with
/// undefined prices classified as in [`price_at_or_below`]. With both prices defined this is
/// exactly [`bin_at_or_below`].
pub fn is_floor_bin(
    price_q64: Option<u128>,
    next_price_q64: Option<u128>,
    bin_id: i32,
    s: u128,
) -> bool {
    match (price_q64, next_price_q64) {
        (Some(p), Some(n)) => bin_at_or_below(p, n, s),
        _ => {
            price_at_or_below(price_q64, bin_id, s)
                && !price_at_or_below(next_price_q64, bin_id.saturating_add(1), s)
        }
    }
}

/// F as a Q64.64 price, `⌊s² / 2^64⌋` — the unit of DLMM bin prices (§6 `floor()`, §9). Saturates
/// at `u128::MAX`, which no reachable `s` produces (F would exceed 2^64 lamports per base unit).
#[allow(clippy::arithmetic_side_effects)]
pub fn f_q64(s: u128) -> u128 {
    let f = U256::from(s).saturating_mul(U256::from(s)) >> 64;
    u128::try_from(f).unwrap_or(u128::MAX)
}

/// Sign of `P(s) = A·s² − B·s − C`, for invariant tests and the verifier (§11).
///
/// [`Ordering::Less`] below the root, [`Ordering::Equal`] exactly on it, [`Ordering::Greater`]
/// above. On a bounds violation returns [`Ordering::Greater`] — the conservative direction, since
/// callers treat "above the root" as "not a valid floor".
pub fn residual_sign(i: &FloorInputs, s: u128) -> Ordering {
    match coefficients(i) {
        Ok((a, b, c)) => residual(a, b, c, U256::from(s)),
        Err(_) => Ordering::Greater,
    }
}

/// The checked invariant from §4, for the fuzzer and the verifier: at `s`, absorption covers supply.
///
/// `V/F + L(1/√F − 1/√P_max) ≥ S`, rearranged to `P(s) ≤ 0` to stay in integers.
pub fn invariant_holds(i: &FloorInputs, s: u128) -> bool {
    residual_sign(i, s) != Ordering::Greater
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/// `2^128` as `U256`. Constant shift.
#[allow(clippy::arithmetic_side_effects)]
fn two_128() -> U256 {
    U256::from(1u8) << 128
}

/// `A = S + ⌈L/s_max⌉`, `B = L`, `C = V·2^128`, after the §4 bounds checks.
fn coefficients(i: &FloorInputs) -> Result<(U256, U256, U256), FloorError> {
    if i.s == 0 {
        return Err(FloorError::SupplyZero);
    }
    if i.s > SUPPLY_MAX || i.l > L_MAX || i.s_max == 0 || i.s_max >= S_MAX_BOUND {
        return Err(FloorError::OutOfRange);
    }
    // V is u64, so `V ≤ 2^64 − 1` holds by construction.

    // ⌈L/s_max⌉ — the ceiling is load-bearing: it raises A, which lowers s. Rounding the other
    // way would report a floor the protocol cannot actually honour.
    let l_over_s_max = i.l.div_ceil(i.s_max);

    let a = U256::from(i.s)
        .checked_add(U256::from(l_over_s_max))
        .ok_or(FloorError::OutOfRange)?;
    let b = U256::from(i.l);
    let c = U256::from(i.v)
        .checked_mul(two_128())
        .ok_or(FloorError::OutOfRange)?;
    Ok((a, b, c))
}

/// Sign of `P(s) = A·s² − B·s − C` without ever going negative (U256 is unsigned).
fn residual(a: U256, b: U256, c: U256, s: U256) -> Ordering {
    // Compare A·s² against B·s + C instead of subtracting.
    let lhs = a.saturating_mul(s).saturating_mul(s);
    let rhs = b.saturating_mul(s).saturating_add(c);
    lhs.cmp(&rhs)
}

/// `⌊√n⌋`, exact, by Newton descent from above.
///
/// Starting at `x ≥ √n` the sequence `x ← ⌊(x + n/x)/2⌋` decreases monotonically, and the first
/// time it fails to decrease, `x` is exactly `⌊√n⌋`. Standard integer Newton; no float.
#[allow(clippy::arithmetic_side_effects)]
fn isqrt(n: U256) -> U256 {
    if n < U256::from(2u8) {
        return n;
    }
    // x₀ = 2^(bits/2 + 1) > √n, since n < 2^bits ⟹ √n < 2^(bits/2).
    let bits = 256 - n.leading_zeros();
    let mut x = U256::from(1u8) << (bits / 2 + 1);
    loop {
        let y = (x + n / x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(v: u64, s: u64, l: u128) -> FloorInputs {
        FloorInputs {
            v,
            s,
            l,
            s_max: S_MAX_DAMM_V2,
        }
    }

    /// The §27 launch and boundary vectors. The differential test against the Python reference
    /// lives in `tests/vectors.rs`; these are here so `cargo test -p ballast-floor` alone is a
    /// meaningful gate.
    #[test]
    fn spec_vectors_27() {
        let cases: &[(&str, u64, u64, u128, u128)] = &[
            (
                "proof",
                1_500_000_000,
                865_440_991_257_550,
                30_640_807_377_189_377_099_685_691_392_000,
                47_755_047_807_748_143,
            ),
            (
                "public",
                3_750_000_000,
                865_440_991_257_550,
                48_447_370_329_204_224_440_919_346_118_656,
                75_507_360_421_341_854,
            ),
            (
                "harvest_0.1_sol",
                3_850_000_000,
                865_440_991_257_550,
                48_447_370_329_204_224_440_919_346_118_656,
                75_919_307_215_186_886,
            ),
            (
                "deposit_1_sol",
                4_750_000_000,
                865_440_991_257_550,
                48_447_370_329_204_224_440_919_346_118_656,
                79_478_727_226_182_304,
            ),
            (
                "redeem_50m",
                2_916_448_923,
                815_440_991_257_550,
                48_447_370_329_204_224_440_919_346_118_656,
                75_526_438_275_666_392,
            ),
            (
                "bid_fill_100m",
                2_076_195_928,
                765_440_991_257_550,
                48_447_370_329_204_224_440_919_346_118_656,
                75_515_850_660_144_827,
            ),
            (
                "tiny",
                1_000_000,
                1_000_000_000_000,
                100_000_000_000_000_000_000,
                18_446_744_123_700_328,
            ),
            (
                "max_supply_l_2_120",
                1_000_000_000_000,
                1_000_000_000_000_000,
                L_MAX,
                1_329_228_229_483_701_708_696,
            ),
            (
                "vault_only_l_zero",
                1_000_000_000,
                100_000_000_000_000,
                0,
                58_333_726_687_135_158,
            ),
            (
                "pool_only_v_zero",
                0,
                100_000_000_000_000,
                1_000_000_000_000_000_000_000_000_000_000,
                9_999_999_999_998_700,
            ),
        ];
        for (name, v, s, l, want) in cases {
            let got = floor_sqrt_q64(&inputs(*v, *s, *l)).expect(name);
            assert_eq!(got, *want, "§27 vector {name}");
        }
    }

    /// §27: "Redeem 1M tokens pays" for both launch classes, at the 0.5% fee.
    #[test]
    fn spec_vectors_27_redeem_payout() {
        let proof = floor_sqrt_q64(&inputs(
            1_500_000_000,
            865_440_991_257_550,
            30_640_807_377_189_377_099_685_691_392_000,
        ))
        .unwrap();
        assert_eq!(
            redeem_payout(1_000_000_000_000, proof, REDEEM_FEE_BPS),
            6_668_408
        );

        let public = floor_sqrt_q64(&inputs(
            3_750_000_000,
            865_440_991_257_550,
            48_447_370_329_204_224_440_919_346_118_656,
        ))
        .unwrap();
        assert_eq!(
            redeem_payout(1_000_000_000_000, public, REDEEM_FEE_BPS),
            16_671_021
        );
    }

    /// The defining property: `P(s) ≤ 0 < P(s+1)`. Independent of the expected values above.
    #[test]
    fn root_is_exactly_the_floor() {
        for (v, s, l) in [
            (
                1_500_000_000u64,
                865_440_991_257_550u64,
                30_640_807_377_189_377_099_685_691_392_000u128,
            ),
            (
                3_750_000_000,
                865_440_991_257_550,
                48_447_370_329_204_224_440_919_346_118_656,
            ),
            (1_000_000, 1_000_000_000_000, 100_000_000_000_000_000_000),
            (
                0,
                100_000_000_000_000,
                1_000_000_000_000_000_000_000_000_000_000,
            ),
            (1_000_000_000, 100_000_000_000_000, 0),
            (1, 1, 0),
            (u64::MAX, SUPPLY_MAX, L_MAX),
        ] {
            let i = inputs(v, s, l);
            let root = floor_sqrt_q64(&i).unwrap();
            assert_ne!(
                residual_sign(&i, root),
                Ordering::Greater,
                "P(s) > 0 for {i:?}"
            );
            assert_eq!(
                residual_sign(&i, root + 1),
                Ordering::Greater,
                "P(s+1) ≤ 0 for {i:?}"
            );
        }
    }

    /// `isqrt` must be exact, checked by its defining property `r² ≤ n < (r+1)²` rather than
    /// against a float sqrt — a float would be both imprecise at scale and banned by the lint.
    ///
    /// `assert!(a == b)` rather than `assert_eq!`: `U256` has no `Debug` without `alloc`, and the
    /// crate is `no_std` with `default-features = false`.
    #[test]
    fn isqrt_is_exact() {
        let one = U256::from(1u8);
        for n in 0u64..4_000 {
            let n256 = U256::from(n);
            let r = isqrt(n256);
            assert!(r.saturating_mul(r) <= n256, "isqrt({n}) too large");
            assert!(
                (r + one).saturating_mul(r + one) > n256,
                "isqrt({n}) too small"
            );
        }
        // Perfect squares and their neighbours at scale.
        for k in [1u128 << 60, 1u128 << 90, 1u128 << 120, u128::MAX >> 8] {
            let kk = U256::from(k);
            let sq = kk.saturating_mul(kk);
            assert!(isqrt(sq) == kk, "isqrt(k²) != k");
            assert!(isqrt(sq - one) == kk - one, "isqrt(k² − 1) != k − 1");
            assert!(isqrt(sq + one) == kk, "isqrt(k² + 1) != k");
        }
    }

    #[test]
    fn bounds_are_errors_not_values() {
        let ok = inputs(1_000, 1_000_000, 0);
        assert!(floor_sqrt_q64(&ok).is_ok());

        assert_eq!(
            floor_sqrt_q64(&inputs(1_000, 0, 0)),
            Err(FloorError::SupplyZero)
        );
        assert_eq!(
            floor_sqrt_q64(&inputs(1_000, SUPPLY_MAX + 1, 0)),
            Err(FloorError::OutOfRange)
        );
        assert_eq!(
            floor_sqrt_q64(&inputs(1_000, 1_000_000, L_MAX + 1)),
            Err(FloorError::OutOfRange)
        );
        assert_eq!(
            floor_sqrt_q64(&FloorInputs {
                v: 1_000,
                s: 1_000_000,
                l: 0,
                s_max: 0
            }),
            Err(FloorError::OutOfRange)
        );
        assert_eq!(
            floor_sqrt_q64(&FloorInputs {
                v: 1_000,
                s: 1_000_000,
                l: 0,
                s_max: S_MAX_BOUND
            }),
            Err(FloorError::OutOfRange)
        );
    }

    /// §4 monotonicity table: harvest and deposit (C += Δ·2^128) can only raise F.
    #[test]
    fn harvest_and_deposit_raise_f() {
        let base = inputs(
            3_750_000_000,
            865_440_991_257_550,
            48_447_370_329_204_224_440_919_346_118_656,
        );
        let s0 = floor_sqrt_q64(&base).unwrap();
        for delta in [1u64, 100_000_000, 1_000_000_000] {
            let mut up = base;
            up.v += delta;
            assert!(
                floor_sqrt_q64(&up).unwrap() >= s0,
                "deposit {delta} lowered F"
            );
        }
    }

    /// §4: a burn (A -= T) can only raise F.
    #[test]
    fn burn_raises_f() {
        let base = inputs(
            3_750_000_000,
            865_440_991_257_550,
            48_447_370_329_204_224_440_919_346_118_656,
        );
        let s0 = floor_sqrt_q64(&base).unwrap();
        for burn in [1u64, 1_000_000_000, 100_000_000_000_000] {
            let mut after = base;
            after.s -= burn;
            assert!(
                floor_sqrt_q64(&after).unwrap() >= s0,
                "burn {burn} lowered F"
            );
        }
    }

    /// §4 redeem row: paying `⌊T·s²·(1−φ)/2^128⌋` for `T` burned tokens leaves `P'(s_old) ≤ 0`,
    /// so the recomputed floor cannot fall. This is the transition the whole mechanism rests on.
    #[test]
    fn redeem_never_lowers_f() {
        let base = inputs(
            3_750_000_000,
            865_440_991_257_550,
            48_447_370_329_204_224_440_919_346_118_656,
        );
        let s0 = floor_sqrt_q64(&base).unwrap();
        for t in [
            1_000_000u64,
            1_000_000_000,
            50_000_000_000_000,
            100_000_000_000_000,
        ] {
            let payout = redeem_payout(t, s0, REDEEM_FEE_BPS);
            let after = FloorInputs {
                v: base.v - payout,
                s: base.s - t,
                ..base
            };
            let s1 = floor_sqrt_q64(&after).unwrap();
            assert!(s1 >= s0, "redeem of {t} lowered F: {s0} -> {s1}");
        }
    }

    /// §4 bid-fill row: absorbing `T` tokens at a price `b ≤ F` cannot lower F.
    #[test]
    fn bid_fill_never_lowers_f() {
        let base = inputs(
            3_750_000_000,
            865_440_991_257_550,
            48_447_370_329_204_224_440_919_346_118_656,
        );
        let s0 = floor_sqrt_q64(&base).unwrap();
        for t in [1_000_000u64, 100_000_000_000_000] {
            // Fill at exactly F (the worst allowed case): quote spent = payout at zero fee.
            let quote = redeem_payout(t, s0, 0);
            let after = FloorInputs {
                v: base.v - quote,
                s: base.s - t,
                ..base
            };
            assert!(
                floor_sqrt_q64(&after).unwrap() >= s0,
                "fill of {t} lowered F"
            );
        }
    }

    #[test]
    fn payout_is_floored_and_fee_free_is_larger() {
        let s = floor_sqrt_q64(&inputs(
            3_750_000_000,
            865_440_991_257_550,
            48_447_370_329_204_224_440_919_346_118_656,
        ))
        .unwrap();
        let gross = redeem_payout(1_000_000_000_000, s, 0);
        let net = redeem_payout(1_000_000_000_000, s, REDEEM_FEE_BPS);
        assert!(net < gross);
        // Floored, never rounded up: 0.5% of gross, truncated.
        assert_eq!(net, gross * 9_950 / 10_000);
        // Dust cannot pay more than nothing by rounding up.
        assert_eq!(redeem_payout(0, s, REDEEM_FEE_BPS), 0);
    }

    #[test]
    fn bin_check_brackets_f() {
        // F = s²/2^128; pick a bin price just below and just above.
        let s = 75_507_360_421_341_854u128;
        let f_q64 = (U256::from(s).saturating_mul(U256::from(s))) >> 64; // F · 2^64
        let f_q64 = u128::try_from(f_q64).unwrap();
        assert!(bin_at_or_below(f_q64, f_q64 + 1, s));
        assert!(
            !bin_at_or_below(f_q64 + 1, f_q64 + 2, s),
            "bin above F accepted"
        );
        assert!(
            !bin_at_or_below(0, f_q64, s),
            "bin whose next price is ≤ F accepted"
        );
    }

    #[test]
    fn s_max_is_an_input_not_a_constant() {
        // A bounded pool (smaller s_max) raises ⌈L/s_max⌉, so A grows and F falls. The engine
        // must honour the value it is given (§1 correction 1).
        let wide = FloorInputs {
            v: 3_750_000_000,
            s: 865_440_991_257_550,
            l: 48_447_370_329_204_224_440_919_346_118_656,
            s_max: S_MAX_DAMM_V2,
        };
        let narrow = FloorInputs {
            s_max: S_MAX_DAMM_V2 / 1_000,
            ..wide
        };
        assert!(floor_sqrt_q64(&narrow).unwrap() < floor_sqrt_q64(&wide).unwrap());
    }
}
