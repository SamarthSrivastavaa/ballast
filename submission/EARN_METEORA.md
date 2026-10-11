# Superteam Earn — Meteora DBC sidetrack (paste-ready)

Submit once, final. Replace every ⟦FILL⟧ first.

**Project:** Ballast — Launch with a floor.

**One line:** A Meteora token launch whose worst case is computed on-chain before the first public trade, and verifiable by anyone.

**Links**
- Repo: https://github.com/SamarthSrivastavaa/ballast
- Demo video: ⟦FILL: YouTube link⟧
- Proof table: https://github.com/SamarthSrivastavaa/ballast#proof
- For judges: https://github.com/SamarthSrivastavaa/ballast/blob/main/JUDGES.md
- Live app: ⟦FILL: URL, or "runs locally: README, Token page"⟧
- X thread: ⟦FILL⟧

## 1. Depth of Meteora integration

All three Meteora products carry part of one invariant; remove any one and there is no floor.

- **DBC.** A launch class: the pool config is validated field by field on-chain before a class exists (`create_class`). The 15% migration fee is claimed by a program PDA into a program-owned vault. The pool-creator role is transferred to a Ballast PDA inside the pool-creation transaction, so the migrated creator position can never be split or withdrawn by a person. Instructions used: pool creation, `swap`, `transfer_pool_creator`, and by CPI `withdraw_migration_fee`, `claim_trading_fee`, `claim_creator_trading_fee`, `partner_withdraw_surplus`, `withdraw_leftover`. Migration is Meteora's own `migration_damm_v2`.
- **DAMM v2.** 85% of the raise migrates into a full-range pool as two permanently locked positions whose NFTs are held by program PDAs. Their liquidity is L in the floor equation. The program reads the pool and both positions on-chain and refuses to open the floor unless both are fully permanent. By CPI: `claim_position_fee`.
- **DLMM.** The whole vault rests as one limit order owned by a program PDA, in the highest bin at or below F. Fills are collected by cancelling, the bought tokens are burned, and the remainder is re-placed. By CPI: `place_limit_order`, `cancel_limit_order`, `close_limit_order_if_empty`, `go_to_a_bin`. The pair is created with `initialize_customizable_permissionless_lb_pair2` in the launch transaction.

Everything was built and tested against **Meteora's mainnet binaries**, dumped from mainnet and pinned by hash, never mocks. Things we learned only by executing them are written up in `docs/meteora.md`.

## 2. Technical execution

- One implementation of F: `crates/floor`, exact integers, called by the program, the verifier and the page (through WebAssembly).
- 34 tests and a 100,000-case property gate on that crate in CI; an independent Python integer reference agrees on 10,014 vectors, bit for bit.
- 12 instructions; 167 program tests on Meteora's mainnet binaries, one negative test per substituted account; a 10-million-step model fuzzer with no failure.
- The floor is recorded on-chain in the pool-creation transaction, before the first public trade, and every later instruction ends with a check that F did not fall.
- **Proof run (11 Oct):** predicted F 6.7019e-9; realised 6.7919e-9 (+1.34%); every holder token sold in 73 sells; worst fill 0.9984 × F with fees included; fills on the DLMM bid 0.9994 × F or better; F ended higher; the vault's ledger closes to the lamport.

## 3. Originality and taste

- The claim is falsifiable on purpose: "realised F ≥ predicted F, and F never falls."
- A public verifier that shares no code path with our app: `ballast verify <mint>`.
- `ballast check <pool>` measures the locked-liquidity floor under **any** Meteora DAMM v2 pool on mainnet, today.
- A public challenge with rules: `submission/BREAK_THE_FLOOR.md`.
- We say what it is not: late buyers can lose about 74%; F is in SOL; a sale straight into the DAMM v2 pool can execute below F.

## 4. Impact potential

Any DBC launchpad can offer it: one DBC config and one instruction (`docs/INTEGRATE.md`); the cranks are permissionless and the keeper is open source. We scanned the 100 newest DBC → DAMM v2 launches on mainnet on 8 Oct: 94 had no permanently locked liquidity at all.

## 5. Traction and volume

Stated plainly: ⟦FILL from `submission/TRACTION.md`: N independent verifications, M launch requests, K break attempts, with links⟧. Cluster: the full lifecycle runs on a local validator with Meteora's mainnet binaries; the program is deployed on devnet with no launch (devnet's DBC writes a config version the program refuses); ⟦FILL: "not on mainnet" or the mainnet mint and volume⟧.
