# Ballast — Decisions & Evidence Log

The record of every Top-20 answer, every toolchain pin, and every deviation from the spec.

**Rules for this file**
- A question is **VERIFIED** only with a devnet (or mainnet) transaction signature recorded here and a
  JSON account dump in `evidence/`. Docs, SDK source, and the `meteora-researcher` agent produce **LEADS**,
  never verifications.
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
| 1 | **P0** | Does one `migration_damm_v2` tx leave partner and creator positions with all liquidity in `permanent_locked_liquidity` (unlocked = 0, vested = 0)? | Atomic, fully permanent | UNKNOWN | | |
| 2 | **P0** | Is the migrated pool `collect_fee_mode = 1` (OnlyB), non-compounding, full range (`sqrt_min_price` = MIN, `sqrt_max_price` = MAX), and do swaps and fee claims leave `pool.liquidity` and position liquidity unchanged? | All unchanged; full range | UNKNOWN | | |
| 3 | **P0** | Does pool state satisfy `amount_A = L·(s_max − s)/(s·s_max)` and `amount_B = L·(s − s_min)/2^128` with Q64 sqrt prices? | Equal within ≤ 2 base units | UNKNOWN | | |
| 4 | **P0** | Can a Ballast PDA, as `fee_claimer`, CPI `withdraw_migration_fee` (partner), `claim_trading_fee`, `partner_withdraw_surplus`? What destination accounts are allowed? | Works; destinations are token accounts owned by the fee claimer | UNKNOWN | | |
| 5 | **P0** | Can the PDA CPI DLMM `place_limit_order` (sender = owner = PDA, fresh keypair order account signing from the outer tx) and `cancel_limit_order`? Do fills stay filled? Does cancel return unfilled quote + filled base + fees? | Yes on all counts | UNKNOWN | | |
| 6 | P1 | Who owns the partner position NFT after migration (`fee_claimer`?), and can the PDA call `claim_position_fee` on it? | Owner = fee claimer | UNKNOWN | | |
| 7 | P1 | Can the creator `split_position` (or otherwise move) permanently locked liquidity into new positions? | Likely yes (owner-only endpoint) | UNKNOWN | | |
| 8 | P1 | DLMM customizable permissionless pair: seeds, uniqueness, creator/operator powers (pool status); can the PDA create it via CPI? | Pair unique per (mints, bin step); no post-activation creator powers | UNKNOWN | | |
| 9 | P1 | DLMM limits: allowed bin steps and base fee, activation, collect-fee mode, minimum order size, ≤ 50 bins, bitmap-extension needs around bin ids −11,000 to −12,000 | Feasible with bitmap extension | UNKNOWN | | |
| 10 | P1 | Does Jupiter route to the fresh DLMM pair and DAMM v2 pool, and how fast? | Within hours | UNKNOWN | | *Mainnet-only — Jupiter does not route on devnet (§18)* |
| 11 | P1 | Is the DBC base mint's freeze authority `None`? | None | UNKNOWN | | |
| 12 | P1 | Exact `PoolConfig` / `VirtualPool` layouts for the deployed DBC version; enum encodings (`migration_fee_option` customizable, `collect_fee_mode`, `token_type`) | Match | UNKNOWN | | |
| 13 | P1 | Fee semantics: flat 1% encoding, dynamic fee off, `creator_trading_fee_percentage`, protocol and referral cuts; partner claim = partner share exactly | Matches docs | UNKNOWN | | |
| 14 | P1 | Migration accounting: fee on threshold or reserve? How is the 0.2% protocol liquidity share taken? Exact Q_d, B_m, L_total vs L_perm | Protocol remainder is an unlocked position, excluded from L | UNKNOWN | | |
| 15 | P1 | Overshoot: can the completing swap exceed the threshold; when is partner surplus withdrawable; `swap2` partial-fill behaviour | Surplus exists; withdrawable after completion | UNKNOWN | | |
| 16 | P2 | Is `withdraw_leftover` permissionless, to `leftover_receiver`'s token account, only after `CreatedPool`? | Yes | UNKNOWN | | |
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

## §18 Devnet gates

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

**Status: Rust leg RESOLVED and proven; Solana/Anchor/Node legs still TBD.**

§16 states its pins are "the starting set" and that "each must be confirmed" on day 1. That check
ran on 2 Oct 2026 and the Rust pin failed, for a concrete reason recorded below.

### Confirmed pins (proven to build and test)

| Tool | §16 starting pin | **Final pin** | Evidence |
|---|---|---|---|
| Rust (host) | 1.84 stable | **1.85.0** stable | `rust-toolchain.toml`; `cargo test -p ballast-floor` → 25 pass; `cargo clippy --all-targets -- -D warnings` clean; `cargo fmt --check` clean |
| `ruint` | unversioned, no_std | **=1.12.3** | builds `no_std`, `default-features = false`; 1.16+ requires Rust 1.90 |
| `proptest` | (§14 property layer) | **=1.5.0** | 100k-case gate passes in 16.7 s |
| `serde_json` (dev) | — | **=1.0.133** | differential test only; 1.0.151 pulls `zmij`, needs newer Rust |
| Python (reference) | — | **3.11.9** | §27 self-test: 10/10 vectors, both redeem payouts |

### Why the Rust pin moved 1.84 → 1.85.0

`proptest` — required by §14 for the property layer — transitively requires `getrandom` 0.4.x,
whose manifest uses `edition2024`. Cargo 1.84 cannot parse an edition-2024 manifest:

```
error: failed to parse manifest at .../getrandom-0.4.3/Cargo.toml
  feature `edition2024` is required
  ... not stabilized in this version of Cargo (1.84.0)
```

Pinning `getrandom = "=0.2.15"` does **not** fix it: the requirement inside proptest's tree is a
caret on a major version, so cargo resolves both 0.2.15 and 0.4.3 and still fails on the latter.
The alternatives were (a) drop proptest, losing the §14 property layer, or (b) move the host
compiler to 1.85.0, the first edition-2024 stable. (b) was taken: it keeps more of the spec.
1.85.0 remains inside Anchor 0.31's supported range. **Still to confirm:** that Anchor 0.31.1 and
Agave 2.1.x's platform tools build the program on 1.85.0 (`cargo build-sbf`) — that is the next
toolchain gate, and it could move this pin again.

### Still unresolved — blocking every gate

| Tool | §16 pin | Installed | Action |
|---|---|---|---|
| Agave / Solana CLI | 2.1.x | **1.18.26** (pre-Agave) | install Agave 2.1.x; confirm `cargo build-sbf` |
| Anchor CLI | 0.31.1 | **0.32.1** | `avm install 0.31.1 && avm use 0.31.1` |
| Node | 20 LTS | **24.15.0** | install 20 LTS |
| pnpm | 9 (workspaces) | **absent** | install; pin `packageManager` in the repo root |
| TypeScript | 5.6 | absent | with the SDK slice |
| `wasm-pack` / `wasm-bindgen` | required | **absent** | with the floor-wasm slice |

A gate run on a mismatched toolchain proves nothing; `/gate` refuses to run while these are TBD.

---

---

## Environment

| Item | Finding | Consequence |
|---|---|---|
| Host OS | Windows 11 (win32), not Linux | `anchor test` / `solana-test-validator` with `[[test.genesis]]`-loaded Meteora `.so` files is **unproven** on Windows. §14 and §17 depend on it for every integration and negative test. |
| WSL | Installed; **only distro is `docker-desktop`** (stopped). No general-purpose Linux distro. | A Linux path exists but needs a distro installed, or Docker, before it can host the validator. |
| Repo root | `C:\Users\HP\OneDrive\Desktop\meteora` | **Inside OneDrive.** File-sync locking and `target/` churn can corrupt builds and slow `cargo`. Worth moving the repo outside OneDrive or excluding it from sync. |
| Parent `package.json` | `C:\Users\HP\package.json` with `packageManager` = yarn and ~20 unrelated deps | pnpm/corepack may resolve the wrong manager; node module resolution may walk up into it. Pin `packageManager: pnpm@9.x` in the repo root. |
| Git | Repo initialised on `main`, 2 Oct 2026. No commits yet. | — |
| Spec path | Export arrived as `docs/spec/Build Spec.md`; renamed to `docs/spec/BUILD_SPEC.md` | Canonical path per the playbook; all tooling references resolve. |
| `docs/spec/SUBMISSION.md` | **Not present** | Optional (demo/README copy only). Export it from the Ballast doc's "Final Submission — War Room" tab when writing the README (§34). |

---

## Deviations and spec-internal findings

Two internal inconsistencies in the spec surfaced while implementing §4. Both are recorded with
the conservative reading taken; **both need approval**, and neither changes the mechanism.

| # | Sections | Finding | Reading taken | Status |
|---|---|---|---|---|
| F1 | §4 vs §27 | §4 bounds say `L < 2^120` strictly. §27's boundary vector "Max supply, 1,000 SOL vault, L = 2^120" uses `L` at **exactly** 2^120, and §27 requires Rust to reproduce its `s` exactly. The two cannot both hold. | **Inclusive, `L ≤ 2^120`.** It keeps the spec self-consistent and is overflow-safe: §4's headroom argument needs `B² < 2^240`, and at `L = 2^120` exactly `B² = 2^240 < 2^256`. The strict reading would make a published vector uncomputable. | **Pending approval** |
| F2 | §4 vs §14 | §14 requires the property "monotone in L" unconditionally. §4's conservative `A = S + ⌈L/s_max⌉` violates it whenever an increase in `L` crosses a multiple of `s_max`: `A` gains a whole base unit while `B` gains only `ΔL`. Minimal counterexample found by proptest: `V = u64::MAX, S = 1, L = 0 → 1` lowers `F`. | Monotone-in-L is tested **within a ceiling step** (where `⌈L/s_max⌉` is unchanged), which is the statement that is actually true of §4's formula. The counterexample is pinned in a named test so a future rounding change cannot hide it. **No impact on the mechanism:** §4's own transition table lists an L change as "Impossible (permanent lock, PDA-owned positions)", and a decrease is covered by the §8 `BackingDecreased` fail-safe. Rounding `A` up always understates `F`, the safe direction. | **Pending approval** |

Evidence: `crates/floor/src/lib.rs` (`L_MAX` doc comment), `crates/floor/tests/properties.rs`
(`monotone_in_l_within_a_ceiling_step`, `ceiling_step_can_lower_f`).

### Approved deviations

None yet.

| Date | Spec section | Observed | Minimum correction | Approved by | Evidence |
|---|---|---|---|---|---|

---

## Canonical constants (fill as verified)

| Constant | Value | Source | Status |
|---|---|---|---|
| DBC program ID | `dbcij3…MaqN` (spec §2, abbreviated — expand and verify) | Meteora docs | LEAD |
| DAMM v2 program ID | `cpamdp…sGG` (abbreviated — expand and verify) | Meteora docs | LEAD |
| DLMM program ID | `LBUZKh…wxo` (abbreviated — expand and verify) | Meteora docs | LEAD |
| SPL WSOL mint | `So11111111111111111111111111111111111111112` | §7 | LEAD |
| DAMM v2 max sqrt price (`s_max`) | `79226673521066979257578248091` | §2, §27 | LEAD — re-read from the pool at runtime, never hard-code into the engine |
| Ballast program ID | — | — | not deployed |
| Proof `dbc_config` | — | — | not created |
| Public `dbc_config` | — | — | not created |
| Multisig (admin + upgrade authority) | — | — | not created |

**Note:** the three Meteora program IDs appear abbreviated in the spec. Expand them from Meteora docs
and byte-verify on devnet before compiling any of them into the program (`meteora-researcher` produces
the lead; a devnet account read confirms it).

---

## Mainnet transactions

Every mainnet signature, in order, with its runbook step. I execute these; Claude records them.

| # | Step | Signature | Slot | Notes |
|---|---|---|---|---|
