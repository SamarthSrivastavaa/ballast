//! Ballast — a Meteora DBC launch class with an on-chain, executable buyback floor `F`.
//!
//! **Program Part 1 (§6):** `initialize_global`, `create_class`, `register_launch` (D-011),
//! `settle_graduation`, `burn_leftover`.
//!
//! The P0 gate (Q1–Q5) closed on 4 Oct 2026 against the mainnet Meteora binaries, which is what
//! permits any of this to exist (`CLAUDE.md` § P0 gate rule, `evidence/p0/REPORT.md`).
//!
//! Nothing here computes `F`: that is `ballast-floor`'s sole job (§4 rule 1).

#![allow(unexpected_cfgs)] // anchor's #[program] expands cfgs this crate does not declare
#![forbid(unsafe_code)]

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::solana_program::program::{invoke, invoke_signed};

pub mod curve;
pub mod dbc_cpi;
pub mod errors;
pub mod introspect;
pub mod spl;
pub mod state;

use errors::BallastError;
use state::{canon, launch_state, Class, ClassCanon, Global, Launch};

declare_id!("HSSv351Q1DftJ7mgEzKm9rt41WUTyWZJZLXUq7sfqerr");

/// DBC program ID (§12: CPI and owner program IDs are hard-coded, never taken on trust).
pub const DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

/// DLMM program ID (§12).
pub const DLMM_PROGRAM_ID: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
/// DLMM's seed prefix for customizable permissionless pairs (SDK `ILM_BASE`). Q8: the pair address
/// is `[ILM_BASE, min(mint), max(mint)]` under DLMM — it carries no bin step (D-014).
pub const DLMM_ILM_BASE: Pubkey = pubkey!("MFGQxwAmB91SwuYX36okv2Qmdc9aMuHTwWGUrp4AtB1");

/// SPL Token program, for validating the treasury without pulling in `anchor-spl`.
pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// SPL Associated Token Account program: staging accounts are `partner_auth`'s ATAs (§5), and DBC's
/// `withdraw_leftover` pays only the leftover receiver's ATA.
pub const ATA_PROGRAM_ID: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/// An SPL token account is exactly this long; mint at offset 0, owner at 32.
const SPL_TOKEN_ACCOUNT_LEN: usize = 165;

/// §7 canonical parameters per `size_tag`.
///
/// `sqrt_start_price` and `config_hash` are **compiler output** (`compiler/out/classes.json`,
/// `pnpm -F compiler emit`); `pnpm -F compiler test` fails if these literals drift from §7. The Proof
/// hash was also reproduced over the real config DBC stored on the mainnet binary in STEP 3 (Q12).
/// A size with a zero hash or start price would still fail closed with `ClassNotPinned`.
pub const CLASSES: &[ClassCanon] = &[
    ClassCanon {
        size_tag: 0,
        name: "proof",
        migration_quote_threshold: 10_000_000_000, // 10 SOL (§7)
        sqrt_start_price: 33241012347184484,
        config_hash: [
            100, 92, 202, 53, 29, 155, 61, 133, 109, 64, 124, 122, 127, 114, 184, 22, 32, 237, 37,
            120, 238, 212, 185, 240, 158, 10, 130, 70, 43, 247, 33, 146,
        ],
        predicted_s_open: 47_755_047_807_748_143, // §27 Proof vector
        bid_bin_step: 10,                         // §9, 10 bps; D-014 fixes it per class
        dust_limit: 1_000_000,                    // D-011(b): 0.001 SOL
    },
    ClassCanon {
        size_tag: 1,
        name: "public",
        migration_quote_threshold: 25_000_000_000, // 25 SOL (§7)
        sqrt_start_price: 52558655373441379,
        config_hash: [
            231, 147, 1, 47, 114, 185, 64, 21, 40, 24, 254, 116, 137, 56, 92, 57, 186, 107, 4, 104,
            162, 101, 113, 229, 175, 155, 75, 60, 61, 176, 234, 206,
        ],
        predicted_s_open: 75_507_360_421_341_854, // §27 Public vector
        bid_bin_step: 10,
        dust_limit: 1_000_000,
    },
];

fn class_canon(size_tag: u8) -> Result<&'static ClassCanon> {
    CLASSES
        .iter()
        .find(|c| c.size_tag == size_tag)
        .ok_or_else(|| error!(BallastError::UnknownSizeTag))
}

/// §7 rule 3's preimage and hash, extracted so a test can pin the exact byte layout.
///
/// `sha256(sqrt_start_price ‖ curve[0..20] ‖ migration_quote_threshold ‖ supply fields)`,
/// little-endian, in that order. The compiler and the verifier must reproduce these bytes exactly,
/// so `tests/hash_preimage.rs` fixes the layout with a committed vector.
pub fn config_hash_of(cfg: &meteora_types::dbc::PoolConfig) -> [u8; 32] {
    hash(&config_hash_preimage(cfg)).to_bytes()
}

/// The §7 rule-3 preimage bytes. 680 bytes: 16 + 20·32 + 8 + 8 + 8.
pub fn config_hash_preimage(cfg: &meteora_types::dbc::PoolConfig) -> Vec<u8> {
    let mut out = Vec::with_capacity(16 + 20 * 32 + 8 + 8 + 8);
    let start = cfg.sqrt_start_price;
    out.extend_from_slice(&start.to_le_bytes());
    for p in cfg.curve.iter() {
        let (sp, liq) = (p.sqrt_price, p.liquidity);
        out.extend_from_slice(&sp.to_le_bytes());
        out.extend_from_slice(&liq.to_le_bytes());
    }
    let threshold = cfg.migration_quote_threshold;
    let pre_supply = cfg.pre_migration_token_supply;
    let post_supply = cfg.post_migration_token_supply;
    out.extend_from_slice(&threshold.to_le_bytes());
    out.extend_from_slice(&pre_supply.to_le_bytes());
    out.extend_from_slice(&post_supply.to_le_bytes());
    out
}

/// `UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address }` as bincode lays it
/// out: variant `u32` = 3, `slot` u64, `Option` tag u8, then the 32-byte authority (45 bytes).
fn upgrade_authority(info: &AccountInfo) -> Result<Option<Pubkey>> {
    let d = info.try_borrow_data()?;
    require!(
        d.len() >= 45 && d[0..4] == 3u32.to_le_bytes(),
        BallastError::NotUpgradeAuthority
    );
    if d[12] != 1 {
        return Ok(None);
    }
    let key: [u8; 32] = d[13..45]
        .try_into()
        .map_err(|_| error!(BallastError::NotUpgradeAuthority))?;
    Ok(Some(Pubkey::new_from_array(key)))
}

/// The `VirtualPool` fields `settle_graduation` and `burn_leftover` act on.
struct PoolView {
    base_vault: Pubkey,
    quote_vault: Pubkey,
    quote_reserve: u64,
    migration_progress: u8,
    is_withdraw_leftover: u8,
    is_partner_withdraw_surplus: u8,
}

/// Decode the launch's DBC pool and re-check its cross-links (§5 rules 1–2): owner, discriminator,
/// `config == class.dbc_config`, `base_mint == launch.base_mint`, and the passed vaults are its own.
fn read_launch_pool(
    info: &AccountInfo,
    class: &Class,
    launch: &Launch,
    base_vault: &Pubkey,
    quote_vault: &Pubkey,
) -> Result<PoolView> {
    require_keys_eq!(
        *info.owner,
        DBC_PROGRAM_ID,
        BallastError::LaunchPoolWrongOwner
    );
    let data = info.try_borrow_data()?;
    let vp = meteora_types::decode::<meteora_types::dbc::VirtualPool>(
        &data,
        &meteora_types::dbc::VirtualPool::DISCRIMINATOR,
    )
    .ok_or_else(|| error!(BallastError::LaunchPoolWrongOwner))?;
    let s = &vp.pool_state;
    require_keys_eq!(
        Pubkey::new_from_array(s.config),
        class.dbc_config,
        BallastError::LaunchWrongConfig
    );
    require_keys_eq!(
        Pubkey::new_from_array(s.base_mint),
        launch.base_mint,
        BallastError::LaunchBaseMintMismatch
    );
    let view = PoolView {
        base_vault: Pubkey::new_from_array(s.base_vault),
        quote_vault: Pubkey::new_from_array(s.quote_vault),
        quote_reserve: s.quote_reserve,
        migration_progress: s.migration_progress,
        is_withdraw_leftover: s.is_withdraw_leftover,
        is_partner_withdraw_surplus: s.is_partner_withdraw_surplus,
    };
    require!(
        view.base_vault == *base_vault && view.quote_vault == *quote_vault,
        BallastError::PoolVaultMismatch
    );
    Ok(view)
}

/// Balance of a token account whose mint and authority must be exactly these (§5 rule 3).
/// Missing, foreign or malformed accounts are an error, never 0 (D-012).
fn token_balance(
    info: &AccountInfo,
    mint: &Pubkey,
    owner: &Pubkey,
    err: BallastError,
) -> Result<u64> {
    let (m, o, amount) = spl::read_token_account(info).ok_or_else(|| error!(err))?;
    if m != *mint || o != *owner {
        return Err(error!(err));
    }
    Ok(amount)
}

/// The SPL associated token account of `owner` for `mint`. `partner_auth`'s base ATA is the only
/// staging account and the only account DBC's `withdraw_leftover` can pay (so a third party
/// front-running it can only fill this one); the beneficiary is paid only at its WSOL ATA (D-016).
fn ata_of(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()],
        &ATA_PROGRAM_ID,
    )
    .0
}

/// The staging account's balance after checking it is `partner_auth`'s base ATA.
fn staging_balance(info: &AccountInfo, partner_auth: &Pubkey, base_mint: &Pubkey) -> Result<u64> {
    require_keys_eq!(
        info.key(),
        ata_of(partner_auth, base_mint),
        BallastError::StagingNotPartnerAta
    );
    token_balance(
        info,
        base_mint,
        partner_auth,
        BallastError::StagingNotPartnerAta,
    )
}

#[program]
pub mod ballast {
    use super::*;

    /// §6 `initialize_global(admin)`; the treasury is passed as an account, not an argument.
    ///
    /// The signer must be the program's **upgrade authority**. Without that constraint the
    /// instruction is open between §19 runbook step 1 (deploy from a buffer) and step 3 (this
    /// call), and whoever calls it first takes `global.admin` and `global.treasury` permanently —
    /// there is no admin setter and `init` makes the legitimate call fail. That would falsify
    /// §19's "exactly two authorities exist, both a 2-of-3 multisig".
    pub fn initialize_global(ctx: Context<InitializeGlobal>, admin: Pubkey) -> Result<()> {
        require!(
            upgrade_authority(&ctx.accounts.program_data)? == Some(ctx.accounts.deployer.key()),
            BallastError::NotUpgradeAuthority
        );
        // §5 rule 3: a token account's mint and authority are checked, never assumed. The treasury
        // receives 10% of harvested partner LP fees (§6 `harvest`), so it must really be a WSOL
        // token account — and it must be checked here, because nothing downstream can recover it.
        let t = ctx.accounts.treasury.to_account_info();
        require_keys_eq!(
            *t.owner,
            TOKEN_PROGRAM_ID,
            BallastError::TreasuryNotTokenAccount
        );
        let treasury_key = t.key();
        {
            let tdata = t.try_borrow_data()?;
            require!(
                tdata.len() == SPL_TOKEN_ACCOUNT_LEN,
                BallastError::TreasuryNotTokenAccount
            );
            let mint_bytes: [u8; 32] = tdata[0..32]
                .try_into()
                .map_err(|_| error!(BallastError::TreasuryNotTokenAccount))?;
            require_keys_eq!(
                Pubkey::new_from_array(mint_bytes),
                canon::QUOTE_MINT,
                BallastError::TreasuryWrongMint
            );
        }

        let g = &mut ctx.accounts.global;
        g.admin = admin;
        g.treasury = treasury_key;
        g.class_creation_enabled = true;
        g.version = 1;
        g.bump = ctx.bumps.global;
        g.reserved = [0u8; 64];

        emit!(GlobalInitialized {
            admin,
            treasury: treasury_key
        });
        Ok(())
    }

    /// §6 `create_class(size_tag)`. Admin signs and pays. Validates the DBC `PoolConfig` field by
    /// field against §7, each rule with its own error code, then records the class immutably.
    pub fn create_class(ctx: Context<CreateClass>, size_tag: u8) -> Result<()> {
        require!(
            ctx.accounts.global.class_creation_enabled,
            BallastError::ClassCreationDisabled
        );
        let spec = class_canon(size_tag)?;
        // Fail closed until the compiler pins this size. A distinct code from a config mismatch, so
        // "not pinned yet" and "this config is wrong" cannot be confused.
        require!(
            spec.config_hash != [0u8; 32] && spec.sqrt_start_price != 0,
            BallastError::ClassNotPinned
        );

        // ---- §7 rule 1: the account really is a DBC PoolConfig of the validated version ----
        let cfg_info = &ctx.accounts.dbc_config;
        require_keys_eq!(
            *cfg_info.owner,
            DBC_PROGRAM_ID,
            BallastError::ConfigWrongOwner
        );
        let data = cfg_info.try_borrow_data()?;
        require!(data.len() >= 8, BallastError::ConfigTooSmall);
        require!(
            data[..8] == meteora_types::dbc::PoolConfig::DISCRIMINATOR,
            BallastError::ConfigWrongDiscriminator
        );
        let cfg = meteora_types::decode::<meteora_types::dbc::PoolConfig>(
            &data,
            &meteora_types::dbc::PoolConfig::DISCRIMINATOR,
        )
        .ok_or_else(|| error!(BallastError::ConfigWrongSize))?;
        require!(
            cfg.version == canon::POOL_CONFIG_VERSION,
            BallastError::ConfigWrongVersion
        );

        // ---- §7 rule 2: every scalar row, one error code each ----
        //
        // Fields are copied into locals where they feed arithmetic. `PoolConfig` is
        // `#[repr(C, packed)]`; every nested type is packed too, so references to them are aligned.
        let partner_auth =
            Pubkey::find_program_address(&[b"partner", cfg_info.key().as_ref()], &crate::ID);

        // The quote mint is compared against the HARD-CODED constant, not against the config's own
        // field. Comparing `cfg.quote_mint` to a caller-supplied account is a tautology any caller
        // passes trivially, which would let a class be pinned to an arbitrary quote mint and
        // propagate it into `Class.quote_mint` for every later instruction to trust.
        require_keys_eq!(
            Pubkey::new_from_array(cfg.quote_mint),
            canon::QUOTE_MINT,
            BallastError::ConfigQuoteMint
        );
        // The Token-2022 half of the same §7 row (Q20: SPL WSOL everywhere).
        require!(
            cfg.quote_token_flag == canon::QUOTE_TOKEN_FLAG_SPL,
            BallastError::ConfigQuoteTokenFlag
        );
        require_keys_eq!(
            Pubkey::new_from_array(cfg.fee_claimer),
            partner_auth.0,
            BallastError::ConfigFeeClaimer
        );
        require_keys_eq!(
            Pubkey::new_from_array(cfg.leftover_receiver),
            partner_auth.0,
            BallastError::ConfigLeftoverReceiver
        );
        require!(
            cfg.token_type == canon::TOKEN_TYPE,
            BallastError::ConfigTokenType
        );
        require!(
            cfg.token_decimal == canon::TOKEN_DECIMAL,
            BallastError::ConfigTokenDecimal
        );
        require!(
            cfg.fixed_token_supply_flag == canon::FIXED_TOKEN_SUPPLY_FLAG,
            BallastError::ConfigFixedSupplyFlag
        );
        let pre_supply = cfg.pre_migration_token_supply;
        require!(
            pre_supply == canon::PRE_MIGRATION_TOKEN_SUPPLY,
            BallastError::ConfigPreMigrationSupply
        );
        require!(
            cfg.token_update_authority == canon::TOKEN_UPDATE_AUTHORITY_IMMUTABLE,
            BallastError::ConfigTokenUpdateAuthority
        );
        require!(
            cfg.collect_fee_mode == canon::COLLECT_FEE_MODE_QUOTE,
            BallastError::ConfigCollectFeeMode
        );
        require!(
            cfg.migration_option == canon::MIGRATION_OPTION_DAMM_V2,
            BallastError::ConfigMigrationOption
        );
        // §7 "Migrated pool: Customizable option". DBC only honours the migrated_* fields below
        // under this option, so without it the next four checks are silently void.
        require!(
            cfg.migration_fee_option == canon::MIGRATION_FEE_OPTION_CUSTOMIZABLE,
            BallastError::ConfigMigrationFeeOption
        );
        // D-010: the DBC-side value, not DAMM's.
        require!(
            cfg.migrated_collect_fee_mode == canon::MIGRATED_COLLECT_FEE_MODE,
            BallastError::ConfigMigratedCollectFeeMode
        );
        require!(
            cfg.migrated_dynamic_fee == canon::MIGRATED_DYNAMIC_FEE,
            BallastError::ConfigMigratedDynamicFee
        );
        let fee_bps = cfg.migrated_pool_fee_bps;
        require!(
            fee_bps == canon::MIGRATED_POOL_FEE_BPS,
            BallastError::ConfigMigratedPoolFeeBps
        );
        // A market-cap fee scheduler reinterprets the migrated pool's base fee, and §31 forbids
        // market-cap-fee pools outright.
        require!(
            cfg.migrated_pool_base_fee_mode == canon::MIGRATED_POOL_BASE_FEE_MODE_FLAT
                && cfg.migrated_pool_base_fee_bytes == [0u8; 16],
            BallastError::ConfigMigratedBaseFeeMode
        );
        let comp_bps = cfg.migrated_compounding_fee_bps;
        require!(
            comp_bps == canon::MIGRATED_COMPOUNDING_FEE_BPS,
            BallastError::ConfigMigratedCompounding
        );
        require!(
            cfg.creator_trading_fee_percentage == canon::CREATOR_TRADING_FEE_PERCENTAGE,
            BallastError::ConfigCreatorTradingFee
        );
        require!(
            cfg.migration_fee_percentage == canon::MIGRATION_FEE_PERCENTAGE,
            BallastError::ConfigMigrationFeePercentage
        );
        require!(
            cfg.creator_migration_fee_percentage == canon::CREATOR_MIGRATION_FEE_PERCENTAGE,
            BallastError::ConfigCreatorMigrationFeePercentage
        );
        require!(
            cfg.partner_permanent_locked_liquidity_percentage
                == canon::PARTNER_PERMANENT_LP_PERCENTAGE,
            BallastError::ConfigPartnerPermanentLp
        );
        require!(
            cfg.creator_permanent_locked_liquidity_percentage
                == canon::CREATOR_PERMANENT_LP_PERCENTAGE,
            BallastError::ConfigCreatorPermanentLp
        );
        require!(
            cfg.partner_liquidity_percentage == canon::PARTNER_LP_PERCENTAGE,
            BallastError::ConfigPartnerLp
        );
        require!(
            cfg.creator_liquidity_percentage == canon::CREATOR_LP_PERCENTAGE,
            BallastError::ConfigCreatorLp
        );
        require!(
            cfg.partner_liquidity_vesting_info.is_initialized == 0
                && cfg.creator_liquidity_vesting_info.is_initialized == 0,
            BallastError::ConfigLpVesting
        );
        let lv = &cfg.locked_vesting_config;
        let (amt, cliff_amt, periods, freq, cliff_dur) = (
            lv.amount_per_period,
            lv.cliff_unlock_amount,
            lv.number_of_period,
            lv.frequency,
            lv.cliff_duration_from_migration_time,
        );
        require!(
            amt == 0 && cliff_amt == 0 && periods == 0 && freq == 0 && cliff_dur == 0,
            BallastError::ConfigLockedVesting
        );
        require!(
            cfg.enable_first_swap_with_min_fee == canon::ENABLE_FIRST_SWAP_WITH_MIN_FEE,
            BallastError::ConfigFirstSwapMinFee
        );
        // §7 "Base fee: cliff numerator 10,000,000 (1% of 1e9), 0 periods" — flat 1%.
        // `base_fee_mode` and factors 2/3 must be pinned too: under the rate-limiter mode those
        // same bytes mean reference_amount / max_limiter_duration / fee_increment_bps, so the cliff
        // numerator alone does not establish the known worst-case exit fee §9/§13 assume.
        let base = &cfg.pool_fees.base_fee;
        let (cliff_num, first_factor, second_factor, third_factor, fee_mode) = (
            base.cliff_fee_numerator,
            base.first_factor,
            base.second_factor,
            base.third_factor,
            base.base_fee_mode,
        );
        require!(
            cliff_num == canon::BASE_FEE_CLIFF_NUMERATOR
                && first_factor == 0
                && second_factor == 0
                && third_factor == 0
                && fee_mode == canon::BASE_FEE_MODE_FLAT,
            BallastError::ConfigBaseFee
        );
        require!(
            cfg.pool_fees.dynamic_fee.initialized == 0,
            BallastError::ConfigDynamicFee
        );
        let threshold = cfg.migration_quote_threshold;
        require!(
            threshold == spec.migration_quote_threshold,
            BallastError::ConfigThreshold
        );
        let start = cfg.sqrt_start_price;
        require!(
            start == spec.sqrt_start_price,
            BallastError::ConfigStartPrice
        );

        // ---- §7 rule 4 (derived) ----
        //
        // Structure first: exactly three leading non-zero points, strictly ascending, zero tail.
        // Filtering on `liquidity != 0` alone would admit non-zero prices in `curve[3..20]`, and
        // taking the last point as a `max()` would not notice a descending curve.
        let mut pts = [(0u128, 0u128); canon::CURVE_POINTS];
        for (i, slot) in pts.iter_mut().enumerate() {
            let p = &cfg.curve[i];
            *slot = (p.sqrt_price, p.liquidity);
        }
        require!(
            pts.iter().all(|&(sp, l)| sp != 0 && l != 0),
            BallastError::ConfigCurvePointCount
        );
        require!(
            cfg.curve[canon::CURVE_POINTS..]
                .iter()
                .all(|p| p.sqrt_price == 0 && p.liquidity == 0),
            BallastError::ConfigCurveTailNotZero
        );
        let mut prev = start;
        for &(sp, _) in pts.iter() {
            require!(sp > prev, BallastError::ConfigCurveNotAscending);
            prev = sp;
        }
        let last_point = pts[canon::CURVE_POINTS - 1].0;

        // §7 rule 4 says `migration_sqrt_price` EQUALS the last curve point. On the mainnet
        // binaries it does not: segment liquidity must round up so the curve can absorb the whole
        // threshold, leaving DBC's derived price slightly BELOW the last point (measured 4,580,459
        // low, relative 5e-11 — evidence/p0/REPORT.md finding 1).
        //
        // The band is therefore two-sided and bounded. A one-sided `<=` would free
        // `migration_sqrt_price` entirely, and because that field is NOT in the rule-3 hash, two
        // materially different configs would hash identically and `predicted_s_open` would no
        // longer provably belong to the validated config.
        //
        // This is a §7 amendment and is PENDING THE OWNER'S APPROVAL (DECISIONS.md § OPEN DECISION
        // rule-4). It cannot be exercised yet: every class is `ClassNotPinned` until the compiler
        // emits the constants.
        let migration_sqrt_price = cfg.migration_sqrt_price;
        let lower = last_point.saturating_sub(canon::MIGRATION_PRICE_TOLERANCE);
        require!(
            (lower..=last_point).contains(&migration_sqrt_price),
            BallastError::ConfigMigrationPriceOutOfBand
        );

        // The other half of the §7 rule-4 proposal: the curve must actually absorb the threshold.
        let cap = curve::capacity(start, &pts).ok_or_else(|| error!(BallastError::Overflow))?;
        require!(
            cap >= threshold as u128,
            BallastError::ConfigCurveCapacityTooSmall
        );

        let lp_sum = (cfg.partner_permanent_locked_liquidity_percentage as u16)
            .checked_add(cfg.creator_permanent_locked_liquidity_percentage as u16)
            .and_then(|s| s.checked_add(cfg.partner_liquidity_percentage as u16))
            .and_then(|s| s.checked_add(cfg.creator_liquidity_percentage as u16))
            .ok_or_else(|| error!(BallastError::Overflow))?;
        require!(lp_sum == 100, BallastError::ConfigLpPercentagesSum);

        // ---- §7 rule 3: the canonical hash ----
        let config_hash = config_hash_of(cfg);
        require!(
            config_hash == spec.config_hash,
            BallastError::ConfigHashMismatch
        );

        // ---- §7 rule 5 (D-014): the bin step is a class property ----
        require!(
            canon::DLMM_BIN_STEPS.contains(&spec.bid_bin_step),
            BallastError::ConfigBinStep
        );

        require!(spec.predicted_s_open != 0, BallastError::BadPrediction);

        let config_key = cfg_info.key();
        let partner_bump = partner_auth.1;
        drop(data);

        let c = &mut ctx.accounts.class;
        c.dbc_config = config_key;
        c.quote_mint = canon::QUOTE_MINT;
        c.config_hash = config_hash;
        c.size_tag = size_tag;
        c.partner_auth_bump = partner_bump;
        c.migration_threshold = threshold;
        c.predicted_s_open = spec.predicted_s_open;
        c.bid_bin_step = spec.bid_bin_step;
        c.redeem_fee_bps = canon::REDEEM_FEE_BPS;
        c.harvest_treasury_bps = canon::HARVEST_TREASURY_BPS;
        c.vault_cap = threshold;
        c.dust_limit = spec.dust_limit;
        c.launches = 0;
        c.bump = ctx.bumps.class;
        c.reserved = [0u8; 64];

        emit!(ClassCreated {
            config: config_key,
            size_tag,
            config_hash,
            predicted_s_open: spec.predicted_s_open,
            bid_bin_step: spec.bid_bin_step,
        });
        Ok(())
    }

    /// §6 `register_launch(creator_beneficiary)`, as amended by D-011: the last instruction of the
    /// single launch transaction. Verifies the transaction by introspection and DBC/DLMM state,
    /// records the prediction, and creates the vault. No funds move.
    pub fn register_launch(
        ctx: Context<RegisterLaunch>,
        creator_beneficiary: Pubkey,
    ) -> Result<()> {
        let class = &ctx.accounts.class;
        let base_mint = ctx.accounts.base_mint.key();
        let creator_auth = ctx.accounts.creator_auth.key();
        // D-016: creator income goes to an outside account. A Ballast PDA as beneficiary would let
        // a caller route creator fees into a vault or the class-wide partner_auth accounts.
        require!(
            creator_beneficiary != ctx.accounts.partner_auth.key()
                && creator_beneficiary != creator_auth
                && creator_beneficiary != ctx.accounts.launch.key()
                && creator_beneficiary != ctx.accounts.vault.key(),
            BallastError::BeneficiaryIsBallastPda
        );

        // ---- the DBC pool (§5 rules 1–2) ----
        let pool_info = &ctx.accounts.virtual_pool;
        require_keys_eq!(
            *pool_info.owner,
            DBC_PROGRAM_ID,
            BallastError::LaunchPoolWrongOwner
        );
        let (cfg, pool_base, pool_creator, quote_reserve) = {
            let data = pool_info.try_borrow_data()?;
            let vp = meteora_types::decode::<meteora_types::dbc::VirtualPool>(
                &data,
                &meteora_types::dbc::VirtualPool::DISCRIMINATOR,
            )
            .ok_or_else(|| error!(BallastError::LaunchPoolWrongOwner))?;
            let s = &vp.pool_state;
            (
                Pubkey::new_from_array(s.config),
                Pubkey::new_from_array(s.base_mint),
                Pubkey::new_from_array(s.creator),
                s.quote_reserve,
            )
        };
        require_keys_eq!(cfg, class.dbc_config, BallastError::LaunchWrongConfig);
        require_keys_eq!(pool_base, base_mint, BallastError::LaunchBaseMintMismatch);
        // D-011(c): the creator role moved to creator_auth earlier in this transaction.
        require_keys_eq!(
            pool_creator,
            creator_auth,
            BallastError::LaunchCreatorNotTransferred
        );
        // State-level guard against any buy introspection cannot see (e.g. inside another
        // program's CPI): after the payer's dust buy, the quote reserve is at most the dust limit.
        require!(
            quote_reserve <= class.dust_limit,
            BallastError::LaunchPoolAlreadyTraded
        );
        require_keys_eq!(
            *ctx.accounts.base_mint.owner,
            TOKEN_PROGRAM_ID,
            BallastError::LaunchBaseMintNotSpl
        );

        // ---- the DLMM pair (§9, D-014), created earlier in this transaction ----
        let pair_info = &ctx.accounts.dlmm_pair;
        require_keys_eq!(
            *pair_info.owner,
            DLMM_PROGRAM_ID,
            BallastError::LaunchPairWrongOwner
        );
        let (lo, hi) = if base_mint < canon::QUOTE_MINT {
            (base_mint, canon::QUOTE_MINT)
        } else {
            (canon::QUOTE_MINT, base_mint)
        };
        let (expected_pair, _) = Pubkey::find_program_address(
            &[DLMM_ILM_BASE.as_ref(), lo.as_ref(), hi.as_ref()],
            &DLMM_PROGRAM_ID,
        );
        require_keys_eq!(
            pair_info.key(),
            expected_pair,
            BallastError::LaunchPairWrongAddress
        );
        {
            let data = pair_info.try_borrow_data()?;
            let lb = meteora_types::decode::<meteora_types::dlmm::LbPair>(
                &data,
                &meteora_types::dlmm::LbPair::DISCRIMINATOR,
            )
            .ok_or_else(|| error!(BallastError::LaunchPairWrongOwner))?;
            require!(
                Pubkey::new_from_array(lb.token_x_mint) == base_mint
                    && Pubkey::new_from_array(lb.token_y_mint) == canon::QUOTE_MINT,
                BallastError::LaunchPairWrongMints
            );
            let bin_step = lb.bin_step;
            require!(
                bin_step == class.bid_bin_step,
                BallastError::LaunchPairWrongBinStep
            );
            let p = &lb.parameters;
            require!(
                lb.pair_type == canon::DLMM_PAIR_TYPE_CUSTOMIZABLE
                    && p.function_type == canon::DLMM_FUNCTION_TYPE_LIMIT_ORDER,
                BallastError::LaunchPairWrongType
            );
            require!(
                p.collect_fee_mode == canon::DLMM_COLLECT_FEE_MODE_ONLY_Y,
                BallastError::LaunchPairWrongFeeMode
            );
            let base_factor = p.base_factor;
            require!(
                p.base_fee_power_factor == 0
                    && (base_factor as u32).checked_mul(bin_step as u32)
                        == Some(canon::DLMM_BASE_FEE_BPS_X10K),
                BallastError::LaunchPairWrongBaseFee
            );
            require!(
                lb.creator_pool_on_off_control == 0,
                BallastError::LaunchPairCreatorControl
            );
            require!(
                lb.status == canon::DLMM_PAIR_STATUS_ENABLED,
                BallastError::LaunchPairDisabled
            );
        }

        // ---- D-011(a)(b): the transaction itself ----
        introspect::verify_launch_tx(
            &ctx.accounts.instructions,
            &introspect::Expect {
                config: class.dbc_config,
                pool: pool_info.key(),
                base_mint,
                creator: ctx.accounts.creator.key(),
                creator_auth,
                payer: ctx.accounts.payer.key(),
                dlmm_pair: expected_pair,
                dust_limit: class.dust_limit,
            },
        )?;

        // ---- the vault: a WSOL token account at ["vault", launch], authority partner_auth ----
        let launch_key = ctx.accounts.launch.key();
        let vault_bump = ctx.bumps.vault;
        spl::create_pda_token_account(
            &ctx.accounts.payer.to_account_info(),
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.quote_mint.to_account_info(),
            &ctx.accounts.partner_auth.key(),
            &[b"vault", launch_key.as_ref(), &[vault_bump]],
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
        )?;

        // ---- record the prediction ----
        let slot = Clock::get()?.slot;
        let predicted_s = class.predicted_s_open;
        let class_key = class.key();
        let l = &mut ctx.accounts.launch;
        l.class = class_key;
        l.dbc_pool = pool_info.key();
        l.base_mint = base_mint;
        l.creator_beneficiary = creator_beneficiary;
        l.state = launch_state::REGISTERED;
        l.bump = ctx.bumps.launch;
        l.creator_auth_bump = ctx.bumps.creator_auth;
        l.vault_bump = vault_bump;
        l.predicted_s = predicted_s;
        l.registered_slot = slot;
        l.dlmm_pair = expected_pair;

        let c = &mut ctx.accounts.class;
        c.launches = c
            .launches
            .checked_add(1)
            .ok_or_else(|| error!(BallastError::Overflow))?;

        emit!(LaunchRegistered {
            launch: launch_key,
            base_mint,
            predicted_s,
            slot,
            dlmm_pair: expected_pair,
            creator_beneficiary,
        });
        Ok(())
    }

    /// §6 `settle_graduation()`: once the curve is complete, move the partner migration fee and the
    /// partner trading fees into the vault and the creator trading fees to the beneficiary, each
    /// measured as a balance delta. Valid before or after migration (§5 keeper lag).
    pub fn settle_graduation(ctx: Context<SettleGraduation>) -> Result<()> {
        let a = &ctx.accounts;
        require!(
            a.launch.state == launch_state::REGISTERED,
            BallastError::LaunchWrongState
        );
        let pv = read_launch_pool(
            &a.virtual_pool,
            &a.class,
            &a.launch,
            a.base_vault.key,
            a.quote_vault.key,
        )?;
        require!(
            pv.quote_reserve >= a.class.migration_threshold,
            BallastError::CurveNotComplete
        );
        let partner = a.partner_auth.key();
        let base_mint = a.launch.base_mint;
        let vault = a.vault.key();
        let st0 = staging_balance(&a.staging_base, &partner, &base_mint)?;
        let beneficiary = a.launch.creator_beneficiary;
        require_keys_eq!(
            a.beneficiary_quote.key(),
            ata_of(&beneficiary, &canon::QUOTE_MINT),
            BallastError::BeneficiaryAccountInvalid
        );
        let ben_bal = || {
            token_balance(
                &a.beneficiary_quote,
                &canon::QUOTE_MINT,
                &beneficiary,
                BallastError::BeneficiaryAccountInvalid,
            )
        };
        ben_bal()?;
        let sub = |x: u64, y: u64| {
            x.checked_sub(y)
                .ok_or_else(|| error!(BallastError::Overflow))
        };
        let vault_bal = || {
            token_balance(
                &a.vault,
                &canon::QUOTE_MINT,
                &partner,
                BallastError::VaultInvalid,
            )
        };
        let v0 = vault_bal()?;

        let pool = dbc_cpi::Pool {
            config: a.class.dbc_config,
            pool: a.virtual_pool.key(),
            base_vault: pv.base_vault,
            quote_vault: pv.quote_vault,
            base_mint,
            quote_mint: canon::QUOTE_MINT,
        };
        let infos = [
            a.dbc_pool_authority.to_account_info(),
            a.dbc_config.to_account_info(),
            a.virtual_pool.to_account_info(),
            a.vault.to_account_info(),
            a.staging_base.to_account_info(),
            a.beneficiary_quote.to_account_info(),
            a.base_vault.to_account_info(),
            a.quote_vault.to_account_info(),
            a.base_mint.to_account_info(),
            a.quote_mint.to_account_info(),
            a.partner_auth.to_account_info(),
            a.creator_auth.to_account_info(),
            a.token_program.to_account_info(),
            a.dbc_event_authority.to_account_info(),
            a.dbc_program.to_account_info(),
        ];
        let partner_seeds: &[&[u8]] = &[
            b"partner",
            pool.config.as_ref(),
            &[a.class.partner_auth_bump],
        ];
        let launch_key = a.launch.key();
        let creator_seeds: &[&[u8]] = &[
            b"creator",
            launch_key.as_ref(),
            &[a.launch.creator_auth_bump],
        ];

        invoke_signed(
            &dbc_cpi::withdraw_migration_fee(
                &pool,
                &vault,
                &partner,
                dbc_cpi::MIGRATION_FEE_FLAG_PARTNER,
            ),
            &infos,
            &[partner_seeds],
        )?;
        let v1 = vault_bal()?;
        invoke_signed(
            &dbc_cpi::claim_trading_fee(&pool, a.staging_base.key, &vault, &partner),
            &infos,
            &[partner_seeds],
        )?;
        let v2 = vault_bal()?;
        let st1 = staging_balance(&a.staging_base, &partner, &base_mint)?;
        // Read after the partner claims, so the delta is the creator claim alone.
        let ben0 = ben_bal()?;
        invoke_signed(
            &dbc_cpi::claim_creator_trading_fee(
                &pool,
                a.staging_base.key,
                a.beneficiary_quote.key,
                a.creator_auth.key,
            ),
            &infos,
            &[creator_seeds],
        )?;
        let ben1 = ben_bal()?;
        // §7 rule 2 pins DBC collect_fee_mode = QuoteToken, so no base fee accrues to anyone.
        // A creator base fee would belong to the beneficiary: fail closed rather than burn it.
        require!(
            staging_balance(&a.staging_base, &partner, &base_mint)? == st1,
            BallastError::CreatorBaseFee
        );
        // Partner base fees from this instruction's own claim are burned (S falls, so F can only
        // rise). Only this delta: a leftover a third party already withdrew into staging stays
        // there for `burn_leftover` to burn and record (D-016).
        let stray = sub(st1, st0)?;
        if stray > 0 {
            invoke_signed(
                &spl::burn(a.staging_base.key, &base_mint, &partner, stray),
                &infos,
                &[partner_seeds],
            )?;
        }

        let migration_fee = sub(v1, v0)?;
        let partner_fees = sub(v2, v1)?;
        let creator_fees = sub(ben1, ben0)?;
        let l = &mut ctx.accounts.launch;
        l.migration_fee = migration_fee;
        l.partner_fees = partner_fees;
        l.creator_forwarded = l
            .creator_forwarded
            .checked_add(creator_fees)
            .ok_or_else(|| error!(BallastError::Overflow))?;
        l.burned = l
            .burned
            .checked_add(stray)
            .ok_or_else(|| error!(BallastError::Overflow))?;
        l.state = launch_state::FUNDED;
        emit!(GraduationSettled {
            launch: launch_key,
            migration_fee,
            partner_fees,
            creator_fees,
            base_burned: stray,
        });
        Ok(())
    }

    /// §6 `burn_leftover()`: after migration, withdraw DBC's leftover base into `partner_auth`'s ATA
    /// (skipped if a third party already did — DBC can only pay that ATA), pull the partner surplus
    /// into the vault, and burn everything in the ATA. The `Migrated` observation and the move to
    /// `Cleaned` happen here together (§5).
    pub fn burn_leftover(ctx: Context<BurnLeftover>) -> Result<()> {
        let a = &ctx.accounts;
        require!(
            a.launch.state == launch_state::FUNDED,
            BallastError::LaunchWrongState
        );
        let pv = read_launch_pool(
            &a.virtual_pool,
            &a.class,
            &a.launch,
            a.base_vault.key,
            a.quote_vault.key,
        )?;
        require!(
            pv.migration_progress == canon::DBC_MIGRATION_PROGRESS_CREATED_POOL,
            BallastError::PoolNotMigrated
        );
        let partner = a.partner_auth.key();
        let base_mint = a.launch.base_mint;
        let vault = a.vault.key();
        staging_balance(&a.staging_base, &partner, &base_mint)?;
        let vault_bal = || {
            token_balance(
                &a.vault,
                &canon::QUOTE_MINT,
                &partner,
                BallastError::VaultInvalid,
            )
        };
        let v0 = vault_bal()?;

        let pool = dbc_cpi::Pool {
            config: a.class.dbc_config,
            pool: a.virtual_pool.key(),
            base_vault: pv.base_vault,
            quote_vault: pv.quote_vault,
            base_mint,
            quote_mint: canon::QUOTE_MINT,
        };
        let infos = [
            a.dbc_pool_authority.to_account_info(),
            a.dbc_config.to_account_info(),
            a.virtual_pool.to_account_info(),
            a.vault.to_account_info(),
            a.staging_base.to_account_info(),
            a.base_vault.to_account_info(),
            a.quote_vault.to_account_info(),
            a.base_mint.to_account_info(),
            a.quote_mint.to_account_info(),
            a.partner_auth.to_account_info(),
            a.token_program.to_account_info(),
            a.dbc_event_authority.to_account_info(),
            a.dbc_program.to_account_info(),
        ];
        let partner_seeds: &[&[u8]] = &[
            b"partner",
            pool.config.as_ref(),
            &[a.class.partner_auth_bump],
        ];

        if pv.is_withdraw_leftover == 0 {
            invoke(
                &dbc_cpi::withdraw_leftover(&pool, a.staging_base.key, &partner),
                &infos,
            )?;
        }
        if pv.is_partner_withdraw_surplus == 0 {
            invoke_signed(
                &dbc_cpi::partner_withdraw_surplus(&pool, &vault, &partner),
                &infos,
                &[partner_seeds],
            )?;
        }
        let v1 = vault_bal()?;
        let amount = staging_balance(&a.staging_base, &partner, &base_mint)?;
        if amount > 0 {
            invoke_signed(
                &spl::burn(a.staging_base.key, &base_mint, &partner, amount),
                &infos,
                &[partner_seeds],
            )?;
        }

        let surplus = v1
            .checked_sub(v0)
            .ok_or_else(|| error!(BallastError::Overflow))?;
        let launch_key = a.launch.key();
        let l = &mut ctx.accounts.launch;
        l.leftover_burned = amount;
        l.surplus = surplus;
        l.burned = l
            .burned
            .checked_add(amount)
            .ok_or_else(|| error!(BallastError::Overflow))?;
        l.state = launch_state::CLEANED;
        emit!(LeftoverBurned {
            launch: launch_key,
            amount,
            surplus,
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeGlobal<'info> {
    #[account(
        init,
        payer = deployer,
        space = 8 + Global::INIT_SPACE,
        seeds = [b"global"],
        bump,
    )]
    pub global: Account<'info, Global>,
    /// Must be the program's upgrade authority — otherwise this instruction is open between
    /// deployment and §19 runbook step 3, and admin/treasury are permanently takeable.
    #[account(mut)]
    pub deployer: Signer<'info>,
    /// CHECK: loader-owned, at the program's canonical ProgramData PDA; the upgrade authority is
    /// parsed in the handler. Anchor's `Account<ProgramData>` decodes with bincode/serde, which
    /// pulls serde and float formatting into the binary (D-009 size budget).
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = bpf_loader_upgradeable::ID,
        owner = bpf_loader_upgradeable::ID,
    )]
    pub program_data: UncheckedAccount<'info>,
    /// CHECK: validated inside the instruction as an SPL token account whose mint is WSOL (§5 r3).
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(size_tag: u8)]
pub struct CreateClass<'info> {
    #[account(seeds = [b"global"], bump = global.bump)]
    pub global: Account<'info, Global>,
    /// §19: only the multisig admin creates classes. §6 lists the admin as the sole signer, so the
    /// admin also pays — no extra payer signer is introduced.
    #[account(mut, address = global.admin @ BallastError::NotAdmin)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Class::INIT_SPACE,
        seeds = [b"class", dbc_config.key().as_ref()],
        bump,
    )]
    pub class: Account<'info, Class>,
    /// CHECK: validated field by field against §7 inside the instruction — owner, discriminator,
    /// size and version are all checked there, with a distinct error code each.
    pub dbc_config: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterLaunch<'info> {
    #[account(mut, seeds = [b"class", class.dbc_config.as_ref()], bump = class.bump)]
    pub class: Account<'info, Class>,
    #[account(
        init,
        payer = payer,
        space = 8 + Launch::INIT_SPACE,
        seeds = [b"launch", base_mint.key().as_ref()],
        bump,
    )]
    pub launch: Account<'info, Launch>,
    /// CHECK: DBC VirtualPool — owner, discriminator and cross-links validated in the handler.
    pub virtual_pool: UncheckedAccount<'info>,
    /// CHECK: cross-checked against the pool and the DLMM pair; owner must be SPL Token.
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: PDA with no data; the DBC pool creator after `transfer_pool_creator`.
    #[account(seeds = [b"creator", launch.key().as_ref()], bump)]
    pub creator_auth: UncheckedAccount<'info>,
    /// CHECK: PDA with no data; the vault's token authority (§5).
    #[account(seeds = [b"partner", class.dbc_config.as_ref()], bump = class.partner_auth_bump)]
    pub partner_auth: UncheckedAccount<'info>,
    /// CHECK: created here as a WSOL token account owned by partner_auth.
    #[account(mut, seeds = [b"vault", launch.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: SPL WSOL.
    #[account(address = canon::QUOTE_MINT)]
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: DLMM LbPair; address re-derived and fields validated in the handler.
    pub dlmm_pair: UncheckedAccount<'info>,
    /// The original DBC pool creator: sets `creator_beneficiary`, so it must sign.
    pub creator: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: the instructions sysvar (D-011 introspection).
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleGraduation<'info> {
    #[account(
        mut,
        seeds = [b"launch", launch.base_mint.as_ref()],
        bump = launch.bump,
        has_one = class,
    )]
    pub launch: Box<Account<'info, Launch>>,
    #[account(seeds = [b"class", class.dbc_config.as_ref()], bump = class.bump)]
    pub class: Box<Account<'info, Class>>,
    /// CHECK: the class's DBC `PoolConfig`; DBC re-checks it against the pool.
    #[account(address = class.dbc_config)]
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: the launch's DBC `VirtualPool`; owner, discriminator and cross-links checked in the handler.
    #[account(mut, address = launch.dbc_pool)]
    pub virtual_pool: UncheckedAccount<'info>,
    /// CHECK: must be the pool's base vault (handler).
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: must be the pool's quote vault (handler).
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: the launch's base mint; writable for a stray base-fee burn.
    #[account(mut, address = launch.base_mint)]
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: SPL WSOL.
    #[account(address = canon::QUOTE_MINT)]
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: PDA with no data; DBC `fee_claimer`, signs the partner CPIs.
    #[account(seeds = [b"partner", class.dbc_config.as_ref()], bump = class.partner_auth_bump)]
    pub partner_auth: UncheckedAccount<'info>,
    /// CHECK: PDA with no data; DBC pool creator, signs the creator fee claim.
    #[account(seeds = [b"creator", launch.key().as_ref()], bump = launch.creator_auth_bump)]
    pub creator_auth: UncheckedAccount<'info>,
    /// CHECK: the launch's WSOL vault (§5) — derived, never caller-supplied.
    #[account(mut, seeds = [b"vault", launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: `partner_auth`'s base-mint ATA (staging); address and fields checked in the handler.
    #[account(mut)]
    pub staging_base: UncheckedAccount<'info>,
    /// CHECK: a WSOL token account owned by `launch.creator_beneficiary` (handler).
    #[account(mut)]
    pub beneficiary_quote: UncheckedAccount<'info>,
    /// CHECK: DBC's constant pool authority.
    #[account(address = dbc_cpi::DBC_POOL_AUTHORITY)]
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: DBC's `__event_authority` PDA.
    #[account(address = dbc_cpi::DBC_EVENT_AUTHORITY)]
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: §12 — CPI program IDs are hard-coded.
    #[account(address = DBC_PROGRAM_ID)]
    pub dbc_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct BurnLeftover<'info> {
    #[account(
        mut,
        seeds = [b"launch", launch.base_mint.as_ref()],
        bump = launch.bump,
        has_one = class,
    )]
    pub launch: Box<Account<'info, Launch>>,
    #[account(seeds = [b"class", class.dbc_config.as_ref()], bump = class.bump)]
    pub class: Box<Account<'info, Class>>,
    /// CHECK: the class's DBC `PoolConfig`; DBC re-checks it against the pool.
    #[account(address = class.dbc_config)]
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: the launch's DBC `VirtualPool`; owner, discriminator and cross-links checked in the handler.
    #[account(mut, address = launch.dbc_pool)]
    pub virtual_pool: UncheckedAccount<'info>,
    /// CHECK: must be the pool's base vault (handler).
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: must be the pool's quote vault (handler).
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: the launch's base mint; writable for the burn.
    #[account(mut, address = launch.base_mint)]
    pub base_mint: UncheckedAccount<'info>,
    /// CHECK: SPL WSOL.
    #[account(address = canon::QUOTE_MINT)]
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: PDA with no data; DBC `leftover_receiver` and `fee_claimer`, burn authority.
    #[account(seeds = [b"partner", class.dbc_config.as_ref()], bump = class.partner_auth_bump)]
    pub partner_auth: UncheckedAccount<'info>,
    /// CHECK: the launch's WSOL vault (§5) — derived, never caller-supplied.
    #[account(mut, seeds = [b"vault", launch.key().as_ref()], bump = launch.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: `partner_auth`'s base-mint ATA (staging); address and fields checked in the handler.
    #[account(mut)]
    pub staging_base: UncheckedAccount<'info>,
    /// CHECK: DBC's constant pool authority.
    #[account(address = dbc_cpi::DBC_POOL_AUTHORITY)]
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: DBC's `__event_authority` PDA.
    #[account(address = dbc_cpi::DBC_EVENT_AUTHORITY)]
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: §12 — CPI program IDs are hard-coded.
    #[account(address = DBC_PROGRAM_ID)]
    pub dbc_program: UncheckedAccount<'info>,
    /// CHECK: SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
}

#[event]
pub struct GlobalInitialized {
    pub admin: Pubkey,
    pub treasury: Pubkey,
}

#[event]
pub struct ClassCreated {
    pub config: Pubkey,
    pub size_tag: u8,
    pub config_hash: [u8; 32],
    pub predicted_s_open: u128,
    pub bid_bin_step: u16,
}

#[event]
pub struct LaunchRegistered {
    pub launch: Pubkey,
    pub base_mint: Pubkey,
    /// The on-chain prediction, recorded in the pool-creation transaction before any third-party
    /// trade (D-011).
    pub predicted_s: u128,
    pub slot: u64,
    pub dlmm_pair: Pubkey,
    pub creator_beneficiary: Pubkey,
}

#[event]
pub struct GraduationSettled {
    pub launch: Pubkey,
    /// Partner migration fee → vault (§10: 15% of the threshold).
    pub migration_fee: u64,
    /// Partner DBC trading fees → vault.
    pub partner_fees: u64,
    /// Creator DBC trading fees → beneficiary.
    pub creator_fees: u64,
    /// Base fees burned from staging (0 under the class's QuoteToken fee mode).
    pub base_burned: u64,
}

#[event]
pub struct LeftoverBurned {
    pub launch: Pubkey,
    /// Base units burned (S falls by exactly this).
    pub amount: u64,
    /// Partner surplus → vault.
    pub surplus: u64,
}
