# Ballast

A Meteora DBC launch class with an on-chain, **executable buyback floor** `F`.

At graduation, 15% of the raise is withdrawn as the DBC migration fee into a program-owned vault;
the other 85% migrates into a DAMM v2 pool as two permanently locked, PDA-owned positions. The
whole vault rests as one DLMM limit order in the highest bin at or below `F`. `F` is the price at
which the locked liquidity plus that bid can absorb the entire outstanding supply:

```
V/F + L·(1/√F − 1/√P_max) = S
```

The claim is falsifiable. The floor is predicted on-chain **before trade 1**, and `ballast verify`
recomputes it from raw mainnet accounts with no dependency on this project's app or API.

This is an executable buyback floor on Meteora, not a promise about prices elsewhere. Selling
directly on DAMM v2 can execute below `F`; the bid and redemption do not. Late buyers can lose most
of what they paid.

---

## Status: in development

The full README — architecture, addresses, proof transactions, limitations — is written in the order
§34 of the build spec prescribes, once the mainnet Proof launch has run. It is not written yet, and
nothing here should be read as a description of a deployed system.

What exists today:

| Component | State |
|---|---|
| `crates/floor` — the only implementation of `F` | **complete**; all §27 vectors exact, 100k property gate green |
| `tests/reference/floor.py` — independent integer reference | **complete** |
| Everything else | not built — gated on the five P0 devnet questions |

Progress is tracked in [`STATUS.md`](STATUS.md); every answered question, toolchain pin and
deviation is recorded with evidence in [`DECISIONS.md`](DECISIONS.md); raw proof lives in
[`evidence/`](evidence/). The authoritative specification is
[`docs/spec/BUILD_SPEC.md`](docs/spec/BUILD_SPEC.md).

## Build and test

```bash
cargo test -p ballast-floor                                           # 25 tests, no network
PROPTEST_CASES=100000 cargo test -p ballast-floor --test properties   # the §14 gate
python tests/reference/floor.py                                       # independent reference
```

Toolchain is pinned in `rust-toolchain.toml`. The Solana, Anchor, Node and pnpm pins are not yet
installed on this machine — see `DECISIONS.md` § Toolchain before running anything beyond the above.
