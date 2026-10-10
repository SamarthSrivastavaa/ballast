# Ballast — Agent Rules

## Mission

Ballast is one Anchor program that wraps a Meteora DBC launch class with an on-chain, executable
buyback floor **F**. At graduation, 15% of the raise is withdrawn as the DBC migration fee into a
program-owned vault; the other 85% migrates into a DAMM v2 pool as two permanently locked,
PDA-owned positions. The whole vault rests as one DLMM limit order in the highest bin at or below F.
F is the price at which locked liquidity plus the vault bid can absorb the entire outstanding supply,
so every holder token can be sold at ≥ F. The claim is falsifiable: the floor is predicted on-chain
in the pool-creation transaction, before any third-party trade (D-011), and `ballast verify`
recomputes it from raw accounts. Deadline 13 Oct 2026 06:59 UTC;
**we submit 11 Oct.** Two tiers, one mechanism (D-008): **Lite** (DBC config only, V = 0) and **Full**.

**Environment:** every shell command runs after `source ~/.ballast-env`; work only in /home/hp/ballast
on ext4; never under /mnt/c or OneDrive.

## Source of truth

- `docs/spec/BUILD_SPEC.md` is authoritative. `docs/spec/SUBMISSION.md` (if present) is demo/README copy only.
- **Read spec sections on demand; never paste the whole spec into context.** Conflicts with the spec → the spec wins.
- Spec vs observed on-chain behaviour → **STOP**: record evidence in `DECISIONS.md`, propose the minimum fix, wait.
- **Never invent Meteora behaviour.** Anything not verified by docs, program source, SDK, or a
  transaction is UNKNOWN until tested. Never mock Meteora in integration tests: mainnet-dumped programs
  on the local validator, or devnet only.
- **D-001 — mainnet binaries govern.** P0/P1 answers come first from a local validator running the mainnet-dumped
  DBC, DAMM v2, DLMM, Token Metadata and Jupiter locker, plus every mainnet account they read (found by simulation,
  not guessed); authoritative. Devnet = Q17 + cross-checks; divergence recorded, mainnet result governs. **Run
  `pnpm fixtures:check` at session start and before any mainnet action**; a hash change → re-run affected gates.

## P0 gate rule

**Nothing beyond test harnesses is built until Q1–Q5 pass on the mainnet-binary local validator
(D-001).** No product code, no app, no program logic past a CPI test harness. Floor crate + Python reference
exempt. Q1 permanent lock · Q2 mode/range/constant L · Q3 L↔reserves · Q4 PDA fee claims · Q5 PDA DLMM orders.

## The floor equation (§4)

```
V/F + L_real·(1/√F − 1/√P_max) = S          L_real = L / 2^64
⟺  A·s² − B·s − C = 0      A = S + ⌈L/s_max⌉,  B = L,  C = V·2^128
```

`s = ⌊√F · 2^64⌋`. V = vault lamports + `launch.bid_quote_committed`. S = `base_mint.supply` −
PDA-held base. L = Σ `permanent_locked_liquidity` of the **two recorded positions only**.

Algorithm, identical in every implementation: (1) `D = B² + 4AC` in U256; (2) `s = ⌊(B + isqrt(D))/(2A)⌋`;
(3) correction loop — while `A·s² − B·s − C > 0`: `s -= 1`; while `A·(s+1)² − B·(s+1) − C ≤ 0`: `s += 1`;
(4) return s. Bounds asserted **before** arithmetic: `S ≤ 2^50`, `V ≤ 2^64 − 1`, `L ≤ 2^120` (D-003),
`s_max < 2^97`. Out-of-range inputs return an error, never a value.

**Rounding is toward the protocol, everywhere:** `⌈L/s_max⌉` in A, `⌊root⌋` for s, `⌊·⌋` on payouts and
bid amounts, bid bin at or below F. No floating point anywhere in the crate.

### Reading balances (D-012)

**A missing token account is an ERROR, never 0.** Use the throwing helper wherever a balance decides
anything — funding, payouts, bid sizing, reconciliation. The returns-zero form is allowed only where
"absent" and "empty" are genuinely the same thing, and it must say so in its name
(`…OrZero`). This cost us a near-miss: the Q5 harness read `partner_auth`'s WSOL with a
returns-zero helper and placed a bid it believed was funded, against an account that did not exist.

Related: **`open` funds the bid from the vault PDA's token account**, not `partner_auth`'s — Q4
showed the DBC claims accept a destination the fee claimer does not own, and this project sends them
to the vault.

### Code rules derived from the proof (§4)

1. Only `ballast-floor` computes F. The program, verifier, and app call it — never reimplement.
2. V, S, L are read from accounts inside the same instruction; nothing is cached across them except `s_last`.
3. Every mutating instruction ends with `require!(s_new >= launch.s_last)` then sets `s_last = s_new`.
4. Redemption pays at s computed **after** settlement and **before** the burn; the post-state check must then pass.
5. Bounds asserts precede all arithmetic.

## Principles from the Part 2 audit (D-021, D-022)

- **No outside actor can prevent the floor from existing; F and redemption never depend on DLMM pair state.**
- **Nothing the creator controls is on the floor's critical path.**

## The six corrections to the canon (§1) — non-negotiable

1. **Bounded range.** The equation carries the `−L·(1/√P_max)` term; L is permanent-only, DAMM Q64 units.
2. **Exact floor of the root** in integer arithmetic, so "F never falls" holds bit for bit across Rust, TS, verifier.
3. **Both migrated positions are PDA-owned.** DBC pool-creator role transfers to `creator_auth` in the pool-creation transaction, before any third-party trade (D-011).
4. **Fills are collected only by cancelling.** "Settle" = cancel → burn → re-place. There is no claim endpoint.
5. **100% of the vault sits in the DLMM bid.** Redemption is atomic cancel → burn → pay → re-place.
6. **The prediction is a lower bound.** The claim is "realised F ≥ predicted F", with a declared upper tolerance.

## Banned wording (§21) — never in app/, README, docs, or events

`safe` · `insured` · `protected` · `can't lose` · `guaranteed profit` · "price can never go below F".
CI fails if `app/` or `README.md` contains any of them (D-006), including the TypeScript keyword `protected`.

Required headline: "This is an executable buyback floor on Meteora, not a promise about prices elsewhere."
Always name which of the six prices (§9) a number is: theoretical F, bid bin price, executable bid net, DAMM v2
price, DAMM v2 sell net, redemption. Late buyers can lose ~74% — say so.

## Repo layout (§15)

```
CRITICAL: programs/ballast/ (all on-chain logic) · crates/floor/ (ballast-floor, no_std, vectors.json)
          crates/meteora-types/ (vendored zero-copy layouts + offset tests) · crates/verifier-core/ · verifier/
sdk/typescript/ (ix builders, PDAs, floor-wasm) · compiler/ (ConfigParameters + predicted s per size)
keeper/ (cranks; liveness only, permissionless) · app/ (token page + launch form)
tests/{unit,integration,fuzz,devnet,mainnet,reference}/
scripts/{deploy,initialize,proof,public-launch,fixtures,toolchain}/
docs/{architecture,mechanism,math,security,meteora,verifier,proof,operations,limitations}.md
fixtures/ (dumped Meteora .so + cloned accounts; gitignored; pins in evidence/fixtures/)
```

## Toolchain (§16) — decided 2 Oct 2026 (STEP 2), full table in `DECISIONS.md` § Toolchain

Agave/Solana CLI **2.1.21** · Anchor **0.31.1** · host rustc **1.85.0** (D-002) · SBF builds by platform-tools
**v1.43** (rustc/cargo 1.79) · Node 20 · pnpm 9 · TS 5.6 · web3.js 1.98.4 · spl-token 0.4.13 · DBC SDK 1.5.13 ·
cp-amm SDK 1.4.8 · dlmm 1.9.10 · `@coral-xyz/anchor` 0.31.1 · `ruint`, `bytemuck`, `proptest`, `solana-client` 2.1 ·
wasm-pack/wasm-bindgen · Vite + React 18 + wallet-adapter · rustfmt, clippy `-D warnings`, eslint, prettier.
**A pin not proven in `DECISIONS.md` § Toolchain is unverified — confirm it before relying on it.**
**Every SBF workspace uses the lockfile method:** `rust-version = "1.79"`; `.cargo/config.toml`
`[resolver] incompatible-rust-versions = "fallback"` (never `resolver = "3"`); lock from host cargo, then
`--precise` pins `solana-program 2.1.21`, `blake3 1.5.5`, every `anchor-*` `0.31.1` (`anchor-lang = "=0.31.1"`
alone does **not** pin its sub-crates); `python3 scripts/toolchain/check_lock.py <ws>` must report 0 problems.

## Build and test commands

```bash
cargo test -p ballast-floor -p meteora-types; cargo test -p verifier-core   # no network
cargo fmt --check && cargo clippy -- -D warnings; python tests/reference/floor.py
pnpm fixtures:dump; pnpm fixtures:check     # mainnet pins (dump refuses drift); check at session start (D-001)
pnpm localnet --quiet; pnpm fixtures:exec   # mainnet-binary validator (checks online first); prove programs execute
bash scripts/fixtures/negative-tests.sh; python3 scripts/toolchain/check_lock.py <ws>   # guards; SBF lock guard
anchor build; anchor test                      # --verifiable for mainnet; local validator, real Meteora
pnpm -F sdk test; pnpm -F compiler test; pnpm -F keeper test; pnpm -F app build; ballast verify <launch> --rpc <url>
```

## Working style

- **Operating loop, every slice:** plan mode → show the plan → tests first → implement → full test
  suite → `/audit` (spec-auditor + security-reviewer) → update `STATUS.md` and `DECISIONS.md` → commit
  citing spec sections → one-paragraph report: what changed → evidence → next → risks.
- One commit per slice, citing the spec section. Tag every passed gate (`gate-1-pass`, …).
- **Every commit: `Samarth <samarthsrivastava897@gmail.com>` only** (author + committer; no trailer; never copy
  `git log`). `origin` = github.com/SamarthSrivastavaa/ballast (public): push `main` + gate tags, never `backup/*`.
- **Update `STATUS.md` and `DECISIONS.md` at the end of every task.** Evidence goes in `evidence/`.
- A Top-20 question is VERIFIED only with a transaction signature on the mainnet-binary local validator
  (D-001) recorded in `DECISIONS.md` with a JSON dump in `evidence/`. Devnet signatures are secondary.
  Exceptions: Q17 (devnet keeper) and Q10 (saved Jupiter quote JSON) — see the `DECISIONS.md` rules.
- Parallel work only after the P0 gates pass, in a separate git worktree; never two sessions on `programs/ballast`.

## Decisions in force (full text in `DECISIONS.md`)

- **D-006 judging order:** Meteora integration depth (DBC, DAMM v2, DLMM each carry part of the floor) → technical
  execution → originality → impact → traction. Apache-2.0; `JUDGES.md` maps each criterion to linked evidence.
- **D-007 budget:** no mainnet spend unless the owner approves **each transaction**. Primary proof: `pnpm proof:local`
  (the full §22 sequence on the mainnet-binary local validator), then devnet. Mainnet Full deploy only if funded.
  **D-009:** `.so` soft ≤ 400 KB (manual CPI builders, `opt-level = "z"`, `lto`, `codegen-units = 1`; report size per
  slice; no days on size). CU: 30% headroom under §26 (open ≤ 420k, redeem ≤ 840k, refresh ≤ 560k) until devnet.
- **D-008 tiers:** Lite = DBC config only, flat 1% fee, 100% permanently locked LP split partner/creator, migration
  fee 0, floor = locked-liquidity floor (V = 0). Full = the specified program. README and `JUDGES.md` show both.

## STOP and ask me when

- any P0 question fails, or a fallback would change the mechanism; any change to the mechanism or canon;
- any mainnet transaction or SOL spend; keys, a multisig signature, or funds; devnet SOL (state the exact amount);
- anything is ambiguous between the spec and observed on-chain behaviour (record the evidence first);
- a test could only pass by weakening an invariant, a rounding direction, or an account check;
- you are about to build anything on the §31 DO NOT BUILD list (governance, platform token, points,
  oracles, transfer hooks, lending, stock/USDC classes, reserve-share slider, dashboards beyond the
  verifier, mobile, analytics, AI features, config marketplace, compounding/market-cap-fee pools).
