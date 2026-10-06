//! Minimal SPL Token instruction builders, written by hand rather than pulling in `anchor-spl`
//! (D-007 / D-009: keep the program small). Only what Ballast needs, each with its documented
//! SPL Token instruction tag.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_program;

use crate::TOKEN_PROGRAM_ID;

/// SPL Token account length.
pub const TOKEN_ACCOUNT_LEN: u64 = 165;

/// System `CreateAccount` (variant 0), built by hand (D-018): `system_instruction::create_account`
/// serialises with bincode. Data: u32 variant ‖ u64 lamports ‖ u64 space ‖ owner, little-endian.
pub fn create_account(
    from: &Pubkey,
    to: &Pubkey,
    lamports: u64,
    space: u64,
    owner: &Pubkey,
) -> Instruction {
    let mut data = Vec::with_capacity(52);
    data.extend_from_slice(&0u32.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: system_program::ID,
        accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, true)],
        data,
    }
}

/// SPL Token `InitializeAccount3` (tag 18): account, mint; owner in the data. No rent sysvar.
fn initialize_account3(account: &Pubkey, mint: &Pubkey, owner: &Pubkey) -> Instruction {
    let mut data = Vec::with_capacity(33);
    data.push(18);
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new_readonly(*mint, false),
        ],
        data,
    }
}

/// SPL Token `Burn` (tag 8): account, mint, authority; amount u64.
pub fn burn(account: &Pubkey, mint: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
    let mut data = Vec::with_capacity(9);
    data.push(8);
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new(*mint, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

/// Create a token account at a PDA (`account_seeds` sign the allocation) owned by the Token
/// program, initialised for `mint` with `owner` as its authority.
#[allow(clippy::too_many_arguments)]
pub fn create_pda_token_account<'info>(
    payer: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    owner: &Pubkey,
    account_seeds: &[&[u8]],
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(TOKEN_ACCOUNT_LEN as usize);
    invoke_signed(
        &create_account(
            payer.key,
            account.key,
            rent,
            TOKEN_ACCOUNT_LEN,
            &TOKEN_PROGRAM_ID,
        ),
        &[payer.clone(), account.clone(), system_program.clone()],
        &[account_seeds],
    )?;
    invoke_signed(
        &initialize_account3(account.key, mint.key, owner),
        &[account.clone(), mint.clone(), token_program.clone()],
        &[],
    )?;
    Ok(())
}

/// Read `(mint, owner, amount)` from an SPL token account's raw bytes, checking owner program and
/// length. §5 rule 3: a token account's mint and authority are checked, never assumed.
pub fn read_token_account(info: &AccountInfo) -> Option<(Pubkey, Pubkey, u64)> {
    if *info.owner != TOKEN_PROGRAM_ID {
        return None;
    }
    let data = info.try_borrow_data().ok()?;
    if data.len() != TOKEN_ACCOUNT_LEN as usize {
        return None;
    }
    let mint = Pubkey::new_from_array(data[0..32].try_into().ok()?);
    let owner = Pubkey::new_from_array(data[32..64].try_into().ok()?);
    let amount = u64::from_le_bytes(data[64..72].try_into().ok()?);
    Some((mint, owner, amount))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::system_instruction;

    /// D-018: the hand-built `CreateAccount` is byte-identical to the SDK's bincode encoding.
    #[test]
    fn create_account_matches_system_instruction() {
        let (a, b, o) = (
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        );
        for &(lamports, space) in &[(0u64, 0u64), (2_039_280, 165), (u64::MAX, u64::MAX)] {
            assert_eq!(
                create_account(&a, &b, lamports, space, &o),
                system_instruction::create_account(&a, &b, lamports, space, &o)
            );
        }
    }
}
