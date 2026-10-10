# Operations

Everything after `register_launch` is permissionless; nothing an operator does can move a launch's
backing. Operations are liveness: cranks, monitoring, and the deploy runbook.

## Environment

```bash
source ~/.ballast-env                       # Agave 2.1.21, Anchor 0.31.1, Node 20, pnpm 9, Rust 1.85.0
pnpm localnet --quiet &                     # mainnet-binary validator (fresh ledger, pins checked)
bash tests/integration/p0/up.sh             # fund the local payer
anchor build                                # → target/deploy/ballast.so, target/idl/ballast.json
cargo build --release -p ballast-verifier   # → target/release/ballast
cargo build -p floor-wasm --target wasm32-unknown-unknown --release
```

## The keeper

```bash
pnpm exec tsx keeper/src/main.ts --rpc <url> --keypair <path> [--launch <addr>...] [--once] [--interval 10000]
```

Per launch and state (`keeper/src/keeper.ts`): settle once the curve completes; migrate if Meteora's
keeper has not; burn the leftover; create the bid's bin arrays (D-013) and `open` at F's bin, falling
back to the active bin if a third-party order blocks the move (D-020/D-021); refresh when the bid is
stale, filled, capped or suspended; harvest and pay the creator on a schedule; keep `partner_auth`'s
rent float. One JSON line per crank with signature and compute units (§25). Its behaviour on the
mainnet binaries: `tests/integration/program/src/part6.ts` (`evidence/program/keeper/results.json`).

Anyone can run a keeper; several can run at once. If none runs, bids go stale but stay at or below F
and redemption settles the bid itself (§26; gate 10 in `evidence/proof-local/`).

## Alerts (§25)

- any `ballast verify` FAIL (run it every 10 minutes per launch);
- any `BackingDecreased` event;
- any transaction that reverts with `FloorDecreased` (an attempted violation or a bug).

## Deploying

- **Local** (authoritative proof, D-001/D-007): `pnpm proof:local`.
- **Devnet** (public cross-check, D-001: the local result governs): fund the devnet payer
  (`.keys/devnet/payer.json`, gitignored) and run `pnpm proof:devnet`. It checks the cluster's genesis
  hash, deploys with `solana program deploy` under `target/deploy/ballast-keypair.json`, runs the same
  §22 sequence, and writes `evidence/proof-devnet/`. Gates 9 and 10 run locally only.
  Cost at the current size (553,456 B; devnet rent is 5,080 lamports per byte, read 8 Oct): ProgramData
  2,812,435,320 lamports ≈ **2.81 SOL** (kept while deployed; `solana program close` returns it), a
  transient deploy buffer of the same size, the 10 SOL threshold (10.10 with the 1% fee; about 5.7
  comes back on the sell-out) and ≤ 0.6 SOL of rents and fees. **Minimum 14.2 SOL, recommended 17**;
  the script refuses to start below 14.2 (`DECISIONS.md` § Devnet SOL budget).
- **Mainnet**: §19's runbook — verifiable build, upgrade authority and admin moved to a 2-of-3 multisig
  immediately, `initialize_global(admin = multisig, treasury = multisig WSOL account)`, then classes
  from the multisig. No mainnet transaction is sent without the owner's approval of that transaction
  (D-007).
