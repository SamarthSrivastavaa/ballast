//! Program Part 2 (§6): `open`, `refresh_floor`, `redeem`, `floor`, `harvest`, `deposit`.
//!
//! Every value F depends on — V, S, L, `s_max` — is read from accounts inside the instruction that
//! uses it (§4 rule 2); only `ballast-floor` computes `s` (§4 rule 1); every mutating instruction
//! ends with the monotone check (§4 rule 3). The bid is one DLMM limit order in the highest bin at
//! or below F, owned by `partner_auth`, funded from the vault (§9, D-012). Fills are collected only
//! by cancelling (canon correction 4).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed, set_return_data};
use ballast_floor::{bin_at_or_below, floor_sqrt_q64, redeem_payout, FloorInputs};

use crate::errors::BallastError;
use crate::state::{canon, launch_state, Class, Global, Launch};
use crate::{ata_of, damm, dlmm, spl, token_balance, DLMM_PROGRAM_ID, TOKEN_PROGRAM_ID};

// ------------------------------------------------------------------------------------------------
// Shared reads and checks
// ------------------------------------------------------------------------------------------------

fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b)
        .ok_or_else(|| error!(BallastError::Overflow))
}

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| error!(BallastError::Overflow))
}

/// `s` from §4 inputs, via the one floor crate. Out-of-range inputs are an error, never a value.
fn floor_of(v: u64, s_supply: u64, l: u128, s_max: u128) -> Result<u128> {
    floor_sqrt_q64(&FloorInputs {
        v,
        s: s_supply,
        l,
        s_max,
    })
    .map_err(|_| error!(BallastError::FloorInputsOutOfRange))
}

fn vault_balance(vault: &AccountInfo, partner: &Pubkey) -> Result<u64> {
    token_balance(
        vault,
        &canon::QUOTE_MINT,
        partner,
        BallastError::VaultInvalid,
    )
}

/// `partner_auth`'s base ATA: the only staging account (D-016). Missing = error (D-012).
fn staging_balance(info: &AccountInfo, partner: &Pubkey, base_mint: &Pubkey) -> Result<u64> {
    require_keys_eq!(
        info.key(),
        ata_of(partner, base_mint),
        BallastError::StagingNotPartnerAta
    );
    token_balance(info, base_mint, partner, BallastError::StagingNotPartnerAta)
}

/// S = `base_mint.supply` − PDA-held base. The only PDA account that can hold base is the
/// staging ATA (the vault is WSOL; a creator base fee fails closed), so S counts everything else —
/// including filled base still inside a DLMM order, which can only understate F.
fn outstanding_supply(base_mint: &AccountInfo, staging: u64) -> Result<u64> {
    let supply = spl::read_mint_supply(base_mint)
        .ok_or_else(|| error!(BallastError::LaunchBaseMintNotSpl))?;
    sub(supply, staging)
}

/// L from the two positions recorded at `open` (§8: only these two count), re-read live.
fn recorded_l(
    launch: &Launch,
    partner_pos: &AccountInfo,
    creator_pos: &AccountInfo,
) -> Result<u128> {
    require!(
        partner_pos.key() == launch.partner_position
            && creator_pos.key() == launch.creator_position,
        BallastError::PositionNotRecorded
    );
    let (_, pl) = damm::read_position(partner_pos, &launch.damm_pool)?;
    let (_, cl) = damm::read_position(creator_pos, &launch.damm_pool)?;
    pl.checked_add(cl)
        .ok_or_else(|| error!(BallastError::Overflow))
}

/// The launch's DAMM pool, re-verified (§8), for `s_max` (re-read, never hard-coded).
fn launch_pool(launch: &Launch, pool: &AccountInfo) -> Result<damm::PoolView> {
    require_keys_eq!(pool.key(), launch.damm_pool, BallastError::DammPoolInvalid);
    damm::read_pool(pool, &launch.base_mint, &canon::QUOTE_MINT)
}

/// §8 fail-safe: L below the value recorded at `open` marks the launch degraded (monotone check
/// suspended) and emits `BackingDecreased`. Meteora cannot do this to permanent liquidity today.
fn note_backing(launch: &mut Launch, l: u128) {
    if l < launch.l_open && !launch.degraded {
        launch.degraded = true;
        emit!(BackingDecreased {
            launch: launch.base_mint,
            l_open: launch.l_open,
            l_now: l,
        });
    }
}

/// §4 rule 3: `require!(s_new ≥ s_last)`, then `s_last = s_new` (suspended only when degraded, §8).
fn monotone(launch: &mut Launch, s_new: u128) -> Result<()> {
    if !launch.degraded {
        require!(s_new >= launch.s_last, BallastError::FloorDecreased);
    }
    launch.s_last = s_new;
    Ok(())
}

/// §9: `price(hint) ≤ F < price(hint + 1)` with DLMM's own price function (vendored).
fn check_bin(hint: i32, bin_step: u16, s: u128) -> Result<()> {
    let p =
        dlmm::price_q64(hint, bin_step).ok_or_else(|| error!(BallastError::BinPriceUndefined))?;
    let n = dlmm::price_q64(
        hint.checked_add(1)
            .ok_or_else(|| error!(BallastError::Overflow))?,
        bin_step,
    )
    .ok_or_else(|| error!(BallastError::BinPriceUndefined))?;
    require!(bin_at_or_below(p, n, s), BallastError::BinHintNotAtFloor);
    Ok(())
}

/// The highest bin at or below F, searched from `start` in either direction (F normally only
/// rises; it can fall only on a degraded launch, §8). Bounded; beyond that, `refresh_floor`.
fn find_bin(start: i32, bin_step: u16, s: u128) -> Result<i32> {
    let mut id = start;
    for _ in 0..canon::BID_SCAN_MAX {
        let p =
            dlmm::price_q64(id, bin_step).ok_or_else(|| error!(BallastError::BinPriceUndefined))?;
        let n = dlmm::price_q64(id + 1, bin_step)
            .ok_or_else(|| error!(BallastError::BinPriceUndefined))?;
        if bin_at_or_below(p, n, s) {
            return Ok(id);
        }
        // F below this bin's price → step down; otherwise F ≥ the next price → step up.
        id = if bin_at_or_below(0, p, s) {
            id - 1
        } else {
            id + 1
        };
    }
    err!(BallastError::BidBinStale)
}

/// D-013: the bin array holding `bin_id` must already exist (the keeper creates it). It is passed in
/// `remaining_accounts` at its derived address.
fn bin_array_for<'info>(
    remaining: &[AccountInfo<'info>],
    lb_pair: &Pubkey,
    bin_id: i32,
) -> Result<AccountInfo<'info>> {
    let want = dlmm::bin_array_address(lb_pair, dlmm::bin_array_index(bin_id));
    let info = remaining
        .iter()
        .find(|a| a.key() == want)
        .ok_or_else(|| error!(BallastError::BinArrayMissing))?;
    require!(
        *info.owner == DLMM_PROGRAM_ID && info.data_len() > 0 && info.is_writable,
        BallastError::BinArrayMissing
    );
    Ok(info.clone())
}

/// Every class bin lies inside DLMM's internal bitmap (bin ≈ −12,000 → array index ≈ −171 of
/// ±512), so the optional bitmap extension is always "None" (= the DLMM program id). A bin that
/// would need the extension is refused rather than handled by an untested path.
fn require_internal_bitmap(lb_pair: &Pubkey, bins: &[i32]) -> Result<()> {
    require_keys_eq!(
        dlmm::bitmap_extension_for(lb_pair, bins),
        DLMM_PROGRAM_ID,
        BallastError::BitmapExtensionInvalid
    );
    Ok(())
}

/// The launch's DLMM pair and its reserves, cross-checked against the `LbPair` account (§5 rule 2).
fn read_pair(
    launch: &Launch,
    pair: &AccountInfo,
    reserve_x: &Pubkey,
    reserve_y: &Pubkey,
) -> Result<dlmm::Pair> {
    require_keys_eq!(
        pair.key(),
        launch.dlmm_pair,
        BallastError::PairAccountsInvalid
    );
    require_keys_eq!(
        *pair.owner,
        DLMM_PROGRAM_ID,
        BallastError::PairAccountsInvalid
    );
    let data = pair.try_borrow_data()?;
    let lb = meteora_types::decode::<meteora_types::dlmm::LbPair>(
        &data,
        &meteora_types::dlmm::LbPair::DISCRIMINATOR,
    )
    .ok_or_else(|| error!(BallastError::PairAccountsInvalid))?;
    let p = dlmm::Pair {
        lb_pair: pair.key(),
        reserve_x: Pubkey::new_from_array(lb.reserve_x),
        reserve_y: Pubkey::new_from_array(lb.reserve_y),
        token_x_mint: Pubkey::new_from_array(lb.token_x_mint),
        token_y_mint: Pubkey::new_from_array(lb.token_y_mint),
    };
    require!(
        p.token_x_mint == launch.base_mint
            && p.token_y_mint == canon::QUOTE_MINT
            && p.reserve_x == *reserve_x
            && p.reserve_y == *reserve_y,
        BallastError::PairAccountsInvalid
    );
    Ok(p)
}

/// Seeds of the class-wide `partner_auth` PDA.
macro_rules! partner_seeds {
    ($class:expr) => {
        &[
            b"partner".as_ref(),
            $class.dbc_config.as_ref(),
            &[$class.partner_auth_bump],
        ]
    };
}

// ------------------------------------------------------------------------------------------------
// Bid accounts shared by refresh_floor and redeem
// ------------------------------------------------------------------------------------------------

/// Settle the resting bid: cancel (filled base → staging, unfilled quote + fees → vault), close the
/// order (rent back to `partner_auth`), burn every base unit received. Returns `(filled, quote_back)`.
fn settle_bid<'info>(
    pair: &dlmm::Pair,
    bid: &BidAccounts<'info>,
    remaining: &[AccountInfo<'info>],
) -> Result<(u64, u64)> {
    let (class, launch) = (&bid.class, &bid.launch);
    if launch.bid_order == Pubkey::default() {
        return Ok((0, 0)); // the vault was exhausted by a redemption; nothing rests
    }
    require_keys_eq!(
        bid.bid_order.key(),
        launch.bid_order,
        BallastError::BidOrderMismatch
    );
    let partner = bid.partner_auth.key();
    let base_mint = launch.base_mint;
    require_internal_bitmap(&pair.lb_pair, &[launch.bid_bin_id])?;
    let arr = bin_array_for(remaining, &pair.lb_pair, launch.bid_bin_id)?;
    let st0 = staging_balance(&bid.staging_base, &partner, &base_mint)?;
    let v0 = vault_balance(&bid.vault, &partner)?;
    let infos = [
        bid.dlmm_pair.to_account_info(),
        bid.dlmm_program.to_account_info(),
        bid.reserve_x.to_account_info(),
        bid.reserve_y.to_account_info(),
        bid.base_mint.to_account_info(),
        bid.quote_mint.to_account_info(),
        bid.bid_order.to_account_info(),
        bid.staging_base.to_account_info(),
        bid.vault.to_account_info(),
        bid.partner_auth.to_account_info(),
        bid.token_program.to_account_info(),
        bid.memo_program.to_account_info(),
        bid.dlmm_event_authority.to_account_info(),
        arr.clone(),
    ];
    invoke_signed(
        &dlmm::cancel(
            pair,
            &DLMM_PROGRAM_ID,
            &launch.bid_order,
            bid.staging_base.key,
            bid.vault.key,
            &partner,
            arr.key,
            launch.bid_bin_id,
        ),
        &infos,
        &[partner_seeds!(class)],
    )?;
    invoke_signed(
        &dlmm::close_if_empty(&launch.bid_order, &partner, &partner),
        &infos,
        &[partner_seeds!(class)],
    )?;
    let filled = sub(
        staging_balance(&bid.staging_base, &partner, &base_mint)?,
        st0,
    )?;
    let quote_back = sub(vault_balance(&bid.vault, &partner)?, v0)?;
    if filled > 0 {
        invoke_signed(
            &spl::burn(bid.staging_base.key, &base_mint, &partner, filled),
            &infos,
            &[partner_seeds!(class)],
        )?;
    }
    Ok((filled, quote_back))
}

/// Rest the whole vault as one bid at `bin_id` (§9). Returns the quote committed (measured), or 0
/// when the vault is empty (no order is placed then).
fn place_bid<'info>(
    pair: &dlmm::Pair,
    bid: &BidAccounts<'info>,
    remaining: &[AccountInfo<'info>],
    bin_id: i32,
) -> Result<u64> {
    let partner = bid.partner_auth.key();
    let v0 = vault_balance(&bid.vault, &partner)?;
    if v0 == 0 {
        return Ok(0);
    }
    place(pair, bid, remaining, bin_id, v0)?;
    sub(v0, vault_balance(&bid.vault, &partner)?)
}

fn place<'info>(
    pair: &dlmm::Pair,
    bid: &BidAccounts<'info>,
    remaining: &[AccountInfo<'info>],
    bin_id: i32,
    amount: u64,
) -> Result<()> {
    require!(
        bid.partner_auth.lamports() > 0,
        BallastError::PartnerAuthUnfunded
    );
    require_internal_bitmap(&pair.lb_pair, &[bin_id])?;
    let arr = bin_array_for(remaining, &pair.lb_pair, bin_id)?;
    let partner = bid.partner_auth.key();
    invoke_signed(
        &dlmm::place_bid(
            pair,
            &DLMM_PROGRAM_ID,
            bid.new_order.key,
            &partner,
            &partner,
            bid.vault.key,
            &partner,
            arr.key,
            bin_id,
            amount,
        ),
        &[
            bid.dlmm_pair.to_account_info(),
            bid.dlmm_program.to_account_info(),
            bid.reserve_y.to_account_info(),
            bid.quote_mint.to_account_info(),
            bid.new_order.to_account_info(),
            bid.partner_auth.to_account_info(),
            bid.vault.to_account_info(),
            bid.token_program.to_account_info(),
            bid.system_program.to_account_info(),
            bid.dlmm_event_authority.to_account_info(),
            arr,
        ],
        &[partner_seeds!(bid.class)],
    )?;
    Ok(())
}

// ------------------------------------------------------------------------------------------------
// Handlers
// ------------------------------------------------------------------------------------------------

/// §6 `open(bin_id_hint)`.
pub fn handle_open<'info>(
    ctx: Context<'_, '_, 'info, 'info, Open<'info>>,
    bin_id_hint: i32,
) -> Result<()> {
    let a = &ctx.accounts;
    require!(
        a.bid.launch.state == launch_state::CLEANED,
        BallastError::LaunchWrongState
    );
    let base_mint = a.bid.launch.base_mint;
    let partner = a.bid.partner_auth.key();

    // §8: the canonical migrated pool, full range, OnlyB.
    let pool = damm::read_pool(&a.damm_pool, &base_mint, &canon::QUOTE_MINT)?;
    // §8: exactly two distinct, fully permanent positions in it, NFTs held by the two PDAs.
    require!(
        a.partner_position.key() != a.creator_position.key(),
        BallastError::PositionsNotDistinct
    );
    let (pm, pl) = damm::read_position(&a.partner_position, &a.damm_pool.key())?;
    let (cm, cl) = damm::read_position(&a.creator_position, &a.damm_pool.key())?;
    damm::check_nft_account(&a.partner_nft_account, &pm, &partner)?;
    damm::check_nft_account(&a.creator_nft_account, &cm, &a.creator_auth.key())?;
    let l = pl
        .checked_add(cl)
        .ok_or_else(|| error!(BallastError::Overflow))?;

    let pair = read_pair(
        &a.bid.launch,
        &a.bid.dlmm_pair,
        a.bid.reserve_x.key,
        a.bid.reserve_y.key,
    )?;

    // F from live V, S, L, s_max (§4 rule 2). Nothing is committed yet.
    let vault0 = vault_balance(&a.bid.vault, &partner)?;
    require!(vault0 > 0, BallastError::VaultEmpty);
    let st = staging_balance(&a.bid.staging_base, &partner, &base_mint)?;
    let s_supply = outstanding_supply(&a.bid.base_mint, st)?;
    let v = add(vault0, a.bid.launch.bid_quote_committed)?;
    let s_open = floor_of(v, s_supply, l, pool.sqrt_max_price)?;
    require!(
        s_open >= a.bid.launch.predicted_s,
        BallastError::FloorBelowPrediction
    );
    check_bin(bin_id_hint, a.bid.class.bid_bin_step, s_open)?;

    // The whole vault as one bid (canon correction 5). The token account's rent reserve is not part
    // of its WSOL amount, so it stays behind as the rent float.
    place(&pair, &a.bid, ctx.remaining_accounts, bin_id_hint, vault0)?;
    let vault1 = vault_balance(&a.bid.vault, &partner)?;
    let committed = sub(vault0, vault1)?;

    // Monotone check on the post-state, read live.
    let s_end = floor_of(add(vault1, committed)?, s_supply, l, pool.sqrt_max_price)?;
    let slot = Clock::get()?.slot;
    let order = a.bid.new_order.key();
    let (pp, cp, pn, cn, dp) = (
        a.partner_position.key(),
        a.creator_position.key(),
        a.partner_nft_account.key(),
        a.creator_nft_account.key(),
        a.damm_pool.key(),
    );
    let launch = &mut ctx.accounts.bid.launch;
    launch.damm_pool = dp;
    launch.partner_position = pp;
    launch.creator_position = cp;
    launch.partner_nft_account = pn;
    launch.creator_nft_account = cn;
    launch.bid_order = order;
    launch.bid_bin_id = bin_id_hint;
    launch.bid_quote_committed = committed;
    launch.s_open = s_open;
    launch.l_open = l;
    launch.open_slot = slot;
    launch.last_refresh_slot = slot;
    monotone(launch, s_end)?;
    launch.state = launch_state::OPEN;
    emit!(FloorOpened {
        launch: launch.key(),
        s_open,
        predicted_s: launch.predicted_s,
        l,
        v,
        s_supply,
        bin_id: bin_id_hint,
        committed,
    });
    Ok(())
}

/// §6 `refresh_floor(bin_id_hint)`: cancel → burn fills → recompute → re-place at the new bin.
pub fn handle_refresh_floor<'info>(
    ctx: Context<'_, '_, 'info, 'info, Refresh<'info>>,
    bin_id_hint: i32,
) -> Result<()> {
    let a = &ctx.accounts;
    require!(
        a.bid.launch.state == launch_state::OPEN,
        BallastError::LaunchWrongState
    );
    let slot = Clock::get()?.slot;
    require!(
        slot >= a
            .bid
            .launch
            .last_refresh_slot
            .saturating_add(canon::REFRESH_MIN_SLOTS),
        BallastError::RefreshRateLimited
    );
    let partner = a.bid.partner_auth.key();
    let base_mint = a.bid.launch.base_mint;
    let pool = launch_pool(&a.bid.launch, &a.damm_pool)?;
    let l = recorded_l(&a.bid.launch, &a.partner_position, &a.creator_position)?;
    let pair = read_pair(
        &a.bid.launch,
        &a.bid.dlmm_pair,
        a.bid.reserve_x.key,
        a.bid.reserve_y.key,
    )?;

    let (filled, _) = settle_bid(&pair, &a.bid, ctx.remaining_accounts)?;

    let vault = vault_balance(&a.bid.vault, &partner)?;
    let st = staging_balance(&a.bid.staging_base, &partner, &base_mint)?;
    let s_supply = outstanding_supply(&a.bid.base_mint, st)?;
    let s_new = floor_of(vault, s_supply, l, pool.sqrt_max_price)?;
    let committed = if vault > 0 {
        check_bin(bin_id_hint, a.bid.class.bid_bin_step, s_new)?;
        place_bid(&pair, &a.bid, ctx.remaining_accounts, bin_id_hint)?
    } else {
        0
    };
    let vault_end = vault_balance(&a.bid.vault, &partner)?;
    let s_end = floor_of(add(vault_end, committed)?, s_supply, l, pool.sqrt_max_price)?;
    let order = a.bid.new_order.key();

    let launch = &mut ctx.accounts.bid.launch;
    note_backing(launch, l);
    launch.burned = add(launch.burned, filled)?;
    launch.filled_tokens = add(launch.filled_tokens, filled)?;
    launch.bid_quote_committed = committed;
    launch.bid_order = if committed > 0 {
        order
    } else {
        Pubkey::default()
    };
    launch.bid_bin_id = bin_id_hint;
    launch.last_refresh_slot = slot;
    monotone(launch, s_end)?;
    emit!(FloorRefreshed {
        launch: launch.key(),
        filled,
        burned: filled,
        s_new: s_end,
        bin_id: bin_id_hint,
    });
    Ok(())
}

/// §6/§10 `redeem(amount, min_out)`, atomic: cancel → burn fills → s → pay → burn → s′ ≥ s_last →
/// re-place.
pub fn handle_redeem<'info>(
    ctx: Context<'_, '_, 'info, 'info, Redeem<'info>>,
    amount: u64,
    min_out: u64,
) -> Result<()> {
    let a = &ctx.accounts;
    require!(
        a.bid.launch.state == launch_state::OPEN,
        BallastError::LaunchWrongState
    );
    let partner = a.bid.partner_auth.key();
    let base_mint = a.bid.launch.base_mint;
    let holder = a.holder.key();
    // D-012: the holder's accounts must exist and be theirs; never read as 0.
    token_balance(
        &a.holder_base,
        &base_mint,
        &holder,
        BallastError::HolderAccountInvalid,
    )?;
    let hq0 = token_balance(
        &a.holder_quote,
        &canon::QUOTE_MINT,
        &holder,
        BallastError::HolderAccountInvalid,
    )?;
    let pool = launch_pool(&a.bid.launch, &a.damm_pool)?;
    let l = recorded_l(&a.bid.launch, &a.partner_position, &a.creator_position)?;
    let pair = read_pair(
        &a.bid.launch,
        &a.bid.dlmm_pair,
        a.bid.reserve_x.key,
        a.bid.reserve_y.key,
    )?;

    // 1. Settle the bid so V and S are exact (canon correction 4).
    let (filled, _) = settle_bid(&pair, &a.bid, ctx.remaining_accounts)?;

    // 2. s after settlement, before the burn (§4 rule 4).
    let vault = vault_balance(&a.bid.vault, &partner)?;
    let st = staging_balance(&a.bid.staging_base, &partner, &base_mint)?;
    let s_supply = outstanding_supply(&a.bid.base_mint, st)?;
    let s = floor_of(vault, s_supply, l, pool.sqrt_max_price)?;
    let payout = redeem_payout(amount, s, a.bid.class.redeem_fee_bps);
    require!(
        payout >= canon::MIN_PAYOUT,
        BallastError::PayoutBelowMinimum
    );
    require!(payout >= min_out, BallastError::SlippageExceeded);
    require!(payout <= vault, BallastError::VaultExhausted);

    // 3. Pay from the vault, then burn exactly `amount` of the holder's base (holder signs).
    invoke_signed(
        &spl::transfer(a.bid.vault.key, a.holder_quote.key, &partner, payout),
        &[
            a.bid.vault.to_account_info(),
            a.holder_quote.to_account_info(),
            a.bid.partner_auth.to_account_info(),
            a.bid.token_program.to_account_info(),
        ],
        &[partner_seeds!(a.bid.class)],
    )?;
    invoke(
        &spl::burn(a.holder_base.key, &base_mint, &holder, amount),
        &[
            a.holder_base.to_account_info(),
            a.bid.base_mint.to_account_info(),
            a.holder.to_account_info(),
            a.bid.token_program.to_account_info(),
        ],
    )?;
    let paid = sub(
        token_balance(
            &a.holder_quote,
            &canon::QUOTE_MINT,
            &holder,
            BallastError::HolderAccountInvalid,
        )?,
        hq0,
    )?;
    require!(paid == payout, BallastError::Overflow);

    // 4. s′ from the post-state; then re-place at the highest bin ≤ F′.
    let vault1 = vault_balance(&a.bid.vault, &partner)?;
    let s_supply1 = outstanding_supply(&a.bid.base_mint, st)?;
    let s_new = floor_of(vault1, s_supply1, l, pool.sqrt_max_price)?;
    let bin = find_bin(a.bid.launch.bid_bin_id, a.bid.class.bid_bin_step, s_new)?;
    let committed = place_bid(&pair, &a.bid, ctx.remaining_accounts, bin)?;
    let vault_end = vault_balance(&a.bid.vault, &partner)?;
    let s_end = floor_of(
        add(vault_end, committed)?,
        s_supply1,
        l,
        pool.sqrt_max_price,
    )?;
    let order = a.bid.new_order.key();

    let launch = &mut ctx.accounts.bid.launch;
    note_backing(launch, l);
    launch.burned = add(add(launch.burned, filled)?, amount)?;
    launch.filled_tokens = add(launch.filled_tokens, filled)?;
    launch.redeemed_tokens = add(launch.redeemed_tokens, amount)?;
    launch.redeemed_lamports = add(launch.redeemed_lamports, payout)?;
    launch.bid_quote_committed = committed;
    launch.bid_order = if committed > 0 {
        order
    } else {
        Pubkey::default()
    };
    launch.bid_bin_id = bin;
    monotone(launch, s_end)?;
    emit!(Redeemed {
        launch: launch.key(),
        holder,
        amount,
        payout,
        s,
        s_new: s_end,
        filled,
    });
    Ok(())
}

/// §6 `floor()` view: `{s, F_q64, V, S, L, s_last, bin_id, bin_price}` via `set_return_data`.
/// F is returned as `s²/2^64` — Q64.64 lamports per base unit, the unit of DLMM bin prices.
pub fn handle_floor(ctx: Context<FloorView>) -> Result<()> {
    let a = &ctx.accounts;
    require!(
        a.launch.state == launch_state::OPEN,
        BallastError::LaunchWrongState
    );
    let partner = a.partner_auth.key();
    let pool = launch_pool(&a.launch, &a.damm_pool)?;
    let l = recorded_l(&a.launch, &a.partner_position, &a.creator_position)?;
    let vault = vault_balance(&a.vault, &partner)?;
    let st = staging_balance(&a.staging_base, &partner, &a.launch.base_mint)?;
    let s_supply = outstanding_supply(&a.base_mint, st)?;
    let v = add(vault, a.launch.bid_quote_committed)?;
    let s = floor_of(v, s_supply, l, pool.sqrt_max_price)?;
    let f_q64 = ruint::aliases::U256::from(s).saturating_mul(ruint::aliases::U256::from(s)) >> 64;
    let out = FloorReport {
        s,
        f_q64: u128::try_from(f_q64).unwrap_or(u128::MAX),
        v,
        s_supply,
        l,
        s_last: a.launch.s_last,
        bin_id: a.launch.bid_bin_id,
        bin_price: dlmm::price_q64(a.launch.bid_bin_id, a.class.bid_bin_step).unwrap_or(0),
    };
    let mut buf = Vec::with_capacity(132);
    out.serialize(&mut buf)?;
    set_return_data(&buf);
    Ok(())
}

/// §6 `harvest()`: partner LP fees 90% → vault, 10% → treasury; creator LP fees → beneficiary.
pub fn handle_harvest(ctx: Context<Harvest>) -> Result<()> {
    let a = &ctx.accounts;
    require!(
        a.launch.state == launch_state::OPEN,
        BallastError::LaunchWrongState
    );
    let partner = a.partner_auth.key();
    let base_mint = a.launch.base_mint;
    require_keys_eq!(
        a.treasury.key(),
        a.global.treasury,
        BallastError::TreasuryMismatch
    );
    let beneficiary = a.launch.creator_beneficiary;
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
    let pool = launch_pool(&a.launch, &a.damm_pool)?;
    require!(
        a.token_a_vault.key() == pool.token_a_vault && a.token_b_vault.key() == pool.token_b_vault,
        BallastError::DammPoolInvalid
    );
    require!(
        a.partner_nft_account.key() == a.launch.partner_nft_account
            && a.creator_nft_account.key() == a.launch.creator_nft_account,
        BallastError::PositionNotRecorded
    );
    let cp = damm::ClaimPool {
        pool: a.damm_pool.key(),
        token_a_vault: pool.token_a_vault,
        token_b_vault: pool.token_b_vault,
        token_a_mint: base_mint,
        token_b_mint: canon::QUOTE_MINT,
    };
    let infos = [
        a.damm_pool_authority.to_account_info(),
        a.damm_pool.to_account_info(),
        a.partner_position.to_account_info(),
        a.creator_position.to_account_info(),
        a.staging_base.to_account_info(),
        a.vault.to_account_info(),
        a.beneficiary_quote.to_account_info(),
        a.token_a_vault.to_account_info(),
        a.token_b_vault.to_account_info(),
        a.base_mint.to_account_info(),
        a.quote_mint.to_account_info(),
        a.partner_nft_account.to_account_info(),
        a.creator_nft_account.to_account_info(),
        a.partner_auth.to_account_info(),
        a.creator_auth.to_account_info(),
        a.treasury.to_account_info(),
        a.token_program.to_account_info(),
        a.damm_event_authority.to_account_info(),
        a.damm_program.to_account_info(),
    ];
    let v0 = vault_balance(&a.vault, &partner)?;
    let st0 = staging_balance(&a.staging_base, &partner, &base_mint)?;
    let b0 = ben()?;

    // Partner position: quote straight to the vault, base (none in OnlyB) to staging and burned.
    invoke_signed(
        &damm::claim_position_fee(
            &cp,
            a.partner_position.key,
            a.staging_base.key,
            a.vault.key,
            a.partner_nft_account.key,
            &partner,
        ),
        &infos,
        &[partner_seeds!(a.class)],
    )?;
    let partner_quote = sub(vault_balance(&a.vault, &partner)?, v0)?;
    let partner_base = sub(staging_balance(&a.staging_base, &partner, &base_mint)?, st0)?;
    if partner_base > 0 {
        invoke_signed(
            &spl::burn(a.staging_base.key, &base_mint, &partner, partner_base),
            &infos,
            &[partner_seeds!(a.class)],
        )?;
    }
    // 10% to the treasury, rounded down: the vault keeps the remainder (rounding toward holders).
    let to_treasury =
        u64::try_from((partner_quote as u128) * (a.class.harvest_treasury_bps as u128) / 10_000)
            .map_err(|_| error!(BallastError::Overflow))?;
    if to_treasury > 0 {
        invoke_signed(
            &spl::transfer(a.vault.key, a.treasury.key, &partner, to_treasury),
            &infos,
            &[partner_seeds!(a.class)],
        )?;
    }

    // Creator position: quote to the beneficiary's WSOL ATA (D-016); a base fee fails closed.
    let launch_key = a.launch.key();
    let creator_seeds: &[&[u8]] = &[
        b"creator",
        launch_key.as_ref(),
        &[a.launch.creator_auth_bump],
    ];
    let st1 = staging_balance(&a.staging_base, &partner, &base_mint)?;
    invoke_signed(
        &damm::claim_position_fee(
            &cp,
            a.creator_position.key,
            a.staging_base.key,
            a.beneficiary_quote.key,
            a.creator_nft_account.key,
            a.creator_auth.key,
        ),
        &infos,
        &[creator_seeds],
    )?;
    require!(
        staging_balance(&a.staging_base, &partner, &base_mint)? == st1,
        BallastError::CreatorBaseLpFee
    );
    let to_creator = sub(ben()?, b0)?;

    let l = recorded_l(&a.launch, &a.partner_position, &a.creator_position)?;
    let vault = vault_balance(&a.vault, &partner)?;
    let st = staging_balance(&a.staging_base, &partner, &base_mint)?;
    let s_supply = outstanding_supply(&a.base_mint, st)?;
    let s_new = floor_of(
        add(vault, a.launch.bid_quote_committed)?,
        s_supply,
        l,
        pool.sqrt_max_price,
    )?;
    let to_vault = sub(partner_quote, to_treasury)?;

    let launch = &mut ctx.accounts.launch;
    note_backing(launch, l);
    launch.harvested = add(launch.harvested, to_vault)?;
    launch.treasury_fees = add(launch.treasury_fees, to_treasury)?;
    launch.creator_forwarded = add(launch.creator_forwarded, to_creator)?;
    launch.burned = add(launch.burned, partner_base)?;
    monotone(launch, s_new)?;
    emit!(Harvested {
        launch: launch_key,
        to_vault,
        to_treasury,
        to_creator,
        s_new,
    });
    Ok(())
}

/// §6 `deposit(amount)`: WSOL → vault; F rises; no claim of any kind is created.
pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let a = &ctx.accounts;
    require!(
        a.launch.state == launch_state::OPEN,
        BallastError::LaunchWrongState
    );
    require!(amount > 0, BallastError::DepositZero);
    let partner = a.partner_auth.key();
    let pool = launch_pool(&a.launch, &a.damm_pool)?;
    let l = recorded_l(&a.launch, &a.partner_position, &a.creator_position)?;
    let v0 = vault_balance(&a.vault, &partner)?;
    invoke(
        &spl::transfer(a.depositor_quote.key, a.vault.key, a.depositor.key, amount),
        &[
            a.depositor_quote.to_account_info(),
            a.vault.to_account_info(),
            a.depositor.to_account_info(),
            a.token_program.to_account_info(),
        ],
    )?;
    let vault = vault_balance(&a.vault, &partner)?;
    let received = sub(vault, v0)?;
    let st = staging_balance(&a.staging_base, &partner, &a.launch.base_mint)?;
    let s_supply = outstanding_supply(&a.base_mint, st)?;
    let s_new = floor_of(
        add(vault, a.launch.bid_quote_committed)?,
        s_supply,
        l,
        pool.sqrt_max_price,
    )?;
    let from = a.depositor.key();
    let launch = &mut ctx.accounts.launch;
    note_backing(launch, l);
    launch.deposited = add(launch.deposited, received)?;
    monotone(launch, s_new)?;
    emit!(Deposited {
        launch: launch.key(),
        from,
        amount: received,
        s_new,
    });
    Ok(())
}

// ------------------------------------------------------------------------------------------------
// Accounts
// ------------------------------------------------------------------------------------------------

/// The bid's accounts, shared by `open`, `refresh_floor` and `redeem`. Bin arrays go in
/// `remaining_accounts` (D-013: they must already exist).
#[derive(Accounts)]
pub struct BidAccounts<'info> {
    #[account(
        mut,
        seeds = [b"launch", launch.base_mint.as_ref()],
        bump = launch.bump,
        has_one = class,
    )]
    pub launch: Box<Account<'info, Launch>>,
    #[account(seeds = [b"class", class.dbc_config.as_ref()], bump = class.bump)]
    pub class: Box<Account<'info, Class>>,
    /// CHECK: class-wide PDA; vault and staging authority, order owner/sender, and the order's rent
    /// payer and receiver (§5: kept funded by the keeper).
    #[account(mut, seeds = [b"partner", class.dbc_config.as_ref()], bump = class.partner_auth_bump)]
    pub partner_auth: UncheckedAccount<'info>,
    /// CHECK: the launch's WSOL vault — derived, never caller-supplied (§5 rule 3).
    #[account(mut, seeds = [b"vault", launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: `partner_auth`'s base ATA (staging); address and fields checked in the handler.
    #[account(mut)]
    pub staging_base: UncheckedAccount<'info>,
    /// CHECK: the launch's base mint; writable for burns.
    #[account(mut, address = launch.base_mint)]
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: SPL WSOL.
    #[account(address = canon::QUOTE_MINT)]
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: the launch's DLMM pair; key, owner, mints and reserves checked in the handler.
    #[account(mut)]
    pub dlmm_pair: UncheckedAccount<'info>,
    /// CHECK: must equal the pair's `reserve_x` (handler).
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: must equal the pair's `reserve_y` (handler).
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    /// CHECK: the resting order; must equal `launch.bid_order` (handler). Unused by `open`.
    #[account(mut)]
    pub bid_order: UncheckedAccount<'info>,
    /// A fresh keypair for the new order account.
    #[account(mut)]
    pub new_order: Signer<'info>,
    /// CHECK: DLMM `__event_authority`.
    #[account(address = dlmm::DLMM_EVENT_AUTHORITY)]
    pub dlmm_event_authority: UncheckedAccount<'info>,
    /// CHECK: §12 — hard-coded CPI program id.
    #[account(address = DLMM_PROGRAM_ID)]
    pub dlmm_program: UncheckedAccount<'info>,
    /// CHECK: SPL Memo, required by `cancel_limit_order`.
    #[account(address = dlmm::MEMO_PROGRAM_ID)]
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Open<'info> {
    pub bid: BidAccounts<'info>,
    /// CHECK: this launch's `creator_auth` PDA (holder of the creator position NFT).
    #[account(seeds = [b"creator", bid.launch.key().as_ref()], bump = bid.launch.creator_auth_bump)]
    pub creator_auth: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 pool; §8 checks in the handler (canonical address under the migration config).
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 Position (handler).
    pub partner_position: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 Position (handler).
    pub creator_position: UncheckedAccount<'info>,
    /// CHECK: the partner position's NFT account (handler).
    pub partner_nft_account: UncheckedAccount<'info>,
    /// CHECK: the creator position's NFT account (handler).
    pub creator_nft_account: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Refresh<'info> {
    pub bid: BidAccounts<'info>,
    /// CHECK: the launch's DAMM pool (handler).
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: recorded partner position (handler).
    pub partner_position: UncheckedAccount<'info>,
    /// CHECK: recorded creator position (handler).
    pub creator_position: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub bid: BidAccounts<'info>,
    /// CHECK: the launch's DAMM pool (handler).
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: recorded partner position (handler).
    pub partner_position: UncheckedAccount<'info>,
    /// CHECK: recorded creator position (handler).
    pub creator_position: UncheckedAccount<'info>,
    pub holder: Signer<'info>,
    /// CHECK: holder's base token account (mint and authority checked in the handler).
    #[account(mut)]
    pub holder_base: UncheckedAccount<'info>,
    /// CHECK: holder's WSOL token account (mint and authority checked in the handler).
    #[account(mut)]
    pub holder_quote: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FloorView<'info> {
    #[account(seeds = [b"launch", launch.base_mint.as_ref()], bump = launch.bump, has_one = class)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(seeds = [b"class", class.dbc_config.as_ref()], bump = class.bump)]
    pub class: Box<Account<'info, Class>>,
    /// CHECK: PDA with no data.
    #[account(seeds = [b"partner", class.dbc_config.as_ref()], bump = class.partner_auth_bump)]
    pub partner_auth: UncheckedAccount<'info>,
    /// CHECK: derived vault.
    #[account(seeds = [b"vault", launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: staging (handler).
    pub staging_base: UncheckedAccount<'info>,
    /// CHECK: base mint.
    #[account(address = launch.base_mint)]
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: the launch's DAMM pool (handler).
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: recorded partner position (handler).
    pub partner_position: UncheckedAccount<'info>,
    /// CHECK: recorded creator position (handler).
    pub creator_position: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Harvest<'info> {
    #[account(mut, seeds = [b"launch", launch.base_mint.as_ref()], bump = launch.bump, has_one = class)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(seeds = [b"class", class.dbc_config.as_ref()], bump = class.bump)]
    pub class: Box<Account<'info, Class>>,
    #[account(seeds = [b"global"], bump = global.bump)]
    pub global: Box<Account<'info, Global>>,
    /// CHECK: PDA with no data; signs the partner position claim and the treasury transfer.
    #[account(seeds = [b"partner", class.dbc_config.as_ref()], bump = class.partner_auth_bump)]
    pub partner_auth: UncheckedAccount<'info>,
    /// CHECK: PDA with no data; signs the creator position claim.
    #[account(seeds = [b"creator", launch.key().as_ref()], bump = launch.creator_auth_bump)]
    pub creator_auth: UncheckedAccount<'info>,
    /// CHECK: derived vault.
    #[account(mut, seeds = [b"vault", launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: staging (handler).
    #[account(mut)]
    pub staging_base: UncheckedAccount<'info>,
    /// CHECK: base mint; writable for a stray base-fee burn.
    #[account(mut, address = launch.base_mint)]
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: SPL WSOL.
    #[account(address = canon::QUOTE_MINT)]
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: the launch's DAMM pool (handler).
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: recorded partner position (handler).
    #[account(mut)]
    pub partner_position: UncheckedAccount<'info>,
    /// CHECK: recorded creator position (handler).
    #[account(mut)]
    pub creator_position: UncheckedAccount<'info>,
    /// CHECK: recorded NFT account (handler).
    pub partner_nft_account: UncheckedAccount<'info>,
    /// CHECK: recorded NFT account (handler).
    pub creator_nft_account: UncheckedAccount<'info>,
    /// CHECK: must equal the pool's `token_a_vault` (handler).
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: must equal the pool's `token_b_vault` (handler).
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: must equal `global.treasury` (handler).
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: `ATA(creator_beneficiary, WSOL)` (handler).
    #[account(mut)]
    pub beneficiary_quote: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 constant pool authority.
    #[account(address = damm::DAMM_POOL_AUTHORITY)]
    pub damm_pool_authority: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 `__event_authority`.
    #[account(address = damm::DAMM_EVENT_AUTHORITY)]
    pub damm_event_authority: UncheckedAccount<'info>,
    /// CHECK: §12 — hard-coded CPI program id.
    #[account(address = damm::DAMM_PROGRAM_ID)]
    pub damm_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut, seeds = [b"launch", launch.base_mint.as_ref()], bump = launch.bump, has_one = class)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(seeds = [b"class", class.dbc_config.as_ref()], bump = class.bump)]
    pub class: Box<Account<'info, Class>>,
    /// CHECK: PDA with no data; the vault's authority.
    #[account(seeds = [b"partner", class.dbc_config.as_ref()], bump = class.partner_auth_bump)]
    pub partner_auth: UncheckedAccount<'info>,
    /// CHECK: derived vault.
    #[account(mut, seeds = [b"vault", launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: staging (handler).
    pub staging_base: UncheckedAccount<'info>,
    /// CHECK: base mint.
    #[account(address = launch.base_mint)]
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: the launch's DAMM pool (handler).
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: recorded partner position (handler).
    pub partner_position: UncheckedAccount<'info>,
    /// CHECK: recorded creator position (handler).
    pub creator_position: UncheckedAccount<'info>,
    pub depositor: Signer<'info>,
    /// CHECK: the depositor's WSOL account; SPL Token enforces its authority in the transfer.
    #[account(mut)]
    pub depositor_quote: UncheckedAccount<'info>,
    /// CHECK: SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
}

// ------------------------------------------------------------------------------------------------
// Return data and events
// ------------------------------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct FloorReport {
    pub s: u128,
    pub f_q64: u128,
    pub v: u64,
    pub s_supply: u64,
    pub l: u128,
    pub s_last: u128,
    pub bin_id: i32,
    pub bin_price: u128,
}

#[event]
pub struct FloorOpened {
    pub launch: Pubkey,
    pub s_open: u128,
    pub predicted_s: u128,
    pub l: u128,
    pub v: u64,
    pub s_supply: u64,
    pub bin_id: i32,
    pub committed: u64,
}

#[event]
pub struct FloorRefreshed {
    pub launch: Pubkey,
    pub filled: u64,
    pub burned: u64,
    pub s_new: u128,
    pub bin_id: i32,
}

#[event]
pub struct Redeemed {
    pub launch: Pubkey,
    pub holder: Pubkey,
    pub amount: u64,
    pub payout: u64,
    pub s: u128,
    pub s_new: u128,
    pub filled: u64,
}

#[event]
pub struct Harvested {
    pub launch: Pubkey,
    pub to_vault: u64,
    pub to_treasury: u64,
    pub to_creator: u64,
    pub s_new: u128,
}

#[event]
pub struct Deposited {
    pub launch: Pubkey,
    pub from: Pubkey,
    pub amount: u64,
    pub s_new: u128,
}

#[event]
pub struct BackingDecreased {
    pub launch: Pubkey,
    pub l_open: u128,
    pub l_now: u128,
}
