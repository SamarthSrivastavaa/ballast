//! D-002 conditions 1 and 2, enforced so they cannot regress silently.
//!
//! The approval to move the host Rust pin from §16's 1.84 to 1.85.0 came with four conditions.
//! Two of them are properties of the manifests and are checked here:
//!
//! 1. `crates/floor` stays **edition 2021**.
//! 2. `proptest` stays a **dev-dependency only**.
//!
//! Condition 3 (`crates/floor` + `ruint` must build with `cargo build-sbf` under platform-tools
//! rustc) is proven by `tests/toolchain-probe`, which links this crate into an on-chain program.
//! Condition 4 (if 3 fails, pin an older `ruint` rather than touching the toolchain) is a
//! procedural instruction recorded in DECISIONS.md.

// Test arithmetic is not protocol arithmetic: an overflow here is a test failure, which is
// exactly what should happen. The lint stays on for `src/` (see lib.rs).
#![allow(clippy::arithmetic_side_effects)]

const CRATE_MANIFEST: &str = include_str!("../Cargo.toml");
const ROOT_MANIFEST: &str = include_str!("../../../Cargo.toml");

/// Return the body of a TOML section, up to the next `[`-prefixed header at column 0.
fn section<'a>(manifest: &'a str, header: &str) -> Option<&'a str> {
    let start = manifest.find(header)? + header.len();
    let rest = &manifest[start..];
    let end = rest
        .lines()
        .scan(0usize, |acc, line| {
            let at = *acc;
            *acc += line.len() + 1;
            Some((at, line))
        })
        .find(|(_, line)| line.starts_with('['))
        .map(|(at, _)| at)
        .unwrap_or(rest.len());
    Some(&rest[..end])
}

/// D-002 condition 1: edition 2021.
///
/// `crates/floor` inherits `edition` from the workspace, so the root manifest is the thing that
/// actually sets it — both are checked, since either could drift.
#[test]
fn d002_condition_1_crate_is_edition_2021() {
    assert!(
        CRATE_MANIFEST.contains("edition.workspace = true")
            || CRATE_MANIFEST.contains(r#"edition = "2021""#),
        "crates/floor must declare edition 2021 (D-002 condition 1); its manifest declares neither \
         `edition.workspace = true` nor `edition = \"2021\"`"
    );

    let pkg = section(ROOT_MANIFEST, "[workspace.package]")
        .expect("root manifest has a [workspace.package] section");
    assert!(
        pkg.contains(r#"edition = "2021""#),
        "the workspace edition must be 2021 (D-002 condition 1), but [workspace.package] says:\n{pkg}"
    );
    assert!(
        !pkg.contains(r#"edition = "2024""#),
        "the workspace must not move to edition 2024 without revisiting D-002"
    );
}

/// D-002 condition 2: `proptest` is a dev-dependency only.
///
/// A proptest in `[dependencies]` would be linked into the on-chain program, which would both
/// bloat it and drag the edition-2024 `getrandom` tree into the SBF build — the exact problem
/// D-002 exists to contain.
#[test]
fn d002_condition_2_proptest_is_dev_only() {
    let deps = section(CRATE_MANIFEST, "[dependencies]")
        .expect("crates/floor has a [dependencies] section");
    assert!(
        !deps.contains("proptest"),
        "proptest must not be a normal dependency (D-002 condition 2); [dependencies] contains:\n{deps}"
    );

    let dev = section(CRATE_MANIFEST, "[dev-dependencies]")
        .expect("crates/floor has a [dev-dependencies] section");
    assert!(
        dev.contains("proptest"),
        "proptest should be in [dev-dependencies] (§14 needs it); found:\n{dev}"
    );

    // The same for the root: nothing may promote it workspace-wide.
    if let Some(wdeps) = section(ROOT_MANIFEST, "[workspace.dependencies]") {
        assert!(
            !wdeps.contains("proptest"),
            "proptest must not be a workspace dependency (D-002 condition 2):\n{wdeps}"
        );
    }
}

/// The crate must stay `no_std` (§11) — a `std` creep would break the on-chain build that
/// condition 3 proves.
#[test]
fn crate_is_no_std() {
    let lib = include_str!("../src/lib.rs");
    assert!(
        lib.contains("#![no_std]"),
        "crates/floor must be no_std (§11)"
    );
    let deps = section(CRATE_MANIFEST, "[dependencies]").unwrap();
    assert!(
        deps.contains("default-features = false") || deps.contains("workspace = true"),
        "ruint must be pulled in with default features off (no_std, no alloc) (§11):\n{deps}"
    );
}
