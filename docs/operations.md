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
- **Devnet** (public cross-check): `solana program deploy -u devnet --program-id target/deploy/ballast-keypair.json target/deploy/ballast.so`, then the same proof sequence against devnet.
  Rent for the program at its current size (551,488 B): ProgramData (128 + 45 + 551,488) × 6,960 =
  3,839,560,560 lamports ≈ **3.84 SOL** (kept while deployed; `solana program close` returns it), plus a
  transient buffer of the same size during the deploy. The proof itself needs the 10 SOL threshold
  (10.10 with the 1% fee) and ≈ 0.5 SOL of rents and fees.
- **Mainnet**: §19's runbook — verifiable build, upgrade authority and admin moved to a 2-of-3 multisig
  immediately, `initialize_global(admin = multisig, treasury = multisig WSOL account)`, then classes
  from the multisig. No mainnet transaction is sent without the owner's approval of that transaction
  (D-007).
