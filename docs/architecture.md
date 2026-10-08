# Architecture

One Anchor program wraps a Meteora Dynamic Bonding Curve launch class with an executable buyback
floor F. All three Meteora programs carry part of it: **DBC** runs the launch and pays the 15%
migration fee into the vault; **DAMM v2** holds the 85% that migrates, as two permanently locked
positions owned by Ballast PDAs; **DLMM** holds the whole vault as one limit-order bid at the highest
bin at or below F. Spec: `BUILD_SPEC.md` §3, §5, §6, §15.

## Components

| Path | What | Tests |
|---|---|---|
| `programs/ballast/` | The program: 12 instructions, class validation, launch registry, vault, bid, redemption, fee routing | Rust unit tests; integration suites on Meteora's mainnet binaries (`tests/integration/program/`) |
| `crates/floor/` | `ballast-floor` — the only implementation of F (no_std, integer-only) | §27 vectors, 100k-case property gate, 10,014-case differential vs Python |
| `crates/floor-wasm/` | The floor crate for WebAssembly (no wasm-bindgen; u64 halves) | 10,014-case differential (`pnpm test:wasm`) |
| `crates/meteora-types/` | Vendored zero-copy Meteora layouts, proven field-for-field against real accounts | offset tests (Q12) |
| `crates/verifier-core/`, `verifier/` | `ballast verify` (§20) | `crates/verifier-core/tests/`, live runs in `proof:local` |
| `compiler/` | Emits the two classes' DBC `ConfigParameters` and their hash and predicted floor | `pnpm -F compiler test` |
| `sdk/typescript/` | Floor via WASM; launch views and instruction builders | used by the keeper and its suite |
| `keeper/` | Permissionless cranks only (§31) | `tests/integration/program/src/part6.ts` |
| `tests/fuzz/` | §14 stateful model fuzzer | 1M- and 10M-step runs (`evidence/fuzz/`) |
| `tests/reference/floor.py` | Independent integer reference for F and the prediction | `pnpm reference` |
| `scripts/proof/local.ts` | `pnpm proof:local` — the §22 Proof launch on mainnet binaries, plus gates 9–10 | `evidence/proof-local/` |

## Accounts (§5)

| Account | Seeds | Holds |
|---|---|---|
| `Global` | `["global"]` | admin (a multisig on mainnet), treasury WSOL account |
| `Class` | `["class", dbc_config]` | the validated DBC config, its hash, the predicted floor, bin step, fees |
| `Launch` | `["launch", base_mint]` | the public proof record: prediction, recorded pool/positions/pair/order, `s_last`, counters (burned, redeemed, harvested, deposited, filled, fill quote spent, creator forwarded, treasury fees) |
| `vault` | `["vault", launch]` | WSOL token account, authority `partner_auth`; never closed |
| `partner_auth` | `["partner", dbc_config]` | DBC fee claimer and leftover receiver; partner-position NFT holder; owner of the bid; staging ATAs (base, WSOL) |
| `creator_auth` | `["creator", launch]` | DBC pool creator after the launch transaction; creator-position NFT holder |

## Lifecycle and instructions (§5, §6)

```
register_launch ─▶ Registered ─settle_graduation▶ Funded ─(DBC migration)─ burn_leftover ▶ Cleaned ─open▶ Open
                                                                                                        │
                       refresh_floor · redeem · harvest · deposit · floor() · pay_creator ◀─────────────┘
```

| Instruction | Signer | Meteora CPIs |
|---|---|---|
| `initialize_global` | upgrade authority | — |
| `create_class` | admin | — (validates the DBC `PoolConfig` field by field, §7) |
| `register_launch` | creator, payer | — (verifies the atomic D-011 launch transaction by introspection) |
| `settle_graduation` | anyone | DBC `withdraw_migration_fee`, `claim_trading_fee` (partner) |
| `burn_leftover` | anyone | DBC `withdraw_leftover`, `partner_withdraw_surplus`; SPL burn |
| `open` | anyone + order keypair | DLMM `go_to_a_bin` (if needed), `place_limit_order` |
| `refresh_floor` | anyone + order keypair | DLMM `cancel_limit_order`, `close_limit_order_if_empty`, `go_to_a_bin`, `place_limit_order`; SPL burn |
| `redeem` | holder + order keypair | the same settlement, SPL transfer (payout) and burn (holder's tokens), re-placement |
| `harvest` | anyone | DAMM v2 `claim_position_fee` (partner position); SPL transfers from staging |
| `deposit` | depositor | SPL transfer into the vault |
| `pay_creator` | anyone | DBC `claim_creator_trading_fee`; once Open, DAMM v2 `claim_position_fee` (creator position) |
| `floor` (view) | — | — |

Every mutating instruction after `open` ends with the §4 monotone check. Every Meteora account is
checked for owner, discriminator, derived or recorded address and its cross-links (§5 rules 1–4);
CPI program IDs are hard-coded.

## The vault's two exits (§10)

The program has exactly two token transfers out of the vault: into the DLMM limit order it owns
(`place_limit_order`), and to a redeemer in the same instruction that burns their tokens at F. The
treasury's 10% of partner LP fees is paid from `partner_auth`'s WSOL staging account before anything
reaches the vault; creator income never touches it (D-022). Integration tests assert that no harvest
transaction contains a transfer out of the vault (`evidence/program/part2/audit.json`).

## Decisions that shape it

D-011 (one atomic launch transaction, prediction before any third-party trade) · D-012 (missing token
accounts are errors, never 0) · D-013 (bin arrays are the keeper's) · D-014 (bin step fixed per class) ·
D-016 (graduation routing) · D-017 (the prediction at the lower-F end of the migration-price band) ·
D-020/D-021 (the bid and the DLMM active bin) · D-022 (creator flows off the critical path). All in
`DECISIONS.md`, with evidence.
