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
| `git remote origin` | **The stale OneDrive copy above, not GitHub.** Nothing has been pushed anywhere public. Do not push to it (environment rule). A public GitHub remote is the owner's action (D-006) |
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
errors on `S = 0` and on the §4 bounds (`crates/floor/src/lib.rs`, `FloorError`). **No `V = 0`
vector exists yet.** One must be added to `vectors.json` and the Python reference before the
verifier's Lite path relies on it. Whether a Lite config can migrate with 100% permanent lock is
STEP 3 check (c).

---

## Canonical constants (fill as verified)

| Constant | Value | Source | Status |
|---|---|---|---|
| DBC program ID | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | DBC SDK 1.5.13 constant = manifest (asserted by `fixtures:check`); mainnet upgradeable program, ProgramData `HUfnSSiJ…CXCYh` (`mainnet-pins.json`) | **VERIFIED (mainnet)** 2 Oct. Devnet ID read open (before 6 Oct) |
| DAMM v2 program ID | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | cp-amm SDK 1.4.8 + DBC SDK constants = manifest (asserted); mainnet ProgramData `AUh8bm2X…nyPH` | **VERIFIED (mainnet)** 2 Oct. Devnet ID read open |
| DLMM program ID | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | dlmm SDK 1.9.10 `LBCLMM_PROGRAM_IDS["mainnet-beta"]` = manifest (asserted); mainnet ProgramData `HZcJwcJ2…bEhu`. **The SDK's `localhost` entry is a different program (`LbVRzDTv…UhFQ`): pass the mainnet ID explicitly on localnet** | **VERIFIED (mainnet)** 2 Oct. Devnet ID read open |
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
they are identical on devnet. Evidence: `evidence/step-1a/step2-decision.md`.

---

## Mainnet transactions

Every mainnet signature, in order, with its runbook step. I execute these; Claude records them.

| # | Step | Signature | Slot | Notes |
|---|---|---|---|---|
