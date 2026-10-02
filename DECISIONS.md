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

**Status: every §16 pin satisfied and proven on Linux, except one open decision on platform-tools.**
Verified 2 Oct 2026 in WSL Ubuntu (D-005). Full evidence: `evidence/step-1a/result.md`.

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
| platform-tools | not pinned by §16 | **v1.43, rustc 1.79.0** (bundled with Agave 2.1.21) | **see the open decision below** |

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

### OPEN DECISION — platform-tools cannot build the Anchor program tree

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

Recommendation: **A**.

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

### Correction to an earlier premise

There have been **no Meteora local-validator runs** at any point. No validator has been started, no
`anchor build` or `anchor test` has succeeded, and no Meteora `.so` has been fetched. The "10/10"
figure refers to the Python reference reproducing the ten §27 **numerical** vectors — pure integer
arithmetic, no network. **The integration layer is entirely unproven.**

---

## Decision register

Approved by the project owner on 2 Oct 2026 unless stated otherwise. A decision here overrides the
spec text; where it amends the spec, the amendment has been applied to `docs/spec/BUILD_SPEC.md`
with a `[D-00n]` marker so the spec and the code cannot drift apart.

### D-001 — Fixtures and the local validator use mainnet binaries and mainnet accounts

**Status: APPROVED — but reconstructed, please confirm the wording.** The decision was referenced
to me as "adjusted per D-001" without its text, so what follows is inferred from the STEP 1C
instructions given alongside it. Correct it if this is not what was meant.

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
| Method | `git clone` from the Windows path, so history is preserved: 3 commits, `02cd402` at HEAD, `git status` clean |
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
