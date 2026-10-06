//! Manual DBC CPI builders (D-007 / D-009: no Meteora program crates). Account order and
//! discriminators follow the vendored IDL (`crates/meteora-types/idl/dynamic_bonding_curve.json`);
//! `tests/discriminators.rs` re-derives the discriminators from it.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};

use crate::{DBC_PROGRAM_ID, TOKEN_PROGRAM_ID};

/// DBC's constant `pool_authority` (IDL address) and its `__event_authority` PDA.
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
pub const DBC_EVENT_AUTHORITY: Pubkey = pubkey!("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF");

pub mod disc {
    pub const WITHDRAW_MIGRATION_FEE: [u8; 8] = [237, 142, 45, 23, 129, 6, 222, 162];
    pub const CLAIM_TRADING_FEE: [u8; 8] = [8, 236, 89, 49, 152, 125, 177, 81];
    pub const CLAIM_CREATOR_TRADING_FEE: [u8; 8] = [82, 220, 250, 189, 3, 85, 107, 45];
    pub const WITHDRAW_LEFTOVER: [u8; 8] = [20, 198, 202, 237, 235, 243, 183, 66];
    pub const PARTNER_WITHDRAW_SURPLUS: [u8; 8] = [168, 173, 72, 100, 201, 98, 38, 92];
}

/// `withdraw_migration_fee` partner flag (SDK: `role === "partner" ? 0 : 1`, STEP 3 Q4).
pub const MIGRATION_FEE_FLAG_PARTNER: u8 = 0;

fn ix(accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    let mut accounts = accounts;
    accounts.push(AccountMeta::new_readonly(DBC_EVENT_AUTHORITY, false));
    accounts.push(AccountMeta::new_readonly(DBC_PROGRAM_ID, false));
    Instruction {
        program_id: DBC_PROGRAM_ID,
        accounts,
        data,
    }
}

pub struct Pool {
    pub config: Pubkey,
    pub pool: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
}

/// `withdraw_migration_fee(flag)`: pool_authority, config, virtual_pool (w), token_quote_account (w),
/// quote_vault (w), quote_mint, sender (s), token_quote_program, event_authority, program.
pub fn withdraw_migration_fee(
    p: &Pool,
    dest_quote: &Pubkey,
    sender: &Pubkey,
    flag: u8,
) -> Instruction {
    let mut data = disc::WITHDRAW_MIGRATION_FEE.to_vec();
    data.push(flag);
    ix(
        vec![
            AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
            AccountMeta::new_readonly(p.config, false),
            AccountMeta::new(p.pool, false),
            AccountMeta::new(*dest_quote, false),
            AccountMeta::new(p.quote_vault, false),
            AccountMeta::new_readonly(p.quote_mint, false),
            AccountMeta::new_readonly(*sender, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        data,
    )
}

fn max_amounts(disc: [u8; 8]) -> Vec<u8> {
    let mut data = disc.to_vec();
    data.extend_from_slice(&u64::MAX.to_le_bytes());
    data.extend_from_slice(&u64::MAX.to_le_bytes());
    data
}

/// `claim_trading_fee(u64::MAX, u64::MAX)`: pool_authority, config, pool (w), token_a_account (w),
/// token_b_account (w), base_vault (w), quote_vault (w), base_mint, quote_mint, fee_claimer (s),
/// token_base_program, token_quote_program, event_authority, program.
pub fn claim_trading_fee(
    p: &Pool,
    dest_base: &Pubkey,
    dest_quote: &Pubkey,
    fee_claimer: &Pubkey,
) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
            AccountMeta::new_readonly(p.config, false),
            AccountMeta::new(p.pool, false),
            AccountMeta::new(*dest_base, false),
            AccountMeta::new(*dest_quote, false),
            AccountMeta::new(p.base_vault, false),
            AccountMeta::new(p.quote_vault, false),
            AccountMeta::new_readonly(p.base_mint, false),
            AccountMeta::new_readonly(p.quote_mint, false),
            AccountMeta::new_readonly(*fee_claimer, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        max_amounts(disc::CLAIM_TRADING_FEE),
    )
}

/// `claim_creator_trading_fee(u64::MAX, u64::MAX)`: pool_authority, pool (w), token_a_account (w),
/// token_b_account (w), base_vault (w), quote_vault (w), base_mint, quote_mint, creator (s),
/// token_base_program, token_quote_program, event_authority, program.
pub fn claim_creator_trading_fee(
    p: &Pool,
    dest_base: &Pubkey,
    dest_quote: &Pubkey,
    creator: &Pubkey,
) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
            AccountMeta::new(p.pool, false),
            AccountMeta::new(*dest_base, false),
            AccountMeta::new(*dest_quote, false),
            AccountMeta::new(p.base_vault, false),
            AccountMeta::new(p.quote_vault, false),
            AccountMeta::new_readonly(p.base_mint, false),
            AccountMeta::new_readonly(p.quote_mint, false),
            AccountMeta::new_readonly(*creator, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        max_amounts(disc::CLAIM_CREATOR_TRADING_FEE),
    )
}

/// `withdraw_leftover()` (permissionless): pool_authority, config, virtual_pool (w),
/// token_base_account (w), base_vault (w), base_mint, leftover_receiver, token_base_program,
/// event_authority, program.
pub fn withdraw_leftover(p: &Pool, dest_base: &Pubkey, leftover_receiver: &Pubkey) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
            AccountMeta::new_readonly(p.config, false),
            AccountMeta::new(p.pool, false),
            AccountMeta::new(*dest_base, false),
            AccountMeta::new(p.base_vault, false),
            AccountMeta::new_readonly(p.base_mint, false),
            AccountMeta::new_readonly(*leftover_receiver, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        disc::WITHDRAW_LEFTOVER.to_vec(),
    )
}

/// `partner_withdraw_surplus()`: pool_authority, config, virtual_pool (w), token_quote_account (w),
/// quote_vault (w), quote_mint, fee_claimer (s), token_quote_program, event_authority, program.
pub fn partner_withdraw_surplus(
    p: &Pool,
    dest_quote: &Pubkey,
    fee_claimer: &Pubkey,
) -> Instruction {
    ix(
        vec![
            AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
            AccountMeta::new_readonly(p.config, false),
            AccountMeta::new(p.pool, false),
            AccountMeta::new(*dest_quote, false),
            AccountMeta::new(p.quote_vault, false),
            AccountMeta::new_readonly(p.quote_mint, false),
            AccountMeta::new_readonly(*fee_claimer, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        disc::PARTNER_WITHDRAW_SURPLUS.to_vec(),
    )
}
