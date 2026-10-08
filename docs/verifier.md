# `ballast verify`

Checks a Ballast launch from raw chain data alone (§20). It reads accounts and transaction history
over standard JSON-RPC from whatever RPC you give it, re-derives every number with the same floor
crate the program uses, and exits non-zero on any FAIL. It never contacts a Ballast app or API.

```bash
cargo build --release -p ballast-verifier          # → target/release/ballast
ballast verify <launch-address> --rpc <url>        # human-readable
ballast verify <launch-address> --rpc <url> --json # machine-readable, with the full history
ballast verify <launch-address> --rpc <url> --sellout <sig> <sig> …   # replay a sell-out (gate 8)
ballast verify <launch-address> --rpc <url> --at-slot <slot>          # F in force at a slot (§24)
```

`--rpc` defaults to `$BALLAST_RPC`, then mainnet-beta.

## What it checks

1. **Launch and Class** — owned by the Ballast program, at their seed-derived addresses.
2. **The prediction** — the config hash recomputed from the DBC config's raw curve fields (§7 rule 3);
   the predicted floor re-derived independently from the same fields at both ends of D-017's band,
   and the recorded prediction confirmed to be at or below both (it is a lower bound); the DBC pool's
   creator is `creator_auth`; and the prediction was recorded in the pool's **first** transaction —
   before any third-party trade (D-011).
3. **The locked pool** — the canonical migrated DAMM v2 pool (OnlyB, no compounding, full range); both
   recorded positions fully permanent (`unlocked = vested = 0`), at their derived addresses, NFTs held
   by `partner_auth` and `creator_auth`; L ≥ L at open.
4. **The vault and the bid** — the vault is `partner_auth`'s WSOL account at its derived address; the
   resting order is a DLMM `LimitOrder` owned by `partner_auth` on the launch's pair; its bin is at or
   below F (a bid stale since the last refresh, capped under a third-party pin (D-020) or suspended
   (D-021) is reported as such).
5. **Supply** — mint and freeze authorities are `None`; S = supply − staging.
6. **F** — s recomputed from live V, S, L with `ballast-floor`; the floor equation holds; s ≥ the
   last recorded s; realised at open ≥ predicted; and the **history**: every floor update the program
   ever emitted (`FloorOpened`, `FloorRefreshed`, `Redeemed`, `Harvested`, `Deposited`), decoded from
   the launch's transactions — only lines logged while Ballast itself executes — must never decrease
   and must end at `s_last`. Any `BackingDecreased` event fails the check.
7. **Sell-out replay** (`--sellout`) — for each transaction, the signer's base sold and quote received
   (WSOL and lamports, fee added back), compared with F in force at that slot; the lowest execution
   must be ≥ 0.99·F (§18 gate 8).

## Independence

The prediction and config hash use the verifier's own code (`crates/verifier-core/src/predict.rs`),
not the program's or the compiler's; its derivation matches D-017's measured table bit for bit
(`crates/verifier-core/tests/predict.rs`). Account layouts are the vendored Meteora types proven
against real accounts (Q12). F itself comes from `ballast-floor` — by design the one implementation.

## Exit codes

`0` every check passed · `1` any FAIL, or an account that must exist does not · `2` usage error.
