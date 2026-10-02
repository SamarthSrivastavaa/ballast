# STEP 1A — environment move and toolchain pins

**Verdict: PARTIAL.** Requirement (a) is satisfied for `crates/floor`; requirements (a, second
half), (b) and (c) are **blocked** by a platform-tools limitation that needs a decision.
Ran 2 Oct 2026 from commit `02cd402`.

## Environment (answers to question 1)

Everything before this step ran in **MINGW64 / Git Bash on Windows** — `MINGW64_NT-10.0-26200
LAPTOP-CVPULMTB ... Msys` — with the repo at `C:\Users\HP\OneDrive\Desktop\meteora` (NTFS, inside
OneDrive) and Windows-native tools (`solana` 1.18.26, `anchor` 0.32.1, Node 24.15.0).

**Correction to the premise of the question:** there were **no Meteora local-validator runs**. No
validator was ever started, `anchor build` and `anchor test` were never run, and no Meteora `.so`
file was ever fetched. The "10/10" was the Python reference reproducing the ten §27 **numerical
vectors** — pure integer arithmetic, no network, no Meteora programs. The integration layer was and
remains unproven.

| | |
|---|---|
| `wsl -l -v` | `docker-desktop` (Stopped, v2) · `Ubuntu` (Stopped, v2) · WSL 2.5.9.0, kernel 6.6.87.2-1 |
| `uname -a` (Ubuntu) | `Linux LAPTOP-CVPULMTB 6.6.87.2-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC Thu Jun 5 18:30:46 UTC 2025 x86_64 GNU/Linux` |
| Distro | Ubuntu 26.04.1 LTS, user `hp`, 16 CPUs, 7.6 GiB RAM, 947 G free on `/dev/sdd` |
| Repo path | **`/home/hp/ballast`** (was `C:\Users\HP\OneDrive\Desktop\meteora`) |
| `sudo` | **requires a password** — no apt installs were possible; everything went into `$HOME` |

## D-005: the move

`git clone` from the Windows path, so history is preserved.

```
path:    /home/hp/ballast        filesystem: /dev/sdd  /   (ext4)
branch:  main
head:    02cd402  commit count: 3
status:  clean
CRLF:    0 CR bytes in crates/floor/src/lib.rs (.gitattributes honoured)
```

`cargo test -p ballast-floor` green immediately after the move. The Windows copy is left in place as
a stale archive; deleting it is the owner's call.

One hazard the move introduces: `/mnt/c/Program Files/nodejs` leaks Windows `node`/`npm`/`pnpm` onto
the WSL `PATH`. `~/.ballast-env` strips every `/mnt/*` entry and must be sourced before any build.

## Toolchain pins — all §16 pins now satisfied

| Tool | §16 pin | Installed | Verdict |
|---|---|---|---|
| Rust (host) | 1.84 → **1.85.0** (D-002) | `rustc 1.85.0 (4d91de4e4 2025-02-17)` | PASS |
| Cargo (host) | — | `cargo 1.85.0 (d73d2caf9 2024-12-31)` | PASS |
| Agave / Solana CLI | 2.1.x | `solana-cli 2.1.21 (src:8a085eeb; client:Agave)` | PASS |
| Anchor CLI | 0.31.1 | `anchor-cli 0.31.1` | PASS |
| avm | — | `avm 0.31.1` | PASS |
| Node | 20 LTS | `v20.20.2` (via nvm) | PASS |
| pnpm | 9 | `9.15.4` (via corepack) | PASS |
| wasm-pack | required | `0.13.1` | PASS |
| Python (reference) | — | `3.14.4` | PASS |
| **platform-tools** | — | **v1.43, rustc 1.79.0** (bundled with Agave 2.1.21) | see blocker |

Two installs needed a different route than planned: `wasm-pack` from source now requires rustc
1.86/1.88 (`icu_*`, `sysinfo`, `time`), so the official **prebuilt** installer was used instead;
and Agave 2.1.x releases are far back in history (latest is v4.3.0), with v2.1.21 the newest 2.1
line whose install script still responds.

## (a) `cargo build-sbf` — D-002 condition 3: **SATISFIED** for `crates/floor`

The first attempt failed with a message that pointed at our own manifest, not at a dependency:

```
error: rustc 1.79.0-dev is not supported by the following package:
  ballast-floor@0.1.0 requires rustc 1.85
```

**Finding (T1): the host toolchain pin and a crate's MSRV are different things, and I had
conflated them.** `rust-version = "1.85"` was inherited from `[workspace.package]`, but
`crates/floor` is compiled *for SBF by platform-tools rustc 1.79.0*, so its MSRV must be low enough
for that compiler. `crates/floor` now declares its own `rust-version = "1.79"`, decoupled from
`rust-toolchain.toml`. The same will apply to `programs/ballast`.

With that corrected, built in isolation — a tree containing **only** `ballast-floor` and `ruint`,
so nothing else can be blamed (`tests/toolchain-probe/floor-sbf`):

```
platform-tools v1.43, rustc 1.79.0
  Compiling ruint-macro v1.2.1
  Compiling ruint v1.12.3
  Compiling ballast-floor v0.1.0
  Compiling floor-sbf-probe v0.1.0
   Finished `release` profile [optimized] target(s) in 5.05s
build-sbf exit: 0

target/deploy/floor_sbf_probe.so   46,784 bytes
file: ELF 64-bit LSB shared object, eBPF, version 1 (SYSV), dynamically linked, not stripped
```

4 packages in the tree: `ballast-floor`, `floor-sbf-probe`, `ruint 1.12.3`, `ruint-macro 1.2.1`.

**D-002 condition 4 was not triggered:** `ruint 1.12.3` declares `rust-version = "1.65"` and
compiled under platform-tools rustc without complaint. No `ruint` downgrade is needed.

Host tests remain green at the lowered MSRV: **31 passed** (12 unit + 3 D-002 + 3 D-004 + 11
property + 2 differential).

## D-002 conditions 1 and 2 — enforced by test, not by memory

`crates/floor/tests/d002_conditions.rs`, 3 tests, all passing:

- `d002_condition_1_crate_is_edition_2021` — asserts the crate is edition 2021 and that the
  workspace has not moved to edition 2024.
- `d002_condition_2_proptest_is_dev_only` — asserts `proptest` is absent from `[dependencies]` and
  from `[workspace.dependencies]`, and present in `[dev-dependencies]`.
- `crate_is_no_std` — asserts `#![no_std]` and that `ruint` keeps default features off.

## D-004 — the bound is in place and binds exactly

`crates/floor/tests/d004_ceiling_step.rs`, 3 tests, all passing:

- `ceiling_step_drop_is_bounded_by_one_base_unit` — at a ceiling step,
  `s(V, S, L+ΔL) ≥ s(V, S+1, L)`. Since `A = S + ⌈L/s_max⌉`, bumping `A` by one *is* bumping `S` by
  one, so this is the required "`s` computed with `A+1`" expressed through the public API.
- `ceiling_step_drop_is_never_a_whole_token` — the drop never exceeds 10⁶ base units.
- `bound_holds_with_equality_on_the_known_counterexample` — on `V = u64::MAX, S = 1, L = 0 → 1` the
  bound **binds with equality**, confirming the whole drop is the `+1` in `A` and nothing else.

`ceiling_step_can_lower_f` is kept, as required.

## Blocker — (a) second half, (b) and (c): the Anchor probe will not build for SBF

**Platform-tools v1.43 bundles cargo 1.79.0, which cannot parse `edition = "2024"` manifests. By
October 2026 the Anchor 0.31.1 + Solana 2.1.21 program tree resolves several of them.** This has
nothing to do with `crates/floor`.

Chain, from `cargo tree -i`:

```
probe
└── anchor-lang 0.31.1
    └── solana-program 2.1.21
        └── solana-borsh 2.1.21 -> borsh 1.8.1
            └── borsh-derive 1.8.1 (proc-macro)
                └── proc-macro-crate 3.5.0
                    └── toml_edit 0.25.15+spec-1.1.0
                        └── toml_datetime 1.1.1+spec-1.1.0   <-- edition 2024
```

What was tried:

| Attempt | Result |
|---|---|
| Pin `anchor-lang` exactly (`=0.31.1`) — the caret had let it drift to 0.31.2 | applied; necessary but not sufficient |
| Pin `solana-program` exactly (`=2.1.21`) — the caret had let it drift to **2.3.0**, off the §16 Agave 2.1.x line | applied; necessary but not sufficient |
| Pin `blake3` to 1.5.5 to drop `digest 0.11` → **cleared `block-buffer 0.12.1`** | **worked** |
| Pin `toml_datetime` down directly | impossible — `toml_edit 0.25.15` forbids every older version |
| Pin `proc-macro-crate` to 3.2.0 / 3.1.0 / 3.0.0 | `borsh-derive 1.8.1`'s requirement forbids them |
| Pin `borsh` to 1.5.x | requirement from `solana-borsh 2.1.21` forbids it |

The critical link is genuinely unpinnable. `cargo-build-sbf` does accept
`--tools-version <STRING>`, and newer platform-tools exist (v1.47 … v1.57, plus v1.51.1/v1.46.1/
v1.42.1 republished 2026-09-15); **v2.3.3 is already cached on this machine**. A probe of
`--tools-version` was run to make the recommendation evidence-based; its outcome is recorded in
`evidence/step-1a/tools-version-probe.md`.

**This needs a decision, because D-002 condition 4 says the toolchain is not to change again
without asking.** Options:

| | Option | Cost |
|---|---|---|
| A | `cargo build-sbf --tools-version <newer>` for the SBF build only | Agave CLI stays 2.1.21 and Anchor stays 0.31.1 exactly as §16 pins them; only the SBF compiler moves. Narrowest change. |
| B | Move Agave to a newer line (e.g. 2.3.x, tools already cached) | Changes the §16 Agave pin outright; pulls new `solana-program` into the program, which has knock-on effects for `meteora-types` offsets. |
| C | Keep pinning | Shown above to be a dead end at `borsh-derive` → `proc-macro-crate`. |

## Not started

STEP 1C (`fixtures:dump` / `fixtures:check`, mainnet pins, local validator with mainnet binaries)
has not begun: it needs a working `anchor test` to be meaningful, which is what the blocker denies.

## Reproduce

```bash
wsl -d Ubuntu
. ~/.ballast-env && cd ~/ballast
cargo test -p ballast-floor                     # 31 tests
cd tests/toolchain-probe/floor-sbf && cargo build-sbf   # D-002 condition 3
```
