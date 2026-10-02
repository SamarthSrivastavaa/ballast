//! Property layer from §14: "For random valid inputs: P(s) ≤ 0 < P(s+1); monotone in V;
//! antitone in S; monotone in L; payout ≤ exact." Gate: 100k cases.
//!
//! Run the full gate with `PROPTEST_CASES=100000 cargo test -p ballast-floor --test properties`.
//! The default below is 2,000 per property so the suite stays usable during a slice; CI runs the
//! 100k gate (see `.github/workflows/ci.yml`).
//!
//! # On preconditions
//!
//! Where a transition has a protocol precondition (§10 solvency: `payout ≤ vault`), that is
//! asserted as a conditional rather than a `prop_assume!`. Rejecting those inputs would throw
//! away most of the input space and abort on the reject limit; the real program simply reverts.

// Test arithmetic is not protocol arithmetic: an overflow here is a test failure, which is
// exactly what should happen. The lint stays on for `src/` (see lib.rs).
#![allow(clippy::arithmetic_side_effects)]

use ballast_floor::{
    floor_sqrt_q64, redeem_payout, residual_sign, FloorInputs, L_MAX, REDEEM_FEE_BPS, SUPPLY_MAX,
    S_MAX_DAMM_V2,
};
use proptest::prelude::*;
use std::cmp::Ordering;

/// Strategy over the legal input box (§4 bounds), weighted toward launch scale but including the
/// edges, since that is where rounding decisions bite.
fn inputs() -> impl Strategy<Value = FloorInputs> {
    (
        prop_oneof![
            Just(0u64),
            Just(1u64),
            1u64..=1_000_000_000_000u64,
            Just(u64::MAX),
        ],
        prop_oneof![Just(1u64), 1u64..=SUPPLY_MAX, Just(SUPPLY_MAX)],
        prop_oneof![Just(0u128), Just(1u128), 0u128..=L_MAX, Just(L_MAX)],
    )
        .prop_map(|(v, s, l)| FloorInputs {
            v,
            s,
            l,
            s_max: S_MAX_DAMM_V2,
        })
}

/// Inputs paired with an amount of base tokens `t` that is always `≤ S`, as a fraction of the
/// supply. Generating `t` independently of `S` would reject almost every case.
fn inputs_and_amount() -> impl Strategy<Value = (FloorInputs, u64)> {
    (inputs(), 1u64..=10_000u64).prop_map(|(i, per_10k)| {
        let t = ((i.s as u128 * per_10k as u128) / 10_000) as u64;
        (i, t.max(1).min(i.s))
    })
}

/// As [`inputs`], but with `L ≥ 1` by construction.
///
/// `prop_assume!(l > 0)` would reject roughly a quarter of cases, and proptest's global reject
/// budget is a fixed 1024 regardless of the case count — so an assumption that is harmless at
/// 2,000 cases aborts the 100k gate. Preconditions belong in the strategy, not in a filter.
fn inputs_with_positive_l() -> impl Strategy<Value = FloorInputs> {
    (
        prop_oneof![
            Just(0u64),
            Just(1u64),
            1u64..=1_000_000_000_000u64,
            Just(u64::MAX)
        ],
        prop_oneof![Just(1u64), 1u64..=SUPPLY_MAX, Just(SUPPLY_MAX)],
        prop_oneof![Just(1u128), 1u128..=L_MAX, Just(L_MAX)],
    )
        .prop_map(|(v, s, l)| FloorInputs {
            v,
            s,
            l,
            s_max: S_MAX_DAMM_V2,
        })
}

/// A pair `L ≤ L'` that lies inside one ceiling step, i.e. `⌈L/s_max⌉ == ⌈L'/s_max⌉`, so that
/// raising L to L' changes only `B` and leaves `A` alone.
///
/// Built by construction rather than filtered: a random bump crosses a step boundary in roughly
/// three cases out of four, which exhausts proptest's reject budget. `⌈L/s_max⌉ = k` exactly for
/// `L ∈ ((k−1)·s_max, k·s_max]`, so both values are drawn from that half-open interval.
fn l_pair_within_one_ceiling_step() -> impl Strategy<Value = (u64, u64, u128, u128)> {
    // k·s_max must stay under L_MAX: L_MAX / s_max ≈ 1.678e7.
    const K_MAX: u128 = 16_700_000;
    (
        prop_oneof![
            Just(0u64),
            Just(1u64),
            1u64..=1_000_000_000_000u64,
            Just(u64::MAX)
        ],
        prop_oneof![Just(1u64), 1u64..=SUPPLY_MAX, Just(SUPPLY_MAX)],
        1u128..=K_MAX,
        0u128..=10_000u128,
        0u128..=10_000u128,
    )
        .prop_map(|(v, s, k, a, b)| {
            let lo = (k - 1) * S_MAX_DAMM_V2 + 1;
            let span = S_MAX_DAMM_V2 - 1; // hi = k·s_max = lo + span
            let (a, b) = if a <= b { (a, b) } else { (b, a) };
            let l = lo + span * a / 10_000;
            let l_big = lo + span * b / 10_000;
            (v, s, l, l_big)
        })
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: std::env::var("PROPTEST_CASES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2_000),
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    /// The definition: s = max{s : P(s) ≤ 0}.
    #[test]
    fn root_is_the_exact_floor(i in inputs()) {
        let s = floor_sqrt_q64(&i).expect("inputs are in range");
        prop_assert_ne!(residual_sign(&i, s), Ordering::Greater, "P(s) > 0 for {:?}", i);
        prop_assert_eq!(residual_sign(&i, s + 1), Ordering::Greater,
            "P(s+1) <= 0 for {:?}", i);
    }

    /// Monotone in V: more quote backing can only raise F (§4 harvest/deposit rows).
    #[test]
    fn monotone_in_v(i in inputs(), bump in 1u64..=u64::MAX) {
        let s0 = floor_sqrt_q64(&i).unwrap();
        let up = FloorInputs { v: i.v.saturating_add(bump), ..i };
        prop_assert!(floor_sqrt_q64(&up).unwrap() >= s0, "raising V lowered F: {:?}", i);
    }

    /// Antitone in S: more outstanding supply can only lower F.
    #[test]
    fn antitone_in_s(i in inputs(), extra in 1u64..=SUPPLY_MAX) {
        let s_big = i.s.saturating_add(extra).min(SUPPLY_MAX);
        let s0 = floor_sqrt_q64(&i).unwrap();
        let more = FloorInputs { s: s_big, ..i };
        // s_big >= i.s always; equal when already at the cap, where the floors must match.
        prop_assert!(floor_sqrt_q64(&more).unwrap() <= s0, "raising S raised F: {:?}", i);
    }

    /// Monotone in L — *within a ceiling step*.
    ///
    /// §14 lists "monotone in L" unconditionally. That holds for the exact rational equation but
    /// not for §4's conservative integer form: `A = S + ⌈L/s_max⌉`, so an increase in L that
    /// crosses a multiple of `s_max` adds a whole base unit to A while adding only Δ to B. When
    /// Δ ≪ s_max the A term dominates and F *falls*. Minimal counterexample, pinned in
    /// `ceiling_step_can_lower_f` below: V = u64::MAX, S = 1, L = 0 → 1.
    ///
    /// This cannot affect the mechanism: §4's transition table lists an L change as "Impossible
    /// (permanent lock, PDA-owned positions)", and a *decrease* is handled by the §8
    /// `BackingDecreased` fail-safe. Recorded in DECISIONS.md under "§4 vs §14 monotone-in-L".
    #[test]
    fn monotone_in_l_within_a_ceiling_step(
        (v, s, l, l_big) in l_pair_within_one_ceiling_step()
    ) {
        let i = FloorInputs { v, s, l, s_max: S_MAX_DAMM_V2 };
        let more = FloorInputs { l: l_big, ..i };

        // The strategy guarantees it, but assert it so a change to the strategy cannot quietly
        // turn this into a different property.
        prop_assert_eq!(l.div_ceil(S_MAX_DAMM_V2), l_big.div_ceil(S_MAX_DAMM_V2));
        prop_assert!(l_big >= l);

        let s0 = floor_sqrt_q64(&i).unwrap();
        let s1 = floor_sqrt_q64(&more).unwrap();
        prop_assert!(s1 >= s0,
            "raising L from {} to {} inside one ceiling step lowered F: {} -> {} ({:?})",
            l, l_big, s0, s1, i);
    }

    /// Payout never exceeds the exact value and the fee always costs the redeemer (§14
    /// `payout_le_exact`). The exact integer value is pinned by the §27 vectors and by the
    /// Python differential; what is checked here is the shape of the function over random input.
    #[test]
    fn payout_le_exact(amount in 0u64..=SUPPLY_MAX, i in inputs()) {
        let s = floor_sqrt_q64(&i).unwrap();
        let net = redeem_payout(amount, s, REDEEM_FEE_BPS);
        let gross = redeem_payout(amount, s, 0);

        prop_assert!(net <= gross, "the fee increased the payout");
        prop_assert_eq!(redeem_payout(0, s, REDEEM_FEE_BPS), 0, "dust paid out of nothing");

        // Subadditive in `amount`: flooring can lose at most one lamport per split, never gain
        // one. A redeemer must not profit by slicing a redemption in two (§12 "rounding
        // extraction"). Skipped once the payout saturates, where the sentinel is not additive.
        let half = amount / 2;
        let rest = amount - half;
        if net < u64::MAX {
            let split = redeem_payout(half, s, REDEEM_FEE_BPS)
                .saturating_add(redeem_payout(rest, s, REDEEM_FEE_BPS));
            prop_assert!(split <= net, "splitting a redemption paid more: {} > {}", split, net);
        }

        // A larger redemption never pays less.
        if amount < SUPPLY_MAX {
            prop_assert!(redeem_payout(amount + 1, s, REDEEM_FEE_BPS) >= net);
        }

        // An out-of-band fee is rejected rather than treated as zero.
        prop_assert_eq!(redeem_payout(amount, s, 10_001), 0, "fee > 100% paid out");
    }

    /// §4 redeem row: paying ⌊T·s²·(1−φ)/2^128⌋ for T burned tokens never lowers F.
    /// This is the single most important property in the crate.
    #[test]
    fn redeem_never_lowers_f((i, t) in inputs_and_amount()) {
        let s0 = floor_sqrt_q64(&i).unwrap();
        let payout = redeem_payout(t, s0, REDEEM_FEE_BPS);

        // §10 solvency and §4 SupplyZero are instruction preconditions: outside them the real
        // program reverts, so the floor is unchanged and there is nothing to check.
        if payout > i.v || t >= i.s {
            return Ok(());
        }

        let after = FloorInputs { v: i.v - payout, s: i.s - t, ..i };
        let s1 = floor_sqrt_q64(&after).unwrap();
        prop_assert!(s1 >= s0, "redeem of {} lowered F: {} -> {} ({:?})", t, s0, s1, i);
    }

    /// §4 bid-fill row: absorbing T tokens at any price b ≤ F never lowers F.
    #[test]
    fn bid_fill_never_lowers_f((i, t) in inputs_and_amount()) {
        let s0 = floor_sqrt_q64(&i).unwrap();
        let quote = redeem_payout(t, s0, 0);   // filled at exactly F: the worst allowed case

        if quote > i.v || t >= i.s {
            return Ok(());
        }

        let after = FloorInputs { v: i.v - quote, s: i.s - t, ..i };
        let s1 = floor_sqrt_q64(&after).unwrap();
        prop_assert!(s1 >= s0, "fill of {} at F lowered F: {} -> {} ({:?})", t, s0, s1, i);
    }

    /// §4 burn rows (leftover burn, filled-base burn): A -= T with no payout.
    #[test]
    fn burn_never_lowers_f((i, t) in inputs_and_amount()) {
        if t >= i.s {
            return Ok(());
        }
        let s0 = floor_sqrt_q64(&i).unwrap();
        let after = FloorInputs { s: i.s - t, ..i };
        prop_assert!(floor_sqrt_q64(&after).unwrap() >= s0, "burn of {} lowered F: {:?}", t, i);
    }

    /// A narrower pool range raises ⌈L/s_max⌉, so F must not rise (§1 correction 1).
    #[test]
    fn narrower_range_never_raises_f(
        i in inputs_with_positive_l(),
        divisor in 2u128..=1_000_000u128,
    ) {
        let narrow = FloorInputs { s_max: (i.s_max / divisor).max(1), ..i };
        let s_wide = floor_sqrt_q64(&i).unwrap();
        let s_narrow = floor_sqrt_q64(&narrow).unwrap();
        prop_assert!(s_narrow <= s_wide,
            "narrowing the range from {} to {} raised F: {} -> {} ({:?})",
            i.s_max, narrow.s_max, s_wide, s_narrow, i);
    }

    /// Out-of-range input is an error, never a value (§4).
    #[test]
    fn out_of_range_is_always_an_error(s in (SUPPLY_MAX + 1)..=u64::MAX, v in any::<u64>()) {
        let i = FloorInputs { v, s, l: 0, s_max: S_MAX_DAMM_V2 };
        prop_assert!(floor_sqrt_q64(&i).is_err(), "S above 2^50 returned a value");
    }
}

/// The counterexample to §14's unconditional "monotone in L", pinned so a future change to the
/// rounding cannot alter it unnoticed. See `monotone_in_l_within_a_ceiling_step`.
///
/// This is a property of §4's deliberately conservative `⌈L/s_max⌉`, not a defect: rounding A up
/// always understates F, which is the safe direction. It is unreachable in the protocol because
/// L is fixed at `open` and permanently locked.
#[test]
fn ceiling_step_can_lower_f() {
    let base = FloorInputs {
        v: u64::MAX,
        s: 1,
        l: 0,
        s_max: S_MAX_DAMM_V2,
    };
    let stepped = FloorInputs { l: 1, ..base };

    let s0 = floor_sqrt_q64(&base).unwrap();
    let s1 = floor_sqrt_q64(&stepped).unwrap();

    // ⌈0/s_max⌉ = 0 but ⌈1/s_max⌉ = 1, so A doubles from 1 to 2 while B gains only 1.
    assert_eq!(0u128.div_ceil(S_MAX_DAMM_V2), 0);
    assert_eq!(1u128.div_ceil(S_MAX_DAMM_V2), 1);
    assert!(
        s1 < s0,
        "the documented ceiling-step counterexample no longer holds: {s0} -> {s1}. \
         If the rounding in §4 changed, DECISIONS.md must be updated too."
    );

    // Both values are still exact floors of their own roots — neither is wrong.
    assert_ne!(residual_sign(&base, s0), Ordering::Greater);
    assert_eq!(residual_sign(&base, s0 + 1), Ordering::Greater);
    assert_ne!(residual_sign(&stepped, s1), Ordering::Greater);
    assert_eq!(residual_sign(&stepped, s1 + 1), Ordering::Greater);
}
