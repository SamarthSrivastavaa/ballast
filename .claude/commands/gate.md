---
description: Run devnet gate N from spec §18, save evidence, record PASS/FAIL with signatures
argument-hint: <gate number 1-10>
---

# Devnet gate $ARGUMENTS

Run gate **$ARGUMENTS** from `docs/spec/BUILD_SPEC.md` §18. A gate is a hard pass/fail. It is not a
status update and not an opinion — it either produced the evidence §18 asks for, or it failed.

## 1. Read the gate

```bash
sed -n '/^## 18\./,/^## 19\./p' docs/spec/BUILD_SPEC.md
```

Quote the gate's **Work** and **Pass gate** columns verbatim into `evidence/gate-$ARGUMENTS/result.md`
before running anything. Then read the Top-20 rows (`DECISIONS.md`) for every question this gate answers,
and the spec sections those rows name — the Top-20 "Exact verification" column is the procedure; follow
it literally, including the parts that look redundant (same-slot reads, 20 swaps each way, 2 fee claims,
inner-instruction listings).

Gates 3 and 5 are **P0**. A failure there halts the build.

## 2. Preflight

- Confirm the toolchain is the one recorded in `DECISIONS.md` § Toolchain. **A gate run on a mismatched
  toolchain proves nothing** — if the pins are still TBD, stop and say so.
- Confirm cluster is devnet (`solana config get`). Never run a gate against mainnet.
- Check the devnet balance of every wallet the gate needs. **If SOL is short, stop and ask me** — do not
  reduce the gate's scope to fit the balance.
- Earlier gates this one depends on must already be PASS.

## 3. Run it

Capture everything as you go, into `evidence/gate-$ARGUMENTS/`:

- `signatures.txt` — every signature, labelled, with the cluster and slot
- `accounts/*.json` — `solana account <addr> -u devnet --output json`, before **and** after
- `logs/*.txt` — full transaction logs, including `consumed … compute units`

Read account state in the same slot as the transaction where the gate says to (Q1 especially).

## 4. Verdict

Write `evidence/gate-$ARGUMENTS/result.md`:

```
# Gate $ARGUMENTS — <phase name>

Verdict:  PASS | FAIL
Ran at:   <commit> on <date>, cluster devnet
Criterion (§18, verbatim): <quoted>

## What was run
<commands / scripts, exactly>

## Observed
<the numbers, the account fields, the deltas — actual values, not "as expected">

## Against the criterion
<field by field: observed vs required>

## Questions answered
Q<n>: <answer> — <signature>
```

Then update `DECISIONS.md`: the gate row (Status, Tag, Evidence) and every Top-20 row this gate touched —
Status `VERIFIED` only with a signature, the observed answer in the Answer column. Update `STATUS.md`.

## 5. On PASS

Report the verdict with the key numbers. Propose the commit and the tag `gate-$ARGUMENTS-pass`; do not
tag until I say so.

## 6. On FAIL — stop

Do **not** retry with different parameters, loosen the criterion, or move to the next gate.

1. Record the failure in `evidence/gate-$ARGUMENTS/result.md` with the full evidence. A FAIL is a result.
2. Set the Top-20 row(s) to `FAILED` in `DECISIONS.md` with the signature that shows it.
3. **Present the spec's own fallback, quoted verbatim** from the `DECISIONS.md` fallback table — and only
   that one. Never invent a different fallback.
4. State plainly what the fallback costs: which part of the mechanism changes, what the submission can no
   longer claim, and whether it needs escalation to Meteora (Q5 does).
5. Stop and wait for my decision. Adopting a fallback is my call, not yours.
