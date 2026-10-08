# Limitations and disclosures

What Ballast does not do, what it depends on, and where its numbers come from. Every item names its
evidence. This page says nothing is safe, insured or protected, because none of those words would
be true.

## What F is, and is not

- **F is a price in SOL, not in dollars.** If SOL falls, F in dollars falls with it.
- **F is an executable buyback floor on Meteora, not a promise about prices elsewhere.** Anyone can
  sell directly into the DAMM v2 pool below F; the DLMM bid and redemption do not execute below it.
  A print below F on DAMM v2 is not a violation (§24).
- **Late buyers can lose most of what they paid.** At graduation the market price sits roughly 3.8×
  above F for the classes as configured (the measured Proof launch: pool ≈ 3.8·F, see
  `evidence/program/part2/results.json`), so a buyer at that price can lose ≈ 74% before reaching
  the floor.
- **The six prices are different numbers** (§9): theoretical F; the bid bin price (at or below F,
  within one 0.1% bin); the executable bid net of the DLMM taker fee; the DAMM v2 price; the DAMM v2
  sell net of its 1% fee; and redemption (F less 0.5%). Ballast labels which one it shows.

## The DLMM leg can be held below F by a third party (D-020, D-021)

DLMM accepts a bid only at or below the pair's active bin, and anyone can move the active bin while
no liquidity lies in between (`go_to_a_bin`), then hold it there with a dust order. Measured on the
mainnet DLMM binary (`evidence/program/part2/dlmm-active-bin.json`, `dlmm-bin-range.json`):

- **Within 70 bins under F's bin**, the bid is **capped** at the pinned active bin (at most ≈ 7%
  under F). It is still a bid at or below F; `BidCapped` is emitted and the verifier reports it.
- **Further down** (the deepest reachable bin at bin step 10 is −35,163, about 23,000 bins under F),
  the DLMM leg is **suspended**: the vault rests unplaced, V still counts it, `BidSuspended` is emitted.
- In both cases **redemption still pays F less 0.5%**, for any amount whose payout is at least
  0.001 SOL. Any `refresh_floor` lifts the cap or suspension as soon as the blocking order is gone;
  while held, such a lift is exempt from the rate limit.
- A holder whose whole balance redeems for less than 0.001 SOL (§10's minimum) cannot redeem. While
  the bid is capped, that dust can only reach the capped bid or the pool. The model fuzzer reports
  these executions separately (`evidence/fuzz/`).

## Dependencies on Meteora

- **DLMM pair status.** If a Meteora operator disables the pair, `cancel_limit_order` can fail and the
  bid and redemption pause; the locked DAMM v2 leg still works (§10 "Dead market", §26, Q19).
- **Meteora admin powers** (pool fees, pool status, program upgrades) are outside Ballast's control
  and are excluded from the challenge (§24). Q19 is not yet answered on-chain.
- **Jupiter routing** to a fresh pair and pool is a mainnet-only question (Q10) and was not tested.
- **Devnet runs different Meteora code.** All five Meteora programs exist on devnet at the same
  addresses, but every devnet binary differs from its mainnet build (`evidence/devnet/program-ids.json`).
  Per D-001 the mainnet-binary local runs are authoritative; devnet is a public cross-check.

## What was proven where

- **The authoritative proof runs locally, on Meteora's mainnet binaries** (D-001, D-007):
  `pnpm proof:local` — the complete §22 sequence, deterministic and rerunnable. No mainnet
  deployment of the Ballast program exists unless and until it is funded and approved
  transaction by transaction (D-007).
- **Compute units are local measurements** (Agave 2.1.21, finding T6). Mainnet cost models can differ;
  every budget keeps headroom (`open` 139k of 400k, atomic `redeem` ≈ 200k of 1.2M).
- **Open questions** from the Top-20 that no run has answered: Q7 (can a creator-owned permanent
  position be split — moot while `creator_auth` holds it), Q10 (Jupiter), Q17 (Meteora keeper latency),
  Q19 (admin powers), Q20 (Token-2022 WSOL handling, excluded by the class rules).

## Trust that remains

- **The program upgrade authority** can replace the code, and with it every rule here. §19's runbook
  puts it and `global.admin` on a 2-of-3 multisig and discloses it; a frozen, verified build is
  post-hackathon work. Until then this is the residual trust.
- **Rounding** goes toward the protocol everywhere (floor of the root; payouts and bid amounts
  rounded down; the bid at or below F). A seller loses at most a lamport or two per trade to it.
- **The prediction is a lower bound** (canon correction 6): the realised floor at `open` must be at or
  above it, and is checked on-chain (`FloorBelowPrediction`).
