---
description: Update STATUS.md for a clean handoff and summarise the session in 10 lines
---

# Handoff

Close out the session so the next one (after `/clear`) can resume from files alone. Assume the next
session knows nothing that is not written down.

## 1. Update `STATUS.md`

- **Updated:** today's date.
- **Current state** table: phase, last passed gate, P0 status, open UNKNOWN count, whether mainnet is touched.
- Tick every checklist item actually completed. Do not tick anything partially done — leave it unticked and
  describe the partial state in the next-task line. An over-optimistic STATUS.md is worse than none.
- **In progress:** what is half-built, in which files, and what the next concrete action on it is.
- **Next task:** one specific action, naming the spec sections it needs.
- **Open risks:** add anything discovered this session; clear anything resolved (and say where the
  resolution is recorded).

## 2. Update `DECISIONS.md` if anything moved

Any question answered (signature required for VERIFIED), any pin confirmed, any gate verdict, any
deviation. If nothing moved, leave it alone.

## 3. Check nothing is stranded

- Uncommitted work: `git status --short`. Either propose a commit or write in `STATUS.md` exactly what is
  uncommitted and why, so it is not mistaken for finished work.
- Evidence captured this session is written to `evidence/`, not left in scrollback or a temp file.
- Anything you learned that contradicts the spec is in `DECISIONS.md`, not only in this conversation.

## 4. Summarise in exactly 10 lines

```
1. Phase and date
2. Done this session
3. Evidence produced (signatures, test results, CU numbers)
4. Last passed gate
5. P0 status (Q1–Q5)
6. In progress, and in which files
7. Uncommitted work, if any
8. Next task, with spec sections
9. Open risks
10. What needs me (funds, keys, signatures, a decision)
```

Then remind me: `/clear`, then paste Prompt 3 from the playbook.
