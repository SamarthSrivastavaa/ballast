---
description: Build one vertical slice end to end — spec sections, plan, tests first, implement, audit, update status
argument-hint: <slice description, e.g. "program part 1 — initialize_global, create_class, …">
---

# Slice: $ARGUMENTS

One vertical slice, start to finish. Do not widen the scope beyond what is named above, and do not
narrow it either — if part of it turns out to be blocked, finish everything else and say explicitly
what you left out and why.

## 0. Gate check (first, always)

Read `DECISIONS.md`. **If any of Q1–Q5 is still UNKNOWN and this slice is not a test harness, the floor
crate, the Python reference, the compiler, fixtures, or a devnet P0 script — STOP and say so.** The P0
gate rule in `CLAUDE.md` outranks the slice request. Report which questions block it.

## 1. Read only what this slice needs

Identify the spec sections this slice touches and read **only those** from `docs/spec/BUILD_SPEC.md`
(`grep -n "^## " docs/spec/BUILD_SPEC.md` for the section map, then `sed -n`). Never read the whole spec.
List the sections you read at the top of your plan so I can check you picked the right ones.

Read `CLAUDE.md`, `STATUS.md`, and the relevant rows of `DECISIONS.md`. Anything this slice depends on
that is still UNKNOWN is a risk to name in the plan, not an assumption to make.

## 2. Plan mode

Enter plan mode. The plan must state:

- The spec sections read, by number.
- Every file to be created or changed.
- The tests to be written **first**, including the negative tests §14 demands for this slice (one per
  §7 validator rule, one per account-substitution rule in §5, one per CPI).
- The invariants that must hold at the end (§4 monotone check, §10 vault-exits rule, conservation).
- Anything that depends on an UNKNOWN, and what you will do instead of guessing.
- What you will **not** build (§31 cut list).

Wait for my approval. Do not write code in plan mode.

## 3. Tests before implementation

Write the tests first and watch them fail for the right reason. Integration tests use dumped Meteora
programs or devnet — **never a mock of a Meteora program** (`CLAUDE.md`). Pure-logic tests may use LiteSVM.

## 4. Implement

Follow the §4 code rules exactly: only `ballast-floor` computes F; V/S/L read live inside the same
instruction; every mutating instruction ends with `require!(s_new >= launch.s_last)`; bounds asserts
precede arithmetic; rounding toward the protocol everywhere.

If a test can only be made to pass by weakening an invariant, a rounding direction, or an account
check — **stop and ask me.** That is never the right fix.

## 5. Run the full suite

Not just the new tests:

```bash
cargo fmt --check && cargo clippy -- -D warnings
cargo test -p ballast-floor -p meteora-types -p verifier-core
anchor build && anchor test
```

Plus the TS workspace tests for any package touched. Report real output. If something fails, say so with
the output — never describe a suite as green unless it is.

## 6. Audit

Invoke the `spec-auditor` agent on the diff. Then, if this slice touched the program, PDA signing, CPIs,
or account validation, invoke `security-reviewer` too. Fix every reported violation, or explain in your
report why a finding is wrong. Do not report the slice done with open violations.

## 7. Bookkeeping

- Update `STATUS.md`: tick what is done, move the "Next task" line, add or clear open risks.
- Update `DECISIONS.md`: any question this slice answered (with signatures), any pin confirmed, any
  deviation (which needs my approval first).
- Save evidence to `evidence/` per its README — signatures, account dumps, CU logs.

## 8. Report and propose a commit

Report in this shape, nothing more:

```
Changed:   <files and what they do>
Evidence:  <tests run and their result; signatures; CU numbers>
Next:      <the next slice or gate>
Risks:     <open, honestly>
```

Then propose a commit message citing the spec sections — do not commit until I say so:

```
<type>: <what> (§<sections>)

<why, in a line or two>
<evidence pointer>
```
