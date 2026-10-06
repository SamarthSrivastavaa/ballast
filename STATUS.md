# Ballast — Status

**Updated:** 6 Oct 2026 — **Program Part 1 done** (5 of 11 instructions, mainnet-binary local validator) · **Deadline:** 13 Oct 2026 06:59 UTC · **We submit 11 Oct.**

## Current state

| | |
|---|---|
| Phase | **Program Part 1 complete** (§6): `initialize_global`, `create_class`, `register_launch`, `settle_graduation`, `burn_leftover`. Next: Part 2 (`open`, `refresh_floor`, `redeem`, `harvest`, `deposit`) |
| Last passed gate | **none** — no §18 gate attempted (gate 2 "graduation and migration" and gate 4 "vault funding" are now exercisable locally) |
| P0 gate (Q1–Q5) | **ALL FIVE VERIFIED** (4 Oct) |
| Program tests | One fresh-ledger run, mainnet binaries: config **41 pass / 0 fail / 9 unreachable**; `register_launch` **19 / 0 / 1**; `settle_graduation` + `burn_leftover` **26 / 0 / 1** (`evidence/program/part1/`). Migration fee exactly 1,500,000,000; leftover 134,558,940,128,191 burned, supply drop = burn |
| Program size | **339,216 B** after D-018 (`no-idl` + hand-built `CreateAccount`; was 381,952). D-018 accepts up to ≈ 500 KB |
| CU (local) | `register_launch` 59k (whole launch tx 305k, 875 B); `settle_graduation` 116k; `burn_leftover` 82k (62k when the leftover was front-run) |
| Decisions this slice | **D-016** (graduation routing; `burn_leftover` requires `Funded`; beneficiary is an outside ATA; leftover front-run) — APPROVED 6 Oct |
| Decisions 6 Oct | **D-017** rule-4 band T = 4,580,461 (measured max + 2), prediction at the lower-F end (pins unchanged); **D-018** size; **D-019** calendar + cuts |
| Floor engine | done and proven: 31 tests, 100k-case property gate, 10,010 differential matches (Rust = Python) |
| Devnet | Meteora IDs read 6 Oct: all exist + executable, same ProgramData, **binaries differ from mainnet** (`DECISIONS.md` § Devnet). SOL needed: **14.1 min / 18 recommended** |
| Mainnet | untouched. D-007: no spend without per-transaction approval |
| Environment | `/home/hp/ballast` on ext4 in WSL Ubuntu (D-005). `source ~/.ballast-env` before every command |

## Calendar (D-019, 6 Oct 2026 — replaces §28 and the 2 Oct calendar)

| Date | Work | Done when |
|---|---|---|
| **6 Oct** (today) | Program Part 2 core: `open` → `refresh_floor` → `redeem` → `floor`; then `harvest` → `deposit` | Fresh-ledger suite green; CU vs §26; `.so` size; `/audit` 0 critical/high; pushed |
| **7 Oct** (+1) | Full-lifecycle test = `pnpm proof:local` + lifecycle fuzzer | `evidence/proof-local/` summary table; fuzz clean |
| **8 Oct** (+2) | Verifier CLI + devnet deploy/proof | Verifier PASS on local and devnet; `evidence/proof-devnet/` |
| **9 Oct** (+3) | Floor Scanner + Lite config + keeper scripts | Scanner CLI on mainnet; Lite config script `--dry-run` |
| **10 Oct** (+4) | Token page + README + `JUDGES.md` | App builds; wording gate green |
| **11 Oct** | Video + **submit** | Submitted |
| **12 Oct** | Buffer | — |

**CUT (D-019):** compiler CLI flags · stats page (→ README evidence table) · challenge page (→ README
section) · Lite launch form (→ scripts).
**Never cut:** verifier, fuzzer, `proof:local`, devnet proof, scanner CLI, `JUDGES.md`.

## Done

- [x] **STEP 0** guardrails — `CLAUDE.md`, `STATUS.md`, `DECISIONS.md`, `evidence/`, `.claude/` commands + agents (`842a773`)
- [x] **Floor crate** — §4/§11 exact; 31 tests; 100k property gate; 10,010 differential matches; D-003, D-004 (`d3e3fc9`, `b9f76c1`)
- [x] **Environment** — WSL Ubuntu ext4 (D-005); Agave 2.1.21, Anchor 0.31.1, Node 20.20.2, pnpm 9.15.4, rustc 1.85.0 (`9435abd`)
- [x] **D-002 condition 3** — `crates/floor` + `ruint` build for SBF under platform-tools v1.43 (rustc 1.79), 46,784-byte ELF
- [x] **STEP 1** (2 Oct) — D-001 exact wording; D-006, D-007, D-008 recorded; environment rule; CI wording gate extended to D-006's full list; spec markers on §3, §17, §18, §19, §22, §28 (`c246a6d`)
- [x] **Program Part 1** (§6, 4–6 Oct) — `initialize_global` (upgrade-authority gated), `create_class` (every §7 rule, one error + one negative test each), `register_launch` (D-011 atomic launch tx, 15 single-defect negatives + D-016 beneficiary checks), `settle_graduation`, `burn_leftover` (normal order, keeper lag, and leftover front-run before/after a late settle). `/audit`: 0 critical · 0 high · 5 medium — 3 fixed in code, 2 recorded as D-016
- [x] **Commit identity** — all history re-authored to `samarthsrivastava897@gmail.com` (dates and trees unchanged; old→new hash map in `DECISIONS.md` § History rewrite; backup branch `backup/pre-identity-rewrite`)

## STEP 2 — toolchain decision (2 Oct) · DONE

**Rule outcome: both tests pass → §16 pins kept** (Agave 2.1.21, Anchor 0.31.1, platform-tools v1.43).
Evidence: `evidence/step-1a/step2-decision.md`.

- [x] TEST 1: `pnpm fixtures:dump` → `evidence/fixtures/mainnet-pins.json` (sha256 + last-deployed slot + authority, five programs; byte-identical to `solana program dump`); `pnpm localnet` boots them at their real IDs; `pnpm fixtures:exec` **27/27** (2 full instructions, 21 dispatch probes, 4 negative controls)
- [x] TEST 2: MSRV-aware lockfile (`rust-version = "1.79"` + `--precise` for `blake3`, `solana-program`, `anchor-*`) → `anchor build` ✓, `anchor test` ✓ (§27 vector on-chain), `cargo build-sbf` on the floor crate ✓; guard `scripts/toolchain/check_lock.py` in CI
- [x] RULE applied; recorded in `DECISIONS.md` § Toolchain (findings T2–T8)
- [x] `/audit`: 0 critical · 1 high · 10 medium · 1 wording, **all fixed**. Re-audit confirmed the fixes; its 9 new mediums are also fixed. `scripts/fixtures/negative-tests.sh`: **14/14 guards refuse** (`evidence/step-1a/hardening.txt`). Final TEST 1 run on the hardened harness: 27/27, served bytes measured = pins

## STEP 3 — P0 harness (started 2 Oct, resumed 4 Oct) · STOPPED at Q2

**Why stopped:** §7's DBC `migrated_pool_fee.collect_fee_mode = 1` yields a DAMM **BothToken**
pool. DBC numbers its enum {0 QuoteToken, 1 OutputToken, 2 Compounding}; DAMM's is
{0 BothToken, 1 OnlyB, 2 Compounding}. DBC value 0 was tested to give OnlyB with constant L.
**Proposed one-value correction**, not applied: `DECISIONS.md` § OPEN DECISION Q2;
`evidence/p0/REPORT.md`.

- [x] Harness: `tests/integration/p0/` (Anchor proxy program `p0_harness` 188,560 B + TS runner;
  `up.sh` / `clone.sh`)
- [x] `crates/meteora-types`: generated from the vendored IDLs; field-for-field = SDK on real
  accounts (`cargo test -p meteora-types`)
- [x] Q12, (a), Q1, Q3, Q4, Q6, Q11, Q13, Q16 answered; Q14, Q15 mostly answered — see `DECISIONS.md` Top-20
- [x] 4 mainnet accounts discovered by execution and pinned
- [x] Q2 authoritative re-run with D-010's value — pool is DAMM OnlyB, constant L (clean ledger)
- [x] **Q5, Q8, Q9** — LimitOrder pair created by `partner_auth` via CPI; PDA bid placed (37,463 CU);
  seller fill persists; cancel returned filled base + unfilled quote + fees exactly and closed the
  order (56,884 CU). Bin steps 1–50 accepted; bid-bin `initialize_bin_array` ≈ 199k CU
- [ ] Q7 (separate wallet-creator run; plus an overshoot-capable curve for Q14 fee basis + Q15 surplus)
- [ ] Q18 (approximate atomic redeem CU)
- [ ] (b) migration at the minimum size; (c) Lite 100% permanent
- [ ] mainnet `simulateTransaction` for config/pool/DLMM-pair creation (discovery so far is per-tx key checks)
- [ ] one clean end-to-end re-run on a fresh validator, so all evidence comes from one ledger

## Next task

**Program Part 2 (§6):** `open` (positions recorded and verified permanent, F via `ballast-floor`,
`s_open ≥ predicted_s`, bid via DLMM `place_limit_order` from the vault — D-012, bin arrays by the
keeper — D-013), then `refresh_floor`, atomic `redeem` (CU vs §26), `harvest`, `deposit`; every
mutating instruction ends with the §4 monotone check. Tests first on the mainnet-binary validator.

Also owed: devnet read of the three Meteora program IDs (risk below); Q7, Q18, extra checks (b)/(c);
the owner's call on the §7 rule 4 OPEN DECISION.

## Open risks

| Risk | Impact | Status |
|---|---|---|
| ~~platform-tools v1.43 vs edition-2024 deps~~ | — | **Resolved** by the lockfile method; guarded in CI |
| Local CU ≠ mainnet CU (Agave 2.1.21 cost model and feature set; finding T6) | Q18 decided on wrong numbers | Cross-check with mainnet `simulateTransaction` (read-only) or devnet before trusting a number near a limit |
| Q5 (PDA DLMM limit orders via CPI) | Kills the DLMM bid layer | **UNKNOWN — next after the Q2 decision** |
| Q7 (splittable creator position) | L under-counted if the creator stays a wallet | UNKNOWN (Q1 atomicity VERIFIED); creator-PDA default works (transfer_pool_creator verified) |
| Q18 (atomic redeem CU) | Forces two-step redeem | UNKNOWN — 5 Oct |
| **Calendar slip:** Program Part 1 (due 4 Oct) closed 6 Oct; Part 2 (due 5 Oct) and the local + devnet proof (due 6 Oct) not started | Squeezes the 7–10 Oct app/README days | Cut order in the calendar applies; the owner may want to re-plan 7–11 Oct |
| Program size (D-009: soft ≤ 400 KB) — 381,952 B with 5 of 11 instructions | Part 2 will push it over 400 KB | Size log in D-009. Known cheap cuts: Anchor `no-idl` feature (IDL instructions ≈ 15 KB), hand-built `create_account` (drops bincode) |
| No funding for mainnet Full deploy | Traction criterion (D-006) relies on Lite + Scanner | Funding message 7 Oct |
| Meteora program IDs not yet read on **devnet** (§2 assumes identical) | 6 Oct devnet deploy targets wrong IDs | Open: devnet `getAccountInfo` of the three IDs before 6 Oct |
| Pinned bytes are only re-fetchable while mainnet still serves them | A Meteora upgrade makes old pins unreproducible from a fresh clone | Accepted; `fixtures:dump` refuses drift; consider archiving the `.so` files as a release asset before submission |
| `sudo` needs a password in WSL; `clang`/`unzip` absent | A build needing them stops | Ask the owner if it comes up |
| This Claude Code session opens in the stale OneDrive copy | Edits could land in the wrong tree | All work by absolute path in `/home/hp/ballast`; launch future sessions from `~/ballast` |
| ~~No public remote~~ | — | **Resolved 2 Oct:** `origin` = github.com/SamarthSrivastavaa/ballast (DECISIONS § Environment). Pushing needs GitHub auth in WSL (no `gh`, no credential helper yet) |
| Identity-rewrite leftovers: branch `backup/pre-identity-rewrite`, `refs/original/refs/heads/main` | Old-email commits remain reachable locally (never pushed) | Delete both once the owner confirms (`git branch -D backup/pre-identity-rewrite; git update-ref -d refs/original/refs/heads/main`) |
| Test validator writes a `None` upgrade authority as the all-zero key (T8) | ProgramData header not byte-identical to mainnet for Token Metadata | Accepted and documented; bytes identical; `fixtures:exec` allows exactly this one encoding |

## In progress

Nothing half-built: Program Part 1 is committed with its evidence. To re-run on a fresh ledger:

```bash
source ~/.ballast-env && cd ~/ballast
pnpm localnet --quiet &                              # mainnet-binary validator (fresh ledger)
bash tests/integration/p0/up.sh                      # fund the payer
anchor build && pnpm exec tsx tests/integration/program/run.ts   # part1 → part2 → part3 (one ledger)
```

A run that stops with `NEEDS CLONE` names a mainnet account to pin: `bash tests/integration/p0/clone.sh
<name> <address> "<why>" "<step>"`, then restart `pnpm localnet`.
