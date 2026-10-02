---
description: Run spec-auditor and security-reviewer on the current diff — report violations only
---

# Audit

Run both review agents against the current diff and report **violations only**. No summary of what the
code does, no praise, no restatement of the architecture. If there are no violations, say so in one line.

## 1. Establish the diff

```bash
git status --short
git diff HEAD          # or git diff <last-tag>..HEAD if the working tree is clean
```

If the tree is clean and there is no obvious range, ask me what to audit rather than auditing everything.

## 2. Run both agents

Invoke `spec-auditor` and `security-reviewer` on that diff. Give each the file list and the spec sections
in scope; they read the spec themselves.

- `spec-auditor` → §4 (math, rounding, monotone check), §5 (account-substitution rules), §6 (pre/postconditions
  per instruction), §10 (the vault has exactly two exits), §21 (UI wording and the six prices)
- `security-reviewer` → §12 threat model: PDA signer scope, account validation, CPI program IDs, arithmetic bounds

## 3. Banned-wording grep (always, regardless of the diff)

```bash
grep -rniE "\b(safe|insured|protected|guaranteed)\b|can'?t lose|cannot lose|never go below|risk[- ]free" \
  app/ README.md docs/ sdk/ programs/ 2>/dev/null
```

§21 bans `safe`, `insured`, `protected`, `can't lose`, `guaranteed profit`, and "price can never go below F"
in anything user-facing. Judge each hit: a banned claim in UI copy, a README line, or an error message is a
violation; the word `safe` inside `checked_add`-style Rust prose or a doc sentence explaining why something
is *not* safe is not. Report the hits you consider violations, with file:line.

Also confirm the §21 headline sentence is present on the token page once `app/` exists:
"This is an executable buyback floor on Meteora, not a promise about prices elsewhere."

## 4. Report

Violations only, most severe first:

```
<file>:<line>  [spec §<n>]  <what rule is broken, in one line>
                            <the minimum fix>
```

Group by severity: **CRITICAL** (could lower F, drain the vault, or let an account be substituted) ·
**HIGH** (invariant or validator rule missing) · **MEDIUM** (rounding direction, bounds, error path) ·
**WORDING** (§21).

End with one line: the count by severity, and whether anything here blocks a commit, a gate, or the
submission. Do not fix anything during an audit unless I ask — report, then wait.
