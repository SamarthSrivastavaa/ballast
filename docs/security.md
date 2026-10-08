# Security

The §12 threat model, each prevention mapped to the code that enforces it and the test that shows it
holding. Integration tests run on Meteora's mainnet binaries (D-001); every negative test changes
exactly one account or argument and must fail with the error the owning check reports.

## Contract attacks

| Attack (§12) | Prevention in code | Test |
|---|---|---|
| PDA misuse — a caller directs a PDA signature | `partner_auth` / `creator_auth` sign only fixed CPIs; destinations are derived (vault, staging ATAs) or validated (beneficiary ATA: address, mint, owner) | `part3`, `part4`, `part5` substitution cases |
| Account substitution — pool, position, pair, order, vault, staging | §5 rules 1–4 in every instruction: owner, discriminator, derived or recorded address, cross-links (`read_pool`, `read_position`, `read_pair` incl. bin step, `check_bid_order`, `is_bin_array`, `staging_balance`) | one negative test per account: `evidence/program/part1/*.json`, `part2/results.json` |
| Fake position to inflate L | position re-derived from its NFT mint (`["position", nft_mint]` under DAMM v2), `pool` cross-checked, NFT holder checked at `open`; afterwards only the recorded keys are accepted | "partner position from another launch's pool", "positions swapped", "position owned by another program" |
| Fake DLMM pair or order | pair recorded at registration; the resting order must be the recorded key, DLMM-owned, a `LimitOrder` owned by `partner_auth` on that pair | "DLMM pair of another launch", "a limit order owned by someone else" |
| Malicious CPI program | every Meteora program ID is a constant, checked by `address =` constraints | "fake DBC program" |
| Signer confusion on burns | the holder signs the burn of their own token account; mint and authority checked (D-012: missing = error) | "holder WSOL account missing" |
| Replay / double settlement | state machine (`LaunchWrongState`), DBC's withdraw bitmask, balance deltas | "second call refused", "the same redemption twice in one transaction" |
| Double redemption | burn and pay in one instruction; a duplicate names a closed order | "the same redemption twice in one transaction" |
| Overflow / precision | U256 inside the floor crate, bounds before arithmetic, checked ops elsewhere, `overflow-checks = true` in release | property gate, model fuzzer |
| Rounding extraction | rounding toward the protocol; 0.001 SOL minimum payout | "payout below 0.001 SOL"; fuzz conservation |
| Freeze / mint authority | DBC base mint with both `None` (Q11), checked by the verifier | verifier "Supply" |
| Vault exits | exactly two: the owned DLMM bid and a redeemer (§10, D-022) | "harvest never transfers out of the vault" (`part2/audit.json`) |

## Griefing the DLMM leg (D-020, D-021)

Anyone can move a pair's active bin while no liquidity lies in between, and hold it there with a dust
order. Without D-021, a pin at the pair's lowest bin would have capped the whole vault ≈ 23,000 bins
under F (reproduced against the D-020 build: `evidence/program/part2/audit-repro-d020.json`). Now:

- a pin within 70 bins under F caps the bid there (still at or below F); deeper, the DLMM leg is
  suspended and the vault rests unplaced; V still counts it and redemption stays live;
- `redeem` never moves the active bin and never fails on pair state (prices DLMM cannot represent are
  compared by sign); `open` cannot be stranded;
- while capped or suspended, a refresh that lifts the bid to F's bin skips the rate limit, so a griefer
  cannot spend the window on caps; other refreshes wait 10 slots.

A dust bid placed in the launch transaction does not stop such a pin
(`evidence/program/part2/d021-dust-experiment.json`).

## Creator-controlled accounts (D-022)

A creator can reassign the owner of, or close, their own beneficiary WSOL account at will. Creator
income therefore moved to `pay_creator`; `settle_graduation`, `harvest`, `open`, `refresh_floor` and
`redeem` take no creator-controlled account. With the beneficiary account bricked, the whole lifecycle
still runs and only `pay_creator` fails, the fees staying claimable (`part2/audit.json`, launch F).

## The 7 Oct audit

1 critical, 6 high and 8 medium findings, all fixed and re-tested; each reproducible finding has a
case that fails on the D-020 build and passes on the fix (`DECISIONS.md` § Part 2 audit —
implementation; `tests/integration/program/src/part5.ts`).

## Residual trust

The upgrade authority (a multisig per §19, disclosed); Meteora's own programs and admin powers (Q19);
and bugs no test or audit found. See `limitations.md`.
