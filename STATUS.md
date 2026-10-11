# Ballast — Status

**Updated:** Mon 12 Oct 2026, 00:30 IST · **Colosseum:** Mon 12 Oct 21:00 IST (confirm in the portal) ·
**Superteam Earn (Meteora, India):** Tue 13 Oct 12:29 IST, submit by 09:00

Read `submission/CHECKLIST.md` first: it lists what only the owner can do.

## The one thing to know

**"Lowest execution 1.0174 × F" was wrong.** The measurement counted a rent refund as sale proceeds.
Corrected on 11 Oct: **worst fill 0.9984 × F, fees included; fills on the DLMM bid 0.9994 × F or
better.** Every document, the page and the scripts use the corrected figure. Any video recorded
before the correction must not be used.

## State

| Item | State |
|---|---|
| Floor crate, program (binary `fc09a069…5abb`, unchanged since 8 Oct), keeper, SDK | DONE |
| Verifier | `verify <mint> --cluster …`, `check <DAMM v2 pool>` (works on mainnet), `scan`; ledger; **execution excludes rent refunds** (11 Oct); release `v0.1.1` (linux-x64, macOS-arm64), `install.sh` |
| `pnpm proof:local` | PASS, rerun 11 Oct with the corrected measurement and routing: every claim, gates 4, 8, 9, 10 |
| Demo runbook `pnpm demo:*` | DONE: four clean runs since the correction (three `all`, one `keeper-path`); dump CSV, animated chart, README GIF |
| Web page | Landing + token page with the floor card ("Before you buy", "Verify in your browser", floor history, `/launch/<mint>`); 15 model checks, redeem end to end, browser smoke test. GitHub Pages workflow ready (owner enables Pages) |
| README, `JUDGES.md`, `docs/INTEGRATE.md`, `docs/proof.md` | Rewritten for submission; no internal spec references |
| `submission/` | AUDIT, CHECKLIST, BREAK_THE_FLOOR, OUTREACH, THREAD, TRACTION (all counts 0), MAINNET, COLOSSEUM, EARN_METEORA, EARN_INDIA, JUDGE_FAQ, `video/` (scripts, shot list, captions, cards) |
| Traction engine | Issue forms and labels live; badges in the README. Counts: 0 / 0 / 0 |
| Devnet | Program deployed; `create_class` refused (devnet DBC writes config version 1). No launch |
| **Mainnet** | **NO-GO by default.** Dry run measured (peak 13.55 SOL, 7.77 spent for good); guarded path written and rehearsed locally (`scripts/mainnet/README.md`). Waits for `GO MAINNET` |

## Next (owner)

1. Send `submission/OUTREACH.md`; enable GitHub Pages; fill the ⟦FILL⟧ items (`CHECKLIST.md`).
2. Decide `GO MAINNET` or not (`submission/MAINNET.md`). Window if GO: Mon 09:00–10:00 IST.
3. Record the two videos from `submission/video/` (Mon 12:00–15:00 IST), upload, paste links.
4. Submit Colosseum by Mon 21:00 IST; both Earn submissions by Tue 09:00 IST.

## Next (Claude, if asked)

- After `GO MAINNET`: run `scripts/mainnet/README.md`, then update the README, TRACTION and the hosted page's default cluster.
- Before submissions: refresh the counts in `TRACTION.md` and the ⟦FILL⟧ traction lines.

## Re-run

```bash
source ~/.ballast-env && cd ~/ballast
pnpm localnet --quiet &                              # mainnet-binary validator, fresh ledger
bash tests/integration/p0/up.sh && anchor build && cargo build --release -p ballast-verifier
pnpm proof:local                                     # full proof and gates, about 20 min
pnpm demo:all                                        # the filmed runbook, about 8 min
pnpm -F app build && (cd app && pnpm exec vite preview --host 0.0.0.0 --port 4173 &)
pnpm -F app test && pnpm -F app test:redeem
```

`/home/hp/ballast` is the live repo. The local ledger and both servers die with WSL; rebuild with the
commands above before filming.

## Owner decisions open

| Item | Detail |
|---|---|
| `GO MAINNET` | Default NO-GO. `submission/MAINNET.md` |
| Bounty for the challenge | ⟦FILL⟧ in `submission/BREAK_THE_FLOOR.md` |
| Treasury account closed → `harvest` reverts (MEDIUM) | Not applied; disclosed in `docs/limitations.md` |
| The spec's limits sentence ("the bid and redemption don't [execute below F]") | Loose: the bid fills at its bin price (≤ F), redemption pays F less 0.5%. The page keeps the mandated sentence; new copy is precise |
| Licence | Apache-2.0 is in the repo; the sprint brief said not to add one. Left as is |
| `/audit` on the 10–11 Oct diffs | Not run. The program binary is unchanged; the verifier, scripts and app changed |

## Open risks

| Risk | Status |
|---|---|
| Nothing Ballast-specific is on a public cluster; traction is zero | `ballast check` gives strangers a mainnet target; outreach is the owner's |
| A video recorded with "1.017" | Must be re-recorded |
| The corrected worst fill (0.9984 × F) depends on routing between the two venues | Stated in the README limits and the FAQ |
| Mainnet launch, if GO: outsiders trade the pool; unaudited; one upgrade key | `submission/MAINNET.md` |
| WSL restart before filming | Rebuild ledger and page first |
