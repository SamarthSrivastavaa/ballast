# Mainnet dry run — 2026-10-11T17:08:58.039Z

The whole Proof launch on the local validator running Meteora's mainnet binaries, with every wallet measured. **No mainnet transaction was sent.** Rent is read from mainnet.

| Item | SOL | Notes |
|---|---|---|
| Program rent (553,456 bytes) | 2.813268 | kept while the program is deployed |
| Deploy buffer | 2.812395 | transient: refunded when the deploy finishes |
| Deploy write transactions | 0.002735 | 547 transactions at the base fee; priority fees extra |
| DBC config, class, keeper float | 0.210249 | rents; the 0.2 SOL float stays with the program's PDA |
| Launch rents and every crank's fees | 0.418786 | DBC pool, mint, metadata, DLMM pair and bin arrays, lookup table, cranks |
| Buys to the 10 SOL threshold | 10.106143 | three wallets, 1% curve fee included |
| Sale proceeds on a full sell-out | -5.785891 | comes back to the three wallets |
| **Peak balance needed** | 13.551182 | the deploy buffer is refunded before the buys |
| **Spent for good after a full sell-out** | 7.765290 | includes the program rent; `solana program close` would return that part |

Sell-out in this run: 73 sells; lowest execution 0.9984 × F (a DAMM v2 sell); fills on the DLMM bid never below 0.9994 × F; F not lower: true.
