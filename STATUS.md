# Ballast — Status

**Updated:** 10 Oct 2026 · **Deadline:** 13 Oct 2026 06:59 UTC (submit 11 Oct)

Development is complete on the local validator (Meteora's mainnet binaries). What is left needs the
owner: devnet SOL, the video, the submission, and two decisions at the bottom.

## State

| Item | State |
|---|---|
| Floor crate, Python reference, vectors, WASM | DONE: Rust = WASM = Python on 10,014 vectors |
| `meteora-types`, compiler, fixtures | DONE |
| Program: 11 instructions + `pay_creator` (D-020, D-021, D-022, audit fixes) | DONE: 553,456 B, sha256 `fc09a069…5abb`; suites on a fresh ledger 8 Oct: Part 1 94 pass, Part 2 46, audit fixes 22, keeper 5, 0 fail |
| Audits | 0 critical / 0 high (8 Oct re-audit). `/audit` not rerun on the 10 Oct diff (no program change) |
| Model fuzzer | DONE: 1M and 10M steps, 0 failures |
| Verifier (`ballast verify`, `ballast scan`) | DONE, incl. event history, `--at-slot`, `--sellout`, and the §10 ledger (10 Oct) |
| `pnpm proof:local` | **PASS, rerun 10 Oct on a fresh ledger**: every claim, gates 4, 8, 9, 10 (`evidence/proof-local/`) |
| §18 gates | 1, 2, 3, 5, 6, 7 PASS by suite · **4 PASS (10 Oct)** · 8, 9, 10 PASS. All local |
| Keeper, SDK, Lite config (D-008) | DONE |
| Token page (§21) | DONE: renders in Chrome, 13 model checks, browser smoke test (`evidence/app/`). Launch form cut (D-019). Redeem button not exercised with a real wallet |
| README, `JUDGES.md`, docs (incl. `docs/proof.md`), `docs/demo.md` | DONE, numbers from the 10 Oct run |
| CI | fmt, clippy, unit, property, reference, wording, SBF lock; **added 10 Oct:** WASM differential, compiler check |
| **Devnet deploy + `pnpm proof:devnet`** | **NOT RUN: the devnet payer holds 0 SOL** |
| Mainnet | Not deployed (D-007) |
| Video, submission | Owner, 11 Oct |

## Next

1. **Owner: fund the devnet payer** `F1s4kPpt5LHNV98YhoWcSDUhqiPsZaw6W41MRYjGrUT1` with **14.2 SOL
   minimum, 17 recommended** (deploy 2.816 SOL kept, 5.63 at the peak; about 5.7 SOL of the buys
   comes back on the sell-out). The faucet refused five CLI requests on 10 Oct. Then:
   `source ~/.ballast-env && cd ~/ballast && anchor build && pnpm proof:devnet`
   → `evidence/proof-devnet/`; record signatures in `DECISIONS.md`; update README "Addresses".
2. **Video (11 Oct):** follow `docs/demo.md` (12 rows, each with its signature). The signatures are
   from the 10 Oct local ledger; if the validator is restarted, rerun `pnpm proof:local` and
   `python3 scripts/proof/demo_checklist.py` first.
3. **Submit (11 Oct).** 12 Oct is buffer.

## Re-run

```bash
source ~/.ballast-env && cd ~/ballast
pnpm localnet --quiet &                              # mainnet-binary validator, fresh ledger
bash tests/integration/p0/up.sh                      # fund the payer
anchor build && pnpm proof:local                     # ≈ 20 min; writes evidence/proof-local/
pnpm exec tsx tests/integration/program/run.ts       # program suites (fresh ledger)
pnpm -F app build && pnpm -F app test                # token page against the proof ledger
pnpm -F app exec vite preview --host 0.0.0.0 --port 4173 &
CHROME=<chrome> LAUNCH=<launch> pnpm -F app smoke    # the page in a real browser
```

`/home/hp/ballast` is the live repo (ext4 in WSL; vdisk on `D:\WSL\Ubuntu`). Toolchain: Agave
2.1.21, Anchor 0.31.1, Node 20, rustc 1.85.0.

## Owner decisions open

| Item | Detail |
|---|---|
| Treasury account closed → `harvest` reverts (MEDIUM) | `global.treasury` has no setter. Proposed: if the treasury is not a valid WSOL account, its share goes to the vault. Changes who is paid, so not applied. Disclosed in `docs/limitations.md` |
| `CLAUDE.md` lines 11 and 83, spec §29 | Still say "before trade 1"; D-011 records the prediction in the pool-creation transaction, which contains a dust buy. Public copy already uses the D-011 wording |
| Identity-rewrite leftovers (`backup/pre-identity-rewrite`, `refs/original`) | Kept until the owner confirms deletion |

## Open risks

| Risk | Impact | Status |
|---|---|---|
| No public (devnet or mainnet) evidence | Judges see a local ledger only | Blocked on devnet SOL; README and `JUDGES.md` say so plainly |
| Devnet runs different Meteora builds | The devnet proof may diverge from the local one | D-001: the local result governs; record any divergence |
| Local CU ≠ mainnet CU (finding T6) | Numbers near a limit could mislead | 6× headroom on `redeem`; cross-check on devnet |
| D-020/D-021 cap is a third-party lever | Bid can sit up to 70 bins under F, or be suspended | Disclosed; redemption at F less 0.5% is unaffected |
| Token page's redeem flow | Built and size-checked (995 bytes), never signed by a browser wallet | Try it with Phantom on the local or devnet ledger before filming |
| Program upgrade authority | The one path to the vault | Disclosed; multisig per §19 before any mainnet step |
