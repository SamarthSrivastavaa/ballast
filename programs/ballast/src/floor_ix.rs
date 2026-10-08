//! Program Part 2 (§6): `open`, `refresh_floor`, `redeem`, `floor`, `harvest`, `deposit`.
//!
//! Every value F depends on — V, S, L, `s_max` — is read from accounts inside the instruction that
//! uses it (§4 rule 2); only `ballast-floor` computes `s` (§4 rule 1); every mutating instruction
//! ends with the monotone check (§4 rule 3). The bid is one DLMM limit order in the highest bin at
//! or below F, owned by `partner_auth`, funded from the vault (§9, D-012). Fills are collected only
//! by cancelling (canon correction 4).
//!
//! Principles from the Part 2 audit (D-021, D-022): no outside actor can prevent the floor from
//! existing, and F and redemption never depend on DLMM pair state — a pinned active bin caps the
//! bid within 70 bins under F's bin or suspends the DLMM leg, it never blocks `open` or `redeem`.
//! The vault has exactly two exits: the DLMM bid it owns and a redeemer (§10).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed, set_return_data};
use ballast_floor::{floor_sqrt_q64, redeem_payout, FloorInputs};

use crate::errors::BallastError;
use crate::state::{canon, launch_state, Class, Global, Launch};
use crate::{ata_of, damm, dlmm, spl, token_balance, DLMM_PROGRAM_ID, TOKEN_PROGRAM_ID};

// ------------------------------------------------------------------------------------------------
// Shared reads and checks
// ------------------------------------------------------------------------------------------------

pub(crate) fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b)
        .ok_or_else(|| error!(BallastError::Overflow))
}

pub(crate) fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or_else(|| error!(BallastError::Overflow))
}

/// `s` from §4 inputs, via the one floor crate. Out-of-range inputs are an error, never a value.
pub(crate) fn floor_of(v: u64, s_supply: u64, l: u128, s_max: u128) -> Result<u128> {
    floor_sqrt_q64(&FloorInputs {
        v,
        s: s_supply,
        l,
        s_max,
    })
    .map_err(|_| error!(BallastError::FloorInputsOutOfRange))
}

pub(crate) fn vault_balance(vault: &AccountInfo, partner: &Pubkey) -> Result<u64> {
    token_balance(
        vault,
        &canon::QUOTE_MINT,
        partner,
        BallastError::VaultInvalid,
    )
}

/// `partner_auth`'s base ATA: the only base staging account (D-016). Missing = error (D-012).
pub(crate) fn staging_balance(
    info: &AccountInfo,
    partner: &Pubkey,
    base_mint: &Pubkey,
) -> Result<u64> {
    require_keys_eq!(
        info.key(),
        ata_of(partner, base_mint),
        BallastError::StagingNotPartnerAta
    );
    token_balance(info, base_mint, partner, BallastError::StagingNotPartnerAta)
}

/// `partner_auth`'s WSOL ATA: `harvest`'s transit account for the partner LP fees (§6 `harvest`,
/// audit 7 Oct), so the treasury share never leaves the vault. Missing = error (D-012).
fn staging_quote_balance(info: &AccountInfo, partner: &Pubkey) -> Result<u64> {
    require_keys_eq!(
        info.key(),
        ata_of(partner, &canon::QUOTE_MINT),
        BallastError::StagingQuoteInvalid
    );
    token_balance(
        info,
        &canon::QUOTE_MINT,
        partner,
        BallastError::StagingQuoteInvalid,
    )
}

/// S = `base_mint.supply` − PDA-held base. The only PDA account that can hold base is the
/// staging ATA (the vault is WSOL; a creator base fee fails closed), so S counts everything else —
/// including filled base still inside a DLMM order, which can only understate F.
pub(crate) fn outstanding_supply(base_mint: &AccountInfo, staging: u64) -> Result<u64> {
    let supply = spl::read_mint_supply(base_mint)
        .ok_or_else(|| error!(BallastError::LaunchBaseMintNotSpl))?;
    sub(supply, staging)
}

/// The two recorded positions' `permanent_locked_liquidity`, re-read live with identity checks only
/// (§8 fail-safe, audit 7 Oct): a decrease degrades the launch through `note_backing`, it never
/// aborts the instruction — least of all a redemption. Returns `(partner, creator)`.
pub(crate) fn recorded_l(
    launch: &Launch,
    partner_pos: &AccountInfo,
    creator_pos: &AccountInfo,
) -> Result<(u128, u128)> {
    require!(
        partner_pos.key() == launch.partner_position
            && creator_pos.key() == launch.creator_position,
        BallastError::PositionNotRecorded
    );
    Ok((
        damm::read_position_identity(partner_pos, &launch.damm_pool)?,
        damm::read_position_identity(creator_pos, &launch.damm_pool)?,
    ))
}

/// L = the sum over the two recorded positions (§8: only these two count).
pub(crate) fn total_l((pl, cl): (u128, u128)) -> Result<u128> {
    pl.checked_add(cl)
        .ok_or_else(|| error!(BallastError::Overflow))
}

/// The launch's DAMM pool, re-verified (§8), for `s_max` (re-read, never hard-coded).
pub(crate) fn launch_pool(launch: &Launch, pool: &AccountInfo) -> Result<damm::PoolView> {
    require_keys_eq!(pool.key(), launch.damm_pool, BallastError::DammPoolInvalid);
    damm::read_pool(pool, &launch.base_mint, &canon::QUOTE_MINT)
}

/// §8 fail-safe, per position (audit 7 Oct): every read below a position's last recorded L emits
/// `BackingDecreased` for that position, lowers the record (so each further decrease is reported
/// too) and marks the launch degraded — the monotone check is suspended, redemption stays open.
/// Meteora cannot do this to permanent liquidity today.
pub(crate) fn note_backing(launch_key: Pubkey, launch: &mut Launch, (pl, cl): (u128, u128)) {
    if pl < launch.partner_l_recorded {
        emit!(BackingDecreased {
            launch: launch_key,
            position: launch.partner_position,
            l_recorded: launch.partner_l_recorded,
            l_read: pl,
        });
        launch.partner_l_recorded = pl;
        launch.degraded = true;
    }
    if cl < launch.creator_l_recorded {
        emit!(BackingDecreased {
            launch: launch_key,
            position: launch.creator_position,
            l_recorded: launch.creator_l_recorded,
            l_read: cl,
        });
        launch.creator_l_recorded = cl;
        launch.degraded = true;
    }
}

/// §4 rule 3: `require!(s_new ≥ s_last)`, then `s_last = s_new` (suspended only when degraded, §8).
pub(crate) fn monotone(launch: &mut Launch, s_new: u128) -> Result<()> {
    if !launch.degraded {
        require!(s_new >= launch.s_last, BallastError::FloorDecreased);
    }
    launch.s_last = s_new;
    Ok(())
}

/// `price(id) ≤ F`, with DLMM's own price function (vendored). The comparison — including the rule
/// for bins where DLMM has no price — is `ballast-floor`'s (§4 rule 1), shared with the verifier and
/// the app (D-021).
fn below(id: i32, bin_step: u16, s: u128) -> bool {
    ballast_floor::price_at_or_below(dlmm::price_q64(id, bin_step), id, s)
}

/// §9: `price(id) ≤ F < price(id + 1)` — `id` is the highest bin at or below F (`ballast-floor`).
fn is_floor_bin(id: i32, bin_step: u16, s: u128) -> bool {
    let next = id.saturating_add(1);
    ballast_floor::is_floor_bin(
        dlmm::price_q64(id, bin_step),
        dlmm::price_q64(next, bin_step),
        id,
        s,
    )
}

/// Where the whole vault rests (§9, D-020, D-021).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Placement {
    /// One order at `bin`. `capped`: below F's bin because a third-party order pins the active bin
    /// (D-020). `move_up`: Ballast first moves the active bin up to `bin` with `go_to_a_bin`, since
    /// DLMM refuses a bid above the active bin.
    At {
        bin: i32,
        capped: bool,
        move_up: bool,
    },
    /// D-021: the active bin is pinned more than `MAX_CAP_DEPTH` bins under F's bin (or where DLMM
    /// has no price). The vault rests unplaced; V still counts it; redemption stays live.
    Suspended,
}

/// `open` / `refresh_floor` (D-020, D-021). The keeper's hint is F's bin — Ballast moves the active
/// bin up to it if needed — or, when a third-party order blocks that move (DLMM 6056), exactly the
/// active bin: a cap if F's bin is within 70 bins above it, else a suspension. A failed CPI aborts
/// the whole transaction, so the choice is the keeper's retry, never a try/catch. Anything else is
/// `BinHintNotAtFloor`.
fn resolve_hint(hint: i32, active: i32, bin_step: u16, s: u128) -> Result<Placement> {
    if is_floor_bin(hint, bin_step, s) {
        return Ok(Placement::At {
            bin: hint,
            capped: false,
            move_up: active < hint,
        });
    }
    require!(
        hint == active && below(active.saturating_add(1), bin_step, s),
        BallastError::BinHintNotAtFloor
    );
    Ok(pinned(active, bin_step, s))
}

/// F's bin lies above the active bin and the active bin cannot (or, in `redeem`, will not) move.
fn pinned(active: i32, bin_step: u16, s: u128) -> Placement {
    if below(
        active.saturating_add(canon::MAX_CAP_DEPTH.saturating_add(1)),
        bin_step,
        s,
    ) {
        Placement::Suspended
    } else {
        Placement::At {
            bin: active,
            capped: true,
            move_up: false,
        }
    }
}

/// `redeem`'s re-placement (D-020, D-021): it never moves the active bin, so no third party can
/// block a redemption, and it never fails on pair state — F's bin when the active bin allows it,
/// else capped at the active bin, else suspended.
fn redeem_placement(old_bin: i32, active: i32, bin_step: u16, s: u128) -> Placement {
    if below(active.saturating_add(1), bin_step, s) {
        return pinned(active, bin_step, s);
    }
    Placement::At {
        bin: floor_bin_up_to(old_bin, active, bin_step, s),
        capped: false,
        move_up: false,
    }
}

/// F's bin, given that it is ≤ `active`: a binary search on the monotone bin price between a lower
/// bound at or below F and `active`. The lower bound is the old bid bin when it qualifies (F never
/// falls, so it usually does), else found by doubling steps down from `active` — that search always
/// ends, because a bin far enough down has no price, which counts as at or below F.
fn floor_bin_up_to(old_bin: i32, active: i32, bin_step: u16, s: u128) -> i32 {
    let mut lo = if old_bin <= active && below(old_bin, bin_step, s) {
        i64::from(old_bin)
    } else {
        let mut d = 1i64;
        loop {
            let c = (i64::from(active) - d).max(i64::from(i32::MIN));
            if below(c as i32, bin_step, s) {
                break c;
            }
            d = d.saturating_mul(2);
        }
    };
    let mut hi = i64::from(active);
    while lo < hi {
        let mid = lo + (hi - lo + 1) / 2;
        if below(mid as i32, bin_step, s) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo as i32
}

/// The pair's live active bin.
fn active_id(pair: &AccountInfo) -> Result<i32> {
    let data = pair.try_borrow_data()?;
    let lb = meteora_types::decode::<meteora_types::dlmm::LbPair>(
        &data,
        &meteora_types::dlmm::LbPair::DISCRIMINATOR,
    )
    .ok_or_else(|| error!(BallastError::PairAccountsInvalid))?;
    Ok(lb.active_id)
}

/// A DLMM `BinArray` account (§5 rule 1: owner and discriminator).
fn is_bin_array(info: &AccountInfo) -> bool {
    *info.owner == DLMM_PROGRAM_ID
        && info
            .try_borrow_data()
            .map(|d| d.len() >= 8 && d[..8] == dlmm::BIN_ARRAY_DISCRIMINATOR)
            .unwrap_or(false)
}

/// Whether the bin array holding `bin_id` exists as a DLMM `BinArray`. Its derived address must be in
/// `remaining_accounts` (a caller cannot claim "missing" for an array that exists).
fn bin_array_ready(remaining: &[AccountInfo], lb_pair: &Pubkey, bin_id: i32) -> Result<bool> {
    let want = dlmm::bin_array_address(lb_pair, dlmm::bin_array_index(bin_id));
    let info = remaining
        .iter()
        .find(|a| a.key() == want)
        .ok_or_else(|| error!(BallastError::BinArrayMissing))?;
    Ok(is_bin_array(info))
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
        is_bin_array(info) && info.is_writable,
        BallastError::BinArrayMissing
    );
    Ok(info.clone())
}

/// The `bin_array_bitmap_extension` for a CPI touching `bins` (D-021): `None` while every bin's
/// array lies inside the pair's internal bitmap, else the pair's `["bitmap", lb_pair]` account,
/// passed in `remaining_accounts` and DLMM-owned.
fn bitmap_extension<'info>(
    remaining: &[AccountInfo<'info>],
    lb_pair: &Pubkey,
    bins: &[i32],
) -> Result<Option<AccountInfo<'info>>> {
    if !bins.iter().any(|&b| dlmm::needs_bitmap_extension(b)) {
        return Ok(None);
    }
    let want = dlmm::bitmap_extension_address(lb_pair);
    let info = remaining
        .iter()
        .find(|a| a.key() == want)
        .ok_or_else(|| error!(BallastError::BitmapExtensionMismatch))?;
    let is_extension = *info.owner == DLMM_PROGRAM_ID
        && info
            .try_borrow_data()
            .map(|d| d.len() >= 8 && d[..8] == dlmm::BITMAP_EXTENSION_DISCRIMINATOR)
            .unwrap_or(false);
    require!(is_extension, BallastError::BitmapExtensionMismatch);
    Ok(Some(info.clone()))
}

/// The extension's key for an instruction builder: the DLMM program id is Anchor's "None".
fn extension_key(ext: &Option<AccountInfo>) -> Pubkey {
    ext.as_ref().map(|e| e.key()).unwrap_or(DLMM_PROGRAM_ID)
}

/// The launch's DLMM pair and its reserves, cross-checked against the `LbPair` account (§5 rule 2:
/// mints, reserves and the class bin step).
fn read_pair(
    launch: &Launch,
    class: &Class,
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
    let bin_step = lb.bin_step;
    require!(
        p.token_x_mint == launch.base_mint
            && p.token_y_mint == canon::QUOTE_MINT
            && p.reserve_x == *reserve_x
            && p.reserve_y == *reserve_y
            && bin_step == class.bid_bin_step,
        BallastError::PairAccountsInvalid
    );
    Ok(p)
}

/// The resting order, fully checked before Ballast cancels it (§5 rules 1–2, audit 7 Oct): the
/// recorded key, DLMM-owned, a `LimitOrder` by discriminator, `owner == partner_auth`, on the
/// launch's pair. The account carries per-bin data after its header, so only the header is decoded.
fn check_bid_order(info: &AccountInfo, launch: &Launch, partner: &Pubkey) -> Result<()> {
    require_keys_eq!(info.key(), launch.bid_order, BallastError::BidOrderMismatch);
    require_keys_eq!(*info.owner, DLMM_PROGRAM_ID, BallastError::BidOrderInvalid);
    let data = info.try_borrow_data()?;
    let header = 8 + core::mem::size_of::<meteora_types::dlmm::LimitOrder>();
    require!(data.len() >= header, BallastError::BidOrderInvalid);
    let lo = meteora_types::decode::<meteora_types::dlmm::LimitOrder>(
        &data[..header],
        &dlmm::LIMIT_ORDER_DISCRIMINATOR,
    )
    .ok_or_else(|| error!(BallastError::BidOrderInvalid))?;
    require!(
        Pubkey::new_from_array(lo.owner) == *partner
            && Pubkey::new_from_array(lo.lb_pair) == launch.dlmm_pair,
        BallastError::BidOrderInvalid
    );
    Ok(())
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

/// Burn `partner_auth`'s whole base staging balance and return it (§5: staging is transit only,
/// zero at the end of the instruction). Fills and anything sent there from outside are burned
/// alike; S excludes staging, so the burn leaves S — and F — unchanged, and `burned` records it.
pub(crate) fn burn_staging<'info>(
    staging: &AccountInfo<'info>,
    base_mint: &AccountInfo<'info>,
    partner_auth: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    class: &Class,
) -> Result<u64> {
    let amount = staging_balance(staging, partner_auth.key, base_mint.key)?;
    if amount > 0 {
        invoke_signed(
            &spl::burn(staging.key, base_mint.key, partner_auth.key, amount),
            &[
                staging.clone(),
                base_mint.clone(),
                partner_auth.clone(),
                token_program.clone(),
            ],
            &[partner_seeds!(class)],
        )?;
    }
    Ok(amount)
}

// ------------------------------------------------------------------------------------------------
// The bid: settle, place, move
// ------------------------------------------------------------------------------------------------

/// What settling the resting bid did.
struct Settled {
    /// Base units the bid bought (the cancel's staging delta).
    filled: u64,
    /// Base units burned from staging: the fill plus anything sent there from outside.
    burned: u64,
    /// Quote the cancel returned to the vault: unfilled + DLMM fees (Q5: exactly).
    quote_returned: u64,
    /// `bid_quote_committed` before the cancel.
    committed: u64,
}

/// Settle the resting bid: cancel (filled base → staging, unfilled quote + fees → vault), close the
/// order (rent back to `partner_auth`), then burn the whole staging balance. With no resting order
/// (exhausted vault, suspended leg) only the staging burn runs.
fn settle_bid<'info>(
    pair: &dlmm::Pair,
    bid: &BidAccounts<'info>,
    remaining: &[AccountInfo<'info>],
) -> Result<Settled> {
    let (class, launch) = (&bid.class, &bid.launch);
    let partner = bid.partner_auth.key();
    let base_mint = launch.base_mint;
    let committed = launch.bid_quote_committed;
    let mut filled = 0;
    let mut quote_returned = 0;
    if launch.bid_order != Pubkey::default() {
        check_bid_order(&bid.bid_order, launch, &partner)?;
        let bin = launch.bid_bin_id;
        let ext = bitmap_extension(remaining, &pair.lb_pair, &[bin])?;
        let arr = bin_array_for(remaining, &pair.lb_pair, bin)?;
        let st0 = staging_balance(&bid.staging_base, &partner, &base_mint)?;
        let v0 = vault_balance(&bid.vault, &partner)?;
        let mut infos = vec![
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
        if let Some(e) = &ext {
            infos.push(e.clone());
        }
        invoke_signed(
            &dlmm::cancel(
                pair,
                &extension_key(&ext),
                &launch.bid_order,
                bid.staging_base.key,
                bid.vault.key,
                &partner,
                arr.key,
                bin,
            ),
            &infos,
            &[partner_seeds!(class)],
        )?;
        invoke_signed(
            &dlmm::close_if_empty(&launch.bid_order, &partner, &partner),
            &infos,
            &[partner_seeds!(class)],
        )?;
        filled = sub(
            staging_balance(&bid.staging_base, &partner, &base_mint)?,
            st0,
        )?;
        quote_returned = sub(vault_balance(&bid.vault, &partner)?, v0)?;
    }
    let burned = burn_staging(
        &bid.staging_base,
        &bid.base_mint,
        &bid.partner_auth,
        &bid.token_program,
        class,
    )?;
    Ok(Settled {
        filled,
        burned,
        quote_returned,
        committed,
    })
}

/// D-020/D-021: CPI `go_to_a_bin(to)` so a bid at F's bin is not above the active bin. Both bin
/// arrays are passed at their derived addresses in `remaining_accounts`; an uninitialised one is
/// "None", as in the SDK, and the bitmap extension is passed when either lies outside the internal
/// bitmap. If a third-party order sits in the range, DLMM refuses (6056) and the whole transaction
/// reverts — the keeper then calls again with the active bin as the hint.
fn move_active<'info>(
    pair: &dlmm::Pair,
    bid: &BidAccounts<'info>,
    remaining: &[AccountInfo<'info>],
    from: i32,
    to: i32,
) -> Result<()> {
    let ext = bitmap_extension(remaining, &pair.lb_pair, &[from, to])?;
    let mut infos = vec![
        bid.dlmm_pair.to_account_info(),
        bid.dlmm_program.to_account_info(),
        bid.dlmm_event_authority.to_account_info(),
    ];
    if let Some(e) = &ext {
        infos.push(e.clone());
    }
    let mut arr = |id: i32| -> Result<Option<Pubkey>> {
        let want = dlmm::bin_array_address(&pair.lb_pair, dlmm::bin_array_index(id));
        let info = remaining
            .iter()
            .find(|a| a.key() == want)
            .ok_or_else(|| error!(BallastError::BinArrayMissing))?;
        if is_bin_array(info) {
            infos.push(info.clone());
            Ok(Some(want))
        } else {
            Ok(None)
        }
    };
    let (f, t) = (arr(from)?, arr(to)?);
    invoke(
        &dlmm::go_to_a_bin(&pair.lb_pair, ext.as_ref().map(|e| e.key()), f, t, to),
        &infos,
    )?;
    Ok(())
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
    let ext = bitmap_extension(remaining, &pair.lb_pair, &[bin_id])?;
    let arr = bin_array_for(remaining, &pair.lb_pair, bin_id)?;
    let partner = bid.partner_auth.key();
    let mut infos = vec![
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
        arr.clone(),
    ];
    if let Some(e) = &ext {
        infos.push(e.clone());
    }
    invoke_signed(
        &dlmm::place_bid(
            pair,
            &extension_key(&ext),
            bid.new_order.key,
            &partner,
            &partner,
            bid.vault.key,
            &partner,
            arr.key,
            bin_id,
            amount,
        ),
        &infos,
        &[partner_seeds!(bid.class)],
    )?;
    Ok(())
}

/// Rest the whole vault as one bid per `placement` (§9, canon correction 5). Returns the quote
/// committed (measured); 0 when the vault is empty or the DLMM leg is suspended (nothing placed).
/// The token account's rent reserve is not part of its WSOL amount, so it stays as the rent float.
fn rest<'info>(
    pair: &dlmm::Pair,
    bid: &BidAccounts<'info>,
    remaining: &[AccountInfo<'info>],
    placement: Placement,
    active: i32,
) -> Result<u64> {
    let Placement::At { bin, move_up, .. } = placement else {
        return Ok(0);
    };
    let partner = bid.partner_auth.key();
    let v0 = vault_balance(&bid.vault, &partner)?;
    if v0 == 0 {
        return Ok(0);
    }
    if move_up {
        move_active(pair, bid, remaining, active, bin)?;
    }
    place(pair, bid, remaining, bin, v0)?;
    sub(v0, vault_balance(&bid.vault, &partner)?)
}

/// Record where the vault now rests. While suspended, `bid_bin_id` is the pinned active bin.
fn record_placement(
    launch: &mut Launch,
    placement: Placement,
    active: i32,
    committed: u64,
    order: Pubkey,
) {
    let placed = committed > 0;
    let (bin, capped, suspended) = match placement {
        Placement::At { bin, capped, .. } => (bin, capped, false),
        Placement::Suspended => (active, false, true),
    };
    launch.bid_quote_committed = committed;
    launch.bid_order = if placed { order } else { Pubkey::default() };
    launch.bid_bin_id = bin;
    launch.bid_capped = capped && placed;
    launch.bid_suspended = suspended;
}

/// §10 ledger counters for a settlement (audit 7 Oct).
fn record_settlement(launch: &mut Launch, s: &Settled) -> Result<()> {
    launch.burned = add(launch.burned, s.burned)?;
    launch.filled_tokens = add(launch.filled_tokens, s.filled)?;
    // Quote the bid spent on fills, net of the fees DLMM credits back with the unfilled rest.
    launch.fill_quote_spent = add(
        launch.fill_quote_spent,
        s.committed.saturating_sub(s.quote_returned),
    )?;
    Ok(())
}

/// D-020 / D-021 events for the placement just recorded.
fn emit_placement(launch_key: Pubkey, launch: &Launch) {
    if launch.bid_capped {
        emit!(BidCapped {
            launch: launch_key,
            bin: launch.bid_bin_id,
        });
    }
    if launch.bid_suspended {
        emit!(BidSuspended {
            launch: launch_key,
            active_bin: launch.bid_bin_id,
        });
    }
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
    let launch_key = a.bid.launch.key();

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
    let l = total_l((pl, cl))?;

    let pair = read_pair(
        &a.bid.launch,
        &a.bid.class,
        &a.bid.dlmm_pair,
        a.bid.reserve_x.key,
        a.bid.reserve_y.key,
    )?;

    // §5: staging ends at zero — anything sent to it before `open` is burned and recorded.
    let swept = burn_staging(
        &a.bid.staging_base,
        &a.bid.base_mint,
        &a.bid.partner_auth,
        &a.bid.token_program,
        &a.bid.class,
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
    let active = active_id(&a.bid.dlmm_pair)?;
    let placement = resolve_hint(bin_id_hint, active, a.bid.class.bid_bin_step, s_open)?;

    // The whole vault as one bid (canon correction 5), or nothing while suspended (D-021).
    let committed = rest(&pair, &a.bid, ctx.remaining_accounts, placement, active)?;
    let vault1 = vault_balance(&a.bid.vault, &partner)?;

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
    record_placement(launch, placement, active, committed, order);
    launch.s_open = s_open;
    launch.l_open = l;
    launch.partner_l_recorded = pl;
    launch.creator_l_recorded = cl;
    launch.burned = add(launch.burned, swept)?;
    launch.open_slot = slot;
    launch.last_refresh_slot = slot;
    monotone(launch, s_end)?;
    launch.state = launch_state::OPEN;
    emit!(FloorOpened {
        launch: launch_key,
        s_open,
        predicted_s: launch.predicted_s,
        l,
        v,
        s_supply,
        bin_id: launch.bid_bin_id,
        committed,
        order: launch.bid_order,
    });
    emit_placement(launch_key, launch);
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
    // §6 rate limit. While the bid is capped or suspended, only a refresh that lifts it to F's bin
    // may skip the window (audit 7 Oct) — checked once the placement is known.
    let slot = Clock::get()?.slot;
    let limited = slot
        < a.bid
            .launch
            .last_refresh_slot
            .saturating_add(canon::REFRESH_MIN_SLOTS);
    let held = a.bid.launch.bid_capped || a.bid.launch.bid_suspended;
    require!(!limited || held, BallastError::RefreshRateLimited);

    let partner = a.bid.partner_auth.key();
    let base_mint = a.bid.launch.base_mint;
    let launch_key = a.bid.launch.key();
    let pool = launch_pool(&a.bid.launch, &a.damm_pool)?;
    let ls = recorded_l(&a.bid.launch, &a.partner_position, &a.creator_position)?;
    let l = total_l(ls)?;
    let pair = read_pair(
        &a.bid.launch,
        &a.bid.class,
        &a.bid.dlmm_pair,
        a.bid.reserve_x.key,
        a.bid.reserve_y.key,
    )?;

    let settled = settle_bid(&pair, &a.bid, ctx.remaining_accounts)?;

    let vault = vault_balance(&a.bid.vault, &partner)?;
    let st = staging_balance(&a.bid.staging_base, &partner, &base_mint)?;
    let s_supply = outstanding_supply(&a.bid.base_mint, st)?;
    let s_new = floor_of(vault, s_supply, l, pool.sqrt_max_price)?;
    let active = active_id(&a.bid.dlmm_pair)?;
    let placement = resolve_hint(bin_id_hint, active, a.bid.class.bid_bin_step, s_new)?;
    if limited {
        let lifts = match placement {
            Placement::At {
                bin, capped: false, ..
            } => a.bid.launch.bid_suspended || bin > a.bid.launch.bid_bin_id,
            _ => false,
        };
        require!(lifts, BallastError::RefreshRateLimited);
    }
    let committed = rest(&pair, &a.bid, ctx.remaining_accounts, placement, active)?;
    let vault_end = vault_balance(&a.bid.vault, &partner)?;
    let s_end = floor_of(add(vault_end, committed)?, s_supply, l, pool.sqrt_max_price)?;
    let order = a.bid.new_order.key();

    let launch = &mut ctx.accounts.bid.launch;
    note_backing(launch_key, launch, ls);
    record_settlement(launch, &settled)?;
    record_placement(launch, placement, active, committed, order);
    launch.last_refresh_slot = slot;
    monotone(launch, s_end)?;
    emit!(FloorRefreshed {
        launch: launch_key,
        filled_tokens: settled.filled,
        burned: settled.burned,
        quote_returned: settled.quote_returned,
        s_new: s_end,
        bin_id: launch.bid_bin_id,
        order: launch.bid_order,
    });
    emit_placement(launch_key, launch);
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
    let launch_key = a.bid.launch.key();
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
    let ls = recorded_l(&a.bid.launch, &a.partner_position, &a.creator_position)?;
    let l = total_l(ls)?;
    let pair = read_pair(
        &a.bid.launch,
        &a.bid.class,
        &a.bid.dlmm_pair,
        a.bid.reserve_x.key,
        a.bid.reserve_y.key,
    )?;

    // 1. Settle the bid so V and S are exact (canon correction 4).
    let settled = settle_bid(&pair, &a.bid, ctx.remaining_accounts)?;

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

    // 4. s′ from the post-state; then re-place at the highest bin ≤ F′ — never moving the active
    // bin and never failing on pair state (D-020, D-021).
    let vault1 = vault_balance(&a.bid.vault, &partner)?;
    let s_supply1 = outstanding_supply(&a.bid.base_mint, st)?;
    let s_new = floor_of(vault1, s_supply1, l, pool.sqrt_max_price)?;
    let active = active_id(&a.bid.dlmm_pair)?;
    let placement = redeem_placement(
        a.bid.launch.bid_bin_id,
        active,
        a.bid.class.bid_bin_step,
        s_new,
    );
    // Redemption never depends on DLMM pair state (CLAUDE.md, D-021): if the chosen bin's array was
    // never created, the vault stays unplaced rather than the redemption reverting. The derived
    // address must still be passed, and an initialised array cannot be faked (owner + discriminator).
    let placement = match placement {
        Placement::At { bin, .. }
            if !bin_array_ready(ctx.remaining_accounts, &pair.lb_pair, bin)? =>
        {
            Placement::Suspended
        }
        p => p,
    };
    let committed = rest(&pair, &a.bid, ctx.remaining_accounts, placement, active)?;
    let vault_end = vault_balance(&a.bid.vault, &partner)?;
    let s_end = floor_of(
        add(vault_end, committed)?,
        s_supply1,
        l,
        pool.sqrt_max_price,
    )?;
    let order = a.bid.new_order.key();

    let launch = &mut ctx.accounts.bid.launch;
    note_backing(launch_key, launch, ls);
    record_settlement(launch, &settled)?;
    launch.burned = add(launch.burned, amount)?;
    launch.redeemed_tokens = add(launch.redeemed_tokens, amount)?;
    launch.redeemed_lamports = add(launch.redeemed_lamports, payout)?;
    record_placement(launch, placement, active, committed, order);
    monotone(launch, s_end)?;
    emit!(Redeemed {
        launch: launch_key,
        holder,
        amount,
        payout,
        s_before: s,
        s_after: s_end,
        filled_tokens: settled.filled,
        quote_returned: settled.quote_returned,
    });
    emit_placement(launch_key, launch);
    Ok(())
}

/// §6 `floor()` view: `{s, F_q64, V, S, L, s_last, bin_id, bin_price, capped, suspended}` via
/// `set_return_data`. F is returned as `s²/2^64` — Q64.64 lamports per base unit, the unit of DLMM
/// bin prices.
pub fn handle_floor(ctx: Context<FloorView>) -> Result<()> {
    let a = &ctx.accounts;
    require!(
        a.launch.state == launch_state::OPEN,
        BallastError::LaunchWrongState
    );
    let partner = a.partner_auth.key();
    let pool = launch_pool(&a.launch, &a.damm_pool)?;
    let l = total_l(recorded_l(
        &a.launch,
        &a.partner_position,
        &a.creator_position,
    )?)?;
    let vault = vault_balance(&a.vault, &partner)?;
    let st = staging_balance(&a.staging_base, &partner, &a.launch.base_mint)?;
    let s_supply = outstanding_supply(&a.base_mint, st)?;
    let v = add(vault, a.launch.bid_quote_committed)?;
    let s = floor_of(v, s_supply, l, pool.sqrt_max_price)?;
    let f_q64 = ballast_floor::f_q64(s);
    let out = FloorReport {
        s,
        f_q64,
        v,
        s_supply,
        l,
        s_last: a.launch.s_last,
        bin_id: a.launch.bid_bin_id,
        bin_price: dlmm::price_q64(a.launch.bid_bin_id, a.class.bid_bin_step).unwrap_or(0),
        capped: a.launch.bid_capped,
        suspended: a.launch.bid_suspended,
    };
    let mut buf = Vec::with_capacity(134);
    out.serialize(&mut buf)?;
    set_return_data(&buf);
    Ok(())
}

/// §6 `harvest()` as amended by D-022 and the 7 Oct audit: the partner position only. Its fees are
/// claimed into `partner_auth`'s WSOL staging ATA; 10% (rounded down) goes staging → treasury and
/// the whole remaining staging balance goes → vault, so staging ends at zero and the vault is never
/// a source (§10). The creator position's fees are `pay_creator`'s.
pub fn handle_harvest(ctx: Context<Harvest>) -> Result<()> {
    let a = &ctx.accounts;
    require!(
        a.launch.state == launch_state::OPEN,
        BallastError::LaunchWrongState
    );
    let partner = a.partner_auth.key();
    let base_mint = a.launch.base_mint;
    let launch_key = a.launch.key();
    require_keys_eq!(
        a.treasury.key(),
        a.global.treasury,
        BallastError::TreasuryMismatch
    );
    let pool = launch_pool(&a.launch, &a.damm_pool)?;
    require!(
        a.token_a_vault.key() == pool.token_a_vault && a.token_b_vault.key() == pool.token_b_vault,
        BallastError::DammPoolInvalid
    );
    require!(
        a.partner_position.key() == a.launch.partner_position
            && a.partner_nft_account.key() == a.launch.partner_nft_account,
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
        a.staging_base.to_account_info(),
        a.staging_quote.to_account_info(),
        a.vault.to_account_info(),
        a.token_a_vault.to_account_info(),
        a.token_b_vault.to_account_info(),
        a.base_mint.to_account_info(),
        a.quote_mint.to_account_info(),
        a.partner_nft_account.to_account_info(),
        a.partner_auth.to_account_info(),
        a.treasury.to_account_info(),
        a.token_program.to_account_info(),
        a.damm_event_authority.to_account_info(),
        a.damm_program.to_account_info(),
    ];
    let sq0 = staging_quote_balance(&a.staging_quote, &partner)?;
    staging_balance(&a.staging_base, &partner, &base_mint)?;

    // Partner position: quote (OnlyB) to WSOL staging; any base to base staging (burned below).
    invoke_signed(
        &damm::claim_position_fee(
            &cp,
            a.partner_position.key,
            a.staging_base.key,
            a.staging_quote.key,
            a.partner_nft_account.key,
            &partner,
        ),
        &infos,
        &[partner_seeds!(a.class)],
    )?;
    let sq1 = staging_quote_balance(&a.staging_quote, &partner)?;
    let claimed = sub(sq1, sq0)?;
    // 10% of the claimed fees to the treasury, rounded down (rounding toward holders).
    let to_treasury =
        u64::try_from((claimed as u128) * (a.class.harvest_treasury_bps as u128) / 10_000)
            .map_err(|_| error!(BallastError::Overflow))?;
    if to_treasury > 0 {
        invoke_signed(
            &spl::transfer(a.staging_quote.key, a.treasury.key, &partner, to_treasury),
            &infos,
            &[partner_seeds!(a.class)],
        )?;
    }
    // Everything left in staging goes to the vault, so staging ends at zero.
    let to_vault = sub(sq1, to_treasury)?;
    if to_vault > 0 {
        invoke_signed(
            &spl::transfer(a.staging_quote.key, a.vault.key, &partner, to_vault),
            &infos,
            &[partner_seeds!(a.class)],
        )?;
    }
    let base_burned = burn_staging(
        &a.staging_base,
        &a.base_mint,
        &a.partner_auth,
        &a.token_program,
        &a.class,
    )?;

    let ls = recorded_l(&a.launch, &a.partner_position, &a.creator_position)?;
    let l = total_l(ls)?;
    let vault = vault_balance(&a.vault, &partner)?;
    let st = staging_balance(&a.staging_base, &partner, &base_mint)?;
    let s_supply = outstanding_supply(&a.base_mint, st)?;
    let s_new = floor_of(
        add(vault, a.launch.bid_quote_committed)?,
        s_supply,
        l,
        pool.sqrt_max_price,
    )?;

    let launch = &mut ctx.accounts.launch;
    note_backing(launch_key, launch, ls);
    launch.harvested = add(launch.harvested, to_vault)?;
    launch.treasury_fees = add(launch.treasury_fees, to_treasury)?;
    launch.burned = add(launch.burned, base_burned)?;
    monotone(launch, s_new)?;
    emit!(Harvested {
        launch: launch_key,
        to_vault,
        to_treasury,
        base_burned,
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
    let launch_key = a.launch.key();
    // §5 rule 3: the depositor's own WSOL account, checked here rather than left to SPL Token.
    token_balance(
        &a.depositor_quote,
        &canon::QUOTE_MINT,
        a.depositor.key,
        BallastError::DepositorAccountInvalid,
    )?;
    let pool = launch_pool(&a.launch, &a.damm_pool)?;
    let ls = recorded_l(&a.launch, &a.partner_position, &a.creator_position)?;
    let l = total_l(ls)?;
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
    // §5: staging ends every instruction at zero; S excludes it, so burning it leaves F unchanged.
    let burned = burn_staging(
        &a.staging_base,
        &a.base_mint,
        &a.partner_auth,
        &a.token_program,
        &a.class,
    )?;
    let s_supply = outstanding_supply(&a.base_mint, 0)?;
    let s_new = floor_of(
        add(vault, a.launch.bid_quote_committed)?,
        s_supply,
        l,
        pool.sqrt_max_price,
    )?;
    let from = a.depositor.key();
    let launch = &mut ctx.accounts.launch;
    note_backing(launch_key, launch, ls);
    launch.deposited = add(launch.deposited, received)?;
    launch.burned = add(launch.burned, burned)?;
    monotone(launch, s_new)?;
    emit!(Deposited {
        launch: launch_key,
        from,
        amount: received,
        s_new,
    });
    Ok(())
}

// ------------------------------------------------------------------------------------------------
// Accounts
// ------------------------------------------------------------------------------------------------

/// The bid's accounts, shared by `open`, `refresh_floor` and `redeem`. Bin arrays (D-013: they must
/// already exist) and, when a bin lies outside the internal bitmap, the pair's bitmap extension
/// (D-021) go in `remaining_accounts`.
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
    /// CHECK: the launch's DLMM pair; key, owner, mints, reserves and bin step checked in the handler.
    #[account(mut)]
    pub dlmm_pair: UncheckedAccount<'info>,
    /// CHECK: must equal the pair's `reserve_x` (handler).
    #[account(mut)]
    pub reserve_x: UncheckedAccount<'info>,
    /// CHECK: must equal the pair's `reserve_y` (handler).
    #[account(mut)]
    pub reserve_y: UncheckedAccount<'info>,
    /// CHECK: the resting order; `launch.bid_order`, decoded and checked before the cancel (handler).
    /// Unused by `open` and while no order rests.
    #[account(mut)]
    pub bid_order: UncheckedAccount<'info>,
    /// A fresh keypair for the new order account (unused while the DLMM leg is suspended).
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
    /// CHECK: PDA with no data; signs the partner position claim and the staging transfers.
    #[account(seeds = [b"partner", class.dbc_config.as_ref()], bump = class.partner_auth_bump)]
    pub partner_auth: UncheckedAccount<'info>,
    /// CHECK: derived vault; a destination only.
    #[account(mut, seeds = [b"vault", launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: `partner_auth`'s base ATA (handler).
    #[account(mut)]
    pub staging_base: UncheckedAccount<'info>,
    /// CHECK: `partner_auth`'s WSOL ATA (handler).
    #[account(mut)]
    pub staging_quote: UncheckedAccount<'info>,
    /// CHECK: base mint; writable for a staging burn.
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
    /// CHECK: recorded creator position, read for L only (handler).
    pub creator_position: UncheckedAccount<'info>,
    /// CHECK: recorded NFT account (handler).
    pub partner_nft_account: UncheckedAccount<'info>,
    /// CHECK: must equal the pool's `token_a_vault` (handler).
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: must equal the pool's `token_b_vault` (handler).
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: must equal `global.treasury` (handler).
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
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
    /// CHECK: staging (handler); writable — burned to zero (§5).
    #[account(mut)]
    pub staging_base: UncheckedAccount<'info>,
    /// CHECK: base mint; writable for the staging burn.
    #[account(mut, address = launch.base_mint)]
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: the launch's DAMM pool (handler).
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: recorded partner position (handler).
    pub partner_position: UncheckedAccount<'info>,
    /// CHECK: recorded creator position (handler).
    pub creator_position: UncheckedAccount<'info>,
    pub depositor: Signer<'info>,
    /// CHECK: the depositor's WSOL account; mint and authority checked in the handler.
    #[account(mut)]
    pub depositor_quote: UncheckedAccount<'info>,
    /// CHECK: SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
}

// ------------------------------------------------------------------------------------------------
// Return data and events (§25)
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
    /// D-020: the resting bid is capped below F's bin.
    pub capped: bool,
    /// D-021: the DLMM leg is suspended; the vault rests unplaced.
    pub suspended: bool,
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
    /// The resting order (default while the DLMM leg is suspended).
    pub order: Pubkey,
}

#[event]
pub struct FloorRefreshed {
    pub launch: Pubkey,
    pub filled_tokens: u64,
    /// Base burned from staging: the fill plus anything sent there from outside.
    pub burned: u64,
    /// Quote the cancel returned to the vault: unfilled + DLMM fees.
    pub quote_returned: u64,
    pub s_new: u128,
    pub bin_id: i32,
    pub order: Pubkey,
}

#[event]
pub struct Redeemed {
    pub launch: Pubkey,
    pub holder: Pubkey,
    pub amount: u64,
    pub payout: u64,
    pub s_before: u128,
    pub s_after: u128,
    pub filled_tokens: u64,
    pub quote_returned: u64,
}

#[event]
pub struct Harvested {
    pub launch: Pubkey,
    pub to_vault: u64,
    pub to_treasury: u64,
    pub base_burned: u64,
    pub s_new: u128,
}

#[event]
pub struct Deposited {
    pub launch: Pubkey,
    pub from: Pubkey,
    pub amount: u64,
    pub s_new: u128,
}

/// D-020: the bid rests at the DLMM active bin, below F's bin, because a third-party order pins the
/// active bin. Still a bid at or below F.
#[event]
pub struct BidCapped {
    pub launch: Pubkey,
    pub bin: i32,
}

/// D-021: the active bin is pinned more than 70 bins under F's bin; the vault rests unplaced, V
/// still counts it and redemption stays live.
#[event]
pub struct BidSuspended {
    pub launch: Pubkey,
    pub active_bin: i32,
}

/// §8 fail-safe, one per position and per decrease.
#[event]
pub struct BackingDecreased {
    pub launch: Pubkey,
    pub position: Pubkey,
    pub l_recorded: u128,
    pub l_read: u128,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// §27 Proof vector: s = 47,755,047,807,748,143, F's bin at 10 bps = −11,920.
    const S: u128 = 47_755_047_807_748_143;
    const STEP: u16 = 10;
    const F_BIN: i32 = -11_920;
    const DEPTH: i32 = canon::MAX_CAP_DEPTH;

    fn at(bin: i32, capped: bool, move_up: bool) -> Placement {
        Placement::At {
            bin,
            capped,
            move_up,
        }
    }

    #[test]
    fn floor_bin_matches_section_27() {
        assert!(is_floor_bin(F_BIN, STEP, S));
        assert!(!is_floor_bin(F_BIN + 1, STEP, S));
        assert!(!is_floor_bin(F_BIN - 1, STEP, S));
    }

    /// Where DLMM has no price, the sign of the bin decides (D-021): never an error.
    #[test]
    fn undefined_prices_compare_by_sign() {
        assert!(dlmm::price_q64(-500_000, STEP).is_none());
        assert!(dlmm::price_q64(500_000, STEP).is_none());
        assert!(below(-500_000, STEP, S));
        assert!(!below(500_000, STEP, S));
        assert!(below(i32::MIN, STEP, S));
        assert!(!below(i32::MAX, STEP, S));
        assert!(!is_floor_bin(i32::MAX, STEP, S));
    }

    /// D-020 rules for `open` / `refresh_floor` hints, within the D-021 cap depth.
    #[test]
    fn hint_resolution() {
        // F's bin, active above it: place there, no move.
        assert_eq!(
            resolve_hint(F_BIN, F_BIN + 5, STEP, S).unwrap(),
            at(F_BIN, false, false)
        );
        // F's bin, active exactly there: no move (a bid at the active bin is accepted).
        assert_eq!(
            resolve_hint(F_BIN, F_BIN, STEP, S).unwrap(),
            at(F_BIN, false, false)
        );
        // F's bin, active far below it (the launch's p0 bin): move the active bin up first.
        assert_eq!(
            resolve_hint(F_BIN, -12_645, STEP, S).unwrap(),
            at(F_BIN, false, true)
        );
        // F's bin, active far below inside the bitmap extension range: still a move.
        assert_eq!(
            resolve_hint(F_BIN, -40_000, STEP, S).unwrap(),
            at(F_BIN, false, true)
        );
        // Capped: the hint is the active bin, within 70 bins under F's bin.
        assert_eq!(
            resolve_hint(F_BIN - 1, F_BIN - 1, STEP, S).unwrap(),
            at(F_BIN - 1, true, false)
        );
        assert_eq!(
            resolve_hint(F_BIN - DEPTH, F_BIN - DEPTH, STEP, S).unwrap(),
            at(F_BIN - DEPTH, true, false)
        );
        // Refused: below the active bin; a "cap" when the active bin is not below F's bin; above F.
        assert!(resolve_hint(-12_646, -12_645, STEP, S).is_err());
        assert!(resolve_hint(F_BIN - 1, F_BIN + 3, STEP, S).is_err());
        assert!(resolve_hint(F_BIN + 1, F_BIN + 1, STEP, S).is_err());
        assert!(resolve_hint(F_BIN + 1, -12_645, STEP, S).is_err());
        assert!(resolve_hint(500_000, 500_000, STEP, S).is_err());
    }

    /// D-021: a pin deeper than 70 bins — or where DLMM has no price — suspends; it never errors.
    #[test]
    fn deep_pins_suspend() {
        let deep = F_BIN - DEPTH - 1;
        assert_eq!(
            resolve_hint(deep, deep, STEP, S).unwrap(),
            Placement::Suspended
        );
        assert_eq!(
            resolve_hint(-12_645, -12_645, STEP, S).unwrap(),
            Placement::Suspended
        );
        assert_eq!(
            resolve_hint(-40_000, -40_000, STEP, S).unwrap(),
            Placement::Suspended
        );
        assert_eq!(
            resolve_hint(-500_000, -500_000, STEP, S).unwrap(),
            Placement::Suspended
        );
    }

    /// `redeem`: never moves the active bin; F's bin when allowed, else capped, else suspended —
    /// never an error, whatever the old bin or the active bin.
    #[test]
    fn redeem_placement_rules() {
        let p = |old, active| redeem_placement(old, active, STEP, S);
        assert_eq!(p(F_BIN, F_BIN), at(F_BIN, false, false));
        assert_eq!(p(F_BIN - 3, F_BIN + 40), at(F_BIN, false, false));
        // An earlier capped bid far down, active moved well above F's bin.
        assert_eq!(p(-12_645, -11_000), at(F_BIN, false, false));
        // Active within 70 below F's bin: capped there.
        assert_eq!(p(F_BIN - 10, F_BIN - 10), at(F_BIN - 10, true, false));
        // Active deeper than 70 below, or with no price: suspended.
        assert_eq!(p(-12_645, -12_645), Placement::Suspended);
        assert_eq!(p(F_BIN, -500_000), Placement::Suspended);
        // Old bin above F (only on a degraded launch) or meaningless: found from the active bin.
        assert_eq!(p(F_BIN + 200, F_BIN + 300), at(F_BIN, false, false));
        assert_eq!(p(0, F_BIN + 5), at(F_BIN, false, false));
        assert_eq!(p(i32::MIN, F_BIN + 5), at(F_BIN, false, false));
        // A griefer moved the active bin to the far top: still F's bin, no error.
        assert_eq!(p(F_BIN, 400_000), at(F_BIN, false, false));
        assert_eq!(p(-500_000, 500_000), at(F_BIN, false, false));
    }

    /// The search agrees with a linear scan over a span of floors (F's bin within ±200 of active).
    #[test]
    fn floor_bin_search_matches_scan() {
        for k in 0..60u32 {
            let s = S + (S / 97) * u128::from(k);
            let mut want = F_BIN - 50;
            while below(want + 1, STEP, s) {
                want += 1;
            }
            for active in [want, want + 1, want + 69, want + 200] {
                for old in [want - 5, want, active, F_BIN - 1_000] {
                    assert_eq!(floor_bin_up_to(old, active, STEP, s), want, "k={k}");
                }
            }
        }
    }

    /// §8 fail-safe: one record per position, lowered on every decrease, degrading the launch.
    #[test]
    fn backing_decrease_is_per_position() {
        let zeros = vec![0u8; Launch::INIT_SPACE];
        let mut l = Launch::deserialize(&mut zeros.as_slice()).unwrap();
        l.partner_l_recorded = 100;
        l.creator_l_recorded = 200;
        note_backing(Pubkey::default(), &mut l, (100, 200));
        assert!(!l.degraded);
        note_backing(Pubkey::default(), &mut l, (90, 200));
        assert!(l.degraded && l.partner_l_recorded == 90 && l.creator_l_recorded == 200);
        note_backing(Pubkey::default(), &mut l, (80, 150));
        assert!(l.partner_l_recorded == 80 && l.creator_l_recorded == 150);
        // A later read back above the record does not raise it (the minimum is kept).
        note_backing(Pubkey::default(), &mut l, (95, 150));
        assert_eq!(l.partner_l_recorded, 80);
    }
}
