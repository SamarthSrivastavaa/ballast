# Colosseum — Solana track (paste-ready, field by field)

Cutoff shown in the portal: ⟦FILL: confirm; plan assumes Mon 12 Oct 21:00 IST⟧. Replace every ⟦FILL⟧.

**Project name:** Ballast

**One-liner:** A Meteora token launch whose worst case is computed on-chain before the first public trade, and verifiable by anyone.

**Problem**
If you buy a token at launch on Solana, nobody can tell you the worst that can happen to your money. Of the 100 newest tokens that graduated from Meteora's bonding curve on mainnet (8 Oct), 94 had no permanently locked liquidity at all. Creators who launch in good faith cannot prove it, so they are treated like the ones who do not.

**Solution**
At graduation, 85% of the raise migrates into DAMM v2 as two permanently locked, program-owned positions; the other 15%, the DBC migration fee, lands in a program vault and rests as one DLMM limit order in the highest bin at or below F; F is the price at which that locked liquidity plus that bid absorb the entire outstanding supply. We sold every token holders had, and the worst fill was 0.998 × F with fees included; `ballast verify` recomputes F from raw accounts, with no dependency on our app or API.

**Technical architecture**
- One Anchor program, 12 instructions. Accounts: `Global`, `Class` (one per validated DBC config), `Launch` (PDA of the mint), a vault PDA per launch, and two PDA authorities that hold the migrated DAMM v2 position NFTs and own the DLMM order.
- Meteora programs called: DBC (`withdraw_migration_fee`, fee claims, `withdraw_leftover`), DAMM v2 (`claim_position_fee`), DLMM (`place_limit_order`, `cancel_limit_order`, `go_to_a_bin`).
- `crates/floor`: the only implementation of F, exact integers; the program, the verifier CLI and the web page (via WebAssembly) all call it.
- `ballast verify`: re-derives the prediction, F, its history from program events and the vault's ledger from raw accounts.

**Why Solana, why now**
A floor like this needs three things at once: a migration fee to fund it (DBC), liquidity that can never be withdrawn (DAMM v2's permanent locks) and a resting order a program can own (DLMM limit orders). ⟦FILL: one sentence on when DLMM limit orders shipped, with a source, if you want to say "new this year"⟧. It also needs cheap transactions: a redemption is one atomic transaction (cancel, burn, pay, re-place) at about 206,000 compute units.

**Target user**
Creators who want to launch credibly, and launchpads that want a launch class with a verifiable floor. Buyers benefit.

**Go-to-market**
Launchpad integrations (one config, one instruction: `docs/INTEGRATE.md`); creator launch requests through a public form; the Superteam India community as first testers of the verifier.

**Demand validation**
⟦FILL from `submission/TRACTION.md`: real counts and links only⟧

**Business model**
The program sends 10% of the LP fees earned by its own locked position to a treasury; the other 90% goes into the vault and raises the floor. No token.

**Traction**
⟦FILL from `submission/TRACTION.md`⟧. Stage: working end to end on a local validator running Meteora's mainnet binaries; deployed on devnet (no launch there); ⟦FILL: not on mainnet / mainnet mint⟧.

**Team**
⟦FILL⟧

**Links**
- Repo: https://github.com/SamarthSrivastavaa/ballast
- Demo video: ⟦FILL⟧
- Pitch video: ⟦FILL⟧
- Live app: ⟦FILL⟧
- Proof table: https://github.com/SamarthSrivastavaa/ballast#proof
- X thread: ⟦FILL⟧
