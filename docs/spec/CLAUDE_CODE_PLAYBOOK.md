# Ballast — Claude Code Playbook

How to build Ballast end to end in Claude Code from `docs/spec/BUILD_SPEC.md`.
Deadline: 13 Oct 2026, 06:59 UTC. Plan to submit on 12 Oct.

---

## 0. Setup (once, ~10 minutes)

1. In the Ballast doc, open the **Build Spec** tab → export as **Markdown** → save as `docs/spec/BUILD_SPEC.md`.
   Optional: export **Final Submission — War Room** → `docs/spec/SUBMISSION.md` (demo and README copy).
2. Put this file at `docs/spec/CLAUDE_CODE_PLAYBOOK.md`.
3. Start:
   ```bash
   mkdir ballast && cd ballast && git init
   mkdir -p docs/spec        # copy the two files above into docs/spec/
   claude
   ```
4. Optional: add Meteora's docs MCP server (instructions at docs.meteora.ag/mcp) so Claude Code can check current Meteora interfaces.
5. Paste this single line into Claude Code:
   ```text
   Read docs/spec/CLAUDE_CODE_PLAYBOOK.md and docs/spec/BUILD_SPEC.md, then execute Prompt 1 from the playbook, starting with STEP 0.
   ```

---

## How the loop works

- **Plan → approve → build.** Every slice starts in plan mode (Shift+Tab or `/plan`). Approve the plan, then let it implement.
- **Small memory, big files.** `CLAUDE.md` holds only rules (≤150 lines). The spec is read section by section on demand, never pasted whole.
- **State lives in files:** `STATUS.md` (progress), `DECISIONS.md` (every Top-20 answer with tx signatures), `evidence/` (account dumps, CU logs, verifier output). These become your README and judging proof.
- **Between slices:** `/handoff` → `/clear` → paste Prompt 3.
- **Commits:** one per slice; tag every passed gate (`gate-1-pass`, …).
- **Parallel work:** only after the P0 gates pass, and only in a separate git worktree (verifier or app). Never two sessions on `programs/ballast`.
- **You stay in the loop for:** devnet SOL, every mainnet transaction, multisig signatures, the Proof-launch spend, and any change to the canon.

---

## Prompt 1 — Kickoff

```text
You are the lead engineer for Ballast, a Meteora DBC launch class with an on-chain buyback floor F. Implement it exactly as specified, end to end, before 13 Oct 2026 06:59 UTC.

SOURCE OF TRUTH
- docs/spec/BUILD_SPEC.md is authoritative. docs/spec/SUBMISSION.md (if present) is only for demo and README copy.
- If code, docs, or your own assumptions conflict with BUILD_SPEC.md, the spec wins. If the spec conflicts with observed on-chain behaviour, STOP: record the evidence in DECISIONS.md, propose the minimum correction, wait for my approval.
- Never invent Meteora behaviour. Anything not verified by docs, program source, SDK, or a devnet transaction is UNKNOWN until tested.

STEP 0 — GUARDRAILS (no product code yet)
Read BUILD_SPEC.md fully. Then create these and show them to me before continuing:
1. CLAUDE.md (≤150 lines): one-paragraph mission; the floor equation and the code rules from spec §4; the six corrections from §1; the banned wording (safe / insured / can't lose / "price can never go below F"); the P0 gate rule (nothing beyond test harnesses until Q1–Q5 pass); repo layout §15; toolchain pins §16; build and test commands; "read spec sections on demand, never paste the whole spec into context"; "update STATUS.md and DECISIONS.md at the end of every task".
2. STATUS.md: the §28 daily plan as a checklist, with current state.
3. DECISIONS.md: the Top-20 questions table with Status = UNKNOWN and an empty Evidence column.
4. evidence/ with a README saying what goes there (tx signatures, account JSON dumps, CU logs, verifier output).
5. .claude/commands/
   - slice.md ($ARGUMENTS): one vertical slice — read the relevant spec sections, plan mode, tests first, implement, run all tests, invoke spec-auditor, update STATUS.md, propose a commit message citing spec sections.
   - gate.md ($ARGUMENTS): run devnet gate N from §18, save evidence to evidence/gate-N/, mark PASS/FAIL in DECISIONS.md with signatures; on FAIL, stop and present the spec's fallback.
   - audit.md: run spec-auditor and security-reviewer on the current diff; report violations only.
   - handoff.md: update STATUS.md (done / in progress / next / open risks) and summarise in 10 lines.
6. .claude/agents/ (read-only tools unless stated)
   - spec-auditor: checks code against §4 (math, rounding), §5 (account-substitution rules), §6 (pre/postconditions), §10 (vault has only two exits), §21 (UI wording). Reports file:line violations.
   - security-reviewer: §12 threat model — PDA signer scope, account validation, CPI program IDs, arithmetic bounds.
   - meteora-researcher (may fetch web pages): answers Top-20 questions from Meteora docs, SDKs and program source, with URLs; never guesses; its answers are leads until a devnet transaction confirms them.
7. .claude/settings.json: allow routine build/test commands (cargo, anchor build/test, pnpm, solana-test-validator, devnet reads). Deny or require approval for: any mainnet RPC write; any program deploy against mainnet; reading .keys/mainnet or any keypair outside .keys/devnet. Verify with /permissions and show me the result.

STEP 1 — DAY 1 (spec §33), in this order
A. Scaffold the repo per §15; pin the toolchain per §16 (prove each pin builds; record final pins in DECISIONS.md); CI with fmt, clippy -D warnings, unit tests.
B. crates/floor: implement §4 and §11 exactly (U256; floor-of-root with the correction loop; ceil(L/s_max) in A; payouts rounded down; bin check). Write tests/reference/floor.py independently. Generate crates/floor/vectors.json from Python with every §27 vector plus 10k random ones. Rust must match Python bit for bit. This needs no network: do it first.
C. Fixtures: `pnpm fixtures:dump` per §17; local validator boots with real DBC, DAMM v2, DLMM, Metaplex and locker programs.
D. Devnet P0 harness (tests/devnet/p0): minimal Anchor program + TS scripts answering Q1, Q2, Q3, Q4, Q6, Q7, Q11, Q12, Q14 exactly as the Top-20 table describes. Ask me when you need devnet SOL. Every answer goes into DECISIONS.md with signatures and a JSON dump in evidence/.

STOP AND ASK ME WHEN
- any P0 question fails, or a fallback would change the mechanism;
- you need funds, keys, a multisig signature, or any mainnet action;
- a test could only pass by weakening an invariant, a rounding direction, or an account check;
- you are about to build anything on the spec's DO NOT BUILD list.

WORKING STYLE
- Plan mode for every new slice; tests before implementation; full test suite before "done".
- Never mock Meteora in integration tests: dumped programs or devnet only.
- One commit per slice; cite the spec section in the message.
- After each step report: what changed → evidence (tests, signatures) → next → open risks.

Begin with STEP 0.
```

---

## Prompt 2 — Slices after Day 1 (one line each, in order)

Each must meet its acceptance check before the next starts.

```text
/slice DLMM P0 harness — Q5, Q8, Q9, Q15–Q17 per spec §9 and §18; then /gate 5
```
```text
/slice floor-wasm + compiler — §11 cross-language and §7 canonical configs; Proof and Public configs plus predicted s; compiler output must match vectors.json
```
```text
/slice program part 1 — initialize_global, create_class (every §7 validator rule, one negative test per rule), register_launch, settle_graduation, burn_leftover; local-validator tests against real Meteora programs
```
```text
/slice program part 2 — open, refresh_floor, redeem (atomic; measure CU for Q18), harvest, deposit, floor view; model fuzzer 1M steps asserting F never falls and V/F + L(1/sqrtF − 1/sqrtPmax) ≥ S
```
```text
/gate 6
/gate 7
/gate 8
/gate 9
/gate 10
```
```text
/slice verifier — §20 exactly; must PASS on the devnet launch from a clean checkout with only an RPC URL
```
```text
/audit
```

Then: Prompt 4 (mainnet Proof) → Public launch and challenge (§23–24) → app (§21) → README (§34) → demo.

---

## Prompt 3 — Resume after /clear or a new session

```text
Read CLAUDE.md, STATUS.md and DECISIONS.md (not the full spec). Summarise in 8 lines: current state, last passed gate, open UNKNOWNs, next task. Then propose the next step in plan mode, reading only the spec sections that step needs.
```

---

## Prompt 4 — Before anything touches mainnet

```text
Prepare the mainnet Proof launch per spec §19 and §22. Do not send any transaction.
1. Write scripts/proof/ with --dry-run that simulates every transaction against mainnet state (simulateTransaction) and saves account lists, CU and signers to evidence/mainnet-dryrun/.
2. Write a runbook checklist: deploy from buffer → set upgrade authority to the multisig → verify the build → initialize_global → create the Proof config with fee_claimer = partner_auth → create_class → fund partner_auth for order rent → register_launch (prediction recorded before trade 1) → buys → settle → migrate → burn_leftover → open → sell-out → refresh_floor → ballast verify --sellout.
3. List every step that needs my signature or funds.
I will execute each mainnet step and paste the signatures back; record them in DECISIONS.md and evidence/mainnet-proof/.
```

---

## Prompt 5 — Public launch, app, README, demo

```text
Using STATUS.md and spec §21, §23, §24, §34, §35:
1. Public class and launch scripts (dry-run first; I sign).
2. Challenge rules page and the verifier --at-slot mode per §24.
3. One token page and the 5-step launch form per §21; every number must come from the floor crate and match `ballast verify`.
4. README in the §34 order, with real addresses and signatures from evidence/.
5. A demo checklist mapping each §35 happy-path step to its signature.
Finish with /audit and a grep for banned wording across app/ and README.md.
```

---

## Tips

- **Day 1 order matters:** the floor crate needs no network, so Claude builds it while you fund devnet wallets.
- **Evidence over claims:** a Top-20 question is VERIFIED only with a devnet signature in DECISIONS.md.
- **If a P0 fails:** don't let Claude improvise. Bring the evidence back to the research doc and choose the spec's fallback deliberately.
- **Context hygiene:** `/handoff` → `/clear` after every slice; long sessions drift.
- **Before recording the demo:** run `/audit` and the verifier one last time.