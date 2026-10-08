//! On-chain state (§5): `Global`, `Class`, `Launch`, and the §7/§9 canonical constants.

use anchor_lang::prelude::*;

/// §5: admin (a multisig), treasury, class-creation switch. Initialised once.
#[account]
#[derive(InitSpace)]
pub struct Global {
    /// The 2-of-3 multisig (§19). Can create classes and toggle creation — nothing else.
    pub admin: Pubkey,
    /// Treasury WSOL token account, receiving 10% of harvested partner LP fees (§6 `harvest`).
    pub treasury: Pubkey,
    pub class_creation_enabled: bool,
    pub version: u8,
    pub bump: u8,
    pub reserved: [u8; 64],
}

/// §5: a verified DBC config plus the prediction parameters. Immutable once created.
#[account]
#[derive(InitSpace)]
pub struct Class {
    /// The DBC `PoolConfig` this class is pinned to.
    pub dbc_config: Pubkey,
    pub quote_mint: Pubkey,
    /// `sha256` over the canonical curve fields (§7 rule 3).
    pub config_hash: [u8; 32],
    pub size_tag: u8,
    pub partner_auth_bump: u8,
    pub migration_threshold: u64,
    /// Lower bound on `s` at `open`, from the compiler (§7). `u128` = Q64 sqrt price.
    pub predicted_s_open: u128,
    /// D-014: fixed per class. The DLMM pair address carries no bin step, so there is one pair per
    /// mint pair and this value cannot be changed later.
    pub bid_bin_step: u16,
    pub redeem_fee_bps: u16,
    pub harvest_treasury_bps: u16,
    pub vault_cap: u64,
    /// D-011(b): the payer's dust first buy in the launch transaction must not exceed this.
    pub dust_limit: u64,
    pub launches: u32,
    pub bump: u8,
    pub reserved: [u8; 64],
}

/// §5 launch lifecycle. Stored as a `u8`; `0` is never a valid state.
pub mod launch_state {
    pub const REGISTERED: u8 = 1;
    pub const FUNDED: u8 = 2;
    /// §5 lists `Migrated` between `Funded` and `Cleaned`; `burn_leftover` is the first instruction
    /// to observe `CreatedPool` and moves straight to `CLEANED`, so it is never stored on its own.
    pub const MIGRATED: u8 = 3;
    pub const CLEANED: u8 = 4;
    pub const OPEN: u8 = 5;
}

/// §5: one launch. Never closed — it is the public proof record.
#[account]
#[derive(InitSpace)]
pub struct Launch {
    pub class: Pubkey,
    pub dbc_pool: Pubkey,
    pub base_mint: Pubkey,
    /// Receives creator income at its WSOL ATA, through `pay_creator` only (D-022) — never on the
    /// floor's critical path. Set by the signing creator.
    pub creator_beneficiary: Pubkey,
    pub state: u8,
    pub bump: u8,
    pub creator_auth_bump: u8,
    pub vault_bump: u8,
    /// The on-chain prediction (§7): `class.predicted_s_open`, recorded in the pool-creation
    /// transaction before any third-party trade (D-011).
    pub predicted_s: u128,
    pub registered_slot: u64,
    pub damm_pool: Pubkey,
    pub partner_position: Pubkey,
    pub creator_position: Pubkey,
    pub partner_nft_account: Pubkey,
    pub creator_nft_account: Pubkey,
    pub dlmm_pair: Pubkey,
    pub bid_order: Pubkey,
    pub bid_bin_id: i32,
    pub bid_quote_committed: u64,
    pub s_open: u128,
    /// Only state cached across instructions (§4 code rule 2): the monotone check's last `s`.
    pub s_last: u128,
    pub burned: u64,
    pub redeemed_tokens: u64,
    pub redeemed_lamports: u64,
    pub harvested: u64,
    pub deposited: u64,
    pub filled_tokens: u64,
    pub creator_forwarded: u64,
    pub treasury_fees: u64,
    pub open_slot: u64,
    /// `settle_graduation`: the partner migration fee and partner trading fees moved to the vault.
    pub migration_fee: u64,
    pub partner_fees: u64,
    /// `burn_leftover`: leftover base units burned and partner surplus moved to the vault.
    pub leftover_burned: u64,
    pub surplus: u64,
    /// `refresh_floor` rate limit (§6): slot of the last refresh.
    pub last_refresh_slot: u64,
    /// L at `open`. A later live read below it is §8's `BackingDecreased` fail-safe.
    pub l_open: u128,
    /// §8 fail-safe: set once L reads below `l_open`; the monotone check is then suspended.
    pub degraded: bool,
    /// D-020: the resting bid sits at the DLMM active bin, below F's bin, because a third-party order
    /// pinned the active bin. Still a bid at or below F; any `refresh_floor` lifts it once cleared.
    pub bid_capped: bool,
    /// D-021: the vault rests unplaced because the DLMM active bin is pinned more than 70 bins under
    /// F's bin (or where DLMM has no price). V still counts the vault; redemption stays live. While
    /// set, `bid_bin_id` is the pinned active bin and `bid_order` is default.
    pub bid_suspended: bool,
    /// §10 ledger (audit 7 Oct): quote the bid spent on fills, net of the fees DLMM credits back
    /// (committed − returned on each cancel).
    pub fill_quote_spent: u64,
    /// §8 fail-safe (audit 7 Oct): each recorded position's L, lowered when a decrease is observed so
    /// every further decrease emits its own `BackingDecreased`.
    pub partner_l_recorded: u128,
    pub creator_l_recorded: u128,
    pub reserved: [u8; 61],
}

/// The canonical parameters a class must match (§7). One per `size_tag`.
///
/// These are the scalar rows of §7's table. `create_class` checks the on-chain `PoolConfig`
/// against the entry for the declared tag, field by field, each with its own error code.
pub struct ClassCanon {
    pub size_tag: u8,
    pub name: &'static str,
    pub migration_quote_threshold: u64,
    pub sqrt_start_price: u128,
    /// `sha256(sqrt_start_price ‖ curve[0..20] ‖ migration_quote_threshold ‖ supply fields)`.
    pub config_hash: [u8; 32],
    pub predicted_s_open: u128,
    pub bid_bin_step: u16,
    pub dust_limit: u64,
}

/// §7 scalar rows that are identical across sizes.
pub mod canon {
    use anchor_lang::prelude::{pubkey, Pubkey};

    /// SPL WSOL. A `Pubkey`, not a `&str`, so the §7 rule-2 check can actually compare against it
    /// — as a string it sat unused and the hard-coded-ID rule had no teeth.
    pub const QUOTE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
    /// DBC's SPL-vs-Token-2022 discriminator for the quote mint (§7, Q20).
    pub const QUOTE_TOKEN_FLAG_SPL: u8 = 0;
    pub const TOKEN_TYPE: u8 = 0; // SPL
    pub const TOKEN_DECIMAL: u8 = 6;
    pub const FIXED_TOKEN_SUPPLY_FLAG: u8 = 1;
    pub const PRE_MIGRATION_TOKEN_SUPPLY: u64 = 1_000_000_000_000_000; // 10^15 = 1B tokens
    pub const TOKEN_UPDATE_AUTHORITY_IMMUTABLE: u8 = 1;
    pub const COLLECT_FEE_MODE_QUOTE: u8 = 0;
    pub const MIGRATION_OPTION_DAMM_V2: u8 = 1;
    /// §7 "Migrated pool: Customizable option". DBC honours the `migrated_*` fee fields only under
    /// this option, so the checks on them are void without it. 6 is the Customizable index used by
    /// the harness throughout STEP 3 (`DAMM_V2_MIGRATION_FEE_ADDRESS[6]`).
    pub const MIGRATION_FEE_OPTION_CUSTOMIZABLE: u8 = 6;
    pub const CREATOR_TRADING_FEE_PERCENTAGE: u8 = 50;
    pub const MIGRATION_FEE_PERCENTAGE: u8 = 15;
    pub const CREATOR_MIGRATION_FEE_PERCENTAGE: u8 = 0;
    pub const PARTNER_PERMANENT_LP_PERCENTAGE: u8 = 50;
    pub const CREATOR_PERMANENT_LP_PERCENTAGE: u8 = 50;
    pub const PARTNER_LP_PERCENTAGE: u8 = 0;
    pub const CREATOR_LP_PERCENTAGE: u8 = 0;
    /// D-010: the DBC-side value. DBC's enum is {0 QuoteToken, 1 OutputToken, 2 Compounding};
    /// value 0 yields a DAMM v2 `collect_fee_mode = 1` (OnlyB) pool. §7 originally wrote 1 here,
    /// which is DBC OutputToken and produces a BothToken pool (Q2).
    pub const MIGRATED_COLLECT_FEE_MODE: u8 = 0;
    pub const MIGRATED_DYNAMIC_FEE: u8 = 0;
    pub const MIGRATED_POOL_FEE_BPS: u16 = 100;
    pub const MIGRATED_COMPOUNDING_FEE_BPS: u16 = 0;
    pub const ENABLE_FIRST_SWAP_WITH_MIN_FEE: u8 = 0;
    /// §7 "Base fee: cliff numerator 10,000,000 (1% of 1e9)".
    pub const BASE_FEE_CLIFF_NUMERATOR: u64 = 10_000_000;
    /// Flat base fee. Under the rate-limiter mode the factor fields are reinterpreted, so the mode
    /// must be pinned for "flat 1%" to mean anything.
    pub const BASE_FEE_MODE_FLAT: u8 = 0;
    /// Flat migrated-pool base fee. §31 forbids market-cap-fee pools outright.
    pub const MIGRATED_POOL_BASE_FEE_MODE_FLAT: u8 = 0;
    /// §7 rule 4 band (D-017). DBC derives `migration_sqrt_price` slightly below the last curve
    /// point because segment liquidity rounds up. Tolerance = the largest shortfall measured on the
    /// mainnet DBC binary (Proof 4,580,459; Public 2,896,937 — evidence/program/d017/band.json),
    /// plus 2 units of rounding margin. Two-sided on purpose: this field is absent from the rule-3
    /// hash, so a one-sided bound would leave it unpinned. `compiler --check` keeps it equal to
    /// the reference's value; the pinned prediction is taken at the lower-F band end (D-017).
    pub const MIGRATION_PRICE_TOLERANCE: u128 = 4_580_461;
    /// §10 "Dust: minimum payout 0.001 SOL".
    pub const MIN_PAYOUT: u64 = 1_000_000;
    /// §6 `refresh_floor` "rate-limited to once per N slots per launch". The spec gives no N; 10
    /// slots (≈ 4 s) bounds griefing to one cancel/re-place per 10 slots.
    pub const REFRESH_MIN_SLOTS: u64 = 10;
    /// D-021: the bid may be capped at the DLMM active bin only within this many bins under F's
    /// bin; further down, the vault stays unplaced (the DLMM leg is suspended).
    pub const MAX_CAP_DEPTH: i32 = 70;
    /// Bin steps DLMM accepted for a customizable LimitOrder pair (Q9, measured by simulation).
    pub const DLMM_BIN_STEPS: [u16; 10] = [1, 2, 4, 5, 8, 10, 16, 20, 25, 50];
    /// The DBC `PoolConfig.version` validated on the mainnet binaries (Q12).
    pub const POOL_CONFIG_VERSION: u8 = 0;
    /// §7: exactly three non-zero curve points.
    pub const CURVE_POINTS: usize = 3;
    pub const REDEEM_FEE_BPS: u16 = 50;
    pub const HARVEST_TREASURY_BPS: u16 = 1_000;

    // ---- §9 DLMM pair, as created in the launch transaction (D-011) and observed in Q8 ----
    /// `LbPair.pair_type` of a customizable permissionless pair.
    pub const DLMM_PAIR_TYPE_CUSTOMIZABLE: u8 = 2;
    /// `parameters.function_type` of a LimitOrder pair (DLMM `FunctionType::LimitOrder`).
    pub const DLMM_FUNCTION_TYPE_LIMIT_ORDER: u8 = 2;
    /// `parameters.collect_fee_mode`: fees in token Y (WSOL) only.
    pub const DLMM_COLLECT_FEE_MODE_ONLY_Y: u8 = 1;
    /// §9 "base fee: minimum allowed" — Q9 measured 1 bps as accepted; base fee in bps is
    /// `base_factor · bin_step / 10_000` with `base_fee_power_factor = 0`.
    pub const DLMM_BASE_FEE_BPS_X10K: u32 = 10_000;
    pub const DLMM_PAIR_STATUS_ENABLED: u8 = 0;

    // ---- DBC lifecycle, as observed on the mainnet binaries ----
    /// `VirtualPool.migration_progress` after `migration_damm_v2` (Q1: 2 at completion, 3 after).
    pub const DBC_MIGRATION_PROGRESS_CREATED_POOL: u8 = 3;
}
