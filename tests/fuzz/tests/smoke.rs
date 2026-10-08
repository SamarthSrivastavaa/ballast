//! The model fuzzer in the ordinary test run: a short sweep on fixed seeds (the 1M-step gate runs
//! with `cargo run -p ballast-fuzz --release`).

use ballast_fuzz::{floor_bin, run, Leg, Model, Stats, Wallet, HOLDERS};

#[test]
fn twenty_thousand_steps_hold_every_invariant() {
    let mut stats = Stats::default();
    for seed in 1..=4u64 {
        run(seed, 5_000, 1_000, &mut stats).unwrap();
    }
    assert!(stats.sellouts >= 20);
    assert!(stats.min_exec_ppm >= 990_000);
}

/// The measured Proof launch at `open` (evidence/program/part2/results.json): vault 1.54 SOL,
/// S ≈ 865M tokens, L ≈ 3.07e31, pool quote 8.483 SOL (Q14), p0 bin −12,645.
fn proof_launch() -> Model {
    let mut holders = [Wallet::default(); HOLDERS];
    let held = 865_441_059_871_809u64 - 326_550_581_591_072;
    for (i, w) in holders.iter_mut().enumerate() {
        w.base = if i == 0 {
            held - (HOLDERS as u64 - 1) * (held / 8)
        } else {
            held / 8
        };
    }
    let l = 30_702_214_157_579_652_106_863_560_058_426u128;
    let pool_s = ((8_483_000_000f64 * 2f64.powi(128)) / l as f64) as u128 + ballast_fuzz::S_MIN;
    Model::open(holders, l, pool_s, 1_540_404_041, -12_645).unwrap()
}

/// The Proof launch, unperturbed: open places the bid at F's bin and a full sell-out clears at or
/// above 0.99·F with the pool ending at or above F.
#[test]
fn proof_launch_sells_out_at_the_floor() {
    let so = proof_launch().sellout(500).unwrap();
    assert!(so.exec_ppm >= 990_000, "{so:?}");
    assert!(so.pool_ppm >= 999_999, "{so:?}");
}

/// D-021: a pin deeper than 70 bins suspends the DLMM leg; redemption still clears the sell-out.
#[test]
fn suspended_leg_still_sells_out() {
    let mut m = proof_launch();
    // Sellers consume the whole bid; DLMM's active bin then sits below it.
    for h in 0..HOLDERS {
        while m.bid_live() && m.bid_fill(h, u64::MAX).unwrap().is_some() {}
    }
    assert!(!m.bid_live());
    // A third party pins the active bin 5,000 bins under F; the keeper's refresh suspends.
    let s = m.s_now().unwrap();
    assert!(m.pin_at(floor_bin(s) - 5_000));
    m.refresh_floor().unwrap();
    assert_eq!(m.leg, Leg::Suspended);
    m.check().unwrap();
    let so = m.sellout(300).unwrap();
    assert!(so.exec_ppm >= 990_000, "{so:?}");
}
