# Ballast — Build Spec & Ceiling Implementation Plan

Oct 1, 2026 · @Samarth

## Top 20 implementation-blocking questions

**Five P0 questions can invalidate the mechanism; all five are answerable on devnet in the first 24 hours, and no program code beyond a CPI test harness should be written until they pass.** P0 = could invalidate the mechanism; P1 = could invalidate a subsystem; P2 = implementation detail.

| # | Pri | Question | Why it matters | Exact verification | Expected | Fallback if wrong |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | P0 | Does one `migration_damm_v2` transaction leave the partner and creator positions with all liquidity in `permanent_locked_liquidity` (unlocked = 0, vested = 0)? | L must be unwithdrawable from its first slot | Devnet config: partner/creator permanent = 50/50, all other LP and vesting 0. Fill curve, migrate. In the same slot, fetch both `Position` accounts; assert fields; list inner instructions of the migration tx | Atomic, fully permanent | Make Ballast's PDA the DBC pool creator before trade 1 (Q7), so no third party ever owns an unlocked position; lock in `open` if needed |
| 2 | P0 | Is the migrated pool `collect_fee_mode = 1` (OnlyB), non-compounding, full range (`sqrt_min_price` = MIN, `sqrt_max_price` = MAX), and do swaps and fee claims leave `pool.liquidity` and position liquidity unchanged? | The floor engine assumes constant L | Read pool after migration; run 20 swaps each way and two fee claims; diff `liquidity`, `sqrt_min_price`, `sqrt_max_price`, positions | All unchanged; full range | If a range: engine already takes `sqrt_min/max` as inputs. If compounding is forced: switch to reserve-based absorption (section 4) |
| 3 | P0 | Does pool state satisfy amount\_A = L·(s\_max − s)/(s·s\_max) and amount\_B = L·(s − s\_min)/2¹²⁸ with Q64 sqrt prices? | The mapping from DAMM state to L is the whole floor | After migration, compare `token_a_amount`/`token_b_amount` (layout v1) or vault balances minus unclaimed fees with the formula from `pool.liquidity` and `sqrt_price` | Equal within ≤ 2 base units | Use reserves directly: absorption to F = x\_now + L·(1/√F − 1/√P\_now), computed from read reserves |
| 4 | P0 | Can a Ballast PDA, as `fee_claimer`, CPI `withdraw_migration_fee` (partner), `claim_trading_fee`, `partner_withdraw_surplus`; what destination accounts are allowed? | Vault funding depends on it | Minimal Anchor harness on devnet; call each via `invoke_signed`. Meteora's Dynamic Fee Sharing program already does this as a PDA ([instructions](https://docs.meteora.ag/developer-guides/dynamic-fee-sharing/program/instructions)) | Works; destinations are token accounts owned by the fee claimer | Disclosed hot-wallet fee claimer that forwards in the same transaction |
| 5 | P0 | Can the PDA CPI DLMM `place_limit_order` (sender = owner = PDA, fresh keypair order account signing from the outer tx) and `cancel_limit_order`; do fills stay filled; does cancel return unfilled quote + filled base + fees? | Executable floor and burn-on-fill | Devnet LimitOrder pair; place via harness; swap through it; cancel; reconcile balances | Yes on all counts (cancel behaviour per [Invent docs](https://github.com/MeteoraAg/meteora-invent)) | Redemption-only floor; DLMM marked unverified in the submission (major regression; escalate to Meteora) |
| 6 | P1 | Who owns the partner position NFT after migration (`fee_claimer`?), and can the PDA call `claim_position_fee` on it? | Fee ratchet | Inspect NFT holder after Q1 migration; CPI claim | Owner = fee claimer | Floor math unaffected; ratchet off |
| 7 | P1 | Can the creator `split_position` (or otherwise move) permanently locked liquidity into new positions? | Reading recorded positions would under-count L and stall F | Devnet: split the creator position with a permanent-lock percentage; observe | Likely yes (owner-only endpoint) | **Default:** transfer the DBC pool-creator role to a Ballast creator PDA at registration, so both positions are PDA-owned; forward creator income |
| 8 | P1 | DLMM customizable permissionless pair: seeds, uniqueness, creator/operator powers (pool status), and can the PDA create it via CPI? | Front-running or disabling the floor market | Read SDK `createCustomizablePermissionlessLbPair2`; devnet attempt via CPI and top level; check who can call set-pool-status | Pair unique per (mints, bin step); no post-activation creator powers | Create the pair in the same transaction as the DBC pool; accept any pair passing parameter checks |
| 9 | P1 | DLMM limits: allowed bin steps and base fee, activation, collect-fee mode, minimum order size, ≤ 50 bins, bitmap-extension needs around bin ids −11,000 to −12,000 | Placement must succeed far below the active bin | SDK constants + devnet placement at those ids | Feasible with bitmap extension | Larger bin step (25 bps) |
| 10 | P1 | Does Jupiter route to the fresh DLMM pair and DAMM v2 pool, and how fast? | Router-visible floor | Jupiter quote API for the mint, polled after creation | Within hours | Demo shows direct DLMM swaps and redemption |
| 11 | P1 | Is the DBC base mint's freeze authority `None`? | A freeze authority could trap holders | `getMint` on the devnet launch | None | Document as Meteora trust |
| 12 | P1 | Exact `PoolConfig` / `VirtualPool` layouts for the deployed DBC version; enum encodings (`migration_fee_option` customizable, `collect_fee_mode`, `token_type`) | On-chain config validation | Decode a fresh config with the SDK and with vendored structs; byte-compare; check discriminators and owner | Match | Validate by hash of canonical bytes |
| 13 | P1 | Fee semantics: flat 1% encoding, dynamic fee off, `creator_trading_fee_percentage`, protocol and referral cuts; partner claim = partner share exactly | Vault and creator accounting | Devnet swaps + claims, reconcile to the lamport | Matches docs | Adjust ledger |
| 14 | P1 | Migration accounting: fee on threshold or reserve? How is the 0.2% protocol liquidity share taken (protocol LP remainder vs tokens)? Exact Q\_d, B\_m, L\_total vs L\_perm | Prediction accuracy | Reconcile after Q1 migration | Protocol remainder is an unlocked position, excluded from L | Prediction stays a lower bound with margin |
| 15 | P1 | Overshoot: can the completing swap exceed the threshold; when is partner surplus withdrawable; `swap2` partial-fill behaviour | Prediction and settlement | Devnet: overshoot by 3% | Surplus exists; withdrawable after completion | Ignore surplus in prediction (it only raises F) |
| 16 | P2 | Is `withdraw_leftover` permissionless, to `leftover_receiver`'s token account, only after `CreatedPool`? | Supply denominator | Devnet call from a third wallet | Yes | Keeper calls it |
| 17 | P2 | Meteora keeper latency for 10 SOL pools; manual migration via SDK | Handoff window | Measure on devnet/mainnet | Seconds to minutes | Ballast keeper migrates |
| 18 | P2 | Compute units and accounts for `open` and an atomic `redeem` (cancel + burn + pay + re-place) | Feasibility of atomic redemption | Simulate on devnet; read CU logs | < 1.4M CU with a lookup table | Split into `redeem` + `refresh_floor` with a minimum size |
| 19 | P2 | Meteora admin powers: DAMM v2 `update_pool_fees`, pool status, DLMM pool status, upgrade authorities | Trust disclosure | Read IDLs and changelogs; operators can update fees on existing DAMM v2 pools ([changelog](https://docs.meteora.ag/developer-guides/damm-v2/changelog)) | Fees and status adjustable by operators; locked liquidity untouchable | Disclose |
| 20 | P2 | WSOL handling across DBC, DAMM v2 and DLMM (SPL WSOL only; Token-2022 WSOL rejected) | Payout plumbing | Devnet transfers and unwraps | SPL WSOL everywhere | — |

## 1. Executive Implementation Verdict

**Ballast is buildable as specified, but only after six corrections to the canon and a 24-hour devnet gate on five P0 questions.** The mechanism, invariant and configuration survive; what changes is how they map onto the real Meteora programs.

**Six corrections:**

1. **Exact floor equation.** The migrated DAMM v2 pool is a bounded-range pool, so the equation is V/F + L·(1/√F − 1/√P\_max) = S, with L = permanently locked liquidity only, in DAMM's Q64 units. The correction is conservative and numerically tiny, but the code must use it.
2. **Floor computed as the exact floor of the root** in integer arithmetic, so "F never falls" holds bit for bit across Rust, TypeScript and the verifier.
3. **Both migrated positions must be owned by Ballast PDAs.** The DBC pool-creator role is transferred to a per-launch Ballast creator PDA before trade 1, because a creator-owned position can likely be split, which would let a creator stall the reported floor. Creator income is forwarded by Ballast.
4. **Fills are collected only by cancelling the limit order** (cancel returns unfilled quote, filled base and fees, then closes the order). "Settle" therefore means cancel → burn → re-place.
5. **All of the vault sits in the DLMM bid.** With an 80/20 bid/reserve split, a router-only seller at the end of a total liquidation can execute at 0.87·F; with 100%, the router path holds at \~0.999·F. Redemption becomes an atomic cancel → burn → pay → re-place.
6. **The prediction is a lower bound.** Bonding fees, surplus and the protocol's liquidity share can only raise F, so the claim is "realised F ≥ predicted F", with a declared upper tolerance.

**Gate:** nothing past a CPI test harness is built until questions 1–5 pass on devnet.

## 2. Technical Truth Audit

**Twenty-one assumptions are verified from Meteora docs or source-derived decoders, six are likely, seven are unknown until devnet, and six statements in the earlier tabs are incorrect as written.** Experiments for every UNKNOWN are in the Top 20 table; the right-hand column says what each result decides.

| Assumption | Status | Evidence or experiment | Decision it drives |
| --- | --- | --- | --- |
| Program IDs: DBC `dbcij3…MaqN`, DAMM v2 `cpamdp…sGG`, DLMM `LBUZKh…wxo`, identical on devnet | VERIFIED | Meteora docs | Constants |
| `PoolConfig` holds `fee_claimer`, `leftover_receiver`, partner/creator permanent-lock %, `migration_fee_percentage`, `creator_migration_fee_percentage` | VERIFIED | [DBC accounts](https://docs.meteora.ag/developer-guides/dbc/program/accounts), Codama decoder | Validator fields |
| On-chain curve capacity 20 points; fee denominator 1e9 | VERIFIED | DBC accounts page | Compiler limits |
| Migration is permissionless; trading stops at completion (`PoolIsCompleted`) | VERIFIED | [DBC migration](https://docs.meteora.ag/overview/products/dbc/migration.md) | Handoff state |
| Migration distributes LP to partner, creator and a protocol remainder | VERIFIED | Same | L counts only permanent partner + creator |
| Leftover = pre-migration supply − swap base − post-migration supply, to `leftover_receiver` | VERIFIED | Same | Supply accounting |
| Migration fee taken from migrated quote reserves, split partner/creator, withdrawn via `withdraw_migration_fee` | VERIFIED | Same | Vault funding |
| New configs must migrate to DAMM v2 | VERIFIED | Same | — |
| DBC migration via CPI is "advanced; prefer top-level" | VERIFIED | [DBC CPI](https://docs.meteora.ag/developer-guides/dbc/rust-integration/cpi) | Keeper migrates top-level; Ballast never CPIs migration |
| DAMM v2: Δa = ΔL·(1/√P − 1/√P\_max), Δb = ΔL·(√P − √P\_min); token B = L·(s − s\_min)/2¹²⁸ | VERIFIED | [DAMM v2 formulas](https://docs.meteora.ag/overview/products/damm-v2/damm-v2-formulas) | L units (Q64) |
| Permanently locked liquidity is never withdrawable and still earns fees; per-position field | VERIFIED | DAMM v2 docs | L source |
| "Withdraw dead liquidity" applies to compounding pools only | VERIFIED | [DAMM v2 changelog](https://docs.meteora.ag/developer-guides/damm-v2/changelog) | Non-compounding pool unaffected |
| Operators can update fees on existing DAMM v2 pools | VERIFIED | Same | Trust disclosure |
| Position delegates exist; split/close are owner-only | VERIFIED | Same | PDA ownership blocks both |
| Fee-mode enums: DBC 0 = quote, 1 = output; DAMM v2 0 = both, 1 = OnlyB, 2 = compounding | VERIFIED | [DBC pool configuration](https://docs.meteora.ag/overview/products/dbc/pool-configuration) | Config values |
| Non-hook DBC mints have mint authority revoked | VERIFIED | DBC changelog | S cannot grow |
| DLMM limit orders only on LimitOrder pairs; ≤ 50 bins; order account is a fresh keypair; event has separate sender and owner | VERIFIED | DLMM docs, SDK examples, events page | Order plumbing |
| Cancelling returns unfilled deposits, filled proceeds and fees, then closes the account | VERIFIED | [Invent](https://github.com/MeteoraAg/meteora-invent) | Settle = cancel |
| DLMM limit orders fillable by Jupiter and Titan | VERIFIED (secondary source) | Launch coverage | Router-visible floor |
| A PDA can sign DBC partner claims and DAMM v2 fee claims | VERIFIED in principle | Meteora Dynamic Fee Sharing does it | CPI design |
| Prices are Q64.64 sqrt prices; DAMM max sqrt price 79226673521066979257578248091 | VERIFIED | Docs; public validator repo | Engine constant (re-read from pool) |
| Migrated pool full range, OnlyB, non-compounding when configured | LIKELY | Config maps `migrated_collect_fee_mode`; no range field | Q2 |
| Partner NFT goes to `fee_claimer` | LIKELY | Docs say "partner owner" | Q6 |
| `withdraw_leftover` permissionless | LIKELY | Docs | Q16 |
| Freeze authority `None` | LIKELY | — | Q11 |
| Jupiter indexes new pools quickly | LIKELY | — | Q10 |
| Meteora keeper migrates ≥ 10 SOL pools | LIKELY | DBC developer guide | Q17 |
| Permanent lock applied atomically inside migration | UNKNOWN | Q1 | Creator-PDA default either way |
| Creator can split permanent liquidity | UNKNOWN | Q7 | Creator-PDA default |
| PDA can own and cancel DLMM limit orders via CPI | UNKNOWN | Q5 | Entire DLMM layer |
| DLMM pair creator powers and uniqueness | UNKNOWN | Q8 | Pair creation timing |
| Minimum order size; usable bin steps | UNKNOWN | Q9 | Bin step |
| CU for atomic redeem | UNKNOWN | Q18 | Atomic vs two-step redeem |
| Migration-fee basis and protocol share | UNKNOWN | Q14 | Prediction margin |
| "V/F + L/√F = S" exactly | **INCORRECT (minor)** | Pool has finite P\_max; L must be permanent-only, Q64 units | Engine uses the corrected form |
| "`settle_floor` claims fills" | **INCORRECT** | No claim endpoint; only cancel collects | Settle = cancel → burn → re-place |
| "Up to 20% of the vault in bids; rest for redemption" | **INCORRECT for the claim** | Router-only tail executes at 0.87·F in total liquidation (section 13) | 100% in bids; atomic redeem |
| "Creator half of LP owned by the creator" | **INCORRECT by default** | Likely splittable (Q7) | Creator role → Ballast creator PDA |
| "Prediction equals realised F" | **INCORRECT** | Fees, surplus and protocol share add backing | Prediction is a lower bound |
| "Bids at F" | **INCORRECT as stated** | F is not a bin price | Highest bin ≤ F (within one bin step) |

## 3. Canonical Architecture

`[D-008: two tiers, one mechanism — Lite = DBC config only (flat 1% fee, 100% permanently locked LP split partner/creator, migration fee 0, no Ballast program, V = 0); Full = everything below]`

**One Anchor program, three Meteora programs it composes but never migrates through, one floor crate shared by every consumer, and four off-chain tools.**

| Layer | Component | Responsibility | Trust |
| --- | --- | --- | --- |
| On-chain | `ballast` program | Class verification, launch registry, prediction record, vault, floor computation, bids, redemption, burns, fee routing | Upgradeable until frozen (section 19) |
| On-chain | Meteora DBC | Curve, fees, graduation, migration fee, leftover | Meteora |
| On-chain | Meteora DAMM v2 | Migrated pool; two PDA-owned permanently locked positions | Meteora |
| On-chain | Meteora DLMM | LimitOrder pair; one PDA-owned single-bin bid | Meteora |
| On-chain | SPL Token / ATA | WSOL and base mint accounts, burns | Solana |
| Shared | `ballast-floor` crate | The only implementation of F (no\_std Rust; compiled to WASM for TypeScript) | Pure math |
| Off-chain | Compiler | Emits the canonical DBC `ConfigParameters` and the predicted floor | Deterministic, checked on-chain |
| Off-chain | Keeper | Migration fallback, settlement, leftover burn, `open`, `refresh_floor`, `harvest` | Liveness only; every call permissionless |
| Off-chain | Verifier CLI | Recomputes F from raw mainnet accounts, independent of the app | None |
| Off-chain | App | One token page and a narrow launch form | Display only |

### Authority map

| PDA | Seeds | Holds / does |
| --- | --- | --- |
| `global` | `["global"]` | Admin (multisig), treasury, class-creation switch |
| `class` | `["class", dbc_config]` | Verified config record and prediction parameters |
| `partner_auth` | `["partner", dbc_config]` | DBC `fee_claimer` and `leftover_receiver`; owner of the partner position NFT, staging accounts and DLMM orders |
| `creator_auth` | `["creator", launch]` | DBC pool creator after registration; owner of the creator position NFT; receives creator fees for forwarding |
| `launch` | `["launch", base_mint]` | Lifecycle state, prediction, floor record, addresses |
| `vault` | `["vault", launch]` | WSOL token account, authority `partner_auth` |

### Flow in one line

Compiler → `create_class` → DBC pool creation + `register_launch` (prediction recorded, creator role transferred) → trading → completion → `settle_graduation` → migration (top-level, any keeper) → `burn_leftover` → `open` (positions recorded, F computed, bid placed) → swaps, fills, `refresh_floor`, `harvest`, `redeem` → verifier.

## 4. Mathematical Specification

**F is defined as the floor of the root of an integer quadratic in Q64 sqrt-price units; every allowed transition provably moves the root right, so the computed value can never fall, bit for bit.**

### Variables and units

| Symbol | Type | Unit | Source |
| --- | --- | --- | --- |
| V | u64 | lamports | `vault` balance + `launch.bid_quote_committed` |
| S | u64 | base units (1 token = 10⁶) | `base_mint.supply` − PDA-held base balance |
| L | u128 | DAMM v2 liquidity (Q64-scaled) | Sum of `permanent_locked_liquidity` of the two recorded positions |
| s\_max | u128 | Q64.64 sqrt price | `pool.sqrt_max_price` |
| s | u128 | Q64.64 sqrt of F (lamports per base unit) | Output |
| F\_raw | rational | lamports per base unit | s² / 2¹²⁸ |
| F (display) | decimal | SOL per token | F\_raw × 10⁶ / 10⁹ |

### Derivation

At price F, the locked liquidity holds L\_real·(1/√F − 1/√P\_max) base tokens in total, where L\_real = L / 2⁶⁴ (from Δb = L·(s − s\_min)/2¹²⁸). Vault bids at prices ≤ F absorb at least V/F more. F is the price at which these capacities cover the entire supply:

```latex
\frac{V}{F} + L_{\text{real}}\Big(\frac{1}{\sqrt{F}} - \frac{1}{\sqrt{P_{\max}}}\Big) = S
\;\;\Longleftrightarrow\;\;
A s^2 - B s - C = 0,\quad A = S + \lceil L / s_{\max} \rceil,\; B = L,\; C = V \cdot 2^{128}
```

**Why it is a floor:** holders own S − x\_now tokens. Selling into the pool moves its price down to F while it absorbs x(F) − x\_now tokens; bids then absorb ≥ V/F. Their sum is ≥ S − x\_now, so every holder token can be sold at ≥ F (pool) or at the bid price b ≤ F, within one bin step, before taker fees.

### Algorithm (identical in every implementation)

1. D = B² + 4AC in U256.
2. s = ⌊(B + isqrt(D)) / (2A)⌋.
3. While A·s² − B·s − C > 0: s −= 1. While A·(s+1)² − B·(s+1) − C ≤ 0: s += 1.
4. Return s, which is exactly ⌊root⌋.

### Bounds

Assert at entry: S ≤ 2⁵⁰, V ≤ 2⁶⁴ − 1, **L ≤ 2¹²⁰** `[D-003: was L < 2¹²⁰; made inclusive so §27's "L = 2¹²⁰" boundary vector is computable]`, s\_max < 2⁹⁷. Then B² ≤ 2²⁴⁰, D = B² + 4AC < 2²⁴⁶, A·s² < 2²⁴⁵ — all inside U256. Out-of-range inputs return an error, never a value.

### Rounding

Towards the protocol, everywhere: ⌈L/s\_max⌉ in A, ⌊root⌋ for s, ⌊·⌋ on payouts and bid amounts, bid bin at or below F. Display error |F\_true − F| / F < 3·2⁻⁵⁴ at launch-scale inputs.

### Monotonicity proof (per transition)

Let P(s) = A s² − B s − C, so s = max{s : P(s) ≤ 0}. A transition is safe iff the new polynomial P′ satisfies P′(s\_old) ≤ 0.

| Transition | Change | P′(s\_old) − P(s\_old) | Safe because |
| --- | --- | --- | --- |
| Redeem T, payout p ≤ T·s²·(1 − φ)/2¹²⁸ | A −= T, C −= p·2¹²⁸ | ≤ −φ·T·s² | φ ≥ 0, payout floored |
| Bid fill T at price b ≤ s²/2¹²⁸ | A −= T, C −= b·T·2¹²⁸ | ≤ 0 | b ≤ F |
| Harvest or deposit Δ | C += Δ·2¹²⁸ | −Δ·2¹²⁸ | Δ ≥ 0 |
| Leftover or filled-base burn T | A −= T | −T·s² | Burn |
| Place / cancel bid (no fill) | V moves between vault and committed | 0 | V counts both |
| Swap on DAMM v2 or DLMM | none | 0 | Non-compounding, quote-only fees |
| L change | Impossible (permanent lock, PDA-owned positions) | — | — |
| S increase | Impossible (mint authority revoked) | — | — |

**Unsettled fills:** while a fill is not yet settled, the measured (A, C) overstate both supply and quote; the true polynomial is lower at s\_old, so the true floor is above the reported one. Settling makes measurement exact and the reported s can only rise.

### Conservation bound

At `open`, with no deposits: in a total liquidation at F, holders receive ≥ F·S\_c, funded only by the raise (vault plus quote released by the locked pool). Hence F\_open·S\_c ≤ Q, i.e. **F\_open ≤ Q/S\_c = average entry price.** After `open`, harvested fees Φ and deposits D are quote that did not come from holders; the bound becomes F ≤ (Q + Φ + D)/S\_c and no longer caps F at the average entry.

### Code rules derived from the proof

1. Only `ballast-floor` computes F; the program, verifier and app call it.
2. V, S and L are read from accounts inside the same instruction; nothing is cached across instructions except `s_last` for the monotone check.
3. Every mutating instruction ends with `require!(s_new >= launch.s_last)` then sets `s_last = s_new`.
4. Redemption pays at s computed after settlement and before the burn; the post-state check then must pass.
5. Bounds asserts precede all arithmetic.

## 5. On-Chain State Model

**Six launch states, each entered by exactly one instruction and each idempotent to re-entry; Meteora state is observed, never assumed.**

### Launch lifecycle

| State | Entered by | Requires (observed on-chain) | Allows next |
| --- | --- | --- | --- |
| `Registered` | `register_launch` | DBC pool from a Ballast class; `quote_reserve == 0`; pool creator transferred to `creator_auth` in the same tx | Trading (DBC); `settle_graduation` once complete |
| `Funded` | `settle_graduation` | Curve complete (`quote_reserve ≥ migration_quote_threshold`) | Migration (top-level, anyone) |
| `Migrated` | first instruction to observe `migration_progress == CreatedPool` (inside `burn_leftover`) | DAMM v2 pool exists | `burn_leftover` |
| `Cleaned` | `burn_leftover` | Leftover withdrawn and burned; partner surplus pulled | `open` |
| `Open` | `open` | Both positions recorded and verified permanent; F computed; bid placed | `refresh_floor`, `settle_floor`, `harvest`, `redeem`, `deposit` |
| (terminal) | — | — | `Open` never exits; the floor is permanent |

If migration happens before `settle_graduation` (keeper lag), `settle_graduation` still runs from `Registered` and the state machine jumps forward; migration-fee withdrawal is valid any time after completion.

### Accounts

| Account | Seeds | Owner | Fields (bytes) | Lifecycle |
| --- | --- | --- | --- | --- |
| `Global` | `["global"]` | Ballast | admin 32, treasury 32, class\_creation\_enabled 1, version 1, bump 1, reserved 64 (≈139) | Init once; admin is a multisig |
| `Class` | `["class", dbc_config]` | Ballast | dbc\_config 32, quote\_mint 32, config\_hash 32, size\_tag 1, partner\_auth\_bump 1, migration\_threshold 8, predicted\_s\_open u128 16, bid\_bin\_step 2, redeem\_fee\_bps 2, harvest\_treasury\_bps 2, vault\_cap 8, launches 4, bump 1, reserved 64 (≈213) | Created by admin after on-chain validation; immutable afterwards |
| `Launch` | `["launch", base_mint]` | Ballast | class, dbc\_pool, base\_mint, creator\_beneficiary (4×32); state 1; bumps 2; predicted\_s 16; registered\_slot 8; damm\_pool, partner\_position, creator\_position, partner\_nft\_account, creator\_nft\_account, dlmm\_pair, bid\_order (7×32); bid\_bin\_id 4; bid\_quote\_committed 8; s\_open 16; s\_last 16; counters: burned, redeemed\_tokens, redeemed\_lamports, harvested, deposited, filled\_tokens, creator\_forwarded, treasury\_fees, open\_slot (9×8); reserved 128 (≈640) | Never closed: it is the public proof record |
| `vault` | `["vault", launch]` | SPL Token | WSOL token account, authority `partner_auth` | Never closed |
| `partner_auth` | `["partner", dbc_config]` | System (no data) | Holds lamports for order rent | Kept funded by keeper |
| `creator_auth` | `["creator", launch]` | System (no data) | — | — |
| Staging accounts | ATAs of `partner_auth` (WSOL, base mint) and `creator_auth` (WSOL) | SPL Token | Transit only; zero balance at the end of every instruction | Never closed |

### Account-substitution rules (applied in every instruction)

1. Every Meteora account: owner == expected program ID, Anchor discriminator matches, and the address is either recorded in `Launch` or re-derived (e.g. DAMM position = PDA `["position", nft_mint]` under DAMM v2).
2. Cross-links: `virtual_pool.config == class.dbc_config`, `virtual_pool.base_mint == launch.base_mint`, `damm_pool.token_a_mint == base_mint`, `damm_pool.token_b_mint == WSOL`, `position.pool == launch.damm_pool`, `dlmm_pair` mints and bin step match `Class`, `limit_order.owner == partner_auth`.
3. Token accounts: mint and authority checked; never accept a caller-supplied "vault".
4. Program accounts passed for CPI are compared to hard-coded IDs.

## 6. Instruction-by-Instruction Specification

**Eleven instructions; only two need a privileged signer (admin for `initialize_global` and `create_class`), one needs the launching creator, and everything after registration is permissionless.** Accounts: (w) writable, (s) signer, all others read-only. Every mutating instruction after `open` ends with the floor check from section 4.

### `initialize_global(admin, treasury)`

- **Signers:** deployer. **Accounts:** `global` (w, init), system program.
- **Effect:** stores admin (the multisig) and the treasury WSOL account; `class_creation_enabled = true`.
- **Errors:** already initialised. **Event:** `GlobalInitialized`. **Re-entry:** `init` fails on second call.

### `create_class(size_tag, params)`

- **Signers:** admin. **Accounts:** `global`, `class` (w, init), `dbc_config` (DBC-owned `PoolConfig`), WSOL mint.
- **Preconditions:** `dbc_config.fee_claimer == partner_auth`, `leftover_receiver == partner_auth`, and every rule in section 7 passes.
- **Effect:** computes `config_hash` over the validated fields and `predicted_s_open` (lower bound, section 7) with `ballast-floor`; stores bin step, fees, cap.
- **Errors:** any validation rule fails (one error code per rule). **Event:** `ClassCreated{config, predicted_s_open, hash}`.

### `register_launch(creator_beneficiary)`

- **Signers:** creator (current DBC pool creator), payer. **Accounts:** `class`, `launch` (w, init), `virtual_pool` (DBC), `base_mint`, `creator_auth`, `vault` (w, init), DLMM pair (w; created in the same tx, see section 9), DBC program, event authority.
- **Preconditions** `[D-011: the `quote_reserve == 0` test is REMOVED — the launch transaction's own dust buy makes it false by design (Q8: DLMM will not create a pair unless the funder holds ≥ 1 base unit). Replaced by instruction-sysvar introspection]`**:** `virtual_pool.config == class.dbc_config`; and by introspection over this transaction: (a) it contains the DBC pool-creation instruction for this pool **and** the DLMM pair creation for `(base_mint, WSOL)` with the class parameters including the class bin step; (b) the only DBC swap before `register_launch` in this transaction is by the payer and is ≤ the class dust limit; (c) `virtual_pool.creator == creator_auth` after the `transfer_pool_creator` in the same transaction.
- **Effect:** records the prediction (`predicted_s = class.predicted_s_open`), `registered_slot`, beneficiary, pair address. No funds move.
- **Errors:** wrong config; pool already traded; creator not transferred; pair parameters invalid. **Event:** `LaunchRegistered{mint, predicted_s, slot}` — the on-chain prediction, recorded in the pool-creation transaction, before any third-party trade `[D-011: was "before trade 1"; the payer's own dust buy precedes it in the same transaction]`.
- **Re-entry:** `init` on `launch`.

### `settle_graduation()`

- **Signers:** any payer. **Accounts:** `launch` (w), `class`, `virtual_pool`, DBC quote vault, `partner_auth`, WSOL staging ATA (w), `vault` (w), `creator_auth` + its WSOL ATA (w), creator beneficiary WSOL ATA (w), DBC program + event authority.
- **Preconditions:** curve complete; state `Registered`.
- **CPI:** `withdraw_migration_fee` (partner flag; signer `partner_auth`), `claim_trading_fee` (partner; max amounts), `claim_creator_trading_fee` (signer `creator_auth`).
- **Effect:** partner flows → staging → `vault`; creator trading fees → beneficiary. Amounts measured as balance deltas. State → `Funded`. `[D-016: no WSOL staging and no creator_auth WSOL ATA — the partner flows go straight to the vault and the creator's quote fees straight to ATA(creator_beneficiary, WSOL), which register_launch requires to be an outside account; the only staging account is partner_auth's base ATA, whose partner-claim delta is burned; a creator base fee fails closed]`
- **Errors:** curve not complete; already settled (status bitmask). **Event:** `GraduationSettled{migration_fee, partner_fees, creator_fees}`.
- **Re-entry:** DBC's withdraw bitmask makes a repeat a no-op; Ballast checks state first.

### `burn_leftover()`

- **Signers:** any payer. **Accounts:** `launch` (w), `virtual_pool`, DBC base vault, `partner_auth` base ATA (w), `base_mint` (w), WSOL staging, `vault` (w), DBC program.
- **Preconditions:** `migration_progress == CreatedPool`; state `Funded` or `Registered` (late settle runs first). `[D-016: state Funded only — a lagging keeper sends settle_graduation first, same transaction allowed. If a third party already ran DBC's permissionless withdraw_leftover (it can pay only partner_auth's ATA), the CPI is skipped and the whole ATA balance is burned and recorded]`
- **CPI:** `withdraw_leftover` (to `partner_auth` ATA), `partner_withdraw_surplus`; SPL `burn` signed by `partner_auth`.
- **Effect:** leftover burned (S falls); surplus → vault. State → `Cleaned`. **Event:** `LeftoverBurned{amount, surplus}`.

### `open(bin_id_hint)`

- **Signers:** any payer; fresh limit-order keypair. **Accounts:** `launch` (w), `class`, DAMM `pool`, partner and creator `position`s + NFT accounts, `base_mint`, `vault` (w), DLMM pair (w), bin arrays (w), bitmap extension, order account (w, s), DLMM program, event authority.
- **Preconditions:** state `Cleaned`; both positions: `pool == damm_pool`, owner/NFT holder ∈ {`partner_auth`, `creator_auth`}, `unlocked_liquidity == 0`, `vested_liquidity == 0`, `permanent_locked_liquidity > 0`; pool `collect_fee_mode == 1`, non-compounding.
- **Effect:** records positions; computes `s_open`; requires `s_open ≥ predicted_s`; verifies `price(bin_id_hint) ≤ F < price(bin_id_hint + 1)`; CPI `place_limit_order` (bid, one bin, entire vault); `bid_quote_committed = amount`; `s_last = s_open`. State → `Open`.
- **Event:** `FloorOpened{s_open, predicted_s, L, V, S, bin_id}`.

### `refresh_floor(bin_id_hint)`

- **Signers:** any payer; new order keypair. **Accounts:** as `open` plus the current order account and `partner_auth` base ATA.
- **CPI:** `cancel_limit_order` (returns unfilled WSOL, filled base, fees), SPL `burn` of all base received, `place_limit_order` at the new highest bin ≤ F with the whole vault.
- **Effect:** fills settled and burned; F recomputed; bid moved up. **Event:** `FloorRefreshed{filled, burned, s_new, bin_id}`.
- **Re-entry:** harmless; with no fills and no new quote it re-places at the same bin. Rate-limited to once per N slots per launch to bound griefing cost.

### `harvest()`

- **Signers:** any payer. **Accounts:** DAMM pool, both positions + NFT accounts, staging WSOL ATAs (w), `vault` (w), treasury WSOL account (w), beneficiary WSOL ATA (w), DAMM program + event authority.
- **CPI:** `claim_position_fee` on the partner position (signer `partner_auth`) and creator position (signer `creator_auth`).
- **Effect:** partner fees: 90% → `vault`, 10% → treasury; creator fees → beneficiary. F rises. **Event:** `Harvested{to_vault, to_treasury, to_creator}`.

### `redeem(amount, min_out)`

- **Signers:** holder; fresh order keypair. **Accounts:** holder base ATA (w), holder WSOL ATA (w), plus every `refresh_floor` account.
- **Preconditions:** state `Open`; `amount ≥ min_redeem`.
- **Sequence:** cancel order → burn filled base → compute s → payout = ⌊amount·s²·(1 − φ)/2¹²⁸⌋ → require payout ≥ `min_out` and ≤ vault → transfer payout → burn holder tokens → recompute s′ → require s′ ≥ s\_last → re-place bid.
- **Event:** `Redeemed{holder, amount, payout, s, s_new}`. **Fallback if CU is too high (Q18):** two-step redeem from a small on-hand reserve plus `refresh_floor`.

### `deposit(amount)`

- **Signers:** depositor. **Effect:** WSOL → `vault`; F rises; no claim of any kind is created. **Event:** `Deposited{from, amount, s_new}`.

### `floor()` (view)

- **Signers:** none. **Effect:** returns `{s, F_raw, V, S, L, s_last, bin_id, bin_price}` via `set_return_data`; used by the verifier, the app and the challenge.

## 7. DBC Integration

**Ballast never builds pools from free-form configs: two DBC configs are compiled once, validated field by field on-chain by `create_class`, and every launch must use one of them.**

### Canonical config (both sizes; only threshold, start price and curve liquidity differ)

| `PoolConfig` field | Value | Why |
| --- | --- | --- |
| `quote_mint` | SPL WSOL `So11111111111111111111111111111111111111112` | SOL wedge; Token-2022 WSOL is rejected downstream |
| `fee_claimer`, `leftover_receiver` | `partner_auth` PDA | Program-controlled flows |
| `token_type`, `token_decimal` | 0 (SPL), 6 | Canon |
| `fixed_token_supply_flag`, `pre_migration_token_supply` | 1, 10¹⁵ base units (1B tokens) | Fixed supply; leftover burned |
| `token_update_authority` | Immutable option (enum per SDK; Q12) | No metadata games |
| `collect_fee_mode` | 0 (quote) | No base-token fee balances |
| Base fee | Cliff numerator 10,000,000 (1% of 10⁹), 0 periods | Flat 1%, below terminal "high tax" flags |
| Dynamic fee | Disabled | Known worst-case exit fee |
| `creator_trading_fee_percentage` | 50 | Creator income (forwarded) |
| `migration_option` | 1 (DAMM v2) | Required |
| Migrated pool | Customizable option; 100 bps; DBC `migrated_pool_fee.collect_fee_mode = 0` (DBC QuoteToken), which yields DAMM v2 `collect_fee_mode = 1` (OnlyB); compounding 0; dynamic fee off `[D-010: was "collect_fee_mode = 1 (OnlyB)" — the DAMM value written into the DBC field; DBC's 1 = OutputToken yields a DAMM BothToken pool (STEP 3, evidence/p0/Q2)]` | Quote-only, non-compounding |
| `migration_fee_percentage`, `creator_migration_fee_percentage` | 15, 0 | Vault funding |
| Partner / creator unlocked LP % | 0 / 0 | Nothing withdrawable |
| Partner / creator permanent LP % | 50 / 50 | 100% permanent |
| LP vesting, token locked vesting | All zero | No unlocks |
| `enable_first_swap_with_min_fee` | false | No privileged first swap |
| `migration_quote_threshold` | 10 SOL (Proof) / 25 SOL (Public) | Sizes |
| `sqrt_start_price` | Q64 √(p0\_raw): p0 = 3.2472e-9 / 8.1180e-9 SOL per token | Compiler output |
| Curve | Three points at √(5·p0), √(6·p0), √(8·p0) carrying 5% / 40% / 55% of the threshold | Shaped 8× curve |

### Encoding the curve

For segment i from price P\_{i−1} to P\_i carrying quote q\_i: L\_i = q\_i·2¹²⁸ / (s\_i − s\_{i−1}) in Q64 units, mirroring DAMM's Δb formula. **Verify DBC's exact scaling** by building the same curve with the SDK's custom-curve builder and comparing `migration_quote_threshold` to the sum of segments (Q12).

### Validator rules in `create_class`

1. Account owner is DBC and the discriminator is `PoolConfig`; `version` equals the version validated on devnet.
2. Every scalar row in the table above matches exactly.
3. `sha256(sqrt_start_price ‖ curve[0..20] ‖ migration_quote_threshold ‖ supply fields)` equals the constant compiled into the program for the declared `size_tag`.
4. Derived checks: `migration_sqrt_price` equals the last curve point `[D-017: within a two-sided band — last point − 4,580,461 ≤ migration_sqrt_price ≤ last point; 4,580,461 = the largest shortfall measured on the mainnet DBC binary (4,580,459) + 2. DBC rounds segment liquidity up, so equality cannot hold. Plus capacity: Σ⌊L_i·Δs_i/2^128⌋ ≥ threshold]`; curve has exactly 3 non-zero points; LP percentages sum to 100.
5. `bid_bin_step` equals the class constant `[D-014: the DLMM pair address derives from [ILM_BASE, min(mintX,mintY), max(mintX,mintY)] and carries NO bin step (Q8), so there is one pair per mint pair and the bin step must be right first time. It is a class property, validated here, and `register_launch` requires the pair creation to carry it]`.
5. `predicted_s_open` is copied from the program constant for the size; the verifier recomputes it independently from the same config (section 20).

Any failure aborts with a rule-specific error code. Configs are immutable once created, so a validated class stays valid.

### Prediction (lower bound)

`[D-017: evaluated at both ends of the rule-4 band; the pinned value is min(§27 vector, both ends), so it never assumes the favourable end]` Computed by the compiler with `ballast-floor` from: V₀ = 15% of the threshold; L from the migrated quote at the migration price, minus the protocol share (Q14, conservative 0.2%); S = curve-sold base + migration base. Bonding fees, surplus and the remaining protocol share are excluded, so the realised floor can only be higher.

## 8. DAMM v2 Integration

**L is the sum of `permanent_locked_liquidity` across exactly two positions, both owned by Ballast PDAs; nothing in Ballast can call `remove_liquidity`, and the code that reads L fails safe if Meteora ever reports less.**

### How the pool and positions come to exist

1. Curve completes; anyone sends DBC `migration_damm_v2` as a top-level transaction (Meteora's keeper or Ballast's).
2. DBC creates the DAMM v2 pool at `migration_sqrt_price` with the migrated quote (85% of the threshold, less the protocol share) and the matching base.
3. DBC distributes LP: partner position (50%, permanent) → NFT to `fee_claimer` = `partner_auth`; creator position (50%, permanent) → NFT to the pool creator = `creator_auth`; protocol remainder → protocol.

### What L is, exactly

DAMM v2 liquidity is a u128 scaled so that token B = L·(s − s\_min)/2¹²⁸ and token A = L·(s\_max − s)/(s·s\_max) with Q64 sqrt prices ([formulas](https://docs.meteora.ag/overview/products/damm-v2/damm-v2-formulas)). It is a scalar liquidity, not reserves. Only the two recorded positions' `permanent_locked_liquidity` counts; the protocol position, any external LP and `pool.liquidity` itself are ignored, which can only under-count backing.

### Why non-compounding is required

In OnlyB mode fees accrue to positions as claimable amounts, so swaps and claims never change L. Compounding pools follow reserve-based x·y = k with dead liquidity; the engine would need a different absorption formula.

### Verification procedure (devnet, then every mainnet launch)

| Check | Read | Pass |
| --- | --- | --- |
| Pool mode | DAMM v2 `pool.collect_fee_mode`, compounding bps | 1 (OnlyB), 0 `[D-010: the DAMM-side value; the DBC config field is 0]` |
| Range | `pool.sqrt_min_price`, `sqrt_max_price` | MIN / MAX constants |
| Positions | Both `Position` accounts: `pool`, `unlocked_liquidity`, `vested_liquidity`, `permanent_locked_liquidity` | Correct pool; 0; 0; > 0 |
| Ownership | NFT token accounts' owners | `partner_auth`, `creator_auth` |
| Mapping | `token_b_amount` vs L·(s − s\_min)/2¹²⁸ summed over all liquidity | Within 2 units |
| Stability | Same reads after 20 swaps and 2 fee claims | L unchanged |

### Fail-safe

If a later read shows L below the recorded value (a Meteora change), Ballast emits `BackingDecreased`, marks the launch degraded, and keeps redemption open at the lower F (still solvent); only the monotone check is suspended for that launch. If Meteora ever disables the pool, the vault leg (bids and redemption) still works.

## 9. DLMM Integration

**The whole vault sits as one limit order in one bin — the highest bin at or below F — on a LimitOrder pair Ballast creates at registration; fills are collected only by cancelling and re-placing.**

### Pair

| Parameter | Value |
| --- | --- |
| Token X / Y | Base mint / SPL WSOL |
| Function type | LimitOrder (0) |
| Bin step | 10 bps (0.1%) unless a smaller step is allowed for customizable pairs (Q9) |
| Base fee | Minimum allowed (Q9) |
| Activation | Immediate |
| Creation | Same transaction as DBC pool creation and `register_launch`, by CPI with `partner_auth` as creator if possible, otherwise top-level by the launch payer (Q8) |

### Bin math

price(id) = (1 + bin\_step/10⁴)^id lamports per base unit, as DLMM's own Q64 `price_from_id`. Ballast vendors that function and accepts a keeper-supplied `bin_id_hint` only if price(hint) ≤ s²/2¹²⁸ < price(hint + 1). Example: Public launch, F\_raw = 1.6755e-5 → bin −11,003, price 1.6743e-5 (0.9993·F).

### Order lifecycle

| Step | Mechanism | Effect on V and S |
| --- | --- | --- |
| Place | CPI `place_limit_order` (bid; one bin; amount = vault − rent float), new keypair account, owner `partner_auth` | V unchanged (quote moves to `bid_quote_committed`) |
| Fill | Any swap crossing the bin (any router) | Reported V and S unchanged; true F rises |
| Partial fill | Same | Same |
| Settle | CPI `cancel_limit_order` → unfilled WSOL to vault, filled base to staging, fees to vault; order closed | V falls by quote spent, S falls by tokens burned; reported F rises |
| Re-place | New order at the new highest bin ≤ F | V unchanged |
| Stale order | F rose above the next bin | `refresh_floor` moves it; permissionless, rate-limited |

### The six prices, kept distinct everywhere

| Name | Definition | Shown as |
| --- | --- | --- |
| Theoretical floor F | Root of the floor equation | "Floor" |
| Bid bin price b | price(bin\_id) ≤ F, within one bin step | "Bid" |
| Executable bid, net | b × (1 − DLMM taker fee) | "You receive at least" |
| DAMM v2 price | Current pool price; can print below F if a seller bypasses the bid | "Market price" |
| DAMM v2 sell, net | Pool output × (1 − 1% fee) | Quote only |
| Redemption | F × (1 − 0.5%) | "Redeem" |

## 10. Vault / Redemption System

**The vault can pay only three destinations — the DLMM bid it owns, a redeemer at the floor, and nobody else — and every lamport that enters or leaves is reconciled in the ledger below.**

### `redeem(T, min_out)` exactly

| Item | Rule |
| --- | --- |
| Quote paid | ⌊T · s² · 9,950 / (2¹²⁸ · 10,000)⌋ lamports, with s computed after settling the bid |
| Fee | 0.5%, never transferred: it stays in the vault and raises F for holders who remain |
| Burn | Exactly T base units from the holder (holder signs the SPL burn inside the CPI) |
| Supply | S −= T |
| V | V −= payout (before re-placing the bid) |
| L | Unchanged |
| F | Rises by ≥ the fee share (section 4 proof); checked on-chain |
| Solvency | Requires payout ≤ vault balance. When the vault is exhausted, F is supported by locked liquidity alone, and the recomputed F is still ≥ the old one, so remaining holders can sell to the pool at ≥ F |
| Dust | Minimum payout 0.001 SOL; floor rounding |
| Repeated / partial / full | Each is an independent call; full redemption of a wallet's balance is allowed |
| Concurrency | `launch` and `vault` are writable in every redeem, so Solana serialises them; `min_out` protects against F moving between quote and execution |
| Permissionless | Yes; any holder of the base token |
| Dead market | Works without any trading; needs DLMM's cancel to succeed. If the DLMM pair is ever disabled and cancel fails, redemption pauses: a disclosed dependency (Q19) |

### Accounting ledger (Public launch, 25 SOL threshold)

Assumes bonding volume equals exactly the buys to the threshold, no sells, no surplus.

| Phase | Traders | Creator beneficiary | Vault | DAMM v2 pool | DLMM bid | Meteora protocol | Burned |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Registered | 0 | 0 | 0 | — | — | 0 | 0 |
| Curve complete | −25.2525 SOL; +538.2M tokens | 0.101 SOL claimable | 0.101 SOL claimable (partner) | — | — | 0.0505 SOL fees | 0 |
| `settle_graduation` | — | +0.101 SOL | +3.75 (migration fee) +0.101 = 3.851 SOL | — | — | — | 0 |
| Migration | — | — | 3.851 | 21.25 SOL incl. protocol share + 327.2M tokens; both positions permanent | — | Protocol LP remainder | 0 |
| `burn_leftover` | — | — | 3.851 | unchanged | — | — | 134.6M |
| `open` | — | — | 0 on hand | unchanged | 3.851 SOL resting | — | 134.6M |

**SOL conservation:** 25.2525 paid = 0.0505 protocol fee + 0.101 creator + 3.851 vault + 21.25 pool. **Token conservation:** 1,000M = 538.2M holders + 327.2M pool + 134.6M burned. After `open`, every later flow (fills, burns, redemptions, harvests, deposits) is recorded in `Launch` counters and events, so the verifier can re-run this table from chain data.

## 11. Floor Engine

**One Rust crate, `ballast-floor`, is the only implementation of F; TypeScript consumes it compiled to WASM, and an independent Python reference exists only to catch errors in it.**

### API

```rust
#![no_std]
pub struct FloorInputs { pub v: u64, pub s: u64, pub l: u128, pub s_max: u128 }

pub enum FloorError { SupplyZero, OutOfRange }

/// s = floor(sqrt(F) * 2^64), exactly the floor of the root (section 4)
pub fn floor_sqrt_q64(i: &FloorInputs) -> Result<u128, FloorError>;

/// floor(amount * s^2 * (10_000 - fee_bps) / (2^128 * 10_000))
pub fn redeem_payout(amount: u64, s: u128, fee_bps: u16) -> u64;

/// true iff price(bin) <= s^2 / 2^64 < price(bin + 1), prices in DLMM Q64 form
pub fn bin_at_or_below(bin_price_q64: u128, next_bin_price_q64: u128, s: u128) -> bool;

/// P(s) = A s^2 - B s - C sign, for invariant tests and the verifier
pub fn residual_sign(i: &FloorInputs, s: u128) -> core::cmp::Ordering;
```

### Types and arithmetic

U256 from `ruint` (no\_std, no allocation); u128 for sqrt prices; no floating point anywhere in the crate. Bounds asserted before arithmetic (section 4).

### Cross-language strategy

| Consumer | How it gets F |
| --- | --- |
| Ballast program | Links the crate |
| Verifier CLI (Rust) | Links the crate |
| TypeScript SDK, app, keeper | `@ballast/floor-wasm`, built from the same crate with `wasm-pack` |
| Independent check | `tests/reference/floor.py`, integer-only, written separately |

### Test vectors

`crates/floor/vectors.json` holds the vectors in section 27 plus 10,000 random ones generated by the Python reference. Rust, WASM and Python must all produce identical `s` for every vector; CI fails on any mismatch.

## 12. Security Threat Model

**No attack found lowers F or withdraws backing if the account constraints and PDA ownership hold; the critical residual risks are program bugs, Meteora admin powers and quote-token behaviour.** Fuzzing reduces but does not eliminate bug risk.

### Smart-contract attacks

| Attack | Mechanism | Sev. | Likel. | Prevention | Detection | Residual |
| --- | --- | --- | --- | --- | --- | --- |
| Authority compromise | Admin key creates a malicious class | High | Low | Multisig; classes immutable; existing launches unaffected | `ClassCreated` events | Admin can only add classes |
| Upgrade-authority abuse | New code drains vaults | Critical | Low | Multisig + timelock; freeze after review (section 19) | Upgrade events | Until frozen |
| PDA misuse | Instruction lets a caller direct a PDA signature | Critical | Medium | PDA signs only fixed CPIs with destinations derived in-program | Code review; tests per CPI | Bug risk |
| Account substitution | Fake pool, position, pair, order, vault | Critical | Medium | Rules in section 5: owner, discriminator, derivation, cross-links | Negative tests per account | Bug risk |
| Signer confusion | Holder signs burn for another's tokens | High | Low | Burn authority = signer; token account owner = signer | Tests | — |
| Malicious CPI program | Caller passes a lookalike program | Critical | Low | Program IDs hard-coded | Tests | — |
| Fake position accounts | Inflate L | Critical | Medium | Position PDA re-derived from recorded NFT mint; owner = DAMM v2 | Tests | — |
| Fake DLMM pair or order | Bid placed elsewhere | High | Low | Pair recorded at registration; order owner checked | Tests | — |
| Stale state | F from old balances | Medium | Medium | All inputs read live; unsettled fills only lower reported F | Invariant tests | — |
| Replay / duplicate settlement | Double-count migration fee | High | Low | State machine + DBC withdraw bitmask; amounts from balance deltas | Tests | — |
| Double redemption | Pay twice for one burn | Critical | Low | Burn and pay in the same instruction | Tests | — |
| Overflow / precision | Wrong F | High | Low | U256, bounds asserts, exact floor-of-root | Property tests | — |
| Rounding extraction | Many tiny redeems | Low | Medium | All rounding toward protocol; minimum payout | Fuzz | — |
| Unexpected decimals / malicious mint | Wrong units | High | Low | Mint and decimals fixed by class validation | Tests | — |
| Freeze authority | Holders frozen | High | Unknown | Verify None (Q11) | `getMint` in verifier | Meteora trust if not None |
| WSOL transfer failure | Payout fails | Low | Low | ATAs created idempotently; SPL WSOL only | Errors | — |

### Economic attacks

| Attack | Outcome | Prevention |
| --- | --- | --- |
| Push F down by trading | Impossible: swaps don't change V, L or S | Proof |
| Wash / self-trading | Pays fees; raises F | None needed |
| Sandwich around `refresh_floor` or `harvest` | Both only raise F; an attacker can buy just below the new F and sell into the new bid for a bin's width | Rate limit; profit bounded by one bin step |
| Front-run a redemption | F can only rise; `min_out` bounds outcome | `min_out` |
| Early-buyer extraction | Small disclosed below-F region (0.8% of raise) | Shaped curve |
| Migration-timing games | Curve complete → no trading until migration | Keeper; disclosed handoff window |
| Griefing with dust redemptions | Each cancels and re-places the bid | Minimum payout; caller pays CU |
| Mass redemption | F rises; vault may empty; pool carries the rest at ≥ F | Proof |
| Malicious creator | Creator role moves to `creator_auth`; creator cannot touch LP, vault or bids | PDA ownership |

### Protocol-dependency risks

| Risk | Effect | Response |
| --- | --- | --- |
| Meteora upgrades change layouts | Reads fail | Layout version checks; fail closed for new launches; redemption stays open |
| DAMM v2 operator changes pool fees | Worse net DAMM exits | Disclose; bids and redemption unaffected |
| Pool disabled (DAMM v2 or DLMM) | One leg unavailable | Other leg remains; disclose |
| Locked liquidity reported lower | F lower | Fail-safe `BackingDecreased` (section 8) |

## 13. Economic Attack Model

**Simulated on the Public launch (25 SOL raise, 8× shaped curve, 15% vault): the floor held in every scenario, and the only place it breaks is the design choice the earlier tabs had made — keeping part of the vault off the bid.** Fees: DAMM v2 1%, DLMM taker 0.1% (assumed, Q9), redemption 0.5%; bid at the highest 10 bps bin ≤ F.

### Opening state

F = 1.6755e-8 SOL/token = 25.8% of graduation price; vault 3.75 SOL; DAMM v2 21.17 SOL; holders 538.2M tokens.

### Scenarios

| Scenario | Sold | Holders receive | Lowest execution | DAMM v2 after | Vault | Supply | Burned | F change |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Complete liquidation, all of vault in the bid (adopted) | 538.2M | 14.03 SOL | 0.9945·F | 1.004·F | 3.75 → 0 | 865M → 642M | 223.9M | +0.03% |
| Complete liquidation, 80% in bid, router-only sellers (rejected design) | 538.2M | 13.98 SOL | **0.869·F** | 0.877·F | 3.75 → 0.75 | 865M → 686M | 179.1M | +0.02% |
| Half of holders sell | 269.1M | 9.48 SOL | 1.151·F | 1.163·F | unchanged | unchanged | 0 | 0 |
| 10% of holders sell | 53.8M | 2.97 SOL | 2.827·F | 2.855·F | unchanged | unchanged | 0 | 0 |
| 100 SOL of round-trip volume, harvested | — | — | — | — | +0.36 SOL | — | — | +3.9% |
| 500 SOL of volume | — | — | — | — | +1.80 SOL | — | — | +19.2% |
| 2,000 SOL of volume | — | — | — | — | +7.20 SOL | — | — | +73.0% |
| Redeem 20% of holders while price > F (irrational) | 107.6M | 1.80 SOL | 0.995·F | unchanged | −1.80 SOL | −107.6M | 107.6M | +0.12% |
| Zero volume forever | — | — | — | — | unchanged | unchanged | 0 | 0 |

### Who gains, who pays

| Actor | Outcome in a complete liquidation | Notes |
| --- | --- | --- |
| Very early buyer (at p0) | Exits at ≥ 2.06× entry | Below-F region: 0.8% of raise |
| Average buyer | Exits at ≥ 36% of average cost | F / average entry |
| Graduation buyer | Exits at ≥ 25.8% of cost | Max loss \~74% |
| Post-graduation buyer above P\_m | Exits at ≥ F; loss can exceed 74% | Disclosed |
| Whale | Same per-token floor; cannot extract more than F per token from the vault | — |
| Small holder | Same as whale; minimum redemption 0.001 SOL | — |
| Creator | 50% of non-protocol bonding fees + creator LP fees, forwarded | No access to LP or vault |
| Attacker | No transition lowers F; best profit is one bin width around refreshes | — |
| Arbitrageur | Buys DAMM v2 below the bid, sells into it | Enforces the floor |
| External LP | Bounded tail above F | — |
| Vault | Ends empty exactly as the last holder exits | Section 2 tabs' simulation agrees |
| Treasury | 10% of partner LP fees | — |
| Keeper | Pays transaction fees only | Permissionless |

**Where it breaks:** (1) taker fees put the net exit \~0.5% below F; (2) a seller who swaps directly on DAMM v2 instead of routing can execute below F (their choice); (3) if DLMM is disabled, the bid leg and redemption pause while the pool leg remains.

## 14. Testing Strategy

**Four layers, each with a gate: pure-math properties, a stateful model fuzzer, local-validator integration against real Meteora binaries, and devnet runs that must reproduce the simulation.**

| Layer | Tooling | What it proves | Gate |
| --- | --- | --- | --- |
| Unit | `cargo test` in `ballast-floor` | isqrt, U256 mul/div, root correctness against the Python reference, bounds errors | All pass |
| Property | `proptest` | For random valid inputs: P(s) ≤ 0 < P(s + 1); monotone in V; antitone in S; **monotone in L within one ⌈L/s\_max⌉ step, with the drop at a step bounded by one base unit** `[D-004: unconditional monotonicity in L is false for §4's ceiling rounding; L is immutable after open, so no mechanism impact]`; payout ≤ exact | 100k cases |
| Stateful fuzz (model) | Rust model of V, S, L, bid, pool reserves | Random sequences of trade, sell, fill, settle, redeem, harvest, deposit, refresh: **F never falls**, **V/F + L(1/√F − 1/√P\_max) ≥ S** at every step, no negative balances, conservation of SOL and tokens | 1M steps, zero failures |
| Differential | Rust vs WASM vs Python on `vectors.json` + 10k random | Identical `s` | Exact match |
| Program integration | `solana-test-validator` with DBC, DAMM v2, DLMM `.so` files dumped from mainnet and required config accounts cloned; Anchor TS tests | Every instruction, every error path, every substitution attack | All pass |
| Stateful integration | Same validator; scripted random sequences against real programs | Invariants hold through real CPIs | 500 sequences |
| Devnet | Real deployed Meteora programs | Q1–Q20 answers; full lifecycle; full sell-out within 1% of predicted behaviour | Section 18 gates |
| Mainnet dry run | Simulated transactions (`simulateTransaction`) against mainnet state before sending | Account lists, CU, signer sets | No simulation errors |

**Negative tests that must exist:** double redemption; double settlement; claim by non-PDA; fake position (wrong pool, wrong owner, wrong program); fake pair; fake order owner; substituted vault; config with any single field changed (one test per validator rule); redeem with `min_out` above payout; redeem larger than vault; `open` before leftover burn; `refresh_floor` with a wrong bin hint; LP withdrawal attempt via DAMM v2 by anyone (must fail at Meteora).

## 15. Repository Architecture

**Production-critical code is three directories — the program, the floor crate and the verifier — and everything else is tooling around them.**

```
ballast/
  programs/ballast/        Anchor program
  crates/floor/            ballast-floor (no_std); vectors.json
  crates/meteora-types/    vendored zero-copy views of PoolConfig, VirtualPool,
                           DAMM Pool/Position, DLMM LbPair/LimitOrder + offset tests
  crates/verifier-core/    account fetch + checks, shared by CLI
  verifier/                CLI binary `ballast`
  sdk/typescript/          instruction builders, PDA helpers, floor-wasm wrapper
  compiler/                emits ConfigParameters + predicted s per size
  keeper/                  crank loop (TS)
  app/                     one token page + launch form
  tests/{unit,integration,fuzz,devnet,mainnet,reference}/
  scripts/{deploy,initialize,proof,public-launch}/
  docs/{architecture,mechanism,math,security,meteora,verifier,proof,operations,limitations}.md
  fixtures/                dumped Meteora .so files and cloned accounts (gitignored hashes listed)
  Anchor.toml  Cargo.toml  package.json  README.md
```

| Directory | Responsibility | Depends on | Critical? | Build / test |
| --- | --- | --- | --- | --- |
| `programs/ballast` | All on-chain logic | floor, meteora-types, anchor | **Yes** | `anchor build`; `anchor test` |
| `crates/floor` | F math | ruint | **Yes** | `cargo test -p ballast-floor` |
| `crates/meteora-types` | Read Meteora accounts without full program crates | bytemuck | **Yes** | `cargo test -p meteora-types` (offsets vs fixtures) |
| `crates/verifier-core`, `verifier` | Independent check | floor, meteora-types, solana-client | **Yes** | `cargo test -p verifier-core` |
| `sdk/typescript` | Clients | Meteora SDKs, floor-wasm | Yes | `pnpm -F sdk test` |
| `compiler` | Class configs + predictions | DBC SDK, floor-wasm | Yes (outputs pinned) | `pnpm -F compiler test` |
| `keeper` | Liveness | sdk | No (any keeper works) | `pnpm -F keeper test` |
| `app` | Display, launch form | sdk | Demo | `pnpm -F app build` |
| `scripts/*` | Deploy, proof, public launch | sdk | Demo | per script `--dry-run` |

## 16. Toolchain / Versions

**Pin everything after the day-1 compatibility check; the versions below are the starting set, chosen from what current Meteora SDKs and recent sidetrack projects use, and each must be confirmed against the deployed program versions.**

| Tool | Starting pin | Why / check |
| --- | --- | --- |
| Rust (host) | 1.84 stable via `rust-toolchain.toml` | Anchor 0.31 compatible |
| Agave / Solana CLI | 2.1.x | Matches Anchor 0.31 platform tools; verify `cargo build-sbf` |
| Anchor | 0.31.1 (CLI via `avm`) | Used by recent DBC projects with DBC SDK 1.5.x |
| Node | 20 LTS | — |
| Package manager | pnpm 9, workspaces | — |
| TypeScript | 5.6 | — |
| `@solana/web3.js` | 1.98.x | Meteora SDKs target web3.js v1 |
| `@solana/spl-token` | 0.4.x | — |
| `@coral-xyz/anchor` | 0.31.1 | Match CLI |
| `@meteora-ag/dynamic-bonding-curve-sdk` | Latest supporting DBC 0.2.1 (≥ 1.5.11); confirm on day 1 | Q12 |
| `@meteora-ag/cp-amm-sdk` | 1.4.8 | Matches cp-amm 0.2.4 ([changelog](https://docs.meteora.ag/developer-guides/damm-v2/changelog)) |
| `@meteora-ag/dlmm` | 1.9.10 | Limit orders + bitmap fix ([changelog](https://github.com/MeteoraAg/dlmm-sdk/blob/main/CHANGELOG.md)) |
| Rust crates | `anchor-lang`/`anchor-spl` 0.31.1, `ruint` (no\_std), `bytemuck`, `proptest`, `solana-client` 2.1 | — |
| WASM | `wasm-pack` + `wasm-bindgen` | floor-wasm |
| Frontend | Vite + React 18 + `@solana/wallet-adapter-react` | Smaller than a full framework |
| Lint / format | rustfmt, clippy `-D warnings`, eslint, prettier | CI |
| CI | GitHub Actions: build, unit, property, differential, integration (local validator) | — |

Jupiter is not a dependency of the program; the app uses it only to show quotes.

## 17. Local Development

`[D-001: fixtures are the MAINNET programs (DBC, DAMM v2, DLMM, Token Metadata, Jupiter locker) plus every mainnet account they read, found by simulation; pinned by sha256 + last-deployed slot in evidence/fixtures/mainnet-pins.json; pnpm fixtures:check at session start and before any mainnet action]`

**A new engineer runs seven commands to get from clone to a passing integration suite against real Meteora binaries.**

```bash
git clone <repo> ballast && cd ballast
avm install 0.31.1 && avm use 0.31.1           # Anchor CLI
pnpm install                                    # workspaces: sdk, compiler, keeper, app
cargo test -p ballast-floor -p meteora-types    # pure math + layouts
pnpm fixtures:dump                              # dumps Meteora programs + accounts from mainnet
anchor build
anchor test                                     # local validator with real DBC / DAMM v2 / DLMM
```

**`pnpm fixtures:dump`** runs `solana program dump -u m` for DBC, DAMM v2, DLMM, Metaplex Token Metadata (DBC creates metadata) and the Jupiter locker program (DBC migration may reference it), and `solana account -u m --output json` for the DBC→DAMM v2 migration config key and DLMM preset parameters. Hashes of every fixture are committed so tests are reproducible.

**`Anchor.toml`** loads them with `[[test.genesis]]` (programs) and `[[test.validator.account]]` (accounts), so integration tests exercise the real Meteora code, not mocks. Pure-logic tests that don't need Meteora use LiteSVM for speed.

| Variable | Purpose |
| --- | --- |
| `RPC_URL` | localnet / devnet / mainnet endpoint |
| `KEEPER_KEYPAIR` | Fee payer for cranks (no privileges) |
| `ADMIN_MULTISIG` | Global admin and upgrade authority (mainnet) |
| `TREASURY` | Treasury WSOL account |
| `NETWORK` | `localnet`, `devnet`, `mainnet` |

**Keys:** `solana-keygen new -o .keys/<role>.json` for local and devnet roles; mainnet program and admin keys never touch the repo. **Test SOL:** local validator airdrop; devnet web faucet.

## 18. Devnet Plan

`[D-001: every gate runs first on the mainnet-binary local validator, which is authoritative; devnet is secondary — keeper behaviour (Q17) and cross-checks; any divergence is recorded and the mainnet result governs]`

**Ten phases, each with a hard pass/fail gate; a failed P0 gate stops the plan until a fallback passes.** Jupiter does not route on devnet, so routing (Q10) is tested on mainnet with the Proof launch.

| Phase | Work | Pass gate |
| --- | --- | --- |
| 1. Config validation | Compiler emits the Proof config; create it on devnet; decode with SDK and vendored types; `create_class` | Byte-identical decode; class created; each single-field mutation is rejected by its rule |
| 2. Graduation and migration | Create pool + `register_launch` (creator transferred, pair created) in one tx; buy to threshold; `settle_graduation`; migrate top-level | States advance; migration fee lands in vault to the lamport |
| 3. Permanent lock (P0) | Q1, Q2, Q3, Q6, Q7 reads | Both positions fully permanent and PDA-owned; L mapping within 2 units; L unchanged after swaps |
| 4. Vault funding | `burn_leftover`; reconcile the section 10 ledger | Exact SOL and token conservation |
| 5. DLMM bid (P0) | Q5, Q8, Q9: place via PDA, swap through, cancel, burn | Fills persist; cancel returns unfilled + filled + fees |
| 6. F | `floor()` vs Rust, WASM, Python | Identical s; realised ≥ predicted |
| 7. Redemption | Atomic redeem; measure CU (Q18) | Exact payout; F rises; CU within limit (else switch to two-step) |
| 8. Full sell-out | Script sells all team tokens choosing the better of DAMM v2 and the bid each step | Lowest execution ≥ 0.99·F; vault ≈ 0; F not lower |
| 9. Invariant run | 200 random transactions from several wallets | No monotone-check failure; verifier PASS |
| 10. Failure injection | Keeper off for an hour; stale order; substituted accounts; dust redeems | All fail safe as in section 26 |

## 19. Mainnet Deployment

`[D-007: mainnet deployment of the full program happens only if funding arrives; every mainnet transaction needs the owner's approval; this runbook is kept ready]`

**After deployment, exactly two authorities exist — the program upgrade authority and the global admin, both a 2-of-3 multisig — and neither can move any launch's backing except by upgrading the program.**

### Runbook

1. `anchor build --verifiable`; deploy from a buffer with a hot deployer key.
2. Immediately set the upgrade authority to the multisig; record the program ID and build hash; verify with `solana-verify` against the tagged commit.
3. `initialize_global(admin = multisig, treasury = multisig WSOL account)`.
4. Generate the Proof config keypair; derive `partner_auth` from its address; create the DBC config with `fee_claimer = leftover_receiver = partner_auth`; `create_class(Proof)` from the multisig.
5. Fund `partner_auth` with \~0.1 SOL for order rent; start the keeper.
6. Proof launch (section 22). Then repeat steps 4–5 for the Public config and run the Public launch (section 23).
7. Run `ballast verify` on both; publish addresses.

### Authorities

| Authority | Holder | Can do | Cannot do |
| --- | --- | --- | --- |
| Program upgrade | Multisig | Replace program code | — (this is the residual trust; frozen after an external review, post-hackathon) |
| `global.admin` | Multisig | Create classes; toggle class creation | Touch any vault, position, bid, launch |
| DBC config fee claimer | `partner_auth` PDA | Program-defined claims only | Anything outside program logic |
| Pool creator | `creator_auth` PDA | Program-defined claims only | — |
| LP positions | PDAs; permanently locked | Claim fees | Remove liquidity (Meteora rejects; Ballast has no such instruction) |
| Keeper | Hot wallet | Pay for permissionless cranks | Anything privileged |
| Treasury | Multisig | Receive 10% of partner LP fees | — |

### Can anyone withdraw user backing?

No instruction in the program transfers from `vault` except (1) into a DLMM limit order owned by `partner_auth` and (2) to a redeemer, in the same instruction that burns their tokens at F. The LP positions are permanently locked, owned by PDAs, and the program contains no CPI to any liquidity-removal endpoint. The only path is a malicious program upgrade by the multisig, which is disclosed.

### Incident handling

The multisig can disable new class creation. There is deliberately no pause on redemption, bids or the floor. A bug is fixed by an upgrade through the multisig with a public post-mortem; rollback of launches is impossible by design.

## 20. Verifier

**`ballast verify <launch>` reads raw mainnet accounts, re-derives every number with the shared floor crate, and fails loudly on any mismatch; it never calls the Ballast app.**

### Interface

```bash
ballast verify <launch-address> [--rpc <url>] [--json] [--sellout <signature>...]
```

### Steps

1. Fetch `Launch` and `Class`; check program ownership and seeds.
2. Fetch the DBC config; recompute the config hash and the predicted s from config fields (independent DBC curve math in `verifier-core`); compare with the recorded prediction and confirm `registered_slot` precedes the pool's first swap (from transaction history).
3. Fetch the DAMM v2 pool and both positions; check mode, range, ownership, `unlocked == vested == 0`; sum permanent liquidity → L.
4. Fetch vault balance, the current order and its bin; compute V; check the order owner, `price(bin) ≤ F < price(bin + 1)`.
5. Fetch mint supply, PDA-held base, mint and freeze authorities → S.
6. Compute s; compare with `s_last` and with history rebuilt from program events (must never fall).
7. Optional: replay sell-out signatures; report lowest execution price per fill relative to F.

### Output

```
Launch:            <address>   class: Public (25 SOL)
Prediction:        1.6755e-8 SOL/token  (recorded slot 312,xxx,xxx, before first trade)
Realised at open:  1.6781e-8 SOL/token  (+0.16% vs prediction)
Recomputed F now:  1.7012e-8 SOL/token
DAMM backing (L):  4.84e31  permanent: PASS  owners: PDA: PASS  mode: OnlyB, full range: PASS
Vault backing (V): 3.851 SOL  (resting bid 3.851 SOL @ bin -11003 = 1.6743e-8): PASS
Outstanding S:     865,440,991 tokens  mint authority: None  freeze authority: None
Invariant:         V/F + L(1/sqrtF - 1/sqrtPmax) >= S: PASS   history monotone: PASS
Prediction:        realised >= predicted: PASS
```

(Values illustrative of the Public configuration.) Exit code is non-zero on any FAIL.

## 21. Frontend

**One token page and one five-step launch form; every number on screen comes from the floor crate and is labelled with which of the six prices it is.**

### Token page

| Element | Content |
| --- | --- |
| Header | Token, market price, **Floor F**, price ÷ F |
| Max loss if you buy now | 1 − F ÷ price, in SOL terms |
| Floor composition | Share of supply the locked pool absorbs at F vs share the vault bid absorbs (Public at open: 74% / 26%) |
| Bid wall | Bin price, resting SOL, "you receive at least" (net of DLMM fee) |
| Redeem | Amount input → exact payout at F minus 0.5%; `min_out` defaulted |
| Proof | Prediction tx, `open` tx, verifier command, all addresses with explorer links |
| Plain-language limits | "F is in SOL, not dollars. Selling directly on DAMM v2 can execute below F; the bid and redemption don't. Late buyers can lose most of what they paid." |

**Never displayed:** safe, insured, protected, can't lose, guaranteed profit, "price can never go below F".

**Headline sentence on the page:** "This is an executable buyback floor on Meteora, not a promise about prices elsewhere."

### Launch form

1. Connect wallet.
2. Class: Public (only choice shown).
3. Token name, ticker, image, beneficiary wallet for creator income.
4. Preview: start price, the 3-segment curve chart, graduation price, 15% vault, predicted minimum floor and the method behind it, and what the creator gives up (LP permanently locked and owned by Ballast; income forwarded).
5. One transaction: DBC pool creation + `transfer_pool_creator` + DLMM pair + `register_launch`. On success, the proof page opens with the prediction transaction.

## 22. Proof Launch

`[D-007: the primary proof is pnpm proof:local — this whole sequence on the mainnet-binary local validator, deterministic and rerunnable — then devnet (public evidence); the mainnet Proof launch only if funded]`

**A controlled, fully disclosed 10 SOL launch whose only purpose is to make a prediction on-chain and then destroy the market to test it.**

| Item | Value |
| --- | --- |
| Class | Proof: identical economics to Public; threshold 10 SOL; p0 = 3.2472e-9 SOL/token |
| Prediction | ≈ 6.70e-9 SOL/token (25.8% of graduation price), recorded by `register_launch` |
| Wallets | Three team wallets, labelled on the proof page and in the README |
| Sequence | Register → three wallets buy to the threshold → keeper settles and migrates → `burn_leftover` → `open` → team sells every token via Jupiter (best-price routing) and, if any remain after the bid empties, via direct DAMM v2 sells → `refresh_floor` → verifier with `--sellout` |
| Expected | Lowest execution ≥ 0.99·F; vault ≈ 0; burned ≈ 224M-equivalent share; F not lower; realised ≥ predicted |
| Cost | \~4.4 SOL (holders recover \~56% of the raise on a total sell-out) plus fees |
| Disclosure | Banner: "Proof launch — team wallets only — built to be sold out" |
| Recording | Screen capture of the sell-out with signatures visible; graduation may be sped up and labelled |

The Proof and Public classes differ only in threshold, start price and curve liquidity scale; every percentage, fee and lock is identical.

## 23. Public Launch

**The open launch where outside wallets trade, redeem and attack, with an external creator if one can be recruited in time.**

| Item | Value |
| --- | --- |
| Class | Public: 25 SOL threshold; p0 = 8.1180e-9 SOL/token; graduation price 6.4944e-8; F ≈ 1.6755e-8 (25.8%) |
| Creator | External creator (target) or the team, disclosed |
| Who trades | Anyone, through any router or the Ballast page |
| Challenge | "Make F go down" opens when the Public launch is `Open` (section 24) |
| Signals sought | A non-team wallet filling the bid or redeeming; an external creator launch |
| Differences from Proof | Threshold and start price only |

## 24. Adversarial Challenge

**A public bounty for anyone who produces on-chain evidence that the published invariant failed, defined tightly enough that there is nothing to argue about.**

| Rule | Definition |
| --- | --- |
| Authoritative value | s returned by the `floor()` view of a named launch, evaluated by `ballast verify --at-slot` at the commit tagged for the challenge |
| A win is any of | (1) two slots t₁ < t₂ with s(t₂) < s(t₁); (2) any transfer out of a vault other than into a `partner_auth` limit order or to a redeemer burning tokens in the same instruction; (3) any decrease in the permanently locked liquidity of a recorded position; (4) a state with vault > 0 in which redeeming T tokens pays less than ⌊T·F·(1 − 0.5%)⌋ |
| Allowed | Any sequence of mainnet transactions by anyone, against any Ballast launch |
| Excluded | Meteora admin actions or program upgrades; Ballast program upgrades; RPC errors; taker fees; prints below F from direct DAMM v2 swaps (not a violation by definition); bugs located solely in Meteora programs (reported to Meteora separately) |
| Evidence | Transaction signatures and the slots, reproducible with the verifier |
| Disclosure | Private report first; 48-hour window to protect real holders; then public credit |
| Payout | Fixed bounty in SOL from the multisig within 72 hours of reproduction |
| Window | From the Public launch's `open` until 31 October 2026 |

## 25. Observability

**Everything needed to audit a launch is reconstructable from program events and account state; the only operational tooling is a keeper log, a verifier cron and three alerts.**

| Event | Fields |
| --- | --- |
| `ClassCreated` | config, size, hash, predicted\_s\_open |
| `LaunchRegistered` | mint, pool, predicted\_s, slot, beneficiary |
| `GraduationSettled` | migration\_fee, partner\_fees, creator\_fees |
| `LeftoverBurned` | amount, surplus |
| `FloorOpened` | s\_open, predicted\_s, V, S, L, bin\_id, order |
| `FloorRefreshed` | filled\_tokens, burned, quote\_returned, s\_new, bin\_id, order |
| `Harvested` | to\_vault, to\_treasury, to\_creator, s\_new |
| `Redeemed` | holder, amount, payout, s\_before, s\_after |
| `Deposited` | from, amount, s\_new |
| `BackingDecreased` | position, L\_recorded, L\_read |

**State views:** `floor()`; the `Launch` account counters.

**Operations:** keeper log (every crank with signature and CU); verifier cron every 10 minutes per launch; alerts on any verifier FAIL, any `BackingDecreased`, and any transaction that reverted on the monotone check (indicates an attempted violation or a bug).

## 26. Failure Paths

**Every failure either reverts with no state change or leaves the floor at least where it was; the one failure that pauses something (DLMM unavailable) still leaves the locked-pool leg working.**

| Failure | Behaviour |
| --- | --- |
| DBC CPI fails in `settle_graduation` | Whole instruction reverts; retry later; state unchanged |
| Migration fails or is delayed | No venue during the handoff (disclosed); any keeper can retry; settle can run first |
| DAMM pool not created as expected (mode, range, lock) | `open` refuses; launch stays `Cleaned`; holders still own tokens; escalate (P0 should have caught this) |
| `place_limit_order` fails in `open` | `open` reverts; retry with a new keypair or bin hint |
| Order partially filled | Reported F conservative; `refresh_floor` settles and raises it |
| Keeper disappears | Bids go stale but stay valid below F; redemption still works; anyone can run cranks |
| Transaction replayed | Solana rejects duplicates; Ballast instructions are idempotent by state and balance deltas |
| Stale Meteora account passed | Reads are live; derivation and owner checks reject substitutes |
| User sends the wrong token | Mint checks reject it |
| Account substituted | Rejected by section 5 rules |
| Vault empty | `redeem` reverts with `VaultExhausted`; recomputed F (pool-only) is still ≥ the previous value; holders sell to the pool at ≥ F |
| Pool has little liquidity | Irrelevant to F; only affects prices above F |
| Large redemption demand | Serialised; each raises F; `min_out` protects each holder |
| F changes while a redemption is in flight | It can only rise; `min_out` is a lower bound |
| F differs across implementations | Impossible by construction (one crate); CI differential test catches regressions |
| Quote transfer fails | Instruction reverts entirely |
| Front-running between DBC pool creation and `register_launch` | Done in one transaction; if size forces two, submit as a Jito bundle or create the pool with a delayed activation point (verify DBC supports it, Q12) |
| DLMM pair disabled by an operator | Cancel may fail → bids and redemption pause; disclosed dependency |

### Compute and capital efficiency (to be measured, not assumed)

| Item | Budget | Measured on |
| --- | --- | --- |
| `open` | ≤ 400k CU; address lookup table for Meteora accounts `[D-013: was 600k. `initialize_bin_array` (≈199k CU, measured in Q9) moves to the keeper as a top-level instruction before `open`; `open` only verifies the arrays exist]` | Devnet phase 5 |
| Atomic `redeem` (cancel + burn + pay + place) | ≤ 1.2M CU | Devnet phase 7 (Q18) |
| `refresh_floor` | ≤ 600k CU `[D-013: was 800k; bin-array creation is the keeper's, before the call]` | Devnet phase 5 |
| Keeper cost | \~10 transactions per launch per day | Mainnet logs |
| Idle capital | 15% of the raise, all resting as the bid | By design |

## 27. Numerical Test Vectors

**Generated by the independent Python reference (exact integers); Rust and WASM must reproduce every `s` exactly.** Units: V in lamports, S in base units, L in DAMM Q64 liquidity, s = ⌊√F·2⁶⁴⌋, F\_raw in lamports per base unit, F in SOL per token = F\_raw / 1,000. s\_max = 79226673521066979257578248091. Launch-level inputs use the conservative 0.2% protocol-share assumption (Q14).

### Launch vectors

| Case | p0 (SOL/token) | Graduation price | V | S | L | s | F (SOL/token) | Bin (10 bps) | Redeem 1M tokens pays |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Proof | 3.2472e-9 | 2.5978e-8 | 1,500,000,000 | 865,440,991,257,550 | 30,640,807,377,189,377,099,685,691,392,000 | 47,755,047,807,748,143 | 6.7019e-9 (25.80%) | −11,920 (0.99907·F) | 6,668,408 lamports |
| Public | 8.1180e-9 | 6.4944e-8 | 3,750,000,000 | 865,440,991,257,550 | 48,447,370,329,204,224,440,919,346,118,656 | 75,507,360,421,341,854 | 1.6755e-8 (25.80%) | −11,003 (0.99932·F) | 16,671,021 lamports |

### Transition vectors (Public)

| Transition | V after | S after | s after | ΔF |
| --- | --- | --- | --- | --- |
| Harvest +0.1 SOL | 3,850,000,000 | unchanged | 75,919,307,215,186,886 | +1.094% |
| Deposit +1 SOL | 4,750,000,000 | unchanged | 79,478,727,226,182,304 | +10.796% |
| Redeem 50M tokens (pays 833,551,077) | 2,916,448,923 | 815,440,991,257,550 | 75,526,438,275,666,392 | +0.051% |
| Bid fill 100M tokens at 0.999·F | 2,076,195,928 | 765,440,991,257,550 | 75,515,850,660,144,827 | +0.022% |
| Complete liquidation (simulation) | ≈ 0 | ≈ 642M tokens | — | +0.03% |

### Boundary vectors

| Case | V | S | L | s | F\_raw |
| --- | --- | --- | --- | --- | --- |
| Tiny | 1,000,000 | 10¹² | 10²⁰ | 18,446,744,123,700,328 | 1.000e-6 |
| Max supply, 1,000 SOL vault, L = 2¹²⁰ | 10¹² | 10¹⁵ | 2¹²⁰ | 1,329,228,229,483,701,708,696 | 5.192e3 |
| Vault only (L = 0) | 10⁹ | 10¹⁴ | 0 | 58,333,726,687,135,158 | 1.000e-5 (= V/S) |
| Pool only (V = 0) | 0 | 10¹⁴ | 10³⁰ | 9,999,999,999,998,700 | 2.939e-7 (= (L/2⁶⁴/S)²) |

## 28. Daily Build Plan

`[2 Oct 2026: this table is superseded by the calendar in STATUS.md (submit 11 Oct)]`

**Irreversible proof first: P0 answers on days 1–2, mainnet Proof launch on day 6, two buffer days.** M = mechanism, S = security, U = user, J = judging proof.

| Date | Work | Deliverable | Acceptance | Blocker → fallback | Not yet |
| --- | --- | --- | --- | --- | --- |
| 1 Oct | CPI harness; devnet phases 1–3; floor crate + Python reference + vectors (M) | Q1–Q4, Q6, Q7, Q11–Q14 answered | Section 18 gates 1–3 | Q1/Q7 fail → creator-PDA default; Q4 fail → disclosed hot-wallet claimer | Program logic, app |
| 2 Oct | DLMM: Q5, Q8, Q9, Q15–Q17; floor-wasm; compiler (M) | Bid placed and cancelled by PDA on devnet | Gate 5 | Q5 fail → escalate to Meteora; redemption-only fallback | App |
| 3 Oct | Program: `initialize_global`, `create_class`, `register_launch`, `settle_graduation`, `burn_leftover`; local-validator tests (M, S) | Instructions + negative tests | All tests green | — | App |
| 4 Oct | `open`, `refresh_floor`, `redeem`, `harvest`, `deposit`, `floor`; model fuzzer (M, S) | Full instruction set | 1M fuzz steps clean; CU within budgets | Q18 fail → two-step redeem | App |
| 5 Oct | Devnet phases 6–10; verifier-core + CLI (M, S) | End-to-end devnet sell-out; verifier PASS | Gates 6–10 | Any gate fail → fix before mainnet | Mainnet |
| 6 Oct | Mainnet deploy, multisig, Proof class, Proof launch, sell-out, verifier (M, J) | Mainnet proof | Realised ≥ predicted; lowest exec ≥ 0.99·F | Deviation → stop, diagnose on 7 Oct | Public launch |
| 7 Oct | Buffer; Public class + launch; keeper; challenge rules published (U) | Public launch `Open` | Verifier PASS | — | — |
| 8 Oct | Token page + launch form; creator outreach (U, J) | App live | Page numbers match verifier | — | — |
| 9 Oct | External creator launch; challenge promotion; README draft (U, J) | Outside interactions | ≥ 1 non-team bid fill or redemption | None → report honestly | — |
| 10 Oct | Demo recording; docs; video edit (J) | Video cut | Every on-screen tx linked | — | — |
| 11 Oct | Submission copy; final verifier runs; buffer (J) | Ready to submit | DoD checklist complete | — | — |
| 12 Oct | Submit (deadline 13 Oct 06:59 UTC) | Submission | — | — | — |

## 29. Definition of Done

### Mechanism

- [ ] On-chain F equals the Rust, WASM and Python implementations for the live mainnet accounts
- [ ] Both positions shown fully permanent and PDA-owned on mainnet
- [ ] Vault ledger reconciles to the lamport
- [ ] DLMM bid placed, filled, settled and burned on mainnet
- [ ] Redemption executed on mainnet at the specified payout
- [ ] F never decreased across 1M model fuzz steps and 500 integration sequences

### Security

- [ ] No known critical issue; every section 12 prevention has a test
- [ ] Upgrade authority and admin on the multisig; program verified against the tagged commit
- [ ] No instruction can move vault funds except the two allowed paths (code review + tests)
- [ ] All account-substitution negative tests pass

### Mainnet

- [ ] Program deployed; Proof and Public classes created
- [ ] Proof prediction recorded before trade 1
- [ ] Proof graduation, `open`, full sell-out completed
- [ ] Realised F ≥ predicted, and within the declared upper tolerance

### User proof

- [ ] Public launch `Open`
- [ ] At least one non-team wallet filled the bid or redeemed
- [ ] External creator launch (if achieved; reported honestly either way)

### Verification

- [ ] `ballast verify` works on a fresh machine with only an RPC URL
- [ ] A judge can confirm the central claim without the app

### Demo and submission

- [ ] Every on-screen transaction has an explorer signature; sped-up segments labelled
- [ ] README complete with addresses, proof transactions, limits
- [ ] Build reproducible from the tagged commit

## 30. Judge Attack Simulation

**Every hostile question maps to a specific test, transaction or verifier line; none is answered with prose alone.**

| Reviewer | Question | Answer | Evidence |
| --- | --- | --- | --- |
| Senior Solana engineer | Can I pass a fake position to inflate L? | Position re-derived from the recorded NFT mint; owner and pool checked | Negative test `fake_position_*` |
|  | Can a PDA be tricked into signing for me? | PDAs sign only fixed CPIs with program-derived destinations | Code review list; tests per CPI |
|  | Rounding extraction via many small redeems? | All rounding toward protocol; minimum payout | Property test `payout_le_exact` |
|  | Can the upgrade key drain vaults? | Yes in principle; multisig; disclosed; frozen after review | Upgrade authority on explorer |
|  | Replay or double settlement? | State machine + DBC bitmask; balance deltas | Negative tests |
| Meteora expert | Is migrated LP really 100% permanent? | Read both positions at `open`; refuse otherwise | `open` tx + verifier `permanent: PASS` |
|  | Are you using L in the right units? | Q64 liquidity per DAMM formulas; mapping checked against reserves | Devnet gate 3 report |
|  | Can the creator split the position? | Creator role is a Ballast PDA; split is owner-only | Registration tx showing `transfer_pool_creator` |
|  | How do you collect limit-order fills? | Cancel → burn → re-place; there is no claim endpoint | `FloorRefreshed` events |
|  | What if we change fees or disable a pool? | Disclosed; the other leg remains | Limits section |
| DeFi quant | Isn't most of this just locked LP? | Yes, \~74% of floor capacity; Ballast adds the vault, exactness and proof | Composition panel |
|  | Can F fall? | Proof per transition; floor-of-root integers | Fuzz suite; verifier history |
|  | Who pays? | Future traders (15% less depth), sellers below F; no subsidy | Section 10 ledger |
|  | Does the bid really execute near F? | Highest bin ≤ F; taker fee 0.1% | Mainnet sell-out: lowest exec ≥ 0.99·F |
|  | Upper bound on F? | ≤ average entry at open without deposits | Section 4 |
| Product judge | Why would anyone use this? | Known worst case before buying; exit at a known price | Outside redemption tx |
|  | Why would a creator choose it? | A signal they can't fake; income preserved | Launch form preview |
|  | Who's the first user? | SOL community launches; dip-buyers near F | Public launch activity |
|  | What happens after the hackathon? | A "Backed" class for DBC launchpads | Section 32 |
|  | Is it safe? | No: late buyers can lose \~74%; we say so | Page copy |
| Hackathon judge | Why this over the other entries? | The only entry with a falsifiable on-chain guarantee | Prediction tx before trade 1 |
|  | Is it real? | Mainnet program, launches, sell-out | Addresses in README |
|  | Can I check without trusting you? | One command | `ballast verify` |
|  | Is Meteora central? | All three programs carry part of the floor | Composition panel; CPI list |
|  | Did anyone else use it? | Reported honestly | Non-team transactions |

## 31. Cut List

**Test applied to every component: does removing it weaken the core promise? If not, it is cut.**

### MUST BUILD

- [ ] `ballast-floor` crate + Python reference + vectors
- [ ] `meteora-types` vendored layouts with offset tests
- [ ] Program: all eleven instructions with account-substitution checks
- [ ] Compiler for the two classes
- [ ] Verifier CLI
- [ ] Keeper (cranks only)
- [ ] Proof launch and sell-out on mainnet
- [ ] Public launch

### SHOULD BUILD

- [ ] Token page and launch form
- [ ] Challenge rules page
- [ ] Event-based floor history in the verifier

### ONLY IF TIME REMAINS

- [ ] Twin-launch comparison on devnet for the video
- [ ] Terminal-friendly JSON endpoint for `floor()`

### DO NOT BUILD

Governance; platform token; points; oracles; transfer hooks; lending; stock or USDC classes; reserve-share slider; dashboards beyond the verifier; mobile; analytics; AI features; config marketplace; compounding or market-cap-fee pools.

## 32. Post-Hackathon Extension Architecture

**Each extension attaches at one existing seam; none requires changing the floor crate or the instruction set's invariants.**

| Extension | Attaches at | What changes |
| --- | --- | --- |
| Reserve-share slider / Backed class | `Class` | New validated configs with different migration fee and curve; validator rules become a class template |
| Stock-quoted classes | `Class.quote_mint` + a token-program adapter | Token-2022 quote handling; badge check; legal review |
| Sponsor deposits | `deposit` (exists) | UI and attribution only |
| Lending against F | `floor()` view + events | External protocols value collateral at F; no Ballast change |
| Launchpad integrations | `register_launch` as a composable instruction; per-partner `partner_auth` seeds | Partners keep their own fee split by forwarding |
| SDK | `sdk/typescript` | Packaging |
| Terminal integrations | `floor()` + `FloorRefreshed` events | Read-only |
| Floor-backed markets | DLMM pair already exists per launch | External LPs above F |

The competition build hard-codes two classes; the class template generalises without touching launch logic.

## 33. Exact Day-1 TODO List

- [ ] Pin toolchain (`rust-toolchain.toml`, Anchor 0.31.1, Agave 2.1.x, Node 20, pnpm 9); confirm `cargo build-sbf`
- [ ] Scaffold the repo per section 15; CI with fmt, clippy, unit tests
- [ ] Write `ballast-floor` (floor-of-root, payout, bin check) and port `tests/reference/floor.py`; generate `vectors.json`; Rust = Python on all vectors
- [ ] Dump Meteora programs and accounts into `fixtures/`; local validator boots with them
- [ ] Devnet: build the Proof config with the DBC SDK (fee claimer = derived `partner_auth`); create it; decode with SDK and vendored types; byte-compare (Q12)
- [ ] Devnet: create a pool, transfer pool creator to a test PDA, buy to threshold, migrate top-level (Q1, Q14, Q15, Q17)
- [ ] Read both positions in the migration slot: unlocked, vested, permanent, owner (Q1, Q6)
- [ ] Read pool: mode, compounding, range, liquidity; 20 swaps + 2 fee claims; diff (Q2); reserve-vs-formula check (Q3)
- [ ] Minimal Anchor harness: PDA CPIs for `withdraw_migration_fee`, `claim_trading_fee`, `partner_withdraw_surplus`, `claim_position_fee` (Q4, Q6)
- [ ] Try `split_position` on a creator-owned permanent position (Q7)
- [ ] `getMint`: mint and freeze authorities (Q11)
- [ ] Write the day-1 report: each question answered with transaction signatures; decide fallbacks

## 34. Critical Blockers

| Blocker | Resolves by | Deadline | If unresolved |
| --- | --- | --- | --- |
| Atomic permanent lock at migration (Q1) | Devnet read in the migration slot | 1 Oct | Creator-PDA default already removes third-party owners; lock in `open` if partly unlocked |
| Pool mode, range, L mapping (Q2, Q3) | Devnet reads and swaps | 1 Oct | Reserve-based absorption formula |
| PDA claims via CPI (Q4) | Harness | 1 Oct | Disclosed hot-wallet claimer |
| PDA-owned DLMM limit orders via CPI (Q5) | Harness | 2 Oct | Redemption-only floor; DLMM moved to "future"; escalate to Meteora |
| DLMM pair creation powers (Q8) | SDK source + devnet | 2 Oct | Create in the launch transaction; accept only parameter-valid pairs |
| Atomic redeem CU (Q18) | Devnet simulation | 4 Oct | Two-step redeem with on-hand reserve |
| Mainnet Proof deviation | Mainnet sell-out | 6 Oct | Stop; diagnose on the 7 Oct buffer; never submit a mismatched claim |

## 35. Final Build Sequence

**Build in the order the proof needs it; the end-to-end happy path below is both the integration test and the demo script.**

### Build order

1. Floor crate, reference, vectors (M).
2. Day-1 devnet P0 answers (M).
3. DLMM CPI harness (M).
4. Program instructions, registration to `open` (M, S).
5. Bid, redemption, harvest, deposit; fuzzing (M, S).
6. Devnet end-to-end and failure injection (M, S).
7. Verifier (J).
8. Mainnet Proof launch and sell-out (M, J).
9. Public launch and challenge (U).
10. App, README, video, submission (J).

### End-to-end happy path

| # | Transaction | Signer | Key CPIs | State change | SOL flow | Token flow | Floor | Event |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `create_class` | Admin multisig | — | Class recorded | — | — | Prediction constant stored | `ClassCreated` |
| 2 | DBC create pool + `transfer_pool_creator` + DLMM pair + `register_launch` | Creator, payer | DBC, DLMM | `Registered` | Fees only | 1B minted to DBC vault | Prediction recorded before trade 1 | `LaunchRegistered` |
| 3 | Buys to threshold | Traders | DBC swap | Curve complete | Raise into DBC | 538M to holders (Public) | Exit ≥ p0·0.99 per holder | DBC events |
| 4 | `settle_graduation` | Anyone | DBC withdraw migration fee, claim fees | `Funded` | 15% + partner fees → vault; creator fees → beneficiary | — | — | `GraduationSettled` |
| 5 | `migration_damm_v2` | Any keeper | DBC → DAMM v2 | DAMM pool, PDA-owned permanent positions | 85% → pool | 327M → pool | L fixed | DBC events |
| 6 | `burn_leftover` | Anyone | DBC withdraw leftover, surplus; burn | `Cleaned` | Surplus → vault | 135M burned | S final | `LeftoverBurned` |
| 7 | `open` | Anyone + order keypair | DLMM place order | `Open` | Vault → bid | — | F computed ≥ prediction | `FloorOpened` |
| 8 | Sell pressure | Holders | Router → DAMM v2, DLMM | Bid fills | Bid → sellers | Tokens → order | True F rises | DLMM events |
| 9 | `refresh_floor` | Anyone + order keypair | DLMM cancel, burn, place | Fills burned | Unfilled → vault → new bid | Filled → burned | Reported F rises | `FloorRefreshed` |
| 10 | `redeem` | Holder + order keypair | Cancel, burn, place | Holder burns T | F·0.995·T → holder | T burned | F rises by fee share | `Redeemed` |
| 11 | `harvest` | Anyone | DAMM claim fees ×2 | — | 90% → vault, 10% → treasury, creator → beneficiary | — | F rises | `Harvested` |
| 12 | `ballast verify` | — | — | — | — | — | Recomputed, compared, PASS | CLI output |

## Sources

- DBC: [program instructions](https://docs.meteora.ag/developer-guides/dbc/program/instructions), [accounts](https://docs.meteora.ag/developer-guides/dbc/program/accounts), [migration](https://docs.meteora.ag/overview/products/dbc/migration.md), [pool configuration](https://docs.meteora.ag/overview/products/dbc/pool-configuration), [config key](https://docs.meteora.ag/overview/products/dbc/dbc-config-key), [Rust CPI](https://docs.meteora.ag/developer-guides/dbc/rust-integration/cpi), [PoolConfig struct (Codama decoder)](https://docs.rs/crate/carbon-meteora-dbc-decoder/latest/source/src/accounts/pool_config.rs)
- DAMM v2: [formulas](https://docs.meteora.ag/overview/products/damm-v2/damm-v2-formulas), [changelog](https://docs.meteora.ag/developer-guides/damm-v2/changelog), [repository](https://github.com/MeteoraAg/damm-v2), [Rust library](https://docs.meteora.ag/developer-guides/damm-v2/rust-integration/library)
- DLMM: [changelog](https://docs.meteora.ag/developer-guides/dlmm/changelog), [events](https://docs.meteora.ag/developer-guides/dlmm/program/events), [SDK examples](https://docs.meteora.ag/developer-guides/dlmm/typescript-sdk/examples), [SDK changelog](https://github.com/MeteoraAg/dlmm-sdk/blob/main/CHANGELOG.md), [Invent limit-order commands](https://github.com/MeteoraAg/meteora-invent)
- PDA-signed claims precedent: [Dynamic Fee Sharing instructions](https://docs.meteora.ag/developer-guides/dynamic-fee-sharing/program/instructions)
- DAMM v2 max sqrt price and DBC constraint table: [CurveForge validator](https://github.com/hereenoww94-ui/curveforge)
- All vectors and simulations: computed for this tab with an integer reference implementation (section 27)
