# Ballast — Status

**Updated:** 7 Oct 2026 19:20 UTC (8 Oct IST) · **Deadline:** 13 Oct 2026 06:59 UTC
**⚠ Behind schedule by about one day.** The 7 Oct crash (C: full, WSL down) interrupted the Part 2
audit fixes. The 7 Oct calendar assumed they were done and gave 8 Oct to `proof:local`. Proposed cuts
are at the bottom, awaiting the owner.

## Reconcile (STEP A, 7 Oct) — full table: `evidence/phases/RECONCILE-2026-10-07.md`

| Item | State |
|---|---|
| Floor crate, Python reference, vectors, meteora-types, compiler, fixtures, CI | DONE (36 tests + 10/10 reference, run 7 Oct) |
| §6 eleven instructions | DONE at D-020 (fresh ledger 7 Oct: Part 1 88/0/12 unreachable, Part 2 41/0) |
| Part 2 audit fixes: D-021, D-022 (`pay_creator`), 11 approved findings | **PARTIAL — tree does not compile** (`floor_ix.rs` rewrite not started) |
| Program size | **DIVERGES:** 531,800 B > D-018's ≈ 500 KB |
| CU (local) | `open` 139k · `refresh` ≤ 192k · atomic `redeem` 197k · `harvest` 136k (Q18 answered locally) |
| §14 model fuzzer (1M) · stateful integration | NOT STARTED |
| §18 gates 1–10 | PARTIAL: 1, 2, 3, 5, 6, 7 exercised locally, never recorded; 4 partial; 8–10 not run |
| `proof:local` (D-007) · devnet proof | NOT STARTED |
| §20 verifier | NOT STARTED |
| §21 app · scanner CLI · Lite config (D-008) · keeper package | NOT STARTED |
| README (stub, stale) · `JUDGES.md` · `LICENSE` · video | PARTIAL / NOT STARTED |
| Backup | **`f83bac3`, `1ee0bdc` unpushed** |

## Calendar — FEATURE FREEZE (owner, 8 Oct 2026)

Nothing new is built except these items.

| Day | Work | Done when |
|---|---|---|
| **8 Oct** | Part 2 audit fixes closed (D-021, D-022, approved findings); then `pnpm proof:local` (full lifecycle on mainnet binaries) + the lifecycle fuzzer | Fresh ledger green; `/audit` 0 critical / 0 high; `evidence/proof-local/` summary table |
| **9 Oct** | Verifier CLI (`ballast verify`) + devnet deploy and devnet proof | Verifier PASS locally and on devnet; `evidence/proof-devnet/`. **Devnet SOL: 14.2 minimum, 17 recommended**, to `F1s4kPpt5LHNV98YhoWcSDUhqiPsZaw6W41MRYjGrUT1`; run `pnpm proof:devnet` (DECISIONS § Devnet budget) |
| **10 Oct** | Floor Scanner CLI + README + `JUDGES.md` (+ a minimal token page only if time allows) | Wording gate green; every claim linked to evidence |
| **11 Oct** | Video + **submit** | Submitted |
| **12 Oct** | Buffer | — |

## Environment

`/home/hp/ballast` on ext4 in WSL Ubuntu, vdisk now at `D:\WSL\Ubuntu` (moved 7 Oct after C: filled).
`source ~/.ballast-env` before every command. Backup of the pre-move vdisk: `D:\ballast-recovery\`
(keep it until the work is pushed). Toolchain: Agave 2.1.21, Anchor 0.31.1, Node 20.20.2, rustc 1.85.0.

To re-run on a fresh ledger:

```bash
source ~/.ballast-env && cd ~/ballast
pnpm localnet --quiet &                              # mainnet-binary validator (fresh ledger)
bash tests/integration/p0/up.sh                      # fund the payer
anchor build && pnpm exec tsx tests/integration/program/run.ts   # part1 → part4 (one ledger)
```

## Open risks

| Risk | Impact | Status |
|---|---|---|
| Unpushed commits | A second disk failure loses 6–7 Oct work | Push with the audit-fix commit. Needs GitHub auth in WSL |
| C: free space (25.6 GB after the move) | Another crash if it fills again | The vdisk is on D: now; C: holds only Windows-side files |
| Program size over D-018 | Deploy cost ≈ 3.7 SOL per copy; owner set ≈ 500 KB | Re-measure after the fixes, then decide |
| Devnet binaries differ from mainnet | Devnet proof may diverge from the local proof | D-001: the local result governs; record any divergence |
| Local CU ≠ mainnet CU (finding T6) | Numbers near a limit could mislead | Cross-check on devnet |
| D-020/D-021 cap is a third-party lever | Bid can sit up to 70 bins under F, or be suspended | Disclosed (D-020); redemption at F unaffected |
| Identity-rewrite leftovers (`backup/pre-identity-rewrite`, `refs/original`) | Old-email commits reachable locally | Delete once the owner confirms |
