# Ballast — Decisions & Evidence Log

The record of every Top-20 answer, every toolchain pin, and every deviation from the spec.

**Rules for this file**
- A question is **VERIFIED** only with a transaction signature on the **mainnet-binary local
  validator** (D-001) recorded here and a JSON account dump in `evidence/`. Those results are
  authoritative. Devnet signatures are secondary cross-checks (and the only evidence for Q17); on any
  divergence the mainnet-binary result governs and the divergence is recorded. Docs, SDK source, and
  the `meteora-researcher` agent produce **LEADS**, never verifications.
  *(Amended 2 Oct 2026 by D-001; was "a devnet (or mainnet) transaction signature".)*
- **Q10 exception** (Jupiter routing, mainnet-only, no transaction of ours to sign): VERIFIED by Jupiter
  quote-API responses for the live pool and pair, saved as timestamped JSON in `evidence/`, that name
  the DLMM pair or DAMM v2 pool in the route. Plus a mainnet swap signature if the owner approves one
  (D-007). *(Added 2 Oct 2026 after the STEP 2 audit.)*
- Status values: `UNKNOWN` · `LEAD` (doc/source evidence only) · `VERIFIED` · `FAILED → fallback taken`.
- If observed on-chain behaviour contradicts `docs/spec/BUILD_SPEC.md`: record the evidence here, propose
  the minimum correction, **stop and wait for approval**. Never silently adopt a fallback.
- Append, never rewrite history. Supersede an entry with a dated note.

---

## Top 20 implementation-blocking questions

P0 = could invalidate the mechanism · P1 = could invalidate a subsystem · P2 = implementation detail.
**Nothing beyond a CPI test harness is built until Q1–Q5 pass.**

| # | Pri | Question | Expected | Status | Evidence (signature / dump / file:line) | Answer & fallback taken |
|---|---|---|---|---|---|---|
| 1 | **P0** | Does one `migration_damm_v2` tx leave partner and creator positions with all liquidity in `permanent_locked_liquidity` (unlocked = 0, vested = 0)? | Atomic, fully permanent | VERIFIED | `25wGvzzW…uQbnQ` (migration, slot 91); `evidence/p0/Q1/` | Atomic, fully permanent: both positions unlocked 0, vested 0, permanent 1.5351e31 each, read in the migration slot; inner ixs show pool creation + both permanent locks in one tx |
| 2 | **P0** | Is the migrated pool `collect_fee_mode = 1` (OnlyB), non-compounding, full range (`sqrt_min_price` = MIN, `sqrt_max_price` = MAX), and do swaps and fee claims leave `pool.liquidity` and position liquidity unchanged? | All unchanged; full range | **FAILED as specified → corrected by D-010; re-run pending** | `evidence/p0/Q2/result.json`, `Q2/characterization-quote-fee-mode.json` (`EnFm9JEm…Gznyq`) | §7's DBC value 1 = DBC OutputToken → DAMM BothToken (0). Constant L, full range, non-compounding all PASS. DBC value 0 (QuoteToken) → DAMM OnlyB (1), quote-only fees, L constant. See § OPEN DECISION Q2 |
| 3 | **P0** | Does pool state satisfy `amount_A = L·(s_max − s)/(s·s_max)` and `amount_B = L·(s − s_min)/2^128` with Q64 sqrt prices? | Equal within ≤ 2 base units | VERIFIED | `evidence/p0/Q3/result.json` | At migration token_a/b_amount = formula +2/+1 (≤ 2). After 40 swaps +13/+10: rounding accrues to the pool |
| 4 | **P0** | Can a Ballast PDA, as `fee_claimer`, CPI `withdraw_migration_fee` (partner), `claim_trading_fee`, `partner_withdraw_surplus`? What destination accounts are allowed? | Works; destinations are token accounts owned by the fee claimer | VERIFIED | `5nynW8so…zsjy6t` (withdraw_migration_fee pre-migration), `4H13Pbob…243ZtR` (claim_trading_fee), `3jwXnZZC…1Vm` (partner_withdraw_surplus), `4gba6qqd…mnBr` (claim_position_fee); `evidence/p0/Q4/` | All four work with the PDA signing via CPI. withdraw_migration_fee works BEFORE migration. claim_trading_fee and partner_withdraw_surplus accept a destination NOT owned by the fee claimer (vault PDA's ATA) |
| 5 | **P0** | Can the PDA CPI DLMM `place_limit_order` (sender = owner = PDA, fresh keypair order account signing from the outer tx) and `cancel_limit_order`? Do fills stay filled? Does cancel return unfilled quote + filled base + fees? | Yes on all counts | **VERIFIED** | place `5Uq5bU4t…tv6QX` (37,463 CU); seller fill `…` (76,550 CU); cancel `35Ndh9HH…Ve7M` (56,884 CU); `evidence/p0/Q5/result.json` | **Yes on all counts.** PDA as sender = owner = payer via CPI, fresh keypair order account signing the outer tx: place works. A seller swapping X→Y fills part of the bid; `fillsPersist: true` (a reverse swap cannot take the filled base back). Cancel returns filled base **and** unfilled quote **and** fees, exactly: receivedX 49,999,999,955,102 base units = the swapped amount; receivedY 665,419,702 = unfilled 665,214,646 + fees 205,056. Order account closed. **New finding:** cancel accepts a destination **not** owned by the order owner (sent to the vault PDA's accounts, no error) — same latitude Q4 found for the DBC claims |
| 6 | P1 | Who owns the partner position NFT after migration (`fee_claimer`?), and can the PDA call `claim_position_fee` on it? | Owner = fee claimer | VERIFIED | `evidence/p0/Q1/result.json` (q6Holders), `Q2/result.json` | Partner NFT → fee_claimer (partner_auth); creator NFT → creator_auth. Both PDAs claimed position fees via CPI |
| 7 | P1 | Can the creator `split_position` (or otherwise move) permanently locked liquidity into new positions? | Likely yes (owner-only endpoint) | UNKNOWN | | |
| 8 | P1 | DLMM customizable permissionless pair: seeds, uniqueness, creator/operator powers (pool status); can the PDA create it via CPI? | Pair unique per (mints, bin step); no post-activation creator powers | **VERIFIED — expectation wrong in two ways** | create `2SFhMVRh…kumh` (pair `3ce2fz6z…ErrK`, by `partner_auth` via CPI); `evidence/p0/Q8/` | PDA creates it via CPI: **yes**. **(i) Seeds are `[ILM_BASE, min(mintX,mintY), max(mintX,mintY)]` — no bin step**, so there is exactly ONE pair per mint pair, not one per (mints, bin step); a second pair at bin step 25 was refused. The bin step must be right first time. **(ii) The funder must already hold ≥ 1 base unit** or DLMM refuses with `6060 MissingTokenAmountAsTokenLaunchProof` (tested 0 → refused, 1 → accepted) — see § OPEN QUESTION Q8-funding, which affects `register_launch`. Creator powers: `set_pair_status_permissionless` refused `6043 InvalidPoolType` with `creator_pool_on_off_control = 0`, so **no post-activation creator powers** as hoped; `set_pair_status` needs a Meteora `operator` signer |
| 9 | P1 | DLMM limits: allowed bin steps and base fee, activation, collect-fee mode, minimum order size, ≤ 50 bins, bitmap-extension needs around bin ids −11,000 to −12,000 | Feasible with bitmap extension | **VERIFIED** | `evidence/p0/Q9/pair-scans.json`, `Q9/order-limits.json` | **Feasible.** Bin steps 1, 2, 4, 5, 8, 10, 16, 20, 25, 50 all accepted for a customizable LimitOrder pair; §9's 10 bps works. Order limits probed by simulation at the §27 Proof bid bin −11,920 (minimum size, 50 vs 51 bins, ascending vs descending) — see `order-limits.json`. **Cost finding for §26:** `initialize_bin_array` for the bid bin costs **≈ 199,000 CU** on its own, which `open` must budget for (§26 allows 600k) |
| 10 | P1 | Does Jupiter route to the fresh DLMM pair and DAMM v2 pool, and how fast? | Within hours | UNKNOWN | | *Mainnet-only — Jupiter does not route on devnet (§18)* |
| 11 | P1 | Is the DBC base mint's freeze authority `None`? | None | VERIFIED | `evidence/p0/Q11/result.json` | Freeze authority None; mint authority None; supply 10^15 |
| 12 | P1 | Exact `PoolConfig` / `VirtualPool` layouts for the deployed DBC version; enum encodings (`migration_fee_option` customizable, `collect_fee_mode`, `token_type`) | Match | VERIFIED | `4WRdaMmy…zGA6` (create_config); `evidence/p0/Q12/`; `cargo test -p meteora-types` | PoolConfig: owner DBC, disc 1a6c0e7b74e6812b, 1,048 B, version 0, all fields as sent; vendored = SDK on PoolConfig (167 fields), VirtualPool (60), DAMM Pool (307), Position (174). Enum finding: DBC migrated collect-fee enum ≠ DAMM enum (see Q2) |
| 13 | P1 | Fee semantics: flat 1% encoding, dynamic fee off, `creator_trading_fee_percentage`, protocol and referral cuts; partner claim = partner share exactly | Matches docs | VERIFIED | `evidence/p0/Q13/result.json` | fee = ⌈1%⌉ of consumed; protocol 20% of fee; partner = creator = 40%; partner claim = partner share exactly; dynamic fee off |
| 14 | P1 | Migration accounting: fee on threshold or reserve? How is the 0.2% protocol liquidity share taken? Exact Q_d, B_m, L_total vs L_perm | Protocol remainder is an unlocked position, excluded from L | LEAD → mostly VERIFIED | `evidence/p0/Q14/`, `Q1/result.json` | Protocol share = 0.2% in TOKENS (quote 17,000,000; base 654,409,983,148), not an LP position ⇒ L_total = L_perm. Q_d 8,483,000,000; B_m 326,550,581,591,072. Realised L ≥ §27 predicted. Open: fee basis threshold vs reserve |
| 15 | P1 | Overshoot: can the completing swap exceed the threshold; when is partner surplus withdrawable; `swap2` partial-fill behaviour | Surplus exists; withdrawable after completion | LEAD → mostly VERIFIED | `evidence/p0/Q15/result.json` | §7 curve: ExactIn overshoot reverts 6033; swap2 PartialFill completes to threshold+1 and refunds the rest; later buy reverts 6013. Open: overshoot on a curve with capacity past the threshold |
| 16 | P2 | Is `withdraw_leftover` permissionless, to `leftover_receiver`'s token account, only after `CreatedPool`? | Yes | VERIFIED | `evidence/p0/Q16/` | Refused before migration (6022). After: permissionless (third wallet); destination must be owned by leftover_receiver (2015 otherwise); paid 134,558,940,128,194 |
| 17 | P2 | Meteora keeper latency for 10 SOL pools; manual migration via SDK | Seconds to minutes | UNKNOWN | | |
| 18 | P2 | Compute units and accounts for `open` and an atomic `redeem` (cancel + burn + pay + re-place) | < 1.4M CU with a lookup table | UNKNOWN | | |
| 19 | P2 | Meteora admin powers: DAMM v2 `update_pool_fees`, pool status, DLMM pool status, upgrade authorities | Fees and status adjustable by operators; locked liquidity untouchable | UNKNOWN | | |
| 20 | P2 | WSOL handling across DBC, DAMM v2 and DLMM (SPL WSOL only; Token-2022 WSOL rejected) | SPL WSOL everywhere | UNKNOWN | | |

### Fallbacks, verbatim from the spec — never improvise a different one

| # | Fallback if the expected answer is wrong |
|---|---|
| 1 | Make Ballast's PDA the DBC pool creator before trade 1 (Q7), so no third party ever owns an unlocked position; lock in `open` if needed |
| 2 | If a range: the engine already takes `sqrt_min/max` as inputs. If compounding is forced: switch to reserve-based absorption (§4) |
| 3 | Use reserves directly: absorption to F = `x_now + L·(1/√F − 1/√P_now)`, computed from read reserves |
| 4 | Disclosed hot-wallet fee claimer that forwards in the same transaction |
| 5 | Redemption-only floor; DLMM marked unverified in the submission (**major regression; escalate to Meteora**) |
| 6 | Floor math unaffected; ratchet off |
| 7 | **Default already adopted:** transfer the DBC pool-creator role to a Ballast creator PDA at registration, so both positions are PDA-owned; forward creator income |
| 8 | Create the pair in the same transaction as the DBC pool; accept any pair passing parameter checks |
| 9 | Larger bin step (25 bps) |
| 10 | Demo shows direct DLMM swaps and redemption |
| 11 | Document as Meteora trust |
| 12 | Validate by hash of canonical bytes |
| 13 | Adjust ledger |
| 14 | Prediction stays a lower bound with margin |
| 15 | Ignore surplus in prediction (it only raises F) |
| 16 | Keeper calls it |
| 17 | Ballast keeper migrates |
| 18 | Split into `redeem` + `refresh_floor` with a minimum size |
| 19 | Disclose |
| 20 | — |

---

## ~~OPEN DECISION~~ — §7 rule 4: `migration_sqrt_price` vs the last curve point

*RESOLVED 6 Oct 2026 by D-017 (band + capacity, tolerance measured). Kept as history; the
"D-015" marker proposed below was never assigned — the spec carries `[D-017]`.*

**Raised 4 Oct 2026. Implemented provisionally in `programs/ballast/src/lib.rs` (`create_class`),
which cites this entry. Not exercisable yet:** every class is `ClassNotPinned` until the compiler
pins `sqrt_start_price` and `config_hash`.

§7 rule 4 says `migration_sqrt_price` **equals** the last curve point. On the mainnet binaries it
cannot. Segment liquidity must round **up** so the curve can absorb the whole threshold, which
leaves DBC's derived `migration_sqrt_price` slightly **below** the last point: 4,580,459 low in
9.4·10¹⁶, relative 5·10⁻¹¹ (`evidence/p0/Q12/result.json`; `evidence/p0/REPORT.md` finding 1).

**Proposed amendment (provisional in code):** replace equality with two checks.

1. **A two-sided band:** `last_point − 2^24 ≤ migration_sqrt_price ≤ last_point`
   (`canon::MIGRATION_PRICE_TOLERANCE = 2^24`, about 3.7× the measured shortfall). It is
   deliberately not one-sided. `migration_sqrt_price` is **not** in the rule-3 hash, so an open
   `≤` would let two materially different configs hash identically, and `predicted_s_open` would
   no longer provably belong to the validated config.
2. **Capacity:** the curve's capacity, `Σ ⌊L_i·(s_i − s_{i−1})/2^128⌋` rounded down, must be
   `≥ migration_quote_threshold` (`curve::capacity`, `ConfigCurveCapacityTooSmall`).

**Alternative:** keep exact equality, and have the compiler solve for segment liquidities that make
DBC's derived price land exactly on the last point. That needs DBC's exact rounding vendored, and
it is fragile across DBC upgrades.

**Recommendation:** approve the band + capacity form. Then mark §7 rule 4 with a `[D-015]`
amendment marker and add a negative test for each side of the band.

## ~~OPEN DECISION~~ — DLMM refuses a bid above the pair's active bin (raised 7 Oct 2026, Part 2)

*RESOLVED 7 Oct 2026 by D-020 (owner chose option A). Kept as the evidence behind D-020.*
Evidence: `evidence/program/part2/dlmm-active-bin.json` (wallet-level, top-level SDK transactions on
the mainnet DLMM binary), `evidence/program/part2/results.json`.

**Observed (mainnet binary):**

| Experiment (pair active_id = −12,645) | Result |
|---|---|
| bid at active − 1 / at active | accepted (`3iccXU3L…`, `3Xnp6dwh…`) |
| bid at active + 1; bid at the floor bin −11,920 | **refused `6105 InvalidPlaceLimitOrderParameters`** (`21QpQGt8…`, `5eFzgTL4…`) — `place_limit_order.rs:133` |
| `go_to_a_bin` up while any order sits in the range, the active bin included | **refused `6056 BinRangeIsNotEmpty`** (`2apj5mU6…`) |
| `go_to_a_bin` down across a resting bid | refused `6056` (`5u2RGbpj…`) — a resting bid protects itself |
| `go_to_a_bin(F's bin)` on an empty range, **no signer** | accepted, 7034 CU (`2MaQnm5q…`) |
| then Ballast `open` at F's bin | **passes every check**: bid from the vault via CPI (U1), vendored price = DLMM's stored bin price (U4), s_open = Python reference, realised/predicted = 1.0067, **147,138 CU** (`7chdrQDx…`) |

**Why it bites:** a bid may sit only at or below the pair's active bin. The D-011 launch
transaction creates the pair with active_id at the DBC start price p0 (bin −12,645), and F's bin is
≈ −11,920 — 725 bins higher. Q5 never saw this because its pair was created at the DAMM price, above
F. After launch, sells move the active bin down into the bid; F then rises, so every later re-place
can again be "above active". `go_to_a_bin` fixes it permissionlessly — unless **anyone** parks an
order (even dust) at or above the active bin below the target, which pins the active bin until a
seller fills that order.

**Proposed minimum correction (A, recommended):** before every placement (`open`, `refresh_floor`,
`redeem`), if `pair.active_id < target`, Ballast CPIs `go_to_a_bin(target)` (permissionless, ≈ 7k
CU, two optional bin-array accounts). If DLMM refuses because a third-party order sits in the range,
place at `min(target, active_id)` — still a bid **at or below F** (rounding toward the protocol
holds), but possibly below F's bin while that order stands; any seller clears it by filling it.
§9's check becomes "bin = min(highest bin ≤ F, the active bin after the attempted move)", and the
condition is emitted and shown. Redemption at F is unaffected. Disclosure: "the executable bid can
sit below F's bin while a third-party order pins the DLMM active bin."

**Alternative (B):** fail closed — if the move is refused, `open`/`refresh_floor` revert; `redeem`
still pays and leaves the vault unplaced (V still counts it). Griefing then freezes the DLMM leg
until someone sells into the blocking order.

Not proposed: changing the pair's initial active_id in the D-011 launch transaction. Anyone can move
an empty pair's active bin with `go_to_a_bin` before `open`, so the launch-time value protects nothing.

## OPEN QUESTION Q8-funding — RESOLVED by D-011 (option C), 4 Oct 2026

*Kept as the reasoning behind D-011.* **Found 4 Oct 2026 by STEP 3 (Q8).**

DLMM refuses `initialize_customizable_permissionless_lb_pair` unless the **funder already holds at
least 1 base unit** of the token: `6060 MissingTokenAmountAsTokenLaunchProof`
(`initialize_customizable_permissionless_lb_pair.rs:284`). Measured: balance 0 → refused,
balance 1 → accepted (`evidence/p0/Q8/result.json`, `funderMustHoldBaseToken`).

§6 `register_launch` and §9 both say the pair is created **in the same transaction** as DBC pool
creation and registration. At that moment `virtual_pool.quote_reserve == 0`, no trade has happened,
and the entire fixed supply sits in the DBC pool's base vault — so `partner_auth` holds **zero**
base and the pair creation reverts. Q8 only succeeded in the harness because that step runs against
the already-graduated token, where the PDA had base on hand.

The spec's own Q8 fallback ("create the pair in the same transaction as the DBC pool; accept any
pair passing parameter checks") does not address this, so it is not a usable fallback here.

Options, none yet chosen:

| | Option | Cost |
|---|---|---|
| A | The launching creator seeds 1 base unit to `partner_auth` inside the registration transaction | Needs base before the curve has sold any. DBC mints the whole supply to its vault at pool creation, so there may be no source — **verify** whether the creator can hold any base at that point. |
| B | Create the pair later, in `open` (after `burn_leftover`, when `partner_auth` has held leftover base) | Loses §9's "pair exists before trade 1" property and the front-running protection §26 cites; `open` gets bigger. Note leftover is *burned*, so the 1 unit must be retained deliberately. |
| C | Create the pair at registration from a 1-unit balance the **payer** holds, with the payer as funder, then rely on the pair being permissionless | Changes who the pair creator is; Q8 shows the creator has no post-activation powers (`6043`), so this may cost nothing — **the cheapest option if it holds**. |

Recommendation: test C first (it is a harness change, not a design change), then A. B is the fallback.

---

## §18 Gates

Run first on the mainnet-binary local validator (D-001, authoritative), then on devnet (public
evidence, secondary). The heading was "§18 Devnet gates" until 2 Oct 2026.

| Gate | Phase | Pass criterion | Status | Tag | Evidence |
|---|---|---|---|---|---|
| 1 | Config validation | Byte-identical decode; class created; each single-field mutation rejected by its rule | NOT RUN | | |
| 2 | Graduation and migration | States advance; migration fee lands in vault to the lamport | NOT RUN | | |
| 3 | **P0** Permanent lock | Both positions fully permanent and PDA-owned; L mapping within 2 units; L unchanged after swaps | NOT RUN | | |
| 4 | Vault funding | Exact SOL and token conservation against the §10 ledger | NOT RUN | | |
| 5 | **P0** DLMM bid | Fills persist; cancel returns unfilled + filled + fees | NOT RUN | | |
| 6 | F | Identical s across `floor()`, Rust, WASM, Python; realised ≥ predicted | NOT RUN | | |
| 7 | Redemption | Exact payout; F rises; CU within limit (else two-step redeem) | NOT RUN | | |
| 8 | Full sell-out | Lowest execution ≥ 0.99·F; vault ≈ 0; F not lower | NOT RUN | | |
| 9 | Invariant run | 200 random txs, no monotone-check failure; verifier PASS | NOT RUN | | |
| 10 | Failure injection | All fail safe as in §26 | NOT RUN | | |

---

## Toolchain

**Status: DECIDED 2 Oct 2026 (STEP 2): the §16 pins stay.** Both STEP 2 tests passed. TEST 1: the
mainnet Meteora binaries execute on Agave 2.1.21. TEST 2: lockfile pins → `anchor build`,
`anchor test` and `cargo build-sbf` under platform-tools v1.43. Evidence:
`evidence/step-1a/step2-decision.md`; earlier pin evidence: `evidence/step-1a/result.md`.

### STEP 2 decision — keep §16; fix the edition-2024 blocker in the lockfile

The owner authorised applying this rule: *both tests pass → keep the §16 pins; either fails → the
oldest Agave + platform-tools + Anchor combination that executes the mainnet Meteora binaries,
passes anchor build/test, and builds `crates/floor` for SBF.* Both passed, so nothing moved.

| Test | Result | Key evidence |
|---|---|---|
| TEST 1 — mainnet binaries execute | **PASS 27/27** | `fixtures:dump` → `evidence/fixtures/mainnet-pins.json`; `solana program dump` byte-identical; DBC `create_partner_metadata` ✓ (`4Tz5Fj9i6P8bnVSYYJ1mzzXzBrmLjJBZMvmtZGYPYqnYzyeUcU6cM8ykDskrBdQauY8ZWTLKJrkuAFZQuz94Z6XV`) and Token Metadata `CreateMetadataAccountV3` ✓ (`3tLDU7JrcsioezAG8nNLcjfirNZR792LXU2mc68R8g2CpPfNV17QbMSQ9kRXf3gsH4rMi3xnHKqEdTsG4u6KfVZo`); served bytes measured = pins; 21 dispatch probes present; 4 negative controls absent |
| TEST 2 — lockfile pins | **PASS** | lock: 185 packages, 0 edition-2024, 0 MSRV > 1.79; `anchor build` ✓ (218,568 B); `anchor test` ✓ (§27 Public vector on-chain, 19,572 CU); `floor-sbf` `cargo build-sbf` ✓ (46,784 B) |

**The lockfile method, required for every SBF workspace, `programs/ballast` included:**

1. Each SBF crate declares `rust-version = "1.79"` (Finding T1).
2. `.cargo/config.toml`: `[resolver] incompatible-rust-versions = "fallback"`. Host cargo 1.85
   uses it; cargo 1.79 ignores it. Do **not** use `resolver = "3"`: cargo 1.79 rejects it.
3. Generate `Cargo.lock` with host cargo 1.85, then `cargo update --precise`: `solana-program
   2.1.21`, `blake3 1.5.5` (1.8.7 is edition 2024 with no declared MSRV), and every `anchor-*` to
   `0.31.1` (`anchor-lang`'s internal carets drift 10 sub-crates to 0.31.2).
4. `python3 scripts/toolchain/check_lock.py <workspace>` must report 0 problems. CI runs it.

Findings logged by STEP 2:

- **T2:** the "unpinnable" `toml_datetime` chain was wrong. MSRV-aware resolution selects
  `proc-macro-crate 3.4.0 → toml_edit 0.23.10 → toml_datetime 0.7.5`, all edition 2021.
- **T3:** `anchor-lang = "=0.31.1"` does not pin Anchor. Its sub-crates resolved to 0.31.2.
  Only the lockfile pins them.
- **T4:** DAMM v2 `swap` takes a pre-Anchor fast path (45 CU, no log). Input to Q18.
- **T5 (risk):** the Anchor baseline is about 210 KB of D-007's 300 KB target. The probe is
  211,312 B even at `opt-level = "z"`, which saves only 3%.
- **T6 (risk):** local CU figures come from Agave 2.1.21's cost model with its own feature set.
  Mainnet runs a newer Agave. Cross-check Q18 CU against mainnet `simulateTransaction` or devnet.
- **T7:** the DLMM SDK's `LBCLMM_PROGRAM_IDS.localhost` is `LbVRzDTvBDEcrthxfZ4RL6yiq3uZw8bS6MwtdY6UhFQ`,
  **not** mainnet DLMM. On the mainnet-binary validator, always pass the mainnet ID explicitly.
- **T8:** `solana-test-validator` writes `--upgradeable-program … none` as `Some(Pubkey::default())`,
  not `None` (Token Metadata). Still non-upgradeable, but not byte-identical to mainnet's header.

**Audit of STEP 2 (`/audit`, 2 Oct): 0 critical, 1 high, 10 medium, 1 wording. All fixed. A
re-audit confirmed the fixes and raised 9 more mediums (2 code gaps, 7 doc/evidence), also fixed.
Every guard has a negative test in `scripts/fixtures/negative-tests.sh` (14/14 refused,
`evidence/step-1a/hardening.txt`).**
`fixtures:exec` measures the bytes the validator serves and refuses non-loopback or mainnet RPCs.
`pnpm localnet` checks online and accepts only harmless flags. `fixtures:dump` refuses drift
without `--accept-drift` and asserts the mainnet genesis. `fixtures:check` cross-checks IDs
against the SDK constants and every account field. Evidence logs are no longer gitignored. The
RPC host only is recorded. The CI wording gate catches the curly apostrophe. The Q10 carve-out
and the `L ≤ 2^120` fix in `CLAUDE.md` are in.

| Tool | §16 pin | **Final pin, proven** | Evidence |
|---|---|---|---|
| Rust (host) | 1.84 → 1.85.0 (D-002) | `rustc 1.85.0 (4d91de4e4 2025-02-17)` | `rust-toolchain.toml`; 31 tests green |
| Cargo (host) | — | `cargo 1.85.0 (d73d2caf9 2024-12-31)` | — |
| Agave / Solana CLI | 2.1.x | **`solana-cli 2.1.21`** (`src:8a085eeb`, client:Agave) | newest 2.1 line whose installer still responds; latest overall is v4.3.0 |
| Anchor CLI | 0.31.1 | **`anchor-cli 0.31.1`** via `avm 0.31.1` | `anchor --version` |
| Node | 20 LTS | **`v20.20.2`** via nvm | — |
| pnpm | 9 | **`9.15.4`** via corepack | — |
| wasm-pack | required | **`0.13.1`**, prebuilt installer | from source it now needs rustc 1.86/1.88 (`icu_*`, `sysinfo`, `time`) — incompatible with the 1.85 pin |
| Python (reference) | — | **`3.14.4`** (Linux) / 3.11.9 (Windows) | `vectors.json` **byte-identical** on both — strong reproducibility result |
| `ruint` | — | **`=1.12.3`** (declares MSRV 1.65) | compiles under platform-tools rustc 1.79.0 |
| `proptest` | §14 | **`=1.5.0`**, dev-only | enforced by `d002_conditions.rs` |
| platform-tools | not pinned by §16 | **v1.43, rustc 1.79.0, cargo 1.79.0** (bundled with Agave 2.1.21) | **kept (STEP 2)**: `anchor build`/`test` pass with the lockfile method above |
| `anchor-lang` + all `anchor-*` sub-crates | 0.31.1 | **`0.31.1`, every sub-crate, pinned in `Cargo.lock`** | `check_lock.py`: 0 problems |
| `solana-program` (in SBF programs) | Agave 2.1.x | **`2.1.21`**, pinned in `Cargo.lock` | `check_lock.py` |
| `@meteora-ag/dynamic-bonding-curve-sdk` | ≥ 1.5.11 | **`1.5.13`** (IDL: DBC 0.2.1) | root `package.json` |
| `@meteora-ag/cp-amm-sdk` | 1.4.8 | **`1.4.8`** (IDL: cp-amm 0.2.4) | root `package.json` |
| `@meteora-ag/dlmm` | 1.9.10 | **`1.9.10`** (IDL: lb_clmm 0.12.0) | root `package.json` |
| `@solana/web3.js` / `@solana/spl-token` / `@coral-xyz/anchor` | 1.98.x / 0.4.x / 0.31.1 | **`1.98.4` / `0.4.13` / `0.31.1`** | root `package.json` |

### Finding T1 — a crate's MSRV is not the host toolchain pin

`cargo build-sbf` initially refused with `ballast-floor@0.1.0 requires rustc 1.85`. That came from
our own `rust-version` in `[workspace.package]`, inherited by `crates/floor` — but `crates/floor` is
compiled **for SBF by platform-tools rustc 1.79.0**, so its MSRV must be low enough for that
compiler. The two values are independent and had been conflated.

`crates/floor` now declares its own `rust-version = "1.79"`; the host pin stays in
`rust-toolchain.toml`. **`programs/ballast` will need the same treatment** — do not let it inherit
the host pin.

### D-002 condition 3 — SATISFIED

Proven in isolation, with a dependency tree of exactly four packages (`ballast-floor`,
`floor-sbf-probe`, `ruint 1.12.3`, `ruint-macro 1.2.1`) so that nothing else could be blamed:

```
platform-tools v1.43, rustc 1.79.0 -> build-sbf exit 0
target/deploy/floor_sbf_probe.so  46,784 bytes
ELF 64-bit LSB shared object, eBPF, version 1 (SYSV)
```

**Condition 4 was not triggered.** `ruint` needs no downgrade.

### ~~OPEN DECISION~~ — platform-tools cannot build the Anchor program tree

*RESOLVED 2 Oct 2026 by STEP 2 (above):* neither option A nor B was needed. The blocker was fixed
in the lockfile; see Finding T2. The text below is kept as history.

**This blocks `anchor build`, `anchor test` and therefore all of STEP 1C and 1D.**

platform-tools v1.43 bundles cargo 1.79.0, which cannot parse `edition = "2024"` manifests. The
Anchor 0.31.1 + Solana 2.1.21 tree now resolves one that cannot be pinned away:

```
anchor-lang 0.31.1 -> solana-program 2.1.21 -> borsh 1.8.1 -> borsh-derive 1.8.1
  -> proc-macro-crate 3.5.0 -> toml_edit 0.25.15 -> toml_datetime 1.1.1   (edition 2024)
```

Two caret drifts were found and fixed on the way (both worth keeping regardless): `anchor-lang` had
resolved to **0.31.2** and `solana-program` to **2.3.0**, off the §16 Agave 2.1.x line entirely.
Pinning `blake3` to 1.5.5 cleared a second offender (`block-buffer 0.12.1`). The remaining link is
unpinnable: `toml_edit 0.25.15` forbids older `toml_datetime`, `borsh-derive 1.8.1` forbids older
`proc-macro-crate`, and `solana-borsh 2.1.21` forbids older `borsh`.

`cargo-build-sbf` does accept `--tools-version <STRING>`. Options, for the owner to choose — D-002
condition 4 forbids changing the toolchain again without asking:

| | Option | Cost |
|---|---|---|
| **A** | `--tools-version <newer>` for the SBF build only | Narrowest. Agave CLI stays 2.1.21 and Anchor stays 0.31.1 exactly as §16 pins them; only the SBF compiler moves. |
| B | Move Agave to a newer line (2.3.x; its platform-tools v2.3.3 is already cached here) | Changes the §16 Agave pin outright and pulls a new `solana-program` into the program, with knock-on effects for `meteora-types` offset tests. |
| C | Keep pinning transitive crates | Dead end, demonstrated above. |

### Probe result (2 Oct 2026) — option A may be closed

`cargo build-sbf --tools-version v1.54` was probed (probe only; nothing adopted). Two findings,
written up in `evidence/step-1a/tools-version-probe.md`:

1. **A newer platform-tools does fix the edition-2024 problem** — `toml_datetime 1.1.1` compiled
   cleanly, which cargo 1.79.0 could not even parse.
2. **But it fails on the target triple instead:** `error[E0463]: can't find crate for core — the
   sbf-solana-solana target may not be installed`. Agave 2.1.21's `build-sbf` requests
   `sbf-solana-solana`; v1.54 ships the renamed `sbpf-solana-solana`.

So option A needs a platform-tools version that *both* carries cargo ≥ 1.85 *and* still provides
`sbf-solana-solana`. The rename landed in roughly the same generation as the cargo bump, so that gap
may be empty. `v1.51` was still downloading when this was written — **re-run the probe to settle
it** (candidates, newest-first in the pre-rename generation: v1.51, v1.50, v1.49, v1.48, v1.47,
v1.46.1, v1.42.1).

If no version sits in the gap, the choice is **B** (move Agave to a newer line; platform-tools
v2.3.3 is already cached here) or a deliberate split of the CLI pin from the build pin.

Recommendation: probe `v1.51` and below first, since A preserves every §16 pin; fall back to B.

### ~~OPEN DECISION~~ — Q2: §7's migrated-pool `collect_fee_mode` value (raised 4 Oct 2026)

*RESOLVED 4 Oct 2026 by D-010 (approved by the owner).* Kept as history.

**STEP 3 stopped here, per the P0 rule.** Evidence: `evidence/p0/REPORT.md`, `evidence/p0/Q2/`.

- §7 sets the DBC config's `migrated_pool_fee.collect_fee_mode = 1`, intending DAMM v2 OnlyB.
- DBC's enum is `{0 QuoteToken, 1 OutputToken, 2 Compounding}`; DAMM v2's is
  `{0 BothToken, 1 OnlyB, 2 Compounding}`.
- On the mainnet binaries, DBC value 1 produced a **BothToken** pool (fees in both tokens).
- DBC value **0** produced an **OnlyB** pool with quote-only fees and constant L.

**Proposed minimum correction (not applied):** §7 "Migrated pool" row → DBC value **0**; §7
validator rule 2 checks DBC value 0; §8 keeps checking DAMM `pool.collect_fee_mode = 1`. No change
to the mechanism or the canon: §1/§8's intent (quote-only, non-compounding) is unchanged, and only
the encoding that achieves it changes.

### Findings from STEP 3 so far (non-blocking)

- **P1 — §7 rule 4** ("`migration_sqrt_price` equals the last curve point") cannot hold exactly.
  Curve liquidity must round up to absorb the threshold, so DBC's migration price sits 4,580,459
  below the last point. Proposal: `≤ last point` and capacity ≥ threshold.
- **P2 — no overshoot with §7's curve:** completing ExactIn buys that exceed the remaining capacity
  revert. The keeper and app complete with `swap2` PartialFill.
- **P3 — protocol migration share is a token fee (0.2%), not LP:** L_total = L_perm, which is
  better than §7's prediction assumed. Realised L ≥ predicted.
- **P4 — DBC partner claims accept any destination token account** (Q4), so claims can go straight
  to the vault. `withdraw_leftover` instead requires the destination to be owned by
  `leftover_receiver`.
- **P5 — lowest accepted threshold (Lite shape): 20 lamports** (extra check a); 19 → `InvalidCurve`.
- **Cloned mainnet accounts so far:** `dbc_event_authority`, `dbc_pool_authority`,
  `damm_v2_pool_authority`, `damm_v2_migration_config_customizable`. All were found by per-tx
  discovery (`evidence/p0/accounts/discovery.jsonl`) and are pinned in `mainnet-pins.json`.

---

## Environment

| Item | Finding |
|---|---|
| Canonical repo | **`/home/hp/ballast`** in WSL distro `Ubuntu` (D-005), ext4 on `/dev/sdd`, 947 G free |
| Distro | Ubuntu 26.04.1 LTS, kernel 6.6.87.2-microsoft-standard-WSL2, WSL 2.5.9.0, user `hp`, 16 CPUs, 7.6 GiB RAM |
| Stale copy | `C:\Users\HP\OneDrive\Desktop\meteora` — archive only, do not commit to it |
| Shell used before the move | MINGW64 / Git Bash on Windows (`MINGW64_NT-10.0-26200 ... Msys`) with Windows-native solana 1.18.26 / anchor 0.32.1 / Node 24 |
| `sudo` | **Requires a password.** No apt installs were possible; everything went into `$HOME`. `clang` and `unzip` are still absent — flag if a build needs them. |
| `PATH` hazard | `/mnt/c/Program Files/nodejs` leaks Windows `node`/`npm`/`pnpm` into WSL. **`~/.ballast-env` strips every `/mnt/*` entry — source it before any build.** |
| Build env file | `~/.ballast-env` (not in the repo; it encodes machine-specific paths) |
| Spec path | `docs/spec/BUILD_SPEC.md` (export arrived as `Build Spec.md`, renamed) |
| `docs/spec/SUBMISSION.md` | Not present — optional, demo/README copy only |
| `git remote origin` | **`https://github.com/SamarthSrivastavaa/ballast.git`** (public; created by the owner 2 Oct 2026, D-006). It replaced the OneDrive-archive remote, which was removed; the archive itself is untouched. History scanned before the first push: no key files or secrets ever committed. Push `main` and gate tags only, never `backup/*` |
| Commit identity | **`Samarth <samarthsrivastava897@gmail.com>` only**, author and committer, no co-author trailer (owner's instruction, 2 Oct 2026). Set in the repo-local git config |
| npm in WSL | pnpm's parallel registry fetches time out (ETIMEDOUT) while curl succeeds. Repo `.npmrc` sets `network-concurrency=2`, longer timeouts and more retries |

### History rewrite — commit identity (2 Oct 2026)

On the owner's instruction, every commit was re-authored to `samarthsrivastava897@gmail.com` with
`git filter-branch --env-filter`. Author dates and trees are unchanged; the final tree is
byte-identical. The pre-rewrite history is kept in branch `backup/pre-identity-rewrite` until the
owner deletes it. Nothing was force-pushed: `origin` is the OneDrive archive, which the environment
rule forbids writing to. Older documents cite the old hashes:

| Old | New | Commit |
|---|---|---|
| `a727dc1` | `842a773` | STEP 0 guardrails |
| `27ab5a6` | `d3e3fc9` | `ballast-floor` crate, Python reference, `vectors.json` |
| `02cd402` | `dfc5a1f` | drop dead proptest regressions file |
| `79f053e` | `9435abd` | move to WSL Linux, pin the §16 toolchain, D-001..D-005 |
| `a1fa353` | `b9f76c1` | clippy fix in `d002_conditions` |
| `b85ab3e` | `7f00673` | platform-tools probe result |
| `3e5cf68` / `cdf73de` | `c246a6d` | STEP 1: D-001 wording, D-006/7/8, calendar |

### Correction to an earlier premise

There have been **no Meteora local-validator runs** at any point. No validator has been started, no
`anchor build` or `anchor test` has succeeded, and no Meteora `.so` has been fetched. The "10/10"
figure refers to the Python reference reproducing the ten §27 **numerical** vectors — pure integer
arithmetic, no network. **The integration layer is entirely unproven.**

*Superseded 2 Oct 2026 by STEP 2:* the five mainnet Meteora binaries now run on a local validator
and execute (27/27 probes, two full instructions), and `anchor build` / `anchor test` pass. The
integration layer **beyond those probes** is still unproven: STEP 3.

---

## Decision register

Approved by the project owner on 2 Oct 2026 unless stated otherwise. A decision here overrides the
spec text; where it amends the spec, the amendment has been applied to `docs/spec/BUILD_SPEC.md`
with a `[D-00n]` marker so the spec and the code cannot drift apart.

### D-011 — A launch is ONE atomic transaction; `register_launch` verifies it by introspection

**Status: APPROVED 4 Oct 2026 (option C of OPEN QUESTION Q8-funding).** Amends §6, §9, §20, §21, §22.

Q8 established that DLMM refuses to create a pair unless the funder already holds ≥ 1 base unit
(`6060 MissingTokenAmountAsTokenLaunchProof`), which makes §6's "create the pair in the registration
transaction" impossible as written — at that point the whole supply is still in the DBC vault. The
fix is to buy a dust amount first, in the same transaction.

A launch is one transaction, in this order:

1. DBC pool creation
2. **payer dust first buy** (≥ 1 base unit, ≤ the class dust limit)
3. DLMM LimitOrder pair creation, **payer as funder**, at the class bin step
4. `transfer_pool_creator` → `creator_auth`
5. `register_launch`

`register_launch` **drops the `virtual_pool.quote_reserve == 0` precondition** — step 2 makes it
false by design. In its place, via **instruction-sysvar introspection**, it requires:

- **(a)** this transaction contains the DBC pool-creation instruction for *this* pool, and the DLMM
  pair creation for `(base_mint, WSOL)` with the class parameters;
- **(b)** the only DBC swap preceding `register_launch` in this transaction is by the payer and is
  ≤ the class dust limit;
- **(c)** `virtual_pool.creator == creator_auth` after the transfer.

**The claim wording changes** — this is the part that matters for honesty. It is no longer
"prediction recorded before trade 1" but:

> "prediction recorded in the pool-creation transaction, before any third-party trade."

That wording must be used in §21 (app), §22 (Proof launch), the README and the demo. The verifier
(§20) gains a check on the creation transaction's instruction list.

Option C was chosen over seeding the creator (A) or deferring pair creation to `open` (B) because
Q8 also proved the pair creator holds **no** post-activation powers
(`set_pair_status_permissionless` → `6043 InvalidPoolType`), so making the payer the funder costs
nothing in trust.

**Gate before `register_launch` is written:** prove on the mainnet-binary localnet that this
transaction fits in 1,232 bytes using an address lookup table. If it does not, test DBC's
create-with-first-buy variant to merge steps 1 and 2. If it still does not, **stop and report the
byte count** — see `evidence/p0/d011/fit.json`.

### D-012 — `open` funds the bid from the vault PDA's token account; a missing token account is an error

**Status: APPROVED 4 Oct 2026.** Rule for `CLAUDE.md`, the SDK and the tests.

Q4 established that `claim_trading_fee` and `partner_withdraw_surplus` accept a destination the fee
claimer does not own, and this project sends them to the **vault PDA's** ATA. So `open` funds the
DLMM bid from the **vault PDA's token account**, not `partner_auth`'s.

The second half is a lesson from a near-miss: the Q5 harness step read `partner_auth`'s WSOL balance
with a helper that returns `0` for a *missing* account, and so placed a bid it believed was funded
when the account did not exist. **Reading a missing token account is an ERROR, never 0.** A throwing
balance helper is added, with a test that proves it throws; the returns-zero form may only be used
where "absent" and "empty" are genuinely equivalent, and must be named so.

### D-013 — `initialize_bin_array` is the keeper's job, not `open`'s

**Status: APPROVED 4 Oct 2026.** Amends §26.

Q9 measured `initialize_bin_array` for the bid bin at **≈ 199,000 CU** on its own — a third of
§26's entire 600k budget for `open`, spent on setup that does not have to be atomic with it.

- The **keeper** creates the bin arrays covering the predicted floor bin **and the next array up**,
  as **top-level DLMM instructions**, before `open`.
- When F moves into a new array, the keeper creates it before `refresh_floor`.
- `open` and `refresh_floor` **verify the arrays exist and fail clearly if not** — they never create
  them, so neither instruction carries that cost or that failure mode.

§26's CU budgets are reduced accordingly.

### D-014 — The bin step is fixed per class and validated in `create_class`

**Status: APPROVED 4 Oct 2026** (recorded with D-011; consequence of Q8).

The DLMM pair address derives from `[ILM_BASE, min(mintX,mintY), max(mintX,mintY)]` — it **carries
no bin step**. There is therefore exactly one pair per mint pair, and a second pair at a different
bin step is refused. **The bin step must be correct the first time**, so it is a property of the
class, not of a launch: `create_class` validates `bid_bin_step` as one of its §7 rules, and
`register_launch`'s introspection check (a) requires the pair creation to carry the class value.

### D-016 — Graduation routing: DBC claims pay the vault and the beneficiary directly; `burn_leftover` requires `Funded`

**Status: APPROVED 6 Oct 2026** (owner: "proceed" on the slice audit's option (b)). Amends §6
`settle_graduation` and `burn_leftover`; spec marked `[D-016]`. Evidence:
`evidence/program/part1/graduation.json`.

1. **Direct destinations.** Q4 showed DBC's claims accept a destination the signer does not own.
   `settle_graduation` sends `withdraw_migration_fee` (partner flag) and `claim_trading_fee` straight
   to the **vault PDA**, and `claim_creator_trading_fee` straight to the **beneficiary's WSOL ATA**.
   There is no WSOL staging ATA and no `creator_auth` WSOL ATA: one hop and one CPI fewer per flow,
   nothing left in transit. Each amount is still a balance delta around its own CPI.
2. **One staging account:** `partner_auth`'s base-mint ATA, required by address. It is the base
   destination of both DBC claims and the `withdraw_leftover` destination. The partner claim's base
   delta (0 under the class's QuoteToken fee mode) is burned in `settle_graduation`; a creator base
   fee **fails closed** (`CreatorBaseFee`) instead of being burned.
3. **The beneficiary is an outside account, paid only at `ATA(creator_beneficiary, WSOL)`.**
   `register_launch` refuses `partner_auth`, `creator_auth`, `launch` or `vault` as the beneficiary
   (`BeneficiaryIsBallastPda`). Slice audit, 6 Oct: with beneficiary = `partner_auth`, a caller could
   pass a vault (this launch's — double-counting `creator_forwarded` — or another launch's) or the
   class-wide `partner_auth` WSOL account as the creator-fee destination.
4. **`burn_leftover` requires `Funded`.** From `Registered` it fails `LaunchWrongState`; a lagging
   keeper sends `settle_graduation` first (the same transaction is fine — settle works after
   migration). Accepting `Registered` without the settle CPIs would make settle unreachable (it
   requires `Registered`) and strand the 15% migration fee in DBC.
5. **Leftover front-run.** DBC's `withdraw_leftover` is permissionless, and on the mainnet binary it
   pays only the leftover receiver's ATA (a `partner_auth`-owned non-ATA account is refused —
   verified in the suite). `burn_leftover` skips the CPI when `is_withdraw_leftover == 1` and burns the
   whole ATA balance. `settle_graduation` burns only its own claim's base delta, so a leftover
   front-run **before** a late settle is still burned and recorded by `burn_leftover`
   (`leftover_burned`, `LeftoverBurned.amount`). Between those two instructions staging can hold that
   leftover; only `partner_auth` controls it and only `burn_leftover` moves it.

### D-017 — §7 rule 4 is a measured band, not equality; the prediction takes the lower-F end

**Status: APPROVED 6 Oct 2026** (owner). Resolves § OPEN DECISION §7 rule 4. Amends §7 rule 4 and
§7 "Prediction"; spec marked `[D-017]`. Evidence: `evidence/program/d017/band.json`,
`evidence/program/part1/results.json`.

1. **Band:** `last_point − T ≤ migration_sqrt_price ≤ last_point`, two-sided
   (`curve::migration_price_in_band`). **T = the maximum shortfall observed on the mainnet DBC
   binary + 2 units of rounding margin = 4,580,461.** Measured on a fresh mainnet-binary ledger
   with the canonical configs: Proof 4,580,459 (`9mHZMzDK…aH96s`; same value as Q12 on 4 Oct, so
   reproducible), Public 2,896,937 (`fCNvBpEw…unzBt`). No config lands above its last point.
   `canon::MIGRATION_PRICE_TOLERANCE`, `tests/reference/floor.py` and `compiler/src/emit.ts` carry
   the same value; `pnpm -F compiler test` fails if any of them drifts.
2. **Capacity check kept:** `Σ ⌊L_i·(s_i − s_{i−1})/2^128⌋ ≥ migration_quote_threshold`.
3. **Prediction at the lower-F band end.** `tests/reference/floor.py` derives (V, S, L) from the
   compiled curve at both ends — V and L rounded down, S up; L net of the 0.2% protocol share, S
   including it (Q14: it is a token fee, still outstanding) — and emits them as `prediction` vectors
   in `vectors.json`, which `ballast-floor` matches bit for bit. The compiler pins
   **min(§27 vector, band_lo, band_hi)**.

   | Class | s at band_lo (last − T) | s at band_hi (last point) | §27 vector (pinned) |
   |---|---|---|---|
   | Proof | 47,811,433,357,069,708 | **47,811,433,353,714,945** | **47,755,047,807,748,143** |
   | Public | 75,596,513,433,716,731 | **75,596,513,430,362,024** | **75,507,360,421,341,854** |

   The lower-F end is the **last curve point** for both classes (by ≈ 3.4·10⁶ in s, relative
   7·10⁻¹¹). §27's values sit ≈ 0.12% below both ends — §27 took the 0.2% protocol share out of L
   twice and was computed in floating point — so **the pinned predictions are unchanged** and every
   published number (§22 "≈ 6.70e-9", §27) stands. The check now proves the pin is ≤ the lower-F
   end instead of assuming it. Cross-check: band_lo's S for Proof (865,441,059,871,812) is 3 base
   units above the S measured after a real Proof graduation (865,441,059,871,809), as a lower-F
   derivation should be.
4. **Negative tests just outside the band** (mainnet DBC binary; segment-3 liquidity tuned until
   DBC's own derived price lands there): shortfall **4,580,462 = T + 1 → `ConfigMigrationPriceOutOfBand`**
   (`4b7iukU2…ruoMS`); shortfall 4,580,460 = T − 1 → passes rule 4 and stops at the rule-3 hash
   (`4qexQzkq…4pmckp`). Above the last point is unreachable on DBC (it refuses a curve that cannot
   reach the threshold), so that side is a unit test (`curve::tests::migration_band_edges`: T + 1
   below, +1 above, both edges, both measured values).

Found on the way: `pnpm -F compiler test` had been failing at HEAD since rustfmt wrapped the
`config_hash` arrays in `lib.rs` (the pinned bytes were right; the check string-matched one line).
The check now parses the arrays. It is not in CI — see STATUS risks.

### D-018 — Size: Anchor `no-idl` + a hand-built `CreateAccount`; no further size work

**Status: APPROVED 6 Oct 2026** (owner). Amends D-009: accept up to ≈ 500 KB if Part 2 needs it.

- `programs/ballast/Cargo.toml`: `default = ["no-idl"]` — drops Anchor's on-chain IDL instructions.
  The client IDL is still generated by `anchor build` (`idl-build`) into `target/idl/`.
- `spl::create_account` builds System `CreateAccount` by hand (u32 variant ‖ lamports ‖ space ‖
  owner); a unit test proves it byte-identical to `system_instruction::create_account`.
- Result: **381,952 → 339,216 B** (−42,736 B) with Part 1's 5 instructions; Part 1 suite unchanged
  (43 / 0 / 10 on a fresh ledger). Anchor's `init` still links bincode for `global`/`class`/`launch`;
  removing that would mean hand-rolling `init`, which D-018 rules out.

### D-019 — Calendar and cuts (6 Oct 2026)

**Status: APPROVED 6 Oct 2026** (owner). Replaces the STATUS.md calendar and the §28 cut order.

| When | Work |
|---|---|
| 6 Oct (today) | Program Part 2 core |
| 7 Oct (+1) | Full-lifecycle test = `pnpm proof:local` + lifecycle fuzzer |
| 8 Oct (+2) | Verifier CLI + devnet deploy/proof |
| 9 Oct (+3) | Floor Scanner + Lite config + keeper scripts |
| 10 Oct (+4) | Token page + README + `JUDGES.md` |
| 11 Oct | Video + submit |
| 12 Oct | Buffer |

- **CUT now:** compiler CLI flags; stats page (→ README evidence table); challenge page (→ README
  section); Lite launch form (→ scripts).
- **NEVER CUT:** verifier, fuzzer, `proof:local`, devnet proof, scanner CLI, `JUDGES.md`.

### D-020 — The bid moves the DLMM active bin up, else caps at it (option A)

**Status: APPROVED 7 Oct 2026** (owner: "A: move, else cap"). Amends §6 `open` / `refresh_floor` /
`redeem` and §9 "Order lifecycle"; spec marked `[D-020]`. Evidence: § OPEN DECISION (active bin),
`evidence/program/part2/dlmm-active-bin.json`.

DLMM accepts a bid only at or below the pair's active bin (6105 above it); `go_to_a_bin` moves the
active bin permissionlessly but is refused (6056) while any order sits in the range. A failed CPI
aborts the whole transaction on Solana, so "try, else cap" cannot happen inside one instruction.
Implemented as:

- **`open` / `refresh_floor(bin_id_hint)`:** the hint is either **F's bin** — then, if the active bin
  is below it, Ballast CPIs `go_to_a_bin(F's bin)` first — or **the active bin**, accepted only when
  F's bin is above it (`price(active + 1) ≤ F`): the cap. Any other hint is `BinHintNotAtFloor`. The
  keeper tries F's bin and, on 6056, calls again with the active bin.
- **`redeem`:** never moves the active bin, so no third party can block a redemption: F's bin when
  the active bin allows it (found by binary search between the old bid bin and the active bin), else
  the active bin.
- A capped bid is still **at or below F** (rounding toward the protocol holds). `Launch.bid_capped`
  records it and `BidCapped{launch, bin}` is emitted; the next `refresh_floor` lifts it once the
  blocking order is filled or cancelled. Redemption at F is unaffected.
- **Disclosure (README, app, `JUDGES.md`):** "the executable bid can sit below F's bin while a
  third-party order pins the DLMM active bin; redemption still pays F."

### D-021 — Extreme-bin pin: cap within 70 bins, else suspend the DLMM leg (amends D-020)

**Status: APPROVED 7 Oct 2026** (owner). Raised by the Part 2 `/audit` (security review): before
`open` the pair is empty, so anyone can move its active bin far down (`go_to_a_bin`, with the
bitmap extension if needed) and park a dust bid there, which stranded the vault under D-020.

- The bid may be capped at the active bin only within **70 bins under F's bin**. Further down — or
  where DLMM's price is undefined — `open`, `refresh_floor` and `redeem` leave the vault **unplaced**:
  `bid_order = default`, V still counts the vault, redemption stays live, the DLMM leg is suspended,
  `bid_suspended` is recorded and `BidSuspended` emitted. `open` still enters `Open`.
- The bitmap-extension account is supported (`["bitmap", lb_pair]` under DLMM) for `go_to_a_bin`
  from or to an array outside the internal bitmap.
- **Principle (CLAUDE.md):** no outside actor can prevent the floor from existing; F and redemption
  never depend on DLMM pair state.
- Time-boxed experiment (45 min, non-blocking): a `partner_auth` dust bid at the predicted floor's bin
  in the D-011 launch transaction, to see whether DLMM then refuses `go_to_a_bin` past it. Kept only if
  it blocks the pin. **Result (8 Oct 2026): DROPPED** — `evidence/program/part2/d021-dust-experiment.json`,
  `tests/integration/program/tools/d021-dust-experiment.ts`, mainnet DLMM binary:
  - X1, the dust bid **at the predicted floor's bin** in the launch transaction: refused,
    `6105 InvalidPlaceLimitOrderParameters` (`5TJJWDM2…`) — at launch that bin is above
    the pair's active bin (p0's), the D-020 rule.
  - X2, a dust bid one bin **below** the launch's active bin: placed (`2esfiNgg…`), and it
    does block the pin while it rests — `go_to_a_bin` down to −35,163 refused `6056` (`3yWm28Js…`).
  - X3, a griefer buys ≈ 309 tokens on the curve, creates the bitmap extension (permissionless) and
    sells exactly what the dust bid absorbs (308,562,969 base units, `3G9SR3o8…`); the pin then
    succeeds — active bin −35,163 (`5fsjWWSn…`). The protection costs a griefer a few
    lamports to remove, so it is not kept; D-021's cap/suspend rule (the floor exists and redemption
    pays F regardless) carries the guarantee.

### D-022 — Creator flows are decoupled into `pay_creator` (amends D-016)

**Status: APPROVED 7 Oct 2026** (owner: "decouple, don't skip"). Raised by the Part 2 `/audit`: a
creator who reassigns the owner of their own `ATA(beneficiary, WSOL)` (SPL Token `SetAuthority`)
made `settle_graduation` and `harvest` revert forever.

- `settle_graduation` and `harvest` handle **partner flows only** (vault; treasury via staging).
- New permissionless `pay_creator`: claims the DBC creator trading fees and, once `Open`, the creator
  position's LP fees via `creator_auth`, and pays `ATA(creator_beneficiary, WSOL)` after full
  validation. If that account is invalid, only `pay_creator` fails; the fees stay claimable.
- **Principle (CLAUDE.md):** nothing the creator controls is on the floor's critical path.

### Part 2 audit findings — approved fixes (7 Oct 2026)

Approved by the owner exactly as reported by `/audit` on 7 Oct: the treasury share is paid from a
`partner_auth` WSOL staging ATA, never from the vault, and staging ends at zero (§10's two exits now
hold structurally); identity-only position checks after `open`, with L decreases routed through
`note_backing` (one `BackingDecreased` per position, on every decrease); `bin_step ==
class.bid_bin_step` in every pair read; the resting order fully decoded (DLMM owner, `LimitOrder`
discriminator, `owner == partner_auth`, `lb_pair`); the whole staging base balance burned and
recorded; an uncapped `refresh_floor` that raises the bid bin skips the rate limit while the bid is
capped or suspended; `BidCapped` emitted by `redeem`; `order` in `FloorOpened`, `quote_returned` and
`order` in `FloorRefreshed`; a `fill_quote_spent` counter; the `BinArray` discriminator check;
`deposit` checks the depositor account's mint and authority.

### Part 2 audit — implementation (7–8 Oct 2026)

Work resumed after the 7 Oct crash (C: full, WSL down; `evidence/phases/RECONCILE-2026-10-07.md`).
Test-first: `tests/integration/program/src/part5.ts` holds one "(repro)" case per reproducible
finding. It runs first against the saved D-020 build (`BALLAST_SO` / `BALLAST_IDL` →
`~/ballast-d020/`, sha256 `d51e099d…` / `2b5616a8…`) to show each finding failing, then against the
fix. Evidence: `evidence/program/part2/audit-repro-d020.json` (D-020 build) and
`evidence/program/part2/audit.json` (fixed build).

**A premise of D-021, corrected by observation.** The audit's extreme pin parked the active bin at
−40,000, beyond the internal bitmap. On the mainnet DLMM binary a class pair (bin step 10) confines
bins to its own `min_bin_id` / `max_bin_id` = **±35,163**, inside the internal bitmap (±35,840).
`initialize_bin_array` at −40,000 is refused with `6000 InvalidStartBinIndex`
(`evidence/program/part2/dlmm-bin-range.json`). So the bitmap extension is never needed at bin step
10; support for it stays, as D-021 approved, for other bin steps. The deep pin itself is real at
−35,163, about 23,000 bins under F's bin. D-020 would have capped the whole vault there at a price
near zero; D-021's suspension is what prevents that.

**D-021, as built** (`floor_ix.rs`):
- `open` / `refresh_floor(hint)`: a hint at F's bin places there, CPI-ing `go_to_a_bin` first when the
  active bin is below it. A hint equal to the active bin, with F's bin above it, caps there if F's bin
  is at most `MAX_CAP_DEPTH = 70` bins up, else **suspends**. Anything else is `BinHintNotAtFloor`.
- `redeem` never moves the active bin and never fails on pair state. It places at F's bin when the
  active bin allows it, else caps within 70, else suspends. F's bin is found by binary search from the
  old bid bin, or, when that bin no longer qualifies, by doubling steps down from the active bin.
- Where DLMM has no price (`price_q64` → `None`), the sign of the bin decides: far below is ≤ F, far
  above is > F. So no active bin a third party can reach turns a comparison into an error. Unit tests:
  `undefined_prices_compare_by_sign`, `deep_pins_suspend`, `redeem_placement_rules`,
  `floor_bin_search_matches_scan`.
- While suspended: `bid_order = default`, `bid_quote_committed = 0`, `bid_bin_id` = the pinned active
  bin, and V = the vault. `floor()` appends `capped` and `suspended` to its return data.
- `require_internal_bitmap` is gone. `place`, `cancel` and `go_to_a_bin` pass the pair's
  `["bitmap", lb_pair]` account whenever a bin's array lies outside ±512, checked DLMM-owned
  (`BitmapExtensionMismatch`).
- Rate limit (10 slots): while the bid is capped or suspended, only a refresh that lifts it to F's bin
  may skip the window. Cap → cap and suspended → suspended wait like any other refresh.

**D-022, as built** (`creator_ix.rs`, `lib.rs`):
- `settle_graduation` no longer takes `creator_auth` or `beneficiary_quote`. `GraduationSettled` drops
  `creator_fees`.
- `harvest` claims the partner position only, into `partner_auth`'s WSOL staging ATA
  (`StagingQuoteInvalid` if it is wrong or missing). 10% of the claimed fees, rounded down, goes →
  treasury. The whole remaining staging balance goes → vault. `Harvested{to_vault, to_treasury,
  base_burned, s_new}`.
- `pay_creator()` is permissionless in any state. If DBC holds creator quote fees, it claims them,
  signed by `creator_auth`, with `partner_auth`'s base ATA as the base sink, which must not move
  (`CreatorBaseFee`). Once `Open`, it also runs the DAMM `claim_position_fee` on the recorded creator
  position (passed as optional accounts) and the §4 monotone check. Creator flows touch none of V, S,
  L, so that check holds.
- Both claims pay `ATA(creator_beneficiary, WSOL)` after full validation. `CreatorPaid{dbc_fees,
  lp_fees}`; `creator_forwarded` is incremented.

**The approved findings, as built:**
- identity-only position reads after `open` (`damm::read_position_identity`), with per-position
  `partner_l_recorded` / `creator_l_recorded`, so each decrease emits its own
  `BackingDecreased{position, l_recorded, l_read}` (unit test `backing_decrease_is_per_position`);
- `bin_step == class.bid_bin_step` in `read_pair`;
- the resting order decoded before the cancel (`check_bid_order`: DLMM owner, `LimitOrder`
  discriminator on the header, `owner == partner_auth`, `lb_pair`, else `BidOrderInvalid`);
- `open`, `refresh_floor`, `redeem` and `harvest` burn the **whole** base staging balance and add it
  to `burned`;
- `BidCapped` / `BidSuspended` on every placement, `redeem` included;
- `FloorOpened.order`;
- `FloorRefreshed{filled_tokens, burned, quote_returned, s_new, bin_id, order}`;
- `Redeemed{…, s_before, s_after, filled_tokens, quote_returned}`;
- `fill_quote_spent += committed − quote_returned` (saturating);
- `is_bin_array` checks the `BinArray` discriminator;
- `deposit` checks the depositor's WSOL account (`DepositorAccountInvalid`).

**Interpretations, flagged for the owner (none changes the mechanism):**
1. "Staging zero at the end of every instruction" is enforced in `open`, `refresh_floor`, `redeem` and
   `harvest`. `settle_graduation` keeps D-016's approved exception: it leaves a front-run leftover in
   staging for `burn_leftover` to burn and record as leftover. `deposit` and `floor` never touch
   staging, and S excludes it, so anything sitting there cannot affect F.
2. WSOL sent to the WSOL staging account goes to the vault (raising F), not the treasury: the
   treasury takes exactly 10% of the claimed fees.

**Program size:** 551,488 B (D-020 build: 531,800 B), over D-018's ≈ 500 KB. Owner decision pending.

### Part 2 re-audit (8 Oct 2026) — closed, one item for the owner

**CU (local, mainnet binaries, fresh ledger 8 Oct; D-009 targets in brackets):** `open` 145,319
(156,615 when it first moves the active bin ≈ 23,000 bins) [≤ 420k] · `refresh_floor` 187,542
[≤ 560k] · atomic `redeem` 209,023–209,061 [≤ 840k — no two-step fallback] · `harvest` 114,184 ·
`pay_creator` 126,129 · `deposit` 58,686 · `floor()` 51,472. Fresh-ledger run 8 Oct: Part 1
43/0/10 · 19/0/1 · 32/0/1; Part 2 46/0; audit suite 22/0/5 (after a test-only signer fix, rerun with
Part 1 on a fresh ledger); keeper 5/0.



`/audit` re-run on the program after D-021/D-022 and the approved fixes: **0 critical · 0 high**
once the items below were fixed. Every D-020/D-021/D-022 rule and approved finding was confirmed
implemented; §19's "can anyone withdraw user backing?" holds literally (the vault's only outflows
are the bid it owns and a redeemer).

Fixed 8 Oct (spec conformance, no new decision):
- **§4 rule 1 (was CRITICAL):** the one-sided `price ≤ F` rule — including D-021's classification of
  bins where DLMM has no price (by sign) — `is_floor_bin` and `F_q64 = ⌊s²/2^64⌋` now live in
  `ballast-floor` (`price_at_or_below`, `is_floor_bin`, `f_q64`; `crates/floor/tests/bin_rules.rs`),
  so the program, verifier and app share one implementation.
- **Redemption never depends on DLMM pair state (CLAUDE.md principle):** if `redeem`'s chosen bin
  lies in a bin array nobody created, the vault stays unplaced (`BidSuspended`) instead of the
  redemption reverting; the derived address must still be passed, and a real array cannot be
  faked. Reproduction: part5 "audit 8 Oct (repro)". *Order note: this fix was written before its
  test; the pre-fix failure (`BinArrayMissing`) is from code reading, not a run.*
- §5 rule 1: the bitmap extension's discriminator is checked. §5 staging: `deposit` and (once
  `Open`) `pay_creator` burn the staging base balance and record it. §25: `LaunchRegistered` carries
  `dbc_pool`.

**Open for the owner (MEDIUM, before the upgrade authority is frozen):** `harvest` needs
`global.treasury` to be a live WSOL token account. If the treasury key holder closes it (or
recreates a keypair account with another mint), every harvest with a treasury share reverts, for
every launch, and `global.treasury` has no setter. Proposed fix: if the treasury account is not a
valid SPL WSOL account, `harvest` sends the treasury's share to the vault as well (F rises; nothing
is stranded). This changes who is paid, so it is the owner's call.

### D-001 — Fixtures and the local validator use mainnet binaries and mainnet accounts

**Status: APPROVED. Exact wording, given by the owner on 2 Oct 2026:**

> Devnet Meteora binaries differ from mainnet. The target is the mainnet programs. All P0 and P1
> questions are answered first on a local validator running the mainnet-dumped DBC, DAMM v2, DLMM,
> Token Metadata and Jupiter locker programs, with every mainnet account they read cloned in (found
> by simulation, not guessed). Those results are authoritative. Devnet is secondary: keeper
> behaviour (Q17) and cross-checks only; any divergence is recorded and the mainnet result governs.
> Mainnet program hashes and slots are pinned in evidence/fixtures/mainnet-pins.json; pnpm
> fixtures:check runs at session start and before any mainnet action; a hash change means
> re-running the affected gates.

*Superseded 2 Oct 2026:* the text below was my reconstruction, written before the wording above was
given. It is kept for history; where the two differ, the quote above governs. The quote adds three
things the reconstruction lacked: Token Metadata and the Jupiter locker are explicitly in the
program set; devnet is limited to Q17 and cross-checks; and `fixtures:check` runs at session start
and before any mainnet action, with a hash change forcing a re-run of the affected gates.

<details><summary>Reconstruction (superseded)</summary>

- The local validator boots with the **mainnet** Meteora binaries, not devnet ones, plus **every
  mainnet account those programs read**.
- That account list is discovered by **simulating** a DBC config creation, a migration and a DLMM
  pair creation against mainnet — never guessed, never assembled from docs alone.
- `pnpm fixtures:dump` dumps them; `pnpm fixtures:check` verifies them.
- Each fixture is pinned by **sha256 and the slot it was dumped at**, recorded in
  `evidence/fixtures/mainnet-pins.json`, so a test run is reproducible and a silently changed
  fixture is detectable.

Rationale: §14 forbids mocking Meteora, and devnet binaries can diverge from the deployed mainnet
versions that the Proof and Public launches will actually run against. Supersedes the plainer
reading of §17.

</details>

### D-002 — Host Rust pinned to 1.85.0

**Status: APPROVED, with conditions.** Amends §16's starting pin of 1.84 stable.

Cause: on cargo 1.84, `proptest` (required by §14's property layer) pulls `getrandom` 0.4.x, whose
manifest needs the edition-2024 parser. The requirement is a caret on a major version inside
proptest's tree, so `getrandom` cannot be pinned down. 1.85.0 is the first edition-2024 stable.

Conditions attached to this approval — all four are binding:

1. `crates/floor` stays **edition 2021**.
2. `proptest` stays a **dev-dependency only**.
3. `crates/floor` and its non-dev dependencies (`ruint`) must build with `cargo build-sbf` under
   the platform-tools rustc.
4. If (3) fails, **pin an older `ruint`** — do not change the toolchain again without asking.

Conditions 1 and 2 are enforced by a test (`d002_conditions`) so they cannot regress silently.
Condition 3 is proven by the STEP 1A evidence below.

### D-003 — §4 bound is `L ≤ 2^120`, inclusive (was finding F1)

**Status: APPROVED.** Amends §4. Resolves the contradiction with §27's boundary vector
"Max supply, 1,000 SOL vault, L = 2^120", which uses `L` at exactly 2^120.

Overflow margin at the bound, as required by the approval: with `L = 2^120` exactly,
**`B² = 2^240`** and **`D = B² + 4AC < 2^246`**, both inside U256 (`2^256`). §4's headroom
argument therefore still holds at the inclusive bound.

### D-004 — §14 "monotone in L" is scoped to within one ceiling step (was finding F2)

**Status: APPROVED.** Amends §14.

§14's unconditional "monotone in L" is false for §4's conservative `A = S + ⌈L/s_max⌉`: an increase
in `L` that crosses a multiple of `s_max` adds a whole base unit to `A` while adding only `ΔL` to
`B`. Counterexample found by proptest: `V = u64::MAX, S = 1, L = 0 → 1` lowers `F`.

Required by this approval, all three now in place:

1. The property is scoped to **within one `⌈L/s_max⌉` step**
   (`monotone_in_l_within_a_ceiling_step`).
2. The named counterexample test is **kept** (`ceiling_step_can_lower_f`).
3. A new property bounds the drop: **at a ceiling step, `s(L+ΔL) ≥ s` computed with `A+1` for the
   same `L`** (`ceiling_step_drop_is_bounded_by_one_base_unit`). Since `A = S + ⌈L/s_max⌉`,
   incrementing `A` by one is exactly incrementing `S` by one, so the test compares
   `s(V, S, L+ΔL)` against `s(V, S+1, L)`. The whole drop is attributable to the `+1` in `A`; the
   `ΔL` added to `B` can only help.

**No mechanism impact:** `L` is immutable after `open` (permanently locked, PDA-owned positions), so
the mechanism never takes this transition. A decrease is covered by the §8 `BackingDecreased`
fail-safe. Rounding `A` up always understates `F`, which is the safe direction.

### D-005 — The repo moved to the WSL Ubuntu Linux filesystem

**Status: APPROVED and done.** New canonical path: **`/home/hp/ballast`** (ext4, `/dev/sdd`).

| | |
|---|---|
| Was | `C:\Users\HP\OneDrive\Desktop\meteora` (Windows NTFS, inside OneDrive) |
| Now | `/home/hp/ballast` in WSL distro `Ubuntu` (Ubuntu 26.04.1 LTS, kernel 6.6.87.2) |
| Method | `git clone` from the Windows path, so history is preserved: 3 commits, `02cd402` (now `dfc5a1f`, see § History rewrite) at HEAD, `git status` clean |
| Verified | LF line endings intact (`.gitattributes` honoured, 0 CR bytes in `crates/floor/src/lib.rs`); `cargo test -p ballast-floor` green on Linux |

Reasons: OneDrive sync locking corrupts `target/` and slows cargo; `/mnt/c` 9p I/O is far slower
than ext4 for a cargo workspace; and `solana-test-validator` with `[[test.genesis]]`-loaded Meteora
binaries is unproven on Windows, which §14 and §17 depend on for every integration and negative test.

**The Windows copy at `C:\Users\HP\OneDrive\Desktop\meteora` is now stale.** It has been left in
place rather than deleted; it should be treated as an archive and not committed to. Deleting it is
your call.

One hazard that follows from the move: `/mnt/c/Program Files/nodejs` leaks Windows `node`, `npm`
and `pnpm` onto the WSL `PATH`, where they resolve the wrong binaries and cannot build Linux native
modules. `~/.ballast-env` strips every `/mnt/*` entry from `PATH`; source it before any build.

**Environment rule (2 Oct 2026, owner's wording, also in `CLAUDE.md`):** "Every shell command runs
after `source ~/.ballast-env`; work only in /home/hp/ballast on ext4; never under /mnt/c or
OneDrive."

### D-006 — Judging: what to optimise for, in order of evidence

**Status: APPROVED 2 Oct 2026. Owner's wording:**

> Optimise for, in this order of evidence:
> - Depth of Meteora integration: DBC, DAMM v2 and DLMM each carry part of the floor.
> - Technical execution: tests, fuzzing, verifier, reproducible proof.
> - Originality and taste: a new DBC use case that outlasts the meme-stock meta; quote-asset-agnostic pitch.
> - Impact: a new asset class; any DBC launchpad can adopt it; floor() is readable by terminals.
> - Traction: live on mainnet with people actively using it.
>
> Consequences:
> - Public repo under Apache-2.0.
> - CI fails if app/ or README.md contains: safe, insured, protected, can't lose, guaranteed profit, "price can never go below".
> - JUDGES.md maps each criterion to linked evidence.

Applied now: the CI `wording` job (`.github/workflows/ci.yml`) enforces the full list on `app/` and
`README.md`. It was missing `safe` and `protected`. `sdk/` keeps the previous, narrower list, because
`protected` is a TypeScript keyword. `Cargo.toml` already declares `license = "Apache-2.0"`.
Not yet done: the `LICENSE` file and `JUDGES.md`, both on the calendar for 8–9 Oct. Making the
repo public is the owner's action.

### D-007 — Budget: no mainnet spend without per-transaction approval

**Status: APPROVED 2 Oct 2026. Owner's wording:**

> No mainnet spend unless I approve each transaction.
> - The full trustless proof runs as `pnpm proof:local` (the complete §22 sequence on the
>   mainnet-binary local validator, deterministic, rerunnable by judges; primary evidence) and on
>   devnet (public evidence).
> - Mainnet deployment of the full program happens only if funding arrives; keep the §19 runbook ready.
> - Program size target ≤ 300 KB: manual CPI instruction builders instead of full Meteora program
>   crates; opt-level "z", lto, codegen-units = 1. Report the .so size after every program slice.

Amends §19 and §22: the mainnet Proof launch becomes conditional on funding; `proof:local` is the
primary proof. Read-only mainnet RPC calls (`solana program dump`, `solana account`,
`getAccountInfo`, `simulateTransaction`) spend nothing and sign nothing, so they are not covered by
the approval requirement. `fixtures:dump` and `fixtures:check` use them.

### D-008 — Two tiers, one mechanism

**Status: APPROVED 2 Oct 2026. Owner's wording:**

> - Ballast Lite = DBC config only: same shaped curve, flat 1% fee, 100% permanently locked LP split
>   partner/creator, migration fee 0, no Ballast program. Floor = locked-liquidity floor. The
>   verifier supports it (V = 0). Mainnet config cost ~0.05 SOL, with my approval; launchers pay
>   their own pool rent.
> - Ballast Full = the specified program, vault and DLMM bids.
> - README and JUDGES.md present both tiers.

Floor-engine note: Lite is the §4 equation with `V = 0`, i.e. `A·s² − B·s = 0`. That gives
`s = ⌊B/A⌋ = ⌊L/(S + ⌈L/s_max⌉)⌋`, the same crate and the same rounding, so the "only
`ballast-floor` computes F" rule holds for both tiers. The crate does not reject `V = 0`; it only
errors on `S = 0` and on the §4 bounds (`crates/floor/src/lib.rs`, `FloorError`). *Corrected
2 Oct 2026:* an earlier version of this note said no `V = 0` vector existed. That was wrong.
§27's "Pool only (V = 0)" boundary vector is in `vectors.json` as `pool_only_v_zero`, along with
2,500 random `V = 0` cases, and Rust matches Python on all of them. Whether a Lite config can migrate with 100% permanent lock is
STEP 3 check (c).

### D-009 — Program size relaxed to a soft ≤ 400 KB; CU budgets keep 30% headroom

**Status: APPROVED 2 Oct 2026. Owner's wording:**

> Program size target relaxed to a soft ≤ 400 KB (rent only matters if mainnet funding arrives);
> keep size-optimised settings, report the .so size per slice, no build days spent on size
> reduction. CU budgets keep 30% headroom under §26 until devnet cross-check.

Amends D-007's 300 KB target; the rest of D-007 stands. The size-optimised settings stay
(`opt-level = "z"`, `lto`, `codegen-units = 1`, manual CPI builders), and the `.so` size is reported
after every program slice. Reason: STEP 2 finding T5 (Anchor baseline ≈ 210 KB).

**Size log (`target/deploy/ballast.so`):**

| Slice | Size | Note |
|---|---|---|
| `initialize_global` + `create_class` | 424,040 → 380,456 B | `[profile.release.package.ballast] opt-level = "z"` |
| + `register_launch` | 380,456 B | |
| + `settle_graduation`, `burn_leftover` | 440,528 → 379,624 B | Anchor's `Account<ProgramData>` decodes with bincode/serde, which linked serde and `f64` formatting (≈ 61 KB); the upgrade authority is now parsed by hand from the 45-byte header |
| + slice-audit fixes (D-016) | 381,952 B | Part 1 complete: 5 of 11 instructions |
| D-018: `no-idl` + hand-built `CreateAccount` | 339,216 B | −42,736 B; same 5 instructions |
| Part 2 at D-020 (11 instructions) | 531,800 B | |
| + D-021, D-022 (`pay_creator`), audit fixes, re-audit fixes (8 Oct) | **553,456 B** | ≈ 11% over D-018's "≈ 500 KB"; reported, no size work (D-018) |

**CU targets until the devnet cross-check** (70% of each §26 budget, measured locally per finding T6):

| Instruction | §26 budget | Local target (30% headroom) |
|---|---|---|
| `open` | 600k | **≤ 420k** |
| atomic `redeem` (cancel + burn + pay + place) | 1.2M | **≤ 840k** |
| `refresh_floor` | 800k | **≤ 560k** |

### D-010 — The DBC config sets `migrated_pool_fee.collect_fee_mode = 0` to get a DAMM v2 OnlyB pool

**Status: APPROVED by the owner, 4 Oct 2026.** Amends §7 ("Migrated pool" row) and §8 ("Pool
mode" row), with `[D-010]` markers.

- §7 wrote DAMM v2's OnlyB value (1) into the **DBC** config field.
- DBC numbers this enum `{0 QuoteToken, 1 OutputToken, 2 Compounding}`. DAMM v2 numbers it
  `{0 BothToken, 1 OnlyB, 2 Compounding}`.
- §2 already listed both enums correctly; §7 misapplied them.
- On the mainnet binaries, DBC 1 → DAMM BothToken (`evidence/p0/Q2/result.json`), and DBC 0 →
  DAMM OnlyB, quote-only fees, constant L (`evidence/p0/Q2/characterization-quote-fee-mode.json`).

Consequences:
- The DBC config uses `0`; the DAMM pool must read `1`.
- `create_class`'s §7 rule 2 checks the DBC field = 0; the verifier and §8 check DAMM
  `pool.collect_fee_mode = 1`.
- The harness default is now 0 (`tests/integration/p0/src/config.ts`).
- Q2 is re-answered under this config as its authoritative result.
- The mechanism and the canon are unchanged: quote-only, non-compounding was always the intent.

---

## Canonical constants (fill as verified)

| Constant | Value | Source | Status |
|---|---|---|---|
| DBC program ID | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | DBC SDK 1.5.13 constant = manifest (asserted by `fixtures:check`); mainnet upgradeable program, ProgramData `HUfnSSiJ…CXCYh` (`mainnet-pins.json`) | **VERIFIED (mainnet)** 2 Oct. **Devnet 6 Oct: exists, executable, same ProgramData; binary differs** (§ Devnet) |
| DAMM v2 program ID | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | cp-amm SDK 1.4.8 + DBC SDK constants = manifest (asserted); mainnet ProgramData `AUh8bm2X…nyPH` | **VERIFIED (mainnet)** 2 Oct. **Devnet 6 Oct: exists, executable, same ProgramData; binary differs** (§ Devnet) |
| DLMM program ID | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | dlmm SDK 1.9.10 `LBCLMM_PROGRAM_IDS["mainnet-beta"]` = manifest (asserted); mainnet ProgramData `HZcJwcJ2…bEhu`. **The SDK's `localhost` entry is a different program (`LbVRzDTv…UhFQ`): pass the mainnet ID explicitly on localnet** | **VERIFIED (mainnet)** 2 Oct. **Devnet 6 Oct: exists, executable, same ProgramData; binary differs** (§ Devnet) |
| Metaplex Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | DBC SDK `METAPLEX_PROGRAM_ID` = manifest (asserted); mainnet ProgramData `PwDiXFxQ…fdYT`, immutable | **VERIFIED (mainnet)** 2 Oct |
| Jupiter locker | `LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn` | DBC SDK `LOCKER_PROGRAM_ID` = manifest (asserted); mainnet ProgramData `7yXf8ZG1…J6Yy` | **VERIFIED (mainnet)** 2 Oct |
| Meteora program upgrade authority (DBC, DAMM v2, DLMM) | `JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd` | mainnet ProgramData (`mainnet-pins.json`) | Observed 2 Oct; input to Q19 (admin powers) |
| SPL WSOL mint | `So11111111111111111111111111111111111111112` | §7 | LEAD |
| DAMM v2 max sqrt price (`s_max`) | `79226673521066979257578248091` | §2, §27 | LEAD — re-read from the pool at runtime, never hard-code into the engine |
| Ballast program ID | — | — | not deployed |
| Proof `dbc_config` | — | — | not created |
| Public `dbc_config` | — | — | not created |
| Multisig (admin + upgrade authority) | — | — | not created |

**Note:** the three Meteora program IDs appear abbreviated in the spec. *Done 2 Oct 2026:* expanded
from the SDK constants, matched against the spec's abbreviations, and read on mainnet as
upgradeable programs. The ID evidence is the **SDK constant plus the mainnet ProgramData read**.
Local execution is not ID evidence, because the local validator loads whatever ID the manifest
gives it; that is why `fixtures:check` asserts manifest ID = SDK constant. **Still open (before
the 6 Oct devnet deploy):** a devnet `getAccountInfo` of the three Meteora IDs, since §2 assumes
they are identical on devnet. Evidence: `evidence/step-1a/step2-decision.md`. *Done 6 Oct 2026:* see
§ Devnet below.

---

## Devnet

### Meteora program IDs on devnet — read 6 Oct 2026 (slot 508,103,963)

Evidence: `evidence/devnet/program-ids.json` (getAccountInfo, ProgramData headers,
`solana program dump -u devnet` + sha256).

| Program | Exists | Executable | ProgramData = mainnet's | Devnet deploy slot | Devnet upgrade authority | Binary = mainnet pin |
|---|---|---|---|---|---|---|
| DBC `dbcij3LW…` | yes | yes | yes (`HUfnSSiJ…`) | 503,167,099 | `DHLXnJdA…76ViX` | **no** (`f5ccbb01…`) |
| DAMM v2 `cpamdpZC…` | yes | yes | yes (`AUh8bm2X…`) | 503,166,267 | `DHLXnJdA…76ViX` | **no** (`82bb9375…`) |
| DLMM `LBUZKhRx…` | yes | yes | yes (`HZcJwcJ2…`) | 466,305,525 | `DHLXnJdA…76ViX` | **no** (`d8fa183b…`) |
| Token Metadata | yes | yes | yes | 363,279,440 | `6Vwz7AXY…` (upgradeable; immutable on mainnet) | no |
| Jupiter locker | yes | yes | yes | 366,583,728 | `DHLXnJdA…76ViX` | no |

Pinned accounts on devnet: `damm_v2_migration_config_customizable` **byte-identical** to the
mainnet pin; DBC pool authority, DAMM v2 pool authority, DLMM event authority exist (system-owned,
empty, as on mainnet). `dbc_event_authority` is **absent** on devnet (an unfunded Anchor
event-CPI PDA; it signs, it need not exist — watch the first devnet DBC call).

**Consequence:** the IDs are identical (§2 holds), but every devnet binary differs from mainnet, so
the devnet proof runs different Meteora code from `proof:local`. Per D-001 the mainnet-binary
result governs and each devnet divergence gets recorded.

### Devnet SOL budget — deploy + devnet proof (6 Oct 2026)

Rent-exempt minimum = (128 + bytes) × 6,960 lamports. Proof class = 10 SOL threshold (§22).

| Item | Lamports | SOL | Kept / returned |
|---|---|---|---|
| ProgramData, 500 KB `.so` (D-018 ceiling): (128 + 45 + 500,000) × 6,960 | 3,481,204,080 | 3.4812 | kept while deployed; `solana program close` refunds it |
| Program account (36 B) | 1,141,440 | 0.0011 | kept |
| Deploy buffer (37 + 500,000 B) | 3,481,148,400 | 3.4811 | **transient**, refunded when the deploy/upgrade finalises |
| Buys to the 10 SOL threshold incl. 1% fee (10 / 0.99, as §10's 25.2525 for 25) + dust buy | 10,102,010,102 | 10.1020 | ≈ 5.7 SOL comes back on the sell-out; ≈ 4.4 SOL stays locked in DAMM v2 for ever (§22) |
| Rents for DBC config/pool/mint/metadata, DLMM pair + 2 bin arrays + bitmap ext, DAMM pool/positions/NFTs, Ballast accounts, ATAs; tx fees | ≤ 500,000,000 | ≤ 0.5 | mostly kept |

- **Minimum to hold at peak: 14.1 SOL** (3.48 deployed + 10.10 buys + 0.5 rents/fees; the deploy
  buffer is refunded before the proof starts).
- **Recommended: 18 SOL** — adds one program upgrade during the devnet run (another transient
  3.48 SOL buffer).
- **Net spent if nothing is reclaimed:** ≈ 8.4 SOL (3.48 program + 4.4 locked + ≤ 0.5). Closing the
  program afterwards brings it to ≈ 4.9 SOL.
- At the current 339 KB the program items fall to 2.36 SOL each (peak 13.0 / 15.3 SOL).

---

### Devnet SOL budget — corrected 8 Oct 2026 (supersedes the 6 Oct table above)

Devnet's rent-exempt minimum is **5,080 lamports/byte** (`getMinimumBalanceForRentExemption`, read
8 Oct: 551,533 B → 2,802,437,880; 36 B → 833,120 = (36 + 128) × 5,080), not the 6,960 the 6 Oct table
assumed. At the current `.so` (551,488 B):

| Item | Lamports | SOL | |
|---|---|---|---|
| ProgramData (45 + 551,488 B) | 2,802,437,880 | 2.8024 | kept; `solana program close` refunds it |
| Program account (36 B) | 833,120 | 0.0008 | kept |
| Deploy buffer (37 + 551,488 B) | 2,802,397,240 | 2.8024 | transient, refunded at finalize |
| Write-transaction fees (≈ 545 × 5,000) | ≈ 2,725,000 | ≈ 0.003 | spent |
| Proof buys to the 10 SOL threshold incl. 1% fee + dust | 10,102,010,102 | 10.102 | ≈ 5.7 back on the sell-out; ≈ 4.4 stays locked (§22) |
| Rents (DBC/DLMM/DAMM/Ballast accounts, bin arrays), keeper's `partner_auth` order-rent float, fees | ≤ 600,000,000 | ≤ 0.6 | mostly kept |

- **Deploy: 2.806 SOL kept, 5.61 SOL at the peak.**
- **9 Oct deploy + proof: minimum 14.2 SOL, recommended 17 SOL** (one upgrade buffer). *Refined 8 Oct from the script as run (`pnpm proof:devnet`): team buys 3.5 + 3.5 + 3.2 SOL (wallets funded 3.6 / 3.6 / 3.35), admin 0.05 for the class rent, keeper's `partner_auth` order-rent float 0.2, rents ≈ 0.6; the script refuses to start below 14.2 SOL.* **Fund the devnet payer `F1s4kPpt5LHNV98YhoWcSDUhqiPsZaw6W41MRYjGrUT1`** (`.keys/devnet/payer.json`, gitignored).
- Net spent if nothing is reclaimed ≈ 7.8 SOL; ≈ 5.0 after `solana program close`.

---

## Mainnet transactions

Every mainnet signature, in order, with its runbook step. I execute these; Claude records them.

| # | Step | Signature | Slot | Notes |
|---|---|---|---|---|
