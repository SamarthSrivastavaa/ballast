//! DAMM v2 reads and the one CPI Ballast makes into it (§8; D-007 / D-009: no Meteora crates).
//!
//! Account order and the discriminator follow the vendored IDL (`crates/meteora-types/idl/cp_amm.json`,
//! cp_amm 0.2.4); PDA seeds follow cp-amm SDK 1.4.8 (`derivePoolAddress`, `derivePositionAddress`,
//! `derivePositionNftAccount`).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use meteora_types::damm_v2::{Pool, Position};

use crate::errors::BallastError;
use crate::{TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID};

pub const DAMM_PROGRAM_ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/// DAMM v2's constant `pool_authority` (IDL address; pinned mainnet account).
pub const DAMM_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
/// DAMM v2's `__event_authority` PDA (unit test re-derives it).
pub const DAMM_EVENT_AUTHORITY: Pubkey = pubkey!("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");
/// The DAMM v2 config DBC migrates Customizable-option pools into (`DAMM_V2_MIGRATION_FEE_ADDRESS[6]`,
/// pinned `damm_v2_migration_config_customizable`; byte-identical on mainnet and devnet). The
/// migrated pool is the PDA under this config — §8's only acceptable pool.
pub const DAMM_MIGRATION_CONFIG: Pubkey = pubkey!("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");
/// cp_amm `MIN_SQRT_PRICE` / `MAX_SQRT_PRICE` (IDL constants, LE bytes): §8 "Range" = full range.
pub const MIN_SQRT_PRICE: u128 = 4_295_048_016;
pub const MAX_SQRT_PRICE: u128 = 79_226_673_521_066_979_257_578_248_091;
/// DAMM `collect_fee_mode` 1 = OnlyB (D-010).
pub const COLLECT_FEE_MODE_ONLY_B: u8 = 1;

pub const CLAIM_POSITION_FEE: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];

/// `["pool", config, max(mint_a, mint_b), min(mint_a, mint_b)]` under DAMM v2.
pub fn pool_address(config: &Pubkey, mint_a: &Pubkey, mint_b: &Pubkey) -> Pubkey {
    let (hi, lo) = if mint_a > mint_b {
        (mint_a, mint_b)
    } else {
        (mint_b, mint_a)
    };
    Pubkey::find_program_address(
        &[b"pool", config.as_ref(), hi.as_ref(), lo.as_ref()],
        &DAMM_PROGRAM_ID,
    )
    .0
}

pub fn position_address(nft_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"position", nft_mint.as_ref()], &DAMM_PROGRAM_ID).0
}

pub fn nft_account_address(nft_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"position_nft_account", nft_mint.as_ref()],
        &DAMM_PROGRAM_ID,
    )
    .0
}

/// The pool fields Ballast uses after the §8 checks.
pub struct PoolView {
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub sqrt_max_price: u128,
}

/// §8 verification of the launch's DAMM v2 pool: owner, discriminator, canonical address under the
/// migration config, mints, OnlyB, no compounding, full range.
pub fn read_pool(info: &AccountInfo, base_mint: &Pubkey, quote_mint: &Pubkey) -> Result<PoolView> {
    require_keys_eq!(*info.owner, DAMM_PROGRAM_ID, BallastError::DammPoolInvalid);
    require_keys_eq!(
        info.key(),
        pool_address(&DAMM_MIGRATION_CONFIG, base_mint, quote_mint),
        BallastError::DammPoolNotMigrated
    );
    let data = info.try_borrow_data()?;
    let p = meteora_types::decode::<Pool>(&data, &Pool::DISCRIMINATOR)
        .ok_or_else(|| error!(BallastError::DammPoolInvalid))?;
    require!(
        Pubkey::new_from_array(p.token_a_mint) == *base_mint
            && Pubkey::new_from_array(p.token_b_mint) == *quote_mint,
        BallastError::DammPoolInvalid
    );
    let (comp_bps, lo, hi) = (
        p.pool_fees.compounding_fee_bps,
        p.sqrt_min_price,
        p.sqrt_max_price,
    );
    require!(
        p.collect_fee_mode == COLLECT_FEE_MODE_ONLY_B && comp_bps == 0,
        BallastError::DammPoolMode
    );
    require!(
        lo == MIN_SQRT_PRICE && hi == MAX_SQRT_PRICE,
        BallastError::DammPoolRange
    );
    Ok(PoolView {
        token_a_vault: Pubkey::new_from_array(p.token_a_vault),
        token_b_vault: Pubkey::new_from_array(p.token_b_vault),
        sqrt_max_price: hi,
    })
}

/// After `open` (§8 fail-safe, audit 7 Oct): identity only — owner, discriminator, `pool`, canonical
/// address — and `permanent_locked_liquidity` as read, 0 allowed. A decrease must degrade the launch
/// (`BackingDecreased`), never abort redemption, so open's "fully permanent" checks are not reapplied.
pub fn read_position_identity(info: &AccountInfo, pool: &Pubkey) -> Result<u128> {
    require_keys_eq!(*info.owner, DAMM_PROGRAM_ID, BallastError::PositionInvalid);
    let data = info.try_borrow_data()?;
    let p = meteora_types::decode::<Position>(&data, &Position::DISCRIMINATOR)
        .ok_or_else(|| error!(BallastError::PositionInvalid))?;
    require_keys_eq!(
        Pubkey::new_from_array(p.pool),
        *pool,
        BallastError::PositionWrongPool
    );
    require_keys_eq!(
        info.key(),
        position_address(&Pubkey::new_from_array(p.nft_mint)),
        BallastError::PositionInvalid
    );
    Ok(p.permanent_locked_liquidity)
}

/// A position's `permanent_locked_liquidity` after §8's checks: owner, discriminator, `pool`,
/// `unlocked == vested == 0`, `permanent > 0`. Returns `(nft_mint, permanent)`. Used by `open`.
pub fn read_position(info: &AccountInfo, pool: &Pubkey) -> Result<(Pubkey, u128)> {
    require_keys_eq!(*info.owner, DAMM_PROGRAM_ID, BallastError::PositionInvalid);
    let data = info.try_borrow_data()?;
    let p = meteora_types::decode::<Position>(&data, &Position::DISCRIMINATOR)
        .ok_or_else(|| error!(BallastError::PositionInvalid))?;
    require_keys_eq!(
        Pubkey::new_from_array(p.pool),
        *pool,
        BallastError::PositionWrongPool
    );
    let nft_mint = Pubkey::new_from_array(p.nft_mint);
    // §5 rule 1: the address is re-derived, not trusted.
    require_keys_eq!(
        info.key(),
        position_address(&nft_mint),
        BallastError::PositionInvalid
    );
    let (unlocked, vested, permanent) = (
        p.unlocked_liquidity,
        p.vested_liquidity,
        p.permanent_locked_liquidity,
    );
    require!(
        unlocked == 0 && vested == 0 && permanent > 0,
        BallastError::PositionNotPermanent
    );
    Ok((nft_mint, permanent))
}

/// §8 "Ownership": the position NFT sits in DAMM's canonical NFT account for `nft_mint`, a Token-2022
/// account holding exactly 1 with token owner `holder`.
pub fn check_nft_account(info: &AccountInfo, nft_mint: &Pubkey, holder: &Pubkey) -> Result<()> {
    require_keys_eq!(
        info.key(),
        nft_account_address(nft_mint),
        BallastError::PositionNftHolder
    );
    require_keys_eq!(
        *info.owner,
        TOKEN_2022_PROGRAM_ID,
        BallastError::PositionNftHolder
    );
    let data = info.try_borrow_data()?;
    require!(data.len() >= 165, BallastError::PositionNftHolder);
    let mint = Pubkey::new_from_array(data[0..32].try_into().unwrap_or([0u8; 32]));
    let owner = Pubkey::new_from_array(data[32..64].try_into().unwrap_or([0u8; 32]));
    let amount = u64::from_le_bytes(data[64..72].try_into().unwrap_or([0u8; 8]));
    require!(
        mint == *nft_mint && owner == *holder && amount == 1,
        BallastError::PositionNftHolder
    );
    Ok(())
}

/// The accounts `claim_position_fee` needs besides the per-position ones.
pub struct ClaimPool {
    pub pool: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
}

/// `claim_position_fee`: pool_authority, pool, position (w), token_a_account (w), token_b_account (w),
/// token_a_vault (w), token_b_vault (w), token_a_mint, token_b_mint, position_nft_account, signer (s),
/// token_a_program, token_b_program, event_authority, program.
pub fn claim_position_fee(
    p: &ClaimPool,
    position: &Pubkey,
    dest_a: &Pubkey,
    dest_b: &Pubkey,
    nft_account: &Pubkey,
    signer: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: DAMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(DAMM_POOL_AUTHORITY, false),
            AccountMeta::new_readonly(p.pool, false),
            AccountMeta::new(*position, false),
            AccountMeta::new(*dest_a, false),
            AccountMeta::new(*dest_b, false),
            AccountMeta::new(p.token_a_vault, false),
            AccountMeta::new(p.token_b_vault, false),
            AccountMeta::new_readonly(p.token_a_mint, false),
            AccountMeta::new_readonly(p.token_b_mint, false),
            AccountMeta::new_readonly(*nft_account, false),
            AccountMeta::new_readonly(*signer, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(DAMM_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(DAMM_PROGRAM_ID, false),
        ],
        data: CLAIM_POSITION_FEE.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_authority_is_the_pda() {
        let (pda, _) = Pubkey::find_program_address(&[b"__event_authority"], &DAMM_PROGRAM_ID);
        assert_eq!(pda, DAMM_EVENT_AUTHORITY);
    }

    /// cp_amm IDL constants `MIN_SQRT_PRICE_LE_BYTES` / `MAX_SQRT_PRICE_LE_BYTES`.
    #[test]
    fn range_constants_match_the_idl_bytes() {
        let min = [80u8, 59, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let max = [
            155u8, 87, 105, 78, 169, 26, 92, 132, 177, 196, 254, 255, 0, 0, 0, 0,
        ];
        assert_eq!(MIN_SQRT_PRICE, u128::from_le_bytes(min));
        assert_eq!(MAX_SQRT_PRICE, u128::from_le_bytes(max));
        assert_eq!(MAX_SQRT_PRICE, ballast_floor::S_MAX_DAMM_V2);
    }

    #[test]
    fn pool_address_orders_the_mints() {
        let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
        let c = Pubkey::new_unique();
        assert_eq!(pool_address(&c, &a, &b), pool_address(&c, &b, &a));
    }
}
