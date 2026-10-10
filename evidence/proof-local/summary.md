# proof:local — 2026-10-10T12:45:08.775Z

The §22 Proof launch on Meteora's mainnet binaries (local validator, D-001/D-007). Reproduce with `pnpm proof:local`.

| Claim | Value | Result |
|---|---|---|
| Prediction recorded in the pool-creation transaction, before any third-party trade (D-011) | 6.7019e-9 SOL/token | PASS |
| Realised F at open ≥ predicted | 6.7919e-9 (1.34%) | PASS |
| Full sell-out: lowest execution ≥ 0.99·F (gate 8) | 1.0173·F over 72 sells (37 to the bid, 35 to DAMM v2) | PASS |
| Vault ≈ 0 after the sell-out (≤ 0.05 SOL left in vault + bid) | 0.045844528 SOL; harvest then added 0.015062311 SOL of LP fees | PASS |
| F not lower after the sell-out | 6.8394e-9 SOL/token | PASS |
| Burned | 354,679,899.1 tokens (fills 220,120,958.972) | — |
| `ballast verify --sellout` | 12 floor updates | PASS |
| Gate 4: §10 ledger from chain data (after the whole lifecycle) | V = 1.555466352 in − 1.494559513 out (fills 1.494559513, redemptions 0.000000000), to the lamport; supply = minted − burned exactly; counters = event sums | PASS |
| Gate 9: 200 random transactions, 5 wallets | 0 monotone-check reverts | PASS |
| Gate 10: keeper off for 60 slots after fills: redeem settles the stale bid and pays exactly | 3 fills; succeeded U2zTmPdQaEZs1SFhd6ut41CmtQjZpjEtqAcG9zuCo2e1F3DP3DkCNhvC9fMfKeaKHXVP9tEkKhiWbUfjBPS6siQ | PASS |
| Gate 10: refresh with a stale bin hint is refused | BinHintNotAtFloor | PASS |
| Gate 10: dust redeem → PayoutBelowMinimum; min_out above payout → SlippageExceeded; s unchanged | PayoutBelowMinimum, SlippageExceeded | PASS |
| Gate 10: substituted accounts (fake position, pool, pair, order, vault, staging, beneficiary) | one negative test per substitution: evidence/program/part1/*.json, part2/results.json, part2/audit.json | PASS |
| Gate 10: verifier PASS after the injected failures | 77 floor updates, never decreasing; ledger reconciles (excess 0 lamports) | PASS |

## Transactions

| Step | Signature |
|---|---|
| initialize_global | `dNihwYfGyBZMaJ8znzQwJJMG97LmDDbpMfnGQ1ZVd7t2aYXSQUaqjXwKYTYCWm4BHKWriAmAwxVHgEn7XnjCgeq` |
| create_class(Proof) — every §7 rule checked on-chain | `5SdXsyU8j4vaypg41PdSJFh4ggJycu5j8XevNN6WGT385T8uTgsetS5SgHZpY88dEeqjjLCH8J3gWnVe6KtxnTgq` |
| launch (D-011: DBC pool + dust buy + DLMM pair + transfer_pool_creator + register_launch) | `4sm5FvS8quQSM5V1VvSiJEfxehZvL4sRVosFb4U8zzfrVmLU6b7jNHxFrecNyNZ6fhjgDV26JxhAE7SzkALneFNS` |
| buy 1 | `Zkp98Piu32EX5t6XVMAMK6VxupdT2ACHEMTKZUyk2yoFqPpMFmiPNNHxQeaahgNQHnLjJfy7eQ7JrrS44efdgPm` |
| buy 2 | `4Pi33z5SgFLz8JToQNz3m1SqnAWS11hcEMnjZrWXYwZyJRznN7sGnLBcYuasBGU6Mp2UgacAMhnvHE9L29zBAk4a` |
| buy 3 | `2Q3jkrPaj81arQ4GYuF2kpdQUHRcvb4ucxBSMcEQdeKErDFnyRbXbnNoy35eG271DEhFHdmBUzx1RhhT8ZiVJh9P` |
| settle_graduation | `5VUDQd5fCyqxCtDnpP8NsTHBkQJnbPccC2ZJbPGE9XhKZqrbCAtRBUhwRLDjvyWDvgKviufYgu59PhvDxvGDzgyM` |
| migration_damm_v2 (top-level keeper) | `55p2RHyQG2MyXs7MAiK5Rn3Ak2SWczEU97anmkDEPPn7eXtrAgb3VyziPjp9WuSobjE2BiShdeXsbxibRaYYZAPt` |
| burn_leftover | `tsgaRPZwpwbipNPDVtkBmxWMs85K4PTQ4yTiej5Ln6gPAqfsZnB9SzgKfxnBaKpd4EwLbxSUooJPyHaBWr6qHYR` |
| open — bid at F's bin, active bin moved up (D-020) | `Nz1crp9tBSJTJPaCTKCo8btWKwupF28FiP6ACVrFYah6RYqZrzbEQvUbaB6yQ6YqVhy1NaRZXTPJw6EmzurvwsC` |
| keeper: refresh_floor during the sell-out | `2yPWnZnwdukjs2mq1cpmFUy9CzeMtv39Zqq85zRrxhkLx8QieXqvFvaY54EcuucJimFVBSJ4NxiJ9g2UQezbmudn` |
| keeper: refresh_floor during the sell-out | `2Vm9pcb3Ra7xbHqZXhGPtQsNf9SCwWxb3ASfCeKHHknDXvsw3WycLmSpVVZry7BwNvaszFm5F2WCUBH1C47Cq84q` |
| keeper: refresh_floor during the sell-out | `2h5pK3z3q9adjkyZx9Bq1mU55abpkJ2Yv9877fW2rnvdGAZvdvrLad8d2hJ7HoUycxDCNJtFHMVVHq4MoZcVBm8N` |
| keeper: refresh_floor during the sell-out | `3hxUB6tKzGXpCKV3TqKUTx5HMvqZeMi2472JUJG4h4mpB3fGJbZ1bKurJTuWm7Qs6wwCgtweuwENJwFVjywRWdAY` |
| keeper: refresh_floor during the sell-out | `5qaTUzrNfrHX7eR8tNyCvJJGggTLHQaFciZG6DtPuETSx7Lxtc3NNPHCNmJw1UjVEy4bMgpYZE5vWYQ15ikmfFnG` |
| keeper: refresh_floor during the sell-out | `5JcwcEk2HwJSTWboZuwZFbDNyoFoRC6oGQCWHKFuzGMuVYTFdJWPYMM5wJgn89NJghNbskkYbVaYeekTrmBuf6V5` |
| keeper: refresh_floor during the sell-out | `2NjZyHaAHEocVXmEeASvDihJ9W7FpaS116UNiA935nz2preTcm4rcXNPeQ82ixCk8ESaco7vZozzV4u4Uhoi4WHC` |
| keeper: refresh_floor during the sell-out | `5d5qYSbkWnNfR31gkSicp8SmXk6CV4K6v1NfstkNFvSX8p2PFxp4jzaTJGZ6x1C7jqVa5ssSmDtrqU8MeDsvqE8K` |
| keeper: refresh_floor during the sell-out | `4U5eeAkqiRNNkFEbNgZu8e5qvXvFowy4hng988Y2gnbUaj3ca8CWrUpFHsXUfyVXduBaFB2TPkS6xwVCGeaQPZrk` |
| refresh_floor after the sell-out | `E2GrYQ2FaKFkSFbJYqW9kcuqr9YbEYNtYmB3eYrR685TCnMd1kWLzHT5m4npf3KcmU3FRRS3LDJJptF3ndKeJJX` |
| harvest (succeeded) | `ipdQhZg5fprdttWRaeBj5oCQ96dgcQuUJDAiPwe31VNMhpmYTANvrKpgBkjCEy6kHHSR1YfzhSw5au4Gm9yqD4o` |
| pay_creator (succeeded) | `4Yjnymu1NSVLu3esAVYhGWUV1cMcaHW9edG1e7C6fdcgx2Fsq4WctEMg2TCSDVTB7z37eCVWEFYWd9cLmH1fbYE4` |
| gate 9: open | `4MrKw2RDGCBmwixVtum8fPKbDGFZtpZvNrsqNqSmjTjfStcze7fkiwev5GsuG28gA8etKqJS8x4UesMNGMpLE8kw` |
