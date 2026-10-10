# Ballast — Status

**Updated:** 10 Oct 2026 · **Deadline:** 13 Oct 2026 06:59 UTC (submit 11 Oct)

Development is complete on the local validator (Meteora's mainnet binaries). The program is deployed
on devnet, but devnet's DBC refuses to yield a config the program accepts, so no devnet proof exists.
What is left needs the owner: the video, the submission, and the decisions at the bottom.

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
| Token page (§21) | DONE: renders in Chrome, 14 model checks, browser smoke test, Redeem path landed end to end on the local ledger (`pnpm -F app test:redeem`, `evidence/app/`). Launch form cut (D-019). A wallet extension has not signed the redeem transaction |
| README, `JUDGES.md`, docs (incl. `docs/proof.md`), `docs/demo.md` | DONE, numbers from the 10 Oct run |
| CI | fmt, clippy, unit, property, reference, wording, SBF lock; **added 10 Oct:** WASM differential, compiler check |
| **Devnet** | **Program deployed and initialised (`HSSv351Q…`); `create_class` REFUSED** (`ConfigWrongVersion`: devnet's DBC writes config version 1, mainnet's 0). No class, no launch, no devnet proof. `evidence/proof-devnet/deploy.json` |
| Mainnet | Not deployed (D-007) |
| Video, submission | Owner, 11 Oct |

## Next

1. Development is closed (owner, 10 Oct: option A on devnet — `DECISIONS.md`). Nothing to build.
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
pnpm -F app build && pnpm -F app test && pnpm -F app test:redeem   # token page against the proof ledger
pnpm -F app exec vite preview --host 0.0.0.0 --port 4173 &
CHROME=<chrome> LAUNCH=<launch> pnpm -F app smoke    # the page in a real browser
```

`/home/hp/ballast` is the live repo (ext4 in WSL; vdisk on `D:\WSL\Ubuntu`). Toolchain: Agave
2.1.21, Anchor 0.31.1, Node 20, rustc 1.85.0.

## Owner decisions open

| Item | Detail |
|---|---|
| Treasury account closed → `harvest` reverts (MEDIUM) | `global.treasury` has no setter. Proposed: if the treasury is not a valid WSOL account, its share goes to the vault. Changes who is paid, so not applied. Disclosed in `docs/limitations.md` |
| Identity-rewrite leftovers (`backup/pre-identity-rewrite`, `refs/original`) | Kept until the owner confirms deletion |

## Open risks

| Risk | Impact | Status |
|---|---|---|
| No public launch (devnet or mainnet) | Judges see a local ledger plus a devnet deployment and refusal | README and `JUDGES.md` say so plainly |
| DBC config version 1 reaching mainnet | `create_class` refuses new configs until version 1 is validated and the program upgraded | Disclosed in `docs/limitations.md`; existing classes unaffected |
| Devnet runs different Meteora builds | The devnet proof may diverge from the local one | D-001: the local result governs; record any divergence |
| Local CU ≠ mainnet CU (finding T6) | Numbers near a limit could mislead | 6× headroom on `redeem`; cross-check on devnet |
| D-020/D-021 cap is a third-party lever | Bid can sit up to 70 bins under F, or be suspended | Disclosed; redemption at F less 0.5% is unaffected |
| Token page's redeem flow | Landed end to end from the page's own code path; never signed by a wallet extension | Try it once with Phantom on the local ledger before filming |
| Program upgrade authority | The one path to the vault | Disclosed; multisig per §19 before any mainnet step |
