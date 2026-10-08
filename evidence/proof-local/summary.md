# proof:local — 2026-10-08T19:50:59.260Z

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
| Gate 9: 200 random transactions, 5 wallets | 0 monotone-check reverts | PASS |
| Gate 10: keeper off for 60 slots after fills: redeem settles the stale bid and pays exactly | 3 fills; succeeded 2GgGG939K2HUcF6XfFsHdqPKfX5kHs6rWUQTZafz9a1NFpV7VrGQGJrJU2JHN | PASS |
| Gate 10: refresh with a stale bin hint is refused | BinHintNotAtFloor | PASS |
| Gate 10: dust redeem → PayoutBelowMinimum; min_out above payout → SlippageExceeded; s unchanged | PayoutBelowMinimum, SlippageExceeded | PASS |
| Gate 10: substituted accounts (fake position, pool, pair, order, vault, staging, beneficiary) | one negative test per substitution: evidence/program/part1/*.json, part2/results | PASS |
| Gate 10: verifier PASS after the injected failures | 78 floor updates, never decreasing | PASS |

## Transactions

| Step | Signature |
|---|---|
| create_class(Proof) — every §7 rule checked on-chain | `23oWiv2EmUaAMTYyvf2kbr12yrpsXFYaHBYYyFXem7ZqGu9DsScHq4Hba3ARZUSBcKc8v53j6UjaEQpMngH3Aydz` |
| launch (D-011: DBC pool + dust buy + DLMM pair + transfer_pool_creator + register_launch) | `ACZiuHjU7KbREMrDvJCb5casA2E64QcMC9F3o3aqhS6z4zmXc8pH2CYwWkWx6Bb51RPDLUJHaX28vWhVMkSFdFp` |
| buy 1 | `4geCx3PJcz7wTSbx7apWEWXYGNqXwvfbgJChpcBpetr1cdyQh3uQyyrKov7upEgXdxnG8SUuMM4pruTSsp6Kwjy6` |
| buy 2 | `3gVNXh1jYJZzGAAPuRxX6fQZqEhiLFs9USQMXUmi16UGC6ReLFY9N4dSuGTJAaGs4V7A6ut4wGvD84a5hNPbHoT5` |
| buy 3 | `2kaexvNebqXDju4Du7BKTYqgVudnWM4Dkt2hxLRuRn2hopMAoCC5e9AGdP8aYygQuVArHGW3vnaartsRfpRq6H6X` |
| settle_graduation | `2L2E9RA9Aeg5iPjKUSboNgVNdatShLDjBRsGGjbmavCqgyB27LTCudUiDX33QK3Y8Kpmvqhg7CbTy3nC7CVNfPBd` |
| migration_damm_v2 (top-level keeper) | `66HE9BHzaj76MVbhXVE7PrJpjWnBZxpNFKjtUnPRR4SSz5eDv9jpAb873vBZwVGKJoYvmWSBMCqK5QXvw2ZBpjJG` |
| burn_leftover | `24juvTPhaiB3yEYeJbKwGdpDhGHTdRgU5J5kgy4fT1LBh9fLqPbGyWSGwyviBxrmoH8DnVYbUVuUCYVfZtcDPTtA` |
| open — bid at F's bin, active bin moved up (D-020) | `26vL3MsqCnwvmKUMYmA4ApuugbjrnEytB3QVuJG4wPpYUeoocjtoCyKNhxr6i6gQV3inXVjuQW6npwMdDYvoJYFS` |
| keeper: refresh_floor during the sell-out | `4KSRpVyV7V3QqSnHbyNgy2hQj1vfoCAKPkiDTk1T5dVrXYeJGn1DCoctHCPqgXejZBw6SwJnkLmFKidUyaBPpdk3` |
| keeper: refresh_floor during the sell-out | `4MumWeZs4a1oWg9QXYCJB8Mb8qSTzG2UYh9QtvXEM9H26k8iPFDk928DpyDncT6Sd9DsxsYF9vYkY7NDvgcV4UDo` |
| keeper: refresh_floor during the sell-out | `3D9eX62CHKVtxiyNpXP7MapAo5trzi3ktQ4pHyTZ3hdLU8G5xd51Cw94oZcuRXHaw1tQVW6HNs6RwMWf4KxcS9id` |
| keeper: refresh_floor during the sell-out | `2RiV6T98uGuE1KoTsNpb7uV9eL9QrSermbFaV5Tjh8XWwkuy56Vgsg87oxPSsiukc29MDotUj833YbPyQRDQdRof` |
| keeper: refresh_floor during the sell-out | `3EH7XV824WPHX994V8oMncQucnzdavPBvMHAXM1GEiNjxCwyiH5P9BNZhLAukVgktKkqjpfMu7VyVz2J36c3TdMU` |
| keeper: refresh_floor during the sell-out | `3Xb84N41YxVEL5yCsknXgBVrVeGboqFdPTwwCgx1vEUKTimLL8gmTftJ72HJqxUbgVTwwoQzhBT8VcRimFhigJVa` |
| keeper: refresh_floor during the sell-out | `3TUFvvFTGu8Qcum656SYSX9sgpfQwZdh27B7PogQW44dMBQd7jaPf58xfwz4xnRqi3ckXxRZtWSevNmu7aWj4Lq4` |
| keeper: refresh_floor during the sell-out | `2Cn2Bp7W4YYXjwdBmFvaCP5cbM3pZwj6UQK8iMbxY96RRNmthyhnWevUiDhpbF1n8SmZc838KETGSmpSuvZ7fLX2` |
| refresh_floor after the sell-out | `oqCMdxD7j69tFJWFPcvv6gDf5DBBtCM1pFkavBTzo4aCPCJN68mdwBGTxwu3NQwJHVP2f3rjFTFCEeoiEo2yk45` |
| harvest (succeeded) | `5uf9VQVw8fLXTYQHYdmni8FHnMXREqPy67uCj9YR6v2PwjJA1MwcUL6vtPBq84xU2B3wiMW8ZU342dKag9FhnzFH` |
| pay_creator (succeeded) | `4C4Tp3baunNQUs8Vj8RRWJKUdfPhGDfBf6LFBf2Q4sMgVxA73SC6U6UK59egd6Dwpb1n9vViABEYRDXMbQJhAKQ5` |
| gate 9: open | `2YamBEzewJgBWwHRuNLCDJHUzaDtxJgYAomTj575YK5XvgccQkrUQHyQzthf6rK78e9iDbea22o4FD7Pf5vf7pup` |
