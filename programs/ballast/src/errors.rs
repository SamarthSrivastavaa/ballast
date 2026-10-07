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

    // ---- settle_graduation, burn_leftover (§6) — appended so earlier codes stay stable ----
    #[msg("launch is not in the state this instruction requires")]
    LaunchWrongState,
    #[msg("DBC curve not complete (quote_reserve < migration threshold)")]
    CurveNotComplete,
    #[msg("DBC pool not migrated (migration_progress != CreatedPool)")]
    PoolNotMigrated,
    #[msg("base or quote vault is not the DBC pool's")]
    PoolVaultMismatch,
    #[msg("staging account is not partner_auth's base-mint ATA")]
    StagingNotPartnerAta,
    #[msg("beneficiary account is not a WSOL account owned by creator_beneficiary")]
    BeneficiaryAccountInvalid,
    #[msg("vault is not a WSOL account owned by partner_auth")]
    VaultInvalid,
    #[msg("a creator base-token fee would be burned; refusing (class pins QuoteToken fees)")]
    CreatorBaseFee,
    #[msg("creator_beneficiary is one of this program's PDAs")]
    BeneficiaryIsBallastPda,

    // ---- Part 2: open, refresh_floor, redeem, floor, harvest, deposit (§6, §8, §9, §10) ----
    #[msg("DAMM pool is not a DAMM v2 Pool for (base mint, WSOL)")]
    DammPoolInvalid,
    #[msg("DAMM pool is not the PDA under the DBC migration config (§8)")]
    DammPoolNotMigrated,
    #[msg("DAMM pool is not OnlyB / non-compounding (§8)")]
    DammPoolMode,
    #[msg("DAMM pool range is not full range (§8)")]
    DammPoolRange,
    #[msg("position is not a DAMM v2 Position at its canonical address")]
    PositionInvalid,
    #[msg("position is not in the launch's DAMM pool")]
    PositionWrongPool,
    #[msg("position liquidity is not fully permanent (§8)")]
    PositionNotPermanent,
    #[msg("position NFT is not held by the required Ballast PDA (§8)")]
    PositionNftHolder,
    #[msg("partner and creator positions are the same account")]
    PositionsNotDistinct,
    #[msg("position is not the one recorded at open")]
    PositionNotRecorded,
    #[msg("floor below the on-chain prediction (s_open < predicted_s)")]
    FloorBelowPrediction,
    #[msg("floor computation rejected its inputs (§4 bounds)")]
    FloorInputsOutOfRange,
    #[msg("monotone check failed: s_new < s_last (§4)")]
    FloorDecreased,
    #[msg("bin hint is not the highest bin at or below F (§9)")]
    BinHintNotAtFloor,
    #[msg("DLMM has no price for this bin")]
    BinPriceUndefined,
    #[msg("bin array for the bid bin does not exist; the keeper creates it (D-013)")]
    BinArrayMissing,
    #[msg("bitmap extension account is not the one DLMM requires for this bin")]
    BitmapExtensionInvalid,
    #[msg("DLMM pair accounts do not match the launch's pair")]
    PairAccountsInvalid,
    #[msg("limit order is not the launch's recorded bid order")]
    BidOrderMismatch,
    #[msg("partner_auth lacks lamports for the order account rent (keeper funds it, §5)")]
    PartnerAuthUnfunded,
    #[msg("vault holds nothing to bid")]
    VaultEmpty,
    #[msg("refresh_floor called again within the rate limit")]
    RefreshRateLimited,
    #[msg("F moved more bins than one call scans; run refresh_floor first")]
    BidBinStale,
    #[msg("redemption payout below the minimum (0.001 SOL, §10)")]
    PayoutBelowMinimum,
    #[msg("redemption payout below min_out")]
    SlippageExceeded,
    #[msg("redemption payout exceeds the vault")]
    VaultExhausted,
    #[msg("holder account is not the holder's token account for this mint")]
    HolderAccountInvalid,
    #[msg("treasury account is not global.treasury")]
    TreasuryMismatch,
    #[msg("a creator base-token LP fee would be burned; refusing (pool is OnlyB)")]
    CreatorBaseLpFee,
    #[msg("deposit amount is zero")]
    DepositZero,
}
