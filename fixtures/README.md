# fixtures/

Meteora programs and accounts dumped from mainnet, so integration tests run against the **real**
Meteora code rather than mocks (§14: "Never mock Meteora in integration tests"; §17).

Everything in here is gitignored except this file — the artefacts are large and reproducible. Their
**sha256 hashes are committed**, in `evidence/fixtures/`, so a test run is reproducible and a
silently changed fixture is detectable.

## What `pnpm fixtures:dump` collects (§17)

Programs, via `solana program dump -u m`:

| Program | Why |
|---|---|
| Dynamic Bonding Curve (DBC) | the curve, graduation, migration fee, leftover |
| DAMM v2 (cp-amm) | the migrated pool and the two permanently locked positions |
| DLMM | the LimitOrder pair holding the vault's bid |
| Metaplex Token Metadata | DBC creates token metadata during pool creation |
| Jupiter locker | DBC migration may reference it |

Accounts, via `solana account -u m --output json`:

| Account | Why |
|---|---|
| DBC → DAMM v2 migration config key | required by `migration_damm_v2` |
| DLMM preset parameters | bin step / base fee presets for pair creation (Q9) |

`Anchor.toml` loads these with `[[test.genesis]]` (programs) and `[[test.validator.account]]`
(accounts). Pure-logic tests that need no Meteora use LiteSVM instead, for speed.

## Status

Not yet dumped — this is STEP 1C, and it is blocked on the Solana CLI pin (the installed 1.18.26 is
not the Agave 2.1.x §16 asks for). See `DECISIONS.md` § Toolchain.

**Note for this host:** `solana-test-validator` with `[[test.genesis]]` is unproven on Windows. The
route for the integration layer is still open — see `DECISIONS.md` § Environment.
