# The proof

This is an executable buyback floor on Meteora, not a promise about prices elsewhere.

The claim Ballast makes is narrow and falsifiable: the floor is predicted on-chain before any
third-party trade, the realised floor is at or above the prediction, and it never falls afterwards.
The proof is one launch built to be sold out (§22): three team wallets buy a 10 SOL Proof launch to
graduation, then sell every token they hold, and the verifier checks what happened from raw chain
data. Every number below is from the run of 10 Oct 2026 in
[`evidence/proof-local/summary.md`](../evidence/proof-local/summary.md) (signatures included) and can
be reproduced with one command.

## Where it ran

On a local validator running **Meteora's mainnet binaries** for DBC, DAMM v2 and DLMM, dumped from
mainnet and pinned by hash (`pnpm fixtures:check` re-verifies them), with the mainnet accounts they
read cloned in. Nothing is mocked (D-001). This is the authoritative proof (D-007).

| Cluster | State |
|---|---|
| Local validator, mainnet binaries | **Done**, all gates below |
| Devnet | **Not run.** `pnpm proof:devnet` is ready; the devnet payer is unfunded (it needs 14.2 SOL at the peak; the faucet refused every request on 10 Oct). Devnet runs different Meteora builds, so it is a cross-check, not the proof |
| Mainnet | **Not deployed.** No mainnet transaction is sent without the owner approving that transaction (D-007) |

```bash
source ~/.ballast-env
pnpm fixtures:check && pnpm localnet --quiet &
bash tests/integration/p0/up.sh
anchor build && pnpm proof:local
```

## What happened, in order

Prices are in SOL per token. "F" is the theoretical floor; each other price says which it is.

| Step | Result |
|---|---|
| `create_class` | The Proof config is checked field by field on-chain; the predicted floor is stored with the class |
| Launch, one transaction: DBC pool, dust buy, DLMM pair, pool-creator role moved to a Ballast PDA, `register_launch` | Predicted F **6.7019e-9**, recorded in the pool's first transaction (D-011) |
| Three team wallets buy to the 10 SOL threshold | Curve completes with 10.000000001 SOL in reserve |
| `settle_graduation` | Migration fee 1.5 SOL (15%) and 0.040404041 SOL of partner fees reach the vault: V = 1.540404041 SOL |
| Migration to DAMM v2 | Two permanently locked positions, both held by Ballast PDAs; L = 3.0702e31 |
| `burn_leftover` | 134,558,940 unsold tokens burned; 865,441,060 outstanding |
| `open` | The whole vault rests as one DLMM bid at F's bin. Realised F **6.7919e-9**, 1.34% above the prediction |
| Sell-out: 72 sells, each to the better of the DLMM bid and DAMM v2 | 37 to the bid, 35 to the pool; 537,931,935 tokens sold. **Lowest execution 1.0173 × F** in force at that slot (gate 8 requires ≥ 0.99) |
| Keeper `refresh_floor` during the sell-out | Fills are settled by cancelling, the bought tokens burned (220,120,959), the bid re-placed; F rises each time |
| After the sell-out | 0.045844528 SOL left in the bid of the 1.54 SOL vault; F **6.8394e-9**, not lower than at `open` |
| `harvest`, `pay_creator` | 0.015062311 SOL of LP fees to the vault, 0.00167359 SOL to the treasury, 0.057139942 SOL to the creator |

After a total sell-out the DAMM v2 price itself sits just under F (6.6718e-9 on this run). That is
expected and disclosed: a sale straight into the pool can execute below F; the DLMM bid and
redemption do not.

## What the verifier found

`ballast verify <launch> --rpc <url> --sellout <signatures>` — full output in
[`evidence/proof-local/verify.txt`](../evidence/proof-local/verify.txt). Every line passed:

- the launch, class, config hash and prediction, recomputed from the DBC config;
- the prediction recorded in the pool's first transaction;
- the canonical DAMM v2 pool, both positions fully permanent and PDA-owned;
- the vault and the resting bid, at or below F;
- F recomputed from live V, S and L with the floor crate, and its history: 12 floor updates decoded
  from the program's events, never decreasing;
- **the §10 ledger, to the lamport**: 1.555466352 SOL in, 1.494559513 SOL out (all of it fills, no
  redemptions on this launch), which is exactly the 0.060906839 SOL the vault and bid hold; the
  supply equals the minted supply less everything burned; every counter equals the sum of its events.

## The gates (§18)

| Gate | Result | Evidence |
|---|---|---|
| 1 Config validation | PASS | `evidence/program/part1/results.json` |
| 2 Graduation and migration | PASS: migration fee exactly 1,500,000,000 lamports | `evidence/program/part1/graduation.json` |
| 3 Permanent lock | PASS | `evidence/p0/Q1`–`Q3`, verifier "Permanent" |
| 4 Vault funding: the §10 ledger | PASS: closes to the lamport | verifier "Ledger" |
| 5 DLMM bid | PASS | `evidence/p0/Q5`, `evidence/program/part2/results.json` |
| 6 F identical across `floor()`, Rust, WASM, Python | PASS | `crates/floor/vectors.json`, `app/test/model.test.ts` |
| 7 Redemption | PASS: exact payout, 209,023 compute units | `evidence/program/part2/results.json` |
| 8 Full sell-out | PASS: lowest execution 1.0173 × F | `evidence/proof-local/summary.md` |
| 9 Invariant run | PASS: 200 random transactions from five wallets on a second launch, no monotone-check failure; its ledger also closes to the lamport, with 0.516360664 SOL of redemptions | same |
| 10 Failure injection | PASS: keeper off with a stale bid (redemption settles it and pays exactly), stale bin hint, dust and slippage redemptions refused | same |

Gates 1–3 and 5–7 passed in the program's test suites rather than as one scripted procedure each.
The curve-phase split between traders, Meteora's protocol fee and the creator (the first rows of
§10's table) is DBC's own accounting and is not rebuilt by the verifier; the ledger starts where
quote first reaches the vault.

## What this does not show

- Nothing ran on mainnet or devnet, so there is no public explorer link yet. The signatures in the
  summary are on a local ledger anyone can regenerate.
- All wallets were the team's. No outside wallet has filled the bid or redeemed.
- Late buyers can lose about 74%: at graduation the DAMM v2 price is roughly 3.8 × F.
- F is a price in SOL, not in dollars.

More: [`limitations.md`](limitations.md) · [`verifier.md`](verifier.md) · [`demo.md`](demo.md).
