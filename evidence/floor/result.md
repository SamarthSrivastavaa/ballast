# Floor engine — §4 / §11 / §27 verification

**Verdict: PASS.** Ran 2 Oct 2026 at commit `a727dc1`+working-tree, Rust 1.85.0, Python 3.11.9.
No network involved — this is pure integer math (§33: "the floor crate needs no network, do it first").

This is not a §18 devnet gate; it is the differential and property evidence §11 and §14 require
before the floor crate may be linked into anything.

## What was run

```bash
python tests/reference/floor.py                                  # §27 self-test
python tests/reference/floor.py --emit 10000 > crates/floor/vectors.json
cargo test -p ballast-floor                                      # 25 tests
PROPTEST_CASES=100000 cargo test -p ballast-floor --test properties   # §14 gate
cargo fmt --all --check && cargo clippy --all-targets -- -D warnings
```

## §27 vectors — Rust and Python agree exactly on all 10

| Case | V (lamports) | S (base units) | expected s | computed s |
|---|---|---|---|---|
| proof | 1,500,000,000 | 865,440,991,257,550 | 47,755,047,807,748,143 | match |
| public | 3,750,000,000 | 865,440,991,257,550 | 75,507,360,421,341,854 | match |
| public_harvest_0.1_sol | 3,850,000,000 | 865,440,991,257,550 | 75,919,307,215,186,886 | match |
| public_deposit_1_sol | 4,750,000,000 | 865,440,991,257,550 | 79,478,727,226,182,304 | match |
| public_redeem_50m | 2,916,448,923 | 815,440,991,257,550 | 75,526,438,275,666,392 | match |
| public_bid_fill_100m | 2,076,195,928 | 765,440,991,257,550 | 75,515,850,660,144,827 | match |
| tiny | 1,000,000 | 10^12 | 18,446,744,123,700,328 | match |
| max_supply_1000_sol_l_2_120 | 10^12 | 10^15 | 1,329,228,229,483,701,708,696 | match |
| vault_only_l_zero | 10^9 | 10^14 | 58,333,726,687,135,158 | match |
| pool_only_v_zero | 0 | 10^14 | 9,999,999,999,998,700 | match |

Redeem 1M tokens at the 0.5% fee (§27): Proof **6,668,408** lamports, Public **16,671,021** — both exact.

Each vector additionally satisfies the defining property `P(s) ≤ 0 < P(s+1)`, checked independently
of the expected values above, so a reference and an implementation that were wrong in the same way
would still be caught.

## Differential test (§11)

`crates/floor/vectors.json` — 10,010 cases (10 from §27 + 10,000 random, seed 20261002), 2,370,275
bytes, sha256 `eee2f16970ae30f85617408e8ca991c810ca796d5b4dd050980f47f4c3fe8e8e`.

Random cases are spread across five buckets: launch-scale, vault-only (L = 0), pool-only (V = 0),
per-axis extremes, and uniform over the full legal box.

**Rust reproduces Python's `s` on all 10,010.** CI also regenerates the file and requires it to be
byte-identical to the committed copy, so the differential test cannot silently compare against a
stale or hand-edited reference. The WASM leg of the same comparison lands with the floor-wasm slice.

## §14 property gate — 100,000 cases each, zero failures (16.7 s)

| Property | §14 / §4 origin |
|---|---|
| `root_is_the_exact_floor` | `P(s) ≤ 0 < P(s+1)` |
| `monotone_in_v` | harvest / deposit rows |
| `antitone_in_s` | supply increase |
| `monotone_in_l_within_a_ceiling_step` | see finding F2 below |
| `payout_le_exact` | payout floored, subadditive under splitting (§12 rounding extraction) |
| `redeem_never_lowers_f` | §4 redeem row — the central invariant |
| `bid_fill_never_lowers_f` | §4 bid-fill row, filled at exactly F (worst allowed case) |
| `burn_never_lowers_f` | §4 leftover / filled-base burn rows |
| `narrower_range_never_raises_f` | §1 correction 1 (bounded range) |
| `out_of_range_is_always_an_error` | §4 bounds return errors, never values |
| `ceiling_step_can_lower_f` | pins finding F2's counterexample |

## Findings

Two spec-internal inconsistencies, both recorded in `DECISIONS.md` and **both pending approval**:

- **F1 (§4 vs §27):** §4 bounds say `L < 2^120`; §27's boundary vector uses `L = 2^120` exactly.
  Read as inclusive — overflow-safe (`B² = 2^240 < 2^256`) and it keeps a published vector computable.
- **F2 (§4 vs §14):** §14's unconditional "monotone in L" is false for §4's `⌈L/s_max⌉` rounding at a
  ceiling boundary. Counterexample found by proptest: `V = u64::MAX, S = 1, L = 0 → 1` lowers F.
  No impact on the mechanism — §4 lists an L change as "Impossible (permanent lock)", and rounding A
  up always understates F, the safe direction.

## Reproduce

```bash
git checkout <this commit>
python tests/reference/floor.py
cargo test -p ballast-floor
PROPTEST_CASES=100000 cargo test -p ballast-floor --test properties
```
