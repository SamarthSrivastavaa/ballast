# proof:local — 2026-10-11T16:55:22.914Z

The §22 Proof launch on Meteora's mainnet binaries (local validator, D-001/D-007). Reproduce with `pnpm proof:local`.

| Claim | Value | Result |
|---|---|---|
| Prediction recorded in the pool-creation transaction, before any third-party trade (D-011) | 6.7019e-9 SOL/token | PASS |
| Realised F at open ≥ predicted | 6.7919e-9 (1.34%) | PASS |
| Full sell-out: lowest execution ≥ 0.99·F (gate 8) | 0.9984·F over 73 sells (38 to the bid, 35 to DAMM v2) | PASS |
| Vault ≈ 0 after the sell-out (≤ 0.05 SOL left in vault + bid) | 0.000058548 SOL; harvest then added 0.014898632 SOL of LP fees | PASS |
| F not lower after the sell-out | 6.8400e-9 SOL/token | PASS |
| Burned | 361,423,326.626 tokens (fills 226,864,386.498) | — |
| `ballast verify --sellout` | 11 floor updates | PASS |
| Gate 4: §10 ledger from chain data (after the whole lifecycle) | V = 1.555302673 in − 1.540345493 out (fills 1.540345493, redemptions 0.000000000), to the lamport; supply = minted − burned exactly; counters = event sums | PASS |
| Gate 9: 200 random transactions, 5 wallets | 0 monotone-check reverts | PASS |
| Gate 10: keeper off for 60 slots after fills: redeem settles the stale bid and pays exactly | 3 fills; succeeded 3hQULumknGtpjJ3BGhjprHh5E7EBcMgfk6pcJ8HjjnnZHyMtp4JjsswzRNCymN2bH1hhUcimMVfwMBUTzRvug43v | PASS |
| Gate 10: refresh with a stale bin hint is refused | BinHintNotAtFloor | PASS |
| Gate 10: dust redeem → PayoutBelowMinimum; min_out above payout → SlippageExceeded; s unchanged | PayoutBelowMinimum, SlippageExceeded | PASS |
| Gate 10: substituted accounts (fake position, pool, pair, order, vault, staging, beneficiary) | one negative test per substitution: evidence/program/part1/*.json, part2/results.json, part2/audit.json | PASS |
| Gate 10: verifier PASS after the injected failures | 76 floor updates, never decreasing; ledger reconciles (excess 0 lamports) | PASS |

## Transactions

| Step | Signature |
|---|---|
| create_class(Proof) — every §7 rule checked on-chain | `4kZfXSfzgyu17Zcg1UaiaCTiqoZT52PCtPoZwkPzzf25cPGrUc2zTU9g11CiMdiHAGiCcaRMHPbmshBg5L6akmrP` |
| launch (D-011: DBC pool + dust buy + DLMM pair + transfer_pool_creator + register_launch) | `5RZTfviZMrvKCeJxwmKgDb99mGi65AfysSJd5XQZ1SiwiHnRSCysJAu4a68DTyyuMsFij8KcR7Kw8zrBfishh3oS` |
| buy 1 | `4vrAoDBNt9R3bA8kbs7W7gBYPoq9yzJrdoCt7dF45KZfXruwijhMPKChVDrpAcqJiAmsMJuGXRnKfSt7bmgzv4V8` |
| buy 2 | `2qWKQ4Cdyi7tUouBqZUNuGbakd4TAuj1rxhgtfAkWaQ915rdPJ66aHj4NFr1uoxoigcTykc2tCeUpDGvesjs29V1` |
| buy 3 | `V3ruYMZ7uEeUMof8ARUiEqBRjsdKXapZEh3GyyJq4oRwSRj4ZuNWWRsgxnMcZiJkUAkMTyZeRUstmTfufYQaKmC` |
| settle_graduation | `4SGMtfdZdW5GGPtcGfa7Ccd9koLMxGzvHhz6hyd9ExfKXywLCce8i4TKHJaGgtgAw5YPeKs5YFrdGKAhpdFLoPdf` |
| migration_damm_v2 (top-level keeper) | `uPrEMwC5s5RBqCb8FtoQNcwEyu8XJ7iV1Vbt3nKJL6hqQKPEWy5SG8qkooSW1viZ6rGjxoRXq6WBTC85TKz1tM5` |
| burn_leftover | `5rEg5JDf7H4Zc9MbBeW8Y4CSkgkkF7PrYumCrS7v8eSoZsNJUEU4Cio6NThsPmmXSKR751TdAqCjmZXXdDwPe9gm` |
| open — bid at F's bin, active bin moved up (D-020) | `3j3W2RGh3LXFziMzN5uKJTTh2kRQ7ycZPuBjq7J9PnHpBE8x17EfwPz4hsD8W8Ej1zEioo8tXNHCeZbmsrkXoeab` |
| keeper: refresh_floor during the sell-out | `c85KpAvFsPiaaXw1ZM9UjkG4FcED7U1VGodS4EEfkEUU6YpaHXRrCn8FENKCAsJYRYDNqKg1abFFKeqfnMJ9GDa` |
| keeper: refresh_floor during the sell-out | `2R9U6j8VqdZULy5HE4kwYuRUESKrnDXrFQctjDHi8iTeBK8o56J2ErSpy2fZJvM2UN4nF5T7ft3Y61k179y845CK` |
| keeper: refresh_floor during the sell-out | `3zaqfUuSZf64DZjR9A8m2ZsxqBH798ANJasKWWe1tpp6sXHV1zAkuCAZMbbtT9trNXBrnyjUifk459GLY4JLWTWy` |
| keeper: refresh_floor during the sell-out | `3eX97WuicCHAwHEzNX5jELNDoqsn543BMfz5BrCdKuCugxjWrk3WBKHVN9RZ9Hoog4Tb5aghUufhSPgaPiGCMvzs` |
| keeper: refresh_floor during the sell-out | `5RADEGXuMJtfQGG8EfK1jhh96NSmWNX2U4ys7nikRBHxWDR15RPL8vaimCxHkskTUTCHEBAp27Gixv9hZq7A2k3P` |
| keeper: refresh_floor during the sell-out | `3FkEGbhhFcTMUsCJjeRTbxQEKAxbk1yDrPQQfZWUcXAbm86J3xtyU8CHmKQg6A3yjUipdvWXHAFPTVPT71GA2j5Z` |
| keeper: refresh_floor during the sell-out | `4zgAx6o9ngdeYDBwodgW8XuPgjQxtvJqZYr2swmLaA7q6thv8zevKAJV3LFJGJ5sA8RX9ecGgQW2iHfQDoGN2FyB` |
| keeper: refresh_floor during the sell-out | `3aJAiKpXYuDSjMVMP9BafGoRqEZ6Y6R4WVJVB9XCzib5qbtE6Qn4fpkbAyRoc8m6Lx41siuZ9cY9MVt3z7eCAMPB` |
| refresh_floor after the sell-out | `5QDZWxZtDrTm9MfEs3neFcer53G5JQz1xHqo8QnjcqY6rCXW8gEse2pJkoBxQnEjSiH2dJnV8kYSWtJ4yYnLDu4N` |
| harvest (succeeded) | `yndKLpCYAnm9tukhwUJdMDGxxXr8kTpNMfJdQRS3mP7yHxfQJaUGPyRW2EHkXSAkfUNhnziCUDHMNbU19nddasQ` |
| pay_creator (succeeded) | `5GT2EA2FfmWutDsPZ2m7nBeu8LJdk3WgKLnPtiMHyxfVsWHKBEr2VbigLRZrQ7LapSvezFtMZLA1BhtpNjMDTdCe` |
| gate 9: open | `54vPxjXk4GC71GMnsqJD4WBWoVqAwwqhLw9hFZAHGPABbVcNVcQenNr8LUjmLtYXmTMPUCmfZiAcXrJEhzvtVukH` |
