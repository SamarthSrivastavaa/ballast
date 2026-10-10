# For judges

Every claim below links to the evidence that backs it. Criteria are in the order the project
optimises for (DECISIONS.md D-006). Nothing here asks you to trust the app: `ballast verify`
recomputes the floor from raw accounts, and `pnpm proof:local` replays the whole lifecycle on
Meteora's own mainnet binaries.

This is an executable buyback floor on Meteora, not a promise about prices elsewhere.

## 1. Depth of Meteora integration — DBC, DAMM v2 and DLMM each carry part of the floor

| Product | What it does for the floor | Evidence |
|---|---|---|
| **DBC** | The launch class. Two configs are validated field by field on-chain (`create_class`, every §7 rule with its own error code); the prediction is recorded in the pool-creation transaction, before any third-party trade (D-011); 15% of the raise is withdrawn as the migration fee straight into the vault | `evidence/program/part1/results.json` (43 pass, one negative test per rule), `evidence/p0/Q4/`, `evidence/p0/d011/` |
| **DAMM v2** | 85% of the raise migrates into a full-range, OnlyB, non-compounding pool as two permanently locked positions owned by Ballast PDAs; their liquidity L is half of the floor equation | `evidence/p0/Q1/` (both positions fully permanent in the migration transaction), `evidence/p0/Q2/`, `evidence/p0/Q3/` (L ↔ reserves within 2 units) |
| **DLMM** | The whole vault rests as one limit order owned by a Ballast PDA at the highest bin at or below F; fills are settled by cancel → burn → re-place; redemption is atomic | `evidence/p0/Q5/` (place, fill, cancel returns exactly unfilled + filled + fees), `evidence/program/part2/results.json` |
| Meteora behaviour found by execution, not assumed | DBC's migration price sits below the last curve point (D-017); DBC's and DAMM's fee-mode enums differ (D-010); DLMM refuses a bid above the active bin and anyone can pin it (D-020, D-021); a DLMM pair carries no bin step in its address (D-014) | `DECISIONS.md`, `evidence/program/d017/band.json`, `evidence/program/part2/dlmm-active-bin.json`, `dlmm-bin-range.json` |

All of it runs against **the mainnet Meteora binaries**, dumped and pinned by hash
(`evidence/fixtures/mainnet-pins.json`; `pnpm fixtures:check` re-verifies them against mainnet), on a
local validator — never mocks (D-001).

## 2. Technical execution — tests, fuzzing, verifier, reproducible proof

| Claim | Evidence |
|---|---|
| One implementation of F, exact integers, no floating point; Rust = WASM = Python bit for bit | `crates/floor` (§4), `crates/floor/vectors.json` (10,014 differential cases), `tests/reference/floor.py`, `evidence/floor/wasm-differential.json` |
| F never falls across 1M and 10M random model steps (200 / 2,000 runs, with sell-outs) | `evidence/fuzz/model-1m.json`, `evidence/fuzz/model-10m.json` |
| 11 instructions + `pay_creator`, each mutating one ending with the monotone check | `programs/ballast/`; fresh-ledger suites: Part 1 94 pass, Part 2 46 pass, audit fixes 22 pass, keeper 5 pass (`evidence/program/`) |
| Every account substitution has a negative test | `tests/integration/program/src/part1.ts` … `part5.ts` |
| Atomic redemption fits easily: `open` 145k CU, `refresh_floor` 188k, `redeem` 209k (limit 1.4M) | `DECISIONS.md` § Part 2 re-audit |
| Two audits (spec + security), every finding fixed or decided; 0 critical / 0 high | `DECISIONS.md` § Part 2 audit findings, § Part 2 re-audit; `evidence/program/part2/audit.json` |
| The vault has exactly two exits — the DLMM bid it owns and a redeemer — structurally | `docs/security.md`, `evidence/program/part2/audit.json` ("harvest never transfers out of the vault") |
| `ballast verify <launch> --rpc <url>` recomputes everything from raw accounts | `crates/verifier-core`, `verifier/`, `docs/verifier.md` |
| `pnpm proof:local` — the full §22 Proof launch on mainnet binaries: realised F +1.34% over the prediction; 72-sell full sell-out, lowest execution 1.0173·F; F never lower; gates 8–10 PASS | `evidence/proof-local/summary.md`, `docs/proof.md`, `docs/demo.md` |
| The §10 ledger closes to the lamport from chain data: live V = recorded inflows − fills − redemptions, supply = minted − burned, every counter = the sum of its events (gate 4) — on the Proof launch and again after 200 random transactions | `ballast verify` line "Ledger" (`evidence/proof-local/verify.txt`), `crates/verifier-core/src/ledger.rs` |
| The token page renders in a real browser, its numbers equal the verifier's and a real DLMM quote, and its Redeem transaction lands and pays exactly the quote shown | `evidence/app/`, `app/test/model.test.ts` (14 checks), `app/test/redeem.e2e.ts`, `app/test/smoke.mjs` |

## 3. Originality and taste

- A launch class whose downside is **computed and predicted on-chain before anyone trades**, then
  checked by anyone with an RPC URL. The claim is falsifiable on purpose: realised F ≥ predicted F.
- The floor is quote-asset agnostic: the equation uses V (quote held), S (supply) and L (locked
  liquidity), nothing SOL-specific.
- Six prices kept distinct everywhere (theoretical F, bid bin price, executable bid net, DAMM v2
  price, DAMM v2 sell net, redemption), so no number is shown without saying which it is.

## 4. Impact

- Any DBC launchpad can adopt the class: two validated configs plus one program.
- `floor()` returns `{s, F, V, S, L, s_last, bin, bin price}` as return data, so a terminal can read
  the floor without this project's app.
- **Ballast Lite** (D-008): the same curve with 100% permanently locked LP and no program — a
  locked-liquidity floor (V = 0) any launch can have, which the verifier and `ballast scan` measure.
- The gap is measurable today: of the 100 newest DBC → DAMM v2 migrations on mainnet (slots
  454,622,437–454,633,832, scanned 8 Oct), **94 had no permanently locked liquidity at all** and only
  2 held a locked-liquidity floor above half the pool price
  (`evidence/scanner/scan-100-2026-10-08.json`; one pool spot-checked with Meteora's cp-amm SDK).

## 5. Traction

Honest status: no mainnet deployment yet (D-007: no mainnet spend without per-transaction approval;
the Full tier deploys only if funded). On devnet the program is deployed and
initialised, but no launch exists: devnet's DBC is a newer build whose configs carry version 1, and
the program refused to create a class from one (`ConfigWrongVersion`, §7 rule 1 —
`evidence/proof-devnet/deploy.json`). The evidence is the reproducible local proof on Meteora's
mainnet binaries, that devnet refusal, and `ballast scan` over existing DBC → DAMM v2 launches
(`evidence/scanner/scan-100-2026-10-08.json`).

## Limits you should know

Late buyers can lose ~74% before reaching the floor; F is in SOL, not dollars; selling directly on
DAMM v2 can execute below F; a third party can hold the DLMM bid below F's bin (redemption still pays
F less 0.5%). Full list: [`docs/limitations.md`](docs/limitations.md).
