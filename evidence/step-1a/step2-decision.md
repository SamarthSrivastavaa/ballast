# STEP 2 — Toolchain decision (2 Oct 2026)

**Outcome: both tests PASS → the §16 pins stay.** Agave / Solana CLI **2.1.21**, Anchor **0.31.1**,
platform-tools **v1.43** (rustc/cargo 1.79.0, bundled with Agave 2.1.21), host rustc **1.85.0**
(D-002). No toolchain move, so the "oldest working combination" search and the meteora-types
offset re-run that the rule would have required are not triggered.

The fix for the edition-2024 blocker is the **lockfile**, not the toolchain: MSRV-aware resolution
plus three `--precise` pins, guarded by `scripts/toolchain/check_lock.py`.

Environment: WSL Ubuntu 26.04.1, `/home/hp/ballast` (ext4), after `source ~/.ballast-env`.

---

## TEST 1 — the mainnet Meteora binaries execute on `solana-test-validator` 2.1.21

### Fixtures (`pnpm fixtures:dump` → `evidence/fixtures/mainnet-pins.json`)

Program IDs come from Meteora's SDK constants (DBC SDK 1.5.13, cp-amm SDK 1.4.8, dlmm SDK 1.9.10),
recorded per program in `scripts/fixtures/manifest.json`. Each pin comes from **one**
`getAccountInfo` of the program's ProgramData account, so the ELF, deploy slot and authority are
read together at one slot. Reads at `2026-10-02T08:19:22Z`, slots 452,554,169–188. The pins file was
rewritten at 08:51:40Z, when hardening added `genesisHash`; every pinned value was unchanged, so
`dumpedAt` records the last write of the file, not the reads.

| Program | ID | Last deployed (slot) | Upgrade authority | ELF bytes | sha256 |
|---|---|---|---|---|---|
| DBC | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | 445,503,633 | `JADaUV8k…CVLd` | 2,326,577 | `4c26a8a5…a9f23b` |
| DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | 445,230,614 | `JADaUV8k…CVLd` | 2,174,352 | `4d5b920b…e6848b` |
| DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | 423,977,638 | `JADaUV8k…CVLd` | 2,229,776 | `d296c677…844c1f` |
| Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | 380,725,176 | none (immutable) | 793,991 | `31f0a627…5e9011` |
| Jupiter locker | `LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn` | 368,684,289 | `CvQZZ23q…tipQ` | 664,736 | `e0ace82e…42ab92` |

Full hashes, ProgramData addresses and solana-verify-style executable hashes (trailing zeros
stripped) are in `mainnet-pins.json`.

Cross-checks:

- **`solana program dump -u m`** (the §17 command) produces byte-identical files for all five:
  `evidence/fixtures/cli-dump-crosscheck.txt`.
- **`pnpm fixtures:check`** passes online (live mainnet = pins) and `--offline` (local files = pins).
- **Tamper control:** flipping one byte of `fixtures/programs/dlmm.so` makes `fixtures:check` fail
  with exit 1; restoring the byte makes it pass.
- All five ELFs are **SBPF v0** (`e_flags = 0`), the legacy format Agave 2.1.21 loads.

### Validator

`pnpm localnet` runs `fixtures:check` first, **online** by default (`LOCALNET_OFFLINE=1` = local
integrity only, with a warning), and refuses to boot on a mismatch. It then
starts `solana-test-validator` 2.1.21 (feature set 1416569292) with each program at its real ID,
loaded via `--upgradeable-program` with its **mainnet** upgrade authority.

### Execution probes (`pnpm fixtures:exec` → `evidence/step-1a/exec/`)

Before any probe, the harness refuses a non-loopback or mainnet-genesis RPC. It then **measures**
the bytes and upgrade authority the validator serves at each ID; they must equal the pins, and
`summary.json` records `loadedSha256` next to `pinnedSha256`. Every probe is a landed transaction
with a signature and full logs. **27/27 PASS; every program executes.** The figures below are from
the final post-audit run. CU for the success probes varies by a few thousand between runs, because each
run uses fresh keypairs and so a different PDA bump search.

| Program | Probes | What ran |
|---|---|---|
| DBC | 11/11 | **`create_partner_metadata` succeeded**: PDA init via system CPI plus an Anchor self-CPI event signed by the event-authority PDA, 14,860 CU. Sig `4Tz5Fj9i6P8bnVSYYJ1mzzXzBrmLjJBZMvmtZGYPYqnYzyeUcU6cM8ykDskrBdQauY8ZWTLKJrkuAFZQuz94Z6XV`. 9 dispatch probes, all present. 1 control → absent |
| Token Metadata | 1/1 | **`CreateMetadataAccountV3` succeeded** on a fresh SPL mint, 39,423 CU. Sig `3tLDU7JrcsioezAG8nNLcjfirNZR792LXU2mc68R8g2CpPfNV17QbMSQ9kRXf3gsH4rMi3xnHKqEdTsG4u6KfVZo` |
| DAMM v2 | 6/6 | 5 dispatch probes, all present (`initialize_customizable_pool`, `claim_position_fee`, `split_position`, `permanent_lock_position`, `swap`). 1 control → absent |
| DLMM | 6/6 | 5 dispatch probes, all present (**`place_limit_order`, `cancel_limit_order`, `close_limit_order_if_empty`**, `initialize_customizable_permissionless_lb_pair2`, `swap2`). 1 control → absent |
| Jupiter locker | 3/3 | `create_vesting_escrow` and `claim` present. 1 control → absent |

How a dispatch probe reads: the program is called with a real Anchor discriminator and no
accounts. Its own dispatcher logs `Instruction: <Name>`, then fails with **102**
(InstructionDidNotDeserialize: Anchor decodes args first) or **3005** (AccountNotEnoughKeys). A
discriminator that matches no handler fails with **101**, which is what each negative control
(`ballast_no_such_instruction`) returned. So "present" is a falsifiable signal. It is a **LEAD**
that the deployed binary has the instruction, not a verification of its behaviour.

The local-validator signatures are reproducible, not durable: the ledger resets on each
`pnpm localnet`. The durable record is the logs in `exec/*.json`.

### Findings from TEST 1

1. **T4 — DAMM v2 `swap` has a pre-Anchor fast path.** It returned `Custom(3005)` in **45 CU** with no
   log, against ~1,900 CU for every Anchor-dispatched instruction. The first classifier required a
   log line and wrongly failed it. The rule now also accepts a `Custom(n)` return, which only
   program code can produce (a load failure surfaces as a runtime error). Relevant to Q18 CU
   budgeting and to the sell path.
2. **The deployed DLMM binary contains the limit-order instructions** Q5 depends on. Lead only:
   whether a PDA can place and cancel one via CPI is STEP 3.
3. DBC `transfer_pool_creator` and `migration_damm_v2` are present: the §1 correction-3 path and
   the migration path exist in the deployed binary. Leads for Q1 and Q7.

4. **T7 —** the DLMM SDK's `LBCLMM_PROGRAM_IDS.localhost` is `LbVRzDTv…UhFQ`, a different
   program. On this validator, always pass the mainnet DLMM ID explicitly.
5. **T8 —** `solana-test-validator` cannot write a `None` upgrade authority.
   `--upgradeable-program … none` becomes `Some(11111111111111111111111111111111)`, observed for
   Token Metadata. It is still non-upgradeable, since nobody can sign for the all-zero key, but it
   is not byte-identical to mainnet's ProgramData header. `fixtures:exec` accepts exactly that one
   encoding of a pinned `none`.

### What TEST 1 does not prove (residual fidelity risk)

- **T6 — Feature set:** the validator activates every feature Agave 2.1.21 knows. Mainnet runs a newer
  Agave with features 2.1.21 has never heard of. Program semantics are unaffected unless a program
  depends on them, but **compute-unit costs can differ**. Q18 CU numbers measured locally must be
  cross-checked by `simulateTransaction` against mainnet (read-only) or on devnet before they are
  trusted near a limit.
- Only two instructions ran to completion. Deep paths (curve swap, migration, DLMM orders) are
  STEP 3.

---

## TEST 2 — lockfile pins → `anchor build` / `anchor test` / `cargo build-sbf`

### Method (`tests/toolchain-probe/`)

1. `programs/probe/Cargo.toml`: `rust-version = "1.79"`, the platform-tools rustc (Finding T1).
2. `tests/toolchain-probe/.cargo/config.toml`: `[resolver] incompatible-rust-versions = "fallback"`
   (MSRV-aware resolution). This is a cargo *config* key, so platform-tools cargo 1.79 ignores it
   with an "unused config key" warning. `resolver = "3"` in `Cargo.toml` would do the same, but
   cargo 1.79 rejects it at parse time.
3. `Cargo.lock` regenerated by host cargo 1.85. **T2 —** the resolver alone broke the chain the previous
   session judged unpinnable: `proc-macro-crate 3.4.0 → toml_edit 0.23.10 → toml_datetime 0.7.5`,
   instead of the edition-2024 `toml_datetime 1.1.1`.
4. Three `cargo update --precise` pins for what MSRV resolution cannot see:
   - `solana-program 2.1.21`: the §16 Agave line.
   - `blake3 1.5.5`: 1.8.7 is edition 2024 but declares no `rust-version`, so the MSRV resolver
     treated it as compatible. It pulled in 8 edition-2024 crates (`digest 0.11`,
     `block-buffer 0.12`, …).
   - **T3 —** every `anchor-*` crate to `0.31.1`: `anchor-lang =0.31.1` uses caret requirements internally,
     which had drifted 10 sub-crates (`anchor-syn`, `anchor-attribute-*`, `anchor-derive-*`) to 0.31.2.
5. **Guard:** `scripts/toolchain/check_lock.py` fails on any edition-2024 package, any MSRV > 1.79,
   or `anchor-*`/`solana-program` off the pin. New lock: **185 packages, 0 problems**
   (`test2/lock-guard.txt`). Pre-STEP-2 lock: **30 problems**, so the guard tells them apart.

### Results

| Leg | Result | Evidence |
|---|---|---|
| `anchor build` (clean) | exit 0; `probe.so` **218,568 B**; IDL generated | `test2/anchor-build.log` |
| `anchor test --skip-build` | 1 passing; on-chain `s = 75507360421341854`, payout `16671021` lamports (§27 Public vector), **19,572 CU**; sig `2SqDBb5VTzntZGm72qobEaKZbctMAK3NHqzbezr7Dn5u396WZsJuiX3wcvhVJRY7CwU38A6kKLsNQvLLKrfNSy59` | `test2/anchor-test.log` |
| `anchor test` (with build) | 1 passing; sig `2SiC9m7NmFGUfaZbBy2x5NvLat7tL3LfXhGrJKLNgvWKrruFZ7hFCxD4Lm8NVkHXAcJLauHJANVKE4Yb1LnRG6MH` | `test2/anchor-test-full.log` |
| `cargo build-sbf` on `floor-sbf` (links only `crates/floor` + `ruint`) | exit 0; **46,784 B**, identical to the D-002 result | `test2/floor-sbf-build.log` |
| Compiler | `solana-cargo-build-sbf 2.1.21`, platform-tools **v1.43**, rustc **1.79.0**, cargo **1.79.0** | `cargo build-sbf --version` |
| Floor regression | 31 tests, 100k property gate (14.8 s), fmt, clippy `-D warnings`, `vectors.json` reproducible | — |

### T5 — Program-size measurement (D-007)

The probe (Anchor 0.31.1 plus `crates/floor`, one instruction) at each `opt-level`:
`3` → 218,568 B, `s` → 216,864 B, `z` → **211,312 B**. `opt-level = "z"` saves about 3%. **The
Anchor baseline is already ~210 KB of the 300 KB target**, before any Ballast instruction or CPI
builder. Flagged as a risk; no decision taken here.

---

## Hardening after `/audit` (2 Oct 2026)

**First audit:** 0 critical, 1 high, 10 medium, 1 wording, all in the tooling and docs. The HIGH:
TEST 1 could not prove which bytes it ran, because it only checked `executable` and copied the hash
from the pins.

**Re-audit of the fixes:** all 12 were confirmed fixed. It raised 9 new mediums, all also fixed:

- Two were code gaps. `exec.ts` measured bytes at the manifest ID but probed at the pinned ID.
  `rpc()` returned `undefined` for a reply with neither `result` nor `error`, which slipped past
  exec's "genesis is not mainnet" comparison.
- Seven were evidence and doc accuracy issues.

Every guard now has a negative test in the committed, rerunnable **`scripts/fixtures/negative-tests.sh`**.
It restores everything it tampers with on exit. Output: `hardening.txt`, **14/14 refused**.

| Guard | Negative test (`hardening.txt`) | Result |
|---|---|---|
| `fixtures:dump` refuses drift and writes nothing | (a) pin `lastDeploySlot` edited | refused; pins + `.so` untouched |
| `fixtures:dump` / `check` assert the mainnet genesis | (b) `MAINNET_RPC_URL` = devnet | refused |
| `fixtures:check`: manifest ID = SDK constant | (c) DLMM ID → the SDK's `localhost` ID | refused |
| `fixtures:check`: account pubkey/owner/lamports/executable/data | (d) account pinned via dump, then owner edited | refused (first run of the account path) |
| `pnpm localnet` flag allow-list | (e) `--bpf-program`, `--clone`, `--rpc-port=8899` | refused before check or boot |
| `fixtures:exec` loopback-only (it signs) | (f) `LOCALNET_RPC_URL` = devnet | refused |
| `fixtures:exec` refuses a mainnet genesis | (f2) fake loopback RPC answering mainnet's genesis | refused |
| `rpc()` fails closed on a reply without `result` | (f3) fake loopback RPC answering `{"message": …}` | refused |
| `fixtures:exec`: served bytes = pin | (g) jup_locker pin sha256 edited (both hashes printed) | refused |
| `fixtures:exec`: served authority = pin | (g2) dbc pin authority edited (both authorities printed) | refused |
| `fixtures:exec`: pinned ID = manifest ID | (h) dlmm pin id → DBC id | refused |

`pnpm localnet` checks **online** by default. The final runs booted that way, and offline needs
`LOCALNET_OFFLINE=1`.

Also changed:

- Re-dumping with no drift leaves `mainnet-pins.json` byte-identical (verified).
- The pins carry `genesisHash`. All five hashes are identical to the first dump.
- Evidence logs are no longer gitignored (`!evidence/**/*.log`).
- Evidence records the RPC host only.
- The CI wording gate matches `can('|’)?t lose` in both C and UTF-8 locales.
- `DECISIONS.md` gains the Q10 carve-out and non-circular program-ID evidence.
- `CLAUDE.md` reads `L ≤ 2^120`.

---

## Reproduce

```bash
source ~/.ballast-env && cd ~/ballast
pnpm install
pnpm fixtures:dump && pnpm fixtures:check    # TEST 1 fixtures + drift check
pnpm localnet --quiet &                       # mainnet-binary validator
pnpm fixtures:exec                            # TEST 1 probes → evidence/step-1a/exec/
bash scripts/fixtures/negative-tests.sh       # every guard fails closed → hardening.txt
kill %1
python3 scripts/toolchain/check_lock.py tests/toolchain-probe tests/toolchain-probe/floor-sbf
cd tests/toolchain-probe && anchor build && anchor test
cd floor-sbf && cargo build-sbf
```
