# Ballast — Status

**Updated:** 4 Oct 2026 (STEP 3 resumed — Q2 unblocked by D-010; DLMM in progress) · **Deadline:** 13 Oct 2026 06:59 UTC · **We submit 11 Oct.**

## Current state

| | |
|---|---|
| Phase | STEP 3 (P0 harness) resumed. **Q2 unblocked: D-010 approved 4 Oct** and applied to `config.ts` + spec. Now on Q5/Q8/Q9 (DLMM) |
| Last passed gate | **none** — no §18 gate attempted |
| P0 gate (Q1–Q5) | **Q1 VERIFIED · Q2 FAILED as specified (correction tested, awaiting approval) · Q3 VERIFIED · Q4 VERIFIED · Q5 NOT RUN** |
| Open UNKNOWNs | 9 of 20 (Q5, Q7–Q10, Q17–Q20); Q14/Q15 partial. Verified: Q1, Q3, Q4, Q6, Q11, Q12, Q13, Q16 |
| Last commit | see `git log`; this field was stale. HEAD was `b408400` before this commit |
| Program code | none (correct — gated). `crates/floor` is exempt: pure math, no network |
| Floor engine | **done and proven:** 31 tests, 100k-case property gate, 10,010 differential matches (Rust = Python); builds for SBF under platform-tools rustc 1.79 |
| Meteora | Full DBC → DAMM v2 graduation runs on the mainnet binaries: config, pool, creator → PDA, buys, PDA fee claims via CPI, migration, 40 DAMM swaps, leftover. DLMM not yet exercised |
| Devnet SOL | not requested (STEP 3 runs locally; devnet comes 6 Oct) |
| Mainnet | untouched. D-007: no spend without per-transaction approval |
| Environment | `/home/hp/ballast` on ext4 in WSL Ubuntu (D-005). `source ~/.ballast-env` before every command |

## Calendar (replaces §28)

| Date | Work | Done when |
|---|---|---|
| **2 Oct** | Session check; STEP 1 decisions; **STEP 2 toolchain decision** (TEST 1 mainnet binaries execute on the local validator; TEST 2 lockfile pins → anchor build/test) | Decision recorded with evidence in `evidence/step-1a/` + `DECISIONS.md`; committed |
| **3 Oct** | **STEP 3 — P0 harness** on the mainnet-binary local validator: Q1–Q9, Q11–Q16, Q18; plus (a) lowest `migration_quote_threshold` DBC accepts, (b) manual migration at that size, (c) Lite config migrates with 100% permanent lock | Every answer in `DECISIONS.md` with signatures + JSON in `evidence/p0/`. **P0 go/no-go** |
| **4 Oct** | Program part 1: `initialize_global`, `create_class` (every §7 rule + a negative test per rule), `register_launch`, `settle_graduation`, `burn_leftover`. **Separate worktree:** Floor Scanner (read-only, free RPC tier, paginated + cached, never touches `programs/ballast`) | Tests green; `.so` size reported (≤ 300 KB target, D-007) |
| **5 Oct** | Program part 2: `open`, `refresh_floor`, `redeem` (atomic, CU measured), `harvest`, `deposit`, `floor` view + 1M-step model fuzz. Scanner live on mainnet. Lite config scripts with `--dry-run` | Fuzz clean; CU within §26 budgets |
| **6 Oct** | `pnpm proof:local` complete → `evidence/proof-local/`; devnet deploy + devnet proof → `evidence/proof-devnet/` | Verifier PASS on both |
| **7 Oct** | Draft the funding message (Meteora / Superteam: ~4–5 SOL deploy rent, refundable, with proof links); Lite outreach materials | Drafts ready for the owner |
| **8–9 Oct** | Minimal app (token page: floor, max loss if buying now, floor composition, redeem; Lite launch form); live stats page from on-chain data; `JUDGES.md`; README in §34 order. If funded: mainnet Full deploy via §19, owner signs every step | App builds; wording gate green |
| **10 Oct** | Feature freeze; demo checklist mapping each §35 step to evidence | Checklist complete |
| **11 Oct** | **Submit.** Afterwards only stats updates and fixes | Submitted |

Optional, with owner approval (~0.3 SOL): a tiny mainnet Lite proof if STEP 3 (a) shows a low threshold works.
Open challenge (no bounty): "make F go down" on devnet and Lite launches, rules per §24.

**Cut order if behind:** compiler CLI flags → stats polish → challenge page → Lite launch form (scripts instead).
**Never cut:** verifier, fuzz suite, `proof:local`, devnet proof, Floor Scanner CLI, `JUDGES.md`.

## Done

- [x] **STEP 0** guardrails — `CLAUDE.md`, `STATUS.md`, `DECISIONS.md`, `evidence/`, `.claude/` commands + agents (`842a773`)
- [x] **Floor crate** — §4/§11 exact; 31 tests; 100k property gate; 10,010 differential matches; D-003, D-004 (`d3e3fc9`, `b9f76c1`)
- [x] **Environment** — WSL Ubuntu ext4 (D-005); Agave 2.1.21, Anchor 0.31.1, Node 20.20.2, pnpm 9.15.4, rustc 1.85.0 (`9435abd`)
- [x] **D-002 condition 3** — `crates/floor` + `ruint` build for SBF under platform-tools v1.43 (rustc 1.79), 46,784-byte ELF
- [x] **STEP 1** (2 Oct) — D-001 exact wording; D-006, D-007, D-008 recorded; environment rule; CI wording gate extended to D-006's full list; spec markers on §3, §17, §18, §19, §22, §28 (`c246a6d`)
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
- [ ] Q2 authoritative re-run with the corrected value (after approval)
- [ ] Q5, Q8, Q9 (DLMM LimitOrder pair, PDA place/cancel, fills, reconciliation)
- [ ] Q7 (separate wallet-creator run; plus an overshoot-capable curve for Q14 fee basis + Q15 surplus)
- [ ] Q18 (approximate atomic redeem CU)
- [ ] (b) migration at the minimum size; (c) Lite 100% permanent
- [ ] mainnet `simulateTransaction` for config/pool/DLMM-pair creation (discovery so far is per-tx key checks)
- [ ] one clean end-to-end re-run on a fresh validator, so all evidence comes from one ledger

## Next task

Q2 is unblocked (D-010 approved 4 Oct, applied to `config.ts` and the spec). Remaining:
1. ~~Set `migratedCollectFeeMode = 0`~~ **done**; `[D-010]` markers applied to §7 and §8.
2. Clean full re-run of q12 → proof-setup → proof-buy → proof-premigration → proof-migrate → proof-post.
3. Build Q5 (DLMM): pair creation (Q8), PDA place/cancel via proxy, swap through, reconcile (Q9).
4. Q7, (b)/(c), Q18, then the report's go/no-go and `/handoff`.

Spec sections: Top-20 table, §7, §8, §9 (DLMM), §10, §26 (CU), §27 (bins).

## Open risks

| Risk | Impact | Status |
|---|---|---|
| ~~platform-tools v1.43 vs edition-2024 deps~~ | — | **Resolved** by the lockfile method; guarded in CI |
| Local CU ≠ mainnet CU (Agave 2.1.21 cost model and feature set; finding T6) | Q18 decided on wrong numbers | Cross-check with mainnet `simulateTransaction` (read-only) or devnet before trusting a number near a limit |
| Q5 (PDA DLMM limit orders via CPI) | Kills the DLMM bid layer | **UNKNOWN — next after the Q2 decision** |
| Q7 (splittable creator position) | L under-counted if the creator stays a wallet | UNKNOWN (Q1 atomicity VERIFIED); creator-PDA default works (transfer_pool_creator verified) |
| Q18 (atomic redeem CU) | Forces two-step redeem | UNKNOWN — 5 Oct |
| **Calendar slip:** STEP 3 was due 3 Oct; P0 not closed on 4 Oct | Program part 1 (4 Oct) starts late | Buffer: cut order in the calendar; P0 work resumes on approval |
| Program size (D-009: soft ≤ 400 KB; was 300 KB under D-007) — Anchor baseline ≈ 210 KB (T5) | Deploy rent if mainnet funding arrives | **Relaxed by D-009.** Size-optimised settings kept; size reported per slice; no build days on size |
| No funding for mainnet Full deploy | Traction criterion (D-006) relies on Lite + Scanner | Funding message 7 Oct |
| Meteora program IDs not yet read on **devnet** (§2 assumes identical) | 6 Oct devnet deploy targets wrong IDs | Open: devnet `getAccountInfo` of the three IDs before 6 Oct |
| Pinned bytes are only re-fetchable while mainnet still serves them | A Meteora upgrade makes old pins unreproducible from a fresh clone | Accepted; `fixtures:dump` refuses drift; consider archiving the `.so` files as a release asset before submission |
| `sudo` needs a password in WSL; `clang`/`unzip` absent | A build needing them stops | Ask the owner if it comes up |
| This Claude Code session opens in the stale OneDrive copy | Edits could land in the wrong tree | All work by absolute path in `/home/hp/ballast`; launch future sessions from `~/ballast` |
| ~~No public remote~~ | — | **Resolved 2 Oct:** `origin` = github.com/SamarthSrivastavaa/ballast (DECISIONS § Environment). Pushing needs GitHub auth in WSL (no `gh`, no credential helper yet) |
| Identity-rewrite leftovers: branch `backup/pre-identity-rewrite`, `refs/original/refs/heads/main` | Old-email commits remain reachable locally (never pushed) | Delete both once the owner confirms (`git branch -D backup/pre-identity-rewrite; git update-ref -d refs/original/refs/heads/main`) |
| Test validator writes a `None` upgrade authority as the all-zero key (T8) | ProgramData header not byte-identical to mainnet for Token Metadata | Accepted and documented; bytes identical; `fixtures:exec` allows exactly this one encoding |

## In progress

STEP 3 is **paused, not half-built**: everything run so far is committed with its evidence. To
resume on a fresh ledger:

```bash
source ~/.ballast-env && cd ~/ballast
pnpm localnet --quiet &                     # mainnet-binary validator (online fixtures check first)
bash tests/integration/p0/up.sh             # fund payer, deploy p0_harness
pnpm exec tsx tests/integration/p0/src/run.ts q12 qa proof-setup proof-buy proof-premigration proof-migrate proof-post
```

A run that stops with `NEEDS CLONE` names a mainnet account to pin: `bash tests/integration/p0/clone.sh
<name> <address> "<why>" "<step>"`, then restart `pnpm localnet`.
