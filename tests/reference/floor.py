#!/usr/bin/env python3
"""Independent integer reference for the Ballast floor engine (BUILD_SPEC.md §4, §11, §27).

This file exists only to catch errors in `crates/floor` (§11). It is written from the spec's
derivation, not transliterated from the Rust, and it shares no code with it. Integers only --
no float appears anywhere in the computation. `math.isqrt` is exact integer sqrt.

Derivation, from §4, re-done here rather than copied:

    s      = floor(sqrt(F) * 2^64)              so  sqrt(F)      = s / 2^64,  F = s^2 / 2^128
    s_max  = floor(sqrt(P_max) * 2^64)          so  sqrt(P_max)  = s_max / 2^64
    L_real = L / 2^64

    V/F + L_real*(1/sqrt(F) - 1/sqrt(P_max)) = S

      V/F                       = V * 2^128 / s^2
      L_real * 1/sqrt(F)        = (L / 2^64) * (2^64 / s)     = L / s
      L_real * 1/sqrt(P_max)    = (L / 2^64) * (2^64 / s_max) = L / s_max

    =>  V*2^128/s^2 + L/s - L/s_max = S           | * s^2
    =>  V*2^128 + L*s - (L/s_max)*s^2 = S*s^2
    =>  (S + L/s_max)*s^2 - L*s - V*2^128 = 0
    =>  A*s^2 - B*s - C = 0     with  A = S + ceil(L/s_max),  B = L,  C = V*2^128

The ceiling on L/s_max is the one rounding choice that is not obvious: a larger A makes s
smaller, i.e. the reported floor lower, which is the direction that favours the protocol (§4
"Rounding ... towards the protocol, everywhere").

F is defined as  s = max{ s : P(s) <= 0 },  P(s) = A*s^2 - B*s - C.

Usage:
    python tests/reference/floor.py                      # self-test on the §27 vectors
    python tests/reference/floor.py --emit N > out.json   # vectors.json with N random cases
"""

import argparse
import json
import math
import random
import sys

# ---------------------------------------------------------------------------
# Constants (§4 bounds, §27 header)
# ---------------------------------------------------------------------------

#: DAMM v2 maximum sqrt price, Q64.64 (§2, §27). Re-read from the pool on chain; this is the
#: value every §27 vector was computed with.
S_MAX_DAMM_V2 = 79226673521066979257578248091

TWO_128 = 1 << 128

SUPPLY_BOUND = 1 << 50   # S <= 2^50          (inclusive)
VAULT_BOUND = (1 << 64) - 1  # V <= 2^64 - 1  (inclusive)
L_BOUND = 1 << 120       # §4 says L < 2^120; §27 has a vector at exactly 2^120 -- see
                         # DECISIONS.md "§4 vs §27 L bound". Treated as inclusive so that
                         # the §27 vector, which is a hard test obligation, is computable.
S_MAX_BOUND = 1 << 97    # s_max < 2^97       (strict)


class FloorError(Exception):
    """Mirrors the crate's error enum; out-of-range input returns an error, never a value."""


class SupplyZero(FloorError):
    pass


class OutOfRange(FloorError):
    pass


# ---------------------------------------------------------------------------
# §4 algorithm
# ---------------------------------------------------------------------------


def _check_bounds(v: int, s_supply: int, l: int, s_max: int) -> None:
    """§4: asserts precede all arithmetic. Out-of-range input is an error, never a value."""
    if s_supply == 0:
        raise SupplyZero("S == 0")
    if s_supply < 0 or s_supply > SUPPLY_BOUND:
        raise OutOfRange(f"S={s_supply} outside (0, 2^50]")
    if v < 0 or v > VAULT_BOUND:
        raise OutOfRange(f"V={v} outside [0, 2^64-1]")
    if l < 0 or l > L_BOUND:
        raise OutOfRange(f"L={l} outside [0, 2^120]")
    if s_max <= 0 or s_max >= S_MAX_BOUND:
        raise OutOfRange(f"s_max={s_max} outside (0, 2^97)")


def _ceil_div(a: int, b: int) -> int:
    return -(-a // b)


def coefficients(v: int, s_supply: int, l: int, s_max: int) -> tuple[int, int, int]:
    """A = S + ceil(L/s_max), B = L, C = V * 2^128."""
    a = s_supply + _ceil_div(l, s_max)
    b = l
    c = v * TWO_128
    return a, b, c


def residual(a: int, b: int, c: int, s: int) -> int:
    """P(s) = A*s^2 - B*s - C."""
    return a * s * s - b * s - c


def floor_sqrt_q64(v: int, s_supply: int, l: int, s_max: int = S_MAX_DAMM_V2) -> int:
    """Return s = floor(sqrt(F) * 2^64), exactly the floor of the positive root (§4)."""
    _check_bounds(v, s_supply, l, s_max)
    a, b, c = coefficients(v, s_supply, l, s_max)

    # 1. D = B^2 + 4AC  (arbitrary precision here; U256 in the crate)
    d = b * b + 4 * a * c

    # 2. First estimate from the exact integer sqrt.
    s = (b + math.isqrt(d)) // (2 * a)

    # 3. Correction loop, both directions. isqrt is exact but the outer division truncates,
    #    so the estimate can land either side of the true floor.
    while s > 0 and residual(a, b, c, s) > 0:
        s -= 1
    while residual(a, b, c, s + 1) <= 0:
        s += 1

    # 4. s is now exactly max{s : P(s) <= 0}.
    return s


def redeem_payout(amount: int, s: int, fee_bps: int) -> int:
    """floor(amount * s^2 * (10_000 - fee_bps) / (2^128 * 10_000))  (§10, §11)."""
    if not 0 <= fee_bps <= 10_000:
        raise OutOfRange(f"fee_bps={fee_bps}")
    return (amount * s * s * (10_000 - fee_bps)) // (TWO_128 * 10_000)


def bin_at_or_below(bin_price_q64: int, next_bin_price_q64: int, s: int) -> bool:
    """True iff price(bin) <= F < price(bin+1), with F = s^2 / 2^128 (§9, §11).

    DLMM prices are Q64 (lamports per base unit, scaled by 2^64), so the comparison is
    bin_price * 2^64 <= s^2 < next_bin_price * 2^64 -- done in integers, no division.
    """
    f_scaled = s * s  # F * 2^128
    return (bin_price_q64 << 64) <= f_scaled < (next_bin_price_q64 << 64)


def residual_sign(v: int, s_supply: int, l: int, s_max: int, s: int) -> int:
    """sign(P(s)): -1 below the root, 0 on it, +1 above (§11)."""
    _check_bounds(v, s_supply, l, s_max)
    a, b, c = coefficients(v, s_supply, l, s_max)
    r = residual(a, b, c, s)
    return (r > 0) - (r < 0)


def f_raw(s: int) -> float:
    """F in lamports per base unit. Display only -- never used in a computation."""
    return (s * s) / TWO_128


def f_display(s: int) -> float:
    """F in SOL per token = F_raw * 10^6 / 10^9 (§4). Display only."""
    return f_raw(s) * 1e6 / 1e9


# ---------------------------------------------------------------------------
# §27 vectors
# ---------------------------------------------------------------------------

#: (name, V, S, L, expected_s) -- the launch and boundary vectors of §27 verbatim.
SPEC_VECTORS: list[tuple[str, int, int, int, int]] = [
    # Launch vectors
    ("proof", 1_500_000_000, 865_440_991_257_550,
     30_640_807_377_189_377_099_685_691_392_000, 47_755_047_807_748_143),
    ("public", 3_750_000_000, 865_440_991_257_550,
     48_447_370_329_204_224_440_919_346_118_656, 75_507_360_421_341_854),
    # Transition vectors (Public), §27
    ("public_harvest_0.1_sol", 3_850_000_000, 865_440_991_257_550,
     48_447_370_329_204_224_440_919_346_118_656, 75_919_307_215_186_886),
    ("public_deposit_1_sol", 4_750_000_000, 865_440_991_257_550,
     48_447_370_329_204_224_440_919_346_118_656, 79_478_727_226_182_304),
    ("public_redeem_50m", 2_916_448_923, 815_440_991_257_550,
     48_447_370_329_204_224_440_919_346_118_656, 75_526_438_275_666_392),
    ("public_bid_fill_100m", 2_076_195_928, 765_440_991_257_550,
     48_447_370_329_204_224_440_919_346_118_656, 75_515_850_660_144_827),
    # Boundary vectors
    ("tiny", 1_000_000, 10**12, 10**20, 18_446_744_123_700_328),
    ("max_supply_1000_sol_l_2_120", 10**12, 10**15, 1 << 120,
     1_329_228_229_483_701_708_696),
    ("vault_only_l_zero", 10**9, 10**14, 0, 58_333_726_687_135_158),
    ("pool_only_v_zero", 0, 10**14, 10**30, 9_999_999_999_998_700),
]


# ---------------------------------------------------------------------------
# §7 prediction at the two ends of the rule-4 band (D-017)
# ---------------------------------------------------------------------------

#: DAMM v2 minimum sqrt price, Q64.64 (DAMM v2 MIN_SQRT_PRICE).
S_MIN_DAMM_V2 = 4295048016

#: §7 rule-4 band, D-017: the largest shortfall of DBC's migration_sqrt_price below the last curve
#: point measured on the mainnet DBC binary (Proof 4,580,459; Public 2,896,937 --
#: evidence/program/d017/band.json) + 2 units of rounding margin. Must equal
#: programs/ballast/src/state.rs canon::MIGRATION_PRICE_TOLERANCE (the compiler checks it).
MIGRATION_PRICE_TOLERANCE = 4_580_461

#: Q14: Meteora's migration protocol share, 0.2% of the migrated amounts, taken as tokens.
PROTOCOL_SHARE_BPS = 20

CLASSES_JSON = __import__("pathlib").Path(__file__).resolve().parents[2] / "compiler/out/classes.json"


def prediction_inputs(threshold: int, sqrt_start: int, curve: list[tuple[int, int]],
                      s_mig: int, migration_fee_pct: int = 15) -> tuple[int, int, int]:
    """(V, S, L) at open for a class whose DBC config migrates at sqrt price s_mig (§7 "Prediction").

    Every rounding goes toward a LOWER floor: V and L down, S up.
      V = migration fee = threshold * 15%                                      (floor)
      L = (migrated quote - protocol share) * 2^128 / (s_mig - s_min)          (floor; share ceil)
      S = base sold along the curve to s_mig  +  base DBC migrates for the full migrated quote
          at s_mig (pool + protocol share, both still outstanding)             (each term ceil)
    Bonding fees, surplus and the partner trading fees are left out, so they only raise F.
    """
    v = threshold * migration_fee_pct // 100
    q_mig = threshold - v
    q_protocol = _ceil_div(q_mig * PROTOCOL_SHARE_BPS, 10_000)
    l = (q_mig - q_protocol) * TWO_128 // (s_mig - S_MIN_DAMM_V2)

    sold, lo = 0, sqrt_start
    for s_pt, l_seg in curve:
        hi = min(s_pt, s_mig)
        if hi > lo:
            sold += _ceil_div(l_seg * (hi - lo), lo * hi)
        lo = s_pt
        if s_pt >= s_mig:
            break
    l_full = _ceil_div(q_mig * TWO_128, s_mig - S_MIN_DAMM_V2)
    base_mig = _ceil_div(l_full * (S_MAX_DAMM_V2 - s_mig), s_mig * S_MAX_DAMM_V2)
    return v, sold + base_mig, l


def band_prediction_vectors() -> list[tuple[str, int, int, int]]:
    """(name, V, S, L) at both rule-4 band ends for every compiled class (D-017)."""
    out = []
    for c in json.loads(CLASSES_JSON.read_text())["classes"]:
        curve = [(int(p["sqrtPrice"]), int(p["liquidity"])) for p in c["curve"]]
        last = curve[-1][0]
        for end, s_mig in (("band_lo", last - MIGRATION_PRICE_TOLERANCE), ("band_hi", last)):
            v, s_supply, l = prediction_inputs(int(c["migrationQuoteThreshold"]),
                                               int(c["sqrtStartPrice"]), curve, s_mig)
            out.append((f"{c['name']}_{end}", v, s_supply, l))
    return out


def selftest() -> int:
    """Check every §27 vector. Returns the number of failures."""
    failures = 0
    print(f"{'case':<32} {'expected s':>24} {'computed s':>24}  verdict")
    print("-" * 110)
    for name, v, s_supply, l, expected in SPEC_VECTORS:
        try:
            got = floor_sqrt_q64(v, s_supply, l)
        except FloorError as exc:
            print(f"{name:<32} {expected:>24} {'ERROR':>24}  FAIL ({exc})")
            failures += 1
            continue
        ok = got == expected
        if not ok:
            failures += 1
        print(f"{name:<32} {expected:>24} {got:>24}  "
              f"{'ok' if ok else f'FAIL (delta {got - expected:+d})'}")

    print("-" * 110)

    # The defining property, independent of the expected values above.
    print("\nresidual check  P(s) <= 0 < P(s+1):")
    for name, v, s_supply, l, _ in SPEC_VECTORS:
        s = floor_sqrt_q64(v, s_supply, l)
        a, b, c = coefficients(v, s_supply, l, S_MAX_DAMM_V2)
        lo, hi = residual(a, b, c, s), residual(a, b, c, s + 1)
        ok = lo <= 0 < hi
        if not ok:
            failures += 1
        print(f"  {name:<32} {'ok' if ok else 'FAIL'}  P(s)={lo!s:.30}... P(s+1)={hi!s:.30}...")

    # §27: "Redeem 1M tokens pays" for the two launch classes, at the 0.5% redemption fee.
    print("\nredeem 1M tokens at 0.5% (§27):")
    for name, expected_payout in (("proof", 6_668_408), ("public", 16_671_021)):
        v, s_supply, l = next((x[1], x[2], x[3]) for x in SPEC_VECTORS if x[0] == name)
        s = floor_sqrt_q64(v, s_supply, l)
        got = redeem_payout(1_000_000 * 10**6, s, 50)
        ok = got == expected_payout
        if not ok:
            failures += 1
        print(f"  {name:<32} expected {expected_payout:>12}  got {got:>12}  "
              f"{'ok' if ok else 'FAIL'}")

    print(f"\n{len(SPEC_VECTORS)} vectors, {failures} failure(s)")
    return failures


# ---------------------------------------------------------------------------
# vectors.json
# ---------------------------------------------------------------------------


def emit(n_random: int, seed: int = 20261002) -> dict:
    """Every §27 vector plus n_random cases, for the Rust/WASM differential test (§11)."""
    rng = random.Random(seed)
    cases = []

    for name, v, s_supply, l, expected in SPEC_VECTORS:
        s = floor_sqrt_q64(v, s_supply, l)
        assert s == expected, f"{name}: reference disagrees with §27 ({s} != {expected})"
        cases.append({
            "name": name, "kind": "spec",
            "v": str(v), "s_supply": str(s_supply), "l": str(l),
            "s_max": str(S_MAX_DAMM_V2), "s": str(s),
        })

    # D-017: the §7 prediction at both ends of the rule-4 band; the compiler pins the lowest s.
    for name, v, s_supply, l in band_prediction_vectors():
        cases.append({
            "name": name, "kind": "prediction",
            "v": str(v), "s_supply": str(s_supply), "l": str(l),
            "s_max": str(S_MAX_DAMM_V2), "s": str(floor_sqrt_q64(v, s_supply, l)),
        })

    # Random cases spread over the whole legal input space, including the edges.
    for i in range(n_random):
        bucket = i % 5
        if bucket == 0:        # launch-scale, the range that actually matters
            v = rng.randrange(10**7, 10**11)
            s_supply = rng.randrange(10**14, 10**15)
            l = rng.randrange(10**28, 10**32)
        elif bucket == 1:      # vault-only
            v = rng.randrange(1, VAULT_BOUND)
            s_supply = rng.randrange(1, SUPPLY_BOUND)
            l = 0
        elif bucket == 2:      # pool-only
            v = 0
            s_supply = rng.randrange(1, SUPPLY_BOUND)
            l = rng.randrange(1, L_BOUND)
        elif bucket == 3:      # extremes of every axis
            v = rng.choice([0, 1, VAULT_BOUND, rng.randrange(0, VAULT_BOUND)])
            s_supply = rng.choice([1, SUPPLY_BOUND, rng.randrange(1, SUPPLY_BOUND)])
            l = rng.choice([0, 1, L_BOUND, rng.randrange(0, L_BOUND)])
        else:                  # uniform over the full legal box
            v = rng.randrange(0, VAULT_BOUND + 1)
            s_supply = rng.randrange(1, SUPPLY_BOUND + 1)
            l = rng.randrange(0, L_BOUND + 1)

        s = floor_sqrt_q64(v, s_supply, l)
        cases.append({
            "name": f"random_{i:05d}", "kind": "random",
            "v": str(v), "s_supply": str(s_supply), "l": str(l),
            "s_max": str(S_MAX_DAMM_V2), "s": str(s),
        })

    return {
        "_comment": ("Generated by tests/reference/floor.py from BUILD_SPEC.md §4/§27. "
                     "Rust, WASM and Python must produce identical s for every case (§11). "
                     "All integers are strings: s and l exceed IEEE-754 exact range."),
        "s_max_damm_v2": str(S_MAX_DAMM_V2),
        "seed": seed,
        "spec_count": len(SPEC_VECTORS),
        "random_count": n_random,
        "cases": cases,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--emit", type=int, metavar="N",
                    help="write vectors.json with N random cases to stdout")
    ap.add_argument("--seed", type=int, default=20261002)
    args = ap.parse_args()

    if args.emit is not None:
        json.dump(emit(args.emit, args.seed), sys.stdout, indent=1)
        sys.stdout.write("\n")
        return 0

    return 1 if selftest() else 0


if __name__ == "__main__":
    sys.exit(main())
