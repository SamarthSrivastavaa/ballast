//! D-011: `register_launch` verifies its own transaction through the instructions sysvar.
//!
//! A launch is ONE transaction: DBC pool creation → the payer's dust first buy → DLMM LimitOrder
//! pair creation (payer as funder) → `transfer_pool_creator` to `creator_auth` → `register_launch`.
//! Every instruction BEFORE `register_launch` is inspected:
//!
//! - DBC: only pool creation (for this pool, this config, this base mint, by this creator),
//!   pool metadata, at most ONE swap (on this pool, by the payer, ≤ the class dust limit), and the
//!   creator transfer (this pool, this creator → `creator_auth`). Anything else is refused.
//! - DLMM: only the customizable pair creation, at the expected pair address. Anything else is
//!   refused.
//!
//! Introspection sees top-level instructions only, so a buy hidden inside some other program's CPI
//! would be invisible here. `register_launch` therefore ALSO checks DBC's state — the pool's quote
//! reserve must not exceed the dust limit — which no hidden buy can avoid moving.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

use crate::errors::BallastError;
use crate::{DBC_PROGRAM_ID, DLMM_PROGRAM_ID};

/// Anchor discriminators, `sha256("global:<name>")[..8]`. `tests/discriminators.rs` re-derives them
/// from the vendored IDLs so a typo cannot slip in.
pub mod disc {
    pub const DBC_INIT_POOL_SPL: [u8; 8] = [140, 85, 215, 176, 102, 54, 104, 79];
    pub const DBC_INIT_POOL_TOKEN2022: [u8; 8] = [169, 118, 51, 78, 145, 110, 220, 155];
    pub const DBC_CREATE_POOL_METADATA: [u8; 8] = [45, 97, 187, 103, 254, 109, 124, 134];
    pub const DBC_SWAP: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];
    pub const DBC_SWAP2: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];
    pub const DBC_TRANSFER_POOL_CREATOR: [u8; 8] = [20, 7, 169, 33, 58, 147, 166, 33];
    pub const DLMM_INIT_CUSTOMIZABLE_PAIR: [u8; 8] = [46, 39, 41, 135, 111, 183, 200, 64];
    pub const DLMM_INIT_CUSTOMIZABLE_PAIR2: [u8; 8] = [243, 73, 129, 126, 51, 19, 241, 107];
}

/// Account positions in each instruction, from the vendored IDLs (`crates/meteora-types/idl`).
mod idx {
    // DBC initialize_virtual_pool_with_spl_token
    pub const INIT_CONFIG: usize = 0;
    pub const INIT_CREATOR: usize = 2;
    pub const INIT_BASE_MINT: usize = 3;
    pub const INIT_POOL: usize = 5;
    // DBC swap / swap2
    pub const SWAP_POOL: usize = 2;
    pub const SWAP_PAYER: usize = 9;
    // DBC transfer_pool_creator
    pub const TPC_POOL: usize = 0;
    pub const TPC_CREATOR: usize = 2;
    pub const TPC_NEW_CREATOR: usize = 3;
    // DLMM initialize_customizable_permissionless_lb_pair(2)
    pub const PAIR_LB_PAIR: usize = 0;
}

/// What `register_launch` expects this transaction to contain.
pub struct Expect {
    pub config: Pubkey,
    pub pool: Pubkey,
    pub base_mint: Pubkey,
    pub creator: Pubkey,
    pub creator_auth: Pubkey,
    pub payer: Pubkey,
    pub dlmm_pair: Pubkey,
    pub dust_limit: u64,
}

fn key_at(ix: &anchor_lang::solana_program::instruction::Instruction, i: usize) -> Result<Pubkey> {
    ix.accounts
        .get(i)
        .map(|a| a.pubkey)
        .ok_or_else(|| error!(BallastError::LaunchTxMalformed))
}

fn u64_at(data: &[u8], off: usize) -> Result<u64> {
    let b: [u8; 8] = data
        .get(off..off + 8)
        .and_then(|s| s.try_into().ok())
        .ok_or_else(|| error!(BallastError::LaunchTxMalformed))?;
    Ok(u64::from_le_bytes(b))
}

/// Walk every instruction before this one; fail unless the D-011 shape holds exactly.
pub fn verify_launch_tx(instructions_sysvar: &AccountInfo, e: &Expect) -> Result<()> {
    let current = load_current_index_checked(instructions_sysvar)? as usize;
    let (mut pool_created, mut pair_created, mut transferred) = (false, false, false);
    let mut swaps = 0u8;

    for i in 0..current {
        let ix = load_instruction_at_checked(i, instructions_sysvar)?;
        let d: [u8; 8] = match ix.data.get(..8).and_then(|s| s.try_into().ok()) {
            Some(d) => d,
            None => {
                if ix.program_id == DBC_PROGRAM_ID || ix.program_id == DLMM_PROGRAM_ID {
                    return err!(BallastError::LaunchTxMalformed);
                }
                continue;
            }
        };

        if ix.program_id == DBC_PROGRAM_ID {
            match d {
                disc::DBC_INIT_POOL_SPL => {
                    require_keys_eq!(
                        key_at(&ix, idx::INIT_POOL)?,
                        e.pool,
                        BallastError::LaunchPoolNotCreatedInTx
                    );
                    require_keys_eq!(
                        key_at(&ix, idx::INIT_CONFIG)?,
                        e.config,
                        BallastError::LaunchWrongConfig
                    );
                    require_keys_eq!(
                        key_at(&ix, idx::INIT_BASE_MINT)?,
                        e.base_mint,
                        BallastError::LaunchBaseMintMismatch
                    );
                    require_keys_eq!(
                        key_at(&ix, idx::INIT_CREATOR)?,
                        e.creator,
                        BallastError::LaunchCreatorMismatch
                    );
                    pool_created = true;
                }
                // §7: the class is an SPL token; a Token-2022 pool creation is never a Ballast launch.
                disc::DBC_INIT_POOL_TOKEN2022 => {
                    return err!(BallastError::LaunchUnexpectedDbcInstruction)
                }
                disc::DBC_CREATE_POOL_METADATA => {}
                disc::DBC_SWAP | disc::DBC_SWAP2 => {
                    swaps = swaps
                        .checked_add(1)
                        .ok_or_else(|| error!(BallastError::Overflow))?;
                    require!(swaps == 1, BallastError::LaunchTooManySwaps);
                    require_keys_eq!(
                        key_at(&ix, idx::SWAP_POOL)?,
                        e.pool,
                        BallastError::LaunchUnexpectedDbcInstruction
                    );
                    require_keys_eq!(
                        key_at(&ix, idx::SWAP_PAYER)?,
                        e.payer,
                        BallastError::LaunchSwapNotByPayer
                    );
                    // swap: (amount_in, minimum_amount_out). swap2: (amount_0, amount_1, swap_mode),
                    // where ExactOut (2) bounds the input by amount_1.
                    let max_in = if d == disc::DBC_SWAP2 && ix.data.get(24) == Some(&2) {
                        u64_at(&ix.data, 16)?
                    } else {
                        u64_at(&ix.data, 8)?
                    };
                    require!(max_in <= e.dust_limit, BallastError::LaunchDustBuyTooLarge);
                }
                disc::DBC_TRANSFER_POOL_CREATOR => {
                    require_keys_eq!(
                        key_at(&ix, idx::TPC_POOL)?,
                        e.pool,
                        BallastError::LaunchUnexpectedDbcInstruction
                    );
                    require_keys_eq!(
                        key_at(&ix, idx::TPC_CREATOR)?,
                        e.creator,
                        BallastError::LaunchCreatorMismatch
                    );
                    require_keys_eq!(
                        key_at(&ix, idx::TPC_NEW_CREATOR)?,
                        e.creator_auth,
                        BallastError::LaunchCreatorNotTransferred
                    );
                    transferred = true;
                }
                _ => return err!(BallastError::LaunchUnexpectedDbcInstruction),
            }
        } else if ix.program_id == DLMM_PROGRAM_ID {
            match d {
                disc::DLMM_INIT_CUSTOMIZABLE_PAIR | disc::DLMM_INIT_CUSTOMIZABLE_PAIR2 => {
                    require_keys_eq!(
                        key_at(&ix, idx::PAIR_LB_PAIR)?,
                        e.dlmm_pair,
                        BallastError::LaunchPairNotCreatedInTx
                    );
                    pair_created = true;
                }
                _ => return err!(BallastError::LaunchUnexpectedDlmmInstruction),
            }
        }
    }

    require!(pool_created, BallastError::LaunchPoolNotCreatedInTx);
    require!(pair_created, BallastError::LaunchPairNotCreatedInTx);
    require!(transferred, BallastError::LaunchCreatorNotTransferred);
    Ok(())
}
