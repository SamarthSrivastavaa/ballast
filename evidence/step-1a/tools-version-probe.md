# Probe: can `--tools-version` unblock the Anchor SBF build?

**Probe only — nothing here was adopted.** No change was written into `Anchor.toml`, CI or any
committed config. The purpose was to make the platform-tools decision in `DECISIONS.md`
§ OPEN DECISION evidence-based rather than a guess.

Ran 2 Oct 2026, `~/ballast/tests/toolchain-probe`, Agave CLI 2.1.21.

## Result so far: option A is **not** a drop-in fix

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

### platform-tools v1.51 — in flight

The probe was still downloading v1.51 when this was written. If v1.51 (Aug 2025) predates the target
rename *and* carries a cargo new enough for edition 2024, option A survives. Re-run to find out:

```bash
wsl -d Ubuntu
. ~/.ballast-env && cd ~/ballast/tests/toolchain-probe
cargo build-sbf --tools-version v1.51
```

Candidates worth trying in order, newest-first within the pre-rename generation:
`v1.51`, `v1.50`, `v1.49`, `v1.48`, `v1.47`, `v1.46.1`, `v1.42.1`.

## What is *not* in question

`crates/floor` itself is fine on the pinned toolchain: it builds for SBF under the bundled
platform-tools v1.43 / rustc 1.79.0 with a four-package dependency tree. See
`evidence/step-1a/result.md` § "(a) `cargo build-sbf`". The blocker is entirely in the
Anchor/Solana transitive tree.
