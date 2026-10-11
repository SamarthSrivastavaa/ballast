# For judges

Every claim links to the evidence behind it. Nothing here asks you to trust our app: `ballast verify`
recomputes the floor from raw accounts, and `pnpm proof:local` replays the whole lifecycle on
Meteora's own mainnet binaries.

This is an executable buyback floor on Meteora, not a promise about prices elsewhere.

**Two minutes, no setup:** the locked-liquidity floor under any Meteora DAMM v2 pool on mainnet.

```bash
curl -fsSL https://raw.githubusercontent.com/SamarthSrivastavaa/ballast/main/install.sh | sh
./ballast check <DAMM v2 pool address> --cluster mainnet
```

## 1. Depth of Meteora integration

| Product | What it does for the floor | Evidence |
|---|---|---|
| **DBC** | The launch class. The config is validated field by field on-chain, each rule with its own error; the prediction is recorded in the pool-creation transaction, before any third-party trade; the 15% migration fee is claimed straight into the vault | `evidence/program/part1/results.json`, `evidence/p0/Q4/`, `evidence/p0/d011/` |
| **DAMM v2** | 85% of the raise in a full-range pool as two permanently locked positions owned by program PDAs: L in the floor equation | `evidence/p0/Q1/`, `Q2/`, `Q3/` |
| **DLMM** | The whole vault as one limit order owned by a program PDA, in the highest bin at or below F; fills settled by cancel → burn → re-place; atomic redemption | `evidence/p0/Q5/`, `evidence/program/part2/results.json` |
| Found by running it, not assumed | DBC's migration price sits just under the last curve point; DLMM refuses a bid above the active bin, and anyone can move that bin; devnet's DBC writes a newer config version than mainnet's, and the program refused it | `docs/meteora.md`, `evidence/program/part2/dlmm-active-bin.json`, `evidence/proof-devnet/deploy.json` |

All of it runs against **Meteora's mainnet binaries**, dumped and pinned by hash
(`pnpm fixtures:check` re-verifies them against mainnet). Nothing is mocked.

## 2. Technical execution

| Claim | Evidence |
|---|---|
| One implementation of F, exact integers; Rust = WebAssembly = Python, bit for bit | `crates/floor` (34 tests, a 100,000-case property gate), `crates/floor/vectors.json` (10,014 cases), `tests/reference/floor.py` |
| F never falls across 10 million random model steps | `evidence/fuzz/model-10m.json` |
| 12 instructions; every one that changes the backing ends with an on-chain check that F did not fall | `programs/ballast/`; 167 tests on the mainnet binaries (`evidence/program/`) |
| The vault has exactly two exits: its own DLMM order, and a redeemer | `docs/security.md`, `evidence/program/part2/audit.json` |
| **The proof run (11 Oct):** predicted F 6.7019e-9; realised +1.34%; every holder token sold in 73 sells; **worst fill 0.9984 × F, fees included**; fills on the bid 0.9994 × F or better; F ended higher; the vault's ledger closes to the lamport | `evidence/proof-local/summary.md`, `docs/proof.md` |
| The same launch as a step-by-step runbook with a chart, run three times in a row | `pnpm demo:all`, `evidence/demo/` |
| The page renders in a real browser, its numbers equal the verifier's, its Redeem transaction lands and pays the quote shown | `evidence/app/`, `app/test/` |

**A correction we made in the open.** Until 11 Oct this repository reported the worst fill as
1.0174 × F. That was a measurement error: a rent refund counted as sale proceeds. The fix, its tests
and the honest number are in `docs/proof.md` and `DECISIONS.md`.

## 3. Originality and taste

- The downside is **computed and recorded on-chain before the public can trade**, then checked by
  anyone with an RPC URL. The claim is falsifiable on purpose: realised F ≥ predicted F.
- Six prices kept distinct everywhere (theoretical F, the bid's bin price, the bid net of fee, the
  DAMM v2 price, the pool sale net of fee, redemption), so no number appears without its meaning.
- A public challenge with rules: `submission/BREAK_THE_FLOOR.md`.

## 4. Impact

- Any DBC launchpad can offer the class: one config, one instruction (`docs/INTEGRATE.md`).
- `ballast check` and `ballast scan` are useful without Ballast: of the 100 newest DBC → DAMM v2
  launches on mainnet (8 Oct), **94 had no permanently locked liquidity at all**
  (`evidence/scanner/scan-100-2026-10-08.json`).

## 5. Traction

Counted, with links, in `submission/TRACTION.md`. Stated plainly: no mainnet deployment, no launch on
devnet, no outside users yet.

## Limits you should know

Late buyers can lose about 74%. F is in SOL, not dollars. A sale straight into the DAMM v2 pool can
execute below F. Not audited; the upgrade authority is one project key. Full list:
[`docs/limitations.md`](docs/limitations.md). Hard questions, answered: [`submission/JUDGE_FAQ.md`](submission/JUDGE_FAQ.md).
