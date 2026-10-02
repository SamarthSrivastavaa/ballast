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

## Status (2 Oct 2026)

**Programs dumped and pinned (D-001).** `scripts/fixtures/manifest.json` lists the five programs.
`pnpm fixtures:dump` writes `fixtures/programs/<name>.so` and
`evidence/fixtures/mainnet-pins.json`, recording sha256, last-deployed slot and upgrade authority.
`pnpm fixtures:check` re-verifies the local files and live mainnet. `pnpm localnet` boots
`solana-test-validator` 2.1.21 with them at their real IDs; `pnpm fixtures:exec` proves each one
executes (STEP 2 TEST 1: 27/27).

**Accounts: none yet.** The migration config key and DLMM presets in the table above are added to
the manifest only when a STEP 3 simulation shows a program reading them (D-001: found by
simulation, not guessed).

The local validator boots through `pnpm localnet`, not `[[test.genesis]]`. When `programs/ballast`
gets an `Anchor.toml`, its `[[test.genesis]]` entries must point at these same pinned files.
