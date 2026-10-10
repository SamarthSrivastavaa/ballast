# Ballast

A Meteora DBC launch class with an on-chain, **executable buyback floor** `F`.

**This is an executable buyback floor on Meteora, not a promise about prices elsewhere.**

At graduation, 15% of the raise is withdrawn as the DBC migration fee into a program-owned vault;
the other 85% migrates into a DAMM v2 pool as two permanently locked, PDA-owned positions. The whole
vault rests as one DLMM limit order in the highest bin at or below `F`. `F` is the price at which the
locked liquidity plus that bid can absorb the entire outstanding supply:

```
V/F + L·(1/√F − 1/√P_max) = S          V = vault quote · L = permanent liquidity · S = outstanding supply
```

**The claim is falsifiable.** The floor is predicted on-chain in the pool-creation transaction,
before any third-party trade (D-011), and `ballast verify` recomputes it from raw accounts with no
dependency on this project's app. The claim is "realised F ≥ predicted F".

**Late buyers can lose about 74%.** At graduation the pool price sits roughly 3.8× above F, so a
buyer at that price can lose ≈ 74% before reaching the floor. F is a price in SOL, not in dollars.
Selling directly into the DAMM v2 pool can execute below F; the DLMM bid and redemption do not.

## How it works

| Meteora product | Role in the floor |
|---|---|
| **DBC** (Dynamic Bonding Curve) | The launch class: two configs (Proof 10 SOL, Public 25 SOL) validated field by field on-chain; the prediction is recorded at registration |
| **DAMM v2** | 85% of the raise, in two permanently locked positions owned by Ballast PDAs — L in the equation |
| **DLMM** | The vault as one limit order at the highest bin at or below F — V in the equation; fills are settled by cancel → burn → re-place, which raises F |

Holders always have two ways out at or above the floor: sell into the DLMM bid, or **redeem** with
the program at F less 0.5% (the fee stays in the vault and raises F for everyone else). Every
instruction that changes V, S or L ends with an on-chain check that F did not fall.

Every number is one of six distinct prices, and Ballast always says which: **theoretical F**, the
**bid bin price** (at or below F, within one 0.1% bin), the **executable bid net** of the DLMM fee,
the **DAMM v2 price**, the **DAMM v2 sell net** of its 1% fee, and **redemption** (F less 0.5%).

Details: [`docs/mechanism.md`](docs/mechanism.md) · [`docs/math.md`](docs/math.md) ·
[`docs/meteora.md`](docs/meteora.md) · [`docs/architecture.md`](docs/architecture.md).

## Two tiers, one mechanism (D-008)

- **Ballast Full** — this program: the vault, the DLMM bid, redemption.
- **Ballast Lite** — the same DBC curve with 100% permanently locked LP and no program. Its floor is
  the locked-liquidity floor (V = 0); `ballast verify` and `ballast scan` measure it. Config scripts:
  [`scripts/lite/`](scripts/lite/).

## Verify it yourself

```bash
cargo build --release -p ballast-verifier
./target/release/ballast verify <launch-address> --rpc <url>          # recompute F from raw accounts
./target/release/ballast verify <launch> --rpc <url> --sellout <sig>…  # lowest execution vs F
./target/release/ballast scan --rpc <url>                              # locked-liquidity floor of DBC → DAMM v2 launches
```

The verifier fetches the launch, the DBC config, the DAMM v2 pool and positions, the vault, the DLMM
order and the mint, recomputes the prediction and F with the same floor crate the program uses, and
rebuilds the floor's history and the §10 ledger from the program's events, and exits non-zero on any
mismatch. See [`docs/verifier.md`](docs/verifier.md).

### Token page

```bash
anchor build && cargo build -p floor-wasm --target wasm32-unknown-unknown --release
pnpm -F app build && pnpm -F app exec vite preview      # open /?launch=<launch>&rpc=<url>
```

One page per launch (§21): market price, F and price ÷ F, the maximum loss if you buy now, how much
of the supply the locked pool and the vault bid each absorb at F, the bid wall, redemption with an
exact quote, and the proof transactions. F is shown only when the program's `floor()` view and the
floor crate (compiled to WebAssembly) agree on the same live accounts. `pnpm -F app test` checks the
page's numbers against `ballast verify` and a real DLMM sell quote; `pnpm -F app test:redeem` lands the
Redeem button's transaction and checks the payout against the page's quote; `pnpm -F app smoke` loads
the built page in Chrome and checks that it renders ([`evidence/app/`](evidence/app/)).

### Reproduce the whole proof on Meteora's mainnet binaries

```bash
source ~/.ballast-env
pnpm fixtures:check                      # the dumped Meteora programs still match mainnet (hashes)
pnpm localnet --quiet &                  # local validator running the mainnet DBC, DAMM v2, DLMM binaries
bash tests/integration/p0/up.sh          # fund the payer
anchor build && pnpm proof:local         # §22: launch → buys → graduation → open → full sell-out → verify
```

`pnpm proof:local` writes [`evidence/proof-local/summary.md`](evidence/proof-local/summary.md); the run is
walked through in [`docs/proof.md`](docs/proof.md).

## Evidence

| What | Result | Where |
|---|---|---|
| Meteora behaviour (P0): permanent lock, pool mode, L ↔ reserves, PDA fee claims, PDA DLMM orders | all five verified on the mainnet binaries | [`DECISIONS.md`](DECISIONS.md) Top 20, [`evidence/p0/`](evidence/p0/) |
| One floor implementation, exact integers | Rust = WASM = Python on 10,014 cases | [`crates/floor/vectors.json`](crates/floor/vectors.json), [`evidence/floor/`](evidence/floor/) |
| F never falls (model fuzz) | 1M and 10M steps, 0 failures | [`evidence/fuzz/`](evidence/fuzz/) |
| Program test suites, fresh ledger, mainnet binaries | Part 1 94 pass · Part 2 46 · audit fixes 22 · keeper 5 · 0 fail | [`evidence/program/`](evidence/program/) |
| Audits (spec + security) | 0 critical, 0 high; the vault's only exits are its own bid and a redeemer | [`DECISIONS.md`](DECISIONS.md) § Part 2 re-audit |
| Compute units | `open` 145k · `refresh_floor` 188k · atomic `redeem` 209k | same |
| Full §22 Proof launch on the mainnet binaries (`pnpm proof:local`) | prediction 6.7019e-09 SOL/token; realised at open 6.7919e-09 (+1.34%); full sell-out of every team token: 72 sells (37 to the bid, 35 to DAMM v2), lowest execution 1.0173·F; F after the sell-out 6.8394e-09 (not lower); vault left 0.0458 SOL; the §10 ledger closes to the lamport (gate 4); gate 9 (200 random transactions) and gate 10 PASS; verifier PASS | [`evidence/proof-local/summary.md`](evidence/proof-local/summary.md) |
| Why it matters: `ballast scan` over the 100 newest DBC → DAMM v2 migrations on mainnet (8 Oct) | 94 had no permanently locked liquidity; 2 held a locked-liquidity floor above half the pool price | [`evidence/scanner/scan-100-2026-10-08.json`](evidence/scanner/scan-100-2026-10-08.json) |

## Addresses

| | Address |
|---|---|
| Ballast program (local validator and devnet) | `HSSv351Q1DftJ7mgEzKm9rt41WUTyWZJZLXUq7sfqerr` |
| DBC | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
| DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |

**Mainnet: not deployed.** The project spends nothing on mainnet without the owner approving each
transaction, and the Full tier deploys only if funded (D-007).

**Devnet: the program is deployed and initialised; no launch exists there.** Devnet runs a newer
DBC build than mainnet, and the config it writes carries version 1 where mainnet's carries 0. The
program checks that version first (§7 rule 1) and refused to create a class from it:
`ConfigWrongVersion`, transaction `2kPEwtNj…rRJVNB`. The proof therefore ran only on the mainnet
binaries. Signatures: [`evidence/proof-devnet/deploy.json`](evidence/proof-devnet/deploy.json).

## Limits

- The DLMM leg depends on Meteora's pair: if an operator disables it, bids and redemption pause; the
  locked pool still works.
- Anyone can move the DLMM active bin and hold it with a dust order. Within 70 bins under F's bin the
  bid is capped there (still at or below F); further down the bid is suspended and the vault rests
  unplaced. Redemption still pays F less 0.5% either way (D-020, D-021).
- A wallet whose whole balance redeems for less than 0.001 SOL cannot redeem (§10's minimum).
- A class can only be created from a DBC config of the version the program was validated against.
  When Meteora ships a new config version to mainnet (devnet already has one), new classes need a
  program upgrade first; existing classes and launches are not affected.
- The program is upgradeable by its authority; a malicious upgrade is the one path to the vault.

Everything else, with evidence: [`docs/limitations.md`](docs/limitations.md) ·
[`docs/security.md`](docs/security.md) · [`docs/operations.md`](docs/operations.md).

## Challenge: make F go down

Show on-chain evidence, on a named Full launch, of any of the following (§24 of the
[build spec](docs/spec/BUILD_SPEC.md) has the exact rules):

1. two slots t₁ < t₂ where the `floor()` value s fell, as evaluated by `ballast verify --at-slot`;
2. a transfer out of a vault other than into the launch's own limit order or to a redeemer burning
   tokens in the same instruction;
3. a decrease in the permanently locked liquidity of a recorded position;
4. a state with vault > 0 in which redeeming T tokens pays less than ⌊T·F·(1 − 0.5%)⌋.

## Build and test

```bash
cargo fmt --all --check && cargo clippy --all-targets -- -D warnings
cargo test --workspace                                   # floor crate, layouts, verifier, fuzzer
python3 tests/reference/floor.py                         # independent integer reference
pnpm test:fuzz                                           # §14 model fuzz, 1M steps
anchor build && pnpm exec tsx tests/integration/program/run.ts   # program suites on mainnet binaries
```

Toolchain: Agave 2.1.21, Anchor 0.31.1, Rust 1.85 (host) / platform-tools v1.43 (SBF), Node 20,
pnpm 9 — pinned and justified in [`DECISIONS.md`](DECISIONS.md) § Toolchain.

For judges: [`JUDGES.md`](JUDGES.md). Specification: [`docs/spec/BUILD_SPEC.md`](docs/spec/BUILD_SPEC.md).
Progress: [`STATUS.md`](STATUS.md). License: [Apache-2.0](LICENSE).
