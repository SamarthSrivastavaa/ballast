# Break the floor

This is an executable buyback floor on Meteora, not a promise about prices elsewhere.

Ballast makes a claim that can be proven wrong, so here it is as a challenge. Show on-chain evidence
of any item under "What counts", on a named Ballast launch, and post it with the
[Break the floor form](https://github.com/SamarthSrivastavaa/ballast/issues/new?template=break-the-floor.yml).

## The claim

A Ballast launch has a floor price F: the price at which its permanently locked DAMM v2 liquidity
plus its vault's DLMM bid can absorb every outstanding token. F is predicted on-chain in the
pool-creation transaction, before any third-party trade. The realised F is at or above the
prediction, and F never falls afterwards. Anyone can recompute all of it from raw accounts with
`ballast verify`.

## What counts

1. **F fell.** Two slots t₁ < t₂ where the floor value fell, as evaluated by `ballast verify --at-slot`.
2. **The vault leaked.** A transfer out of a vault to anywhere other than the launch's own limit
   order, or a redeemer burning tokens in the same instruction.
3. **Locked liquidity shrank.** A decrease in the permanently locked liquidity of a recorded position.
4. **A redemption underpaid.** With quote in the vault, redeeming T tokens paid less than
   ⌊T · F · (1 − 0.5%)⌋.
5. **The verifier is wrong.** `ballast verify` passes while the chain says otherwise, or the on-chain
   prediction differs from the one the verifier recomputes from the DBC config.
6. **The bid filled below its stated price.** A fill of the vault's limit order below its bin price,
   beyond DLMM's own fee.

## What does not count

- **A sale straight into the DAMM v2 pool printing below F.** That is out of scope by design and said
  everywhere: the DLMM bid and redemption do not execute below F; the pool can.
- Anything that needs Meteora's admin keys (changing pool fees, disabling a pair, upgrading their
  programs) or the Ballast upgrade authority. Both are disclosed dependencies.
- A third party holding the DLMM active bin below F's bin. It is disclosed: within 70 bins the bid is
  capped there, further down it is suspended; redemption still pays F less 0.5%.
- The price of SOL. F is in SOL, not dollars.

## Where

| Cluster | Target |
|---|---|
| Local validator running Meteora's mainnet DBC, DAMM v2 and DLMM binaries | Create your own launch: `pnpm proof:local` (README, "Reproduce the whole proof"). About 25 minutes from a clean clone with the toolchain installed |
| Mainnet | ⟦FILL: mint, once a mainnet launch exists⟧ |
| Devnet | Not available: the program is deployed, but devnet's DBC writes a config version it refuses |

## Bounty

⟦FILL: amount and currency, decided by the owner, or "no bounty: credit in the README"⟧. One
payout per distinct break, to the first valid report.

## Deadline

⟦FILL: date⟧. Reports after that are still welcome and will be credited.

## Not a break, but still worth posting

Tried and it held? Post that too, with what you tried. A failed attempt is evidence.
