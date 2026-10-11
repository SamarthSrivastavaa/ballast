# The proof

This is an executable buyback floor on Meteora, not a promise about prices elsewhere.

The claim Ballast makes is narrow and falsifiable: the floor is predicted on-chain before any
third-party trade, the realised floor is at or above the prediction, and it never falls afterwards.
The proof is one launch built to be sold out: three team wallets buy a 10 SOL Proof launch to
graduation, then sell every token they hold, and the verifier checks what happened from raw chain
data. Every number below is from the run of 11 Oct 2026 in
[`evidence/proof-local/summary.md`](../evidence/proof-local/summary.md) (signatures included) and can
be reproduced with one command.

## Where it ran

On a local validator running **Meteora's mainnet binaries** for DBC, DAMM v2 and DLMM, dumped from
mainnet and pinned by hash (`pnpm fixtures:check` re-verifies them), with the mainnet accounts they
read cloned in. Nothing is mocked. This is the authoritative proof.

| Cluster | State |
|---|---|
| Local validator, mainnet binaries | **Done**, all gates below |
| Devnet | **Program deployed and initialised; no launch.** Devnet's DBC is a newer build whose configs carry version 1 (mainnet's carry 0), and `create_class` refused one with `ConfigWrongVersion` (its config-version rule). Signatures in [`evidence/proof-devnet/deploy.json`](../evidence/proof-devnet/deploy.json) |
| Mainnet | **Not deployed.** No mainnet transaction is sent without the owner approving that transaction |

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
| Launch, one transaction: DBC pool, dust buy, DLMM pair, pool-creator role moved to a Ballast PDA, `register_launch` | Predicted F **6.7019e-9**, recorded in the pool's first transaction |
| Three team wallets buy to the 10 SOL threshold | Curve completes with 10.000000001 SOL in reserve |
| `settle_graduation` | Migration fee 1.5 SOL (15%) and 0.040404041 SOL of partner fees reach the vault: V = 1.540404041 SOL |
| Migration to DAMM v2 | Two permanently locked positions, both held by Ballast PDAs; L = 3.0702e31 |
| `burn_leftover` | 134,558,940 unsold tokens burned; 865,441,060 outstanding |
| `open` | The whole vault rests as one DLMM bid at F's bin. Realised F **6.7919e-9**, 1.34% above the prediction |
| Sell-out: 73 sells, each to the better of the DLMM bid and DAMM v2 (a chunk the bid can only partly absorb is split) | 38 to the bid, 35 to the pool; 537,931,935 tokens sold. **Lowest execution 0.9984 × F** in force at that slot, fees included: the last sell, into the pool. Fills on the bid: 0.9994 × F or better (gate 8 requires ≥ 0.99) |
| Keeper `refresh_floor` during the sell-out | Fills are settled by cancelling, the bought tokens burned (226,864,386), the bid re-placed; F rises each time |
| After the sell-out | 0.000058548 SOL left of the 1.54 SOL vault: the bid was sold out; F **6.8400e-9**, not lower than at `open` |
| `harvest`, `pay_creator` | 0.014898632 SOL of LP fees to the vault, 0.001655403 SOL to the treasury, 0.056958076 SOL to the creator |

After a total sell-out the DAMM v2 price sits just under F (6.8136e-9 against 6.8400e-9 on this run)
and the pool charges a 1% fee, so a sale straight into the pool can execute below F. That is expected
and disclosed. The DLMM bid fills at its bin price, at or just under F, and redemption pays F less
0.5%; neither depends on the pool price.

**Correction, 11 Oct.** Earlier versions of this page reported the lowest execution as 1.0174 × F.
That figure was wrong: the measurement counted the rent of each seller's closed wrapped-SOL account
(0.002 SOL per sell) as sale proceeds. The verifier now excludes it
(`crates/verifier-core/tests/execution.rs`), and the sell-out script now fills what is left of the bid
before sending the rest of a chunk to the pool. Measured correctly, the old routing's last sell
executed at 0.988 × F.

## What the verifier found

`ballast verify <launch> --rpc <url> --sellout <signatures>` — full output in
[`evidence/proof-local/verify.txt`](../evidence/proof-local/verify.txt). Every line passed:

- the launch, class, config hash and prediction, recomputed from the DBC config;
- the prediction recorded in the pool's first transaction;
- the canonical DAMM v2 pool, both positions fully permanent and PDA-owned;
- the vault and the resting bid, at or below F;
- F recomputed from live V, S and L with the floor crate, and its history: 11 floor updates decoded
  from the program's events, never decreasing;
- **the ledger, to the lamport**: 1.555302673 SOL in, 1.540345493 SOL out (all of it fills, no
  redemptions on this launch), which is exactly the 0.014957180 SOL the vault and bid hold; the
  supply equals the minted supply less everything burned; every counter equals the sum of its events.

## The gates

| Gate | Result | Evidence |
|---|---|---|
| 1 Config validation | PASS | `evidence/program/part1/results.json` |
| 2 Graduation and migration | PASS: migration fee exactly 1,500,000,000 lamports | `evidence/program/part1/graduation.json` |
| 3 Permanent lock | PASS | `evidence/p0/Q1`–`Q3`, verifier "Permanent" |
| 4 Vault funding: the ledger | PASS: closes to the lamport | verifier "Ledger" |
| 5 DLMM bid | PASS | `evidence/p0/Q5`, `evidence/program/part2/results.json` |
| 6 F identical across `floor()`, Rust, WASM, Python | PASS | `crates/floor/vectors.json`, `app/test/model.test.ts` |
| 7 Redemption | PASS: exact payout, 209,023 compute units | `evidence/program/part2/results.json` |
| 8 Full sell-out | PASS: lowest execution 0.9984 × F, fees included | `evidence/proof-local/summary.md` |
| 9 Invariant run | PASS: 200 random transactions from five wallets on a second launch, no monotone-check failure; its ledger also closes to the lamport, with 0.516360664 SOL of redemptions | same |
| 10 Failure injection | PASS: keeper off with a stale bid (redemption settles it and pays exactly), stale bin hint, dust and slippage redemptions refused | same |

Gates 1–3 and 5–7 passed in the program's test suites rather than as one scripted procedure each.
The curve-phase split between traders, Meteora's protocol fee and the creator (the first rows of
the ledger's first rows) is DBC's own accounting and is not rebuilt by the verifier; the ledger starts where
quote first reaches the vault.

## What this does not show

- No launch ran on mainnet or devnet. The only public explorer links are the devnet deployment and
  the refused `create_class`; the signatures in the summary are on a local ledger anyone can
  regenerate.
- All wallets were the team's. No outside wallet has filled the bid or redeemed.
- Late buyers can lose about 74%: at graduation the DAMM v2 price is roughly 3.8 × F.
- F is a price in SOL, not in dollars.

More: [`limitations.md`](limitations.md) · [`verifier.md`](verifier.md) · [`demo.md`](demo.md).
