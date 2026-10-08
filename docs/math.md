# The floor equation

Ballast's floor `F` is the price at which the permanently locked DAMM v2 liquidity plus the vault's
bid can absorb the entire outstanding supply. Spec: `BUILD_SPEC.md` §4 and §11. Code:
`crates/floor` — the only implementation of F; the program, the verifier, the WASM build and the
keeper all call it.

## Definition

```
V/F + L_real·(1/√F − 1/√P_max) = S          L_real = L / 2^64
```

- **V**: quote that buys tokens at F — the vault balance plus `launch.bid_quote_committed` (the quote
  resting in the DLMM bid, counted at what was committed, so fills awaiting settlement can only
  understate F).
- **S**: outstanding supply — `base_mint.supply` minus base held by Ballast PDAs (the staging account).
  The DAMM pool's own base reserve is part of S.
- **L**: the `permanent_locked_liquidity` of the two positions recorded at `open`, and nothing else
  (the protocol position, external LPs and `pool.liquidity` are ignored, which can only under-count).
- **P_max**: the pool's `sqrt_max_price`, read live (DAMM v2's full-range maximum).

`L_real·(1/√F − 1/√P_max)` is exactly the base a full-range position holds at price F: if the price
fell to F, the pool would hold that many tokens and the bid would have bought `V/F`, so all S is
absorbed. Above F, holders therefore always have a counterparty at F or better.

## Computing it exactly

With `s = ⌊√F · 2^64⌋`, the equation becomes the quadratic

```
A·s² − B·s − C = 0      A = S + ⌈L/s_max⌉,   B = L,   C = V·2^128
```

1. `D = B² + 4AC` in 256-bit integers;
2. `s = ⌊(B + isqrt(D)) / (2A)⌋`;
3. correct to the exact floor of the root: while `A·s² − B·s − C > 0`, `s −= 1`; while
   `A·(s+1)² − B·(s+1) − C ≤ 0`, `s += 1`.

Bounds are asserted before any arithmetic (`S ≤ 2^50`, `V ≤ 2^64 − 1`, `L ≤ 2^120` — D-003,
`s_max < 2^97`); out-of-range inputs return an error, never a value. There is no floating point.

## Rounding toward the protocol

`⌈L/s_max⌉` in A, `⌊root⌋` for s, `⌊·⌋` on payouts and bid amounts, the bid in the highest bin at or
below F. Each makes the reported floor a little lower, never higher, than the exact one.

## Why F never falls

Every mutating instruction recomputes s from live V, S, L and ends with `require!(s_new ≥ s_last)`
(§4 rule 3). The proof in §4 shows each transition raises or keeps s: a fill swaps quote for tokens
at a price ≤ F and the tokens are burned; a redemption pays `F·(1 − 0.5%)` per token burned, the fee
staying in the vault; harvests and deposits add V; leftover burns lower S. Only a decrease of L — which
Meteora's permanent lock does not allow — could lower it; the program then marks the launch degraded
and keeps redemption open (§8 fail-safe).

## Evidence

| Check | Result | Where |
|---|---|---|
| §27 vectors, Rust = Python | all exact | `cargo test -p ballast-floor`, `python tests/reference/floor.py` |
| Property gate (100k cases): exact floor of the root, monotone in V, antitone in S, monotone in L within one ceiling step (D-004), payout ≤ exact | pass | `pnpm test:property` |
| Differential, Rust = Python | all 10,014 cases (§27, D-017 prediction, 10,000 random) | `crates/floor/vectors.json`, `cargo test -p ballast-floor` |
| Differential, WASM = vectors | 10,014 / 10,014 identical | `evidence/floor/wasm-differential.json` (`pnpm test:wasm`) |
| On-chain `floor()` = Python reference on live accounts | exact | `evidence/program/part2/results.json` |
| Model fuzzer: F never falls, the equation holds, conservation, sell-outs clear ≥ 0.99·F | 1M + 10M steps, 0 failures | `evidence/fuzz/model-1m.json`, `model-10m.json` |
| Verifier's independent prediction = D-017's table | bit-for-bit | `crates/verifier-core/tests/predict.rs` |
