//! DLMM bin math and manual CPI builders for the bid (§9; D-007 / D-009: no Meteora program crates).
//!
//! Account order and discriminators follow the vendored IDL (`crates/meteora-types/idl/lb_clmm.json`,
//! lb_clmm 0.12.0); `tests/discriminators.rs` re-derives the discriminators from it. Remaining
//! accounts and `RemainingAccountsInfo` slices follow the dlmm SDK 1.9.10 builders used in Q5.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};

use crate::{DLMM_PROGRAM_ID, TOKEN_PROGRAM_ID};

/// DLMM's `__event_authority` PDA (pinned mainnet account `dlmm_event_authority`).
pub const DLMM_EVENT_AUTHORITY: Pubkey = pubkey!("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");
/// SPL Memo v2, which `cancel_limit_order` takes as `memo_program` (IDL address).
pub const MEMO_PROGRAM_ID: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/// IDL constants (`MAX_BIN_PER_ARRAY`, `BIN_ARRAY_BITMAP_SIZE`, `BASIS_POINT_MAX`).
pub const MAX_BIN_PER_ARRAY: i64 = 70;
pub const BIN_ARRAY_BITMAP_SIZE: i64 = 512;
const BASIS_POINT_MAX: u128 = 10_000;
const SCALE_OFFSET: u32 = 64;
const ONE: u128 = 1 << SCALE_OFFSET;
/// The SDK's `MAX_EXPONENTIAL` (`0x80000`): larger exponents have no price.
const MAX_EXPONENTIAL: u32 = 0x80000;

pub mod disc {
    pub const PLACE_LIMIT_ORDER: [u8; 8] = [108, 176, 33, 186, 146, 229, 1, 197];
    pub const CANCEL_LIMIT_ORDER: [u8; 8] = [132, 156, 132, 31, 67, 40, 232, 97];
    pub const CLOSE_LIMIT_ORDER_IF_EMPTY: [u8; 8] = [57, 124, 36, 155, 126, 249, 93, 171];
    pub const GO_TO_A_BIN: [u8; 8] = [146, 72, 174, 224, 40, 253, 84, 174];
}

/// Account discriminators (IDL `accounts`); `tests/discriminators.rs` re-derives them.
pub const BIN_ARRAY_DISCRIMINATOR: [u8; 8] = [92, 142, 92, 220, 5, 148, 70, 181];
pub const LIMIT_ORDER_DISCRIMINATOR: [u8; 8] = [137, 183, 212, 91, 115, 29, 141, 227];
pub const BITMAP_EXTENSION_DISCRIMINATOR: [u8; 8] = [80, 111, 124, 113, 55, 237, 18, 5];

/// `AccountsType` variant indices (IDL enum order).
const TRANSFER_HOOK_X: u8 = 0;
const TRANSFER_HOOK_Y: u8 = 1;

/// DLMM's Q64.64 price of bin `id`: `(1 + bin_step/10^4)^id`, exactly as the SDK's BN `pow` /
/// `getQPriceFromId` computes it (vendored, §9). `None` where DLMM has no price (result 0 or the
/// exponent out of range), so a caller can never compare against a fabricated value.
///
/// After the inversion step `squared` ≤ `ONE`, so every product is < 2^128; `checked_*` is kept
/// anyway so an impossible overflow is a `None`, not a wrap.
pub fn price_q64(id: i32, bin_step: u16) -> Option<u128> {
    if id == 0 {
        return Some(ONE);
    }
    let base = ONE.checked_add(((bin_step as u128) << SCALE_OFFSET) / BASIS_POINT_MAX)?;
    let mut invert = id < 0;
    let exp = id.unsigned_abs();
    if exp > MAX_EXPONENTIAL {
        return None;
    }
    let mut squared = base;
    let mut result = ONE;
    if squared >= result {
        squared = u128::MAX.checked_div(squared)?;
        invert = !invert;
    }
    let mut bit = 1u32;
    while bit <= 0x40000 {
        if exp & bit != 0 {
            result = result.checked_mul(squared)? >> SCALE_OFFSET;
        }
        if bit < 0x40000 {
            squared = squared.checked_mul(squared)? >> SCALE_OFFSET;
        }
        bit <<= 1;
    }
    if result == 0 {
        return None;
    }
    if invert {
        result = u128::MAX.checked_div(result)?;
    }
    Some(result)
}

/// Bin array index holding `id`: floor division by 70 (SDK `binIdToBinArrayIndex`).
pub fn bin_array_index(id: i32) -> i64 {
    (id as i64).div_euclid(MAX_BIN_PER_ARRAY)
}

/// `["bin_array", lb_pair, index as i64 LE]` under DLMM (SDK `deriveBinArray`).
pub fn bin_array_address(lb_pair: &Pubkey, index: i64) -> Pubkey {
    Pubkey::find_program_address(
        &[b"bin_array", lb_pair.as_ref(), &index.to_le_bytes()],
        &DLMM_PROGRAM_ID,
    )
    .0
}

/// `["bitmap", lb_pair]` under DLMM: the pair's bin-array bitmap extension (D-021). A CPI passes it
/// as `bin_array_bitmap_extension` when a bin's array lies outside the internal bitmap, else the
/// DLMM program id (Anchor's "None") — SDK `getBinArrayInfoForNonContiguousBinIds`.
pub fn bitmap_extension_address(lb_pair: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"bitmap", lb_pair.as_ref()], &DLMM_PROGRAM_ID).0
}

/// True when the bin's array lies outside the pair's internal bitmap (index beyond ±512).
pub fn needs_bitmap_extension(id: i32) -> bool {
    let idx = bin_array_index(id);
    !(-BIN_ARRAY_BITMAP_SIZE..=BIN_ARRAY_BITMAP_SIZE - 1).contains(&idx)
}

/// The pair accounts every bid CPI needs.
pub struct Pair {
    pub lb_pair: Pubkey,
    pub reserve_x: Pubkey,
    pub reserve_y: Pubkey,
    pub token_x_mint: Pubkey,
    pub token_y_mint: Pubkey,
}

/// The optional `bin_array_bitmap_extension` meta: Anchor encodes "None" as the program id, which
/// must be passed read-only (a writable executable account is a privilege escalation in a CPI).
fn bitmap_meta(bitmap_extension: &Pubkey) -> AccountMeta {
    if *bitmap_extension == DLMM_PROGRAM_ID {
        AccountMeta::new_readonly(DLMM_PROGRAM_ID, false)
    } else {
        AccountMeta::new(*bitmap_extension, false)
    }
}

fn slices(data: &mut Vec<u8>, kinds: &[u8]) {
    data.extend_from_slice(&(kinds.len() as u32).to_le_bytes());
    for &k in kinds {
        data.push(k);
        data.push(0); // no transfer-hook accounts: SPL base mint and SPL WSOL
    }
}

/// `place_limit_order`: a bid (`is_ask_side = false`) of `amount` quote in one bin.
#[allow(clippy::too_many_arguments)]
pub fn place_bid(
    p: &Pair,
    bitmap_extension: &Pubkey,
    limit_order: &Pubkey,
    payer: &Pubkey,
    owner: &Pubkey,
    user_token: &Pubkey,
    sender: &Pubkey,
    bin_array: &Pubkey,
    bin_id: i32,
    amount: u64,
) -> Instruction {
    let mut data = disc::PLACE_LIMIT_ORDER.to_vec();
    data.push(0); // is_ask_side = false
    data.extend_from_slice(&[0u8; 16]); // padding
    data.push(0); // relative_bin = None: `bins[].id` is absolute
    data.extend_from_slice(&1u32.to_le_bytes());
    data.extend_from_slice(&bin_id.to_le_bytes());
    data.extend_from_slice(&amount.to_le_bytes());
    slices(&mut data, &[TRANSFER_HOOK_Y]);
    Instruction {
        program_id: DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(p.lb_pair, false),
            bitmap_meta(bitmap_extension),
            AccountMeta::new(p.reserve_y, false),
            AccountMeta::new_readonly(p.token_y_mint, false),
            AccountMeta::new(*limit_order, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new(*user_token, false),
            AccountMeta::new_readonly(*sender, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
            AccountMeta::new_readonly(DLMM_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(DLMM_PROGRAM_ID, false),
            AccountMeta::new(*bin_array, false),
        ],
        data,
    }
}

/// `cancel_limit_order(bins = [bin_id])`: filled base to `dest_x`, unfilled quote + fees to `dest_y`.
#[allow(clippy::too_many_arguments)]
pub fn cancel(
    p: &Pair,
    bitmap_extension: &Pubkey,
    limit_order: &Pubkey,
    dest_x: &Pubkey,
    dest_y: &Pubkey,
    owner: &Pubkey,
    bin_array: &Pubkey,
    bin_id: i32,
) -> Instruction {
    let mut data = disc::CANCEL_LIMIT_ORDER.to_vec();
    data.extend_from_slice(&1u32.to_le_bytes());
    data.extend_from_slice(&bin_id.to_le_bytes());
    slices(&mut data, &[TRANSFER_HOOK_X, TRANSFER_HOOK_Y]);
    Instruction {
        program_id: DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(p.lb_pair, false),
            bitmap_meta(bitmap_extension),
            AccountMeta::new(p.reserve_x, false),
            AccountMeta::new(p.reserve_y, false),
            AccountMeta::new_readonly(p.token_x_mint, false),
            AccountMeta::new_readonly(p.token_y_mint, false),
            AccountMeta::new(*limit_order, false),
            AccountMeta::new(*dest_x, false),
            AccountMeta::new(*dest_y, false),
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(MEMO_PROGRAM_ID, false),
            AccountMeta::new_readonly(DLMM_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(DLMM_PROGRAM_ID, false),
            AccountMeta::new(*bin_array, false),
        ],
        data,
    }
}

/// `go_to_a_bin(bin_id)` (D-020, D-021): moves the pair's active bin when no liquidity lies in between.
/// Permissionless (no signer). The bin arrays are optional: pass the ones that exist, as the SDK's
/// `syncWithMarketPrice` does; an absent one is "None" (the program id, read-only).
pub fn go_to_a_bin(
    lb_pair: &Pubkey,
    bitmap_extension: Option<Pubkey>,
    from_bin_array: Option<Pubkey>,
    to_bin_array: Option<Pubkey>,
    bin_id: i32,
) -> Instruction {
    let opt = |k: Option<Pubkey>| AccountMeta::new_readonly(k.unwrap_or(DLMM_PROGRAM_ID), false);
    let mut data = disc::GO_TO_A_BIN.to_vec();
    data.extend_from_slice(&bin_id.to_le_bytes());
    Instruction {
        program_id: DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*lb_pair, false),
            opt(bitmap_extension), // D-021: the pair's extension when an array lies outside the bitmap
            opt(from_bin_array),
            opt(to_bin_array),
            AccountMeta::new_readonly(DLMM_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(DLMM_PROGRAM_ID, false),
        ],
        data,
    }
}

/// `close_limit_order_if_empty`: closes the cancelled order, rent to `rent_receiver`.
pub fn close_if_empty(limit_order: &Pubkey, owner: &Pubkey, rent_receiver: &Pubkey) -> Instruction {
    Instruction {
        program_id: DLMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*limit_order, false),
            AccountMeta::new_readonly(*owner, true),
            AccountMeta::new(*rent_receiver, false),
            AccountMeta::new_readonly(DLMM_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(DLMM_PROGRAM_ID, false),
        ],
        data: disc::CLOSE_LIMIT_ORDER_IF_EMPTY.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `(id, bin_step, price)` from the SDK's exact BN `getQPriceFromId`
    /// (`tests/integration/program/tools/dlmm-price-vectors.ts`); `0` there means "no price".
    const SDK: &[(i32, u16, u128)] = &[
        (0, 1, 18446744073709551616),
        (1, 1, 18448588748116922571),
        (-1, 1, 18444899583751176498),
        (69, 1, 18574460336529624015),
        (-71, 1, 18316242544370393927),
        (-1000, 1, 16691387729992145910),
        (-11920, 1, 5601013020900378114),
        (100000, 1, 406113483393644920993599),
        (-100000, 1, 837899702510255),
        (1, 10, 18465190817783261167),
        (-1, 10, 18428315757951600016),
        (2, 10, 18483656008601044429),
        (-2, 10, 18409905852099500515),
        (70, 10, 19783591960007384784),
        (-70, 10, 17200231768266385305),
        (-71, 10, 17183048719546838466),
        (1000, 10, 50118400445692101499),
        (-1000, 10, 6789569577138953565),
        (-11003, 10, 308862525001043),
        (-11004, 10, 308553971030012),
        (-11920, 10, 123513995008195),
        (-11921, 10, 123390604403792),
        (-12000, 10, 114022345563993),
        (20000, 10, 8860726036540184572323860509),
        (-50000, 10, 0),
        (100000, 10, 0),
        (-11003, 25, 21600925),
        (-12000, 25, 1792025),
        (20000, 25, 0),
        (-70, 50, 13010542315544101046),
        (1000, 50, 2703843053091971336639),
        (-11003, 50, 0),
    ];

    #[test]
    fn price_matches_the_sdk_bit_for_bit() {
        for &(id, step, want) in SDK {
            let got = price_q64(id, step).unwrap_or(0);
            assert_eq!(got, want, "id {id} step {step}");
        }
    }

    #[test]
    fn prices_strictly_increase_with_the_bin() {
        for id in -12_100..-11_800 {
            assert!(price_q64(id, 10).unwrap() < price_q64(id + 1, 10).unwrap());
        }
    }

    /// SDK `binIdToBinArrayIndex` (same tool).
    #[test]
    fn bin_array_index_floors() {
        for &(id, idx) in &[
            (-1, -1),
            (-69, -1),
            (-70, -1),
            (-71, -2),
            (-140, -2),
            (-141, -3),
            (-11920, -171),
            (0, 0),
            (69, 0),
            (70, 1),
        ] {
            assert_eq!(bin_array_index(id), idx, "id {id}");
        }
    }

    /// Class bins (≈ −12,000 at 10 bps) sit inside the internal bitmap (array index ±512 = bins
    /// −35,840 … 35,839); the D-021 pin at −40,000 needs the extension.
    #[test]
    fn bitmap_extension_boundary() {
        assert!(!needs_bitmap_extension(-11_920));
        assert!(!needs_bitmap_extension(-11_003));
        assert!(!needs_bitmap_extension(-35_840));
        assert!(!needs_bitmap_extension(35_839));
        assert!(needs_bitmap_extension(-35_841));
        assert!(needs_bitmap_extension(35_840));
        assert!(needs_bitmap_extension(-40_000));
        let pair = Pubkey::new_unique();
        assert_eq!(
            bitmap_extension_address(&pair),
            Pubkey::find_program_address(&[b"bitmap", pair.as_ref()], &DLMM_PROGRAM_ID).0
        );
    }

    #[test]
    fn event_authority_is_the_pda() {
        let (pda, _) = Pubkey::find_program_address(&[b"__event_authority"], &DLMM_PROGRAM_ID);
        assert_eq!(pda, DLMM_EVENT_AUTHORITY);
    }
}
