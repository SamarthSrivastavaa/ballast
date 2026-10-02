//! D-002 condition 3, isolated: does `crates/floor` + `ruint` compile for the SBF target under
//! the platform-tools rustc, with **nothing else** in the dependency tree?
//!
//! The Anchor probe next door answers a different and broader question, and it currently fails for
//! reasons that have nothing to do with this crate: platform-tools v1.43 bundles cargo 1.79.0,
//! which cannot parse the edition-2024 manifests that the Anchor/Solana transitive tree now pulls
//! in (`block-buffer 0.12`, `toml_datetime 1.1`, …). That is a toolchain question.
//!
//! This crate removes that confound. It depends on `ballast-floor` and nothing else, so if it
//! builds, condition 3 is satisfied as written: the floor engine and `ruint` are SBF-clean.

#![no_std]
#![allow(clippy::arithmetic_side_effects)]

use ballast_floor::{floor_sqrt_q64, redeem_payout, FloorInputs, REDEEM_FEE_BPS, S_MAX_DAMM_V2};

#[cfg(target_os = "solana")]
#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

/// §27 Public vector, recomputed with no std, no alloc and no host support.
///
/// Returns 0 on success and a non-zero code on any mismatch, so the result is observable from a
/// caller without needing a logging syscall.
#[no_mangle]
pub extern "C" fn ballast_floor_sbf_selftest() -> u64 {
    let inputs = FloorInputs {
        v: 3_750_000_000,
        s: 865_440_991_257_550,
        l: 48_447_370_329_204_224_440_919_346_118_656,
        s_max: S_MAX_DAMM_V2,
    };

    let s = match floor_sqrt_q64(&inputs) {
        Ok(s) => s,
        Err(_) => return 1,
    };
    if s != 75_507_360_421_341_854 {
        return 2;
    }
    if redeem_payout(1_000_000_000_000, s, REDEEM_FEE_BPS) != 16_671_021 {
        return 3;
    }
    // Bounds must still be errors, not values, on this target.
    let bad = FloorInputs { s: 0, ..inputs };
    if floor_sqrt_q64(&bad).is_ok() {
        return 4;
    }
    0
}

/// Keep the symbol reachable so the optimiser cannot discard the whole engine.
#[no_mangle]
pub extern "C" fn entrypoint(_input: *mut u8) -> u64 {
    ballast_floor_sbf_selftest()
}
