//! One error code per validator rule (§7: "Any failure aborts with a rule-specific error code").
//!
//! A shared or generic error for several rules is a spec violation the auditor reports, because a
//! rejected config must say *which* field was wrong — that is what makes a class auditable.
//!
//! §6's `initialize_global` error "already initialised" is Anchor's `init` constraint
//! (`AccountAlreadyInitialized`), not a code here: a second call cannot reach the handler, so a
//! Ballast-side code for it would be unreachable.

use anchor_lang::prelude::*;

#[error_code]
pub enum BallastError {
    // ---- global ----
    #[msg("signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("treasury is not an SPL token account")]
    TreasuryNotTokenAccount,
    #[msg("treasury's mint is not SPL WSOL")]
    TreasuryWrongMint,
    #[msg("class creation is disabled")]
    ClassCreationDisabled,
    #[msg("signer is not the global admin")]
    NotAdmin,
    #[msg("unknown size_tag")]
    UnknownSizeTag,
    #[msg("this size_tag has no compiler-pinned constants yet")]
    ClassNotPinned,

    // ---- §7 rule 1: account identity ----
    #[msg("rule 1: dbc_config is not owned by the DBC program")]
    ConfigWrongOwner,
    #[msg("rule 1: dbc_config discriminator is not PoolConfig")]
    ConfigWrongDiscriminator,
    #[msg("rule 1: dbc_config is too small to hold a discriminator")]
    ConfigTooSmall,
    #[msg("rule 1: dbc_config account size is wrong for PoolConfig")]
    ConfigWrongSize,
    #[msg("rule 1: dbc_config.version is not the validated version")]
    ConfigWrongVersion,

    // ---- §7 rule 2: one code per scalar row ----
    #[msg("rule 2: quote_mint is not SPL WSOL")]
    ConfigQuoteMint,
    #[msg("rule 2: quote_token_flag is not SPL (Token-2022 is rejected)")]
    ConfigQuoteTokenFlag,
    #[msg("rule 2: fee_claimer is not the partner_auth PDA")]
    ConfigFeeClaimer,
    #[msg("rule 2: leftover_receiver is not the partner_auth PDA")]
    ConfigLeftoverReceiver,
    #[msg("rule 2: token_type is not SPL")]
    ConfigTokenType,
    #[msg("rule 2: token_decimal is not 6")]
    ConfigTokenDecimal,
    #[msg("rule 2: fixed_token_supply_flag is not set")]
    ConfigFixedSupplyFlag,
    #[msg("rule 2: pre_migration_token_supply is not 10^15")]
    ConfigPreMigrationSupply,
    #[msg("rule 2: token_update_authority is not Immutable")]
    ConfigTokenUpdateAuthority,
    #[msg("rule 2: collect_fee_mode is not quote-only")]
    ConfigCollectFeeMode,
    #[msg("rule 2: migration_option is not DAMM v2")]
    ConfigMigrationOption,
    #[msg("rule 2: migration_fee_option is not the Customizable option")]
    ConfigMigrationFeeOption,
    #[msg("rule 2: migrated_collect_fee_mode is not DBC QuoteToken (D-010)")]
    ConfigMigratedCollectFeeMode,
    #[msg("rule 2: migrated_dynamic_fee is not off")]
    ConfigMigratedDynamicFee,
    #[msg("rule 2: migrated_pool_fee_bps is not 100")]
    ConfigMigratedPoolFeeBps,
    #[msg("rule 2: migrated pool base fee is not a flat mode with zero scheduler bytes")]
    ConfigMigratedBaseFeeMode,
    #[msg("rule 2: migrated_compounding_fee_bps is not 0")]
    ConfigMigratedCompounding,
    #[msg("rule 2: creator_trading_fee_percentage is not 50")]
    ConfigCreatorTradingFee,
    #[msg("rule 2: migration_fee_percentage is not 15")]
    ConfigMigrationFeePercentage,
    #[msg("rule 2: creator_migration_fee_percentage is not 0")]
    ConfigCreatorMigrationFeePercentage,
    #[msg("rule 2: partner permanent LP percentage is not 50")]
    ConfigPartnerPermanentLp,
    #[msg("rule 2: creator permanent LP percentage is not 50")]
    ConfigCreatorPermanentLp,
    #[msg("rule 2: partner unlocked LP percentage is not 0")]
    ConfigPartnerLp,
    #[msg("rule 2: creator unlocked LP percentage is not 0")]
    ConfigCreatorLp,
    #[msg("rule 2: LP vesting is not all zero")]
    ConfigLpVesting,
    #[msg("rule 2: token locked vesting is not all zero")]
    ConfigLockedVesting,
    #[msg("rule 2: enable_first_swap_with_min_fee is not false")]
    ConfigFirstSwapMinFee,
    #[msg("rule 2: base fee is not a flat 1% cliff with zero periods and zero factors")]
    ConfigBaseFee,
    #[msg("rule 2: dynamic fee is not disabled")]
    ConfigDynamicFee,
    #[msg("rule 2: migration_quote_threshold does not match the size")]
    ConfigThreshold,
    #[msg("rule 2: sqrt_start_price does not match the size")]
    ConfigStartPrice,

    // ---- §7 rule 3: canonical hash ----
    #[msg("rule 3: config hash does not match the compiled constant for this size_tag")]
    ConfigHashMismatch,

    // ---- §7 rule 4: derived checks ----
    #[msg("rule 4: migration_sqrt_price is not within tolerance of the last curve point")]
    ConfigMigrationPriceOutOfBand,
    #[msg("rule 4: the curve cannot absorb the whole migration_quote_threshold")]
    ConfigCurveCapacityTooSmall,
    #[msg("rule 4: the curve does not have exactly three non-zero leading points")]
    ConfigCurvePointCount,
    #[msg("rule 4: the curve's points are not strictly ascending in sqrt_price")]
    ConfigCurveNotAscending,
    #[msg("rule 4: the curve's unused tail entries are not zero")]
    ConfigCurveTailNotZero,
    #[msg("rule 4: LP percentages do not sum to 100")]
    ConfigLpPercentagesSum,

    // ---- §7 rule 5 (D-014): the bin step ----
    #[msg("rule 5: bid_bin_step is not a DLMM-legal step for this class (D-014)")]
    ConfigBinStep,

    // ---- prediction ----
    #[msg("predicted_s_open is zero or out of range")]
    BadPrediction,

    // ---- arithmetic ----
    #[msg("arithmetic overflow")]
    Overflow,

    // ---- register_launch (§6, D-011) — appended so earlier codes stay stable ----
    #[msg("launch tx: an instruction is too short to parse")]
    LaunchTxMalformed,
    #[msg("launch tx: no DBC pool creation for this pool before register_launch")]
    LaunchPoolNotCreatedInTx,
    #[msg("launch tx: no DLMM pair creation for this pair before register_launch")]
    LaunchPairNotCreatedInTx,
    #[msg("launch: the pool creator was not transferred to creator_auth")]
    LaunchCreatorNotTransferred,
    #[msg("launch: the pool is not from this class's DBC config")]
    LaunchWrongConfig,
    #[msg("launch: base mint does not match the pool")]
    LaunchBaseMintMismatch,
    #[msg("launch: the signing creator is not the pool's creator")]
    LaunchCreatorMismatch,
    #[msg("launch tx: more than one DBC swap before register_launch")]
    LaunchTooManySwaps,
    #[msg("launch tx: the DBC swap before register_launch is not by the payer")]
    LaunchSwapNotByPayer,
    #[msg("launch tx: the payer's first buy exceeds the class dust limit")]
    LaunchDustBuyTooLarge,
    #[msg("launch tx: unexpected DBC instruction before register_launch")]
    LaunchUnexpectedDbcInstruction,
    #[msg("launch tx: unexpected DLMM instruction before register_launch")]
    LaunchUnexpectedDlmmInstruction,
    #[msg("launch: virtual_pool is not a DBC VirtualPool")]
    LaunchPoolWrongOwner,
    #[msg("launch: the pool's quote reserve exceeds the dust limit (already traded)")]
    LaunchPoolAlreadyTraded,
    #[msg("launch: base mint is not an SPL Token mint")]
    LaunchBaseMintNotSpl,
    #[msg("launch: dlmm_pair is not a DLMM LbPair")]
    LaunchPairWrongOwner,
    #[msg("launch: dlmm_pair is not the customizable pair for (base mint, WSOL)")]
    LaunchPairWrongAddress,
    #[msg("launch: pair mints are not (base mint, WSOL)")]
    LaunchPairWrongMints,
    #[msg("launch: pair bin step is not the class bin step (D-014)")]
    LaunchPairWrongBinStep,
    #[msg("launch: pair is not a customizable LimitOrder pair")]
    LaunchPairWrongType,
    #[msg("launch: pair does not collect fees in WSOL only")]
    LaunchPairWrongFeeMode,
    #[msg("launch: pair base fee is not 1 bps")]
    LaunchPairWrongBaseFee,
    #[msg("launch: pair creator has on/off control")]
    LaunchPairCreatorControl,
    #[msg("launch: pair is not enabled")]
    LaunchPairDisabled,
}
