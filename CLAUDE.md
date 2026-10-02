# Ballast — Agent Rules

## Mission

Ballast is one Anchor program that wraps a Meteora DBC launch class with an on-chain, executable
buyback floor **F**. At graduation, 15% of the raise is withdrawn as the DBC migration fee into a
program-owned vault; the other 85% migrates into a DAMM v2 pool as two permanently locked,
PDA-owned positions. The whole vault rests as one DLMM limit order in the highest bin at or below F.
F is the price at which locked liquidity plus the vault bid can absorb the entire outstanding supply,
so every holder token can be sold at ≥ F. The claim is falsifiable: the floor is predicted on-chain
before trade 1, and `ballast verify` recomputes it from raw accounts. Deadline 13 Oct 2026 06:59 UTC.

## Source of truth

- `docs/spec/BUILD_SPEC.md` is authoritative. `docs/spec/SUBMISSION.md` (if present) is demo/README copy only.
- **Read spec sections on demand. Never paste the whole spec into context.**
- Code, docs, or my own assumptions conflicting with the spec → the spec wins.
- Spec conflicting with observed on-chain behaviour → **STOP.** Record evidence in `DECISIONS.md`,
  propose the minimum correction, wait for approval.
- **Never invent Meteora behaviour.** Anything not verified by docs, program source, SDK, or a devnet
  transaction is UNKNOWN until tested. Never mock Meteora in integration tests: dumped programs or devnet only.

## P0 gate rule

**Nothing beyond test harnesses is built until Q1–Q5 pass on devnet.** No product code, no app, no
program logic past a CPI test harness. The floor crate and its Python reference are exempt (pure math,
no network). Q1 permanent lock · Q2 pool mode/range/constant L · Q3 L↔reserve mapping · Q4 PDA fee
claims via CPI · Q5 PDA DLMM limit orders via CPI.

## The floor equation (§4)

```
V/F + L_real·(1/√F − 1/√P_max) = S          L_real = L / 2^64
⟺  A·s² − B·s − C = 0      A = S + ⌈L/s_max⌉,  B = L,  C = V·2^128
```

`s = ⌊√F · 2^64⌋`. V = vault lamports + `launch.bid_quote_committed`. S = `base_mint.supply` −
PDA-held base. L = Σ `permanent_locked_liquidity` of the **two recorded positions only**.

Algorithm, identical in every implementation: (1) `D = B² + 4AC` in U256; (2) `s = ⌊(B + isqrt(D))/(2A)⌋`;
(3) correction loop — while `A·s² − B·s − C > 0`: `s -= 1`; while `A·(s+1)² − B·(s+1) − C ≤ 0`: `s += 1`;
(4) return s. Bounds asserted **before** arithmetic: `S ≤ 2^50`, `V ≤ 2^64 − 1`, `L < 2^120`,
`s_max < 2^97`. Out-of-range inputs return an error, never a value.

**Rounding is toward the protocol, everywhere:** `⌈L/s_max⌉` in A, `⌊root⌋` for s, `⌊·⌋` on payouts and
bid amounts, bid bin at or below F. No floating point anywhere in the crate.

### Code rules derived from the proof (§4)

1. Only `ballast-floor` computes F. The program, verifier, and app call it — never reimplement.
2. V, S, L are read from accounts inside the same instruction. Nothing is cached across instructions
   except `s_last` for the monotone check.
3. Every mutating instruction ends with `require!(s_new >= launch.s_last)` then sets `s_last = s_new`.
4. Redemption pays at s computed **after** settlement and **before** the burn; the post-state check must then pass.
5. Bounds asserts precede all arithmetic.

## The six corrections to the canon (§1) — non-negotiable

1. **Bounded range.** The equation carries the `−L·(1/√P_max)` term; L is permanent-only, DAMM Q64 units.
2. **Exact floor of the root** in integer arithmetic, so "F never falls" holds bit for bit across Rust, TS, verifier.
3. **Both migrated positions are PDA-owned.** DBC pool-creator role transfers to `creator_auth` before trade 1.
4. **Fills are collected only by cancelling.** "Settle" = cancel → burn → re-place. There is no claim endpoint.
5. **100% of the vault sits in the DLMM bid.** Redemption is atomic cancel → burn → pay → re-place.
6. **The prediction is a lower bound.** The claim is "realised F ≥ predicted F", with a declared upper tolerance.

## Banned wording (§21) — never in app/, README, docs, or events

`safe` · `insured` · `protected` · `can't lose` · `guaranteed profit` · "price can never go below F"

Required headline: "This is an executable buyback floor on Meteora, not a promise about prices elsewhere."
Always say which of the six prices (§9) a number is: theoretical F, bid bin price, executable bid net,
DAMM v2 price, DAMM v2 sell net, redemption. Late buyers can lose ~74% — say so.

## Repo layout (§15)

```
programs/ballast/        Anchor program (all on-chain logic)          CRITICAL
crates/floor/            ballast-floor (no_std) + vectors.json        CRITICAL
crates/meteora-types/    vendored zero-copy layouts + offset tests    CRITICAL
crates/verifier-core/    account fetch + checks                       CRITICAL
verifier/                CLI binary `ballast`                         CRITICAL
sdk/typescript/          instruction builders, PDAs, floor-wasm wrapper
compiler/                emits ConfigParameters + predicted s per size
keeper/                  crank loop (TS; liveness only, permissionless)
app/                     one token page + launch form
tests/{unit,integration,fuzz,devnet,mainnet,reference}/
scripts/{deploy,initialize,proof,public-launch}/
docs/{architecture,mechanism,math,security,meteora,verifier,proof,operations,limitations}.md
fixtures/                dumped Meteora .so + cloned accounts (gitignored; hashes committed)
```

## Toolchain pins (§16) — verify each before relying on it

Rust 1.84 stable (`rust-toolchain.toml`) · Agave/Solana CLI 2.1.x · Anchor 0.31.1 (via `avm`) ·
Node 20 LTS · pnpm 9 (workspaces) · TypeScript 5.6 · `@solana/web3.js` 1.98.x · `@solana/spl-token` 0.4.x ·
`@coral-xyz/anchor` 0.31.1 · `@meteora-ag/dynamic-bonding-curve-sdk` ≥1.5.11 · `@meteora-ag/cp-amm-sdk` 1.4.8 ·
`@meteora-ag/dlmm` 1.9.10 · `ruint` (no_std), `bytemuck`, `proptest`, `solana-client` 2.1 · `wasm-pack`/`wasm-bindgen` ·
Vite + React 18 + wallet-adapter · rustfmt, clippy `-D warnings`, eslint, prettier.

**The installed toolchain does not match these pins** — see `DECISIONS.md` § Toolchain. Do not assume a pin
is in place; confirm it and record the final pins in `DECISIONS.md`.

## Build and test commands

```bash
cargo test -p ballast-floor -p meteora-types   # pure math + layouts (no network)
cargo test -p verifier-core
cargo fmt --check && cargo clippy -- -D warnings
pnpm fixtures:dump                             # dump Meteora .so + accounts from mainnet
anchor build                                   # anchor build --verifiable for mainnet
anchor test                                    # local validator, real DBC/DAMM v2/DLMM
pnpm -F sdk test; pnpm -F compiler test; pnpm -F keeper test; pnpm -F app build
python tests/reference/floor.py                # independent integer reference
ballast verify <launch> --rpc <url>            # verifier
```

## Working style

- **Plan mode for every new slice.** Tests before implementation. Full test suite before "done".
- One commit per slice, citing the spec section. Tag every passed gate (`gate-1-pass`, …).
- **Update `STATUS.md` and `DECISIONS.md` at the end of every task.** Evidence goes in `evidence/`.
- A Top-20 question is VERIFIED only with a devnet transaction signature recorded in `DECISIONS.md`.
- After each step report: what changed → evidence (tests, signatures) → next → open risks.
- Parallel work only after the P0 gates pass, and only in a separate git worktree. Never two sessions
  on `programs/ballast`.

## STOP and ask me when

- any P0 question fails, or a fallback would change the mechanism;
- you need funds, keys, a multisig signature, or any mainnet action;
- a test could only pass by weakening an invariant, a rounding direction, or an account check;
- you are about to build anything on the §31 DO NOT BUILD list (governance, platform token, points,
  oracles, transfer hooks, lending, stock/USDC classes, reserve-share slider, dashboards beyond the
  verifier, mobile, analytics, AI features, config marketplace, compounding/market-cap-fee pools).
