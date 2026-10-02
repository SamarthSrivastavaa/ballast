# Ballast — Status

**Updated:** 2 Oct 2026 (STEP 1A — environment moved, toolchain pinned) · **Deadline:** 13 Oct 2026 06:59 UTC (plan to submit 12 Oct)

## Current state

| | |
|---|---|
| Phase | STEP 1B done. STEP 1A **blocked** on one platform-tools decision |
| Last passed gate | **none** — §18 gate 1 not yet attempted |
| P0 gate (Q1–Q5) | **BLOCKING.** All five UNKNOWN. Nothing beyond test harnesses may be built. |
| Open UNKNOWNs | 12 of 20 Top-20 questions (see `DECISIONS.md`) |
| Program code | none (correct — gated). `crates/floor` is exempt: pure math, no network |
| Floor engine | **§4/§11 implemented; all 10 §27 vectors exact; 25 tests + 100k property gate green** |
| Devnet SOL | not yet requested |
| Mainnet | untouched |
| Environment | **moved to `/home/hp/ballast`** in WSL Ubuntu 26.04.1 (D-005); every §16 pin installed and proven on Linux |
| Blocked on | **your decision**: platform-tools v1.43 (cargo 1.79) cannot build the Anchor tree — `DECISIONS.md` § OPEN DECISION |

### Read this first

**Blocked, needing one decision.** `anchor build` / `anchor test` cannot run: platform-tools v1.43
(bundled with Agave 2.1.21) ships cargo 1.79.0, which cannot parse the `edition = "2024"` manifests
the Anchor 0.31.1 + Solana 2.1.21 tree now resolves. The offending link is unpinnable. Options and a
recommendation are in `DECISIONS.md` § OPEN DECISION; D-002 condition 4 means I may not change the
toolchain without asking. **This blocks STEP 1C and 1D.**

**Resolved since the last update:** the Windows/OneDrive and local-validator risks are gone — the
repo now lives at `/home/hp/ballast` on ext4 in WSL Ubuntu (D-005), and every §16 pin is installed
and proven there (Agave 2.1.21, Anchor 0.31.1, Node 20.20.2, pnpm 9.15.4, wasm-pack 0.13.1).

**Schedule:** §28's plan starts 1 Oct; it is 2 Oct and Day 1 is not finished. The floor crate (1B)
is complete and is the critical-path item, but 1C and 1D have not started. Buffer days 7 and 11 are
the slack.

## STEP 0 — Guardrails

- [x] Read `docs/spec/BUILD_SPEC.md` in full (1159 lines, 35 sections + Top-20 table)
- [x] Normalise spec path (`Build Spec.md` → `docs/spec/BUILD_SPEC.md`); `git init` on `main`
- [x] `CLAUDE.md` (134 lines) — mission, §4 equation + code rules, §1 six corrections, banned wording,
      P0 gate rule, §15 layout, §16 pins, commands, context and bookkeeping rules
- [x] `STATUS.md` — this file
- [x] `DECISIONS.md` — Top-20 table, all Status = UNKNOWN, Evidence empty
- [x] `evidence/README.md`
- [x] `.claude/commands/` — `slice`, `gate`, `audit`, `handoff`
- [x] `.claude/agents/` — `spec-auditor`, `security-reviewer`, `meteora-researcher`
- [x] `.claude/settings.json` + `/permissions` verified
- [x] Approved; committed as `a727dc1`

## Day 1 — 1 Oct (§33) · NOT STARTED, overdue

Deliverable: Q1–Q4, Q6, Q7, Q11–Q14 answered. Acceptance: §18 gates 1–3.
Blocker → fallback: Q1/Q7 fail → creator-PDA default; Q4 fail → disclosed hot-wallet claimer.

- [~] **A.** Scaffold + toolchain. **Mostly done; one blocker.**
      §15 skeleton, Cargo workspace, `.gitattributes` (LF for bit-for-bit `vectors.json`), CI with
      fmt, clippy `-D warnings`, tests, the 100k property gate, a `vectors.json` reproducibility
      check and a §21 wording grep.
      **Repo moved to `/home/hp/ballast`** (WSL Ubuntu, ext4) per D-005 — clone, clean, LF intact.
      **All §16 pins installed and proven on Linux:** rustc 1.85.0, Agave 2.1.21, Anchor 0.31.1
      (avm 0.31.1), Node 20.20.2, pnpm 9.15.4, wasm-pack 0.13.1, Python 3.14.4.
      **`cargo build-sbf` proves D-002 condition 3** — `crates/floor` + `ruint` compile for SBF
      under platform-tools rustc 1.79.0 (46,784-byte eBPF ELF). Condition 4 not triggered.
      **Finding T1:** a crate's MSRV is not the host pin; `crates/floor` now declares
      `rust-version = "1.79"` because platform-tools compiles it. `programs/ballast` will need the
      same.
      **BLOCKED:** `anchor build` / `anchor test` — see Read this first. CI's Rust legs pass
      locally; the probe legs cannot run.

- [x] **B.** `crates/floor` — **DONE.** §4 + §11 implemented exactly: U256 via `ruint` (no_std,
      no alloc), exact integer `isqrt` by Newton descent, floor-of-root with the two-directional
      correction loop, `⌈L/s_max⌉` in A, floored payouts, integer bin check, bounds-before-arithmetic
      returning errors not values. `tests/reference/floor.py` written from the §4 derivation
      independently; reproduces all 10 §27 vectors and both §27 redeem payouts. `vectors.json` =
      10,010 cases (10 from §27 + 10,000 random); **Rust matches Python on every one**.
      25 tests green; §14 100k property gate green (16.7 s); fmt + clippy `-D warnings` clean.
      Surfaced two spec-internal findings (F1, F2 in `DECISIONS.md`) — both need your approval.
- [ ] **C.** Fixtures: `pnpm fixtures:dump` per §17 (DBC, DAMM v2, DLMM, Metaplex Token Metadata, locker
      `.so` + migration config key + DLMM preset accounts); local validator boots with them; hashes committed
- [ ] **D.** Devnet P0 harness (`tests/devnet/p0`): minimal Anchor program + TS scripts answering
      **Q1, Q2, Q3, Q4, Q6, Q7, Q11, Q12, Q14** exactly as the Top-20 table prescribes.
      *Needs devnet SOL — will ask.* Every answer → `DECISIONS.md` with signatures + JSON in `evidence/`
- [ ] §18 gate 1 — config validation (byte-identical decode; class created; every single-field mutation rejected)
- [ ] §18 gate 2 — graduation and migration (states advance; migration fee lands in vault to the lamport)
- [ ] §18 gate 3 — **P0** permanent lock (both positions fully permanent + PDA-owned; L mapping ≤2 units;
      L unchanged after 20 swaps + 2 claims)
- [ ] Day-1 report: every question with signatures; fallbacks decided

## Day 2 — 2 Oct (today)

Deliverable: bid placed and cancelled by PDA on devnet. Acceptance: gate 5. Blocker: Q5 fail → escalate
to Meteora, redemption-only fallback.

- [ ] DLMM: Q5, Q8, Q9, Q15–Q17
- [ ] `floor-wasm` (§11 cross-language: Rust = WASM = Python on `vectors.json`)
- [ ] Compiler (§7 canonical configs — Proof and Public — plus predicted s; output must match `vectors.json`)
- [ ] §18 gate 4 — vault funding (`burn_leftover`; §10 ledger reconciles; exact SOL + token conservation)
- [ ] §18 gate 5 — **P0** DLMM bid (place via PDA, swap through, cancel, burn; fills persist; cancel
      returns unfilled + filled + fees)

## Day 3 — 3 Oct · Program part 1

- [ ] `initialize_global`, `create_class` (every §7 validator rule + one negative test per rule),
      `register_launch`, `settle_graduation`, `burn_leftover`
- [ ] Local-validator tests against real Meteora programs; all §14 negative tests present
- [ ] All tests green

## Day 4 — 4 Oct · Program part 2

- [ ] `open`, `refresh_floor`, `redeem` (atomic; measure CU for Q18), `harvest`, `deposit`, `floor` view
- [ ] Model fuzzer: 1M steps asserting **F never falls** and **V/F + L(1/√F − 1/√P_max) ≥ S** at every step,
      no negative balances, SOL + token conservation
- [ ] CU within §26 budgets (`open` ≤600k, `redeem` ≤1.2M, `refresh_floor` ≤800k)
- [ ] Blocker: Q18 fail → two-step redeem

## Day 5 — 5 Oct · Devnet end-to-end + verifier

- [ ] §18 gate 6 — F (`floor()` vs Rust, WASM, Python identical; realised ≥ predicted)
- [ ] §18 gate 7 — redemption (exact payout; F rises; CU within limit)
- [ ] §18 gate 8 — full sell-out (lowest execution ≥ 0.99·F; vault ≈ 0; F not lower)
- [ ] §18 gate 9 — invariant run (200 random txs, several wallets; no monotone failure; verifier PASS)
- [ ] §18 gate 10 — failure injection (keeper off 1h; stale order; substituted accounts; dust redeems)
- [ ] `verifier-core` + `ballast` CLI per §20 — PASS on the devnet launch from a clean checkout with only an RPC URL
- [ ] Any gate fail → fix before mainnet

## Day 6 — 6 Oct · Mainnet Proof launch (§19, §22) — I execute every transaction

- [ ] Dry-run everything first (`simulateTransaction` → `evidence/mainnet-dryrun/`); runbook written
- [ ] Deploy from buffer → upgrade authority to multisig → `solana-verify` against tagged commit
- [ ] `initialize_global` → Proof config (`fee_claimer = leftover_receiver = partner_auth`) → `create_class`
- [ ] Fund `partner_auth` ~0.1 SOL; keeper started
- [ ] Register (prediction recorded before trade 1) → buys to 10 SOL → settle → migrate → `burn_leftover` → `open`
- [ ] Team sell-out → `refresh_floor` → `ballast verify --sellout`
- [ ] Acceptance: realised ≥ predicted; lowest exec ≥ 0.99·F. Deviation → **stop**, diagnose 7 Oct

## Day 7 — 7 Oct · Buffer + Public launch (§23)

- [ ] Public class + launch; keeper running; challenge rules published (§24)
- [ ] Verifier PASS

## Day 8 — 8 Oct · App (§21)

- [ ] Token page (six prices kept distinct; floor composition; bid wall; redeem; proof links; plain-language limits)
- [ ] 5-step launch form; creator outreach
- [ ] Every number from the floor crate and matching `ballast verify`

## Day 9 — 9 Oct · Outside interactions

- [ ] External creator launch; challenge promotion; README draft
- [ ] Target: ≥1 non-team bid fill or redemption. None → report honestly

## Day 10 — 10 Oct · Demo

- [ ] Recording; docs; video edit. Every on-screen tx linked; sped-up segments labelled
- [ ] `/audit` + verifier run immediately before recording

## Day 11 — 11 Oct · Submission prep

- [ ] README in §34 order with real addresses and signatures from `evidence/`
- [ ] Final verifier runs; §29 Definition of Done checklist complete
- [ ] `/audit` + grep for banned wording across `app/` and `README.md`

## Day 12 — 12 Oct · Submit

- [ ] Submit (deadline 13 Oct 06:59 UTC)

## Open risks

| Risk | Impact | Status |
|---|---|---|
| **platform-tools v1.43 (cargo 1.79) cannot build the Anchor tree** | Blocks `anchor build`/`test`, STEP 1C, STEP 1D | **Open — needs your decision** |
| One day behind before any code (§28 starts 1 Oct) | Compresses the two P0 devnet days | Open — buffer days 7 + 11 absorb |
| Caret requirements silently drift off the §16 pins | `anchor-lang` had drifted to 0.31.2, `solana-program` to 2.3.0 | Fixed with exact pins in the probe; **apply the same to `programs/ballast`** |
| `sudo` needs a password in WSL; `clang`/`unzip` absent | A build needing them will stop | Open — one `apt-get install` from you if it comes up |
| ~~Toolchain mismatch on every §16 pin~~ | — | **Resolved** — all pins installed and proven in WSL |
| ~~Windows host; OneDrive; no Linux distro~~ | — | **Resolved** by D-005 (repo on ext4 in WSL Ubuntu) |
| Q5 (PDA DLMM limit orders via CPI) | Kills the entire DLMM/bid layer | UNKNOWN — gate 5, due 2 Oct |
| Q1/Q7 (permanent lock atomicity / splittable creator position) | L could be stalled or under-counted | UNKNOWN — gate 3, due 1 Oct (overdue) |
| Q18 (atomic redeem CU) | Forces two-step redeem | UNKNOWN — due 4 Oct |
| Mainnet Proof deviation | Never submit a mismatched claim | Not reached |
| ~~Stray `C:\Users\HP\package.json` above the repo~~ | — | **Resolved** — `packageManager` pinned; `~/.ballast-env` strips `/mnt/*` from PATH |

## Next task

**Awaiting one decision**: how to get the Anchor program tree building for SBF
(`DECISIONS.md` § OPEN DECISION — recommendation is option A, `--tools-version`, which keeps every
§16 pin intact). Nothing past this can be trusted until `anchor build` and `anchor test` work.

Once decided, in order:
1. Finish STEP 1A (b) and (c): `anchor build`, `anchor test` on the probe workspace, CI locally.
2. **STEP 1C** per D-001: `pnpm fixtures:dump` + `pnpm fixtures:check`, mainnet sha256 **and slot**
   pins in `evidence/fixtures/mainnet-pins.json`; local validator booting with the **mainnet**
   binaries plus every mainnet account they read — that account list discovered by **simulating** a
   DBC config creation, a migration and a DLMM pair creation against mainnet, not guessed.
3. **STEP 1D**: the P0 harness, on the mainnet-binary local validator. No devnet SOL needed yet.

Also confirm: the **D-001 wording in `DECISIONS.md` is my reconstruction** — its text was never
given to me.
