# Probe: can `--tools-version` unblock the Anchor SBF build?

> **CLOSED 2 Oct 2026 — superseded by STEP 2 (`step2-decision.md`).** This route was not needed.
> The edition-2024 blocker was fixed in the **lockfile**, not the toolchain: MSRV-aware resolution
> (`rust-version = "1.79"`) plus `--precise` pins for `blake3`, `solana-program` and `anchor-*`.
> `anchor build` and `anchor test` pass under the bundled platform-tools v1.43. v1.52 and v1.53
> were never needed and were not probed. The analysis below is kept as history; its claim that
> the `toml_datetime` chain was "unpinnable" was wrong. MSRV-aware resolution moved
> `proc-macro-crate` to 3.4.0, which uses the edition-2021 `toml_edit 0.23` / `toml_datetime 0.7`.

**Probe only — nothing here was adopted.** No change was written into `Anchor.toml`, CI or any
committed config. The purpose was to make the platform-tools decision in `DECISIONS.md`
§ OPEN DECISION evidence-based rather than a guess.

Ran 2 Oct 2026, `~/ballast/tests/toolchain-probe`, Agave CLI 2.1.21.

## Result: option A is **not** a drop-in fix, and may be closed entirely

### platform-tools v1.54 — FAILED, but for a *different* reason

```
Compiling toml_datetime v1.1.1+spec-1.1.0      <-- the edition-2024 blocker COMPILED
Compiling zerocopy v0.8.59
error[E0463]: can't find crate for `core`
  = note: the `sbf-solana-solana` target may not be installed
build-sbf --tools-version v1.54 exit: 1
```

Two things to take from this:

1. **A newer platform-tools does solve the edition-2024 problem.** `toml_datetime 1.1.1` compiled
   without complaint, which is exactly what cargo 1.79.0 could not even parse.
2. **But Agave 2.1.21's `cargo-build-sbf` and platform-tools v1.54 disagree about the target
   triple.** 2.1.21 asks for `sbf-solana-solana`; v1.54 ships the renamed `sbpf-solana-solana`, so
   the old name has no `core` in its sysroot. The two halves cannot simply be mixed.

That creates a squeeze. The viable tools version would have to satisfy both:

- cargo ≥ 1.85, to parse edition-2024 manifests; **and**
- still provide the `sbf-solana-solana` target that Agave 2.1.21's `build-sbf` requests.

The target rename landed in the Agave 2.2 era, i.e. in roughly the same platform-tools generation
that moved to a newer cargo. If no version sits in that gap, **option A is closed** and the decision
is between:

- **B** — move Agave to a newer line (2.3.x; its platform-tools v2.3.3 is already cached on this
  machine), accepting a change to the §16 Agave pin and a newer `solana-program` in the program,
  with knock-on effects for `meteora-types` offset tests; or
- a variant of B: keep Agave 2.1.21 as the *CLI* for cluster operations, but build the program with
  a newer Anchor/Agave pair. That splits one pin into two and should only be done deliberately.

### platform-tools v1.51 — FAILED, cargo too old

```
error: failed to parse manifest at .../toml_datetime-1.1.1+spec-1.1.0/Cargo.toml
  feature `edition2024` is required
  ... not stabilized in this version of Cargo (1.84.0 (12fe57a9d 2025-04-07))
build-sbf --tools-version v1.51 exit: 1
```

v1.51 carries **cargo 1.84.0** — one minor short of what edition-2024 manifests need.

## The squeeze, stated precisely

A viable platform-tools version must satisfy **both**:

1. cargo ≥ 1.85, to parse the edition-2024 manifests in the Anchor/Solana tree; and
2. still provide the `sbf-solana-solana` target that Agave 2.1.21's `build-sbf` requests.

Measured so far:

| platform-tools | cargo | target name | Verdict |
|---|---|---|---|
| v1.43 (bundled with Agave 2.1.21) | 1.79.0 | `sbf-solana-solana` | fails (1) |
| v1.51 | **1.84.0** | — (never got that far) | fails (1) |
| v1.52 | ? | ? | probing |
| v1.53 | ? | ? | probing |
| v1.54 | ≥ 1.85 (compiled the manifest) | **renamed** `sbpf-solana-solana` | fails (2) |

The boundary therefore lies in **v1.52–v1.53**. If neither sits in the gap, **option A is closed**
and the decision is option B (move Agave to a newer line; platform-tools v2.3.3 is already cached
on this machine) or a deliberate split of the CLI pin from the build pin.

Re-run to settle it:

```bash
wsl -d Ubuntu
. ~/.ballast-env && cd ~/ballast/tests/toolchain-probe
cargo build-sbf --tools-version v1.52    # then v1.53
```

Reading the failure mode: a complaint about `edition2024` means cargo is too old (constraint 1); a
complaint that `the sbf-solana-solana target may not be installed` means the target was renamed
(constraint 2).

## What is *not* in question

`crates/floor` itself is fine on the pinned toolchain: it builds for SBF under the bundled
platform-tools v1.43 / rustc 1.79.0 with a four-package dependency tree. See
`evidence/step-1a/result.md` § "(a) `cargo build-sbf`". The blocker is entirely in the
Anchor/Solana transitive tree.
