# evidence/

Raw proof for every claim Ballast makes. **This directory becomes the judging record** — §29 Definition of
Done and the §34 README are both written from it. Nothing here is generated prose; it is all chain data,
tool output, and signatures.

A Top-20 question or a §18 gate is only answered when its evidence lives here *and* is linked from
`DECISIONS.md`. "It worked when I ran it" is not evidence.

## What goes where

```
evidence/
  gate-1/ … gate-10/        One directory per §18 devnet gate
    result.md               PASS / FAIL, the pass criterion quoted from §18, what was run
    signatures.txt          Every tx signature, one per line, with a label and the cluster
    accounts/*.json         `solana account --output json` dumps, before/after where it matters
    logs/*.txt              Transaction logs, including CU consumed
  q01/ … q20/               One directory per Top-20 question (whichever gate produced it)
    answer.md               The question, the observed answer, the signature(s) that prove it
    accounts/*.json
  cu/                       Compute-unit measurements per instruction (Q18, §26 budgets)
    open.txt  redeem.txt  refresh_floor.txt
  fixtures/                 Hashes of dumped Meteora .so files and cloned accounts (§17)
  verifier/                 `ballast verify` output, one file per run, timestamped
  mainnet-dryrun/           `simulateTransaction` results: account lists, CU, signer sets (Prompt 4)
  mainnet-proof/            The §22 Proof launch: every signature in runbook order
  mainnet-public/           The §23 Public launch
  sellout/                  Per-fill execution price vs F for the sell-out runs (§22, gate 8)
  fuzz/                     Model-fuzzer seeds and any failing sequence (§14, 1M steps)
  challenge/                Any §24 challenge submission and its reproduction
```

## Rules

1. **Signatures, not screenshots.** Every claim ties to a transaction signature on a named cluster
   (`devnet` / `mainnet-beta`) at a named slot. Screenshots only for the demo, and only alongside signatures.
2. **Raw account JSON.** Dump with `solana account <addr> -u <cluster> --output json`. Keep the base64
   account data — a decoded summary is a convenience, not the record. Capture before *and* after for any
   claim about a change (or a non-change, e.g. Q2's "L unchanged after 20 swaps").
3. **Both directions of a negative result.** A FAIL is evidence too. Record it, then stop and bring it
   back — do not substitute a fallback silently (`DECISIONS.md` rules).
4. **Reproducible.** Each `result.md` names the exact command or script that produced it, with the commit
   it ran at. A judge should be able to re-run it.
5. **Never edited after the fact.** Supersede with a new dated file; keep the original.
6. **No keypairs, ever.** No private keys, no seed phrases, no `.keys/` contents, no RPC URLs carrying API
   keys. Public addresses and signatures only.
7. **Committed to git.** This directory is the proof; it is not gitignored. (`fixtures/` itself is
   gitignored — only its hashes are committed, here.)

## The three things a judge must be able to do from this directory alone

- Confirm the prediction was recorded **before trade 1** (`LaunchRegistered` signature + slot, vs the DBC
  pool's first swap).
- Confirm **realised F ≥ predicted F** on mainnet (`verifier/` output + `mainnet-proof/`).
- Confirm the full sell-out executed at **≥ 0.99·F** (`sellout/` per-fill prices).
