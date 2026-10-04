# STEP 3 — P0 harness report (interim: STOPPED at Q2)

**Status: STOPPED, awaiting the owner's decision.** Q2 failed **as specified**. §7 tells the DBC
config to set the migrated pool's `collect_fee_mode = 1`, expecting DAMM v2's OnlyB. On the
mainnet binaries that value produces a **BothToken** pool. Per the P0 rule, Q5 onwards was not
started.

The part of Q2 the mechanism depends on **passed**: constant L under 40 swaps and 2 claims,
non-compounding, full range. The failure is an enum-encoding error in the spec, not a Meteora
limitation, and a one-value correction was tested to work (below).

All results come from the **mainnet-dumped** DBC, DAMM v2, DLMM, Token Metadata and Jupiter locker
programs on `solana-test-validator` 2.1.21 (D-001), pinned in
`evidence/fixtures/mainnet-pins.json`. Signatures are local-validator signatures; the ledger resets
per run, so the durable record is the JSON next to each one. Q12's config and check (a) came from
an earlier validator run of the same pinned fixtures than the Proof scenario.

## The failure

| | |
|---|---|
| Question | Q2 (P0): is the migrated pool `collect_fee_mode = 1` (OnlyB), non-compounding, full range, and do swaps and claims leave L unchanged? |
| What §7 sets | DBC config `migrated_pool_fee.collect_fee_mode = 1` |
| Observed | DAMM v2 pool `collect_fee_mode = 0` (BothToken). Protocol fees accrued in **both** tokens (`protocolAFee` 89,741,274,921 base units) — `Q2/result.json` |
| Cause | Two enums, numbered differently. DBC `MigratedCollectFeeMode`: 0 QuoteToken, **1 OutputToken**, 2 Compounding. DAMM v2 `CollectFeeMode`: 0 BothToken, **1 OnlyB**, 2 Compounding. DBC's "OutputToken" becomes DAMM BothToken |
| What passed | Full range (`sqrt_min` = MIN 4295048016, `sqrt_max` = MAX); compounding 0; **`pool.liquidity`, permanent-lock total and both positions' permanent liquidity unchanged after 40 swaps and 2 fee claims** |
| Spec's fallback | "If a range: engine already takes sqrt_min/max. If compounding is forced: reserve-based absorption." **Neither applies**: the range is full and the pool does not compound |
| **Proposed minimum correction** | §7 "Migrated pool" row: DBC `migrated_pool_fee.collect_fee_mode = **0** (DBC QuoteToken)`, which yields DAMM `collect_fee_mode = 1` (OnlyB). §7 validator rule 2 checks the DBC-side value 0; §8's verification table keeps checking DAMM `pool.collect_fee_mode = 1`. The Q12 enum table gets both columns. **No mechanism change** |
| Evidence for the correction | Same Proof config with DBC value 0 → DAMM pool mode **1 (OnlyB)**; after 10 swaps `protocolAFee` = 0, `protocolBFee` = 1,801,915 (quote only); L unchanged; full range — `Q2/characterization-quote-fee-mode.json`, migration `EnFm9JEm3Ks2jvtEPCuwvTuYscdFGMjx7NUnUDE1qbo16BsYaKzsE61CinPL7RT1MhUJe6uzFyFxA2iGbHGznyq` |

If the owner approves, the next run uses value 0, re-runs Q2 under the corrected config as the
authoritative answer, and continues with Q5.

## Answers so far

| Q | Verdict | One line | Evidence |
|---|---|---|---|
| **1** P0 | **PASS** | One `migration_damm_v2` tx (slot 91, read at slot 91) leaves **both** positions `unlocked = 0, vested = 0, permanent = 15,351,107,078,789,826,053,431,780,029,213` on the right pool. Inner instructions show `initialize_pool_with_dynamic_config → permanent_lock_position → create_position → add_liquidity → permanent_lock_position` in that one transaction: atomic. Migration 275,344 CU | `Q1/result.json`, `Q1/positions-raw.json`; sig `25wGvzzW…uQbnQ` |
| **2** P0 | **FAIL as specified** (see above); constant L, full range and non-compounding PASS; corrected config PASSES | — | `Q2/result.json`, `Q2/characterization-quote-fee-mode.json` |
| **3** P0 | **PASS** | At migration `token_a_amount` / `token_b_amount` = the formulas + 2 / + 1 units (≤ 2). After 40 swaps: + 13 / + 10, because rounding accrues to the pool (protocol's favour) | `Q3/result.json` |
| **4** P0 | **PASS** | The harness `partner_auth` PDA, signing via CPI, ran `withdraw_migration_fee` (partner) **before migration**: received 1,500,000,000 = 15% of the threshold. `claim_trading_fee` (40,404,041 = the partner's accrued share exactly), `partner_withdraw_surplus` and DAMM `claim_position_fee` also passed. **Destinations:** `claim_trading_fee` and `partner_withdraw_surplus` accepted a token account the fee claimer does **not** own (the vault PDA's), so Ballast can claim straight into the vault | `Q4/result.json`, `Q1/result.json` (pre-migration withdraw `5nynW8so…zsjy6t`) |
| 5 P0 | **NOT RUN** | Stopped at Q2 per the P0 rule | — |
| 6 | **PASS** | Partner NFT held by `partner_auth` (the fee claimer); creator NFT held by `creator_auth`. `claim_position_fee` by each PDA via CPI succeeded | `Q1/result.json` q6Holders, `Q2/result.json` claims |
| 7 | NOT RUN | (planned: separate wallet-creator run) | — |
| 8, 9 | NOT RUN | (DLMM, after Q5) | — |
| 11 | **PASS** | Base mint freeze authority **None**, mint authority **None**, supply 10¹⁵ | `Q11/result.json` |
| 12 | **PASS** (+ findings) | Fresh Proof `PoolConfig`: owner DBC, discriminator `1a6c0e7b74e6812b`, 1,048 B, `version` 0, every sent field stored as sent. Vendored `crates/meteora-types` = SDK decode **field for field** on real accounts: `PoolConfig` 167, `VirtualPool` 60, DAMM `Pool` 307, `Position` 174 × 2; generator offsets = compiler offsets | `Q12/*.json`; `cargo test -p meteora-types` |
| 13 | **PASS** | Every DBC swap: fee = ⌈1%⌉ of the amount consumed, `Δreserve + fee = consumed`, protocol 20% of fee, partner = creator = 40%. Partner claim = partner share exactly | `Q13/result.json` |
| 14 | **PASS (partial)** | Protocol share is **0.2% taken in tokens**, not an LP position: 17,000,000 lamports (0.2% of 8.5 SOL migrated quote) and 654,409,983,148 base units (0.2% of 327.2M). So **L_total = L_perm** (pool liquidity = permanent-lock total = Σ two positions). Deposited Q_d = 8,483,000,000; B_m = 326,550,581,591,072. Realised L 3.0702e31 vs §27 predicted 3.0641e31: **realised ≥ predicted**. *Open:* fee basis threshold vs reserve, indistinguishable with a 1-lamport overshoot | `Q14/*.json`, `Q3/result.json` |
| 15 | **PASS (partial)** | With §7's curve (last point = migration price), an ExactIn buy that would overshoot **reverts** `InsufficientLiquidity` (6033). `swap2` PartialFill completes exactly (quote reserve 10,000,000,001) and refunds the rest. A later buy reverts `PoolIsCompleted` (6013). Surplus (1 lamport) withdrawable after migration. *Open:* overshoot on a curve with capacity past the threshold | `Q15/result.json` |
| 16 | **PASS** | Before migration: refused `NotPermitToDoThisAction` (6022). After: a **third wallet** can call it; destination must be owned by `leftover_receiver` (`ConstraintTokenOwner` 2015 otherwise); paid 134,558,940,128,194 base units | `Q16/*.json` |
| 18 | NOT RUN | — | — |
| (a) | **Done** | Lowest `migration_quote_threshold` accepted for a Lite (§7-shaped) config: **20 lamports**; 19 rejected `InvalidCurve` (6021). Acceptance monotonic over 10⁰…10¹⁰. No explicit minimum-threshold rule fired | `extra-a/result.json` |
| (b), (c) | NOT RUN | (migration at that size; Lite 100% permanent) | — |

## Other spec findings (non-blocking, for the owner's review)

1. **§7 validator rule 4** ("`migration_sqrt_price` equals the last curve point") does not hold
   exactly. Segment liquidity must round up so the curve can absorb the whole threshold, which
   leaves DBC's derived migration price 4,580,459 below the last point (relative 5·10⁻¹¹).
   Proposal: check `migration_sqrt_price ≤ last point` and that curve capacity ≥ threshold. Or the
   compiler solves for equality, once DBC's exact rounding is vendored.
2. **No overshoot with §7's curve** (Q15). The keeper and app must complete the curve with
   `swap2` PartialFill (or an exact amount); a naive ExactIn completing buy reverts.
3. **Curve capacity:** the on-chain `PoolConfig` stores 20 points (as §2 says); the SDK caps
   builders at 16 (`MAX_CURVE_POINT`). Our 3-point curve is unaffected.
4. **DLMM SDK** `LBCLMM_PROGRAM_IDS.localhost` is a different program from mainnet DLMM (T7);
   the harness passes the mainnet ID explicitly.

## Cloned mainnet accounts (found by execution, pinned with sha256)

| Name | Address | Found by |
|---|---|---|
| `dbc_event_authority` | `8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF` | Q12 `create_config` |
| `dbc_pool_authority` | `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM` | `initialize_virtual_pool_with_spl_token` |
| `damm_v2_pool_authority` | `HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC` | `migration_damm_v2` |
| `damm_v2_migration_config_customizable` | `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck` (DAMM v2-owned, 328 B) | `migration_damm_v2` |

Method: before every transaction, `send()` checks each key it lists (a Solana tx can read only
those) against the local validator and mainnet. Mainnet-only keys stop the run and are pinned
(`accounts/discovery.jsonl`). **Not yet done:** the requested `simulateTransaction` against
mainnet for each step. It is planned for the resumed run (config + pool creation, DLMM pair
creation are simulable there).

## Go / no-go for Ballast Full

**Provisional: GO, conditional on Q5** (not yet run) **and the owner approving the Q2 correction.**
Every mechanism-critical fact tested so far holds on the mainnet binaries:
- atomic, fully permanent, PDA-owned positions (Q1, Q6);
- constant L, full range, non-compounding (Q2 core);
- exact L ↔ reserves mapping (Q3);
- PDA fee claims via CPI into the vault (Q4);
- immutable supply (Q11);
- protocol share outside L, realised ≥ predicted (Q14).

The DLMM bid layer (Q5) is the one P0 still unknown.
