//! `execution_ppm`: what a seller received per token, against F. Account rent that comes back when
//! a token account is closed is not sale proceeds and must not count (11 Oct: it did, and inflated
//! every execution in the sell-out by one account's rent).

use anchor_lang::prelude::Pubkey;
use verifier_core::rpc::Tx;
use verifier_core::verify::execution_ppm;

const RENT: u64 = 2_039_280;
const FEE: u64 = 5_000;
/// s = 2^64 makes F exactly 1 lamport per base unit, so ppm reads as lamports per base unit × 1e6.
const S_ONE: u128 = 1 << 64;

fn wsol() -> Pubkey {
    "So11111111111111111111111111111111111111112"
        .parse()
        .unwrap()
}

/// A sell of `sold` base units by the signer (account 0). Account 1 is the base token account,
/// account 2 the WSOL account.
fn sell(sold: u64, base: &Pubkey) -> Tx {
    let signer = Pubkey::new_unique();
    Tx {
        slot: 1,
        failed: false,
        logs: vec![],
        fee: FEE,
        keys: vec![signer, Pubkey::new_unique(), Pubkey::new_unique()],
        pre_lamports: vec![10_000_000_000, RENT, 0],
        post_lamports: vec![10_000_000_000, RENT, 0],
        pre_tokens: vec![(1, *base, signer, sold)],
        post_tokens: vec![(1, *base, signer, 0)],
        instructions: vec![],
    }
}

#[test]
fn wsol_credited_to_an_account_that_stays_open() {
    let base = Pubkey::new_unique();
    let mut tx = sell(1_048_576, &base);
    let signer = tx.keys[0];
    tx.pre_lamports[2] = RENT;
    tx.post_lamports[2] = RENT + 786_432;
    tx.pre_tokens.push((2, wsol(), signer, 0));
    tx.post_tokens.push((2, wsol(), signer, 786_432));
    tx.post_lamports[0] -= FEE;
    assert_eq!(execution_ppm(&tx, &base, S_ONE), Some(750_000));
}

#[test]
fn rent_of_a_pre_existing_wsol_account_closed_in_the_sell_is_not_proceeds() {
    let base = Pubkey::new_unique();
    let mut tx = sell(1_048_576, &base);
    let signer = tx.keys[0];
    // The WSOL account existed before (funded by anyone), received 990,000 and was closed to the
    // signer: the signer's lamports rise by the proceeds AND the account's rent.
    tx.pre_lamports[2] = RENT;
    tx.post_lamports[2] = 0;
    tx.pre_tokens.push((2, wsol(), signer, 0));
    tx.post_lamports[0] = tx.pre_lamports[0] + 786_432 + RENT - FEE;
    assert_eq!(execution_ppm(&tx, &base, S_ONE), Some(750_000));
}

#[test]
fn a_wsol_account_created_and_closed_inside_the_sell_nets_to_the_proceeds() {
    let base = Pubkey::new_unique();
    let mut tx = sell(1_048_576, &base);
    // Not in the pre-state and not in the post-state: the signer paid its rent and got it back.
    tx.post_lamports[0] = tx.pre_lamports[0] + 786_432 - FEE;
    assert_eq!(execution_ppm(&tx, &base, S_ONE), Some(750_000));
}

#[test]
fn wsol_already_held_in_the_closed_account_is_not_proceeds_either() {
    let base = Pubkey::new_unique();
    let mut tx = sell(1_048_576, &base);
    let signer = tx.keys[0];
    tx.pre_lamports[2] = RENT + 500_000;
    tx.post_lamports[2] = 0;
    tx.pre_tokens.push((2, wsol(), signer, 500_000));
    tx.post_lamports[0] = tx.pre_lamports[0] + 500_000 + 786_432 + RENT - FEE;
    assert_eq!(execution_ppm(&tx, &base, S_ONE), Some(750_000));
}

#[test]
fn rent_of_a_closed_base_token_account_is_not_proceeds() {
    let base = Pubkey::new_unique();
    let mut tx = sell(1_048_576, &base);
    // The seller sold the whole balance and closed the base token account too.
    tx.post_tokens.clear();
    tx.post_lamports[1] = 0;
    tx.post_lamports[0] = tx.pre_lamports[0] + 786_432 + RENT - FEE;
    assert_eq!(execution_ppm(&tx, &base, S_ONE), Some(750_000));
}
