//! Toolchain probe — proves D-002 condition 3 and nothing else.
//!
//! This is **not** `programs/ballast`. It is a test harness, which is all the P0 gate rule allows
//! until Q1–Q5 pass. Its only job is to show that:
//!
//! 1. `crates/floor` and its non-dev dependency (`ruint`) compile for the SBF target under the
//!    platform-tools rustc (1.79.0 in platform-tools v1.43), even though the host pin is 1.85.0
//!    (D-002); and
//! 2. `floor_sqrt_q64` returns the §27 Public vector's exact `s` when run **on-chain**, not just
//!    on the host — so the floor engine is usable from an Anchor program at all.
//!
//! If this program stops building, D-002 condition 4 applies: pin an older `ruint`, and do not
//! change the toolchain again without asking.

use anchor_lang::prelude::*;
use ballast_floor::{floor_sqrt_q64, redeem_payout, FloorInputs, REDEEM_FEE_BPS, S_MAX_DAMM_V2};

declare_id!("C6vEPX5hU7uK6VXzJLBoZYM1nwnmbcbpEEJ83ghV4aPq");

/// §27 Public launch vector.
const PUBLIC_V: u64 = 3_750_000_000;
const PUBLIC_S: u64 = 865_440_991_257_550;
const PUBLIC_L: u128 = 48_447_370_329_204_224_440_919_346_118_656;
const PUBLIC_EXPECTED_S: u128 = 75_507_360_421_341_854;
/// §27: redeeming 1M tokens (1e6 tokens at 6 decimals = 1e12 base units) pays this many lamports.
const PUBLIC_EXPECTED_PAYOUT: u64 = 16_671_021;

#[program]
pub mod probe {
    use super::*;

    /// Recompute the §27 Public vector on-chain and fail the transaction unless it is exact.
    pub fn check_public_vector(_ctx: Context<CheckPublicVector>) -> Result<()> {
        let inputs = FloorInputs {
            v: PUBLIC_V,
            s: PUBLIC_S,
            l: PUBLIC_L,
            s_max: S_MAX_DAMM_V2,
        };

        let s = floor_sqrt_q64(&inputs).map_err(|_| error!(ProbeError::FloorErrored))?;
        msg!("floor_sqrt_q64 -> s = {}", s);
        require!(s == PUBLIC_EXPECTED_S, ProbeError::FloorMismatch);

        let payout = redeem_payout(1_000_000_000_000, s, REDEEM_FEE_BPS);
        msg!("redeem_payout(1e12, s, 50bps) -> {} lamports", payout);
        require!(
            payout == PUBLIC_EXPECTED_PAYOUT,
            ProbeError::PayoutMismatch
        );

        // Out-of-range input must be an error on-chain too, never a value (§4).
        let bad = FloorInputs { s: 0, ..inputs };
        require!(floor_sqrt_q64(&bad).is_err(), ProbeError::BoundsNotEnforced);

        msg!("probe: OK — §27 Public vector reproduced on-chain");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct CheckPublicVector {}

#[error_code]
pub enum ProbeError {
    #[msg("floor_sqrt_q64 returned an error for in-range inputs")]
    FloorErrored,
    #[msg("on-chain s does not match the §27 Public vector")]
    FloorMismatch,
    #[msg("on-chain redeem_payout does not match the §27 Public vector")]
    PayoutMismatch,
    #[msg("bounds were not enforced on-chain")]
    BoundsNotEnforced,
}
