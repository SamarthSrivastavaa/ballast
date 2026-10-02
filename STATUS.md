# Ballast — Status

**Updated:** 2 Oct 2026 (STEP 1 and STEP 2 done; STEP 3 P0 harness next) · **Deadline:** 13 Oct 2026 06:59 UTC · **We submit 11 Oct.**

## Current state

| | |
|---|---|
| Phase | STEP 1 (decisions) **done**. STEP 2 (toolchain) **done: §16 pins kept**. Next: STEP 3 P0 harness (3 Oct) |
| Last passed gate | **none** — no §18 gate attempted |
| P0 gate (Q1–Q5) | **BLOCKING.** All five UNKNOWN. Answered on the mainnet-binary local validator (D-001) |
| Program code | none (correct — gated). `crates/floor` is exempt: pure math, no network |
| Floor engine | **done and proven:** 31 tests, 100k-case property gate, 10,010 differential matches (Rust = Python); builds for SBF under platform-tools rustc 1.79 |
| Meteora | **The five mainnet binaries execute** on Agave 2.1.21 at their real IDs (27/27 probes; DBC `create_partner_metadata` and Token Metadata `CreateMetadataAccountV3` ran to completion). Nothing deeper yet. `anchor build`/`anchor test` **pass** (lockfile method) |
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

## Next — STEP 3 (3 Oct): P0 harness on the mainnet-binary validator

Q1–Q9, Q11–Q16, Q18 exactly as the Top-20 table describes, plus (a) the lowest `migration_quote_threshold` DBC accepts, (b) manual migration at that size, (c) a Lite config migrating with 100% permanent lock. Every answer → `DECISIONS.md` with signatures + JSON in `evidence/p0/`. **Any Q1–Q5 failure: STOP, present the spec's fallback.**

Gotchas carried in: pass the **mainnet** DLMM ID explicitly to the DLMM SDK (its `localhost` entry is a different program, T7); measure CU locally but cross-check against mainnet `simulateTransaction` before deciding Q18 (T6).

First moves: `pnpm fixtures:check` → `pnpm localnet` → DBC `create_config` via the SDK (1.5.13) → simulate pool creation + migration to discover the mainnet accounts each program reads (D-001), then add them to `scripts/fixtures/manifest.json` and re-dump.

## Open risks

| Risk | Impact | Status |
|---|---|---|
| ~~platform-tools v1.43 vs edition-2024 deps~~ | — | **Resolved** by the lockfile method; guarded in CI |
| Local CU ≠ mainnet CU (Agave 2.1.21 cost model and feature set; finding T6) | Q18 decided on wrong numbers | Cross-check with mainnet `simulateTransaction` (read-only) or devnet before trusting a number near a limit |
| Q5 (PDA DLMM limit orders via CPI) | Kills the DLMM bid layer | UNKNOWN — 3 Oct |
| Q1/Q7 (permanent-lock atomicity / splittable creator position) | L stalled or under-counted | UNKNOWN — 3 Oct |
| Q18 (atomic redeem CU) | Forces two-step redeem | UNKNOWN — 5 Oct |
| **Program size > 300 KB (D-007)** — Anchor baseline is already ~210 KB (probe: 211,312 B at `opt-level = "z"`, which saves only 3%) | Deploy rent beyond the funding ask | **Open, measured.** Manual CPI builders; size reported every slice; owner decision if the first slice lands > 300 KB |
| No funding for mainnet Full deploy | Traction criterion (D-006) relies on Lite + Scanner | Funding message 7 Oct |
| No `V = 0` vector in `vectors.json` | Lite verifier path untested | Add before the verifier's Lite path |
| Meteora program IDs not yet read on **devnet** (§2 assumes identical) | 6 Oct devnet deploy targets wrong IDs | Open: devnet `getAccountInfo` of the three IDs before 6 Oct |
| Pinned bytes are only re-fetchable while mainnet still serves them | A Meteora upgrade makes old pins unreproducible from a fresh clone | Accepted; `fixtures:dump` refuses drift; consider archiving the `.so` files as a release asset before submission |
| `sudo` needs a password in WSL; `clang`/`unzip` absent | A build needing them stops | Ask the owner if it comes up |
| This Claude Code session opens in the stale OneDrive copy | Edits could land in the wrong tree | All work by absolute path in `/home/hp/ballast`; launch future sessions from `~/ballast` |

## In progress

Nothing half-built. STEP 2 is committed. The local validator is stopped. `pnpm localnet` restarts it from the pinned fixtures.
