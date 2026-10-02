//! D-004: the drop in `F` at a `⌈L/s_max⌉` step is bounded by one base unit of supply.
//!
//! §14's unconditional "monotone in L" is false for §4's conservative `A = S + ⌈L/s_max⌉`: an
//! increase in `L` that crosses a multiple of `s_max` adds a whole base unit to `A` while adding
//! only `ΔL` to `B`, so `F` can fall. `monotone_in_l_within_a_ceiling_step` covers the interior of
//! a step and `ceiling_step_can_lower_f` pins the counterexample. This file closes the remaining
//! question: **how far can it fall?**
//!
//! The bound required by D-004: at a ceiling step,
//!
//! ```text
//! s(V, S, L + ΔL)  ≥  s(V, S, L) computed with A + 1
//! ```
//!
//! Since `A = S + ⌈L/s_max⌉`, incrementing `A` by one is *exactly* incrementing `S` by one, so the
//! right-hand side is `s(V, S + 1, L)` — a quantity the public API can compute directly. The whole
//! drop is therefore attributable to the `+1` in `A`, which is one base unit of supply; the `ΔL`
//! added to `B` can only help. Proof sketch: both sides share the same `A = S + ⌈L/s_max⌉ + 1`, and
//! `P(s) = A·s² − B·s − C` is decreasing in `B`, so a larger `B` moves the root right.
//!
//! None of this is reachable in the protocol: `L` is fixed at `open` and permanently locked, so the
//! mechanism never takes this transition (§4's transition table lists an L change as "Impossible").

// Test arithmetic is not protocol arithmetic: an overflow here is a test failure, which is
// exactly what should happen. The lint stays on for `src/` (see lib.rs).
#![allow(clippy::arithmetic_side_effects)]

use ballast_floor::{floor_sqrt_q64, FloorInputs, L_MAX, SUPPLY_MAX, S_MAX_DAMM_V2};
use proptest::prelude::*;

/// `(V, S, L, L')` where `L` sits in ceiling step `k` and `L'` in step `k+1`, so the ceiling term
/// rises by **exactly one**. `⌈L/s_max⌉ = k` for `L ∈ ((k−1)·s_max, k·s_max]`.
///
/// `S` is capped at `SUPPLY_MAX − 1` so that `S + 1` is still a legal input.
fn across_one_ceiling_step() -> impl Strategy<Value = (u64, u64, u128, u128)> {
    // (k+1)·s_max must stay inside L_MAX: L_MAX / s_max ≈ 1.678e7.
    const K_MAX: u128 = 16_700_000;
    (
        prop_oneof![
            Just(0u64),
            Just(1u64),
            1u64..=1_000_000_000_000u64,
            Just(u64::MAX)
        ],
        prop_oneof![Just(1u64), 1u64..=(SUPPLY_MAX - 1), Just(SUPPLY_MAX - 1)],
        1u128..=K_MAX,
        0u128..=10_000u128,
        0u128..=10_000u128,
    )
        .prop_map(|(v, s, k, a, b)| {
            let span = S_MAX_DAMM_V2 - 1;
            let l = (k - 1) * S_MAX_DAMM_V2 + 1 + span * a / 10_000; // step k
            let l_next = k * S_MAX_DAMM_V2 + 1 + span * b / 10_000; // step k+1
            (v, s, l, l_next.min(L_MAX))
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

    /// The D-004 bound: crossing a ceiling step costs at most what adding one base unit of supply
    /// would cost, and never more.
    #[test]
    fn ceiling_step_drop_is_bounded_by_one_base_unit(
        (v, s, l, l_next) in across_one_ceiling_step()
    ) {
        let before = FloorInputs { v, s, l, s_max: S_MAX_DAMM_V2 };
        let after = FloorInputs { l: l_next, ..before };
        // `A + 1` for the *same* L, expressed through the public API: A = S + ⌈L/s_max⌉, so
        // bumping A by one is bumping S by one.
        let a_plus_one = FloorInputs { s: s + 1, ..before };

        // The strategy's contract, asserted so a change to it cannot silently alter the property.
        let step_before = l.div_ceil(S_MAX_DAMM_V2);
        let step_after = l_next.div_ceil(S_MAX_DAMM_V2);
        prop_assume!(step_after == step_before + 1);

        let s_after = floor_sqrt_q64(&after).unwrap();
        let s_bound = floor_sqrt_q64(&a_plus_one).unwrap();

        prop_assert!(
            s_after >= s_bound,
            "crossing a ceiling step cost more than one base unit of supply:\n  \
             s(L+ΔL) = {}\n  s(A+1)  = {}\n  V={} S={} L={} L'={}",
            s_after, s_bound, v, s, l, l_next
        );
    }

    /// Restated as the consequence that matters: the floor never drops below what it would be with
    /// one extra base unit outstanding. A whole-token drop would be a different kind of defect.
    #[test]
    fn ceiling_step_drop_is_never_a_whole_token(
        (v, s, l, l_next) in across_one_ceiling_step()
    ) {
        let before = FloorInputs { v, s, l, s_max: S_MAX_DAMM_V2 };
        let after = FloorInputs { l: l_next, ..before };
        prop_assume!(l_next.div_ceil(S_MAX_DAMM_V2) == l.div_ceil(S_MAX_DAMM_V2) + 1);

        // One token is 10^6 base units (§4 units table).
        let one_token_worse = FloorInputs { s: (s + 1_000_000).min(SUPPLY_MAX), ..before };

        prop_assert!(
            floor_sqrt_q64(&after).unwrap() >= floor_sqrt_q64(&one_token_worse).unwrap(),
            "ceiling step cost more than a whole token of supply (V={} S={} L={} L'={})",
            v, s, l, l_next
        );
    }
}

/// The bound, on the exact counterexample `ceiling_step_can_lower_f` pins.
///
/// `V = u64::MAX, S = 1, L = 0 → 1`: `⌈0/s_max⌉ = 0` and `⌈1/s_max⌉ = 1`, so `A` goes 1 → 2. The
/// resulting `s` must equal what `S = 2, L = 0` gives, because at `L = 1` the `B·s` term is
/// negligible beside `C = V·2^128` — this is the worst case for the bound, and it holds with
/// equality rather than violating it.
#[test]
fn bound_holds_with_equality_on_the_known_counterexample() {
    let base = FloorInputs {
        v: u64::MAX,
        s: 1,
        l: 0,
        s_max: S_MAX_DAMM_V2,
    };
    let stepped = FloorInputs { l: 1, ..base };
    let a_plus_one = FloorInputs { s: 2, ..base };

    let s_stepped = floor_sqrt_q64(&stepped).unwrap();
    let s_bound = floor_sqrt_q64(&a_plus_one).unwrap();

    assert!(
        s_stepped >= s_bound,
        "D-004 bound violated on the known counterexample: {s_stepped} < {s_bound}"
    );
    assert_eq!(
        s_stepped, s_bound,
        "expected the bound to bind exactly here (A is the only thing that changed)"
    );
}
