# Reconcile against BUILD_SPEC.md — 7 Oct 2026, 19:19 UTC

Session check, STEP A. Every row was checked by running something or by reading the evidence file it
cites. STATUS.md was not used as a source. Where an approved decision replaces a spec item, the row
says which decision it was checked against.

## Context: the 7 Oct crash

At about 14:34 UTC on 7 Oct, `C:` reached 0 bytes free. The WSL vdisk could no longer grow, and
Ubuntu stopped booting (`E_FAIL`). Recovery steps:
- backed up the vdisk to `D:\ballast-recovery\` (25.5 GB);
- read the repo out of the backup and checked it with `git fsck`;
- moved the distro to `D:\WSL\Ubuntu` (`wsl --manage --move`);
- fixed the vdisk ACL so WSL could attach it.

On the first boot the ext4 journal replayed (`recovery complete`). `~/ballast` matches the recovered
copy byte for byte: `HEAD` is `1ee0bdc`, `git fsck` is clean, and all 16 modified files are identical.
Nothing was lost.

The crash happened in the middle of applying the Part 2 audit fixes:
- done: D-021/D-022 recorded, spec markers, CLAUDE.md principles, and edits to `state.rs`,
  `errors.rs`, `dlmm.rs`, `damm.rs` and `tests/discriminators.rs`;
- not started: the `floor_ix.rs` rewrite, `pay_creator`, and the new tests.

**The working tree does not compile.** The only error is `floor_ix.rs:403`, a call site that still
uses the old `dlmm::go_to_a_bin` signature. That is expected at this point, not a regression.

## Step 1 — build + suite on a fresh mainnet-binary ledger

| Check | Result | Source |
|---|---|---|
| `cargo test -p ballast-floor -p meteora-types` | **36 pass / 0 fail** (run now) | this session |
| `python tests/reference/floor.py` | **10 vectors, 0 failures** (run now) | this session |
| Program build, current tree | **does not compile** (half-applied audit fixes, above) | `cargo check -p ballast`, this session |
| Last green fresh-ledger run | 7 Oct 14:06–14:15 UTC, D-020 code: Part 1 **88 pass / 0 fail / 12 unreachable**, Part 2 **41 pass / 0 fail** | `evidence/program/part1/*.json`, `evidence/program/part2/results.json` |
| `.so` size | **531,800 B** (D-020 build, 7 Oct 13:56) | `target/deploy/ballast.so` |
| CU (local, D-020 build) | `open` 139k (tx 140k) · `refresh_floor` 163k–192k · `redeem` 197k (atomic) · `harvest` 136k · `deposit` 53k · `floor` 46k · `create_class` 30k · `register_launch` 59k · `settle_graduation` 116k · `burn_leftover` 82k | `evidence/program/part*/` |

The fresh-ledger run is repeated when the audit-fix item closes (STATUS.md, 8 Oct).

## Step 2 — deliverables

DONE = evidence exists · PARTIAL = some of it · DIVERGES = differs from the spec or a decision ·
NOT STARTED.

| Spec item | State | Evidence / gap |
|---|---|---|
| §4/§11 floor crate, Python reference, vectors | DONE | `d3e3fc9`; 36 tests; 100k property gate; 10,010 differential matches |
| §14 differential incl. **WASM** | PARTIAL | Rust = Python. No `floor-wasm` crate; the app is its only consumer |
| §15/§33 meteora-types, fixtures, CI | DONE | `cargo test -p meteora-types`; `evidence/fixtures/`; `.github/workflows/ci.yml` (rust, reference, wording, sbf-lock) |
| §7 compiler (two classes) | DONE | `compiler/`; hash-preimage test `b1c8b87` |
| §6 eleven instructions | PARTIAL | All 11 implemented and green at D-020 (`1ee0bdc` + working tree). D-022's 12th, `pay_creator`, is not written |
| Part 2 audit: D-021 extreme-bin pin | PARTIAL | Recorded, spec-marked; `state.rs` and `dlmm.rs` edits in; placement logic, bitmap extension and tests not in. 45-min dust-bid experiment not run |
| Part 2 audit: D-022 `pay_creator` | PARTIAL | Recorded, spec-marked; no code, no tests |
| Part 2 audit: 11 approved findings | PARTIAL | `damm.rs` identity-only read and the `BinArray` discriminator constant in; the rest are in `floor_ix.rs` and not done |
| §26 CU budgets / Q18 atomic redeem | DONE locally | Atomic redeem 197k CU ≪ 1.4M, so no two-step redeem. Top-20 VERIFIED needs a devnet signature |
| Program size (D-007 ≤ 300 KB, D-009 ≤ 400 KB, D-018 ≈ 500 KB) | **DIVERGES** | 531,800 B is over D-018's ceiling, and `pay_creator` adds more. Needs the owner's call |
| §14 model fuzzer, 1M steps | NOT STARTED | `tests/fuzz/` absent. Never cut (D-019) |
| §14 stateful integration (500 sequences) / gate 9 (200 random tx) | NOT STARTED | — |
| §14 required negative tests | PARTIAL | Most exist in the Part 1/2 suites. Fake order owner, fake pair `bin_step` and staging donation wait on the audit fixes. "LP withdrawal via DAMM v2 must fail at Meteora" not written |
| §18 gates 1–10 (D-001: local first, authoritative) | PARTIAL | Exercised locally, never recorded as gates: 1 (Part 1 config suite), 2 (migration fee exact 1.5 SOL), 3 and 5 (P0 Q1–Q3, Q5), 6 (`floor()` = Python; s_open ≥ predicted), 7 (exact payout, F rises). 4 partial (no §10 ledger reconcile). 8, 9, 10 not run. No gate tags |
| D-007 `pnpm proof:local` (§22 sequence) | NOT STARTED | Never cut |
| Devnet deploy + proof | NOT STARTED | Meteora IDs read 6 Oct; **binaries differ from mainnet**. Never cut |
| §20 verifier (`verifier-core` + CLI) | NOT STARTED | Never cut |
| §21 app: token page + launch form | NOT STARTED | D-019 cut the launch form (→ scripts). 7 Oct calendar: minimal token page only if time |
| Floor Scanner CLI (D-019) | NOT STARTED | D-019 never-cut list |
| D-008 Lite config + check (c) | NOT STARTED | — |
| §31 keeper (cranks only) | NOT STARTED as a package | Keeper logic exists inside the tests (D-013 bin arrays, D-020 cap fallback) |
| §29 README | PARTIAL | Stub; its status table is stale ("everything else not built") |
| D-006 `JUDGES.md`, `LICENSE` | NOT STARTED | `JUDGES.md` never cut |
| §29 mainnet items, multisig, §22/§23 launches | DIVERGES (D-007) | Replaced by `proof:local` + devnet unless funding arrives |
| Top-20 still open | — | Q7, Q17, Q19, Q20 UNKNOWN; Q10 mainnet-only; Q18 local only |
| §29 demo video | NOT STARTED | 11 Oct |
| Backup | **RISK** | `f83bac3` and `1ee0bdc` are not pushed; all work since 6 Oct exists only on this SSD (plus the `D:` backup) |
