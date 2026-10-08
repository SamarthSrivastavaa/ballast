//! D-022 `pay_creator()`: the creator's income, decoupled from the floor.
//!
//! Principle (CLAUDE.md, D-022): nothing the creator controls is on the floor's critical path.
//! `settle_graduation` and `harvest` handle partner flows only; the creator's DBC trading fees and,
//! once `Open`, the creator position's DAMM v2 LP fees are claimed here by `creator_auth` and paid
//! straight to `ATA(creator_beneficiary, WSOL)`. If that account is invalid — the creator can
//! reassign its owner or close it at will — only this instruction fails and the fees stay claimable
//! in DBC and DAMM v2.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;

use crate::errors::BallastError;
use crate::floor_ix::{
    add, burn_staging, floor_of, launch_pool, monotone, note_backing, outstanding_supply,
    recorded_l, staging_balance, sub, total_l, vault_balance,
};
use crate::state::{canon, launch_state, Class, Launch};
use crate::{
    ata_of, damm, dbc_cpi, read_launch_pool, token_balance, DBC_PROGRAM_ID, TOKEN_PROGRAM_ID,
};

/// §6 `pay_creator()` (D-022). Permissionless; any state from `Registered` on.
pub fn handle_pay_creator(ctx: Context<PayCreator>) -> Result<()> {
    let a = &ctx.accounts;
    let launch_key = a.launch.key();
    let partner = a.partner_auth.key();
    let base_mint = a.launch.base_mint;
    let beneficiary = a.launch.creator_beneficiary;

    // The beneficiary's WSOL ATA, fully validated: address, mint, owner (D-016). Only this
    // instruction depends on it.
    require_keys_eq!(
        a.beneficiary_quote.key(),
        ata_of(&beneficiary, &canon::QUOTE_MINT),
        BallastError::BeneficiaryAccountInvalid
    );
    let ben = || {
        token_balance(
            &a.beneficiary_quote,
            &canon::QUOTE_MINT,
            &beneficiary,
            BallastError::BeneficiaryAccountInvalid,
        )
    };
    let b0 = ben()?;
    // `partner_auth`'s base ATA is both claims' base destination; it must not move (below).
    let st0 = staging_balance(&a.staging_base, &partner, &base_mint)?;

    let pv = read_launch_pool(
        &a.virtual_pool,
        &a.class,
        &a.launch,
        a.base_vault.key,
        a.quote_vault.key,
    )?;
    // §7 rule 2 pins DBC collect_fee_mode = QuoteToken. A creator base fee would be the
    // beneficiary's, so it fails closed rather than being burned or paid elsewhere.
    require!(pv.creator_base_fee == 0, BallastError::CreatorBaseFee);

    let creator_seeds: &[&[u8]] = &[
        b"creator",
        launch_key.as_ref(),
        &[a.launch.creator_auth_bump],
    ];
    if pv.creator_quote_fee > 0 {
        let pool = dbc_cpi::Pool {
            config: a.class.dbc_config,
            pool: a.virtual_pool.key(),
            base_vault: pv.base_vault,
            quote_vault: pv.quote_vault,
            base_mint,
            quote_mint: canon::QUOTE_MINT,
        };
        invoke_signed(
            &dbc_cpi::claim_creator_trading_fee(
                &pool,
                a.staging_base.key,
                a.beneficiary_quote.key,
                a.creator_auth.key,
            ),
            &[
                a.dbc_pool_authority.to_account_info(),
                a.virtual_pool.to_account_info(),
                a.staging_base.to_account_info(),
                a.beneficiary_quote.to_account_info(),
                a.base_vault.to_account_info(),
                a.quote_vault.to_account_info(),
                a.base_mint.to_account_info(),
                a.quote_mint.to_account_info(),
                a.creator_auth.to_account_info(),
                a.token_program.to_account_info(),
                a.dbc_event_authority.to_account_info(),
                a.dbc_program.to_account_info(),
            ],
            &[creator_seeds],
        )?;
    }
    let b1 = ben()?;
    let dbc_fees = sub(b1, b0)?;

    // Once `Open`: the creator position's LP fees (OnlyB, quote only), and the §4 floor check.
    let mut lp_fees = 0;
    let mut floor_inputs = None;
    if a.launch.state == launch_state::OPEN {
        let missing = || error!(BallastError::PositionNotRecorded);
        let damm_pool = a.damm_pool.as_ref().ok_or_else(missing)?;
        let partner_position = a.partner_position.as_ref().ok_or_else(missing)?;
        let creator_position = a.creator_position.as_ref().ok_or_else(missing)?;
        let creator_nft = a.creator_nft_account.as_ref().ok_or_else(missing)?;
        let token_a_vault = a.token_a_vault.as_ref().ok_or_else(missing)?;
        let token_b_vault = a.token_b_vault.as_ref().ok_or_else(missing)?;
        let damm_pool_authority = a.damm_pool_authority.as_ref().ok_or_else(missing)?;
        let damm_event_authority = a.damm_event_authority.as_ref().ok_or_else(missing)?;
        let damm_program = a.damm_program.as_ref().ok_or_else(missing)?;
        let pool = launch_pool(&a.launch, damm_pool)?;
        require!(
            token_a_vault.key() == pool.token_a_vault && token_b_vault.key() == pool.token_b_vault,
            BallastError::DammPoolInvalid
        );
        require!(
            creator_position.key() == a.launch.creator_position
                && creator_nft.key() == a.launch.creator_nft_account,
            BallastError::PositionNotRecorded
        );
        require!(
            damm_pool_authority.key() == damm::DAMM_POOL_AUTHORITY
                && damm_event_authority.key() == damm::DAMM_EVENT_AUTHORITY
                && damm_program.key() == damm::DAMM_PROGRAM_ID,
            BallastError::DammPoolInvalid
        );
        let cp = damm::ClaimPool {
            pool: damm_pool.key(),
            token_a_vault: pool.token_a_vault,
            token_b_vault: pool.token_b_vault,
            token_a_mint: base_mint,
            token_b_mint: canon::QUOTE_MINT,
        };
        invoke_signed(
            &damm::claim_position_fee(
                &cp,
                creator_position.key,
                a.staging_base.key,
                a.beneficiary_quote.key,
                creator_nft.key,
                a.creator_auth.key,
            ),
            &[
                damm_pool_authority.to_account_info(),
                damm_pool.to_account_info(),
                creator_position.to_account_info(),
                a.staging_base.to_account_info(),
                a.beneficiary_quote.to_account_info(),
                token_a_vault.to_account_info(),
                token_b_vault.to_account_info(),
                a.base_mint.to_account_info(),
                a.quote_mint.to_account_info(),
                creator_nft.to_account_info(),
                a.creator_auth.to_account_info(),
                a.token_program.to_account_info(),
                damm_event_authority.to_account_info(),
                damm_program.to_account_info(),
            ],
            &[creator_seeds],
        )?;
        lp_fees = sub(ben()?, b1)?;
        let ls = recorded_l(&a.launch, partner_position, creator_position)?;
        floor_inputs = Some((ls, pool.sqrt_max_price));
    }
    // A creator base fee (DBC or DAMM) would have landed in staging: fail closed.
    require!(
        staging_balance(&a.staging_base, &partner, &base_mint)? == st0,
        BallastError::CreatorBaseFee
    );
    // §5: once the floor exists, staging ends every instruction at zero (S excludes it, so F does
    // not move). Before `Open` it may still hold a leftover a third party withdrew early, which only
    // `burn_leftover` burns and records (D-016).
    let burned = if a.launch.state == launch_state::OPEN {
        burn_staging(
            &a.staging_base,
            &a.base_mint,
            &a.partner_auth,
            &a.token_program,
            &a.class,
        )?
    } else {
        0
    };
    let st_after = sub(st0, burned)?;

    // §4 rule 3 once the floor exists: creator flows never touch V, S or L, so this must hold.
    let s_new = match floor_inputs {
        Some((ls, s_max)) => {
            let vault = vault_balance(&a.vault, &partner)?;
            let s_supply = outstanding_supply(&a.base_mint, st_after)?;
            Some((
                ls,
                floor_of(
                    add(vault, a.launch.bid_quote_committed)?,
                    s_supply,
                    total_l(ls)?,
                    s_max,
                )?,
            ))
        }
        None => None,
    };

    let launch = &mut ctx.accounts.launch;
    launch.creator_forwarded = add(add(launch.creator_forwarded, dbc_fees)?, lp_fees)?;
    launch.burned = add(launch.burned, burned)?;
    if let Some((ls, s)) = s_new {
        note_backing(launch_key, launch, ls);
        monotone(launch, s)?;
    }
    emit!(CreatorPaid {
        launch: launch_key,
        dbc_fees,
        lp_fees,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct PayCreator<'info> {
    #[account(
        mut,
        seeds = [b"launch", launch.base_mint.as_ref()],
        bump = launch.bump,
        has_one = class,
    )]
    pub launch: Box<Account<'info, Launch>>,
    #[account(seeds = [b"class", class.dbc_config.as_ref()], bump = class.bump)]
    pub class: Box<Account<'info, Class>>,
    /// CHECK: PDA with no data; the DBC pool creator and the creator-position NFT holder. Signs
    /// both claims.
    #[account(seeds = [b"creator", launch.key().as_ref()], bump = launch.creator_auth_bump)]
    pub creator_auth: UncheckedAccount<'info>,
    /// CHECK: PDA with no data; owner of the staging base ATA.
    #[account(seeds = [b"partner", class.dbc_config.as_ref()], bump = class.partner_auth_bump)]
    pub partner_auth: UncheckedAccount<'info>,
    /// CHECK: `partner_auth`'s base ATA — the claims' base destination, which must not move
    /// (handler).
    #[account(mut)]
    pub staging_base: UncheckedAccount<'info>,
    /// CHECK: `ATA(creator_beneficiary, WSOL)`; address, mint and owner checked in the handler.
    #[account(mut)]
    pub beneficiary_quote: UncheckedAccount<'info>,
    /// CHECK: the launch's WSOL vault, read for V once `Open` — derived, never caller-supplied.
    #[account(seeds = [b"vault", launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the launch's base mint, read for S; writable for the staging burn once `Open`.
    #[account(mut, address = launch.base_mint)]
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: SPL WSOL.
    #[account(address = canon::QUOTE_MINT)]
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: the launch's DBC `VirtualPool`; owner, discriminator and cross-links checked in the
    /// handler.
    #[account(mut, address = launch.dbc_pool)]
    pub virtual_pool: UncheckedAccount<'info>,
    /// CHECK: must be the pool's base vault (handler).
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: must be the pool's quote vault (handler).
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: DBC's constant pool authority.
    #[account(address = dbc_cpi::DBC_POOL_AUTHORITY)]
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: DBC's `__event_authority` PDA.
    #[account(address = dbc_cpi::DBC_EVENT_AUTHORITY)]
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: §12 — hard-coded CPI program id.
    #[account(address = DBC_PROGRAM_ID)]
    pub dbc_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
    // ---- required once `Open` (the creator position's LP fees and the floor check) ----
    /// CHECK: the launch's DAMM v2 pool (handler).
    pub damm_pool: Option<UncheckedAccount<'info>>,
    /// CHECK: the recorded partner position, read for L (handler).
    pub partner_position: Option<UncheckedAccount<'info>>,
    /// CHECK: the recorded creator position (handler).
    #[account(mut)]
    pub creator_position: Option<UncheckedAccount<'info>>,
    /// CHECK: the recorded creator NFT account (handler).
    pub creator_nft_account: Option<UncheckedAccount<'info>>,
    /// CHECK: must equal the pool's `token_a_vault` (handler).
    #[account(mut)]
    pub token_a_vault: Option<UncheckedAccount<'info>>,
    /// CHECK: must equal the pool's `token_b_vault` (handler).
    #[account(mut)]
    pub token_b_vault: Option<UncheckedAccount<'info>>,
    /// CHECK: DAMM v2 constant pool authority (handler).
    pub damm_pool_authority: Option<UncheckedAccount<'info>>,
    /// CHECK: DAMM v2 `__event_authority` (handler).
    pub damm_event_authority: Option<UncheckedAccount<'info>>,
    /// CHECK: §12 — hard-coded CPI program id (handler).
    pub damm_program: Option<UncheckedAccount<'info>>,
}

/// D-022: creator income paid to `ATA(creator_beneficiary, WSOL)`.
#[event]
pub struct CreatorPaid {
    pub launch: Pubkey,
    /// DBC creator trading fees.
    pub dbc_fees: u64,
    /// The creator position's DAMM v2 LP fees (0 before `Open`).
    pub lp_fees: u64,
}
