# Meteora integration

All three Meteora programs carry part of the floor, and every behaviour Ballast relies on was observed
on Meteora's **mainnet binaries** running locally (D-001: dumped with `pnpm fixtures:dump`, pinned by
sha256 in `evidence/fixtures/mainnet-pins.json`), not assumed from docs. Answers and signatures: the
Top-20 table in `DECISIONS.md`; raw evidence in `evidence/p0/`.

## Dynamic Bonding Curve — the launch and the migration fee

- A **class** is one DBC `PoolConfig` whose every field `create_class` checks against §7: flat 1% fee,
  QuoteToken fee mode, 15% partner migration fee, 50/50 permanently locked LP, DAMM v2 migration with
  the Customizable fee option, a 3-segment curve pinned by hash (rule 3), migration price within a
  measured band (rule 4, D-017). `fee_claimer = leftover_receiver = partner_auth`.
- A **launch** is one atomic transaction (D-011): DBC pool creation, the payer's dust buy (DLMM needs
  the funder to hold ≥ 1 base unit, Q8), the DLMM pair, `transfer_pool_creator → creator_auth`, and
  `register_launch`, which verifies the rest by instruction introspection — so the prediction is
  on-chain before any third-party trade.
- **Q4**: `partner_auth` signs `withdraw_migration_fee`, `claim_trading_fee`, `partner_withdraw_surplus`
  by CPI; the migration fee is withdrawable before migration. **Q16**: `withdraw_leftover` is
  permissionless and pays only the leftover receiver's ATA, so a front-run lands where `burn_leftover`
  burns it (D-016). **Q13**: fee = ⌈1%⌉, protocol 20%, partner = creator = 40%.
- **D-010**: the DBC field value that yields a DAMM v2 OnlyB pool is `migrated_collect_fee_mode = 0`
  (DBC's enum differs from DAMM's; §7's original value would have produced a BothToken pool — Q2).

## DAMM v2 — the locked liquidity, L

- **Q1**: one `migration_damm_v2` leaves both partner and creator positions fully permanent
  (`unlocked = vested = 0`) in the migration slot. **Q6**: the partner NFT goes to `partner_auth`, the
  creator NFT to `creator_auth` (the pool creator after D-011's transfer).
- **Q2**: the pool is OnlyB, non-compounding, full range; swaps and fee claims leave L unchanged.
  **Q3**: reserves match `L·(s_max − s)/(s·s_max)` and `L·(s − s_min)/2^128` within 2 units.
- **Q14**: the 0.2% protocol share is taken in tokens, not as an LP position, so all migrated liquidity
  is permanent; only the two recorded positions count toward L.
- `open` records both positions after checking them in full; afterwards they are read for identity
  only, so a (hypothetical) decrease degrades the launch instead of blocking it (§8, audit 7 Oct).

## DLMM — the bid

- **Q8**: a customizable LimitOrder pair's address is `[ILM_BASE, min(mint), max(mint)]` — one pair per
  mint pair, no bin step — so the bin step is fixed per class (D-014). `partner_auth` creates no pair;
  the launch transaction does, with the class bin step (10 bps).
- **Q5**: `partner_auth` places and cancels limit orders by CPI; fills persist; cancel returns filled
  base, unfilled quote and fees exactly. There is no claim endpoint: fills are collected by cancel →
  burn → re-place (canon correction 4).
- **D-020**: DLMM accepts a bid only at or below the pair's active bin, and `go_to_a_bin` moves the
  active bin permissionlessly unless an order sits in the range (6056). `open` / `refresh_floor` move
  it to F's bin; if a third-party order blocks that, the bid is capped at the active bin.
- **D-021**: the cap is allowed within 70 bins under F's bin; further down the DLMM leg is suspended
  and the vault rests unplaced while redemption stays live. At bin step 10 DLMM confines a pair's bins
  to ±35,163, inside its internal bitmap (`evidence/program/part2/dlmm-bin-range.json`).
- **Q9**: bin steps 1–50 accepted for LimitOrder pairs; `initialize_bin_array` costs ≈ 199k CU, so the
  keeper creates bin arrays before `open` (D-013).

## Devnet

All five Meteora programs exist on devnet at the same addresses, but every devnet binary differs from
its mainnet build (`evidence/devnet/program-ids.json`). The DAMM v2 migration config used by DBC is
byte-identical on both. Devnet runs are a public cross-check; the mainnet-binary local results govern.
