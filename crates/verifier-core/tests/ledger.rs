//! §10's accounting ledger: the reconciliation `ballast verify` runs on a launch's counters.

use verifier_core::ledger::{event_totals_match, EventTotals, QuoteLedger};

/// §10's Public table: 3.75 migration fee + 0.101 partner fees, all resting in the bid at `open`.
fn public_at_open() -> QuoteLedger {
    QuoteLedger {
        migration_fee: 3_750_000_000,
        partner_fees: 101_010_101,
        ..Default::default()
    }
}

#[test]
fn spec_public_ledger_reconciles_at_open() {
    let l = public_at_open();
    assert_eq!(l.expected_v(), Some(3_851_010_101));
    assert_eq!(l.quote_excess(3_851_010_101), Some(0));
}

#[test]
fn every_flow_moves_the_expected_backing_by_its_own_amount() {
    let mut l = public_at_open();
    l.surplus = 7;
    l.harvested = 15_062_311;
    l.deposited = 200_000_000;
    l.fill_quote_spent = 1_000_000_000;
    l.redeemed_lamports = 66_123_456;
    let v = 3_851_010_101 + 7 + 15_062_311 + 200_000_000 - 1_000_000_000 - 66_123_456;
    assert_eq!(l.expected_v(), Some(v));
    assert_eq!(l.quote_excess(v), Some(0));
}

#[test]
fn a_missing_lamport_is_a_failure_not_a_rounding() {
    let l = public_at_open();
    assert_eq!(l.quote_excess(3_851_010_100), None);
}

#[test]
fn quote_sent_straight_to_the_vault_shows_as_excess() {
    let l = public_at_open();
    assert_eq!(l.quote_excess(3_851_010_101 + 5_000), Some(5_000));
}

#[test]
fn outflows_above_inflows_do_not_reconcile() {
    let l = QuoteLedger {
        migration_fee: 10,
        redeemed_lamports: 11,
        ..Default::default()
    };
    assert_eq!(l.expected_v(), None);
    assert_eq!(l.quote_excess(0), None);
}

#[test]
fn token_ledger_is_minted_less_burned() {
    // §10: 1,000M = 538.2M holders + 327.2M pool + 134.6M burned.
    let minted = 1_000_000_000_000_000u64;
    let burned = 134_600_000_000_000u64;
    assert_eq!(
        QuoteLedger::token_excess(minted, minted - burned, burned),
        Some(0)
    );
    // A holder burning their own tokens lowers the supply further: reported, never a failure.
    assert_eq!(
        QuoteLedger::token_excess(minted, minted - burned - 9, burned),
        Some(9)
    );
    // More supply than minted less burned cannot happen with the mint authority removed.
    assert_eq!(
        QuoteLedger::token_excess(minted, minted - burned + 1, burned),
        None
    );
    assert_eq!(QuoteLedger::token_excess(10, 0, 11), None);
}

#[test]
fn events_must_sum_to_the_counters() {
    let mut l = public_at_open();
    l.harvested = 30;
    l.deposited = 40;
    l.redeemed_lamports = 50;
    l.surplus = 2;
    let mut e = EventTotals {
        migration_fee: 3_750_000_000,
        partner_fees: 101_010_101,
        surplus: 2,
        harvested: 30,
        deposited: 40,
        redeemed_lamports: 50,
    };
    assert!(event_totals_match(&l, &e));
    e.redeemed_lamports = 49;
    assert!(!event_totals_match(&l, &e));
}
