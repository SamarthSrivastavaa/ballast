#!/usr/bin/env python3
"""Lockfile guard for the crates an SBF build compiles (STEP 2 TEST 2, D-002, §16).

platform-tools v1.43 (bundled with Agave 2.1.21) ships cargo/rustc 1.79. It cannot parse an
edition-2024 manifest, and it should not compile a crate that declares a newer MSRV. Host cargo
1.85 resolves the lockfile with MSRV-aware resolution (.cargo/config.toml), but crates that use
edition 2024 without declaring rust-version slip through (blake3 1.8.7 did), and caret
requirements inside anchor-lang drift its sub-crates to 0.31.2. This guard fails on all three.

Only packages reachable from the workspace members through **normal and build** dependencies are
checked. Dev-dependencies are excluded deliberately: `cargo build-sbf` never compiles them, so a
host-only test dependency (proptest -> getrandom -> wasip2 / wit-bindgen, all edition 2024) is not
a problem for the on-chain build and must not fail this guard. The root workspace holds both
programs/ballast and crates/floor, so without this distinction the guard reports false positives.

Usage: python3 scripts/toolchain/check_lock.py <workspace-dir> [<workspace-dir> ...]
"""
import json
import subprocess
import sys

SBF_RUSTC = (1, 79, 0)
PINS = {"anchor-lang": "0.31.1", "solana-program": "2.1.21"}


def ver(s: str) -> tuple:
    parts = [int(x) for x in s.split("-")[0].split(".")[:3]]
    return tuple(parts + [0] * (3 - len(parts)))


def check(workspace: str) -> list[str]:
    meta = json.loads(
        subprocess.run(
            ["cargo", "metadata", "--format-version", "1", "--locked"],
            cwd=workspace,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    )
    # Reachable from the workspace members through normal/build deps only.
    nodes = {n["id"]: n for n in meta["resolve"]["nodes"]}
    reachable, stack = set(), list(meta["workspace_members"])
    while stack:
        pid = stack.pop()
        if pid in reachable or pid not in nodes:
            continue
        reachable.add(pid)
        for dep in nodes[pid]["deps"]:
            kinds = {dk.get("kind") for dk in dep.get("dep_kinds", [])}
            # kind None = normal, "build" = build script. "dev" never reaches an SBF build.
            if kinds and kinds <= {"dev"}:
                continue
            stack.append(dep["pkg"])

    problems = []
    skipped = 0
    for p in meta["packages"]:
        name, version = p["name"], p["version"]
        if p["id"] not in reachable:
            skipped += 1
            continue
        if p["edition"] == "2024":
            problems.append(f"{name} {version}: edition 2024 (cargo 1.79 cannot parse it)")
        rv = p.get("rust_version")
        if rv and ver(rv) > SBF_RUSTC:
            problems.append(f"{name} {version}: rust-version {rv} > platform-tools rustc 1.79")
        if name.startswith("anchor-") and not name.startswith("anchor-lang-idl") and version != PINS["anchor-lang"]:
            problems.append(f"{name} {version}: off the Anchor {PINS['anchor-lang']} pin")
        if name == "solana-program" and version != PINS["solana-program"]:
            problems.append(f"{name} {version}: off the Agave {PINS['solana-program']} pin")
    print(
        f"{workspace}: {len(reachable)} packages in the SBF graph "
        f"({skipped} dev-only skipped), {len(problems)} problems"
    )
    return problems


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    problems = [f"{ws}: {p}" for ws in sys.argv[1:] for p in check(ws)]
    for p in problems:
        print("  -", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
