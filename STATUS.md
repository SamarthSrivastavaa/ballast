# Ballast — Status

**Updated:** 2 Oct 2026 (STEP 1A/1B) · **Deadline:** 13 Oct 2026 06:59 UTC (plan to submit 12 Oct)

## Current state

| | |
|---|---|
| Phase | STEP 1B done — floor crate + Python reference + vectors complete |
| Last passed gate | **none** — §18 gate 1 not yet attempted |
| P0 gate (Q1–Q5) | **BLOCKING.** All five UNKNOWN. Nothing beyond test harnesses may be built. |
| Open UNKNOWNs | 12 of 20 Top-20 questions (see `DECISIONS.md`) |
| Program code | none (correct — gated). `crates/floor` is exempt: pure math, no network |
| Floor engine | **§4/§11 implemented; all 10 §27 vectors exact; 25 tests + 100k property gate green** |
| Devnet SOL | not yet requested |
| Mainnet | untouched |

### Schedule risk — read this first

**The §28 plan starts 1 Oct; today is 2 Oct and Day 1 is not done.** We are one day behind before the
first line of code. Day 1 and Day 2 work (two full devnet phases plus the floor crate) must either be
compressed into 2 Oct or the buffer days (7 Oct, 11 Oct) must absorb the slip. The floor crate needs no
network, so it proceeds in parallel with devnet funding to recover part of the day.

**The installed toolchain does not match the §16 pins** (Rust nightly 1.95 vs 1.84 stable; Solana CLI
1.18.26 vs Agave 2.1.x; Anchor 0.32.1 vs 0.31.1; Node 24 vs 20 LTS; pnpm and wasm-pack absent) and this
is a Windows host, where `anchor test` against a local validator with dumped Meteora programs is
unproven. Both are recorded in `DECISIONS.md` § Toolchain and § Environment and must be resolved in
STEP 1A before any gate can be trusted.

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

- [~] **A.** Scaffold + toolchain. **Partly done.** §15 skeleton created; Cargo workspace;
      `.gitattributes` (LF, for bit-for-bit `vectors.json`); CI with fmt, clippy `-D warnings`, unit
      tests, the 100k property gate, a `vectors.json` reproducibility check and a §21 wording grep.
      **Rust pin proven at 1.85.0** (not §16's 1.84 — see `DECISIONS.md` § Toolchain for why).
      **Still open:** Agave 2.1.x, Anchor 0.31.1, Node 20, pnpm 9, wasm-pack; `cargo build-sbf` unconfirmed
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
| One day behind before any code (§28 starts 1 Oct) | Compresses the two P0 devnet days | Open — buffer days 7 + 11 absorb |
| Toolchain mismatch on every §16 pin; pnpm + wasm-pack absent | Gates untrustworthy until fixed | Open — STEP 1A |
| Windows host; `anchor test` + local validator with dumped Meteora `.so` unproven; only WSL distro is docker-desktop | §14/§17 integration layer may not run | Open — decide in STEP 1A |
| Q5 (PDA DLMM limit orders via CPI) | Kills the entire DLMM/bid layer | UNKNOWN — gate 5, due 2 Oct |
| Q1/Q7 (permanent lock atomicity / splittable creator position) | L could be stalled or under-counted | UNKNOWN — gate 3, due 1 Oct (overdue) |
| Q18 (atomic redeem CU) | Forces two-step redeem | UNKNOWN — due 4 Oct |
| Mainnet Proof deviation | Never submit a mismatched claim | Not reached |
| Stray `C:\Users\HP\package.json` above the repo | pnpm/corepack may resolve the wrong package manager | Open — pin `packageManager` in repo root |

## Next task

**Finish STEP 1A's toolchain legs**, which block every gate: install Agave 2.1.x and Anchor 0.31.1,
confirm `cargo build-sbf` on Rust 1.85.0, install Node 20 + pnpm 9 (pinning `packageManager` in the
repo root to defeat the parent `yarn` declaration). Then **1C** (`pnpm fixtures:dump`, §17) and
**1D** (devnet P0 harness for Q1–Q4, Q6, Q7, Q11, Q12, Q14), which needs devnet SOL from you.

Decide first: findings **F1** and **F2** in `DECISIONS.md`, and whether to accept the Rust 1.85.0 pin.
