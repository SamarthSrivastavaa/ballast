# proof:local — 2026-10-11T15:26:31.397Z

The §22 Proof launch on Meteora's mainnet binaries (local validator, D-001/D-007). Reproduce with `pnpm proof:local`.

| Claim | Value | Result |
|---|---|---|
| Prediction recorded in the pool-creation transaction, before any third-party trade (D-011) | 6.7019e-9 SOL/token | PASS |
| Realised F at open ≥ predicted | 6.7919e-9 (1.34%) | PASS |
| Full sell-out: lowest execution ≥ 0.99·F (gate 8) | 1.0174·F over 72 sells (37 to the bid, 35 to DAMM v2) | PASS |
| Vault ≈ 0 after the sell-out (≤ 0.05 SOL left in vault + bid) | 0.045844528 SOL; harvest then added 0.015062311 SOL of LP fees | PASS |
| F not lower after the sell-out | 6.8394e-9 SOL/token | PASS |
| Burned | 354,679,899.1 tokens (fills 220,120,958.972) | — |
| `ballast verify --sellout` | 11 floor updates | PASS |
| Gate 4: §10 ledger from chain data (after the whole lifecycle) | V = 1.555466352 in − 1.494559513 out (fills 1.494559513, redemptions 0.000000000), to the lamport; supply = minted − burned exactly; counters = event sums | PASS |
| Gate 9: 200 random transactions, 5 wallets | 0 monotone-check reverts | PASS |
| Gate 10: keeper off for 60 slots after fills: redeem settles the stale bid and pays exactly | 3 fills; succeeded 3KmoBSFEREwoeS6hrVo4R99kyP16rtVYV4JPVTZsVSbWVciouevYLos3B5GWZZSChxsKGWUEQ1h4wUZRkyH5TcL | PASS |
| Gate 10: refresh with a stale bin hint is refused | BinHintNotAtFloor | PASS |
| Gate 10: dust redeem → PayoutBelowMinimum; min_out above payout → SlippageExceeded; s unchanged | PayoutBelowMinimum, SlippageExceeded | PASS |
| Gate 10: substituted accounts (fake position, pool, pair, order, vault, staging, beneficiary) | one negative test per substitution: evidence/program/part1/*.json, part2/results.json, part2/audit.json | PASS |
| Gate 10: verifier PASS after the injected failures | 76 floor updates, never decreasing; ledger reconciles (excess 0 lamports) | PASS |

## Transactions

| Step | Signature |
|---|---|
| initialize_global | `5hNMSpK1CcABxi8tBtWoUiA5gervWRXTSBM9PiSkMVMwRaUW7HpwPsxGHsDWPxkpEBoooz3HFCuVJpGXmdFVCsN5` |
| create_class(Proof) — every §7 rule checked on-chain | `5ixXZ11sXz3LgCGiL7jBiwtN5F8rwabXHoSQEnY1o1RucyU1iYtdwFbB95DFqQL3uPSwQWg174i5nEYWv4QdvHxk` |
| launch (D-011: DBC pool + dust buy + DLMM pair + transfer_pool_creator + register_launch) | `4b3vNmiTPz51kagpRCVtjPZFY7bYChSC4ASN1dDTY1iG4qPNogdwoDoqBp259KATaX5UMunZuLgQoAT1tFJodHWT` |
| buy 1 | `59YQPMfqq5F3qCaXeZZWSR2jCbnCbH6Q1gyDXC9vABud7xVeFhrMwRHerjLGyjgQcqxFB5PJ1xhp4RGMxeNETRXN` |
| buy 2 | `2x4NSmSc975Trz9FLMp8de6DmEXeK4MkSea2mhapPUiRJxvB61GAs4JA7244wEWLJ4g9M4kwMtjVyC8jp5mwVJyn` |
| buy 3 | `4ij2gxqCTtg9FegWJvGE5WHkmdGxw6HoQbgih99HXrRehmii6cpn6Lwed5Ap6BKDWuHtgYXkdwRk9vHuEXJ17xWk` |
| settle_graduation | `4Sxs9fMjeZ7j7FJYniEkWxyBxBCZXHAjDQ7SSAJiUtp16SidnQq12ujWoqofNMR3BEgrk62e7bJguA9cTgko6jXL` |
| migration_damm_v2 (top-level keeper) | `2M5RUo48Kiro6jiLgGznzDZwPX3wjqFDcS39dreJbnSa9CShEP2DeP9NKY818D1eYFBfL9PkgMP9tXfdGnQwL4Po` |
| burn_leftover | `3yRvdNcrV6GvjG5ezaVeZKYtbBG52tnzR2Fkduu6KsMQcSCxKDGQivnErenwUKFzXkXyiumiaxR5yYh2CrL4RKko` |
| open — bid at F's bin, active bin moved up (D-020) | `isxnur9cjHVCsoZ7WG1XjZasgFpaAcKk6x5qsMQuM5HZsnbDJquPW9DDbgARtMtixrTdfgdrFZ8yfJGVtF11oJz` |
| keeper: refresh_floor during the sell-out | `SZFAX1T5fAf3MWireiekeutY8w4ac1VF7cpdJMWoUjUxrvewt9XnsgzRM33Tpom9xXZcDGT6Z61rAWXf93zvZif` |
| keeper: refresh_floor during the sell-out | `2t7zRiaKErLwEVCgGdSXz8XCfRSVRngXCrzMdn3BVTp7w3e2GXZtyS6djnM3QMXSBqmqaxWGrWrXc24JkAKFwCvj` |
| keeper: refresh_floor during the sell-out | `31oavPWcB2bynTxqakqhbi5bnbU46T3MDGnHBERgFoLcAYNZdR7ZzQm4geMJgrfbnXrKFz7ugzGQVC4DY3yJPi8t` |
| keeper: refresh_floor during the sell-out | `62mv1f6KQkTA2zT5xES7DcM6UE58uEg4Z5SHvTNR3u9y8cLqK1dKSDY4bGgHjM1SL36kcrjuYxSy64vunMJQNT7j` |
| keeper: refresh_floor during the sell-out | `2hXVcx47P6DTvCVWEiD4QYJmwSeTyzAGbV6HLyjriQtLFCBro5GnCMfpTUSgnfyqVBS7n25x79ejy25U4MyGde8h` |
| keeper: refresh_floor during the sell-out | `48bsgoHLsz3SyC4LKpuiiEWFLqyQTSnr3KWmiQycysTeHXCJYoSk5raRVoAcmRSfmUvDq2c7r1ekDGFMAGwb75nz` |
| keeper: refresh_floor during the sell-out | `3HT9gmKMTQUXgBGMQ9UYTm5d5YFMxYeh89v71VpvnMAHtpJjBxqocoGQpB9EWojxcYW7WTtPWbQC8SUnWoJJiq6J` |
| keeper: refresh_floor during the sell-out | `4mydQ5rpBaSDjyHNPHzuBKba3EaugxWTRr7tHm7zkf3LbmBrWJ6ewhq4ez2vzY9XogEUvGmUeJJJrFvz36jRuLUW` |
| refresh_floor after the sell-out | `3GkkjVMHvNke1SZshV18NtdKgdzWFJZhaZXJHjLcRS4nhXzMLKBQGF3cysyowaXPnpdGCVeGdB6aErSPkWHswmj9` |
| harvest (succeeded) | `23FSzuakDrbGgosCMtG3KYChw2xhGAUupL7FqkX4eSGsjD7GF4J4GW58YPYHBta9LK68ajGvL4YFoFzDhimG28Ae` |
| pay_creator (succeeded) | `3K8NS4jtH4opwmEhUJtxhk8Y5vcxzSjuiorMsZ1hxpj2EbYrYNRanwD9Z6es7iqQSG2FhSChATokCCmZi63KoCPr` |
| gate 9: open | `3H8iw34oeHECuqZrw1w6b4qbcGNVvRroHbSrze3sGizirYXWwXvVW4MbxNyYVwAFhdDxQUndZxRsECLwbVixCUBx` |
